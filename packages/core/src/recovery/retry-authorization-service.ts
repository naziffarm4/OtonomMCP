/**
 * Bounded Task Retry Authorization Service (Phase 13 TASK-P13-02)
 *
 * Implements the authoritative boundary that converts a P13-01 RETRY policy decision
 * into an authorized, bounded task retry state transition.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Operates strictly on verified SystemExecutionEvidence.
 * 2. BOUNDED ATTEMPTS: Authorizes retry ONLY if attempt < max_attempts.
 * 3. NO COMPLETED RETRY: ACCEPTED/completed tasks can never be retried.
 * 4. ATOMIC & IDEMPOTENT: Transitions state to READY and increments attempt exactly once.
 * 5. PRESERVES INTEGRITY: Does NOT mutate task revision, DAG structure, criteria, or scope.
 * 6. ZERO AUTONOMOUS EXECUTION: Does NOT invoke Antigravity or create ExecutionIntent/ExecutionRequest.
 * 7. PRESERVES AUTHORITATIVE ROLES:
 *    - DurableStateManager remains sole global FSM authority.
 *    - TaskDagEngine remains sole DAG authority.
 *    - SpecStore remains authoritative task specification store.
 *    - ApprovalPackageEngine remains authoritative for development authorization.
 */

import { Actor } from '../actors.js';
import { TaskStatus, type TaskDefinition } from '../task-engine/task-types.js';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
  assertNoForbiddenEvidenceFields,
} from '../evidence/system-execution-evidence.js';
import {
  DurableStateManager,
  CURRENT_DURABLE_STATE_SCHEMA_VERSION,
  type DurableState,
} from '../storage/durable-state.js';
import { SpecStore } from '../storage/spec-store.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import { HistoryManager } from '../storage/history-manager.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { ExecutionIntegrationLock } from '../execution-integration/execution-integration-lock.js';
import { RecoveryPolicyEngine } from './recovery-policy-engine.js';
import {
  RecoveryStrategy,
  type RecoveryPolicyDecision,
  RecoveryPolicyDecisionZodSchema,
} from './recovery-policy-types.js';
import {
  type RetryAuthorizationInput,
  type RetryAuthorizationOutcome,
  type RetryTransitionRecord,
  computeDeterministicRetryKey,
  computeDeterministicRetryEventId,
} from './retry-authorization-types.js';
import {
  RetryValidationError,
  RetrySecurityViolationError,
  RetryPolicyMismatchError,
  RetryBindingMismatchError,
  RetryBudgetExhaustedError,
  RetryTaskStateInvalidError,
  RetryUnauthorizedError,
  RetryPersistenceError,
} from './retry-authorization-errors.js';

export interface RetryAuthorizationServiceOptions {
  readonly workspaceRoot?: string;
  readonly durableStateManager?: DurableStateManager;
  readonly specStore?: SpecStore;
  readonly dagEngine?: TaskDagEngine;
  readonly historyManager?: HistoryManager;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly directorSessionStore?: DirectorSessionStore;
  readonly recoveryPolicyEngine?: RecoveryPolicyEngine;
  readonly lock?: ExecutionIntegrationLock;
  readonly expectedProjectId?: string;
}

export class RetryAuthorizationService {
  readonly workspaceRoot: string;
  readonly durableStateManager: DurableStateManager;
  readonly specStore: SpecStore;
  readonly dagEngine: TaskDagEngine;
  readonly historyManager?: HistoryManager;
  readonly approvalStore: ApprovalStore;
  readonly approvalPackageEngine: ApprovalPackageEngine;
  readonly directorSessionStore: DirectorSessionStore;
  readonly recoveryPolicyEngine: RecoveryPolicyEngine;
  readonly lock: ExecutionIntegrationLock;
  readonly expectedProjectId?: string;

