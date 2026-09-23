import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RiskLevel,
  GitOperationType,
  GitStatus,
  GitRemoteSyncStatus,
  GitPolicyViolationCode,
  GitPolicyValidator,
  DEFAULT_GIT_POLICY_CONFIG,
  createGitState,
  createGitCheckpoint,
  FakeGitPort,
  GitPolicyError,
  GitForcePushProhibitedError,
  GitCheckpointIntegrityError,
  GitDirtyWorktreeError,
  GitDetachedHeadError,
  GitBranchMismatchError,
  GitRemoteMismatchError,
  GitRemoteVerificationError,
  GitParentMismatchError,
  GitCheckpointManager,
  generateDeterministicCheckpointId,
  type GitState,
  type GitCheckpoint,
  type GitPort,
  type RemoteVerificationResult,
} from '../dist/index.js';

// ============================================================================
// FIXTURES
// ============================================================================

const COMMIT_SHA_A = '1111111111111111111111111111111111111111';
const COMMIT_SHA_B = '2222222222222222222222222222222222222222';
const COMMIT_SHA_C = '3333333333333333333333333333333333333333';

function createCleanPort(initialState?: Partial<GitState>): FakeGitPort {
  return new FakeGitPort({
    initialState: {
      head_sha: COMMIT_SHA_B,
      current_branch: 'main',
      remote_head_sha: COMMIT_SHA_B,
      parent_sha: COMMIT_SHA_A,
      working_tree_clean: true,
      staged_changes: [],
      unstaged_changes: [],
      untracked_files: [],
      is_detached_head: false,
      remote_sync_state: GitRemoteSyncStatus.UP_TO_DATE,
      status: GitStatus.CLEAN,
      ...initialState,
    },
    remoteVerificationResult: {
      verified: true,
      remoteHeadSha: COMMIT_SHA_B,
    },
  });
}

function createCleanCheckpointFixture(): GitCheckpoint {
  return createGitCheckpoint({
    checkpoint_id: 'chk_test_checkpoint_001',
    task_id: 'TASK-P6-02',
    phase: 'PHASE_6',
    purpose: 'PRE_FLIGHT',
    commit_sha: COMMIT_SHA_B,
    parent_sha: COMMIT_SHA_A,
    branch: 'main',
    remote: 'origin',
    working_tree_clean: true,
    remote_verified: false,
    policy_level: RiskLevel.CAUTION,
  });
}

