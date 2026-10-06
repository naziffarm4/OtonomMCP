/**
 * Driver Lock Manager (Phase 17 TASK-P17-01)
 *
 * Implements atomic, durable single-active-driver protection.
 * Ensures only ONE active driver may execute for a given project at any time.
 * Prevents concurrent runs, duplicate execution, and racing iterations.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type DriverLockInfo,
  DriverLockInfoZodSchema,
} from './driver-types.js';
import { DriverConcurrencyError } from './driver-errors.js';

export interface DriverLockManagerOptions {
  readonly workspaceRoot?: string;
  readonly lockFilePath?: string;
  /** Timeout in ms after which an untouched heartbeat is considered stale (default 30,000ms) */
  readonly heartbeatStaleMs?: number;
}

export class DriverLockManager {
  readonly workspaceRoot?: string;
  readonly lockFilePath: string;
  readonly heartbeatStaleMs: number;

  constructor(options: DriverLockManagerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? 30_000;

    if (options.lockFilePath) {
      this.lockFilePath = options.lockFilePath;
    } else {
      const base = options.workspaceRoot ?? process.cwd();
      this.lockFilePath = path.join(base, '.ai-manager', 'driver', 'driver.lock');
    }
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.lockFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // directory already exists or created
    }
  }

  /**
   * Helper to check if a process ID is currently running.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Signal 0 tests for existence of process without sending a signal
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // ESRCH means process does not exist
      return err.code === 'EPERM'; // EPERM means process exists but we lack permission to signal
    }
  }

  /**
   * Reads existing lock file if present and valid.
   */
  async getLockInfo(): Promise<DriverLockInfo | null> {
    try {
      const raw = await fs.readFile(this.lockFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const validated = DriverLockInfoZodSchema.safeParse(parsed);
      if (validated.success) {
        return validated.data;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Checks if an active (non-stale) lock is currently held.
   */
  async isLocked(currentDriverId?: string): Promise<boolean> {
    const lock = await this.getLockInfo();
    if (!lock) {
      return false;
    }

    if (currentDriverId && lock.driverId === currentDriverId) {
      return true;
    }

    // Check if process is still alive
    if (this.isProcessAlive(lock.pid)) {
      return true;
    }

    // Process is dead, check heartbeat staleness
    const heartbeatAge = Date.now() - new Date(lock.heartbeatAt).getTime();
    return heartbeatAge < this.heartbeatStaleMs;
  }

  /**
   * Checks if an existing lock file exists and is stale (process dead or heartbeat timed out).
   */
  async isStaleLock(): Promise<boolean> {
    const lock = await this.getLockInfo();
    if (!lock) {
      return false;
    }
    const processAlive = this.isProcessAlive(lock.pid);
    const heartbeatAge = Date.now() - new Date(lock.heartbeatAt).getTime();
    return !processAlive || heartbeatAge >= this.heartbeatStaleMs;
  }

  /**
   * Atomically acquires the lock for `driverId` and `projectId`.
   * Throws DriverConcurrencyError if another active driver holds the lock.
   */
  async acquireLock(driverId: string, projectId: string): Promise<DriverLockInfo> {
    await this.ensureDir();
    const existingLock = await this.getLockInfo();

    if (existingLock) {
      // If lock belongs to the same driverId and projectId, idempotent re-acquisition
      if (existingLock.driverId === driverId && existingLock.projectId === projectId) {
        return await this.renewHeartbeat(driverId);
      }

      // Check if existing lock holder is active
      const processAlive = this.isProcessAlive(existingLock.pid);
      const heartbeatAge = Date.now() - new Date(existingLock.heartbeatAt).getTime();
      const isStale = !processAlive || heartbeatAge >= this.heartbeatStaleMs;

      if (!isStale) {
        throw new DriverConcurrencyError(
          `Cannot start driver '${driverId}'. Another active driver '${existingLock.driverId}' holds the lock for project '${existingLock.projectId}' (PID: ${existingLock.pid}). Only one active driver is permitted per project.`,
          {
            driverId,
            projectId,
            existingDriverId: existingLock.driverId,
            existingProjectId: existingLock.projectId,
            existingPid: existingLock.pid,
            heartbeatAt: existingLock.heartbeatAt,
          }
        );
      }

      // Lock is stale: break lock cleanly for recovery
      await this.forceRelease();
    }

    const now = new Date().toISOString();
    const lockInfo: DriverLockInfo = {
      lockId: `lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      driverId,
      projectId,
      acquiredAt: now,
      heartbeatAt: now,
      pid: process.pid,
    };

    // Atomically create lock file with 'wx' flag (O_CREAT | O_EXCL)
    try {
      await fs.writeFile(this.lockFilePath, JSON.stringify(lockInfo, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
      });
      return lockInfo;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        const activeLock = await this.getLockInfo();
        if (activeLock && activeLock.driverId === driverId && activeLock.projectId === projectId) {
          return activeLock;
        }
        throw new DriverConcurrencyError(
          `Cannot start driver '${driverId}'. Another active driver '${activeLock?.driverId ?? 'unknown'}' won the atomic lock race for project '${activeLock?.projectId ?? projectId}' (PID: ${activeLock?.pid}). Only one active driver is permitted per project.`,
          {
            driverId,
            projectId,
            existingDriverId: activeLock?.driverId,
            existingProjectId: activeLock?.projectId,
            existingPid: activeLock?.pid,
          }
        );
      }
      throw err;
    }
  }

  /**
   * Renews the heartbeat timestamp in the lock file.
   */
  async renewHeartbeat(driverId: string): Promise<DriverLockInfo> {
    const existingLock = await this.getLockInfo();
    if (!existingLock || existingLock.driverId !== driverId) {
      throw new DriverConcurrencyError(
        `Cannot renew heartbeat for driver '${driverId}': lock is not owned by this driver.`,
        { driverId, lockOwner: existingLock?.driverId }
      );
    }

    const updated: DriverLockInfo = {
      ...existingLock,
      heartbeatAt: new Date().toISOString(),
    };

    await fs.writeFile(this.lockFilePath, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  /**
   * Releases the lock file if owned by `driverId`.
   */
  async releaseLock(driverId: string): Promise<void> {
    const existingLock = await this.getLockInfo();
    if (!existingLock) {
      return;
    }

    if (existingLock.driverId === driverId) {
      try {
        await fs.unlink(this.lockFilePath);
      } catch {
        // ignore unlink error if already removed
      }
    }
  }

  /**
   * Unconditionally releases the lock file (used during stale recovery).
   */
  async forceRelease(): Promise<void> {
    try {
      await fs.unlink(this.lockFilePath);
    } catch {
      // ignore
    }
  }
}
