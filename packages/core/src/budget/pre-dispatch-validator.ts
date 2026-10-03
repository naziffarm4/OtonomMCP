import { BudgetError } from '../errors/budget-error.js';
import {
  type PreDispatchValidationRequest,
  type PreDispatchValidationResult,
  BudgetAccountState,
} from './budget-types.js';
import type { BudgetDatabase } from './budget-database.js';
import type { PricingEngine } from './pricing-engine.js';

export class PreDispatchValidator {
  constructor(
    private readonly db: BudgetDatabase,
    private readonly pricingEngine: PricingEngine
  ) {}

  /**
   * Validates whether a dispatch is allowed based on active budget account state,
   * pricing rate availability, and remaining available funds.
   * 
   * If strict=true, throws a specific BudgetError on any failure.
   */
  validate(request: PreDispatchValidationRequest, strict = true): PreDispatchValidationResult {
    // 1. Resolve Account
    const account = request.accountId
      ? this.db.getAccount(request.accountId)
      : this.db.getGlobalAccount();

    if (!account) {
      const msg = request.accountId
        ? `Budget account not found: '${request.accountId}'`
        : 'Global budget account is not configured';
      if (strict) {
        throw new BudgetError(msg, 'ERR_INVALID_BUDGET_ACCOUNT', {
          accountId: request.accountId,
        });
      }
      return {
        allowed: false,
        accountId: request.accountId ?? 'UNKNOWN',
        availableNanoUsd: 0n,
        estimatedCostNanoUsd: 0n,
        reason: msg,
      };
    }

    // 2. Validate Account State
    if (account.accountState !== BudgetAccountState.ACTIVE) {
      const msg = `Budget account '${account.accountId}' is not ACTIVE (current state: ${account.accountState})`;
      if (strict) {
        throw new BudgetError(msg, 'ERR_BUDGET_OVERRUN', {
          accountId: account.accountId,
          currentState: account.accountState,
        });
      }
      return {
        allowed: false,
        accountId: account.accountId,
        availableNanoUsd: account.availableSpendNanoUsd,
        estimatedCostNanoUsd: 0n,
        reason: msg,
      };
    }

    // 3. Compute Estimated Cost via Pricing Engine
    let estimatedCost: bigint;
    try {
      estimatedCost = this.pricingEngine.estimateCostNanoUsd(
        request.estimatedTokens,
        request.providerId,
        request.modelId
      );
    } catch (err) {
      if (strict) throw err;
      return {
        allowed: false,
        accountId: account.accountId,
        availableNanoUsd: account.availableSpendNanoUsd,
        estimatedCostNanoUsd: 0n,
        reason: (err as Error).message,
      };
    }

    // 4. Check available funds: available = limit - committed - reserved
    if (account.availableSpendNanoUsd < estimatedCost) {
      const msg = `Insufficient available budget in account '${account.accountId}': required ${estimatedCost} nano-USD, available ${account.availableSpendNanoUsd} nano-USD`;
      if (strict) {
        throw new BudgetError(msg, 'ERR_BUDGET_EXCEEDED', {
          accountId: account.accountId,
          availableNanoUsd: account.availableSpendNanoUsd,
          requestedNanoUsd: estimatedCost,
          limitNanoUsd: account.limitSpendNanoUsd,
          committedNanoUsd: account.committedSpendNanoUsd,
          reservedNanoUsd: account.reservedSpendNanoUsd,
        });
      }
      return {
        allowed: false,
        accountId: account.accountId,
        availableNanoUsd: account.availableSpendNanoUsd,
        estimatedCostNanoUsd: estimatedCost,
        reason: msg,
      };
    }

    return {
      allowed: true,
      accountId: account.accountId,
      availableNanoUsd: account.availableSpendNanoUsd,
      estimatedCostNanoUsd: estimatedCost,
    };
  }
}
