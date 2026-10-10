import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import { StorageError } from '../errors/storage-error.js';

/**
 * Strict schema validation for epoch timestamps and durations:
 * - Must be of type 'number'
 * - Must be a safe integer via Number.isSafeInteger() (rejects non-integers, fractional values/floats, and values outside safe integer bounds)
 * - Must be finite via Number.isFinite() (rejects NaN, Infinity, -Infinity)
 * - Must be non-negative (>= 0 epoch ms or duration)
 * - Must be less than or equal to Number.MAX_SAFE_INTEGER (rejects numerical overflows from JSON parsing like 1e999, 1e300)
 *
 * @param val Value to validate as an epoch timestamp or duration
 */
export function isValidNonceTimestamp(val: unknown): val is number {
  return (
    typeof val === 'number' &&
    Number.isSafeInteger(val) &&
    Number.isFinite(val) &&
    val >= 0 &&
    val <= Number.MAX_SAFE_INTEGER
  );
}

/**
 * Computes and strictly validates the expiration timestamp for a nonce reservation.
 *
 * Requirements & Unit Semantics:
 * - `now`: Current epoch timestamp in milliseconds (Date.now()). Must satisfy `isValidNonceTimestamp(now)` (safe integer).
 * - `ttlMs`: Requested time-to-live duration in milliseconds. Must be a positive finite safe integer (> 0 and <= Number.MAX_SAFE_INTEGER).
 * - Calculation: `now + ttlMs`.
 * - Persistence constraint: Must satisfy `isValidNonceTimestamp(expiresAt)` (finite, safe integer, non-negative, <= Number.MAX_SAFE_INTEGER).
 *
 * Fail-Closed Defense:
 * Even if `ttlMs` independently passes input checking (e.g. `Number.MAX_SAFE_INTEGER`),
 * the resulting addition `now + ttlMs` exceeds `Number.MAX_SAFE_INTEGER` and overflows JavaScript safe
 * integer arithmetic. This function detects arithmetic overflow post-calculation and throws `StorageError`
 * before any persistent mutation or disk write occurs.
 *
 * @param now Current epoch timestamp in milliseconds
 * @param ttlMs Time-to-live duration in milliseconds
 * @param filePath Nonce store file path for error context
 * @returns Safe reservation expiration epoch timestamp in milliseconds
 * @throws StorageError if input or calculated timestamp is fractional or exceeds safe integer bounds
 */
