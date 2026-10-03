/**
 * @file director-action-types.ts
 * @description Strongly-typed domain models, protocol constants, and Zod schemas
 * for the Structured Director Action Protocol (Phase 2 TASK-P19-01).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. DIRECTOR ACTION IS A PROPOSAL, NOT EXECUTION AUTHORITY: An action produced by
 *    the Director agent is an intent proposal. It does NOT convey execution authority.
 * 2. STRICT ACTOR BOUNDARY (NO PO IMPERSONATION): The actor must strictly be 'DIRECTOR'
 *    with actorRole 'DIRECTOR'. Any action claiming 'PRODUCT_OWNER' or attempting
 *    self-authorization is rejected immediately.
 * 3. FAIL-CLOSED CONTEXT FRESHNESS: Actions MUST bind to the exact context fingerprint
 *    and understanding revision. Stale actions fail closed.
 * 4. IDEMPOTENCY: Duplicate actions with identical content return cached results;
 *    duplicate keys with conflicting payloads are strictly rejected.
 * 5. DAG INTEGRITY: Task creation, corrective tasks, and implementation proposals
 *    must preserve DAG lineage and acyclicity without bypassing TaskDagEngine.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const DIRECTOR_ACTION_PROTOCOL_VERSION = 'P19-01';
export const DIRECTOR_ACTION_SCHEMA_VERSION = 1;
export const DIRECTOR_ACTION_ACTOR = 'DIRECTOR' as const;
export const DIRECTOR_ACTION_ACTOR_ROLE = 'DIRECTOR' as const;

export const DIRECTOR_ACTION_TYPES = [
  'IMPLEMENT_TASK',
  'CREATE_TASK',
  'CREATE_CORRECTIVE_TASK',
  'REPLAN',
  'REVIEW_EVIDENCE',
  'REQUEST_HUMAN_DECISION',
  'PROJECT_COMPLETE',
  'PAUSE',
  'STOP',
] as const;

export type DirectorActionType = (typeof DIRECTOR_ACTION_TYPES)[number];

// ============================================================================
// 2. ACTION PAYLOAD SCHEMAS & TYPES
// ============================================================================

/**
 * IMPLEMENT_TASK: Director proposes executing a specific ready task from the DAG.
 */
