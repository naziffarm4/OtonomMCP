/**
 * Phase 4 Deterministic QA Review Engine
 *
 * Evaluates system-verified execution evidence against task acceptance criteria.
 * Pure decision component: does NOT execute commands, mutate files, call Git,
 * call Antigravity, or make network requests.
 *
 * Implements strict separation: AGENT_CLAIM can NEVER satisfy criteria.
 * Distinguishes between explicit failure (REJECT) and missing evidence (REQUEST_CONTEXT).
 */

import {
  EvidenceType,
  EvidenceSource,
  type SystemVerifiedEvidence,
  type AgentClaim,
} from '../evidence/evidence-types.js';
import { validateSystemVerifiedEvidence } from '../evidence/evidence-validator.js';
import {
  ReviewDecision,
  CriterionStatus,
  CriterionType,
  ReviewFindingSeverity,
  isCriterionType,
  type AcceptanceCriterion,
  type AcceptanceCriterionInput,
  type CriterionResult,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewRequestInput,
  type ReviewResult,
} from './qa-review-types.js';
import {
  InvalidReviewRequestError,
  MissingAcceptanceCriteriaError,
  UnsupportedCriterionTypeError,
} from '../errors/qa-review-error.js';
import {
  sanitizeEvidenceSecrets,
  sanitizeEvidenceDetails,
} from '../errors/evidence-error.js';

// ============================================================================
// HELPER UTILITIES
// ============================================================================

function sortStrings(list: readonly string[]): string[] {
  return [...list].sort();
}

function deduplicateStrings(list: readonly string[]): string[] {
  return Array.from(new Set(list)).sort();
}

function normalizeCriterionInput(
  input: AcceptanceCriterionInput,
  index: number
): AcceptanceCriterion {
  const criterionId = String(
    input.criterion_id ?? input.criterionId ?? `AC-${String(index + 1).padStart(3, '0')}`
  ).trim();

  if (!criterionId) {
    throw new InvalidReviewRequestError(
      `Criterion at index ${index} must have a non-empty criterion_id.`,
      { field: `acceptance_criteria[${index}].criterion_id` }
    );
  }

  const description = String(input.description ?? '').trim();
  if (!description) {
    throw new InvalidReviewRequestError(
      `Criterion '${criterionId}' must have a non-empty description.`,
      { criterionId, field: `acceptance_criteria[${index}].description` }
    );
  }

  const rawType = input.criterion_type ?? input.criterionType ?? CriterionType.COMMAND;
  if (!isCriterionType(rawType)) {
    throw new UnsupportedCriterionTypeError(
      `Unsupported criterion_type '${String(rawType)}' for criterion '${criterionId}'.`,
      { criterionId, field: `acceptance_criteria[${index}].criterion_type` }
    );
  }

  const isMandatory =
    input.is_mandatory !== undefined
      ? Boolean(input.is_mandatory)
      : input.isMandatory !== undefined
        ? Boolean(input.isMandatory)
        : input.mandatory !== undefined
          ? Boolean(input.mandatory)
          : true;

  const expectedExitCode =
    input.expected_exit_code !== undefined
      ? input.expected_exit_code
      : input.expectedExitCode !== undefined
        ? input.expectedExitCode
        : rawType === CriterionType.COMMAND ||
            rawType === CriterionType.TEST ||
            rawType === CriterionType.BUILD
          ? 0
          : undefined;

  const stdoutContains = input.stdout_contains ?? input.stdoutContains;
  const normalizedStdout = stdoutContains
    ? Array.isArray(stdoutContains)
      ? stdoutContains.map(String)
      : [String(stdoutContains)]
    : undefined;

  const stderrContains = input.stderr_contains ?? input.stderrContains;
  const normalizedStderr = stderrContains
    ? Array.isArray(stderrContains)
      ? stderrContains.map(String)
      : [String(stderrContains)]
    : undefined;

  const outputDisallowed = input.output_disallowed ?? input.outputDisallowed;
  const normalizedDisallowed = outputDisallowed
    ? Array.isArray(outputDisallowed)
      ? outputDisallowed.map(String)
      : [String(outputDisallowed)]
    : undefined;

  const requiredFiles = input.required_files ?? input.requiredFiles;
  const normalizedRequiredFiles = requiredFiles ? requiredFiles.map(String).sort() : undefined;

  const rawFileHashes = input.file_hashes ?? input.fileHashes;
  const fileHashes: Record<string, string> | undefined = rawFileHashes
    ? { ...rawFileHashes }
    : undefined;

  const disallowedDiff = input.disallowed_diff_patterns ?? input.disallowedDiffPatterns;
  const normalizedDisallowedDiff = disallowedDiff ? disallowedDiff.map(String) : undefined;

  return Object.freeze({
    criterion_id: criterionId,
    description,
    criterion_type: rawType as CriterionType,
    is_mandatory: isMandatory,
    expected_command: input.expected_command ?? input.expectedCommand,
    expected_exit_code: expectedExitCode,
    working_directory: input.working_directory ?? input.workingDirectory,
    stdout_contains: normalizedStdout ? Object.freeze(normalizedStdout) : undefined,
    stderr_contains: normalizedStderr ? Object.freeze(normalizedStderr) : undefined,
    output_disallowed: normalizedDisallowed ? Object.freeze(normalizedDisallowed) : undefined,
    required_files: normalizedRequiredFiles ? Object.freeze(normalizedRequiredFiles) : undefined,
    file_hashes: fileHashes ? Object.freeze(fileHashes) : undefined,
    require_diff: input.require_diff ?? input.requireDiff,
    disallowed_diff_patterns: normalizedDisallowedDiff
      ? Object.freeze(normalizedDisallowedDiff)
      : undefined,
    expected_git_head: input.expected_git_head ?? input.expectedGitHead,
    predicate: input.predicate,
    metadata: input.metadata ? Object.freeze({ ...input.metadata }) : null,
  });
}

