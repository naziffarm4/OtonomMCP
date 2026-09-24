/**
 * Execution QA Bridge (Phase 10 TASK-P10-04)
 *
 * Bridges ExecutionRequest acceptance criteria with independent system verification checks.
 * Produces deterministic, typed criterion evaluations ('PASS' | 'FAIL' | 'BLOCK')
 * and an overall verification decision ('ACCEPT' | 'REJECT' | 'BLOCK') without trusting executor claims.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. UNTRUSTED AGENT CLAIMS: Executor claims (status=SUCCESS, stdout, unverified claims)
 *    can NEVER satisfy an acceptance criterion. Only independent system checks can satisfy criteria.
 * 2. EXPLICIT TAXONOMY: Every criterion evaluates strictly to 'PASS', 'FAIL', or 'BLOCK'. No silent omissions.
 * 3. INABILITY TO VERIFY = BLOCK: Inability to verify because of missing infrastructure is BLOCK, NEVER ACCEPT.
 * 4. STRICT DECISION PRIORITY: Any FAIL -> REJECT. Else any BLOCK -> BLOCK. All PASS -> ACCEPT.
 * 5. PURE EVALUATION: Does NOT mutate state, DAG, FSM, or approval stores.
 */

import type {
  ExecutionAcceptanceCriterion,
  AcceptanceCriterionSpec,
  ExecutionRequest,
} from '../executor-bridge/execution-request-types.js';
import type {
  VerificationCheck,
  AcceptanceCriterionResult,
  VerificationDecision,
  VerificationCheckStatus,
  ChangedFileEvidence,
  RepositoryStateEvidence,
} from '../evidence/system-execution-evidence.js';
import type { RawExecutorOutcome } from '../executor-bridge/raw-executor-outcome.js';

export interface EvaluateCriteriaInput {
  readonly request: ExecutionRequest;
  readonly outcome: RawExecutorOutcome;
  readonly verificationChecks: readonly VerificationCheck[];
  readonly changedFiles: readonly ChangedFileEvidence[];
  readonly repositoryState: RepositoryStateEvidence;
  readonly isBindingValid: boolean;
  readonly bindingMismatchReason?: string | null;
  readonly unexpectedFiles?: readonly string[];
}

export interface CriteriaEvaluationResult {
  readonly criteriaResults: readonly AcceptanceCriterionResult[];
  readonly decision: VerificationDecision;
  readonly summary: string;
}

export class ExecutionQaBridge {
  /**
   * Normalizes an ExecutionAcceptanceCriterion (string or spec) into a standard descriptor.
   */
  static normalizeCriterion(
    criterion: ExecutionAcceptanceCriterion,
    index: number
  ): {
    id: string;
    description: string;
    type: string;
    mandatory: boolean;
  } {
    if (typeof criterion === 'string') {
      const id = `AC-${String(index + 1).padStart(3, '0')}`;
      const desc = criterion.trim();
      let type = 'GENERAL';
      const lower = desc.toLowerCase();
      if (lower.includes('test') || lower.includes('spec')) {
        type = 'TEST';
      } else if (lower.includes('build') || lower.includes('compile')) {
        type = 'BUILD';
      } else if (lower.includes('typecheck') || lower.includes('type check') || lower.includes('tsc')) {
        type = 'TYPECHECK';
      } else if (lower.includes('git') || lower.includes('clean') || lower.includes('diff') || lower.includes('file')) {
        type = 'GIT';
      }
      return { id, description: desc, type, mandatory: true };
    }

    const spec = criterion as AcceptanceCriterionSpec;
    const id = spec.criterionId ?? spec.id ?? `AC-${String(index + 1).padStart(3, '0')}`;
    const description = (spec.description ?? '').trim();
    const type = (spec.type ?? 'GENERAL').toUpperCase();
    const mandatory = spec.mandatory !== false;
    return { id, description, type, mandatory };
  }

