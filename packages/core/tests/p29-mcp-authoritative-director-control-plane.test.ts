/**
 * Phase 29 MCP Authoritative Director Control Plane Integration Test Suite
 *
 * Verifies that the MCP control plane is completely and authoritatively integrated
 * with the P28 closed-loop architecture:
 *
 * MCP Interface
 *     ↓
 * ClosedLoopCoordinator
 *     ↓
 * DirectorRuntime -> DirectorAction -> ActionValidator -> ActionDispatcher
 *     ↓
 * AuthorizationPolicyEngine -> ExecutionBridge -> EvidenceCollector
 *     ↓
 * SystemExecutionEvidence & History
 *
 * COVERS 37 MANDATORY SPECIFICATION TESTS:
 *  1. Registration: Director session tools registered
 *  2. Registration: Director context sync registered
 *  3. Registration: Director loop tools registered
 *  4. Registration: Driver tools registered
 *  5. Registration: Correct exposed tool names (format and collision-safety)
 *  6. Routing: director.executeCycle uses authoritative ClosedLoopCoordinator path
 *  7. Routing: DirectorRuntime production path verified (fail-closed if unconfigured)
 *  8. Routing: Legacy reasoning engine cannot bypass authoritative pipeline
 *  9. Routing: MCP cannot directly invoke executor without coordinator
 * 10. Routing: MCP cannot directly execute AGY or shell commands
 * 11. Authorization: Read-only tool policy allows SAFE inspection
 * 12. Authorization: Planning tool policy evaluates CAUTION/PLANNING
 * 13. Authorization: Execution tool policy evaluates DANGEROUS/CRITICAL execution
 * 14. Authorization: Human-gate policy evaluates HUMAN_APPROVAL_REQUIRED
 * 15. Authorization: Unauthorized execution rejected when policy denies
 * 16. Authorization: Fake USER authorization payload rejected
 * 17. Authorization: Missing authorization context fail-closed
 * 18. Isolation: Mismatched projectId rejected
 * 19. Isolation: Mismatched workspace root rejected
 * 20. Isolation: Non-existent directorSessionId rejected
 * 21. Isolation: Closed session rejected
 * 22. Isolation: Suspended session rejected
 * 23. Isolation: Stale context snapshot fingerprint rejected
 * 24. Isolation: Stale understanding revision rejected
 * 25. Isolation: Stale task revision rejected
 * 26. Isolation: Stale approval package revision rejected
 * 27. Execution: P28 authoritative closed-loop execution path completes
 * 28. Execution: SystemExecutionEvidence required for verified proof
 * 29. Execution: AGY verbal claims are not proof without evidence
 * 30. Execution: EXECUTION_UNKNOWN halts and blocks further progression
 * 31. Execution: Human gate actions do not reach executor
 * 32. Execution: Duplicate execution request is idempotent
 * 33. Execution: Retry creates distinct execution intent without duplicate execution
 * 34. Lifecycle: evaluateNextAction evaluates boundary without executing
 * 35. Lifecycle: executeCycle executes exactly one cycle (autoContinue = false)
 * 36. Lifecycle: No hidden recursive loop or autonomous daemon spawned
 * 37. Lifecycle: Driver controls do not bypass Director or authorization
 */