function normalizeReviewRequest(input: ReviewRequestInput): ReviewRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidReviewRequestError('Review request must be a non-null object.', {
      field: 'request',
    });
  }

  const taskId = String(input.task_id ?? input.taskId ?? '').trim();
  if (!taskId) {
    throw new InvalidReviewRequestError('Missing mandatory review request field: task_id.', {
      field: 'task_id',
    });
  }

  const projectId = String(input.project_id ?? input.projectId ?? '').trim();
  if (!projectId) {
    throw new InvalidReviewRequestError('Missing mandatory review request field: project_id.', {
      field: 'project_id',
      taskId,
    });
  }

  const correlationId = String(input.correlation_id ?? input.correlationId ?? '').trim();
  if (!correlationId) {
    throw new InvalidReviewRequestError('Missing mandatory review request field: correlation_id.', {
      field: 'correlation_id',
      taskId,
      projectId,
    });
  }

  const attempt = input.attempt !== undefined ? Number(input.attempt) : 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidReviewRequestError('Field attempt must be an integer >= 1.', {
      field: 'attempt',
      taskId,
    });
  }

  const maxAttempts =
    input.max_attempts !== undefined
      ? Number(input.max_attempts)
      : input.maxAttempts !== undefined
        ? Number(input.maxAttempts)
        : Math.max(attempt, 3);

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InvalidReviewRequestError('Field max_attempts must be an integer >= 1.', {
      field: 'max_attempts',
      taskId,
    });
  }

  const rawCriteria = input.acceptance_criteria ?? input.acceptanceCriteria;
  if (!rawCriteria || !Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    throw new MissingAcceptanceCriteriaError(
      'Review request must provide at least one acceptance criterion in acceptance_criteria.',
      { taskId, projectId, correlationId }
    );
  }

  const normalizedCriteria = rawCriteria
    .map(normalizeCriterionInput)
    .sort((a, b) => a.criterion_id.localeCompare(b.criterion_id));

  const rawEvidence = input.evidence;
  const evidenceList = Array.isArray(rawEvidence) ? rawEvidence : [];

  const rawRequired = input.required_evidence ?? input.requiredEvidence;
  const requiredEvidence = Array.isArray(rawRequired)
    ? Object.freeze([...rawRequired])
    : undefined;

  const blockingCondition =
    input.blocking_condition === true || input.blockingCondition === true;

  const blockingReason = input.blocking_reason ?? input.blockingReason ?? null;

  return Object.freeze({
    task_id: taskId,
    project_id: projectId,
    correlation_id: correlationId,
    attempt,
    max_attempts: maxAttempts,
    acceptance_criteria: Object.freeze(normalizedCriteria),
    required_evidence: requiredEvidence,
    evidence: Object.freeze(evidenceList),
    traceability: input.traceability ? Object.freeze({ ...input.traceability }) : null,
    blocking_condition: blockingCondition,
    blocking_reason: blockingReason ? String(blockingReason) : null,
    metadata: input.metadata ? Object.freeze({ ...input.metadata }) : null,
  });
}

