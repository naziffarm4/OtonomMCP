/**
 * Recovery Policy Evaluation MCP Tool (Phase 13 TASK-P13-04)
 *
 * Exposes the Failure Diagnosis & Recovery Policy Engine as an authoritative,
 * secure MCP tool: `aidm.recovery.evaluate`.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. PURE DECISION BOUNDARY: Never executes Antigravity, authorizes retry, mutates retry count,
 *    creates corrective tasks, modifies the DAG, or starts autonomous continuation.
 * 2. ZERO EXECUTOR TRUST: Accepts only verified SystemExecutionEvidence. Caller fabricated claims rejected.
 * 3. NO FABRICATED VERIFICATION: Rejects any caller claims attempting to bypass verification or governance.
 * 4. STRICT AUTHORITATIVE BINDINGS: Validates task existence, revision, project ID, session, and approval state.
 * 5. DETERMINISTIC & AUDITABLE: Emits RECOVERY_DECISION_EVALUATED to HistoryManager.
 * 6. SANITIZED PAYLOADS: Sanitizes output against secret leakage.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import {
  RecoveryPolicyEngine,
  type RecoveryPolicyEngineOptions,
} from '../../recovery/recovery-policy-engine.js';
import {
  type RecoveryPolicyDecision,
} from '../../recovery/recovery-policy-types.js';
import {
  RecoveryPolicyError,
  RecoveryPolicySecurityViolationError,
  RecoveryPolicyValidationError,
  RecoveryPolicyBindingMismatchError,
} from '../../recovery/recovery-policy-errors.js';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
  assertNoForbiddenEvidenceFields,
} from '../../evidence/system-execution-evidence.js';
import { SpecStore } from '../../storage/spec-store.js';
import { HistoryManager } from '../../storage/history-manager.js';
import { ApprovalStore } from '../../approval/approval-store.js';
import { DirectorSessionStore } from '../../director/director-session-store.js';
import type { TaskDefinition } from '../../task-engine/task-types.js';

export const AIDM_RECOVERY_EVALUATE_TOOL_NAME = 'aidm.recovery.evaluate';

const FORBIDDEN_MCP_RECOVERY_CLAIMS = [
  'verified',
  'systemAccepted',
  'retryApproved',
  'replanApproved',
  'qaPassed',
  'taskCompleted',
  'systemApproved',
  'accepted',
  'completed',
  'replan',
  'approved',
];

export const recoveryEvaluateToolDefinition: McpToolDefinition = {
  name: AIDM_RECOVERY_EVALUATE_TOOL_NAME,
  description:
    'Evaluates verified execution failure evidence against authoritative task state using P13-01 recovery policy. Pure decision boundary; does NOT mutate task state or execute tasks.',
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
        description: 'Canonical SystemExecutionEvidence object with verificationDecision REJECT or BLOCK.',
      },
      recordHistory: {
        type: 'boolean',
        description: 'Whether to record the evaluation decision in HistoryManager. Defaults to true.',
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

export interface CreateRecoveryEvaluateToolOptions {
  toolName?: string;
  recoveryPolicyEngine?: RecoveryPolicyEngine;
  serviceOptions?: RecoveryPolicyEngineOptions;
  specStore?: SpecStore;
  historyManager?: HistoryManager;
  approvalStore?: ApprovalStore;
  directorSessionStore?: DirectorSessionStore;
  defaultDelegate?: McpOrchestratorDelegate;
}

export function createRecoveryEvaluateTool(options: CreateRecoveryEvaluateToolOptions = {}): {
  definition: McpToolDefinition;
  handler: McpToolHandler;
} {
  const toolName = options.toolName ?? AIDM_RECOVERY_EVALUATE_TOOL_NAME;

  return {
    definition: {
      ...recoveryEvaluateToolDefinition,
      name: toolName,
    },
    handler: async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
      try {
        if (!rawArgs || typeof rawArgs !== 'object') {
          throw new McpInvalidRequestError('Arguments must be a valid non-null object');
        }

        // 1. Security check for forbidden caller claims
        for (const forbidden of FORBIDDEN_MCP_RECOVERY_CLAIMS) {
          if (forbidden in rawArgs && rawArgs[forbidden] !== undefined) {
            throw new RecoveryPolicySecurityViolationError(
              `Forbidden caller claim '${forbidden}' detected in recovery evaluation arguments. Fabricated claims are rejected.`,
              { forbiddenField: forbidden }
            );
          }
        }

        // 2. Validate evidence object presence
        const rawEvidence = rawArgs.evidence;
        if (!rawEvidence || typeof rawEvidence !== 'object') {
          throw new RecoveryPolicyValidationError('Input.evidence must be a valid non-null object');
        }

        // 3. Security check inside evidence
        try {
          assertNoForbiddenEvidenceFields(rawEvidence);
        } catch (err: any) {
          throw new RecoveryPolicySecurityViolationError(err.message, { cause: err });
        }

        // 4. Schema validation on evidence
        const evidenceParsed = SystemExecutionEvidenceZodSchema.safeParse(rawEvidence);
        if (!evidenceParsed.success) {
          const firstIssue = evidenceParsed.error.issues[0];
          const message = `Evidence schema validation failed: ${firstIssue?.message ?? evidenceParsed.error.message}`;
          if (firstIssue && (firstIssue.message.includes('Forbidden') || firstIssue.message.includes('fake'))) {
            throw new RecoveryPolicySecurityViolationError(message, { issues: evidenceParsed.error.issues });
          }
          throw new RecoveryPolicyValidationError(message, { issues: evidenceParsed.error.issues });
        }

        const evidence: SystemExecutionEvidence = evidenceParsed.data;

        // 5. Resolve environment & services
        const delegate = context.delegate ?? options.defaultDelegate;
        const resolvedRoot =
          (typeof rawArgs.workspaceRoot === 'string' && rawArgs.workspaceRoot.length > 0
            ? rawArgs.workspaceRoot
            : undefined) ??
          delegate?.projectRoot ??
          process.cwd();

        const expectedProject =
          (typeof rawArgs.expectedProjectId === 'string' && rawArgs.expectedProjectId.length > 0
            ? rawArgs.expectedProjectId
            : undefined) ??
          (typeof rawArgs.projectId === 'string' && rawArgs.projectId.length > 0
            ? rawArgs.projectId
            : undefined);

        // Cross-project check against evidence
        if (expectedProject && evidence.projectId !== expectedProject) {
          throw new RecoveryPolicyBindingMismatchError(
            `Project ID mismatch: evidence belongs to '${evidence.projectId}', but expected '${expectedProject}'`,
            { evidenceProjectId: evidence.projectId, expectedProjectId: expectedProject }
          );
        }

        // Cross-check taskId if caller provided one
        if (typeof rawArgs.taskId === 'string' && rawArgs.taskId.length > 0 && rawArgs.taskId !== evidence.taskId) {
          throw new RecoveryPolicyBindingMismatchError(
            `Task ID mismatch: evidence targets '${evidence.taskId}', but input specifies '${rawArgs.taskId}'`,
            { evidenceTaskId: evidence.taskId, inputTaskId: rawArgs.taskId }
          );
        }

        // Cross-check requestId if caller provided one
        if (typeof rawArgs.requestId === 'string' && rawArgs.requestId.length > 0 && rawArgs.requestId !== evidence.requestId) {
          throw new RecoveryPolicyBindingMismatchError(
            `Request ID mismatch: evidence references '${evidence.requestId}', but input specifies '${rawArgs.requestId}'`,
            { evidenceRequestId: evidence.requestId, inputRequestId: rawArgs.requestId }
          );
        }

        // Cross-check evidenceId if caller provided one
        if (typeof rawArgs.evidenceId === 'string' && rawArgs.evidenceId.length > 0 && rawArgs.evidenceId !== evidence.evidenceId) {
          throw new RecoveryPolicyBindingMismatchError(
            `Evidence ID mismatch: evidence ID is '${evidence.evidenceId}', but input specifies '${rawArgs.evidenceId}'`,
            { evidenceId: evidence.evidenceId, inputEvidenceId: rawArgs.evidenceId }
          );
        }

        // 6. Context Assertions
        if (rawArgs.contextFingerprint !== undefined && evidence.contextFingerprint !== rawArgs.contextFingerprint) {
          throw new RecoveryPolicyBindingMismatchError(
            `Context fingerprint mismatch: evidence has '${evidence.contextFingerprint}', expected '${rawArgs.contextFingerprint}'`,
            { actual: evidence.contextFingerprint, expected: rawArgs.contextFingerprint }
          );
        }

        if (rawArgs.understandingRevision !== undefined && evidence.understandingRevision !== rawArgs.understandingRevision) {
          throw new RecoveryPolicyBindingMismatchError(
            `Understanding revision mismatch: evidence has revision ${evidence.understandingRevision}, expected ${rawArgs.understandingRevision}`,
            { actual: evidence.understandingRevision, expected: rawArgs.understandingRevision }
          );
        }

        if (rawArgs.approvalPackageRevision !== undefined && evidence.approvalPackageRevision !== rawArgs.approvalPackageRevision) {
          throw new RecoveryPolicyBindingMismatchError(
            `Approval package revision mismatch: evidence has revision ${evidence.approvalPackageRevision}, expected ${rawArgs.approvalPackageRevision}`,
            { actual: evidence.approvalPackageRevision, expected: rawArgs.approvalPackageRevision }
          );
        }

        // 7. Load authoritative TaskDefinition from SpecStore
        const specStore =
          options.specStore ??
          delegate?.specStore ??
          new SpecStore({ baseDir: resolvedRoot });

        let specTasks: TaskDefinition[];
        try {
          specTasks = await specStore.loadTasks();
        } catch (err: any) {
          throw new RecoveryPolicyValidationError(`Failed to load tasks from SpecStore: ${err.message}`, {
            cause: err,
          });
        }

        const task = specTasks.find((t) => t.task_id === evidence.taskId);
        if (!task) {
          throw new RecoveryPolicyBindingMismatchError(
            `Task '${evidence.taskId}' not found in authoritative SpecStore`,
            { taskId: evidence.taskId }
          );
        }

        // Task Revision Validation
        const authoritativeRevision = (task.metadata?.revision as number) ?? 1;
        if (evidence.taskRevision !== authoritativeRevision) {
          throw new RecoveryPolicyBindingMismatchError(
            `Task revision mismatch: evidence specifies revision ${evidence.taskRevision}, but authoritative task revision in SpecStore is ${authoritativeRevision}`,
            { evidenceRevision: evidence.taskRevision, authoritativeRevision }
          );
        }

        // 8. DirectorSession check if provided
        if (typeof rawArgs.directorSessionId === 'string' && rawArgs.directorSessionId.length > 0) {
          const sessionStore =
            options.directorSessionStore ??
            delegate?.directorSessionStore ??
            new DirectorSessionStore({ baseDir: resolvedRoot });
          const session = await sessionStore.loadSession(rawArgs.directorSessionId);
          if (!session || session.status !== 'ACTIVE') {
            throw new RecoveryPolicyBindingMismatchError(
              `Director session '${rawArgs.directorSessionId}' is invalid or inactive`,
              { directorSessionId: rawArgs.directorSessionId }
            );
          }
          if (session.projectId !== evidence.projectId) {
            throw new RecoveryPolicyBindingMismatchError(
              `Director session project '${session.projectId}' does not match evidence project '${evidence.projectId}'`,
              { sessionProjectId: session.projectId, evidenceProjectId: evidence.projectId }
            );
          }
        }

        // 9. Authoritative Development Authorization Check
        const approvalStore =
          options.approvalStore ??
          delegate?.approvalStore ??
          new ApprovalStore({ baseDir: resolvedRoot });

        const activePkg = await approvalStore.getActivePackage();
        if (activePkg) {
          if (activePkg.projectId !== evidence.projectId) {
            throw new RecoveryPolicyBindingMismatchError(
              `Active approval package belongs to project '${activePkg.projectId}', not evidence project '${evidence.projectId}'`,
              { packageProjectId: activePkg.projectId, evidenceProjectId: evidence.projectId }
            );
          }
          if (evidence.approvalPackageRevision !== activePkg.revision) {
            throw new RecoveryPolicyBindingMismatchError(
              `Stale approval package revision: evidence bound to revision ${evidence.approvalPackageRevision}, but active approved package is at revision ${activePkg.revision}`,
              { evidenceRevision: evidence.approvalPackageRevision, activeRevision: activePkg.revision }
            );
          }
        }

        // 10. Execute Recovery Policy Engine evaluation and record audit event
        const historyManager =
          options.historyManager ??
          delegate?.historyManager ??
          new HistoryManager({ baseDir: resolvedRoot });

        const engine =
          options.recoveryPolicyEngine ??
          new RecoveryPolicyEngine({
            historyManager,
            expectedProjectId: expectedProject,
            ...options.serviceOptions,
          });

        const recordHistory = rawArgs.recordHistory !== false;
        const decision: RecoveryPolicyDecision = await engine.evaluateAndRecord({
          evidence,
          task,
          expectedProjectId: expectedProject,
          recordHistory,
        });

        // 11. Return sanitized decision
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(decision), null, 2),
            },
          ],
          isError: false,
        };
      } catch (err: unknown) {
        if (err instanceof RecoveryPolicyError) {
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
                  code: 'ERR_RECOVERY_POLICY_EVALUATION',
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

export function registerRecoveryEvaluateTools(
  server: McpServer,
  options: { recoveryEngine?: RecoveryPolicyEngine } = {}
): void {
  const { definition, handler } = createRecoveryEvaluateTool({
    recoveryPolicyEngine: options.recoveryEngine,
    defaultDelegate: server.delegate,
  });
  server.registerTool(definition, handler);
}
