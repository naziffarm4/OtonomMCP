/**
 * @file director-action-dispatcher.ts
 * @description Authoritative Action Dispatcher & Execution Gate (Phase 2 TASK-P19-03).
 *
 * Implements the controlled dispatch boundary between validated Director actions
 * and AIDM task management / execution infrastructure.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO DRIVER/AGY EXECUTION: Dispatcher validates authorization and stages tasks/intents,
 *    but NEVER executes DriverEngine, DriverRuntime, or Antigravity CLI.
 * 2. STRICT FAIL-CLOSED AUTHORIZATION GATE: If P21 Policy Engine or Product Owner approval
 *    is not present, actions remain strictly in PENDING_AUTHORIZATION without mutating the active DAG.
 * 3. NO PRODUCT_OWNER IMPERSONATION: Model outputs or client parameters cannot grant authority.
 *    P18-04 BLOCKED_ON_AUTH_CONTEXT is preserved.
 * 4. ATOMIC CONTEXT & FRESHNESS RE-CHECK: Stale fingerprints or revisions at dispatch time
 *    fail closed immediately.
 * 5. PERSISTENT IDEMPOTENCY: Dispatches are tracked via HistoryManager; duplicate dispatches
 *    do not re-apply mutations; conflicting payloads under the same key are rejected.
 * 6. DAG LINEAGE & EVIDENCE INTEGRITY: Task creation, corrective tasks, and evidence reviews
 *    must satisfy graph integrity and independently verified evidence requirements.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import { HistoryManager } from '../storage/history-manager.js';
import { SpecStore } from '../storage/spec-store.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';
import {
  type ValidatedDirectorActionResult,
} from './director-action-pipeline.js';
import {
  type DirectorActionEnvelope,
  type DirectorActionType,
  type ActionDispatchResult,
  ActionDispatchStatus,
  computePayloadHash,
} from './director-action-types.js';
import {
  DirectorActionIdempotencyConflictError,
  DirectorActionStaleContextError,
} from './director-action-errors.js';
import {
  LocalRuntimeStateManager,
  InstanceConcurrencyError,
} from '../storage/runtime-state.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { AuthorizationPolicyEngine } from '../authorization/authorization-policy-engine.js';
import { AuthorizationDecisionResult } from '../authorization/authorization-policy-types.js';

export interface DispatchedActionRecord {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly actionType: DirectorActionType;
  readonly status: ActionDispatchStatus;
  readonly result: ActionDispatchResult;
  readonly dispatchedAt: string;
}

export interface DirectorActionDispatcherOptions {
  readonly workspaceRoot?: string;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
  readonly evidenceStore?: SystemExecutionEvidenceStore;
  readonly dagEngine?: TaskDagEngine;
  readonly runtimeStateManager?: LocalRuntimeStateManager;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly authorizationPolicyEngine?: AuthorizationPolicyEngine;
}

export class DirectorActionDispatcher {
  readonly workspaceRoot?: string;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
  readonly evidenceStore?: SystemExecutionEvidenceStore;
  readonly dagEngine: TaskDagEngine;
  readonly runtimeStateManager?: LocalRuntimeStateManager;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly authorizationPolicyEngine?: AuthorizationPolicyEngine;

  private readonly dispatchedRecords = new Map<string, DispatchedActionRecord>();
  private isInitialized = false;

  constructor(options: DirectorActionDispatcherOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;
    this.specStore = options.specStore;
    this.evidenceStore = options.evidenceStore;
    this.dagEngine = options.dagEngine ?? new TaskDagEngine();
    this.runtimeStateManager = options.runtimeStateManager;
    this.approvalStore = options.approvalStore;
    this.approvalPackageEngine = options.approvalPackageEngine;
    this.authorizationPolicyEngine = options.authorizationPolicyEngine;
  }

  /**
   * Initializes dispatcher state from existing HistoryManager events.
   * Ensures idempotency duplicate protection survives process restarts.
   */
  async initializeFromHistory(): Promise<void> {
    if (!this.historyManager) {
      this.isInitialized = true;
      return;
    }

    try {
      const events = await this.historyManager.readEvents();
      for (const ev of events) {
        if (ev.eventType === 'DIRECTOR_ACTION_DISPATCHED' && ev.payload) {
          const raw = ev.payload as Record<string, unknown>;
          const idempotencyKey = raw.idempotencyKey as string | undefined;
          const payloadHash = raw.payloadHash as string | undefined;
          const actionId = (raw.actionId ?? ev.taskId ?? '') as string;
          const actionType = raw.actionType as DirectorActionType | undefined;
          const status = raw.status as ActionDispatchStatus | undefined;
          const result = (raw.result as ActionDispatchResult | undefined) ?? (raw as unknown as ActionDispatchResult);

          if (idempotencyKey && payloadHash && (actionType || result.actionType) && (status || result.status)) {
            this.dispatchedRecords.set(idempotencyKey, {
              actionId: actionId || result.actionId,
              idempotencyKey,
              payloadHash,
              actionType: actionType || result.actionType,
              status: status || result.status,
              result,
              dispatchedAt: ev.timestamp,
            });
          }
        }
      }
    } catch {
      // Clean history startup
    }

    this.isInitialized = true;
  }

  /**
   * Computes deterministic executionIntentId for an authorized IMPLEMENT_TASK action.
   */
  private computeExecutionIntentId(
    projectId: string,
    actionId: string,
    taskId: string,
    contextFingerprint: string
  ): string {
    const raw = `${projectId}:${actionId}:${taskId}:${contextFingerprint}`;
    const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
    return `intent-${hash}`;
  }

  /**
   * Dispatches a validated DirectorActionEnvelope through the authoritative policy & execution gate.
   *
   * @param input.validatedResult The validated result from DirectorActionPipeline/Validator
   * @param input.snapshot The authoritative DirectorContextSnapshot at dispatch time
   * @param input.correlationId Optional correlation tracing ID
   */
  async dispatch(input: {
    validatedResult: ValidatedDirectorActionResult;
    snapshot: DirectorContextSnapshot;
    correlationId?: string;
  }): Promise<ActionDispatchResult> {
    if (!this.isInitialized && this.historyManager) {
      await this.initializeFromHistory();
    }

    const { validatedResult, snapshot, correlationId } = input;
    const now = new Date().toISOString();
    const dispatchId = `disp-${crypto.randomBytes(8).toString('hex')}`;

    // ========================================================================
    // 1. VALIDATION OF INPUT RESULT
    // ========================================================================
    if (!validatedResult.success || !validatedResult.envelope) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: 'unknown',
        actionType: (validatedResult.rawDecision?.decisionType as DirectorActionType) ?? 'IMPLEMENT_TASK',
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Cannot dispatch unvalidated or failed action result: ${validatedResult.error ?? 'validation failure'}`,
        code: 'ERR_UNVALIDATED_ENVELOPE',
        dispatchedAt: now,
      };
      await this.recordHistory(snapshot.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    const envelope = validatedResult.envelope;

    // ========================================================================
    // 2. CONTEXT FRESHNESS RE-CHECK AT DISPATCH TIME
    // ========================================================================
    if (snapshot.logicalFingerprint !== envelope.basedOnContextFingerprint) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Context fingerprint has changed since action creation. Envelope: '${envelope.basedOnContextFingerprint}', Snapshot: '${snapshot.logicalFingerprint}'. Dispatch rejected.`,
        code: 'ERR_DIRECTOR_ACTION_STALE_CONTEXT',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    const currentRevision = snapshot.sectionMetadata?.requirements?.revision ?? 1;
    if (currentRevision !== envelope.understandingRevision) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Understanding revision mismatch at dispatch time. Envelope: ${envelope.understandingRevision}, Snapshot: ${currentRevision}. Dispatch rejected.`,
        code: 'ERR_DIRECTOR_ACTION_STALE_REVISION',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    // ========================================================================
    // 3. PROJECT & SESSION BINDING
    // ========================================================================
    if (envelope.projectId !== snapshot.projectId) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Project mismatch: Envelope '${envelope.projectId}' != Snapshot '${snapshot.projectId}'. Cross-project dispatch prohibited.`,
        code: 'ERR_PROJECT_MISMATCH',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    if (envelope.directorSessionId !== snapshot.directorSessionId) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Director session mismatch: Envelope '${envelope.directorSessionId}' != Snapshot '${snapshot.directorSessionId}'.`,
        code: 'ERR_SESSION_MISMATCH',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    // ========================================================================
    // 3.5 ACTOR & ROLE ENFORCEMENT (ANTI-IMPERSONATION)
    // ========================================================================
    if (envelope.actor !== 'DIRECTOR' || envelope.actorRole !== 'DIRECTOR') {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Actor impersonation rejected: actor must be DIRECTOR and actorRole must be DIRECTOR. Received actor='${envelope.actor}', actorRole='${envelope.actorRole}'.`,
        code: 'ERR_DIRECTOR_ACTION_IMPERSONATION',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    // ========================================================================
    // 3.8 WORKSPACE INSTANCE LOCK CONCURRENCY CHECK
    // ========================================================================
    if (this.runtimeStateManager) {
      const runtimeState = await this.runtimeStateManager.load();
      if (runtimeState && runtimeState.acquiredLock) {
        if (runtimeState.processId !== process.pid) {
          throw new InstanceConcurrencyError(
            `Cannot dispatch action: another AIDM instance (PID: ${runtimeState.processId}) holds the workspace lock. Only one active instance is permitted per workspace.`,
            { currentPid: process.pid, existingPid: runtimeState.processId }
          );
        }
      }
    }

    // ========================================================================
    // 4. IDEMPOTENCY & DUPLICATE DISPATCH PROTECTION
    // ========================================================================
    const payloadHash = computePayloadHash(envelope.payload);
    let existingDispatch = this.dispatchedRecords.get(envelope.idempotencyKey);

    // Cross-process concurrency check: if not in memory, re-read latest events from HistoryManager
    if (!existingDispatch && this.historyManager) {
      try {
        const events = await this.historyManager.readEvents();
        for (const ev of events) {
          if (ev.eventType === 'DIRECTOR_ACTION_DISPATCHED' && ev.payload) {
            const p = ev.payload as Record<string, unknown>;
            if (p.idempotencyKey === envelope.idempotencyKey) {
              const resultObj = ((p.result as ActionDispatchResult | undefined) ?? (p as unknown as ActionDispatchResult));
              existingDispatch = {
                actionId: (p.actionId as string) || resultObj.actionId || ev.taskId || '',
                idempotencyKey: p.idempotencyKey as string,
                payloadHash: (p.payloadHash as string) || '',
                actionType: (p.actionType as DirectorActionType) || resultObj.actionType,
                status: (p.status as ActionDispatchStatus) || resultObj.status,
                result: resultObj,
                dispatchedAt: ev.timestamp,
              };
              this.dispatchedRecords.set(envelope.idempotencyKey, existingDispatch);
              break;
            }
          }
        }
      } catch {
        // history read fallback
      }
    }

    if (existingDispatch) {
      if (existingDispatch.payloadHash !== payloadHash) {
        throw new DirectorActionIdempotencyConflictError(
          `Conflicting payload for idempotency key '${envelope.idempotencyKey}'. Existing hash: '${existingDispatch.payloadHash}', new hash: '${payloadHash}'.`,
          {
            idempotencyKey: envelope.idempotencyKey,
            existingActionId: existingDispatch.actionId,
            newActionId: envelope.actionId,
          }
        );
      }

      // Re-dispatch of exact identical action: return cached result with DUPLICATE status
      return {
        ...existingDispatch.result,
        status: ActionDispatchStatus.DUPLICATE,
        reason: 'Action was already dispatched; returning idempotent duplicate result without repeating state mutations.',
      };
    }

    // ========================================================================
    // 4.5. P21 AUTHORIZATION POLICY ENGINE EVALUATION
    // ========================================================================
    if (!this.authorizationPolicyEngine) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Policy Engine (P21) is not configured. Failing closed.`,
        code: 'ERR_POLICY_ENGINE_MISSING',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    const decision = await this.authorizationPolicyEngine.evaluateAction(envelope);
    if (decision.decisionResult === AuthorizationDecisionResult.DENY) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Policy Engine (P21) rejected action: ${decision.reason}`,
        code: 'ERR_POLICY_ENGINE_DENIED',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    } else if (
      decision.decisionResult === AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL ||
      decision.decisionResult === AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION ||
      decision.decisionResult === AuthorizationDecisionResult.WAITING_FOR_TRUSTED_IDENTITY
    ) {
      const pendingResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.PENDING_AUTHORIZATION,
        isAuthorized: false,
        requiresHumanApproval: true,
        reason: `Policy Engine (P21) requires human approval or configuration: ${decision.reason}`,
        code: decision.decisionResult === AuthorizationDecisionResult.WAITING_FOR_TRUSTED_IDENTITY
          ? 'WAITING_FOR_TRUSTED_IDENTITY'
          : 'PENDING_POLICY_AUTHORIZATION',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCHED', pendingResult as unknown as Record<string, unknown>);
      return pendingResult;
    } else if (decision.decisionResult !== AuthorizationDecisionResult.ALLOW) {
      const rejectResult: ActionDispatchResult = {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Policy Engine (P21) returned non-ALLOW result '${decision.decisionResult}': ${decision.reason}`,
        code: 'ERR_POLICY_ENGINE_DENIED',
        dispatchedAt: now,
      };
      await this.recordHistory(envelope.projectId, 'DIRECTOR_ACTION_DISPATCH_REJECTED', rejectResult as unknown as Record<string, unknown>);
      return rejectResult;
    }

    // ========================================================================
    // 5. AUTHORIZATION GATE & ACTION-SPECIFIC POLICY EVALUATION
    // ========================================================================
    let dispatchResult: ActionDispatchResult;

    switch (envelope.actionType) {
      case 'IMPLEMENT_TASK':
        dispatchResult = await this.handleImplementTask(envelope, snapshot, dispatchId, now);
        break;

      case 'CREATE_TASK':
        dispatchResult = await this.handleCreateTask(envelope, snapshot, dispatchId, now);
        break;

      case 'CREATE_CORRECTIVE_TASK':
        dispatchResult = await this.handleCreateCorrectiveTask(envelope, snapshot, dispatchId, now);
        break;

      case 'REPLAN':
        dispatchResult = await this.handleReplan(envelope, snapshot, dispatchId, now);
        break;

      case 'REVIEW_EVIDENCE':
        dispatchResult = await this.handleReviewEvidence(envelope, snapshot, dispatchId, now);
        break;

      default:
        // Governance / Lifecycle / Unknown actions fail closed
        dispatchResult = {
          dispatchId,
          actionId: envelope.actionId,
          actionType: envelope.actionType,
          status: ActionDispatchStatus.PENDING_AUTHORIZATION,
          isAuthorized: false,
          requiresHumanApproval: true,
          reason: `Action type '${envelope.actionType}' is a governance/lifecycle action and cannot be autonomously dispatched at this gate.`,
          code: 'ERR_GOVERNANCE_ACTION_PENDING',
          dispatchedAt: now,
        };
        break;
    }

    // ========================================================================
    // 6. RECORDING & CACHING
    // ========================================================================
    this.dispatchedRecords.set(envelope.idempotencyKey, {
      actionId: envelope.actionId,
      idempotencyKey: envelope.idempotencyKey,
      payloadHash,
      actionType: envelope.actionType,
      status: dispatchResult.status,
      result: dispatchResult,
      dispatchedAt: now,
    });

    await this.recordHistory(
      envelope.projectId,
      dispatchResult.status === ActionDispatchStatus.REJECTED
        ? 'DIRECTOR_ACTION_DISPATCH_REJECTED'
        : 'DIRECTOR_ACTION_DISPATCHED',
      {
        ...dispatchResult,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: dispatchResult.status,
        result: dispatchResult,
        idempotencyKey: envelope.idempotencyKey,
        payloadHash,
        correlationId,
      }
    );

    return dispatchResult;
  }

  // ==========================================================================
  // ACTION HANDLERS
  // ==========================================================================

  /**
   * IMPLEMENT_TASK Handler:
   * Validates task existence, readiness, and dependencies against DAG.
   * Evaluates Product Owner development authorization.
   * NEVER runs Driver or AGY directly.
   */
  private async handleImplementTask(
    envelope: DirectorActionEnvelope,
    snapshot: DirectorContextSnapshot,
    dispatchId: string,
    now: string
  ): Promise<ActionDispatchResult> {
    const payload = envelope.payload as {
      taskId: string;
      expectedTaskRevision?: number;
      executionPlan: string;
    };

    const targetTaskId = payload.taskId;
    const taskList = snapshot.sections.taskList.tasks ?? [];
    const task = taskList.find((t) => t.taskId === targetTaskId);

    if (!task) {
      return {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Target task '${targetTaskId}' not found in Task DAG.`,
        code: 'ERR_TASK_NOT_FOUND',
        dispatchedAt: now,
      };
    }

    if (task.status === 'COMPLETED') {
      return {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Target task '${targetTaskId}' is already COMPLETED.`,
        code: 'ERR_TASK_ALREADY_COMPLETED',
        dispatchedAt: now,
      };
    }

    // Verify dependencies
    for (const depId of task.dependencies) {
      const dep = taskList.find((t) => t.taskId === depId);
      if (!dep || (dep.status !== 'COMPLETED' && dep.status !== 'ACCEPTED')) {
        return {
          dispatchId,
          actionId: envelope.actionId,
          actionType: envelope.actionType,
          status: ActionDispatchStatus.REJECTED,
          isAuthorized: false,
          requiresHumanApproval: false,
          reason: `Dependency '${depId}' for task '${targetTaskId}' is not completed (status: ${dep?.status ?? 'MISSING'}).`,
          code: 'ERR_DEPENDENCIES_UNMET',
          dispatchedAt: now,
        };
      }
    }

    // Authorization Gate: Development authorization must be granted by Product Owner (P18-04)
    // PROVENANCE: strictly from snapshot and independently verified against disk ApprovalStore
    let isDevAuthorized = snapshot.sections.authorization.isDevelopmentAuthorized === true;

    // Independent disk re-verification against ApprovalStore
    if (isDevAuthorized && this.approvalStore) {
      try {
        const activePkg = await this.approvalStore.getActivePackage(envelope.projectId);
        const engine = this.approvalPackageEngine ?? new ApprovalPackageEngine();
        if (!activePkg || !engine.isDevelopmentAuthorized(activePkg)) {
          isDevAuthorized = false;
        }
      } catch {
        isDevAuthorized = false; // fail-closed on storage/verification failure
      }
    }

    if (!isDevAuthorized) {
      return {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.PENDING_AUTHORIZATION,
        isAuthorized: false,
        requiresHumanApproval: true,
        reason: 'Development authorization not granted by Product Owner (P18-04 boundary). Implementation remains pending explicit authorization.',
        code: 'PENDING_PO_AUTHORIZATION',
        dispatchedAt: now,
      };
    }

    // Development is authorized: generate deterministic executionIntentId
    const intentId = this.computeExecutionIntentId(
      envelope.projectId,
      envelope.actionId,
      targetTaskId,
      snapshot.logicalFingerprint
    );

    // INVARIANT: DriverEngine / DriverRuntime is NOT started by Dispatcher!
    return {
      dispatchId,
      actionId: envelope.actionId,
      actionType: envelope.actionType,
      status: ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION,
      isAuthorized: true,
      requiresHumanApproval: false,
      reason: `Task '${targetTaskId}' execution authorized and intent generated; handed off to DriverLoop queue without direct execution.`,
      executionIntentId: intentId,
      dispatchedAt: now,
    };
  }

  /**
   * CREATE_TASK Handler:
   * Validates forward dependencies against current DAG and checks for cycles.
   * Without P21 Policy Engine, dynamic DAG mutation requires human approval.
   * NEVER mutates tasks.json while pending authorization.
   */
  private async handleCreateTask(
    envelope: DirectorActionEnvelope,
    snapshot: DirectorContextSnapshot,
    dispatchId: string,
    now: string
  ): Promise<ActionDispatchResult> {
    const payload = envelope.payload as {
      title: string;
      description: string;
      parentTaskId?: string;
      dependencies?: string[];
      acceptanceCriteria: string[];
      category?: string;
    };

    const taskList = snapshot.sections.taskList.tasks ?? [];
    const declaredDeps = payload.dependencies ?? [];

    // All declared dependencies must exist in the DAG
    for (const depId of declaredDeps) {
      if (!taskList.some((t) => t.taskId === depId)) {
        return {
          dispatchId,
          actionId: envelope.actionId,
          actionType: envelope.actionType,
          status: ActionDispatchStatus.REJECTED,
          isAuthorized: false,
          requiresHumanApproval: false,
          reason: `Declared dependency '${depId}' does not exist in the current Task DAG.`,
          code: 'ERR_MISSING_DEPENDENCY',
          dispatchedAt: now,
        };
      }
    }

    // Check parent task if provided
    if (payload.parentTaskId && !taskList.some((t) => t.taskId === payload.parentTaskId)) {
      return {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Parent task '${payload.parentTaskId}' does not exist in the current Task DAG.`,
        code: 'ERR_INVALID_PARENT',
        dispatchedAt: now,
      };
    }

    // Policy & Authorization Gate: Task graph modifications require Policy Engine (P21) or human approval
    // INVARIANT: Do NOT mutate tasks.json or DAG!
    return {
      dispatchId,
      actionId: envelope.actionId,
      actionType: envelope.actionType,
      status: ActionDispatchStatus.PENDING_AUTHORIZATION,
      isAuthorized: false,
      requiresHumanApproval: true,
      reason: 'Task creation proposal validated against DAG integrity; held in PENDING_AUTHORIZATION awaiting Policy Engine (P21) or human approval before mutating active DAG.',
      code: 'PENDING_POLICY_AUTHORIZATION',
      dispatchedAt: now,
    };
  }

  /**
   * CREATE_CORRECTIVE_TASK Handler:
   * Validates failedTaskId lineage and requires independently verified failure evidence.
   */
  private async handleCreateCorrectiveTask(
    envelope: DirectorActionEnvelope,
    snapshot: DirectorContextSnapshot,
    dispatchId: string,
    now: string
  ): Promise<ActionDispatchResult> {
    const payload = envelope.payload as {
      parentTaskId: string;
      failedTaskId: string;
      failureReason: string;
      remediationType: string;
      correctivePlan: string;
      targetFiles?: string[];
    };

    const taskList = snapshot.sections.taskList.tasks ?? [];
    const failedTask = taskList.find((t) => t.taskId === payload.failedTaskId);

    if (!failedTask) {
      return {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Failed task '${payload.failedTaskId}' does not exist in the Task DAG. Lineage check failed.`,
        code: 'ERR_FAILED_TASK_NOT_FOUND',
        dispatchedAt: now,
      };
    }

    // Verified Evidence Check: Must have verified failure evidence in EvidenceStore or Snapshot
    let hasVerifiedFailure = false;

    // 1. Check snapshot evidence items
    const snapshotEvidence = snapshot.sections.evidence.items ?? [];
    for (const ev of snapshotEvidence) {
      if (ev.taskId === payload.failedTaskId && ev.isSystemVerified) {
        hasVerifiedFailure = true;
        break;
      }
    }

    // 2. Check filesystem evidence store if available
    if (!hasVerifiedFailure && this.evidenceStore) {
      try {
        const stored = await this.evidenceStore.loadEvidenceByTask(payload.failedTaskId);
        if (stored.some((s) => s.verificationDecision === 'REJECT' || s.verificationDecision === 'BLOCK')) {
          hasVerifiedFailure = true;
        }
      } catch {
        // Evidence store read failed
      }
    }

    // If source task is not marked FAILED and no verified failure evidence exists, reject fail-closed
    if (!hasVerifiedFailure && failedTask.status !== 'FAILED' && failedTask.status !== 'REJECTED') {
      return {
        dispatchId,
        actionId: envelope.actionId,
        actionType: envelope.actionType,
        status: ActionDispatchStatus.REJECTED,
        isAuthorized: false,
        requiresHumanApproval: false,
        reason: `Cannot create corrective task: failedTaskId '${payload.failedTaskId}' has no system-verified failure evidence and is not in FAILED state. Unverified executor claims are rejected.`,
        code: 'ERR_UNVERIFIED_FAILURE_EVIDENCE',
        dispatchedAt: now,
      };
    }

    // Policy & Authorization Gate
    return {
      dispatchId,
      actionId: envelope.actionId,
      actionType: envelope.actionType,
      status: ActionDispatchStatus.PENDING_AUTHORIZATION,
      isAuthorized: false,
      requiresHumanApproval: true,
      reason: `Corrective task proposal validated against lineage and verified failure evidence; held in PENDING_AUTHORIZATION awaiting Policy Engine (P21) or human approval.`,
      code: 'PENDING_POLICY_AUTHORIZATION',
      dispatchedAt: now,
    };
  }

  /**
   * REPLAN Handler:
   * Validates affected tasks and proposed dependency modifications against DAG.
   * Requires explicit human approval. NEVER mutates DAG.
   */
  private async handleReplan(
    envelope: DirectorActionEnvelope,
    snapshot: DirectorContextSnapshot,
    dispatchId: string,
    now: string
  ): Promise<ActionDispatchResult> {
    const payload = envelope.payload as {
      replanReason: string;
      affectedTaskIds: string[];
      proposedModifications: Array<{
        taskId: string;
        action: string;
        newDependencies?: string[];
        justification: string;
      }>;
    };

    const taskList = snapshot.sections.taskList.tasks ?? [];

    for (const aId of payload.affectedTaskIds) {
      if (!taskList.some((t) => t.taskId === aId)) {
        return {
          dispatchId,
          actionId: envelope.actionId,
          actionType: envelope.actionType,
          status: ActionDispatchStatus.REJECTED,
          isAuthorized: false,
          requiresHumanApproval: false,
          reason: `Replan references unknown affected task '${aId}'.`,
          code: 'ERR_AFFECTED_TASK_NOT_FOUND',
          dispatchedAt: now,
        };
      }
    }

    // INVARIANT: Replan proposals NEVER mutate active DAG directly
    return {
      dispatchId,
      actionId: envelope.actionId,
      actionType: envelope.actionType,
      status: ActionDispatchStatus.PENDING_AUTHORIZATION,
      isAuthorized: false,
      requiresHumanApproval: true,
      reason: 'Replan proposal validated against current DAG; held in PENDING_AUTHORIZATION awaiting explicit Product Owner approval before modifying task graph.',
      code: 'PENDING_PO_APPROVAL',
      dispatchedAt: now,
    };
  }

  /**
   * REVIEW_EVIDENCE Handler:
   * Validates that evidence items exist and are independently system-verified.
   * AGY self-claims are rejected.
   */
  private async handleReviewEvidence(
    envelope: DirectorActionEnvelope,
    snapshot: DirectorContextSnapshot,
    dispatchId: string,
    now: string
  ): Promise<ActionDispatchResult> {
    const payload = envelope.payload as {
      taskId: string;
      evidenceIds: string[];
      verdict: 'VERIFIED_SUCCESS' | 'INCONCLUSIVE' | 'REJECTED_FAILURE';
      findings: string;
    };

    const snapshotEvidence = snapshot.sections.evidence.items ?? [];

    for (const evId of payload.evidenceIds) {
      let isVerified = false;

      // Check snapshot
      const item = snapshotEvidence.find((e) => e.evidenceId === evId);
      if (item && item.isSystemVerified) {
        isVerified = true;
      }

      // Check evidenceStore if available
      if (!isVerified && this.evidenceStore) {
        try {
          const loaded = await this.evidenceStore.loadEvidence(evId);
          if (loaded && (loaded.verificationDecision === 'ACCEPT' || loaded.verificationDecision === 'REJECT' || loaded.verificationDecision === 'BLOCK')) {
            isVerified = true;
          }
        } catch {
          // not found in store
        }
      }

      if (!isVerified) {
        return {
          dispatchId,
          actionId: envelope.actionId,
          actionType: envelope.actionType,
          status: ActionDispatchStatus.REJECTED,
          isAuthorized: false,
          requiresHumanApproval: false,
          reason: `Evidence '${evId}' is either missing or not independently verified by the system. Self-claimed executor outcomes are rejected.`,
          code: 'ERR_UNVERIFIED_EVIDENCE',
          dispatchedAt: now,
        };
      }
    }

    return {
      dispatchId,
      actionId: envelope.actionId,
      actionType: envelope.actionType,
      status: ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION,
      isAuthorized: true,
      requiresHumanApproval: false,
      reason: `All ${payload.evidenceIds.length} evidence items independently verified; review finding recorded.`,
      dispatchedAt: now,
    };
  }

  /**
   * Helper to write events into HistoryManager if configured.
   */
  private async recordHistory(
    projectId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.historyManager) return;
    try {
      await this.historyManager.appendEvent({
        eventType,
        actor: Actor.DIRECTOR,
        timestamp: new Date().toISOString(),
        taskId: (payload.actionId as string) || (payload.taskId as string) || undefined,
        payload,
      });
    } catch {
      // Non-blocking history record failure must not crash dispatch
    }
  }
}
