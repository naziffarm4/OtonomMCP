/**
 * Authoritative type definitions for L0 Indexer & Cache (TASK-P1-04).
 */

export const FileChangeType = {
  NEW: 'NEW',
  UNCHANGED: 'UNCHANGED',
  MODIFIED: 'MODIFIED',
  REMOVED: 'REMOVED',
} as const;

export type FileChangeType = (typeof FileChangeType)[keyof typeof FileChangeType];

/**
 * File record persisted in the L0 SQLite context database.
 */
export interface FileRecord {
  /**
   * Normalized relative path from workspaceRoot (using forward slashes).
   * Acts as canonical file identity.
   */
  path: string;
  /**
   * SHA-256 hash of actual file bytes (64 hexadecimal characters).
   */
  sha256: string;
  /**
   * File size in bytes.
   */
  size: number;
  /**
   * File modification time in milliseconds (from fs.stat).
   */
  mtimeMs: number;
  /**
   * ISO timestamp when the record was indexed into SQLite.
   */
  indexedAt: string;
}

/**
 * Represents a detected change for a file during synchronization.
 */
export interface FileChange {
  path: string;
  type: FileChangeType;
  currentHash: string | null;
  previousHash: string | null;
  size: number | null;
  mtimeMs: number | null;
}

/**
 * Result of a filesystem synchronization operation against the L0 index.
 */
export interface SyncResult {
  /**
   * All file changes detected in this synchronization run, in deterministic sorted order.
   */
  changes: FileChange[];
  /**
   * Newly discovered files that were not previously in the index.
   */
  new: FileChange[];
  /**
   * Files whose contents (SHA-256) changed on disk compared to the index.
   */
  modified: FileChange[];
  /**
   * Files whose contents (SHA-256) are identical to the index.
   */
  unchanged: FileChange[];
  /**
   * Previously indexed files that no longer exist on disk.
   */
  removed: FileChange[];
  /**
   * Total number of active files currently indexed after sync.
   */
  totalIndexed: number;
  /**
   * Timestamp when synchronization completed.
   */
  syncedAt: string;
}

/**
 * Metadata for a file discovered by the filesystem scanner.
 */
export interface ScannedFile {
  relativePath: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Configuration options for L0Indexer.
 */
export interface L0IndexerOptions {
  /**
   * Absolute path to project workspace root.
   */
  workspaceRoot: string;
  /**
   * Optional custom database path. Defaults to `<workspaceRoot>/.ai-manager/cache/context.db`.
   */
  dbPath?: string;
  /**
   * Additional glob/string ignore patterns (e.g. ['build', 'temp']).
   */
  ignorePatterns?: string[];
  /**
   * Whether to follow symlinks. Defaults to false to prevent infinite recursion and workspace escape.
   */
  followSymlinks?: boolean;
}
