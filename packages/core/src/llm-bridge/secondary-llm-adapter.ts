/**
 * @file secondary-llm-adapter.ts
 * @description Secondary LLM Provider Adapter demonstrating multi-provider decoupling (TASK-P3-03 Requirement 10).
 * 
 * Invariants:
 * 1. Proves the generic LLMProvider contract is not coupled to ReferenceLlmAdapter.
 * 2. Uses a distinct wire format (e.g. top-level system prompt, block content, input/output tokens).
 * 3. Uses injectable LlmTransport with zero hidden network calls.
 * 4. Normalizes to canonical LlmResponse identically and deterministically.
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
import {
  createEstimatedTelemetry,
  normalizeTelemetry,
} from '../token-budget/telemetry.js';
import type { TokenTelemetry } from '../token-budget/budget-types.js';

// ============================================================================
// 1. SECONDARY PROVIDER WIRE FORMAT (DISTINCT FROM REFERENCE FORMAT)
// ============================================================================

export interface SecondaryWireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface SecondaryWireRequest {
  readonly model: string;
  readonly system_prompt: string;
  readonly conversation: readonly SecondaryWireMessage[];
  readonly max_tokens_to_sample: number | null;
  readonly temperature: number | null;
  readonly extra_headers: Readonly<Record<string, string>>;
  readonly correlation_id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SecondaryWireContentBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface SecondaryWireUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cached_creation_input_tokens?: number | null;
}

export interface SecondaryWireResponse {
  readonly id?: string | null;
  readonly model?: string | null;
  readonly content?: readonly SecondaryWireContentBlock[] | null;
  readonly stop_reason?: string | null;
  readonly usage?: SecondaryWireUsage | null;
  readonly correlation_id?: string | null;
}

// ============================================================================
// 2. SECONDARY ADAPTER CONFIGURATION
// ============================================================================

export interface SecondaryLlmAdapterConfig {
  readonly providerId?: string;
  readonly providerName?: string;
  readonly defaultModel?: string;
  readonly supportedModels?: readonly string[];
  readonly supportedCapabilities?: readonly LlmCapability[];
  readonly transport: LlmTransport<SecondaryWireRequest, SecondaryWireResponse>;
  readonly timeoutMs?: number;
}

// ============================================================================
// 3. SECONDARY ADAPTER IMPLEMENTATION
// ============================================================================

export class SecondaryLlmAdapter implements LLMProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly defaultModel: string;
  readonly supportedModels: readonly string[];
  readonly supportedCapabilities: readonly LlmCapability[];

  private readonly transport: LlmTransport<SecondaryWireRequest, SecondaryWireResponse>;
  private readonly defaultTimeoutMs: number;

  constructor(config: SecondaryLlmAdapterConfig) {
    if (!config.transport) {
      throw new Error('SecondaryLlmAdapter requires an injected LlmTransport implementation');
    }

    this.providerId = config.providerId ?? 'llm:secondary-adapter';
    this.providerName = config.providerName ?? 'secondary-llm';
    this.defaultModel = config.defaultModel ?? 'sec-model-v2';
    this.supportedModels = Object.freeze(
      config.supportedModels && config.supportedModels.length > 0
        ? [...config.supportedModels]
        : [this.defaultModel, 'sec-model-v2-turbo']
    );
    this.supportedCapabilities = Object.freeze(
      config.supportedCapabilities && config.supportedCapabilities.length > 0
        ? [...config.supportedCapabilities]
        : [Caps.TEXT_GENERATION, Caps.STRUCTURED_OUTPUT]
    );

    this.transport = config.transport;
    this.defaultTimeoutMs = config.timeoutMs ?? 30000;
  }

  async checkAvailability(): Promise<LlmProviderAvailability> {
    try {
      const isAvail = await this.transport.isAvailable();
      const reasonDetail = (this.transport as { unavailableReason?: string }).unavailableReason;
      return Object.freeze({
        available: isAvail,
        model: this.defaultModel,
        reason: isAvail
          ? null
          : `Transport "${this.transport.transportName}" unavailable${reasonDetail ? `: ${reasonDetail}` : ''}`,
      });
    } catch (err) {
      return Object.freeze({
        available: false,
        model: this.defaultModel,
        reason: `Secondary provider availability probe failed: ${
          err instanceof Error ? sanitizeSecrets(err.message) : 'Unknown error'
        }`,
      });
    }
  }

  /**
   * Translates to distinct secondary wire format:
   * - System messages are concatenated into top-level `system_prompt`
   * - Non-system messages form `conversation`
   * - `max_tokens_to_sample` used instead of `max_tokens`
   */
  translateToWire(request: LlmRequest): SecondaryWireRequest {
    const model = request.model?.trim() || this.defaultModel;

    // Collect system instructions
    const systemParts: string[] = [];
    const conversation: SecondaryWireMessage[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        conversation.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    // Append director context information to system prompt if present
    if (request.director_context.objective) {
      systemParts.push(`Objective: ${request.director_context.objective}`);
    }
    if (request.director_context.acceptance_criteria && request.director_context.acceptance_criteria.length > 0) {
      systemParts.push(`Acceptance Criteria: ${request.director_context.acceptance_criteria.join('; ')}`);
    }

    return Object.freeze({
      model,
      system_prompt: systemParts.join('\n\n'),
      conversation: Object.freeze(conversation),
      max_tokens_to_sample: request.max_tokens ?? null,
      temperature: request.temperature ?? null,
      extra_headers: Object.freeze({
        'x-correlation-id': request.correlation.correlation_id,
      }),
      correlation_id: request.correlation.correlation_id,
      metadata: Object.freeze({
        project_id: request.correlation.project_id,
        task_id: request.correlation.task_id ?? null,
        attempt: request.correlation.attempt ?? null,
        response_format: request.response_format,
        ...(request.metadata ?? {}),
      }),
    });
  }

  async generate<TStructured = unknown>(
    request: LlmRequest
  ): Promise<LlmResponse<TStructured>> {
    const validatedRequest = validateLlmRequest(request);

    // Check availability
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

    const wireRequest = this.translateToWire(validatedRequest);
    const timeoutMs = validatedRequest.timeout_ms ?? this.defaultTimeoutMs;

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
              correlationId: validatedRequest.correlation.correlation_id,
              timeoutMs,
            }
          )
        );
      }, timeoutMs);
    });

    const transportReq: LlmTransportRequest<SecondaryWireRequest> = Object.freeze({
      body: wireRequest,
      timeoutMs,
      signal: abortController.signal,
    });

    let wireResponse: SecondaryWireResponse;
    try {
      const transportRes: LlmTransportResponse<SecondaryWireResponse> =
        await Promise.race([this.transport.send(transportReq), timeoutPromise]);

      if (transportRes.status >= 400) {
        throw new LlmExecutionError(
          `Provider "${this.providerId}" returned HTTP ${transportRes.status}: ${transportRes.statusText || 'Error'}`,
          {
            providerId: this.providerId,
            model: wireRequest.model,
            correlationId: validatedRequest.correlation.correlation_id,
            statusCode: transportRes.status,
            rawError: transportRes.body,
          }
        );
      }

      wireResponse = transportRes.body;
    } catch (err) {
      if (didTimeout || err instanceof LlmTimeoutError) {
        throw err instanceof LlmTimeoutError
          ? err
          : new LlmTimeoutError(
              `Request to LLM provider "${this.providerId}" timed out after ${timeoutMs}ms`,
              {
                providerId: this.providerId,
                model: wireRequest.model,
                correlationId: validatedRequest.correlation.correlation_id,
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
            correlationId: validatedRequest.correlation.correlation_id,
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
            correlationId: validatedRequest.correlation.correlation_id,
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
          correlationId: validatedRequest.correlation.correlation_id,
          rawError: err instanceof Error ? sanitizeSecrets(err.message) : err,
        }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    return this.normalizeWireResponse<TStructured>(wireResponse, validatedRequest);
  }

  normalizeWireResponse<TStructured = unknown>(
    wire: SecondaryWireResponse,
    request: LlmRequest
  ): LlmResponse<TStructured> {
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

    if (!Array.isArray(wire.content) || wire.content.length === 0) {
      throw new MalformedLlmResponseError(
        `Malformed response from provider "${this.providerId}": content blocks array is missing or empty`,
        {
          providerId: this.providerId,
          correlationId: request.correlation.correlation_id,
          rawResponse: wire,
          reason: 'MISSING_CONTENT_BLOCKS',
        }
      );
    }

    const content = wire.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');

    const model = wire.model?.trim() || request.model?.trim() || this.defaultModel;

    let finishReason: LlmFinishReason = LlmFinishReason.STOP;
    if (wire.stop_reason === 'max_tokens') finishReason = LlmFinishReason.LENGTH;
    else if (wire.stop_reason === 'stop_sequence') finishReason = LlmFinishReason.STOP;

    // Token telemetry
    let usage: TokenTelemetry;
    if (wire.usage && typeof wire.usage === 'object') {
      const hasExact =
        typeof wire.usage.input_tokens === 'number' ||
        typeof wire.usage.output_tokens === 'number';

      usage = normalizeTelemetry({
        reported_input_tokens: wire.usage.input_tokens ?? null,
        reported_output_tokens: wire.usage.output_tokens ?? null,
        reported_cached_tokens: wire.usage.cached_creation_input_tokens ?? null,
        estimated_tokens: (wire.usage.input_tokens ?? 0) + (wire.usage.output_tokens ?? 0),
        estimated_cost_usd: null,
        provider_name: this.providerName,
        model,
        is_exact_provider_metric: hasExact,
      });
    } else {
      usage = createEstimatedTelemetry({
        text: content,
        providerName: this.providerName,
        model,
      });
    }

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
      raw_metadata: wire.id ? Object.freeze({ id: wire.id }) : null,
      error: null,
    });
  }
}
