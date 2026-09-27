/**
 * Corrective Task Lineage & Governed DAG Augmentation Errors (Phase 13 TASK-P13-03)
 *
 * Defines deterministic, typed errors for the Corrective Task Lineage & DAG Augmentation boundary.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class CorrectiveTaskError extends AidmError {
  constructor(message: string, code = 'ERR_CORRECTIVE_TASK', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CorrectiveTaskValidationError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_VALIDATION', details);
  }
}

export class CorrectiveTaskSecurityViolationError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_SECURITY_VIOLATION', details);
  }
}

export class CorrectiveTaskPolicyMismatchError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_POLICY_MISMATCH', details);
  }
}

export class CorrectiveTaskBindingMismatchError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_BINDING_MISMATCH', details);
  }
}

export class CorrectiveTaskSourceStateInvalidError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_SOURCE_STATE_INVALID', details);
  }
}

export class CorrectiveTaskUnauthorizedError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_UNAUTHORIZED', details);
  }
}

export class CorrectiveTaskScopeViolationError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_SCOPE_VIOLATION', details);
  }
}

export class CorrectiveTaskGraphValidationError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_GRAPH_VALIDATION', details);
  }
}

export class CorrectiveTaskConflictError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_CONFLICT', details);
  }
}

export class CorrectiveTaskPersistenceError extends CorrectiveTaskError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_CORRECTIVE_TASK_PERSISTENCE', details);
  }
}
