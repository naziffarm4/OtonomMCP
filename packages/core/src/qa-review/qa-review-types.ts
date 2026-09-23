/**
 * Phase 4 QA Review Engine Contracts & Types
 *
 * Defines strongly typed models for review requests, criteria, evaluation statuses,
 * deterministic decisions (ACCEPT, REJECT, REQUEST_CONTEXT, BLOCK), findings, and traceability.
 */

import type { SystemVerifiedEvidence, EvidenceType, AgentClaim } from '../evidence/evidence-types.js';

// ============================================================================
// 1. REVIEW DECISION CONTRACT
// ============================================================================

export const ReviewDecision = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  REQUEST_CONTEXT: 'REQUEST_CONTEXT',
  BLOCK: 'BLOCK',
} as const;

export type ReviewDecision = (typeof ReviewDecision)[keyof typeof ReviewDecision];
export const REVIEW_DECISIONS = Object.values(ReviewDecision) as readonly ReviewDecision[];

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === 'string' && (REVIEW_DECISIONS as readonly string[]).includes(value);
}

// ============================================================================
// 2. CRITERION EVALUATION STATUS
// ============================================================================

export const CriterionStatus = {
  SATISFIED: 'SATISFIED',
  NOT_SATISFIED: 'NOT_SATISFIED',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  INVALID_EVIDENCE: 'INVALID_EVIDENCE',
  CONFLICTING_EVIDENCE: 'CONFLICTING_EVIDENCE',
} as const;

export type CriterionStatus = (typeof CriterionStatus)[keyof typeof CriterionStatus];
export const CRITERION_STATUSES = Object.values(CriterionStatus) as readonly CriterionStatus[];

export function isCriterionStatus(value: unknown): value is CriterionStatus {
  return typeof value === 'string' && (CRITERION_STATUSES as readonly string[]).includes(value);
}

// ============================================================================
// 3. CRITERION CLASSIFICATION TYPES
// ============================================================================

export const CriterionType = {
  COMMAND: 'COMMAND',
  TEST: 'TEST',
  BUILD: 'BUILD',
  GIT: 'GIT',
  DIFF: 'DIFF',
  FILE_HASH: 'FILE_HASH',
  CUSTOM: 'CUSTOM',
  UI: 'UI',
} as const;

export type CriterionType = (typeof CriterionType)[keyof typeof CriterionType];
export const CRITERION_TYPES = Object.values(CriterionType) as readonly CriterionType[];

export function isCriterionType(value: unknown): value is CriterionType {
  return typeof value === 'string' && (CRITERION_TYPES as readonly string[]).includes(value);
}

// ============================================================================
// 4. FINDING SEVERITY
// ============================================================================

export const ReviewFindingSeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  BLOCKING: 'BLOCKING',
} as const;

export type ReviewFindingSeverity =
  (typeof ReviewFindingSeverity)[keyof typeof ReviewFindingSeverity];

// ============================================================================
// 5. ACCEPTANCE CRITERION SPECIFICATION
// ============================================================================

