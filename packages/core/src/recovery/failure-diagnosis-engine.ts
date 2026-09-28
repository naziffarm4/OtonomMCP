/**
 * Failure Diagnosis Engine (Phase 13 TASK-P13-01)
 *
 * Implements deterministic root-cause analysis on verified SystemExecutionEvidence.
 * Evaluates independent verification checks, acceptance criteria evaluations,
 * and executor outcome references to classify execution failures deterministically.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Evaluates only verified evidence and independent checks.
 * 2. DETERMINISTIC PRECEDENCE:
 *    SECURITY_VIOLATION > STALE_BINDING > SCOPE_VIOLATION > INFRASTRUCTURE_FAILURE >
 *    TIMEOUT > BUILD_FAILURE > TYPECHECK_FAILURE > TEST_FAILURE > LINT_FAILURE >
 *    ACCEPTANCE_CRITERIA_FAILURE > EXECUTOR_FAILURE > UNKNOWN
 * 3. PURE EVALUATION: Does not mutate state, DAG, SpecStore, or DurableState.
 */

import type {
  SystemExecutionEvidence,
  VerificationCheck,
  AcceptanceCriterionResult,
} from '../evidence/system-execution-evidence.js';
import {
  FailureCategory,
  FailureSeverity,
  type FailureDiagnosis,
  type FailureDiagnosisItem,
} from './failure-diagnosis-types.js';

// Deterministic Precedence Rank (lower number = higher priority)
export const FAILURE_CATEGORY_PRECEDENCE: Record<FailureCategory, number> = Object.freeze({
  [FailureCategory.SECURITY_VIOLATION]: 1,
  [FailureCategory.SECURITY_FAILURE]: 1,
  [FailureCategory.STALE_BINDING]: 2,
  [FailureCategory.SCOPE_VIOLATION]: 3,
  [FailureCategory.INFRASTRUCTURE_FAILURE]: 4,
  [FailureCategory.INFRASTRUCTURE_BLOCK]: 4,
  [FailureCategory.EXECUTOR_START_FAILURE]: 5,
  [FailureCategory.EXECUTOR_PROTOCOL_FAILURE]: 6,
  [FailureCategory.EXECUTOR_CANCELLED]: 7,
  [FailureCategory.EXECUTOR_OUTPUT_FAILURE]: 8,
  [FailureCategory.TIMEOUT]: 9,
  [FailureCategory.EXECUTOR_TIMEOUT]: 9,
  [FailureCategory.BUILD_FAILURE]: 10,
  [FailureCategory.TYPECHECK_FAILURE]: 11,
  [FailureCategory.TEST_FAILURE]: 12,
  [FailureCategory.LINT_FAILURE]: 13,
  [FailureCategory.ACCEPTANCE_CRITERIA_FAILURE]: 14,
  [FailureCategory.VERIFICATION_FAILURE]: 15,
  [FailureCategory.EXECUTOR_EXIT_FAILURE]: 16,
  [FailureCategory.EXECUTOR_FAILURE]: 16,
  [FailureCategory.UNKNOWN]: 17,
});

