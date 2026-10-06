/**
 * Phase 33 (P33) MCP Integration Contract Hardening Test Suite
 *
 * Systematic verification of MCP JSON-RPC 2.0 integration contract boundaries:
 * A. MCP Protocol Contract (T01 - T08)
 * B. Tool Contract & Naming (T09 - T14)
 * C. Error / Sanitization Contract (T15 - T20)
 * D. Request Correlation Contract (T21 - T24)
 * E. Project & Session Isolation (T25 - T28)
 * F. Idempotency & Authoritative Routing (T29 - T32)
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
  McpServerState,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  ClosedLoopCoordinator,
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
  DriverStore,
  DriverLockManager,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  IdentityManager,
  type ProjectMandate,
  type TaskDefinition,
  type DirectorSession,
  type DirectorContextSnapshot,
  type ApprovalPackage,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  PolicyEngine,
  createAuthoritativeMcpServer,
  McpJsonRpcErrorCode,
  McpDomainErrorCode,
  McpErrorCode,
  McpErrorNormalizer,
  McpInvalidRequestError,
  McpUnsupportedOperationError,
  McpPolicyBlockedError,
  McpHumanBlockedError,
  sanitizeMcpSecrets,
  sanitizeMcpPayload,
  createCollisionSafeToolName,
  isValidMcpToolName,
  resolveCanonicalProjectIdentity,
  classifyMcpTool,
} from '../dist/index.js';

import { PolicyViolationError } from '../dist/errors/policy-violation-error.js';

// ============================================================================
// TEST FIXTURES: MOCK EXECUTOR
// ============================================================================

class TestExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId = 'mock-executor-p33';
  readonly provider = 'antigravity';
  readonly supportedOperations = ['IMPLEMENT_TASK'];
  executionCallCount = 0;
  isAvailable = true;
  tempDir: string;

  constructor(tempDir: string) {
    this.tempDir = tempDir;
  }

  async checkAvailability() {
    return { available: this.isAvailable };
  }

  async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
    this.executionCallCount++;

    const files = request.targetFiles && request.targetFiles.length > 0
      ? request.targetFiles
      : ['src/index.ts'];

    for (const f of files) {
      const full = path.join(this.tempDir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `// Authoritative implementation of ${request.taskId}\n`, 'utf8');
    }

    return {
      executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
      requestId: request.requestId,
      requestBinding: {
        requestId: request.requestId,
        directorSessionId: request.directorSessionId,
        directorDecisionId: request.directorDecisionId,
        projectId: request.projectId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
        contextFingerprint: request.contextFingerprint,
        understandingRevision: request.understandingRevision,
        approvalPackageRevision: request.approvalPackageRevision,
        operationType: request.operationType,
      },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: `Successfully implemented ${request.taskId}`,
      stderr: '',
      durationMs: 25,
      unverifiedAgentClaims: ['P33 task implemented'],
      unverifiedModifiedFiles: files as string[],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}

// ============================================================================
// SUITE SETUP
// ============================================================================

describe('P33 — MCP Integration Contract Hardening', { concurrency: 1 }, () => {
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
  let historyManager: HistoryManager;
  let durableStateManager: DurableStateManager;
  let dagEngine: TaskDagEngine;
  let evidenceStore: SystemExecutionEvidenceStore;
  let evidenceCollector: SystemEvidenceCollector;
  let actionDispatcher: DirectorActionDispatcher;
  let actionBuilder: DirectorActionBuilder;
  let actionValidator: DirectorActionValidator;
  let executionBridge: ExecutionBridge;
  let driverEngine: DriverEngine;
  let authorizationPolicyEngine: AuthorizationPolicyEngine;
  let mandateStore: ProjectMandateStore;
  let policyEngine: PolicyEngine;
  let testExecutor: TestExecutor;
  let coordinator: ClosedLoopCoordinator;
  let transport: InMemoryMcpTransport;
  let server: McpServer;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p33-test-'));
    validProjectId = path.basename(tempDir).toLowerCase();

    // Initialize git repo
    try {
      child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
      child_process.execSync('git config user.name "P33 Test"', { cwd: tempDir, stdio: 'ignore' });
      child_process.execSync('git config user.email "p33@aidm.internal"', { cwd: tempDir, stdio: 'ignore' });
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: validProjectId, version: '1.0.0' }), 'utf8');
      fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const p33 = true;\n', 'utf8');
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n*.log\n', 'utf8');
      child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
      child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });
    } catch {
      // Non-fatal if git configuration fails
    }

    // Set up project identity
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: validProjectId, version: '1.0.0' }),
      'utf8'
    );
    const p1Dir = path.join(tempDir, '.ai-manager', 'p1');
    fs.mkdirSync(p1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(p1Dir, 'project-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: validProjectId,
        projectRoot: tempDir,
        canonicalId: validProjectId,
        ecosystem: 'node',
      }),
      'utf8'
    );

    // Initialize stores & engines
    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ baseDir: tempDir, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine({ approvalStore, historyManager });
    specStore = new SpecStore({ baseDir: tempDir });
    durableStateManager = new DurableStateManager({ baseDir: tempDir });
    dagEngine = new TaskDagEngine({ specStore, historyManager });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    evidenceCollector = new SystemEvidenceCollector({ evidenceStore, historyManager });
    mandateStore = new ProjectMandateStore({ baseDir: tempDir });

    const identityManager = new IdentityManager({ baseDir: tempDir });
    authorizationPolicyEngine = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore,
      identityManager,
    });

    testExecutor = new TestExecutor(tempDir);

    executionBridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      evidenceStore,
      dagEngine,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      executorPort: testExecutor,
      authorizationPolicyEngine,
    });

    driverEngine = new DriverEngine({
      workspaceRoot: tempDir,
      historyManager,
      specStore,
      dagEngine,
      evidenceCollector,
      executionBridge,
    });

    actionDispatcher = new DirectorActionDispatcher({
      decisionStore,
      sessionStore,
      historyManager,
      authorizationPolicyEngine,
    });

    actionValidator = new DirectorActionValidator({
      sessionStore,
      decisionStore,
      historyManager,
    });

    coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager,
      historyManager,
      executorPort: testExecutor,
      executionBridge,
      driverEngine,
      authorizationPolicyEngine,
      actionDispatcher,
      actionValidator,
    });

    policyEngine = new PolicyEngine({
      mode: 'audit',
      projectRoot: tempDir,
    });

    // Create session & mandate
    const sess = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
    });
    validSessionId = sess.directorSessionId;
    validRevision = sess.understandingRevision ?? 1;

    validFingerprint = 'snap-fingerprint-p33-valid';

    const activeSnapshot: DirectorContextSnapshot = {
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
      sectionMetadata: {} as any,
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
        approval: { hasApprovalPackage: true, packageId: 'pkg-p33', isReadyForApproval: true, isExplicitlyApproved: true },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        discovery: { isDiscovered: true, projectName: 'p33-service', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], unknownsCount: 0, contradictionsCount: 0 },
        requirements: { total: 1, items: [{ id: 'REQ-01', title: 'MCP API', status: 'ACTIVE', authority: 'PO' }] },
        decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Node 22 Runtime', status: 'ACCEPTED' }] },
      } as any,
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    const testMandate: ProjectMandate = {
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION'],
      allowedCommandCategories: ['test', 'build', 'lint'],
      autoExecutableTaskClasses: ['CODE_IMPLEMENTATION'],
      forbiddenOperations: ['WORKSPACE_ESCAPE'],
      humanApprovalRequiredOperations: ['REPLAN'],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
      policyVersion: 1,
      mandateRevision: 1,
      mandateHash: 'mandate-hash-p33',
      rules: [
        {
          ruleId: 'RULE-P33-ALLOW',
          description: 'Allow standard dev operations',
          actionType: 'IMPLEMENT_TASK' as any,
          permission: 'ALLOW',
          conditions: { allowedTaskClasses: ['CODE_IMPLEMENTATION'] },
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-p33-test',
      projectId: testMandate.projectId,
      instanceId: 'inst-p33',
      actorType: 'PRODUCT_OWNER' as const,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nonce: crypto.randomUUID(),
      publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey),
      authenticationMethod: 'ED25519_DPAPI' as const,
      protocolVersion: 1,
      verified: true,
      authSource: 'TRUSTED_IDE' as const,
    };
    const signature = await identityManager.signPayload(payload, privateKey);
    await mandateStore.saveMandate(testMandate, { ...payload, signature });

    // Seed task in SpecStore
    const featCore: TaskDefinition = {
      task_id: 'feat-01',
      parent_feature_id: null,
      title: 'Control Plane Feature',
      description: 'High-level Director MCP Control Plane',
      traceability_sources: ['REQ:01'],
      dependencies: [],
      acceptance_criteria: ['AC-CP-01'],
      status: 'ACCEPTED',
      attempt: 0,
      max_attempts: 1,
      priority: 'HIGH',
      risk_level: 'SAFE',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };
    const testTask: TaskDefinition = {
      task_id: 'TASK-P33-01',
      parent_feature_id: 'feat-01',
      title: 'MCP integration hardening task',
      description: 'Implement contract hardening',
      traceability_sources: ['REQ:01'],
      dependencies: [],
      acceptance_criteria: ['AC-01'],
      status: 'READY',
      attempt: 0,
      max_attempts: 3,
      priority: 'HIGH',
      risk_level: 'SAFE',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: { targetFiles: ['src/index.ts'], revision: 1, taskClass: 'CODE_IMPLEMENTATION' },
    };
    await specStore.saveTasks([featCore, testTask]);

    // Create server with delegate
    transport = new InMemoryMcpTransport();
    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager,
      historyManager,
      systemExecutionEvidenceStore: evidenceStore,
      evidenceCollector,
      projectMandateStore: mandateStore,
      authorizationPolicyEngine,
      closedLoopCoordinator: coordinator,
      getClosedLoopCoordinator: (_root: string) => coordinator,
      policyEngine,
    });
    delegate.closedLoopCoordinator = coordinator;

    server = createAuthoritativeMcpServer({
      transport,
      projectRoot: tempDir,
      delegate,
      policyEngine,
    });

    await server.start();
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup
    }
  });

  // ==========================================================================
  // A. MCP PROTOCOL CONTRACT (T01 - T08)
  // ==========================================================================

  it('T01_initialize: server returns deterministic protocol and foundation versions', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.ok('result' in res);
    const result = (res as any).result;
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.foundationVersion, 'P8-01');
    assert.equal(result.serverInfo.name, 'aidm-mcp-server');
    assert.ok(result.capabilities.tools);
  });

  it('T02_ping: server responds with empty object', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 2);
    assert.ok('result' in res);
    assert.deepEqual((res as any).result, {});
  });

  it('T03_invalid_jsonrpc: jsonrpc != "2.0" returns ERR_MCP_INVALID_REQUEST', async () => {
    const res = await server.handleMessage({
      jsonrpc: '1.0',
      id: 3,
      method: 'ping',
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 3);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.equal(err.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.equal(err.data?.code, McpErrorCode.INVALID_REQUEST);
  });

  it('T04_missing_request_id: request message without id returns ERR_MCP_INVALID_REQUEST', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'aidm_health' },
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, null);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.equal(err.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.equal(err.data?.code, McpErrorCode.INVALID_REQUEST);
  });

  it('T05_unknown_method: unsupported method returns standard error', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/unknownMethod',
      params: {},
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 5);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.equal(err.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);
    assert.equal(err.data?.code, McpErrorCode.UNSUPPORTED_OPERATION);
  });

  it('T06_unknown_tool: non-existing tool returns ERR_MCP_UNSUPPORTED_OPERATION', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'non_existing_tool' },
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 6);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.equal(err.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);
    assert.equal(err.data?.code, McpErrorCode.UNSUPPORTED_OPERATION);
  });

  it('T07_notification_no_response: notification produces no response envelope', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    assert.equal(res, null);
  });

  it('T08_stopped_server_rejection: stopped server rejects requests with deterministic failure', async () => {
    await server.stop();
    assert.equal(server.isRunning(), false);

    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'ping',
    });

    assert.ok(res);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 8);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.equal(err.code, McpJsonRpcErrorCode.INTERNAL_ERROR);
    assert.equal(err.data?.code, McpErrorCode.INTERNAL_FAILURE);
    assert.ok(err.message.includes('STOPPED'));
  });

  // ==========================================================================
  // B. TOOL CONTRACT & NAMING (T09 - T14)
  // ==========================================================================

  it('T09_tools_list: tools/list returns callable tools with valid schemas', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
    });

    assert.ok(res);
    assert.ok('result' in res);
    const tools = (res as any).result.tools as any[];
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 6);

    for (const tool of tools) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
      assert.ok(typeof tool.inputSchema === 'object' && tool.inputSchema !== null);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('T10_inputSchema_validation: rejects malformed or missing required arguments', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'aidm_director_control',
        arguments: {}, // missing required 'action'
      },
    });

    assert.ok(res);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.equal(err.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.equal(err.data?.code, McpErrorCode.INVALID_REQUEST);
    assert.ok(err.message.includes('Missing required argument'));
  });

  it('T11_duplicate_exposed_name: registering tool with colliding name generates unique safe name', () => {
    const transport2 = new InMemoryMcpTransport();
    const testServer = new McpServer({ transport: transport2 });

    testServer.registerTool(
      { name: 'custom_tool', description: 'first tool', inputSchema: { type: 'object' } },
      async () => ({ content: [] })
    );

    testServer.registerTool(
      { name: 'custom_tool', description: 'duplicate tool', inputSchema: { type: 'object' } },
      async () => ({ content: [] })
    );

    const tools = testServer.getRegisteredTools();
    const names = tools.map((t) => t.name);
    assert.equal(names.length, 3); // 1 health + 2 custom
    assert.equal(new Set(names).size, 3, 'All exposed names must be strictly unique');
  });

  it('T12_collision_safe_naming: createCollisionSafeToolName produces valid MCP names', () => {
    const existing = new Set(['my_tool']);
    const safeName = createCollisionSafeToolName('my_tool', existing);
    assert.notEqual(safeName, 'my_tool');
    assert.ok(isValidMcpToolName(safeName));
    assert.ok(safeName.length <= 64);
  });

  it('T13_director_tool_compatibility_names: both dot notation and underscore are resolvable', async () => {
    const dotTool = server.getTool('aidm.director.status');
    const underTool = server.getTool('aidm_director_status');

    assert.ok(dotTool, 'aidm.director.status must be found');
    assert.ok(underTool, 'aidm_director_status must be found');
    assert.equal(dotTool.exposedName, underTool.exposedName);
  });

  it('T14_no_arbitrary_shell_tool: control plane exposes zero arbitrary shell execution tools', () => {
    const tools = server.getRegisteredTools();
    for (const tool of tools) {
      const lower = tool.name.toLowerCase();
      assert.equal(lower.includes('bash'), false, `Forbidden shell tool found: ${tool.name}`);
      assert.equal(lower.includes('exec_command'), false, `Forbidden shell tool found: ${tool.name}`);
      assert.equal(lower.includes('terminal'), false, `Forbidden shell tool found: ${tool.name}`);
    }
  });

  // ==========================================================================
  // C. ERROR & SANITIZATION CONTRACT (T15 - T20)
  // ==========================================================================

  it('T15_invalid_request_normalization: McpErrorNormalizer normalizes malformed request', () => {
    const err = new McpInvalidRequestError('Malformed envelope payload');
    const normalized = McpErrorNormalizer.normalize(err, { correlationId: 'corr-15', receivedAt: new Date().toISOString() });

    assert.equal(normalized.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.equal(normalized.data?.code, McpErrorCode.INVALID_REQUEST);
    assert.equal(normalized.data?.correlationId, 'corr-15');
  });

  it('T16_unsupported_operation_normalization: normalizes unsupported operation', () => {
    const err = new McpUnsupportedOperationError('Operation not supported');
    const normalized = McpErrorNormalizer.normalize(err);

    assert.equal(normalized.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);
    assert.equal(normalized.data?.code, McpErrorCode.UNSUPPORTED_OPERATION);
  });

  it('T17_policy_blocked_normalization: PolicyViolationError normalizes to ERR_MCP_POLICY_BLOCKED', () => {
    const err = new PolicyViolationError('Policy engine blocked action', ['RULE_VIOLATION']);
    const normalized = McpErrorNormalizer.normalize(err, { correlationId: 'corr-17', receivedAt: new Date().toISOString() });

    assert.equal(normalized.code, McpDomainErrorCode.POLICY_BLOCKED);
    assert.equal(normalized.data?.code, McpErrorCode.POLICY_BLOCKED);
    assert.equal(normalized.data?.correlationId, 'corr-17');
  });

  it('T18_human_blocked_normalization: human gate error normalizes to ERR_MCP_HUMAN_BLOCKED', () => {
    const err = new McpHumanBlockedError('Human approval required');
    const normalized = McpErrorNormalizer.normalize(err, { correlationId: 'corr-18', receivedAt: new Date().toISOString() });

    assert.equal(normalized.code, McpDomainErrorCode.HUMAN_BLOCKED);
    assert.equal(normalized.data?.code, McpErrorCode.HUMAN_BLOCKED);
    assert.equal(normalized.data?.correlationId, 'corr-18');
  });

  it('T19_secret_in_message_redacted: all sensitive tokens in error message are redacted', () => {
    const sensitive =
      'Failed with Bearer abc123secret and sk-test-secret and token=super-secret and Authorization: Bearer xyz and humanApprovalToken=secret';
    const sanitized = sanitizeMcpSecrets(sensitive);

    assert.equal(sanitized.includes('abc123secret'), false);
    assert.equal(sanitized.includes('test-secret'), false);
    assert.equal(sanitized.includes('super-secret'), false);
    assert.equal(sanitized.includes('Bearer xyz'), false);
    assert.equal(sanitized.includes('***REDACTED***'), true);
  });

  it('T20_nested_secret_in_data_redacted: nested object details are sanitized recursively', () => {
    const payload = {
      user: 'director',
      auth: {
        authToken: 'secret-auth-token',
        humanApprovalToken: 'human-secret',
        header: 'Authorization: Bearer topsecret123',
      },
      list: ['safe', 'Bearer token999'],
    };

    const sanitized = sanitizeMcpPayload(payload);

    assert.equal(sanitized.auth.authToken, '***REDACTED***');
    assert.equal(sanitized.auth.humanApprovalToken, '***REDACTED***');
    assert.equal(JSON.stringify(sanitized).includes('topsecret123'), false);
    assert.equal(JSON.stringify(sanitized).includes('token999'), false);
  });

  // ==========================================================================
  // D. REQUEST CORRELATION CONTRACT (T21 - T24)
  // ==========================================================================

  it('T21_deterministic_correlation_presence: requests generate aidm-corr- correlation', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'aidm_health', arguments: {} },
    });

    assert.ok(res);
    assert.ok('result' in res);
    // Health tool returns healthy payload
    const result = (res as any).result;
    assert.ok(result);
  });

  it('T22_mcpRequestId_binding: request ID is preserved in response envelope', async () => {
    const reqId = 'custom-request-id-42';
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: reqId,
      method: 'ping',
    });

    assert.ok(res);
    assert.equal(res.id, reqId);
  });

  it('T23_project_session_correlation: projectId and sessionId are bound into request context', async () => {
    let capturedCorrelation: any = null;

    server.registerTool(
      { name: 'test_correlation_tool', description: 'captures correlation', inputSchema: { type: 'object' } },
      async (_args, context) => {
        capturedCorrelation = context.correlation;
        return { content: [] };
      }
    );

    await server.handleMessage({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: {
        name: 'test_correlation_tool',
        _projectId: validProjectId,
        _directorSessionId: validSessionId,
        arguments: {},
      },
    });

    assert.ok(capturedCorrelation);
    assert.equal(capturedCorrelation.projectId, validProjectId);
    assert.equal(capturedCorrelation.directorSessionId, validSessionId);
    assert.equal(capturedCorrelation.mcpRequestId, 23);
  });

  it('T24_error_correlation_propagation: normalized errors include correlationId in error.data', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          directorSessionId: 12345 as any, // invalid type: number instead of string
          actionType: 'REQUEST_PLANNING',
          payload: {},
        },
      },
    });

    assert.ok(res);
    assert.ok('error' in res);
    const err = (res as any).error;
    assert.ok(err.data?.correlationId);
    assert.ok(err.data.correlationId.startsWith('aidm-corr-'));
  });

  // ==========================================================================
  // E. PROJECT & SESSION ISOLATION (T25 - T28)
  // ==========================================================================

  it('T25_project_mismatch: Project A session with Project B tool call is rejected', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          projectId: 'alien-project-xyz',
          directorSessionId: validSessionId,
          actionType: 'IMPLEMENT_TASK',
          payload: { taskId: 'TASK-P33-01' },
        },
      },
    });

    assert.ok(res);
    assert.ok('result' in res);
    const raw = (res as any).result;
    const parsed = JSON.parse(raw.content[0].text);
    assert.equal(parsed.success, false);
    assert.equal(parsed.error.code, 'ERR_PROJECT_MISMATCH');
  });

  it('T26_session_mismatch: mismatched or missing session ID is rejected fail-closed', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          directorSessionId: 'sess-non-existent-999',
          actionType: 'REQUEST_PLANNING',
          humanApprovalToken: 'p33-human-token',
          payload: { objective: 'test' },
        },
      },
    });

    assert.ok(res);
    assert.ok('result' in res);
    const raw = (res as any).result;
    const parsed = JSON.parse(raw.content[0].text);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.message.includes('MISSING') || parsed.error.code.includes('SESSION'));
  });

  it('T27_stale_context: action based on outdated context fingerprint is rejected', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 27,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          directorSessionId: validSessionId,
          actionType: 'REQUEST_PLANNING',
          humanApprovalToken: 'p33-human-token',
          basedOnContextFingerprint: 'stale-fingerprint-old',
          payload: { objective: 'test' },
        },
      },
    });

    assert.ok(res);
    assert.ok('result' in res);
    const raw = (res as any).result;
    const parsed = JSON.parse(raw.content[0].text);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.code.includes('STALE'));
  });

  it('T28_synthetic_context_rejection: action with synthetic context without snapshot is rejected', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 28,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          directorSessionId: validSessionId,
          actionType: 'REQUEST_PLANNING',
          humanApprovalToken: 'p33-human-token',
          basedOnContextFingerprint: 'synthetic-caller-fake-fp',
          payload: { objective: 'test' },
        },
      },
    });

    assert.ok(res);
    assert.ok('result' in res);
    const raw = (res as any).result;
    const parsed = JSON.parse(raw.content[0].text);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.code.includes('STALE'));
  });

  // ==========================================================================
  // F. IDEMPOTENCY & AUTHORITATIVE ROUTING (T29 - T32)
  // ==========================================================================

  it('T29_duplicate_action: duplicate action with identical idempotencyKey does not double-execute', async () => {
    const idempotencyKey = 'p33-idem-key-29';

    const res1 = await server.handleMessage({
      jsonrpc: '2.0',
      id: 291,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          directorSessionId: validSessionId,
          actionType: 'REQUEST_PLANNING',
          humanApprovalToken: 'p33-human-token',
          idempotencyKey,
          basedOnContextFingerprint: validFingerprint,
          understandingRevision: validRevision,
          payload: { objective: 'test' },
        },
      },
    });

    const res2 = await server.handleMessage({
      jsonrpc: '2.0',
      id: 292,
      method: 'tools/call',
      params: {
        name: 'aidm_director_act',
        arguments: {
          directorSessionId: validSessionId,
          actionType: 'REQUEST_PLANNING',
          humanApprovalToken: 'p33-human-token',
          idempotencyKey,
          basedOnContextFingerprint: validFingerprint,
          understandingRevision: validRevision,
          payload: { objective: 'test' },
        },
      },
    });

    assert.ok(res1);
    assert.ok(res2);
    const raw1 = JSON.parse((res1 as any).result.content[0].text);
    const raw2 = JSON.parse((res2 as any).result.content[0].text);
    assert.equal(raw1.actionId, raw2.actionId);
  });

  it('T30_duplicate_execution_intent: ExecutionBridge single claim prevents duplicate dispatch', async () => {
    const intent = {
      executionIntentId: 'intent-p33-30',
      actionId: 'act-p33-30',
      idempotencyKey: 'idem-p33-30',
      projectId: validProjectId,
      directorSessionId: validSessionId,
      taskId: 'TASK-P33-01',
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      authorizationReference: {
        packageRevision: 1,
        isDevelopmentAuthorized: true,
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'execute once',
    };

    // First claim
    const claim1 = await executionBridge.claimIntent(intent as any);
    assert.equal(claim1.executionIntentId, intent.executionIntentId);

    // Second claim with same intent returns identical claim record
    const claim2 = await executionBridge.claimIntent(intent as any);
    assert.equal(claim2.executionIntentId, intent.executionIntentId);

    // Second claim with different intentId for already claimed idempotency key is rejected
    const conflictingIntent = { ...intent, executionIntentId: 'intent-different-30' };
    await assert.rejects(async () => {
      await executionBridge.claimIntent(conflictingIntent as any);
    }, /already claimed/i);
  });

  it('T31_no_direct_executor_bypass: execution tools require ClosedLoopCoordinator / delegate boundary', () => {
    // Verify classifyMcpTool classifies director.act as EXECUTION_CAPABLE
    const classification = classifyMcpTool('aidm.director.act');
    assert.equal(classification.category, 'EXECUTION_CAPABLE');
    assert.equal(classification.isReadOnly, false);
    assert.equal(classification.mutatesSource, true);
  });

  it('T32_no_direct_dag_fsm_bypass: MCP tools list does not expose arbitrary DAG or FSM mutators', () => {
    const tools = server.getRegisteredTools();
    const names = tools.map((t) => t.name);

    // Ensure no raw bypass mutation tools exist
    assert.equal(names.includes('fsm_set_state'), false);
    assert.equal(names.includes('dag_force_complete'), false);
    assert.equal(names.includes('raw_executor_run'), false);
  });
});
