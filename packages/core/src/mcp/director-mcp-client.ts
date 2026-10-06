/**
 * Antigravity / Internal Director MCP Client & Auth Boundary (Phase 22 TASK-P22-01)
 *
 * Provides a clean, typed programmatic client for Antigravity and internal components
 * to invoke the 6 high-level Director MCP Control Plane tools.
 *
 * Supported Modes:
 * 1. In-Memory Direct Mode: invokes McpServer directly via handleMessage without network/IPC overhead.
 * 2. Transport Mode: connects via McpTransport (e.g. InMemoryMcpTransport, StdioMcpTransport).
 *
 * AUTH & TRUST BOUNDARY:
 * - Stdio & in-memory transports operate within the local process trust boundary.
 * - External network / HTTP integrations require explicit cryptographic token authentication.
 * - No credentials or tokens are ever logged, leaked into errors, or written to telemetry.
 */

import type { McpServer } from './mcp-server.js';
import type { McpTransport } from './mcp-transport.js';
import type {
  McpRequestEnvelope,
  McpResponseEnvelope,
  McpToolDefinition,
  McpMessage,
} from './mcp-types.js';
import {
  AIDM_DIRECTOR_OPEN_TOOL_NAME,
  AIDM_DIRECTOR_CONTEXT_TOOL_NAME,
  AIDM_DIRECTOR_ACT_TOOL_NAME,
  AIDM_DIRECTOR_RESULT_TOOL_NAME,
  AIDM_DIRECTOR_STATUS_TOOL_NAME,
  AIDM_DIRECTOR_CONTROL_TOOL_NAME,
} from './tools/director-control-plane-tools.js';

// ============================================================================
// CLIENT OPTIONS & TYPES
// ============================================================================

export interface DirectorMcpClientOptions {
  readonly server?: McpServer;
  readonly transport?: McpTransport;
  readonly authToken?: string;
  readonly defaultWorkspaceRoot?: string;
  readonly defaultProjectId?: string;
}

export interface DirectorOpenParams {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly actor?: string;
  readonly actorRole?: 'DIRECTOR' | 'PROJECT_DIRECTOR';
  readonly metadata?: Record<string, unknown>;
  readonly forceNew?: boolean;
}

export interface DirectorContextParams {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly refresh?: boolean;
}

export interface DirectorActParams {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly actionType: string;
  readonly payload: Record<string, unknown>;
  readonly basedOnContextFingerprint?: string;
  readonly contextFingerprint?: string;
  readonly understandingRevision?: number;
  readonly idempotencyKey?: string;
  readonly authContext?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface DirectorResultParams {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly cycleId?: string;
  readonly actionId?: string;
  readonly instructionId?: string;
  readonly taskId?: string;
}

export interface DirectorStatusParams {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
}

export interface DirectorControlParams {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly action: 'pause' | 'resume' | 'stop';
  readonly reason?: string;
  readonly targetTaskId?: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
}

// ============================================================================
// AUTHENTICATION MIDDLEWARE & TRUST BOUNDARY
// ============================================================================

export interface McpAuthVerificationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface McpAuthMiddlewareOptions {
  readonly requiredToken?: string;
  readonly headerName?: string;
}

/**
 * Creates an authentication middleware for external MCP connections.
 * In local stdio / in-memory mode without configured token, operates in trusted process space.
 */
export function createMcpAuthMiddleware(options: McpAuthMiddlewareOptions = {}) {
  const expectedToken = options.requiredToken ?? process.env.AIDM_MCP_AUTH_TOKEN;

  return (rawMessage: unknown): McpAuthVerificationResult => {
    // If no token is configured in environment or options, local process trust boundary applies
    if (!expectedToken) {
      return { allowed: true };
    }

    if (typeof rawMessage !== 'object' || rawMessage === null) {
      return { allowed: false, reason: 'Invalid payload structure' };
    }

    const msg = rawMessage as Record<string, unknown>;
    const params = (msg.params as Record<string, unknown>) ?? {};
    const candidate =
      (params._authToken as string | undefined) ??
      (params.authToken as string | undefined) ??
      (msg.authToken as string | undefined);

    if (candidate !== expectedToken) {
      return { allowed: false, reason: 'Unauthorized: missing or invalid MCP authentication token' };
    }

    return { allowed: true };
  };
}

// ============================================================================
// DIRECTOR MCP CLIENT IMPLEMENTATION
// ============================================================================

export class DirectorMcpClient {
  private readonly server?: McpServer;
  private readonly transport?: McpTransport;
  private readonly authToken?: string;
  private readonly defaultWorkspaceRoot?: string;
  private readonly defaultProjectId?: string;
  private requestIdCounter = 1;
  private pendingRequests = new Map<string | number, (response: McpResponseEnvelope) => void>();

