/**
 * @file director-reasoning-types.ts
 * @description Types and contracts for the Director Reasoning Runtime (TASK-P18-02).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Establishes typed LLM reasoning contracts for the Director agent.
 * 2. Director reasoning NEVER grants development authorization (Product Owner approval required).
 * 3. Director reasoning NEVER conveys implementation authority (hasImplementationAuthority strictly false).
 * 4. Model output must strictly conform to the defined JSON decision schema.
 * 5. Fail-closed: No silent mock fallback in production.
 * 6. Model decisions must never be routed directly to Driver without authorization and decision engine validation.
 */

import { z } from 'zod';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';
import {
  type DirectorDecisionType,
  type DirectorDecisionValidationResult,
  DIRECTOR_DECISION_TYPES,
} from '../director/director-decision-types.js';
import type { DirectorDecisionEngine } from '../director/director-decision-engine.js';
import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import type { LlmProviderRegistry } from '../llm-bridge/llm-registry.js';
import type { LlmJsonSchema, LlmMessage } from '../llm-bridge/llm-types.js';
import type { TokenTelemetry } from '../token-budget/budget-types.js';
import type { DirectorPromptBuilder } from './director-prompt-builder.js';
import type { DirectorResponseParser } from './director-response-parser.js';

// ============================================================================
// 1. JSON DECISION CONTRACT & SCHEMA
// ============================================================================

export const DIRECTOR_REASONING_JSON_SCHEMA: LlmJsonSchema = {
  name: 'director_decision',
  description: 'Authoritative structured Director decision contract for AIDM',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      decisionType: {
        type: 'string',
        enum: [
          'REQUEST_CLARIFICATION',
          'ACCEPT_CONTEXT',
          'REJECT_CONTEXT',
          'REQUEST_PLANNING',
          'DEFER',
          'BLOCK',
          'RESUME',
          'IMPLEMENT_TASK',
        ],
        description: 'The authoritative typed decision from the Director.',
      },
      rationale: {
        type: 'string',
        description: 'Detailed technical rationale and justification for this decision.',
      },
      basedOnContextFingerprint: {
        type: 'string',
        description: 'The exact logical fingerprint of the context snapshot this decision is based on.',
      },
      selectedTaskId: {
        type: ['string', 'null'],
        description: 'Task ID to implement or clarify, if applicable.',
      },
      suggestedNextAction: {
        type: ['string', 'null'],
        description: 'Recommended next action or guidance for the orchestrator.',
      },
      metadata: {
        type: 'object',
        description: 'Optional additional metadata for the decision.',
      },
    },
    required: ['decisionType', 'rationale', 'basedOnContextFingerprint'],
    additionalProperties: false,
  },
};

