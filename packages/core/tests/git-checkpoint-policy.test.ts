import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  RiskLevel,
  GitOperationType,
  GitStatus,
  GitWorktreeStatus,
  GitRemoteSyncStatus,
  GitPolicyDecisionState,
  GitPolicyViolationCode,
  GitPolicyValidator,
  DEFAULT_GIT_POLICY_CONFIG,
  createGitState,
  createGitCheckpoint,
  validateGitCheckpointSchema,
  isValidCommitSha,
  FakeGitPort,
  DefaultGitPort,
  GitPolicyError,
  GitForcePushProhibitedError,
  GitCheckpointIntegrityError,
  getGitOperationRiskLevel,
  type GitState,
  type GitCheckpoint,
  type GitOperationIntent,
  type GitPolicyConfig,
} from '../dist/index.js';

// ============================================================================
// FIXTURES
// ============================================================================

const COMMIT_SHA_A = '1111111111111111111111111111111111111111';
const COMMIT_SHA_B = '2222222222222222222222222222222222222222';
const COMMIT_SHA_C = '3333333333333333333333333333333333333333';

function createCleanMainState(): GitState {
  return createGitState({
    head_sha: COMMIT_SHA_B,
    current_branch: 'main',
    remote_head_sha: COMMIT_SHA_B,
    working_tree_clean: true,
    staged_changes: [],
    unstaged_changes: [],
    untracked_files: [],
    is_detached_head: false,
    remote_sync_state: GitRemoteSyncStatus.UP_TO_DATE,
    status: GitStatus.CLEAN,
  });
}

function createCleanCheckpoint(): GitCheckpoint {
  return createGitCheckpoint({
    checkpoint_id: 'chk-0001',
    task_id: 'TASK-P6-01',
    phase: 'PHASE_6',
    purpose: 'PRE_FLIGHT',
    commit_sha: COMMIT_SHA_B,
    parent_sha: COMMIT_SHA_A,
    branch: 'main',
    remote: 'origin',
    working_tree_clean: true,
    remote_verified: true,
    policy_level: RiskLevel.CAUTION,
  });
}

