import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  HistoryManager,
  SpecStore,
  SystemExecutionEvidenceStore,
  AuthorizationDecisionResult,
  type ProjectMandate,
  type DirectorActionEnvelope,
  type BridgeExecutionIntent,
  type SystemExecutionEvidence,
  ExecutionBridge,
  DirectorActionDispatcher,
  ActionDispatchStatus,
  IdentityManager,
} from '../dist/index.js';

describe('P32 — Authorization Policy Hardening & Explicit Mandate Enforcement', () => {
  let engine: AuthorizationPolicyEngine;
  let mandateStore: ProjectMandateStore;
  let historyManager: HistoryManager;
  let identityManager: IdentityManager;
  let specStore: SpecStore;
  let evidenceStore: SystemExecutionEvidenceStore;
  let testDir: string;
  let runCount = 0;

  const validProjectId = 'p32-secure-project';

  const baseMandate: ProjectMandate = {
    projectId: validProjectId,
    allowedDirectories: ['src/'],
    allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'BUILD_EXECUTION'],
    allowedCommandCategories: ['test', 'build', 'lint', 'format'],
    autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
    forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE'],
    humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION'],
    authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
    authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
    resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
    policyVersion: 1,
    mandateRevision: 1,
  };

  const createMockEnvelope = (
    actionType: any,
    payloadOverrides: Record<string, unknown> = {},
    projectId = validProjectId,
    directorSessionId = 'session-p32',
    fingerprint = 'ctx-p32-fp'
  ): DirectorActionEnvelope => ({
    protocolVersion: 'P19-01',
    schemaVersion: 1,
    actionId: `act-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    projectId,
    directorSessionId,
    basedOnContextFingerprint: fingerprint,
    understandingRevision: 1,
    actionType,
    actor: 'DIRECTOR',
    actorRole: 'DIRECTOR',
    timestamp: new Date().toISOString(),
    payload: { taskId: 'task-1', ...payloadOverrides },
  });

  function createValidEvidence(overrides: Partial<SystemExecutionEvidence> = {}): SystemExecutionEvidence {
    return {
      evidenceId: `evi_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      requestId: 'req_test_p32',
      taskId: 'task-1',
      taskRevision: 1,
      projectId: validProjectId,
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      contextFingerprint: 'ctx-p32-fp',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      repositoryState: {
        baseCommit: 'commit_base_sha',
        headCommit: 'commit_head_sha',
        isClean: true,
      },
      changedFiles: [{ path: 'src/index.ts', status: 'MODIFIED' }],
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
      ...overrides,
    };
  }

  async function saveTestMandate(mandate: ProjectMandate, authOverrides: any = {}) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-p32',
      projectId: mandate.projectId,
      instanceId: 'inst-p32',
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

  beforeEach(async () => {
    runCount++;
    testDir = path.join(process.cwd(), `.test-p32-${runCount}-${Date.now()}`);
    await fs.promises.mkdir(testDir, { recursive: true });
    historyManager = new HistoryManager({ baseDir: testDir });
    mandateStore = new ProjectMandateStore({ baseDir: testDir });
    specStore = new SpecStore({ baseDir: testDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: testDir });
    engine = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore,
    });
    identityManager = new IdentityManager({ baseDir: testDir });

    // Seed authoritative task-1 for implementation tests
    await specStore.saveTasks([
      {
        task_id: 'task-1',
        parent_feature_id: 'feat-1',
        title: 'Core feature',
        description: 'Implement core logic',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptanceCriteria: ['AC1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'IMPLEMENTATION' },
      } as any,
    ]);
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ==========================================================================
  // SECTION 1: Authorization Basics (T01 - T06)
  // ==========================================================================

  it('T01 — missing mandate -> fail closed', async () => {
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);
    assert.ok(decision.appliedRules.includes('MISSING_PROJECT_MANDATE'));
  });

  it('T02 — expired mandate -> DENY', async () => {
    const expiredMandate = {
      ...baseMandate,
      authorizationEndTime: new Date(Date.now() - 1000).toISOString(),
    };
    await saveTestMandate(expiredMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('MANDATE_EXPIRED_OR_NOT_STARTED'));
  });

  it('T03 — future mandate -> DENY', async () => {
    const futureMandate = {
      ...baseMandate,
      authorizationStartTime: new Date(Date.now() + 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 7200000).toISOString(),
    };
    await saveTestMandate(futureMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('MANDATE_EXPIRED_OR_NOT_STARTED'));
  });

  it('T04 — project mismatch -> DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, 'alien-project');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('PROJECT_ISOLATION_VIOLATION'));
  });

  it('T05 — mandate revision mismatch -> DENY', async () => {
    await saveTestMandate({ ...baseMandate, mandateRevision: 3 });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { expectedMandateRevision: 2 });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('MANDATE_REVISION_MISMATCH'));
  });

  it('T06 — policy version mismatch -> DENY', async () => {
    await saveTestMandate({ ...baseMandate, policyVersion: 2 });
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { expectedPolicyVersion: 1 });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('POLICY_VERSION_MISMATCH'));
  });

  // ==========================================================================
  // SECTION 2: Operation Permissions (T07 - T12)
  // ==========================================================================

  it('T07 — IMPLEMENT_TASK without FILE_MODIFY permission -> DENY', async () => {
    const readOnlyMandate: ProjectMandate = {
      ...baseMandate,
      allowedOperationTypes: ['FILE_READ'],
    };
    await saveTestMandate(readOnlyMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('OPERATION_NOT_ALLOWED'));
  });

  it('T08 — IMPLEMENT_TASK with FILE_MODIFY permission -> eligible', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
  });

  it('T09 — FILE_CREATE permission respected', async () => {
    // 1. Without FILE_CREATE
    const noCreateMandate: ProjectMandate = {
      ...baseMandate,
      allowedOperationTypes: ['FILE_MODIFY', 'FILE_READ'],
    };
    await saveTestMandate(noCreateMandate);
    const envelopeNoCreate = createMockEnvelope('CREATE_TASK', {
      title: 'New Task',
      description: 'Desc',
      acceptanceCriteria: ['AC1'],
    });
    const decisionDenied = await engine.evaluateAction(envelopeNoCreate);
    assert.equal(decisionDenied.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decisionDenied.appliedRules.includes('OPERATION_NOT_ALLOWED'));

    // 2. With FILE_CREATE
    await saveTestMandate(baseMandate);
    const decisionAllowed = await engine.evaluateAction(envelopeNoCreate);
    assert.equal(decisionAllowed.decisionResult, AuthorizationDecisionResult.ALLOW);
  });

  it('T10 — TEST_EXECUTION permission respected', async () => {
    // Mandate without TEST_EXECUTION
    const noTestMandate: ProjectMandate = {
      ...baseMandate,
      allowedOperationTypes: ['FILE_MODIFY', 'FILE_READ'],
    };
    await saveTestMandate(noTestMandate);
    const envelopeWithTestPlan = createMockEnvelope('IMPLEMENT_TASK', {
      executionPlan: 'Run pnpm test to verify changes',
    });
    const decision = await engine.evaluateAction(envelopeWithTestPlan);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('OPERATION_NOT_ALLOWED'));
  });

  it('T11 — BUILD_EXECUTION permission respected', async () => {
    // Mandate without BUILD_EXECUTION
    const noBuildMandate: ProjectMandate = {
      ...baseMandate,
      allowedOperationTypes: ['FILE_MODIFY', 'FILE_READ'],
    };
    await saveTestMandate(noBuildMandate);
    const envelopeWithBuildPlan = createMockEnvelope('IMPLEMENT_TASK', {
      executionPlan: 'Run pnpm build bundle',
    });
    const decision = await engine.evaluateAction(envelopeWithBuildPlan);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('OPERATION_NOT_ALLOWED'));
  });

  it('T12 — unknown operation -> DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('ARBITRARY_UNRECOGNIZED_ACTION' as any);
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('UNKNOWN_OPERATION_DENIED'));
  });

  // ==========================================================================
  // SECTION 3: Forbidden Precedence (T13 - T15)
  // ==========================================================================

  it('T13 — forbidden overrides allowed', async () => {
    // FILE_MODIFY is present in allowedOperationTypes AND forbiddenOperations
    const conflictingMandate: ProjectMandate = {
      ...baseMandate,
      allowedOperationTypes: ['FILE_MODIFY', 'FILE_READ'],
      forbiddenOperations: ['FILE_MODIFY'],
    };
    await saveTestMandate(conflictingMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));
  });

  it('T14 — forbidden overrides human approval', async () => {
    // REPLAN is in humanApprovalRequiredOperations AND forbiddenOperations
    const conflictingMandate: ProjectMandate = {
      ...baseMandate,
      humanApprovalRequiredOperations: ['REPLAN'],
      forbiddenOperations: ['REPLAN'],
    };
    await saveTestMandate(conflictingMandate);
    const envelope = createMockEnvelope('REPLAN', {
      replanReason: 'Need to restructure tasks',
      affectedTaskIds: ['task-1'],
    });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));
  });

  it('T15 — forbidden implementation operation -> DENY', async () => {
    const forbiddenImplMandate: ProjectMandate = {
      ...baseMandate,
      forbiddenOperations: ['IMPLEMENTATION'],
    };
    await saveTestMandate(forbiddenImplMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));
  });

  // ==========================================================================
  // SECTION 4: Human Approval Precedence (T16 - T20)
  // ==========================================================================

  it('T16 — implementation requiring approval -> REQUIRE_HUMAN_APPROVAL', async () => {
    const approvalMandate: ProjectMandate = {
      ...baseMandate,
      humanApprovalRequiredOperations: ['IMPLEMENT_TASK'],
    };
    await saveTestMandate(approvalMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_REQUIRES_HUMAN_APPROVAL'));
  });

  it('T17 — retry requiring approval -> REQUIRE_HUMAN_APPROVAL', async () => {
    const approvalMandate: ProjectMandate = {
      ...baseMandate,
      humanApprovalRequiredOperations: ['RETRY_TASK'],
    };
    await saveTestMandate(approvalMandate);
    const envelope = createMockEnvelope('RETRY_TASK', {
      reason: 'Retry after timeout',
    });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_REQUIRES_HUMAN_APPROVAL'));
  });

  it('T18 — corrective task requiring approval -> REQUIRE_HUMAN_APPROVAL', async () => {
    const approvalMandate: ProjectMandate = {
      ...baseMandate,
      humanApprovalRequiredOperations: ['CREATE_CORRECTIVE_TASK'],
    };
    await saveTestMandate(approvalMandate);
    const envelope = createMockEnvelope('CREATE_CORRECTIVE_TASK', {
      parentTaskId: 'task-1',
      failedTaskId: 'task-1',
      failureReason: 'Build failed',
      remediationType: 'CODE_FIX',
      correctivePlan: 'Fix syntax error',
    });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_REQUIRES_HUMAN_APPROVAL'));
  });

  it('T19 — caller cannot self-approve', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      selfApproved: true,
      hasImplementationAuthority: true,
    });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  it('T20 — Director cannot spoof trusted human', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      isTrustedHumanAuth: true,
      authStatus: 'VERIFIED_HUMAN',
      actor: 'USER',
    });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  // ==========================================================================
  // SECTION 5: Auto-Executable Task Classes (T21 - T24)
  // ==========================================================================

  it('T21 — authorized auto task class can proceed', async () => {
    await saveTestMandate({
      ...baseMandate,
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
    });

    await specStore.saveTasks([
      {
        task_id: 'task-1',
        parent_feature_id: 'feat-1',
        title: 'Core feature',
        description: 'Implement core logic',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptanceCriteria: ['AC1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'IMPLEMENTATION' },
      } as any,
    ]);

    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
  });

  it('T22 — unauthorized task class cannot proceed', async () => {
    await saveTestMandate({
      ...baseMandate,
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
    });

    await specStore.saveTasks([
      {
        task_id: 'task-doc-1',
        parent_feature_id: 'feat-1',
        title: 'Documentation task',
        description: 'Write developer docs',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptanceCriteria: ['AC1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'LOW',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'DOCS' },
      } as any,
    ]);

    const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-doc-1' });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('TASK_CLASS_NOT_AUTO_EXECUTABLE'));
  });

  it('T23 — caller cannot spoof task class', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskClass: 'IMPLEMENTATION',
      autoExecutable: true,
    });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  it('T24 — autoExecutableTaskClasses does not grant unrestricted authority', async () => {
    // Task class is auto-executable, but FILE_MODIFY is explicitly forbidden
    await saveTestMandate({
      ...baseMandate,
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
      forbiddenOperations: ['FILE_MODIFY'],
    });

    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));
  });

  // ==========================================================================
  // SECTION 6: REVIEW_EVIDENCE Authorization & Integrity (T25 - T29)
  // ==========================================================================

  it('T25 — valid SystemExecutionEvidence reference', async () => {
    await saveTestMandate(baseMandate);
    const evidence = createValidEvidence({
      evidenceId: 'evi-valid-01',
      taskId: 'task-1',
      projectId: validProjectId,
      verificationDecision: 'ACCEPT',
    });
    await evidenceStore.saveEvidence(evidence);

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-1',
      evidenceIds: ['evi-valid-01'],
      verdict: 'VERIFIED_SUCCESS',
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
  });

  it('T26 — missing evidence -> fail closed', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-1',
      evidenceIds: ['evi-phantom-nonexistent'],
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('INVALID_EVIDENCE_REFERENCE'));
  });

  it('T27 — cross-project evidence -> DENY', async () => {
    await saveTestMandate(baseMandate);
    const alienEvidence = createValidEvidence({
      evidenceId: 'evi-alien-01',
      projectId: 'other-alien-project',
      taskId: 'task-1',
    });
    await evidenceStore.saveEvidence(alienEvidence);

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-1',
      evidenceIds: ['evi-alien-01'],
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('PROJECT_ISOLATION_VIOLATION'));
  });

  it('T28 — wrong task evidence -> DENY', async () => {
    await saveTestMandate(baseMandate);
    const task2Evidence = createValidEvidence({
      evidenceId: 'evi-task2-01',
      taskId: 'task-2-different',
      projectId: validProjectId,
    });
    await evidenceStore.saveEvidence(task2Evidence);

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-1', // Evaluating task-1 with task-2's evidence
      evidenceIds: ['evi-task2-01'],
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EVIDENCE_TASK_MISMATCH'));
  });

  it('T29 — caller payload cannot replace SystemExecutionEvidence', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-1',
      evidenceIds: ['evi-valid-01'],
      syntheticEvidence: { fake: true },
      isSystemVerified: true,
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  // ==========================================================================
  // SECTION 7: Audit Decision Recording (T30 - T33)
  // ==========================================================================

  it('T30 — authorization decision persisted', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    await engine.evaluateAction(envelope);

    const events = await historyManager.readEvents();
    const authEvent = events.find((e) => e.eventType === 'AUTHORIZATION_POLICY_DECISION');
    assert.ok(authEvent);
    assert.equal((authEvent.payload as any).decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.equal((authEvent.payload as any).actionId, envelope.actionId);
  });

  it('T31 — mandate revision persisted in audit', async () => {
    await saveTestMandate({ ...baseMandate, mandateRevision: 4 });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    await engine.evaluateAction(envelope);

    const events = await historyManager.readEvents();
    const authEvent = events.find((e) => e.eventType === 'AUTHORIZATION_POLICY_DECISION');
    assert.ok(authEvent);
    assert.equal((authEvent.payload as any).mandateRevision, 4);
  });

  it('T32 — policy version persisted in audit', async () => {
    await saveTestMandate({ ...baseMandate, policyVersion: 3 });
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    await engine.evaluateAction(envelope);

    const events = await historyManager.readEvents();
    const authEvent = events.find((e) => e.eventType === 'AUTHORIZATION_POLICY_DECISION');
    assert.ok(authEvent);
    assert.equal((authEvent.payload as any).policyVersion, 3);
  });

  it('T33 — spoofed credentials never persisted', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      secretToken: 'super-secret-password-1234',
      bearerCredential: 'raw-token-abcdef',
      isTrustedHumanAuth: true,
    });
    await engine.evaluateAction(envelope);

    const events = await historyManager.readEvents();
    const authEvent = events.find((e) => e.eventType === 'AUTHORIZATION_POLICY_DECISION');
    assert.ok(authEvent);
    const serialized = JSON.stringify(authEvent.payload);
    assert.strictEqual(serialized.includes('super-secret-password-1234'), false);
    assert.strictEqual(serialized.includes('raw-token-abcdef'), false);
  });

  // ==========================================================================
  // SECTION 8: Regression and Security Invariants (T34 - T38)
  // ==========================================================================

  it('T34 — P31 authoritative snapshot remains mandatory', async () => {
    await saveTestMandate(baseMandate);
    const dispatcher = new DirectorActionDispatcher({
      historyManager,
      authorizationPolicyEngine: engine,
    });

    const envelope = createMockEnvelope('IMPLEMENT_TASK');

    // Stale snapshot logicalFingerprint
    const staleSnapshot = {
      projectId: validProjectId,
      directorSessionId: 'session-p32',
      logicalFingerprint: 'ctx-stale-other-fp',
      sectionMetadata: { requirements: { revision: 1 } },
      sections: {
        taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
        authorization: { isDevelopmentAuthorized: true },
        evidence: { items: [] },
      },
    } as any;

    const result = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot: staleSnapshot,
    });

    assert.equal(result.status, ActionDispatchStatus.REJECTED);
    assert.equal(result.code, 'ERR_DIRECTOR_ACTION_STALE_CONTEXT');
  });

  it('T35 — MCP cannot bypass authorization', async () => {
    // Mandate is not signed / missing
    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.notEqual(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);
  });

  it('T36 — execution bridge performs independent authorization', async () => {
    await saveTestMandate(baseMandate);

    const bridge = new ExecutionBridge({
      workspaceRoot: testDir,
      authorizationPolicyEngine: engine,
      evidenceStore,
      specStore,
    });

    const intent: BridgeExecutionIntent = {
      executionIntentId: 'intent-p32-01',
      actionId: 'act-p32-01',
      idempotencyKey: 'idem-p32-01',
      projectId: validProjectId,
      directorSessionId: 'session-p32',
      taskId: 'task-1',
      taskRevision: 1,
      basedOnContextFingerprint: 'ctx-p32-fp',
      understandingRevision: 1,
      authorizationReference: {
        packageRevision: 1,
        isDevelopmentAuthorized: true,
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Implement core functionality in src/index.ts',
    };

    const result = await bridge.validatePreconditions(intent);
    const check10 = result.allChecks.find((c) => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
    assert.ok(check10);
    assert.equal(check10?.passed, true);
  });

  it('T37 — unknown action defaults DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('UNREGISTERED_SYSTEM_CALL' as any);
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('UNKNOWN_OPERATION_DENIED'));
  });

  it('T38 — no hidden autonomous continuation', async () => {
    // Mandate policy rejection must halt cleanly without setting autoContinue or starting loops
    const forbiddenMandate: ProjectMandate = {
      ...baseMandate,
      forbiddenOperations: ['IMPLEMENT_TASK'],
    };
    await saveTestMandate(forbiddenMandate);

    const envelope = createMockEnvelope('IMPLEMENT_TASK');
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);

    const dispatcher = new DirectorActionDispatcher({
      historyManager,
      authorizationPolicyEngine: engine,
    });

    const snapshot = {
      projectId: validProjectId,
      directorSessionId: 'session-p32',
      logicalFingerprint: 'ctx-p32-fp',
      sectionMetadata: { requirements: { revision: 1 } },
      sections: {
        taskList: { tasks: [{ taskId: 'task-1', status: 'READY', dependencies: [] }] },
        authorization: { isDevelopmentAuthorized: true },
        evidence: { items: [] },
      },
    } as any;

    const result = await dispatcher.dispatch({
      validatedResult: { success: true, envelope } as any,
      snapshot,
    });

    assert.equal(result.status, ActionDispatchStatus.REJECTED);
    assert.equal(result.code, 'ERR_POLICY_ENGINE_DENIED');
    assert.equal((result as any).autoContinue, undefined);
  });

  // ==========================================================================
  // SECTION 9: P32-FIX — Authorization Fail-Closed Hardening (T33 - T46)
  // ==========================================================================
  describe('P32-FIX — Authorization Fail-Closed Hardening', () => {
    it('T33 — REVIEW_EVIDENCE + missing EvidenceStore -> DENY (AUTHORITATIVE_EVIDENCE_STORE_REQUIRED)', async () => {
      await saveTestMandate(baseMandate);
      const engineWithoutEvidenceStore = new AuthorizationPolicyEngine({
        historyManager,
        mandateStore,
        specStore,
        evidenceStore: null,
      });

      const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
        taskId: 'task-1',
        evidenceIds: ['evi-valid-01'],
      });

      const decision = await engineWithoutEvidenceStore.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_EVIDENCE_STORE_REQUIRED'));
    });

    it('T34 — REVIEW_EVIDENCE + EvidenceStore var + evidence missing -> DENY (INVALID_EVIDENCE_REFERENCE)', async () => {
      await saveTestMandate(baseMandate);
      const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
        taskId: 'task-1',
        evidenceIds: ['evi-missing-from-store'],
      });

      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('INVALID_EVIDENCE_REFERENCE'));
    });

    it('T35 — REVIEW_EVIDENCE + cross-project evidence -> DENY (PROJECT_ISOLATION_VIOLATION)', async () => {
      await saveTestMandate(baseMandate);
      const foreignEvidence = createValidEvidence({
        evidenceId: 'evi-foreign-project-01',
        projectId: 'other-foreign-project',
        taskId: 'task-1',
      });
      await evidenceStore.saveEvidence(foreignEvidence);

      const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
        taskId: 'task-1',
        evidenceIds: ['evi-foreign-project-01'],
      });

      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('PROJECT_ISOLATION_VIOLATION'));
    });

    it('T36 — REVIEW_EVIDENCE + task mismatch -> DENY (EVIDENCE_TASK_MISMATCH)', async () => {
      await saveTestMandate(baseMandate);
      const mismatchEvidence = createValidEvidence({
        evidenceId: 'evi-mismatch-task-01',
        projectId: validProjectId,
        taskId: 'task-other-99',
      });
      await evidenceStore.saveEvidence(mismatchEvidence);

      const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
        taskId: 'task-1',
        evidenceIds: ['evi-mismatch-task-01'],
      });

      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('EVIDENCE_TASK_MISMATCH'));
    });

    it('T37 — REVIEW_EVIDENCE + unverified evidence -> DENY (UNVERIFIED_EVIDENCE_REJECTED)', async () => {
      await saveTestMandate(baseMandate);
      const unverifiedEvidenceStore = {
        loadEvidence: async (id: string) => ({
          evidenceId: id,
          projectId: validProjectId,
          taskId: 'task-1',
          taskRevision: 1,
          verificationDecision: 'UNVERIFIED' as any,
          isSystemVerified: false,
        }),
      } as unknown as SystemExecutionEvidenceStore;

      const engineWithUnverified = new AuthorizationPolicyEngine({
        historyManager,
        mandateStore,
        specStore,
        evidenceStore: unverifiedEvidenceStore,
      });

      const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
        taskId: 'task-1',
        evidenceIds: ['evi-unverified-01'],
      });

      const decision = await engineWithUnverified.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('UNVERIFIED_EVIDENCE_REJECTED'));
    });

    it('T38 — IMPLEMENT_TASK + missing SpecStore -> DENY (AUTHORITATIVE_TASK_STORE_REQUIRED)', async () => {
      await saveTestMandate(baseMandate);
      const engineWithoutSpecStore = new AuthorizationPolicyEngine({
        historyManager,
        mandateStore,
        evidenceStore,
        specStore: null,
      });

      const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-1' });
      const decision = await engineWithoutSpecStore.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_STORE_REQUIRED'));
    });

    it('T39 — IMPLEMENT_TASK + missing taskId -> DENY (AUTHORITATIVE_TASK_LOOKUP_FAILED)', async () => {
      await saveTestMandate(baseMandate);
      const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: '' });
      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_LOOKUP_FAILED'));
    });

    it('T40 — IMPLEMENT_TASK + task not found -> DENY (AUTHORITATIVE_TASK_LOOKUP_FAILED)', async () => {
      await saveTestMandate(baseMandate);
      const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-does-not-exist-in-store' });
      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_LOOKUP_FAILED'));
    });

    it('T41 — IMPLEMENT_TASK + SpecStore throws -> DENY (AUTHORITATIVE_TASK_LOOKUP_FAILED)', async () => {
      await saveTestMandate(baseMandate);
      const throwingSpecStore = {
        loadTasks: async () => {
          throw new Error('Disk IO failure reading tasks.json');
        },
      } as unknown as SpecStore;

      const engineWithThrowingSpec = new AuthorizationPolicyEngine({
        historyManager,
        mandateStore,
        specStore: throwingSpecStore,
        evidenceStore,
      });

      const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-1' });
      const decision = await engineWithThrowingSpec.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_LOOKUP_FAILED'));
    });

    it('T42 — IMPLEMENT_TASK + task class not permitted -> DENY (TASK_CLASS_NOT_AUTO_EXECUTABLE)', async () => {
      await saveTestMandate({
        ...baseMandate,
        autoExecutableTaskClasses: ['IMPLEMENTATION'],
      });

      await specStore.saveTasks([
        {
          task_id: 'task-unpermitted-class',
          parent_feature_id: 'feat-1',
          title: 'Manual review task',
          description: 'Requires human manual review',
          traceability_sources: ['REQ-01'],
          dependencies: [],
          acceptanceCriteria: ['AC1'],
          status: 'READY',
          attempt: 0,
          max_attempts: 3,
          priority: 'LOW',
          risk_level: 'SAFE',
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          metadata: { taskClass: 'MANUAL_REVIEW' },
        } as any,
      ]);

      const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-unpermitted-class' });
      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('TASK_CLASS_NOT_AUTO_EXECUTABLE'));
    });

    it('T43 — Valid task + valid mandate + valid operation permissions -> ALLOW', async () => {
      await saveTestMandate(baseMandate);
      const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-1' });
      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
      assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
    });

    it('T44 — Execution intent + missing SpecStore -> DENY (ExecutionBridge/Executor unreachable)', async () => {
      await saveTestMandate(baseMandate);
      const engineWithoutSpecStore = new AuthorizationPolicyEngine({
        historyManager,
        mandateStore,
        evidenceStore,
        specStore: null,
      });

      const intent: BridgeExecutionIntent = {
        executionIntentId: 'intent-fail-no-spec',
        actionId: 'act-test-01',
        idempotencyKey: 'idem-test-01',
        projectId: validProjectId,
        directorSessionId: 'session-p32',
        taskId: 'task-1',
        taskRevision: 1,
        basedOnContextFingerprint: 'ctx-p32-fp',
        understandingRevision: 1,
        authorizationReference: {
          packageRevision: 1,
          isDevelopmentAuthorized: true,
        },
        createdAt: new Date().toISOString(),
        executionPlan: 'Implement core functionality in src/index.ts',
      };

      const decision = await engineWithoutSpecStore.evaluateExecutionIntent(intent);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_STORE_REQUIRED'));

      // Verify ExecutionBridge rejects and halts before Executor
      const bridge = new ExecutionBridge({
        workspaceRoot: testDir,
        authorizationPolicyEngine: engineWithoutSpecStore,
        evidenceStore,
      });

      const preResult = await bridge.validatePreconditions(intent);
      assert.equal(preResult.isValid, false);
      const check10 = preResult.allChecks.find((c) => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
      assert.ok(check10);
      assert.equal(check10?.passed, false);
    });

    it('T45 — Execution intent + task lookup failure -> DENY (Executor unreachable)', async () => {
      await saveTestMandate(baseMandate);
      const intent: BridgeExecutionIntent = {
        executionIntentId: 'intent-fail-task-lookup',
        actionId: 'act-test-02',
        idempotencyKey: 'idem-test-02',
        projectId: validProjectId,
        directorSessionId: 'session-p32',
        taskId: 'task-non-existent-999',
        taskRevision: 1,
        basedOnContextFingerprint: 'ctx-p32-fp',
        understandingRevision: 1,
        authorizationReference: {
          packageRevision: 1,
          isDevelopmentAuthorized: true,
        },
        createdAt: new Date().toISOString(),
        executionPlan: 'Implement core functionality in src/index.ts',
      };

      const decision = await engine.evaluateExecutionIntent(intent);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
      assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_LOOKUP_FAILED'));

      // Verify ExecutionBridge rejects and halts before Executor
      const bridge = new ExecutionBridge({
        workspaceRoot: testDir,
        authorizationPolicyEngine: engine,
        evidenceStore,
        specStore,
      });

      const preResult = await bridge.validatePreconditions(intent);
      assert.equal(preResult.isValid, false);
      const check10 = preResult.allChecks.find((c) => c.checkName === '10_POLICY_ENGINE_AUTHORIZATION');
      assert.ok(check10);
      assert.equal(check10?.passed, false);
    });

    it('T46 — Valid REVIEW_EVIDENCE + authoritative evidence -> ALLOW', async () => {
      await saveTestMandate(baseMandate);
      const validEvidence = createValidEvidence({
        evidenceId: 'evi-authoritative-p32-46',
        taskId: 'task-1',
        projectId: validProjectId,
        verificationDecision: 'ACCEPT',
      });
      await evidenceStore.saveEvidence(validEvidence);

      const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
        taskId: 'task-1',
        evidenceIds: ['evi-authoritative-p32-46'],
      });

      const decision = await engine.evaluateAction(envelope);
      assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
      assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
    });
  });
});
