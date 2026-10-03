/**
 * @file director-reasoning-engine.ts
 * @description Production Director Reasoning Runtime engine (TASK-P18-02).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Leverages HttpLlmTransport and LLMProvider adapter boundary.
 * 2. Fail-closed: No silent mock fallback in production.
 * 3. Supports request correlation IDs, timeouts, and AbortSignal cancellation.
 * 4. Captures exact provider-reported token usage and distinguishes from estimated tokens.
 * 5. Secret sanitization: API keys and credentials are never exposed in logs or errors.
 * 6. Validates model decisions against AIDM decision contract and prevents authority escalation.
 */

import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import {
  ReferenceLlmAdapter,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
} from '../llm-bridge/reference-llm-adapter.js';
import { HttpLlmTransport } from '../llm-bridge/http-llm-transport.js';
import { TransportSecurityRegistry } from '../llm-bridge/transport-security-registry.js';
import {
  LlmProviderUnavailableError,
  LlmTimeoutError,
  LlmExecutionError,
  MalformedLlmResponseError,
  sanitizeSecrets,
} from '../errors/llm-error.js';
import { TokenBudgetError } from '../errors/token-budget-error.js';
import { BudgetError } from '../errors/budget-error.js';
import { BudgetAwareLlmAdapter } from '../budget/budget-aware-llm-adapter.js';
import {
  DirectorValidationError,
  DirectorSecurityError,
} from '../director/director-errors.js';
import type { DirectorDecisionEngine } from '../director/director-decision-engine.js';
import { DirectorPromptBuilder } from './director-prompt-builder.js';
import { DirectorResponseParser } from './director-response-parser.js';
import type {
  DirectorReasoningEngineConfig,
  DirectorReasoningInput,
  DirectorReasoningResult,
} from './director-reasoning-types.js';
import { generateDeterministicLlmCorrelationId } from '../llm-bridge/llm-types.js';

export class DirectorReasoningEngine {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly timeoutMs: number;
  readonly mode: 'production' | 'development' | 'test';
  readonly promptBuilder: DirectorPromptBuilder;
  readonly responseParser: DirectorResponseParser;
  readonly decisionEngine?: DirectorDecisionEngine;
  readonly isMock: boolean;
  private readonly validatedTransport: unknown;

