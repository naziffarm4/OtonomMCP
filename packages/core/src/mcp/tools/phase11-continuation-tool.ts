/**
 * Phase 11 Controlled Continuation MCP Tool (Phase 11 TASK-P11-02)
 *
 * Implements the authoritative continuation request tool:
 * - phase11.requestContinue
 *
 * Releases an execution continuation checkpoint (WAITING -> NONE)
 * after verification ACCEPT and durable state integration under MANUAL policy.
 *
 * STRICT GOVERNANCE RULES:
 * 1. Actor must strictly be human ('PRODUCT_OWNER' or 'USER').
 * 2. Rejects DIRECTOR, EXECUTOR, ANTIGRAVITY, SYSTEM, ORCHESTRATOR.
 * 3. Does NOT invoke Antigravity execution.
 * 4. Does NOT create ExecutionIntent or ExecutionRequest.
 * 5. Does NOT invoke DirectorDecisionEngine directly.
 * 6. Does NOT mutate Task DAG.
 * 7. Idempotency: Re-issuing when continuationState === 'NONE' returns
 *    success: false (or CONTINUATION_NOT_NEEDED) with explanatory message without error.
 * 8. Records HistoryManager events:
 *    - PHASE11_CONTINUATION_REQUESTED
 *    - PHASE11_CONTINUATION_ACCEPTED (on successful WAITING -> NONE)
 *    - PHASE11_CONTINUATION_REJECTED (on validation failure)
 */

import { z } from 'zod';
import { Actor } from '../../actors.js';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { HumanApprovalEngine } from '../../director/human-approval-engine.js';
import { DurableStateManager } from '../../storage/durable-state.js';
import { HistoryManager } from '../../storage/history-manager.js';
import { ExecutionIntegrationLock } from '../../execution-integration/execution-integration-lock.js';
import {
  type ValidateContinuationRequestInput,
  ValidateContinuationRequestInputZodSchema,
} from '../../director/human-approval-types.js';

export const PHASE11_REQUEST_CONTINUE_TOOL_NAME = 'phase11.requestContinue';

export const phase11RequestContinueToolDefinition: McpToolDefinition = {
  name: PHASE11_REQUEST_CONTINUE_TOOL_NAME,
  description:
    'Authorizes continuation past an execution checkpoint under MANUAL policy. Releases WAITING continuationState to NONE without invoking Antigravity or mutating the Task DAG.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to workspace root. Defaults to current working directory.',
      },
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier for cross-project safety check.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Active Director session ID bound to this execution continuation checkpoint.',
      },
      contextFingerprint: {
        type: 'string',
        description: 'Current non-stale context snapshot logical fingerprint.',
      },
      understandingRevision: {
        type: 'number',
        description: 'Optional authoritative understanding revision baseline.',
      },
      approvalPackageRevision: {
        type: 'number',
        description: 'Optional bound human approval package revision.',
      },
      actor: {
        type: 'string',
        description: "Must strictly be a human actor identifier (not 'DIRECTOR', 'EXECUTOR', or 'ANTIGRAVITY').",
      },
      actorRole: {
        type: 'string',
        description: "Must strictly be 'PRODUCT_OWNER' or 'USER'.",
      },
      comment: {
        type: 'string',
        description: 'Optional human operator comment explaining the continuation decision.',
      },
    },
    required: ['directorSessionId', 'contextFingerprint', 'actor', 'actorRole'],
  },
};

