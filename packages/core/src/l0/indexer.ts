import * as path from 'node:path';
import type {
  FileChange,
  FileRecord,
  L0IndexerOptions,
  SyncResult,
} from './types.js';
import { FileChangeType } from './types.js';
import { L0Database } from './database.js';
import { scanWorkspaceFiles } from './scanner.js';
import { computeFileSha256 } from './hasher.js';
import { L0IndexError } from '../errors/l0-index-error.js';

/**
 * L0 Indexer & Cache Service.
 * Manages filesystem scanning, streaming SHA-256 calculation, and deterministic
 * SQLite WAL index synchronization for the workspace.
 */
export class L0Indexer {
  readonly workspaceRoot: string;
  readonly dbPath: string;
  private readonly db: L0Database;
  private readonly options: L0IndexerOptions;

  constructor(options: L0IndexerOptions) {
    if (!options.workspaceRoot) {
      throw new L0IndexError('workspaceRoot must be provided to L0Indexer', {
        operation: 'constructor',
      });
    }

    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.options = options;

    if (options.dbPath) {
      this.dbPath = path.resolve(options.dbPath);
    } else {
      this.dbPath = path.join(this.workspaceRoot, '.ai-manager', 'cache', 'context.db');
    }

    this.db = new L0Database({ dbPath: this.dbPath });
  }

  /**
   * Initializes the database connection, ensures WAL mode, and verifies table schemas.
   */
  async initialize(): Promise<void> {
    this.db.open();
  }

  /**
   * Returns current SQLite journal mode (verified to be 'wal').
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  /**
   * Executes a full synchronization of the workspace files against the SQLite index.
   * Traverses files deterministically, computes streaming SHA-256 hashes, classifies
   * changes (NEW, UNCHANGED, MODIFIED, REMOVED), and persists updates in an atomic SQLite transaction.
   */
  async sync(): Promise<SyncResult> {
    this.db.open();

    const syncedAt = new Date().toISOString();

    // 1. Deterministic filesystem scan
    const scannedFiles = await scanWorkspaceFiles(this.workspaceRoot, {
      ignorePatterns: this.options.ignorePatterns,
      followSymlinks: this.options.followSymlinks,
    });

    // 2. Read existing records from SQLite
    const existingRecords = this.db.getAllFiles();
    const existingMap = new Map<string, FileRecord>();
    for (const record of existingRecords) {
      existingMap.set(record.path, record);
    }

    const scannedPathSet = new Set<string>();
    const changes: FileChange[] = [];
    const newFiles: FileChange[] = [];
    const modifiedFiles: FileChange[] = [];
    const unchangedFiles: FileChange[] = [];
    const removedFiles: FileChange[] = [];

    const toUpsert: FileRecord[] = [];
    const toDelete: string[] = [];

    // 3. Process scanned files in deterministic order
    for (const file of scannedFiles) {
      scannedPathSet.add(file.relativePath);
      const currentHash = await computeFileSha256(file.fullPath);
      const existing = existingMap.get(file.relativePath);

      if (!existing) {
        // NEW file
        const change: FileChange = {
          path: file.relativePath,
          type: FileChangeType.NEW,
          currentHash,
          previousHash: null,
          size: file.size,
          mtimeMs: file.mtimeMs,
        };
        changes.push(change);
        newFiles.push(change);
        toUpsert.push({
          path: file.relativePath,
          sha256: currentHash,
          size: file.size,
          mtimeMs: file.mtimeMs,
          indexedAt: syncedAt,
        });
      } else if (existing.sha256 !== currentHash) {
        // MODIFIED file
        const change: FileChange = {
          path: file.relativePath,
          type: FileChangeType.MODIFIED,
          currentHash,
          previousHash: existing.sha256,
          size: file.size,
          mtimeMs: file.mtimeMs,
        };
        changes.push(change);
        modifiedFiles.push(change);
        toUpsert.push({
          path: file.relativePath,
          sha256: currentHash,
          size: file.size,
          mtimeMs: file.mtimeMs,
          indexedAt: syncedAt,
        });
      } else {
        // UNCHANGED file
        const change: FileChange = {
          path: file.relativePath,
          type: FileChangeType.UNCHANGED,
          currentHash,
          previousHash: existing.sha256,
          size: file.size,
          mtimeMs: file.mtimeMs,
        };
        changes.push(change);
        unchangedFiles.push(change);
      }
    }

    // 4. Check for REMOVED files (in existing index but no longer on disk)
    for (const existing of existingRecords) {
      if (!scannedPathSet.has(existing.path)) {
        const change: FileChange = {
          path: existing.path,
          type: FileChangeType.REMOVED,
          currentHash: null,
          previousHash: existing.sha256,
          size: null,
          mtimeMs: null,
        };
        changes.push(change);
        removedFiles.push(change);
        toDelete.push(existing.path);
      }
    }

    // 5. Ensure changes array is deterministically sorted by path
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // 6. Persist to SQLite in an atomic transaction
    if (toUpsert.length > 0 || toDelete.length > 0) {
      this.db.syncTransaction(toUpsert, toDelete);
    }

    const totalIndexed = scannedFiles.length;

    return {
      changes,
      new: newFiles,
      modified: modifiedFiles,
      unchanged: unchangedFiles,
      removed: removedFiles,
      totalIndexed,
      syncedAt,
    };
  }

  /**
   * Retrieves single indexed file by relative path.
   */
  async getFile(relativePath: string): Promise<FileRecord | null> {
    this.db.open();
    const normalized = relativePath.replace(/\\/g, '/');
    return this.db.getFile(normalized);
  }

  /**
   * Retrieves all currently indexed files.
   */
  async getAllFiles(): Promise<FileRecord[]> {
    this.db.open();
    return this.db.getAllFiles();
  }

  /**
   * Closes underlying database connection.
   */
  close(): void {
    this.db.close();
  }
}
