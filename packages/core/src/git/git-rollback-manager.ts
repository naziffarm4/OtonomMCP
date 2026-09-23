import { RiskLevel, isRiskLevel } from '../risk.js';
import {
  type GitState,
  type GitOperationIntent,
  type GitPolicyDecision,
  type GitExecutionResult,
  type GitCheckpoint,
  type GitRollbackResult,
  type RollbackOptions,
  type GitPolicyViolation,
  GitOperationType,
  GitRollbackStage,
  GitRollbackStatus,
  GitPolicyDecisionState,
  GitStatus,
  GitRemoteSyncStatus,
  GitPolicyViolationCode,
} from './git-types.js';
import { type GitPort, type RemoteVerificationResult } from './git-port.js';
import {
  GitPolicyValidator,
  type GitPolicyConfig,
  DEFAULT_GIT_POLICY_CONFIG,
} from './git-policy-validator.js';
import {
  validateGitCheckpointSchema,
  isValidCommitSha,
} from './git-checkpoint-factory.js';
import { type GitCheckpointManager } from './git-checkpoint-manager.js';
import {
  GitPolicyError,
  GitForcePushProhibitedError,
  GitCheckpointIntegrityError,
  GitDirtyWorktreeError,
  GitDetachedHeadError,
  GitBranchMismatchError,
  GitRemoteMismatchError,
  GitParentMismatchError,
  GitRollbackError,
  GitRollbackAuthorizationError,
  GitRollbackVerificationError,
  GitRollbackExecutionError,
  GitCheckpointNotFoundError,
  GitCheckpointNotKnownGoodError,
  GitTargetCommitMissingError,
} from '../errors/git-policy-error.js';

export interface GitRollbackManagerOptions {
  readonly policyValidator?: GitPolicyValidator;
  readonly policyConfig?: Partial<GitPolicyConfig>;
  readonly defaultWorkingDirectory?: string;
  readonly checkpointManager?: GitCheckpointManager;
}

/**
 * Provider-neutral production Git recovery and rollback manager.
 * Orchestrates atomic rollback to a known-good checkpoint through the
 * P6-01 policy boundary without bypassing GitPolicyValidator or duplicating policy logic.
 *
 * Core Guarantees:
 * - Depends solely on GitPort abstraction (zero process / shell dependencies)
 * - Treats rollback as a strictly DANGEROUS operation requiring verified human authorization
 * - Prohibits force-push, destructive remote rewrites, and uncommitted data loss unconditionally
 * - Enforces pre-flight workspace cleanliness; rejects dirty worktrees
 * - Verifies target commit existence, branch compatibility, and checkpoint provenance
 * - Performs post-rollback verification of HEAD, branch, working tree, and parent relationship
 * - Clearly distinguishes requested, authorized, executed, verified, and failed states
 * - Returns structured immutable GitRollbackResult without exposing secrets or authorization tokens
 */
export class GitRollbackManager {
  readonly gitPort: GitPort;
  readonly policyValidator: GitPolicyValidator;
  readonly policyConfig: GitPolicyConfig;
  readonly defaultWorkingDirectory: string;
  readonly checkpointManager?: GitCheckpointManager;

  constructor(
    gitPort: GitPort,
    optionsOrValidator?: GitRollbackManagerOptions | GitPolicyValidator
  ) {
    if (!gitPort) {
      throw new Error('gitPort is required for GitRollbackManager');
    }
    this.gitPort = gitPort;

    if (optionsOrValidator instanceof GitPolicyValidator) {
      this.policyValidator = optionsOrValidator;
      this.policyConfig = DEFAULT_GIT_POLICY_CONFIG;
      this.defaultWorkingDirectory = process.cwd();
    } else {
      this.policyValidator =
        optionsOrValidator?.policyValidator ??
        new GitPolicyValidator(optionsOrValidator?.policyConfig);
      this.policyConfig = Object.freeze({
        ...DEFAULT_GIT_POLICY_CONFIG,
        ...optionsOrValidator?.policyConfig,
        prohibit_force_push: true,
      });
      this.defaultWorkingDirectory =
        optionsOrValidator?.defaultWorkingDirectory ?? process.cwd();
      this.checkpointManager = optionsOrValidator?.checkpointManager;
    }
  }

