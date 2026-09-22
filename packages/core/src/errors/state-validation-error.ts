import { AidmError, AidmErrorDetails } from './aidm-error.js';

export interface StateValidationErrorDetails extends AidmErrorDetails {
  filePath?: string;
  validationErrors?: unknown;
}

/**
 * Thrown when data loaded from or written to storage fails schema validation.
 */
export class StateValidationError extends AidmError {
  readonly filePath?: string;
  readonly validationErrors?: unknown;

  constructor(
    message: string,
    options?: {
      filePath?: string;
      validationErrors?: unknown;
      details?: AidmErrorDetails;
    }
  ) {
    const details: StateValidationErrorDetails = {
      filePath: options?.filePath,
      validationErrors: options?.validationErrors,
      ...options?.details,
    };
    super(message, 'ERR_STATE_VALIDATION', details);
    this.name = 'StateValidationError';
    this.filePath = options?.filePath;
    this.validationErrors = options?.validationErrors;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