export function createPhase11ContinuationToolHandler(
  serverRoot?: string,
  serverDelegate?: McpOrchestratorDelegate
): McpToolHandler {
  return async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
    const delegate = context.delegate ?? serverDelegate;
    const resolvedRoot =
      (rawArgs.workspaceRoot as string | undefined) ??
      serverRoot ??
      delegate?.projectRoot ??
      process.cwd();

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: resolvedRoot,
      delegate,
    });

    const durableStateManager = new DurableStateManager({
      baseDir: resolvedRoot,
    });

    const historyManager =
      delegate?.historyManager ??
      new HistoryManager({
        baseDir: resolvedRoot,
      });

    const now = new Date().toISOString();

    // 1. Zod input schema validation
    const parsed = ValidateContinuationRequestInputZodSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const errMessage = `Invalid continuation request input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`;
      try {
        await historyManager.appendEvent({
          timestamp: now,
          eventType: 'PHASE11_CONTINUATION_REJECTED',
          actor: Actor.ORCHESTRATOR,
          payload: {
            reason: errMessage,
            code: 'VALIDATION_ERROR',
            rawArgs,
          },
        });
      } catch {
        // ignore history append failures in error handler
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sanitizeMcpPayload({
                success: false,
                code: 'VALIDATION_ERROR',
                message: errMessage,
                details: { issues: parsed.error.issues },
              }),
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    const input = parsed.data as ValidateContinuationRequestInput;

    // Record request event in HistoryManager
    try {
      await historyManager.appendEvent({
        timestamp: now,
        eventType: 'PHASE11_CONTINUATION_REQUESTED',
        actor: Actor.USER,
        payload: {
          directorSessionId: input.directorSessionId,
          contextFingerprint: input.contextFingerprint,
          actor: input.actor,
          actorRole: input.actorRole,
          comment: input.comment,
        },
      });
    } catch {
      // non-fatal
    }

    const lock = new ExecutionIntegrationLock({
      baseDir: resolvedRoot,
    });

    return await lock.withLock(async () => {
      // 2. Validate using HumanApprovalEngine continuation validation
      const validation = await humanEngine.validateContinuationRequest(input);

      if (!validation.isValid) {
        // Idempotency: If continuationState is already 'NONE', return idempotent no-op without error
        if (validation.code === 'CONTINUATION_NOT_NEEDED') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  sanitizeMcpPayload({
                    success: false,
                    code: 'CONTINUATION_NOT_NEEDED',
                    message: validation.message,
                    continuationState: 'NONE',
                    isIdempotent: true,
                    details: validation.details,
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: false,
          };
        }

        // Rejection / validation error
        try {
          await historyManager.appendEvent({
            timestamp: now,
            eventType: 'PHASE11_CONTINUATION_REJECTED',
            actor: Actor.ORCHESTRATOR,
            payload: {
              reason: validation.message,
              code: validation.code,
              details: validation.details,
            },
          });
        } catch {
          // non-fatal
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sanitizeMcpPayload({
                  success: false,
                  code: validation.code,
                  message: validation.message,
                  details: validation.details,
                }),
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // 3. Atomically transition continuationState from WAITING to NONE
      const currentState = await durableStateManager.load();
      if (!currentState || currentState.continuationState !== 'WAITING') {
        // Check again if already transitioned
        if (currentState?.continuationState === 'NONE') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  sanitizeMcpPayload({
                    success: false,
                    code: 'CONTINUATION_NOT_NEEDED',
                    message: 'Continuation is not needed: checkpoint has already been cleared to NONE.',
                    continuationState: 'NONE',
                    isIdempotent: true,
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: false,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sanitizeMcpPayload({
                  success: false,
                  code: 'CONTINUATION_NOT_WAITING',
                  message: `Cannot release checkpoint: state is not WAITING (${currentState?.continuationState ?? 'null'}).`,
                }),
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const updatedState = {
        ...currentState,
        continuationState: 'NONE' as const,
        updatedAt: now,
      };

      await durableStateManager.save(updatedState);

      // 4. Record PHASE11_CONTINUATION_ACCEPTED audit event
      try {
        await historyManager.appendEvent({
          timestamp: now,
          eventType: 'PHASE11_CONTINUATION_ACCEPTED',
          actor: Actor.ORCHESTRATOR,
          payload: {
            directorSessionId: input.directorSessionId,
            contextFingerprint: input.contextFingerprint,
            actor: input.actor,
            actorRole: input.actorRole,
            continuationState: 'NONE',
            timestamp: now,
          },
        });
      } catch {
        // non-fatal
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sanitizeMcpPayload({
                success: true,
                code: 'VALID',
                message: 'Execution continuation authorized. Checkpoint released from WAITING to NONE.',
                continuationState: 'NONE',
                timestamp: now,
                details: {
                  directorSessionId: input.directorSessionId,
                  actor: input.actor,
                  actorRole: input.actorRole,
                },
              }),
              null,
              2
            ),
          },
        ],
        isError: false,
      };
    });
  };
}

export function registerPhase11ContinuationTools(server: McpServer): void {
  const handler = createPhase11ContinuationToolHandler(undefined, server.delegate);
  server.registerTool(phase11RequestContinueToolDefinition, handler);
}
