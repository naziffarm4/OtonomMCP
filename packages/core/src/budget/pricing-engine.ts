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

  private makeKey(providerId: string, modelId: string, serviceTier: string = 'standard'): string {
    const tier = (serviceTier || 'standard').toLowerCase();
    return `${providerId.toLowerCase()}::${modelId.toLowerCase()}::${tier}`;
  }

  /**
   * Registers a pricing rate. Validates that rates are strictly non-negative and denominators > 0.
   * Wildcard model IDs are rejected to enforce explicit, verifiable model pricing.
   */
  registerRate(input: PricingRateInput): PricingRate {
    if (!input.providerId || !input.modelId || input.modelId.trim() === '*' || input.modelId.trim() === '') {
      throw new BudgetError('Provider and a specific Model ID are required for pricing rate. Wildcards are not permitted.', 'ERR_INVALID_PRICING');
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

    const cacheWriteNum = input.cacheWriteRateNum ?? 0n;
    const cacheWriteDen = input.cacheWriteRateDen ?? 1n;
    if (cacheWriteNum < 0n || cacheWriteDen <= 0n) {
      throw new BudgetError('Cache-write rate parameters are invalid', 'ERR_INVALID_PRICING');
    }

    if (input.longContext) {
      if (input.longContext.inputRateNum < 0n || input.longContext.outputRateNum < 0n) {
        throw new BudgetError('Long-context rate numerators cannot be negative', 'ERR_INVALID_PRICING');
      }
      if (input.longContext.inputRateDen <= 0n || input.longContext.outputRateDen <= 0n) {
        throw new BudgetError('Long-context rate denominators must be strictly positive', 'ERR_INVALID_PRICING');
      }
      if (input.longContext.cachedInputRateNum !== undefined && input.longContext.cachedInputRateNum < 0n) {
        throw new BudgetError('Long-context cached rate parameters are invalid', 'ERR_INVALID_PRICING');
      }
      if (input.longContext.cachedInputRateDen !== undefined && input.longContext.cachedInputRateDen <= 0n) {
        throw new BudgetError('Long-context cached rate parameters are invalid', 'ERR_INVALID_PRICING');
      }
      if (input.longContext.cacheWriteRateNum !== undefined && input.longContext.cacheWriteRateNum < 0n) {
        throw new BudgetError('Long-context cache-write rate parameters are invalid', 'ERR_INVALID_PRICING');
      }
      if (input.longContext.cacheWriteRateDen !== undefined && input.longContext.cacheWriteRateDen <= 0n) {
        throw new BudgetError('Long-context cache-write rate parameters are invalid', 'ERR_INVALID_PRICING');
      }
    }

    const serviceTier = (input.serviceTier ?? 'standard').toLowerCase();

    const rate: PricingRate = {
      rateId: input.rateId ?? `${input.providerId}-${input.modelId}-${serviceTier}-${Date.now()}`,
      providerId: input.providerId,
      modelId: input.modelId,
      serviceTier,
      inputRateNum: input.inputRateNum,
      inputRateDen: input.inputRateDen,
      outputRateNum: input.outputRateNum,
      outputRateDen: input.outputRateDen,
      cachedInputRateNum: cachedNum,
      cachedInputRateDen: cachedDen,
      cacheWriteRateNum: cacheWriteNum,
      cacheWriteRateDen: cacheWriteDen,
      longContextThreshold: input.longContextThreshold,
      longContext: input.longContext,
      validFrom: input.validFrom ?? new Date().toISOString(),
    };

    this.rates.set(this.makeKey(input.providerId, input.modelId, serviceTier), rate);
    if (serviceTier === 'standard') {
      this.rates.set(`${input.providerId.toLowerCase()}::${input.modelId.toLowerCase()}`, rate);
    }
    return rate;
  }

  /**
   * Retrieves registered pricing rate or throws if missing (fail-closed).
   * Exact match only: no silent wildcard fallback for unknown models.
   */
  getRate(providerId: string, modelId: string, serviceTier: string = 'standard'): PricingRate {
    const tier = (serviceTier || 'standard').toLowerCase();
    const key = this.makeKey(providerId, modelId, tier);
    const rate = this.rates.get(key) ?? (tier === 'standard' ? this.rates.get(`${providerId.toLowerCase()}::${modelId.toLowerCase()}`) : undefined);
    if (!rate) {
      throw new BudgetError(
        `Pricing rate not found for provider '${providerId}', model '${modelId}', service tier '${tier}'`,
        'ERR_PRICING_NOT_FOUND',
        { providerId, modelId, serviceTier: tier }
      );
    }
    return rate;
  }

  /**
   * Calculates exact integer Nano-USD cost for reported or estimated token usage.
   * Fail-closed: missing pricing or negative/non-finite tokens throw immediately.
   */
  calculateCostNanoUsd(usage: TokenUsage, rate: PricingRate): bigint {
    if (
      typeof usage.inputTokens !== 'number' ||
      typeof usage.outputTokens !== 'number' ||
      !Number.isFinite(usage.inputTokens) ||
      !Number.isFinite(usage.outputTokens) ||
      usage.inputTokens < 0 ||
      usage.outputTokens < 0
    ) {
      throw new BudgetError('Token counts must be non-negative finite numbers', 'ERR_INVALID_PRICING');
    }

    if (usage.cachedTokens !== undefined && (!Number.isFinite(usage.cachedTokens) || usage.cachedTokens < 0)) {
      throw new BudgetError('Cached token count must be a non-negative finite number', 'ERR_INVALID_PRICING');
    }

    if (usage.cacheWriteTokens !== undefined && (!Number.isFinite(usage.cacheWriteTokens) || usage.cacheWriteTokens < 0)) {
      throw new BudgetError('Cache-write token count must be a non-negative finite number', 'ERR_INVALID_PRICING');
    }

    if (usage.reasoningTokens !== undefined && (!Number.isFinite(usage.reasoningTokens) || usage.reasoningTokens < 0)) {
      throw new BudgetError('Reasoning token count must be a non-negative finite number', 'ERR_INVALID_PRICING');
    }

    const totalInputTokens = BigInt(Math.floor(usage.inputTokens));
    const cachedTokens = BigInt(Math.floor(Math.max(0, usage.cachedTokens ?? 0)));
    const cacheWriteTokens = BigInt(Math.floor(Math.max(0, usage.cacheWriteTokens ?? 0)));
    const outputTokens = BigInt(Math.floor(usage.outputTokens));
    const reasoningTokens = BigInt(Math.floor(Math.max(0, usage.reasoningTokens ?? 0)));

    // Invariant: cached read + cache write cannot exceed total input
    if (cacheWriteTokens === 0n && cachedTokens > totalInputTokens) {
      throw new BudgetError(
        `Cached tokens (${cachedTokens}) cannot exceed total input tokens (${totalInputTokens})`,
        'ERR_INVALID_PRICING'
      );
    }
    if (cachedTokens + cacheWriteTokens > totalInputTokens) {
      throw new BudgetError(
        `Sum of cached tokens (${cachedTokens}) and cache-write tokens (${cacheWriteTokens}) cannot exceed total input tokens (${totalInputTokens})`,
        'ERR_INVALID_PRICING'
      );
    }

    // Invariant: reasoning tokens are output tokens and cannot exceed total output
    if (reasoningTokens > outputTokens) {
      throw new BudgetError(
        `Reasoning tokens (${reasoningTokens}) cannot exceed total output tokens (${outputTokens})`,
        'ERR_INVALID_PRICING'
      );
    }

    // Context Length Tier Determination
    const isLongContext =
      (rate.longContextThreshold !== undefined && totalInputTokens > BigInt(rate.longContextThreshold)) ||
      usage.contextTier === 'long';

    let activeInputRateNum = rate.inputRateNum;
    let activeInputRateDen = rate.inputRateDen;
    let activeOutputRateNum = rate.outputRateNum;
    let activeOutputRateDen = rate.outputRateDen;
    let activeCachedRateNum = rate.cachedInputRateNum;
    let activeCachedRateDen = rate.cachedInputRateDen;
    let activeCacheWriteRateNum = rate.cacheWriteRateNum ?? 0n;
    let activeCacheWriteRateDen = rate.cacheWriteRateDen ?? 1n;

    if (isLongContext) {
      if (!rate.longContext) {
        throw new BudgetError(
          `Request exceeds short-context limit of ${rate.longContextThreshold ?? 272000} tokens, but model '${rate.modelId}' has no long-context pricing registered`,
          'ERR_INVALID_PRICING'
        );
      }
      activeInputRateNum = rate.longContext.inputRateNum;
      activeInputRateDen = rate.longContext.inputRateDen;
      activeOutputRateNum = rate.longContext.outputRateNum;
      activeOutputRateDen = rate.longContext.outputRateDen;
      if (rate.longContext.cachedInputRateNum !== undefined && rate.longContext.cachedInputRateDen !== undefined) {
        activeCachedRateNum = rate.longContext.cachedInputRateNum;
        activeCachedRateDen = rate.longContext.cachedInputRateDen;
      }
      if (rate.longContext.cacheWriteRateNum !== undefined && rate.longContext.cacheWriteRateDen !== undefined) {
        activeCacheWriteRateNum = rate.longContext.cacheWriteRateNum;
        activeCacheWriteRateDen = rate.longContext.cacheWriteRateDen;
      }
    }

    // Cache-write pricing enforcement:
    // If cache-write tokens are reported, model MUST have registered cache-write rates > 0
    if (cacheWriteTokens > 0n && activeCacheWriteRateNum <= 0n) {
      throw new BudgetError(
        `Cache-write tokens (${cacheWriteTokens}) reported but rate for '${rate.modelId}' has no cache-write pricing registered`,
        'ERR_INVALID_PRICING'
      );
    }

    // Partitioned input calculation according to authoritative formula:
    // ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens
    const ordinaryInputTokens = totalInputTokens - cachedTokens - cacheWriteTokens;

    const inputCost = ceilDiv(ordinaryInputTokens * activeInputRateNum, activeInputRateDen);
    const cachedCost = cachedTokens > 0n
      ? ceilDiv(cachedTokens * activeCachedRateNum, activeCachedRateDen)
      : 0n;
    const cacheWriteCost = cacheWriteTokens > 0n
      ? ceilDiv(cacheWriteTokens * activeCacheWriteRateNum, activeCacheWriteRateDen)
      : 0n;
    // Output tokens (including reasoning tokens, which are billed at output token rates)
    const outputCost = ceilDiv(outputTokens * activeOutputRateNum, activeOutputRateDen);

    const totalCost = inputCost + cachedCost + cacheWriteCost + outputCost;

    if (totalCost > MAX_SAFE_INT64) {
      throw new BudgetError('Calculated cost exceeds maximum safe integer 64-bit value', 'ERR_INVALID_PRICING');
    }

    return totalCost;
  }

  /**
   * Helper to estimate cost for a provider & model.
   */
  estimateCostNanoUsd(usage: TokenUsage, providerId: string, modelId: string, serviceTier?: string): bigint {
    const rate = this.getRate(providerId, modelId, serviceTier ?? usage.serviceTier);
    return this.calculateCostNanoUsd(usage, rate);
  }
}
