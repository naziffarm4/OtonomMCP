import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import type { RiskLevel } from '../risk.js';

export type GitPolicyErrorCode =
  | 'ERR_GIT_POLICY_VIOLATION'
  | 'ERR_GIT_FORCE_PUSH_PROHIBITED'
  | 'ERR_GIT_CHECKPOINT_INTEGRITY'
  | 'ERR_GIT_INVALID_STATE'
  | 'ERR_GIT_OPERATION_NOT_AUTHORIZED'
  | 'ERR_GIT_REMOTE_VERIFICATION_FAILED'
  | 'ERR_GIT_HUMAN_APPROVAL_REQUIRED'
  | 'ERR_GIT_DIRTY_WORKTREE'
  | 'ERR_GIT_DETACHED_HEAD'
  | 'ERR_GIT_BRANCH_MISMATCH'
  | 'ERR_GIT_REMOTE_MISMATCH';

export interface GitPolicyViolationItem {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface GitPolicyErrorDetails extends AidmErrorDetails {
  readonly operation?: string;
  readonly riskLevel?: RiskLevel;
  readonly configuredBranch?: string;
  readonly currentBranch?: string | null;
  readonly configuredRemote?: string;
  readonly violations?: readonly GitPolicyViolationItem[];
  readonly checkpointId?: string;
  readonly commitSha?: string;
  readonly parentSha?: string | null;
  readonly requiresHumanApproval?: boolean;
}

/**
 * Base structured error thrown for Git policy and checkpoint boundary violations.
 */
export class GitPolicyError extends AidmError {
  readonly operation?: string;
  readonly riskLevel?: RiskLevel;
  readonly violations?: readonly GitPolicyViolationItem[];

  constructor(
    message: string,
    code: GitPolicyErrorCode = 'ERR_GIT_POLICY_VIOLATION',
    details?: GitPolicyErrorDetails
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.operation = details?.operation;
    this.riskLevel = details?.riskLevel;
    this.violations = details?.violations;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Specifically thrown when an attempt is made to invoke, execute, or authorize
 * a force push or destructive history rewrite.
 */
export class GitForcePushProhibitedError extends GitPolicyError {
  constructor(message = 'Force push is strictly prohibited by policy and cannot be executed', details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_FORCE_PUSH_PROHIBITED', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when checkpoint integrity validation fails (e.g. wrong parent, branch mismatch,
 * detached head, dirty worktree, or remote mismatch).
 */
export class GitCheckpointIntegrityError extends GitPolicyError {
  constructor(message: string, details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_CHECKPOINT_INTEGRITY', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when attempting an operation that requires a clean working tree, but uncommitted
 * changes or untracked files are detected.
 */
export class GitDirtyWorktreeError extends GitPolicyError {
  constructor(message = 'Working tree is dirty; clean workspace required', details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_DIRTY_WORKTREE', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a Git operation or checkpoint cannot be performed because HEAD is detached.
 */
export class GitDetachedHeadError extends GitPolicyError {
  constructor(message = 'Repository is in detached HEAD state', details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_DETACHED_HEAD', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when repository branch does not match expected or configured policy branch.
 */
export class GitBranchMismatchError extends GitPolicyError {
  constructor(message = 'Branch mismatch detected', details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_BRANCH_MISMATCH', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when repository remote does not match expected or configured policy remote.
 */
export class GitRemoteMismatchError extends GitPolicyError {
  constructor(message = 'Remote mismatch detected', details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_REMOTE_MISMATCH', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when remote verification fails to prove commit existence on the remote repository.
 */
export class GitRemoteVerificationError extends GitPolicyError {
  constructor(message = 'Remote verification failed', details?: GitPolicyErrorDetails) {
    super(message, 'ERR_GIT_REMOTE_VERIFICATION_FAILED', details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when expected parent commit SHA does not match observed repository or checkpoint history.
 */
export class GitParentMismatchError extends GitCheckpointIntegrityError {
  constructor(message = 'Parent commit SHA mismatch', details?: GitPolicyErrorDetails) {
    super(message, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when verification of a GitCheckpoint fails.
 */
export class GitCheckpointVerificationError extends GitCheckpointIntegrityError {
  constructor(message = 'Checkpoint verification failed', details?: GitPolicyErrorDetails) {
    super(message, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