export class FailureDiagnosisEngine {
  /**
   * Diagnoses verified execution evidence into a structured FailureDiagnosis.
   * If evidence represents an ACCEPT decision with no failures, returns isFailure = false.
   */
  static diagnose(evidence: SystemExecutionEvidence): FailureDiagnosis {
    const issues: FailureDiagnosisItem[] = [];

    // 1. Inspect Verification Checks
    for (const check of evidence.verificationChecks) {
      if (check.status === 'PASS') continue;

      const item = this.classifyVerificationCheck(check);
      issues.push(item);
    }

    // 2. Inspect Acceptance Criteria
    for (const crit of evidence.acceptanceCriteria) {
      if (crit.status === 'PASS') continue;

      const item = this.classifyAcceptanceCriterion(crit);
      issues.push(item);
    }

    // 3. Inspect Executor Outcome Reference
    if (evidence.executorOutcomeReference) {
      const outcomeRef = evidence.executorOutcomeReference;
      const outcomeStatus = (outcomeRef.status || '').toUpperCase();
      const rawCategory = outcomeRef.failureCategory;

      if (rawCategory && (rawCategory as string) in FailureCategory) {
        const cat = rawCategory as FailureCategory;
        const severity =
          cat === FailureCategory.SECURITY_FAILURE
            ? FailureSeverity.FATAL
            : cat === FailureCategory.EXECUTOR_START_FAILURE ||
              cat === FailureCategory.EXECUTOR_PROTOCOL_FAILURE ||
              cat === FailureCategory.EXECUTOR_CANCELLED ||
              cat === FailureCategory.EXECUTOR_OUTPUT_FAILURE ||
              cat === FailureCategory.INFRASTRUCTURE_BLOCK
            ? FailureSeverity.CRITICAL
            : FailureSeverity.RETRYABLE;

        issues.push({
          category: cat,
          severity,
          message: outcomeRef.errorMessage || `Executor operation reported ${cat}`,
          details: { exitCode: outcomeRef.exitCode, signal: outcomeRef.signal, failureCategory: cat },
        });
      } else if (outcomeStatus === 'TIMEOUT' || outcomeRef.timedOut) {
        issues.push({
          category: FailureCategory.TIMEOUT,
          severity: FailureSeverity.RETRYABLE,
          message: 'Executor operation timed out during execution',
          details: { exitCode: outcomeRef.exitCode },
        });
      } else if (outcomeRef.cancelled || outcomeStatus === 'CANCELLED') {
        issues.push({
          category: FailureCategory.EXECUTOR_CANCELLED,
          severity: FailureSeverity.CRITICAL,
          message: 'Executor operation was cancelled',
          details: { exitCode: outcomeRef.exitCode, signal: outcomeRef.signal },
        });
      } else if (
        outcomeStatus === 'FAILURE' ||
        outcomeStatus === 'ERROR'
      ) {
        // If not already covered by specific test/build/check failure, note executor failure
        issues.push({
          category: FailureCategory.EXECUTOR_FAILURE,
          severity: FailureSeverity.RETRYABLE,
          message: outcomeRef.errorMessage || `Executor finished with status ${outcomeStatus}`,
          details: { exitCode: outcomeRef.exitCode },
        });
      }
    }

    // 4. Handle Case: verificationDecision is REJECT or BLOCK, but issues list was empty
    if (evidence.verificationDecision !== 'ACCEPT' && issues.length === 0) {
      const blockingReason = (evidence.metadata?.blockingReason as string) ??
        (evidence.metadata?.summary as string) ??
        `Verification decision was ${evidence.verificationDecision} without detailed check failures`;

      let category: FailureCategory;
      if (evidence.failureCategory && (evidence.failureCategory as string) in FailureCategory) {
        category = evidence.failureCategory as FailureCategory;
      } else {
        category = evidence.verificationDecision === 'BLOCK'
          ? FailureCategory.INFRASTRUCTURE_FAILURE
          : FailureCategory.UNKNOWN;
      }

      const severity =
        category === FailureCategory.SECURITY_FAILURE
          ? FailureSeverity.FATAL
          : evidence.verificationDecision === 'BLOCK' ||
            category === FailureCategory.EXECUTOR_START_FAILURE ||
            category === FailureCategory.EXECUTOR_PROTOCOL_FAILURE ||
            category === FailureCategory.EXECUTOR_CANCELLED ||
            category === FailureCategory.EXECUTOR_OUTPUT_FAILURE ||
            category === FailureCategory.INFRASTRUCTURE_BLOCK
          ? FailureSeverity.CRITICAL
          : FailureSeverity.RETRYABLE;

      issues.push({
        category,
        severity,
        message: blockingReason,
      });
    }

    // If verification was ACCEPT and no issues exist, return sound success diagnosis
    if (evidence.verificationDecision === 'ACCEPT' && issues.length === 0) {
      return Object.freeze({
        isFailure: false,
        primaryCategory: FailureCategory.UNKNOWN,
        primarySeverity: FailureSeverity.RETRYABLE,
        isRetryable: false,
        isReplannable: false,
        requiresHuman: false,
        issues: Object.freeze([]),
        rootCauses: Object.freeze([]),
        summary: 'Execution verified successfully (ACCEPT)',
      });
    }

    // Sort issues deterministically by precedence rank then message
    const sortedIssues = [...issues].sort((a, b) => {
      const rankA = FAILURE_CATEGORY_PRECEDENCE[a.category] ?? 99;
      const rankB = FAILURE_CATEGORY_PRECEDENCE[b.category] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      return a.message.localeCompare(b.message);
    });

    const primaryIssue = sortedIssues[0] ?? {
      category: FailureCategory.UNKNOWN,
      severity: FailureSeverity.RETRYABLE,
      message: 'Unknown execution verification failure',
    };

    const primaryCategory = primaryIssue.category;
    const primarySeverity = primaryIssue.severity;

    // Determine policy flags derived from primary category and severity
    let isRetryable = false;
    let isReplannable = false;
    let requiresHuman = false;

    switch (primaryCategory) {
      case FailureCategory.SECURITY_VIOLATION:
      case FailureCategory.SECURITY_FAILURE:
      case FailureCategory.STALE_BINDING:
        requiresHuman = true;
        isRetryable = false;
        isReplannable = false;
        break;

      case FailureCategory.INFRASTRUCTURE_FAILURE:
      case FailureCategory.INFRASTRUCTURE_BLOCK:
      case FailureCategory.EXECUTOR_START_FAILURE:
      case FailureCategory.EXECUTOR_PROTOCOL_FAILURE:
      case FailureCategory.EXECUTOR_CANCELLED:
      case FailureCategory.EXECUTOR_OUTPUT_FAILURE:
        // Operational/environment/executor defect; non-retryable autonomously, requires human
        requiresHuman = true;
        isRetryable = false;
        isReplannable = false;
        break;

      case FailureCategory.SCOPE_VIOLATION:
        // Scope violation indicates implementation exceeded boundary; requires replan or human intervention
        isReplannable = true;
        requiresHuman = true;
        isRetryable = false;
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
        // Standard code-level defects are retryable by the implementation agent
        isRetryable = true;
        isReplannable = true;
        requiresHuman = false;
        break;

      case FailureCategory.UNKNOWN:
      default:
        // Fail closed for unknown categories
        requiresHuman = true;
        isRetryable = false;
        isReplannable = false;
        break;
    }

    const rootCauses = Array.from(new Set(sortedIssues.map((i) => i.message)));
    const summary = `Primary failure [${primaryCategory}]: ${primaryIssue.message}`;

    return Object.freeze({
      isFailure: true,
      primaryCategory,
      primarySeverity,
      isRetryable,
      isReplannable,
      requiresHuman,
      issues: Object.freeze(sortedIssues),
      rootCauses: Object.freeze(rootCauses),
      summary,
    });
  }

