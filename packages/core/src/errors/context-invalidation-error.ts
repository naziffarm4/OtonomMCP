import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import type {
  ContextValidationAction,
  StaleFileDetail,
} from '../context-engine/invalidation-types.js';

export type ContextInvalidationErrorCode =
  | 'ERR_CONTEXT_INVALIDATED'
  | 'ERR_CONTEXT_STALE_WRITE_REJECTED'
  | 'ERR_CONTEXT_FILE_MISSING';

export interface ContextInvalidationErrorDetails extends AidmErrorDetails {
  action?: ContextValidationAction;
  affectedFiles?: StaleFileDetail[];
  contextReference?: string;
  sourcePath?: string;
  oldHash?: string;
  currentHash?: string | null;
  reason?: string;
}

/**
 * Structured error thrown when a stale context is detected or when an operation
 * attempts to execute with invalidated context.
 * 
 * Satisfies Architecture Section 8:
 * OLD_HASH != CURRENT_HASH -> CONTEXT_INVALIDATED -> STOP OPERATION.
 */
export class ContextInvalidationError extends AidmError {
  readonly code: ContextInvalidationErrorCode;
  readonly action: ContextValidationAction;
  readonly affectedFiles: StaleFileDetail[];
  readonly contextReference?: string;
  readonly sourcePath?: string;
  readonly oldHash?: string;
  readonly currentHash?: string | null;
  readonly reason?: string;

  constructor(
    message: string,
    code: ContextInvalidationErrorCode = 'ERR_CONTEXT_INVALIDATED',
    details?: ContextInvalidationErrorDetails
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'ContextInvalidationError';
    this.code = code;
    this.action = details?.action ?? 'CONTEXT_INVALIDATED';
    this.affectedFiles = details?.affectedFiles ?? [];
    this.contextReference = details?.contextReference;
    this.sourcePath = details?.sourcePath ?? (this.affectedFiles[0]?.sourcePath);
    this.oldHash = details?.oldHash ?? (this.affectedFiles[0]?.oldHash);
    this.currentHash = details?.currentHash !== undefined ? details.currentHash : (this.affectedFiles[0]?.currentHash ?? null);
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
