import { BudgetError } from '../errors/budget-error.js';
import {
  type PricingRate,
  type PricingRateInput,
  type TokenUsage,
  ceilDiv,
  MAX_SAFE_INT64,
} from './budget-types.js';

export class PricingEngine {
  private rates = new Map<string, PricingRate>();

  private makeKey(providerId: string, modelId: string): string {
    return `${providerId.toLowerCase()}::${modelId.toLowerCase()}`;
  }

  /**
   * Registers a pricing rate. Validates that rates are strictly non-negative and denominators > 0.
   */
  registerRate(input: PricingRateInput): PricingRate {
    if (!input.providerId || !input.modelId) {
      throw new BudgetError('Provider and Model ID are required for pricing rate', 'ERR_INVALID_PRICING');
    }
    if (input.inputRateNum < 0n || input.outputRateNum < 0n) {
      throw new BudgetError('Rate numerators cannot be negative', 'ERR_INVALID_PRICING');
    }
    if (input.inputRateDen <= 0n || input.outputRateDen <= 0n) {
      throw new BudgetError('Rate denominators must be strictly positive', 'ERR_INVALID_PRICING');
    }

    const cachedNum = input.cachedInputRateNum ?? 0n;
    const cachedDen = input.cachedInputRateDen ?? 1n;
    if (cachedNum < 0n || cachedDen <= 0n) {
      throw new BudgetError('Cached rate parameters are invalid', 'ERR_INVALID_PRICING');
    }

    const rate: PricingRate = {
      rateId: input.rateId ?? `${input.providerId}-${input.modelId}-${Date.now()}`,
      providerId: input.providerId,
      modelId: input.modelId,
      inputRateNum: input.inputRateNum,
      inputRateDen: input.inputRateDen,
      outputRateNum: input.outputRateNum,
      outputRateDen: input.outputRateDen,
      cachedInputRateNum: cachedNum,
      cachedInputRateDen: cachedDen,
      validFrom: input.validFrom ?? new Date().toISOString(),
    };

    this.rates.set(this.makeKey(input.providerId, input.modelId), rate);
    return rate;
  }

  /**
   * Retrieves registered pricing rate or throws if missing (fail-closed).
   */
  getRate(providerId: string, modelId: string): PricingRate {
    const key = this.makeKey(providerId, modelId);
    const rate = this.rates.get(key);
    if (!rate) {
      throw new BudgetError(
        `Pricing rate not found for provider '${providerId}' and model '${modelId}'`,
        'ERR_PRICING_NOT_FOUND',
        { providerId, modelId }
      );
    }
    return rate;
  }

  /**
   * Calculates exact integer Nano-USD cost for reported or estimated token usage.
   * Fail-closed: missing pricing or negative tokens throw immediately.
   */
  calculateCostNanoUsd(usage: TokenUsage, rate: PricingRate): bigint {
    if (usage.inputTokens < 0 || usage.outputTokens < 0) {
      throw new BudgetError('Token counts cannot be negative', 'ERR_INVALID_PRICING');
    }

    const cachedTokens = BigInt(Math.max(0, usage.cachedTokens ?? 0));
    const totalInputTokens = BigInt(usage.inputTokens);
    const outputTokens = BigInt(usage.outputTokens);

    let uncachedInputTokens = totalInputTokens;
    let cachedCost = 0n;

    if (cachedTokens > 0n) {
      if (cachedTokens > totalInputTokens) {
        throw new BudgetError(
          `Cached tokens (${cachedTokens}) cannot exceed total input tokens (${totalInputTokens})`,
          'ERR_INVALID_PRICING'
        );
      }
      uncachedInputTokens = totalInputTokens - cachedTokens;
      cachedCost = ceilDiv(cachedTokens * rate.cachedInputRateNum, rate.cachedInputRateDen);
    }

    const inputCost = ceilDiv(uncachedInputTokens * rate.inputRateNum, rate.inputRateDen);
    const outputCost = ceilDiv(outputTokens * rate.outputRateNum, rate.outputRateDen);

    const totalCost = inputCost + cachedCost + outputCost;

    if (totalCost > MAX_SAFE_INT64) {
      throw new BudgetError('Calculated cost exceeds maximum safe integer 64-bit value', 'ERR_INVALID_PRICING');
    }

    return totalCost;
  }

  /**
   * Helper to estimate cost for a provider & model.
   */
  estimateCostNanoUsd(usage: TokenUsage, providerId: string, modelId: string): bigint {
    const rate = this.getRate(providerId, modelId);
    return this.calculateCostNanoUsd(usage, rate);
  }
}
