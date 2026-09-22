import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export interface StaleContextDetails extends AidmErrorDetails {
  filePath?: string;
  expectedHash?: string;
  actualHash?: string;
  invalidatedAt?: string;
}

/**
 * Thrown when an actor attempts an action using out-of-date context
 * (i.e. OLD_HASH != CURRENT_HASH).
 * Distinct error code: ERR_STALE_CONTEXT
 */
export class StaleContextError extends AidmError {
  readonly filePath?: string;
  readonly expectedHash?: string;
  readonly actualHash?: string;

  constructor(
    message: string,
    details?: StaleContextDetails,
    code = 'ERR_STALE_CONTEXT'
  ) {
    super(message, code, details);
    this.filePath = details?.filePath;
    this.expectedHash = details?.expectedHash;
    this.actualHash = details?.actualHash;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
