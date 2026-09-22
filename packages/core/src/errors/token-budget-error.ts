import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export type TokenBudgetErrorCode =
  | 'ERR_INVALID_TOKEN_BUDGET'
  | 'ERR_MALFORMED_BUDGET_ITEM'
  | 'ERR_INVALID_CONTEXT_PRIORITY'
  | 'ERR_MANDATORY_BUDGET_EXCEEDED'
  | 'ERR_INCOMPLETE_PRICING';

export interface TokenBudgetErrorDetails extends AidmErrorDetails {
  budget?: number;
  itemId?: string;
  priority?: string;
  p0Tokens?: number;
  totalTokens?: number;
  reason?: string;
  field?: string;
}

/**
 * Structured error class for Token Budget and Telemetry failures (Architecture Section 9).
 */
export class TokenBudgetError extends AidmError {
  readonly code: TokenBudgetErrorCode;
  readonly budget?: number;
  readonly itemId?: string;
  readonly priority?: string;
  readonly p0Tokens?: number;
  readonly totalTokens?: number;
  readonly reason?: string;

  constructor(
    message: string,
    code: TokenBudgetErrorCode = 'ERR_INVALID_TOKEN_BUDGET',
    details?: TokenBudgetErrorDetails
  ) {
    const formattedMessage = message.startsWith(`[${code}]`)
      ? message
      : `[${code}] ${message}`;

    super(formattedMessage, code, details);
    this.name = 'TokenBudgetError';
    this.code = code;
    this.budget = details?.budget;
    this.itemId = details?.itemId;
    this.priority = details?.priority;
    this.p0Tokens = details?.p0Tokens;
    this.totalTokens = details?.totalTokens;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
