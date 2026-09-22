import type { TokenTelemetry } from './budget-types.js';

/**
 * Creates telemetry for exact provider-reported metrics (Architecture Section 9).
 * Preserves exact metrics without fabricating missing fields.
 */
export function createExactTelemetry(params: {
  reportedInputTokens: number;
  reportedOutputTokens?: number | null;
  reportedCachedTokens?: number | null;
  estimatedCostUsd?: number | null;
  providerName?: string | null;
  model?: string | null;
}): TokenTelemetry {
  const input = params.reportedInputTokens;
  const output = params.reportedOutputTokens ?? null;
  const cached = params.reportedCachedTokens ?? null;

  // Estimated tokens reflects the total reported tokens when exact metrics are available
  const totalTokens = input + (output ?? 0);

  return {
    reported_input_tokens: input,
    reported_output_tokens: output,
    reported_cached_tokens: cached,
    estimated_tokens: totalTokens,
    estimated_cost_usd: params.estimatedCostUsd ?? null,
    provider_name: params.providerName ?? null,
    model: params.model ?? null,
    is_exact_provider_metric: true,
  };
}

/**
 * Creates telemetry for local deterministic estimation.
 * Rules (Section 9):
 * - is_exact_provider_metric is strictly false.
 * - reported provider fields are strictly null.
 * - estimated_cost_usd is strictly null (never fabricated).
 * - estimated_tokens is deterministically calculated via character ratio (~4 chars/token).
 */
export function createEstimatedTelemetry(params?: {
  text?: string | null;
  estimatedTokens?: number;
  providerName?: string | null;
  model?: string | null;
}): TokenTelemetry {
  let estimated = 0;

  if (params?.estimatedTokens !== undefined) {
    estimated = Math.max(0, Math.floor(params.estimatedTokens));
  } else if (params?.text && params.text.length > 0) {
    estimated = Math.max(1, Math.ceil(params.text.length / 4));
  }

  return {
    reported_input_tokens: null,
    reported_output_tokens: null,
    reported_cached_tokens: null,
    estimated_tokens: estimated,
    estimated_cost_usd: null,
    provider_name: params?.providerName ?? null,
    model: params?.model ?? null,
    is_exact_provider_metric: false,
  };
}

/**
 * Normalizes an arbitrary telemetry object into a canonical TokenTelemetry representation.
 * Prevents collapsing exact and estimated metrics into ambiguous numbers.
 */
export function normalizeTelemetry(raw: unknown): TokenTelemetry {
  if (!raw || typeof raw !== 'object') {
    return createEstimatedTelemetry();
  }

  const obj = raw as Record<string, unknown>;

  const reportedInput =
    typeof obj.reported_input_tokens === 'number' && Number.isFinite(obj.reported_input_tokens)
      ? Math.max(0, Math.floor(obj.reported_input_tokens))
      : null;

  const reportedOutput =
    typeof obj.reported_output_tokens === 'number' && Number.isFinite(obj.reported_output_tokens)
      ? Math.max(0, Math.floor(obj.reported_output_tokens))
      : null;

  const reportedCached =
    typeof obj.reported_cached_tokens === 'number' && Number.isFinite(obj.reported_cached_tokens)
      ? Math.max(0, Math.floor(obj.reported_cached_tokens))
      : null;

  const isExact = Boolean(obj.is_exact_provider_metric && reportedInput !== null);

  const estimatedTokens =
    typeof obj.estimated_tokens === 'number' && Number.isFinite(obj.estimated_tokens)
      ? Math.max(0, Math.floor(obj.estimated_tokens))
      : (reportedInput ?? 0) + (reportedOutput ?? 0);

  const estimatedCost =
    typeof obj.estimated_cost_usd === 'number' && Number.isFinite(obj.estimated_cost_usd)
      ? Math.max(0, obj.estimated_cost_usd)
      : null;

  const providerName = typeof obj.provider_name === 'string' ? obj.provider_name : null;
  const model = typeof obj.model === 'string' ? obj.model : null;

  return {
    reported_input_tokens: reportedInput,
    reported_output_tokens: reportedOutput,
    reported_cached_tokens: reportedCached,
    estimated_tokens: estimatedTokens,
    estimated_cost_usd: estimatedCost,
    provider_name: providerName,
    model,
    is_exact_provider_metric: isExact,
  };
}

/**
 * Deterministically combines two telemetry objects.
 * If either telemetry is estimated, the combined result is marked as estimated.
 */
export function combineTelemetry(a: TokenTelemetry, b: TokenTelemetry): TokenTelemetry {
  const normA = normalizeTelemetry(a);
  const normB = normalizeTelemetry(b);

  const bothExact = normA.is_exact_provider_metric && normB.is_exact_provider_metric;

  const combinedInput =
    normA.reported_input_tokens !== null && normB.reported_input_tokens !== null
      ? normA.reported_input_tokens + normB.reported_input_tokens
      : null;

  const combinedOutput =
    normA.reported_output_tokens !== null && normB.reported_output_tokens !== null
      ? normA.reported_output_tokens + normB.reported_output_tokens
      : null;

  const combinedCached =
    normA.reported_cached_tokens !== null && normB.reported_cached_tokens !== null
      ? normA.reported_cached_tokens + normB.reported_cached_tokens
      : normA.reported_cached_tokens ?? normB.reported_cached_tokens;

  const combinedEstimatedTokens = normA.estimated_tokens + normB.estimated_tokens;

  const combinedCost =
    normA.estimated_cost_usd !== null && normB.estimated_cost_usd !== null
      ? Number((normA.estimated_cost_usd + normB.estimated_cost_usd).toFixed(8))
      : null;

  const provider = normA.provider_name === normB.provider_name ? normA.provider_name : null;
  const model = normA.model === normB.model ? normA.model : null;

  return {
    reported_input_tokens: bothExact ? combinedInput : null,
    reported_output_tokens: bothExact ? combinedOutput : null,
    reported_cached_tokens: bothExact ? combinedCached : null,
    estimated_tokens: combinedEstimatedTokens,
    estimated_cost_usd: combinedCost,
    provider_name: provider,
    model,
    is_exact_provider_metric: bothExact,
  };
}
