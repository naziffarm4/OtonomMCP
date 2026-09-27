/**
 * Bounded Task Retry Authorization Errors (Phase 13 TASK-P13-02)
 *
 * Defines deterministic, typed errors for the Retry Authorization & State Transition boundary.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class RetryAuthorizationError extends AidmError {
  constructor(message: string, code = 'ERR_RETRY_AUTHORIZATION', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RetryValidationError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_VALIDATION', details);
  }
}

export class RetrySecurityViolationError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_SECURITY_VIOLATION', details);
  }
}

export class RetryPolicyMismatchError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_POLICY_MISMATCH', details);
  }
}

export class RetryBindingMismatchError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_BINDING_MISMATCH', details);
  }
}

export class RetryBudgetExhaustedError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_BUDGET_EXHAUSTED', details);
  }
}

export class RetryTaskStateInvalidError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_TASK_STATE_INVALID', details);
  }
}

export class RetryUnauthorizedError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_UNAUTHORIZED', details);
  }
}

export class RetryPersistenceError extends RetryAuthorizationError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RETRY_PERSISTENCE', details);
  }
}
