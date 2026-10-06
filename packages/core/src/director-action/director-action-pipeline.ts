/**
 * @file director-action-pipeline.ts
 * @description Closed pipeline integrating Director Reasoning Engine with Structured Director Action
 * Envelope creation and semantic validation (TASK-P19-02).
 *
 * PIPELINE FLOW:
 * Authoritative Director Snapshot
 * → Prompt Builder
 * → Director Reasoning Engine
 * → Provider Response Parser
 * → Parsed Director Decision
 * → Structured Action Envelope
 * → Director Action Validator
 * → Validated Action Result
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. PROPOSAL ONLY, NO EXECUTION: The output of this pipeline is a validated action proposal.
 *    It strictly DOES NOT invoke DriverEngine, DriverRuntime, or Antigravity CLI.
 * 2. AUTHORITATIVE SNAPSHOT SOURCE: All envelope metadata (projectId, directorSessionId,
 *    logicalFingerprint, understandingRevision) is sourced strictly from the authoritative snapshot.
 * 3. NO ACTOR ESCALATION: The model cannot claim PRODUCT_OWNER or self-authorize.
 * 4. FAIL CLOSED: If the LLM provider times out, fails, or produces malformed JSON,
 *    the pipeline fails closed immediately and does NOT manufacture any action envelope.
 * 5. PERSISTENT IDEMPOTENCY: Integrates with DirectorActionValidator and HistoryManager
 *    for deduplication across invocations.
 */

import { DirectorReasoningEngine } from '../director-reasoning/director-reasoning-engine.js';
import type {
  DirectorReasoningInput,
  DirectorReasoningResult as LegacyDirectorReasoningResult,
} from '../director-reasoning/director-reasoning-types.js';
import {
  DirectorRuntime,
  type DirectorReasoningResult as P27DirectorReasoningResult,
} from '../director/director-runtime.js';
import { DirectorRuntimeUnavailableError } from '../director/director-runtime-errors.js';
import {
  type DirectorActionEnvelope,
  type DirectorActionType,
} from './director-action-types.js';
import { DirectorActionBuilder } from './director-action-builder.js';
import {
  DirectorActionValidator,
  type DirectorActionValidationResult,
  type DirectorActionValidationContext,
  type TaskSummaryInfo,
} from './director-action-validator.js';

export interface DirectorActionPipelineConfig {
  readonly reasoningEngine?: DirectorReasoningEngine;
  readonly directorRuntime?: DirectorRuntime;
  readonly actionBuilder?: DirectorActionBuilder;
  readonly actionValidator?: DirectorActionValidator;
  /** Explicit test-only flag to allow legacy DirectorReasoningEngine fallback */
  readonly allowLegacyReasoningEngine?: boolean;
}

export interface RunDirectorActionPipelineInput extends Partial<DirectorReasoningInput> {
  readonly snapshot: any;
  /** Optional custom idempotency key to enforce deterministic deduplication */
  readonly idempotencyKey?: string;
  /** Optional active execution cycle ID */
  readonly cycleId?: string;
  /** Optional explicit action type override */
  readonly explicitActionType?: DirectorActionType;
  /** Optional custom payload overrides */
  readonly customPayload?: Record<string, unknown>;
  /** Optional Task DAG state for deep lineage validation */
  readonly existingTasks?: readonly TaskSummaryInfo[];
  /** Optional target task ID */
  readonly taskId?: string;
  /** Optional user instructions */
  readonly userInstructions?: string;
}

export interface DirectorActionPipelineResult {
  readonly success: true;
  readonly reasoningResult: LegacyDirectorReasoningResult | P27DirectorReasoningResult;
  readonly envelope: DirectorActionEnvelope;
  readonly validationResult: DirectorActionValidationResult;
  readonly isDuplicate: boolean;
}

export type ValidatedDirectorActionResult =
  | DirectorActionPipelineResult
  | {
      readonly success: false;
      readonly isDuplicate?: boolean;
      readonly envelope?: undefined;
      readonly validationResult?: DirectorActionValidationResult;
      readonly error: string;
      readonly rawDecision?: Record<string, unknown>;
    };


export class DirectorActionPipeline {
  readonly reasoningEngine?: DirectorReasoningEngine;
  readonly directorRuntime?: DirectorRuntime;
  readonly actionBuilder: DirectorActionBuilder;
  readonly actionValidator: DirectorActionValidator;
  readonly allowLegacyReasoningEngine: boolean;

