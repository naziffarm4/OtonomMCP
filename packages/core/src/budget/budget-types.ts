import { BudgetError } from '../errors/budget-error.js';

export const NANO_USD_PER_USD = 1_000_000_000n;
export const MAX_SAFE_INT64 = 9223372036854775807n;

export const BudgetAccountType = {
  GLOBAL: 'GLOBAL',
  PROJECT: 'PROJECT',
} as const;

export type BudgetAccountType = (typeof BudgetAccountType)[keyof typeof BudgetAccountType];

export const BudgetAccountState = {
  ACTIVE: 'ACTIVE',
  LIMIT_OVERRUN: 'LIMIT_OVERRUN',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;

export type BudgetAccountState = (typeof BudgetAccountState)[keyof typeof BudgetAccountState];

export const ReservationState = {
  PREPARED: 'PREPARED',
  DISPATCHED: 'DISPATCHED',
  SETTLED: 'SETTLED',
  RELEASED: 'RELEASED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ReservationState = (typeof ReservationState)[keyof typeof ReservationState];

export interface BudgetAccount {
  accountId: string;
  accountType: BudgetAccountType;
  projectId?: string | null;
  limitSpendNanoUsd: bigint;
  reservedSpendNanoUsd: bigint;
  committedSpendNanoUsd: bigint;
  accountState: BudgetAccountState;
  availableSpendNanoUsd: bigint;
  createdAt: string;
  updatedAt: string;
}

export interface PricingRate {
  rateId: string;
  providerId: string;
  modelId: string;
  inputRateNum: bigint;
  inputRateDen: bigint;
  outputRateNum: bigint;
  outputRateDen: bigint;
  cachedInputRateNum: bigint;
  cachedInputRateDen: bigint;
  validFrom: string;
}

export interface PricingRateInput {
  rateId?: string;
  providerId: string;
  modelId: string;
  inputRateNum: bigint;
  inputRateDen: bigint;
  outputRateNum: bigint;
  outputRateDen: bigint;
  cachedInputRateNum?: bigint;
  cachedInputRateDen?: bigint;
  validFrom?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export interface BudgetReservation {
  reservationId: string;
  accountId: string;
  sessionId: string;
  taskId?: string | null;
  modelId: string;
  reservedSpendNanoUsd: bigint;
  settledSpendNanoUsd: bigint;
  state: ReservationState;
  idempotencyKey: string;
  providerId?: string;
  dispatchCount?: number;
  dispatchClaimId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimReservationRequest {
  reservationId: string;
  dispatchClaimId?: string | null;
  expectedAccountId?: string;
  expectedProjectId?: string;
  expectedProviderId?: string;
  expectedModelId?: string;
}

export interface PreDispatchValidationRequest {
  accountId?: string;
  sessionId: string;
  taskId?: string | null;
  providerId: string;
  modelId: string;
  estimatedTokens: TokenUsage;
  idempotencyKey: string;
}

export interface PreDispatchValidationResult {
  allowed: boolean;
  accountId: string;
  availableNanoUsd: bigint;
  estimatedCostNanoUsd: bigint;
  reason?: string;
}

export interface ReservationRequest extends PreDispatchValidationRequest {
  reservationId?: string;
}

export interface SettlementRequest {
  reservationId: string;
  reportedUsage: TokenUsage;
  providerCorrelationId?: string;
  idempotencyKey: string;
}

export interface SettlementResult {
  reservationId: string;
  accountId: string;
  reservedNanoUsd: bigint;
  actualCostNanoUsd: bigint;
  overdraftNanoUsd: bigint;
  accountState: BudgetAccountState;
  isOverrun: boolean;
}

export interface ReleaseRequest {
  reservationId: string;
  reason: string;
}

export interface RecordUnknownRequest {
  reservationId: string;
  errorReason: string;
}

export interface BudgetManagerOptions {
  dbPath?: string;
  baseDir?: string;
  historyManager?: unknown;
}

/**
 * Converts USD decimal to integer Nano-USD.
 */
export function usdToNanoUsd(usd: number): bigint {
  if (typeof usd !== 'number' || isNaN(usd) || usd < 0) {
    throw new BudgetError(`Invalid USD value: ${usd}`, 'ERR_INVALID_BUDGET_ACCOUNT');
  }
  const nano = BigInt(Math.round(usd * 1_000_000_000));
  if (nano > MAX_SAFE_INT64) {
    throw new BudgetError(`USD value exceeds max int64 nano-USD: ${usd}`, 'ERR_INVALID_BUDGET_ACCOUNT');
  }
  return nano;
}

/**
 * Converts integer Nano-USD to USD floating-point (for reporting / telemetry).
 */
export function nanoUsdToUsd(nanoUsd: bigint): number {
  return Number(nanoUsd) / 1_000_000_000;
}

/**
 * Integer ceiling division for positive BigInt values.
 * Ceil((tokens * num) / den) = (tokens * num + den - 1n) / den
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new BudgetError('Division denominator must be strictly positive', 'ERR_INVALID_PRICING');
  }
  if (numerator <= 0n) {
    return 0n;
  }
  return (numerator + (denominator - 1n)) / denominator;
}
