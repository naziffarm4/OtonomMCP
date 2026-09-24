/**
 * Human Approval & Resume Protocol Engine (Phase 9 TASK-P9-04)
 *
 * Implements deterministic validation, session/context binding, replay protection,
 * and resume evaluation for explicit human/Product Owner approval.
 *
 * STRICT GOVERNANCE RULES:
 * 1. Human/Product Owner approval is strictly separated from Director session identity.
 * 2. Approval can ONLY be granted by authorized Human / Product Owner actor (USER or PRODUCT_OWNER).
 * 3. Director (DIRECTOR) CANNOT grant approval; executor (EXECUTOR) / antigravity / system CANNOT approve.
 * 4. Natural-language "tamam", clarification answers, or Director decisions (including RESUME) are NOT approval.
 * 5. Approval is strictly bound to canonical project, active session, context fingerprint, understanding revision, and approval revision.
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

import { Actor } from '../actors.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import {
  FORBIDDEN_APPROVAL_ACTORS,
  type ProjectApprovalPackage,
  type ApprovalActorRole,
} from '../approval/approval-types.js';
import {
  ApprovalAuthorizationError,
  ApprovalRevisionMismatchError,
  ApprovalInvalidIntentError,
  ApprovalNotReadyError,
  ApprovalAlreadyDecidedError,
  ApprovalPackageNotFoundError,
} from '../approval/approval-errors.js';
import { DirectorSessionStore } from './director-session-store.js';
import { DirectorSessionEngine } from './director-session-engine.js';
import { DirectorDecisionStore } from './director-decision-store.js';
import {
  resolveCanonicalProjectIdentity,
  validateProjectBinding,
} from './project-identity-resolver.js';
import {
  DirectorSessionNotFoundError,
  DirectorInvalidTransitionError,
  DirectorSecurityError,
  HumanApprovalError,
  HumanApprovalValidationError,
  HumanApprovalUnauthorizedActorError,
  HumanApprovalProjectBindingMismatchError,
  HumanApprovalContextMismatchError,
  HumanApprovalContextStaleError,
  HumanApprovalContextIncompleteError,
  HumanApprovalRevisionMismatchError,
  HumanApprovalReplayError,
  ResumeUnauthorizedError,
} from './director-errors.js';
import {
  HUMAN_APPROVAL_PROTOCOL_VERSION,
  HUMAN_APPROVAL_SCHEMA_VERSION,
  RESUME_PROTOCOL_VERSION,
  RESUME_SCHEMA_VERSION,
  type ValidateHumanApprovalInput,
  type SubmitHumanApprovalInput,
  type HumanApprovalValidationResult,
  type HumanApprovalResult,
  type EvaluateResumeInput,
  type ResumeEvaluationResult,
  ValidateHumanApprovalInputZodSchema,
  SubmitHumanApprovalInputZodSchema,
  EvaluateResumeInputZodSchema,
} from './human-approval-types.js';
import type { HistoryManager } from '../storage/history-manager.js';

export interface HumanApprovalEngineOptions {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly decisionStore?: DirectorDecisionStore;
  readonly historyManager?: HistoryManager;
}

export class HumanApprovalEngine {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly approvalStore: ApprovalStore;
  readonly approvalPackageEngine: ApprovalPackageEngine;
  readonly sessionStore: DirectorSessionStore;
  readonly sessionEngine: DirectorSessionEngine;
  readonly decisionStore: DirectorDecisionStore;
  readonly historyManager?: HistoryManager;

  constructor(options: HumanApprovalEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.delegate = options.delegate;
    this.historyManager = options.historyManager ?? options.delegate?.historyManager;

    this.approvalStore =
      options.approvalStore ??
      options.delegate?.approvalStore ??
      new ApprovalStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });

    this.approvalPackageEngine =
      options.approvalPackageEngine ?? new ApprovalPackageEngine();

    this.sessionStore =
      options.sessionStore ??
      options.delegate?.directorSessionStore ??
      new DirectorSessionStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });

    this.sessionEngine =
      options.sessionEngine ??
      new DirectorSessionEngine({
        store: this.sessionStore,
        workspaceRoot: this.workspaceRoot,
      });

    this.decisionStore =
      options.decisionStore ??
      options.delegate?.directorDecisionStore ??
      new DirectorDecisionStore({
        sessionStore: this.sessionStore,
        historyManager: this.historyManager,
      });
  }

  /**
   * Validates human approval input against actor authority, session state,
   * context snapshot freshness/completeness, and package revision binding.
   * Returns a structured validation result without throwing.
   */
  async validateApproval(
    input: ValidateHumanApprovalInput
  ): Promise<HumanApprovalValidationResult> {
    // 1. Zod schema validation
    const parsed = ValidateHumanApprovalInputZodSchema.safeParse(input);
    if (!parsed.success) {
      return {
        isValid: false,
        code: 'VALIDATION_ERROR',
        message: `Invalid human approval input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        details: { issues: parsed.error.issues },
      };
    }

    // 2. Strict Actor validation
    const actor = input.actor.trim();
    const normalizedActor = actor.toUpperCase();

    // Check if actor is Director
    if (
      normalizedActor === 'DIRECTOR' ||
      normalizedActor.includes('DIRECTOR') ||
      (input.actorRole as string) === 'DIRECTOR'
    ) {
      return {
        isValid: false,
        code: 'ACTOR_UNAUTHORIZED',
        message:
          "Director actor cannot grant approval. Approval authority strictly belongs to human Product Owner ('PRODUCT_OWNER' or 'USER').",
        details: { actor: input.actor, actorRole: input.actorRole },
      };
    }

    // Check if actor is Executor / Antigravity
    if (
      normalizedActor === 'EXECUTOR' ||
      normalizedActor === 'ANTIGRAVITY' ||
      normalizedActor.includes('EXECUTOR') ||
      normalizedActor.includes('ANTIGRAVITY')
    ) {
      return {
        isValid: false,
        code: 'SECURITY_VIOLATION',
        message:
          "Antigravity executor ('EXECUTOR') is strictly prohibited from granting approval or authorizing development.",
        details: { actor: input.actor, actorRole: input.actorRole },
      };
    }

    // Check all other forbidden actors
    for (const forbidden of FORBIDDEN_APPROVAL_ACTORS) {
      if (normalizedActor === forbidden || normalizedActor.includes(forbidden)) {
        return {
          isValid: false,
          code: 'ACTOR_UNAUTHORIZED',
          message: `Unauthorized approval actor: '${input.actor}'. Forbidden actor category: ${forbidden}.`,
          details: { actor: input.actor, forbiddenActor: forbidden },
        };
      }
    }

    // Check role strictly human PO
    if (input.actorRole !== 'PRODUCT_OWNER' && input.actorRole !== 'USER') {
      return {
        isValid: false,
        code: 'ACTOR_UNAUTHORIZED',
        message: `Invalid actorRole '${input.actorRole}'. Must strictly be 'PRODUCT_OWNER' or 'USER'.`,
        details: { actorRole: input.actorRole },
      };
    }

    // 3. Strict Intent validation: reject natural language signals
    if (input.intent !== 'EXPLICIT_APPROVAL') {
      return {
        isValid: false,
        code: 'INTENT_INVALID',
        message:
          "Approval intent must strictly be 'EXPLICIT_APPROVAL'. Natural-language signals ('tamam', 'anladım', 'devam') and clarification answers are NOT approval.",
        details: { intent: input.intent },
      };
    }

    // 4. Resolve and validate canonical project identity
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        return {
          isValid: false,
          code: 'PROJECT_BINDING_MISMATCH',
          message: `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project approval rejected.`,
          details: {
            specifiedProjectId: trimmed,
            canonicalProjectId: canonical.projectId,
            canonicalProjectRoot: canonical.projectRoot,
          },
        };
      }
    }

    // 5. Resolve and validate Director session
    let session;
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
        details: { directorSessionId: input.directorSessionId },
      };
    }

    // Session must be ACTIVE
    if (session.status !== 'ACTIVE') {
      return {
        isValid: false,
        code: 'SESSION_NOT_ACTIVE',
        message: `Director session '${session.directorSessionId}' is ${session.status}. Approvals can only be bound to an ACTIVE Director session.`,
        details: { directorSessionId: session.directorSessionId, status: session.status },
      };
    }

    // Validate project binding on session
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

    // 6. Context snapshot validation: fingerprint, staleness, completeness
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!latestSnapshot) {
      return {
        isValid: false,
        code: 'CONTEXT_NOT_FOUND',
        message: `No context snapshot found for Director session '${session.directorSessionId}'. Context synchronization must precede approval.`,
        details: { directorSessionId: session.directorSessionId },
      };
    }

    // Check fingerprint match
    if (latestSnapshot.logicalFingerprint !== input.contextFingerprint) {
      return {
        isValid: false,
        code: 'CONTEXT_FINGERPRINT_MISMATCH',
        message: `Context fingerprint mismatch: approval is bound to fingerprint '${input.contextFingerprint}', but latest context snapshot fingerprint is '${latestSnapshot.logicalFingerprint}'. Context has changed; resynchronization and re-review required.`,
        details: {
          specifiedFingerprint: input.contextFingerprint,
          latestFingerprint: latestSnapshot.logicalFingerprint,
        },
      };
    }

    // Check staleness
    if (latestSnapshot.syncStatus === 'STALE' || latestSnapshot.staleSections.length > 0) {
      return {
        isValid: false,
        code: 'CONTEXT_STALE',
        message: `Context snapshot is stale (stale sections: ${latestSnapshot.staleSections.join(', ')}). Approval cannot be granted on a stale context snapshot.`,
        details: { staleSections: latestSnapshot.staleSections },
      };
    }

    // Check completeness
    if (
      latestSnapshot.syncStatus === 'INCOMPLETE' ||
      !latestSnapshot.isComplete ||
      latestSnapshot.unavailableSections.length > 0
    ) {
      return {
        isValid: false,
        code: 'CONTEXT_INCOMPLETE',
        message: `Context snapshot is incomplete (unavailable sections: ${latestSnapshot.unavailableSections.join(', ')}). Approval cannot be granted on an incomplete context snapshot.`,
        details: { unavailableSections: latestSnapshot.unavailableSections },
      };
    }

    // 7. Understanding revision validation
    if (
      session.understandingRevision !== null &&
      session.understandingRevision !== undefined
    ) {
      if (
        input.understandingRevision !== undefined &&
        input.understandingRevision !== null &&
        input.understandingRevision !== session.understandingRevision
      ) {
        return {
          isValid: false,
          code: 'UNDERSTANDING_REVISION_MISMATCH',
          message: `Understanding revision mismatch: approval specifies revision ${input.understandingRevision}, but session understanding revision is ${session.understandingRevision}.`,
          details: {
            specifiedUnderstandingRevision: input.understandingRevision,
            sessionUnderstandingRevision: session.understandingRevision,
          },
        };
      }
    }

    // 8. Approval Package & Revision validation
    let pkg: ProjectApprovalPackage | null = null;
    try {
      pkg = await this.approvalStore.loadPackage(input.packageId);
    } catch {
      // ignore
    }

    if (!pkg) {
      return {
        isValid: false,
        code: 'PACKAGE_NOT_FOUND',
        message: `Approval package '${input.packageId}' not found.`,
        details: { packageId: input.packageId },
      };
    }

    // Check package project identity
    if (pkg.projectId !== canonical.projectId) {
      return {
        isValid: false,
        code: 'PROJECT_BINDING_MISMATCH',
        message: `Approval package '${pkg.packageId}' is bound to project '${pkg.projectId}', not canonical project '${canonical.projectId}'.`,
        details: { packageProjectId: pkg.projectId, canonicalProjectId: canonical.projectId },
      };
    }

    // Check revision binding
    if (pkg.revision !== input.revision) {
      return {
        isValid: false,
        code: 'APPROVAL_REVISION_MISMATCH',
        message: `Approval revision mismatch: package revision is ${pkg.revision}, but approval specifies revision ${input.revision}. Approvals must bind to the exact revision.`,
        details: { currentRevision: pkg.revision, requestedRevision: input.revision },
      };
    }

    // Replay / Duplicate approval protection
    if (pkg.status === 'APPROVED') {
      return {
        isValid: false,
        code: 'APPROVAL_ALREADY_DECIDED',
        message: `Package '${pkg.packageId}' revision ${pkg.revision} is already APPROVED. Duplicate approval or revision replay rejected.`,
        details: {
          packageId: pkg.packageId,
          revision: pkg.revision,
          status: pkg.status,
          approvedAt: pkg.approvalRecord?.approvedAt,
        },
      };
    }

    if (pkg.status === 'REJECTED' || pkg.status === 'SUPERSEDED') {
      return {
        isValid: false,
        code: 'APPROVAL_ALREADY_DECIDED',
        message: `Cannot approve package '${pkg.packageId}': package is already in status '${pkg.status}'.`,
        details: { packageId: pkg.packageId, status: pkg.status, revision: pkg.revision },
      };
    }

    if (pkg.status === 'NOT_READY') {
      const readiness = this.approvalPackageEngine.checkReadiness(
        pkg.projectUnderstanding,
        pkg.proposedDevelopmentPlan
      );
      return {
        isValid: false,
        code: 'PACKAGE_NOT_READY',
        message: `Cannot approve package '${pkg.packageId}': package is in status NOT_READY. Reasons: ${readiness.reasons.join('; ')}`,
        details: { packageId: pkg.packageId, revision: pkg.revision, reasons: readiness.reasons },
      };
    }

    return {
      isValid: true,
      code: 'VALID',
      message: 'Human approval validation passed.',
    };
  }

  /**
   * Applies explicit human Product Owner approval to the package, binding it
   * to Director session, context fingerprint, and understanding revision.
   *
   * INVARIANTS:
   * - Does NOT create tasks in Task DAG.
   * - Does NOT invoke Antigravity execution.
   * - Does NOT start autonomous loop.
   * - Does NOT mutate DurableStateManager FSM.
   */
  async submitApproval(input: SubmitHumanApprovalInput): Promise<HumanApprovalResult> {
    // 1. Zod input validation
    const parsedInput = SubmitHumanApprovalInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new HumanApprovalValidationError(
        `Invalid human approval submit input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    // 2. Validate approval preconditions
    const validation = await this.validateApproval(input);
    if (!validation.isValid) {
      // Record failure audit event if history manager available
      if (this.historyManager) {
        try {
          await this.historyManager.appendEvent({
            eventType: 'HUMAN_APPROVAL_REJECTED',
            actor: Actor.USER,
            payload: {
              packageId: input.packageId,
              revision: input.revision,
              directorSessionId: input.directorSessionId,
              contextFingerprint: input.contextFingerprint,
              code: validation.code,
              reason: validation.message,
            },
          });
        } catch {
          // ignore audit failure
        }
      }

      // Map validation code to deterministic domain error
      switch (validation.code) {
        case 'ACTOR_UNAUTHORIZED':
          throw new HumanApprovalUnauthorizedActorError(validation.message, validation.details);
        case 'SECURITY_VIOLATION':
          throw new DirectorSecurityError(validation.message, validation.details);
        case 'INTENT_INVALID':
          throw new ApprovalInvalidIntentError(validation.message, validation.details);
        case 'PROJECT_BINDING_MISMATCH':
          throw new HumanApprovalProjectBindingMismatchError(validation.message, validation.details);
        case 'SESSION_INVALID':
          throw new DirectorSessionNotFoundError(input.directorSessionId, validation.details);
        case 'SESSION_NOT_ACTIVE':
          throw new DirectorInvalidTransitionError(
            (validation.details?.status as string) ?? 'INACTIVE',
            'APPROVAL',
            { reason: validation.message, ...validation.details }
          );
        case 'CONTEXT_NOT_FOUND':
        case 'CONTEXT_FINGERPRINT_MISMATCH':
          throw new HumanApprovalContextMismatchError(validation.message, validation.details);
        case 'CONTEXT_STALE':
          throw new HumanApprovalContextStaleError(validation.message, validation.details);
        case 'CONTEXT_INCOMPLETE':
          throw new HumanApprovalContextIncompleteError(validation.message, validation.details);
        case 'UNDERSTANDING_REVISION_MISMATCH':
          throw new HumanApprovalRevisionMismatchError(validation.message, validation.details);
        case 'APPROVAL_REVISION_MISMATCH':
          throw new ApprovalRevisionMismatchError(validation.message, validation.details);
        case 'APPROVAL_ALREADY_DECIDED':
          throw new HumanApprovalReplayError(validation.message, validation.details);
        case 'PACKAGE_NOT_FOUND':
          throw new ApprovalPackageNotFoundError(validation.message, validation.details);
        case 'PACKAGE_NOT_READY':
          throw new ApprovalNotReadyError(
            validation.message,
            (validation.details?.reasons as readonly string[]) ?? [],
            validation.details
          );
        default:
          throw new HumanApprovalValidationError(validation.message, validation.details);
      }
    }

    // 3. Load authoritative package from ApprovalStore
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);
    const pkg = await this.approvalStore.loadPackage(input.packageId);
    if (!pkg) {
      throw new ApprovalPackageNotFoundError(`Package '${input.packageId}' not found.`);
    }

    // 4. Delegate to ApprovalPackageEngine to construct approved package
    const approvedPkg = this.approvalPackageEngine.approvePackage(pkg, {
      packageId: input.packageId,
      revision: input.revision,
      actor: input.actor,
      actorRole: input.actorRole as ApprovalActorRole,
      intent: input.intent as 'EXPLICIT_APPROVAL',
      comment: input.comment,
      timestamp: input.timestamp,
      directorSessionId: input.directorSessionId,
      contextFingerprint: input.contextFingerprint,
      understandingRevision: input.understandingRevision ?? null,
      protocolVersion: HUMAN_APPROVAL_PROTOCOL_VERSION,
      schemaVersion: HUMAN_APPROVAL_SCHEMA_VERSION,
    });

    // 5. Persist approved package in ApprovalStore (sole store authority)
    await this.approvalStore.savePackage(approvedPkg);

    // 6. Touch Director session activity
    await this.sessionEngine.touchSession({
      directorSessionId: input.directorSessionId,
      workspaceRoot: targetRoot,
      projectId: canonical.projectId,
    });

    // 7. Calculate authoritative development authorization state
    const authorized = this.approvalPackageEngine.isDevelopmentAuthorized(approvedPkg);

    // 8. Log audit event
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'HUMAN_APPROVAL_GRANTED',
          actor: Actor.USER,
          payload: {
            packageId: approvedPkg.packageId,
            revision: approvedPkg.revision,
            projectId: approvedPkg.projectId,
            directorSessionId: input.directorSessionId,
            contextFingerprint: input.contextFingerprint,
            understandingRevision: input.understandingRevision ?? null,
            actor: input.actor,
            actorRole: input.actorRole,
            packageHash: approvedPkg.approvalRecord?.packageHash,
            approvedAt: approvedPkg.approvalRecord?.approvedAt,
            isDevelopmentAuthorized: authorized,
            protocolVersion: HUMAN_APPROVAL_PROTOCOL_VERSION,
            schemaVersion: HUMAN_APPROVAL_SCHEMA_VERSION,
          },
        });
      } catch {
        // Logging failure does not abort approval
      }
    }

    return {
      package: approvedPkg,
      isDevelopmentAuthorized: authorized,
      approvalRecord: approvedPkg.approvalRecord!,
      protocolVersion: HUMAN_APPROVAL_PROTOCOL_VERSION,
      schemaVersion: HUMAN_APPROVAL_SCHEMA_VERSION,
      verifiedBindings: {
        projectId: canonical.projectId,
        directorSessionId: input.directorSessionId,
        contextFingerprint: input.contextFingerprint,
        understandingRevision: input.understandingRevision ?? null,
        approvalRevision: input.revision,
      },
    };
  }

  /**
   * Evaluates whether development resume is authorized under the P9-04 protocol.
   *
   * RULES:
   * 1. Resume CANNOT happen without explicit Human/Product Owner approval.
   * 2. Director 'RESUME' decision does NOT grant implementation authorization or substitute for PO approval.
   * 3. Requires active Director session, fresh non-stale complete context snapshot.
   * 4. Context fingerprint must match the fingerprint bound to the human approval.
   * 5. Does NOT mutate Task DAG, invoke Antigravity, or start autonomous loops.
   */
  async evaluateResume(input: EvaluateResumeInput): Promise<ResumeEvaluationResult> {
    const parsed = EvaluateResumeInputZodSchema.safeParse(input);
    if (!parsed.success) {
      return {
        canResume: false,
        code: 'VALIDATION_ERROR',
        message: `Invalid resume evaluation input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        isDevelopmentAuthorized: false,
        details: { issues: parsed.error.issues },
      };
    }

    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        return {
          canResume: false,
          code: 'PROJECT_BINDING_MISMATCH',
          message: `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}'.`,
          isDevelopmentAuthorized: false,
          details: { specifiedProjectId: trimmed, canonicalProjectId: canonical.projectId },
        };
      }
    }

    // 1. Resolve Director session
    let session;
    try {
      session = await this.sessionEngine.getSession(input.directorSessionId, {
        workspaceRoot: targetRoot,
        projectId: canonical.projectId,
      });
    } catch (err) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_SESSION_INACTIVE',
        message: `Director session '${input.directorSessionId}' cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
        isDevelopmentAuthorized: false,
      };
    }

    if (session.status !== 'ACTIVE') {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_SESSION_INACTIVE',
        message: `Director session '${session.directorSessionId}' is ${session.status}. Resume requires an ACTIVE Director session.`,
        isDevelopmentAuthorized: false,
        directorSession: session,
      };
    }

    // 2. Resolve Context snapshot
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!latestSnapshot) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_CONTEXT_STALE',
        message: `No context snapshot found for session '${session.directorSessionId}'. Context must be synchronized before resume.`,
        isDevelopmentAuthorized: false,
        directorSession: session,
      };
    }

    if (latestSnapshot.syncStatus === 'STALE' || latestSnapshot.staleSections.length > 0) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_CONTEXT_STALE',
        message: `Context snapshot is stale (stale sections: ${latestSnapshot.staleSections.join(', ')}). Resume is blocked on stale context.`,
        isDevelopmentAuthorized: false,
        directorSession: session,
        contextFingerprint: latestSnapshot.logicalFingerprint,
      };
    }

    if (
      latestSnapshot.syncStatus === 'INCOMPLETE' ||
      !latestSnapshot.isComplete ||
      latestSnapshot.unavailableSections.length > 0
    ) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_CONTEXT_INCOMPLETE',
        message: `Context snapshot is incomplete (unavailable sections: ${latestSnapshot.unavailableSections.join(', ')}). Resume is blocked on incomplete context.`,
        isDevelopmentAuthorized: false,
        directorSession: session,
        contextFingerprint: latestSnapshot.logicalFingerprint,
      };
    }

    // 3. Check Director decision if referenced
    let directorDecision = null;
    if (input.directorDecisionId) {
      try {
        directorDecision = await this.decisionStore.loadDecision(input.directorDecisionId);
      } catch {
        // ignore
      }

      if (directorDecision) {
        // Verify decision actor is DIRECTOR and has NO implementation authority
        if (directorDecision.actor !== Actor.DIRECTOR || directorDecision.hasImplementationAuthority !== false) {
          return {
            canResume: false,
            code: 'RESUME_BLOCKED_UNAUTHORIZED_ACTOR',
            message: 'Referenced Director decision violates authority constraints.',
            isDevelopmentAuthorized: false,
            directorSession: session,
            directorDecision,
          };
        }
      }
    }

    // 4. Resolve Approval Package from ApprovalStore
    const pkg = input.packageId
      ? await this.approvalStore.loadPackage(input.packageId, input.revision)
      : await this.approvalStore.getActivePackage();

    if (!pkg) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_NO_APPROVAL',
        message: 'Cannot resume: No project approval package found. Explicit human Product Owner approval is required.',
        isDevelopmentAuthorized: false,
        directorSession: session,
        contextFingerprint: latestSnapshot.logicalFingerprint,
        directorDecision,
      };
    }

    // 5. Authoritative development authorization check
    const isAuthorized = this.approvalPackageEngine.isDevelopmentAuthorized(pkg);
    if (!isAuthorized || pkg.status !== 'APPROVED' || !pkg.approvalRecord) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_NO_APPROVAL',
        message: `Cannot resume: Package '${pkg.packageId}' is in status '${pkg.status}'. Development is unauthorized without explicit human Product Owner approval. Director decision does NOT grant implementation authority.`,
        isDevelopmentAuthorized: false,
        approvedPackage: pkg,
        directorSession: session,
        contextFingerprint: latestSnapshot.logicalFingerprint,
        directorDecision,
      };
    }

    // 6. Verify Human approval record bindings
    const record = pkg.approvalRecord;

    // Check actor authority
    if (record.actorRole !== 'PRODUCT_OWNER' && record.actorRole !== 'USER') {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_UNAUTHORIZED_ACTOR',
        message: `Cannot resume: Approval was granted by unauthorized role '${record.actorRole}'. Only human Product Owner can authorize resume.`,
        isDevelopmentAuthorized: false,
        approvedPackage: pkg,
      };
    }

    // Check session binding if present
    if (record.directorSessionId && record.directorSessionId !== session.directorSessionId) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_SESSION_INACTIVE',
        message: `Approval is bound to Director session '${record.directorSessionId}', but current active session is '${session.directorSessionId}'.`,
        isDevelopmentAuthorized: true,
        approvedPackage: pkg,
        directorSession: session,
      };
    }

    // Check context fingerprint binding if present
    if (record.contextFingerprint && record.contextFingerprint !== latestSnapshot.logicalFingerprint) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_CONTEXT_MISMATCH',
        message: `Context snapshot has changed since human approval was granted (approval fingerprint: '${record.contextFingerprint}', current: '${latestSnapshot.logicalFingerprint}'). Resynchronization and human re-review required.`,
        isDevelopmentAuthorized: true,
        approvedPackage: pkg,
        directorSession: session,
        contextFingerprint: latestSnapshot.logicalFingerprint,
        details: {
          approvedFingerprint: record.contextFingerprint,
          currentFingerprint: latestSnapshot.logicalFingerprint,
        },
      };
    }

    // Check understanding revision if present
    if (
      record.understandingRevision !== undefined &&
      record.understandingRevision !== null &&
      session.understandingRevision !== null &&
      session.understandingRevision !== undefined &&
      record.understandingRevision !== session.understandingRevision
    ) {
      return {
        canResume: false,
        code: 'RESUME_BLOCKED_UNDERSTANDING_MISMATCH',
        message: `Understanding revision mismatch: approval is bound to understanding revision ${record.understandingRevision}, but current session revision is ${session.understandingRevision}.`,
        isDevelopmentAuthorized: true,
        approvedPackage: pkg,
        directorSession: session,
      };
    }

    // All resume conditions satisfied under P9-04 protocol
    return {
      canResume: true,
      code: 'RESUME_AUTHORIZED',
      message: 'Resume authorized: verified explicit human Product Owner approval and non-stale context bindings.',
      isDevelopmentAuthorized: true,
      approvedPackage: pkg,
      directorSession: session,
      contextFingerprint: latestSnapshot.logicalFingerprint,
      directorDecision,
      details: {
        packageId: pkg.packageId,
        revision: pkg.revision,
        approvedAt: record.approvedAt,
        actor: record.actor,
        actorRole: record.actorRole,
        protocolVersion: RESUME_PROTOCOL_VERSION,
        schemaVersion: RESUME_SCHEMA_VERSION,
      },
    };
  }
}
