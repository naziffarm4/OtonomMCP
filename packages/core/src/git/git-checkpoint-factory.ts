import * as crypto from 'node:crypto';
import { RiskLevel, isRiskLevel } from '../risk.js';
import {
  type GitCheckpoint,
  type GitCheckpointPurpose,
  GitCheckpointPurpose as GitCheckpointPurposes,
} from './git-types.js';
import { GitCheckpointIntegrityError } from '../errors/git-policy-error.js';

import { GIT_SHA1_REGEX, GIT_SHA256_REGEX } from '../evidence/evidence-validator.js';

/**
 * Checks whether a string is a valid 40-character or 64-character Git commit hash.
 */
export function isValidCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && (GIT_SHA1_REGEX.test(sha) || GIT_SHA256_REGEX.test(sha));
}

export interface GitCheckpointInput {
  checkpoint_id?: string;
  task_id?: string | null;
  phase: string;
  purpose: GitCheckpointPurpose;
  commit_sha: string;
  parent_sha?: string | null;
  branch: string;
  remote?: string | null;
  created_at?: string;
  working_tree_clean: boolean;
  remote_verified?: boolean;
  policy_level?: RiskLevel;
  metadata?: Readonly<Record<string, unknown>>;

  // CamelCase aliases
  checkpointId?: string;
  taskId?: string | null;
  commitSha?: string;
  parentSha?: string | null;
  createdAt?: string;
  workingTreeClean?: boolean;
  remoteVerified?: boolean;
  policyLevel?: RiskLevel;
}

export interface GitCheckpointValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validates the schema and invariant rules of a GitCheckpoint object.
 */
export function validateGitCheckpointSchema(value: unknown): GitCheckpointValidationResult {
  const errors: string[] = [];

  if (!value || typeof value !== 'object') {
    return { valid: false, errors: ['Checkpoint must be a non-null object'] };
  }

  const cp = value as Record<string, unknown>;

  const checkpointId = cp.checkpoint_id ?? cp.checkpointId;
  if (typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
    errors.push('checkpoint_id is required and must be a non-empty string');
  }

  const phase = cp.phase;
  if (typeof phase !== 'string' || phase.trim().length === 0) {
    errors.push('phase is required and must be a non-empty string');
  }

  const purpose = cp.purpose;
  if (typeof purpose !== 'string' || purpose.trim().length === 0) {
    errors.push('purpose is required and must be a non-empty string');
  }

  const commitSha = cp.commit_sha ?? cp.commitSha;
  if (!isValidCommitSha(commitSha)) {
    errors.push(`commit_sha must be a valid 40-char SHA-1 or 64-char SHA-256 hex string, received: ${String(commitSha)}`);
  }

  const parentSha = cp.parent_sha !== undefined ? cp.parent_sha : cp.parentSha;
  if (parentSha !== null && parentSha !== undefined && !isValidCommitSha(parentSha)) {
    errors.push(`parent_sha if provided must be a valid SHA or null, received: ${String(parentSha)}`);
  }

  const branch = cp.branch;
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    errors.push('branch is required and must be a non-empty string');
  }

  const workingTreeClean =
    cp.working_tree_clean !== undefined ? cp.working_tree_clean : cp.workingTreeClean;
  if (typeof workingTreeClean !== 'boolean') {
    errors.push('working_tree_clean must be a boolean');
  }

  const remoteVerified =
    cp.remote_verified !== undefined ? cp.remote_verified : cp.remoteVerified;
  if (remoteVerified !== undefined && typeof remoteVerified !== 'boolean') {
    errors.push('remote_verified if provided must be a boolean');
  }

  const policyLevel = cp.policy_level ?? cp.policyLevel;
  if (policyLevel !== undefined && !isRiskLevel(policyLevel)) {
    errors.push(`policy_level must be a valid RiskLevel (SAFE, CAUTION, DANGEROUS, CRITICAL), received: ${String(policyLevel)}`);
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  };
}

/**
 * Creates and returns an immutable GitCheckpoint, validating all fields.
 * Throws GitCheckpointIntegrityError if input fields fail validation.
 */
export function createGitCheckpoint(input: GitCheckpointInput): GitCheckpoint {
  const checkpoint_id = input.checkpoint_id ?? input.checkpointId ?? crypto.randomUUID();
  const task_id = input.task_id !== undefined ? input.task_id : (input.taskId ?? null);
  const phase = input.phase;
  const purpose = input.purpose;
  const commit_sha = input.commit_sha ?? input.commitSha ?? '';
  const parent_sha = input.parent_sha !== undefined ? input.parent_sha : (input.parentSha ?? null);
  const branch = input.branch;
  const remote = input.remote ?? null;
  const created_at = input.created_at ?? input.createdAt ?? new Date().toISOString();
  const working_tree_clean =
    input.working_tree_clean !== undefined
      ? input.working_tree_clean
      : input.workingTreeClean ?? false;
  const remote_verified =
    input.remote_verified !== undefined
      ? input.remote_verified
      : input.remoteVerified ?? false;
  const policy_level = input.policy_level ?? input.policyLevel ?? RiskLevel.CAUTION;
  const metadata = input.metadata ? Object.freeze({ ...input.metadata }) : undefined;

  const rawCandidate = {
    checkpoint_id,
    task_id,
    phase,
    purpose,
    commit_sha,
    parent_sha,
    branch,
    remote,
    created_at,
    working_tree_clean,
    remote_verified,
    policy_level,
    metadata,
  };

  const validation = validateGitCheckpointSchema(rawCandidate);
  if (!validation.valid) {
    throw new GitCheckpointIntegrityError(
      `Cannot create GitCheckpoint: ${validation.errors.join('; ')}`,
      {
        checkpointId: checkpoint_id,
        commitSha: commit_sha,
        parentSha: parent_sha,
        violations: validation.errors.map((e) => ({
          code: 'INVALID_CHECKPOINT_SCHEMA',
          message: e,
        })),
      }
    );
  }

  return Object.freeze({
    checkpoint_id,
    task_id,
    phase,
    purpose,
    commit_sha,
    parent_sha,
    branch,
    remote,
    created_at,
    working_tree_clean,
    remote_verified,
    policy_level,
    metadata,

    // Aliases
    checkpointId: checkpoint_id,
    taskId: task_id,
    commitSha: commit_sha,
    parentSha: parent_sha,
    createdAt: created_at,
    workingTreeClean: working_tree_clean,
    remoteVerified: remote_verified,
    policyLevel: policy_level,
  });
}
