/**
 * Phase 14 TASK-P14-02: Single Task End-to-End Real Execution Test Suite
 *
 * Verifies that a single governed implementation task traverses the complete
 * authoritative pipeline with the REAL Antigravity CLI and is independently verified:
 *
 *   Director Decision
 *       ↓
 *   ExecutionAuthorizer
 *       ↓
 *   ExecutionIntent
 *       ↓
 *   ExecutionRequestBuilder
 *       ↓
 *   ExecutionRequest (with authoritative ExecutorContextPackage)
 *       ↓
 *   ExecutorGuard
 *       ↓
 *   AntigravityAdapter
 *       ↓
 *   REAL `agy` CLI (via NodeAntigravityProcessRunner, shell: false)
 *       ↓
 *   REAL isolated workspace (disposable test directory)
 *       ↓
 *   REAL file modification
 *       ↓
 *   RawExecutorOutcome (status: SUCCESS, untrusted)
 *       ↓
 *   Independent SystemEvidenceCollector (Git state + scope + acceptance check)
 *       ↓
 *   SystemExecutionEvidence (verificationDecision: ACCEPT)
 *       ↓
 *   ExecutionStateIntegrator
 *       ↓
 *   DurableStateManager / SpecStore / HistoryManager
 *       ↓
 *   Task ACCEPTED
 *
 * Also verifies negative proofs:
 * - Executor SUCCESS does NOT equal system ACCEPT (independent criteria failure -> REJECT -> task FAILED).
 * - Scope enforcement (forbidden file modification outside implementationScope -> REJECT).
 * - Security & context integrity (tampered hash, unauthorized execution, stale revision rejected).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';

import {
  type ExecutionRequest,
  type RawExecutorOutcome,
  type SystemExecutionEvidence,
  type ProjectDiscoveryReport,
  AntigravityAdapter,
  NodeAntigravityProcessRunner,
  FakeAntigravityProcessRunner,
  resolveAntigravityExecutable,
  DefaultGitPort,
  SystemEvidenceCollector,
  ExecutionStateIntegrator,
  DurableStateManager,
  SpecStore,
  HistoryManager,
  ApprovalStore,
  ApprovalPackageEngine,
  HumanApprovalEngine,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  DirectorContextSynchronizer,
  InitialProjectUnderstandingBuilder,
  ExecutionAuthorizer,
  ExecutionRequestBuilder,
  ExecutorGuard,
  TaskDagEngine,
  DefaultMcpOrchestratorDelegate,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  computeDeterministicRequestId,
  assertNotVerifiedEvidence,
} from '../dist/index.js';

function createMockReport(workspaceRoot: string): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'test-p14-02-e2e-project',
      version: '1.0.0',
      workspaceRoot,
      ecosystem: 'Node.js',
      evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'Single task end-to-end real execution fixture',
      domainKeywords: ['e2e', 'execution'],
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'README.md' }],
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
      summary: 'Modular TypeScript architecture',
      architecturalPattern: 'Modular',
      identifiedAreas: [],
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/index.ts' }],
    },
    currentImplementationState: {
      lifecycleState: 'TASK_LOOP',
      hasActiveTask: false,
      isBlocked: false,
      totalTasksInDag: 1,
      completedTasksCount: 0,
      evidence: [{ sourceType: 'STATE_MANAGER', sourceIdentifier: 'durable-state.json' }],
    },
    unknowns: [],
    contradictions: [],
    evidenceInventory: [],
    generatedAt: new Date().toISOString(),
  };
}

function createParentFeature(): any {
  return {
    task_id: 'FEAT-P14-02',
    parent_feature_id: 'ROOT',
    title: 'Phase 14 Feature Parent',
    description: 'Feature parent node for P14-02',
    traceability_sources: ['REQ-001'],
    dependencies: [],
    acceptance_criteria: ['Feature completion'],
    status: TaskStatus.READY,
    attempt: 0,
    max_attempts: 1,
    priority: TaskPriority.HIGH,
    risk_level: RiskLevel.LOW,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    hierarchy_level: 'FEATURE',
    metadata: { revision: 1 },
  };
}

describe('Phase 14 TASK-P14-02: Single Task End-to-End Real Execution', () => {
  let tempDir: string;
  let specStore: SpecStore;
  let durableStateManager: DurableStateManager;
  let historyManager: HistoryManager;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let humanApprovalEngine: HumanApprovalEngine;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let synchronizer: DirectorContextSynchronizer;
  let authorizer: ExecutionAuthorizer;
  let requestBuilder: ExecutionRequestBuilder;
  let integrator: ExecutionStateIntegrator;
  let gitPort: DefaultGitPort;
  let collector: SystemEvidenceCollector;
  let delegate: DefaultMcpOrchestratorDelegate;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p14-02-e2e-'));

    // Initialize git repository in fixture
    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-test@example.com"', { cwd: tempDir, stdio: 'ignore' });

    // Create initial project files
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'greeting.ts'),
      'export const greeting = "initial_unmodified_value";\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-p14-02-e2e-project', version: '1.0.0' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# P14-02 E2E Test Project\n', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      '.ai-manager/\n.gemini/\n.agents/\n*.log\n',
      'utf8'
    );

    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

    // Initialize storage and engines
    specStore = new SpecStore({ baseDir: tempDir });
    durableStateManager = new DurableStateManager({ baseDir: tempDir });
    historyManager = new HistoryManager({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir });
    approvalPackageEngine = new ApprovalPackageEngine();
    sessionStore = new DirectorSessionStore({ baseDir: tempDir });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ baseDir: tempDir });

    humanApprovalEngine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      approvalStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      durableStateManager,
      historyManager,
    });
    delegate = new DefaultMcpOrchestratorDelegate();
    gitPort = new DefaultGitPort();

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      specStore,
      durableStateManager,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
    });

    authorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      delegate,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
      historyManager,
    });

    requestBuilder = new ExecutionRequestBuilder({
      workspaceRoot: tempDir,
      gitPort,
      specStore,
      authorizer,
      delegate,
    });

    collector = new SystemEvidenceCollector({
      gitPort,
      historyManager,
    });

    integrator = new ExecutionStateIntegrator({
      baseDir: tempDir,
      durableStateManager,
      specStore,
      historyManager,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows
    }
  });

  // ==========================================================================
  // 1. HAPPY PATH: COMPLETE REAL EXECUTION E2E
  // ==========================================================================
  it('1. completes full E2E execution through real agy CLI and integrates ACCEPT state', async () => {
    const resolution = resolveAntigravityExecutable();
    assert.strictEqual(resolution.found, true, 'Antigravity CLI executable must be available on host');
    assert.ok(resolution.executablePath);

    const projectId = 'test-p14-02-e2e-project';
    const taskId = 'TASK-P14-02-REAL';

    // 1. Setup Director Session & Context Snapshot
    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-02-001',
      understandingRevision: 1,
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    // 2. Setup Approval Package with Explicit Product Owner Approval
    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, {
      packageId: 'pkg-p14-02-001',
    });
    await approvalStore.savePackage(pkg);

    const approvalResult = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'po-lead',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for real P14-02 execution',
    });
    assert.strictEqual(approvalResult.isDevelopmentAuthorized, true);
    pkg = approvalResult.package;

    // 3. Register Director Decision
    const decision = {
      decisionId: `dec-p14-02-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Approved for real P14-02 execution',
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      basedOnApprovalRevision: pkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);

    // 4. Register Task in SpecStore in READY status
    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-02',
        title: 'Single Task Real Execution E2E',
        description: 'Modify src/greeting.ts to export greeting = "verified_real_execution"',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['src/greeting.ts must export greeting with value "verified_real_execution"'],
        tags: ['p14-02', 'real-exec'],
        traceability_sources: ['REQ-001'],
        assigned_to: 'antigravity',
        estimated_complexity: 'LOW',
        risk_level: RiskLevel.LOW,
        attempt: 0,
        max_attempts: 1,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK',
        metadata: {
          revision: 1,
          targetFiles: ['src/greeting.ts'],
          implementationScope: ['src/greeting.ts'],
        },
      },
    ]);

    // 5. Authorize Execution Intent
    const authorizationResult = await authorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      directorDecisionId: decision.decisionId,
      taskId,
      taskRevision: 1,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: pkg.revision,
      operationType: 'IMPLEMENT_TASK',
    });
    assert.strictEqual(authorizationResult.isValid, true);
    assert.ok(authorizationResult.intent);

    // 6. Build Deterministic Execution Request with Authoritative Context Package
    const request = await requestBuilder.buildExecutionRequest({
      intent: authorizationResult.intent!,
      instruction: {
        objective: 'Modify src/greeting.ts to export greeting = "verified_real_execution"',
        targetFiles: ['src/greeting.ts'],
        acceptanceCriteria: ['src/greeting.ts must export greeting with value "verified_real_execution"'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: {
        timeoutMs: 30000,
        maxFileModifications: 5,
      },
    });
    assert.strictEqual(request.taskId, taskId);
    assert.strictEqual(request.taskRevision, 1);
    assert.strictEqual(request.operationType, 'IMPLEMENT_TASK');
    assert.ok(request.contextPackage);
    assert.ok(request.contextPackage.packageId);

    // 7. Validate via ExecutorGuard
    const validatedRequest = ExecutorGuard.validateExecutionPreconditions(request, {
      workingDirectory: tempDir,
    });
    assert.strictEqual(validatedRequest.requestId, request.requestId);

    // 8. Execute through AntigravityAdapter with REAL NodeAntigravityProcessRunner
    const adapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      binaryPath: resolution.executablePath!,
      processRunner: new NodeAntigravityProcessRunner(),
      skipCompatibilityProbe: false,
    });

    const initialContent = fs.readFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'utf8');
    assert.ok(initialContent.includes('initial_unmodified_value'));

    const rawOutcome = await adapter.execute(validatedRequest);

    // Verify raw outcome lifecycle
    assertNotVerifiedEvidence(rawOutcome);
    assert.strictEqual(rawOutcome.status, 'SUCCESS');
    assert.strictEqual(rawOutcome.exitCode, 0);
    assert.ok(rawOutcome.durationMs > 0);
    assert.strictEqual(rawOutcome.requestBinding.requestId, request.requestId);

    // 9. Verify on-disk file change
    const updatedContent = fs.readFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'utf8');
    assert.notStrictEqual(updatedContent, initialContent);
    assert.ok(
      updatedContent.includes('verified_real_execution'),
      `Expected file content to include 'verified_real_execution', found: "${updatedContent}"`
    );

    // Verify git detected change
    const postGitState = await gitPort.inspectState(tempDir);
    assert.strictEqual(postGitState.working_tree_clean, false);
    const hasGreetingModified = postGitState.unstaged_changes.some((p) => p.includes('greeting.ts'));
    assert.strictEqual(hasGreetingModified, true, 'Git must detect greeting.ts modification');

    // 10. Independent Evidence Collection
    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
    });
    assert.strictEqual(evidence.verificationDecision, 'ACCEPT');
    assert.strictEqual(evidence.requestId, request.requestId);
    assert.strictEqual(evidence.taskId, taskId);

    // Check verification checks
    const bindingCheck = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_REQUEST_BINDING');
    assert.strictEqual(bindingCheck?.status, 'PASS');
    const pathCheck = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_PATH_SAFETY');
    assert.strictEqual(pathCheck?.status, 'PASS');

    // 11. State Integration
    const integrationOutcome = await integrator.integrate(evidence);
    assert.strictEqual(integrationOutcome.success, true);
    assert.strictEqual(integrationOutcome.taskStatus, TaskStatus.ACCEPTED);
    assert.strictEqual(integrationOutcome.verificationDecision, 'ACCEPT');

    // 12. Verify Authoritative SpecStore Updated
    const specTasks = await specStore.loadTasks();
    const finalTask = specTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(finalTask?.status, TaskStatus.ACCEPTED);

    // 13. Verify History Recorded
    const historyEvents = await historyManager.readEvents();
    const integratedEvent = historyEvents.find(
      (e) => e.taskId === taskId && e.eventType === 'EXECUTION_STATE_INTEGRATED'
    );
    assert.ok(integratedEvent, 'History must record EXECUTION_STATE_INTEGRATED event');

    // 14. Idempotency Check: repeated integration does not duplicate state
    const repeatedOutcome = await integrator.integrate(evidence);
    assert.strictEqual(repeatedOutcome.success, true);
    assert.strictEqual(repeatedOutcome.isDuplicate, true);
    assert.strictEqual(repeatedOutcome.taskStatus, TaskStatus.ACCEPTED);
  });

  // ==========================================================================
  // 2. CONTROLLED NEGATIVE PROOF: EXECUTOR SUCCESS != SYSTEM ACCEPT
  // ==========================================================================
  it('2. proves executor SUCCESS does NOT produce ACCEPT when independent criteria verification fails', async () => {
    const projectId = 'test-p14-02-e2e-project';
    const taskId = 'TASK-P14-02-NEG-CRITERIA';

    // 1. Setup Director Session & Approval
    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-02-002',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, { packageId: 'pkg-p14-02-002' });
    await approvalStore.savePackage(pkg);

    const approvalResult = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'po-lead',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for negative verification',
    });
    pkg = approvalResult.package;

    const decision = {
      decisionId: `dec-p14-02-neg-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Approved for negative verification',
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      basedOnApprovalRevision: pkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);

    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-02',
        title: 'Negative Proof Task',
        description: 'Task where executor succeeds but verification criteria fails',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['src/greeting.ts must contain IMPOSSIBLE_UNMET_CRITERIA_TOKEN'],
        tags: ['negative-proof'],
        traceability_sources: ['REQ-001'],
        assigned_to: 'antigravity',
        estimated_complexity: 'LOW',
        risk_level: RiskLevel.LOW,
        attempt: 0,
        max_attempts: 1,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK',
        metadata: {
          revision: 1,
          targetFiles: ['src/greeting.ts'],
          implementationScope: ['src/greeting.ts'],
        },
      },
    ]);

    const authResult = await authorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      directorDecisionId: decision.decisionId,
      taskId,
      taskRevision: 1,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: pkg.revision,
      operationType: 'IMPLEMENT_TASK',
    });
    assert.strictEqual(authResult.isValid, true);

    const request = await requestBuilder.buildExecutionRequest({
      intent: authResult.intent!,
      instruction: {
        objective: 'Task where criteria will fail independently',
        targetFiles: ['src/greeting.ts'],
        acceptanceCriteria: ['src/greeting.ts must contain IMPOSSIBLE_UNMET_CRITERIA_TOKEN'],
      },
    });

    // Fabricate an executor outcome claiming SUCCESS
    const fakeRawOutcome: RawExecutorOutcome = {
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'Executor completed successfully with 100% test pass claim',
      stderr: null,
      durationMs: 500,
      unverifiedAgentClaims: ['All acceptance criteria implemented successfully!'],
      unverifiedModifiedFiles: ['src/greeting.ts'],
      requestBinding: {
        requestId: request.requestId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
        projectId: request.projectId,
        directorSessionId: request.directorSessionId,
        directorDecisionId: request.directorDecisionId,
        contextFingerprint: request.contextFingerprint,
        understandingRevision: request.understandingRevision,
        approvalPackageRevision: request.approvalPackageRevision,
      },
    };

    // Independent verification collector evaluates against actual file system and criteria
    // The mandatory verification command fails
    const evidence = await collector.collectAndVerify(request, fakeRawOutcome, {
      workingDirectory: tempDir,
      verificationCommands: [
        {
          id: 'CMD_VERIFY_TOKEN',
          type: 'TEST',
          command: 'node -e "process.exit(1)"', // Fails verification command
          mandatory: true,
        },
      ],
    });

    // CRITICAL PROOF: Executor reported SUCCESS, but evidence collector independently REJECTS!
    assert.strictEqual(evidence.verificationDecision, 'REJECT');

    // Integration must NOT accept task
    const integrationOutcome = await integrator.integrate(evidence);
    assert.strictEqual(integrationOutcome.taskStatus, TaskStatus.REJECTED);
    assert.notStrictEqual(integrationOutcome.taskStatus, TaskStatus.ACCEPTED);

    const specTasks = await specStore.loadTasks();
    const taskInStore = specTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(taskInStore?.status, TaskStatus.REJECTED);
  });

  // ==========================================================================
  // 3. SCOPE ENFORCEMENT: MODIFICATION OUTSIDE SCOPE REJECTED
  // ==========================================================================
  it('3. rejects task acceptance when executor modifies a file outside allowed implementationScope', async () => {
    const projectId = 'test-p14-02-e2e-project';
    const taskId = 'TASK-P14-02-SCOPE-LEAK';

    // 1. Setup Director Session & Approval
    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-02-003',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, { packageId: 'pkg-p14-02-003' });
    await approvalStore.savePackage(pkg);

    const approvalResult = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'po-lead',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for scope leak testing',
    });
    pkg = approvalResult.package;

    const decision = {
      decisionId: `dec-p14-02-scope-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Approved for scope leak testing',
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      basedOnApprovalRevision: pkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);

    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-02',
        title: 'Scope Enforcement Task',
        description: 'Task with strict targetFiles and implementationScope',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['Strictly modify src/greeting.ts only'],
        tags: ['scope-test'],
        traceability_sources: ['REQ-001'],
        assigned_to: 'antigravity',
        estimated_complexity: 'LOW',
        risk_level: RiskLevel.LOW,
        attempt: 0,
        max_attempts: 1,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK',
        metadata: {
          revision: 1,
          targetFiles: ['src/greeting.ts'],
          implementationScope: ['src/greeting.ts'],
        },
      },
    ]);

    const authResult = await authorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      directorDecisionId: decision.decisionId,
      taskId,
      taskRevision: 1,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: pkg.revision,
      operationType: 'IMPLEMENT_TASK',
    });
    assert.strictEqual(authResult.isValid, true);

    const request = await requestBuilder.buildExecutionRequest({
      intent: authResult.intent!,
      instruction: {
        objective: 'Task with strict scope',
        targetFiles: ['src/greeting.ts'],
        implementationScope: ['src/greeting.ts'],
      },
    });

    // Modify a forbidden file on disk outside scope: package.json
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"modified":"forbidden"}\n', 'utf8');

    // Also modify the allowed target file
    fs.writeFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'export const greeting = "modified";\n', 'utf8');

    const rawOutcome: RawExecutorOutcome = {
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'Completed',
      stderr: null,
      durationMs: 300,
      unverifiedAgentClaims: ['Modified greeting.ts and package.json'],
      unverifiedModifiedFiles: ['src/greeting.ts', 'package.json'],
      requestBinding: {
        requestId: request.requestId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
        projectId: request.projectId,
        directorSessionId: request.directorSessionId,
        directorDecisionId: request.directorDecisionId,
        contextFingerprint: request.contextFingerprint,
        understandingRevision: request.understandingRevision,
        approvalPackageRevision: request.approvalPackageRevision,
      },
    };

    // Evidence collector independently detects package.json change via Git!
    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
    });

    // Verification must FAIL on scope check
    const scopeCheck = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_IMPLEMENTATION_SCOPE');
    assert.strictEqual(scopeCheck?.status, 'FAIL');
    assert.ok(scopeCheck?.evidence.includes('package.json'));

    assert.strictEqual(evidence.verificationDecision, 'REJECT');

    const integrationOutcome = await integrator.integrate(evidence);
    assert.strictEqual(integrationOutcome.taskStatus, TaskStatus.REJECTED);
    assert.notStrictEqual(integrationOutcome.taskStatus, TaskStatus.ACCEPTED);

    const specTasks = await specStore.loadTasks();
    const taskInStore = specTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(taskInStore?.status, TaskStatus.REJECTED);
  });

  // ==========================================================================
  // 4. SECURITY & CONTEXT INTEGRITY BOUNDARIES
  // ==========================================================================
  it('4. strictly rejects unauthorized execution or forged context at each boundary layer', async () => {
    const projectId = 'test-p14-02-e2e-project';
    const taskId = 'TASK-P14-02-SECURITY';

    // 1. Unapproved task is rejected by ExecutionAuthorizer
    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-02',
        title: 'Unauthorized Task',
        description: 'Task without PO approval',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['Must reject without approval'],
        tags: ['security'],
        traceability_sources: ['REQ-001'],
        assigned_to: 'antigravity',
        estimated_complexity: 'LOW',
        risk_level: RiskLevel.LOW,
        attempt: 0,
        max_attempts: 1,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK',
        metadata: { revision: 1, targetFiles: ['src/greeting.ts'] },
      },
    ]);

    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-02-004',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    const unapprovedResult = await authorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: session.directorSessionId,
      directorDecisionId: 'dec-nonexistent',
      taskId,
      taskRevision: 1,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
    });
    assert.strictEqual(unapprovedResult.isValid, false);
    assert.ok(unapprovedResult.message || unapprovedResult.code);

    // 2. ExecutorGuard rejects forged request ID
    const fakeRequest: any = {
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: 'req-' + '0'.repeat(64),
      projectId,
      taskId,
      taskRevision: 1,
      directorSessionId: session.directorSessionId,
      directorDecisionId: 'dec-fake',
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Test forged hash rejection',
        acceptanceCriteria: ['Should fail'],
        constraints: [],
        targetFiles: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: '1111222233334444555566667777888899990000', isClean: true },
    };

    assert.throws(
      () => ExecutorGuard.validateExecutionPreconditions(fakeRequest, { workingDirectory: tempDir }),
      /hash mismatch|tampered/i
    );

    // 3. ExecutorGuard rejects path traversal in targetFiles
    const validId = computeDeterministicRequestId({
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      projectId,
      taskId,
      taskRevision: 1,
      directorSessionId: session.directorSessionId,
      directorDecisionId: 'dec-fake',
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Test traversal rejection',
        acceptanceCriteria: ['Should fail'],
        constraints: [],
        targetFiles: ['../outside.txt'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: '1111222233334444555566667777888899990000', isClean: true },
    });

    const traversalRequest = {
      ...fakeRequest,
      requestId: validId,
      instruction: {
        ...fakeRequest.instruction,
        targetFiles: ['../outside.txt'],
      },
    };

    assert.throws(
      () => ExecutorGuard.validateExecutionPreconditions(traversalRequest, { workingDirectory: tempDir }),
      /traversal|unsafe path/i
    );
  });
});
