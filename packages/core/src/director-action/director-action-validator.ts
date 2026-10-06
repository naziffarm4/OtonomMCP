/**
 * @file director-action-validator.ts
 * @description Semantic validation and idempotency pipeline for Structured Director Actions (TASK-P19-01).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. STRICT ACTOR BOUNDARY: The caller cannot pose as Product Owner or bypass authorization.
 * 2. STALE CONTEXT DETECTION: Fail closed if action is based on an outdated fingerprint or revision.
 * 3. IDEMPOTENCY ENFORCEMENT: Duplicate actions with identical content return cached results.
 *    Conflicting duplicate keys are rejected with ERR_DIRECTOR_ACTION_IDEMPOTENCY_CONFLICT.
 * 4. DAG & LINEAGE VALIDATION: Task operations are validated against existing graph state.
 */

import {
  type DirectorActionEnvelope,
  type DirectorActionType,
  DirectorActionEnvelopeZodSchema,
  ImplementTaskPayloadSchema,
  RetryTaskPayloadSchema,
  CorrectTaskPayloadSchema,
  CreateTaskPayloadSchema,
  CreateCorrectiveTaskPayloadSchema,
  ReplanPayloadSchema,
  ReviewEvidencePayloadSchema,
  RequestHumanDecisionPayloadSchema,
  RequestClarificationPayloadSchema,
  DeclareProjectCompletePayloadSchema,
  LifecyclePayloadSchema,
  computePayloadHash,
  computeDeterministicActionId,
} from './director-action-types.js';
import {
  DirectorActionValidationError,
  DirectorActionImpersonationError,
  DirectorActionStaleContextError,
  DirectorActionIdempotencyConflictError,
  DirectorActionLineageError,
} from './director-action-errors.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';

export interface TaskSummaryInfo {
  readonly taskId: string;
  readonly status: string;
  readonly dependencies: readonly string[];
  readonly revision?: number;
}

export interface DirectorActionValidationContext {
  readonly currentFingerprint: string;
  readonly currentUnderstandingRevision: number;
  readonly currentDirectorSessionId: string;
  readonly currentProjectId: string;
  readonly existingTasks?: readonly TaskSummaryInfo[];
  readonly expectedApprovalRevision?: number;
  readonly actualApprovalRevision?: number;
  readonly expectedMandateRevision?: number;
  readonly actualMandateRevision?: number;
}

export interface DirectorActionIdempotencyRecord {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly actionType: DirectorActionType;
  readonly validatedAt: string;
}

export interface DirectorActionValidationResult {
  readonly isValid: boolean;
  readonly isDuplicate: boolean;
  readonly envelope: DirectorActionEnvelope;
  readonly typedPayload: unknown;
  readonly validatedAt: string;
}

export interface DirectorActionValidatorOptions {
  readonly historyManager?: HistoryManager;
}

export class DirectorActionValidator {
  private readonly idempotencyStore = new Map<string, DirectorActionIdempotencyRecord>();
  private readonly historyManager?: HistoryManager;
  private isHistoryInitialized = false;

  constructor(options?: DirectorActionValidatorOptions) {
    this.historyManager = options?.historyManager;
  }

  /**
   * Clears the idempotency cache (primarily for tests).
   */
  clearIdempotencyCache(): void {
    this.idempotencyStore.clear();
    this.isHistoryInitialized = false;
  }

  /**
   * Initializes the in-memory cache by reading authoritative events from HistoryManager.
   */
  async initializeFromHistory(): Promise<void> {
    if (!this.historyManager || this.isHistoryInitialized) return;
    try {
      const events = await this.historyManager.readEvents();
      for (const ev of events) {
        if (ev.eventType === 'DIRECTOR_ACTION_VALIDATED' && ev.payload) {
          const p = ev.payload as Record<string, unknown>;
          if (typeof p.idempotencyKey === 'string' && typeof p.payloadHash === 'string') {
            this.idempotencyStore.set(p.idempotencyKey, {
              actionId: String(p.actionId ?? ''),
              idempotencyKey: p.idempotencyKey,
              payloadHash: p.payloadHash,
              actionType: p.actionType as DirectorActionType,
              validatedAt: String(p.validatedAt || ev.timestamp),
            });
          }
        }
      }
    } catch {
      // Ignore if file doesn't exist yet
    }
    this.isHistoryInitialized = true;
  }

