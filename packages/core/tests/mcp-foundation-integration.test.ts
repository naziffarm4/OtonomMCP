/**
 * Phase 8 MCP Foundation Integration Tests (TASK-P8-06)
 *
 * Validates the complete Phase 8 MCP foundation as one coherent read/control surface:
 *   P8-01 MCP Server Foundation
 *          ↓
 *   P8-02 Director Read Tools
 *          ↓
 *   P8-03 Existing Project Discovery
 *          ↓
 *   P8-04 Clarification Protocol
 *          ↓
 *   P8-05 Initial Understanding / Approval Gate
 *
 * COVERAGE GROUPS (32 mandatory verification criteria):
 *  1. MCP initialization & protocol handshake
 *  2. Tool registration & boundaries
 *  3. Tool enable/disable configuration
 *  4. JSON-RPC request correlation
 *  5. Malformed MCP request handling
 *  6. Read tool integration & non-mutation
 *  7. Discovery integration (bounded, read-only)
 *  8. Discovery → Clarification integration
 *  9. Clarification answer integration
 * 10. Blocking clarification prevents approval
 * 11. Discovery → Understanding integration
 * 12. Understanding → Approval readiness
 * 13. Explicit Product Owner approval
 * 14. Invalid approval actor rejection
 * 15. Invalid approval intent rejection
 * 16. Stale revision approval rejection
 * 17. Rejection semantics & reason preservation
 * 18. Revision invalidates prior approval
 * 19. Approval → Development authorization
 * 20. No authorization before explicit approval
 * 21. No automatic Task DAG creation
 * 22. No Antigravity invocation
 * 23. No autonomous execution
 * 24. Persistence & recovery across fresh service instances
 * 25. HistoryManager audit trail
 * 26. Evidence traceability
 * 27. Secret sanitization
 * 28. Path traversal rejection
 * 29. No second FSM
 * 30. No duplicate source of truth
 * 31. Read-only project preservation
 * 32. Full Phase 8 lifecycle integration (In-Memory & Stream transport)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { PassThrough } from 'node:stream';

import {
  McpServer,
  McpServerState,
  InMemoryMcpTransport,
  StreamMcpTransport,
  DefaultMcpOrchestratorDelegate,
  LATEST_MCP_PROTOCOL_VERSION,
  MCP_FOUNDATION_VERSION,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_MCP_SERVER_VERSION,
  DEFAULT_AIDM_VERSION,
  AIDM_HEALTH_TOOL_NAME,
  DIRECTOR_READ_TOOL_NAMES,
  AIDM_PROJECT_STATUS_TOOL_NAME,
  AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  AIDM_PROJECT_DECISIONS_TOOL_NAME,
  AIDM_TASKS_LIST_TOOL_NAME,
  AIDM_TASKS_CURRENT_TOOL_NAME,
  AIDM_CONTEXT_GET_TOOL_NAME,
  AIDM_EVIDENCE_GET_TOOL_NAME,
  AIDM_HISTORY_GET_TOOL_NAME,
  AIDM_GIT_STATUS_TOOL_NAME,
  AIDM_PROJECT_DISCOVER_TOOL_NAME,
  AIDM_CLARIFICATION_CREATE_TOOL_NAME,
  AIDM_CLARIFICATION_GET_TOOL_NAME,
  AIDM_CLARIFICATION_ANSWER_TOOL_NAME,
  AIDM_CLARIFICATION_BLOCKING_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME,
  McpJsonRpcErrorCode,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
  type ProjectDiscoveryReport,
  type ClarificationSession,
  type ClarificationQuestion,
  type ProjectApprovalPackage,
  ApprovalPackageEngine,
  ApprovalStore,
  InitialProjectUnderstandingBuilder,
  isDevelopmentAuthorized,
  ClarificationStore,
  ClarificationSessionEngine,
  LifecycleState,
  Actor,
} from '../dist/index.js';

const execFile = promisify(execFileCallback);

// ============================================================================
// RPC TEST HELPERS
// ============================================================================

async function sendRpc<T = unknown>(
  server: McpServer,
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1
): Promise<McpSuccessResponseEnvelope<T>> {
  const req: McpRequestEnvelope = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
  const res = await server.handleMessage(req);
  assert.ok(res, `Expected response for ${method}`);
  assert.ok(
    !('error' in res),
    `Expected success response for ${method} but got error: ${JSON.stringify(
      (res as McpErrorResponseEnvelope).error
    )}`
  );
  return res as McpSuccessResponseEnvelope<T>;
}

async function sendRpcError(
  server: McpServer,
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1
): Promise<McpErrorResponseEnvelope> {
  const req: McpRequestEnvelope = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
  const res = await server.handleMessage(req);
  assert.ok(res, `Expected response for ${method}`);
  assert.ok('error' in res, `Expected error response for ${method} but got success`);
  return res as McpErrorResponseEnvelope;
}

function parseToolResult<T = unknown>(response: McpSuccessResponseEnvelope): T {
  const toolResult = response.result as { content?: Array<{ type: string; text?: string }> };
  assert.ok(toolResult && Array.isArray(toolResult.content), 'Expected result.content array');
  const textContent = toolResult.content.find((c) => c.type === 'text');
  assert.ok(textContent && textContent.text, 'Expected text content block in tool result');
  return JSON.parse(textContent.text) as T;
}

// Compute directory hash ignoring .ai-manager
async function computeSourceChecksum(dir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  async function walk(current: string) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.ai-manager' || entry.name === 'node_modules') {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const content = await fs.promises.readFile(fullPath);
        hash.update(path.relative(dir, fullPath));
        hash.update(content);
      }
    }
  }
  await walk(dir);
  return hash.digest('hex');
}

function createMockReport(overrides?: Partial<ProjectDiscoveryReport>): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'payment-gateway-service',
      version: '1.2.0',
      workspaceRoot: '/mock/workspace',
      ecosystem: 'Node.js',
      evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'Payment gateway integration microservice',
      domainKeywords: ['payments', 'gateway'],
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'README.md' }],
    },
    technologyStack: {
      primaryLanguages: ['TypeScript'],
      frameworks: ['Express'],
      buildTools: ['tsc'],
      packageManagers: ['npm'],
      runtimes: ['node'],
      containerization: [],
      ciCd: [],
      workspaceType: 'standalone',
      dependencies: [],
      devDependencies: [],
      evidence: [{ sourceType: 'CONFIG', sourceIdentifier: 'tsconfig.json' }],
    },
    repositoryStructure: {
      layout: 'standard-src',
      topLevelDirectories: ['src'],
      totalFileCount: 4,
      significantFiles: ['package.json'],
      fileExtensions: ['.ts', '.json'],
      evidence: [],
    },
    architecture: {
      identifiedAreas: [],
      architecturalPattern: 'Modular',
      summary: 'Modular Express architecture',
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/index.ts' }],
    },
    entryPoints: [
      {
        type: 'main',
        target: 'src/index.ts',
        source: 'package.json:main',
        isAuthoritative: true,
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
      },
    ],
    commands: {
      build: {
        status: 'DISCOVERED',
        command: 'npm run build',
        source: 'package.json:scripts.build',
        evidence: [],
      },
      test: {
        status: 'DISCOVERED',
        command: 'npm test',
        source: 'package.json:scripts.test',
        evidence: [],
      },
      runtime: {
        status: 'DISCOVERED',
        command: 'node dist/index.js',
        evidence: [],
      },
      lint: {
        status: 'UNKNOWN',
        evidence: [],
      },
    },
    featureInventory: [
      {
        id: 'feat-1',
        name: 'Payment Processing',
        description: 'Process financial transactions',
        status: 'IMPLEMENTED',
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/index.ts' }],
      },
    ],
    documentationSummary: {
      hasReadme: true,
      readmePath: 'README.md',
      hasContributing: false,
      hasArchitectureDocs: false,
      documentationFiles: ['README.md'],
      summary: 'README present',
      evidence: [],
    },
    requirementsSummary: {
      totalRequirements: 0,
      lockedCount: 0,
      source: 'NONE',
      requirements: [],
      evidence: [],
    },
    decisionsSummary: {
      totalDecisions: 0,
      source: 'NONE',
      decisions: [],
      evidence: [],
    },
    currentImplementationState: {
      lifecycleState: 'INITIALIZING',
      hasActiveTask: false,
      isBlocked: false,
      totalTasksInDag: 0,
      completedTasksCount: 0,
      evidence: [],
    },
    gitStatus: {
      uncommittedChangesCount: 0,
      untrackedFilesCount: 0,
      evidence: [],
    },
    facts: [
      {
        id: 'fact-1',
        statement: 'Package name is payment-gateway-service',
        category: 'IDENTITY',
        evidence: [],
      },
    ],
    observations: [],
    inferences: [],
    unknowns: [],
    contradictions: [],
    clarificationCandidates: [],
    recommendedNextAction: 'PROCEED_TO_CLARIFICATION',
    timestamp: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Phase 8 MCP Foundation Integration Tests (TASK-P8-06)', () => {
  let tempDir: string;
  let transport: InMemoryMcpTransport;
  let delegate: DefaultMcpOrchestratorDelegate;
  let server: McpServer;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p8-06-integ-'));

    // Create realistic fixture repository
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify(
        {
          name: 'payment-gateway-service',
          version: '1.2.0',
          description: 'Payment gateway integration microservice with idempotency and audit trail',
          type: 'module',
          scripts: {
            start: 'node dist/index.js',
            build: 'tsc -b',
            test: 'node --test',
          },
          dependencies: {
            express: '^4.18.2',
            zod: '^3.22.4',
          },
          devDependencies: {
            typescript: '^5.3.3',
          },
        },
        null,
        2
      )
    );

    await fs.promises.writeFile(
      path.join(tempDir, 'README.md'),
      `# Payment Gateway Service
Robust financial transaction processing system with strict idempotency and audit logs.

## Architecture
- API Layer: Express HTTP endpoints for charge, refund, and webhook processing
- Domain Layer: Transaction aggregation, idempotent token validation
- Storage Layer: PostgreSQL transaction persistence with ACID guarantees

## Requirements & Scope
- Must support Stripe and PayPal providers
- Must guarantee at-least-once webhook delivery with idempotency deduplication
- Secret credentials must be stored via KMS
`
    );

    const srcDir = path.join(tempDir, 'src');
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(srcDir, 'index.ts'),
      `export const SERVICE_NAME = 'payment-gateway-service';\nexport function processPayment() { return true; }\n`
    );

    await fs.promises.writeFile(path.join(tempDir, '.gitignore'), `.ai-manager\nnode_modules\ndist\n`);

    // Initialize git repository
    try {
      await execFile('git', ['init', '-b', 'main'], { cwd: tempDir });
      await execFile('git', ['config', 'user.name', 'AIDM Integration Test'], { cwd: tempDir });
      await execFile('git', ['config', 'user.email', 'test@aidm.local'], { cwd: tempDir });
      await execFile('git', ['add', '.'], { cwd: tempDir });
      await execFile('git', ['commit', '-m', 'initial commit'], { cwd: tempDir });
    } catch {
      // Non-fatal fallback
    }

    // Initialize underlying authoritative stores via DefaultMcpOrchestratorDelegate
    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
    });

    // Seed DurableStateManager in INITIALIZING state
    await delegate.durableStateManager?.save({
      currentLifecycleState: LifecycleState.INITIALIZING,
      activeTaskId: null,
      blockedState: null,
      lastCheckpoint: 'chk-init-001',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Seed SpecStore with initial empty requirements and decisions
    await delegate.specStore?.saveRequirements([]);
    await delegate.specStore?.saveDecisions([]);

    // Seed HistoryManager with an initial lifecycle event
    await delegate.historyManager?.appendEvent({
      eventType: 'SYSTEM_BOOTSTRAPPED',
      actor: Actor.ORCHESTRATOR,
      payload: { workspace: tempDir, phase: 'PHASE_8' },
    });

    // Create MCP Server with all Phase 8 tools enabled
    transport = new InMemoryMcpTransport();
    server = new McpServer({
      transport,
      delegate,
      directorTools: true,
      discoveryTools: true,
      clarificationTools: true,
      approvalTools: true,
    });

    await server.start();
  });

  afterEach(async () => {
    try {
      if (server.isRunning()) {
        await server.stop();
      }
    } catch {
      // ignore
    }
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // 1. MCP INITIALIZATION & PROTOCOL HANDSHAKE
  // ==========================================================================
  it('T01_mcp_initialization: completes standard JSON-RPC 2.0 handshake and capability discovery', async () => {
    const initRes = await sendRpc<Record<string, unknown>>(server, 'initialize', {
      protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chatgpt-director', version: '1.0.0' },
    });

    assert.equal(initRes.jsonrpc, '2.0');
    assert.equal(initRes.id, 1);
    const result = initRes.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: { listChanged: boolean } };
      aidmVersion: string;
      foundationVersion: string;
    };
    assert.equal(result.protocolVersion, LATEST_MCP_PROTOCOL_VERSION);
    assert.equal(result.serverInfo.name, DEFAULT_MCP_SERVER_NAME);
    assert.equal(result.serverInfo.version, DEFAULT_MCP_SERVER_VERSION);
    assert.equal(result.aidmVersion, DEFAULT_AIDM_VERSION);
    assert.equal(result.foundationVersion, MCP_FOUNDATION_VERSION);
    assert.deepEqual(result.capabilities.tools, { listChanged: false });

    // Client notification notifications/initialized
    await server.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // Ping check
    const pingRes = await sendRpc(server, 'ping', undefined, 'ping-1');
    assert.deepEqual(pingRes.result, {});
  });

  // ==========================================================================
  // 2. TOOL REGISTRATION & BOUNDARIES
  // ==========================================================================
  it('T02_tool_registration: registers all 20 Phase 8 tools across read, discover, clarify, and approval domains', async () => {
    const listRes = await sendRpc<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>(
      server,
      'tools/list',
      undefined,
      'tools-list-1'
    );

    const tools = listRes.result.tools;
    assert.equal(tools.length, 20, 'Expected exactly 20 tools registered when all Phase 8 tools are enabled');

    const toolNames = new Set(tools.map((t) => t.name));

    // Health
    assert.ok(toolNames.has(AIDM_HEALTH_TOOL_NAME));

    // Read tools (9)
    for (const readTool of DIRECTOR_READ_TOOL_NAMES) {
      assert.ok(toolNames.has(readTool), `Missing read tool: ${readTool}`);
    }

    // Discovery (1)
    assert.ok(toolNames.has(AIDM_PROJECT_DISCOVER_TOOL_NAME));

    // Clarification (4)
    assert.ok(toolNames.has(AIDM_CLARIFICATION_CREATE_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_CLARIFICATION_GET_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_CLARIFICATION_ANSWER_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_CLARIFICATION_BLOCKING_TOOL_NAME));

    // Approval (5)
    assert.ok(toolNames.has(AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME));
    assert.ok(toolNames.has(AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME));
  });

  // ==========================================================================
  // 3. TOOL ENABLE/DISABLE CONFIGURATION
  // ==========================================================================
  it('T03_tool_enable_disable_configuration: registers only enabled groups and rejects calls to disabled tools', async () => {
    // Server with only read tools
    const readOnlyServer = new McpServer({
      transport: new InMemoryMcpTransport(),
      delegate,
      directorTools: true,
      discoveryTools: false,
      clarificationTools: false,
      approvalTools: false,
    });
    await readOnlyServer.start();

    const readOnlyTools = readOnlyServer.getRegisteredTools();
    assert.equal(readOnlyTools.length, 10); // health + 9 read tools

    // Attempting to call disabled discovery tool
    const disabledCallRes = await sendRpcError(
      readOnlyServer,
      'tools/call',
      { name: AIDM_PROJECT_DISCOVER_TOOL_NAME, arguments: {} },
      'err-disabled-1'
    );
    assert.equal(disabledCallRes.error.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);
    assert.match(disabledCallRes.error.message, /Unsupported tool/);

    // Attempting to call disabled approval tool
    const disabledApprovalRes = await sendRpcError(
      readOnlyServer,
      'tools/call',
      { name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME, arguments: {} },
      'err-disabled-2'
    );
    assert.equal(disabledApprovalRes.error.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);

    await readOnlyServer.stop();
  });

  // ==========================================================================
  // 4. JSON-RPC REQUEST CORRELATION
  // ==========================================================================
  it('T04_jsonrpc_request_correlation: preserves request correlation IDs throughout execution and errors', async () => {
    const res = await sendRpc(
      server,
      'tools/call',
      {
        name: AIDM_PROJECT_STATUS_TOOL_NAME,
        arguments: {},
        _directorSessionId: 'sess-director-42',
        _projectId: 'proj-gateway',
        _taskId: 'task-inspect',
        _executionIterationId: 'iter-001',
      },
      'corr-req-101'
    );

    assert.equal(res.id, 'corr-req-101');
    const statusData = parseToolResult<{ initialized: boolean; lifecycle: { state: string } }>(res);
    assert.equal(statusData.initialized, true);
    assert.equal(statusData.lifecycle.state, 'INITIALIZING');

    // Correlation on error
    const errRes = await sendRpcError(
      server,
      'tools/call',
      {
        name: 'non.existent.tool',
        arguments: {},
        _directorSessionId: 'sess-director-42',
      },
      'corr-err-202'
    );
    assert.equal(errRes.id, 'corr-err-202');
    assert.ok(errRes.error.data?.correlationId);
  });

  // ==========================================================================
  // 5. MALFORMED MCP REQUEST
  // ==========================================================================
  it('T05_malformed_mcp_request: deterministically rejects invalid envelopes and missing parameters', async () => {
    // Missing jsonrpc string
    const res1 = await server.handleMessage({ id: 1, method: 'ping' });
    assert.ok(res1 && 'error' in res1);
    assert.equal(res1.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);

    // Non-object payload
    const res2 = await server.handleMessage('not an object');
    assert.ok(res2 && 'error' in res2);
    assert.equal(res2.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);

    // Missing tool name in tools/call
    const res3 = await sendRpcError(server, 'tools/call', {}, 'missing-tool-name');
    assert.equal(res3.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.match(res3.error.message, /Missing required parameter "name"/);

    // Synthetic transport malformed JSON
    const res4 = await server.handleMessage({ method: '__malformed_json__' });
    assert.ok(res4 && 'error' in res4);
    assert.equal(res4.error.code, McpJsonRpcErrorCode.PARSE_ERROR);
  });

  // ==========================================================================
  // 6. READ TOOL INTEGRATION
  // ==========================================================================
  it('T06_read_tool_integration: queries all 9 read tools without mutating project or git state', async () => {
    const checksumBefore = await computeSourceChecksum(tempDir);

    // 1. project.status
    const statusRes = await sendRpc(server, 'tools/call', { name: AIDM_PROJECT_STATUS_TOOL_NAME });
    const status = parseToolResult<{ initialized: boolean; lifecycle: { state: string } }>(statusRes);
    assert.equal(status.initialized, true);
    assert.equal(status.lifecycle.state, 'INITIALIZING');

    // 2. project.requirements
    const reqRes = await sendRpc(server, 'tools/call', { name: AIDM_PROJECT_REQUIREMENTS_TOOL_NAME });
    const reqs = parseToolResult<{ requirements: unknown[] }>(reqRes);
    assert.ok(Array.isArray(reqs.requirements));

    // 3. project.decisions
    const decRes = await sendRpc(server, 'tools/call', { name: AIDM_PROJECT_DECISIONS_TOOL_NAME });
    const decs = parseToolResult<{ decisions: unknown[] }>(decRes);
    assert.ok(Array.isArray(decs.decisions));

    // 4. tasks.list
    const tasksRes = await sendRpc(server, 'tools/call', { name: AIDM_TASKS_LIST_TOOL_NAME });
    const tasks = parseToolResult<{ tasks: unknown[]; total: number }>(tasksRes);
    assert.equal(tasks.total, 0);
    assert.equal(tasks.tasks.length, 0);

    // 5. tasks.current
    const currRes = await sendRpc(server, 'tools/call', { name: AIDM_TASKS_CURRENT_TOOL_NAME });
    const curr = parseToolResult<{ hasActiveTask: boolean; task: unknown | null }>(currRes);
    assert.equal(curr.hasActiveTask, false);
    assert.equal(curr.task, null);

    // 6. context.get
    const ctxRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CONTEXT_GET_TOOL_NAME,
      arguments: { sourcePaths: ['package.json'], layer: 'L0' },
    });
    const ctx = parseToolResult<{ items: unknown[] }>(ctxRes);
    assert.ok(Array.isArray(ctx.items));

    // 7. evidence.get
    const evRes = await sendRpc(server, 'tools/call', { name: AIDM_EVIDENCE_GET_TOOL_NAME });
    const ev = parseToolResult<{ evidence: unknown[] }>(evRes);
    assert.ok(Array.isArray(ev.evidence));

    // 8. history.get
    const histRes = await sendRpc(server, 'tools/call', { name: AIDM_HISTORY_GET_TOOL_NAME });
    const hist = parseToolResult<{ events: Array<{ eventType: string }> }>(histRes);
    assert.ok(hist.events.some((e) => e.eventType === 'SYSTEM_BOOTSTRAPPED'));

    // 9. git.status
    const gitRes = await sendRpc(server, 'tools/call', { name: AIDM_GIT_STATUS_TOOL_NAME });
    const git = parseToolResult<{ branch: string; workingTreeClean: boolean }>(gitRes);
    assert.equal(git.branch, 'main');
    assert.equal(git.workingTreeClean, true);

    const checksumAfter = await computeSourceChecksum(tempDir);
    assert.equal(checksumBefore, checksumAfter, 'Source files must remain strictly unmodified after read queries');
  });

  // ==========================================================================
  // 7. DISCOVERY INTEGRATION
  // ==========================================================================
  it('T07_discovery_integration: executes bounded read-only project discovery with structured report', async () => {
    const checksumBefore = await computeSourceChecksum(tempDir);

    const res = await sendRpc(
      server,
      'tools/call',
      {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: { workspaceRoot: tempDir },
      },
      'disc-1'
    );

    const report = parseToolResult<ProjectDiscoveryReport>(res);

    assert.equal(report.projectIdentity.name, 'payment-gateway-service');
    assert.ok(
      report.projectIdentity.ecosystem.toLowerCase().includes('typescript') ||
        report.projectIdentity.ecosystem.toLowerCase().includes('node')
    );
    assert.equal(report.purpose.classification, 'UNDERSTOOD');
    assert.ok(report.technologyStack.primaryLanguages.includes('TypeScript'));
    assert.ok(report.commands.build);
    assert.ok(report.commands.test);
    assert.ok(Array.isArray(report.featureInventory));
    assert.ok(Array.isArray(report.facts));
    assert.ok(Array.isArray(report.unknowns));
    assert.ok(Array.isArray(report.contradictions));
    assert.ok(Array.isArray(report.clarificationCandidates));

    const checksumAfter = await computeSourceChecksum(tempDir);
    assert.equal(checksumBefore, checksumAfter, 'Discovery must not mutate source files');
  });

  // ==========================================================================
  // 8. DISCOVERY → CLARIFICATION INTEGRATION
  // ==========================================================================
  it('T08_discovery_to_clarification_integration: flows discovery report into clarification session without re-parsing', async () => {
    // 1. Run discovery
    const discRes = await sendRpc(server, 'tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const discoveryReport = parseToolResult<ProjectDiscoveryReport>(discRes);

    // 2. Create clarification session passing pre-computed discoveryReport directly
    const clarifRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        projectId: 'payment-gateway-service',
        discoveryReport,
      },
    });

    const session = parseToolResult<ClarificationSession>(clarifRes);
    assert.ok(session.sessionId.startsWith('clarify-session-'));
    assert.equal(session.projectId, 'payment-gateway-service');
    assert.ok(session.totalCount >= 0);
    assert.equal(session.resolvedCount, 0);

    // Verify session is retrievable via aidm.clarification.session.get
    const getRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_GET_TOOL_NAME,
      arguments: { sessionId: session.sessionId },
    });
    const retrieved = parseToolResult<ClarificationSession>(getRes);
    assert.equal(retrieved.sessionId, session.sessionId);
  });

  // ==========================================================================
  // 9. CLARIFICATION ANSWER INTEGRATION
  // ==========================================================================
  it('T09_clarification_answer_integration: validates and records human answers without mutating SpecStore', async () => {
    // Create clarification session with deterministic questions
    const sessionEngine = new ClarificationSessionEngine();
    const mockReport = createMockReport({
      unknowns: [
        {
          id: 'unk-provider',
          item: 'Which payment provider is primary for v1: Stripe or PayPal?',
          description: 'Payment providers mentioned in documentation without prioritization',
          impact: 'Blocking architecture decision required for provider adapter routing',
        },
      ],
    });

    const session = sessionEngine.createSession(mockReport);
    const store = new ClarificationStore({ baseDir: tempDir });
    await store.saveSession(session);

    assert.equal(session.blockingOpenCount, 1);
    const targetQ = session.questions[0];

    // Submit human answer via MCP tool
    const answerRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_ANSWER_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        sessionId: session.sessionId,
        clarificationId: targetQ.clarificationId,
        answerType: 'FREE_FORM',
        freeFormResponse: 'Stripe is the primary provider for v1; PayPal deferred to v2.',
        source: 'HUMAN',
        status: 'ANSWERED',
      },
    });

    const updatedSession = parseToolResult<ClarificationSession>(answerRes);
    assert.equal(updatedSession.blockingOpenCount, 0);
    assert.equal(updatedSession.resolvedCount, 1);
    assert.equal(updatedSession.status, 'RESOLVED');

    // Verify blocking query tool returns 0 blocking items
    const blockingRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_BLOCKING_TOOL_NAME,
      arguments: { sessionId: session.sessionId },
    });
    const blockingData = parseToolResult<{ blockingOpenCount: number; blockingQuestions: unknown[] }>(blockingRes);
    assert.equal(blockingData.blockingOpenCount, 0);
    assert.equal(blockingData.blockingQuestions.length, 0);

    // Verify SpecStore was NOT mutated by clarification answer
    const currentReqs = await delegate.specStore?.loadRequirements();
    assert.equal(currentReqs?.length, 0, 'Clarification answers must NOT mutate SpecStore requirements');
  });

  // ==========================================================================
  // 10. BLOCKING CLARIFICATION PREVENTS APPROVAL
  // ==========================================================================
  it('T10_blocking_clarification_prevents_approval: evaluates NOT_READY and blocks approval when questions are open', async () => {
    // 1. Create a clarification session with an unresolved blocking question
    const sessionEngine = new ClarificationSessionEngine();
    const mockReport = createMockReport({
      unknowns: [
        {
          id: 'unk-auth',
          item: 'Is mutual TLS required for all webhook endpoints?',
          description: 'Webhook security specifications missing',
          impact: 'Blocking security requirement required before implementation',
        },
      ],
    });
    const session = sessionEngine.createSession(mockReport);
    const clarifStore = new ClarificationStore({ baseDir: tempDir });
    await clarifStore.saveSession(session);

    // 2. Create approval package referencing this session
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        projectId: 'payment-gateway',
        clarificationSessionId: session.sessionId,
        discoveryReport: mockReport,
      },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    // 3. Query readiness
    const readyRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
      arguments: { packageId: pkg.packageId },
    });
    const readyData = parseToolResult<{
      currentStatus: string;
      readiness: { isReady: boolean; status: string; blockingConditions: { unresolvedBlockingClarifications: boolean } };
      isDevelopmentAuthorized: boolean;
    }>(readyRes);

    assert.equal(readyData.currentStatus, 'NOT_READY');
    assert.equal(readyData.readiness.isReady, false);
    assert.equal(readyData.readiness.status, 'NOT_READY');
    assert.equal(readyData.readiness.blockingConditions.unresolvedBlockingClarifications, true);
    assert.equal(readyData.isDevelopmentAuthorized, false);

    // 4. Attempting to approve package in NOT_READY state must be rejected
    const approveErrRes = await sendRpcError(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg.packageId,
        revision: pkg.revision,
        actor: 'Alice PO',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.match(approveErrRes.error.message, /NOT_READY/i);
  });

  // ==========================================================================
  // 11. DISCOVERY → UNDERSTANDING INTEGRATION
  // ==========================================================================
  it('T11_discovery_to_understanding_integration: constructs structured initial project understanding and plan', async () => {
    const createRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        projectId: 'payment-gateway-service',
      },
    });

    const pkg = parseToolResult<ProjectApprovalPackage>(createRes);
    assert.ok(pkg.packageId.startsWith('pkg-'));
    assert.equal(pkg.revision, 1);
    assert.equal(pkg.projectId, 'payment-gateway-service');
    assert.ok(pkg.projectUnderstanding);
    assert.equal(pkg.projectUnderstanding.projectId, 'payment-gateway-service');
    assert.ok(pkg.projectUnderstanding.architectureSummary);
    assert.ok(pkg.proposedDevelopmentPlan);
    assert.ok(pkg.proposedDevelopmentPlan.objectives.length > 0);
    assert.ok(pkg.proposedDevelopmentPlan.proposedScope.length > 0);
    assert.ok(pkg.proposedDevelopmentPlan.proposedFeatureGroups.length > 0);
  });

  // ==========================================================================
  // 12. UNDERSTANDING → APPROVAL READINESS
  // ==========================================================================
  it('T12_understanding_to_approval_readiness: transitions to READY_FOR_APPROVAL when all 5 conditions pass', async () => {
    const cleanReport = createMockReport();

    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        projectId: 'payment-gateway-service',
        discoveryReport: cleanReport,
      },
    });

    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);
    assert.equal(pkg.status, 'READY_FOR_APPROVAL');

    const readyRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
      arguments: { packageId: pkg.packageId },
    });
    const readyData = parseToolResult<{
      currentStatus: string;
      readiness: { isReady: boolean; status: string };
      isDevelopmentAuthorized: boolean;
    }>(readyRes);

    assert.equal(readyData.currentStatus, 'READY_FOR_APPROVAL');
    assert.equal(readyData.readiness.isReady, true);
    assert.equal(readyData.readiness.status, 'READY_FOR_APPROVAL');
    assert.equal(readyData.isDevelopmentAuthorized, false);
  });

  // ==========================================================================
  // 13. EXPLICIT PRODUCT OWNER APPROVAL
  // ==========================================================================
  it('T13_explicit_product_owner_approval: records approval with cryptographic hash and human audit record', async () => {
    const cleanReport = createMockReport();

    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir, discoveryReport: cleanReport },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    // Submit explicit Product Owner approval
    const approveRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg.packageId,
        revision: 1,
        actor: 'Alice ProductOwner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        comment: 'Initial scope approved for implementation.',
      },
    });

    const approvedPkg = parseToolResult<ProjectApprovalPackage>(approveRes);
    assert.equal(approvedPkg.status, 'APPROVED');
    assert.ok(approvedPkg.approvalRecord);
    assert.equal(approvedPkg.approvalRecord.actor, 'Alice ProductOwner');
    assert.equal(approvedPkg.approvalRecord.actorRole, 'PRODUCT_OWNER');
    assert.equal(approvedPkg.approvalRecord.intent, 'EXPLICIT_APPROVAL');
    assert.equal(approvedPkg.approvalRecord.revision, 1);
    assert.ok(approvedPkg.approvalRecord.packageHash);
    assert.equal(approvedPkg.approvalRecord.packageHash.length, 64);

    // Invariant: isDevelopmentAuthorized becomes true
    assert.equal(isDevelopmentAuthorized(approvedPkg), true);
  });

  // ==========================================================================
  // 14. INVALID APPROVAL ACTOR
  // ==========================================================================
  it('T14_invalid_approval_actor: strictly rejects approval attempts from non-human actors', async () => {
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    const forbiddenActors = ['EXECUTOR', 'ANTIGRAVITY', 'ORCHESTRATOR', 'SYSTEM'];

    for (const actor of forbiddenActors) {
      const errRes = await sendRpcError(server, 'tools/call', {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor,
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        },
      });
      assert.match(errRes.error.message, /Unauthorized approval actor/);
    }
  });

  // ==========================================================================
  // 15. INVALID APPROVAL INTENT
  // ==========================================================================
  it('T15_invalid_approval_intent: rejects ambiguous natural language strings as approval intent', async () => {
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    const invalidIntents = ['tamam', 'looks good', 'approved', 'proceed', 'yes'];

    for (const intent of invalidIntents) {
      const errRes = await sendRpcError(server, 'tools/call', {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'Alice PO',
          actorRole: 'PRODUCT_OWNER',
          intent,
        },
      });
      assert.ok(errRes.error);
    }
  });

  // ==========================================================================
  // 16. STALE REVISION APPROVAL
  // ==========================================================================
  it('T16_stale_revision_approval: rejects approval attempts when revision does not match current package revision', async () => {
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);
    assert.equal(pkg.revision, 1);

    const staleRes = await sendRpcError(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg.packageId,
        revision: 999, // Stale revision
        actor: 'Alice PO',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });

    assert.match(staleRes.error.message, /revision mismatch/);
  });

  // ==========================================================================
  // 17. REJECTION
  // ==========================================================================
  it('T17_rejection: records explicit rejection with reason and prevents development authorization', async () => {
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    const rejectRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg.packageId,
        revision: pkg.revision,
        actor: 'Bob PO',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_REJECTION',
        reason: 'Scope includes Stripe but client specifically requested Adyen only.',
      },
    });

    const rejectedPkg = parseToolResult<ProjectApprovalPackage>(rejectRes);
    assert.equal(rejectedPkg.status, 'REJECTED');
    assert.ok(rejectedPkg.rejectionRecord);
    assert.equal(rejectedPkg.rejectionRecord.actor, 'Bob PO');
    assert.equal(rejectedPkg.rejectionRecord.reason, 'Scope includes Stripe but client specifically requested Adyen only.');
    assert.equal(isDevelopmentAuthorized(rejectedPkg), false);
  });

  // ==========================================================================
  // 18. REVISION INVALIDATES PRIOR APPROVAL
  // ==========================================================================
  it('T18_revision_invalidates_prior_approval: supersedes revision N approval and requires new approval for N+1', async () => {
    const cleanReport = createMockReport();

    // 1. Create and approve Revision 1
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir, discoveryReport: cleanReport },
    });
    const pkgRev1 = parseToolResult<ProjectApprovalPackage>(pkgRes);

    const approveRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkgRev1.packageId,
        revision: 1,
        actor: 'Alice PO',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    const approvedRev1 = parseToolResult<ProjectApprovalPackage>(approveRes);
    assert.equal(isDevelopmentAuthorized(approvedRev1), true);

    // 2. Revise package to produce Revision 2
    const engine = new ApprovalPackageEngine();
    const { supersededPackage, newPackage } = engine.revisePackage(approvedRev1, {
      proposedPlan: {
        ...approvedRev1.proposedDevelopmentPlan,
        proposedScope: ['Scope update: include PayPal'],
      },
    });

    assert.equal(supersededPackage.status, 'SUPERSEDED');
    assert.equal(newPackage.revision, 2);
    assert.equal(newPackage.status, 'READY_FOR_APPROVAL');
    assert.equal(newPackage.approvalRecord, undefined);

    // Invariant: Revision 1 approval does NOT authorize Revision 2
    assert.equal(isDevelopmentAuthorized(newPackage), false);

    // Save and check via MCP
    const store = new ApprovalStore({ baseDir: tempDir });
    await store.savePackage(newPackage);

    const getRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
      arguments: { packageId: newPackage.packageId, revision: 2 },
    });
    const rev2Loaded = parseToolResult<ProjectApprovalPackage>(getRes);
    assert.equal(rev2Loaded.revision, 2);
    assert.equal(isDevelopmentAuthorized(rev2Loaded), false);
  });

  // ==========================================================================
  // 19. APPROVAL → DEVELOPMENT AUTHORIZATION
  // ==========================================================================
  it('T19_approval_to_development_authorization: isDevelopmentAuthorized is true ONLY after valid PO approval', async () => {
    const cleanReport = createMockReport();

    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir, discoveryReport: cleanReport },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);
    assert.equal(isDevelopmentAuthorized(pkg), false);

    const approveRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg.packageId,
        revision: 1,
        actor: 'Alice PO',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    const approvedPkg = parseToolResult<ProjectApprovalPackage>(approveRes);

    assert.equal(isDevelopmentAuthorized(approvedPkg), true);

    // Verify readiness tool also reports isDevelopmentAuthorized: true
    const readyRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
      arguments: { packageId: pkg.packageId },
    });
    const readyData = parseToolResult<{ isDevelopmentAuthorized: boolean }>(readyRes);
    assert.equal(readyData.isDevelopmentAuthorized, true);
  });

  // ==========================================================================
  // 20. NO AUTHORIZATION BEFORE APPROVAL
  // ==========================================================================
  it('T20_no_authorization_before_approval: isDevelopmentAuthorized is strictly false before explicit PO approval', async () => {
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    assert.equal(isDevelopmentAuthorized(pkg), false);

    const readyRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
      arguments: { packageId: pkg.packageId },
    });
    const readyData = parseToolResult<{ isDevelopmentAuthorized: boolean }>(readyRes);
    assert.equal(readyData.isDevelopmentAuthorized, false);
  });

  // ==========================================================================
  // 21. NO AUTOMATIC TASK DAG CREATION
  // ==========================================================================
  it('T21_no_automatic_task_dag_creation: discovery, clarification, and approval create ZERO implementation tasks', async () => {
    // 1. Run discovery
    await sendRpc(server, 'tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // 2. Create clarification session
    await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // 3. Create approval package
    await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // Check SpecStore tasks
    const specTasks = (await delegate.specStore?.loadTasks()) ?? [];
    assert.equal(specTasks.length, 0, 'SpecStore must have 0 implementation tasks created');

    const tasksListRes = await sendRpc(server, 'tools/call', { name: AIDM_TASKS_LIST_TOOL_NAME });
    const tasksData = parseToolResult<{ total: number }>(tasksListRes);
    assert.equal(tasksData.total, 0, 'aidm.tasks.list must report 0 tasks');
  });

  // ==========================================================================
  // 22. NO ANTIGRAVITY INVOCATION
  // ==========================================================================
  it('T22_no_antigravity_invocation: entire Phase 8 protocol operates with zero calls or references to Antigravity', () => {
    const registeredTools = server.getRegisteredTools();
    for (const tool of registeredTools) {
      assert.ok(!tool.name.toLowerCase().includes('antigravity'), `Tool name leaks Antigravity: ${tool.name}`);
      assert.ok(
        !tool.description.toLowerCase().includes('antigravity'),
        `Tool description leaks Antigravity: ${tool.name}`
      );
    }

    const serverObj = server as unknown as Record<string, unknown>;
    assert.equal(typeof serverObj.antigravity, 'undefined');
    assert.equal(typeof serverObj.invokeAntigravity, 'undefined');
    assert.equal(typeof serverObj.runAntigravity, 'undefined');
  });

  // ==========================================================================
  // 23. NO AUTONOMOUS EXECUTION
  // ==========================================================================
  it('T23_no_autonomous_execution: no autonomous loop or executor bridge is triggered', async () => {
    const serverObj = server as unknown as Record<string, unknown>;
    assert.equal(typeof serverObj.startLoop, 'undefined');
    assert.equal(typeof serverObj.runAutonomousLoop, 'undefined');
    assert.equal(typeof serverObj.executeTasks, 'undefined');

    // Lifecycle state in DurableStateManager remains INITIALIZING
    const state = await delegate.durableStateManager?.load();
    assert.equal(state?.currentLifecycleState, LifecycleState.INITIALIZING);
  });

  // ==========================================================================
  // 24. PERSISTENCE RECOVERY ACROSS FRESH SERVICE INSTANCES
  // ==========================================================================
  it('T24_persistence_recovery: recovers identical clarification and approval state through fresh service instance', async () => {
    // 1. Create clarification session and save
    const sessionEngine = new ClarificationSessionEngine();
    const mockReport = createMockReport();
    const session = sessionEngine.createSession(mockReport);
    const clarifStore1 = new ClarificationStore({ baseDir: tempDir });
    await clarifStore1.saveSession(session);

    // 2. Create approval package and approve
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(mockReport, session);
    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'Alice PO',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const approvalStore1 = new ApprovalStore({ baseDir: tempDir });
    await approvalStore1.savePackage(approvedPkg);

    // 3. Reconstruct completely fresh delegate and stores
    const freshDelegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const recoveredSession = await freshDelegate.clarificationStore?.getActiveSession();
    assert.ok(recoveredSession);
    assert.equal(recoveredSession?.sessionId, session.sessionId);

    const recoveredPkg = await freshDelegate.approvalStore?.getActivePackage();
    assert.ok(recoveredPkg);
    assert.equal(recoveredPkg?.packageId, approvedPkg.packageId);
    assert.equal(recoveredPkg?.revision, 1);
    assert.equal(recoveredPkg?.status, 'APPROVED');
    assert.equal(recoveredPkg?.approvalRecord?.actor, 'Alice PO');
    assert.equal(isDevelopmentAuthorized(recoveredPkg!), true);
  });

  // ==========================================================================
  // 25. HISTORY MANAGER AUDIT TRAIL
  // ==========================================================================
  it('T25_history_manager_audit_trail: records all major lifecycle events into append-only HistoryManager', async () => {
    // 1. Create clarification session
    await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // 2. Create approval package
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const pkg = parseToolResult<ProjectApprovalPackage>(pkgRes);

    // 3. Reject package
    await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg.packageId,
        revision: pkg.revision,
        actor: 'Alice PO',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_REJECTION',
        reason: 'Testing history events',
      },
    });

    // Verify history events via history tool
    const histRes = await sendRpc(server, 'tools/call', { name: AIDM_HISTORY_GET_TOOL_NAME });
    const hist = parseToolResult<{ events: Array<{ eventType: string; actor: string }> }>(histRes);

    const eventTypes = hist.events.map((e) => e.eventType);
    assert.ok(eventTypes.includes('CLARIFICATION_SESSION_SAVED'));
    assert.ok(eventTypes.includes('PROJECT_UNDERSTANDING_CREATED'));
    assert.ok(eventTypes.includes('PROJECT_UNDERSTANDING_REJECTED'));
  });

  // ==========================================================================
  // 26. EVIDENCE TRACEABILITY
  // ==========================================================================
  it('T26_evidence_traceability: discovery and understanding preserve authentic evidence references', async () => {
    const discRes = await sendRpc(server, 'tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const report = parseToolResult<ProjectDiscoveryReport>(discRes);

    assert.ok(report.projectIdentity.evidence.length > 0);
    const identityEv = report.projectIdentity.evidence[0];
    assert.ok(identityEv.sourceType);
    assert.ok(identityEv.sourceIdentifier);

    assert.ok(report.purpose.evidence.length > 0);
    const purposeEv = report.purpose.evidence[0];
    assert.ok(purposeEv.sourceType);
    assert.ok(purposeEv.sourceIdentifier);
  });

  // ==========================================================================
  // 27. SECRET SANITIZATION
  // ==========================================================================
  it('T27_secret_sanitization: redacts sensitive keys and credentials in MCP responses', async () => {
    const pkgRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        metadata: {
          clientSecret: 'SuperSecretPassword123',
          apiToken: 'sk_live_secret_token_abc',
        },
      },
    });

    const responseText = JSON.stringify(pkgRes.result);
    assert.ok(!responseText.includes('SuperSecretPassword123'), 'Secrets must be redacted in MCP output');
  });

  // ==========================================================================
  // 28. PATH TRAVERSAL REJECTION
  // ==========================================================================
  it('T28_path_traversal_rejection: rejects path traversal sequences in package and session IDs', async () => {
    // Malicious packageId
    const errRes1 = await sendRpcError(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
      arguments: { packageId: '../../etc/passwd' },
    });
    assert.match(errRes1.error.message, /illegal characters|path traversal/i);

    // Malicious sessionId
    const errRes2 = await sendRpcError(server, 'tools/call', {
      name: AIDM_CLARIFICATION_GET_TOOL_NAME,
      arguments: { sessionId: '../../../secrets' },
    });
    assert.ok(errRes2.error);
  });

  // ==========================================================================
  // 29. NO SECOND FSM
  // ==========================================================================
  it('T29_no_second_fsm: DurableStateManager remains the sole global FSM authority', async () => {
    // Check initial state
    const initialState = await delegate.durableStateManager?.load();
    assert.equal(initialState?.currentLifecycleState, LifecycleState.INITIALIZING);

    // Run discovery, clarification, approval
    await sendRpc(server, 'tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // DurableStateManager state must remain INITIALIZING (not mutated by MCP tools)
    const finalState = await delegate.durableStateManager?.load();
    assert.equal(finalState?.currentLifecycleState, LifecycleState.INITIALIZING);
  });

  // ==========================================================================
  // 30. NO DUPLICATE SOURCE OF TRUTH
  // ==========================================================================
  it('T30_no_duplicate_source_of_truth: MCP handlers read directly from authoritative delegate stores', async () => {
    // Add a requirement directly to SpecStore
    await delegate.specStore?.saveRequirements([
      {
        id: 'req-auth-001',
        title: 'OAuth2 Authentication',
        description: 'OAuth2 authentication required',
        status: 'DRAFT',
      },
    ]);

    // Query via MCP read tool
    const reqRes = await sendRpc(server, 'tools/call', { name: AIDM_PROJECT_REQUIREMENTS_TOOL_NAME });
    const reqData = parseToolResult<{ requirements: Array<{ id: string }> }>(reqRes);

    assert.equal(reqData.requirements.length, 1);
    assert.equal(reqData.requirements[0].id, 'req-auth-001');
  });

  // ==========================================================================
  // 31. READ-ONLY PROJECT PRESERVATION
  // ==========================================================================
  it('T31_read_only_project_preservation: complete protocol lifecycle preserves source files and Git commits', async () => {
    const sourceChecksumBefore = await computeSourceChecksum(tempDir);
    const gitStatusBefore = await delegate.gitPort?.inspectState(tempDir);

    // Run discovery
    await sendRpc(server, 'tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // Create clarification
    await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    // Create approval package
    await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });

    const sourceChecksumAfter = await computeSourceChecksum(tempDir);
    const gitStatusAfter = await delegate.gitPort?.inspectState(tempDir);

    assert.equal(sourceChecksumBefore, sourceChecksumAfter, 'Target workspace files must remain byte-identical');
    assert.equal(gitStatusBefore?.headCommit, gitStatusAfter?.headCommit, 'No new git commits may be created');
  });

  // ==========================================================================
  // 32. FULL PHASE 8 LIFECYCLE INTEGRATION (IN-MEMORY & STREAM TRANSPORT)
  // ==========================================================================
  it('T32_full_phase8_lifecycle_integration: executes the complete 18-step Phase 8 lifecycle end-to-end', async () => {
    // 1. Handshake
    const initRes = await sendRpc(server, 'initialize', {
      protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'director-e2e', version: '1.0.0' },
    });
    assert.equal(initRes.result.protocolVersion, LATEST_MCP_PROTOCOL_VERSION);

    // 2. Director reads project status
    const statusRes = await sendRpc(server, 'tools/call', { name: AIDM_PROJECT_STATUS_TOOL_NAME });
    const status = parseToolResult<{ initialized: boolean; lifecycle: { state: string } }>(statusRes);
    assert.equal(status.initialized, true);
    assert.equal(status.lifecycle.state, 'INITIALIZING');

    // 3. Director requests discovery
    const discRes = await sendRpc(server, 'tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: { workspaceRoot: tempDir },
    });
    const discReport = parseToolResult<ProjectDiscoveryReport>(discRes);
    assert.equal(discReport.projectIdentity.name, 'payment-gateway-service');

    // 4. Clarification session created from discovery findings with blocking question
    const sessionEngine = new ClarificationSessionEngine();
    const session = sessionEngine.createSession(
      createMockReport({
        unknowns: [
          {
            id: 'unk-e2e-blocking',
            item: 'Target SLA: 99.9% or 99.99%?',
            description: 'SLA requirement missing',
            impact: 'Blocking architecture decision required for redundancy architecture',
          },
        ],
      })
    );
    const clarifStore = new ClarificationStore({ baseDir: tempDir });
    await clarifStore.saveSession(session);

    // 5. Director reads clarification state & finds blocking question
    const blockingRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_BLOCKING_TOOL_NAME,
      arguments: { sessionId: session.sessionId },
    });
    const blockingData = parseToolResult<{
      sessionId: string;
      status: string;
      blockingOpenCount: number;
      blockingQuestions: Array<{ clarificationId: string; [k: string]: unknown }>;
    }>(blockingRes);
    assert.equal(blockingData.blockingOpenCount, 1);
    assert.equal(blockingData.blockingQuestions.length, 1);
    const targetQId = blockingData.blockingQuestions[0].clarificationId;

    // 6. Approval package created while question is blocking -> evaluates NOT_READY
    const pkg1Res = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        clarificationSessionId: session.sessionId,
        discoveryReport: discReport,
      },
    });
    const pkg1 = parseToolResult<ProjectApprovalPackage>(pkg1Res);
    assert.equal(pkg1.status, 'NOT_READY');
    assert.equal(isDevelopmentAuthorized(pkg1), false);

    // 7. Human submits answer to unblock
    const answerRes = await sendRpc(server, 'tools/call', {
      name: AIDM_CLARIFICATION_ANSWER_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        sessionId: session.sessionId,
        clarificationId: targetQId,
        answerType: 'FREE_FORM',
        freeFormResponse: 'Target SLA is 99.9% for MVP phase.',
        source: 'HUMAN',
        status: 'ANSWERED',
      },
    });
    const unblockedSession = parseToolResult<ClarificationSession>(answerRes);
    assert.equal(unblockedSession.blockingOpenCount, 0);

    // 8. Create approval package now that all blocking questions are resolved
    const pkg2Res = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        clarificationSessionId: session.sessionId,
        discoveryReport: discReport,
      },
    });
    const pkg2 = parseToolResult<ProjectApprovalPackage>(pkg2Res);
    assert.equal(pkg2.status, 'READY_FOR_APPROVAL');
    assert.equal(isDevelopmentAuthorized(pkg2), false);

    // 9. Query readiness tool
    const readinessRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
      arguments: { packageId: pkg2.packageId },
    });
    const readiness = parseToolResult<{ readiness: { isReady: boolean }; isDevelopmentAuthorized: boolean }>(
      readinessRes
    );
    assert.equal(readiness.readiness.isReady, true);
    assert.equal(readiness.isDevelopmentAuthorized, false);

    // 10. Product Owner explicitly approves exact revision 1
    const approveRes = await sendRpc(server, 'tools/call', {
      name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
      arguments: {
        workspaceRoot: tempDir,
        packageId: pkg2.packageId,
        revision: 1,
        actor: 'Alice ProductOwner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        comment: 'Full Phase 8 lifecycle approved.',
      },
    });
    const approvedPkg = parseToolResult<ProjectApprovalPackage>(approveRes);
    assert.equal(approvedPkg.status, 'APPROVED');

    // 11. Authoritative invariant: isDevelopmentAuthorized becomes true
    assert.equal(isDevelopmentAuthorized(approvedPkg), true);

    // 12. Persisted state recovers cleanly across a fresh instance
    const freshDelegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const loadedApproved = await freshDelegate.approvalStore?.getActivePackage();
    assert.ok(loadedApproved);
    assert.equal(loadedApproved?.status, 'APPROVED');
    assert.equal(isDevelopmentAuthorized(loadedApproved!), true);

    // 13. Verify stream framing transport integration (NDJSON duplex streams)
    const clientToReadable = new PassThrough();
    const serverToWritable = new PassThrough();
    const streamTransport = new StreamMcpTransport({
      readable: clientToReadable,
      writable: serverToWritable,
    });
    const streamServer = new McpServer({
      transport: streamTransport,
      delegate: freshDelegate,
      directorTools: true,
      approvalTools: true,
    });
    await streamServer.start();

    // Send NDJSON query through stream
    const ndjsonQuery = JSON.stringify({
      jsonrpc: '2.0',
      id: 'stream-readiness-1',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
        arguments: { packageId: approvedPkg.packageId },
      },
    }) + '\n';

    const chunkPromise = new Promise<string>((resolve) => {
      serverToWritable.once('data', (d) => resolve(d.toString('utf-8')));
    });

    clientToReadable.write(ndjsonQuery);
    const chunk = await chunkPromise;

    assert.ok(chunk, 'Expected response chunk from StreamMcpTransport');
    const parsedLine = JSON.parse(chunk.trim()) as McpSuccessResponseEnvelope;
    assert.equal(parsedLine.id, 'stream-readiness-1');
    const streamReadyData = parseToolResult<{ isDevelopmentAuthorized: boolean }>(parsedLine);
    assert.equal(streamReadyData.isDevelopmentAuthorized, true);

    await streamServer.stop();
  });
});
