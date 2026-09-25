/**
 * Execution State Integration MCP Tool (Phase 10 TASK-P10-05)
 *
 * Exposes the Verified Execution State Integration Bridge as an authoritative,
 * secure MCP tool: `aidm.execution.integrate`.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. INTEGRATION BOUNDARY ONLY: Never invokes Antigravity or dispatches execution.
 * 2. ZERO EXECUTOR TRUST: Accepts only verified P10-04 result envelope or SystemExecutionEvidence.
 * 3. NO FABRICATED VERIFICATION: Rejects any caller claims attempting to bypass verification
 *    (e.g., verified, qaPassed, systemAccepted, taskCompleted, systemApproved).
 * 4. COMPLETE EXECUTION BINDING: Requires complete, matching executionBinding.
 * 5. NO ARBITRARY STATE MUTATION: Integrates exclusively via ExecutionStateIntegrator.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler } from '../mcp-types.js';
import type { McpServer } from '../mcp-server.js';
import {
  type VerifiedExecutionResult,
  VerifiedExecutionResultZodSchema,
  assertNoForbiddenIntegrationFields,
} from '../../execution-integration/execution-integration-types.js';
import {
  ExecutionStateIntegrator,
  type ExecutionIntegrationServiceOptions,
} from '../../execution-integration/execution-integration-service.js';
import {
  SystemExecutionEvidenceZodSchema,
  type SystemExecutionEvidence,
} from '../../evidence/system-execution-evidence.js';
import { AidmError } from '../../errors/aidm-error.js';
import {
  ExecutionIntegrationError,
  ExecutionIntegrationSecurityViolationError,
  ExecutionIntegrationValidationError,
  ExecutionIntegrationBindingMismatchError,
  ExecutionIntegrationStaleResultError,
  ExecutionIntegrationConflictError,
} from '../../director/director-errors.js';

export const AIDM_EXECUTION_INTEGRATE_TOOL_NAME = 'aidm.execution.integrate';

const FORBIDDEN_MCP_CLAIMS = [
  'verified',
  'qaPassed',
  'systemAccepted',
  'taskCompleted',
  'systemApproved',
  'accepted',
  'completed',
];

export const ExecutionIntegrateInputZodSchema = z.union([
  z.object({
    result: VerifiedExecutionResultZodSchema,
  }),
  z.object({
    evidence: SystemExecutionEvidenceZodSchema,
  }),
  SystemExecutionEvidenceZodSchema,
]);

export function createExecutionIntegrateTool(options: {
  integrationService?: ExecutionStateIntegrator;
  serviceOptions?: ExecutionIntegrationServiceOptions;
} = {}): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const service =
    options.integrationService ?? new ExecutionStateIntegrator(options.serviceOptions);

  const definition: McpToolDefinition = {
    name: AIDM_EXECUTION_INTEGRATE_TOOL_NAME,
    description:
      'Authoritatively integrates an independently verified P10-04 execution result into DurableState and History audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        evidence: {
          type: 'object',
          description:
            'Canonical P10-04 SystemExecutionEvidence object with verificationDecision and verified execution facts.',
        },
        result: {
          type: 'object',
          description:
            'Canonical VerifiedExecutionResult envelope containing P10-04 SystemExecutionEvidence and ExecutionBinding.',
        },
      },
    },
  };

  const handler: McpToolHandler = async (args, _context) => {
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
                  message: 'Arguments must be a valid object containing verified evidence or result',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const input = args as Record<string, unknown>;

      // SECURITY GUARD: Reject fabricated verification claims in top-level args
      for (const forbidden of FORBIDDEN_MCP_CLAIMS) {
        if (forbidden in input && input[forbidden] !== undefined) {
          throw new ExecutionIntegrationSecurityViolationError(
            `Forbidden caller claim '${forbidden}' detected in MCP arguments. Fabricated verification flags are rejected.`,
            { forbiddenField: forbidden }
          );
        }
      }

      // Check forbidden claims in nested objects
      assertNoForbiddenIntegrationFields(input);

      // Determine candidate payload
      let candidate: unknown;
      if (input.result) {
        candidate = input.result;
      } else if (input.evidence) {
        candidate = input.evidence;
      } else {
        candidate = input;
      }

      const outcome = await service.integrate(candidate);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: outcome.success,
                integrationKey: outcome.integrationKey,
                verificationDecision: outcome.verificationDecision,
                taskStatus: outcome.taskStatus,
                taskId: outcome.taskId,
                taskRevision: outcome.taskRevision,
                integratedAt: outcome.integratedAt,
                isDuplicate: outcome.isDuplicate,
                affectedReadyTasks: outcome.affectedReadyTasks,
                message: outcome.message,
              },
              null,
              2
            ),
          },
        ],
        isError: false,
      };
    } catch (err: unknown) {
      const code =
        err instanceof AidmError
          ? err.code
          : err instanceof Error && 'code' in err
            ? (err as { code: string }).code
            : 'ERR_EXECUTION_INTEGRATION_FAILED';

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

/**
 * Registers the `aidm.execution.integrate` tool on an MCP server instance.
 */
export function registerExecutionIntegrateTools(
  server: McpServer,
  options: { integrationService?: ExecutionStateIntegrator } = {}
): void {
  const { definition, handler } = createExecutionIntegrateTool(options);
  server.registerTool(definition, handler);
}
