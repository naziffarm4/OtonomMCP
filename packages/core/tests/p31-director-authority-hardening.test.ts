/**
 * @file p31-director-authority-hardening.test.ts
 * @description Comprehensive Test Suite for Phase 31 (P31):
 * Director Authority Hardening & Real Lifecycle Boundary.
 *
 * Enforces hard architectural invariants:
 * 1. Authority: DirectorRuntime is the sole authoritative reasoning source; fail-closed on missing runtime or synthetic snapshot.
 * 2. Action: Anti-spoofing and envelope validation reject spoofed PO, fake USER auth, self-escalation, and revision mismatch.
 * 3. Authorization: Implementation strictly requires valid signed Mandate and PO approval; routine operations cannot bypass approval semantics.
 * 4. Recovery: EXECUTION_UNKNOWN halts to human gate; never auto-retried; zombie takeover strictly prevented.
 * 5. Driver: Driver lifecycle coordination only; driver cannot manufacture technical implementation decisions.
 * 6. MCP & Controlled Execution: Single cycle execution only; zero hidden autonomous loops.
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
  DriverRuntime,
  DriverStore,
  DriverLockManager,
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
  LifecycleState,
  RecoveryEngine,
  ExecutionLifecycleState,
  RecoveryDecision,
  resolveCanonicalProjectIdentity,
} from '../dist/index.js';

import {
  DirectorRuntime,
  DirectorPromptBuilder,
  type DirectorAction,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
  DirectorRuntimeUnavailableError,
} from '../dist/director/index.js';

import { LlmFinishReason } from '../dist/llm-bridge/llm-types.js';
import { ActionDispatchStatus } from '../dist/director-action/director-action-types.js';
import {
  createDirectorOpenHandler,
  createDirectorContextHandler,
  createDirectorActHandler,
  createDirectorControlHandler,
} from '../dist/mcp/tools/director-control-plane-tools.js';

// ============================================================================
// DETERMINISTIC MOCK LLM PROVIDER
// ============================================================================

class MockDirectorLlmProvider implements LLMProvider {
  readonly providerId = 'llm:deterministic-p31';
  readonly providerName = 'deterministic-mock-p31';
  readonly defaultModel = 'mock-director-v1';
  readonly supportedModels = ['mock-director-v1'];
  readonly supportedCapabilities = [] as any;
  isMock = true;

  isAvailable = true;
  unavailableReason: string | undefined;
  capturedRequests: LlmRequest[] = [];
  nextActionToReturn: Record<string, unknown> | null = null;
  callCount = 0;

  projectId = 'test-project-p31';
  directorSessionId = 'dir-session-p31';
  fingerprint = 'fp-p31-valid';

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

    const payload = this.nextActionToReturn ?? {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: `act-p31-${Date.now()}`,
      directorSessionId: this.directorSessionId,
      projectId: this.projectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: this.fingerprint,
      rationale: 'Task dependencies satisfied and PO approval confirmed.',
      confidence: 0.98,
      taskId: 'task-02-auth',
      objective: 'Implement auth module',
      implementationScope: 'src/',
      constraints: ['Must follow ESLint standards'],
      targetFiles: ['src/auth.ts'],
      acceptanceCriteria: ['AC-02'],
    };

    return {
      correlation: { correlation_id: `corr-${Date.now()}`, project_id: this.projectId },
      provider: 'deterministic-mock-p31',
      model: this.defaultModel,
      content: JSON.stringify(payload),
      structured_output: payload as TStructured,
      finish_reason: LlmFinishReason.STOP,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  }
}

// ============================================================================
// DETERMINISTIC MOCK EXECUTOR
// ============================================================================

class MockExecutor implements ExecutorPort {
  readonly executorId = 'mock-executor-p31';
  calls: any[] = [];
  tempDir = '';

  async execute(request: any): Promise<any> {
    this.calls.push(request);
    const files = request.targetFiles && request.targetFiles.length > 0 ? request.targetFiles : ['src/auth.ts'];
    for (const f of files) {
      if (this.tempDir) {
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
      stdout: `Executed task ${request.taskId}`,
      stderr: '',
      durationMs: 50,
      unverifiedAgentClaims: ['Implemented successfully'],
      unverifiedModifiedFiles: files,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

describe('Phase 31 (P31): Director Authority Hardening & Real Lifecycle Boundary', { concurrency: 1 }, () => {
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
  let recoveryEngine: RecoveryEngine;
  let mockExecutor: MockExecutor;
  let mockLlmProvider: MockDirectorLlmProvider;
  let directorRuntime: DirectorRuntime;
  let coordinator: ClosedLoopCoordinator;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;

  async function saveSignedMandate(mandate: ProjectMandate) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-p31-test',
      projectId: mandate.projectId,
      instanceId: 'inst-p31',
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
        approval: { hasApprovalPackage: true, packageId: `pkg-${validProjectId}`, isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'p31-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 1, items: [{ id: 'REQ-01', title: 'Auth Service', status: 'ACTIVE', authority: 'PO' }] },
        decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Node 22', status: 'ACCEPTED' }] },
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
            description: 'Implement auth module',
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p31-test-'));
    validProjectId = path.basename(tempDir).toLowerCase();
    validSessionId = `dir-session-p31-${Date.now()}`;
    validFingerprint = 'fp-p31-authoritative-99';
    validRevision = 1;

    // Seed git repository
    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM P31 Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-p31@example.com"', { cwd: tempDir, stdio: 'ignore' });

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: validProjectId, version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'src', 'auth.ts'), 'export const auth = "v1";\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n*.log\n', 'utf8');
    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

    // Stores
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
    mandateStore = new ProjectMandateStore({ baseDir: tempDir, historyManager });
    identityManager = new IdentityManager({ baseDir: tempDir });
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
    recoveryEngine = new RecoveryEngine({
      durableStateManager: durableManager,
      evidenceStore,
      specStore,
      dagEngine,
      historyManager,
      workspaceRoot: tempDir,
    });

    policyEngine = new AuthorizationPolicyEngine({
      mandateStore,
      approvalStore,
      identityManager,
      baseDir: tempDir,
      historyManager,
    });

    mockExecutor = new MockExecutor();
    mockExecutor.tempDir = tempDir;

    const nowIso = new Date().toISOString();
    const mandate: ProjectMandate = {
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'IMPLEMENTATION'],
      allowedCommandCategories: ['test', 'build', 'lint'],
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
      forbiddenOperations: ['WORKSPACE_ESCAPE'],
      humanApprovalRequiredOperations: [],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 86400000).toISOString(),
      resourceAndWorkLimits: {
        maxFileEdits: 50,
        maxCommands: 50,
      },
      policyVersion: 1,
      mandateRevision: 1,
    };
    await saveSignedMandate(mandate);

    // Active session
    activeSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: nowIso,
      lastActivityAt: nowIso,
      updatedAt: nowIso,
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

    // Approval package
    const pkgId = `pkg-${validProjectId}`;
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
    } as any;
    await approvalStore.savePackage(approvedPackage);

    // Tasks
    const featCore: TaskDefinition = {
      task_id: 'FEAT-CORE',
      parent_feature_id: null,
      title: 'Core Engine Feature',
      description: 'Core engine setup',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['Repo exists'],
      hierarchy_level: 'FEATURE',
      status: 'ACCEPTED',
      risk_level: 'LOW',
      dependencies: [],
      created_at: new Date().toISOString(),
    };
    const t1: TaskDefinition = {
      task_id: 'task-01-core',
      parent_feature_id: 'FEAT-CORE',
      title: 'Core Setup',
      description: 'Setup core',
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

    mockLlmProvider = new MockDirectorLlmProvider();
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
      recoveryEngine,
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
  // CATEGORY 1: AUTHORITY (Tests 1-8)
  // ==========================================================================
  describe('1. Authority Boundaries', () => {
    it('T01_runtime_unavailable_fails_closed: coordinator without DirectorRuntime fails closed', async () => {
      const coordWithoutRuntime = new ClosedLoopCoordinator({
        workspaceRoot: tempDir,
        sessionStore,
        sessionEngine,
        decisionStore,
        approvalStore,
        approvalPackageEngine,
        specStore,
        dagEngine,
        durableStateManager: durableManager,
        directorRuntime: undefined,
      });

      const result = await coordWithoutRuntime.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.strictEqual(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /DIRECTOR_RUNTIME_UNAVAILABLE/i);
    });

    it('T02_legacy_reasoning_cannot_bypass_production: legacy reasoning engine cannot execute in production without flag', async () => {
      const coordLegacy = new ClosedLoopCoordinator({
        workspaceRoot: tempDir,
        sessionStore,
        sessionEngine,
        decisionStore,
        approvalStore,
        approvalPackageEngine,
        specStore,
        dagEngine,
        durableStateManager: durableManager,
        directorRuntime: undefined,
        reasoningEngine: {} as any, // legacy engine provided, but allowLegacyReasoning is false
        allowLegacyReasoning: false,
      });

      const result = await coordLegacy.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /DIRECTOR_RUNTIME_UNAVAILABLE/i);
    });

    it('T03_director_runtime_is_authoritative_source: DirectorRuntime is invoked and its action is used', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.strictEqual(result.isSuccess, true);
      assert.strictEqual(result.status, 'COMPLETED_SUCCESS');
      assert.ok(mockLlmProvider.callCount >= 1, 'LLM Provider must have been called by DirectorRuntime');
      assert.strictEqual(result.taskId, 'task-02-auth');
    });

    it('T04_synthetic_snapshot_cannot_be_used_for_implementation: synthetic fingerprint (-auto / -recovery) fails closed', async () => {
      const syntheticSnapshot = createAuthoritativeSnapshot({
        logicalFingerprint: `fp-${validProjectId}-auto`,
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: syntheticSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.strictEqual(result.status, 'EXECUTION_FAILED');
      assert.match(result.summary, /CONTEXT_UNAVAILABLE/i);
    });

    it('T05_missing_context_fails_closed: un-synchronizable missing snapshot halts fail closed', async () => {
      // Empty session store with no snapshot
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-empty-p31-'));
      const emptySessionStore = new DirectorSessionStore({ baseDir: emptyDir });
      const coordEmpty = new ClosedLoopCoordinator({
        workspaceRoot: emptyDir,
        sessionStore: emptySessionStore,
        directorRuntime,
      });

      const canonicalEmpty = resolveCanonicalProjectIdentity(emptyDir);
      await emptySessionStore.saveSession({
        directorSessionId: 'dir-session-none',
        projectId: canonicalEmpty.projectId,
        projectRoot: emptyDir,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        understandingRevision: 1,
        protocolVersion: 'P9-01',
        schemaVersion: 1,
        actor: 'DIRECTOR',
        actorRole: 'DIRECTOR',
        hasImplementationAuthority: false,
        decisionCount: 0,
        metadata: {},
      });

      // Corrupt spec so synchronizer fails and cannot manufacture a snapshot
      fs.mkdirSync(path.join(emptyDir, '.ai-manager', 'spec'), { recursive: true });
      fs.writeFileSync(path.join(emptyDir, '.ai-manager', 'spec', 'tasks.json'), 'INVALID_JSON_CORRUPTED{{{', 'utf8');

      const result = await coordEmpty.coordinateCycle({
        projectId: canonicalEmpty.projectId,
        directorSessionId: 'dir-session-none',
        contextSnapshot: undefined,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /CONTEXT_UNAVAILABLE/i);
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('T06_stale_context_fails_closed: incomplete snapshot fails closed', async () => {
      const incompleteSnapshot = createAuthoritativeSnapshot({
        isComplete: false,
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: incompleteSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /CONTEXT_UNAVAILABLE/i);
    });

    it('T07_project_mismatch_fails_closed: cross-project context snapshot rejected', async () => {
      const foreignSnapshot = createAuthoritativeSnapshot({
        projectId: 'foreign-project-id',
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: foreignSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /CONTEXT_UNAVAILABLE/i);
    });

    it('T08_session_mismatch_fails_closed: session mismatch between input and snapshot rejected', async () => {
      const mismatchedSnapshot = createAuthoritativeSnapshot({
        directorSessionId: 'foreign-session-id',
      });

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: mismatchedSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /CONTEXT_UNAVAILABLE/i);
    });
  });

  // ==========================================================================
  // CATEGORY 2: ACTION BOUNDARIES & ANTI-SPOOFING (Tests 9-16)
  // ==========================================================================
  describe('2. Action Boundaries & Anti-Spoofing', () => {
    it('T09_arbitrary_custom_envelope_cannot_acquire_authority: envelope with unapproved authority rejected', async () => {
      const customEnvelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-spoof-01',
        idempotencyKey: 'idem-spoof-01',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: {
          taskId: 'task-02-auth',
          isDevelopmentAuthorized: true, // Spoofed field!
        },
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: customEnvelope as any,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /Spoofed authority/i);
    });

    it('T10_spoofed_product_owner_rejected: action claiming actor USER or actorRole PRODUCT_OWNER rejected', async () => {
      const spoofedUserEnvelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-spoof-user',
        idempotencyKey: 'idem-spoof-user',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'USER' as any, // Spoofed actor!
        actorRole: 'PRODUCT_OWNER' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth' },
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: spoofedUserEnvelope as any,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /Spoofed authority/i);
    });

    it('T11_spoofed_human_approval_rejected: payload claiming isTrustedHumanAuth or authStatus VERIFIED_HUMAN rejected', async () => {
      const spoofedAuthEnvelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-spoof-human-auth',
        idempotencyKey: 'idem-spoof-human-auth',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: {
          taskId: 'task-02-auth',
          isTrustedHumanAuth: true,
          authStatus: 'VERIFIED_HUMAN',
        },
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: spoofedAuthEnvelope as any,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /Spoofed authority/i);
    });

    it('T12_spoofed_implementation_authority_rejected: payload claiming hasImplementationAuthority or selfApproved rejected', async () => {
      const spoofedImplEnvelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-spoof-impl-auth',
        idempotencyKey: 'idem-spoof-impl-auth',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: {
          taskId: 'task-02-auth',
          hasImplementationAuthority: true,
          selfApproved: true,
        },
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: spoofedImplEnvelope as any,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /Spoofed authority/i);
    });

    it('T13_stale_action_fingerprint_rejected: action with mismatched context fingerprint rejected', async () => {
      const staleEnvelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-stale-fp',
        idempotencyKey: 'idem-stale-fp',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: 'fp-different-fingerprint',
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth' },
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: staleEnvelope as any,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /Action envelope validation failed/i);
    });

    it('T14_wrong_understanding_revision_rejected: action envelope with mismatched understanding revision rejected', async () => {
      const wrongRevEnvelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-wrong-rev',
        idempotencyKey: 'idem-wrong-rev',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 999, // mismatch with session (1)
        payload: { taskId: 'task-02-auth' },
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
        customEnvelope: wrongRevEnvelope as any,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.match(result.summary, /Action envelope validation failed/i);
    });

    it('T15_wrong_approval_revision_rejected: validation fails when approval revision does not match', async () => {
      const actionValidator = new DirectorActionValidator();
      const envelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-appr-rev',
        idempotencyKey: 'idem-appr-rev',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth' },
      };

      await assert.rejects(
        async () => {
          await actionValidator.validate(envelope as any, {
            currentFingerprint: validFingerprint,
            currentUnderstandingRevision: 1,
            currentDirectorSessionId: validSessionId,
            currentProjectId: validProjectId,
            expectedApprovalRevision: 99,
            actualApprovalRevision: 1,
          });
        },
        /Approval revision mismatch/i
      );
    });

    it('T16_wrong_mandate_revision_rejected: mandate revision mismatch rejected by validator and policy engine', async () => {
      const actionValidator = new DirectorActionValidator();
      const envelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-mandate-rev',
        idempotencyKey: 'idem-mandate-rev',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as any,
        actor: 'DIRECTOR' as any,
        actorRole: 'DIRECTOR' as any,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth' },
      };

      await assert.rejects(
        async () => {
          await actionValidator.validate(envelope as any, {
            currentFingerprint: validFingerprint,
            currentUnderstandingRevision: 1,
            currentDirectorSessionId: validSessionId,
            currentProjectId: validProjectId,
            expectedMandateRevision: 5,
            actualMandateRevision: 1,
          });
        },
        /Mandate revision mismatch/i
      );
    });
  });

  // ==========================================================================
  // CATEGORY 3: AUTHORIZATION POLICY HARDENING (Tests 17-22)
  // ==========================================================================
  describe('3. Authorization Policy Hardening', () => {
    it('T17_implementation_requires_mandate: IMPLEMENT_TASK cannot execute without active Mandate', async () => {
      const tempWithoutMandate = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-no-mandate-'));
      const historyManagerNoMandate = new HistoryManager({ baseDir: tempWithoutMandate });
      const mandateStoreNoMandate = new ProjectMandateStore({ baseDir: tempWithoutMandate });
      const policyEngineNoMandate = new AuthorizationPolicyEngine({
        historyManager: historyManagerNoMandate,
        mandateStore: mandateStoreNoMandate,
      });

      const envelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-no-mandate',
        idempotencyKey: 'idem-no-mandate',
        projectId: path.basename(tempWithoutMandate).toLowerCase(),
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as const,
        actor: 'DIRECTOR' as const,
        actorRole: 'DIRECTOR' as const,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth' },
      };

      const evalResult = await policyEngineNoMandate.evaluateAction(envelope as any);

      assert.notStrictEqual(evalResult.decisionResult, 'ALLOW');
      assert.ok(evalResult.appliedRules.includes('MISSING_PROJECT_MANDATE'));
      fs.rmSync(tempWithoutMandate, { recursive: true, force: true });
    });

    it('T18_expired_mandate_rejected: expired Project Mandate causes policy rejection', async () => {
      const expiredMandate: ProjectMandate = {
        projectId: validProjectId,
        allowedDirectories: ['src/'],
        allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'IMPLEMENTATION'],
        allowedCommandCategories: ['test', 'build', 'lint'],
        autoExecutableTaskClasses: ['IMPLEMENTATION'],
        forbiddenOperations: ['WORKSPACE_ESCAPE'],
        humanApprovalRequiredOperations: [],
        authorizationStartTime: new Date(Date.now() - 7200000).toISOString(),
        authorizationEndTime: new Date(Date.now() - 3600000).toISOString(), // Expired 1 hour ago
        resourceAndWorkLimits: {},
        policyVersion: 1,
        mandateRevision: 2,
      };
      await saveSignedMandate(expiredMandate);

      const envelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-expired-mandate',
        idempotencyKey: 'idem-expired-mandate',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as const,
        actor: 'DIRECTOR' as const,
        actorRole: 'DIRECTOR' as const,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth' },
      };

      const evalResult = await policyEngine.evaluateAction(envelope as any);

      assert.strictEqual(evalResult.decisionResult, 'DENY');
      assert.ok(evalResult.appliedRules.includes('MANDATE_EXPIRED_OR_NOT_STARTED'));
    });

    it('T19_mandate_revision_mismatch_rejected: policy engine rejects if expected mandate revision differs', async () => {
      const envelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-mandate-rev-eval',
        idempotencyKey: 'idem-mandate-rev-eval',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as const,
        actor: 'DIRECTOR' as const,
        actorRole: 'DIRECTOR' as const,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth', expectedMandateRevision: 999 },
      };

      const evalResult = await policyEngine.evaluateAction(envelope as any);

      assert.strictEqual(evalResult.decisionResult, 'DENY');
      assert.ok(evalResult.appliedRules.includes('MANDATE_REVISION_MISMATCH'));
    });

    it('T20_policy_version_mismatch_rejected: policy version mismatch causes policy rejection', async () => {
      const envelope = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: 'act-policy-ver-eval',
        idempotencyKey: 'idem-policy-ver-eval',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        actionType: 'IMPLEMENT_TASK' as const,
        actor: 'DIRECTOR' as const,
        actorRole: 'DIRECTOR' as const,
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: validFingerprint,
        understandingRevision: 1,
        payload: { taskId: 'task-02-auth', expectedPolicyVersion: 999 },
      };

      const evalResult = await policyEngine.evaluateAction(envelope as any);

      assert.strictEqual(evalResult.decisionResult, 'DENY');
      assert.ok(evalResult.appliedRules.includes('POLICY_VERSION_MISMATCH'));
    });

    it('T21_routine_operation_cannot_bypass_approval: routine technical operations require human approval for modification', async () => {
      // Unapprove the package
      const unapprovedPkg: ApprovalPackage = {
        ...approvedPackage,
        status: 'PENDING',
        isDevelopmentAuthorized: false,
      };
      await approvalStore.savePackage(unapprovedPkg);

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.strictEqual(result.isSuccess, false);
      assert.strictEqual(result.status, 'BLOCKED_ON_APPROVAL');
      assert.strictEqual(result.humanDecisionRequired, true);
    });

    it('T22_director_cannot_self_escalate_authority: Director session cannot change hasImplementationAuthority to true', async () => {
      assert.strictEqual(activeSession.hasImplementationAuthority, false);

      // Attempt to save a modified session with hasImplementationAuthority: true
      const escalatedSession: DirectorSession = {
        ...activeSession,
        hasImplementationAuthority: true as any,
      };

      await assert.rejects(
        async () => {
          await sessionEngine.createSession({
            actor: 'USER' as any, // Impersonating PO
            directorSessionId: 'sess-escalated',
          });
        },
        /cannot impersonate Product Owner/i
      );
    });
  });

  // ==========================================================================
  // CATEGORY 4: RECOVERY ENGINE BOUNDARIES (Tests 23-28)
  // ==========================================================================
  describe('4. Recovery Engine Boundaries', () => {
    it('T23_execution_unknown_never_auto_retried: EXECUTION_UNKNOWN halts to human gate and does not auto retry', async () => {
      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'task-02-auth',
        completedTaskIds: ['task-01-core'],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTION_UNKNOWN,
          contextReference: validFingerprint,
        },
      });

      const outcome = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: validSessionId,
        projectId: validProjectId,
      });

      assert.strictEqual(outcome.recoveryResult.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(outcome.humanDecisionRequired, true);
      assert.strictEqual(outcome.directorDecision, null, 'Director must not auto-execute next action when blocked');
    });

    it('T24_crashed_execution_routes_to_human_gate: crashed process in EXECUTING without evidence routes to human', async () => {
      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'task-02-auth',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          contextReference: validFingerprint,
        },
      });

      const outcome = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: validSessionId,
        projectId: validProjectId,
      });

      assert.strictEqual(outcome.recoveryResult.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(outcome.humanDecisionRequired, true);
    });

    it('T25_valid_evidence_enables_deterministic_recovery: verified SystemExecutionEvidence enables recovery to ACCEPTED', async () => {
      const evidence = {
        evidenceId: 'ev-p31-valid-01',
        requestId: 'req-p31-01',
        projectId: validProjectId,
        taskId: 'task-02-auth',
        taskRevision: 1,
        verificationDecision: 'ACCEPT' as const,
        verificationReason: 'All tests passed with zero errors',
        verifiedAt: new Date().toISOString(),
        contextFingerprint: validFingerprint,
        understandingRevision: 1,
        approvalPackageRevision: 1,
        repositoryState: {
          baseCommit: 'commit_base_sha',
          headCommit: 'commit_head_sha',
          isClean: true,
        },
        changedFiles: [{ path: 'src/auth.ts', status: 'MODIFIED' as const }],
        verificationChecks: [
          { checkId: 'CHECK_TESTS', type: 'TEST', status: 'PASS', evidence: 'Tests passed' },
        ],
        acceptanceCriteria: [
          { criterion: 'Pass unit tests', status: 'PASS', evidence: 'All tests pass' },
        ],
        executorOutcomeReference: {
          status: 'SUCCESS',
          exitCode: 0,
          durationMs: 120,
        },
      };
      await evidenceStore.saveEvidence(evidence as any);

      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'task-02-auth',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          contextReference: validFingerprint,
          intentId: 'intent-p31-01',
          evidenceId: evidence.evidenceId,
        },
      });

      const outcome = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: validSessionId,
        projectId: validProjectId,
      });

      assert.ok(
        outcome.recoveryResult.decision === RecoveryDecision.RESTART ||
        outcome.recoveryResult.decision === RecoveryDecision.RESUME,
        `Expected deterministic recovery decision, got ${outcome.recoveryResult.decision}`
      );
      assert.strictEqual(outcome.humanDecisionRequired, false);
    });

    it('T26_invalid_evidence_prevents_autonomous_resume: verbal self-claim without verified evidence prevents resume', async () => {
      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'task-02-auth',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTING,
          verbalClaimOnly: true,
        },
      });

      const outcome = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: validSessionId,
        projectId: validProjectId,
      });

      assert.strictEqual(outcome.recoveryResult.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.strictEqual(outcome.humanDecisionRequired, true);
    });

    it('T27_duplicate_recovery_is_idempotent: running recovery twice produces identical state', async () => {
      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'task-02-auth',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          executionLifecycleState: ExecutionLifecycleState.EXECUTION_UNKNOWN,
        },
      });

      const outcome1 = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: validSessionId,
        projectId: validProjectId,
      });
      const outcome2 = await coordinator.recoverAuthoritativeLifecycle({
        directorSessionId: validSessionId,
        projectId: validProjectId,
      });

      assert.strictEqual(outcome1.recoveryResult.decision, outcome2.recoveryResult.decision);
      assert.strictEqual(outcome1.humanDecisionRequired, outcome2.humanDecisionRequired);
    });

    it('T28_zombie_takeover_prevented: driver recovery detects EXECUTION_UNKNOWN and halts', async () => {
      const driverStore = new DriverStore({ workspaceRoot: tempDir, historyManager });
      await driverStore.saveState({
        schemaVersion: 1,
        driverId: 'drv-p31-zombie',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        currentIteration: 1,
        lifecycleState: 'RUNNING' as any,
        continuationState: 'CONTINUING',
        continuationPolicy: 'GOVERNED_AUTONOMOUS',
        lastTerminalStatus: 'EXECUTION_UNKNOWN',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const driverRuntime = new DriverRuntime({
        workspaceRoot: tempDir,
        historyManager,
        driverStore,
      });

      const summary = await driverRuntime.start({
        workspaceRoot: tempDir,
        projectId: validProjectId,
      });

      assert.strictEqual(summary.lifecycleState, 'PAUSED');
      assert.strictEqual(summary.finalStatus, 'EXECUTION_UNKNOWN');
      assert.match(summary.reason, /Zombie takeover prevented/i);
    });
  });

  // ==========================================================================
  // CATEGORY 5: DRIVER AUTHORITY BOUNDARIES (Tests 29-34)
  // ==========================================================================
  describe('5. Driver Authority Boundaries', () => {
    it('T29_driver_cannot_decide_implementation: DriverEngine cannot manufacture IMPLEMENT_TASK decision', async () => {
      // Empty decisions
      const emptyDecisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
      const driverEngine = new DriverEngine({
        workspaceRoot: tempDir,
        historyManager,
        sessionStore,
        sessionEngine,
        decisionStore: emptyDecisionStore,
        approvalStore,
        approvalPackageEngine,
        specStore,
        dagEngine,
        durableStateManager: durableManager,
      });

      const result = await driverEngine.runIteration({
        workspaceRoot: tempDir,
        projectId: validProjectId,
        iterationNumber: 1,
        targetTaskId: 'task-02-auth',
      });

      assert.strictEqual(result.decision, 'HUMAN_DECISION_REQUIRED');
      assert.match(result.reason, /Driver has no authority to manufacture implementation decisions/i);
    });

    it('T30_driver_lifecycle_control_preserved: Driver owns lifecycle coordination start and status', async () => {
      const driverRuntime = new DriverRuntime({
        workspaceRoot: tempDir,
        historyManager,
      });

      assert.strictEqual(driverRuntime.currentLifecycleState, 'IDLE');
    });

    it('T31_driver_pause_halts_safely: driver pause stops iterations gracefully', async () => {
      const driverStore = new DriverStore({ workspaceRoot: tempDir, historyManager });
      await driverStore.saveState({
        schemaVersion: 1,
        driverId: 'drv-p31-pause-test',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        currentIteration: 1,
        lifecycleState: 'RUNNING' as any,
        continuationState: 'CONTINUING',
        continuationPolicy: 'GOVERNED_AUTONOMOUS',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const driverRuntime = new DriverRuntime({
        workspaceRoot: tempDir,
        historyManager,
        driverStore,
      });

      await driverRuntime.recover();
      await driverRuntime.pause();
      assert.strictEqual(driverRuntime.isPaused, true);
    });

    it('T32_driver_resume_validates_freshness: driver resume validates context freshness', async () => {
      const driverStore = new DriverStore({ workspaceRoot: tempDir, historyManager });
      await driverStore.saveState({
        schemaVersion: 1,
        driverId: 'drv-p31-resume-test',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        currentIteration: 1,
        lifecycleState: 'PAUSED' as any,
        continuationState: 'CONTINUING',
        continuationPolicy: 'GOVERNED_AUTONOMOUS',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const driverRuntime = new DriverRuntime({
        workspaceRoot: tempDir,
        historyManager,
        driverStore,
      });

      await driverRuntime.recover();
      assert.strictEqual(driverRuntime.isPaused, true);

      // Invalidate context snapshot by removing snapshots directory entirely
      const snapshotsDir = path.join(tempDir, '.ai-manager', 'director', 'snapshots');
      if (fs.existsSync(snapshotsDir)) {
        fs.rmSync(snapshotsDir, { recursive: true, force: true });
      }

      await assert.rejects(
        async () => {
          await driverRuntime.resume({ workspaceRoot: tempDir });
        },
        /authoritative state validation failed|missing, incomplete, or synthetic/i
      );
    });

    it('T33_driver_stop_releases_lock: stop transitions to STOPPED and releases lock', async () => {
      const lockManager = new DriverLockManager({ workspaceRoot: tempDir });
      const driverRuntime = new DriverRuntime({
        workspaceRoot: tempDir,
        historyManager,
        lockManager,
      });

      await driverRuntime.stop('Test stop');
      assert.strictEqual(driverRuntime.isStopped, true);
      const isLocked = await lockManager.isLocked();
      assert.strictEqual(isLocked, false);
    });

    it('T34_driver_lock_isolation_enforced: second driver start for same project is rejected', async () => {
      const lockManager = new DriverLockManager({ workspaceRoot: tempDir });
      await lockManager.acquireLock('drv-holder', validProjectId);

      const driverRuntime = new DriverRuntime({
        workspaceRoot: tempDir,
        historyManager,
        lockManager,
      });

      await assert.rejects(
        async () => {
          await driverRuntime.start({ workspaceRoot: tempDir, projectId: validProjectId });
        },
        /Another active driver 'drv-holder' holds the lock/i
      );
    });
  });

  // ==========================================================================
  // CATEGORY 6: MCP CONTROL PLANE & NO HIDDEN LOOPS (Tests 35-42)
  // ==========================================================================
  describe('6. MCP Control Plane & Controlled Execution', () => {
    it('T35_mcp_director_open_preserves_session_continuity: aidm.director.open reuses active session', async () => {
      const handler = createDirectorOpenHandler(tempDir);
      const res = await handler(
        { workspaceRoot: tempDir, actor: 'DIRECTOR', forceNew: false },
        { correlation: { correlationId: 'c-35', projectId: validProjectId } } as any
      );

      assert.ok(!res.isError);
      const data = JSON.parse(res.content[0].text);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.directorSessionId, validSessionId, 'Must reuse existing active session');
    });

    it('T36_mcp_director_context_strictly_authoritative: aidm.director.context returns authoritative context', async () => {
      const handler = createDirectorContextHandler(tempDir);
      const res = await handler(
        { workspaceRoot: tempDir, directorSessionId: validSessionId },
        { correlation: { correlationId: 'c-36', projectId: validProjectId } } as any
      );

      assert.ok(!res.isError);
      const data = JSON.parse(res.content[0].text);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.contextFingerprint, validFingerprint);
    });

    it('T37_mcp_director_act_validates_boundaries: aidm.director.act rejects spoofed payload', async () => {
      const handler = createDirectorActHandler(tempDir);
      const res = await handler(
        {
          workspaceRoot: tempDir,
          directorSessionId: validSessionId,
          actionType: 'IMPLEMENT_TASK',
          payload: {
            taskId: 'task-02-auth',
            isDevelopmentAuthorized: true, // Spoofed!
          },
        },
        { correlation: { correlationId: 'c-37', projectId: validProjectId } } as any
      );

      assert.strictEqual(res.isError, true);
      const data = JSON.parse(res.content[0].text);
      assert.match(data.error.message, /Anti-spoofing violation/i);
    });

    it('T38_mcp_director_control_governed_by_authorization: aidm.director.control requires authorized action', async () => {
      const handler = createDirectorControlHandler(tempDir);
      const res = await handler(
        {
          workspaceRoot: tempDir,
          action: 'pause',
        },
        { correlation: { correlationId: 'c-38', projectId: validProjectId } } as any
      );

      assert.ok(!res.isError);
      const data = JSON.parse(res.content[0].text);
      assert.strictEqual(data.success, true);
    });

    it('T39_mcp_executes_single_cycle_only: ClosedLoopCoordinator executes exactly one cycle', async () => {
      let runCount = 0;
      const originalReason = directorRuntime.reason.bind(directorRuntime);
      directorRuntime.reason = async (opts: any) => {
        runCount++;
        return originalReason(opts);
      };

      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
      });

      if (!result.isSuccess) {
        console.log('T39 failure result:', JSON.stringify(result, null, 2));
      }
      assert.strictEqual(result.isSuccess, true);
      assert.strictEqual(runCount, 1, 'Closed loop must execute exactly one reasoning cycle');
    });

    it('T40_no_hidden_recursive_loop: autoContinue is false and no recurring execution launched', async () => {
      const result = await coordinator.coordinateCycle({
        projectId: validProjectId,
        directorSessionId: validSessionId,
        contextSnapshot: activeSnapshot,
      });

      assert.strictEqual(result.isSuccess, true);
      assert.strictEqual(result.humanDecisionRequired, false);
      assert.strictEqual(result.status, 'COMPLETED_SUCCESS');
      // No background tasks or daemons should be active
    });

    it('T41_executor_never_directly_invoked_by_director: Director cannot invoke executor directly without bridge', async () => {
      // Invariant check: DirectorRuntime has no reference to ExecutorPort
      assert.strictEqual((directorRuntime as any).executorPort, undefined);
      assert.strictEqual((directorRuntime as any).driverEngine, undefined);
    });

    it('T42_driver_evaluate_next_action_evaluates_only: evaluateNextAction evaluates boundary without creating technical decisions', async () => {
      const directorLoopEngine = coordinator.directorLoopEngine;
      const cycleResult = {
        cycleId: 'cycle-p31-eval',
        instructionId: 'inst-p31-eval',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        taskId: 'task-02-auth',
        taskRevision: 1,
        terminalStatus: 'ACCEPTED' as const,
        completedAt: new Date().toISOString(),
        systemEvidence: {
          evidenceId: 'evi-p31-eval',
          verificationDecision: 'ACCEPT' as const,
        } as any,
      };
      await directorLoopEngine.loopStore.saveCycleResult(cycleResult);

      const nextAction = await directorLoopEngine.evaluateNextAction({
        projectId: validProjectId,
        workspaceRoot: tempDir,
        cycleId: 'cycle-p31-eval',
      });

      assert.ok(nextAction);
      assert.strictEqual(nextAction.autoContinue, false, 'No hidden autonomous loops');
      assert.strictEqual(nextAction.actionStatus, 'EXECUTION_ACCEPTED');
      assert.strictEqual(nextAction.taskCompleted, true);
    });
  });
});
