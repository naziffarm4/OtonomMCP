import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';

export interface PersistedNonceData {
  seen: string[];
  reserved: Record<string, number>; // nonce -> expiresAt (epoch ms)
}

interface FileLockMetadata {
  ownerToken: string;
  pid: number;
  acquiredAt: number;
}

// Process-wide mutex per normalized file path to serialize async operations within the same process
const inProcessLockQueues = new Map<string, Promise<unknown>>();

function withInProcessLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  const currentLock = inProcessLockQueues.get(normalizedPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const newLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  inProcessLockQueues.set(normalizedPath, currentLock.then(() => newLock));

  return currentLock
    .then(operation)
    .finally(() => {
      release();
      if (inProcessLockQueues.get(normalizedPath) === currentLock.then(() => newLock)) {
        inProcessLockQueues.delete(normalizedPath);
      }
    });
}

/**
 * Cross-process and cross-instance mutual exclusion file lock.
 * Uses atomic O_CREAT | O_EXCL with unique ownership tokens, process liveness checking, and stale recovery.
 */
export async function withCrossProcessNonceLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: { timeoutMs?: number; staleThresholdMs?: number; pollIntervalMs?: number }
): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  const lockFilePath = `${normalizedPath}.lock`;
  const timeoutMs = options?.timeoutMs ?? 5000;
  const staleThresholdMs = options?.staleThresholdMs ?? 4000;
  const pollIntervalMs = options?.pollIntervalMs ?? 15;

  return withInProcessLock(normalizedPath, async () => {
    await fs.promises.mkdir(path.dirname(lockFilePath), { recursive: true });
    const ownerToken = crypto.randomUUID();
    const startTime = Date.now();

    while (true) {
      try {
        const handle = await fs.promises.open(
          lockFilePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
        );
        const metadata: FileLockMetadata = {
          ownerToken,
          pid: process.pid,
          acquiredAt: Date.now(),
        };
        try {
          await handle.writeFile(JSON.stringify(metadata), 'utf8');
          await handle.sync();
        } finally {
          await handle.close().catch(() => {});
        }
        break; // Successfully acquired lock
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'EEXIST') {
          throw err;
        }

        // Lock file exists; check for staleness or dead PID
        try {
          const raw = await fs.promises.readFile(lockFilePath, 'utf8');
          const meta = JSON.parse(raw) as FileLockMetadata;
          const isStale = Date.now() - meta.acquiredAt > staleThresholdMs;
          let isProcessDead = false;
          if (meta.pid && meta.pid !== process.pid) {
            try {
              process.kill(meta.pid, 0);
            } catch (e: any) {
              if (e?.code === 'ESRCH') {
                isProcessDead = true;
              }
            }
          }

          if (isStale || isProcessDead) {
            await fs.promises.unlink(lockFilePath).catch(() => {});
            continue;
          }
        } catch {
          // If file is mid-write or already unlinked, wait and retry
        }

        if (Date.now() - startTime >= timeoutMs) {
          throw new Error(
            `Timeout acquiring cross-process lock for ${lockFilePath} after ${timeoutMs}ms`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    try {
      return await operation();
    } finally {
      try {
        const raw = await fs.promises.readFile(lockFilePath, 'utf8');
        const meta = JSON.parse(raw) as FileLockMetadata;
        if (meta.ownerToken === ownerToken) {
          await fs.promises.unlink(lockFilePath).catch(() => {});
        }
      } catch {
        // Ignored if already cleaned up
      }
    }
  });
}

export class NonceStore {
  readonly filePath: string;

  constructor(options?: { baseDir?: string; filePath?: string }) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'seen-nonces.json');
    }
  }

  /**
   * Reads fresh persistent state under cross-process lock and cleans up expired reservations.
   */
  private async readStateUnderLock(): Promise<PersistedNonceData> {
    const now = Date.now();
    try {
      const raw = await readJsonFile<unknown>(this.filePath);
      if (Array.isArray(raw)) {
        // Legacy format compatibility: plain string[] of seen nonces
        return {
          seen: raw.filter((s): s is string => typeof s === 'string'),
          reserved: {},
        };
      }
      if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        const seen = Array.isArray(obj.seen)
          ? obj.seen.filter((s): s is string => typeof s === 'string')
          : [];
        const rawReserved =
          obj.reserved && typeof obj.reserved === 'object'
            ? (obj.reserved as Record<string, unknown>)
            : {};
        const reserved: Record<string, number> = {};
        for (const [k, v] of Object.entries(rawReserved)) {
          if (typeof v === 'number' && v > now) {
            reserved[k] = v;
          }
        }
        return { seen, reserved };
      }
    } catch {
      // File does not exist yet or unreadable
    }
    return { seen: [], reserved: {} };
  }

  /**
   * Pre-check / reserve a nonce temporarily (useful for two-phase approval validation).
   * Cross-process atomic: returns false if nonce was already seen or is currently reserved.
   */
  async reserveNonce(nonce: string, ttlMs = 30000): Promise<boolean> {
    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      const now = Date.now();

      if (state.seen.includes(nonce)) {
        return false;
      }

      if (state.reserved[nonce] && state.reserved[nonce] > now) {
        return false;
      }

      state.reserved[nonce] = now + ttlMs;
      await atomicWriteJson(this.filePath, state);
      return true;
    });
  }

  /**
   * Release a previously reserved nonce if approval evaluation fails before commit.
   * Cross-process atomic.
   */
  async releaseReservation(nonce: string): Promise<void> {
    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      if (state.reserved[nonce]) {
        delete state.reserved[nonce];
        await atomicWriteJson(this.filePath, state);
      }
    });
  }

  /**
   * Atomically mark nonce as permanently consumed and persist to storage.
   * Cross-process atomic: returns true if successfully marked, false if already consumed or duplicate.
   */
  async markNonceSeen(nonce: string): Promise<boolean> {
    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();

      if (state.seen.includes(nonce)) {
        return false;
      }

      state.seen.push(nonce);
      delete state.reserved[nonce];

      // Keep only last 2000 nonces to prevent unbounded growth
      if (state.seen.length > 2000) {
        state.seen = state.seen.slice(-2000);
      }

      await atomicWriteJson(this.filePath, state);
      return true;
    });
  }

  /**
   * Checks whether a nonce has already been seen or reserved without consuming it.
   * Cross-process atomic.
   */
  async isNonceSeen(nonce: string): Promise<boolean> {
    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      const now = Date.now();
      if (state.seen.includes(nonce)) {
        return true;
      }
      if (state.reserved[nonce] && state.reserved[nonce] > now) {
        return true;
      }
      return false;
    });
  }
}


