import type { LLMProvider, LlmProviderAvailability, LlmCapability } from '../llm-bridge/llm-provider.js';
import type { LlmRequest, LlmResponse } from '../llm-bridge/llm-types.js';
import { LlmTimeoutError } from '../errors/llm-error.js';
import { BudgetError } from '../errors/budget-error.js';
import type { BudgetManager } from './budget-manager.js';
import type { TokenUsage } from './budget-types.js';

export interface BudgetAwareLlmAdapterOptions {
  budgetManager: BudgetManager;
  defaultEstimatedPromptTokens?: number;
  defaultEstimatedCompletionTokens?: number;
}

/**
 * Budget-Enforcing Decorator for any LLMProvider.
 * 
 * Enforces the authoritative execution chain:
 * DirectorReasoningEngine / Caller
 *   → BudgetAwareLlmAdapter
 *     → Pre-dispatch budget validation
 *     → Atomic reservation (PREPARED)
 *     → DISPATCHED persistence
 *     → Inner HTTP provider request
 *     → Usage extraction
 *     → Reconciliation (SETTLED / UNKNOWN / RELEASED)
 */
export class BudgetAwareLlmAdapter implements LLMProvider {
  readonly inner: LLMProvider;
  readonly budgetManager: BudgetManager;
  private readonly defaultEstimatedPromptTokens: number;
  private readonly defaultEstimatedCompletionTokens: number;

  constructor(inner: LLMProvider, options: BudgetAwareLlmAdapterOptions | BudgetManager) {
    this.inner = inner;
    if ('budgetManager' in options) {
      this.budgetManager = options.budgetManager;
      this.defaultEstimatedPromptTokens = options.defaultEstimatedPromptTokens ?? 1000;
      this.defaultEstimatedCompletionTokens = options.defaultEstimatedCompletionTokens ?? 1000;
    } else {
      this.budgetManager = options;
      this.defaultEstimatedPromptTokens = 1000;
      this.defaultEstimatedCompletionTokens = 1000;
    }

    if (this.inner && 'setBudgetManager' in this.inner && typeof (this.inner as any).setBudgetManager === 'function') {
      (this.inner as any).setBudgetManager(this.budgetManager);
    }
  }

  get providerId(): string {
    return this.inner.providerId;
  }

  get providerName(): string {
    return this.inner.providerName;
  }

  get defaultModel(): string {
    return this.inner.defaultModel;
  }

  get supportedModels(): readonly string[] {
    return this.inner.supportedModels;
  }

  get supportedCapabilities(): readonly LlmCapability[] {
    return this.inner.supportedCapabilities;
  }

  get transport(): unknown {
    return (this.inner as unknown as { transport?: unknown }).transport;
  }

  async checkAvailability(): Promise<LlmProviderAvailability> {
    return this.inner.checkAvailability();
  }

  /**
   * Estimates token usage from request messages.
   */
  private estimateTokens(request: LlmRequest): TokenUsage {
    let charCount = 0;
    if (Array.isArray(request.messages)) {
      for (const msg of request.messages) {
        if (typeof msg.content === 'string') {
          charCount += msg.content.length;
        }
      }
    }

    const estimatedInput = charCount > 0
      ? Math.max(100, Math.ceil(charCount / 4))
      : this.defaultEstimatedPromptTokens;

    const estimatedOutput = request.max_tokens && request.max_tokens > 0
      ? request.max_tokens
      : this.defaultEstimatedCompletionTokens;

    return {
      inputTokens: estimatedInput,
      outputTokens: estimatedOutput,
    };
  }

  async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
    const correlationId = request.correlation?.correlation_id ?? `corr_${Date.now()}`;
    const attempt = request.correlation?.attempt ?? 1;
    const model = request.model?.trim() || this.defaultModel;
    const providerId = this.providerName;
    const estimatedTokens = this.estimateTokens(request);
    const reservationKey = `idemp_res_${correlationId}_att_${attempt}`;
    const settlementKey = `idemp_set_${correlationId}_att_${attempt}`;

