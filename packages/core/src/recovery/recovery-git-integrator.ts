import type { RecoveryResult, DeterministicDecisionData } from './types.js';
import { RecoveryDecision } from './types.js';
import type { RecoveryEngine } from './recovery-engine.js';
import type {
  GitCheckpoint,
  GitRollbackResult,
  RollbackOptions,
} from '../git/git-types.js';
import type { GitCheckpointManager, KnownGoodCheckpoint } from '../git/git-checkpoint-manager.js';
import type { GitRollbackManager } from '../git/git-rollback-manager.js';
import {
  GitCheckpointNotFoundError,
  GitCheckpointNotKnownGoodError,
} from '../errors/git-policy-error.js';

// ============================================================================
// 1. CONTRACTS & INTERFACES
// ============================================================================

/**
 * Configuration options for recovery-initiated rollback operations.
 */
export interface RecoveryRollbackOptions {
  /**
   * Verified human authorization token required for executing the DANGEROUS rollback operation.
   * STRICTLY CONFIDENTIAL: Never logged, persisted, or included in results/errors.
   */
  readonly human_approval_token?: string | null;
  readonly humanApprovalToken?: string | null;

  /**
   * Working directory override for git operations.
   */
  readonly working_directory?: string;
  readonly workingDirectory?: string;

  /**
   * Whether to verify remote state post-rollback (safe read-only inspection, zero mutation).
   */
  readonly verify_remote?: boolean;
  readonly verifyRemote?: boolean;

  /**
   * When true, throws structured GitPolicyError / GitRollbackError / GitCheckpointIntegrityError on failure.
   * When false (default), returns structured failure result.
   */
  readonly throw_on_error?: boolean;
  readonly throwOnError?: boolean;

  /**
   * Expected branch name.
   */
  readonly expected_branch?: string;
  readonly expectedBranch?: string;

  /**
   * Expected parent SHA.
   */
  readonly expected_parent_sha?: string | null;
  readonly expectedParentSha?: string | null;

  /**
   * Explicit flag to allow rollback on RETRY decisions if ever required.
   * Default: false (RETRY preserves existing non-rollback semantics).
   */
  readonly allowRetryRollback?: boolean;

  /**
   * Optional custom metadata (must not contain secrets).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Structured, immutable result returned by the Recovery-to-Git Rollback Integration boundary.
 * Exposes previous HEAD and resulting HEAD through GitRollbackResult without inventing redundant models.
 */
export interface RecoveryRollbackIntegrationResult {
  /**
   * Overall success status of the integration operation.
   */
  readonly success: boolean;

  /**
   * Authoritative recovery decision evaluated by Phase 1.
   */
  readonly recoveryDecision: RecoveryDecision;

  /**
   * Whether a physical Git rollback was executed.
   */
  readonly rollbackExecuted: boolean;

  /**
   * Checkpoint identifier if rollback was attempted or executed.
   */
  readonly checkpointId?: string | null;

  /**
   * Target commit SHA if rollback was attempted or executed.
   */
  readonly targetCommitSha?: string | null;

  /**
   * Commit SHA of HEAD prior to rollback (from GitRollbackResult).
   */
  readonly previousHeadSha?: string | null;

  /**
   * Resulting commit SHA of HEAD after rollback (from GitRollbackResult).
   */
  readonly resultingHeadSha?: string | null;

  /**
   * Full, immutable GitRollbackResult produced by GitRollbackManager when rollback was executed.
   */
  readonly rollbackResult?: GitRollbackResult | null;

  /**
   * Human-readable error message upon failure.
   */
  readonly error?: string | null;

  /**
   * Machine-readable error / failure code.
   */
  readonly failureCode?: string | null;

  /**
   * Whether workspace requires reconciliation after partial or failed execution.
   */
  readonly requiresReconciliation?: boolean;