  /**
   * Performs an atomic recovery rollback to an exact known-good checkpoint.
   *
   * Architectural flow:
   * 1. Resolve target checkpoint (from object or manager lookup)
   * 2. Validate checkpoint schema, commit SHA, and known-good status
   * 3. Observe current repository state via GitPort.inspectState
   * 4. Enforce worktree safety (reject dirty worktree, detached HEAD, branch mismatch)
   * 5. Verify target commit exists in repository object database
   * 6. Authorize DANGEROUS operation with human authorization token via GitPolicyValidator
   * 7. Execute authorized rollback via GitPort.executeAuthorizedOperation
   * 8. Observe and verify resulting Git state (HEAD, branch, worktree, parent)
   * 9. Verify remote status safely without destructive remote rewrite
   * 10. Return structured, immutable GitRollbackResult (sanitized of tokens/secrets)
   */
  async rollbackToCheckpoint(
    checkpointOrIdOrOptions: GitCheckpoint | string | RollbackOptions,
    explicitOptions?: RollbackOptions
  ): Promise<GitRollbackResult> {
    // 0. Normalize parameters
    let targetCheckpointInput: GitCheckpoint | string | undefined;
    let opts: RollbackOptions;

    if (
      typeof checkpointOrIdOrOptions === 'object' &&
      checkpointOrIdOrOptions !== null &&
      !('commit_sha' in checkpointOrIdOrOptions) &&
      !('commitSha' in checkpointOrIdOrOptions) &&
      ('checkpoint' in checkpointOrIdOrOptions ||
        'human_approval_token' in checkpointOrIdOrOptions ||
        'humanApprovalToken' in checkpointOrIdOrOptions)
    ) {
      opts = checkpointOrIdOrOptions as RollbackOptions;
      targetCheckpointInput = opts.checkpoint;
    } else {
      targetCheckpointInput = checkpointOrIdOrOptions as GitCheckpoint | string;
      opts = explicitOptions ?? {};
    }

    const shouldThrow = Boolean(opts.throw_on_error ?? opts.throwOnError);
    const workingDir =
      opts.working_directory ?? opts.workingDirectory ?? this.defaultWorkingDirectory;
    const humanApprovalToken =
      opts.human_approval_token ?? opts.humanApprovalToken ?? null;

    let currentStage: GitRollbackStage = GitRollbackStage.REQUESTED;
    let currentStatus: GitRollbackStatus = GitRollbackStatus.REQUESTED;
    let executionStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' = 'NOT_STARTED';
    let verificationStatus: 'NOT_VERIFIED' | 'VERIFIED' | 'FAILED' = 'NOT_VERIFIED';
    let requiresReconciliation = false;

    // Helper to assemble sanitized, immutable failure result
    const buildFailureResult = (
      code: string,
      message: string,
      details?: {
        checkpointId?: string;
        taskId?: string | null;
        targetCommitSha?: string;
        prevHead?: string | null;
        prevBranch?: string | null;
        resultingHead?: string | null;
        resultingBranch?: string | null;
        decision?: GitPolicyDecision;
        execResult?: GitExecutionResult;
        stateBefore?: GitState;
        stateAfter?: GitState;
      }
    ): GitRollbackResult => {
      return Object.freeze({
        success: false,
        stage: currentStage,
        status: GitRollbackStatus.FAILED,
        checkpoint_id: details?.checkpointId ?? (typeof targetCheckpointInput === 'string' ? targetCheckpointInput : ''),
        task_id: details?.taskId ?? null,
        target_commit_sha: details?.targetCommitSha ?? '',
        previous_head_sha: details?.prevHead ?? null,
        resulting_head_sha: details?.resultingHead ?? null,
        previous_branch: details?.prevBranch ?? null,
        resulting_branch: details?.resultingBranch ?? null,
        authorization_status: details?.decision?.decision ?? GitPolicyDecisionState.NOT_AUTHORIZED,
        execution_status: executionStatus,
        verification_status: verificationStatus,
        remote_verification_status: 'NOT_APPLICABLE',
        error: message,
        failure_code: code,
        policy_decision: details?.decision,
        execution_result: details?.execResult,
        observed_state_before: details?.stateBefore,
        observed_state_after: details?.stateAfter,
        requires_reconciliation: requiresReconciliation,
        completed_at: new Date().toISOString(),

        // Aliases
        checkpointId: details?.checkpointId ?? (typeof targetCheckpointInput === 'string' ? targetCheckpointInput : ''),
        taskId: details?.taskId ?? null,
        targetCommitSha: details?.targetCommitSha ?? '',
        previousHeadSha: details?.prevHead ?? null,
        resultingHeadSha: details?.resultingHead ?? null,
        previousBranch: details?.prevBranch ?? null,
        resultingBranch: details?.resultingBranch ?? null,
        authorizationStatus: details?.decision?.decision ?? GitPolicyDecisionState.NOT_AUTHORIZED,
        executionStatus,
        verificationStatus,
        remoteVerificationStatus: 'NOT_APPLICABLE',
        failureCode: code,
        requiresReconciliation,
      });
    };

    // 1. Resolve target checkpoint
    if (!targetCheckpointInput) {
      const msg = 'Rollback target checkpoint or checkpoint ID is required';
      if (shouldThrow) {
        throw new GitCheckpointNotFoundError(msg, { violations: [{ code: 'MISSING_CHECKPOINT', message: msg }] });
      }
      return buildFailureResult('MISSING_CHECKPOINT', msg);
    }

    let checkpoint: GitCheckpoint;
    if (typeof targetCheckpointInput === 'string') {
      const id = targetCheckpointInput.trim();
      const resolved = this.checkpointManager?.getCheckpoint(id);
      if (!resolved) {
        const msg = `Target checkpoint with ID '${id}' not found in manager registry`;
        if (shouldThrow) {
          throw new GitCheckpointNotFoundError(msg, { checkpointId: id });
        }
        return buildFailureResult('CHECKPOINT_NOT_FOUND', msg, { checkpointId: id });
      }
      checkpoint = resolved;
    } else {
      checkpoint = targetCheckpointInput;
    }

    const checkpointId = checkpoint.checkpoint_id ?? checkpoint.checkpointId ?? '';
    const taskId = checkpoint.task_id ?? checkpoint.taskId ?? null;
    const targetCommitSha = checkpoint.commit_sha ?? checkpoint.commitSha ?? '';
    const checkpointBranch = checkpoint.branch ?? '';

    // 2. Validate commit SHA format
    if (!isValidCommitSha(targetCommitSha)) {
      const msg = `Target checkpoint commit SHA '${targetCommitSha}' is invalid`;
      if (shouldThrow) {
        throw new GitCheckpointIntegrityError(msg, {
          checkpointId,
          commitSha: targetCommitSha,
          violations: [{ code: 'INVALID_COMMIT_SHA', message: msg, field: 'commit_sha' }],
        });
      }
      return buildFailureResult('INVALID_COMMIT_SHA', msg, { checkpointId, taskId, targetCommitSha });
    }

    // 3. Validate checkpoint schema
    const schemaValidation = validateGitCheckpointSchema(checkpoint);
    if (!schemaValidation.valid) {
      const msg = `Invalid checkpoint schema: ${schemaValidation.errors.join('; ')}`;
      if (shouldThrow) {
        throw new GitCheckpointIntegrityError(msg, {
          checkpointId,
          commitSha: targetCommitSha,
          violations: schemaValidation.errors.map((e) => ({ code: 'INVALID_SCHEMA', message: e })),
        });
      }
      return buildFailureResult('INVALID_CHECKPOINT_SCHEMA', msg, { checkpointId, taskId, targetCommitSha });
    }

    // Expected commit SHA check
    const expectedCommitSha = opts.expected_commit_sha ?? opts.expectedCommitSha;
    if (expectedCommitSha && targetCommitSha !== expectedCommitSha) {
      const msg = `Checkpoint commit SHA '${targetCommitSha}' does not match expected commit SHA '${expectedCommitSha}'`;
      if (shouldThrow) {
        throw new GitCheckpointIntegrityError(msg, {
          checkpointId,
          commitSha: targetCommitSha,
          violations: [{ code: 'COMMIT_SHA_MISMATCH', message: msg, field: 'commit_sha' }],
        });
      }
      return buildFailureResult('COMMIT_SHA_MISMATCH', msg, { checkpointId, taskId, targetCommitSha });
    }

    // 4. Validate known-good status
    const requireKnownGood = opts.require_known_good ?? opts.requireKnownGood ?? true;
    if (requireKnownGood) {
      const isKnownGood =
        (checkpoint as { is_known_good?: boolean }).is_known_good === true ||
        (checkpoint as { isKnownGood?: boolean }).isKnownGood === true;

      if (!isKnownGood) {
        const msg = `Checkpoint '${checkpointId}' is not verified known-good; rollback requires a verified known-good checkpoint`;
        if (shouldThrow) {
          throw new GitCheckpointNotKnownGoodError(msg, {
            checkpointId,
            commitSha: targetCommitSha,
            violations: [{ code: 'CHECKPOINT_NOT_KNOWN_GOOD', message: msg }],
          });
        }
        return buildFailureResult('CHECKPOINT_NOT_KNOWN_GOOD', msg, { checkpointId, taskId, targetCommitSha });
      }
    }

    // Expected parent SHA check
    const expectedParentSha = opts.expected_parent_sha ?? opts.expectedParentSha;
    if (expectedParentSha !== undefined && checkpoint.parent_sha !== expectedParentSha) {
      const msg = `Checkpoint parent SHA '${checkpoint.parent_sha}' does not match expected parent SHA '${expectedParentSha}'`;
      if (shouldThrow) {
        throw new GitParentMismatchError(msg, {
          checkpointId,
          commitSha: targetCommitSha,
          parentSha: checkpoint.parent_sha,
          violations: [{ code: GitPolicyViolationCode.WRONG_PARENT_SHA, message: msg, field: 'parent_sha' }],
        });
      }
      return buildFailureResult('WRONG_PARENT_SHA', msg, { checkpointId, taskId, targetCommitSha });
    }

    // 5. Verify target commit exists in repository object database
    if (this.gitPort.checkCommitExists) {
      const commitExists = await this.gitPort.checkCommitExists(workingDir, targetCommitSha);
      if (!commitExists) {
        const msg = `Target commit '${targetCommitSha}' does not exist in repository object database`;
        if (shouldThrow) {
          throw new GitTargetCommitMissingError(msg, {
            checkpointId,
            commitSha: targetCommitSha,
            violations: [{ code: GitPolicyViolationCode.MISSING_COMMIT, message: msg, field: 'commit_sha' }],
          });
        }
        return buildFailureResult('TARGET_COMMIT_MISSING', msg, { checkpointId, taskId, targetCommitSha });
      }
    }

    // 6. Observe current Git repository state before rollback
    const stateBefore = await this.gitPort.inspectState(workingDir);
    if (!stateBefore || stateBefore.isRepository === false) {
      const msg = 'Repository state cannot be observed or target is not a valid Git repository';
      if (shouldThrow) {
        throw new GitPolicyError(msg, 'ERR_GIT_INVALID_STATE', { operation: GitOperationType.ROLLBACK_REQUEST });
      }
      return buildFailureResult('ERR_GIT_INVALID_STATE', msg, { checkpointId, taskId, targetCommitSha });
    }

    const prevHead = (stateBefore.head_sha ?? stateBefore.currentHead ?? null) as string | null;
    const prevBranch = (stateBefore.current_branch ?? null) as string | null;

    // 7. Worktree Safety: Enforce clean worktree & reject detached HEAD & branch mismatch
    const isDetached = stateBefore.is_detached_head || stateBefore.status === GitStatus.DETACHED;
    if (isDetached && !this.policyConfig.allow_detached_head) {
      const msg = 'Cannot perform rollback in detached HEAD state';
      if (shouldThrow) {
        throw new GitDetachedHeadError(msg, {
          operation: GitOperationType.ROLLBACK_REQUEST,
          currentBranch: prevBranch,
          checkpointId,
          commitSha: targetCommitSha,
          violations: [{ code: GitPolicyViolationCode.DETACHED_HEAD_PROHIBITED, message: msg, field: 'is_detached_head' }],
        });
      }
      return buildFailureResult('DETACHED_HEAD_PROHIBITED', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        stateBefore,
      });
    }

