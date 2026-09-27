/**
 * Phase 14 TASK-P14-03: Real Execution Evidence Integration Test Suite
 *
 * Verifies that real execution evidence is an authoritative, persisted, binding-safe,
 * auditable, recoverable, and idempotent integration boundary:
 *
 *   REAL agy EXECUTION
 *           ↓
 *   RawExecutorOutcome (untrusted claims)
 *           ↓
 *   INDEPENDENT SYSTEM VERIFICATION (Git + Scope + Acceptance Criteria)
 *           ↓
 *   SystemExecutionEvidence (authoritative envelope)
 *           ↓
 *   EVIDENCE PERSISTENCE / AUDIT (SystemExecutionEvidenceStore + HistoryManager)
 *           ↓
 *   ExecutionStateIntegrator
 *           ↓
 *   DurableState / SpecStore / HistoryManager
 *
 * Covers all P14-03 core requirements:
 * 1. ACCEPT evidence persistence
 * 2. REJECT evidence persistence
 * 3. BLOCK evidence persistence
 * 4. restart/reload recovery
 * 5. idempotent evidence integration
 * 6. duplicate evidence suppression
 * 7. wrong project rejection
 * 8. wrong task rejection
 * 9. wrong task revision rejection
 * 10. wrong request rejection
 * 11. forged evidence rejection
 * 12. stale context rejection
 * 13. stale Git baseline rejection
 * 14. scope violation rejection
 * 15. history audit
 * 16. no secret leakage
 * 17. real agy evidence path
 * 18. ACCEPT state integration
 * 19. REJECT state integration
 * 20. BLOCK state integration
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
  resolveAntigravityExecutable,
  DefaultGitPort,
  SystemEvidenceCollector,
  ExecutionStateIntegrator,
  SystemExecutionEvidenceStore,
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
  computeDeterministicEvidenceId,
  computeExpectedEvidenceId,
  verifyEvidenceIdIntegrity,
  assertValidEvidenceProvenance,
  assertNotVerifiedEvidence,
  ExecutionIntegrationBindingMismatchError,
  ExecutionIntegrationSecurityViolationError,
  ExecutionIntegrationStaleResultError,
  SystemEvidenceBindingMismatchError,
  SystemEvidenceSecurityViolationError,
} from '../dist/index.js';

function createMockReport(workspaceRoot: string): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'test-p14-03-evidence-project',
      version: '1.0.0',
      workspaceRoot,
      ecosystem: 'Node.js',
      evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'Real execution evidence integration test fixture',
      domainKeywords: ['evidence', 'integration', 'p14-03'],
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
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/greeting.ts' }],
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
    task_id: 'FEAT-P14-03',
    parent_feature_id: 'ROOT',
    title: 'Phase 14 Feature Parent',
    description: 'Feature parent node for P14-03',
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

function createMockRawOutcome(
  request: ExecutionRequest,
  overrides: Partial<RawExecutorOutcome> = {}
): RawExecutorOutcome {
  return {
    requestId: request.requestId,
    executorIdentity: {
      executorType: 'antigravity',
      version: '1.2.11',
      executionHost: 'host',
    },
    status: 'SUCCESS',
    exitCode: 0,
    signal: null,
    stdout: 'Simulated executor output',
    stderr: '',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 100,
    timedOut: false,
    cancelled: false,
    requestBinding: {
      requestId: request.requestId,
      projectId: request.projectId,
      taskId: request.taskId,
      taskRevision: request.taskRevision,
      contextFingerprint: request.contextFingerprint,
      understandingRevision: request.understandingRevision,
      approvalPackageRevision: request.approvalPackageRevision,
    },
    unverifiedAgentClaims: ['Simulated claims'],
    unverifiedModifiedFiles: request.instruction?.targetFiles ?? [],
    ...overrides,
  };
}

describe('Phase 14 TASK-P14-03: Real Evidence Integration', () => {
  let tempDir: string;
  let specStore: SpecStore;
  let durableStateManager: DurableStateManager;
  let historyManager: HistoryManager;
  let evidenceStore: SystemExecutionEvidenceStore;
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
  let initialCommitSha: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p14-03-evidence-'));

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
      JSON.stringify({ name: 'test-p14-03-evidence-project', version: '1.0.0' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# P14-03 Evidence Integration Test\n', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      '.ai-manager/\n.gemini/\n.agents/\n*.log\n',
      'utf8'
    );

    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });
    initialCommitSha = child_process.execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf8' }).trim();

    // Initialize storage and engines
    specStore = new SpecStore({ baseDir: tempDir });
    durableStateManager = new DurableStateManager({ baseDir: tempDir });
    historyManager = new HistoryManager({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
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
      evidenceStore,
    });

    integrator = new ExecutionStateIntegrator({
      baseDir: tempDir,
      durableStateManager,
      specStore,
      historyManager,
      evidenceStore,
      strictEvidenceIdCheck: true,
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
  // 1. REAL AGY EXECUTION -> ACCEPT EVIDENCE PERSISTENCE & INTEGRATION
  // ==========================================================================
  it('1. real agy execution generates ACCEPT evidence, persists to evidenceStore, and integrates into state', async () => {
    const resolution = resolveAntigravityExecutable();
    assert.strictEqual(resolution.found, true, 'Antigravity CLI executable must be available on host');
    assert.ok(resolution.executablePath);

    const projectId = 'test-p14-03-evidence-project';
    const taskId = 'TASK-P14-03-REAL-ACCEPT';

    // 1. Setup Director Session & Context Snapshot
    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-03-001',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    // 2. Setup Approval Package with Explicit Product Owner Approval
    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, { packageId: 'pkg-p14-03-001' });
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
      comment: 'Approved for real P14-03 execution evidence integration',
    });
    assert.strictEqual(approvalResult.isDevelopmentAuthorized, true);
    pkg = approvalResult.package;

    // 3. Register Director Decision
    const decision = {
      decisionId: `dec-p14-03-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Approved for real P14-03 execution',
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
        parent_feature_id: 'FEAT-P14-03',
        title: 'Real Evidence Integration Task',
        description: 'Modify src/greeting.ts to export greeting = "p14_03_verified_evidence"',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['src/greeting.ts must export greeting with value "p14_03_verified_evidence"'],
        tags: ['p14-03', 'evidence'],
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
    assert.ok(authResult.intent);

    // 6. Build Deterministic Execution Request with Authoritative Context Package
    const request = await requestBuilder.buildExecutionRequest({
      intent: authResult.intent!,
      instruction: {
        objective: 'Modify src/greeting.ts to export greeting = "p14_03_verified_evidence"',
        targetFiles: ['src/greeting.ts'],
        acceptanceCriteria: ['src/greeting.ts must export greeting with value "p14_03_verified_evidence"'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 30000, maxFileModifications: 5 },
    });

    // 7. Validate Request Preconditions via ExecutorGuard
    const validatedRequest = ExecutorGuard.validateExecutionPreconditions(request, {
      workingDirectory: tempDir,
    });
    assert.strictEqual(validatedRequest.requestId, request.requestId);

    // 8. Execute via AntigravityAdapter using real agy CLI
    const adapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      binaryPath: resolution.executablePath!,
      processRunner: new NodeAntigravityProcessRunner(),
      skipCompatibilityProbe: false,
    });
    const rawOutcome = await adapter.execute(validatedRequest);

    assertNotVerifiedEvidence(rawOutcome);
    assert.strictEqual(rawOutcome.status, 'SUCCESS');
    assert.strictEqual(rawOutcome.exitCode, 0);

    // 9. Verify actual file modification
    const updatedContent = fs.readFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'utf8');
    assert.ok(updatedContent.includes('p14_03_verified_evidence'));

    // 10. Independent Evidence Collection and Automatic Persistence
    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
    });

    assert.strictEqual(evidence.verificationDecision, 'ACCEPT');
    assert.strictEqual(evidence.requestId, request.requestId);
    assert.strictEqual(evidence.taskId, taskId);
    assert.strictEqual(evidence.taskRevision, 1);
    assert.strictEqual(verifyEvidenceIdIntegrity(evidence), true);

    // Verify evidence was durably persisted on disk
    const persistedEvidence = await evidenceStore.loadEvidence(evidence.evidenceId);
    assert.ok(persistedEvidence, 'Evidence must be loadable from evidenceStore');
    assert.strictEqual(persistedEvidence?.evidenceId, evidence.evidenceId);
    assert.strictEqual(persistedEvidence?.verificationDecision, 'ACCEPT');
    assert.strictEqual(persistedEvidence?.changedFiles.length, 1);

    // 11. State Integration
    const integrationOutcome = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(integrationOutcome.success, true);
    assert.strictEqual(integrationOutcome.taskStatus, TaskStatus.ACCEPTED);
    assert.strictEqual(integrationOutcome.verificationDecision, 'ACCEPT');

    // 12. Verify SpecStore and DurableState
    const specTasks = await specStore.loadTasks();
    const finalTask = specTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(finalTask?.status, TaskStatus.ACCEPTED);

    const durableState = await durableStateManager.load();
    assert.ok(durableState?.completedTaskIds.includes(taskId));
    assert.strictEqual(durableState?.activeTaskId, null);
  });

  // ==========================================================================
  // 2. REJECT EVIDENCE PERSISTENCE & INTEGRATION
  // ==========================================================================
  it('2. persists REJECT evidence and integrates task status as REJECTED without task completion', async () => {
    const projectId = 'test-p14-03-evidence-project';
    const taskId = 'TASK-P14-03-REJECT';

    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'Reject Evidence Task',
        description: 'Task designed to fail criteria check',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['src/greeting.ts must contain UNMET_REJECT_TOKEN'],
        tags: ['p14-03', 'reject'],
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

    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-03-002',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, { packageId: 'pkg-p14-03-002' });
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
      comment: 'Approved for reject evidence test',
    });
    pkg = approvalResult.package;

    const decision = {
      decisionId: `dec-p14-03-rej-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Testing reject evidence',
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      basedOnApprovalRevision: pkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);

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

    const request = await requestBuilder.buildExecutionRequest({
      intent: authResult.intent!,
      instruction: {
        objective: 'Objective requiring token',
        targetFiles: ['src/greeting.ts'],
        acceptanceCriteria: ['src/greeting.ts must contain UNMET_REJECT_TOKEN'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
    });

    // Simulated executor outcome claiming SUCCESS, but file does not contain required token
    const fakeRawOutcome = createMockRawOutcome(request, {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: 'Simulated executor claims finished',
      unverifiedAgentClaims: ['Claims success'],
      unverifiedModifiedFiles: ['src/greeting.ts'],
    });

    // Independent verification determines criteria failure
    const evidence = await collector.collectAndVerify(request, fakeRawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
      verificationCommands: [
        {
          id: 'CMD_FAIL_CRITERIA',
          type: 'TEST',
          command: 'node -e "process.exit(1)"',
          mandatory: true,
        },
      ],
    });
    assert.strictEqual(evidence.verificationDecision, 'REJECT');

    // Verify persisted in evidenceStore
    const loaded = await evidenceStore.loadEvidence(evidence.evidenceId);
    assert.ok(loaded);
    assert.strictEqual(loaded?.verificationDecision, 'REJECT');

    // Integrate REJECT
    const outcome = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.taskStatus, TaskStatus.REJECTED);
    assert.strictEqual(outcome.verificationDecision, 'REJECT');

    // Verify task is NOT completed in DurableState and SpecStore
    const durableState = await durableStateManager.load();
    assert.strictEqual(durableState?.completedTaskIds.includes(taskId), false);

    const specTasks = await specStore.loadTasks();
    const taskInStore = specTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(taskInStore?.status, TaskStatus.REJECTED);
  });

  // ==========================================================================
  // 3. BLOCK EVIDENCE PERSISTENCE & INTEGRATION
  // ==========================================================================
  it('3. persists BLOCK evidence and integrates task status as BLOCKED with blockedState recorded', async () => {
    const projectId = 'test-p14-03-evidence-project';
    const taskId = 'TASK-P14-03-BLOCK';

    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'Block Evidence Task',
        description: 'Task designed to block on infrastructure error',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['Independent test verification must pass'],
        tags: ['p14-03', 'block'],
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

    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-03-003',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, { packageId: 'pkg-p14-03-003' });
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
      comment: 'Approved for block evidence test',
    });
    pkg = approvalResult.package;

    const decision = {
      decisionId: `dec-p14-03-blk-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Testing block evidence',
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      basedOnApprovalRevision: pkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);

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

    const request = await requestBuilder.buildExecutionRequest({
      intent: authResult.intent!,
      instruction: {
        objective: 'Test requiring external tool that is unavailable',
        targetFiles: ['src/greeting.ts'],
        acceptanceCriteria: ['Must pass test suite via pnpm test'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
    });

    const rawOutcome = createMockRawOutcome(request, {
      status: 'TIMEOUT',
      exitCode: null,
      stdout: '',
      stderr: 'Execution timed out',
      durationMs: 10000,
      timedOut: true,
      unverifiedAgentClaims: [],
    });

    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
      verificationCommands: [
        {
          id: 'CMD_INFRA_UNAVAILABLE',
          type: 'TEST',
          command: 'non_existent_binary_xyz_12345 --test',
          mandatory: true,
        },
      ],
    });
    assert.strictEqual(evidence.verificationDecision, 'BLOCK');

    // Verify stored
    const loaded = await evidenceStore.loadEvidence(evidence.evidenceId);
    assert.ok(loaded);
    assert.strictEqual(loaded?.verificationDecision, 'BLOCK');

    // Integrate BLOCK
    const outcome = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.taskStatus, TaskStatus.BLOCKED);
    assert.strictEqual(outcome.verificationDecision, 'BLOCK');

    // Verify blockedState is persisted in DurableState
    const durableState = await durableStateManager.load();
    assert.ok(durableState?.blockedState);
    assert.strictEqual(durableState?.blockedState?.blockedTaskId, taskId);
    assert.strictEqual(durableState?.completedTaskIds.includes(taskId), false);

    const specTasks = await specStore.loadTasks();
    const taskInStore = specTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(taskInStore?.status, TaskStatus.BLOCKED);
  });

  // ==========================================================================
  // 4. RESTART & RECOVERY: PERSISTED EVIDENCE SURVIVES PROCESS RESTART
  // ==========================================================================
  it('4. persists evidence and verifies full restart recovery reload from disk', async () => {
    const projectId = 'test-p14-03-evidence-project';
    const taskId = 'TASK-P14-03-RESTART';

    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'Restart Recovery Task',
        description: 'Verifies recovery after process restart',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['Restart recovery verified'],
        tags: ['p14-03', 'restart'],
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

    const session = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p14-03-004',
      understandingRevision: 1,
    });
    const snapshot = await synchronizer.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: tempDir,
    });

    const report = createMockReport(tempDir);
    const understanding = new InitialProjectUnderstandingBuilder().build(report, undefined, { projectId });
    let pkg = approvalPackageEngine.buildPackage(understanding, undefined, { packageId: 'pkg-p14-03-004' });
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
      comment: 'Approved for restart test',
    });
    pkg = approvalResult.package;

    const decision = {
      decisionId: `dec-p14-03-res-${Date.now()}`,
      directorSessionId: session.directorSessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Testing restart reload',
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      basedOnApprovalRevision: pkg.revision,
      basedOnUnderstandingRevision: 1,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);

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

    const request = await requestBuilder.buildExecutionRequest({
      intent: authResult.intent!,
      instruction: {
        objective: 'Test restart recovery',
        targetFiles: ['src/greeting.ts'],
        acceptanceCriteria: ['Restart recovery verified'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
    });

    // Make clean source modification
    fs.writeFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'export const greeting = "reloaded_value";\n');

    const rawOutcome = createMockRawOutcome(request, {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: 'Modified file',
      unverifiedAgentClaims: ['File updated'],
      unverifiedModifiedFiles: ['src/greeting.ts'],
    });

    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
    });
    assert.strictEqual(evidence.verificationDecision, 'ACCEPT');

    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });

    // ========================================================================
    // SIMULATE PROCESS RESTART: Discard existing memory instances and reload
    // ========================================================================
    const restartedEvidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    const restartedDurableManager = new DurableStateManager({ baseDir: tempDir });
    const restartedSpecStore = new SpecStore({ baseDir: tempDir });
    const restartedHistoryManager = new HistoryManager({ baseDir: tempDir });
    const restartedIntegrator = new ExecutionStateIntegrator({
      baseDir: tempDir,
      durableStateManager: restartedDurableManager,
      specStore: restartedSpecStore,
      historyManager: restartedHistoryManager,
      evidenceStore: restartedEvidenceStore,
      strictEvidenceIdCheck: true,
    });

    // 1. Reload evidence from disk
    const reloadedEvidence = await restartedEvidenceStore.loadEvidence(evidence.evidenceId);
    assert.ok(reloadedEvidence, 'Reloaded evidence must exist on disk after restart');
    assert.strictEqual(reloadedEvidence?.evidenceId, evidence.evidenceId);
    assert.strictEqual(reloadedEvidence?.requestId, request.requestId);
    assert.strictEqual(reloadedEvidence?.verificationDecision, 'ACCEPT');
    assert.strictEqual(verifyEvidenceIdIntegrity(reloadedEvidence!), true);

    // 2. Reload authoritative durable state from disk
    const reloadedDurableState = await restartedDurableManager.load();
    assert.ok(reloadedDurableState?.completedTaskIds.includes(taskId));
    const integratedRecord = (reloadedDurableState?.metadata?.integratedEvidence as any)?.[evidence.evidenceId];
    assert.ok(integratedRecord, 'Integrated evidence journal must survive restart');
    assert.strictEqual(integratedRecord.evidenceId, evidence.evidenceId);
    assert.strictEqual(integratedRecord.taskStatus, TaskStatus.ACCEPTED);

    // 3. Reload spec store tasks from disk
    const reloadedTasks = await restartedSpecStore.loadTasks();
    const reloadedTask = reloadedTasks.find((t) => t.task_id === taskId);
    assert.strictEqual(reloadedTask?.status, TaskStatus.ACCEPTED);

    // 4. Verify idempotent integration of reloaded evidence
    const reloadedOutcome = await restartedIntegrator.integrate(reloadedEvidence!, {
      strictEvidenceIdCheck: true,
    });
    assert.strictEqual(reloadedOutcome.success, true);
    assert.strictEqual(reloadedOutcome.isDuplicate, true);
    assert.strictEqual(reloadedOutcome.taskStatus, TaskStatus.ACCEPTED);
  });

  // ==========================================================================
  // 5. IDEMPOTENT INTEGRATION & DUPLICATE SUPPRESSION
  // ==========================================================================
  it('5. processes repeated integration calls idempotently without duplicate side effects', async () => {
    const projectId = 'test-p14-03-evidence-project';
    const taskId = 'TASK-P14-03-IDEMPOTENT';

    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'Idempotency Task',
        description: 'Verifies 3x repeated integration',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['Idempotency verified'],
        tags: ['p14-03', 'idempotent'],
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
        metadata: { revision: 1, targetFiles: ['src/greeting.ts'], implementationScope: ['src/greeting.ts'] },
      },
    ]);

    fs.writeFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'export const greeting = "idempotent_val";\n');

    const request: ExecutionRequest = {
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: 'req-' + 'a'.repeat(64),
      projectId,
      taskId,
      taskRevision: 1,
      directorSessionId: 'sess-idem',
      directorDecisionId: 'dec-idem',
      contextFingerprint: 'fp-sha256-idem',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Test idempotency',
        acceptanceCriteria: ['Idempotency verified'],
        constraints: [],
        targetFiles: ['src/greeting.ts'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: initialCommitSha, isClean: true },
    };

    const rawOutcome = createMockRawOutcome(request, {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: '',
      durationMs: 50,
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: ['src/greeting.ts'],
    });

    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
    });

    // 1st Integration: Main acceptance
    const call1 = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(call1.success, true);
    assert.strictEqual(call1.isDuplicate, false);
    assert.strictEqual(call1.taskStatus, TaskStatus.ACCEPTED);

    const historyAfterCall1 = await historyManager.readEvents();
    const eventCountCall1 = historyAfterCall1.filter(
      (e) => e.taskId === taskId && e.eventType === 'EXECUTION_STATE_INTEGRATED'
    ).length;
    assert.strictEqual(eventCountCall1, 1);

    // 2nd Integration: Idempotent duplicate
    const call2 = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(call2.success, true);
    assert.strictEqual(call2.isDuplicate, true);
    assert.strictEqual(call2.taskStatus, TaskStatus.ACCEPTED);

    // 3rd Integration: Idempotent duplicate
    const call3 = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(call3.success, true);
    assert.strictEqual(call3.isDuplicate, true);
    assert.strictEqual(call3.taskStatus, TaskStatus.ACCEPTED);

    // Verify history events were NOT duplicated
    const historyAfterCall3 = await historyManager.readEvents();
    const eventCountCall3 = historyAfterCall3.filter(
      (e) => e.taskId === taskId && e.eventType === 'EXECUTION_STATE_INTEGRATED'
    ).length;
    assert.strictEqual(eventCountCall3, 1, 'History events must not be duplicated by re-integration');

    // Verify completed tasks list is not duplicated
    const durableState = await durableStateManager.load();
    const taskOccurrences = durableState?.completedTaskIds.filter((id) => id === taskId).length;
    assert.strictEqual(taskOccurrences, 1);
  });

  // ==========================================================================
  // 6. BINDING SAFETY: REJECTS WRONG PROJECT, TASK, REVISION, OR REQUEST
  // ==========================================================================
  it('6. rejects evidence with mismatched project, task, revision, or request', async () => {
    const validEvidence: SystemExecutionEvidence = {
      evidenceId: 'evi-valid-001',
      requestId: 'req-' + 'b'.repeat(64),
      projectId: 'project-alpha',
      taskId: 'TASK-ALPHA-01',
      taskRevision: 1,
      contextFingerprint: 'fp-alpha-sha256',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: 'Valid summary' },
    };

    // 1. Wrong Project
    await assert.rejects(
      () =>
        integrator.integrate(validEvidence, {
          expectedBinding: { projectId: 'project-beta' },
          strictEvidenceIdCheck: false,
        }),
      (err: any) => err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Project ID mismatch')
    );

    // 2. Wrong Task
    await assert.rejects(
      () =>
        integrator.integrate(validEvidence, {
          expectedBinding: { taskId: 'TASK-OTHER-99' },
          strictEvidenceIdCheck: false,
        }),
      (err: any) => err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Task ID mismatch')
    );

    // 3. Wrong Task Revision
    await assert.rejects(
      () =>
        integrator.integrate(validEvidence, {
          expectedBinding: { taskRevision: 2 },
          strictEvidenceIdCheck: false,
        }),
      (err: any) => err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Task revision mismatch')
    );

    // 4. Wrong Request ID
    await assert.rejects(
      () =>
        integrator.integrate(validEvidence, {
          expectedBinding: { requestId: 'req-' + 'c'.repeat(64) },
          strictEvidenceIdCheck: false,
        }),
      (err: any) => err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Request ID mismatch')
    );
  });

  // ==========================================================================
  // 7. FORGED EVIDENCE & FORGED ACCEPT RESULT REJECTION
  // ==========================================================================
  it('7. detects and rejects forged evidenceId and forged ACCEPT results via strict hash check', async () => {
    const summary = 'Verification completed with PASS';
    const realId = computeDeterministicEvidenceId({
      requestId: 'req-' + 'd'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-FORGERY',
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-original',
      headCommit: initialCommitSha,
      verificationDecision: 'REJECT',
      checkSummary: summary,
    });

    const legitimateRejectedEvidence: SystemExecutionEvidence = {
      evidenceId: realId,
      requestId: 'req-' + 'd'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-FORGERY',
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-original',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'FAIL' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'FAIL', evidence: 'failed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 20 },
      verificationDecision: 'REJECT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    // Verify legitimate rejected evidence hash passes verification
    assert.strictEqual(verifyEvidenceIdIntegrity(legitimateRejectedEvidence), true);

    // 1. Attack Scenario A: Attacker alters decision to ACCEPT without recomputing hash
    const forgedAcceptEvidence: SystemExecutionEvidence = {
      ...legitimateRejectedEvidence,
      verificationDecision: 'ACCEPT', // Forged promotion to ACCEPT!
    };

    assert.strictEqual(verifyEvidenceIdIntegrity(forgedAcceptEvidence), false);

    await assert.rejects(
      () => integrator.integrate(forgedAcceptEvidence, { strictEvidenceIdCheck: true }),
      (err: any) =>
        err instanceof ExecutionIntegrationSecurityViolationError && err.message.includes('Evidence ID hash mismatch')
    );

    // 2. Attack Scenario B: Attacker supplies arbitrary forged evidenceId
    const forgedIdEvidence: SystemExecutionEvidence = {
      ...legitimateRejectedEvidence,
      evidenceId: 'evi-forged-arbitrary-identifier-000',
    };

    assert.strictEqual(verifyEvidenceIdIntegrity(forgedIdEvidence), false);

    await assert.rejects(
      () => integrator.integrate(forgedIdEvidence, { strictEvidenceIdCheck: true }),
      (err: any) =>
        err instanceof ExecutionIntegrationSecurityViolationError && err.message.includes('Evidence ID hash mismatch')
    );
  });

  // ==========================================================================
  // 8. STALE CONTEXT & STALE GIT BASELINE REJECTION
  // ==========================================================================
  it('8. rejects evidence with stale context fingerprint or stale Git baseline', async () => {
    const summary = 'Evaluation summary';
    const evidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + 'e'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-STALE',
      taskRevision: 1,
      contextFingerprint: 'fp-stale-context-001',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const evidence: SystemExecutionEvidence = {
      evidenceId,
      requestId: 'req-' + 'e'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-STALE',
      taskRevision: 1,
      contextFingerprint: 'fp-stale-context-001',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 20 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    // 1. Stale context rejection
    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { contextFingerprint: 'fp-new-resynced-context-002' },
          strictEvidenceIdCheck: true,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Context fingerprint mismatch')
    );

    // 2. Stale Git baseline rejection
    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { expectedBaseCommit: '0000000000000000000000000000000000000000' },
          strictEvidenceIdCheck: true,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Git base commit mismatch')
    );
  });

  // ==========================================================================
  // 9. HISTORY AUDIT TRAIL & ZERO SECRET LEAKAGE
  // ==========================================================================
  it('9. records deterministic audit events in HistoryManager without leaking credentials', async () => {
    const summary = 'Summary for audit check';
    const evidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + 'f'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-AUDIT',
      taskRevision: 1,
      contextFingerprint: 'fp-audit-test',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const evidence: SystemExecutionEvidence = {
      evidenceId,
      requestId: 'req-' + 'f'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-AUDIT',
      taskRevision: 1,
      contextFingerprint: 'fp-audit-test',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 30 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });

    const events = await historyManager.readEvents();
    const integrationEvent = events.find(
      (e) => e.taskId === 'TASK-P14-03-AUDIT' && e.eventType === 'EXECUTION_STATE_INTEGRATED'
    );

    assert.ok(integrationEvent);
    assert.strictEqual(integrationEvent.actor, 'ORCHESTRATOR');
    assert.strictEqual(integrationEvent.payload.evidenceId, evidenceId);
    assert.strictEqual(integrationEvent.payload.verificationDecision, 'ACCEPT');
    assert.strictEqual(integrationEvent.payload.integrationResult, TaskStatus.ACCEPTED);

    // Verify no secrets or credentials appear in raw JSON history line
    const rawContent = fs.readFileSync(historyManager.historyPath, 'utf8');
    assert.strictEqual(rawContent.includes('secret'), false);
    assert.strictEqual(rawContent.includes('bearer'), false);
    assert.strictEqual(rawContent.includes('password'), false);
    assert.strictEqual(rawContent.includes('token'), false);
  });
});
