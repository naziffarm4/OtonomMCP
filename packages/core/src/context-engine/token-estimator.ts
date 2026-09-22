import type { ContextTokenInfo } from './context-types.js';

/**
 * Deterministically estimates token counts for text according to Architecture Section 9.
 * 
 * Rules:
 * - is_exact_provider_metric is strictly false for local estimation.
 * - reported provider fields and estimated_cost_usd are null (never fabricated).
 * - estimated_tokens is deterministically calculated (~4 chars per token).
 */
export function estimateContextTokens(text: string | null | undefined): ContextTokenInfo {
  if (!text || text.length === 0) {
    return {
      reported_input_tokens: null,
      reported_output_tokens: null,
      reported_cached_tokens: null,
      estimated_tokens: 0,
      estimated_cost_usd: null,
      provider_name: null,
      model: null,
      is_exact_provider_metric: false,
    };
  }

  // Deterministic estimation: 1 token ~= 4 chars of UTF-8 text/code
  const estimated = Math.max(1, Math.ceil(text.length / 4));

  return {
    reported_input_tokens: null,
    reported_output_tokens: null,
    reported_cached_tokens: null,
    estimated_tokens: estimated,
    estimated_cost_usd: null,
    provider_name: null,
    model: null,
    is_exact_provider_metric: false,
  };
}
