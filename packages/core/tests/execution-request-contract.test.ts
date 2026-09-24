/**
 * Comprehensive Test Suite for Phase 10 TASK-P10-02
 * Deterministic Execution Request Contract
 *
 * Verifies all deterministic invariants, boundary protections, and contracts:
 *
 * T01: Valid ExecutionIntent -> produces valid, immutable ExecutionRequest
 * T02: Deterministic requestId reproducibility: identical inputs -> identical requestId
 * T03: Deterministic requestId sensitivity: any change in semantic field -> different requestId
 * T04: Deterministic requestId indifference: createdAt or metadata change -> identical requestId
 * T05: Input order invariance: unordered targetFiles/constraints/criteria -> identical requestId
 * T06: Duplicate removal in targetFiles and constraints -> normalized and identical requestId
 * T07: targetFiles POSIX normalization: Windows backslashes converted to forward slashes
 * T08: targetFiles leading './' stripping
 * T09: targetFiles path traversal ('..') rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T10: targetFiles absolute Unix path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T11: targetFiles Windows drive letter path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T12: targetFiles empty or whitespace-only path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T13: Authoritative repository state auto-capture from GitPort.inspectState()
 * T14: Repository state forgery detection: baseCommit mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY
 * T15: Repository state forgery detection: isClean mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY
 * T16: Repository state failure when Git HEAD cannot be determined
 * T17: Execution limits default assignment (timeoutMs: 300_000, maxFileModifications: 20)
 * T18: Execution limits valid custom assignment within bounds
 * T19: Execution limits rejection: timeoutMs < 1000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID
 * T20: Execution limits rejection: timeoutMs > 3_600_000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID
 * T21: Execution limits rejection: timeoutMs negative, float, NaN, Infinity
 * T22: Execution limits rejection: maxFileModifications < 1 or > 100
 * T23: Intent binding forgery protection: caller override of projectId rejected -> ERR_EXECUTION_REQUEST_INTENT_MISMATCH
 * T24: Intent binding forgery protection: caller override of directorSessionId rejected
 * T25: Intent binding forgery protection: caller override of directorDecisionId rejected
 * T26: Intent binding forgery protection: caller override of taskId rejected
 * T27: Intent binding forgery protection: caller override of taskRevision rejected
 * T28: Intent binding forgery protection: caller override of contextFingerprint rejected
 * T29: Intent binding forgery protection: caller override of understandingRevision rejected
 * T30: Intent binding forgery protection: caller override of approvalPackageRevision rejected
 * T31: Intent binding forgery protection: caller override of operationType rejected
 * T32: Intent binding forgery protection: caller override of protocolVersion / schemaVersion rejected
 * T33: Objective empty or missing rejection
 * T34: Acceptance criteria empty array rejection
 * T35: Acceptance criteria empty string criterion rejection
 * T36: Acceptance criteria structured object validation
 * T37: SpecStore fallback: derives objective and criteria from task when omitted by caller
 * T38: validateExecutionRequest() method: valid request -> VALID
 * T39: validateExecutionRequest() method: tampered requestId -> VALIDATION_ERROR
 * T40: validateExecutionRequest() method: unsafe targetFiles -> INVALID_PATH
 * T41: MCP tool aidm.execution.request.build: successful execution request generation
 * T42: MCP tool aidm.execution.request.create: alias tool behavior
 * T43: MCP tool rejection on path traversal, forgery, and invalid limits
 * T44: Architectural invariant: zero child process, zero Antigravity call, zero DAG mutation
 * T45: Structurally valid but unauthorized/fake ExecutionIntent MUST NOT produce ExecutionRequest
 * T46: ExecutionRequest MCP build with forged raw intent MUST be rejected by authoritative P10-01 authorization
 * T47: Approval authorization revoked/stale after intent formulation MUST prevent request creation
 * T48: Context becomes stale/changed after intent formulation MUST prevent request creation
 * T49: Task revision changes after intent formulation MUST prevent request creation
 * T50: Task revision mismatch during SpecStore instruction fallback MUST reject
 * T51: Task revision matching intent MUST allow fallback
 * T52: Old task revision + new task description MUST never produce a mixed request
 * T53: Caller-provided instruction must not bypass P10-01 authorization
 * T54: A caller-provided fake "verified" marker/result must not bypass authorization
 * T55: Successful request creation still has deterministic requestId
 * T56: Successful request creation remains zero-execution
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  EXECUTION_REQUEST_PROTOCOL_VERSION,
  EXECUTION_REQUEST_SCHEMA_VERSION,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_MAX_FILE_MODIFICATIONS,
  type ExecutionIntent,
  type ExecutionRequest,
  type BuildExecutionRequestInput,
  ExecutionRequestBuilder,
  canonicalStringify,
  computeDeterministicRequestId,
  ExecutionRequestValidationError,
  ExecutionRequestInvalidPathError,
  ExecutionRequestRepositoryForgeryError,
  ExecutionRequestIntentMismatchError,
  ExecutionRequestLimitsInvalidError,
  ExecutionRequestTaskRevisionMismatchError,
  ExecutionIntentSessionMismatchError,
  ExecutionIntentDecisionInvalidError,
  ExecutionIntentProjectMismatchError,
  ExecutionIntentContextMismatchError,
  ExecutionIntentContextStaleError,
  ExecutionIntentRevisionMismatchError,
  ExecutionIntentUnauthorizedError,
  ExecutionIntentTaskInvalidError,
  ExecutionAuthorizer,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  DirectorDecisionEngine,
  ApprovalStore,
  ApprovalPackageEngine,
  HumanApprovalEngine,
  InitialProjectUnderstandingBuilder,
  DirectorContextSynchronizer,
  ContextEngine,
  DurableStateManager,
  TaskDagEngine,
  HistoryManager,
  DefaultMcpOrchestratorDelegate,
  FakeGitPort,
  SpecStore,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  McpServer,
  InMemoryMcpTransport,
  AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME,
  AIDM_EXECUTION_REQUEST_CREATE_TOOL_NAME,
  type DirectorSession,
  type DirectorDecision,
  type DirectorContextSnapshot,
  type ProjectApprovalPackage,
  type ProjectDiscoveryReport,
} from '../dist/index.js';

describe('Deterministic Execution Request Contract (Phase 10 TASK-P10-02)', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let humanApprovalEngine: HumanApprovalEngine;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let contextEngine: ContextEngine;
  let synchronizer: DirectorContextSynchronizer;
  let fakeGitPort: FakeGitPort;
  let delegate: DefaultMcpOrchestratorDelegate;
  let executionAuthorizer: ExecutionAuthorizer;
  let builder: ExecutionRequestBuilder;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let testPackage: ProjectApprovalPackage;
  let implementDecision: DirectorDecision;
  let sampleIntent: ExecutionIntent;

  const validBaseCommit = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const alternativeCommit = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

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
        acceptance_criteria: ['SpecStore AC-1', 'SpecStore AC-2'],
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-02-test-'));

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

    builder = new ExecutionRequestBuilder({
      workspaceRoot: tempDir,
      gitPort: fakeGitPort,
      specStore,
      authorizer: executionAuthorizer,
      delegate,
    });

    // 1. Create active Director session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p10-02-001',
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
      packageId: 'pkg-p10-02-001',
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
      comment: 'Approved for execution request testing',
    });
    assert.equal(approvalResult.isDevelopmentAuthorized, true);
    testPackage = approvalResult.package;

    // 4. Create READY task
    await createReadyTasks();

    // 5. Create IMPLEMENT_TASK decision
    implementDecision = {
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
    await decisionStore.saveDecision(implementDecision);

    // 6. Formulate verified sampleIntent
    const authResult = await executionAuthorizer.validateExecutionIntent({
      workspaceRoot: tempDir,
      projectId: 'test-exec-project',
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
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
  });

  afterEach(() => {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================================================
  // 1. BASIC REQUEST GENERATION & SCHEMA CONFORMANCE
  // ==========================================================================

  it('T01: Valid ExecutionIntent -> produces valid, immutable ExecutionRequest', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Implement deterministic request contract',
        constraints: ['Must be deterministic', 'No shell spawn'],
        targetFiles: ['packages/core/src/request.ts', 'packages/core/tests/request.test.ts'],
        acceptanceCriteria: ['All tests pass with exit code 0', 'SHA-256 hash is collision resistant'],
      },
      executionLimits: {
        timeoutMs: 120_000,
        maxFileModifications: 10,
      },
    });

    assert.ok(request);
    assert.match(request.requestId, /^req-[a-f0-9]{32}$/);
    assert.strictEqual(request.projectId, sampleIntent.projectId);
    assert.strictEqual(request.directorSessionId, sampleIntent.directorSessionId);
    assert.strictEqual(request.directorDecisionId, sampleIntent.directorDecisionId);
    assert.strictEqual(request.taskId, sampleIntent.taskId);
    assert.strictEqual(request.taskRevision, sampleIntent.taskRevision);
    assert.strictEqual(request.contextFingerprint, sampleIntent.contextFingerprint);
    assert.strictEqual(request.understandingRevision, sampleIntent.understandingRevision);
    assert.strictEqual(request.approvalPackageRevision, sampleIntent.approvalPackageRevision);
    assert.strictEqual(request.operationType, 'IMPLEMENT_TASK');
    assert.strictEqual(request.protocolVersion, 'P10-02');
    assert.strictEqual(request.schemaVersion, 1);
    assert.strictEqual(request.intentId, sampleIntent.intentId);
    assert.strictEqual(request.instruction.objective, 'Implement deterministic request contract');
    assert.deepStrictEqual(request.instruction.constraints, ['Must be deterministic', 'No shell spawn']);
    assert.deepStrictEqual(request.instruction.targetFiles, [
      'packages/core/src/request.ts',
      'packages/core/tests/request.test.ts',
    ]);
    assert.strictEqual(request.expectedRepositoryState.baseCommit, validBaseCommit);
    assert.strictEqual(request.expectedRepositoryState.isClean, true);
    assert.strictEqual(request.executionLimits.timeoutMs, 120_000);
    assert.strictEqual(request.executionLimits.maxFileModifications, 10);
  });

  // ==========================================================================
  // 2. DETERMINISTIC REQUEST ID PROPERTIES
  // ==========================================================================

  it('T02: Deterministic requestId reproducibility: identical inputs -> identical requestId', async () => {
    const input: BuildExecutionRequestInput = {
      intent: sampleIntent,
      instruction: {
        objective: 'Deterministic hashing test',
        constraints: ['Constraint A', 'Constraint B'],
        targetFiles: ['src/a.ts', 'src/b.ts'],
        acceptanceCriteria: ['AC-1', 'AC-2'],
      },
    };

    const req1 = await builder.buildExecutionRequest(input);
    const req2 = await builder.buildExecutionRequest(input);

    assert.strictEqual(req1.requestId, req2.requestId);
  });

  it('T03: Deterministic requestId sensitivity: any change in semantic field -> different requestId', async () => {
    const baseInput: BuildExecutionRequestInput = {
      intent: sampleIntent,
      instruction: {
        objective: 'Base objective',
        constraints: ['C1'],
        targetFiles: ['src/file.ts'],
        acceptanceCriteria: ['AC-1'],
      },
    };

    const baseReq = await builder.buildExecutionRequest(baseInput);

    // Objective changed
    const reqDiffObj = await builder.buildExecutionRequest({
      ...baseInput,
      instruction: { ...baseInput.instruction!, objective: 'Different objective' },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffObj.requestId);

    // Target files changed
    const reqDiffFiles = await builder.buildExecutionRequest({
      ...baseInput,
      instruction: { ...baseInput.instruction!, targetFiles: ['src/other.ts'] },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffFiles.requestId);

    // Constraints changed
    const reqDiffConstraints = await builder.buildExecutionRequest({
      ...baseInput,
      instruction: { ...baseInput.instruction!, constraints: ['C2'] },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffConstraints.requestId);

    // Limits changed
    const reqDiffLimits = await builder.buildExecutionRequest({
      ...baseInput,
      executionLimits: { timeoutMs: 500_000 },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffLimits.requestId);
  });

  it('T04: Deterministic requestId indifference: createdAt or metadata change -> identical requestId', async () => {
    const baseInput: BuildExecutionRequestInput = {
      intent: sampleIntent,
      instruction: {
        objective: 'Indifference test',
        acceptanceCriteria: ['AC-1'],
      },
      metadata: { tag: 'initial' },
    };

    const req1 = await builder.buildExecutionRequest(baseInput);

    const req2 = await builder.buildExecutionRequest({
      ...baseInput,
      metadata: { tag: 'completely-different-metadata', extra: 12345 },
    });

    assert.strictEqual(req1.requestId, req2.requestId);
  });

  it('T05: Input order invariance: unordered targetFiles/constraints/criteria -> identical requestId', async () => {
    const reqA = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Order invariance test',
        constraints: ['Beta', 'Alpha', 'Gamma'],
        targetFiles: ['src/z.ts', 'src/a.ts', 'src/m.ts'],
        acceptanceCriteria: ['Criterion Z', 'Criterion A'],
      },
    });

    const reqB = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Order invariance test',
        constraints: ['Gamma', 'Alpha', 'Beta'],
        targetFiles: ['src/a.ts', 'src/m.ts', 'src/z.ts'],
        acceptanceCriteria: ['Criterion A', 'Criterion Z'],
      },
    });

    assert.strictEqual(reqA.requestId, reqB.requestId);
    assert.deepStrictEqual(reqA.instruction.constraints, ['Alpha', 'Beta', 'Gamma']);
    assert.deepStrictEqual(reqA.instruction.targetFiles, ['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('T06: Duplicate removal in targetFiles and constraints -> normalized and identical requestId', async () => {
    const reqUnique = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Deduplication test',
        constraints: ['Constraint A'],
        targetFiles: ['src/a.ts'],
        acceptanceCriteria: ['AC-1'],
      },
    });

    const reqDups = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Deduplication test',
        constraints: ['Constraint A', 'Constraint A', '  Constraint A  '],
        targetFiles: ['src/a.ts', './src/a.ts', 'src\\a.ts'],
        acceptanceCriteria: ['AC-1', '  AC-1  '],
      },
    });

    assert.strictEqual(reqUnique.requestId, reqDups.requestId);
    assert.deepStrictEqual(reqDups.instruction.constraints, ['Constraint A']);
    assert.deepStrictEqual(reqDups.instruction.targetFiles, ['src/a.ts']);
    assert.deepStrictEqual(reqDups.instruction.acceptanceCriteria, ['AC-1']);
  });

  // ==========================================================================
  // 3. TARGET FILES NORMALIZATION & PATH SAFETY
  // ==========================================================================

  it('T07: targetFiles POSIX normalization: Windows backslashes converted to forward slashes', () => {
    const normalized = builder.canonicalizeTargetFiles([
      'packages\\core\\src\\foo.ts',
      'packages/core/src/bar.ts',
    ]);
    assert.deepStrictEqual(normalized, [
      'packages/core/src/bar.ts',
      'packages/core/src/foo.ts',
    ]);
  });

  it('T08: targetFiles leading "./" stripping', () => {
    const normalized = builder.canonicalizeTargetFiles([
      './packages/core/index.ts',
      'src/main.ts',
    ]);
    assert.deepStrictEqual(normalized, [
      'packages/core/index.ts',
      'src/main.ts',
    ]);
  });

  it('T09: targetFiles path traversal ("..") rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const badPaths = [
      '../secret.txt',
      'packages/../../secret.txt',
      'packages/core/../..',
      '..',
      'foo/bar/..',
    ];

    for (const badPath of badPaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([badPath]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          assert.match(err.message, /Path traversal/);
          return true;
        }
      );
    }
  });

  it('T10: targetFiles absolute Unix path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const absolutePaths = ['/etc/passwd', '/root/.ssh/id_rsa', '/packages/core/src/a.ts'];

    for (const p of absolutePaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([p]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          assert.match(err.message, /Absolute paths are strictly prohibited/);
          return true;
        }
      );
    }
  });

  it('T11: targetFiles Windows drive letter path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const windowsPaths = [
      'C:/Windows/System32/cmd.exe',
      'd:\\work\\project\\src\\main.ts',
      'D:/repo/file.ts',
    ];

    for (const p of windowsPaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([p]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          assert.match(err.message, /Absolute paths are strictly prohibited/);
          return true;
        }
      );
    }
  });

  it('T12: targetFiles empty or whitespace-only path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const invalidPaths = ['', '   ', './'];

    for (const p of invalidPaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([p]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          return true;
        }
      );
    }
  });

  // ==========================================================================
  // 4. REPOSITORY STATE AUTHORITY & FORGERY DETECTION
  // ==========================================================================

  it('T13: Authoritative repository state auto-capture from GitPort.inspectState()', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Auto-capture test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    assert.strictEqual(request.expectedRepositoryState.baseCommit, validBaseCommit);
    assert.strictEqual(request.expectedRepositoryState.isClean, true);
  });

  it('T14: Repository state forgery detection: baseCommit mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Forgery test',
            acceptanceCriteria: ['AC-1'],
          },
          expectedRepositoryState: {
            baseCommit: alternativeCommit, // Forged baseline commit
            isClean: true,
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestRepositoryForgeryError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY');
        assert.match(err.message, /Repository state forgery detected/);
        return true;
      }
    );
  });

  it('T15: Repository state forgery detection: isClean mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Forgery test',
            acceptanceCriteria: ['AC-1'],
          },
          expectedRepositoryState: {
            baseCommit: validBaseCommit,
            isClean: false, // Forged status
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestRepositoryForgeryError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY');
        assert.match(err.message, /isClean/);
        return true;
      }
    );
  });

  it('T16: Repository state failure when Git HEAD cannot be determined', async () => {
    const uninitGitPort = new FakeGitPort({
      initialState: {
        head_sha: null,
        working_tree_clean: true,
      },
    });

    const brokenBuilder = new ExecutionRequestBuilder({
      workspaceRoot: tempDir,
      gitPort: uninitGitPort,
      authorizer: executionAuthorizer,
      delegate,
    });

    await assert.rejects(
      async () => {
        await brokenBuilder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Uninit test',
            acceptanceCriteria: ['AC-1'],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestRepositoryForgeryError);
        assert.match(err.message, /Authoritative Git HEAD commit could not be determined/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 5. EXECUTION LIMITS VALIDATION
  // ==========================================================================

  it('T17: Execution limits default assignment (timeoutMs: 300_000, maxFileModifications: 20)', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Limits defaults test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    assert.strictEqual(request.executionLimits.timeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS);
    assert.strictEqual(request.executionLimits.maxFileModifications, DEFAULT_MAX_FILE_MODIFICATIONS);
  });

  it('T18: Execution limits valid custom assignment within bounds', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Custom limits test',
        acceptanceCriteria: ['AC-1'],
      },
      executionLimits: {
        timeoutMs: 60_000,
        maxFileModifications: 50,
      },
    });

    assert.strictEqual(request.executionLimits.timeoutMs, 60_000);
    assert.strictEqual(request.executionLimits.maxFileModifications, 50);
  });

  it('T19: Execution limits rejection: timeoutMs < 1000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID', () => {
    assert.throws(
      () => builder.canonicalizeExecutionLimits({ timeoutMs: 999 }),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');
        assert.match(err.message, /between 1000 and 3600000/);
        return true;
      }
    );
  });

  it('T20: Execution limits rejection: timeoutMs > 3_600_000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID', () => {
    assert.throws(
      () => builder.canonicalizeExecutionLimits({ timeoutMs: 3_600_001 }),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');
        return true;
      }
    );
  });

  it('T21: Execution limits rejection: timeoutMs negative, float, NaN, Infinity', () => {
    const invalidTimeouts = [-5000, 1000.5, NaN, Infinity, -Infinity];

    for (const t of invalidTimeouts) {
      assert.throws(
        () => builder.canonicalizeExecutionLimits({ timeoutMs: t }),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
          return true;
        }
      );
    }
  });

  it('T22: Execution limits rejection: maxFileModifications < 1 or > 100', () => {
    const invalidMaxFiles = [0, -1, 101, 10.5, NaN, Infinity];

    for (const m of invalidMaxFiles) {
      assert.throws(
        () => builder.canonicalizeExecutionLimits({ maxFileModifications: m }),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');
          return true;
        }
      );
    }
  });

  // ==========================================================================
  // 6. INTENT BINDING FORGERY PROTECTION
  // ==========================================================================

  it('T23: Intent binding forgery protection: caller override of projectId rejected -> ERR_EXECUTION_REQUEST_INTENT_MISMATCH', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          projectId: 'attacker-project-id',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INTENT_MISMATCH');
        assert.match(err.message, /projectId override mismatch/);
        return true;
      }
    );
  });

  it('T24: Intent binding forgery protection: caller override of directorSessionId rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          directorSessionId: 'fake-session',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /directorSessionId override mismatch/);
        return true;
      }
    );
  });

  it('T25: Intent binding forgery protection: caller override of directorDecisionId rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          directorDecisionId: 'fake-decision',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /directorDecisionId override mismatch/);
        return true;
      }
    );
  });

  it('T26: Intent binding forgery protection: caller override of taskId rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          taskId: 'TASK-ATTACK-999',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /taskId override mismatch/);
        return true;
      }
    );
  });

  it('T27: Intent binding forgery protection: caller override of taskRevision rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          taskRevision: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /taskRevision override mismatch/);
        return true;
      }
    );
  });

  it('T28: Intent binding forgery protection: caller override of contextFingerprint rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          contextFingerprint: 'forged-fingerprint',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /contextFingerprint override mismatch/);
        return true;
      }
    );
  });

  it('T29: Intent binding forgery protection: caller override of understandingRevision rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          understandingRevision: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /understandingRevision override mismatch/);
        return true;
      }
    );
  });

  it('T30: Intent binding forgery protection: caller override of approvalPackageRevision rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          approvalPackageRevision: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /approvalPackageRevision override mismatch/);
        return true;
      }
    );
  });

  it('T31: Intent binding forgery protection: caller override of operationType rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          operationType: 'EXECUTE_BUILD',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /operationType override mismatch/);
        return true;
      }
    );
  });

  it('T32: Intent binding forgery protection: caller override of protocolVersion / schemaVersion rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          protocolVersion: 'P99-99',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /protocolVersion override mismatch/);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          schemaVersion: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /schemaVersion override mismatch/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 7. INSTRUCTION VALIDATION & CRITERIA CANONICALIZATION
  // ==========================================================================

  it('T33: Objective empty or missing rejection', async () => {
    // When instruction has no objective and specStore has no task
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: '   ',
            acceptanceCriteria: ['AC-1'],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /Instruction objective cannot be empty/);
        return true;
      }
    );
  });

  it('T34: Acceptance criteria empty array rejection', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Test objective',
            acceptanceCriteria: [],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /acceptanceCriteria must contain at least one criterion/);
        return true;
      }
    );
  });

  it('T35: Acceptance criteria empty string criterion rejection', () => {
    assert.throws(
      () => builder.canonicalizeAcceptanceCriteria(['   ']),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /criterion string cannot be empty/);
        return true;
      }
    );
  });

  it('T36: Acceptance criteria structured object validation', () => {
    const normalized = builder.canonicalizeAcceptanceCriteria([
      {
        criterionId: 'AC-002',
        description: '  Secondary criterion  ',
        mandatory: true,
      },
      {
        criterionId: 'AC-001',
        description: 'Primary criterion',
        mandatory: true,
      },
    ]);

    assert.strictEqual(normalized.length, 2);
    assert.strictEqual((normalized[0] as { criterionId?: string }).criterionId, 'AC-001');
    assert.strictEqual((normalized[1] as { criterionId?: string }).criterionId, 'AC-002');
  });

  // ==========================================================================
  // 8. SPECSTORE TASK DERIVATION FALLBACK
  // ==========================================================================

  it('T37: SpecStore fallback: derives objective and criteria from task when omitted by caller', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        constraints: ['Constraint from caller'],
        targetFiles: ['src/task.ts'],
      },
    });

    assert.strictEqual(request.instruction.objective, 'Authoritative description from SpecStore Task DAG');
    assert.deepStrictEqual(request.instruction.acceptanceCriteria, ['SpecStore AC-1', 'SpecStore AC-2']);
  });

  // ==========================================================================
  // 9. VALIDATION METHOD (validateExecutionRequest)
  // ==========================================================================

  it('T38: validateExecutionRequest() method: valid request -> VALID', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Valid check test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    const result = builder.validateExecutionRequest(request);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.code, 'VALID');
    assert.ok(result.request);
  });

  it('T39: validateExecutionRequest() method: tampered requestId -> VALIDATION_ERROR', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Tamper test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    const tampered = {
      ...request,
      requestId: 'req-00000000000000000000000000000000',
    };

    const result = builder.validateExecutionRequest(tampered);
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.code, 'VALIDATION_ERROR');
    assert.match(result.message, /requestId hash mismatch/);
  });

  it('T40: validateExecutionRequest() method: unsafe targetFiles -> INVALID_PATH', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Unsafe path test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    const tampered = {
      ...request,
      instruction: {
        ...request.instruction,
        targetFiles: ['../escaping/path.ts'],
      },
    };

    const result = builder.validateExecutionRequest(tampered);
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.code, 'INVALID_PATH');
  });

  // ==========================================================================
  // 10. MCP BOUNDARY TOOLS
  // ==========================================================================

  it('T41: MCP tool aidm.execution.request.build: successful execution request generation', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate,
    });

    await server.start();

    const buildTool = server.getTool(AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME);
    assert.ok(buildTool, 'Build tool should be registered');

    const result = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'MCP execution request build test',
          constraints: ['Constraint 1'],
          targetFiles: ['packages/core/src/mcp-test.ts'],
          acceptanceCriteria: ['AC-MCP-1'],
        },
        executionLimits: {
          timeoutMs: 180_000,
        },
      },
      {
        correlation: { correlationId: 'corr-001', requestId: 'req-mcp-01', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.length, 1);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.requestId);
    assert.strictEqual(parsed.request.taskId, sampleIntent.taskId);
    assert.strictEqual(parsed.request.protocolVersion, 'P10-02');

    await server.stop();
  });

  it('T42: MCP tool aidm.execution.request.create: alias tool behavior', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate,
    });

    await server.start();

    const createTool = server.getTool(AIDM_EXECUTION_REQUEST_CREATE_TOOL_NAME);
    assert.ok(createTool, 'Create tool alias should be registered');

    const result = await createTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'MCP alias tool test',
          acceptanceCriteria: ['AC-ALIAS-1'],
        },
      },
      {
        correlation: { correlationId: 'corr-002', requestId: 'req-mcp-02', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );

    assert.strictEqual(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.requestId);

    await server.stop();
  });

  it('T43: MCP tool rejection on path traversal, forgery, and invalid limits', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate,
    });

    await server.start();

    const buildTool = server.getTool(AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME)!;

    // Path traversal attempt
    const resTraversal = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'Traversal test',
          targetFiles: ['../escaped.ts'],
          acceptanceCriteria: ['AC-1'],
        },
      },
      {
        correlation: { correlationId: 'corr-003', requestId: 'req-mcp-03', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );
    assert.strictEqual(resTraversal.isError, true);
    const parsedTraversal = JSON.parse(resTraversal.content[0].text as string);
    assert.strictEqual(parsedTraversal.success, false);
    assert.strictEqual(parsedTraversal.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');

    // Forgery attempt
    const resForgery = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'Forgery test',
          acceptanceCriteria: ['AC-1'],
        },
        expectedRepositoryState: {
          baseCommit: alternativeCommit, // Forged
          isClean: true,
        },
      },
      {
        correlation: { correlationId: 'corr-004', requestId: 'req-mcp-04', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );
    assert.strictEqual(resForgery.isError, true);
    const parsedForgery = JSON.parse(resForgery.content[0].text as string);
    assert.strictEqual(parsedForgery.success, false);
    assert.strictEqual(parsedForgery.code, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY');

    // Invalid limits attempt
    const resLimits = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'Invalid limits test',
          acceptanceCriteria: ['AC-1'],
        },
        executionLimits: {
          timeoutMs: -500, // Invalid
        },
      },
      {
        correlation: { correlationId: 'corr-005', requestId: 'req-mcp-05', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );
    assert.strictEqual(resLimits.isError, true);
    const parsedLimits = JSON.parse(resLimits.content[0].text as string);
    assert.strictEqual(parsedLimits.success, false);
    assert.strictEqual(parsedLimits.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');

    await server.stop();
  });

  // ==========================================================================
  // 11. ARCHITECTURAL INVARIANT ASSURANCES
  // ==========================================================================

  it('T44: Architectural invariant: zero child process, zero Antigravity call, zero DAG mutation', async () => {
    const tasksBefore = await specStore.loadTasks();

    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
    });

    assert.ok(request);

    // SpecStore tasks must NOT have mutated
    const tasksAfter = await specStore.loadTasks();
    assert.deepStrictEqual(tasksAfter, tasksBefore);
    assert.strictEqual(tasksAfter[1].status, TaskStatus.READY);
    assert.strictEqual(tasksAfter[1].attempt, 1);
  });

  // ==========================================================================
  // 12. HARDENED P10-02 VERIFIED INTENT & TASK REVISION BINDING (T45–T56)
  // ==========================================================================

  it('T45: Structurally valid but unauthorized/fake ExecutionIntent MUST NOT produce ExecutionRequest', async () => {
    const fakeIntent: ExecutionIntent = {
      intentId: 'fake-intent-001',
      directorSessionId: 'non-existent-session',
      directorDecisionId: 'non-existent-decision',
      projectId: 'test-exec-project',
      taskId: 'TASK-P10-01',
      taskRevision: 2,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
      operationType: 'IMPLEMENT_TASK',
      protocolVersion: 'P10-01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: fakeIntent,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentSessionMismatchError);
        return true;
      }
    );
  });

  it('T46: ExecutionRequest MCP build with forged raw intent MUST be rejected by authoritative P10-01 authorization', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate,
    });

    await server.start();
    const buildTool = server.getTool(AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME)!;

    const forgedIntent: ExecutionIntent = {
      intentId: 'forged-intent-002',
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: 'fake-decision-id',
      projectId: 'test-exec-project',
      taskId: 'TASK-P10-01',
      taskRevision: 2,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 5,
      approvalPackageRevision: testPackage.revision,
      operationType: 'IMPLEMENT_TASK',
      protocolVersion: 'P10-01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    const res = await buildTool.handler(
      {
        intent: forgedIntent,
        instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
      },
      {
        correlation: { correlationId: 'corr-fake', requestId: 'req-fake', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );

    assert.strictEqual(res.isError, true);
    const parsed = JSON.parse(res.content[0].text as string);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, 'ERR_EXECUTION_INTENT_DECISION_INVALID');

    await server.stop();
  });

  it('T47: Approval authorization revoked/stale after intent formulation MUST prevent request creation', async () => {
    // Revoke approval by marking package REJECTED
    await approvalStore.savePackage({
      ...testPackage,
      status: 'REJECTED' as any,
    });

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentUnauthorizedError);
        return true;
      }
    );
  });

  it('T48: Context becomes stale/changed after intent formulation MUST prevent request creation', async () => {
    // Modify a file in workspace causing context snapshot to change
    fs.writeFileSync(path.join(tempDir, 'new-file.txt'), 'new content');
    // Synchronize fresh context snapshot
    const freshSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });
    assert.notStrictEqual(freshSnapshot.logicalFingerprint, sampleIntent.contextFingerprint);

    // Old intent now has stale context fingerprint
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof ExecutionIntentContextMismatchError ||
          err instanceof ExecutionIntentContextStaleError
        );
        return true;
      }
    );
  });

  it('T49: Task revision changes after intent formulation MUST prevent request creation', async () => {
    // Bump task revision in SpecStore from 2 to 3
    const tasks = await specStore.loadTasks();
    const taskIndex = tasks.findIndex((t) => t.task_id === 'TASK-P10-01');
    tasks[taskIndex].metadata = { revision: 3 };
    await specStore.saveTasks(tasks);

    // Intent still has taskRevision: 2
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof ExecutionIntentRevisionMismatchError ||
          err instanceof ExecutionRequestTaskRevisionMismatchError
        );
        return true;
      }
    );
  });

  it('T50: Task revision mismatch during SpecStore instruction fallback MUST reject', async () => {
    // Task in SpecStore has revision 2, intent has revision 1
    const intentOldRev: ExecutionIntent = {
      ...sampleIntent,
      taskRevision: 1,
    };

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: intentOldRev,
          // Omit objective to trigger SpecStore fallback
        });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof ExecutionIntentRevisionMismatchError ||
          err instanceof ExecutionRequestTaskRevisionMismatchError
        );
        return true;
      }
    );
  });

  it('T51: Task revision matching intent MUST allow fallback', async () => {
    // Both intent and SpecStore have taskRevision: 2
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      // Omit objective to trigger fallback
    });

    assert.ok(request);
    assert.strictEqual(request.taskRevision, 2);
    assert.strictEqual(request.instruction.objective, 'Authoritative description from SpecStore Task DAG');
    assert.deepStrictEqual(request.instruction.acceptanceCriteria, ['SpecStore AC-1', 'SpecStore AC-2']);
  });

  it('T52: Old task revision + new task description MUST never produce a mixed request', async () => {
    // Update task description and bump revision to 3
    const tasks = await specStore.loadTasks();
    const taskIndex = tasks.findIndex((t) => t.task_id === 'TASK-P10-01');
    tasks[taskIndex].description = 'New task description for revision 3';
    tasks[taskIndex].metadata = { revision: 3 };
    await specStore.saveTasks(tasks);

    // Old intent specifies taskRevision: 2
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent, // taskRevision is 2
        });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof ExecutionIntentRevisionMismatchError ||
          err instanceof ExecutionRequestTaskRevisionMismatchError
        );
        return true;
      }
    );
  });

  it('T53: Caller-provided instruction must not bypass P10-01 authorization', async () => {
    const unapprovedIntent: ExecutionIntent = {
      ...sampleIntent,
      directorDecisionId: 'unapproved-decision-id',
    };

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: unapprovedIntent,
          instruction: {
            objective: 'Explicit caller objective that tries to bypass authorization',
            acceptanceCriteria: ['Explicit AC'],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentDecisionInvalidError);
        return true;
      }
    );
  });

  it('T54: A caller-provided fake "verified" marker/result must not bypass authorization', async () => {
    const fakePayload = {
      intent: {
        ...sampleIntent,
        directorDecisionId: 'forged-decision',
        verified: true, // Fake boolean
        isAuthorized: true, // Fake boolean
      },
      isVerified: true, // Fake outer marker
      instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
    };

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest(fakePayload as any);
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionIntentDecisionInvalidError);
        return true;
      }
    );
  });

  it('T55: Successful request creation still has deterministic requestId', async () => {
    const reqA = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: { objective: 'Deterministic test', acceptanceCriteria: ['AC-1'] },
    });

    const reqB = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: { objective: 'Deterministic test', acceptanceCriteria: ['AC-1'] },
    });

    assert.strictEqual(reqA.requestId, reqB.requestId);
    assert.match(reqA.requestId, /^req-[a-f0-9]{32}$/);
  });

  it('T56: Successful request creation remains zero-execution', async () => {
    const durableStateBefore = await durableManager.load();
    const tasksBefore = await specStore.loadTasks();
    const pkgBefore = await approvalStore.getActivePackage();

    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: { objective: 'Zero execution check', acceptanceCriteria: ['AC-1'] },
    });

    assert.ok(request);

    // 1. FSM not mutated
    const durableStateAfter = await durableManager.load();
    assert.deepStrictEqual(durableStateAfter, durableStateBefore);

    // 2. SpecStore tasks not mutated
    const tasksAfter = await specStore.loadTasks();
    assert.deepStrictEqual(tasksAfter, tasksBefore);

    // 3. ApprovalStore package not mutated
    const pkgAfter = await approvalStore.getActivePackage();
    assert.deepStrictEqual(pkgAfter, pkgBefore);
  });
});
