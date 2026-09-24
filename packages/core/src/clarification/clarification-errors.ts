/**
 * Clarification Protocol Error Hierarchy (Phase 8 TASK-P8-04)
 *
 * Deterministic error classes for the clarification protocol, input validation,
 * answer processing, and session state enforcement.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class ClarificationError extends AidmError {
  constructor(message: string, code = 'ERR_CLARIFICATION', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export type ClarificationValidationReason =
  | 'UNKNOWN_CLARIFICATION_ID'
  | 'ALREADY_RESOLVED'
  | 'UNSUPPORTED_SOURCE'
  | 'MISSING_REQUIRED_ANSWER'
  | 'INVALID_OPTION'
  | 'FREE_FORM_PROHIBITED'
  | 'SECURITY_VIOLATION'
  | 'INVALID_SESSION_STATE'
  | 'SCHEMA_VALIDATION_FAILED';

export class ClarificationValidationError extends ClarificationError {
  readonly reason: ClarificationValidationReason;

  constructor(
    message: string,
    reason: ClarificationValidationReason,
    details?: AidmErrorDetails
  ) {
    super(message, `ERR_CLARIFICATION_VALIDATION_${reason}`, {
      ...details,
      reason,
    });
    this.reason = reason;
  }
}

export class ClarificationSessionError extends ClarificationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CLARIFICATION_SESSION', details);
  }
}