// ============================================================================
// DETERMINISTIC QA REVIEW ENGINE
// ============================================================================

export class QAReviewEngine {
  /**
   * Deterministically evaluates system-verified evidence against a review request.
   *
   * Pure evaluation function:
   * - Never executes external commands
   * - Never mutates files or Git
   * - Never invokes network, LLM, or Antigravity
   * - Preserves strict separation between AGENT_CLAIM and SYSTEM_VERIFIED_EVIDENCE
   */
  public review(input: ReviewRequestInput): ReviewResult {
    const request = normalizeReviewRequest(input);

    const findings: ReviewFinding[] = [];
    const validEvidencePool: SystemVerifiedEvidence[] = [];
    let rejectedClaimsCount = 0;
    let invalidEvidenceCount = 0;

    function addFinding(
      code: string,
      severity: ReviewFindingSeverity,
      rawMessage: string,
      criterionId?: string | null,
      evidenceIds?: readonly string[],
      details?: Record<string, unknown>
    ): void {
      findings.push(
        Object.freeze({
          criterion_id: criterionId ?? null,
          code,
          severity,
          message: sanitizeEvidenceSecrets(rawMessage),
          evidence_ids: evidenceIds ? Object.freeze(sortStrings(evidenceIds)) : undefined,
          details: details ? (sanitizeEvidenceDetails(details) as Record<string, unknown>) : undefined,
        })
      );
    }

    // ========================================================================
    // 1. EVIDENCE INGESTION & SOURCE SEPARATION (Rule 4 & Rule 10)
    // ========================================================================
    for (const rawItem of request.evidence) {
      if (!rawItem || typeof rawItem !== 'object') {
        invalidEvidenceCount++;
        addFinding(
          'ERR_INVALID_REVIEW_EVIDENCE',
          ReviewFindingSeverity.WARNING,
          'Encountered non-object evidence item in evidence collection.',
          null,
          undefined,
          { item: String(rawItem) }
        );
        continue;
      }

      const itemObj = rawItem as Record<string, unknown>;

      // Explicit check for AGENT_CLAIM
      const isClaim =
        itemObj.source === EvidenceSource.AGENT_CLAIM ||
        itemObj.source_type === EvidenceSource.AGENT_CLAIM ||
        itemObj.sourceType === EvidenceSource.AGENT_CLAIM ||
        itemObj.is_agent_claim === true ||
        itemObj.isAgentClaim === true;

      if (isClaim) {
        rejectedClaimsCount++;
        const statement = typeof itemObj.statement === 'string' ? itemObj.statement : 'unspecified claim';
        addFinding(
          'ERR_AGENT_CLAIM_REJECTED',
          ReviewFindingSeverity.WARNING,
          `AGENT_CLAIM rejected as acceptance evidence. Agent claims are unverified assertions: "${statement}"`,
          null,
          itemObj.claim_id ? [String(itemObj.claim_id)] : undefined,
          {
            claim_id: itemObj.claim_id,
            statement: sanitizeEvidenceSecrets(statement),
          }
        );
        continue;
      }

      // Validate as SystemVerifiedEvidence
      const valResult = validateSystemVerifiedEvidence(rawItem);
      if (!valResult.valid || !valResult.evidence) {
        invalidEvidenceCount++;
        const firstIssue = valResult.issues[0];
        addFinding(
          'ERR_INVALID_REVIEW_EVIDENCE',
          ReviewFindingSeverity.WARNING,
          `Evidence verification failed: ${firstIssue ? firstIssue.message : 'Unknown validation issue'}.`,
          null,
          itemObj.evidence_id ? [String(itemObj.evidence_id)] : undefined,
          { issues: valResult.issues }
        );
        continue;
      }

      const evidence = valResult.evidence;

      // Identity Boundary Verification (Section 10)
      const taskMatches = evidence.task_id === request.task_id;
      const projectMatches = evidence.project_id === request.project_id;
      const correlationMatches = evidence.correlation_id === request.correlation_id;

      if (!taskMatches || !projectMatches || !correlationMatches) {
        addFinding(
          'ERR_EVIDENCE_IDENTITY_MISMATCH',
          ReviewFindingSeverity.WARNING,
          `Evidence '${evidence.evidence_id}' has context identity mismatch. Expected task='${request.task_id}', proj='${request.project_id}', corr='${request.correlation_id}', but evidence has task='${evidence.task_id}', proj='${evidence.project_id}', corr='${evidence.correlation_id}'.`,
          null,
          [evidence.evidence_id],
          {
            evidence_id: evidence.evidence_id,
            expected: {
              task_id: request.task_id,
              project_id: request.project_id,
              correlation_id: request.correlation_id,
            },
            actual: {
              task_id: evidence.task_id,
              project_id: evidence.project_id,
              correlation_id: evidence.correlation_id,
            },
          }
        );
        continue;
      }

      validEvidencePool.push(evidence);
    }

    // Sort valid evidence pool deterministically by evidence_id
    validEvidencePool.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));

    // ========================================================================
    // 2. REQUIRED EVIDENCE TOP-LEVEL VERIFICATION (Section 3)
    // ========================================================================
    let missingRequiredEvidence = false;
    if (request.required_evidence && request.required_evidence.length > 0) {
      for (const reqItem of request.required_evidence) {
        const reqStr = String(reqItem);
        // Can match an exact evidence_id or an EvidenceType
        const found = validEvidencePool.some(
          (evi) => evi.evidence_id === reqStr || evi.evidence_type === reqStr
        );
        if (!found) {
          missingRequiredEvidence = true;
          addFinding(
            'ERR_MISSING_REQUIRED_EVIDENCE',
            ReviewFindingSeverity.ERROR,
            `Required evidence '${reqStr}' is missing from valid system verified evidence.`,
            null,
            undefined,
            { required_evidence: reqStr }
          );
        }
      }
    }

    // ========================================================================
    // 3. EVALUATE EACH ACCEPTANCE CRITERION
    // ========================================================================
    const criteriaResults: CriterionResult[] = [];
    const usedEvidenceIds: string[] = [];

    for (const criterion of request.acceptance_criteria) {
      const result = this.evaluateCriterion(criterion, validEvidencePool, addFinding);
      criteriaResults.push(result);
      for (const id of result.evidence_ids) {
        usedEvidenceIds.push(id);
      }
    }

    // ========================================================================
    // 4. DECISION SYNTHESIS (Section 5, 8, 9)
    // ========================================================================
    const mandatoryResults = criteriaResults.filter((r) => {
      const spec = request.acceptance_criteria.find((c) => c.criterion_id === r.criterion_id);
      return spec ? spec.is_mandatory : true;
    });

    const allMandatorySatisfied =
      mandatoryResults.length > 0 && mandatoryResults.every((r) => r.status === CriterionStatus.SATISFIED);

    let decision: ReviewDecision;
    let summary: string;

    // Check blocking conditions
    if (request.blocking_condition) {
      decision = ReviewDecision.BLOCK;
      summary = `Review blocked: ${request.blocking_reason || 'Explicit blocking condition active requiring human intervention.'}`;
    } else if (request.attempt >= request.max_attempts && !allMandatorySatisfied) {
      decision = ReviewDecision.BLOCK;
      summary = `Review blocked: Maximum review attempts exceeded (${request.attempt}/${request.max_attempts}) without satisfying mandatory acceptance criteria.`;
    } else {
      // Check for explicit rejection: any mandatory criterion NOT_SATISFIED
      const hasExplicitFailure = mandatoryResults.some(
        (r) => r.status === CriterionStatus.NOT_SATISFIED
      );

      // Check for conflicting evidence
      const hasConflictingEvidence = mandatoryResults.some(
        (r) => r.status === CriterionStatus.CONFLICTING_EVIDENCE
      );

      // Check for insufficient evidence
      const hasInsufficientEvidence =
        mandatoryResults.some(
          (r) =>
            r.status === CriterionStatus.INSUFFICIENT_EVIDENCE ||
            r.status === CriterionStatus.INVALID_EVIDENCE
        ) || missingRequiredEvidence;

      if (hasExplicitFailure) {
        decision = ReviewDecision.REJECT;
        const failedIds = mandatoryResults
          .filter((r) => r.status === CriterionStatus.NOT_SATISFIED)
          .map((r) => r.criterion_id)
          .sort();
        summary = `Review rejected: One or more mandatory acceptance criteria failed verification [${failedIds.join(', ')}].`;
      } else if (hasConflictingEvidence) {
        decision = ReviewDecision.REQUEST_CONTEXT;
        const conflictIds = mandatoryResults
          .filter((r) => r.status === CriterionStatus.CONFLICTING_EVIDENCE)
          .map((r) => r.criterion_id)
          .sort();
        summary = `Review requires additional context: Conflicting system verified evidence detected for [${conflictIds.join(', ')}].`;
      } else if (hasInsufficientEvidence) {
        decision = ReviewDecision.REQUEST_CONTEXT;
        const missingIds = mandatoryResults
          .filter((r) => r.status === CriterionStatus.INSUFFICIENT_EVIDENCE)
          .map((r) => r.criterion_id)
          .sort();
        summary = `Review requires additional context: Insufficient system verified evidence to prove criteria [${missingIds.join(', ')}].`;
      } else if (allMandatorySatisfied) {
        decision = ReviewDecision.ACCEPT;
        summary = `All mandatory acceptance criteria (${mandatoryResults.length}/${mandatoryResults.length}) satisfied by valid system verified evidence.`;
      } else {
        decision = ReviewDecision.REQUEST_CONTEXT;
        summary = 'Review requires additional context: Incomplete evidence evaluation state.';
      }
    }

    return Object.freeze({
      task_id: request.task_id,
      project_id: request.project_id,
      correlation_id: request.correlation_id,
      attempt: request.attempt,
      max_attempts: request.max_attempts,
      decision,
      summary: sanitizeEvidenceSecrets(summary),
      all_mandatory_satisfied: allMandatorySatisfied,
      criteria_results: Object.freeze(criteriaResults),
      findings: Object.freeze(findings),
      evidence_ids_used: Object.freeze(deduplicateStrings(usedEvidenceIds)),
      rejected_claims_count: rejectedClaimsCount,
      invalid_evidence_count: invalidEvidenceCount,
      evaluated_at: null, // Deterministic: null by default to guarantee byte-for-byte replay
    });
  }

  // ==========================================================================
  // CRITERION EVALUATOR
  // ==========================================================================

  private evaluateCriterion(
    criterion: AcceptanceCriterion,
    evidencePool: readonly SystemVerifiedEvidence[],
    addFinding: (
      code: string,
      severity: ReviewFindingSeverity,
      rawMessage: string,
      criterionId?: string | null,
      evidenceIds?: readonly string[],
      details?: Record<string, unknown>
    ) => void
  ): CriterionResult {
    // 1. Filter evidence candidate items based on criterion type and command
    let candidates = evidencePool.filter((evi) => {
      switch (criterion.criterion_type) {
        case CriterionType.COMMAND:
          return (
            evi.evidence_type === EvidenceType.COMMAND ||
            evi.evidence_type === EvidenceType.TEST ||
            evi.evidence_type === EvidenceType.BUILD
          );
        case CriterionType.TEST:
          return (
            evi.evidence_type === EvidenceType.TEST ||
            evi.command.toLowerCase().includes('test')
          );
        case CriterionType.BUILD:
          return (
            evi.evidence_type === EvidenceType.BUILD ||
            evi.command.toLowerCase().includes('build')
          );
        case CriterionType.GIT:
        case CriterionType.DIFF:
          return (
            evi.evidence_type === EvidenceType.GIT ||
            evi.evidence_type === EvidenceType.DIFF ||
            evi.unified_diff !== null ||
            evi.git_head_after !== null
          );
        case CriterionType.FILE_HASH:
          return (
            evi.evidence_type === EvidenceType.FILE_HASH ||
            (evi.file_hashes_after !== null && Object.keys(evi.file_hashes_after).length > 0)
          );
        case CriterionType.CUSTOM:
        default:
          return true;
      }
    });

    // If expected_command is specified, narrow candidates to matching command
    if (criterion.expected_command) {
      const expCmd = criterion.expected_command.trim().toLowerCase();
      candidates = candidates.filter((evi) => {
        const actualCmd = evi.command.trim().toLowerCase();
        return actualCmd === expCmd || actualCmd.includes(expCmd);
      });
    }

    // 2. Insufficient evidence check: no matching candidates
    if (candidates.length === 0) {
      return Object.freeze({
        criterion_id: criterion.criterion_id,
        satisfied: false,
        status: CriterionStatus.INSUFFICIENT_EVIDENCE,
        evidence_ids: Object.freeze([]),
        reason: `No system verified evidence found matching criterion '${criterion.criterion_id}' (${criterion.description}).`,
        missing_evidence: Object.freeze([criterion.criterion_id]),
        conflicting_evidence: Object.freeze([]),
      });
    }

    // 3. Evidence Conflict Detection (Section 9)
    // Check if candidates contain conflicting results (e.g. exit_code 0 vs exit_code != 0 for same command,
    // or different hashes for the same file in file_hashes_after)
    const conflictingEvidenceIds: string[] = [];

    // Check exit code conflicts for matching commands
    const commandMap = new Map<string, { zero: string[]; nonZero: string[] }>();
    for (const evi of candidates) {
      const cmdKey = evi.command.trim();
      let entry = commandMap.get(cmdKey);
      if (!entry) {
        entry = { zero: [], nonZero: [] };
        commandMap.set(cmdKey, entry);
      }
      if (evi.exit_code === 0) {
        entry.zero.push(evi.evidence_id);
      } else {
        entry.nonZero.push(evi.evidence_id);
      }
    }

    for (const [, entry] of commandMap.entries()) {
      if (entry.zero.length > 0 && entry.nonZero.length > 0) {
        for (const id of [...entry.zero, ...entry.nonZero]) {
          conflictingEvidenceIds.push(id);
        }
      }
    }

    // Check file hash conflicts
    const fileHashMap = new Map<string, Map<string, string[]>>();
    for (const evi of candidates) {
      if (evi.file_hashes_after) {
        for (const [filePath, hash] of Object.entries(evi.file_hashes_after)) {
          let hashSubMap = fileHashMap.get(filePath);
          if (!hashSubMap) {
            hashSubMap = new Map<string, string[]>();
            fileHashMap.set(filePath, hashSubMap);
          }
          let idList = hashSubMap.get(hash);
          if (!idList) {
            idList = [];
            hashSubMap.set(hash, idList);
          }
          idList.push(evi.evidence_id);
        }
      }
    }

    for (const [, hashSubMap] of fileHashMap.entries()) {
      if (hashSubMap.size > 1) {
        for (const idList of hashSubMap.values()) {
          for (const id of idList) {
            conflictingEvidenceIds.push(id);
          }
        }
      }
    }

    if (conflictingEvidenceIds.length > 0) {
      const dedupedConflicts = deduplicateStrings(conflictingEvidenceIds);
      const allCandidateIds = sortStrings(candidates.map((e) => e.evidence_id));
      addFinding(
        'ERR_CONFLICTING_EVIDENCE',
        ReviewFindingSeverity.WARNING,
        `Criterion '${criterion.criterion_id}' has conflicting system verified evidence [${dedupedConflicts.join(', ')}].`,
        criterion.criterion_id,
        dedupedConflicts,
        { criterion_id: criterion.criterion_id, conflicting_evidence: dedupedConflicts }
      );

      return Object.freeze({
        criterion_id: criterion.criterion_id,
        satisfied: false,
        status: CriterionStatus.CONFLICTING_EVIDENCE,
        evidence_ids: Object.freeze(allCandidateIds),
        reason: `Conflicting system verified evidence detected for criterion '${criterion.criterion_id}' across evidence [${dedupedConflicts.join(', ')}].`,
        missing_evidence: Object.freeze([]),
        conflicting_evidence: Object.freeze(dedupedConflicts),
      });
    }

    // 4. Evaluate Specific Verification Rules
    const matchedEvidenceIds: string[] = [];

    for (const evi of candidates) {
      // Check exit code
      if (criterion.expected_exit_code !== undefined) {
        if (evi.exit_code !== criterion.expected_exit_code) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.NOT_SATISFIED,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Process '${evi.command}' exited with code ${evi.exit_code} (expected ${criterion.expected_exit_code}).`,
            missing_evidence: Object.freeze([]),
            conflicting_evidence: Object.freeze([]),
          });
        }
      }

      // Check working directory
      if (criterion.working_directory) {
        const expectedDir = criterion.working_directory.trim().toLowerCase();
        const actualDir = evi.working_directory.trim().toLowerCase();
        if (!actualDir.includes(expectedDir) && actualDir !== expectedDir) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.NOT_SATISFIED,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Execution working directory '${evi.working_directory}' does not match expected '${criterion.working_directory}'.`,
            missing_evidence: Object.freeze([]),
            conflicting_evidence: Object.freeze([]),
          });
        }
      }

      // Check stdout_contains
      if (criterion.stdout_contains && criterion.stdout_contains.length > 0) {
        if (!evi.stdout_tail) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.INSUFFICIENT_EVIDENCE,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Expected standard output containing patterns, but evidence '${evi.evidence_id}' has no stdout captured.`,
            missing_evidence: Object.freeze(criterion.stdout_contains),
            conflicting_evidence: Object.freeze([]),
          });
        }
        for (const pattern of criterion.stdout_contains) {
          if (!evi.stdout_tail.includes(pattern)) {
            return Object.freeze({
              criterion_id: criterion.criterion_id,
              satisfied: false,
              status: CriterionStatus.NOT_SATISFIED,
              evidence_ids: Object.freeze([evi.evidence_id]),
              reason: `Evidence standard output does not contain expected pattern '${pattern}'.`,
              missing_evidence: Object.freeze([]),
              conflicting_evidence: Object.freeze([]),
            });
          }
        }
      }

      // Check stderr_contains
      if (criterion.stderr_contains && criterion.stderr_contains.length > 0) {
        if (!evi.stderr) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.INSUFFICIENT_EVIDENCE,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Expected standard error containing patterns, but evidence '${evi.evidence_id}' has no stderr captured.`,
            missing_evidence: Object.freeze(criterion.stderr_contains),
            conflicting_evidence: Object.freeze([]),
          });
        }
        for (const pattern of criterion.stderr_contains) {
          if (!evi.stderr.includes(pattern)) {
            return Object.freeze({
              criterion_id: criterion.criterion_id,
              satisfied: false,
              status: CriterionStatus.NOT_SATISFIED,
              evidence_ids: Object.freeze([evi.evidence_id]),
              reason: `Evidence standard error does not contain expected pattern '${pattern}'.`,
              missing_evidence: Object.freeze([]),
              conflicting_evidence: Object.freeze([]),
            });
          }
        }
      }

      // Check output_disallowed
      if (criterion.output_disallowed && criterion.output_disallowed.length > 0) {
        const fullOutput = `${evi.stdout_tail ?? ''}\n${evi.stderr ?? ''}`;
        for (const disallowed of criterion.output_disallowed) {
          if (fullOutput.includes(disallowed)) {
            return Object.freeze({
              criterion_id: criterion.criterion_id,
              satisfied: false,
              status: CriterionStatus.NOT_SATISFIED,
              evidence_ids: Object.freeze([evi.evidence_id]),
              reason: `Output contains disallowed pattern '${disallowed}'.`,
              missing_evidence: Object.freeze([]),
              conflicting_evidence: Object.freeze([]),
            });
          }
        }
      }

      // Check required_files in file_hashes_after
      if (criterion.required_files && criterion.required_files.length > 0) {
        if (!evi.file_hashes_after) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.INSUFFICIENT_EVIDENCE,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Criterion requires files [${criterion.required_files.join(', ')}], but evidence '${evi.evidence_id}' has no file_hashes_after.`,
            missing_evidence: Object.freeze(sortStrings(criterion.required_files)),
            conflicting_evidence: Object.freeze([]),
          });
        }
        const missingFiles = criterion.required_files.filter(
          (file) => !evi.file_hashes_after![file]
        );
        if (missingFiles.length > 0) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.INSUFFICIENT_EVIDENCE,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Evidence '${evi.evidence_id}' is missing required file hashes for [${missingFiles.join(', ')}].`,
            missing_evidence: Object.freeze(sortStrings(missingFiles)),
            conflicting_evidence: Object.freeze([]),
          });
        }
      }

      // Check file_hashes exact matches
      if (criterion.file_hashes) {
        if (!evi.file_hashes_after) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.INSUFFICIENT_EVIDENCE,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Criterion specifies expected file hashes, but evidence '${evi.evidence_id}' has no file_hashes_after.`,
            missing_evidence: Object.freeze(sortStrings(Object.keys(criterion.file_hashes))),
            conflicting_evidence: Object.freeze([]),
          });
        }
        for (const [file, expectedHash] of Object.entries(criterion.file_hashes)) {
          const actualHash = evi.file_hashes_after[file];
          if (!actualHash) {
            return Object.freeze({
              criterion_id: criterion.criterion_id,
              satisfied: false,
              status: CriterionStatus.INSUFFICIENT_EVIDENCE,
              evidence_ids: Object.freeze([evi.evidence_id]),
              reason: `Evidence '${evi.evidence_id}' is missing expected hash for file '${file}'.`,
              missing_evidence: Object.freeze([file]),
              conflicting_evidence: Object.freeze([]),
            });
          }
          if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
            return Object.freeze({
              criterion_id: criterion.criterion_id,
              satisfied: false,
              status: CriterionStatus.NOT_SATISFIED,
              evidence_ids: Object.freeze([evi.evidence_id]),
              reason: `File hash mismatch for '${file}': received ${actualHash}, expected ${expectedHash}.`,
              missing_evidence: Object.freeze([]),
              conflicting_evidence: Object.freeze([]),
            });
          }
        }
      }

      // Check require_diff
      if (criterion.require_diff === true) {
        if (!evi.unified_diff || evi.unified_diff.trim().length === 0) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.NOT_SATISFIED,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Evidence '${evi.evidence_id}' has no unified_diff, but diff is required.`,
            missing_evidence: Object.freeze([]),
            conflicting_evidence: Object.freeze([]),
          });
        }
      }

      // Check disallowed_diff_patterns (e.g. scanner.ts)
      if (
        criterion.disallowed_diff_patterns &&
        criterion.disallowed_diff_patterns.length > 0 &&
        evi.unified_diff
      ) {
        for (const pattern of criterion.disallowed_diff_patterns) {
          if (evi.unified_diff.includes(pattern)) {
            return Object.freeze({
              criterion_id: criterion.criterion_id,
              satisfied: false,
              status: CriterionStatus.NOT_SATISFIED,
              evidence_ids: Object.freeze([evi.evidence_id]),
              reason: `Unified diff in evidence '${evi.evidence_id}' contains disallowed diff pattern '${pattern}'.`,
              missing_evidence: Object.freeze([]),
              conflicting_evidence: Object.freeze([]),
            });
          }
        }
      }

      // Check expected_git_head
      if (criterion.expected_git_head) {
        if (evi.git_head_after !== criterion.expected_git_head) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.NOT_SATISFIED,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: `Git HEAD after execution (${evi.git_head_after}) does not match expected (${criterion.expected_git_head}).`,
            missing_evidence: Object.freeze([]),
            conflicting_evidence: Object.freeze([]),
          });
        }
      }

      // Check custom predicate if provided
      if (criterion.predicate) {
        const predResult = criterion.predicate([evi]);
        if (!predResult.satisfied) {
          return Object.freeze({
            criterion_id: criterion.criterion_id,
            satisfied: false,
            status: CriterionStatus.NOT_SATISFIED,
            evidence_ids: Object.freeze([evi.evidence_id]),
            reason: predResult.reason || `Custom predicate evaluation failed for '${criterion.criterion_id}'.`,
            missing_evidence: Object.freeze([]),
            conflicting_evidence: Object.freeze([]),
          });
        }
      }

      matchedEvidenceIds.push(evi.evidence_id);
    }

    // 5. If we reach here with at least one matching evidence item, criterion is SATISFIED
    const sortedMatchedIds = sortStrings(matchedEvidenceIds);
    return Object.freeze({
      criterion_id: criterion.criterion_id,
      satisfied: true,
      status: CriterionStatus.SATISFIED,
      evidence_ids: Object.freeze(sortedMatchedIds),
      reason: `Satisfied by system verified evidence: [${sortedMatchedIds.join(', ')}].`,
      missing_evidence: Object.freeze([]),
      conflicting_evidence: Object.freeze([]),
    });
  }
}
