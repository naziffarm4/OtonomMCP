/**
 * @file autonomous-mandate.ts
 * @description Automatic Project Mandate generation & sealing for `aidm run --spec`.
 *
 * AUTHORIZATION SOURCE (HARD RULE):
 * The mandate is authorized by the HUMAN OPERATOR who explicitly invoked
 * `aidm run --spec <file>` from their own shell. The CLI signs an
 * OPERATOR_CLI_INVOCATION auth context with the local, OS-user-protected Ed25519
 * identity (IdentityManager) and seals the mandate through the existing
 * ProjectMandateStore.saveMandate() trusted-identity validation (signature,
 * nonce anti-replay, project binding, short TTL, spec fingerprint binding).
 *
 * The LLM Director NEVER produces, signs or approves this context. MCP callers
 * (which may be LLM agents) cannot use this path; they must present an
 * externally verifiable auth context (P18-04) or the run fails closed with
 * BLOCKED_ON_AUTH_CONTEXT.
 *
 * SCOPE: only IMPLEMENTATION-class work inside the project root is ALLOW.
 * Policy/mandate changes, budget overrides, replanning and human decisions remain
 * REQUIRE_HUMAN_APPROVAL; workspace escape / destructive / push operations are DENY.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ProjectMandate, ProjectMandateZodSchema } from '../authorization/authorization-policy-types.js';
import { ProjectMandateStore } from '../authorization/project-mandate-store.js';
import { IdentityManager } from '../authorization/identity-manager.js';
import { OPERATOR_CLI_INVOCATION_MAX_TTL_MS } from '../authorization/auth-context-validator.js';

export const AUTONOMOUS_ALLOWED_OPERATION_TYPES = Object.freeze([
  'FILE_READ',
  'FILE_CREATE',
  'FILE_MODIFY',
  'IMPLEMENTATION',
  'TEST_EXECUTION',
  'BUILD_EXECUTION',
  'READ_ONLY_INSPECTION',
  'EVIDENCE_REVIEW',
]);

export const AUTONOMOUS_FORBIDDEN_OPERATIONS = Object.freeze([
  'WORKSPACE_ESCAPE',
  'SYSTEM_DESTRUCTIVE',
  'DROP_DATABASE',
  'GIT_PUSH',
  'GIT_FORCE_PUSH',
  'GIT_HISTORY_REWRITE',
  'CREDENTIAL_ACCESS',
  'SECRET_EXFILTRATION',
  'PACKAGE_PUBLISH',
  'DEPLOY_PRODUCTION',
]);

/** Always human-gated. Never ALLOW in an auto-generated mandate. */
export const AUTONOMOUS_HUMAN_APPROVAL_OPERATIONS = Object.freeze([
  'REPLAN',
  'REQUEST_HUMAN_DECISION',
  'UPDATE_SECURITY_POLICY',
  'POLICY_CHANGE',
  'MANDATE_CHANGE',
  'BUDGET_OVERRIDE',
  'BUDGET_INCREASE',
  'OUT_OF_SCOPE_ACTION',
  'NETWORK_ACCESS',
  'DEPENDENCY_INSTALL',
]);

/** Default project-relative directories / root files the Director may target. */
export const DEFAULT_AUTONOMOUS_ALLOWED_PATHS = Object.freeze([
  'src',
  'lib',
  'app',
  'test',
  'tests',
  '__tests__',
  'docs',
  'public',
  'assets',
  'scripts',
  'examples',
  'package.json',
  'README.md',
  'tsconfig.json',
  'jsconfig.json',
  'index.js',
  'index.ts',
  'index.html',
  '.gitignore',
]);

export interface AutonomousMandateOptions {
  readonly projectId: string;
  readonly allowedPaths?: readonly string[];
  /** Mandate validity window in hours (default 8, max 24). */
  readonly validityHours?: number;
  readonly maxFileEdits?: number;
  readonly maxCommands?: number;
  readonly previous?: ProjectMandate | null;
  readonly now?: () => Date;
}

export function buildAutonomousMandate(options: AutonomousMandateOptions): ProjectMandate {
  const now = (options.now ?? (() => new Date()))();
  const hours = Math.min(Math.max(options.validityHours ?? 8, 0.25), 24);
  const allowed = [...new Set([...DEFAULT_AUTONOMOUS_ALLOWED_PATHS, ...(options.allowedPaths ?? [])])];
  return ProjectMandateZodSchema.parse({
    projectId: options.projectId,
    allowedDirectories: allowed,
    allowedOperationTypes: [...AUTONOMOUS_ALLOWED_OPERATION_TYPES],
    allowedCommandCategories: ['test', 'build', 'lint', 'format', 'typecheck'],
    autoExecutableTaskClasses: ['IMPLEMENTATION'],
    forbiddenOperations: [...AUTONOMOUS_FORBIDDEN_OPERATIONS],
    humanApprovalRequiredOperations: [...AUTONOMOUS_HUMAN_APPROVAL_OPERATIONS],
    authorizationStartTime: new Date(now.getTime() - 60_000).toISOString(),
    authorizationEndTime: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    resourceAndWorkLimits: {
      maxFileEdits: options.maxFileEdits ?? 200,
      maxCommands: options.maxCommands ?? 200,
    },
    policyVersion: options.previous?.policyVersion ?? 1,
    mandateRevision: (options.previous?.mandateRevision ?? 0) + 1,
  });
}

// ============================================================================
// OPERATOR INVOCATION AUTHORIZATION
// ============================================================================

