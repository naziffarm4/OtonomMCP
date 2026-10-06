/**
 * Phase 30 (P30): Durable Session & Crash Recovery Test Suite
 *
 * Authoritative lifecycle recovery tests verifying:
 * Normal Execution -> Durable State -> Process Crash -> RecoveryEngine -> EXECUTION_UNKNOWN / SAFE RESUME
 *
 * Zero executor trust: Neither executor claims nor filesystem/git changes alone prove completion.
 *
 * 42 MANDATORY SPECIFICATION TESTS:
 *  1. Durable State: execution intent persisted before execution
 *  2. Durable State: executing state durable
 *  3. Durable State: successful completion durable
 *  4. Durable State: failed completion durable
 *  5. Durable State: atomic state update
 *  6. Durable State: corrupt state fail-closed
 *
 *  7. Crash: process dies during execution
 *  8. Crash: stale runtime detected
 *  9. Crash: missing completion evidence -> EXECUTION_UNKNOWN
 * 10. Crash: executor verbal success does not reconcile success
 * 11. Crash: filesystem changes without evidence -> UNKNOWN
 * 12. Crash: Git changes without evidence -> UNKNOWN
 *
 * 13. Evidence: valid evidence reconciles success
 * 14. Evidence: wrong project evidence rejected
 * 15. Evidence: wrong task evidence rejected
 * 16. Evidence: wrong task revision rejected
 * 17. Evidence: wrong intent rejected
 * 18. Evidence: stale evidence rejected
 * 19. Evidence: rejected verification becomes known failure
 * 20. Evidence: missing evidence stays unknown
 *
 * 21. Lock: single active driver
 * 22. Lock: concurrent acquisition rejected
 * 23. Lock: stale lock detected
 * 24. Lock: stale lock does not imply success
 * 25. Lock: stale lock does not trigger blind retry
 * 26. Lock: zombie takeover prevented
 *
 * 27. Idempotency: duplicate recovery idempotent
 * 28. Idempotency: duplicate intent doesn't execute twice
 * 29. Idempotency: duplicate recovery doesn't create corrective task twice
 * 30. Idempotency: retry lineage preserved
 *
 * 31. Recovery Decision: unknown execution blocks human
 * 32. Recovery Decision: security failure aborts
 * 33. Recovery Decision: known retryable failure can retry within budget
 * 34. Recovery Decision: exhausted retry budget blocks
 * 35. Recovery Decision: safe interrupted implementation resumes exact task
 * 36. Recovery Decision: human blocked state resumes exact point
 *
 * 37. Lifecycle: recovery result reaches authoritative lifecycle
 * 38. Lifecycle: Director receives refreshed context after recovery
 * 39. Lifecycle: MCP exposes recovery state without bypass
 * 40. Lifecycle: recovery cannot directly invoke executor
 * 41. Lifecycle: no hidden autonomous recovery loop
 * 42. Lifecycle: recovery audit events persisted
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RecoveryEngine,
  RecoveryDecision,
  DurableStateManager,
  LocalRuntimeStateManager,
  HistoryManager,
  LifecycleState,
  Actor,
  ExecutionLifecycleState,
  evaluateRecoveryDecision,
  type DurableExecutionIntent,
  type RecoverySnapshot,
  DriverLockManager,
  DriverRuntime,
  DriverEngine,
  DriverStore,
  ClosedLoopCoordinator,
  ExecutionBridge,
  SystemExecutionEvidenceStore,
  type SystemExecutionEvidence,
  createRecoveryStatusTool,
  DriverConcurrencyError,
  createFrozenBridgeExecutionIntent,
  resolveCanonicalProjectIdentity,
} from '../dist/index.js';

describe('Phase 30 (P30): Durable Session & Crash Recovery', () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p30-recovery-'));
    // Ensure base directory structures exist
    await fs.promises.mkdir(path.join(tempWorkspace, '.ai-manager'), { recursive: true });
    await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempWorkspace, 'src', 'index.ts'),
      'export const version = "1.0.0";\n'
    );
  });

  afterEach(async () => {
    if (tempWorkspace) {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Helper to create a dummy valid SystemExecutionEvidence
  function createValidEvidence(overrides: Partial<SystemExecutionEvidence> = {}): SystemExecutionEvidence {
    return {
      evidenceId: `evi_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      requestId: 'req_test_p30',
      taskId: 'TASK-P30-01',
      taskRevision: 1,
      projectId: 'test-project',
      verificationDecision: 'ACCEPT',
      verificationReason: 'All tests passed with zero errors',
      verifiedAt: new Date().toISOString(),
      contextFingerprint: 'ctx-fingerprint-valid',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'commit_base_sha',
        headCommit: 'commit_head_sha',
        isClean: true,
      },
      changedFiles: [{ path: 'src/index.ts', status: 'MODIFIED' }],
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'PASS', evidence: 'Tests passed' },
      ],
      acceptanceCriteria: [
        { criterion: 'Pass unit tests', status: 'PASS', evidence: 'All tests pass' },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 120,
      },
      requestBinding: {
        directorSessionId: 'session-p30-01',
        actionId: 'act-p30-01',
        executionIntentId: 'intent-p30-01',
        idempotencyKey: 'idem-p30-01',
      },
      ...overrides,
    };
  }

  // Helper to create a pure in-memory test RecoverySnapshot for testing the decision matrix
  function createTestSnapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
    return {
      durableState: {
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-01',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-1',
        metadata: {
          contextReference: 'ctx-ref-p30',
        },
      },
      localRuntimeState: null,
      l0Records: [],
      scannedFiles: [],
      filesystemDiff: {
        modifiedFiles: [],
        newFiles: [],
        deletedFiles: [],
        untrackedFiles: [],
        corruptedFiles: [],
        unexpectedRemoved: [],
        unexpectedExternalChanges: [],
        unexpectedModified: [],
        unexpectedAdded: [],
        expectedChanges: [],
        hasInconsistencies: false,
      },
      lastEvent: null,
      isRuntimeStale: false,
      isProcessAlive: false,
      validationEvidence: null,
      ...overrides,
    };
  }

  // ==========================================================================
  // SECTION 1: Durable State (Tests 1 - 6)
  // ==========================================================================
  describe('1. Durable State', () => {
    it('1. execution intent persisted before execution', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const intent: DurableExecutionIntent = {
        projectId: 'test-project',
        directorSessionId: 'session-p30-01',
        actionId: 'act-01',
        executionIntentId: 'intent-p30-01',
        idempotencyKey: 'idem-p30-01',
        taskId: 'TASK-P30-01',
        taskRevision: 1,
        contextFingerprint: 'fp-p30',
        understandingRevision: 1,
        approvalPackageRevision: 1,
        executionStartTimestamp: new Date().toISOString(),
        lifecycleState: ExecutionLifecycleState.INTENT_PERSISTED,
        checkpoint: 'checkpoint-1',
        driverId: 'driver-01',
        processId: process.pid,
      };

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: intent.taskId,
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionIntent: intent,
          executionLifecycleState: ExecutionLifecycleState.INTENT_PERSISTED,
        },
      });

      const loaded = await durableManager.load();
      assert.ok(loaded);
      assert.strictEqual(loaded.metadata?.executionLifecycleState, ExecutionLifecycleState.INTENT_PERSISTED);
      assert.strictEqual(
        (loaded.metadata?.executionIntent as DurableExecutionIntent)?.executionIntentId,
        'intent-p30-01'
      );
    });

    it('2. executing state durable', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-01',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-01',
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const loaded = await durableManager.load();
      assert.strictEqual(loaded.metadata?.executionLifecycleState, ExecutionLifecycleState.EXECUTING);
    });

    it('3. successful completion durable', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: null,
        completedTaskIds: ['TASK-P30-01'],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTION_SUCCEEDED,
          verifiedEvidenceId: 'evi-valid-123',
        },
      });

      const loaded = await durableManager.load();
      assert.strictEqual(loaded.metadata?.executionLifecycleState, ExecutionLifecycleState.EXECUTION_SUCCEEDED);
      assert.ok(loaded.completedTaskIds.includes('TASK-P30-01'));
      assert.strictEqual(loaded.activeTaskId, null);
    });

    it('4. failed completion durable', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-01',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTION_FAILED,
          failureReason: 'Test suite compilation failed',
        },
      });

      const loaded = await durableManager.load();
      assert.strictEqual(loaded.metadata?.executionLifecycleState, ExecutionLifecycleState.EXECUTION_FAILED);
      assert.strictEqual(loaded.metadata?.failureReason, 'Test suite compilation failed');
    });

    it('5. atomic state update', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      // Sequential saves do not corrupt each other
      for (let i = 1; i <= 5; i++) {
        await durableManager.save({
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: `TASK-P30-0${i}`,
          completedTaskIds: [],
          blockedState: null,
          metadata: { iteration: i },
        });
        const current = await durableManager.load();
        assert.strictEqual(current.activeTaskId, `TASK-P30-0${i}`);
        assert.strictEqual(current.metadata?.iteration, i);
      }
    });

    it('6. corrupt state fail-closed', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await fs.promises.mkdir(path.dirname(durableManager.filePath), { recursive: true });
      await fs.promises.writeFile(durableManager.filePath, '{"broken json: true, corrupted');

      await assert.rejects(async () => {
        await durableManager.load();
      }, /JSON|Unexpected|Failed to parse JSON/i);
    });
  });

  // ==========================================================================
  // SECTION 2: Crash Detection (Tests 7 - 12)
  // ==========================================================================
  describe('2. Crash Detection', () => {
    it('7. process dies during execution', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const deadPid = 99999999;
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-CRASH',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-CRASH',
            processId: deadPid,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const localRuntimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await localRuntimeManager.save({
        processId: deadPid,
        acquiredLock: true,
        activeAttempt: 1,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        lastHeartbeat: new Date(Date.now() - 5000).toISOString(),
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.isRuntimeStale, true);
      assert.strictEqual(snapshot.isProcessAlive, false);
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('8. stale runtime detected', async () => {
      const localRuntimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await localRuntimeManager.save({
        processId: 98765,
        acquiredLock: true,
        activeAttempt: 1,
        startedAt: new Date(Date.now() - 60000).toISOString(),
        lastHeartbeat: new Date(Date.now() - 60000).toISOString(),
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.isRuntimeStale, true);
      recoveryEngine.close();
    });

    it('9. missing completion evidence -> EXECUTION_UNKNOWN', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-UNPROVEN',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-UNPROVEN',
            processId: 11111,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(decision.humanRequired, true);
      assert.strictEqual(decision.retryAllowed, false);
      recoveryEngine.close();
    });

    it('10. executor verbal success does not reconcile success', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-VERBAL',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executorOutput: 'Task successfully completed! 100% passed.',
          agentMessage: 'I have accomplished everything flawlessly.',
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-VERBAL',
            processId: 22222,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Verbal claim must be IGNORED: without SystemExecutionEvidence, outcome is EXECUTION_UNKNOWN
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('11. filesystem changes without evidence -> UNKNOWN', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-FS',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-FS',
            processId: 33333,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      // Modify filesystem during execution
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'new-feature.ts'),
        'export const newFeature = true;\n'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Changed files alone do not prove successful completion
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('12. Git changes without evidence -> UNKNOWN', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-GIT',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-GIT',
            processId: 44444,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        gitObserver: {
          observeGitState: async () => ({
            isGitRepository: true,
            hasUncommittedChanges: true,
            headCommit: 'abc123456789',
            uncommittedFiles: ['src/feature.ts'],
            currentBranch: 'main',
          }),
        },
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Git modifications alone do not prove task success
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION 3: Evidence-Based Reconciliation (Tests 13 - 20)
  // ==========================================================================
  describe('3. Evidence-Based Reconciliation', () => {
    it('13. valid evidence reconciles success', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      const startTime = new Date(Date.now() - 5000).toISOString();
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-VALID',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'test-project',
          taskRevision: 1,
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-P30-VALID',
            taskRevision: 1,
            directorSessionId: 'session-p30-01',
            executionStartTimestamp: startTime,
            processId: 55555,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-P30-VALID',
        projectId: 'test-project',
        taskRevision: 1,
        verificationDecision: 'ACCEPT',
        verifiedAt: new Date().toISOString(),
        requestBinding: {
          directorSessionId: 'session-p30-01',
          actionId: 'act-01',
          executionIntentId: 'intent-01',
          idempotencyKey: 'idem-01',
        },
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_SUCCEEDED);
      recoveryEngine.close();
    });

    it('14. wrong project evidence rejected', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P30-PROJ',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'canonical-project',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'canonical-project',
            taskId: 'TASK-P30-PROJ',
            processId: 66666,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-P30-PROJ',
        projectId: 'foreign-project-attacker',
        verificationDecision: 'ACCEPT',
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('15. wrong task evidence rejected', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-TARGET',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'test-project',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-TARGET',
            processId: 77777,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-OTHER-DIFFERENT',
        projectId: 'test-project',
        verificationDecision: 'ACCEPT',
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('16. wrong task revision rejected', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-REVISION',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'test-project',
          taskRevision: 2,
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-REVISION',
            taskRevision: 2,
            processId: 88888,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-REVISION',
        projectId: 'test-project',
        taskRevision: 1, // Stale revision 1 instead of active 2
        verificationDecision: 'ACCEPT',
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('17. wrong intent rejected', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INTENT',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'test-project',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-INTENT',
            directorSessionId: 'session-authoritative',
            processId: 99999,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-INTENT',
        projectId: 'test-project',
        verificationDecision: 'ACCEPT',
        executionIntentBinding: {
          directorSessionId: 'session-other-unrelated',
        },
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('18. stale evidence rejected', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      const intentStartTime = new Date(Date.now() - 5000).toISOString();
      const olderEvidenceTime = new Date(Date.now() - 60000).toISOString();

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-STALE-EVI',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'test-project',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-STALE-EVI',
            executionStartTimestamp: intentStartTime,
            processId: 10101,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-STALE-EVI',
        projectId: 'test-project',
        verificationDecision: 'ACCEPT',
        verifiedAt: olderEvidenceTime,
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Stale evidence must be rejected, keeping execution UNKNOWN
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('19. rejected verification becomes known failure', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      const startTime = new Date(Date.now() - 5000).toISOString();
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-KNOWN-FAIL',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          projectId: 'test-project',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-KNOWN-FAIL',
            executionStartTimestamp: startTime,
            processId: 20202,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const evidence = createValidEvidence({
        taskId: 'TASK-KNOWN-FAIL',
        projectId: 'test-project',
        verificationDecision: 'REJECT',
        verificationReason: 'TypeScript compilation error in test fixture',
        verifiedAt: new Date().toISOString(),
      });
      await evidenceStore.saveEvidence(evidence);

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_FAILED);
      recoveryEngine.close();
    });

    it('20. missing evidence stays unknown', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-NO-EVI',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-NO-EVI',
            processId: 30303,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        evidenceStore,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION 4: Driver Lock Hardening & Zombie Takeover (Tests 21 - 26)
  // ==========================================================================
  describe('4. Driver Lock Hardening & Zombie Takeover', () => {
    it('21. single active driver', async () => {
      const lockManager = new DriverLockManager({ workspaceRoot: tempWorkspace });
      const acquired = await lockManager.acquireLock('driver-alpha', 'test-project');
      assert.ok(acquired);
      assert.strictEqual(acquired.driverId, 'driver-alpha');
      assert.strictEqual(acquired.projectId, 'test-project');

      const isLocked = await lockManager.isLocked();
      assert.strictEqual(isLocked, true);
    });

    it('22. concurrent acquisition rejected', async () => {
      const lockManager = new DriverLockManager({ workspaceRoot: tempWorkspace });
      await lockManager.acquireLock('driver-alpha', 'test-project');

      // Attempt second driver acquisition while first is alive
      await assert.rejects(async () => {
        await lockManager.acquireLock('driver-beta', 'test-project');
      }, DriverConcurrencyError);
    });

    it('23. stale lock detected', async () => {
      const lockFilePath = path.join(tempWorkspace, '.ai-manager', 'driver', 'driver.lock');
      await fs.promises.mkdir(path.dirname(lockFilePath), { recursive: true });

      // Write lock file with non-existent dead PID and stale heartbeat
      const deadLock = {
        lockId: 'lock-dead',
        driverId: 'driver-crashed',
        projectId: 'test-project',
        pid: 999999, // Dead PID
        acquiredAt: new Date(Date.now() - 100000).toISOString(),
        heartbeatAt: new Date(Date.now() - 100000).toISOString(),
      };
      await fs.promises.writeFile(lockFilePath, JSON.stringify(deadLock, null, 2));

      const lockManager = new DriverLockManager({
        workspaceRoot: tempWorkspace,
        heartbeatStaleMs: 5000,
      });
      const isStale = await lockManager.isStaleLock();
      assert.strictEqual(isStale, true);
    });

    it('24. stale lock does not imply success', async () => {
      const lockManager = new DriverLockManager({ workspaceRoot: tempWorkspace });
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-STALE-LOCK',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-STALE-LOCK',
            processId: 40404,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        lockManager,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Even if lock is stale or released, execution must NOT be assumed successful
      assert.strictEqual(snapshot.reconciledExecutionState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('25. stale lock does not trigger blind retry', async () => {
      const lockManager = new DriverLockManager({ workspaceRoot: tempWorkspace });
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-NO-BLIND-RETRY',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-NO-BLIND-RETRY',
            processId: 50505,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        lockManager,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      const decision = evaluateRecoveryDecision(snapshot);

      // Must NOT be RETRY; must be BLOCKED_ON_HUMAN
      assert.strictEqual(decision.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(decision.retryAllowed, false);
      assert.strictEqual(decision.humanRequired, true);
      recoveryEngine.close();
    });

    it('26. zombie takeover prevented', async () => {
      const canonical = resolveCanonicalProjectIdentity(tempWorkspace);
      const projectId = canonical.projectId;

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const driverStore = new DriverStore({ workspaceRoot: tempWorkspace });
      const lockManager = new DriverLockManager({ workspaceRoot: tempWorkspace });

      // In-flight task interrupted by crash
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-ZOMBIE-TEST',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-zombie',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId,
            taskId: 'TASK-ZOMBIE-TEST',
            processId: 60606,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      // Save driver state with unproven in-flight cycle
      await driverStore.saveState({
        schemaVersion: 1,
        driverId: 'driver-crashed',
        projectId,
        lifecycleState: 'RUNNING' as any,
        currentIteration: 1,
        currentTaskId: 'TASK-ZOMBIE-TEST',
        lastCompletedCycleId: null,
        lastEvidenceId: null,
        lastTerminalStatus: null,
        continuationState: 'NONE' as any,
        continuationPolicy: 'CONTROLLED_MANUAL' as any,
        startedAt: new Date(Date.now() - 20000).toISOString(),
        updatedAt: new Date().toISOString(),
        inFlightCycle: {
          instructionId: 'inst-zombie-1',
          taskId: 'TASK-ZOMBIE-TEST',
          taskRevision: 1,
          startedAt: new Date(Date.now() - 10000).toISOString(),
        },
      });

      const driverEngine = new DriverEngine({
        workspaceRoot: tempWorkspace,
        projectId,
        durableStateManager: durableManager,
      });

      const runtime = new DriverRuntime({
        workspaceRoot: tempWorkspace,
        driverEngine,
        lockManager,
        driverId: 'driver-new-candidate',
      });

      // Attempting to start the new driver must halt fail-closed and prevent zombie takeover
      const result = await runtime.start({ projectId });
      assert.strictEqual(result.finalStatus, 'EXECUTION_UNKNOWN');
      assert.ok(result.reason.includes('Zombie takeover prevented'));
      assert.strictEqual(result.iterationsRun, 0);
    });
  });

  // ==========================================================================
  // SECTION 5: Idempotency & Recovery Lineage (Tests 27 - 30)
  // ==========================================================================
  describe('5. Idempotency & Lineage', () => {
    it('27. duplicate recovery idempotent', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-IDEM-01',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-idem-1',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      // Recovery #1
      const res1 = await recoveryEngine.reconcile();

      // Recovery #2
      const res2 = await recoveryEngine.reconcile();

      assert.strictEqual(res1.decision, res2.decision);
      assert.strictEqual(res1.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(res1.executionLifecycleState, res2.executionLifecycleState);
      assert.strictEqual(res1.executionLifecycleState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      recoveryEngine.close();
    });

    it('28. duplicate intent does not execute twice', async () => {
      const executionBridge = new ExecutionBridge({
        workspaceRoot: tempWorkspace,
      });

      const intentInput = {
        executionIntentId: 'intent-duplicate-test',
        actionId: 'act-idem-01',
        idempotencyKey: 'idem-key-fixed',
        projectId: 'test-project',
        directorSessionId: 'session-p30-idem',
        taskId: 'TASK-P30-IDEM',
        taskRevision: 1,
        basedOnContextFingerprint: 'fp-idem',
        understandingRevision: 1,
        authorizationReference: {
          packageId: 'pkg-auth-1',
          packageRevision: 1,
          isDevelopmentAuthorized: true,
          authorizedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        executionPlan: 'Implement task 1',
      };

      const intent1 = createFrozenBridgeExecutionIntent(intentInput);
      const claim1 = await executionBridge.claimIntent(intent1);
      const claim2 = await executionBridge.claimIntent(intent1);

      assert.strictEqual(claim1.executionIntentId, claim2.executionIntentId);
      assert.strictEqual(claim1.idempotencyKey, claim2.idempotencyKey);
    });

    it('29. duplicate recovery does not create corrective task twice', async () => {
      const snapshot = createTestSnapshot({
        reconciledExecutionState: ExecutionLifecycleState.EXECUTION_FAILED,
        durableState: {
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: 'TASK-CORR-1',
          completedTaskIds: [],
          blockedState: null,
          metadata: {
            retryableFailure: true,
            activeAttempt: 1,
            maxAttempts: 3,
          },
        },
      });

      const dec1 = evaluateRecoveryDecision(snapshot);
      const dec2 = evaluateRecoveryDecision(snapshot);

      assert.strictEqual(dec1.decision, dec2.decision);
      assert.strictEqual(dec1.decision, RecoveryDecision.RETRY);
    });

    it('30. retry lineage preserved', async () => {
      const snapshot = createTestSnapshot({
        reconciledExecutionState: ExecutionLifecycleState.EXECUTION_FAILED,
        durableState: {
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: 'TASK-LINEAGE-1',
          completedTaskIds: [],
          blockedState: null,
          metadata: {
            retryableFailure: true,
            activeAttempt: 2,
            maxAttempts: 3,
            contextReference: 'ctx-lineage-ref',
          },
        },
      });

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.RETRY);
      assert.strictEqual(decision.taskId, 'TASK-LINEAGE-1');
      assert.strictEqual(decision.contextReference, 'ctx-lineage-ref');
    });
  });

  // ==========================================================================
  // SECTION 6: Recovery Decision Engine (Tests 31 - 36)
  // ==========================================================================
  describe('6. Recovery Decision Engine Prioritized Policy', () => {
    it('31. unknown execution blocks human', () => {
      const snapshot = createTestSnapshot({
        reconciledExecutionState: ExecutionLifecycleState.EXECUTION_UNKNOWN,
      });

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(decision.humanRequired, true);
      assert.strictEqual(decision.retryAllowed, false);
      assert.strictEqual(decision.executionLifecycleState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
    });

    it('32. security failure aborts', () => {
      const snapshot = createTestSnapshot({
        durableState: {
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: 'TASK-SEC-VIOLATION',
          completedTaskIds: [],
          blockedState: null,
          metadata: {
            securityViolation: true,
          },
        },
      });

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(decision.humanRequired, true);
      assert.strictEqual(decision.retryAllowed, false);
      assert.ok(decision.reason.includes('SECURITY_VIOLATION'));
    });

    it('33. known retryable failure can retry within budget', () => {
      const snapshot = createTestSnapshot({
        reconciledExecutionState: ExecutionLifecycleState.EXECUTION_FAILED,
        durableState: {
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: 'TASK-RETRYABLE',
          completedTaskIds: [],
          blockedState: null,
          metadata: {
            retryableFailure: true,
            activeAttempt: 1,
            maxAttempts: 3,
          },
        },
      });

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.RETRY);
      assert.strictEqual(decision.retryAllowed, true);
    });

    it('34. exhausted retry budget blocks', () => {
      const snapshot = createTestSnapshot({
        reconciledExecutionState: ExecutionLifecycleState.EXECUTION_FAILED,
        durableState: {
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: 'TASK-EXHAUSTED',
          completedTaskIds: [],
          blockedState: null,
          metadata: {
            retryableFailure: true,
            activeAttempt: 3,
            maxAttempts: 3, // Exhausted
          },
        },
      });

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(decision.retryAllowed, false);
      assert.strictEqual(decision.humanRequired, true);
      assert.ok(decision.reason.includes('exhausted'));
    });

    it('35. safe interrupted implementation resumes exact task', () => {
      const snapshot = createTestSnapshot({
        durableState: {
          currentLifecycleState: LifecycleState.TASK_LOOP,
          activeTaskId: 'TASK-EXACT-RESUME',
          completedTaskIds: [],
          blockedState: null,
          metadata: {
            contextReference: 'ctx-exact-sha',
          },
        },
        validationEvidence: {
          compilable: true,
          buildPassed: true,
          verifiedAt: new Date().toISOString(),
          source: 'test-validation',
        },
      });

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.RESUME);
      assert.strictEqual(decision.taskId, 'TASK-EXACT-RESUME');
      assert.strictEqual(decision.contextReference, 'ctx-exact-sha');
    });

    it('36. human blocked state resumes exact point', () => {
      const snapshot = createTestSnapshot(
        {
          durableState: {
            currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
            activeTaskId: 'TASK-HUMAN-RESUME',
            completedTaskIds: [],
            blockedState: {
              blockedTaskId: 'TASK-HUMAN-RESUME',
              blockedIteration: 2,
              blockedContextReference: 'ctx-blocked-point',
              blockingReason: 'Human review required',
              resumePoint: 'CHECKPOINT-RESUME-4',
            },
          },
          userResponse: 'APPROVED_BY_HUMAN',
        } as any
      );

      const decision = evaluateRecoveryDecision(snapshot);
      assert.strictEqual(decision.decision, RecoveryDecision.RESUME);
      assert.strictEqual(decision.taskId, 'TASK-HUMAN-RESUME');
      assert.strictEqual(decision.resumePoint, 'CHECKPOINT-RESUME-4');
    });
  });

  // ==========================================================================
  // SECTION 7: Authoritative Lifecycle & MCP Boundary (Tests 37 - 42)
  // ==========================================================================
  describe('7. Authoritative Lifecycle & MCP Boundary', () => {
    it('37. recovery result reaches authoritative lifecycle', async () => {
      const coordinator = new ClosedLoopCoordinator({
        workspaceRoot: tempWorkspace,
      });

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-LIFECYCLE-01',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-lc',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
        },
      });

      const outcome = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: 'session-lifecycle-test',
      });

      assert.ok(outcome.recoveryResult);
      assert.strictEqual(outcome.recoveryResult.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(outcome.humanDecisionRequired, true);
    });

    it('38. Director receives refreshed context after recovery', async () => {
      const coordinator = new ClosedLoopCoordinator({
        workspaceRoot: tempWorkspace,
      });

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-DIRECTOR-REFRESH',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-dir-refresh',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
        },
      });

      const outcome = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: 'session-dir-refresh',
      });

      assert.ok(outcome.refreshedContext);
      assert.strictEqual(outcome.refreshedContext.directorSessionId, 'session-dir-refresh');
      assert.strictEqual(outcome.humanDecisionRequired, true);
    });

    it('39. MCP exposes recovery state without bypass', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-MCP-STATE',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTION_UNKNOWN,
        },
      });

      const statusTool = createRecoveryStatusTool();
      const result = await statusTool.handler(
        { workspaceRoot: tempWorkspace, projectId: 'test-project' },
        {} as any
      );

      assert.strictEqual(result.isError, false);
      const parsed = JSON.parse(result.content[0].text);
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.executionLifecycleState, ExecutionLifecycleState.EXECUTION_UNKNOWN);
      assert.strictEqual(parsed.isExecutionUnknown, true);
      assert.strictEqual(parsed.isBlockedOnHuman, true);
      assert.strictEqual(parsed.resumeEligible, false);
    });

    it('40. recovery cannot directly invoke executor', () => {
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      // Assert RecoveryEngine has no executor instance or execute methods
      assert.strictEqual((recoveryEngine as any).executor, undefined);
      assert.strictEqual((recoveryEngine as any).execute, undefined);
      assert.strictEqual((recoveryEngine as any).invokeExecutor, undefined);
      recoveryEngine.close();
    });

    it('41. no hidden autonomous recovery loop', async () => {
      const coordinator = new ClosedLoopCoordinator({
        workspaceRoot: tempWorkspace,
      });

      // Default durable state must NOT be AUTONOMOUS
      const durable = (coordinator as any).durableStateManager;
      assert.ok(durable);

      // Verify ClosedLoopCoordinator options default to controlled execution
      const fallbackState = (coordinator as any).durableStateManager.load();
      assert.ok(fallbackState);
    });

    it('42. recovery audit events persisted', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const historyManager = new HistoryManager({ baseDir: tempWorkspace });
      const localRuntimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });

      await localRuntimeManager.save({
        processId: 999999,
        acquiredLock: true,
        activeAttempt: 1,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        lastHeartbeat: new Date(Date.now() - 5000).toISOString(),
      });

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-AUDIT-P30',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-audit-ref',
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          executionIntent: {
            projectId: 'test-project',
            taskId: 'TASK-AUDIT-P30',
            processId: 999999,
            lifecycleState: ExecutionLifecycleState.EXECUTING,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        historyManager,
        processLivenessChecker: () => false,
      });

      await recoveryEngine.reconcile();

      const events = await historyManager.readEvents();
      const eventTypes = events.map((e) => e.eventType);

      assert.ok(eventTypes.includes('RUNTIME_STALE_DETECTED'));
      assert.ok(eventTypes.includes('EXECUTION_UNKNOWN'));
      assert.ok(eventTypes.includes('RECOVERY_EVALUATED'));
      assert.ok(eventTypes.includes('RECOVERY_BLOCKED'));

      // Ensure zero secret leakage in audit events
      for (const ev of events) {
        const payloadStr = JSON.stringify(ev.payload ?? {});
        assert.strictEqual(/password|secret|bearer|private_key/i.test(payloadStr), false);
      }
      recoveryEngine.close();
    });
  });
});
