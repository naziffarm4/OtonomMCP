/**
 * Clarification Protocol Domain Types & Contracts (Phase 8 TASK-P8-04)
 *
 * Defines the structured, typed domain model for project clarification:
 * - Uncertainty classification: CLEAR, AMBIGUOUS, CONTRADICTORY, MISSING, INSUFFICIENT_EVIDENCE
 * - Clarification questions & items with evidence traceability
 * - Clarification answers & answer validation
 * - Clarification sessions and bounded protocol lifecycle
 * - Deterministic priority rankings and blocking rules
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. The system must NEVER silently resolve ambiguous project intent.
 * 2. Does NOT make product decisions, resolve user intent, or approve requirements.
 * 3. Inferences are never converted into requirements.
 * 4. Human answers are clarification results, NOT direct mutations to requirements/decisions.
 * 5. Does NOT create a second global state machine or replace AIDM FSM.
 * 6. Evidence references are strictly preserved from discovery without fabrication.
 */

import { z } from 'zod';
import type {
  EvidenceReference,
  DiscoveryUnknown,
  DiscoveryContradictionSource,
} from '../discovery/discovery-types.js';

// ============================================================================
// 1. UNCERTAINTY CLASSIFICATION
// ============================================================================

export const UNCERTAINTY_TYPES = [
  'CLEAR',
  'AMBIGUOUS',
  'CONTRADICTORY',
  'MISSING',
  'INSUFFICIENT_EVIDENCE',
] as const;

export type UncertaintyType = (typeof UNCERTAINTY_TYPES)[number];

// ============================================================================
// 2. CLARIFICATION STATUS, KIND & PRIORITY
// ============================================================================

export const CLARIFICATION_STATUSES = [
  'OPEN',
  'ANSWERED',
  'DEFERRED',
  'BLOCKED',
  'NEEDS_FOLLOWUP',
] as const;

export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

export const CLARIFICATION_KINDS = [
  'MISSING_REQUIREMENT',
  'AMBIGUOUS_REQUIREMENT',
  'CONTRADICTORY_REQUIREMENT',
  'UNKNOWN_PRODUCT_INTENT',
  'CONFLICTING_DOCUMENTATION',
  'CONFLICTING_IMPLEMENTATION',
  'UNCLEAR_ENTRYPOINT',
  'UNCLEAR_RUNTIME_BEHAVIOR',
  'OTHER',
] as const;

export type ClarificationKind = (typeof CLARIFICATION_KINDS)[number];

export const CLARIFICATION_PRIORITIES = ['REQUIRED', 'IMPORTANT', 'OPTIONAL'] as const;

export type ClarificationPriority = (typeof CLARIFICATION_PRIORITIES)[number];

// ============================================================================
// 3. EVIDENCE & TRACEABILITY
// ============================================================================

export interface FindingReference {
  readonly id: string;
  readonly type: 'fact' | 'observation' | 'inference' | 'unknown' | 'contradiction' | 'candidate';
  readonly summary?: string;
}

export interface ClarificationContradictionPair {
  readonly contradictionId: string;
  readonly category: string;
  readonly description: string;
  readonly sourceA: DiscoveryContradictionSource;
  readonly sourceB: DiscoveryContradictionSource;
}

// ============================================================================
// 4. USER ANSWERS
// ============================================================================

export const CLARIFICATION_ANSWER_STATUSES = [
  'ANSWERED',
  'DEFERRED',
  'REJECTED',
  'NEEDS_FOLLOWUP',
] as const;

export type ClarificationAnswerStatus = (typeof CLARIFICATION_ANSWER_STATUSES)[number];

export const CLARIFICATION_ANSWER_TYPES = [
  'OPTION_SELECTION',
  'FREE_FORM',
  'DEFERRED',
  'REJECTED',
] as const;

export type ClarificationAnswerType = (typeof CLARIFICATION_ANSWER_TYPES)[number];

export interface ClarificationAnswer {
  readonly clarificationId: string;
  readonly answerType: ClarificationAnswerType;
  readonly selectedOptions?: readonly string[];
  readonly freeFormResponse?: string;
  readonly timestamp: string;
  readonly source: 'HUMAN';
  readonly status: ClarificationAnswerStatus;
  readonly followUpReason?: string;
  readonly notes?: string;
}

export interface ClarificationAnswerInput {
  readonly clarificationId: string;
  readonly answerType?: ClarificationAnswerType;
  readonly selectedOptions?: readonly string[];
  readonly freeFormResponse?: string;
  readonly source: 'HUMAN';
  readonly status?: ClarificationAnswerStatus;
  readonly followUpReason?: string;
  readonly notes?: string;
}

