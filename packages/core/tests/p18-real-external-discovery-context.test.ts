/**
 * P18 Real External Project: Discovery Persistence, Context Propagation, and Canonical Identity Tests
 *
 * Covers:
 * - MANDATORY TEST 1: Baseline discovery without prompt persists authoritative revision 1
 * - MANDATORY TEST 2: aidm.requirements.scope.define resolves discovery revision after prompt-less discovery
 * - MANDATORY TEST 3: Downstream tool with projectId and omitted workspaceRoot resolves active context root (not cwd)
 * - MANDATORY TEST 4: Project directory with spaces normalizes to valid canonical ID across all stores
 * - MANDATORY TEST 5: Path traversal and illegal characters in project IDs are strictly rejected
 * - MANDATORY TEST 6: Cross-project isolation and conflict rejection
 * - REAL EXTERNAL CLIENT SCENARIO: Full public lifecycle flow without repeating workspaceRoot
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultMcpOrchestratorDelegate } from '../dist/mcp/mcp-delegate.js';
import { InMemoryMcpTransport } from '../dist/mcp/mcp-transport.js';
import { McpServer } from '../dist/mcp/mcp-server.js';
import type { McpRequestEnvelope, McpSuccessResponseEnvelope, McpErrorResponseEnvelope } from '../dist/mcp/mcp-types.js';
import { AIDM_PROJECT_DISCOVER_TOOL_NAME } from '../dist/mcp/tools/project-discover-tool.js';
import { AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME, AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME } from '../dist/mcp/tools/requirements-scope-tool.js';
import { AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME } from '../dist/mcp/tools/specification-completeness-tool.js';
import { AIDM_PROJECT_STATUS_TOOL_NAME } from '../dist/mcp/tools/project-status-tool.js';
import {
  resolveCanonicalProjectIdentity,
  normalizeCanonicalProjectId,
  validateCanonicalProjectId,
  CANONICAL_PROJECT_ID_REGEX,
} from '../dist/director/project-identity-resolver.js';
import { AdaptiveDiscoveryStore } from '../dist/discovery/adaptive-discovery-store.js';
import { RequirementsScopeStore } from '../dist/discovery/requirements-scope-store.js';
import { CompletenessGateStore } from '../dist/discovery/completeness-gate-store.js';
import { ExternalMcpClient } from './helpers/external-mcp-client.ts';

describe('P18 Real External Project: Discovery Persistence, Context Propagation & Identity', () => {
  let tempBaseDir: string;
  let targetProjectDir: string;
  let spaceProjectDir: string;
  let targetDirB: string;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p18-real-'));
    targetProjectDir = path.join(tempBaseDir, 'test-external-project');
    spaceProjectDir = path.join(tempBaseDir, 'Antigravity IDE Test Proj');
    targetDirB = path.join(tempBaseDir, 'isolated-target-b');

    await fs.mkdir(targetProjectDir, { recursive: true });
    await fs.mkdir(spaceProjectDir, { recursive: true });
    await fs.mkdir(targetDirB, { recursive: true });

    // Seed target project files
    await fs.writeFile(
      path.join(targetProjectDir, 'package.json'),
      JSON.stringify({
        name: 'test-external-project',
        version: '1.0.0',
        description: 'External test project for AIDM audit',
      }, null, 2)
    );
    await fs.writeFile(
      path.join(targetProjectDir, 'README.md'),
      '# Test External Project\nBaseline for external MCP audit.\n'
    );

    // Seed space project files
    await fs.writeFile(
      path.join(spaceProjectDir, 'README.md'),
      '# Antigravity IDE Test Project\nProject path contains spaces.\n'
    );
  });

  after(async () => {
    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ============================================================================
  // MANDATORY TEST 1: Baseline discovery without prompt persists authoritative rev 1
  // ============================================================================
  it('MANDATORY TEST 1: Discovery without prompt creates and persists authoritative revision 1', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      requirementsScopeTools: true,
    });
    await server.start();

    // Call aidm.project.discover without prompt
    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetProjectDir,
        },
      },
    };

    const res = (await server.handleMessage(req)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(res.result?.content?.[0]?.text, 'Should return text content');
    const parsedRevision = JSON.parse(res.result.content[0].text);
    assert.equal(parsedRevision.projectId, 'test-external-project');
    assert.equal(parsedRevision.discoveryRevision, 1);

    // Verify authoritative files exist on disk
    const latestPath = path.join(
      targetProjectDir,
      '.ai-manager',
      'project-discovery',
      'records',
      'test-external-project',
      'latest.json'
    );
    const rev1Path = path.join(
      targetProjectDir,
      '.ai-manager',
      'project-discovery',
      'records',
      'test-external-project',
      'rev-1.json'
    );

    assert.ok(fsSync.existsSync(latestPath), 'latest.json must exist');
    assert.ok(fsSync.existsSync(rev1Path), 'rev-1.json must exist');

    const latestContent = JSON.parse(await fs.readFile(latestPath, 'utf8'));
    assert.equal(latestContent.projectId, 'test-external-project');
    assert.equal(latestContent.discoveryRevision, 1);
    assert.ok(latestContent.fingerprint, 'Must have deterministic fingerprint');

    // Test Idempotency: repeating baseline discovery without prompt must return rev 1 without error
    const req2: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetProjectDir,
        },
      },
    };

    const res2 = (await server.handleMessage(req2)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    const parsedRev2 = JSON.parse(res2.result.content[0].text);
    assert.equal(parsedRev2.discoveryRevision, 1, 'Idempotent call must return revision 1');
    assert.equal(parsedRev2.fingerprint, parsedRevision.fingerprint);

    await server.stop();
  });

  // ============================================================================
  // MANDATORY TEST 2: aidm.requirements.scope.define resolves discovery revision
  // ============================================================================
  it('MANDATORY TEST 2: Immediately after prompt-less discovery, requirements.scope.define resolves discovery revision', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      requirementsScopeTools: true,
    });
    await server.start();

    // Call aidm.requirements.scope.define
    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetProjectDir,
        },
      },
    };

    const res = (await server.handleMessage(req)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(res.result?.content?.[0]?.text, 'Requirements scope define must succeed');
    const result = JSON.parse(res.result.content[0].text);
    assert.equal(result.projectId, 'test-external-project');
    assert.equal(result.sourceDiscoveryRevision, 1, 'Must bind to discovery revision 1');
    assert.ok(result.requirementsRevision >= 1);

    await server.stop();
  });

  // ============================================================================
  // MANDATORY TEST 3: Downstream tool resolves active context root when workspaceRoot omitted
  // ============================================================================
  it('MANDATORY TEST 3: Downstream tool with projectId and omitted workspaceRoot resolves active context root', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      requirementsScopeTools: true,
    });
    await server.start();

    // 1. Discover to establish active project context
    const discReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetProjectDir,
        },
      },
    };
    await server.handleMessage(discReq);

    // Verify delegate active context was bound
    assert.ok(delegate.activeContext, 'Active context must be set');
    assert.equal(delegate.activeContext.projectId, 'test-external-project');
    assert.equal(delegate.activeContext.projectRoot, targetProjectDir);

    // 2. Call requirements.scope.get with projectId ONLY (omitting workspaceRoot)
    const getReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          // workspaceRoot intentionally omitted!
        },
      },
    };

    const getRes = (await server.handleMessage(getReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(getRes.result?.content?.[0]?.text, 'Must succeed without workspaceRoot');
    const scopeData = JSON.parse(getRes.result.content[0].text);
    assert.equal(scopeData.projectId, 'test-external-project');

    // Verify it resolved targetProjectDir and NOT process.cwd()
    assert.notEqual(path.resolve(delegate.activeContext.projectRoot), path.resolve(process.cwd()));
    assert.equal(path.resolve(delegate.activeContext.projectRoot), path.resolve(targetProjectDir));

    await server.stop();
  });

  // ============================================================================
  // MANDATORY TEST 4: Project directory with spaces produces valid canonical projectId
  // ============================================================================
  it('MANDATORY TEST 4: Directory with spaces normalizes to valid canonical projectId across all stores', async () => {
    // Test canonical normalization
    const canonical = resolveCanonicalProjectIdentity(spaceProjectDir);
    assert.equal(canonical.projectName, 'Antigravity IDE Test Proj');
    assert.equal(canonical.projectId, 'Antigravity-IDE-Test-Proj');
    assert.ok(CANONICAL_PROJECT_ID_REGEX.test(canonical.projectId));

    // Verify stores accept this canonical ID without throwing
    const discStore = new AdaptiveDiscoveryStore({ baseDir: spaceProjectDir });
    const sanitizedDisc = discStore.sanitizeProjectId(canonical.projectId);
    assert.equal(sanitizedDisc, 'Antigravity-IDE-Test-Proj');

    const reqStore = new RequirementsScopeStore({ baseDir: spaceProjectDir });
    const sanitizedReq = reqStore.sanitizeProjectId(canonical.projectId);
    assert.equal(sanitizedReq, 'Antigravity-IDE-Test-Proj');

    const gateStore = new CompletenessGateStore({ baseDir: spaceProjectDir });
    const sanitizedGate = gateStore.sanitizeProjectId(canonical.projectId);
    assert.equal(sanitizedGate, 'Antigravity-IDE-Test-Proj');

    // Run discovery via MCP server on the space-containing directory
    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      requirementsScopeTools: true,
    });
    await server.start();

    const discReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          workspaceRoot: spaceProjectDir,
        },
      },
    };

    const res = (await server.handleMessage(discReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(res.result?.content?.[0]?.text);
    // Should have established activeContext with normalized projectId
    assert.ok(delegate.activeContext);
    assert.equal(delegate.activeContext.projectId, 'Antigravity-IDE-Test-Proj');
    assert.ok(CANONICAL_PROJECT_ID_REGEX.test(delegate.activeContext.projectId));

    await server.stop();
  });

  // ============================================================================
  // MANDATORY TEST 5: Path traversal and illegal project IDs remain rejected
  // ============================================================================
  it('MANDATORY TEST 5: Path traversal and illegal project IDs are strictly rejected', async () => {
    assert.throws(
      () => validateCanonicalProjectId('../malicious-traversal'),
      /illegal characters or path traversal/
    );
    assert.throws(
      () => validateCanonicalProjectId('/rooted/path'),
      /illegal characters or path traversal/
    );
    assert.throws(
      () => validateCanonicalProjectId('invalid space in id'),
      /illegal characters or path traversal/
    );
    assert.throws(
      () => validateCanonicalProjectId(''),
      /cannot be empty/
    );

    const store = new AdaptiveDiscoveryStore({ baseDir: targetProjectDir });
    assert.throws(() => store.sanitizeProjectId('../escape'), /illegal characters or path traversal/);
    assert.throws(() => store.sanitizeProjectId('has spaces'), /illegal characters or path traversal/);
  });

  // ============================================================================
  // MANDATORY TEST 6: Cross-project isolation and conflict rejection
  // ============================================================================
  it('MANDATORY TEST 6: Cross-project mismatch and explicit conflict fail closed', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      requirementsScopeTools: true,
    });
    await server.start();

    // Bind Target-A
    await server.handleMessage({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetProjectDir,
        },
      },
    });

    assert.equal(delegate.activeContext?.projectId, 'test-external-project');

    // 1. Conflicting explicit root with active context fails closed
    const conflictRootReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetDirB, // conflicts with activeContext targetProjectDir!
        },
      },
    };

    const conflictRootRes = (await server.handleMessage(conflictRootReq)) as McpErrorResponseEnvelope;
    assert.ok(conflictRootRes.error, 'Must fail closed on conflicting workspaceRoot');
    assert.ok(conflictRootRes.error.message.includes('conflicts with active context projectRoot'));

    // 2. Mismatched projectId without workspaceRoot fails closed (does not fallback to cwd or switch)
    const mismatchReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
        arguments: {
          projectId: 'completely-different-project',
          // no workspaceRoot
        },
      },
    };

    const mismatchRes = (await server.handleMessage(mismatchReq)) as McpErrorResponseEnvelope;
    assert.ok(mismatchRes.error, 'Must fail closed on mismatched projectId');
    assert.ok(mismatchRes.error.message.includes('Cross-project mismatch rejected'));

    // 3. Confirm target state is strictly in targetProjectDir and not AIDM server repository
    assert.ok(
      fsSync.existsSync(path.join(targetProjectDir, '.ai-manager', 'project-discovery')),
      'Target state must exist in target dir'
    );
    assert.ok(
      !fsSync.existsSync(path.join(targetDirB, '.ai-manager')),
      'Target B must not have received state'
    );

    await server.stop();
  });

  // ============================================================================
  // REAL EXTERNAL CLIENT SCENARIO: Public MCP flow without repeating workspaceRoot
  // ============================================================================
  it('REAL EXTERNAL CLIENT SCENARIO: executes canonical MCP lifecycle sequence without Director session', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorTools: true,
      discoveryTools: true,
      requirementsScopeTools: true,
      completenessTools: true,
    });
    await server.start();

    // 1. aidm.health
    const healthReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: {
        name: 'aidm.health',
        arguments: {},
      },
    };
    const healthRes = (await server.handleMessage(healthReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(healthRes.result?.content?.[0]?.text);
    const healthData = JSON.parse(healthRes.result.content[0].text);
    assert.equal(healthData.status, 'healthy');

    // 2. aidm.project.status (before discovery, with workspaceRoot)
    const statusReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_STATUS_TOOL_NAME,
        arguments: {
          workspaceRoot: targetProjectDir,
        },
      },
    };
    const statusRes = (await server.handleMessage(statusReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(statusRes.result?.content?.[0]?.text);

    // 3. aidm.project.discover (provides projectId & workspaceRoot)
    const discoverReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          workspaceRoot: targetProjectDir,
        },
      },
    };
    const discoverRes = (await server.handleMessage(discoverReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(discoverRes.result?.content?.[0]?.text);
    const discRev = JSON.parse(discoverRes.result.content[0].text);
    assert.equal(discRev.projectId, 'test-external-project');
    assert.equal(discRev.discoveryRevision, 1);

    // Context is now bound to test-external-project at targetProjectDir!
    // SUBSEQUENT CALLS OMIT workspaceRoot:

    // 4. aidm.requirements.scope.get({ projectId })
    const scopeGetReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          // workspaceRoot omitted!
        },
      },
    };
    const scopeGetRes = (await server.handleMessage(scopeGetReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(scopeGetRes.result?.content?.[0]?.text);

    // 5. aidm.requirements.scope.define({ projectId })
    const scopeDefineReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 104,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          // workspaceRoot omitted!
        },
      },
    };
    const scopeDefineRes = (await server.handleMessage(scopeDefineReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(scopeDefineRes.result?.content?.[0]?.text);
    const scopeDefinedData = JSON.parse(scopeDefineRes.result.content[0].text);
    assert.equal(scopeDefinedData.projectId, 'test-external-project');
    assert.equal(scopeDefinedData.sourceDiscoveryRevision, 1);

    // 6. aidm.specification.completeness.evaluate({ projectId })
    const completeReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 105,
      method: 'tools/call',
      params: {
        name: AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME,
        arguments: {
          projectId: 'test-external-project',
          // workspaceRoot omitted!
        },
      },
    };
    const completeRes = (await server.handleMessage(completeReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(completeRes.result?.content?.[0]?.text);
    const completeData = JSON.parse(completeRes.result.content[0].text);
    assert.equal(completeData.projectId, 'test-external-project');
    assert.equal(completeData.discoveryRevision, 1);
    assert.ok(completeData.status);
    assert.ok(completeData.fingerprint);

    await server.stop();
  });

  // ============================================================================
  // MANDATORY REGRESSION TEST 8: Canonical external discovery with workspaceRoot only (no projectId)
  // followed by downstream requirements.scope.define with workspaceRoot only (no projectId)
  // ============================================================================
  it('MANDATORY REGRESSION TEST 8: Canonical external discovery with workspaceRoot only unblocks downstream define', async () => {
    const canonicalAppDir = path.join(tempBaseDir, 'canonical-external-app');
    await fs.mkdir(canonicalAppDir, { recursive: true });
    await fs.writeFile(
      path.join(canonicalAppDir, 'package.json'),
      JSON.stringify({ name: 'canonical-external-app', version: '0.1.0' }, null, 2)
    );

    const delegate = new DefaultMcpOrchestratorDelegate();
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      requirementsScopeTools: true,
    });
    await server.start();

    // 1. aidm.project.discover with ONLY workspaceRoot (no projectId)
    const discoverReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          workspaceRoot: canonicalAppDir,
        },
      },
    };

    const discoverRes = (await server.handleMessage(discoverReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(discoverRes.result?.content?.[0]?.text, 'Discover should return text');
    const discRev = JSON.parse(discoverRes.result.content[0].text);

    // Verify canonical project ID resolved from root, revision 1, fingerprint, sections, completeness
    assert.equal(discRev.projectId, 'canonical-external-app');
    assert.equal(discRev.discoveryRevision, 1);
    assert.ok(typeof discRev.fingerprint === 'string' && discRev.fingerprint.length === 64);
    assert.ok(discRev.sections, 'Response must expose sections');
    assert.ok(discRev.completeness, 'Response must expose completeness');

    // Verify target-project .ai-manager isolation and latest.json persistence
    const targetLatestPath = path.join(
      canonicalAppDir,
      '.ai-manager',
      'project-discovery',
      'records',
      'canonical-external-app',
      'latest.json'
    );
    const targetRev1Path = path.join(
      canonicalAppDir,
      '.ai-manager',
      'project-discovery',
      'records',
      'canonical-external-app',
      'rev-1.json'
    );
    assert.ok(fsSync.existsSync(targetLatestPath), 'latest.json must be persisted on disk');
    assert.ok(fsSync.existsSync(targetRev1Path), 'rev-1.json must be persisted on disk');

    const latestJson = JSON.parse(await fs.readFile(targetLatestPath, 'utf-8'));
    assert.equal(latestJson.discoveryRevision, 1);
    assert.equal(latestJson.fingerprint, discRev.fingerprint);

    // Verify active project context was bound
    assert.equal(delegate.activeContext?.projectId, 'canonical-external-app');
    assert.equal(delegate.activeContext?.projectRoot, canonicalAppDir);

    // Verify NO dependency on Director session
    assert.equal(delegate.activeDirectorSession, undefined);

    // 2. Downstream aidm.requirements.scope.define with ONLY workspaceRoot (no projectId)
    const reqScopeReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 202,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
        arguments: {
          workspaceRoot: canonicalAppDir,
        },
      },
    };

    const reqScopeRes = (await server.handleMessage(reqScopeReq)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(reqScopeRes.result?.content?.[0]?.text, 'Requirements define should succeed');
    const reqScopeData = JSON.parse(reqScopeRes.result.content[0].text);
    assert.equal(reqScopeData.projectId, 'canonical-external-app');
    assert.equal(reqScopeData.requirementsRevision, 1);
    assert.equal(reqScopeData.sourceDiscoveryRevision, 1);
    assert.ok(reqScopeData.fingerprint);

    // Verify requirements state was persisted in target .ai-manager
    const reqLatestPath = path.join(
      canonicalAppDir,
      '.ai-manager',
      'project-requirements',
      'records',
      'canonical-external-app',
      'latest.json'
    );
    assert.ok(fsSync.existsSync(reqLatestPath), 'Requirements latest.json must be persisted');

    // 3. Explicit workspaceRoot mismatch fails closed
    const conflictReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 203,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
        arguments: {
          workspaceRoot: targetDirB, // Conflicting root
        },
      },
    };

    const conflictRes = (await server.handleMessage(conflictReq)) as McpErrorResponseEnvelope;
    assert.ok(conflictRes.error, 'Conflicting workspaceRoot must fail closed');
    assert.ok(conflictRes.error.message.includes('conflicts with active context projectRoot'));

    await server.stop();
  });

  // ============================================================================
  // MANDATORY REGRESSION TEST 9: Real stdio transport lifecycle, persistent daemon & restart verification
  // ============================================================================
  it('MANDATORY REGRESSION TEST 9: Real stdio process lifecycle differentiates persistent daemon vs restart', async () => {
    const stdioAppDir = path.join(tempBaseDir, 'stdio-lifecycle-app');
    await fs.mkdir(stdioAppDir, { recursive: true });
    await fs.writeFile(
      path.join(stdioAppDir, 'package.json'),
      JSON.stringify({ name: 'stdio-lifecycle-app', version: '1.0.0' }, null, 2)
    );

    // 1. Start real MCP server child process over stdio
    const client = new ExternalMcpClient({
      projectRoot: stdioAppDir,
    });
    await client.start();

    assert.ok(client.isRunning, 'Stdio server process must be running');
    const initialPid = client.serverPid;
    assert.ok(typeof initialPid === 'number' && initialPid > 0);

    // Initialize MCP handshake over stdio
    const initRes = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-antigravity-client', version: '1.0.0' },
    });
    assert.equal(initRes.error, undefined);
    await client.notify('notifications/initialized');

    // 2. Discover via stdio with ONLY workspaceRoot (no projectId)
    const discRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
      arguments: {
        workspaceRoot: stdioAppDir,
      },
    });

    assert.equal(discRes.error, undefined);
    assert.ok(discRes.result?.content?.[0]?.text);
    const discData = JSON.parse(discRes.result.content[0].text);
    assert.equal(discData.projectId, 'stdio-lifecycle-app');
    assert.equal(discData.discoveryRevision, 1);
    assert.ok(discData.fingerprint);

    // Verify on-disk persistence
    const discLatest = path.join(
      stdioAppDir,
      '.ai-manager',
      'project-discovery',
      'records',
      'stdio-lifecycle-app',
      'latest.json'
    );
    assert.ok(fsSync.existsSync(discLatest), 'Discovery latest.json must be persisted by stdio server');

    // 3. Persistent Daemon Check: subsequent downstream call uses the SAME running server process
    assert.equal(client.serverPid, initialPid, 'Server PID must remain identical across requests (persistent daemon)');

    const reqDefineRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
      arguments: {
        workspaceRoot: stdioAppDir,
      },
    });

    assert.equal(reqDefineRes.error, undefined);
    assert.ok(reqDefineRes.result?.content?.[0]?.text);
    const reqData = JSON.parse(reqDefineRes.result.content[0].text);
    assert.equal(reqData.projectId, 'stdio-lifecycle-app');
    assert.equal(reqData.requirementsRevision, 1);
    assert.equal(reqData.sourceDiscoveryRevision, 1);

    // 4. Stale daemon distinction: stop old server, verify process termination
    const stopResult = await client.stop();
    assert.equal(stopResult.exitCode, 0, 'Server process must terminate cleanly');
    assert.equal(client.isRunning, false);

    // 5. Fresh daemon cold-start: new process loads persisted disk state without re-running discovery
    const freshClient = new ExternalMcpClient({
      projectRoot: stdioAppDir,
    });
    await freshClient.start();
    assert.ok(freshClient.isRunning);
    assert.notEqual(freshClient.serverPid, initialPid, 'Fresh server must have a distinct PID');

    await freshClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'fresh-client', version: '1.0.0' },
    });
    await freshClient.notify('notifications/initialized');

    // Query requirements get tool without re-discovering
    const getRes = await freshClient.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
      arguments: {
        workspaceRoot: stdioAppDir,
      },
    });

    assert.equal(getRes.error, undefined);
    assert.ok(getRes.result?.content?.[0]?.text);
    const getData = JSON.parse(getRes.result.content[0].text);
    assert.equal(getData.projectId, 'stdio-lifecycle-app');
    assert.equal(getData.requirementsRevision, 1);

    await freshClient.stop();
  });
});