    // Check branch compatibility
    const expectedBranch = opts.expected_branch ?? opts.expectedBranch ?? this.policyConfig.configured_branch;
    if (expectedBranch && checkpointBranch !== expectedBranch) {
      const msg = `Checkpoint branch '${checkpointBranch}' does not match expected branch '${expectedBranch}'`;
      if (shouldThrow) {
        throw new GitBranchMismatchError(msg, {
          operation: GitOperationType.ROLLBACK_REQUEST,
          currentBranch: prevBranch,
          configuredBranch: expectedBranch,
          checkpointId,
          violations: [{ code: GitPolicyViolationCode.BRANCH_MISMATCH, message: msg, field: 'branch' }],
        });
      }
      return buildFailureResult('BRANCH_MISMATCH', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        stateBefore,
      });
    }

    if (prevBranch !== null && prevBranch !== checkpointBranch) {
      const msg = `Current repository branch '${prevBranch}' does not match checkpoint branch '${checkpointBranch}'`;
      if (shouldThrow) {
        throw new GitBranchMismatchError(msg, {
          operation: GitOperationType.ROLLBACK_REQUEST,
          currentBranch: prevBranch,
          configuredBranch: checkpointBranch,
          checkpointId,
          violations: [{ code: GitPolicyViolationCode.BRANCH_MISMATCH, message: msg, field: 'current_branch' }],
        });
      }
      return buildFailureResult('BRANCH_MISMATCH', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        stateBefore,
      });
    }

    // Clean worktree check: Do NOT silently destroy dirty changes
    const hasUnstaged = stateBefore.unstaged_changes.length > 0 || (stateBefore.unstagedFiles && stateBefore.unstagedFiles.length > 0);
    const hasStaged = stateBefore.staged_changes.length > 0 || (stateBefore.stagedFiles && stateBefore.stagedFiles.length > 0);
    const hasUntracked = stateBefore.untracked_files.length > 0 || (stateBefore.untrackedFiles && stateBefore.untrackedFiles.length > 0);
    const worktreeIsClean = stateBefore.working_tree_clean && stateBefore.status !== GitStatus.DIRTY && !hasUnstaged && !hasStaged && !hasUntracked;

    if (!worktreeIsClean) {
      const msg = 'Cannot perform rollback: working tree is dirty; uncommitted changes detected';
      if (shouldThrow) {
        throw new GitDirtyWorktreeError(msg, {
          operation: GitOperationType.ROLLBACK_REQUEST,
          checkpointId,
          violations: [
            {
              code: GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED,
              message: msg,
              field: 'working_tree_clean',
              details: {
                staged: stateBefore.staged_changes.length,
                unstaged: stateBefore.unstaged_changes.length,
                untracked: stateBefore.untracked_files.length,
              },
            },
          ],
        });
      }
      return buildFailureResult('DIRTY_WORKTREE_PROHIBITED', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        stateBefore,
      });
    }

    // 8. Construct operation intent & validate policy authorization
    const intent: GitOperationIntent = Object.freeze({
      operation: GitOperationType.ROLLBACK_REQUEST,
      checkpoint_id: checkpointId,
      task_id: taskId,
      phase: checkpoint.phase ?? 'PHASE_6',
      purpose: checkpoint.purpose,
      target_branch: checkpointBranch,
      target_remote: checkpoint.remote ?? this.policyConfig.configured_remote,
      expected_commit_sha: targetCommitSha,
      expected_parent_sha: checkpoint.parent_sha,
      force: false, // Strict prohibition: force is unconditionally false
      human_approval_token: humanApprovalToken,
      metadata: opts.metadata ? Object.freeze({ ...opts.metadata }) : undefined,
    });

    const policyDecision = this.policyValidator.validateOperation(
      intent,
      stateBefore,
      this.policyConfig
    );

    if (!policyDecision.allowed) {
      const isAuthViolation = policyDecision.violations.some(
        (v) => v.code === GitPolicyViolationCode.HUMAN_APPROVAL_REQUIRED
      );
      const isForcePush = policyDecision.violations.some(
        (v) => v.code === GitPolicyViolationCode.FORCE_PUSH_PROHIBITED
      );

      const errorMsg = isAuthViolation
        ? 'Rollback operation requires a valid human authorization token'
        : `Rollback rejected by policy: ${policyDecision.reasons.join('; ')}`;

      if (shouldThrow) {
        if (isForcePush) {
          throw new GitForcePushProhibitedError(errorMsg, {
            operation: intent.operation,
            riskLevel: policyDecision.risk_level,
            checkpointId,
          });
        }
        if (isAuthViolation) {
          throw new GitRollbackAuthorizationError(errorMsg, {
            operation: intent.operation,
            riskLevel: policyDecision.risk_level,
            checkpointId,
            commitSha: targetCommitSha,
            violations: policyDecision.violations,
          });
        }
        throw new GitPolicyError(errorMsg, 'ERR_GIT_OPERATION_NOT_AUTHORIZED', {
          operation: intent.operation,
          riskLevel: policyDecision.risk_level,
          violations: policyDecision.violations,
        });
      }

      return buildFailureResult(
        isAuthViolation ? 'HUMAN_APPROVAL_REQUIRED' : 'POLICY_REJECTED',
        errorMsg,
        {
          checkpointId,
          taskId,
          targetCommitSha,
          prevHead,
          prevBranch,
          decision: policyDecision,
          stateBefore,
        }
      );
    }

    currentStage = GitRollbackStage.AUTHORIZATION_VALIDATED;
    currentStatus = GitRollbackStatus.AUTHORIZED;

    // 9. Execute rollback through GitPort abstraction
    currentStage = GitRollbackStage.EXECUTION_STARTED;
    executionStatus = 'IN_PROGRESS';

    let executionResult: GitExecutionResult;
    try {
      executionResult = await this.gitPort.executeAuthorizedOperation(
        intent,
        policyDecision,
        workingDir
      );
    } catch (err) {
      // Execution failed halfway through -> repository may require reconciliation!
      requiresReconciliation = true;
      executionStatus = 'FAILED';
      currentStage = GitRollbackStage.FAILED;
      currentStatus = GitRollbackStatus.FAILED;

      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = `Rollback execution failed: ${rawMsg}`;

      if (shouldThrow) {
        throw new GitRollbackExecutionError(msg, {
          operation: intent.operation,
          riskLevel: policyDecision.risk_level,
          checkpointId,
          commitSha: targetCommitSha,
        });
      }

      return buildFailureResult('ROLLBACK_EXECUTION_FAILURE', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        decision: policyDecision,
        stateBefore,
      });
    }

    if (!executionResult.success) {
      requiresReconciliation = true;
      executionStatus = 'FAILED';
      currentStage = GitRollbackStage.FAILED;
      currentStatus = GitRollbackStatus.FAILED;

      const msg = `Rollback execution failed: ${executionResult.error ?? 'unknown execution error'}`;
      if (shouldThrow) {
        throw new GitRollbackExecutionError(msg, {
          operation: intent.operation,
          riskLevel: policyDecision.risk_level,
          checkpointId,
          commitSha: targetCommitSha,
        });
      }

      return buildFailureResult('ROLLBACK_EXECUTION_FAILURE', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        decision: policyDecision,
        execResult: executionResult,
        stateBefore,
      });
    }

    currentStage = GitRollbackStage.EXECUTION_COMPLETED;
    currentStatus = GitRollbackStatus.EXECUTED;
    executionStatus = 'COMPLETED';

    // 10. Post-rollback repository state observation & verification
    const stateAfter = await this.gitPort.inspectState(workingDir);
    const resultingHead = stateAfter?.head_sha ?? stateAfter?.currentHead ?? null;
    const resultingBranch = stateAfter?.current_branch ?? null;

    const verificationErrors: string[] = [];

    // Verify HEAD matches target checkpoint commit
    if (resultingHead !== targetCommitSha) {
      verificationErrors.push(
        `Post-rollback HEAD '${resultingHead}' does not match checkpoint commit SHA '${targetCommitSha}'`
      );
    }

    // Verify branch matches checkpoint branch
    if (resultingBranch !== checkpointBranch) {
      verificationErrors.push(
        `Post-rollback branch '${resultingBranch}' does not match checkpoint branch '${checkpointBranch}'`
      );
    }

    // Verify repository is not in detached HEAD state
    if (stateAfter.is_detached_head || stateAfter.status === GitStatus.DETACHED) {
      verificationErrors.push('Repository is in detached HEAD state following rollback');
    }

    // Verify target commit exists in post-rollback repository
    if (this.gitPort.checkCommitExists && resultingHead) {
      const commitStillExists = await this.gitPort.checkCommitExists(workingDir, resultingHead);
      if (!commitStillExists) {
        verificationErrors.push(`Target commit '${resultingHead}' cannot be found in repository after rollback`);
      }
    }

    // Verify parent relationship integrity
    if (
      checkpoint.parent_sha !== null &&
      stateAfter.parent_sha !== undefined &&
      stateAfter.parent_sha !== null &&
      stateAfter.parent_sha !== checkpoint.parent_sha
    ) {
      verificationErrors.push(
        `Post-rollback parent SHA '${stateAfter.parent_sha}' does not match checkpoint parent SHA '${checkpoint.parent_sha}'`
      );
    }

    // Verify working tree is clean post-rollback
    const cleanPostRollback =
      stateAfter.working_tree_clean &&
      stateAfter.staged_changes.length === 0 &&
      stateAfter.unstaged_changes.length === 0 &&
      stateAfter.untracked_files.length === 0;

    if (!cleanPostRollback) {
      verificationErrors.push('Working tree is not clean after rollback execution');
    }

    // 11. Remote safety verification (read-only, zero destructive synchronization)
    let remoteStatus:
      | GitRemoteSyncStatus
      | 'VERIFIED'
      | 'UNVERIFIED'
      | 'DIVERGED'
      | 'UNKNOWN'
      | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';

    const shouldVerifyRemote = Boolean(opts.verify_remote ?? opts.verifyRemote);
    if (shouldVerifyRemote) {
      const remote = checkpoint.remote ?? this.policyConfig.configured_remote ?? 'origin';
      const remoteResult: RemoteVerificationResult = await this.gitPort.verifyRemote(
        workingDir,
        remote,
        checkpointBranch,
        targetCommitSha
      );

      if (remoteResult.verified && remoteResult.remoteHeadSha === targetCommitSha) {
        remoteStatus = 'VERIFIED';
      } else if (stateAfter.remote_sync_state) {
        remoteStatus = stateAfter.remote_sync_state;
      } else {
        remoteStatus = remoteResult.remoteHeadSha !== targetCommitSha ? 'DIVERGED' : 'UNKNOWN';
      }
    }

    // Handle verification failures: never report success on partial or failed verification
    if (verificationErrors.length > 0) {
      requiresReconciliation = true;
      verificationStatus = 'FAILED';
      currentStage = GitRollbackStage.FAILED;
      currentStatus = GitRollbackStatus.FAILED;

      const msg = `Post-rollback verification failed: ${verificationErrors.join('; ')}`;
      if (shouldThrow) {
        throw new GitRollbackVerificationError(msg, {
          operation: intent.operation,
          riskLevel: policyDecision.risk_level,
          checkpointId,
          commitSha: targetCommitSha,
          currentBranch: resultingBranch,
          configuredBranch: checkpointBranch,
          violations: verificationErrors.map((e) => ({ code: 'VERIFICATION_FAILURE', message: e })),
        });
      }

      return buildFailureResult('ROLLBACK_VERIFICATION_FAILURE', msg, {
        checkpointId,
        taskId,
        targetCommitSha,
        prevHead,
        prevBranch,
        resultingHead,
        resultingBranch,
        decision: policyDecision,
        execResult: executionResult,
        stateBefore,
        stateAfter,
      });
    }

    currentStage = GitRollbackStage.VERIFICATION_COMPLETED;
    currentStatus = GitRollbackStatus.VERIFIED;
    verificationStatus = 'VERIFIED';

    // 12. Build and return structured, immutable recovery result
    return Object.freeze({
      success: true,
      stage: GitRollbackStage.COMPLETED,
      status: GitRollbackStatus.VERIFIED,
      checkpoint_id: checkpointId,
      task_id: taskId,
      target_commit_sha: targetCommitSha,
      previous_head_sha: prevHead,
      resulting_head_sha: resultingHead,
      previous_branch: prevBranch,
      resulting_branch: resultingBranch,
      authorization_status: policyDecision.decision,
      execution_status: executionStatus,
      verification_status: verificationStatus,
      remote_verification_status: remoteStatus,
      policy_decision: policyDecision,
      execution_result: executionResult,
      observed_state_before: stateBefore,
      observed_state_after: stateAfter,
      requires_reconciliation: false,
      completed_at: new Date().toISOString(),

      // Aliases
      checkpointId,
      taskId,
      targetCommitSha,
      previousHeadSha: prevHead,
      resultingHeadSha: resultingHead,
      previousBranch: prevBranch,
      resultingBranch,
      authorizationStatus: policyDecision.decision,
      executionStatus,
      verificationStatus,
      remoteVerificationStatus: remoteStatus,
      requiresReconciliation: false,
    });
  }
}
