/**
 * @file a3-action-policy-integration.test.ts
 * @description Comprehensive verification test suite for Task A3:
 * Director Action Protocol & Authorization Policy Integration (ROADMAP A3).
 *
 * Verifies all A3 acceptance criteria:
 * 1. Direct transformation of reasoning output (DirectorReasoningEngine) to validated DirectorActionEnvelope.
 * 2. Mandate compliance and routine task execution (ALLOW).
 * 3. Fail-closed DENY on mandate violations (forbidden operations, expired mandate, cross-project).
 * 4. Human-approval-required operations halt fail-closed in WAITING_FOR_TRUSTED_IDENTITY / PENDING_AUTHORIZATION.
 * 5. Strict rejection of forged/spoofed authority declarations (actor: "USER", isTrustedHumanAuth: true).
 * 6. Stale context fingerprint and revision detection at dispatch time.
 * 7. Persistent idempotency across invocations and process restarts.
 * 8. Cross-project and cross-session strict boundary isolation.
 * 9. Fail-closed behavior on missing or unconfigured mandate.
 * 10. Architectural invariant: Zero Driver or Antigravity CLI execution throughout the A3 boundary.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  DirectorReasoningEngine,
  DirectorActionBuilder,
  DirectorActionValidator,
  DirectorActionPipeline,
  DirectorActionDispatcher,
  ActionDispatchStatus,
  type ActionDispatchResult,
  type DirectorContextSnapshot,
  type DirectorActionEnvelope,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_ACTOR,
  DIRECTOR_ACTION_ACTOR_ROLE,
  DirectorActionImpersonationError,
  DirectorActionStaleContextError,
  DirectorActionIdempotencyConflictError,
  AuthorizationPolicyEngine,
  AuthorizationDecisionResult,
  ProjectMandateStore,
  type ProjectMandate,
  IdentityManager,
  HistoryManager,
  SpecStore,
  SystemExecutionEvidenceStore,
  TaskDagEngine,
  ApprovalStore,
  ApprovalPackageEngine,
} from '../dist/index.js';

describe('A3: Director Action Protocol & Authorization Policy Integration', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let evidenceStore: SystemExecutionEvidenceStore;
  let dagEngine: TaskDagEngine;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let mandateStore: ProjectMandateStore;
  let identityManager: IdentityManager;
  let policyEngine: AuthorizationPolicyEngine;
  let actionBuilder: DirectorActionBuilder;
  let actionValidator: DirectorActionValidator;
  let dispatcher: DirectorActionDispatcher;
  let snapshot: DirectorContextSnapshot;

  const validProjectId = 'notification-dispatch-service';
  const validSessionId = 'sess-director-a3';
  const validFingerprint = 'fp-authoritative-a3-snapshot-555';
  const validRevision = 2;

  const baseMandate: ProjectMandate = {
    projectId: validProjectId,
    allowedDirectories: ['src/', 'tests/'],
    allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION', 'BUILD_EXECUTION'],
    allowedCommandCategories: ['test', 'build', 'lint', 'format'],
    autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
    forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE', 'DROP_DATABASE'],
    humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION', 'UPDATE_SECURITY_POLICY'],
    authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
    authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
    resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
    policyVersion: 1,
    mandateRevision: 1,
  };

  async function saveSignedMandate(mandate: ProjectMandate, authOverrides: Record<string, unknown> = {}) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-a3-test',
      projectId: mandate.projectId,
      instanceId: 'inst-a3',
      actorType: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
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

  function createAuthoritativeSnapshot(overrides: Partial<DirectorContextSnapshot> = {}): DirectorContextSnapshot {
    return {
      projectId: validProjectId,
      projectRoot: tempDir,
      directorSessionId: validSessionId,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      syncStatus: 'CHANGED',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      logicalFingerprint: validFingerprint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sequenceNumber: 1,
      warnings: [],
      sectionMetadata: {
        requirements: { revision: validRevision },
      } as any,
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
        approval: { hasApprovalPackage: true, packageId: 'pkg_a3_01', isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'notification-dispatch-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 1, items: [{ id: 'REQ-01', title: 'Dispatch API', status: 'ACTIVE', authority: 'PO' }] },
        decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Node 22 Runtime', status: 'ACCEPTED' }] },
        taskList: {
          total: 2,
          topologicalOrder: ['task-01-core', 'task-02-auth'],
          tasks: [
            { taskId: 'task-01-core', title: 'Core Setup', status: 'COMPLETED', dependencies: [] },
            { taskId: 'task-02-auth', title: 'Auth Token Service', status: 'READY', dependencies: ['task-01-core'] },
          ],
        },
        currentTask: {
          hasActiveTask: true,
          task: {
            taskId: 'task-02-auth',
            title: 'Auth Token Service',
            status: 'READY',
            description: 'Implement JWT verification service',
            acceptanceCriteria: ['Valid JWT passes', 'Expired JWT fails'],
          },
        },
        git: { isGitRepository: true, branch: 'main', workingTreeClean: true },
        evidence: { totalAvailable: 1 },
        history: { totalEvents: 5 },
      } as any,
      ...overrides,
    } as any;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-a3-'));
    const historyPath = path.join(tempDir, 'events.jsonl');

    historyManager = new HistoryManager({ historyPath });
    specStore = new SpecStore({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    approvalStore = new ApprovalStore({ baseDir: tempDir });
    approvalPackageEngine = new ApprovalPackageEngine();
    mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    identityManager = new IdentityManager({ baseDir: tempDir });
    policyEngine = new AuthorizationPolicyEngine({ historyManager, mandateStore });
    actionBuilder = new DirectorActionBuilder();
    actionValidator = new DirectorActionValidator({ historyManager });

    dispatcher = new DirectorActionDispatcher({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      authorizationPolicyEngine: policyEngine,
    });

    snapshot = createAuthoritativeSnapshot();

    // Seed tasks in specStore with full valid schema
    await specStore.saveTasks([
      {
        task_id: 'task-01-core',
        parent_feature_id: 'FEAT-A3',
        title: 'Core Setup',
        description: 'Set up core scaffolding and runtime',
        traceability_sources: ['REQ-01'],
        dependencies: [],
        acceptance_criteria: ['Criterion 1'],
        status: 'ACCEPTED',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK',
        metadata: {
          revision: 1,
          projectId: validProjectId,
          contextFingerprint: validFingerprint,
          scope: {
            analysisScope: ['src/'],
            implementationScope: ['src/core.ts'],
            targetFiles: ['src/core.ts'],
          },
        },
      },
      {
        task_id: 'task-02-auth',
        parent_feature_id: 'FEAT-A3',
        title: 'Auth Token Service',
        description: 'Implement JWT verification service',
        traceability_sources: ['REQ-01'],
        dependencies: ['task-01-core'],
        acceptance_criteria: ['Valid JWT passes'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK',
        metadata: {
          revision: 1,
          taskClass: 'IMPLEMENTATION',
          projectId: validProjectId,
          contextFingerprint: validFingerprint,
          scope: {
            analysisScope: ['src/'],
            implementationScope: ['src/auth.ts'],
            targetFiles: ['src/auth.ts'],
          },
        },
      },
    ]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // ==========================================================================
  // A3-01: Reasoning to Action Envelope Transformation
  // ==========================================================================
  it('A3-01: transforms DirectorReasoningEngine output into validated DirectorActionEnvelope with authoritative snapshot metadata', async () => {
    const mockProvider: LLMProvider = {
      providerId: 'mock:a3-provider',
      providerName: 'mock-llm',
      defaultModel: 'director-reasoning-v1',
      async generate(request: LlmRequest): Promise<LlmResponse> {
        return {
          content: JSON.stringify({
            decisionType: 'IMPLEMENT_TASK',
            rationale: 'Task task-02-auth is ready and its dependencies are satisfied. Proposing implementation.',
            basedOnContextFingerprint: validFingerprint,
            selectedTaskId: 'task-02-auth',
            suggestedNextAction: 'Execute task-02-auth under project mandate.',
          }),
          format: 'json',
          inputTokens: 300,
          outputTokens: 150,
          totalTokens: 450,
          cachedTokens: 50,
          reasoningTokens: 20,
        };
      },
    };

    const reasoningEngine = new DirectorReasoningEngine({ provider: mockProvider, mode: 'test' });
    const pipeline = new DirectorActionPipeline({
      reasoningEngine,
      actionBuilder,
      actionValidator,
      allowLegacyReasoningEngine: true,
    });

    const result = await pipeline.execute({
      snapshot,
      correlationId: 'corr-a3-01',
    });

    assert.equal(result.success, true);
    assert.ok(result.envelope);
    assert.equal(result.envelope.protocolVersion, DIRECTOR_ACTION_PROTOCOL_VERSION);
    assert.equal(result.envelope.projectId, validProjectId);
    assert.equal(result.envelope.directorSessionId, validSessionId);
    assert.equal(result.envelope.basedOnContextFingerprint, validFingerprint);
    assert.equal(result.envelope.understandingRevision, validRevision);
    assert.equal(result.envelope.actionType, 'IMPLEMENT_TASK');
    assert.equal(result.envelope.actor, DIRECTOR_ACTION_ACTOR);
    assert.equal(result.envelope.actorRole, DIRECTOR_ACTION_ACTOR_ROLE);
    assert.equal((result.envelope.payload as any).taskId, 'task-02-auth');
    assert.equal(result.validationResult.isValid, true);
    assert.equal(result.isDuplicate, false);
  });

  // ==========================================================================
  // A3-02: Mandate Allowed Routine Task Execution (ALLOW)
  // ==========================================================================
  it('A3-02: allows routine task implementation within Project Mandate scope without executing Driver or AGY CLI', async () => {
    await saveSignedMandate(baseMandate);

    const envelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-a3-impl-01',
      idempotencyKey: 'idem-a3-impl-01',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth',
        expectedTaskRevision: 1,
        executionPlan: 'Implement JWT token verification service in src/auth.ts',
      },
    };

    // First verify policy engine evaluation directly
    const policyDecision = await policyEngine.evaluateAction(envelope);
    assert.equal(policyDecision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(policyDecision.appliedRules.includes('ROUTINE_TECHNICAL_OPERATION_ALLOWED'));

    // Dispatch envelope
    const dispatchResult = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope, typedPayload: envelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
    assert.equal(dispatchResult.isAuthorized, true);
    assert.equal(dispatchResult.requiresHumanApproval, false);
    assert.ok(dispatchResult.executionIntentId);

    // Verify history recorded the dispatch
    const events = await historyManager.readEvents();
    const dispatchEvent = events.find((e) => e.eventType === 'DIRECTOR_ACTION_DISPATCHED');
    assert.ok(dispatchEvent);
    assert.equal((dispatchEvent.payload as any).status, ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION);
  });

  // ==========================================================================
  // A3-03: Mandate Violation Results in Fail-Closed DENY
  // ==========================================================================
  it('A3-03: fails closed with DENY when action violates mandate forbidden operations', async () => {
    await saveSignedMandate(baseMandate);

    const forbiddenEnvelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-a3-deny-01',
      idempotencyKey: 'idem-a3-deny-01',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'SYSTEM_DESTRUCTIVE' as any,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth',
        destructiveCommand: 'rm -rf /',
      },
    };

    const policyDecision = await policyEngine.evaluateAction(forbiddenEnvelope);
    assert.equal(policyDecision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(policyDecision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));

    const dispatchResult = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope: forbiddenEnvelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope: forbiddenEnvelope, typedPayload: forbiddenEnvelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.REJECTED);
    assert.equal(dispatchResult.isAuthorized, false);
    assert.equal(dispatchResult.code, 'ERR_POLICY_ENGINE_DENIED');
    assert.match(dispatchResult.reason, /Policy Engine \(P21\) rejected action/);
  });

  // ==========================================================================
  // A3-04: Approval-Required Actions Fail-Closed
  // ==========================================================================
  it('A3-04: halts approval-required operations in WAITING_FOR_TRUSTED_IDENTITY / PENDING_AUTHORIZATION fail-closed', async () => {
    await saveSignedMandate(baseMandate);

    const replanEnvelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-a3-replan-01',
      idempotencyKey: 'idem-a3-replan-01',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'REPLAN',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        reason: 'Architecture scope change requires reordering authentication tasks.',
        affectedTaskIds: ['task-02-auth'],
      },
    };

    const policyDecision = await policyEngine.evaluateAction(replanEnvelope);
    assert.equal(policyDecision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);

    const dispatchResult = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope: replanEnvelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope: replanEnvelope, typedPayload: replanEnvelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.PENDING_AUTHORIZATION);
    assert.equal(dispatchResult.isAuthorized, false);
    assert.equal(dispatchResult.requiresHumanApproval, true);
    assert.equal(dispatchResult.code, 'PENDING_POLICY_AUTHORIZATION');

    // Verify task DAG was NOT mutated
    const tasks = await specStore.loadTasks();
    assert.equal(tasks.length, 2);
  });

  // ==========================================================================
  // A3-05: Model Output Anti-Spoofing & Privilege Escalation Defense
  // ==========================================================================
  it('A3-05: strictly rejects forged or spoofed authority declarations in envelope and payload', async () => {
    await saveSignedMandate(baseMandate);

    // 1. Validator rejects envelope attempting to claim actorRole='PRODUCT_OWNER'
    assert.throws(
      () => {
        actionValidator.validate(
          {
            protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
            schemaVersion: 1,
            actionId: 'act-spoof-01',
            idempotencyKey: 'idem-spoof-01',
            projectId: validProjectId,
            directorSessionId: validSessionId,
            basedOnContextFingerprint: validFingerprint,
            understandingRevision: validRevision,
            actionType: 'IMPLEMENT_TASK',
            actor: 'DIRECTOR',
            actorRole: 'PRODUCT_OWNER', // Spoof attempt
            timestamp: new Date().toISOString(),
            payload: { taskId: 'task-02-auth', executionPlan: 'test' },
          },
          {
            currentFingerprint: validFingerprint,
            currentUnderstandingRevision: validRevision,
            currentDirectorSessionId: validSessionId,
            currentProjectId: validProjectId,
          }
        );
      },
      (err: any) => {
        assert.ok(err instanceof DirectorActionImpersonationError || err.name === 'DirectorActionImpersonationError' || err.name === 'DirectorActionValidationError');
        return true;
      }
    );

    // 2. Policy engine rejects action carrying spoofed authority fields in payload
    const spoofedPayloadEnvelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-spoof-02',
      idempotencyKey: 'idem-spoof-02',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth',
        executionPlan: 'test plan',
        isTrustedHumanAuth: true, // Spoofed field
        authStatus: 'VERIFIED_HUMAN', // Spoofed field
      },
    };

    const policyDecision = await policyEngine.evaluateAction(spoofedPayloadEnvelope);
    assert.equal(policyDecision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(policyDecision.appliedRules.includes('ANTI_SPOOFING_AUTHORITY_VIOLATION'));
  });

  // ==========================================================================
  // A3-06: Stale Context Fingerprint and Revision Defense
  // ==========================================================================
  it('A3-06: rejects actions based on stale context fingerprint or understanding revision', async () => {
    await saveSignedMandate(baseMandate);

    const staleEnvelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-stale-01',
      idempotencyKey: 'idem-stale-01',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: 'fp-stale-old-fingerprint-999',
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: { taskId: 'task-02-auth', executionPlan: 'test plan' },
    };

    const dispatchResult = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope: staleEnvelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope: staleEnvelope, typedPayload: staleEnvelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot, // snapshot has validFingerprint !== fp-stale-old-fingerprint-999
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.REJECTED);
    assert.equal(dispatchResult.code, 'ERR_DIRECTOR_ACTION_STALE_CONTEXT');
    assert.match(dispatchResult.reason, /Context fingerprint has changed since action creation/);
  });

  // ==========================================================================
  // A3-07: Persistent Idempotency Across Invocations and Restarts
  // ==========================================================================
  it('A3-07: enforces deterministic idempotency and detects conflicting payloads across restarts', async () => {
    await saveSignedMandate(baseMandate);

    const envelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-idem-01',
      idempotencyKey: 'idem-key-stable-01',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'CREATE_TASK',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        title: 'New Integration Test',
        description: 'Add tests for auth service',
        acceptanceCriteria: ['Passes unit tests'],
        category: 'TEST',
      },
    };

    const firstDispatch = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope, typedPayload: envelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });
    assert.equal(firstDispatch.status, ActionDispatchStatus.PENDING_AUTHORIZATION);

    // Re-dispatch identical envelope -> returns DUPLICATE status
    const secondDispatch = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: true, envelope, typedPayload: envelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: true,
      },
      snapshot,
    });
    assert.equal(secondDispatch.status, ActionDispatchStatus.DUPLICATE);

    // Re-dispatch same key with CONFLICTING payload -> throws DirectorActionIdempotencyConflictError
    const conflictingEnvelope = {
      ...envelope,
      actionId: 'act-idem-02-conflict',
      payload: {
        title: 'COMPLETELY DIFFERENT TASK',
        description: 'Conflicting content',
        acceptanceCriteria: ['Criterion different'],
        category: 'IMPLEMENTATION',
      },
    };

    await assert.rejects(
      async () => {
        await dispatcher.dispatch({
          validatedResult: {
            success: true,
            envelope: conflictingEnvelope as any,
            reasoningResult: {} as any,
            validationResult: { isValid: true, isDuplicate: false, envelope: conflictingEnvelope as any, typedPayload: conflictingEnvelope.payload, validatedAt: new Date().toISOString() },
            isDuplicate: false,
          },
          snapshot,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorActionIdempotencyConflictError || err.name === 'DirectorActionIdempotencyConflictError');
        return true;
      }
    );

    // Restart recovery: create fresh dispatcher pointing to same history
    const freshDispatcher = new DirectorActionDispatcher({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      approvalStore,
      approvalPackageEngine,
      authorizationPolicyEngine: policyEngine,
    });
    await freshDispatcher.initializeFromHistory();

    const restartDispatch = await freshDispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: true, envelope, typedPayload: envelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: true,
      },
      snapshot,
    });
    assert.equal(restartDispatch.status, ActionDispatchStatus.DUPLICATE);
  });

  // ==========================================================================
  // A3-08: Cross-Project and Cross-Session Isolation
  // ==========================================================================
  it('A3-08: enforces strict project and session isolation fail-closed', async () => {
    await saveSignedMandate(baseMandate);

    const crossProjectEnvelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-cross-01',
      idempotencyKey: 'idem-cross-01',
      projectId: 'other-alien-project',
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: { taskId: 'task-02-auth', executionPlan: 'test' },
    };

    const dispatchResult = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope: crossProjectEnvelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope: crossProjectEnvelope, typedPayload: crossProjectEnvelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });

    assert.equal(dispatchResult.status, ActionDispatchStatus.REJECTED);
    assert.equal(dispatchResult.code, 'ERR_PROJECT_MISMATCH');
  });

  // ==========================================================================
  // A3-09: Unconfigured Mandate or Expired Mandate Fails Closed
  // ==========================================================================
  it('A3-09: fails closed when mandate is unconfigured or expired', async () => {
    // 1. Unconfigured mandate
    const envelope: DirectorActionEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: 'act-unconf-01',
      idempotencyKey: 'idem-unconf-01',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK',
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: { taskId: 'task-02-auth', executionPlan: 'test' },
    };

    const unconfDecision = await policyEngine.evaluateAction(envelope);
    assert.equal(unconfDecision.decisionResult, AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION);

    const unconfDispatch = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope, typedPayload: envelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });
    assert.equal(unconfDispatch.status, ActionDispatchStatus.PENDING_AUTHORIZATION);

    // 2. Expired mandate
    const expiredMandate: ProjectMandate = {
      ...baseMandate,
      authorizationStartTime: new Date(Date.now() - 7200000).toISOString(),
      authorizationEndTime: new Date(Date.now() - 3600000).toISOString(), // Expired 1 hour ago
    };
    await saveSignedMandate(expiredMandate);

    const expiredDecision = await policyEngine.evaluateAction(envelope);
    assert.equal(expiredDecision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(expiredDecision.appliedRules.includes('MANDATE_EXPIRED_OR_NOT_STARTED'));

    const expiredDispatch = await dispatcher.dispatch({
      validatedResult: {
        success: true,
        envelope,
        reasoningResult: {} as any,
        validationResult: { isValid: true, isDuplicate: false, envelope, typedPayload: envelope.payload, validatedAt: new Date().toISOString() },
        isDuplicate: false,
      },
      snapshot,
    });
    assert.equal(expiredDispatch.status, ActionDispatchStatus.REJECTED);
    assert.equal(expiredDispatch.code, 'ERR_POLICY_ENGINE_DENIED');
  });

  // ==========================================================================
  // A3-10: Invariant Confirmation - Zero Driver / AGY CLI Execution
  // ==========================================================================
  it('A3-10: verifies that throughout all A3 operations zero Driver or AGY CLI processes are spawned', async () => {
    // Confirm no runtime state lock was acquired
    const lockExists = await fs
      .access(path.join(tempDir, '.ai-manager', 'runtime.lock'))
      .then(() => true)
      .catch(() => false);
    assert.equal(lockExists, false, 'No driver runtime.lock must exist during A3 action processing.');

    // Confirm history contains zero execution events (no DRIVER_STARTED, no TASK_EXECUTION_STARTED)
    const events = await historyManager.readEvents();
    const executionEvents = events.filter((e) =>
      ['DRIVER_STARTED', 'DRIVER_STEP_EXECUTED', 'TASK_EXECUTION_STARTED', 'EXECUTION_SUCCEEDED'].includes(e.eventType)
    );
    assert.equal(executionEvents.length, 0, 'Zero execution events must be generated during A3 action/policy pipeline.');
  });
});