export function computeReservationExpiresAt(
  now: number,
  ttlMs: number,
  filePath: string
): number {
  if (!isValidNonceTimestamp(now)) {
    throw new StorageError(
      `Invalid current timestamp: ${now}. Must be non-negative finite safe integer.`,
      { filePath, operation: 'reserveNonce' }
    );
  }

  if (!isValidNonceTimestamp(ttlMs) || ttlMs === 0) {
    throw new StorageError(
      `Invalid ttlMs: ${ttlMs}. Expected positive finite safe integer.`,
      { filePath, operation: 'reserveNonce' }
    );
  }

  const expiresAt = now + ttlMs;
  if (!isValidNonceTimestamp(expiresAt)) {
    throw new StorageError(
      `Calculated reservation expiration timestamp (${now} + ${ttlMs} = ${expiresAt}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
      { filePath, operation: 'reserveNonce' }
    );
  }

  return expiresAt;
}

/**
 * Computes and strictly validates the retention expiration timestamp (`retentionUntil`)
 * for seen nonces.
 *
 * Input type, unit semantics, and compatibility rules:
 * 1. `optionsOrExpiresAt` = undefined | null:
 *    - Uses default retention window: `now + defaultRetentionMs`.
 *
 * 2. `optionsOrExpiresAt` = number:
 *    - Must satisfy `isValidNonceTimestamp(optionsOrExpiresAt)` (positive safe integer).
 *    - If `> 1e11`: Treated as absolute Unix epoch milliseconds (e.g. standard timestamps > 1973 AD).
 *      Calculated candidate: `optionsOrExpiresAt + clockSkewMs`.
 *      Retention is `Math.max(calculated, now + defaultRetentionMs)`.
 *    - If `> 1e9` and `<= 1e11`: Treated as absolute Unix epoch seconds (Unix timestamp).
 *      Converted to ms: `optionsOrExpiresAt * 1000`.
 *      Calculated candidate: `(optionsOrExpiresAt * 1000) + clockSkewMs`.
 *      Retention is `Math.max(calculated, now + defaultRetentionMs)`.
 *    - If `<= 1e9`: Treated as relative TTL duration in milliseconds (up to ~11.5 days).
 *      Calculated candidate: `now + Math.max(optionsOrExpiresAt, defaultRetentionMs)`.
 *
 * 3. `optionsOrExpiresAt` = object (`{ expiresAt?: number; ttlMs?: number }`):
 *    - If `expiresAt` is present:
 *      Must satisfy `isValidNonceTimestamp(expiresAt)`.
 *      Converted: `expMs = expiresAt > 1e11 ? expiresAt : expiresAt * 1000`.
 *      Calculated candidate: `expMs + clockSkewMs`.
 *      Retention is `Math.max(calculated, now + defaultRetentionMs)`.
 *    - Else if `ttlMs` is present:
 *      Must satisfy `isValidNonceTimestamp(ttlMs)`.
 *      Calculated candidate: `now + Math.max(ttlMs, defaultRetentionMs)`.
 *    - Else:
 *      Calculated candidate: `now + defaultRetentionMs`.
 *
 * Fail-Closed Post-Calculation Validation:
 * - Every arithmetic step (`optionsOrExpiresAt + clockSkewMs`, `expMs + clockSkewMs`, `now + ttlMs`, `now + defaultRetentionMs`)
 *   is strictly bounded: candidate must be a safe integer (candidate <= Number.MAX_SAFE_INTEGER and Number.isSafeInteger(candidate)).
 * - If any calculation overflows Number.MAX_SAFE_INTEGER or results in a non-integer,
 *   it is rejected immediately with `StorageError` before acquiring locks or mutating state.
 *
 * @param now Current epoch timestamp in milliseconds
 * @param optionsOrExpiresAt Expiration or TTL specification
 * @param defaultRetentionMs Default retention period in milliseconds
 * @param clockSkewMs Allowed clock skew tolerance in milliseconds
 * @param filePath Nonce store file path for error context
 * @param operation Operation name for error context
 * @returns Safe retention epoch timestamp in milliseconds
 * @throws StorageError if input or calculated timestamp is fractional or exceeds safe bounds
 */
export function calculateRetentionUntil(
  now: number,
  optionsOrExpiresAt: number | { expiresAt?: number; ttlMs?: number } | undefined,
  defaultRetentionMs: number,
  clockSkewMs: number,
  filePath: string,
  operation: string
): number {
  if (!isValidNonceTimestamp(now)) {
    throw new StorageError(
      `Invalid current timestamp: ${now}. Must be non-negative finite safe integer.`,
      { filePath, operation }
    );
  }
  if (!isValidNonceTimestamp(defaultRetentionMs)) {
    throw new StorageError(
      `Invalid defaultRetentionMs: ${defaultRetentionMs}. Must be non-negative finite safe integer.`,
      { filePath, operation }
    );
  }
  if (!isValidNonceTimestamp(clockSkewMs)) {
    throw new StorageError(
      `Invalid clockSkewMs: ${clockSkewMs}. Must be non-negative finite safe integer.`,
      { filePath, operation }
    );
  }

  const defaultRetentionUntil = now + defaultRetentionMs;
  if (!isValidNonceTimestamp(defaultRetentionUntil)) {
    throw new StorageError(
      `Calculated default retention timestamp (${now} + ${defaultRetentionMs} = ${defaultRetentionUntil}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
      { filePath, operation }
    );
  }

  let retentionUntil: number;

  if (typeof optionsOrExpiresAt === 'number') {
    if (!isValidNonceTimestamp(optionsOrExpiresAt)) {
      throw new StorageError(
        `Invalid expiration/ttl timestamp: ${optionsOrExpiresAt}. Must be non-negative finite safe integer.`,
        { filePath, operation }
      );
    }

    if (optionsOrExpiresAt > 1e11) {
      const expCandidate = optionsOrExpiresAt + clockSkewMs;
      if (!isValidNonceTimestamp(expCandidate)) {
        throw new StorageError(
          `Calculated retention timestamp (${optionsOrExpiresAt} + clockSkewMs ${clockSkewMs} = ${expCandidate}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
          { filePath, operation }
        );
      }
      retentionUntil = Math.max(expCandidate, defaultRetentionUntil);
    } else if (optionsOrExpiresAt > 1e9) {
      const expMs = optionsOrExpiresAt * 1000;
      if (!isValidNonceTimestamp(expMs)) {
        throw new StorageError(
          `Calculated expiration timestamp in milliseconds (${optionsOrExpiresAt} * 1000 = ${expMs}) exceeds safe bounds.`,
          { filePath, operation }
        );
      }
      const expCandidate = expMs + clockSkewMs;
      if (!isValidNonceTimestamp(expCandidate)) {
        throw new StorageError(
          `Calculated retention timestamp (${expMs} + clockSkewMs ${clockSkewMs} = ${expCandidate}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
          { filePath, operation }
        );
      }
      retentionUntil = Math.max(expCandidate, defaultRetentionUntil);
    } else {
      const candidate = now + Math.max(optionsOrExpiresAt, defaultRetentionMs);
      if (!isValidNonceTimestamp(candidate)) {
        throw new StorageError(
          `Calculated retention timestamp (${now} + TTL ${optionsOrExpiresAt} = ${candidate}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
          { filePath, operation }
        );
      }
      retentionUntil = candidate;
    }
  } else if (optionsOrExpiresAt && typeof optionsOrExpiresAt === 'object') {
    if (Array.isArray(optionsOrExpiresAt)) {
      throw new StorageError(
        `Invalid optionsOrExpiresAt: expected options object or number, got array.`,
        { filePath, operation }
      );
    }
    if (optionsOrExpiresAt.expiresAt !== undefined && !isValidNonceTimestamp(optionsOrExpiresAt.expiresAt)) {
      throw new StorageError(
        `Invalid expiresAt timestamp: ${optionsOrExpiresAt.expiresAt}. Must be non-negative finite safe integer.`,
        { filePath, operation }
      );
    }
    if (optionsOrExpiresAt.ttlMs !== undefined && !isValidNonceTimestamp(optionsOrExpiresAt.ttlMs)) {
      throw new StorageError(
        `Invalid ttlMs: ${optionsOrExpiresAt.ttlMs}. Must be non-negative finite safe integer.`,
        { filePath, operation }
      );
    }

    if (optionsOrExpiresAt.expiresAt !== undefined) {
      const expMs =
        optionsOrExpiresAt.expiresAt > 1e11
          ? optionsOrExpiresAt.expiresAt
          : optionsOrExpiresAt.expiresAt * 1000;
      if (!isValidNonceTimestamp(expMs)) {
        throw new StorageError(
          `Calculated expiresAt in milliseconds (${expMs}) exceeds safe bounds.`,
          { filePath, operation }
        );
      }
      const expCandidate = expMs + clockSkewMs;
      if (!isValidNonceTimestamp(expCandidate)) {
        throw new StorageError(
          `Calculated retention timestamp (${expMs} + clockSkewMs ${clockSkewMs} = ${expCandidate}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
          { filePath, operation }
        );
      }
      retentionUntil = Math.max(expCandidate, defaultRetentionUntil);
    } else if (optionsOrExpiresAt.ttlMs !== undefined) {
      const candidate = now + Math.max(optionsOrExpiresAt.ttlMs, defaultRetentionMs);
      if (!isValidNonceTimestamp(candidate)) {
        throw new StorageError(
          `Calculated retention timestamp (${now} + TTL ${optionsOrExpiresAt.ttlMs} = ${candidate}) exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
          { filePath, operation }
        );
      }
      retentionUntil = candidate;
    } else {
      retentionUntil = defaultRetentionUntil;
    }
  } else if (optionsOrExpiresAt === undefined || optionsOrExpiresAt === null) {
    retentionUntil = defaultRetentionUntil;
  } else {
    throw new StorageError(
      `Invalid optionsOrExpiresAt: expected number, options object, or undefined.`,
      { filePath, operation }
    );
  }

  if (!isValidNonceTimestamp(retentionUntil)) {
    throw new StorageError(
      `Calculated retention timestamp ${retentionUntil} is invalid or exceeds safe bounds (0 - Number.MAX_SAFE_INTEGER).`,
      { filePath, operation }
    );
  }

  return retentionUntil;
}


/**
 * Persisted schema specification and backward-compatibility rules:
 *
 * 1. Root structure:
 *    - Modern format: JSON Object { seen: string[], seenUntil?: Record<string, number>, reserved: Record<string, number> }
 *    - Legacy format: JSON Array string[] (representing seen nonces without timestamps)
 *
 * 2. Field definitions:
 *    - `seen`: REQUIRED. Array of non-empty strings. Represents all nonces that have been consumed.
 *    - `seenUntil`: OPTIONAL. Object map of nonce -> retention epoch timestamp in milliseconds.
 *      - Timestamp constraints: Must be a non-negative finite safe integer (0 <= ts <= Number.MAX_SAFE_INTEGER).
 *      - Numerical overflows (e.g. 1e999, -1e999, Infinity, -Infinity, NaN, values > MAX_SAFE_INTEGER, fractional values) are strictly rejected with StorageError.
 *      - Backward compatibility: If seenUntil is absent or a nonce in `seen` does not have a timestamp in `seenUntil`,
 *        it is retained indefinitely to enforce fail-closed replay protection.
 *    - `reserved`: OPTIONAL. Object map of nonce -> expiration epoch timestamp in milliseconds.
 *      - Timestamp constraints: Same as seenUntil. Must be a non-negative finite safe integer.
 *      - Expired reservations (ts <= now) are cleanly pruned on read. Active reservations (ts > now) block reuse.
 *
 * 3. Fail-Closed Invariant:
 *    - Any malformed JSON, corrupted data, invalid types, or out-of-range/overflow timestamps immediately
 *      cause `readStateUnderLock` to throw `StorageError`.
 *    - When `StorageError` is thrown, the SQLite transaction rolls back and the on-disk file is NEVER modified,
 *      truncated, or overwritten with empty state.
 */
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

    if (options?.defaultRetentionMs !== undefined) {
      if (!isValidNonceTimestamp(options.defaultRetentionMs)) {
        throw new StorageError(
          `Invalid defaultRetentionMs: ${options.defaultRetentionMs}. Must be non-negative finite safe integer.`,
          { filePath: this.filePath, operation: 'constructor' }
        );
      }
      this.defaultRetentionMs = options.defaultRetentionMs;
    } else {
      this.defaultRetentionMs = 24 * 60 * 60 * 1000;
    }

    if (options?.clockSkewMs !== undefined) {
      if (!isValidNonceTimestamp(options.clockSkewMs)) {
        throw new StorageError(
          `Invalid clockSkewMs: ${options.clockSkewMs}. Must be non-negative finite safe integer.`,
          { filePath: this.filePath, operation: 'constructor' }
        );
      }
      this.clockSkewMs = options.clockSkewMs;
    } else {
      this.clockSkewMs = 5 * 60 * 1000;
    }
  }

  /**
   * Reads fresh persistent state under cross-process lock and cleans up expired reservations
   * and seen nonces whose retention period has expired.
   *
   * Differentiates:
   * 1. Initial creation (ENOENT): returns fresh empty state.
   * 2. Valid persistent state (object schema or legacy array): parsed & returned.
   * 3. Corrupt/truncated JSON, I/O errors, permission denied, or invalid schema/timestamps:
   *    THROWS StorageError (fail-closed) and refuses to overwrite existing state on disk.
   */
  private async readStateUnderLock(): Promise<PersistedNonceData> {
    const now = Date.now();
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(this.filePath);
    } catch (err: unknown) {
      // Differentiates read / I-O / parse errors from non-existent file
      throw new StorageError(
        `Failed to read nonce state from '${this.filePath}': ${err instanceof Error ? err.message : String(err)}`,
        {
          filePath: this.filePath,
          operation: 'readStateUnderLock',
          cause: err,
        }
      );
    }

    if (raw === null) {
      // Check if file actually exists (e.g. content was literal "null")
      try {
        await fs.promises.stat(this.filePath);
        // File exists on disk, but parsed to null -> invalid schema!
        throw new StorageError(
          `Nonce store file '${this.filePath}' contains invalid state (parsed null). Refusing to treat as empty state.`,
          {
            filePath: this.filePath,
            operation: 'validateNonceState',
          }
        );
      } catch (statErr: unknown) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
          // File does NOT exist yet. Safe initial creation!
          return { seen: [], seenUntil: {}, reserved: {} };
        }
        throw new StorageError(
          `Failed to verify existence of nonce store file '${this.filePath}': ${(statErr as Error).message}`,
          {
            filePath: this.filePath,
            operation: 'stat',
            cause: statErr,
          }
        );
      }
    }

    // Validate schema of raw content
    if (Array.isArray(raw)) {
      // Legacy format compatibility: plain string[] of seen nonces
      if (!raw.every((s): s is string => typeof s === 'string' && s.length > 0)) {
        throw new StorageError(
          `Nonce store file '${this.filePath}' contains invalid legacy schema elements. Expected non-empty strings.`,
          {
            filePath: this.filePath,
            operation: 'validateNonceState',
          }
        );
      }
      return {
        seen: [...raw],
        seenUntil: {},
        reserved: {},
      };
    }

    if (typeof raw !== 'object' || raw === null) {
      throw new StorageError(
        `Nonce store file '${this.filePath}' has invalid schema. Expected JSON object or string array, got ${typeof raw}.`,
        {
          filePath: this.filePath,
          operation: 'validateNonceState',
        }
      );
    }

    const obj = raw as Record<string, unknown>;

    // 'seen' must be an array of non-empty strings
    if (!('seen' in obj) || !Array.isArray(obj.seen)) {
      throw new StorageError(
        `Nonce store file '${this.filePath}' is missing required 'seen' array property.`,
        {
          filePath: this.filePath,
          operation: 'validateNonceState',
        }
      );
    }

    if (!obj.seen.every((s): s is string => typeof s === 'string' && s.length > 0)) {
      throw new StorageError(
        `Nonce store file '${this.filePath}' contains invalid elements in 'seen'. Expected non-empty strings.`,
        {
          filePath: this.filePath,
          operation: 'validateNonceState',
        }
      );
    }

    // Validate 'seenUntil' if present
    if (obj.seenUntil !== undefined) {
      if (typeof obj.seenUntil !== 'object' || obj.seenUntil === null || Array.isArray(obj.seenUntil)) {
        throw new StorageError(
          `Nonce store file '${this.filePath}' has invalid 'seenUntil' property. Expected object map.`,
          {
            filePath: this.filePath,
            operation: 'validateNonceState',
          }
        );
      }
      for (const [k, v] of Object.entries(obj.seenUntil as Record<string, unknown>)) {
        if (typeof k !== 'string' || k.length === 0 || !isValidNonceTimestamp(v)) {
          throw new StorageError(
            `Nonce store file '${this.filePath}' has invalid timestamp in 'seenUntil' for key '${k}'. Value must be a non-negative finite safe integer, got ${v}.`,
            {
              filePath: this.filePath,
              operation: 'validateNonceState',
            }
          );
        }
      }
    }

    // Validate 'reserved' if present
    if (obj.reserved !== undefined) {
      if (typeof obj.reserved !== 'object' || obj.reserved === null || Array.isArray(obj.reserved)) {
        throw new StorageError(
          `Nonce store file '${this.filePath}' has invalid 'reserved' property. Expected object map.`,
          {
            filePath: this.filePath,
            operation: 'validateNonceState',
          }
        );
      }
      for (const [k, v] of Object.entries(obj.reserved as Record<string, unknown>)) {
        if (typeof k !== 'string' || k.length === 0 || !isValidNonceTimestamp(v)) {
          throw new StorageError(
            `Nonce store file '${this.filePath}' has invalid timestamp in 'reserved' for key '${k}'. Value must be a non-negative finite safe integer, got ${v}.`,
            {
              filePath: this.filePath,
              operation: 'validateNonceState',
            }
          );
        }
      }
    }

    const rawSeen = obj.seen as string[];
    const rawSeenUntil = (obj.seenUntil ?? {}) as Record<string, number>;
    const rawReserved = (obj.reserved ?? {}) as Record<string, number>;

    const reserved: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawReserved)) {
      if (v > now) {
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

  /**
   * Pre-check / reserve a nonce temporarily (useful for two-phase approval validation).
   * Cross-process atomic: returns false if nonce was already seen or is currently reserved.
   */
  async reserveNonce(nonce: string, ttlMs = 30000): Promise<boolean> {
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new StorageError('Invalid nonce: expected non-empty string.', {
        filePath: this.filePath,
        operation: 'reserveNonce',
      });
    }
    if (!isValidNonceTimestamp(ttlMs) || ttlMs === 0) {
      throw new StorageError(
        `Invalid ttlMs: ${ttlMs}. Expected positive finite safe integer.`,
        {
          filePath: this.filePath,
          operation: 'reserveNonce',
        }
      );
    }

    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      const now = Date.now();
      const expiresAt = computeReservationExpiresAt(now, ttlMs, this.filePath);

      if (state.seen.includes(nonce)) {
        return false;
      }

      if (state.reserved[nonce] && state.reserved[nonce] > now) {
        return false;
      }

      state.reserved[nonce] = expiresAt;
      await atomicWriteJson(this.filePath, state);
      return true;
    });
  }

  /**
   * Release a previously reserved nonce if approval evaluation fails before commit.
   * Cross-process atomic.
   */
  async releaseReservation(nonce: string): Promise<void> {
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new StorageError('Invalid nonce: expected non-empty string.', {
        filePath: this.filePath,
        operation: 'releaseReservation',
      });
    }

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
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new StorageError('Invalid nonce: expected non-empty string.', {
        filePath: this.filePath,
        operation: 'markNonceSeen',
      });
    }

    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      const now = Date.now();
      const retentionUntil = calculateRetentionUntil(
        now,
        optionsOrExpiresAt,
        this.defaultRetentionMs,
        this.clockSkewMs,
        this.filePath,
        'markNonceSeen'
      );

      if (state.seen.includes(nonce)) {
        return false;
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
    if (!Array.isArray(nonces) || !nonces.every((n) => typeof n === 'string' && n.trim().length > 0)) {
      throw new StorageError('Invalid nonces batch: expected array of non-empty strings.', {
        filePath: this.filePath,
        operation: 'markNoncesSeenBatch',
      });
    }

    return withCrossProcessNonceLock(this.filePath, async () => {
      const state = await this.readStateUnderLock();
      const now = Date.now();
      const retentionUntil = calculateRetentionUntil(
        now,
        optionsOrExpiresAt,
        this.defaultRetentionMs,
        this.clockSkewMs,
        this.filePath,
        'markNoncesSeenBatch'
      );

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
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new StorageError('Invalid nonce: expected non-empty string.', {
        filePath: this.filePath,
        operation: 'isNonceSeen',
      });
    }

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