  /**
   * Classifies an individual VerificationCheck into a FailureDiagnosisItem.
   */
  private static classifyVerificationCheck(check: VerificationCheck): FailureDiagnosisItem {
    const typeUpper = (check.type || '').toUpperCase();
    const idUpper = (check.checkId || '').toUpperCase();
    const evidenceLower = (check.evidence || '').toLowerCase();

    // 0. Executor execution check
    if (typeUpper === 'EXECUTOR' || idUpper.includes('EXECUTOR')) {
      const cat = (check.details as any)?.failureCategory;
      if (cat && (cat as string) in FailureCategory) {
        const failureCat = cat as FailureCategory;
        const severity =
          failureCat === FailureCategory.SECURITY_FAILURE
            ? FailureSeverity.FATAL
            : failureCat === FailureCategory.EXECUTOR_START_FAILURE ||
              failureCat === FailureCategory.EXECUTOR_PROTOCOL_FAILURE ||
              failureCat === FailureCategory.EXECUTOR_CANCELLED ||
              failureCat === FailureCategory.EXECUTOR_OUTPUT_FAILURE ||
              failureCat === FailureCategory.INFRASTRUCTURE_BLOCK
            ? FailureSeverity.CRITICAL
            : FailureSeverity.RETRYABLE;
        return {
          checkId: check.checkId,
          category: failureCat,
          severity,
          message: check.evidence || `Executor failed with category ${cat}`,
          details: check.details,
        };
      }
    }

    // 1. Security / Path safety
    if (typeUpper === 'SECURITY' || idUpper.includes('PATH_SAFETY') || idUpper.includes('SECURITY')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.SECURITY_VIOLATION,
        severity: FailureSeverity.FATAL,
        message: check.evidence || 'Security check failed',
        details: check.details,
      };
    }

