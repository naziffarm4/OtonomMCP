import { RiskLevel } from '../risk.js';
import {
  type GitOperationIntent,
  type GitOperationType,
  type GitState,
  type GitCheckpoint,
  type GitPolicyDecision,
  type GitPolicyViolation,
  GitOperationType as GitOpTypes,
  GitPolicyDecisionState,
  GitPolicyViolationCode,
  GitStatus,
  GitRemoteSyncStatus,
  getGitOperationRiskLevel,
  isGitOperationType,
} from './git-types.js';
import { isValidCommitSha, validateGitCheckpointSchema } from './git-checkpoint-factory.js';

export interface GitPolicyConfig {
  readonly configured_branch: string;
  readonly configured_remote: string;
  readonly require_clean_worktree_for_checkpoint?: boolean;
  readonly require_clean_worktree_for_push?: boolean;
  readonly require_clean_worktree_for_rollback?: boolean;
  readonly allow_detached_head?: boolean;
  readonly require_human_approval_for_dangerous?: boolean;
  readonly prohibit_force_push?: boolean;
  readonly allow_history_rewrite?: boolean;
  readonly validateHumanApprovalToken?: (
    token: string
  ) => boolean | { valid: boolean; reason?: string };
}

export const DEFAULT_GIT_POLICY_CONFIG: GitPolicyConfig = Object.freeze({
  configured_branch: 'main',
  configured_remote: 'origin',
  require_clean_worktree_for_checkpoint: true,
  require_clean_worktree_for_push: true,
  require_clean_worktree_for_rollback: true,
  allow_detached_head: false,
  require_human_approval_for_dangerous: true,
  prohibit_force_push: true,
  allow_history_rewrite: false,
});

export interface CheckpointIntegrityOptions {
  readonly expected_parent_sha?: string | null;
  readonly expected_branch?: string;
  readonly expected_remote?: string;
  readonly require_clean_worktree?: boolean;
  readonly require_remote_verified?: boolean;
  readonly expected_commit_sha?: string;
  readonly expected_remote_head_sha?: string | null;
}

/**
 * Deterministic Git policy validation engine.
 * Pure validation logic separated from execution and state collection.
 * Strictly enforces policy boundaries:
 * - Deterministic risk level evaluation
 * - Prohibits force push unconditionally
 * - Enforces clean working tree where required
 * - Detects detached HEAD, branch mismatch, remote mismatch, and history divergence
 * - Requires verified human authorization for DANGEROUS operations
 * - Validates parent SHA and checkpoint integrity
 */
export class GitPolicyValidator {
  private readonly defaultConfig: GitPolicyConfig;

  constructor(defaultConfig?: Partial<GitPolicyConfig>) {
    this.defaultConfig = Object.freeze({
      ...DEFAULT_GIT_POLICY_CONFIG,
      ...defaultConfig,
      // Force push prohibition is immutable across all configs
      prohibit_force_push: true,
    });
  }

  /**
   * Deterministically returns the policy risk level for an operation type.
   */
  classifyOperation(operation: GitOperationType): RiskLevel {
    return getGitOperationRiskLevel(operation);
  }

