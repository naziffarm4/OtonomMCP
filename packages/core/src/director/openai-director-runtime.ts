/**
 * @file openai-director-runtime.ts
 * @description Authoritative OpenAI Director Runtime integration and factory.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Configuration follows strict priority: explicit options > AIDM_LLM_* > OPENAI_* > defaults.
 * 2. Secrets sanitization: API keys and bearer tokens are NEVER exposed in logs, serialized
 *    representations, or error messages (redacted via sanitizeSecrets).
 * 3. Fail-closed: In production mode (NODE_ENV=production), absence of valid credentials
 *    or attempt to use mock provider is strictly prohibited and fails closed.
 * 4. Transparent budget enforcement: LLMProvider is wrapped in BudgetAwareLlmAdapter when
 *    BudgetManager is provided, validating SQLite reservations and token spend.
 * 5. Structured output enforcement: Wire format is set to 'openai', translating to OpenAI
 *    Chat Completions payload with clean JSON schema and anti-spoofing guards.
 */

import { HttpLlmTransport } from '../llm-bridge/http-llm-transport.js';
import {
  ReferenceLlmAdapter,
  OPENAI_REASONING_EFFORTS,
  isOpenAiReasoningModel,
  type OpenAiReasoningEffort,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
} from '../llm-bridge/reference-llm-adapter.js';
import { BudgetAwareLlmAdapter } from '../budget/budget-aware-llm-adapter.js';
import type { BudgetManager } from '../budget/budget-manager.js';
import {
  DirectorRuntime,
  type DirectorRuntimeDependencies,
} from './director-runtime.js';
import { DirectorSessionStore } from './director-session-store.js';
import { DirectorSessionEngine } from './director-session-engine.js';
import { HistoryManager } from '../storage/history-manager.js';
import { DirectorPromptBuilder } from './director-prompt-builder.js';
import { DirectorLlmProviderUnavailableError } from './director-runtime-errors.js';
import type { LLMProvider, LlmCapability } from '../llm-bridge/llm-provider.js';
import { LlmCapability as Caps } from '../llm-bridge/llm-provider.js';
import { sanitizeSecrets } from '../errors/llm-error.js';
import type { DirectorContextSynchronizer } from './director-context-synchronizer.js';

// ============================================================================
// 1. CONFIGURATION INTERFACES
// ============================================================================

export interface OpenAiDirectorRuntimeConfig {
  /** API key for OpenAI. Precedence: apiKey > AIDM_LLM_API_KEY > OPENAI_API_KEY */
  readonly apiKey?: string | null;
  /** Full dispatch URL or base URL. Precedence: endpoint > AIDM_LLM_ENDPOINT > OPENAI_BASE_URL > default */
  readonly endpoint?: string;
  /** Model name. Precedence: model > AIDM_LLM_MODEL > OPENAI_MODEL > default ('gpt-6-luna') */
  readonly model?: string;
  /** Reasoning effort. Precedence: reasoningEffort > AIDM_LLM_REASONING_EFFORT > default ('medium' for reasoning models) */
  readonly reasoningEffort?: string;
  /** Timeout in ms (default: 30000) */
  readonly timeoutMs?: number;
  /** Custom fetch function */
  readonly fetchFn?: typeof fetch;
  /** Whether running in production mode (default: process.env.NODE_ENV === 'production') */
  readonly isProduction?: boolean;
  /** Whether to allow mock providers (strictly forbidden in production) */
  readonly allowMockProvider?: boolean;
  /** Optional custom BudgetManager for nano-USD SQLite accounting */
  readonly budgetManager?: BudgetManager;
}

export interface ResolvedOpenAiConfig {
  readonly apiKey: string | null;
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly isProduction: boolean;
  readonly hasValidApiKey: boolean;
  readonly wireFormat: 'openai' | 'reference' | 'auto';
  /** Effective reasoning effort (undefined for non-reasoning models). */
  readonly reasoningEffort?: OpenAiReasoningEffort;
  /** Set when the configured reasoning effort is invalid; the provider then fails closed. */
  readonly configError?: string;
}

// ============================================================================
// 2. CONFIG RESOLUTION
// ============================================================================

