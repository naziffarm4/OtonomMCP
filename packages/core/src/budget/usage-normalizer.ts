/**
 * Usage Normalizer & Billing Reconciliation Gate
 *
 * Enforces fail-closed usage normalization, documented schema contracts,
 * integer token count validation, and authoritative service-tier reconciliation.
 *
 * ============================================================================
 * DOCUMENTED USAGE SCHEMAS & POLICIES (Architecture & Official Documentation)
 * ============================================================================
 *
 * 1. OpenAI Chat Completions API (`v1/chat/completions`) & Responses API (`v1/responses`):
 *    Official Sources:
 *      https://developers.openai.com/api/docs/pricing
 *      https://developers.openai.com/api/docs/guides/prompt-caching
 *      https://developers.openai.com/api/docs/models/gpt-6-luna
 *
 *    - Mandatory Fields:
 *      * `prompt_tokens` (or `reported_input_tokens`): Integer >= 0.
 *      * `completion_tokens` (or `reported_output_tokens`): Integer >= 0.
 *      * If either is omitted, null, non-integer, negative, or NaN/Infinity,
 *        usage is INCOMPLETE/MALFORMED. The engine REFUSES to settle using estimates.
 *
 *    - Optional / Conditional Fields:
 *      * `prompt_tokens_details.cached_tokens`: Integer >= 0.
 *        Schema policy: For models supporting prompt caching (e.g. gpt-4o, gpt-6-luna),
 *        cache read hits are returned here. If prompt_tokens_details is absent or
 *        cached_tokens is omitted, cached reads are 0. Uncached input is billed at the
 *        higher base rate, so omission never undercharges.
 *
 *      * `prompt_tokens_details.cache_write_tokens`: Integer >= 0.
 *        Schema policy: For models that charge for cache writes (e.g. gpt-6-luna at 1.25x),
 *        cache-write is an active pricing dimension. If a model charges cache writes,
 *        an omission of cache_write_tokens CANNOT be assumed to be 0 unless prompt caching
 *        was explicitly disabled. Assuming 0 when cache writes cost 1.25x would cause a
 *        silent undercharge. Therefore, omission on cache-write models fails closed to UNKNOWN.
 *        For models where cache writes are not billed (e.g. gpt-4o, gpt-4o-mini), omission
 *        is safely treated as 0 cost.
 *
 *      * `completion_tokens_details.reasoning_tokens`: Integer >= 0.
 *        Schema policy: Reasoning tokens are a constituent part of `completion_tokens`
 *        and billed at the output token rate. They must not exceed completion_tokens.
 *
 *      * `service_tier`: String ("default", "scale", "priority", "flex", "batch", "fast").
 *        Schema policy: Provider-reported tier is authoritative. If omitted, discounted
 *        tiers ('batch', 'flex') fall back to 'standard' to prevent undercharging.
 *
 *    - Guaranteed Absent Fields:
 *      * For non-caching models (e.g. gpt-3.5-turbo), prompt_tokens_details is absent;
 *        cached_tokens and cache_write_tokens are guaranteed 0.
 *
 * 2. Anthropic Messages API (`v1/messages`):
 *    - Mandatory: `input_tokens`, `output_tokens` (Integers >= 0).
 *    - Optional: `cache_creation_input_tokens` (cache write), `cache_read_input_tokens` (cache read).
 *
 * 3. Reference Adapter / Normalized Telemetry:
 *    - Mandatory: `reported_input_tokens`, `reported_output_tokens` (Integers >= 0).
 *    - Optional: `reported_cached_tokens`, `reported_cache_write_tokens`, `reported_reasoning_tokens`.
 */

import { BudgetError, type BudgetErrorCode } from '../errors/budget-error.js';
import type { LlmRequest, LlmResponse } from '../llm-bridge/llm-types.js';
import type { PricingRate, TokenUsage } from './budget-types.js';
import type { PricingEngine } from './pricing-engine.js';

export interface NormalizedUsageSuccess {
  readonly success: true;
  readonly usage: TokenUsage;
  readonly effectiveServiceTier: string;
}

export interface NormalizedUsageFailure {
  readonly success: false;
  readonly errorReason: string;
  readonly errorCode: BudgetErrorCode;
}

export type UsageNormalizationResult = NormalizedUsageSuccess | NormalizedUsageFailure;

