import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export type EvidenceErrorCode =
  | 'ERR_INVALID_EVIDENCE'
  | 'ERR_MISSING_EVIDENCE_FIELD'
  | 'ERR_MALFORMED_FILE_HASH'
  | 'ERR_INVALID_EXECUTION_METADATA'
  | 'ERR_INVALID_EVIDENCE_SOURCE'
  | 'ERR_INVALID_EVIDENCE_TYPE'
  | 'ERR_INVALID_GIT_REFERENCE'
  | 'ERR_INVALID_COMMAND'
  | 'ERR_INVALID_EXIT_CODE';

/**
 * Sanitizes potentially sensitive keys or tokens from error messages and details.
 */
export function sanitizeEvidenceSecrets(text: string): string {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(?:sk-[a-zA-Z0-9_-]{8,})/g, '***REDACTED_KEY***')
    .replace(/(?:Bearer\s+[a-zA-Z0-9_.-]{8,})/gi, 'Bearer ***REDACTED_TOKEN***')
    .replace(/(?:ghp_[a-zA-Z0-9]{20,})/g, '***REDACTED_TOKEN***')
    .replace(/(?:xox[baprs]-[a-zA-Z0-9-]{10,})/g, '***REDACTED_TOKEN***')
    .replace(/(key|token|secret|password|passwd|auth)=([^\s&'"]+)/gi, '$1=***REDACTED***')
    .replace(/(["']?(?:apiKey|token|secret|password)["']?\s*:\s*["'])([^"']+)["']/gi, '$1***REDACTED***"');
}

/**
 * Recursively sanitizes structured error details so credentials or secrets are never leaked.
 */
export function sanitizeEvidenceDetails(details?: AidmErrorDetails): AidmErrorDetails | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('token') ||
      lowerKey.includes('apikey') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('credential')
    ) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof val === 'string') {
      sanitized[key] = sanitizeEvidenceSecrets(val);
    } else if (Array.isArray(val)) {
      sanitized[key] = val.map((item) =>
        typeof item === 'string' ? sanitizeEvidenceSecrets(item) : item
      );
    } else if (val && typeof val === 'object') {
      sanitized[key] = sanitizeEvidenceDetails(val as AidmErrorDetails);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export interface EvidenceErrorDetails extends AidmErrorDetails {
  evidenceId?: string;
  taskId?: string;
  field?: string;
  reason?: string;
  value?: unknown;
  validationErrors?: readonly string[];
}

/**
 * Base error class for all evidence-related failures.
 * Extends AidmError to ensure unified error hierarchy and machine-readable serialization.
 */
export class EvidenceError extends AidmError {
  readonly evidenceId?: string;
  readonly taskId?: string;
  readonly field?: string;
  readonly reason?: string;

  constructor(
    message: string,
    code: EvidenceErrorCode = 'ERR_INVALID_EVIDENCE',
    details?: EvidenceErrorDetails
  ) {
    const sanitizedMsg = sanitizeEvidenceSecrets(message);
    const sanitizedDetails = sanitizeEvidenceDetails(details) as EvidenceErrorDetails | undefined;
    const formattedMessage = sanitizedMsg.startsWith(`[${code}]`)
      ? sanitizedMsg
      : `[${code}] ${sanitizedMsg}`;

    super(formattedMessage, code, sanitizedDetails);
    this.name = 'EvidenceError';
    this.evidenceId = sanitizedDetails?.evidenceId;
    this.taskId = sanitizedDetails?.taskId;
    this.field = sanitizedDetails?.field;
    this.reason = sanitizedDetails?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when evidence structure is invalid or malformed.
 */
export class InvalidEvidenceError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_EVIDENCE', details);
    this.name = 'InvalidEvidenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a mandatory evidence field is missing or empty.
 */
export class MissingEvidenceFieldError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_MISSING_EVIDENCE_FIELD', details);
    this.name = 'MissingEvidenceFieldError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a file hash is not a structurally valid SHA-256 hexadecimal string.
 */
export class MalformedFileHashError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_MALFORMED_FILE_HASH', details);
    this.name = 'MalformedFileHashError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when execution metadata (e.g. execution_time_ms) violates integrity constraints.
 */
export class InvalidExecutionMetadataError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_EXECUTION_METADATA', details);
    this.name = 'InvalidExecutionMetadataError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an agent claim or invalid source attempts to be passed as system verified evidence.
 */
export class InvalidEvidenceSourceError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_EVIDENCE_SOURCE', details);
    this.name = 'InvalidEvidenceSourceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an unrecognized evidence type classification is provided.
 */
export class InvalidEvidenceTypeError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_EVIDENCE_TYPE', details);
    this.name = 'InvalidEvidenceTypeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a Git reference format is invalid.
 */
export class InvalidGitReferenceError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_GIT_REFERENCE', details);
    this.name = 'InvalidGitReferenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when command string violates command integrity (e.g. empty or non-string).
 */
export class InvalidCommandError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_COMMAND', details);
    this.name = 'InvalidCommandError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when process exit code violates process exit representation integrity.
 */
export class InvalidExitCodeError extends EvidenceError {
  constructor(message: string, details?: EvidenceErrorDetails) {
    super(message, 'ERR_INVALID_EXIT_CODE', details);
    this.name = 'InvalidExitCodeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
