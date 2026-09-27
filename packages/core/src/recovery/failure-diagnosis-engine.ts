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
  [FailureCategory.STALE_BINDING]: 2,
  [FailureCategory.SCOPE_VIOLATION]: 3,
  [FailureCategory.INFRASTRUCTURE_FAILURE]: 4,
  [FailureCategory.TIMEOUT]: 5,
  [FailureCategory.BUILD_FAILURE]: 6,
  [FailureCategory.TYPECHECK_FAILURE]: 7,
  [FailureCategory.TEST_FAILURE]: 8,
  [FailureCategory.LINT_FAILURE]: 9,
  [FailureCategory.ACCEPTANCE_CRITERIA_FAILURE]: 10,
  [FailureCategory.EXECUTOR_FAILURE]: 11,
  [FailureCategory.UNKNOWN]: 12,
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
      const outcomeStatus = (evidence.executorOutcomeReference.status || '').toUpperCase();
      if (outcomeStatus === 'TIMEOUT') {
        issues.push({
          category: FailureCategory.TIMEOUT,
          severity: FailureSeverity.RETRYABLE,
          message: 'Executor operation timed out during execution',
          details: { exitCode: evidence.executorOutcomeReference.exitCode },
        });
      } else if (
        outcomeStatus === 'FAILURE' ||
        outcomeStatus === 'ERROR' ||
        outcomeStatus === 'CANCELLED'
      ) {
        // If not already covered by specific test/build/check failure, note executor failure
        issues.push({
          category: FailureCategory.EXECUTOR_FAILURE,
          severity: FailureSeverity.RETRYABLE,
          message: `Executor finished with status ${outcomeStatus}`,
          details: { exitCode: evidence.executorOutcomeReference.exitCode },
        });
      }
    }

    // 4. Handle Case: verificationDecision is REJECT or BLOCK, but issues list was empty
    if (evidence.verificationDecision !== 'ACCEPT' && issues.length === 0) {
      const blockingReason = (evidence.metadata?.blockingReason as string) ??
        (evidence.metadata?.summary as string) ??
        `Verification decision was ${evidence.verificationDecision} without detailed check failures`;

      const category = evidence.verificationDecision === 'BLOCK'
        ? FailureCategory.INFRASTRUCTURE_FAILURE
        : FailureCategory.UNKNOWN;

      issues.push({
        category,
        severity: evidence.verificationDecision === 'BLOCK' ? FailureSeverity.CRITICAL : FailureSeverity.RETRYABLE,
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
      case FailureCategory.STALE_BINDING:
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

      case FailureCategory.INFRASTRUCTURE_FAILURE:
        // Environment/tooling problem; human review/fix needed
        requiresHuman = true;
        isRetryable = false;
        isReplannable = false;
        break;

      case FailureCategory.BUILD_FAILURE:
      case FailureCategory.TYPECHECK_FAILURE:
      case FailureCategory.TEST_FAILURE:
      case FailureCategory.LINT_FAILURE:
      case FailureCategory.ACCEPTANCE_CRITERIA_FAILURE:
      case FailureCategory.EXECUTOR_FAILURE:
      case FailureCategory.TIMEOUT:
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
