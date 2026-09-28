/**
 * Business Rules Persistence Store (Phase 15 TASK-P15-05)
 *
 * Implements atomic, schema-validated, revision-bound persistence for business
 * rules artifacts under `.ai-manager/project-business-rules/`.
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
  ProjectBusinessRulesRevisionZodSchema,
  type ProjectBusinessRulesRevision,
} from './business-rules-types.js';
import {
  BusinessRulesValidationError,
  BusinessRulesProjectBindingMismatchError,
  BusinessRulesImmutableRevisionError,
} from './business-rules-errors.js';

export interface BusinessRulesStoreOptions {
  businessRulesDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class BusinessRulesStore {
  readonly businessRulesDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: BusinessRulesStoreOptions) {
    if (options?.businessRulesDir) {
      this.businessRulesDir = options.businessRulesDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.businessRulesDir = path.join(baseDir, '.ai-manager', 'project-business-rules');
    }
    this.recordsDir = path.join(this.businessRulesDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new BusinessRulesValidationError('projectId cannot be empty.', {
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
      throw new BusinessRulesValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a ProjectBusinessRulesRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected unless identical.
   */
  async saveRevision(revision: ProjectBusinessRulesRevision): Promise<void> {
    const parseResult = ProjectBusinessRulesRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new BusinessRulesValidationError(
        `Failed to persist business rules revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    // Validate that all rule IDs match safe deterministic format
    const ruleIdRegex = /^BR-[A-Za-z0-9_\-]+$/;
    for (const rule of revision.rules) {
      if (!ruleIdRegex.test(rule.ruleId)) {
        throw new BusinessRulesValidationError(
          `Invalid ruleId '${rule.ruleId}': must follow format 'BR-<IDENTIFIER>'.`,
          { ruleId: rule.ruleId }
        );
      }
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.businessRulesRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability check
    if (fs.existsSync(revisionFilePath)) {
      try {
        const existing = await readJsonFile<ProjectBusinessRulesRevision>(revisionFilePath);
        if (existing && existing.fingerprint !== revision.fingerprint) {
          throw new BusinessRulesImmutableRevisionError(
            `Business rules revision ${revision.businessRulesRevision} for project '${revision.projectId}' is immutable and already exists with a different fingerprint.`,
            {
              projectId: revision.projectId,
              revision: revision.businessRulesRevision,
              existingFingerprint: existing.fingerprint,
              newFingerprint: revision.fingerprint,
            }
          );
        }
      } catch (err) {
        if (err instanceof BusinessRulesImmutableRevisionError) {
          throw err;
        }
        // If file cannot be read, continue with atomic write
      }
    }

    // 1. Write revision-bound file: records/<projectId>/rev-<businessRulesRevision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        const confirmedCount = revision.rules.filter((r) => r.status === 'CONFIRMED').length;
        const proposedCount = revision.rules.filter((r) => r.status === 'PROPOSED').length;
        const pendingDecisionCount =
          revision.pendingHumanDecisions.length +
          revision.rules.filter((r) => r.status === 'PENDING_DECISION').length;

        await this.historyManager.appendEvent({
          eventType: 'PROJECT_BUSINESS_RULES_DEFINED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            businessRulesRevision: revision.businessRulesRevision,
            sourceRequirementsRevision: revision.sourceRequirementsRevision,
            sourceArchitectureRevision: revision.sourceArchitectureRevision,
            sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
            fingerprint: revision.fingerprint,
            ruleCount: revision.rules.length,
            confirmedCount,
            proposedCount,
            pendingDecisionCount,
            conflictCount: revision.conflicts.length,
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
   * Loads a ProjectBusinessRulesRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectBusinessRulesRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new BusinessRulesValidationError(
          `Invalid business rules revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectBusinessRulesRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // Cross-project mismatch check
    if (raw.projectId !== projectId) {
      throw new BusinessRulesProjectBindingMismatchError(
        `Cross-project mismatch: requested '${projectId}' but business rules record belongs to '${raw.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: raw.projectId }
      );
    }

    return raw;
  }

  /**
   * Gets the latest business rules revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    if (!fs.existsSync(projectDir)) {
      return 0;
    }

    const latest = await this.loadRevision(projectId);
    if (latest && typeof latest.businessRulesRevision === 'number') {
      return latest.businessRulesRevision;
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
