/**
 * @file p20-01b-consistency-hardening.test.ts
 * @description P20-01B: Execution Bridge Final Consistency & Crash-Safety Hardening Test Suite.
 *
 * Covers the 10 required test scenarios:
 * 1. Reservation sonrasında HistoryManager yazılmadan süreç çökmesi.
 * 2. Restart sonrasında sahipsiz reservation recovery.
 * 3. HistoryManager kaydı başarılı, reservation durumu tutarsız.
 * 4. Aynı reservation'ın recovery sırasında ikinci kez kullanılmasının engellenmesi.
 * 5. MCP üzerinden sahte PO onayı yazma girişimi.
 * 6. LLM/model yanıtıyla sahte PO onayı üretme girişimi.
 * 7. Onay paketi revision uyuşmazlığı.
 * 8. Onay geri çekildikten sonra bekleyen intent'in reddedilmesi.
 * 9. Gerçek LLM çağrısı olmayan AGY yürütmesinde P18-03 token maliyeti oluşturulmaması.
 * 10. Gerçek LLM provider çağrısı için mevcut bütçe korumasının bozulmadığının test edilmesi (mock fixture ile).
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
  resolveCanonicalProjectIdentity,
} from '../dist/index.js';
import { ReservationState } from '../dist/budget/budget-types.js';
import { createApprovalPackageApproveTool } from '../dist/mcp/tools/approval-tools.js';
import { McpPolicyBlockedError } from '../dist/mcp/mcp-errors.js';

describe('Phase 20 TASK-P20-01B — Execution Bridge Final Consistency & Crash-Safety Hardening', { concurrency: 1 }, () => {
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

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;
  let implementDecision: DirectorDecision;
  let task1: TaskDefinition;

  class MockHardeningExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-hardening-executor';
    readonly provider = 'antigravity';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    executionCallCount = 0;
    isAvailable = true;

    async checkAvailability() {
      return { available: this.isAvailable, reason: this.isAvailable ? undefined : 'Executor host not found' };
    }

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      this.executionCallCount++;

      // Mutate filesystem so independent EvidenceCollector verifies changes
      const files = request.targetFiles && request.targetFiles.length > 0 ? request.targetFiles : ['src/hardening.ts'];
      for (const f of files) {
        const full = path.join(tempDir, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '// hardened execution\n', 'utf8');
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
        stdout: 'Task implemented successfully',
        stderr: '',
        durationMs: 15,
        unverifiedAgentClaims: ['Created hardened code'],
        unverifiedModifiedFiles: files,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }
  }

  let mockExecutor: MockHardeningExecutor;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p20-01b-test-'));

    // Initialize clean Git repo for Evidence Collector
    canonicalProjectId = resolveCanonicalProjectIdentity(tempDir).projectId;
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: canonicalProjectId, version: '1.0.0', type: 'module' }),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\nnode_modules/\nbudget.sqlite*\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# P20-01B Hardening Project\n', 'utf8');

    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm@test.local"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git add . && git commit -m "initial commit"', {
      cwd: tempDir,
      stdio: 'ignore',
    });

    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir });
    decisionStore = new DirectorDecisionStore({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir });
    approvalPackageEngine = new ApprovalPackageEngine({ workspaceRoot: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine({ specStore });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    runtimeStateManager = new LocalRuntimeStateManager({ baseDir: tempDir });

    budgetManager = new BudgetManager({ dbPath: path.join(tempDir, 'budget.sqlite') });
    budgetManager.open();
    budgetManager.createProjectAccount(canonicalProjectId, 100.0); // $100 budget

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
      providerId: 'openai',
      modelId: 'gpt-4o',
      inputRateNum: 2500n,
      inputRateDen: 1000000n,
      outputRateNum: 10000n,
      outputRateDen: 1000000n,
    });

    sessionEngine = new DirectorSessionEngine({
      workspaceRoot: tempDir,
      sessionStore,
      decisionStore,
      historyManager,
    });

    mockExecutor = new MockHardeningExecutor();
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

    // 1. Create Director Session & Context Snapshot
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      understandingRevision: 1,
    });

    activeSnapshot = {
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      logicalFingerprint: 'hardening-fingerprint-001',
      isComplete: true,
      syncStatus: 'UNCHANGED',
      sections: {} as any,
      unavailableSections: [],
      staleSections: [],
      sectionMetadata: {} as any,
      isDerived: true,
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    // 2. Create and Approve ApprovalPackage (revision 1)
    const rawPkg: ApprovalPackage = {
      packageId: `pkg-${Date.now()}`,
      projectId: canonicalProjectId,
      revision: 1,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isStale: false,
      understanding: {
        projectName: 'Hardening Project',
        summary: 'P20-01B hardening tests',
        techStack: ['typescript'],
        architecturePatterns: ['hexagonal'],
        conventions: ['strict-clean'],
      },
      specifications: {
        requirements: ['req-01'],
        architectureDecisions: ['dec-01'],
        businessRules: ['rule-01'],
        acceptanceCriteria: ['acc-01'],
      },
      plannedTasks: [
        {
          task_id: 'TASK-HARDEN-01',
          title: 'Hardening Task 1',
          description: 'Harden execution bridge against crashes',
          status: 'PENDING',
          dependencies: [],
          metadata: { revision: 1 },
        },
      ],
      approvalRecord: {
        packageId: `pkg-${canonicalProjectId}-01`,
        revision: 1,
        actor: 'HUMAN_PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: new Date().toISOString(),
        packageHash: 'sha256-approved-package-hash-hardening',
        comment: 'Hardening approval granted',
      },
    };
    await approvalStore.savePackage(rawPkg);
    approvedPackage = rawPkg;

    // 3. Populate Task DAG in SpecStore
    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-HARDEN-01',
      parent_feature_id: 'ROOT',
      title: 'Parent Hardening Feature',
      description: 'Parent feature node for hardening tests',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-HARDEN-01'],
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
      task_id: 'TASK-HARDEN-01',
      parent_feature_id: 'FEAT-HARDEN-01',
      title: 'Hardening Task 1',
      description: 'Harden execution bridge against crashes',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01: Hardening checks pass'],
      status: 'READY' as any,
      attempt: 0,
      max_attempts: 2,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      dependencies: [],
      metadata: { revision: 1, target_files: ['src/hardening.ts'] },
    };
    await specStore.saveTasks([parentFeature, task1]);

    // 4. Create Decision
    implementDecision = {
      decisionId: 'dec-hardening-01',
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Harden execution bridge consistency',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: approvedPackage.revision,
      basedOnUnderstandingRevision: activeSession.understandingRevision,
      createdAt: new Date().toISOString(),
      metadata: { taskId: 'TASK-HARDEN-01' },
      hasImplementationAuthority: false,
    };
    await decisionStore.saveDecision(implementDecision);
  });

  afterEach(async () => {
    budgetManager.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  function createValidIntent(overrides?: Partial<BridgeExecutionIntent>): BridgeExecutionIntent {
    return createFrozenBridgeExecutionIntent({
      executionIntentId: `intent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      actionId: `action-${Date.now()}`,
      idempotencyKey: `idem-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      projectId: canonicalProjectId,
      directorSessionId: activeSession.directorSessionId,
      taskId: 'TASK-HARDEN-01',
      taskRevision: 1,
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: approvedPackage.revision,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Execute hardened task',
      metadata: {},
      ...overrides,
    });
  }

  // ==========================================================================
  // TEST 1: Reservation sonrasında HistoryManager yazılmadan süreç çökmesi
  // ==========================================================================
  it('TEST 1: Reservation succeeds, crash before HistoryManager write leaves orphaned PREPARED reservation', async () => {
    const projectAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(projectAccount);

    // Simulate reservation succeeding in SQLite
    const idempotencyKey = `idem-crash-before-history-${Date.now()}`;
    const reservation = budgetManager.reserve({
      accountId: projectAccount.accountId,
      estimatedTokens: { inputTokens: 500, outputTokens: 500 },
      modelId: 'default',
      providerId: 'antigravity',
      sessionId: activeSession.directorSessionId,
      taskId: 'TASK-HARDEN-01',
      idempotencyKey,
    });

    assert.ok(reservation.reservationId);
    assert.equal(reservation.state, ReservationState.PREPARED);

    // Verify reservation is stored in DB in PREPARED state
    const saved = budgetManager.getReservation(reservation.reservationId);
    assert.ok(saved);
    assert.equal(saved.state, ReservationState.PREPARED);

    // HistoryManager was NEVER written (simulating instant process crash/SIGKILL)
    const events = await historyManager.readEvents();
    const claimEvent = events.find((e) => e.eventType === 'EXECUTION_BRIDGE_INTENT_CLAIMED');
    assert.equal(claimEvent, undefined, 'No claim event must exist in HistoryManager');
  });

  // ==========================================================================
  // TEST 2: Restart sonrasında sahipsiz reservation recovery
  // ==========================================================================
  it('TEST 2: Restart recovery safely reconciles orphaned PREPARED reservation to RELEASED', async () => {
    const projectAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(projectAccount);

    const idempotencyKey = `idem-orphaned-${Date.now()}`;
    const reservation = budgetManager.reserve({
      accountId: projectAccount.accountId,
      estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
      modelId: 'default',
      providerId: 'antigravity',
      sessionId: activeSession.directorSessionId,
      taskId: 'TASK-HARDEN-01',
      idempotencyKey,
    });
    assert.equal(reservation.state, ReservationState.PREPARED);

    // Start a new ExecutionBridge instance representing post-restart AIDM
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
    });

    // Run recovery
    const recoveryResult = await bridge.recover();
    assert.ok(recoveryResult.budgetRecoveryReport);
    assert.equal(
      recoveryResult.budgetRecoveryReport.releasedPreparedCount,
      1,
      'Orphaned PREPARED reservation must be safely released by recovery'
    );

    // Verify reservation in DB is now RELEASED
    const recoveredReservation = budgetManager.getReservation(reservation.reservationId);
    assert.ok(recoveredReservation);
    assert.equal(recoveredReservation.state, ReservationState.RELEASED);

    // Intent was never claimed in HistoryManager -> 0 recovered intents, no duplicate execution
    assert.equal(recoveryResult.recoveredCount, 0);
    assert.equal(mockExecutor.executionCallCount, 0, 'No AGY subprocess or executor call triggered during recovery');
  });

  // ==========================================================================
  // TEST 3: HistoryManager kaydı başarılı, reservation durumu tutarsız
  // ==========================================================================
  it('TEST 3: HistoryManager record exists, DISPATCHED reservation reconciles to UNKNOWN hold on crash recovery', async () => {
    const intent = createValidIntent();

    // 1. Manually write claim to HistoryManager
    await historyManager.appendEvent({
      eventId: `ev-claim-${Date.now()}`,
      eventType: 'EXECUTION_BRIDGE_INTENT_CLAIMED',
      actor: 'ORCHESTRATOR' as any,
      taskId: intent.taskId,
      payload: {
        executionIntentId: intent.executionIntentId,
        idempotencyKey: intent.idempotencyKey,
        projectId: intent.projectId,
        directorSessionId: intent.directorSessionId,
        taskId: intent.taskId,
        status: ExecutionBridgeStatus.EXECUTION_CLAIMED,
        claimedAt: new Date().toISOString(),
        processId: 99999,
        budgetReservationId: 'res-dispatched-crashed',
      },
    });

    // 2. Create reservation and mark it DISPATCHED in SQLite
    const projectAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(projectAccount);
    const res = budgetManager.reserve({
      accountId: projectAccount.accountId,
      estimatedTokens: { inputTokens: 500, outputTokens: 500 },
      modelId: 'default',
      providerId: 'antigravity',
      sessionId: activeSession.directorSessionId,
      taskId: intent.taskId,
      idempotencyKey: intent.idempotencyKey,
    });
    budgetManager.markDispatched(res.reservationId);

    const beforeRecovery = budgetManager.getReservation(res.reservationId);
    assert.equal(beforeRecovery?.state, ReservationState.DISPATCHED);

    // 3. Restart AIDM & run recovery
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
    });

    const recoveryResult = await bridge.recover();

    // Bridge reconciles in-flight intent to EXECUTION_UNKNOWN (NO verified evidence)
    assert.equal(recoveryResult.recoveredCount, 1);
    assert.equal(recoveryResult.reconciledIntents[intent.executionIntentId], ExecutionBridgeStatus.EXECUTION_UNKNOWN);

    // Budget recovery transitions DISPATCHED reservation to UNKNOWN hold
    assert.ok(recoveryResult.budgetRecoveryReport);
    assert.equal(recoveryResult.budgetRecoveryReport.transitionedDispatchedToUnknownCount, 1);

    const afterRecovery = budgetManager.getReservation(res.reservationId);
    assert.equal(afterRecovery?.state, ReservationState.UNKNOWN, 'Dispatched reservation must enter UNKNOWN hold');
  });

  // ==========================================================================
  // TEST 4: Aynı reservation'ın recovery sırasında ikinci kez kullanılmasının engellenmesi
  // ==========================================================================
  it('TEST 4: Recovered RELEASED or UNKNOWN reservation cannot be reused or re-claimed', async () => {
    const projectAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(projectAccount);

    // Prepare reservation and recover it to RELEASED
    const res = budgetManager.reserve({
      accountId: projectAccount.accountId,
      estimatedTokens: { inputTokens: 500, outputTokens: 500 },
      modelId: 'default',
      providerId: 'antigravity',
      sessionId: activeSession.directorSessionId,
      taskId: 'TASK-HARDEN-01',
      idempotencyKey: `idem-single-use-${Date.now()}`,
    });

    budgetManager.recover(); // Sweeps PREPARED -> RELEASED

    const recoveredRes = budgetManager.getReservation(res.reservationId);
    assert.equal(recoveredRes?.state, ReservationState.RELEASED);

    // Attempting to claim a RELEASED reservation for dispatch MUST throw
    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          modelId: 'default',
          providerId: 'antigravity',
          idempotencyKey: 're-claim-attempt',
        });
      },
      (err: any) => {
        assert.ok(err.code === 'ERR_INVALID_RESERVATION_STATE' || err.message.includes('RELEASED'));
        return true;
      }
    );

    // Attempting to settle a RELEASED reservation MUST also throw
    assert.throws(
      () => {
        budgetManager.settle(
          {
            reservationId: res.reservationId,
            reportedUsage: { inputTokens: 100, outputTokens: 100 },
            idempotencyKey: 're-settle-attempt',
          },
          'antigravity'
        );
      },
      (err: any) => {
        assert.ok(err.code === 'ERR_INVALID_RESERVATION_STATE' || err.message.includes('RELEASED'));
        return true;
      }
    );
  });

  // ==========================================================================
  // TEST 5: MCP üzerinden sahte PO onayı yazma girişimi
  // ==========================================================================
  it('TEST 5: Attempting to submit fake PO approval via MCP tool is rejected fail-closed with McpPolicyBlockedError', async () => {
    const approveTool = createApprovalPackageApproveTool();

    // 1. Non-human forbidden actors (DIRECTOR, ANTIGRAVITY, EXECUTOR, SYSTEM)
    await assert.rejects(
      async () => {
        await approveTool.handler(
          {
            workspaceRoot: tempDir,
            projectId: canonicalProjectId,
            packageId: approvedPackage.packageId,
            revision: 1,
            actor: 'DIRECTOR',
            actorRole: 'PRODUCT_OWNER',
            intent: 'EXPLICIT_APPROVAL',
          },
          { requestId: 'req-01' }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpPolicyBlockedError);
        assert.match(err.message, /Unauthorized approval actor 'DIRECTOR'/);
        return true;
      }
    );

    // 2. Forbidden actor role (e.g. LLM_ASSISTANT)
    await assert.rejects(
      async () => {
        await approveTool.handler(
          {
            workspaceRoot: tempDir,
            projectId: canonicalProjectId,
            packageId: approvedPackage.packageId,
            revision: 1,
            actor: 'AGENT_LLM',
            actorRole: 'LLM_ASSISTANT',
            intent: 'EXPLICIT_APPROVAL',
          },
          { requestId: 'req-02' }
        );
      },
      (err: any) => {
        assert.ok(err instanceof McpPolicyBlockedError);
        assert.match(err.message, /Only PRODUCT_OWNER or USER may grant approval/);
        return true;
      }
    );
  });

  // ==========================================================================
  // TEST 6: LLM/model yanıtıyla sahte PO onayı üretme girişimi
  // ==========================================================================
  it('TEST 6: LLM response with forged authorizationReference is rejected fail-closed by Check 6', async () => {
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
    });

    // Model attempts to forge authorization with a non-existent package
    const fakeIntent = createValidIntent({
      authorizationReference: {
        packageId: 'forged-pkg-from-model-json',
        packageRevision: 999,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(fakeIntent);
    assert.equal(valResult.isValid, false);

    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'ERR_PO_AUTHORIZATION_REQUIRED');
    assert.match(check6.reason, /Approval package ID mismatch|Active Product Owner approval package not found/);

    // Driver execution must NOT be called
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 7: Onay paketi revision uyuşmazlığı
  // ==========================================================================
  it('TEST 7: Approval package revision mismatch is rejected fail-closed by Check 6', async () => {
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
    });

    // Intent references revision 2, but ApprovalStore only has revision 1
    const mismatchedIntent = createValidIntent({
      authorizationReference: {
        packageId: approvedPackage.packageId,
        packageRevision: 2, // Mismatch!
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
    });

    const valResult = await bridge.validatePreconditions(mismatchedIntent);
    assert.equal(valResult.isValid, false);

    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'ERR_PO_AUTHORIZATION_REQUIRED');
    assert.match(check6.reason, /Approval package revision mismatch/);
  });

  // ==========================================================================
  // TEST 8: Onay geri çekildikten sonra bekleyen intent'in reddedilmesi
  // ==========================================================================
  it('TEST 8: Revoked or marked-stale approval package rejects pending intent execution fail-closed', async () => {
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
    });

    const intent = createValidIntent();

    // 1. Product Owner revokes approval by marking package REJECTED or stale
    const revokedPkg: ApprovalPackage = {
      ...approvedPackage,
      status: 'REJECTED',
      isStale: true,
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(revokedPkg);

    // 2. Validate preconditions
    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);

    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'ERR_PO_AUTHORIZATION_REQUIRED');

    // 3. Execution attempt fails closed without Driver handoff
    const execResult = await bridge.executeIntent(intent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(mockExecutor.executionCallCount, 0);
  });

  // ==========================================================================
  // TEST 9: Gerçek LLM çağrısı olmayan AGY yürütmesinde P18-03 token maliyeti oluşturulmaması
  // ==========================================================================
  it('TEST 9: Pure AGY/Driver execution (requiresLlm: false) does NOT reserve or consume P18-03 token budget', async () => {
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
    });

    const initialAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(initialAccount);
    assert.equal(initialAccount.committedSpendNanoUsd, 0n);

    // Intent declares local AGY execution without LLM provider calls
    const pureAgyIntent = createValidIntent({
      metadata: {
        requiresLlm: false,
      },
    });

    // Check 7 passes with bypass message
    const valResult = await bridge.validatePreconditions(pureAgyIntent);
    assert.equal(valResult.isValid, true);
    const check7 = valResult.allChecks.find((c) => c.checkName === '7_BUDGET_AVAILABILITY');
    assert.ok(check7);
    assert.equal(check7.passed, true);
    assert.match(check7.reason, /Local AGY\/Driver execution without LLM provider calls does not consume P18-03 token budget/);

    // Claim does NOT create a budget reservation
    const claimIntentObj = createValidIntent({
      metadata: { requiresLlm: false },
    });
    const claim = await bridge.claimIntent(claimIntentObj);
    assert.equal(claim.budgetReservationId, undefined, 'No budget reservation ID on claim for pure AGY execution');

    // Execution succeeds without token budget settlement
    const execIntentObj = createValidIntent({
      metadata: { requiresLlm: false },
    });
    const execResult = await bridge.executeIntent(execIntentObj);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.equal(execResult.budgetReservationId, undefined);

    const postAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(postAccount);
    assert.equal(postAccount.committedSpendNanoUsd, 0n, 'Committed token spend MUST remain 0 for non-LLM AGY runs');
    assert.equal(postAccount.reservedSpendNanoUsd, 0n, 'Reserved token spend MUST remain 0 for non-LLM AGY runs');
  });

  // ==========================================================================
  // TEST 10: Gerçek LLM provider çağrısı için mevcut bütçe korumasının bozulmadığının test edilmesi (mock fixture ile)
  // ==========================================================================
  it('TEST 10: Real LLM provider calls enforce P18-03 budget pre-dispatch checks, reservation, and settlement', async () => {
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
    });

    // A) Intent requiring LLM within available budget -> succeeds and settles
    const llmIntent = createValidIntent({
      metadata: {
        requiresLlm: true,
        modelId: 'gpt-4o',
        providerId: 'openai',
        estimatedTokens: { inputTokens: 1000, outputTokens: 500 },
      },
    });

    const valResult = await bridge.validatePreconditions(llmIntent);
    assert.equal(valResult.isValid, true);
    const check7 = valResult.allChecks.find((c) => c.checkName === '7_BUDGET_AVAILABILITY');
    assert.ok(check7);
    assert.equal(check7.passed, true);

    const execResult = await bridge.executeIntent(llmIntent);
    assert.equal(execResult.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED);
    assert.ok(execResult.budgetReservationId, 'Budget reservation must be created for LLM execution');

    // Verify reservation was settled in SQLite
    const settledRes = budgetManager.getReservation(execResult.budgetReservationId);
    assert.ok(settledRes);
    assert.equal(settledRes.state, ReservationState.SETTLED);

    const postAccount = budgetManager.getProjectAccount(canonicalProjectId);
    assert.ok(postAccount);
    assert.ok(postAccount.committedSpendNanoUsd > 0n, 'Committed spend must increase after LLM token settlement');

    // B) Intent requiring LLM exceeding budget -> fails closed at Check 7
    const zeroBudgetProject = `proj-broke-${Date.now()}`;
    budgetManager.createProjectAccount(zeroBudgetProject, 0.000000001); // Negligible budget

    const brokeIntent = createValidIntent({
      projectId: zeroBudgetProject,
      metadata: {
        requiresLlm: true,
        modelId: 'gpt-4o',
        providerId: 'openai',
        estimatedTokens: { inputTokens: 100000, outputTokens: 50000 },
      },
    });

    const brokeVal = await bridge.validatePreconditions(brokeIntent);
    assert.equal(brokeVal.isValid, false);
    const brokeCheck7 = brokeVal.allChecks.find((c) => c.checkName === '7_BUDGET_AVAILABILITY');
    assert.ok(brokeCheck7);
    assert.equal(brokeCheck7.passed, false);
    assert.equal(brokeCheck7.code, 'ERR_BUDGET_EXCEEDED');
  });
});
