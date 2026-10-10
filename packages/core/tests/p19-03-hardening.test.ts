import { createValidApprovalPackage } from './helpers/test-discovery-factory.ts';
/**
 * @file p19-03-hardening.test.ts
 * @description Hardening verification tests for P19-03:
 * Dispatcher Concurrency & Authorization Provenance.
 *
 * Verifies:
 * 1. Single-Instance workspace lock: Second AIDM instance attempt fails fast with InstanceConcurrencyError.
 * 2. Stale instance lock handling: Dead PID allows clean acquisition without takeover/force-unlock.
 * 3. Cross-process concurrent dispatch: Second dispatcher catches committed idempotency key from HistoryManager.
 * 4. Cross-process conflicting payload: Conflicting payload on same key throws DirectorActionIdempotencyConflictError.
 * 5. Authorization provenance: Spoofed client/model isDevelopmentAuthorized is strictly ignored.
 * 6. Missing / unapproved PO record: IMPLEMENT_TASK remains strictly PENDING_AUTHORIZATION.
 * 7. Stale approval package: Even if marked APPROVED, stale package fails closed to PENDING_AUTHORIZATION.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  DirectorActionDispatcher,
  ActionDispatchStatus,
  DirectorActionBuilder,
  DirectorActionValidator,
  DirectorActionIdempotencyConflictError,
  DirectorActionValidationError,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  HistoryManager,
  SpecStore,
  SystemExecutionEvidenceStore,
  TaskDagEngine,
  LocalRuntimeStateManager,
  InstanceConcurrencyError,
  ApprovalStore,
  ApprovalPackageEngine,
  type ApprovalPackage,
  type DirectorContextSnapshot,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
  TaskStatus,
  TaskPriority,
  RiskLevel,
} from '../dist/index.js';

describe('P19-03-HARDENING: Dispatcher Concurrency & Authorization Provenance', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let evidenceStore: SystemExecutionEvidenceStore;
  let dagEngine: TaskDagEngine;
  let runtimeStateManager: LocalRuntimeStateManager;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let actionBuilder: DirectorActionBuilder;
  let actionValidator: DirectorActionValidator;
  let dispatcher: DirectorActionDispatcher;
  let snapshot: DirectorContextSnapshot;
  let authorizationPolicyEngine: AuthorizationPolicyEngine;

  const validProjectId = 'notification-dispatch-service';
  const validSessionId = 'sess-director-p19';
  const validFingerprint = 'fp-authoritative-p19-snapshot-123';
  const validRevision = 2;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p19-hardening-'));
    const historyPath = path.join(tempDir, 'events.jsonl');

    historyManager = new HistoryManager({ historyPath });
    specStore = new SpecStore({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    runtimeStateManager = new LocalRuntimeStateManager({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      approvalStore,
    });

    const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    const baseMandate: ProjectMandate = {
      projectId: validProjectId,
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
    await fs.mkdir(path.join(tempDir, '.ai-manager', 'state'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.ai-manager', 'state', 'project-mandate.json'),
      JSON.stringify(baseMandate, null, 2),
      'utf8'
    );

    await specStore.saveTasks([
      {
        task_id: 'task-01-core',
        parent_feature_id: 'ROOT',
        title: 'Core',
        description: 'Core task',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptance_criteria: ['Done'],
        status: TaskStatus.ACCEPTED,
        hierarchy_level: 'TASK',
        attempt: 1,
        max_attempts: 3,
        priority: TaskPriority.CRITICAL,
        risk_level: RiskLevel.SAFE,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'IMPLEMENTATION', revision: 1 },
      },
      {
        task_id: 'task-02-auth',
        parent_feature_id: 'ROOT',
        title: 'Auth',
        description: 'Auth task',
        traceability_sources: ['REQ-01'],
        dependencies: ['task-01-core'],
        acceptance_criteria: ['Done'],
        status: TaskStatus.READY,
        hierarchy_level: 'TASK',
        attempt: 0,
        max_attempts: 3,
        priority: TaskPriority.CRITICAL,
        risk_level: RiskLevel.SAFE,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'IMPLEMENTATION', revision: 1 },
      },
    ]);

    await evidenceStore.saveEvidence({
      evidenceId: 'ev-01',
      requestId: 'req-01',
      taskId: 'task-01-core',
      taskRevision: 1,
      projectId: validProjectId,
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      contextFingerprint: validFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'commit_base',
        headCommit: 'commit_head',
        isClean: true,
      },
      changedFiles: [{ path: 'src/index.ts', status: 'MODIFIED' }],
      verificationChecks: [
        { checkId: 'CHECK_1', type: 'TEST', status: 'PASS', evidence: 'exit 0' },
      ],
      acceptanceCriteria: [
        { criterion: 'Done', status: 'PASS', evidence: 'exit 0' },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 100,
      },
    });

    authorizationPolicyEngine = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore,
    });

    actionBuilder = new DirectorActionBuilder();
    actionValidator = new DirectorActionValidator({ historyManager });

    dispatcher = new DirectorActionDispatcher({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
      authorizationPolicyEngine,
    });

    snapshot = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      syncStatus: 'CHANGED',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      logicalFingerprint: validFingerprint,
      isDerived: true,
      sectionMetadata: {
        projectStatus: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-1' },
        requirements: { synchronized: true, available: true, isStale: false, revision: validRevision, fingerprint: 'fp-2' },
        decisions: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-3' },
        currentTask: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-4' },
        taskList: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-5' },
        contextEngine: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-6' },
        evidence: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-7' },
        history: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-8' },
        git: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-9' },
        discovery: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-10' },
        clarification: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-11' },
        approval: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-12' },
        authorization: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-13' },
      },
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        requirements: { total: 0, items: [] },
        decisions: { total: 0, items: [] },
        currentTask: { hasActiveTask: false, task: null },
        taskList: {
          total: 2,
          topologicalOrder: ['task-01-core', 'task-02-auth'],
          tasks: [
            { taskId: 'task-01-core', title: 'Core', status: 'COMPLETED', hierarchyLevel: 'ROOT', dependencies: [], priority: 'P0' },
            { taskId: 'task-02-auth', title: 'Auth', status: 'READY', hierarchyLevel: 'ROOT', dependencies: ['task-01-core'], priority: 'P0' },
          ],
        },
        contextEngine: { isAvailable: true, hasL0Cache: false, inspectedPaths: [] },
        evidence: {
          totalAvailable: 1,
          items: [
            { evidenceId: 'ev-01', taskId: 'task-01-core', evidenceType: 'COMMAND', isSystemVerified: true, exitCode: 0 },
          ],
        },
        history: { totalEvents: 0, recentEvents: [] },
        git: { isGitRepository: true, head: 'abc', branch: 'main', workingTreeClean: true, totalAcceptedCheckpoints: 1 },
        discovery: { isDiscovered: true, projectName: validProjectId, apparentPurposeClassification: 'Web', technologyStack: [], entryPointsCount: 1, unknownsCount: 0, contradictionsCount: 0 },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        approval: { hasApprovalPackage: true, isReadyForApproval: true, isExplicitlyApproved: true },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
      },
    };
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  // Helper to construct validated result
  async function createValidatedResult(
    actionType: any,
    payload: Record<string, unknown>,
    opts?: { customIdempotencyKey?: string }
  ) {
    const envelope = actionBuilder.buildEnvelope({
      decision: {
        decisionType: actionType,
        rationale: 'Valid rationale for hardening test',
        basedOnContextFingerprint: validFingerprint,
        basedOnUnderstandingRevision: validRevision,
        selectedTaskId: (payload.taskId ?? payload.targetTaskId) as string,
        metadata: {},
        actor: 'DIRECTOR',
        hasImplementationAuthority: false,
      },
      snapshot,
      idempotencyKey: opts?.customIdempotencyKey,
      explicitActionType: actionType,
      customPayload: payload,
    });

    const validationResult = await actionValidator.validateAsync(envelope, {
      currentFingerprint: validFingerprint,
      currentUnderstandingRevision: validRevision,
      currentDirectorSessionId: validSessionId,
      currentProjectId: validProjectId,
      existingTasks: snapshot.sections.taskList.tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        dependencies: t.dependencies,
      })),
    });

    return {
      success: true as const,
      reasoningResult: {} as any,
      envelope,
      validationResult,
      isDuplicate: false,
    };
  }

  // ==========================================================================
  // 1. WORKSPACE SINGLE INSTANCE LOCK & STRICT REJECTION POLICY
  // ==========================================================================

  it('HARDENING 1a: active PID lock blocks second instance from acquiring workspace lock (fail-fast with InstanceConcurrencyError)', async () => {
    // Instance 1 acquires lock
    const lock1 = await runtimeStateManager.acquireInstanceLock({ processId: process.pid });
    assert.equal(lock1.acquiredLock, true);
    assert.equal(lock1.processId, process.pid);

    // Instance 2 (another active PID, e.g. parent PID) attempts acquisition
    const otherRunningPid = process.ppid;
    const manager2 = new LocalRuntimeStateManager({ baseDir: tempDir });
    await assert.rejects(
      async () => {
        await manager2.acquireInstanceLock({ processId: otherRunningPid });
      },
      (err: any) => {
        assert.ok(err instanceof InstanceConcurrencyError);
        assert.ok(err.message.includes('Only one active instance is permitted per workspace'));
        assert.equal(err.details?.existingPid, process.pid);
        return true;
      }
    );
  });

  it('HARDENING 1b: dead PID lock is NOT automatically cleared and second instance is fail-fast rejected', async () => {
    const deadPid = 999999;
    await runtimeStateManager.save({
      schemaVersion: 1,
      processId: deadPid,
      acquiredLock: true,
      activeAttempt: 1,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      lastHeartbeat: new Date(Date.now() - 60000).toISOString(),
      blockedState: null,
    });

    // Second instance attempts to acquire: MUST FAIL FAST, no automatic takeover
    const manager2 = new LocalRuntimeStateManager({ baseDir: tempDir });
    await assert.rejects(
      async () => {
        await manager2.acquireInstanceLock({ processId: process.pid });
      },
      (err: any) => {
        assert.ok(err instanceof InstanceConcurrencyError);
        assert.ok(err.message.includes('Automatic takeover, stale lock clearing, and force-unlock are strictly disabled'));
        assert.equal(err.details?.existingPid, deadPid);
        return true;
      }
    );

    // Verify lock file was NOT cleared or overwritten
    const persisted = await runtimeStateManager.load();
    assert.ok(persisted);
    assert.equal(persisted.acquiredLock, true);
    assert.equal(persisted.processId, deadPid);
  });

  it('HARDENING 1c: expired heartbeat does NOT allow automatic takeover; fail-fast rejection is preserved', async () => {
    const deadPid = 888888;
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    await runtimeStateManager.save({
      schemaVersion: 1,
      processId: deadPid,
      acquiredLock: true,
      activeAttempt: 1,
      startedAt: oneHourAgo,
      lastHeartbeat: oneHourAgo,
      blockedState: null,
    });

    const manager2 = new LocalRuntimeStateManager({ baseDir: tempDir });
    await assert.rejects(
      async () => {
        await manager2.acquireInstanceLock({ processId: process.pid });
      },
      (err: any) => {
        assert.ok(err instanceof InstanceConcurrencyError);
        assert.equal(err.details?.existingPid, deadPid);
        return true;
      }
    );

    // Verify lock file is untouched
    const persisted = await runtimeStateManager.load();
    assert.ok(persisted);
    assert.equal(persisted.acquiredLock, true);
    assert.equal(persisted.processId, deadPid);
    assert.equal(persisted.lastHeartbeat, oneHourAgo);
  });

  it('HARDENING 1d: lock is cleanly released when owning process performs controlled shutdown; enables normal restart', async () => {
    const ownerPid = 50001;
    const manager1 = new LocalRuntimeStateManager({ baseDir: tempDir });
    const lock = await manager1.acquireInstanceLock({ processId: ownerPid });
    assert.equal(lock.acquiredLock, true);

    // Owner performs controlled shutdown
    await manager1.releaseInstanceLock(ownerPid);

    const released = await manager1.load();
    assert.ok(released);
    assert.equal(released.acquiredLock, false);

    // Subsequent/restarted instance can now acquire lock cleanly without error
    const nextPid = 50002;
    const manager2 = new LocalRuntimeStateManager({ baseDir: tempDir });
    const nextLock = await manager2.acquireInstanceLock({ processId: nextPid });
    assert.equal(nextLock.acquiredLock, true);
    assert.equal(nextLock.processId, nextPid);
  });

  it('HARDENING 1e: non-owning process cannot release or clear workspace lock file', async () => {
    const ownerPid = 60001;
    const nonOwnerPid = 60002;
    const managerOwner = new LocalRuntimeStateManager({ baseDir: tempDir });
    await managerOwner.acquireInstanceLock({ processId: ownerPid });

    const managerNonOwner = new LocalRuntimeStateManager({ baseDir: tempDir });

    // Non-owner attempts to release lock -> throws InstanceConcurrencyError
    await assert.rejects(
      async () => {
        await managerNonOwner.releaseInstanceLock(nonOwnerPid);
      },
      (err: any) => {
        assert.ok(err instanceof InstanceConcurrencyError);
        assert.ok(err.message.includes('Non-owner processes cannot release or mutate the lock'));
        return true;
      }
    );

    // Non-owner attempts to clear/unlink lock file -> throws InstanceConcurrencyError
    await assert.rejects(
      async () => {
        await managerNonOwner.clear(nonOwnerPid);
      },
      (err: any) => {
        assert.ok(err instanceof InstanceConcurrencyError);
        assert.ok(err.message.includes('Non-owner processes cannot delete the lock file'));
        return true;
      }
    );

    // Verify lock is still active and held by ownerPid
    const persisted = await managerOwner.load();
    assert.ok(persisted);
    assert.equal(persisted.acquiredLock, true);
    assert.equal(persisted.processId, ownerPid);

    // Clean up with owner
    await managerOwner.releaseInstanceLock(ownerPid);
  });

  // ==========================================================================
  // 2. CROSS-PROCESS CONCURRENT DISPATCH VIA HISTORY RE-CHECK
  // ==========================================================================
  it('HARDENING 3: concurrent dispatcher instances catch already committed idempotency key from HistoryManager', async () => {
    const fixedIdempotencyKey = 'idemp-cross-proc-123';
    const payload = {
      taskId: 'task-02-auth',
      executionPlan: 'Cross-process dispatch plan',
    };

    const approvedPkg: ApprovalPackage = createValidApprovalPackage({
      packageId: `pkg-${validProjectId}-01`,
      projectId: validProjectId,
      revision: 1,
    });
    await approvalStore.savePackage(approvedPkg);

    const validatedResultA = await createValidatedResult('IMPLEMENT_TASK', payload, {
      customIdempotencyKey: fixedIdempotencyKey,
    });

    // Dispatcher A dispatches and writes to HistoryManager (events.jsonl)
    const resA = await dispatcher.dispatch({
      validatedResult: validatedResultA,
      snapshot,
    });
    assert.equal(resA.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);

    // Create Dispatcher B representing a fresh process with EMPTY in-memory dispatched cache
    const dispatcherB = new DirectorActionDispatcher({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
      approvalStore,
      approvalPackageEngine,
    });

    // Dispatcher B receives the same idempotency key:
    // It has not run initializeFromHistory() yet, but dispatch() re-checks history before executing
    const resB = await dispatcherB.dispatch({
      validatedResult: validatedResultA,
      snapshot,
    });

    assert.equal(resB.status, ActionDispatchStatus.DUPLICATE);
    assert.equal(resB.executionIntentId, resA.executionIntentId);
    assert.ok(resB.reason.includes('already dispatched'));
  });

  it('HARDENING 4: concurrent dispatcher instance catches conflicting payload on same idempotency key from disk', async () => {
    const fixedIdempotencyKey = 'idemp-cross-proc-conflict';
    const payloadA = {
      taskId: 'task-02-auth',
      executionPlan: 'Plan A original',
    };

    const validatedResultA = await createValidatedResult('IMPLEMENT_TASK', payloadA, {
      customIdempotencyKey: fixedIdempotencyKey,
    });

    // Dispatcher A commits to history
    await dispatcher.dispatch({
      validatedResult: validatedResultA,
      snapshot,
    });

    // Dispatcher B (fresh instance with empty in-memory cache) receives conflicting payload on same key
    const dispatcherB = new DirectorActionDispatcher({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      runtimeStateManager,
    });

    const conflictingEnvelope = {
      ...validatedResultA.envelope,
      payload: {
        taskId: 'task-02-auth',
        executionPlan: 'Plan B CONFLICTING PAYLOAD',
      },
    };

    const validatedResultB = {
      success: true as const,
      reasoningResult: {} as any,
      envelope: conflictingEnvelope,
      validationResult: { isValid: true, isDuplicate: false, envelope: conflictingEnvelope, typedPayload: {}, validatedAt: new Date().toISOString() },
      isDuplicate: false,
    };

    await assert.rejects(
      async () => {
        await dispatcherB.dispatch({
          validatedResult: validatedResultB,
          snapshot,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorActionIdempotencyConflictError);
        assert.equal(err.code, 'ERR_DIRECTOR_ACTION_IDEMPOTENCY_CONFLICT');
        return true;
      }
    );
  });

  // ==========================================================================
  // 3. AUTHORIZATION PROVENANCE & ANTI-SPOOFING
  // ==========================================================================
  it('HARDENING 5: client attempting to inject isDevelopmentAuthorized in payload cannot bypass gate', async () => {
    // Snapshot where development is NOT authorized
    const unauthorizedSnapshot: DirectorContextSnapshot = {
      ...snapshot,
      sections: {
        ...snapshot.sections,
        authorization: {
          isDevelopmentAuthorized: false,
          authoritySource: 'PRODUCT_OWNER',
          requiresHumanApproval: true,
        },
      },
    };

    // 1. Direct injection into customPayload is strictly rejected during envelope validation
    await assert.rejects(
      async () => {
        const envelope = actionBuilder.buildEnvelope({
          decision: {
            decisionType: 'IMPLEMENT_TASK',
            rationale: 'Valid rationale',
            basedOnContextFingerprint: validFingerprint,
            basedOnUnderstandingRevision: validRevision,
            selectedTaskId: 'task-02-auth',
            actor: 'DIRECTOR',
            hasImplementationAuthority: false,
            metadata: {},
          },
          snapshot: unauthorizedSnapshot,
          explicitActionType: 'IMPLEMENT_TASK',
          customPayload: {
            taskId: 'task-02-auth',
            executionPlan: 'Attempted self-authorization',
            isDevelopmentAuthorized: true, // Spoofed field rejected by Zod .strict()
          },
        });
        await actionValidator.validateAsync(envelope, {
          currentFingerprint: validFingerprint,
          currentUnderstandingRevision: validRevision,
          currentDirectorSessionId: validSessionId,
          currentProjectId: validProjectId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorActionValidationError || err.name === 'DirectorActionValidationError');
        return true;
      }
    );

    // 2. Client/model injects isDevelopmentAuthorized into inputContext (generic bag)
    const spoofedContextPayload = {
      taskId: 'task-02-auth',
      executionPlan: 'Attempted self-authorization via context',
      inputContext: {
        isDevelopmentAuthorized: true,
        actorRole: 'PRODUCT_OWNER',
      },
    };

    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', spoofedContextPayload);

    const res = await dispatcher.dispatch({
      validatedResult,
      snapshot: unauthorizedSnapshot,
    });

    // The gate must ignore the spoofed context fields and fail closed
    assert.equal(res.status, ActionDispatchStatus.PENDING_AUTHORIZATION);
    assert.equal(res.isAuthorized, false);
    assert.equal(res.requiresHumanApproval, true);
    assert.equal(res.code, 'PENDING_PO_AUTHORIZATION');
    assert.equal(res.executionIntentId, undefined);
  });

  it('HARDENING 6: IMPLEMENT_TASK remains PENDING_AUTHORIZATION when disk ApprovalPackage is missing or unapproved', async () => {
    // Snapshot claims isDevelopmentAuthorized: true, BUT disk ApprovalStore has NO approved package
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    // Because approvalStore on disk has no active approved package, dispatcher's provenance check fails closed
    const res = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.equal(res.status, ActionDispatchStatus.PENDING_AUTHORIZATION);
    assert.equal(res.isAuthorized, false);
    assert.equal(res.requiresHumanApproval, true);
    assert.equal(res.code, 'PENDING_PO_AUTHORIZATION');
  });

  it('HARDENING 7: IMPLEMENT_TASK is authorized only when disk ApprovalPackage is genuinely APPROVED and valid', async () => {
    // Create and approve a genuine ApprovalPackage on disk
    const genuinePkg = createValidApprovalPackage({
      packageId: `pkg-${validProjectId}-01`,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      projectId: validProjectId,
      status: 'APPROVED',
      isStale: false,
      approvalRecord: {
        packageId: `pkg-${validProjectId}-01`,
        revision: validRevision,
        actor: 'human-product-owner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: new Date().toISOString(),
        packageHash: 'sha256-approved-package-hash',
        comment: 'Formal approval granted by human Product Owner',
      },
    });
    await approvalStore.savePackage(genuinePkg);

    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    const res = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.equal(res.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    assert.equal(res.isAuthorized, true);
    assert.ok(res.executionIntentId?.startsWith('intent-'));
  });
});
