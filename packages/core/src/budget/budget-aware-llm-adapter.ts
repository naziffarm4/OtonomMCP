import type { LLMProvider, LlmProviderAvailability, LlmCapability } from '../llm-bridge/llm-provider.js';
import type { LlmRequest, LlmResponse } from '../llm-bridge/llm-types.js';
import { LlmTimeoutError } from '../errors/llm-error.js';
import { BudgetError } from '../errors/budget-error.js';
import type { BudgetManager } from './budget-manager.js';
import { ReservationState, type TokenUsage } from './budget-types.js';
import { UsageNormalizer } from './usage-normalizer.js';

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
      serviceTier: (request.metadata?.service_tier ?? request.metadata?.serviceTier ?? 'standard') as string,
    };
  }

  async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
    // 0. Surcharge & Unsupported Billing Mode Check (Fail closed)
    if (
      request.metadata?.regional ||
      request.metadata?.data_residency ||
      request.metadata?.dataResidency ||
      request.metadata?.regional_processing
    ) {
      throw new BudgetError(
        'Regional processing and data-residency billing surcharges are not currently supported by pricing engine; rejected fail-closed to prevent billing inaccuracy',
        'ERR_UNSUPPORTED_BILLING_MODE'
      );
    }

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
    if (reservation.state === ReservationState.PREPARED) {
      this.budgetManager.markDispatched(reservation.reservationId);
    }

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

    // 5b. Authoritative Usage Normalization & Fail-Closed Reconciliation
    const rate = this.budgetManager.getPricingRate(providerId, model, estimatedTokens.serviceTier);
    if (!rate) {
      this.budgetManager.recordUnknown({
        reservationId: reservation.reservationId,
        errorReason: `Model '${model}' has no verified pricing registered under provider '${providerId}'; holding reservation in UNKNOWN state`,
      });
      throw new BudgetError(`Model '${model}' has no verified pricing registered`, 'ERR_PRICING_NOT_FOUND');
    }

    const normResult = UsageNormalizer.normalizeAndReconcile({
      response: response as LlmResponse<unknown>,
      request,
      modelId: model,
      rate,
      pricingEngine: this.budgetManager.pricingEngine,
      providerId,
    });

    if (!normResult.success) {
      // Incomplete, malformed, or missing required usage metrics:
      // Keep reservation in UNKNOWN state, retaining reservation hold against unbudgeted spend.
      // Never settle using estimates as actual!
      this.budgetManager.recordUnknown({
        reservationId: reservation.reservationId,
        errorReason: `${normResult.errorReason}; holding reservation in UNKNOWN state`,
      });
      return response;
    }

    // Settle against verified actual provider usage
    try {
      this.budgetManager.settle({
        reservationId: reservation.reservationId,
        reportedUsage: normResult.usage,
        providerCorrelationId: correlationId,
        idempotencyKey: settlementKey,
      }, providerId);
    } catch (settleErr) {
      // If settlement fails (e.g. unpriced tier, invalid token metrics),
      // retain reservation in UNKNOWN state to preserve the reserved spend hold.
      try {
        this.budgetManager.recordUnknown({
          reservationId: reservation.reservationId,
          errorReason: `Usage settlement failed: ${(settleErr as Error).message}; holding reservation in UNKNOWN state`,
        });
      } catch {
        // preserve original error
      }
      throw settleErr;
    }

    return response;
  }
}