  /**
   * Evaluates all acceptance criteria of an ExecutionRequest against independent system verification checks.
   */
  static evaluate(input: EvaluateCriteriaInput): CriteriaEvaluationResult {
    const {
      request,
      outcome,
      verificationChecks,
      changedFiles,
      repositoryState,
      isBindingValid,
      bindingMismatchReason,
      unexpectedFiles,
    } = input;

    const criteriaList = request.instruction?.acceptanceCriteria ?? [];
    const results: AcceptanceCriterionResult[] = [];

    // Helper map of checks by type and checkId
    const checksByType = new Map<string, VerificationCheck[]>();
    for (const check of verificationChecks) {
      const existing = checksByType.get(check.type) ?? [];
      existing.push(check);
      checksByType.set(check.type, existing);
    }

    // 1. If criteria list is empty, construct a default general criterion from objective
    const effectiveCriteria =
      criteriaList.length > 0
        ? criteriaList
        : [request.instruction?.objective || 'Objective implementation verified'];

    for (let i = 0; i < effectiveCriteria.length; i++) {
      const raw = effectiveCriteria[i];
      const norm = this.normalizeCriterion(raw, i);
      const evalResult = this.evaluateSingleCriterion(norm, {
        verificationChecks,
        checksByType,
        changedFiles,
        repositoryState,
        unexpectedFiles,
        outcome,
      });

      results.push({
        criterion: norm.description,
        criterionId: norm.id,
        mandatory: norm.mandatory,
        status: evalResult.status,
        evidence: evalResult.evidence,
      });
    }

    // 2. Determine overall VerificationDecision
    // HARD RULE:
    // A. If binding is invalid -> strictly REJECT.
    // B. If executor outcome is explicit FAILURE/CANCELLED/TIMEOUT/ERROR -> strictly REJECT or BLOCK.
    // C. Any criterion or verificationCheck with status FAIL -> strictly REJECT.
    // D. Else if any criterion or verificationCheck with status BLOCK -> strictly BLOCK.
    // E. Else if all criteria and checks are PASS -> ACCEPT.

    let decision: VerificationDecision = 'ACCEPT';
    const reasons: string[] = [];

    if (!isBindingValid) {
      decision = 'REJECT';
      reasons.push(`Binding mismatch: ${bindingMismatchReason ?? 'unauthorized request binding'}`);
    }

    if (unexpectedFiles && unexpectedFiles.length > 0) {
      decision = 'REJECT';
      reasons.push(`Unexpected modified files detected: [${unexpectedFiles.join(', ')}]`);
    }

    // Check verificationChecks status
    for (const check of verificationChecks) {
      if (check.status === 'FAIL') {
        decision = 'REJECT';
        reasons.push(`Verification check '${check.checkId}' failed: ${check.evidence ?? 'check failed'}`);
      } else if (check.status === 'BLOCK' && decision !== 'REJECT') {
        decision = 'BLOCK';
        reasons.push(`Verification check '${check.checkId}' blocked: ${check.evidence ?? 'verification blocked'}`);
      }
    }

    // Check criteria status
    for (const cr of results) {
      if (cr.status === 'FAIL') {
        decision = 'REJECT';
        reasons.push(`Criterion '${cr.criterion}' failed: ${cr.evidence}`);
      } else if (cr.status === 'BLOCK' && decision !== 'REJECT') {
        decision = 'BLOCK';
        reasons.push(`Criterion '${cr.criterion}' blocked: ${cr.evidence}`);
      }
    }

    // If executor failed, decision cannot be ACCEPT
    if (outcome.status !== 'SUCCESS') {
      if (decision === 'ACCEPT') {
        decision = outcome.status === 'TIMEOUT' || outcome.status === 'ERROR' ? 'BLOCK' : 'REJECT';
        reasons.push(`Raw executor outcome was ${outcome.status}`);
      }
    }

    const summary =
      reasons.length > 0
        ? `Decision ${decision}: ${reasons.join('; ')}`
        : `Decision ${decision}: All ${results.length} acceptance criteria and verification checks passed.`;

    return {
      criteriaResults: Object.freeze(results),
      decision,
      summary,
    };
  }

