import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ResolvedContext,
  ContextRequest,
  ContextLayer,
} from './context-types.js';
import { ContextIntent } from './context-types.js';
import type {
  ContextValidationResult,
  ContextRefreshResult,
  ContextGuardResult,
  StaleFileDetail,
  ContextInvalidatorOptions,
} from './invalidation-types.js';
import {
  ContextValidationAction,
  StaleFileStatus,
} from './invalidation-types.js';
import { computeFileSha256 } from '../l0/hasher.js';
import { ContextEngineError } from '../errors/context-engine-error.js';
import { ContextInvalidationError } from '../errors/context-invalidation-error.js';
import type { ContextEngine } from './context-engine.js';

/**
 * Stale Context Invalidation Engine (Architecture Section 8).
 * 
 * Enforces the authoritative rule:
 * OLD_HASH != CURRENT_HASH
 * -> CONTEXT_INVALIDATED
 * -> STOP OPERATION (guard against overwrites)
 * -> REFRESH CURRENT CONTEXT (L1 / L2)
 * -> RE-EVALUATE (force re-evaluation using refreshed context)
 */
export class ContextInvalidator {
  readonly workspaceRoot: string;
  private contextEngine?: ContextEngine;

  constructor(options: ContextInvalidatorOptions & { contextEngine?: ContextEngine }) {
    if (!options.workspaceRoot) {
      throw new ContextEngineError(
        'workspaceRoot must be provided to ContextInvalidator',
        'ERR_INVALID_CONTEXT_REQUEST'
      );
    }
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.contextEngine = options.contextEngine;
  }

  setContextEngine(engine: ContextEngine): void {
    this.contextEngine = engine;
  }

  /**
   * Validates all context items in a ResolvedContext against the current filesystem.
   * Produces a pure, deterministic validation decision result (Architecture Section 10).
   * 
   * Multi-file determinism:
   * - 0 stale files -> CONTINUE
   * - >=1 stale files -> CONTEXT_INVALIDATED (affected files sorted deterministically)
   * - Unrelated modified files in the workspace do NOT invalidate context.
   */
  async validateContext(context: ResolvedContext): Promise<ContextValidationResult> {
    if (!context || !Array.isArray(context.items)) {
      throw new ContextEngineError(
        'Valid ResolvedContext with items array must be provided for validation',
        'ERR_INVALID_CONTEXT_REQUEST'
      );
    }

    const affectedFiles: StaleFileDetail[] = [];

    for (const item of context.items) {
      const normalizedPath = this.normalizePath(item.sourcePath);
      const fullPath = path.join(this.workspaceRoot, normalizedPath);

      if (!fs.existsSync(fullPath)) {
        affectedFiles.push({
          sourcePath: normalizedPath,
          oldHash: item.fileHash,
          currentHash: null,
          status: StaleFileStatus.DELETED,
          reason: `File no longer exists on disk: '${normalizedPath}'`,
        });
        continue;
      }

      let currentHash: string;
      try {
        currentHash = await computeFileSha256(fullPath);
      } catch (err) {
        affectedFiles.push({
          sourcePath: normalizedPath,
          oldHash: item.fileHash,
          currentHash: null,
          status: StaleFileStatus.UNREADABLE,
          reason: `Failed to compute hash for '${normalizedPath}': ${(err as Error).message}`,
        });
        continue;
      }

      if (currentHash !== item.fileHash) {
        affectedFiles.push({
          sourcePath: normalizedPath,
          oldHash: item.fileHash,
          currentHash,
          status: StaleFileStatus.MODIFIED,
          reason: `Hash mismatch: context=${item.fileHash} disk=${currentHash}`,
        });
      }
    }

    // Sort affected files deterministically by sourcePath
    affectedFiles.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

    if (affectedFiles.length === 0) {
      return {
        isValid: true,
        action: ContextValidationAction.CONTINUE,
        affectedFiles: [],
        reason: 'All context files match current disk SHA-256 hashes',
        contextRequestId: context.requestId,
        taskId: context.taskId,
      };
    }

    return {
      isValid: false,
      action: ContextValidationAction.CONTEXT_INVALIDATED,
      affectedFiles,
      reason: `Context invalidated: ${affectedFiles.length} file(s) changed or deleted`,
      contextRequestId: context.requestId,
      taskId: context.taskId,
    };
  }

