import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  RiskLevel,
  GitOperationType,
  GitStatus,
  GitRollbackStage,
  GitRollbackStatus,
  GitPolicyDecisionState,
  GitPolicyValidator,
  createGitState,
  createGitCheckpoint,
  FakeGitPort,
  GitCheckpointManager,
  GitRollbackManager,
  GitCheckpointNotFoundError,
  GitCheckpointNotKnownGoodError,
  GitRollbackAuthorizationError,
  GitRollbackVerificationError,
  GitRollbackExecutionError,
  GitDirtyWorktreeError,
  RecoveryDecision,
  RecoveryGitRollbackIntegrator,
  RecoveryGitIntegrator,
  RecoveryEngine,
  DurableStateManager,
  LifecycleState,
  type GitState,
  type GitCheckpoint,
  type KnownGoodCheckpoint,
  type RecoveryResult,
  type DeterministicDecisionData,
  type RecoveryRollbackIntegrationResult,
} from '../dist/index.js';

// ============================================================================
// FIXTURES & CONSTANTS
// ============================================================================

const COMMIT_SHA_BASE = '1111111111111111111111111111111111111111';
const COMMIT_SHA_MID = '2222222222222222222222222222222222222222';
const COMMIT_SHA_HEAD = '3333333333333333333333333333333333333333';
const COMMIT_SHA_ARBITRARY = '9999999999999999999999999999999999999999';
const VALID_AUTH_TOKEN = 'auth-token-director-verified-secret-token-776655';

function createCleanKnownGoodCheckpoint(overrides?: Partial<GitCheckpoint>): KnownGoodCheckpoint {
  const base = createGitCheckpoint({
    checkpoint_id: 'chk_task_p6_04_pre_flight_11111111_abc123',
    task_id: 'task-p6-04',
    phase: 'PHASE_6',
    purpose: 'PRE_FLIGHT',
    commit_sha: COMMIT_SHA_BASE,
    parent_sha: null,
    branch: 'main',
    remote: 'origin',
    working_tree_clean: true,
    remote_verified: true,
    policy_level: RiskLevel.CAUTION,
    ...overrides,
  });

  const observedState = createGitState({
    head_sha: base.commit_sha,
    current_branch: base.branch,
    working_tree_clean: true,
  });

  const validator = new GitPolicyValidator();
  const decision = validator.validateOperation(
    { operation: GitOperationType.CHECKPOINT_CREATION, target_branch: base.branch },
    observedState
  );

  return Object.freeze({
    ...base,
    is_known_good: true,
    isKnownGood: true,
    verified_at: new Date().toISOString(),
    observed_state: observedState,
    policy_decision: decision,
    execution_result: {
      success: true,
      operation: GitOperationType.CHECKPOINT_CREATION,
      policy_level: RiskLevel.CAUTION,
      executed_at: new Date().toISOString(),
    },
    checkpoint: base,
  }) as KnownGoodCheckpoint;
}

function createRepoState(overrides?: Partial<GitState>): GitState {
  return createGitState({
    head_sha: COMMIT_SHA_HEAD,
    current_branch: 'main',
    remote_head_sha: COMMIT_SHA_HEAD,
    parent_sha: COMMIT_SHA_MID,
    working_tree_clean: true,
    staged_changes: [],
    unstaged_changes: [],
    untracked_files: [],
    is_detached_head: false,
    ...overrides,
  });
}

// ============================================================================
// TEST SUITE: P6-04 — RECOVERY / RECONCILIATION → GIT ROLLBACK INTEGRATION
// ============================================================================