  constructor(config: DirectorActionPipelineConfig) {
    this.directorRuntime = config.directorRuntime;
    this.reasoningEngine = config.reasoningEngine;
    this.actionBuilder = config.actionBuilder ?? new DirectorActionBuilder();
    this.actionValidator = config.actionValidator ?? new DirectorActionValidator();
    this.allowLegacyReasoningEngine = config.allowLegacyReasoningEngine ?? false;
  }

  /**
   * Executes the full Director reasoning to validated action envelope pipeline.
   * Authoritative production flow uses P27 DirectorRuntime.
   *
   * @throws DirectorRuntimeUnavailableError if DirectorRuntime is not configured
   * @throws DirectorRuntimeError | DirectorLlmRequestFailedError if DirectorRuntime reasoning fails
   * @throws DirectorActionValidationError | DirectorActionStaleContextError if validation fails
   */
  async execute(
    input: RunDirectorActionPipelineInput
  ): Promise<DirectorActionPipelineResult> {
    // 1. Authoritative path: DirectorRuntime (P27)
    if (this.directorRuntime) {
      const trigger = (input as any).trigger ?? (input.taskId ? 'TASK_READY' : 'PERIODIC_REVIEW');
      const reasoningResult = await this.directorRuntime.reason({
        projectId: input.snapshot.projectId,
        directorSessionId: input.snapshot.directorSessionId,
        trigger,
        snapshot: input.snapshot,
        objective: input.userInstructions,
        taskId: input.taskId,
      });

      // 2. Build Structured Action Envelope directly from typed DirectorAction & Snapshot
      const envelope = this.actionBuilder.buildEnvelope({
        action: reasoningResult.action,
        snapshot: input.snapshot,
        idempotencyKey: input.idempotencyKey,
        cycleId: input.cycleId,
        explicitActionType: input.explicitActionType,
        customPayload: input.customPayload,
      });

      // 3. Construct Validation Context from Snapshot
      const understandingRevision =
        (typeof input.snapshot.sectionMetadata?.requirements?.revision === 'number' &&
          input.snapshot.sectionMetadata.requirements.revision > 0)
          ? input.snapshot.sectionMetadata.requirements.revision
          : (reasoningResult.action.basedOnUnderstandingRevision ?? 1);

      const validationContext: DirectorActionValidationContext = {
        currentFingerprint: input.snapshot.logicalFingerprint,
        currentUnderstandingRevision: understandingRevision,
        currentDirectorSessionId: input.snapshot.directorSessionId,
        currentProjectId: input.snapshot.projectId,
        existingTasks: input.existingTasks,
      };

      // 4. Validate Action Envelope Semantics and Idempotency
      const validationResult = await this.actionValidator.validateAsync(envelope, validationContext);

      return {
        success: true,
        reasoningResult,
        envelope,
        validationResult,
        isDuplicate: validationResult.isDuplicate,
      };
    }

    // 2. Explicit test-only legacy fallback path: DirectorReasoningEngine
    if (this.allowLegacyReasoningEngine && this.reasoningEngine) {
      const reasoningResult = await this.reasoningEngine.reason(input as any);

      const envelope = this.actionBuilder.buildEnvelope({
        decision: reasoningResult.decision,
        snapshot: input.snapshot,
        idempotencyKey: input.idempotencyKey,
        cycleId: input.cycleId,
        explicitActionType: input.explicitActionType,
        customPayload: input.customPayload,
      });

      const understandingRevision =
        (typeof input.snapshot.sectionMetadata?.requirements?.revision === 'number' &&
          input.snapshot.sectionMetadata.requirements.revision > 0)
          ? input.snapshot.sectionMetadata.requirements.revision
          : (reasoningResult.decision.basedOnUnderstandingRevision ?? 1);

      const validationContext: DirectorActionValidationContext = {
        currentFingerprint: input.snapshot.logicalFingerprint,
        currentUnderstandingRevision: understandingRevision,
        currentDirectorSessionId: input.snapshot.directorSessionId,
        currentProjectId: input.snapshot.projectId,
        existingTasks: input.existingTasks,
      };

      const validationResult = await this.actionValidator.validateAsync(envelope, validationContext);

      return {
        success: true,
        reasoningResult,
        envelope,
        validationResult,
        isDuplicate: validationResult.isDuplicate,
      };
    }

    throw new DirectorRuntimeUnavailableError(
      'DirectorActionPipeline: Authoritative DirectorRuntime is not configured. Legacy reasoning fallback is prohibited in production execution.',
      {
        hasRuntime: Boolean(this.directorRuntime),
        hasReasoningEngine: Boolean(this.reasoningEngine),
        allowLegacyReasoningEngine: this.allowLegacyReasoningEngine,
      }
    );
  }
}
