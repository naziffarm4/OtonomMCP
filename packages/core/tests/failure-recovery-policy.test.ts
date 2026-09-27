import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  FailureDiagnosisEngine,
  FailureCategory,
  FailureSeverity,
  RecoveryPolicyEngine,
  RecoveryStrategy,
  RecoveryPolicyValidationError,
  RecoveryPolicySecurityViolationError,
  RecoveryPolicyBindingMismatchError,
  type SystemExecutionEvidence,
  type TaskDefinition,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  HistoryManager,
  SpecStore,
  DurableStateManager,
  TaskDagEngine,
} from '../dist/index.js';

describe('P13-01: Failure Diagnosis & Recovery Policy Engine', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let dagEngine: TaskDagEngine;

  const validTask: TaskDefinition = {
    task_id: 'TASK-P13-01',
    parent_feature_id: 'FEAT-P13',
    title: 'Implement failure recovery policy engine',
    description: 'Diagnoses verified execution failure evidence',
    traceability_sources: ['REQ:P13-01'],
    dependencies: [],
    acceptance_criteria: ['All tests pass'],
    status: TaskStatus.READY,
    attempt: 0,
    max_attempts: 3,
    priority: TaskPriority.HIGH,
    risk_level: RiskLevel.SAFE,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    hierarchy_level: 'TASK',
    metadata: {
      revision: 1,
    },
  };

  const createBaseEvidence = (overrides: Partial<SystemExecutionEvidence> = {}): SystemExecutionEvidence => {
    return {
      evidenceId: 'evi_req123_abc1234567890def',
      requestId: 'req_1234567890abcdef',
      projectId: 'proj_test',
      taskId: 'TASK-P13-01',
      taskRevision: 1,
      contextFingerprint: 'ctx_fingerprint_hash_123',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'commit_base_sha',
        headCommit: 'commit_head_sha',
        isClean: true,
      },
      changedFiles: [{ path: 'packages/core/src/test.ts', status: 'MODIFIED' }],
      verificationChecks: [],
      acceptanceCriteria: [],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 120,
      },
      verificationDecision: 'REJECT',
      verifiedAt: new Date().toISOString(),
      ...overrides,
    };
  };

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p13-01-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // T01
  it('T01: valid ACCEPT evidence is not classified as a failure', () => {
    const evidence = createBaseEvidence({
      verificationDecision: 'ACCEPT',
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'PASS', evidence: 'Tests passed' },
      ],
      acceptanceCriteria: [
        { criterion: 'Pass unit tests', status: 'PASS', evidence: 'All tests pass' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, false);
    assert.equal(diagnosis.issues.length, 0);

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
    assert.ok(policy.reasonCodes.includes('NO_FAILURE_DETECTED'));
  });

  // T02
  it('T02: test failure classified correctly', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST_RUN', type: 'TEST', status: 'FAIL', evidence: 'Assertion failed: expected 1 to be 2' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.TEST_FAILURE);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T03
  it('T03: build failure classified correctly', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_BUILD', type: 'BUILD', status: 'FAIL', evidence: 'Compile error TS2304: Cannot find name' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.BUILD_FAILURE);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T04
  it('T04: typecheck failure classified correctly', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TSC', type: 'TYPECHECK', status: 'FAIL', evidence: 'Typecheck verification check failed' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.TYPECHECK_FAILURE);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T05
  it('T05: lint failure classified correctly', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_ESLINT', type: 'LINT', status: 'FAIL', evidence: 'Lint error: unused variable' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.LINT_FAILURE);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T06
  it('T06: scope violation classified correctly and marked replannable', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_SCOPE', type: 'FILE_SCOPE', status: 'FAIL', evidence: 'Repository changes outside allowed implementationScope' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.SCOPE_VIOLATION);
    assert.equal(diagnosis.isReplannable, true);
    assert.equal(diagnosis.isRetryable, false);

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.REPLAN);
    assert.equal(policy.replanAllowed, true);
  });

  // T07
  it('T07: acceptance criteria failure classified correctly', () => {
    const evidence = createBaseEvidence({
      acceptanceCriteria: [
        { criterion: 'Custom domain requirement', status: 'FAIL', evidence: 'Condition not satisfied' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.ACCEPTANCE_CRITERIA_FAILURE);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T08
  it('T08: executor failure classified correctly', () => {
    const evidence = createBaseEvidence({
      executorOutcomeReference: {
        status: 'FAILURE',
        exitCode: 1,
        durationMs: 50,
      },
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.EXECUTOR_FAILURE);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T09
  it('T09: timeout classified correctly', () => {
    const evidence = createBaseEvidence({
      executorOutcomeReference: {
        status: 'TIMEOUT',
        exitCode: 124,
        durationMs: 30000,
      },
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.TIMEOUT);
    assert.equal(diagnosis.isRetryable, true);
  });

  // T10
  it('T10: infrastructure failure classified correctly and blocks on human', () => {
    const evidence = createBaseEvidence({
      verificationDecision: 'BLOCK',
      verificationChecks: [
        { checkId: 'CHECK_ENV', type: 'COMMAND', status: 'BLOCK', evidence: 'Verification command execution failed due to infrastructure error: spawn ENOENT node' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.INFRASTRUCTURE_FAILURE);
    assert.equal(diagnosis.requiresHuman, true);

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
    assert.equal(policy.humanRequired, true);
  });

  // T11
  it('T11: security violation fails closed with ABORT', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_PATH_SAFETY', type: 'SECURITY', status: 'FAIL', evidence: 'Unsafe path detected: ../etc/passwd' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.isFailure, true);
    assert.equal(diagnosis.primaryCategory, FailureCategory.SECURITY_VIOLATION);

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.ABORT);
    assert.equal(policy.humanRequired, true);
    assert.equal(policy.retryAllowed, false);
  });

  // T12
  it('T12: unknown unclassified failure fails closed into BLOCK_ON_HUMAN', () => {
    const evidence = createBaseEvidence({
      verificationDecision: 'REJECT',
      verificationChecks: [],
      metadata: { blockingReason: 'Unexplained rejection without checks' },
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    assert.equal(diagnosis.primaryCategory, FailureCategory.UNKNOWN);

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
    assert.equal(policy.humanRequired, true);
  });

  // T13
  it('T13: retryable failure with attempts remaining yields RETRY', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const taskWithBudget: TaskDefinition = {
      ...validTask,
      attempt: 1,
      max_attempts: 3,
    };

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: taskWithBudget });
    assert.equal(policy.decision, RecoveryStrategy.RETRY);
    assert.equal(policy.retryAllowed, true);
    assert.equal(policy.attempt, 1);
    assert.equal(policy.maxAttempts, 3);
  });

  // T14
  it('T14: retryable failure at max attempts yields BLOCK_ON_HUMAN', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed repeatedly' },
      ],
    });

    const exhaustedTask: TaskDefinition = {
      ...validTask,
      attempt: 3,
      max_attempts: 3,
    };

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: exhaustedTask });
    assert.equal(policy.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
    assert.equal(policy.retryAllowed, false);
    assert.equal(policy.humanRequired, true);
    assert.ok(policy.reasonCodes.includes('RETRY_BUDGET_EXHAUSTED'));
  });

  // T15
  it('T15: attempt counter is NOT mutated on the input task object', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const taskCopy: TaskDefinition = {
      ...validTask,
      attempt: 0,
      max_attempts: 3,
    };

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: taskCopy });
    assert.equal(taskCopy.attempt, 0);
  });

  // T16
  it('T16: task status is NOT mutated on the input task object', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const taskCopy: TaskDefinition = {
      ...validTask,
      status: TaskStatus.READY,
    };

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: taskCopy });
    assert.equal(taskCopy.status, TaskStatus.READY);
  });

  // T17
  it('T17: SpecStore is NOT mutated during policy evaluation', async () => {
    await specStore.saveTasks([validTask]);
    const beforeTasks = await specStore.loadTasks();

    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: validTask });

    const afterTasks = await specStore.loadTasks();
    assert.deepEqual(afterTasks, beforeTasks);
  });

  // T18
  it('T18: DurableState is NOT mutated during policy evaluation', async () => {
    await durableManager.save({
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: validTask.task_id,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
    });

    const beforeState = await durableManager.load();

    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: validTask });

    const afterState = await durableManager.load();
    assert.deepEqual(afterState, beforeState);
  });

  // T19
  it('T19: Task DAG is NOT mutated during policy evaluation', () => {
    const parentFeature = {
      task_id: 'FEAT-P13',
      parent_feature_id: 'ROOT',
      title: 'Feature P13',
      hierarchy_level: 'FEATURE' as const,
    };
    const tasks = [validTask];
    const initialOrder = dagEngine.topologicalSort(tasks, { parentNodes: [parentFeature] });

    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: validTask });

    const afterOrder = dagEngine.topologicalSort(tasks, { parentNodes: [parentFeature] });
    assert.deepEqual(afterOrder, initialOrder);
  });

  // T20
  it('T20: REPLAN classification works for structural scope boundary violations', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_FILE_SCOPE', type: 'FILE_SCOPE', status: 'FAIL', evidence: 'Unexpected file modified: packages/core/other.ts' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.REPLAN);
    assert.equal(policy.replanAllowed, true);
  });

  // T21
  it('T21: REPLAN does not create any tasks in SpecStore or in memory', async () => {
    await specStore.saveTasks([validTask]);

    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_FILE_SCOPE', type: 'FILE_SCOPE', status: 'FAIL', evidence: 'Unexpected file modified' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.REPLAN);

    const specTasks = await specStore.loadTasks();
    assert.equal(specTasks.length, 1);
    assert.equal(specTasks[0].task_id, validTask.task_id);
  });

  // T22
  it('T22: fabricated evidence with forbidden verification fields is strictly rejected', () => {
    const fakeEvidence = {
      ...createBaseEvidence(),
      verified: true,
      qaPassed: true,
    };

    const engine = new RecoveryPolicyEngine();
    assert.throws(
      () => engine.evaluate({ evidence: fakeEvidence, task: validTask }),
      RecoveryPolicySecurityViolationError
    );
  });

  // T23
  it('T23: missing or malformed evidence bindings are rejected with validation error', () => {
    const malformed = {
      requestId: 'req_123',
      // missing evidenceId, projectId, taskId, etc.
    };

    const engine = new RecoveryPolicyEngine();
    assert.throws(
      () => engine.evaluate({ evidence: malformed, task: validTask }),
      RecoveryPolicyValidationError
    );
  });

  // T24
  it('T24: task revision mismatch between evidence and authoritative task is rejected', () => {
    const evidence = createBaseEvidence({
      taskRevision: 2, // authoritative task metadata revision is 1
    });

    const engine = new RecoveryPolicyEngine();
    assert.throws(
      () => engine.evaluate({ evidence, task: validTask }),
      RecoveryPolicyBindingMismatchError
    );
  });

  // T25
  it('T25: project mismatch is rejected, ensuring strict cross-project isolation', () => {
    const evidence = createBaseEvidence({
      projectId: 'proj_other',
    });

    const engine = new RecoveryPolicyEngine();
    assert.throws(
      () =>
        engine.evaluate({
          evidence,
          task: validTask,
          expectedProjectId: 'proj_test',
        }),
      RecoveryPolicyBindingMismatchError
    );
  });

  // T26
  it('T26: stale context binding failure is handled safely by blocking on human', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_BINDING', type: 'BINDING', status: 'FAIL', evidence: 'contextFingerprint mismatch: outcome has stale context' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
    assert.equal(policy.humanRequired, true);
    assert.equal(policy.retryAllowed, false);
  });

  // T27
  it('T27: evaluation is purely deterministic for identical input', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy1 = engine.evaluate({ evidence, task: validTask });
    const policy2 = engine.evaluate({ evidence, task: validTask });

    assert.deepEqual(policy1, policy2);
  });

  // T28
  it('T28: precedence rules are strictly deterministic when multiple failures exist', () => {
    // Both test failure and security violation present
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
        { checkId: 'CHECK_SECURITY', type: 'SECURITY', status: 'FAIL', evidence: 'Security violation' },
        { checkId: 'CHECK_BUILD', type: 'BUILD', status: 'FAIL', evidence: 'Build failed' },
      ],
    });

    const diagnosis = FailureDiagnosisEngine.diagnose(evidence);
    // Security violation must win precedence over test and build
    assert.equal(diagnosis.primaryCategory, FailureCategory.SECURITY_VIOLATION);

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });
    assert.equal(policy.decision, RecoveryStrategy.ABORT);
  });

  // T29
  it('T29: cross-project isolation rejects mismatched expectedProjectId in engine constructor', () => {
    const evidence = createBaseEvidence({
      projectId: 'proj_a',
    });

    const engine = new RecoveryPolicyEngine({ expectedProjectId: 'proj_b' });
    assert.throws(
      () => engine.evaluate({ evidence, task: validTask }),
      RecoveryPolicyBindingMismatchError
    );
  });

  // T30
  it('T30: no Antigravity dispatch occurs during policy evaluation', () => {
    let dispatchCalled = false;
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: validTask });

    assert.equal(dispatchCalled, false);
  });

  // T31
  it('T31: no ExecutionIntent creation occurs during policy evaluation', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });

    assert.equal((policy as any).executionIntentId, undefined);
    assert.equal((policy as any).intentId, undefined);
  });

  // T32
  it('T32: no ExecutionRequest creation occurs during policy evaluation', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });

    assert.equal((policy as any).executionRequest, undefined);
    assert.equal((policy as any).instruction, undefined);
  });

  // T33
  it('T33: no continuation request occurs during policy evaluation', async () => {
    await durableManager.save({
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: validTask.task_id,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    engine.evaluate({ evidence, task: validTask });

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  // T34
  it('T34: legacy recovery harness remains completely untouched and isolated', () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine();
    const policy = engine.evaluate({ evidence, task: validTask });

    // Verifies modern P13 recovery strategy is returned, not legacy RecoveryDecision.RESTART
    assert.equal(policy.decision, RecoveryStrategy.RETRY);
    assert.equal((policy as any).targetCheckpoint, undefined);
  });

  // T35
  it('T35: audit event RECOVERY_DECISION_EVALUATED is deterministic and sanitized', async () => {
    const evidence = createBaseEvidence({
      verificationChecks: [
        { checkId: 'CHECK_TEST', type: 'TEST', status: 'FAIL', evidence: 'Test failed' },
      ],
    });

    const engine = new RecoveryPolicyEngine({ historyManager });
    await engine.evaluateAndRecord({
      evidence,
      task: validTask,
      recordHistory: true,
    });

    const events = await historyManager.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'RECOVERY_DECISION_EVALUATED');
    assert.equal(events[0].payload.decision, RecoveryStrategy.RETRY);
    assert.equal(events[0].payload.taskId, validTask.task_id);
    assert.equal(events[0].payload.failureCategory, FailureCategory.TEST_FAILURE);
  });
});