  /**
   * Asynchronous validation with persistent HistoryManager integration.
   */
  async validateAsync(
    raw: unknown,
    context: DirectorActionValidationContext
  ): Promise<DirectorActionValidationResult> {
    await this.initializeFromHistory();
    const result = this.validate(raw, context);

    if (!result.isDuplicate && this.historyManager) {
      const payloadHash = computePayloadHash(result.typedPayload);
      await this.historyManager.appendEvent({
        eventId: `act-${result.envelope.actionId}`,
        eventType: 'DIRECTOR_ACTION_VALIDATED',
        actor: Actor.DIRECTOR,
        taskId: (result.typedPayload as any)?.taskId ?? null,
        payload: {
          actionId: result.envelope.actionId,
          idempotencyKey: result.envelope.idempotencyKey,
          actionType: result.envelope.actionType,
          payloadHash,
          validatedAt: result.validatedAt,
        },
      });
    }

    return result;
  }

  /**
   * Validates raw envelope structure, semantic contracts, and context binding.
   */
  validate(
    raw: unknown,
    context: DirectorActionValidationContext
  ): DirectorActionValidationResult {
    // 1. Structural Schema Validation
    const parsedEnvelope = this.validateEnvelopeStructure(raw);

    // 2. Strict Actor & Anti-Impersonation Check
    this.validateActorBoundary(raw, parsedEnvelope);

    // 3. Project and Session Binding Check
    if (parsedEnvelope.projectId !== context.currentProjectId) {
      throw new DirectorActionValidationError(
        `Project ID mismatch: action bound to '${parsedEnvelope.projectId}', but active project is '${context.currentProjectId}'.`,
        { expectedProjectId: context.currentProjectId, actualProjectId: parsedEnvelope.projectId }
      );
    }

    if (parsedEnvelope.directorSessionId !== context.currentDirectorSessionId) {
      throw new DirectorActionValidationError(
        `Director session mismatch: action bound to session '${parsedEnvelope.directorSessionId}', but active session is '${context.currentDirectorSessionId}'.`,
        { expectedSessionId: context.currentDirectorSessionId, actualSessionId: parsedEnvelope.directorSessionId }
      );
    }

    // 4. Stale Context & Fingerprint Validation
    if (parsedEnvelope.basedOnContextFingerprint !== context.currentFingerprint) {
      throw new DirectorActionStaleContextError(
        `Stale context fingerprint: action is based on '${parsedEnvelope.basedOnContextFingerprint}', but current authoritative fingerprint is '${context.currentFingerprint}'.`,
        {
          expectedFingerprint: context.currentFingerprint,
          actionFingerprint: parsedEnvelope.basedOnContextFingerprint,
        }
      );
    }

    if (parsedEnvelope.understandingRevision !== context.currentUnderstandingRevision) {
      throw new DirectorActionStaleContextError(
        `Stale understanding revision: action revision is ${parsedEnvelope.understandingRevision}, but current authoritative revision is ${context.currentUnderstandingRevision}.`,
        {
          expectedRevision: context.currentUnderstandingRevision,
          actionRevision: parsedEnvelope.understandingRevision,
        }
      );
    }

    if (
      context.expectedApprovalRevision !== undefined &&
      context.actualApprovalRevision !== undefined &&
      context.expectedApprovalRevision !== context.actualApprovalRevision
    ) {
      throw new DirectorActionValidationError(
        `Approval revision mismatch: expected ${context.expectedApprovalRevision}, got ${context.actualApprovalRevision}.`,
        { expectedApprovalRevision: context.expectedApprovalRevision, actualApprovalRevision: context.actualApprovalRevision }
      );
    }

    if (
      context.expectedMandateRevision !== undefined &&
      context.actualMandateRevision !== undefined &&
      context.expectedMandateRevision !== context.actualMandateRevision
    ) {
      throw new DirectorActionValidationError(
        `Mandate revision mismatch: expected ${context.expectedMandateRevision}, got ${context.actualMandateRevision}.`,
        { expectedMandateRevision: context.expectedMandateRevision, actualMandateRevision: context.actualMandateRevision }
      );
    }

    // 5. Payload-Specific Schema & Semantic Validation
    const typedPayload = this.validateActionPayload(
      parsedEnvelope.actionType,
      parsedEnvelope.payload
    );

    // 6. Action ID Determinism Check
    const expectedActionId = computeDeterministicActionId({
      projectId: parsedEnvelope.projectId,
      directorSessionId: parsedEnvelope.directorSessionId,
      actionType: parsedEnvelope.actionType,
      idempotencyKey: parsedEnvelope.idempotencyKey,
    });

    if (parsedEnvelope.actionId !== expectedActionId) {
      throw new DirectorActionValidationError(
        `Action ID mismatch: expected deterministic ID '${expectedActionId}', got '${parsedEnvelope.actionId}'.`,
        { expectedActionId, actualActionId: parsedEnvelope.actionId }
      );
    }

    // 7. DAG Lineage Semantic Validation
    if (context.existingTasks) {
      this.validateDagLineage(parsedEnvelope.actionType, typedPayload, context.existingTasks);
    }

    // 8. Idempotency & Conflict Check
    const payloadHash = computePayloadHash(typedPayload);
    const existingRecord = this.idempotencyStore.get(parsedEnvelope.idempotencyKey);

    if (existingRecord) {
      if (existingRecord.payloadHash !== payloadHash) {
        throw new DirectorActionIdempotencyConflictError(
          `Idempotency conflict: key '${parsedEnvelope.idempotencyKey}' was already used with a different payload.`,
          {
            idempotencyKey: parsedEnvelope.idempotencyKey,
            existingActionId: existingRecord.actionId,
            currentActionId: parsedEnvelope.actionId,
          }
        );
      }

      return {
        isValid: true,
        isDuplicate: true,
        envelope: parsedEnvelope,
        typedPayload,
        validatedAt: existingRecord.validatedAt,
      };
    }

    // Record in idempotency cache
    const now = new Date().toISOString();
    this.idempotencyStore.set(parsedEnvelope.idempotencyKey, {
      actionId: parsedEnvelope.actionId,
      idempotencyKey: parsedEnvelope.idempotencyKey,
      payloadHash,
      actionType: parsedEnvelope.actionType,
      validatedAt: now,
    });

    return {
      isValid: true,
      isDuplicate: false,
      envelope: parsedEnvelope,
      typedPayload,
      validatedAt: now,
    };
  }

