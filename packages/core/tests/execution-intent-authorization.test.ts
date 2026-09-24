/**
 * Comprehensive Test Suite for Phase 10 TASK-P10-01
 * Execution Intent Authorization Boundary
 *
 * Verifies all mandatory adversarial scenarios and protocol invariants:
 *
 * T01: Valid authorized execution intent → VALID
 * T02: Missing approval → APPROVAL_NOT_FOUND
 * T03: Unauthorized approval (isDevelopmentAuthorized() === false) → APPROVAL_NOT_AUTHORIZED
 * T04: Wrong project → PROJECT_BINDING_MISMATCH
 * T05: Wrong session → SESSION_INVALID
 * T06: Decision session mismatch → DECISION_SESSION_MISMATCH
 * T07: Invalid decision type → DECISION_TYPE_INVALID
 * T08: Task not found → TASK_NOT_FOUND
 * T09: Task not ready / dependencies unmet → TASK_STATE_INVALID
 * T10: Task revision mismatch → TASK_REVISION_MISMATCH
 * T11: Context fingerprint mismatch → CONTEXT_FINGERPRINT_MISMATCH
 * T12: Context stale → CONTEXT_STALE
 * T13: Context incomplete → CONTEXT_INCOMPLETE
 * T14: Understanding revision missing from session → UNDERSTANDING_REVISION_MISMATCH
 * T15: Understanding revision missing from intent → UNDERSTANDING_REVISION_MISMATCH
 * T16: Understanding revision value mismatch → UNDERSTANDING_REVISION_MISMATCH
 * T17: Approval revision mismatch → APPROVAL_REVISION_MISMATCH
 * T18: Inactive / closed session → SESSION_NOT_ACTIVE
 * T19: Director decision with hasImplementationAuthority !== false → SECURITY_VIOLATION
 * T20: Dry-run guarantee: no task mutation, no FSM mutation, no executor invocation
 * T21: MCP boundary tool validation
 * T22: Decision not found → DECISION_INVALID
 * T23: createExecutionIntent() success + audit history
 * T24: createExecutionIntent() failure + error hierarchy
 * T25: Approval actor role not PRODUCT_OWNER/USER → APPROVAL_INVALID
 * T26: Approval intent not EXPLICIT_APPROVAL → APPROVAL_INVALID
 * T27: Approval project mismatch → APPROVAL_PROJECT_MISMATCH
 * T28: Task BLOCKED status → TASK_STATE_INVALID
 * T29: Task with unmet dependency → TASK_STATE_INVALID
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  Actor,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorContextSynchronizer,
  DirectorDecisionStore,
  DirectorDecisionEngine,
  HumanApprovalEngine,
  ExecutionAuthorizer,
  type DirectorSession,
  type DirectorContextSnapshot,
  type DirectorDecision,
  type ProjectApprovalPackage,
  type ProjectDiscoveryReport,
  ApprovalStore,
  ApprovalPackageEngine,
  InitialProjectUnderstandingBuilder,
  isDevelopmentAuthorized,
  HistoryManager,
  DurableStateManager,
  SpecStore,
  TaskDagEngine,
  ContextEngine,
  DefaultGitPort,
  DefaultMcpOrchestratorDelegate,
  McpServer,
  InMemoryMcpTransport,
  AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME,
  registerExecutionIntentTools,
  EXECUTION_INTENT_PROTOCOL_VERSION,
  EXECUTION_INTENT_SCHEMA_VERSION,
  EXECUTION_OPERATION_TYPES,
  ExecutionIntentValidationError,
  ExecutionIntentUnauthorizedError,
  ExecutionIntentSessionMismatchError,
  ExecutionIntentProjectMismatchError,
  ExecutionIntentContextMismatchError,
  ExecutionIntentContextStaleError,
  ExecutionIntentContextIncompleteError,
  ExecutionIntentRevisionMismatchError,
  ExecutionIntentTaskInvalidError,
  ExecutionIntentDecisionInvalidError,
} from '../dist/index.js';

describe('Phase 10 — Execution Intent Authorization Boundary (TASK-P10-01)', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let decisionEngine: DirectorDecisionEngine;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let humanApprovalEngine: HumanApprovalEngine;
  let executionAuthorizer: ExecutionAuthorizer;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let contextEngine: ContextEngine;
  let gitPort: DefaultGitPort;
  let delegate: DefaultMcpOrchestratorDelegate;
  let synchronizer: DirectorContextSynchronizer;
  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let testPackage: ProjectApprovalPackage;
  let implementDecision: DirectorDecision;

  function createMockReport(workspaceRoot: string): ProjectDiscoveryReport {
    return {
      projectIdentity: {
        name: 'test-exec-intent-project',
        version: '1.0.0',
        workspaceRoot,
        ecosystem: 'Node.js',
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
      },
      purpose: {
        classification: 'UNDERSTOOD',
        summary: 'A deterministic agent orchestration platform',
        domainKeywords: ['orchestration', 'agent'],
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'README.md' }],
      },
      technologyStack: {
        primaryLanguages: ['TypeScript'],
        frameworks: [],
        buildTools: ['tsc'],
        packageManagers: ['npm'],
        runtimes: ['node'],
        containerization: [],
        ciCd: [],
        workspaceType: 'standalone',
      },
      architecture: {
        summary: 'Standard modular TypeScript architecture',
        architecturalPattern: 'Modular',
        identifiedAreas: [],
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/index.ts' }],
      },
      currentImplementationState: {
        lifecycleState: 'REQUIREMENTS_INGESTION',
        hasActiveTask: false,
        isBlocked: false,
        totalTasksInDag: 0,
        completedTasksCount: 0,
        evidence: [{ sourceType: 'STATE_MANAGER', sourceIdentifier: 'durable-state.json' }],
      },
      unknowns: [],
      contradictions: [],
      evidenceInventory: [],
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Creates a READY task with given id in the SpecStore.
   */
  async function createReadyTask(
    taskId: string,
    dependencies: string[] = [],
    statusOverride?: string,
    metadataOverride?: Record<string, unknown>
  ) {
    const tasks = await specStore.loadTasks().catch(() => []);
    if (!tasks.some(t => t.task_id === 'FEAT-TEST-001')) {
      tasks.push({
        task_id: 'FEAT-TEST-001',
        parent_feature_id: 'ROOT',
        title: 'Test Feature',
        description: 'Test Feature for execution intent testing',
        traceability_sources: ['REQ-001'],
        dependencies: [],
        acceptance_criteria: ['AC-FEAT-001'],
        status: 'READY' as any,
        attempt: 1,
        max_attempts: 3,
        priority: 'MEDIUM',
        risk_level: 'SAFE',
        hierarchy_level: 'FEATURE' as any,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { revision: 1 },
      });
    }
    tasks.push({
      task_id: taskId,
      parent_feature_id: 'FEAT-TEST-001',
      title: `Test task ${taskId}`,
      description: 'A test task for execution intent validation',
      traceability_sources: ['REQ-001'],
      dependencies,
      acceptance_criteria: ['AC-001'],
      status: (statusOverride as any) ?? 'READY',
      attempt: 1,
      max_attempts: 3,
      priority: 'MEDIUM',
      risk_level: 'SAFE',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: metadataOverride ?? { revision: 1 },
    });
    await specStore.saveTasks(tasks);
  }

  /**
   * Creates an IMPLEMENT_TASK decision in the decision store.
   */
  async function createImplementTaskDecision(
    sessionId: string,
    projectId: string,
    fingerprint: string,
    understandingRevision?: number | null,
    decisionType = 'IMPLEMENT_TASK' as any,
    basedOnApprovalRevision: number | null = null
  ): Promise<DirectorDecision> {
    const decision: DirectorDecision = {
      decisionId: `dec-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      directorSessionId: sessionId,
      projectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType,
      rationale: 'Implement the next task per Director analysis',
      basedOnContextFingerprint: fingerprint,
      basedOnApprovalRevision,
      basedOnUnderstandingRevision: understandingRevision ?? null,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(decision);
    return decision;
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-01-test-'));

    // Create minimal package.json
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-exec-intent-project', version: '1.0.0' }, null, 2)
    );

    // Initialize core storage and engines
    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine();
    durableManager = new DurableStateManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    contextEngine = new ContextEngine({ workspaceRoot: tempDir });
    gitPort = new DefaultGitPort();

    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      approvalStore,
      contextEngine,
      gitPort,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
    });

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
    });

    decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
      decisionStore,
      approvalStore,
    });

    humanApprovalEngine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      delegate,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
    });

    executionAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      delegate,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
      historyManager,
    });

    // Create active Director session with understanding revision 5
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p10-01-001',
      understandingRevision: 5,
    });

    // Synchronize context
    activeSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    // Build and approve a valid package with explicit Product Owner approval
    const report = createMockReport(tempDir);
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, undefined, { projectId: 'test-exec-intent-project' });
    testPackage = approvalPackageEngine.buildPackage(understanding, undefined, {
      packageId: 'pkg-p10-01-001',
    });
    await approvalStore.savePackage(testPackage);

    // Submit human approval
    const approvalResult = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      projectId: 'test-exec-intent-project',
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for execution intent testing',
    });
    assert.equal(approvalResult.isDevelopmentAuthorized, true);
    // Reload approved package
    testPackage = approvalResult.package;

    // Create a READY task in SpecStore
    await createReadyTask('TASK-P10-IMPL-001');

    // Create an IMPLEMENT_TASK decision
    implementDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // T01: Valid authorized execution intent → VALID
  // ==========================================================================

  it('T01_valid_authorized_intent: fully authorized execution intent returns VALID with verified bindings', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId: 'test-exec-intent-project',
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
      operationType: 'IMPLEMENT_TASK',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.code, 'VALID');
    assert.ok(result.intent);
    assert.equal(result.intent.directorSessionId, activeSession.directorSessionId);
    assert.equal(result.intent.directorDecisionId, implementDecision.decisionId);
    assert.equal(result.intent.projectId, 'test-exec-intent-project');
    assert.equal(result.intent.taskId, 'TASK-P10-IMPL-001');
    assert.equal(result.intent.taskRevision, 1);
    assert.equal(result.intent.contextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(result.intent.understandingRevision, 5);
    assert.equal(result.intent.approvalPackageRevision, testPackage.revision);
    assert.equal(result.intent.operationType, 'IMPLEMENT_TASK');
    assert.equal(result.intent.protocolVersion, EXECUTION_INTENT_PROTOCOL_VERSION);
    assert.equal(result.intent.schemaVersion, EXECUTION_INTENT_SCHEMA_VERSION);
    assert.ok(result.intent.createdAt);
    assert.ok(result.intent.intentId);

    // Verify verified bindings
    assert.ok(result.verifiedBindings);
    assert.equal(result.verifiedBindings.projectId, 'test-exec-intent-project');
    assert.equal(result.verifiedBindings.directorSessionId, activeSession.directorSessionId);
    assert.equal(result.verifiedBindings.directorDecisionId, implementDecision.decisionId);
    assert.equal(result.verifiedBindings.taskId, 'TASK-P10-IMPL-001');
    assert.equal(result.verifiedBindings.understandingRevision, 5);
  });

  // ==========================================================================
  // T02: Missing approval → APPROVAL_NOT_FOUND
  // ==========================================================================

  it('T02_missing_approval: no approval package returns APPROVAL_NOT_FOUND', async () => {
    // Create a fresh environment with no approval
    const noApprovalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-01-noappr-'));
    fs.writeFileSync(
      path.join(noApprovalDir, 'package.json'),
      JSON.stringify({ name: 'test-exec-intent-project', version: '1.0.0' }, null, 2)
    );

    const noApprovalStore = new ApprovalStore({ baseDir: noApprovalDir, historyManager: new HistoryManager({ baseDir: noApprovalDir }) });
    const noApprovalAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: noApprovalDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore: noApprovalStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
    });

    const result = await noApprovalAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_NOT_FOUND');

    fs.rmSync(noApprovalDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // T03: Unauthorized approval → APPROVAL_NOT_AUTHORIZED
  // ==========================================================================

  it('T03_unauthorized_approval: isDevelopmentAuthorized() === false returns APPROVAL_NOT_AUTHORIZED', async () => {
    // Create a custom engine that always returns false for isDevelopmentAuthorized
    const fakePackageEngine = new ApprovalPackageEngine();
    const origMethod = fakePackageEngine.isDevelopmentAuthorized.bind(fakePackageEngine);
    fakePackageEngine.isDevelopmentAuthorized = () => false;

    const restrictedAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine: fakePackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
    });

    const result = await restrictedAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_NOT_AUTHORIZED');
  });

  // ==========================================================================
  // T04: Wrong project → PROJECT_BINDING_MISMATCH
  // ==========================================================================

  it('T04_wrong_project: mismatched project returns PROJECT_BINDING_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId: 'wrong-project-name',
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'PROJECT_BINDING_MISMATCH');
  });

  // ==========================================================================
  // T05: Wrong session → SESSION_INVALID
  // ==========================================================================

  it('T05_wrong_session: non-existent session returns SESSION_INVALID', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-nonexistent',
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'SESSION_INVALID');
  });

  // ==========================================================================
  // T06: Decision session mismatch → DECISION_SESSION_MISMATCH
  // ==========================================================================

  it('T06_decision_session_mismatch: decision bound to different session returns DECISION_SESSION_MISMATCH', async () => {
    // Create a second session
    const session2 = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p10-01-002',
      understandingRevision: 5,
    });

    // Sync context for session2
    await synchronizer.synchronize({
      directorSessionId: session2.directorSessionId,
      workspaceRoot: tempDir,
    });

    // Decision was created for session 1, but we validate with session 2
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: session2.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_SESSION_MISMATCH');
  });

  // ==========================================================================
  // T07: Invalid decision type → DECISION_TYPE_INVALID
  // ==========================================================================

  it('T07_invalid_decision_type: REQUEST_CLARIFICATION decision returns DECISION_TYPE_INVALID', async () => {
    // Create a non-executable decision type
    const clarifyDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5,
      'REQUEST_CLARIFICATION'
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: clarifyDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_TYPE_INVALID');
  });

  // ==========================================================================
  // T08: Task not found → TASK_NOT_FOUND
  // ==========================================================================

  it('T08_task_not_found: non-existent task returns TASK_NOT_FOUND', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-NONEXISTENT',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_NOT_FOUND');
  });

  // ==========================================================================
  // T09: Task not ready → TASK_STATE_INVALID
  // ==========================================================================

  it('T09_task_not_ready: ACCEPTED task returns TASK_STATE_INVALID', async () => {
    await createReadyTask('TASK-P10-DONE-001', [], 'ACCEPTED');

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-DONE-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_STATE_INVALID');
  });

  // ==========================================================================
  // T10: Task revision mismatch → TASK_REVISION_MISMATCH
  // ==========================================================================

  it('T10_task_revision_mismatch: wrong task revision returns TASK_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 999,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_REVISION_MISMATCH');
  });

  // ==========================================================================
  // T11: Context fingerprint mismatch → CONTEXT_FINGERPRINT_MISMATCH
  // ==========================================================================

  it('T11_context_fingerprint_mismatch: wrong fingerprint returns CONTEXT_FINGERPRINT_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: 'wrong-fingerprint-abc123',
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'CONTEXT_FINGERPRINT_MISMATCH');
  });

  // ==========================================================================
  // T12: Context stale → CONTEXT_STALE
  // ==========================================================================

  it('T12_context_stale: stale context snapshot returns CONTEXT_STALE', async () => {
    // Manipulate snapshot to be stale by writing directly to latest.json
    const snapshot = await sessionStore.loadLatestSnapshot(activeSession.directorSessionId);
    assert.ok(snapshot);

    const staleSnapshot = {
      ...snapshot,
      directorSessionId: activeSession.directorSessionId,
      syncStatus: 'STALE',
      staleSections: ['requirements'],
    };
    await sessionStore.saveSnapshot(staleSnapshot);

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'CONTEXT_STALE');

    // Restore original for other tests
    await sessionStore.saveSnapshot({ ...snapshot, directorSessionId: activeSession.directorSessionId });
  });

  // ==========================================================================
  // T13: Context incomplete → CONTEXT_INCOMPLETE
  // ==========================================================================

  it('T13_context_incomplete: incomplete context snapshot returns CONTEXT_INCOMPLETE', async () => {
    const snapshot = await sessionStore.loadLatestSnapshot(activeSession.directorSessionId);
    assert.ok(snapshot);

    const incompleteSnapshot = {
      ...snapshot,
      directorSessionId: activeSession.directorSessionId,
      syncStatus: 'INCOMPLETE',
      isComplete: false,
      unavailableSections: ['tasks'],
    };
    await sessionStore.saveSnapshot(incompleteSnapshot);

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: snapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'CONTEXT_INCOMPLETE');

    // Restore
    await sessionStore.saveSnapshot({ ...snapshot, directorSessionId: activeSession.directorSessionId });
  });

  // ==========================================================================
  // T14: Understanding revision missing from session → UNDERSTANDING_REVISION_MISMATCH
  // ==========================================================================

  it('T14_understanding_revision_missing_session: session without understanding revision returns UNDERSTANDING_REVISION_MISMATCH', async () => {
    // Create a session without understanding revision
    const noRevSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-norev-001',
    });

    const noRevSnapshot = await synchronizer.synchronize({
      directorSessionId: noRevSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    const noRevDecision = await createImplementTaskDecision(
      noRevSession.directorSessionId,
      'test-exec-intent-project',
      noRevSnapshot.logicalFingerprint,
      null
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: noRevSession.directorSessionId,
      directorDecisionId: noRevDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: noRevSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(result.message, /no authoritative understanding revision/);
  });

  // ==========================================================================
  // T15: Understanding revision missing from intent → UNDERSTANDING_REVISION_MISMATCH
  // ==========================================================================

  it('T15_understanding_revision_missing_intent: omitted understanding revision returns UNDERSTANDING_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      approvalPackageRevision: testPackage.revision,
      // understandingRevision intentionally omitted
    } as any);

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(result.message, /mandatory/i);
  });

  // ==========================================================================
  // T16: Understanding revision value mismatch → UNDERSTANDING_REVISION_MISMATCH
  // ==========================================================================

  it('T16_understanding_revision_mismatch: wrong revision value returns UNDERSTANDING_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 99,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(result.message, /99/);
    assert.match(result.message, /5/);
  });

  // ==========================================================================
  // T17: Approval revision mismatch → APPROVAL_REVISION_MISMATCH
  // ==========================================================================

  it('T17_approval_revision_mismatch: wrong approval revision returns APPROVAL_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: 999,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_REVISION_MISMATCH');
  });

  // ==========================================================================
  // T18: Inactive / closed session → SESSION_NOT_ACTIVE
  // ==========================================================================

  it('T18_inactive_session: closed session returns SESSION_NOT_ACTIVE', async () => {
    // Create and close a session
    const closedSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-closed-001',
      understandingRevision: 5,
    });

    await synchronizer.synchronize({
      directorSessionId: closedSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    const closedDecision = await createImplementTaskDecision(
      closedSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5
    );

    await sessionEngine.closeSession({
      directorSessionId: closedSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: closedSession.directorSessionId,
      directorDecisionId: closedDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'SESSION_NOT_ACTIVE');
  });

  // ==========================================================================
  // T19: hasImplementationAuthority !== false → SECURITY_VIOLATION
  // ==========================================================================

  it('T19_security_violation: decision claiming implementation authority returns SECURITY_VIOLATION', async () => {
    // The decision store validates on load and rejects hasImplementationAuthority: true,
    // so we need to mock the loadDecision method to simulate a bypass (defense-in-depth test)
    const badDecisionId = `dec-bad-${Date.now()}`;
    const badDecision = {
      decisionId: badDecisionId,
      directorSessionId: activeSession.directorSessionId,
      projectId: 'test-exec-intent-project',
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK' as const,
      rationale: 'Attempting to claim authority',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: null,
      basedOnUnderstandingRevision: 5,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: true as any, // VIOLATION
    };

    // Create an authorizer with a mocked decision store
    const mockDecisionStore = Object.create(decisionStore);
    const origLoad = decisionStore.loadDecision.bind(decisionStore);
    mockDecisionStore.loadDecision = async (id: string) => {
      if (id === badDecisionId) return badDecision;
      return origLoad(id);
    };

    const mockAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      sessionEngine,
      decisionStore: mockDecisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
    });

    const result = await mockAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: badDecisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'SECURITY_VIOLATION');
  });

  // ==========================================================================
  // T20: Dry-run guarantee: no mutation
  // ==========================================================================

  it('T20_dry_run_no_mutation: validation does not mutate task DAG, FSM, or invoke executor', async () => {
    // Snapshot state before validation
    const tasksBefore = await specStore.loadTasks();
    const taskBefore = tasksBefore.find(t => t.task_id === 'TASK-P10-IMPL-001');
    assert.ok(taskBefore);
    const statusBefore = taskBefore.status;
    const attemptBefore = taskBefore.attempt;

    // Run validation (both valid and invalid)
    await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    // Run an invalid one too
    await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-NONEXISTENT',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    // Verify no mutation
    const tasksAfter = await specStore.loadTasks();
    const taskAfter = tasksAfter.find(t => t.task_id === 'TASK-P10-IMPL-001');
    assert.ok(taskAfter);
    assert.equal(taskAfter.status, statusBefore);
    assert.equal(taskAfter.attempt, attemptBefore);

    // Verify session is still active
    const sessionAfter = await sessionStore.loadSession(activeSession.directorSessionId);
    assert.ok(sessionAfter);
    assert.equal(sessionAfter.status, 'ACTIVE');
  });

  // ==========================================================================
  // T21: MCP boundary tool validation
  // ==========================================================================

  it('T21_mcp_tool_boundary: aidm.execution.intent.validate tool returns proper result through MCP', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      executionIntentTools: true,
    });
    await server.start();

    // Tool must be registered
    const tools = server.getRegisteredTools();
    const intentTool = tools.find((t: any) => t.name === AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME);
    assert.ok(intentTool, 'aidm.execution.intent.validate tool must be registered');
    assert.equal(intentTool.name, 'aidm.execution.intent.validate');

    // Call the tool with valid input through MCP handleMessage
    const resp = await server.handleMessage({
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: 'TASK-P10-IMPL-001',
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 5,
          approvalPackageRevision: testPackage.revision,
        },
      },
    });

    assert.ok(resp && 'result' in resp);
    const parsed = JSON.parse((resp as any).result.content[0].text);
    assert.equal(parsed.isValid, true);
    assert.equal(parsed.code, 'VALID');
    assert.ok(parsed.intent);
    assert.equal(parsed.intent.taskId, 'TASK-P10-IMPL-001');

    await server.stop();
  });

  // ==========================================================================
  // T22: Decision not found → DECISION_INVALID
  // ==========================================================================

  it('T22_decision_not_found: non-existent decision returns DECISION_INVALID', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: 'dec-nonexistent-123',
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_INVALID');
  });

  // ==========================================================================
  // T23: createExecutionIntent() success + audit
  // ==========================================================================

  it('T23_create_execution_intent_success: createExecutionIntent returns intent on success', async () => {
    const intent = await executionAuthorizer.createExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.ok(intent);
    assert.equal(intent.projectId, 'test-exec-intent-project');
    assert.equal(intent.directorSessionId, activeSession.directorSessionId);
    assert.equal(intent.directorDecisionId, implementDecision.decisionId);
    assert.equal(intent.taskId, 'TASK-P10-IMPL-001');
    assert.equal(intent.understandingRevision, 5);
    assert.equal(intent.operationType, 'IMPLEMENT_TASK');
    assert.ok(intent.intentId);
  });

  // ==========================================================================
  // T24: createExecutionIntent() failure + error hierarchy
  // ==========================================================================

  it('T24_create_execution_intent_failure: createExecutionIntent throws typed errors', async () => {
    // PROJECT_BINDING_MISMATCH → ExecutionIntentProjectMismatchError
    await assert.rejects(
      async () => {
        await executionAuthorizer.createExecutionIntent({
          workspaceRoot: tempDir,
          projectId: 'wrong-project',
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: 'TASK-P10-IMPL-001',
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 5,
          approvalPackageRevision: testPackage.revision,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentProjectMismatchError);
        return true;
      }
    );

    // SESSION_INVALID → ExecutionIntentSessionMismatchError
    await assert.rejects(
      async () => {
        await executionAuthorizer.createExecutionIntent({
          workspaceRoot: tempDir,
          directorSessionId: 'nonexistent-session',
          directorDecisionId: implementDecision.decisionId,
          taskId: 'TASK-P10-IMPL-001',
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 5,
          approvalPackageRevision: testPackage.revision,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentSessionMismatchError);
        return true;
      }
    );

    // TASK_NOT_FOUND → ExecutionIntentTaskInvalidError
    await assert.rejects(
      async () => {
        await executionAuthorizer.createExecutionIntent({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: 'TASK-NONEXISTENT',
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 5,
          approvalPackageRevision: testPackage.revision,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentTaskInvalidError);
        return true;
      }
    );

    // UNDERSTANDING_REVISION_MISMATCH → ExecutionIntentRevisionMismatchError
    await assert.rejects(
      async () => {
        await executionAuthorizer.createExecutionIntent({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: 'TASK-P10-IMPL-001',
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 99,
          approvalPackageRevision: testPackage.revision,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentRevisionMismatchError);
        return true;
      }
    );
  });

  // ==========================================================================
  // T25: Approval actor role not PRODUCT_OWNER/USER → APPROVAL_INVALID
  // ==========================================================================

  it('T25_approval_wrong_actor_role: approval with EXECUTOR role returns APPROVAL_INVALID', async () => {
    // Mock getActivePackage to return a package with invalid actorRole
    // (Defense-in-depth test: the store validates on save/load, so we mock)
    const badPkg = {
      ...testPackage,
      status: 'APPROVED',
      approvalRecord: {
        ...testPackage.approvalRecord,
        actor: 'executor-bot',
        actorRole: 'EXECUTOR',
        intent: 'EXPLICIT_APPROVAL',
      },
    };

    const mockApprovalStore = Object.create(approvalStore);
    mockApprovalStore.getActivePackage = async () => badPkg;

    const mockAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore: mockApprovalStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
    });

    const result = await mockAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_INVALID');
  });

  // ==========================================================================
  // T26: Approval intent not EXPLICIT_APPROVAL → APPROVAL_INVALID
  // ==========================================================================

  it('T26_approval_wrong_intent: approval with IMPLICIT intent returns APPROVAL_INVALID', async () => {
    // Mock getActivePackage to return a package with invalid intent
    // (Defense-in-depth test: the store validates on save/load, so we mock)
    const badPkg = {
      ...testPackage,
      status: 'APPROVED',
      approvalRecord: {
        ...testPackage.approvalRecord,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
        intent: 'NATURAL_LANGUAGE_CONFIRM',
      },
    };

    const mockApprovalStore = Object.create(approvalStore);
    mockApprovalStore.getActivePackage = async () => badPkg;

    const mockAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: tempDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore: mockApprovalStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
    });

    const result = await mockAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_INVALID');
  });

  // ==========================================================================
  // T27: Approval project mismatch → APPROVAL_PROJECT_MISMATCH
  // ==========================================================================

  it('T27_approval_project_mismatch: approval for different project returns APPROVAL_PROJECT_MISMATCH', async () => {
    const wrongProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-01-wrongproj-'));
    fs.writeFileSync(
      path.join(wrongProjDir, 'package.json'),
      JSON.stringify({ name: 'test-exec-intent-project', version: '1.0.0' }, null, 2)
    );

    const wrongProjStore = new ApprovalStore({ baseDir: wrongProjDir, historyManager: new HistoryManager({ baseDir: wrongProjDir }) });
    const wrongProjPackage: any = {
      ...testPackage,
      projectId: 'completely-different-project',
      status: 'APPROVED',
      approvalRecord: {
        ...testPackage.approvalRecord,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    };
    await wrongProjStore.savePackage(wrongProjPackage);

    const wrongProjAuthorizer = new ExecutionAuthorizer({
      workspaceRoot: wrongProjDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore: wrongProjStore,
      approvalPackageEngine,
      specStore,
      dagEngine: new TaskDagEngine(),
    });

    const result = await wrongProjAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_PROJECT_MISMATCH');

    fs.rmSync(wrongProjDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // T28: Task BLOCKED → TASK_STATE_INVALID
  // ==========================================================================

  it('T28_task_blocked: BLOCKED task returns TASK_STATE_INVALID', async () => {
    await createReadyTask('TASK-P10-BLOCKED-001', [], 'BLOCKED');

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-BLOCKED-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_STATE_INVALID');
  });

  // ==========================================================================
  // T29: Task with unmet dependency → TASK_STATE_INVALID
  // ==========================================================================

  it('T29_task_unmet_dependency: task with non-ACCEPTED dependency returns TASK_STATE_INVALID', async () => {
    // Create a dependency task that is NOT accepted (still READY)
    await createReadyTask('TASK-P10-DEP-001', [], 'READY');
    // Create a task that depends on the un-accepted dependency
    await createReadyTask('TASK-P10-CHILD-001', ['TASK-P10-DEP-001']);

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-CHILD-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_STATE_INVALID');
    assert.match(result.message, /unmet dependencies/);
  });

  // ==========================================================================
  // T30: RESUME decision type is REJECTED (not execution-eligible)
  // ==========================================================================

  it('T30_resume_decision_rejected: RESUME decision type is rejected and not execution-eligible', async () => {
    const resumeDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5,
      'RESUME'
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: resumeDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_TYPE_INVALID');
    assert.match(result.message, /RESUME is not an execution intent/);
  });

  // ==========================================================================
  // T31: BLOCK decision type is NOT execution-eligible
  // ==========================================================================

  it('T31_block_decision_not_eligible: BLOCK decision type returns DECISION_TYPE_INVALID', async () => {
    const blockDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5,
      'BLOCK'
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: blockDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_TYPE_INVALID');
  });

  // ==========================================================================
  // T32: IN_PROGRESS task is execution-eligible
  // ==========================================================================

  it('T32_in_progress_task_eligible: IN_PROGRESS task is execution-eligible', async () => {
    await createReadyTask('TASK-P10-WIP-001', [], 'IN_PROGRESS');

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-WIP-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, true);
    assert.equal(result.code, 'VALID');
  });

  // ==========================================================================
  // T33: Intent ID generation is deterministic and context-dependent
  // ==========================================================================

  it('T33_deterministic_intent_id: same inputs generate same ID, different contextFingerprint generates different ID', async () => {
    const id1 = executionAuthorizer.generateIntentId(
      'test-project', 'dec-1', 'task-1', 'fingerprint-A'
    );
    const id2 = executionAuthorizer.generateIntentId(
      'test-project', 'dec-1', 'task-1', 'fingerprint-A'
    );
    assert.equal(id1, id2);
    assert.ok(id1.startsWith('intent-'));

    // Different contextFingerprint → different ID
    const id3 = executionAuthorizer.generateIntentId(
      'test-project', 'dec-1', 'task-1', 'fingerprint-B'
    );
    assert.notEqual(id1, id3);

    // Different decisionId → different ID
    const id4 = executionAuthorizer.generateIntentId(
      'test-project', 'dec-2', 'task-1', 'fingerprint-A'
    );
    assert.notEqual(id1, id4);
  });

  // ==========================================================================
  // T34: null understandingRevision in intent → UNDERSTANDING_REVISION_MISMATCH
  // ==========================================================================

  it('T34_null_understanding_revision_intent: null understandingRevision in intent returns UNDERSTANDING_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: null as any,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'UNDERSTANDING_REVISION_MISMATCH');
  });

  // ==========================================================================
  // T35: Validation input schema rejection
  // ==========================================================================

  it('T35_input_schema_validation: malformed input returns VALIDATION_ERROR', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: '',
      directorDecisionId: 'dec-1',
      taskId: 'TASK-1',
      taskRevision: 1,
      contextFingerprint: 'fp-1',
      understandingRevision: 1,
      approvalPackageRevision: 1,
    } as any);

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
  });

  // ==========================================================================
  // T36: MCP tool with invalid input returns error
  // ==========================================================================

  it('T36_mcp_tool_invalid_input: MCP tool rejects malformed input', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      executionIntentTools: true,
    });
    await server.start();

    const resp = await server.handleMessage({
      jsonrpc: '2.0' as const,
      id: 99,
      method: 'tools/call',
      params: {
        name: AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME,
        arguments: {
          // Missing required fields
          directorSessionId: '',
        },
      },
    });

    assert.ok(resp);
    assert.ok('error' in resp);

    await server.stop();
  });

  // ==========================================================================
  // T37: Decision project mismatch → DECISION_PROJECT_MISMATCH
  // ==========================================================================

  it('T37_decision_project_mismatch: decision for different project returns DECISION_PROJECT_MISMATCH', async () => {
    const wrongProjDecision: DirectorDecision = {
      decisionId: `dec-wrongproj-${Date.now()}`,
      directorSessionId: activeSession.directorSessionId,
      projectId: 'some-other-project',
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Implement task',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: null,
      basedOnUnderstandingRevision: 5,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(wrongProjDecision);

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: wrongProjDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_PROJECT_MISMATCH');
  });

  // ==========================================================================
  // T38: Mandatory approvalPackageRevision: missing from input → APPROVAL_REVISION_MISMATCH
  // ==========================================================================

  it('T38_missing_approval_package_revision: omitted approvalPackageRevision returns APPROVAL_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      // approvalPackageRevision omitted
    } as any);

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_REVISION_MISMATCH');
    assert.match(result.message, /mandatory/i);
  });

  // ==========================================================================
  // T39: Decision context fingerprint mismatch → CONTEXT_FINGERPRINT_MISMATCH
  // ==========================================================================

  it('T39_decision_context_fingerprint_mismatch: decision with stale/foreign fingerprint returns CONTEXT_FINGERPRINT_MISMATCH', async () => {
    const staleDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      'foreign-stale-fingerprint-999',
      5
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: staleDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'CONTEXT_FINGERPRINT_MISMATCH');
    assert.match(result.message, /Decision was made on a different or stale context snapshot/);
  });

  // ==========================================================================
  // T40: Decision understanding revision mismatch → UNDERSTANDING_REVISION_MISMATCH
  // ==========================================================================

  it('T40_decision_understanding_revision_mismatch: decision with different understanding revision returns UNDERSTANDING_REVISION_MISMATCH', async () => {
    const mismatchedDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      3 // different from session revision 5
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: mismatchedDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(result.message, /Director decision was based on understanding revision 3/);
  });

  // ==========================================================================
  // T41: Decision approval revision mismatch → APPROVAL_REVISION_MISMATCH
  // ==========================================================================

  it('T41_decision_approval_revision_mismatch: decision with different approval revision returns APPROVAL_REVISION_MISMATCH', async () => {
    const mismatchedDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5,
      'IMPLEMENT_TASK',
      99 // different from testPackage.revision (1)
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: mismatchedDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'APPROVAL_REVISION_MISMATCH');
    assert.match(result.message, /Director decision was based on approval revision 99/);
  });

  // ==========================================================================
  // T42: Decision with exact matching bindings → VALID
  // ==========================================================================

  it('T42_decision_exact_bindings_valid: decision with matching context, understanding, and approval revisions is accepted', async () => {
    const fullyBoundDecision = await createImplementTaskDecision(
      activeSession.directorSessionId,
      'test-exec-intent-project',
      activeSnapshot.logicalFingerprint,
      5,
      'IMPLEMENT_TASK',
      testPackage.revision
    );

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: fullyBoundDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, true);
    assert.equal(result.code, 'VALID');
  });

  // ==========================================================================
  // T43: Mandatory taskRevision: missing from input → TASK_REVISION_MISMATCH
  // ==========================================================================

  it('T43_missing_task_revision: omitted taskRevision returns TASK_REVISION_MISMATCH', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
      // taskRevision omitted
    } as any);

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_REVISION_MISMATCH');
    assert.match(result.message, /mandatory/i);
  });

  // ==========================================================================
  // T44: Authoritative taskRevision from metadata.revision (not attempt)
  // ==========================================================================

  it('T44_task_revision_from_metadata: authoritative task revision is read from metadata.revision, not attempt', async () => {
    // Create a task where attempt is 3, but metadata.revision is 2
    await createReadyTask('TASK-P10-ATTEMPT-DIFF-001', [], 'READY', { revision: 2 });
    const tasks = await specStore.loadTasks();
    const task = tasks.find(t => t.task_id === 'TASK-P10-ATTEMPT-DIFF-001')!;
    task.attempt = 3; // attempt != revision
    await specStore.saveTasks(tasks);

    // Using attempt (3) should fail
    const attemptResult = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-ATTEMPT-DIFF-001',
      taskRevision: 3, // using attempt instead of metadata.revision
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });
    assert.equal(attemptResult.isValid, false);
    assert.equal(attemptResult.code, 'TASK_REVISION_MISMATCH');

    // Using metadata.revision (2) should succeed
    const validResult = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-ATTEMPT-DIFF-001',
      taskRevision: 2,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });
    assert.equal(validResult.isValid, true);
    assert.equal(validResult.code, 'VALID');
  });

  // ==========================================================================
  // T45: Lifecycle: P10-01 does NOT emit EXECUTION_REQUESTED history event
  // ==========================================================================

  it('T45_lifecycle_no_execution_requested_event: createExecutionIntent does NOT emit EXECUTION_REQUESTED event', async () => {
    const eventsBefore = await historyManager.readEvents();
    const executionRequestedBefore = eventsBefore.filter(e => e.eventType === 'EXECUTION_REQUESTED');

    const intent = await executionAuthorizer.createExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.ok(intent);

    const eventsAfter = await historyManager.readEvents();
    const executionRequestedAfter = eventsAfter.filter(e => e.eventType === 'EXECUTION_REQUESTED');

    // P10-01 must NOT emit EXECUTION_REQUESTED
    assert.equal(executionRequestedAfter.length, executionRequestedBefore.length);
  });

  // ==========================================================================
  // T46: Operation type restriction: only IMPLEMENT_TASK is authorized in P10-01
  // ==========================================================================

  it('T46_operation_type_narrowed: non-IMPLEMENT_TASK operation type is rejected in P10-01', async () => {
    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
      operationType: 'EXECUTE_TEST' as any,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'DECISION_TYPE_INVALID');
    assert.match(result.message, /EXECUTE_TEST/);
  });

  // ==========================================================================
  // T47: Task authority: TaskDagEngine validates structural integrity of tasks
  // ==========================================================================

  it('T47_task_dag_engine_structural_validation: corrupted Task DAG graph fails validation', async () => {
    // Add a corrupted task with missing parent and missing dependency
    const tasks = await specStore.loadTasks();
    tasks.push({
      task_id: 'TASK-P10-CORRUPT-001',
      parent_feature_id: '', // empty parent
      title: 'Corrupt task',
      description: 'Corrupt task with missing dependency',
      traceability_sources: ['REQ-001'],
      dependencies: ['TASK-NONEXISTENT-DEP-999'], // missing dependency
      acceptance_criteria: ['AC-001'],
      status: 'READY',
      attempt: 1,
      max_attempts: 3,
      priority: 'MEDIUM',
      risk_level: 'MEDIUM',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { revision: 1 },
    });
    await specStore.saveTasks(tasks);

    const result = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'TASK_STATE_INVALID');
    assert.match(result.message, /Task DAG structural integrity check failed/);
  });

  // ==========================================================================
  // T48: Non-mutation boundary: execution intent creation does NOT mutate FSM or DAG
  // ==========================================================================

  it('T48_no_fsm_or_dag_mutation: intent creation does NOT mutate durable state or task state', async () => {
    const fsmBefore = await durableManager.load();
    const tasksBefore = await specStore.loadTasks();

    await executionAuthorizer.createExecutionIntent({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: 'TASK-P10-IMPL-001',
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
    });

    const fsmAfter = await durableManager.load();
    const tasksAfter = await specStore.loadTasks();

    assert.deepEqual(fsmBefore, fsmAfter);
    assert.deepEqual(tasksBefore, tasksAfter);
  });
});
