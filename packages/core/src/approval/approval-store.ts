/**
 * Project Approval Package Persistence Store (Phase 8 TASK-P8-05)
 *
 * Implements atomic, schema-validated persistence for project approval packages
 * and revision histories under `.ai-manager/approval/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly conforms to AIDM storage conventions (atomic writes, JSON).
 * 2. Preserves immutable revision histories under packages/<packageId>/rev-<revision>.json.
 * 3. Does NOT mutate SpecStore (requirements.json, decisions.json) or Task DAG.
 * 4. Logs append-only audit events via HistoryManager when available.
 * 5. Strictly protects against path traversal in packageId and revision.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ProjectApprovalPackageZodSchema,
  type ProjectApprovalPackage,
} from './approval-types.js';
import { ApprovalValidationError, ApprovalPackageNotFoundError } from './approval-errors.js';

export interface ApprovalStoreOptions {
  approvalDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class ApprovalStore {
  readonly approvalDir: string;
  readonly packagesDir: string;
  readonly activePackagePath: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: ApprovalStoreOptions) {
    if (options?.approvalDir) {
      this.approvalDir = options.approvalDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.approvalDir = path.join(baseDir, '.ai-manager', 'approval');
    }
    this.packagesDir = path.join(this.approvalDir, 'packages');
    this.activePackagePath = path.join(this.approvalDir, 'active-package.json');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that packageId contains no path traversal sequences.
   */
  private sanitizePackageId(packageId: string): string {
    if (!packageId || typeof packageId !== 'string') {
      throw new ApprovalValidationError('packageId cannot be empty.', 'MISSING_PACKAGE_ID');
    }
    const safeRegex = /^[a-zA-Z0-9_\-\.]+$/;
    if (!safeRegex.test(packageId) || packageId.includes('..') || packageId.includes('/') || packageId.includes('\\')) {
      throw new ApprovalValidationError(
        `Invalid packageId '${packageId}': contains illegal characters or path traversal.`,
        'SCHEMA_VALIDATION_FAILED'
      );
    }
    return packageId;
  }

  /**
   * Atomically saves a ProjectApprovalPackage to disk.
   * Persists both latest revision pointer and immutable revision snapshot.
   */
  async savePackage(pkg: ProjectApprovalPackage): Promise<void> {
    const parseResult = ProjectApprovalPackageZodSchema.safeParse(pkg);
    if (!parseResult.success) {
      throw new ApprovalValidationError(
        `Failed to persist approval package: schema validation error: ${parseResult.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { issues: parseResult.error.issues }
      );
    }

    const safeId = this.sanitizePackageId(pkg.packageId);

    // 1. Write latest package file: packages/<packageId>.json
    const latestFilePath = path.join(this.packagesDir, `${safeId}.json`);
    await atomicWriteJson(latestFilePath, pkg);

    // 2. Write immutable revision file: packages/<packageId>/rev-<revision>.json
    const revisionDir = path.join(this.packagesDir, safeId);
    const revisionFilePath = path.join(revisionDir, `rev-${pkg.revision}.json`);
    await atomicWriteJson(revisionFilePath, pkg);

    // 3. Update active-package pointer
    await atomicWriteJson(this.activePackagePath, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      projectId: pkg.projectId,
      status: pkg.status,
      updatedAt: pkg.updatedAt,
    });

    // 4. Optionally log audit event to History stream
    if (this.historyManager) {
      try {
        let eventType = 'PROJECT_UNDERSTANDING_CREATED';
        let actor: Actor = Actor.DIRECTOR;

        if (pkg.status === 'APPROVED') {
          eventType = 'PROJECT_UNDERSTANDING_APPROVED';
          actor = Actor.USER;
        } else if (pkg.status === 'REJECTED') {
          eventType = 'PROJECT_UNDERSTANDING_REJECTED';
          actor = Actor.USER;
        } else if (pkg.revision > 1) {
          eventType = 'PROJECT_UNDERSTANDING_REVISED';
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
            packageHash: pkg.approvalRecord?.packageHash ?? pkg.rejectionRecord?.packageHash ?? null,
          },
        });
      } catch {
        // Logging failure should not break persistence
      }
    }
  }

  /**
   * Loads a ProjectApprovalPackage from disk by packageId and optional revision.
   * If revision is omitted, loads the latest package state.
   */
  async loadPackage(packageId: string, revision?: number): Promise<ProjectApprovalPackage | null> {
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

    const raw = await readJsonFile<ProjectApprovalPackage>(targetPath);
    if (!raw) {
      return null;
    }

    const parseResult = ProjectApprovalPackageZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new ApprovalValidationError(
        `Corrupt or invalid approval package file at '${targetPath}': ${parseResult.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { filePath: targetPath, issues: parseResult.error.issues }
      );
    }

    return parseResult.data as unknown as ProjectApprovalPackage;
  }

  /**
   * Loads the currently active project approval package, if any.
   */
  async getActivePackage(): Promise<ProjectApprovalPackage | null> {
    const pointer = await readJsonFile<{ packageId?: string; revision?: number }>(
      this.activePackagePath
    );
    if (!pointer?.packageId) {
      return null;
    }

    return this.loadPackage(pointer.packageId, pointer.revision);
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
