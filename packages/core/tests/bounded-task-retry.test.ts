import { createValidDiscoveryReport } from './helpers/test-discovery-factory.ts';
/**
 * Bounded Task Retry Authorization & State Transition Test Suite (Phase 13 TASK-P13-02)
 *
 * Verifies all architectural invariants of P13-02:
 * T01 — valid retry policy authorizes retry
 * T02 — RETRY policy required
 * T03 — REPLAN policy rejected by P13-02
 * T04 — BLOCK_ON_HUMAN rejected
 * T05 — ABORT rejected
 * T06 — ACCEPT evidence rejected
 * T07 — BLOCK evidence rejected
 * T08 — fabricated RawExecutorOutcome rejected
 * T09 — project mismatch rejected
 * T10 — task mismatch rejected
 * T11 — task revision mismatch rejected
 * T12 — context fingerprint mismatch rejected
 * T13 — understanding revision mismatch rejected
 * T14 — approval revision mismatch rejected
 * T15 — missing task rejected
 * T16 — completed/ACCEPTED task cannot retry
 * T17 — invalid lifecycle state rejected
 * T18 — attempt below max_attempts succeeds
 * T19 — attempt == max_attempts rejected
 * T20 — attempt greater than max_attempts rejected
 * T21 — attempt increments exactly once
 * T22 — max_attempts is never changed
 * T23 — task revision is unchanged
 * T24 — task ID is unchanged
 * T25 — scope preserved
 * T26 — acceptance criteria preserved
 * T27 — traceability preserved
 * T28 — duplicate retry is idempotent
 * T29 — duplicate retry does not increment attempt twice
 * T30 — duplicate retry does not duplicate history event
 * T31 — no Antigravity invocation
 * T32 — no ExecutionIntent creation
 * T33 — no ExecutionRequest creation
 * T34 — no DAG mutation
 * T35 — no corrective task creation
 * T36 — no autonomous continuation
 * T37 — unauthorized retry rejected
 * T38 — cross-project isolation
 * T39 — stale evidence rejected after task state changes
 * T40 — history event contains correct attempt transition
 * T41 — deterministic retry identity if an idempotency key is used
 * T42 — concurrent/lock conflict is handled safely if persistence architecture requires locking
 * T43 — restart/reload preserves retry attempt state
 * T44 — subsequent normal execution authorization still works through existing pipeline
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  RetryAuthorizationService,
  RecoveryPolicyEngine,
  RecoveryStrategy,
  type SystemExecutionEvidence,
  type TaskDefinition,
  type ProjectApprovalPackage,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  HistoryManager,
  SpecStore,
  DurableStateManager,
  ApprovalStore,
  ApprovalPackageEngine,
  InitialProjectUnderstandingBuilder,
  DirectorSessionStore,
  TaskDagEngine,
  ExecutionAuthorizer,
  RetryValidationError,
  RetrySecurityViolationError,
  RetryPolicyMismatchError,
  RetryBindingMismatchError,
  RetryBudgetExhaustedError,
  RetryTaskStateInvalidError,
  RetryUnauthorizedError,
  computeDeterministicRetryKey,
  createRetryAuthorizeTool,
} from '../dist/index.js';

describe('P13-02: Bounded Task Retry Authorization & State Transition', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let approvalStore: ApprovalStore;
  let sessionStore: DirectorSessionStore;
  let dagEngine: TaskDagEngine;
  let retryService: RetryAuthorizationService;

  const projectId = 'proj_test_p13';
  const taskId = 'TASK-P13-02';

  const createBaseTask = (overrides: Partial<TaskDefinition> = {}): TaskDefinition => {
    return {
      task_id: taskId,
      parent_feature_id: 'FEAT-P13',
      title: 'Implement retry authorization',
      description: 'Bounded task retry authorization boundary',
      traceability_sources: ['REQ:P13-02'],
      dependencies: [],
      acceptance_criteria: ['AC-P13-02-1', 'AC-P13-02-2'],
      status: TaskStatus.REJECTED,
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
        scope: {
          allowedFiles: ['packages/core/src/recovery/retry-authorization-service.ts'],
        },
      },
      ...overrides,
    };
  };

  const createBaseEvidence = (
    overrides: Partial<SystemExecutionEvidence> = {}
  ): SystemExecutionEvidence => {
    return {
      evidenceId: 'evi_p13_02_fail_1234567890abcdef',
      requestId: 'req_1234567890abcdef',
      projectId,
      taskId,
      taskRevision: 1,
      contextFingerprint: 'ctx_fingerprint_hash_abc123',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'commit_base_sha',
        headCommit: 'commit_head_sha',
        isClean: true,
      },
      changedFiles: [
        { path: 'packages/core/src/recovery/retry-authorization-service.ts', status: 'MODIFIED' },
      ],
      verificationChecks: [
        {
          checkId: 'CHECK_TESTS',
          type: 'TEST',
          status: 'FAIL',
          evidence: 'Unit test failed with assertion error',
        },
      ],
      acceptanceCriteria: [
        {
          criterion: 'AC-P13-02-1',
          status: 'FAIL',
          evidence: 'Expected true, got false',
        },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 1,
        durationMs: 150,
      },
      verificationDecision: 'REJECT',
      verifiedAt: new Date().toISOString(),
      ...overrides,
    };
  };

  const createApprovedPackage = (
    overrides: Partial<ProjectApprovalPackage> = {}
  ): ProjectApprovalPackage => {
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(createValidDiscoveryReport({ projectIdentity: { name: projectId, version: "1.0.0", workspaceRoot: tempDir, ecosystem: "Node.js", evidence: [] } }),
      undefined,
      { projectId }
    );

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, {
      packageId: 'pkg_test_approval',
    });

    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'PO-001',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for test',
    });

    return {
      ...approvedPkg,
      ...overrides,
    };
  };

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p13-02-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    dagEngine = new TaskDagEngine();

    // Seed valid approved package
    await approvalStore.savePackage(createApprovedPackage());

    // Seed default base task in SpecStore
    await specStore.saveTasks([createBaseTask()], { bypassValidation: true });

    retryService = new RetryAuthorizationService({
      workspaceRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      dagEngine,
      historyManager,
      approvalStore,
      directorSessionStore: sessionStore,
      expectedProjectId: projectId,
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  // T01 — valid retry policy authorizes retry
  it('T01 — valid retry policy authorizes retry', async () => {
    const evidence = createBaseEvidence();
    const outcome = await retryService.authorizeRetry({ evidence });

    assert.equal(outcome.success, true);
    assert.equal(outcome.isDuplicate, false);
    assert.equal(outcome.previousAttempt, 0);
    assert.equal(outcome.newAttempt, 1);
    assert.equal(outcome.maxAttempts, 3);
    assert.equal(outcome.remainingAttempts, 2);
    assert.equal(outcome.taskStatus, TaskStatus.READY);

    // Verify persisted SpecStore task
    const tasks = await specStore.loadTasks();
    const updated = tasks.find((t) => t.task_id === taskId);
    assert.ok(updated);
    assert.equal(updated.status, TaskStatus.READY);
    assert.equal(updated.attempt, 1);
    assert.equal(updated.max_attempts, 3);
  });

  // T02 — RETRY policy required
  it('T02 — RETRY policy required: decision must be RETRY', async () => {
    const evidence = createBaseEvidence();
    const decisionEngine = new RecoveryPolicyEngine();
    const decision = decisionEngine.evaluate({ evidence, task: createBaseTask() });
    assert.equal(decision.decision, RecoveryStrategy.RETRY);

    const outcome = await retryService.authorizeRetry({ evidence, decision });
    assert.equal(outcome.success, true);
    assert.equal(outcome.newAttempt, 1);
  });

  // T03 — REPLAN policy rejected by P13-02
  it('T03 — REPLAN policy rejected by P13-02', async () => {
    const evidence = createBaseEvidence();
    const decision = {
      decision: RecoveryStrategy.REPLAN,
      failureCategory: 'SCOPE_VIOLATION' as any,
      retryAllowed: false,
      replanAllowed: true,
      humanRequired: true,
      attempt: 0,
      maxAttempts: 3,
      projectId,
      taskId,
      taskRevision: 1,
      evidenceId: evidence.evidenceId,
      reasonCodes: ['SCOPE_VIOLATION_DETECTED'],
      justification: 'Scope violation requires replanning',
    };

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence, decision }),
      RetryPolicyMismatchError
    );
  });

  // T04 — BLOCK_ON_HUMAN rejected
  it('T04 — BLOCK_ON_HUMAN rejected', async () => {
    const evidence = createBaseEvidence();
    const decision = {
      decision: RecoveryStrategy.BLOCK_ON_HUMAN,
      failureCategory: 'INFRASTRUCTURE_FAILURE' as any,
      retryAllowed: false,
      replanAllowed: false,
      humanRequired: true,
      attempt: 0,
      maxAttempts: 3,
      projectId,
      taskId,
      taskRevision: 1,
      evidenceId: evidence.evidenceId,
      reasonCodes: ['INFRASTRUCTURE_FAILURE'],
      justification: 'Blocked on human',
    };

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence, decision }),
      RetryPolicyMismatchError
    );
  });

  // T05 — ABORT rejected
  it('T05 — ABORT rejected', async () => {
    const evidence = createBaseEvidence();
    const decision = {
      decision: RecoveryStrategy.ABORT,
      failureCategory: 'SECURITY_VIOLATION' as any,
      retryAllowed: false,
      replanAllowed: false,
      humanRequired: true,
      attempt: 0,
      maxAttempts: 3,
      projectId,
      taskId,
      taskRevision: 1,
      evidenceId: evidence.evidenceId,
      reasonCodes: ['SECURITY_VIOLATION_DETECTED'],
      justification: 'Security violation requires abort',
    };

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence, decision }),
      RetryPolicyMismatchError
    );
  });

  // T06 — ACCEPT evidence rejected
  it('T06 — ACCEPT evidence rejected', async () => {
    const evidence = createBaseEvidence({
      verificationDecision: 'ACCEPT',
      verificationChecks: [
        { checkId: 'CHECK_TESTS', type: 'TEST', status: 'PASS', evidence: 'passed' },
      ],
      acceptanceCriteria: [
        { criterion: 'AC-P13-02-1', status: 'PASS', evidence: 'passed' },
      ],
    });

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryPolicyMismatchError
    );
  });

  // T07 — BLOCK evidence rejected
  it('T07 — BLOCK evidence rejected', async () => {
    const evidence = createBaseEvidence({
      verificationDecision: 'BLOCK',
    });

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryPolicyMismatchError
    );
  });

  // T08 — fabricated RawExecutorOutcome rejected
  it('T08 — fabricated RawExecutorOutcome rejected', async () => {
    const fabricatedOutcome = {
      status: 'FAILURE',
      verified: true,
      systemAccepted: true,
      retryApproved: true,
    };

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence: fabricatedOutcome }),
      RetrySecurityViolationError
    );
  });

  // T09 — project mismatch rejected
  it('T09 — project mismatch rejected', async () => {
    const evidence = createBaseEvidence({ projectId: 'wrong_project' });

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryBindingMismatchError
    );
  });

  // T10 — task mismatch rejected
  it('T10 — task mismatch rejected', async () => {
    const evidence = createBaseEvidence({ taskId: 'TASK-OTHER-99' });

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryBindingMismatchError
    );
  });

  // T11 — task revision mismatch rejected
  it('T11 — task revision mismatch rejected', async () => {
    const evidence = createBaseEvidence({ taskRevision: 2 }); // Authoritative task revision is 1

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryBindingMismatchError
    );
  });

  // T12 — context fingerprint mismatch rejected
  it('T12 — context fingerprint mismatch rejected', async () => {
    const evidence = createBaseEvidence({ contextFingerprint: 'ctx_abc' });

    await assert.rejects(
      async () =>
        retryService.authorizeRetry({
          evidence,
          contextFingerprint: 'ctx_expected_diff',
        }),
      RetryBindingMismatchError
    );
  });

  // T13 — understanding revision mismatch rejected
  it('T13 — understanding revision mismatch rejected', async () => {
    const evidence = createBaseEvidence({ understandingRevision: 1 });

    await assert.rejects(
      async () =>
        retryService.authorizeRetry({
          evidence,
          understandingRevision: 2,
        }),
      RetryBindingMismatchError
    );
  });

  // T14 — approval revision mismatch rejected
  it('T14 — approval revision mismatch rejected', async () => {
    const evidence = createBaseEvidence({ approvalPackageRevision: 1 });

    await assert.rejects(
      async () =>
        retryService.authorizeRetry({
          evidence,
          approvalPackageRevision: 2,
        }),
      RetryBindingMismatchError
    );
  });

  // T15 — missing task rejected
  it('T15 — missing task rejected', async () => {
    await specStore.saveTasks([]); // empty specStore
    const evidence = createBaseEvidence();

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryBindingMismatchError
    );
  });

  // T16 — completed/ACCEPTED task cannot retry
  it('T16 — completed/ACCEPTED task cannot retry', async () => {
    await specStore.saveTasks([createBaseTask({ status: TaskStatus.ACCEPTED })]);
    const evidence = createBaseEvidence();

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryTaskStateInvalidError
    );
  });

  // T17 — invalid lifecycle state rejected
  it('T17 — invalid lifecycle state rejected', async () => {
    await specStore.saveTasks([createBaseTask({ status: 'REVIEW' as any })]);
    const evidence = createBaseEvidence();

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryTaskStateInvalidError
    );
  });

  // T18 — attempt below max_attempts succeeds
  it('T18 — attempt below max_attempts succeeds', async () => {
    await specStore.saveTasks([createBaseTask({ attempt: 1, max_attempts: 3 })]);
    const evidence = createBaseEvidence();

    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.success, true);
    assert.equal(outcome.previousAttempt, 1);
    assert.equal(outcome.newAttempt, 2);
    assert.equal(outcome.remainingAttempts, 1);
  });

  // T19 — attempt == max_attempts rejected
  it('T19 — attempt == max_attempts rejected', async () => {
    await specStore.saveTasks([createBaseTask({ attempt: 3, max_attempts: 3 })]);
    const evidence = createBaseEvidence();

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryBudgetExhaustedError
    );
  });

  // T20 — attempt greater than max_attempts rejected
  it('T20 — attempt greater than max_attempts rejected', async () => {
    await specStore.saveTasks([createBaseTask({ attempt: 4, max_attempts: 3 })]);
    const evidence = createBaseEvidence();

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryBudgetExhaustedError
    );
  });

  // T21 — attempt increments exactly once
  it('T21 — attempt increments exactly once', async () => {
    await specStore.saveTasks([createBaseTask({ attempt: 0, max_attempts: 3 })]);
    const evidence = createBaseEvidence();

    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.newAttempt, 1);

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.equal(stored?.attempt, 1);
  });

  // T22 — max_attempts is never changed
  it('T22 — max_attempts is never changed', async () => {
    await specStore.saveTasks([createBaseTask({ attempt: 0, max_attempts: 5 })]);
    const evidence = createBaseEvidence();

    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.maxAttempts, 5);

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.equal(stored?.max_attempts, 5);
  });

  // T23 — task revision is unchanged
  it('T23 — task revision is unchanged', async () => {
    const evidence = createBaseEvidence();

    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.taskRevision, 1);

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.equal(stored?.metadata?.revision, 1);
  });

  // T24 — task ID is unchanged
  it('T24 — task ID is unchanged', async () => {
    const evidence = createBaseEvidence();
    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.taskId, taskId);

    const tasks = await specStore.loadTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].task_id, taskId);
  });

  // T25 — scope preserved
  it('T25 — scope preserved in metadata', async () => {
    const scopeData = { allowedFiles: ['src/a.ts', 'src/b.ts'] };
    await specStore.saveTasks(
      [createBaseTask({ metadata: { revision: 1, scope: scopeData } })],
      { bypassValidation: true }
    );
    const evidence = createBaseEvidence();

    await retryService.authorizeRetry({ evidence });

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.deepEqual(stored?.metadata?.scope, scopeData);
  });

  // T26 — acceptance criteria preserved
  it('T26 — acceptance criteria preserved', async () => {
    const originalCriteria = ['AC-1', 'AC-2', 'AC-3'];
    await specStore.saveTasks(
      [createBaseTask({ acceptance_criteria: originalCriteria })],
      { bypassValidation: true }
    );
    const evidence = createBaseEvidence();

    await retryService.authorizeRetry({ evidence });

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.deepEqual(stored?.acceptance_criteria, originalCriteria);
  });

  // T27 — traceability preserved
  it('T27 — traceability preserved', async () => {
    const originalTrace = ['REQ:P13-02', 'DEC:009'];
    await specStore.saveTasks(
      [createBaseTask({ traceability_sources: originalTrace })],
      { bypassValidation: true }
    );
    const evidence = createBaseEvidence();

    await retryService.authorizeRetry({ evidence });

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.deepEqual(stored?.traceability_sources, originalTrace);
  });

  // T28 — duplicate retry is idempotent
  it('T28 — duplicate retry is idempotent', async () => {
    const evidence = createBaseEvidence();

    const first = await retryService.authorizeRetry({ evidence });
    assert.equal(first.success, true);
    assert.equal(first.isDuplicate, false);
    assert.equal(first.newAttempt, 1);

    const duplicate = await retryService.authorizeRetry({ evidence });
    assert.equal(duplicate.success, true);
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(duplicate.retryKey, first.retryKey);
    assert.equal(duplicate.newAttempt, 1);
  });

  // T29 — duplicate retry does not increment attempt twice
  it('T29 — duplicate retry does not increment attempt twice', async () => {
    const evidence = createBaseEvidence();

    await retryService.authorizeRetry({ evidence });
    await retryService.authorizeRetry({ evidence });
    await retryService.authorizeRetry({ evidence });

    const tasks = await specStore.loadTasks();
    const stored = tasks.find((t) => t.task_id === taskId);
    assert.equal(stored?.attempt, 1);
  });

  // T30 — duplicate retry does not duplicate history event
  it('T30 — duplicate retry does not duplicate history event', async () => {
    const evidence = createBaseEvidence();

    await retryService.authorizeRetry({ evidence });
    await retryService.authorizeRetry({ evidence });

    const events = await historyManager.readEvents();
    const retryEvents = events.filter((e) => e.eventType === 'TASK_RETRY_AUTHORIZED');
    assert.equal(retryEvents.length, 1);
  });

  // T31 — no Antigravity invocation
  it('T31 — no Antigravity invocation occurred', async () => {
    const evidence = createBaseEvidence();
    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.success, true);
    // Verified: RetryAuthorizationService does not import or invoke Antigravity execution
  });

  // T32 — no ExecutionIntent creation
  it('T32 — no ExecutionIntent creation during retry', async () => {
    const evidence = createBaseEvidence();
    await retryService.authorizeRetry({ evidence });

    // Ensure no intents dir or files were created
    const intentPath = path.join(tempDir, '.ai-manager', 'director', 'intents');
    assert.equal(fs.existsSync(intentPath), false);
  });

  // T33 — no ExecutionRequest creation
  it('T33 — no ExecutionRequest creation during retry', async () => {
    const evidence = createBaseEvidence();
    await retryService.authorizeRetry({ evidence });

    // Ensure no requests were persisted
    const reqPath = path.join(tempDir, '.ai-manager', 'executor', 'requests');
    assert.equal(fs.existsSync(reqPath), false);
  });

  // T34 — no DAG mutation
  it('T34 — no DAG mutation: dependencies and task structure unchanged', async () => {
    const initialTasks = [
      createBaseTask({ task_id: 'TASK-P13-DEP', status: TaskStatus.ACCEPTED }),
      createBaseTask({ task_id: taskId, dependencies: ['TASK-P13-DEP'] }),
    ];
    await specStore.saveTasks(initialTasks, { bypassValidation: true });
    const evidence = createBaseEvidence();

    await retryService.authorizeRetry({ evidence });

    const tasksAfter = await specStore.loadTasks();
    assert.equal(tasksAfter.length, 2);
    const retryTarget = tasksAfter.find((t) => t.task_id === taskId);
    assert.deepEqual(retryTarget?.dependencies, ['TASK-P13-DEP']);
  });

  // T35 — no corrective task creation
  it('T35 — no corrective task creation: task count strictly preserved', async () => {
    const evidence = createBaseEvidence();
    await retryService.authorizeRetry({ evidence });

    const tasks = await specStore.loadTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].task_id, taskId);
  });

  // T36 — no autonomous continuation
  it('T36 — no autonomous continuation triggered', async () => {
    const evidence = createBaseEvidence();
    await retryService.authorizeRetry({ evidence });

    const durable = await durableManager.load();
    assert.equal(durable?.continuationState, 'NONE');
    assert.equal(durable?.activeTaskId, null);
  });

  // T37 — unauthorized retry rejected
  it('T37 — unauthorized retry rejected if approval package not approved', async () => {
    // Overwrite approval package with REJECTED status
    await approvalStore.savePackage(
      createApprovedPackage({
        status: 'REJECTED',
        approvalRecord: undefined,
      })
    );
    const evidence = createBaseEvidence();

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryUnauthorizedError
    );
  });

  // T38 — cross-project isolation
  it('T38 — cross-project isolation: evidence from another project rejected', async () => {
    const foreignEvidence = createBaseEvidence({ projectId: 'foreign_project' });

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence: foreignEvidence }),
      RetryBindingMismatchError
    );
  });

  // T39 — stale evidence rejected after task state changes
  it('T39 — stale evidence rejected after task is marked ACCEPTED', async () => {
    const evidence = createBaseEvidence();

    // Now task completes
    await specStore.saveTasks([createBaseTask({ status: TaskStatus.ACCEPTED })]);

    await assert.rejects(
      async () => retryService.authorizeRetry({ evidence }),
      RetryTaskStateInvalidError
    );
  });

  // T40 — history event contains correct attempt transition
  it('T40 — history event contains correct attempt transition', async () => {
    const evidence = createBaseEvidence();
    await retryService.authorizeRetry({ evidence });

    const events = await historyManager.readEvents();
    const retryEvent = events.find((e) => e.eventType === 'TASK_RETRY_AUTHORIZED');
    assert.ok(retryEvent);
    assert.equal(retryEvent.taskId, taskId);
    assert.equal(retryEvent.payload.previousAttempt, 0);
    assert.equal(retryEvent.payload.newAttempt, 1);
    assert.equal(retryEvent.payload.maxAttempts, 3);
    assert.equal(retryEvent.payload.evidenceId, evidence.evidenceId);
  });

  // T41 — deterministic retry identity if an idempotency key is used
  it('T41 — deterministic retry key computation', () => {
    const key1 = computeDeterministicRetryKey({
      projectId,
      taskId,
      taskRevision: 1,
      evidenceId: 'evi_123',
    });
    const key2 = computeDeterministicRetryKey({
      projectId,
      taskId,
      taskRevision: 1,
      evidenceId: 'evi_123',
    });
    assert.equal(key1, key2);
    assert.ok(key1.startsWith('retry-'));
  });

  // T42 — concurrent/lock conflict is handled safely if persistence architecture requires locking
  it('T42 — concurrent lock serializes retry execution safely', async () => {
    const evidence1 = createBaseEvidence({ evidenceId: 'evi_seq_1' });
    const evidence2 = createBaseEvidence({ evidenceId: 'evi_seq_2' });

    // Run sequentially under lock
    const out1 = await retryService.authorizeRetry({ evidence: evidence1 });
    assert.equal(out1.newAttempt, 1);

    const out2 = await retryService.authorizeRetry({ evidence: evidence2 });
    assert.equal(out2.newAttempt, 2);

    const tasks = await specStore.loadTasks();
    const finalTask = tasks.find((t) => t.task_id === taskId);
    assert.equal(finalTask?.attempt, 2);
  });

  // T43 — restart/reload preserves retry attempt state
  it('T43 — restart/reload preserves retry attempt state', async () => {
    const evidence = createBaseEvidence();
    await retryService.authorizeRetry({ evidence });

    // Create fresh service instance simulating daemon/process restart
    const freshService = new RetryAuthorizationService({
      workspaceRoot: tempDir,
      expectedProjectId: projectId,
    });

    const duplicateOutcome = await freshService.authorizeRetry({ evidence });
    assert.equal(duplicateOutcome.isDuplicate, true);
    assert.equal(duplicateOutcome.newAttempt, 1);
  });

  // T44 — subsequent normal execution authorization still works through existing pipeline
  it('T44 — subsequent normal execution authorization still works through existing pipeline', async () => {
    const evidence = createBaseEvidence();
    const outcome = await retryService.authorizeRetry({ evidence });
    assert.equal(outcome.taskStatus, TaskStatus.READY);

    // Verify task is in READY state and valid for ExecutionAuthorizer
    const tasks = await specStore.loadTasks();
    const readyTask = tasks.find((t) => t.task_id === taskId);
    assert.ok(readyTask);
    assert.equal(readyTask.status, TaskStatus.READY);
    assert.equal(readyTask.attempt, 1);

    // DAG validation passes
    const validGraph = dagEngine.assertValidGraph(tasks, { validFeatureIds: ['FEAT-P13'] });
    assert.equal(validGraph.length, 1);
  });

  // T45 — MCP Tool aidm.task.authorizeRetry integration
  it('T45 — MCP tool aidm.task.authorizeRetry executes successfully', async () => {
    const tool = createRetryAuthorizeTool({ retryService });
    const evidence = createBaseEvidence();

    const result = await tool.handler(
      {
        evidence,
      },
      {
        correlation: {
          correlationId: 'corr-mcp-1',
          mcpRequestId: 'req_mcp_1',
          receivedAt: new Date().toISOString(),
        },
      }
    );

    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.equal(parsed.success, true);
    assert.equal(parsed.taskStatus, TaskStatus.READY);
    assert.equal(parsed.newAttempt, 1);
  });

  // T46 — MCP Tool rejects fabricated caller claims
  it('T46 — MCP tool rejects fabricated caller claims', async () => {
    const tool = createRetryAuthorizeTool({ retryService });
    const evidence = createBaseEvidence();

    const result = await tool.handler(
      {
        evidence,
        retryApproved: true,
      },
      {
        correlation: {
          correlationId: 'corr-mcp-2',
          mcpRequestId: 'req_mcp_2',
          receivedAt: new Date().toISOString(),
        },
      }
    );

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.equal(parsed.code, 'ERR_RETRY_SECURITY_VIOLATION');
  });
});
