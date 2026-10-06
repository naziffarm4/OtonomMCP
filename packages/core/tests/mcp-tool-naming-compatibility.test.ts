/**
 * Regression Test Suite: MCP Tool Naming Compatibility & Antigravity Invariants
 *
 * Verifies that:
 * 1. Internal tool identifiers with unsupported characters (dots) are deterministically
 *    mapped to Antigravity-compatible MCP tool names matching ^[a-zA-Z0-9_-]{1,64}$.
 * 2. Key canonical tools (aidm.health, aidm.project.status, aidm.project.requirements,
 *    aidm.project.decisions) are properly mapped, registered, and callable through both
 *    external and internal names.
 * 3. 64-character maximum name length is strictly enforced with deterministic hash truncation.
 * 4. Naming collisions between distinct internal tools are safely disambiguated without tool dropping.
 * 5. All 71 tools in the authoritative AIDM MCP server register cleanly without naming validation errors.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  normalizeMcpToolName,
  isValidMcpToolName,
  createCollisionSafeToolName,
  MCP_TOOL_NAME_REGEX,
  MAX_MCP_TOOL_NAME_LENGTH,
  McpServer,
  createAuthoritativeMcpServer,
  AIDM_HEALTH_TOOL_NAME,
  AIDM_PROJECT_STATUS_TOOL_NAME,
  AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  AIDM_PROJECT_DECISIONS_TOOL_NAME,
  type McpMessage,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
  type McpToolDefinition,
  type McpToolResult,
  type McpTransport,
} from '../dist/index.js';

class MockTransport implements McpTransport {
  isConnected = true;
  private messageHandler?: (msg: McpMessage) => Promise<void> | void;

  async start(): Promise<void> {
    this.isConnected = true;
  }
  async close(): Promise<void> {
    this.isConnected = false;
  }
  async send(_msg: McpMessage): Promise<void> {}
  onMessage(handler: (msg: McpMessage) => Promise<void> | void): void {
    this.messageHandler = handler;
  }
  onError(_handler: (err: Error) => void): void {}
  onClose(_handler: () => void): void {}

  async simulateMessage(msg: McpMessage): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(msg);
    }
  }
}

describe('MCP Tool Naming Compatibility & Antigravity Invariants', () => {
  // ==========================================================================
  // 1. CANONICAL TOOLS COVERAGE
  // ==========================================================================
  describe('Canonical Tool Mappings', () => {
    it('correctly maps aidm.health to aidm_health and invokes handler', async () => {
      assert.equal(normalizeMcpToolName('aidm.health'), 'aidm_health');
      assert.ok(isValidMcpToolName('aidm_health'));

      const transport = new MockTransport();
      const server = new McpServer({ transport });
      await server.start();

      // Verify exposed tool name in registered tools
      const tools = server.getRegisteredTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'aidm_health');
      assert.equal(tools[0].internalName, 'aidm.health');

      // Verify dual lookup
      const toolByExposed = server.getTool('aidm_health');
      const toolByInternal = server.getTool('aidm.health');
      assert.ok(toolByExposed, 'Tool must be found by exposed name aidm_health');
      assert.ok(toolByInternal, 'Tool must be found by internal name aidm.health');
      assert.equal(toolByExposed, toolByInternal);

      // Verify invocation via exposed name
      const callExposedReq: McpRequestEnvelope = {
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'tools/call',
        params: {
          name: 'aidm_health',
          arguments: {},
        },
      };
      const resExposed = (await server.handleMessage(callExposedReq)) as McpSuccessResponseEnvelope<McpToolResult>;
      assert.equal(resExposed.id, 'call-1');
      assert.ok(resExposed.result);
      assert.ok(resExposed.result.content[0].text?.includes('aidm-mcp-server'));

      // Verify invocation via internal name for backwards compatibility
      const callInternalReq: McpRequestEnvelope = {
        jsonrpc: '2.0',
        id: 'call-2',
        method: 'tools/call',
        params: {
          name: 'aidm.health',
          arguments: {},
        },
      };
      const resInternal = (await server.handleMessage(callInternalReq)) as McpSuccessResponseEnvelope<McpToolResult>;
      assert.equal(resInternal.id, 'call-2');
      assert.ok(resInternal.result);
      assert.ok(resInternal.result.content[0].text?.includes('aidm-mcp-server'));
    });

    it('correctly maps aidm.project.status to aidm_project_status', () => {
      assert.equal(normalizeMcpToolName(AIDM_PROJECT_STATUS_TOOL_NAME), 'aidm_project_status');
      assert.ok(isValidMcpToolName('aidm_project_status'));

      const transport = new MockTransport();
      const server = new McpServer({
        transport,
        directorTools: true,
      });

      const tool = server.getTool('aidm_project_status');
      assert.ok(tool, 'Must resolve by aidm_project_status');
      assert.equal(tool.definition.name, 'aidm_project_status');
      assert.equal(tool.definition.internalName, AIDM_PROJECT_STATUS_TOOL_NAME);

      const internalLookup = server.getTool(AIDM_PROJECT_STATUS_TOOL_NAME);
      assert.equal(internalLookup, tool);
    });

    it('correctly maps aidm.project.requirements to aidm_project_requirements', () => {
      assert.equal(normalizeMcpToolName(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME), 'aidm_project_requirements');
      assert.ok(isValidMcpToolName('aidm_project_requirements'));

      const transport = new MockTransport();
      const server = new McpServer({
        transport,
        directorTools: true,
      });

      const tool = server.getTool('aidm_project_requirements');
      assert.ok(tool, 'Must resolve by aidm_project_requirements');
      assert.equal(tool.definition.name, 'aidm_project_requirements');
      assert.equal(tool.definition.internalName, AIDM_PROJECT_REQUIREMENTS_TOOL_NAME);

      const internalLookup = server.getTool(AIDM_PROJECT_REQUIREMENTS_TOOL_NAME);
      assert.equal(internalLookup, tool);
    });

    it('correctly maps aidm.project.decisions to aidm_project_decisions', () => {
      assert.equal(normalizeMcpToolName(AIDM_PROJECT_DECISIONS_TOOL_NAME), 'aidm_project_decisions');
      assert.ok(isValidMcpToolName('aidm_project_decisions'));

      const transport = new MockTransport();
      const server = new McpServer({
        transport,
        directorTools: true,
      });

      const tool = server.getTool('aidm_project_decisions');
      assert.ok(tool, 'Must resolve by aidm_project_decisions');
      assert.equal(tool.definition.name, 'aidm_project_decisions');
      assert.equal(tool.definition.internalName, AIDM_PROJECT_DECISIONS_TOOL_NAME);

      const internalLookup = server.getTool(AIDM_PROJECT_DECISIONS_TOOL_NAME);
      assert.equal(internalLookup, tool);
    });
  });

  // ==========================================================================
  // 2. MAXIMUM NAME LENGTH ENFORCEMENT
  // ==========================================================================
  describe('Maximum Name Length Enforcement', () => {
    it('preserves names with length <= 64 unchanged when characters are valid', () => {
      const name64 = 'a'.repeat(64);
      const normalized = normalizeMcpToolName(name64);
      assert.equal(normalized.length, 64);
      assert.equal(normalized, name64);
      assert.ok(isValidMcpToolName(normalized));
    });

    it('deterministically truncates names exceeding 64 characters to exactly 64 characters', () => {
      const name70 = 'tool_prefix_'.repeat(6); // 72 chars
      const normalized = normalizeMcpToolName(name70);
      assert.equal(normalized.length, MAX_MCP_TOOL_NAME_LENGTH);
      assert.ok(isValidMcpToolName(normalized));
      assert.match(normalized, MCP_TOOL_NAME_REGEX);

      // Verify deterministic stability (same input -> same output)
      const normalizedAgain = normalizeMcpToolName(name70);
      assert.equal(normalized, normalizedAgain);
    });

    it('produces distinct hash suffixes for distinct long names with the same prefix', () => {
      const longName1 = 'enterprise_long_domain_service_action_'.repeat(2) + '_alpha';
      const longName2 = 'enterprise_long_domain_service_action_'.repeat(2) + '_beta';

      const norm1 = normalizeMcpToolName(longName1);
      const norm2 = normalizeMcpToolName(longName2);

      assert.equal(norm1.length, 64);
      assert.equal(norm2.length, 64);
      assert.notEqual(norm1, norm2, 'Different inputs must produce different hash truncated names');
    });

    it('enforces 64-character limit in McpServer.registerTool', () => {
      const transport = new MockTransport();
      const server = new McpServer({ transport });

      const longDefinition: McpToolDefinition = {
        name: 'very.long.custom.namespace.subsystem.service.action.perform.operation.run',
        description: 'Test long tool definition',
        inputSchema: { type: 'object' },
      };

      server.registerTool(longDefinition, async () => ({ content: [] }));
      const registered = server.getRegisteredTools();
      const exposed = registered.find((t) => t.internalName === longDefinition.name);

      assert.ok(exposed);
      assert.ok(exposed.name.length <= MAX_MCP_TOOL_NAME_LENGTH);
      assert.ok(isValidMcpToolName(exposed.name));
      assert.ok(server.getTool(exposed.name));
      assert.ok(server.getTool(longDefinition.name));
    });
  });

  // ==========================================================================
  // 3. COLLISION HANDLING
  // ==========================================================================
  describe('Collision Handling', () => {
    it('safely disambiguates multiple internal names mapping to the same base name', () => {
      const existing = new Set<string>();

      // First tool: 'system.cache.clear' -> 'system_cache_clear'
      const name1 = createCollisionSafeToolName('system.cache.clear', existing);
      assert.equal(name1, 'system_cache_clear');
      existing.add(name1);

      // Second tool: 'system_cache.clear' -> would also map to 'system_cache_clear'
      const name2 = createCollisionSafeToolName('system_cache.clear', existing);
      assert.notEqual(name2, name1);
      assert.ok(isValidMcpToolName(name2));
      assert.ok(name2.length <= MAX_MCP_TOOL_NAME_LENGTH);
      existing.add(name2);

      // Third tool: 'system_cache_clear' -> also collides
      const name3 = createCollisionSafeToolName('system_cache_clear', existing);
      assert.notEqual(name3, name1);
      assert.notEqual(name3, name2);
      assert.ok(isValidMcpToolName(name3));
      assert.ok(name3.length <= MAX_MCP_TOOL_NAME_LENGTH);
    });

    it('McpServer registers colliding tools without throwing and dispatches correctly', async () => {
      const transport = new MockTransport();
      const server = new McpServer({ transport });
      await server.start();

      let handler1Called = false;
      let handler2Called = false;

      const def1: McpToolDefinition = {
        name: 'custom.audit.log',
        description: 'First tool',
        inputSchema: { type: 'object' },
      };
      const def2: McpToolDefinition = {
        name: 'custom_audit.log',
        description: 'Second colliding tool',
        inputSchema: { type: 'object' },
      };

      server.registerTool(def1, async () => {
        handler1Called = true;
        return { content: [{ type: 'text', text: 'handler 1' }] };
      });

      server.registerTool(def2, async () => {
        handler2Called = true;
        return { content: [{ type: 'text', text: 'handler 2' }] };
      });

      const registered = server.getRegisteredTools();
      assert.equal(registered.length, 3); // 1 health + 2 custom

      const reg1 = server.getTool('custom.audit.log')!;
      const reg2 = server.getTool('custom_audit.log')!;

      assert.ok(reg1);
      assert.ok(reg2);
      assert.notEqual(reg1.definition.name, reg2.definition.name);
      assert.ok(isValidMcpToolName(reg1.definition.name));
      assert.ok(isValidMcpToolName(reg2.definition.name));

      // Call tool 1
      await server.handleMessage({
        jsonrpc: '2.0',
        id: 'c1',
        method: 'tools/call',
        params: { name: reg1.definition.name, arguments: {} },
      });
      assert.ok(handler1Called);
      assert.ok(!handler2Called);

      // Call tool 2
      await server.handleMessage({
        jsonrpc: '2.0',
        id: 'c2',
        method: 'tools/call',
        params: { name: reg2.definition.name, arguments: {} },
      });
      assert.ok(handler2Called);
    });
  });

  // ==========================================================================
  // 4. COMPLETE TOOL REGISTRATION (ALL 71 TOOLS)
  // ==========================================================================
  describe('Complete Tool Registration (All 71 Tools)', () => {
    it('registers all 71 tools without naming validation errors and ensures uniqueness', () => {
      const transport = new MockTransport();
      const server = createAuthoritativeMcpServer({ transport });

      const tools = server.getRegisteredTools();
      assert.ok(tools.length >= 71, `Expected at least 71 registered tools, got ${tools.length}`);
      assert.equal(tools.length, 77, `Expected exactly 77 registered tools, got ${tools.length}`);

      const exposedNames = new Set<string>();
      const antigravityPrefix = 'mcp_OtonomMCP_';

      for (const tool of tools) {
        // 1. Tool name must be string
        assert.ok(typeof tool.name === 'string', 'Tool name must be string');

        // 2. Validate Antigravity regex: ^[a-zA-Z0-9_-]{1,64}$
        assert.ok(
          MCP_TOOL_NAME_REGEX.test(tool.name),
          `Tool name "${tool.name}" violates regex ${MCP_TOOL_NAME_REGEX}`
        );

        // 3. Length must be <= 64
        assert.ok(
          tool.name.length <= MAX_MCP_TOOL_NAME_LENGTH,
          `Tool name "${tool.name}" exceeds max length ${MAX_MCP_TOOL_NAME_LENGTH}`
        );

        // 4. No dots or special characters allowed
        assert.ok(!tool.name.includes('.'), `Exposed tool name "${tool.name}" must not contain dots`);

        // 5. Uniqueness
        assert.ok(!exposedNames.has(tool.name), `Duplicate exposed tool name detected: "${tool.name}"`);
        exposedNames.add(tool.name);

        // 6. With Antigravity prefix 'mcp_OtonomMCP_<name>', must also satisfy regex and length
        const prefixedName = `${antigravityPrefix}${tool.name}`;
        assert.ok(
          MCP_TOOL_NAME_REGEX.test(prefixedName),
          `Prefixed name "${prefixedName}" violates regex ${MCP_TOOL_NAME_REGEX}`
        );
        assert.ok(
          prefixedName.length <= MAX_MCP_TOOL_NAME_LENGTH,
          `Prefixed name "${prefixedName}" (${prefixedName.length}) exceeds 64 chars`
        );

        // 7. Verify schemas and descriptions preserved
        assert.ok(tool.description && typeof tool.description === 'string');
        assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object');

        // 8. Verify lookup by exposed name and internal name
        const lookupByExposed = server.getTool(tool.name);
        assert.ok(lookupByExposed, `Lookup by exposed name failed for: ${tool.name}`);

        if (tool.internalName) {
          const lookupByInternal = server.getTool(tool.internalName);
          assert.ok(lookupByInternal, `Lookup by internal name failed for: ${tool.internalName}`);
          assert.equal(lookupByExposed, lookupByInternal);
        }
      }

      assert.equal(exposedNames.size, tools.length, 'All exposed tool names must be unique');
    });
  });
});
