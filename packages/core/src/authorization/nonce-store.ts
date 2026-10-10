import * as path from 'node:path';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';

// Process-wide mutex per normalized file path to prevent concurrent async race conditions
const lockQueues = new Map<string, Promise<unknown>>();

function withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const normalizedPath = path.resolve(filePath);
  const currentLock = lockQueues.get(normalizedPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const newLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockQueues.set(normalizedPath, currentLock.then(() => newLock));

  return currentLock
    .then(operation)
    .finally(() => {
      release();
      if (lockQueues.get(normalizedPath) === currentLock.then(() => newLock)) {
        lockQueues.delete(normalizedPath);
      }
    });
}

export class NonceStore {
  readonly filePath: string;
  private readonly memoryCache = new Set<string>();
  private readonly reservedNonces = new Map<string, number>();
  private isLoaded = false;

  constructor(options?: { baseDir?: string; filePath?: string }) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'seen-nonces.json');
    }
  }

  private async loadUnderLock(): Promise<void> {
    if (this.isLoaded) return;
    try {
      const data = await readJsonFile<string[]>(this.filePath);
      if (Array.isArray(data)) {
        for (const n of data) {
          if (typeof n === 'string') {
            this.memoryCache.add(n);
          }
        }
      }
    } catch {
      // file might not exist initially
    }
    this.isLoaded = true;
  }

  /**
   * Pre-check / reserve a nonce temporarily (useful for two-phase approval validation).
   * Returns false if nonce was already seen or is currently reserved.
   */
  async reserveNonce(nonce: string, ttlMs = 30000): Promise<boolean> {
    return withLock(this.filePath, async () => {
      await this.loadUnderLock();
      const now = Date.now();

      if (this.memoryCache.has(nonce)) {
        return false;
      }

      const reservedUntil = this.reservedNonces.get(nonce);
      if (reservedUntil && reservedUntil > now) {
        return false;
      }

      this.reservedNonces.set(nonce, now + ttlMs);
      return true;
    });
  }

  /**
   * Release a previously reserved nonce if approval evaluation fails before commit.
   */
  async releaseReservation(nonce: string): Promise<void> {
    return withLock(this.filePath, async () => {
      this.reservedNonces.delete(nonce);
    });
  }

  /**
   * Atomically mark nonce as permanently consumed and persist to storage.
   * Serialized via withLock: strictly race-condition proof against parallel requests.
   * Returns true if successfully marked, false if already consumed or duplicate.
   */
  async markNonceSeen(nonce: string): Promise<boolean> {
    return withLock(this.filePath, async () => {
      await this.loadUnderLock();

      if (this.memoryCache.has(nonce)) {
        return false;
      }

      this.memoryCache.add(nonce);
      this.reservedNonces.delete(nonce);

      // Keep only last 1000 nonces to prevent unbounded growth
      const nonces = Array.from(this.memoryCache);
      let trimmed = nonces;
      if (nonces.length > 1000) {
        trimmed = nonces.slice(-1000);
        this.memoryCache.clear();
        for (const n of trimmed) {
          this.memoryCache.add(n);
        }
      }

      await atomicWriteJson(this.filePath, trimmed);
      return true;
    });
  }

  /**
   * Checks whether a nonce has already been seen or reserved without consuming it.
   */
  async isNonceSeen(nonce: string): Promise<boolean> {
    return withLock(this.filePath, async () => {
      await this.loadUnderLock();
      if (this.memoryCache.has(nonce)) {
        return true;
      }
      const reservedUntil = this.reservedNonces.get(nonce);
      if (reservedUntil && reservedUntil > Date.now()) {
        return true;
      }
      return false;
    });
  }
}