export class UsageNormalizer {
  /**
   * Normalizes raw response usage into an exact, validated TokenUsage object.
   * Enforces fail-closed handling on missing, partial, fractional, or inconsistent metrics.
   */
  static normalizeAndReconcile(params: {
    response: LlmResponse<unknown>;
    request: LlmRequest;
    modelId: string;
    rate: PricingRate;
    pricingEngine: PricingEngine;
    providerId: string;
  }): UsageNormalizationResult {
    const { response, request, modelId, rate, pricingEngine, providerId } = params;

    // 1. Regional / Data-residency surcharge check
    if (
      request.metadata?.regional ||
      request.metadata?.data_residency ||
      request.metadata?.dataResidency ||
      request.metadata?.regional_processing
    ) {
      return {
        success: false,
        errorReason: 'Regional processing and data-residency billing surcharges are not currently supported by pricing engine; rejected fail-closed to prevent billing inaccuracy',
        errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      };
    }

    // 2. Validate Usage Object Presence
    const rawUsage = response?.usage as unknown as Record<string, unknown> | undefined;
    if (!rawUsage || typeof rawUsage !== 'object') {
      return {
        success: false,
        errorReason: 'Provider response omitted usage metrics; cannot settle without authoritative metrics',
        errorCode: 'ERR_USAGE_MISSING',
      };
    }

    // 3. Mandatory Input Token Validation (No Fallback to Estimates)
    const rawInput =
      rawUsage.prompt_tokens ??
      rawUsage.reported_input_tokens ??
      rawUsage.input_tokens;

    if (rawInput === undefined || rawInput === null) {
      return {
        success: false,
        errorReason: 'Provider response omitted input/prompt tokens; refusing to settle using estimated usage as actual',
        errorCode: 'ERR_USAGE_INCOMPLETE',
      };
    }

    if (typeof rawInput !== 'number' || !Number.isInteger(rawInput) || rawInput < 0) {
      return {
        success: false,
        errorReason: `Provider reported invalid input token count: ${String(rawInput)}; must be non-negative integer`,
        errorCode: 'ERR_USAGE_MALFORMED',
      };
    }

    // 4. Mandatory Output Token Validation (No Fallback to Estimates)
    let rawOutput =
      rawUsage.completion_tokens ??
      rawUsage.reported_output_tokens ??
      rawUsage.output_tokens;

    if (rawOutput === undefined || rawOutput === null) {
      return {
        success: false,
        errorReason: 'Provider response omitted output/completion tokens; refusing to settle using estimated usage as actual',
        errorCode: 'ERR_USAGE_INCOMPLETE',
      };
    }

    if (typeof rawOutput !== 'number' || !Number.isInteger(rawOutput) || rawOutput < 0) {
      return {
        success: false,
        errorReason: `Provider reported invalid output token count: ${String(rawOutput)}; must be non-negative integer`,
        errorCode: 'ERR_USAGE_MALFORMED',
      };
    }

    // 5. Reasoning Token Validation & Accounting
    const promptDetails = rawUsage.prompt_tokens_details as Record<string, unknown> | undefined;
    const compDetails = rawUsage.completion_tokens_details as Record<string, unknown> | undefined;
    const outDetails = rawUsage.output_tokens_details as Record<string, unknown> | undefined;
    const inDetails = rawUsage.input_tokens_details as Record<string, unknown> | undefined;

    const rawReasoning =
      rawUsage.reasoning_tokens ??
      rawUsage.reported_reasoning_tokens ??
      compDetails?.reasoning_tokens ??
      outDetails?.reasoning_tokens;

    let reasoningTokens = 0;
    if (rawReasoning !== undefined && rawReasoning !== null) {
      if (typeof rawReasoning !== 'number' || !Number.isInteger(rawReasoning) || rawReasoning < 0) {
        return {
          success: false,
          errorReason: `Provider reported invalid reasoning token count: ${String(rawReasoning)}; must be non-negative integer`,
          errorCode: 'ERR_USAGE_MALFORMED',
        };
      }
      reasoningTokens = rawReasoning;

      // In OpenAI schema, completion_tokens already includes reasoning_tokens.
      // If reasoning_tokens was reported separately outside completion_tokens_details, ensure it is in rawOutput:
      if (compDetails?.reasoning_tokens === undefined && outDetails?.reasoning_tokens === undefined && rawUsage.reasoning_tokens !== undefined) {
        rawOutput += reasoningTokens;
      }
    }

    if (reasoningTokens > rawOutput) {
      return {
        success: false,
        errorReason: `Reasoning tokens (${reasoningTokens}) cannot exceed total output tokens (${rawOutput})`,
        errorCode: 'ERR_USAGE_INCONSISTENT',
      };
    }

    // 6. Cached Input (Cache Read) Validation
    const rawCached =
      rawUsage.cached_tokens ??
      rawUsage.reported_cached_tokens ??
      promptDetails?.cached_tokens ??
      inDetails?.cached_tokens ??
      rawUsage.cache_read_input_tokens;

    let cachedTokens = 0;
    if (rawCached !== undefined && rawCached !== null) {
      if (typeof rawCached !== 'number' || !Number.isInteger(rawCached) || rawCached < 0) {
        return {
          success: false,
          errorReason: `Provider reported invalid cached token count: ${String(rawCached)}; must be non-negative integer`,
          errorCode: 'ERR_USAGE_MALFORMED',
        };
      }
      cachedTokens = rawCached;
    } else {
      // Documented schema policy: Absence of prompt_tokens_details or cached_tokens represents
      // 0 cached tokens. Uncached base rate applies to full input, which never undercharges.
      cachedTokens = 0;
    }

    // 7. Cache-Write Validation according to Documented Schema Policy
    const rawCacheWrite =
      rawUsage.cache_write_tokens ??
      rawUsage.reported_cache_write_tokens ??
      promptDetails?.cache_write_tokens ??
      inDetails?.cache_write_tokens ??
      rawUsage.cache_creation_input_tokens;

    let cacheWriteTokens = 0;
    const modelChargesCacheWrite = (rate.cacheWriteRateNum ?? 0n) > 0n;

    if (rawCacheWrite !== undefined && rawCacheWrite !== null) {
      if (typeof rawCacheWrite !== 'number' || !Number.isInteger(rawCacheWrite) || rawCacheWrite < 0) {
        return {
          success: false,
          errorReason: `Provider reported invalid cache-write token count: ${String(rawCacheWrite)}; must be non-negative integer`,
          errorCode: 'ERR_USAGE_MALFORMED',
        };
      }
      cacheWriteTokens = rawCacheWrite;
    } else {
      // Missing cache-write usage:
      // If the model bills cache-writes at a higher rate (e.g. gpt-6-luna at 1.25x),
      // we CANNOT assume 0 cache-writes if caching was possible.
      // Omission of cache_write_tokens would silently undercharge if cache writes occurred!
      if (modelChargesCacheWrite) {
        return {
          success: false,
          errorReason: `Model '${modelId}' has cache-write pricing (1.25x rate), but provider response omitted cache_write_tokens. Refusing to settle incomplete usage as zero-write.`,
          errorCode: 'ERR_USAGE_INCOMPLETE',
        };
      }
      // For models where cache writes are not billed (e.g. gpt-4o, gpt-4o-mini), omission is safely 0 cost.
      cacheWriteTokens = 0;
    }

    // 8. Total Input Partition Invariant: cached + cacheWrite <= total input
    if (cachedTokens + cacheWriteTokens > rawInput) {
      return {
        success: false,
        errorReason: `Sum of cached tokens (${cachedTokens}) and cache-write tokens (${cacheWriteTokens}) cannot exceed total input tokens (${rawInput})`,
        errorCode: 'ERR_USAGE_INCONSISTENT',
      };
    }

    // 9. Reconcile Actual Billed Service Tier
    const requestedTier = (request.metadata?.service_tier ?? request.metadata?.serviceTier ?? 'standard') as string;

    const reportedTierRaw =
      (response as any).service_tier ??
      rawUsage.service_tier ??
      (response.raw_metadata as any)?.service_tier ??
      (response as any).metadata?.service_tier;

    let reportedTier: string | null = null;
    if (typeof reportedTierRaw === 'string' && reportedTierRaw.trim().length > 0) {
      const lower = reportedTierRaw.trim().toLowerCase();
      if (lower === 'default' || lower === 'scale' || lower === 'standard') {
        reportedTier = 'standard';
      } else if (lower === 'priority' || lower === 'fast') {
        reportedTier = 'fast';
      } else if (lower === 'flex') {
        reportedTier = 'flex';
      } else if (lower === 'batch') {
        reportedTier = 'batch';
      } else {
        reportedTier = lower;
      }
    }

    let effectiveTier = requestedTier;
    if (reportedTier !== null) {
      // Provider-reported tier is authoritative
      effectiveTier = reportedTier;
    } else {
      // Provider did not report service tier:
      // If requested tier is a discounted tier ('batch' or 'flex'), provider did not confirm discount!
      // Policy: Never silently settle at a cheaper tier when actual tier is uncertain!
      // Fallback to standard tier (undiscounted rate), preventing undercharge.
      if (requestedTier === 'batch' || requestedTier === 'flex') {
        effectiveTier = 'standard';
      } else if (requestedTier === 'fast') {
        effectiveTier = 'fast'; // Priority requested; do not undercharge
      } else {
        effectiveTier = 'standard';
      }
    }

    // Verify pricing rate exists for effective tier
    try {
      pricingEngine.getRate(providerId, modelId, effectiveTier);
    } catch {
      return {
        success: false,
        errorReason: `Service tier '${effectiveTier}' is unsupported or has no registered pricing for model '${modelId}' under provider '${providerId}'`,
        errorCode: 'ERR_PRICING_NOT_FOUND',
      };
    }

    return {
      success: true,
      usage: {
        inputTokens: rawInput,
        outputTokens: rawOutput,
        cachedTokens,
        cacheWriteTokens,
        reasoningTokens,
        serviceTier: effectiveTier,
      },
      effectiveServiceTier: effectiveTier,
    };
  }
}
