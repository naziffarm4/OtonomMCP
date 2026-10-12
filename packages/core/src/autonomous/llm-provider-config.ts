/**
 * @file llm-provider-config.ts
 * @description Configurable OpenAI-compatible Director LLM provider for autonomous runs.
 *
 * Env / config:
 *   AIDM_LLM_API_KEY | OPENAI_API_KEY | XAI_API_KEY   (first non-empty wins, in this order)
 *   AIDM_LLM_ENDPOINT  (default: https://api.openai.com/v1/chat/completions,
 *                       or https://api.x.ai/v1/chat/completions when only XAI_API_KEY is set)
 *   AIDM_LLM_MODEL     (default: gpt-6-luna for OpenAI — same default as the OpenAI DirectorRuntime —, grok-4 for xAI)
 *   AIDM_LLM_REASONING_EFFORT  none|minimal|low|medium|high|xhigh|max (reasoning models only;
 *                       default medium). Invalid values fail closed.
 *   AIDM_LLM_INPUT_USD_PER_MTOK / AIDM_LLM_OUTPUT_USD_PER_MTOK / AIDM_LLM_CACHED_INPUT_USD_PER_MTOK
 *     Operator-declared pricing (USD per 1M tokens). REQUIRED for any non-OpenAI host
 *     (e.g. api.x.ai) and for OpenAI models without built-in verified pricing.
 *     Budget governance (P18-03) is never bypassed: without pricing the run fails closed
 *     before any request is dispatched.
 *
 * Secrets are never logged or returned; only the env var *name* is reported.
 */

import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import {
  ReferenceLlmAdapter,
  OPENAI_REASONING_EFFORTS,
  isOpenAiReasoningModel,
  type OpenAiReasoningEffort,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
} from '../llm-bridge/reference-llm-adapter.js';
import { HttpLlmTransport } from '../llm-bridge/http-llm-transport.js';
import type { BudgetManager } from '../budget/budget-manager.js';
import { DEFAULT_OPENAI_DIRECTOR_MODEL, DEFAULT_REASONING_EFFORT } from '../director/openai-director-runtime.js';
import { STANDARD_OPENAI_HOSTS, registerCustomEndpointContract } from '../budget/endpoint-audit.js';

export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_XAI_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

export type LlmProviderKind = 'openai' | 'xai' | 'openai-compatible';

export interface LlmPricingUsdPerMTok {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
}

export interface ResolvedLlmProviderConfig {
  readonly kind: LlmProviderKind;
  readonly endpoint: string;
  readonly host: string;
  readonly model: string;
  readonly apiKeyEnvVar: string | null;
  readonly hasApiKey: boolean;
  readonly pricing: LlmPricingUsdPerMTok | null;
  /** Billing provider id used for pricing lookup ('openai' or the host for custom endpoints). */
  readonly billingProviderId: string;
  /** Effective reasoning_effort (undefined for non-reasoning models). */
  readonly reasoningEffort?: OpenAiReasoningEffort;
}

export class LlmProviderConfigError extends Error {
  readonly code: string;
  constructor(message: string, code = 'LLM_PROVIDER_CONFIG_INVALID') {
    super(message);
    this.name = 'LlmProviderConfigError';
    this.code = code;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function parseUsd(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new LlmProviderConfigError(`${name} must be a non-negative number (USD per 1M tokens).`, 'LLM_PRICING_INVALID');
  }
  return n;
}

export interface ResolveLlmConfigOverrides {
  readonly endpoint?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** Pure resolution of provider configuration from env (+ optional CLI overrides). */
export function resolveLlmProviderConfig(
  env: Env = process.env,
  overrides: ResolveLlmConfigOverrides = {}
): ResolvedLlmProviderConfig {
  const keyCandidates: Array<[string, string | undefined]> = [
    ['AIDM_LLM_API_KEY', nonEmpty(env.AIDM_LLM_API_KEY)],
    ['OPENAI_API_KEY', nonEmpty(env.OPENAI_API_KEY)],
    ['XAI_API_KEY', nonEmpty(env.XAI_API_KEY)],
  ];
  const keyHit = keyCandidates.find(([, v]) => v !== undefined);
  const apiKeyEnvVar = keyHit ? keyHit[0] : null;

  const explicitEndpoint = nonEmpty(overrides.endpoint) ?? nonEmpty(env.AIDM_LLM_ENDPOINT);
  const endpoint =
    explicitEndpoint ?? (apiKeyEnvVar === 'XAI_API_KEY' ? DEFAULT_XAI_ENDPOINT : DEFAULT_OPENAI_ENDPOINT);

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new LlmProviderConfigError(`AIDM_LLM_ENDPOINT is not a valid URL.`, 'LLM_ENDPOINT_INVALID');
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new LlmProviderConfigError('AIDM_LLM_ENDPOINT must use https (http only allowed for localhost).', 'LLM_ENDPOINT_INSECURE');
  }
  if (parsed.username || parsed.password) {
    throw new LlmProviderConfigError('AIDM_LLM_ENDPOINT must not embed credentials.', 'LLM_ENDPOINT_INVALID');
  }
  if (!parsed.pathname.toLowerCase().endsWith('/chat/completions')) {
    throw new LlmProviderConfigError(
      'AIDM_LLM_ENDPOINT must be an OpenAI-compatible chat completions URL (…/v1/chat/completions).',
      'LLM_ENDPOINT_UNSUPPORTED'
    );
  }

