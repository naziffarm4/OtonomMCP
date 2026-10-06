/**
 * @file director-action-schema.ts
 * @description Authoritative Zod validation schemas for the Director Action Contract (Phase 26 P26).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly validates the DirectorAction discriminated union by `actionType`.
 * 2. Rejects path traversal and malformed action IDs fail-closed.
 * 3. Rejects negative or out-of-bounds confidence values (strictly 0..1).
 * 4. Invariant: DECLARE_PROJECT_COMPLETE must require finalVerificationRequested: true.
 * 5. Invariant: REQUEST_HUMAN_DECISION must require blocking: true.
 * 6. Invariant: Action never grants implementation authority; no authority field can spoof execution.
 */

import { z } from 'zod';
import { DirectorSessionIdZodSchema } from './director-types.js';
import {
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_SCHEMA_VERSION,
  DIRECTOR_ACTION_TYPES,
} from './director-action-types.js';

// ============================================================================
// 1. ACTION ID VALIDATION SCHEMA
// ============================================================================

const ACTION_ID_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

export const DirectorActionIdZodSchema = z
  .string({ message: 'actionId is required' })
  .min(3, 'actionId must have at least 3 characters')
  .max(128, 'actionId must have at most 128 characters')
  .regex(
    ACTION_ID_REGEX,
    'actionId must only contain alphanumeric characters, underscores, dashes, and periods'
  )
  .refine(
    (id) => !id.includes('..') && !id.includes('/') && !id.includes('\\'),
    'actionId cannot contain path traversal sequences'
  );

// ============================================================================
// 2. COMMON ACTION ENVELOPE SCHEMA
// ============================================================================

export const DirectorActionEnvelopeZodSchema = z.object({
  protocolVersion: z.literal(DIRECTOR_ACTION_PROTOCOL_VERSION),
  schemaVersion: z.literal(DIRECTOR_ACTION_SCHEMA_VERSION),
  actionId: DirectorActionIdZodSchema,
  directorSessionId: DirectorSessionIdZodSchema,
  projectId: z.string().min(1, 'projectId cannot be empty'),
  actionType: z.enum(DIRECTOR_ACTION_TYPES),
  basedOnContextFingerprint: z.string().min(1, 'basedOnContextFingerprint cannot be empty'),
  basedOnUnderstandingRevision: z.number().int().nonnegative().nullable().optional(),
  basedOnApprovalRevision: z.number().int().nonnegative().nullable().optional(),
  rationale: z.string().min(1, 'rationale cannot be empty'),
  confidence: z
    .number({ message: 'confidence is required and must be a number' })
    .min(0, 'confidence must be >= 0')
    .max(1, 'confidence must be <= 1'),
  expectedOutcome: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// 3. ACTION-SPECIFIC SCHEMAS
// ============================================================================

// --- Understanding Action Schemas ---

export const AnalyzeProjectActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('ANALYZE_PROJECT'),
  analysisScope: z.string().optional(),
});

export const DiscoverProjectActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('DISCOVER_PROJECT'),
  discoveryScope: z.string().optional(),
});

export const RequestClarificationActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REQUEST_CLARIFICATION'),
  question: z.string().min(1, 'question cannot be empty'),
  reason: z.string().min(1, 'reason cannot be empty'),
  blocking: z.boolean(),
  options: z
    .array(
      z.object({
        id: z.string().min(1, 'option id cannot be empty'),
        label: z.string().min(1, 'option label cannot be empty'),
      })
    )
    .optional(),
});

export const AcceptContextActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('ACCEPT_CONTEXT'),
  contextScope: z.string().optional(),
});

export const RejectContextActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REJECT_CONTEXT'),
  reason: z.string().optional(),
});

// --- Planning Action Schemas ---

export const RequestPlanningActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REQUEST_PLANNING'),
  planningScope: z.string().optional(),
});

export const SelectTaskActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('SELECT_TASK'),
  taskId: z.string().optional(),
});

export const UpdatePlanActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('UPDATE_PLAN'),
  planSummary: z.string().optional(),
});

export const ReplanActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REPLAN'),
  reason: z.string().min(1, 'reason cannot be empty'),
  affectedTaskIds: z.array(z.string()),
  planningObjective: z.string().min(1, 'planningObjective cannot be empty'),
  constraints: z.array(z.string()),
});

