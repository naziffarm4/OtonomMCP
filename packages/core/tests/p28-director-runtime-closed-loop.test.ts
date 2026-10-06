/**
 * @file p28-director-runtime-closed-loop.test.ts
 * @description Comprehensive Test Suite for Phase 28 (P28):
 * DirectorRuntime Integration into the Authoritative Closed Loop.
 *
 * Covers 30 distinct scenarios verifying:
 * 1. Runtime integration (Scenarios 1-5)
 * 2. Authority boundaries (Scenarios 6-10)
 * 3. Context & Fingerprint validation (Scenarios 11-14)
 * 4. Idempotency guarantees (Scenarios 15-16)
 * 5. Human gate actions (Scenarios 17-19)
 * 6. Completion boundary (Scenarios 20-21)
 * 7. Failure safety & fail-closed behavior (Scenarios 22-25)
 * 8. End-to-end closed loop execution (Scenarios 26-30)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as child_process from 'node:child_process';

import {
  ClosedLoopCoordinator,
  type ClosedLoopCycleInput,
  type ClosedLoopCycleResult,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  ApprovalStore,
  ApprovalPackageEngine,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  TaskDagEngine,
  SystemExecutionEvidenceStore,
  SystemEvidenceCollector,
  DirectorActionDispatcher,
  DirectorActionBuilder,
  DirectorActionValidator,
  ExecutionBridge,
  DriverEngine,
  RecoveryPolicyEngine,
  CorrectiveTaskService,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
  IdentityManager,
  type TaskDefinition,
  type DirectorSession,
  type DirectorContextSnapshot,
  type ApprovalPackage,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  LifecycleState,
} from '../dist/index.js';

import {
  DirectorRuntime,
  DirectorPromptBuilder,
  type DirectorAction,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
} from '../dist/director/index.js';

import { LlmFinishReason } from '../dist/llm-bridge/llm-types.js';

// ============================================================================
// DETERMINISTIC MOCK LLM PROVIDER
// ============================================================================

class DeterministicDirectorLlmProvider implements LLMProvider {
  readonly providerId = 'llm:deterministic-p28';
  readonly providerName = 'deterministic-mock';
  readonly defaultModel = 'mock-director-v1';
  readonly supportedModels = ['mock-director-v1'];
  readonly supportedCapabilities = [] as any;
  isMock = true;

  isAvailable = true;
  unavailableReason: string | undefined;
  capturedRequests: LlmRequest[] = [];
  nextActionToReturn: Record<string, unknown> | null = null;
  shouldFailRequest = false;
  failureMessage = 'Simulated LLM call failure';
  callCount = 0;

  projectId = 'test-project-p28';
  directorSessionId = 'dir-session-p28';
  fingerprint = 'fp-p28';

  setContext(projectId: string, sessionId: string, fingerprint: string) {
    this.projectId = projectId;
    this.directorSessionId = sessionId;
    this.fingerprint = fingerprint;
  }

  async checkAvailability() {
    return {
      available: this.isAvailable,
      reason: this.unavailableReason,
      model: this.defaultModel,
    };
  }

  async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
    this.capturedRequests.push(request);
    this.callCount++;

    if (this.shouldFailRequest) {
      throw new Error(this.failureMessage);
    }

    const payload = this.nextActionToReturn ?? {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: 'act-impl-101',
      directorSessionId: this.directorSessionId,
      projectId: this.projectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: this.fingerprint,
      rationale: 'Task-02 dependencies are satisfied and PO approval is in place.',
      confidence: 0.95,
      taskId: 'task-02-auth',
      objective: 'Implement auth token service',
      targetFiles: ['src/auth.ts'],
      implementationScope: 'src/',
      acceptanceCriteria: ['AC-02'],
      constraints: ['Must follow ESLint standards'],
    };

    return {
      correlation: {
        correlation_id: `corr-${Date.now()}`,
        project_id: this.projectId,
      },
      provider: 'deterministic-mock',
      model: this.defaultModel,
      content: JSON.stringify(payload),
      structured_output: payload as TStructured,
      finish_reason: LlmFinishReason.STOP,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };
  }
}

// ============================================================================
// MOCK EXECUTOR
// ============================================================================

class MockExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId = 'mock-p28-executor';
  readonly provider = 'antigravity';
  readonly supportedOperations = ['IMPLEMENT_TASK'];
  executionCallCount = 0;
  isAvailable = true;
  simulateTimeout = false;
  simulateFailure = false;
  simulateSelfClaimOnly = false;

  private tempDir: string;

  constructor(tempDir: string) {
    this.tempDir = tempDir;
  }

  setTempDir(dir: string) {
    this.tempDir = dir;
  }

  async checkAvailability() {
    return { available: this.isAvailable, reason: this.isAvailable ? undefined : 'Executor offline' };
  }

  async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
    this.executionCallCount++;

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
        stderr: 'Syntax error in file',
        durationMs: 30,
        unverifiedAgentClaims: ['Failed execution'],
        unverifiedModifiedFiles: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    const files =
      request.targetFiles && request.targetFiles.length > 0
        ? request.targetFiles
        : ['src/auth.ts'];

    if (!this.simulateSelfClaimOnly) {
      for (const f of files) {
        const full = path.join(this.tempDir, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, `// Verified implementation for ${request.taskId}\n`, 'utf8');
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
      stdout: `Antigravity executed task ${request.taskId} successfully`,
      stderr: '',
      durationMs: 50,
      unverifiedAgentClaims: ['Implemented all requirements successfully'],
      unverifiedModifiedFiles: this.simulateSelfClaimOnly ? [] : (files as string[]),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

describe('Phase 28 (P28): DirectorRuntime Closed-Loop Integration', { concurrency: 1 }, () => {
  let tempDir: string;
  let validProjectId: string;
  let validSessionId: string;
  let validFingerprint: string;
  let validRevision: number;

  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let durableManager: DurableStateManager;
  let historyManager: HistoryManager;
  let evidenceStore: SystemExecutionEvidenceStore;
  let evidenceCollector: SystemEvidenceCollector;
  let mandateStore: ProjectMandateStore;
  let identityManager: IdentityManager;
  let policyEngine: AuthorizationPolicyEngine;
  let recoveryPolicyEngine: RecoveryPolicyEngine;
  let correctiveTaskService: CorrectiveTaskService;

  let mockLlmProvider: DeterministicDirectorLlmProvider;
  let directorRuntime: DirectorRuntime;
  let mockExecutor: MockExecutor;
  let coordinator: ClosedLoopCoordinator;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;

  const validMandate: ProjectMandate = {
    projectId: 'test-project-p28',
    allowedDirectories: ['src/', 'tests/'],
    allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'BUILD_EXECUTION'],
    allowedCommandCategories: ['test', 'build', 'lint', 'format'],
    autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
    forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE', 'DROP_DATABASE'],
    humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION', 'UPDATE_SECURITY_POLICY'],
    authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
    authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
    resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
    policyVersion: 1,
    mandateRevision: 1,
  };

  async function saveSignedMandate(mandate: ProjectMandate) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-p28-test',
      projectId: mandate.projectId,
      instanceId: 'inst-p28',
      actorType: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nonce: crypto.randomUUID(),
      publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey),
      authenticationMethod: 'ED25519_DPAPI',
      protocolVersion: 1,
      verified: true,
      authSource: 'TRUSTED_IDE',
    };
    const signature = await identityManager.signPayload(payload, privateKey);
    return await mandateStore.saveMandate(mandate, { ...payload, signature });
  }

  function createAuthoritativeSnapshot(overrides: Partial<DirectorContextSnapshot> = {}): DirectorContextSnapshot {
    return {
      projectId: validProjectId,
      projectRoot: tempDir,
      directorSessionId: validSessionId,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      syncStatus: 'CHANGED',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      logicalFingerprint: validFingerprint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sequenceNumber: 1,
      warnings: [],
      sectionMetadata: {
        requirements: { revision: validRevision },
        projectStatus: { revision: 1 },
        taskList: { revision: 1 },
        currentTask: { revision: 1 },
        architecture: { revision: 1 },
        businessRules: { revision: 1 },
        acceptanceCriteria: { revision: 1 },
        risks: { revision: 1 },
        decisions: { revision: 1 },
        clarifications: { revision: 1 },
        approvalPackage: { revision: 1 },
        gitStatus: { revision: 1 },
      } as any,
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
        approval: { hasApprovalPackage: true, packageId: approvedPackage?.packageId ?? 'pkg-test', isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'p28-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 1, items: [{ id: 'REQ-01', title: 'Auth API', status: 'ACTIVE', authority: 'PO' }] },
        decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Node 22 Runtime', status: 'ACCEPTED' }] },
        taskList: {
          total: 2,
          topologicalOrder: ['task-01-core', 'task-02-auth'],
          tasks: [
            { taskId: 'task-01-core', title: 'Core Setup', status: 'ACCEPTED', dependencies: [] },
            { taskId: 'task-02-auth', title: 'Auth Service', status: 'READY', dependencies: ['task-01-core'] },
          ],
        },
        currentTask: {
          hasActiveTask: true,
          task: {
            taskId: 'task-02-auth',
            title: 'Auth Service',
            status: 'READY',
            description: 'Implement auth token service',
            acceptanceCriteria: ['AC-02'],
          },
        },
        risks: { total: 0, items: [] },
        evidence: { totalAvailable: 0, items: [] },
        history: { totalEvents: 0, recentEvents: [] },
        git: { isGitRepository: true, head: 'main', branch: 'main', workingTreeClean: true, totalAcceptedCheckpoints: 1 },
        contextEngine: { isAvailable: true, hasL0Cache: true, inspectedPaths: [] },
      } as any,
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p28-test-'));
    validProjectId = path.basename(tempDir).toLowerCase();
    validSessionId = `dir-session-p28-${Date.now()}`;
    validFingerprint = `fp-p28-${Date.now()}`;
    validRevision = 1;

    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM P28 Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-p28@example.com"', { cwd: tempDir, stdio: 'ignore' });

    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: validProjectId, version: '1.0.0' }),
      'utf8'
    );
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'auth.ts'), 'export const auth = "initial";\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n.gemini/\n.agents/\n*.log\n', 'utf8');
    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

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
    evidenceCollector = new SystemEvidenceCollector({ evidenceStore });
    mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    identityManager = new IdentityManager({ baseDir: tempDir });
    policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager });
    recoveryPolicyEngine = new RecoveryPolicyEngine({ historyManager });
    correctiveTaskService = new CorrectiveTaskService({
      durableStateManager: durableManager,
      specStore,
      dagEngine,
      historyManager,
      approvalStore,
      approvalPackageEngine,
      directorSessionStore: sessionStore,
      recoveryPolicyEngine,
      workspaceRoot: tempDir,
    });

    mockExecutor = new MockExecutor(tempDir);

    // Active session
    activeSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      understandingRevision: validRevision,
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      hasImplementationAuthority: false,
      decisionCount: 0,
      metadata: {},
    };
    await sessionStore.saveSession(activeSession);

    // Approved package
    const pkgId = `pkg-p28-${Date.now()}`;
    const nowIso = new Date().toISOString();
    approvedPackage = {
      packageId: pkgId,
      projectId: validProjectId,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      status: 'APPROVED',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: true,
      approvalRecord: {
        packageId: pkgId,
        revision: validRevision,
        actor: 'PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: nowIso,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Human Product Owner authorizes task development',
      },
    };
    await approvalStore.savePackage(approvedPackage);

    await saveSignedMandate({
      ...validMandate,
      projectId: validProjectId,
    });

    const featCore: TaskDefinition = {
      task_id: 'FEAT-CORE',
      parent_feature_id: 'ROOT',
      title: 'Core Feature',
      description: 'Core feature foundation',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01'],
      hierarchy_level: 'FEATURE',
      attempt: 1,
      max_attempts: 2,
      status: 'IN_PROGRESS',
      risk_level: 'LOW',
      dependencies: [],
      created_at: new Date().toISOString(),
    };
    const t1: TaskDefinition = {
      task_id: 'task-01-core',
      parent_feature_id: 'FEAT-CORE',
      title: 'Core Setup',
      description: 'Initial repo setup',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['Repo exists'],
      hierarchy_level: 'TASK',
      attempt: 1,
      max_attempts: 2,
      status: 'ACCEPTED',
      risk_level: 'LOW',
      dependencies: [],
      created_at: new Date().toISOString(),
    };
    const t2: TaskDefinition = {
      task_id: 'task-02-auth',
      parent_feature_id: 'FEAT-CORE',
      title: 'Auth Service',
      description: 'Implement auth token service',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-02'],
      hierarchy_level: 'TASK',
      attempt: 1,
      max_attempts: 2,
      status: 'READY',
      risk_level: 'LOW',
      dependencies: ['task-01-core'],
      created_at: new Date().toISOString(),
      metadata: { targetFiles: ['src/auth.ts'], revision: 1 },
    };
    await specStore.saveTasks([featCore, t1, t2]);

    await durableManager.save({
      schemaVersion: 1,
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-01-core'],
      activeTaskId: null,
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
      updatedAt: new Date().toISOString(),
    });

    activeSnapshot = createAuthoritativeSnapshot();
    await sessionStore.saveSnapshot(activeSnapshot);

    mockLlmProvider = new DeterministicDirectorLlmProvider();
    mockLlmProvider.setContext(validProjectId, validSessionId, validFingerprint);

    directorRuntime = new DirectorRuntime({
      sessionStore,
      promptBuilder: new DirectorPromptBuilder(),
      llmProvider: mockLlmProvider,
      strictProductionSafety: false,
    });

    coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
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
      evidenceCollector,
      directorRuntime,
      executorPort: mockExecutor,
      authorizationPolicyEngine: policyEngine,
      recoveryPolicyEngine,
      correctiveTaskService,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  // ==========================================================================
  // 1. RUNTIME INTEGRATION (Scenarios 1-5)
  // ==========================================================================
  describe('1. Runtime Integration', () => {
    it('Scenario 1: Coordinator uses real DirectorRuntime when reasoning', async () => {
      assert.ok(coordinator.directorRuntime, 'DirectorRuntime must be configured');
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });
      assert.equal(mockLlmProvider.callCount, 1, 'LLM provider must be invoked');
      if (!result.isSuccess) {
        console.log('SYSTEM EVIDENCE:', JSON.stringify(result.systemEvidence, null, 2));
        console.log('BRIDGE RESULT:', JSON.stringify(result.bridgeResult, null, 2));
      }
      assert.equal(result.status, 'COMPLETED_SUCCESS', `FAILED at ${result.stepReached}: ${result.summary}`);
      assert.ok(result.reasoningResult, 'ReasoningResult must be present');
      assert.equal(result.directorAction?.actionType, 'IMPLEMENT_TASK');
    });

    it('Scenario 2: DirectorAction from DirectorRuntime transforms into valid DirectorActionEnvelope', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });
      assert.ok(result.actionEnvelope, 'actionEnvelope must be produced');
      assert.equal(result.actionEnvelope?.actionType, 'IMPLEMENT_TASK');
      assert.equal((result.actionEnvelope?.payload as any)?.taskId, 'task-02-auth');
    });

    it('Scenario 3: Action fingerprint matches context snapshot logicalFingerprint', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });
      assert.equal(
        result.actionEnvelope?.basedOnContextFingerprint,
        activeSnapshot.logicalFingerprint,
        'Envelope fingerprint must match snapshot logicalFingerprint'
      );
    });

    it('Scenario 4: projectId is preserved across reasoning and envelope packaging', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });
      assert.equal(result.actionEnvelope?.projectId, validProjectId);
      assert.equal(result.projectId, validProjectId);
    });

    it('Scenario 5: directorSessionId is preserved across reasoning and envelope packaging', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });
      assert.equal(result.actionEnvelope?.directorSessionId, activeSession.directorSessionId);
      assert.equal(result.directorSessionId, activeSession.directorSessionId);
    });
  });

  // ==========================================================================
  // 2. AUTHORITY BOUNDARIES (Scenarios 6-10)
  // ==========================================================================
  describe('2. Authority Boundaries', () => {
    it('Scenario 6: Director action cannot bypass approval (unapproved package halts in BLOCKED_ON_APPROVAL)', async () => {
      await approvalStore.savePackage({
        ...approvedPackage,
        status: 'PENDING',
        isDevelopmentAuthorized: false,
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'BLOCKED_ON_APPROVAL');
      assert.equal(result.isSuccess, false);
      assert.equal(mockExecutor.executionCallCount, 0, 'Executor must NOT be called without approval');
    });

    it('Scenario 7: Director action cannot bypass authorization policy gate', async () => {
      await saveSignedMandate({
        ...validMandate,
        projectId: validProjectId,
        allowedOperationTypes: ['FILE_READ'],
        forbiddenOperations: ['FILE_MODIFY'],
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'REJECTED_BY_POLICY');
      assert.equal(result.isSuccess, false);
      assert.equal(mockExecutor.executionCallCount, 0);
    });

    it('Scenario 8: IMPLEMENT_TASK does not reach executor without Product Owner approval', async () => {
      await approvalStore.savePackage({
        ...approvedPackage,
        status: 'REJECTED',
        isDevelopmentAuthorized: false,
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(mockExecutor.executionCallCount, 0);
      assert.ok(result.status === 'BLOCKED_ON_APPROVAL' || result.status === 'REJECTED_BY_POLICY');
    });

    it('Scenario 9: Director cannot produce hasImplementationAuthority', async () => {
      const fakeAuthAction: DirectorAction = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-fake-auth',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'IMPLEMENT_TASK',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'Claiming direct authority',
        confidence: 0.99,
        taskId: 'task-02-auth',
        objective: 'Bypass authorization',
        targetFiles: ['src/auth.ts'],
        implementationScope: 'Scope',
        acceptanceCriteria: ['Valid token passes'],
        constraints: [],
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customAction: fakeAuthAction,
      });

      assert.ok(result.actionEnvelope, 'Envelope formed');
      assert.equal((result.actionEnvelope as any).isDevelopmentAuthorized, undefined);
    });

    it('Scenario 10: If Product Owner approval is present, existing authorization path is used', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });
      assert.equal(result.status, 'COMPLETED_SUCCESS');
      assert.equal(mockExecutor.executionCallCount, 1);
    });
  });

  // ==========================================================================
  // 3. CONTEXT & FINGERPRINT VALIDATION (Scenarios 11-14)
  // ==========================================================================
  describe('3. Context & Fingerprint Validation', () => {
    it('Scenario 11: Stale context fingerprint rejects dispatch (fail closed)', async () => {
      const staleActionEnvelope = new DirectorActionBuilder().buildEnvelope({
        action: {
          protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
          schemaVersion: 1,
          actionId: 'act-stale-101',
          directorSessionId: validSessionId,
          projectId: validProjectId,
          actionType: 'IMPLEMENT_TASK',
          basedOnContextFingerprint: 'old-stale-fingerprint-999',
          rationale: 'Stale action',
          confidence: 0.95,
          taskId: 'task-02-auth',
          objective: 'Implement auth',
          targetFiles: ['src/auth.ts'],
          implementationScope: 'Scope',
          acceptanceCriteria: ['AC-1'],
          constraints: [],
        },
        snapshot: {
          ...activeSnapshot,
          logicalFingerprint: 'old-stale-fingerprint-999',
        },
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: staleActionEnvelope,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /Stale context fingerprint|stale/i);
      assert.equal(mockExecutor.executionCallCount, 0);
    });

    it('Scenario 12: Incomplete context rejects reasoning (fail closed)', async () => {
      const incompleteSnapshot = createAuthoritativeSnapshot({
        isComplete: false,
        unavailableSections: ['taskList', 'requirements'],
      });
      await sessionStore.saveSnapshot(incompleteSnapshot);

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: incompleteSnapshot,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /incomplete/i);
      assert.equal(mockExecutor.executionCallCount, 0);
    });

    it('Scenario 13: Changed understanding revision is rejected', async () => {
      const baseEnvelope = new DirectorActionBuilder().buildEnvelope({
        action: {
          protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
          schemaVersion: 1,
          actionId: 'act-rev-101',
          directorSessionId: validSessionId,
          projectId: validProjectId,
          actionType: 'IMPLEMENT_TASK',
          basedOnContextFingerprint: validFingerprint,
          rationale: 'Revision mismatch action',
          confidence: 0.95,
          taskId: 'task-02-auth',
          objective: 'Implement auth',
          targetFiles: ['src/auth.ts'],
          implementationScope: 'Scope',
          acceptanceCriteria: ['AC-1'],
          constraints: [],
        },
        snapshot: activeSnapshot,
      });
      const staleRevisionEnvelope = {
        ...baseEnvelope,
        understandingRevision: 999,
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: staleRevisionEnvelope,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /Stale understanding revision|revision/i);
    });

    it('Scenario 14: Changed session ID in envelope is rejected', async () => {
      const mismatchedSessionEnvelope = new DirectorActionBuilder().buildEnvelope({
        action: {
          protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
          schemaVersion: 1,
          actionId: 'act-sess-101',
          directorSessionId: 'session-foreign-404',
          projectId: validProjectId,
          actionType: 'IMPLEMENT_TASK',
          basedOnContextFingerprint: validFingerprint,
          rationale: 'Mismatched session',
          confidence: 0.95,
          taskId: 'task-02-auth',
          objective: 'Implement auth',
          targetFiles: ['src/auth.ts'],
          implementationScope: 'Scope',
          acceptanceCriteria: ['AC-1'],
          constraints: [],
        },
        snapshot: {
          ...activeSnapshot,
          directorSessionId: 'session-foreign-404',
        },
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: mismatchedSessionEnvelope,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /session/i);
    });
  });

  // ==========================================================================
  // 4. IDEMPOTENCY GUARANTEES (Scenarios 15-16)
  // ==========================================================================
  describe('4. Idempotency Guarantees', () => {
    it('Scenario 15: Same action dispatched twice does not repeat mutation', async () => {
      const fixedKey = 'idempotent-test-key-001';
      const result1 = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        idempotencyKey: fixedKey,
      });
      assert.equal(result1.status, 'COMPLETED_SUCCESS');
      assert.equal(mockExecutor.executionCallCount, 1);

      const result2 = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        idempotencyKey: fixedKey,
      });

      assert.equal(result2.status, 'COMPLETED_SUCCESS');
      assert.equal(mockExecutor.executionCallCount, 1, 'Executor must NOT be called a second time');
    });

    it('Scenario 16: Different payload with same idempotency key is rejected', async () => {
      const fixedKey = 'conflict-idempotency-key-002';
      const action1: DirectorAction = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-conflict-1',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'IMPLEMENT_TASK',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'Action 1',
        confidence: 0.9,
        taskId: 'task-02-auth',
        objective: 'Implement 1',
        targetFiles: ['src/auth.ts'],
        implementationScope: 'Scope',
        acceptanceCriteria: ['AC-1'],
        constraints: [],
      };
      const result1 = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customAction: action1,
        idempotencyKey: fixedKey,
      });
      assert.equal(result1.status, 'COMPLETED_SUCCESS');

      const action2: DirectorAction = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-conflict-2',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'IMPLEMENT_TASK',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'Action 2 with conflicting payload',
        confidence: 0.9,
        taskId: 'task-02-auth',
        objective: 'Different objective completely',
        targetFiles: ['src/different.ts'],
        implementationScope: 'Different scope',
        acceptanceCriteria: ['AC-2'],
        constraints: [],
      };

      const result2 = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customAction: action2,
        idempotencyKey: fixedKey,
      });

      assert.equal(result2.status, 'EXECUTION_FAILED');
      assert.match(result2.summary, /Idempotency conflict/i);
    });
  });

  // ==========================================================================
  // 5. HUMAN GATE ACTIONS (Scenarios 17-19)
  // ==========================================================================
  describe('5. Human Gate Actions', () => {
    it('Scenario 17: REQUEST_CLARIFICATION does not go to executor', async () => {
      mockLlmProvider.nextActionToReturn = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-clar-1',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'REQUEST_CLARIFICATION',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'Need clarification on auth mechanism',
        confidence: 0.9,
        question: 'Should we use JWT or opaque bearer tokens?',
        reason: 'Ambiguity in REQ-01',
        blocking: true,
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(mockExecutor.executionCallCount, 0, 'Executor must NOT be called for REQUEST_CLARIFICATION');
      assert.equal(result.status, 'BLOCKED_ON_APPROVAL');
      assert.equal(result.humanDecisionRequired, true);
    });

    it('Scenario 18: BLOCK does not go to executor', async () => {
      mockLlmProvider.nextActionToReturn = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-block-1',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'BLOCK',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'External auth provider is down',
        confidence: 0.9,
        reason: 'Third party auth provider offline',
        blockingConditions: ['Third party service restored'],
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(mockExecutor.executionCallCount, 0, 'Executor must NOT be called for BLOCK');
      assert.equal(result.status, 'BLOCKED_ON_APPROVAL');
      assert.equal(result.humanDecisionRequired, true);
    });

    it('Scenario 19: REQUEST_HUMAN_DECISION does not go to executor', async () => {
      mockLlmProvider.nextActionToReturn = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-human-1',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'REQUEST_HUMAN_DECISION',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'Need human approval for crypto library selection',
        confidence: 0.9,
        question: 'Which crypto library algorithm should be selected?',
        reason: 'Requirement REQ-01 specifies crypto parameters',
        decisionTopic: 'Crypto algorithm',
        options: [{ id: 'opt-1', label: 'Argon2id' }, { id: 'opt-2', label: 'bcrypt' }],
        recommendation: 'Argon2id',
        blocking: true,
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(mockExecutor.executionCallCount, 0, 'Executor must NOT be called for REQUEST_HUMAN_DECISION');
      assert.equal(result.status, 'BLOCKED_ON_APPROVAL');
      assert.equal(result.humanDecisionRequired, true);
    });
  });

  // ==========================================================================
  // 6. COMPLETION BOUNDARY (Scenarios 20-21)
  // ==========================================================================
  describe('6. Completion Boundary', () => {
    it('Scenario 20: DECLARE_PROJECT_COMPLETE does not directly produce terminal state without evidence', async () => {
      mockLlmProvider.nextActionToReturn = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-complete-1',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'All requirements done',
        confidence: 0.95,
        finalVerificationRequested: true,
        completionChecklist: {
          allTasksAccepted: true,
          allAcceptanceCriteriaMet: true,
          noBlockingIssues: true,
          noOpenClarifications: true,
        },
        requirementCoverage: [],
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(mockExecutor.executionCallCount, 0);
      assert.equal(result.status, 'BLOCKED_ON_APPROVAL');
      assert.match(result.summary, /Final verification requires human approval/i);
    });

    it('Scenario 21: Completion rejected if finalVerificationRequested is false', async () => {
      const prematureAction = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-complete-2',
        directorSessionId: validSessionId,
        projectId: validProjectId,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        basedOnContextFingerprint: validFingerprint,
        rationale: 'Premature claim',
        confidence: 0.95,
        finalVerificationRequested: false,
        completionChecklist: {
          allTasksAccepted: true,
          allAcceptanceCriteriaMet: true,
          noBlockingIssues: true,
          noOpenClarifications: true,
        },
        requirementCoverage: [],
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        customAction: prematureAction as any,
      });

      assert.equal(mockExecutor.executionCallCount, 0);
      assert.equal(result.status, 'REJECTED_BY_POLICY');
      assert.match(result.summary, /finalVerificationRequested/i);
    });
  });

  // ==========================================================================
  // 7. FAILURE MODES & FAIL-CLOSED SAFETY (Scenarios 22-25)
  // ==========================================================================
  describe('7. Failure Safety & Fail-Closed Behavior', () => {
    it('Scenario 22: In production without provider, fails closed immediately', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const noRuntimeCoordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          sessionStore,
          approvalStore,
          approvalPackageEngine,
          specStore,
          dagEngine,
          durableStateManager: durableManager,
          historyManager,
          evidenceStore,
          evidenceCollector,
        });

        const result = await noRuntimeCoordinator.coordinateCycle({
          projectId: validProjectId,
          directorSessionId: activeSession.directorSessionId,
          contextSnapshot: activeSnapshot,
        });

        assert.equal(result.status, 'EXECUTION_FAILED');
        assert.match(result.summary, /Fail closed: No authoritative DirectorRuntime configured/i);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('Scenario 23: Malformed DirectorAction fails closed', async () => {
      mockLlmProvider.nextActionToReturn = {
        actionType: 'INVALID_UNKNOWN_ACTION_TYPE',
        something: 'completely invalid',
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.equal(mockExecutor.executionCallCount, 0);
    });

    it('Scenario 24: In case of LLM provider failure, task is not automatically selected', async () => {
      mockLlmProvider.shouldFailRequest = true;
      mockLlmProvider.failureMessage = 'LLM rate limit / timeout';

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /LLM rate limit \/ timeout/i);
      assert.equal(result.stepReached, 'REASONING');
    });

    it('Scenario 25: In case of LLM provider failure, executor is not called', async () => {
      mockLlmProvider.shouldFailRequest = true;
      mockLlmProvider.failureMessage = 'LLM connection refused';

      await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(mockExecutor.executionCallCount, 0, 'Executor must remain completely untouched when reasoning fails');
    });
  });

  // ==========================================================================
  // 8. END-TO-END CLOSED LOOP (Scenarios 26-30)
  // ==========================================================================
  describe('8. End-to-End Closed Loop Execution', () => {
    it('Scenario 26: Full end-to-end chain functions correctly', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'COMPLETED_SUCCESS');
      assert.equal(result.isSuccess, true);
      assert.equal(result.stepReached, 'STATE_INTEGRATION_RECOVERY');
      assert.equal(mockExecutor.executionCallCount, 1);
      assert.ok(result.systemEvidence, 'Evidence must be present');
    });

    it('Scenario 27: Without independent SystemExecutionEvidence, success is not accepted', async () => {
      mockExecutor.simulateSelfClaimOnly = true;

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'EXECUTION_FAILED');
      assert.equal(result.isSuccess, false);
      assert.match(result.summary, /AGY self-claim rejected|evidence|Zero trust/i);
    });

    it('Scenario 28: If evidence is verified, state integration updates durable state', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'COMPLETED_SUCCESS');
      const state = await durableManager.load();
      assert.ok(state?.completedTaskIds?.includes('task-02-auth'), 'task-02-auth must be recorded in durable state');
    });

    it('Scenario 29: Execution failure routes to bounded recovery mechanism', async () => {
      mockExecutor.simulateFailure = true;

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.equal(result.status, 'MAX_ATTEMPTS_EXCEEDED');
      assert.equal(result.isSuccess, false);
      assert.ok(result.recoveryDecision, 'RecoveryDecision must have been evaluated');
    });

    it('Scenario 30: When closed loop is re-run, duplicate execution does not occur', async () => {
      const fixedKey = 'p28-e2e-rerun-key';
      const result1 = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        idempotencyKey: fixedKey,
      });
      assert.equal(result1.status, 'COMPLETED_SUCCESS');
      assert.equal(mockExecutor.executionCallCount, 1);

      const result2 = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: activeSession.directorSessionId,
        contextSnapshot: activeSnapshot,
        idempotencyKey: fixedKey,
      });
      assert.equal(result2.status, 'COMPLETED_SUCCESS');
      assert.equal(mockExecutor.executionCallCount, 1, 'Duplicate execution must NOT happen');
    });
  });
});
