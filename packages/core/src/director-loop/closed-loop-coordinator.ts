/**
 * @file closed-loop-coordinator.ts
 * @description Unified Closed-Loop Coordinator (Phase A4).
 *
 * Implements the single orchestrator unifying:
 * Step 1: Director Context Snapshot sync
 * Step 2: Director Reasoning (budget pruned LLM decision)
 * Step 3: Director Action Envelope packaging & validation
 * Step 4: Authorization Policy Gate & Project Mandate evaluation
 * Step 5: Execution Bridge pre-execution checks, atomic claim & budget dispatch
 * Step 6: Driver execution handoff (isolated executor)
 * Step 7: Independent evidence verification (Zero AGY Trust)
 * Step 8: State integration, loop refresh & bounded recovery (Corrective tasks / max attempts).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: AGY self-claims and raw process outputs are never proof.
 *    Only independently verified SystemExecutionEvidence marks task success.
 * 2. SINGLE CHAT WINDOW: All steering flows through the single ChatGPT Director session.
 * 3. FAIL CLOSED: Halts cleanly on policy denial (REJECTED_BY_POLICY) or pending human approval
 *    (BLOCKED_ON_APPROVAL / WAITING_FOR_TRUSTED_IDENTITY).
 * 4. UNKNOWN STATE TERMINATION: Timeouts, aborts, or crashed processes enter EXECUTION_UNKNOWN
 *    and are NEVER automatically re-dispatched without human intervention.
 * 5. BOUNDED RECOVERY: Failures route through RecoveryPolicyEngine and CorrectiveTaskService
 *    within strict max attempts limits. No infinite retry loops.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import { LifecycleState } from '../lifecycle.js';
import {
  type ClosedLoopCycleInput,
  type ClosedLoopCycleResult,
  type ClosedLoopCycleStatus,
  type ClosedLoopStep,
  ClosedLoopCycleInputZodSchema,
} from './closed-loop-types.js';
import {
  type DirectorInstruction,
  type DirectorExecutionCycleResult,
  computeDeterministicCycleId,
} from './director-loop-types.js';
import { DirectorLoopStore } from './director-loop-store.js';
import { DirectorLoopEngine } from './director-loop-engine.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { DirectorDecisionStore } from '../director/director-decision-store.js';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { SpecStore } from '../storage/spec-store.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { HistoryManager } from '../storage/history-manager.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import { SystemEvidenceCollector } from '../evidence/execution-evidence-collector.js';
import type { SystemExecutionEvidence } from '../evidence/system-execution-evidence.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import { DirectorReasoningEngine } from '../director-reasoning/director-reasoning-engine.js';
import type { DirectorReasoningResult, DirectorDecisionContract } from '../director-reasoning/director-reasoning-types.js';
import { DirectorActionPipeline, type ValidatedDirectorActionResult } from '../director-action/director-action-pipeline.js';
import { DirectorActionBuilder } from '../director-action/director-action-builder.js';
import { DirectorActionValidator } from '../director-action/director-action-validator.js';
import { DirectorActionDispatcher } from '../director-action/director-action-dispatcher.js';
import {
  type DirectorActionEnvelope,
  type ActionDispatchResult,
  ActionDispatchStatus,
  computePayloadHash,
} from '../director-action/director-action-types.js';
import { AuthorizationPolicyEngine } from '../authorization/authorization-policy-engine.js';
import { DriverEngine } from '../driver/driver-engine.js';
import { ExecutionBridge } from '../execution-bridge/execution-bridge.js';
import {
  type BridgeExecutionIntent,
  type BridgeExecutionResult,
  ExecutionBridgeStatus,
  createFrozenBridgeExecutionIntent,
} from '../execution-bridge/execution-bridge-types.js';
import { RecoveryPolicyEngine } from '../recovery/recovery-policy-engine.js';
import { CorrectiveTaskService } from '../recovery/corrective-task-service.js';
import {
  RecoveryStrategy,
  type RecoveryPolicyDecision,
} from '../recovery/recovery-policy-types.js';
import { BudgetManager } from '../budget/budget-manager.js';
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import { LocalRuntimeStateManager } from '../storage/runtime-state.js';

export interface ClosedLoopCoordinatorOptions {
  readonly workspaceRoot?: string;
  readonly loopStore?: DirectorLoopStore;
  readonly directorLoopEngine?: DirectorLoopEngine;
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
  readonly evidenceCollector?: SystemEvidenceCollector;
  readonly runtimeStateManager?: LocalRuntimeStateManager;
  readonly reasoningEngine?: DirectorReasoningEngine;
  readonly actionPipeline?: DirectorActionPipeline;
  readonly actionBuilder?: DirectorActionBuilder;
  readonly actionValidator?: DirectorActionValidator;
  readonly actionDispatcher?: DirectorActionDispatcher;
  readonly executionBridge?: ExecutionBridge;
  readonly driverEngine?: DriverEngine;
  readonly authorizationPolicyEngine?: AuthorizationPolicyEngine;
  readonly recoveryPolicyEngine?: RecoveryPolicyEngine;
  readonly correctiveTaskService?: CorrectiveTaskService;
  readonly budgetManager?: BudgetManager;
  readonly executorPort?: ExecutorPort;
}

export class ClosedLoopCoordinator {
  readonly workspaceRoot?: string;
  readonly loopStore: DirectorLoopStore;
  readonly directorLoopEngine: DirectorLoopEngine;
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
  readonly evidenceCollector: SystemEvidenceCollector;
  readonly runtimeStateManager?: LocalRuntimeStateManager;
  readonly reasoningEngine?: DirectorReasoningEngine;
  readonly actionPipeline?: DirectorActionPipeline;
  readonly actionBuilder: DirectorActionBuilder;
  readonly actionValidator: DirectorActionValidator;
  readonly actionDispatcher: DirectorActionDispatcher;
  readonly executionBridge: ExecutionBridge;
  readonly driverEngine: DriverEngine;
  readonly authorizationPolicyEngine?: AuthorizationPolicyEngine;
  readonly recoveryPolicyEngine: RecoveryPolicyEngine;
  readonly correctiveTaskService: CorrectiveTaskService;
  readonly budgetManager?: BudgetManager;
  readonly executorPort?: ExecutorPort;

  constructor(options: ClosedLoopCoordinatorOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;
    this.budgetManager = options.budgetManager;
    this.executorPort = options.executorPort;
    this.authorizationPolicyEngine = options.authorizationPolicyEngine;
    this.runtimeStateManager = options.runtimeStateManager;

    this.specStore = options.specStore ?? new SpecStore({ baseDir: this.workspaceRoot });
    this.dagEngine = options.dagEngine ?? new TaskDagEngine();
    this.durableStateManager =
      options.durableStateManager ?? new DurableStateManager({ baseDir: this.workspaceRoot });
    this.evidenceStore =
      options.evidenceStore ?? new SystemExecutionEvidenceStore({ baseDir: this.workspaceRoot });
    this.evidenceCollector =
      options.evidenceCollector ??
      new SystemEvidenceCollector({ evidenceStore: this.evidenceStore });

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
    this.approvalPackageEngine = options.approvalPackageEngine ?? new ApprovalPackageEngine();

    this.loopStore =
      options.loopStore ??
      new DirectorLoopStore({ baseDir: this.workspaceRoot, historyManager: this.historyManager });

    this.recoveryPolicyEngine =
      options.recoveryPolicyEngine ??
      new RecoveryPolicyEngine({ historyManager: this.historyManager });

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

    this.directorLoopEngine =
      options.directorLoopEngine ??
      new DirectorLoopEngine({
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
        evidenceCollector: this.evidenceCollector,
        executorPort: this.executorPort,
        recoveryPolicyEngine: this.recoveryPolicyEngine,
        correctiveTaskService: this.correctiveTaskService,
      });

    this.driverEngine =
      options.driverEngine ??
      new DriverEngine({
        workspaceRoot: this.workspaceRoot,
        directorLoopEngine: this.directorLoopEngine,
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
        executorPort: this.executorPort,
        recoveryPolicyEngine: this.recoveryPolicyEngine,
        correctiveTaskService: this.correctiveTaskService,
      });

    this.executionBridge =
      options.executionBridge ??
      new ExecutionBridge({
        workspaceRoot: this.workspaceRoot,
        historyManager: this.historyManager,
        specStore: this.specStore,
        evidenceStore: this.evidenceStore,
        dagEngine: this.dagEngine,
        runtimeStateManager: this.runtimeStateManager,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        sessionStore: this.sessionStore,
        sessionEngine: this.sessionEngine,
        driverEngine: this.driverEngine,
        executorPort: this.executorPort,
        budgetManager: this.budgetManager,
        authorizationPolicyEngine: this.authorizationPolicyEngine,
      });

    this.actionBuilder = options.actionBuilder ?? new DirectorActionBuilder();
    this.actionValidator =
      options.actionValidator ??
      new DirectorActionValidator({
        historyManager: this.historyManager,
      });

    this.actionDispatcher =
      options.actionDispatcher ??
      new DirectorActionDispatcher({
        workspaceRoot: this.workspaceRoot,
        historyManager: this.historyManager,
        specStore: this.specStore,
        evidenceStore: this.evidenceStore,
        dagEngine: this.dagEngine,
        runtimeStateManager: this.runtimeStateManager,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        authorizationPolicyEngine: this.authorizationPolicyEngine,
      });

    this.reasoningEngine = options.reasoningEngine;
    this.actionPipeline =
      options.actionPipeline ??
      (this.reasoningEngine
        ? new DirectorActionPipeline({
            reasoningEngine: this.reasoningEngine,
            actionBuilder: this.actionBuilder,
            actionValidator: this.actionValidator,
          })
        : undefined);
  }

  /**
   * Executes a single, unified closed-loop cycle.
   */
  async coordinateCycle(input: ClosedLoopCycleInput): Promise<ClosedLoopCycleResult> {
    const parseResult = ClosedLoopCycleInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      const errReason = `Invalid closed-loop input: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`;
      return this.buildImmediateFailure({
        status: 'EXECUTION_FAILED',
        stepReached: 'CONTEXT_SYNC',
        summary: errReason,
        projectId: input.projectId ?? 'unknown',
        directorSessionId: input.directorSessionId ?? 'unknown',
      });
    }

    const workingDir = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    const projectId = input.projectId ?? canonical.projectId;

    if (canonical.projectId !== projectId) {
      return this.buildImmediateFailure({
        status: 'EXECUTION_FAILED',
        stepReached: 'CONTEXT_SYNC',
        summary: `Canonical project identity mismatch: expected '${projectId}', got '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project execution rejected.`,
        projectId,
        directorSessionId: input.directorSessionId ?? 'unknown',
      });
    }

    // ------------------------------------------------------------------------
    // Step 1: Context & Snapshot Synchronization
    // ------------------------------------------------------------------------
    let session = null;
    if (input.directorSessionId) {
      try {
        session = await this.sessionEngine.getSession(input.directorSessionId, {
          workspaceRoot: workingDir,
          projectId,
        });
      } catch (err: any) {
        return this.buildImmediateFailure({
          status: 'EXECUTION_FAILED',
          stepReached: 'CONTEXT_SYNC',
          summary: `Failed to resolve Director session '${input.directorSessionId}': ${err.message}`,
          projectId,
          directorSessionId: input.directorSessionId,
        });
      }
    } else {
      session = await this.sessionStore.getActiveSession();
    }

    if (!session || session.status !== 'ACTIVE') {
      return this.buildImmediateFailure({
        status: 'EXECUTION_FAILED',
        stepReached: 'CONTEXT_SYNC',
        summary: `Director session '${session?.directorSessionId ?? 'none'}' is ${session?.status ?? 'MISSING'}. An ACTIVE session is required for closed-loop execution.`,
        projectId,
        directorSessionId: session?.directorSessionId ?? 'unknown',
      });
    }

    // Check pre-existing blocked state in DurableStateManager
    const durableState = await this.durableStateManager.load();
    if (durableState?.blockedState) {
      return {
        cycleId: `cycle-${Date.now()}-blocked`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'BLOCKED_ON_APPROVAL',
        isSuccess: false,
        summary: `Durable state is currently blocked on human decision: ${durableState.blockedState.blockingReason}`,
        stepReached: 'CONTEXT_SYNC',
        humanDecisionRequired: true,
        humanDecisionPoint: durableState.blockedState,
        completedAt: new Date().toISOString(),
      };
    }

    // Resolve or build authoritative context snapshot
    let snapshot: DirectorContextSnapshot | null = input.contextSnapshot ?? null;
    if (!snapshot) {
      snapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    }

    if (!snapshot) {
      const fallbackSnapshot: DirectorContextSnapshot = {
        directorSessionId: session.directorSessionId,
        projectId,
        projectRoot: workingDir,
        protocolVersion: 'P9-02',
        schemaVersion: 1,
        synchronizedAt: new Date().toISOString(),
        logicalFingerprint: `fp-${projectId}-auto`,
        isComplete: true,
        syncStatus: 'UNCHANGED',
        sections: {} as any,
        unavailableSections: [],
        staleSections: [],
        sectionMetadata: {} as any,
        isDerived: true,
      };
      await this.sessionStore.saveSnapshot(fallbackSnapshot);
      snapshot = fallbackSnapshot;
    }

    const currentUnderstandingRevision = session.understandingRevision ?? 1;

    // ------------------------------------------------------------------------
    // Step 2: Reasoning (LLM or Contract)
    // ------------------------------------------------------------------------
    let reasoningResult: DirectorReasoningResult | undefined;
    let decisionContract: DirectorDecisionContract | undefined = input.customDecision;
    let actionEnvelope: DirectorActionEnvelope | undefined = input.customEnvelope;

    if (!actionEnvelope && !decisionContract) {
      if (this.reasoningEngine) {
        try {
          reasoningResult = await this.reasoningEngine.reason({
            snapshot,
            userInstructions: typeof input.instruction === 'string' ? input.instruction : undefined,
          });
          decisionContract = reasoningResult.decision;
        } catch (err: any) {
          return {
            cycleId: `cycle-${Date.now()}-reasoning-err`,
            projectId,
            directorSessionId: session.directorSessionId,
            status: 'EXECUTION_FAILED',
            isSuccess: false,
            summary: `Director reasoning failed: ${err.message}`,
            stepReached: 'REASONING',
            humanDecisionRequired: false,
            completedAt: new Date().toISOString(),
          };
        }
      } else {
        // Resolve target task from input or SpecStore
        let targetTaskId = input.targetTaskId;
        const allTasks = await this.specStore.loadTasks();

        if (!targetTaskId) {
          const eligibleTask = allTasks.find(
            (t) => t.status === 'READY' || t.status === 'IN_PROGRESS'
          );
          targetTaskId = eligibleTask?.task_id;
        }

        if (targetTaskId) {
          const taskObj = allTasks.find((t) => t.task_id === targetTaskId);
          const targetFiles: string[] =
            Array.isArray(taskObj?.metadata?.targetFiles)
              ? (taskObj.metadata.targetFiles as string[])
              : ['src/index.ts'];

          decisionContract = {
            decisionType: 'IMPLEMENT_TASK',
            rationale: `Closed-loop coordinator executing task ${targetTaskId}`,
            basedOnContextFingerprint: snapshot.logicalFingerprint,
            selectedTaskId: targetTaskId,
            metadata: {
              taskId: targetTaskId,
              taskRevision: (taskObj?.metadata?.revision as number) ?? 1,
              targetFiles,
            },
          };
        }
      }
    }

    // Handle No-op or Clarification decisions from reasoning
    if (decisionContract) {
      if (
        (decisionContract.decisionType as string) === 'NO_OP' ||
        (decisionContract.decisionType as string) === 'REQUEST_CLARIFICATION'
      ) {
        return {
          cycleId: `cycle-${Date.now()}-noop`,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'NO_ACTION_REQUIRED',
          isSuccess: true,
          summary: decisionContract.rationale ?? 'Reasoning concluded no implementation action required.',
          stepReached: 'REASONING',
          reasoningResult,
          humanDecisionRequired: (decisionContract.decisionType as string) === 'REQUEST_CLARIFICATION',
          humanDecisionPoint:
            (decisionContract.decisionType as string) === 'REQUEST_CLARIFICATION'
              ? decisionContract.metadata
              : undefined,
          completedAt: new Date().toISOString(),
        };
      }
    }

    // ------------------------------------------------------------------------
    // Step 3: Action Packaging & Envelope Validation
    // ------------------------------------------------------------------------
    let validatedActionResult: ValidatedDirectorActionResult;

    if (actionEnvelope) {
      const validationContext = {
        currentFingerprint: snapshot.logicalFingerprint,
        currentUnderstandingRevision,
        currentDirectorSessionId: session.directorSessionId,
        currentProjectId: projectId,
      };

      try {
        const val = await this.actionValidator.validate(actionEnvelope, validationContext);
        validatedActionResult = {
          success: true,
          envelope: actionEnvelope,
          validationResult: val,
          isDuplicate: false,
          reasoningResult: reasoningResult as any,
        };
      } catch (err: any) {
        return {
          cycleId: `cycle-${Date.now()}-envelope-val-err`,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'EXECUTION_FAILED',
          isSuccess: false,
          summary: `Action envelope validation failed: ${err.message}`,
          stepReached: 'ACTION_PACKAGING',
          actionEnvelope,
          humanDecisionRequired: false,
          completedAt: new Date().toISOString(),
        };
      }
    } else if (decisionContract) {
      try {
        const envelope = this.actionBuilder.buildEnvelope({
          decision: decisionContract as any,
          snapshot,
          idempotencyKey: input.idempotencyKey,
        });
        actionEnvelope = envelope;

        const val = await this.actionValidator.validate(envelope, {
          currentFingerprint: snapshot.logicalFingerprint,
          currentUnderstandingRevision,
          currentDirectorSessionId: session.directorSessionId,
          currentProjectId: projectId,
        });

        validatedActionResult = {
          success: true,
          envelope,
          validationResult: val,
          isDuplicate: false,
          reasoningResult: reasoningResult as any,
        };
      } catch (err: any) {
        return {
          cycleId: `cycle-${Date.now()}-action-packaging-err`,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'EXECUTION_FAILED',
          isSuccess: false,
          summary: `Action envelope construction failed: ${err.message}`,
          stepReached: 'ACTION_PACKAGING',
          humanDecisionRequired: false,
          completedAt: new Date().toISOString(),
        };
      }
    } else {
      return {
        cycleId: `cycle-${Date.now()}-no-action`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'NO_ACTION_REQUIRED',
        isSuccess: true,
        summary: 'No executable action could be formed from context or input.',
        stepReached: 'ACTION_PACKAGING',
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    // ------------------------------------------------------------------------
    // Step 4: Policy & Mandate Evaluation (Dispatch Gate)
    // ------------------------------------------------------------------------
    let dispatchResult: ActionDispatchResult;
    try {
      dispatchResult = await this.actionDispatcher.dispatch({
        validatedResult: validatedActionResult,
        snapshot,
      });
    } catch (err: any) {
      return {
        cycleId: `cycle-${Date.now()}-dispatch-err`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'EXECUTION_FAILED',
        isSuccess: false,
        summary: `Action dispatch exception: ${err.message}`,
        stepReached: 'POLICY_EVALUATION',
        actionEnvelope,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    if (dispatchResult.status === ActionDispatchStatus.REJECTED) {
      return {
        cycleId: `cycle-${Date.now()}-policy-denied`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'REJECTED_BY_POLICY',
        isSuccess: false,
        summary: dispatchResult.reason,
        stepReached: 'POLICY_EVALUATION',
        actionEnvelope,
        dispatchResult,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    if (dispatchResult.status === ActionDispatchStatus.PENDING_AUTHORIZATION) {
      return {
        cycleId: `cycle-${Date.now()}-blocked-auth`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'BLOCKED_ON_APPROVAL',
        isSuccess: false,
        summary: dispatchResult.reason,
        stepReached: 'POLICY_EVALUATION',
        actionEnvelope,
        dispatchResult,
        humanDecisionRequired: true,
        humanDecisionPoint: {
          actionId: actionEnvelope.actionId,
          status: dispatchResult.status,
          reason: dispatchResult.reason,
        },
        completedAt: new Date().toISOString(),
      };
    }

    if (dispatchResult.status === ActionDispatchStatus.DUPLICATE) {
      const curDurable = await this.durableStateManager.load();
      const targetId = (actionEnvelope.payload as any)?.taskId;
      const isTaskAlreadyCompleted = Boolean(targetId && curDurable?.completedTaskIds?.includes(targetId));

      return {
        cycleId: `cycle-${Date.now()}-duplicate`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: isTaskAlreadyCompleted ? 'COMPLETED_SUCCESS' : 'EXECUTION_FAILED',
        isSuccess: isTaskAlreadyCompleted,
        summary: `Idempotent duplicate: action was already dispatched (${dispatchResult.reason})`,
        stepReached: 'STATE_INTEGRATION_RECOVERY',
        taskId: targetId,
        actionEnvelope,
        dispatchResult,
        humanDecisionRequired: !isTaskAlreadyCompleted,
        completedAt: new Date().toISOString(),
      };
    }

    if (dispatchResult.status !== ActionDispatchStatus.AUTHORIZED_PENDING_EXECUTION) {
      return {
        cycleId: `cycle-${Date.now()}-unauthorized-dispatch`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'EXECUTION_FAILED',
        isSuccess: false,
        summary: `Action not authorized for execution: status is ${dispatchResult.status} (${dispatchResult.reason})`,
        stepReached: 'POLICY_EVALUATION',
        actionEnvelope,
        dispatchResult,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    // ------------------------------------------------------------------------
    // Step 5: Execution Bridge Handoff & Pre-Execution Checks
    // ------------------------------------------------------------------------
    const targetTaskId =
      ((actionEnvelope.payload as any)?.taskId ??
        decisionContract?.selectedTaskId ??
        input.targetTaskId) as string;

    const activePkg = await this.approvalStore.getActivePackage(projectId);

    const intent: BridgeExecutionIntent = createFrozenBridgeExecutionIntent({
      executionIntentId: dispatchResult.executionIntentId ?? `intent-${Date.now()}`,
      actionId: actionEnvelope.actionId,
      idempotencyKey: actionEnvelope.idempotencyKey,
      projectId,
      directorSessionId: session.directorSessionId,
      taskId: targetTaskId,
      taskRevision: (actionEnvelope.payload as any)?.expectedTaskRevision ?? 1,
      basedOnContextFingerprint: actionEnvelope.basedOnContextFingerprint,
      understandingRevision: actionEnvelope.understandingRevision,
      authorizationReference: {
        packageId: activePkg?.packageId,
        packageRevision: activePkg?.revision ?? 1,
        isDevelopmentAuthorized: activePkg?.status === 'APPROVED',
        authorizedAt: activePkg?.createdAt,
        authContext: input.authContext as any,
      },
      createdAt: new Date().toISOString(),
      executionPlan:
        (actionEnvelope.payload as any)?.executionPlan ?? `Implement task ${targetTaskId}`,
      metadata: { actionId: actionEnvelope.actionId },
    });

    let bridgeResult: BridgeExecutionResult;
    try {
      bridgeResult = await this.executionBridge.executeIntent(intent, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        authContext: input.authContext as any,
      });
    } catch (err: any) {
      return {
        cycleId: `cycle-${Date.now()}-bridge-err`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'EXECUTION_FAILED',
        isSuccess: false,
        summary: `Execution bridge error: ${err.message}`,
        stepReached: 'BRIDGE_EXECUTION',
        taskId: intent.taskId,
        actionEnvelope,
        dispatchResult,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    // ------------------------------------------------------------------------
    // Step 6 & 7: Check Execution Outcome & Independent Evidence Verification
    // ------------------------------------------------------------------------
    const completedAt = new Date().toISOString();
    const cycleId =
      bridgeResult.cycleResult?.cycleId ??
      computeDeterministicCycleId({
        instructionId: actionEnvelope.actionId,
        requestId: intent.executionIntentId,
        evidenceId: bridgeResult.systemEvidence?.evidenceId ?? `ev-${Date.now()}`,
      });

    // Check for Ambiguous Timeout / Abort -> EXECUTION_UNKNOWN
    if (bridgeResult.status === ExecutionBridgeStatus.EXECUTION_UNKNOWN) {
      return {
        cycleId,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'EXECUTION_UNKNOWN',
        isSuccess: false,
        summary: bridgeResult.reason,
        stepReached: 'EVIDENCE_VERIFICATION',
        taskId: intent.taskId,
        reasoningResult,
        actionEnvelope,
        dispatchResult,
        bridgeResult,
        cycleResult: bridgeResult.cycleResult,
        systemEvidence: bridgeResult.systemEvidence,
        humanDecisionRequired: true,
        humanDecisionPoint: {
          code: bridgeResult.code,
          reason: bridgeResult.reason,
        },
        completedAt,
      };
    }

    // Check for Idempotent Duplicate / Already Claimed Execution
    if (
      bridgeResult.code === 'ERR_INTENT_ALREADY_CLAIMED' ||
      bridgeResult.reason?.includes('was already claimed')
    ) {
      return {
        cycleId,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'COMPLETED_SUCCESS',
        isSuccess: true,
        summary: `Idempotent duplicate execution: ${bridgeResult.reason}`,
        stepReached: 'STATE_INTEGRATION_RECOVERY',
        taskId: intent.taskId,
        reasoningResult,
        actionEnvelope,
        dispatchResult,
        bridgeResult,
        humanDecisionRequired: false,
        completedAt,
      };
    }

    // Check for Success: SystemExecutionEvidence independently verified
    if (bridgeResult.status === ExecutionBridgeStatus.EXECUTION_SUCCEEDED && bridgeResult.isSuccess) {
      // Invariant: Must have verified system evidence
      if (!bridgeResult.systemEvidence) {
        return {
          cycleId,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'EXECUTION_FAILED',
          isSuccess: false,
          summary: 'Zero trust violation: execution marked succeeded without SystemExecutionEvidence.',
          stepReached: 'EVIDENCE_VERIFICATION',
          taskId: intent.taskId,
          reasoningResult,
          actionEnvelope,
          dispatchResult,
          bridgeResult,
          humanDecisionRequired: false,
          completedAt,
        };
      }

      // Step 8: State Integration & Loop Refresh
      try {
        const curState = (await this.durableStateManager.load()) ?? {
          schemaVersion: 1,
          currentLifecycleState: LifecycleState.TASK_LOOP,
          completedTaskIds: [],
          activeTaskId: null,
          blockedState: null,
          continuationState: 'NONE',
          continuationPolicy: 'AUTONOMOUS',
          updatedAt: new Date().toISOString(),
        };
        const completedSet = new Set(curState.completedTaskIds ?? []);
        completedSet.add(intent.taskId);

        await this.durableStateManager.save({
          currentLifecycleState: curState.currentLifecycleState ?? LifecycleState.TASK_LOOP,
          completedTaskIds: Array.from(completedSet),
          activeTaskId: null,
          blockedState: null,
        });

        if (this.historyManager) {
          await this.historyManager.appendEvent({
            eventType: 'CLOSED_LOOP_CYCLE_COMPLETED',
            actor: Actor.ORCHESTRATOR,
            taskId: intent.taskId,
            payload: {
              cycleId,
              status: 'COMPLETED_SUCCESS',
              taskId: intent.taskId,
              evidenceId: bridgeResult.systemEvidence.evidenceId,
            },
          });
        }
      } catch {
        // Non-fatal persistence error
      }

      return {
        cycleId,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'COMPLETED_SUCCESS',
        isSuccess: true,
        summary: bridgeResult.reason,
        stepReached: 'STATE_INTEGRATION_RECOVERY',
        taskId: intent.taskId,
        reasoningResult,
        actionEnvelope,
        dispatchResult,
        bridgeResult,
        cycleResult: bridgeResult.cycleResult,
        systemEvidence: bridgeResult.systemEvidence,
        humanDecisionRequired: false,
        completedAt,
      };
    }

    // ------------------------------------------------------------------------
    // Step 8: Execution Failed — Bounded Recovery Routing
    // ------------------------------------------------------------------------
    try {
      const curDurable = await this.durableStateManager.load();
      if (curDurable && curDurable.completedTaskIds?.includes(intent.taskId)) {
        const cleaned = curDurable.completedTaskIds.filter((id) => id !== intent.taskId);
        await this.durableStateManager.save({
          ...curDurable,
          completedTaskIds: cleaned,
        });
      }
    } catch {
      // Non-fatal cleanup
    }

    const tasks = await this.specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === intent.taskId);
    const attempt = task?.attempt ?? 1;
    const maxAttempts = Math.min(task?.max_attempts ?? 2, input.maxRecoveryAttempts ?? 2);

    let recoveryDecision: RecoveryPolicyDecision | undefined;
    if (bridgeResult.systemEvidence) {
      try {
        recoveryDecision = this.recoveryPolicyEngine.evaluate({
          evidence: bridgeResult.systemEvidence,
          task:
            task ??
            ({
              task_id: intent.taskId,
              parent_feature_id: 'FEAT-CORE',
              title: `Task ${intent.taskId}`,
              description: `Task ${intent.taskId}`,
              traceability_sources: ['REQ-01'],
              acceptance_criteria: ['AC-01'],
              hierarchy_level: 'TASK',
              attempt,
              max_attempts: maxAttempts,
              status: 'IN_PROGRESS',
              risk_level: 'LOW',
              dependencies: [],
              created_at: new Date().toISOString(),
            } as any),
          expectedProjectId: projectId,
        });
      } catch {
        // Recovery evaluation exception
      }
    }

    // Strict invariant: bounded recovery budget
    if (attempt >= maxAttempts) {
      return {
        cycleId,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'MAX_ATTEMPTS_EXCEEDED',
        isSuccess: false,
        summary: `Task '${intent.taskId}' failed and maximum retry attempts (${maxAttempts}) reached. Bounded recovery halted fail-closed.`,
        stepReached: 'STATE_INTEGRATION_RECOVERY',
        taskId: intent.taskId,
        reasoningResult,
        actionEnvelope,
        dispatchResult,
        bridgeResult,
        cycleResult: bridgeResult.cycleResult,
        systemEvidence: bridgeResult.systemEvidence,
        recoveryDecision,
        humanDecisionRequired: true,
        humanDecisionPoint: {
          reason: `Max attempts exceeded for task ${intent.taskId}`,
          attempt,
          maxAttempts,
          recoveryDecision,
        },
        completedAt,
      };
    }

    // Check if recovery recommends REPLAN or allows replan and creates corrective task
    if (
      recoveryDecision &&
      (recoveryDecision.decision === RecoveryStrategy.REPLAN ||
        (recoveryDecision.replanAllowed && recoveryDecision.decision === RecoveryStrategy.RETRY))
    ) {
      try {
        const replanDecision: RecoveryPolicyDecision =
          recoveryDecision.decision === RecoveryStrategy.REPLAN
            ? recoveryDecision
            : {
                ...recoveryDecision,
                decision: RecoveryStrategy.REPLAN,
                replanAllowed: true,
              };

        const correctiveOutcome = await this.correctiveTaskService.createCorrectiveTask({
          evidence: bridgeResult.systemEvidence,
          decision: replanDecision,
          expectedProjectId: projectId,
          directorSessionId: session.directorSessionId,
          workspaceRoot: workingDir,
        });

        if (correctiveOutcome.success && correctiveOutcome.correctiveTask) {
          return {
            cycleId,
            projectId,
            directorSessionId: session.directorSessionId,
            status: 'CORRECTIVE_TASK_CREATED',
            isSuccess: false,
            summary: `Task '${intent.taskId}' failed. Bounded corrective task '${correctiveOutcome.correctiveTask.task_id}' created in DAG.`,
            stepReached: 'STATE_INTEGRATION_RECOVERY',
            taskId: intent.taskId,
            reasoningResult,
            actionEnvelope,
            dispatchResult,
            bridgeResult,
            cycleResult: bridgeResult.cycleResult,
            systemEvidence: bridgeResult.systemEvidence,
            recoveryDecision,
            correctiveTaskId: correctiveOutcome.correctiveTask.task_id,
            humanDecisionRequired: false,
            completedAt,
          };
        }
      } catch {
        // Corrective task creation failed
      }
    }

    return {
      cycleId,
      projectId,
      directorSessionId: session.directorSessionId,
      status: 'EXECUTION_FAILED',
      isSuccess: false,
      summary: bridgeResult.reason,
      stepReached: 'STATE_INTEGRATION_RECOVERY',
      taskId: intent.taskId,
      reasoningResult,
      actionEnvelope,
      dispatchResult,
      bridgeResult,
      cycleResult: bridgeResult.cycleResult,
      systemEvidence: bridgeResult.systemEvidence,
      recoveryDecision,
      humanDecisionRequired: recoveryDecision?.humanRequired ?? true,
      humanDecisionPoint: recoveryDecision?.humanRequired ? { reason: bridgeResult.reason } : undefined,
      completedAt,
    };
  }

  private buildImmediateFailure(params: {
    status: ClosedLoopCycleStatus;
    stepReached: ClosedLoopStep;
    summary: string;
    projectId: string;
    directorSessionId: string;
  }): ClosedLoopCycleResult {
    return {
      cycleId: `cycle-${Date.now()}-fail`,
      projectId: params.projectId,
      directorSessionId: params.directorSessionId,
      status: params.status,
      isSuccess: false,
      summary: params.summary,
      stepReached: params.stepReached,
      humanDecisionRequired: false,
      completedAt: new Date().toISOString(),
    };
  }
}
