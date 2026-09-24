/**
 * Execution Intent & Authorization Boundary Engine (Phase 10 TASK-P10-01)
 *
 * Implements the authoritative validation boundary between Director decisions
 * and implementation execution. Verifies session state, decision bindings,
 * context snapshot freshness/completeness, understanding revision,
 * Product Owner development authorization, and task DAG readiness.
 *
 * STRICT GOVERNANCE RULES:
 * 1. Director decision NEVER substitutes for Product Owner approval.
 * 2. Director CANNOT produce implementation authorization.
 * 3. Requires explicit isDevelopmentAuthorized() === true from ApprovalPackageEngine.
 * 4. Task must exist and be in executable state (e.g. READY with met dependencies).
 * 5. Rejects stale or incomplete context snapshots.
 * 6. Does NOT invoke Antigravity or spawn any OS processes (NO EXECUTION).
 * 7. Does NOT mutate Task DAG, SpecStore, or DurableStateManager global FSM.
 * 8. Zero parallel authority: reuses existing stores, engines, and domain models.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { SpecStore } from '../storage/spec-store.js';
import { HistoryManager } from '../storage/history-manager.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import { DirectorSessionStore } from './director-session-store.js';
import { DirectorSessionEngine } from './director-session-engine.js';
import { DirectorDecisionStore } from './director-decision-store.js';
import {
  resolveCanonicalProjectIdentity,
  validateProjectBinding,
} from './project-identity-resolver.js';
import {
  EXECUTION_INTENT_PROTOCOL_VERSION,
  EXECUTION_INTENT_SCHEMA_VERSION,
  type ExecutionIntent,
  type ValidateExecutionIntentInput,
  type ExecutionIntentValidationResult,
  ValidateExecutionIntentInputZodSchema,
} from './execution-intent-types.js';
import {
  ExecutionIntentValidationError,
  ExecutionIntentUnauthorizedError,
  ExecutionIntentSessionMismatchError,
  ExecutionIntentProjectMismatchError,
  ExecutionIntentContextMismatchError,
  ExecutionIntentContextStaleError,
  ExecutionIntentContextIncompleteError,
  ExecutionIntentRevisionMismatchError,
  ExecutionIntentTaskInvalidError,
  ExecutionIntentDecisionInvalidError,
} from './director-errors.js';

export interface ExecutionAuthorizerOptions {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly decisionStore?: DirectorDecisionStore;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly specStore?: SpecStore;
  readonly dagEngine?: TaskDagEngine;
  readonly historyManager?: HistoryManager;
}

export class ExecutionAuthorizer {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly sessionStore: DirectorSessionStore;
  readonly sessionEngine: DirectorSessionEngine;
  readonly decisionStore: DirectorDecisionStore;
  readonly approvalStore: ApprovalStore;
  readonly approvalPackageEngine: ApprovalPackageEngine;
  readonly specStore: SpecStore;
  readonly dagEngine: TaskDagEngine;
  readonly historyManager?: HistoryManager;

  constructor(options: ExecutionAuthorizerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.delegate = options.delegate;
    this.historyManager = options.historyManager ?? options.delegate?.historyManager;

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

    this.approvalStore =
      options.approvalStore ??
      options.delegate?.approvalStore ??
      new ApprovalStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });

    this.approvalPackageEngine =
      options.approvalPackageEngine ?? new ApprovalPackageEngine();

    this.specStore =
      options.specStore ??
      options.delegate?.specStore ??
      new SpecStore({ baseDir: this.workspaceRoot });

    this.dagEngine =
      options.dagEngine ?? options.delegate?.dagEngine ?? new TaskDagEngine();
  }

  /**
   * Generates a deterministic intentId derived from project, decision, task, and context fingerprint.
   * Format: intent-<sha256(projectId:directorDecisionId:taskId:contextFingerprint)[:16]>
   */
  generateIntentId(
    projectId: string,
    decisionId: string,
    taskId: string,
    contextFingerprint: string
  ): string {
    const raw = `${projectId}:${decisionId}:${taskId}:${contextFingerprint}`;
    const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
    return `intent-${hash}`;
  }

  /**
   * Validates an execution intent against all authoritative boundaries:
   * 1. Director Session: Active, correct project.
   * 2. Director Decision: Exists, matches session/project, strictly IMPLEMENT_TASK decisionType,
   *    and decision's own bindings (contextFingerprint, understandingRevision, approvalRevision) match.
   * 3. Director Context Snapshot: Fresh, complete, matching fingerprint.
   * 4. Understanding Revision: Authoritative session revision matches intent revision and decision revision.
   * 5. Approval & Development Authorization: isDevelopmentAuthorized() === true, exact revision match.
   * 6. Task DAG: Task exists in authoritative Task DAG (validated via TaskDagEngine), valid executable state,
   *    all dependencies satisfied (ACCEPTED), and exact taskRevision match.
   * 7. Cross-project protection.
   *
   * Non-mutating: does NOT invoke executor, mutate task state, or modify FSM.
   */
  async validateExecutionIntent(
    input: ValidateExecutionIntentInput
  ): Promise<ExecutionIntentValidationResult> {
    // 1. Zod input schema validation
    const parsed = ValidateExecutionIntentInputZodSchema.safeParse(input);
    if (!parsed.success) {
      return {
        isValid: false,
        code: 'VALIDATION_ERROR',
        message: `Invalid execution intent input: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        details: { issues: parsed.error.issues },
      };
    }

    // 2. Operation type constraint: P10-01 only authorizes IMPLEMENT_TASK
    const operationType = input.operationType ?? 'IMPLEMENT_TASK';
    if (operationType !== 'IMPLEMENT_TASK') {
      return {
        isValid: false,
        code: 'DECISION_TYPE_INVALID',
        message: `Execution operation type '${operationType}' is not authorized in P10-01. Only 'IMPLEMENT_TASK' is supported at this execution boundary.`,
        details: { operationType },
      };
    }

    // 3. Canonical project identity resolution
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        return {
          isValid: false,
          code: 'PROJECT_BINDING_MISMATCH',
          message: `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project execution rejected.`,
          details: {
            specifiedProjectId: trimmed,
            canonicalProjectId: canonical.projectId,
            canonicalProjectRoot: canonical.projectRoot,
          },
        };
      }
    }

    // 4. Director Session validation
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

    if (session.status !== 'ACTIVE') {
      return {
        isValid: false,
        code: 'SESSION_NOT_ACTIVE',
        message: `Director session '${session.directorSessionId}' is ${session.status}. Execution requires an ACTIVE Director session.`,
        details: { directorSessionId: session.directorSessionId, status: session.status },
      };
    }

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

    // 5. Director Decision validation
    let decision;
    try {
      decision = await this.decisionStore.loadDecision(input.directorDecisionId);
    } catch (err) {
      return {
        isValid: false,
        code: 'DECISION_INVALID',
        message: `Failed to load Director decision '${input.directorDecisionId}': ${err instanceof Error ? err.message : String(err)}`,
        details: { directorDecisionId: input.directorDecisionId },
      };
    }

    if (!decision) {
      return {
        isValid: false,
        code: 'DECISION_INVALID',
        message: `Director decision '${input.directorDecisionId}' was not found. Execution requires an authoritative Director decision.`,
        details: { directorDecisionId: input.directorDecisionId },
      };
    }

    if (decision.directorSessionId !== session.directorSessionId) {
      return {
        isValid: false,
        code: 'DECISION_SESSION_MISMATCH',
        message: `Director decision '${decision.decisionId}' is bound to session '${decision.directorSessionId}', but execution was requested under session '${session.directorSessionId}'.`,
        details: {
          decisionSessionId: decision.directorSessionId,
          requestedSessionId: session.directorSessionId,
        },
      };
    }

    if (decision.projectId !== canonical.projectId) {
      return {
        isValid: false,
        code: 'DECISION_PROJECT_MISMATCH',
        message: `Director decision '${decision.decisionId}' is bound to project '${decision.projectId}', not canonical project '${canonical.projectId}'.`,
        details: {
          decisionProjectId: decision.projectId,
          canonicalProjectId: canonical.projectId,
        },
      };
    }

    // Decision type must strictly be IMPLEMENT_TASK in P10-01 (RESUME is rejected)
    if (decision.decisionType !== 'IMPLEMENT_TASK') {
      return {
        isValid: false,
        code: 'DECISION_TYPE_INVALID',
        message: `Director decision type '${decision.decisionType}' cannot form an execution intent. Only 'IMPLEMENT_TASK' is execution-eligible at the Phase 10 execution boundary. RESUME is not an execution intent.`,
        details: { decisionType: decision.decisionType },
      };
    }

    // Decision must not falsely claim implementation authority
    if (decision.hasImplementationAuthority !== false) {
      return {
        isValid: false,
        code: 'SECURITY_VIOLATION',
        message: 'Director decision violates authority boundary: hasImplementationAuthority must be strictly false.',
      };
    }

    // 6. Director Context Snapshot validation
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!latestSnapshot) {
      return {
        isValid: false,
        code: 'CONTEXT_NOT_FOUND',
        message: `No context snapshot found for session '${session.directorSessionId}'. Context synchronization must precede execution.`,
        details: { directorSessionId: session.directorSessionId },
      };
    }

    if (latestSnapshot.logicalFingerprint !== input.contextFingerprint) {
      return {
        isValid: false,
        code: 'CONTEXT_FINGERPRINT_MISMATCH',
        message: `Context fingerprint mismatch: intent specifies '${input.contextFingerprint}', but authoritative snapshot fingerprint is '${latestSnapshot.logicalFingerprint}'. Context has changed; resynchronization required.`,
        details: {
          specifiedFingerprint: input.contextFingerprint,
          authoritativeFingerprint: latestSnapshot.logicalFingerprint,
        },
      };
    }

    if (latestSnapshot.syncStatus === 'STALE' || latestSnapshot.staleSections.length > 0) {
      return {
        isValid: false,
        code: 'CONTEXT_STALE',
        message: `Context snapshot is stale (stale sections: ${latestSnapshot.staleSections.join(', ')}). Execution cannot proceed on a stale context snapshot.`,
        details: { staleSections: latestSnapshot.staleSections },
      };
    }

    if (
      latestSnapshot.syncStatus === 'INCOMPLETE' ||
      !latestSnapshot.isComplete ||
      latestSnapshot.unavailableSections.length > 0
    ) {
      return {
        isValid: false,
        code: 'CONTEXT_INCOMPLETE',
        message: `Context snapshot is incomplete (unavailable sections: ${latestSnapshot.unavailableSections.join(', ')}). Execution cannot proceed on an incomplete context snapshot.`,
        details: { unavailableSections: latestSnapshot.unavailableSections },
      };
    }

    // Verify Decision's own context fingerprint matches authoritative snapshot
    if (decision.basedOnContextFingerprint !== latestSnapshot.logicalFingerprint) {
      return {
        isValid: false,
        code: 'CONTEXT_FINGERPRINT_MISMATCH',
        message: `Director decision was based on context fingerprint '${decision.basedOnContextFingerprint}', which does not match authoritative snapshot fingerprint '${latestSnapshot.logicalFingerprint}'. Decision was made on a different or stale context snapshot.`,
        details: {
          decisionContextFingerprint: decision.basedOnContextFingerprint,
          authoritativeFingerprint: latestSnapshot.logicalFingerprint,
        },
      };
    }

    // 7. Understanding Revision validation (Strict P9-04 binding rule)
    if (session.understandingRevision === null || session.understandingRevision === undefined) {
      return {
        isValid: false,
        code: 'UNDERSTANDING_REVISION_MISMATCH',
        message: `Director session '${session.directorSessionId}' has no authoritative understanding revision. Execution requires an authoritative understanding baseline.`,
        details: {
          sessionUnderstandingRevision: null,
          specifiedUnderstandingRevision: input.understandingRevision,
        },
      };
    }

    if (input.understandingRevision === undefined || input.understandingRevision === null) {
      return {
        isValid: false,
        code: 'UNDERSTANDING_REVISION_MISMATCH',
        message: `Understanding revision binding is mandatory: session understanding revision is ${session.understandingRevision}, but intent omitted understandingRevision.`,
        details: {
          sessionUnderstandingRevision: session.understandingRevision,
          specifiedUnderstandingRevision: null,
        },
      };
    }

    if (input.understandingRevision !== session.understandingRevision) {
      return {
        isValid: false,
        code: 'UNDERSTANDING_REVISION_MISMATCH',
        message: `Understanding revision mismatch: intent specifies revision ${input.understandingRevision}, but session understanding revision is ${session.understandingRevision}.`,
        details: {
          specifiedUnderstandingRevision: input.understandingRevision,
          sessionUnderstandingRevision: session.understandingRevision,
        },
      };
    }

    // Verify Decision's own understanding revision matches session understanding revision if present
    if (
      decision.basedOnUnderstandingRevision !== null &&
      decision.basedOnUnderstandingRevision !== undefined &&
      decision.basedOnUnderstandingRevision !== session.understandingRevision
    ) {
      return {
        isValid: false,
        code: 'UNDERSTANDING_REVISION_MISMATCH',
        message: `Director decision was based on understanding revision ${decision.basedOnUnderstandingRevision}, which does not match session understanding revision ${session.understandingRevision}.`,
        details: {
          decisionUnderstandingRevision: decision.basedOnUnderstandingRevision,
          sessionUnderstandingRevision: session.understandingRevision,
        },
      };
    }

    // 8. Approval & Development Authorization validation
    const pkg = await this.approvalStore.getActivePackage();
    if (!pkg) {
      return {
        isValid: false,
        code: 'APPROVAL_NOT_FOUND',
        message: 'No approval package found. Execution cannot proceed without explicit Product Owner approval.',
      };
    }

    if (pkg.projectId !== canonical.projectId) {
      return {
        isValid: false,
        code: 'APPROVAL_PROJECT_MISMATCH',
        message: `Approval package '${pkg.packageId}' belongs to project '${pkg.projectId}', not canonical project '${canonical.projectId}'.`,
        details: { packageProjectId: pkg.projectId, canonicalProjectId: canonical.projectId },
      };
    }

    if (pkg.status !== 'APPROVED' || !pkg.approvalRecord) {
      return {
        isValid: false,
        code: 'APPROVAL_INVALID',
        message: `Package '${pkg.packageId}' is in status '${pkg.status}'. Execution requires an APPROVED package with a valid approval record.`,
        details: { packageId: pkg.packageId, status: pkg.status },
      };
    }

    const record = pkg.approvalRecord;
    if (record.actorRole !== 'PRODUCT_OWNER' && record.actorRole !== 'USER') {
      return {
        isValid: false,
        code: 'APPROVAL_INVALID',
        message: `Approval record actor role '${record.actorRole}' is unauthorized. Only human Product Owner or User can grant approval.`,
        details: { actorRole: record.actorRole },
      };
    }

    if (record.intent !== 'EXPLICIT_APPROVAL') {
      return {
        isValid: false,
        code: 'APPROVAL_INVALID',
        message: `Approval intent must strictly be 'EXPLICIT_APPROVAL', found '${record.intent}'.`,
      };
    }

    // Authoritative development authorization check
    const isAuthorized = this.approvalPackageEngine.isDevelopmentAuthorized(pkg);
    if (!isAuthorized) {
      return {
        isValid: false,
        code: 'APPROVAL_NOT_AUTHORIZED',
        message: 'Development is not authorized under authoritative isDevelopmentAuthorized() boundary.',
      };
    }

    // Mandatory approval revision check: input.approvalPackageRevision must be provided and match pkg.revision exactly
    if (
      input.approvalPackageRevision === undefined ||
      input.approvalPackageRevision === null
    ) {
      return {
        isValid: false,
        code: 'APPROVAL_REVISION_MISMATCH',
        message: `Approval package revision binding is mandatory: active approved package revision is ${pkg.revision}, but intent omitted approvalPackageRevision.`,
        details: {
          specifiedRevision: null,
          activePackageRevision: pkg.revision,
        },
      };
    }

    if (input.approvalPackageRevision !== pkg.revision) {
      return {
        isValid: false,
        code: 'APPROVAL_REVISION_MISMATCH',
        message: `Approval revision mismatch: intent specifies revision ${input.approvalPackageRevision}, but active approved package revision is ${pkg.revision}.`,
        details: {
          specifiedRevision: input.approvalPackageRevision,
          activePackageRevision: pkg.revision,
        },
      };
    }

    // Verify Decision's own approval revision matches active package revision if present
    if (
      decision.basedOnApprovalRevision !== null &&
      decision.basedOnApprovalRevision !== undefined &&
      decision.basedOnApprovalRevision !== pkg.revision
    ) {
      return {
        isValid: false,
        code: 'APPROVAL_REVISION_MISMATCH',
        message: `Director decision was based on approval revision ${decision.basedOnApprovalRevision}, which does not match active approved package revision ${pkg.revision}.`,
        details: {
          decisionApprovalRevision: decision.basedOnApprovalRevision,
          activePackageRevision: pkg.revision,
        },
      };
    }

    // 9. Task DAG validation: Read tasks from authoritative SpecStore and validate structural integrity via TaskDagEngine
    let tasks: TaskDefinition[] = [];
    try {
      tasks = await this.specStore.loadTasks();
    } catch (err) {
      return {
        isValid: false,
        code: 'TASK_NOT_FOUND',
        message: `Failed to load tasks from SpecStore: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const task = tasks.find((t) => t.task_id === input.taskId);
    if (!task) {
      return {
        isValid: false,
        code: 'TASK_NOT_FOUND',
        message: `Task '${input.taskId}' not found in authoritative Task DAG.`,
        details: { taskId: input.taskId },
      };
    }

    // Mandatory Task revision check: task.metadata.revision is the authoritative task revision
    const taskRevision = (task.metadata?.revision as number) ?? 1;
    if (input.taskRevision === undefined || input.taskRevision === null) {
      return {
        isValid: false,
        code: 'TASK_REVISION_MISMATCH',
        message: `Task revision binding is mandatory: authoritative task revision is ${taskRevision}, but intent omitted taskRevision.`,
        details: {
          specifiedTaskRevision: null,
          currentTaskRevision: taskRevision,
        },
      };
    }

    if (input.taskRevision !== taskRevision) {
      return {
        isValid: false,
        code: 'TASK_REVISION_MISMATCH',
        message: `Task revision mismatch: intent specifies revision ${input.taskRevision}, but authoritative task revision is ${taskRevision}.`,
        details: {
          specifiedTaskRevision: input.taskRevision,
          currentTaskRevision: taskRevision,
        },
      };
    }

    // Task DAG structural integrity check
    if (tasks.length > 0) {
      try {
        this.dagEngine.assertValidGraph(tasks);
      } catch (err) {
        return {
          isValid: false,
          code: 'TASK_STATE_INVALID',
          message: `Task DAG structural integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Task state must be eligible for execution
    const validExecutionStates = ['READY', 'IN_PROGRESS'];
    if (!validExecutionStates.includes(task.status)) {
      return {
        isValid: false,
        code: 'TASK_STATE_INVALID',
        message: `Task '${task.task_id}' is in status '${task.status}'. Only tasks in 'READY' or 'IN_PROGRESS' status can be authorized for execution.`,
        details: { taskId: task.task_id, status: task.status },
      };
    }

    // Task dependencies must all be satisfied (ACCEPTED)
    if (task.dependencies && task.dependencies.length > 0) {
      const unmetDependencies = task.dependencies.filter((depId) => {
        const depTask = tasks.find((t) => t.task_id === depId);
        return !depTask || depTask.status !== 'ACCEPTED';
      });

      if (unmetDependencies.length > 0) {
        return {
          isValid: false,
          code: 'TASK_STATE_INVALID',
          message: `Task '${task.task_id}' has unmet dependencies: ${unmetDependencies.join(', ')}. All prerequisite tasks must be ACCEPTED prior to execution.`,
          details: { taskId: task.task_id, unmetDependencies },
        };
      }
    }

    // 10. Construct verified ExecutionIntent
    const intentId =
      input.intentId ??
      this.generateIntentId(
        canonical.projectId,
        decision.decisionId,
        task.task_id,
        latestSnapshot.logicalFingerprint
      );

    const intent: ExecutionIntent = {
      intentId,
      directorSessionId: session.directorSessionId,
      directorDecisionId: decision.decisionId,
      projectId: canonical.projectId,
      taskId: task.task_id,
      taskRevision,
      contextFingerprint: latestSnapshot.logicalFingerprint,
      understandingRevision: session.understandingRevision,
      approvalPackageRevision: pkg.revision,
      operationType: 'IMPLEMENT_TASK',
      protocolVersion: EXECUTION_INTENT_PROTOCOL_VERSION,
      schemaVersion: EXECUTION_INTENT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };

    return {
      isValid: true,
      code: 'VALID',
      message: 'Execution intent is fully authorized and verified across all boundaries.',
      intent,
      verifiedBindings: {
        projectId: canonical.projectId,
        directorSessionId: session.directorSessionId,
        directorDecisionId: decision.decisionId,
        taskId: task.task_id,
        taskRevision,
        contextFingerprint: latestSnapshot.logicalFingerprint,
        understandingRevision: session.understandingRevision,
        approvalPackageRevision: pkg.revision,
      },
    };
  }

  /**
   * Creates and verifies an ExecutionIntent. Throws specific domain error if validation fails.
   * Records DIRECTOR_DECISION_VALIDATION_FAILED audit event upon failure.
   * INVARIANT: Does NOT emit EXECUTION_REQUESTED at this stage; execution request dispatch
   * is reserved for P10-02+.
   */
  async createExecutionIntent(input: ValidateExecutionIntentInput): Promise<ExecutionIntent> {
    const result = await this.validateExecutionIntent(input);
    if (!result.isValid) {
      if (this.historyManager) {
        try {
          await this.historyManager.appendEvent({
            eventType: 'DIRECTOR_DECISION_VALIDATION_FAILED',
            actor: Actor.DIRECTOR,
            payload: {
              code: result.code,
              message: result.message,
              directorSessionId: input.directorSessionId,
              directorDecisionId: input.directorDecisionId,
              taskId: input.taskId,
            },
          });
        } catch {
          // ignore audit failure
        }
      }

      switch (result.code) {
        case 'PROJECT_BINDING_MISMATCH':
          throw new ExecutionIntentProjectMismatchError(result.message, result.details);
        case 'SESSION_INVALID':
        case 'SESSION_NOT_ACTIVE':
        case 'DECISION_SESSION_MISMATCH':
          throw new ExecutionIntentSessionMismatchError(result.message, result.details);
        case 'DECISION_INVALID':
        case 'DECISION_TYPE_INVALID':
        case 'DECISION_PROJECT_MISMATCH':
          throw new ExecutionIntentDecisionInvalidError(result.message, result.details);
        case 'CONTEXT_NOT_FOUND':
        case 'CONTEXT_FINGERPRINT_MISMATCH':
          throw new ExecutionIntentContextMismatchError(result.message, result.details);
        case 'CONTEXT_STALE':
          throw new ExecutionIntentContextStaleError(result.message, result.details);
        case 'CONTEXT_INCOMPLETE':
          throw new ExecutionIntentContextIncompleteError(result.message, result.details);
        case 'UNDERSTANDING_REVISION_MISMATCH':
        case 'APPROVAL_REVISION_MISMATCH':
        case 'TASK_REVISION_MISMATCH':
          throw new ExecutionIntentRevisionMismatchError(result.message, result.details);
        case 'APPROVAL_NOT_FOUND':
        case 'APPROVAL_INVALID':
        case 'APPROVAL_NOT_AUTHORIZED':
        case 'APPROVAL_PROJECT_MISMATCH':
          throw new ExecutionIntentUnauthorizedError(result.message, result.details);
        case 'TASK_NOT_FOUND':
        case 'TASK_PROJECT_MISMATCH':
        case 'TASK_STATE_INVALID':
          throw new ExecutionIntentTaskInvalidError(result.message, result.details);
        default:
          throw new ExecutionIntentValidationError(result.message, result.details);
      }
    }

    return result.intent!;
  }
}