    // 2. Binding
    if (typeUpper === 'BINDING' || idUpper.includes('BINDING')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.STALE_BINDING,
        severity: FailureSeverity.FATAL,
        message: check.evidence || 'Request or execution binding mismatch',
        details: check.details,
      };
    }

    // 3. File Scope
    if (typeUpper === 'FILE_SCOPE' || idUpper.includes('SCOPE') || idUpper.includes('TARGET_FILES')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.SCOPE_VIOLATION,
        severity: FailureSeverity.STRUCTURAL,
        message: check.evidence || 'File scope violation detected',
        details: check.details,
      };
    }

    // 4. Infrastructure failure (status === 'BLOCK')
    if (check.status === 'BLOCK' || evidenceLower.includes('infrastructure') || evidenceLower.includes('spawn')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.INFRASTRUCTURE_FAILURE,
        severity: FailureSeverity.CRITICAL,
        message: check.evidence || 'Verification command infrastructure failure',
        details: check.details,
      };
    }

    // 5. Build / Compile
    if (typeUpper === 'BUILD' || idUpper.includes('BUILD') || evidenceLower.includes('build failed')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.BUILD_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: check.evidence || 'Build verification check failed',
        details: check.details,
      };
    }

    // 6. Typecheck
    if (typeUpper === 'TYPECHECK' || idUpper.includes('TYPECHECK') || evidenceLower.includes('typecheck')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.TYPECHECK_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: check.evidence || 'Typecheck verification check failed',
        details: check.details,
      };
    }

    // 7. Lint
    if (typeUpper === 'LINT' || idUpper.includes('LINT') || evidenceLower.includes('lint')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.LINT_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: check.evidence || 'Lint verification check failed',
        details: check.details,
      };
    }

    // 8. Test
    if (typeUpper === 'TEST' || idUpper.includes('TEST') || evidenceLower.includes('test failed')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.TEST_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: check.evidence || 'Test suite verification check failed',
        details: check.details,
      };
    }

    // 9. Timeout
    if (evidenceLower.includes('timed out') || evidenceLower.includes('timeout')) {
      return {
        checkId: check.checkId,
        category: FailureCategory.TIMEOUT,
        severity: FailureSeverity.RETRYABLE,
        message: check.evidence || 'Verification check timed out',
        details: check.details,
      };
    }

    // Fallback
    return {
      checkId: check.checkId,
      category: FailureCategory.UNKNOWN,
      severity: (check.status as string) === 'BLOCK' ? FailureSeverity.CRITICAL : FailureSeverity.RETRYABLE,
      message: check.evidence || `Verification check ${check.checkId} failed`,
      details: check.details,
    };
  }

  /**
   * Classifies an AcceptanceCriterionResult into a FailureDiagnosisItem.
   */
  private static classifyAcceptanceCriterion(crit: AcceptanceCriterionResult): FailureDiagnosisItem {
    const descLower = (crit.criterion || '').toLowerCase();
    const evidenceLower = (crit.evidence || '').toLowerCase();

    if (crit.status === 'BLOCK' || evidenceLower.includes('infrastructure')) {
      return {
        checkId: crit.criterionId,
        category: FailureCategory.INFRASTRUCTURE_FAILURE,
        severity: FailureSeverity.CRITICAL,
        message: crit.evidence || `Acceptance criterion blocked: ${crit.criterion}`,
      };
    }

    if (descLower.includes('test') || evidenceLower.includes('test')) {
      return {
        checkId: crit.criterionId,
        category: FailureCategory.TEST_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: crit.evidence || `Test acceptance criterion failed: ${crit.criterion}`,
      };
    }

    if (descLower.includes('build') || descLower.includes('compile') || evidenceLower.includes('build')) {
      return {
        checkId: crit.criterionId,
        category: FailureCategory.BUILD_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: crit.evidence || `Build acceptance criterion failed: ${crit.criterion}`,
      };
    }

    if (descLower.includes('typecheck') || descLower.includes('type check') || evidenceLower.includes('type')) {
      return {
        checkId: crit.criterionId,
        category: FailureCategory.TYPECHECK_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: crit.evidence || `Typecheck acceptance criterion failed: ${crit.criterion}`,
      };
    }

    if (descLower.includes('lint') || evidenceLower.includes('lint')) {
      return {
        checkId: crit.criterionId,
        category: FailureCategory.LINT_FAILURE,
        severity: FailureSeverity.RETRYABLE,
        message: crit.evidence || `Lint acceptance criterion failed: ${crit.criterion}`,
      };
    }

    return {
      checkId: crit.criterionId,
      category: FailureCategory.ACCEPTANCE_CRITERIA_FAILURE,
      severity: FailureSeverity.RETRYABLE,
      message: crit.evidence || `Acceptance criterion failed: ${crit.criterion}`,
    };
  }
}
