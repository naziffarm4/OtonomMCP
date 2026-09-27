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
  ExecutionIntegrationValidationError,
  ExecutionIntegrationPersistenceError,
  SystemEvidenceBindingMismatchError,
  SystemEvidenceSecurityViolationError,
  SystemEvidenceValidationError,
  isSafeRelativePath,
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
  // 5. EVIDENCE INTEGRITY VALIDATION AFTER RELOAD
  // ==========================================================================
  it('5. validates evidence integrity after reload and detects disk tampering', async () => {
    // 1. Create and persist valid evidence
    const summary = 'Validation summary for integrity test';
    const evidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + '5'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-INTEGRITY',
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-integrity',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const validEvidence: SystemExecutionEvidence = {
      evidenceId,
      requestId: 'req-' + '5'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-INTEGRITY',
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-integrity',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 25 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await evidenceStore.saveEvidence(validEvidence);

    // 2. Fresh store reloads and passes integrity
    const freshEvidenceStore = new SystemExecutionEvidenceStore({
      baseDir: tempDir,
    });
    const loaded = await freshEvidenceStore.loadEvidence(evidenceId);
    assert.ok(loaded);
    assert.strictEqual(verifyEvidenceIdIntegrity(loaded), true);

    // 3. Tamper with file on disk directly
    const evidenceFilePath = path.join(freshEvidenceStore.evidenceDir, `${evidenceId}.json`);
    const rawDisk = JSON.parse(fs.readFileSync(evidenceFilePath, 'utf8'));
    rawDisk.verificationDecision = 'REJECT'; // tampered on disk!
    fs.writeFileSync(evidenceFilePath, JSON.stringify(rawDisk, null, 2), 'utf8');

    // 4. Reload tampered file from disk and assert integrity fails
    const tamperedLoaded = await freshEvidenceStore.loadEvidence(evidenceId);
    assert.ok(tamperedLoaded);
    assert.strictEqual(verifyEvidenceIdIntegrity(tamperedLoaded), false);
  });

  // ==========================================================================
  // 6. IDEMPOTENT INTEGRATION (DUPLICATE INTEGRATION)
  // ==========================================================================
  it('6. handles duplicate integration calls idempotently without state corruption', async () => {
    const taskId = 'TASK-P14-03-IDEM';
    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'Idempotency Task',
        description: 'Verifies repeated integration',
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

    const summary = 'Summary for idem check';
    const evidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + '6'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-idem',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const evidence: SystemExecutionEvidence = {
      evidenceId,
      requestId: 'req-' + '6'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-idem',
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

    await evidenceStore.saveEvidence(evidence);

    const call1 = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(call1.success, true);
    assert.strictEqual(call1.isDuplicate, false);
    assert.strictEqual(call1.taskStatus, TaskStatus.ACCEPTED);

    const call2 = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(call2.success, true);
    assert.strictEqual(call2.isDuplicate, true);
    assert.strictEqual(call2.taskStatus, TaskStatus.ACCEPTED);

    const call3 = await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    assert.strictEqual(call3.success, true);
    assert.strictEqual(call3.isDuplicate, true);
    assert.strictEqual(call3.taskStatus, TaskStatus.ACCEPTED);
  });

  // ==========================================================================
  // 7. DUPLICATE HISTORY SUPPRESSION & AUDIT TRAIL
  // ==========================================================================
  it('7. suppresses duplicate history event emission across repeated integrations and records audit trail', async () => {
    const taskId = 'TASK-P14-03-HIST-SUPPRESS';
    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'History Suppression Task',
        description: 'Verifies history suppression',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['History suppression verified'],
        tags: ['p14-03', 'history'],
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

    const summary = 'Summary for history suppression';
    const evidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + '7'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-hist',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const evidence: SystemExecutionEvidence = {
      evidenceId,
      requestId: 'req-' + '7'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-hist',
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

    await evidenceStore.saveEvidence(evidence);

    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });

    const events = await historyManager.readEvents();
    const integrationEvents = events.filter(
      (e) => e.taskId === taskId && e.eventType === 'EXECUTION_STATE_INTEGRATED'
    );
    assert.strictEqual(integrationEvents.length, 1, 'History must contain exactly one event despite 3 integrations');

    // Verify audit event details and zero secret leakage
    const event = integrationEvents[0];
    assert.strictEqual(event.actor, 'ORCHESTRATOR');
    assert.strictEqual(event.payload.evidenceId, evidenceId);
    assert.strictEqual(event.payload.verificationDecision, 'ACCEPT');
    assert.strictEqual(event.payload.integrationResult, TaskStatus.ACCEPTED);

    const rawContent = fs.readFileSync(historyManager.historyPath, 'utf8');
    assert.strictEqual(rawContent.includes('secret'), false);
    assert.strictEqual(rawContent.includes('bearer'), false);
    assert.strictEqual(rawContent.includes('password'), false);
    assert.strictEqual(rawContent.includes('token'), false);
  });

  // ==========================================================================
  // 8. DUPLICATE COMPLETEDTASKIDS SUPPRESSION
  // ==========================================================================
  it('8. suppresses duplicate entries in DurableState completedTaskIds upon repeated integration', async () => {
    const taskId = 'TASK-P14-03-DURABLE-SUPPRESS';
    await specStore.saveTasks([
      createParentFeature(),
      {
        task_id: taskId,
        parent_feature_id: 'FEAT-P14-03',
        title: 'Durable Suppression Task',
        description: 'Verifies durable completedTaskIds suppression',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        dependencies: [],
        acceptance_criteria: ['Durable suppression verified'],
        tags: ['p14-03', 'durable'],
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

    const summary = 'Summary for durable suppression';
    const evidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + '8'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-durable',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const evidence: SystemExecutionEvidence = {
      evidenceId,
      requestId: 'req-' + '8'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-durable',
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

    await evidenceStore.saveEvidence(evidence);

    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });
    await integrator.integrate(evidence, { strictEvidenceIdCheck: true });

    const durableState = await durableStateManager.load();
    const taskOccurrences = durableState?.completedTaskIds.filter((id) => id === taskId).length;
    assert.strictEqual(taskOccurrences, 1, 'completedTaskIds must contain taskId exactly once');
  });

  // ==========================================================================
  // 9. PROJECT BINDING MISMATCH
  // ==========================================================================
  it('9. rejects evidence with project binding mismatch', async () => {
    const summary = 'Summary for project mismatch';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-project-mismatch',
      requestId: 'req-' + '9'.repeat(64),
      projectId: 'project-expected-alpha',
      taskId: 'TASK-P14-03-MISMATCH-1',
      taskRevision: 1,
      contextFingerprint: 'fp-project-mismatch',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { projectId: 'project-different-beta' },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Project ID mismatch')
    );
  });

  // ==========================================================================
  // 10. TASK BINDING MISMATCH
  // ==========================================================================
  it('10. rejects evidence with task binding mismatch', async () => {
    const summary = 'Summary for task mismatch';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-task-mismatch',
      requestId: 'req-' + 'a'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-EXPECTED',
      taskRevision: 1,
      contextFingerprint: 'fp-task-mismatch',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { taskId: 'TASK-P14-03-DIFFERENT' },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Task ID mismatch')
    );
  });

  // ==========================================================================
  // 11. TASK REVISION MISMATCH
  // ==========================================================================
  it('11. rejects evidence with task revision mismatch', async () => {
    const summary = 'Summary for revision mismatch';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-rev-mismatch',
      requestId: 'req-' + 'b'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-REV',
      taskRevision: 1,
      contextFingerprint: 'fp-rev-mismatch',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { taskRevision: 2 },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Task revision mismatch')
    );
  });

  // ==========================================================================
  // 12. REQUEST BINDING MISMATCH
  // ==========================================================================
  it('12. rejects evidence with request binding mismatch', async () => {
    const summary = 'Summary for request mismatch';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-req-mismatch',
      requestId: 'req-' + '1'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-REQ',
      taskRevision: 1,
      contextFingerprint: 'fp-req-mismatch',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { requestId: 'req-' + '2'.repeat(64) },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Request ID mismatch')
    );
  });

  // ==========================================================================
  // 13. CONTEXT FINGERPRINT MISMATCH
  // ==========================================================================
  it('13. rejects evidence with context fingerprint mismatch', async () => {
    const summary = 'Summary for context fp mismatch';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-fp-mismatch',
      requestId: 'req-' + '3'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-FP',
      taskRevision: 1,
      contextFingerprint: 'fp-old-state-001',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { contextFingerprint: 'fp-new-resynced-002' },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Context fingerprint mismatch')
    );
  });

  // ==========================================================================
  // 14. GIT BASELINE MISMATCH
  // ==========================================================================
  it('14. rejects evidence with Git baseline mismatch', async () => {
    const summary = 'Summary for git baseline mismatch';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-git-mismatch',
      requestId: 'req-' + '4'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-GIT',
      taskRevision: 1,
      contextFingerprint: 'fp-git-mismatch',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { expectedBaseCommit: '0000000000000000000000000000000000000000' },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Git base commit mismatch')
    );
  });

  // ==========================================================================
  // 15. FORGED VERIFICATIONDECISION
  // ==========================================================================
  it('15. rejects forged verificationDecision via strict evidence ID hash check', async () => {
    const summary = 'Verification finished with REJECT';
    const legitimateRejectId = computeDeterministicEvidenceId({
      requestId: 'req-' + 'f'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-FORGE-DECISION',
      taskRevision: 1,
      contextFingerprint: 'fp-forge-decision',
      headCommit: initialCommitSha,
      verificationDecision: 'REJECT',
      checkSummary: summary,
    });

    const legitimateEvidence: SystemExecutionEvidence = {
      evidenceId: legitimateRejectId,
      requestId: 'req-' + 'f'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-FORGE-DECISION',
      taskRevision: 1,
      contextFingerprint: 'fp-forge-decision',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'FAIL' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'FAIL', evidence: 'failed' }],
      executorOutcomeReference: { status: 'FAILURE', exitCode: 1, durationMs: 10 },
      verificationDecision: 'REJECT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    // Adversary modifies verificationDecision from REJECT to ACCEPT without recomputing hash
    const forgedEvidence: SystemExecutionEvidence = {
      ...legitimateEvidence,
      verificationDecision: 'ACCEPT',
    };

    assert.strictEqual(verifyEvidenceIdIntegrity(forgedEvidence), false);

    await assert.rejects(
      () => integrator.integrate(forgedEvidence, { strictEvidenceIdCheck: true }),
      (err: any) =>
        err instanceof ExecutionIntegrationSecurityViolationError && err.message.includes('Evidence ID hash mismatch')
    );
  });

  // ==========================================================================
  // 16. FORGED EVIDENCE IDENTITY
  // ==========================================================================
  it('16. rejects forged evidence identity via strict hash check', async () => {
    const summary = 'Summary for forged id test';
    const legitimateEvidence: SystemExecutionEvidence = {
      evidenceId: 'evi-arbitrary-unhashed-fake-id-12345',
      requestId: 'req-' + 'd'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-FORGE-ID',
      taskRevision: 1,
      contextFingerprint: 'fp-forge-id',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    assert.strictEqual(verifyEvidenceIdIntegrity(legitimateEvidence), false);

    await assert.rejects(
      () => integrator.integrate(legitimateEvidence, { strictEvidenceIdCheck: true }),
      (err: any) =>
        err instanceof ExecutionIntegrationSecurityViolationError && err.message.includes('Evidence ID hash mismatch')
    );
  });

  // ==========================================================================
  // 17. INVALID / MALFORMED EVIDENCE REJECTION
  // ==========================================================================
  it('17. rejects invalid or malformed evidence missing critical fields', async () => {
    // Malformed: missing evidenceId
    const missingEvidenceId: any = {
      requestId: 'req-' + '1'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-MALFORMED',
      verificationDecision: 'ACCEPT',
    };

    await assert.rejects(
      () => integrator.integrate(missingEvidenceId),
      (err: any) => err instanceof ExecutionIntegrationValidationError
    );

    // Malformed: missing repositoryState
    const missingRepoState: any = {
      evidenceId: 'evi-missing-repo',
      requestId: 'req-' + '1'.repeat(64),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-MALFORMED',
      taskRevision: 1,
      contextFingerprint: 'fp-test',
      verificationDecision: 'ACCEPT',
      changedFiles: [],
      verificationChecks: [],
      acceptanceCriteria: [],
    };

    await assert.rejects(
      () => integrator.integrate(missingRepoState),
      (err: any) => err instanceof ExecutionIntegrationValidationError
    );
  });

  // ==========================================================================
  // 18. IMPLEMENTATION SCOPE VIOLATION
  // ==========================================================================
  it('18. rejects changes outside authorized implementation scope and marks REJECT', async () => {
    const taskId = 'TASK-P14-03-SCOPE-VIOLATION';
    const request: ExecutionRequest = {
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: 'req-' + '18'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      directorSessionId: 'sess-scope',
      directorDecisionId: 'dec-scope',
      contextFingerprint: 'fp-scope',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Modify greeting',
        acceptanceCriteria: ['Must modify greeting only'],
        constraints: [],
        targetFiles: ['src/greeting.ts'],
        implementationScope: ['src/greeting.ts'], // ONLY src/greeting.ts allowed!
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: initialCommitSha, isClean: true },
    };

    // Untrusted executor modifies an out-of-scope file
    const unauthorizedFile = path.join(tempDir, 'src', 'unauthorized.ts');
    fs.writeFileSync(unauthorizedFile, 'export const secret = "leak";\n');

    const rawOutcome = createMockRawOutcome(request, {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: '',
      durationMs: 50,
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: ['src/unauthorized.ts'],
    });

    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
    });

    // Verification must detect scope violation and set decision to REJECT
    assert.strictEqual(evidence.verificationDecision, 'REJECT');
    const scopeCheck = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_IMPLEMENTATION_SCOPE');
    assert.ok(scopeCheck);
    assert.strictEqual(scopeCheck.status, 'FAIL');
    assert.ok(scopeCheck.evidence?.includes('outside allowed implementationScope'));

    // Cleanup file
    fs.unlinkSync(unauthorizedFile);
  });

  // ==========================================================================
  // 19. PATH TRAVERSAL / ABSOLUTE PATH REJECTION
  // ==========================================================================
  it('19. rejects path traversal and absolute paths in targetFiles and implementationScope', async () => {
    // 1. isSafeRelativePath utility checks
    assert.strictEqual(isSafeRelativePath('src/greeting.ts'), true);
    assert.strictEqual(isSafeRelativePath('../outside.ts'), false);
    assert.strictEqual(isSafeRelativePath('/etc/passwd'), false);
    assert.strictEqual(isSafeRelativePath('C:\\Windows\\System32'), false);
    assert.strictEqual(isSafeRelativePath('src/../../escaped.ts'), false);

    // 2. ExecutorGuard rejects request with path traversal in targetFiles
    const traversalRequest: ExecutionRequest = {
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: 'req-' + '19'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-TRAVERSAL',
      taskRevision: 1,
      directorSessionId: 'sess-trav',
      directorDecisionId: 'dec-trav',
      contextFingerprint: 'fp-trav',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Test path traversal rejection',
        acceptanceCriteria: ['Must fail'],
        constraints: [],
        targetFiles: ['../escaped.ts'],
        implementationScope: ['../escaped.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: initialCommitSha, isClean: true },
    };

    assert.throws(
      () => ExecutorGuard.validateExecutionPreconditions(traversalRequest, { workingDirectory: tempDir }),
      (err: any) => err.message.includes('Path traversal')
    );
  });

  // ==========================================================================
  // 20. RAWEXECUTOROUTCOME CANNOT DIRECTLY BECOME AUTHORITATIVE EVIDENCE
  // ==========================================================================
  it('20. enforces that RawExecutorOutcome cannot directly be integrated as authoritative evidence', async () => {
    const rawOutcome: RawExecutorOutcome = {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: 'all tests passed!',
      stderr: '',
      durationMs: 42,
      timedOut: false,
      unverifiedAgentClaims: [{ claim: 'I wrote all features and tests pass', confidence: 1.0 }],
      unverifiedModifiedFiles: ['src/greeting.ts'],
    };

    // Statically prevented by TypeScript, but at runtime passing raw object without evidence envelope fails closed
    await assert.rejects(
      () => integrator.integrate(rawOutcome as any),
      (err: any) =>
        err instanceof ExecutionIntegrationValidationError &&
        err.message.includes('RawExecutorOutcome cannot be integrated directly')
    );

    // Also assertNotVerifiedEvidence rejects raw outcome claiming authoritative verification
    const forgedRawOutcome = {
      ...rawOutcome,
      verified: true,
      systemAccepted: true,
    };
    assert.throws(
      () => assertNotVerifiedEvidence(forgedRawOutcome),
      (err: any) => err.message.includes('forbidden system verification field')
    );
  });

  // ==========================================================================
  // 21. STALE EVIDENCE REJECTION
  // ==========================================================================
  it('21. rejects stale evidence when task revision or git baseline has advanced', async () => {
    const summary = 'Summary for stale evidence';
    const evidence: SystemExecutionEvidence = {
      evidenceId: 'evi-stale-001',
      requestId: 'req-' + '21'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-STALE-CHECK',
      taskRevision: 1, // Evidence generated for revision 1
      contextFingerprint: 'fp-stale-001',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 15 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    // Spec task is now at revision 2 (stale evidence against advanced task revision)
    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: { taskRevision: 2 },
          strictEvidenceIdCheck: false,
        }),
      (err: any) =>
        err instanceof ExecutionIntegrationBindingMismatchError && err.message.includes('Task revision mismatch')
    );
  });

  // ==========================================================================
  // 22. ACCEPTANCE-CRITERIA FAILURE DESPITE RAW SUCCESS
  // ==========================================================================
  it('22. sets REJECT when acceptance criteria fail despite RawExecutorOutcome reporting SUCCESS', async () => {
    const taskId = 'TASK-P14-03-AC-FAIL';
    const request: ExecutionRequest = {
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: 'req-' + '22'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      directorSessionId: 'sess-ac-fail',
      directorDecisionId: 'dec-ac-fail',
      contextFingerprint: 'fp-ac-fail',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Must set greeting to "required_token_123"',
        acceptanceCriteria: [
          {
            criterionId: 'AC-TOKEN',
            description: 'src/greeting.ts must export greeting with value "required_token_123"',
            type: 'TEST',
            mandatory: true,
            expected_command: process.platform === 'win32'
              ? 'cmd.exe /c findstr "required_token_123" src\\greeting.ts'
              : 'grep "required_token_123" src/greeting.ts',
          },
        ],
        constraints: [],
        targetFiles: ['src/greeting.ts'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: initialCommitSha, isClean: true },
    };

    // File was modified, but does NOT contain "required_token_123"
    fs.writeFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'export const greeting = "wrong_token_456";\n');

    // Raw executor falsely claims SUCCESS!
    const rawOutcome = createMockRawOutcome(request, {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: 'all good',
      durationMs: 30,
      unverifiedAgentClaims: [{ claim: 'criteria satisfied', confidence: 1.0 }],
      unverifiedModifiedFiles: ['src/greeting.ts'],
    });

    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
    });

    // Verification must independently reject the claim and set REJECT
    assert.strictEqual(evidence.verificationDecision, 'REJECT');
    const acCheck = evidence.acceptanceCriteria[0];
    assert.ok(acCheck);
    assert.strictEqual(acCheck.status, 'FAIL');
  });

  // ==========================================================================
  // 23. INDEPENDENT VERIFICATION FAILURE
  // ==========================================================================
  it('23. sets REJECT when independent verification command fails despite agent claim', async () => {
    const taskId = 'TASK-P14-03-CMD-FAIL';
    const request: ExecutionRequest = {
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: 'req-' + '23'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId,
      taskRevision: 1,
      directorSessionId: 'sess-cmd-fail',
      directorDecisionId: 'dec-cmd-fail',
      contextFingerprint: 'fp-cmd-fail',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'IMPLEMENT_TASK',
      instruction: {
        objective: 'Independent test run',
        acceptanceCriteria: ['Verification command passes'],
        constraints: [],
        targetFiles: ['src/greeting.ts'],
        implementationScope: ['src/greeting.ts'],
      },
      executionLimits: { timeoutMs: 10000, maxFileModifications: 5 },
      expectedRepositoryState: { baseCommit: initialCommitSha, isClean: true },
    };

    fs.writeFileSync(path.join(tempDir, 'src', 'greeting.ts'), 'export const greeting = "cmd_fail_val";\n');

    const rawOutcome = createMockRawOutcome(request, {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: '',
      durationMs: 30,
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: ['src/greeting.ts'],
    });

    const evidence = await collector.collectAndVerify(request, rawOutcome, {
      workingDirectory: tempDir,
      evidenceStore,
      verificationCommands: [
        {
          id: 'FAILS',
          type: 'TEST',
          command: process.platform === 'win32' ? 'cmd.exe /c exit 1' : 'sh -c "exit 1"',
        },
      ],
    });

    assert.strictEqual(evidence.verificationDecision, 'REJECT');
    const failedCheck = evidence.verificationChecks.find((c) => c.checkId.includes('FAILS'));
    assert.ok(failedCheck);
    assert.strictEqual(failedCheck.status, 'FAIL');
  });

  // ==========================================================================
  // 24. PERSISTENCE FAILURE / ATOMIC WRITE BEHAVIOR
  // ==========================================================================
  it('24. fails closed on persistence failure and guarantees atomic write cleanup', async () => {
    // 1. Evidence store pointing to an invalid read-only / file path instead of directory
    const invalidFilePath = path.join(tempDir, 'invalid-evidence-file.txt');
    fs.writeFileSync(invalidFilePath, 'not a directory');

    const failingStore = new SystemExecutionEvidenceStore({
      evidenceDir: invalidFilePath, // Will fail mkdir/write
    });

    const sampleEvidence: SystemExecutionEvidence = {
      evidenceId: 'evi-fail-persist',
      requestId: 'req-' + '24'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-PERSIST-FAIL',
      taskRevision: 1,
      contextFingerprint: 'fp-fail',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: 'Fail summary' },
    };

    // saveEvidence must throw and not leave partial / corrupted state
    await assert.rejects(
      () => failingStore.saveEvidence(sampleEvidence),
      (err: any) =>
        err.name === 'StorageError' ||
        err.message.includes('atomic write') ||
        err.message.includes('Failed to create directory')
    );

    // Integrator with failing store and requirePersistedEvidence must fail closed
    const failingIntegrator = new ExecutionStateIntegrator({
      evidenceStore: failingStore,
      requirePersistedEvidence: true,
      workspaceRoot: tempDir,
    });

    await assert.rejects(
      () => failingIntegrator.integrate(sampleEvidence),
      (err: any) =>
        err instanceof ExecutionIntegrationSecurityViolationError ||
        err instanceof ExecutionIntegrationPersistenceError
    );
  });

  // ==========================================================================
  // 25. TRUSTED PROVENANCE REQUIREMENT (SECURITY AUDIT TEST)
  // ==========================================================================
  it('25. enforces trusted provenance: rejects fabricated in-memory evidence even when internal SHA-256 hash is self-consistent', async () => {
    // ADVERSARIAL AUDIT SCENARIO:
    // Attacker crafts a fabricated evidence object with verificationDecision = 'ACCEPT'.
    // Attacker recomputes deterministic SHA-256 evidenceId so verifyEvidenceIdIntegrity(forged) returns true!
    const summary = 'Adversarial forgery with recomputed valid hash';
    const forgedEvidenceId = computeDeterministicEvidenceId({
      requestId: 'req-' + '25'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-ADVERSARY',
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-adversary',
      headCommit: initialCommitSha,
      verificationDecision: 'ACCEPT',
      checkSummary: summary,
    });

    const forgedSelfConsistentEvidence: SystemExecutionEvidence = {
      evidenceId: forgedEvidenceId,
      requestId: 'req-' + '25'.repeat(32),
      projectId: 'test-p14-03-evidence-project',
      taskId: 'TASK-P14-03-ADVERSARY',
      taskRevision: 1,
      contextFingerprint: 'fp-sha256-adversary',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: { baseCommit: initialCommitSha, headCommit: initialCommitSha, isClean: false },
      changedFiles: [{ path: 'src/greeting.ts', status: 'M' }],
      verificationChecks: [{ checkId: 'CHECK_1', type: 'GENERAL', status: 'PASS' }],
      acceptanceCriteria: [{ criterion: 'AC1', status: 'PASS', evidence: 'passed' }],
      executorOutcomeReference: { status: 'SUCCESS', exitCode: 0, durationMs: 10 },
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      metadata: { evaluationSummary: summary },
    };

    // 1. Verify that internal SHA-256 hash self-consistency PASSES (integrity check alone is insufficient!)
    assert.strictEqual(
      verifyEvidenceIdIntegrity(forgedSelfConsistentEvidence),
      true,
      'Hash is self-consistent because attacker recomputed it'
    );

    // 2. Integration with requirePersistedEvidence MUST reject the forgery because it lacks authoritative provenance
    // (was never collected and persisted by trusted SystemEvidenceCollector)
    await assert.rejects(
      () => integrator.integrate(forgedSelfConsistentEvidence, { requirePersistedEvidence: true }),
      (err: any) =>
        err instanceof ExecutionIntegrationSecurityViolationError &&
        err.message.includes('has no authoritative persisted record')
    );
  });
});