  /**
   * Validates whether an intended Git operation is permitted by policy.
   * Does NOT mutate any inputs. Returns a structured GitPolicyDecision.
   */
  validateOperation(
    intent: GitOperationIntent,
    currentState: GitState | null | undefined,
    configOverride?: Partial<GitPolicyConfig>
  ): GitPolicyDecision {
    const evaluatedAt = new Date().toISOString();
    const config: GitPolicyConfig = Object.freeze({
      ...this.defaultConfig,
      ...configOverride,
      prohibit_force_push: true,
    });

    // 1. Missing state information check: Never silently allow when state is missing
    if (currentState === null || currentState === undefined) {
      const riskLevel = intent && intent.operation ? getGitOperationRiskLevel(intent.operation) : RiskLevel.CRITICAL;
      return Object.freeze({
        allowed: false,
        decision: GitPolicyDecisionState.NOT_AUTHORIZED,
        risk_level: riskLevel,
        operation: intent?.operation ?? (GitOpTypes.STATUS_INSPECTION as GitOperationType),
        reasons: Object.freeze(['Current Git state information is missing or null; policy cannot permit operation']),
        requires_human_approval: false,
        violations: Object.freeze([
          {
            code: GitPolicyViolationCode.MISSING_STATE_INFORMATION,
            message: 'Current Git state information is missing or null',
            field: 'currentState',
          },
        ]),
        evaluated_at: evaluatedAt,
      });
    }

    // 2. Intent validation
    if (!intent || !intent.operation || !isGitOperationType(intent.operation)) {
      return Object.freeze({
        allowed: false,
        decision: GitPolicyDecisionState.NOT_AUTHORIZED,
        risk_level: RiskLevel.CRITICAL,
        operation: (intent?.operation as GitOperationType) ?? GitOpTypes.STATUS_INSPECTION,
        reasons: Object.freeze(['Operation intent is invalid or missing']),
        requires_human_approval: false,
        violations: Object.freeze([
          {
            code: GitPolicyViolationCode.MISSING_OPERATION_TYPE,
            message: 'Operation type is missing or unrecognized',
            field: 'operation',
          },
        ]),
        evaluated_at: evaluatedAt,
      });
    }

    const operation = intent.operation;
    const riskLevel = this.classifyOperation(operation);
    const violations: GitPolicyViolation[] = [];
    const reasons: string[] = [];

    // 3. FORCE PUSH & CRITICAL OPERATION PROHIBITION
    if (
      intent.force === true ||
      riskLevel === RiskLevel.CRITICAL ||
      operation === GitOpTypes.FORCE_PUSH ||
      operation === GitOpTypes.DESTRUCTIVE_REMOTE_REWRITE ||
      operation === GitOpTypes.DESTROY_PROJECT_HISTORY
    ) {
      violations.push({
        code: GitPolicyViolationCode.FORCE_PUSH_PROHIBITED,
        message: 'Force push and destructive remote history rewrites are strictly prohibited by policy',
        field: 'force',
        details: { operation, force: intent.force },
      });
      reasons.push('CRITICAL operations and force push are unconditionally disallowed');

      return Object.freeze({
        allowed: false,
        decision: GitPolicyDecisionState.NOT_AUTHORIZED,
        risk_level: RiskLevel.CRITICAL,
        operation,
        reasons: Object.freeze(reasons),
        requires_human_approval: false,
        violations: Object.freeze(violations),
        evaluated_at: evaluatedAt,
      });
    }

    const isSafe = riskLevel === RiskLevel.SAFE;
    const isMutating = !isSafe;

    // 4. DETACHED HEAD CHECK
    const isDetached = currentState.is_detached_head || currentState.status === GitStatus.DETACHED;
    if (isDetached && isMutating && !config.allow_detached_head) {
      violations.push({
        code: GitPolicyViolationCode.DETACHED_HEAD_PROHIBITED,
        message: 'Cannot perform mutating or checkpoint Git operations while in detached HEAD state',
        field: 'is_detached_head',
      });
      reasons.push('Repository is in detached HEAD state');
    }

    // 5. BRANCH MISMATCH CHECK
    const targetBranch = intent.target_branch ?? config.configured_branch;
    if (
      operation === GitOpTypes.PUSH ||
      operation === GitOpTypes.COMMIT ||
      operation === GitOpTypes.PRE_FLIGHT_CHECKPOINT ||
      operation === GitOpTypes.POST_FLIGHT_CHECKPOINT ||
      operation === GitOpTypes.CHECKPOINT_CREATION ||
      operation === GitOpTypes.ROLLBACK_REQUEST ||
      operation === GitOpTypes.ROLLBACK
    ) {
      if (targetBranch !== config.configured_branch) {
        violations.push({
          code: GitPolicyViolationCode.BRANCH_MISMATCH,
          message: `Target branch '${targetBranch}' does not match configured policy branch '${config.configured_branch}'`,
          field: 'target_branch',
          details: { targetBranch, configuredBranch: config.configured_branch },
        });
        reasons.push(`Branch mismatch: target branch is '${targetBranch}', expected '${config.configured_branch}'`);
      }

      if (currentState.current_branch !== null && currentState.current_branch !== config.configured_branch) {
        violations.push({
          code: GitPolicyViolationCode.BRANCH_MISMATCH,
          message: `Current repository branch '${currentState.current_branch}' does not match configured policy branch '${config.configured_branch}'`,
          field: 'current_branch',
          details: { currentBranch: currentState.current_branch, configuredBranch: config.configured_branch },
        });
        reasons.push(`Branch mismatch: current branch is '${currentState.current_branch}', expected '${config.configured_branch}'`);
      }

      if (intent.target_branch && currentState.current_branch !== null && intent.target_branch !== currentState.current_branch) {
        violations.push({
          code: GitPolicyViolationCode.BRANCH_MISMATCH,
          message: `Current repository branch '${currentState.current_branch}' does not match target branch '${intent.target_branch}'`,
          field: 'current_branch',
          details: { currentBranch: currentState.current_branch, targetBranch: intent.target_branch },
        });
        reasons.push(`Branch mismatch: current branch is '${currentState.current_branch}', target is '${intent.target_branch}'`);
      }
    }

    // 6. REMOTE MISMATCH CHECK
    const targetRemote = intent.target_remote ?? config.configured_remote;
    if (operation === GitOpTypes.PUSH || operation === GitOpTypes.REMOTE_VERIFICATION) {
      if (targetRemote !== config.configured_remote) {
        violations.push({
          code: GitPolicyViolationCode.REMOTE_MISMATCH,
          message: `Target remote '${targetRemote}' does not match configured policy remote '${config.configured_remote}'`,
          field: 'target_remote',
          details: { targetRemote, configuredRemote: config.configured_remote },
        });
        reasons.push(`Remote mismatch: target remote is '${targetRemote}', expected '${config.configured_remote}'`);
      }
    }

    // 7. WORKING TREE CLEAN CHECK
    const worktreeIsClean =
      currentState.working_tree_clean &&
      currentState.staged_changes.length === 0 &&
      currentState.unstaged_changes.length === 0 &&
      currentState.untracked_files.length === 0 &&
      currentState.status !== GitStatus.DIRTY;

    if (operation === GitOpTypes.PRE_FLIGHT_CHECKPOINT && config.require_clean_worktree_for_checkpoint) {
      if (!worktreeIsClean) {
        violations.push({
          code: GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED,
          message: 'Pre-flight checkpoint requires a clean working tree; uncommitted changes detected',
          field: 'working_tree_clean',
          details: {
            staged: currentState.staged_changes.length,
            unstaged: currentState.unstaged_changes.length,
            untracked: currentState.untracked_files.length,
          },
        });
        reasons.push('Working tree is dirty; pre-flight checkpoint requires clean working tree');
      }
    }

    if (operation === GitOpTypes.PUSH && config.require_clean_worktree_for_push) {
      if (!worktreeIsClean) {
        violations.push({
          code: GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED,
          message: 'Push operation requires a clean working tree to ensure consistent remote history',
          field: 'working_tree_clean',
        });
        reasons.push('Working tree is dirty; push operation prohibited');
      }
    }

    if (
      (operation === GitOpTypes.ROLLBACK_REQUEST ||
        operation === GitOpTypes.ROLLBACK ||
        operation === GitOpTypes.RESET) &&
      (config.require_clean_worktree_for_rollback ?? true)
    ) {
      if (!worktreeIsClean) {
        violations.push({
          code: GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED,
          message: 'Rollback operation requires a clean working tree; uncommitted changes detected',
          field: 'working_tree_clean',
          details: {
            staged: currentState.staged_changes.length,
            unstaged: currentState.unstaged_changes.length,
            untracked: currentState.untracked_files.length,
          },
        });
        reasons.push('Working tree is dirty; rollback operation requires clean working tree');
      }
    }

    // 8. HISTORY DIVERGENCE DETECTION
    if (operation === GitOpTypes.PUSH) {
      const isDiverged =
        currentState.divergence.diverged ||
        currentState.divergence.behind > 0 ||
        currentState.remote_sync_state === GitRemoteSyncStatus.DIVERGED;

      if (isDiverged) {
        violations.push({
          code: GitPolicyViolationCode.HISTORY_DIVERGENCE_DETECTED,
          message: `Local branch has diverged from or is behind remote (ahead: ${currentState.divergence.ahead}, behind: ${currentState.divergence.behind}). Fast-forward push not possible, force push prohibited.`,
          field: 'divergence',
          details: {
            ahead: currentState.divergence.ahead,
            behind: currentState.divergence.behind,
            syncState: currentState.remote_sync_state,
          },
        });
        reasons.push('History divergence detected between local and remote branch');
      }
    }

    // 9. DANGEROUS OPERATIONS & HUMAN APPROVAL
    let requiresHumanApproval = false;
    if (riskLevel === RiskLevel.DANGEROUS) {
      requiresHumanApproval = true;
      if (config.require_human_approval_for_dangerous) {
        const hasApprovalToken =
          typeof intent.human_approval_token === 'string' && intent.human_approval_token.trim().length > 0;

        let tokenValid = hasApprovalToken;
        let tokenInvalidReason: string | undefined;

        if (hasApprovalToken && config.validateHumanApprovalToken) {
          try {
            const res = config.validateHumanApprovalToken(intent.human_approval_token!.trim());
            if (typeof res === 'boolean') {
              tokenValid = res;
              if (!res) tokenInvalidReason = 'Human approval token is invalid or expired';
            } else if (res && typeof res === 'object') {
              tokenValid = Boolean(res.valid);
              if (!res.valid) tokenInvalidReason = res.reason ?? 'Human approval token is invalid or expired';
            }
          } catch (err) {
            tokenValid = false;
            tokenInvalidReason = err instanceof Error ? err.message : 'Token validation failed';
          }
        }

        if (!hasApprovalToken) {
          violations.push({
            code: GitPolicyViolationCode.HUMAN_APPROVAL_REQUIRED,
            message: `Operation '${operation}' is classified as DANGEROUS and requires human approval token`,
            field: 'human_approval_token',
          });
          reasons.push(`Dangerous operation '${operation}' requires human approval`);
        } else if (!tokenValid) {
          violations.push({
            code: GitPolicyViolationCode.HUMAN_APPROVAL_REQUIRED,
            message: tokenInvalidReason ?? 'Human approval token is invalid or expired',
            field: 'human_approval_token',
          });
          reasons.push('Human approval token validation failed');
        } else {
          reasons.push(`Human approval token verified for dangerous operation '${operation}'`);
        }
      }
    }

    // 10. DECISION RESOLUTION
    const hasViolations = violations.length > 0;
    const humanApprovalNeeded = violations.some(
      (v) => v.code === GitPolicyViolationCode.HUMAN_APPROVAL_REQUIRED
    );

    let decisionState: GitPolicyDecisionState;
    if (!hasViolations) {
      decisionState = GitPolicyDecisionState.AUTHORIZED;
      reasons.push(`Operation '${operation}' authorized under policy`);
    } else if (humanApprovalNeeded && violations.length === 1) {
      decisionState = GitPolicyDecisionState.HUMAN_REQUIRED;
    } else {
      decisionState = GitPolicyDecisionState.NOT_AUTHORIZED;
    }

    return Object.freeze({
      allowed: !hasViolations,
      decision: decisionState,
      risk_level: riskLevel,
      operation,
      reasons: Object.freeze(reasons),
      requires_human_approval: requiresHumanApproval,
      violations: Object.freeze(violations),
      evaluated_at: evaluatedAt,
      metadata: intent.metadata ? Object.freeze({ ...intent.metadata }) : undefined,
    });
  }

