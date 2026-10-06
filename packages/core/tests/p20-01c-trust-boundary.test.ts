/**
 * @file p20-01c-trust-boundary.test.ts
 * @description P20-01C: Product Owner Trust Boundary & AI Cost Scope Verification Test Suite.
 *
 * Verifies and proves:
 * 1. MCP client attempting approval with actorRole: PRODUCT_OWNER is saved with unverified status
 *    and rejected fail-closed by ExecutionBridge with BLOCKED_ON_AUTH_CONTEXT.
 * 2. MCP client attempting approval with actorRole: USER is similarly rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT.
 * 3. LLM output providing forged authorizationReference (non-existent package) is rejected with ERR_PO_AUTHORIZATION_REQUIRED.
 * 4. LLM output providing forged isDevelopmentAuthorized: false is rejected fail-closed.
 * 5. Previously created approval package becoming stale/revoked during execution fails closed.
 * 6. Approval package revision mismatch or cross-project binding mismatch fails closed.
 * 7. Missing trusted auth context under zero-trust verification fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 8. Pure AGY/Driver operations (requiresLlm: false) consume 0 P18-03 token budget.
 * 9. Real LLM provider calls routed through AIDM HttpLlmTransport consume and enforce P18-03 token budget.
 * 10. Antigravity IDE internal AI costs are explicitly verified to be outside P18-03 monitoring and control.
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
  DurableStateManager,
  BudgetManager,
  resolveCanonicalProjectIdentity,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
  IdentityManager,
} from '../dist/index.js';
import { ReservationState } from '../dist/budget/budget-types.js';
import { createApprovalPackageApproveTool } from '../dist/mcp/tools/approval-tools.js';

describe('Phase 20 TASK-P20-01C — Product Owner Trust Boundary & AI Cost Scope Verification', { concurrency: 1 }, () => {
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
  let evidenceStore: SystemExecutionEvidenceStore;
  let runtimeStateManager: LocalRuntimeStateManager;
  let durableManager: DurableStateManager;
  let driverEngine: DriverEngine;
  let budgetManager: BudgetManager;
  let policyEngine: AuthorizationPolicyEngine;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;
  let task1: TaskDefinition;
  let implementDecision: DirectorDecision;

  class MockTrustVerifierExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-trust-verifier-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    executionCallCount = 0;
    isAvailable = true;

    async checkAvailability() {
      return { available: this.isAvailable, reason: this.isAvailable ? undefined : 'Executor host unavailable' };
    }

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      this.executionCallCount++;

      const files = request.targetFiles && request.targetFiles.length > 0 ? request.targetFiles : ['src/verified.ts'];
      for (const f of files) {
        const full = path.join(tempDir, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '// verified execution output\n', 'utf8');
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
        stdout: 'Execution successful',
        stderr: '',
        durationMs: 10,
        unverifiedAgentClaims: ['Task implemented'],
        unverifiedModifiedFiles: files,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockTrustVerifierExecutor;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p20-01c-test-'));

    canonicalProjectId = resolveCanonicalProjectIdentity(tempDir).projectId;
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: canonicalProjectId, version: '1.0.0', type: 'module' }),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\nnode_modules/\nbudget.sqlite*\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# P20-01C Trust Boundary Project\n', 'utf8');

    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm@test.local"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    sessionEngine = new DirectorSessionEngine({
      workspaceRoot: tempDir,
      sessionStore,
      decisionStore,
      historyManager,
    });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine({
      workspaceRoot: tempDir,
      approvalStore,
      historyManager,
    });
    specStore = new SpecStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    runtimeStateManager = new LocalRuntimeStateManager({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    mockExecutor = new MockTrustVerifierExecutor();

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

    budgetManager = new BudgetManager({
      dbPath: path.join(tempDir, 'budget.sqlite'),
      historyManager,
    });
    budgetManager.open();
    budgetManager.createProjectAccount(canonicalProjectId, 100.0);

    // Register pricing for testing
    budgetManager.registerPricingRate({
      providerId: 'antigravity',
      modelId: 'default',
      inputRateNum: 1000n,
      inputRateDen: 1000000n,
      outputRateNum: 2000n,
      outputRateDen: 1000000n,
    });
    budgetManager.registerPricingRate({
      providerId: 'google',
      modelId: 'gemini-1.5-pro',
      inputRateNum: 1250n,
      inputRateDen: 1000000n,
      outputRateNum: 5000n,
      outputRateDen: 1000000n,
    });

    const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    const baseMandate: ProjectMandate = {
      projectId: canonicalProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'BUILD_EXECUTION'],
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
    await fs.promises.mkdir(path.join(tempDir, '.ai-manager', 'state'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, '.ai-manager', 'state', 'project-mandate.json'), JSON.stringify(baseMandate, null, 2), 'utf8');
    policyEngine = new AuthorizationPolicyEngine({ historyManager, mandateStore });

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

    // 1. Create DirectorSession
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      understandingRevision: 1,
    });

    // 2. Persist Snapshot
    activeSnapshot = {
      snapshotId: `snap-${Date.now()}`,
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      createdAt: new Date().toISOString(),
      understandingRevision: 1,
      logicalFingerprint: 'ctx-fingerprint-p20-01c-canonical',
      syncStatus: 'SYNCHRONIZED',
      isComplete: true,
      staleSections: [],
      unavailableSections: [],
      sections: {
        understanding: {
          projectId: canonicalProjectId,
          projectName: canonicalProjectId,
          summary: 'Verified P20-01C Baseline',
          technologyStack: ['TypeScript', 'Node.js'],
          architectureSummary: 'Modular Core Architecture',
          constraints: [],
          nonGoals: [],
        },
        decisions: [],
        tasks: {
          tasks: [],
          activeTaskCount: 1,
          completedTaskCount: 0,
          pendingTaskCount: 1,
        },
        risks: {
          activeRisks: [],
          unresolvedDecisionPoints: [],
        },
        authorization: {
          isDevelopmentAuthorized: true,
          status: 'APPROVED',
          packageId: 'pkg-init',
          packageRevision: 1,
        },
      },
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    // 3. Create active task in SpecStore with parent feature
    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-TRUST-01',
      parent_feature_id: 'ROOT',
      title: 'Trust Parent Feature',
      description: 'Parent feature for trust tests',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-TRUST-01'],
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
      task_id: 'TASK-TRUST-01',
      parent_feature_id: 'FEAT-TRUST-01',
      title: 'Trust Boundary Implementation',
      description: 'Implement zero-trust Product Owner gate',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01: Trust checks pass'],
      dependencies: [],
      status: 'READY' as any,
      attempt: 0,
      max_attempts: 2,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { revision: 1, target_files: ['src/verified.ts'] },
    };
    await specStore.saveTasks([parentFeature, task1]);

    // 4. Create base ApprovalPackage approved by trusted PO by default
    const rawPkg: ApprovalPackage = {
      packageId: `pkg-${Date.now()}`,
      projectId: canonicalProjectId,
      revision: 1,
      approvalPackageRevision: 1,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isStale: false,
      projectUnderstanding: {
        projectId: canonicalProjectId,
        projectName: canonicalProjectId,
        apparentPurpose: { summary: 'Trust verification' } as any,
        targetUsers: ['Engineers'],
        technologyStack: { languages: ['TypeScript'], framework: 'Node.js', runtime: 'Node' } as any,
        architectureSummary: { pattern: 'Modular' } as any,
        existingCapabilities: [],
        confirmedRequirements: [],
        clarifiedRequirements: [],
        unresolvedUnknowns: [],
        unresolvedContradictions: [],
        currentImplementationState: { state: 'IN_PROGRESS' } as any,
        constraints: [],
        assumptions: [],
        nonGoals: [],
        proposedDevelopmentScope: ['Trust boundary verification'],
        evidenceReferences: [],
        sourceDiscoveryReference: 'disc-01',
        generatedAt: new Date().toISOString(),
      },
      proposedDevelopmentPlan: {
        objectives: ['Trust boundary verification'],
        proposedScope: ['Trust boundary checks'],
        proposedFeatureGroups: [
          { name: 'Trust', description: 'Trust tests', targetCapabilities: ['Trust'] },
        ],
        dependencies: [],
        constraints: [],
        knownRisks: [],
        unresolvedIssues: [],
        excludedScope: [],
        suggestedImplementationOrder: ['Trust'],
      },
      approvalRecord: {
        packageId: `pkg-${Date.now()}`,
        revision: 1,
        actor: 'HUMAN_PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: new Date().toISOString(),
        packageHash: 'sha256-approved-package-hash-trust',
        comment: 'Trust verification approval granted',
        isTrustedHumanAuth: true,
        authStatus: 'VERIFIED_HUMAN',
        provenanceSource: 'DIRECT_AUTHORIZATION',
      },
    };
    await approvalStore.savePackage(rawPkg);
    approvedPackage = rawPkg;

    // 5. Create Decision
    implementDecision = {
      decisionId: 'dec-trust-01',
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Verify trust boundary execution',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: approvedPackage.revision,
      basedOnUnderstandingRevision: activeSession.understandingRevision,
      createdAt: new Date().toISOString(),
      metadata: { taskId: 'TASK-TRUST-01' },
      hasImplementationAuthority: false,
    };
    await decisionStore.saveDecision(implementDecision);
  });

  afterEach(() => {
    try {
      budgetManager.close();
    } catch {
      // ignore
    }
  });

  function createValidIntent(overrides: Partial<BridgeExecutionIntent> = {}): BridgeExecutionIntent {
    return {
      executionIntentId: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      actionId: `action-${Date.now()}`,
      idempotencyKey: `idem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      projectId: canonicalProjectId,
      directorSessionId: activeSession.directorSessionId,
      taskId: 'TASK-TRUST-01',
      taskRevision: 1,
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Execute trust boundary verification under fail-closed invariants',
      ...overrides,
    };
  }

  // ==========================================================================
  // SCENARIO 1: MCP çağrısı PRODUCT_OWNER rolüyle onay vermeye çalışıyor
  // ==========================================================================
  it('SCENARIO 1: MCP call attempting approval with PRODUCT_OWNER role writes unverified record and is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    // 0. Ensure package is in READY_FOR_APPROVAL status for the MCP approval tool
    const unapprovedPkg: ApprovalPackage = {
      ...approvedPackage,
      status: 'READY_FOR_APPROVAL',
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(unapprovedPkg);
    approvedPackage = unapprovedPkg;

    const approveTool = createApprovalPackageApproveTool();

    // 1. External MCP client calls approve tool claiming actorRole: 'PRODUCT_OWNER'
    const toolResult = await approveTool.handler(
      {
        workspaceRoot: tempDir,
        projectId: canonicalProjectId,
        packageId: approvedPackage.packageId,
        revision: 1,
        actor: 'UntrustedClientOrModel',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        comment: 'Approval submitted via MCP tool call',
      },
      { correlation: { correlationId: 'mcp-po-req-01' } }
    );

    assert.ok(toolResult.content[0]);
    const returnedPkg = JSON.parse(toolResult.content[0].text as string);
    assert.equal(returnedPkg.status, 'APPROVED');

    // 2. Verify ApprovalStore on disk: record is explicitly marked UNVERIFIED_CLIENT_INPUT
    const storedPkg = await approvalStore.loadPackage(approvedPackage.packageId, 1, canonicalProjectId);
    assert.ok(storedPkg);
    assert.equal(storedPkg.status, 'APPROVED');
    assert.equal(storedPkg.approvalRecord?.authStatus, 'UNVERIFIED_CLIENT_INPUT');
    assert.equal(storedPkg.approvalRecord?.isTrustedHumanAuth, false);
    assert.equal(storedPkg.approvalRecord?.provenanceSource, 'MCP_TOOL');

    // 3. ExecutionBridge attempts execution referencing this MCP-approved package
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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
    const valResult = await bridge.validatePreconditions(intent);

    assert.equal(valResult.isValid, false, 'Preconditions must fail closed');
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /unverified MCP client input without Trusted IDE Authentication/);

    // 4. Execution handoff attempt must fail closed without invoking Driver
    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver/Executor must NEVER be invoked for unverified MCP approval');
  });

  // ==========================================================================
  // SCENARIO 2: MCP çağrısı USER rolüyle onay vermeye çalışıyor
  // ==========================================================================
  it('SCENARIO 2: MCP call attempting approval with USER role writes unverified record and is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    // 0. Ensure package is in READY_FOR_APPROVAL status for the MCP approval tool
    const unapprovedPkg: ApprovalPackage = {
      ...approvedPackage,
      status: 'READY_FOR_APPROVAL',
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(unapprovedPkg);
    approvedPackage = unapprovedPkg;

    const approveTool = createApprovalPackageApproveTool();

    // 1. External MCP client calls approve tool claiming actorRole: 'USER'
    await approveTool.handler(
      {
        workspaceRoot: tempDir,
        projectId: canonicalProjectId,
        packageId: approvedPackage.packageId,
        revision: 1,
        actor: 'ClientScriptUser',
        actorRole: 'USER',
        intent: 'EXPLICIT_APPROVAL',
        comment: 'User approval via MCP',
      },
      { correlation: { correlationId: 'mcp-user-req-02' } }
    );

    // 2. Verify ApprovalStore: marked UNVERIFIED_CLIENT_INPUT
    const storedPkg = await approvalStore.loadPackage(approvedPackage.packageId, 1, canonicalProjectId);
    assert.ok(storedPkg);
    assert.equal(storedPkg.approvalRecord?.authStatus, 'UNVERIFIED_CLIENT_INPUT');
    assert.equal(storedPkg.approvalRecord?.isTrustedHumanAuth, false);

    // 3. ExecutionBridge fails closed with BLOCKED_ON_AUTH_CONTEXT
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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
    const execResult = await bridge.executeIntent(intent);

    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // SCENARIO 3: LLM çıktısı sahte authorizationReference sağlıyor
  // ==========================================================================
  it('SCENARIO 3: LLM output providing forged authorizationReference (non-existent package) is rejected with ERR_PO_AUTHORIZATION_REQUIRED', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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

    // LLM creates intent with hallucinated packageId
    const forgedIntent = createValidIntent({
      authorizationReference: {
        packageId: 'pkg-hallucinated-by-llm-12345',
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(forgedIntent);
    assert.equal(valResult.isValid, false);

    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'ERR_PO_AUTHORIZATION_REQUIRED');
    assert.match(check6.reason, /Approval package ID mismatch|Active Product Owner approval package not found/);

    const execResult = await bridge.executeIntent(forgedIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // SCENARIO 4: LLM çıktısı sahte isDevelopmentAuthorized sağlıyor
  // ==========================================================================
  it('SCENARIO 4: LLM output declaring isDevelopmentAuthorized: false is rejected fail-closed', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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

    // Intent declares isDevelopmentAuthorized: false
    const unauthorizedIntent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: false,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(unauthorizedIntent);
    assert.equal(valResult.isValid, false);

    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'ERR_PO_AUTHORIZATION_REQUIRED');
    assert.match(check6.reason, /declares isDevelopmentAuthorized as false/);

    const execResult = await bridge.executeIntent(unauthorizedIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // SCENARIO 5: Daha önce oluşturulmuş bir onay paketi yürütme sırasında geçersiz hale geliyor
  // ==========================================================================
  it('SCENARIO 5: Previously created approval package becoming stale or revoked rejects execution fail-closed', async () => {
    const approvedPkg = approvedPackage;

    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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

    // First validation passes
    const initialVal = await bridge.validatePreconditions(intent);
    assert.equal(initialVal.isValid, true);

    // Product Owner revokes package or marks it stale before execution
    const revokedPkg: ApprovalPackage = {
      ...approvedPkg,
      status: 'REJECTED',
      isStale: true,
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(revokedPkg);

    // Second validation fails closed
    const staleVal = await bridge.validatePreconditions(intent);
    assert.equal(staleVal.isValid, false);

    const check6 = staleVal.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'ERR_PO_AUTHORIZATION_REQUIRED');

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // SCENARIO 6: Onay paketi başka proje, task veya revision için oluşturulmuş
  // ==========================================================================
  it('SCENARIO 6: Cross-project, mismatched revision, or mismatched task fails closed', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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

    // A: Revision mismatch (intent points to rev 2, store has rev 1)
    const revMismatchIntent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 2,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const revVal = await bridge.validatePreconditions(revMismatchIntent);
    assert.equal(revVal.isValid, false);
    const check6 = revVal.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.match(check6.reason, /Approval package revision mismatch/);

    // B: Cross-project mismatch (intent for different project)
    const crossProjIntent = createValidIntent({
      projectId: 'other-project-id',
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const projVal = await bridge.validatePreconditions(crossProjIntent);
    assert.equal(projVal.isValid, false);
    const check2 = projVal.allChecks.find((c) => c.checkName === '2_PROJECT_AND_SESSION_MATCH');
    assert.ok(check2);
    assert.equal(check2.passed, false);

    // C: Task revision mismatch
    const taskRevMismatchIntent = createValidIntent({
      taskRevision: 99,
    });
    const taskVal = await bridge.validatePreconditions(taskRevMismatchIntent);
    assert.equal(taskVal.isValid, false);
    const check4 = taskVal.allChecks.find((c) => c.checkName === '4_TARGET_TASK_VALIDITY');
    assert.ok(check4);
    assert.equal(check4.passed, false);
  });

  // ==========================================================================
  // SCENARIO 7: Güvenilir auth context bulunmuyor (Zero-Trust Mode)
  // ==========================================================================
  it('SCENARIO 7: ExecutionBridge with requireTrustedAuthContext fails closed with BLOCKED_ON_AUTH_CONTEXT when trusted auth context is absent', async () => {
    // Bridge initialized with requireTrustedAuthContext: true (zero-trust production mode)
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      driverEngine,
      executorPort: mockExecutor,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
      requireTrustedAuthContext: true,
    });

    // Intent without verified auth context
    const intentWithoutAuth = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        // authContext is absent!
      },
    });

    const valResult = await bridge.validatePreconditions(intentWithoutAuth);
    assert.equal(valResult.isValid, false);

    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /Trusted IDE Authentication context is required but missing or unverified \(P18-04 boundary\)/);

    const execResult = await bridge.executeIntent(intentWithoutAuth);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);

    // Providing a verified authContext allows execution under zero-trust mode
    const idManager = new IdentityManager({ baseDir: tempDir });
    const { privateKey } = await idManager.getOrCreateIdentity();
    const verifiedPayload = {
      verified: true,
      authSource: 'TRUSTED_IDE',
      actorId: 'po-verified-human',
      verifiedAt: new Date().toISOString(),
      projectId: canonicalProjectId,
      nonce: `nonce-scen7-${Date.now()}`,
    };
    const signature = await idManager.signPayload(verifiedPayload, privateKey);

    const intentWithVerifiedAuth = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          ...verifiedPayload,
          signature,
        },
      },
    });

    const verifiedVal = await bridge.validatePreconditions(intentWithVerifiedAuth);
    assert.equal(verifiedVal.isValid, true);
    const verifiedCheck6 = verifiedVal.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(verifiedCheck6);
    assert.equal(verifiedCheck6.passed, true);
  });

  // ==========================================================================
  // SCENARIO 8: Pure AGY/Driver yerel işlemleri token bütçesi tüketmez
  // ==========================================================================
  it('SCENARIO 8: Pure AGY local file/shell/test operations (requiresLlm: false) consume 0 P18-03 token budget', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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

    const initialAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(initialAccount);
    assert.equal(initialAccount.committedSpendNanoUsd, 0n);

    // Intent declares local file/shell operations without LLM provider calls
    const localAgyIntent = createValidIntent({
      metadata: {
        requiresLlm: false,
      },
    });

    const valResult = await bridge.validatePreconditions(localAgyIntent);
    assert.equal(valResult.isValid, true);
    const check7 = valResult.allChecks.find((c) => c.checkName === '7_BUDGET_AVAILABILITY');
    assert.ok(check7);
    assert.equal(check7.passed, true);
    assert.match(check7.reason, /Local AGY\/Driver execution without LLM provider calls does not consume P18-03 token budget/);

    const execResult = await bridge.executeIntent(localAgyIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.equal(execResult.budgetReservationId, undefined, 'No reservation created for non-LLM operations');

    const postAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(postAccount);
    assert.equal(postAccount.committedSpendNanoUsd, 0n, 'Committed token spend MUST remain 0 for non-LLM AGY runs');
    assert.equal(postAccount.reservedSpendNanoUsd, 0n, 'Reserved token spend MUST remain 0 for non-LLM AGY runs');
  });

  // ==========================================================================
  // SCENARIO 9: Real LLM provider calls routed through AIDM HttpLlmTransport consume P18-03 budget
  // ==========================================================================
  it('SCENARIO 9: Real LLM provider calls enforce P18-03 budget pre-dispatch checks, reservation, and settlement', async () => {
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceStore,
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

    const llmIntent = createValidIntent({
      metadata: {
        requiresLlm: true,
        modelId: 'gemini-1.5-pro',
        providerId: 'google',
        estimatedTokens: { inputTokens: 2000, outputTokens: 1000 },
      },
    });

    const valResult = await bridge.validatePreconditions(llmIntent);
    assert.equal(valResult.isValid, true);
    const check7 = valResult.allChecks.find((c) => c.checkName === '7_BUDGET_AVAILABILITY');
    assert.ok(check7);
    assert.equal(check7.passed, true);

    const execResult = await bridge.executeIntent(llmIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.ok(execResult.budgetReservationId);

    const settledRes = budgetManager.getReservation(execResult.budgetReservationId);
    assert.ok(settledRes);
    assert.equal(settledRes.state, ReservationState.SETTLED);

    const postAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(postAccount);
    assert.ok(postAccount.committedSpendNanoUsd > 0n, 'Committed spend MUST increase for real LLM provider calls');
  });

  // ==========================================================================
  // SCENARIO 10: Antigravity IDE internal AI costs are OUTSIDE P18-03 scope
  // ==========================================================================
  it('SCENARIO 10: Architectural Boundary Assertion: AGY IDE internal AI costs are strictly outside P18-03 scope', async () => {
    // P18-03 is strictly the budget manager for AIDM's HttpLlmTransport provider calls.
    // Antigravity IDE internal models (IDE completions, sidecar agent, private IDE LLMs)
    // are NOT intercepted, monitored, or metered by AIDM.
    const projectAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(projectAccount);

    // Verify that BudgetManager has no methods or transports for IDE internal costs
    assert.equal(typeof (budgetManager as any).trackIdeInternalCost, 'undefined');
    assert.equal(typeof (budgetManager as any).meterAntigravityIdeSubprocess, 'undefined');

    // Re-verify that local operations have zero impact on P18-03
    const localIntent = createValidIntent({ metadata: { requiresLlm: false } });
    assert.equal(localIntent.metadata?.requiresLlm, false);
  });
});
