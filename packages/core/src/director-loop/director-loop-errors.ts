/**
 * Director ↔ Executor Loop Error Hierarchy (Phase 16 TASK-P16-01)
 *
 * Defines deterministic, strongly-typed errors for the Director ↔ Executor feedback cycle.
 */

export abstract class DirectorLoopError extends Error {
  abstract readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorInstructionValidationError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_VALIDATION_ERROR';
}

export class DirectorInstructionUnauthorizedError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_UNAUTHORIZED';
}

export class DirectorInstructionStaleError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_STALE';
}

export class DirectorInstructionRevisionMismatchError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_REVISION_MISMATCH';
}

export class DirectorInstructionScopeMismatchError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_SCOPE_MISMATCH';
}

export class DirectorInstructionSessionMismatchError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_SESSION_MISMATCH';
}

export class DirectorInstructionProjectMismatchError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_PROJECT_MISMATCH';
}

export class DirectorInstructionDuplicateError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_DUPLICATE';
}

export class DirectorInstructionStateInconsistencyError extends DirectorLoopError {
  readonly code = 'DIRECTOR_INSTRUCTION_STATE_INCONSISTENCY';
}

export class DirectorLoopExecutionError extends DirectorLoopError {
  readonly code = 'DIRECTOR_LOOP_EXECUTION_ERROR';
}
