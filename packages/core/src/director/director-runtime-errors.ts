/**
 * @file director-runtime-errors.ts
 * @description Strongly typed error hierarchy and deterministic error codes
 * for the Director Reasoning Runtime (Phase 27 P27).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Error codes are stable, uppercase, and deterministic.
 * 2. Secrets and credentials are automatically sanitized from error messages and details.
 * 3. Fail-closed error handling: unknown/invalid state raises typed DirectorRuntimeError.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';
import { sanitizeSecrets } from '../errors/llm-error.js';

export const DirectorRuntimeErrorCode = {
  DIRECTOR_SESSION_INVALID: 'DIRECTOR_SESSION_INVALID',
  DIRECTOR_CONTEXT_UNAVAILABLE: 'CONTEXT_UNAVAILABLE',
  DIRECTOR_CONTEXT_STALE: 'DIRECTOR_CONTEXT_STALE',
  DIRECTOR_CONTEXT_INCOMPLETE: 'DIRECTOR_CONTEXT_INCOMPLETE',
  DIRECTOR_CONTEXT_MISMATCH: 'DIRECTOR_CONTEXT_MISMATCH',
  DIRECTOR_RUNTIME_UNAVAILABLE: 'DIRECTOR_RUNTIME_UNAVAILABLE',
  DIRECTOR_LLM_PROVIDER_UNAVAILABLE: 'DIRECTOR_LLM_PROVIDER_UNAVAILABLE',
  DIRECTOR_LLM_REQUEST_FAILED: 'DIRECTOR_LLM_REQUEST_FAILED',
  DIRECTOR_LLM_RESPONSE_INVALID: 'DIRECTOR_LLM_RESPONSE_INVALID',
  DIRECTOR_STRUCTURED_OUTPUT_REQUIRED: 'DIRECTOR_STRUCTURED_OUTPUT_REQUIRED',
  DIRECTOR_ACTION_VALIDATION_FAILED: 'DIRECTOR_ACTION_VALIDATION_FAILED',
  DIRECTOR_ACTION_CONTEXT_MISMATCH: 'DIRECTOR_ACTION_CONTEXT_MISMATCH',
} as const;

export type DirectorRuntimeErrorCode =
  (typeof DirectorRuntimeErrorCode)[keyof typeof DirectorRuntimeErrorCode];

export class DirectorRuntimeError extends AidmError {
  constructor(
    message: string,
    code: string = 'ERR_DIRECTOR_RUNTIME',
    details?: AidmErrorDetails
  ) {
    const cleanMsg = sanitizeSecrets(message);
    super(cleanMsg, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorRuntimeUnavailableError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_RUNTIME_UNAVAILABLE, details);
  }
}

export class DirectorSessionInvalidError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_SESSION_INVALID, details);
  }
}

export class DirectorContextUnavailableError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_CONTEXT_UNAVAILABLE, details);
  }
}

export class DirectorLlmProviderUnavailableError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_LLM_PROVIDER_UNAVAILABLE, details);
  }
}

export class DirectorLlmRequestFailedError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_LLM_REQUEST_FAILED, details);
  }
}

export class DirectorLlmResponseInvalidError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_LLM_RESPONSE_INVALID, details);
  }
}

export class DirectorStructuredOutputRequiredError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_STRUCTURED_OUTPUT_REQUIRED, details);
  }
}

export class DirectorActionValidationFailedError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_ACTION_VALIDATION_FAILED, details);
  }
}

export class DirectorActionContextMismatchError extends DirectorRuntimeError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, DirectorRuntimeErrorCode.DIRECTOR_ACTION_CONTEXT_MISMATCH, details);
  }
}
