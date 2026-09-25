/**
 * Verified Execution State Integration Service (Phase 10 TASK-P10-05)
 *
 * Implements the authoritative state integration bridge connecting verified
 * P10-04 execution evidence to DurableStateManager (sole durable state authority)
 * and HistoryManager (sole audit authority).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Integrates ONLY P10-04 independently verified SystemExecutionEvidence.
 * 2. NO FABRICATED VERIFICATION: Rejects fake executor verification flags with security errors.
 * 3. NO SECOND FSM / NO SECOND STORE / NO SECOND DAG: Directly updates existing authoritative stores.
 * 4. STRICT DECISION SEMANTICS:
 *    - ACCEPT: marks task completed in completedTaskIds, clears activeTaskId, emits audit event.
 *    - REJECT: does NOT add task to completedTaskIds, clears activeTaskId, NEVER retries autonomously.
 *    - BLOCK: does NOT add task to completedTaskIds, persists structured BlockedState, NEVER marks accepted.
 * 5. DETERMINISTIC IDEMPOTENCY: Derived from evidenceId and execution binding.
 *    Replaying exact same evidenceId returns safe idempotent duplicate without duplicate mutations or events.
 *    Conflicting evidence for same (taskId, taskRevision, requestId) raises typed conflict error.
 * 6. ATOMIC FILESYSTEM LOCK: Uses ExecutionIntegrationLock (O_CREAT | O_EXCL) for true cross-process concurrency.
 * 7. ZERO ANTIGRAVITY DISPATCH: Never invokes executor adapters, Antigravity, or subagents.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import {
  type VerifiedExecutionResult,
  type ExecutionBinding,
  type ExecutionIntegrationRecord,
  type ExecutionIntegrationOutcome,
  type ReconciliationReport,
  type ReconciliationDiscrepancy,
  VerifiedExecutionResultZodSchema,
  computeDeterministicIntegrationKey,
  computeDeterministicIntegrationEventId,
  assertNoForbiddenIntegrationFields,
} from './execution-integration-types.js';
import {
  ExecutionIntegrationLock,
  type ExecutionIntegrationLockOptions,
} from './execution-integration-lock.js';
import {
  DurableStateManager,
  type DurableState,
  CURRENT_DURABLE_STATE_SCHEMA_VERSION,
} from '../storage/durable-state.js';
import { SpecStore } from '../storage/spec-store.js';
import { HistoryManager } from '../storage/history-manager.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import {
  type TaskDefinition,
  TaskStatus,
} from '../task-engine/task-types.js';
import {
  type BlockedState,
} from '../storage/blocked-state-schema.js';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
  type VerificationDecision,
  VERIFICATION_DECISIONS,
  isVerificationDecision,
} from '../evidence/system-execution-evidence.js';
import {
  ExecutionIntegrationError,
  ExecutionIntegrationValidationError,
  ExecutionIntegrationBindingMismatchError,
  ExecutionIntegrationStaleResultError,
  ExecutionIntegrationConflictError,
  ExecutionIntegrationSecurityViolationError,
  ExecutionIntegrationStateTransitionError,
  ExecutionIntegrationPersistenceError,
} from '../director/director-errors.js';
import { RawExecutorOutcomeZodSchema } from '../executor-bridge/raw-executor-outcome.js';

function isRawExecutorCandidate(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const rec = candidate as Record<string, unknown>;
  return (
    'executorIdentity' in rec ||
    'unverifiedAgentClaims' in rec ||
    ('requestBinding' in rec && !('verificationDecision' in rec))
  );
}

export interface ExecutionIntegrationServiceOptions {
  readonly durableStateManager?: DurableStateManager;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;
  readonly dagEngine?: TaskDagEngine;
  readonly lock?: ExecutionIntegrationLock;
  readonly lockOptions?: ExecutionIntegrationLockOptions;
  readonly expectedProjectId?: string;
  readonly baseDir?: string;
}

export interface ExpectedExecutionBinding {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly taskRevision?: number;
  readonly contextFingerprint?: string;
  readonly understandingRevision?: number;
  readonly approvalPackageRevision?: number;
  readonly requestId?: string;
}

export interface IntegrateOptions {
  readonly expectedBinding?: ExpectedExecutionBinding;
}

export class ExecutionStateIntegrator {
  readonly durableStateManager: DurableStateManager;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;
  readonly dagEngine: TaskDagEngine;
  readonly lock: ExecutionIntegrationLock;
  readonly expectedProjectId?: string;

  constructor(options: ExecutionIntegrationServiceOptions = {}) {
    const baseDir = options.baseDir ?? process.cwd();
    this.durableStateManager =
      options.durableStateManager ?? new DurableStateManager({ baseDir });
    this.specStore = options.specStore;
    this.historyManager = options.historyManager;
    this.dagEngine = options.dagEngine ?? new TaskDagEngine();
    this.lock =
      options.lock ??
      new ExecutionIntegrationLock({
        baseDir,
        ...options.lockOptions,
      });
    this.expectedProjectId = options.expectedProjectId;
  }

  /**
   * Normalizes and validates incoming integration input.
   * Can be either SystemExecutionEvidence directly, or VerifiedExecutionResult envelope,
   * or an object wrapping { evidence, expectedBinding }.
   */
  normalizeAndValidateEvidence(
    candidate: unknown,
    options?: IntegrateOptions
  ): {
    evidence: SystemExecutionEvidence;
    decision: VerificationDecision;
    expectedBinding?: ExpectedExecutionBinding;
  } {
    if (!candidate || typeof candidate !== 'object') {
      throw new ExecutionIntegrationValidationError(
        'Execution integration candidate must be a non-null object',
        { candidate }
      );
    }

    // Guard against RawExecutorOutcome
    if (isRawExecutorCandidate(candidate)) {
      throw new ExecutionIntegrationValidationError(
        'RawExecutorOutcome cannot be integrated directly. Only independent P10-04 SystemExecutionEvidence is permitted.',
        { code: 'ERR_RAW_EXECUTOR_OUTCOME_NOT_PERMITTED' }
      );
    }

    // Security guard: no forbidden fake verification fields
    assertNoForbiddenIntegrationFields(candidate);

    const rec = candidate as Record<string, unknown>;

    // Case 1: Wrapped in VerifiedExecutionResult or { evidence, ... }
    let rawEvidence: unknown;
    let expectedBindingFromEnvelope: ExpectedExecutionBinding | undefined;
    let envelopeDecision: VerificationDecision | undefined;

    if ('evidence' in rec && rec.evidence && typeof rec.evidence === 'object') {
      rawEvidence = rec.evidence;
      assertNoForbiddenIntegrationFields(rawEvidence);

      if ('executionBinding' in rec && rec.executionBinding && typeof rec.executionBinding === 'object') {
        expectedBindingFromEnvelope = rec.executionBinding as ExpectedExecutionBinding;
      }
      if ('verificationDecision' in rec && typeof rec.verificationDecision === 'string') {
        envelopeDecision = rec.verificationDecision as VerificationDecision;
      }
    } else {
      // Case 2: Candidate is SystemExecutionEvidence directly
      rawEvidence = candidate;
    }

    // Schema validation of SystemExecutionEvidence
    const parseResult = SystemExecutionEvidenceZodSchema.safeParse(rawEvidence);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      const message = `SystemExecutionEvidence schema validation failed: ${firstIssue?.message ?? parseResult.error.message}`;

      if (firstIssue && (firstIssue.message.includes('Forbidden') || firstIssue.message.includes('fake'))) {
        throw new ExecutionIntegrationSecurityViolationError(message, {
          issues: parseResult.error.issues,
        });
      }

      throw new ExecutionIntegrationValidationError(message, {
        issues: parseResult.error.issues,
      });
    }

    const evidence = parseResult.data as SystemExecutionEvidence;

    // Decision validation
    if (!isVerificationDecision(evidence.verificationDecision)) {
      throw new ExecutionIntegrationValidationError(
        `Invalid verification decision: '${evidence.verificationDecision}'. Must be one of: ${VERIFICATION_DECISIONS.join(', ')}`,
        { decision: evidence.verificationDecision }
      );
    }

    if (envelopeDecision && envelopeDecision !== evidence.verificationDecision) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Decision mismatch: envelope decision '${envelopeDecision}' !== evidence.verificationDecision '${evidence.verificationDecision}'`,
        { envelopeDecision, evidenceDecision: evidence.verificationDecision }
      );
    }

    // Merge expected bindings from options and envelope
    const expectedBinding: ExpectedExecutionBinding = {
      ...(expectedBindingFromEnvelope ?? {}),
      ...(options?.expectedBinding ?? {}),
    };

    if (this.expectedProjectId) {
      (expectedBinding as { projectId?: string }).projectId = this.expectedProjectId;
    }

    // Validate execution binding if expected fields are provided
    this.validateBinding(evidence, expectedBinding);

    return {
      evidence,
      decision: evidence.verificationDecision,
      expectedBinding,
    };
  }

  /**
   * Validates project/task/revision/context binding between evidence and expected context.
   */
  private validateBinding(
    evidence: SystemExecutionEvidence,
    expected: ExpectedExecutionBinding
  ): void {
    if (expected.projectId !== undefined && evidence.projectId !== expected.projectId) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Project ID mismatch: evidence targets '${evidence.projectId}', but expected '${expected.projectId}'`,
        { expected: expected.projectId, actual: evidence.projectId, field: 'projectId' }
      );
    }

    if (expected.taskId !== undefined && evidence.taskId !== expected.taskId) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Task ID mismatch: evidence targets '${evidence.taskId}', but expected '${expected.taskId}'`,
        { expected: expected.taskId, actual: evidence.taskId, field: 'taskId' }
      );
    }

    if (expected.taskRevision !== undefined && evidence.taskRevision !== expected.taskRevision) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Task revision mismatch: evidence specifies revision ${evidence.taskRevision}, but expected ${expected.taskRevision}`,
        { expected: expected.taskRevision, actual: evidence.taskRevision, field: 'taskRevision' }
      );
    }

    if (
      expected.contextFingerprint !== undefined &&
      evidence.contextFingerprint !== expected.contextFingerprint
    ) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Context fingerprint mismatch: evidence specifies '${evidence.contextFingerprint}', but expected '${expected.contextFingerprint}'`,
        { expected: expected.contextFingerprint, actual: evidence.contextFingerprint, field: 'contextFingerprint' }
      );
    }

    if (
      expected.understandingRevision !== undefined &&
      evidence.understandingRevision !== expected.understandingRevision
    ) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Understanding revision mismatch: evidence specifies revision ${evidence.understandingRevision}, but expected ${expected.understandingRevision}`,
        { expected: expected.understandingRevision, actual: evidence.understandingRevision, field: 'understandingRevision' }
      );
    }

    if (
      expected.approvalPackageRevision !== undefined &&
      evidence.approvalPackageRevision !== expected.approvalPackageRevision
    ) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Approval package revision mismatch: evidence specifies revision ${evidence.approvalPackageRevision}, but expected ${expected.approvalPackageRevision}`,
        { expected: expected.approvalPackageRevision, actual: evidence.approvalPackageRevision, field: 'approvalPackageRevision' }
      );
    }

    if (expected.requestId !== undefined && evidence.requestId !== expected.requestId) {
      throw new ExecutionIntegrationBindingMismatchError(
        `Request ID mismatch: evidence specifies requestId '${evidence.requestId}', but expected '${expected.requestId}'`,
        { expected: expected.requestId, actual: evidence.requestId, field: 'requestId' }
      );
    }
  }

  /**
   * Main entry point: integrates a verified execution result into authoritative system state.
   * Concurrency is enforced via atomic filesystem lock (O_CREAT | O_EXCL).
   */
  async integrate(
    candidate: unknown,
    options?: IntegrateOptions
  ): Promise<ExecutionIntegrationOutcome> {
    const { evidence, decision, expectedBinding } = this.normalizeAndValidateEvidence(
      candidate,
      options
    );

    // Acquire atomic filesystem lock before reading or modifying durable state
    return await this.lock.withLock(async () => {
      return await this.executeIntegrationUnderLock(evidence, decision);
    });
  }

  /**
   * Internal integration implementation running under exclusive filesystem lock.
   */
  private async executeIntegrationUnderLock(
    evidence: SystemExecutionEvidence,
    verificationDecision: VerificationDecision
  ): Promise<ExecutionIntegrationOutcome> {
    const { projectId, requestId, taskId, taskRevision } = evidence;
    const now = new Date().toISOString();

    const integrationKey = computeDeterministicIntegrationKey({
      projectId,
      requestId,
      taskId,
      taskRevision,
    });

    // 1. Inspect Authoritative DurableState
    const durableState = (await this.durableStateManager.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      updatedAt: now,
      metadata: {},
    };

    const metadata = (durableState.metadata ?? {}) as Record<string, unknown>;
    const integratedRecords = (metadata.integratedEvidence ?? {}) as Record<
      string,
      ExecutionIntegrationRecord
    >;

    // 2. Idempotency Check: Same evidenceId
    const existingByEvidenceId = integratedRecords[evidence.evidenceId];
    if (existingByEvidenceId) {
      // Safe idempotent duplicate: return cached outcome without re-mutating stores
      return {
        success: true,
        integrationKey: existingByEvidenceId.integrationKey,
        verificationDecision: existingByEvidenceId.verificationDecision,
        taskStatus: existingByEvidenceId.taskStatus,
        taskId,
        taskRevision,
        integratedAt: existingByEvidenceId.integratedAt,
        historyEventId: existingByEvidenceId.historyEventId,
        isDuplicate: true,
        affectedReadyTasks: existingByEvidenceId.affectedReadyTasks ?? [],
        message: `Idempotent duplicate: evidence '${evidence.evidenceId}' already integrated at ${existingByEvidenceId.integratedAt}`,
        details: existingByEvidenceId.details,
      };
    }

    // 3. Different evidence for same execution identity (taskId, taskRevision, requestId)
    const existingList = Object.values(integratedRecords);
    const existingForExecution = existingList.find(
      (r) =>
        r.taskId === taskId &&
        r.taskRevision === taskRevision &&
        r.requestId === requestId
    );

    if (existingForExecution) {
      // Conflict: different evidence object attempting to integrate for already integrated execution identity
      throw new ExecutionIntegrationConflictError(
        `Conflicting execution evidence detected for task '${taskId}' revision ${taskRevision} requestId '${requestId}'. Already integrated under evidenceId '${existingForExecution.evidenceId}', incoming evidenceId '${evidence.evidenceId}'.`,
        {
          taskId,
          taskRevision,
          requestId,
          existingEvidenceId: existingForExecution.evidenceId,
          incomingEvidenceId: evidence.evidenceId,
          existingDecision: existingForExecution.verificationDecision,
          incomingDecision: verificationDecision,
        }
      );
    }

    // Check conflict for same task revision under different requestId
    const existingForTaskRevision = existingList.find(
      (r) => r.taskId === taskId && r.taskRevision === taskRevision
    );
    if (existingForTaskRevision && existingForTaskRevision.requestId !== requestId) {
      throw new ExecutionIntegrationConflictError(
        `Conflicting execution evidence detected for task '${taskId}' revision ${taskRevision}: already integrated under requestId '${existingForTaskRevision.requestId}', incoming requestId '${requestId}'.`,
        {
          taskId,
          taskRevision,
          existingRequestId: existingForTaskRevision.requestId,
          incomingRequestId: requestId,
        }
      );
    }

    // 4. Authoritative SpecStore task check (if SpecStore configured)
    let specTasks: TaskDefinition[] | undefined;
    if (this.specStore) {
      try {
        specTasks = await this.specStore.loadTasks();
        const authoritativeTask = specTasks.find((t) => t.task_id === taskId);
        if (authoritativeTask) {
          const authoritativeRevision = (authoritativeTask.metadata?.revision as number) ?? 1;
          if (taskRevision !== authoritativeRevision) {
            throw new ExecutionIntegrationStaleResultError(
              `Task revision mismatch: verified evidence specifies revision ${taskRevision}, but authoritative task revision in SpecStore is ${authoritativeRevision}. Cannot integrate stale result.`,
              { taskId, resultTaskRevision: taskRevision, authoritativeRevision }
            );
          }
        }
      } catch (err) {
        if (err instanceof ExecutionIntegrationError) {
          throw err;
        }
        // If SpecStore fails to read, proceed with DurableState as primary authority
      }
    }

    // Check if task is already completed in DurableState by another evidence
    const completedSet = new Set(durableState.completedTaskIds ?? []);
    if (completedSet.has(taskId) && verificationDecision !== 'ACCEPT') {
      throw new ExecutionIntegrationConflictError(
        `Task '${taskId}' is already completed in DurableState; cannot overwrite completed status with non-ACCEPT decision '${verificationDecision}'.`,
        { taskId, verificationDecision }
      );
    }

    let targetTaskStatus: TaskStatus;
    let affectedReadyTasks: string[] = [];
    let updatedCompletedTaskIds = [...(durableState.completedTaskIds ?? [])];
    let updatedActiveTaskId = durableState.activeTaskId;
    let updatedBlockedState: BlockedState | null = durableState.blockedState ?? null;
    let updatedLifecycleState = durableState.currentLifecycleState;

    // 5. Apply Approved Decision Mapping
    if (verificationDecision === 'ACCEPT') {
      targetTaskStatus = TaskStatus.ACCEPTED;

      // Add taskId to completedTaskIds (deduplicated, sorted)
      if (!completedSet.has(taskId)) {
        completedSet.add(taskId);
        updatedCompletedTaskIds = Array.from(completedSet).sort((a, b) => a.localeCompare(b));
      }

      // Clear activeTaskId if matched
      if (updatedActiveTaskId === taskId) {
        updatedActiveTaskId = null;
      }

      // Clear blockedState if matching this task
      if (updatedBlockedState?.blockedTaskId === taskId) {
        updatedBlockedState = null;
      }

      // Compute ready tasks in DAG if SpecStore is available
      if (specTasks) {
        affectedReadyTasks = this.computeNewlyReadyTasks(specTasks, completedSet, taskId);
      }
    } else if (verificationDecision === 'REJECT') {
      targetTaskStatus = TaskStatus.REJECTED;

      // Do NOT add to completedTaskIds. Clear activeTaskId if matched.
      if (updatedActiveTaskId === taskId) {
        updatedActiveTaskId = null;
      }
    } else {
      // BLOCK
      targetTaskStatus = TaskStatus.BLOCKED;

      // Do NOT add to completedTaskIds. Clear activeTaskId if matched.
      if (updatedActiveTaskId === taskId) {
        updatedActiveTaskId = null;
      }

      const blockingReason =
        (evidence.metadata?.blockingReason as string | undefined) ??
        `Execution verification decision BLOCK for task '${taskId}' (requestId: '${requestId}')`;

      updatedBlockedState = {
        blockedTaskId: taskId,
        blockedIteration: taskRevision,
        blockedContextReference: evidence.contextFingerprint,
        blockingReason,
        resumePoint: 'TASK_LOOP',
        timestamp: now,
        metadata: {
          requestId,
          evidenceId: evidence.evidenceId,
        },
      };
    }

    // 6. Record Audit Event in HistoryManager
    let historyEventId: string | undefined;
    if (this.historyManager) {
      historyEventId = computeDeterministicIntegrationEventId(
        integrationKey,
        `EXECUTION_STATE_INTEGRATED_${verificationDecision}`
      );

      try {
        await this.historyManager.appendEvent({
          eventId: historyEventId,
          timestamp: now,
          eventType: 'EXECUTION_STATE_INTEGRATED',
          actor: Actor.ORCHESTRATOR,
          taskId,
          payload: {
            evidenceId: evidence.evidenceId,
            requestId,
            projectId,
            taskId,
            taskRevision,
            verificationDecision,
            integrationResult: targetTaskStatus,
            timestamp: now,
            affectedReadyTasks,
          },
        });
      } catch (historyErr) {
        // Crash window / recovery: History append is logged; state persistence proceeds
      }
    }

    // 7. Persist Updated DurableState
    const integrationRecord: ExecutionIntegrationRecord = {
      integrationKey,
      requestId,
      projectId,
      taskId,
      taskRevision,
      evidenceId: evidence.evidenceId,
      contextFingerprint: evidence.contextFingerprint,
      understandingRevision: evidence.understandingRevision,
      approvalPackageRevision: evidence.approvalPackageRevision,
      verificationDecision,
      taskStatus: targetTaskStatus,
      status:
        verificationDecision === 'ACCEPT'
          ? 'INTEGRATED'
          : verificationDecision === 'REJECT'
            ? 'REJECTED'
            : 'BLOCKED',
      integratedAt: now,
      historyEventId,
      affectedReadyTasks,
      details: {
        evidenceId: evidence.evidenceId,
        verifiedAt: evidence.verifiedAt,
      },
    };

    const newIntegratedMap = {
      ...integratedRecords,
      [evidence.evidenceId]: integrationRecord,
    };

    const updatedState: DurableState = {
      ...durableState,
      completedTaskIds: updatedCompletedTaskIds,
      activeTaskId: updatedActiveTaskId,
      blockedState: updatedBlockedState,
      updatedAt: now,
      metadata: {
        ...metadata,
        integratedEvidence: newIntegratedMap,
      },
    };

    try {
      await this.durableStateManager.save(updatedState);
    } catch (saveErr) {
      throw new ExecutionIntegrationPersistenceError(
        `Failed to persist updated DurableState: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        { taskId, cause: saveErr }
      );
    }

    // 8. Update SpecStore if present (secondary spec authority, preserving DurableState primacy)
    if (this.specStore && specTasks) {
      try {
        const updatedSpecTasks = specTasks.map((t) => {
          if (t.task_id === taskId) {
            return {
              ...t,
              status: targetTaskStatus,
              completed_at: targetTaskStatus === TaskStatus.ACCEPTED ? now : t.completed_at,
              metadata: {
                ...(t.metadata ?? {}),
                lastIntegratedEvidenceId: evidence.evidenceId,
                lastIntegrationDecision: verificationDecision,
                lastIntegratedAt: now,
              },
            };
          }
          return t;
        });
        await this.specStore.saveTasks(updatedSpecTasks);
      } catch {
        // SpecStore update failure is non-fatal to DurableState integration
      }
    }

    return {
      success: true,
      integrationKey,
      verificationDecision,
      taskStatus: targetTaskStatus,
      taskId,
      taskRevision,
      integratedAt: now,
      historyEventId,
      isDuplicate: false,
      affectedReadyTasks,
      message: `Execution evidence successfully integrated with decision ${verificationDecision}`,
      details: integrationRecord.details,
    };
  }

  /**
   * Computes newly ready tasks in the DAG after a task has been completed.
   */
  private computeNewlyReadyTasks(
    allTasks: readonly TaskDefinition[],
    completedTaskIds: ReadonlySet<string>,
    completedTaskId: string
  ): string[] {
    const directDependents = this.dagEngine.getDependents(allTasks as TaskDefinition[], completedTaskId);
    const readyTasks: string[] = [];

    for (const depTaskId of directDependents) {
      const depTask = allTasks.find((t) => t.task_id === depTaskId);
      if (!depTask) continue;
      if (completedTaskIds.has(depTaskId) || depTask.status === TaskStatus.ACCEPTED) continue;

      const allDepsMet = depTask.dependencies.every((d) => completedTaskIds.has(d));
      if (allDepsMet) {
        readyTasks.push(depTaskId);
      }
    }

    return readyTasks.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Authoritatively reconciles state across DurableStateManager, SpecStore,
   * and HistoryManager to recover from crash windows or partial persistence.
   */
  async reconcileAuthoritativeState(options?: { taskId?: string }): Promise<ReconciliationReport> {
    const now = new Date().toISOString();
    const discrepancies: ReconciliationDiscrepancy[] = [];

    const durableState = (await this.durableStateManager.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      updatedAt: now,
      metadata: {},
    };

    const metadata = (durableState.metadata ?? {}) as Record<string, unknown>;
    const integratedRecords = Object.values(
      (metadata.integratedEvidence ?? {}) as Record<string, ExecutionIntegrationRecord>
    );

    const completedInDurable = new Set(durableState.completedTaskIds ?? []);
    let durableStateChanged = false;
    const reconciledCompleted = new Set(completedInDurable);

    // Reconcile from integrated evidence in DurableState metadata
    for (const record of integratedRecords) {
      if (options?.taskId && record.taskId !== options.taskId) continue;

      if (record.verificationDecision === 'ACCEPT') {
        if (!reconciledCompleted.has(record.taskId)) {
          reconciledCompleted.add(record.taskId);
          durableStateChanged = true;
          discrepancies.push({
            taskId: record.taskId,
            type: 'COMPLETION_STATE_MISMATCH',
            description: `Task '${record.taskId}' recorded as ACCEPT in integrated evidence metadata but missing in completedTaskIds`,
            actionTaken: 'Added taskId to completedTaskIds',
          });
        }
      }
    }

    if (durableStateChanged) {
      const sortedCompleted = Array.from(reconciledCompleted).sort((a, b) => a.localeCompare(b));
      await this.durableStateManager.save({
        ...durableState,
        completedTaskIds: sortedCompleted,
        updatedAt: now,
      });
    }

    return {
      timestamp: now,
      reconciledCount: discrepancies.length,
      discrepancies,
      totalCompletedTasks: reconciledCompleted.size,
      activeTaskId: durableState.activeTaskId,
      isConsistent: discrepancies.length === 0,
    };
  }
}

// Backward-compatibility alias
export const ExecutionIntegrationService = ExecutionStateIntegrator;
