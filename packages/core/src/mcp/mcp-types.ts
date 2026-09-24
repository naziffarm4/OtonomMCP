/**
 * MCP Server Domain & Boundary Types (Phase 8 TASK-P8-01)
 *
 * Defines the authoritative MCP protocol envelope contracts, server capabilities,
 * tool definition contracts, lifecycle states, and request context boundaries.
 * Adheres to standard MCP protocol specification (2024-11-05).
 */

import type { McpRequestCorrelation } from './mcp-correlation.js';
import type { McpOrchestratorDelegate } from './mcp-delegate.js';
import type { McpTransport } from './mcp-transport.js';
import type { PolicyEngine } from '../policy/policy-engine.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const LATEST_MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_FOUNDATION_VERSION = 'P8-01';
export const DEFAULT_MCP_SERVER_NAME = 'aidm-mcp-server';
export const DEFAULT_MCP_SERVER_VERSION = '0.1.0';
export const DEFAULT_AIDM_VERSION = '0.1.0';

// ============================================================================
// 2. SERVER LIFECYCLE STATES
// ============================================================================

export const McpServerState = {
  CREATED: 'CREATED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
} as const;

export type McpServerState = (typeof McpServerState)[keyof typeof McpServerState];

export const MCP_SERVER_STATES = Object.values(McpServerState) as readonly McpServerState[];

export function isMcpServerState(value: unknown): value is McpServerState {
  return typeof value === 'string' && (MCP_SERVER_STATES as readonly string[]).includes(value);
}

// ============================================================================
// 3. JSON-RPC 2.0 / MCP ENVELOPES
// ============================================================================

export type McpId = string | number;

/**
 * Standard MCP JSON-RPC 2.0 Request Envelope.
 */
export interface McpRequestEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: McpId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Standard MCP JSON-RPC 2.0 Notification Envelope (no id).
 */
export interface McpNotificationEnvelope {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Standard MCP JSON-RPC 2.0 Success Response Envelope.
 */
export interface McpSuccessResponseEnvelope<T = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: McpId;
  readonly result: T;
}

/**
 * Standard MCP JSON-RPC 2.0 Error Object.
 */
export interface McpJsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: {
    readonly code: string;
    readonly correlationId?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
}

/**
 * Standard MCP JSON-RPC 2.0 Error Response Envelope.
 */
export interface McpErrorResponseEnvelope {
  readonly jsonrpc: '2.0';
  readonly id: McpId | null;
  readonly error: McpJsonRpcErrorObject;
}

export type McpResponseEnvelope<T = unknown> =
  | McpSuccessResponseEnvelope<T>
  | McpErrorResponseEnvelope;

export type McpMessage =
  | McpRequestEnvelope
  | McpNotificationEnvelope
  | McpSuccessResponseEnvelope
  | McpErrorResponseEnvelope;

// Type guards
export function isMcpRequest(message: unknown): message is McpRequestEnvelope {
  if (typeof message !== 'object' || message === null) return false;
  const req = message as Record<string, unknown>;
  return req.jsonrpc === '2.0' && typeof req.method === 'string' && (typeof req.id === 'string' || typeof req.id === 'number');
}

export function isMcpNotification(message: unknown): message is McpNotificationEnvelope {
  if (typeof message !== 'object' || message === null) return false;
  const notif = message as Record<string, unknown>;
  return notif.jsonrpc === '2.0' && typeof notif.method === 'string' && !('id' in notif);
}

export function isMcpResponse(message: unknown): message is McpResponseEnvelope {
  if (typeof message !== 'object' || message === null) return false;
  const res = message as Record<string, unknown>;
  return res.jsonrpc === '2.0' && ('result' in res || 'error' in res);
}

export function isMcpErrorResponse(message: unknown): message is McpErrorResponseEnvelope {
  if (!isMcpResponse(message)) return false;
  const res = message as unknown as Record<string, unknown>;
  return 'error' in res && typeof res.error === 'object' && res.error !== null;
}

// ============================================================================
// 4. MCP CAPABILITIES & DISCOVERY
// ============================================================================

export interface McpServerCapabilities {
  readonly tools?: {
    readonly listChanged?: boolean;
  };
  readonly resources?: {
    readonly subscribe?: boolean;
    readonly listChanged?: boolean;
  };
  readonly prompts?: {
    readonly listChanged?: boolean;
  };
  readonly logging?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface McpClientInfo {
  readonly name: string;
  readonly version?: string;
}

export interface McpInitializeParams {
  readonly protocolVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly clientInfo?: McpClientInfo;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpServerCapabilities;
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly aidmVersion: string;
  readonly foundationVersion: string;
  readonly instructions?: string;
}

// ============================================================================
// 5. TOOL CONTRACTS
// ============================================================================

export interface McpToolInputSchema {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpToolInputSchema;
}

export interface McpToolContent {
  readonly type: 'text' | 'image' | 'resource';
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

export interface McpToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface McpRequestContext {
  readonly correlation: McpRequestCorrelation;
  readonly delegate?: McpOrchestratorDelegate;
}

export type McpToolHandler = (
  args: Readonly<Record<string, unknown>>,
  context: McpRequestContext
) => Promise<McpToolResult> | McpToolResult;

export interface McpToolRegistration {
  readonly definition: McpToolDefinition;
  readonly handler: McpToolHandler;
}

// ============================================================================
// 6. SERVER CONFIGURATION
// ============================================================================

export interface McpServerConfig {
  readonly name?: string;
  readonly version?: string;
  readonly aidmVersion?: string;
  readonly foundationVersion?: string;
  readonly transport: McpTransport;
  readonly delegate?: McpOrchestratorDelegate;
  readonly policyEngine?: PolicyEngine;
  readonly capabilities?: McpServerCapabilities;
  readonly instructions?: string;
  readonly correlationGenerator?: () => string;
  readonly directorTools?: boolean;
  readonly discoveryTools?: boolean;
  readonly clarificationTools?: boolean;
}