  // Snake_case aliases for contract consistency
  readonly recovery_decision?: RecoveryDecision;
  readonly rollback_executed?: boolean;
  readonly checkpoint_id?: string | null;
  readonly target_commit_sha?: string | null;
  readonly previous_head_sha?: string | null;
  readonly resulting_head_sha?: string | null;
  readonly rollback_result?: GitRollbackResult | null;
  readonly failure_code?: string | null;
  readonly requires_reconciliation?: boolean;
}

/**
 * Options for initializing the RecoveryGitRollbackIntegrator.
 */
export interface RecoveryGitIntegratorOptions {
  readonly checkpointManager: GitCheckpointManager;
  readonly rollbackManager?: GitRollbackManager;
  readonly defaultWorkingDirectory?: string;
}

// ============================================================================
// 2. RECOVERY GIT ROLLBACK INTEGRATOR IMPLEMENTATION
// ============================================================================

/**
 * Production integration boundary between Phase 1 Recovery/Reconciliation and Phase 6 Git Rollback.
 *
 * Responsibilities:
 * - Preserves Phase 1 recovery decision authority (RESUME, RETRY, RESTART)
 * - Uses recovery-selected checkpoint reference without inventing arbitrary SHAs
 * - Verifies target checkpoint is a registered, verified known-good checkpoint
 * - Validates Git rollback policy and enforces human authorization token requirement
 * - Protects against dirty worktrees, detached HEAD, force push, and destructive remote rewrites
 * - Delegates physical rollback execution to GitRollbackManager
 * - Surfaces post-rollback verification and structured recovery results to Orchestrator
 *
 * Architectural Invariants:
 * 1. Recovery remains the authority for the recovery decision.
 * 2. Recovery remains the authority for selecting the checkpoint reference.
 * 3. GitRollbackManager remains the authority for executing physical rollback.
 * 4. GitPolicyValidator remains the authority for Git operation policy.
 * 5. GitCheckpointManager remains the authority for known-good checkpoint validation/management.
 * 6. No arbitrary commit SHA may be accepted as a recovery rollback target unless it resolves through a verified known-good checkpoint.
 * 7. No direct Git CLI exists in the recovery integration layer.
 * 8. Zero process execution / shell dependencies outside existing Git adapter.
 * 9. RESUME must never cause rollback.
 * 10. RETRY must not silently become rollback.
 * 11. RESTART must use the recovery-selected checkpoint reference.
 * 12. Missing checkpoint reference must produce a deterministic structured failure.
 * 13. Unknown/non-known-good checkpoint must be rejected.
 * 14. Dirty worktree protection remains enforced by existing Git rollback boundary.
 * 15. Human authorization remains enforced by existing policy boundary.
 * 16. Critical remote history rewrite remains impossible.
 * 17. Force push and force-with-lease remain prohibited.
 * 18. Never mutates FSM state.
 * 19. Rollback failures produce structured information for Orchestrator error paths.
 * 20. Exposes previous and resulting HEAD via GitRollbackResult.
 */
export class RecoveryGitRollbackIntegrator {
  readonly checkpointManager: GitCheckpointManager;
  readonly rollbackManager: GitRollbackManager;
  readonly defaultWorkingDirectory?: string;

  constructor(
    checkpointManagerOrOptions: GitCheckpointManager | RecoveryGitIntegratorOptions,
    rollbackManager?: GitRollbackManager
  ) {
    if (
      typeof checkpointManagerOrOptions === 'object' &&
      checkpointManagerOrOptions !== null &&
      'checkpointManager' in checkpointManagerOrOptions
    ) {
      const opts = checkpointManagerOrOptions as RecoveryGitIntegratorOptions;
      if (!opts.checkpointManager) {
        throw new Error('checkpointManager is required for RecoveryGitRollbackIntegrator');
      }
      this.checkpointManager = opts.checkpointManager;
      this.rollbackManager = opts.rollbackManager ?? opts.checkpointManager.getRollbackManager();
      this.defaultWorkingDirectory = opts.defaultWorkingDirectory;
    } else if (checkpointManagerOrOptions) {
      this.checkpointManager = checkpointManagerOrOptions as GitCheckpointManager;
      this.rollbackManager =
        rollbackManager ?? (checkpointManagerOrOptions as GitCheckpointManager).getRollbackManager();
      this.defaultWorkingDirectory = undefined;
    } else {
      throw new Error('checkpointManager is required for RecoveryGitRollbackIntegrator');
    }
  }

