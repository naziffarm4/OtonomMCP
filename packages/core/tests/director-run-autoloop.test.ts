/**
 * @file director-run-autoloop.test.ts
 * @description Comprehensive verification test suite for director_runAutoLoop MCP tool:
 *
 * 1. MCP tool schema and registration verification (internal & exposed naming)
 * 2. Successful coordinateAutoLoop delegation & result structure
 * 3. Workspace and canonical project isolation enforcement
 * 4. Bounded maxCycles and timeoutMs enforcement
 * 5. Cancellation via AbortSignal & fail-closed on EXECUTION_UNKNOWN
 * 6. Authority rejection and human approval required gate
 * 7. Budget limit enforcement
 * 8. Zero executor trust: independent evidence verification required
 * 9. API key and secrets redaction guarantee
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as child_process from 'node:child_process';

import {
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  ClosedLoopCoordinator,
  type ClosedLoopCycleInput,
  type ClosedLoopCycleResult,
  type ClosedLoopAutoLoopInput,
  type ClosedLoopAutoLoopResult,
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
  classifyMcpTool,
  McpToolCategory,
  DIRECTOR_RUN_AUTOLOOP_TOOL_NAME,
  DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME,
  directorRunAutoLoopToolDefinition,
  isValidMcpToolName,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
  type McpToolResult,
} from '../dist/index.js';
import { BudgetManager } from '../dist/budget/budget-manager.js';
import { DirectorRuntime } from '../dist/director/director-runtime.js';
import { DirectorPromptBuilder } from '../dist/director/director-prompt-builder.js';
import type { LLMProvider } from '../dist/llm-bridge/llm-provider.js';
import type { LlmRequest, LlmResponse } from '../dist/llm-bridge/llm-types.js';
import { LlmFinishReason } from '../dist/llm-bridge/llm-types.js';

// ============================================================================
// MOCKS & STUBS
// ============================================================================

class MockLlmProvider implements LLMProvider {
  readonly providerId = 'llm:mock-autoloop';
  readonly providerName = 'mock-autoloop-provider';
  readonly defaultModel = 'autoloop-model-v1';
  readonly supportedModels = ['autoloop-model-v1'];
  readonly supportedCapabilities = [] as any;
  isMock = true;

  isAvailable = true;
  callCount = 0;
  nextAction: Record<string, unknown> | null = null;
  projectId = 'test-proj-autoloop';
  sessionId = 'sess-autoloop';
  fingerprint = 'fp-autoloop-initial';
  sessionStore?: DirectorSessionStore;

  async checkAvailability() {
    return { available: this.isAvailable, model: this.defaultModel };
  }

  async generate<TStructured = unknown>(_request: LlmRequest): Promise<LlmResponse<TStructured>> {
    this.callCount++;
    const latestSnapshot = this.sessionStore ? await this.sessionStore.loadLatestSnapshot(this.sessionId) : null;
    const fp = latestSnapshot?.logicalFingerprint ?? this.fingerprint;
    const payload = this.nextAction ?? {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: `act-${crypto.randomUUID()}`,
      directorSessionId: this.sessionId,
      projectId: this.projectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: fp,
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
  readonly executorId = 'mock-executor-autoloop';
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
        stderr: 'Execution failed: simulated compilation error',
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
    const files = targetFiles && targetFiles.length > 0 ? targetFiles : ['src/auth.ts'];

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
// TEST SUITE
// ============================================================================

describe('AIDM — director_runAutoLoop MCP Tool Verification Suite', { concurrency: 1 }, () => {
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
  let mandateStore: ProjectMandateStore;
  let identityManager: IdentityManager;
  let policyEngine: AuthorizationPolicyEngine;
  let budgetManager: BudgetManager;

  let mockLlmProvider: MockLlmProvider;
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
      workspaceId: 'ws-autoloop-test',
      projectId: mandate.projectId,
      instanceId: 'inst-autoloop',
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
        discovery: { isDiscovered: true, projectName: 'autoloop-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otonom-autoloop-test-'));
    validProjectId = path.basename(tempDir).toLowerCase();
    validSessionId = `dir-session-${Date.now()}`;
    validFingerprint = 'fp-autoloop-initial-001';
    validRevision = 1;

    // Seed git repository
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
    execGit('git config user.name "AIDM AutoLoop Test"');
    execGit('git config user.email "aidm-autoloop@example.com"');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: validProjectId, version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'src', 'auth.ts'), 'export const auth = "initial";\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n.gemini/\n.agents/\n*.log\n*.sqlite*\n', 'utf8');
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
    mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    identityManager = new IdentityManager({ baseDir: tempDir });
    policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager });
    budgetManager = new BudgetManager({ dbPath: path.join(tempDir, 'budget.sqlite') });
    budgetManager.open();
    budgetManager.createGlobalAccount(100_000_000_000n);
    budgetManager.pricingEngine.registerRate({
      providerId: 'antigravity',
      modelId: 'default',
      serviceTier: 'standard',
      inputRateNum: 100_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 100_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 0n,
      cachedInputRateDen: 1_000_000n,
    });

    mockLlmProvider = new MockLlmProvider();
    mockLlmProvider.projectId = validProjectId;
    mockLlmProvider.sessionId = validSessionId;
    mockLlmProvider.fingerprint = validFingerprint;
    mockLlmProvider.sessionStore = sessionStore;

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
      executorPort: mockExecutor,
      directorRuntime,
      budgetManager,
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
        comment: 'Product Owner authorizes task development',
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

    // Setup tasks in SpecStore
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
    await specStore.saveRequirements([
      {
        id: 'REQ-01',
        title: 'Auth API',
        description: 'Implement auth service API',
        authority: 'USER' as any,
        status: 'LOCKED' as any,
      },
    ]);
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
      budgetManager,
      executorPort: mockExecutor,
    });

    // Setup MCP server with director loop tools
    transport = new InMemoryMcpTransport();
    server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
      directorDecisionTools: true,
      directorLoopTools: true,
      driverTools: true,
      approvalTools: true,
    });
    await server.start();
  });

  afterEach(async () => {
    try {
      budgetManager.close();
    } catch {
      // ignore cleanup error
    }
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
  // 1. TOOL SCHEMA & REGISTRATION
  // ==========================================================================

  it('T01_registration_and_naming: registers director_runAutoLoop and conforms to MCP naming spec', () => {
    const tools = server.getRegisteredTools();
    const toolNames = tools.map((t) => t.name);

    assert.ok(
      toolNames.includes(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME),
      `Must expose '${DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME}' in registered tools list`
    );

    const autoLoopDef = tools.find((t) => t.name === DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME);
    assert.ok(autoLoopDef, 'Auto-loop tool definition must be found');
    assert.ok(isValidMcpToolName(autoLoopDef.name), 'Exposed name must satisfy MCP naming specification');
    assert.equal(autoLoopDef.inputSchema.type, 'object');
    assert.ok(Array.isArray(autoLoopDef.inputSchema.required));
    assert.ok(autoLoopDef.inputSchema.required?.includes('instruction'));

    // Check lookup by both canonical and compat names
    const byCompat = server.getTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME);
    const byInternal = server.getTool(DIRECTOR_RUN_AUTOLOOP_TOOL_NAME);
    assert.ok(byCompat, 'Lookup by compat name must succeed');
    assert.ok(byInternal, 'Lookup by internal name must succeed');
    assert.equal(byCompat, byInternal, 'Both names must resolve to identical registration');
  });

  it('T02_policy_classification: classifies director_runAutoLoop as EXECUTION_CAPABLE and CRITICAL risk', () => {
    const classification = classifyMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME);
    assert.equal(classification.category, McpToolCategory.EXECUTION_CAPABLE);
    assert.equal(classification.isReadOnly, false);
    assert.equal(classification.riskLevel, 'CRITICAL');

    const internalClassification = classifyMcpTool(DIRECTOR_RUN_AUTOLOOP_TOOL_NAME);
    assert.equal(internalClassification.category, McpToolCategory.EXECUTION_CAPABLE);
    assert.equal(internalClassification.riskLevel, 'CRITICAL');
  });

  it('T03_schema_validation_rejects_missing_instruction: missing instruction fails schema check', async () => {
    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
    });

    assert.equal(isError, true, 'Must return error for missing required instruction');
    assert.ok(
      JSON.stringify(parsed).includes('instruction'),
      'Error message must mention missing instruction'
    );
  });

  // ==========================================================================
  // 2. COORDINATE AUTO-LOOP INVOCATION
  // ==========================================================================

  it('T04_delegation_to_coordinator: calls ClosedLoopCoordinator.coordinateAutoLoop and returns structured summary', async () => {
    let coordinatorCalled = false;
    let receivedInput: ClosedLoopAutoLoopInput | null = null;

    const originalCoordinateAutoLoop = coordinator.coordinateAutoLoop.bind(coordinator);
    coordinator.coordinateAutoLoop = async (input: ClosedLoopAutoLoopInput): Promise<ClosedLoopAutoLoopResult> => {
      coordinatorCalled = true;
      receivedInput = input;
      return originalCoordinateAutoLoop(input);
    };

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Implement authentication service and verify AC-AUTH-01',
      maxCycles: 5,
      maxRecoveryAttempts: 2,
    });

    assert.equal(coordinatorCalled, true, 'coordinateAutoLoop must have been called');
    assert.ok(receivedInput, 'Input must be captured');
    assert.equal((receivedInput as ClosedLoopAutoLoopInput).instruction, 'Implement authentication service and verify AC-AUTH-01');
    assert.equal((receivedInput as ClosedLoopAutoLoopInput).maxCycles, 5);
    assert.equal((receivedInput as ClosedLoopAutoLoopInput).maxRecoveryAttempts, 2);

    assert.equal(
      parsed.success,
      true,
      `Expected success, summary: ${parsed.summary}, terminalStatus: ${parsed.terminalStatus}, humanDecisionPoint: ${JSON.stringify(parsed.humanDecisionPoint)}`
    );
    assert.equal(parsed.projectId, validProjectId);
    assert.equal(parsed.directorSessionId, validSessionId);
    assert.ok(parsed.loopId.startsWith(`loop-${validProjectId}`));
    assert.ok(parsed.cyclesRun >= 1);
    assert.ok(Array.isArray(parsed.completedCycles));
  });

  // ==========================================================================
  // 3. WORKSPACE & PROJECT ISOLATION
  // ==========================================================================

  it('T05_project_isolation_mismatch: rejects execution when projectId mismatches canonical identity', async () => {
    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: 'rogue-other-project-id',
      instruction: 'Implement feature in rogue project',
    });

    assert.equal(isError, true, 'Cross-project execution must be rejected');
    assert.equal(parsed.code ?? parsed.error?.code, 'ERR_PROJECT_MISMATCH');
  });

  // ==========================================================================
  // 4. MAX CYCLES & TIMEOUT LIMITS
  // ==========================================================================

  it('T06_max_cycles_bounded: stops safely when maxCycles limit is reached without infinite loop', async () => {
    // Add an extra ready task so tasks remain incomplete and maxCycles is triggered
    const t3: TaskDefinition = {
      task_id: 'task-03-extra',
      parent_feature_id: 'FEAT-CORE',
      title: 'Extra Service',
      description: 'Extra task description',
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
    const allTasks = await specStore.loadTasks();
    await specStore.saveTasks([...allTasks, t3]);

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Implement tasks continuously',
      maxCycles: 1, // Restrict to exactly 1 cycle
    });

    assert.equal(parsed.cyclesRun, 1, 'Must run exactly 1 cycle');
    assert.equal(parsed.terminalStatus, 'MAX_CYCLES_REACHED', 'Must stop at max cycle limit');
  });

  // ==========================================================================
  // 5. CANCELLATION & EXECUTION_UNKNOWN
  // ==========================================================================

  it('T07_cancellation_via_signal: stops immediately on AbortSignal without further dispatch', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted signal

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Implement cancelled task',
      signal: controller.signal,
    });

    assert.equal(parsed.terminalStatus, 'CANCELLED');
    assert.equal(parsed.isSuccess, false);
    assert.equal(parsed.cyclesRun, 0);
  });

  it('T08_execution_unknown_halts_fail_closed: EXECUTION_UNKNOWN halts loop immediately with zero re-dispatch', async () => {
    // Mock cycle to return EXECUTION_UNKNOWN
    coordinator.coordinateCycle = async (): Promise<ClosedLoopCycleResult> => {
      return {
        cycleId: 'cycle-unknown-001',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        taskId: 'task-02-auth',
        status: 'EXECUTION_UNKNOWN',
        isSuccess: false,
        stepReached: 'BRIDGE_EXECUTION',
        summary: 'Executor process vanished; state indeterminate',
        humanDecisionRequired: true,
        humanDecisionPoint: { reason: 'Unknown outcome' },
        completedAt: new Date().toISOString(),
      };
    };

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Run task that produces unknown state',
      maxCycles: 5,
    });

    assert.equal(isError, true, 'EXECUTION_UNKNOWN must produce error response');
    assert.equal(parsed.terminalStatus, 'EXECUTION_UNKNOWN');
    assert.equal(parsed.humanDecisionRequired, true);
    assert.equal(parsed.cyclesRun, 1, 'Zero blind re-dispatch allowed after EXECUTION_UNKNOWN');
  });

  // ==========================================================================
  // 6. AUTHORITY & HUMAN APPROVAL GATE
  // ==========================================================================

  it('T09_human_approval_gate_not_bypassed: BLOCKED_ON_APPROVAL halts loop safely without auto-generating approval', async () => {
    // Mock cycle requiring human approval
    coordinator.coordinateCycle = async (): Promise<ClosedLoopCycleResult> => {
      return {
        cycleId: 'cycle-approval-001',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        taskId: 'task-02-auth',
        status: 'BLOCKED_ON_APPROVAL',
        isSuccess: false,
        stepReached: 'POLICY_EVALUATION',
        summary: 'Re-planning requires explicit Product Owner authorization',
        humanDecisionRequired: true,
        humanDecisionPoint: { requiredRole: 'PRODUCT_OWNER', intent: 'REPLAN_APPROVAL' },
        completedAt: new Date().toISOString(),
      };
    };

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Trigger action requiring human approval',
      maxCycles: 3,
    });

    assert.equal(parsed.terminalStatus, 'BLOCKED_ON_APPROVAL');
    assert.equal(parsed.humanDecisionRequired, true);
    assert.equal(parsed.isSuccess, false);
    assert.equal(parsed.cyclesRun, 1, 'Must halt immediately at human approval boundary');
  });

  it('T10_policy_rejection_halts_fail_closed: REJECTED_BY_POLICY stops auto-loop fail-closed', async () => {
    coordinator.coordinateCycle = async (): Promise<ClosedLoopCycleResult> => {
      return {
        cycleId: 'cycle-policy-denied',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        taskId: 'task-02-auth',
        status: 'REJECTED_BY_POLICY',
        isSuccess: false,
        stepReached: 'POLICY_EVALUATION',
        summary: 'Action outside authorized directory scope src/',
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    };

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Perform action outside directory mandate',
      maxCycles: 3,
    });

    assert.equal(isError, true);
    assert.equal(parsed.terminalStatus, 'REJECTED_BY_POLICY');
    assert.equal(parsed.cyclesRun, 1);
  });

  // ==========================================================================
  // 7. BUDGET MANAGER LIMIT ENFORCEMENT
  // ==========================================================================

  it('T11_budget_limit_enforcement: stops loop when budget limit is exhausted', async () => {
    coordinator.coordinateCycle = async (): Promise<ClosedLoopCycleResult> => {
      return {
        cycleId: 'cycle-budget-exceeded',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        taskId: 'task-02-auth',
        status: 'EXECUTION_FAILED',
        isSuccess: false,
        stepReached: 'REASONING',
        summary: 'Director execution halted: Project budget limit exceeded.',
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    };

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Execute with exhausted budget',
    });

    assert.equal(isError, true);
    assert.equal(parsed.isSuccess, false);
    assert.ok(parsed.summary.includes('budget') || parsed.summary.includes('FAILED'));
  });

  // ==========================================================================
  // 8. ZERO EXECUTOR TRUST & INDEPENDENT EVIDENCE
  // ==========================================================================

  it('T12_zero_executor_trust_verbal_claims_insufficient: verbal claims without evidence do not result in success', async () => {
    // Executor simulates verbal claims but produces no actual file modifications
    mockExecutor.simulateVerbalSuccessOnly = true;

    const { parsed, isError } = await callMcpTool(DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME, {
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Implement auth with verbal claim only',
      maxCycles: 1,
    });

    // Without verified evidence, task cannot succeed
    assert.equal(parsed.isSuccess, false, 'Loop cannot succeed on verbal claims without independent evidence');
  });

  // ==========================================================================
  // 9. SECRETS & API KEY REDACTION
  // ==========================================================================

  it('T13_secrets_redaction: API keys and bearer tokens are strictly redacted from tool response', async () => {
    const sensitiveApiKey = 'sk-proj-super-secret-key-1234567890abcdef';
    const sensitiveBearer = 'Bearer secret_token_xyz_987654321';

    coordinator.coordinateCycle = async (): Promise<ClosedLoopCycleResult> => {
      return {
        cycleId: 'cycle-leak-test',
        projectId: validProjectId,
        directorSessionId: validSessionId,
        taskId: 'task-02-auth',
        status: 'EXECUTION_FAILED',
        isSuccess: false,
        stepReached: 'BRIDGE_EXECUTION',
        summary: `Connection failed with API key ${sensitiveApiKey} and header ${sensitiveBearer}`,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    };

    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-secret-redaction-test',
      method: 'tools/call',
      params: {
        name: DIRECTOR_RUN_AUTOLOOP_COMPAT_NAME,
        arguments: {
          workspaceRoot: tempDir,
          projectId: validProjectId,
          directorSessionId: validSessionId,
          instruction: `Instruction with secret token ${sensitiveApiKey}`,
        },
      },
    };

    const res = await server.handleMessage(req);
    assert.ok(res);
    const rawResponseText = JSON.stringify(res);

    assert.equal(
      rawResponseText.includes(sensitiveApiKey),
      false,
      'API key must never appear in raw MCP tool response'
    );
    assert.equal(
      rawResponseText.includes(sensitiveBearer),
      false,
      'Bearer token must never appear in raw MCP tool response'
    );
    assert.ok(
      rawResponseText.includes('***REDACTED_KEY***') || rawResponseText.includes('***REDACTED***'),
      'Redaction marker must be present in response'
    );
  });
});
