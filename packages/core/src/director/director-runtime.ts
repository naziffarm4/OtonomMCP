/**
 * @file director-runtime.ts
 * @description Authoritative Director Reasoning Runtime implementation (Phase 27 P27).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Runtime produces reasoning / action proposals only (DirectorAction).
 * 2. Director does NOT directly mutate files, Git, Task DAG, global FSM, or execution boundaries.
 * 3. DirectorAction != Implementation Authorization. hasImplementationAuthority cannot be granted.
 * 4. Structured output is mandatory (response_format: JSON_SCHEMA + DirectorActionZodSchema validation).
 * 5. Strict context fingerprint binding: action.basedOnContextFingerprint === snapshot.logicalFingerprint.
 * 6. Stale or incomplete context triggers fail-closed error.
 * 7. In production mode, absence of LLM provider fails closed (no implicit mock/simulation fallback).
 * 8. Deterministic correlation ID generated for all requests.
 */

import * as crypto from 'node:crypto';
import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import {
  type LlmRequest,
  type LlmResponse,
  LlmResponseFormat,
} from '../llm-bridge/llm-types.js';
import type { DirectorSessionStore } from './director-session-store.js';
import type { DirectorSessionEngine } from './director-session-engine.js';
import type { DirectorContextSynchronizer } from './director-context-synchronizer.js';
import type { DirectorContextSnapshot } from './director-context-types.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  type DirectorAction,
  type DirectorActionType,
} from './director-action-types.js';
import { DirectorActionZodSchema } from './director-action-schema.js';
import {
  DirectorPromptBuilder,
  type DirectorReasoningInput,
  type DirectorReasoningTrigger,
} from './director-prompt-builder.js';
import {
  DirectorContextMismatchError,
  DirectorContextStaleError,
  DirectorContextIncompleteError,
} from './director-errors.js';
import {
  DirectorRuntimeErrorCode,
  DirectorRuntimeError,
  DirectorSessionInvalidError,
  DirectorContextUnavailableError,
  DirectorLlmProviderUnavailableError,
  DirectorLlmRequestFailedError,
  DirectorLlmResponseInvalidError,
  DirectorStructuredOutputRequiredError,
  DirectorActionValidationFailedError,
  DirectorActionContextMismatchError,
} from './director-runtime-errors.js';

// Re-export input types
export type { DirectorReasoningInput, DirectorReasoningTrigger };

// ============================================================================
// 1. REASONING RESULT CONTRACT
// ============================================================================

export interface DirectorReasoningResult {
  readonly reasoningId: string;
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly contextFingerprint: string;
  readonly action: DirectorAction;
  readonly provider: string;
  readonly model: string;
  readonly correlationId: string;
  readonly finishReason: string;
  readonly usage?: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
}

// ============================================================================
// 2. RUNTIME DEPENDENCIES & OPTIONS
// ============================================================================

export interface DirectorRuntimeDependencies {
  readonly llmProvider?: LLMProvider | null;
  readonly contextSynchronizer?: DirectorContextSynchronizer;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly historyManager?: HistoryManager;
  readonly promptBuilder?: DirectorPromptBuilder;
  readonly isProduction?: boolean;
  readonly allowMockProvider?: boolean;
  readonly requireCompleteContext?: boolean;
  readonly defaultModel?: string;
  readonly defaultTemperature?: number;
  readonly defaultMaxTokens?: number;
}

// ============================================================================
// 3. DIRECTOR RUNTIME IMPLEMENTATION
// ============================================================================

export class DirectorRuntime {
  private readonly llmProvider: LLMProvider | null;
  private readonly contextSynchronizer?: DirectorContextSynchronizer;
  private readonly sessionStore?: DirectorSessionStore;
  private readonly sessionEngine?: DirectorSessionEngine;
  private readonly historyManager?: HistoryManager;
  private readonly promptBuilder: DirectorPromptBuilder;
  private readonly isProduction: boolean;
  private readonly allowMockProvider: boolean;
  private readonly requireCompleteContext: boolean;
  private readonly defaultModel?: string;
  private readonly defaultTemperature?: number;
  private readonly defaultMaxTokens?: number;

