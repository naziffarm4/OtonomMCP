/**
 * @file p20-01-execution-bridge.test.ts
 * @description Comprehensive Test Suite for Phase 20 TASK-P20-01:
 * Execution Bridge Architecture & Safe Driver Handoff.
 *
 * Validates all required architectural, lifecycle, governance, and safety scenarios:
 * 1. Valid intent handed off to existing Driver and successfully executed with independent verification.
 * 2. Idempotency: duplicate intent execution prevented (returns cached result without re-executing).
 * 3. Stale fingerprint: Driver is NOT called when context fingerprint is stale.
 * 4. Project/session mismatch: Driver is NOT called when project or session doesn't match canonical.
 * 5. Missing/unmet dependency: Driver is NOT called when task dependencies are unmet.
 * 6. Insufficient budget: Driver is NOT called when P18-03 budget limit is exceeded.
 * 7. Missing or invalid Product Owner approval: Driver is NOT called without explicit development authorization.
 * 8. Instance lock loss: Driver is NOT called when workspace instance lock is held by another process.
 * 9. AGY timeout/abort: Enters EXECUTION_UNKNOWN and is NEVER automatically retried.
 * 10. Restart recovery: In-flight intents are reconciled to EXECUTION_UNKNOWN, preventing duplicate AGY runs.
 * 11. AGY self-claim rejected: AGY's verbal self-claim is NOT accepted as success proof.
 * 12. Independent evidence required: Task is NOT marked COMPLETED without independent evidence.
 * 13. HistoryManager event sequencing: Lifecycle events logged in strict auditable order.
 * 14. Zero paid LLM calls and zero real AGY subprocess execution.
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
  DriverEngine,
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
  LocalRuntimeStateManager,
  BudgetManager,
  usdToNanoUsd,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
} from '../dist/index.js';

describe('Phase 20 TASK-P20-01 — Execution Bridge Architecture & Safe Driver Handoff', { concurrency: 1 }, () => {
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
    readonly executorId = 'mock-bridge-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    executionCallCount = 0;
    isAvailable = true;
    simulateTimeout = false;
    simulateFailure = false;
    simulateSelfClaimOnly = false;

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

      // Write files so real EvidenceCollector observes filesystem mutations
      const files = request.targetFiles && request.targetFiles.length > 0 ? request.targetFiles : ['src/index.ts'];
      if (!this.simulateSelfClaimOnly) {
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
        unverifiedAgentClaims: ['I have completed the task and it works perfectly'],
        unverifiedModifiedFiles: this.simulateSelfClaimOnly ? [] : (files as string[]),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockExecutor;

  function createTestApprovedPackage(projectId: string, revision = 1): ApprovalPackage {
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
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: now,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Formal development approval granted by human Product Owner',
      },
    };
  }

  function createValidIntent(overrides: Partial<BridgeExecutionIntent> = {}): BridgeExecutionIntent {
    return createFrozenBridgeExecutionIntent({
      executionIntentId: overrides.executionIntentId ?? 'intent-valid-001',
      actionId: overrides.actionId ?? 'act-implement-001',
      idempotencyKey: overrides.idempotencyKey ?? 'idem-key-001',
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p20-test-'));
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

    // Durable state
    await durableManager.save({
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
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
      logicalFingerprint: 'fp-p20-valid-fingerprint-1234',
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
    approvedPackage = createTestApprovedPackage(canonicalProjectId, 1);
    await approvalStore.savePackage(approvedPackage);

    // Decision
    implementDecision = {
      decisionId: 'dec-p20-task-01',
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
  // Test 1: Valid Intent Execution
  // ==========================================================================
  it('T1: Valid intent is safely handed off to Driver and executed with independent verification', async () => {
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
    assert.equal(result.isSuccess, true);
    assert.equal(result.taskId, 'TASK-01');
    assert.equal(mockExecutor.executionCallCount, 1, 'Mock executor must be called exactly once');

    // Verify claim state
    const claim = bridge.getClaim(intent.executionIntentId);
    assert.ok(claim);
    assert.equal(claim.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.ok(claim.budgetReservationId, 'Budget reservation ID must be recorded on claim');

    // Verify independent evidence proof
    assert.ok(result.systemEvidence);
    assert.equal(result.systemEvidence.verificationDecision, 'ACCEPT');
    assert.equal(result.cycleResult?.isAuthoritativeProof.systemEvidenceIsProof, true);
    assert.equal(result.cycleResult?.isAuthoritativeProof.executorOutcomeIsProof, false);
  });

  // ==========================================================================
  // Test 2: Idempotency & Duplicate Claim Prevention
  // ==========================================================================
  it('T2: Idempotent duplicate intent execution is prevented without repeating Driver/AGY run', async () => {
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
    const result1 = await bridge.executeIntent(intent);
    assert.equal(result1.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.equal(mockExecutor.executionCallCount, 1);

    // Call second time with the exact same intent
    const result2 = await bridge.executeIntent(intent);
    assert.equal(result2.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.equal(mockExecutor.executionCallCount, 1, 'Second execution must NOT call executor again');
  });

  // ==========================================================================
  // Test 3: Stale Context Fingerprint Rejection
  // ==========================================================================
  it('T3: Stale context fingerprint rejects execution and does NOT invoke Driver', async () => {
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

    const staleIntent = createValidIntent({
      basedOnContextFingerprint: 'fp-stale-old-fingerprint-999',
    });

    const result = await bridge.executeIntent(staleIntent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_STALE_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver/Executor must NEVER be called on stale fingerprint');
  });

  // ==========================================================================
  // Test 4: Project and Session Mismatch Rejection
  // ==========================================================================
  it('T4: Project or DirectorSession mismatch rejects execution and does NOT invoke Driver', async () => {
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

    const mismatchIntent = createValidIntent({
      projectId: 'completely-different-project-id',
    });

    const result = await bridge.executeIntent(mismatchIntent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_PROJECT_SESSION_MISMATCH');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver must NEVER be called on project mismatch');
  });

  // ==========================================================================
  // Test 5: Unmet Dependencies Rejection
  // ==========================================================================
  it('T5: Task with unmet prerequisite dependencies rejects execution and does NOT invoke Driver', async () => {
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

    // TASK-02 depends on TASK-01 which is not completed
    const unmetDepIntent = createValidIntent({
      executionIntentId: 'intent-task-02',
      taskId: 'TASK-02',
    });

    const result = await bridge.executeIntent(unmetDepIntent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_DEPENDENCIES_UNMET');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver must NEVER be called when dependencies are unmet');
  });

  // ==========================================================================
  // Test 6: Insufficient Budget Rejection
  // ==========================================================================
  it('T6: Insufficient budget rejects execution and does NOT invoke Driver', async () => {
    // Set project budget limit to 0
    budgetManager.updateBudgetLimit(0, `acc_proj_${canonicalProjectId}`);

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
    assert.equal(result.code, 'ERR_BUDGET_EXCEEDED');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver must NEVER be called when budget is exceeded');
  });

  // ==========================================================================
  // Test 7: Missing/Invalid Product Owner Approval Rejection
  // ==========================================================================
  it('T7: Missing or invalid Product Owner approval rejects execution and preserves PO boundary', async () => {
    // Change approval package status to PENDING
    await approvalStore.savePackage({
      ...approvedPackage,
      status: 'PENDING',
      approvalRecord: undefined,
    });

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
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver must NEVER be called without approved PO package');
  });

  // ==========================================================================
  // Test 8: Workspace Instance Lock Ownership Loss
  // ==========================================================================
  it('T8: Instance lock held by another process rejects execution immediately', async () => {
    // Overwrite lock with another PID
    await runtimeStateManager.save({
      processId: process.pid + 9999,
      acquiredLock: true,
      activeAttempt: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });

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
    assert.equal(result.code, 'ERR_INSTANCE_LOCK_NOT_HELD');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver must NEVER be called when instance lock is lost');
  });

  // ==========================================================================
  // Test 9: AGY Timeout / In-flight Failure Enters EXECUTION_UNKNOWN
  // ==========================================================================
  it('T9: AGY timeout transitions intent to EXECUTION_UNKNOWN and prevents automatic retry', async () => {
    mockExecutor.simulateTimeout = true;

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

    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_UNKNOWN);
    assert.equal(result.isSuccess, false);
    assert.equal(result.code, 'ERR_EXECUTION_TIMED_OUT');

    // Calling again with the same intent returns the cached UNKNOWN result without re-executing
    const secondResult = await bridge.executeIntent(intent);
    assert.equal(secondResult.status, ExecutionBridgeStatus.EXECUTION_UNKNOWN);
    assert.equal(mockExecutor.executionCallCount, 1, 'Timed-out intent must NEVER be automatically re-dispatched');
  });

  // ==========================================================================
  // Test 10: Restart Recovery for In-Flight Cycle
  // ==========================================================================
  it('T10: Restart recovery reconciles in-flight intent to EXECUTION_UNKNOWN preventing duplicate runs', async () => {
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

    const intent = createValidIntent({ executionIntentId: 'intent-crash-001' });

    // Simulate claiming the intent right before process death
    await bridge1.claimIntent(intent);

    // Simulate process death and new ExecutionBridge instance startup
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

    // Run recovery
    const recoveryReport = await bridge2.recover();
    assert.equal(recoveryReport.recoveredCount, 1);
    assert.equal(recoveryReport.reconciledIntents['intent-crash-001'], ExecutionBridgeStatus.EXECUTION_UNKNOWN);

    // Verify claim status in bridge2
    const claim = bridge2.getClaim('intent-crash-001');
    assert.ok(claim);
    assert.equal(claim.status, ExecutionBridgeStatus.EXECUTION_UNKNOWN);

    // Verify that attempting to execute this intent is rejected by idempotency
    const result = await bridge2.executeIntent(intent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.code, 'ERR_INTENT_ALREADY_CLAIMED');
    assert.equal(mockExecutor.executionCallCount, 0, 'Recovered intent must NOT be executed again');
  });

  // ==========================================================================
  // Test 11: AGY Self-Claim Output is NOT Accepted as Proof of Success
  // ==========================================================================
  it('T11: AGY verbal self-claim is rejected without independent filesystem verification', async () => {
    // AGY says "SUCCESS" with verbal claim, but doesn't actually produce modified files
    mockExecutor.simulateSelfClaimOnly = true;

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
  // Test 12: Task Not Marked COMPLETED Without Independent Evidence
  // ==========================================================================
  it('T12: Task DAG task remains uncompleted when independent verification fails', async () => {
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
    assert.equal(result.isSuccess, false);

    // Verify task in SpecStore did NOT transition to COMPLETED or ACCEPTED
    const tasks = await specStore.loadTasks();
    const target = tasks.find((t) => t.task_id === 'TASK-01');
    assert.ok(target);
    assert.notEqual(target.status, 'COMPLETED');
    assert.notEqual(target.status, 'ACCEPTED');
  });

  // ==========================================================================
  // Test 13: HistoryManager Event Sequencing & Audit Integrity
  // ==========================================================================
  it('T13: HistoryManager events are recorded in correct chronological sequence', async () => {
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
    await bridge.executeIntent(intent);

    const events = await historyManager.readEvents();
    const eventTypes = events.map((e) => e.eventType);

    // Verify presence and ordering of bridge lifecycle events
    const claimIdx = eventTypes.indexOf('EXECUTION_BRIDGE_INTENT_CLAIMED');
    const startIdx = eventTypes.indexOf('EXECUTION_BRIDGE_STARTED');
    const succIdx = eventTypes.indexOf('EXECUTION_BRIDGE_SUCCEEDED');

    assert.ok(claimIdx >= 0, 'Must record EXECUTION_BRIDGE_INTENT_CLAIMED');
    assert.ok(startIdx >= 0, 'Must record EXECUTION_BRIDGE_STARTED');
    assert.ok(succIdx >= 0, 'Must record EXECUTION_BRIDGE_SUCCEEDED');

    assert.ok(claimIdx < startIdx, 'CLAIMED must precede STARTED');
    assert.ok(startIdx < succIdx, 'STARTED must precede SUCCEEDED');
  });
});
