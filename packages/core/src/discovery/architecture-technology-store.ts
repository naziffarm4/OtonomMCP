/**
 * Architecture & Technology Persistence Store (Phase 15 TASK-P15-04)
 *
 * Implements atomic, schema-validated, revision-bound persistence for architecture
 * and technology definition artifacts under `.ai-manager/project-architecture/`.
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
  ProjectArchitectureRevisionZodSchema,
  type ProjectArchitectureRevision,
} from './architecture-technology-types.js';
import {
  ArchitectureValidationError,
  ArchitectureProjectBindingMismatchError,
  ArchitectureImmutableRevisionError,
} from './architecture-technology-errors.js';

export interface ArchitectureTechnologyStoreOptions {
  architectureDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class ArchitectureTechnologyStore {
  readonly architectureDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: ArchitectureTechnologyStoreOptions) {
    if (options?.architectureDir) {
      this.architectureDir = options.architectureDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.architectureDir = path.join(baseDir, '.ai-manager', 'project-architecture');
    }
    this.recordsDir = path.join(this.architectureDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new ArchitectureValidationError('projectId cannot be empty.', {
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
      throw new ArchitectureValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a ProjectArchitectureRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected unless identical.
   */
  async saveRevision(revision: ProjectArchitectureRevision): Promise<void> {
    const parseResult = ProjectArchitectureRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new ArchitectureValidationError(
        `Failed to persist architecture/technology revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.architectureRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability check
    if (fs.existsSync(revisionFilePath)) {
      try {
        const existing = await readJsonFile<ProjectArchitectureRevision>(revisionFilePath);
        if (existing && existing.fingerprint !== revision.fingerprint) {
          throw new ArchitectureImmutableRevisionError(
            `Architecture revision ${revision.architectureRevision} for project '${revision.projectId}' is immutable and already exists with a different fingerprint.`,
            {
              projectId: revision.projectId,
              revision: revision.architectureRevision,
              existingFingerprint: existing.fingerprint,
              newFingerprint: revision.fingerprint,
            }
          );
        }
      } catch (err) {
        if (err instanceof ArchitectureImmutableRevisionError) {
          throw err;
        }
        // If file cannot be read, continue with atomic write
      }
    }

    // 1. Write revision-bound file: records/<projectId>/rev-<architectureRevision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        const selectedTechCount = revision.technologyStack.filter(
          (t) => t.selectionStatus === 'SELECTED' || t.selectionStatus === 'REQUIRED'
        ).length;
        const pendingDecisionsCount =
          revision.pendingHumanDecisions.length +
          revision.decisions.filter((d) => d.status === 'PENDING_DECISION').length;

        await this.historyManager.appendEvent({
          eventType: 'PROJECT_ARCHITECTURE_TECHNOLOGY_DEFINED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            architectureRevision: revision.architectureRevision,
            sourceRequirementsRevision: revision.sourceRequirementsRevision,
            sourceRequirementsFingerprint: revision.sourceRequirementsFingerprint,
            sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
            sourceDiscoveryFingerprint: revision.sourceDiscoveryFingerprint,
            fingerprint: revision.fingerprint,
            isStale: revision.isStale,
            componentsCount: revision.systemComponents.length,
            decisionsCount: revision.decisions.length,
            selectedTechnologyCount: selectedTechCount,
            pendingDecisionsCount: pendingDecisionsCount,
            integrationsCount: revision.integrations.length,
            traceabilityLinksCount: revision.requirementsTraceability.length,
          },
        });
      } catch {
        // Logging failure does not break persistence
      }
    }
  }

  /**
   * Loads a ProjectArchitectureRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectArchitectureRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new ArchitectureValidationError(
          `Invalid architecture revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectArchitectureRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // Cross-project mismatch check
    if (raw.projectId !== projectId) {
      throw new ArchitectureProjectBindingMismatchError(
        `Cross-project mismatch: requested '${projectId}' but architecture record belongs to '${raw.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: raw.projectId }
      );
    }

    return raw;
  }

  /**
   * Gets the latest architecture revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    if (!fs.existsSync(projectDir)) {
      return 0;
    }

    const latest = await this.loadRevision(projectId);
    if (latest && typeof latest.architectureRevision === 'number') {
      return latest.architectureRevision;
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
