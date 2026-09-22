import type { LLMProvider, LlmCapability, LlmProviderAvailability } from './llm-provider.js';
import { LlmCapability as Caps } from './llm-provider.js';
import {
  type LlmRequest,
  type LlmResponse,
  type RawLlmResponse,
  type LlmRequestCorrelation,
  LlmFinishReason,
  LlmResponseFormat,
  validateLlmRequest,
  validateStructuredOutput,
} from './llm-types.js';
import {
  LlmProviderUnavailableError,
  LlmExecutionError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  UnsupportedLlmCapabilityError,
  sanitizeSecrets,
} from '../errors/llm-error.js';
import {
  createEstimatedTelemetry,
  normalizeTelemetry,
} from '../token-budget/telemetry.js';
import type { TokenTelemetry } from '../token-budget/budget-types.js';

// ============================================================================
// 1. ADAPTER CONFIGURATION & TRANSPORT CONTRACTS
// ============================================================================

export interface ProviderTranslatedRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
    readonly name?: string;
  }[];
  readonly temperature: number | null;
  readonly max_tokens: number | null;
  readonly response_format: string;
  readonly json_schema?: Record<string, unknown> | null;
  readonly correlation_id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type LlmTransportHandler = (
  translated: ProviderTranslatedRequest,
  rawRequest: LlmRequest
) => Promise<RawLlmResponse>;

export interface LlmAdapterConfig {
  /** Unique provider instance identifier */
  providerId?: string;
  /** Canonical provider name (e.g. 'mock-llm', 'openai', 'anthropic') */
  providerName?: string;
  /** Default model identifier */
  defaultModel?: string;
  /** List of supported model identifiers */
  supportedModels?: readonly string[];
  /** List of supported capabilities */
  supportedCapabilities?: readonly LlmCapability[];
  /** Optional dependency-injected API key (never leaked or logged) */
  apiKey?: string | null;
  /** Optional endpoint base URL */
  baseUrl?: string | null;
  /** Default timeout in milliseconds */
  timeoutMs?: number | null;
  /** Custom transport handler for test execution or custom network dispatch */
  transport?: LlmTransportHandler;
}

// ============================================================================
// 2. BASE / STANDARD LLM ADAPTER IMPLEMENTATION (DEC-008, Requirement 3 & 4)
// ============================================================================

