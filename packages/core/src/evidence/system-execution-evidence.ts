/**
 * System Execution Evidence Contract (Phase 10 TASK-P10-04)
 *
 * Defines the authoritative, strongly-typed contract for independently collected
 * and verified execution evidence produced by the System Evidence Verification Pipeline.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. INDEPENDENT SYSTEM EVIDENCE: Evidence is produced deterministically by the system itself
 *    (via Git, OS process runner, and objective criteria evaluation), NEVER by trusting executor claims.
 * 2. NO FABRICATED VERIFICATION: Must NEVER accept fake verification flags from the executor
 *    (e.g., verified, qaPassed, systemAccepted, taskCompleted, systemApproved).
 * 3. STRICT DECISION BOUNDS: verificationDecision is strictly one of 'ACCEPT' | 'REJECT' | 'BLOCK'.
 * 4. REQUEST TRACEABILITY & DETERMINISM: evidenceId is deterministically derived from requestId
 *    and canonical SHA-256 hash of verified attributes.
 * 5. IMMUTABLE RAW OUTCOME SEPARATION: References the RawExecutorOutcome status without mutating it.
 * 6. ZERO MUTATION: P10-04 is a verification boundary only; it does NOT mutate DAG, state, or approval stores.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import {
  SystemEvidenceSecurityViolationError,
  SystemEvidenceValidationError,
} from '../director/director-errors.js';
import { FORBIDDEN_VERIFICATION_FIELDS } from '../executor-bridge/raw-executor-outcome.js';
import {
  SHELL_INJECTION_PATTERN,
  WINDOWS_DRIVE_PATTERN,
  UNC_PATH_PATTERN,
} from '../executor-bridge/executor-guard.js';

// Re-export for convenience where needed without re-declaring
export { FORBIDDEN_VERIFICATION_FIELDS };

// ============================================================================
// 1. VERIFICATION DECISION & CHECK TAXONOMY
// ============================================================================

export type VerificationDecision = 'ACCEPT' | 'REJECT' | 'BLOCK';

export const VERIFICATION_DECISIONS: readonly VerificationDecision[] = Object.freeze([
  'ACCEPT',
  'REJECT',
  'BLOCK',
]);

export function isVerificationDecision(val: unknown): val is VerificationDecision {
  return typeof val === 'string' && (VERIFICATION_DECISIONS as readonly string[]).includes(val);
}

export type VerificationCheckStatus = 'PASS' | 'FAIL' | 'BLOCK';

export const VERIFICATION_CHECK_STATUSES: readonly VerificationCheckStatus[] = Object.freeze([
  'PASS',
  'FAIL',
  'BLOCK',
]);

export function isVerificationCheckStatus(val: unknown): val is VerificationCheckStatus {
  return typeof val === 'string' && (VERIFICATION_CHECK_STATUSES as readonly string[]).includes(val);
}

// ============================================================================
// 2. FORBIDDEN VERIFICATION FIELDS GUARD
// ============================================================================

/**
 * Asserts that the given input contains no forbidden fake executor verification fields.
 * Throws SystemEvidenceSecurityViolationError if any forbidden field is detected.
 */
export function assertNoForbiddenEvidenceFields(data: unknown): void {
  if (!data || typeof data !== 'object') {
    return;
  }
  const record = data as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_VERIFICATION_FIELDS) {
    if (forbidden in record && record[forbidden] !== undefined) {
      throw new SystemEvidenceSecurityViolationError(
        `Forbidden fake verification field '${forbidden}' detected in evidence input. Executor cannot fabricate verification claims.`,
        { forbiddenField: forbidden }
      );
    }
  }
}

// ============================================================================
// 3. PATH INTEGRITY & SAFETY FOR EVIDENCE
// ============================================================================

/**
 * Validates whether a file path conforms to safe relative path constraints.
 * Path traversal (..), absolute paths, Windows drive paths, UNC paths, and null bytes are rejected.
 */
export function isSafeRelativePath(filePath: string): boolean {
  if (typeof filePath !== 'string') return false;
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('\0')) return false;
  if (SHELL_INJECTION_PATTERN.test(trimmed)) return false;
  if (WINDOWS_DRIVE_PATTERN.test(trimmed)) return false;
  if (UNC_PATH_PATTERN.test(trimmed)) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;

  // Traversal check: check path segments
  const segments = trimmed.replace(/\\/g, '/').split('/');
  for (const segment of segments) {
    if (segment === '..') {
      return false;
    }
  }
  return true;
}

/**
 * Asserts that a file path is safe for inclusion in system evidence.
 * Throws SystemEvidenceSecurityViolationError if unsafe.
 */
export function assertSafeEvidencePath(filePath: string, context = 'changedFiles'): void {
  if (!isSafeRelativePath(filePath)) {
    throw new SystemEvidenceSecurityViolationError(
      `Unsafe path detected in ${context}: '${filePath}'. Path traversal and absolute paths cannot enter evidence.`,
      { path: filePath, context }
    );
  }
}

// ============================================================================
// 4. SUB-CONTRACTS
// ============================================================================

export interface RepositoryStateEvidence {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly isClean: boolean;
}

export interface ChangedFileEvidence {
  readonly path: string;
  readonly status: string;
}

export interface VerificationCheck {
  readonly checkId: string;
  readonly type: string;
  readonly status: VerificationCheckStatus;
  readonly command?: string;
  readonly evidence?: string;
  readonly durationMs?: number;
  readonly details?: unknown;
}

