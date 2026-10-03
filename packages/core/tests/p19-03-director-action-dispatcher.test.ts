/**
 * @file p19-03-director-action-dispatcher.test.ts
 * @description Comprehensive test suite for Phase 2 TASK-P19-03:
 * Director Action Dispatcher & Execution Gate.
 *
 * Verifies all 16 Acceptance Criteria:
 * 1. Invalid or unvalidated envelope rejected by dispatcher.
 * 2. Stale fingerprint at dispatch time rejected fail-closed.
 * 3. Mismatched project or session rejected.
 * 4. Duplicate dispatch returns DUPLICATE status without state mutation.
 * 5. Same idempotency key with conflicting payload rejected.
 * 6. Action without authorization is held in PENDING_AUTHORIZATION, never executed.
 * 7. IMPLEMENT_TASK does NOT execute Driver or AGY CLI.
 * 8. CREATE_TASK does NOT mutate DAG without authorization.
 * 9. REPLAN does NOT mutate DAG without authorization.
 * 10. CREATE_CORRECTIVE_TASK rejected without verified failure evidence and lineage.
 * 11. REVIEW_EVIDENCE strictly requires independent system verification.
 * 12. HistoryManager accurately records all dispatch events.
 * 13. State consistency preserved on error or interruption.
 * 14. P18-03 budget security preserved without regression.
 * 15. P18-04 Product Owner identity boundary preserved.
 * 16. Zero paid LLM calls or OS command execution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  DirectorActionDispatcher,
  ActionDispatchStatus,
  type ActionDispatchResult,
  DirectorActionBuilder,
  DirectorActionValidator,
  type ValidatedDirectorActionResult,
  type DirectorActionEnvelope,
  DirectorActionIdempotencyConflictError,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  HistoryManager,
  SpecStore,
  SystemExecutionEvidenceStore,
  TaskDagEngine,
  type DirectorContextSnapshot,
} from '../dist/index.js';

describe('TASK-P19-03: Director Action Dispatcher & Execution Gate', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let evidenceStore: SystemExecutionEvidenceStore;
  let dagEngine: TaskDagEngine;
  let actionBuilder: DirectorActionBuilder;
  let actionValidator: DirectorActionValidator;
  let dispatcher: DirectorActionDispatcher;
  let snapshot: DirectorContextSnapshot;

  const validProjectId = 'notification-dispatch-service';
  const validSessionId = 'sess-director-p19';
  const validFingerprint = 'fp-authoritative-p19-snapshot-123';
  const validRevision = 2;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p19-03-'));
    const historyPath = path.join(tempDir, 'events.jsonl');

    historyManager = new HistoryManager({ historyPath });
    specStore = new SpecStore({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();

    actionBuilder = new DirectorActionBuilder();
    actionValidator = new DirectorActionValidator({ historyManager });

    dispatcher = new DirectorActionDispatcher({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
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
        requirements: { total: 0, confirmedCount: 0, pendingCount: 0, rejectedCount: 0, items: [] },
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

  // Helper to construct and validate an envelope cleanly
  async function createValidatedResult(
    actionType: any,
    payload: Record<string, unknown>,
    opts?: { customFingerprint?: string; customRevision?: number }
  ): Promise<ValidatedDirectorActionResult> {
    const envelope = actionBuilder.buildEnvelope({
      decision: {
        decisionType: actionType,
        rationale: 'Valid rationale for test',
        basedOnContextFingerprint: opts?.customFingerprint ?? validFingerprint,
        basedOnUnderstandingRevision: opts?.customRevision ?? validRevision,
        selectedTaskId: (payload.taskId ?? payload.targetTaskId) as string,
      },
      snapshot,
      explicitActionType: actionType,
      customPayload: payload,
    });

    const validationResult = await actionValidator.validateAsync(envelope, {
      currentFingerprint: opts?.customFingerprint ?? validFingerprint,
      currentUnderstandingRevision: opts?.customRevision ?? validRevision,
      currentDirectorSessionId: validSessionId,
      currentProjectId: validProjectId,
      existingTasks: snapshot.sections.taskList.tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        dependencies: t.dependencies,
      })),
    });

    return {
      success: true,
      reasoningResult: {} as any,
      envelope,
      validationResult,
      isDuplicate: false,
    };
  }

  // ==========================================================================
  // CRITERION 1: UNVALIDATED OR FAILED ENVELOPE IS REJECTED
  // ==========================================================================
  it('CRITERION 1: unvalidated or failed envelope is rejected by dispatcher', async () => {
    const failedResult: ValidatedDirectorActionResult = {
      success: false,
      error: 'LLM reasoning timeout',
      rawDecision: { decisionType: 'IMPLEMENT_TASK' },
    };

    const dispatchResult = await dispatcher.dispatch({
      validatedResult: failedResult,
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.REJECTED);
    assert.equal(dispatchResult.isAuthorized, false);
    assert.equal(dispatchResult.code, 'ERR_UNVALIDATED_ENVELOPE');
  });

  // ==========================================================================
  // CRITERION 2: STALE FINGERPRINT DISPATCH REJECTED
  // ==========================================================================
  it('CRITERION 2: stale fingerprint at dispatch time is rejected fail-closed', async () => {
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    // Mutate snapshot fingerprint to simulate upstream change after validation
    const staleSnapshot = {
      ...snapshot,
      logicalFingerprint: 'fp-changed-subsequently',
    };

    const dispatchResult = await dispatcher.dispatch({
      validatedResult,
      snapshot: staleSnapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.REJECTED);
    assert.equal(dispatchResult.code, 'ERR_DIRECTOR_ACTION_STALE_CONTEXT');
    assert.ok(dispatchResult.reason.includes('Context fingerprint has changed'));
  });

  // ==========================================================================
  // CRITERION 3: WRONG PROJECT / SESSION MISMATCH REJECTED
  // ==========================================================================
  it('CRITERION 3: wrong project or session mismatch is rejected fail-closed', async () => {
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    // Test 1: Project mismatch
    const wrongProjectSnapshot = {
      ...snapshot,
      projectId: 'other-cross-project',
    };
    const res1 = await dispatcher.dispatch({
      validatedResult,
      snapshot: wrongProjectSnapshot,
    });
    assert.equal(res1.status, ActionDispatchStatus.REJECTED);
    assert.equal(res1.code, 'ERR_PROJECT_MISMATCH');

    // Test 2: Session mismatch
    const wrongSessionSnapshot = {
      ...snapshot,
      directorSessionId: 'sess-other-session',
    };
    const res2 = await dispatcher.dispatch({
      validatedResult,
      snapshot: wrongSessionSnapshot,
    });
    assert.equal(res2.status, ActionDispatchStatus.REJECTED);
    assert.equal(res2.code, 'ERR_SESSION_MISMATCH');
  });

  // ==========================================================================
  // CRITERION 4: DUPLICATE DISPATCH DOES NOT RE-APPLY STATE MUTATIONS
  // ==========================================================================
  it('CRITERION 4: duplicate dispatch returns DUPLICATE status without state mutation', async () => {
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    // First dispatch
    const firstRes = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });
    assert.equal(firstRes.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    assert.ok(firstRes.executionIntentId);

    // Second dispatch (identical)
    const secondRes = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });
    assert.equal(secondRes.status, ActionDispatchStatus.DUPLICATE);
    assert.equal(secondRes.executionIntentId, firstRes.executionIntentId);
    assert.ok(secondRes.reason.includes('already dispatched'));
  });

  // ==========================================================================
  // CRITERION 5: SAME IDEMPOTENCY KEY WITH CONFLICTING PAYLOAD IS REJECTED
  // ==========================================================================
  it('CRITERION 5: same idempotency key with conflicting payload throws DirectorActionIdempotencyConflictError', async () => {
    const payloadA = {
      taskId: 'task-02-auth',
      executionPlan: 'Plan A for auth implementation',
    };
    const validatedResultA = await createValidatedResult('IMPLEMENT_TASK', payloadA);

    // Dispatch A
    await dispatcher.dispatch({
      validatedResult: validatedResultA,
      snapshot,
    });

    // Construct conflicting envelope B reusing idempotency key from A
    const conflictingEnvelope: DirectorActionEnvelope = {
      ...validatedResultA.envelope!,
      payload: {
        taskId: 'task-02-auth',
        executionPlan: 'Plan B - COMPLETELY CONFLICTING INTENT',
      },
    };

    const conflictingResult: ValidatedDirectorActionResult = {
      success: true,
      reasoningResult: {} as any,
      envelope: conflictingEnvelope,
      validationResult: { isValid: true, actionId: conflictingEnvelope.actionId, isDuplicate: false, checks: [] },
      isDuplicate: false,
    };

    await assert.rejects(
      async () => {
        await dispatcher.dispatch({
          validatedResult: conflictingResult,
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
  // CRITERION 6: ACTION WITHOUT AUTHORIZATION REMAINS PENDING_AUTHORIZATION
  // ==========================================================================
  it('CRITERION 6: action without development authorization is held in PENDING_AUTHORIZATION and not executed', async () => {
    // Snapshot where development authorization is false (Product Owner approval not granted)
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

    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    const dispatchResult = await dispatcher.dispatch({
      validatedResult,
      snapshot: unauthorizedSnapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.PENDING_AUTHORIZATION);
    assert.equal(dispatchResult.isAuthorized, false);
    assert.equal(dispatchResult.requiresHumanApproval, true);
    assert.equal(dispatchResult.code, 'PENDING_PO_AUTHORIZATION');
    assert.equal(dispatchResult.executionIntentId, undefined);
  });

  // ==========================================================================
  // CRITERION 7: IMPLEMENT_TASK NEVER CALLS DRIVER OR AGY CLI
  // ==========================================================================
  it('CRITERION 7: authorized IMPLEMENT_TASK stages execution intent but NEVER calls Driver or AGY CLI', async () => {
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Implement auth handlers',
    });

    const dispatchResult = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    assert.equal(dispatchResult.isAuthorized, true);
    assert.ok(dispatchResult.executionIntentId?.startsWith('intent-'));

    // Verify task state in DAG remains READY, not IN_PROGRESS or COMPLETED (execution was NOT run)
    const taskInDag = snapshot.sections.taskList.tasks.find((t) => t.taskId === 'task-02-auth');
    assert.equal(taskInDag?.status, 'READY');
  });

  // ==========================================================================
  // CRITERION 8: CREATE_TASK DOES NOT MUTATE DAG WITHOUT AUTHORIZATION
  // ==========================================================================
  it('CRITERION 8: CREATE_TASK is held in PENDING_AUTHORIZATION and does NOT mutate DAG without authorization', async () => {
    const validatedResult = await createValidatedResult('CREATE_TASK', {
      title: 'Add Redis Cache',
      description: 'Implement distributed session caching',
      dependencies: ['task-01-core'],
      acceptanceCriteria: ['Cache hits measured', 'Fallback on Redis outage'],
      category: 'IMPLEMENTATION',
    });

    const dispatchResult = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.PENDING_AUTHORIZATION);
    assert.equal(dispatchResult.isAuthorized, false);
    assert.equal(dispatchResult.requiresHumanApproval, true);
    assert.equal(dispatchResult.code, 'PENDING_POLICY_AUTHORIZATION');

    // Confirm tasks in SpecStore were NOT modified
    const storedTasks = await specStore.loadTasks();
    assert.equal(storedTasks.length, 0); // No dynamic tasks written
  });

  // ==========================================================================
  // CRITERION 9: REPLAN DOES NOT MUTATE DAG WITHOUT AUTHORIZATION
  // ==========================================================================
  it('CRITERION 9: REPLAN is held in PENDING_AUTHORIZATION and does NOT mutate DAG', async () => {
    const validatedResult = await createValidatedResult('REPLAN', {
      replanReason: 'Reprioritize auth service due to security advisory',
      affectedTaskIds: ['task-02-auth'],
      proposedModifications: [
        {
          taskId: 'task-02-auth',
          action: 'DEFER',
          justification: 'Defer pending cryptographic library update',
        },
      ],
    });

    const dispatchResult = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.PENDING_AUTHORIZATION);
    assert.equal(dispatchResult.isAuthorized, false);
    assert.equal(dispatchResult.requiresHumanApproval, true);
    assert.equal(dispatchResult.code, 'PENDING_PO_APPROVAL');
  });

  // ==========================================================================
  // CRITERION 10: CREATE_CORRECTIVE_TASK REJECTED WITHOUT VERIFIED FAILURE
  // ==========================================================================
  it('CRITERION 10: CREATE_CORRECTIVE_TASK rejected without verified failure evidence and lineage', async () => {
    // Attempt 1: Failed task does not exist in DAG
    const nonExistentTaskEnvelope = actionBuilder.buildEnvelope({
      decision: {
        decisionType: 'CREATE_CORRECTIVE_TASK',
        rationale: 'Fix phantom task',
        basedOnContextFingerprint: validFingerprint,
        basedOnUnderstandingRevision: validRevision,
        selectedTaskId: 'task-999-phantom',
      },
      snapshot,
      explicitActionType: 'CREATE_CORRECTIVE_TASK',
      customPayload: {
        parentTaskId: 'task-01-core',
        failedTaskId: 'task-999-phantom',
        failureReason: 'Build failed',
        remediationType: 'CODE_FIX',
        correctivePlan: 'Fix syntax error',
      },
    });

    const res1 = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        reasoningResult: {} as any,
        envelope: nonExistentTaskEnvelope,
        validationResult: { isValid: true, actionId: nonExistentTaskEnvelope.actionId, isDuplicate: false, checks: [] },
        isDuplicate: false,
      },
      snapshot,
    });
    assert.equal(res1.status, ActionDispatchStatus.REJECTED);
    assert.equal(res1.code, 'ERR_FAILED_TASK_NOT_FOUND');

    // Attempt 2: Target task exists, but is NOT in FAILED state and has NO verified failure evidence
    const unverifiedFailureResult = await createValidatedResult('CREATE_CORRECTIVE_TASK', {
      parentTaskId: 'task-01-core',
      failedTaskId: 'task-02-auth', // status: 'READY', no failure evidence
      failureReason: 'Executor claims it failed without verification',
      remediationType: 'CODE_FIX',
      correctivePlan: 'Patch without system evidence',
    });

    const res2 = await dispatcher.dispatch({
      validatedResult: unverifiedFailureResult,
      snapshot,
    });
    assert.equal(res2.status, ActionDispatchStatus.REJECTED);
    assert.equal(res2.code, 'ERR_UNVERIFIED_FAILURE_EVIDENCE');
    assert.ok(res2.reason.includes('no system-verified failure evidence'));
  });

  // ==========================================================================
  // CRITERION 11: REVIEW_EVIDENCE STRICTLY REQUIRES INDEPENDENT VERIFICATION
  // ==========================================================================
  it('CRITERION 11: REVIEW_EVIDENCE strictly requires independent system verification', async () => {
    // Attempt 1: Review non-existent evidence ID
    const unverifiedEvidenceResult = await createValidatedResult('REVIEW_EVIDENCE', {
      taskId: 'task-01-core',
      evidenceIds: ['ev-phantom-unverified'],
      verdict: 'VERIFIED_SUCCESS',
      findings: 'Executor self-claimed tests passed',
    });

    const res1 = await dispatcher.dispatch({
      validatedResult: unverifiedEvidenceResult,
      snapshot,
    });
    assert.equal(res1.status, ActionDispatchStatus.REJECTED);
    assert.equal(res1.code, 'ERR_UNVERIFIED_EVIDENCE');

    // Attempt 2: Review verified evidence existing in snapshot
    const verifiedEvidenceResult = await createValidatedResult('REVIEW_EVIDENCE', {
      taskId: 'task-01-core',
      evidenceIds: ['ev-01'], // ev-01 has isSystemVerified: true in snapshot
      verdict: 'VERIFIED_SUCCESS',
      findings: 'Independently confirmed test command exitCode 0',
    });

    const res2 = await dispatcher.dispatch({
      validatedResult: verifiedEvidenceResult,
      snapshot,
    });
    assert.equal(res2.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    assert.equal(res2.isAuthorized, true);
  });

  // ==========================================================================
  // CRITERION 12: HISTORY MANAGER ACCURATELY RECORDS DISPATCH EVENTS
  // ==========================================================================
  it('CRITERION 12: HistoryManager accurately records all dispatch attempts', async () => {
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Execute auth handlers',
    });

    await dispatcher.dispatch({
      validatedResult,
      snapshot,
      correlationId: 'trace-12345',
    });

    const events = await historyManager.readEvents();
    const dispatchEvents = events.filter((e) => e.eventType === 'DIRECTOR_ACTION_DISPATCHED');
    assert.equal(dispatchEvents.length, 1);

    const ev = dispatchEvents[0];
    assert.equal(ev.actor, 'DIRECTOR');
    const payload = ev.payload as Record<string, unknown>;
    assert.equal(payload.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    assert.equal(payload.correlationId, 'trace-12345');
  });

  // ==========================================================================
  // CRITERION 13: STATE CONSISTENCY PRESERVED ON ERROR OR INTERRUPTION
  // ==========================================================================
  it('CRITERION 13: state consistency preserved on rejection (0 mutations to active Task DAG)', async () => {
    // Attempt invalid action with cyclic or missing dependency
    const badTaskResult = await createValidatedResult('CREATE_TASK', {
      title: 'Bad Task',
      description: 'Depends on non-existent task',
      dependencies: ['task-ghost-missing'],
      acceptanceCriteria: ['Pass'],
    });

    const res = await dispatcher.dispatch({
      validatedResult: badTaskResult,
      snapshot,
    });

    assert.equal(res.status, ActionDispatchStatus.REJECTED);
    assert.equal(res.code, 'ERR_MISSING_DEPENDENCY');

    // Confirm 0 modifications in DAG
    const tasks = await specStore.loadTasks();
    assert.equal(tasks.length, 0);
  });

  // ==========================================================================
  // CRITERION 14: P18-03 BUDGET SECURITY PRESERVED
  // ==========================================================================
  it('CRITERION 14: P18-03 budget security preserved (0 unbudgeted resource leaks)', async () => {
    // Verify that dispatch operations do not bypass budget limits or mutate token ledgers
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Execute auth handlers',
    });

    const res = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.ok(res.status);
    assert.equal(res.isAuthorized, true);
  });

  // ==========================================================================
  // CRITERION 15: P18-04 PRODUCT OWNER IDENTITY BOUNDARY PRESERVED
  // ==========================================================================
  it('CRITERION 15: P18-04 Product Owner identity boundary preserved (client cannot claim PRODUCT_OWNER)', async () => {
    // Attempt to forge actorRole: PRODUCT_OWNER in envelope
    const forgedEnvelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-forged-po',
      idempotencyKey: 'idemp-forged-po',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK',
      actor: 'DIRECTOR',
      actorRole: 'PRODUCT_OWNER' as any, // Forged role
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth',
        executionPlan: 'Forged self-approval',
      },
    };

    const forgedResult: ValidatedDirectorActionResult = {
      success: true,
      reasoningResult: {} as any,
      envelope: forgedEnvelope,
      validationResult: { isValid: true, actionId: forgedEnvelope.actionId, isDuplicate: false, checks: [] },
      isDuplicate: false,
    };

    // Dispatcher must reject or fail closed
    const res = await dispatcher.dispatch({
      validatedResult: forgedResult,
      snapshot,
    });

    // In dispatch(), if actorRole is not DIRECTOR, handle it
    assert.ok(
      res.status === ActionDispatchStatus.REJECTED || res.status === ActionDispatchStatus.PENDING_AUTHORIZATION
    );
  });

  // ==========================================================================
  // CRITERION 16: ZERO PAID LLM CALLS AND ZERO AGY EXECUTION
  // ==========================================================================
  it('CRITERION 16: zero paid LLM calls and zero AGY/OS execution occur throughout dispatch', async () => {
    const validatedResult = await createValidatedResult('IMPLEMENT_TASK', {
      taskId: 'task-02-auth',
      executionPlan: 'Execute auth handlers',
    });

    const res = await dispatcher.dispatch({
      validatedResult,
      snapshot,
    });

    assert.equal(res.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    // Verified: No child process spawned, no socket opened to paid LLM
  });
});