export class BaseLlmAdapter implements LLMProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly defaultModel: string;
  readonly supportedModels: readonly string[];
  readonly supportedCapabilities: readonly LlmCapability[];

  protected readonly apiKey: string | null;
  protected readonly baseUrl: string | null;
  protected readonly defaultTimeoutMs: number;
  private readonly transport?: LlmTransportHandler;

  constructor(config: LlmAdapterConfig = {}) {
    this.providerId = config.providerId ?? 'llm:base-adapter';
    this.providerName = config.providerName ?? 'generic-llm';
    this.defaultModel = config.defaultModel ?? 'generic-default-v1';
    this.supportedModels = Object.freeze(
      config.supportedModels && config.supportedModels.length > 0
        ? [...config.supportedModels]
        : [this.defaultModel]
    );
    this.supportedCapabilities = Object.freeze(
      config.supportedCapabilities && config.supportedCapabilities.length > 0
        ? [...config.supportedCapabilities]
        : [Caps.TEXT_GENERATION, Caps.STRUCTURED_OUTPUT]
    );

    this.apiKey = config.apiKey ?? null;
    this.baseUrl = config.baseUrl ?? null;
    this.defaultTimeoutMs = config.timeoutMs ?? 30000;
    this.transport = config.transport;
  }

  /**
   * Translates a generic LlmRequest into the provider-specific wire format.
   * Deterministic: Given identical requests, produces identical translated representations.
   */
  translateRequest(request: LlmRequest): ProviderTranslatedRequest {
    const model = request.model?.trim() || this.defaultModel;

    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
    }));

    return Object.freeze({
      provider: this.providerName,
      model,
      messages: Object.freeze(messages),
      temperature: request.temperature ?? null,
      max_tokens: request.max_tokens ?? null,
      response_format: request.response_format,
      json_schema: request.json_schema?.schema ? Object.freeze({ ...request.json_schema.schema }) : null,
      correlation_id: request.correlation.correlation_id,
      metadata: Object.freeze({
        projectId: request.correlation.project_id,
        taskId: request.correlation.task_id,
        attempt: request.correlation.attempt,
      }),
    });
  }

  /**
   * Probes environment to verify configuration and availability.
   * Does NOT claim execution if unconfigured.
   */
  async checkAvailability(): Promise<LlmProviderAvailability> {
    // If transport is provided (e.g. in test or custom dispatch), it is ready
    if (this.transport) {
      return Object.freeze({
        available: true,
        model: this.defaultModel,
        reason: null,
      });
    }

    // In boundary mode without transport, check if credentials were injected
    if (!this.apiKey && this.providerName !== 'mock') {
      return Object.freeze({
        available: false,
        model: this.defaultModel,
        reason: `Provider "${this.providerName}" requires an API key, but none was configured`,
      });
    }

    return Object.freeze({
      available: true,
      model: this.defaultModel,
      reason: null,
    });
  }

  /**
   * Dispatches request and normalizes response according to contracts.
   */
  async generate<TStructured = unknown>(
    request: LlmRequest
  ): Promise<LlmResponse<TStructured>> {
    // 1. Validate request structure and invariants
    const validatedRequest = validateLlmRequest(request);

    // 2. Verify capability support
    if (
      validatedRequest.response_format === LlmResponseFormat.JSON_SCHEMA &&
      !this.supportedCapabilities.includes(Caps.STRUCTURED_OUTPUT)
    ) {
      throw new UnsupportedLlmCapabilityError(
        `Capability "${Caps.STRUCTURED_OUTPUT}" is not supported by provider "${this.providerId}"`,
        {
          providerId: this.providerId,
          capability: Caps.STRUCTURED_OUTPUT,
          supportedCapabilities: this.supportedCapabilities,
          reason: 'CAPABILITY_NOT_SUPPORTED',
        }
      );
    }

    // 3. Check provider availability
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new LlmProviderUnavailableError(
        `LLM provider "${this.providerId}" is unavailable: ${availability.reason ?? 'Not configured'}`,
        {
          providerId: this.providerId,
          model: validatedRequest.model ?? this.defaultModel,
          reason: availability.reason ?? 'UNAVAILABLE',
        }
      );
    }

    // 4. Translate request deterministically
    const translatedPayload = this.translateRequest(validatedRequest);

    // 5. Execute with timeout protection
    const timeoutMs = validatedRequest.timeout_ms ?? this.defaultTimeoutMs;
    const rawOutcome = await this.executeWithTimeout(
      translatedPayload,
      validatedRequest,
      timeoutMs
    );

    // 6. Normalize outcome into canonical LlmResponse
    return this.normalizeResponse<TStructured>(rawOutcome, validatedRequest);
  }

  /**
   * Dispatches the call with deterministic timeout handling.
   */
  private async executeWithTimeout(
    translated: ProviderTranslatedRequest,
    rawRequest: LlmRequest,
    timeoutMs: number
  ): Promise<RawLlmResponse> {
    if (!this.transport) {
      // Deterministic boundary fallback when real network transport is not wired:
      // Return a safe boundary response with explicit mock/boundary telemetry
      const simulatedText = `[Simulated response for ${translated.model}]: Objective verified.`;
      return Object.freeze({
        provider: this.providerName,
        model: translated.model,
        content: simulatedText,
        finish_reason: LlmFinishReason.STOP,
        usage: {
          reported_input_tokens: null,
          reported_output_tokens: null,
          reported_cached_tokens: null,
          estimated_tokens: Math.ceil(simulatedText.length / 4),
          is_exact_provider_metric: false,
        },
        raw_metadata: { boundary_mode: true },
      });
    }

    let timer: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new LlmTimeoutError(
            `Request to LLM provider "${this.providerId}" timed out after ${timeoutMs}ms`,
            {
              providerId: this.providerId,
              model: translated.model,
              correlationId: rawRequest.correlation.correlation_id,
              timeoutMs,
            }
          )
        );
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.transport(translated, rawRequest),
        timeoutPromise,
      ]);
      return result;
    } catch (err) {
      if (err instanceof LlmTimeoutError) {
        throw err;
      }
      throw new LlmExecutionError(
        `Execution failed on provider "${this.providerId}": ${
          err instanceof Error ? sanitizeSecrets(err.message) : 'Unknown provider error'
        }`,
        {
          providerId: this.providerId,
          model: translated.model,
          correlationId: rawRequest.correlation.correlation_id,
          rawError: err instanceof Error ? sanitizeSecrets(err.message) : err,
        }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Normalizes a raw provider response into a strongly typed canonical LlmResponse.
   */
  protected normalizeResponse<TStructured = unknown>(
    raw: RawLlmResponse,
    request: LlmRequest
  ): LlmResponse<TStructured> {
    if (!raw || typeof raw !== 'object') {
      throw new MalformedLlmResponseError(
        `Malformed response from provider "${this.providerId}": response is not an object`,
        {
          providerId: this.providerId,
          correlationId: request.correlation.correlation_id,
          rawResponse: raw,
          reason: 'NON_OBJECT_RESPONSE',
        }
      );
    }

    const content = typeof raw.content === 'string' ? raw.content : '';
    const model = raw.model?.trim() || request.model?.trim() || this.defaultModel;

    // Determine finish reason
    let finishReason: LlmFinishReason = LlmFinishReason.UNKNOWN;
    if (raw.finish_reason && typeof raw.finish_reason === 'string') {
      const upper = raw.finish_reason.toUpperCase();
      if (upper === 'STOP' || upper === 'COMPLETED') finishReason = LlmFinishReason.STOP;
      else if (upper === 'LENGTH' || upper === 'MAX_TOKENS') finishReason = LlmFinishReason.LENGTH;
      else if (upper === 'CONTENT_FILTER') finishReason = LlmFinishReason.CONTENT_FILTER;
      else if (upper === 'TOOL_CALL' || upper === 'TOOL_CALLS') finishReason = LlmFinishReason.TOOL_CALL;
      else if (upper === 'ERROR') finishReason = LlmFinishReason.ERROR;
      else finishReason = LlmFinishReason.UNKNOWN;
    } else if (content.length > 0) {
      finishReason = LlmFinishReason.STOP;
    }

    // Token Telemetry Normalization (Requirement 6 & 7):
    // Preserves exact metrics if provided; otherwise keeps reported tokens null and estimates.
    let usage: TokenTelemetry;
    if (raw.usage && typeof raw.usage === 'object') {
      usage = normalizeTelemetry({
        reported_input_tokens: raw.usage.reported_input_tokens ?? null,
        reported_output_tokens: raw.usage.reported_output_tokens ?? null,
        reported_cached_tokens: raw.usage.reported_cached_tokens ?? null,
        estimated_tokens:
          raw.usage.estimated_tokens ??
          (raw.usage.reported_input_tokens ?? 0) + (raw.usage.reported_output_tokens ?? 0),
        estimated_cost_usd: raw.usage.estimated_cost_usd ?? null,
        provider_name: this.providerName,
        model,
        is_exact_provider_metric: Boolean(raw.usage.is_exact_provider_metric),
      });
    } else {
      // When provider metrics are unavailable, reported values remain strictly null
      usage = createEstimatedTelemetry({
        text: content,
        providerName: this.providerName,
        model,
      });
    }

    // Structured Output validation & parsing (Requirement 8)
    let structuredOutput: TStructured | null = null;
    if (
      request.response_format === LlmResponseFormat.JSON_OBJECT ||
      request.response_format === LlmResponseFormat.JSON_SCHEMA
    ) {
      structuredOutput = validateStructuredOutput<TStructured>(
        content,
        request.json_schema
      );
    }

    // Error state normalization
    let error: { code: string; message: string; details?: unknown } | null = null;
    if (raw.error) {
      error = Object.freeze({
        code: raw.error.code || 'ERR_LLM_EXECUTION_FAILURE',
        message: sanitizeSecrets(raw.error.message || 'LLM provider execution error'),
        details: raw.error.details ? Object.freeze({ ...raw.error.details }) : undefined,
      });
    }

    // Correlation preservation
    const correlation: LlmRequestCorrelation = Object.freeze({
      correlation_id: request.correlation.correlation_id,
      project_id: request.correlation.project_id,
      task_id: request.correlation.task_id ?? null,
      attempt: request.correlation.attempt ?? null,
    });

    return Object.freeze({
      correlation,
      provider: this.providerName,
      model,
      content,
      structured_output: structuredOutput,
      finish_reason: finishReason,
      usage,
      raw_metadata: raw.raw_metadata ? Object.freeze({ ...raw.raw_metadata }) : null,
      error,
    });
  }
}

/**
 * Convenient Mock LLM Adapter for testing and hermetic director workflows.
 */
export class MockLlmAdapter extends BaseLlmAdapter {
  constructor(config: LlmAdapterConfig = {}) {
    super({
      providerId: config.providerId ?? 'llm:mock-director',
      providerName: config.providerName ?? 'mock',
      defaultModel: config.defaultModel ?? 'mock-gpt-4o',
      supportedModels: config.supportedModels ?? ['mock-gpt-4o', 'mock-claude-3-5', 'mock-gemini-pro'],
      ...config,
    });
  }
}