export interface AcceptanceCriterion {
  /** Stable identifier, e.g. 'AC-001' */
  readonly criterion_id: string;
  /** Human-readable description of requirement */
  readonly description: string;
  /** Category of criterion */
  readonly criterion_type: CriterionType;
  /** Whether satisfying this criterion is mandatory for overall ACCEPT (default true) */
  readonly is_mandatory: boolean;
  /** Expected command string (exact match or prefix/substring) */
  readonly expected_command?: string;
  /** Expected process exit code (defaults to 0 for commands/test/build) */
  readonly expected_exit_code?: number;
  /** Expected working directory substring or exact match */
  readonly working_directory?: string;
  /** Substrings or patterns that must appear in stdout */
  readonly stdout_contains?: readonly string[];
  /** Substrings or patterns that must appear in stderr */
  readonly stderr_contains?: readonly string[];
  /** Substrings or patterns that must NOT appear in stdout or stderr */
  readonly output_disallowed?: readonly string[];
  /** Specific file paths required to exist or have evidence */
  readonly required_files?: readonly string[];
  /** Expected SHA-256 hashes for specific files */
  readonly file_hashes?: Readonly<Record<string, string>>;
  /** Whether unified_diff must be present and non-empty */
  readonly require_diff?: boolean;
  /** Disallowed diff patterns (e.g. scanner.ts must have 0 diff) */
  readonly disallowed_diff_patterns?: readonly string[];
  /** Expected git head reference */
  readonly expected_git_head?: string;
  /** Optional deterministic evaluation predicate */
  readonly predicate?: (
    evidence: readonly SystemVerifiedEvidence[]
  ) => { satisfied: boolean; reason?: string };
  /** Metadata associated with criterion */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface AcceptanceCriterionInput {
  criterion_id?: string;
  criterionId?: string;
  description?: string;
  criterion_type?: CriterionType | string;
  criterionType?: CriterionType | string;
  is_mandatory?: boolean;
  isMandatory?: boolean;
  mandatory?: boolean;
  expected_command?: string;
  expectedCommand?: string;
  expected_exit_code?: number;
  expectedExitCode?: number;
  working_directory?: string;
  workingDirectory?: string;
  stdout_contains?: string[] | string;
  stdoutContains?: string[] | string;
  stderr_contains?: string[] | string;
  stderrContains?: string[] | string;
  output_disallowed?: string[] | string;
  outputDisallowed?: string[] | string;
  required_files?: string[];
  requiredFiles?: string[];
  file_hashes?: Record<string, string>;
  fileHashes?: Record<string, string>;
  require_diff?: boolean;
  requireDiff?: boolean;
  disallowed_diff_patterns?: string[];
  disallowedDiffPatterns?: string[];
  expected_git_head?: string;
  expectedGitHead?: string;
  predicate?: (
    evidence: readonly SystemVerifiedEvidence[]
  ) => { satisfied: boolean; reason?: string };
  metadata?: Record<string, unknown> | null;
}

// ============================================================================
// 6. CRITERION EVALUATION RESULT
// ============================================================================

export interface CriterionResult {
  readonly criterion_id: string;
  readonly satisfied: boolean;
  readonly status: CriterionStatus;
  readonly evidence_ids: readonly string[];
  readonly reason: string;
  readonly missing_evidence: readonly string[];
  readonly conflicting_evidence: readonly string[];
}

// ============================================================================
// 7. REVIEW FINDING
// ============================================================================

export interface ReviewFinding {
  readonly criterion_id?: string | null;
  readonly code: string;
  readonly severity: ReviewFindingSeverity;
  readonly message: string;
  readonly evidence_ids?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 8. REVIEW REQUEST CONTRACT
// ============================================================================

export interface ReviewRequest {
  readonly task_id: string;
  readonly project_id: string;
  readonly correlation_id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly acceptance_criteria: readonly AcceptanceCriterion[];
  readonly required_evidence?: readonly (string | EvidenceType)[];
  readonly evidence: readonly (SystemVerifiedEvidence | AgentClaim | unknown)[];
  readonly traceability?: Readonly<Record<string, unknown>> | null;
  readonly blocking_condition?: boolean;
  readonly blocking_reason?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface ReviewRequestInput {
  task_id?: string;
  taskId?: string;
  project_id?: string;
  projectId?: string;
  correlation_id?: string;
  correlationId?: string;
  attempt?: number;
  max_attempts?: number;
  maxAttempts?: number;
  acceptance_criteria?: readonly AcceptanceCriterionInput[];
  acceptanceCriteria?: readonly AcceptanceCriterionInput[];
  required_evidence?: readonly (string | EvidenceType)[];
  requiredEvidence?: readonly (string | EvidenceType)[];
  evidence?: readonly (SystemVerifiedEvidence | AgentClaim | unknown)[];
  traceability?: Record<string, unknown> | null;
  blocking_condition?: boolean;
  blockingCondition?: boolean;
  blocking_reason?: string | null;
  blockingReason?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ============================================================================
// 9. REVIEW RESULT CONTRACT
// ============================================================================

export interface ReviewResult {
  readonly task_id: string;
  readonly project_id: string;
  readonly correlation_id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly decision: ReviewDecision;
  readonly summary: string;
  readonly all_mandatory_satisfied: boolean;
  readonly criteria_results: readonly CriterionResult[];
  readonly findings: readonly ReviewFinding[];
  readonly evidence_ids_used: readonly string[];
  readonly rejected_claims_count: number;
  readonly invalid_evidence_count: number;
  readonly evaluated_at: string | null;
}