  constructor(deps: DirectorRuntimeDependencies = {}) {
    this.llmProvider = deps.llmProvider ?? null;
    this.contextSynchronizer = deps.contextSynchronizer;
    this.sessionStore = deps.sessionStore;
    this.sessionEngine = deps.sessionEngine;
    this.historyManager = deps.historyManager;
    this.promptBuilder = deps.promptBuilder ?? new DirectorPromptBuilder();

    // Determine production environment mode
    this.isProduction =
      deps.isProduction !== undefined
        ? deps.isProduction
        : process.env.NODE_ENV === 'production';
    this.allowMockProvider = deps.allowMockProvider ?? false;
    this.requireCompleteContext = deps.requireCompleteContext ?? true;
    this.defaultModel = deps.defaultModel;
    this.defaultTemperature = deps.defaultTemperature;
    this.defaultMaxTokens = deps.defaultMaxTokens;
  }

  /**
   * Primary entrypoint: reviews context, triggers structured reasoning via LLM bridge,
   * validates DirectorAction contract, binds fingerprint, and returns typed reasoning result.
   */
  async reason(
    input: DirectorReasoningInput & {
      readonly snapshot?: DirectorContextSnapshot | null;
    }
  ): Promise<DirectorReasoningResult> {
    // ------------------------------------------------------------------------
    // Step 1: Validate active Director session
    // ------------------------------------------------------------------------
    await this.validateSession(input.projectId, input.directorSessionId);

    // ------------------------------------------------------------------------
    // Step 2 & 3: Acquire and validate context snapshot (staleness & completeness)
    // ------------------------------------------------------------------------
    const snapshot = await this.resolveAndValidateSnapshot(input);

    // ------------------------------------------------------------------------
    // Step 4: Verify LLM provider readiness & production safety
    // ------------------------------------------------------------------------
    const provider = await this.resolveAndValidateProvider();

    // ------------------------------------------------------------------------
    // Step 5: Build deterministic, bounded, secret-safe prompt
    // ------------------------------------------------------------------------
    const promptBuild = this.promptBuilder.buildPrompt(snapshot, input);

    // ------------------------------------------------------------------------
    // Step 6: Formulate and dispatch strongly typed LLM request
    // ------------------------------------------------------------------------
    const llmRequest: LlmRequest = Object.freeze({
      correlation: Object.freeze({
        correlation_id: promptBuild.correlationId,
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        attempt: input.attempt ?? 1,
      }),
      messages: promptBuild.messages,
      director_context: Object.freeze({
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        objective: input.objective ?? null,
        acceptance_criteria: null,
        attempt: input.attempt ?? 1,
        max_attempts: null,
        relevant_context: input.additionalContext ?? null,
      }),
      model: this.defaultModel ?? provider.defaultModel ?? null,
      temperature: this.defaultTemperature ?? 0.1,
      max_tokens: this.defaultMaxTokens ?? 4000,
      response_format: LlmResponseFormat.JSON_SCHEMA,
      json_schema: promptBuild.jsonSchema,
      metadata: Object.freeze({
        directorSessionId: input.directorSessionId,
        trigger: input.trigger,
        contextFingerprint: snapshot.logicalFingerprint,
      }),
    });

    let llmResponse: LlmResponse;
    try {
      llmResponse = await provider.generate(llmRequest);
    } catch (err) {
      if (
        err instanceof DirectorRuntimeError ||
        (err && typeof err === 'object' && 'code' in err && String((err as { code: unknown }).code).startsWith('DIRECTOR_'))
      ) {
        throw err;
      }
      throw new DirectorLlmRequestFailedError(
        `LLM provider execution failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          provider: provider.providerName,
          correlationId: promptBuild.correlationId,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }

    if (llmResponse.error) {
      throw new DirectorLlmRequestFailedError(
        `LLM provider returned error: ${llmResponse.error.message}`,
        {
          code: llmResponse.error.code,
          details: llmResponse.error.details,
          correlationId: promptBuild.correlationId,
        }
      );
    }

    // ------------------------------------------------------------------------
    // Step 7: Parse structured output and enforce structured output requirement
    // ------------------------------------------------------------------------
    const rawAction = this.extractStructuredOutput(llmResponse, promptBuild.correlationId);

    // ------------------------------------------------------------------------
    // Step 8: Strict authority invariant: anti-spoofing
    // Director CANNOT generate hasImplementationAuthority
    // ------------------------------------------------------------------------
    if (
      rawAction &&
      typeof rawAction === 'object' &&
      'hasImplementationAuthority' in rawAction &&
      Boolean((rawAction as Record<string, unknown>).hasImplementationAuthority)
    ) {
      // Forcefully strip or invalidate - Director action proposal never has authority
      delete (rawAction as Record<string, unknown>).hasImplementationAuthority;
    }

    // ------------------------------------------------------------------------
    // Step 9: Validate action against DirectorAction Zod schema
    // ------------------------------------------------------------------------
    const parseResult = DirectorActionZodSchema.safeParse(rawAction);
    if (!parseResult.success) {
      throw new DirectorActionValidationFailedError(
        `LLM output failed DirectorAction schema validation: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
        {
          issues: parseResult.error.issues,
          correlationId: promptBuild.correlationId,
        }
      );
    }

    const action = parseResult.data as DirectorAction;

    // ------------------------------------------------------------------------
    // Step 10: Strict context & session binding verification
    // ------------------------------------------------------------------------
    if (action.projectId !== input.projectId) {
      throw new DirectorActionValidationFailedError(
        `DirectorAction projectId '${action.projectId}' does not match expected projectId '${input.projectId}'.`,
        {
          expectedProjectId: input.projectId,
          actualProjectId: action.projectId,
        }
      );
    }

    if (action.directorSessionId !== input.directorSessionId) {
      throw new DirectorSessionInvalidError(
        `DirectorAction directorSessionId '${action.directorSessionId}' does not match expected session '${input.directorSessionId}'.`,
        {
          expectedSessionId: input.directorSessionId,
          actualSessionId: action.directorSessionId,
        }
      );
    }

    if (action.basedOnContextFingerprint !== snapshot.logicalFingerprint) {
      throw new DirectorActionContextMismatchError(
        `DirectorAction fingerprint mismatch: action is based on '${action.basedOnContextFingerprint}', but current context fingerprint is '${snapshot.logicalFingerprint}'. Fail-closed rejection.`,
        {
          expectedFingerprint: snapshot.logicalFingerprint,
          actionFingerprint: action.basedOnContextFingerprint,
        }
      );
    }

    // ------------------------------------------------------------------------
    // Step 11: Build and return reasoning result + audit metadata
    // ------------------------------------------------------------------------
    const reasoningId = `dir-rsn-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();

    const result: DirectorReasoningResult = Object.freeze({
      reasoningId,
      projectId: input.projectId,
      directorSessionId: input.directorSessionId,
      contextFingerprint: snapshot.logicalFingerprint,
      action,
      provider: provider.providerName,
      model: llmResponse.model || (this.defaultModel ?? provider.defaultModel),
      correlationId: promptBuild.correlationId,
      finishReason: String(llmResponse.finish_reason ?? 'STOP'),
      usage: llmResponse.usage ? Object.freeze({ ...llmResponse.usage }) : null,
      createdAt,
    });

    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'DIRECTOR_REASONING_COMPLETED',
          actor: Actor.DIRECTOR,
          payload: {
            reasoningId,
            projectId: input.projectId,
            directorSessionId: input.directorSessionId,
            contextFingerprint: snapshot.logicalFingerprint,
            actionType: action.actionType,
            actionId: action.actionId,
            confidence: action.confidence,
            correlationId: promptBuild.correlationId,
            provider: provider.providerName,
          },
        });
      } catch {
        // Audit failures must not break reasoning runtime
      }
    }

    return result;
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  private async validateSession(projectId: string, directorSessionId: string): Promise<void> {
    if (!directorSessionId || typeof directorSessionId !== 'string' || directorSessionId.trim().length === 0) {
      throw new DirectorSessionInvalidError('directorSessionId cannot be empty.');
    }

    if (this.sessionStore) {
      const session = await this.sessionStore.loadSession(directorSessionId);
      if (!session) {
        throw new DirectorSessionInvalidError(
          `Director session '${directorSessionId}' does not exist.`
        );
      }
      if (session.projectId !== projectId) {
        throw new DirectorSessionInvalidError(
          `Director session '${directorSessionId}' belongs to project '${session.projectId}', not '${projectId}'. Accidental cross-project reasoning rejected.`
        );
      }
      if (session.status !== 'ACTIVE') {
        throw new DirectorSessionInvalidError(
          `Director session '${directorSessionId}' is ${session.status}. Reasoning requires an ACTIVE session.`
        );
      }
    } else if (this.sessionEngine) {
      const session = await this.sessionEngine.getSession(directorSessionId, { projectId });
      if (session.status !== 'ACTIVE') {
        throw new DirectorSessionInvalidError(
          `Director session '${directorSessionId}' is ${session.status}. Reasoning requires an ACTIVE session.`
        );
      }
    }
  }

  private async resolveAndValidateSnapshot(
    input: DirectorReasoningInput & {
      readonly snapshot?: DirectorContextSnapshot | null;
    }
  ): Promise<DirectorContextSnapshot> {
    let snapshot = input.snapshot ?? null;

    if (!snapshot) {
      if (this.sessionStore) {
        snapshot = await this.sessionStore.loadLatestSnapshot(input.directorSessionId);
      }
      if (!snapshot && this.contextSynchronizer) {
        try {
          snapshot = await this.contextSynchronizer.synchronize({
            directorSessionId: input.directorSessionId,
            projectId: input.projectId,
          });
        } catch (err) {
          throw new DirectorContextUnavailableError(
            `Failed to synchronize context snapshot: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    if (!snapshot) {
      throw new DirectorContextUnavailableError(
        `No context snapshot found or available for Director session '${input.directorSessionId}'. Context synchronization required.`
      );
    }

    // Validate project & session binding on snapshot
    if (snapshot.projectId !== input.projectId) {
      throw new DirectorContextMismatchError(
        `Context snapshot projectId '${snapshot.projectId}' does not match requested projectId '${input.projectId}'.`,
        DirectorRuntimeErrorCode.DIRECTOR_CONTEXT_MISMATCH
      );
    }

    if (snapshot.directorSessionId !== input.directorSessionId) {
      throw new DirectorSessionInvalidError(
        `Context snapshot directorSessionId '${snapshot.directorSessionId}' does not match requested session '${input.directorSessionId}'.`
      );
    }

    // Staleness check
    if (
      snapshot.syncStatus === 'STALE' ||
      (Array.isArray(snapshot.staleSections) && snapshot.staleSections.length > 0)
    ) {
      throw new DirectorContextStaleError(
        `Context snapshot is stale (stale sections: ${snapshot.staleSections?.join(', ') || 'unknown'}). Decisions cannot be made on stale context.`,
        DirectorRuntimeErrorCode.DIRECTOR_CONTEXT_STALE
      );
    }

    // Completeness check
    if (this.requireCompleteContext) {
      if (
        snapshot.syncStatus === 'INCOMPLETE' ||
        snapshot.isComplete === false ||
        (Array.isArray(snapshot.unavailableSections) && snapshot.unavailableSections.length > 0)
      ) {
        throw new DirectorContextIncompleteError(
          `Context snapshot is incomplete (unavailable sections: ${snapshot.unavailableSections?.join(', ') || 'none'}). Decisions cannot be made on incomplete context.`,
          DirectorRuntimeErrorCode.DIRECTOR_CONTEXT_INCOMPLETE
        );
      }
    }

    return snapshot;
  }

