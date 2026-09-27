/**
 * Executor Context Package Errors
 *
 * Typed error hierarchy for the authoritative context-to-executor pipeline.
 */

import { AidmError } from '../errors/aidm-error.js';

export class ExecutorContextError extends AidmError {
  constructor(message: string, code = 'ERR_EXECUTOR_CONTEXT', details?: Record<string, unknown>) {
    super(message, code, details);
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
