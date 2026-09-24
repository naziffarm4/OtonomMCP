/**
 * Director Decision Protocol Types (Phase 9 TASK-P9-03)
 *
 * Establishes the authoritative, typed domain model for ChatGPT Director
 * decisions communicating with AIDM via MCP.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Establishes TYPED DECISION PROTOCOL only.
 * 2. Director decision NEVER grants development authorization (Director Decision != Product Owner Approval).
 * 3. Director decision NEVER conveys implementation authority (Director Decision != Implementation Authorization).
 * 4. Product Owner approval remains the sole source of development authorization.
 * 5. isDevelopmentAuthorized() semantics remain strictly unchanged.
 * 6. Director decision CANNOT directly mutate SpecStore (requirements.json, decisions.json), Task DAG, or global AIDM FSM.
 * 7. Does NOT invoke Antigravity or autonomous iteration loops.
 * 8. Decisions are strictly bound to a valid, non-stale, complete Director Context Snapshot fingerprint.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';
import { DirectorSessionIdZodSchema } from './director-types.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const DIRECTOR_DECISION_PROTOCOL_VERSION = 'P9-03';
export const DIRECTOR_DECISION_SCHEMA_VERSION = 1;

export const DIRECTOR_DECISION_TYPES = [
  'REQUEST_CLARIFICATION',
  'ACCEPT_CONTEXT',
  'REJECT_CONTEXT',
  'REQUEST_PLANNING',
  'DEFER',
  'BLOCK',
  'RESUME',
  'IMPLEMENT_TASK',
] as const;

export type DirectorDecisionType = (typeof DIRECTOR_DECISION_TYPES)[number];

export const DIRECTOR_DECISION_VALIDATION_CODES = [
  'VALID',
  'CONTEXT_CHANGED',
  'CONTEXT_STALE',
  'CONTEXT_INCOMPLETE',
  'CONTEXT_NOT_FOUND',
  'SESSION_INVALID',
  'SESSION_NOT_ACTIVE',
  'PROJECT_BINDING_MISMATCH',
  'APPROVAL_REVISION_MISMATCH',
  'UNDERSTANDING_REVISION_MISMATCH',
  'SCHEMA_MISMATCH',
  'ACTOR_INVALID',
  'DECISION_TYPE_INVALID',
  'SECURITY_VIOLATION',
  'VALIDATION_ERROR',
] as const;

export type DirectorDecisionValidationCode =
  (typeof DIRECTOR_DECISION_VALIDATION_CODES)[number];

// ============================================================================
// 2. DOMAIN MODEL
// ============================================================================

export interface DirectorDecision {
  /** Deterministic, unique identifier for this Director decision */
  readonly decisionId: string;
  /** Bound Director session identifier */
  readonly directorSessionId: string;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Protocol version string (P9-03) */
  readonly protocolVersion: string;
  /** Schema version integer */
  readonly schemaVersion: number;
  /** Actor type: strictly DIRECTOR */
  readonly actor: 'DIRECTOR';
  /** Typed decision type */
  readonly decisionType: DirectorDecisionType;
  /** Human-readable explanation and rationale for the decision */
  readonly rationale: string;
  /** Mandatory deterministic fingerprint of the Director Context Snapshot this decision is based on */
  readonly basedOnContextFingerprint: string;
  /** Associated approval package revision if applicable */
  readonly basedOnApprovalRevision?: number | null;
  /** Associated project understanding revision if applicable */
  readonly basedOnUnderstandingRevision?: number | null;
  /** ISO 8601 creation timestamp */
  readonly createdAt: string;
  /** Decision metadata (secrets redacted) */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * INVARIANT: Director decision NEVER conveys implementation authority.
   * Implementation authorization requires explicit Product Owner approval.
   */
  readonly hasImplementationAuthority: false;
}

// ============================================================================
// 3. OPERATION INPUTS & RESULTS
// ============================================================================

