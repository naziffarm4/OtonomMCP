import type { LLMProvider, LlmProviderAvailability, LlmCapability } from '../llm-bridge/llm-provider.js';
import type { LlmRequest, LlmResponse } from '../llm-bridge/llm-types.js';
import { LlmTimeoutError } from '../errors/llm-error.js';
import { BudgetError } from '../errors/budget-error.js';
import type { BudgetManager } from './budget-manager.js';
import { ReservationState, type TokenUsage } from './budget-types.js';
import { UsageNormalizer } from './usage-normalizer.js';

import { auditBillingEndpoint, resolveEffectiveBillingEndpoint } from './endpoint-audit.js';

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

    const innerWithSetter = this.inner as unknown as { setBudgetManager?(bm: BudgetManager): void };
    if (typeof innerWithSetter.setBudgetManager === 'function') {
      innerWithSetter.setBudgetManager(this.budgetManager);
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
    const correlationId = withInvocationDiscriminator(request.correlation?.correlation_id ?? `corr_${Date.now()}`, request.metadata);
    const attempt = request.correlation?.attempt ?? 1;
    const model = request.model?.trim() || this.defaultModel;
    const providerId = this.providerName;

    // 0. Resolve Effective Billing Endpoint & Audit (Fail closed before dispatch)
    const resolvedEndpoint = resolveEffectiveBillingEndpoint({
      requestEndpoint: request.metadata?.endpoint as string | undefined,
      requestBaseUrl: (request.metadata?.base_url ?? request.metadata?.baseUrl) as string | undefined,
      adapterEndpoint: (this.inner as unknown as { endpoint?: string })?.endpoint,
      transportEndpoint: (this.inner as unknown as { transport?: { endpoint?: string } })?.transport?.endpoint,
      envLlmEndpoint: process.env.AIDM_LLM_ENDPOINT,
      envOpenAiBaseUrl: process.env.OPENAI_BASE_URL,
      providerId,
      modelId: model,
      usageContract: (request.metadata?.usage_contract ?? request.metadata?.usageContract) as string | undefined,
    });

    if (!resolvedEndpoint.success) {
      throw new BudgetError(resolvedEndpoint.errorReason, resolvedEndpoint.errorCode);
    }

    const auditResult = auditBillingEndpoint({
      endpoint: resolvedEndpoint.effectiveUrl,
      metadata: request.metadata,
      providerId,
      modelId: model,
      pricingEngine: this.budgetManager.pricingEngine,
      usageContract: (request.metadata?.usage_contract ?? request.metadata?.usageContract) as string | undefined,
    });

    if (!auditResult.valid) {
      throw new BudgetError(auditResult.errorReason, auditResult.errorCode);
    }
    const billingProvider = (auditResult.isCustomHost && auditResult.effectiveHost)
      ? auditResult.effectiveHost
      : providerId;

    const estimatedTokens = this.estimateTokens(request);
    const reservationKey = `idemp_res_${correlationId}_att_${attempt}`;
    const settlementKey = `idemp_set_${correlationId}_att_${attempt}`;

    // Resolve target account ID: if caller specifies account or project has dedicated account, reserve against it
    const targetAccountId =
      (request.metadata?.account_id as string | undefined) ??
      (request.metadata?.accountId as string | undefined) ??
      (() => {
        const projectId =
          request.correlation?.project_id ??
          (request.metadata?.project_id as string | undefined) ??
          (request.director_context?.project_id as string | undefined);
        if (projectId) {
          const projectAccount = this.budgetManager.getProjectAccount(projectId);
          if (projectAccount) {
            return projectAccount.accountId;
          }
        }
        return this.budgetManager.getGlobalAccount()?.accountId;
      })();

    // 1. Pre-dispatch Budget Validation (fails closed if budget insufficient or pricing missing)
    this.budgetManager.preDispatchValidate({
      accountId: targetAccountId,
      sessionId: correlationId,
      taskId: request.correlation?.task_id ?? null,
      providerId: billingProvider,
      modelId: model,
      estimatedTokens,
      idempotencyKey: reservationKey,
    }, true);

    // 2. Atomic Budget Reservation in PREPARED state
    const reservation = this.budgetManager.reserve({
      accountId: targetAccountId,
      sessionId: correlationId,
      taskId: request.correlation?.task_id ?? null,
      providerId: billingProvider,
      modelId: model,
      estimatedTokens,
      idempotencyKey: reservationKey,
    });

    // 3. Mark Reservation DISPATCHED before issuing the HTTP call.
    // An idempotent replay of the same request key returns the EXISTING reservation.
    // - SETTLED: genuine replay of a reconciled request (existing contract: no double charge).
    // - DISPATCHED / UNKNOWN: the earlier outcome is unreconciled; dispatching again would add
    //   provider spend on top of an open hold without its own reservation -> fail closed.
    // Distinct logical requests must carry distinct correlation ids / attempts / invocation ids.
    if (reservation.state === ReservationState.DISPATCHED || reservation.state === ReservationState.UNKNOWN) {
      throw new BudgetError(
        `Budget reservation '${reservation.reservationId}' for idempotency key '${reservationKey}' is ${reservation.state} (unreconciled); refusing to dispatch another provider request under the same reservation.`,
        'ERR_BUDGET_DUPLICATE_DISPATCH',
        { reservationId: reservation.reservationId, state: reservation.state, idempotencyKey: reservationKey }
      );
    }
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
        __aidm_account_id: reservation.accountId,
        __aidm_dispatch_claim_id: dispatchClaimId,
        __aidm_effective_endpoint: resolvedEndpoint.effectiveUrl,
        __aidm_endpoint_kind: auditResult.endpointKind,
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

      // A completion WAS received but rejected locally (e.g. structured-output validation):
      // the provider billed it, so settle against the provider-reported usage when available.
      const reportedUsage = !isTimeout ? extractReportedUsage(err) : null;
      if (reportedUsage) {
        const settled = this.trySettleFromUsage({
          usage: reportedUsage,
          request,
          authorizedRequest,
          reservationId: reservation.reservationId,
          model,
          billingProvider,
          providerId,
          correlationId,
          settlementKey,
          endpoint: resolvedEndpoint.effectiveUrl,
          endpointKind: auditResult.endpointKind,
          serviceTier: estimatedTokens.serviceTier ?? 'standard',
        });
        if (settled) throw err;
      }

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
    const rate = this.budgetManager.getPricingRate(billingProvider, model, estimatedTokens.serviceTier);
    if (!rate) {
      this.budgetManager.recordUnknown({
        reservationId: reservation.reservationId,
        errorReason: `Model '${model}' has no verified pricing registered under provider '${billingProvider}'; holding reservation in UNKNOWN state`,
      });
      throw new BudgetError(`Model '${model}' has no verified pricing registered`, 'ERR_PRICING_NOT_FOUND');
    }

    const normResult = UsageNormalizer.normalizeAndReconcile({
      response: response as LlmResponse<unknown>,
      request: authorizedRequest,
      modelId: model,
      rate,
      pricingEngine: this.budgetManager.pricingEngine,
      providerId: billingProvider,
      endpoint: resolvedEndpoint.effectiveUrl,
      expectedEndpointKind: auditResult.endpointKind,
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

  /** Settles a reservation from provider-reported usage attached to a rejected response. */
  private trySettleFromUsage(p: {
    usage: Record<string, unknown>;
    request: LlmRequest;
    authorizedRequest: LlmRequest;
    reservationId: string;
    model: string;
    billingProvider: string;
    providerId: string;
    correlationId: string;
    settlementKey: string;
    endpoint: string | undefined;
    endpointKind: Parameters<typeof UsageNormalizer.normalizeAndReconcile>[0]['expectedEndpointKind'];
    serviceTier: string;
  }): boolean {
    try {
      const rate = this.budgetManager.getPricingRate(p.billingProvider, p.model, p.serviceTier);
      if (!rate) return false;
      const pseudoResponse = {
        correlation: p.request.correlation,
        provider: p.providerId,
        model: typeof p.usage.model === 'string' ? p.usage.model : p.model,
        content: '',
        structured_output: null,
        finish_reason: 'STOP',
        usage: p.usage,
        raw_metadata: null,
        error: null,
      } as unknown as LlmResponse<unknown>;
      const norm = UsageNormalizer.normalizeAndReconcile({
        response: pseudoResponse,
        request: p.authorizedRequest,
        modelId: p.model,
        rate,
        pricingEngine: this.budgetManager.pricingEngine,
        providerId: p.billingProvider,
        endpoint: p.endpoint,
        expectedEndpointKind: p.endpointKind,
      });
      if (!norm.success) return false;
      this.budgetManager.settle({
        reservationId: p.reservationId,
        reportedUsage: norm.usage,
        providerCorrelationId: p.correlationId,
        idempotencyKey: p.settlementKey,
      }, p.providerId);
      return true;
    } catch {
      return false;
    }
  }
}

function extractReportedUsage(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { usage?: unknown; details?: { usage?: unknown } };
  const u = e.usage ?? e.details?.usage;
  if (!u || typeof u !== 'object') return null;
  const rec = u as Record<string, unknown>;
  // Only provider-reported (non-estimated) usage may settle actual spend.
  if (rec.is_exact_provider_metric === false || rec.is_estimated === true) return null;
  return rec;
}

/**
 * Distinct logical requests that share a deterministic correlation id (e.g. a new Director cycle
 * for the same task/trigger) carry metadata.llm_invocation_id and get their own reservation and
 * settlement keys. A genuine retry of the same request keeps the same id and stays idempotent.
 */
function withInvocationDiscriminator(correlationId: string, metadata: LlmRequest['metadata']): string {
  const raw = metadata?.llm_invocation_id;
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? `${correlationId}_inv_${raw}` : correlationId;
}
