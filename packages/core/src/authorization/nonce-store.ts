import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';

export interface PersistedNonceData {
  seen: string[];
  seenUntil?: Record<string, number>; // nonce -> retentionUntil timestamp (epoch ms)
  reserved: Record<string, number>; // nonce -> expiresAt (epoch ms)
}

// Process-wide mutex per normalized file path to serialize async operations within the same process
export const inProcessLockQueues = new Map<string, Promise<void>>();

export function withInProcessLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  const prevLock = inProcessLockQueues.get(normalizedPath) ?? Promise.resolve();

  let releaseLock: () => void = () => {};
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  // Tail promise settles after prevLock settles and our operation releases the lock.
  // Using .catch(() => {}) ensures an earlier operation's rejection does not poison subsequent operations.
  const tailPromise = prevLock
    .catch(() => {})
    .then(() => lockPromise);

  inProcessLockQueues.set(normalizedPath, tailPromise);

  return prevLock
    .catch(() => {})
    .then(operation)
    .finally(() => {
      releaseLock();
      // Clean up the queue entry only if no newer operation has queued behind us
      if (inProcessLockQueues.get(normalizedPath) === tailPromise) {
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

export interface NonceStoreOptions {
  baseDir?: string;
  filePath?: string;
  defaultRetentionMs?: number; // default: 24 hours (86,400,000 ms)
  clockSkewMs?: number; // default: 5 minutes (300,000 ms)
}

export class NonceStore {
  readonly filePath: string;
  readonly defaultRetentionMs: number;
  readonly clockSkewMs: number;

  constructor(options?: NonceStoreOptions) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'seen-nonces.json');
    }
    this.defaultRetentionMs = options?.defaultRetentionMs ?? 24 * 60 * 60 * 1000;
    this.clockSkewMs = options?.clockSkewMs ?? 5 * 60 * 1000;
  }

  /**
   * Reads fresh persistent state under cross-process lock and cleans up expired reservations
   * and seen nonces whose retention period has expired.
   *
   * Note: Seen nonces are NEVER pruned simply because the list reached an arbitrary count (such as 2,000).
   * They are strictly retained until their cryptographic validity/retention period has passed.
   */
  private async readStateUnderLock(): Promise<PersistedNonceData> {
    const now = Date.now();
    try {
      const raw = await readJsonFile<unknown>(this.filePath);
      if (Array.isArray(raw)) {
        // Legacy format compatibility: plain string[] of seen nonces
        return {
          seen: raw.filter((s): s is string => typeof s === 'string'),
          seenUntil: {},
          reserved: {},
        };
      }
      if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        const rawSeen = Array.isArray(obj.seen)
          ? obj.seen.filter((s): s is string => typeof s === 'string')
          : [];
        const rawSeenUntil =
          obj.seenUntil && typeof obj.seenUntil === 'object'
            ? (obj.seenUntil as Record<string, unknown>)
            : {};
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

        // Time-based retention cleanup:
        // A seen nonce is ONLY pruned if its retention timestamp has expired (until <= now).
        // It is NEVER pruned simply because the list size exceeded 2,000!
        // If seenUntil timestamp is absent (legacy entries), retain by default to be fail-closed.
        const seen: string[] = [];
        const seenUntil: Record<string, number> = {};
        for (const nonce of rawSeen) {
          const until = rawSeenUntil[nonce];
          if (typeof until === 'number') {
            if (until > now) {
              seen.push(nonce);
              seenUntil[nonce] = until;
            }
          } else {
            // Legacy entry without timestamp - retain safely
            seen.push(nonce);
          }
        }

        return { seen, seenUntil, reserved };
      }
    } catch {
      // File does not exist yet or unreadable
    }
    return { seen: [], seenUntil: {}, reserved: {} };
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
   *
   * @param nonce The unique nonce to mark as consumed.
   * @param optionsOrExpiresAt Optional expiration epoch ms or options with expiresAt/ttlMs.
   */
  async markNonceSeen(
    nonce: string,
    optionsOrExpiresAt?: number | { expiresAt?: number; ttlMs?: number }
  ): Promise<boolean> {
    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();

      if (state.seen.includes(nonce)) {
        return false;
      }

      const now = Date.now();
      let retentionUntil: number;

      if (typeof optionsOrExpiresAt === 'number') {
        if (optionsOrExpiresAt > 1e11) {
          retentionUntil = Math.max(optionsOrExpiresAt + this.clockSkewMs, now + this.defaultRetentionMs);
        } else if (optionsOrExpiresAt > 1e9) {
          retentionUntil = Math.max(optionsOrExpiresAt * 1000 + this.clockSkewMs, now + this.defaultRetentionMs);
        } else {
          retentionUntil = now + Math.max(optionsOrExpiresAt, this.defaultRetentionMs);
        }
      } else if (optionsOrExpiresAt && typeof optionsOrExpiresAt === 'object') {
        if (typeof optionsOrExpiresAt.expiresAt === 'number') {
          const expMs = optionsOrExpiresAt.expiresAt > 1e11 ? optionsOrExpiresAt.expiresAt : optionsOrExpiresAt.expiresAt * 1000;
          retentionUntil = Math.max(expMs + this.clockSkewMs, now + this.defaultRetentionMs);
        } else if (typeof optionsOrExpiresAt.ttlMs === 'number') {
          retentionUntil = now + Math.max(optionsOrExpiresAt.ttlMs, this.defaultRetentionMs);
        } else {
          retentionUntil = now + this.defaultRetentionMs;
        }
      } else {
        retentionUntil = now + this.defaultRetentionMs;
      }

      state.seen.push(nonce);
      state.seenUntil = state.seenUntil ?? {};
      state.seenUntil[nonce] = retentionUntil;
      delete state.reserved[nonce];

      await atomicWriteJson(this.filePath, state);
      return true;
    });
  }

  /**
   * Batch mark multiple nonces as consumed under a single atomic lock.
   */
  async markNoncesSeenBatch(
    nonces: string[],
    optionsOrExpiresAt?: number | { expiresAt?: number; ttlMs?: number }
  ): Promise<number> {
    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      const now = Date.now();
      let retentionUntil = now + this.defaultRetentionMs;

      if (typeof optionsOrExpiresAt === 'number') {
        if (optionsOrExpiresAt > 1e11) {
          retentionUntil = Math.max(optionsOrExpiresAt + this.clockSkewMs, now + this.defaultRetentionMs);
        } else if (optionsOrExpiresAt > 1e9) {
          retentionUntil = Math.max(optionsOrExpiresAt * 1000 + this.clockSkewMs, now + this.defaultRetentionMs);
        }
      }

      state.seenUntil = state.seenUntil ?? {};
      let added = 0;
      for (const nonce of nonces) {
        if (!state.seen.includes(nonce)) {
          state.seen.push(nonce);
          state.seenUntil[nonce] = retentionUntil;
          delete state.reserved[nonce];
          added++;
        }
      }

      await atomicWriteJson(this.filePath, state);
      return added;
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


