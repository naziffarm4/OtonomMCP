/**
 * Director Session & Identity Domain Types (Phase 9 TASK-P9-01)
 *
 * Establishes the authoritative, typed domain model for ChatGPT Director
 * session identity and authority context communicating with AIDM via MCP.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Establishes SESSION IDENTITY and AUTHORITY CONTEXT only.
 * 2. Director session identity NEVER grants implementation authority.
 * 3. Product Owner approval remains the sole source of development authorization.
 * 4. isDevelopmentAuthorized() semantics remain strictly unchanged.
 * 5. Director session CANNOT mutate SpecStore, Task DAG, or global AIDM FSM.
 * 6. Does NOT invoke Antigravity or autonomous iteration loops.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const DIRECTOR_PROTOCOL_VERSION = 'P9-01';
export const DIRECTOR_SCHEMA_VERSION = 1;

export const DIRECTOR_SESSION_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type DirectorSessionStatus = (typeof DIRECTOR_SESSION_STATUSES)[number];

export const DIRECTOR_ACTOR_ROLES = ['DIRECTOR', 'PROJECT_DIRECTOR'] as const;
export type DirectorActorRole = (typeof DIRECTOR_ACTOR_ROLES)[number];

// ============================================================================
// 2. DOMAIN MODEL
// ============================================================================

export interface DirectorSession {
  /** Deterministic, unique session identifier for the Director session */
  readonly directorSessionId: string;
  /** Canonical project identifier bound to this session */
  readonly projectId: string;
  /** Absolute filesystem path of the bound project workspace root */
  readonly projectRoot: string;
  /** Session lifecycle status: ACTIVE | SUSPENDED | CLOSED */
  readonly status: DirectorSessionStatus;
  /** Protocol version string */
  readonly protocolVersion: string;
  /** Schema version integer */
  readonly schemaVersion: number;
  /** Actor type: strictly DIRECTOR */
  readonly actor: 'DIRECTOR';
  /** Actor role: DIRECTOR | PROJECT_DIRECTOR */
  readonly actorRole: DirectorActorRole;
  /** ISO 8601 creation timestamp */
  readonly createdAt: string;
  /** ISO 8601 last activity timestamp */
  readonly lastActivityAt: string;
  /** Associated approval package identifier if available */
  readonly approvalPackageId?: string | null;
  /** Associated approval package revision if available */
  readonly approvalRevision?: number | null;
  /** Associated project understanding revision if available */
  readonly understandingRevision?: number | null;
  /** Session metadata necessary for deterministic resume/audit (secrets redacted) */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * INVARIANT: Director session identity NEVER conveys implementation authority.
   * Implementation authorization requires explicit Product Owner approval.
   */
  readonly hasImplementationAuthority: false;
}

// ============================================================================
// 3. OPERATION INPUTS
// ============================================================================

export interface CreateDirectorSessionInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly actor?: string;
  readonly actorRole?: DirectorActorRole;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly approvalPackageId?: string | null;
  readonly approvalRevision?: number | null;
  readonly understandingRevision?: number | null;
}

export interface ResumeDirectorSessionInput {
  readonly directorSessionId?: string;
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SuspendDirectorSessionInput {
  readonly directorSessionId?: string;
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly reason?: string;
}

export interface CloseDirectorSessionInput {
  readonly directorSessionId?: string;
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly reason?: string;
}

export interface TouchDirectorSessionInput {
  readonly directorSessionId: string;
  readonly workspaceRoot?: string;
  readonly projectId?: string;
}

// ============================================================================
// 4. ZOD VALIDATION SCHEMAS
// ============================================================================

const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

export const DirectorSessionIdZodSchema = z
  .string({ message: 'directorSessionId is required' })
  .min(3, 'directorSessionId must have at least 3 characters')
  .max(128, 'directorSessionId must have at most 128 characters')
  .regex(
    SESSION_ID_REGEX,
    'directorSessionId must only contain alphanumeric characters, underscores, dashes, and periods'
  )
  .refine(
    (id) => !id.includes('..') && !id.includes('/') && !id.includes('\\'),
    'directorSessionId cannot contain path traversal sequences'
  );

export const DirectorSessionZodSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema,
  projectId: z.string().min(1, 'projectId cannot be empty'),
  projectRoot: z.string().min(1, 'projectRoot cannot be empty'),
  status: z.enum(DIRECTOR_SESSION_STATUSES),
  protocolVersion: z.string().min(1, 'protocolVersion cannot be empty'),
  schemaVersion: z.number().int().positive('schemaVersion must be a positive integer'),
  actor: z.literal(Actor.DIRECTOR),
  actorRole: z.enum(DIRECTOR_ACTOR_ROLES).default('DIRECTOR'),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  lastActivityAt: z.string().min(1, 'lastActivityAt cannot be empty'),
  approvalPackageId: z.string().nullable().optional().default(null),
  approvalRevision: z.number().int().nonnegative().nullable().optional().default(null),
  understandingRevision: z.number().int().nonnegative().nullable().optional().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  hasImplementationAuthority: z.literal(false).default(false),
});

export const CreateDirectorSessionInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  actor: z.string().optional(),
  actorRole: z.enum(DIRECTOR_ACTOR_ROLES).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  approvalPackageId: z.string().nullable().optional(),
  approvalRevision: z.number().int().nonnegative().nullable().optional(),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
});

export const ResumeDirectorSessionInputZodSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SuspendDirectorSessionInputZodSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  reason: z.string().optional(),
});

export const CloseDirectorSessionInputZodSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  reason: z.string().optional(),
});
