/**
 * Execution Intent Authorization Boundary MCP Tools (Phase 10 TASK-P10-01)
 *
 * Exposes a single dry-run validation tool through the MCP boundary:
 * 1. aidm.execution.intent.validate
 *
 * STRICT GOVERNANCE RULES:
 * 1. This is a DRY-RUN validation boundary only — zero execution.
 * 2. Director decision NEVER substitutes for Product Owner approval.
 * 3. Director CANNOT produce implementation authorization.
 * 4. Requires explicit isDevelopmentAuthorized() === true from ApprovalPackageEngine.
 * 5. Strictly bound to canonical project, active Director session, context fingerprint,
 *    authoritative understanding revision, approval package revision, and task DAG state.
 * 6. Does NOT invoke Antigravity, spawn OS processes, or start autonomous loops.
 * 7. Does NOT mutate Task DAG, SpecStore, or DurableStateManager global FSM.
 * 8. Zero parallel authority: reuses existing stores, engines, and domain models.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { ExecutionAuthorizer } from '../../director/execution-authorizer.js';
import { ValidateExecutionIntentInputZodSchema } from '../../director/execution-intent-types.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME = 'aidm.execution.intent.validate';

// ============================================================================
// HELPER: Construct ExecutionAuthorizer from delegate
// ============================================================================

function getExecutionAuthorizer(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): ExecutionAuthorizer {
  return new ExecutionAuthorizer({
    workspaceRoot: resolvedRoot,
    delegate,
  });
}

// ============================================================================
// 1. VALIDATE EXECUTION INTENT TOOL
// ============================================================================

export const executionIntentValidateToolDefinition: McpToolDefinition = {
  name: AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME,
  description:
    'Dry-run validation of an execution intent. Verifies Director session, decision type, context snapshot freshness, understanding revision, Product Owner authorization (isDevelopmentAuthorized), and task DAG readiness. Returns VALID or a specific rejection code. Does NOT invoke execution, mutate Task DAG, or start autonomous loops.',
  inputSchema: {
    type: 'object',
    required: [
      'directorSessionId',
      'directorDecisionId',
      'taskId',
      'taskRevision',
      'contextFingerprint',
      'understandingRevision',
      'approvalPackageRevision',
    ],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier. Must match canonical project identity if provided.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Active Director session identifier. Must be an ACTIVE session bound to this project.',
      },
      directorDecisionId: {
        type: 'string',
        description: 'Director decision identifier. Must be an IMPLEMENT_TASK decision.',
      },
      taskId: {
        type: 'string',
        description: 'Task identifier from the authoritative Task DAG. Task must be READY or IN_PROGRESS with all dependencies ACCEPTED.',
      },
      taskRevision: {
        type: 'number',
        description: 'Mandatory expected authoritative task revision for strict revision binding.',
      },
      contextFingerprint: {
        type: 'string',
        description: 'Logical fingerprint of the non-stale context snapshot. Must match the authoritative snapshot.',
      },
      understandingRevision: {
        type: 'number',
        description: 'Mandatory authoritative understanding revision baseline. Must match session understanding revision exactly.',
      },
      approvalPackageRevision: {
        type: 'number',
        description: 'Mandatory bound human approval package revision for strict revision binding.',
      },
      operationType: {
        type: 'string',
        enum: ['IMPLEMENT_TASK'],
        description: 'Intended executor operation type. Must strictly be IMPLEMENT_TASK in P10-01.',
      },
      intentId: {
        type: 'string',
        description: 'Optional deterministic intent identifier. Auto-generated if omitted.',
      },
      metadata: {
        type: 'object',
        description: 'Optional sanitized metadata.',
      },
    },
  },
};

export function createExecutionIntentValidateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: executionIntentValidateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = ValidateExecutionIntentInputZodSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for '${AIDM_EXECUTION_INTENT_VALIDATE_TOOL_NAME}': ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.data.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const authorizer = getExecutionAuthorizer(resolvedRoot, delegate);

      const result = await authorizer.validateExecutionIntent(parsed.data);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(result), null, 2),
          },
        ],
      };
    },
  };
}

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerExecutionIntentTools(server: McpServer): void {
  const tools = [
    createExecutionIntentValidateTool(server.delegate),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