  constructor(config: DirectorReasoningEngineConfig = {}) {
    this.mode = config.mode ?? 'production';
    this.timeoutMs = config.defaultTimeoutMs ?? 30000;
    this.promptBuilder = config.promptBuilder ?? new DirectorPromptBuilder();
    this.responseParser = config.responseParser ?? new DirectorResponseParser();
    this.decisionEngine = config.decisionEngine;

    // 1. Resolve Provider
    let resolvedProvider: LLMProvider | undefined = config.provider;

    if (!resolvedProvider && config.providerRegistry) {
      resolvedProvider = config.providerId
        ? config.providerRegistry.get(config.providerId)
        : config.providerRegistry.getDefault();
    }

    if (!resolvedProvider) {
      // Attempt to configure from explicit config or environment variables
      const endpoint = config.endpoint ?? process.env.AIDM_LLM_ENDPOINT;
      const apiKey =
        config.apiKey ??
        process.env.AIDM_LLM_API_KEY ??
        process.env.OPENAI_API_KEY ??
        null;

      if (endpoint || apiKey) {
        const transport = new HttpLlmTransport<
          ReferenceWireRequest,
          ReferenceWireResponse
        >({
          endpoint: endpoint ?? undefined,
          apiKey: apiKey ?? null,
          authHeaderName: config.authHeaderName,
          authHeaderPrefix: config.authHeaderPrefix,
          defaultTimeoutMs: this.timeoutMs,
        });

        resolvedProvider = new ReferenceLlmAdapter({
          providerId: config.providerId ?? 'llm:reference-adapter',
          providerName: 'reference-llm',
          defaultModel: config.model ?? 'director-reasoning-v1',
          transport,
          timeoutMs: this.timeoutMs,
          endpoint: endpoint ?? undefined,
        });
      }
    }

    // 2. Strict Fail-Closed Check
    if (!resolvedProvider) {
      throw new LlmProviderUnavailableError(
        'DirectorReasoningEngine failed to initialize: No LLM provider configured and no real credentials found. Fail-closed rule strictly enforced.',
        {
          reason: 'NO_PROVIDER_CONFIGURED',
          mode: this.mode,
        }
      );
    }

    // 2.1 Attach Budget Management if configured
    if (config.budgetManager && !(resolvedProvider instanceof BudgetAwareLlmAdapter)) {
      resolvedProvider = new BudgetAwareLlmAdapter(resolvedProvider, config.budgetManager as any);
    }

    // 3. Robust inspection of provider and underlying transport (F-01)
    const underlyingTransport = (resolvedProvider as unknown as { transport?: any })
      .transport;
    this.validatedTransport = underlyingTransport;

    const isMockTransport = TransportSecurityRegistry.isMockTransport(underlyingTransport);
    const isMockProvider = Boolean(
      resolvedProvider.providerName.toLowerCase().includes('mock') ||
        resolvedProvider.providerId.toLowerCase().includes('mock') ||
        (resolvedProvider as unknown as { isMock?: boolean }).isMock === true ||
        isMockTransport
    );

    this.isMock = isMockProvider;

    // Strict Production Constraints
    if (this.mode === 'production') {
      // 3.1 Reject any mock provider or transport
      if (isMockProvider) {
        throw new LlmProviderUnavailableError(
          'Mock LLM provider is strictly prohibited in production mode. A verified live network transport (HttpLlmTransport) is required.',
          {
            providerId: resolvedProvider.providerId,
            transportName: (underlyingTransport as any)?.transportName,
            mode: this.mode,
            reason: 'MOCK_FORBIDDEN_IN_PRODUCTION',
          }
        );
      }

      // 3.2 Production fail-closed rule: Transport MUST be an authentic, verified live network transport
      TransportSecurityRegistry.assertTrustedLiveTransport(
        underlyingTransport,
        'DirectorReasoningEngine.constructor'
      );

      // 3.3 F-02: Production Decision Engine is strictly mandatory in production mode
      if (!this.decisionEngine) {
        throw new DirectorValidationError(
          'DirectorReasoningEngine requires an authoritative DirectorDecisionEngine in production mode. Fail-closed rule strictly enforced.',
          {
            mode: this.mode,
            reason: 'MISSING_DECISION_ENGINE_IN_PRODUCTION',
          }
        );
      }

      // 3.4 Production fail-closed rule: BudgetManager is strictly mandatory in production mode
      if (!config.budgetManager) {
        throw new BudgetError(
          'DirectorReasoningEngine requires an authoritative BudgetManager in production mode. Operation without budget governance is strictly prohibited.',
          'ERR_BUDGET_REQUIRED',
          {
            mode: this.mode,
            reason: 'MISSING_BUDGET_MANAGER_IN_PRODUCTION',
          }
        );
      }
    } else {
      // In non-production (development), mock is only permitted if explicitly enabled or mode is test
      if (
        isMockProvider &&
        this.mode !== 'test' &&
        !config.allowMockInDevelopment
      ) {
        throw new LlmProviderUnavailableError(
          'Mock LLM provider or transport is not allowed unless allowMockInDevelopment is explicitly enabled or mode is test.',
          {
            providerId: resolvedProvider.providerId,
            mode: this.mode,
            reason: 'MOCK_NOT_EXPLICITLY_ENABLED',
          }
        );
      }
    }

    this.provider = resolvedProvider;
    this.model = config.model ?? this.provider.defaultModel;
  }

  /**
   * Executes a reasoning cycle on the provided DirectorContextSnapshot.
   */
  async reason(input: DirectorReasoningInput): Promise<DirectorReasoningResult> {
    const snapshot = input.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      throw new DirectorValidationError(
        'DirectorReasoningEngine: Valid DirectorContextSnapshot is required',
        { reason: 'INVALID_SNAPSHOT' }
      );
    }

    if (!snapshot.logicalFingerprint) {
      throw new DirectorValidationError(
        'DirectorReasoningEngine: DirectorContextSnapshot missing logicalFingerprint',
        { reason: 'MISSING_LOGICAL_FINGERPRINT' }
      );
    }

    // 1. Production Validation & Transport Integrity Rules Check (F-01, F-02)
    if (this.mode === 'production') {
      if (!(this.provider instanceof BudgetAwareLlmAdapter)) {
        throw new BudgetError(
          'DirectorReasoningEngine provider must be wrapped with BudgetAwareLlmAdapter in production mode.',
          'ERR_BUDGET_REQUIRED',
          {
            mode: this.mode,
            reason: 'MISSING_BUDGET_GOVERNANCE',
          }
        );
      }

      const currentTransport = (this.provider as unknown as { transport?: any })?.transport;
      if (currentTransport !== this.validatedTransport) {
        throw new DirectorSecurityError(
          'Transport integrity violation: provider.transport was mutated after DirectorReasoningEngine initialization.',
          {
            mode: this.mode,
            reason: 'TRANSPORT_INTEGRITY_TAMPERED',
          }
        );
      }
      TransportSecurityRegistry.assertTrustedLiveTransport(
        currentTransport,
        'DirectorReasoningEngine.reason'
      );

      if (!this.decisionEngine) {
        throw new DirectorValidationError(
          'DirectorReasoningEngine requires an authoritative DirectorDecisionEngine in production mode. Fail-closed rule strictly enforced.',
          {
            mode: this.mode,
            reason: 'MISSING_DECISION_ENGINE_IN_PRODUCTION',
          }
        );
      }
      if (input.validateThroughDecisionEngine === false) {
        throw new DirectorSecurityError(
          'Production reasoning cannot bypass validation through DirectorDecisionEngine. validateThroughDecisionEngine: false is strictly prohibited in production mode.',
          {
            mode: this.mode,
            reason: 'PRODUCTION_VALIDATION_BYPASS_FORBIDDEN',
          }
        );
      }
    }

