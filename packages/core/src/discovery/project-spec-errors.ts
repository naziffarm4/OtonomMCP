/**
 * Project Specification Projection Errors
 *
 * Defines domain-specific error classes for the PROJECT_SPEC projection subsystem.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class ProjectSpecError extends AidmError {
  constructor(message: string, code = 'ERR_PROJECT_SPEC', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class ProjectSpecValidationError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_VALIDATION', details);
  }
}

export class ProjectSpecRevisionNotFoundError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_REVISION_NOT_FOUND', details);
  }
}

export class ProjectSpecProjectBindingMismatchError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_PROJECT_BINDING_MISMATCH', details);
  }
}

export class ProjectSpecImmutableRevisionError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_IMMUTABLE_REVISION', details);
  }
}

export class ProjectSpecStaleSourceError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_STALE_SOURCE', details);
  }
}

export class ProjectSpecForgedFingerprintError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_FORGED_FINGERPRINT', details);
  }
}

export class ProjectSpecTamperingError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_TAMPERING', details);
  }
}

export class ProjectSpecPathTraversalError extends ProjectSpecError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_PROJECT_SPEC_PATH_TRAVERSAL', details);
  }
}