    // 1. Pre-dispatch Budget Validation (fails closed if budget insufficient or pricing missing)
    this.budgetManager.preDispatchValidate({
      sessionId: correlationId,
      taskId: request.correlation?.task_id ?? null,
      providerId,
      modelId: model,
      estimatedTokens,
      idempotencyKey: reservationKey,
    }, true);

    // 2. Atomic Budget Reservation in PREPARED state
    const reservation = this.budgetManager.reserve({
      sessionId: correlationId,
      taskId: request.correlation?.task_id ?? null,
      providerId,
      modelId: model,
      estimatedTokens,
      idempotencyKey: reservationKey,
    });

    // 3. Mark Reservation DISPATCHED before issuing the HTTP call
    this.budgetManager.markDispatched(reservation.reservationId);

    const dispatchClaimId = `claim_${reservation.reservationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 4. Dispatch the actual HTTP provider request with budget authorization metadata
    const authorizedRequest: LlmRequest = {
      ...request,
      metadata: {
        ...(request.metadata ?? {}),
        __aidm_budget_authorized: true,
        __aidm_reservation_id: reservation.reservationId,
        __aidm_dispatch_claim_id: dispatchClaimId,
      },
    };

    let response: LlmResponse<TStructured>;
    try {
      response = await this.inner.generate<TStructured>(authorizedRequest);
    } catch (err: unknown) {
      // 5a. Failure Handling:
      // If error is timeout or unknown network failure after dispatch: mark UNKNOWN (retaining hold)
      const isTimeout = err instanceof LlmTimeoutError ||
        (err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('timeout')));

      if (isTimeout) {
        this.budgetManager.recordUnknown({
          reservationId: reservation.reservationId,
          errorReason: (err as Error).message ?? 'Provider request timed out',
        });
      } else {
        // Unknown connection break / network drop after dispatch
        this.budgetManager.recordUnknown({
          reservationId: reservation.reservationId,
          errorReason: (err as Error).message ?? 'Provider dispatch failed with undetermined outcome',
        });
      }

      throw err;
    }

    // 5b. Usage Extraction & Reconciliation
    const usage = response?.usage as any;
    const hasReportedMetrics =
      usage &&
      (typeof usage.reported_input_tokens === 'number' ||
        typeof usage.reported_output_tokens === 'number' ||
        typeof usage.prompt_tokens === 'number' ||
        typeof usage.input_tokens === 'number' ||
        typeof usage.completion_tokens === 'number' ||
        typeof usage.output_tokens === 'number');

    if (!hasReportedMetrics) {
      // Never record zero cost on missing usage; hold reservation as UNKNOWN
      this.budgetManager.recordUnknown({
        reservationId: reservation.reservationId,
        errorReason: 'Provider response omitted usage metrics; holding reservation in UNKNOWN state',
      });
      return response;
    }

    const reportedInput =
      usage?.reported_input_tokens ??
      usage?.input_tokens ??
      usage?.prompt_tokens ??
      estimatedTokens.inputTokens;

    // Reasoning tokens extraction (OpenAI / DeepSeek / Anthropic schemas)
    const reportedReasoning =
      usage?.reported_reasoning_tokens ??
      usage?.reasoning_tokens ??
      usage?.completion_tokens_details?.reasoning_tokens ??
      0;

    let reportedOutput =
      usage?.reported_output_tokens ??
      usage?.output_tokens ??
      usage?.completion_tokens ??
      estimatedTokens.outputTokens;

    if (reportedReasoning > 0 && usage?.completion_tokens_details?.reasoning_tokens === undefined) {
      reportedOutput += reportedReasoning;
    }

    const reportedCached =
      usage?.reported_cached_tokens ??
      usage?.cached_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      0;

    const reportedUsage: TokenUsage = {
      inputTokens: reportedInput,
      outputTokens: reportedOutput,
      cachedTokens: reportedCached,
    };

    // Settle against actual provider usage
    this.budgetManager.settle({
      reservationId: reservation.reservationId,
      reportedUsage,
      providerCorrelationId: correlationId,
      idempotencyKey: settlementKey,
    }, providerId);

    return response;
  }
}
