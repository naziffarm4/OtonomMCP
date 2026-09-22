import { AidmError, AidmErrorDetails } from './aidm-error.js';

export interface StorageErrorDetails extends AidmErrorDetails {
  filePath?: string;
  operation?: string;
  causeError?: unknown;
}

/**
 * Thrown when an I/O or filesystem error occurs in the storage layer.
 */
export class StorageError extends AidmError {
  readonly filePath?: string;
  readonly operation?: string;

  constructor(
    message: string,
    options?: {
      filePath?: string;
      operation?: string;
      details?: StorageErrorDetails;
      cause?: unknown;
    }
  ) {
    const details: StorageErrorDetails = {
      filePath: options?.filePath,
      operation: options?.operation,
      causeError: options?.cause instanceof Error ? options.cause.message : options?.cause,
      ...options?.details,
    };
    super(message, 'ERR_STORAGE_IO', details);
    this.name = 'StorageError';
    this.filePath = options?.filePath;
    this.operation = options?.operation;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
