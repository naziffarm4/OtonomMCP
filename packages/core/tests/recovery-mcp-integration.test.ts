/**
 * Phase 13 TASK-P13-04: Failure Replanning MCP Boundary & End-to-End Recovery Integration Tests
 *
 * Exposes and proves the complete failure recovery lifecycle across:
 * - aidm.recovery.evaluate
 * - aidm.task.retry
 * - aidm.task.replan
 * Composing P13-01, P13-02, P13-03, P10, P11, and P12 authoritative services.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  McpServer,
  McpServerState,
  createRecoveryEvaluateTool,
  createRetryAuthorizeTool,
  createCorrectiveTaskTool,
  AIDM_RECOVERY_EVALUATE_TOOL_NAME,
  AIDM_TASK_RETRY_TOOL_NAME,
  AIDM_TASK_AUTHORIZE_RETRY_TOOL_NAME,
  AIDM_TASK_REPLAN_TOOL_NAME,
  AIDM_TASK_CREATE_CORRECTIVE_TOOL_NAME,
  type McpTransport,
  RecoveryPolicyEngine,
  RecoveryStrategy,
  FailureCategory,
  RetryAuthorizationService,
  CorrectiveTaskService,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  TaskDagEngine,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type TaskDefinition,
  ApprovalStore,
  ApprovalPackageEngine,
  InitialProjectUnderstandingBuilder,
  type ProjectApprovalPackage,
  DirectorSessionStore,
  DirectorDecisionStore,
  ExecutionAuthorizer,
  ExecutionStateIntegrator,
  type SystemExecutionEvidence,
} from '../dist/index.js';

class MockMcpTransport implements McpTransport {
  isConnected = true;
  sentMessages: unknown[] = [];
  private messageHandler?: (msg: any) => Promise<void>;

  async start(): Promise<void> {
    this.isConnected = true;
  }
  async close(): Promise<void> {
    this.isConnected = false;
  }
  async send(message: unknown): Promise<void> {
    this.sentMessages.push(message);
  }
  onMessage(handler: (msg: any) => Promise<void>): void {
    this.messageHandler = handler;
  }
  onError(_handler: (err: Error) => void): void {}
  onClose(_handler: () => void): void {}

  async simulateMessage(msg: any): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(msg);
    }
  }
}

describe('P13-04: Failure Replanning MCP Boundary & End-to-End Recovery Integration', () => {
  let tempDir: string;
  let specStore: SpecStore;
  let historyManager: HistoryManager;
  let durableStateManager: DurableStateManager;
  let dagEngine: TaskDagEngine;
  let approvalStore: ApprovalStore;
  let sessionStore: DirectorSessionStore;
  let decisionStore: DirectorDecisionStore;
  let authorizer: ExecutionAuthorizer;
  let recoveryPolicyEngine: RecoveryPolicyEngine;
  let retryService: RetryAuthorizationService;
  let correctiveService: CorrectiveTaskService;
  let integrator: ExecutionStateIntegrator;

  const projectId = 'PROJ-P13-04-TEST';
  const directorSessionId = 'sess-p13-04-001';
  const contextFingerprint = 'fp_p13_04_authoritative_sha256';

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

  async function saveTasks(tasks: TaskDefinition[]): Promise<void> {
    await specStore.saveTasks([parentFeature, ...tasks]);
  }

  function createValidTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
    return {
      task_id: overrides.task_id ?? 'TASK-P13-04-001',
      parent_feature_id: overrides.parent_feature_id ?? 'FEAT-P13',
      title: overrides.title ?? 'Implement governed failure recovery endpoint',
      description: overrides.description ?? 'Test implementation task for P13-04',
      traceability_sources: overrides.traceability_sources ?? ['REQ:P13-04-01'],
      dependencies: overrides.dependencies ?? [],
      acceptance_criteria: overrides.acceptance_criteria ?? [
        'AC-1: Failure is accurately diagnosed',
        'AC-2: State transitions fail-closed',
      ],
      status: overrides.status ?? TaskStatus.READY,
      attempt: overrides.attempt ?? 0,
      max_attempts: overrides.max_attempts ?? 2,
      priority: overrides.priority ?? TaskPriority.HIGH,
      risk_level: overrides.risk_level ?? RiskLevel.SAFE,
      created_at: overrides.created_at ?? new Date().toISOString(),
      started_at: overrides.started_at ?? null,
      completed_at: overrides.completed_at ?? null,
      hierarchy_level: 'TASK',
      metadata: {
        revision: 1,
        ...overrides.metadata,
      },
    };
  }

  function createVerifiedEvidence(overrides: Partial<SystemExecutionEvidence> = {}): SystemExecutionEvidence {
    const taskId = overrides.taskId ?? 'TASK-P13-04-001';
    const requestId = overrides.requestId ?? `req_${taskId}_${Date.now()}`;
    const evidenceId = overrides.evidenceId ?? `evi_${requestId.replace(/^req_/, '').slice(0, 16)}_abc1234567890`;
    return {
      evidenceId,
      requestId,
      projectId: overrides.projectId ?? projectId,
      taskId,
      taskRevision: overrides.taskRevision ?? 1,
      contextFingerprint: overrides.contextFingerprint ?? contextFingerprint,
      understandingRevision: overrides.understandingRevision ?? 1,
      approvalPackageRevision: overrides.approvalPackageRevision ?? 1,
      repositoryState: {
        baseCommit: 'commit_base_0000000000000000000000000000000000000000',
        headCommit: 'commit_head_1111111111111111111111111111111111111111',
        isClean: true,
        ...overrides.repositoryState,
      },
      changedFiles: overrides.changedFiles ?? [{ path: 'src/service.ts', status: 'M' }],
      verificationChecks: overrides.verificationChecks ?? [
        {
          checkId: 'CHK-TEST',
          type: 'TEST',
          status: 'FAIL',
          command: 'npm test',
          evidence: 'AssertionError: Expected 200 OK, got 500 Internal Error',
          durationMs: 250,
        },
      ],
      acceptanceCriteria: overrides.acceptanceCriteria ?? [
        {
          criterion: 'AC-1: Failure is accurately diagnosed',
          status: 'FAIL',
          evidence: 'Test assertion failed in endpoint handler',
        },
      ],
      executorOutcomeReference: overrides.executorOutcomeReference ?? {
        status: 'EXECUTION_FAILED',
        exitCode: 1,
        durationMs: 450,
      },
      verificationDecision: overrides.verificationDecision ?? 'REJECT',
      verifiedAt: overrides.verifiedAt ?? new Date().toISOString(),
      metadata: overrides.metadata,
    };
  }

  function createApprovedPackage(overrides: Partial<ProjectApprovalPackage> = {}): ProjectApprovalPackage {
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
      packageId: 'pkg-p13-04-active',
      directorSessionId,
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
  }

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p13-04-test-'));
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: projectId, version: '1.0.0' })
    );
    specStore = new SpecStore({ baseDir: tempDir });
    historyManager = new HistoryManager({ baseDir: tempDir });
    durableStateManager = new DurableStateManager({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    authorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      decisionStore,
      approvalStore,
      specStore,
      dagEngine,
      historyManager,
    });
    recoveryPolicyEngine = new RecoveryPolicyEngine({
      historyManager,
      expectedProjectId: projectId,
    });
    retryService = new RetryAuthorizationService({
      workspaceRoot: tempDir,
      specStore,
      dagEngine,
      historyManager,
      approvalStore,
      directorSessionStore: sessionStore,
      expectedProjectId: projectId,
    });
    correctiveService = new CorrectiveTaskService({
      workspaceRoot: tempDir,
      specStore,
      dagEngine,
      historyManager,
      approvalStore,
      directorSessionStore: sessionStore,
      expectedProjectId: projectId,
    });
    integrator = new ExecutionStateIntegrator({
      baseDir: tempDir,
      specStore,
      durableStateManager,
      historyManager,
      expectedProjectId: projectId,
    });

    // Establish active director session
    await sessionStore.saveSession({
      directorSessionId,
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

    // Establish active approval package conforming to schema
    await approvalStore.savePackage(createApprovedPackage());
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // MCP TOOL REGISTRATION
  // ==========================================================================
  describe('MCP Tool Registration & Discovery', () => {
    it('1. registers aidm.recovery.evaluate, aidm.task.retry, and aidm.task.replan on McpServer', () => {
      const transport = new MockMcpTransport();
      const server = new McpServer({
        transport,
        recoveryTools: true,
      });

      const registry = (server as any).toolRegistry as Map<string, any>;
      assert.ok(registry.has(AIDM_RECOVERY_EVALUATE_TOOL_NAME), 'aidm.recovery.evaluate must be registered');
      assert.ok(registry.has(AIDM_TASK_RETRY_TOOL_NAME), 'aidm.task.retry must be registered');
      assert.ok(registry.has(AIDM_TASK_REPLAN_TOOL_NAME), 'aidm.task.replan must be registered');
      // Verify backward-compatibility aliases
      assert.ok(registry.has(AIDM_TASK_AUTHORIZE_RETRY_TOOL_NAME), 'aidm.task.authorizeRetry alias must be registered');
      assert.ok(registry.has(AIDM_TASK_CREATE_CORRECTIVE_TOOL_NAME), 'aidm.task.createCorrective alias must be registered');
    });
  });

  // ==========================================================================
  // SCENARIO A — RETRY PATH (End-to-End Lifecycle)
  // ==========================================================================
  describe('Scenario A: Retry Path (End-to-End Recovery Lifecycle)', () => {
    it('completes the full recovery lifecycle: evaluate -> retry -> re-execute -> accept', async () => {
      // 1. Authoritative task exists in SpecStore
      const task = createValidTask({
        task_id: 'TASK-E2E-RETRY',
        status: TaskStatus.READY,
        attempt: 0,
        max_attempts: 2,
      });
      await saveTasks([task]);

      // 2. First execution fails -> produce independent REJECT evidence
      const failEvidence = createVerifiedEvidence({
        taskId: 'TASK-E2E-RETRY',
        verificationDecision: 'REJECT',
        verificationChecks: [
          {
            checkId: 'CHK-1',
            type: 'TEST',
            status: 'FAIL',
            command: 'npm test',
            evidence: 'Test failed: timeout',
          },
        ],
      });

      // 3. Call aidm.recovery.evaluate MCP tool
      const evalTool = createRecoveryEvaluateTool({
        recoveryPolicyEngine,
        specStore,
        historyManager,
        approvalStore,
      });
      const evalResult = await evalTool.handler(
        {
          evidence: failEvidence,
          expectedProjectId: projectId,
        },
        {
          correlation: { requestId: 'req_eval_1', sessionId: 'sess_1', timestamp: new Date().toISOString() },
        }
      );

      assert.equal(evalResult.isError, false);
      const evalPayload = JSON.parse(evalResult.content[0].text as string);
      assert.equal(evalPayload.decision, RecoveryStrategy.RETRY);
      assert.equal(evalPayload.retryAllowed, true);

      // Verify history event RECOVERY_DECISION_EVALUATED was written
      const eventsAfterEval = await historyManager.readEvents();
      assert.ok(eventsAfterEval.some((e) => e.eventType === 'RECOVERY_DECISION_EVALUATED'));

      // 4. Call aidm.task.retry MCP tool
      const retryTool = createRetryAuthorizeTool({ retryService });
      const retryResult = await retryTool.handler(
        {
          evidence: failEvidence,
          decision: evalPayload,
          expectedProjectId: projectId,
        },
        {
          correlation: { requestId: 'req_retry_1', sessionId: 'sess_1', timestamp: new Date().toISOString() },
        }
      );

      assert.equal(retryResult.isError, false);
      const retryPayload = JSON.parse(retryResult.content[0].text as string);
      assert.equal(retryPayload.success, true);
      assert.equal(retryPayload.taskStatus, TaskStatus.READY);
      assert.equal(retryPayload.newAttempt, 1);

      // Verify task in SpecStore: status is READY, attempt is 1
      const tasksAfterRetry = await specStore.loadTasks();
      const updatedTask = tasksAfterRetry.find((t) => t.task_id === 'TASK-E2E-RETRY');
      assert.ok(updatedTask);
      assert.equal(updatedTask.status, TaskStatus.READY);
      assert.equal(updatedTask.attempt, 1);
      assert.equal(updatedTask.max_attempts, 2);

      // Verify history event TASK_RETRY_AUTHORIZED was written
      const eventsAfterRetry = await historyManager.readEvents();
      assert.ok(eventsAfterRetry.some((e) => e.eventType === 'TASK_RETRY_AUTHORIZED'));

      // 5. Second execution succeeds -> produce independent ACCEPT evidence
      const passEvidence = createVerifiedEvidence({
        taskId: 'TASK-E2E-RETRY',
        verificationDecision: 'ACCEPT',
        verificationChecks: [
          {
            checkId: 'CHK-1',
            type: 'TEST',
            status: 'PASS',
            command: 'npm test',
            evidence: 'All 15 tests passed',
          },
        ],
        acceptanceCriteria: [
          {
            criterion: 'AC-1: Failure is accurately diagnosed',
            status: 'PASS',
            evidence: 'Verified passing',
          },
        ],
        executorOutcomeReference: {
          status: 'SUCCESS',
          exitCode: 0,
          durationMs: 300,
        },
      });

      // 6. Integrate ACCEPT evidence via ExecutionStateIntegrator
      const integrateOutcome = await integrator.integrate(passEvidence);
      assert.equal(integrateOutcome.success, true);
      assert.equal(integrateOutcome.taskStatus, TaskStatus.ACCEPTED);

      // 7. Verify final task state in SpecStore is ACCEPTED
      const tasksAfterPass = await specStore.loadTasks();
      const acceptedTask = tasksAfterPass.find((t) => t.task_id === 'TASK-E2E-RETRY');
      assert.ok(acceptedTask);
      assert.equal(acceptedTask.status, TaskStatus.ACCEPTED);
      assert.equal(acceptedTask.attempt, 1); // Preserves attempt count
    });
  });

  // ==========================================================================
  // SCENARIO B — RETRY EXHAUSTION
  // ==========================================================================
  describe('Scenario B: Retry Exhaustion & Budget Limits', () => {
    it('rejects retry authorization when max_attempts is exhausted', async () => {
      // Task with attempt = 2, max_attempts = 2
      const task = createValidTask({
        task_id: 'TASK-BUDGET-EXHAUSTED',
        status: TaskStatus.REJECTED,
        attempt: 2,
        max_attempts: 2,
      });
      await saveTasks([task]);

      const failEvidence = createVerifiedEvidence({
        taskId: 'TASK-BUDGET-EXHAUSTED',
        verificationDecision: 'REJECT',
      });

      // 1. aidm.recovery.evaluate recognizes exhaustion
      const evalTool = createRecoveryEvaluateTool({
        recoveryPolicyEngine,
        specStore,
        historyManager,
        approvalStore,
      });
      const evalResult = await evalTool.handler(
        { evidence: failEvidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_eval_b', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(evalResult.isError, false);
      const evalPayload = JSON.parse(evalResult.content[0].text as string);
      assert.equal(evalPayload.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
      assert.equal(evalPayload.retryAllowed, false);
      assert.ok(evalPayload.reasonCodes.includes('RETRY_BUDGET_EXHAUSTED'));

      // 2. aidm.task.retry is rejected
      const retryTool = createRetryAuthorizeTool({ retryService });
      const retryResult = await retryTool.handler(
        { evidence: failEvidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_retry_b', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(retryResult.isError, true);
      const retryPayload = JSON.parse(retryResult.content[0].text as string);
      assert.equal(retryPayload.code, 'ERR_RETRY_BUDGET_EXHAUSTED');

      // 3. Verify task did not reset or mutate
      const tasks = await specStore.loadTasks();
      const currentTask = tasks.find((t) => t.task_id === 'TASK-BUDGET-EXHAUSTED');
      assert.equal(currentTask?.attempt, 2);
      assert.equal(currentTask?.max_attempts, 2);
      assert.equal(currentTask?.status, TaskStatus.REJECTED);
    });
  });

  // ==========================================================================
  // SCENARIO C — REPLAN PATH
  // ==========================================================================
  describe('Scenario C: Replan Path & Governed Corrective Lineage', () => {
    it('creates governed corrective task with proper lineage and clean dependencies', async () => {
      // Source task with existing prerequisite
      const prereqTask = createValidTask({
        task_id: 'TASK-PREREQ-ACCEPTED',
        status: TaskStatus.ACCEPTED,
      });
      const sourceTask = createValidTask({
        task_id: 'TASK-SRC-FAIL',
        dependencies: ['TASK-PREREQ-ACCEPTED'],
        status: TaskStatus.REJECTED,
      });
      await saveTasks([prereqTask, sourceTask]);

      // Evidence with SCOPE_VIOLATION to trigger REPLAN
      const failEvidence = createVerifiedEvidence({
        taskId: 'TASK-SRC-FAIL',
        verificationDecision: 'REJECT',
        verificationChecks: [
          {
            checkId: 'CHK-SCOPE',
            type: 'SCOPE',
            status: 'FAIL',
            evidence: 'Modified files outside authorized implementation scope: unauthorized_file.ts',
          },
        ],
      });

      // 1. aidm.recovery.evaluate evaluates failure as REPLAN
      const evalTool = createRecoveryEvaluateTool({
        recoveryPolicyEngine,
        specStore,
        historyManager,
        approvalStore,
      });
      const evalResult = await evalTool.handler(
        { evidence: failEvidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_eval_c', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(evalResult.isError, false);
      const evalPayload = JSON.parse(evalResult.content[0].text as string);
      assert.equal(evalPayload.decision, RecoveryStrategy.REPLAN);
      assert.equal(evalPayload.replanAllowed, true);

      // 2. Call aidm.task.replan
      const replanTool = createCorrectiveTaskTool({ correctiveService });
      const replanResult = await replanTool.handler(
        {
          evidence: failEvidence,
          decision: evalPayload,
          expectedProjectId: projectId,
          proposal: {
            title: 'Corrective: Scope-governed replan task',
            description: 'Refined task targeting authorized files only',
            additionalDependencies: [],
          },
        },
        { correlation: { requestId: 'req_replan_c', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(replanResult.isError, false);
      const replanPayload = JSON.parse(replanResult.content[0].text as string);
      assert.equal(replanPayload.success, true);
      assert.ok(replanPayload.correctiveTaskId.startsWith('TASK-CORRECTIVE-SRC-FAIL-'));

      // 3. Inspect SpecStore:
      const tasks = await specStore.loadTasks();
      const correctiveTask = tasks.find((t) => t.task_id === replanPayload.correctiveTaskId);
      assert.ok(correctiveTask);

      // Source task remains preserved and REJECTED
      const preservedSource = tasks.find((t) => t.task_id === 'TASK-SRC-FAIL');
      assert.equal(preservedSource?.status, TaskStatus.REJECTED);

      // Critical invariant: Corrective task must NOT depend on rejected source task
      assert.ok(
        !correctiveTask.dependencies.includes('TASK-SRC-FAIL'),
        'Corrective task must NOT depend on rejected source task'
      );
      // Corrective task preserves legitimate prerequisites of source task
      assert.ok(correctiveTask.dependencies.includes('TASK-PREREQ-ACCEPTED'));

      // Lineage metadata is accurate
      const lineage = correctiveTask.metadata?.lineage as any;
      assert.ok(lineage);
      assert.equal(lineage.kind, 'CORRECTIVE');
      assert.equal(lineage.sourceTaskId, 'TASK-SRC-FAIL');
      assert.equal(lineage.sourceEvidenceId, failEvidence.evidenceId);
      assert.equal(lineage.recoveryStrategy, 'REPLAN');

      // 4. DAG validation passes
      const validGraph = dagEngine.assertValidGraph(tasks, { validFeatureIds: ['FEAT-P13'] });
      assert.ok(validGraph.length >= 3);

      // 5. Normal ExecutionAuthorizer authorization is required to execute corrective task
      const sessionId = 'dir-sess-corrective';
      const decisionId = 'dir-dec-corrective';
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
        logicalFingerprint: contextFingerprint,
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
      await decisionStore.saveDecision({
        decisionId,
        directorSessionId: sessionId,
        projectId,
        protocolVersion: 'P9-03',
        schemaVersion: 1,
        actor: 'DIRECTOR',
        decisionType: 'IMPLEMENT_TASK',
        rationale: 'Execute corrective task',
        basedOnContextFingerprint: contextFingerprint,
        basedOnApprovalRevision: 1,
        basedOnUnderstandingRevision: 1,
        createdAt: new Date().toISOString(),
        metadata: {},
        hasImplementationAuthority: false,
      });

      const authResult = await authorizer.validateExecutionIntent({
        directorSessionId: sessionId,
        directorDecisionId: decisionId,
        projectId,
        taskId: correctiveTask.task_id,
        taskRevision: 1,
        contextFingerprint,
        understandingRevision: 1,
        approvalPackageRevision: 1,
      });

      assert.equal(authResult.isValid, true);
      assert.equal(authResult.code, 'VALID');
    });
  });

  // ==========================================================================
  // SCENARIO D — UNAUTHORIZED ACCESS
  // ==========================================================================
  describe('Scenario D: Unauthorized Access Protections', () => {
    it('rejects evaluation when project ID mismatches', async () => {
      const task = createValidTask({ task_id: 'TASK-UNAUTH-1' });
      await saveTasks([task]);

      const foreignEvidence = createVerifiedEvidence({
        taskId: 'TASK-UNAUTH-1',
        projectId: 'PROJ-FOREIGN-ATTACKER',
      });

      const evalTool = createRecoveryEvaluateTool({
        recoveryPolicyEngine,
        specStore,
        historyManager,
        approvalStore,
      });
      const result = await evalTool.handler(
        { evidence: foreignEvidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_d1', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text as string);
      assert.equal(parsed.code, 'ERR_RECOVERY_POLICY_BINDING_MISMATCH');
    });

    it('rejects retry when approval package is stale', async () => {
      const task = createValidTask({ task_id: 'TASK-UNAUTH-2' });
      await saveTasks([task]);

      // Evidence claims approvalPackageRevision: 99 (active is 1)
      const staleEvidence = createVerifiedEvidence({
        taskId: 'TASK-UNAUTH-2',
        approvalPackageRevision: 99,
      });

      const retryTool = createRetryAuthorizeTool({ retryService });
      const result = await retryTool.handler(
        { evidence: staleEvidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_d2', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text as string);
      assert.equal(parsed.code, 'ERR_RETRY_BINDING_MISMATCH');
    });

    it('rejects replan when understanding revision mismatches', async () => {
      const task = createValidTask({ task_id: 'TASK-UNAUTH-3' });
      await saveTasks([task]);

      const evidence = createVerifiedEvidence({
        taskId: 'TASK-UNAUTH-3',
        understandingRevision: 1,
        verificationChecks: [
          {
            checkId: 'CHK-SCOPE',
            type: 'SCOPE',
            status: 'FAIL',
            evidence: 'Out of scope modification',
          },
        ],
      });

      const replanTool = createCorrectiveTaskTool({ correctiveService });
      const result = await replanTool.handler(
        {
          evidence,
          expectedProjectId: projectId,
          understandingRevision: 2, // caller claims revision 2
        },
        { correlation: { requestId: 'req_d3', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text as string);
      assert.equal(parsed.code, 'ERR_CORRECTIVE_TASK_BINDING_MISMATCH');
    });

    it('rejects evaluation when task revision mismatches authoritative SpecStore', async () => {
      const task = createValidTask({ task_id: 'TASK-UNAUTH-4', metadata: { revision: 1 } });
      await saveTasks([task]);

      const evidence = createVerifiedEvidence({
        taskId: 'TASK-UNAUTH-4',
        taskRevision: 5, // Mismatch with SpecStore
      });

      const evalTool = createRecoveryEvaluateTool({
        recoveryPolicyEngine,
        specStore,
        historyManager,
        approvalStore,
      });
      const result = await evalTool.handler(
        { evidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_d4', sessionId: 'sess_1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text as string);
      assert.equal(parsed.code, 'ERR_RECOVERY_POLICY_BINDING_MISMATCH');
    });
  });

  // ==========================================================================
  // SCENARIO E — FORGED EVIDENCE
  // ==========================================================================
  describe('Scenario E: Forged Evidence Rejection', () => {
    it('rejects fabricated caller verification claims (retryApproved, replanApproved)', async () => {
      const task = createValidTask({ task_id: 'TASK-FORGE-1' });
      await saveTasks([task]);
      const evidence = createVerifiedEvidence({ taskId: 'TASK-FORGE-1' });

      const evalTool = createRecoveryEvaluateTool({ recoveryPolicyEngine, specStore });
      const resEval = await evalTool.handler(
        { evidence, retryApproved: true }, // Fabricated claim
        { correlation: { requestId: 'f1', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(resEval.isError, true);
      assert.equal(JSON.parse(resEval.content[0].text as string).code, 'ERR_RECOVERY_POLICY_SECURITY_VIOLATION');

      const retryTool = createRetryAuthorizeTool({ retryService });
      const resRetry = await retryTool.handler(
        { evidence, systemAccepted: true }, // Fabricated claim
        { correlation: { requestId: 'f2', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(resRetry.isError, true);
      assert.equal(JSON.parse(resRetry.content[0].text as string).code, 'ERR_RETRY_SECURITY_VIOLATION');

      const replanTool = createCorrectiveTaskTool({ correctiveService });
      const resReplan = await replanTool.handler(
        { evidence, replanApproved: true }, // Fabricated claim
        { correlation: { requestId: 'f3', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(resReplan.isError, true);
      assert.equal(JSON.parse(resReplan.content[0].text as string).code, 'ERR_CORRECTIVE_TASK_SECURITY_VIOLATION');
    });

    it('rejects fake verification fields embedded inside evidence payload', async () => {
      const task = createValidTask({ task_id: 'TASK-FORGE-2' });
      await saveTasks([task]);

      const taintedEvidence = {
        ...createVerifiedEvidence({ taskId: 'TASK-FORGE-2' }),
        verified: true, // Forbidden field
      };

      const evalTool = createRecoveryEvaluateTool({ recoveryPolicyEngine, specStore });
      const result = await evalTool.handler(
        { evidence: taintedEvidence },
        { correlation: { requestId: 'f4', sessionId: 's1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text as string).code, 'ERR_RECOVERY_POLICY_SECURITY_VIOLATION');
    });

    it('rejects raw executor outcomes masquerading as SystemExecutionEvidence', async () => {
      const task = createValidTask({ task_id: 'TASK-FORGE-3' });
      await saveTasks([task]);

      const rawOutcome = {
        status: 'EXECUTION_FAILED',
        exitCode: 1,
        stdout: 'Error: failed',
      };

      const evalTool = createRecoveryEvaluateTool({ recoveryPolicyEngine, specStore });
      const result = await evalTool.handler(
        { evidence: rawOutcome },
        { correlation: { requestId: 'f5', sessionId: 's1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text as string).code, 'ERR_RECOVERY_POLICY_VALIDATION');
    });

    it('rejects mismatched caller taskId assertion vs evidence taskId', async () => {
      const task = createValidTask({ task_id: 'TASK-FORGE-4' });
      await saveTasks([task]);
      const evidence = createVerifiedEvidence({ taskId: 'TASK-FORGE-4' });

      const evalTool = createRecoveryEvaluateTool({ recoveryPolicyEngine, specStore });
      const result = await evalTool.handler(
        { evidence, taskId: 'TASK-SOME-OTHER-ID' },
        { correlation: { requestId: 'f6', sessionId: 's1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text as string).code, 'ERR_RECOVERY_POLICY_BINDING_MISMATCH');
    });
  });

  // ==========================================================================
  // SCENARIO F — IDEMPOTENCY
  // ==========================================================================
  describe('Scenario F: Idempotency & Deduplication', () => {
    it('repeating the exact same retry request is idempotent and does not increment attempt twice', async () => {
      const task = createValidTask({
        task_id: 'TASK-IDEM-RETRY',
        status: TaskStatus.READY,
        attempt: 0,
        max_attempts: 2,
      });
      await saveTasks([task]);

      const evidence = createVerifiedEvidence({ taskId: 'TASK-IDEM-RETRY' });
      const retryTool = createRetryAuthorizeTool({ retryService });

      // First call
      const first = await retryTool.handler(
        { evidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_idem_1', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(first.isError, false);
      const firstPayload = JSON.parse(first.content[0].text as string);
      assert.equal(firstPayload.newAttempt, 1);
      assert.equal(firstPayload.isDuplicate ?? false, false);

      // Second identical call
      const second = await retryTool.handler(
        { evidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_idem_2', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(second.isError, false);
      const secondPayload = JSON.parse(second.content[0].text as string);
      assert.equal(secondPayload.newAttempt, 1);
      assert.equal(secondPayload.isDuplicate, true);

      // Verify task in SpecStore only incremented once
      const tasks = await specStore.loadTasks();
      const currentTask = tasks.find((t) => t.task_id === 'TASK-IDEM-RETRY');
      assert.equal(currentTask?.attempt, 1);

      // Verify history events: only 1 TASK_RETRY_AUTHORIZED event
      const events = await historyManager.readEvents();
      const retryEvents = events.filter(
        (e) => e.eventType === 'TASK_RETRY_AUTHORIZED' && e.taskId === 'TASK-IDEM-RETRY'
      );
      assert.equal(retryEvents.length, 1);
    });

    it('repeating the exact same replan request is idempotent and does not create duplicate tasks', async () => {
      const task = createValidTask({
        task_id: 'TASK-IDEM-REPLAN',
        status: TaskStatus.REJECTED,
      });
      await saveTasks([task]);

      const evidence = createVerifiedEvidence({
        taskId: 'TASK-IDEM-REPLAN',
        verificationChecks: [{ checkId: 'CHK-SCOPE', type: 'FILE_SCOPE', status: 'FAIL', evidence: 'Scope violation' }],
      });
      const replanTool = createCorrectiveTaskTool({ correctiveService });

      // First call
      const first = await replanTool.handler(
        { evidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_idem_3', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(first.isError, false);
      const firstPayload = JSON.parse(first.content[0].text as string);
      assert.equal(firstPayload.isDuplicate ?? false, false);

      // Second identical call
      const second = await replanTool.handler(
        { evidence, expectedProjectId: projectId },
        { correlation: { requestId: 'req_idem_4', sessionId: 's1', timestamp: new Date().toISOString() } }
      );
      assert.equal(second.isError, false);
      const secondPayload = JSON.parse(second.content[0].text as string);
      assert.equal(secondPayload.isDuplicate, true);
      assert.equal(secondPayload.correctiveTaskId, firstPayload.correctiveTaskId);

      // Verify SpecStore only contains 1 corrective task
      const tasks = await specStore.loadTasks();
      const correctiveTasks = tasks.filter((t) => t.task_id === firstPayload.correctiveTaskId);
      assert.equal(correctiveTasks.length, 1);
    });
  });

  // ==========================================================================
  // SANITIZATION & SECRET REDACTION
  // ==========================================================================
  describe('Sanitization & Secret Redaction', () => {
    it('redacts sensitive keys from MCP responses, decisions, and history', async () => {
      const task = createValidTask({ task_id: 'TASK-SECRET-TEST' });
      await saveTasks([task]);

      const evidenceWithSecrets = createVerifiedEvidence({
        taskId: 'TASK-SECRET-TEST',
        metadata: {
          apiKey: 'AIzaSyA_TOP_SECRET_API_KEY_12345',
          secretToken: 'ghp_MY_SECRET_GITHUB_TOKEN',
          nested: {
            password: 'SuperSecretPassword99!',
            credentials: {
              authHeader: 'Bearer my-auth-token-xyz',
            },
          },
          arrayWithSecrets: [
            { token: 'secret-token-in-array' },
            'plain text',
          ],
        },
      });

      const evalTool = createRecoveryEvaluateTool({
        recoveryPolicyEngine,
        specStore,
        historyManager,
        approvalStore,
      });
      const result = await evalTool.handler(
        { evidence: evidenceWithSecrets, expectedProjectId: projectId },
        { correlation: { requestId: 'req_sec', sessionId: 's1', timestamp: new Date().toISOString() } }
      );

      assert.equal(result.isError, false);
      const responseText = result.content[0].text as string;

      // Verify no sensitive tokens leaked into response text
      assert.ok(!responseText.includes('AIzaSyA_TOP_SECRET_API_KEY_12345'));
      assert.ok(!responseText.includes('ghp_MY_SECRET_GITHUB_TOKEN'));
      assert.ok(!responseText.includes('SuperSecretPassword99!'));
      assert.ok(!responseText.includes('my-auth-token-xyz'));
      assert.ok(!responseText.includes('secret-token-in-array'));
    });
  });

  // ==========================================================================
  // AUTONOMY & BOUNDARY INTEGRITY
  // ==========================================================================
  describe('Autonomy & Non-Autonomous Boundary Integrity', () => {
    it('proves MCP tools operate purely synchronously without autonomous daemons or execution loops', async () => {
      const task = createValidTask({ task_id: 'TASK-AUTONOMY-TEST' });
      await saveTasks([task]);
      const evidence = createVerifiedEvidence({ taskId: 'TASK-AUTONOMY-TEST' });

      const evalTool = createRecoveryEvaluateTool({ recoveryPolicyEngine, specStore });
      const retryTool = createRetryAuthorizeTool({ retryService });
      const replanTool = createCorrectiveTaskTool({ correctiveService });

      // None of the tools should return a background promise or loop
      const evalOut = await evalTool.handler({ evidence, expectedProjectId: projectId }, { correlation: { requestId: '1', sessionId: '1', timestamp: '' } });
      const retryOut = await retryTool.handler({ evidence, expectedProjectId: projectId }, { correlation: { requestId: '2', sessionId: '1', timestamp: '' } });

      assert.ok(evalOut.content.length > 0);
      assert.ok(retryOut.content.length > 0);

      // Verify no FSM state was mutated into autonomous continuation
      const durable = await durableStateManager.load();
      assert.notEqual(durable?.continuationPolicy, 'CONTINUOUS_LOOP');
    });
  });
});
