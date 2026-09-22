import type { LlmRequest, LlmResponse } from './llm-types.js';

// ============================================================================
// 1. LLM CAPABILITIES & AVAILABILITY
// ============================================================================

export const LlmCapability = {
  TEXT_GENERATION: 'TEXT_GENERATION',
  STRUCTURED_OUTPUT: 'STRUCTURED_OUTPUT',
  STREAMING: 'STREAMING',
  TOOL_CALLING: 'TOOL_CALLING',
  VISION: 'VISION',
} as const;

export type LlmCapability = (typeof LlmCapability)[keyof typeof LlmCapability];
export const LLM_CAPABILITIES = Object.values(LlmCapability) as readonly LlmCapability[];

export function isLlmCapability(value: unknown): value is LlmCapability {
  return (
    typeof value === 'string' && (LLM_CAPABILITIES as readonly string[]).includes(value)
  );
}

export interface LlmProviderAvailability {
  readonly available: boolean;
  readonly reason?: string | null;
  readonly model?: string | null;
}

// ============================================================================
// 2. LLM PROVIDER CONTRACT (DEC-008 & Architecture Section 1)
// ============================================================================

/**
 * Strongly typed abstraction boundary through which the Director / Orchestrator
 * interacts with external LLM providers.
 * 
 * Invariant (DEC-008):
 * The core orchestration domain depends exclusively on this interface,
 * not directly on OpenAI, Anthropic, or any specific model.
 * 
 * Conceptually:
 * Director / Orchestrator
 *         ↓
 *    LLMProvider
 *         ↓
 *   Provider Adapter
 *         ↓
 * External LLM API / transport
 */
export interface LLMProvider {
  /** Unique identifier of the provider instance */
  readonly providerId: string;

  /** Canonical name of the LLM provider (e.g. 'openai', 'anthropic', 'mock') */
  readonly providerName: string;

  /** Default model identity used when not specified in request */
  readonly defaultModel: string;

  /** List of model identifiers supported by this provider */
  readonly supportedModels: readonly string[];

  /** List of capabilities supported by this provider adapter */
  readonly supportedCapabilities: readonly LlmCapability[];

  /**
   * Probes environment / configuration to verify whether the provider is configured,
   * accessible, and ready to serve requests.
   */
  checkAvailability(): Promise<LlmProviderAvailability>;

  /**
   * Dispatches a strongly typed LLM request through the adapter boundary,
   * producing a normalized LLM response with preserved token telemetry, finish reason,
   * correlation information, and optional structured output validation.
   */
  generate<TStructured = unknown>(
    request: LlmRequest
  ): Promise<LlmResponse<TStructured>>;
}