// ============================================================================
// 5. CLARIFICATION QUESTION
// ============================================================================

export interface ClarificationQuestion {
  readonly clarificationId: string;
  readonly kind: ClarificationKind;
  readonly priority: ClarificationPriority;
  readonly question: string;
  readonly context: string;
  readonly reason: string;
  readonly evidence: readonly EvidenceReference[];
  readonly relatedDiscoveryFinding?: FindingReference;
  readonly contradictionPair?: ClarificationContradictionPair;
  readonly options?: readonly string[];
  readonly allowsFreeFormAnswer: boolean;
  readonly status: ClarificationStatus;
  readonly blocking: boolean;
  readonly uncertaintyType: UncertaintyType;
  readonly createdAt: string;
  readonly answer?: ClarificationAnswer;
  readonly parentClarificationId?: string;
  readonly followUpClarificationIds?: readonly string[];
}

// ============================================================================
// 6. CLARIFICATION SESSION
// ============================================================================

export const CLARIFICATION_SESSION_STATUSES = [
  'OPEN',
  'WAITING_FOR_HUMAN',
  'PARTIALLY_RESOLVED',
  'RESOLVED',
  'BLOCKED',
] as const;

export type ClarificationSessionStatus = (typeof CLARIFICATION_SESSION_STATUSES)[number];

export interface ClarificationSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly sourceDiscoveryReference: string;
  readonly questions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];
  readonly status: ClarificationSessionStatus;
  readonly blockingOpenCount: number;
  readonly totalCount: number;
  readonly resolvedCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 7. AMBIGUITY ANALYSIS RESULT
// ============================================================================

export interface AmbiguityAnalysisResult {
  readonly clearAreas: readonly string[];
  readonly questions: readonly ClarificationQuestion[];
  readonly blockingQuestions: readonly ClarificationQuestion[];
  readonly nonBlockingQuestions: readonly ClarificationQuestion[];
  readonly informationalUnknowns: readonly DiscoveryUnknown[];
  readonly summary: {
    readonly totalQuestions: number;
    readonly blockingCount: number;
    readonly nonBlockingCount: number;
    readonly uncertaintyCounts: Readonly<Record<UncertaintyType, number>>;
  };
}

// ============================================================================
// 8. ZOD VALIDATION SCHEMAS
// ============================================================================

export const ClarificationAnswerZodSchema = z.object({
  clarificationId: z.string().min(1, 'clarificationId cannot be empty'),
  answerType: z.enum(CLARIFICATION_ANSWER_TYPES as unknown as [string, ...string[]]).default('OPTION_SELECTION'),
  selectedOptions: z.array(z.string()).optional(),
  freeFormResponse: z.string().optional(),
  timestamp: z.string().min(1, 'timestamp cannot be empty'),
  source: z.literal('HUMAN', { message: 'Source must be strictly HUMAN' }),
  status: z.enum(CLARIFICATION_ANSWER_STATUSES as unknown as [string, ...string[]]).default('ANSWERED'),
  followUpReason: z.string().optional(),
  notes: z.string().optional(),
});

export const ClarificationQuestionZodSchema = z.object({
  clarificationId: z.string().min(1),
  kind: z.enum(CLARIFICATION_KINDS as unknown as [string, ...string[]]),
  priority: z.enum(CLARIFICATION_PRIORITIES as unknown as [string, ...string[]]),
  question: z.string().min(1),
  context: z.string(),
  reason: z.string(),
  evidence: z.array(z.any()),
  relatedDiscoveryFinding: z.object({
    id: z.string(),
    type: z.enum(['fact', 'observation', 'inference', 'unknown', 'contradiction', 'candidate']),
    summary: z.string().optional(),
  }).optional(),
  contradictionPair: z.any().optional(),
  options: z.array(z.string()).optional(),
  allowsFreeFormAnswer: z.boolean(),
  status: z.enum(CLARIFICATION_STATUSES as unknown as [string, ...string[]]),
  blocking: z.boolean(),
  uncertaintyType: z.enum(UNCERTAINTY_TYPES as unknown as [string, ...string[]]),
  createdAt: z.string().min(1),
  answer: ClarificationAnswerZodSchema.optional(),
  parentClarificationId: z.string().optional(),
  followUpClarificationIds: z.array(z.string()).optional(),
});

export const ClarificationSessionZodSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  sourceDiscoveryReference: z.string().min(1),
  questions: z.array(ClarificationQuestionZodSchema),
  answers: z.array(ClarificationAnswerZodSchema),
  status: z.enum(CLARIFICATION_SESSION_STATUSES as unknown as [string, ...string[]]),
  blockingOpenCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  resolvedCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
