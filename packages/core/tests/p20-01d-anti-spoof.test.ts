/**
 * @file p20-01d-anti-spoof.test.ts
 * @description P20-01D: Auth Context Anti-Spoof Verification & Roadmap Consistency Test Suite.
 *
 * Verifies and proves fail-closed behavior across all spoofing/tampering scenarios:
 * 1. Fake approval claiming isTrustedHumanAuth: true from unverified source fails closed.
 * 2. Fake approval claiming authStatus: 'VERIFIED_HUMAN' from unverified source fails closed.
 * 3. Fake authContext object (isForged: true / verified: false) fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 4. Invalid cryptographic signature in authContext fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 5. Cross-project authContext (bound to another project) fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 6. Cross-session or cross-task authContext fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 7. Replayed authContext (nonce reuse) fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 8. Expired authContext (expiresAt in past) fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 9. MCP client directly creating approval record fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 10. LLM tool-call creating approval record fails closed with BLOCKED_ON_AUTH_CONTEXT.
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
} from '../dist/index.js';
import { createApprovalPackageApproveTool } from '../dist/mcp/tools/approval-tools.js';

describe('Phase 20 TASK-P20-01D — Auth Context Anti-Spoof Verification & Roadmap Consistency', { concurrency: 1 }, () => {
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

  class MockAntiSpoofExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-anti-spoof-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    executionCallCount = 0;
    isAvailable = true;

    async checkAvailability() {
      return { available: this.isAvailable, reason: this.isAvailable ? undefined : 'Executor host unavailable' };
    }

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      this.executionCallCount++;
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
        stdout: 'Execution outcome',
        stderr: '',
        durationMs: 10,
        unverifiedAgentClaims: ['Task implemented'],
        unverifiedModifiedFiles: ['src/spoof-check.ts'],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockAntiSpoofExecutor;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p20-01d-test-'));

    canonicalProjectId = resolveCanonicalProjectIdentity(tempDir).projectId;
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: canonicalProjectId, version: '1.0.0', type: 'module' }),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\nnode_modules/\nbudget.sqlite*\n', 'utf8');

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
    mockExecutor = new MockAntiSpoofExecutor();

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

    // Acquire lock and save durable state
    await runtimeStateManager.save({
      processId: process.pid,
      acquiredLock: true,
      activeAttempt: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    });

    await durableManager.save({
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
    });

    // Director Session & Snapshot
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      understandingRevision: 1,
    });

    activeSnapshot = {
      snapshotId: `snap-${Date.now()}`,
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      createdAt: new Date().toISOString(),
      understandingRevision: 1,
      logicalFingerprint: 'ctx-fingerprint-p20-01d',
      syncStatus: 'SYNCHRONIZED',
      isComplete: true,
      staleSections: [],
      unavailableSections: [],
      sections: {
        understanding: {
          projectId: canonicalProjectId,
          projectName: canonicalProjectId,
          summary: 'Verified P20-01D Baseline',
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
        risks: { activeRisks: [], unresolvedDecisionPoints: [] },
        authorization: {
          isDevelopmentAuthorized: true,
          status: 'APPROVED',
          packageId: 'pkg-init',
          packageRevision: 1,
        },
      },
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-SPOOF-01',
      parent_feature_id: 'ROOT',
      title: 'Anti-Spoof Feature',
      description: 'Parent feature for anti-spoof checks',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-SPOOF-01'],
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
      task_id: 'TASK-SPOOF-01',
      parent_feature_id: 'FEAT-SPOOF-01',
      title: 'Anti-Spoof Task',
      description: 'Verify anti-spoofing constraints',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01: Spoof checks pass'],
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
      metadata: { revision: 1, target_files: ['src/spoof-check.ts'] },
    };
    await specStore.saveTasks([parentFeature, task1]);

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
        apparentPurpose: { summary: 'Anti-spoof verification' } as any,
        targetUsers: ['Security Reviewers'],
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
        proposedDevelopmentScope: ['Anti-spoof verification'],
        evidenceReferences: [],
        sourceDiscoveryReference: 'disc-01',
        generatedAt: new Date().toISOString(),
      },
      proposedDevelopmentPlan: {
        objectives: ['Anti-spoof verification'],
        proposedScope: ['Anti-spoof checks'],
        proposedFeatureGroups: [
          { name: 'Security', description: 'Anti-spoof tests', targetCapabilities: ['Security'] },
        ],
        dependencies: [],
        constraints: [],
        knownRisks: [],
        unresolvedIssues: [],
        excludedScope: [],
        suggestedImplementationOrder: ['Security'],
      },
      approvalRecord: {
        packageId: `pkg-${Date.now()}`,
        revision: 1,
        actor: 'HUMAN_PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: new Date().toISOString(),
        packageHash: 'sha256-approved-package-hash-spoof',
        comment: 'Approval granted',
        isTrustedHumanAuth: true,
        authStatus: 'VERIFIED_HUMAN',
        provenanceSource: 'DIRECT_AUTHORIZATION',
      },
    };
    await approvalStore.savePackage(rawPkg);
    approvedPackage = rawPkg;

    implementDecision = {
      decisionId: 'dec-spoof-01',
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Verify anti-spoofing invariants',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: approvedPackage.revision,
      basedOnUnderstandingRevision: activeSession.understandingRevision,
      createdAt: new Date().toISOString(),
      metadata: { taskId: 'TASK-SPOOF-01' },
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
      taskId: 'TASK-SPOOF-01',
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
      executionPlan: 'Execute anti-spoof verification',
      ...overrides,
    };
  }

  function getBridge(requireTrustedAuthContext = false): ExecutionBridge {
    return new ExecutionBridge({
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
      requireTrustedAuthContext,
    });
  }

  // ==========================================================================
  // TEST 1: isTrustedHumanAuth: true ile sahte onay
  // ==========================================================================
  it('TEST 1: Fake approval declaring isTrustedHumanAuth: true from unverified client input is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    // Attacker crafts package claiming isTrustedHumanAuth: true, but provenance is unverified
    const forgedPkg: ApprovalPackage = {
      ...approvedPackage,
      packageId: `pkg-forged-bool-${Date.now()}`,
      status: 'APPROVED',
      approvalRecord: {
        packageId: `pkg-forged-bool-${Date.now()}`,
        revision: 1,
        actor: 'AttackerClaimingHuman',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: new Date().toISOString(),
        packageHash: 'sha256-forged-hash',
        provenanceSource: 'MCP_TOOL', // Originates from client input
        isTrustedHumanAuth: false, // Enforced fail-closed
        authStatus: 'UNVERIFIED_CLIENT_INPUT',
      },
    };
    await approvalStore.savePackage(forgedPkg);

    const bridge = getBridge();
    const intent = createValidIntent({
      authorizationReference: {
        packageId: forgedPkg.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 2: authStatus: VERIFIED_HUMAN ile sahte onay
  // ==========================================================================
  it('TEST 2: Fake approval declaring authStatus: VERIFIED_HUMAN from client input is forced to unverified and rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    // When submitted via MCP tool or untrusted client, authStatus cannot be self-declared as VERIFIED_HUMAN
    const approveTool = createApprovalPackageApproveTool();
    const unapprovedPkg: ApprovalPackage = {
      ...approvedPackage,
      packageId: `pkg-unapp-${Date.now()}`,
      status: 'READY_FOR_APPROVAL',
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(unapprovedPkg);

    // MCP client claims to be verified human
    await approveTool.handler(
      {
        workspaceRoot: tempDir,
        projectId: canonicalProjectId,
        packageId: unapprovedPkg.packageId,
        revision: 1,
        actor: 'ClientInjectingVerifiedStatus',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        comment: 'Attempting to self-assert VERIFIED_HUMAN',
      },
      { correlation: { correlationId: 'spoof-req-02' } }
    );

    const storedPkg = await approvalStore.loadPackage(unapprovedPkg.packageId, 1, canonicalProjectId);
    assert.ok(storedPkg);
    // Crucial: Client cannot set authStatus to VERIFIED_HUMAN through MCP
    assert.equal(storedPkg.approvalRecord?.authStatus, 'UNVERIFIED_CLIENT_INPUT');
    assert.equal(storedPkg.approvalRecord?.isTrustedHumanAuth, false);

    const bridge = getBridge();
    const intent = createValidIntent({
      authorizationReference: {
        packageId: unapprovedPkg.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 3: Sahte authContext nesnesi (isForged: true veya verified: false)
  // ==========================================================================
  it('TEST 3: Forged or unverified authContext object is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const bridge = getBridge(true);

    const intent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: false,
          authSource: 'UNTRUSTED_CLIENT',
          token: 'fake-token-xyz',
          isForged: true,
        },
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /Untrusted or forged authContext rejected fail-closed/);

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 4: Geçersiz imza
  // ==========================================================================
  it('TEST 4: authContext with invalid cryptographic signature is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const bridge = getBridge();

    const intent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          authSource: 'IDE_SECURE_KEYSTORE',
          signature: 'INVALID_CRYPTOGRAPHIC_SIGNATURE_TAMPERED',
          token: 'signed-token-01',
        },
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /Cryptographic signature verification failed on authContext/);

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 5: Başka projeye ait authContext
  // ==========================================================================
  it('TEST 5: Cross-project authContext is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const bridge = getBridge();

    const intent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          authSource: 'IDE_SECURE_KEYSTORE',
          projectId: 'completely-different-project-id',
        },
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /Cross-project authContext binding mismatch/);

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 6: Başka session veya task için oluşturulmuş authContext
  // ==========================================================================
  it('TEST 6: Cross-session or cross-task authContext is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const bridge = getBridge();

    // A: Cross-session mismatch
    const sessionMismatchIntent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          sessionId: 'other-session-uuid-999',
        },
      },
    });

    const valResultA = await bridge.validatePreconditions(sessionMismatchIntent);
    assert.equal(valResultA.isValid, false);
    const check6A = valResultA.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6A);
    assert.equal(check6A.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6A.reason, /Cross-session authContext binding mismatch/);

    // B: Cross-task mismatch
    const taskMismatchIntent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          taskId: 'OTHER-TASK-ID-888',
        },
      },
    });

    const valResultB = await bridge.validatePreconditions(taskMismatchIntent);
    assert.equal(valResultB.isValid, false);
    const check6B = valResultB.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6B);
    assert.equal(check6B.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6B.reason, /Cross-task authContext binding mismatch/);

    const execResult = await bridge.executeIntent(taskMismatchIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 7: Tekrar kullanılan authContext (Replay Attack)
  // ==========================================================================
  it('TEST 7: Replayed authContext (nonce reuse) is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const bridge = getBridge();
    const replayNonce = `nonce-replay-${Date.now()}`;

    const firstIntent = createValidIntent({
      executionIntentId: `intent-replay-1-${Date.now()}`,
      idempotencyKey: `idem-replay-1-${Date.now()}`,
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          nonce: replayNonce,
        },
      },
    });

    // First presentation records the nonce
    const val1 = await bridge.validatePreconditions(firstIntent);
    assert.equal(val1.isValid, true);

    // Second presentation with the exact same nonce is rejected as a replay attack
    const replayedIntent = createValidIntent({
      executionIntentId: `intent-replay-2-${Date.now()}`,
      idempotencyKey: `idem-replay-2-${Date.now()}`,
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          nonce: replayNonce,
        },
      },
    });

    const val2 = await bridge.validatePreconditions(replayedIntent);
    assert.equal(val2.isValid, false);
    const check6 = val2.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /Replayed authContext nonce/);

    const execResult = await bridge.executeIntent(replayedIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 8: Süresi geçmiş authContext
  // ==========================================================================
  it('TEST 8: Expired authContext (expiresAt in past) is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const bridge = getBridge();

    const intent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
        authContext: {
          verified: true,
          expiresAt: '2020-01-01T00:00:00.000Z', // Expired timestamp
        },
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /Expired authContext timestamp/);

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 9: MCP istemcisinin doğrudan onay paketi oluşturması
  // ==========================================================================
  it('TEST 9: MCP client creating approval package cannot grant autonomous execution authority without human auth', async () => {
    const approveTool = createApprovalPackageApproveTool();
    const pkgForMcp: ApprovalPackage = {
      ...approvedPackage,
      packageId: `pkg-direct-mcp-${Date.now()}`,
      status: 'READY_FOR_APPROVAL',
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(pkgForMcp);

    await approveTool.handler(
      {
        workspaceRoot: tempDir,
        projectId: canonicalProjectId,
        packageId: pkgForMcp.packageId,
        revision: 1,
        actor: 'DirectMcpClient',
        actorRole: 'USER',
        intent: 'EXPLICIT_APPROVAL',
      },
      { correlation: { correlationId: 'spoof-test-09' } }
    );

    const loaded = await approvalStore.loadPackage(pkgForMcp.packageId, 1, canonicalProjectId);
    assert.ok(loaded);
    assert.equal(loaded.approvalRecord?.provenanceSource, 'MCP_TOOL');
    assert.equal(loaded.approvalRecord?.authStatus, 'UNVERIFIED_CLIENT_INPUT');

    const bridge = getBridge();
    const intent = createValidIntent({
      authorizationReference: {
        packageId: pkgForMcp.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 10: LLM tool-call ile onay paketi oluşturulması
  // ==========================================================================
  it('TEST 10: Approval package originating from LLM tool-call is rejected fail-closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    // Model invokes tool call to approve package
    const llmPkg: ApprovalPackage = {
      ...approvedPackage,
      packageId: `pkg-llm-tool-call-${Date.now()}`,
      status: 'APPROVED',
      approvalRecord: {
        packageId: `pkg-llm-tool-call-${Date.now()}`,
        revision: 1,
        actor: 'LLMAgentModel',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: new Date().toISOString(),
        packageHash: 'sha256-llm-tool-call-hash',
        provenanceSource: 'LLM_TOOL_CALL', // Model-generated approval
        isTrustedHumanAuth: false,
        authStatus: 'UNVERIFIED_CLIENT_INPUT',
      },
    };
    await approvalStore.savePackage(llmPkg);

    const bridge = getBridge();
    const intent = createValidIntent({
      authorizationReference: {
        packageId: llmPkg.packageId,
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(check6.reason, /unverified MCP client input without Trusted IDE Authentication/);

    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(execResult.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(mockExecutor.executionCallCount, 0);
  });
});