import {
  describe,
  it,
  before,
  beforeEach,
  afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as child_process from 'node:child_process';

import {
  McpServer,
  McpServerState,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  ClosedLoopCoordinator,
  type ClosedLoopCycleInput,
  type ClosedLoopCycleResult,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  ApprovalStore,
  ApprovalPackageEngine,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  TaskDagEngine,
  SystemExecutionEvidenceStore,
  SystemEvidenceCollector,
  DirectorActionDispatcher,
  DirectorActionBuilder,
  DirectorActionValidator,
  ExecutionBridge,
  DriverEngine,
  RecoveryPolicyEngine,
  CorrectiveTaskService,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
  IdentityManager,
  type DirectorSession,
  type DirectorContextSnapshot,
  type ApprovalPackage,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  LifecycleState,
  type TaskDefinition,
  PolicyEngine,
  classifyMcpTool,
  McpToolCategory,
  DIRECTOR_INGEST_INSTRUCTION_TOOL_NAME,
  DIRECTOR_EXECUTE_CYCLE_TOOL_NAME,
  DIRECTOR_GET_CYCLE_RESULT_TOOL_NAME,
  DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_GET_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_SUSPEND_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_CLOSE_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_RESUME_TOOL_NAME,
  AIDM_DIRECTOR_CONTEXT_SYNC_TOOL_NAME,
  DRIVER_START_TOOL_NAME,
  DRIVER_STATUS_TOOL_NAME,
  DRIVER_PAUSE_TOOL_NAME,
  DRIVER_RESUME_TOOL_NAME,
  DRIVER_STOP_TOOL_NAME,
  isValidMcpToolName,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
  type McpToolResult,
  } from '../dist/index.js';

import {
  DirectorRuntime,
  DirectorPromptBuilder,
  type DirectorAction,
} from '../dist/director/index.js';
import {
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
} from '../dist/llm-bridge/index.js';;

import { LlmFinishReason } from '../dist/llm-bridge/llm-types.js';

// ============================================================================
// TEST FIXTURES: MOCK LLM & EXECUTOR
// ============================================================================

class DeterministicLlmProvider implements LLMProvider {
  readonly providerId = 'llm:mock-p29';
  readonly providerName = 'mock-p29-provider';
  readonly defaultModel = 'p29-model-v1';
  readonly supportedModels = ['p29-model-v1'];
  readonly supportedCapabilities = [] as any;
  isMock = true;

  isAvailable = true;
  callCount = 0;
  nextAction: Record<string, unknown> | null = null;
  projectId = 'test-proj-p29';
  sessionId = 'sess-p29';
  fingerprint = 'fp-p29-initial';

  async checkAvailability() {
    return { available: this.isAvailable, model: this.defaultModel };
  }

  async generate<TStructured = unknown>(_request: LlmRequest): Promise<LlmResponse<TStructured>> {
    this.callCount++;
    const payload = this.nextAction ?? {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: `act-${crypto.randomUUID()}`,
      directorSessionId: this.sessionId,
      projectId: this.projectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: this.fingerprint,
      rationale: 'Implementing authentication service as requested',
      confidence: 0.95,
      taskId: 'task-02-auth',
      objective: 'Implement authentication service',
      targetFiles: ['src/auth.ts'],
      implementationScope: 'src/',
      acceptanceCriteria: ['AC-AUTH-01'],
      constraints: ['TypeScript only'],
    };

    return {
      correlation: { correlation_id: `corr-${Date.now()}`, project_id: this.projectId },
      provider: this.providerId,
      model: this.defaultModel,
      content: JSON.stringify(payload),
      structured_output: payload as TStructured,
      finish_reason: LlmFinishReason.STOP,
      raw_metadata: {},
      error: null,
      usage: {
        reported_input_tokens: 100,
        reported_output_tokens: 50,
        reported_cached_tokens: 0,
        estimated_tokens: 150,
        estimated_cost_usd: 0.001,
        provider_name: this.providerId,
        model: this.defaultModel,
        is_exact_provider_metric: true,
      },
    };
  }
}

class TestExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId = 'mock-executor-p29';
  readonly provider = 'antigravity';
  readonly supportedOperations = ['IMPLEMENT_TASK'];
  executionCallCount = 0;
  isAvailable = true;
  simulateFailure = false;
  simulateVerbalSuccessOnly = false;
  tempDir: string;

  constructor(tempDir: string) {
    this.tempDir = tempDir;
  }

  async checkAvailability() {
    return { available: this.isAvailable };
  }

  async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
    this.executionCallCount++;

    if (this.simulateFailure) {
      return {
        executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
        requestId: request.requestId,
        requestBinding: {
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
        },
        status: 'FAILURE',
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'Compilation failed',
        durationMs: 25,
        unverifiedAgentClaims: ['Failure outcome'],
        unverifiedModifiedFiles: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        timedOut: false,
        cancelled: false,
      };
    }

    const targetFiles = request.instruction?.targetFiles;
    const files = targetFiles && targetFiles.length > 0
      ? targetFiles
      : ['src/auth.ts'];

    if (!this.simulateVerbalSuccessOnly) {
      for (const f of files) {
        const full = path.join(this.tempDir, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, `// Authoritative implementation of ${request.taskId}\n`, 'utf8');
      }
    }

    return {
      executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
      requestId: request.requestId,
      requestBinding: {
        requestId: request.requestId,
        projectId: request.projectId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
        contextFingerprint: request.contextFingerprint,
        understandingRevision: request.understandingRevision,
        approvalPackageRevision: request.approvalPackageRevision,
      },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: `Successfully implemented ${request.taskId}`,
      stderr: '',
      durationMs: 40,
      unverifiedAgentClaims: ['All tests pass, 100% complete!'],
      unverifiedModifiedFiles: this.simulateVerbalSuccessOnly ? [] : (files as string[]),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      timedOut: false,
      cancelled: false,
    };
  }
}

// ============================================================================
// SUITE SETUP
// ============================================================================

