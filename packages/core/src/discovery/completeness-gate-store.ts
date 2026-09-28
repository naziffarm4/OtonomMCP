/**
 * Specification Completeness Gate Persistence Store (Phase 15 TASK-P15-02)
 *
 * Implements atomic, schema-validated, revision-bound persistence for completeness
 * gate evaluation records under `.ai-manager/completeness-gate/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Atomic writes via atomicWriteJson conforming to AIDM storage standards.
 * 2. Revision-bound: records are keyed by (projectId, discoveryRevision).
 * 3. Enforces strict cross-project isolation (projectId mismatch fails closed).
 * 4. Strictly protects against path traversal in projectId and revision.
 * 5. Logs append-only audit events via HistoryManager without secrets.
 * 6. Does NOT create second approval store or second requirement store.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  CompletenessGateResultZodSchema,
  type CompletenessGateResult,
} from './completeness-gate-types.js';
import {
  CompletenessValidationError,
  CompletenessProjectBindingMismatchError,
} from './completeness-gate-errors.js';

export interface CompletenessGateStoreOptions {
  completenessDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class CompletenessGateStore {
  readonly completenessDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: CompletenessGateStoreOptions) {
    if (options?.completenessDir) {
      this.completenessDir = options.completenessDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.completenessDir = path.join(baseDir, '.ai-manager', 'completeness-gate');
    }
    this.recordsDir = path.join(this.completenessDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new CompletenessValidationError('projectId cannot be empty.', {
        code: 'MISSING_PROJECT_ID',
      });
    }
    const trimmed = projectId.trim();
    const safeRegex = /^[a-zA-Z0-9_\-\.@\/]+$/;
    if (
      !safeRegex.test(trimmed) ||
      trimmed.includes('..') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\')
    ) {
      throw new CompletenessValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a CompletenessGateResult to disk.
   */
  async saveResult(result: CompletenessGateResult): Promise<void> {
    const parseResult = CompletenessGateResultZodSchema.safeParse(result);
    if (!parseResult.success) {
      throw new CompletenessValidationError(
        `Failed to persist completeness result: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeProjectId = this.sanitizeProjectId(result.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${result.discoveryRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // 1. Write revision-bound file: records/<projectId>/rev-<discoveryRevision>.json
    await atomicWriteJson(revisionFilePath, result);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, result);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'SPECIFICATION_COMPLETENESS_EVALUATED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: result.projectId,
            discoveryRevision: result.discoveryRevision,
            discoveryFingerprint: result.discoveryFingerprint,
            status: result.status,
            isEligibleForApproval: result.isEligibleForApproval,
            isStale: result.isStale,
            fingerprint: result.fingerprint,
            evaluatedAreasCount: result.evaluatedAreas.length,
            blockingIssuesCount: result.blockingIssues.length,
            missingInformationCount: result.missingInformation.length,
            humanDecisionsCount: result.humanDecisions.length,
          },
        });
      } catch {
        // Logging failure does not break persistence
      }
    }
  }

  /**
   * Loads a CompletenessGateResult from disk by projectId and optional discovery revision.
   * If revision is omitted, loads latest result.
   */
  async loadResult(
    projectId: string,
    revision?: number
  ): Promise<CompletenessGateResult | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new CompletenessValidationError(
          `Invalid discovery revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<CompletenessGateResult>(targetPath);
    if (!raw) {
      return null;
    }

    // Enforce cross-project binding (payload must match requested projectId)
    if (raw.projectId !== projectId) {
      throw new CompletenessProjectBindingMismatchError(
        `Cross-project completeness access rejected: requested project '${projectId}' but record has '${raw.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: raw.projectId }
      );
    }

    const parseResult = CompletenessGateResultZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new CompletenessValidationError(
        `Corrupt completeness result at '${targetPath}': ${parseResult.error.message}`,
        { filePath: targetPath, issues: parseResult.error.issues }
      );
    }

    return parseResult.data as CompletenessGateResult;
  }

  /**
   * Lists all evaluated revision numbers for a given projectId in ascending order.
   */
  async listEvaluatedRevisions(projectId: string): Promise<number[]> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    try {
      const files = await fs.promises.readdir(projectDir);
      const revisions: number[] = [];
      for (const file of files) {
        const match = file.match(/^rev-(\d+)\.json$/);
        if (match && match[1]) {
          revisions.push(parseInt(match[1], 10));
        }
      }
      return revisions.sort((a, b) => a - b);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }
}
