/**
 * Phase 8 TASK-P8-02: Director Read-Only MCP Tools Tests
 *
 * Verifies all 25 required criteria:
 * 1. Tool registration (all 9 Director tools + aidm.health)
 * 2. Input schema validation
 * 3. Output schema validation
 * 4. aidm.project.status
 * 5. aidm.project.requirements
 * 6. aidm.project.decisions
 * 7. aidm.tasks.list
 * 8. aidm.tasks.current
 * 9. aidm.context.get
 * 10. aidm.evidence.get
 * 11. aidm.history.get
 * 12. aidm.git.status
 * 13. Empty / no-active-task behavior
 * 14. Missing / unknown IDs
 * 15. Stale-context reporting
 * 16. AGENT_CLAIM remains rejected / not promoted
 * 17. Secret sanitization
 * 18. Read-only mutation protection
 * 19. No Git mutation
 * 20. No OS execution
 * 21. No second state store
 * 22. No second DAG engine
 * 23. No second QA engine
 * 24. Pagination / bounded retrieval
 * 25. Deterministic repeated reads
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { promisify } from 'node:util';
import {
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_HEALTH_TOOL_NAME,
  AIDM_PROJECT_STATUS_TOOL_NAME,
  AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  AIDM_PROJECT_DECISIONS_TOOL_NAME,
  AIDM_TASKS_LIST_TOOL_NAME,
  AIDM_TASKS_CURRENT_TOOL_NAME,
  AIDM_CONTEXT_GET_TOOL_NAME,
  AIDM_EVIDENCE_GET_TOOL_NAME,
  AIDM_HISTORY_GET_TOOL_NAME,
  AIDM_GIT_STATUS_TOOL_NAME,
  DIRECTOR_READ_TOOL_NAMES,
  registerDirectorReadTools,
  SpecStore,
  DurableStateManager,
  HistoryManager,
  CheckpointStore,
  ContextEngine,
  TaskDagEngine,
  DefaultGitPort,
  LifecycleState,
  Actor,
  RiskLevel,
  EvidenceType,
  EvidenceSource,
  type SystemVerifiedEvidence,
  type TaskDefinition,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
} from '../dist/index.js';

const execFile = promisify(child_process.execFile);

describe('Phase 8 Director Read-Only MCP Tools (TASK-P8-02)', () => {
  let tempDir: string;
  let transport: InMemoryMcpTransport;
  let server: McpServer;
  let delegate: DefaultMcpOrchestratorDelegate;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8-02-test-'));

    try {
      await execFile('git', ['init', '-b', 'main'], { cwd: tempDir });
      await execFile('git', ['config', 'user.name', 'AIDM Test'], { cwd: tempDir });
      await execFile('git', ['config', 'user.email', 'aidm-test@example.com'], { cwd: tempDir });
      const initFile = path.join(tempDir, 'README.md');
      await fs.promises.writeFile(initFile, '# Test Project\n');
      const gitignoreFile = path.join(tempDir, '.gitignore');
      await fs.promises.writeFile(gitignoreFile, '.ai-manager\n');
      await execFile('git', ['add', '.'], { cwd: tempDir });
      await execFile('git', ['commit', '-m', 'initial commit'], { cwd: tempDir });
    } catch {
      // Git command fallback
    }

    delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    transport = new InMemoryMcpTransport();
    server = new McpServer({
      transport,
      delegate,
      directorTools: true,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: `req-${Date.now()}-${Math.random()}`,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    };
    const res = await server.handleMessage(req);
    assert.ok(res, `Tool ${name} call returned null response`);
    if ('error' in res) {
      throw new Error(`Tool ${name} failed: ${(res as McpErrorResponseEnvelope).error.message}`);
    }
    const successRes = res as McpSuccessResponseEnvelope<{ content: Array<{ type: string; text: string }> }>;
    assert.ok(successRes.result?.content?.[0]?.text, `Missing content in ${name} result`);
    return JSON.parse(successRes.result.content[0].text);
  }

  // ==========================================================================
  // 1. TOOL REGISTRATION
  // ==========================================================================
  it('T01_tool_registration: registers all 9 Director read tools plus health tool', async () => {
    const listRes = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as McpSuccessResponseEnvelope<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>;

    const registered = listRes.result.tools;
    assert.equal(registered.length, 10);

    const registeredNames = registered.map((t) => t.name);
    assert.ok(registeredNames.includes(AIDM_HEALTH_TOOL_NAME));

    for (const name of DIRECTOR_READ_TOOL_NAMES) {
      assert.ok(registeredNames.includes(name), `Missing tool registration: ${name}`);
      const toolDef = registered.find((t) => t.name === name)!;
      assert.ok(toolDef.description.toLowerCase().includes('read-only'), `${name} description must declare read-only`);
      assert.ok(toolDef.inputSchema, `${name} must have inputSchema`);
    }

    // Direct registration function verification
    const standaloneServer = new McpServer({ transport: new InMemoryMcpTransport() });
    assert.equal(standaloneServer.getRegisteredTools().length, 1);
    registerDirectorReadTools(standaloneServer);
    assert.equal(standaloneServer.getRegisteredTools().length, 10);
  });

  // ==========================================================================
  // 2. INPUT SCHEMA VALIDATION
  // ==========================================================================
  it('T02_input_schema_validation: invalid arguments fail with typed McpInvalidRequestError', async () => {
    // 1. Invalid status enum on aidm.project.requirements
    const req1: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'inv-1',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
        arguments: { status: 'INVALID_STATUS' },
      },
    };
    const res1 = (await server.handleMessage(req1)) as McpErrorResponseEnvelope;
    assert.ok(res1.error);
    assert.equal(res1.error.code, -32600);
    assert.ok(res1.error.message.includes('Invalid arguments'));

    // 2. Missing required sourcePaths on aidm.context.get
    const req2: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'inv-2',
      method: 'tools/call',
      params: {
        name: AIDM_CONTEXT_GET_TOOL_NAME,
        arguments: {}, // missing required sourcePaths
      },
    };
    const res2 = (await server.handleMessage(req2)) as McpErrorResponseEnvelope;
    assert.ok(res2.error);
    assert.equal(res2.error.code, -32600);

    // 3. Negative limit on aidm.history.get
    const req3: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'inv-3',
      method: 'tools/call',
      params: {
        name: AIDM_HISTORY_GET_TOOL_NAME,
        arguments: { limit: -5 },
      },
    };
    const res3 = (await server.handleMessage(req3)) as McpErrorResponseEnvelope;
    assert.ok(res3.error);
    assert.equal(res3.error.code, -32600);
  });

  // ==========================================================================
  // 3. OUTPUT SCHEMA VALIDATION
  // ==========================================================================
  it('T03_output_schema_validation: output adheres to MCP contract and correlation ID is preserved', async () => {
    const rawResult = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 'output-val-1',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_STATUS_TOOL_NAME,
        _directorSessionId: 'director-session-42',
      },
    })) as McpSuccessResponseEnvelope<{ content: Array<{ type: string; text: string }> }>;

    assert.equal(rawResult.jsonrpc, '2.0');
    assert.equal(rawResult.id, 'output-val-1');
    assert.ok(Array.isArray(rawResult.result.content));
    assert.equal(rawResult.result.content[0].type, 'text');

    const parsed = JSON.parse(rawResult.result.content[0].text);
    assert.ok(parsed.correlationId);
    assert.ok(typeof parsed.correlationId === 'string');
    assert.equal(parsed.projectRoot, tempDir);
  });

  // ==========================================================================
  // 4. aidm.project.status
  // ==========================================================================
  it('T04_project_status: returns authoritative project lifecycle, active task, and blocked state', async () => {
    const durableManager = new DurableStateManager({ baseDir: tempDir });
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-001',
      completedTaskIds: ['TASK-000'],
      blockedState: {
        blockedTaskId: 'TASK-001',
        blockedIteration: 2,
        blockedContextReference: 'BUILD_FAILURE',
        blockingReason: 'TypeScript compilation failed on missing export',
        resumePoint: 'TASK_SELECTION',
      },
      lastCheckpoint: 'cp-known-good-01',
    });

    const status = (await callTool(AIDM_PROJECT_STATUS_TOOL_NAME)) as any;

    assert.equal(status.initialized, true);
    assert.equal(status.orchestrator.available, true);
    assert.equal(status.lifecycle.state, LifecycleState.TASK_LOOP);
    assert.equal(status.lifecycle.isBlocked, true);
    assert.equal(status.lifecycle.blockedState?.blockedTaskId, 'TASK-001');
    assert.equal(status.lifecycle.blockedState?.blockingReason, 'TypeScript compilation failed on missing export');
    assert.equal(status.tasks.activeTaskId, 'TASK-001');
    assert.equal(status.tasks.completedTasksCount, 1);
    assert.deepEqual(status.tasks.completedTaskIds, ['TASK-000']);
    assert.equal(status.checkpoints.lastCheckpoint, 'cp-known-good-01');
  });

  // ==========================================================================
  // 5. aidm.project.requirements
  // ==========================================================================
  it('T05_project_requirements: reads authoritative locked requirements from SpecStore', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'User Authentication',
        description: 'Secure JWT authentication',
        authority: Actor.USER,
        status: 'LOCKED',
        metadata: { acceptance_criteria: ['Must reject invalid password', 'Must issue token'] },
      },
      {
        id: 'REQ-002',
        title: 'Audit Logging',
        description: 'Record all user actions',
        authority: Actor.USER,
        status: 'LOCKED',
      },
    ]);

    const res = (await callTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME)) as any;

    assert.equal(res.isAuthoritative, true);
    assert.equal(res.total, 2);
    assert.equal(res.requirements.length, 2);
    assert.equal(res.requirements[0].id, 'REQ-001');
    assert.equal(res.requirements[0].authority, 'USER');
    assert.equal(res.requirements[0].status, 'LOCKED');
    assert.deepEqual(res.requirements[0].acceptanceCriteria, [
      'Must reject invalid password',
      'Must issue token',
    ]);
  });

  // ==========================================================================
  // 6. aidm.project.decisions
  // ==========================================================================
  it('T06_project_decisions: reads authoritative architecture decisions from SpecStore', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveDecisions([
      {
        id: 'DEC-001',
        title: 'Use SQLite for L0 Index',
        description: 'Fast metadata caching using node:sqlite',
        authority: Actor.DIRECTOR,
        status: 'LOCKED',
        rationale: 'Zero external dependencies and instant querying',
      },
    ]);

    const res = (await callTool(AIDM_PROJECT_DECISIONS_TOOL_NAME)) as any;

    assert.equal(res.isAuthoritative, true);
    assert.equal(res.total, 1);
    assert.equal(res.decisions[0].id, 'DEC-001');
    assert.equal(res.decisions[0].authority, 'DIRECTOR');
    assert.equal(res.decisions[0].rationale, 'Zero external dependencies and instant querying');
  });

  // ==========================================================================
  // 7. aidm.tasks.list
  // ==========================================================================
  it('T07_tasks_list: returns task DAG with topological order via TaskDagEngine', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    const tasks: TaskDefinition[] = [
      {
        task_id: 'FEAT-001',
        title: 'Backend Features',
        description: 'Features',
        hierarchy_level: 'FEATURE',
        parent_feature_id: 'ROOT',
        dependencies: [],
        acceptance_criteria: ['All tests pass'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
      {
        task_id: 'TASK-001',
        title: 'Database Setup',
        description: 'Initialize schema',
        hierarchy_level: 'TASK',
        parent_feature_id: 'FEAT-001',
        dependencies: [],
        acceptance_criteria: ['Schema passes validation'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
      {
        task_id: 'TASK-002',
        title: 'Auth Endpoints',
        description: 'Implement login endpoint',
        hierarchy_level: 'TASK',
        parent_feature_id: 'FEAT-001',
        dependencies: ['TASK-001'],
        acceptance_criteria: ['POST /login returns 200 on success'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
    ];
    await specStore.saveTasks(tasks);

    const res = (await callTool(AIDM_TASKS_LIST_TOOL_NAME)) as any;

    assert.equal(res.total, 3);
    assert.equal(res.validation.valid, true);
    assert.deepEqual(res.topologicalOrder, ['FEAT-001', 'TASK-001', 'TASK-002']);
    assert.equal(res.tasks[1].taskId, 'TASK-001');
    assert.equal(res.tasks[2].taskId, 'TASK-002');
    assert.deepEqual(res.tasks[2].dependencies, ['TASK-001']);
  });

  // ==========================================================================
  // 8. aidm.tasks.current
  // ==========================================================================
  it('T08_tasks_current: returns active task details and blocked state', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveTasks([
      {
        task_id: 'TASK-ACTIVE',
        title: 'Active Feature Task',
        description: 'Currently executing task',
        hierarchy_level: 'TASK',
        parent_feature_id: 'FEAT-001',
        dependencies: [],
        acceptance_criteria: ['Tests pass'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 1,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
    ]);

    const durableManager = new DurableStateManager({ baseDir: tempDir });
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: 'TASK-ACTIVE',
      completedTaskIds: [],
    });

    const res = (await callTool(AIDM_TASKS_CURRENT_TOOL_NAME)) as any;

    assert.equal(res.hasActiveTask, true);
    assert.ok(res.task);
    assert.equal(res.task.taskId, 'TASK-ACTIVE');
    assert.equal(res.task.title, 'Active Feature Task');
  });

  // ==========================================================================
  // 9. aidm.context.get
  // ==========================================================================
  it('T09_context_get: returns L0, L1, and L2 context targeted by path without full-repo dump', async () => {
    // Write sample file
    const samplePath = 'src/example.ts';
    const fullSamplePath = path.join(tempDir, samplePath);
    await fs.promises.mkdir(path.dirname(fullSamplePath), { recursive: true });
    await fs.promises.writeFile(
      fullSamplePath,
      'export interface SampleInterface {\n  id: string;\n  name: string;\n}\nexport function doWork(): void {}\n'
    );

    // 1. Query L0
    const l0Res = (await callTool(AIDM_CONTEXT_GET_TOOL_NAME, {
      sourcePaths: [samplePath],
      layer: 'L0',
    })) as any;

    assert.equal(l0Res.items.length, 1);
    assert.equal(l0Res.items[0].layer, 'L0');
    assert.ok(l0Res.items[0].fileHash);
    assert.equal(l0Res.items[0].content, undefined);

    // 2. Query L1
    const l1Res = (await callTool(AIDM_CONTEXT_GET_TOOL_NAME, {
      sourcePaths: [samplePath],
      layer: 'L1',
    })) as any;

    assert.equal(l1Res.items[0].layer, 'L1');
    assert.ok(l1Res.items[0].interfaces.some((i: string) => i.includes('SampleInterface')));
    assert.equal(l1Res.items[0].content, undefined);

    // 3. Query L2
    const l2Res = (await callTool(AIDM_CONTEXT_GET_TOOL_NAME, {
      sourcePaths: [samplePath],
      layer: 'L2',
    })) as any;

    assert.equal(l2Res.items[0].layer, 'L2');
    assert.ok(l2Res.items[0].content.includes('SampleInterface'));
  });

  it('T09_context_get_path_escape: path escaping workspace is rejected', async () => {
    const escapeReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'esc-1',
      method: 'tools/call',
      params: {
        name: AIDM_CONTEXT_GET_TOOL_NAME,
        arguments: { sourcePaths: ['../../outside/secret.txt'] },
      },
    };
    const res = (await server.handleMessage(escapeReq)) as McpErrorResponseEnvelope;
    assert.ok(res.error);
    assert.equal(res.error.code, -32600);
    assert.ok(res.error.message.includes('escapes workspace root'));
  });

  // ==========================================================================
  // 10. aidm.evidence.get
  // ==========================================================================
  it('T10_evidence_get: returns validated system-verified evidence with command and hashes', async () => {
    const validEvidence: SystemVerifiedEvidence = {
      evidence_id: 'evi-valid-01',
      task_id: 'TASK-001',
      instruction_id: 'inst-01',
      project_id: 'proj-test',
      correlation_id: 'corr-01',
      command: 'pnpm test',
      exit_code: 0,
      stdout_tail: 'All 5 tests passed',
      stderr: null,
      working_directory: tempDir,
      execution_time_ms: 120,
      git_head_before: '0123456789abcdef0123456789abcdef01234567',
      git_head_after: '0123456789abcdef0123456789abcdef01234567',
      unified_diff: null,
      file_hashes_after: { 'src/app.ts': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      evidence_type: EvidenceType.TEST,
      executor_identity: { provider: 'node', name: 'process' },
      captured_at: new Date().toISOString(),
      metadata: null,
      source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
    };

    // Record evidence in history event
    const historyManager = new HistoryManager({ baseDir: tempDir });
    await historyManager.appendEvent({
      eventType: 'EVIDENCE_COLLECTED',
      actor: Actor.ORCHESTRATOR,
      taskId: 'TASK-001',
      payload: { evidence: [validEvidence] },
    });

    const res = (await callTool(AIDM_EVIDENCE_GET_TOOL_NAME, { taskId: 'TASK-001' })) as any;

    assert.equal(res.total, 1);
    assert.equal(res.evidence[0].evidenceId, 'evi-valid-01');
    assert.equal(res.evidence[0].command, 'pnpm test');
    assert.equal(res.evidence[0].exitCode, 0);
    assert.equal(res.evidence[0].validationStatus, 'VALID');
  });

  // ==========================================================================
  // 11. aidm.history.get
  // ==========================================================================
  it('T11_history_get: returns immutable events and supports eventType and actor filtering', async () => {
    const historyManager = new HistoryManager({ baseDir: tempDir });
    await historyManager.appendEvent({
      eventId: 'evt-01',
      timestamp: '2026-09-24T00:00:01Z',
      eventType: 'TASK_SELECTED',
      actor: Actor.ORCHESTRATOR,
      taskId: 'TASK-100',
      payload: { iteration: 1 },
    });
    await historyManager.appendEvent({
      eventId: 'evt-02',
      timestamp: '2026-09-24T00:00:02Z',
      eventType: 'QA_REVIEW',
      actor: Actor.DIRECTOR,
      taskId: 'TASK-100',
      payload: { decision: 'ACCEPT' },
    });

    // 1. All events
    const all = (await callTool(AIDM_HISTORY_GET_TOOL_NAME)) as any;
    assert.equal(all.total, 2);
    assert.equal(all.events.length, 2);

    // 2. Filter by actor
    const directorOnly = (await callTool(AIDM_HISTORY_GET_TOOL_NAME, { actor: 'DIRECTOR' })) as any;
    assert.equal(directorOnly.total, 1);
    assert.equal(directorOnly.events[0].eventId, 'evt-02');
  });

  // ==========================================================================
  // 12. aidm.git.status
  // ==========================================================================
  it('T12_git_status: returns authoritative HEAD commit, branch, and clean state without mutation', async () => {
    const checkpointStore = new CheckpointStore(tempDir);
    await checkpointStore.recordCheckpoint({
      checkpoint_id: 'cp-accepted-01',
      task_id: 'TASK-PREV',
      commit_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      branch: 'main',
      purpose: 'POST_FLIGHT',
      created_at: new Date().toISOString(),
      is_known_good: true,
    });

    const res = (await callTool(AIDM_GIT_STATUS_TOOL_NAME)) as any;

    assert.equal(res.isGitRepository, true);
    assert.ok(res.head);
    assert.equal(res.workingTreeClean, true);
    assert.equal(res.totalAcceptedCheckpoints, 1);
    assert.equal(res.lastAcceptedCheckpoint?.checkpointId, 'cp-accepted-01');
  });

  // ==========================================================================
  // 13. EMPTY / NO-ACTIVE-TASK BEHAVIOR
  // ==========================================================================
  it('T13_empty_and_no_active_task: returns explicit null when no active task exists', async () => {
    const res = (await callTool(AIDM_TASKS_CURRENT_TOOL_NAME)) as any;

    assert.equal(res.hasActiveTask, false);
    assert.equal(res.task, null);
    assert.equal(res.reason, 'NO_ACTIVE_TASK');
  });

  // ==========================================================================
  // 14. MISSING / UNKNOWN IDS
  // ==========================================================================
  it('T14_missing_unknown_ids: non-existent requirement, decision, or evidence returns empty set', async () => {
    const reqRes = (await callTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME, { id: 'REQ-NONEXISTENT' })) as any;
    assert.equal(reqRes.total, 0);
    assert.deepEqual(reqRes.requirements, []);

    const decRes = (await callTool(AIDM_PROJECT_DECISIONS_TOOL_NAME, { id: 'DEC-NONEXISTENT' })) as any;
    assert.equal(decRes.total, 0);
    assert.deepEqual(decRes.decisions, []);

    const eviRes = (await callTool(AIDM_EVIDENCE_GET_TOOL_NAME, { evidenceId: 'evi-nonexistent' })) as any;
    assert.equal(eviRes.total, 0);
    assert.deepEqual(eviRes.evidence, []);
  });

  // ==========================================================================
  // 15. STALE-CONTEXT REPORTING
  // ==========================================================================
  it('T15_stale_context_reporting: identifies stale file without silently refreshing index', async () => {
    const contextEngine = new ContextEngine({ workspaceRoot: tempDir });
    await contextEngine.initialize();

    const filePath = 'tracked-file.txt';
    const absPath = path.join(tempDir, filePath);
    await fs.promises.writeFile(absPath, 'initial content');

    // Sync index once to establish baseline hash in SQLite
    await contextEngine.syncIndex();

    // Now modify the file on disk without calling syncIndex
    await fs.promises.writeFile(absPath, 'modified content that is different');

    const res = (await callTool(AIDM_CONTEXT_GET_TOOL_NAME, { sourcePaths: [filePath], layer: 'L0' })) as any;

    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].isStale, true);
    assert.notEqual(res.items[0].indexedHash, res.items[0].currentHash);

    // Verify index was NOT silently refreshed
    const l0Again = await contextEngine.getL0Context(filePath);
    assert.notEqual(l0Again.fileHash, res.items[0].currentHash);
  });

  // ==========================================================================
  // 16. AGENT_CLAIM REMAINS REJECTED / NOT PROMOTED
  // ==========================================================================
  it('T16_agent_claim_rejected: AGENT_CLAIM is filtered out and never promoted to system evidence', async () => {
    const claimPayload = {
      evidence_id: 'evi-agent-claim-01',
      task_id: 'TASK-001',
      instruction_id: 'inst-01',
      project_id: 'proj-test',
      correlation_id: 'corr-01',
      command: 'echo fake test passed',
      exit_code: 0,
      source: EvidenceSource.AGENT_CLAIM, // Explicit claim
      is_agent_claim: true,
      working_directory: tempDir,
      execution_time_ms: 10,
    };

    const validEvidence: SystemVerifiedEvidence = {
      evidence_id: 'evi-real-02',
      task_id: 'TASK-001',
      instruction_id: 'inst-01',
      project_id: 'proj-test',
      correlation_id: 'corr-01',
      command: 'pnpm test',
      exit_code: 0,
      stdout_tail: 'Pass',
      stderr: null,
      working_directory: tempDir,
      execution_time_ms: 100,
      git_head_before: '0123456789abcdef0123456789abcdef01234567',
      git_head_after: '0123456789abcdef0123456789abcdef01234567',
      unified_diff: null,
      file_hashes_after: null,
      evidence_type: EvidenceType.COMMAND,
      executor_identity: null,
      capturedAt: new Date().toISOString(),
      metadata: null,
      source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
    };

    const historyManager = new HistoryManager({ baseDir: tempDir });
    await historyManager.appendEvent({
      eventType: 'EVIDENCE_COLLECTED',
      actor: Actor.EXECUTOR,
      taskId: 'TASK-001',
      payload: {
        evidence: [claimPayload, validEvidence],
      },
    });

    const res = (await callTool(AIDM_EVIDENCE_GET_TOOL_NAME, { taskId: 'TASK-001' })) as any;

    assert.equal(res.total, 1);
    assert.equal(res.rejectedClaimsCount, 1);
    assert.equal(res.evidence[0].evidenceId, 'evi-real-02');
  });

  // ==========================================================================
  // 17. SECRET SANITIZATION
  // ==========================================================================
  it('T17_secret_sanitization: sensitive keys, tokens, and passwords are redacted', async () => {
    const historyManager = new HistoryManager({ baseDir: tempDir });
    await historyManager.appendEvent({
      eventType: 'SECRET_EVENT',
      actor: Actor.ORCHESTRATOR,
      taskId: 'TASK-SECRET',
      payload: {
        api_token: 'Bearer secret_value_123456789',
        secret_key: 'sk-abcdef123456789012345678',
        password: 'super_secret_password',
        safe_field: 'public_value',
      },
    });

    const res = (await callTool(AIDM_HISTORY_GET_TOOL_NAME, { taskId: 'TASK-SECRET' })) as any;

    const payload = res.events[0].payload;
    assert.equal(payload.api_token, '***REDACTED***');
    assert.equal(payload.secret_key, '***REDACTED***');
    assert.equal(payload.password, '***REDACTED***');
    assert.equal(payload.safe_field, 'public_value');
  });

  // ==========================================================================
  // 18. READ-ONLY MUTATION PROTECTION
  // ==========================================================================
  it('T18_read_only_mutation_protection: invoking every Director tool does not mutate project state', async () => {
    const durableManager = new DurableStateManager({ baseDir: tempDir });
    await durableManager.save({
      currentLifecycleState: LifecycleState.REQUIREMENTS_INGESTION,
      activeTaskId: null,
      completedTaskIds: [],
    });

    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveRequirements([
      { id: 'REQ-1', title: 'R1', description: 'D1', authority: Actor.USER, status: 'LOCKED' },
    ]);
    await specStore.saveDecisions([
      { id: 'DEC-1', title: 'D1', description: 'Desc1', authority: Actor.DIRECTOR, status: 'LOCKED' },
    ]);
    await specStore.saveTasks([
      {
        task_id: 'TASK-1',
        title: 'T1',
        hierarchy_level: 'TASK',
        parent_feature_id: 'FEAT-1',
        dependencies: [],
        acceptance_criteria: ['A'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-1'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
    ]);

    // Snapshot state before tool calls
    const stateBefore = await durableManager.load();
    const reqsBefore = await specStore.loadRequirements();
    const decsBefore = await specStore.loadDecisions();
    const tasksBefore = await specStore.loadTasks();

    // Call each of the 9 tools
    await callTool(AIDM_PROJECT_STATUS_TOOL_NAME);
    await callTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME);
    await callTool(AIDM_PROJECT_DECISIONS_TOOL_NAME);
    await callTool(AIDM_TASKS_LIST_TOOL_NAME);
    await callTool(AIDM_TASKS_CURRENT_TOOL_NAME);
    await callTool(AIDM_CONTEXT_GET_TOOL_NAME, { sourcePaths: ['README.md'] });
    await callTool(AIDM_EVIDENCE_GET_TOOL_NAME);
    await callTool(AIDM_HISTORY_GET_TOOL_NAME);
    await callTool(AIDM_GIT_STATUS_TOOL_NAME);

    // Snapshot state after tool calls
    const stateAfter = await durableManager.load();
    const reqsAfter = await specStore.loadRequirements();
    const decsAfter = await specStore.loadDecisions();
    const tasksAfter = await specStore.loadTasks();

    assert.deepEqual(stateAfter, stateBefore, 'Durable state was mutated by read tools');
    assert.deepEqual(reqsAfter, reqsBefore, 'Requirements were mutated by read tools');
    assert.deepEqual(decsAfter, decsBefore, 'Decisions were mutated by read tools');
    assert.deepEqual(tasksAfter, tasksBefore, 'Tasks were mutated by read tools');
  });

  // ==========================================================================
  // 19. NO GIT MUTATION
  // ==========================================================================
  it('T19_no_git_mutation: git.status does not mutate git log or create commits', async () => {
    const { stdout: commitsBefore } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: tempDir });

    await callTool(AIDM_GIT_STATUS_TOOL_NAME);

    const { stdout: commitsAfter } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: tempDir });
    assert.equal(commitsAfter.trim(), commitsBefore.trim(), 'Git HEAD commit was changed by git.status');
  });

  // ==========================================================================
  // 20. NO OS EXECUTION
  // ==========================================================================
  it('T20_no_os_execution: no arbitrary shell or command execution tools are registered', () => {
    const registered = server.getRegisteredTools().map((t) => t.name.toLowerCase());
    assert.ok(!registered.includes('exec'));
    assert.ok(!registered.includes('run_command'));
    assert.ok(!registered.includes('shell'));
    assert.ok(!registered.includes('bash'));
    assert.ok(!registered.includes('terminal'));
  });

  // ==========================================================================
  // 21. NO SECOND STATE STORE
  // ==========================================================================
  it('T21_no_second_state_store: MCP delegates directly to DurableStateManager', async () => {
    // Modify durable state directly and confirm project.status immediately reflects it
    const durableManager = new DurableStateManager({ baseDir: tempDir });
    await durableManager.save({
      currentLifecycleState: LifecycleState.ARCHITECTURE_SPEC,
      activeTaskId: null,
      completedTaskIds: [],
    });

    const status = (await callTool(AIDM_PROJECT_STATUS_TOOL_NAME)) as any;
    assert.equal(status.lifecycle.state, LifecycleState.ARCHITECTURE_SPEC);
  });

  // ==========================================================================
  // 22. NO SECOND DAG ENGINE
  // ==========================================================================
  it('T22_no_second_dag_engine: tasks.list uses authoritative TaskDagEngine', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    // Write cyclical tasks to verify TaskDagEngine cycle detection triggers
    await specStore.saveTasks([
      {
        task_id: 'FEAT-1',
        title: 'Feature 1',
        description: 'Feature 1 description',
        hierarchy_level: 'FEATURE',
        parent_feature_id: 'ROOT',
        dependencies: [],
        acceptance_criteria: ['Parent feature criteria'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
      {
        task_id: 'TASK-CYC-1',
        title: 'Cyc 1',
        description: 'Cyclical task 1 description',
        hierarchy_level: 'TASK',
        parent_feature_id: 'FEAT-1',
        dependencies: ['TASK-CYC-2'],
        acceptance_criteria: ['A'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
      {
        task_id: 'TASK-CYC-2',
        title: 'Cyc 2',
        description: 'Cyclical task 2 description',
        hierarchy_level: 'TASK',
        parent_feature_id: 'FEAT-1',
        dependencies: ['TASK-CYC-1'],
        acceptance_criteria: ['B'],
        traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH',
        risk_level: RiskLevel.CAUTION,
      },
    ]);

    const res = (await callTool(AIDM_TASKS_LIST_TOOL_NAME)) as any;
    assert.equal(res.validation.valid, false);
    assert.ok(res.validation.issues.some((i: any) => i.category === 'CIRCULAR_DEPENDENCY_CHECK'));
  });

  // ==========================================================================
  // 23. NO SECOND QA ENGINE
  // ==========================================================================
  it('T23_no_second_qa_engine: MCP delegates to validateSystemVerifiedEvidence', async () => {
    const historyManager = new HistoryManager({ baseDir: tempDir });
    // Add invalid evidence (negative exit code)
    await historyManager.appendEvent({
      eventType: 'EVIDENCE_COLLECTED',
      actor: Actor.ORCHESTRATOR,
      taskId: 'TASK-001',
      payload: {
        evidence: [
          {
            evidence_id: 'evi-bad-exit',
            task_id: 'TASK-001',
            command: 'test',
            exit_code: -1, // invalid per EvidenceValidator
            source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
          },
        ],
      },
    });

    const res = (await callTool(AIDM_EVIDENCE_GET_TOOL_NAME, { taskId: 'TASK-001' })) as any;
    assert.equal(res.total, 0);
    assert.equal(res.rejectedClaimsCount, 1);
  });

  // ==========================================================================
  // 24. PAGINATION / BOUNDED RETRIEVAL
  // ==========================================================================
  it('T24_pagination: supports limit and offset on large datasets', async () => {
    const historyManager = new HistoryManager({ baseDir: tempDir });
    for (let i = 1; i <= 10; i++) {
      await historyManager.appendEvent({
        eventId: `evt-page-${i}`,
        timestamp: `2026-09-24T00:00:${String(i).padStart(2, '0')}Z`,
        eventType: 'PAGE_EVENT',
        actor: Actor.ORCHESTRATOR,
        payload: { index: i },
      });
    }

    const page1 = (await callTool(AIDM_HISTORY_GET_TOOL_NAME, { limit: 3, offset: 0 })) as any;
    assert.equal(page1.total, 10);
    assert.equal(page1.events.length, 3);
    assert.equal(page1.events[0].eventId, 'evt-page-1');
    assert.equal(page1.hasMore, true);

    const page2 = (await callTool(AIDM_HISTORY_GET_TOOL_NAME, { limit: 3, offset: 3 })) as any;
    assert.equal(page2.events.length, 3);
    assert.equal(page2.events[0].eventId, 'evt-page-4');
  });

  // ==========================================================================
  // 25. DETERMINISTIC REPEATED READS
  // ==========================================================================
  it('T25_deterministic_repeated_reads: repeated invocations return identical payloads', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveRequirements([
      { id: 'REQ-DET-1', title: 'Determinism', description: 'Repeatable', authority: Actor.USER, status: 'LOCKED' },
    ]);

    const read1 = (await callTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME)) as any;
    const read2 = (await callTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME)) as any;
    const read3 = (await callTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME)) as any;

    const { correlationId: _c1, ...data1 } = read1;
    const { correlationId: _c2, ...data2 } = read2;
    const { correlationId: _c3, ...data3 } = read3;

    assert.deepEqual(data1, data2);
    assert.deepEqual(data2, data3);
  });
});