describe('Phase 6 Git Checkpoint Policy & Boundary (TASK-P6-01)', () => {
  const validator = new GitPolicyValidator();

  // --------------------------------------------------------------------------
  // 1. SAFE operation classification
  // --------------------------------------------------------------------------
  it('1. SAFE operation classification: inspection and read-only operations are SAFE', () => {
    const safeOps = [
      GitOperationType.STATUS_INSPECTION,
      GitOperationType.DIFF_INSPECTION,
      GitOperationType.LOG_INSPECTION,
      GitOperationType.BRANCH_INSPECTION,
      GitOperationType.REMOTE_HEAD_INSPECTION,
      GitOperationType.REMOTE_VERIFICATION,
      GitOperationType.HISTORY_DIVERGENCE_DETECTION,
    ];

    for (const op of safeOps) {
      assert.equal(validator.classifyOperation(op), RiskLevel.SAFE);
      assert.equal(getGitOperationRiskLevel(op), RiskLevel.SAFE);
    }
  });

  // --------------------------------------------------------------------------
  // 2. CAUTION operation classification
  // --------------------------------------------------------------------------
  it('2. CAUTION operation classification: normal commits, push, and checkpoints are CAUTION', () => {
    const cautionOps = [
      GitOperationType.COMMIT,
      GitOperationType.PUSH,
      GitOperationType.PRE_FLIGHT_CHECKPOINT,
      GitOperationType.POST_FLIGHT_CHECKPOINT,
      GitOperationType.CHECKPOINT_CREATION,
    ];

    for (const op of cautionOps) {
      assert.equal(validator.classifyOperation(op), RiskLevel.CAUTION);
      assert.equal(getGitOperationRiskLevel(op), RiskLevel.CAUTION);
    }
  });

  // --------------------------------------------------------------------------
  // 3. DANGEROUS operation classification
  // --------------------------------------------------------------------------
  it('3. DANGEROUS operation classification: reset, checkout, revert, and rollback are DANGEROUS', () => {
    const dangerousOps = [
      GitOperationType.RESET,
      GitOperationType.CHECKOUT,
      GitOperationType.REVERT,
      GitOperationType.ROLLBACK_REQUEST,
      GitOperationType.HISTORY_REWRITE,
    ];

    for (const op of dangerousOps) {
      assert.equal(validator.classifyOperation(op), RiskLevel.DANGEROUS);
      assert.equal(getGitOperationRiskLevel(op), RiskLevel.DANGEROUS);
    }
  });

  // --------------------------------------------------------------------------
  // 4. CRITICAL operation classification
  // --------------------------------------------------------------------------
  it('4. CRITICAL operation classification: force push and destructive rewrites are CRITICAL', () => {
    const criticalOps = [
      GitOperationType.FORCE_PUSH,
      GitOperationType.DESTRUCTIVE_REMOTE_REWRITE,
      GitOperationType.DESTROY_PROJECT_HISTORY,
    ];

    for (const op of criticalOps) {
      assert.equal(validator.classifyOperation(op), RiskLevel.CRITICAL);
      assert.equal(getGitOperationRiskLevel(op), RiskLevel.CRITICAL);
    }
  });

  // --------------------------------------------------------------------------
  // 5. force-push rejection
  // --------------------------------------------------------------------------
  it('5. force-push rejection: force-push intent is strictly rejected without automatic execution', () => {
    const state = createCleanMainState();

    // Direct FORCE_PUSH operation
    const directForcePush = validator.validateOperation(
      { operation: GitOperationType.FORCE_PUSH },
      state
    );
    assert.equal(directForcePush.allowed, false);
    assert.equal(directForcePush.decision, GitPolicyDecisionState.NOT_AUTHORIZED);
    assert.equal(directForcePush.risk_level, RiskLevel.CRITICAL);
    assert.ok(
      directForcePush.violations.some((v) => v.code === GitPolicyViolationCode.FORCE_PUSH_PROHIBITED)
    );

    // Normal push with force flag
    const pushWithForce = validator.validateOperation(
      { operation: GitOperationType.PUSH, force: true },
      state
    );
    assert.equal(pushWithForce.allowed, false);
    assert.equal(pushWithForce.decision, GitPolicyDecisionState.NOT_AUTHORIZED);
    assert.equal(pushWithForce.risk_level, RiskLevel.CRITICAL);
    assert.ok(
      pushWithForce.violations.some((v) => v.code === GitPolicyViolationCode.FORCE_PUSH_PROHIBITED)
    );
  });

  // --------------------------------------------------------------------------
  // 6. dirty-worktree rejection where required
  // --------------------------------------------------------------------------
  it('6. dirty-worktree rejection: pre-flight checkpoint and push reject dirty worktree', () => {
    const dirtyState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'main',
      remote_head_sha: COMMIT_SHA_B,
      working_tree_clean: false,
      staged_changes: ['src/index.ts'],
      unstaged_changes: [],
      untracked_files: [],
      status: GitStatus.DIRTY,
    });

    const preFlight = validator.validateOperation(
      { operation: GitOperationType.PRE_FLIGHT_CHECKPOINT },
      dirtyState
    );
    assert.equal(preFlight.allowed, false);
    assert.equal(preFlight.decision, GitPolicyDecisionState.NOT_AUTHORIZED);
    assert.ok(
      preFlight.violations.some((v) => v.code === GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED)
    );

    const push = validator.validateOperation({ operation: GitOperationType.PUSH }, dirtyState);
    assert.equal(push.allowed, false);
    assert.ok(
      push.violations.some((v) => v.code === GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED)
    );
  });

  // --------------------------------------------------------------------------
  // 7. detached-HEAD rejection
  // --------------------------------------------------------------------------
  it('7. detached-HEAD rejection: mutating and checkpoint operations reject detached HEAD', () => {
    const detachedState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: null,
      is_detached_head: true,
      status: GitStatus.DETACHED,
      working_tree_clean: true,
      staged_changes: [],
      unstaged_changes: [],
      untracked_files: [],
    });

    const mutatingOps = [
      GitOperationType.COMMIT,
      GitOperationType.PUSH,
      GitOperationType.PRE_FLIGHT_CHECKPOINT,
      GitOperationType.POST_FLIGHT_CHECKPOINT,
      GitOperationType.CHECKPOINT_CREATION,
    ];

    for (const op of mutatingOps) {
      const decision = validator.validateOperation({ operation: op }, detachedState);
      assert.equal(decision.allowed, false);
      assert.ok(
        decision.violations.some((v) => v.code === GitPolicyViolationCode.DETACHED_HEAD_PROHIBITED),
        `Expected DETACHED_HEAD_PROHIBITED for ${op}`
      );
    }
  });

  // --------------------------------------------------------------------------
  // 8. branch mismatch
  // --------------------------------------------------------------------------
  it('8. branch mismatch: target branch or current branch mismatch is detected and rejected', () => {
    const featureState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'feature-experimental',
      working_tree_clean: true,
      staged_changes: [],
      unstaged_changes: [],
      untracked_files: [],
    });

    // Current workspace branch does not match configured 'main'
    const decisionCurrentMismatch = validator.validateOperation(
      { operation: GitOperationType.PUSH },
      featureState
    );
    assert.equal(decisionCurrentMismatch.allowed, false);
    assert.ok(
      decisionCurrentMismatch.violations.some(
        (v) => v.code === GitPolicyViolationCode.BRANCH_MISMATCH
      )
    );

    // Target branch explicitly specifies wrong branch
    const cleanMain = createCleanMainState();
    const decisionTargetMismatch = validator.validateOperation(
      { operation: GitOperationType.PUSH, target_branch: 'develop' },
      cleanMain
    );
    assert.equal(decisionTargetMismatch.allowed, false);
    assert.ok(
      decisionTargetMismatch.violations.some(
        (v) => v.code === GitPolicyViolationCode.BRANCH_MISMATCH
      )
    );
  });

  // --------------------------------------------------------------------------
  // 9. remote mismatch
  // --------------------------------------------------------------------------
  it('9. remote mismatch: target remote mismatch is detected and rejected', () => {
    const cleanMain = createCleanMainState();
    const decision = validator.validateOperation(
      { operation: GitOperationType.PUSH, target_remote: 'upstream_fork' },
      cleanMain
    );
    assert.equal(decision.allowed, false);
    assert.ok(
      decision.violations.some((v) => v.code === GitPolicyViolationCode.REMOTE_MISMATCH)
    );
  });

  // --------------------------------------------------------------------------
  // 10. wrong parent SHA
  // --------------------------------------------------------------------------
  it('10. wrong parent SHA: checkpoint integrity validation detects parent mismatch', () => {
    const checkpoint = createCleanCheckpoint(); // parent_sha is COMMIT_SHA_A
    const state = createCleanMainState();

    const decision = validator.validateCheckpointIntegrity(checkpoint, state, {
      expected_parent_sha: COMMIT_SHA_C, // wrong parent
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.decision, GitPolicyDecisionState.NOT_AUTHORIZED);
    assert.ok(
      decision.violations.some((v) => v.code === GitPolicyViolationCode.WRONG_PARENT_SHA)
    );
  });

  // --------------------------------------------------------------------------
  // 11. missing commit
  // --------------------------------------------------------------------------
  it('11. missing commit: missing or non-matching commit SHA is detected and rejected', () => {
    const state = createCleanMainState();

    // Checkpoint with non-matching expected commit
    const checkpoint = createCleanCheckpoint();
    const decision = validator.validateCheckpointIntegrity(checkpoint, state, {
      expected_commit_sha: COMMIT_SHA_C,
    });
    assert.equal(decision.allowed, false);
    assert.ok(
      decision.violations.some((v) => v.code === GitPolicyViolationCode.MISSING_COMMIT)
    );

    // Checkpoint schema validation rejects invalid SHA
    assert.throws(
      () =>
        createGitCheckpoint({
          phase: 'PHASE_6',
          purpose: 'PRE_FLIGHT',
          commit_sha: 'invalid-non-sha',
          branch: 'main',
          working_tree_clean: true,
        }),
      GitCheckpointIntegrityError
    );
  });

  // --------------------------------------------------------------------------
  // 12. remote verification failure
  // --------------------------------------------------------------------------
  it('12. remote verification failure: remote mismatch or missing remote verification is detected', () => {
    const state = createCleanMainState();
    const checkpoint = createGitCheckpoint({
      phase: 'PHASE_6',
      purpose: 'POST_FLIGHT',
      commit_sha: COMMIT_SHA_B,
      branch: 'main',
      working_tree_clean: true,
      remote_verified: false, // not verified
    });

    const decision = validator.validateCheckpointIntegrity(checkpoint, state, {
      require_remote_verified: true,
    });
    assert.equal(decision.allowed, false);
    assert.ok(
      decision.violations.some(
        (v) => v.code === GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED
      )
    );
  });

  // --------------------------------------------------------------------------
  // 13. clean checkpoint acceptance
  // --------------------------------------------------------------------------
  it('13. clean checkpoint acceptance: valid checkpoint matching all criteria is authorized', () => {
    const checkpoint = createCleanCheckpoint();
    const state = createCleanMainState();

    const decision = validator.validateCheckpointIntegrity(checkpoint, state, {
      expected_parent_sha: COMMIT_SHA_A,
      expected_branch: 'main',
      expected_remote: 'origin',
      require_clean_worktree: true,
      require_remote_verified: true,
      expected_commit_sha: COMMIT_SHA_B,
    });

    assert.equal(decision.allowed, true);
    assert.equal(decision.decision, GitPolicyDecisionState.AUTHORIZED);
    assert.equal(decision.violations.length, 0);
  });

  // --------------------------------------------------------------------------
  // 14. structured policy rejection
  // --------------------------------------------------------------------------
  it('14. structured policy rejection: rejections provide complete structured diagnostics', () => {
    const dirtyFeatureState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'wrong-branch',
      working_tree_clean: false,
      staged_changes: ['file1.ts'],
      unstaged_changes: ['file2.ts'],
      untracked_files: ['file3.ts'],
      status: GitStatus.DIRTY,
    });

    const decision = validator.validateOperation(
      { operation: GitOperationType.PRE_FLIGHT_CHECKPOINT },
      dirtyFeatureState
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.decision, GitPolicyDecisionState.NOT_AUTHORIZED);
    assert.ok(decision.violations.length >= 2);
    assert.ok(decision.reasons.length >= 2);
    assert.ok(typeof decision.evaluated_at === 'string');

    // Does not silently allow when state is missing
    const nullStateDecision = validator.validateOperation(
      { operation: GitOperationType.STATUS_INSPECTION },
      null
    );
    assert.equal(nullStateDecision.allowed, false);
    assert.equal(nullStateDecision.decision, GitPolicyDecisionState.NOT_AUTHORIZED);
    assert.ok(
      nullStateDecision.violations.some(
        (v) => v.code === GitPolicyViolationCode.MISSING_STATE_INFORMATION
      )
    );
  });

  // --------------------------------------------------------------------------
  // 15. deterministic policy decisions
  // --------------------------------------------------------------------------
  it('15. deterministic policy decisions: identical inputs produce strictly identical decisions', () => {
    const state = createCleanMainState();
    const intent: GitOperationIntent = {
      operation: GitOperationType.PRE_FLIGHT_CHECKPOINT,
      target_branch: 'main',
      target_remote: 'origin',
    };

    const run1 = validator.validateOperation(intent, state);
    const run2 = validator.validateOperation(intent, state);
    const run3 = validator.validateOperation(intent, state);

    assert.equal(run1.allowed, run2.allowed);
    assert.equal(run2.allowed, run3.allowed);
    assert.equal(run1.decision, run2.decision);
    assert.equal(run1.risk_level, run2.risk_level);
    assert.deepEqual(run1.violations, run2.violations);
    assert.deepEqual(run2.violations, run3.violations);
  });

  // --------------------------------------------------------------------------
  // 16. provider-neutral Git state representation
  // --------------------------------------------------------------------------
  it('16. provider-neutral Git state representation: covers all required fields and distinguishes statuses', () => {
    const state = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'main',
      remote_head_sha: COMMIT_SHA_A,
      working_tree_clean: false,
      staged_changes: ['a.txt'],
      unstaged_changes: ['b.txt'],
      untracked_files: ['c.txt'],
      divergence: { ahead: 1, behind: 2, diverged: true },
      is_detached_head: false,
      remote_sync_state: GitRemoteSyncStatus.DIVERGED,
      status: GitStatus.DIVERGED,
    });

    assert.equal(state.head_sha, COMMIT_SHA_B);
    assert.equal(state.current_branch, 'main');
    assert.equal(state.remote_head_sha, COMMIT_SHA_A);
    assert.equal(state.working_tree_clean, false);
    assert.deepEqual(state.staged_changes, ['a.txt']);
    assert.deepEqual(state.unstaged_changes, ['b.txt']);
    assert.deepEqual(state.untracked_files, ['c.txt']);
    assert.equal(state.divergence.ahead, 1);
    assert.equal(state.divergence.behind, 2);
    assert.equal(state.divergence.diverged, true);
    assert.equal(state.is_detached_head, false);
    assert.equal(state.remote_sync_state, GitRemoteSyncStatus.DIVERGED);
    assert.equal(state.status, GitStatus.DIVERGED);

    // Verify all required status distinctions
    assert.equal(GitStatus.CLEAN, 'CLEAN');
    assert.equal(GitStatus.DIRTY, 'DIRTY');
    assert.equal(GitStatus.DIVERGED, 'DIVERGED');
    assert.equal(GitStatus.DETACHED, 'DETACHED');
    assert.equal(GitStatus.UNKNOWN, 'UNKNOWN');
  });

  // --------------------------------------------------------------------------
  // 17. provider-neutral checkpoint representation
  // --------------------------------------------------------------------------
  it('17. provider-neutral checkpoint representation: records all required checkpoint properties', () => {
    const cp = createGitCheckpoint({
      checkpoint_id: 'chk-explicit-1',
      task_id: 'TASK-P6-01',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      commit_sha: COMMIT_SHA_B,
      parent_sha: COMMIT_SHA_A,
      branch: 'main',
      remote: 'origin',
      created_at: '2026-09-23T20:00:00.000Z',
      working_tree_clean: true,
      remote_verified: true,
      policy_level: RiskLevel.CAUTION,
    });

    assert.equal(cp.checkpoint_id, 'chk-explicit-1');
    assert.equal(cp.task_id, 'TASK-P6-01');
    assert.equal(cp.phase, 'PHASE_6');
    assert.equal(cp.purpose, 'PRE_FLIGHT');
    assert.equal(cp.commit_sha, COMMIT_SHA_B);
    assert.equal(cp.parent_sha, COMMIT_SHA_A);
    assert.equal(cp.branch, 'main');
    assert.equal(cp.remote, 'origin');
    assert.equal(cp.created_at, '2026-09-23T20:00:00.000Z');
    assert.equal(cp.working_tree_clean, true);
    assert.equal(cp.remote_verified, true);
    assert.equal(cp.policy_level, RiskLevel.CAUTION);
  });

  // --------------------------------------------------------------------------
  // 18. no destructive execution path
  // --------------------------------------------------------------------------
  it('18. no destructive execution path: execution adapters reject force push unconditionally', async () => {
    const fakePort = new FakeGitPort();
    const authorizedFakeDecision = {
      allowed: true,
      decision: GitPolicyDecisionState.AUTHORIZED,
      risk_level: RiskLevel.CRITICAL,
      operation: GitOperationType.FORCE_PUSH,
      reasons: [],
      requires_human_approval: false,
      violations: [],
      evaluated_at: new Date().toISOString(),
    };

    // Even if an unauthorized or forged authorization is passed, force push must throw
    await assert.rejects(
      async () => {
        await fakePort.executeAuthorizedOperation(
          { operation: GitOperationType.FORCE_PUSH },
          authorizedFakeDecision,
          process.cwd()
        );
      },
      (err) => err instanceof GitForcePushProhibitedError
    );

    // Intent with force: true must also throw
    await assert.rejects(
      async () => {
        await fakePort.executeAuthorizedOperation(
          { operation: GitOperationType.PUSH, force: true },
          authorizedFakeDecision,
          process.cwd()
        );
      },
      (err) => err instanceof GitForcePushProhibitedError
    );

    // DefaultGitPort also refuses force push unconditionally
    const defaultPort = new DefaultGitPort();
    await assert.rejects(
      async () => {
        await defaultPort.executeAuthorizedOperation(
          { operation: GitOperationType.FORCE_PUSH },
          authorizedFakeDecision,
          process.cwd()
        );
      },
      (err) => err instanceof GitForcePushProhibitedError
    );
  });

  // --------------------------------------------------------------------------
  // 19. human-approval-required classification
  // --------------------------------------------------------------------------
  it('19. human-approval-required classification: DANGEROUS operations require verified human authorization', () => {
    const state = createCleanMainState();
    const rollbackIntent: GitOperationIntent = {
      operation: GitOperationType.ROLLBACK_REQUEST,
    };

    // Without token: decision is HUMAN_REQUIRED
    const decisionNoToken = validator.validateOperation(rollbackIntent, state);
    assert.equal(decisionNoToken.allowed, false);
    assert.equal(decisionNoToken.decision, GitPolicyDecisionState.HUMAN_REQUIRED);
    assert.equal(decisionNoToken.requires_human_approval, true);
    assert.equal(decisionNoToken.risk_level, RiskLevel.DANGEROUS);
    assert.ok(
      decisionNoToken.violations.some(
        (v) => v.code === GitPolicyViolationCode.HUMAN_APPROVAL_REQUIRED
      )
    );

    // With human approval token: decision becomes AUTHORIZED
    const authorizedIntent: GitOperationIntent = {
      ...rollbackIntent,
      human_approval_token: 'auth-director-token-12345',
    };
    const decisionAuthorized = validator.validateOperation(authorizedIntent, state);
    assert.equal(decisionAuthorized.allowed, true);
    assert.equal(decisionAuthorized.decision, GitPolicyDecisionState.AUTHORIZED);
    assert.equal(decisionAuthorized.requires_human_approval, true);
    assert.equal(decisionAuthorized.risk_level, RiskLevel.DANGEROUS);
  });

  // --------------------------------------------------------------------------
  // 20. no mutation during policy validation
  // --------------------------------------------------------------------------
  it('20. no mutation during policy validation: inputs remain strictly unchanged', () => {
    const originalState = Object.freeze(createCleanMainState());
    const originalIntent: GitOperationIntent = Object.freeze({
      operation: GitOperationType.PRE_FLIGHT_CHECKPOINT,
      target_branch: 'main',
      target_remote: 'origin',
    });
    const originalCheckpoint = Object.freeze(createCleanCheckpoint());
    const originalConfig: Partial<GitPolicyConfig> = Object.freeze({
      configured_branch: 'main',
      configured_remote: 'origin',
    });

    // Run validateOperation
    validator.validateOperation(originalIntent, originalState, originalConfig);

    // Run validateCheckpointIntegrity
    validator.validateCheckpointIntegrity(originalCheckpoint, originalState, {
      expected_parent_sha: COMMIT_SHA_A,
      expected_branch: 'main',
    });

    // Ensure state and checkpoint remain completely intact
    assert.equal(originalState.head_sha, COMMIT_SHA_B);
    assert.equal(originalState.current_branch, 'main');
    assert.equal(originalState.working_tree_clean, true);
    assert.equal(originalCheckpoint.commit_sha, COMMIT_SHA_B);
    assert.equal(originalCheckpoint.parent_sha, COMMIT_SHA_A);
  });

  // --------------------------------------------------------------------------
  // Extra tests: Execution Boundary and History Divergence
  // --------------------------------------------------------------------------
  it('History divergence rejects normal push to prevent accidental force requirement', () => {
    const divergedState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'main',
      working_tree_clean: true,
      staged_changes: [],
      unstaged_changes: [],
      untracked_files: [],
      divergence: { ahead: 2, behind: 3, diverged: true },
      remote_sync_state: GitRemoteSyncStatus.DIVERGED,
      status: GitStatus.DIVERGED,
    });

    const decision = validator.validateOperation(
      { operation: GitOperationType.PUSH },
      divergedState
    );
    assert.equal(decision.allowed, false);
    assert.ok(
      decision.violations.some(
        (v) => v.code === GitPolicyViolationCode.HISTORY_DIVERGENCE_DETECTED
      )
    );
  });

  it('Execution Port executes authorized pre-flight checkpoint and records results', async () => {
    const fakePort = new FakeGitPort({
      initialState: {
        head_sha: COMMIT_SHA_B,
        current_branch: 'main',
        working_tree_clean: true,
      },
    });

    const state = await fakePort.inspectState(process.cwd());
    const intent: GitOperationIntent = {
      operation: GitOperationType.PRE_FLIGHT_CHECKPOINT,
      checkpoint_id: 'chk-exec-test',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      expected_commit_sha: COMMIT_SHA_B,
      expected_parent_sha: COMMIT_SHA_A,
    };

    const authorization = validator.validateOperation(intent, state);
    assert.equal(authorization.allowed, true);

    const execResult = await fakePort.executeAuthorizedOperation(
      intent,
      authorization,
      process.cwd()
    );
    assert.equal(execResult.success, true);
    assert.equal(execResult.operation, GitOperationType.PRE_FLIGHT_CHECKPOINT);
    assert.ok(execResult.checkpoint);
    assert.equal(execResult.checkpoint?.checkpoint_id, 'chk-exec-test');
    assert.equal(execResult.checkpoint?.commit_sha, COMMIT_SHA_B);
  });
});
