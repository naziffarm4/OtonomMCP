import { RiskLevel, isRiskLevel } from '../risk.js';

// ============================================================================
// 1. GIT OPERATION TYPES & DETERMINISTIC RISK LEVEL CLASSIFICATION
// ============================================================================

export const GitOperationType = {
  // SAFE (read-only inspection, zero mutation)
  STATUS_INSPECTION: 'STATUS_INSPECTION',
  DIFF_INSPECTION: 'DIFF_INSPECTION',
  LOG_INSPECTION: 'LOG_INSPECTION',
  BRANCH_INSPECTION: 'BRANCH_INSPECTION',
  REMOTE_HEAD_INSPECTION: 'REMOTE_HEAD_INSPECTION',
  REMOTE_VERIFICATION: 'REMOTE_VERIFICATION',
  HISTORY_DIVERGENCE_DETECTION: 'HISTORY_DIVERGENCE_DETECTION',

  // CAUTION (normal workspace commits, normal push to configured branch, checkpoint creation)
  COMMIT: 'COMMIT',
  PUSH: 'PUSH',
  PRE_FLIGHT_CHECKPOINT: 'PRE_FLIGHT_CHECKPOINT',
  POST_FLIGHT_CHECKPOINT: 'POST_FLIGHT_CHECKPOINT',
  CHECKPOINT_CREATION: 'CHECKPOINT_CREATION',

  // DANGEROUS (reset, checkout affecting worktree, revert, rollback request, history rewrite)
  RESET: 'RESET',
  CHECKOUT: 'CHECKOUT',
  REVERT: 'REVERT',
  ROLLBACK_REQUEST: 'ROLLBACK_REQUEST',
  HISTORY_REWRITE: 'HISTORY_REWRITE',

  // CRITICAL (force push, destructive remote history rewrite, destroying unrecoverable history)
  FORCE_PUSH: 'FORCE_PUSH',
  DESTRUCTIVE_REMOTE_REWRITE: 'DESTRUCTIVE_REMOTE_REWRITE',
  DESTROY_PROJECT_HISTORY: 'DESTROY_PROJECT_HISTORY',
} as const;

export type GitOperationType = (typeof GitOperationType)[keyof typeof GitOperationType];
export const GIT_OPERATION_TYPES = Object.values(GitOperationType) as readonly GitOperationType[];

export function isGitOperationType(value: unknown): value is GitOperationType {
  return typeof value === 'string' && (GIT_OPERATION_TYPES as readonly string[]).includes(value);
}

/**
 * Deterministically maps each Git operation type to its project RiskLevel.
 * SAFE: Read-only, inspection, zero mutation
 * CAUTION: Normal local commit, push to configured branch, checkpoint creation
 * DANGEROUS: Reset, checkout affecting worktree, revert, rollback request
 * CRITICAL: Force push, destructive remote history rewrites (STRICTLY PROHIBITED)
 */
export function getGitOperationRiskLevel(operation: GitOperationType): RiskLevel {
  switch (operation) {
    case GitOperationType.STATUS_INSPECTION:
    case GitOperationType.DIFF_INSPECTION:
    case GitOperationType.LOG_INSPECTION:
    case GitOperationType.BRANCH_INSPECTION:
    case GitOperationType.REMOTE_HEAD_INSPECTION:
    case GitOperationType.REMOTE_VERIFICATION:
    case GitOperationType.HISTORY_DIVERGENCE_DETECTION:
      return RiskLevel.SAFE;

    case GitOperationType.COMMIT:
    case GitOperationType.PUSH:
    case GitOperationType.PRE_FLIGHT_CHECKPOINT:
    case GitOperationType.POST_FLIGHT_CHECKPOINT:
    case GitOperationType.CHECKPOINT_CREATION:
      return RiskLevel.CAUTION;

    case GitOperationType.RESET:
    case GitOperationType.CHECKOUT:
    case GitOperationType.REVERT:
    case GitOperationType.ROLLBACK_REQUEST:
    case GitOperationType.HISTORY_REWRITE:
      return RiskLevel.DANGEROUS;

    case GitOperationType.FORCE_PUSH:
    case GitOperationType.DESTRUCTIVE_REMOTE_REWRITE:
    case GitOperationType.DESTROY_PROJECT_HISTORY:
      return RiskLevel.CRITICAL;

    default:
      return RiskLevel.CRITICAL;
  }
}