export const DeferActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('DEFER'),
  reason: z.string().optional(),
  taskId: z.string().optional(),
});

// --- Execution Action Schemas ---

export const ImplementTaskActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('IMPLEMENT_TASK'),
  taskId: z.string().min(1, 'taskId cannot be empty'),
  objective: z.string().min(1, 'objective cannot be empty'),
  targetFiles: z.array(z.string()),
  implementationScope: z.string().min(1, 'implementationScope cannot be empty'),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
});

export const RetryTaskActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('RETRY_TASK'),
  taskId: z.string().min(1, 'taskId cannot be empty'),
  previousExecutionId: z.string().min(1, 'previousExecutionId cannot be empty'),
  reason: z.string().min(1, 'reason cannot be empty'),
  correctionStrategy: z.string().optional(),
  acceptanceCriteria: z.array(z.string()),
});

export const CorrectTaskActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('CORRECT_TASK'),
  taskId: z.string().min(1, 'taskId cannot be empty'),
  failureAnalysis: z.string().min(1, 'failureAnalysis cannot be empty'),
  correctionPlan: z.string().min(1, 'correctionPlan cannot be empty'),
  targetFiles: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});

// --- Evaluation Action Schemas ---

export const ReviewEvidenceActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REVIEW_EVIDENCE'),
  taskId: z.string().optional(),
  evidenceIds: z.array(z.string()),
  reviewObjective: z.string().min(1, 'reviewObjective cannot be empty'),
});

export const AcceptTaskActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('ACCEPT_TASK'),
  taskId: z.string().min(1, 'taskId cannot be empty'),
  evidenceIds: z.array(z.string()),
  acceptanceRationale: z.string().min(1, 'acceptanceRationale cannot be empty'),
});

export const RejectTaskActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REJECT_TASK'),
  taskId: z.string().min(1, 'taskId cannot be empty'),
  evidenceIds: z.array(z.string()),
  rejectionReason: z.string().min(1, 'rejectionReason cannot be empty'),
});

// --- Control Action Schemas ---

export const BlockActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('BLOCK'),
  reason: z.string().optional(),
});

export const RequestHumanDecisionActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('REQUEST_HUMAN_DECISION'),
  question: z.string().min(1, 'question cannot be empty'),
  reason: z.string().min(1, 'reason cannot be empty'),
  decisionTopic: z.string().optional(),
  options: z.array(z.any()).optional(),
  recommendation: z.string().optional(),
  blocking: z.literal(true),
});

export const ResumeActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('RESUME'),
  resumeReason: z.string().optional(),
});

// --- Completion Action Schema ---

export const DeclareProjectCompleteActionZodSchema = DirectorActionEnvelopeZodSchema.extend({
  actionType: z.literal('DECLARE_PROJECT_COMPLETE'),
  completionRationale: z.string().optional(),
  requirementCoverage: z.array(
    z.object({
      requirementId: z.string().min(1, 'requirementId cannot be empty'),
      satisfied: z.boolean(),
      evidenceIds: z.array(z.string()),
    })
  ).or(z.array(z.any())),
  unresolvedRisks: z.array(z.string()).optional().default([]),
  remainingTasks: z.array(z.string()).optional().default([]),
  finalVerificationRequested: z.literal(true),
  completionChecklist: z.record(z.string(), z.boolean()).optional(),
});

// ============================================================================
// 4. DISCRIMINATED UNION SCHEMA
// ============================================================================

export const DirectorActionZodSchema = z.discriminatedUnion('actionType', [
  AnalyzeProjectActionZodSchema,
  DiscoverProjectActionZodSchema,
  RequestClarificationActionZodSchema,
  AcceptContextActionZodSchema,
  RejectContextActionZodSchema,
  RequestPlanningActionZodSchema,
  SelectTaskActionZodSchema,
  UpdatePlanActionZodSchema,
  ReplanActionZodSchema,
  DeferActionZodSchema,
  ImplementTaskActionZodSchema,
  RetryTaskActionZodSchema,
  CorrectTaskActionZodSchema,
  ReviewEvidenceActionZodSchema,
  AcceptTaskActionZodSchema,
  RejectTaskActionZodSchema,
  BlockActionZodSchema,
  RequestHumanDecisionActionZodSchema,
  ResumeActionZodSchema,
  DeclareProjectCompleteActionZodSchema,
]);
