/**
 * Recovery Policy Engine (Phase 13 TASK-P13-01)
 *
 * Implements the authoritative, deterministic policy evaluation boundary connecting
 * verified SystemExecutionEvidence and authoritative TaskDefinition to a RecoveryPolicyDecision.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Rejects unverified claims and fake verification fields.
 * 2. BOUNDED RETRY BUDGET: Strictly verifies task.attempt < task.max_attempts.
 *    If budget is exhausted, RETRY is strictly prohibited -> BLOCK_ON_HUMAN.
 * 3. IMMUTABILITY & NO MUTATION: Pure evaluation boundary.
 *    - DOES NOT increment task.attempt
 *    - DOES NOT reset task status
 *    - DOES NOT mutate SpecStore or DurableState
 *    - DOES NOT mutate Task DAG
 *    - DOES NOT invoke Antigravity or create ExecutionIntent/ExecutionRequest
 * 4. PROJECT & REVISION INTEGRITY: Rejects cross-project or stale-revision evidence.
 * 5. DETERMINISTIC PURITY: Identical input yields identical decision.
 */

import { Actor } from '../actors.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
  assertNoForbiddenEvidenceFields,
} from '../evidence/system-execution-evidence.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { FailureCategory, type FailureDiagnosis } from './failure-diagnosis-types.js';
import { FailureDiagnosisEngine } from './failure-diagnosis-engine.js';
import {
  type RecoveryPolicyDecision,
  RecoveryStrategy,
} from './recovery-policy-types.js';
import {
  RecoveryPolicyValidationError,
  RecoveryPolicySecurityViolationError,
  RecoveryPolicyBindingMismatchError,
} from './recovery-policy-errors.js';

export interface EvaluatePolicyInput {
  readonly evidence: unknown;
  readonly task: TaskDefinition;
  readonly expectedProjectId?: string;
  readonly recordHistory?: boolean;
}

export interface RecoveryPolicyEngineOptions {
  readonly historyManager?: HistoryManager;
  readonly expectedProjectId?: string;
}

export class RecoveryPolicyEngine {
  private readonly historyManager?: HistoryManager;
  private readonly expectedProjectId?: string;

  constructor(options: RecoveryPolicyEngineOptions = {}) {
    this.historyManager = options.historyManager;
    this.expectedProjectId = options.expectedProjectId;
  }

  /**
   * Validates and normalizes verified evidence against security rules and task binding.
   */
  validateEvidenceAndBinding(
    candidate: unknown,
    task: TaskDefinition,
    expectedProjectId?: string
  ): SystemExecutionEvidence {
    if (!candidate || typeof candidate !== 'object') {
      throw new RecoveryPolicyValidationError(
        'Evidence must be a non-null object',
        { candidate }
      );
    }

    // 1. Security guard: no forbidden fake verification fields
    try {
      assertNoForbiddenEvidenceFields(candidate);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      throw new RecoveryPolicySecurityViolationError(errMessage, { cause: err });
    }

    // 2. Schema validation
    const parseResult = SystemExecutionEvidenceZodSchema.safeParse(candidate);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      const message = `Evidence schema validation failed: ${firstIssue?.message ?? parseResult.error.message}`;

      if (firstIssue && (firstIssue.message.includes('Forbidden') || firstIssue.message.includes('fake'))) {
        throw new RecoveryPolicySecurityViolationError(message, { issues: parseResult.error.issues });
      }

      throw new RecoveryPolicyValidationError(message, { issues: parseResult.error.issues });
    }

    const evidence = parseResult.data as SystemExecutionEvidence;

    // 3. Task binding validation
    if (evidence.taskId !== task.task_id) {
      throw new RecoveryPolicyBindingMismatchError(
        `Task ID mismatch: evidence targets '${evidence.taskId}', but task definition is '${task.task_id}'`,
        { evidenceTaskId: evidence.taskId, taskDefinitionId: task.task_id }
      );
    }