  constructor(options: DirectorMcpClientOptions) {
    if (!options.server && !options.transport) {
      throw new Error('DirectorMcpClient requires either a server (in-memory) or transport instance');
    }
    this.server = options.server;
    this.transport = options.transport;
    this.authToken = options.authToken ?? process.env.AIDM_MCP_AUTH_TOKEN;
    this.defaultWorkspaceRoot = options.defaultWorkspaceRoot;
    this.defaultProjectId = options.defaultProjectId;

    if (this.transport) {
      this.transport.onMessage((msg: McpMessage) => {
        if ('id' in msg && msg.id !== null && msg.id !== undefined) {
          const resolver = this.pendingRequests.get(msg.id);
          if (resolver && ('result' in msg || 'error' in msg)) {
            this.pendingRequests.delete(msg.id);
            resolver(msg as McpResponseEnvelope);
          }
        }
      });
    }
  }

  /**
   * Initializes MCP session with server.
   */
  async initialize(): Promise<unknown> {
    return this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'AntigravityDirectorClient', version: '0.1.0' },
    });
  }

  /**
   * Lists all available MCP tools from the server.
   */
  async listTools(): Promise<readonly McpToolDefinition[]> {
    const res = (await this.sendRequest('tools/list', {})) as { tools: readonly McpToolDefinition[] };
    return res.tools ?? [];
  }

  /**
   * Calls a tool by name and arguments, automatically extracting parsed JSON payload.
   */
  async callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const finalArgs: Record<string, unknown> = {
      ...(this.defaultWorkspaceRoot && !args.workspaceRoot ? { workspaceRoot: this.defaultWorkspaceRoot } : {}),
      ...(this.defaultProjectId && !args.projectId ? { projectId: this.defaultProjectId } : {}),
      ...args,
    };

    const res = (await this.sendRequest('tools/call', {
      name,
      arguments: finalArgs,
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

    if (!res || !res.content || res.content.length === 0) {
      return res as T;
    }

    const first = res.content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        return parsed as T;
      } catch {
        return first.text as unknown as T;
      }
    }

    return res as T;
  }

  // ==========================================================================
  // TYPED FACADE OVER THE 6 HIGH-LEVEL TOOLS
  // ==========================================================================

  /**
   * 1. aidm.director.open: Opens or retrieves an existing active Director session.
   */
  async open<T = any>(params: DirectorOpenParams = {}): Promise<T> {
    return this.callTool<T>(AIDM_DIRECTOR_OPEN_TOOL_NAME, params as unknown as Record<string, unknown>);
  }

  /**
   * 2. aidm.director.context: Retrieves current authoritative context snapshot.
   */
  async context<T = any>(params: DirectorContextParams = {}): Promise<T> {
    return this.callTool<T>(AIDM_DIRECTOR_CONTEXT_TOOL_NAME, params as unknown as Record<string, unknown>);
  }

  /**
   * 3. aidm.director.act: Submits a structured Director action.
   */
  async act<T = any>(params: DirectorActParams): Promise<T> {
    return this.callTool<T>(AIDM_DIRECTOR_ACT_TOOL_NAME, params as unknown as Record<string, unknown>);
  }

  /**
   * 4. aidm.director.result: Retrieves action / cycle / evidence result.
   */
  async result<T = any>(params: DirectorResultParams = {}): Promise<T> {
    return this.callTool<T>(AIDM_DIRECTOR_RESULT_TOOL_NAME, params as unknown as Record<string, unknown>);
  }

  /**
   * 5. aidm.director.status: Retrieves unified project / session / lifecycle status.
   */
  async status<T = any>(params: DirectorStatusParams = {}): Promise<T> {
    return this.callTool<T>(AIDM_DIRECTOR_STATUS_TOOL_NAME, params as unknown as Record<string, unknown>);
  }

  /**
   * 6. aidm.director.control: Executes lifecycle control (pause | resume | stop).
   */
  async control<T = any>(params: DirectorControlParams): Promise<T> {
    return this.callTool<T>(AIDM_DIRECTOR_CONTROL_TOOL_NAME, params as unknown as Record<string, unknown>);
  }

  // ==========================================================================
  // DISPATCH CORE
  // ==========================================================================

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.requestIdCounter++;
    const requestEnvelope: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...(this.authToken ? { _authToken: this.authToken } : {}),
        ...params,
      },
    };

    if (this.server) {
      // In-Memory direct call
      const response = await this.server.handleMessage(requestEnvelope);
      if (!response) {
        throw new Error(`Null response from McpServer for method "${method}"`);
      }
      if ('error' in response && response.error) {
        const err = new Error(response.error.message || `MCP Error ${response.error.code}`);
        (err as any).code = response.error.code;
        (err as any).data = response.error.data;
        throw err;
      }
      if ('result' in response) {
        return response.result;
      }
      return response;
    }

    const transport = this.transport;
    if (transport) {
      return new Promise<unknown>((resolve, reject) => {
        this.pendingRequests.set(id, (resp: McpResponseEnvelope) => {
          if ('error' in resp && resp.error) {
            const err = new Error(resp.error.message || `MCP Error ${resp.error.code}`);
            (err as any).code = resp.error.code;
            (err as any).data = resp.error.data;
            reject(err);
          } else if ('result' in resp) {
            resolve(resp.result);
          } else {
            resolve(resp);
          }
        });

        transport.send(requestEnvelope).catch((err) => {
          this.pendingRequests.delete(id);
          reject(err);
        });
      });
    }

    throw new Error('No server or transport available');
  }
}

/**
 * Type alias for Antigravity internal client.
 */
export const AntigravityDirectorMcpClient = DirectorMcpClient;
