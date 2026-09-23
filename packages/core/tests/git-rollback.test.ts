import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RiskLevel,
  GitOperationType,
  GitStatus,
  GitRollbackStage,
  GitRollbackStatus,
  GitPolicyDecisionState,
  GitPolicyViolationCode,
  GitPolicyValidator,
  DEFAULT_GIT_POLICY_CONFIG,
  createGitState,
  createGitCheckpoint,
  FakeGitPort,
  DefaultGitPort,
  GitPolicyError,
  GitForcePushProhibitedError,
  GitCheckpointIntegrityError,
  GitDirtyWorktreeError,
  GitDetachedHeadError,
  GitBranchMismatchError,
  GitParentMismatchError,
  GitRollbackError,
  GitRollbackAuthorizationError,
  GitRollbackVerificationError,
  GitRollbackExecutionError,
  GitCheckpointNotFoundError,
  GitCheckpointNotKnownGoodError,
  GitTargetCommitMissingError,
  GitCheckpointManager,
  GitRollbackManager,
  type GitState,
  type GitCheckpoint,
  type GitOperationIntent,
  type KnownGoodCheckpoint,
} from '../dist/index.js';

// ============================================================================
// FIXTURES
// ============================================================================

const COMMIT_SHA_BASE = '1111111111111111111111111111111111111111';
const COMMIT_SHA_MID = '2222222222222222222222222222222222222222';
const COMMIT_SHA_HEAD = '3333333333333333333333333333333333333333';
const COMMIT_SHA_UNKNOWN = '4444444444444444444444444444444444444444';
const VALID_AUTH_TOKEN = 'auth-token-director-verified-998877';

