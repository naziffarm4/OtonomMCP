import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export type BudgetErrorCode =
  | 'ERR_INVALID_BUDGET_ACCOUNT'
  | 'ERR_BUDGET_EXCEEDED'
  | 'ERR_BUDGET_OVERRUN'
  | 'ERR_BUDGET_REQUIRED'
  | 'ERR_PRICING_NOT_FOUND'
  | 'ERR_INVALID_PRICING'
  | 'ERR_RESERVATION_NOT_FOUND'
  | 'ERR_INVALID_RESERVATION_STATE'
  | 'ERR_RESERVATION_ACCOUNT_MISMATCH'
  | 'ERR_RESERVATION_MODEL_MISMATCH'
  | 'ERR_RESERVATION_ALREADY_CONSUMED'
  | 'ERR_IDEMPOTENCY_CONFLICT'
  | 'ERR_BUDGET_DB_ERROR';

export interface BudgetErrorDetails extends AidmErrorDetails {
  accountId?: string;
  reservationId?: string;
  idempotencyKey?: string;
  modelId?: string;
  providerId?: string;
  limitNanoUsd?: bigint | string;
  committedNanoUsd?: bigint | string;
  reservedNanoUsd?: bigint | string;
  availableNanoUsd?: bigint | string;
  requestedNanoUsd?: bigint | string;
  currentState?: string;
  targetState?: string;
  reason?: string;
}

/**
 * Structured error class for Persistent Budget and Financial operations (P18-03).
 */
export class BudgetError extends AidmError {
  readonly code: BudgetErrorCode;
  readonly accountId?: string;
  readonly reservationId?: string;
  readonly idempotencyKey?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly limitNanoUsd?: bigint | string;
  readonly committedNanoUsd?: bigint | string;
  readonly reservedNanoUsd?: bigint | string;
  readonly availableNanoUsd?: bigint | string;
  readonly requestedNanoUsd?: bigint | string;
  readonly currentState?: string;
  readonly targetState?: string;
  readonly reason?: string;

  constructor(
    message: string,
    code: BudgetErrorCode = 'ERR_INVALID_BUDGET_ACCOUNT',
    details?: BudgetErrorDetails
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'BudgetError';
    this.code = code;
    this.accountId = details?.accountId;
    this.reservationId = details?.reservationId;
    this.idempotencyKey = details?.idempotencyKey;
    this.modelId = details?.modelId;
    this.providerId = details?.providerId;
    this.limitNanoUsd = details?.limitNanoUsd;
    this.committedNanoUsd = details?.committedNanoUsd;
    this.reservedNanoUsd = details?.reservedNanoUsd;
    this.availableNanoUsd = details?.availableNanoUsd;
    this.requestedNanoUsd = details?.requestedNanoUsd;
    this.currentState = details?.currentState;
    this.targetState = details?.targetState;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
