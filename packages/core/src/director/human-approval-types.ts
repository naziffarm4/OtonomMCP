/**
 * Human Approval & Resume Protocol Types (Phase 9 TASK-P9-04)
 *
 * Establishes the authoritative, typed domain model for explicit human/Product Owner
 * approvals bound to Director sessions, context snapshots, and understanding revisions,
 * as well as the controlled resume protocol.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Human/Product Owner approval is strictly separated from Director session identity.
 * 2. Approval can ONLY be granted by authorized Human / Product Owner actor (USER or PRODUCT_OWNER).
 * 3. Director (DIRECTOR) CANNOT grant approval; executor (EXECUTOR) / antigravity / system CANNOT approve.
 * 4. Natural-language "tamam", clarification answers, or Director decisions (including RESUME) are NOT approval.
 * 5. Approval is strictly bound to:
 *    - canonical project identity
 *    - active Director session
 *    - synchronized context snapshot fingerprint (logicalFingerprint)
 *    - session understanding revision
 *    - approval package revision
 * 6. Approval is rejected on stale or incomplete context.
 * 7. Duplicate approvals and revision replays are strictly rejected (replay protection).
 * 8. Approval persistence uses the existing authoritative ApprovalStore; no second store.
 * 9. isDevelopmentAuthorized() remains the authoritative authorization check; no second authority.
 * 10. Approval or Resume evaluation does NOT:
 *     - mutate Task DAG or create tasks
 *     - invoke Antigravity execution
 *     - start autonomous loops
 *     - directly transition or mutate DurableStateManager FSM
 * 11. Resume semantics are strictly governed by this P9-04 protocol and require explicit Human approval.
 */

import { z } from 'zod';
import { APPROVAL_ACTOR_ROLES, type ApprovalActorRole, type ProjectApprovalPackage, type ProjectApprovalRecord } from '../approval/approval-types.js';
import { DirectorSessionIdZodSchema, type DirectorSession } from './director-types.js';
import type { DirectorDecision } from './director-decision-types.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const HUMAN_APPROVAL_PROTOCOL_VERSION = 'P9-04';
export const HUMAN_APPROVAL_SCHEMA_VERSION = 1;

export const RESUME_PROTOCOL_VERSION = 'P9-04';
export const RESUME_SCHEMA_VERSION = 1;

export const HUMAN_APPROVAL_VALIDATION_CODES = [
  'VALID',
  'ACTOR_UNAUTHORIZED',
  'INTENT_INVALID',
  'PROJECT_BINDING_MISMATCH',
  'SESSION_INVALID',
  'SESSION_NOT_ACTIVE',
  'CONTEXT_NOT_FOUND',
  'CONTEXT_FINGERPRINT_MISMATCH',
  'CONTEXT_STALE',
  'CONTEXT_INCOMPLETE',
  'UNDERSTANDING_REVISION_MISMATCH',
  'APPROVAL_REVISION_MISMATCH',
  'APPROVAL_ALREADY_DECIDED',
  'PACKAGE_NOT_FOUND',
  'PACKAGE_NOT_READY',
  'SECURITY_VIOLATION',
  'VALIDATION_ERROR',
] as const;

export type HumanApprovalValidationCode = (typeof HUMAN_APPROVAL_VALIDATION_CODES)[number];

export const RESUME_EVALUATION_CODES = [
  'RESUME_AUTHORIZED',
  'RESUME_BLOCKED_NO_APPROVAL',
  'RESUME_BLOCKED_UNAUTHORIZED_ACTOR',
  'RESUME_BLOCKED_SESSION_INACTIVE',
  'RESUME_BLOCKED_CONTEXT_STALE',
  'RESUME_BLOCKED_CONTEXT_INCOMPLETE',
  'RESUME_BLOCKED_CONTEXT_MISMATCH',
  'RESUME_BLOCKED_UNDERSTANDING_MISMATCH',
  'RESUME_BLOCKED_REVISION_MISMATCH',
  'RESUME_BLOCKED_DIRECTOR_DECISION_INSUFFICIENT',
  'PROJECT_BINDING_MISMATCH',
  'VALIDATION_ERROR',
] as const;

export type ResumeEvaluationCode = (typeof RESUME_EVALUATION_CODES)[number];

// ============================================================================
// 2. INPUT & RESULT INTERFACES
// ============================================================================

export interface ValidateHumanApprovalInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly packageId: string;
  readonly revision: number;
  readonly contextFingerprint: string;
  readonly understandingRevision?: number | null;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole | string;
  readonly intent: string;
  readonly comment?: string;
  readonly timestamp?: string;
}

export interface SubmitHumanApprovalInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly packageId: string;
  readonly revision: number;
  readonly contextFingerprint: string;
  readonly understandingRevision?: number | null;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole | string;
  readonly intent: string;
  readonly comment?: string;
  readonly timestamp?: string;
}

export interface HumanApprovalValidationResult {
  readonly isValid: boolean;
  readonly code: HumanApprovalValidationCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface HumanApprovalResult {
  readonly package: ProjectApprovalPackage;
  readonly isDevelopmentAuthorized: boolean;
  readonly approvalRecord: ProjectApprovalRecord;
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly verifiedBindings: {
    readonly projectId: string;
    readonly directorSessionId: string;
    readonly contextFingerprint: string;
    readonly understandingRevision: number | null;
    readonly approvalRevision: number;
  };
}

export interface EvaluateResumeInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly packageId?: string;
  readonly revision?: number;
  readonly directorDecisionId?: string;
}

export interface ResumeEvaluationResult {
  readonly canResume: boolean;
  readonly code: ResumeEvaluationCode;
  readonly message: string;
  readonly isDevelopmentAuthorized: boolean;
  readonly approvedPackage?: ProjectApprovalPackage | null;
  readonly directorSession?: DirectorSession | null;
  readonly contextFingerprint?: string | null;
  readonly directorDecision?: DirectorDecision | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 3. ZOD VALIDATION SCHEMAS
// ============================================================================

export const ValidateHumanApprovalInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema,
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  contextFingerprint: z.string().min(1, 'contextFingerprint is required'),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.string().min(1, 'actorRole is required'),
  intent: z.string().min(1, 'intent is required'),
  comment: z.string().optional(),
  timestamp: z.string().optional(),
});

export const SubmitHumanApprovalInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema,
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  contextFingerprint: z.string().min(1, 'contextFingerprint is required'),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.string().min(1, 'actorRole is required'),
  intent: z.string().min(1, 'intent is required'),
  comment: z.string().optional(),
  timestamp: z.string().optional(),
});

export const EvaluateResumeInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema,
  packageId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  directorDecisionId: z.string().optional(),
});

export const HumanApprovalValidationResultZodSchema = z.object({
  isValid: z.boolean(),
  code: z.enum(HUMAN_APPROVAL_VALIDATION_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ResumeEvaluationResultZodSchema = z.object({
  canResume: z.boolean(),
  code: z.enum(RESUME_EVALUATION_CODES),
  message: z.string(),
  isDevelopmentAuthorized: z.boolean(),
  approvedPackage: z.any().optional(),
  directorSession: z.any().optional(),
  contextFingerprint: z.string().nullable().optional(),
  directorDecision: z.any().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