    // 4. Task revision validation
    const authoritativeRevision = (task.metadata?.revision as number) ?? 1;
    if (evidence.taskRevision !== authoritativeRevision) {
      throw new RecoveryPolicyBindingMismatchError(
        `Task revision mismatch: evidence specifies revision ${evidence.taskRevision}, but authoritative task revision is ${authoritativeRevision}`,
        { evidenceRevision: evidence.taskRevision, authoritativeRevision }
      );
    }

    // 5. Cross-project binding validation
    const targetProject = expectedProjectId ?? this.expectedProjectId;
    if (targetProject && evidence.projectId !== targetProject) {
      throw new RecoveryPolicyBindingMismatchError(
        `Project ID mismatch: evidence belongs to '${evidence.projectId}', but expected '${targetProject}'`,
        { evidenceProjectId: evidence.projectId, expectedProjectId: targetProject }
      );
    }

    return evidence;
  }

  /**
   * Pure evaluation function: transforms verified evidence and authoritative task state into a RecoveryPolicyDecision.
   */
  evaluate(input: EvaluatePolicyInput): RecoveryPolicyDecision {
    const { task, expectedProjectId } = input;
    const evidence = this.validateEvidenceAndBinding(input.evidence, task, expectedProjectId);

    // 1. Perform Failure Diagnosis
    const diagnosis: FailureDiagnosis = FailureDiagnosisEngine.diagnose(evidence);

    // 2. Authoritative attempt limits
    const currentAttempt = typeof task.attempt === 'number' ? task.attempt : 0;
    const maxAttempts = typeof task.max_attempts === 'number' && task.max_attempts > 0 ? task.max_attempts : 3;
    const hasRemainingAttempts = currentAttempt < maxAttempts;

    // 3. Evaluate Decision Strategy
    let decision: RecoveryStrategy;
    const reasonCodes: string[] = [];
    let justification: string;
    let retryAllowed = false;
    let replanAllowed = false;
    let humanRequired = false;

    // If evidence was actually ACCEPT, no recovery needed
    if (!diagnosis.isFailure) {
      return Object.freeze({
        decision: RecoveryStrategy.BLOCK_ON_HUMAN,
        failureCategory: FailureCategory.UNKNOWN,
        retryAllowed: false,
        replanAllowed: false,
        humanRequired: false,
        attempt: currentAttempt,
        maxAttempts,
        projectId: evidence.projectId,
        taskId: task.task_id,
        taskRevision: evidence.taskRevision,
        evidenceId: evidence.evidenceId,
        reasonCodes: Object.freeze(['NO_FAILURE_DETECTED', 'VERIFICATION_ACCEPTED']),
        justification: 'Execution was verified as ACCEPT; recovery policy evaluation not applicable.',
        diagnosis,
      });
    }

    const { primaryCategory } = diagnosis;

    switch (primaryCategory) {
      case FailureCategory.SECURITY_VIOLATION:
      case FailureCategory.SECURITY_FAILURE:
        decision = RecoveryStrategy.ABORT;
        humanRequired = true;
        reasonCodes.push('SECURITY_VIOLATION_DETECTED', 'FAIL_CLOSED_ABORT');
        justification = `Security violation detected: ${diagnosis.summary}. Immediate lifecycle abort required.`;
        break;

      case FailureCategory.STALE_BINDING:
        decision = RecoveryStrategy.BLOCK_ON_HUMAN;
        humanRequired = true;
        reasonCodes.push('STALE_BINDING_DETECTED', 'HUMAN_INTERVENTION_REQUIRED');
        justification = `Execution binding or context is stale: ${diagnosis.summary}. Human or Director resynchronization required.`;
        break;

      case FailureCategory.INFRASTRUCTURE_FAILURE:
      case FailureCategory.INFRASTRUCTURE_BLOCK:
      case FailureCategory.EXECUTOR_START_FAILURE:
      case FailureCategory.EXECUTOR_PROTOCOL_FAILURE:
      case FailureCategory.EXECUTOR_CANCELLED:
      case FailureCategory.EXECUTOR_OUTPUT_FAILURE:
        decision = RecoveryStrategy.BLOCK_ON_HUMAN;
        humanRequired = true;
        reasonCodes.push(primaryCategory, 'HUMAN_INTERVENTION_REQUIRED');
        justification = `Non-retryable execution failure encountered [${primaryCategory}]: ${diagnosis.summary}. Environment or configuration requires human inspection.`;
        break;

      case FailureCategory.SCOPE_VIOLATION:
        // Scope violation indicates structural plan boundary was exceeded
        decision = RecoveryStrategy.REPLAN;
        replanAllowed = true;
        humanRequired = true;
        reasonCodes.push('SCOPE_VIOLATION_DETECTED', 'REPLAN_RECOMMENDED');
        justification = `Repository modifications violated implementation scope: ${diagnosis.summary}. Task replanning required.`;
        break;

      case FailureCategory.BUILD_FAILURE:
      case FailureCategory.TYPECHECK_FAILURE:
      case FailureCategory.TEST_FAILURE:
      case FailureCategory.LINT_FAILURE:
      case FailureCategory.ACCEPTANCE_CRITERIA_FAILURE:
      case FailureCategory.EXECUTOR_FAILURE:
      case FailureCategory.EXECUTOR_EXIT_FAILURE:
      case FailureCategory.VERIFICATION_FAILURE:
      case FailureCategory.TIMEOUT:
      case FailureCategory.EXECUTOR_TIMEOUT:
        if (hasRemainingAttempts) {
          decision = RecoveryStrategy.RETRY;
          retryAllowed = true;
          replanAllowed = true;
          reasonCodes.push('RETRYABLE_CODE_DEFECT', 'ATTEMPTS_REMAINING');
          justification = `Code defect [${primaryCategory}] is retryable. Attempt ${currentAttempt + 1} of ${maxAttempts} permitted.`;
        } else {
          // Retry budget exhausted!
          decision = RecoveryStrategy.BLOCK_ON_HUMAN;
          humanRequired = true;
          replanAllowed = true;
          reasonCodes.push('RETRY_BUDGET_EXHAUSTED', 'MAX_ATTEMPTS_REACHED');
          justification = `Retry budget exhausted (${currentAttempt}/${maxAttempts} attempts used) for ${primaryCategory}. Escalated to human operator.`;
        }
        break;

      case FailureCategory.UNKNOWN:
      default:
        decision = RecoveryStrategy.BLOCK_ON_HUMAN;
        humanRequired = true;
        reasonCodes.push('UNKNOWN_FAILURE_CATEGORY', 'FAIL_CLOSED_BLOCK');
        justification = `Unclassified failure category: ${diagnosis.summary}. Fail-closed into BLOCK_ON_HUMAN.`;
        break;
    }

    const policyDecision: RecoveryPolicyDecision = Object.freeze({
      decision,
      failureCategory: primaryCategory,
      retryAllowed,
      replanAllowed,
      humanRequired,
      attempt: currentAttempt,
      maxAttempts,
      projectId: evidence.projectId,
      taskId: task.task_id,
      taskRevision: evidence.taskRevision,
      evidenceId: evidence.evidenceId,
      reasonCodes: Object.freeze(reasonCodes),
      justification,
      diagnosis,
    });

    return policyDecision;
  }

  /**
   * Async entry point that evaluates policy and optionally records RECOVERY_DECISION_EVALUATED in HistoryManager.
   */
  async evaluateAndRecord(input: EvaluatePolicyInput): Promise<RecoveryPolicyDecision> {
    const decision = this.evaluate(input);

    if (input.recordHistory && this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'RECOVERY_DECISION_EVALUATED',
          actor: Actor.ORCHESTRATOR,
          taskId: decision.taskId,
          payload: {
            decision: decision.decision,
            failureCategory: decision.failureCategory,
            retryAllowed: decision.retryAllowed,
            replanAllowed: decision.replanAllowed,
            humanRequired: decision.humanRequired,
            attempt: decision.attempt,
            maxAttempts: decision.maxAttempts,
            projectId: decision.projectId,
            taskId: decision.taskId,
            taskRevision: decision.taskRevision,
            evidenceId: decision.evidenceId,
            reasonCodes: decision.reasonCodes,
            justification: decision.justification,
          },
        });
      } catch {
        // Logging failure must not alter policy result
      }
    }

    return decision;
  }
}
