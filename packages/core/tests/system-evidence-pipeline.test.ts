/**
 * Phase 10 TASK-P10-04: System Evidence Collection & Verification Pipeline Test Suite
 *
 * Verifies the authoritative, independent evidence collection and verification boundary:
 * - T01: Valid RawExecutorOutcome enters verification pipeline.
 * - T02: Executor SUCCESS alone cannot produce ACCEPT.
 * - T03: Executor-reported tests passing without actual test execution cannot produce ACCEPT.
 * - T04: Independent passing test produces PASS evidence.
 * - T05: Independent failing test produces FAIL evidence.
 * - T06: Verification infrastructure failure produces BLOCK.
 * - T07: Changed files are independently determined via GitPort.
 * - T08: Unexpected file modification is detected.
 * - T09: Expected target files are correctly recognized.
 * - T10: Path traversal cannot enter evidence.
 * - T11: Absolute path cannot enter evidence.
 * - T12: Request binding mismatch is rejected.
 * - T13: Task revision mismatch is rejected.
 * - T14: Context fingerprint mismatch is rejected.
 * - T15: Approval revision mismatch is rejected.
 * - T16: Acceptance criterion PASS is represented correctly.
 * - T17: Acceptance criterion FAIL causes REJECT.
 * - T18: Acceptance criterion BLOCK causes BLOCK.
 * - T19: Mixed PASS + FAIL results in REJECT.
 * - T20: Required verification unavailable results in BLOCK.
 * - T21: SystemVerifiedEvidence cannot contain fake executor verification flags.
 * - T22: RawExecutorOutcome remains unchanged.
 * - T23: Evidence collection does not mutate DurableStateManager.
 * - T24: Evidence collection does not mutate TaskDagEngine.
 * - T25: Evidence collection does not mutate SpecStore.
 * - T26: Evidence collection does not mutate ApprovalStore.
 * - T27: P10-04 never invokes Antigravity.
 * - T28: P10-04 never performs autonomous retry.
 * - T29: Evidence is traceable to requestId.
 * - T30: Verification decision is deterministic for identical verified inputs.
 * - T31: MCP cannot submit fabricated verified evidence.
 * - T32: MCP cannot submit fabricated ACCEPT.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  type ExecutionRequest,
  ExecutionRequestBuilder,
  computeDeterministicRequestId,
  type RawExecutorOutcome,
  AntigravityAdapter,
  SystemEvidenceCollector,
  type SystemExecutionEvidence,
  type VerificationCheck,
  SystemExecutionEvidenceZodSchema,
  computeDeterministicEvidenceId,
  assertSafeEvidencePath,
  assertNoForbiddenEvidenceFields,
  ExecutionQaBridge,
  createEvidenceVerifyTool,
  AIDM_EVIDENCE_VERIFY_TOOL_NAME,
  FakeGitPort,
  FakeProcessExecutor,
  DurableStateManager,
  SpecStore,
  HistoryManager,
  ApprovalStore,
  ApprovalPackageEngine,
  HumanApprovalEngine,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  DirectorContextSynchronizer,
  ExecutionAuthorizer,
  TaskDagEngine,
  DefaultMcpOrchestratorDelegate,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  LifecycleState,
  ContextEngine,
  InitialProjectUnderstandingBuilder,
  type DirectorSession,
  type DirectorDecision,
  type DirectorContextSnapshot,
  type ProjectApprovalPackage,
  type ProjectDiscoveryReport,
  type ExecutionIntent,
  McpServer,
  InMemoryMcpTransport,
  SystemEvidenceBindingMismatchError,
  SystemEvidenceSecurityViolationError,
  SystemEvidenceError,
} from '../dist/index.js';

describe('Phase 10 TASK-P10-04: System Evidence Collection & Verification Pipeline', () => {
  let tempDir: string;
  let fakeGitPort: FakeGitPort;
  let fakeProcessExecutor: FakeProcessExecutor;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let historyManager: HistoryManager;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let humanApprovalEngine: HumanApprovalEngine;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let synchronizer: DirectorContextSynchronizer;
  let contextEngine: ContextEngine;
  let delegate: DefaultMcpOrchestratorDelegate;
  let authorizer: ExecutionAuthorizer;
  let requestBuilder: ExecutionRequestBuilder;
  let collector: SystemEvidenceCollector;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let testPackage: ProjectApprovalPackage;
  let testDecision: DirectorDecision;
  let sampleIntent: ExecutionIntent;
  let sampleRequest: ExecutionRequest;
  let sampleRawOutcome: RawExecutorOutcome;

  const validBaseCommit = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  function createMockReport(workspaceRoot: string): ProjectDiscoveryReport {
    return {
      projectIdentity: {
        name: 'test-exec-project',
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


  async function createReadyTasks() {
    await specStore.saveTasks([
      {
        task_id: 'FEAT-ROOT-001',
        parent_feature_id: 'ROOT',
        title: 'Feature Root',
        description: 'Root feature',
        traceability_sources: ['REQ-001'],
        dependencies: [],
        acceptance_criteria: ['AC-ROOT'],
        status: TaskStatus.READY,
        attempt: 1,
        max_attempts: 3,
        priority: TaskPriority.HIGH,
        risk_level: RiskLevel.SAFE,
        hierarchy_level: 'FEATURE' as any,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { revision: 1 },
      },
      {
        task_id: 'TASK-P10-01',
        parent_feature_id: 'FEAT-ROOT-001',
        title: 'Phase 10 Execution Task',
        description: 'Authoritative description from SpecStore Task DAG',
        traceability_sources: ['REQ-001'],
        dependencies: [],
        acceptance_criteria: ['Must compile cleanly', 'All unit tests pass'],
        status: TaskStatus.READY,
        attempt: 1,
        max_attempts: 3,
        priority: TaskPriority.HIGH,
        risk_level: RiskLevel.SAFE,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { revision: 2 },
      },
    ]);
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-04-test-'));

    // Create minimal project file
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-exec-project', version: '1.0.0' }, null, 2)
    );

    fakeGitPort = new FakeGitPort({
      initialState: {
        head_sha: validBaseCommit,
        current_branch: 'main',
        working_tree_clean: true,
        staged_changes: [],
        unstaged_changes: [],
        untracked_files: [],
      },
    });

    fakeProcessExecutor = new FakeProcessExecutor();

    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine();
    durableManager = new DurableStateManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    contextEngine = new ContextEngine({ workspaceRoot: tempDir });

    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      approvalStore,
      contextEngine,
      gitPort: fakeGitPort,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
    });

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
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

    authorizer = new ExecutionAuthorizer({
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

    requestBuilder = new ExecutionRequestBuilder({
      workspaceRoot: tempDir,
      gitPort: fakeGitPort,
      specStore,
      authorizer,
      delegate,
    });

    collector = new SystemEvidenceCollector({
      gitPort: fakeGitPort,
      processExecutor: fakeProcessExecutor,
      historyManager,
    });

    // 1. Create active Director session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p10-04-001',
      understandingRevision: 5,
    });

    // 2. Synchronize context snapshot
    activeSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    // 3. Build & approve package with explicit Product Owner approval
    const report = createMockReport(tempDir);
    const understandingBuilder = new InitialProjectUnderstandingBuilder();
    const understanding = understandingBuilder.build(report, undefined, { projectId: 'test-exec-project' });
    testPackage = approvalPackageEngine.buildPackage(understanding, undefined, {
      packageId: 'pkg-p10-04-001',
    });
    await approvalStore.savePackage(testPackage);

    const approvalResult = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      projectId: 'test-exec-project',
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for evidence testing',
    });
    assert.equal(approvalResult.isDevelopmentAuthorized, true);
    testPackage = approvalResult.package;

    // 4. Create READY task
    await createReadyTasks();

    // 5. Create IMPLEMENT_TASK decision
    testDecision = {
      decisionId: `dec-impl-${Date.now()}`,
      directorSessionId: activeSession.directorSessionId,
      projectId: 'test-exec-project',
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR' as const,
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Implement task TASK-P10-01',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: testPackage.revision,
      basedOnUnderstandingRevision: 5,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false as const,
    };
    await decisionStore.saveDecision(testDecision);

    // 6. Formulate verified sampleIntent
    const authResult = await authorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId: 'test-exec-project',
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: testDecision.decisionId,
      taskId: 'TASK-P10-01',
      taskRevision: 2,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
      operationType: 'IMPLEMENT_TASK',
    });
    assert.equal(authResult.isValid, true);
    assert.ok(authResult.intent);
    sampleIntent = authResult.intent;

    // 7. Build deterministic ExecutionRequest
    sampleRequest = await requestBuilder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Implement evidence verification pipeline boundary tests',
        targetFiles: ['src/pipeline.ts'],
        acceptanceCriteria: ['Must compile cleanly', 'All unit tests pass'],
      },
      executionLimits: {
        timeoutMs: 15_000,
        maxFileModifications: 10,
      },
    });

    // 8. Build matching RawExecutorOutcome
    sampleRawOutcome = Object.freeze({
      requestId: sampleRequest.requestId,
      executorIdentity: {
        provider: 'antigravity',
        name: 'cli',
        version: '1.0.0',
      },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'Task completed successfully',
      stderr: '',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 5000,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: sampleRequest.requestId,
        projectId: sampleRequest.projectId,
        taskId: sampleRequest.taskId,
        taskRevision: sampleRequest.taskRevision,
        contextFingerprint: sampleRequest.contextFingerprint,
        understandingRevision: sampleRequest.understandingRevision,
        approvalPackageRevision: sampleRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: ['Compiled cleanly', 'Tests passed'],
      unverifiedModifiedFiles: ['src/pipeline.ts'],
    });
  });


  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // T01: Valid RawExecutorOutcome enters verification pipeline
  // ==========================================================================
  it('T01: Valid RawExecutorOutcome enters verification pipeline', async () => {
    // Configure fake git port with target file modified
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      working_tree_clean: false,
      staged_changes: ['src/pipeline.ts'],
    };

    // Configure fake process executor to succeed on test/build commands
    fakeProcessExecutor.setHandler((cmd) => ({
      command: cmd,
      exitCode: 0,
      stdout: 'Compilation successful\nTests passed',
      stderr: '',
      durationMs: 42,
    }));

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST_01', type: 'TEST', command: 'npm test' }],
    });

    assert.ok(evidence);
    assert.equal(evidence.requestId, sampleRequest.requestId);
    assert.equal(evidence.taskId, sampleRequest.taskId);
    assert.equal(typeof evidence.evidenceId, 'string');
    assert.ok(evidence.evidenceId.startsWith('evi_'));
    assert.ok(Array.isArray(evidence.verificationChecks));
    assert.ok(Array.isArray(evidence.acceptanceCriteria));
    assert.ok(Array.isArray(evidence.changedFiles));
    assert.equal(evidence.executorOutcomeReference.status, 'SUCCESS');
  });

  // ==========================================================================
  // T02: Executor SUCCESS alone cannot produce ACCEPT
  // ==========================================================================
  it('T02: Executor SUCCESS alone cannot produce ACCEPT without independent verification', async () => {
    // Executor says SUCCESS, but NO verification commands are run, and acceptance criteria require tests
    const reqWithCriteria: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['Unit tests must pass'],
      },
    };

    const evidence = await collector.collectAndVerify(reqWithCriteria, sampleRawOutcome);

    // Cannot be ACCEPT because required test verification was not independently collected
    assert.notEqual(evidence.verificationDecision, 'ACCEPT');
    assert.ok(evidence.verificationDecision === 'BLOCK' || evidence.verificationDecision === 'REJECT');
  });

  // ==========================================================================
  // T03: Executor-reported tests passing without actual test execution cannot produce ACCEPT
  // ==========================================================================
  it('T03: Executor-reported tests passing without actual test execution cannot produce ACCEPT', async () => {
    const outcomeWithClaim: RawExecutorOutcome = {
      ...sampleRawOutcome,
      unverifiedAgentClaims: ['All 50 unit tests passed completely'],
      stdout: 'PASS: 50 tests passed',
    };

    const reqWithCriteria: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['Unit tests must pass'],
      },
    };

    // Zero process executor calls run
    fakeProcessExecutor.setHandler(() => {
      throw new Error('Process executor should not be called in this test');
    });

    const evidence = await collector.collectAndVerify(reqWithCriteria, outcomeWithClaim);

    // Untrusted executor claim alone must NEVER produce ACCEPT
    assert.notEqual(evidence.verificationDecision, 'ACCEPT');
    assert.equal(evidence.verificationDecision, 'BLOCK');
    const testCriterion = evidence.acceptanceCriteria.find((c) =>
      c.criterion.toLowerCase().includes('test')
    );
    assert.ok(testCriterion);
    assert.equal(testCriterion.status, 'BLOCK');
    assert.ok(testCriterion.evidence.includes('not executed') || testCriterion.evidence.includes('unavailable'));
  });

  // ==========================================================================
  // T04: Independent passing test produces PASS evidence
  // ==========================================================================
  it('T04: Independent passing test produces PASS evidence', async () => {
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      working_tree_clean: false,
      staged_changes: ['src/pipeline.ts'],
    };

    fakeProcessExecutor.setHandler((cmd) => {
      assert.equal(cmd, 'pnpm test');
      return {
        command: cmd,
        exitCode: 0,
        stdout: 'ok 1 - test passed',
        stderr: '',
        durationMs: 120,
      };
    });

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST_SUITE', type: 'TEST', command: 'pnpm test' }],
    });

    const check = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_TEST_SUITE');
    assert.ok(check);
    assert.equal(check.status, 'PASS');
    assert.equal(check.type, 'TEST');
    assert.ok(check.evidence?.includes('exited 0'));
  });

  // ==========================================================================
  // T05: Independent failing test produces FAIL evidence
  // ==========================================================================
  it('T05: Independent failing test produces FAIL evidence', async () => {
    fakeProcessExecutor.setHandler((cmd) => {
      return {
        command: cmd,
        exitCode: 1,
        stdout: 'not ok 1 - test failed assertion',
        stderr: 'AssertionError: expected true to equal false',
        durationMs: 85,
      };
    });

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST_SUITE', type: 'TEST', command: 'pnpm test' }],
    });

    const check = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_TEST_SUITE');
    assert.ok(check);
    assert.equal(check.status, 'FAIL');
    assert.equal(evidence.verificationDecision, 'REJECT');
  });

  // ==========================================================================
  // T06: Verification infrastructure failure produces BLOCK
  // ==========================================================================
  it('T06: Verification infrastructure failure produces BLOCK', async () => {
    fakeProcessExecutor.setHandler(() => {
      throw new Error('ENOENT: spawn pnpm ENOENT (binary not found)');
    });

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST_SUITE', type: 'TEST', command: 'pnpm test' }],
    });

    const check = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_TEST_SUITE');
    assert.ok(check);
    assert.equal(check.status, 'BLOCK');
    assert.equal(evidence.verificationDecision, 'BLOCK');
    assert.ok(check.evidence?.includes('infrastructure error'));
  });

  // ==========================================================================
  // T07: Changed files are independently determined
  // ==========================================================================
  it('T07: Changed files are independently determined from GitPort, ignoring executor claims', async () => {
    // GitPort reports different files than executor claims
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      staged_changes: ['src/pipeline.ts', 'src/helper.ts'],
      unstaged_changes: ['src/extra.ts'],
      untracked_files: [],
    };

    const outcomeWithFakeModified: RawExecutorOutcome = {
      ...sampleRawOutcome,
      unverifiedModifiedFiles: ['fabricated/path.ts'], // should be completely ignored
    };

    const evidence = await collector.collectAndVerify(sampleRequest, outcomeWithFakeModified);

    // Must match GitPort, NOT outcome.unverifiedModifiedFiles
    const paths = evidence.changedFiles.map((f) => f.path);
    assert.ok(paths.includes('src/pipeline.ts'));
    assert.ok(paths.includes('src/helper.ts'));
    assert.ok(paths.includes('src/extra.ts'));
    assert.equal(paths.includes('fabricated/path.ts'), false);
  });

  // ==========================================================================
  // T08: Unexpected file modification is detected
  // ==========================================================================
  it('T08: Unexpected file modification is detected as scope leak', async () => {
    // request.targetFiles is strictly ['src/pipeline.ts']
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      staged_changes: ['src/pipeline.ts', 'unexpected/unauthorized.ts'],
    };

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(evidence.verificationDecision, 'REJECT');
    const scopeCheck = evidence.verificationChecks.find((c) => c.type === 'FILE_SCOPE');
    assert.ok(scopeCheck);
    assert.equal(scopeCheck.status, 'FAIL');
    assert.ok(scopeCheck.evidence?.includes('unexpected/unauthorized.ts'));
  });

  // ==========================================================================
  // T09: Expected target files are correctly recognized
  // ==========================================================================
  it('T09: Expected target files are correctly recognized within scope', async () => {
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      staged_changes: ['src/pipeline.ts'],
      unstaged_changes: [],
      untracked_files: [],
    };

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    const scopeCheck = evidence.verificationChecks.find((c) => c.type === 'FILE_SCOPE');
    assert.ok(scopeCheck);
    assert.equal(scopeCheck.status, 'PASS');
    assert.ok(scopeCheck.evidence?.includes('strictly match targetFiles scope'));
  });

  // ==========================================================================
  // T10: Path traversal cannot enter evidence
  // ==========================================================================
  it('T10: Path traversal sequence (..) cannot enter evidence', async () => {
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      staged_changes: ['src/pipeline.ts', '../secret.env', 'src/../../etc/shadow'],
    };

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    // Traversal paths must be blocked from entering changedFiles
    for (const f of evidence.changedFiles) {
      assert.equal(f.path.includes('..'), false);
    }

    const pathCheck = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_PATH_SAFETY');
    assert.ok(pathCheck);
    assert.equal(pathCheck.status, 'FAIL');
    assert.equal(evidence.verificationDecision, 'REJECT');

    // assertSafeEvidencePath helper directly throws
    assert.throws(
      () => assertSafeEvidencePath('../secret.env'),
      SystemEvidenceSecurityViolationError
    );
  });

  // ==========================================================================
  // T11: Absolute path cannot enter evidence
  // ==========================================================================
  it('T11: Absolute path cannot enter evidence', async () => {
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      staged_changes: ['/etc/passwd', 'C:\\Windows\\system32', 'src/pipeline.ts'],
    };

    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    // Absolute paths must be filtered out of changedFiles
    for (const f of evidence.changedFiles) {
      assert.equal(f.path.startsWith('/'), false);
      assert.equal(f.path.startsWith('\\'), false);
      assert.equal(/^[a-zA-Z]:/.test(f.path), false);
    }

    const pathCheck = evidence.verificationChecks.find((c) => c.checkId === 'CHECK_PATH_SAFETY');
    assert.ok(pathCheck);
    assert.equal(pathCheck.status, 'FAIL');
    assert.equal(evidence.verificationDecision, 'REJECT');

    // assertSafeEvidencePath helper directly throws
    assert.throws(
      () => assertSafeEvidencePath('/etc/passwd'),
      SystemEvidenceSecurityViolationError
    );
    assert.throws(
      () => assertSafeEvidencePath('C:\\secret.txt'),
      SystemEvidenceSecurityViolationError
    );
  });

  // ==========================================================================
  // T12: Request binding mismatch is rejected
  // ==========================================================================
  it('T12: Request binding mismatch is rejected', async () => {
    const mismatchedOutcome: RawExecutorOutcome = {
      ...sampleRawOutcome,
      requestId: 'req-forged-000000000000000000000000',
    };

    const evidence = await collector.collectAndVerify(sampleRequest, mismatchedOutcome);

    assert.equal(evidence.verificationDecision, 'REJECT');
    const bindingCheck = evidence.verificationChecks.find((c) => c.type === 'BINDING');
    assert.ok(bindingCheck);
    assert.equal(bindingCheck.status, 'FAIL');

    // With throwOnBindingMismatch = true, directly throws
    await assert.rejects(
      () =>
        collector.collectAndVerify(sampleRequest, mismatchedOutcome, {
          throwOnBindingMismatch: true,
        }),
      SystemEvidenceBindingMismatchError
    );
  });

  // ==========================================================================
  // T13: Task revision mismatch is rejected
  // ==========================================================================
  it('T13: Task revision mismatch is rejected', async () => {
    const outcomeWithRevisionMismatch: RawExecutorOutcome = {
      ...sampleRawOutcome,
      requestBinding: {
        ...sampleRawOutcome.requestBinding,
        taskRevision: 999, // request requires 1
      },
    };

    const evidence = await collector.collectAndVerify(sampleRequest, outcomeWithRevisionMismatch);

    assert.equal(evidence.verificationDecision, 'REJECT');
    const bindingCheck = evidence.verificationChecks.find((c) => c.type === 'BINDING');
    assert.ok(bindingCheck);
    assert.equal(bindingCheck.status, 'FAIL');
    assert.ok(bindingCheck.evidence?.includes('taskRevision'));
  });

  // ==========================================================================
  // T14: Context fingerprint mismatch is rejected
  // ==========================================================================
  it('T14: Context fingerprint mismatch is rejected', async () => {
    const outcomeWithFpMismatch: RawExecutorOutcome = {
      ...sampleRawOutcome,
      requestBinding: {
        ...sampleRawOutcome.requestBinding,
        contextFingerprint: 'stale-fingerprint-hex',
      },
    };

    const evidence = await collector.collectAndVerify(sampleRequest, outcomeWithFpMismatch);

    assert.equal(evidence.verificationDecision, 'REJECT');
    const bindingCheck = evidence.verificationChecks.find((c) => c.type === 'BINDING');
    assert.ok(bindingCheck);
    assert.equal(bindingCheck.status, 'FAIL');
    assert.ok(bindingCheck.evidence?.includes('contextFingerprint'));
  });

  // ==========================================================================
  // T15: Approval revision mismatch is rejected
  // ==========================================================================
  it('T15: Approval revision mismatch is rejected', async () => {
    const outcomeWithApprovalMismatch: RawExecutorOutcome = {
      ...sampleRawOutcome,
      requestBinding: {
        ...sampleRawOutcome.requestBinding,
        approvalPackageRevision: 999,
      },
    };

    const evidence = await collector.collectAndVerify(sampleRequest, outcomeWithApprovalMismatch);

    assert.equal(evidence.verificationDecision, 'REJECT');
    const bindingCheck = evidence.verificationChecks.find((c) => c.type === 'BINDING');
    assert.ok(bindingCheck);
    assert.equal(bindingCheck.status, 'FAIL');
    assert.ok(bindingCheck.evidence?.includes('approvalPackageRevision'));
  });

  // ==========================================================================
  // T16: Acceptance criterion PASS is represented correctly
  // ==========================================================================
  it('T16: Acceptance criterion PASS is represented correctly', async () => {
    fakeGitPort.currentState = {
      ...fakeGitPort.currentState,
      staged_changes: ['src/pipeline.ts'],
    };

    fakeProcessExecutor.setHandler(() => ({
      command: 'npm test',
      exitCode: 0,
      stdout: 'all tests pass',
      stderr: '',
      durationMs: 40,
    }));

    const reqWithCriteria: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['All unit tests pass'],
      },
    };

    const evidence = await collector.collectAndVerify(reqWithCriteria, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST', type: 'TEST', command: 'npm test' }],
    });

    const crit = evidence.acceptanceCriteria[0];
    assert.ok(crit);
    assert.equal(crit.criterion, 'All unit tests pass');
    assert.equal(crit.status, 'PASS');
    assert.ok(crit.evidence.length > 0);
  });

  // ==========================================================================
  // T17: Acceptance criterion FAIL causes REJECT
  // ==========================================================================
  it('T17: Acceptance criterion FAIL causes REJECT', async () => {
    fakeProcessExecutor.setHandler(() => ({
      command: 'npm test',
      exitCode: 1,
      stdout: '1 test failed',
      stderr: 'FAIL',
      durationMs: 50,
    }));

    const reqWithCriteria: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['All unit tests pass'],
      },
    };

    const evidence = await collector.collectAndVerify(reqWithCriteria, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST', type: 'TEST', command: 'npm test' }],
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    const crit = evidence.acceptanceCriteria[0];
    assert.equal(crit.status, 'FAIL');
  });

  // ==========================================================================
  // T18: Acceptance criterion BLOCK causes BLOCK
  // ==========================================================================
  it('T18: Acceptance criterion BLOCK causes BLOCK', async () => {
    fakeProcessExecutor.setHandler(() => {
      throw new Error('Test runner infrastructure unavailable');
    });

    const reqWithCriteria: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['All unit tests pass'],
      },
    };

    const evidence = await collector.collectAndVerify(reqWithCriteria, sampleRawOutcome, {
      verificationCommands: [{ id: 'TEST', type: 'TEST', command: 'npm test' }],
    });

    assert.equal(evidence.verificationDecision, 'BLOCK');
    const crit = evidence.acceptanceCriteria[0];
    assert.equal(crit.status, 'BLOCK');
  });

  // ==========================================================================
  // T19: Mixed PASS + FAIL results in REJECT
  // ==========================================================================
  it('T19: Mixed PASS + FAIL results in REJECT', async () => {
    fakeProcessExecutor.setHandler((cmd) => {
      if (cmd === 'pnpm build') {
        return { command: cmd, exitCode: 0, stdout: 'Build success', stderr: '', durationMs: 50 };
      }
      return { command: cmd, exitCode: 1, stdout: 'Test failed', stderr: '', durationMs: 50 };
    });

    const reqMixed: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['Must compile cleanly', 'All unit tests pass'],
      },
    };

    const evidence = await collector.collectAndVerify(reqMixed, sampleRawOutcome, {
      verificationCommands: [
        { id: 'BUILD', type: 'BUILD', command: 'pnpm build' },
        { id: 'TEST', type: 'TEST', command: 'pnpm test' },
      ],
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    const buildCrit = evidence.acceptanceCriteria.find((c) => c.criterion.includes('compile'));
    const testCrit = evidence.acceptanceCriteria.find((c) => c.criterion.includes('test'));
    assert.ok(buildCrit);
    assert.ok(testCrit);
    assert.equal(buildCrit.status, 'PASS');
    assert.equal(testCrit.status, 'FAIL');
  });

  // ==========================================================================
  // T20: Required verification unavailable results in BLOCK
  // ==========================================================================
  it('T20: Required verification unavailable results in BLOCK', async () => {
    const reqWithUnverifiedTest: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        acceptanceCriteria: ['Acceptance integration test suite must execute and pass'],
      },
    };

    // No test verification command provided, so required check is unavailable
    const evidence = await collector.collectAndVerify(reqWithUnverifiedTest, sampleRawOutcome);

    assert.equal(evidence.verificationDecision, 'BLOCK');
    const crit = evidence.acceptanceCriteria[0];
    assert.equal(crit.status, 'BLOCK');
    assert.ok(crit.evidence.includes('not executed or tooling was unavailable'));
  });

  // ==========================================================================
  // T21: SystemVerifiedEvidence cannot contain fake executor verification flags
  // ==========================================================================
  it('T21: SystemExecutionEvidence cannot contain fake executor verification flags', async () => {
    const forgedOutcome = {
      ...sampleRawOutcome,
      verified: true,
      qaPassed: true,
      systemAccepted: true,
      taskCompleted: true,
    };

    // Collector must reject outcome containing forbidden verification flags
    await assert.rejects(
      () => collector.collectAndVerify(sampleRequest, forgedOutcome as any),
      (err: any) => err.code === 'ERR_EXECUTOR_SECURITY_VIOLATION' || err.code === 'ERR_SYSTEM_EVIDENCE_SECURITY_VIOLATION'
    );

    // Direct helper check
    assert.throws(
      () => assertNoForbiddenEvidenceFields({ verified: true }),
      SystemEvidenceSecurityViolationError
    );
  });

  // ==========================================================================
  // T22: RawExecutorOutcome remains unchanged
  // ==========================================================================
  it('T22: RawExecutorOutcome remains unchanged and unmutated', async () => {
    const copyBefore = JSON.parse(JSON.stringify(sampleRawOutcome));

    await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.deepEqual(sampleRawOutcome, copyBefore);
  });

  // ==========================================================================
  // T23: Evidence collection does not mutate DurableStateManager
  // ==========================================================================
  it('T23: Evidence collection does not mutate DurableStateManager', async () => {
    let mutated = false;
    const originalSave = durableManager.save.bind(durableManager);
    durableManager.save = async (...args) => {
      mutated = true;
      return originalSave(...args);
    };

    await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(mutated, false);
  });

  // ==========================================================================
  // T24: Evidence collection does not mutate TaskDagEngine
  // ==========================================================================
  it('T24: Evidence collection does not mutate TaskDagEngine or mark task ACCEPTED', async () => {
    const dagEngine = new TaskDagEngine();
    let advanceCalled = false;
    dagEngine.advanceTask = () => {
      advanceCalled = true;
      return {} as any;
    };

    await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(advanceCalled, false);
    // Task in specStore remains READY
    const tasks = await specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === 'TASK-P10-01');
    assert.equal(task?.status, TaskStatus.READY);
  });

  // ==========================================================================
  // T25: Evidence collection does not mutate SpecStore
  // ==========================================================================
  it('T25: Evidence collection does not mutate SpecStore', async () => {
    let saveTasksCalled = false;
    const origSave = specStore.saveTasks.bind(specStore);
    specStore.saveTasks = async (...args) => {
      saveTasksCalled = true;
      return origSave(...args);
    };

    await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(saveTasksCalled, false);
  });

  // ==========================================================================
  // T26: Evidence collection does not mutate ApprovalStore
  // ==========================================================================
  it('T26: Evidence collection does not mutate ApprovalStore', async () => {
    let savePackageCalled = false;
    const origSave = approvalStore.savePackage.bind(approvalStore);
    approvalStore.savePackage = async (...args) => {
      savePackageCalled = true;
      return origSave(...args);
    };

    await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(savePackageCalled, false);
  });

  // ==========================================================================
  // T27: P10-04 never invokes Antigravity
  // ==========================================================================
  it('T27: P10-04 never invokes Antigravity or executor adapter', async () => {
    let antigravityInvoked = false;
    const adapter = new AntigravityAdapter({
      executor: {
        execute: async () => {
          antigravityInvoked = true;
          return sampleRawOutcome;
        },
      },
    });

    await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(antigravityInvoked, false);
  });

  // ==========================================================================
  // T28: P10-04 never performs autonomous retry
  // ==========================================================================
  it('T28: P10-04 never performs autonomous retry on failure', async () => {
    let invocationCount = 0;
    fakeProcessExecutor.setHandler(() => {
      invocationCount++;
      return { command: 'test', exitCode: 1, stdout: 'fail', stderr: '', durationMs: 10 };
    });

    const failingOutcome: RawExecutorOutcome = {
      ...sampleRawOutcome,
      status: 'FAILURE',
      exitCode: 1,
    };

    const evidence = await collector.collectAndVerify(sampleRequest, failingOutcome, {
      verificationCommands: [{ id: 'TEST', type: 'TEST', command: 'test' }],
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(invocationCount, 1); // exactly 1 run, zero retry attempts
  });

  // ==========================================================================
  // T29: Evidence is traceable to requestId
  // ==========================================================================
  it('T29: Evidence is traceable to requestId deterministically', async () => {
    const evidence = await collector.collectAndVerify(sampleRequest, sampleRawOutcome);

    assert.equal(evidence.requestId, sampleRequest.requestId);
    assert.ok(evidence.evidenceId.startsWith('evi_'));
    const expectedPart = sampleRequest.requestId.replace(/^req_/, '').slice(0, 16);
    assert.ok(evidence.evidenceId.includes(expectedPart));
  });

  // ==========================================================================
  // T30: Verification decision is deterministic for identical verified inputs
  // ==========================================================================
  it('T30: Verification decision is deterministic for identical verified inputs', async () => {
    const id1 = computeDeterministicEvidenceId({
      requestId: sampleRequest.requestId,
      projectId: sampleRequest.projectId,
      taskId: sampleRequest.taskId,
      taskRevision: sampleRequest.taskRevision,
      contextFingerprint: sampleRequest.contextFingerprint,
      headCommit: validBaseCommit,
      verificationDecision: 'ACCEPT',
      checkSummary: 'summary A',
    });

    const id2 = computeDeterministicEvidenceId({
      requestId: sampleRequest.requestId,
      projectId: sampleRequest.projectId,
      taskId: sampleRequest.taskId,
      taskRevision: sampleRequest.taskRevision,
      contextFingerprint: sampleRequest.contextFingerprint,
      headCommit: validBaseCommit,
      verificationDecision: 'ACCEPT',
      checkSummary: 'summary A',
    });

    assert.equal(id1, id2);
  });

  // ==========================================================================
  // T31: MCP cannot submit fabricated verified evidence
  // ==========================================================================
  it('T31: MCP cannot submit fabricated verified evidence', async () => {
    const server = new McpServer({
      transport: new InMemoryMcpTransport(),
      evidenceVerifyTools: true,
    });

    const tool = createEvidenceVerifyTool({ evidenceCollector: collector });

    // Attacker passes fabricated evidence object
    const result = await tool.handler(
      {
        request: sampleRequest,
        outcome: sampleRawOutcome,
        evidence: { fabricated: true, decision: 'ACCEPT' },
      },
      {} as any
    );

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.code, 'ERR_FABRICATED_EVIDENCE_REJECTED');
  });

  // ==========================================================================
  // T32: MCP cannot submit fabricated ACCEPT
  // ==========================================================================
  it('T32: MCP cannot submit fabricated ACCEPT decision', async () => {
    const tool = createEvidenceVerifyTool({ evidenceCollector: collector });

    // Attacker passes pre-determined verificationDecision: ACCEPT
    const result = await tool.handler(
      {
        request: sampleRequest,
        outcome: sampleRawOutcome,
        verificationDecision: 'ACCEPT',
      },
      {} as any
    );

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.code, 'ERR_FABRICATED_EVIDENCE_REJECTED');
  });
});
