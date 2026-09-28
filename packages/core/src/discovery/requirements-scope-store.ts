/**
 * Requirements & Scope Persistence Store (Phase 15 TASK-P15-03)
 *
 * Implements atomic, schema-validated, revision-bound persistence for requirements
 * and scope artifacts under `.ai-manager/project-requirements/`.
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
  ProjectRequirementsScopeRevisionZodSchema,
  type ProjectRequirementsScopeRevision,
} from './requirements-scope-types.js';
import {
  RequirementsScopeValidationError,
  RequirementsScopeProjectBindingMismatchError,
  RequirementsScopeImmutableRevisionError,
} from './requirements-scope-errors.js';

export interface RequirementsScopeStoreOptions {
  requirementsDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class RequirementsScopeStore {
  readonly requirementsDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: RequirementsScopeStoreOptions) {
    if (options?.requirementsDir) {
      this.requirementsDir = options.requirementsDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.requirementsDir = path.join(baseDir, '.ai-manager', 'project-requirements');
    }
    this.recordsDir = path.join(this.requirementsDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new RequirementsScopeValidationError('projectId cannot be empty.', {
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
      throw new RequirementsScopeValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a ProjectRequirementsScopeRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected unless identical.
   */
  async saveRevision(revision: ProjectRequirementsScopeRevision): Promise<void> {
    const parseResult = ProjectRequirementsScopeRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new RequirementsScopeValidationError(
        `Failed to persist requirements/scope revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.requirementsRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability check
    if (fs.existsSync(revisionFilePath)) {
      try {
        const existing = await readJsonFile<ProjectRequirementsScopeRevision>(revisionFilePath);
        if (existing && existing.fingerprint !== revision.fingerprint) {
          throw new RequirementsScopeImmutableRevisionError(
            `Requirements revision ${revision.requirementsRevision} for project '${revision.projectId}' is immutable and already exists with a different fingerprint.`,
            {
              projectId: revision.projectId,
              revision: revision.requirementsRevision,
              existingFingerprint: existing.fingerprint,
              newFingerprint: revision.fingerprint,
            }
          );
        }
      } catch (err) {
        if (err instanceof RequirementsScopeImmutableRevisionError) {
          throw err;
        }
        // If file cannot be read, continue with atomic write
      }
    }

    // 1. Write revision-bound file: records/<projectId>/rev-<requirementsRevision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'PROJECT_REQUIREMENTS_SCOPE_DEFINED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            requirementsRevision: revision.requirementsRevision,
            sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
            sourceDiscoveryFingerprint: revision.sourceDiscoveryFingerprint,
            fingerprint: revision.fingerprint,
            isStale: revision.isStale,
            functionalRequirementsCount: revision.functionalRequirements.length,
            inScopeCapabilitiesCount: revision.inScope.capabilities.length,
            outOfScopeCapabilitiesCount: revision.outOfScope.capabilities.length,
            undecidedScopeCount: revision.undecidedScope.length,
            humanDecisionsCount: revision.humanDecisions.length,
            openQuestionsCount: revision.openQuestions.length,
          },
        });
      } catch {
        // Logging failure does not break persistence
      }
    }
  }

  /**
   * Loads a ProjectRequirementsScopeRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectRequirementsScopeRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new RequirementsScopeValidationError(
          `Invalid requirements revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectRequirementsScopeRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // Cross-project mismatch check
    if (raw.projectId !== projectId) {
      throw new RequirementsScopeProjectBindingMismatchError(
        `Cross-project mismatch: requested '${projectId}' but requirements record belongs to '${raw.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: raw.projectId }
      );
    }

    return raw;
  }

  /**
   * Gets the latest requirements revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    if (!fs.existsSync(projectDir)) {
      return 0;
    }

    const latest = await this.loadRevision(projectId);
    if (latest && typeof latest.requirementsRevision === 'number') {
      return latest.requirementsRevision;
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