export const DirectorDecisionContractZodSchema = z
  .object({
    decisionType: z.enum(DIRECTOR_DECISION_TYPES),
    rationale: z.string().min(1, 'Rationale must not be empty'),
    basedOnContextFingerprint: z
      .string()
      .min(1, 'basedOnContextFingerprint must not be empty'),
    selectedTaskId: z.string().nullable().optional(),
    suggestedNextAction: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type DirectorDecisionContract = z.infer<
  typeof DirectorDecisionContractZodSchema
>;

// ============================================================================
// 2. PARSED DECISION DOMAIN MODEL
// ============================================================================

export interface ParsedDirectorDecision {
  readonly decisionType: DirectorDecisionType;
  readonly rationale: string;
  readonly basedOnContextFingerprint: string;
  readonly selectedTaskId?: string | null;
  readonly suggestedNextAction?: string | null;
  readonly basedOnApprovalRevision?: number | null;
  readonly basedOnUnderstandingRevision?: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** INVARIANT: Model is strictly DIRECTOR actor, never USER or EXECUTOR */
  readonly actor: 'DIRECTOR';
  /** INVARIANT: Model decision NEVER conveys implementation authority */
  readonly hasImplementationAuthority: false;
}

// ============================================================================
// 3. PROMPT BUILDER TYPES
// ============================================================================

export const DEFAULT_HARD_MAX_PROMPT_TOKENS = 16384;
export const DEFAULT_MAX_FIELD_LENGTH_CHARS = 2000;

export interface DirectorPromptBudgetOptions {
  /** Maximum number of requirements to retain in prompt (defaults to 50) */
  readonly maxRequirements?: number;
  /** Maximum number of decisions to retain in prompt (defaults to 30) */
  readonly maxDecisions?: number;
  /** Maximum number of tasks to retain in prompt (defaults to 50) */
  readonly maxTasks?: number;
  /** Maximum character length for any single text field before deterministic truncation (defaults to 2000) */
  readonly maxFieldLength?: number;
  /** Mandatory hard limit on overall estimated prompt tokens (defaults to 16384) */
  readonly hardMaxPromptTokens?: number;
  /** Optional custom token budget (cannot exceed hardMaxPromptTokens) */
  readonly tokenBudget?: number;
  /** Known context window limit of the underlying LLM provider */
  readonly providerContextWindow?: number;
  /** Fail closed if mandatory P0 context or total prompt exceeds budget (defaults to true) */
  readonly throwOnBudgetExceeded?: boolean;
}

export interface DirectorPromptAuditMetadata {
  readonly requirementsTotal: number;
  readonly requirementsIncluded: number;
  readonly requirementsPruned: readonly string[];
  readonly decisionsTotal: number;
  readonly decisionsIncluded: number;
  readonly decisionsPruned: readonly string[];
  readonly tasksTotal: number;
  readonly tasksIncluded: number;
  readonly tasksPruned: readonly string[];
  /** List of field names/paths that were deterministically truncated due to exceeding maxFieldLength */
  readonly truncatedFields: readonly string[];
  /** Estimated token count of the assembled prompt */
  readonly estimatedTokens: number;
  /** Applied hard maximum token limit */
  readonly hardMaxPromptTokens: number;
  readonly wasPruned: boolean;
}

export interface DirectorPromptOptions {
  readonly systemInstructions?: string;
  readonly userInstructions?: string;
  readonly correlationId?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly budgetOptions?: DirectorPromptBudgetOptions;
}

export interface DirectorPromptBuildResult {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly messages: readonly LlmMessage[];
  readonly contextFingerprint: string;
  readonly directorSessionId: string;
  readonly projectId: string;
  readonly jsonSchema: LlmJsonSchema;
  readonly auditMetadata: DirectorPromptAuditMetadata;
}

// ============================================================================
// 4. PARSER TYPES
// ============================================================================

export interface ParseDirectorResponseParams {
  /** Raw text content returned by LLM */
  readonly content: string;
  /** Optional pre-parsed structured output returned by provider */
  readonly structuredOutput?: unknown;
  /** Active snapshot for context fingerprint and session verification */
  readonly snapshot?: DirectorContextSnapshot;
  /** Expected logical context fingerprint */
  readonly expectedFingerprint?: string;
  /** Optional DecisionEngine for running authoritative validation */
  readonly decisionEngine?: DirectorDecisionEngine;
  /** Whether to run validation through DirectorDecisionEngine */
  readonly validateThroughDecisionEngine?: boolean;
  /** Preserved token telemetry usage from provider response */
  readonly usage?: TokenTelemetry;
}

export interface ParseDirectorResponseResult {
  readonly decision: ParsedDirectorDecision;
  readonly validationResult?: DirectorDecisionValidationResult;
}

// ============================================================================
// 5. ENGINE CONFIGURATION & REASONING TYPES
// ============================================================================

export interface DirectorReasoningEngineConfig {
  /** Explicit LLM provider instance */
  readonly provider?: LLMProvider;
  /** Injected LLM provider registry */
  readonly providerRegistry?: LlmProviderRegistry;
  /** Provider identifier to resolve from registry or instantiate */
  readonly providerId?: string;
  /** Target model identifier */
  readonly model?: string;
  /** Default timeout in milliseconds (defaults to 30000) */
  readonly defaultTimeoutMs?: number;
  /** Operational mode: 'production' | 'development' | 'test' (defaults to 'production') */
  readonly mode?: 'production' | 'development' | 'test';
  /** Whether mock transport is explicitly permitted in test/development mode */
  readonly allowMockInDevelopment?: boolean;
  /** Target endpoint URI for real HTTP LLM transport */
  readonly endpoint?: string;
  /** API key for provider (never logged or exposed) */
  readonly apiKey?: string | null;
  /** Custom auth header name */
  readonly authHeaderName?: string;
  /** Custom auth header prefix */
  readonly authHeaderPrefix?: string;
  /** Custom prompt builder */
  readonly promptBuilder?: DirectorPromptBuilder;
  /** Custom response parser */
  readonly responseParser?: DirectorResponseParser;
  /** DecisionEngine for validating decisions */
  readonly decisionEngine?: DirectorDecisionEngine;
  /** Project/workspace root */
  readonly workspaceRoot?: string;
  /** Optional Persistent Budget Manager to enforce pre-dispatch validation and reconciliation */
  readonly budgetManager?: unknown;
}

export interface DirectorReasoningInput {
  /** Mandatory DirectorContextSnapshot input */
  readonly snapshot: DirectorContextSnapshot;
  /** Optional custom correlation ID */
  readonly correlationId?: string;
  /** Abort signal for cancellation */
  readonly signal?: AbortSignal;
  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;
  /** Additional user guidance or instructions */
  readonly userInstructions?: string;
  /** Arbitrary metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Whether to validate the resulting decision through DirectorDecisionEngine */
  readonly validateThroughDecisionEngine?: boolean;
}

export interface DirectorReasoningResult {
  readonly success: boolean;
  readonly decision: ParsedDirectorDecision;
  readonly validationResult?: DirectorDecisionValidationResult;
  readonly rawResponse: string;
  readonly correlationId: string;
  readonly providerId: string;
  readonly model: string;
  readonly usage: TokenTelemetry;
  readonly latencyMs: number;
  readonly isMock: boolean;
}
