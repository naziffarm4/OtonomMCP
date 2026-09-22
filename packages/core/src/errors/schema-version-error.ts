import { AidmError, AidmErrorDetails } from './aidm-error.js';

export interface SchemaVersionErrorDetails extends AidmErrorDetails {
  expectedVersion: number;
  actualVersion: unknown;
  filePath?: string;
}

/**
 * Thrown when a persisted state file has an unsupported schema version.
 */
export class SchemaVersionError extends AidmError {
  readonly expectedVersion: number;
  readonly actualVersion: unknown;
  readonly filePath?: string;

  constructor(
    message: string,
    options: {
      expectedVersion: number;
      actualVersion: unknown;
      filePath?: string;
      details?: AidmErrorDetails;
    }
  ) {
    const details: SchemaVersionErrorDetails = {
      expectedVersion: options.expectedVersion,
      actualVersion: options.actualVersion,
      filePath: options.filePath,
      ...options.details,
    };
    super(message, 'ERR_SCHEMA_VERSION', details);
    this.name = 'SchemaVersionError';
    this.expectedVersion = options.expectedVersion;
    this.actualVersion = options.actualVersion;
    this.filePath = options.filePath;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
