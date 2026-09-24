/**
 * Director Decision Protocol Engine (Phase 9 TASK-P9-03)
 *
 * Implements deterministic validation, revision-binding, and lifecycle handling
 * for typed ChatGPT Director decisions communicating with AIDM.
 *
 * STRICT GOVERNANCE RULES:
 * 1. Establishes TYPED DECISION PROTOCOL only.
 * 2. Director decision NEVER grants development authorization (Director Decision != Product Owner Approval).
 * 3. Director decision NEVER conveys implementation authority (Director Decision != Implementation Authorization).
 * 4. Product Owner approval remains the sole source of development authorization.
 * 5. isDevelopmentAuthorized() semantics remain strictly unchanged.
 * 6. Director decision CANNOT directly mutate SpecStore (requirements.json, decisions.json), Task DAG, or global AIDM FSM.
 * 7. Does NOT invoke Antigravity execution or autonomous iteration loops.
 * 8. Decisions are strictly bound to a valid, non-stale, complete Director Context Snapshot fingerprint.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Actor } from '../actors.js';
import { sanitizeMcpPayload } from '../mcp/mcp-errors.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import { ApprovalStore } from '../approval/approval-store.js';
import {
  type DirectorDecision,
  type CreateDirectorDecisionInput,
  type GetDirectorDecisionInput,
  type ValidateDirectorDecisionInput,
  type ListDirectorDecisionsInput,
  type DirectorDecisionValidationResult,
  DIRECTOR_DECISION_PROTOCOL_VERSION,
  DIRECTOR_DECISION_SCHEMA_VERSION,
  DIRECTOR_DECISION_TYPES,
  CreateDirectorDecisionInputZodSchema,
  GetDirectorDecisionInputZodSchema,
  ValidateDirectorDecisionInputZodSchema,
  ListDirectorDecisionsInputZodSchema,
} from './director-decision-types.js';
import { DirectorDecisionStore } from './director-decision-store.js';
import { DirectorSessionStore } from './director-session-store.js';
import { DirectorSessionEngine } from './director-session-engine.js';
import {
  resolveCanonicalProjectIdentity,
  validateProjectBinding,
} from './project-identity-resolver.js';
import {
  DirectorValidationError,
  DirectorSessionNotFoundError,
  DirectorDecisionNotFoundError,
  DirectorDecisionAlreadyExistsError,
  DirectorInvalidTransitionError,
  DirectorSecurityError,
  DirectorProjectBindingMismatchError,
  DirectorContextMismatchError,
  DirectorContextStaleError,
  DirectorContextIncompleteError,
  DirectorApprovalRevisionMismatchError,
  DirectorUnderstandingRevisionMismatchError,
} from './director-errors.js';
import type { DirectorSession } from './director-types.js';

export interface DirectorDecisionEngineOptions {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly decisionStore?: DirectorDecisionStore;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly approvalStore?: ApprovalStore;
}

export class DirectorDecisionEngine {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly decisionStore: DirectorDecisionStore;
  readonly sessionStore: DirectorSessionStore;
  readonly sessionEngine: DirectorSessionEngine;
  readonly approvalStore?: ApprovalStore;

  constructor(options: DirectorDecisionEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.delegate = options.delegate;
    this.sessionStore =
      options.sessionStore ??
      options.delegate?.directorSessionStore ??
      new DirectorSessionStore({
        baseDir: this.workspaceRoot,
        historyManager: options.delegate?.historyManager,
      });
    this.decisionStore =
      options.decisionStore ??
      new DirectorDecisionStore({
        sessionStore: this.sessionStore,
        historyManager: options.delegate?.historyManager,
      });
    this.sessionEngine =
      options.sessionEngine ??
      new DirectorSessionEngine({
        store: this.sessionStore,
        workspaceRoot: this.workspaceRoot,
      });
    this.approvalStore =
      options.approvalStore ??
      options.delegate?.approvalStore ??
      (this.workspaceRoot
        ? new ApprovalStore({
            baseDir: this.workspaceRoot,
            historyManager: options.delegate?.historyManager,
          })
        : undefined);
  }

  /**
   * Generates a deterministic, prefixed Director decision ID.
   */
  generateDecisionId(): string {
    const randomHex = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    return `dir-dec-${randomHex}`;
  }

  /**
   * Validates a Director decision input against session state, context snapshot, and approval revision.
   * Returns a structured validation result without throwing.
   */
  async validateDecision(
    input: ValidateDirectorDecisionInput
  ): Promise<DirectorDecisionValidationResult> {
    // 1. Zod input validation
    const parsedInput = ValidateDirectorDecisionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      return {
        isValid: false,
        code: 'VALIDATION_ERROR',
        message: `Invalid Director decision input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        details: { issues: parsedInput.error.issues },
      };
    }

    // 2. Strict Actor & Authority validation
    if (input.actor !== undefined && input.actor !== null) {
      if (input.actor === Actor.USER) {
        return {
          isValid: false,
          code: 'SECURITY_VIOLATION',
          message:
            "Director decision cannot impersonate Product Owner ('USER'). Product Owner approval is required for development authorization.",
        };
      }
      if (input.actor === Actor.EXECUTOR) {
        return {
          isValid: false,
          code: 'SECURITY_VIOLATION',
          message:
            "Antigravity executor ('EXECUTOR') is strictly prohibited from creating or submitting Director decisions.",
        };
      }
      if (input.actor !== Actor.DIRECTOR) {
        return {
          isValid: false,
          code: 'ACTOR_INVALID',
          message: `Unauthorized actor '${input.actor}'. Only 'DIRECTOR' can submit Director decisions.`,
        };
      }
    }

    // 3. Decision Type validation
    if (!DIRECTOR_DECISION_TYPES.includes(input.decisionType)) {
      return {
        isValid: false,
        code: 'DECISION_TYPE_INVALID',
        message: `Invalid decisionType '${input.decisionType}'. Must be one of: ${DIRECTOR_DECISION_TYPES.join(', ')}`,
      };
    }

    // 4. Resolve canonical project identity
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        return {
          isValid: false,
          code: 'PROJECT_BINDING_MISMATCH',
          message: `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project binding rejected.`,
          details: {
            specifiedProjectId: trimmed,
            canonicalProjectId: canonical.projectId,
            canonicalProjectRoot: canonical.projectRoot,
          },
        };
      }
    }

    // 5. Resolve Director session
    let session: DirectorSession;
    try {
      session = await this.sessionEngine.getSession(input.directorSessionId, {
        workspaceRoot: targetRoot,
        projectId: canonical.projectId,
      });
    } catch (err) {
      return {
        isValid: false,
        code: 'SESSION_INVALID',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 6. Session status validation: must be ACTIVE
    if (session.status !== 'ACTIVE') {
      return {
        isValid: false,
        code: 'SESSION_NOT_ACTIVE',
        message: `Director session '${session.directorSessionId}' is ${session.status}. Decisions can only be submitted for an ACTIVE session.`,
        details: {
          directorSessionId: session.directorSessionId,
          status: session.status,
        },
      };
    }

    // 7. Validate project binding on session
    try {
      validateProjectBinding(session, {
        workspaceRoot: targetRoot,
        projectId: canonical.projectId,
      });
    } catch (err) {
      return {
        isValid: false,
        code: 'PROJECT_BINDING_MISMATCH',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 8. Context fingerprint validation
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!latestSnapshot) {
      return {
        isValid: false,
        code: 'CONTEXT_NOT_FOUND',
        message: `No context snapshot found for Director session '${session.directorSessionId}'. Context synchronization must be performed before submitting decisions.`,
        details: { directorSessionId: session.directorSessionId },
      };
    }

    // Check if snapshot fingerprint matches the latest synchronized snapshot
    if (latestSnapshot.logicalFingerprint !== input.basedOnContextFingerprint) {
      return {
        isValid: false,
        code: 'CONTEXT_CHANGED',
        message: `Context fingerprint mismatch: decision is based on '${input.basedOnContextFingerprint}', but latest context snapshot fingerprint is '${latestSnapshot.logicalFingerprint}'. Context has changed; resynchronization is required.`,
        details: {
          basedOnFingerprint: input.basedOnContextFingerprint,
          latestFingerprint: latestSnapshot.logicalFingerprint,
        },
      };
    }

    // Check if snapshot is stale
    if (latestSnapshot.syncStatus === 'STALE' || latestSnapshot.staleSections.length > 0) {
      return {
        isValid: false,
        code: 'CONTEXT_STALE',
        message: `Context snapshot is stale (stale sections: ${latestSnapshot.staleSections.join(', ')}). Decisions cannot be based on a stale context snapshot.`,
        details: { staleSections: latestSnapshot.staleSections },
      };
    }

    // Check if snapshot is incomplete
    if (
      latestSnapshot.syncStatus === 'INCOMPLETE' ||
      !latestSnapshot.isComplete ||
      latestSnapshot.unavailableSections.length > 0
    ) {
      return {
        isValid: false,
        code: 'CONTEXT_INCOMPLETE',
        message: `Context snapshot is incomplete (unavailable sections: ${latestSnapshot.unavailableSections.join(', ')}). Decisions cannot be based on an incomplete context snapshot.`,
        details: { unavailableSections: latestSnapshot.unavailableSections },
      };
    }

    // 9. Approval revision validation if specified
    if (
      input.basedOnApprovalRevision !== undefined &&
      input.basedOnApprovalRevision !== null
    ) {
      const approvalStore =
        this.approvalStore ??
        new ApprovalStore({
          baseDir: targetRoot,
          historyManager: this.delegate?.historyManager,
        });

      let activePkg = null;
      try {
        activePkg = await approvalStore.getActivePackage();
      } catch {
        // ignore
      }

      if (!activePkg) {
        return {
          isValid: false,
          code: 'APPROVAL_REVISION_MISMATCH',
          message: `Decision references approval revision ${input.basedOnApprovalRevision}, but no active approval package exists.`,
          details: { basedOnApprovalRevision: input.basedOnApprovalRevision },
        };
      }

      if (activePkg.revision !== input.basedOnApprovalRevision) {
        return {
          isValid: false,
          code: 'APPROVAL_REVISION_MISMATCH',
          message: `Decision is based on approval revision ${input.basedOnApprovalRevision}, but current active approval package has revision ${activePkg.revision}. Approval revision has changed.`,
          details: {
            basedOnApprovalRevision: input.basedOnApprovalRevision,
            activeApprovalRevision: activePkg.revision,
          },
        };
      }
    }

    // 10. Understanding revision validation if specified
    if (
      input.basedOnUnderstandingRevision !== undefined &&
      input.basedOnUnderstandingRevision !== null
    ) {
      if (
        session.understandingRevision === null ||
        session.understandingRevision === undefined
      ) {
        return {
          isValid: false,
          code: 'UNDERSTANDING_REVISION_MISMATCH',
          message: `Decision references understanding revision ${input.basedOnUnderstandingRevision}, but session has no authoritative understanding revision.`,
          details: { basedOnUnderstandingRevision: input.basedOnUnderstandingRevision },
        };
      }

      if (session.understandingRevision !== input.basedOnUnderstandingRevision) {
        return {
          isValid: false,
          code: 'UNDERSTANDING_REVISION_MISMATCH',
          message: `Decision is based on understanding revision ${input.basedOnUnderstandingRevision}, but session understanding revision is ${session.understandingRevision}.`,
          details: {
            basedOnUnderstandingRevision: input.basedOnUnderstandingRevision,
            sessionUnderstandingRevision: session.understandingRevision,
          },
        };
      }
    }

    // 11. Check decision ID collision if specified
    if (input.decisionId) {
      const safeId = this.decisionStore.sanitizeDecisionId(input.decisionId);
      const existing = await this.decisionStore.loadDecision(safeId);
      if (existing) {
        return {
          isValid: false,
          code: 'VALIDATION_ERROR',
          message: `Director decision '${safeId}' already exists.`,
          details: { decisionId: safeId },
        };
      }
    }

    return {
      isValid: true,
      code: 'VALID',
      message: 'Director decision validation passed.',
    };
  }

  /**
   * Creates, validates, and persists a typed Director decision.
   */
  async createDecision(input: CreateDirectorDecisionInput): Promise<DirectorDecision> {
    // 1. Zod input validation
    const parsedInput = CreateDirectorDecisionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      const err = new DirectorValidationError(
        `Invalid Director decision create input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
      await this.decisionStore.recordValidationFailure({
        directorSessionId: input.directorSessionId ?? null,
        projectId: input.projectId ?? null,
        decisionId: input.decisionId ?? null,
        decisionType: input.decisionType ?? null,
        basedOnContextFingerprint: input.basedOnContextFingerprint ?? null,
        reason: err.message,
        code: 'VALIDATION_ERROR',
      });
      throw err;
    }

    // 2. Validate decision against authoritative state
    const validation = await this.validateDecision(input);
    if (!validation.isValid) {
      await this.decisionStore.recordValidationFailure({
        directorSessionId: input.directorSessionId ?? null,
        projectId: input.projectId ?? null,
        decisionId: input.decisionId ?? null,
        decisionType: input.decisionType,
        basedOnContextFingerprint: input.basedOnContextFingerprint,
        reason: validation.message,
        code: validation.code,
      });

      // Map validation code to specific domain error
      switch (validation.code) {
        case 'SECURITY_VIOLATION':
        case 'ACTOR_INVALID':
          throw new DirectorSecurityError(validation.message, validation.details);
        case 'SESSION_NOT_ACTIVE':
          throw new DirectorInvalidTransitionError(
            (validation.details?.status as string) ?? 'INACTIVE',
            'DECISION',
            {
              reason: validation.message,
              ...validation.details,
            }
          );
        case 'SESSION_INVALID':
          throw new DirectorSessionNotFoundError(
            input.directorSessionId ?? 'active-session',
            validation.details
          );
        case 'PROJECT_BINDING_MISMATCH':
          throw new DirectorProjectBindingMismatchError(
            validation.message,
            validation.details
          );
        case 'CONTEXT_CHANGED':
        case 'CONTEXT_NOT_FOUND':
          throw new DirectorContextMismatchError(
            validation.message,
            validation.details
          );
        case 'CONTEXT_STALE':
          throw new DirectorContextStaleError(
            validation.message,
            validation.details
          );
        case 'CONTEXT_INCOMPLETE':
          throw new DirectorContextIncompleteError(
            validation.message,
            validation.details
          );
        case 'APPROVAL_REVISION_MISMATCH':
          throw new DirectorApprovalRevisionMismatchError(
            validation.message,
            validation.details
          );
        case 'UNDERSTANDING_REVISION_MISMATCH':
          throw new DirectorUnderstandingRevisionMismatchError(
            validation.message,
            validation.details
          );
        default:
          if (validation.message.includes('already exists')) {
            throw new DirectorDecisionAlreadyExistsError(
              input.decisionId ?? 'unknown',
              validation.details
            );
          }
          throw new DirectorValidationError(validation.message, validation.details);
      }
    }

    // 3. Resolve canonical project identity and active session
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);
    const session = await this.sessionEngine.getSession(input.directorSessionId, {
      workspaceRoot: targetRoot,
      projectId: canonical.projectId,
    });

    const decisionId = input.decisionId
      ? this.decisionStore.sanitizeDecisionId(input.decisionId)
      : this.generateDecisionId();

    const now = new Date().toISOString();
    const safeMetadata = input.metadata
      ? (sanitizeMcpPayload(input.metadata) as Record<string, unknown>)
      : {};

    // 4. Construct domain model
    const decision: DirectorDecision = {
      decisionId,
      directorSessionId: session.directorSessionId,
      projectId: canonical.projectId,
      protocolVersion: DIRECTOR_DECISION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_DECISION_SCHEMA_VERSION,
      actor: Actor.DIRECTOR,
      decisionType: input.decisionType,
      rationale: input.rationale,
      basedOnContextFingerprint: input.basedOnContextFingerprint,
      basedOnApprovalRevision: input.basedOnApprovalRevision ?? null,
      basedOnUnderstandingRevision: input.basedOnUnderstandingRevision ?? null,
      createdAt: now,
      metadata: safeMetadata,
      hasImplementationAuthority: false,
    };

    // 5. Persist decision atomically and log audit event
    await this.decisionStore.saveDecision(decision, 'DIRECTOR_DECISION_CREATED');

    // 6. Update Director session last activity
    await this.sessionEngine.touchSession({
      directorSessionId: session.directorSessionId,
      workspaceRoot: targetRoot,
      projectId: canonical.projectId,
    });

    return decision;
  }

  /**
   * Retrieves a Director decision by ID.
   */
  async getDecision(
    decisionId: string,
    options?: {
      readonly workspaceRoot?: string;
      readonly projectId?: string;
      readonly directorSessionId?: string;
    }
  ): Promise<DirectorDecision> {
    const safeId = this.decisionStore.sanitizeDecisionId(decisionId);
    const decision = await this.decisionStore.loadDecision(safeId);

    if (!decision) {
      throw new DirectorDecisionNotFoundError(safeId);
    }

    // Validate project binding if requested
    if (options?.projectId || options?.workspaceRoot) {
      const targetRoot = options.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
      const canonical = resolveCanonicalProjectIdentity(targetRoot);
      if (options.projectId && options.projectId !== canonical.projectId) {
        throw new DirectorProjectBindingMismatchError(
          `Project ID mismatch: requested '${options.projectId}', canonical is '${canonical.projectId}'`
        );
      }
      if (decision.projectId !== canonical.projectId) {
        throw new DirectorProjectBindingMismatchError(
          `Decision '${safeId}' is bound to project '${decision.projectId}', but target project is '${canonical.projectId}'. Cross-project access rejected.`
        );
      }
    }

    // Validate session binding if requested
    if (options?.directorSessionId && decision.directorSessionId !== options.directorSessionId) {
      throw new DirectorValidationError(
        `Decision '${safeId}' is bound to Director session '${decision.directorSessionId}', not '${options.directorSessionId}'.`
      );
    }

    return decision;
  }

  /**
   * Lists persisted Director decisions.
   */
  async listDecisions(
    input: ListDirectorDecisionsInput = {}
  ): Promise<readonly DirectorDecision[]> {
    const parsed = ListDirectorDecisionsInputZodSchema.safeParse(input);
    if (!parsed.success) {
      throw new DirectorValidationError(
        `Invalid Director decision list arguments: ${parsed.error.issues[0]?.message ?? 'validation failed'}`
      );
    }

    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        throw new DirectorProjectBindingMismatchError(
          `Project ID mismatch: requested '${trimmed}', canonical is '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project binding rejected.`
        );
      }
    }

    const filterProjectId = canonical.projectId;

    return this.decisionStore.listDecisions({
      sessionId: input.directorSessionId,
      projectId: filterProjectId,
      decisionType: input.decisionType,
      limit: input.limit,
    });
  }
}
