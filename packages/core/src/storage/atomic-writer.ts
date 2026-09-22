import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageError } from '../errors/storage-error.js';

export interface AtomicWriteOptions {
  /**
   * Optional file mode / permissions (e.g. 0o644).
   */
  mode?: number;
  /**
   * Indentation for JSON serialization (defaults to 2).
   */
  indent?: number;
}

/**
 * Atomically writes a string content to a target file.
 * Creates directory if needed, writes to a temporary file in the same directory,
 * flushes and syncs to disk, then atomically renames to the target path.
 * In case of failure, cleans up the temporary file and preserves the existing target file.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  options?: AtomicWriteOptions
): Promise<void> {
  const dir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const tempPath = path.join(dir, `.${baseName}.tmp.${Date.now()}.${randomSuffix}`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new StorageError(`Failed to create directory '${dir}' for atomic write`, {
      filePath: dir,
      operation: 'mkdir',
      cause: err,
    });
  }

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, 'w', options?.mode ?? 0o644);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore close error
      }
      handle = null;
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    throw new StorageError(`Failed to write temporary file '${tempPath}'`, {
      filePath: tempPath,
      operation: 'writeFile',
      cause: err,
    });
  }

  try {
    await handle.close();
    handle = null;
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw new StorageError(`Failed to close temporary file '${tempPath}'`, {
      filePath: tempPath,
      operation: 'close',
      cause: err,
    });
  }

  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw new StorageError(`Failed to atomically rename '${tempPath}' to '${targetPath}'`, {
      filePath: targetPath,
      operation: 'rename',
      cause: err,
    });
  }
}

/**
 * Atomically writes a serializable JavaScript object as JSON to the target file.
 */
export async function atomicWriteJson<T>(
  targetPath: string,
  data: T,
  options?: AtomicWriteOptions
): Promise<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(data, null, options?.indent ?? 2);
  } catch (err) {
    throw new StorageError(`Failed to serialize JSON for file '${targetPath}'`, {
      filePath: targetPath,
      operation: 'serializeJson',
      cause: err,
    });
  }

  await atomicWriteFile(targetPath, serialized + '\n', options);
}

/**
 * Safely reads and parses a JSON file from disk.
 * Returns null if the file does not exist.
 * Throws StorageError if the file cannot be read or contains invalid JSON.
 */
export async function readJsonFile<T = unknown>(targetPath: string): Promise<T | null> {
  let content: string;
  try {
    content = await fs.promises.readFile(targetPath, 'utf8');
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return null;
    }
    throw new StorageError(`Failed to read file '${targetPath}'`, {
      filePath: targetPath,
      operation: 'readFile',
      cause: err,
    });
  }

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    throw new StorageError(`Failed to parse JSON in file '${targetPath}'`, {
      filePath: targetPath,
      operation: 'parseJson',
      cause: err,
    });
  }
}
