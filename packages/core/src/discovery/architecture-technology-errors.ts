/**
 * Architecture & Technology Definition Errors (Phase 15 TASK-P15-04)
 *
 * Defines domain-specific error classes for the Architecture & Technology subsystem.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class ArchitectureError extends AidmError {
  constructor(message: string, code = 'ERR_ARCHITECTURE', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class ArchitectureValidationError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_VALIDATION', details);
  }
}

export class ArchitectureRevisionNotFoundError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_REVISION_NOT_FOUND', details);
  }
}

export class ArchitectureProjectBindingMismatchError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_PROJECT_BINDING_MISMATCH', details);
  }
}

export class ArchitectureImmutableRevisionError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_IMMUTABLE_REVISION', details);
  }
}

export class ArchitectureStaleSourceError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_STALE_SOURCE', details);
  }
}

export class ArchitectureForgedFingerprintError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_FORGED_FINGERPRINT', details);
  }
}

export class ArchitectureStorageError extends ArchitectureError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_ARCHITECTURE_STORAGE', details);
  }
}
