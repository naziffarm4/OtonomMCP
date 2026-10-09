/**
 * @file reference-llm-adapter.ts
 * @description Reference LLM Provider Adapter implementation (TASK-P3-03).
 * 
 * Invariants:
 * 1. Implements the generic LLMProvider contract (DEC-008).
 * 2. Isolates provider-specific wire format entirely within this adapter boundary.
 * 3. Uses injectable LlmTransport with zero hidden network calls.
 * 4. Maps all semantic fields without loss: system/user prompts, context,
 *    acceptance criteria, attempts, response formats, model, correlation, project/task IDs.
 * 5. Normalizes wire responses into canonical LlmResponse while preserving exact
 *    reported usage, correlation, and finish reason. Missing metrics remain null.
 * 6. Maps provider/transport failures into the structured LLM error hierarchy.
 * 7. Enforces capability checks and secret sanitization.
 */

import type { LLMProvider, LlmProviderAvailability } from './llm-provider.js';
import { LlmCapability as Caps, type LlmCapability } from './llm-provider.js';
import {
  type LlmRequest,
  type LlmResponse,
  type LlmRequestCorrelation,
  LlmFinishReason,
  LlmResponseFormat,
  validateLlmRequest,
  validateStructuredOutput,
} from './llm-types.js';
import type {
  LlmTransport,
  LlmTransportRequest,
  LlmTransportResponse,
} from './llm-transport.js';
import {
  LlmTransportHttpError,
  LlmTransportUnavailableError,
} from './llm-transport.js';
import {
  LlmProviderUnavailableError,
  LlmExecutionError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  UnsupportedLlmCapabilityError,
  sanitizeSecrets,
} from '../errors/llm-error.js';
import { BudgetError } from '../errors/budget-error.js';
import type { BudgetManager } from '../budget/budget-manager.js';
import {
  createEstimatedTelemetry,
  normalizeTelemetry,
} from '../token-budget/telemetry.js';
import type { TokenTelemetry } from '../token-budget/budget-types.js';

// ============================================================================
// 1. PROVIDER-SPECIFIC WIRE FORMAT (ISOLATED INSIDE ADAPTER)
// ============================================================================

export interface ReferenceWireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
}

export interface ReferenceWireContextData {
  readonly project_id: string;
  readonly task_id: string | null;
  readonly objective: string | null;
  readonly acceptance_criteria: readonly string[];
  readonly attempt: number | null;
  readonly max_attempts: number | null;
  readonly relevant_context: Readonly<Record<string, unknown>> | null;
}

export interface ReferenceWireResponseFormat {
  readonly type: 'text' | 'json_object' | 'json_schema';
  readonly schema?: Record<string, unknown> | null;
  readonly schema_name?: string | null;
  readonly strict?: boolean | null;
}

export interface ReferenceWireRequest {
  readonly model: string;
  readonly messages: readonly ReferenceWireMessage[];
  readonly temperature: number | null;
  readonly max_tokens: number | null;
  readonly response_format: ReferenceWireResponseFormat;
  readonly correlation_id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly director_context: ReferenceWireContextData;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ReferenceWireChoice {
  readonly index: number;
  readonly message: {
    readonly role: string;
    readonly content: string;
  };
  readonly finish_reason: string;
}

export interface ReferenceWireUsage {
  readonly prompt_tokens?: number | null;
  readonly completion_tokens?: number | null;
  readonly cached_tokens?: number | null;
  readonly total_tokens?: number | null;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number | null;
    readonly audio_tokens?: number | null;
  } | null;
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number | null;
    readonly audio_tokens?: number | null;
    readonly accepted_prediction_tokens?: number | null;
    readonly rejected_prediction_tokens?: number | null;
  } | null;
}

export interface ReferenceWireResponse {
  readonly id?: string | null;
  readonly object?: string | null;
  readonly created?: number | null;
  readonly model?: string | null;
  readonly choices?: readonly ReferenceWireChoice[] | null;
  readonly usage?: ReferenceWireUsage | null;
  readonly system_fingerprint?: string | null;
  readonly correlation_id?: string | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly error?: {
    readonly code?: string | null;
    readonly message?: string | null;
    readonly details?: unknown;
  } | null;
}

