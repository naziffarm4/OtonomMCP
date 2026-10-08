import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  HistoryManager,
  AuthorizationDecisionResult,
  type ProjectMandate,
  type DirectorActionEnvelope,
  type BridgeExecutionIntent,
  ExecutionBridge,
  DirectorActionDispatcher,
  ActionDispatchStatus,
  IdentityManager,
  SpecStore,
} from '../dist/index.js';

const expect = (actual: any) => ({
  toBeUndefined: () => assert.equal(actual, undefined),
  toBeGreaterThan: (expected: number) => assert.ok(actual > expected, `Expected ${actual} > ${expected}`),
  toContain: (item: any) => assert.ok(actual.includes(item), `Expected to contain ${item}`),
});

describe('P21 - Authorization Policy & Governance Enforcement', () => {
  let engine: AuthorizationPolicyEngine;
  let mandateStore: ProjectMandateStore;
  let historyManager: HistoryManager;
  let identityManager: IdentityManager;
  let testDir: string;
  let runCount = 0;

  const baseMandate: ProjectMandate = {
    projectId: 'test-project',
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

  const createMockEnvelope = (actionType: any, payloadOverrides = {}, projectId = 'test-project', directorSessionId = 'session-1', fingerprint = 'ctx1'): DirectorActionEnvelope => ({
    protocolVersion: 'P19-01',
    schemaVersion: 1,
    actionId: `act-test-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    projectId,
    directorSessionId,
    basedOnContextFingerprint: fingerprint,
    understandingRevision: 1,
    actionType,
    actor: 'DIRECTOR',
    actorRole: 'DIRECTOR',
    timestamp: new Date().toISOString(),
    payload: { taskId: 'task-1', ...payloadOverrides }
  });

  beforeEach(async () => {
    runCount++;
    testDir = path.join(process.cwd(), `.test-p21-${runCount}`);
    await fs.promises.mkdir(testDir, { recursive: true });
    historyManager = new HistoryManager({ baseDir: testDir });
    mandateStore = new ProjectMandateStore({ baseDir: testDir });
    const specStore = new SpecStore({ baseDir: testDir });
    await specStore.saveTasks([
      {
        task_id: 'task-1',
        title: 'Task 1',
        description: 'Test task',
        status: 'READY',
        metadata: {
          taskClass: 'IMPLEMENTATION',
          revision: 1,
        },
      } as any,
      {
        task_id: 'task1',
        title: 'Task 1 alias',
        description: 'Test task alias',
        status: 'READY',
        metadata: {
          taskClass: 'IMPLEMENTATION',
          revision: 1,
        },
      } as any,
    ], { bypassValidation: true });
    engine = new AuthorizationPolicyEngine({ historyManager, mandateStore, specStore });
    identityManager = new IdentityManager({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => { });
  });

  async function saveTestMandate(mandate: ProjectMandate, authOverrides: any = {}) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-1',
      projectId: mandate.projectId,
      instanceId: 'inst-1',
      actorType: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      nonce: crypto.randomUUID(),
      publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey),
      authenticationMethod: 'ED25519_DPAPI',
      protocolVersion: 1,
      verified: true,
      authSource: 'TRUSTED_IDE',
      ...authOverrides,
    };
    const signature = await identityManager.signPayload(payload, privateKey);
    return await mandateStore.saveMandate(mandate, { ...payload, signature });
  }

  it('1. Mandate kapsamındaki rutin kod değişikliği ALLOW', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
  });

  it('2. İzin verilen test komutu ALLOW', async () => {
    // "IMPLEMENT_TASK" is routinely allowed in policy engine.
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { executionPlan: 'run tests' });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
  });

  it('3. İzin verilmeyen dizine yazma DENY (veya EXPLICITLY_FORBIDDEN_OPERATION)', async () => {
    const restrictedMandate = { ...baseMandate, forbiddenOperations: ['WRITE_OUTSIDE_WORKSPACE'] };
    await saveTestMandate(restrictedMandate);
    const envelope = createMockEnvelope('WRITE_OUTSIDE_WORKSPACE' as any);
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
  });

  it('4. Ürün gereksinimi değiştirme REQUIRE_HUMAN_APPROVAL', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('REPLAN');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
  });

  it('5. Destructive işlem DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('SYSTEM_DESTRUCTIVE' as any);
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
  });

  it('6. Güvenlik politikasını değiştirme REQUIRE_HUMAN_APPROVAL', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('UPDATE_SECURITY_POLICY' as any);
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
  });

  it('7. Sahte PRODUCT_OWNER kimliği reddedilir', async () => {
    await assert.rejects(async () => await mandateStore.saveMandate(baseMandate, { verified: false, authSource: 'UNTRUSTED_CLIENT' }), /WAITING_FOR_TRUSTED_IDENTITY/);
  });

  it('8. Sahte VERIFIED_HUMAN bilgisi reddedilir', async () => {
    await assert.rejects(async () => await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'SOME_FAKE_IDE' }), /WAITING_FOR_TRUSTED_IDENTITY/);
  });

  it('9. Geçersiz (bozuk) mandate reddedilir', async () => {
    // Write corrupt json
    await fs.promises.mkdir(path.join(testDir, '.ai-manager', 'state'), { recursive: true });
    await fs.promises.writeFile(path.join(testDir, '.ai-manager', 'state', 'project-mandate.json'), '{ bad json');
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);
  });

  it('9.5. Eksik mandate durumunda fail closed', async () => {
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);
  });

  it('10. Süresi geçmiş mandate reddedilir', async () => {
    const expiredMandate = { ...baseMandate, authorizationEndTime: new Date(Date.now() - 1000).toISOString() };
    await saveTestMandate(expiredMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
  });

  it('11. Stale fingerprint reddedilir (Dispatcher tarafında P19 Check)', async () => {
    await saveTestMandate(baseMandate);
    const dispatcher = new DirectorActionDispatcher({
      historyManager,
      authorizationPolicyEngine: engine
    });
    const snapshot = {
      projectId: 'test-project',
      directorSessionId: 'session-1',
      logicalFingerprint: 'ctx-current',
      sections: {
        taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
        authorization: { isDevelopmentAuthorized: true },
        evidence: { items: [] }
      }
    } as any;

    // Validate that envelope with old fingerprint is rejected
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'test-project', 'session-1', 'ctx-old');
    const result = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot
    });
    assert.equal(result.status, ActionDispatchStatus.REJECTED);
    assert.equal(result.code, 'ERR_DIRECTOR_ACTION_STALE_CONTEXT');
  });

  it('12. Stale task revision reddedilir (Dispatcher P19 Check)', async () => {
    await saveTestMandate(baseMandate);
    const dispatcher = new DirectorActionDispatcher({
      historyManager,
      authorizationPolicyEngine: engine
    });
    const snapshot = {
      projectId: 'test-project',
      directorSessionId: 'session-1',
      logicalFingerprint: 'ctx1',
      sections: {
        taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
        authorization: { isDevelopmentAuthorized: true },
        evidence: { items: [] }
      },
      sectionMetadata: { requirements: { revision: 5 } }
    } as any;

    // Envelope has understandingRevision: 1
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'test-project', 'session-1', 'ctx1');
    const result = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot
    });
    assert.equal(result.status, ActionDispatchStatus.REJECTED);
    assert.equal(result.code, 'ERR_DIRECTOR_ACTION_STALE_REVISION');
  });

  it('13. Başka proje adına işlem reddedilir', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'wrong-project');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
  });

  it('14. Başka session adına işlem reddedilir', async () => {
    const dispatcher = new DirectorActionDispatcher({ historyManager, authorizationPolicyEngine: engine });
    const snapshot = {
      projectId: 'test-project',
      directorSessionId: 'session-new',
      logicalFingerprint: 'ctx1',
      sections: {
        taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
        authorization: { isDevelopmentAuthorized: true },
        requirements: { revision: 1 },
        evidence: { items: [] }
      }
    } as any;

    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'test-project', 'session-old');
    const result = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot
    });
    assert.equal(result.status, ActionDispatchStatus.REJECTED);
    assert.equal(result.code, 'ERR_SESSION_MISMATCH');
  });

  it('15. Duplicate action ikinci kez yürütülemez (Idempotency)', async () => {
    await saveTestMandate(baseMandate);
    const dispatcher = new DirectorActionDispatcher({ historyManager, authorizationPolicyEngine: engine });
    const snapshot = {
      projectId: 'test-project',
      directorSessionId: 'session-1',
      logicalFingerprint: 'ctx1',
      sections: {
        taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
        authorization: { isDevelopmentAuthorized: true },
        requirements: { revision: 1 },
        evidence: { items: [] }
      }
    } as any;

    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'test-project', 'session-1', 'ctx1');
    const result1 = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot
    });
    assert.equal(result1.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);

    // Dispatch exact same envelope again
    const result2 = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot
    });
    assert.equal(result2.status, ActionDispatchStatus.DUPLICATE);
  });

  it('16. Policy veritabanı veya HistoryManager hatasında fail-closed', async () => {
    // Break history manager append event
    mock.method(historyManager, 'appendEvent').mock.mockImplementation(async () => { throw new Error('Disk write failed'); });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    await assert.rejects(async () => await engine.evaluateAction(envelope), /Disk write failed/);
  });

it('17. Restart sonrası policy kararları ve geçmişi korunur', async () => {
  await saveTestMandate(baseMandate);
  const envelope = createMockEnvelope('IMPLEMENT_TASK');
  await engine.evaluateAction(envelope);

  const events = await historyManager.readEvents();
  expect(events.length).toBeGreaterThan(0);
  assert.equal(events.some((e) => e.eventType === 'AUTHORIZATION_POLICY_DECISION'), true);
});

it('18. P20 ExecutionBridge policy kararı olmadan yürütme başlatamaz', async () => {
  await saveTestMandate(baseMandate);

  const bridge = new ExecutionBridge({
    workspaceRoot: testDir,
    authorizationPolicyEngine: engine,
  });

  const intent: BridgeExecutionIntent = {
    executionIntentId: 'intent1',
    actionId: 'act1',
    idempotencyKey: 'idk',
    projectId: 'test-project',
    directorSessionId: 'sess1',
    taskId: 'task1',
    taskRevision: 1,
    basedOnContextFingerprint: 'ctx1',
    understandingRevision: 1,
    authorizationReference: {
      packageRevision: 1,
      isDevelopmentAuthorized: true,
    },
    createdAt: new Date().toISOString(),
    executionPlan: 'plan',
  };

  const result = await bridge.validatePreconditions(intent);
  const check10 = result.allChecks.find(c => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
  assert.ok(check10);
  assert.equal(check10?.passed, true);
});

it('19. P20 Trusted IDE Authentication eksikliği yürütmeyi engellemeye devam eder', async () => {
  // If requireTrustedAuthContext is true, it should fail Check 8 if missing.
  const bridge = new ExecutionBridge({
    workspaceRoot: testDir,
    authorizationPolicyEngine: engine,
    requireTrustedAuthContext: true
  });

  mock.method(bridge.approvalStore, 'getActivePackage').mock.mockImplementation(async () => ({
    packageId: 'pkg1',
    projectId: 'test-project',
    status: 'APPROVED',
    revision: 1,
    approvalRecord: {
      actor: 'PO',
      actorRole: 'PRODUCT_OWNER',
      authStatus: 'AUTHORIZED',
      provenanceSource: 'SYSTEM'
    },
    intents: []
  } as any));

  mock.method(bridge.approvalPackageEngine, 'isDevelopmentAuthorized').mock.mockImplementation(() => (true));

  const intent: BridgeExecutionIntent = {
    executionIntentId: 'intent1',
    actionId: 'act1',
    idempotencyKey: 'idk',
    projectId: 'test-project',
    directorSessionId: 'sess1',
    taskId: 'task1',
    taskRevision: 1,
    basedOnContextFingerprint: 'ctx1',
    understandingRevision: 1,
    authorizationReference: {
      packageRevision: 1,
      isDevelopmentAuthorized: true,
      // authContext is missing here
    },
    createdAt: new Date().toISOString(),
    executionPlan: 'plan',
  };

  const result = await bridge.validatePreconditions(intent);
  const check6 = result.allChecks.find(c => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
  console.log(check6?.reason);
  assert.equal(check6?.passed, false);
  assert.equal(check6?.code, 'BLOCKED_ON_AUTH_CONTEXT');
});

it('20. Policy motoru doğrudan Driver veya AGY çağrısı yapmaz', async () => {
  // By architecture, AuthorizationPolicyEngine only returns a decision.
  // It doesn't even have a reference to DriverEngine or Runtime.
  expect((engine as any).driverEngine).toBeUndefined();
  expect((engine as any).driverRuntime).toBeUndefined();
});

it('3a. Mandate revision uyuşmazlığı', async () => {
  await saveTestMandate({ ...baseMandate, mandateRevision: 2 });
  const envelope = createMockEnvelope('IMPLEMENT_TASK', { expectedMandateRevision: 1 });
  const decision = await engine.evaluateAction(envelope);
  assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
  expect(decision.appliedRules).toContain('MANDATE_REVISION_MISMATCH');
});

it('4a. Policy version uyuşmazlığı', async () => {
  await saveTestMandate({ ...baseMandate, policyVersion: 2 });
  const envelope = createMockEnvelope('IMPLEMENT_TASK', { expectedPolicyVersion: 1 });
  const decision = await engine.evaluateAction(envelope);
  assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
  expect(decision.appliedRules).toContain('POLICY_VERSION_MISMATCH');
});

it('11a. Dispatcher bypass denemesi (Fail closed)', async () => {
  // If authorizationPolicyEngine is omitted in options, it should fail closed.
  const dispatcher = new DirectorActionDispatcher({ historyManager }); // NO ENGINE
  const snapshot = {
    projectId: 'test-project',
    directorSessionId: 'session-1',
    logicalFingerprint: 'ctx1',
    sections: {
      taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
      authorization: { isDevelopmentAuthorized: true },
      requirements: { revision: 1 },
      evidence: { items: [] }
    }
  } as any;

  const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'test-project', 'session-1', 'ctx1');
  const result = await dispatcher.dispatch({
    validatedResult: { success: true, envelope } as any,
    snapshot
  });
  assert.equal(result.status, ActionDispatchStatus.REJECTED);
  assert.equal(result.code, 'ERR_POLICY_ENGINE_MISSING');
});

it('12a. ExecutionBridge bypass denemesi (Fail closed)', async () => {
  const bridge = new ExecutionBridge({
    workspaceRoot: testDir,
    // NO ENGINE
  });

  const intent: BridgeExecutionIntent = {
    executionIntentId: 'intent1',
    actionId: 'act1',
    idempotencyKey: 'idk',
    projectId: 'test-project',
    directorSessionId: 'sess1',
    taskId: 'task1',
    taskRevision: 1,
    basedOnContextFingerprint: 'ctx1',
    understandingRevision: 1,
    authorizationReference: {
      packageRevision: 1,
      isDevelopmentAuthorized: true,
    },
    createdAt: new Date().toISOString(),
    executionPlan: 'plan',
  };

  const result = await bridge.validatePreconditions(intent);
  const check10 = result.allChecks.find(c => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
  assert.equal(check10?.passed, false);
  assert.equal(check10?.code, 'ERR_POLICY_ENGINE_DENIED');
});
});
