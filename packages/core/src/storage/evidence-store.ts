/**
 * System Execution Evidence Store (Phase 14 TASK-P14-03)
 *
 * Durable, atomic, filesystem-backed store for authoritative SystemExecutionEvidence
 * under `.ai-manager/evidence/<evidenceId>.json`.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Only independently verified SystemExecutionEvidence may be persisted.
 *    RawExecutorOutcome or fake verification flags are strictly forbidden.
 * 2. ATOMIC PERSISTENCE: Writes use atomicWriteJson (temporary file + fsync + atomic rename)
 *    to guarantee crash-safe, uncorrupted durability.
 * 3. PROCESS RESTARABILITY: Authoritative evidence survives process restarts and can be
 *    reliably reloaded and validated across runs.
 * 4. DETERMINISTIC IDENTITY: Evidence files are named by their deterministic evidenceId.
 * 5. PATH INTEGRITY: evidenceId is validated against path traversal before disk access.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
  assertNoForbiddenEvidenceFields,
  isSafeRelativePath,
} from '../evidence/system-execution-evidence.js';
import { atomicWriteJson, readJsonFile } from './atomic-writer.js';
import {
  SystemEvidenceSecurityViolationError,
  SystemEvidenceValidationError,
} from '../director/director-errors.js';

export interface EvidenceStoreOptions {
  readonly evidenceDir?: string;
  readonly baseDir?: string;
}

export class SystemExecutionEvidenceStore {
  readonly evidenceDir: string;

  constructor(options?: EvidenceStoreOptions) {
    if (options?.evidenceDir) {
      this.evidenceDir = path.resolve(options.evidenceDir);
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.evidenceDir = path.join(path.resolve(baseDir), '.ai-manager', 'evidence');
    }
  }

  /**
   * Sanitizes and verifies that evidenceId is a safe filename without path traversal.
   */
  sanitizeEvidenceId(evidenceId: string): string {
    if (typeof evidenceId !== 'string' || evidenceId.trim().length === 0) {
      throw new SystemEvidenceValidationError('evidenceId must be a non-empty string');
    }
    const trimmed = evidenceId.trim();
    if (!isSafeRelativePath(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
      throw new SystemEvidenceSecurityViolationError(
        `Invalid or unsafe evidenceId '${evidenceId}'. Path traversal and directory separators are prohibited.`,
        { evidenceId }
      );
    }
    return trimmed;
  }

  /**
   * Atomically saves a validated SystemExecutionEvidence record to disk.
   */
  async saveEvidence(evidence: SystemExecutionEvidence): Promise<void> {
    // 1. Guard against fake verification flags
    assertNoForbiddenEvidenceFields(evidence);

    // 2. Schema validation
    const parseResult = SystemExecutionEvidenceZodSchema.safeParse(evidence);
    if (!parseResult.success) {
      throw new SystemEvidenceValidationError(
        `Failed to persist evidence: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeId = this.sanitizeEvidenceId(evidence.evidenceId);
    const targetFile = path.join(this.evidenceDir, `${safeId}.json`);

    // 3. Atomically write to disk
    await atomicWriteJson(targetFile, evidence);
  }

  /**
   * Loads a SystemExecutionEvidence record by its evidenceId.
   * Returns null if no record exists.
   */
  async loadEvidence(evidenceId: string): Promise<SystemExecutionEvidence | null> {
    const safeId = this.sanitizeEvidenceId(evidenceId);
    const targetFile = path.join(this.evidenceDir, `${safeId}.json`);

    const data = await readJsonFile<unknown>(targetFile);
    if (!data) {
      return null;
    }

    assertNoForbiddenEvidenceFields(data);
    const parseResult = SystemExecutionEvidenceZodSchema.safeParse(data);
    if (!parseResult.success) {
      throw new SystemEvidenceValidationError(
        `Corrupted evidence file at '${targetFile}': ${parseResult.error.message}`,
        { filePath: targetFile, issues: parseResult.error.issues }
      );
    }

    return parseResult.data as SystemExecutionEvidence;
  }

  /**
   * Loads all evidence records for a given taskId, sorted chronologically by verifiedAt.
   */
  async loadEvidenceByTask(taskId: string): Promise<SystemExecutionEvidence[]> {
    if (!taskId || typeof taskId !== 'string') {
      return [];
    }
    const all = await this.listAllEvidence();
    return all.filter((e) => e.taskId === taskId);
  }

  /**
   * Loads all evidence records for a given requestId.
   */
  async loadEvidenceByRequest(requestId: string): Promise<SystemExecutionEvidence[]> {
    if (!requestId || typeof requestId !== 'string') {
      return [];
    }
    const all = await this.listAllEvidence();
    return all.filter((e) => e.requestId === requestId);
  }

  /**
   * Lists all evidence records in the store, sorted chronologically by verifiedAt.
   */
  async listAllEvidence(): Promise<SystemExecutionEvidence[]> {
    try {
      await fs.promises.mkdir(this.evidenceDir, { recursive: true });
      const entries = await fs.promises.readdir(this.evidenceDir, { withFileTypes: true });
      const results: SystemExecutionEvidence[] = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
          const evidenceId = entry.name.slice(0, -5);
          try {
            const ev = await this.loadEvidence(evidenceId);
            if (ev) {
              results.push(ev);
            }
          } catch {
            // Ignore unparseable or transient files during listing
          }
        }
      }

      return results.sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt));
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }
}
