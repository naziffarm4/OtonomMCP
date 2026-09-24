/**
 * MCP Request Correlation Boundary (Phase 8 TASK-P8-01)
 *
 * Provides a deterministic request correlation identifier available to downstream
 * logging and evidence without conflating:
 * - MCP request ID (JSON-RPC message ID)
 * - Director session ID (reserved for Phase 9)
 * - Project ID
 * - Task ID
 * - Execution iteration ID
 */

import type { McpId } from './mcp-types.js';

let correlationCounter = 0;

/**
 * Structured correlation context for requests crossing the MCP boundary.
 */
export interface McpRequestCorrelation {
  /**
   * Deterministic correlation identifier for tracking this request across AIDM.
   */
  readonly correlationId: string;

  /**
   * The client-provided JSON-RPC message ID (number, string, or null/undefined if notification).
   */
  readonly mcpRequestId?: McpId | null;

  /**
   * Optional future Director session identifier (reserved boundary for P9; not conflated).
   */
  readonly directorSessionId?: string | null;

  /**
   * Optional target project identifier if scoped to a project.
   */
  readonly projectId?: string | null;

  /**
   * Optional target task identifier if scoped to a specific task.
   */
  readonly taskId?: string | null;

  /**
   * Optional execution iteration ID if executing within an autonomous iteration loop.
   */
  readonly executionIterationId?: string | null;

  /**
   * ISO 8601 timestamp when the request crossed the MCP boundary.
   */
  readonly receivedAt: string;
}

export interface CreateCorrelationOptions {
  readonly correlationId?: string;
  readonly mcpRequestId?: McpId | null;
  readonly directorSessionId?: string | null;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly executionIterationId?: string | null;
  readonly customGenerator?: () => string;
}

/**
 * Generate a deterministic or uniquely prefixed correlation identifier.
 */
export function generateCorrelationId(): string {
  correlationCounter += 1;
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  return `aidm-corr-${timestamp}-${correlationCounter}-${rand}`;
}

/**
 * Create a validated McpRequestCorrelation context.
 */
export function createRequestCorrelation(
  options: CreateCorrelationOptions = {}
): McpRequestCorrelation {
  const correlationId =
    options.correlationId ??
    (options.customGenerator ? options.customGenerator() : generateCorrelationId());

  return Object.freeze({
    correlationId,
    mcpRequestId: options.mcpRequestId ?? null,
    directorSessionId: options.directorSessionId ?? null,
    projectId: options.projectId ?? null,
    taskId: options.taskId ?? null,
    executionIterationId: options.executionIterationId ?? null,
    receivedAt: new Date().toISOString(),
  });
}

/**
 * Type guard for McpRequestCorrelation.
 */
export function isMcpRequestCorrelation(value: unknown): value is McpRequestCorrelation {
  if (typeof value !== 'object' || value === null) return false;
  const corr = value as Record<string, unknown>;
  return typeof corr.correlationId === 'string' && typeof corr.receivedAt === 'string';
}
