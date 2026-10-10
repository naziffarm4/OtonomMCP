import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';

export interface PersistedNonceData {
  seen: string[];
  reserved: Record<string, number>; // nonce -> expiresAt (epoch ms)
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
 * Cross-process and cross-instance mutual exclusion lock using SQLite exclusive transactions.
 * Leverages operating system kernel byte-range file locking (LockFileEx / POSIX locks).
 *
 * Guarantees:
 * 1. Safe against long operations: Active locks are NEVER stolen or deleted just because a stale timer elapsed.
 * 2. Race-condition proof cleanup: When a holding process terminates or crashes, the OS kernel automatically
 *    and instantly releases the byte-range lock on the file descriptor without leaving stale lock files behind.
 * 3. Competing processes queue cleanly: No process can accidentally delete another process's newly acquired lock.
 * 4. Lock integrity: The lock owner holds an active EXCLUSIVE database transaction for the exact duration of operation().
 */
export async function withCrossProcessNonceLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: { timeoutMs?: number; staleThresholdMs?: number; pollIntervalMs?: number }
): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  const lockDbPath = `${normalizedPath}.lock.sqlite`;
  const timeoutMs = options?.timeoutMs ?? 10000;
  const pollIntervalMs = options?.pollIntervalMs ?? 20;

  return withInProcessLock(normalizedPath, async () => {
    await fs.promises.mkdir(path.dirname(lockDbPath), { recursive: true });
    const startTime = Date.now();
    let db: DatabaseSync | null = null;

    while (true) {
      try {
        db = new DatabaseSync(lockDbPath);
        db.exec('PRAGMA busy_timeout = 0;');
        db.exec('CREATE TABLE IF NOT EXISTS _nonce_lock (id INTEGER PRIMARY KEY, pid INTEGER, acquired_at INTEGER);');
        db.exec('BEGIN EXCLUSIVE;');
        // Lock acquired exclusively across all processes and threads
        break;
      } catch (err: unknown) {
        if (db) {
          try {
            db.close();
          } catch {
            // Ignored
          }
          db = null;
        }

        const msg = (err as Error)?.message ?? '';
        const isLocked = msg.includes('locked') || msg.includes('busy');
        if (!isLocked) {
          throw err;
        }

        if (Date.now() - startTime >= timeoutMs) {
          throw new Error(
            `Timeout acquiring cross-process lock for ${normalizedPath} after ${timeoutMs}ms`
          );
        }

        const jitter = Math.floor(Math.random() * 10);
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs + jitter));
      }
    }

    let succeeded = false;
    try {
      const result = await operation();
      succeeded = true;
      return result;
    } finally {
      if (db) {
        try {
          if (succeeded) {
            db.exec('COMMIT;');
          } else {
            db.exec('ROLLBACK;');
          }
        } catch {
          // Transaction may have already been closed
        }
        try {
          db.close();
        } catch {
          // Ignored
        }
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


