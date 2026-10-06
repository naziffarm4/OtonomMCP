/**
 * @file execution-bridge-errors.ts
 * @description Strongly-typed errors for the Execution Bridge & Safe Driver Handoff.
 */

export class ExecutionBridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = 'ERR_EXECUTION_BRIDGE', details?: Record<string, unknown>) {
    super(message);
    this.name = 'ExecutionBridgeError';
    this.code = code;
    this.details = details;
  }
}

export class ExecutionBridgeValidationError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_VALIDATION', details);
    this.name = 'ExecutionBridgeValidationError';
  }
}

export class ExecutionBridgeClaimConflictError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_CLAIM_CONFLICT', details);
    this.name = 'ExecutionBridgeClaimConflictError';
  }
}

export class ExecutionBridgeLockError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_LOCK_ERROR', details);
    this.name = 'ExecutionBridgeLockError';
  }
}

export class ExecutionBridgeStaleContextError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_STALE_CONTEXT', details);
    this.name = 'ExecutionBridgeStaleContextError';
  }
}

export class ExecutionBridgeAuthorizationError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_UNAUTHORIZED', details);
    this.name = 'ExecutionBridgeAuthorizationError';
  }
}

export class ExecutionBridgeBudgetError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_BUDGET_EXCEEDED', details);
    this.name = 'ExecutionBridgeBudgetError';
  }
}

export class ExecutionBridgeDependencyError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_DEPENDENCIES_UNMET', details);
    this.name = 'ExecutionBridgeDependencyError';
  }
}

export class ExecutionBridgeExecutorUnavailableError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_EXECUTOR_UNAVAILABLE', details);
    this.name = 'ExecutionBridgeExecutorUnavailableError';
  }
}

export class ExecutionBridgeUnknownStateError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ERR_EXECUTION_BRIDGE_UNKNOWN_STATE', details);
    this.name = 'ExecutionBridgeUnknownStateError';
  }
}

export class ExecutionBridgeAuthContextError extends ExecutionBridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BLOCKED_ON_AUTH_CONTEXT', details);
    this.name = 'ExecutionBridgeAuthContextError';
  }
}

