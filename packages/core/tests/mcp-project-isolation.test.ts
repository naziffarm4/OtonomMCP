/**
 * MCP Project Isolation & Boundary Audit Tests (OM-09C-FIX)
 *
 * Verifies strict cross-project isolation in AIDM MCP Server:
 * 1. Mismatched caller workspaceRoot is strictly rejected fail-closed (PROJECT_ISOLATION_VIOLATION).
 * 2. Target project operations targeting the AIDM server repository itself are prohibited.
 * 3. Dedicated server mode cannot be hijacked or rebound to a different project.
 * 4. Legitimate session binding and switching in dynamic monorepo/host mode works securely.
 * 5. Path aliases and trailing slash canonicalization do not create false rejections or bypasses.
 * 6. Concurrency under mixed matching/mismatched requests preserves isolation deterministically.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  McpServer,
  DefaultMcpOrchestratorDelegate,
  InMemoryMcpTransport,
  type McpResponseEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
} from '../dist/index.js';
import { resolveCanonicalProjectIdentity } from '../dist/director/project-identity-resolver.js';

describe('OM-09C-FIX: MCP Project Isolation & Security Audit', () => {
  let tempRoot: string;
  let targetDirA: string;
  let targetDirB: string;
  let serverRepoRoot: string;

  async function callTool(
    server: McpServer,
    toolName: string,
    args: Record<string, unknown>,
    id: string | number = 1
  ): Promise<McpResponseEnvelope | null> {
    return server.handleMessage({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    });
  }

  before(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-mcp-iso-'));
    targetDirA = path.join(tempRoot, 'project-alpha');
    targetDirB = path.join(tempRoot, 'project-beta');

    await fs.promises.mkdir(targetDirA, { recursive: true });
    await fs.promises.mkdir(targetDirB, { recursive: true });

    // Initialize minimal package.json in each target to establish distinct canonical identities
    await fs.promises.writeFile(
      path.join(targetDirA, 'package.json'),
      JSON.stringify({ name: 'project-alpha', version: '1.0.0' }, null, 2),
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(targetDirB, 'package.json'),
      JSON.stringify({ name: 'project-beta', version: '1.0.0' }, null, 2),
      'utf8'
    );

    serverRepoRoot = path.resolve(process.cwd());
  });

  after(async () => {
    try {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Positive: Legitimate session-binding binds target project successfully in dynamic mode', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    let boundRoot = '';
    server.registerTool(
      {
        name: 'aidm.director.session.create',
        description: 'Mock session create',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async (args) => {
        boundRoot = args.workspaceRoot as string;
        delegate.setActiveContext({
          projectRoot: boundRoot,
          directorSessionId: 'sess-001',
          projectId: 'project-alpha',
          status: 'ACTIVE',
        });
        return { content: [{ type: 'text', text: JSON.stringify({ boundRoot }) }] };
      }
    );

    const res = await callTool(server, 'aidm.director.session.create', { workspaceRoot: targetDirA });
    assert.ok(res);
    assert.equal('error' in res && res.error, false);
    assert.equal(delegate.activeContext?.projectRoot, targetDirA);
  });

  it('Positive: Matching workspaceRoot and path aliases are permitted for operational tools', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    delegate.setActiveContext({
      projectRoot: targetDirA,
      directorSessionId: 'sess-001',
      projectId: 'project-alpha',
      status: 'ACTIVE',
    });

    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    server.registerTool(
      {
        name: 'aidm.project.status',
        description: 'Mock status tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async () => ({ content: [{ type: 'text', text: 'OK' }] })
    );

    // Exact matching path
    const res1 = await callTool(server, 'aidm.project.status', { workspaceRoot: targetDirA });
    assert.ok(res1);
    assert.equal('error' in res1 && res1.error, false);

    // Path alias with trailing slash
    const res2 = await callTool(server, 'aidm.project.status', { workspaceRoot: targetDirA + path.sep });
    assert.ok(res2);
    assert.equal('error' in res2 && res2.error, false);

    // Path alias with dotdot resolving to the same project root
    const aliasPath = path.join(targetDirA, 'subdir', '..');
    const res3 = await callTool(server, 'aidm.project.status', { workspaceRoot: aliasPath });
    assert.ok(res3);
    assert.equal('error' in res3 && res3.error, false);
  });

  it('Negative: Mismatched caller workspaceRoot is strictly rejected fail-closed with PROJECT_ISOLATION_VIOLATION', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    delegate.setActiveContext({
      projectRoot: targetDirA,
      directorSessionId: 'sess-001',
      projectId: 'project-alpha',
      status: 'ACTIVE',
    });

    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    server.registerTool(
      {
        name: 'aidm.project.status',
        description: 'Mock status tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async () => ({ content: [{ type: 'text', text: 'SHOULD_NOT_EXECUTE' }] })
    );

    // Caller attempts to access project-beta while project-alpha is the active context
    const res = await callTool(server, 'aidm.project.status', { workspaceRoot: targetDirB });
    assert.ok(res);
    assert.ok('error' in res && res.error);
    const err = (res as McpErrorResponseEnvelope).error;
    assert.ok(err.message.includes('Cross-project boundary violation'));
    assert.equal((err.data as any)?.details?.code, 'PROJECT_ISOLATION_VIOLATION');
  });

  it('Negative: Target project operations targeting the AIDM server repository itself are strictly prohibited', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    server.registerTool(
      {
        name: 'aidm.project.status',
        description: 'Mock status tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async () => ({ content: [{ type: 'text', text: 'SHOULD_NOT_EXECUTE' }] })
    );

    const res = await callTool(server, 'aidm.project.status', { workspaceRoot: serverRepoRoot });
    assert.ok(res);
    assert.ok('error' in res && res.error);
    const err = (res as McpErrorResponseEnvelope).error;
    assert.ok(err.message.includes('Target project operations on server repository'));
    assert.equal((err.data as any)?.details?.code, 'PROJECT_ISOLATION_VIOLATION');
  });

  it('Negative: Dedicated server mode prevents re-binding to a different target project', async () => {
    // Server is started in dedicated mode bound to project-alpha
    const delegate = new DefaultMcpOrchestratorDelegate();
    (delegate as any).projectRoot = targetDirA;

    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    server.registerTool(
      {
        name: 'aidm.director.session.create',
        description: 'Mock session tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async () => ({ content: [{ type: 'text', text: 'SHOULD_NOT_EXECUTE' }] })
    );

    // Caller attempts to rebind dedicated server to project-beta
    const res = await callTool(server, 'aidm.director.session.create', { workspaceRoot: targetDirB });
    assert.ok(res);
    assert.ok('error' in res && res.error);
    const err = (res as McpErrorResponseEnvelope).error;
    assert.ok(err.message.includes('Cross-project boundary violation: dedicated server configured for'));
    assert.equal((err.data as any)?.details?.code, 'PROJECT_ISOLATION_VIOLATION');
  });

  it('Positive: Dynamic monorepo mode allows legitimate session switching between projects', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    server.registerTool(
      {
        name: 'aidm.director.session.create',
        description: 'Mock session tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async (args) => {
        const root = args.workspaceRoot as string;
        const canonical = resolveCanonicalProjectIdentity(root);
        delegate.setActiveContext({
          projectRoot: root,
          directorSessionId: `sess-${canonical.projectId}`,
          projectId: canonical.projectId,
          status: 'ACTIVE',
        });
        return { content: [{ type: 'text', text: 'BOUND' }] };
      }
    );

    server.registerTool(
      {
        name: 'aidm.project.status',
        description: 'Mock status tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async () => ({ content: [{ type: 'text', text: 'STATUS_OK' }] })
    );

    // 1. Bind to Target A
    const res1 = await callTool(server, 'aidm.director.session.create', { workspaceRoot: targetDirA });
    assert.ok(res1);
    assert.equal('error' in res1 && res1.error, false);
    assert.equal(delegate.activeContext?.projectId, 'project-alpha');

    // 2. Query Target A succeeds
    const res2 = await callTool(server, 'aidm.project.status', { workspaceRoot: targetDirA });
    assert.ok(res2);
    assert.equal('error' in res2 && res2.error, false);

    // 3. Switch to Target B
    const res3 = await callTool(server, 'aidm.director.session.create', { workspaceRoot: targetDirB });
    assert.ok(res3);
    assert.equal('error' in res3 && res3.error, false);
    assert.equal(delegate.activeContext?.projectId, 'project-beta');

    // 4. Query Target B succeeds
    const res4 = await callTool(server, 'aidm.project.status', { workspaceRoot: targetDirB });
    assert.ok(res4);
    assert.equal('error' in res4 && res4.error, false);

    // 5. Query Target A is now rejected
    const res5 = await callTool(server, 'aidm.project.status', { workspaceRoot: targetDirA });
    assert.ok(res5);
    assert.ok('error' in res5 && res5.error);
    const err = (res5 as McpErrorResponseEnvelope).error;
    assert.ok(err.message.includes('Cross-project boundary violation'));
    assert.equal((err.data as any)?.details?.code, 'PROJECT_ISOLATION_VIOLATION');
  });

  it('Concurrency: Interleaved calls maintain strict project isolation without leakage', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    delegate.setActiveContext({
      projectRoot: targetDirA,
      directorSessionId: 'sess-001',
      projectId: 'project-alpha',
      status: 'ACTIVE',
    });

    const server = new McpServer({
      name: 'aidm-test-server',
      version: '1.0.0',
      transport: new InMemoryMcpTransport(),
      delegate,
    });
    await server.start();

    server.registerTool(
      {
        name: 'aidm.project.status',
        description: 'Mock status tool',
        inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
      },
      async () => ({ content: [{ type: 'text', text: 'OK' }] })
    );

    const calls = Array.from({ length: 20 }, (_, idx) => {
      const isTargetA = idx % 2 === 0;
      const root = isTargetA ? targetDirA : targetDirB;
      return callTool(server, 'aidm.project.status', { workspaceRoot: root }, idx + 10).then((res) => ({
        idx,
        isTargetA,
        hasError: Boolean(res && 'error' in res && res.error),
      }));
    });

    const results = await Promise.all(calls);
    for (const r of results) {
      if (r.isTargetA) {
        assert.equal(r.hasError, false, `Matching call #${r.idx} must succeed`);
      } else {
        assert.equal(r.hasError, true, `Mismatched call #${r.idx} must fail closed`);
      }
    }
  });
});
