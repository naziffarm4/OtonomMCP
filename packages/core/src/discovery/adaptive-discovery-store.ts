/**
 * Adaptive Project Discovery Persistence Store (Phase 15 TASK-P15-01)
 *
 * Implements atomic, schema-validated persistence for adaptive project discovery
 * revisions under `.ai-manager/project-discovery/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Conforms to AIDM storage conventions (atomic writes, JSON).
 * 2. Immutable revision history: rev-<revision>.json is NEVER overwritten once persisted.
 * 3. Does NOT create second project state, requirement store, decision store, or approval system.
 * 4. Strictly protects against path traversal in projectId and revision.
 * 5. Prevents cross-project discovery contamination.
 * 6. Logs append-only audit events via HistoryManager.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ProjectDiscoveryRevisionZodSchema,
  type ProjectDiscoveryRevision,
} from './adaptive-discovery-types.js';
import {
  DiscoveryValidationError,
  DiscoveryImmutableRevisionError,
  DiscoveryProjectBindingMismatchError,
} from './adaptive-discovery-errors.js';

export interface AdaptiveDiscoveryStoreOptions {
  discoveryDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class AdaptiveDiscoveryStore {
  readonly discoveryDir: string;
  readonly recordsDir: string;
  readonly activeDiscoveryPath: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: AdaptiveDiscoveryStoreOptions) {
    if (options?.discoveryDir) {
      this.discoveryDir = options.discoveryDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.discoveryDir = path.join(baseDir, '.ai-manager', 'project-discovery');
    }
    this.recordsDir = path.join(this.discoveryDir, 'records');
    this.activeDiscoveryPath = path.join(this.discoveryDir, 'active-discovery.json');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new DiscoveryValidationError('projectId cannot be empty.', {
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
      throw new DiscoveryValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    // Encode slash for directory safety
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a ProjectDiscoveryRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected.
   */
  async saveRevision(revision: ProjectDiscoveryRevision): Promise<void> {
    const parseResult = ProjectDiscoveryRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new DiscoveryValidationError(
        `Failed to persist discovery revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.discoveryRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability invariant check
    if (fs.existsSync(revisionFilePath)) {
      throw new DiscoveryImmutableRevisionError(
        `Discovery revision ${revision.discoveryRevision} already exists for project '${revision.projectId}'. Revisions are strictly immutable.`,
        {
          projectId: revision.projectId,
          revision: revision.discoveryRevision,
          path: revisionFilePath,
        }
      );
    }

    // 1. Write immutable revision file: records/<projectId>/rev-<revision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Update global active-discovery pointer
    await atomicWriteJson(this.activeDiscoveryPath, {
      projectId: revision.projectId,
      discoveryRevision: revision.discoveryRevision,
      fingerprint: revision.fingerprint,
      updatedAt: revision.createdAt,
    });

    // 4. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        const eventType =
          revision.discoveryRevision === 1
            ? 'PROJECT_DISCOVERY_CREATED'
            : 'PROJECT_DISCOVERY_REVISED';
        await this.historyManager.appendEvent({
          eventType,
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            discoveryRevision: revision.discoveryRevision,
            previousRevision: revision.previousRevision,
            changedSections: revision.changedSections,
            fingerprint: revision.fingerprint,
            isComplete: revision.completeness.isComplete,
            blockingQuestionsCount: revision.completeness.blockingQuestionsCount,
          },
        });
      } catch {
        // Logging failure does not break persistence
      }
    }
  }

  /**
   * Loads a ProjectDiscoveryRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectDiscoveryRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new DiscoveryValidationError(
          `Invalid discovery revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectDiscoveryRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // Validate cross-project binding (payload must match requested projectId)
    if (raw.projectId !== projectId) {
      throw new DiscoveryProjectBindingMismatchError(
        `Cross-project discovery access rejected: requested project '${projectId}' but record has '${raw.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: raw.projectId }
      );
    }

    const parseResult = ProjectDiscoveryRevisionZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new DiscoveryValidationError(
        `Corrupt discovery revision at '${targetPath}': ${parseResult.error.message}`,
        { filePath: targetPath, issues: parseResult.error.issues }
      );
    }

    return parseResult.data as unknown as ProjectDiscoveryRevision;
  }

  /**
   * Returns the latest revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const latest = await this.loadRevision(projectId);
    return latest?.discoveryRevision ?? 0;
  }

  /**
   * Lists all available revisions for a given projectId in ascending order.
   */
  async listRevisions(projectId: string): Promise<number[]> {
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

  /**
   * Loads the currently active discovery revision, if any.
   */
  async getActiveDiscovery(): Promise<ProjectDiscoveryRevision | null> {
    const pointer = await readJsonFile<{ projectId?: string; discoveryRevision?: number }>(
      this.activeDiscoveryPath
    );
    if (!pointer?.projectId) {
      return null;
    }
    return this.loadRevision(pointer.projectId, pointer.discoveryRevision);
  }
}
