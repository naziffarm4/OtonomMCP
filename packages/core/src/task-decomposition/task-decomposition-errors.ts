/**
 * Task Decomposition Domain Errors (Phase 12 TASK-P12-01)
 *
 * Defines deterministic, typed domain errors for the authoritative
 * Task Decomposition and Ingestion boundary.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class TaskDecompositionError extends AidmError {
  constructor(message: string, code = 'ERR_TASK_DECOMPOSITION', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TaskDecompositionValidationError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_VALIDATION', details);
  }
}

export class TaskDecompositionApprovalRequiredError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_APPROVAL_REQUIRED', details);
  }
}

export class TaskDecompositionApprovalRevisionMismatchError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_APPROVAL_REVISION_MISMATCH', details);
  }
}

export class TaskDecompositionProjectBindingMismatchError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_PROJECT_BINDING_MISMATCH', details);
  }
}

export class TaskDecompositionSessionBindingMismatchError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_SESSION_BINDING_MISMATCH', details);
  }
}

export class TaskDecompositionContextMismatchError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_CONTEXT_MISMATCH', details);
  }
}

export class TaskDecompositionContextStaleError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_CONTEXT_STALE', details);
  }
}

export class TaskDecompositionContextIncompleteError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_CONTEXT_INCOMPLETE', details);
  }
}

export class TaskDecompositionInvalidTaskDefinitionError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_INVALID_TASK_DEFINITION', details);
  }
}

export class TaskDecompositionInvalidTraceabilityError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_INVALID_TRACEABILITY', details);
  }
}

export class TaskDecompositionInvalidScopeError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_INVALID_SCOPE', details);
  }
}

export class TaskDecompositionDuplicateTaskError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_DUPLICATE_TASK', details);
  }
}

export class TaskDecompositionConflictError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_TASK_CONFLICT', details);
  }
}

export class TaskDecompositionInvalidGraphError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_INVALID_GRAPH', details);
  }
}

export class TaskDecompositionOutOfScopeError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_OUT_OF_SCOPE', details);
  }
}

export class TaskDecompositionSecurityViolationError extends TaskDecompositionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_TASK_DECOMPOSITION_SECURITY_VIOLATION', details);
  }
}
