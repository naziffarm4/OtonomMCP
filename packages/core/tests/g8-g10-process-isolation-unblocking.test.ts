/**
 * @file g8-g10-process-isolation-unblocking.test.ts
 * @description Comprehensive regression test suite for Revision 6 G-8 / G-10 Process Isolation:
 *
 * 1. Process isolation uncertainty transitions coordinator to BLOCKED status.
 * 2. Block reason (PROCESS_ISOLATION_UNCERTAINTY) and blockId are durably persisted.
 * 3. Blockade is preserved across coordinator/system restarts.
 * 4. New dispatch is rejected while blocked (DISPATCH_BLOCKED).
 * 5. Fabricated or missing PO approval cannot unblock.
 * 6. Valid PO approval with failed process verification cannot unblock.
 * 7. Verified dead processes without PO approval cannot unblock.
 * 8. Block cannot be lifted without BOTH conditions verified.
 * 9. Two valid conditions unblock only the targeted active block.
 * 10. Stale / replay / wrong cycle approval is strictly rejected.
 * 11. Process query uncertainty or error fails closed (block remains active).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  ClosedLoopCoordinator,
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
  LifecycleState,
} from '../dist/index.js';

describe('Revision 6: G-8 / G-10 Process Isolation Hardening', () => {
  let tempDir: string;
  let durableManager: DurableStateManager;
  let approvalStore: ApprovalStore;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let specStore: SpecStore;
  let coordinator: ClosedLoopCoordinator;

  const projectId = 'test-g8-g10-project';
  const sessionId = 'dir-sess-g8-g10-001';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-g8-g10-test-'));

    // Create required base directories
    fs.mkdirSync(path.join(tempDir, '.ai-manager', 'state'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.ai-manager', 'approval', 'packages'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.ai-manager', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.ai-manager', 'decisions'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.ai-manager', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });

    // Initialize package.json to identify workspace
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: projectId, version: '1.0.0' }, null, 2),
      'utf8'
    );

    historyManager = new HistoryManager({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    specStore = new SpecStore({ baseDir: tempDir });

    // Initialize clean durable state
    await durableManager.save({
      schemaVersion: 1,
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-G8-01',
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
      updatedAt: new Date().toISOString(),
    });

    // Create active director session
    await sessionEngine.createSession({
      directorSessionId: sessionId,
      workspaceRoot: tempDir,
      understandingRevision: 1,
    });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on windows locks
      }
    }
  });

  // Helper to construct coordinator with mock process verifier
  function createTestCoordinator(processVerifier?: (pids?: number[]) => Promise<{ verifiedDead: boolean; error?: string; output?: string }>) {
    return new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      durableStateManager: durableManager,
      approvalStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      specStore,
      historyManager,
      processVerifier,
    });
  }

  // Helper to establish a persistent G-8 isolation block
  async function establishIsolationBlock(blockId = 'block-test-001', pid = 99999, timestamp = new Date().toISOString()) {
    const cur = await durableManager.load();
    await durableManager.save({
      ...cur!,
      currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
      activeTaskId: 'TASK-G8-01',
      blockedState: {
        blockedTaskId: 'TASK-G8-01',
        blockedIteration: 1,
        blockedContextReference: 'fp-test-g8',
        blockingReason: 'PROCESS_ISOLATION_UNCERTAINTY',
        resumePoint: 'TASK_LOOP',
        timestamp,
        metadata: {
          blockId,
          reason: 'PROCESS_ISOLATION_UNCERTAINTY',
          cycleId: 'cycle-g8-001',
          projectId,
          processPid: pid,
          state: 'BLOCKED',
        },
      },
    });
  }

  // Helper to create an approved PO package in ApprovalStore
  async function createPoApprovalPackage(packageId: string, approvedAt = new Date().toISOString(), actorRole = 'PRODUCT_OWNER', status = 'APPROVED') {
    const pkg: any = {
      packageId,
      revision: 1,
      projectId,
      status,
      proposedPlan: {
        objectives: ['Unblock isolation'],
        proposedScope: ['packages'],
        proposedFeatureGroups: [],
        dependencies: [],
        constraints: [],
        knownRisks: [],
        unresolvedIssues: [],
        excludedScope: [],
        suggestedImplementationOrder: [],
      },
      sourceBindings: {
        projectId,
        discoveryRevision: 1,
        discoveryFingerprint: 'disc-fp-1',
        requirementsRevision: 1,
        requirementsFingerprint: 'req-fp-1',
        architectureRevision: 1,
        architectureFingerprint: 'arch-fp-1',
        businessRulesRevision: 1,
        businessRulesFingerprint: 'br-fp-1',
        acceptanceCriteriaRevision: 1,
        acceptanceCriteriaFingerprint: 'ac-fp-1',
        riskRevision: 1,
        riskFingerprint: 'risk-fp-1',
        specRevision: 1,
        specFingerprint: 'spec-fp-1',
        completenessFingerprint: 'comp-fp-1',
      },
      packageFingerprint: 'fp-pkg-1',
      understandingRevision: 1,
      createdAt: approvedAt,
      updatedAt: approvedAt,
      approvalRecord: {
        packageId,
        revision: 1,
        actor: 'alice-po',
        actorRole,
        intent: 'EXPLICIT_APPROVAL',
        comment: 'Authoritative PO approval to lift isolation block',
        approvedAt,
        packageHash: 'pkg-hash-1',
      },
    };
    await approvalStore.savePackage(pkg);
    return pkg;
  }

  // ==========================================================================
  // TESTS
  // ==========================================================================

  it('1. Süreç izolasyonu belirsizliği koordinatörü BLOCKED durumuna geçirir', async () => {
    await establishIsolationBlock('block-01');
    coordinator = createTestCoordinator();

    const isBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isBlocked, true, 'Coordinator must detect active isolation block');

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: sessionId,
      instruction: 'Run next cycle while blocked',
    });

    assert.strictEqual(result.status, 'BLOCKED', 'Outcome status must be BLOCKED');
    assert.strictEqual(result.isSuccess, false, 'Blocked outcome must not be success');
    assert.match(result.summary, /DISPATCH_BLOCKED/);
    assert.strictEqual(result.humanDecisionRequired, true);
  });

  it('2. Blokaj nedeni (PROCESS_ISOLATION_UNCERTAINTY) ve kimliği kalıcı olarak saklanır', async () => {
    const blockId = `block-${Date.now()}`;
    await establishIsolationBlock(blockId, 88888);

    const loaded = await durableManager.load();
    assert.ok(loaded?.blockedState);
    assert.strictEqual(loaded.blockedState.blockingReason, 'PROCESS_ISOLATION_UNCERTAINTY');
    assert.strictEqual(loaded.currentLifecycleState, LifecycleState.BLOCKED_ON_HUMAN);
    assert.strictEqual((loaded.blockedState.metadata as any)?.blockId, blockId);
    assert.strictEqual((loaded.blockedState.metadata as any)?.processPid, 88888);
  });

  it('3. Yeniden başlatma sonrasında blokaj korunur', async () => {
    await establishIsolationBlock('block-reboot-01');

    // Simulate system restart: instantiate fresh stores and fresh coordinator
    const freshDurable = new DurableStateManager({ baseDir: tempDir });
    const freshCoordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      durableStateManager: freshDurable,
      approvalStore,
      sessionStore,
      sessionEngine,
      specStore,
    });

    const isBlocked = await freshCoordinator.isIsolationBlocked();
    assert.strictEqual(isBlocked, true, 'Blockade must survive coordinator restart');

    const cycleRes = await freshCoordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: sessionId,
    });
    assert.strictEqual(cycleRes.status, 'BLOCKED');
  });

  it('4. Blokaj sırasında yeni dispatch engellenir (DISPATCH_BLOCKED)', async () => {
    await establishIsolationBlock('block-dispatch-test');
    coordinator = createTestCoordinator();

    const autoLoopRes = await coordinator.coordinateAutoLoop({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId: sessionId,
      maxCycles: 5,
    });

    assert.strictEqual(autoLoopRes.terminalStatus, 'DISPATCH_BLOCKED');
    assert.strictEqual(autoLoopRes.isSuccess, false);
    assert.strictEqual(autoLoopRes.cyclesRun, 0);
    assert.match(autoLoopRes.summary, /DISPATCH_BLOCKED/);
  });

  it('5. Sahte veya bulunmayan PO onayı blokajı kaldıramaz', async () => {
    await establishIsolationBlock('block-unblock-fake');
    coordinator = createTestCoordinator(async () => ({ verifiedDead: true }));

    // Unblock attempt with non-existent PO approval
    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-unblock-fake',
      poApprovalId: 'pkg-non-existent-approval',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');
    assert.match(res.reason ?? '', /Condition A FAIL/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true, 'System must remain BLOCKED when approval is missing');
  });

  it('6. Gerçek onay var ancak süreç doğrulaması başarısızsa blokaj kalkmaz', async () => {
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-unblock-cond-b', 55555, blockTime);

    // Create valid PO approval package (approved shortly after block)
    const approveTime = new Date(Date.now() + 5000).toISOString();
    await createPoApprovalPackage('pkg-valid-po-01', approveTime);

    // Mock verifier reporting process STILL ALIVE
    coordinator = createTestCoordinator(async (pids) => {
      assert.deepStrictEqual(pids, [55555]);
      return { verifiedDead: false, output: 'Process PID 55555 is still active in Windows process table.' };
    });

    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-unblock-cond-b',
      poApprovalId: 'pkg-valid-po-01',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');
    assert.match(res.reason ?? '', /Condition B FAIL/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true, 'System must remain BLOCKED if processes are not confirmed dead');
  });

  it('7. Süreç doğrulaması başarılı ancak PO onayı yoksa blokaj kalkmaz', async () => {
    await establishIsolationBlock('block-no-po');
    coordinator = createTestCoordinator(async () => ({ verifiedDead: true }));

    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-no-po',
      poApprovalId: '', // invalid / missing
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true);
  });

  it('8. İki koşul da doğrulanmadan blokaj kaldırılamaz (İstemci approved:true bayrağı reddedilir)', async () => {
    await establishIsolationBlock('block-client-bypass');
    coordinator = createTestCoordinator(async () => ({ verifiedDead: true }));

    // Try passing arbitrary client payload without registered PO approval
    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-client-bypass',
      poApprovalId: 'arbitrary-unregistered-id',
      poActor: 'client-user',
    } as any);

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');
    assert.match(res.reason ?? '', /Condition A FAIL/);
  });

  it('9. Başarılı iki koşul yalnızca ilgili blokajı kaldırır', async () => {
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-lift-success', 44444, blockTime);

    const approveTime = new Date(Date.now() + 2000).toISOString();
    await createPoApprovalPackage('pkg-lift-success-po', approveTime);

    coordinator = createTestCoordinator(async (pids) => {
      assert.deepStrictEqual(pids, [44444]);
      return { verifiedDead: true, output: 'Process confirmed dead' };
    });

    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-lift-success',
      poApprovalId: 'pkg-lift-success-po',
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'UNBLOCKED');
    assert.strictEqual(res.blockId, 'block-lift-success');
    assert.ok(res.unblockedAt);
    assert.strictEqual(res.unblockDetails?.verifiedByActor, 'alice-po');

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, false, 'System must now be UNBLOCKED');

    const durable = await durableManager.load();
    assert.strictEqual(durable?.blockedState, null);
    assert.strictEqual(durable?.currentLifecycleState, LifecycleState.TASK_LOOP);
  });

  it('10. Eski, başka cycle a ait veya tekrar kullanılan kanıt reddedilir (Replay Protection)', async () => {
    // Block occurred NOW
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-replay-test', 33333, blockTime);

    // Approval package was created YESTERDAY (older than block)
    const oldApproveTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await createPoApprovalPackage('pkg-stale-approval', oldApproveTime);

    coordinator = createTestCoordinator(async () => ({ verifiedDead: true }));

    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-replay-test',
      poApprovalId: 'pkg-stale-approval',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');
    assert.match(res.reason ?? '', /Replay of prior approval is forbidden/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true, 'System must remain BLOCKED when stale approval is replayed');
  });

  it('11. Süreç sorgusu hata verir veya belirsiz sonuç döndürürse sistem fail-closed kalır', async () => {
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-query-err', 22222, blockTime);

    const approveTime = new Date(Date.now() + 2000).toISOString();
    await createPoApprovalPackage('pkg-query-err-po', approveTime);

    // Verifier encounters OS query exception / uncertainty
    coordinator = createTestCoordinator(async () => {
      return { verifiedDead: false, error: 'WMI query timeout or permission denied' };
    });

    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-query-err',
      poApprovalId: 'pkg-query-err-po',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');
    assert.match(res.reason ?? '', /Independent OS process table verification failed/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true, 'System must remain fail-closed on OS query error');
  });

  it('12. Eşzamanlı unblock çağrısı yarış koşulu oluşturmaz (Re-entrant / Concurrency Lock)', async () => {
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-concurrency-test', 11111, blockTime);

    const approveTime = new Date(Date.now() + 2000).toISOString();
    await createPoApprovalPackage('pkg-concurrency-po', approveTime);

    // Verifier with simulated delay to expose race conditions
    coordinator = createTestCoordinator(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { verifiedDead: true };
    });

    // Launch two parallel unblock requests simultaneously
    const promise1 = coordinator.unblockProcessIsolation({
      blockId: 'block-concurrency-test',
      poApprovalId: 'pkg-concurrency-po',
    });
    const promise2 = coordinator.unblockProcessIsolation({
      blockId: 'block-concurrency-test',
      poApprovalId: 'pkg-concurrency-po',
    });

    const [res1, res2] = await Promise.all([promise1, promise2]);

    // One must succeed, the other must be rejected by concurrency lock or state guard
    const successes = [res1, res2].filter((r) => r.success);
    const failures = [res1, res2].filter((r) => !r.success);

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent request must succeed');
    assert.strictEqual(failures.length, 1, 'The competing request must fail safely');
    assert.match(failures[0]?.reason ?? '', /Concurrent unblock operation in progress|System is not currently blocked/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, false, 'System should be safely unblocked after winning request completes');
  });

  it('13. Tüketilmiş onay paketi sonraki blokajda tekrar kullanılamaz (Single-Use Replay Protection)', async () => {
    // 1st Block and Unblock
    const block1Time = new Date().toISOString();
    await establishIsolationBlock('block-single-use-1', 12341, block1Time);
    const approveTime = new Date(Date.now() + 1000).toISOString();
    await createPoApprovalPackage('pkg-single-use-po', approveTime);

    coordinator = createTestCoordinator(async () => ({ verifiedDead: true }));

    const unblock1 = await coordinator.unblockProcessIsolation({
      blockId: 'block-single-use-1',
      poApprovalId: 'pkg-single-use-po',
    });
    assert.strictEqual(unblock1.success, true);

    // 2nd Block occurs later
    const block2Time = new Date(Date.now() + 5000).toISOString();
    await establishIsolationBlock('block-single-use-2', 12342, block2Time);

    // Attempt to re-use the SAME approval package that already lifted block 1
    const unblock2 = await coordinator.unblockProcessIsolation({
      blockId: 'block-single-use-2',
      poApprovalId: 'pkg-single-use-po',
    });

    assert.strictEqual(unblock2.success, false);
    assert.strictEqual(unblock2.state, 'BLOCKED');
    assert.match(unblock2.reason ?? '', /already been consumed to unblock a prior isolation block/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true, 'Blockade 2 must remain BLOCKED when consumed approval is re-used');
  });

  it('14. Başka bir projeye ait PO onayı (Cross-Project) blokajı kaldıramaz', async () => {
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-cross-proj', 99999, blockTime);

    // Create an approval package belonging to a foreign project
    const foreignProject = 'foreign-project-xyz';
    const approveTime = new Date(Date.now() + 2000).toISOString();
    const foreignPkg: any = {
      packageId: 'pkg-foreign-po-01',
      revision: 1,
      projectId: foreignProject,
      status: 'APPROVED',
      proposedPlan: { objectives: [], proposedScope: [], proposedFeatureGroups: [], dependencies: [], constraints: [], knownRisks: [], unresolvedIssues: [], excludedScope: [], suggestedImplementationOrder: [] },
      sourceBindings: {
        projectId: foreignProject,
        discoveryRevision: 1, discoveryFingerprint: 'f-disc',
        requirementsRevision: 1, requirementsFingerprint: 'f-req',
        architectureRevision: 1, architectureFingerprint: 'f-arch',
        businessRulesRevision: 1, businessRulesFingerprint: 'f-br',
        acceptanceCriteriaRevision: 1, acceptanceCriteriaFingerprint: 'f-ac',
        riskRevision: 1, riskFingerprint: 'f-risk',
        specRevision: 1, specFingerprint: 'f-spec',
        completenessFingerprint: 'f-comp',
      },
      packageFingerprint: 'fp-foreign',
      understandingRevision: 1,
      createdAt: approveTime,
      updatedAt: approveTime,
      approvalRecord: {
        packageId: 'pkg-foreign-po-01',
        revision: 1,
        actor: 'foreign-po',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: approveTime,
        packageHash: 'foreign-hash',
      },
    };
    await approvalStore.savePackage(foreignPkg);

    coordinator = createTestCoordinator(async () => ({ verifiedDead: true }));

    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-cross-proj',
      poApprovalId: 'pkg-foreign-po-01',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.state, 'BLOCKED');
    assert.match(res.reason ?? '', /Condition A FAIL/);

    const isStillBlocked = await coordinator.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, true, 'Cross-project approval must not lift isolation block');
  });

  it('15. ExecutionBridge doğrudan çağrıldığında sistem PROCESS_ISOLATION_UNCERTAINTY ile bloklu ise fail-closed reddedilir ve blokaj asla silinmez', async () => {
    await establishIsolationBlock('block-bridge-guard', 88888);
    coordinator = createTestCoordinator();

    // Verify initial blocked state in durable storage
    const initialDurable = await durableManager.load();
    assert.strictEqual(initialDurable?.blockedState?.blockingReason, 'PROCESS_ISOLATION_UNCERTAINTY');

    // Attempt direct dispatch via coordinator's internal executionBridge
    const dummyIntent: any = {
      executionIntentId: 'intent-bypass-attempt-01',
      actionId: 'action-bypass-01',
      projectId,
      directorSessionId: sessionId,
      taskId: 'TASK-001',
      taskRevision: 1,
      idempotencyKey: 'idemp-bypass-01',
      basedOnContextFingerprint: 'ctx-fp-1',
      understandingRevision: 1,
      authorizationReference: {
        packageRevision: 1,
        isDevelopmentAuthorized: true,
        authorizedByRole: 'PRODUCT_OWNER',
        authorizedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Bypass test plan',
      metadata: { requiresLlm: false },
    };

    // Preconditions validation must reject with ERR_PROCESS_ISOLATION_BLOCKED
    const preCheck = await coordinator.executionBridge.validatePreconditions(dummyIntent);
    assert.strictEqual(preCheck.isValid, false);
    assert.strictEqual(preCheck.failedChecks[0]?.code, 'ERR_PROCESS_ISOLATION_BLOCKED');

    // Execution must fail-closed
    const execRes = await coordinator.executionBridge.executeIntent(dummyIntent);
    assert.strictEqual(execRes.isSuccess, false);
    assert.strictEqual(execRes.status, 'EXECUTION_FAILED');

    // Durable state must NOT have been erased or overwritten with blockedState: null
    const finalDurable = await durableManager.load();
    assert.strictEqual(finalDurable?.blockedState?.blockingReason, 'PROCESS_ISOLATION_UNCERTAINTY');
    assert.strictEqual(finalDurable?.blockedState?.metadata?.blockId, 'block-bridge-guard');
  });

  it('16. İki ayrı ClosedLoopCoordinator örneği aynı anda aynı workspace te unblock çağırdığında yalnızca biri başarılı olur', async () => {
    const blockTime = new Date().toISOString();
    await establishIsolationBlock('block-cross-instance-test', 77777, blockTime);

    const approveTime = new Date(Date.now() + 2000).toISOString();
    await createPoApprovalPackage('pkg-cross-instance-po', approveTime);

    // Two completely distinct ClosedLoopCoordinator instances for the same workspace
    const verifier = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { verifiedDead: true };
    };
    const coordA = createTestCoordinator(verifier);
    const coordB = createTestCoordinator(verifier);

    // Launch unblock simultaneously from distinct instances
    const [resA, resB] = await Promise.all([
      coordA.unblockProcessIsolation({
        blockId: 'block-cross-instance-test',
        poApprovalId: 'pkg-cross-instance-po',
      }),
      coordB.unblockProcessIsolation({
        blockId: 'block-cross-instance-test',
        poApprovalId: 'pkg-cross-instance-po',
      }),
    ]);

    const successes = [resA, resB].filter((r) => r.success);
    const failures = [resA, resB].filter((r) => !r.success);

    assert.strictEqual(successes.length, 1, 'Exactly one coordinator instance must succeed');
    assert.strictEqual(failures.length, 1, 'The competing instance must fail safely');
    assert.match(
      failures[0]?.reason ?? '',
      /Concurrent unblock operation in progress|System state was already unblocked concurrently|was consumed concurrently/
    );

    const isStillBlocked = await coordA.isIsolationBlocked();
    assert.strictEqual(isStillBlocked, false, 'Workspace must be safely unblocked by the winning instance');
  });

  it('17. Onay kaydı (approvalRecord) olmayan paket blokajı kaldıramaz (fail-closed)', async () => {
    await establishIsolationBlock('block-no-record', 55555);
    const pkg = await createPoApprovalPackage('pkg-no-record', new Date(Date.now() + 2000).toISOString());
    delete pkg.approvalRecord;
    await approvalStore.savePackage(pkg);

    coordinator = createTestCoordinator(async () => ({ verifiedDead: true, output: 'dead' }));
    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-no-record',
      poApprovalId: 'pkg-no-record',
    });

    assert.strictEqual(res.success, false);
    assert.match(res.reason ?? '', /Condition A FAIL/);
    assert.strictEqual(await coordinator.isIsolationBlocked(), true);
  });

  it('18. Doğrulanacak PID yoksa süreç doğrulaması boş geçmez (vacuous verification reddedilir)', async () => {
    await establishIsolationBlock('block-no-pid', null as unknown as number);
    await createPoApprovalPackage('pkg-no-pid', new Date(Date.now() + 2000).toISOString());

    let verifierCalled = false;
    coordinator = createTestCoordinator(async () => {
      verifierCalled = true;
      return { verifiedDead: true, output: 'empty list' };
    });
    const res = await coordinator.unblockProcessIsolation({
      blockId: 'block-no-pid',
      poApprovalId: 'pkg-no-pid',
    });

    assert.strictEqual(res.success, false);
    assert.match(res.reason ?? '', /Condition B FAIL/);
    assert.strictEqual(verifierCalled, false);
    assert.strictEqual(await coordinator.isIsolationBlocked(), true);
  });
});