describe('P6-02 — Git Checkpoint Manager', () => {
  let fakePort: FakeGitPort;
  let manager: GitCheckpointManager;

  beforeEach(() => {
    fakePort = createCleanPort();
    manager = new GitCheckpointManager(fakePort);
  });

  // --------------------------------------------------------------------------
  // 1. Valid checkpoint creation
  // --------------------------------------------------------------------------
  it('1. valid checkpoint creation: creates and verifies known-good checkpoint', async () => {
    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'PRE_FLIGHT',
      expected_parent_sha: COMMIT_SHA_A,
    });

    assert.equal(cp.is_known_good, true);
    assert.equal(cp.task_id, 'TASK-P6-02');
    assert.equal(cp.purpose, 'PRE_FLIGHT');
    assert.equal(cp.commit_sha, COMMIT_SHA_B);
    assert.equal(cp.parent_sha, COMMIT_SHA_A);
    assert.equal(cp.branch, 'main');
    assert.equal(cp.remote, 'origin');
    assert.equal(cp.working_tree_clean, true);
    assert.equal(cp.remote_verified, false);
    assert.equal(cp.policy_level, RiskLevel.CAUTION);
    assert.ok(cp.checkpoint_id.startsWith('chk_TASK_P6_02_pre_flight_'));

    // Check distinctions preserved
    assert.ok(cp.observed_state);
    assert.equal(cp.observed_state.head_sha, COMMIT_SHA_B);
    assert.ok(cp.policy_decision);
    assert.equal(cp.policy_decision.allowed, true);
    assert.ok(cp.execution_result);
    assert.equal(cp.execution_result.success, true);
    assert.ok(cp.checkpoint);

    // Retrievable from manager
    const retrieved = manager.getCheckpoint(cp.checkpoint_id);
    assert.ok(retrieved);
    assert.equal(retrieved.checkpoint_id, cp.checkpoint_id);

    // Listed in manager
    const list = manager.listCheckpoints();
    assert.equal(list.length, 1);
    assert.equal(list[0].checkpoint_id, cp.checkpoint_id);
  });

  // --------------------------------------------------------------------------
  // 2. Checkpoint metadata validation
  // --------------------------------------------------------------------------
  it('2. checkpoint metadata validation: preserves and freezes metadata', async () => {
    const meta = { environment: 'production', ticket: 'SEC-101', depth: 3 };
    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'POST_FLIGHT',
      metadata: meta,
    });

    assert.deepEqual(cp.metadata, meta);
    assert.ok(Object.isFrozen(cp.metadata));
  });

  // --------------------------------------------------------------------------
  // 3. Missing task_id rejection
  // --------------------------------------------------------------------------
  it('3. missing task_id rejection: rejects empty, whitespace, or missing task_id deterministically', async () => {
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: '',
          purpose: 'PRE_FLIGHT',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointIntegrityError);
        assert.equal((err as GitPolicyError).code, 'ERR_GIT_CHECKPOINT_INTEGRITY');
        assert.ok((err as Error).message.includes('task_id is required'));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: '   ',
          purpose: 'PRE_FLIGHT',
        });
      },
      GitCheckpointIntegrityError
    );

    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: undefined as unknown as string,
          purpose: 'PRE_FLIGHT',
        });
      },
      GitCheckpointIntegrityError
    );

    assert.equal(manager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 4. Missing purpose rejection
  // --------------------------------------------------------------------------
  it('4. missing purpose rejection: rejects empty, whitespace, or missing purpose deterministically', async () => {
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: '' as unknown as string,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointIntegrityError);
        assert.equal((err as GitPolicyError).code, 'ERR_GIT_CHECKPOINT_INTEGRITY');
        assert.ok((err as Error).message.includes('purpose is required'));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: '   ' as unknown as string,
        });
      },
      GitCheckpointIntegrityError
    );

    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: undefined as unknown as string,
        });
      },
      GitCheckpointIntegrityError
    );

    assert.equal(manager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 5. Dirty unstaged workspace rejection
  // --------------------------------------------------------------------------
  it('5. dirty unstaged workspace rejection: rejects dirty unstaged changes with GitDirtyWorktreeError', async () => {
    const dirtyPort = createCleanPort({
      unstaged_changes: ['src/core.ts'],
      working_tree_clean: false,
      status: GitStatus.DIRTY,
    });
    const dirtyManager = new GitCheckpointManager(dirtyPort);

    await assert.rejects(
      async () => {
        await dirtyManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitDirtyWorktreeError);
        assert.ok(err instanceof GitPolicyError);
        assert.equal((err as GitDirtyWorktreeError).code, 'ERR_GIT_DIRTY_WORKTREE');
        assert.ok((err as Error).message.includes('unstaged'));
        return true;
      }
    );

    assert.equal(dirtyPort.executedOperations.length, 0);
    assert.equal(dirtyManager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 6. Dirty staged workspace rejection
  // --------------------------------------------------------------------------
  it('6. dirty staged workspace rejection: rejects staged changes with GitDirtyWorktreeError', async () => {
    const dirtyPort = createCleanPort({
      staged_changes: ['src/config.json'],
      working_tree_clean: false,
      status: GitStatus.DIRTY,
    });
    const dirtyManager = new GitCheckpointManager(dirtyPort);

    await assert.rejects(
      async () => {
        await dirtyManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitDirtyWorktreeError);
        assert.equal((err as GitDirtyWorktreeError).code, 'ERR_GIT_DIRTY_WORKTREE');
        assert.ok((err as Error).message.includes('staged'));
        return true;
      }
    );

    assert.equal(dirtyPort.executedOperations.length, 0);
    assert.equal(dirtyManager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 7. Untracked file rejection
  // --------------------------------------------------------------------------
  it('7. untracked file rejection: rejects untracked files with GitDirtyWorktreeError', async () => {
    const dirtyPort = createCleanPort({
      untracked_files: ['scratch.txt'],
      working_tree_clean: false,
      status: GitStatus.DIRTY,
    });
    const dirtyManager = new GitCheckpointManager(dirtyPort);

    await assert.rejects(
      async () => {
        await dirtyManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitDirtyWorktreeError);
        assert.equal((err as GitDirtyWorktreeError).code, 'ERR_GIT_DIRTY_WORKTREE');
        assert.ok((err as Error).message.includes('untracked'));
        return true;
      }
    );

    assert.equal(dirtyPort.executedOperations.length, 0);
    assert.equal(dirtyManager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 8. Detached HEAD rejection
  // --------------------------------------------------------------------------
  it('8. detached HEAD rejection: rejects detached HEAD state with GitDetachedHeadError', async () => {
    const detachedPort = createCleanPort({
      is_detached_head: true,
      current_branch: null,
      status: GitStatus.DETACHED,
    });
    const detachedManager = new GitCheckpointManager(detachedPort);

    await assert.rejects(
      async () => {
        await detachedManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitDetachedHeadError);
        assert.ok(err instanceof GitPolicyError);
        assert.equal((err as GitDetachedHeadError).code, 'ERR_GIT_DETACHED_HEAD');
        assert.ok((err as Error).message.includes('detached HEAD'));
        return true;
      }
    );

    assert.equal(detachedPort.executedOperations.length, 0);
    assert.equal(detachedManager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 9. Invalid HEAD rejection
  // --------------------------------------------------------------------------
  it('9. invalid HEAD rejection: rejects missing or malformed HEAD SHA', async () => {
    const noHeadPort = createCleanPort({
      head_sha: null,
    });
    const noHeadManager = new GitCheckpointManager(noHeadPort);

    await assert.rejects(
      async () => {
        await noHeadManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointIntegrityError);
        assert.equal((err as GitCheckpointIntegrityError).code, 'ERR_GIT_CHECKPOINT_INTEGRITY');
        assert.ok((err as Error).message.includes('HEAD does not exist'));
        return true;
      }
    );

    const badHeadPort = createCleanPort({
      head_sha: 'bad-sha-not-40-hex',
    });
    const badHeadManager = new GitCheckpointManager(badHeadPort);

    await assert.rejects(
      async () => {
        await badHeadManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      GitCheckpointIntegrityError
    );
  });

  // --------------------------------------------------------------------------
  // 10. Invalid parent rejection
  // --------------------------------------------------------------------------
  it('10. invalid parent rejection: rejects malformed parent SHA format', async () => {
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
          expected_parent_sha: 'invalid-parent-sha',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitCheckpointIntegrityError);
        assert.equal((err as GitCheckpointIntegrityError).code, 'ERR_GIT_CHECKPOINT_INTEGRITY');
        assert.ok((err as Error).message.includes('expected_parent_sha must be a valid'));
        return true;
      }
    );

    assert.equal(fakePort.executedOperations.length, 0);
    assert.equal(manager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 11. Parent mismatch rejection
  // --------------------------------------------------------------------------
  it('11. parent mismatch rejection: rejects when expected parent does not match observed repository parent', async () => {
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
          expected_parent_sha: COMMIT_SHA_C, // Mismatch: observed is COMMIT_SHA_A
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitParentMismatchError);
        assert.ok(err instanceof GitCheckpointIntegrityError);
        assert.ok(err instanceof GitPolicyError);
        assert.equal((err as GitParentMismatchError).code, 'ERR_GIT_CHECKPOINT_INTEGRITY');
        assert.ok((err as Error).message.includes('Parent mismatch') || (err as Error).message.includes('parent SHA'));
        return true;
      }
    );

    assert.equal(fakePort.executedOperations.length, 0);
    assert.equal(manager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 12. Branch mismatch rejection
  // --------------------------------------------------------------------------
  it('12. branch mismatch rejection: rejects when branch does not match expected or configured branch', async () => {
    // Expected branch mismatch
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
          expected_branch: 'develop', // Observed is 'main'
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitBranchMismatchError);
        assert.ok(err instanceof GitPolicyError);
        assert.equal((err as GitBranchMismatchError).code, 'ERR_GIT_BRANCH_MISMATCH');
        return true;
      }
    );

    // Configured policy branch mismatch
    const otherBranchPort = createCleanPort({
      current_branch: 'feature-branch',
    });
    const otherBranchManager = new GitCheckpointManager(otherBranchPort, {
      policyConfig: { configured_branch: 'main' },
    });

    await assert.rejects(
      async () => {
        await otherBranchManager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
        });
      },
      GitBranchMismatchError
    );
  });

  // --------------------------------------------------------------------------
  // 13. Remote mismatch rejection
  // --------------------------------------------------------------------------
  it('13. remote mismatch rejection: rejects when target remote does not match configured policy remote', async () => {
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
          target_remote: 'upstream', // Configured is 'origin'
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitRemoteMismatchError);
        assert.ok(err instanceof GitPolicyError);
        assert.equal((err as GitRemoteMismatchError).code, 'ERR_GIT_REMOTE_MISMATCH');
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 14. Missing remote verification rejection
  // --------------------------------------------------------------------------
  it('14. missing remote verification rejection: rejects when remote verification fails', async () => {
    fakePort.remoteVerificationResult = {
      verified: false,
      remoteHeadSha: null,
      error: 'Remote branch does not exist or network unavailable',
    };

    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
          verify_remote: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitRemoteVerificationError);
        assert.ok(err instanceof GitPolicyError);
        assert.equal((err as GitRemoteVerificationError).code, 'ERR_GIT_REMOTE_VERIFICATION_FAILED');
        return true;
      }
    );

    assert.equal(manager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 15. Valid remote verification
  // --------------------------------------------------------------------------
  it('15. valid remote verification: verifies commit exists on remote and sets remote_verified true', async () => {
    fakePort.remoteVerificationResult = {
      verified: true,
      remoteHeadSha: COMMIT_SHA_B,
    };

    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'POST_FLIGHT',
      verify_remote: true,
    });

    assert.equal(cp.remote_verified, true);
    assert.equal(cp.is_known_good, true);
    assert.equal(fakePort.remoteVerifications.length, 1);
    assert.equal(fakePort.remoteVerifications[0].expectedCommitSha, COMMIT_SHA_B);
    assert.equal(fakePort.remoteVerifications[0].remote, 'origin');
    assert.equal(fakePort.remoteVerifications[0].branch, 'main');
  });

  // --------------------------------------------------------------------------
  // 16. Checkpoint commit existence validation
  // --------------------------------------------------------------------------
  it('16. checkpoint commit existence validation: detects missing or invalid commit SHA', async () => {
    const invalidShaCp = createGitCheckpoint({
      checkpoint_id: 'chk-invalid',
      task_id: 'TASK-P6-02',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      commit_sha: '0000000000000000000000000000000000000000',
      branch: 'main',
      working_tree_clean: true,
    });

    const currentState = await fakePort.inspectState('any');
    const result = manager.validateCheckpoint(invalidShaCp, currentState, {
      expected_commit_sha: COMMIT_SHA_B, // Mismatch
    });

    assert.equal(result.valid, false);
    assert.equal(result.is_known_good, false);
    assert.ok(result.violations.some((v) => v.code === GitPolicyViolationCode.MISSING_COMMIT));
  });

  // --------------------------------------------------------------------------
  // 17. Invalid checkpoint verification
  // --------------------------------------------------------------------------
  it('17. invalid checkpoint verification: verification detects invariant violations deterministically', async () => {
    const cp = createCleanCheckpointFixture();

    // Verifying against dirty state
    const dirtyState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'main',
      unstaged_changes: ['file.ts'],
      working_tree_clean: false,
    });

    const resultDirty = await manager.verifyCheckpoint(cp, {
      currentState: dirtyState,
      require_clean_worktree: true,
    });

    assert.equal(resultDirty.valid, false);
    assert.equal(resultDirty.is_known_good, false);
    assert.ok(
      resultDirty.violations.some(
        (v) => v.code === GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED
      )
    );

    // Verify throwOnError throws specific error
    await assert.rejects(
      async () => {
        await manager.verifyCheckpoint(cp, {
          currentState: dirtyState,
          throwOnError: true,
        });
      },
      GitDirtyWorktreeError
    );

    // Verifying against detached state
    const detachedState = createGitState({
      head_sha: COMMIT_SHA_B,
      is_detached_head: true,
      current_branch: null,
    });

    await assert.rejects(
      async () => {
        await manager.verifyCheckpoint(cp, {
          currentState: detachedState,
          throwOnError: true,
        });
      },
      GitDetachedHeadError
    );
  });

  // --------------------------------------------------------------------------
  // 18. Deterministic verification result
  // --------------------------------------------------------------------------
  it('18. deterministic verification result: repeated verification produces identical results', async () => {
    const cp = createCleanCheckpointFixture();
    const state = await fakePort.inspectState('any');

    const res1 = manager.validateCheckpoint(cp, state, {
      expected_parent_sha: COMMIT_SHA_A,
      expected_branch: 'main',
    });

    const res2 = manager.validateCheckpoint(cp, state, {
      expected_parent_sha: COMMIT_SHA_A,
      expected_branch: 'main',
    });

    assert.equal(res1.valid, res2.valid);
    assert.equal(res1.is_known_good, res2.is_known_good);
    assert.deepEqual(res1.errors, res2.errors);
    assert.deepEqual(res1.violations, res2.violations);
    assert.equal(res1.checkpoint_id, res2.checkpoint_id);
    assert.equal(res1.commit_sha, res2.commit_sha);
  });

  // --------------------------------------------------------------------------
  // 19. Policy boundary is actually invoked
  // --------------------------------------------------------------------------
  it('19. policy boundary is actually invoked: GitPolicyValidator decides authorization before GitPort executes', async () => {
    let validatorInvoked = false;
    const customValidator = new GitPolicyValidator();
    const originalValidate = customValidator.validateOperation.bind(customValidator);

    customValidator.validateOperation = (intent, state, config) => {
      validatorInvoked = true;
      return originalValidate(intent, state, config);
    };

    const managerWithCustomValidator = new GitCheckpointManager(fakePort, {
      policyValidator: customValidator,
    });

    await managerWithCustomValidator.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'PRE_FLIGHT',
    });

    assert.equal(validatorInvoked, true, 'GitPolicyValidator must be invoked');
    assert.equal(fakePort.executedOperations.length, 1);
    assert.equal(fakePort.executedOperations[0].authorization.allowed, true);
    assert.equal(
      fakePort.executedOperations[0].authorization.operation,
      GitOperationType.CHECKPOINT_CREATION
    );
  });

  // --------------------------------------------------------------------------
  // 20. Force-push/destructive operation remains prohibited
  // --------------------------------------------------------------------------
  it('20. force-push/destructive operation remains prohibited: CRITICAL risk and force attempts are blocked', async () => {
    await assert.rejects(
      async () => {
        await manager.createCheckpoint({
          task_id: 'TASK-P6-02',
          purpose: 'PRE_FLIGHT',
          policy_level: RiskLevel.CRITICAL,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof GitForcePushProhibitedError);
        assert.equal((err as GitForcePushProhibitedError).code, 'ERR_GIT_FORCE_PUSH_PROHIBITED');
        return true;
      }
    );

    assert.equal(fakePort.executedOperations.length, 0);
  });

  // --------------------------------------------------------------------------
  // 21. Provider neutrality
  // --------------------------------------------------------------------------
  it('21. provider neutrality: operates seamlessly with any GitPort implementation without platform coupling', async () => {
    // Custom mock GitPort
    let customInspectCalled = false;
    const customPort: GitPort = {
      async inspectState() {
        customInspectCalled = true;
        return createGitState({
          head_sha: COMMIT_SHA_B,
          current_branch: 'main',
          working_tree_clean: true,
          staged_changes: [],
          unstaged_changes: [],
          untracked_files: [],
        });
      },
      async verifyRemote() {
        return { verified: true, remoteHeadSha: COMMIT_SHA_B };
      },
      async executeAuthorizedOperation(intent, auth) {
        return {
          success: true,
          operation: intent.operation,
          policy_level: auth.risk_level,
          commit_sha: COMMIT_SHA_B,
          executed_at: new Date().toISOString(),
        };
      },
    };

    const neutralManager = new GitCheckpointManager(customPort);
    const cp = await neutralManager.createCheckpoint({
      task_id: 'TASK-NEUTRAL',
      purpose: 'PRE_FLIGHT',
    });

    assert.equal(customInspectCalled, true);
    assert.equal(cp.is_known_good, true);
  });

  // --------------------------------------------------------------------------
  // 22. No direct shell/process dependency
  // --------------------------------------------------------------------------
  it('22. no direct shell/process dependency: git-checkpoint-manager source code has zero child_process or shell imports', () => {
    const managerFilePath = fileURLToPath(
      new URL('../src/git/git-checkpoint-manager.ts', import.meta.url)
    );
    const source = fs.readFileSync(managerFilePath, 'utf8');

    assert.equal(source.includes('child_process'), false, 'Must not import child_process');
    assert.equal(source.includes('exec('), false, 'Must not use exec');
    assert.equal(source.includes('spawn('), false, 'Must not use spawn');
    assert.equal(source.includes('execFile('), false, 'Must not use execFile');
    assert.equal(source.includes('execSync('), false, 'Must not use execSync');
  });

  // --------------------------------------------------------------------------
  // 23. Checkpoint metadata immutability
  // --------------------------------------------------------------------------
  it('23. checkpoint metadata immutability: returned checkpoint is deeply frozen and cannot be mutated', async () => {
    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'PRE_FLIGHT',
      metadata: { env: 'prod' },
    });

    assert.ok(Object.isFrozen(cp));
    assert.ok(Object.isFrozen(cp.metadata));

    assert.throws(() => {
      // In strict mode, modifying read-only property throws TypeError
      (cp as unknown as Record<string, unknown>).commit_sha = 'modified';
    }, TypeError);

    assert.throws(() => {
      (cp.metadata as Record<string, unknown>).env = 'dev';
    }, TypeError);
  });

  // --------------------------------------------------------------------------
  // 24. Known-good status is not granted before verification
  // --------------------------------------------------------------------------
  it('24. known-good status is not granted before verification: failed verification never grants known-good status', async () => {
    // Create an unverified raw checkpoint with a dirty workspace in observed state
    const rawCheckpoint = createGitCheckpoint({
      checkpoint_id: 'chk-unverified',
      task_id: 'TASK-P6-02',
      phase: 'PHASE_6',
      purpose: 'PRE_FLIGHT',
      commit_sha: COMMIT_SHA_B,
      branch: 'main',
      working_tree_clean: true,
    });

    const dirtyState = createGitState({
      head_sha: COMMIT_SHA_B,
      current_branch: 'main',
      unstaged_changes: ['dirty.txt'],
      working_tree_clean: false,
    });

    const result = manager.validateCheckpoint(rawCheckpoint, dirtyState);
    assert.equal(result.valid, false);
    assert.equal(result.is_known_good, false);

    // Manager does not store it
    assert.equal(manager.getCheckpoint(rawCheckpoint.checkpoint_id), undefined);
  });

  // --------------------------------------------------------------------------
  // 25. Deterministic Checkpoint ID generation
  // --------------------------------------------------------------------------
  it('25. deterministic checkpoint ID: produces consistent, attributable ID without randomness', () => {
    const id1 = generateDeterministicCheckpointId('TASK-100', 'PRE_FLIGHT', COMMIT_SHA_B, {
      step: 1,
    });
    const id2 = generateDeterministicCheckpointId('TASK-100', 'PRE_FLIGHT', COMMIT_SHA_B, {
      step: 1,
    });
    const id3 = generateDeterministicCheckpointId('TASK-200', 'PRE_FLIGHT', COMMIT_SHA_B, {
      step: 1,
    });

    assert.equal(id1, id2, 'Same inputs must produce exact same ID');
    assert.notEqual(id1, id3, 'Different task ID must produce different checkpoint ID');
    assert.ok(id1.includes('TASK_100'));
    assert.ok(id1.includes('pre_flight'));
  });

  // --------------------------------------------------------------------------
  // 26. Checkpoint lookup, listing, and filtering
  // --------------------------------------------------------------------------
  it('26. checkpoint lookup and listing: getCheckpoint and listCheckpoints support filtering and clearing', async () => {
    const cp1 = await manager.createCheckpoint({
      task_id: 'TASK-A',
      purpose: 'PRE_FLIGHT',
    });
    const cp2 = await manager.createCheckpoint({
      task_id: 'TASK-B',
      purpose: 'POST_FLIGHT',
    });

    assert.equal(manager.getCheckpoint(cp1.checkpoint_id)?.checkpoint_id, cp1.checkpoint_id);
    assert.equal(manager.getCheckpoint(cp2.checkpoint_id)?.checkpoint_id, cp2.checkpoint_id);
    assert.equal(manager.getCheckpoint('non-existent'), undefined);

    const all = manager.listCheckpoints();
    assert.equal(all.length, 2);

    const taskA = manager.listCheckpoints({ taskId: 'TASK-A' });
    assert.equal(taskA.length, 1);
    assert.equal(taskA[0].task_id, 'TASK-A');

    const postFlight = manager.listCheckpoints({ purpose: 'POST_FLIGHT' });
    assert.equal(postFlight.length, 1);
    assert.equal(postFlight[0].purpose, 'POST_FLIGHT');

    manager.clearCheckpoints();
    assert.equal(manager.listCheckpoints().length, 0);
  });

  // --------------------------------------------------------------------------
  // 27. verifyCheckpoint by ID
  // --------------------------------------------------------------------------
  it('27. verifyCheckpoint by ID: retrieves and verifies existing checkpoint or reports not found', async () => {
    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'PRE_FLIGHT',
    });

    const verifyResult = await manager.verifyCheckpoint(cp.checkpoint_id);
    assert.equal(verifyResult.valid, true);
    assert.equal(verifyResult.is_known_good, true);
    assert.equal(verifyResult.checkpoint_id, cp.checkpoint_id);

    const missingResult = await manager.verifyCheckpoint('chk-missing-999');
    assert.equal(missingResult.valid, false);
    assert.equal(missingResult.is_known_good, false);
    assert.ok(missingResult.errors[0].includes('not found'));

    await assert.rejects(
      async () => {
        await manager.verifyCheckpoint('chk-missing-999', { throwOnError: true });
      },
      GitCheckpointIntegrityError
    );
  });

  // --------------------------------------------------------------------------
  // 28. Truthful remote verification representation
  // --------------------------------------------------------------------------
  it('28. truthful remote verification: does not claim remote verification when verify_remote is not requested', async () => {
    // FakeGitPort defaults to verified: true, but createCheckpoint without verify_remote MUST set remote_verified: false
    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'PRE_FLIGHT',
    });

    assert.equal(cp.remote_verified, false, 'Must not claim remote verification without request');
    assert.equal(fakePort.remoteVerifications.length, 0, 'No remote call should be made');
  });

  // --------------------------------------------------------------------------
  // 29. Remote HEAD mismatch during verifyCheckpoint
  // --------------------------------------------------------------------------
  it('29. remote HEAD mismatch during verifyCheckpoint: fails verification when remote HEAD does not match checkpoint commit', async () => {
    const cp = await manager.createCheckpoint({
      task_id: 'TASK-P6-02',
      purpose: 'POST_FLIGHT',
      verify_remote: true,
    });
    assert.equal(cp.remote_verified, true);

    // Now remote moves to COMMIT_SHA_C
    fakePort.remoteVerificationResult = {
      verified: true,
      remoteHeadSha: COMMIT_SHA_C, // Mismatch with checkpoint commit (COMMIT_SHA_B)
    };

    const verifyRes = await manager.verifyCheckpoint(cp, {
      require_remote_verified: true,
    });

    assert.equal(verifyRes.valid, false);
    assert.equal(verifyRes.is_known_good, false);
    assert.ok(
      verifyRes.violations.some(
        (v) => v.code === GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED
      )
    );
  });
});