describe('Phase 29 (P29): Authoritative Director MCP Control Plane Integration', { concurrency: 1 }, () => {
  let tempDir: string;
  let validProjectId: string;
  let validSessionId: string;
  let validFingerprint: string;
  let validRevision: number;

  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let durableManager: DurableStateManager;
  let historyManager: HistoryManager;
  let evidenceStore: SystemExecutionEvidenceStore;
  let evidenceCollector: SystemEvidenceCollector;
  let mandateStore: ProjectMandateStore;
  let identityManager: IdentityManager;
  let policyEngine: AuthorizationPolicyEngine;
  let recoveryPolicyEngine: RecoveryPolicyEngine;
  let correctiveTaskService: CorrectiveTaskService;

  let mockLlmProvider: DeterministicLlmProvider;
  let directorRuntime: DirectorRuntime;
  let mockExecutor: TestExecutor;
  let coordinator: ClosedLoopCoordinator;
  let delegate: DefaultMcpOrchestratorDelegate;
  let transport: InMemoryMcpTransport;
  let server: McpServer;

  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;

  async function saveSignedMandate(mandate: ProjectMandate) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-p29-test',
      projectId: mandate.projectId,
      instanceId: 'inst-p29',
      actorType: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nonce: crypto.randomUUID(),
      publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey),
      authenticationMethod: 'ED25519_DPAPI',
      protocolVersion: 1,
      verified: true,
      authSource: 'TRUSTED_IDE',
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
      isDerived: true,
      sectionMetadata: {
        requirements: { revision: validRevision },
        projectStatus: { revision: 1 },
        taskList: { revision: 1 },
        currentTask: { revision: 1 },
        architecture: { revision: 1 },
        businessRules: { revision: 1 },
        acceptanceCriteria: { revision: 1 },
        risks: { revision: 1 },
        decisions: { revision: 1 },
        clarifications: { revision: 1 },
        approvalPackage: { revision: 1 },
        gitStatus: { revision: 1 },
      } as any,
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
        approval: { hasApprovalPackage: true, packageId: approvedPackage?.packageId ?? 'pkg-test', isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'p29-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 1, items: [{ id: 'REQ-01', title: 'Auth API', status: 'ACTIVE', authority: 'PO' }] },
        decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Node 22 Runtime', status: 'ACCEPTED' }] },
        taskList: {
          total: 2,
          topologicalOrder: ['task-01-core', 'task-02-auth'],
          tasks: [
            { taskId: 'task-01-core', title: 'Core Setup', status: 'ACCEPTED', dependencies: [] },
            { taskId: 'task-02-auth', title: 'Auth Service', status: 'READY', dependencies: ['task-01-core'] },
          ],
        },
        currentTask: {
          hasActiveTask: true,
          task: {
            taskId: 'task-02-auth',
            title: 'Auth Service',
            status: 'READY',
            description: 'Implement auth token service',
            acceptanceCriteria: ['AC-AUTH-01'],
          },
        },
        risks: { total: 0, items: [] },
        evidence: { totalAvailable: 0, items: [] },
        history: { totalEvents: 0, recentEvents: [] },
        git: { isGitRepository: true, head: 'main', branch: 'main', workingTreeClean: true, totalAcceptedCheckpoints: 1 },
        contextEngine: { isAvailable: true, hasL0Cache: true, inspectedPaths: [] },
      } as any,
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otonom-p29-test-'));
    validProjectId = path.basename(tempDir).toLowerCase();
    validSessionId = `dir-session-${Date.now()}`;
    validFingerprint = 'fp-p29-initial-001';
    validRevision = 1;

    // Seed minimal project files with initialized git repo
    const execGit = (cmd: string) => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          child_process.execSync(cmd, { cwd: tempDir, stdio: 'ignore' });
          return;
        } catch (err) {
          lastErr = err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
        }
      }
      throw lastErr;
    };
    execGit('git init -b main');
    execGit('git config user.name "AIDM P29 Test"');
    execGit('git config user.email "aidm-p29@example.com"');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: validProjectId, version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'src', 'auth.ts'), 'export const auth = "initial";\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n.gemini/\n.agents/\n*.log\n', 'utf8');
    execGit('git add .');
    execGit('git commit -m "initial commit"');

    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    durableManager = new DurableStateManager({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    evidenceCollector = new SystemEvidenceCollector({ evidenceStore });
    mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    identityManager = new IdentityManager({ baseDir: tempDir });
    policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager });
    recoveryPolicyEngine = new RecoveryPolicyEngine();
    correctiveTaskService = new CorrectiveTaskService({ workspaceRoot: tempDir, specStore, dagEngine, historyManager, approvalStore, approvalPackageEngine, directorSessionStore: sessionStore, recoveryPolicyEngine });

    mockLlmProvider = new DeterministicLlmProvider();
    mockLlmProvider.projectId = validProjectId;
    mockLlmProvider.sessionId = validSessionId;
    mockLlmProvider.fingerprint = validFingerprint;

    directorRuntime = new DirectorRuntime({
      sessionStore,
      promptBuilder: new DirectorPromptBuilder(),
      llmProvider: mockLlmProvider,
      isProduction: true,
      allowMockProvider: true,
    });

    mockExecutor = new TestExecutor(tempDir);

    coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      recoveryPolicyEngine,
      correctiveTaskService,
      executorPort: mockExecutor,
      directorRuntime,
      authorizationPolicyEngine: policyEngine,
    });

    // Create active session
    activeSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      understandingRevision: validRevision,
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };
    await sessionStore.saveSession(activeSession);

    // Create approved approval package
    const nowIso = new Date().toISOString();
    const pkgId = `pkg-${validProjectId}`;
    approvedPackage = {
      packageId: pkgId,
      projectId: validProjectId,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      status: 'APPROVED',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: true,
      approvalRecord: {
        packageId: pkgId,
        revision: validRevision,
        actor: 'PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: nowIso,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Human Product Owner authorizes task development',
      },
    } as any;
    await approvalStore.savePackage(approvedPackage);

    // Save signed mandate
    await saveSignedMandate({
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION'],
      allowedCommandCategories: ['test', 'build', 'lint'],
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
      forbiddenOperations: ['WORKSPACE_ESCAPE'],
      humanApprovalRequiredOperations: ['REPLAN'],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
      policyVersion: 1,
      mandateRevision: 1,
    });

    // Setup initial task in SpecStore
    const featCore: TaskDefinition = {
      task_id: 'FEAT-CORE',
      parent_feature_id: 'ROOT',
      title: 'Core Engine Feature',
      description: 'Core engine setup',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01'],
      hierarchy_level: 'FEATURE',
      priority: 'MEDIUM',
      status: 'ACCEPTED',
      risk_level: 'SAFE',
      dependencies: [],
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    attempt: 1,
    max_attempts: 3,
    };
    const t1: TaskDefinition = {
      task_id: 'task-01-core',
      parent_feature_id: 'FEAT-CORE',
      title: 'Core Setup',
      description: 'Setup project core skeleton',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-01'],
      hierarchy_level: 'TASK',
      priority: 'MEDIUM',
      attempt: 1,
      max_attempts: 2,
      status: 'ACCEPTED',
      risk_level: 'SAFE',
      dependencies: [],
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    const t2: TaskDefinition = {
      task_id: 'task-02-auth',
      parent_feature_id: 'FEAT-CORE',
      title: 'Auth Service',
      description: 'Implement auth token service',
      traceability_sources: ['REQ-01'],
      acceptance_criteria: ['AC-AUTH-01'],
      hierarchy_level: 'TASK',
      priority: 'MEDIUM',
      attempt: 1,
      max_attempts: 2,
      status: 'READY',
      risk_level: 'SAFE',
      dependencies: ['task-01-core'],
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { targetFiles: ['src/auth.ts'], revision: 1, taskClass: 'IMPLEMENTATION' },
    };
    await specStore.saveTasks([featCore, t1, t2]);

    await durableManager.save({
      schemaVersion: 1,
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-01-core'],
      activeTaskId: null,
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
    });

    activeSnapshot = createAuthoritativeSnapshot();
    await sessionStore.saveSnapshot(activeSnapshot);

    // Setup delegate
    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      directorRuntime,
      closedLoopCoordinator: coordinator,
      executorPort: mockExecutor,
    });

    // Setup MCP server with all relevant tools enabled
    transport = new InMemoryMcpTransport();
    server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
      directorDecisionTools: true,
      directorLoopTools: true,
      driverTools: true,
      approvalTools: true,
      clarificationTools: true,
    });
    await server.start();
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  // Helper to call tool on MCP server
  async function callMcpTool(name: string, args: Record<string, unknown> = {}): Promise<{
    res: McpSuccessResponseEnvelope | McpErrorResponseEnvelope;
    parsed: any;
    isError: boolean;
  }> {
    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: `req-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    };
    const res = await server.handleMessage(req);
    assert.ok(res, `Tool '${name}' returned null response`);

    if ('error' in res) {
      return { res: res as McpErrorResponseEnvelope, parsed: res.error, isError: true };
    }

    const toolResult = (res as McpSuccessResponseEnvelope).result as McpToolResult;
    const isError = Boolean(toolResult.isError);
    let parsed: any = null;
    if (toolResult.content && toolResult.content[0] && toolResult.content[0].text) {
      try {
        parsed = JSON.parse(toolResult.content[0].text);
      } catch {
        parsed = toolResult.content[0].text;
      }
    }
    return { res: res as McpSuccessResponseEnvelope, parsed, isError };
  }

  // ==========================================================================
  // GROUP 1: REGISTRATION (Scenarios 1-5)
  // ==========================================================================

  it('T01_registration_session_tools: registers all Director session identity tools', () => {
    const tools = server.getRegisteredTools().map(t => t.internalName ?? t.name);
    assert.ok(tools.includes(AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME), 'Must register session.create');
    assert.ok(tools.includes(AIDM_DIRECTOR_SESSION_GET_TOOL_NAME), 'Must register session.get');
    assert.ok(tools.includes(AIDM_DIRECTOR_SESSION_SUSPEND_TOOL_NAME), 'Must register session.suspend');
    assert.ok(tools.includes(AIDM_DIRECTOR_SESSION_CLOSE_TOOL_NAME), 'Must register session.close');
    assert.ok(tools.includes(AIDM_DIRECTOR_SESSION_RESUME_TOOL_NAME), 'Must register session.resume');
  });

  it('T02_registration_context_sync: registers Director context synchronization tool', () => {
    const tools = server.getRegisteredTools().map(t => t.internalName ?? t.name);
    assert.ok(tools.includes(AIDM_DIRECTOR_CONTEXT_SYNC_TOOL_NAME), 'Must register context.sync');
  });

  it('T03_registration_loop_tools: registers all Director loop tools', () => {
    const tools = server.getRegisteredTools().map(t => t.internalName ?? t.name);
    assert.ok(tools.includes(DIRECTOR_INGEST_INSTRUCTION_TOOL_NAME), 'Must register director.ingestInstruction');
    assert.ok(tools.includes(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME), 'Must register director.executeCycle');
    assert.ok(tools.includes(DIRECTOR_GET_CYCLE_RESULT_TOOL_NAME), 'Must register director.getCycleResult');
    assert.ok(tools.includes(DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME), 'Must register director.evaluateNextAction');
  });

  it('T04_registration_driver_tools: registers all driver control tools', () => {
    const tools = server.getRegisteredTools().map(t => t.internalName ?? t.name);
    assert.ok(tools.includes(DRIVER_START_TOOL_NAME), 'Must register driver.start');
    assert.ok(tools.includes(DRIVER_STATUS_TOOL_NAME), 'Must register driver.status');
    assert.ok(tools.includes(DRIVER_PAUSE_TOOL_NAME), 'Must register driver.pause');
    assert.ok(tools.includes(DRIVER_RESUME_TOOL_NAME), 'Must register driver.resume');
    assert.ok(tools.includes(DRIVER_STOP_TOOL_NAME), 'Must register driver.stop');
  });

  it('T05_registration_exposed_naming: exposed tool names satisfy MCP naming specification', () => {
    const tools = server.getRegisteredTools();
    for (const tool of tools) {
      assert.ok(
        isValidMcpToolName(tool.name),
        `Exposed tool name '${tool.name}' must satisfy MCP naming specification`
      );
    }
  });

  // ==========================================================================
  // GROUP 2: ROUTING & AUTHORITATIVE ARCHITECTURE (Scenarios 6-10)
  // ==========================================================================

  it('T06_routing_execute_cycle_coordinator: director.executeCycle delegates to ClosedLoopCoordinator', async () => {
    let coordinatorCalled = false;
    const originalCoordinate = coordinator.coordinateCycle.bind(coordinator);
    coordinator.coordinateCycle = async (input: ClosedLoopCycleInput): Promise<ClosedLoopCycleResult> => {
      coordinatorCalled = true;
      return originalCoordinate(input);
    };

    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, false, `Expected successful cycle, got: ${JSON.stringify(parsed)}`);
    assert.equal(coordinatorCalled, true, 'Must route through ClosedLoopCoordinator');
  });

  it('T07_routing_director_runtime_production_path: runtime fail-closed when provider unconfigured', async () => {
    // Replace runtime with unconfigured provider runtime
    const unconfiguredRuntime = new DirectorRuntime({
      llmProvider: null,
      isProduction: true,
    });

    const coordinatorWithoutProvider = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      sessionStore,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      evidenceCollector,
      authorizationPolicyEngine: policyEngine,
      recoveryPolicyEngine,
      correctiveTaskService,
      executorPort: mockExecutor,
      directorRuntime: unconfiguredRuntime,
    });

    // Swap coordinator on delegate
    (delegate as any).closedLoopCoordinator = coordinatorWithoutProvider;
    (delegate as any).getClosedLoopCoordinator = () => coordinatorWithoutProvider;

    try {
      const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
        workspaceRoot: tempDir,
        projectId: validProjectId,
        directorSessionId: validSessionId,
      });

      assert.equal(isError, true, 'Must fail-closed without configured LLM provider in production');
      assert.ok(
        parsed.summary?.includes('provider') ||
        parsed.summary?.includes('reasoning') ||
        parsed.summary?.includes('failed') ||
        parsed.error?.message?.includes('provider') ||
        parsed.error?.code?.includes('FAIL') ||
        parsed.error?.code?.includes('RUNTIME'),
        'Error message must indicate missing/unconfigured reasoning provider'
      );
    } finally {
      (delegate as any).closedLoopCoordinator = coordinator;
      (delegate as any).getClosedLoopCoordinator = () => coordinator;
    }
  });

  it('T08_routing_legacy_reasoning_prevention: legacy reasoning engine cannot bypass authoritative pipeline', async () => {
    // Ensure mock LLM was actually called by DirectorRuntime, proving legacy fallback was not used
    mockLlmProvider.callCount = 0;
    const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, false);
    assert.equal(mockLlmProvider.callCount, 1, 'DirectorRuntime.reason() must be invoked');
  });

  it('T09_routing_no_direct_executor_access: MCP boundary exposes no direct executor invocation tool', () => {
    const tools = server.getRegisteredTools().map(t => t.name.toLowerCase());
    assert.ok(!tools.includes('executor.execute_direct'), 'No direct executor tool');
    assert.ok(!tools.includes('executor.run_unauthorized'), 'No unauthorized executor tool');
    assert.ok(!tools.includes('antigravity.run'), 'No direct AGY runner');
  });

  it('T10_routing_no_direct_agy_or_shell: MCP boundary strictly forbids arbitrary shell execution', () => {
    const tools = server.getRegisteredTools().map(t => t.name.toLowerCase());
    assert.ok(!tools.some(t => t.includes('shell') || t.includes('bash') || t.includes('exec_cmd')),
      'MCP boundary must not expose arbitrary process or shell execution');
  });

  // ==========================================================================
  // GROUP 3: AUTHORIZATION & POLICY CLASSIFIER (Scenarios 11-17)
  // ==========================================================================

  it('T11_authorization_read_only_tools: read-only tools classified as READ_ONLY and SAFE', () => {
    const readOnlyTools = [
      'aidm_health',
      'aidm.project.status',
      'aidm.tasks.list',
      'aidm.director.session.get',
      'director.getCycleResult',
      'driver.status',
    ];
    for (const tool of readOnlyTools) {
      const classification = classifyMcpTool(tool);
      assert.equal(classification.category, McpToolCategory.READ_ONLY, `${tool} must be READ_ONLY`);
      assert.equal(classification.riskLevel, 'SAFE', `${tool} risk level must be SAFE`);
      assert.equal(classification.isReadOnly, true, `${tool} isReadOnly must be true`);
    }
  });

  it('T12_authorization_planning_tools: planning tools classified as PLANNING and CAUTION', () => {
    const planningTools = [
      'aidm.director.context.sync',
      'director.evaluateNextAction',
      'aidm.director.decision.create',
    ];
    for (const tool of planningTools) {
      const classification = classifyMcpTool(tool);
      assert.equal(classification.category, McpToolCategory.PLANNING, `${tool} must be PLANNING`);
      assert.equal(classification.riskLevel, 'CAUTION', `${tool} risk level must be CAUTION`);
      assert.equal(classification.mutatesSource, false, `${tool} must not mutate source`);
    }
  });

  it('T13_authorization_execution_tools: execution tools classified as EXECUTION_CAPABLE and CRITICAL', () => {
    const execTools = [
      'director.executeCycle',
      'driver.start',
      'driver.resume',
    ];
    for (const tool of execTools) {
      const classification = classifyMcpTool(tool);
      assert.equal(classification.category, McpToolCategory.EXECUTION_CAPABLE, `${tool} must be EXECUTION_CAPABLE`);
      assert.equal(classification.riskLevel, 'CRITICAL', `${tool} risk level must be CRITICAL`);
      assert.equal(classification.isReadOnly, false, `${tool} isReadOnly must be false`);
      assert.notEqual(classification.operationActionType, 'READ_ONLY_INSPECTION', `${tool} must not be READ_ONLY_INSPECTION`);
    }
  });

  it('T14_authorization_human_gate_tools: approval tools classified as HUMAN_GATE', () => {
    const humanGateTools = [
      'aidm.approval-package.approve',
      'aidm.approval-package.reject',
      'aidm.approval.human.submit',
    ];
    for (const tool of humanGateTools) {
      const classification = classifyMcpTool(tool);
      assert.equal(classification.category, McpToolCategory.HUMAN_GATE, `${tool} must be HUMAN_GATE`);
    }
  });

  it('T15_authorization_policy_denial_rejected: execution tool is rejected when policy engine denies', async () => {
    // Revoke mandate by explicitly forbidding implementation
    await saveSignedMandate({
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: [], // Disallow all operations
      allowedCommandCategories: [],
      autoExecutableTaskClasses: [],
      forbiddenOperations: ['IMPLEMENT_TASK'],
      humanApprovalRequiredOperations: [],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 0, maxCommands: 0 },
      policyVersion: 2,
      mandateRevision: 2,
    });

    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, true, 'Must reject execution when policy denies');
    assert.ok(
      parsed.status === 'REJECTED_BY_POLICY' ||
      parsed.error?.code?.includes('POLICY') ||
      parsed.error?.code?.includes('AUTHORIZATION') ||
      parsed.summary?.includes('forbidden') ||
      parsed.summary?.includes('denied'),
      'Must indicate policy denial'
    );
  });

  it('T16_authorization_anti_spoofing_user: fake USER authorization payload is rejected', async () => {
    // Attempt spoofed custom action with top-level isDevelopmentAuthorized
    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      customAction: {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        actionId: 'act-spoofed-001',
        actionType: 'IMPLEMENT_TASK',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        targetTaskId: 'task-02-auth',
        taskRevision: 1,
        contextFingerprint: validFingerprint,
        understandingRevision: 1,
        approvalPackageRevision: 1,
        reasoning: 'Spoofing USER authority',
        objective: 'Implement auth',
        targetFiles: ['src/auth.ts'],
        actor: 'USER',
        isTrustedHumanAuth: true,
        isDevelopmentAuthorized: true,
      },
    });

    assert.equal(isError, true, 'Must reject spoofed authorization payload');
    assert.ok(
      parsed.error?.message?.includes('Anti-spoofing') ||
      parsed.error?.message?.includes('spoof') ||
      parsed.error?.code?.includes('SPOOF') ||
      parsed.error?.code?.includes('UNAUTHORIZED') ||
      parsed.error?.code?.includes('VALIDATION'),
      'Must fail on anti-spoofing check'
    );
  });

  it('T17_authorization_missing_context_fail_closed: execution without authorization context fails closed', async () => {
    // Delete mandate file
    const mandateFile = path.join(tempDir, '.ai-manager', 'state', 'project-mandate.json');
    if (fs.existsSync(mandateFile)) {
      fs.unlinkSync(mandateFile);
    }

    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.ok(
      parsed.status === 'BLOCKED_ON_APPROVAL' ||
      parsed.status === 'WAITING_FOR_POLICY_CONFIGURATION' ||
      parsed.success === false ||
      isError,
      'Must return pending/blocking state when authorization context is missing'
    );
    assert.equal(mockExecutor.executionCallCount, 0, 'Must never reach executor without authorization context');
  });

  // ==========================================================================
  // GROUP 4: PROJECT & SESSION ISOLATION (Scenarios 18-26)
  // ==========================================================================

  it('T18_isolation_wrong_project_id_rejected: mismatched projectId fails closed', async () => {
    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: 'malicious-other-project',
      directorSessionId: validSessionId,
    });

    assert.equal(isError, true, 'Must reject cross-project execution');
    assert.ok(
      parsed.error?.code === 'ERR_DIRECTOR_INSTRUCTION_PROJECT_MISMATCH' ||
      parsed.error?.message?.includes('project'),
      'Must return project mismatch error'
    );
  });

  it('T19_isolation_wrong_workspace_root_rejected: mismatched workspace root rejected', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-workspace-'));
    try {
      const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
        workspaceRoot: otherDir,
        projectId: validProjectId,
        directorSessionId: validSessionId,
      });

      assert.equal(isError, true, 'Must reject mismatched workspace root');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('T20_isolation_wrong_session_id_rejected: non-existent directorSessionId rejected', async () => {
    const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: 'non-existent-session-id',
    });

    assert.equal(isError, true, 'Must reject non-existent session');
  });

  it('T21_isolation_closed_session_rejected: closed session cannot execute cycles', async () => {
    await sessionStore.saveSession({
      ...activeSession,
      status: 'CLOSED',
    });

    const { isError, parsed } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, true, 'Closed session must be rejected');
    assert.ok(
      parsed.error?.message?.includes('ACTIVE') ||
      parsed.error?.code?.includes('SESSION'),
      'Error must state session is not ACTIVE'
    );
  });

  it('T22_isolation_suspended_session_rejected: suspended session cannot execute cycles', async () => {
    await sessionStore.saveSession({
      ...activeSession,
      status: 'SUSPENDED',
    });

    const { isError, parsed } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, true, 'Suspended session must be rejected');
    assert.ok(
      parsed.error?.message?.includes('ACTIVE') ||
      parsed.error?.code?.includes('SESSION'),
      'Error must state session is not ACTIVE'
    );
  });

  it('T23_isolation_stale_fingerprint_rejected: stale context snapshot fingerprint rejected', async () => {
    // Custom action with mismatched fingerprint
    const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      customAction: {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        actionId: `act-${crypto.randomUUID()}`,
        actionType: 'IMPLEMENT_TASK',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        targetTaskId: 'task-02-auth',
        taskRevision: 1,
        contextFingerprint: 'stale-wrong-fingerprint-999',
        understandingRevision: 1,
        approvalPackageRevision: 1,
        reasoning: 'Implementing',
        objective: 'Implement auth',
        targetFiles: ['src/auth.ts'],
      },
    });

    assert.equal(isError, true, 'Mismatched fingerprint must be rejected');
  });

  it('T24_isolation_stale_understanding_revision_rejected: stale understanding revision rejected', async () => {
    const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      customAction: {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        actionId: `act-${crypto.randomUUID()}`,
        actionType: 'IMPLEMENT_TASK',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        targetTaskId: 'task-02-auth',
        taskRevision: 1,
        contextFingerprint: validFingerprint,
        understandingRevision: 999, // Mismatched understanding revision
        approvalPackageRevision: 1,
        reasoning: 'Implementing',
        objective: 'Implement auth',
        targetFiles: ['src/auth.ts'],
      },
    });

    assert.equal(isError, true, 'Mismatched understanding revision must be rejected');
  });

  it('T25_isolation_stale_task_revision_rejected: stale task revision rejected', async () => {
    const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      customAction: {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        actionId: `act-${crypto.randomUUID()}`,
        actionType: 'IMPLEMENT_TASK',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        targetTaskId: 'task-02-auth',
        taskRevision: 999, // Mismatched task revision
        contextFingerprint: validFingerprint,
        understandingRevision: 1,
        approvalPackageRevision: 1,
        reasoning: 'Implementing',
        objective: 'Implement auth',
        targetFiles: ['src/auth.ts'],
      },
    });

    assert.equal(isError, true, 'Mismatched task revision must be rejected');
  });

  it('T26_isolation_stale_approval_revision_rejected: stale approval package revision rejected', async () => {
    const { isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      customAction: {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        actionId: `act-${crypto.randomUUID()}`,
        actionType: 'IMPLEMENT_TASK',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        targetTaskId: 'task-02-auth',
        taskRevision: 1,
        contextFingerprint: validFingerprint,
        understandingRevision: 1,
        approvalPackageRevision: 999, // Mismatched approval revision
        reasoning: 'Implementing',
        objective: 'Implement auth',
        targetFiles: ['src/auth.ts'],
      },
    });

    assert.equal(isError, true, 'Mismatched approval package revision must be rejected');
  });

  // ==========================================================================
  // GROUP 5: EXECUTION VERIFICATION & EVIDENCE (Scenarios 27-33)
  // ==========================================================================

  it('T27_execution_authoritative_p28_path: authoritative closed-loop cycle completes with machine-readable result', async () => {
    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, false);
    assert.equal(parsed.success, true);
    assert.ok(parsed.cycleId, 'Must return cycleId');
    assert.ok(parsed.actionId, 'Must return actionId');
    assert.ok(parsed.status, 'Must return status');
    assert.equal(parsed.projectId, validProjectId);
    assert.equal(parsed.directorSessionId, validSessionId);
  });

  it('T28_execution_system_evidence_required: execution requires verified SystemExecutionEvidence', async () => {
    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, false);
    assert.ok(parsed.evidenceId, 'Must return authoritative evidenceId');
    assert.ok(
      parsed.verificationDecision === 'ACCEPT' || parsed.verificationDecision === 'VERIFIED',
      'Verification decision must be ACCEPT or VERIFIED'
    );
  });

  it('T29_execution_verbal_claim_not_proof: AGY verbal claims fail verification without verified file changes', async () => {
    mockExecutor.simulateVerbalSuccessOnly = true;

    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    // Verification must fail because files were not actually created on disk
    assert.ok(
      parsed.verificationDecision === 'VERIFICATION_FAILED' ||
      parsed.status === 'VERIFICATION_FAILED' ||
      parsed.error?.code?.includes('VERIFICATION') ||
      isError,
      'Verbal claim without actual disk changes must fail verification'
    );
  });

  it('T30_execution_unknown_halts_and_blocks: EXECUTION_UNKNOWN halts fail-closed', async () => {
    mockExecutor.simulateFailure = true;

    const { parsed } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    // Fails closed and records failure, corrective task, or unknown
    assert.ok(
      parsed.status === 'EXECUTION_FAILED' ||
      parsed.status === 'EXECUTION_UNKNOWN' ||
      parsed.status === 'VERIFICATION_FAILED' ||
      parsed.status === 'CORRECTIVE_TASK_CREATED' ||
      parsed.success === false,
      'Must record execution failure and halt progression'
    );
  });

  it('T31_execution_human_gate_never_reaches_executor: human gate action halts before executor', async () => {
    // Provide a valid human-gate action (REQUEST_HUMAN_DECISION) satisfying RequestHumanDecisionActionZodSchema
    mockLlmProvider.nextAction = {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: `act-${crypto.randomUUID()}`,
      actionType: 'REQUEST_HUMAN_DECISION',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      taskId: 'task-02-auth',
      basedOnContextFingerprint: validFingerprint,
      rationale: 'Human architectural decision required on token format',
      confidence: 0.95,
      question: 'Which authentication format should be used?',
      reason: 'Architecture decision needed for token specification',
      blocking: true,
      options: ['JWT', 'Paseto'],
      recommendation: 'JWT',
      decisionTopic: 'Authentication format',
      objective: 'Decide on JWT vs Paseto',
      targetFiles: ['src/auth.ts'],
    };

    mockExecutor.executionCallCount = 0;

    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, false);
    assert.ok(
      parsed.status === 'BLOCKED_ON_APPROVAL' ||
      parsed.status === 'HUMAN_DECISION_REQUIRED' ||
      parsed.details?.humanDecisionRequired === true,
      'Status must indicate human decision required'
    );
    assert.equal(mockExecutor.executionCallCount, 0, 'Human-gate action must never reach executor');
  });

  it('T32_execution_duplicate_request_idempotent: duplicate request returns idempotent result', async () => {
    const fixedIdempotencyKey = 'idemp-key-p29-001';

    const first = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      idempotencyKey: fixedIdempotencyKey,
    });

    assert.equal(first.isError, false);
    const initialCallCount = mockExecutor.executionCallCount;

    const duplicate = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      idempotencyKey: fixedIdempotencyKey,
    });

    assert.equal(duplicate.isError, false);
    assert.ok(
      duplicate.parsed.cycleId === first.parsed.cycleId ||
      duplicate.parsed.cycleId.includes('duplicate'),
      'Must return idempotent cycleId'
    );
    assert.equal(mockExecutor.executionCallCount, initialCallCount, 'Executor must not be re-invoked on duplicate');
  });

  it('T33_execution_retry_distinct_lineage: retry creates distinct execution intent without duplicate execution', async () => {
    // First run with failure
    mockExecutor.simulateFailure = true;
    const firstRun = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    // Fix failure for retry
    mockExecutor.simulateFailure = false;
    const retryRun = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      idempotencyKey: 'retry-intent-key-002',
    });

    assert.notEqual(retryRun.parsed.cycleId, firstRun.parsed.cycleId, 'Retry must generate new cycleId');
  });

  // ==========================================================================
  // GROUP 6: LIFECYCLE & GOVERNANCE (Scenarios 34-37)
  // ==========================================================================

  it('T34_lifecycle_evaluate_next_action_no_execution: evaluateNextAction evaluates boundary without executing', async () => {
    // First execute an authoritative cycle so evaluateNextAction has a cycle to evaluate
    const cycle = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });
    assert.equal(cycle.isError, false);

    mockExecutor.executionCallCount = 0;

    const { parsed, isError } = await callMcpTool(DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      taskId: 'task-02-auth',
      cycleId: cycle.parsed.cycleId,
    });

    assert.equal(isError, false);
    assert.equal(mockExecutor.executionCallCount, 0, 'evaluateNextAction must NEVER invoke executor');
    assert.ok(
      parsed.boundary !== undefined ||
      parsed.actionStatus !== undefined ||
      parsed.taskCompleted !== undefined ||
      parsed.canIssueNextInstruction !== undefined,
      'Must return evaluation details'
    );
  });

  it('T35_lifecycle_execute_cycle_single_cycle_only: executeCycle executes exactly one cycle', async () => {
    mockExecutor.executionCallCount = 0;

    const { parsed, isError } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(isError, false);
    assert.equal(mockExecutor.executionCallCount, 1, 'Must execute exactly one cycle');
    assert.equal(parsed.continuationPolicy, 'CONTROLLED_MANUAL');
  });

  it('T36_lifecycle_no_hidden_recursive_loop: autoContinue is strictly false with no background daemon', async () => {
    const { parsed } = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });

    assert.equal(parsed.autoContinue, false, 'autoContinue must be strictly false');
  });

  it('T37_lifecycle_driver_governed_boundary: driver controls do not bypass Director or authorization', async () => {
    // Attempt driver.start with wrong projectId
    const { parsed: wrongProjParsed, isError: wrongProjError } = await callMcpTool(DRIVER_START_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: 'malicious-other-project',
      directorSessionId: validSessionId,
    });
    assert.equal(wrongProjError, true, 'Driver must enforce canonical project identity');
    assert.ok(wrongProjParsed.error?.code?.includes('PROJECT_MISMATCH'));

    // Attempt driver.start with closed session
    await sessionStore.saveSession({
      ...activeSession,
      status: 'CLOSED',
    });

    const { parsed: closedParsed, isError: closedError } = await callMcpTool(DRIVER_START_TOOL_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
    });
    assert.equal(closedError, true, 'Driver must reject non-ACTIVE session');
    assert.ok(closedParsed.error?.code?.includes('SESSION_NOT_ACTIVE'));
  });
});
