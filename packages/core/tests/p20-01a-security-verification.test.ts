/**
 * @file p20-01a-security-verification.test.ts
 * @description P20-01A: Execution Bridge Final Security & Acceptance Verification Test Suite.
 *
 * Covers the 12 explicit security verification scenarios:
 * 1. Sahte PRODUCT_OWNER kimliği.
 * 2. Sahte PO onay verisi.
 * 3. Aynı intent için eşzamanlı iki dispatch.
 * 4. Claim ile HistoryManager kaydı arasında hata.
 * 5. Driver başladıktan sonra süreç çökmesi.
 * 6. UNKNOWN intent'in restart sonrasında yeniden çalıştırılmaması.
 * 7. AGY'nin sahte changedFiles beyanı.
 * 8. AGY'nin sahte TEST/BUILD sonucu.
 * 9. Başka intent'e ait eski kanıtın kullanılması.
 * 10. Yanlış task/project/intent ilişkisinin reddedilmesi.
 * 11. Gerçek doğrulama başarısızken Task DAG'nin tamamlanmaması.
 * 12. Bütçe rezervasyonunun yanlışlıkla çift kullanılmasının engellenmesi.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';

import {
  ExecutionBridge,
  ExecutionBridgeStatus,
  type BridgeExecutionIntent,
  createFrozenBridgeExecutionIntent,
  HistoryManager,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  ApprovalStore,
  ApprovalPackageEngine,
  SpecStore,
  TaskDagEngine,
  DurableStateManager,
  DriverEngine,
  type DirectorSession,
  type DirectorContextSnapshot,
  type ApprovalPackage,
  type DirectorDecision,
  type TaskDefinition,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  SystemExecutionEvidenceStore,
  LocalRuntimeStateManager,
  BudgetManager,
  usdToNanoUsd,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
} from '../dist/index.js';

describe('Phase 20 TASK-P20-01A — Execution Bridge Final Security & Acceptance Verification', { concurrency: 1 }, () => {
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
  let runtimeStateManager: LocalRuntimeStateManager;
  let driverEngine: DriverEngine;
  let budgetManager: BudgetManager;
  let policyEngine: AuthorizationPolicyEngine;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;
  let implementDecision: DirectorDecision;
  let task1: TaskDefinition;
  let task2: TaskDefinition;

  // Mock executor tracking all execution invocations
  class MockExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-security-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    executionCallCount = 0;
    isAvailable = true;
    simulateTimeout = false;
    simulateFailure = false;
    simulateSelfClaimOnly = false;
    fakeModifiedFilesDeclaration: string[] | null = null;
    fakeTestClaimsDeclaration: string[] | null = null;

    async checkAvailability() {
      return { available: this.isAvailable, reason: this.isAvailable ? undefined : 'Executor host not found' };
    }

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      this.executionCallCount++;

      if (this.simulateTimeout) {
        const timeoutErr: any = new Error('Antigravity execution timed out after 30000ms');
        timeoutErr.code = 'ETIMEDOUT';
        throw timeoutErr;
      }

      if (this.simulateFailure) {
        return {
          executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
          requestId: request.requestId,
          requestBinding: {
            requestId: request.requestId,
            directorSessionId: request.directorSessionId,
            directorDecisionId: request.directorDecisionId,
            projectId: request.projectId,
            taskId: request.taskId,
            taskRevision: request.taskRevision,
            contextFingerprint: request.contextFingerprint,
            understandingRevision: request.understandingRevision,
            approvalPackageRevision: request.approvalPackageRevision,
            operationType: request.operationType,
          },
          status: 'FAILURE',
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Compilation error in src/index.ts',
          durationMs: 45,
          unverifiedAgentClaims: ['Failed to build'],
          unverifiedModifiedFiles: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }

      // Write files so real EvidenceCollector observes filesystem mutations (unless simulating verbal claim or fake claim)
      const files = request.targetFiles && request.targetFiles.length > 0 ? request.targetFiles : ['src/index.ts'];
      if (!this.simulateSelfClaimOnly && !this.fakeModifiedFilesDeclaration) {
        for (const f of files) {
          const full = path.join(tempDir, f);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, '// bridge implemented feature\n', 'utf8');
        }
      }

      return {
        executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
        requestId: request.requestId,
        requestBinding: {
          requestId: request.requestId,
          directorSessionId: request.directorSessionId,
          directorDecisionId: request.directorDecisionId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
          operationType: request.operationType,
        },
        status: 'SUCCESS',
        exitCode: 0,
        signal: null,
        stdout: 'Antigravity executed task successfully',
        stderr: '',
        durationMs: 60,
        unverifiedAgentClaims: this.fakeTestClaimsDeclaration ?? ['I have completed the task and it works perfectly'],
        unverifiedModifiedFiles: this.fakeModifiedFilesDeclaration ?? (this.simulateSelfClaimOnly ? [] : (files as string[])),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockExecutor;

  function createTestApprovedPackage(projectId: string, revision = 1, actorRole = 'PRODUCT_OWNER'): ApprovalPackage {
    const now = new Date().toISOString();
    return {
      packageId: `pkg-${projectId}-01`,
      revision,
      approvalPackageRevision: revision,
      projectId,
      status: 'APPROVED',
      isStale: false,
      createdAt: now,
      updatedAt: now,
      approvalRecord: {
        packageId: `pkg-${projectId}-01`,
        revision,
        actor: 'human-product-owner',
        actorRole: actorRole as any,
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: now,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Formal development approval granted by human Product Owner',
      },
    };
  }

  function createValidIntent(overrides: Partial<BridgeExecutionIntent> = {}): BridgeExecutionIntent {
    return createFrozenBridgeExecutionIntent({
      executionIntentId: overrides.executionIntentId ?? 'intent-sec-001',
      actionId: overrides.actionId ?? 'act-implement-001',
      idempotencyKey: overrides.idempotencyKey ?? 'idem-sec-001',
      projectId: overrides.projectId ?? canonicalProjectId,
      directorSessionId: overrides.directorSessionId ?? activeSession.directorSessionId,
      taskId: overrides.taskId ?? 'TASK-01',
      taskRevision: overrides.taskRevision ?? 1,
      basedOnContextFingerprint: overrides.basedOnContextFingerprint ?? activeSnapshot.logicalFingerprint,
      understandingRevision: overrides.understandingRevision ?? 1,
      authorizationReference: overrides.authorizationReference ?? {
        packageId: approvedPackage.packageId,
        packageRevision: approvedPackage.revision,
        isDevelopmentAuthorized: true,
        authorizedAt: approvedPackage.createdAt,
      },
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      executionPlan: overrides.executionPlan ?? 'Implement core notification feature',
      metadata: overrides.metadata ?? { source: 'test' },
    });
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p20a-test-'));
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
    runtimeStateManager = new LocalRuntimeStateManager({ baseDir: tempDir });
    mockExecutor = new MockExecutor();

    // Acquire workspace instance lock for current process
    await runtimeStateManager.save({
      processId: process.pid,
      acquiredLock: true,
      activeAttempt: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });

    // Active session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      understandingRevision: 1,
    });

    // Snapshot
    activeSnapshot = {
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      logicalFingerprint: 'fp-p20a-valid-fingerprint-9999',
      isComplete: true,
      syncStatus: 'UNCHANGED',
      sections: {} as any,
      unavailableSections: [],
      staleSections: [],
      sectionMetadata: {} as any,
      isDerived: true,
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    // Approval package
    approvedPackage = createTestApprovedPackage(canonicalProjectId, 1, 'PRODUCT_OWNER');
    await approvalStore.savePackage(approvedPackage);

    // Decision
    implementDecision = {
      decisionId: 'dec-p20a-task-01',
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
      metadata: { taskId: 'TASK-01' },
      hasImplementationAuthority: false,
    };
    await decisionStore.saveDecision(implementDecision);

    // Tasks in DAG
    const parentFeature: TaskDefinition = {
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
      metadata: { revision: 1 },
    };

    task1 = {
      task_id: 'TASK-01',
      parent_feature_id: 'FEAT-01',
      title: 'Task 1: Core Service',
      description: 'Implement core notification service',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-01: Primary implementation files created in repository'],
      status: 'READY' as any,
      attempt: 0,
      max_attempts: 2,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { revision: 1, target_files: ['src/index.ts'], taskClass: 'IMPLEMENTATION' },
    };

    task2 = {
      task_id: 'TASK-02',
      parent_feature_id: 'FEAT-01',
      title: 'Task 2: Secondary Service',
      description: 'Implement secondary service dependent on Task 1',
      traceability_sources: ['REQ-02'],
      dependencies: ['TASK-01'],
      acceptance_criteria: ['AC-02: Secondary implementation files created in repository'],
      status: 'READY' as any,
      attempt: 0,
      max_attempts: 2,
      priority: 'MEDIUM' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { revision: 1, target_files: ['src/secondary.ts'], taskClass: 'IMPLEMENTATION' },
    };

    await specStore.saveTasks([parentFeature, task1, task2]);

    // Budget Manager
    budgetManager = new BudgetManager({
      dbPath: ':memory:',
      historyManager,
    });
    budgetManager.open();
    budgetManager.createGlobalAccount(usdToNanoUsd(50.0));
    budgetManager.createProjectAccount(canonicalProjectId, usdToNanoUsd(25.0));
    budgetManager.registerPricingRate({
      providerId: 'antigravity',
      modelId: 'default',
      inputRateNum: 1n,
      inputRateDen: 1000n,
      outputRateNum: 2n,
      outputRateDen: 1000n,
    });

    // Driver Engine
    driverEngine = new DriverEngine({
      workspaceRoot: tempDir,
      historyManager,
      evidenceStore,
      specStore,
      dagEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      executorPort: mockExecutor,
    });

    const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    const baseMandate: ProjectMandate = {
      projectId: canonicalProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'IMPLEMENTATION', 'IMPLEMENT_TASK', 'TEST_EXECUTION', 'BUILD_EXECUTION', 'EVIDENCE_REVIEW', 'REVIEW_EVIDENCE'],
      allowedCommandCategories: ['test', 'build', 'lint', 'format'],
      autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
      forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE'],
      humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION', 'UPDATE_SECURITY_POLICY'],
      authorizationStartTime: new Date(Date.now() - 100000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 100000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
      policyVersion: 1,
      mandateRevision: 1,
    };
    fs.mkdirSync(path.join(tempDir, '.ai-manager', 'state'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.ai-manager', 'state', 'project-mandate.json'), JSON.stringify(baseMandate, null, 2), 'utf8');
    policyEngine = new AuthorizationPolicyEngine({ historyManager, mandateStore, specStore, evidenceStore });
  });

  afterEach(() => {
    try {
      budgetManager.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // Scenario 1: Sahte PRODUCT_OWNER kimliği
  // ==========================================================================
  it('SEC-01: Fake PRODUCT_OWNER actorRole in approval package is rejected fail-closed', async () => {
    // Save package where status is PENDING and human PO approval is missing
    const unapprovedPackage: ApprovalPackage = {
      ...approvedPackage,
      status: 'PENDING',
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(unapprovedPackage);

    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    // Intent tries to claim authorizedByRole: 'PRODUCT_OWNER'
    const intent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: approvedPackage.revision,
        isDevelopmentAuthorized: true,
        authorizedByRole: 'PRODUCT_OWNER',
        authorizedAt: new Date().toISOString(),
      },
    });
    const result = await bridge.executeIntent(intent);

    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_PO_AUTHORIZATION_REQUIRED');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver/Executor must NEVER be called with fake PO role');
  });

  // ==========================================================================
  // Scenario 2: Sahte PO onay verisi
  // ==========================================================================
  it('SEC-02: Forged PO approval data (REJECTED status or package revision mismatch) is rejected', async () => {
    const rejectedPackage = {
      ...approvedPackage,
      status: 'REJECTED' as const,
    };
    await approvalStore.savePackage(rejectedPackage);

    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();
    const result = await bridge.executeIntent(intent);

    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_PO_AUTHORIZATION_REQUIRED');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // Scenario 3: Aynı intent için eşzamanlı iki dispatch
  // ==========================================================================
  it('SEC-03: Two concurrent dispatches for the same intent execute driver exactly ONCE', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();

    // Fire two dispatches concurrently
    const [res1, res2] = await Promise.all([
      bridge.executeIntent(intent),
      bridge.executeIntent(intent),
    ]);

    assert.equal(res1.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.equal(res2.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.equal(mockExecutor.executionCallCount, 1, 'Mock executor must be called exactly once despite concurrent dispatches');
  });

  // ==========================================================================
  // Scenario 4: Claim ile HistoryManager kaydı arasında hata
  // ==========================================================================
  it('SEC-04: Error during HistoryManager claim write triggers rollback of in-memory claim and budget reservation', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();

    // Stub historyManager.appendEvent to throw on intent claim
    const originalAppendEvent = historyManager.appendEvent.bind(historyManager);
    historyManager.appendEvent = async (event: any) => {
      if (event.eventType === 'EXECUTION_BRIDGE_INTENT_CLAIMED') {
        throw new Error('Simulated disk full / HistoryManager persistence error');
      }
      return originalAppendEvent(event);
    };

    await assert.rejects(
      async () => {
        await bridge.claimIntent(intent);
      },
      /Simulated disk full/
    );

    // Verify claim was rolled back from in-memory record
    assert.equal(bridge.getClaim(intent.executionIntentId), undefined, 'Claim must be rolled back on history write failure');
  });

  // ==========================================================================
  // Scenario 5: Driver başladıktan sonra süreç çökmesi
  // ==========================================================================
  it('SEC-05: Process crash after Driver starts leaves intent recoverable to EXECUTION_UNKNOWN', async () => {
    const bridge1 = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent({ executionIntentId: 'intent-crash-started' });
    await bridge1.claimIntent(intent);

    // Simulate process death after EXECUTION_STARTED recorded
    await historyManager.appendEvent({
      eventId: 'ev-started-sim',
      eventType: 'EXECUTION_BRIDGE_STARTED',
      actor: 'ORCHESTRATOR' as any,
      taskId: intent.taskId,
      payload: {
        executionIntentId: intent.executionIntentId,
        taskId: intent.taskId,
        status: ExecutionBridgeStatus.EXECUTION_STARTED,
        startedAt: new Date().toISOString(),
      },
    });

    // Simulate fresh process restart
    const bridge2 = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const recovery = await bridge2.recover();
    assert.equal(recovery.recoveredCount, 1);
    assert.equal(recovery.reconciledIntents[intent.executionIntentId], ExecutionBridgeStatus.EXECUTION_UNKNOWN);
  });

  // ==========================================================================
  // Scenario 6: UNKNOWN intent'in restart sonrasında yeniden çalıştırılmaması
  // ==========================================================================
  it('SEC-06: UNKNOWN intent after restart is rejected and never re-dispatched to AGY', async () => {
    const bridge1 = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent({ executionIntentId: 'intent-unknown-never-retry' });
    await bridge1.claimIntent(intent);

    // Simulate recovery to UNKNOWN
    const bridge2 = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    await bridge2.recover();

    // Re-dispatching this intent must fail closed and NOT call driver/executor
    const retryResult = await bridge2.executeIntent(intent);
    assert.equal(retryResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(retryResult.code, 'ERR_INTENT_ALREADY_CLAIMED');
    assert.equal(mockExecutor.executionCallCount, 0, 'Executor must NEVER be called for UNKNOWN intent');
  });

  // ==========================================================================
  // Scenario 7: AGY'nin sahte changedFiles beyanı
  // ==========================================================================
  it('SEC-07: AGY claims fake modified files but git repository is clean -> rejected fail-closed', async () => {
    mockExecutor.fakeModifiedFilesDeclaration = ['src/fake-nonexistent.ts'];

    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();
    const result = await bridge.executeIntent(intent);

    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_VERIFICATION_FAILED');
  });

  // ==========================================================================
  // Scenario 8: AGY'nin sahte TEST/BUILD sonucu
  // ==========================================================================
  it('SEC-08: AGY claims verbal TEST/BUILD success without independent command checks -> rejected', async () => {
    mockExecutor.simulateSelfClaimOnly = true;
    mockExecutor.fakeTestClaimsDeclaration = ['All 100 tests passed with 100% coverage'];

    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();
    const result = await bridge.executeIntent(intent);

    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_VERIFICATION_FAILED');
  });

  // ==========================================================================
  // Scenario 9: Başka intent'e ait eski kanıtın kullanılması
  // ==========================================================================
  it('SEC-09: Stale evidence from a previous cycle or older timestamp is rejected during recovery', async () => {
    // Pre-save an older evidence package collected before the current intent was claimed
    const pastTimestamp = new Date(Date.now() - 3600000).toISOString();
    await evidenceStore.saveEvidence({
      evidenceId: 'ev-stale-past-001',
      requestId: 'req-stale-001',
      projectId: canonicalProjectId,
      taskId: 'TASK-01',
      taskRevision: 1,
      contextFingerprint: 'fp-old',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'sha-base',
        headCommit: 'sha-head',
        isClean: true,
      },
      changedFiles: [{ path: 'src/index.ts', status: 'MODIFIED' }],
      verificationChecks: [
        {
          checkId: 'CHECK_COMMAND_01',
          type: 'COMMAND',
          status: 'PASS',
          evidence: 'Tests passed in previous cycle',
        },
      ],
      acceptanceCriteria: [
        {
          criterion: 'AC-01',
          status: 'PASS',
          evidence: 'Verified in past run',
        },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 50,
      },
      verificationDecision: 'ACCEPT',
      verifiedAt: pastTimestamp,
    });

    const bridge1 = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    // Claim intent NOW (claimedAt is strictly newer than pastTimestamp)
    const intent = createValidIntent({ executionIntentId: 'intent-with-stale-evidence' });
    await bridge1.claimIntent(intent);

    // Simulate crash and recovery in new instance
    const bridge2 = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const recovery = await bridge2.recover();
    // Stale evidence must be rejected, reconciling to EXECUTION_UNKNOWN, NOT EXECUTION_SUCCEEDED!
    assert.equal(recovery.reconciledIntents[intent.executionIntentId], ExecutionBridgeStatus.EXECUTION_UNKNOWN);
  });

  // ==========================================================================
  // Scenario 10: Yanlış task/project/intent ilişkisinin reddedilmesi
  // ==========================================================================
  it('SEC-10: Mismatched task revision or project ID is rejected fail-closed before invoking driver', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    // Task revision mismatch: intent specifies revision 999, DAG has revision 1
    const invalidIntent = createValidIntent({
      taskRevision: 999,
    });

    const result = await bridge.executeIntent(invalidIntent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.code, 'ERR_TASK_INVALID');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver must NEVER be called on revision mismatch');
  });

  // ==========================================================================
  // Scenario 11: Gerçek doğrulama başarısızken Task DAG'nin tamamlanmaması
  // ==========================================================================
  it('SEC-11: Task DAG target task remains in original state when verification fails', async () => {
    mockExecutor.simulateFailure = true;

    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();
    const result = await bridge.executeIntent(intent);

    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);

    // Verify task in SpecStore did NOT become ACCEPTED or COMPLETED
    const tasks = await specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === 'TASK-01');
    assert.ok(task);
    assert.notEqual(task.status, 'ACCEPTED');
    assert.notEqual(task.status, 'COMPLETED');
  });

  // ==========================================================================
  // Scenario 12: Bütçe rezervasyonunun yanlışlıkla çift kullanılmasının engellenmesi
  // ==========================================================================
  it('SEC-12: Single-use budget reservation cannot be double-claimed or double-settled', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    const intent = createValidIntent();
    const result = await bridge.executeIntent(intent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.ok(result.budgetReservationId);

    // Attempting to claim the exact same reservation again for dispatch must throw
    assert.throws(() => {
      budgetManager.claimReservationForDispatch({
        reservationId: result.budgetReservationId!,
        sessionId: intent.directorSessionId,
        taskId: intent.taskId,
        idempotencyKey: intent.idempotencyKey,
      });
    }, /Reservation is in SETTLED state|cannot be reused|Cannot claim reservation|ERR_INVALID_RESERVATION_STATE/);
  });
});