// ============================================================================
// 2. REFERENCE ADAPTER CONFIGURATION
// ============================================================================

export interface ReferenceLlmAdapterConfig {
  /** Unique provider instance identifier (defaults to 'llm:reference-adapter') */
  readonly providerId?: string;
  /** Canonical provider name (defaults to 'reference-llm') */
  readonly providerName?: string;
  /** Default model identifier */
  readonly defaultModel?: string;
  /** List of model identifiers supported by this adapter */
  readonly supportedModels?: readonly string[];
  /** Supported capabilities */
  readonly supportedCapabilities?: readonly LlmCapability[];
  /** Injected transport implementation (mandatory for real execution) */
  readonly transport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse>;
  /** Default timeout in milliseconds */
  readonly timeoutMs?: number;
  /** Optional endpoint URL */
  readonly endpoint?: string;
  /** Whether to enforce budget authorization on direct generate calls (P18-03) */
  readonly enforceBudget?: boolean;
  /** Optional authoritative BudgetManager to verify reservations in SQLite (P18-03) */
  readonly budgetManager?: BudgetManager;
  /**
   * Wire format mode:
   * - 'openai': Standard OpenAI Chat Completions payload format (clean JSON body, nested json_schema)
   * - 'reference': Internal AIDM reference format (includes top-level director_context and metadata)
   * - 'auto': Uses 'openai' when endpoint includes 'openai.com' or provider is 'openai', otherwise 'reference'. Defaults to 'auto'.
   */
  readonly wireFormat?: 'reference' | 'openai' | 'auto';
}

// ============================================================================
// 3. REFERENCE LLM ADAPTER IMPLEMENTATION
// ============================================================================

