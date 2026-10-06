/**
 * @file director-action-errors.ts
 * @description Typed errors for Director Action validation, contract compliance,
 * and security invariant violations (Phase 26 P26).
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class DirectorActionError extends AidmError {
  constructor(message: string, code = 'ERR_DIRECTOR_ACTION', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorActionValidationError extends DirectorActionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_ACTION_VALIDATION', details);
  }
}

export class DirectorActionSecurityError extends DirectorActionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_ACTION_SECURITY_VIOLATION', details);
  }
}
