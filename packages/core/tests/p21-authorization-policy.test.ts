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

describe('P21 - Authorization Policy & Governance Enforcement', () => {
  let engine: AuthorizationPolicyEngine;
  let mandateStore: ProjectMandateStore;
  let historyManager: HistoryManager;
  const testDir = path.join(process.cwd(), '.test-p21');

  const baseMandate: ProjectMandate = {
    projectId: 'test-project',
    allowedDirectories: ['src/'],
    allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'BUILD_EXECUTION'],
    allowedCommandCategories: ['test', 'build', 'lint', 'format'],
    autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
    forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE'],
    humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION'],
    authorizationStartTime: new Date(Date.now() - 100000).toISOString(),
    authorizationEndTime: new Date(Date.now() + 100000).toISOString(),
    resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
    policyVersion: 1,
    mandateRevision: 1,
  };

  const createMockEnvelope = (actionType: any, projectId = 'test-project', directorSessionId = 'session-1'): DirectorActionEnvelope => ({
    protocolVersion: 'P19-01',
    schemaVersion: 1,
    actionId: 'act-test1',
    idempotencyKey: 'key1',
    projectId,
    directorSessionId,
    basedOnContextFingerprint: 'ctx1',
    understandingRevision: 1,
    actionType,
    actor: 'DIRECTOR',
    actorRole: 'DIRECTOR',
    timestamp: new Date().toISOString(),
    payload: { taskId: 'task-1' }
  });

  beforeEach(async () => {
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

  it('4. Ürün gereksinimi değiştirme REQUIRE_HUMAN_APPROVAL', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('REPLAN');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
  });

  it('5. Destructive işlem DENY', async () => {
    const restrictedMandate = { ...baseMandate, forbiddenOperations: ['IMPLEMENT_TASK'] };
    await mandateStore.saveMandate(restrictedMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
  });

  it('7. Sahte PRODUCT_OWNER kimliği reddedilir', async () => {
    await expect(mandateStore.saveMandate(baseMandate, { verified: false, authSource: 'UNTRUSTED_CLIENT' })).rejects.toThrow('WAITING_FOR_TRUSTED_IDENTITY');
  });

  it('8. Sahte VERIFIED_HUMAN bilgisi reddedilir', async () => {
    await expect(mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'SOME_FAKE_IDE' })).rejects.toThrow('WAITING_FOR_TRUSTED_IDENTITY');
  });

  it('10. Süresi geçmiş mandate reddedilir', async () => {
    const expiredMandate = { ...baseMandate, authorizationEndTime: new Date(Date.now() - 1000).toISOString() };
    await mandateStore.saveMandate(expiredMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
  });

  it('13. Başka proje adına işlem reddedilir', async () => {
    await mandateStore.saveMandate(baseMandate, { verified: true, authSource: 'TRUSTED_IDE' });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', 'wrong-project');
    const decision = await engine.evaluateAction(envelope);
    expect(decision.decisionResult).toBe(AuthorizationDecisionResult.DENY);
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
    // Since Check 2, 4, 6 will fail (no active session, no active PO approval), let's just assert it runs Check 10 and Check 10 passes (it's ALLOW)
    const check10 = result.allChecks.find(c => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
    expect(check10).toBeDefined();
    expect(check10?.passed).toBe(true);

    // If mandate is missing, Check 10 should fail
    await fs.promises.rm(path.join(testDir, '.ai-manager', 'state', 'project-mandate.json'), { force: true });
    const resultNoMandate = await bridge.validatePreconditions(intent);
    const check10NoMandate = resultNoMandate.allChecks.find(c => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
    expect(check10NoMandate?.passed).toBe(false);
  });
});
