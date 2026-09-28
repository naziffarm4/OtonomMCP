/**
 * Acceptance Criteria Persistence Store (Phase 15 TASK-P15-06)
 *
 * Implements atomic, schema-validated, revision-bound persistence for acceptance
 * criteria artifacts under `.ai-manager/project-acceptance-criteria/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Atomic writes conforming to AIDM storage standards (atomicWriteJson).
 * 2. Immutable revision history: rev-<revision>.json is NEVER overwritten with different content once persisted.
 * 3. Enforces strict cross-project isolation (projectId mismatch fails closed).
 * 4. Strictly protects against path traversal in projectId and revision.
 * 5. Logs append-only audit events via HistoryManager without secrets.
 * 6. Does NOT create second generic persistence framework.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ProjectAcceptanceCriteriaRevisionZodSchema,
  type ProjectAcceptanceCriteriaRevision,
} from './acceptance-criteria-types.js';
import {
  AcceptanceCriteriaValidationError,
  AcceptanceCriteriaProjectBindingMismatchError,
  AcceptanceCriteriaImmutableRevisionError,
} from './acceptance-criteria-errors.js';

export interface AcceptanceCriteriaStoreOptions {
  acceptanceCriteriaDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class AcceptanceCriteriaStore {
  readonly acceptanceCriteriaDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: AcceptanceCriteriaStoreOptions) {
    if (options?.acceptanceCriteriaDir) {
      this.acceptanceCriteriaDir = options.acceptanceCriteriaDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.acceptanceCriteriaDir = path.join(baseDir, '.ai-manager', 'project-acceptance-criteria');
    }
    this.recordsDir = path.join(this.acceptanceCriteriaDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new AcceptanceCriteriaValidationError('projectId cannot be empty.', {
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
      throw new AcceptanceCriteriaValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a ProjectAcceptanceCriteriaRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected unless identical.
   */
  async saveRevision(revision: ProjectAcceptanceCriteriaRevision): Promise<void> {
    const parseResult = ProjectAcceptanceCriteriaRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new AcceptanceCriteriaValidationError(
        `Failed to persist acceptance criteria revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    // Validate that all criterion IDs match safe deterministic format
    const criterionIdRegex = /^AC-[A-Za-z0-9_\-]+$/;
    for (const criterion of revision.criteria) {
      if (!criterionIdRegex.test(criterion.criterionId)) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid criterionId '${criterion.criterionId}': must follow format 'AC-<IDENTIFIER>'.`,
          { criterionId: criterion.criterionId }
        );
      }
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.acceptanceCriteriaRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability check
    if (fs.existsSync(revisionFilePath)) {
      try {
        const existing = await readJsonFile<ProjectAcceptanceCriteriaRevision>(revisionFilePath);
        if (existing && existing.fingerprint !== revision.fingerprint) {
          throw new AcceptanceCriteriaImmutableRevisionError(
            `Acceptance criteria revision ${revision.acceptanceCriteriaRevision} for project '${revision.projectId}' is immutable and already exists with a different fingerprint.`,
            {
              projectId: revision.projectId,
              revision: revision.acceptanceCriteriaRevision,
              existingFingerprint: existing.fingerprint,
              newFingerprint: revision.fingerprint,
            }
          );
        }
      } catch (err) {
        if (err instanceof AcceptanceCriteriaImmutableRevisionError) {
          throw err;
        }
        // If file cannot be read, continue with atomic write
      }
    }

    // 1. Write revision-bound file: records/<projectId>/rev-<acceptanceCriteriaRevision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'PROJECT_ACCEPTANCE_CRITERIA_DEFINED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            acceptanceCriteriaRevision: revision.acceptanceCriteriaRevision,
            sourceRequirementsRevision: revision.sourceRequirementsRevision,
            sourceArchitectureRevision: revision.sourceArchitectureRevision,
            sourceBusinessRulesRevision: revision.sourceBusinessRulesRevision,
            sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
            fingerprint: revision.fingerprint,
            criteriaCount: revision.criteria.length,
            coveredRequirementCount: revision.coverage.coveredRequirements.length,
            uncoveredRequirementCount: revision.coverage.uncoveredRequirements.length,
            coveredBusinessRuleCount: revision.coverage.coveredBusinessRules.length,
            pendingDecisionCount: revision.coverage.pendingDecisionCount,
            actor: Actor.DIRECTOR,
            timestamp: new Date().toISOString(),
          },
        });
      } catch {
        // Logging failure does not break persistence
      }
    }
  }

  /**
   * Loads a ProjectAcceptanceCriteriaRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectAcceptanceCriteriaRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid acceptance criteria revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectAcceptanceCriteriaRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // Cross-project mismatch check
    if (raw.projectId !== projectId) {
      throw new AcceptanceCriteriaProjectBindingMismatchError(
        `Cross-project mismatch: requested '${projectId}' but acceptance criteria record belongs to '${raw.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: raw.projectId }
      );
    }

    return raw;
  }

  /**
   * Gets the latest acceptance criteria revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    if (!fs.existsSync(projectDir)) {
      return 0;
    }

    const latest = await this.loadRevision(projectId);
    if (latest && typeof latest.acceptanceCriteriaRevision === 'number') {
      return latest.acceptanceCriteriaRevision;
    }

    try {
      const files = fs.readdirSync(projectDir);
      let maxRev = 0;
      for (const file of files) {
        const match = file.match(/^rev-(\d+)\.json$/);
        if (match && match[1]) {
          const revNum = parseInt(match[1], 10);
          if (revNum > maxRev) {
            maxRev = revNum;
          }
        }
      }
      return maxRev;
    } catch {
      return 0;
    }
  }
}
