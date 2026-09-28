/**
 * Acceptance Criteria Definition Errors (Phase 15 TASK-P15-06)
 *
 * Defines domain-specific error classes for the Acceptance Criteria subsystem.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class AcceptanceCriteriaError extends AidmError {
  constructor(message: string, code = 'ERR_ACCEPTANCE_CRITERIA', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class AcceptanceCriteriaValidationError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_VALIDATION', details);
  }
}

export class AcceptanceCriteriaRevisionNotFoundError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_REVISION_NOT_FOUND', details);
  }
}

export class AcceptanceCriteriaProjectBindingMismatchError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_PROJECT_BINDING_MISMATCH', details);
  }
}

export class AcceptanceCriteriaImmutableRevisionError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_IMMUTABLE_REVISION', details);
  }
}

export class AcceptanceCriteriaStaleSourceError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_STALE_SOURCE', details);
  }
}

export class AcceptanceCriteriaForgedFingerprintError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_FORGED_FINGERPRINT', details);
  }
}

export class AcceptanceCriteriaDependencyError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_DEPENDENCY', details);
  }
}

export class AcceptanceCriteriaStorageError extends AcceptanceCriteriaError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ACCEPTANCE_CRITERIA_STORAGE', details);
  }
}
