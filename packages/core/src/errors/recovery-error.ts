import { AidmError, AidmErrorDetails } from './aidm-error.js';

export type RecoveryErrorCategory =
  | 'INVALID_INPUT'
  | 'UNREADABLE_DURABLE_STATE'
  | 'UNREADABLE_RUNTIME_STATE'
  | 'CORRUPT_HISTORY'
  | 'UNREADABLE_L0_INDEX'
  | 'GIT_INSPECTION_FAILURE'
  | 'FILESYSTEM_INSPECTION_FAILURE'
  | 'UNRECONCILABLE_STATE';

export interface RecoveryErrorDetails extends AidmErrorDetails {
  category?: RecoveryErrorCategory;
  path?: string;
  causeError?: unknown;
}

/**
 * Thrown when an error occurs during recovery reconciliation or state inspection.
 */
export class RecoveryError extends AidmError {
  readonly category?: RecoveryErrorCategory;
  readonly path?: string;

  constructor(
    message: string,
    options?: {
      category?: RecoveryErrorCategory;
      path?: string;
      details?: RecoveryErrorDetails;
      cause?: unknown;
    }
  ) {
    const details: RecoveryErrorDetails = {
      category: options?.category,
      path: options?.path,
      causeError: options?.cause instanceof Error ? options.cause.message : options?.cause,
      ...options?.details,
    };
    super(message, 'ERR_RECOVERY', details);
    this.name = 'RecoveryError';
    this.category = options?.category;
    this.path = options?.path;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
