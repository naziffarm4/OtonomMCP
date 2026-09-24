/**
 * System Evidence Verification MCP Tool (Phase 10 TASK-P10-04)
 *
 * Exposes the System Evidence Collection & Verification Pipeline as an authoritative,
 * secure MCP tool: `aidm.evidence.verify`.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO CALLER-FABRICATED EVIDENCE: Callers CANNOT submit pre-fabricated SystemVerifiedEvidence.
 * 2. ZERO CALLER-FABRICATED DECISIONS: Callers CANNOT supply or override verificationDecision.
 * 3. EXPLICIT INPUT: Accepts only valid ExecutionRequest and RawExecutorOutcome.
 * 4. SYSTEM EXECUTION ONLY: Independent verification is strictly performed by the SystemEvidenceCollector.
 * 5. ZERO MUTATION: Does NOT mutate DurableStateManager, Task DAG, SpecStore, or ApprovalStore.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler } from '../mcp-types.js';
import type { McpServer } from '../mcp-server.js';
import {
  type ExecutionRequest,
  ExecutionRequestZodSchema,
} from '../../executor-bridge/execution-request-types.js';
import {
  type RawExecutorOutcome,
  RawExecutorOutcomeZodSchema,
} from '../../executor-bridge/raw-executor-outcome.js';
import { SystemEvidenceCollector } from '../../evidence/execution-evidence-collector.js';
import { AidmError } from '../../errors/aidm-error.js';
import {
  SystemEvidenceError,
  SystemEvidenceSecurityViolationError,
  SystemEvidenceBindingMismatchError,
} from '../../director/director-errors.js';

export const AIDM_EVIDENCE_VERIFY_TOOL_NAME = 'aidm.evidence.verify';

export const EvidenceVerifyInputZodSchema = z
  .object({
    request: ExecutionRequestZodSchema,
    outcome: RawExecutorOutcomeZodSchema,
    strictFileScope: z.boolean().optional(),
    throwOnBindingMismatch: z.boolean().optional(),
  })
  .strict();

export type EvidenceVerifyInput = z.infer<typeof EvidenceVerifyInputZodSchema>;

export function createEvidenceVerifyTool(options: {
  evidenceCollector?: SystemEvidenceCollector;
} = {}): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const collector = options.evidenceCollector ?? new SystemEvidenceCollector();

  const definition: McpToolDefinition = {
    name: AIDM_EVIDENCE_VERIFY_TOOL_NAME,
    description:
      'Independently collects repository evidence and evaluates RawExecutorOutcome against ExecutionRequest criteria to determine ACCEPT, REJECT, or BLOCK.',
    inputSchema: {
      type: 'object',
      required: ['request', 'outcome'],
      properties: {
        request: {
          type: 'object',
          description: 'Authorized ExecutionRequest conforming to P10-02 contract',
        },
        outcome: {
          type: 'object',
          description: 'RawExecutorOutcome produced by ExecutorPort conforming to P10-03 contract',
        },
        strictFileScope: {
          type: 'boolean',
          description: 'Whether unexpected file modifications should strictly trigger REJECT',
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
                  message: 'Arguments must be an object with valid "request" and "outcome" fields',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // Check if caller attempted to inject fabricated verification or decision
      const rawArgs = args as Record<string, unknown>;
      if ('evidence' in rawArgs || 'verificationDecision' in rawArgs || 'decision' in rawArgs || 'systemVerifiedEvidence' in rawArgs) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  code: 'ERR_FABRICATED_EVIDENCE_REJECTED',
                  message: 'Callers cannot submit fabricated evidence or pre-determined verification decisions. Evidence must be independently collected by the system.',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // 1. Validate inputs via Zod schema
      const parseResult = EvidenceVerifyInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  code: 'ERR_EVIDENCE_VERIFY_INPUT_VALIDATION',
                  message: `Evidence verification input validation failed: ${parseResult.error.issues[0]?.message ?? 'invalid input'}`,
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

      const input = parseResult.data;

      // 2. Execute authoritative independent verification pipeline
      const evidence = await collector.collectAndVerify(
        input.request as ExecutionRequest,
        input.outcome as RawExecutorOutcome,
        {
          strictFileScope: input.strictFileScope,
          throwOnBindingMismatch: input.throwOnBindingMismatch,
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                evidenceId: evidence.evidenceId,
                requestId: evidence.requestId,
                verificationDecision: evidence.verificationDecision,
                evidence,
              },
              null,
              2
            ),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      const code =
        error instanceof AidmError
          ? error.code
          : 'ERR_SYSTEM_EVIDENCE_VERIFICATION_FAILED';
      const message = error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                code,
                message,
                details: error instanceof AidmError ? error.details : undefined,
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

export function registerEvidenceVerifyTools(
  server: McpServer,
  collector?: SystemEvidenceCollector
): void {
  const tool = createEvidenceVerifyTool({ evidenceCollector: collector });
  server.registerTool(tool.definition, tool.handler);
}
