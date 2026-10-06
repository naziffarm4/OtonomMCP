/**
 * @file a4-closed-loop-coordinator.test.ts
 * @description Comprehensive Test Suite for Phase A4: Closed-Loop Coordinator.
 *
 * Validates the unified coordinator integrating:
 * 1. Full Closed-Loop Success Cycle (Loop ➔ Action ➔ Policy ➔ ence ➔ Refresh)
 * 2. Zero Executor Trust (Rejects AGY verbal self-claims without independent evidence)Bridge ➔ Driver ➔ AGY ➔ Evid
 * 3. Ambiguous In-flight Timeout/Abort strictly transitions to EXECUTION_UNKNOWN (No auto re-dispatch)
 * 4. Policy Gate DENY stops closed-loop fail-closed before execution
 * 5. Human approval requirement stops in BLOCKED_ON_APPROVAL (WAITING_FOR_TRUSTED_IDENTITY)
 * 6. Pre-execution Bridge checks fail-closed on unmet dependencies
 * 7. Bounded recovery generates a corrective task with explicit lineage
 * 8. Max recovery attempts halts fail-closed with MAX_ATTEMPTS_EXCEEDED (No infinite loops)
 * 9. Reasoning REQUEST_CLARIFICATION and NO_OP decisions handled gracefully
 * 10. Single claim & deterministic idempotency across closed-loop executions
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

describe('Phase A4: Closed-Loop Coordinator Integration', { concurrency: 1 }, () => {
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

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;
  let coordinator: ClosedLoopCoordinator;

  // Mock executor simulating Antigravity CLI adapter with configurable behavior
  class MockExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-a4-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    executionCallCount = 0;
    isAvailable = true;
    simulateTimeout = false;
    simulateFailure = false;
    simulateSelfClaimOnly = false;
    simulateScopeViolation = false;

    async checkAvailability() {
      return { available: this.isAvailable, reason: this.isAvailable ? undefined : 'Executor offline' };
    }

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      this.executionCallCount++;

      if (this.simulateTimeout) {
        const timeoutErr: any = new Error('Antigravity execution timed out after 30000ms');
        timeoutErr.code = 'ETIMEDOUT';
        throw timeoutErr;
      }

      if (this.simulateScopeViolation) {
        const unexpectedFile = path.join(tempDir, 'src', 'unauthorized.ts');
        fs.mkdirSync(path.dirname(unexpectedFile), { recursive: true });
        fs.writeFileSync(unexpectedFile, '// Unauthorized file outside implementation scope\n', 'utf8');
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
          stdout: 'Execution modified files outside allowed scope',
          stderr: '',
          durationMs: 45,
          unverifiedAgentClaims: ['Modified unauthorized file'],
          unverifiedModifiedFiles: ['src/unauthorized.ts'],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
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
          stderr: 'Compilation error: src/index.ts:1:1: unexpected token',
          durationMs: 40,
          unverifiedAgentClaims: ['Task failed to compile'],
          unverifiedModifiedFiles: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }

      const reqAny = request as any;
      const files =
        Array.isArray(reqAny.targetFiles) && reqAny.targetFiles.length > 0
          ? reqAny.targetFiles
          : Array.isArray(reqAny.instruction?.targetFiles) && reqAny.instruction.targetFiles.length > 0
            ? reqAny.instruction.targetFiles
            : ['src/index.ts'];

      if (!this.simulateSelfClaimOnly) {
        for (const f of files) {
          const full = path.join(tempDir, f);
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
        durationMs: 55,
        unverifiedAgentClaims: ['Implemented all requirements successfully'],
        unverifiedModifiedFiles: this.simulateSelfClaimOnly ? [] : (files as string[]),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockExecutor;

  const validMandate: ProjectMandate = {
    projectId: 'test-project-a4',
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
      workspaceId: 'ws-a4-test',
      projectId: mandate.projectId,
      instanceId: 'inst-a4',
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
      } as any,
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
        approval: { hasApprovalPackage: true, packageId: approvedPackage.packageId, isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'notification-dispatch-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 1, items: [{ id: 'REQ-01', title: 'Dispatch API', status: 'ACTIVE', authority: 'PO' }] },
        decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Node 22 Runtime', status: 'ACCEPTED' }] },
        taskList: {
          total: 2,
          topologicalOrder: ['task-01-core', 'task-02-auth'],
          tasks: [
            { taskId: 'task-01-core', title: 'Core Setup', status: 'COMPLETED', dependencies: [] },
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
            acceptanceCriteria: ['Valid token passes'],
          },
        },
        risks: { total: 0, items: [] },
      } as any,
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-a4-test-'));
    validProjectId = path.basename(tempDir).toLowerCase();
    validSessionId = `dir-session-a4-${Date.now()}`;
    validFingerprint = `fp-a4-${Date.now()}`;
    validRevision = 1;

    // Initialize git repository in fixture so ExecutionRequest repository binding passes
    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-test@example.com"', { cwd: tempDir, stdio: 'ignore' });

    // Write minimal package.json so resolveCanonicalProjectIdentity derives project
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: validProjectId, version: '1.0.0' }),
      'utf8'
    );
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'auth.ts'),
      'export const auth = "initial";\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      '.ai-manager/\n.gemini/\n.agents/\n*.log\n',
      'utf8'
    );
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

    mockExecutor = new MockExecutor();

    // Create active Director session
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

    // Save approved human Product Owner package
    const pkgId = `pkg-a4-${Date.now()}`;
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

    // Save signed project mandate
    await saveSignedMandate({
      ...validMandate,
      projectId: validProjectId,
    });

    // Save tasks in SpecStore
    const featCore: TaskDefinition = {
      task_id: 'FEAT-CORE',
      parent_feature_id: 'ROOT',
      title: 'Core Feature',
      description: 'Core feature foundation',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01'],
      status: 'ACCEPTED',
      attempt: 0,
      max_attempts: 1,
      priority: 'HIGH',
      risk_level: 'LOW',
      dependencies: [],
      created_at: new Date().toISOString(),
      hierarchy_level: 'FEATURE',
      metadata: {},
    };

    const task1: TaskDefinition = {
      task_id: 'task-01-core',
      parent_feature_id: 'FEAT-CORE',
      title: 'Core Setup',
      description: 'Setup core foundations',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01'],
      status: 'ACCEPTED',
      attempt: 1,
      max_attempts: 2,
      priority: 'HIGH',
      risk_level: 'LOW',
      dependencies: [],
      created_at: new Date().toISOString(),
      hierarchy_level: 'TASK',
      metadata: { targetFiles: ['src/core.ts'], revision: 1 },
    };

    const task2: TaskDefinition = {
      task_id: 'task-02-auth',
      parent_feature_id: 'FEAT-CORE',
      title: 'Auth Service',
      description: 'Implement token verification service',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-02'],
      status: 'READY',
      attempt: 0,
      max_attempts: 2,
      priority: 'HIGH',
      risk_level: 'LOW',
      dependencies: ['task-01-core'],
      created_at: new Date().toISOString(),
      hierarchy_level: 'TASK',
      metadata: { targetFiles: ['src/auth.ts'], revision: 1 },
    };

    await specStore.saveTasks([featCore, task1, task2]);

    // Save snapshot
    activeSnapshot = createAuthoritativeSnapshot();
    await sessionStore.saveSnapshot(activeSnapshot);

    // Initialize durable state with completed task-01-core
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-01-core'],
      activeTaskId: null,
      blockedState: null,
    });

    // Instantiate ClosedLoopCoordinator
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
      authorizationPolicyEngine: policyEngine,
      recoveryPolicyEngine,
      correctiveTaskService,
      executorPort: mockExecutor,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('A4-01: executes full closed-loop success cycle with independent evidence verification', async () => {
    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
    });

    assert.equal(result.isSuccess, true, 'Cycle should succeed');
    assert.equal(result.status, 'COMPLETED_SUCCESS', 'Terminal status should be COMPLETED_SUCCESS');
    assert.equal(result.stepReached, 'STATE_INTEGRATION_RECOVERY', 'Step reached should be STATE_INTEGRATION_RECOVERY');
    assert.equal(result.taskId, 'task-02-auth');
    assert.equal(result.humanDecisionRequired, false);

    // Invariant: Executor was invoked exactly once
    assert.equal(mockExecutor.executionCallCount, 1);

    // Invariant: SystemExecutionEvidence independently verified
    assert.ok(result.systemEvidence, 'Must produce independent SystemExecutionEvidence');
    assert.equal(result.systemEvidence.verificationDecision, 'ACCEPT');
    assert.ok(result.systemEvidence.changedFiles && result.systemEvidence.changedFiles.length > 0);

    // Invariant: Target file was written to disk
    const targetFilePath = path.join(tempDir, 'src/auth.ts');
    assert.ok(fs.existsSync(targetFilePath), 'Target file should exist on disk');

    // Invariant: State integrated in DurableStateManager
    const durable = await durableManager.load();
    assert.ok(durable?.completedTaskIds.includes('task-02-auth'), 'Durable state must contain completed task');

    // Invariant: HistoryManager recorded completion event
    const events = await historyManager.readEvents();
    const completedEv = events.find((e) => e.eventType === 'CLOSED_LOOP_CYCLE_COMPLETED');
    assert.ok(completedEv, 'History event CLOSED_LOOP_CYCLE_COMPLETED must be logged');
  });

  it('A4-02: strictly rejects AGY verbal self-claims when no independent evidence was produced', async () => {
    mockExecutor.simulateSelfClaimOnly = true;

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
    });

    const durable = await durableManager.load();

    assert.equal(result.isSuccess, false, 'Cycle must fail without independent evidence');
    assert.equal(result.status, 'EXECUTION_FAILED');
    assert.ok(
      result.summary.toLowerCase().includes('claim') || result.summary.toLowerCase().includes('evidence'),
      `Summary should mention verbal self-claim rejection: ${result.summary}`
    );

    // Task must NOT be marked completed in durable state
    assert.ok(!durable?.completedTaskIds.includes('task-02-auth'));
  });

  it('A4-03: transitions in-flight timeout / abort strictly to EXECUTION_UNKNOWN without auto re-dispatch', async () => {
    mockExecutor.simulateTimeout = true;

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
    });

    assert.equal(result.isSuccess, false);
    assert.equal(result.status, 'EXECUTION_UNKNOWN', 'Must enter EXECUTION_UNKNOWN');
    assert.equal(result.humanDecisionRequired, true, 'Human decision must be required');
    assert.ok(result.summary.toLowerCase().includes('timed out'));

    // Attempting to re-run must NOT re-dispatch to executor automatically
    const initialCallCount = mockExecutor.executionCallCount;
    assert.equal(initialCallCount, 1);

    const reResult = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
    });

    // Mock executor was NOT invoked again (claim conflict / already processed)
    assert.equal(mockExecutor.executionCallCount, initialCallCount, 'Must not re-dispatch to executor');
    assert.equal(reResult.isSuccess, false);
  });

  it('A4-04: policy gate DENY halts closed-loop fail-closed before execution', async () => {
    // Mandate explicitly forbids IMPLEMENT_TASK for this security test
    await saveSignedMandate({
      ...validMandate,
      projectId: validProjectId,
      forbiddenOperations: ['IMPLEMENT_TASK', 'DROP_DATABASE', 'PURGE_LOGS'],
    });

    // Decision that violates mandate forbidden operations
    const forbiddenDecision = {
      decisionType: 'IMPLEMENT_TASK' as const,
      rationale: 'Attempt operation forbidden by mandate',
      basedOnContextFingerprint: validFingerprint,
      selectedTaskId: 'task-02-auth',
      metadata: {
        taskId: 'task-02-auth',
      },
    };

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      contextSnapshot: activeSnapshot,
      customDecision: forbiddenDecision,
    });

    assert.equal(result.isSuccess, false);
    assert.equal(result.status, 'REJECTED_BY_POLICY');
    assert.equal(result.stepReached, 'POLICY_EVALUATION');
    assert.equal(result.humanDecisionRequired, false);

    // Invariant: Executor was NEVER invoked
    assert.equal(mockExecutor.executionCallCount, 0, 'Executor must not be called when denied by policy');
  });

  it('A4-05: halts approval-required operations in BLOCKED_ON_APPROVAL fail-closed', async () => {
    // Action requiring human approval under mandate (e.g. REPLAN)
    const replanDecision = {
      decisionType: 'REQUEST_PLANNING' as const,
      rationale: 'Reorganize graph',
      basedOnContextFingerprint: validFingerprint,
      metadata: {
        operationType: 'REPLAN',
      },
    };

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      contextSnapshot: activeSnapshot,
      customDecision: replanDecision,
    });

    assert.equal(result.isSuccess, false);
    assert.equal(result.status, 'BLOCKED_ON_APPROVAL');
    assert.equal(result.stepReached, 'POLICY_EVALUATION');
    assert.equal(result.humanDecisionRequired, true);

    // Invariant: Executor was NEVER invoked
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  it('A4-06: fails closed on pre-execution Bridge check when task dependencies are unmet', async () => {
    // Create task with unmet dependency
    const taskUnmet: TaskDefinition = {
      task_id: 'task-03-unmet',
      parent_feature_id: 'FEAT-CORE',
      title: 'Dependent Task',
      description: 'Dependent on missing task',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-03'],
      status: 'READY',
      attempt: 0,
      max_attempts: 2,
      priority: 'MEDIUM',
      risk_level: 'LOW',
      dependencies: ['task-non-existent'], // unmet!
      created_at: new Date().toISOString(),
      hierarchy_level: 'TASK',
      metadata: { targetFiles: ['src/dep.ts'], revision: 1 },
    };

    const currentTasks = await specStore.loadTasks();
    await specStore.saveTasks([...currentTasks, taskUnmet]);

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-03-unmet',
      contextSnapshot: activeSnapshot,
    });

    assert.equal(result.isSuccess, false);
    // Should be rejected by Dispatcher or Bridge pre-check
    assert.ok(
      result.status === 'EXECUTION_FAILED' || result.status === 'REJECTED_BY_POLICY',
      `Unexpected status: ${result.status}`
    );
    assert.equal(mockExecutor.executionCallCount, 0, 'Driver/Executor must not be invoked');
  });

  it('A4-07: bounded recovery generates a corrective task with explicit lineage on failure', async () => {
    mockExecutor.simulateFailure = true;

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
      maxRecoveryAttempts: 2,
    });

    assert.equal(result.isSuccess, false);
    // Since attempt was 0 < 2, recovery policy evaluates REPLAN and creates corrective task
    assert.equal(result.status, 'CORRECTIVE_TASK_CREATED');
    assert.ok(result.correctiveTaskId, 'Corrective task ID must be populated');
    assert.ok(result.recoveryDecision, 'Recovery policy decision must be populated');

    // Invariant: SpecStore now contains the corrective task
    const tasks = await specStore.loadTasks();
    const corrTask = tasks.find((t) => t.task_id === result.correctiveTaskId);
    assert.ok(corrTask, 'Corrective task must be saved in SpecStore');
    assert.equal(corrTask.parent_feature_id, 'FEAT-CORE');
  });

  it('A4-08: halts fail-closed with MAX_ATTEMPTS_EXCEEDED when retry limit is reached', async () => {
    mockExecutor.simulateFailure = true;

    // Set task-02-auth attempt counter to 2 (equal to max_attempts)
    const currentTasks = await specStore.loadTasks();
    const updatedTasks = currentTasks.map((t) =>
      t.task_id === 'task-02-auth' ? { ...t, attempt: 2, max_attempts: 2 } : t
    );
    await specStore.saveTasks(updatedTasks);

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
      maxRecoveryAttempts: 2,
    });

    assert.equal(result.isSuccess, false);
    assert.equal(result.status, 'MAX_ATTEMPTS_EXCEEDED');
    assert.equal(result.humanDecisionRequired, true);
    assert.ok(result.summary.includes('maximum retry attempts'));

    // Invariant: Executor ran exactly once, no infinite loop
    assert.equal(mockExecutor.executionCallCount, 1);
  });

  it('A4-09: handles REQUEST_CLARIFICATION and NO_OP reasoning decisions gracefully', async () => {
    const clarifyDecision = {
      decisionType: 'REQUEST_CLARIFICATION' as const,
      rationale: 'Need clarification on whether token expires in 15 or 60 minutes',
      basedOnContextFingerprint: validFingerprint,
      metadata: {
        questionId: 'Q-01',
        options: ['15m', '60m'],
      },
    };

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      contextSnapshot: activeSnapshot,
      customDecision: clarifyDecision,
    });

    assert.equal(result.isSuccess, true, 'Clarification should cleanly finish cycle without error');
    assert.equal(result.status, 'NO_ACTION_REQUIRED');
    assert.equal(result.stepReached, 'REASONING');
    assert.equal(result.humanDecisionRequired, true);
    assert.equal(mockExecutor.executionCallCount, 0, 'No execution should be triggered');
  });

  it('A4-10: enforces single claim and deterministic idempotency across closed-loop cycles', async () => {
    // First cycle executes successfully
    const result1 = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
      idempotencyKey: 'idem-a4-fixed-01',
    });

    assert.equal(result1.status, 'COMPLETED_SUCCESS');
    assert.equal(mockExecutor.executionCallCount, 1);

    // Second cycle with same idempotency key or already claimed intent
    const result2 = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'task-02-auth',
      contextSnapshot: activeSnapshot,
      idempotencyKey: 'idem-a4-fixed-01',
    });

    // Invariant: Mock executor was NOT invoked a second time!
    assert.equal(mockExecutor.executionCallCount, 1, 'Executor call count must not increase on duplicate execution');
    assert.equal(result2.status, 'COMPLETED_SUCCESS');
  });
});
