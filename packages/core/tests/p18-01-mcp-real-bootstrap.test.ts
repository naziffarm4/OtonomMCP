import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExternalMcpClient } from './helpers/external-mcp-client.ts';


describe('P18-01: Real MCP Server + External Client Bootstrap', () => {
  let targetDir: string;
  let client: ExternalMcpClient;
  let serverPid: number | undefined;

  before(async () => {
    // 1. Create an isolated target project directory outside the AIDM repository
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p18-01-target-'));
    // Create a dummy file in target to verify source integrity
    await fs.writeFile(path.join(targetDir, 'dummy.txt'), 'clean pilot project context\n', 'utf-8');
  });

  after(async () => {
    if (client && client.isRunning) {
      await client.stop();
    }
    // Clean up isolated target project directory
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('AC-01 & AC-02: starts AIDM MCP server as an independent real process over stdio transport', async () => {
    client = new ExternalMcpClient({
      projectRoot: targetDir,
    });

    await client.start();

    assert.ok(client.isRunning, 'Server process should be running');
    assert.ok(typeof client.serverPid === 'number', 'Server PID must be a valid number');
    assert.notEqual(client.serverPid, client.clientPid, 'Server PID must be distinct from Client PID (process boundary)');
    serverPid = client.serverPid;
  });

  it('AC-03: initialize succeeds over the real transport with protocol negotiation and capabilities', async () => {
    const initResponse = await client.request<{
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
      aidmVersion: string;
      foundationVersion: string;
    }>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'external-pilot-director',
        version: '1.0.0',
      },
    });

    assert.equal(initResponse.jsonrpc, '2.0');
    assert.equal(initResponse.error, undefined, `Unexpected error: ${JSON.stringify(initResponse.error)}`);
    assert.ok(initResponse.result, 'Response must include result payload');
    assert.equal(initResponse.result.protocolVersion, '2024-11-05');
    assert.equal(initResponse.result.serverInfo.name, 'aidm-mcp-server');
    assert.equal(initResponse.result.aidmVersion, '0.1.0');
    assert.equal(initResponse.result.foundationVersion, 'P8-01');
    assert.deepEqual(initResponse.result.capabilities, {
      tools: { listChanged: false },
    });

    // Send initialized notification
    await client.notify('notifications/initialized');
  });

  it('AC-04: tools/list succeeds and returns real registered tools with valid schemas', async () => {
    const toolsResponse = await client.request<{
      tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    }>('tools/list', {});

    assert.equal(toolsResponse.jsonrpc, '2.0');
    assert.equal(toolsResponse.error, undefined);
    assert.ok(Array.isArray(toolsResponse.result?.tools), 'Tools must be an array');

    const tools = toolsResponse.result!.tools;
    assert.ok(tools.length >= 30, `Expected >= 30 registered tools, observed ${tools.length}`);

    // Verify key canonical tools exist
    const toolNames = new Set(tools.map((t) => t.name));
    assert.ok(toolNames.has('aidm.health'), 'aidm.health must be registered');
    assert.ok(toolNames.has('aidm.project.status'), 'aidm.project.status must be registered');
    assert.ok(toolNames.has('aidm.git.status'), 'aidm.git.status must be registered');
    assert.ok(toolNames.has('aidm.tasks.list'), 'aidm.tasks.list must be registered');
    assert.ok(toolNames.has('aidm.project.discover'), 'aidm.project.discover must be registered');
    assert.ok(toolNames.has('aidm.director.session.create'), 'aidm.director.session.create must be registered');

    // Verify schemas are valid
    for (const tool of tools) {
      assert.ok(tool.name && typeof tool.name === 'string', 'Tool name must be string');
      assert.ok(tool.description && typeof tool.description === 'string', `Tool ${tool.name} must have description`);
      assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `Tool ${tool.name} must have inputSchema`);
    }
  });

  it('AC-05: safe read-only tools/call succeeds through the real transport without state mutation', async () => {
    // 1. Call aidm.health
    const healthResponse = await client.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>('tools/call', {
      name: 'aidm.health',
      arguments: {},
    });

    assert.equal(healthResponse.jsonrpc, '2.0');
    assert.equal(healthResponse.error, undefined);
    assert.ok(!healthResponse.result?.isError, 'healthResponse.result.isError should be falsy');
    assert.ok(healthResponse.result?.content?.[0]?.text, 'Health response must contain content text');

    const healthData = JSON.parse(healthResponse.result!.content[0].text);
    assert.equal(healthData.status, 'healthy');
    assert.equal(healthData.server.name, 'aidm-mcp-server');

    // 2. Call aidm.project.status (read-only inspection of target project)
    const statusResponse = await client.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>('tools/call', {
      name: 'aidm.project.status',
      arguments: {},
    });

    assert.equal(statusResponse.jsonrpc, '2.0');
    assert.equal(statusResponse.error, undefined);
    assert.ok(!statusResponse.result?.isError, 'statusResponse.result.isError should be falsy');
    const statusData = JSON.parse(statusResponse.result!.content[0].text);
    assert.equal(statusData.projectRoot, targetDir);
    assert.equal(statusData.initialized, false);


    // 3. Call aidm.git.status (read-only git inspection)
    const gitResponse = await client.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>('tools/call', {
      name: 'aidm.git.status',
      arguments: {},
    });

    assert.equal(gitResponse.jsonrpc, '2.0');
    assert.equal(gitResponse.error, undefined);
  });

  it('AC-06: invalid request and unsupported tool call produce controlled MCP errors without server crash', async () => {
    // 1. Call unsupported tool name
    const invalidToolResponse = await client.request('tools/call', {
      name: 'aidm.unsupported.forbidden.tool',
      arguments: {},
    });

    assert.equal(invalidToolResponse.jsonrpc, '2.0');
    assert.ok(invalidToolResponse.error, 'Must return error envelope');
    assert.equal(invalidToolResponse.error!.code, -32601); // METHOD_NOT_FOUND / UNSUPPORTED
    assert.equal(
      (invalidToolResponse.error!.data as Record<string, unknown>)?.code,
      'ERR_MCP_UNSUPPORTED_OPERATION'
    );

    // 2. Verify server did NOT crash and is still healthy
    assert.ok(client.isRunning, 'Server process must still be running after error');

    // 3. Subsequent valid request succeeds
    const healthAfter = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.health',
      arguments: {},
    });
    assert.equal(healthAfter.error, undefined);
    assert.ok(healthAfter.result?.content?.[0]?.text);

    // 4. Send unknown JSON-RPC method
    const unknownMethodResponse = await client.request('nonexistent/method', {});
    assert.equal(unknownMethodResponse.error?.code, -32601);
  });

  it('AC-07: server terminates gracefully and can be cleanly restarted without zombie processes', async () => {
    // 1. Stop first server instance
    const stopResult = await client.stop();
    assert.equal(stopResult.exitCode, 0, 'Server should exit cleanly with code 0 on stdin close');
    assert.equal(client.isRunning, false, 'Client should report server not running');

    // 2. Clean restart verification
    const restartedClient = new ExternalMcpClient({
      projectRoot: targetDir,
    });
    await restartedClient.start();
    assert.ok(restartedClient.isRunning, 'Restarted server must be running');
    assert.notEqual(restartedClient.serverPid, serverPid, 'Restarted server must have new PID');

    // Verify it handles initialize cleanly
    const restartInit = await restartedClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'restarted-client', version: '1.0.0' },
    });
    assert.equal(restartInit.error, undefined);

    // Shut down restarted server
    const restartStop = await restartedClient.stop();
    assert.equal(restartStop.exitCode, 0);
  });

  it('AC-08, AC-09, AC-10: enforces target project separation, zero source modification, and no state mutation', async () => {
    // 1. Verify target project dummy file is completely intact
    const dummyContent = await fs.readFile(path.join(targetDir, 'dummy.txt'), 'utf-8');
    assert.equal(dummyContent, 'clean pilot project context\n', 'Target source must be completely untouched');

    // 2. Verify no .ai-manager was created in targetDir during read-only bootstrap
    let targetAiManagerExists = false;
    try {
      await fs.access(path.join(targetDir, '.ai-manager'));
      targetAiManagerExists = true;
    } catch {
      targetAiManagerExists = false;
    }
    assert.equal(targetAiManagerExists, false, 'Target project .ai-manager must NOT be created by read-only bootstrap');

    // 3. Verify server repository .ai-manager was NOT mutated
    // In server repository, .ai-manager must never receive target runtime state or records
    const serverRepoAiManager = path.resolve(import.meta.dirname, '../../../.ai-manager');
    let hasTargetState = false;
    try {
      const serverFiles = await fs.readdir(serverRepoAiManager);
      hasTargetState = serverFiles.includes('project-discovery') || serverFiles.includes('approval') || serverFiles.includes('state');
    } catch {
      hasTargetState = false;
    }
    assert.equal(hasTargetState, false, 'Server repository must not receive target runtime state');
  });
});
