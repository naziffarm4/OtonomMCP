/**
 * Project Specification Projection Persistence Store
 *
 * Implements atomic, schema-validated, revision-bound persistence for PROJECT_SPEC
 * projection artifacts under `.ai-manager/project-spec/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. PROJECT_SPEC.md is strictly a projection, NOT a second source of truth.
 * 2. If PROJECT_SPEC.md or .ai-manager/project-spec/ is deleted, authoritative state remains intact and reconstructible.
 * 3. Atomic writes conforming to AIDM storage standards (atomicWriteJson, atomicWriteFile).
 * 4. Immutable revision history: rev-<specRevision>.json is NEVER overwritten with different content once persisted.
 * 5. Cross-project isolation: projectId mismatch fails closed.
 * 6. Strictly protects against path traversal in projectId and revision.
 * 7. HistoryManager audit events logged without secrets.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, atomicWriteFile, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ProjectSpecProjectionZodSchema,
  computeProjectSpecSemanticFingerprint,
  type ProjectSpecProjection,
} from './project-spec-types.js';
import {
  ProjectSpecValidationError,
  ProjectSpecImmutableRevisionError,
  ProjectSpecForgedFingerprintError,
  ProjectSpecPathTraversalError,
  ProjectSpecProjectBindingMismatchError,
} from './project-spec-errors.js';

export interface ProjectSpecStoreOptions {
  specDir?: string;
  baseDir?: string;
  workspaceRoot?: string;
  historyManager?: HistoryManager;
}

export class ProjectSpecStore {
  readonly specDir: string;
  readonly recordsDir: string;
  readonly workspaceRoot?: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: ProjectSpecStoreOptions) {
    this.workspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
    if (options?.specDir) {
      this.specDir = path.resolve(options.specDir);
    } else {
      const baseDir = options?.baseDir ? path.resolve(options.baseDir) : this.workspaceRoot ?? process.cwd();
      this.specDir = path.join(baseDir, '.ai-manager', 'project-spec');
    }
    this.recordsDir = path.join(this.specDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new ProjectSpecValidationError('projectId cannot be empty.', {
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
      throw new ProjectSpecPathTraversalError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Returns path to the project spec directory for a specific project.
   */
  getProjectDir(projectId: string): string {
    const safeProjectId = this.sanitizeProjectId(projectId);
    return path.join(this.recordsDir, safeProjectId);
  }

  /**
   * Returns path to the JSON spec file.
   */
  getSpecPath(projectId: string, revision?: number): string {
    const projectDir = this.getProjectDir(projectId);
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new ProjectSpecValidationError(
          `Invalid revision '${revision}': must be a positive integer.`,
          { revision }
        );
      }
      return path.join(projectDir, `rev-${revision}.json`);
    }
    return path.join(projectDir, 'latest.json');
  }

  /**
   * Returns path to the Markdown spec file.
   */
  getMarkdownPath(projectId: string, revision?: number): string {
    const projectDir = this.getProjectDir(projectId);
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new ProjectSpecValidationError(
          `Invalid revision '${revision}': must be a positive integer.`,
          { revision }
        );
      }
      return path.join(projectDir, `PROJECT_SPEC-rev-${revision}.md`);
    }
    return path.join(projectDir, 'PROJECT_SPEC.md');
  }

  /**
   * Atomically saves a ProjectSpecProjection to disk.
   * Enforces immutability: rev-<specRevision>.json is rejected if it already exists with different content.
   */
  async saveRevision(
    projection: ProjectSpecProjection,
    options?: { workspaceRoot?: string }
  ): Promise<void> {
    const parseResult = ProjectSpecProjectionZodSchema.safeParse(projection);
    if (!parseResult.success) {
      throw new ProjectSpecValidationError(
        `Failed to persist project spec projection: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    // Validate canonical semantic fingerprint
    const canonicalFingerprint = computeProjectSpecSemanticFingerprint(projection);
    if (projection.semanticFingerprint !== canonicalFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Fingerprint mismatch for project spec revision ${projection.specRevision}: declared '${projection.semanticFingerprint}' but recomputed canonical fingerprint is '${canonicalFingerprint}'.`,
        { declaredFingerprint: projection.semanticFingerprint, canonicalFingerprint }
      );
    }

    const safeProjectId = this.sanitizeProjectId(projection.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionJsonPath = path.join(projectDir, `rev-${projection.specRevision}.json`);
    const revisionMdPath = path.join(projectDir, `PROJECT_SPEC-rev-${projection.specRevision}.md`);
    const latestJsonPath = path.join(projectDir, 'latest.json');
    const latestMdPath = path.join(projectDir, 'PROJECT_SPEC.md');

    // Immutability check
    if (fs.existsSync(revisionJsonPath)) {
      const existing = await readJsonFile<ProjectSpecProjection>(revisionJsonPath);
      if (existing) {
        const existingCanonicalFingerprint = computeProjectSpecSemanticFingerprint(existing);
        if (
          existing.semanticFingerprint !== projection.semanticFingerprint ||
          existingCanonicalFingerprint !== canonicalFingerprint
        ) {
          throw new ProjectSpecImmutableRevisionError(
            `Project spec revision ${projection.specRevision} for project '${projection.projectId}' is immutable and already exists with different content.`,
            {
              projectId: projection.projectId,
              revision: projection.specRevision,
              existingFingerprint: existing.semanticFingerprint,
              newFingerprint: projection.semanticFingerprint,
            }
          );
        }
        // Exact idempotent replay: already persisted with identical canonical content
        return;
      }
    }

    // 1. Write revision-bound JSON artifact
    await atomicWriteJson(revisionJsonPath, projection);

    // 2. Write revision-bound Markdown artifact
    await atomicWriteFile(revisionMdPath, projection.markdownContent);

    // 3. Write latest JSON pointer
    await atomicWriteJson(latestJsonPath, projection);

    // 4. Write latest Markdown artifact in project records
    await atomicWriteFile(latestMdPath, projection.markdownContent);

    // 5. If workspaceRoot is available, also write PROJECT_SPEC.md at workspace root
    const targetWorkspace = options?.workspaceRoot ?? this.workspaceRoot;
    if (targetWorkspace) {
      try {
        const rootMdPath = path.join(path.resolve(targetWorkspace), 'PROJECT_SPEC.md');
        await atomicWriteFile(rootMdPath, projection.markdownContent);
      } catch {
        // Workspace root write failure should not abort internal projection persistence
      }
    }

    // 6. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'PROJECT_SPEC_PERSISTED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: projection.projectId,
            specRevision: projection.specRevision,
            sourceBindings: projection.sourceBindings,
            semanticFingerprint: projection.semanticFingerprint,
            pendingHumanDecisions: projection.sourceBindings.pendingHumanDecisionsCount,
          },
        });
      } catch {
        // history append failure must not fail the primary projection persistence
      }
    }
  }

  /**
   * Loads a ProjectSpecProjection by project ID and optional revision number (defaults to latest).
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectSpecProjection | null> {
    const specPath = this.getSpecPath(projectId, revision);
    if (!fs.existsSync(specPath)) {
      return null;
    }

    const raw = await readJsonFile<ProjectSpecProjection>(specPath);
    if (!raw) return null;

    const parseResult = ProjectSpecProjectionZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new ProjectSpecValidationError(
        `Corrupted project spec projection at '${specPath}': ${parseResult.error.message}`,
        { issues: parseResult.error.issues, specPath }
      );
    }

    if (parseResult.data.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: file at '${specPath}' has projectId '${parseResult.data.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, actualProjectId: parseResult.data.projectId }
      );
    }

    return parseResult.data;
  }

  /**
   * Loads latest ProjectSpecProjection.
   */
  async loadLatest(projectId: string): Promise<ProjectSpecProjection | null> {
    return this.loadRevision(projectId);
  }

  /**
   * Lists all persisted spec revision numbers for a project in ascending order.
   */
  async listRevisions(projectId: string): Promise<number[]> {
    const projectDir = this.getProjectDir(projectId);
    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const files = await fs.promises.readdir(projectDir);
    const revRegex = /^rev-(\d+)\.json$/;
    const revisions: number[] = [];

    for (const file of files) {
      const match = revRegex.exec(file);
      if (match) {
        revisions.push(parseInt(match[1], 10));
      }
    }

    return revisions.sort((a, b) => a - b);
  }
}
