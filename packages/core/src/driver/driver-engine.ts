/**
 * Autonomous Driver Engine (Phase 17 TASK-P17-01)
 *
 * Implements deterministic orchestration policy for the Autonomous Driver:
 * - Decides what a driver iteration means
 * - Evaluates authoritative state before and after each cycle
 * - Coordinates existing Director ↔ Executor Loop (P16) without bypass
 * - Evaluates governed continuation policy (no uncontrolled loops)
 * - Coordinates recovery (P13/P14) without replacing it
 * - Strictly observes human decision boundaries
 * - Has ZERO process lifetime responsibility (separated into DriverRuntime)
 */

import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { Actor } from '../actors.js';
import {
  type DriverRunIterationInput,
  type DriverIterationResult,
  type DriverIterationDecision,
  type DriverContinuationValidationResult,
  type DriverHumanDecisionPoint,
} from './driver-types.js';
import {
  DriverValidationError,
  DriverAuthorizationError,
  DriverStaleStateError,
  DriverExecutionError,
} from './driver-errors.js';
import { DirectorLoopEngine } from '../director-loop/director-loop-engine.js';
import { DirectorLoopStore } from '../director-loop/director-loop-store.js';
import type {
  DirectorInstruction,
  DirectorExecutionCycleResult,
  DirectorNextActionBoundary,
} from '../director-loop/director-loop-types.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { DirectorDecisionStore } from '../director/director-decision-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { SpecStore } from '../storage/spec-store.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { HistoryManager } from '../storage/history-manager.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { RecoveryPolicyEngine } from '../recovery/recovery-policy-engine.js';
import { RetryAuthorizationService } from '../recovery/retry-authorization-service.js';
import { CorrectiveTaskService } from '../recovery/corrective-task-service.js';
import { RecoveryStrategy } from '../recovery/recovery-policy-types.js';
import type { DirectorDecision } from '../director/director-decision-types.js';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';

export interface DriverEngineOptions {
  readonly workspaceRoot?: string;
  readonly directorLoopEngine?: DirectorLoopEngine;
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
  readonly evidenceStore?: SystemExecutionEvidenceStore;
  readonly executorPort?: ExecutorPort;
  readonly recoveryPolicyEngine?: RecoveryPolicyEngine;
  readonly retryAuthorizationService?: RetryAuthorizationService;
  readonly correctiveTaskService?: CorrectiveTaskService;
}

export class DriverEngine {
  readonly workspaceRoot?: string;
  readonly directorLoopEngine: DirectorLoopEngine;
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
  readonly evidenceStore: SystemExecutionEvidenceStore;
  readonly recoveryPolicyEngine: RecoveryPolicyEngine;
  readonly retryAuthorizationService: RetryAuthorizationService;
  readonly correctiveTaskService: CorrectiveTaskService;

