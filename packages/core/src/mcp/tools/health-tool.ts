/**
 * Minimal Health & Capability Tool: aidm.health (Phase 8 TASK-P8-01)
 *
 * Implements the minimal health and capability discovery tool sufficient to prove
 * the MCP server is alive and able to query orchestrator connectivity without
 * state mutation.
 */

import {
  type McpToolDefinition,
  type McpToolRegistration,
  type McpToolResult,
  type McpRequestContext,
  LATEST_MCP_PROTOCOL_VERSION,
  MCP_FOUNDATION_VERSION,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_MCP_SERVER_VERSION,
  DEFAULT_AIDM_VERSION,
} from '../mcp-types.js';

export const AIDM_HEALTH_TOOL_NAME = 'aidm.health';

export const healthToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_HEALTH_TOOL_NAME,
  description:
    'Returns AIDM MCP server health status, capabilities, and orchestrator connectivity without mutating state.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
});

export interface HealthToolMetadataOptions {
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly aidmVersion?: string;
}

export function createHealthTool(
  options: HealthToolMetadataOptions = {}
): McpToolRegistration {
  const serverName = options.serverName ?? DEFAULT_MCP_SERVER_NAME;
  const serverVersion = options.serverVersion ?? DEFAULT_MCP_SERVER_VERSION;
  const aidmVersion = options.aidmVersion ?? DEFAULT_AIDM_VERSION;

  return {
    definition: healthToolDefinition,
    handler: async (
      _args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      let orchestratorConnected = false;
      let orchestratorInitialized = false;
      let lifecycleState: string | null = null;
      let isBlocked = false;

      if (context.delegate) {
        try {
          orchestratorConnected = await context.delegate.isHealthy();
          if (context.delegate.getStatus) {
            const status = await context.delegate.getStatus(context.correlation);
            orchestratorInitialized = status.isInitialized;
            lifecycleState = status.currentLifecycleState ?? null;
            isBlocked = !!status.isBlocked;
          }
        } catch {
          orchestratorConnected = false;
        }
      }

      const status = orchestratorConnected ? 'healthy' : 'degraded';

      const payload = {
        status,
        server: {
          name: serverName,
          version: serverVersion,
          aidmVersion,
          foundationVersion: MCP_FOUNDATION_VERSION,
          protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
        },
        supportedCapabilities: ['tools', 'discovery', 'health'],
        orchestrator: {
          connected: orchestratorConnected,
          initialized: orchestratorInitialized,
          currentLifecycleState: lifecycleState,
          isBlocked,
        },
        correlationId: context.correlation.correlationId,
        timestamp: new Date().toISOString(),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: false,
      };
    },
  };
}
