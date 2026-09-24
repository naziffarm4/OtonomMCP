/**
 * Execution Request Contract MCP Tools (Phase 10 TASK-P10-02)
 *
 * Exposes deterministic ExecutionRequest creation and validation tools
 * through the MCP boundary:
 * 1. aidm.execution.request.build
 * 2. aidm.execution.request.create (alias)
 *
 * STRICT GOVERNANCE RULES:
 * 1. CONTRACT ONLY: Zero executor invocation, zero subagent spawn, zero shell commands.
 * 2. DETERMINISTIC IDENTIFIERS: requestId is computed deterministically via canonical JSON + SHA-256.
 * 3. BINDING FIDELITY: Sensitive binding fields originate from the verified ExecutionIntent;
 *    any caller attempts to forge or override these fields are strictly rejected.
 * 4. PATH RESTRICTIONS: targetFiles must be relative POSIX paths; path traversal (..)
 *    and absolute paths are strictly prohibited and rejected.
 * 5. REPOSITORY STATE AUTHORITY: expectedRepositoryState is verified against authoritative
 *    Git state; baseline forgery is rejected.
 * 6. FINITE BOUNDS: executionLimits (timeoutMs, maxFileModifications) are strictly bounded.
 * 7. ZERO STATE MUTATION: Does NOT mutate DurableStateManager global FSM, Task DAG,
 *    SpecStore, or ApprovalStore.
 */

import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { ExecutionRequestBuilder } from '../../executor-bridge/execution-request-builder.js';
import {
  BuildExecutionRequestInputZodSchema,
  type BuildExecutionRequestInput,
} from '../../executor-bridge/execution-request-types.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME = 'aidm.execution.request.build';
export const AIDM_EXECUTION_REQUEST_CREATE_TOOL_NAME = 'aidm.execution.request.create';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const executionRequestBuildToolDefinition: McpToolDefinition = {
  name: AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME,
  description:
    'Deterministically builds and validates an immutable ExecutionRequest from a verified ExecutionIntent. Enforces canonical instruction normalization, POSIX relative path safety (rejecting path traversal and absolute paths), authoritative Git repository state capture/forgery detection, and finite execution limits. Computes deterministic requestId via canonical SHA-256. Zero execution dispatch.',
  inputSchema: {
    type: 'object',
    required: ['intent'],
    properties: {
      intent: {
        type: 'object',
        description: 'Authoritative, verified ExecutionIntent from aidm.execution.intent.validate.',
        required: [
          'intentId',
          'directorSessionId',
          'directorDecisionId',
          'projectId',
          'taskId',
          'taskRevision',
          'contextFingerprint',
          'understandingRevision',
          'approvalPackageRevision',
          'operationType',
          'protocolVersion',
          'schemaVersion',
        ],
      },
      instruction: {
        type: 'object',
        description: 'Optional execution instruction details. Can be derived from task in SpecStore if omitted.',
        properties: {
          objective: { type: 'string', description: 'Clear, non-empty objective description.' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Execution constraints.' },
          targetFiles: { type: 'array', items: { type: 'string' }, description: 'Target file paths (strictly relative POSIX paths; no .. or absolute paths).' },
          acceptanceCriteria: {
            type: 'array',
            description: 'Measurable acceptance criteria (strings or criterion objects).',
          },
        },
      },
      expectedRepositoryState: {
        type: 'object',
        description: 'Optional expected Git repository baseline state. Validated against authoritative Git HEAD; forgery rejected.',
        properties: {
          baseCommit: { type: 'string', description: 'Expected Git commit SHA.' },
          isClean: { type: 'boolean', description: 'Expected working tree clean status.' },
        },
      },
      executionLimits: {
        type: 'object',
        description: 'Optional execution limits (timeoutMs, maxFileModifications). Bounded to safe ranges.',
        properties: {
          timeoutMs: { type: 'number', description: 'Execution timeout in ms (1,000 to 3,600,000).' },
          maxFileModifications: { type: 'number', description: 'Max allowed modified files (1 to 100).' },
        },
      },
      workingDirectory: {
        type: 'string',
        description: 'Optional working directory path for Git state inspection.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional project root path.',
      },
      metadata: {
        type: 'object',
        description: 'Optional sanitized metadata.',
      },
    },
  },
};

export const executionRequestCreateToolDefinition: McpToolDefinition = {
  ...executionRequestBuildToolDefinition,
  name: AIDM_EXECUTION_REQUEST_CREATE_TOOL_NAME,
};

// ============================================================================
// TOOL FACTORIES
// ============================================================================

export function createExecutionRequestBuildTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: executionRequestBuildToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = BuildExecutionRequestInputZodSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for '${AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME}': ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
      }

      const delegate = context.delegate ?? defaultDelegate;
      const workspaceRoot =
        (args.workspaceRoot as string | undefined) ??
        parsed.data.workingDirectory ??
        delegate?.projectRoot ??
        process.cwd();

      const builder = new ExecutionRequestBuilder({
        workspaceRoot,
        gitPort: delegate?.gitPort,
        specStore: delegate?.specStore,
      });

      try {
        const request = await builder.buildExecutionRequest(parsed.data as BuildExecutionRequestInput);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sanitizeMcpPayload({
                  success: true,
                  requestId: request.requestId,
                  request,
                }),
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sanitizeMcpPayload({
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                  code: (err as { code?: string })?.code ?? 'ERR_EXECUTION_REQUEST',
                  details: (err as { details?: unknown })?.details,
                }),
                null,
                2
              ),
            },
          ],
        };
      }
    },
  };
}

export function createExecutionRequestCreateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  const base = createExecutionRequestBuildTool(defaultDelegate);
  return {
    definition: executionRequestCreateToolDefinition,
    handler: base.handler,
  };
}

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerExecutionRequestTools(server: McpServer): void {
  const buildTool = createExecutionRequestBuildTool(server.delegate);
  const createTool = createExecutionRequestCreateTool(server.delegate);

  server.registerTool(buildTool.definition, buildTool.handler);
  server.registerTool(createTool.definition, createTool.handler);
}