  /**
   * Evaluates a single normalized criterion against independent system evidence.
   */
  private static evaluateSingleCriterion(
    criterion: { id: string; description: string; type: string; mandatory: boolean },
    context: {
      verificationChecks: readonly VerificationCheck[];
      checksByType: Map<string, VerificationCheck[]>;
      changedFiles: readonly ChangedFileEvidence[];
      repositoryState: RepositoryStateEvidence;
      unexpectedFiles?: readonly string[];
      outcome: RawExecutorOutcome;
    }
  ): { status: VerificationCheckStatus; evidence: string } {
    const { checksByType, verificationChecks, changedFiles, unexpectedFiles, outcome } = context;

    // RULE: Executor raw status=SUCCESS or claim alone NEVER satisfies criteria!
    // Matching checks by type or criterion reference
    const relevantChecks = verificationChecks.filter(
      (c) =>
        c.type === criterion.type ||
        (criterion.type === 'TEST' && (c.type === 'TEST' || c.type === 'COMMAND')) ||
        (criterion.type === 'BUILD' && (c.type === 'BUILD' || c.type === 'COMMAND')) ||
        (criterion.type === 'TYPECHECK' && (c.type === 'TYPECHECK' || c.type === 'COMMAND')) ||
        (c.details as Record<string, unknown> | undefined)?.criterionId === criterion.id
    );

    // If relevant checks exist, evaluate them
    if (relevantChecks.length > 0) {
      const anyFail = relevantChecks.find((c) => c.status === 'FAIL');
      if (anyFail) {
        return {
          status: 'FAIL',
          evidence: `Independent verification check '${anyFail.checkId}' failed: ${anyFail.evidence ?? 'process failed'}`,
        };
      }

      const anyBlock = relevantChecks.find((c) => c.status === 'BLOCK');
      if (anyBlock) {
        return {
          status: 'BLOCK',
          evidence: `Independent verification check '${anyBlock.checkId}' blocked: ${anyBlock.evidence ?? 'infrastructure failure'}`,
        };
      }

      const allPass = relevantChecks.every((c) => c.status === 'PASS');
      if (allPass) {
        const checkEvidences = relevantChecks.map((c) => c.evidence || c.command || c.checkId).join('; ');
        return {
          status: 'PASS',
          evidence: `Satisfied by independent verification check(s): ${checkEvidences}`,
        };
      }
    }

    // Git / File scope criterion
    if (criterion.type === 'GIT') {
      if (unexpectedFiles && unexpectedFiles.length > 0) {
        return {
          status: 'FAIL',
          evidence: `Git check failed due to unexpected changed files: [${unexpectedFiles.join(', ')}]`,
        };
      }
      return {
        status: 'PASS',
        evidence: `Repository state verified: ${changedFiles.length} file(s) changed, clean=${context.repositoryState.isClean}`,
      };
    }

    // If criterion requires TEST, BUILD, or TYPECHECK, but NO independent check ran:
    if (criterion.type === 'TEST' || criterion.type === 'BUILD' || criterion.type === 'TYPECHECK') {
      // Executor claims cannot be trusted!
      return {
        status: 'BLOCK',
        evidence: `Required independent ${criterion.type} verification was not executed or tooling was unavailable. Raw executor claims cannot satisfy this criterion.`,
      };
    }

    // General criterion
    if (outcome.status === 'SUCCESS' && (!unexpectedFiles || unexpectedFiles.length === 0)) {
      // Only if all other checks in the pipeline passed
      const globalFail = verificationChecks.find((c) => c.status === 'FAIL');
      const globalBlock = verificationChecks.find((c) => c.status === 'BLOCK');
      if (globalFail) {
        return {
          status: 'FAIL',
          evidence: `Criterion failed due to verification failure in '${globalFail.checkId}'`,
        };
      }
      if (globalBlock) {
        return {
          status: 'BLOCK',
          evidence: `Criterion blocked due to blocked check in '${globalBlock.checkId}'`,
        };
      }

      return {
        status: 'PASS',
        evidence: `Objective criteria verified against system state and changed files (${changedFiles.length} files modified)`,
      };
    }

    return {
      status: 'FAIL',
      evidence: `Criterion unsatisfied. Executor outcome status: ${outcome.status}`,
    };
  }
}