export const ImplementTaskPayloadSchema = z
  .object({
    taskId: z.string().min(1, 'taskId is required'),
    expectedTaskRevision: z.number().int().positive().optional(),
    executionPlan: z.string().min(1, 'executionPlan is required'),
    inputContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ImplementTaskPayload = z.infer<typeof ImplementTaskPayloadSchema>;

/**
 * CREATE_TASK: Director proposes adding a new forward task to the DAG.
 */
export const CreateTaskPayloadSchema = z
  .object({
    title: z.string().min(1, 'title is required'),
    description: z.string().min(1, 'description is required'),
    parentTaskId: z.string().optional(),
    dependencies: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).min(1, 'At least one acceptance criterion is required'),
    estimatedTokens: z.number().int().nonnegative().optional(),
    category: z.enum(['ARCHITECTURE', 'IMPLEMENTATION', 'TEST', 'REFACTOR', 'DOCS']).default('IMPLEMENTATION'),
  })
  .strict();

export type CreateTaskPayload = z.infer<typeof CreateTaskPayloadSchema>;

/**
 * CREATE_CORRECTIVE_TASK: Director proposes a corrective task after an execution failure.
 */
export const CreateCorrectiveTaskPayloadSchema = z
  .object({
    parentTaskId: z.string().min(1, 'parentTaskId is required'),
    failedTaskId: z.string().min(1, 'failedTaskId is required'),
    failureReason: z.string().min(1, 'failureReason is required'),
    remediationType: z.enum(['CODE_FIX', 'TEST_ADJUSTMENT', 'CONFIG_REPAIR', 'DEPENDENCY_FIX', 'ROLLBACK_REPAIR']),
    correctivePlan: z.string().min(1, 'correctivePlan is required'),
    targetFiles: z.array(z.string()).optional(),
  })
  .strict();

export type CreateCorrectiveTaskPayload = z.infer<typeof CreateCorrectiveTaskPayloadSchema>;

/**
 * REPLAN: Director proposes reorganizing or reprioritizing tasks in the DAG.
 */
export const ReplanPayloadSchema = z
  .object({
    replanReason: z.string().min(1, 'replanReason is required'),
    affectedTaskIds: z.array(z.string()).min(1, 'At least one affectedTaskId is required'),
    proposedModifications: z.array(
      z.object({
        taskId: z.string().min(1),
        action: z.enum(['CANCEL', 'DEFER', 'UPDATE_DEPENDENCIES', 'SPLIT']),
        newDependencies: z.array(z.string()).optional(),
        justification: z.string().min(1),
      })
    ),
  })
  .strict();

export type ReplanPayload = z.infer<typeof ReplanPayloadSchema>;

/**
 * REVIEW_EVIDENCE: Director reviews evidence produced by Executor/Verification and records assessment.
 */
export const ReviewEvidencePayloadSchema = z
  .object({
    taskId: z.string().min(1, 'taskId is required'),
    evidenceIds: z.array(z.string()).min(1, 'At least one evidenceId is required'),
    verdict: z.enum(['VERIFIED_SUCCESS', 'INCONCLUSIVE', 'REJECTED_FAILURE']),
    findings: z.string().min(1, 'findings is required'),
    suggestedRemediation: z.string().optional(),
  })
  .strict();

export type ReviewEvidencePayload = z.infer<typeof ReviewEvidencePayloadSchema>;

/**
 * REQUEST_HUMAN_DECISION: Director requests explicit human decision or approval from Product Owner.
 */
export const RequestHumanDecisionPayloadSchema = z
  .object({
    decisionId: z.string().min(1, 'decisionId is required'),
    question: z.string().min(1, 'question is required'),
    options: z.array(z.string()).min(2, 'At least two options are required'),
    recommendedOption: z.string().optional(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
    affectedAreas: z.array(z.string()).default([]),
  })
  .strict();

export type RequestHumanDecisionPayload = z.infer<typeof RequestHumanDecisionPayloadSchema>;

/**
 * LIFECYCLE PAYLOAD: PAUSE, STOP, or PROJECT_COMPLETE.
 */
export const LifecyclePayloadSchema = z
  .object({
    reason: z.string().min(1, 'reason is required'),
    saveCheckpoint: z.boolean().default(true),
    summary: z.string().optional(),
  })
  .strict();

export type LifecyclePayload = z.infer<typeof LifecyclePayloadSchema>;

// ============================================================================
// 3. ACTION ENVELOPE SCHEMA
// ============================================================================

export const DirectorActionEnvelopeZodSchema = z
  .object({
    protocolVersion: z.literal(DIRECTOR_ACTION_PROTOCOL_VERSION),
    schemaVersion: z.literal(DIRECTOR_ACTION_SCHEMA_VERSION).default(DIRECTOR_ACTION_SCHEMA_VERSION),
    actionId: z.string().min(1, 'actionId is required'),
    idempotencyKey: z.string().min(1, 'idempotencyKey is required'),
    projectId: z.string().min(1, 'projectId is required'),
    directorSessionId: z.string().min(1, 'directorSessionId is required'),
    cycleId: z.string().optional(),
    basedOnContextFingerprint: z.string().min(1, 'basedOnContextFingerprint is required'),
    understandingRevision: z.number().int().positive('understandingRevision must be a positive integer'),
    actionType: z.enum(DIRECTOR_ACTION_TYPES),
    actor: z.literal(DIRECTOR_ACTION_ACTOR),
    actorRole: z.literal(DIRECTOR_ACTION_ACTOR_ROLE),
    timestamp: z.string().min(1, 'timestamp is required'),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type DirectorActionEnvelope<T = Record<string, unknown>> = z.infer<
  typeof DirectorActionEnvelopeZodSchema
> & {
  payload: T;
};

// ============================================================================
// 4. DETERMINISTIC ACTION ID GENERATION
// ============================================================================

/**
 * Computes deterministic actionId: act-<sha256(projectId:directorSessionId:actionType:idempotencyKey)[:16]>
 */
export function computeDeterministicActionId(params: {
  projectId: string;
  directorSessionId: string;
  actionType: DirectorActionType;
  idempotencyKey: string;
}): string {
  const raw = `${params.projectId}:${params.directorSessionId}:${params.actionType}:${params.idempotencyKey}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
  return `act-${hash}`;
}

/**
 * Computes deterministic hash of action payload for idempotency conflict detection.
 */
export function computePayloadHash(payload: unknown): string {
  const serialized = JSON.stringify(payload, Object.keys(payload as any).sort());
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

// ============================================================================
// 5. ACTION DISPATCH MODELS & CONSTANTS
// ============================================================================

export const ActionDispatchStatus = {
  AUTHORIZED_PENDING_EXECUTION: 'AUTHORIZED_PENDING_EXECUTION',
  PENDING_AUTHORIZATION: 'PENDING_AUTHORIZATION',
  REJECTED: 'REJECTED',
  DUPLICATE: 'DUPLICATE',
} as const;

export type ActionDispatchStatus =
  (typeof ActionDispatchStatus)[keyof typeof ActionDispatchStatus];

export interface ActionDispatchResult {
  readonly dispatchId: string;
  readonly actionId: string;
  readonly actionType: DirectorActionType;
  readonly status: ActionDispatchStatus;
  readonly isAuthorized: boolean;
  readonly requiresHumanApproval: boolean;
  readonly reason: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly executionIntentId?: string;
  readonly stagedTaskId?: string;
  readonly dispatchedAt: string;
}

