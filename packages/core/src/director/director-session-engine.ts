/**
 * Director Session Lifecycle & Authority Engine (Phase 9 TASK-P9-01)
 *
 * Implements deterministic session lifecycle semantics, project binding validation,
 * authority context boundary enforcement, and resume semantics.
 *
 * STRICT GOVERNANCE RULES:
 * 1. Establishes SESSION IDENTITY only.
 * 2. NEVER grants implementation authority (hasImplementationAuthority: false).
 * 3. Product Owner approval remains the sole source of development authorization.
 * 4. Strictly prevents Antigravity (EXECUTOR) and Product Owner (USER) impersonation.
 * 5. Deterministic session resume recovers existing identity without creating a new session.
 * 6. Closed sessions are terminal and cannot be resumed or suspended.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import { sanitizeMcpPayload } from '../mcp/mcp-errors.js';
import {
  type DirectorSession,
  type CreateDirectorSessionInput,
  type ResumeDirectorSessionInput,
  type SuspendDirectorSessionInput,
  type CloseDirectorSessionInput,
  type TouchDirectorSessionInput,
  DIRECTOR_PROTOCOL_VERSION,
  DIRECTOR_SCHEMA_VERSION,
  CreateDirectorSessionInputZodSchema,
  ResumeDirectorSessionInputZodSchema,
  SuspendDirectorSessionInputZodSchema,
  CloseDirectorSessionInputZodSchema,
} from './director-types.js';
import { DirectorSessionStore } from './director-session-store.js';
import {
  resolveCanonicalProjectIdentity,
  validateProjectBinding,
} from './project-identity-resolver.js';
import {
  DirectorValidationError,
  DirectorSessionNotFoundError,
  DirectorSessionAlreadyExistsError,
  DirectorInvalidTransitionError,
  DirectorSecurityError,
  DirectorProjectBindingMismatchError,
} from './director-errors.js';

export interface DirectorSessionEngineOptions {
  readonly store?: DirectorSessionStore;
  readonly workspaceRoot?: string;
}

export class DirectorSessionEngine {
  readonly store: DirectorSessionStore;
  readonly workspaceRoot?: string;

  constructor(options?: DirectorSessionEngineOptions) {
    this.workspaceRoot = options?.workspaceRoot;
    this.store =
      options?.store ??
      new DirectorSessionStore({
        baseDir: options?.workspaceRoot,
      });
  }

  /**
   * Generates a deterministic, prefixed Director session ID.
   */
  generateSessionId(): string {
    const randomHex = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    return `dir-sess-${randomHex}`;
  }

  /**
   * Creates a new Director session bound to the canonical project context.
   */
  async createSession(input: CreateDirectorSessionInput = {}): Promise<DirectorSession> {
    // 1. Zod input validation
    const parsedInput = CreateDirectorSessionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new DirectorValidationError(
        `Invalid Director session create arguments: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    // 2. Strict Actor & Authority validation
    if (input.actor !== undefined && input.actor !== null) {
      if (input.actor === Actor.USER) {
        throw new DirectorSecurityError(
          "Director session cannot impersonate Product Owner ('USER'). Only human Product Owners can grant authorization."
        );
      }
      if (input.actor === Actor.EXECUTOR) {
        throw new DirectorSecurityError(
          "Antigravity executor ('EXECUTOR') is strictly prohibited from creating or impersonating a Director session."
        );
      }
      if (input.actor !== Actor.DIRECTOR) {
        throw new DirectorSecurityError(
          `Unauthorized actor '${input.actor}' cannot establish a Director session.`
        );
      }
    }

    // 3. Resolve canonical project identity
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        throw new DirectorProjectBindingMismatchError(
          `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project binding rejected.`,
          {
            specifiedProjectId: trimmed,
            canonicalProjectId: canonical.projectId,
            canonicalProjectRoot: canonical.projectRoot,
          }
        );
      }
    }

    // 4. Session ID assignment and collision check
    let sessionId: string;
    if (input.directorSessionId) {
      sessionId = this.store.sanitizeSessionId(input.directorSessionId);
      const existing = await this.store.loadSession(sessionId);
      if (existing) {
        throw new DirectorSessionAlreadyExistsError(sessionId);
      }
    } else {
      sessionId = this.generateSessionId();
    }

    const now = new Date().toISOString();

    // Sanitize metadata to redact secrets before constructing or persisting
    const safeMetadata = input.metadata
      ? (sanitizeMcpPayload(input.metadata) as Record<string, unknown>)
      : {};

    // 5. Construct domain model
    const session: DirectorSession = {
      directorSessionId: sessionId,
      projectId: canonical.projectId,
      projectRoot: canonical.projectRoot,
      status: 'ACTIVE',
      protocolVersion: DIRECTOR_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_SCHEMA_VERSION,
      actor: Actor.DIRECTOR,
      actorRole: input.actorRole ?? 'DIRECTOR',
      createdAt: now,
      lastActivityAt: now,
      approvalPackageId: input.approvalPackageId ?? null,
      approvalRevision: input.approvalRevision ?? null,
      understandingRevision: input.understandingRevision ?? null,
      metadata: safeMetadata,
      hasImplementationAuthority: false,
    };

    // 6. Atomically persist and record audit event
    await this.store.saveSession(session, 'DIRECTOR_SESSION_CREATED');

    return session;
  }

  /**
   * Resumes an existing Director session.
   * Recovers existing identity, project binding, and protocol context without creating a new session.
   */
  async resumeSession(input: ResumeDirectorSessionInput = {}): Promise<DirectorSession> {
    const parsedInput = ResumeDirectorSessionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new DirectorValidationError(
        `Invalid Director session resume arguments: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    // 1. Locate existing session
    let session: DirectorSession | null = null;
    if (input.directorSessionId) {
      const safeId = this.store.sanitizeSessionId(input.directorSessionId);
      session = await this.store.loadSession(safeId);
      if (!session) {
        throw new DirectorSessionNotFoundError(safeId);
      }
    } else {
      session = await this.store.getActiveSession();
      if (!session) {
        // Look for the most recently active suspended session
        const all = await this.store.listSessions();
        const resumable = all.find((s) => s.status === 'SUSPENDED');
        if (resumable) {
          session = resumable;
        } else {
          throw new DirectorSessionNotFoundError(
            'No active or suspended Director session available to resume'
          );
        }
      }
    }

    // 2. Validate project binding (prevent cross-project resume)
    validateProjectBinding(session, {
      workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
      projectId: input.projectId,
    });

    // 3. Lifecycle state transition validation
    if (session.status === 'CLOSED') {
      throw new DirectorInvalidTransitionError('CLOSED', 'ACTIVE', {
        reason: 'Closed Director sessions are terminal and cannot be resumed. A new session must be created.',
      });
    }

    // 4. Deterministic resume semantics:
    // Identity, creation timestamp, protocol metadata remain identical.
    const now = new Date().toISOString();
    const resumedSession: DirectorSession = {
      ...session,
      status: 'ACTIVE',
      lastActivityAt: now,
      metadata: input.metadata ? { ...session.metadata, ...input.metadata } : session.metadata,
      hasImplementationAuthority: false,
    };

    await this.store.saveSession(resumedSession, 'DIRECTOR_SESSION_RESUMED');

    return resumedSession;
  }

  /**
   * Suspends an active Director session.
   */
  async suspendSession(input: SuspendDirectorSessionInput = {}): Promise<DirectorSession> {
    const parsedInput = SuspendDirectorSessionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new DirectorValidationError(
        `Invalid Director session suspend arguments: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    let session: DirectorSession | null = null;
    if (input.directorSessionId) {
      const safeId = this.store.sanitizeSessionId(input.directorSessionId);
      session = await this.store.loadSession(safeId);
      if (!session) {
        throw new DirectorSessionNotFoundError(safeId);
      }
    } else {
      session = await this.store.getActiveSession();
      if (!session) {
        throw new DirectorSessionNotFoundError(
          'No active Director session available to suspend'
        );
      }
    }

    validateProjectBinding(session, {
      workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
      projectId: input.projectId,
    });

    if (session.status === 'CLOSED') {
      throw new DirectorInvalidTransitionError('CLOSED', 'SUSPENDED', {
        reason: 'Closed Director sessions are terminal and cannot be suspended.',
      });
    }

    // Idempotent if already suspended
    if (session.status === 'SUSPENDED') {
      return session;
    }

    const now = new Date().toISOString();
    const suspendedSession: DirectorSession = {
      ...session,
      status: 'SUSPENDED',
      lastActivityAt: now,
      metadata: input.reason
        ? { ...session.metadata, suspendReason: input.reason }
        : session.metadata,
      hasImplementationAuthority: false,
    };

    await this.store.saveSession(suspendedSession, 'DIRECTOR_SESSION_SUSPENDED');

    return suspendedSession;
  }

  /**
   * Closes a Director session. Closed sessions are terminal.
   */
  async closeSession(input: CloseDirectorSessionInput = {}): Promise<DirectorSession> {
    const parsedInput = CloseDirectorSessionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new DirectorValidationError(
        `Invalid Director session close arguments: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    let session: DirectorSession | null = null;
    if (input.directorSessionId) {
      const safeId = this.store.sanitizeSessionId(input.directorSessionId);
      session = await this.store.loadSession(safeId);
      if (!session) {
        throw new DirectorSessionNotFoundError(safeId);
      }
    } else {
      session = await this.store.getActiveSession();
      if (!session) {
        throw new DirectorSessionNotFoundError(
          'No active Director session available to close'
        );
      }
    }

    validateProjectBinding(session, {
      workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
      projectId: input.projectId,
    });

    // Idempotent if already closed
    if (session.status === 'CLOSED') {
      return session;
    }

    const now = new Date().toISOString();
    const closedSession: DirectorSession = {
      ...session,
      status: 'CLOSED',
      lastActivityAt: now,
      metadata: input.reason
        ? { ...session.metadata, closeReason: input.reason }
        : session.metadata,
      hasImplementationAuthority: false,
    };

    await this.store.saveSession(closedSession, 'DIRECTOR_SESSION_CLOSED');

    return closedSession;
  }

  /**
   * Retrieves a Director session by ID or returns the currently active session.
   */
  async getSession(
    sessionId?: string,
    context?: {
      readonly workspaceRoot?: string;
      readonly projectId?: string;
      readonly touch?: boolean;
    }
  ): Promise<DirectorSession> {
    let session: DirectorSession | null = null;

    if (sessionId) {
      const safeId = this.store.sanitizeSessionId(sessionId);
      session = await this.store.loadSession(safeId);
      if (!session) {
        throw new DirectorSessionNotFoundError(safeId);
      }
    } else {
      session = await this.store.getActiveSession();
      if (!session) {
        throw new DirectorSessionNotFoundError('No active Director session found');
      }
    }

    validateProjectBinding(session, {
      workspaceRoot: context?.workspaceRoot ?? this.workspaceRoot,
      projectId: context?.projectId,
    });

    if (context?.touch && session.status !== 'CLOSED') {
      const now = new Date().toISOString();
      session = {
        ...session,
        lastActivityAt: now,
      };
      await this.store.saveSession(session, 'DIRECTOR_SESSION_ACTIVITY_UPDATED');
    }

    return session;
  }

  /**
   * Updates last activity timestamp without state transition.
   */
  async touchSession(input: TouchDirectorSessionInput): Promise<DirectorSession> {
    return this.getSession(input.directorSessionId, {
      workspaceRoot: input.workspaceRoot,
      projectId: input.projectId,
      touch: true,
    });
  }
}
