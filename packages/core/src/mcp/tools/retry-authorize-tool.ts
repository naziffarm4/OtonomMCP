/**
 * Task Retry Authorization MCP Tool (Phase 13 TASK-P13-02, TASK-P13-04)
 *
 * Exposes the Bounded Task Retry Authorization & State Transition Bridge as an authoritative,
 * secure MCP tool: `aidm.task.retry` (and backward-compatible alias `aidm.task.authorizeRetry`).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. AUTHORIZATION & TRANSITION BOUNDARY ONLY: Never invokes Antigravity or dispatches execution.
 * 2. ZERO EXECUTOR TRUST: Accepts only verified SystemExecutionEvidence. Caller fabricated claims rejected.
 * 3. NO FABRICATED VERIFICATION: Rejects any caller claims attempting to bypass verification or budget.
 * 4. STRICT BUDGET: Rejects retry if attempt >= max_attempts.
 * 5. NO COMPLETED RETRY: Rejects retry for ACCEPTED or completed tasks.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import {
  RetryAuthorizationService,
  type RetryAuthorizationServiceOptions,
} from '../../recovery/retry-authorization-service.js';
import {
  type RetryAuthorizationInput,
  RetryAuthorizationInputZodSchema,
} from '../../recovery/retry-authorization-types.js';
import {
  RetryAuthorizationError,
  RetrySecurityViolationError,
  RetryBindingMismatchError,
} from '../../recovery/retry-authorization-errors.js';
import { assertNoForbiddenEvidenceFields } from '../../evidence/system-execution-evidence.js';

export const AIDM_TASK_RETRY_TOOL_NAME = 'aidm.task.retry';
export const AIDM_TASK_AUTHORIZE_RETRY_TOOL_NAME = 'aidm.task.authorizeRetry';

const FORBIDDEN_MCP_RETRY_CLAIMS = [
  'verified',
  'systemAccepted',
  'retryApproved',
  'qaPassed',
  'taskCompleted',
  'systemApproved',
  'accepted',
  'completed',
];

export const retryAuthorizeToolDefinition: McpToolDefinition = {
  name: AIDM_TASK_RETRY_TOOL_NAME,
  description:
    'Authorizes and performs bounded task retry state transition following a verified execution failure and RETRY policy decision. Does NOT execute tasks.',
  inputSchema: {
    type: 'object',
    required: ['evidence'],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier for cross-project safety check.',
      },
      expectedProjectId: {
        type: 'string',
        description: 'Optional canonical project identifier alias.',
      },
      taskId: {
        type: 'string',
        description: 'Optional task identifier asserting target task.',
      },
      evidence: {
        type: 'object',
        description:
          'Canonical SystemExecutionEvidence object with verificationDecision REJECT.',
      },
      decision: {
        type: 'object',
        description:
          'Optional canonical RecoveryPolicyDecision object from P13-01.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Optional active Director session ID.',
      },
      contextFingerprint: {
        type: 'string',
        description: 'Optional context fingerprint assertion.',
      },
      understandingRevision: {
        type: 'number',
        description: 'Optional understanding revision assertion.',
      },
      approvalPackageRevision: {
        type: 'number',
        description: 'Optional approval package revision assertion.',
      },
    },
  },
};

export function createRetryAuthorizeTool(options: {
  toolName?: string;
  retryService?: RetryAuthorizationService;
  serviceOptions?: RetryAuthorizationServiceOptions;
  defaultDelegate?: McpOrchestratorDelegate;
} = {}): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const toolName = options.toolName ?? AIDM_TASK_RETRY_TOOL_NAME;

  return {
    definition: {
      ...retryAuthorizeToolDefinition,
      name: toolName,
    },
    handler: async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
      try {
        if (!rawArgs || typeof rawArgs !== 'object') {
          throw new McpInvalidRequestError('Arguments must be a valid non-null object');
        }

        // Security check for forbidden caller claims
        for (const forbidden of FORBIDDEN_MCP_RETRY_CLAIMS) {
          if (forbidden in rawArgs && rawArgs[forbidden] !== undefined) {
            throw new RetrySecurityViolationError(
              `Forbidden caller claim '${forbidden}' detected in retry authorization arguments. Fabricated claims are rejected.`,
              { forbiddenField: forbidden }
            );
          }
        }

        // Check inside evidence as well
        if (rawArgs.evidence && typeof rawArgs.evidence === 'object') {
          assertNoForbiddenEvidenceFields(rawArgs.evidence);

          const ev = rawArgs.evidence as Record<string, unknown>;
          if (typeof rawArgs.taskId === 'string' && rawArgs.taskId.length > 0 && ev.taskId && ev.taskId !== rawArgs.taskId) {
            throw new RetryBindingMismatchError(
              `Task ID mismatch: evidence targets '${ev.taskId}', but input specifies '${rawArgs.taskId}'`,
              { evidenceTaskId: ev.taskId, inputTaskId: rawArgs.taskId }
            );
          }
          if (typeof rawArgs.requestId === 'string' && rawArgs.requestId.length > 0 && ev.requestId && ev.requestId !== rawArgs.requestId) {
            throw new RetryBindingMismatchError(
              `Request ID mismatch: evidence references '${ev.requestId}', but input specifies '${rawArgs.requestId}'`,
              { evidenceRequestId: ev.requestId, inputRequestId: rawArgs.requestId }
            );
          }
          if (typeof rawArgs.evidenceId === 'string' && rawArgs.evidenceId.length > 0 && ev.evidenceId && ev.evidenceId !== rawArgs.evidenceId) {
            throw new RetryBindingMismatchError(
              `Evidence ID mismatch: evidence ID is '${ev.evidenceId}', but input specifies '${rawArgs.evidenceId}'`,
              { evidenceId: ev.evidenceId, inputEvidenceId: rawArgs.evidenceId }
            );
          }
        }

        const parsed = RetryAuthorizationInputZodSchema.safeParse(rawArgs);
        if (!parsed.success) {
          throw new McpInvalidRequestError(
            `Invalid retry authorization request: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
            { issues: parsed.error.issues }
          );
        }

        const delegate = context.delegate ?? options.defaultDelegate;
        const resolvedRoot =
          parsed.data.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

        const resolvedExpectedProject =
          parsed.data.expectedProjectId ??
          (typeof rawArgs.projectId === 'string' ? rawArgs.projectId : undefined);

        const service =
          options.retryService ??
          new RetryAuthorizationService({
            workspaceRoot: resolvedRoot,
            specStore: delegate?.specStore,
            dagEngine: delegate?.dagEngine,
            historyManager: delegate?.historyManager,
            approvalStore: delegate?.approvalStore,
            directorSessionStore: delegate?.directorSessionStore,
            expectedProjectId: resolvedExpectedProject,
            ...options.serviceOptions,
          });

        const outcome = await service.authorizeRetry({
          ...parsed.data,
          expectedProjectId: resolvedExpectedProject,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(outcome), null, 2),
            },
          ],
          isError: false,
        };
      } catch (err: unknown) {
        if (err instanceof RetryAuthorizationError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  sanitizeMcpPayload({
                    success: false,
                    code: err.code,
                    message: err.message,
                    details: err.details,
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        if (err instanceof McpInvalidRequestError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  sanitizeMcpPayload({
                    success: false,
                    code: err.code,
                    message: err.message,
                    details: err.details,
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sanitizeMcpPayload({
                  success: false,
                  code: 'ERR_RETRY_AUTHORIZATION_FAILED',
                  message,
                }),
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    },
  };
}

export const createTaskRetryTool = createRetryAuthorizeTool;

export function registerRetryAuthorizeTools(
  server: McpServer,
  options: { retryService?: RetryAuthorizationService } = {}
): void {
  // Register primary required tool: aidm.task.retry
  const primary = createRetryAuthorizeTool({
    toolName: AIDM_TASK_RETRY_TOOL_NAME,
    retryService: options.retryService,
    defaultDelegate: server.delegate,
  });
  server.registerTool(primary.definition, primary.handler);

  // Register backward-compatible alias: aidm.task.authorizeRetry
  const alias = createRetryAuthorizeTool({
    toolName: AIDM_TASK_AUTHORIZE_RETRY_TOOL_NAME,
    retryService: options.retryService,
    defaultDelegate: server.delegate,
  });
  server.registerTool(alias.definition, alias.handler);
}
