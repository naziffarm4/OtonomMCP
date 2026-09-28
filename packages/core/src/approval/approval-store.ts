/**
 * Project Approval Package Persistence Store (Phase 8 TASK-P8-05 & Phase 15 Product Owner Approval)
 *
 * Implements atomic, schema-validated persistence for project approval packages
 * and revision histories under `.ai-manager/approval/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly conforms to AIDM storage conventions (atomic writes, JSON).
 * 2. Preserves immutable revision histories under packages/<packageId>/rev-<revision>.json.
 * 3. Does NOT mutate SpecStore (requirements.json, decisions.json) or Task DAG.
 * 4. Logs append-only audit events via HistoryManager when available.
 * 5. Strictly protects against path traversal in packageId, projectId, and revision.
 * 6. Enforces cross-project isolation (cross-project contamination fails closed).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ApprovalPackageZodSchema,
  type ApprovalPackage,
  type ProjectApprovalPackage,
} from './approval-types.js';
import {
  ApprovalValidationError,
  ApprovalPackageNotFoundError,
  ApprovalPathTraversalError,
  ApprovalImmutableRevisionError,
  ApprovalProjectBindingMismatchError,
} from './approval-errors.js';

export interface ApprovalStoreOptions {
  approvalDir?: string;
  baseDir?: string;
  workspaceRoot?: string;
  historyManager?: HistoryManager;
}

export class ApprovalStore {
  readonly approvalDir: string;
  readonly packagesDir: string;
  readonly projectsDir: string;
  readonly activePackagePath: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: ApprovalStoreOptions) {
    if (options?.approvalDir) {
      this.approvalDir = options.approvalDir;
    } else {
      const baseDir = options?.baseDir ?? options?.workspaceRoot ?? process.cwd();
      this.approvalDir = path.join(baseDir, '.ai-manager', 'approval');
    }
    this.packagesDir = path.join(this.approvalDir, 'packages');
    this.projectsDir = path.join(this.approvalDir, 'projects');
    this.activePackagePath = path.join(this.approvalDir, 'active-package.json');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that packageId contains no path traversal sequences.
   */
  sanitizePackageId(packageId: string): string {
    if (!packageId || typeof packageId !== 'string') {
      throw new ApprovalValidationError('packageId cannot be empty.', 'MISSING_PACKAGE_ID');
    }
    const safeRegex = /^[a-zA-Z0-9_\-\.]+$/;
    if (!safeRegex.test(packageId) || packageId.includes('..') || packageId.includes('/') || packageId.includes('\\')) {
      throw new ApprovalPathTraversalError(
        `Invalid packageId '${packageId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PACKAGE_ID' }
      );
    }
    return packageId;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new ApprovalValidationError('projectId cannot be empty.', 'MISSING_PACKAGE_ID');
    }
    const trimmed = projectId.trim();
    const safeRegex = /^[a-zA-Z0-9_\-\.@\/]+$/;
    if (
      !safeRegex.test(trimmed) ||
      trimmed.includes('..') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\')
    ) {
      throw new ApprovalPathTraversalError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves an ApprovalPackage to disk.
   * Persists both latest revision pointer and immutable revision snapshot.
   */
  async savePackage(pkg: ApprovalPackage): Promise<void> {
    const parseResult = ApprovalPackageZodSchema.safeParse(pkg);
    if (!parseResult.success) {
      throw new ApprovalValidationError(
        `Failed to persist approval package: schema validation error: ${parseResult.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { issues: parseResult.error.issues }
      );
    }

    const safeId = this.sanitizePackageId(pkg.packageId);
    const safeProjectId = this.sanitizeProjectId(pkg.projectId);

    // 1. Revision immutability enforcement for P15 revision-bound packages
    const revisionDir = path.join(this.packagesDir, safeId);
    const revisionFilePath = path.join(revisionDir, `rev-${pkg.revision}.json`);

    if (pkg.sourceBindings) {
      try {
        const existing = await readJsonFile<ApprovalPackage>(revisionFilePath);
        if (existing) {
          const existingFp = existing.packageFingerprint ?? existing.approvalRecord?.packageHash ?? existing.rejectionRecord?.packageHash;
          const newFp = pkg.packageFingerprint ?? pkg.approvalRecord?.packageHash ?? pkg.rejectionRecord?.packageHash;
          if (existingFp && newFp && existingFp !== newFp) {
            throw new ApprovalImmutableRevisionError(
              `Cannot overwrite immutable revision rev-${pkg.revision}.json with conflicting fingerprint for package '${pkg.packageId}'.`,
              { packageId: pkg.packageId, revision: pkg.revision }
            );
          }
          if (existing.status !== pkg.status && existing.status === 'APPROVED') {
            throw new ApprovalImmutableRevisionError(
              `Cannot mutate already approved revision rev-${pkg.revision}.json for package '${pkg.packageId}'.`,
              { packageId: pkg.packageId, revision: pkg.revision }
            );
          }
        }
      } catch (err) {
        if (err instanceof ApprovalImmutableRevisionError) {
          throw err;
        }
        // If file doesn't exist, proceed
      }
    }

    // 2. Write latest package file: packages/<packageId>.json
    const latestFilePath = path.join(this.packagesDir, `${safeId}.json`);
    await atomicWriteJson(latestFilePath, pkg);

    // 3. Write immutable revision file: packages/<packageId>/rev-<revision>.json
    await atomicWriteJson(revisionFilePath, pkg);

    // 4. Write project-isolated files: projects/<projectId>/...
    const projectDir = path.join(this.projectsDir, safeProjectId);
    const projectLatestFilePath = path.join(projectDir, 'latest.json');
    const projectRevisionFilePath = path.join(projectDir, `rev-${pkg.revision}.json`);
    await atomicWriteJson(projectLatestFilePath, pkg);
    await atomicWriteJson(projectRevisionFilePath, pkg);

    // 5. Update active-package pointer
    await atomicWriteJson(this.activePackagePath, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      projectId: pkg.projectId,
      status: pkg.status,
      updatedAt: pkg.updatedAt,
    });

    // 6. Optionally log audit events to History stream
    if (this.historyManager) {
      try {
        let eventType = 'APPROVAL_PACKAGE_CREATED';
        let actor: Actor = Actor.ORCHESTRATOR;

        if (pkg.status === 'APPROVED') {
          eventType = 'APPROVAL_EXPLICITLY_GRANTED';
          actor = Actor.USER;
        } else if (pkg.status === 'REJECTED') {
          eventType = 'APPROVAL_EXPLICITLY_REJECTED';
          actor = Actor.USER;
        } else if (pkg.status === 'STALE') {
          eventType = 'APPROVAL_PACKAGE_STALE';
          actor = Actor.ORCHESTRATOR;
        } else if (pkg.revision > 1) {
          eventType = 'APPROVAL_PACKAGE_REVISED';
          actor = Actor.DIRECTOR;
        }

        await this.historyManager.appendEvent({
          eventType,
          actor,
          payload: {
            packageId: pkg.packageId,
            revision: pkg.revision,
            projectId: pkg.projectId,
            status: pkg.status,
            intent: pkg.approvalRecord?.intent ?? pkg.rejectionRecord?.intent ?? null,
            actorRole: pkg.approvalRecord?.actorRole ?? pkg.rejectionRecord?.actorRole ?? null,
            packageHash: pkg.approvalRecord?.packageHash ?? pkg.rejectionRecord?.packageHash ?? pkg.packageFingerprint ?? null,
          },
        });

        // Also emit legacy compatibility events
        if (pkg.status === 'APPROVED') {
          await this.historyManager.appendEvent({
            eventType: 'PROJECT_UNDERSTANDING_APPROVED',
            actor: Actor.USER,
            payload: {
              packageId: pkg.packageId,
              revision: pkg.revision,
              projectId: pkg.projectId,
              status: pkg.status,
            },
          });
        } else if (pkg.status === 'REJECTED') {
          await this.historyManager.appendEvent({
            eventType: 'PROJECT_UNDERSTANDING_REJECTED',
            actor: Actor.USER,
            payload: {
              packageId: pkg.packageId,
              revision: pkg.revision,
              projectId: pkg.projectId,
              status: pkg.status,
            },
          });
        } else if (pkg.revision > 1) {
          await this.historyManager.appendEvent({
            eventType: 'PROJECT_UNDERSTANDING_REVISED',
            actor: Actor.DIRECTOR,
            payload: {
              packageId: pkg.packageId,
              revision: pkg.revision,
              projectId: pkg.projectId,
              status: pkg.status,
            },
          });
        } else {
          await this.historyManager.appendEvent({
            eventType: 'PROJECT_UNDERSTANDING_CREATED',
            actor: Actor.DIRECTOR,
            payload: {
              packageId: pkg.packageId,
              revision: pkg.revision,
              projectId: pkg.projectId,
              status: pkg.status,
            },
          });
        }
      } catch {
        // Logging failure should not break persistence
      }
    }
  }

  /**
   * Loads an ApprovalPackage from disk by packageId and optional revision.
   * If revision is omitted, loads the latest package state.
   * Enforces cross-project isolation if expectedProjectId is provided.
   */
  async loadPackage(
    packageId: string,
    revision?: number,
    expectedProjectId?: string
  ): Promise<ApprovalPackage | null> {
    const safeId = this.sanitizePackageId(packageId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new ApprovalValidationError(
          `Invalid revision '${revision}': must be a positive integer.`,
          'INVALID_REVISION'
        );
      }
      targetPath = path.join(this.packagesDir, safeId, `rev-${revision}.json`);
    } else {
      targetPath = path.join(this.packagesDir, `${safeId}.json`);
    }

    let raw = await readJsonFile<ApprovalPackage>(targetPath);

    // Fallback: check if packageId is actually a projectId in projectsDir
    if (!raw) {
      const safeProject = this.sanitizeProjectId(packageId);
      const projectPath = revision !== undefined
        ? path.join(this.projectsDir, safeProject, `rev-${revision}.json`)
        : path.join(this.projectsDir, safeProject, 'latest.json');
      raw = await readJsonFile<ApprovalPackage>(projectPath);
    }

    if (!raw) {
      return null;
    }

    // Cross-project isolation check
    if (expectedProjectId && raw.projectId !== expectedProjectId) {
      throw new ApprovalProjectBindingMismatchError(
        `Cross-project approval package access rejected: requested project '${expectedProjectId}' but package '${raw.packageId}' belongs to '${raw.projectId}'.`,
        { requestedProjectId: expectedProjectId, packageProjectId: raw.projectId, packageId: raw.packageId }
      );
    }

    const parseResult = ApprovalPackageZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new ApprovalValidationError(
        `Corrupt or invalid approval package file at '${targetPath}': ${parseResult.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { filePath: targetPath, issues: parseResult.error.issues }
      );
    }

    return parseResult.data as ApprovalPackage;
  }

  /**
   * Loads the latest approval package for a specific projectId.
   */
  async getLatestPackage(projectId: string): Promise<ApprovalPackage | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const targetPath = path.join(this.projectsDir, safeProjectId, 'latest.json');

    const raw = await readJsonFile<ApprovalPackage>(targetPath);
    if (raw) {
      if (raw.projectId !== projectId) {
        throw new ApprovalProjectBindingMismatchError(
          `Cross-project approval package access rejected: requested project '${projectId}' but record has '${raw.projectId}'.`,
          { requestedProjectId: projectId, recordProjectId: raw.projectId }
        );
      }
      return raw;
    }

    // Fallback: check active package
    const active = await this.getActivePackage(projectId);
    if (active && active.projectId === projectId) {
      return active;
    }

    return null;
  }

  /**
   * Loads the currently active project approval package, if any.
   */
  async getActivePackage(expectedProjectId?: string): Promise<ApprovalPackage | null> {
    const pointer = await readJsonFile<{ packageId?: string; revision?: number; projectId?: string }>(
      this.activePackagePath
    );
    if (!pointer?.packageId) {
      return null;
    }

    if (expectedProjectId && pointer.projectId && pointer.projectId !== expectedProjectId) {
      return null;
    }

    return this.loadPackage(pointer.packageId, pointer.revision, expectedProjectId);
  }

  /**
   * Lists all stored package IDs.
   */
  async listPackages(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.packagesDir);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.basename(file, '.json'));
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Lists all available revisions for a given packageId.
   */
  async listRevisions(packageId: string): Promise<number[]> {
    const safeId = this.sanitizePackageId(packageId);
    const revisionDir = path.join(this.packagesDir, safeId);

    try {
      const files = await fs.promises.readdir(revisionDir);
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
