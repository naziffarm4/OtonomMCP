/**
 * Canonical Project Root Resolver (Phase 18 P18-02)
 *
 * Implements the authoritative 4-tier project-root resolution priority:
 * 1. explicit workspaceRoot
 * 2. active project/session context projectRoot
 * 3. configured projectRoot
 * 4. process.cwd() fallback
 *
 * STRICT INVARIANTS:
 * 1. AIDM server repository != target project.
 * 2. Project-specific state (!= server-global state) must live under <resolvedProjectRoot>/.ai-manager/.
 * 3. Explicit root and active context conflict must fail closed (no silent preference).
 * 4. Invalid roots (nonexistent, file instead of directory, illegal characters) must fail closed.
 * 5. No silent fallback from invalid explicit root to process.cwd().
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpInvalidRequestError } from './mcp-errors.js';
import type { McpOrchestratorDelegate } from './mcp-delegate.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';

export interface ResolveProjectRootOptions {
  readonly explicitRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly allowCwdFallback?: boolean;
  readonly ignoreActiveContextConflict?: boolean;
  readonly targetProjectId?: string;
}

export function resolveTargetProjectRoot(options: ResolveProjectRootOptions): string {
  const { explicitRoot, delegate, allowCwdFallback = true, ignoreActiveContextConflict = false, targetProjectId } = options;

  let validatedExplicit: string | undefined;

  // 1. Explicit workspaceRoot validation (Priority 1)
  if (explicitRoot !== undefined && explicitRoot !== null) {
    if (typeof explicitRoot !== 'string' || explicitRoot.trim().length === 0) {
      throw new McpInvalidRequestError('Explicit workspaceRoot must be a non-empty string');
    }

    if (explicitRoot.includes('\0')) {
      throw new McpInvalidRequestError('Explicit workspaceRoot contains invalid characters');
    }

    const resolved = path.resolve(explicitRoot);

    if (!fs.existsSync(resolved)) {
      throw new McpInvalidRequestError(`Explicit workspaceRoot does not exist: "${explicitRoot}"`);
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        throw new McpInvalidRequestError(`Explicit workspaceRoot is not a directory: "${explicitRoot}"`);
      }
    } catch (err) {
      if (err instanceof McpInvalidRequestError) throw err;
      throw new McpInvalidRequestError(`Cannot access explicit workspaceRoot: "${explicitRoot}"`);
    }

    validatedExplicit = resolved;
  }

  // 2. Active project/session context (Priority 2)
  const activeContext = delegate?.activeContext;
  let validatedActive: string | undefined;

  if (activeContext?.projectRoot) {
    const resolvedActive = path.resolve(activeContext.projectRoot);
    if (!fs.existsSync(resolvedActive) || !fs.statSync(resolvedActive).isDirectory()) {
      throw new McpInvalidRequestError(
        `Active context projectRoot does not exist or is not a directory: "${activeContext.projectRoot}"`
      );
    }
    validatedActive = resolvedActive;
  }

  // Conflict Detection between Explicit Root and Active Context
  if (validatedExplicit && validatedActive && !ignoreActiveContextConflict) {
    if (path.resolve(validatedExplicit) !== path.resolve(validatedActive)) {
      throw new McpInvalidRequestError(
        `Explicit workspaceRoot "${validatedExplicit}" conflicts with active context projectRoot "${validatedActive}". Cross-project conflict rejected.`
      );
    }
    if (targetProjectId !== undefined && targetProjectId !== null) {
      const trimmedTarget = targetProjectId.trim();
      if (trimmedTarget.length > 0 && activeContext?.projectId && activeContext.projectId !== trimmedTarget) {
        throw new McpInvalidRequestError(
          `Target projectId "${trimmedTarget}" conflicts with active context projectId "${activeContext.projectId}". Cross-project conflict rejected.`
        );
      }
    }
    return validatedExplicit;
  }

  if (validatedExplicit) {
    return validatedExplicit;
  }

  // If no explicit root was provided, check activeContext
  if (validatedActive) {
    if (targetProjectId !== undefined && targetProjectId !== null) {
      const trimmedTarget = targetProjectId.trim();
      if (trimmedTarget.length > 0 && activeContext?.projectId && activeContext.projectId !== trimmedTarget) {
        throw new McpInvalidRequestError(
          `Target projectId "${trimmedTarget}" conflicts with active context projectId "${activeContext.projectId}". Cross-project mismatch rejected.`
        );
      }
    }
    return validatedActive;
  }

  // 3. Configured projectRoot (Priority 3)
  if (delegate?.projectRoot) {
    const resolvedConfigured = path.resolve(delegate.projectRoot);
    if (!fs.existsSync(resolvedConfigured) || !fs.statSync(resolvedConfigured).isDirectory()) {
      throw new McpInvalidRequestError(
        `Configured projectRoot does not exist or is not a directory: "${delegate.projectRoot}"`
      );
    }
    return resolvedConfigured;
  }

  // 4. process.cwd() fallback (Priority 4)
  if (allowCwdFallback) {
    const cwd = process.cwd();
    if (targetProjectId !== undefined && targetProjectId !== null) {
      const trimmedTarget = targetProjectId.trim();
      if (trimmedTarget.length > 0) {
        const cwdCanonical = resolveCanonicalProjectIdentity(cwd);
        if (cwdCanonical.projectId !== trimmedTarget) {
          throw new McpInvalidRequestError(
            `Target projectId "${trimmedTarget}" does not match process.cwd() "${cwd}" (projectId "${cwdCanonical.projectId}"). Cross-project mismatch rejected.`
          );
        }
      }
    }
    return cwd;
  }

  throw new McpInvalidRequestError('No project root specified and fallback is disabled');
}
