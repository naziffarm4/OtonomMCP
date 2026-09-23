import * as path from 'node:path';
import { computeFileSha256 } from '../l0/hasher.js';
import { FileHashCollectionError } from '../errors/collector-error.js';
import { isValidSha256 } from './evidence-validator.js';

export interface FileHashCollectionOptions {
  /** Optional base directory to resolve relative file paths */
  readonly workingDirectory?: string;
  /**
   * If true, missing files are omitted rather than throwing an error.
   * Under NO circumstances will a missing file receive a fabricated hash.
   * Defaults to false (strict mode).
   */
  readonly allowMissing?: boolean;
  /** Injectable hasher function for testing or alternative hash providers */
  readonly fileHasher?: (fullPath: string) => Promise<string>;
}

/**
 * Normalizes file paths into deterministic, platform-independent relative/canonical format.
 * Replaces backslashes with forward slashes.
 */
export function normalizeEvidenceFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').trim();
}

/**
 * Collects SHA-256 hashes for explicitly requested relevant file paths.
 * Guarantees:
 * 1. Only requested files are hashed.
 * 2. SHA-256 algorithm with lowercase hexadecimal representation.
 * 3. Deterministic key ordering (keys sorted ascending).
 * 4. Missing/unreadable files produce structured collection failure (or omission if allowMissing=true).
 * 5. NEVER fabricates a file hash.
 */
export class FileHashCollector {
  private readonly defaultHasher: (fullPath: string) => Promise<string>;

  constructor(hasher?: (fullPath: string) => Promise<string>) {
    this.defaultHasher = hasher ?? computeFileSha256;
  }

  async collectHashes(
    filePaths: readonly string[],
    options?: FileHashCollectionOptions
  ): Promise<Readonly<Record<string, string>>> {
    if (!filePaths || filePaths.length === 0) {
      return Object.freeze({});
    }

    const hasher = options?.fileHasher ?? this.defaultHasher;
    const workingDir = options?.workingDirectory;
    const allowMissing = options?.allowMissing ?? false;

    // Deduplicate and deterministically sort paths ascending
    const normalizedMap = new Map<string, string>(); // normalizedKey -> originalPath
    for (const rawPath of filePaths) {
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        continue;
      }
      const normalizedKey = normalizeEvidenceFilePath(rawPath);
      if (!normalizedMap.has(normalizedKey)) {
        normalizedMap.set(normalizedKey, rawPath);
      }
    }

    const sortedKeys = Array.from(normalizedMap.keys()).sort((a, b) => a.localeCompare(b, 'en'));
    const result: Record<string, string> = {};

    for (const key of sortedKeys) {
      const originalPath = normalizedMap.get(key)!;
      const fullPath = workingDir && !path.isAbsolute(originalPath)
        ? path.resolve(workingDir, originalPath)
        : originalPath;

      try {
        const hash = await hasher(fullPath);
        const lowerHash = hash.toLowerCase();

        if (!isValidSha256(lowerHash)) {
          throw new FileHashCollectionError(
            `Hasher produced invalid SHA-256 format for file '${key}': '${hash}'`,
            {
              path: key,
              reason: 'INVALID_HASH_FORMAT',
            }
          );
        }

        result[key] = lowerHash;
      } catch (err) {
        if (err instanceof FileHashCollectionError) {
          throw err;
        }

        if (allowMissing) {
          // Never fabricate; simply do not include
          continue;
        }

        throw new FileHashCollectionError(
          `Failed to compute SHA-256 hash for requested file '${key}': ${
            err instanceof Error ? err.message : String(err)
          }`,
          {
            path: key,
            workingDirectory: workingDir,
            reason: 'FILE_UNREADABLE_OR_MISSING',
            cause: err,
          }
        );
      }
    }

    return Object.freeze(result);
  }
}
