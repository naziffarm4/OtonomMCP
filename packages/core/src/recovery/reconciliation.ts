import * as fs from 'node:fs';
import type { FileRecord, ScannedFile } from '../l0/types.js';
import type { ClassifiedFileChange, FilesystemReconciliationDiff } from './types.js';
import { RecoveryFileChangeType } from './types.js';
import { computeFileSha256 } from '../l0/hasher.js';

export async function defaultFileIntegrityChecker(fullPath: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(fullPath, 'utf8');
    // 1. Conflict markers
    if (content.includes('<<<<<<< ') || content.includes('>>>>>>> ')) {
      return false;
    }
    // 2. Explicit corruption or syntax error marker
    if (content.includes('CORRUPTED') || content.includes('SYNTAX ERROR') || content.includes('MALFORMED')) {
      return false;
    }
    // 3. Null bytes
    if (content.includes('\0')) {
      return false;
    }
    // 4. JSON parse check
    if (fullPath.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a relative path matches the established attributable scope of an interrupted task.
 */
export function isPathAttributable(
  relativePath: string,
  attributablePatterns?: Iterable<string>
): boolean {
  if (!attributablePatterns) return false;
  const normalizedPath = relativePath.replace(/\\/g, '/');

  for (const pattern of attributablePatterns) {
    if (!pattern) continue;
    const normalizedPattern = pattern.replace(/\\/g, '/');
    if (normalizedPath === normalizedPattern) {
      return true;
    }
    // Support directory wildcard or folder scope e.g. "src/**", "src/*", "src/"
    if (normalizedPattern.endsWith('/**')) {
      const prefix = normalizedPattern.slice(0, -3);
      if (normalizedPath === prefix || normalizedPath.startsWith(prefix + '/')) {
        return true;
      }
    } else if (normalizedPattern.endsWith('/*')) {
      const prefix = normalizedPattern.slice(0, -2);
      if (normalizedPath.startsWith(prefix + '/')) {
        return true;
      }
    } else if (normalizedPattern.endsWith('/')) {
      if (normalizedPath.startsWith(normalizedPattern)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compares persisted L0 records against current filesystem state to detect
 * modifications, deletions, additions, or corruptions, categorizing file changes into
 * EXPECTED_IMPLEMENTATION_CHANGE vs UNEXPECTED_EXTERNAL_CHANGE.
 */
export async function reconcileFilesystemAndL0(
  l0Records: FileRecord[],
  scannedFiles: ScannedFile[],
  fileIntegrityChecker: (fullPath: string) => Promise<boolean> | boolean = defaultFileIntegrityChecker,
  attributablePatterns?: Iterable<string>
): Promise<FilesystemReconciliationDiff> {
  const indexedMap = new Map<string, FileRecord>();
  for (const record of l0Records) {
    indexedMap.set(record.path, record);
  }

  const scannedPaths = new Set<string>();
  const unexpectedModified: string[] = [];
  const unexpectedAdded: string[] = [];
  const unexpectedRemoved: string[] = [];
  const corruptedFiles: string[] = [];
  const expectedChanges: string[] = [];
  const unexpectedExternalChanges: string[] = [];
  const classifiedChanges: ClassifiedFileChange[] = [];
  const currentHashes: Record<string, string> = {};

  for (const scanned of scannedFiles) {
    scannedPaths.add(scanned.relativePath);
    const currentHash = await computeFileSha256(scanned.fullPath);
    currentHashes[scanned.relativePath] = currentHash;
    const existing = indexedMap.get(scanned.relativePath);

    if (!existing) {
      unexpectedAdded.push(scanned.relativePath);
      const isValid = await fileIntegrityChecker(scanned.fullPath);
      if (!isValid) {
        corruptedFiles.push(scanned.relativePath);
      }
      const isAttributable = isPathAttributable(scanned.relativePath, attributablePatterns);
      if (isAttributable) {
        expectedChanges.push(scanned.relativePath);
        classifiedChanges.push({
          path: scanned.relativePath,
          type: RecoveryFileChangeType.EXPECTED_IMPLEMENTATION_CHANGE,
          attributionSource: 'task_scope',
        });
      } else {
        unexpectedExternalChanges.push(scanned.relativePath);
        classifiedChanges.push({
          path: scanned.relativePath,
          type: RecoveryFileChangeType.UNEXPECTED_EXTERNAL_CHANGE,
        });
      }
    } else {
      if (currentHash !== existing.sha256) {
        unexpectedModified.push(scanned.relativePath);
        const isValid = await fileIntegrityChecker(scanned.fullPath);
        if (!isValid) {
          corruptedFiles.push(scanned.relativePath);
        }
        const isAttributable = isPathAttributable(scanned.relativePath, attributablePatterns);
        if (isAttributable) {
          expectedChanges.push(scanned.relativePath);
          classifiedChanges.push({
            path: scanned.relativePath,
            type: RecoveryFileChangeType.EXPECTED_IMPLEMENTATION_CHANGE,
            attributionSource: 'task_scope',
          });
        } else {
          unexpectedExternalChanges.push(scanned.relativePath);
          classifiedChanges.push({
            path: scanned.relativePath,
            type: RecoveryFileChangeType.UNEXPECTED_EXTERNAL_CHANGE,
          });
        }
      }
    }
  }

  for (const record of l0Records) {
    if (!scannedPaths.has(record.path)) {
      unexpectedRemoved.push(record.path);
    }
  }

  unexpectedModified.sort();
  unexpectedAdded.sort();
  unexpectedRemoved.sort();
  corruptedFiles.sort();
  expectedChanges.sort();
  unexpectedExternalChanges.sort();

  // Consistent when expected tracked files are neither modified nor deleted without record
  const isConsistent = unexpectedModified.length === 0 && unexpectedRemoved.length === 0;

  return {
    isConsistent,
    unexpectedModified,
    unexpectedRemoved,
    unexpectedAdded,
    corruptedFiles,
    expectedChanges,
    unexpectedExternalChanges,
    classifiedChanges,
    currentHashes,
    totalExpectedFiles: l0Records.length,
    totalActualFiles: scannedFiles.length,
  };
}