export interface OperatorInvocation {
  readonly projectId: string;
  readonly specFingerprint: string;
  readonly specPath: string;
  /** e.g. 'aidm run --spec' or 'aidm_autonomous_start' */
  readonly entryPoint: string;
  readonly budgetUsd: number;
}

export interface OperatorAuthContext extends Record<string, unknown> {
  readonly identityId: string;
  readonly projectId: string;
  readonly actorType: 'USER';
  readonly actorRole: 'PRODUCT_OWNER';
  readonly authSource: 'OPERATOR_CLI_INVOCATION';
  readonly authenticationMethod: string;
  readonly verified: true;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly publicKeyFingerprint: string;
  readonly protocolVersion: number;
  readonly specFingerprint: string;
  readonly specPath: string;
  readonly entryPoint: string;
  readonly budgetUsd: string;
  readonly osUser: string;
  readonly hostPid: number;
  readonly signature: string;
}

/**
 * Signs an OPERATOR_CLI_INVOCATION context with the local identity key.
 * Must only be called from the CLI entry point in response to an explicit human
 * invocation; never from MCP handlers or LLM-driven code paths.
 */
export async function signOperatorInvocation(
  invocation: OperatorInvocation,
  identityManager: IdentityManager,
  now: Date = new Date()
): Promise<OperatorAuthContext> {
  const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
  let osUser = 'unknown';
  try {
    osUser = (await import('node:os')).userInfo().username;
  } catch {
    // best effort provenance
  }
  const payload = {
    identityId,
    projectId: invocation.projectId,
    actorType: 'USER' as const,
    actorRole: 'PRODUCT_OWNER' as const,
    authSource: 'OPERATOR_CLI_INVOCATION' as const,
    authenticationMethod: 'ED25519_LOCAL_IDENTITY',
    verified: true as const,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Math.min(5 * 60_000, OPERATOR_CLI_INVOCATION_MAX_TTL_MS)).toISOString(),
    nonce: crypto.randomUUID(),
    publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey),
    protocolVersion: 1,
    specFingerprint: invocation.specFingerprint,
    specPath: invocation.specPath,
    entryPoint: invocation.entryPoint,
    budgetUsd: String(invocation.budgetUsd),
    osUser,
    hostPid: process.pid,
  };
  const signature = await identityManager.signPayload(payload, privateKey);
  return { ...payload, signature };
}

export interface SealResult {
  readonly mandate: ProjectMandate;
  readonly provenance: AutonomousAuthorizationProvenance;
}

export interface AutonomousAuthorizationProvenance {
  readonly projectId: string;
  readonly mandateRevision: number;
  readonly policyVersion: number;
  readonly specFingerprint: string;
  readonly authSource: string;
  readonly actorType: string;
  readonly identityId?: string;
  readonly publicKeyFingerprint?: string;
  readonly entryPoint: string;
  readonly nonce?: string;
  readonly sealedAt: string;
  readonly note: string;
}

export const AUTONOMOUS_RUN_LOCK_FILE = path.join('.ai-manager', 'state', 'autonomous-run.lock');

/**
 * Seals the mandate via ProjectMandateStore.saveMandate (existing trusted-identity validation).
 * Refuses while another autonomous run holds the lock (prevents an executor launched by the
 * run from re-invoking `aidm run --spec` to mint itself a new mandate).
 */
export async function sealAutonomousMandate(
  store: ProjectMandateStore,
  mandate: ProjectMandate,
  authContext: Record<string, unknown>,
  meta: { specFingerprint: string; entryPoint: string; ignoreLock?: boolean }
): Promise<SealResult> {
  const lockPath = path.join(store.baseDir, AUTONOMOUS_RUN_LOCK_FILE);
  if (!meta.ignoreLock && fs.existsSync(lockPath)) {
    throw new Error(
      `BLOCKED_ON_AUTH_CONTEXT: an autonomous run is already active for this project (${lockPath}). ` +
        'Nested mandate sealing from inside a run is refused.'
    );
  }
  if (authContext.specFingerprint !== undefined && authContext.specFingerprint !== meta.specFingerprint) {
    throw new Error('BLOCKED_ON_AUTH_CONTEXT: auth context is bound to a different spec fingerprint.');
  }
  const sealed = await store.saveMandate(mandate, authContext);
  const provenance: AutonomousAuthorizationProvenance = {
    projectId: sealed.projectId,
    mandateRevision: sealed.mandateRevision,
    policyVersion: sealed.policyVersion,
    specFingerprint: meta.specFingerprint,
    authSource: String(authContext.authSource ?? (authContext.token ? 'EXTERNAL_IDP' : 'UNKNOWN')),
    actorType: String(authContext.actorType ?? 'USER'),
    identityId: typeof authContext.identityId === 'string' ? authContext.identityId : undefined,
    publicKeyFingerprint:
      typeof authContext.publicKeyFingerprint === 'string' ? authContext.publicKeyFingerprint : undefined,
    entryPoint: meta.entryPoint,
    nonce: typeof authContext.nonce === 'string' ? authContext.nonce : undefined,
    sealedAt: new Date().toISOString(),
    note: 'Authorization originates from the human operator invocation, not from LLM output.',
  };
  const provPath = path.join(store.baseDir, '.ai-manager', 'state', 'autonomous-authorization.json');
  await fs.promises.mkdir(path.dirname(provPath), { recursive: true });
  await fs.promises.writeFile(provPath, JSON.stringify(provenance, null, 2), 'utf8');
  return { mandate: sealed, provenance };
}