  // ============================================================================
  // INTERNAL VALIDATION HELPERS
  // ============================================================================

  private validateEnvelopeStructure(raw: unknown): DirectorActionEnvelope {
    const parseResult = DirectorActionEnvelopeZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new DirectorActionValidationError(
        `Director action envelope schema validation failed: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }
    return parseResult.data as DirectorActionEnvelope;
  }

  private validateActorBoundary(raw: unknown, envelope: DirectorActionEnvelope): void {
    const rawObj = raw as Record<string, unknown>;
    const rawActor = String(rawObj.actor ?? '').trim().toUpperCase();
    const rawRole = String(rawObj.actorRole ?? '').trim().toUpperCase();

    // Check for any attempt to claim human authority or bypass Director boundary
    if (rawRole === 'PRODUCT_OWNER' || rawRole === 'USER') {
      throw new DirectorActionImpersonationError(
        `Director action cannot claim actorRole '${rawRole}'. Director actions are proposals and must strictly have actorRole 'DIRECTOR'.`,
        { rawActor, rawRole }
      );
    }

    if (rawActor.includes('PRODUCT_OWNER') || rawActor.includes('OWNER') || rawActor.includes('SYSTEM')) {
      throw new DirectorActionImpersonationError(
        `Unauthorized actor name '${rawActor}'. Director actions cannot impersonate Product Owner or SYSTEM.`,
        { rawActor, rawRole }
      );
    }

    if (envelope.actor !== 'DIRECTOR' || envelope.actorRole !== 'DIRECTOR') {
      throw new DirectorActionImpersonationError(
        `Director action must strictly carry actor='DIRECTOR' and actorRole='DIRECTOR'. Got actor='${envelope.actor}', actorRole='${envelope.actorRole}'.`,
        { actor: envelope.actor, actorRole: envelope.actorRole }
      );
    }

    if (
      (envelope as any).hasImplementationAuthority === true ||
      (envelope as any).isDevelopmentAuthorized === true
    ) {
      throw new DirectorActionImpersonationError(
        'Director action envelope cannot claim implementation authority or development authorization directly.',
        { actor: envelope.actor, actorRole: envelope.actorRole }
      );
    }
  }

  private validateActionPayload(
    actionType: DirectorActionType,
    rawPayload: unknown
  ): unknown {
    if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
      const p = rawPayload as Record<string, unknown>;
      if (
        p.isDevelopmentAuthorized !== undefined ||
        p.hasImplementationAuthority !== undefined ||
        p.isTrustedHumanAuth !== undefined ||
        p.authStatus === 'VERIFIED_HUMAN' ||
        p.actor === 'USER' ||
        p.actorRole === 'PRODUCT_OWNER' ||
        p.selfApproved !== undefined ||
        p.claimImplementationAuthority !== undefined
      ) {
        throw new DirectorActionValidationError(
          'Payload contains prohibited authority claim fields (isDevelopmentAuthorized / hasImplementationAuthority / isTrustedHumanAuth / authStatus / selfApproved).'
        );
      }
    }

    let result: { success: boolean; data?: unknown; error?: { message: string; issues: unknown[] } };

    switch (actionType) {
      case 'IMPLEMENT_TASK':
        result = ImplementTaskPayloadSchema.safeParse(rawPayload);
        break;
      case 'RETRY_TASK':
        result = RetryTaskPayloadSchema.safeParse(rawPayload);
        break;
      case 'CORRECT_TASK':
        result = CorrectTaskPayloadSchema.safeParse(rawPayload);
        break;
      case 'CREATE_TASK':
        result = CreateTaskPayloadSchema.safeParse(rawPayload);
        break;
      case 'CREATE_CORRECTIVE_TASK':
        result = CreateCorrectiveTaskPayloadSchema.safeParse(rawPayload);
        break;
      case 'REPLAN':
        result = ReplanPayloadSchema.safeParse(rawPayload);
        break;
      case 'REVIEW_EVIDENCE':
        result = ReviewEvidencePayloadSchema.safeParse(rawPayload);
        break;
      case 'REQUEST_HUMAN_DECISION':
        result = RequestHumanDecisionPayloadSchema.safeParse(rawPayload);
        break;
      case 'REQUEST_CLARIFICATION':
        result = RequestClarificationPayloadSchema.safeParse(rawPayload);
        break;
      case 'DECLARE_PROJECT_COMPLETE':
        result = DeclareProjectCompletePayloadSchema.safeParse(rawPayload);
        break;
      case 'PROJECT_COMPLETE':
      case 'PAUSE':
      case 'STOP':
        result = LifecyclePayloadSchema.safeParse(rawPayload);
        break;
      case 'BLOCK':
      case 'RESUME':
      case 'REQUEST_PLANNING':
      case 'SELECT_TASK':
      case 'UPDATE_PLAN':
      case 'DEFER':
      case 'ACCEPT_TASK':
      case 'REJECT_TASK':
      case 'ANALYZE_PROJECT':
      case 'DISCOVER_PROJECT':
      case 'ACCEPT_CONTEXT':
      case 'REJECT_CONTEXT':
        if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
          result = { success: true, data: rawPayload };
        } else {
          result = {
            success: false,
            error: { message: `Payload must be an object for action type '${actionType}'`, issues: [] },
          };
        }
        break;
      default:
        throw new DirectorActionValidationError(`Unsupported action type '${actionType}'.`);
    }

    if (!result.success) {
      throw new DirectorActionValidationError(
        `Payload validation failed for action type '${actionType}': ${result.error?.message}`,
        { actionType, issues: result.error?.issues }
      );
    }

    return result.data;
  }

  private validateDagLineage(
    actionType: DirectorActionType,
    payload: unknown,
    existingTasks: readonly TaskSummaryInfo[]
  ): void {
    const taskMap = new Map(existingTasks.map((t) => [t.taskId, t]));

    if (actionType === 'IMPLEMENT_TASK') {
      const p = payload as { taskId: string };
      const task = taskMap.get(p.taskId);
      if (!task) {
        throw new DirectorActionLineageError(
          `Cannot implement task '${p.taskId}': task does not exist in the project Task DAG.`,
          { taskId: p.taskId }
        );
      }

      // Check dependencies are completed
      for (const depId of task.dependencies) {
        const dep = taskMap.get(depId);
        if (dep && dep.status !== 'COMPLETED' && dep.status !== 'RESOLVED' && dep.status !== 'ACCEPTED') {
          throw new DirectorActionLineageError(
            `Cannot implement task '${p.taskId}': dependency '${depId}' is not completed (current status: '${dep.status}').`,
            { taskId: p.taskId, uncompletedDependency: depId, dependencyStatus: dep.status }
          );
        }
      }
    } else if (actionType === 'RETRY_TASK' || actionType === 'CORRECT_TASK') {
      const p = payload as { taskId: string };
      if (!taskMap.has(p.taskId)) {
        throw new DirectorActionLineageError(
          `Cannot execute ${actionType} for '${p.taskId}': task does not exist in the project Task DAG.`,
          { taskId: p.taskId }
        );
      }
    } else if (actionType === 'CREATE_CORRECTIVE_TASK') {
      const p = payload as { parentTaskId: string; failedTaskId: string };
      if (!taskMap.has(p.parentTaskId)) {
        throw new DirectorActionLineageError(
          `Cannot create corrective task: parent task '${p.parentTaskId}' does not exist in the Task DAG.`,
          { parentTaskId: p.parentTaskId }
        );
      }
      if (!taskMap.has(p.failedTaskId)) {
        throw new DirectorActionLineageError(
          `Cannot create corrective task: failed task '${p.failedTaskId}' does not exist in the Task DAG.`,
          { failedTaskId: p.failedTaskId }
        );
      }
    } else if (actionType === 'REPLAN') {
      const p = payload as { affectedTaskIds: readonly string[] };
      for (const id of p.affectedTaskIds) {
        if (!taskMap.has(id)) {
          throw new DirectorActionLineageError(
            `Cannot replan: affected task '${id}' does not exist in the Task DAG.`,
            { missingTaskId: id }
          );
        }
      }
    } else if (actionType === 'REVIEW_EVIDENCE' || actionType === 'ACCEPT_TASK' || actionType === 'REJECT_TASK') {
      const p = payload as { taskId?: string };
      if (p.taskId && !taskMap.has(p.taskId)) {
        throw new DirectorActionLineageError(
          `Cannot evaluate evidence/outcome for task '${p.taskId}': task does not exist in the Task DAG.`,
          { taskId: p.taskId }
        );
      }
    }
  }
}