  /**
   * Processes a recovery decision and invokes Git rollback if and only if required by recovery semantics.
   *
   * Flow:
   * 1. Inspect decision:
   *    - RESUME: No rollback.
   *    - RETRY: No rollback (unless explicitly identified/permitted).
   *    - BLOCKED_ON_HUMAN: No rollback.
   *    - RESTART: Execute rollback to target checkpoint.
   * 2. For RESTART:
   *    - Verify target checkpoint reference exists.
   *    - Resolve target checkpoint through GitCheckpointManager.
   *    - Ensure target checkpoint is a verified known-good checkpoint (reject arbitrary SHAs).
   *    - Pass human approval token to GitRollbackManager.
   *    - Execute atomic rollback via GitRollbackManager.rollbackToCheckpoint.
   * 3. Return structured RecoveryRollbackIntegrationResult.
   */
  async processRecoveryDecision(
    recoveryResult: RecoveryResult | DeterministicDecisionData,
    options?: RecoveryRollbackOptions
  ): Promise<RecoveryRollbackIntegrationResult> {
    const decision = recoveryResult.decision;
    const shouldThrow = Boolean(options?.throw_on_error ?? options?.throwOnError);

    // ------------------------------------------------------------------------
    // Rule 1: RESUME never causes rollback (Invariant 9)
    // ------------------------------------------------------------------------
    if (decision === RecoveryDecision.RESUME) {
      return Object.freeze({
        success: true,
        recoveryDecision: RecoveryDecision.RESUME,
        rollbackExecuted: false,
        requiresReconciliation: false,
        recovery_decision: RecoveryDecision.RESUME,
        rollback_executed: false,
        requires_reconciliation: false,
      });
    }

    // ------------------------------------------------------------------------
    // Rule 2: RETRY does not silently rollback (Invariant 10)
    // ------------------------------------------------------------------------
    if (decision === RecoveryDecision.RETRY && !options?.allowRetryRollback) {
      return Object.freeze({
        success: true,
        recoveryDecision: RecoveryDecision.RETRY,
        rollbackExecuted: false,
        requiresReconciliation: false,
        recovery_decision: RecoveryDecision.RETRY,
        rollback_executed: false,
        requires_reconciliation: false,
      });
    }

    // ------------------------------------------------------------------------
    // Rule 3: BLOCKED_ON_HUMAN does not cause rollback
    // ------------------------------------------------------------------------
    if (decision === RecoveryDecision.BLOCKED_ON_HUMAN) {
      return Object.freeze({
        success: true,
        recoveryDecision: RecoveryDecision.BLOCKED_ON_HUMAN,
        rollbackExecuted: false,
        requiresReconciliation: false,
        recovery_decision: RecoveryDecision.BLOCKED_ON_HUMAN,
        rollback_executed: false,
        requires_reconciliation: false,
      });
    }

    // ------------------------------------------------------------------------
    // Rule 4: RESTART requires rollback to recovery-selected checkpoint reference (Invariant 11)
    // ------------------------------------------------------------------------
    const targetRef = recoveryResult.targetCheckpoint?.trim();

    // Checkpoint reference must be present (Invariant 12)
    if (!targetRef) {
      const errMsg = 'Recovery decision is RESTART but no target checkpoint reference was provided';
      if (shouldThrow) {
        throw new GitCheckpointNotFoundError(errMsg, {
          violations: [{ code: 'MISSING_CHECKPOINT_REFERENCE', message: errMsg }],
        });
      }
      return Object.freeze({
        success: false,
        recoveryDecision: decision,
        rollbackExecuted: false,
        checkpointId: null,
        targetCommitSha: null,
        error: errMsg,
        failureCode: 'MISSING_CHECKPOINT_REFERENCE',
        requiresReconciliation: false,
        recovery_decision: decision,
        rollback_executed: false,
        checkpoint_id: null,
        target_commit_sha: null,
        failure_code: 'MISSING_CHECKPOINT_REFERENCE',
        requires_reconciliation: false,
      });
    }

    // Resolve checkpoint through GitCheckpointManager (Invariants 5, 6, 13)
    let checkpoint: KnownGoodCheckpoint | undefined = this.checkpointManager.getCheckpoint(targetRef);

    // If not found by checkpoint ID, check if targetRef resolves to a verified known-good checkpoint by commit SHA
    if (!checkpoint) {
      const matchingCheckpoints = this.checkpointManager
        .listCheckpoints({ onlyKnownGood: true })
        .filter((cp) => cp.commit_sha === targetRef || cp.commitSha === targetRef);

      if (matchingCheckpoints.length === 1) {
        checkpoint = matchingCheckpoints[0];
      }
    }

    // Unknown checkpoint rejection (Invariant 13)
    if (!checkpoint) {
      const errMsg = `Target checkpoint '${targetRef}' was not found in checkpoint manager registry`;
      if (shouldThrow) {
        throw new GitCheckpointNotFoundError(errMsg, {
          checkpointId: targetRef,
          violations: [{ code: 'CHECKPOINT_NOT_FOUND', message: errMsg }],
        });
      }
      return Object.freeze({
        success: false,
        recoveryDecision: decision,
        rollbackExecuted: false,
        checkpointId: targetRef,
        targetCommitSha: null,
        error: errMsg,
        failureCode: 'CHECKPOINT_NOT_FOUND',
        requiresReconciliation: false,
        recovery_decision: decision,
        rollback_executed: false,
        checkpoint_id: targetRef,
        target_commit_sha: null,
        failure_code: 'CHECKPOINT_NOT_FOUND',
        requires_reconciliation: false,
      });
    }

    // Non-known-good checkpoint rejection (Invariant 13)
    const isKnownGood =
      (checkpoint as { is_known_good?: boolean }).is_known_good === true ||
      (checkpoint as { isKnownGood?: boolean }).isKnownGood === true;

    if (!isKnownGood) {
      const errMsg = `Checkpoint '${checkpoint.checkpoint_id}' is not verified known-good; rollback requires a verified known-good checkpoint`;
      if (shouldThrow) {
        throw new GitCheckpointNotKnownGoodError(errMsg, {
          checkpointId: checkpoint.checkpoint_id,
          commitSha: checkpoint.commit_sha,
          violations: [{ code: 'CHECKPOINT_NOT_KNOWN_GOOD', message: errMsg }],
        });
      }
      return Object.freeze({
        success: false,
        recoveryDecision: decision,
        rollbackExecuted: false,
        checkpointId: checkpoint.checkpoint_id,
        targetCommitSha: checkpoint.commit_sha,
        error: errMsg,
        failureCode: 'CHECKPOINT_NOT_KNOWN_GOOD',
        requiresReconciliation: false,
        recovery_decision: decision,
        rollback_executed: false,
        checkpoint_id: checkpoint.checkpoint_id,
        target_commit_sha: checkpoint.commit_sha,
        failure_code: 'CHECKPOINT_NOT_KNOWN_GOOD',
        requires_reconciliation: false,
      });
    }

    // ------------------------------------------------------------------------
    // Rule 5: Invoke GitRollbackManager with human authorization pass-through (Invariants 3, 14, 15)
    // ------------------------------------------------------------------------
    const humanApprovalToken = options?.human_approval_token ?? options?.humanApprovalToken ?? null;
    const workingDir =
      options?.working_directory ?? options?.workingDirectory ?? this.defaultWorkingDirectory;

    const rollbackOpts: RollbackOptions = {
      checkpoint,
      human_approval_token: humanApprovalToken,
      working_directory: workingDir,
      verify_remote: options?.verify_remote ?? options?.verifyRemote,
      expected_branch: options?.expected_branch ?? options?.expectedBranch,
      expected_parent_sha: options?.expected_parent_sha ?? options?.expectedParentSha,
      throw_on_error: shouldThrow,
      require_known_good: true,
      metadata: options?.metadata,
    };

    let rollbackResult: GitRollbackResult;
    try {
      rollbackResult = await this.rollbackManager.rollbackToCheckpoint(checkpoint, rollbackOpts);
    } catch (err) {
      if (shouldThrow) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      return Object.freeze({
        success: false,
        recoveryDecision: decision,
        rollbackExecuted: true,
        checkpointId: checkpoint.checkpoint_id,
        targetCommitSha: checkpoint.commit_sha,
        error: errMsg,
        failureCode: 'ROLLBACK_EXECUTION_FAILURE',
        requiresReconciliation: true,
        recovery_decision: decision,
        rollback_executed: true,
        checkpoint_id: checkpoint.checkpoint_id,
        target_commit_sha: checkpoint.commit_sha,
        failure_code: 'ROLLBACK_EXECUTION_FAILURE',
        requires_reconciliation: true,
      });
    }

    // ------------------------------------------------------------------------
    // Rule 6: Surface structured result to Orchestrator (Invariants 19, 20)
    // ------------------------------------------------------------------------
    if (rollbackResult.success) {
      return Object.freeze({
        success: true,
        recoveryDecision: decision,
        rollbackExecuted: true,
        checkpointId: rollbackResult.checkpoint_id,
        targetCommitSha: rollbackResult.target_commit_sha,
        previousHeadSha: rollbackResult.previous_head_sha,
        resultingHeadSha: rollbackResult.resulting_head_sha,
        rollbackResult,
        requiresReconciliation: rollbackResult.requires_reconciliation,
        recovery_decision: decision,
        rollback_executed: true,
        checkpoint_id: rollbackResult.checkpoint_id,
        target_commit_sha: rollbackResult.target_commit_sha,
        previous_head_sha: rollbackResult.previous_head_sha,
        resulting_head_sha: rollbackResult.resulting_head_sha,
        rollback_result: rollbackResult,
        requires_reconciliation: rollbackResult.requires_reconciliation,
      });
    } else {
      return Object.freeze({
        success: false,
        recoveryDecision: decision,
        rollbackExecuted: true,
        checkpointId: rollbackResult.checkpoint_id,
        targetCommitSha: rollbackResult.target_commit_sha,
        previousHeadSha: rollbackResult.previous_head_sha,
        resultingHeadSha: rollbackResult.resulting_head_sha,
        rollbackResult,
        error: rollbackResult.error,
        failureCode: rollbackResult.failure_code,
        requiresReconciliation: rollbackResult.requires_reconciliation,
        recovery_decision: decision,
        rollback_executed: true,
        checkpoint_id: rollbackResult.checkpoint_id,
        target_commit_sha: rollbackResult.target_commit_sha,
        previous_head_sha: rollbackResult.previous_head_sha,
        resulting_head_sha: rollbackResult.resulting_head_sha,
        rollback_result: rollbackResult,
        failure_code: rollbackResult.failure_code,
        requires_reconciliation: rollbackResult.requires_reconciliation,
      });
    }
  }

  /**
   * Convenience alias for processRecoveryDecision.
   */
  async integrate(
    recoveryResult: RecoveryResult | DeterministicDecisionData,
    options?: RecoveryRollbackOptions
  ): Promise<RecoveryRollbackIntegrationResult> {
    return this.processRecoveryDecision(recoveryResult, options);
  }

  /**
   * Convenience end-to-end method that executes RecoveryEngine.reconcile and integrates with Git rollback.
   */
  async reconcileAndIntegrate(
    recoveryEngine: RecoveryEngine,
    runtimeOptions?: Parameters<RecoveryEngine['reconcile']>[0],
    rollbackOptions?: RecoveryRollbackOptions
  ): Promise<RecoveryRollbackIntegrationResult> {
    const recoveryResult = await recoveryEngine.reconcile(runtimeOptions);
    return this.processRecoveryDecision(recoveryResult, rollbackOptions);
  }
}

/**
 * Convenience alias for RecoveryGitRollbackIntegrator.
 */
export const RecoveryGitIntegrator = RecoveryGitRollbackIntegrator;
export type RecoveryGitIntegrator = RecoveryGitRollbackIntegrator;