  /**
   * Validates the integrity of an existing checkpoint against current Git state and expectations.
   * Detects:
   * - wrong parent SHA
   * - unexpected branch
   * - remote mismatch
   * - dirty worktree when clean is required
   * - detached HEAD
   * - missing commit
   * - remote not containing expected commit
   */
  validateCheckpointIntegrity(
    checkpoint: GitCheckpoint,
    currentState: GitState,
    options?: CheckpointIntegrityOptions
  ): GitPolicyDecision {
    const evaluatedAt = new Date().toISOString();
    const violations: GitPolicyViolation[] = [];
    const reasons: string[] = [];

    // Checkpoint schema validation
    const schemaValidation = validateGitCheckpointSchema(checkpoint);
    if (!schemaValidation.valid) {
      for (const err of schemaValidation.errors) {
        violations.push({
          code: GitPolicyViolationCode.MISSING_COMMIT,
          message: err,
        });
      }
    }

    // State existence
    if (currentState === null || currentState === undefined) {
      return Object.freeze({
        allowed: false,
        decision: GitPolicyDecisionState.NOT_AUTHORIZED,
        risk_level: RiskLevel.CAUTION,
        operation: GitOpTypes.CHECKPOINT_CREATION,
        reasons: Object.freeze(['Current Git state is missing']),
        requires_human_approval: false,
        violations: Object.freeze([
          {
            code: GitPolicyViolationCode.MISSING_STATE_INFORMATION,
            message: 'Current Git state is missing for checkpoint integrity check',
          },
        ]),
        evaluated_at: evaluatedAt,
      });
    }

    // 1. Missing or malformed commit SHA
    if (!isValidCommitSha(checkpoint.commit_sha)) {
      violations.push({
        code: GitPolicyViolationCode.MISSING_COMMIT,
        message: `Checkpoint commit SHA '${checkpoint.commit_sha}' is missing or malformed`,
        field: 'commit_sha',
      });
      reasons.push('Checkpoint commit SHA is missing or invalid');
    }

    if (options?.expected_commit_sha && checkpoint.commit_sha !== options.expected_commit_sha) {
      violations.push({
        code: GitPolicyViolationCode.MISSING_COMMIT,
        message: `Checkpoint commit SHA '${checkpoint.commit_sha}' does not match expected commit SHA '${options.expected_commit_sha}'`,
        field: 'commit_sha',
      });
      reasons.push(`Commit SHA mismatch: expected '${options.expected_commit_sha}', found '${checkpoint.commit_sha}'`);
    }

    // 2. Wrong parent SHA
    if (options?.expected_parent_sha !== undefined && checkpoint.parent_sha !== options.expected_parent_sha) {
      violations.push({
        code: GitPolicyViolationCode.WRONG_PARENT_SHA,
        message: `Checkpoint parent SHA '${checkpoint.parent_sha}' does not match expected parent SHA '${options.expected_parent_sha}'`,
        field: 'parent_sha',
      });
      reasons.push(`Wrong parent SHA: expected '${options.expected_parent_sha}', found '${checkpoint.parent_sha}'`);
    }

    // 3. Unexpected branch
    if (options?.expected_branch && checkpoint.branch !== options.expected_branch) {
      violations.push({
        code: GitPolicyViolationCode.BRANCH_MISMATCH,
        message: `Checkpoint branch '${checkpoint.branch}' does not match expected branch '${options.expected_branch}'`,
        field: 'branch',
      });
      reasons.push(`Checkpoint branch '${checkpoint.branch}' does not match expected branch '${options.expected_branch}'`);
    }

    if (currentState.current_branch && checkpoint.branch !== currentState.current_branch) {
      violations.push({
        code: GitPolicyViolationCode.BRANCH_MISMATCH,
        message: `Checkpoint branch '${checkpoint.branch}' does not match current repository branch '${currentState.current_branch}'`,
        field: 'branch',
      });
      reasons.push(`Checkpoint branch '${checkpoint.branch}' does not match current branch '${currentState.current_branch}'`);
    }

    // 4. Remote mismatch
    if (options?.expected_remote && checkpoint.remote !== options.expected_remote) {
      violations.push({
        code: GitPolicyViolationCode.REMOTE_MISMATCH,
        message: `Checkpoint remote '${checkpoint.remote}' does not match expected remote '${options.expected_remote}'`,
        field: 'remote',
      });
      reasons.push(`Checkpoint remote '${checkpoint.remote}' does not match expected remote '${options.expected_remote}'`);
    }

    // 5. Dirty worktree when clean is required
    const requireClean = options?.require_clean_worktree ?? true;
    if (requireClean) {
      const isTreeClean =
        checkpoint.working_tree_clean &&
        currentState.working_tree_clean &&
        currentState.status !== GitStatus.DIRTY;

      if (!isTreeClean) {
        violations.push({
          code: GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED,
          message: 'Working tree is dirty; checkpoint integrity requires a clean working tree',
          field: 'working_tree_clean',
        });
        reasons.push('Working tree is dirty during checkpoint integrity validation');
      }
    }

    // 6. Detached HEAD
    if (currentState.is_detached_head || currentState.status === GitStatus.DETACHED) {
      violations.push({
        code: GitPolicyViolationCode.DETACHED_HEAD_PROHIBITED,
        message: 'Current Git state is detached HEAD; checkpoint cannot be validated in detached state',
        field: 'is_detached_head',
      });
      reasons.push('Repository is in detached HEAD state');
    }

    // 7. Remote verification failure
    if (options?.require_remote_verified && !checkpoint.remote_verified) {
      violations.push({
        code: GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED,
        message: 'Checkpoint commit has not been verified on remote repository',
        field: 'remote_verified',
      });
      reasons.push('Remote repository does not contain verified checkpoint commit');
    }

    if (
      options?.expected_remote_head_sha &&
      currentState.remote_head_sha &&
      currentState.remote_head_sha !== checkpoint.commit_sha
    ) {
      violations.push({
        code: GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED,
        message: `Remote HEAD SHA '${currentState.remote_head_sha}' does not match checkpoint commit SHA '${checkpoint.commit_sha}'`,
        field: 'remote_head_sha',
      });
      reasons.push(`Remote HEAD SHA '${currentState.remote_head_sha}' does not match checkpoint commit SHA '${checkpoint.commit_sha}'`);
    }

    const hasViolations = violations.length > 0;
    if (!hasViolations) {
      reasons.push('Checkpoint integrity successfully verified');
    }

    return Object.freeze({
      allowed: !hasViolations,
      decision: hasViolations ? GitPolicyDecisionState.NOT_AUTHORIZED : GitPolicyDecisionState.AUTHORIZED,
      risk_level: checkpoint.policy_level ?? RiskLevel.CAUTION,
      operation: GitOpTypes.CHECKPOINT_CREATION,
      reasons: Object.freeze(reasons),
      requires_human_approval: false,
      violations: Object.freeze(violations),
      evaluated_at: evaluatedAt,
    });
  }
}
