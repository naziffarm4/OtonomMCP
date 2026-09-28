/**
 * Director ↔ Executor Loop Orchestration Engine (Phase 16 TASK-P16-01)
 *
 * Implements the authoritative orchestration boundary connecting:
 * Director instruction
 * → AIDM authoritative instruction/context
 * → Execution authorization
 * → Execution
 * → independent evidence verification
 * → state integration
 * → evidence/report ingestion
 * → Director-visible result
 * → next Director instruction OR human decision routing.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. DIRECTOR INSTRUCTION IS NOT EXECUTION AUTHORITY: It must pass through ExecutionAuthorizer
 *    and require explicit human Product Owner approval.
 * 2. ZERO EXECUTOR TRUST: Neither RawExecutorOutcome nor stdout nor executor claims are proof;
 *    SystemExecutionEvidence is the sole authoritative proof.
 * 3. CONTROLLED ORCHESTRATION ONLY: Coordinates one controlled cycle at a time;
 *    automatic continuation is strictly forbidden (reserved for P17).
 * 4. FAIL CLOSED: Any inconsistency, stale revision, or cross-project mismatch fails immediately.
 * 5. NO NATURAL-LANGUAGE APPROVAL: Natural-language strings ('tamam', 'devam', 'onay', 'yes', 'ok')
 *    MUST NEVER count as approval.
 */

import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import {
  type DirectorInstruction,
  type IngestDirectorInstructionInput,
  type ExecuteDirectorCycleInput,
  type DirectorExecutionCycleResult,
  type DirectorNextActionBoundary,
  type EvaluateDirectorNextActionInput,
  DIRECTOR_INSTRUCTION_ACTOR,
  computeDeterministicInstructionId,
  computeDeterministicCycleId,
  IngestDirectorInstructionInputZodSchema,
  ExecuteDirectorCycleInputZodSchema,
  EvaluateDirectorNextActionInputZodSchema,
} from './director-loop-types.js';
import {
  DirectorInstructionValidationError,
  DirectorInstructionUnauthorizedError,
  DirectorInstructionStaleError,
  DirectorInstructionRevisionMismatchError,
  DirectorInstructionScopeMismatchError,
  DirectorInstructionSessionMismatchError,
  DirectorInstructionProjectMismatchError,
  DirectorInstructionDuplicateError,
  DirectorInstructionStateInconsistencyError,
  DirectorLoopExecutionError,
} from './director-loop-errors.js';
import type { ExecutionAcceptanceCriterion } from '../executor-bridge/execution-request-types.js';
import { DirectorLoopStore } from './director-loop-store.js';
import { ExecutionAuthorizer } from '../director/execution-authorizer.js';
import { ExecutionRequestBuilder } from '../executor-bridge/execution-request-builder.js';
import { ExecutorGuard, SHELL_INJECTION_PATTERN } from '../executor-bridge/executor-guard.js';
import type { ExecutorPort, ExecutionRequestExecutorPort } from '../executor-bridge/executor-port.js';
import { AntigravityAdapter } from '../executor-bridge/antigravity-adapter.js';
import { SystemEvidenceCollector } from '../evidence/execution-evidence-collector.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import { ExecutionStateIntegrator } from '../execution-integration/execution-integration-service.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { SpecStore } from '../storage/spec-store.js';
import { HistoryManager } from '../storage/history-manager.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { DirectorDecisionStore } from '../director/director-decision-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { RecoveryPolicyEngine } from '../recovery/recovery-policy-engine.js';
import { RetryAuthorizationService } from '../recovery/retry-authorization-service.js';
import { CorrectiveTaskService } from '../recovery/corrective-task-service.js';
import { RecoveryStrategy } from '../recovery/recovery-policy-types.js';

export interface DirectorLoopEngineOptions {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly loopStore?: DirectorLoopStore;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly decisionStore?: DirectorDecisionStore;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly specStore?: SpecStore;
  readonly dagEngine?: TaskDagEngine;
  readonly durableStateManager?: DurableStateManager;
  readonly historyManager?: HistoryManager;
  readonly executionAuthorizer?: ExecutionAuthorizer;
  readonly requestBuilder?: ExecutionRequestBuilder;
  readonly executorPort?: ExecutorPort;
  readonly evidenceCollector?: SystemEvidenceCollector;
  readonly evidenceStore?: SystemExecutionEvidenceStore;
  readonly stateIntegrator?: ExecutionStateIntegrator;
  readonly recoveryPolicyEngine?: RecoveryPolicyEngine;
  readonly retryAuthorizationService?: RetryAuthorizationService;
  readonly correctiveTaskService?: CorrectiveTaskService;
}