    const effectiveValidateThroughDecisionEngine =
      this.mode === 'production'
        ? true
        : (input.validateThroughDecisionEngine ?? Boolean(this.decisionEngine));

    // 2. Establish Correlation ID
    const correlationId =
      input.correlationId ??
      generateDeterministicLlmCorrelationId(
        snapshot.projectId,
        snapshot.sections.currentTask.task?.taskId ?? null,
        'director_reasoning'
      );

    // 3. Build Request Prompt via PromptBuilder
    const effectiveTimeoutMs = input.timeoutMs ?? this.timeoutMs;
    const llmRequest = this.promptBuilder.buildLlmRequest(snapshot, {
      correlationId,
      model: this.model,
      timeoutMs: effectiveTimeoutMs,
      userInstructions: input.userInstructions,
      metadata: {
        ...(input.metadata ?? {}),
        directorSessionId: snapshot.directorSessionId,
        logicalFingerprint: snapshot.logicalFingerprint,
      },
    });

    // 4. Setup AbortSignal / Timeout management
    const abortController = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        throw new LlmTimeoutError('Reasoning aborted prior to dispatch', {
          correlationId,
          reason: 'PRE_ABORTED',
        });
      }
      input.signal.addEventListener(
        'abort',
        () => abortController.abort(input.signal?.reason),
        { once: true }
      );
    }

    // 5. Dispatch call through the real Provider Adapter
    const startTime = Date.now();
    let llmResponse;

    try {
      llmResponse = await this.provider.generate(llmRequest);
    } catch (err) {
      const sanitizedMsg =
        err instanceof Error ? sanitizeSecrets(err.message) : 'Reasoning failed';

      // Propagate known error types preserving their identity and sanitizing
      if (err instanceof LlmTimeoutError) {
        throw err;
      }
      if (err instanceof TokenBudgetError) {
        throw err;
      }
      if (err instanceof BudgetError) {
        throw err;
      }
      if (err instanceof LlmProviderUnavailableError) {
        throw err;
      }
      if (err instanceof DirectorSecurityError) {
        throw err;
      }
      if (err instanceof MalformedLlmResponseError) {
        throw err;
      }
      if (err instanceof DirectorValidationError) {
        throw err;
      }

      // Wrap other unexpected network / runtime errors
      throw new LlmExecutionError(
        `Director reasoning failed during provider dispatch: ${sanitizedMsg}`,
        {
          correlationId,
          providerId: this.provider.providerId,
          model: this.model,
          originalError: sanitizedMsg,
        }
      );
    }

    const latencyMs = Date.now() - startTime;

    // 6. Parse and Validate Model Decision (F-03: usage preserved on error)
    let parseResult;
    try {
      parseResult = await this.responseParser.parse({
        content: llmResponse.content,
        structuredOutput: llmResponse.structured_output,
        snapshot,
        expectedFingerprint: snapshot.logicalFingerprint,
        validateThroughDecisionEngine: effectiveValidateThroughDecisionEngine,
        decisionEngine: this.decisionEngine,
        usage: llmResponse.usage,
      });
    } catch (err) {
      if (err && typeof err === 'object') {
        const errObj = err as { details?: Record<string, unknown>; usage?: unknown };
        if (llmResponse.usage) {
          if (!errObj.usage) {
            errObj.usage = llmResponse.usage;
          }
          if (errObj.details && typeof errObj.details === 'object') {
            if (!errObj.details.usage) {
              errObj.details.usage = llmResponse.usage;
            }
          }
        }
      }
      throw err;
    }

    // 6. Return Structured Reasoning Result
    return {
      success: true,
      decision: parseResult.decision,
      validationResult: parseResult.validationResult,
      rawResponse: llmResponse.content,
      correlationId,
      providerId: this.provider.providerId,
      model: llmResponse.model || this.model,
      usage: llmResponse.usage,
      latencyMs,
      isMock: this.isMock,
    };
  }
}
