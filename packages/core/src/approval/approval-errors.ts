/**
 * Approval Gate Error Hierarchy (Phase 8 TASK-P8-05)
 *
 * Deterministic error classes for project understanding approval, rejection,
 * readiness enforcement, revision matching, and human actor authorization.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class ApprovalError extends AidmError {
  constructor(message: string, code = 'ERR_APPROVAL', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export type ApprovalValidationReason =
  | 'MISSING_PACKAGE_ID'
  | 'INVALID_REVISION'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'STRUCTURALLY_INCOMPLETE'
  | 'MISSING_DISCOVERY'
  | 'UNRESOLVED_CONTRADICTIONS'
  | 'UNRESOLVED_BLOCKING_CLARIFICATIONS';

export class ApprovalValidationError extends ApprovalError {
  readonly reason: ApprovalValidationReason;

  constructor(
    message: string,
    reason: ApprovalValidationReason,
    details?: AidmErrorDetails
  ) {
    super(message, `ERR_APPROVAL_VALIDATION_${reason}`, {
      ...details,
      reason,
    });
    this.reason = reason;
  }
}

export class ApprovalAuthorizationError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_UNAUTHORIZED_ACTOR', details);
  }
}

export class ApprovalRevisionMismatchError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_REVISION_MISMATCH', details);
  }
}

export class ApprovalInvalidIntentError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_INVALID_INTENT', details);
  }
}

export class ApprovalNotReadyError extends ApprovalError {
  readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[] = [], details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_NOT_READY', {
      ...details,
      reasons,
    });
    this.reasons = reasons;
  }
}

export class ApprovalPackageNotFoundError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_PACKAGE_NOT_FOUND', details);
  }
}

export class ApprovalAlreadyDecidedError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_ALREADY_DECIDED', details);
  }
}

export class ApprovalStaleError extends ApprovalError {
  readonly reasons: readonly string[];
  constructor(message: string, reasons: readonly string[] = [], details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_STALE', { ...details, reasons });
    this.reasons = reasons;
  }
}

export class ApprovalForgedFingerprintError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_FORGED_FINGERPRINT', details);
  }
}

export class ApprovalTamperingError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_TAMPERING', details);
  }
}

export class ApprovalIntegrityError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_INTEGRITY_FAILED', details);
  }
}

export class ApprovalProjectBindingMismatchError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_PROJECT_MISMATCH', details);
  }
}

export class ApprovalPathTraversalError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_PATH_TRAVERSAL', details);
  }
}

export class ApprovalImmutableRevisionError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_IMMUTABLE_REVISION', details);
  }
}

export class ApprovalSourceMismatchError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_SOURCE_MISMATCH', details);
  }
}

export class ApprovalBlockedOnHumanError extends ApprovalError {
  readonly unresolvedHumanDecisions: readonly string[];
  constructor(message: string, unresolvedHumanDecisions: readonly string[] = [], details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_BLOCKED_ON_HUMAN', { ...details, unresolvedHumanDecisions });
    this.unresolvedHumanDecisions = unresolvedHumanDecisions;
  }
}

export class ApprovalCompletenessGateFailedError extends ApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_APPROVAL_COMPLETENESS_GATE_FAILED', details);
  }
}
