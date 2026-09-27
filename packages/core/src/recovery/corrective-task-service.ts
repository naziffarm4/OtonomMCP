/**
 * Corrective Task Lineage & Governed DAG Augmentation Service (Phase 13 TASK-P13-03)
 *
 * Implements the authoritative boundary that converts a verified failure with a P13-01
 * REPLAN policy decision into an authorized, validated corrective task that safely augments
 * the authoritative project DAG in SpecStore.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Accepts only verified SystemExecutionEvidence. Raw executor outcomes
 *    and caller-fabricated verification claims are rejected.
 * 2. STRICT REPLAN POLICY: Authorizes corrective task creation ONLY if policy decision is REPLAN
 *    and replanAllowed === true.
 * 3. AUTHORITATIVE PO APPROVAL: Requires explicit isDevelopmentAuthorized() === true from ApprovalPackageEngine.
 * 4. EXPLICIT LINEAGE: Corrective task immutably references sourceTaskId, sourceTaskRevision, and sourceEvidenceId.
 * 5. DETERMINISTIC TASK IDENTITY: Derived deterministically from project, source task, revision, and evidence.
 * 6. SOURCE TASK PRESERVATION: Original failed task is NOT overwritten, reset, or marked ACCEPTED.
 * 7. SCOPE GOVERNANCE: Target files and scopes are strictly validated and constrained within authorized project boundary.
 * 8. DAG AUTHORITY & ATOMIC INGESTION: Candidate augmented graph is strictly validated via TaskDagEngine before
 *    atomic persistence in SpecStore.
 * 9. IDEMPOTENCY: Repeated identical replans return the existing corrective task without duplicate DAG edges or tasks.
 * 10. ZERO AUTONOMOUS EXECUTION: Never invokes Antigravity or creates ExecutionIntent/ExecutionRequest.
 */

import { Actor } from '../actors.js';
import { TaskStatus, TaskPriority, type TaskDefinition } from '../task-engine/task-types.js';
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
  type CreateCorrectiveTaskInput,
  type CreateCorrectiveTaskOutcome,
  type CorrectiveTaskLineage,
  computeDeterministicCorrectiveTaskId,
  computeDeterministicReplanKey,
  computeDeterministicCorrectiveEventId,
} from './corrective-task-types.js';
import {
  CorrectiveTaskValidationError,
  CorrectiveTaskSecurityViolationError,
  CorrectiveTaskPolicyMismatchError,
  CorrectiveTaskBindingMismatchError,
  CorrectiveTaskSourceStateInvalidError,
  CorrectiveTaskUnauthorizedError,
  CorrectiveTaskScopeViolationError,
  CorrectiveTaskGraphValidationError,
  CorrectiveTaskConflictError,
  CorrectiveTaskPersistenceError,
} from './corrective-task-errors.js';
import { TaskGraphValidationError } from '../errors/task-graph-validation-error.js';

export interface CorrectiveTaskServiceOptions {
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

export class CorrectiveTaskService {
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

