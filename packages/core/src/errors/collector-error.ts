import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import { sanitizeEvidenceSecrets, sanitizeEvidenceDetails } from './evidence-error.js';

export type CollectorErrorCode =
  | 'ERR_COLLECTOR_GENERAL'
  | 'ERR_COMMAND_COLLECTION_FAILED'
  | 'ERR_PROCESS_EXECUTION_FAILED'
  | 'ERR_GIT_OBSERVATION_FAILED'
  | 'ERR_FILE_HASH_COLLECTION_FAILED'
  | 'ERR_INVALID_COLLECTOR_INPUT';

export interface CollectorErrorDetails extends AidmErrorDetails {
  taskId?: string;
  correlationId?: string;
  evidenceId?: string;
  command?: string;
  workingDirectory?: string;
  path?: string;
  reason?: string;
  exitCode?: number | null;
  cause?: unknown;
}

/**
 * Base structured error class for all Evidence Collector failures.
 * Extends AidmError and ensures secret sanitization for diagnostics and messages.
 */
export class CollectorError extends AidmError {
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly evidenceId?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly path?: string;
  readonly reason?: string;

  constructor(
    message: string,
    code: CollectorErrorCode = 'ERR_COLLECTOR_GENERAL',
    details?: CollectorErrorDetails
  ) {
    const sanitizedMsg = sanitizeEvidenceSecrets(message);
    const sanitizedDetails = sanitizeEvidenceDetails(details) as CollectorErrorDetails | undefined;
    const formattedMessage = sanitizedMsg.startsWith(`[${code}]`)
      ? sanitizedMsg
      : `[${code}] ${sanitizedMsg}`;

    super(formattedMessage, code, sanitizedDetails);
    this.name = 'CollectorError';
    this.taskId = sanitizedDetails?.taskId;
    this.correlationId = sanitizedDetails?.correlationId;
    this.evidenceId = sanitizedDetails?.evidenceId;
    this.command = sanitizedDetails?.command;
    this.workingDirectory = sanitizedDetails?.workingDirectory;
    this.path = sanitizedDetails?.path;
    this.reason = sanitizedDetails?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when command evidence collection fails or input is invalid.
 */
export class CommandCollectionError extends CollectorError {
  constructor(message: string, details?: CollectorErrorDetails) {
    super(message, 'ERR_COMMAND_COLLECTION_FAILED', details);
    this.name = 'CommandCollectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when process execution encounters a failure (spawn error, timeout, crash).
 */
export class ProcessExecutionError extends CollectorError {
  constructor(message: string, details?: CollectorErrorDetails) {
    super(message, 'ERR_PROCESS_EXECUTION_FAILED', details);
    this.name = 'ProcessExecutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when Git observation encounters a fatal or unrecoverable error.
 */
export class GitObservationError extends CollectorError {
  constructor(message: string, details?: CollectorErrorDetails) {
    super(message, 'ERR_GIT_OBSERVATION_FAILED', details);
    this.name = 'GitObservationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when file hash collection fails (e.g. missing file or unreadable file).
 */
export class FileHashCollectionError extends CollectorError {
  constructor(message: string, details?: CollectorErrorDetails) {
    super(message, 'ERR_FILE_HASH_COLLECTION_FAILED', details);
    this.name = 'FileHashCollectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when collector inputs violate integrity (e.g. agent claim passed to collector).
 */
export class InvalidCollectorInputError extends CollectorError {
  constructor(message: string, details?: CollectorErrorDetails) {
    super(message, 'ERR_INVALID_COLLECTOR_INPUT', details);
    this.name = 'InvalidCollectorInputError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
