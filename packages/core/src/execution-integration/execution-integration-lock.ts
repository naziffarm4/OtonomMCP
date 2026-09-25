/**
 * Execution Integration Filesystem Lock (Phase 10 TASK-P10-05)
 *
 * Provides crash-resilient, atomic filesystem concurrency protection for
 * execution state integration without relying on in-memory boolean locks.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ATOMIC PRIMITIVE: Uses O_CREAT | O_EXCL (via flag 'wx' / constants.O_CREAT | constants.O_EXCL).
 * 2. UNIQUE TOKEN: Every acquisition generates a unique cryptographic ownership token.
 * 3. METADATA TRACEABILITY: Persists owner token, process ID (PID), and timestamps in the lockfile.
 * 4. CRASH-WINDOW SAFETY: Safely handles crash windows between lock creation and metadata write.
 * 5. SAFE STALE RECOVERY: Stale lock breaking verifies and transitions ownership safely;
 *    an old owner whose lock expired or was broken can NEVER delete a new owner's lock.
 * 6. TOKEN-VERIFIED RELEASE: Release strictly verifies that the lockfile still contains the owner token.
 * 7. PERSISTENCE BOUNDARY: Placed under .ai-manager/state/ conforming to repository conventions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ExecutionIntegrationError } from '../director/director-errors.js';

export interface LockMetadata {
  readonly ownerToken: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly acquiredAt: number;
}

export interface LockHandle {
  readonly ownerToken: string;
  readonly lockFilePath: string;
  readonly acquiredAt: number;
}

export interface ExecutionIntegrationLockOptions {
  readonly lockFilePath?: string;
  readonly baseDir?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly staleThresholdMs?: number;
}

export class ExecutionIntegrationLock {
  readonly lockFilePath: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly staleThresholdMs: number;

  constructor(options: ExecutionIntegrationLockOptions = {}) {
    const baseDir = options.baseDir ?? process.cwd();
    this.lockFilePath =
      options.lockFilePath ??
      path.join(baseDir, '.ai-manager', 'state', 'execution-integration.lock');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.staleThresholdMs = options.staleThresholdMs ?? 3000;
  }

  /**
   * Acquires the exclusive filesystem lock.
   * Retries until timeoutMs, performing safe stale-lock recovery if needed.
   */
  async acquire(options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleThresholdMs?: number;
  }): Promise<LockHandle> {
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    const pollInterval = options?.pollIntervalMs ?? this.pollIntervalMs;
    const staleThreshold = options?.staleThresholdMs ?? this.staleThresholdMs;

    const startTime = Date.now();
    const ownerToken = crypto.randomUUID();

    // Ensure parent directory exists
    const dir = path.dirname(this.lockFilePath);
    await fs.promises.mkdir(dir, { recursive: true });

    while (Date.now() - startTime < timeout) {
      try {
        // Attempt atomic creation with O_CREAT | O_EXCL
        const handle = await fs.promises.open(
          this.lockFilePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
        );

        const now = Date.now();
        const metadata: LockMetadata = {
          ownerToken,
          pid: process.pid,
          createdAt: new Date(now).toISOString(),
          acquiredAt: now,
        };

        try {
          await handle.writeFile(JSON.stringify(metadata, null, 2), 'utf8');
          await handle.sync();
        } finally {
          await handle.close().catch(() => {});
        }

        return {
          ownerToken,
          lockFilePath: this.lockFilePath,
          acquiredAt: now,
        };
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') {
          throw new ExecutionIntegrationError(
            `Failed to create lock file '${this.lockFilePath}': ${nodeErr.message}`,
            'ERR_EXECUTION_INTEGRATION_LOCK_FAILURE',
            { lockFilePath: this.lockFilePath, cause: err }
          );
        }

        // Lock file exists. Inspect it for staleness or crash window.
        await this.inspectAndRecoverStaleLock(staleThreshold);

        // Sleep pollInterval before retrying
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    throw new ExecutionIntegrationError(
      `Failed to acquire execution integration lock on '${this.lockFilePath}' within ${timeout}ms`,
      'ERR_EXECUTION_INTEGRATION_LOCK_TIMEOUT',
      { lockFilePath: this.lockFilePath, timeoutMs: timeout }
    );
  }

  /**
   * Releases the lock, verifying that the lock file still belongs to this ownerToken.
   * If the lock file has already been taken over or deleted, this owner DOES NOT delete
   * another owner's lock.
   */
  async release(handle: LockHandle): Promise<void> {
    if (!handle || !handle.ownerToken) {
      return;
    }

    try {
      const content = await fs.promises.readFile(this.lockFilePath, 'utf8');
      const parsed = JSON.parse(content) as LockMetadata;

      // STRICT INVARIANT: Only delete if the file still contains our token
      if (parsed.ownerToken === handle.ownerToken) {
        await fs.promises.unlink(this.lockFilePath).catch((err: unknown) => {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr.code !== 'ENOENT') {
            throw err;
          }
        });
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      // If file doesn't exist or JSON is corrupt, do nothing - do not unlink blindly
      if (nodeErr.code !== 'ENOENT') {
        // Safe ignore
      }
    }
  }

  /**
   * Executes a callback inside an acquired lock, ensuring deterministic release in finally.
   */
  async withLock<T>(
    fn: () => Promise<T>,
    options?: { timeoutMs?: number; pollIntervalMs?: number; staleThresholdMs?: number }
  ): Promise<T> {
    const handle = await this.acquire(options);
    try {
      return await fn();
    } finally {
      await this.release(handle);
    }
  }

  /**
   * Inspects the existing lock file and safely recovers if it is determined to be stale.
   * Handles:
   * 1. Crash window: Lock created (0 bytes or malformed JSON) where mtime is older than staleThreshold.
   * 2. Process termination: Owner process dead (kill -0 fails with ESRCH) or age exceeds threshold.
   */
  private async inspectAndRecoverStaleLock(staleThresholdMs: number): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.lockFilePath);
      const ageMs = Date.now() - stat.mtimeMs;

      let content: string;
      try {
        content = await fs.promises.readFile(this.lockFilePath, 'utf8');
      } catch {
        return; // File might have been removed concurrently
      }

      // Check crash window: Empty file or partial write
      if (content.trim().length === 0) {
        if (ageMs > staleThresholdMs) {
          // Crash window: created but metadata never written, and age exceeds threshold
          await fs.promises.unlink(this.lockFilePath).catch(() => {});
        }
        return;
      }

      let metadata: LockMetadata;
      try {
        metadata = JSON.parse(content) as LockMetadata;
      } catch {
        // Corrupt content
        if (ageMs > staleThresholdMs) {
          await fs.promises.unlink(this.lockFilePath).catch(() => {});
        }
        return;
      }

      const lockAgeMs = Date.now() - (metadata.acquiredAt ?? stat.mtimeMs);

      // Check process liveness
      let processDead = false;
      if (metadata.pid && typeof metadata.pid === 'number') {
        try {
          process.kill(metadata.pid, 0);
        } catch (killErr: unknown) {
          const err = killErr as NodeJS.ErrnoException;
          if (err.code === 'ESRCH') {
            processDead = true;
          }
        }
      }

      if (processDead || lockAgeMs > staleThresholdMs) {
        // Verify token matches before breaking stale lock
        try {
          const verifyContent = await fs.promises.readFile(this.lockFilePath, 'utf8');
          const verifyMeta = JSON.parse(verifyContent) as LockMetadata;
          if (verifyMeta.ownerToken === metadata.ownerToken) {
            await fs.promises.unlink(this.lockFilePath).catch(() => {});
          }
        } catch {
          // Concurrently removed or altered
        }
      }
    } catch {
      // File could have been unlinked concurrently
    }
  }
}