function createCleanCheckpoint(overrides?: Partial<GitCheckpoint>): KnownGoodCheckpoint {
  const base = createGitCheckpoint({
    checkpoint_id: 'chk_task_001_pre_flight_11111111_abc123',
    task_id: 'task-001',
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
// TEST SUITE: P6-03 — ATOMIC GIT ROLLBACK / RECOVERY OPERATIONS
// ============================================================================

describe('P6-03 — Atomic Git Rollback / Recovery Operations', () => {
  let fakePort: FakeGitPort;
  let validator: GitPolicyValidator;
  let checkpointManager: GitCheckpointManager;
  let rollbackManager: GitRollbackManager;
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
    knownGoodCheckpoint = createCleanCheckpoint();
  });

  // --------------------------------------------------------------------------
  // 1. Valid rollback to known-good checkpoint
  // --------------------------------------------------------------------------
  it('1. valid rollback to known-good checkpoint: restores repository state and verifies postconditions', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, GitRollbackStatus.VERIFIED);
    assert.equal(result.stage, GitRollbackStage.COMPLETED);
    assert.equal(result.checkpoint_id, knownGoodCheckpoint.checkpoint_id);
    assert.equal(result.target_commit_sha, knownGoodCheckpoint.commit_sha);
    assert.equal(result.previous_head_sha, COMMIT_SHA_HEAD);
    assert.equal(result.resulting_head_sha, COMMIT_SHA_BASE);
    assert.equal(result.previous_branch, 'main');
    assert.equal(result.resulting_branch, 'main');
    assert.equal(result.authorization_status, GitPolicyDecisionState.AUTHORIZED);
    assert.equal(result.execution_status, 'COMPLETED');
    assert.equal(result.verification_status, 'VERIFIED');
    assert.equal(result.requires_reconciliation, false);

    // Verify repository state was actually updated in the port
    const stateAfter = await fakePort.inspectState(process.cwd());
    assert.equal(stateAfter.head_sha, COMMIT_SHA_BASE);
    assert.equal(stateAfter.current_branch, 'main');
    assert.equal(stateAfter.working_tree_clean, true);
  });

  // --------------------------------------------------------------------------
  // 2. Checkpoint must exist
  // --------------------------------------------------------------------------
  it('2. checkpoint must exist: missing checkpoint ID lookup rejects with structured error', async () => {
    // Calling with non-existent ID string without throwOnError
    const result = await rollbackManager.rollbackToCheckpoint('chk_non_existent_id', {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'CHECKPOINT_NOT_FOUND');
    assert.match(result.error ?? '', /not found/i);

    // With throwOnError: throws GitCheckpointNotFoundError
    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint('chk_non_existent_id', {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointNotFoundError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 3. Checkpoint must be known-good
  // --------------------------------------------------------------------------
  it('3. checkpoint must be known-good: unverified checkpoint rejects rollback', async () => {
    const unverifiedCheckpoint = createGitCheckpoint({
      checkpoint_id: 'chk_unverified_001',
      task_id: 'task-001',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      commit_sha: COMMIT_SHA_BASE,
      branch: 'main',
      remote: 'origin',
      working_tree_clean: true,
    }); // Not wrapped as KnownGoodCheckpoint (no is_known_good: true)

    const result = await rollbackManager.rollbackToCheckpoint(unverifiedCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'CHECKPOINT_NOT_KNOWN_GOOD');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(unverifiedCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointNotKnownGoodError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 4. Invalid checkpoint rejected
  // --------------------------------------------------------------------------
  it('4. invalid checkpoint rejected: malformed checkpoint schema is rejected deterministically', async () => {
    const malformedCheckpoint = {
      checkpoint_id: '',
      commit_sha: COMMIT_SHA_BASE,
      branch: '',
      is_known_good: true,
    } as unknown as GitCheckpoint;

    const result = await rollbackManager.rollbackToCheckpoint(malformedCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'INVALID_CHECKPOINT_SCHEMA');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(malformedCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointIntegrityError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 5. Invalid commit SHA rejected
  // --------------------------------------------------------------------------
  it('5. invalid commit SHA rejected: non-hex or malformed target commit SHA is rejected', async () => {
    const badShaCheckpoint = {
      checkpoint_id: 'chk_task_001_pre_flight_bad_sha',
      task_id: 'task-001',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      commit_sha: 'invalid-sha-not-40-hex-characters-zzz!',
      parent_sha: null,
      branch: 'main',
      remote: 'origin',
      created_at: new Date().toISOString(),
      working_tree_clean: true,
      remote_verified: true,
      policy_level: RiskLevel.CAUTION,
      is_known_good: true,
    } as unknown as GitCheckpoint;

    const result = await rollbackManager.rollbackToCheckpoint(badShaCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'INVALID_COMMIT_SHA');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(badShaCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointIntegrityError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 6. Missing target commit rejected
  // --------------------------------------------------------------------------
  it('6. missing target commit rejected: SHA not present in repo object database is rejected', async () => {
    const missingShaCheckpoint = createCleanCheckpoint({
      commit_sha: COMMIT_SHA_UNKNOWN, // Not in fakePort.knownCommits
    });

    const result = await rollbackManager.rollbackToCheckpoint(missingShaCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'TARGET_COMMIT_MISSING');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(missingShaCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitTargetCommitMissingError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 7. Branch mismatch rejected
  // --------------------------------------------------------------------------
  it('7. branch mismatch rejected: repository or checkpoint branch mismatch is rejected', async () => {
    // Current branch is 'main', checkpoint is for 'feature/p6'
    const branchMismatchCheckpoint = createCleanCheckpoint({
      branch: 'feature/p6',
    });

    const result = await rollbackManager.rollbackToCheckpoint(branchMismatchCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'BRANCH_MISMATCH');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(branchMismatchCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitBranchMismatchError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 8. Parent mismatch rejected
  // --------------------------------------------------------------------------
  it('8. parent mismatch rejected: expected parent mismatch is rejected before and verified after', async () => {
    const parentCheckpoint = createCleanCheckpoint({
      parent_sha: COMMIT_SHA_BASE,
    });

    // Caller expects a different parent SHA
    const result = await rollbackManager.rollbackToCheckpoint(parentCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
      expected_parent_sha: COMMIT_SHA_MID, // Mismatch
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'WRONG_PARENT_SHA');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(parentCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          expected_parent_sha: COMMIT_SHA_MID,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitParentMismatchError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 9. Detached HEAD rejected
  // --------------------------------------------------------------------------
  it('9. detached HEAD rejected: repository in detached HEAD state rejects rollback', async () => {
    fakePort.currentState = createRepoState({
      is_detached_head: true,
      status: GitStatus.DETACHED,
      current_branch: null,
    });

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'DETACHED_HEAD_PROHIBITED');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitDetachedHeadError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 10. Clean workspace accepted
  // --------------------------------------------------------------------------
  it('10. clean workspace accepted: completely clean worktree executes rollback successfully', async () => {
    fakePort.currentState = createRepoState({
      working_tree_clean: true,
      staged_changes: [],
      unstaged_changes: [],
      untracked_files: [],
      status: GitStatus.CLEAN,
    });

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, GitRollbackStatus.VERIFIED);
  });

  // --------------------------------------------------------------------------
  // 11. Dirty workspace rejected when preservation contract is unavailable
  // --------------------------------------------------------------------------
  it('11. dirty workspace rejected: uncommitted unstaged/staged/untracked files reject rollback without mutation', async () => {
    fakePort.currentState = createRepoState({
      working_tree_clean: false,
      unstaged_changes: ['packages/core/src/index.ts'],
      status: GitStatus.DIRTY,
    });

    const initialHead = fakePort.currentState.head_sha;

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'DIRTY_WORKTREE_PROHIBITED');

    // Verify HEAD was NOT mutated
    assert.equal(fakePort.currentState.head_sha, initialHead);

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitDirtyWorktreeError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 12. Missing authorization rejected
  // --------------------------------------------------------------------------
  it('12. missing authorization rejected: rollback without human authorization token is blocked', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      // human_approval_token is omitted
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.failure_code, 'HUMAN_APPROVAL_REQUIRED');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitRollbackAuthorizationError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 13. Invalid authorization rejected
  // --------------------------------------------------------------------------
  it('13. invalid authorization rejected: whitespace or expired authorization tokens are blocked', async () => {
    // Empty whitespace token
    const resultWhitespace = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: '   ',
    });
    assert.equal(resultWhitespace.success, false);
    assert.equal(resultWhitespace.failure_code, 'HUMAN_APPROVAL_REQUIRED');

    // Config with token validator rejecting expired token
    const customManager = new GitRollbackManager(fakePort, {
      policyConfig: {
        validateHumanApprovalToken: (token: string) => {
          if (token.startsWith('expired-')) {
            return { valid: false, reason: 'Authorization token has expired' };
          }
          return true;
        },
      },
    });

    const resultExpired = await customManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: 'expired-token-12345',
    });
    assert.equal(resultExpired.success, false);
    assert.equal(resultExpired.failure_code, 'HUMAN_APPROVAL_REQUIRED');
  });

  // --------------------------------------------------------------------------
  // 14. Valid dangerous authorization accepted
  // --------------------------------------------------------------------------
  it('14. valid dangerous authorization accepted: verified human token allows rollback execution', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);
    assert.equal(result.authorization_status, GitPolicyDecisionState.AUTHORIZED);
    assert.equal(result.status, GitRollbackStatus.VERIFIED);
  });

  // --------------------------------------------------------------------------
  // 15. Policy validator invoked
  // --------------------------------------------------------------------------
  it('15. policy validator invoked: policyValidator evaluates the dangerous rollback intent', async () => {
    let validatorCalled = false;
    const trackingValidator = new GitPolicyValidator();
    const originalValidate = trackingValidator.validateOperation.bind(trackingValidator);
    trackingValidator.validateOperation = (intent, state, config) => {
      validatorCalled = true;
      return originalValidate(intent, state, config);
    };

    const managerWithTracking = new GitRollbackManager(fakePort, trackingValidator);
    const result = await managerWithTracking.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(validatorCalled, true);
    assert.equal(result.success, true);
    assert.ok(result.policy_decision);
  });

  // --------------------------------------------------------------------------
  // 16. Rollback classified as DANGEROUS
  // --------------------------------------------------------------------------
  it('16. rollback classified as DANGEROUS: risk level is strictly DANGEROUS, never SAFE or CAUTION', () => {
    const riskReq = validator.classifyOperation(GitOperationType.ROLLBACK_REQUEST);
    const riskRollback = validator.classifyOperation(GitOperationType.ROLLBACK);

    assert.equal(riskReq, RiskLevel.DANGEROUS);
    assert.equal(riskRollback, RiskLevel.DANGEROUS);
    assert.notEqual(riskReq, RiskLevel.SAFE);
    assert.notEqual(riskReq, RiskLevel.CAUTION);
  });

  // --------------------------------------------------------------------------
  // 17. CRITICAL remote rewrite rejected
  // --------------------------------------------------------------------------
  it('17. CRITICAL remote rewrite rejected: destructive operations are unconditionally prohibited', () => {
    const state = createRepoState();
    const rewriteIntent: GitOperationIntent = {
      operation: GitOperationType.DESTRUCTIVE_REMOTE_REWRITE,
      target_branch: 'main',
      target_remote: 'origin',
      human_approval_token: VALID_AUTH_TOKEN,
    };

    const decision = validator.validateOperation(rewriteIntent, state);
    assert.equal(decision.allowed, false);
    assert.equal(decision.risk_level, RiskLevel.CRITICAL);
    assert.ok(decision.violations.some((v) => v.code === GitPolicyViolationCode.FORCE_PUSH_PROHIBITED));
  });

  // --------------------------------------------------------------------------
  // 18. Force push rejected
  // --------------------------------------------------------------------------
  it('18. force push rejected: intent with force: true is unconditionally prohibited by policy and port', async () => {
    const state = createRepoState();
    const forceIntent: GitOperationIntent = {
      operation: GitOperationType.PUSH,
      force: true,
      target_branch: 'main',
      human_approval_token: VALID_AUTH_TOKEN,
    };

    const decision = validator.validateOperation(forceIntent, state);
    assert.equal(decision.allowed, false);
    assert.equal(decision.risk_level, RiskLevel.CRITICAL);

    // Port directly rejects force execution unconditionally
    await assert.rejects(
      async () => {
        await fakePort.executeAuthorizedOperation(forceIntent, decision, process.cwd());
      },
      (err: unknown) => {
        assert.ok(err instanceof GitForcePushProhibitedError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 19. Force-with-lease rejected
  // --------------------------------------------------------------------------
  it('19. force-with-lease rejected: DefaultGitPort never passes force flags to git commands', () => {
    const defaultPort = new DefaultGitPort();
    // DefaultGitPort implementation rejects force: true unconditionally
    const forceIntent: GitOperationIntent = {
      operation: GitOperationType.PUSH,
      force: true,
    };
    const fakeDecision = {
      allowed: true, // Forged decision
      decision: GitPolicyDecisionState.AUTHORIZED,
      risk_level: RiskLevel.CRITICAL,
      operation: GitOperationType.PUSH,
      reasons: [],
      requires_human_approval: false,
      violations: [],
      evaluated_at: new Date().toISOString(),
    };

    assert.rejects(
      async () => {
        await defaultPort.executeAuthorizedOperation(forceIntent, fakeDecision, process.cwd());
      },
      (err: unknown) => {
        assert.ok(err instanceof GitForcePushProhibitedError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 20. Rollback execution failure reported
  // --------------------------------------------------------------------------
  it('20. rollback execution failure reported: port execution failure sets requires_reconciliation', async () => {
    fakePort.simulateExecutionFailure = true;
    fakePort.executionFailureError = 'Simulated hardware or git lock failure';

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.stage, GitRollbackStage.FAILED);
    assert.equal(result.execution_status, 'FAILED');
    assert.equal(result.requires_reconciliation, true);
    assert.equal(result.failure_code, 'ROLLBACK_EXECUTION_FAILURE');
  });

  // --------------------------------------------------------------------------
  // 21. Post-rollback HEAD verification
  // --------------------------------------------------------------------------
  it('21. post-rollback HEAD verification: failure when HEAD does not match target commit SHA', async () => {
    fakePort.simulatePostRollbackState = {
      head_sha: COMMIT_SHA_MID, // Wrong HEAD after rollback
    };

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, GitRollbackStatus.FAILED);
    assert.equal(result.verification_status, 'FAILED');
    assert.equal(result.requires_reconciliation, true);
    assert.equal(result.failure_code, 'ROLLBACK_VERIFICATION_FAILURE');

    await assert.rejects(
      async () => {
        await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
          human_approval_token: VALID_AUTH_TOKEN,
          throw_on_error: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitRollbackVerificationError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 22. Post-rollback branch verification
  // --------------------------------------------------------------------------
  it('22. post-rollback branch verification: failure when branch does not match checkpoint branch', async () => {
    fakePort.simulatePostRollbackState = {
      current_branch: 'other-branch',
    };

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.verification_status, 'FAILED');
    assert.equal(result.requires_reconciliation, true);
  });

  // --------------------------------------------------------------------------
  // 23. Post-rollback checkpoint verification
  // --------------------------------------------------------------------------
  it('23. post-rollback checkpoint verification: ensures parent SHA integrity is preserved post-rollback', async () => {
    const cpWithParent = createCleanCheckpoint({
      parent_sha: '0000000000000000000000000000000000000001',
    });

    fakePort.simulatePostRollbackState = {
      parent_sha: '9999999999999999999999999999999999999999', // Mismatched parent
    };

    const result = await rollbackManager.rollbackToCheckpoint(cpWithParent, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.equal(result.verification_status, 'FAILED');
    assert.equal(result.requires_reconciliation, true);
  });

  // --------------------------------------------------------------------------
  // 24. Remote verification accurately represented
  // --------------------------------------------------------------------------
  it('24. remote verification accurately represented: reflects remote divergence without destructive sync', async () => {
    // Remote has diverged from rollback commit
    fakePort.remoteVerificationResult = Object.freeze({
      verified: true,
      remoteHeadSha: COMMIT_SHA_HEAD, // Remote is on original HEAD, not rolled-back commit
    });

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
      verify_remote: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, GitRollbackStatus.VERIFIED);
    // Remote status truthfully reflects that remote is not identical to local rollback target
    assert.notEqual(result.remote_verification_status, 'VERIFIED');
    // Ensure no push operations were invoked
    const pushOps = fakePort.executedOperations.filter((op) => op.intent.operation === GitOperationType.PUSH);
    assert.equal(pushOps.length, 0);
  });

  // --------------------------------------------------------------------------
  // 25. Partial execution does not report success
  // --------------------------------------------------------------------------
  it('25. partial execution does not report success: failures halfway through report failed status', async () => {
    fakePort.simulatePostRollbackState = {
      working_tree_clean: false,
      unstaged_changes: ['dirty.txt'],
    };

    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, false);
    assert.notEqual(result.status, GitRollbackStatus.VERIFIED);
    assert.equal(result.requires_reconciliation, true);
  });

  // --------------------------------------------------------------------------
  // 26. Deterministic rollback result
  // --------------------------------------------------------------------------
  it('26. deterministic rollback result: identical inputs produce identical outcome structure', async () => {
    const res1 = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    // Reset repo state to head
    fakePort.currentState = createRepoState();

    const res2 = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(res1.success, res2.success);
    assert.equal(res1.target_commit_sha, res2.target_commit_sha);
    assert.equal(res1.previous_head_sha, res2.previous_head_sha);
    assert.equal(res1.resulting_head_sha, res2.resulting_head_sha);
    assert.equal(res1.status, res2.status);
    assert.equal(res1.stage, res2.stage);
  });

  // --------------------------------------------------------------------------
  // 27. Provider neutrality
  // --------------------------------------------------------------------------
  it('27. provider neutrality: no child_process or raw system handles in GitRollbackResult', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(typeof result, 'object');
    // Check all properties are serializable plain data
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    assert.equal(parsed.success, true);
    assert.equal(parsed.checkpoint_id, knownGoodCheckpoint.checkpoint_id);
    assert.equal(parsed.resulting_head_sha, COMMIT_SHA_BASE);
  });

  // --------------------------------------------------------------------------
  // 28. No direct shell/process dependency in recovery manager
  // --------------------------------------------------------------------------
  it('28. no direct shell/process dependency: recovery manager source contains zero raw shell or child_process imports', () => {
    const currentFile = fileURLToPath(import.meta.url);
    const srcDir = path.resolve(path.dirname(currentFile), '../src/git');
    const managerFile = path.join(srcDir, 'git-rollback-manager.ts');

    const content = fs.readFileSync(managerFile, 'utf-8');
    assert.equal(content.includes('child_process'), false);
    assert.equal(content.includes('execFile'), false);
    assert.equal(content.includes('spawn'), false);
    assert.equal(content.includes('exec('), false);
  });

  // --------------------------------------------------------------------------
  // 29. Authorization token never appears in result/error output
  // --------------------------------------------------------------------------
  it('29. authorization token never appears in result/error output: secret sanitization verified', async () => {
    const SECRET_TOKEN = 'super-secret-director-token-xyz-987';

    // Check successful result
    const successResult = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: SECRET_TOKEN,
    });
    const successJson = JSON.stringify(successResult);
    assert.equal(successJson.includes(SECRET_TOKEN), false);

    // Check failure result
    fakePort.simulateExecutionFailure = true;
    const failResult = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: SECRET_TOKEN,
    });
    const failJson = JSON.stringify(failResult);
    assert.equal(failJson.includes(SECRET_TOKEN), false);

    // Check thrown error
    try {
      await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
        human_approval_token: SECRET_TOKEN,
        throw_on_error: true,
      });
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const errString = JSON.stringify(err);
      const errMsg = (err as Error).message;
      assert.equal(errMsg.includes(SECRET_TOKEN), false);
      assert.equal(errString.includes(SECRET_TOKEN), false);
    }
  });

  // --------------------------------------------------------------------------
  // 30. Checkpoint identity preserved
  // --------------------------------------------------------------------------
  it('30. checkpoint identity preserved: result contains exact target checkpoint ID', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.checkpoint_id, knownGoodCheckpoint.checkpoint_id);
    assert.equal(result.checkpointId, knownGoodCheckpoint.checkpoint_id);
  });

  // --------------------------------------------------------------------------
  // 31. Previous HEAD recorded
  // --------------------------------------------------------------------------
  it('31. previous HEAD recorded: result records repository HEAD prior to rollback', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.previous_head_sha, COMMIT_SHA_HEAD);
    assert.equal(result.previousHeadSha, COMMIT_SHA_HEAD);
  });

  // --------------------------------------------------------------------------
  // 32. Resulting HEAD recorded
  // --------------------------------------------------------------------------
  it('32. resulting HEAD recorded: result records repository HEAD after rollback', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.resulting_head_sha, COMMIT_SHA_BASE);
    assert.equal(result.resultingHeadSha, COMMIT_SHA_BASE);
  });

  // --------------------------------------------------------------------------
  // 33. Repeated verification is deterministic
  // --------------------------------------------------------------------------
  it('33. repeated verification is deterministic: repeated checks yield identical outcomes', async () => {
    const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
      human_approval_token: VALID_AUTH_TOKEN,
    });

    assert.equal(result.success, true);

    // Verify checkpoint again against the state after rollback
    const verify1 = await checkpointManager.verifyCheckpoint(knownGoodCheckpoint, {
      currentState: result.observed_state_after,
      require_remote_verified: false,
    });
    const verify2 = await checkpointManager.verifyCheckpoint(knownGoodCheckpoint, {
      currentState: result.observed_state_after,
      require_remote_verified: false,
    });

    assert.equal(verify1.valid, true);
    assert.equal(verify2.valid, true);
    assert.equal(verify1.commit_sha, verify2.commit_sha);
  });

  // ==========================================================================
  // SECURITY TESTS
  // ==========================================================================
  describe('Security Tests', () => {
    it('Sec-1: cannot bypass GitPolicyValidator: invalid intent cannot be executed', async () => {
      // Trying to rollback to an unverified checkpoint without token
      const unverified = createGitCheckpoint({
        checkpoint_id: 'chk_fake',
        task_id: 'task-fake',
        phase: 'PHASE_6',
        purpose: 'PRE_FLIGHT',
        commit_sha: COMMIT_SHA_BASE,
        branch: 'main',
        working_tree_clean: true,
      });

      const result = await rollbackManager.rollbackToCheckpoint(unverified, {});
      assert.equal(result.success, false);
      assert.equal(result.status, GitRollbackStatus.FAILED);
      // Execution in port was never invoked
      assert.equal(fakePort.executedOperations.length, 0);
    });

    it('Sec-2: cannot force push or force-with-lease: unconditionally rejected', async () => {
      await assert.rejects(
        async () => {
          await fakePort.executeAuthorizedOperation(
            { operation: GitOperationType.FORCE_PUSH, force: true },
            {
              allowed: true,
              decision: GitPolicyDecisionState.AUTHORIZED,
              risk_level: RiskLevel.CRITICAL,
              operation: GitOperationType.FORCE_PUSH,
              reasons: [],
              requires_human_approval: false,
              violations: [],
              evaluated_at: new Date().toISOString(),
            },
            process.cwd()
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof GitForcePushProhibitedError);
          return true;
        }
      );
    });

    it('Sec-3: cannot rewrite remote history: remote sync never forces or rewrites remote', async () => {
      const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
        human_approval_token: VALID_AUTH_TOKEN,
        verify_remote: true,
      });

      assert.equal(result.success, true);
      // Verify no destructive operations recorded
      const destructiveOps = fakePort.executedOperations.filter(
        (op) =>
          op.intent.force === true ||
          op.intent.operation === GitOperationType.FORCE_PUSH ||
          op.intent.operation === GitOperationType.DESTRUCTIVE_REMOTE_REWRITE
      );
      assert.equal(destructiveOps.length, 0);
    });

    it('Sec-4: cannot silently destroy dirty worktree data', async () => {
      fakePort.currentState = createRepoState({
        working_tree_clean: false,
        unstaged_changes: ['important-unsaved-work.ts'],
      });

      const result = await rollbackManager.rollbackToCheckpoint(knownGoodCheckpoint, {
        human_approval_token: VALID_AUTH_TOKEN,
      });

      assert.equal(result.success, false);
      assert.equal(result.failure_code, 'DIRTY_WORKTREE_PROHIBITED');
      // No operations executed
      assert.equal(fakePort.executedOperations.length, 0);
    });

    it('Sec-5: delegation through GitCheckpointManager.rollbackToCheckpoint preserves all guarantees', async () => {
      // Register checkpoint in manager
      checkpointManager['checkpoints'].set(knownGoodCheckpoint.checkpoint_id, knownGoodCheckpoint);

      const result = await checkpointManager.rollbackToCheckpoint(knownGoodCheckpoint.checkpoint_id, {
        human_approval_token: VALID_AUTH_TOKEN,
      });

      assert.equal(result.success, true);
      assert.equal(result.checkpoint_id, knownGoodCheckpoint.checkpoint_id);
      assert.equal(result.resulting_head_sha, COMMIT_SHA_BASE);
      assert.equal(result.status, GitRollbackStatus.VERIFIED);
    });
  });
});