export class DirectorLoopEngine {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly loopStore: DirectorLoopStore;
  readonly sessionStore: DirectorSessionStore;
  readonly sessionEngine: DirectorSessionEngine;
  readonly decisionStore: DirectorDecisionStore;
  readonly approvalStore: ApprovalStore;
  readonly approvalPackageEngine: ApprovalPackageEngine;
  readonly specStore: SpecStore;
  readonly dagEngine: TaskDagEngine;
  readonly durableStateManager: DurableStateManager;
  readonly historyManager?: HistoryManager;
  readonly executionAuthorizer: ExecutionAuthorizer;
  readonly requestBuilder: ExecutionRequestBuilder;
  readonly executorPort: ExecutorPort;
  readonly evidenceCollector: SystemEvidenceCollector;
  readonly evidenceStore: SystemExecutionEvidenceStore;
  readonly stateIntegrator: ExecutionStateIntegrator;
  readonly recoveryPolicyEngine: RecoveryPolicyEngine;
  readonly retryAuthorizationService: RetryAuthorizationService;
  readonly correctiveTaskService: CorrectiveTaskService;

  constructor(options: DirectorLoopEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.delegate = options.delegate;
    this.historyManager = options.historyManager ?? options.delegate?.historyManager;

    this.loopStore =
      options.loopStore ??
      new DirectorLoopStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });

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
      options.approvalPackageEngine ??
      options.delegate?.approvalPackageEngine ??
      new ApprovalPackageEngine();

    this.specStore =
      options.specStore ??
      options.delegate?.specStore ??
      new SpecStore({ baseDir: this.workspaceRoot });

    this.dagEngine =
      options.dagEngine ?? options.delegate?.dagEngine ?? new TaskDagEngine();

    this.durableStateManager =
      options.durableStateManager ??
      options.delegate?.durableStateManager ??
      new DurableStateManager({ baseDir: this.workspaceRoot });

    this.executionAuthorizer =
      options.executionAuthorizer ??
      new ExecutionAuthorizer({
        workspaceRoot: this.workspaceRoot,
        delegate: this.delegate,
        sessionStore: this.sessionStore,
        sessionEngine: this.sessionEngine,
        decisionStore: this.decisionStore,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        specStore: this.specStore,
        dagEngine: this.dagEngine,
        historyManager: this.historyManager,
      });

    this.requestBuilder =
      options.requestBuilder ??
      new ExecutionRequestBuilder({
        workspaceRoot: this.workspaceRoot,
        authorizer: this.executionAuthorizer,
        specStore: this.specStore,
        historyManager: this.historyManager,
      });

    this.executorPort =
      options.executorPort ??
      options.delegate?.executorPort ??
      new AntigravityAdapter({
        workspaceRoot: this.workspaceRoot,
      });

    this.evidenceStore =
      options.evidenceStore ??
      new SystemExecutionEvidenceStore({ baseDir: this.workspaceRoot });

    this.evidenceCollector =
      options.evidenceCollector ??
      new SystemEvidenceCollector({
        evidenceStore: this.evidenceStore,
      });

    this.stateIntegrator =
      options.stateIntegrator ??
      new ExecutionStateIntegrator({
        durableStateManager: this.durableStateManager,
        specStore: this.specStore,
        historyManager: this.historyManager,
        evidenceStore: this.evidenceStore,
        dagEngine: this.dagEngine,
        baseDir: this.workspaceRoot,
      });

    this.recoveryPolicyEngine =
      options.recoveryPolicyEngine ??
      new RecoveryPolicyEngine({
        historyManager: this.historyManager,
      });

    this.retryAuthorizationService =
      options.retryAuthorizationService ??
      new RetryAuthorizationService({
        durableStateManager: this.durableStateManager,
        specStore: this.specStore,
        dagEngine: this.dagEngine,
        historyManager: this.historyManager,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        directorSessionStore: this.sessionStore,
        recoveryPolicyEngine: this.recoveryPolicyEngine,
        workspaceRoot: this.workspaceRoot,
      });

    this.correctiveTaskService =
      options.correctiveTaskService ??
      new CorrectiveTaskService({
        durableStateManager: this.durableStateManager,
        specStore: this.specStore,
        dagEngine: this.dagEngine,
        historyManager: this.historyManager,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        directorSessionStore: this.sessionStore,
        recoveryPolicyEngine: this.recoveryPolicyEngine,
        workspaceRoot: this.workspaceRoot,
      });
  }

  // ==========================================================================
  // 1. INGEST DIRECTOR INSTRUCTION
  // ==========================================================================

  /**
   * Authoritatively ingests, validates, and stores a Director instruction.
   * Strictly enforces:
   * - Actor must be 'DIRECTOR'
   * - Canonical project identity match (cross-project rejection)
   * - Active Director session match
   * - Valid IMPLEMENT_TASK Director decision
   * - Explicit human Product Owner approval (APPROVED + isDevelopmentAuthorized)
   * - Task existence and exact task revision match in SpecStore
   * - Prerequisite task dependency satisfaction
   * - Path traversal and implementation scope safety
   * - Fail-closed on any mismatch or stale state
   */
  async ingestInstruction(input: IngestDirectorInstructionInput): Promise<DirectorInstruction> {
    const parseResult = IngestDirectorInstructionInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      throw new DirectorInstructionValidationError(
        `Invalid Director instruction input: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parseResult.error.issues }
      );
    }

    const raw = parseResult.data;

    // 1. Actor constraint: strictly DIRECTOR
    if (raw.actor !== undefined && raw.actor !== DIRECTOR_INSTRUCTION_ACTOR) {
      throw new DirectorInstructionUnauthorizedError(
        `Actor '${raw.actor}' is unauthorized to issue Director instructions. Strictly 'DIRECTOR' required.`,
        { actor: raw.actor }
      );
    }

    // 2. Canonical project identity resolution & cross-project safety check
    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (raw.projectId !== undefined && raw.projectId !== null) {
      const trimmed = raw.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        throw new DirectorInstructionProjectMismatchError(
          `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project instruction rejected.`,
          { specifiedProjectId: trimmed, canonicalProjectId: canonical.projectId }
        );
      }
    }

    const projectId = canonical.projectId;

    // 3. Director Session validation
    let session;
    try {
      session = await this.sessionEngine.getSession(raw.directorSessionId, {
        workspaceRoot: targetRoot,
        projectId,
      });
    } catch (err: any) {
      throw new DirectorInstructionSessionMismatchError(
        `Failed to resolve Director session '${raw.directorSessionId}': ${err.message}`,
        { directorSessionId: raw.directorSessionId }
      );
    }

    if (session.status !== 'ACTIVE') {
      throw new DirectorInstructionSessionMismatchError(
        `Director session '${session.directorSessionId}' is ${session.status}. Instructions require an ACTIVE Director session.`,
        { directorSessionId: session.directorSessionId, status: session.status }
      );
    }

    if (session.projectId !== projectId) {
      throw new DirectorInstructionSessionMismatchError(
        `Director session '${session.directorSessionId}' is bound to project '${session.projectId}', not '${projectId}'.`,
        { sessionProjectId: session.projectId, canonicalProjectId: projectId }
      );
    }

    // Context snapshot check
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!latestSnapshot) {
      throw new DirectorInstructionStaleError(
        `Director session '${session.directorSessionId}' has no context snapshot. Instruction cannot be bound.`,
        { directorSessionId: session.directorSessionId }
      );
    }

    if (latestSnapshot.logicalFingerprint !== raw.contextFingerprint) {
      throw new DirectorInstructionStaleError(
        `Context fingerprint mismatch: instruction specified '${raw.contextFingerprint}', but authoritative snapshot is '${latestSnapshot.logicalFingerprint}'. Instruction is stale.`,
        {
          specifiedFingerprint: raw.contextFingerprint,
          authoritativeFingerprint: latestSnapshot.logicalFingerprint,
        }
      );
    }

    // Understanding revision check
    if (session.understandingRevision === null || session.understandingRevision === undefined) {
      throw new DirectorInstructionStateInconsistencyError(
        `Director session '${session.directorSessionId}' has no authoritative understanding revision.`,
        { directorSessionId: session.directorSessionId }
      );
    }

    if (raw.understandingRevision !== session.understandingRevision) {
      throw new DirectorInstructionRevisionMismatchError(
        `Understanding revision mismatch: instruction specifies revision ${raw.understandingRevision}, but session revision is ${session.understandingRevision}.`,
        {
          specifiedRevision: raw.understandingRevision,
          authoritativeRevision: session.understandingRevision,
        }
      );
    }

    // 4. Director Decision validation
    let decision;
    try {
      decision = await this.decisionStore.loadDecision(raw.directorDecisionId);
    } catch (err: any) {
      throw new DirectorInstructionValidationError(
        `Failed to load Director decision '${raw.directorDecisionId}': ${err.message}`,
        { directorDecisionId: raw.directorDecisionId }
      );
    }

    if (!decision) {
      throw new DirectorInstructionValidationError(
        `Director decision '${raw.directorDecisionId}' was not found.`,
        { directorDecisionId: raw.directorDecisionId }
      );
    }

    if (decision.decisionType !== 'IMPLEMENT_TASK') {
      throw new DirectorInstructionValidationError(
        `Director decision '${decision.decisionId}' has decisionType '${decision.decisionType}'. Instructions require strictly 'IMPLEMENT_TASK'.`,
        { directorDecisionId: decision.decisionId, decisionType: decision.decisionType }
      );
    }

    if (decision.directorSessionId !== session.directorSessionId) {
      throw new DirectorInstructionSessionMismatchError(
        `Director decision '${decision.decisionId}' belongs to session '${decision.directorSessionId}', not '${session.directorSessionId}'.`,
        { decisionSessionId: decision.directorSessionId, instructionSessionId: session.directorSessionId }
      );
    }

    if (decision.projectId !== projectId) {
      throw new DirectorInstructionProjectMismatchError(
        `Director decision '${decision.decisionId}' belongs to project '${decision.projectId}', not '${projectId}'.`,
        { decisionProjectId: decision.projectId, canonicalProjectId: projectId }
      );
    }

    if (decision.basedOnContextFingerprint !== latestSnapshot.logicalFingerprint) {
      throw new DirectorInstructionStaleError(
        `Director decision '${decision.decisionId}' was based on context fingerprint '${decision.basedOnContextFingerprint}', which does not match authoritative snapshot '${latestSnapshot.logicalFingerprint}'.`,
        { decisionFingerprint: decision.basedOnContextFingerprint, authoritativeFingerprint: latestSnapshot.logicalFingerprint }
      );
    }

    // 5. Product Owner Approval & Development Authorization Check
    const pkg = await this.approvalStore.getActivePackage();
    if (!pkg) {
      throw new DirectorInstructionUnauthorizedError(
        'No approval package found. Execution instructions cannot proceed without explicit Product Owner approval.',
        { projectId }
      );
    }

    if (pkg.projectId !== projectId) {
      throw new DirectorInstructionProjectMismatchError(
        `Active approval package belongs to project '${pkg.projectId}', not canonical '${projectId}'.`,
        { packageProjectId: pkg.projectId, canonicalProjectId: projectId }
      );
    }

    if (pkg.status !== 'APPROVED' || !pkg.approvalRecord) {
      throw new DirectorInstructionUnauthorizedError(
        `Approval package '${pkg.packageId}' is in status '${pkg.status}'. Execution requires an APPROVED package with explicit human approval.`,
        { packageId: pkg.packageId, status: pkg.status }
      );
    }

    const record = pkg.approvalRecord;
    if (record.actorRole !== 'PRODUCT_OWNER' && record.actorRole !== 'USER') {
      throw new DirectorInstructionUnauthorizedError(
        `Approval record actor role '${record.actorRole}' is unauthorized. Only human Product Owner or User can grant approval.`,
        { actorRole: record.actorRole }
      );
    }

    if (record.intent !== 'EXPLICIT_APPROVAL') {
      throw new DirectorInstructionUnauthorizedError(
        `Approval intent must strictly be 'EXPLICIT_APPROVAL', found '${record.intent}'.`,
        { intent: record.intent }
      );
    }

    if (raw.approvalPackageRevision !== pkg.revision) {
      throw new DirectorInstructionRevisionMismatchError(
        `Approval revision mismatch: instruction specifies revision ${raw.approvalPackageRevision}, but active approved package revision is ${pkg.revision}.`,
        { specifiedRevision: raw.approvalPackageRevision, activePackageRevision: pkg.revision }
      );
    }

    const isAuthorized = this.approvalPackageEngine.isDevelopmentAuthorized(pkg);
    if (!isAuthorized) {
      throw new DirectorInstructionUnauthorizedError(
        'Development is not authorized under authoritative isDevelopmentAuthorized() boundary.',
        { packageId: pkg.packageId }
      );
    }

    // 6. Task validation in SpecStore
    let tasks: TaskDefinition[] = [];
    try {
      tasks = await this.specStore.loadTasks();
    } catch (err: any) {
      throw new DirectorInstructionValidationError(
        `Failed to load tasks from SpecStore: ${err.message}`,
        { taskId: raw.taskId }
      );
    }

    const task = tasks.find((t) => t.task_id === raw.taskId);
    if (!task) {
      throw new DirectorInstructionValidationError(
        `Task '${raw.taskId}' was not found in authoritative SpecStore tasks.`,
        { taskId: raw.taskId }
      );
    }

    const taskRevision = task.metadata?.revision ?? 1;
    if (raw.taskRevision !== taskRevision) {
      throw new DirectorInstructionRevisionMismatchError(
        `Task revision mismatch: instruction specifies revision ${raw.taskRevision}, but authoritative task revision is ${taskRevision}. Instruction is stale.`,
        { specifiedTaskRevision: raw.taskRevision, authoritativeTaskRevision: taskRevision }
      );
    }

    // Prerequisite dependency satisfaction check
    if (task.dependencies && task.dependencies.length > 0) {
      const completedTaskIds = new Set(
        tasks.filter((t) => t.status === 'ACCEPTED').map((t) => t.task_id)
      );
      // Also check durable state completedTaskIds
      const durableState = await this.durableStateManager.load();
      if (durableState?.completedTaskIds) {
        for (const cid of durableState.completedTaskIds) {
          completedTaskIds.add(cid);
        }
      }

      const unmet = task.dependencies.filter((depId) => !completedTaskIds.has(depId));
      if (unmet.length > 0) {
        throw new DirectorInstructionStateInconsistencyError(
          `Task '${task.task_id}' has unmet dependencies: [${unmet.join(', ')}]. Prerequisite tasks must be ACCEPTED prior to instruction ingestion.`,
          { taskId: task.task_id, unmetDependencies: unmet }
        );
      }
    }

    // 7. Target files and implementation scope validation
    if (raw.targetFiles.length === 0) {
      throw new DirectorInstructionValidationError(
        'targetFiles must contain at least one file path',
        { taskId: raw.taskId }
      );
    }

    for (const f of raw.targetFiles) {
      if (typeof f !== 'string' || f.trim().length === 0) {
        throw new DirectorInstructionValidationError('targetFiles contains empty or non-string entry');
      }
      if (SHELL_INJECTION_PATTERN.test(f)) {
        throw new DirectorInstructionValidationError(
          `Shell injection characters detected in target file path: '${f}'`,
          { targetFile: f }
        );
      }
      if (f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.startsWith('//') || f.startsWith('\\\\')) {
        throw new DirectorInstructionValidationError(
          `Absolute paths are strictly prohibited in targetFiles: '${f}'`,
          { targetFile: f }
        );
      }
      const parts = f.split(/[/\\]/);
      if (parts.includes('..')) {
        throw new DirectorInstructionValidationError(
          `Path traversal sequence (..) detected in target file path: '${f}'`,
          { targetFile: f }
        );
      }
    }

    // If implementationScope is provided, verify all targetFiles are within implementationScope
    if (raw.implementationScope && raw.implementationScope.length > 0) {
      const allowedSet = new Set(raw.implementationScope.map((s) => s.replace(/^\.\//, '')));
      for (const f of raw.targetFiles) {
        const clean = f.replace(/^\.\//, '');
        if (!allowedSet.has(clean)) {
          throw new DirectorInstructionScopeMismatchError(
            `Target file '${f}' is not within authorized implementationScope: [${Array.from(allowedSet).join(', ')}]`,
            { targetFile: f, implementationScope: raw.implementationScope }
          );
        }
      }
    }

    // 8. Deterministic instructionId
    const instructionId =
      raw.instructionId ??
      computeDeterministicInstructionId({
        projectId,
        directorSessionId: session.directorSessionId,
        directorDecisionId: decision.decisionId,
        taskId: task.task_id,
        taskRevision,
      });

    const instruction: DirectorInstruction = {
      instructionId,
      projectId,
      directorSessionId: session.directorSessionId,
      directorDecisionId: decision.decisionId,
      taskId: task.task_id,
      taskRevision,
      contextFingerprint: latestSnapshot.logicalFingerprint,
      understandingRevision: session.understandingRevision,
      approvalPackageRevision: pkg.revision,
      objective: raw.objective.trim(),
      targetFiles: Object.freeze([...raw.targetFiles]),
      implementationScope: raw.implementationScope ? Object.freeze([...raw.implementationScope]) : undefined,
      acceptanceCriteria: raw.acceptanceCriteria
        ? Object.freeze([...(raw.acceptanceCriteria as unknown as readonly ExecutionAcceptanceCriterion[])])
        : undefined,
      constraints: raw.constraints ? Object.freeze([...raw.constraints]) : undefined,
      actor: DIRECTOR_INSTRUCTION_ACTOR,
      createdAt: new Date().toISOString(),
      metadata: raw.metadata,
    };

    // 9. Persist instruction
    await this.loopStore.saveInstruction(instruction);

    return instruction;
  }

  // ==========================================================================
  // 2. EXECUTE CONTROLLED EXECUTION CYCLE
  // ==========================================================================

  /**
   * Executes a single, controlled execution cycle using the existing authoritative pipeline.
   * Strictly coordinates:
   * ExecutionAuthorizer -> ExecutionIntent -> ExecutionRequestBuilder -> ExecutorGuard
   * -> ExecutorPort -> RawExecutorOutcome -> SystemEvidenceCollector -> SystemExecutionEvidence
   * -> ExecutionStateIntegrator -> DirectorExecutionCycleResult
   *
   * Rejects automatic repetition; executes exactly ONE cycle.
   */
  async executeCycle(input: ExecuteDirectorCycleInput): Promise<DirectorExecutionCycleResult> {
    const parseResult = ExecuteDirectorCycleInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      throw new DirectorLoopExecutionError(
        `Invalid executeCycle input: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parseResult.error.issues }
      );
    }

    // 1. Resolve instruction
    let instruction: DirectorInstruction | null = null;
    if (input.instruction) {
      instruction = input.instruction;
    } else {
      instruction = await this.loopStore.getInstruction(input.instructionId);
    }

    if (!instruction) {
      throw new DirectorInstructionValidationError(
        `Director instruction '${input.instructionId}' not found. Cannot execute cycle.`,
        { instructionId: input.instructionId }
      );
    }

    const workingDir = input.workingDirectory ?? input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();

    // 2. Freshness re-verification (Fail-closed against concurrent mutations)
    const session = await this.sessionEngine.getSession(instruction.directorSessionId, {
      workspaceRoot: workingDir,
      projectId: instruction.projectId,
    });
    if (session.status !== 'ACTIVE') {
      throw new DirectorInstructionStaleError(
        `Director session '${session.directorSessionId}' transitioned to ${session.status}. Cycle execution rejected.`,
        { directorSessionId: session.directorSessionId, status: session.status }
      );
    }

    const pkg = await this.approvalStore.getActivePackage();
    if (!pkg || pkg.status !== 'APPROVED' || pkg.revision !== instruction.approvalPackageRevision) {
      throw new DirectorInstructionStaleError(
        'Authoritative approval package changed or is no longer APPROVED. Cycle execution rejected.',
        { expectedRevision: instruction.approvalPackageRevision, actualRevision: pkg?.revision }
      );
    }

    // 3. Step 1: Execution Authorization (ExecutionAuthorizer)
    const intentValidation = await this.executionAuthorizer.validateExecutionIntent({
      workspaceRoot: workingDir,
      projectId: instruction.projectId,
      directorSessionId: instruction.directorSessionId,
      directorDecisionId: instruction.directorDecisionId,
      taskId: instruction.taskId,
      taskRevision: instruction.taskRevision,
      contextFingerprint: instruction.contextFingerprint,
      understandingRevision: instruction.understandingRevision,
      approvalPackageRevision: instruction.approvalPackageRevision,
      operationType: 'IMPLEMENT_TASK',
    });

    if (!intentValidation.isValid || !intentValidation.intent) {
      throw new DirectorInstructionUnauthorizedError(
        `Execution authorization failed: ${intentValidation.message}`,
        { code: intentValidation.code, details: intentValidation.details }
      );
    }

    const intent = intentValidation.intent;

    // 4. Step 2: Build Deterministic Execution Request (ExecutionRequestBuilder)
    const request = await this.requestBuilder.buildExecutionRequest({
      intent,
      workingDirectory: workingDir,
      instruction: {
        objective: instruction.objective,
        targetFiles: instruction.targetFiles,
        implementationScope: instruction.implementationScope,
        acceptanceCriteria: instruction.acceptanceCriteria,
        constraints: instruction.constraints,
      },
      executionLimits: input.timeoutMs ? { timeoutMs: input.timeoutMs } : undefined,
    });

    // 5. Step 3: Precondition and Security Validation (ExecutorGuard)
    ExecutorGuard.validateExecutionPreconditions(request, {
      workingDirectory: workingDir,
    });

    // 6. Step 4: Execute via ExecutorPort
    // AntigravityAdapter or mock executor
    let rawOutcome;
    try {
      const execResult = await (this.executorPort as ExecutionRequestExecutorPort).execute(request, {
        signal: input.signal,
      });
      rawOutcome = execResult as any;
    } catch (err: any) {
      throw new DirectorLoopExecutionError(
        `Executor failure during cycle execution: ${err.message}`,
        { requestId: request.requestId, error: err }
      );
    }

    // 7. Step 5: Independent Evidence Verification (SystemEvidenceCollector)
    // CRITICAL: RawExecutorOutcome is NOT proof. Only independently collected facts matter.
    const systemEvidence = await this.evidenceCollector.collectAndVerify(request, rawOutcome, {
      workingDirectory: workingDir,
      evidenceStore: this.evidenceStore,
    });

    // 8. Step 6: State Integration (ExecutionStateIntegrator)
    const integrationOutcome = await this.stateIntegrator.integrate(systemEvidence);

    // 9. Step 7: Construct Authoritative DirectorExecutionCycleResult
    const verificationDecision = systemEvidence.verificationDecision;
    const terminalStatus: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' =
      verificationDecision === 'ACCEPT'
        ? 'ACCEPTED'
        : verificationDecision === 'BLOCK'
          ? 'BLOCKED'
          : 'REJECTED';

    const cycleId = computeDeterministicCycleId({
      instructionId: instruction.instructionId,
      requestId: request.requestId,
      evidenceId: systemEvidence.evidenceId,
    });

    const cycleResult: DirectorExecutionCycleResult = {
      cycleId,
      instructionId: instruction.instructionId,
      projectId: instruction.projectId,
      taskId: instruction.taskId,
      taskRevision: instruction.taskRevision,
      directorSessionId: instruction.directorSessionId,
      directorDecisionId: instruction.directorDecisionId,
      executionIntent: intent,
      executionRequest: request,
      rawExecutorOutcome: rawOutcome,
      systemEvidence,
      verificationDecision,
      integrationOutcome,
      terminalStatus,
      completedAt: new Date().toISOString(),
      isAuthoritativeProof: {
        executorOutcomeIsProof: false, // Invariant: executor claims are never proof
        systemEvidenceIsProof: true,   // Invariant: SystemExecutionEvidence is sole authority
      },
    };

    // 10. Persist cycle result
    await this.loopStore.saveCycleResult(cycleResult);

    return cycleResult;
  }

  // ==========================================================================
  // 3. EVALUATE NEXT-ACTION BOUNDARY & HUMAN DECISION ROUTING
  // ==========================================================================

  /**
   * Evaluates the next-action boundary after an execution cycle.
   * Strictly enforces:
   * - NEVER automatically executes the next task (autoContinue is false)
   * - Does NOT accept natural language strings ('tamam', 'devam', 'onay') as approval
   * - Routes human decisions explicitly when BLOCK / BLOCK_ON_HUMAN occurs
   * - Integrates recovery policy (RETRY / REPLAN / BLOCK) when REJECT occurs
   */
  async evaluateNextAction(
    input: EvaluateDirectorNextActionInput
  ): Promise<DirectorNextActionBoundary> {
    const parseResult = EvaluateDirectorNextActionInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      throw new DirectorLoopExecutionError(
        `Invalid evaluateNextAction input: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parseResult.error.issues }
      );
    }

    const workingDir = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    const projectId = input.projectId ?? canonical.projectId;

    let cycleResult: DirectorExecutionCycleResult | null = null;
    if (input.cycleId) {
      cycleResult = await this.loopStore.getCycleResult(input.cycleId);
    } else if (input.instructionId) {
      cycleResult = await this.loopStore.getCycleResultByInstructionId(input.instructionId);
    } else if (input.taskId) {
      cycleResult = await this.loopStore.getLatestCycleResultForTask(projectId, input.taskId);
    }

    if (!cycleResult) {
      throw new DirectorInstructionValidationError(
        'No cycle result found for next action evaluation. An execution cycle must be completed first.',
        { input }
      );
    }

    const { taskId, taskRevision, directorSessionId, terminalStatus, systemEvidence } = cycleResult;

    // Load authoritative task definition
    const tasks = await this.specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === taskId);
    if (!task) {
      throw new DirectorInstructionValidationError(`Task '${taskId}' not found in SpecStore`, { taskId });
    }

    if (terminalStatus === 'ACCEPTED') {
      return {
        projectId,
        directorSessionId,
        taskId,
        taskRevision,
        latestCycleResult: cycleResult,
        actionStatus: 'EXECUTION_ACCEPTED',
        taskCompleted: true,
        canIssueNextInstruction: true,
        autoContinue: false, // Invariant: no automatic continuation
        continuationPolicy: 'CONTROLLED_MANUAL',
        humanDecisionRequired: false,
      };
    }

    if (terminalStatus === 'BLOCKED') {
      const blockedState = (await this.durableStateManager.load())?.blockedState;
      return {
        projectId,
        directorSessionId,
        taskId,
        taskRevision,
        latestCycleResult: cycleResult,
        actionStatus: 'HUMAN_DECISION_REQUIRED',
        taskCompleted: false,
        canIssueNextInstruction: false,
        autoContinue: false,
        continuationPolicy: 'CONTROLLED_MANUAL',
        humanDecisionRequired: true,
        humanDecisionPoint: {
          decisionId: `decision-${taskId}-blocked`,
          category: 'EXECUTION_BLOCKED',
          description: `Task '${taskId}' execution is blocked and requires human intervention.`,
          reason: systemEvidence.failureCategory ?? 'Execution verification returned BLOCK decision.',
          blockedState,
        },
      };
    }

    // Terminal status is REJECTED: evaluate recovery policy
    const policyDecision = this.recoveryPolicyEngine.evaluate({
      evidence: systemEvidence,
      task,
      expectedProjectId: projectId,
    });

    if (policyDecision.decision === RecoveryStrategy.RETRY) {
      let retryAuth;
      try {
        retryAuth = await this.retryAuthorizationService.authorizeRetry({
          evidence: systemEvidence,
          decision: policyDecision,
          expectedProjectId: projectId,
        });
      } catch {
        // if retry auth fails, fall back to human decision
      }

      return {
        projectId,
        directorSessionId,
        taskId,
        taskRevision,
        latestCycleResult: cycleResult,
        actionStatus: 'EXECUTION_REJECTED',
        taskCompleted: false,
        canIssueNextInstruction: true,
        autoContinue: false,
        continuationPolicy: 'CONTROLLED_MANUAL',
        recoveryRecommendation: policyDecision,
        retryAuthorization: retryAuth,
        humanDecisionRequired: false,
      };
    }

    if (policyDecision.decision === RecoveryStrategy.REPLAN) {
      return {
        projectId,
        directorSessionId,
        taskId,
        taskRevision,
        latestCycleResult: cycleResult,
        actionStatus: 'EXECUTION_REJECTED',
        taskCompleted: false,
        canIssueNextInstruction: true,
        autoContinue: false,
        continuationPolicy: 'CONTROLLED_MANUAL',
        recoveryRecommendation: policyDecision,
        humanDecisionRequired: false,
      };
    }

    // BLOCK_ON_HUMAN or retry budget exhausted
    return {
      projectId,
      directorSessionId,
      taskId,
      taskRevision,
      latestCycleResult: cycleResult,
      actionStatus: 'HUMAN_DECISION_REQUIRED',
      taskCompleted: false,
      canIssueNextInstruction: false,
      autoContinue: false,
      continuationPolicy: 'CONTROLLED_MANUAL',
      recoveryRecommendation: policyDecision,
      humanDecisionRequired: true,
      humanDecisionPoint: {
        decisionId: `decision-${taskId}-recovery-blocked`,
        category: 'RECOVERY_EXHAUSTED',
        description: `Recovery policy requires human decision: ${policyDecision.justification}`,
        reason: policyDecision.justification,
      },
    };
  }
}
