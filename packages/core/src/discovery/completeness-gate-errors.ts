/**
 * Completeness Gate Errors (Phase 15 TASK-P15-02)
 *
 * Defines domain-specific error classes for specification completeness gate.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class CompletenessGateError extends AidmError {
  constructor(message: string, code = 'ERR_COMPLETENESS_GATE', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class CompletenessValidationError extends CompletenessGateError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_COMPLETENESS_VALIDATION', details);
  }
}

export class CompletenessRevisionNotFoundError extends CompletenessGateError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_COMPLETENESS_REVISION_NOT_FOUND', details);
  }
}

export class CompletenessProjectBindingMismatchError extends CompletenessGateError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_COMPLETENESS_PROJECT_BINDING_MISMATCH', details);
  }
}

export class CompletenessStaleRevisionError extends CompletenessGateError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_COMPLETENESS_STALE_REVISION', details);
  }
}

export class CompletenessStorageError extends CompletenessGateError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_COMPLETENESS_STORAGE', details);
  }
}
