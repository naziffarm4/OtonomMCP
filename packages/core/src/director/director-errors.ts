/**
 * Director Session Domain Errors (Phase 9 TASK-P9-01)
 *
 * Defines deterministic, typed errors for Director session identity, lifecycle,
 * project binding, and security violations.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class DirectorSessionError extends AidmError {
  constructor(message: string, code = 'ERR_DIRECTOR_SESSION', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorValidationError extends DirectorSessionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_VALIDATION', details);
  }
}

export class DirectorSessionNotFoundError extends DirectorSessionError {
  constructor(sessionId: string, details?: AidmErrorDetails) {
    super(`Director session not found: '${sessionId}'`, 'ERR_DIRECTOR_SESSION_NOT_FOUND', {
      sessionId,
      ...details,
    });
  }
}

export class DirectorSessionAlreadyExistsError extends DirectorSessionError {
  constructor(sessionId: string, details?: AidmErrorDetails) {
    super(`Director session already exists: '${sessionId}'`, 'ERR_DIRECTOR_SESSION_ALREADY_EXISTS', {
      sessionId,
      ...details,
    });
  }
}

export class DirectorProjectBindingMismatchError extends DirectorSessionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_PROJECT_BINDING_MISMATCH', details);
  }
}

export class DirectorInvalidTransitionError extends DirectorSessionError {
  constructor(fromStatus: string, toStatus: string, details?: AidmErrorDetails) {
    super(
      `Invalid Director session lifecycle transition from '${fromStatus}' to '${toStatus}'`,
      'ERR_DIRECTOR_INVALID_TRANSITION',
      { fromStatus, toStatus, ...details }
    );
  }
}

export class DirectorSecurityError extends DirectorSessionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_SECURITY_VIOLATION', details);
  }
}
