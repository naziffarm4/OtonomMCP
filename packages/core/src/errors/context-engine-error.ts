import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export type ContextEngineErrorCode =
  | 'ERR_CONTEXT_SOURCE_NOT_FOUND'
  | 'ERR_INVALID_CONTEXT_REQUEST'
  | 'ERR_UNSUPPORTED_CONTEXT_LAYER'
  | 'ERR_FILE_CHANGED_DURING_RETRIEVAL'
  | 'ERR_STRUCTURAL_CONTEXT_UNAVAILABLE';

export interface ContextEngineErrorDetails extends AidmErrorDetails {
  sourcePath?: string;
  requestedLayer?: string;
  reason?: string;
  expectedHash?: string;
  actualHash?: string;
}

/**
 * Structured error class for Context Engine failures.
 * Distinguishes source not found, invalid requests, unsupported layers, and concurrency mismatches.
 */
export class ContextEngineError extends AidmError {
  readonly code: ContextEngineErrorCode;
  readonly sourcePath?: string;
  readonly requestedLayer?: string;

  constructor(
    message: string,
    code: ContextEngineErrorCode = 'ERR_INVALID_CONTEXT_REQUEST',
    details?: ContextEngineErrorDetails
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'ContextEngineError';
    this.code = code;
    this.sourcePath = details?.sourcePath;
    this.requestedLayer = details?.requestedLayer;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