  constructor(options: RetryAuthorizationServiceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.durableStateManager =
      options.durableStateManager ??
      new DurableStateManager({ baseDir: this.workspaceRoot });
    this.specStore =
      options.specStore ?? new SpecStore({ baseDir: this.workspaceRoot });
    this.dagEngine = options.dagEngine ?? new TaskDagEngine();
    this.historyManager =
      options.historyManager ??
      new HistoryManager({ baseDir: this.workspaceRoot });
    this.approvalStore =
      options.approvalStore ??
      new ApprovalStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });
    this.approvalPackageEngine =
      options.approvalPackageEngine ?? new ApprovalPackageEngine();
    this.directorSessionStore =
      options.directorSessionStore ??
      new DirectorSessionStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });
    this.recoveryPolicyEngine =
      options.recoveryPolicyEngine ??
      new RecoveryPolicyEngine({
        historyManager: this.historyManager,
        expectedProjectId: options.expectedProjectId,
      });
    this.lock =
      options.lock ??
      new ExecutionIntegrationLock({
        baseDir: this.workspaceRoot,
      });
    this.expectedProjectId = options.expectedProjectId;
  }

  /**
   * Main entry point: Authorizes and performs bounded retry state transition under filesystem lock.
   */
  async authorizeRetry(
    input: RetryAuthorizationInput
  ): Promise<RetryAuthorizationOutcome> {
    return await this.lock.withLock(async () => {
      return await this.executeRetryUnderLock(input);
    });
  }

  private async executeRetryUnderLock(
    input: RetryAuthorizationInput
  ): Promise<RetryAuthorizationOutcome> {
    if (!input || typeof input !== 'object') {
      throw new RetryValidationError('Input must be a valid non-null object');
    }

    // 1. Validate Evidence: reject forbidden verification claims and raw outcomes
    const rawEvidence = input.evidence;
    if (!rawEvidence || typeof rawEvidence !== 'object') {
      throw new RetryValidationError('Input.evidence must be a valid non-null object');
    }

    try {
      assertNoForbiddenEvidenceFields(rawEvidence);
    } catch (err: any) {
      throw new RetrySecurityViolationError(err.message, { cause: err });
    }

    const evidenceParsed = SystemExecutionEvidenceZodSchema.safeParse(rawEvidence);
    if (!evidenceParsed.success) {
      const firstIssue = evidenceParsed.error.issues[0];
      const message = `Evidence schema validation failed: ${firstIssue?.message ?? evidenceParsed.error.message}`;
      if (firstIssue && (firstIssue.message.includes('Forbidden') || firstIssue.message.includes('fake'))) {
        throw new RetrySecurityViolationError(message, { issues: evidenceParsed.error.issues });
      }
      throw new RetryValidationError(message, { issues: evidenceParsed.error.issues });
    }

    const evidence: SystemExecutionEvidence = evidenceParsed.data;

    // Hard invariant: Only REJECT verificationDecision can be retried
    if (evidence.verificationDecision !== 'REJECT') {
      throw new RetryPolicyMismatchError(
        `Cannot authorize retry for evidence with verificationDecision '${evidence.verificationDecision}'. Only 'REJECT' evidence is eligible for retry.`,
        { verificationDecision: evidence.verificationDecision }
      );
    }

    // 2. Cross-Project Validation
    const expectedProject = input.expectedProjectId ?? this.expectedProjectId;
    if (expectedProject && evidence.projectId !== expectedProject) {
      throw new RetryBindingMismatchError(
        `Project ID mismatch: evidence targets '${evidence.projectId}', but expected '${expectedProject}'`,
        { evidenceProjectId: evidence.projectId, expectedProjectId: expectedProject }
      );
    }

    // 3. Load Authoritative Task from SpecStore
    let specTasks: TaskDefinition[];
    try {
      specTasks = await this.specStore.loadTasks();
    } catch (err: any) {
      throw new RetryPersistenceError(`Failed to load tasks from SpecStore: ${err.message}`, {
        cause: err,
      });
    }

    const task = specTasks.find((t) => t.task_id === evidence.taskId);
    if (!task) {
      throw new RetryBindingMismatchError(
        `Task '${evidence.taskId}' not found in authoritative SpecStore`,
        { taskId: evidence.taskId }
      );
    }

    // Task Revision Validation
    const authoritativeRevision = (task.metadata?.revision as number) ?? 1;
    if (evidence.taskRevision !== authoritativeRevision) {
      throw new RetryBindingMismatchError(
        `Task revision mismatch: evidence specifies revision ${evidence.taskRevision}, but authoritative task revision in SpecStore is ${authoritativeRevision}`,
        { evidenceRevision: evidence.taskRevision, authoritativeRevision }
      );
    }

    // Inspect DurableState
    const durableState = (await this.durableStateManager.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      continuationState: 'NONE' as const,
      continuationPolicy: 'AUTONOMOUS' as const,
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    const durableMetadata = (durableState.metadata ?? {}) as Record<string, unknown>;
    const retryRecords = (durableMetadata.retryTransitions ?? {}) as Record<
      string,
      RetryTransitionRecord
    >;

    // Idempotency check: if this exact evidenceId was already authorized for retry
    const existingRetry = retryRecords[evidence.evidenceId];
    if (existingRetry) {
      const remaining = Math.max(0, existingRetry.maxAttempts - existingRetry.newAttempt);
      return {
        success: true,
        retryKey: existingRetry.retryKey,
        projectId: existingRetry.projectId,
        taskId: existingRetry.taskId,
        taskRevision: existingRetry.taskRevision,
        previousAttempt: existingRetry.previousAttempt,
        newAttempt: existingRetry.newAttempt,
        maxAttempts: existingRetry.maxAttempts,
        remainingAttempts: remaining,
        taskStatus: existingRetry.taskStatus,
        isDuplicate: true,
        evidenceId: existingRetry.evidenceId,
        historyEventId: existingRetry.historyEventId,
        message: `Retry already authorized for evidence '${evidence.evidenceId}'. Returned idempotent outcome.`,
        task,
      };
    }

    // Hard invariant: ACCEPTED / completed task cannot be retried
    const completedSet = new Set(durableState.completedTaskIds ?? []);
    if (task.status === TaskStatus.ACCEPTED || completedSet.has(task.task_id)) {
      throw new RetryTaskStateInvalidError(
        `Task '${task.task_id}' is already marked ACCEPTED/completed; completed tasks can never be retried.`,
        { taskId: task.task_id, status: task.status }
      );
    }

    // Permitted lifecycle states for retry: REJECTED, IN_PROGRESS, READY, BLOCKED
    const permittedRetryStates: TaskStatus[] = [
      TaskStatus.REJECTED,
      TaskStatus.IN_PROGRESS,
      TaskStatus.READY,
      TaskStatus.BLOCKED,
    ];
    if (!permittedRetryStates.includes(task.status)) {
      throw new RetryTaskStateInvalidError(
        `Task '${task.task_id}' has invalid status '${task.status}' for retry. Must be one of: ${permittedRetryStates.join(', ')}`,
        { taskId: task.task_id, status: task.status }
      );
    }

    // 4. Authoritative Attempt & Budget Validation
    const currentAttempt = typeof task.attempt === 'number' ? task.attempt : 0;
    const maxAttempts =
      typeof task.max_attempts === 'number' && task.max_attempts > 0
        ? task.max_attempts
        : 3;

    if (currentAttempt >= maxAttempts) {
      throw new RetryBudgetExhaustedError(
        `Retry budget exhausted for task '${task.task_id}': current attempt ${currentAttempt} >= max_attempts ${maxAttempts}.`,
        { taskId: task.task_id, currentAttempt, maxAttempts }
      );
    }

    // 5. Validate or Evaluate Recovery Policy Decision
    let decision: RecoveryPolicyDecision;
    if (input.decision) {
      const decisionParsed = RecoveryPolicyDecisionZodSchema.safeParse(input.decision);
      if (!decisionParsed.success) {
        throw new RetryValidationError(
          `Decision schema validation failed: ${decisionParsed.error.issues[0]?.message ?? decisionParsed.error.message}`,
          { issues: decisionParsed.error.issues }
        );
      }
      decision = input.decision as RecoveryPolicyDecision;

      // Validate decision bindings
      if (decision.evidenceId !== evidence.evidenceId) {
        throw new RetryBindingMismatchError(
          `Decision evidenceId '${decision.evidenceId}' does not match evidence.evidenceId '${evidence.evidenceId}'`,
          { decisionEvidenceId: decision.evidenceId, evidenceId: evidence.evidenceId }
        );
      }
      if (decision.taskId !== task.task_id) {
        throw new RetryBindingMismatchError(
          `Decision taskId '${decision.taskId}' does not match task '${task.task_id}'`,
          { decisionTaskId: decision.taskId, taskId: task.task_id }
        );
      }
      if (decision.taskRevision !== authoritativeRevision) {
        throw new RetryBindingMismatchError(
          `Decision taskRevision '${decision.taskRevision}' does not match authoritative task revision '${authoritativeRevision}'`,
          { decisionTaskRevision: decision.taskRevision, authoritativeRevision }
        );
      }
      if (decision.projectId !== evidence.projectId) {
        throw new RetryBindingMismatchError(
          `Decision projectId '${decision.projectId}' does not match evidence.projectId '${evidence.projectId}'`,
          { decisionProjectId: decision.projectId, evidenceProjectId: evidence.projectId }
        );
      }
    } else {
      // Evaluate policy deterministically using RecoveryPolicyEngine
      decision = this.recoveryPolicyEngine.evaluate({
        evidence,
        task,
        expectedProjectId: expectedProject,
      });
    }

    // Policy Decision check: strictly RETRY and retryAllowed === true
    if (decision.decision !== RecoveryStrategy.RETRY || !decision.retryAllowed) {
      throw new RetryPolicyMismatchError(
        `Recovery policy decision is '${decision.decision}' (retryAllowed: ${decision.retryAllowed}). Retry cannot be authorized for non-RETRY decision.`,
        { decision: decision.decision, retryAllowed: decision.retryAllowed, reasonCodes: decision.reasonCodes }
      );
    }

    // 6. Bindings Verification: contextFingerprint, understandingRevision, approvalPackageRevision
    if (input.contextFingerprint !== undefined && evidence.contextFingerprint !== input.contextFingerprint) {
      throw new RetryBindingMismatchError(
        `Context fingerprint mismatch: evidence has '${evidence.contextFingerprint}', expected '${input.contextFingerprint}'`,
        { actual: evidence.contextFingerprint, expected: input.contextFingerprint }
      );
    }

    if (input.understandingRevision !== undefined && evidence.understandingRevision !== input.understandingRevision) {
      throw new RetryBindingMismatchError(
        `Understanding revision mismatch: evidence has revision ${evidence.understandingRevision}, expected ${input.understandingRevision}`,
        { actual: evidence.understandingRevision, expected: input.understandingRevision }
      );
    }

    if (input.approvalPackageRevision !== undefined && evidence.approvalPackageRevision !== input.approvalPackageRevision) {
      throw new RetryBindingMismatchError(
        `Approval package revision mismatch: evidence has revision ${evidence.approvalPackageRevision}, expected ${input.approvalPackageRevision}`,
        { actual: evidence.approvalPackageRevision, expected: input.approvalPackageRevision }
      );
    }

    // 7. Authoritative Development Authorization Check
    const activePkg = await this.approvalStore.getActivePackage();
    if (!activePkg) {
      throw new RetryUnauthorizedError(
        'No active approval package found in ApprovalStore. Development is unauthorized.',
        { taskId: task.task_id }
      );
    }

    if (activePkg.projectId !== evidence.projectId) {
      throw new RetryBindingMismatchError(
        `Active approval package belongs to project '${activePkg.projectId}', not evidence project '${evidence.projectId}'`,
        { packageProjectId: activePkg.projectId, evidenceProjectId: evidence.projectId }
      );
    }

    if (evidence.approvalPackageRevision !== activePkg.revision) {
      throw new RetryBindingMismatchError(
        `Stale approval package revision: evidence bound to revision ${evidence.approvalPackageRevision}, but active approved package is at revision ${activePkg.revision}`,
        { evidenceApprovalRevision: evidence.approvalPackageRevision, activePackageRevision: activePkg.revision }
      );
    }

    const isDevAuth = this.approvalPackageEngine.isDevelopmentAuthorized(activePkg);
    if (!isDevAuth) {
      throw new RetryUnauthorizedError(
        `Active approval package '${activePkg.packageId}' is not authorized for development. Status: '${activePkg.status}'.`,
        { packageId: activePkg.packageId, status: activePkg.status }
      );
    }

    // 8. If Director Session is provided, verify session status and context snapshot
    if (input.directorSessionId) {
      const session = await this.directorSessionStore.loadSession(input.directorSessionId);
      if (!session) {
        throw new RetryBindingMismatchError(
          `Director session '${input.directorSessionId}' was not found.`,
          { directorSessionId: input.directorSessionId }
        );
      }
      if (session.status !== 'ACTIVE') {
        throw new RetryUnauthorizedError(
          `Director session '${input.directorSessionId}' is ${session.status}. Execution requires an ACTIVE Director session.`,
          { directorSessionId: input.directorSessionId, status: session.status }
        );
      }
      if (session.projectId !== evidence.projectId) {
        throw new RetryBindingMismatchError(
          `Director session project '${session.projectId}' does not match evidence project '${evidence.projectId}'`,
          { sessionProjectId: session.projectId, evidenceProjectId: evidence.projectId }
        );
      }
      const snapshot = await this.directorSessionStore.loadLatestSnapshot(input.directorSessionId);
      if (snapshot && snapshot.logicalFingerprint !== evidence.contextFingerprint) {
        throw new RetryBindingMismatchError(
          `Context fingerprint mismatch with active Director session snapshot: evidence has '${evidence.contextFingerprint}', snapshot has '${snapshot.logicalFingerprint}'`,
          { evidenceFingerprint: evidence.contextFingerprint, snapshotFingerprint: snapshot.logicalFingerprint }
        );
      }
    }

    // 9. Perform Authorized State Transition
    // Attempt increments exactly once
    const newAttempt = currentAttempt + 1;
    const now = new Date().toISOString();

    const retryKey = computeDeterministicRetryKey({
      projectId: evidence.projectId,
      taskId: task.task_id,
      taskRevision: authoritativeRevision,
      evidenceId: evidence.evidenceId,
    });

    const historyEventId = computeDeterministicRetryEventId(retryKey);

    // 10. Record History Event
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventId: historyEventId,
          timestamp: now,
          eventType: 'TASK_RETRY_AUTHORIZED',
          actor: Actor.ORCHESTRATOR,
          taskId: task.task_id,
          payload: {
            projectId: evidence.projectId,
            taskId: task.task_id,
            taskRevision: authoritativeRevision,
            previousAttempt: currentAttempt,
            newAttempt,
            maxAttempts,
            failureCategory: decision.failureCategory,
            recoveryStrategy: decision.decision,
            evidenceId: evidence.evidenceId,
            requestId: evidence.requestId,
            retryKey,
            authorizedAt: now,
          },
        });
      } catch (histErr: any) {
        // Logging crash window protection
      }
    }

    // 11. Update SpecStore: mutate status -> READY, attempt -> newAttempt
    // All other fields preserved (id, max_attempts, criteria, scope, revision, dependencies)
    const updatedTask: TaskDefinition = {
      ...task,
      status: TaskStatus.READY,
      attempt: newAttempt,
      started_at: null,
      completed_at: null,
      metadata: {
        ...task.metadata,
        revision: authoritativeRevision,
      },
    };

    const updatedTasksList = specTasks.map((t) =>
      t.task_id === task.task_id ? updatedTask : t
    );

    try {
      await this.specStore.saveTasks(updatedTasksList);
    } catch (saveErr: any) {
      throw new RetryPersistenceError(
        `Failed to persist updated task in SpecStore: ${saveErr.message}`,
        { taskId: task.task_id, cause: saveErr }
      );
    }

    // 12. Update DurableState
    // Clear activeTaskId if it was this task, clear blockedState if matching this task
    let updatedActiveTaskId = durableState.activeTaskId;
    if (updatedActiveTaskId === task.task_id) {
      updatedActiveTaskId = null;
    }
    let updatedBlockedState = durableState.blockedState ?? null;
    if (updatedBlockedState?.blockedTaskId === task.task_id) {
      updatedBlockedState = null;
    }

    const retryRecord: RetryTransitionRecord = {
      retryKey,
      projectId: evidence.projectId,
      taskId: task.task_id,
      taskRevision: authoritativeRevision,
      previousAttempt: currentAttempt,
      newAttempt,
      maxAttempts,
      failureCategory: decision.failureCategory,
      recoveryStrategy: RecoveryStrategy.RETRY,
      evidenceId: evidence.evidenceId,
      requestId: evidence.requestId,
      taskStatus: TaskStatus.READY,
      authorizedAt: now,
      historyEventId,
    };

    const newRetryRecords = {
      ...retryRecords,
      [evidence.evidenceId]: retryRecord,
    };

    const updatedDurableState: DurableState = {
      ...durableState,
      activeTaskId: updatedActiveTaskId,
      blockedState: updatedBlockedState,
      updatedAt: now,
      metadata: {
        ...durableMetadata,
        retryTransitions: newRetryRecords,
      },
    };

    try {
      await this.durableStateManager.save(updatedDurableState);
    } catch (durableErr: any) {
      throw new RetryPersistenceError(
        `Failed to persist updated DurableState: ${durableErr.message}`,
        { taskId: task.task_id, cause: durableErr }
      );
    }

    const remaining = Math.max(0, maxAttempts - newAttempt);

    return {
      success: true,
      retryKey,
      projectId: evidence.projectId,
      taskId: task.task_id,
      taskRevision: authoritativeRevision,
      previousAttempt: currentAttempt,
      newAttempt,
      maxAttempts,
      remainingAttempts: remaining,
      taskStatus: TaskStatus.READY,
      isDuplicate: false,
      evidenceId: evidence.evidenceId,
      historyEventId,
      message: `Authorized retry transition for task '${task.task_id}' (attempt ${newAttempt}/${maxAttempts}). Task reset to READY.`,
      task: updatedTask,
    };
  }
}