export interface AcceptanceCriterionResult {
  readonly criterion: string;
  readonly status: VerificationCheckStatus;
  readonly evidence: string;
  readonly criterionId?: string;
  readonly mandatory?: boolean;
}

export interface ExecutorOutcomeReference {
  readonly status: string;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
}

// ============================================================================
// 5. SYSTEM EXECUTION EVIDENCE PRIMARY CONTRACT
// ============================================================================

export interface SystemExecutionEvidence {
  /** Deterministic evidence ID traceable to requestId */
  readonly evidenceId: string;
  /** Preserved exact requestId from ExecutionRequest */
  readonly requestId: string;

  /** Preserved project identifier */
  readonly projectId: string;
  /** Preserved task identifier */
  readonly taskId: string;
  /** Preserved task revision */
  readonly taskRevision: number;

  /** Preserved context fingerprint */
  readonly contextFingerprint: string;
  /** Preserved understanding baseline revision */
  readonly understandingRevision: number;
  /** Preserved approval package revision */
  readonly approvalPackageRevision: number;

  /** Independently inspected Git repository state */
  readonly repositoryState: RepositoryStateEvidence;
  /** Independently collected changed files */
  readonly changedFiles: readonly ChangedFileEvidence[];
  /** Independent system verification checks (test, typecheck, build, scope, binding) */
  readonly verificationChecks: readonly VerificationCheck[];
  /** Objective evaluation of each acceptance criterion */
  readonly acceptanceCriteria: readonly AcceptanceCriterionResult[];
  /** Non-authoritative reference to executor outcome status */
  readonly executorOutcomeReference: ExecutorOutcomeReference;
  /** Authoritative system verification decision */
  readonly verificationDecision: VerificationDecision;
  /** ISO 8601 timestamp of verification completion */
  readonly verifiedAt: string;
  /** Optional sanitized metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// Type aliases for seamless interoperability
export type SystemVerifiedExecutionEvidence = SystemExecutionEvidence;

// ============================================================================
// 6. ZOD SCHEMAS
// ============================================================================

export const RepositoryStateEvidenceZodSchema = z.object({
  baseCommit: z.string().min(1),
  headCommit: z.string().min(1),
  isClean: z.boolean(),
});

export const ChangedFileEvidenceZodSchema = z.object({
  path: z.string().min(1).refine(isSafeRelativePath, {
    message: 'Changed file path must be a safe POSIX relative path without traversal or drive prefix',
  }),
  status: z.string().min(1),
});

export const VerificationCheckZodSchema = z.object({
  checkId: z.string().min(1),
  type: z.string().min(1),
  status: z.enum(['PASS', 'FAIL', 'BLOCK']),
  command: z.string().optional(),
  evidence: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  details: z.unknown().optional(),
});

export const AcceptanceCriterionResultZodSchema = z.object({
  criterion: z.string().min(1),
  status: z.enum(['PASS', 'FAIL', 'BLOCK']),
  evidence: z.string(),
  criterionId: z.string().optional(),
  mandatory: z.boolean().optional(),
});

export const ExecutorOutcomeReferenceZodSchema = z.object({
  status: z.string().min(1),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export const SystemExecutionEvidenceZodSchema = z
  .object({
    evidenceId: z.string().min(1),
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    taskRevision: z.number().int().positive(),
    contextFingerprint: z.string().min(1),
    understandingRevision: z.number().int().positive(),
    approvalPackageRevision: z.number().int().positive(),
    repositoryState: RepositoryStateEvidenceZodSchema,
    changedFiles: z.array(ChangedFileEvidenceZodSchema),
    verificationChecks: z.array(VerificationCheckZodSchema),
    acceptanceCriteria: z.array(AcceptanceCriterionResultZodSchema),
    executorOutcomeReference: ExecutorOutcomeReferenceZodSchema,
    verificationDecision: z.enum(['ACCEPT', 'REJECT', 'BLOCK']),
    verifiedAt: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((val, ctx) => {
    // Assert no forbidden fields masquerading as verification flags
    for (const forbidden of FORBIDDEN_VERIFICATION_FIELDS) {
      if (forbidden in val && (val as Record<string, unknown>)[forbidden] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Forbidden field '${forbidden}' detected in evidence.`,
          path: [forbidden],
        });
      }
    }
  });

// ============================================================================
// 7. DETERMINISTIC EVIDENCE ID GENERATION
// ============================================================================

export interface ComputeEvidenceIdInput {
  readonly requestId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly contextFingerprint: string;
  readonly headCommit: string;
  readonly verificationDecision: string;
  readonly checkSummary?: string;
}

/**
 * Computes a deterministic evidence ID traceable to requestId.
 * Uses SHA-256 over canonical JSON string of semantic verification fields.
 */
export function computeDeterministicEvidenceId(input: ComputeEvidenceIdInput): string {
  const canonical = JSON.stringify({
    requestId: input.requestId,
    projectId: input.projectId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    contextFingerprint: input.contextFingerprint,
    headCommit: input.headCommit,
    verificationDecision: input.verificationDecision,
    checkSummary: input.checkSummary ?? '',
  });

  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  const sanitizedReq = input.requestId.replace(/^req_/, '').slice(0, 16);
  return `evi_${sanitizedReq}_${hash.slice(0, 16)}`;
}
