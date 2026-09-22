import type { TokenTelemetry, ModelPricing } from './budget-types.js';

/**
 * Calculates token cost deterministically when explicit and sufficient pricing is supplied.
 * 
 * Rules (Architecture Section 9):
 * 1. If pricing is null, undefined, or empty -> return null.
 * 2. If provider metrics are missing or unavailable -> return null.
 * 3. If required pricing rates are incomplete for reported token metrics -> return null.
 * 4. Never fabricate or invent pricing or cost.
 */
export function calculateTokenCost(
  telemetry: TokenTelemetry,
  pricing?: ModelPricing | null
): number | null {
  if (!pricing || typeof pricing !== 'object') {
    return null;
  }

  // Provider metrics must be present to compute exact defensible cost
  const inputTokens = telemetry.reported_input_tokens;
  const outputTokens = telemetry.reported_output_tokens;
  const cachedTokens = telemetry.reported_cached_tokens;

  // If no exact tokens reported at all, cannot compute defensible cost
  if (inputTokens === null && outputTokens === null) {
    return null;
  }

  let totalCost = 0;

  // If cached tokens are reported (>0), cached pricing rate MUST be supplied and valid
  let cachedRatePerToken: number | undefined;
  if (cachedTokens !== null && cachedTokens > 0) {
    const cachedRatePerMillion = pricing.cachedTokenRateUsdPerMillion;
    cachedRatePerToken =
      pricing.cachedTokenRateUsd ??
      (cachedRatePerMillion !== undefined ? cachedRatePerMillion / 1_000_000 : undefined);

    if (cachedRatePerToken === undefined || cachedRatePerToken < 0) {
      // Incomplete pricing for reported cached tokens
      return null;
    }
  }

  // 1. Prompt / Input Token Rate
  const promptRatePerMillion = pricing.promptTokenRateUsdPerMillion;
  const promptRatePerToken =
    pricing.promptTokenRateUsd ??
    (promptRatePerMillion !== undefined ? promptRatePerMillion / 1_000_000 : undefined);

  if (inputTokens !== null && inputTokens > 0) {
    if (promptRatePerToken === undefined || promptRatePerToken < 0) {
      // Incomplete pricing for reported input tokens
      return null;
    }

    // If cached tokens are reported, handle cached vs non-cached prompt tokens
    if (cachedTokens !== null && cachedTokens > 0 && cachedRatePerToken !== undefined) {
      const nonCachedTokens = Math.max(0, inputTokens - cachedTokens);
      totalCost += nonCachedTokens * promptRatePerToken;
      totalCost += cachedTokens * cachedRatePerToken;
    } else {
      totalCost += inputTokens * promptRatePerToken;
    }
  }

  // 2. Completion / Output Token Rate
  const completionRatePerMillion = pricing.completionTokenRateUsdPerMillion;
  const completionRatePerToken =
    pricing.completionTokenRateUsd ??
    (completionRatePerMillion !== undefined ? completionRatePerMillion / 1_000_000 : undefined);

  if (outputTokens !== null && outputTokens > 0) {
    if (completionRatePerToken === undefined || completionRatePerToken < 0) {
      // Incomplete pricing for reported output tokens
      return null;
    }
    totalCost += outputTokens * completionRatePerToken;
  }

  // Deterministic float representation
  return Number(totalCost.toFixed(8));
}
