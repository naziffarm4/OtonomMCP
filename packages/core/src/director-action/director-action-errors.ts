/**
 * @file director-action-errors.ts
 * @description Strongly-typed error hierarchy for the Structured Director Action Protocol (TASK-P19-01).
 */

export class DirectorActionError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = 'DirectorActionError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorActionValidationError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_VALIDATION', details);
    this.name = 'DirectorActionValidationError';
  }
}

export class DirectorActionImpersonationError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_IMPERSONATION', details);
    this.name = 'DirectorActionImpersonationError';
  }
}

export class DirectorActionStaleContextError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_STALE_CONTEXT', details);
    this.name = 'DirectorActionStaleContextError';
  }
}

export class DirectorActionIdempotencyConflictError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_IDEMPOTENCY_CONFLICT', details);
    this.name = 'DirectorActionIdempotencyConflictError';
  }
}

export class DirectorActionLineageError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_LINEAGE', details);
    this.name = 'DirectorActionLineageError';
  }
}

export class DirectorActionDispatchError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_DISPATCH', details);
    this.name = 'DirectorActionDispatchError';
  }
}

export class DirectorActionUnauthorizedError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_UNAUTHORIZED', details);
    this.name = 'DirectorActionUnauthorizedError';
  }
}

export class DirectorActionEvidenceError extends DirectorActionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_DIRECTOR_ACTION_EVIDENCE_INVALID', details);
    this.name = 'DirectorActionEvidenceError';
  }
}

