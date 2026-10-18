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

/** AIDM state directory inside a managed project (git-ignored, never stashed). */
const AIDM_STATE_ROOT = '.ai-manager';

/**
 * Pinned project identity (project-relative). Written once per project root so that the canonical
 * projectId stays STABLE for the project's lifetime: a task that creates or renames package.json /
 * Cargo.toml / pyproject.toml (e.g. scaffolding with a different `name`) must not change the
 * identity mid-run and make every later task fail as a "cross-project" execution.
 */
export const PROJECT_IDENTITY_PIN_FILE = path.join(AIDM_STATE_ROOT, 'state', 'project-identity.json');

interface ProjectIdentityPin {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly ecosystem: string;
  readonly pinnedAt: string;
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function readIdentityPin(resolvedRoot: string): ProjectIdentityPin | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(resolvedRoot, PROJECT_IDENTITY_PIN_FILE), 'utf8')) as Partial<ProjectIdentityPin>;
    if (
      typeof raw.projectId !== 'string' ||
      !CANONICAL_PROJECT_ID_REGEX.test(raw.projectId) ||
      raw.projectId.includes('..') ||
      typeof raw.projectRoot !== 'string' ||
      // A pin copied along with the folder belongs to another root: ignore (re-pinned below).
      !samePath(raw.projectRoot, resolvedRoot)
    ) {
      return null;
    }
    return {
      projectId: raw.projectId,
      projectName: typeof raw.projectName === 'string' ? raw.projectName : raw.projectId,
      projectRoot: resolvedRoot,
      ecosystem: typeof raw.ecosystem === 'string' ? raw.ecosystem : 'unknown',
      pinnedAt: typeof raw.pinnedAt === 'string' ? raw.pinnedAt : '',
    };
  } catch {
    return null;
  }
}

function writeIdentityPin(identity: CanonicalProjectIdentity): void {
  try {
    const file = path.join(identity.projectRoot, PROJECT_IDENTITY_PIN_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pin: ProjectIdentityPin = { ...identity, pinnedAt: new Date().toISOString() };
    const body = `${JSON.stringify(pin, null, 2)}\n`;
    try {
      // 'wx': never overwrite a valid pin another process wrote concurrently.
      fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      // An existing but invalid / foreign-root pin (folder copied with its .ai-manager) is replaced.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && !readIdentityPin(identity.projectRoot)) {
        fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'w' });
      }
    }
  } catch {
    // Best effort: an unwritable state dir falls back to the derived (unpinned) identity.
  }
}

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
 *
 * A pinned identity (.ai-manager/state/project-identity.json) always wins, so the projectId never
 * changes while AIDM manages the project. Without a pin the identity is derived from the package
 * manifest (or the directory basename); it is pinned automatically once the project is AIDM-managed
 * (the .ai-manager directory exists), or explicitly via {@link pinCanonicalProjectIdentity}.
 */
export function resolveCanonicalProjectIdentity(workspaceRoot: string): CanonicalProjectIdentity {
  const resolvedRoot = path.resolve(workspaceRoot);
  const pinned = readIdentityPin(resolvedRoot);
  if (pinned) {
    return { projectId: pinned.projectId, projectName: pinned.projectName, projectRoot: resolvedRoot, ecosystem: pinned.ecosystem };
  }
  const derived = deriveCanonicalProjectIdentity(resolvedRoot);
  if (fs.existsSync(path.join(resolvedRoot, AIDM_STATE_ROOT))) {
    writeIdentityPin(derived);
    // Another process may have won the race: its pin is authoritative.
    const winner = readIdentityPin(resolvedRoot);
    if (winner) {
      return { projectId: winner.projectId, projectName: winner.projectName, projectRoot: resolvedRoot, ecosystem: winner.ecosystem };
    }
  }
  return derived;
}

/**
 * Pins the project's canonical identity now (idempotent) and returns it. Called at the start of an
 * autonomous run / approval so that files created by tasks can never change the identity.
 */
export function pinCanonicalProjectIdentity(workspaceRoot: string): CanonicalProjectIdentity {
  const resolvedRoot = path.resolve(workspaceRoot);
  if (!readIdentityPin(resolvedRoot)) writeIdentityPin(deriveCanonicalProjectIdentity(resolvedRoot));
  return resolveCanonicalProjectIdentity(resolvedRoot);
}

/** Derives the identity from manifests / directory basename (no pin involved). */
function deriveCanonicalProjectIdentity(resolvedRoot: string): CanonicalProjectIdentity {
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