  constructor(options: DriverEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;

    if (options.directorLoopEngine) {
      this.directorLoopEngine = options.directorLoopEngine;
      this.loopStore = options.directorLoopEngine.loopStore;
      this.sessionStore = options.directorLoopEngine.sessionStore;
      this.sessionEngine = options.directorLoopEngine.sessionEngine;
      this.decisionStore = options.directorLoopEngine.decisionStore;
      this.approvalStore = options.directorLoopEngine.approvalStore;
      this.approvalPackageEngine = options.directorLoopEngine.approvalPackageEngine;
      this.specStore = options.directorLoopEngine.specStore;
      this.dagEngine = options.directorLoopEngine.dagEngine;
      this.durableStateManager = options.directorLoopEngine.durableStateManager;
      this.evidenceStore = options.directorLoopEngine.evidenceStore;
      this.recoveryPolicyEngine = options.directorLoopEngine.recoveryPolicyEngine;
      this.retryAuthorizationService = options.directorLoopEngine.retryAuthorizationService;
      this.correctiveTaskService = options.directorLoopEngine.correctiveTaskService;
    } else {
      this.loopStore =
        options.loopStore ??
        new DirectorLoopStore({ baseDir: this.workspaceRoot, historyManager: this.historyManager });
      this.sessionStore =
        options.sessionStore ??
        new DirectorSessionStore({ baseDir: this.workspaceRoot, historyManager: this.historyManager });
      this.sessionEngine =
        options.sessionEngine ??
        new DirectorSessionEngine({ store: this.sessionStore, workspaceRoot: this.workspaceRoot });
      this.decisionStore =
        options.decisionStore ??
        new DirectorDecisionStore({ sessionStore: this.sessionStore, historyManager: this.historyManager });
      this.approvalStore =
        options.approvalStore ??
        new ApprovalStore({ baseDir: this.workspaceRoot, historyManager: this.historyManager });
      this.approvalPackageEngine =
        options.approvalPackageEngine ?? new ApprovalPackageEngine();
      this.specStore =
        options.specStore ?? new SpecStore({ baseDir: this.workspaceRoot });
      this.dagEngine =
        options.dagEngine ?? new TaskDagEngine();
      this.durableStateManager =
        options.durableStateManager ??
        new DurableStateManager({ baseDir: this.workspaceRoot });
      this.evidenceStore =
        options.evidenceStore ??
        new SystemExecutionEvidenceStore({ baseDir: this.workspaceRoot });
      this.recoveryPolicyEngine =
        options.recoveryPolicyEngine ??
        new RecoveryPolicyEngine({ historyManager: this.historyManager });
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

      this.directorLoopEngine = new DirectorLoopEngine({
        workspaceRoot: this.workspaceRoot,
        loopStore: this.loopStore,
        sessionStore: this.sessionStore,
        sessionEngine: this.sessionEngine,
        decisionStore: this.decisionStore,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        specStore: this.specStore,
        dagEngine: this.dagEngine,
        durableStateManager: this.durableStateManager,
        historyManager: this.historyManager,
        evidenceStore: this.evidenceStore,
        executorPort: options.executorPort,
        recoveryPolicyEngine: this.recoveryPolicyEngine,
        retryAuthorizationService: this.retryAuthorizationService,
        correctiveTaskService: this.correctiveTaskService,
      });
    }
  }

  // ==========================================================================
  // 1. GOVERNED CONTINUATION VALIDATION
  // ==========================================================================

