/**
 * MCP Server Implementation (Phase 8 TASK-P8-01)
 *
 * Establishes the authoritative MCP-compatible server boundary for AIDM.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. MCP is a control-plane adapter sitting strictly ABOVE the AIDM Orchestrator.
 * 2. MCP is NOT a second orchestrator. It does not own or mutate an FSM, task DAG,
 *    Git, or evidence.
 * 3. All operations pass through the delegate boundary and policy engine.
 * 4. Error responses are normalized, typed, and secret-redacted.
 * 5. Deterministic request correlation is tracked for every request.
 */

import {
  type McpServerConfig,
  type McpServerCapabilities,
  type McpMessage,
  type McpRequestEnvelope,
  type McpResponseEnvelope,
  type McpSuccessResponseEnvelope,
  type McpErrorResponseEnvelope,
  type McpToolDefinition,
  type McpToolHandler,
  type McpToolRegistration,
  type McpInitializeResult,
  McpServerState,
  LATEST_MCP_PROTOCOL_VERSION,
  MCP_FOUNDATION_VERSION,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_MCP_SERVER_VERSION,
  DEFAULT_AIDM_VERSION,
  isMcpRequest,
  isMcpNotification,
} from './mcp-types.js';
import type { McpTransport } from './mcp-transport.js';
import type { McpOrchestratorDelegate } from './mcp-delegate.js';
import type { PolicyEngine } from '../policy/policy-engine.js';
import {
  McpErrorNormalizer,
  McpInvalidRequestError,
  McpUnsupportedOperationError,
  McpPolicyBlockedError,
  McpJsonRpcErrorCode,
  McpErrorCode,
} from './mcp-errors.js';
import {
  createRequestCorrelation,
  type McpRequestCorrelation,
} from './mcp-correlation.js';
import { createHealthTool } from './tools/health-tool.js';
import {
  registerDirectorReadTools,
  registerDiscoveryTools,
} from './tools/director-read-tools.js';
import { registerClarificationTools } from './tools/clarification-tools.js';

export class McpServer {
  readonly name: string;
  readonly version: string;
  readonly aidmVersion: string;
  readonly foundationVersion: string;
  readonly transport: McpTransport;
  readonly delegate?: McpOrchestratorDelegate;
  readonly policyEngine?: PolicyEngine;
  readonly capabilities: McpServerCapabilities;
  readonly instructions?: string;

  private state: McpServerState = McpServerState.CREATED;
  private readonly toolRegistry = new Map<string, McpToolRegistration>();
  private readonly correlationGenerator?: () => string;
  private clientInitialized = false;

  constructor(config: McpServerConfig) {
    this.name = config.name ?? DEFAULT_MCP_SERVER_NAME;
    this.version = config.version ?? DEFAULT_MCP_SERVER_VERSION;
    this.aidmVersion = config.aidmVersion ?? DEFAULT_AIDM_VERSION;
    this.foundationVersion = config.foundationVersion ?? MCP_FOUNDATION_VERSION;
    this.transport = config.transport;
    this.delegate = config.delegate;
    this.policyEngine = config.policyEngine ?? config.delegate?.policyEngine;
    this.capabilities = Object.freeze({
      tools: { listChanged: false },
      ...config.capabilities,
    });
    this.instructions = config.instructions;
    this.correlationGenerator = config.correlationGenerator;

    // Register minimal health & capability discovery tool
    const healthTool = createHealthTool({
      serverName: this.name,
      serverVersion: this.version,
      aidmVersion: this.aidmVersion,
    });
    this.registerTool(healthTool.definition, healthTool.handler);

    // Register Director read-only tools if enabled
    if (config.directorTools) {
      registerDirectorReadTools(this);
    }

    // Register Director project discovery tool if enabled
    if (config.discoveryTools) {
      registerDiscoveryTools(this);
    }

    // Register Director clarification protocol tools if enabled
    if (config.clarificationTools) {
      registerClarificationTools(this);
    }
  }

  // ==========================================================================
  // LIFECYCLE MANAGEMENT
  // ==========================================================================