  const kind: LlmProviderKind = STANDARD_OPENAI_HOSTS.has(host)
    ? 'openai'
    : host === 'api.x.ai'
    ? 'xai'
    : 'openai-compatible';

  const model =
    nonEmpty(overrides.model) ??
    nonEmpty(env.AIDM_LLM_MODEL) ??
    nonEmpty(env.OPENAI_MODEL) ??
    (kind === 'xai' ? 'grok-4' : kind === 'openai' ? DEFAULT_OPENAI_DIRECTOR_MODEL : '');
  if (!model) {
    throw new LlmProviderConfigError('AIDM_LLM_MODEL is required for custom OpenAI-compatible endpoints.', 'LLM_MODEL_REQUIRED');
  }

  const input = parseUsd('AIDM_LLM_INPUT_USD_PER_MTOK', env.AIDM_LLM_INPUT_USD_PER_MTOK);
  const output = parseUsd('AIDM_LLM_OUTPUT_USD_PER_MTOK', env.AIDM_LLM_OUTPUT_USD_PER_MTOK);
  const cached = parseUsd('AIDM_LLM_CACHED_INPUT_USD_PER_MTOK', env.AIDM_LLM_CACHED_INPUT_USD_PER_MTOK);
  if ((input === undefined) !== (output === undefined)) {
    throw new LlmProviderConfigError(
      'Both AIDM_LLM_INPUT_USD_PER_MTOK and AIDM_LLM_OUTPUT_USD_PER_MTOK must be set together.',
      'LLM_PRICING_INVALID'
    );
  }
  const pricing = input !== undefined && output !== undefined ? { input, output, cachedInput: cached } : null;

  const rawEffort = (nonEmpty(overrides.reasoningEffort) ?? nonEmpty(env.AIDM_LLM_REASONING_EFFORT))?.toLowerCase();
  if (rawEffort !== undefined && !(OPENAI_REASONING_EFFORTS as readonly string[]).includes(rawEffort)) {
    throw new LlmProviderConfigError(
      `AIDM_LLM_REASONING_EFFORT must be one of ${OPENAI_REASONING_EFFORTS.join(', ')} (got '${rawEffort}').`,
      'LLM_CONFIG_INVALID'
    );
  }
  const reasoningEffort = isOpenAiReasoningModel(model)
    ? ((rawEffort as OpenAiReasoningEffort | undefined) ?? DEFAULT_REASONING_EFFORT)
    : undefined;