export interface CreateDirectorDecisionInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly decisionId?: string;
  readonly actor?: string;
  readonly decisionType: DirectorDecisionType;
  readonly rationale: string;
  readonly basedOnContextFingerprint: string;
  readonly basedOnApprovalRevision?: number | null;
  readonly basedOnUnderstandingRevision?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GetDirectorDecisionInput {
  readonly decisionId: string;
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
}

export interface ValidateDirectorDecisionInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly decisionId?: string;
  readonly actor?: string;
  readonly decisionType: DirectorDecisionType;
  readonly rationale: string;
  readonly basedOnContextFingerprint: string;
  readonly basedOnApprovalRevision?: number | null;
  readonly basedOnUnderstandingRevision?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ListDirectorDecisionsInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly decisionType?: DirectorDecisionType;
  readonly limit?: number;
}

export interface DirectorDecisionValidationResult {
  readonly isValid: boolean;
  readonly code: DirectorDecisionValidationCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 4. ZOD VALIDATION SCHEMAS
// ============================================================================

const DECISION_ID_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

export const DirectorDecisionIdZodSchema = z
  .string({ message: 'decisionId is required' })
  .min(3, 'decisionId must have at least 3 characters')
  .max(128, 'decisionId must have at most 128 characters')
  .regex(
    DECISION_ID_REGEX,
    'decisionId must only contain alphanumeric characters, underscores, dashes, and periods'
  )
  .refine(
    (id) => !id.includes('..') && !id.includes('/') && !id.includes('\\'),
    'decisionId cannot contain path traversal sequences'
  );

export const DirectorDecisionZodSchema = z.object({
  decisionId: DirectorDecisionIdZodSchema,
  directorSessionId: DirectorSessionIdZodSchema,
  projectId: z.string().min(1, 'projectId cannot be empty'),
  protocolVersion: z.string().min(1, 'protocolVersion cannot be empty'),
  schemaVersion: z.number().int().positive('schemaVersion must be a positive integer'),
  actor: z.literal(Actor.DIRECTOR),
  decisionType: z.enum(DIRECTOR_DECISION_TYPES),
  rationale: z.string().min(1, 'rationale cannot be empty'),
  basedOnContextFingerprint: z.string().min(1, 'basedOnContextFingerprint cannot be empty'),
  basedOnApprovalRevision: z.number().int().nonnegative().nullable().optional().default(null),
  basedOnUnderstandingRevision: z.number().int().nonnegative().nullable().optional().default(null),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  metadata: z.record(z.string(), z.unknown()).default({}),
  hasImplementationAuthority: z.literal(false).default(false),
});

export const CreateDirectorDecisionInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  decisionId: DirectorDecisionIdZodSchema.optional(),
  actor: z.string().optional(),
  decisionType: z.enum(DIRECTOR_DECISION_TYPES),
  rationale: z.string().min(1, 'rationale cannot be empty'),
  basedOnContextFingerprint: z.string().min(1, 'basedOnContextFingerprint cannot be empty'),
  basedOnApprovalRevision: z.number().int().nonnegative().nullable().optional(),
  basedOnUnderstandingRevision: z.number().int().nonnegative().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GetDirectorDecisionInputZodSchema = z.object({
  decisionId: DirectorDecisionIdZodSchema,
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema.optional(),
});

export const ValidateDirectorDecisionInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  decisionId: DirectorDecisionIdZodSchema.optional(),
  actor: z.string().optional(),
  decisionType: z.enum(DIRECTOR_DECISION_TYPES),
  rationale: z.string().min(1, 'rationale cannot be empty'),
  basedOnContextFingerprint: z.string().min(1, 'basedOnContextFingerprint cannot be empty'),
  basedOnApprovalRevision: z.number().int().nonnegative().nullable().optional(),
  basedOnUnderstandingRevision: z.number().int().nonnegative().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ListDirectorDecisionsInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  decisionType: z.enum(DIRECTOR_DECISION_TYPES).optional(),
  limit: z.number().int().positive().max(100).optional().default(50),
});
