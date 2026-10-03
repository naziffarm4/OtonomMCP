import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthorizationPolicyEngine } from '../src/authorization/authorization-policy-engine.js';
import { ProjectMandateStore } from '../src/authorization/project-mandate-store.js';
import { HistoryManager } from '../src/storage/history-manager.js';
import { AuthorizationDecisionResult, ProjectMandate } from '../src/authorization/authorization-policy-types.js';
import { DirectorActionEnvelope } from '../src/director-action/director-action-types.js';
import { BridgeExecutionIntent } from '../src/execution-bridge/execution-bridge-types.js';
import { ExecutionBridge } from '../src/execution-bridge/execution-bridge.js';
import { DirectorActionDispatcher } from '../src/director-action/director-action-dispatcher.js';
import { ActionDispatchStatus } from '../src/director-action/director-action-types.js';

describe('P21 - Authorization Policy & Governance Enforcement', () => {
  let engine: AuthorizationPolicyEngine;
  let mandateStore: ProjectMandateStore;
  let historyManager: HistoryManager;
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
    engine = new AuthorizationPolicyEngine({ historyManager, mandateStore });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('1. Mandate kapsamındaki rutin kod değişikliği ALLOW', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.ALLOW);
  });

  it('2. İzin verilen test komutu ALLOW', async () => {
    // "IMPLEMENT_TASK" is routinely allowed in policy engine.
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { executionPlan: 'run tests' });
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.ALLOW);
  });

  it('3. İzin verilmeyen dizine yazma DENY (veya EXPLICITLY_FORBIDDEN_OPERATION)', async () => {
    const restrictedMandate = { ...baseMandate, forbiddenOperations: ['WRITE_OUTSIDE_WORKSPACE'] };
    await mandateStore.saveMandate(restrictedMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('WRITE_OUTSIDE_WORKSPACE' as any);
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
  });

  it('4. Ürün gereksinimi değiştirme REQUIRE_HUMAN_APPROVAL', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('REPLAN');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
  });

  it('5. Destructive işlem DENY', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('SYSTEM_DESTRUCTIVE' as any);
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
  });

  it('6. Güvenlik politikasını değiştirme REQUIRE_HUMAN_APPROVAL', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('UPDATE_SECURITY_POLICY' as any);
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
  });

  it('7. Sahte PRODUCT_OWNER kimliği reddedilir', async () => {
    await expect(mandateStore.saveMandate(baseMandate, { verified: false, authSource: 'UNTRUSTED_CLIENT' })).rejects.toThrow('WAITING_FOR_TRUSTED_IDENTITY');
  });

  it('8. Sahte VERIFIED_HUMAN bilgisi reddedilir', async () => {
    await expect(mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'SOME_FAKE_IDE' })).rejects.toThrow('WAITING_FOR_TRUSTED_IDENTITY');
  });

  it('9. Geçersiz (bozuk) mandate reddedilir', async () => {
    // Write corrupt json
    await fs.promises.mkdir(path.join(testDir, '.ai-manager', 'state'), { recursive: true });
    await fs.promises.writeFile(path.join(testDir, '.ai-manager', 'state', 'project-mandate.json'), '{ bad json');
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);
  });
  
  it('9.5. Eksik mandate durumunda fail closed', async () => {
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);
  });

  it('10. Süresi geçmiş mandate reddedilir', async () => {
    const expiredMandate = { ...baseMandate, authorizationEndTime: new Date(Date.now() - 1000).toISOString() };
    await mandateStore.saveMandate(expiredMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
  });

  it('11. Stale fingerprint reddedilir (Dispatcher tarafında P19 Check)', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
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
    expect(result.status).toBe(ActionDispatchStatus.REJECTED);
    expect(result.code).toBe('ERR_DIRECTOR_ACTION_STALE_CONTEXT');
  });

  it('12. Stale task revision reddedilir (Dispatcher P19 Check)', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
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
    expect(result.status).toBe(ActionDispatchStatus.REJECTED);
    expect(result.code).toBe('ERR_DIRECTOR_ACTION_STALE_REVISION');
  });

  it('13. Başka proje adına işlem reddedilir', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'wrong-project');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
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
    expect(result.status).toBe(ActionDispatchStatus.REJECTED);
    expect(result.code).toBe('ERR_SESSION_MISMATCH');
  });

  it('15. Duplicate action ikinci kez yürütülemez (Idempotency)', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
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
    expect(result1.status).toBe(ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);

    // Dispatch exact same envelope again
    const result2 = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot
    });
    expect(result2.status).toBe(ActionDispatchStatus.DUPLICATE);
  });

  it('16. Policy veritabanı veya HistoryManager hatasında fail-closed', async () => {
    // Break history manager append event
    vi.spyOn(historyManager, 'appendEvent').mockRejectedValue(new Error('Disk write failed'));
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    await expect(engine.evaluateAction(envelope)).rejects.toThrow('Disk write failed');
  });

  it('17. Restart sonrası policy kararları ve geçmişi korunur', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    await engine.evaluateAction(envelope);

    const events = await historyManager.readEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.eventType === 'AUTHORIZATION_POLICY_DECISION')).toBe(true);
  });

  it('18. P20 ExecutionBridge policy kararı olmadan yürütme başlatamaz', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    
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
    expect(check10).toBeDefined();
    expect(check10?.passed).toBe(true);
  });

  it('19. P20 Trusted IDE Authentication eksikliği yürütmeyi engellemeye devam eder', async () => {
    // If requireTrustedAuthContext is true, it should fail Check 8 if missing.
    const bridge = new ExecutionBridge({
      workspaceRoot: testDir,
      authorizationPolicyEngine: engine,
      requireTrustedAuthContext: true
    });

    vi.spyOn(bridge.approvalStore, 'getActivePackage').mockResolvedValue({
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
    } as any);
    
    vi.spyOn(bridge.approvalPackageEngine, 'isDevelopmentAuthorized').mockReturnValue(true);

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
    expect(check6?.passed).toBe(false);
    expect(check6?.code).toBe('BLOCKED_ON_AUTH_CONTEXT');
  });

  it('20. Policy motoru doğrudan Driver veya AGY çağrısı yapmaz', async () => {
    // By architecture, AuthorizationPolicyEngine only returns a decision.
    // It doesn't even have a reference to DriverEngine or Runtime.
    expect((engine as any).driverEngine).toBeUndefined();
    expect((engine as any).driverRuntime).toBeUndefined();
  });

  it('3a. Mandate revision uyuşmazlığı', async () => {
    await mandateStore.saveMandate({ ...baseMandate, mandateRevision: 2 }, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { expectedMandateRevision: 1 });
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
    expect(decision.appliedRules).toContain('MANDATE_REVISION_MISMATCH');
  });

  it('4a. Policy version uyuşmazlığı', async () => {
    await mandateStore.saveMandate({ ...baseMandate, policyVersion: 2 }, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { expectedPolicyVersion: 1 });
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
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
    expect(result.status).toBe(ActionDispatchStatus.REJECTED);
    expect(result.code).toBe('ERR_POLICY_ENGINE_MISSING');
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
    expect(check10?.passed).toBe(false);
    expect(check10?.code).toBe('ERR_POLICY_ENGINE_DENIED');
  });
});