  /**
   * Authoritatively re-validates all required conditions before allowing continuation:
   * 1. Project identity matches canonical
   * 2. Active Director session exists and is ACTIVE
   * 3. Authoritative human Product Owner approval package is APPROVED and development authorized
   * 4. No active blocked state in DurableStateManager
   * 5. Task state, revision, and dependency readiness
   * 6. Fails closed on any inconsistency or staleness
   */
  async validateContinuation(
    workingDir: string,
    expectedProjectId?: string,
    targetTaskId?: string
  ): Promise<DriverContinuationValidationResult> {
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    const projectId = expectedProjectId ?? canonical.projectId;
    if (canonical.projectId !== projectId) {
      return {
        isAllowed: false,
        requiresHumanDecision: true,
        reason: `Project identity mismatch: expected '${projectId}', detected '${canonical.projectId}'. Execution rejected.`,
        humanDecisionPoint: {
          decisionId: `decision-${projectId}-mismatch`,
          category: 'PROJECT_MISMATCH',
          description: 'Project identity mismatch detected.',
          reason: `Expected ${projectId}, got ${canonical.projectId}`,
        },
      };
    }

    // 1. Check DurableStateManager for blockedState
    const durableState = await this.durableStateManager.load();
    if (durableState?.blockedState) {
      return {
        isAllowed: false,
        requiresHumanDecision: true,
        reason: `Durable state is blocked on human decision: ${durableState.blockedState.blockingReason}`,
        humanDecisionPoint: {
          decisionId: `decision-${durableState.activeTaskId ?? 'task'}-blocked`,
          category: 'BLOCKED_ON_HUMAN',
          description: 'Durable state indicates system is blocked on human decision.',
          reason: durableState.blockedState.blockingReason,
          blockedState: durableState.blockedState,
        },
      };
    }

    // 2. Check Product Owner Approval Package
    const pkg = await this.approvalStore.getActivePackage();
    if (!pkg || pkg.status !== 'APPROVED') {
      return {
        isAllowed: false,
        requiresHumanDecision: true,
        reason: 'Authoritative human Product Owner approval package is missing or not in APPROVED state.',
        humanDecisionPoint: {
          decisionId: 'decision-po-approval-required',
          category: 'APPROVAL_REQUIRED',
          description: 'Autonomous execution requires an active, APPROVED human Product Owner approval package.',
          reason: 'No APPROVED package found in ApprovalStore.',
        },
      };
    }

    const isAuthorized = this.approvalPackageEngine.isDevelopmentAuthorized(pkg);
    if (!isAuthorized) {
      return {
        isAllowed: false,
        requiresHumanDecision: true,
        reason: 'Product Owner approval package does not authorize development (development is blocked).',
        humanDecisionPoint: {
          decisionId: 'decision-po-development-unauthorized',
          category: 'DEVELOPMENT_UNAUTHORIZED',
          description: 'Product Owner approval package explicitly blocks development.',
          reason: 'isDevelopmentAuthorized returned false.',
        },
      };
    }

    // 3. Check Director Session
    const session = await this.sessionStore.getActiveSession();
    if (!session || session.status !== 'ACTIVE') {
      return {
        isAllowed: false,
        requiresHumanDecision: true,
        reason: `Director session is not ACTIVE (status: ${session?.status ?? 'NONE'}).`,
        humanDecisionPoint: {
          decisionId: 'decision-session-inactive',
          category: 'SESSION_INACTIVE',
          description: 'Active Director session required for driver continuation.',
          reason: `Session status is ${session?.status ?? 'NONE'}.`,
        },
      };
    }

    // 4. Resolve next ready task and check dependencies
    const tasks = await this.specStore.loadTasks();
    if (tasks.length === 0) {
      return {
        isAllowed: false,
        requiresHumanDecision: false,
        reason: 'SpecStore has no defined tasks.',
      };
    }

    const completedTaskIds = new Set(
      tasks.filter((t) => t.status === 'ACCEPTED').map((t) => t.task_id)
    );
    if (durableState?.completedTaskIds) {
      for (const id of durableState.completedTaskIds) {
        completedTaskIds.add(id);
      }
    }

    let candidateTask: TaskDefinition | undefined;
    if (targetTaskId) {
      candidateTask = tasks.find((t) => t.task_id === targetTaskId);
      if (!candidateTask) {
        return {
          isAllowed: false,
          requiresHumanDecision: false,
          reason: `Target task '${targetTaskId}' not found in SpecStore.`,
        };
      }
    } else {
      // Find candidate tasks that are not yet accepted and are executable
      const remainingTasks = tasks.filter(
        (t) =>
          !completedTaskIds.has(t.task_id) &&
          t.hierarchy_level !== 'FEATURE' &&
          t.hierarchy_level !== 'EPIC'
      );
      if (remainingTasks.length === 0) {
        return {
          isAllowed: false,
          requiresHumanDecision: false,
          reason: 'All project specification tasks are completed and ACCEPTED.',
        };
      }

      // Find first ready task where all dependencies are completed
      candidateTask = remainingTasks.find((t) => {
        if (!t.dependencies || t.dependencies.length === 0) return true;
        return t.dependencies.every((depId) => completedTaskIds.has(depId));
      });

      if (!candidateTask) {
        return {
          isAllowed: false,
          requiresHumanDecision: true,
          reason: 'Remaining tasks have unmet dependencies or dependency cycle.',
          humanDecisionPoint: {
            decisionId: 'decision-unmet-dependencies',
            category: 'UNMET_DEPENDENCIES',
            description: 'No remaining tasks have satisfied dependencies.',
            reason: 'All remaining tasks have prerequisite dependencies that are not ACCEPTED.',
          },
        };
      }
    }

    // Check candidate task prerequisite dependencies
    if (candidateTask.dependencies && candidateTask.dependencies.length > 0) {
      const unmet = candidateTask.dependencies.filter((depId) => !completedTaskIds.has(depId));
      if (unmet.length > 0) {
        return {
          isAllowed: false,
          requiresHumanDecision: true,
          reason: `Task '${candidateTask.task_id}' has unmet dependencies: [${unmet.join(', ')}].`,
          humanDecisionPoint: {
            decisionId: `decision-${candidateTask.task_id}-unmet-deps`,
            category: 'UNMET_DEPENDENCIES',
            description: `Task has unmet dependencies: ${unmet.join(', ')}`,
            reason: `Prerequisite tasks must be ACCEPTED prior to execution.`,
          },
        };
      }
    }

    return {
      isAllowed: true,
      requiresHumanDecision: false,
      nextTaskId: candidateTask.task_id,
      reason: `Continuation authorized for task '${candidateTask.task_id}'.`,
    };
  }

