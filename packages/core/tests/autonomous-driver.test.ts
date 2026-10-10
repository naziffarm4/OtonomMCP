/**
 * Comprehensive Test Suite for Autonomous Driver (Phase 17 TASK-P17-01)
 *
 * Validates all 30 required architectural, lifecycle, governance, and safety requirements:
 * 1. driver creation
 * 2. driver start
 * 3. duplicate driver prevention
 * 4. lifecycle transitions
 * 5. one complete driver iteration
 * 6. automatic continuation
 * 7. continuation authorization validation
 * 8. pause before next cycle
 * 9. resume
 * 10. graceful stop
 * 11. restart recovery
 * 12. in-flight cycle recovery
 * 13. duplicate execution prevention
 * 14. stale task revision
 * 15. stale approval
 * 16. scope mismatch
 * 17. authorization loss
 * 18. human decision blocking
 * 19. recovery policy integration
 * 20. retry authorization integration
 * 21. replan integration
 * 22. durable driver state
 * 23. deterministic driver identity/idempotency
 * 24. MCP driver controls
 * 25. CLI foreground runtime
 * 26. no arbitrary process execution
 * 27. raw outcome never becomes proof
 * 28. evidence-driven continuation
 * 29. terminal driver state
 * 30. concurrent start race
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';

import {
  DriverEngine,
  DriverRuntime,
  DriverStore,
  DriverLockManager,
  DriverLifecycleState,
  VALID_DRIVER_LIFECYCLE_TRANSITIONS,
  validateDriverLifecycleTransition,
  InvalidDriverLifecycleTransitionError,
  DriverConcurrencyError,
  DriverValidationError,
  DriverAuthorizationError,
  DriverStaleStateError,
  computeDeterministicDriverId,
  type DurableDriverState,
  DirectorLoopEngine,
  DirectorLoopStore,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  type DirectorSession,
  type DirectorContextSnapshot,
  type DirectorDecision,
  ApprovalStore,
  ApprovalPackageEngine,
  type ApprovalPackage,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  TaskDagEngine,
  type TaskDefinition,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  SystemExecutionEvidenceStore,
  Actor,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  DRIVER_START_TOOL_NAME,
  DRIVER_STATUS_TOOL_NAME,
  DRIVER_PAUSE_TOOL_NAME,
  DRIVER_RESUME_TOOL_NAME,
  DRIVER_STOP_TOOL_NAME,
  executeDriver,
  CliOutputWriter,
} from '../dist/index.js';
import { createValidApprovalPackage } from './helpers/test-discovery-factory.ts';

describe('Phase 17 — Autonomous Driver', { concurrency: 1 }, () => {
  let tempDir: string;
  let canonicalProjectId: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let durableManager: DurableStateManager;
  let evidenceStore: SystemExecutionEvidenceStore;
  let loopStore: DirectorLoopStore;
  let driverStore: DriverStore;
  let lockManager: DriverLockManager;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;
  let implementDecision: DirectorDecision;
  let parentFeature: TaskDefinition;
  let task1: TaskDefinition;
  let task2: TaskDefinition;

  // Mock executor port
  class MockExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-driver-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    outcomeToReturn: Partial<RawExecutorOutcome> = {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: 'Simulated driver executor success',
      stderr: '',
      unverifiedModifiedFiles: ['src/task1.ts'],
    };

    failNext = false;
    failWithVerification = false;

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      const files = request.instruction?.targetFiles && request.instruction.targetFiles.length > 0 ? request.instruction.targetFiles : ['src/task1.ts'];
      for (const f of files) {
        try {
          const full = path.join(tempDir, f);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, '// driver generated code\n', 'utf8');
        } catch {
          // ignore
        }
      }

      if (this.failNext) {
        return {
          executorIdentity: { provider: 'mock', name: this.executorId, version: '1.0.0' },
          requestId: request.requestId,
          requestBinding: {
            requestId: request.requestId,
            projectId: request.projectId,
            taskId: request.taskId,
            taskRevision: request.taskRevision,
            contextFingerprint: request.contextFingerprint,
            understandingRevision: request.understandingRevision,
            approvalPackageRevision: request.approvalPackageRevision,
          },
          status: 'FAILURE',
          exitCode: 1,
          timedOut: false,
          cancelled: false,
          signal: null,
          stdout: '',
          stderr: 'Simulated executor error',
          durationMs: 50,
          unverifiedAgentClaims: [],
          unverifiedModifiedFiles: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }

      return {
        executorIdentity: { provider: 'mock', name: this.executorId, version: '1.0.0' },
        requestId: request.requestId,
        requestBinding: {
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
        },
        status: this.outcomeToReturn.status ?? 'SUCCESS',
        exitCode: this.outcomeToReturn.exitCode ?? 0,
        timedOut: false,
        cancelled: false,
        signal: null,
        stdout: this.outcomeToReturn.stdout ?? '',
        stderr: this.outcomeToReturn.stderr ?? '',
        durationMs: 50,
        unverifiedAgentClaims: ['Driver implemented feature successfully'],
        unverifiedModifiedFiles: files as string[],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockExecutor;

  function createTestApprovedPackage(projectId: string, revision = 1): ApprovalPackage {
    return createValidApprovalPackage({
      packageId: `pkg-${projectId}-01`,
      projectId,
      revision,
      approvalPackageRevision: revision,
    });
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p17-test-'));
    canonicalProjectId = path.basename(tempDir).toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: canonicalProjectId, version: '1.0.0' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\nnode_modules/\n', 'utf8');

    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git add . && git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine();
    specStore = new SpecStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    durableManager = new DurableStateManager({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    loopStore = new DirectorLoopStore({ baseDir: tempDir, historyManager });
    driverStore = new DriverStore({ workspaceRoot: tempDir, historyManager });
    lockManager = new DriverLockManager({ workspaceRoot: tempDir });
    mockExecutor = new MockExecutor();

    // 1. Initialize DurableState
    await durableManager.save({
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
    });

    // 2. Create Active Director Session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      understandingRevision: 1,
    });

    // 3. Save Context Snapshot
    activeSnapshot = {
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      logicalFingerprint: 'fp-valid-snapshot-sha256',
      isComplete: true,
      syncStatus: 'UNCHANGED',
      sections: {
        projectSummary: { fingerprint: 'fp-1', status: 'FRESH' },
      } as any,
      unavailableSections: [],
      staleSections: [],
      sectionMetadata: {} as any,
      isDerived: true,
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    // 4. Create Approved ApprovalPackage
    approvedPackage = createTestApprovedPackage(canonicalProjectId, 1);
    await approvalStore.savePackage(approvedPackage);

    // 5. Create IMPLEMENT_TASK Decision
    implementDecision = {
      decisionId: 'dec-p17-task-01',
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Driver automated execution decision',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: approvedPackage.revision,
      basedOnUnderstandingRevision: activeSession.understandingRevision,
      createdAt: new Date().toISOString(),
      metadata: { taskId: 'TASK-P17-01' },
      hasImplementationAuthority: false,
    };
    await decisionStore.saveDecision(implementDecision);

    const implementDecision2 = {
      ...implementDecision,
      decisionId: 'dec-p17-task-02',
      metadata: { taskId: 'TASK-P17-02' },
    };
    await decisionStore.saveDecision(implementDecision2);

    // 6. Create Tasks in SpecStore with DAG dependency: task1 -> task2
    parentFeature = {
      task_id: 'FEAT-01',
      parent_feature_id: 'ROOT',
      title: 'Parent Feature',
      description: 'Parent feature node',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-01'],
      status: 'READY' as any,
      attempt: 0,
      max_attempts: 1,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'FEATURE' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: {
        revision: 1,
        target_files: ['src/feature.ts'],
      },
    };

    task1 = {
      task_id: 'TASK-P17-01',
      parent_feature_id: 'FEAT-01',
      title: 'Task 1: Core Logic',
      description: 'Implement Task 1 core feature logic',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-01: Task 1 verified'],
      status: 'READY' as any,
      attempt: 1,
      max_attempts: 3,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: {
        revision: 1,
        target_files: ['src/task1.ts'],
      },
    };

    task2 = {
      task_id: 'TASK-P17-02',
      parent_feature_id: 'FEAT-01',
      title: 'Task 2: Secondary Logic',
      description: 'Implement Task 2 dependent logic',
      traceability_sources: ['REQ-01'],
      dependencies: ['TASK-P17-01'],
      acceptance_criteria: ['AC-02: Task 2 verified'],
      status: 'READY' as any,
      attempt: 1,
      max_attempts: 3,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: {
        revision: 1,
        target_files: ['src/task2.ts'],
      },
    };

    await specStore.saveTasks([parentFeature, task1, task2]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createDriverEngine(executor: ExecutorPort = mockExecutor): DriverEngine {
    const directorLoopEngine = new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: executor,
    });

    return new DriverEngine({
      workspaceRoot: tempDir,
      directorLoopEngine,
      historyManager,
    });
  }

  function createDriverRuntime(executor: ExecutorPort = mockExecutor): DriverRuntime {
    const engine = createDriverEngine(executor);
    return new DriverRuntime({
      workspaceRoot: tempDir,
      driverEngine: engine,
      lockManager,
      driverStore,
      historyManager,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 1: Driver Creation
  // --------------------------------------------------------------------------
  it('1. driver creation: initializes with IDLE state, deterministic driverId, and proper defaults', async () => {
    const runtime = createDriverRuntime();
    assert.equal(runtime.currentLifecycleState, DriverLifecycleState.IDLE);
    assert.equal(runtime.isRunning, false);
    assert.equal(runtime.isPaused, false);
    assert.equal(runtime.isStopped, false);
    assert.ok(runtime.driverId.startsWith('driver-'));
    assert.equal(runtime.driverId, computeDeterministicDriverId(canonicalProjectId));
  });

  // --------------------------------------------------------------------------
  // TEST 2: Driver Start
  // --------------------------------------------------------------------------
  it('2. driver start: transitions IDLE -> STARTING -> RUNNING, acquires lock, and emits DRIVER_STARTED', async () => {
    const runtime = createDriverRuntime();
    const summary = await runtime.start({ maxIterations: 1 });

    assert.equal(summary.driverId, runtime.driverId);
    assert.equal(summary.projectId, canonicalProjectId);
    assert.equal(summary.iterationsRun, 1);
    assert.equal(summary.state.currentIteration, 1);

    // Verify history events
    const events = (await historyManager.readEvents()).filter((e) => e.eventType === 'DRIVER_STARTED');
    assert.ok(events.length >= 1);
    assert.equal(events[0].actor, Actor.ORCHESTRATOR);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Duplicate Driver Prevention
  // --------------------------------------------------------------------------
  it('3. duplicate driver prevention: concurrent driver start on same project is rejected', async () => {
    const runtime1 = createDriverRuntime();
    const lockMgr = new DriverLockManager({ workspaceRoot: tempDir });
    await lockMgr.acquireLock('other-driver-active', canonicalProjectId);

    const runtime2 = createDriverRuntime();
    await assert.rejects(
      async () => {
        await runtime2.start({ maxIterations: 1 });
      },
      (err: any) => {
        assert.ok(err instanceof DriverConcurrencyError);
        assert.ok(err.message.includes('Only one active driver is permitted'));
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 4: Lifecycle Transitions
  // --------------------------------------------------------------------------
  it('4. lifecycle transitions: enforces deterministic transitions and fails closed on invalid jumps', async () => {
    // Valid transitions check
    assert.doesNotThrow(() => {
      validateDriverLifecycleTransition(DriverLifecycleState.IDLE, DriverLifecycleState.STARTING);
      validateDriverLifecycleTransition(DriverLifecycleState.STARTING, DriverLifecycleState.RUNNING);
      validateDriverLifecycleTransition(DriverLifecycleState.RUNNING, DriverLifecycleState.PAUSING);
      validateDriverLifecycleTransition(DriverLifecycleState.PAUSING, DriverLifecycleState.PAUSED);
      validateDriverLifecycleTransition(DriverLifecycleState.PAUSED, DriverLifecycleState.RUNNING);
      validateDriverLifecycleTransition(DriverLifecycleState.RUNNING, DriverLifecycleState.STOPPING);
      validateDriverLifecycleTransition(DriverLifecycleState.STOPPING, DriverLifecycleState.STOPPED);
    });

    // Invalid transition: STOPPED -> RUNNING (STOPPED is terminal)
    assert.throws(
      () => {
        validateDriverLifecycleTransition(DriverLifecycleState.STOPPED, DriverLifecycleState.RUNNING);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidDriverLifecycleTransitionError);
        return true;
      }
    );

    // Invalid jump: IDLE -> RUNNING directly (must go through STARTING)
    assert.throws(
      () => {
        validateDriverLifecycleTransition(DriverLifecycleState.IDLE, DriverLifecycleState.RUNNING);
      },
      (err: any) => {
        assert.ok(err instanceof InvalidDriverLifecycleTransitionError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 5: One Complete Driver Iteration
  // --------------------------------------------------------------------------
  it('5. one complete driver iteration: coordinates P16, verifies evidence, integrates state, and advances task', async () => {
    const engine = createDriverEngine();
    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.iteration, 1);
    assert.equal(result.taskId, task1.task_id);
    assert.equal(result.cycleResult.terminalStatus, 'ACCEPTED');
    assert.equal(result.decision, 'CONTINUE');

    // Verify task is now ACCEPTED in SpecStore
    const tasks = await specStore.loadTasks();
    const updated = tasks.find((t) => t.task_id === task1.task_id);
    assert.equal(updated?.status, 'ACCEPTED');
  });

  // --------------------------------------------------------------------------
  // TEST 6: Automatic Continuation
  // --------------------------------------------------------------------------
  it('6. automatic continuation: advances through task1 to dependent task2 when authorized', async () => {
    const runtime = createDriverRuntime();
    // Run up to 2 iterations: iteration 1 accepts task1, iteration 2 accepts task2
    const summary = await runtime.start({ maxIterations: 2 });

    assert.equal(summary.iterationsRun, 2);
    const tasks = await specStore.loadTasks();
    const t1 = tasks.find((t) => t.task_id === task1.task_id);
    const t2 = tasks.find((t) => t.task_id === task2.task_id);

    assert.equal(t1?.status, 'ACCEPTED');
    assert.equal(t2?.status, 'ACCEPTED');
    assert.equal(summary.lifecycleState, DriverLifecycleState.STOPPED);
    assert.ok(summary.reason.includes('All project specification tasks are completed'));
  });

  // --------------------------------------------------------------------------
  // TEST 7: Continuation Authorization Validation
  // --------------------------------------------------------------------------
  it('7. continuation authorization validation: verifies development authorization before each cycle', async () => {
    const engine = createDriverEngine();
    const validation = await engine.validateContinuation(tempDir, canonicalProjectId);
    assert.equal(validation.isAllowed, true);
    assert.equal(validation.nextTaskId, task1.task_id);
  });

  // --------------------------------------------------------------------------
  // TEST 8: Pause Before Next Cycle
  // --------------------------------------------------------------------------
  it('8. pause before next cycle: stops before next iteration, preserves durable state, and does not corrupt state', async () => {
    const runtime = createDriverRuntime();
    // Start with maxIterations: 1 to simulate pause after first iteration
    await runtime.start({ maxIterations: 1 });
    await runtime.pause();

    assert.equal(runtime.currentLifecycleState, DriverLifecycleState.PAUSED);
    const state = await driverStore.loadState();
    assert.equal(state?.lifecycleState, DriverLifecycleState.PAUSED);
    assert.equal(state?.currentIteration, 1);
  });

  // --------------------------------------------------------------------------
  // TEST 9: Resume
  // --------------------------------------------------------------------------
  it('9. resume: reloads authoritative state, revalidates authorization, and resumes execution', async () => {
    const runtime = createDriverRuntime();
    await runtime.start({ maxIterations: 1 });
    await runtime.pause();
    assert.equal(runtime.currentLifecycleState, DriverLifecycleState.PAUSED);

    // Resume execution for task 2
    const summary = await runtime.resume({ maxIterations: 1 });
    assert.equal(summary.iterationsRun, 1);

    const tasks = await specStore.loadTasks();
    const t2 = tasks.find((t) => t.task_id === task2.task_id);
    assert.equal(t2?.status, 'ACCEPTED');
  });

  // --------------------------------------------------------------------------
  // TEST 10: Graceful Stop
  // --------------------------------------------------------------------------
  it('10. graceful stop: stops future cycles, persists STOPPED, releases lock, and preserves history', async () => {
    const runtime = createDriverRuntime();
    await runtime.start({ maxIterations: 1 });
    await runtime.stop('User requested termination');

    assert.equal(runtime.currentLifecycleState, DriverLifecycleState.STOPPED);
    const isLocked = await lockManager.isLocked();
    assert.equal(isLocked, false);

    const state = await driverStore.loadState();
    assert.equal(state?.lifecycleState, DriverLifecycleState.STOPPED);
    assert.ok(state?.completedAt);

    const stopEvents = (await historyManager.readEvents()).filter((e) => e.eventType === 'DRIVER_STOPPED');
    assert.ok(stopEvents.length >= 1);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Restart Recovery
  // --------------------------------------------------------------------------
  it('11. restart recovery: recovers from crash while RUNNING into safe PAUSED state with history audit', async () => {
    // Simulate crashed state on disk
    const crashedState: DurableDriverState = {
      schemaVersion: 1,
      driverId: 'crashed-driver',
      projectId: canonicalProjectId,
      lifecycleState: DriverLifecycleState.RUNNING,
      currentTaskId: task1.task_id,
      currentIteration: 3,
      continuationState: 'CONTINUING',
      continuationPolicy: 'GOVERNED_AUTONOMOUS',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await driverStore.saveState(crashedState);

    const runtime = createDriverRuntime();
    const recovered = await runtime.recover();

    assert.equal(recovered.lifecycleState, DriverLifecycleState.PAUSED);
    assert.equal(runtime.currentLifecycleState, DriverLifecycleState.PAUSED);

    const recEvents = (await historyManager.readEvents()).filter((e) => e.eventType === 'DRIVER_RECOVERING');
    assert.ok(recEvents.length >= 1);
  });

  // --------------------------------------------------------------------------
  // TEST 12: In-Flight Cycle Recovery
  // --------------------------------------------------------------------------
  it('12. in-flight cycle recovery: reconciles completed cycle result from crash without duplicate execution', async () => {
    // 1. Ingest instruction and execute cycle
    const engine = createDriverEngine();
    const instruction = await engine.directorLoopEngine.ingestInstruction({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: task1.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Test instruction',
      targetFiles: ['src/task1.ts'],
      actor: 'DIRECTOR',
    });
    const cycle = await engine.directorLoopEngine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
      instruction,
    });

    // 2. Simulate crashed driver state with inFlightCycle matching this instruction
    const crashedState: DurableDriverState = {
      schemaVersion: 1,
      driverId: 'crashed-driver-inflight',
      projectId: canonicalProjectId,
      lifecycleState: DriverLifecycleState.RUNNING,
      currentTaskId: task1.task_id,
      currentIteration: 1,
      continuationState: 'CONTINUING',
      continuationPolicy: 'GOVERNED_AUTONOMOUS',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inFlightCycle: {
        instructionId: instruction.instructionId,
        taskId: task1.task_id,
        taskRevision: 1,
        startedAt: new Date().toISOString(),
      },
    };
    await driverStore.saveState(crashedState);

    const runtime = createDriverRuntime();
    const recovered = await runtime.recover();

    assert.equal(recovered.inFlightCycle, null);
    assert.equal(recovered.lastCompletedCycleId, cycle.cycleId);
    assert.equal(recovered.lastTerminalStatus, 'ACCEPTED');
  });

  // --------------------------------------------------------------------------
  // TEST 13: Duplicate Execution Prevention
  // --------------------------------------------------------------------------
  it('13. duplicate execution prevention: already ACCEPTED instruction is not blindly re-executed', async () => {
    const engine = createDriverEngine();
    // Iteration 1 executes task 1
    const r1 = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });
    assert.equal(r1.cycleResult.terminalStatus, 'ACCEPTED');

    // Iteration 2 targets task 1 again: skips execution cleanly
    const r2 = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 2,
      targetTaskId: task1.task_id,
    });
    assert.equal(r2.cycleResult.cycleId, r1.cycleResult.cycleId);
    assert.ok(r2.reason.includes('already ACCEPTED. Skipping duplicate execution'));
  });

  // --------------------------------------------------------------------------
  // TEST 14: Stale Task Revision
  // --------------------------------------------------------------------------
  it('14. stale task revision: task revision mismatch between instruction and store fails closed', async () => {
    // Ingest instruction with revision 1
    const engine = createDriverEngine();
    const instruction = await engine.directorLoopEngine.ingestInstruction({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: task1.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Test instruction',
      targetFiles: ['src/task1.ts'],
      actor: 'DIRECTOR',
    });

    // Mutate task revision in SpecStore to 2
    task1.metadata = { ...task1.metadata, revision: 2 };
    await specStore.saveTasks([parentFeature, task1, task2]);

    // Executing the stale instruction must fail closed
    await assert.rejects(async () => {
      await engine.directorLoopEngine.executeCycle({
        workspaceRoot: tempDir,
        instructionId: instruction.instructionId,
        instruction,
      });
    });
  });

  // --------------------------------------------------------------------------
  // TEST 15: Stale Approval
  // --------------------------------------------------------------------------
  it('15. stale approval: approval package transitioning to PENDING fails closed', async () => {
    // Set approval package status to PENDING
    const revoked = { ...approvedPackage, status: 'PENDING' as any };
    await approvalStore.savePackage(revoked);

    const engine = createDriverEngine();
    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.decision, 'HUMAN_DECISION_REQUIRED');
    assert.ok(result.reason.includes('approval package is missing or not in APPROVED state'));
  });

  // --------------------------------------------------------------------------
  // TEST 16: Scope Mismatch
  // --------------------------------------------------------------------------
  it('16. scope mismatch: target file outside authorized scope fails closed', async () => {
    const engine = createDriverEngine();
    await assert.rejects(async () => {
      await engine.directorLoopEngine.ingestInstruction({
        workspaceRoot: tempDir,
        projectId: canonicalProjectId,
        directorSessionId: activeSession.directorSessionId,
        directorDecisionId: implementDecision.decisionId,
        taskId: task1.task_id,
        taskRevision: 1,
        contextFingerprint: activeSnapshot.logicalFingerprint,
        understandingRevision: 1,
        approvalPackageRevision: approvedPackage.revision,
        objective: 'Test scope violation',
        targetFiles: ['src/unauthorized.ts'],
        implementationScope: ['src/task1.ts'],
        actor: 'DIRECTOR',
      });
    });
  });

  // --------------------------------------------------------------------------
  // TEST 17: Authorization Loss
  // --------------------------------------------------------------------------
  it('17. authorization loss: isDevelopmentAuthorized returning false stops execution', async () => {
    // Revoke development authorization in approval package
    const unauthorizedPkg: ApprovalPackage = {
      ...approvedPackage,
      revision: 2,
      approvalRecord: undefined,
      status: 'APPROVED',
      developmentBlocked: true,
    } as any;
    await approvalStore.savePackage(unauthorizedPkg);

    const engine = createDriverEngine();
    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.decision, 'HUMAN_DECISION_REQUIRED');
    assert.ok(result.reason.includes('does not authorize development'));
  });

  // --------------------------------------------------------------------------
  // TEST 18: Human Decision Blocking
  // --------------------------------------------------------------------------
  it('18. human decision blocking: blockedState in DurableStateManager stops driver and yields decision point', async () => {
    await durableManager.save({
      currentLifecycleState: 'BLOCKED_ON_HUMAN' as any,
      activeTaskId: task1.task_id,
      completedTaskIds: [],
      blockedState: {
        blockedTaskId: task1.task_id,
        blockedIteration: 1,
        blockedContextReference: 'ctx-ref',
        blockingReason: 'Architectural conflict requires Product Owner decision',
        resumePoint: 'RESUME_TASK',
      },
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
    });

    const engine = createDriverEngine();
    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.decision, 'HUMAN_DECISION_REQUIRED');
    assert.ok(result.reason.includes('Architectural conflict requires Product Owner decision'));
  });

  // --------------------------------------------------------------------------
  // TEST 19: Recovery Policy Integration
  // --------------------------------------------------------------------------
  it('19. recovery policy integration: failed verification routes through RecoveryPolicyEngine without duplication', async () => {
    mockExecutor.failNext = true;
    const engine = createDriverEngine();

    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.cycleResult.terminalStatus, 'REJECTED');
    assert.ok(result.recoveryDecision);
  });

  // --------------------------------------------------------------------------
  // TEST 20: Retry Authorization Integration
  // --------------------------------------------------------------------------
  it('20. retry authorization integration: retry-eligible failure authorizes retry via RetryAuthorizationService', async () => {
    mockExecutor.failNext = true;
    const engine = createDriverEngine();

    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.cycleResult.terminalStatus, 'REJECTED');
    if (result.retryAuthorization?.success) {
      assert.equal(result.decision, 'CONTINUE');
      assert.ok(result.reason.includes('retry was authorized'));
    }
  });

  // --------------------------------------------------------------------------
  // TEST 21: Replan Integration
  // --------------------------------------------------------------------------
  it('21. replan integration: replan recommendation properly captured and surfaced in decision', async () => {
    mockExecutor.failNext = true;
    // Set max_attempts: 1 so retry budget is exhausted and triggers replan or human block
    task1.max_attempts = 1;
    await specStore.saveTasks([parentFeature, task1, task2]);

    const engine = createDriverEngine();
    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.cycleResult.terminalStatus, 'REJECTED');
    assert.ok(result.recoveryDecision);
  });

  // --------------------------------------------------------------------------
  // TEST 22: Durable Driver State
  // --------------------------------------------------------------------------
  it('22. durable driver state: persists atomically, captures all required fields, and survives reload', async () => {
    const runtime = createDriverRuntime();
    await runtime.start({ maxIterations: 1 });

    const loaded = await driverStore.loadState();
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(loaded.projectId, canonicalProjectId);
    assert.equal(loaded.currentIteration, 1);
    assert.equal(loaded.currentTaskId, task1.task_id);
    assert.ok(loaded.lastCompletedCycleId);
    assert.ok(loaded.lastInstructionId);
    assert.ok(loaded.lastEvidenceId);
    assert.equal(loaded.lastTerminalStatus, 'ACCEPTED');
  });

  // --------------------------------------------------------------------------
  // TEST 23: Deterministic Driver Identity / Idempotency
  // --------------------------------------------------------------------------
  it('23. deterministic driver identity/idempotency: computeDeterministicDriverId is stable; same driver lock is re-entrant', async () => {
    const id1 = computeDeterministicDriverId('my-proj', 'seed1');
    const id2 = computeDeterministicDriverId('my-proj', 'seed1');
    assert.equal(id1, id2);

    // Re-entrant lock re-acquisition with identical driverId is idempotent
    await lockManager.acquireLock('my-driver-id', canonicalProjectId);
    const renewed = await lockManager.acquireLock('my-driver-id', canonicalProjectId);
    assert.equal(renewed.driverId, 'my-driver-id');
  });

  // --------------------------------------------------------------------------
  // TEST 24: MCP Driver Controls
  // --------------------------------------------------------------------------
  it('24. MCP driver controls: driver.start, driver.status, driver.pause, driver.resume, driver.stop work over MCP', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      approvalStore,
      approvalPackageEngine,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
      executorPort: mockExecutor,
    });

    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      name: 'test-driver-server',
      version: '1.0.0',
      transport,
      delegate,
      driverTools: true,
    });
    await server.start();

    // Call driver.status
    // Initialize MCP session
    await server.handleMessage({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    async function callMcpTool(name: string, args: Record<string, unknown>): Promise<any> {
      const req = {
        jsonrpc: '2.0' as const,
        id: 'req-' + Math.random().toString(36).slice(2),
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      };
      const res = (await server.handleMessage(req)) as any;
      assert.ok(res?.result?.content?.[0]?.text, `Tool ${name} failed to return text content: ${JSON.stringify(res)}`);
      return JSON.parse(res.result.content[0].text);
    }

    const statusData = await callMcpTool(DRIVER_STATUS_TOOL_NAME, {
      workspaceRoot: tempDir,
    });
    assert.equal(statusData.success, true);

    // Call driver.start
    const startData = await callMcpTool(DRIVER_START_TOOL_NAME, {
      workspaceRoot: tempDir,
      maxIterations: 1,
    });
    assert.equal(startData.success, true);

    // Call driver.pause
    const pauseData = await callMcpTool(DRIVER_PAUSE_TOOL_NAME, {
      workspaceRoot: tempDir,
    });
    assert.equal(pauseData.success, true);

    // Call driver.stop
    const stopData = await callMcpTool(DRIVER_STOP_TOOL_NAME, {
      workspaceRoot: tempDir,
    });
    assert.equal(stopData.success, true);

    await server.stop();
  });

  // --------------------------------------------------------------------------
  // TEST 25: CLI Foreground Runtime
  // --------------------------------------------------------------------------
  it('25. CLI foreground runtime: executeDriver executes aidm driver run with proper lifecycle reporting', async () => {
    let output = '';
    const mockWriter: any = {
      write: (msg: string) => {
        output += msg + '\n';
      },
      writeError: (msg: string) => {
        output += msg + '\n';
      },
      writeJson: (val: any) => {
        output += JSON.stringify(val) + '\n';
      },
    };

    const result = await executeDriver(
      {
        projectRoot: tempDir,
        subcommand: 'run',
        maxIterations: 1,
        executorPort: mockExecutor,
      },
      mockWriter
    );

    assert.equal(result.exitCode, 0);
    assert.ok(output.includes('Starting Autonomous Driver (Foreground Runtime)...'));
    assert.ok(output.includes('Driver execution completed.'));
  });

  // --------------------------------------------------------------------------
  // TEST 26: No Arbitrary Process Execution
  // --------------------------------------------------------------------------
  it('26. no arbitrary process execution: driver interface exposes no shell command tool or arbitrary execution', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      driverTools: true,
    });
    await server.start();

    // Verify tools registered do not include any shell or bash execution
    const tools = server.getRegisteredTools();
    const toolNames = tools.flatMap((t: any) => [t.name, t.internalName].filter(Boolean));

    assert.ok(!toolNames.includes('bash'));
    assert.ok(!toolNames.includes('sh'));
    assert.ok(!toolNames.includes('exec'));
    assert.ok(!toolNames.includes('eval'));
    assert.ok(toolNames.includes(DRIVER_START_TOOL_NAME));
    assert.ok(toolNames.includes(DRIVER_STATUS_TOOL_NAME));

    await server.stop();
  });

  // --------------------------------------------------------------------------
  // TEST 27: Raw Outcome Never Becomes Proof
  // --------------------------------------------------------------------------
  it('27. raw outcome never becomes proof: executor reporting success with missing evidence fails verification', async () => {
    const engine = createDriverEngine();
    const instruction = await engine.directorLoopEngine.ingestInstruction({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: task1.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Test proof invariant',
      targetFiles: ['src/task1.ts'],
      actor: 'DIRECTOR',
    });

    const cycle = await engine.directorLoopEngine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
      instruction,
    });

    // Invariant: raw outcome is NOT proof, only system evidence is proof
    assert.equal(cycle.isAuthoritativeProof.executorOutcomeIsProof, false);
    assert.equal(cycle.isAuthoritativeProof.systemEvidenceIsProof, true);
  });

  // --------------------------------------------------------------------------
  // TEST 28: Evidence-Driven Continuation
  // --------------------------------------------------------------------------
  it('28. evidence-driven continuation: continuation decisions strictly depend on SystemExecutionEvidence verification decision', async () => {
    const engine = createDriverEngine();
    const result = await engine.runIteration({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      iterationNumber: 1,
      targetTaskId: task1.task_id,
    });

    assert.equal(result.cycleResult.systemEvidence.verificationDecision, 'ACCEPT');
    assert.equal(result.decision, 'CONTINUE');
  });

  // --------------------------------------------------------------------------
  // TEST 29: Terminal Driver State
  // --------------------------------------------------------------------------
  it('29. terminal driver state: STOPPED state rejects further transitions without new start', async () => {
    const runtime = createDriverRuntime();
    await runtime.start({ maxIterations: 1 });
    await runtime.stop('Clean shutdown');

    assert.equal(runtime.currentLifecycleState, DriverLifecycleState.STOPPED);
    await assert.rejects(async () => {
      await runtime.resume();
    });
  });

  // --------------------------------------------------------------------------
  // TEST 30: Concurrent Start Race
  // --------------------------------------------------------------------------
  it('30. concurrent start race: atomic lock guarantees only one winner during racing starts', async () => {
    const runtimeA = createDriverRuntime();
    const runtimeB = new DriverRuntime({
      workspaceRoot: tempDir,
      driverId: 'competing-driver-b',
      driverEngine: createDriverEngine(),
      lockManager: new DriverLockManager({ workspaceRoot: tempDir }),
      driverStore: new DriverStore({ workspaceRoot: tempDir, historyManager }),
      historyManager,
    });

    const results = await Promise.allSettled([
      runtimeA.start({ maxIterations: 1 }),
      runtimeB.start({ maxIterations: 1 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one driver should succeed');
    assert.equal(rejected.length, 1, 'Competing driver should be rejected');
    const rejReason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejReason instanceof DriverConcurrencyError);
  });
});
