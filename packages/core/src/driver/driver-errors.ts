/**
 * Autonomous Driver Error Definitions (Phase 17 TASK-P17-01)
 *
 * Strongly-typed error hierarchy for driver lifecycle, concurrency, authorization,
 * recovery, and execution failures.
 */

export class DriverError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidDriverLifecycleTransitionError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverConcurrencyError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverValidationError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverAuthorizationError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverStaleStateError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverRecoveryError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverExecutionError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class DriverScopeMismatchError extends DriverError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}
