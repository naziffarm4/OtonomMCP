/**
 * Phase 10 TASK-P10-05: Verified Execution State Integration Test Suite
 *
 * Verifies the authoritative state-integration boundary:
 * 1. ACCEPT updates completedTaskIds.
 * 2. ACCEPT clears matching activeTaskId.
 * 3. ACCEPT is idempotent.
 * 4. REJECT does not complete the task.
 * 5. BLOCK persists blockedState.
 * 6. BLOCK does not complete the task.
 * 7. Invalid evidence is rejected.
 * 8. Project binding mismatch is rejected.
 * 9. Task binding mismatch is rejected.
 * 10. Task revision mismatch is rejected.
 * 11. Context fingerprint mismatch is rejected.
 * 12. Understanding revision mismatch is rejected.
 * 13. Approval package revision mismatch is rejected.
 * 14. Same evidence replay does not mutate state twice.
 * 15. Conflicting evidence does not silently overwrite state.
 * 16. Existing unrelated DurableState fields are preserved.
 * 17. Existing completed tasks are preserved.
 * 18. History event contains the required audit identity.
 * 19. Recovery after state persistence interruption is idempotent.
 * 20. Recovery never invokes executor or verification.
 * 21. Concurrent integration cannot corrupt DurableState.
 * 22. Lock ownership cannot be stolen/released incorrectly.
 * 23. Stale lock recovery works.
 * 24. Crash-window lock metadata handling works.
 * 25. No second FSM/store/DAG is introduced.
 * 26. MCP boundary rejects fabricated verification claims.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  ExecutionStateIntegrator,
  ExecutionIntegrationService,
  ExecutionIntegrationLock,
  createExecutionIntegrateTool,
  AIDM_EXECUTION_INTEGRATE_TOOL_NAME,
  DurableStateManager,
  type DurableState,
  SpecStore,
  HistoryManager,
  TaskDagEngine,
  TaskStatus,
  LifecycleState,
  type SystemExecutionEvidence,
  ExecutionIntegrationError,
  ExecutionIntegrationValidationError,
  ExecutionIntegrationBindingMismatchError,
  ExecutionIntegrationConflictError,
  ExecutionIntegrationSecurityViolationError,
  ExecutionIntegrationStaleResultError,
} from '../dist/index.js';

describe('Phase 10 TASK-P10-05: Verified Execution State Integration', () => {
  let tempDir: string;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let historyManager: HistoryManager;
  let lock: ExecutionIntegrationLock;
  let integrator: ExecutionStateIntegrator;

  function createMockEvidence(overrides?: Partial<SystemExecutionEvidence>): SystemExecutionEvidence {
    const randomHex = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const requestId = overrides?.requestId ?? `req-${randomHex}`;
    const evidenceId = overrides?.evidenceId ?? `ev-${randomHex}`;

    return {
      evidenceId,
      requestId,
      projectId: overrides?.projectId ?? 'proj-aidm-test',
      taskId: overrides?.taskId ?? 'TASK-001',
      taskRevision: overrides?.taskRevision ?? 1,
      contextFingerprint: overrides?.contextFingerprint ?? 'fp-sha256-abcdef0123456789',
      understandingRevision: overrides?.understandingRevision ?? 1,
      approvalPackageRevision: overrides?.approvalPackageRevision ?? 1,
      repositoryState: {
        baseCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        headCommit: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        isClean: true,
      },
      changedFiles: [{ path: 'src/index.ts', status: 'M' }],
      verificationChecks: [
        {
          checkId: 'CHECK_TESTS',
          type: 'TEST',
          status: 'PASS',
          command: 'pnpm test',
          evidence: '1249 tests passing',
        },
      ],
      acceptanceCriteria: [
        {
          criterion: 'AC-1: Verification completes',
          status: 'PASS',
          evidence: 'All checks passed',
        },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 150,
      },
      verificationDecision: overrides?.verificationDecision ?? 'ACCEPT',
      verifiedAt: overrides?.verifiedAt ?? new Date().toISOString(),
      metadata: overrides?.metadata,
    };
  }

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p10-05-test-'));
    durableManager = new DurableStateManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    historyManager = new HistoryManager({ baseDir: tempDir });
    lock = new ExecutionIntegrationLock({ baseDir: tempDir, staleThresholdMs: 200, timeoutMs: 1500 });

    integrator = new ExecutionStateIntegrator({
      baseDir: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      lock,
      expectedProjectId: 'proj-aidm-test',
    });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Safe cleanup
    }
  });

  // ==========================================================================
  // 1. ACCEPT updates completedTaskIds
  // ==========================================================================
  it('1. ACCEPT updates completedTaskIds', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-001',
      completedTaskIds: ['TASK-000'],
      blockedState: null,
    });

    const evidence = createMockEvidence({
      taskId: 'TASK-001',
      verificationDecision: 'ACCEPT',
    });

    const outcome = await integrator.integrate(evidence);

    assert.equal(outcome.success, true);
    assert.equal(outcome.verificationDecision, 'ACCEPT');
    assert.equal(outcome.taskStatus, TaskStatus.ACCEPTED);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.ok(reloaded.completedTaskIds.includes('TASK-001'));
    assert.ok(reloaded.completedTaskIds.includes('TASK-000'));
  });

  // ==========================================================================
  // 2. ACCEPT clears matching activeTaskId
  // ==========================================================================
  it('2. ACCEPT clears matching activeTaskId', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-001',
      completedTaskIds: [],
      blockedState: null,
    });

    const evidence = createMockEvidence({
      taskId: 'TASK-001',
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(evidence);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.equal(reloaded.activeTaskId, null);
  });

  // ==========================================================================
  // 3. ACCEPT is idempotent
  // ==========================================================================
  it('3. ACCEPT is idempotent', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-001',
      verificationDecision: 'ACCEPT',
    });

    const first = await integrator.integrate(evidence);
    assert.equal(first.success, true);
    assert.equal(first.isDuplicate, false);

    const second = await integrator.integrate(evidence);
    assert.equal(second.success, true);
    assert.equal(second.isDuplicate, true);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    const count = reloaded.completedTaskIds.filter((t) => t === 'TASK-001').length;
    assert.equal(count, 1);
  });

  // ==========================================================================
  // 4. REJECT does not complete the task
  // ==========================================================================
  it('4. REJECT does not complete the task', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-002',
      completedTaskIds: ['TASK-000'],
      blockedState: null,
    });

    const evidence = createMockEvidence({
      taskId: 'TASK-002',
      verificationDecision: 'REJECT',
    });

    const outcome = await integrator.integrate(evidence);
    assert.equal(outcome.success, true);
    assert.equal(outcome.verificationDecision, 'REJECT');
    assert.equal(outcome.taskStatus, TaskStatus.REJECTED);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.equal(reloaded.completedTaskIds.includes('TASK-002'), false);
    assert.equal(reloaded.activeTaskId, null);
  });

  // ==========================================================================
  // 5. BLOCK persists blockedState
  // ==========================================================================
  it('5. BLOCK persists blockedState', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-003',
      taskRevision: 2,
      verificationDecision: 'BLOCK',
      metadata: { blockingReason: 'Human clarification required for contradictory specs' },
    });

    const outcome = await integrator.integrate(evidence);
    assert.equal(outcome.success, true);
    assert.equal(outcome.verificationDecision, 'BLOCK');
    assert.equal(outcome.taskStatus, TaskStatus.BLOCKED);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.ok(reloaded.blockedState);
    assert.equal(reloaded.blockedState.blockedTaskId, 'TASK-003');
    assert.equal(reloaded.blockedState.blockedIteration, 2);
    assert.ok(reloaded.blockedState.blockingReason.includes('Human clarification'));
  });

  // ==========================================================================
  // 6. BLOCK does not complete the task
  // ==========================================================================
  it('6. BLOCK does not complete the task', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-004',
      verificationDecision: 'BLOCK',
    });

    await integrator.integrate(evidence);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.equal(reloaded.completedTaskIds.includes('TASK-004'), false);
  });

  // ==========================================================================
  // 7. Invalid evidence is rejected
  // ==========================================================================
  it('7. Invalid evidence is rejected', async () => {
    await assert.rejects(
      () => integrator.integrate(null),
      ExecutionIntegrationValidationError
    );

    await assert.rejects(
      () => integrator.integrate({ invalidField: true }),
      ExecutionIntegrationValidationError
    );

    await assert.rejects(
      () => integrator.integrate('not an object'),
      ExecutionIntegrationValidationError
    );
  });

  // ==========================================================================
  // 8. Project binding mismatch is rejected
  // ==========================================================================
  it('8. Project binding mismatch is rejected', async () => {
    const evidence = createMockEvidence({
      projectId: 'other-project',
    });

    await assert.rejects(
      () => integrator.integrate(evidence, { expectedBinding: { projectId: 'expected-project' } }),
      ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 9. Task binding mismatch is rejected
  // ==========================================================================
  it('9. Task binding mismatch is rejected', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-A',
    });

    await assert.rejects(
      () => integrator.integrate(evidence, { expectedBinding: { taskId: 'TASK-B' } }),
      ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 10. Task revision mismatch is rejected
  // ==========================================================================
  it('10. Task revision mismatch is rejected', async () => {
    const evidence = createMockEvidence({
      taskRevision: 2,
    });

    await assert.rejects(
      () => integrator.integrate(evidence, { expectedBinding: { taskRevision: 1 } }),
      ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 11. Context fingerprint mismatch is rejected
  // ==========================================================================
  it('11. Context fingerprint mismatch is rejected', async () => {
    const evidence = createMockEvidence({
      contextFingerprint: 'fp-old',
    });

    await assert.rejects(
      () => integrator.integrate(evidence, { expectedBinding: { contextFingerprint: 'fp-new' } }),
      ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 12. Understanding revision mismatch is rejected
  // ==========================================================================
  it('12. Understanding revision mismatch is rejected', async () => {
    const evidence = createMockEvidence({
      understandingRevision: 2,
    });

    await assert.rejects(
      () => integrator.integrate(evidence, { expectedBinding: { understandingRevision: 1 } }),
      ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 13. Approval package revision mismatch is rejected
  // ==========================================================================
  it('13. Approval package revision mismatch is rejected', async () => {
    const evidence = createMockEvidence({
      approvalPackageRevision: 2,
    });

    await assert.rejects(
      () => integrator.integrate(evidence, { expectedBinding: { approvalPackageRevision: 1 } }),
      ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 14. Same evidence replay does not mutate state twice
  // ==========================================================================
  it('14. Same evidence replay does not mutate state twice', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-014',
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(evidence);

    const eventsAfterFirst = await historyManager.readEvents();
    assert.equal(eventsAfterFirst.length, 1);

    const secondOutcome = await integrator.integrate(evidence);
    assert.equal(secondOutcome.isDuplicate, true);

    const eventsAfterSecond = await historyManager.readEvents();
    assert.equal(eventsAfterSecond.length, 1);
  });

  // ==========================================================================
  // 15. Conflicting evidence does not silently overwrite state
  // ==========================================================================
  it('15. Conflicting evidence does not silently overwrite state', async () => {
    const ev1 = createMockEvidence({
      evidenceId: 'ev-first-11111111111111111111',
      requestId: 'req-same-11111111111111111111',
      taskId: 'TASK-CONFLICT',
      taskRevision: 1,
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(ev1);

    const ev2 = createMockEvidence({
      evidenceId: 'ev-conflicting-22222222222222',
      requestId: 'req-same-11111111111111111111',
      taskId: 'TASK-CONFLICT',
      taskRevision: 1,
      verificationDecision: 'REJECT',
    });

    await assert.rejects(
      () => integrator.integrate(ev2),
      ExecutionIntegrationConflictError
    );

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.ok(reloaded.completedTaskIds.includes('TASK-CONFLICT'));
  });

  // ==========================================================================
  // 15b. Same taskId + same taskRevision + different requestId does NOT conflict
  // ==========================================================================
  it('15b. Same taskId + same taskRevision + different requestId does NOT conflict', async () => {
    // ev1 is a REJECT on request 1 (task remains not completed)
    const ev1 = createMockEvidence({
      evidenceId: 'ev-req1-11111111111111111111',
      requestId: 'req-first-1111111111111111111',
      taskId: 'TASK-MULTI-REQ',
      taskRevision: 1,
      verificationDecision: 'REJECT',
    });

    const res1 = await integrator.integrate(ev1);
    assert.equal(res1.success, true);
    assert.equal(res1.taskStatus, TaskStatus.REJECTED);

    // ev2 is a subsequent execution under a different requestId for the same task and revision
    const ev2 = createMockEvidence({
      evidenceId: 'ev-req2-22222222222222222222',
      requestId: 'req-second-222222222222222222',
      taskId: 'TASK-MULTI-REQ',
      taskRevision: 1,
      verificationDecision: 'ACCEPT',
    });

    const res2 = await integrator.integrate(ev2);
    assert.equal(res2.success, true);
    assert.equal(res2.taskStatus, TaskStatus.ACCEPTED);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.ok(reloaded.completedTaskIds.includes('TASK-MULTI-REQ'));
  });

  // ==========================================================================
  // 16. Existing unrelated DurableState fields are preserved
  // ==========================================================================
  it('16. Existing unrelated DurableState fields are preserved', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-016',
      completedTaskIds: ['TASK-OLD'],
      blockedState: null,
      lastCheckpoint: 'ckpt-git-12345',
      metadata: {
        unrelatedFlag: true,
        projectCustomSetting: 'preserved',
      },
    });

    const evidence = createMockEvidence({
      taskId: 'TASK-016',
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(evidence);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.equal(reloaded.lastCheckpoint, 'ckpt-git-12345');
    assert.equal(reloaded.currentLifecycleState, LifecycleState.TASK_LOOP);
    assert.equal(reloaded.metadata?.unrelatedFlag, true);
    assert.equal(reloaded.metadata?.projectCustomSetting, 'preserved');
  });

  // ==========================================================================
  // 17. Existing completed tasks are preserved
  // ==========================================================================
  it('17. Existing completed tasks are preserved', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      completedTaskIds: ['TASK-A', 'TASK-B'],
      blockedState: null,
    });

    const evidence = createMockEvidence({
      taskId: 'TASK-C',
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(evidence);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.deepEqual(reloaded.completedTaskIds, ['TASK-A', 'TASK-B', 'TASK-C']);
  });

  // ==========================================================================
  // 18. History event contains the required audit identity
  // ==========================================================================
  it('18. History event contains the required audit identity', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-018',
      taskRevision: 3,
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(evidence);

    const events = await historyManager.readEvents();
    assert.equal(events.length, 1);
    const event = events[0];

    assert.equal(event.eventType, 'EXECUTION_STATE_INTEGRATED');
    assert.equal(event.taskId, 'TASK-018');

    const payload = event.payload;
    assert.equal(payload.evidenceId, evidence.evidenceId);
    assert.equal(payload.requestId, evidence.requestId);
    assert.equal(payload.projectId, evidence.projectId);
    assert.equal(payload.taskId, 'TASK-018');
    assert.equal(payload.taskRevision, 3);
    assert.equal(payload.verificationDecision, 'ACCEPT');
    assert.equal(payload.integrationResult, TaskStatus.ACCEPTED);
    assert.ok(payload.timestamp);
  });

  // ==========================================================================
  // 19. Recovery after state persistence interruption is idempotent
  // ==========================================================================
  it('19. Recovery after state persistence interruption is idempotent', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-019',
      verificationDecision: 'ACCEPT',
    });

    // Simulate partial persistence: history event was written, but process crashed before state save
    await historyManager.appendEvent({
      eventType: 'EXECUTION_STATE_INTEGRATED',
      actor: 'ORCHESTRATOR' as any,
      taskId: 'TASK-019',
      payload: {
        evidenceId: evidence.evidenceId,
        requestId: evidence.requestId,
      },
    });

    // Recovery runs integrate again on the already verified evidence
    const outcome = await integrator.integrate(evidence);
    assert.equal(outcome.success, true);

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    assert.ok(reloaded.completedTaskIds.includes('TASK-019'));

    // Repeating after recovery is completely idempotent
    const replay = await integrator.integrate(evidence);
    assert.equal(replay.isDuplicate, true);
  });

  // ==========================================================================
  // 20. Recovery never invokes executor or verification
  // ==========================================================================
  it('20. Recovery never invokes executor or verification', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-020',
      verificationDecision: 'ACCEPT',
    });

    // The integrator object does NOT hold or reference any executor or verification port
    assert.equal((integrator as any).executorPort, undefined);
    assert.equal((integrator as any).antigravity, undefined);
    assert.equal((integrator as any).collector, undefined);

    const outcome = await integrator.integrate(evidence);
    assert.equal(outcome.success, true);
  });

  // ==========================================================================
  // 21. Concurrent integration cannot corrupt DurableState
  // ==========================================================================
  it('21. Concurrent integration cannot corrupt DurableState', async () => {
    const tasks = ['TASK-C1', 'TASK-C2', 'TASK-C3', 'TASK-C4', 'TASK-C5'];
    const evidenceList = tasks.map((taskId) =>
      createMockEvidence({
        taskId,
        verificationDecision: 'ACCEPT',
      })
    );

    // Run all integrations concurrently
    const outcomes = await Promise.all(
      evidenceList.map((ev) => integrator.integrate(ev))
    );

    for (const outcome of outcomes) {
      assert.equal(outcome.success, true);
    }

    const reloaded = await durableManager.load();
    assert.ok(reloaded);
    for (const taskId of tasks) {
      assert.ok(reloaded.completedTaskIds.includes(taskId));
    }
  });

  // ==========================================================================
  // 22. Lock ownership cannot be stolen/released incorrectly
  // ==========================================================================
  it('22. Lock ownership cannot be stolen/released incorrectly', async () => {
    const handleA = await lock.acquire();

    // Fabricate a fake handle with different token
    const fakeHandle = {
      ownerToken: 'fake-owner-token-12345',
      lockFilePath: lock.lockFilePath,
      acquiredAt: Date.now(),
    };

    // Attempting release with fake handle MUST NOT delete handleA's lock file
    await lock.release(fakeHandle);

    const lockExists = fs.existsSync(lock.lockFilePath);
    assert.equal(lockExists, true);

    // Proper release with handleA removes the file
    await lock.release(handleA);
    assert.equal(fs.existsSync(lock.lockFilePath), false);
  });

  // ==========================================================================
  // 23. Stale lock recovery works
  // ==========================================================================
  it('23. Stale lock recovery works', async () => {
    // Write a simulated stale lock from a dead process with old acquiredAt
    const oldTimestamp = Date.now() - 5000;
    const staleMetadata = {
      ownerToken: 'stale-token-dead-pid',
      pid: 999999, // Unlikely to exist
      createdAt: new Date(oldTimestamp).toISOString(),
      acquiredAt: oldTimestamp,
    };

    await fs.promises.mkdir(path.dirname(lock.lockFilePath), { recursive: true });
    await fs.promises.writeFile(lock.lockFilePath, JSON.stringify(staleMetadata));

    // Fast lock instance with short staleThreshold
    const fastLock = new ExecutionIntegrationLock({
      lockFilePath: lock.lockFilePath,
      staleThresholdMs: 100,
      timeoutMs: 1000,
    });

    const newHandle = await fastLock.acquire();
    assert.ok(newHandle);
    assert.notEqual(newHandle.ownerToken, 'stale-token-dead-pid');

    await fastLock.release(newHandle);
  });

  // ==========================================================================
  // 24. Crash-window lock metadata handling works
  // ==========================================================================
  it('24. Crash-window lock metadata handling works', async () => {
    // Create an empty (0 bytes) lock file with backdated mtime
    await fs.promises.mkdir(path.dirname(lock.lockFilePath), { recursive: true });
    await fs.promises.writeFile(lock.lockFilePath, '');
    const oldTime = (Date.now() - 5000) / 1000;
    await fs.promises.utimes(lock.lockFilePath, oldTime, oldTime);

    const fastLock = new ExecutionIntegrationLock({
      lockFilePath: lock.lockFilePath,
      staleThresholdMs: 100,
      timeoutMs: 1000,
    });

    const handle = await fastLock.acquire();
    assert.ok(handle);

    await fastLock.release(handle);
  });

  // ==========================================================================
  // 25. No second FSM/store/DAG is introduced
  // ==========================================================================
  it('25. No second FSM/store/DAG is introduced', async () => {
    const evidence = createMockEvidence({
      taskId: 'TASK-025',
      verificationDecision: 'ACCEPT',
    });

    await integrator.integrate(evidence);

    // Verify that NO execution-integrations.json or other state files were created
    const stateDir = path.join(tempDir, '.ai-manager', 'state');
    const files = await fs.promises.readdir(stateDir);

    // Only durable-state.json (and temporary lock files if any) are permitted
    assert.ok(files.includes('durable-state.json'));
    assert.equal(files.includes('execution-integrations.json'), false);
    assert.equal(files.includes('.antigravity'), false);
  });

  // ==========================================================================
  // 26. MCP boundary rejects fabricated verification claims
  // ==========================================================================
  it('26. MCP boundary rejects fabricated verification claims', async () => {
    const { handler } = createExecutionIntegrateTool({
      integrationService: integrator,
    });

    const validEvidence = createMockEvidence({
      taskId: 'TASK-026',
      verificationDecision: 'ACCEPT',
    });

    // 1. Caller tries to pass fabricated verified: true claim
    const forbiddenClaims = [
      { evidence: validEvidence, verified: true },
      { evidence: validEvidence, qaPassed: true },
      { evidence: validEvidence, systemAccepted: true },
      { evidence: validEvidence, taskCompleted: true },
      { evidence: validEvidence, systemApproved: true },
    ];

    for (const input of forbiddenClaims) {
      const response = await handler(input, {} as any);
      assert.equal(response.isError, true);
      const parsed = JSON.parse(response.content[0].text);
      assert.equal(parsed.code, 'ERR_EXECUTION_INTEGRATION_SECURITY_VIOLATION');
    }

    // 2. Legitimate evidence without fake flags succeeds via MCP tool
    const validResponse = await handler({ evidence: validEvidence }, {} as any);
    assert.equal(validResponse.isError, false);
    const parsedValid = JSON.parse(validResponse.content[0].text);
    assert.equal(parsedValid.success, true);
    assert.equal(parsedValid.taskId, 'TASK-026');
  });
});