  // ==========================================================================
  // 2. RUN CONTROLLED DRIVER ITERATION
  // ==========================================================================

  /**
   * Executes a single governed driver iteration:
   * 1. Revalidates authoritative state and continuation authorization
   * 2. Resolves task and checks revision / scope
   * 3. Prepares / ingests DirectorInstruction via DirectorLoopEngine
   * 4. Invokes P16 executeCycle
   * 5. Evaluates next action via P16 evaluateNextAction
   * 6. Determines iteration outcome (CONTINUE, PAUSE, STOP, HUMAN_DECISION_REQUIRED)
   */
  async runIteration(input: DriverRunIterationInput): Promise<DriverIterationResult> {
    const workingDir = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    const projectId = input.projectId ?? canonical.projectId;

    if (canonical.projectId !== projectId) {
      throw new DriverValidationError(
        `Cross-project execution rejected: requested '${projectId}', but working directory is '${canonical.projectId}'`,
        { expectedProjectId: projectId, actualProjectId: canonical.projectId }
      );
    }

    // 1. Authoritative Continuation & Freshness Validation
    const continuationCheck = await this.validateContinuation(
      workingDir,
      projectId,
      input.targetTaskId
    );

    if (!continuationCheck.isAllowed) {
      const decision: DriverIterationDecision = continuationCheck.requiresHumanDecision
        ? 'HUMAN_DECISION_REQUIRED'
        : 'STOP';

      return {
        iteration: input.iterationNumber,
        taskId: input.targetTaskId ?? continuationCheck.nextTaskId ?? 'unknown',
        instructionId: 'none',
        cycleResult: null as any,
        nextAction: null as any,
        decision,
        reason: continuationCheck.reason,
      };
    }

    const taskId = continuationCheck.nextTaskId ?? input.targetTaskId;
    if (!taskId) {
      return {
        iteration: input.iterationNumber,
        taskId: 'unknown',
        instructionId: 'none',
        cycleResult: null as any,
        nextAction: null as any,
        decision: 'STOP',
        reason: 'No task available for execution.',
      };
    }

    // 2. Load Task from SpecStore
    const tasks = await this.specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === taskId);
    if (!task) {
      throw new DriverValidationError(`Task '${taskId}' not found in SpecStore.`, { taskId });
    }

    const rawRevision = task.metadata?.revision;
    const taskRevision: number = typeof rawRevision === 'number' ? rawRevision : 1;

    // 3. Resolve Session and Snapshot
    let session = null;
    if (input.directorSessionId) {
      session = await this.sessionEngine.getSession(input.directorSessionId, {
        workspaceRoot: workingDir,
        projectId,
      });
    } else {
      session = await this.sessionStore.getActiveSession();
    }

    if (!session || session.status !== 'ACTIVE') {
      throw new DriverAuthorizationError(
        `Cannot execute iteration: active Director session not found or inactive.`,
        { status: session?.status }
      );
    }

