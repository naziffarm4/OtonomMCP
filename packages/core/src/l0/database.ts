import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileRecord } from './types.js';
import { L0IndexError } from '../errors/l0-index-error.js';

export interface L0DatabaseOptions {
  dbPath: string;
}

/**
 * SQLite L0 Database Client using Node.js 24 native node:sqlite.
 * Manages table schemas, WAL mode verification, and transactional index persistence.
 */
export class L0Database {
  readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(options: L0DatabaseOptions) {
    this.dbPath = options.dbPath;
  }

  /**
   * Initializes SQLite database, enables and verifies WAL mode, and applies idempotent schemas.
   */
  open(): void {
    if (this.db) {
      return;
    }

    const dir = path.dirname(this.dbPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new L0IndexError(`Failed to create directory '${dir}' for L0 database`, {
        operation: 'open',
        path: dir,
        cause: err,
      });
    }

    try {
      this.db = new DatabaseSync(this.dbPath);
    } catch (err) {
      throw new L0IndexError(`Failed to open SQLite database at '${this.dbPath}'`, {
        operation: 'open',
        path: this.dbPath,
        cause: err,
      });
    }

    // 1. Enable WAL mode and verify that the database engine actually reported "wal"
    this.configureAndVerifyWal();

    // 2. Performance pragmas
    try {
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
    } catch (err) {
      throw new L0IndexError(`Failed to configure database pragmas`, {
        operation: 'pragmas',
        path: this.dbPath,
        cause: err,
      });
    }

    // 3. Create idempotent table schema
    this.initSchema();
  }

  private configureAndVerifyWal(): void {
    if (!this.db) throw new L0IndexError('Database is not open', { operation: 'configureAndVerifyWal' });

    let walResult: { journal_mode?: string } | undefined;
    try {
      walResult = this.db.prepare('PRAGMA journal_mode = WAL;').get() as { journal_mode?: string };
    } catch (err) {
      throw new L0IndexError(`Failed to execute 'PRAGMA journal_mode = WAL;'`, {
        operation: 'configureAndVerifyWal',
        path: this.dbPath,
        cause: err,
      });
    }

    const effectiveMode = walResult?.journal_mode?.toLowerCase();
    if (effectiveMode !== 'wal') {
      throw new L0IndexError(
        `SQLite failed to enable WAL mode. Expected 'wal', got '${effectiveMode}'`,
        {
          operation: 'configureAndVerifyWal',
          path: this.dbPath,
        }
      );
    }

    // Double check with read query
    const checkQuery = this.db.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string };
    if (checkQuery?.journal_mode?.toLowerCase() !== 'wal') {
      throw new L0IndexError(
        `WAL mode verification check failed. Current journal_mode: '${checkQuery?.journal_mode}'`,
        {
          operation: 'configureAndVerifyWal',
          path: this.dbPath,
        }
      );
    }
  }

  /**
   * Returns current SQLite journal mode.
   */
  getJournalMode(): string {
    this.ensureOpen();
    const res = this.db!.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string };
    return res?.journal_mode ?? 'unknown';
  }

  /**
   * Idempotent table schema initialization.
   */
  private initSchema(): void {
    this.ensureOpen();
    try {
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS file_index (
          path TEXT PRIMARY KEY NOT NULL,
          sha256 TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_index_sha256 ON file_index(sha256);
      `);
    } catch (err) {
      throw new L0IndexError(`Failed to initialize L0 schema in '${this.dbPath}'`, {
        operation: 'initSchema',
        path: this.dbPath,
        cause: err,
      });
    }
  }

  /**
   * Retrieves single indexed file record by its normalized relative path.
   */
  getFile(relativePath: string): FileRecord | null {
    this.ensureOpen();
    try {
      const stmt = this.db!.prepare(
        'SELECT path, sha256, size, mtime_ms, indexed_at FROM file_index WHERE path = ?'
      );
      const row = stmt.get(relativePath) as {
        path: string;
        sha256: string;
        size: number;
        mtime_ms: number;
        indexed_at: string;
      } | undefined;

      if (!row) return null;

      return {
        path: row.path,
        sha256: row.sha256,
        size: row.size,
        mtimeMs: row.mtime_ms,
        indexedAt: row.indexed_at,
      };
    } catch (err) {
      throw new L0IndexError(`Failed to get file '${relativePath}' from index`, {
        operation: 'getFile',
        path: relativePath,
        cause: err,
      });
    }
  }

  /**
   * Retrieves all indexed file records, sorted by path.
   */
  getAllFiles(): FileRecord[] {
    this.ensureOpen();
    try {
      const stmt = this.db!.prepare(
        'SELECT path, sha256, size, mtime_ms, indexed_at FROM file_index ORDER BY path ASC'
      );
      const rows = stmt.all() as Array<{
        path: string;
        sha256: string;
        size: number;
        mtime_ms: number;
        indexed_at: string;
      }>;

      return rows.map((r) => ({
        path: r.path,
        sha256: r.sha256,
        size: r.size,
        mtimeMs: r.mtime_ms,
        indexedAt: r.indexed_at,
      }));
    } catch (err) {
      throw new L0IndexError(`Failed to get all files from index`, {
        operation: 'getAllFiles',
        cause: err,
      });
    }
  }

  /**
   * Applies index changes atomically in a single SQLite transaction.
   * If any statement fails, rolls back the transaction completely.
   */
  syncTransaction(toUpsert: FileRecord[], toDeletePaths: string[]): void {
    this.ensureOpen();
    const db = this.db!;

    db.exec('BEGIN IMMEDIATE;');
    try {
      if (toUpsert.length > 0) {
        const insertStmt = db.prepare(`
          INSERT INTO file_index (path, sha256, size, mtime_ms, indexed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            sha256 = excluded.sha256,
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            indexed_at = excluded.indexed_at;
        `);

        for (const file of toUpsert) {
          insertStmt.run(file.path, file.sha256, file.size, file.mtimeMs, file.indexedAt);
        }
      }

      if (toDeletePaths.length > 0) {
        const deleteStmt = db.prepare('DELETE FROM file_index WHERE path = ?;');
        for (const relPath of toDeletePaths) {
          deleteStmt.run(relPath);
        }
      }

      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw new L0IndexError(`Index synchronization transaction failed and was rolled back`, {
        operation: 'syncTransaction',
        path: this.dbPath,
        cause: err,
      });
    }
  }

  /**
   * Closes database connection.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        throw new L0IndexError(`Failed to close database '${this.dbPath}'`, {
          operation: 'close',
          path: this.dbPath,
          cause: err,
        });
      } finally {
        this.db = null;
      }
    }
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  private ensureOpen(): void {
    if (!this.db) {
      this.open();
    }
  }
}
