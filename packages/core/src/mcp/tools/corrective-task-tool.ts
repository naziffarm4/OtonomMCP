/**
 * Governed Corrective Task Lineage MCP Tool (Phase 13 TASK-P13-03, TASK-P13-04)
 *
 * Exposes the Governed Corrective Task Lineage & DAG Augmentation boundary as an authoritative,
 * secure MCP tool: `aidm.task.replan` (and backward-compatible alias `aidm.task.createCorrective`).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. GOVERNED BOUNDARY ONLY: Never invokes Antigravity or dispatches execution.
 * 2. ZERO EXECUTOR TRUST: Accepts only verified SystemExecutionEvidence. Caller fabricated claims rejected.
 * 3. NO FABRICATED VERIFICATION: Rejects any caller claims attempting to bypass verification or governance.
 * 4. STRICT REPLAN POLICY: Requires REPLAN strategy and replanAllowed === true.
 * 5. ATOMIC PERSISTENCE: Integrates through TaskDagEngine and persists atomically in SpecStore.
 */

import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import {
  CorrectiveTaskService,
  type CorrectiveTaskServiceOptions,
} from '../../recovery/corrective-task-service.js';
import {
  CreateCorrectiveTaskInputZodSchema,
} from '../../recovery/corrective-task-types.js';
import {
  CorrectiveTaskError,
  CorrectiveTaskSecurityViolationError,
  CorrectiveTaskBindingMismatchError,
} from '../../recovery/corrective-task-errors.js';
import { assertNoForbiddenEvidenceFields } from '../../evidence/system-execution-evidence.js';

export const AIDM_TASK_REPLAN_TOOL_NAME = 'aidm.task.replan';
export const AIDM_TASK_CREATE_CORRECTIVE_TOOL_NAME = 'aidm.task.createCorrective';

const FORBIDDEN_MCP_CORRECTIVE_CLAIMS = [
  'verified',
  'systemAccepted',
  'replanApproved',
  'qaPassed',
  'taskCompleted',
  'systemApproved',
  'accepted',
  'completed',
  'replan',
];

export const correctiveTaskToolDefinition: McpToolDefinition = {
  name: AIDM_TASK_REPLAN_TOOL_NAME,
  description:
    'Creates a governed corrective task with explicit lineage to a failed task following a verified execution failure and REPLAN policy decision. Augments the DAG safely without executing tasks.',
  inputSchema: {
    type: 'object',
    required: ['evidence'],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      expectedProjectId: {
        type: 'string',
        description: 'Optional canonical project identifier for cross-project safety check.',
      },
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier alias.',
      },
      taskId: {
        type: 'string',
        description: 'Optional task identifier asserting target task.',
      },
      evidence: {
        type: 'object',
        description: 'Canonical SystemExecutionEvidence object with verificationDecision REJECT.',
      },
      decision: {
        type: 'object',
        description: 'Optional canonical RecoveryPolicyDecision object from P13-01 with strategy REPLAN.',
      },
      proposal: {
        type: 'object',
        description: 'Optional candidate proposal augmenting title, description, criteria, or scope.',
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

export function createCorrectiveTaskTool(options: {
  toolName?: string;
  correctiveService?: CorrectiveTaskService;
  serviceOptions?: CorrectiveTaskServiceOptions;
  defaultDelegate?: McpOrchestratorDelegate;
} = {}): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const toolName = options.toolName ?? AIDM_TASK_REPLAN_TOOL_NAME;

  return {
    definition: {
      ...correctiveTaskToolDefinition,
      name: toolName,
    },
    handler: async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
      try {
        if (!rawArgs || typeof rawArgs !== 'object') {
          throw new McpInvalidRequestError('Arguments must be a valid non-null object');
        }

        // Security check for forbidden caller claims
        for (const forbidden of FORBIDDEN_MCP_CORRECTIVE_CLAIMS) {
          if (forbidden in rawArgs && rawArgs[forbidden] !== undefined) {
            throw new CorrectiveTaskSecurityViolationError(
              `Forbidden caller claim '${forbidden}' detected in corrective task creation arguments. Fabricated claims are rejected.`,
              { forbiddenField: forbidden }
            );
          }
        }

        // Check inside evidence as well
        if (rawArgs.evidence && typeof rawArgs.evidence === 'object') {
          assertNoForbiddenEvidenceFields(rawArgs.evidence);

          const ev = rawArgs.evidence as Record<string, unknown>;
          if (typeof rawArgs.taskId === 'string' && rawArgs.taskId.length > 0 && ev.taskId && ev.taskId !== rawArgs.taskId) {
            throw new CorrectiveTaskBindingMismatchError(
              `Task ID mismatch: evidence targets '${ev.taskId}', but input specifies '${rawArgs.taskId}'`,
              { evidenceTaskId: ev.taskId, inputTaskId: rawArgs.taskId }
            );
          }
          if (typeof rawArgs.requestId === 'string' && rawArgs.requestId.length > 0 && ev.requestId && ev.requestId !== rawArgs.requestId) {
            throw new CorrectiveTaskBindingMismatchError(
              `Request ID mismatch: evidence references '${ev.requestId}', but input specifies '${rawArgs.requestId}'`,
              { evidenceRequestId: ev.requestId, inputRequestId: rawArgs.requestId }
            );
          }
          if (typeof rawArgs.evidenceId === 'string' && rawArgs.evidenceId.length > 0 && ev.evidenceId && ev.evidenceId !== rawArgs.evidenceId) {
            throw new CorrectiveTaskBindingMismatchError(
              `Evidence ID mismatch: evidence ID is '${ev.evidenceId}', but input specifies '${rawArgs.evidenceId}'`,
              { evidenceId: ev.evidenceId, inputEvidenceId: rawArgs.evidenceId }
            );
          }
        }

        const parsed = CreateCorrectiveTaskInputZodSchema.safeParse(rawArgs);
        if (!parsed.success) {
          throw new McpInvalidRequestError(
            `Invalid corrective task request: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
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
          options.correctiveService ??
          new CorrectiveTaskService({
            workspaceRoot: resolvedRoot,
            specStore: delegate?.specStore,
            dagEngine: delegate?.dagEngine,
            historyManager: delegate?.historyManager,
            approvalStore: delegate?.approvalStore,
            directorSessionStore: delegate?.directorSessionStore,
            expectedProjectId: resolvedExpectedProject,
            ...options.serviceOptions,
          });

        const outcome = await service.createCorrectiveTask({
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
        if (err instanceof CorrectiveTaskError) {
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
                  code: 'ERR_CORRECTIVE_TASK_FAILED',
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

export const createTaskReplanTool = createCorrectiveTaskTool;

export function registerCorrectiveTaskTools(
  server: McpServer,
  options: { correctiveService?: CorrectiveTaskService } = {}
): void {
  // Register primary required tool: aidm.task.replan
  const primary = createCorrectiveTaskTool({
    toolName: AIDM_TASK_REPLAN_TOOL_NAME,
    correctiveService: options.correctiveService,
    defaultDelegate: server.delegate,
  });
  server.registerTool(primary.definition, primary.handler);

  // Register backward-compatible alias: aidm.task.createCorrective
  const alias = createCorrectiveTaskTool({
    toolName: AIDM_TASK_CREATE_CORRECTIVE_TOOL_NAME,
    correctiveService: options.correctiveService,
    defaultDelegate: server.delegate,
  });
  server.registerTool(alias.definition, alias.handler);
}
