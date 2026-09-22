import { AidmError, AidmErrorDetails } from './aidm-error.js';

export interface L0IndexErrorDetails extends AidmErrorDetails {
  operation?: string;
  path?: string;
  causeError?: unknown;
}

/**
 * Thrown when an error occurs during L0 indexer operations (SQLite, hashing, scanning, or synchronization).
 */
export class L0IndexError extends AidmError {
  readonly operation?: string;
  readonly path?: string;

  constructor(
    message: string,
    options?: {
      operation?: string;
      path?: string;
      details?: L0IndexErrorDetails;
      cause?: unknown;
    }
  ) {
    const details: L0IndexErrorDetails = {
      operation: options?.operation,
      path: options?.path,
      causeError: options?.cause instanceof Error ? options.cause.message : options?.cause,
      ...options?.details,
    };
    super(message, 'ERR_L0_INDEX', details);
    this.name = 'L0IndexError';
    this.operation = options?.operation;
    this.path = options?.path;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
