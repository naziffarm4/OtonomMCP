/**
 * Executor Context Package Errors
 *
 * Typed error hierarchy for the authoritative context-to-executor pipeline.
 */

import { ExecutorPreconditionError } from '../director/director-errors.js';

export class ExecutorContextError extends ExecutorPreconditionError {
  constructor(message: string, code = 'ERR_EXECUTOR_CONTEXT', details?: Record<string, unknown>) {
    super(message, { code, ...details });
    (this as any).code = code;
    this.name = 'ExecutorContextError';
  }
}

export class ExecutorContextValidationError extends ExecutorContextError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTOR_CONTEXT_VALIDATION', details);
    this.name = 'ExecutorContextValidationError';
  }
}

export class ExecutorContextSourceUnavailableError extends ExecutorContextError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTOR_CONTEXT_SOURCE_UNAVAILABLE', details);
    this.name = 'ExecutorContextSourceUnavailableError';
  }
}

export class ExecutorContextStaleError extends ExecutorContextError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTOR_CONTEXT_STALE', details);
    this.name = 'ExecutorContextStaleError';
  }
}

export class ExecutorContextBudgetExceededError extends ExecutorContextError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTOR_CONTEXT_BUDGET_EXCEEDED', details);
    this.name = 'ExecutorContextBudgetExceededError';
  }
}

export class ExecutorContextBindingMismatchError extends ExecutorContextError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_CONTEXT_PACKAGE_BINDING_MISMATCH', details);
    this.name = 'ExecutorContextBindingMismatchError';
  }
}

export class ExecutorContextIntegrityError extends ExecutorContextError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      message,
      (details?.code as string | undefined) ?? 'ERR_CONTEXT_PACKAGE_INTEGRITY_FAILED',
      details
    );
    this.name = 'ExecutorContextIntegrityError';
  }
}

