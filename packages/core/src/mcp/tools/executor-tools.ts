/**
 * Executor Dispatch MCP Tools (Phase 10 TASK-P10-03)
 *
 * Exposes the Antigravity Executor Adapter Boundary as a safe, read-only/control-plane
 * MCP tool without allowing arbitrary shell command execution or internal state mutation.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ONLY EXECUTIONREQUEST: Accepts only validated ExecutionRequest objects.
 * 2. NO ARBITRARY SHELL INVOCATION: Rejects raw shell commands or free-form execution requests.
 * 3. NO INTERNAL STATE MUTATION: Does NOT mutate DurableStateManager, Task DAG, SpecStore, or ApprovalStore.
 * 4. RAW OUTCOME ONLY: Returns RawExecutorOutcome; never creates or claims SystemVerifiedEvidence.
 */

import { z } from 'zod';
import type { McpServer } from '../mcp-server.js';
import type { McpToolDefinition, McpToolHandler } from '../mcp-types.js';
import {
  type ExecutionRequest,
  ExecutionRequestZodSchema,
} from '../../executor-bridge/execution-request-types.js';
import { AntigravityAdapter } from '../../executor-bridge/antigravity-adapter.js';
import { type RawExecutorOutcome } from '../../executor-bridge/raw-executor-outcome.js';
import { AidmError } from '../../errors/aidm-error.js';
import {
  ExecutorPreconditionError,
  ExecutorSecurityViolationError,
  ExecutionRequestValidationError,
} from '../../director/director-errors.js';

export const AIDM_EXECUTOR_EXECUTE_TOOL_NAME = 'aidm.executor.execute';

export const ExecutorExecuteInputZodSchema = z.object({
  request: ExecutionRequestZodSchema,
});

export type ExecutorExecuteInput = z.infer<typeof ExecutorExecuteInputZodSchema>;

export function createExecutorExecuteTool(): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const definition: McpToolDefinition = {
    name: AIDM_EXECUTOR_EXECUTE_TOOL_NAME,
    description:
      'Dispatches an authorized, deterministic ExecutionRequest to the ExecutorPort and returns the RawExecutorOutcome without mutating task, DAG, FSM, or approval state.',
    inputSchema: {
      type: 'object',
      required: ['request'],
      properties: {
        request: {
          type: 'object',
          description: 'Authorized ExecutionRequest conforming to P10-02 contract',
        },
      },
    },
  };

  const handler: McpToolHandler = async (args, context) => {
    try {
      if (!args || typeof args !== 'object') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  code: 'ERR_INVALID_ARGUMENTS',
                  message: 'Arguments must be an object with a valid "request" field',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // 1. Validate input structure with Zod schema
      const parseResult = ExecutorExecuteInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  code: 'ERR_EXECUTION_REQUEST_VALIDATION',
                  message: `ExecutionRequest validation failed: ${parseResult.error.issues[0]?.message ?? 'invalid request'}`,
                  details: { issues: parseResult.error.issues },
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const { request } = parseResult.data;

      // 2. Resolve authoritative ExecutorPort
      const executorPort =
        context.delegate?.executorPort ??
        new AntigravityAdapter({
          workspaceRoot: context.delegate?.projectRoot,
        });

      // 3. Dispatch execution through the executor adapter boundary
      const outcome: RawExecutorOutcome = await executorPort.execute(request as ExecutionRequest);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: outcome.status === 'SUCCESS',
                status: outcome.status,
                outcome,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: unknown) {
      const code =
        err instanceof AidmError
          ? err.code
          : err instanceof ExecutorPreconditionError
          ? 'ERR_EXECUTOR_PRECONDITION'
          : err instanceof ExecutorSecurityViolationError
          ? 'ERR_EXECUTOR_SECURITY_VIOLATION'
          : err instanceof ExecutionRequestValidationError
          ? 'ERR_EXECUTION_REQUEST_VALIDATION'
          : 'ERR_EXECUTOR_EXECUTION_FAILED';

      const message = err instanceof Error ? err.message : String(err);
      const details = err instanceof AidmError ? err.details : undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                code,
                message,
                details,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  return { definition, handler };
}

export function registerExecutorTools(server: McpServer): void {
  const tool = createExecutorExecuteTool();
  server.registerTool(tool.definition, tool.handler);
}
