/**
 * Execution Intent & Authorization Protocol Types (Phase 10 TASK-P10-01)
 *
 * Establishes the strongly typed contract for translating validated Director
 * decisions into verifiable execution intents, ensuring strict adherence to
 * Product Owner authorization boundaries prior to any executor dispatch.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Establishes TYPED EXECUTION INTENT and VALIDATION BOUNDARY only.
 * 2. Director decision NEVER substitutes for Product Owner approval.
 * 3. Requires explicit isDevelopmentAuthorized() === true from ApprovalPackageEngine.
 * 4. Strictly bound to canonical project, active Director session, context fingerprint,
 *    authoritative understanding revision, and approval package revision.
 * 5. Strictly bound to a valid, executable Task in the authoritative TaskDagEngine / SpecStore.
 * 6. Does NOT invoke Antigravity, spawn OS processes, or start autonomous loops.
 * 7. Does NOT mutate Task DAG, SpecStore, or DurableStateManager global FSM.
 * 8. Zero parallel authority: reuses existing ApprovalStore, SpecStore, TaskDagEngine,
 *    and DirectorSessionStore.
 */

import { z } from 'zod';
import { DirectorSessionIdZodSchema } from './director-types.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const EXECUTION_INTENT_PROTOCOL_VERSION = 'P10-01';
export const EXECUTION_INTENT_SCHEMA_VERSION = 1;

export const EXECUTION_OPERATION_TYPES = [
  'IMPLEMENT_TASK',
  'EXECUTE_TEST',
  'EXECUTE_BUILD',
  'INSPECT_WORKSPACE',
  'APPLY_REPAIR',
] as const;

export type ExecutionOperationType = (typeof EXECUTION_OPERATION_TYPES)[number];

export const EXECUTION_INTENT_VALIDATION_CODES = [
  'VALID',
  'SESSION_INVALID',
  'SESSION_NOT_ACTIVE',
  'DECISION_INVALID',
  'DECISION_TYPE_INVALID',
  'DECISION_SESSION_MISMATCH',
  'DECISION_PROJECT_MISMATCH',
  'PROJECT_BINDING_MISMATCH',
  'CONTEXT_NOT_FOUND',
  'CONTEXT_STALE',
  'CONTEXT_INCOMPLETE',
  'CONTEXT_FINGERPRINT_MISMATCH',
  'UNDERSTANDING_REVISION_MISMATCH',
  'APPROVAL_NOT_FOUND',
  'APPROVAL_INVALID',
  'APPROVAL_NOT_AUTHORIZED',
  'APPROVAL_REVISION_MISMATCH',
  'APPROVAL_PROJECT_MISMATCH',
  'TASK_NOT_FOUND',
  'TASK_PROJECT_MISMATCH',
  'TASK_STATE_INVALID',
  'TASK_REVISION_MISMATCH',
  'VALIDATION_ERROR',
  'SECURITY_VIOLATION',
] as const;

export type ExecutionIntentValidationCode =
  (typeof EXECUTION_INTENT_VALIDATION_CODES)[number];

// ============================================================================
// 2. DOMAIN MODEL
// ============================================================================

export interface ExecutionIntent {
  /** Deterministic identifier for this execution intent */
  readonly intentId: string;
  /** Bound Director session identifier */
  readonly directorSessionId: string;
  /** Triggering Director decision identifier */
  readonly directorDecisionId: string;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Task identifier from TaskDagEngine / SpecStore */
  readonly taskId: string;
  /** Expected task revision / attempt counter */
  readonly taskRevision: number;
  /** Logical fingerprint of the non-stale context snapshot */
  readonly contextFingerprint: string;
  /** Authoritative understanding revision baseline */
  readonly understandingRevision: number;
  /** Bound human approval package revision */
  readonly approvalPackageRevision: number;
  /** Intended executor operation */
  readonly operationType: ExecutionOperationType;
  /** Protocol version string (P10-01) */
  readonly protocolVersion: string;
  /** Schema version integer */
  readonly schemaVersion: number;
  /** ISO 8601 timestamp when intent was formulated/validated */
  readonly createdAt: string;
  /** Optional sanitized metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ValidateExecutionIntentInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly directorDecisionId: string;
  readonly taskId: string;
  readonly taskRevision?: number | null;
  readonly contextFingerprint: string;
  readonly understandingRevision?: number | null;
  readonly approvalPackageRevision?: number | null;
  readonly operationType?: ExecutionOperationType;
  readonly intentId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutionIntentValidationResult {
  readonly isValid: boolean;
  readonly code: ExecutionIntentValidationCode;
  readonly message: string;
  readonly intent?: ExecutionIntent;
  readonly verifiedBindings?: {
    readonly projectId: string;
    readonly directorSessionId: string;
    readonly directorDecisionId: string;
    readonly taskId: string;
    readonly taskRevision: number;
    readonly contextFingerprint: string;
    readonly understandingRevision: number;
    readonly approvalPackageRevision: number;
  };
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 3. ZOD VALIDATION SCHEMAS
// ============================================================================

export const ExecutionOperationTypeZodSchema = z.enum(EXECUTION_OPERATION_TYPES);

export const ValidateExecutionIntentInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema,
  directorDecisionId: z.string().min(1, 'directorDecisionId is required'),
  taskId: z.string().min(1, 'taskId is required'),
  taskRevision: z.number().int().nonnegative('taskRevision must be a non-negative integer').nullable().optional(),
  contextFingerprint: z.string().min(1, 'contextFingerprint is required'),
  understandingRevision: z.number().int().nonnegative('understandingRevision must be a non-negative integer').nullable().optional(),
  approvalPackageRevision: z.number().int().positive('approvalPackageRevision must be a positive integer').nullable().optional(),
  operationType: ExecutionOperationTypeZodSchema.optional(),
  intentId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ExecutionIntentZodSchema = z.object({
  intentId: z.string().min(1),
  directorSessionId: DirectorSessionIdZodSchema,
  directorDecisionId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  contextFingerprint: z.string().min(1),
  understandingRevision: z.number().int().nonnegative(),
  approvalPackageRevision: z.number().int().positive(),
  operationType: ExecutionOperationTypeZodSchema,
  protocolVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ExecutionIntentValidationResultZodSchema = z.object({
  isValid: z.boolean(),
  code: z.enum(EXECUTION_INTENT_VALIDATION_CODES),
  message: z.string(),
  intent: ExecutionIntentZodSchema.optional(),
  verifiedBindings: z
    .object({
      projectId: z.string(),
      directorSessionId: z.string(),
      directorDecisionId: z.string(),
      taskId: z.string(),
      taskRevision: z.number(),
      contextFingerprint: z.string(),
      understandingRevision: z.number(),
      approvalPackageRevision: z.number(),
    })
    .optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