  getState(): McpServerState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state === McpServerState.RUNNING;
  }

  async start(): Promise<void> {
    if (this.state === McpServerState.RUNNING) {
      return;
    }

    this.state = McpServerState.STARTING;

    this.transport.onMessage(async (message: McpMessage) => {
      try {
        const response = await this.handleMessage(message);
        if (response && this.transport.isConnected) {
          await this.transport.send(response);
        }
      } catch (err) {
        // Transport-level sending error
        this.state = McpServerState.ERROR;
      }
    });

    this.transport.onError((_err: Error) => {
      // Keep running or transition to error depending on severity
    });

    this.transport.onClose(() => {
      if (this.state === McpServerState.RUNNING) {
        this.state = McpServerState.STOPPED;
      }
    });

    await this.transport.start();
    this.state = McpServerState.RUNNING;
  }

  async stop(): Promise<void> {
    if (this.state === McpServerState.STOPPED) {
      return;
    }

    this.state = McpServerState.STOPPING;
    this.clientInitialized = false;

    if (this.transport.isConnected) {
      await this.transport.close();
    }

    this.state = McpServerState.STOPPED;
  }

  // ==========================================================================
  // TOOL REGISTRATION
  // ==========================================================================

  registerTool(definition: McpToolDefinition, handler: McpToolHandler): void {
    if (!definition || !definition.name) {
      throw new McpInvalidRequestError('Tool definition must specify a valid name');
    }
    this.toolRegistry.set(definition.name, { definition, handler });
  }

  getRegisteredTools(): readonly McpToolDefinition[] {
    return Array.from(this.toolRegistry.values()).map((r) => r.definition);
  }

  getTool(name: string): McpToolRegistration | undefined {
    return this.toolRegistry.get(name);
  }

  // ==========================================================================
  // MESSAGE PROCESSING & ENVELOPE BOUNDARY
  // ==========================================================================

  async handleMessage(rawMessage: unknown): Promise<McpResponseEnvelope | null> {
    // 1. Validate envelope structure
    if (typeof rawMessage !== 'object' || rawMessage === null) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: McpJsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid MCP JSON-RPC message: payload must be a non-null object',
          data: { code: McpErrorCode.INVALID_REQUEST },
        },
      };
    }

    const msg = rawMessage as Record<string, unknown>;

    // Handle synthetic malformed JSON notification from transport
    if (msg.method === '__malformed_json__') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: McpJsonRpcErrorCode.PARSE_ERROR,
          message: 'Parse error: invalid JSON received',
          data: { code: McpErrorCode.PARSE_ERROR },
        },
      };
    }

    if (msg.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null,
        error: {
          code: McpJsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid MCP JSON-RPC message: "jsonrpc" must be exact string "2.0"',
          data: { code: McpErrorCode.INVALID_REQUEST },
        },
      };
    }

    // 2. Handle Notifications (no response envelope returned)
    if (isMcpNotification(rawMessage)) {
      if (rawMessage.method === 'notifications/initialized') {
        this.clientInitialized = true;
      }
      return null;
    }

    // 3. Handle Requests (must have an id)
    if (!isMcpRequest(rawMessage)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: McpJsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid MCP request: missing or invalid "id" or "method"',
          data: { code: McpErrorCode.INVALID_REQUEST },
        },
      };
    }

    const req: McpRequestEnvelope = rawMessage;

    // Establish request correlation
    const params = req.params ?? {};
    const correlation = createRequestCorrelation({
      mcpRequestId: req.id,
      directorSessionId: typeof params._directorSessionId === 'string' ? params._directorSessionId : null,
      projectId: typeof params._projectId === 'string' ? params._projectId : null,
      taskId: typeof params._taskId === 'string' ? params._taskId : null,
      executionIterationId: typeof params._executionIterationId === 'string' ? params._executionIterationId : null,
      customGenerator: this.correlationGenerator,
    });

    // Check server lifecycle readiness
    if (this.state !== McpServerState.RUNNING && this.state !== McpServerState.STARTING) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: McpJsonRpcErrorCode.INTERNAL_ERROR,
          message: `Server is not running (current state: ${this.state})`,
          data: {
            code: McpErrorCode.INTERNAL_FAILURE,
            correlationId: correlation.correlationId,
          },
        },
      };
    }

    // 4. Method Dispatch
    try {
      const result = await this.dispatchMethod(req, correlation);
      return {
        jsonrpc: '2.0',
        id: req.id,
        result,
      };
    } catch (err) {
      const normalized = McpErrorNormalizer.normalize(err, correlation);
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: normalized,
      };
    }
  }

  private async dispatchMethod(
    req: McpRequestEnvelope,
    correlation: McpRequestCorrelation
  ): Promise<unknown> {
    const params = req.params ?? {};

    switch (req.method) {
      case 'initialize': {
        const initResult: McpInitializeResult = {
          protocolVersion: LATEST_MCP_PROTOCOL_VERSION,
          capabilities: this.capabilities,
          serverInfo: {
            name: this.name,
            version: this.version,
          },
          aidmVersion: this.aidmVersion,
          foundationVersion: this.foundationVersion,
          instructions: this.instructions,
        };
        return initResult;
      }

      case 'ping': {
        return {};
      }

      case 'tools/list': {
        return {
          tools: this.getRegisteredTools(),
        };
      }

      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : undefined;
        if (!toolName) {
          throw new McpInvalidRequestError('Missing required parameter "name" in tools/call', {
            correlationId: correlation.correlationId,
          });
        }

        const registration = this.toolRegistry.get(toolName);
        if (!registration) {
          throw new McpUnsupportedOperationError(`Unsupported tool: "${toolName}"`, {
            toolName,
            correlationId: correlation.correlationId,
          });
        }

        const args = (typeof params.arguments === 'object' && params.arguments !== null)
          ? (params.arguments as Record<string, unknown>)
          : {};

        // Policy boundary check if policyEngine is injected
        if (this.policyEngine) {
          const policyDecision = this.policyEngine.evaluate({
            command: `mcp tools/call ${toolName}`,
            action_type: 'READ_ONLY_INSPECTION',
            is_read_only: true,
            metadata: { toolName, correlationId: correlation.correlationId },
          });

          if (!policyDecision.allowed) {
            throw new McpPolicyBlockedError(
              `Tool call "${toolName}" blocked by policy: ${policyDecision.reason}`,
              {
                toolName,
                code: policyDecision.code,
                reason: policyDecision.reason,
                violations: policyDecision.violations,
              },
              correlation.correlationId
            );
          }
        }

        // Execute tool within request context
        const context = {
          correlation,
          delegate: this.delegate,
        };

        const toolResult = await registration.handler(args, context);
        return toolResult;
      }

      default: {
        throw new McpUnsupportedOperationError(`Unsupported MCP method: "${req.method}"`, {
          method: req.method,
          correlationId: correlation.correlationId,
        });
      }
    }
  }
}