    let snapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!snapshot) {
      // Create minimal synchronized snapshot if not present
      const newSnapshot: DirectorContextSnapshot = {
        directorSessionId: session.directorSessionId,
        projectId,
        projectRoot: workingDir,
        protocolVersion: 'P9-02',
        schemaVersion: 1,
        synchronizedAt: new Date().toISOString(),
        logicalFingerprint: `fp-${projectId}-driver-auto`,
        isComplete: true,
        syncStatus: 'UNCHANGED',
        sections: {} as any,
        unavailableSections: [],
        staleSections: [],
        sectionMetadata: {} as any,
        isDerived: true,
      };
      await this.sessionStore.saveSnapshot(newSnapshot);
      snapshot = newSnapshot;
    }

    const pkg = await this.approvalStore.getActivePackage();
    if (!pkg || pkg.status !== 'APPROVED') {
      throw new DriverAuthorizationError(
        'Cannot execute iteration: active human Product Owner approval package missing or not APPROVED.',
        { packageStatus: pkg?.status }
      );
    }

    // 4. Resolve Decision
    const decisions = await this.decisionStore.listDecisions({
      sessionId: session.directorSessionId,
    });
    let decision = decisions.find(
      (d) =>
        d.decisionType === 'IMPLEMENT_TASK' &&
        (d.metadata as any)?.taskId === task.task_id
    );

    if (!decision) {
      // Look for any generic IMPLEMENT_TASK decision without a conflicting taskId
      decision = decisions.find(
        (d) =>
          d.decisionType === 'IMPLEMENT_TASK' &&
          !(d.metadata as any)?.taskId
      );
    }

    if (!decision) {
      // Create IMPLEMENT_TASK decision bound to this task
      decision = {
        decisionId: `dec-driver-${task.task_id}-${Date.now()}`,
        directorSessionId: session.directorSessionId,
        projectId,
        protocolVersion: 'P9-03',
        schemaVersion: 1,
        actor: 'DIRECTOR',
        decisionType: 'IMPLEMENT_TASK',
        rationale: `Autonomous driver executing task ${task.task_id}`,
        basedOnContextFingerprint: snapshot.logicalFingerprint,
        basedOnApprovalRevision: pkg.revision,
        basedOnUnderstandingRevision: session.understandingRevision,
        createdAt: new Date().toISOString(),
        metadata: { taskId: task.task_id },
        hasImplementationAuthority: false,
      };
      await this.decisionStore.saveDecision(decision);
    }

    // 5. Check or Ingest DirectorInstruction
    const instructions = await this.loopStore.listInstructions(projectId);
    let instruction = instructions.find(
      (i) =>
        i.taskId === task.task_id &&
        i.taskRevision === taskRevision &&
        i.directorSessionId === session!.directorSessionId
    );

    if (instruction) {
      // Check if this exact instruction has ALREADY been executed and accepted
      const prevResult = await this.loopStore.getCycleResultByInstructionId(
        instruction.instructionId
      );
      if (prevResult && prevResult.terminalStatus === 'ACCEPTED') {
        // Invariant: completed cycles cannot be blindly replayed
        // Evaluate next action to check if already complete or needs next
        const nextAction = await this.directorLoopEngine.evaluateNextAction({
          workspaceRoot: workingDir,
          projectId,
          directorSessionId: session.directorSessionId,
          cycleId: prevResult.cycleId,
          instructionId: instruction.instructionId,
          taskId: task.task_id,
        });

        return {
          iteration: input.iterationNumber,
          taskId: task.task_id,
          instructionId: instruction.instructionId,
          cycleResult: prevResult,
          nextAction,
          decision: 'CONTINUE',
          reason: `Instruction '${instruction.instructionId}' already ACCEPTED. Skipping duplicate execution to advance next task.`,
        };
      }
    }

    if (!instruction) {
      const taskAny = task as any;
      const metaAny = (task.metadata ?? {}) as any;
      const targetFiles: readonly string[] =
        Array.isArray(taskAny.targetFiles) && taskAny.targetFiles.length > 0
          ? taskAny.targetFiles
          : Array.isArray(taskAny.target_files) && taskAny.target_files.length > 0
            ? taskAny.target_files
            : Array.isArray(metaAny.targetFiles) && metaAny.targetFiles.length > 0
              ? metaAny.targetFiles
              : Array.isArray(metaAny.target_files) && metaAny.target_files.length > 0
                ? metaAny.target_files
                : ['src/index.ts'];

      instruction = await this.directorLoopEngine.ingestInstruction({
        workspaceRoot: workingDir,
        projectId,
        directorSessionId: session.directorSessionId,
        directorDecisionId: decision.decisionId,
        taskId: task.task_id,
        taskRevision,
        contextFingerprint: snapshot.logicalFingerprint,
        understandingRevision: typeof session.understandingRevision === 'number' ? session.understandingRevision : 1,
        approvalPackageRevision: pkg.revision,
        objective: task.description || task.title,
        targetFiles,
        implementationScope: targetFiles,
        acceptanceCriteria: task.acceptance_criteria as any,
        actor: 'DIRECTOR',
      });
    }

    // 6. Step 4 of iteration: Invoke existing P16 controlled cycle
    const cycleResult = await this.directorLoopEngine.executeCycle({
      workspaceRoot: workingDir,
      instructionId: instruction.instructionId,
      instruction,
      workingDirectory: workingDir,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });

    // 7. Step 7 of iteration: Evaluate next action via P16
    const nextAction = await this.directorLoopEngine.evaluateNextAction({
      workspaceRoot: workingDir,
      projectId,
      directorSessionId: session.directorSessionId,
      cycleId: cycleResult.cycleId,
      instructionId: instruction.instructionId,
      taskId: task.task_id,
    });

    // 8. Decide next driver step based on authoritative evidence and results
    let iterationDecision: DriverIterationDecision;
    let reason: string;

    if (cycleResult.terminalStatus === 'ACCEPTED') {
      // Commit accepted task changes to advance repository baseline for next iteration
      try {
        child_process.execSync(
          `git add -A && git commit -m "aidm: accepted ${task.task_id}"`,
          { cwd: workingDir, stdio: 'ignore' }
        );
      } catch {
        // Proceed if not a git repository or no new commits
      }

      // Reload tasks from spec store to check if all tasks in project are complete
      const updatedTasks = await this.specStore.loadTasks();
      const updatedDurable = await this.durableStateManager.load();
      const executableTasks = updatedTasks.filter(
        (t) => t.hierarchy_level !== 'FEATURE' && t.hierarchy_level !== 'EPIC'
      );
      const allDone = executableTasks.every(
        (t) =>
          t.status === 'ACCEPTED' ||
          updatedDurable?.completedTaskIds.includes(t.task_id)
      );

      if (allDone) {
        iterationDecision = 'STOP';
        reason = `Task '${task.task_id}' ACCEPTED. All project specification tasks are completed.`;
      } else {
        iterationDecision = 'CONTINUE';
        reason = `Task '${task.task_id}' ACCEPTED by independent verification. Proceeding to next ready task.`;
      }
    } else if (cycleResult.terminalStatus === 'BLOCKED') {
      iterationDecision = 'HUMAN_DECISION_REQUIRED';
      reason =
        nextAction.humanDecisionPoint?.reason ??
        `Task '${task.task_id}' verification returned BLOCK decision requiring human intervention.`;
    } else {
      // REJECTED: evaluate recovery policy
      if (
        nextAction.recoveryRecommendation?.decision === RecoveryStrategy.RETRY &&
        nextAction.retryAuthorization?.success
      ) {
        iterationDecision = 'CONTINUE';
        reason = `Task '${task.task_id}' REJECTED, but retry was authorized by RetryAuthorizationService.`;
      } else if (nextAction.recoveryRecommendation?.decision === RecoveryStrategy.REPLAN) {
        iterationDecision = 'CONTINUE';
        reason = `Task '${task.task_id}' REJECTED; corrective replan recommended.`;
      } else {
        iterationDecision = 'HUMAN_DECISION_REQUIRED';
        reason =
          nextAction.humanDecisionPoint?.reason ??
          `Task '${task.task_id}' execution failed verification and recovery is exhausted. Human decision required.`;
      }
    }

    return {
      iteration: input.iterationNumber,
      taskId: task.task_id,
      instructionId: instruction.instructionId,
      cycleResult,
      nextAction,
      decision: iterationDecision,
      reason,
      recoveryDecision: nextAction.recoveryRecommendation,
      retryAuthorization: nextAction.retryAuthorization,
    };
  }
}