  /**
   * Refreshes a stale context using current filesystem content through the ContextEngine.
   * Preserves original request intent and layer requirements where possible.
   * Explicitly signals that RE-EVALUATE is required before proceeding.
   */
  async refreshContext(
    context: ResolvedContext,
    options?: Partial<ContextRequest>
  ): Promise<ContextRefreshResult> {
    if (!this.contextEngine) {
      throw new ContextEngineError(
        'ContextEngine instance required on ContextInvalidator to refresh context',
        'ERR_INVALID_CONTEXT_REQUEST'
      );
    }

    const invalidation = await this.validateContext(context);
    const sourcePaths = context.items.map((item) => item.sourcePath);

    // Map previous target layer to corresponding default refresh intent
    let defaultIntent: ContextIntent = ContextIntent.AUTO;

    if (context.targetLayer === 'L0') {
      defaultIntent = ContextIntent.METADATA;
    } else if (context.targetLayer === 'L1') {
      defaultIntent = ContextIntent.CONTRACT;
    } else if (context.targetLayer === 'L2') {
      defaultIntent = ContextIntent.FULL_IMPLEMENTATION;
    }

    const request: ContextRequest = {
      requestId: options?.requestId ?? `refresh-${Date.now()}`,
      taskId: options?.taskId ?? context.taskId,
      sourcePaths,
      intent: options?.intent ?? defaultIntent,
      requiredLayer: options?.requiredLayer,
      maxLayer: options?.maxLayer,
      relevantSymbols: options?.relevantSymbols,
      diffChunk: options?.diffChunk,
      isSufficient: options?.isSufficient,
    };

    const refreshedContext = await this.contextEngine.resolveContext(request);

    return {
      invalidation,
      refreshedContext,
      action: ContextValidationAction.RE_EVALUATE,
      reason:
        'Context refreshed with current filesystem state. Re-evaluation is required before proceeding.',
    };
  }

  /**
   * Guard checking whether a context is safe to write/modify target files.
   * Throws ContextInvalidationError if context is stale (ERR_CONTEXT_STALE_WRITE_REJECTED).
   */
  async assertValidForWrite(context: ResolvedContext, targetPath?: string): Promise<void> {
    const validation = await this.validateContext(context);
    if (!validation.isValid) {
      const normalizedTarget = targetPath ? this.normalizePath(targetPath) : undefined;
      const matchedDetail = normalizedTarget
        ? validation.affectedFiles.find((f) => f.sourcePath === normalizedTarget)
        : validation.affectedFiles[0];

      throw new ContextInvalidationError(
        `Write operation rejected: context is stale (OLD_HASH != CURRENT_HASH). ${validation.reason}`,
        'ERR_CONTEXT_STALE_WRITE_REJECTED',
        {
          action: ContextValidationAction.CONTEXT_INVALIDATED,
          affectedFiles: validation.affectedFiles,
          contextReference: context.requestId,
          sourcePath: normalizedTarget ?? matchedDetail?.sourcePath,
          oldHash: matchedDetail?.oldHash,
          currentHash: matchedDetail?.currentHash,
          reason: validation.reason,
        }
      );
    }
  }

  /**
   * Non-throwing guard check before write/execution.
   */
  async checkWriteGuard(
    context: ResolvedContext,
    targetPath?: string
  ): Promise<ContextGuardResult> {
    const validation = await this.validateContext(context);
    return {
      allowed: validation.isValid,
      validation,
      targetPath: targetPath ? this.normalizePath(targetPath) : undefined,
    };
  }

  /**
   * Wraps an operation with the context validity guard.
   * Throws ContextInvalidationError and skips operation execution if context is stale.
   */
  async guardOperation<T>(
    context: ResolvedContext,
    operation: () => Promise<T> | T,
    targetPath?: string
  ): Promise<T> {
    await this.assertValidForWrite(context, targetPath);
    return await operation();
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  }
}
