import { describe, it, beforeEach, afterEach } from 'node:test';
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
  type DirectorActionType,
  type BridgeExecutionIntent,
  type SystemExecutionEvidence,
  IdentityManager,
} from '../dist/index.js';

describe('P34 — Authorization Fail-Closed Gap Closure', () => {
  let engine: AuthorizationPolicyEngine;
  let mandateStore: ProjectMandateStore;
  let historyManager: HistoryManager;
  let identityManager: IdentityManager;
  let specStore: SpecStore;
  let evidenceStore: SystemExecutionEvidenceStore;
  let testDir: string;
  let runCount = 0;

  const validProjectId = 'p34-fail-closed-project';

  const baseMandate: ProjectMandate = {
    projectId: validProjectId,
    allowedDirectories: ['src/'],
    allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'BUILD_EXECUTION', 'READ_ONLY_INSPECTION', 'EVIDENCE_REVIEW', 'REVIEW_EVIDENCE'],
    allowedCommandCategories: ['test', 'build', 'lint', 'format'],
    autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
    forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE', 'FORBIDDEN_CUSTOM_OP'],
    humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION', 'HIGH_RISK_OP'],
    authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
    authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
    resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
    policyVersion: 1,
    mandateRevision: 1,
  };

  const createMockEnvelope = (
    actionType: DirectorActionType,
    payloadOverrides: Record<string, unknown> = {},
    projectId = validProjectId,
    directorSessionId = 'session-p34',
    fingerprint = 'ctx-p34-fp'
  ): DirectorActionEnvelope => ({
    protocolVersion: 'P19-01',
    schemaVersion: 1,
    actionId: `act-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    directorSessionId,
    projectId,
    actionType,
    actor: 'DIRECTOR',
    actorRole: 'DIRECTOR',
    timestamp: new Date().toISOString(),
    basedOnContextFingerprint: fingerprint,
    understandingRevision: 1,
    payload: {
      taskId: 'task-with-class',
      ...payloadOverrides,
    },
  });

  const createValidEvidence = (overrides: Partial<SystemExecutionEvidence> = {}): SystemExecutionEvidence => {
    return {
      evidenceId: overrides.evidenceId ?? `evi_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      requestId: 'req_test_p34',
      taskId: 'task-with-class',
      taskRevision: 1,
      projectId: validProjectId,
      verificationDecision: 'ACCEPT',
      verifiedAt: new Date().toISOString(),
      contextFingerprint: 'ctx-p34-fp',
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
  };

  async function saveTestMandate(mandate: ProjectMandate, authOverrides: any = {}) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-p34',
      projectId: mandate.projectId,
      instanceId: 'inst-p34',
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
    testDir = path.join(process.cwd(), `.test-p34-${runCount}-${Date.now()}`);
    await fs.promises.mkdir(testDir, { recursive: true });
    historyManager = new HistoryManager({ baseDir: testDir });
    mandateStore = new ProjectMandateStore({ baseDir: testDir });
    specStore = new SpecStore({ baseDir: testDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: testDir });
    identityManager = new IdentityManager({ baseDir: testDir });

    engine = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore,
    });

    // Seed authoritative tasks in SpecStore
    await specStore.saveTasks([
      {
        task_id: 'task-with-class',
        parent_feature_id: 'feat-1',
        title: 'Task With Class',
        description: 'Implement feature with explicit taskClass',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptance_criteria: ['AC1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'IMPLEMENTATION', targetFiles: ['src/index.ts'], revision: 1 },
      },
      {
        task_id: 'task-without-class',
        parent_feature_id: 'feat-1',
        title: 'Task Without Class',
        description: 'Task having no authoritative taskClass',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptance_criteria: ['AC1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'MEDIUM',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { targetFiles: ['src/other.ts'], revision: 1 },
      },
      {
        task_id: 'task-unknown-state',
        parent_feature_id: 'feat-1',
        title: 'Task With Unknown State',
        description: 'Task whose state or taskClass is indeterminate',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptance_criteria: ['AC1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'LOW',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { taskClass: 'UNKNOWN', revision: 1 },
      },
    ]);
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // T01 — REVIEW_EVIDENCE without EvidenceStore -> DENY (AUTHORITATIVE_EVIDENCE_STORE_REQUIRED)
  it('T01 — REVIEW_EVIDENCE without EvidenceStore fails closed with DENY', async () => {
    await saveTestMandate(baseMandate);
    const engineNoEvidenceStore = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore: null,
    });

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-with-class',
      evidenceIds: ['evi-valid-01'],
    });

    const decision = await engineNoEvidenceStore.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_EVIDENCE_STORE_REQUIRED'));
  });

  // T02 — REVIEW_EVIDENCE with invalid/missing authoritative evidence -> DENY
  it('T02 — REVIEW_EVIDENCE with missing authoritative evidence fails closed with DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-with-class',
      evidenceIds: ['evi-non-existent-999'],
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('INVALID_EVIDENCE_REFERENCE'));
  });

  // T03 — REVIEW_EVIDENCE with valid evidence -> ALLOW
  it('T03 — REVIEW_EVIDENCE with valid authoritative evidence produces ALLOW', async () => {
    await saveTestMandate(baseMandate);
    const validEvidence = createValidEvidence({
      evidenceId: 'evi-valid-p34-03',
      taskId: 'task-with-class',
      verificationDecision: 'ACCEPT',
    });
    await evidenceStore.saveEvidence(validEvidence);

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-with-class',
      evidenceIds: ['evi-valid-p34-03'],
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
  });

  // T04 — Execution without SpecStore -> DENY
  it('T04 — Execution without SpecStore fails closed with DENY', async () => {
    await saveTestMandate(baseMandate);
    const engineNoSpecStore = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      evidenceStore,
      specStore: null,
    });

    const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-with-class' });
    const decision = await engineNoSpecStore.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_STORE_REQUIRED'));
  });

  // T05 — Execution with missing task -> DENY
  it('T05 — Execution with missing task fails closed with DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-does-not-exist-xyz' });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_LOOKUP_FAILED'));
  });

  // T06 — Execution with missing taskClass -> DENY
  it('T06 — Execution with missing taskClass fails closed with DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-without-class' });
    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_CLASS_UNRESOLVED'));
  });

  // T07 — Caller tries to inject taskClass -> DENY
  it('T07 — Caller trying to inject taskClass is rejected with DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-without-class',
      taskClass: 'IMPLEMENTATION',
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  // T08 — Default IMPLEMENTATION fallback -> DENY
  it('T08 — System does not fall back to default IMPLEMENTATION and fails closed', async () => {
    await saveTestMandate(baseMandate);
    // Task has no taskClass; verify system does not silently assume IMPLEMENTATION
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-without-class' });
    const decision = await engine.evaluateAction(envelope);
    assert.notEqual(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_CLASS_UNRESOLVED'));

    // Also verify for execution intent
    const intent: BridgeExecutionIntent = {
      executionIntentId: 'intent-t08-fallback',
      actionId: 'act-t08',
      idempotencyKey: 'idem-t08',
      projectId: validProjectId,
      directorSessionId: 'session-p34',
      taskId: 'task-without-class',
      taskRevision: 1,
      basedOnContextFingerprint: 'ctx-p34-fp',
      understandingRevision: 1,
      authorizationReference: {
        packageRevision: 1,
        isDevelopmentAuthorized: true,
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Implement core functionality in src/index.ts',
    };

    const intentDecision = await engine.evaluateExecutionIntent(intent);
    assert.notEqual(intentDecision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.equal(intentDecision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(intentDecision.appliedRules.includes('AUTHORITATIVE_TASK_CLASS_UNRESOLVED'));
  });

  // T09 — Forbidden operation precedence -> DENY
  it('T09 — Forbidden operation takes precedence over allowedOperationTypes', async () => {
    await saveTestMandate({
      ...baseMandate,
      allowedOperationTypes: ['FILE_MODIFY', 'FORBIDDEN_CUSTOM_OP'],
      forbiddenOperations: ['FORBIDDEN_CUSTOM_OP'],
    });

    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-with-class',
      operationType: 'FORBIDDEN_CUSTOM_OP',
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));
  });

  // T10 — Human approval precedence -> REQUIRE_HUMAN_APPROVAL
  it('T10 — Human approval required operation takes precedence over automatic ALLOW', async () => {
    await saveTestMandate({
      ...baseMandate,
      allowedOperationTypes: ['FILE_MODIFY', 'HIGH_RISK_OP'],
      humanApprovalRequiredOperations: ['HIGH_RISK_OP'],
    });

    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-with-class',
      operationType: 'HIGH_RISK_OP',
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_REQUIRES_HUMAN_APPROVAL'));
  });

  // T11 — Stale mandate -> DENY
  it('T11 — Stale expected mandate revision is rejected with DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-with-class',
      expectedMandateRevision: 999, // actual is 1
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('MANDATE_REVISION_MISMATCH'));
  });

  // T12 — Actor/role spoofing -> DENY
  it('T12 — Actor or role spoofing is rejected fail-closed with DENY', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-with-class',
      actor: 'USER',
      actorRole: 'PRODUCT_OWNER',
      isTrustedHumanAuth: true,
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  // T13 — Evidence provenance -> DENY
  it('T13 — Evidence provided directly by caller/executor cannot bypass authoritative EvidenceStore', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-with-class',
      evidenceIds: ['evi-inline-fake'],
      evidence: {
        evidenceId: 'evi-inline-fake',
        isSystemVerified: true,
        verificationDecision: 'ACCEPT',
      },
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(
      decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION') ||
      decision.appliedRules.includes('INVALID_EVIDENCE_REFERENCE')
    );
  });

  // T14 — Spec provenance -> DENY
  it('T14 — Director/LLM supplied taskClass cannot override authoritative SpecStore', async () => {
    await saveTestMandate(baseMandate);
    // Task in specStore has no taskClass; caller attempts to supply taskCategory
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-without-class',
      taskCategory: 'IMPLEMENTATION',
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  // T15 — Unknown dependency state -> DENY
  it('T15 — Indeterminate or UNKNOWN authoritative dependency state fails closed with DENY', async () => {
    await saveTestMandate(baseMandate);

    // Case A: Task has UNKNOWN state in SpecStore
    const taskEnvelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-unknown-state',
    });
    const taskDecision = await engine.evaluateAction(taskEnvelope);
    assert.equal(taskDecision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(taskDecision.appliedRules.includes('UNKNOWN_DEPENDENCY_STATE_DENIED'));

    // Case B: Evidence in EvidenceStore has UNKNOWN verification status
    const unknownEvidenceStore = {
      loadEvidence: async (id: string) => ({
        evidenceId: id,
        projectId: validProjectId,
        taskId: 'task-with-class',
        taskRevision: 1,
        verificationDecision: 'UNKNOWN' as any,
        isSystemVerified: true,
      }),
    } as unknown as SystemExecutionEvidenceStore;

    const engineWithUnknownEvidence = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore: unknownEvidenceStore,
    });

    const evidenceEnvelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-with-class',
      evidenceIds: ['evi-unknown-decision'],
    });

    const evidenceDecision = await engineWithUnknownEvidence.evaluateAction(evidenceEnvelope);
    assert.equal(evidenceDecision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(
      evidenceDecision.appliedRules.includes('UNKNOWN_DEPENDENCY_STATE_DENIED') ||
      evidenceDecision.appliedRules.includes('UNVERIFIED_EVIDENCE_REJECTED')
    );
  });

  // T16 — Valid execution -> ALLOW
  it('T16 — Valid execution with authoritatively resolved task and taskClass produces ALLOW', async () => {
    await saveTestMandate(baseMandate);
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-with-class',
    });

    const decision = await engine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(decision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));

    // Verify execution intent also succeeds
    const intent: BridgeExecutionIntent = {
      executionIntentId: 'intent-t16-valid',
      actionId: 'act-t16',
      idempotencyKey: 'idem-t16',
      projectId: validProjectId,
      directorSessionId: 'session-p34',
      taskId: 'task-with-class',
      taskRevision: 1,
      basedOnContextFingerprint: 'ctx-p34-fp',
      understandingRevision: 1,
      authorizationReference: {
        packageRevision: 1,
        isDevelopmentAuthorized: true,
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Implement core functionality in src/index.ts',
    };

    const intentDecision = await engine.evaluateExecutionIntent(intent);
    assert.equal(intentDecision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(intentDecision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));
  });
});
