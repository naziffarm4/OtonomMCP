import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import { sanitizeEvidenceSecrets, sanitizeEvidenceDetails } from './evidence-error.js';

export type QAReviewErrorCode =
  | 'ERR_QA_REVIEW_GENERAL'
  | 'ERR_INVALID_REVIEW_REQUEST'
  | 'ERR_MISSING_ACCEPTANCE_CRITERIA'
  | 'ERR_INVALID_REVIEW_EVIDENCE'
  | 'ERR_EVIDENCE_IDENTITY_MISMATCH'
  | 'ERR_UNSUPPORTED_CRITERION_TYPE'
  | 'ERR_CONFLICTING_EVIDENCE'
  | 'ERR_BLOCKED_REVIEW';

export interface QAReviewErrorDetails extends AidmErrorDetails {
  taskId?: string;
  projectId?: string;
  correlationId?: string;
  criterionId?: string;
  evidenceId?: string;
  conflictingEvidenceIds?: readonly string[];
  reason?: string;
  field?: string;
  decision?: string;
  cause?: unknown;
}

/**
 * Base structured error class for all QA Review Engine failures.
 * Extends AidmError and ensures secret sanitization across messages and details.
 */
export class QAReviewError extends AidmError {
  readonly taskId?: string;
  readonly projectId?: string;
  readonly correlationId?: string;
  readonly criterionId?: string;
  readonly evidenceId?: string;
  readonly conflictingEvidenceIds?: readonly string[];
  readonly reason?: string;
  readonly field?: string;

  constructor(
    message: string,
    code: QAReviewErrorCode = 'ERR_QA_REVIEW_GENERAL',
    details?: QAReviewErrorDetails
  ) {
    const sanitizedMsg = sanitizeEvidenceSecrets(message);
    const sanitizedDetails = sanitizeEvidenceDetails(details) as QAReviewErrorDetails | undefined;
    const formattedMessage = sanitizedMsg.startsWith(`[${code}]`)
      ? sanitizedMsg
      : `[${code}] ${sanitizedMsg}`;

    super(formattedMessage, code, sanitizedDetails);
    this.name = 'QAReviewError';
    this.taskId = sanitizedDetails?.taskId;
    this.projectId = sanitizedDetails?.projectId;
    this.correlationId = sanitizedDetails?.correlationId;
    this.criterionId = sanitizedDetails?.criterionId;
    this.evidenceId = sanitizedDetails?.evidenceId;
    this.conflictingEvidenceIds = sanitizedDetails?.conflictingEvidenceIds;
    this.reason = sanitizedDetails?.reason;
    this.field = sanitizedDetails?.field;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a review request fails structural validation.
 */
export class InvalidReviewRequestError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_INVALID_REVIEW_REQUEST', details);
    this.name = 'InvalidReviewRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a review request is missing required acceptance criteria.
 */
export class MissingAcceptanceCriteriaError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_MISSING_ACCEPTANCE_CRITERIA', details);
    this.name = 'MissingAcceptanceCriteriaError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when evidence supplied for review fails verification or has an invalid structure.
 */
export class InvalidReviewEvidenceError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_INVALID_REVIEW_EVIDENCE', details);
    this.name = 'InvalidReviewEvidenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when evidence task/project/correlation does not match review scope.
 */
export class EvidenceIdentityMismatchError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_EVIDENCE_IDENTITY_MISMATCH', details);
    this.name = 'EvidenceIdentityMismatchError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an unrecognized or unsupported acceptance criterion type is encountered.
 */
export class UnsupportedCriterionTypeError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_UNSUPPORTED_CRITERION_TYPE', details);
    this.name = 'UnsupportedCriterionTypeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when irreconcilable conflicting evidence prevents a deterministic decision.
 */
export class ConflictingEvidenceError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_CONFLICTING_EVIDENCE', details);
    this.name = 'ConflictingEvidenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when review is in an explicitly blocked state requiring external intervention.
 */
export class BlockedReviewError extends QAReviewError {
  constructor(message: string, details?: QAReviewErrorDetails) {
    super(message, 'ERR_BLOCKED_REVIEW', details);
    this.name = 'BlockedReviewError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