// ============================================================================
// 2. GIT STATE CONTRACT & STATUS ENUMS
// ============================================================================

export const GitStatus = {
  CLEAN: 'CLEAN',
  DIRTY: 'DIRTY',
  DIVERGED: 'DIVERGED',
  DETACHED: 'DETACHED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type GitStatus = (typeof GitStatus)[keyof typeof GitStatus];
export const GIT_STATUSES = Object.values(GitStatus) as readonly GitStatus[];

export const GitWorktreeStatus = {
  CLEAN: 'CLEAN',
  DIRTY: 'DIRTY',
  UNKNOWN: 'UNKNOWN',
} as const;
export type GitWorktreeStatus = (typeof GitWorktreeStatus)[keyof typeof GitWorktreeStatus];

export const GitRemoteSyncStatus = {
  UP_TO_DATE: 'UP_TO_DATE',
  AHEAD: 'AHEAD',
  BEHIND: 'BEHIND',
  DIVERGED: 'DIVERGED',
  DETACHED: 'DETACHED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type GitRemoteSyncStatus = (typeof GitRemoteSyncStatus)[keyof typeof GitRemoteSyncStatus];

export interface GitDivergence {
  readonly ahead: number;
  readonly behind: number;
  readonly diverged: boolean;
}

/**
 * Provider-neutral Git state representation.
 * Distinguishes CLEAN, DIRTY, DIVERGED, DETACHED, and UNKNOWN states.
 */
export interface GitState {
  readonly head_sha: string | null;
  readonly current_branch: string | null;
  readonly remote_head_sha: string | null;
  readonly working_tree_clean: boolean;
  readonly staged_changes: readonly string[];
  readonly unstaged_changes: readonly string[];
  readonly untracked_files: readonly string[];
  readonly divergence: GitDivergence;
  readonly is_detached_head: boolean;
  readonly remote_sync_state: GitRemoteSyncStatus;
  readonly status: GitStatus;
  readonly parent_sha?: string | null;

  // Convenience aliases and backwards compatibility fields:
  readonly isRepository?: boolean;
  readonly currentHead?: string | null;
  readonly isClean?: boolean;
  readonly stagedFiles?: readonly string[];
  readonly unstagedFiles?: readonly string[];
  readonly untrackedFiles?: readonly string[];
  readonly branch?: string | null;
  readonly headSha?: string | null;
  readonly remoteHeadSha?: string | null;
  readonly isDetached?: boolean;
  readonly parentSha?: string | null;
}

/**
 * Input structure for constructing or normalizing a GitState.
 */
export interface GitStateInput {
  head_sha?: string | null;
  current_branch?: string | null;
  remote_head_sha?: string | null;
  parent_sha?: string | null;
  working_tree_clean?: boolean;
  staged_changes?: readonly string[];
  unstaged_changes?: readonly string[];
  untracked_files?: readonly string[];
  divergence?: Partial<GitDivergence>;
  is_detached_head?: boolean;
  remote_sync_state?: GitRemoteSyncStatus;
  status?: GitStatus;

  // Backward compatibility alias inputs
  isRepository?: boolean;
  currentHead?: string | null;
  isClean?: boolean;
  stagedFiles?: readonly string[];
  unstagedFiles?: readonly string[];
  untrackedFiles?: readonly string[];
  branch?: string | null;
  headSha?: string | null;
  remoteHeadSha?: string | null;
  isDetached?: boolean;
  parentSha?: string | null;
}

/**
 * Deterministically constructs an immutable, provider-neutral GitState.
 */
export function createGitState(input: GitStateInput): GitState {
  const head_sha = input.head_sha ?? input.headSha ?? input.currentHead ?? null;
  const current_branch = input.current_branch ?? input.branch ?? null;
  const remote_head_sha = input.remote_head_sha ?? input.remoteHeadSha ?? null;
  const parent_sha = input.parent_sha ?? input.parentSha ?? null;

  const staged_changes = Object.freeze([...(input.staged_changes ?? input.stagedFiles ?? [])]);
  const unstaged_changes = Object.freeze([...(input.unstaged_changes ?? input.unstagedFiles ?? [])]);
  const untracked_files = Object.freeze([...(input.untracked_files ?? input.untrackedFiles ?? [])]);

  const working_tree_clean =
    input.working_tree_clean !== undefined
      ? input.working_tree_clean
      : input.isClean !== undefined
      ? input.isClean
      : staged_changes.length === 0 && unstaged_changes.length === 0 && untracked_files.length === 0;

  const ahead = input.divergence?.ahead ?? 0;
  const behind = input.divergence?.behind ?? 0;
  const diverged = input.divergence?.diverged ?? (ahead > 0 && behind > 0);

  const divergence: GitDivergence = Object.freeze({
    ahead,
    behind,
    diverged,
  });

  const is_detached_head = input.is_detached_head ?? input.isDetached ?? (current_branch === null && head_sha !== null);

  let remote_sync_state = input.remote_sync_state;
  if (!remote_sync_state) {
    if (is_detached_head) {
      remote_sync_state = GitRemoteSyncStatus.DETACHED;
    } else if (diverged) {
      remote_sync_state = GitRemoteSyncStatus.DIVERGED;
    } else if (ahead > 0 && behind === 0) {
      remote_sync_state = GitRemoteSyncStatus.AHEAD;
    } else if (behind > 0 && ahead === 0) {
      remote_sync_state = GitRemoteSyncStatus.BEHIND;
    } else if (remote_head_sha !== null && remote_head_sha === head_sha) {
      remote_sync_state = GitRemoteSyncStatus.UP_TO_DATE;
    } else {
      remote_sync_state = GitRemoteSyncStatus.UNKNOWN;
    }
  }

  let status = input.status;
  if (!status) {
    if (is_detached_head) {
      status = GitStatus.DETACHED;
    } else if (diverged || remote_sync_state === GitRemoteSyncStatus.DIVERGED) {
      status = GitStatus.DIVERGED;
    } else if (!working_tree_clean) {
      status = GitStatus.DIRTY;
    } else if (head_sha === null && current_branch === null) {
      status = GitStatus.UNKNOWN;
    } else {
      status = GitStatus.CLEAN;
    }
  }

  return Object.freeze({
    head_sha,
    current_branch,
    remote_head_sha,
    working_tree_clean,
    staged_changes,
    unstaged_changes,
    untracked_files,
    divergence,
    is_detached_head,
    remote_sync_state,
    status,
    parent_sha,

    // Aliases
    isRepository: input.isRepository ?? true,
    currentHead: head_sha,
    isClean: working_tree_clean,
    stagedFiles: staged_changes,
    unstagedFiles: unstaged_changes,
    untrackedFiles: untracked_files,
    branch: current_branch,
    headSha: head_sha,
    remoteHeadSha: remote_head_sha,
    isDetached: is_detached_head,
    parentSha: parent_sha,
  });
}

// ============================================================================
// 3. CHECKPOINT CONTRACT
// ============================================================================

export const GitCheckpointPurpose = {
  PRE_FLIGHT: 'PRE_FLIGHT',
  POST_FLIGHT: 'POST_FLIGHT',
  TASK_BOUNDARY: 'TASK_BOUNDARY',
  RECOVERY_BASE: 'RECOVERY_BASE',
  MANUAL: 'MANUAL',
} as const;
export type GitCheckpointPurpose =
  | (typeof GitCheckpointPurpose)[keyof typeof GitCheckpointPurpose]
  | string;

/**
 * Provider-neutral checkpoint representation.
 * Captures all required checkpoint metadata to establish reproducible orchestrator boundaries.
 */
export interface GitCheckpoint {
  readonly checkpoint_id: string;
  readonly task_id: string | null;
  readonly phase: string;
  readonly purpose: GitCheckpointPurpose;
  readonly commit_sha: string;
  readonly parent_sha: string | null;
  readonly branch: string;
  readonly remote: string | null;
  readonly created_at: string;
  readonly working_tree_clean: boolean;
  readonly remote_verified: boolean;
  readonly policy_level: RiskLevel;
  readonly metadata?: Readonly<Record<string, unknown>>;

  // Convenience aliases
  readonly checkpointId?: string;
  readonly taskId?: string | null;
  readonly commitSha?: string;
  readonly parentSha?: string | null;
  readonly createdAt?: string;
  readonly workingTreeClean?: boolean;
  readonly remoteVerified?: boolean;
  readonly policyLevel?: RiskLevel;
}

// ============================================================================
// 4. OPERATION INTENT & POLICY EVALUATION MODELS
// ============================================================================

export interface GitOperationIntent {
  readonly operation: GitOperationType;
  readonly target_branch?: string;
  readonly target_remote?: string;
  readonly commit_message?: string;
  readonly checkpoint_id?: string;
  readonly task_id?: string | null;
  readonly phase?: string;
  readonly purpose?: GitCheckpointPurpose;
  readonly expected_parent_sha?: string | null;
  readonly expected_commit_sha?: string | null;
  readonly force?: boolean;
  readonly human_approval_token?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const GitPolicyDecisionState = {
  AUTHORIZED: 'AUTHORIZED',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
} as const;
export type GitPolicyDecisionState =
  (typeof GitPolicyDecisionState)[keyof typeof GitPolicyDecisionState];

export const GitPolicyViolationCode = {
  MISSING_STATE_INFORMATION: 'MISSING_STATE_INFORMATION',
  MISSING_OPERATION_TYPE: 'MISSING_OPERATION_TYPE',
  DIRTY_WORKTREE_PROHIBITED: 'DIRTY_WORKTREE_PROHIBITED',
  DETACHED_HEAD_PROHIBITED: 'DETACHED_HEAD_PROHIBITED',
  BRANCH_MISMATCH: 'BRANCH_MISMATCH',
  REMOTE_MISMATCH: 'REMOTE_MISMATCH',
  FORCE_PUSH_PROHIBITED: 'FORCE_PUSH_PROHIBITED',
  CRITICAL_OPERATION_PROHIBITED: 'CRITICAL_OPERATION_PROHIBITED',
  WRONG_PARENT_SHA: 'WRONG_PARENT_SHA',
  MISSING_COMMIT: 'MISSING_COMMIT',
  REMOTE_VERIFICATION_FAILED: 'REMOTE_VERIFICATION_FAILED',
  HISTORY_DIVERGENCE_DETECTED: 'HISTORY_DIVERGENCE_DETECTED',
  HUMAN_APPROVAL_REQUIRED: 'HUMAN_APPROVAL_REQUIRED',
  DESTRUCTIVE_OPERATION_BLOCKED: 'DESTRUCTIVE_OPERATION_BLOCKED',
} as const;
export type GitPolicyViolationCode =
  (typeof GitPolicyViolationCode)[keyof typeof GitPolicyViolationCode];

export interface GitPolicyViolation {
  readonly code: GitPolicyViolationCode | string;
  readonly message: string;
  readonly field?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface GitPolicyDecision {
  readonly allowed: boolean;
  readonly decision: GitPolicyDecisionState;
  readonly risk_level: RiskLevel;
  readonly operation: GitOperationType;
  readonly reasons: readonly string[];
  readonly requires_human_approval: boolean;
  readonly violations: readonly GitPolicyViolation[];
  readonly evaluated_at: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GitExecutionResult {
  readonly success: boolean;
  readonly operation: GitOperationType;
  readonly policy_level: RiskLevel;
  readonly commit_sha?: string | null;
  readonly checkpoint?: GitCheckpoint | null;
  readonly state_after?: GitState | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string | null;
  readonly executed_at: string;
}