  private async resolveAndValidateProvider(): Promise<LLMProvider> {
    if (!this.llmProvider) {
      throw new DirectorLlmProviderUnavailableError(
        'No LLM provider configured for DirectorRuntime. Real LLM provider is required in production (fail-closed).'
      );
    }

    // Production safety invariant: no implicit mock or simulation in production
    if (this.isProduction && this.llmProvider.isMock && !this.allowMockProvider) {
      throw new DirectorLlmProviderUnavailableError(
        'Mock LLM provider is strictly prohibited in production mode. A real LLM provider must be configured.'
      );
    }

    try {
      const avail = await this.llmProvider.checkAvailability();
      if (!avail.available) {
        throw new DirectorLlmProviderUnavailableError(
          `LLM provider '${this.llmProvider.providerName}' is unavailable: ${avail.reason ?? 'checkAvailability returned false'}`
        );
      }
    } catch (err) {
      if (err instanceof DirectorRuntimeError) {
        throw err;
      }
      throw new DirectorLlmProviderUnavailableError(
        `LLM provider '${this.llmProvider.providerName}' availability check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return this.llmProvider;
  }

  private extractStructuredOutput(
    response: LlmResponse,
    correlationId: string
  ): unknown {
    if (response.structured_output !== null && response.structured_output !== undefined) {
      if (typeof response.structured_output === 'object') {
        return response.structured_output;
      }
    }

    if (typeof response.content === 'string' && response.content.trim().length > 0) {
      const trimmed = response.content.trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new DirectorLlmResponseInvalidError(
          `Failed to parse LLM response as JSON: ${err instanceof Error ? err.message : String(err)}`,
          {
            rawContent: trimmed,
            correlationId,
          }
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new DirectorStructuredOutputRequiredError(
          'LLM response must be a structured JSON object conforming to DirectorAction schema.',
          { correlationId }
        );
      }

      return parsed;
    }

    throw new DirectorStructuredOutputRequiredError(
      'Structured output is required for Director reasoning. No structured_output or valid JSON content received.',
      { correlationId }
    );
  }
}