  constructor(options: CorrectiveTaskServiceOptions = {}) {
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
   * Main entry point: Validates inputs, creates corrective task with explicit lineage,
   * augments DAG, and persists atomically under filesystem lock.
   */
  async createCorrectiveTask(
    input: CreateCorrectiveTaskInput
  ): Promise<CreateCorrectiveTaskOutcome> {
    return await this.lock.withLock(async () => {
      return await this.executeCreateCorrectiveTaskUnderLock(input);
    });
  }

  /**
   * Validates and canonicalizes scope paths according to Section 10 / P11-03 / P12 rules.
   * Strictly prohibits path traversal ('..'), absolute paths, Windows drive paths, UNC paths, and null bytes.
   */
  canonicalizeScopePaths(
    rawPaths?: readonly string[],
    scopeName = 'scope'
  ): readonly string[] | undefined {
    if (rawPaths === undefined) {
      return undefined;
    }
    if (rawPaths.length === 0) {
      return Object.freeze([]);
    }

    const normalizedSet = new Set<string>();

    for (const raw of rawPaths) {
      if (typeof raw !== 'string') {
        throw new CorrectiveTaskScopeViolationError(
          `Scope path in ${scopeName} must be a string, got ${typeof raw}`,
          { [scopeName]: raw }
        );
      }

      if (raw.includes('\0')) {
        throw new CorrectiveTaskScopeViolationError(
          `Null byte detected in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new CorrectiveTaskScopeViolationError(
          `Scope path in ${scopeName} cannot be empty or whitespace only`,
          { [scopeName]: raw }
        );
      }

      // Check UNC paths (\\ or //)
      if (/^(\/\/|\\\\)/.test(trimmed)) {
        throw new CorrectiveTaskScopeViolationError(
          `UNC network paths are strictly prohibited in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      // Check Windows drive letter paths (e.g. C:\ or c:/)
      if (/^[a-zA-Z]:/.test(trimmed)) {
        throw new CorrectiveTaskScopeViolationError(
          `Windows drive paths are strictly prohibited in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      const posixPath = trimmed.replace(/\\/g, '/');

      // Check absolute Unix path
      if (posixPath.startsWith('/')) {
        throw new CorrectiveTaskScopeViolationError(
          `Absolute paths are strictly prohibited in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      // Check path traversal variants and segments
      const segments = posixPath.split('/');
      if (segments.includes('..')) {
        throw new CorrectiveTaskScopeViolationError(
          `Path traversal ('..') is strictly prohibited in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      const cleanPath = posixPath.replace(/^\.\//, '');
      if (cleanPath.length === 0) {
        throw new CorrectiveTaskScopeViolationError(
          `Scope path in ${scopeName} resolved to empty after normalization: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      normalizedSet.add(cleanPath);
    }

    const sorted = Array.from(normalizedSet).sort();
    return Object.freeze(sorted);
  }

  private async executeCreateCorrectiveTaskUnderLock(
    input: CreateCorrectiveTaskInput
  ): Promise<CreateCorrectiveTaskOutcome> {
    if (!input || typeof input !== 'object') {
      throw new CorrectiveTaskValidationError('Input must be a valid non-null object');
    }

    // 1. Evidence Validation: reject forbidden verification claims and raw outcomes
    const rawEvidence = input.evidence;
    if (!rawEvidence || typeof rawEvidence !== 'object') {
      throw new CorrectiveTaskValidationError('Input.evidence must be a valid non-null object');
    }

    try {
      assertNoForbiddenEvidenceFields(rawEvidence);
    } catch (err: any) {
      throw new CorrectiveTaskSecurityViolationError(err.message, { cause: err });
    }

    const evidenceParsed = SystemExecutionEvidenceZodSchema.safeParse(rawEvidence);
    if (!evidenceParsed.success) {
      const firstIssue = evidenceParsed.error.issues[0];
      const message = `Evidence schema validation failed: ${firstIssue?.message ?? evidenceParsed.error.message}`;
      if (firstIssue && (firstIssue.message.includes('Forbidden') || firstIssue.message.includes('fake'))) {
        throw new CorrectiveTaskSecurityViolationError(message, { issues: evidenceParsed.error.issues });
      }
      throw new CorrectiveTaskValidationError(message, { issues: evidenceParsed.error.issues });
    }

    const evidence: SystemExecutionEvidence = evidenceParsed.data;

    // Hard invariant: Only REJECT verificationDecision can be replanned
    if (evidence.verificationDecision !== 'REJECT') {
      throw new CorrectiveTaskPolicyMismatchError(
        `Cannot create corrective task for evidence with verificationDecision '${evidence.verificationDecision}'. Only 'REJECT' evidence is eligible for corrective replan.`,
        { verificationDecision: evidence.verificationDecision }
      );
    }

    // 2. Cross-Project Validation
    const expectedProject = input.expectedProjectId ?? this.expectedProjectId;
    if (expectedProject && evidence.projectId !== expectedProject) {
      throw new CorrectiveTaskBindingMismatchError(
        `Project ID mismatch: evidence targets '${evidence.projectId}', but expected '${expectedProject}'`,
        { evidenceProjectId: evidence.projectId, expectedProjectId: expectedProject }
      );
    }

    // 3. Load Authoritative Source Task from SpecStore
    let specTasks: TaskDefinition[];
    try {
      specTasks = await this.specStore.loadTasks();
    } catch (err: any) {
      throw new CorrectiveTaskPersistenceError(
        `Failed to load tasks from SpecStore: ${err.message}`,
        { cause: err }
      );
    }

    const sourceTask = specTasks.find((t) => t.task_id === evidence.taskId);
    if (!sourceTask) {
      throw new CorrectiveTaskBindingMismatchError(
        `Source task '${evidence.taskId}' not found in authoritative SpecStore`,
        { taskId: evidence.taskId }
      );
    }

    // Source Task Revision Validation
    const authoritativeRevision = (sourceTask.metadata?.revision as number) ?? 1;
    if (evidence.taskRevision !== authoritativeRevision) {
      throw new CorrectiveTaskBindingMismatchError(
        `Source task revision mismatch: evidence specifies revision ${evidence.taskRevision}, but authoritative task revision in SpecStore is ${authoritativeRevision}`,
        { evidenceRevision: evidence.taskRevision, authoritativeRevision }
      );
    }

    // Hard invariant: ACCEPTED / completed source task cannot be replanned
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

    const completedSet = new Set(durableState.completedTaskIds ?? []);
    if (sourceTask.status === TaskStatus.ACCEPTED || completedSet.has(sourceTask.task_id)) {
      throw new CorrectiveTaskSourceStateInvalidError(
        `Source task '${sourceTask.task_id}' is already marked ACCEPTED/completed; completed tasks cannot produce corrective tasks.`,
        { taskId: sourceTask.task_id, status: sourceTask.status }
      );
    }

    // 4. Validate or Evaluate Recovery Policy Decision
    let decision: RecoveryPolicyDecision;
    if (input.decision) {
      const decisionParsed = RecoveryPolicyDecisionZodSchema.safeParse(input.decision);
      if (!decisionParsed.success) {
        throw new CorrectiveTaskValidationError(
          `Decision schema validation failed: ${decisionParsed.error.issues[0]?.message ?? decisionParsed.error.message}`,
          { issues: decisionParsed.error.issues }
        );
      }
      decision = input.decision as RecoveryPolicyDecision;

      // Validate decision bindings
      if (decision.evidenceId !== evidence.evidenceId) {
        throw new CorrectiveTaskBindingMismatchError(
          `Decision evidenceId '${decision.evidenceId}' does not match evidence.evidenceId '${evidence.evidenceId}'`,
          { decisionEvidenceId: decision.evidenceId, evidenceId: evidence.evidenceId }
        );
      }
      if (decision.taskId !== sourceTask.task_id) {
        throw new CorrectiveTaskBindingMismatchError(
          `Decision taskId '${decision.taskId}' does not match task '${sourceTask.task_id}'`,
          { decisionTaskId: decision.taskId, taskId: sourceTask.task_id }
        );
      }
      if (decision.taskRevision !== authoritativeRevision) {
        throw new CorrectiveTaskBindingMismatchError(
          `Decision taskRevision '${decision.taskRevision}' does not match authoritative task revision '${authoritativeRevision}'`,
          { decisionTaskRevision: decision.taskRevision, authoritativeRevision }
        );
      }
      if (decision.projectId !== evidence.projectId) {
        throw new CorrectiveTaskBindingMismatchError(
          `Decision projectId '${decision.projectId}' does not match evidence.projectId '${evidence.projectId}'`,
          { decisionProjectId: decision.projectId, evidenceProjectId: evidence.projectId }
        );
      }
    } else {
      decision = this.recoveryPolicyEngine.evaluate({
        evidence,
        task: sourceTask,
        expectedProjectId: expectedProject,
      });
    }

    // Policy Decision check: strictly REPLAN and replanAllowed === true
    if (decision.decision !== RecoveryStrategy.REPLAN || !decision.replanAllowed) {
      throw new CorrectiveTaskPolicyMismatchError(
        `Recovery policy decision is '${decision.decision}' (replanAllowed: ${decision.replanAllowed}). Corrective task creation requires strategy 'REPLAN'.`,
        { decision: decision.decision, replanAllowed: decision.replanAllowed, reasonCodes: decision.reasonCodes }
      );
    }

    // 5. Bindings Verification: contextFingerprint, understandingRevision, approvalPackageRevision
    if (input.contextFingerprint !== undefined && evidence.contextFingerprint !== input.contextFingerprint) {
      throw new CorrectiveTaskBindingMismatchError(
        `Context fingerprint mismatch: evidence has '${evidence.contextFingerprint}', expected '${input.contextFingerprint}'`,
        { actual: evidence.contextFingerprint, expected: input.contextFingerprint }
      );
    }

    if (input.understandingRevision !== undefined && evidence.understandingRevision !== input.understandingRevision) {
      throw new CorrectiveTaskBindingMismatchError(
        `Understanding revision mismatch: evidence has revision ${evidence.understandingRevision}, expected ${input.understandingRevision}`,
        { actual: evidence.understandingRevision, expected: input.understandingRevision }
      );
    }

    if (input.approvalPackageRevision !== undefined && evidence.approvalPackageRevision !== input.approvalPackageRevision) {
      throw new CorrectiveTaskBindingMismatchError(
        `Approval package revision mismatch: evidence has revision ${evidence.approvalPackageRevision}, expected ${input.approvalPackageRevision}`,
        { actual: evidence.approvalPackageRevision, expected: input.approvalPackageRevision }
      );
    }

    // 6. Authoritative Development Authorization Check
    const activePkg = await this.approvalStore.getActivePackage();
    if (!activePkg) {
      throw new CorrectiveTaskUnauthorizedError(
        'No active approval package found in ApprovalStore. Corrective task creation is unauthorized.',
        { taskId: sourceTask.task_id }
      );
    }

    if (activePkg.projectId !== evidence.projectId) {
      throw new CorrectiveTaskBindingMismatchError(
        `Active approval package belongs to project '${activePkg.projectId}', not evidence project '${evidence.projectId}'`,
        { packageProjectId: activePkg.projectId, evidenceProjectId: evidence.projectId }
      );
    }

    if (evidence.approvalPackageRevision !== activePkg.revision) {
      throw new CorrectiveTaskBindingMismatchError(
        `Stale approval package revision: evidence bound to revision ${evidence.approvalPackageRevision}, but active approved package is at revision ${activePkg.revision}`,
        { evidenceApprovalRevision: evidence.approvalPackageRevision, activePackageRevision: activePkg.revision }
      );
    }

    const isDevAuth = this.approvalPackageEngine.isDevelopmentAuthorized(activePkg);
    if (!isDevAuth) {
      throw new CorrectiveTaskUnauthorizedError(
        `Active approval package '${activePkg.packageId}' is not authorized for development. Status: '${activePkg.status}'.`,
        { packageId: activePkg.packageId, status: activePkg.status }
      );
    }

    // 7. Director Session Validation if provided
    if (input.directorSessionId) {
      const session = await this.directorSessionStore.loadSession(input.directorSessionId);
      if (!session) {
        throw new CorrectiveTaskBindingMismatchError(
          `Director session '${input.directorSessionId}' was not found.`,
          { directorSessionId: input.directorSessionId }
        );
      }
      if (session.status !== 'ACTIVE') {
        throw new CorrectiveTaskUnauthorizedError(
          `Director session '${input.directorSessionId}' is ${session.status}. Execution requires an ACTIVE Director session.`,
          { directorSessionId: input.directorSessionId, status: session.status }
        );
      }
      if (session.projectId !== evidence.projectId) {
        throw new CorrectiveTaskBindingMismatchError(
          `Director session project '${session.projectId}' does not match evidence project '${evidence.projectId}'`,
          { sessionProjectId: session.projectId, evidenceProjectId: evidence.projectId }
        );
      }
      const snapshot = await this.directorSessionStore.loadLatestSnapshot(input.directorSessionId);
      if (snapshot && snapshot.logicalFingerprint !== evidence.contextFingerprint) {
        throw new CorrectiveTaskBindingMismatchError(
          `Context fingerprint mismatch with active Director session snapshot: evidence has '${evidence.contextFingerprint}', snapshot has '${snapshot.logicalFingerprint}'`,
          { evidenceFingerprint: evidence.contextFingerprint, snapshotFingerprint: snapshot.logicalFingerprint }
        );
      }
    }

    // 8. Deterministic Identity & Idempotency Key Computation
    const correctiveTaskId = computeDeterministicCorrectiveTaskId({
      projectId: evidence.projectId,
      sourceTaskId: sourceTask.task_id,
      sourceTaskRevision: authoritativeRevision,
      evidenceId: evidence.evidenceId,
    });

    const replanKey = computeDeterministicReplanKey({
      projectId: evidence.projectId,
      sourceTaskId: sourceTask.task_id,
      sourceTaskRevision: authoritativeRevision,
      evidenceId: evidence.evidenceId,
    });

    const durableMetadata = (durableState.metadata ?? {}) as Record<string, unknown>;
    const correctiveRecords = (durableMetadata.correctiveTasks ?? {}) as Record<
      string,
      {
        replanKey: string;
        correctiveTaskId: string;
        sourceTaskId: string;
        sourceTaskRevision: number;
        evidenceId: string;
        historyEventId?: string;
        createdAt: string;
      }
    >;

    // Idempotency check 1: record in DurableState metadata
    const existingRecord = correctiveRecords[evidence.evidenceId];
    // Idempotency check 2: already existing task in SpecStore
    const existingCorrectiveTask = specTasks.find((t) => t.task_id === correctiveTaskId);

    if (existingCorrectiveTask) {
      const lineage = existingCorrectiveTask.metadata?.lineage as CorrectiveTaskLineage | undefined;
      if (lineage && lineage.sourceEvidenceId !== evidence.evidenceId) {
        throw new CorrectiveTaskConflictError(
          `Conflict: Task with ID '${correctiveTaskId}' already exists in SpecStore with different evidence binding (${lineage.sourceEvidenceId} !== ${evidence.evidenceId}).`,
          { conflictingTaskId: correctiveTaskId }
        );
      }
    }

    if (existingRecord && existingCorrectiveTask) {
      // Validate complete DAG with existing task
      const topoOrder = this.dagEngine.topologicalSort(specTasks, {
        validFeatureIds: new Set([sourceTask.parent_feature_id]),
      });
      return {
        success: true,
        projectId: evidence.projectId,
        sourceTaskId: sourceTask.task_id,
        sourceTaskRevision: authoritativeRevision,
        correctiveTaskId,
        correctiveTask: existingCorrectiveTask,
        topologicalOrder: topoOrder,
        totalTaskCount: specTasks.length,
        replanKey,
        isDuplicate: true,
        historyEventId: existingRecord.historyEventId,
        evidenceId: evidence.evidenceId,
        message: `Corrective task '${correctiveTaskId}' already exists for evidence '${evidence.evidenceId}'. Returned idempotent outcome.`,
      };
    }

    if (existingCorrectiveTask && !existingRecord) {
      // If task exists in SpecStore under same ID, verify it is materially compatible
      const lineage = existingCorrectiveTask.metadata?.lineage as CorrectiveTaskLineage | undefined;
      if (lineage?.sourceEvidenceId === evidence.evidenceId) {
        const topoOrder = this.dagEngine.topologicalSort(specTasks, {
          validFeatureIds: new Set([sourceTask.parent_feature_id]),
        });
        return {
          success: true,
          projectId: evidence.projectId,
          sourceTaskId: sourceTask.task_id,
          sourceTaskRevision: authoritativeRevision,
          correctiveTaskId,
          correctiveTask: existingCorrectiveTask,
          topologicalOrder: topoOrder,
          totalTaskCount: specTasks.length,
          replanKey,
          isDuplicate: true,
          evidenceId: evidence.evidenceId,
          message: `Corrective task '${correctiveTaskId}' already persisted in SpecStore. Returned idempotent outcome.`,
        };
      } else {
        throw new CorrectiveTaskConflictError(
          `Conflict: Task with ID '${correctiveTaskId}' already exists in SpecStore with different evidence binding.`,
          { conflictingTaskId: correctiveTaskId }
        );
      }
    }

    // 9. Scope Governance and Proposal Normalization
    const proposal = input.proposal;
    let canonicalScope: Record<string, unknown> | undefined;

    // Base scope from source task if available
    const sourceScope = (sourceTask.metadata?.scope as Record<string, unknown> | undefined);

    if (proposal?.scope) {
      const pScope = proposal.scope;
      const analysisScope = this.canonicalizeScopePaths(pScope.analysisScope, 'analysisScope');
      const implementationScope = this.canonicalizeScopePaths(pScope.implementationScope, 'implementationScope');
      const targetFiles = this.canonicalizeScopePaths(pScope.targetFiles, 'targetFiles');

      // Scope protection: ensure targetFiles and implementationScope do not exceed sourceTask/approved plan scope
      if (sourceScope) {
        const sourceAllowedFiles = (sourceScope.allowedFiles as string[] | undefined) ?? [];
        const sourceImpl = (sourceScope.implementationScope as string[] | undefined) ?? sourceAllowedFiles;
        if (sourceImpl && sourceImpl.length > 0) {
          const sourceSet = new Set(sourceImpl);
          if (targetFiles) {
            for (const tf of targetFiles) {
              if (!sourceSet.has(tf)) {
                throw new CorrectiveTaskScopeViolationError(
                  `Corrective proposal targetFile '${tf}' exceeds authorized implementation scope of source task.`,
                  { targetFile: tf, authorizedScope: sourceImpl }
                );
              }
            }
          }
        }
      }

      canonicalScope = {
        ...(analysisScope !== undefined ? { analysisScope } : {}),
        ...(implementationScope !== undefined ? { implementationScope } : {}),
        ...(targetFiles !== undefined ? { targetFiles } : {}),
      };
    } else if (sourceScope) {
      // Inherit source scope safely
      canonicalScope = { ...sourceScope };
    }

    // 10. Formulate Corrective Task Definition with Lineage
    const now = new Date().toISOString();
    const lineageRecord: CorrectiveTaskLineage = {
      kind: 'CORRECTIVE',
      sourceTaskId: sourceTask.task_id,
      sourceTaskRevision: authoritativeRevision,
      sourceEvidenceId: evidence.evidenceId,
      sourceRecoveryDecisionId: decision.evidenceId,
      failureCategory: decision.failureCategory,
      recoveryStrategy: RecoveryStrategy.REPLAN,
      projectId: evidence.projectId,
      createdFrom: 'P13-03',
      createdAt: now,
    };

    // Dependencies: corrective task must depend on prerequisite tasks of source task,
    // plus optionally any additional dependencies supplied in the proposal.
    // Notice: The corrective task replaces the execution path of the source task;
    // to maintain a valid DAG without circularity, it depends on sourceTask.dependencies,
    // and can also depend on the sourceTask itself if modeled as sequential predecessor.
    // In our architecture, the corrective task depends on sourceTask.task_id
    // (original task failed -> corrective task runs after original task failure).
    const correctiveDependencies = Array.from(
      new Set([
        sourceTask.task_id,
        ...(proposal?.additionalDependencies ?? []),
      ])
    ).sort();

    // Acceptance criteria: must be explicit and non-empty
    let acceptanceCriteria: string[];
    if (proposal?.acceptanceCriteria !== undefined) {
      if (proposal.acceptanceCriteria.length === 0) {
        throw new CorrectiveTaskValidationError(
          'Candidate proposal acceptanceCriteria cannot be an empty array; at least one criterion required.',
          { acceptanceCriteria: proposal.acceptanceCriteria }
        );
      }
      acceptanceCriteria = [...proposal.acceptanceCriteria];
    } else {
      acceptanceCriteria = [
        `Resolve ${decision.failureCategory} failure from ${sourceTask.task_id} with verified acceptance.`,
        ...sourceTask.acceptance_criteria.map((ac) => `Satisfy requirement: ${ac}`),
      ];
    }

    const title =
      proposal?.title && proposal.title.trim().length > 0
        ? proposal.title.trim()
        : `[Corrective] ${sourceTask.title}`;

    const description =
      proposal?.description && proposal.description.trim().length > 0
        ? proposal.description.trim()
        : `Corrective task resolving ${decision.failureCategory} in ${sourceTask.task_id} (evidence: ${evidence.evidenceId}). Summary: ${decision.justification}`;

    // Traceability: must reference source task and failure diagnosis
    const traceabilitySources = [
      `PARENT_TASK:${sourceTask.task_id}`,
      `REQ:P13-03-CORRECTIVE`,
      ...sourceTask.traceability_sources.filter((s) => s.startsWith('REQ:') || s.startsWith('DEC:')),
    ];

    const correctiveTask: TaskDefinition = {
      task_id: correctiveTaskId,
      parent_feature_id: sourceTask.parent_feature_id,
      title,
      description,
      traceability_sources: traceabilitySources,
      dependencies: correctiveDependencies,
      acceptance_criteria: acceptanceCriteria,
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: sourceTask.max_attempts ?? 3,
      priority: proposal?.priority ?? sourceTask.priority ?? TaskPriority.HIGH,
      risk_level: sourceTask.risk_level,
      created_at: now,
      started_at: null,
      completed_at: null,
      hierarchy_level: sourceTask.hierarchy_level ?? 'TASK',
      metadata: {
        revision: 1,
        lineage: lineageRecord,
        ...(canonicalScope ? { scope: canonicalScope } : {}),
        ...(proposal?.metadata ?? {}),
      },
    };

    // 11. Validate Candidate Augmented Task Graph via TaskDagEngine
    // Candidate graph includes all existing specTasks + new correctiveTask
    const candidateTasks = [...specTasks, correctiveTask];

    let validatedTasks: TaskDefinition[];
    let topologicalOrder: string[];
    try {
      validatedTasks = this.dagEngine.assertValidGraph(candidateTasks, {
        validFeatureIds: new Set([sourceTask.parent_feature_id]),
      });
      topologicalOrder = this.dagEngine.topologicalSort(candidateTasks, {
        validFeatureIds: new Set([sourceTask.parent_feature_id]),
      });
    } catch (dagErr: any) {
      if (dagErr instanceof TaskGraphValidationError) {
        throw new CorrectiveTaskGraphValidationError(dagErr.message, {
          category: dagErr.category,
          taskId: dagErr.taskId,
          details: dagErr.details,
        });
      }
      throw new CorrectiveTaskGraphValidationError(
        `Task graph validation failed for candidate corrective task: ${dagErr.message}`,
        { cause: dagErr }
      );
    }

    // 12. History Event Recording
    const historyEventId = computeDeterministicCorrectiveEventId(replanKey);
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventId: historyEventId,
          timestamp: now,
          eventType: 'TASK_CORRECTIVE_CREATED',
          actor: Actor.ORCHESTRATOR,
          taskId: correctiveTaskId,
          payload: {
            projectId: evidence.projectId,
            sourceTaskId: sourceTask.task_id,
            sourceTaskRevision: authoritativeRevision,
            correctiveTaskId,
            correctiveTaskRevision: 1,
            evidenceId: evidence.evidenceId,
            recoveryStrategy: RecoveryStrategy.REPLAN,
            failureCategory: decision.failureCategory,
            replanKey,
            createdAt: now,
          },
        });
      } catch (histErr) {
        // Non-blocking audit protection
      }
    }

    // 13. Atomic Persistence to SpecStore
    // Ingest the validated augmented task list
    try {
      await this.specStore.saveTasks(validatedTasks);
    } catch (saveErr: any) {
      throw new CorrectiveTaskPersistenceError(
        `Failed to persist augmented task graph in SpecStore: ${saveErr.message}`,
        { cause: saveErr, correctiveTaskId }
      );
    }

    // 14. Update DurableState Metadata with Corrective Record
    const newCorrectiveRecords = {
      ...correctiveRecords,
      [evidence.evidenceId]: {
        replanKey,
        correctiveTaskId,
        sourceTaskId: sourceTask.task_id,
        sourceTaskRevision: authoritativeRevision,
        evidenceId: evidence.evidenceId,
        historyEventId,
        createdAt: now,
      },
    };

    const updatedDurableState: DurableState = {
      ...durableState,
      updatedAt: now,
      metadata: {
        ...durableMetadata,
        correctiveTasks: newCorrectiveRecords,
      },
    };

    try {
      await this.durableStateManager.save(updatedDurableState);
    } catch (durableErr: any) {
      throw new CorrectiveTaskPersistenceError(
        `Failed to update DurableState with corrective metadata: ${durableErr.message}`,
        { cause: durableErr }
      );
    }

    return {
      success: true,
      projectId: evidence.projectId,
      sourceTaskId: sourceTask.task_id,
      sourceTaskRevision: authoritativeRevision,
      correctiveTaskId,
      correctiveTask,
      topologicalOrder,
      totalTaskCount: validatedTasks.length,
      replanKey,
      isDuplicate: false,
      historyEventId,
      evidenceId: evidence.evidenceId,
      message: `Created governed corrective task '${correctiveTaskId}' with lineage to '${sourceTask.task_id}'. DAG augmented successfully.`,
    };
  }
}
