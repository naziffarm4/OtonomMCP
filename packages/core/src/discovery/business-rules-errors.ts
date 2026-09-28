/**
 * Business Rules Definition Errors (Phase 15 TASK-P15-05)
 *
 * Defines domain-specific error classes for the Business Rules subsystem.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class BusinessRulesError extends AidmError {
  constructor(message: string, code = 'ERR_BUSINESS_RULES', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class BusinessRulesValidationError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_VALIDATION', details);
  }
}

export class BusinessRulesRevisionNotFoundError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_REVISION_NOT_FOUND', details);
  }
}

export class BusinessRulesProjectBindingMismatchError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_PROJECT_BINDING_MISMATCH', details);
  }
}

export class BusinessRulesImmutableRevisionError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_IMMUTABLE_REVISION', details);
  }
}

export class BusinessRulesStaleSourceError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_STALE_SOURCE', details);
  }
}

export class BusinessRulesForgedFingerprintError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_FORGED_FINGERPRINT', details);
  }
}

export class BusinessRulesDependencyError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_DEPENDENCY', details);
  }
}

export class BusinessRulesStorageError extends BusinessRulesError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_BUSINESS_RULES_STORAGE', details);
  }
}
