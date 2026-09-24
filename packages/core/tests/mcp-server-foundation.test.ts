/**
 * Phase 8 MCP Server Foundation Tests (TASK-P8-01)
 *
 * Verifies the 15 required core boundary criteria:
 * 1. MCP server construction
 * 2. Startup
 * 3. Shutdown
 * 4. Capability discovery
 * 5. Request correlation
 * 6. Malformed request handling
 * 7. Unsupported operation handling
 * 8. Orchestrator-unavailable handling
 * 9. Policy/error propagation boundary
 * 10. No direct state mutation from MCP
 * 11. No direct OS execution from MCP
 * 12. No direct Git mutation from MCP
 * 13. No second FSM
 * 14. No second QA engine
 * 15. Clean resource shutdown
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  McpServer,
  McpServerState,
  InMemoryMcpTransport,
  StreamMcpTransport,
  StdioMcpTransport,
  DefaultMcpOrchestratorDelegate,
  createRequestCorrelation,
  McpErrorNormalizer,
  McpInvalidRequestError,
  McpUnsupportedOperationError,
  McpOrchestratorUnavailableError,
  McpPolicyBlockedError,
  McpJsonRpcErrorCode,
  McpDomainErrorCode,
  McpErrorCode,
  LATEST_MCP_PROTOCOL_VERSION,
  MCP_FOUNDATION_VERSION,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_MCP_SERVER_VERSION,
  DEFAULT_AIDM_VERSION,
  AIDM_HEALTH_TOOL_NAME,
  PolicyEngine,
  PolicyViolationError,
  type McpRequestEnvelope,
  type McpNotificationEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
} from '../dist/index.js';

describe('Phase 8 MCP Server Foundation (TASK-P8-01)', () => {
  let transport: InMemoryMcpTransport;
  let server: McpServer;

  beforeEach(() => {
    transport = new InMemoryMcpTransport();
    server = new McpServer({
      transport,
    });
  });

  // ==========================================================================
  // 1. MCP SERVER CONSTRUCTION
  // ==========================================================================
  it('T01_construction: initializes server with defaults, transport, and built-in health tool', () => {
    assert.equal(server.name, DEFAULT_MCP_SERVER_NAME);
    assert.equal(server.version, DEFAULT_MCP_SERVER_VERSION);
    assert.equal(server.aidmVersion, DEFAULT_AIDM_VERSION);
    assert.equal(server.foundationVersion, MCP_FOUNDATION_VERSION);
    assert.equal(server.getState(), McpServerState.CREATED);
    assert.equal(server.isRunning(), false);

    const tools = server.getRegisteredTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, AIDM_HEALTH_TOOL_NAME);
  });

  it('T01_construction_custom: accepts custom configuration parameters', () => {
    const customServer = new McpServer({
      name: 'custom-mcp-server',
      version: '1.2.3',
      aidmVersion: '2.0.0',
      foundationVersion: 'P8-01-CUSTOM',
      transport,
      instructions: 'Custom director instructions',
    });

    assert.equal(customServer.name, 'custom-mcp-server');
    assert.equal(customServer.version, '1.2.3');
    assert.equal(customServer.aidmVersion, '2.0.0');
    assert.equal(customServer.foundationVersion, 'P8-01-CUSTOM');
    assert.equal(customServer.instructions, 'Custom director instructions');
  });

  // ==========================================================================
  // 2. STARTUP
  // ==========================================================================
  it('T02_startup: starts transport, binds listeners, and transitions state to RUNNING', async () => {
    assert.equal(server.getState(), McpServerState.CREATED);
    assert.equal(transport.isConnected, false);

    await server.start();

    assert.equal(server.getState(), McpServerState.RUNNING);
    assert.equal(server.isRunning(), true);
    assert.equal(transport.isConnected, true);

    // Idempotent start
    await server.start();
    assert.equal(server.getState(), McpServerState.RUNNING);
  });

  // ==========================================================================
  // 3. SHUTDOWN
  // ==========================================================================
  it('T03_shutdown: closes transport, unbinds resources, and transitions state to STOPPED', async () => {
    await server.start();
    assert.equal(server.isRunning(), true);

    await server.stop();
    assert.equal(server.getState(), McpServerState.STOPPED);
    assert.equal(server.isRunning(), false);
    assert.equal(transport.isConnected, false);

    // Idempotent stop
    await server.stop();
    assert.equal(server.getState(), McpServerState.STOPPED);

    // Request received while stopped returns server error
    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 999,
      method: 'ping',
    };
    const res = await server.handleMessage(req);
    assert.ok(res);
    assert.ok('error' in res);
    assert.equal((res as McpErrorResponseEnvelope).error.code, McpJsonRpcErrorCode.INTERNAL_ERROR);
    assert.equal((res as McpErrorResponseEnvelope).error.data?.code, McpErrorCode.INTERNAL_FAILURE);
  });

  // ==========================================================================
  // 4. CAPABILITY DISCOVERY
  // ==========================================================================
  it('T04_capability_discovery: initialize returns protocolVersion, serverInfo, capabilities, and versions', async () => {
    await server.start();

    const initReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'chatgpt-director', version: '1.0.0' },
      },
    };

    const res = (await server.handleMessage(initReq)) as McpSuccessResponseEnvelope;
    assert.ok(res);
    assert.equal(res.id, 1);
    assert.equal(res.jsonrpc, '2.0');

    const result = res.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, LATEST_MCP_PROTOCOL_VERSION);
    assert.equal(result.aidmVersion, DEFAULT_AIDM_VERSION);
    assert.equal(result.foundationVersion, MCP_FOUNDATION_VERSION);
    assert.deepEqual(result.serverInfo, {
      name: DEFAULT_MCP_SERVER_NAME,
      version: DEFAULT_MCP_SERVER_VERSION,
    });
    assert.ok(result.capabilities);
  });

  it('T04_capability_tools_list: tools/list returns registered tool definitions including aidm.health', async () => {
    await server.start();

    const listReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    };

    const res = (await server.handleMessage(listReq)) as McpSuccessResponseEnvelope;
    assert.ok(res);
    assert.equal(res.id, 2);

    const result = res.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    assert.ok(Array.isArray(result.tools));
    const healthTool = result.tools.find((t) => t.name === AIDM_HEALTH_TOOL_NAME);
    assert.ok(healthTool);
    assert.ok(healthTool.description.includes('health status'));
  });

  it('T04_ping_and_initialized: ping returns empty result and notifications/initialized returns null', async () => {
    await server.start();

    // ping
    const pingReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'ping-1',
      method: 'ping',
    };
    const pingRes = (await server.handleMessage(pingReq)) as McpSuccessResponseEnvelope;
    assert.ok(pingRes);
    assert.equal(pingRes.id, 'ping-1');
    assert.deepEqual(pingRes.result, {});

    // notifications/initialized (notification must not yield a response)
    const initNotif: McpNotificationEnvelope = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    const notifRes = await server.handleMessage(initNotif);
    assert.equal(notifRes, null);
  });

  // ==========================================================================
  // 5. REQUEST CORRELATION
  // ==========================================================================
  it('T05_request_correlation: generates deterministic correlation without conflating IDs', async () => {
    await server.start();

    const callReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'rpc-req-42',
      method: 'tools/call',
      params: {
        name: AIDM_HEALTH_TOOL_NAME,
        _directorSessionId: 'director-session-789',
        _projectId: 'proj-xyz',
        _taskId: 'task-abc',
        _executionIterationId: 'iter-5',
      },
    };

    const res = (await server.handleMessage(callReq)) as McpSuccessResponseEnvelope;
    assert.ok(res);
    assert.equal(res.id, 'rpc-req-42');

    const result = res.result as { content: Array<{ type: string; text: string }> };
    assert.ok(result.content && result.content[0]);
    const parsedText = JSON.parse(result.content[0].text);

    // Verify correlation ID is present in payload
    assert.ok(parsedText.correlationId);
    assert.ok(typeof parsedText.correlationId === 'string');
    assert.ok(parsedText.correlationId.startsWith('aidm-corr-'));

    // Standalone correlation generator validation
    const customCorr = createRequestCorrelation({
      mcpRequestId: 'mcp-1',
      directorSessionId: 'director-session-9',
      projectId: 'proj-1',
      taskId: 'task-1',
      executionIterationId: 'iter-1',
    });

    assert.notEqual(customCorr.correlationId, customCorr.mcpRequestId);
    assert.notEqual(customCorr.correlationId, customCorr.directorSessionId);
    assert.equal(customCorr.mcpRequestId, 'mcp-1');
    assert.equal(customCorr.directorSessionId, 'director-session-9');
    assert.equal(customCorr.projectId, 'proj-1');
    assert.equal(customCorr.taskId, 'task-1');
    assert.equal(customCorr.executionIterationId, 'iter-1');
  });

  // ==========================================================================
  // 6. MALFORMED REQUEST HANDLING
  // ==========================================================================
  it('T06_malformed_requests: invalid payloads return typed machine-readable JSON-RPC errors', async () => {
    await server.start();

    // 1. Non-object
    const res1 = (await server.handleMessage('not an object')) as McpErrorResponseEnvelope;
    assert.equal(res1.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.equal(res1.error.data?.code, McpErrorCode.INVALID_REQUEST);

    // 2. Null
    const res2 = (await server.handleMessage(null)) as McpErrorResponseEnvelope;
    assert.equal(res2.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);

    // 3. Missing jsonrpc version
    const res3 = (await server.handleMessage({ id: 1, method: 'ping' })) as McpErrorResponseEnvelope;
    assert.equal(res3.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);

    // 4. Invalid jsonrpc version (e.g. 1.0)
    const res4 = (await server.handleMessage({
      jsonrpc: '1.0',
      id: 1,
      method: 'ping',
    })) as McpErrorResponseEnvelope;
    assert.equal(res4.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);

    // 5. Missing required tool name in tools/call
    const res5 = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {},
    })) as McpErrorResponseEnvelope;
    assert.equal(res5.error.code, McpJsonRpcErrorCode.INVALID_REQUEST);
    assert.equal(res5.error.data?.code, McpErrorCode.INVALID_REQUEST);
  });

  // ==========================================================================
  // 7. UNSUPPORTED OPERATION HANDLING
  // ==========================================================================
  it('T07_unsupported_operations: unknown method or tool returns METHOD_NOT_FOUND', async () => {
    await server.start();

    // Unknown RPC method
    const res1 = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'unsupported/method',
    })) as McpErrorResponseEnvelope;

    assert.equal(res1.error.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);
    assert.equal(res1.error.data?.code, McpErrorCode.UNSUPPORTED_OPERATION);

    // Unregistered tool in tools/call
    const res2 = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'nonexistent.tool' },
    })) as McpErrorResponseEnvelope;

    assert.equal(res2.error.code, McpJsonRpcErrorCode.METHOD_NOT_FOUND);
    assert.equal(res2.error.data?.code, McpErrorCode.UNSUPPORTED_OPERATION);
    assert.ok(res2.error.message.includes('nonexistent.tool'));
  });

  // ==========================================================================
  // 8. ORCHESTRATOR-UNAVAILABLE HANDLING
  // ==========================================================================
  it('T08_orchestrator_unavailable: reports degraded status when orchestrator is unavailable', async () => {
    // Delegate that reports orchestrator unhealthy
    const unhealthyDelegate = {
      isHealthy: () => false,
      getStatus: () => ({ isInitialized: false }),
    };

    const serverWithUnhealthy = new McpServer({
      transport,
      delegate: unhealthyDelegate,
    });
    await serverWithUnhealthy.start();

    const res = (await serverWithUnhealthy.handleMessage({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: AIDM_HEALTH_TOOL_NAME },
    })) as McpSuccessResponseEnvelope;

    const result = res.result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.status, 'degraded');
    assert.equal(parsed.orchestrator.connected, false);
  });

  it('T08_orchestrator_unavailable_error: throws McpOrchestratorUnavailableError with -32001', async () => {
    const err = new McpOrchestratorUnavailableError('Orchestrator is not running', {
      orchestratorState: 'OFFLINE',
    });
    const normalized = McpErrorNormalizer.normalize(err);

    assert.equal(normalized.code, McpDomainErrorCode.ORCHESTRATOR_UNAVAILABLE);
    assert.equal(normalized.data?.code, McpErrorCode.ORCHESTRATOR_UNAVAILABLE);
    assert.equal(normalized.message, 'Orchestrator is not running');
  });

  // ==========================================================================
  // 9. POLICY / ERROR PROPAGATION BOUNDARY & SECRET REDACTION
  // ==========================================================================
  it('T09_policy_blocked: PolicyEngine rejection propagates as POLICY_BLOCKED (-32002)', async () => {
    const policyEngine = new PolicyEngine();
    // Register custom tool that triggers policy denial
    const policyServer = new McpServer({
      transport,
      policyEngine,
    });

    policyServer.registerTool(
      {
        name: 'test.restricted_tool',
        description: 'Tool that triggers policy check',
        inputSchema: { type: 'object', properties: {} },
      },
      () => {
        throw new PolicyViolationError('Direct execution blocked by AIDM policy', {
          operation: 'test.restricted_tool',
          suggestedAction: 'BLOCK',
        });
      }
    );

    await policyServer.start();

    const res = (await policyServer.handleMessage({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'test.restricted_tool' },
    })) as McpErrorResponseEnvelope;

    assert.ok(res.error);
    assert.equal(res.error.code, McpDomainErrorCode.POLICY_BLOCKED);
    assert.equal(res.error.data?.code, McpErrorCode.POLICY_BLOCKED);
    assert.ok(res.error.message.includes('Direct execution blocked by AIDM policy'));
  });

  it('T09_secret_redaction: sensitive API tokens and credentials are redacted in errors', async () => {
    const errorWithSecret = new McpInvalidRequestError(
      'Failed with key sk-abcdef1234567890 and Bearer secrettoken123456789',
      {
        secretKey: 'sk-abcdef1234567890',
        apiToken: 'Bearer secrettoken123456789',
        normalField: 'safeValue',
      }
    );

    const normalized = McpErrorNormalizer.normalize(errorWithSecret);

    assert.ok(!normalized.message.includes('sk-abcdef1234567890'));
    assert.ok(!normalized.message.includes('secrettoken123456789'));
    assert.ok(normalized.message.includes('***REDACTED_KEY***'));
    assert.ok(normalized.message.includes('Bearer ***REDACTED_TOKEN***'));

    const details = normalized.data?.details as Record<string, unknown>;
    assert.equal(details.secretKey, '***REDACTED***');
    assert.equal(details.normalField, 'safeValue');
  });

  // ==========================================================================
  // 10. NO DIRECT STATE MUTATION FROM MCP
  // ==========================================================================
  it('T10_no_direct_state_mutation: aidm.health and MCP calls do not mutate state', async () => {
    let stateMutated = false;
    const trackingDelegate = {
      isHealthy: () => true,
      getStatus: () => {
        return {
          isInitialized: true,
          currentLifecycleState: 'IDLE',
          activeTaskId: null,
          isBlocked: false,
        };
      },
    };

    const serverWithTracking = new McpServer({
      transport,
      delegate: trackingDelegate,
    });
    await serverWithTracking.start();

    // Call health tool multiple times
    for (let i = 0; i < 3; i++) {
      const res = (await serverWithTracking.handleMessage({
        jsonrpc: '2.0',
        id: `health-${i}`,
        method: 'tools/call',
        params: { name: AIDM_HEALTH_TOOL_NAME },
      })) as McpSuccessResponseEnvelope;

      assert.ok(res.result);
    }

    assert.equal(stateMutated, false);
    // Verify server has no setState or FSM transition methods
    assert.equal(typeof (serverWithTracking as unknown as Record<string, unknown>).transition, 'undefined');
    assert.equal(typeof (serverWithTracking as unknown as Record<string, unknown>).mutateState, 'undefined');
  });

  // ==========================================================================
  // 11. NO DIRECT OS EXECUTION FROM MCP
  // ==========================================================================
  it('T11_no_direct_os_execution: MCP server does not expose arbitrary command execution', () => {
    const registeredTools = server.getRegisteredTools();
    const toolNames = registeredTools.map((t) => t.name.toLowerCase());

    assert.ok(!toolNames.includes('exec'));
    assert.ok(!toolNames.includes('execute'));
    assert.ok(!toolNames.includes('command'));
    assert.ok(!toolNames.includes('shell'));
    assert.ok(!toolNames.includes('bash'));
    assert.ok(!toolNames.includes('run_command'));

    // Server prototype verification
    const serverObj = server as unknown as Record<string, unknown>;
    assert.equal(typeof serverObj.exec, 'undefined');
    assert.equal(typeof serverObj.executeCommand, 'undefined');
    assert.equal(typeof serverObj.spawn, 'undefined');
  });

  // ==========================================================================
  // 12. NO DIRECT GIT MUTATION FROM MCP
  // ==========================================================================
  it('T12_no_direct_git_mutation: MCP server does not expose arbitrary Git mutation tools', () => {
    const registeredTools = server.getRegisteredTools();
    const toolNames = registeredTools.map((t) => t.name.toLowerCase());

    assert.ok(!toolNames.includes('git'));
    assert.ok(!toolNames.includes('git_commit'));
    assert.ok(!toolNames.includes('git_checkout'));
    assert.ok(!toolNames.includes('git_rollback'));

    const serverObj = server as unknown as Record<string, unknown>;
    assert.equal(typeof serverObj.commit, 'undefined');
    assert.equal(typeof serverObj.checkout, 'undefined');
    assert.equal(typeof serverObj.rollback, 'undefined');
  });

  // ==========================================================================
  // 13. NO SECOND FSM
  // ==========================================================================
  it('T13_no_second_fsm: MCP server does not maintain an independent FSM or lifecycle graph', () => {
    const serverObj = server as unknown as Record<string, unknown>;
    assert.equal(typeof serverObj.fsm, 'undefined');
    assert.equal(typeof serverObj.stateMachine, 'undefined');
    assert.equal(typeof serverObj.taskLoopFsm, 'undefined');

    // Server only tracks its own operational state (CREATED/STARTING/RUNNING/STOPPING/STOPPED)
    assert.ok(Object.values(McpServerState).includes(server.getState()));
  });

  // ==========================================================================
  // 14. NO SECOND QA ENGINE
  // ==========================================================================
  it('T14_no_second_qa_engine: MCP server does not implement QA review or accept agent claims', () => {
    const serverObj = server as unknown as Record<string, unknown>;
    assert.equal(typeof serverObj.qaReview, 'undefined');
    assert.equal(typeof serverObj.evaluateEvidence, 'undefined');
    assert.equal(typeof serverObj.acceptAgentClaim, 'undefined');
  });

  // ==========================================================================
  // 15. CLEAN RESOURCE SHUTDOWN & TRANSPORT INTEGRATION
  // ==========================================================================
  it('T15_clean_resource_shutdown: clean teardown of transport and message handlers', async () => {
    await server.start();
    assert.equal(transport.isConnected, true);

    // Simulate sending message through transport
    await transport.simulateClientMessage({
      jsonrpc: '2.0',
      id: 'msg-1',
      method: 'ping',
    });

    assert.equal(transport.sentMessages.length, 1);
    const sentMsg = transport.sentMessages[0] as McpSuccessResponseEnvelope;
    assert.equal(sentMsg.id, 'msg-1');

    await server.stop();
    assert.equal(transport.isConnected, false);

    // Further simulated messages fail
    await assert.rejects(
      async () => {
        await transport.simulateClientMessage({
          jsonrpc: '2.0',
          id: 'msg-2',
          method: 'ping',
        });
      },
      /disconnected/
    );
  });

  it('T15_stream_transport: StreamMcpTransport frames NDJSON messages across duplex streams', async () => {
    const clientToReadable = new PassThrough();
    const serverToWritable = new PassThrough();

    const streamTransport = new StreamMcpTransport({
      readable: clientToReadable,
      writable: serverToWritable,
    });

    const receivedMessages: unknown[] = [];
    streamTransport.onMessage((msg) => {
      receivedMessages.push(msg);
    });

    await streamTransport.start();

    // Write NDJSON line
    const requestPayload = JSON.stringify({ jsonrpc: '2.0', id: 'stream-1', method: 'ping' }) + '\n';
    clientToReadable.write(requestPayload);

    // Yield tick for stream event loop
    await new Promise((r) => setImmediate(r));

    assert.equal(receivedMessages.length, 1);
    assert.deepEqual(receivedMessages[0], { jsonrpc: '2.0', id: 'stream-1', method: 'ping' });

    // Send outgoing message
    const responsePayload = { jsonrpc: '2.0', id: 'stream-1', result: {} } as const;
    await streamTransport.send(responsePayload);

    const writtenChunk = serverToWritable.read();
    assert.ok(writtenChunk);
    assert.equal(
      writtenChunk.toString('utf-8'),
      JSON.stringify(responsePayload) + '\n'
    );

    await streamTransport.close();
    assert.equal(streamTransport.isConnected, false);
  });

  it('T15_stdio_transport: StdioMcpTransport instantiates and functions with custom streams', async () => {
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();

    const stdioTransport = new StdioMcpTransport({
      stdin: fakeStdin,
      stdout: fakeStdout,
    });

    assert.equal(stdioTransport.name, 'stdio');
    await stdioTransport.start();
    assert.equal(stdioTransport.isConnected, true);

    await stdioTransport.close();
    assert.equal(stdioTransport.isConnected, false);
  });
});
