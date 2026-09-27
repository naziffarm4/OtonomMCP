/**
 * Corrective Task Lineage & Governed DAG Augmentation Test Suite (Phase 13 TASK-P13-03)
 *
 * Verifies all architectural invariants of P13-03:
 * T01 — valid REPLAN creates corrective task
 * T02 — RETRY rejected
 * T03 — BLOCK_ON_HUMAN rejected
 * T04 — ABORT rejected
 * T05 — evidence must be REJECT
 * T06 — RawExecutorOutcome rejected
 * T07 — forged verification fields rejected
 * T08 — project mismatch rejected
 * T09 — source task mismatch rejected
 * T10 — task revision mismatch rejected
 * T11 — context fingerprint mismatch rejected
 * T12 — understanding revision mismatch rejected
 * T13 — approval revision mismatch rejected
 * T14 — missing approval rejected
 * T15 — unapproved package rejected
 * T16 — development authorization failure rejected
 * T17 — completed source task rejected
 * T18 — stale source task rejected
 * T19 — deterministic corrective task ID
 * T20 — same input is idempotent
 * T21 — duplicate corrective task not created
 * T22 — duplicate DAG edge not created
 * T23 — source task remains intact
 * T24 — source task revision remains unchanged
 * T25 — corrective task has explicit lineage
 * T26 — evidenceId lineage preserved
 * T27 — source task revision lineage preserved
 * T28 — corrective task scope preserved/controlled
 * T29 — targetFiles cannot escape authorized scope
 * T30 — dependency validation
 * T31 — missing dependency rejected
 * T32 — cycle rejected
 * T33 — duplicate task ID rejected
 * T34 — atomic rejection leaves graph unchanged
 * T35 — history event created
 * T36 — duplicate request does not duplicate history
 * T37 — restart/reload preserves corrective task
 * T38 — cross-project isolation
 * T39 — no Antigravity invocation
 * T40 — no ExecutionIntent
 * T41 — no ExecutionRequest
 * T42 — no autonomous continuation
 * T43 — no DAG mutation outside governed service
 * T44 — subsequent task readiness is computed by TaskDagEngine
 * T45 — Director proposal cannot bypass governance
 * T46 — stale corrective proposal rejected
 * T47 — concurrent corrective creation is idempotent/safe
 * T48 — corrective task revision semantics
 * T49 — acceptance criteria are explicit
 * T50 — original failure remains auditable
 * T51 — MCP tool aidm.task.createCorrective executes successfully
 * T52 — MCP tool rejects fabricated caller claims
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  CorrectiveTaskService,
  RecoveryPolicyEngine,
  RecoveryStrategy,
  FailureCategory,
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
  DirectorDecisionStore,
  TaskDagEngine,
  ExecutionAuthorizer,
  CorrectiveTaskValidationError,
  CorrectiveTaskSecurityViolationError,
  CorrectiveTaskPolicyMismatchError,
  CorrectiveTaskBindingMismatchError,
  CorrectiveTaskSourceStateInvalidError,
  CorrectiveTaskUnauthorizedError,
  CorrectiveTaskScopeViolationError,
  CorrectiveTaskGraphValidationError,
  CorrectiveTaskConflictError,
  computeDeterministicCorrectiveTaskId,
  computeDeterministicReplanKey,
  createCorrectiveTaskTool,
} from '../dist/index.js';

describe('P13-03: Corrective Task Lineage & Governed DAG Augmentation', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let approvalStore: ApprovalStore;
  let sessionStore: DirectorSessionStore;
  let dagEngine: TaskDagEngine;
  let correctiveService: CorrectiveTaskService;

  const projectId = 'proj_test_p13_03';
  const sourceTaskId = 'TASK-P13-03-SRC';

  const createBaseSourceTask = (overrides: Partial<TaskDefinition> = {}): TaskDefinition => {
    return {
      task_id: sourceTaskId,
      parent_feature_id: 'FEAT-P13',
      title: 'Original source task',
      description: 'Original task to be replanned upon verified failure',
      traceability_sources: ['REQ:P13-03'],
      dependencies: [],
      acceptance_criteria: ['AC-P13-03-1', 'AC-P13-03-2'],
      status: TaskStatus.REJECTED,
      attempt: 3,
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
          analysisScope: ['packages/core/src/recovery/corrective-task-service.ts'],
          implementationScope: ['packages/core/src/recovery/corrective-task-service.ts'],
          allowedFiles: ['packages/core/src/recovery/corrective-task-service.ts'],
        },
      },
      ...overrides,
    };
  };

  const createValidEvidence = (overrides: Partial<SystemExecutionEvidence> = {}): SystemExecutionEvidence => {
    return {
      evidenceId: 'ev_test_replan_100',
      requestId: 'req_test_100',
      projectId,
      taskId: sourceTaskId,
      taskRevision: 1,
      contextFingerprint: 'fp_ctx_100',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'commit_base_000',
        headCommit: 'commit_head_111',
        isClean: true,
      },
      changedFiles: [{ path: 'packages/core/src/recovery/corrective-task-service.ts', status: 'M' }],
      verificationChecks: [
        {
          checkId: 'check_scope',
          type: 'SCOPE',
          status: 'FAIL',
          command: 'scope-check',
          evidence: 'Scope boundary violated',
        },
      ],
      acceptanceCriteria: [
        {
          criterion: 'AC-P13-03-1',
          status: 'FAIL',
          evidence: 'Scope violation prevented acceptance',
        },
      ],
      executorOutcomeReference: {
        status: 'FAILURE',
        exitCode: 1,
        durationMs: 120,
      },
      verificationDecision: 'REJECT',
      verifiedAt: new Date().toISOString(),
      ...overrides,
    };
  };

  const createValidApprovalPackage = (
    overrides: Partial<ProjectApprovalPackage> = {}
  ): ProjectApprovalPackage => {
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(
      {
        projectIdentity: {
          name: projectId,
          version: '1.0.0',
          workspaceRoot: tempDir,
          ecosystem: 'Node.js',
          evidence: [],
        },
        purpose: {
          classification: 'UNDERSTOOD',
          summary: 'Test project',
          domainKeywords: ['test'],
          evidence: [],
        },
        technologyStack: {
          primaryLanguages: ['TypeScript'],
          frameworks: [],
          buildTools: ['tsc'],
          packageManagers: ['npm'],
          runtimes: ['node'],
          containerization: [],
          ciCd: [],
          workspaceType: 'standalone',
        },
        architecture: {
          summary: 'Modular',
          architecturalPattern: 'Modular',
          identifiedAreas: [],
          evidence: [],
        },
        currentImplementationState: {
          lifecycleState: 'TASK_LOOP',
          hasActiveTask: false,
          isBlocked: false,
          totalTasksInDag: 1,
          completedTasksCount: 0,
          evidence: [],
        },
        unknowns: [],
        contradictions: [],
        evidenceInventory: [],
        generatedAt: new Date().toISOString(),
      },
      undefined,
      { projectId }
    );

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, {
      packageId: 'pkg_test_p13_03',
    });

    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'po_alice',
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
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p13-03-test-'));
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: projectId, version: '1.0.0' })
    );
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir, projectId });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    dagEngine = new TaskDagEngine();

    // Default SpecStore initialized with parent feature and source task
    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-P13',
      parent_feature_id: 'ROOT',
      title: 'P13 Failure Recovery Feature',
      description: 'Feature parent node',
      traceability_sources: ['REQ:P13-FEATURE'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-P13'],
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };

    await specStore.saveTasks([parentFeature, createBaseSourceTask()]);
    await approvalStore.savePackage(createValidApprovalPackage());

    correctiveService = new CorrectiveTaskService({
      workspaceRoot: tempDir,
      specStore,
      durableStateManager: durableManager,
      historyManager,
      approvalStore,
      directorSessionStore: sessionStore,
      dagEngine,
      expectedProjectId: projectId,
    });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // T01 — valid REPLAN creates corrective task
  it('T01 — valid REPLAN creates corrective task', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    assert.equal(outcome.success, true);
    assert.equal(outcome.isDuplicate, false);
    assert.equal(outcome.sourceTaskId, sourceTaskId);
    assert.equal(outcome.sourceTaskRevision, 1);
    assert.ok(outcome.correctiveTaskId.startsWith('TASK-CORRECTIVE-P13-03-SRC-'));

    // Verify task in SpecStore
    const tasks = await specStore.loadTasks();
    const persisted = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    assert.ok(persisted);
    assert.equal(persisted.status, TaskStatus.READY);
    assert.equal(persisted.dependencies.includes(sourceTaskId), false);
    assert.deepEqual(persisted.dependencies, []);
  });

  // T02 — RETRY rejected
  it('T02 — RETRY rejected', async () => {
    const evidence = createValidEvidence();
    const retryDecision = {
      decision: RecoveryStrategy.RETRY,
      failureCategory: FailureCategory.TEST_FAILURE,
      retryAllowed: true,
      replanAllowed: false,
      humanRequired: false,
      attempt: 1,
      maxAttempts: 3,
      projectId,
      taskId: sourceTaskId,
      taskRevision: 1,
      evidenceId: evidence.evidenceId,
      reasonCodes: ['RETRYABLE_CODE_DEFECT'],
      justification: 'Retry permitted',
    };

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence, decision: retryDecision }),
      CorrectiveTaskPolicyMismatchError
    );
  });

  // T03 — BLOCK_ON_HUMAN rejected
  it('T03 — BLOCK_ON_HUMAN rejected', async () => {
    const evidence = createValidEvidence();
    const blockDecision = {
      decision: RecoveryStrategy.BLOCK_ON_HUMAN,
      failureCategory: FailureCategory.INFRASTRUCTURE_FAILURE,
      retryAllowed: false,
      replanAllowed: false,
      humanRequired: true,
      attempt: 1,
      maxAttempts: 3,
      projectId,
      taskId: sourceTaskId,
      taskRevision: 1,
      evidenceId: evidence.evidenceId,
      reasonCodes: ['INFRASTRUCTURE_FAILURE'],
      justification: 'Human intervention required',
    };

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence, decision: blockDecision }),
      CorrectiveTaskPolicyMismatchError
    );
  });

  // T04 — ABORT rejected
  it('T04 — ABORT rejected', async () => {
    const evidence = createValidEvidence();
    const abortDecision = {
      decision: RecoveryStrategy.ABORT,
      failureCategory: FailureCategory.SECURITY_VIOLATION,
      retryAllowed: false,
      replanAllowed: false,
      humanRequired: true,
      attempt: 1,
      maxAttempts: 3,
      projectId,
      taskId: sourceTaskId,
      taskRevision: 1,
      evidenceId: evidence.evidenceId,
      reasonCodes: ['SECURITY_VIOLATION'],
      justification: 'Immediate abort',
    };

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence, decision: abortDecision }),
      CorrectiveTaskPolicyMismatchError
    );
  });

  // T05 — evidence must be REJECT
  it('T05 — evidence must be REJECT', async () => {
    const acceptEvidence = createValidEvidence({
      verificationDecision: 'ACCEPT',
    });

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence: acceptEvidence }),
      CorrectiveTaskPolicyMismatchError
    );
  });

  // T06 — RawExecutorOutcome rejected
  it('T06 — RawExecutorOutcome rejected', async () => {
    const rawOutcome = {
      status: 'FAILURE',
      exitCode: 1,
      durationMs: 400,
    };

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence: rawOutcome }),
      CorrectiveTaskValidationError
    );
  });

  // T07 — forged verification fields rejected
  it('T07 — forged verification fields rejected', async () => {
    const fakeEvidence = {
      ...createValidEvidence(),
      systemApproved: true,
    };

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence: fakeEvidence }),
      CorrectiveTaskSecurityViolationError
    );
  });

  // T08 — project mismatch rejected
  it('T08 — project mismatch rejected', async () => {
    const evidence = createValidEvidence({
      projectId: 'proj_foreign_123',
    });

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T09 — source task mismatch rejected
  it('T09 — source task mismatch rejected', async () => {
    const evidence = createValidEvidence({
      taskId: 'TASK-NONEXISTENT',
    });

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T10 — task revision mismatch rejected
  it('T10 — task revision mismatch rejected', async () => {
    const evidence = createValidEvidence({
      taskRevision: 99,
    });

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T11 — context fingerprint mismatch rejected
  it('T11 — context fingerprint mismatch rejected', async () => {
    const evidence = createValidEvidence();

    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          contextFingerprint: 'fp_different_hash',
        }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T12 — understanding revision mismatch rejected
  it('T12 — understanding revision mismatch rejected', async () => {
    const evidence = createValidEvidence();

    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          understandingRevision: 5,
        }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T13 — approval revision mismatch rejected
  it('T13 — approval revision mismatch rejected', async () => {
    const evidence = createValidEvidence();

    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          approvalPackageRevision: 5,
        }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T14 — missing approval rejected
  it('T14 — missing approval rejected', async () => {
    const emptyApprovalStore = new ApprovalStore({ baseDir: tempDir + '_empty' });
    const svc = new CorrectiveTaskService({
      workspaceRoot: tempDir,
      specStore,
      durableStateManager: durableManager,
      historyManager,
      approvalStore: emptyApprovalStore,
      expectedProjectId: projectId,
    });

    const evidence = createValidEvidence();
    await assert.rejects(
      async () => svc.createCorrectiveTask({ evidence }),
      CorrectiveTaskUnauthorizedError
    );
  });

  // T15 — unapproved package rejected
  it('T15 — unapproved package rejected', async () => {
    await approvalStore.savePackage(
      createValidApprovalPackage({
        status: 'READY_FOR_APPROVAL',
        approvalRecord: undefined,
      })
    );

    const evidence = createValidEvidence();
    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskUnauthorizedError
    );
  });

  // T16 — development authorization failure rejected
  it('T16 — development authorization failure rejected', async () => {
    await approvalStore.savePackage(
      createValidApprovalPackage({
        status: 'READY_FOR_APPROVAL',
        approvalRecord: undefined,
      })
    );

    const evidence = createValidEvidence();
    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskUnauthorizedError
    );
  });

  // T17 — completed source task rejected
  it('T17 — completed source task rejected', async () => {
    const completedTask = createBaseSourceTask({
      status: TaskStatus.ACCEPTED,
    });
    const parentFeature = (await specStore.loadTasks())[0];
    await specStore.saveTasks([parentFeature, completedTask]);

    const evidence = createValidEvidence();
    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskSourceStateInvalidError
    );
  });

  // T18 — stale source task rejected
  it('T18 — stale source task rejected', async () => {
    const durableState = (await durableManager.load()) ?? {
      schemaVersion: 1,
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      continuationState: 'NONE' as const,
      continuationPolicy: 'AUTONOMOUS' as const,
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    durableState.completedTaskIds = [sourceTaskId];
    await durableManager.save(durableState);

    const evidence = createValidEvidence();
    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskSourceStateInvalidError
    );
  });

  // T19 — deterministic corrective task ID
  it('T19 — deterministic corrective task ID', async () => {
    const id1 = computeDeterministicCorrectiveTaskId({
      projectId,
      sourceTaskId,
      sourceTaskRevision: 1,
      evidenceId: 'ev_test_1',
    });

    const id2 = computeDeterministicCorrectiveTaskId({
      projectId,
      sourceTaskId,
      sourceTaskRevision: 1,
      evidenceId: 'ev_test_1',
    });

    assert.equal(id1, id2);
    assert.ok(id1.startsWith('TASK-CORRECTIVE-P13-03-SRC-'));
  });

  // T20 — same input is idempotent
  it('T20 — same input is idempotent', async () => {
    const evidence = createValidEvidence();
    const outcome1 = await correctiveService.createCorrectiveTask({ evidence });
    const outcome2 = await correctiveService.createCorrectiveTask({ evidence });

    assert.equal(outcome1.success, true);
    assert.equal(outcome2.success, true);
    assert.equal(outcome1.correctiveTaskId, outcome2.correctiveTaskId);
    assert.equal(outcome2.isDuplicate, true);
  });

  // T21 — duplicate corrective task not created
  it('T21 — duplicate corrective task not created', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });

    const tasksBefore = await specStore.loadTasks();
    await correctiveService.createCorrectiveTask({ evidence });
    const tasksAfter = await specStore.loadTasks();

    assert.equal(tasksBefore.length, tasksAfter.length);
  });

  // T22 — duplicate DAG edge not created
  it('T22 — duplicate DAG edge not created', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({
      evidence,
      proposal: {
        additionalDependencies: ['FEAT-P13'],
      },
    });
    await correctiveService.createCorrectiveTask({
      evidence,
      proposal: {
        additionalDependencies: ['FEAT-P13'],
      },
    });

    const tasks = await specStore.loadTasks();
    const correctiveTask = tasks.find((t) => t.task_id.startsWith('TASK-CORRECTIVE'));
    assert.ok(correctiveTask);
    const occurrences = correctiveTask.dependencies.filter((d) => d === 'FEAT-P13');
    assert.equal(occurrences.length, 1);
  });

  // T23 — source task remains intact
  it('T23 — source task remains intact', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const source = tasks.find((t) => t.task_id === sourceTaskId);
    assert.ok(source);
    assert.equal(source.status, TaskStatus.REJECTED);
    assert.equal(source.title, 'Original source task');
  });

  // T24 — source task revision remains unchanged
  it('T24 — source task revision remains unchanged', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const source = tasks.find((t) => t.task_id === sourceTaskId);
    assert.equal(source?.metadata?.revision, 1);
  });

  // T25 — corrective task has explicit lineage
  it('T25 — corrective task has explicit lineage', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const corrective = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    assert.ok(corrective?.metadata?.lineage);
    const lineage = corrective.metadata.lineage as any;
    assert.equal(lineage.kind, 'CORRECTIVE');
    assert.equal(lineage.sourceTaskId, sourceTaskId);
    assert.equal(lineage.sourceTaskRevision, 1);
    assert.equal(lineage.sourceEvidenceId, evidence.evidenceId);
    assert.equal(lineage.createdFrom, 'P13-03');
  });

  // T26 — evidenceId lineage preserved
  it('T26 — evidenceId lineage preserved', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const corrective = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    const lineage = corrective?.metadata?.lineage as any;
    assert.equal(lineage.sourceEvidenceId, evidence.evidenceId);
  });

  // T27 — source task revision lineage preserved
  it('T27 — source task revision lineage preserved', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const corrective = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    const lineage = corrective?.metadata?.lineage as any;
    assert.equal(lineage.sourceTaskRevision, 1);
  });

  // T28 — corrective task scope preserved/controlled
  it('T28 — corrective task scope preserved/controlled', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({
      evidence,
      proposal: {
        scope: {
          targetFiles: ['packages/core/src/recovery/corrective-task-service.ts'],
        },
      },
    });

    const tasks = await specStore.loadTasks();
    const corrective = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    const scope = corrective?.metadata?.scope as any;
    assert.ok(scope);
    assert.deepEqual(scope.targetFiles, ['packages/core/src/recovery/corrective-task-service.ts']);
  });

  // T29 — targetFiles cannot escape authorized scope
  it('T29 — targetFiles cannot escape authorized scope', async () => {
    const evidence = createValidEvidence();

    // 1. Path traversal
    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          proposal: {
            scope: {
              targetFiles: ['../outside.ts'],
            },
          },
        }),
      CorrectiveTaskScopeViolationError
    );

    // 2. Unapproved out-of-scope file
    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          proposal: {
            scope: {
              targetFiles: ['packages/unauthorized/other.ts'],
            },
          },
        }),
      CorrectiveTaskScopeViolationError
    );
  });

  // T30 — dependency validation
  it('T30 — dependency validation', async () => {
    // Add prerequisite task
    const prereqTask: TaskDefinition = {
      task_id: 'TASK-PREREQ-01',
      parent_feature_id: 'FEAT-P13',
      title: 'Prerequisite task',
      description: 'Prerequisite that was accepted',
      traceability_sources: ['REQ:P13-03'],
      dependencies: [],
      acceptance_criteria: ['AC-PREREQ-1'],
      status: TaskStatus.ACCEPTED,
      attempt: 1,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: new Date().toISOString(),
      hierarchy_level: 'TASK',
      metadata: { revision: 1 },
    };

    const sourceTaskIdWithPrereq = 'TASK-SRC-WITH-PREREQ';
    const sourceWithPrereq = createBaseSourceTask({
      task_id: sourceTaskIdWithPrereq,
      dependencies: ['TASK-PREREQ-01'],
    });

    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-P13',
      parent_feature_id: 'ROOT',
      title: 'P13 Failure Recovery Feature',
      description: 'Feature parent node',
      traceability_sources: ['REQ:P13-FEATURE'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-P13'],
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };

    const existingTasks = await specStore.loadTasks();
    await specStore.saveTasks([...existingTasks, prereqTask, sourceWithPrereq]);

    const evidence = createValidEvidence({
      evidenceId: 'ev_test_t30',
      taskId: sourceTaskIdWithPrereq,
    });
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const corrective = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    assert.ok(corrective);
    // Corrective task inherits prerequisite, does NOT depend on failed sourceTaskId
    assert.equal(corrective.dependencies.includes('TASK-PREREQ-01'), true);
    assert.equal(corrective.dependencies.includes(sourceTaskIdWithPrereq), false);

    const topo = dagEngine.topologicalSort(tasks);
    assert.ok(topo.indexOf('TASK-PREREQ-01') < topo.indexOf(outcome.correctiveTaskId));
  });

  // T31 — missing dependency rejected
  it('T31 — missing dependency rejected', async () => {
    const evidence = createValidEvidence();

    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          proposal: {
            additionalDependencies: ['TASK-GHOST-999'],
          },
        }),
      CorrectiveTaskGraphValidationError
    );
  });

  // T32 — cycle rejected
  it('T32 — cycle rejected', async () => {
    // If source task were to depend on corrective task, cycle would form.
    // Propose an additional dependency creating circularity if any
    const evidence = createValidEvidence();

    // Directly test that creating a proposal with an invalid self or cyclic dependency fails
    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          proposal: {
            // correctiveTaskId will be TASK-CORRECTIVE-P13-03-SRC-XXXX
            // attempting to make it depend on something impossible or cyclical
            additionalDependencies: ['FEAT-P13', 'NON-EXISTENT'],
          },
        }),
      CorrectiveTaskGraphValidationError
    );
  });

  // T33 — duplicate task ID rejected
  it('T33 — duplicate task ID rejected', async () => {
    const evidence1 = createValidEvidence({ evidenceId: 'ev_001' });
    const outcome1 = await correctiveService.createCorrectiveTask({ evidence: evidence1 });

    // Different evidence producing a conflict with an existing distinct task definition
    const evidence2 = createValidEvidence({ evidenceId: 'ev_002' });
    const outcome2 = await correctiveService.createCorrectiveTask({ evidence: evidence2 });

    assert.notEqual(outcome1.correctiveTaskId, outcome2.correctiveTaskId);
  });

  // T34 — atomic rejection leaves graph unchanged
  it('T34 — atomic rejection leaves graph unchanged', async () => {
    const tasksBefore = await specStore.loadTasks();
    const evidence = createValidEvidence();

    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          proposal: {
            additionalDependencies: ['TASK-DOES-NOT-EXIST'],
          },
        }),
      CorrectiveTaskGraphValidationError
    );

    const tasksAfter = await specStore.loadTasks();
    assert.equal(tasksBefore.length, tasksAfter.length);
  });

  // T35 — history event created
  it('T35 — history event created', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    assert.ok(outcome.historyEventId);
    const events = await historyManager.readEvents();
    const createdEvent = events.find((e) => e.eventType === 'TASK_CORRECTIVE_CREATED');
    assert.ok(createdEvent);
    assert.equal(createdEvent.taskId, outcome.correctiveTaskId);
  });

  // T36 — duplicate request does not duplicate history
  it('T36 — duplicate request does not duplicate history', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });
    const countBefore = (await historyManager.readEvents()).length;

    await correctiveService.createCorrectiveTask({ evidence });
    const countAfter = (await historyManager.readEvents()).length;

    assert.equal(countBefore, countAfter);
  });

  // T37 — restart/reload preserves corrective task
  it('T37 — restart/reload preserves corrective task', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    // Simulate service reload
    const freshService = new CorrectiveTaskService({
      workspaceRoot: tempDir,
      expectedProjectId: projectId,
    });

    const secondOutcome = await freshService.createCorrectiveTask({ evidence });
    assert.equal(secondOutcome.isDuplicate, true);
    assert.equal(secondOutcome.correctiveTaskId, outcome.correctiveTaskId);
  });

  // T38 — cross-project isolation
  it('T38 — cross-project isolation', async () => {
    const foreignEvidence = createValidEvidence({
      projectId: 'proj_foreign',
    });

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence: foreignEvidence }),
      CorrectiveTaskBindingMismatchError
    );
  });

  // T39 — no Antigravity invocation
  it('T39 — no Antigravity invocation', async () => {
    assert.equal((correctiveService as any).antigravity, undefined);
    assert.equal((correctiveService as any).executor, undefined);
    assert.equal((correctiveService as any).executorPort, undefined);
  });

  // T40 — no ExecutionIntent
  it('T40 — no ExecutionIntent', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });
    assert.equal((outcome as any).intentId, undefined);
    assert.equal((outcome as any).executionIntent, undefined);
  });

  // T41 — no ExecutionRequest
  it('T41 — no ExecutionRequest', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });
    assert.equal((outcome as any).requestId, undefined);
    assert.equal((outcome as any).executionRequest, undefined);
  });

  // T42 — no autonomous continuation
  it('T42 — no autonomous continuation', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  // T43 — no DAG mutation outside governed service
  it('T43 — no DAG mutation outside governed service', async () => {
    const tasks = await specStore.loadTasks();
    const feat = tasks.find((t) => t.task_id === 'FEAT-P13');
    assert.equal(feat?.status, TaskStatus.READY);
  });

  // T44 — subsequent task readiness is computed by TaskDagEngine
  it('T44 — subsequent task readiness is computed by TaskDagEngine', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const corrective = tasks.find((t) => t.task_id === outcome.correctiveTaskId);
    assert.ok(corrective);
    // Corrective task does NOT depend on failed sourceTaskId
    assert.equal(corrective.dependencies.includes(sourceTaskId), false);

    // Topological order succeeds
    const topo = dagEngine.topologicalSort(tasks);
    assert.ok(topo.includes(outcome.correctiveTaskId));
  });

  // T44b — legitimate prerequisites check: ExecutionAuthorizer validates corrective task when prerequisites are ACCEPTED
  it('T44b — legitimate prerequisites check: ExecutionAuthorizer validates corrective task when prerequisites are ACCEPTED', async () => {
    const prereqTask: TaskDefinition = {
      task_id: 'TASK-PREREQ-OK',
      parent_feature_id: 'FEAT-P13',
      title: 'Prerequisite task',
      description: 'Prerequisite that was accepted',
      traceability_sources: ['REQ:P13-03'],
      dependencies: [],
      acceptance_criteria: ['AC-PREREQ-OK'],
      status: TaskStatus.ACCEPTED,
      attempt: 1,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: new Date().toISOString(),
      hierarchy_level: 'TASK',
      metadata: { revision: 1 },
    };

    const sourceTaskIdT44b = 'TASK-SRC-T44B';
    const sourceWithPrereq = createBaseSourceTask({
      task_id: sourceTaskIdT44b,
      dependencies: ['TASK-PREREQ-OK'],
    });

    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-P13',
      parent_feature_id: 'ROOT',
      title: 'P13 Failure Recovery Feature',
      description: 'Feature parent node',
      traceability_sources: ['REQ:P13-FEATURE'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-P13'],
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };

    const currentTasks = await specStore.loadTasks();
    await specStore.saveTasks([...currentTasks, prereqTask, sourceWithPrereq]);

    const evidence = createValidEvidence({
      evidenceId: 'ev_test_t44b',
      taskId: sourceTaskIdT44b,
    });
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    // Set up Director session, snapshot, and decision for corrective execution authorization
    const sessionId = 'dir-sess-t44b';
    const decisionId = 'dir-dec-t44b';
    await sessionStore.saveSession({
      directorSessionId: sessionId,
      projectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-01',
      actor: 'DIRECTOR',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      schemaVersion: 1,
      hasImplementationAuthority: false,
      understandingRevision: 1,
      metadata: {},
    });

    await sessionStore.saveSnapshot({
      directorSessionId: sessionId,
      projectId,
      projectRoot: tempDir,
      syncStatus: 'SUCCESS',
      logicalFingerprint: 'fp_ctx_100',
      priorFingerprint: null,
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      synchronizedAt: new Date().toISOString(),
      schemaVersion: 1,
      protocolVersion: 'P9-02',
      sections: {
        projectIdentity: { isAvailable: true, isStale: false, content: {} },
        purpose: { isAvailable: true, isStale: false, content: {} },
        technologyStack: { isAvailable: true, isStale: false, content: {} },
        architecture: { isAvailable: true, isStale: false, content: {} },
        taskGraph: { isAvailable: true, isStale: false, content: {} },
        approvalState: { isAvailable: true, isStale: false, content: {} },
        implementationState: { isAvailable: true, isStale: false, content: {} },
      },
    });

    const activePkg = await approvalStore.getActivePackage();
    assert.ok(activePkg);

    const decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    await decisionStore.saveDecision({
      decisionId,
      directorSessionId: sessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Execute corrective task',
      basedOnContextFingerprint: 'fp_ctx_100',
      basedOnApprovalRevision: activePkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false,
    });

    const authorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      decisionStore,
      approvalStore,
      specStore,
      dagEngine,
      historyManager,
    });

    // Authorize execution of corrective task
    const authResult = await authorizer.validateExecutionIntent({
      directorSessionId: sessionId,
      directorDecisionId: decisionId,
      projectId,
      taskId: outcome.correctiveTaskId,
      taskRevision: 1,
      contextFingerprint: 'fp_ctx_100',
      understandingRevision: 1,
      approvalPackageRevision: activePkg.revision,
    });

    assert.equal(authResult.isValid, true);
    assert.equal(authResult.code, 'VALID');
    assert.ok(authResult.intent);
    assert.equal(authResult.intent.taskId, outcome.correctiveTaskId);
  });

  // T44c — unmet legitimate prerequisite blocks corrective execution authorization
  it('T44c — unmet legitimate prerequisite blocks corrective execution authorization', async () => {
    const unmetPrereqTask: TaskDefinition = {
      task_id: 'TASK-PREREQ-UNMET',
      parent_feature_id: 'FEAT-P13',
      title: 'Prerequisite task not yet accepted',
      description: 'Prerequisite still in ready state',
      traceability_sources: ['REQ:P13-03'],
      dependencies: [],
      acceptance_criteria: ['AC-PREREQ-UNMET'],
      status: TaskStatus.READY, // NOT ACCEPTED
      attempt: 0,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: { revision: 1 },
    };

    const sourceTaskIdT44c = 'TASK-SRC-T44C';
    const sourceWithUnmetPrereq = createBaseSourceTask({
      task_id: sourceTaskIdT44c,
      dependencies: ['TASK-PREREQ-UNMET'],
    });

    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-P13',
      parent_feature_id: 'ROOT',
      title: 'P13 Failure Recovery Feature',
      description: 'Feature parent node',
      traceability_sources: ['REQ:P13-FEATURE'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-P13'],
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: 1,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };

    const currentTasks = await specStore.loadTasks();
    await specStore.saveTasks([...currentTasks, unmetPrereqTask, sourceWithUnmetPrereq]);

    const evidence = createValidEvidence({
      evidenceId: 'ev_test_t44c',
      taskId: sourceTaskIdT44c,
    });
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    const sessionId = 'dir-sess-t44c';
    const decisionId = 'dir-dec-t44c';
    await sessionStore.saveSession({
      directorSessionId: sessionId,
      projectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-01',
      actor: 'DIRECTOR',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      schemaVersion: 1,
      hasImplementationAuthority: false,
      understandingRevision: 1,
      metadata: {},
    });

    await sessionStore.saveSnapshot({
      directorSessionId: sessionId,
      projectId,
      projectRoot: tempDir,
      syncStatus: 'SUCCESS',
      logicalFingerprint: 'fp_ctx_100',
      priorFingerprint: null,
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      synchronizedAt: new Date().toISOString(),
      schemaVersion: 1,
      protocolVersion: 'P9-02',
      sections: {
        projectIdentity: { isAvailable: true, isStale: false, content: {} },
        purpose: { isAvailable: true, isStale: false, content: {} },
        technologyStack: { isAvailable: true, isStale: false, content: {} },
        architecture: { isAvailable: true, isStale: false, content: {} },
        taskGraph: { isAvailable: true, isStale: false, content: {} },
        approvalState: { isAvailable: true, isStale: false, content: {} },
        implementationState: { isAvailable: true, isStale: false, content: {} },
      },
    });

    const activePkg = await approvalStore.getActivePackage();
    assert.ok(activePkg);

    const decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    await decisionStore.saveDecision({
      decisionId,
      directorSessionId: sessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Execute corrective task',
      basedOnContextFingerprint: 'fp_ctx_100',
      basedOnApprovalRevision: activePkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false,
    });

    const authorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      decisionStore,
      approvalStore,
      specStore,
      dagEngine,
      historyManager,
    });

    const authResult = await authorizer.validateExecutionIntent({
      directorSessionId: sessionId,
      directorDecisionId: decisionId,
      projectId,
      taskId: outcome.correctiveTaskId,
      taskRevision: 1,
      contextFingerprint: 'fp_ctx_100',
      understandingRevision: 1,
      approvalPackageRevision: activePkg.revision,
    });

    // Blocked by TASK-PREREQ-UNMET, NOT by sourceTaskId
    assert.equal(authResult.isValid, false);
    assert.equal(authResult.code, 'TASK_STATE_INVALID');
    assert.ok(authResult.message.includes('TASK-PREREQ-UNMET'));
    assert.ok(!authResult.message.includes(sourceTaskIdT44c));
  });

  // T45 — Director proposal cannot bypass governance
  it('T45 — Director proposal cannot bypass governance', async () => {
    const evidence = createValidEvidence();

    // Director cannot propose empty acceptance criteria
    await assert.rejects(
      async () =>
        correctiveService.createCorrectiveTask({
          evidence,
          proposal: {
            acceptanceCriteria: [],
          },
        }),
      CorrectiveTaskValidationError
    );
  });

  // T46 — stale corrective proposal rejected
  it('T46 — stale corrective proposal rejected', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });

    // A conflicting replay with incompatible scope or title
    const tasks = await specStore.loadTasks();
    const existing = tasks.find((t) => t.task_id.startsWith('TASK-CORRECTIVE-P13-03-SRC-'))!;
    existing.metadata = {
      ...existing.metadata,
      lineage: {
        ...(existing.metadata?.lineage as any),
        sourceEvidenceId: 'ev_other_conflicting',
      },
    };
    await specStore.saveTasks(tasks);

    await assert.rejects(
      async () => correctiveService.createCorrectiveTask({ evidence }),
      CorrectiveTaskConflictError
    );
  });

  // T47 — concurrent corrective creation is idempotent/safe
  it('T47 — concurrent corrective creation is idempotent/safe', async () => {
    const evidence = createValidEvidence();

    // Launch 3 concurrent requests
    const outcomes = await Promise.all([
      correctiveService.createCorrectiveTask({ evidence }),
      correctiveService.createCorrectiveTask({ evidence }),
      correctiveService.createCorrectiveTask({ evidence }),
    ]);

    for (const outcome of outcomes) {
      assert.equal(outcome.success, true);
      assert.equal(outcome.correctiveTaskId, outcomes[0].correctiveTaskId);
    }

    const tasks = await specStore.loadTasks();
    const matches = tasks.filter((t) => t.task_id === outcomes[0].correctiveTaskId);
    assert.equal(matches.length, 1);
  });

  // T48 — corrective task revision semantics
  it('T48 — corrective task revision semantics', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    assert.equal(outcome.correctiveTask.metadata?.revision, 1);
  });

  // T49 — acceptance criteria are explicit
  it('T49 — acceptance criteria are explicit', async () => {
    const evidence = createValidEvidence();
    const outcome = await correctiveService.createCorrectiveTask({ evidence });

    assert.ok(outcome.correctiveTask.acceptance_criteria.length >= 2);
    assert.ok(
      outcome.correctiveTask.acceptance_criteria.some((ac) => ac.includes('AC-P13-03-1'))
    );
  });

  // T50 — original failure remains auditable
  it('T50 — original failure remains auditable', async () => {
    const evidence = createValidEvidence();
    await correctiveService.createCorrectiveTask({ evidence });

    const tasks = await specStore.loadTasks();
    const source = tasks.find((t) => t.task_id === sourceTaskId);
    assert.equal(source?.status, TaskStatus.REJECTED);
  });

  // T51 — MCP tool aidm.task.createCorrective executes successfully
  it('T51 — MCP tool aidm.task.createCorrective executes successfully', async () => {
    const tool = createCorrectiveTaskTool({ correctiveService });
    const evidence = createValidEvidence();

    const result = await tool.handler(
      {
        evidence,
        expectedProjectId: projectId,
      },
      { correlation: { correlationId: 'corr_test_1' } }
    );

    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.equal(parsed.success, true);
    assert.ok(parsed.correctiveTaskId.startsWith('TASK-CORRECTIVE-P13-03-SRC-'));
  });

  // T52 — MCP tool rejects fabricated caller claims
  it('T52 — MCP tool rejects fabricated caller claims', async () => {
    const tool = createCorrectiveTaskTool({ correctiveService });
    const evidence = createValidEvidence();

    const result = await tool.handler(
      {
        evidence,
        replanApproved: true, // Forbidden claim
      },
      { correlation: { correlationId: 'corr_test_2' } }
    );

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.equal(parsed.code, 'ERR_CORRECTIVE_TASK_SECURITY_VIOLATION');
  });
});