export function resolveOpenAiDirectorConfig(
  config: Partial<OpenAiDirectorRuntimeConfig> = {}
): ResolvedOpenAiConfig {
  if (
    !process.env.AIDM_LLM_API_KEY?.trim() &&
    !process.env.OPENAI_API_KEY?.trim() &&
    typeof process.loadEnvFile === 'function'
  ) {
    try {
      process.loadEnvFile();
    } catch {
      // .env missing or unreadable
    }
  }

  const envKey =
    (process.env.AIDM_LLM_API_KEY && process.env.AIDM_LLM_API_KEY.trim().length > 0)
      ? process.env.AIDM_LLM_API_KEY
      : (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0)
        ? process.env.OPENAI_API_KEY
        : null;

  const apiKey = config.apiKey ?? envKey;

  const rawBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const defaultEndpoint = rawBaseUrl
    ? `${rawBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';

  const rawEndpoint = (config.endpoint && config.endpoint.trim().length > 0)
    ? config.endpoint.trim()
    : (process.env.AIDM_LLM_ENDPOINT && process.env.AIDM_LLM_ENDPOINT.trim().length > 0)
      ? process.env.AIDM_LLM_ENDPOINT.trim()
      : defaultEndpoint;

  const endpoint = rawEndpoint;

  const defaultModel = endpoint.includes('openai.com') ? DEFAULT_OPENAI_DIRECTOR_MODEL : 'director-reasoning-v1';
  const rawModel = (config.model && config.model.trim().length > 0)
    ? config.model.trim()
    : (process.env.AIDM_LLM_MODEL && process.env.AIDM_LLM_MODEL.trim().length > 0)
      ? process.env.AIDM_LLM_MODEL.trim()
      : (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim().length > 0)
        ? process.env.OPENAI_MODEL.trim()
        : defaultModel;

  const model = rawModel;

  const timeoutMs = config.timeoutMs ?? 30000;
  const isProduction =
    config.isProduction !== undefined
      ? config.isProduction
      : process.env.NODE_ENV === 'production';

  const hasValidApiKey = Boolean(apiKey && apiKey.trim().length > 0);
  const wireFormat =
    endpoint.includes('openai.com') || (model && model.toLowerCase().startsWith('gpt-'))
      ? 'openai'
      : 'auto';

  const rawEffort = (config.reasoningEffort && config.reasoningEffort.trim().length > 0)
    ? config.reasoningEffort.trim().toLowerCase()
    : (process.env.AIDM_LLM_REASONING_EFFORT && process.env.AIDM_LLM_REASONING_EFFORT.trim().length > 0)
      ? process.env.AIDM_LLM_REASONING_EFFORT.trim().toLowerCase()
      : undefined;
  let reasoningEffort: OpenAiReasoningEffort | undefined;
  let configError: string | undefined;
  if (rawEffort !== undefined && !(OPENAI_REASONING_EFFORTS as readonly string[]).includes(rawEffort)) {
    configError = `Invalid reasoning effort '${rawEffort}' (allowed: ${OPENAI_REASONING_EFFORTS.join(', ')})`;
  } else if (isOpenAiReasoningModel(model)) {
    reasoningEffort = (rawEffort as OpenAiReasoningEffort | undefined) ?? DEFAULT_REASONING_EFFORT;
  }

  return {
    apiKey,
    endpoint,
    model,
    timeoutMs,
    isProduction,
    hasValidApiKey,
    wireFormat,
    reasoningEffort,
    configError,
  };
}

/** Default OpenAI Director model (gpt-6-luna: 1.05M context, 128K output, structured outputs). */
export const DEFAULT_OPENAI_DIRECTOR_MODEL = 'gpt-6-luna';
/** Default reasoning effort for reasoning models when AIDM_LLM_REASONING_EFFORT is not set. */
export const DEFAULT_REASONING_EFFORT: OpenAiReasoningEffort = 'medium';
export const OPENAI_DIRECTOR_SUPPORTED_MODELS: readonly string[] = Object.freeze([
  'gpt-6-luna',
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o3-mini',
]);

// ============================================================================
// 3. UNCONFIGURED PROVIDER FALLBACK
// ============================================================================

export function createUnconfiguredOpenAiProvider(reason: string): LLMProvider {
  return {
    providerId: 'openai:unconfigured',
    providerName: 'openai',
    defaultModel: DEFAULT_OPENAI_DIRECTOR_MODEL,
    supportedModels: OPENAI_DIRECTOR_SUPPORTED_MODELS,
    supportedCapabilities: [Caps.TEXT_GENERATION, Caps.STRUCTURED_OUTPUT],
    async checkAvailability() {
      return { available: false, reason };
    },
    async generate() {
      throw new DirectorLlmProviderUnavailableError(
        `OpenAI provider cannot execute: ${reason} (fail-closed)`
      );
    },
  };
}

// ============================================================================
// 4. PROVIDER FACTORY
// ============================================================================

export function createOpenAiDirectorProvider(
  config: Partial<OpenAiDirectorRuntimeConfig> = {}
): LLMProvider {
  const resolved = resolveOpenAiDirectorConfig(config);

  if (!resolved.hasValidApiKey) {
    if (resolved.isProduction) {
      throw new DirectorLlmProviderUnavailableError(
        'OpenAI API key missing in production mode. Set OPENAI_API_KEY or AIDM_LLM_API_KEY environment variable. Fail-closed strictly enforced.'
      );
    }
    return createUnconfiguredOpenAiProvider(
      'OpenAI API key missing (OPENAI_API_KEY or AIDM_LLM_API_KEY not set).'
    );
  }

  if (resolved.configError) {
    if (resolved.isProduction) {
      throw new DirectorLlmProviderUnavailableError(`${resolved.configError}. Fail-closed strictly enforced.`);
    }
    return createUnconfiguredOpenAiProvider(resolved.configError);
  }

  const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    defaultTimeoutMs: resolved.timeoutMs,
    fetchFn: config.fetchFn,
    budgetManager: config.budgetManager,
    enforceBudget: Boolean(config.budgetManager),
  });

  const adapter = new ReferenceLlmAdapter({
    providerId: 'openai',
    providerName: 'openai',
    defaultModel: resolved.model,
    supportedModels: OPENAI_DIRECTOR_SUPPORTED_MODELS.includes(resolved.model)
      ? OPENAI_DIRECTOR_SUPPORTED_MODELS
      : [resolved.model, ...OPENAI_DIRECTOR_SUPPORTED_MODELS],
    reasoningEffort: resolved.reasoningEffort,
    transport,
    timeoutMs: resolved.timeoutMs,
    endpoint: resolved.endpoint,
    wireFormat: resolved.wireFormat,
    budgetManager: config.budgetManager,
    enforceBudget: Boolean(config.budgetManager),
  });

  if (config.budgetManager) {
    return new BudgetAwareLlmAdapter(adapter, {
      budgetManager: config.budgetManager,
    });
  }

  return adapter;
}

// ============================================================================
// 5. RUNTIME FACTORY
// ============================================================================

export interface CreateOpenAiDirectorRuntimeOptions extends Partial<OpenAiDirectorRuntimeConfig> {
  readonly workspaceRoot?: string;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly historyManager?: HistoryManager;
  readonly contextSynchronizer?: DirectorContextSynchronizer;
  readonly promptBuilder?: DirectorPromptBuilder;
  readonly llmProvider?: LLMProvider | null;
}

export function createOpenAiDirectorRuntime(
  options: CreateOpenAiDirectorRuntimeOptions = {}
): DirectorRuntime {
  let provider = options.llmProvider;

  const resolved = resolveOpenAiDirectorConfig(options);

  if (provider === undefined) {
    if (resolved.hasValidApiKey) {
      provider = createOpenAiDirectorProvider(options);
    } else if (resolved.isProduction) {
      // In production with missing key, pass null so DirectorRuntime fails closed cleanly
      provider = null;
    } else {
      // Non-production with missing key: unconfigured provider
      provider = createUnconfiguredOpenAiProvider(
        'OpenAI API key is missing (set OPENAI_API_KEY or AIDM_LLM_API_KEY).'
      );
    }
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const historyManager =
    options.historyManager ?? new HistoryManager({ baseDir: workspaceRoot });
  const sessionStore =
    options.sessionStore ??
    new DirectorSessionStore({ baseDir: workspaceRoot, historyManager });
  const sessionEngine =
    options.sessionEngine ??
    new DirectorSessionEngine({ store: sessionStore, workspaceRoot });

  return new DirectorRuntime({
    llmProvider: provider,
    sessionStore,
    sessionEngine,
    historyManager,
    contextSynchronizer: options.contextSynchronizer,
    promptBuilder: options.promptBuilder,
    isProduction: resolved.isProduction,
    allowMockProvider: options.allowMockProvider ?? false,
    defaultModel: resolved.model,
  });
}
