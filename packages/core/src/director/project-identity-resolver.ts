/**
 * Canonical Project Identity Resolver & Project Binding Validator (Phase 9 TASK-P9-01)
 *
 * Ensures a Director session is strictly bound to its canonical project context,
 * preventing cross-project session reuse and validating project identities.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { DirectorSession } from './director-types.js';
import { DirectorProjectBindingMismatchError } from './director-errors.js';

export interface CanonicalProjectIdentity {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly ecosystem: string;
}

/**
 * Authoritative regular expression for valid project IDs across all AIDM stores.
 * Disallows spaces, path traversal, backslashes, and control characters.
 */
export const CANONICAL_PROJECT_ID_REGEX = /^[a-zA-Z0-9_\-\.@\/]+$/;

/**
 * Normalizes an arbitrary raw project name or directory basename into a valid canonical projectId.
 * Rules:
 * - Trims whitespace
 * - Replaces backslashes with slashes
 * - Strips path traversal '..'
 * - Replaces spaces and whitespace sequences with hyphens '-'
 * - Replaces characters outside [a-zA-Z0-9_\-\.@\/] with hyphens '-'
 * - Strips leading/trailing hyphens and slashes
 * - Collapses consecutive hyphens
 * - Falls back to 'unnamed-project' if empty
 */
export function normalizeCanonicalProjectId(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') {
    return 'unnamed-project';
  }
  let normalized = rawName.trim();
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/\.\.+/g, '');
  normalized = normalized.replace(/\s+/g, '-');
  normalized = normalized.replace(/[^a-zA-Z0-9_\-\.@\/]/g, '-');
  normalized = normalized.replace(/^[\-\/]+/, '').replace(/[\-\/]+$/, '');
  normalized = normalized.replace(/\-+/g, '-');
  if (normalized.length === 0) {
    return 'unnamed-project';
  }
  return normalized;
}

/**
 * Validates that an explicit projectId strictly conforms to the canonical contract.
 * Throws an Error if invalid.
 */
export function validateCanonicalProjectId(projectId: string): string {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId cannot be empty.');
  }
  const trimmed = projectId.trim();
  if (
    !CANONICAL_PROJECT_ID_REGEX.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\')
  ) {
    throw new Error(
      `Invalid projectId '${projectId}': contains illegal characters or path traversal.`
    );
  }
  return trimmed.replace(/\//g, '__');
}

/**
 * Resolves the canonical project identity for a workspace root.
 * Reads package manifests or falls back deterministically to directory basename.
 */
export function resolveCanonicalProjectIdentity(workspaceRoot: string): CanonicalProjectIdentity {
  const resolvedRoot = path.resolve(workspaceRoot);
  let name = path.basename(resolvedRoot);
  let ecosystem = 'unknown';

  const packageJsonPath = path.join(resolvedRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(content);
      if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
        name = parsed.name.trim();
      }
      ecosystem = 'node';
    } catch {
      // Ignore parse failure; fallback to dirname
    }
  } else {
    const cargoTomlPath = path.join(resolvedRoot, 'Cargo.toml');
    if (fs.existsSync(cargoTomlPath)) {
      try {
        const content = fs.readFileSync(cargoTomlPath, 'utf8');
        const match = content.match(/name\s*=\s*["']([^"']+)["']/);
        if (match && match[1]) {
          name = match[1].trim();
        }
        ecosystem = 'rust';
      } catch {
        // Fallback
      }
    } else {
      const pyprojectPath = path.join(resolvedRoot, 'pyproject.toml');
      if (fs.existsSync(pyprojectPath)) {
        try {
          const content = fs.readFileSync(pyprojectPath, 'utf8');
          const match = content.match(/name\s*=\s*["']([^"']+)["']/);
          if (match && match[1]) {
            name = match[1].trim();
          }
          ecosystem = 'python';
        } catch {
          // Fallback
        }
      }
    }
  }

  const rawName = name;
  const canonicalId = normalizeCanonicalProjectId(rawName);

  return {
    projectId: canonicalId,
    projectName: rawName,
    projectRoot: resolvedRoot,
    ecosystem,
  };
}

/**
 * Validates that a DirectorSession matches the requested project context.
 * Throws DirectorProjectBindingMismatchError if cross-project reuse is attempted.
 */
export function validateProjectBinding(
  session: DirectorSession,
  context: {
    readonly workspaceRoot?: string;
    readonly projectId?: string;
  }
): void {
  // 1. Validate projectId if explicitly provided
  if (context.projectId !== undefined && context.projectId !== null) {
    const trimmedInput = context.projectId.trim();
    if (trimmedInput.length > 0 && session.projectId !== trimmedInput) {
      throw new DirectorProjectBindingMismatchError(
        `Director session '${session.directorSessionId}' is bound to project '${session.projectId}', but request specified project '${trimmedInput}'. Cross-project session reuse is strictly prohibited.`,
        {
          sessionId: session.directorSessionId,
          sessionProjectId: session.projectId,
          requestedProjectId: trimmedInput,
        }
      );
    }
  }

  // 2. Validate workspaceRoot if provided
  if (context.workspaceRoot !== undefined && context.workspaceRoot !== null) {
    const resolvedInputRoot = path.resolve(context.workspaceRoot);
    const sessionRoot = path.resolve(session.projectRoot);

    if (resolvedInputRoot !== sessionRoot) {
      // Check if canonical projectId matches before rejecting
      const canonical = resolveCanonicalProjectIdentity(resolvedInputRoot);
      if (canonical.projectId !== session.projectId) {
        throw new DirectorProjectBindingMismatchError(
          `Director session '${session.directorSessionId}' is bound to workspace '${session.projectRoot}' (project '${session.projectId}'), but request specified workspace '${resolvedInputRoot}' (project '${canonical.projectId}'). Cross-project session reuse is strictly prohibited.`,
          {
            sessionId: session.directorSessionId,
            sessionProjectRoot: session.projectRoot,
            requestedWorkspaceRoot: resolvedInputRoot,
          }
        );
      }
    }
  }
}
