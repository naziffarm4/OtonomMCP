import { AidmError, AidmErrorDetails } from './aidm-error.js';

export interface HistoryCorruptErrorDetails extends AidmErrorDetails {
  lineNumber: number;
  rawLine?: string;
  filePath?: string;
}

/**
 * Thrown when an append-only history stream file contains a corrupt or invalid record line.
 */
export class HistoryCorruptError extends AidmError {
  readonly lineNumber: number;
  readonly rawLine?: string;
  readonly filePath?: string;

  constructor(
    message: string,
    options: {
      lineNumber: number;
      rawLine?: string;
      filePath?: string;
      details?: AidmErrorDetails;
    }
  ) {
    const details: HistoryCorruptErrorDetails = {
      lineNumber: options.lineNumber,
      rawLine: options.rawLine,
      filePath: options.filePath,
      ...options.details,
    };
    super(message, 'ERR_HISTORY_CORRUPT', details);
    this.name = 'HistoryCorruptError';
    this.lineNumber = options.lineNumber;
    this.rawLine = options.rawLine;
    this.filePath = options.filePath;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