  return Object.freeze({
    kind,
    endpoint,
    host,
    model,
    apiKeyEnvVar,
    hasApiKey: apiKeyEnvVar !== null,
    pricing,
    billingProviderId: kind === 'openai' ? 'openai' : host,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });
}

/** USD/1M tokens -> nano-USD per token as exact rational (num/den). */
function usdPerMTokToRate(usd: number): { num: bigint; den: bigint } {
  // nano-USD per 1M tokens, rounded up to integer nano-USD (never under-reserve)
  const nanoPerMTok = BigInt(Math.ceil(usd * 1_000_000_000));
  return { num: nanoPerMTok, den: 1_000_000n };
}

/**
 * Registers operator-declared pricing + host usage contract so budget hold/settle works
 * for the configured endpoint. Fails closed if pricing is missing for a host/model without
 * built-in verified pricing.
 */
export function registerProviderBudgetTerms(config: ResolvedLlmProviderConfig, budgetManager: BudgetManager): void {
  if (config.pricing) {
    const i = usdPerMTokToRate(config.pricing.input);
    const o = usdPerMTokToRate(config.pricing.output);
    const c = usdPerMTokToRate(config.pricing.cachedInput ?? config.pricing.input);
    // Settlement looks the rate up under the adapter's providerName while pre-dispatch uses
    // the host for custom endpoints, so the same operator-declared rate is registered under both.
    const providerIds = new Set([config.billingProviderId, config.kind === 'openai' ? 'openai' : config.kind]);
    for (const providerId of providerIds) {
      budgetManager.registerPricingRate({
        providerId,
        modelId: config.model,
        inputRateNum: i.num,
        inputRateDen: i.den,
        outputRateNum: o.num,
        outputRateDen: o.den,
        cachedInputRateNum: c.num,
        cachedInputRateDen: c.den,
      });
    }
  }
  if (config.kind !== 'openai' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(config.host)) {
    registerCustomEndpointContract(config.host, 'openai_chat_completions');
  }
  if (!budgetManager.getPricingRate(config.billingProviderId, config.model)) {
    throw new LlmProviderConfigError(
      `No verified pricing for model '${config.model}' on '${config.billingProviderId}'. ` +
        'Set AIDM_LLM_INPUT_USD_PER_MTOK and AIDM_LLM_OUTPUT_USD_PER_MTOK; budget control cannot be bypassed.',
      'LLM_PRICING_REQUIRED'
    );
  }
}

/** Creates the live HTTP provider (not budget-wrapped; caller wraps with BudgetManager). */
export function createConfiguredLlmProvider(
  config: ResolvedLlmProviderConfig,
  env: Env = process.env,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {}
): LLMProvider {
  const apiKey = config.apiKeyEnvVar ? nonEmpty(env[config.apiKeyEnvVar]) : undefined;
  if (!apiKey) {
    throw new LlmProviderConfigError(
      'No LLM API key configured. Set AIDM_LLM_API_KEY (or OPENAI_API_KEY / XAI_API_KEY).',
      'LLM_API_KEY_MISSING'
    );
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
    endpoint: config.endpoint,
    apiKey,
    defaultTimeoutMs: timeoutMs,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  return new ReferenceLlmAdapter({
    providerId: config.kind === 'openai' ? 'openai' : `llm:${config.kind}`,
    providerName: config.kind === 'openai' ? 'openai' : config.kind,
    defaultModel: config.model,
    supportedModels: [config.model],
    transport,
    timeoutMs,
    endpoint: config.endpoint,
    wireFormat: 'openai',
    // Reasoning-aware wire (shared with the OpenAI DirectorRuntime): reasoning_effort,
    // max_completion_tokens, no temperature unless effort is 'none', strict json_schema.
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  });
}

/** Secret-free description for reports/logs. */
export type LlmPricingSource = 'OPERATOR_ENV' | 'BUILT_IN_VERIFIED' | 'MISSING' | 'NOT_CHECKED';

/**
 * Where the budget rate for the configured model comes from.
 * OPERATOR_ENV: AIDM_LLM_*_USD_PER_MTOK. BUILT_IN_VERIFIED: the budget pricing registry
 * already has a verified rate (e.g. OpenAI gpt-4o). MISSING: no rate; a live run fails closed.
 * NOT_CHECKED: no budget manager consulted yet (e.g. dry-run).
 */
export function resolveLlmPricingSource(
  config: ResolvedLlmProviderConfig,
  budgetManager?: Pick<BudgetManager, 'getPricingRate'> | null
): LlmPricingSource {
  if (config.pricing) return 'OPERATOR_ENV';
  if (!budgetManager) return 'NOT_CHECKED';
  return budgetManager.getPricingRate(config.billingProviderId, config.model) ? 'BUILT_IN_VERIFIED' : 'MISSING';
}

export function describeLlmProviderConfig(
  config: ResolvedLlmProviderConfig,
  budgetManager?: Pick<BudgetManager, 'getPricingRate'> | null
): Record<string, unknown> {
  const pricingSource = resolveLlmPricingSource(config, budgetManager);
  return {
    kind: config.kind,
    endpoint: config.endpoint,
    model: config.model,
    reasoningEffort: config.reasoningEffort ?? null,
    apiKeyEnvVar: config.apiKeyEnvVar,
    hasApiKey: config.hasApiKey,
    /** True when a verified budget rate is available (operator env or built-in registry). */
    pricingConfigured: pricingSource === 'OPERATOR_ENV' || pricingSource === 'BUILT_IN_VERIFIED',
    pricingSource,
  };
}

export interface DirectorOutputSettings {
  readonly responseFormatMode: 'json_schema_strict' | 'json_schema' | 'json_object';
  readonly autoFallbackToJsonObject: boolean;
  readonly maxRepairAttempts: number;
}

/**
 * AIDM_LLM_RESPONSE_FORMAT: auto (default: strict json_schema, falls back to json_object if the
 * provider rejects json_schema) | json_schema (strict, no fallback) | json_schema_loose | json_object.
 * AIDM_LLM_REPAIR_ATTEMPTS: 0..3 (default 1) validation-repair retries per Director reasoning call.
 */
export function resolveDirectorOutputSettings(env: Env = process.env): DirectorOutputSettings {
  const fmt = (nonEmpty(env.AIDM_LLM_RESPONSE_FORMAT) ?? 'auto').toLowerCase();
  const map: Record<string, DirectorOutputSettings['responseFormatMode']> = {
    auto: 'json_schema_strict',
    json_schema: 'json_schema_strict',
    json_schema_strict: 'json_schema_strict',
    json_schema_loose: 'json_schema',
    json_object: 'json_object',
  };
  const mode = map[fmt];
  if (!mode) {
    throw new LlmProviderConfigError(
      `AIDM_LLM_RESPONSE_FORMAT must be one of auto, json_schema, json_schema_loose, json_object (got '${fmt}').`,
      'LLM_CONFIG_INVALID'
    );
  }
  const rawRepair = nonEmpty(env.AIDM_LLM_REPAIR_ATTEMPTS);
  const repair = rawRepair === undefined ? 1 : Number(rawRepair);
  if (!Number.isInteger(repair) || repair < 0 || repair > 3) {
    throw new LlmProviderConfigError('AIDM_LLM_REPAIR_ATTEMPTS must be an integer between 0 and 3.', 'LLM_CONFIG_INVALID');
  }
  return { responseFormatMode: mode, autoFallbackToJsonObject: fmt === 'auto', maxRepairAttempts: repair };
}