describe('P6-04 — Recovery / Reconciliation → Git Rollback Integration', () => {
  let fakePort: FakeGitPort;
  let validator: GitPolicyValidator;
  let checkpointManager: GitCheckpointManager;
  let rollbackManager: GitRollbackManager;
  let integrator: RecoveryGitRollbackIntegrator;
  let knownGoodCheckpoint: KnownGoodCheckpoint;

  beforeEach(() => {
    fakePort = new FakeGitPort({
      initialState: createRepoState(),
      knownCommits: [COMMIT_SHA_BASE, COMMIT_SHA_MID, COMMIT_SHA_HEAD],
    });
    validator = new GitPolicyValidator();
    checkpointManager = new GitCheckpointManager(fakePort, validator);
    rollbackManager = new GitRollbackManager(fakePort, {
      policyValidator: validator,
      checkpointManager,
    });
    integrator = new RecoveryGitRollbackIntegrator(checkpointManager, rollbackManager);

    knownGoodCheckpoint = createCleanKnownGoodCheckpoint();
    // Register the known-good checkpoint in the manager's memory store
    (checkpointManager as any).checkpoints.set(
      knownGoodCheckpoint.checkpoint_id,
      knownGoodCheckpoint
    );
  });

  // --------------------------------------------------------------------------
  // 1. RESUME does not rollback
  // --------------------------------------------------------------------------
  it('1. RESUME does not rollback: preserves workspace and skips rollback execution', async () => {
    const resumeDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESUME,
      reason: 'Active task loop with consistent workspace; continuing execution',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'IMPLEMENTATION',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(resumeDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.recoveryDecision, RecoveryDecision.RESUME);
    assert.equal(result.rollbackExecuted, false);
    assert.equal(result.requiresReconciliation, false);
    assert.equal(result.rollbackResult, undefined);
    assert.equal(fakePort.executedOperations.length, 0);
    assert.equal(fakePort.currentState.head_sha, COMMIT_SHA_HEAD);
  });

  // --------------------------------------------------------------------------
  // 2. RETRY does not silently rollback
  // --------------------------------------------------------------------------
  it('2. RETRY does not silently rollback: preserves existing retry semantics without mutation', async () => {
    const retryDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RETRY,
      reason: 'Previous execution failed under consistent workspace; retryable condition confirmed',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'INSTRUCT_ANTIGRAVITY',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(retryDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.recoveryDecision, RecoveryDecision.RETRY);
    assert.equal(result.rollbackExecuted, false);
    assert.equal(result.requiresReconciliation, false);
    assert.equal(result.rollbackResult, undefined);
    assert.equal(fakePort.executedOperations.length, 0);
    assert.equal(fakePort.currentState.head_sha, COMMIT_SHA_HEAD);
  });

  // --------------------------------------------------------------------------
  // 3. RESTART with valid known-good checkpoint invokes rollback boundary
  // --------------------------------------------------------------------------
  it('3. RESTART with valid known-good checkpoint invokes rollback boundary', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace state is inconsistent with L0 index: corrupted files detected',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.recoveryDecision, RecoveryDecision.RESTART);
    assert.equal(result.rollbackExecuted, true);
    assert.equal(result.checkpointId, knownGoodCheckpoint.checkpoint_id);
    assert.equal(result.targetCommitSha, knownGoodCheckpoint.commit_sha);
    assert.equal(result.previousHeadSha, COMMIT_SHA_HEAD);
    assert.equal(result.resultingHeadSha, knownGoodCheckpoint.commit_sha);
    assert.ok(result.rollbackResult);
    assert.equal(result.rollbackResult.success, true);
    assert.equal(result.rollbackResult.status, GitRollbackStatus.VERIFIED);
    assert.equal(fakePort.currentState.head_sha, knownGoodCheckpoint.commit_sha);
    assert.equal(fakePort.executedOperations.length, 1);
    assert.equal(fakePort.executedOperations[0].intent.operation, GitOperationType.ROLLBACK_REQUEST);
  });

  // --------------------------------------------------------------------------
  // 4. RESTART without checkpoint reference fails deterministically
  // --------------------------------------------------------------------------
  it('4. RESTART without checkpoint reference fails deterministically', async () => {
    const missingCheckpointDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace state is inconsistent with L0 index',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: null,
    };

    const result = await integrator.processRecoveryDecision(missingCheckpointDecision);

    assert.equal(result.success, false);
    assert.equal(result.recoveryDecision, RecoveryDecision.RESTART);
    assert.equal(result.rollbackExecuted, false);
    assert.equal(result.failureCode, 'MISSING_CHECKPOINT_REFERENCE');
    assert.ok(result.error?.includes('no target checkpoint reference'));
    assert.equal(fakePort.executedOperations.length, 0);

    // Also verify throwOnError: true throws GitCheckpointNotFoundError
    await assert.rejects(
      async () =>
        integrator.processRecoveryDecision(missingCheckpointDecision, { throwOnError: true }),
      (err: any) => {
        assert.ok(err instanceof GitCheckpointNotFoundError);
        assert.ok(err.message.includes('no target checkpoint reference'));
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 5. RESTART with unknown checkpoint fails
  // --------------------------------------------------------------------------
  it('5. RESTART with unknown checkpoint fails: rejected deterministically', async () => {
    const unknownCheckpointDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: 'chk_unknown_non_existent_999',
    };

    const result = await integrator.processRecoveryDecision(unknownCheckpointDecision);

    assert.equal(result.success, false);
    assert.equal(result.recoveryDecision, RecoveryDecision.RESTART);
    assert.equal(result.rollbackExecuted, false);
    assert.equal(result.failureCode, 'CHECKPOINT_NOT_FOUND');
    assert.ok(result.error?.includes('chk_unknown_non_existent_999'));
    assert.equal(fakePort.executedOperations.length, 0);

    // With throwOnError: true throws GitCheckpointNotFoundError
    await assert.rejects(
      async () =>
        integrator.processRecoveryDecision(unknownCheckpointDecision, { throwOnError: true }),
      (err: any) => {
        assert.ok(err instanceof GitCheckpointNotFoundError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 6. RESTART with non-known-good checkpoint fails
  // --------------------------------------------------------------------------
  it('6. RESTART with non-known-good checkpoint fails: rejected deterministically', async () => {
    const unverifiedCheckpoint = createGitCheckpoint({
      checkpoint_id: 'chk_unverified_not_known_good',
      task_id: 'task-p6-04',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      commit_sha: COMMIT_SHA_BASE,
      parent_sha: null,
      branch: 'main',
      remote: 'origin',
      working_tree_clean: true,
      remote_verified: false,
      policy_level: RiskLevel.CAUTION,
    });

    // Register without is_known_good: true
    (checkpointManager as any).checkpoints.set(
      unverifiedCheckpoint.checkpoint_id,
      unverifiedCheckpoint as any
    );

    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: unverifiedCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision);

    assert.equal(result.success, false);
    assert.equal(result.recoveryDecision, RecoveryDecision.RESTART);
    assert.equal(result.rollbackExecuted, false);
    assert.equal(result.failureCode, 'CHECKPOINT_NOT_KNOWN_GOOD');
    assert.ok(result.error?.includes('not verified known-good'));
    assert.equal(fakePort.executedOperations.length, 0);

    // With throwOnError: true throws GitCheckpointNotKnownGoodError
    await assert.rejects(
      async () => integrator.processRecoveryDecision(restartDecision, { throwOnError: true }),
      (err: any) => {
        assert.ok(err instanceof GitCheckpointNotKnownGoodError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 7. rollback policy validation is invoked
  // --------------------------------------------------------------------------
  it('7. rollback policy validation is invoked during integration', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.ok(result.rollbackResult?.policy_decision);
    assert.equal(result.rollbackResult.policy_decision.allowed, true);
    assert.equal(result.rollbackResult.policy_decision.operation, GitOperationType.ROLLBACK_REQUEST);
  });

  // --------------------------------------------------------------------------
  // 8. DANGEROUS classification is preserved
  // --------------------------------------------------------------------------
  it('8. DANGEROUS classification is preserved for recovery rollback', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.rollbackResult?.policy_decision?.risk_level, RiskLevel.DANGEROUS);
  });

  // --------------------------------------------------------------------------
  // 9. human authorization remains required
  // --------------------------------------------------------------------------
  it('9. human authorization remains required: fails when approval token is omitted', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision);

    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(
      result.rollbackResult?.authorization_status,
      GitPolicyDecisionState.HUMAN_REQUIRED
    );
    assert.equal(fakePort.currentState.head_sha, COMMIT_SHA_HEAD); // HEAD untouched
  });

  // --------------------------------------------------------------------------
  // 10. invalid authorization is rejected
  // --------------------------------------------------------------------------
  it('10. invalid authorization is rejected: empty or whitespace-only token blocked', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: '   ',
    });

    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(fakePort.currentState.head_sha, COMMIT_SHA_HEAD);
  });

  // --------------------------------------------------------------------------
  // 11. valid authorization reaches rollback boundary
  // --------------------------------------------------------------------------
  it('11. valid authorization reaches rollback boundary: executes and verifies rollback', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.rollbackResult?.status, GitRollbackStatus.VERIFIED);
    assert.equal(result.resultingHeadSha, knownGoodCheckpoint.commit_sha);
  });

  // --------------------------------------------------------------------------
  // 12. dirty worktree remains protected
  // --------------------------------------------------------------------------
  it('12. dirty worktree remains protected: rollback rejected when unstaged changes exist', async () => {
    fakePort.currentState = createRepoState({
      working_tree_clean: false,
      unstaged_changes: ['src/corrupt.ts'],
    });

    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'DIRTY_WORKTREE_PROHIBITED');
    assert.equal(fakePort.currentState.head_sha, COMMIT_SHA_HEAD); // Never touched
  });

  // --------------------------------------------------------------------------
  // 13. force push remains prohibited
  // --------------------------------------------------------------------------
  it('13. force push remains prohibited: force flag is strictly false in executed intent', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(fakePort.executedOperations.length, 1);
    assert.equal(fakePort.executedOperations[0].intent.force, false);
  });

  // --------------------------------------------------------------------------
  // 14. force-with-lease remains prohibited
  // --------------------------------------------------------------------------
  it('14. force-with-lease remains prohibited: policy validator denies forced updates', async () => {
    assert.equal(integrator.rollbackManager.policyConfig.prohibit_force_push, true);
  });

  // --------------------------------------------------------------------------
  // 15. remote history rewrite remains prohibited
  // --------------------------------------------------------------------------
  it('15. remote history rewrite remains prohibited: remote verification is strictly read-only', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
      verifyRemote: true,
    });

    assert.equal(result.success, true);
    assert.equal(fakePort.remoteVerifications.length, 1);
    // Remote was only inspected, zero push operations executed
    assert.equal(
      fakePort.executedOperations.some((op) => op.intent.operation === GitOperationType.PUSH),
      false
    );
  });

  // --------------------------------------------------------------------------
  // 16. rollback execution failure is surfaced deterministically
  // --------------------------------------------------------------------------
  it('16. rollback execution failure is surfaced deterministically with requiresReconciliation', async () => {
    fakePort.simulateExecutionFailure = true;
    fakePort.executionFailureError = 'Simulated I/O disk hardware fault';

    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'ROLLBACK_EXECUTION_FAILURE');
    assert.equal(result.requiresReconciliation, true);
    assert.ok(result.error?.includes('Simulated I/O disk hardware fault'));
  });

  // --------------------------------------------------------------------------
  // 17. rollback verification failure is surfaced deterministically
  // --------------------------------------------------------------------------
  it('17. rollback verification failure is surfaced deterministically when post-rollback state mismatches', async () => {
    fakePort.simulatePostRollbackState = {
      head_sha: COMMIT_SHA_MID, // Mismatches expected target COMMIT_SHA_BASE
    };

    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'ROLLBACK_VERIFICATION_FAILURE');
    assert.equal(result.requiresReconciliation, true);
    assert.ok(result.error?.includes('Post-rollback HEAD'));
  });

  // --------------------------------------------------------------------------
  // 18. successful rollback returns structured rollback result
  // --------------------------------------------------------------------------
  it('18. successful rollback returns structured rollback result matching GitRollbackResult contract', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.ok(result.rollbackResult);
    assert.equal(result.rollbackResult.stage, GitRollbackStage.COMPLETED);
    assert.equal(result.rollbackResult.status, GitRollbackStatus.VERIFIED);
    assert.equal(result.rollbackResult.authorization_status, GitPolicyDecisionState.AUTHORIZED);
    assert.equal(result.rollbackResult.execution_status, 'COMPLETED');
    assert.equal(result.rollbackResult.verification_status, 'VERIFIED');
    assert.ok(result.rollbackResult.completed_at);
  });

  // --------------------------------------------------------------------------
  // 19. previous HEAD is preserved
  // --------------------------------------------------------------------------
  it('19. previous HEAD is preserved in integration result', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.previousHeadSha, COMMIT_SHA_HEAD);
    assert.equal(result.previous_head_sha, COMMIT_SHA_HEAD);
  });

  // --------------------------------------------------------------------------
  // 20. resulting HEAD is preserved
  // --------------------------------------------------------------------------
  it('20. resulting HEAD is preserved in integration result', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Workspace corruption',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.resultingHeadSha, COMMIT_SHA_BASE);
    assert.equal(result.resulting_head_sha, COMMIT_SHA_BASE);
  });

  // --------------------------------------------------------------------------
  // 21. recovery decision itself is not changed by the integration
  // --------------------------------------------------------------------------
  it('21. recovery decision itself is not changed by the integration across all decision types', async () => {
    const decisions: RecoveryDecision[] = [
      RecoveryDecision.RESUME,
      RecoveryDecision.RETRY,
      RecoveryDecision.BLOCKED_ON_HUMAN,
    ];

    for (const d of decisions) {
      const data: DeterministicDecisionData = {
        decision: d,
        reason: `Testing ${d}`,
        taskId: 'task-p6-04',
        iteration: 1,
        contextReference: null,
        resumePoint: null,
        targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
      };

      const res = await integrator.processRecoveryDecision(data);
      assert.equal(res.recoveryDecision, d);
      assert.equal(res.recovery_decision, d);
    }
  });

  // --------------------------------------------------------------------------
  // 22. no direct shell/process dependency exists in the recovery integration
  // --------------------------------------------------------------------------
  it('22. no direct shell/process dependency exists in the recovery integration module', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const sourcePath = path.resolve(
      __dirname,
      '../src/recovery/recovery-git-integrator.ts'
    );
    const sourceContent = fs.readFileSync(sourcePath, 'utf8');

    // Strictly ensure no prohibited execution modules or CLI calls
    assert.equal(sourceContent.includes('child_process'), false);
    assert.equal(sourceContent.includes('execSync'), false);
    assert.equal(sourceContent.includes('execFile'), false);
    assert.equal(sourceContent.includes('spawn'), false);
    assert.equal(sourceContent.includes('exec('), false);
  });

  // --------------------------------------------------------------------------
  // 23. provider neutrality is preserved
  // --------------------------------------------------------------------------
  it('23. provider neutrality is preserved: operates solely against GitCheckpointManager abstractions', () => {
    assert.ok(integrator.checkpointManager);
    assert.ok(integrator.rollbackManager);
    assert.equal(typeof integrator.processRecoveryDecision, 'function');
    assert.equal(typeof integrator.integrate, 'function');
  });

  // --------------------------------------------------------------------------
  // 24. no duplicate checkpoint implementation exists
  // --------------------------------------------------------------------------
  it('24. no duplicate checkpoint implementation exists: delegates to GitCheckpointManager directly', () => {
    assert.equal(integrator.checkpointManager, checkpointManager);
    assert.equal(integrator.rollbackManager, rollbackManager);
  });

  // --------------------------------------------------------------------------
  // 25. arbitrary commit SHA rollback without known-good checkpoint is rejected
  // --------------------------------------------------------------------------
  it('25. arbitrary commit SHA rollback without known-good checkpoint is rejected', async () => {
    const arbitraryDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Malicious or arbitrary target commit',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: COMMIT_SHA_ARBITRARY,
    };

    const result = await integrator.processRecoveryDecision(arbitraryDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'CHECKPOINT_NOT_FOUND');
    assert.equal(fakePort.executedOperations.length, 0);
  });

  // --------------------------------------------------------------------------
  // 26. human approval token is never leaked in result or errors
  // --------------------------------------------------------------------------
  it('26. human approval token is never leaked in result or error objects', async () => {
    const restartDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.RESTART,
      reason: 'Testing secret token leakage prevention',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: VALID_AUTH_TOKEN,
    });

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(VALID_AUTH_TOKEN), false);
    assert.equal(Boolean(result.error?.includes(VALID_AUTH_TOKEN)), false);

    const failResult = await integrator.processRecoveryDecision(restartDecision, {
      humanApprovalToken: 'invalid-secret-attempt-token-1234',
    });
    const serializedFail = JSON.stringify(failResult);
    assert.equal(serializedFail.includes('invalid-secret-attempt-token-1234'), false);
    assert.equal(Boolean(failResult.error?.includes('invalid-secret-attempt-token-1234')), false);
  });

  // --------------------------------------------------------------------------
  // 27. BLOCKED_ON_HUMAN decision skips rollback
  // --------------------------------------------------------------------------
  it('27. BLOCKED_ON_HUMAN decision preserves state without invoking rollback', async () => {
    const blockedDecision: DeterministicDecisionData = {
      decision: RecoveryDecision.BLOCKED_ON_HUMAN,
      reason: 'Awaiting human authorization',
      taskId: 'task-p6-04',
      iteration: 1,
      contextReference: 'ctx-123',
      resumePoint: 'RESUME_EXACT_BLOCKED_POINT',
      targetCheckpoint: knownGoodCheckpoint.checkpoint_id,
    };

    const result = await integrator.processRecoveryDecision(blockedDecision);

    assert.equal(result.success, true);
    assert.equal(result.recoveryDecision, RecoveryDecision.BLOCKED_ON_HUMAN);
    assert.equal(result.rollbackExecuted, false);
    assert.equal(fakePort.executedOperations.length, 0);
  });

  // --------------------------------------------------------------------------
  // 28. RecoveryGitIntegrator alias is identical to RecoveryGitRollbackIntegrator
  // --------------------------------------------------------------------------
  it('28. RecoveryGitIntegrator alias is identical to RecoveryGitRollbackIntegrator', () => {
    assert.equal(RecoveryGitIntegrator, RecoveryGitRollbackIntegrator);
    const instance = new RecoveryGitIntegrator(checkpointManager);
    assert.ok(instance instanceof RecoveryGitRollbackIntegrator);
  });

  // --------------------------------------------------------------------------
  // 29. Constructor options object configuration overload
  // --------------------------------------------------------------------------
  it('29. constructor options object configuration overload works cleanly', () => {
    const instance = new RecoveryGitRollbackIntegrator({
      checkpointManager,
      rollbackManager,
      defaultWorkingDirectory: process.cwd(),
    });
    assert.equal(instance.checkpointManager, checkpointManager);
    assert.equal(instance.rollbackManager, rollbackManager);
  });

  // --------------------------------------------------------------------------
  // 30. End-to-end reconcileAndIntegrate flow with RecoveryEngine
  // --------------------------------------------------------------------------
  it('30. end-to-end reconcileAndIntegrate flow executes Phase 1 reconciliation and integrates rollback', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p6-04-rec-'));
    try {
      const durableManager = new DurableStateManager({ baseDir: tempDir });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'task-p6-04-e2e',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: knownGoodCheckpoint.checkpoint_id,
        metadata: {
          contextReference: 'ctx-e2e',
          resumePoint: 'IMPLEMENTATION',
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempDir,
        durableStateManager: durableManager,
      });

      // Baseline with consistent workspace -> produces RESUME -> rollback skipped
      const resumeIntegrationResult = await integrator.reconcileAndIntegrate(
        recoveryEngine,
        undefined,
        { humanApprovalToken: VALID_AUTH_TOKEN }
      );

      assert.equal(resumeIntegrationResult.success, true);
      assert.equal(resumeIntegrationResult.recoveryDecision, RecoveryDecision.RESUME);
      assert.equal(resumeIntegrationResult.rollbackExecuted, false);

      // Now simulate corruption -> produces RESTART -> rollback executed
      const restartIntegrationResult = await integrator.reconcileAndIntegrate(
        recoveryEngine,
        { isCorrupted: true },
        { humanApprovalToken: VALID_AUTH_TOKEN }
      );

      assert.equal(restartIntegrationResult.success, true);
      assert.equal(restartIntegrationResult.recoveryDecision, RecoveryDecision.RESTART);
      assert.equal(restartIntegrationResult.rollbackExecuted, true);
      assert.equal(restartIntegrationResult.checkpointId, knownGoodCheckpoint.checkpoint_id);
      assert.equal(restartIntegrationResult.resultingHeadSha, knownGoodCheckpoint.commit_sha);

      recoveryEngine.close();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});