export class ReferenceLlmAdapter implements LLMProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly defaultModel: string;
  readonly supportedModels: readonly string[];
  readonly supportedCapabilities: readonly LlmCapability[];
  readonly enforceBudget: boolean;
  readonly wireFormat: 'reference' | 'openai' | 'auto';
  budgetManager?: BudgetManager;

  readonly transport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse>;
  private readonly defaultTimeoutMs: number;
  private readonly endpoint?: string;

  constructor(config: ReferenceLlmAdapterConfig) {
    if (!config.transport) {
      throw new Error('ReferenceLlmAdapter requires an injected LlmTransport implementation');
    }

    this.providerId = config.providerId ?? 'llm:reference-adapter';
    this.providerName = config.providerName ?? 'reference-llm';
    this.defaultModel = config.defaultModel ?? 'ref-model-v1';
    this.enforceBudget = config.enforceBudget ?? false;
    this.budgetManager = config.budgetManager;
    this.supportedModels = Object.freeze(
      config.supportedModels && config.supportedModels.length > 0
        ? [...config.supportedModels]
        : [this.defaultModel, 'ref-model-v1-fast', 'ref-model-v1-heavy']
    );
    this.supportedCapabilities = Object.freeze(
      config.supportedCapabilities && config.supportedCapabilities.length > 0
        ? [...config.supportedCapabilities]
        : [
            Caps.TEXT_GENERATION,
            Caps.STRUCTURED_OUTPUT,
            Caps.STREAMING,
          ]
    );

    this.transport = config.transport;
    this.defaultTimeoutMs = config.timeoutMs ?? 30000;
    this.endpoint = config.endpoint;
    this.wireFormat = config.wireFormat ?? 'auto';

    if (this.budgetManager && this.transport && typeof (this.transport as any).setBudgetManager === 'function') {
      (this.transport as any).setBudgetManager(this.budgetManager);
    }
  }

  /**
   * Evaluates whether OpenAI Chat Completions wire format should be used.
   */
  isOpenAiFormat(): boolean {
    if (this.wireFormat === 'openai') return true;
    if (this.wireFormat === 'reference') return false;
    const endpoint = this.endpoint || (this.transport as any)?.endpoint || '';
    if (typeof endpoint === 'string' && endpoint.includes('openai.com')) {
      return true;
    }
    if (this.providerName.toLowerCase().includes('openai')) {
      return true;
    }
    return false;
  }

  /**
   * Formats wire request for standard OpenAI Chat Completions API.
   * Strips out internal orchestrator metadata from JSON body to prevent HTTP 400 Bad Request.
   */
  translateToOpenAiWire(wire: ReferenceWireRequest): Record<string, unknown> {
    const isReasoningModel = /^(o[0-9]|gpt-5|gpt-6)/i.test(wire.model);
    const body: Record<string, unknown> = {
      model: wire.model,
      messages: wire.messages,
    };
    if (!isReasoningModel && typeof wire.temperature === 'number' && Number.isFinite(wire.temperature)) {
      body.temperature = wire.temperature;
    }
    if (typeof wire.max_tokens === 'number' && Number.isFinite(wire.max_tokens)) {
      if (isReasoningModel) {
        body.max_completion_tokens = wire.max_tokens;
      } else {
        body.max_tokens = wire.max_tokens;
      }
    }
    if (wire.response_format) {
      if (wire.response_format.type === 'json_schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: wire.response_format.schema_name || 'director_decision',
            strict: isReasoningModel ? false : (wire.response_format.strict ?? true),
            schema: wire.response_format.schema ?? {},
          },
        };
      } else if (wire.response_format.type === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
    }
    return Object.freeze(body);
  }

  setBudgetManager(budgetManager: BudgetManager): void {
    this.budgetManager = budgetManager;
    if (this.transport && typeof (this.transport as any).setBudgetManager === 'function') {
      (this.transport as any).setBudgetManager(budgetManager);
    }
  }

  /**
   * Probes environment / transport availability.
   */
  async checkAvailability(): Promise<LlmProviderAvailability> {
    try {
      const isTransportAvail = await this.transport.isAvailable();
      if (!isTransportAvail) {
        const reasonDetail = (this.transport as { unavailableReason?: string }).unavailableReason;
        return Object.freeze({
          available: false,
          model: this.defaultModel,
          reason: `Transport "${this.transport.transportName}" reported unavailable${
            reasonDetail ? `: ${reasonDetail}` : ''
          }`,
        });
      }

      return Object.freeze({
        available: true,
        model: this.defaultModel,
        reason: null,
      });
    } catch (err) {
      return Object.freeze({
        available: false,
        model: this.defaultModel,
        reason: `Availability probe failed: ${err instanceof Error ? sanitizeSecrets(err.message) : 'Unknown error'}`,
      });
    }
  }

  /**
   * Translates a generic LlmRequest into the reference provider's wire format.
   * Deterministic: Identical requests produce identical deep-equal representations.
   */
  translateToWire(request: LlmRequest): ReferenceWireRequest {
    const model = request.model?.trim() || this.defaultModel;

    // 1. Map messages preserving order and role
    const wireMessages: ReferenceWireMessage[] = request.messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    }));

    // 2. Map director context fields
    const dirCtx = request.director_context;
    const wireContextData: ReferenceWireContextData = Object.freeze({
      project_id: dirCtx.project_id,
      task_id: dirCtx.task_id ?? null,
      objective: dirCtx.objective ?? null,
      acceptance_criteria: dirCtx.acceptance_criteria
        ? Object.freeze([...dirCtx.acceptance_criteria])
        : Object.freeze([]),
      attempt: dirCtx.attempt ?? null,
      max_attempts: dirCtx.max_attempts ?? null,
      relevant_context: dirCtx.relevant_context
        ? Object.freeze({ ...dirCtx.relevant_context })
        : null,
    });

    // 3. Map response format
    let responseFormat: ReferenceWireResponseFormat;
    if (request.response_format === LlmResponseFormat.JSON_SCHEMA) {
      responseFormat = Object.freeze({
        type: 'json_schema',
        schema: request.json_schema?.schema ? Object.freeze({ ...request.json_schema.schema }) : null,
        schema_name: request.json_schema?.name ?? null,
        strict: request.json_schema?.strict ?? true,
      });
    } else if (request.response_format === LlmResponseFormat.JSON_OBJECT) {
      responseFormat = Object.freeze({
        type: 'json_object',
      });
    } else {
      responseFormat = Object.freeze({
        type: 'text',
      });
    }

    // 4. Assemble complete wire request
    return Object.freeze({
      model,
      messages: Object.freeze(wireMessages),
      temperature: request.temperature ?? null,
      max_tokens: request.max_tokens ?? null,
      response_format: responseFormat,
      correlation_id: request.correlation.correlation_id,
      project_id: request.correlation.project_id,
      task_id: request.correlation.task_id ?? null,
      attempt: request.correlation.attempt ?? null,
      director_context: wireContextData,
      metadata: Object.freeze({
        ...(request.metadata ?? {}),
        aidm_correlation_id: request.correlation.correlation_id,
        aidm_project_id: request.correlation.project_id,
        aidm_task_id: request.correlation.task_id ?? null,
        aidm_attempt: request.correlation.attempt ?? null,
      }),
    });
  }

  /**
   * Dispatches request through the adapter boundary and normalizes the response.
   */
  async generate<TStructured = unknown>(
    request: LlmRequest
  ): Promise<LlmResponse<TStructured>> {
    // 0. Budget Enforcement Check (P18-03)
    if (this.enforceBudget) {
      const isBudgetAuthorized = Boolean(request.metadata?.__aidm_budget_authorized);
      const reservationId = request.metadata?.__aidm_reservation_id
        ? String(request.metadata.__aidm_reservation_id)
        : undefined;

      if (!isBudgetAuthorized || !reservationId) {
        throw new BudgetError(
          `Direct call to provider "${this.providerId}" without valid budget reservation is strictly prohibited. Wrap provider with BudgetAwareLlmAdapter.`,
          'ERR_BUDGET_REQUIRED',
          { providerId: this.providerId, reason: 'DIRECT_CALL_PROHIBITED' }
        );
      }

      if (this.budgetManager) {
        const expectedModel = request.model?.trim() || this.defaultModel;
        const expectedProjectId = request.correlation?.project_id;
        const dispatchClaimId = request.metadata?.__aidm_dispatch_claim_id
          ? String(request.metadata.__aidm_dispatch_claim_id)
          : undefined;

        this.budgetManager.verifyReservation({
          reservationId,
          dispatchClaimId,
          expectedModelId: expectedModel,
          expectedProjectId,
        });
      }
    }

    // 1. Validate request structure and invariants
    const validatedRequest = validateLlmRequest(request);

    // 2. Check capability support
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

    // 3. Verify availability
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new LlmProviderUnavailableError(
        `LLM provider "${this.providerId}" is unavailable: ${availability.reason ?? 'Transport unavailable'}`,
        {
          providerId: this.providerId,
          model: validatedRequest.model ?? this.defaultModel,
          reason: availability.reason ?? 'UNAVAILABLE',
        }
      );
    }

    // 4. Translate to wire format
    const wireRequest = this.translateToWire(validatedRequest);

    // 5. Execute wire call with timeout & abort protection
    const timeoutMs = validatedRequest.timeout_ms ?? this.defaultTimeoutMs;
    const wireResponse = await this.dispatchWireCall(wireRequest, validatedRequest, timeoutMs);

    // 6. Normalize wire response into canonical LlmResponse
    return this.normalizeWireResponse<TStructured>(wireResponse, validatedRequest);
  }

  /**
   * Dispatches the wire call to the injected transport with timeout and error handling.
   */
  private async dispatchWireCall(
    wireRequest: ReferenceWireRequest,
    rawRequest: LlmRequest,
    timeoutMs: number
  ): Promise<ReferenceWireResponse> {
    const abortController = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let didTimeout = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        didTimeout = true;
        abortController.abort();
        reject(
          new LlmTimeoutError(
            `Request to LLM provider "${this.providerId}" timed out after ${timeoutMs}ms`,
            {
              providerId: this.providerId,
              model: wireRequest.model,
              correlationId: rawRequest.correlation.correlation_id,
              timeoutMs,
            }
          )
        );
      }, timeoutMs);
    });

    const effectiveBody = this.isOpenAiFormat()
      ? (this.translateToOpenAiWire(wireRequest) as unknown as ReferenceWireRequest)
      : wireRequest;

    const transportReq: LlmTransportRequest<ReferenceWireRequest> = Object.freeze({
      endpoint: this.endpoint,
      method: 'POST',
      headers: Object.freeze({
        'content-type': 'application/json',
        'x-correlation-id': rawRequest.correlation.correlation_id,
        'x-project-id': rawRequest.correlation.project_id,
        'x-budget-provider-id': this.providerId,
        'x-budget-model-id': wireRequest.model,
        ...(rawRequest.metadata?.__aidm_account_id
          ? { 'x-budget-account-id': String(rawRequest.metadata.__aidm_account_id) }
          : {}),
        ...(rawRequest.metadata?.__aidm_reservation_id
          ? { 'x-budget-reservation-id': String(rawRequest.metadata.__aidm_reservation_id) }
          : {}),
      }),
      body: effectiveBody,
      timeoutMs,
      signal: abortController.signal,
    });

    try {
      const transportRes: LlmTransportResponse<ReferenceWireResponse> =
        await Promise.race([this.transport.send(transportReq), timeoutPromise]);

      if (transportRes.status >= 400) {
        throw new LlmExecutionError(
          `Provider "${this.providerId}" returned HTTP ${transportRes.status}: ${
            transportRes.statusText || 'Error'
          }`,
          {
            providerId: this.providerId,
            model: wireRequest.model,
            correlationId: rawRequest.correlation.correlation_id,
            statusCode: transportRes.status,
            rawError: transportRes.body,
          }
        );
      }

      return transportRes.body;
    } catch (err) {
      if (didTimeout || err instanceof LlmTimeoutError) {
        throw err instanceof LlmTimeoutError
          ? err
          : new LlmTimeoutError(
              `Request to LLM provider "${this.providerId}" timed out after ${timeoutMs}ms`,
              {
                providerId: this.providerId,
                model: wireRequest.model,
                correlationId: rawRequest.correlation.correlation_id,
                timeoutMs,
              }
            );
      }

      if (err instanceof Error && err.name === 'AbortError') {
        throw new LlmTimeoutError(
          `Request to LLM provider "${this.providerId}" timed out after ${timeoutMs}ms`,
          {
            providerId: this.providerId,
            model: wireRequest.model,
            correlationId: rawRequest.correlation.correlation_id,
            timeoutMs,
          }
        );
      }

      if (err instanceof LlmTransportUnavailableError) {
        throw new LlmProviderUnavailableError(
          `LLM provider "${this.providerId}" is unavailable: ${err.message}`,
          {
            providerId: this.providerId,
            model: wireRequest.model,
            reason: err.reason ?? 'TRANSPORT_UNAVAILABLE',
          }
        );
      }

      if (err instanceof LlmTransportHttpError) {
        let detailMsg = err.message;
        if (err.responseBody && typeof err.responseBody === 'object') {
          const bodyObj = err.responseBody as Record<string, unknown>;
          if (typeof bodyObj.error === 'object' && bodyObj.error && 'message' in bodyObj.error) {
            detailMsg = `${err.message} - ${String((bodyObj.error as Record<string, unknown>).message)}`;
          } else if (typeof bodyObj.message === 'string') {
            detailMsg = `${err.message} - ${bodyObj.message}`;
          }
        }
        throw new LlmExecutionError(
          `Provider "${this.providerId}" HTTP failure (${err.status}): ${sanitizeSecrets(detailMsg)}`,
          {
            providerId: this.providerId,
            model: wireRequest.model,
            correlationId: rawRequest.correlation.correlation_id,
            statusCode: err.status,
            rawError: err.responseBody,
          }
        );
      }

      if (err instanceof LlmExecutionError || err instanceof MalformedLlmResponseError) {
        throw err;
      }

      throw new LlmExecutionError(
        `Execution failed on provider "${this.providerId}": ${
          err instanceof Error ? sanitizeSecrets(err.message) : 'Unknown provider error'
        }`,
        {
          providerId: this.providerId,
          model: wireRequest.model,
          correlationId: rawRequest.correlation.correlation_id,
          rawError: err instanceof Error ? sanitizeSecrets(err.message) : err,
        }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Normalizes a reference provider wire response into the canonical LlmResponse.
   */
  normalizeWireResponse<TStructured = unknown>(
    wire: ReferenceWireResponse,
    request: LlmRequest
  ): LlmResponse<TStructured> {
    // 1. Validate wire response is an object
    if (!wire || typeof wire !== 'object') {
      throw new MalformedLlmResponseError(
        `Malformed response from provider "${this.providerId}": response is not an object`,
        {
          providerId: this.providerId,
          correlationId: request.correlation.correlation_id,
          rawResponse: wire,
          reason: 'NON_OBJECT_RESPONSE',
        }
      );
    }

    // 2. Validate choices array presence and non-emptiness
    if (!Array.isArray(wire.choices) || wire.choices.length === 0) {
      throw new MalformedLlmResponseError(
        `Malformed response from provider "${this.providerId}": missing or empty choices array`,
        {
          providerId: this.providerId,
          correlationId: request.correlation.correlation_id,
          rawResponse: wire,
          reason: 'MISSING_OR_EMPTY_CHOICES',
        }
      );
    }

    const firstChoice = wire.choices[0];
    if (!firstChoice || typeof firstChoice !== 'object' || !firstChoice.message) {
      throw new MalformedLlmResponseError(
        `Malformed response from provider "${this.providerId}": choices[0] is missing message object`,
        {
          providerId: this.providerId,
          correlationId: request.correlation.correlation_id,
          rawResponse: wire,
          reason: 'INVALID_CHOICE_STRUCTURE',
        }
      );
    }

    const content = typeof firstChoice.message.content === 'string' ? firstChoice.message.content : '';
    const model = wire.model?.trim() || request.model?.trim() || this.defaultModel;

    // 3. Map finish reason
    let finishReason: LlmFinishReason = LlmFinishReason.UNKNOWN;
    if (firstChoice.finish_reason && typeof firstChoice.finish_reason === 'string') {
      const lower = firstChoice.finish_reason.toLowerCase();
      if (lower === 'stop' || lower === 'completed') finishReason = LlmFinishReason.STOP;
      else if (lower === 'length' || lower === 'max_tokens') finishReason = LlmFinishReason.LENGTH;
      else if (lower === 'content_filter') finishReason = LlmFinishReason.CONTENT_FILTER;
      else if (lower === 'tool_calls' || lower === 'tool_call') finishReason = LlmFinishReason.TOOL_CALL;
      else if (lower === 'error') finishReason = LlmFinishReason.ERROR;
      else finishReason = LlmFinishReason.UNKNOWN;
    } else if (content.length > 0) {
      finishReason = LlmFinishReason.STOP;
    }

    // 4. Token telemetry normalization (DEC-008 & Phase 2 invariants):
    // If usage is explicitly reported by wire response, preserve exact values.
    // If usage is omitted, reported values MUST remain strictly null (zero fabrication).
    let usage: TokenTelemetry;
    if (wire.usage && typeof wire.usage === 'object') {
      const hasExactMetrics =
        typeof wire.usage.prompt_tokens === 'number' ||
        typeof wire.usage.completion_tokens === 'number';

      const cachedTokens =
        wire.usage.cached_tokens ??
        wire.usage.prompt_tokens_details?.cached_tokens ??
        (wire.usage as any).input_tokens_details?.cached_tokens ??
        null;

      const cacheWriteTokens =
        (wire.usage as any).cache_write_tokens ??
        (wire.usage.prompt_tokens_details as any)?.cache_write_tokens ??
        (wire.usage as any).input_tokens_details?.cache_write_tokens ??
        null;

      const reasoningTokens =
        (wire.usage as any).reasoning_tokens ??
        (wire.usage.completion_tokens_details as any)?.reasoning_tokens ??
        (wire.usage as any).output_tokens_details?.reasoning_tokens ??
        null;

      usage = normalizeTelemetry({
        reported_input_tokens: wire.usage.prompt_tokens ?? (wire.usage as any).input_tokens ?? null,
        reported_output_tokens: wire.usage.completion_tokens ?? (wire.usage as any).output_tokens ?? null,
        reported_cached_tokens: cachedTokens,
        reported_cache_write_tokens: cacheWriteTokens,
        reported_reasoning_tokens: reasoningTokens,
        estimated_tokens:
          wire.usage.total_tokens ??
          ((wire.usage.prompt_tokens ?? 0) + (wire.usage.completion_tokens ?? 0)),
        estimated_cost_usd: null, // Never invent pricing without explicit cost model
        provider_name: this.providerName,
        model,
        is_exact_provider_metric: hasExactMetrics,
      });

      if (wire.usage.completion_tokens_details) {
        (usage as any).completion_tokens_details = wire.usage.completion_tokens_details;
      }
      if (wire.usage.prompt_tokens_details) {
        (usage as any).prompt_tokens_details = wire.usage.prompt_tokens_details;
      }
      if ((wire.usage as any).input_tokens_details) {
        (usage as any).input_tokens_details = (wire.usage as any).input_tokens_details;
      }
      if ((wire.usage as any).output_tokens_details) {
        (usage as any).output_tokens_details = (wire.usage as any).output_tokens_details;
      }
    } else {
      // When provider metrics are unavailable, reported values remain strictly null
      usage = createEstimatedTelemetry({
        text: content,
        providerName: this.providerName,
        model,
      });
    }

    // 5. Structured output parsing & validation
    let structuredOutput: TStructured | null = null;
    try {
      if (
        request.response_format === LlmResponseFormat.JSON_OBJECT ||
        request.response_format === LlmResponseFormat.JSON_SCHEMA
      ) {
        structuredOutput = validateStructuredOutput<TStructured>(
          content,
          request.json_schema
        );
      }
    } catch (err) {
      if (err instanceof MalformedLlmResponseError) {
        (err as any).usage = usage;
        if ((err as any).details && typeof (err as any).details === 'object') {
          (err as any).details.usage = usage;
        }
      }
      throw err;
    }

    // 6. Error state normalization
    let error: { code: string; message: string; details?: unknown } | null = null;
    if (wire.error) {
      error = Object.freeze({
        code: wire.error.code || 'ERR_LLM_PROVIDER_ERROR',
        message: sanitizeSecrets(wire.error.message || 'LLM provider reported an error'),
        details: wire.error.details ? Object.freeze({ ...wire.error.details }) : undefined,
      });
    }

    // 7. Strictly preserve correlation
    const correlation: LlmRequestCorrelation = Object.freeze({
      correlation_id: request.correlation.correlation_id,
      project_id: request.correlation.project_id,
      task_id: request.correlation.task_id ?? null,
      attempt: request.correlation.attempt ?? null,
    });

    // 8. Raw provider metadata preservation (without leaking secrets)
    const rawMetadata: Record<string, unknown> = {};
    if (wire.id) rawMetadata.id = wire.id;
    if (wire.object) rawMetadata.object = wire.object;
    if (wire.created) rawMetadata.created = wire.created;
    if (wire.system_fingerprint) rawMetadata.system_fingerprint = wire.system_fingerprint;
    if (wire.metadata) {
      Object.assign(rawMetadata, wire.metadata);
    }

    return Object.freeze({
      correlation,
      provider: this.providerName,
      model,
      content,
      structured_output: structuredOutput,
      finish_reason: finishReason,
      usage,
      raw_metadata: Object.keys(rawMetadata).length > 0 ? Object.freeze(rawMetadata) : null,
      error,
    });
  }
}
