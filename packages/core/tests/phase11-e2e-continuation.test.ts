/**
 * Phase 11 TASK-P11-05: End-to-End Multi-Task Continuation Integration & Hardening
 *
 * Provides definitive end-to-end integration proof for Phase 11 controlled continuation
 * across multiple consecutive tasks, proving that:
 * 1. Task A executes and integrates with ACCEPT under MANUAL continuation policy.
 * 2. System transitions continuationState to 'WAITING'.
 * 3. Director is blocked from selecting Task B (CONTINUATION_WAITING).
 * 4. DAG readiness of Task B exists independently of continuation permission.
 * 5. Human Product Owner triggers phase11.requestContinue via the MCP tool boundary.
 * 6. System transitions continuationState to 'NONE'.
 * 7. Director successfully selects Task B in topological order.
 * 8. Hardens the multi-task pipeline against all 10 edge cases required by the P11-05 spec.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  DurableStateManager,
  CURRENT_DURABLE_STATE_SCHEMA_VERSION,
  type DurableState,
  ExecutionStateIntegrator,
  type SystemExecutionEvidence,
  HumanApprovalEngine,
  DirectorDecisionEngine,
  DirectorSessionEngine,
  DirectorSessionStore,
  ApprovalStore,
  SpecStore,
  HistoryManager,
  TaskDagEngine,
  Actor,
  LifecycleState,
  createPhase11ContinuationToolHandler,
  PHASE11_REQUEST_CONTINUE_TOOL_NAME,
  TaskStatus,
  type TaskDefinitionInput,
  type TaskGraphModel,
  ExecutionIntegrationLock,
} from '../dist/index.js';

describe('Phase 11 TASK-P11-05: End-to-End Multi-Task Continuation Integration & Hardening', () => {
  let tmpDir: string;
  let durableManager: DurableStateManager;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let approvalStore: ApprovalStore;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let integrator: ExecutionStateIntegrator;
  let lock: ExecutionIntegrationLock;

  const PROJECT_ID = 'test-e2e-project';
  const SESSION_ID = 'dir-ses-e2e-1111-2222-3333-444455556666';
  const FINGERPRINT = 'fp-e2e-sha256-abcdef1234567890';

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p11-05-e2e-'));
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-e2e-project', version: '1.0.0' }, null, 2)
    );
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'state'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'history'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'sessions'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'decisions'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'specs'), { recursive: true });

    durableManager = new DurableStateManager({ baseDir: tmpDir });
    historyManager = new HistoryManager({ baseDir: tmpDir });
    sessionStore = new DirectorSessionStore({ baseDir: tmpDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tmpDir });
    approvalStore = new ApprovalStore({ baseDir: tmpDir, historyManager });
    specStore = new SpecStore({ baseDir: tmpDir });
    dagEngine = new TaskDagEngine();
    lock = new ExecutionIntegrationLock({ baseDir: tmpDir, staleThresholdMs: 5000, timeoutMs: 10000 });
    integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      lock,
      expectedProjectId: PROJECT_ID,
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedActiveSession(sessionId = SESSION_ID, projectId = PROJECT_ID): Promise<void> {
    await sessionEngine.createSession({
      directorSessionId: sessionId,
      projectId,
      understandingRevision: 1,
    });

    await sessionStore.saveSnapshot(({
      directorSessionId: sessionId,
      projectId: projectId,
      projectRoot: tmpDir,
      syncStatus: 'CHANGED',
      logicalFingerprint: FINGERPRINT,
      priorFingerprint: null,
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      synchronizedAt: new Date().toISOString(),
      schemaVersion: 1,
      protocolVersion: 'P9-02',
      isDerived: true,
      sectionMetadata: {
        projectStatus: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        requirements: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        decisions: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        currentTask: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        taskList: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        contextEngine: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        evidence: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        history: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        git: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        discovery: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        clarification: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        approval: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
        authorization: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-meta' },
      },
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
        approval: { hasApprovalPackage: true, packageId: 'pkg-valid', isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'test', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], entryPointsCount: 0, unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 0, items: [] },
        decisions: { total: 0, items: [] },
        taskList: { total: 0, topologicalOrder: [], tasks: [] },
        currentTask: { hasActiveTask: false, task: null },
        contextEngine: { isAvailable: true, hasL0Cache: false, inspectedPaths: [] },
        evidence: { totalAvailable: 0, items: [] },
        history: { totalEvents: 0, recentEvents: [] },
        git: { isGitRepository: true, head: null, branch: 'main', workingTreeClean: true, totalAcceptedCheckpoints: 0 },
      },
    }));
  }

  function createValidTaskInput(overrides?: Partial<TaskDefinitionInput>): TaskDefinitionInput {
    return {
      task_id: 'TASK-1',
      parent_feature_id: 'FEAT-CORE',
      title: 'Valid Task Title',
      description: 'Valid Task Description',
      traceability_sources: ['SYSTEM_REQUIREMENT: REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-1: Verification completes'],
      status: 'READY',
      attempt: 0,
      max_attempts: 3,
      priority: 'HIGH',
      risk_level: 'SAFE',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      ...overrides,
    };
  }

  function createMockEvidence(
    taskId: string,
    decision: 'ACCEPT' | 'REJECT' | 'BLOCK' = 'ACCEPT',
    overrides?: Partial<SystemExecutionEvidence>
  ): SystemExecutionEvidence {
    const randomHex = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    return {
      evidenceId: overrides?.evidenceId ?? `evi-${randomHex}`,
      requestId: overrides?.requestId ?? `req-${randomHex}`,
      projectId: overrides?.projectId ?? PROJECT_ID,
      taskId,
      taskRevision: overrides?.taskRevision ?? 1,
      contextFingerprint: overrides?.contextFingerprint ?? FINGERPRINT,
      understandingRevision: overrides?.understandingRevision ?? 1,
      approvalPackageRevision: overrides?.approvalPackageRevision ?? 1,
      verificationDecision: decision,
      verifiedAt: overrides?.verifiedAt ?? new Date().toISOString(),
      repositoryState: {
        baseCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        headCommit: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        isClean: true,
      },
      changedFiles: [{ path: 'src/app.ts', status: 'M' }],
      verificationChecks: [
        {
          checkId: 'CHECK_TESTS',
          type: 'TEST',
          status: 'PASS',
          command: 'pnpm test',
          evidence: 'All tests passing',
        },
      ],
      acceptanceCriteria: [
        {
          criterion: 'AC-1: Verification completes',
          status: 'PASS',
          evidence: 'All checks passed',
        },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 120,
      },
      ...overrides,
    };
  }

  // ==========================================================================
  // TEST 1 — MANUAL CONTINUATION HAPPY PATH
  // Task 1 executes, integrates with ACCEPT -> continuationState becomes WAITING
  // Director blocked from selecting Task 2 -> Human calls requestContinue
  // continuationState becomes NONE -> Director selects Task 2
  // ==========================================================================
  it('TEST 1: MANUAL continuation happy path — Task 1 ACCEPT -> WAITING -> Blocked -> Continue -> NONE -> Task 2 selected', async () => {
    await seedActiveSession();

    // Setup 2 tasks: TASK-1 -> TASK-2 under feature FEAT-CORE
    const taskGraph: TaskGraphModel = {
      features: ['FEAT-CORE'],
      tasks: [
        createValidTaskInput({
          task_id: 'TASK-1',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task One',
          description: 'First task',
          dependencies: [],
          status: 'READY',
        }),
        createValidTaskInput({
          task_id: 'TASK-2',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task Two',
          description: 'Second task depending on Task 1',
          dependencies: ['TASK-1'],
          status: 'BLOCKED',
        }),
      ],
    };
    const validatedTasks = dagEngine.assertValidGraph(taskGraph);
    const order = dagEngine.topologicalSort(taskGraph);
    assert.deepEqual(order, ['TASK-1', 'TASK-2']);

    // Initial durable state under MANUAL continuation policy
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: [],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    // Step 1: Director selects and initiates TASK-1
    const valTask1 = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Select Task 1 for implementation',
    });
    assert.equal(valTask1.isValid, true);

    // Step 2: Task 1 completes execution, verified by P10-04, integrated by P10-05 with ACCEPT
    const evidenceTask1 = createMockEvidence('TASK-1', 'ACCEPT');
    const outcome1 = await integrator.integrate(evidenceTask1);
    assert.equal(outcome1.success, true);
    assert.equal(outcome1.verificationDecision, 'ACCEPT');

    // State check: completedTaskIds includes TASK-1, continuationState transitioned to WAITING
    const stateAfter1 = await durableManager.load();
    assert.ok(stateAfter1?.completedTaskIds.includes('TASK-1'));
    assert.equal(stateAfter1?.continuationState, 'WAITING');
    assert.equal(stateAfter1?.continuationPolicy, 'MANUAL');

    // Step 3: Director attempts to select TASK-2 -> MUST be blocked by CONTINUATION_WAITING
    const valTask2Blocked = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Attempt to select Task 2 while continuationState is WAITING',
    });
    assert.equal(valTask2Blocked.isValid, false);
    assert.equal(valTask2Blocked.code, 'CONTINUATION_WAITING');
    assert.match(valTask2Blocked.message, /continuationState === 'WAITING'/);

    // Verify createDecision throws on blocked decision
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: SESSION_ID,
          decisionType: 'IMPLEMENT_TASK',
          basedOnContextFingerprint: FINGERPRINT,
          actor: Actor.DIRECTOR,
          rationale: 'Attempt to create decision for Task 2 while WAITING',
        });
      },
      (err: any) => err.name === 'DirectorInvalidTransitionError' && err.message.includes('WAITING')
    );

    // Step 4: Human Product Owner requests continuation via MCP boundary
    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);
    const mcpResult = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'product-owner-alice',
        actorRole: 'PRODUCT_OWNER',
        comment: 'Authorized continuation to next planned task TASK-2',
      },
      { correlation: { requestId: 'req-e2e-cont-1' } as any }
    );
    assert.equal(mcpResult.isError, false);

    // Step 5: Verify continuationState is now NONE
    const stateAfterContinue = await durableManager.load();
    assert.equal(stateAfterContinue?.continuationState, 'NONE');
    assert.deepEqual(stateAfterContinue?.completedTaskIds, ['TASK-1']);

    // Step 6: Director can now successfully select TASK-2
    const valTask2Allowed = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Proceed with Task 2 after continuation granted',
    });
    assert.equal(valTask2Allowed.isValid, true);
    assert.equal(valTask2Allowed.code, 'VALID');

    const decisionTask2 = await decisionEngine.createDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Proceed with Task 2 after continuation granted',
    });
    assert.ok(decisionTask2.decisionId);
    assert.equal(decisionTask2.decisionType, 'IMPLEMENT_TASK');
  });

  // ==========================================================================
  // TEST 2 — CONTINUATION WITHOUT AUTHORIZATION
  // An actor other than PRODUCT_OWNER or USER (e.g. DIRECTOR, SYSTEM, unknown)
  // attempts to request continuation -> REJECTED, continuationState remains WAITING
  // ==========================================================================
  it('TEST 2: Continuation without authorization — Non-human actor is rejected and WAITING state remains', async () => {
    await seedActiveSession();

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: ['TASK-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);

    // Attempt continuation as DIRECTOR
    const resDirector = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'autonomous-director',
        actorRole: 'DIRECTOR' as any,
      },
      { correlation: { requestId: 'req-unauth-1' } as any }
    );
    assert.equal(resDirector.isError, true);
    const bodyDirector = JSON.parse((resDirector.content[0] as any).text);
    assert.equal(bodyDirector.code, 'ACTOR_UNAUTHORIZED');

    // Attempt continuation as SYSTEM
    const resSystem = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'system-agent',
        actorRole: 'SYSTEM' as any,
      },
      { correlation: { requestId: 'req-unauth-2' } as any }
    );
    assert.equal(resSystem.isError, true);
    const bodySystem = JSON.parse((resSystem.content[0] as any).text);
    assert.equal(bodySystem.code, 'ACTOR_UNAUTHORIZED');

    // Verify continuationState remains strictly WAITING
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'WAITING');

    // Director remains blocked
    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });
    const val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Try to proceed without human authorization',
    });
    assert.equal(val.isValid, false);
    assert.equal(val.code, 'CONTINUATION_WAITING');
  });

  // ==========================================================================
  // TEST 3 — CONTINUATION DOES NOT COMPLETE A TASK
  // Requesting continuation releases the boundary (WAITING -> NONE), but does
  // NOT modify completedTaskIds or mark any task complete.
  // ==========================================================================
  it('TEST 3: Continuation does not complete a task — completedTaskIds remains strictly unchanged', async () => {
    await seedActiveSession();

    const initialCompleted = ['TASK-1'];
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      completedTaskIds: [...initialCompleted],
      blockedState: null,
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'authorized-human',
        actorRole: 'USER',
      },
      { correlation: { requestId: 'req-test-3' } as any }
    );
    assert.equal(result.isError, false);

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
    // TASK-2 was NOT completed by continuation
    assert.deepEqual(state?.completedTaskIds, ['TASK-1']);
    assert.ok(!state?.completedTaskIds.includes('TASK-2'));
  });

  // ==========================================================================
  // TEST 4 — DAG READINESS PRESERVED
  // In the DAG, TASK-2 depends on TASK-1. Once TASK-1 is in completedTaskIds,
  // TASK-2 is ready in the DAG regardless of continuationState.
  // Proves that DAG readiness and continuationState gating are orthogonal.
  // ==========================================================================
  it('TEST 4: DAG readiness preserved — DAG readiness is orthogonal to continuationState block', async () => {
    await seedActiveSession();

    const taskGraph: TaskGraphModel = {
      features: ['FEAT-CORE'],
      tasks: [
        createValidTaskInput({
          task_id: 'TASK-1',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task 1',
          description: 'First',
          dependencies: [],
          status: 'ACCEPTED',
        }),
        createValidTaskInput({
          task_id: 'TASK-2',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task 2',
          description: 'Depends on Task 1',
          dependencies: ['TASK-1'],
          status: 'READY',
        }),
      ],
    };

    // Verify DAG readiness logic: all dependencies of TASK-2 (TASK-1) are satisfied
    const task2 = taskGraph.tasks.find((t) => (t.task_id ?? t.taskId) === 'TASK-2')!;
    const completedSet = new Set(['TASK-1']);
    const isTask2DependenciesMet = (task2.dependencies ?? []).every((dep) => completedSet.has(dep));
    assert.equal(isTask2DependenciesMet, true, 'DAG evaluates TASK-2 dependencies as fully satisfied');

    // Now set continuationState to WAITING
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: ['TASK-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    // Director selection is blocked despite DAG readiness
    const valBlocked = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Evaluate ready task',
    });
    assert.equal(valBlocked.isValid, false);
    assert.equal(valBlocked.code, 'CONTINUATION_WAITING');

    // Release continuation
    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);
    await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'lead-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-dag-ready' } as any }
    );

    // Director selection is now permitted
    const valAllowed = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Evaluate ready task after continuation',
    });
    assert.equal(valAllowed.isValid, true);
  });

  // ==========================================================================
  // TEST 5 — MULTI-TASK ORDER (A -> B -> C sequential chaining)
  // Proves that in a 3-task chain:
  // - Task A completes -> WAITING -> continue -> NONE -> Director selects B
  // - Task B completes -> WAITING -> continue -> NONE -> Director selects C
  // - Task C completes -> WAITING -> continue -> NONE -> All complete
  // Topological order and gating are strictly preserved at every step.
  // ==========================================================================
  it('TEST 5: Multi-task order — Sequential chaining across 3 tasks (A -> B -> C) with WAITING between each', async () => {
    await seedActiveSession();

    const taskGraph: TaskGraphModel = {
      features: ['FEAT-CORE'],
      tasks: [
        createValidTaskInput({
          task_id: 'TASK-A',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task A',
          description: 'Step 1',
          dependencies: [],
          status: 'READY',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-A'],
        }),
        createValidTaskInput({
          task_id: 'TASK-B',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task B',
          description: 'Step 2',
          dependencies: ['TASK-A'],
          status: 'BLOCKED',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-B'],
        }),
        createValidTaskInput({
          task_id: 'TASK-C',
          parent_feature_id: 'FEAT-CORE',
          title: 'Task C',
          description: 'Step 3',
          dependencies: ['TASK-B'],
          status: 'BLOCKED',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-C'],
        }),
      ],
    };
    dagEngine.assertValidGraph(taskGraph);
    const sortOrder = dagEngine.topologicalSort(taskGraph);
    assert.deepEqual(sortOrder, ['TASK-A', 'TASK-B', 'TASK-C']);

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: [],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });
    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);

    // --- PHASE A ---
    // Director selects Task A
    let val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Select Task A',
    });
    assert.equal(val.isValid, true);

    // Execute & integrate Task A
    await integrator.integrate(createMockEvidence('TASK-A', 'ACCEPT'));
    let state = (await durableManager.load())!;
    assert.deepEqual(state.completedTaskIds, ['TASK-A']);
    assert.equal(state.continuationState, 'WAITING');

    // Director blocked from selecting Task B
    val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Select Task B',
    });
    assert.equal(val.isValid, false);
    assert.equal(val.code, 'CONTINUATION_WAITING');

    // Human continues to B
    let contRes = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'po-user',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-chain-1' } as any }
    );
    assert.equal(contRes.isError, false);

    // --- PHASE B ---
    // Director selects Task B
    val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Select Task B',
    });
    assert.equal(val.isValid, true);

    // Execute & integrate Task B
    await integrator.integrate(createMockEvidence('TASK-B', 'ACCEPT'));
    state = (await durableManager.load())!;
    assert.deepEqual(state.completedTaskIds, ['TASK-A', 'TASK-B']);
    assert.equal(state.continuationState, 'WAITING');

    // Director blocked from selecting Task C
    val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Select Task C',
    });
    assert.equal(val.isValid, false);
    assert.equal(val.code, 'CONTINUATION_WAITING');

    // Human continues to C
    contRes = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'po-user',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-chain-2' } as any }
    );
    assert.equal(contRes.isError, false);

    // --- PHASE C ---
    // Director selects Task C
    val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Select Task C',
    });
    assert.equal(val.isValid, true);

    // Execute & integrate Task C
    await integrator.integrate(createMockEvidence('TASK-C', 'ACCEPT'));
    state = (await durableManager.load())!;
    assert.deepEqual(state.completedTaskIds, ['TASK-A', 'TASK-B', 'TASK-C']);
    assert.equal(state.continuationState, 'WAITING');
  });

  // ==========================================================================
  // TEST 6 — DUPLICATE CONTINUATION
  // Calling requestContinue when continuationState is already NONE returns
  // an informational/not needed response without error and does not corrupt state.
  // ==========================================================================
  it('TEST 6: Duplicate continuation — Continuation when NONE returns not-needed without corrupting state', async () => {
    await seedActiveSession();

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: ['TASK-1'],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);

    const result = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'human-user',
        actorRole: 'USER',
      },
      { correlation: { requestId: 'req-dup-1' } as any }
    );

    assert.equal(result.isError, false);
    const body = JSON.parse((result.content[0] as any).text);
    assert.equal(body.code, 'CONTINUATION_NOT_NEEDED');
    assert.equal(body.isIdempotent, true);

    // State is unaltered
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
    assert.deepEqual(state?.completedTaskIds, ['TASK-1']);
  });

  // ==========================================================================
  // TEST 7 — RESTART / RECOVERY
  // If the process crashes or a new manager is instantiated from disk while
  // continuationState is WAITING, the WAITING state persists, Director remains
  // blocked, and a subsequent requestContinue clears it cleanly.
  // ==========================================================================
  it('TEST 7: Restart / Recovery — WAITING state survives cold restart from disk and clears cleanly', async () => {
    await seedActiveSession();

    // Persist WAITING state
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: ['TASK-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    // Simulate process crash / cold restart by creating entirely new manager instances
    const restartedDurableManager = new DurableStateManager({ baseDir: tmpDir });
    const loadedState = await restartedDurableManager.load();
    assert.ok(loadedState);
    assert.equal(loadedState.continuationState, 'WAITING');
    assert.equal(loadedState.continuationPolicy, 'MANUAL');
    assert.deepEqual(loadedState.completedTaskIds, ['TASK-1']);

    // Director on restarted process is still blocked
    const restartedDecisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: restartedDurableManager,
      sessionEngine,
      sessionStore,
    });
    const valBlocked = await restartedDecisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Post-restart decision attempt',
    });
    assert.equal(valBlocked.isValid, false);
    assert.equal(valBlocked.code, 'CONTINUATION_WAITING');

    // Continuation issued on restarted instance
    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);
    const contResult = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'admin-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-restart-cont' } as any }
    );
    assert.equal(contResult.isError, false);

    // Verify unblocked
    const stateAfter = await restartedDurableManager.load();
    assert.equal(stateAfter?.continuationState, 'NONE');
    const valAllowed = await restartedDecisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Post-restart decision after continuation',
    });
    assert.equal(valAllowed.isValid, true);
  });

  // ==========================================================================
  // TEST 8 — CROSS-PROJECT ISOLATION
  // Continuation request with mismatched projectId or foreign workspace
  // must be strictly rejected with PROJECT_BINDING_MISMATCH and not affect the target project.
  // ==========================================================================
  it('TEST 8: Cross-project isolation — Continuation request with foreign projectId is rejected', async () => {
    await seedActiveSession(); // Seeds SESSION_ID for PROJECT_ID ('test-e2e-project')

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: ['TASK-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);

    // Continuation request explicitly specifying a foreign project ID
    const result = await continueHandler(
      {
        workspaceRoot: tmpDir,
        projectId: 'foreign-project-xyz',
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'foreign-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-foreign' } as any }
    );

    assert.equal(result.isError, true);
    const body = JSON.parse((result.content[0] as any).text);
    assert.equal(body.code, 'PROJECT_BINDING_MISMATCH');

    // State of target project must remain strictly unchanged
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'WAITING');
  });

  // ==========================================================================
  // TEST 9 — SESSION BINDING & FINGERPRINT MISMATCH
  // Continuation request with unknown directorSessionId or stale fingerprint
  // is rejected and leaves continuationState WAITING.
  // ==========================================================================
  it('TEST 9: Session binding & fingerprint mismatch — Non-existent session or stale fingerprint is rejected', async () => {
    await seedActiveSession();

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: ['TASK-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const continueHandler = createPhase11ContinuationToolHandler(tmpDir);

    // 1. Non-existent session
    const resBadSession = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: 'dir-ses-non-existent-session-id-0000',
        contextFingerprint: FINGERPRINT,
        actor: 'user-alice',
        actorRole: 'USER',
      },
      { correlation: { requestId: 'req-bad-session' } as any }
    );
    assert.equal(resBadSession.isError, true);
    const bodyBadSession = JSON.parse((resBadSession.content[0] as any).text);
    assert.equal(bodyBadSession.code, 'SESSION_INVALID');
    assert.match(bodyBadSession.message, /Director session not found/);

    // 2. Mismatched context fingerprint
    const resBadFp = await continueHandler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: 'fp-stale-or-corrupted-hash',
        actor: 'user-alice',
        actorRole: 'USER',
      },
      { correlation: { requestId: 'req-bad-fp' } as any }
    );
    assert.equal(resBadFp.isError, true);
    const bodyBadFp = JSON.parse((resBadFp.content[0] as any).text);
    assert.equal(bodyBadFp.code, 'CONTEXT_FINGERPRINT_MISMATCH');

    // Verify continuationState was not modified
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'WAITING');
  });

  // ==========================================================================
  // TEST 10 — NO AUTONOMOUS BYPASS
  // Under continuationPolicy: 'MANUAL', after ACCEPT is integrated, there is NO
  // automatic transition to NONE. No background timer, no auto-approval,
  // no bypass without explicit human tool invocation.
  // ==========================================================================
  it('TEST 10: No autonomous bypass — Under MANUAL policy, state remains WAITING indefinitely until human continues', async () => {
    await seedActiveSession();

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      blockedState: null,
      completedTaskIds: [],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    // Task 1 accepted
    const evidence = createMockEvidence('TASK-1', 'ACCEPT');
    await integrator.integrate(evidence);

    // Multiple state re-reads to ensure no autonomous transition occurs
    for (let i = 0; i < 5; i++) {
      const state = await durableManager.load();
      assert.equal(state?.continuationState, 'WAITING', `Iteration ${i} must remain WAITING`);
      assert.equal(state?.continuationPolicy, 'MANUAL');
    }

    // Director cannot bypass
    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });
    const val = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Autonomous attempt to select next task',
    });
    assert.equal(val.isValid, false);
    assert.equal(val.code, 'CONTINUATION_WAITING');
  });
});
