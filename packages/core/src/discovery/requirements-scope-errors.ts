/**
 * Requirements & Scope Definition Errors (Phase 15 TASK-P15-03)
 *
 * Defines domain-specific error classes for the Requirements & Scope subsystem.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class RequirementsScopeError extends AidmError {
  constructor(message: string, code = 'ERR_REQUIREMENTS_SCOPE', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class RequirementsScopeValidationError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_VALIDATION', details);
  }
}

export class RequirementsScopeRevisionNotFoundError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_REVISION_NOT_FOUND', details);
  }
}

export class RequirementsScopeProjectBindingMismatchError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_PROJECT_BINDING_MISMATCH', details);
  }
}

export class RequirementsScopeImmutableRevisionError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_IMMUTABLE_REVISION', details);
  }
}

export class RequirementsScopeStaleSourceError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_STALE_SOURCE', details);
  }
}

export class RequirementsScopeForgedFingerprintError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_FORGED_FINGERPRINT', details);
  }
}

export class RequirementsScopeStorageError extends RequirementsScopeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_REQUIREMENTS_SCOPE_STORAGE', details);
  }
}
