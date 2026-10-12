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

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as child_process from 'node:child_process';
import { Actor } from '../actors.js';
import { LifecycleState } from '../lifecycle.js';
import {
  type ClosedLoopCycleInput,
  type ClosedLoopCycleResult,
  type ClosedLoopCycleStatus,
  type ClosedLoopStep,
  ClosedLoopCycleInputZodSchema,
  type ClosedLoopAutoLoopInput,
  type ClosedLoopAutoLoopResult,
  type ClosedLoopAutoLoopTerminalStatus,
  ClosedLoopAutoLoopInputZodSchema,
  type ProcessIsolationBlockRecord,
  type UnblockProcessIsolationInput,
  type UnblockProcessIsolationResult,
  UnblockProcessIsolationInputZodSchema,
} from './closed-loop-types.js';
import {
  type DirectorInstruction,
  type DirectorExecutionCycleResult,
  computeDeterministicCycleId,
} from './director-loop-types.js';
import {
  createOpenAiDirectorRuntime,
  resolveOpenAiDirectorConfig,
} from '../director/openai-director-runtime.js';
import { DirectorLoopStore } from './director-loop-store.js';
import { DirectorLoopEngine } from './director-loop-engine.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { DirectorDecisionStore } from '../director/director-decision-store.js';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';
import { DirectorContextSynchronizer } from '../director/director-context-synchronizer.js';
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
import { DirectorRuntime, type DirectorReasoningResult as P27DirectorReasoningResult } from '../director/director-runtime.js';
import type { DirectorAction } from '../director/director-action-types.js';
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
import { RecoveryEngine, type RecoveryResult } from '../recovery/index.js';

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
  readonly directorRuntime?: DirectorRuntime;
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
  readonly recoveryEngine?: RecoveryEngine;
  /** Explicit test-only flag to allow legacy reasoning engine fallback */
  readonly allowLegacyReasoning?: boolean;
  /** Whether to automatically resolve and initialize OpenAI DirectorRuntime if credentials exist (default: true) */
  readonly autoResolveDirectorRuntime?: boolean;
  /** Independent OS process verifier for G-10 two-phase unblocking (default: queries tasklist / OS table) */
  readonly processVerifier?: (pids?: number[]) => Promise<{ verifiedDead: boolean; error?: string; output?: string }>;
}

async function defaultProcessVerifier(
  pids?: number[]
): Promise<{ verifiedDead: boolean; error?: string; output?: string }> {
  if (!pids || pids.length === 0) {
    return { verifiedDead: true, output: 'No specific PIDs supplied to check' };
  }

  if (process.platform === 'win32') {
    for (const pid of pids) {
      if (typeof pid !== 'number' || pid <= 0) continue;
      try {
        const out = child_process.execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
          windowsHide: true,
        });
        if (out.includes(`"${pid}"`)) {
          return { verifiedDead: false, output: `Process PID ${pid} is still active in Windows process table.` };
        }
      } catch (err: any) {
        return {
          verifiedDead: false,
          error: `Failed to query Windows process table for PID ${pid}: ${err.message}`,
        };
      }
    }
    return { verifiedDead: true, output: `All checked PIDs [${pids.join(', ')}] confirmed dead in Windows process table.` };
  } else {
    for (const pid of pids) {
      if (typeof pid !== 'number' || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        return { verifiedDead: false, output: `Process PID ${pid} is still alive.` };
      } catch (err: any) {
        if (err.code !== 'ESRCH') {
          return { verifiedDead: false, error: `Failed to query process status for PID ${pid}: ${err.message}` };
        }
      }
    }
    return { verifiedDead: true, output: `All checked PIDs [${pids.join(', ')}] confirmed dead.` };
  }
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
  readonly directorRuntime?: DirectorRuntime;
  readonly reasoningEngine?: DirectorReasoningEngine;
  readonly allowLegacyReasoning: boolean;
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
  readonly recoveryEngine: RecoveryEngine;
  readonly processVerifier: (pids?: number[]) => Promise<{ verifiedDead: boolean; error?: string; output?: string }>;
  private isUnblockingProcess = false;
  private static readonly activeUnblockWorkspaces = new Set<string>();

  constructor(options: ClosedLoopCoordinatorOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;
    this.budgetManager = options.budgetManager;
    this.executorPort = options.executorPort;
    this.authorizationPolicyEngine = options.authorizationPolicyEngine;
    this.runtimeStateManager = options.runtimeStateManager;
    this.allowLegacyReasoning = options.allowLegacyReasoning ?? false;
    this.processVerifier = options.processVerifier ?? defaultProcessVerifier;

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
        durableStateManager: this.durableStateManager,
      });

    this.recoveryEngine =
      options.recoveryEngine ??
      new RecoveryEngine({
        workspaceRoot: this.workspaceRoot ?? process.cwd(),
        durableStateManager: this.durableStateManager,
        localRuntimeStateManager: this.runtimeStateManager,
        historyManager: this.historyManager,
        evidenceStore: this.evidenceStore,
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

    const autoResolve = options.autoResolveDirectorRuntime ?? true;
    if (options.directorRuntime) {
      this.directorRuntime = options.directorRuntime;
    } else if (autoResolve && !this.allowLegacyReasoning && this.budgetManager) {
      // Auto-resolution only with an authoritative BudgetManager: a live LLM Director without
      // budget hold/settle would bypass budget governance (P18-03). Without it: no runtime (fail-closed).
      const openAiConfig = resolveOpenAiDirectorConfig();
      if (openAiConfig.hasValidApiKey) {
        this.directorRuntime = createOpenAiDirectorRuntime({
          workspaceRoot: this.workspaceRoot,
          sessionStore: this.sessionStore,
          sessionEngine: this.sessionEngine,
          historyManager: this.historyManager,
          budgetManager: this.budgetManager,
        });
      }
    }

    this.reasoningEngine = options.reasoningEngine;
    this.actionPipeline =
      options.actionPipeline ??
      (this.directorRuntime
        ? new DirectorActionPipeline({
            directorRuntime: this.directorRuntime,
            actionBuilder: this.actionBuilder,
            actionValidator: this.actionValidator,
            allowLegacyReasoningEngine: this.allowLegacyReasoning,
          })
        : this.reasoningEngine && this.allowLegacyReasoning
        ? new DirectorActionPipeline({
            reasoningEngine: this.reasoningEngine,
            actionBuilder: this.actionBuilder,
            actionValidator: this.actionValidator,
            allowLegacyReasoningEngine: true,
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

    // Pre-Execution Boundary: Check if system is permanently BLOCKED due to PROCESS_ISOLATION_UNCERTAINTY (G-8 / G-10)
    const existingDurable = await this.durableStateManager.load();
    if (existingDurable?.blockedState?.blockingReason === 'PROCESS_ISOLATION_UNCERTAINTY') {
      const blockMeta = (existingDurable.blockedState.metadata ?? {}) as Record<string, unknown>;
      return {
        cycleId: `cycle-${Date.now()}-dispatch-blocked`,
        projectId,
        directorSessionId: input.directorSessionId ?? 'unknown',
        status: 'BLOCKED',
        isSuccess: false,
        summary: `DISPATCH_BLOCKED: System is permanently BLOCKED due to PROCESS_ISOLATION_UNCERTAINTY. New dispatch is rejected until two-phase unblocking (PO approval + independent OS process verification) is completed.`,
        stepReached: 'CONTEXT_SYNC',
        humanDecisionRequired: true,
        humanDecisionPoint: {
          code: 'ERR_PROCESS_ISOLATION_UNCERTAINTY',
          blockingReason: 'PROCESS_ISOLATION_UNCERTAINTY',
          blockId: blockMeta.blockId,
          blockedState: existingDurable.blockedState,
        },
        completedAt: new Date().toISOString(),
      };
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
      try {
        const synchronizer = new DirectorContextSynchronizer({
          workspaceRoot: workingDir,
          sessionStore: this.sessionStore,
          sessionEngine: this.sessionEngine,
        });
        snapshot = await synchronizer.synchronize({
          directorSessionId: session.directorSessionId,
          projectId,
        });
      } catch {
        // failed to synchronize
      }
    }

    // Authoritative snapshot invariant enforcement (Section 4 & 5):
    // Must be non-null, complete, matching project & session, and non-synthetic
    const isSyntheticFingerprint =
      Boolean(snapshot?.logicalFingerprint?.endsWith('-auto')) ||
      Boolean(snapshot?.logicalFingerprint?.endsWith('-recovery'));

    if (
      !snapshot ||
      snapshot.isComplete !== true ||
      !snapshot.logicalFingerprint ||
      isSyntheticFingerprint ||
      snapshot.projectId !== projectId ||
      snapshot.directorSessionId !== session.directorSessionId
    ) {
      return {
        cycleId: `cycle-${Date.now()}-no-context`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'EXECUTION_FAILED',
        isSuccess: false,
        summary: `CONTEXT_UNAVAILABLE: Authoritative DirectorContextSnapshot is missing, incomplete, synthetic, or mismatched for session ${session.directorSessionId}.`,
        stepReached: 'CONTEXT_SYNC',
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    const currentUnderstandingRevision = session.understandingRevision ?? 1;

    // ------------------------------------------------------------------------
    // Step 2: Reasoning (P27 DirectorRuntime or Legacy Engine or Direct Action)
    // ------------------------------------------------------------------------
    let p27ReasoningResult: P27DirectorReasoningResult | undefined;
    let legacyReasoningResult: DirectorReasoningResult | undefined;
    let directorAction: DirectorAction | undefined = input.customAction;
    let decisionContract: DirectorDecisionContract | undefined = input.customDecision;
    let actionEnvelope: DirectorActionEnvelope | undefined = input.customEnvelope;

    if (!actionEnvelope && !directorAction && !decisionContract) {
      if (this.directorRuntime) {
        try {
          p27ReasoningResult = await this.directorRuntime.reason({
            projectId,
            directorSessionId: session.directorSessionId,
            snapshot,
            objective: typeof input.instruction === 'string' ? input.instruction : undefined,
            trigger: input.targetTaskId ? 'TASK_READY' : 'PERIODIC_REVIEW',
            taskId: input.targetTaskId,
          } as any);
          directorAction = p27ReasoningResult.action;
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
      } else if (this.reasoningEngine && this.allowLegacyReasoning) {
        try {
          legacyReasoningResult = await this.reasoningEngine.reason({
            snapshot,
            userInstructions: typeof input.instruction === 'string' ? input.instruction : undefined,
          });
          decisionContract = legacyReasoningResult.decision;
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
      } else if (this.allowLegacyReasoning) {
        // Test/compatibility fallback strictly when allowLegacyReasoning is explicitly enabled:
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
      } else {
        // Fail closed: In production execution path, closed-loop reasoning MUST fail closed
        // if DirectorRuntime is not configured. Legacy reasoning fallback is rejected unless
        // explicitly allowed via test option allowLegacyReasoning.
        return {
          cycleId: `cycle-${Date.now()}-no-runtime`,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'EXECUTION_FAILED',
          isSuccess: false,
          summary: 'DIRECTOR_RUNTIME_UNAVAILABLE: Fail closed: No authoritative DirectorRuntime configured for closed-loop execution.',
          stepReached: 'REASONING',
          humanDecisionRequired: false,
          completedAt: new Date().toISOString(),
        };
      }
    }

    // Handle legacy No-op or Clarification decisions from legacy reasoning if present
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
          reasoningResult: legacyReasoningResult,
          humanDecisionRequired: (decisionContract.decisionType as string) === 'REQUEST_CLARIFICATION',
          humanDecisionPoint:
            (decisionContract.decisionType as string) === 'REQUEST_CLARIFICATION'
              ? decisionContract.metadata
              : undefined,
          completedAt: new Date().toISOString(),
        };
      }
    }

    const reasoningResult = (p27ReasoningResult ?? legacyReasoningResult) as any;

    // ------------------------------------------------------------------------
    // Step 3: Action Packaging & Envelope Validation
    // ------------------------------------------------------------------------
    let validatedActionResult: ValidatedDirectorActionResult;
    const validationContext = {
      currentFingerprint: snapshot.logicalFingerprint,
      currentUnderstandingRevision,
      currentDirectorSessionId: session.directorSessionId,
      currentProjectId: projectId,
    };

    if (actionEnvelope) {
      // Anti-spoofing & authority boundary verification on arbitrary custom envelope
      const p = (actionEnvelope.payload ?? {}) as Record<string, unknown>;
      if (
        (actionEnvelope as any).actor === 'USER' ||
        (actionEnvelope as any).actorRole === 'PRODUCT_OWNER' ||
        p.isDevelopmentAuthorized === true ||
        p.hasImplementationAuthority === true ||
        p.isTrustedHumanAuth === true ||
        p.authStatus === 'VERIFIED_HUMAN' ||
        p.actor === 'USER' ||
        p.actorRole === 'PRODUCT_OWNER' ||
        p.selfApproved === true ||
        p.claimImplementationAuthority === true
      ) {
        return {
          cycleId: `cycle-${Date.now()}-envelope-spoof-err`,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'EXECUTION_FAILED',
          isSuccess: false,
          summary: 'Action envelope validation failed: Spoofed authority or unauthorized role escalation detected in payload.',
          stepReached: 'ACTION_PACKAGING',
          actionEnvelope,
          humanDecisionRequired: false,
          completedAt: new Date().toISOString(),
        };
      }

      try {
        const val = await this.actionValidator.validate(actionEnvelope, validationContext);
        validatedActionResult = {
          success: true,
          envelope: actionEnvelope,
          validationResult: val,
          isDuplicate: false,
          reasoningResult: (p27ReasoningResult ?? legacyReasoningResult) as any,
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
          directorAction,
          humanDecisionRequired: false,
          completedAt: new Date().toISOString(),
        };
      }
    } else if (directorAction) {
      try {
        const envelope = this.actionBuilder.buildEnvelope({
          action: directorAction,
          snapshot,
          idempotencyKey: input.idempotencyKey,
        });
        actionEnvelope = envelope;

        const val = await this.actionValidator.validate(envelope, validationContext);
        validatedActionResult = {
          success: true,
          envelope,
          validationResult: val,
          isDuplicate: false,
          reasoningResult: (p27ReasoningResult ?? legacyReasoningResult) as any,
        };
      } catch (err: any) {
        return {
          cycleId: `cycle-${Date.now()}-action-packaging-err`,
          projectId,
          directorSessionId: session.directorSessionId,
          status: 'EXECUTION_FAILED',
          isSuccess: false,
          summary: `Action envelope packaging or validation failed: ${err.message}`,
          stepReached: 'ACTION_PACKAGING',
          directorAction,
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

        const val = await this.actionValidator.validate(envelope, validationContext);
        validatedActionResult = {
          success: true,
          envelope,
          validationResult: val,
          isDuplicate: false,
          reasoningResult: legacyReasoningResult as any,
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
        directorAction,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    if (dispatchResult.status === ActionDispatchStatus.COMPLETED) {
      return {
        cycleId: `cycle-${Date.now()}-completed`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'COMPLETED_SUCCESS',
        isSuccess: true,
        summary: dispatchResult.reason ?? 'Action completed successfully.',
        stepReached: 'STATE_INTEGRATION_RECOVERY',
        actionEnvelope,
        directorAction,
        dispatchResult,
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
        directorAction,
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
        directorAction,
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
        directorAction,
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
        directorAction,
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
        (actionEnvelope.payload as any)?.selectedTaskId ??
        decisionContract?.selectedTaskId ??
        input.targetTaskId) as string;

    const activePkg = await this.approvalStore.getActivePackage(projectId);

    // Non-IMPLEMENT_TASK actions (e.g. DECLARE_PROJECT_COMPLETE, REQUEST_PLANNING) do not dispatch implementation to bridge
    // RETRY_TASK / CORRECT_TASK are execution actions (dispatcher routes them through
    // handleImplementTask): they MUST reach the bridge and independent evidence, never succeed here.
    if (
      actionEnvelope &&
      actionEnvelope.actionType !== 'IMPLEMENT_TASK' &&
      actionEnvelope.actionType !== 'RETRY_TASK' &&
      actionEnvelope.actionType !== 'CORRECT_TASK'
    ) {
      return {
        cycleId: `cycle-${Date.now()}-${actionEnvelope.actionType.toLowerCase()}`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'COMPLETED_SUCCESS',
        isSuccess: true,
        summary: dispatchResult.reason ?? `Action ${actionEnvelope.actionType} dispatched and accepted.`,
        stepReached: 'STATE_INTEGRATION_RECOVERY',
        actionEnvelope,
        directorAction,
        dispatchResult,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    // Persist authoritative Director decision if action is IMPLEMENT_TASK
    if (actionEnvelope && actionEnvelope.actionType === 'IMPLEMENT_TASK' && targetTaskId) {
      const existingDecisions = await this.decisionStore.listDecisions({ sessionId: session.directorSessionId });
      const hasDecision = existingDecisions.some(
        (d) =>
          d.decisionType === 'IMPLEMENT_TASK' &&
          (d.metadata as any)?.taskId === targetTaskId &&
          // A bounded repair attempt on a changed context is a NEW authoritative decision.
          d.basedOnContextFingerprint === actionEnvelope!.basedOnContextFingerprint
      );
      if (!hasDecision) {
        await this.decisionStore.saveDecision({
          decisionId: `dec-${actionEnvelope.actionId}`,
          directorSessionId: session.directorSessionId,
          projectId,
          protocolVersion: 'P9-03',
          schemaVersion: 1,
          actor: 'DIRECTOR',
          decisionType: 'IMPLEMENT_TASK',
          rationale:
            (actionEnvelope.payload as any)?.rationale ??
            (actionEnvelope.payload as any)?.objective ??
            `Authoritative Director implementation decision for task ${targetTaskId}`,
          basedOnContextFingerprint: actionEnvelope.basedOnContextFingerprint,
          basedOnApprovalRevision: activePkg?.revision ?? 1,
          basedOnUnderstandingRevision: actionEnvelope.understandingRevision,
          createdAt: new Date().toISOString(),
          metadata: { taskId: targetTaskId },
          hasImplementationAuthority: false,
        });
      }
    }

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
        (actionEnvelope.payload as any)?.executionPlan ??
        (actionEnvelope.payload as any)?.objective ??
        `Implement task ${targetTaskId}`,
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
      const isTimeout =
        err.code === 'ETIMEDOUT' ||
        err.name === 'TimeoutError' ||
        (typeof err.message === 'string' &&
          (err.message.toLowerCase().includes('timed out') ||
            err.message.toLowerCase().includes('timeout') ||
            err.message.toLowerCase().includes('aborted')));

      return {
        cycleId: `cycle-${Date.now()}-bridge-err`,
        projectId,
        directorSessionId: session.directorSessionId,
        status: isTimeout ? 'EXECUTION_UNKNOWN' : 'EXECUTION_FAILED',
        isSuccess: false,
        summary: `Execution bridge error: ${err.message}`,
        stepReached: isTimeout ? 'EVIDENCE_VERIFICATION' : 'BRIDGE_EXECUTION',
        taskId: intent.taskId,
        actionEnvelope,
        dispatchResult,
        humanDecisionRequired: isTimeout,
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

    // Check for Process Tree Isolation Uncertainty -> fail-closed to BLOCKED_ON_APPROVAL (ADR-15)
    const isIsolationUncertain =
      bridgeResult.code === 'ERR_PROCESS_ISOLATION_UNCERTAINTY' ||
      bridgeResult.systemEvidence?.failureCategory === 'PROCESS_ISOLATION_UNCERTAINTY';

    if (isIsolationUncertain) {
      const blockId = `block-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const detectedPid = (bridgeResult.systemEvidence as any)?.processPid ?? (bridgeResult as any)?.rawOutcome?.processPid;

      const curState = (await this.durableStateManager.load()) ?? {
        currentLifecycleState: LifecycleState.TASK_LOOP,
        completedTaskIds: [],
        activeTaskId: intent.taskId,
        blockedState: null,
      };

      await this.durableStateManager.save({
        ...curState,
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: intent.taskId,
        blockedState: {
          blockedTaskId: intent.taskId,
          blockedIteration: 1,
          blockedContextReference: intent.basedOnContextFingerprint,
          blockingReason: 'PROCESS_ISOLATION_UNCERTAINTY',
          resumePoint: 'TASK_LOOP',
          timestamp: completedAt,
          metadata: {
            blockId,
            reason: 'Process tree termination could not be independently verified. Orphan process may exist.',
            cycleId,
            projectId,
            processPid: detectedPid,
            state: 'BLOCKED',
            resumptionCondition: 'Human PO approval and independent OS-level verification that no orphan processes remain alive.',
          },
        },
      });

      if (this.historyManager) {
        await this.historyManager
          .appendEvent({
            eventType: 'PROCESS_ISOLATION_BLOCKED',
            actor: Actor.ORCHESTRATOR,
            payload: {
              blockId,
              cycleId,
              taskId: intent.taskId,
              projectId,
              reason: 'PROCESS_ISOLATION_UNCERTAINTY',
              blockedAt: completedAt,
              processPid: detectedPid,
            },
          })
          .catch(() => {});
      }

      return {
        cycleId,
        projectId,
        directorSessionId: session.directorSessionId,
        status: 'BLOCKED',
        isSuccess: false,
        summary: `BLOCKED on PROCESS_ISOLATION_UNCERTAINTY: Process tree termination could not be independently verified. Orphan process may exist.`,
        stepReached: 'DRIVER_EXECUTION',
        taskId: intent.taskId,
        reasoningResult,
        actionEnvelope,
        directorAction,
        dispatchResult,
        bridgeResult,
        cycleResult: bridgeResult.cycleResult,
        systemEvidence: bridgeResult.systemEvidence,
        humanDecisionRequired: true,
        humanDecisionPoint: {
          code: 'ERR_PROCESS_ISOLATION_UNCERTAINTY',
          blockId,
          cycleId,
          reason: 'PROCESS_ISOLATION_UNCERTAINTY: Process termination could not be verified dead. OS-level re-verification required before resuming.',
        },
        completedAt,
      };
    }

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
        directorAction,
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
        directorAction,
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
          directorAction,
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
          continuationPolicy: 'CONTROLLED_MANUAL',
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
        directorAction,
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
        directorAction,
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
            directorAction,
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
      directorAction,
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

  /**
   * P30 Authoritative Lifecycle Recovery
   * Reconciles crash state through RecoveryEngine, updates DurableState and HistoryManager,
   * refreshes DirectorContextSnapshot, and provides updated context to DirectorRuntime.
   *
   * Flow:
   * RecoveryEngine ➔ RecoveryResult ➔ ClosedLoopCoordinator boundary ➔ DirectorContextSnapshot refresh ➔ DirectorRuntime
   */
  async recoverAuthoritativeLifecycle(options?: {
    directorSessionId?: string;
    projectId?: string;
  }): Promise<{
    recoveryResult: RecoveryResult;
    refreshedContext: DirectorContextSnapshot;
    directorDecision?: any;
    humanDecisionRequired: boolean;
  }> {
    // 1. RecoveryEngine authoritative reconciliation
    const recoveryResult = await this.recoveryEngine.reconcile();

    // 2. Refresh DirectorContextSnapshot with updated durable state and blocked state
    const targetSessionId = options?.directorSessionId ?? 'session-director-p30';
    const targetProjectId =
      options?.projectId ??
      resolveCanonicalProjectIdentity(this.workspaceRoot ?? process.cwd()).projectId;

    let refreshedContext: DirectorContextSnapshot;
    try {
      const existing = await this.sessionStore.loadLatestSnapshot(targetSessionId);
      if (existing && existing.isComplete && !existing.logicalFingerprint.endsWith('-recovery')) {
        refreshedContext = existing;
      } else {
        const synchronizer = new DirectorContextSynchronizer({
          workspaceRoot: this.workspaceRoot ?? process.cwd(),
          sessionStore: this.sessionStore,
          sessionEngine: this.sessionEngine,
        });
        refreshedContext = await synchronizer.synchronize({
          directorSessionId: targetSessionId,
          projectId: targetProjectId,
        });
      }
    } catch {
      try {
        let sess = await this.sessionStore.loadSession(targetSessionId);
        if (!sess) {
          sess = await this.sessionEngine.createSession({
            directorSessionId: targetSessionId,
            projectId: targetProjectId,
          });
        }
        const synchronizer = new DirectorContextSynchronizer({
          workspaceRoot: this.workspaceRoot ?? process.cwd(),
          sessionStore: this.sessionStore,
          sessionEngine: this.sessionEngine,
        });
        refreshedContext = await synchronizer.synchronize({
          directorSessionId: targetSessionId,
          projectId: targetProjectId,
        });
      } catch {
        const fallbackExisting = await this.sessionStore.loadLatestSnapshot(targetSessionId);
        if (fallbackExisting) {
          refreshedContext = fallbackExisting;
        } else {
          throw new Error(`Cannot recover authoritative lifecycle: Context unavailable for session ${targetSessionId}`);
        }
      }
    }

    const humanDecisionRequired =
      recoveryResult.decision === 'BLOCKED_ON_HUMAN' ||
      recoveryResult.executionLifecycleState === 'EXECUTION_UNKNOWN' ||
      recoveryResult.reason.startsWith('EXECUTION_UNKNOWN');

    // 3. If DirectorRuntime is available, let Director evaluate next step without mutating recovery state
    let directorDecision: any = null;
    if (this.directorRuntime && !humanDecisionRequired) {
      try {
        directorDecision = await this.directorRuntime.reason({
          projectId: targetProjectId,
          directorSessionId: targetSessionId,
          trigger: 'PERIODIC_REVIEW',
          snapshot: refreshedContext,
          additionalContext: {
            recoveryDecision: recoveryResult.decision,
            recoveryReason: recoveryResult.reason,
          },
        });
      } catch {
        // Director reasoning error is non-fatal to recovery
      }
    }

    return {
      recoveryResult,
      refreshedContext,
      directorDecision,
      humanDecisionRequired,
    };
  }

  /**
   * Authoritative Closed-Loop Automation Engine (Phase OM-09 / Director Runtime Automation).
   * Executes continuous, bounded cycles from a single user instruction until all tasks are complete,
   * human approval is required, a policy violation occurs, or unknown execution state is reached.
   *
   * HARD ARCHITECTURAL INVARIANTS:
   * 1. Bounded execution: Strictly enforced maxCycles (never runs indefinitely).
   * 2. Zero executor trust: Independent SystemExecutionEvidence verification on every cycle.
   * 3. Unknown state fail-closed: EXECUTION_UNKNOWN halts the loop immediately without re-dispatch.
   * 4. Human approval boundary: Halts in BLOCKED_ON_APPROVAL when human authorization is required.
   * 5. Fresh context guarantee: Re-synchronizes context snapshot before each reasoning cycle.
   * 6. Cancellation: Reacts immediately to AbortSignal cancellation.
   */
  async coordinateAutoLoop(input: ClosedLoopAutoLoopInput): Promise<ClosedLoopAutoLoopResult> {
    if (input.signal?.aborted) {
      return {
        loopId: `loop-cancelled-${Date.now()}`,
        projectId: input.projectId ?? 'unknown',
        directorSessionId: input.directorSessionId ?? 'unknown',
        terminalStatus: 'CANCELLED',
        isSuccess: false,
        cyclesRun: 0,
        completedCycles: [],
        tasksCompleted: [],
        summary: 'Auto-loop cancelled via AbortSignal before start.',
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    const parseResult = ClosedLoopAutoLoopInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      const errReason = `Invalid auto-loop input: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`;
      return {
        loopId: `loop-${Date.now()}-invalid`,
        projectId: input.projectId ?? 'unknown',
        directorSessionId: input.directorSessionId ?? 'unknown',
        terminalStatus: 'EXECUTION_FAILED',
        isSuccess: false,
        cyclesRun: 0,
        completedCycles: [],
        tasksCompleted: [],
        summary: errReason,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    const workingDir = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    const projectId = input.projectId ?? canonical.projectId;

    if (canonical.projectId !== projectId) {
      return {
        loopId: `loop-${Date.now()}-mismatch`,
        projectId,
        directorSessionId: input.directorSessionId ?? 'unknown',
        terminalStatus: 'EXECUTION_FAILED',
        isSuccess: false,
        cyclesRun: 0,
        completedCycles: [],
        tasksCompleted: [],
        summary: `Canonical project identity mismatch: expected '${projectId}', got '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project execution rejected.`,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    const maxCycles = input.maxCycles ?? 10;
    const maxRecoveryAttempts = input.maxRecoveryAttempts ?? 2;
    const loopId = `loop-${canonical.projectId}-${Date.now()}`;
    const completedCycles: ClosedLoopCycleResult[] = [];
    const tasksCompleted: string[] = [];
    const taskFailureCounts = new Map<string, number>();

    let currentSession = null;
    if (input.directorSessionId) {
      try {
        currentSession = await this.sessionEngine.getSession(input.directorSessionId, {
          workspaceRoot: workingDir,
          projectId,
        });
      } catch (err: any) {
        return {
          loopId,
          projectId,
          directorSessionId: input.directorSessionId,
          terminalStatus: 'EXECUTION_FAILED',
          isSuccess: false,
          cyclesRun: 0,
          completedCycles: [],
          tasksCompleted: [],
          summary: `Failed to resolve Director session '${input.directorSessionId}': ${err.message}`,
          humanDecisionRequired: false,
          completedAt: new Date().toISOString(),
        };
      }
    } else {
      currentSession = await this.sessionStore.getActiveSession();
    }

    if (!currentSession || currentSession.status !== 'ACTIVE') {
      return {
        loopId,
        projectId,
        directorSessionId: currentSession?.directorSessionId ?? 'unknown',
        terminalStatus: 'EXECUTION_FAILED',
        isSuccess: false,
        cyclesRun: 0,
        completedCycles: [],
        tasksCompleted: [],
        summary: `Director session '${currentSession?.directorSessionId ?? 'none'}' is ${currentSession?.status ?? 'MISSING'}. An ACTIVE session is required for auto-loop execution.`,
        humanDecisionRequired: false,
        completedAt: new Date().toISOString(),
      };
    }

    // Check pre-existing blocked state in DurableStateManager
    const durableState = await this.durableStateManager.load();
    if (durableState?.blockedState) {
      const isIsolationBlock = durableState.blockedState.blockingReason === 'PROCESS_ISOLATION_UNCERTAINTY';
      return {
        loopId,
        projectId,
        directorSessionId: currentSession.directorSessionId,
        terminalStatus: isIsolationBlock ? 'DISPATCH_BLOCKED' : 'BLOCKED_ON_APPROVAL',
        isSuccess: false,
        cyclesRun: 0,
        completedCycles: [],
        tasksCompleted: [],
        summary: isIsolationBlock
          ? `DISPATCH_BLOCKED: Auto-loop dispatch rejected because system is permanently BLOCKED on PROCESS_ISOLATION_UNCERTAINTY. Two-phase unblocking (PO approval + OS process verification) required.`
          : `Durable state is currently blocked on human decision: ${durableState.blockedState.blockingReason}`,
        humanDecisionRequired: true,
        humanDecisionPoint: durableState.blockedState,
        completedAt: new Date().toISOString(),
      };
    }

    let nextTargetTaskId = input.targetTaskId;
    let terminalStatus: ClosedLoopAutoLoopTerminalStatus = 'ALL_TASKS_COMPLETED';
    let summary = 'Auto-loop completed successfully.';
    let humanDecisionRequired = false;
    let humanDecisionPoint: unknown = undefined;

    for (let cycleNum = 1; cycleNum <= maxCycles; cycleNum++) {
      // 1. Check AbortSignal for user cancellation
      if (input.signal?.aborted) {
        terminalStatus = 'CANCELLED';
        summary = 'Auto-loop cancelled via AbortSignal.';
        break;
      }

      // 2. Synchronize Context Snapshot before each cycle (Freshness Guarantee)
      try {
        const synchronizer = new DirectorContextSynchronizer({
          workspaceRoot: workingDir,
          sessionStore: this.sessionStore,
          sessionEngine: this.sessionEngine,
        });
        await synchronizer.synchronize({
          directorSessionId: currentSession.directorSessionId,
          projectId,
        });
      } catch {
        // Sync failure logged; coordinateCycle validates snapshot staleness fail-closed
      }

      // 3. Execute Single Controlled Cycle
      const cycleResult = await this.coordinateCycle({
        workspaceRoot: workingDir,
        projectId,
        directorSessionId: currentSession.directorSessionId,
        instruction: input.instruction,
        targetTaskId: nextTargetTaskId,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        authContext: input.authContext,
        maxRecoveryAttempts,
      });

      completedCycles.push(cycleResult);

      if (input.onCycleCompleted) {
        await input.onCycleCompleted(cycleResult, cycleNum);
      }

      // 4. Evaluate Cycle Outcome & Enforce Fail-Closed Invariants
      if (cycleResult.status === 'BLOCKED') {
        terminalStatus = 'BLOCKED';
        summary = `Auto-loop halted fail-closed: System entered BLOCKED state due to PROCESS_ISOLATION_UNCERTAINTY (${cycleResult.summary}).`;
        humanDecisionRequired = true;
        humanDecisionPoint = cycleResult.humanDecisionPoint;
        break;
      }

      if (cycleResult.status === 'EXECUTION_UNKNOWN') {
        terminalStatus = 'EXECUTION_UNKNOWN';
        summary = `Auto-loop halted fail-closed: Execution state is unknown (${cycleResult.summary}). Invariant: Zero blind re-dispatch. Human intervention required.`;
        humanDecisionRequired = true;
        humanDecisionPoint = { reason: cycleResult.summary, cycleId: cycleResult.cycleId };
        break;
      }

      if (cycleResult.status === 'REJECTED_BY_POLICY') {
        terminalStatus = 'REJECTED_BY_POLICY';
        summary = `Auto-loop halted fail-closed: Action rejected by policy (${cycleResult.summary}).`;
        break;
      }

      if (cycleResult.humanDecisionRequired || cycleResult.status === 'BLOCKED_ON_APPROVAL') {
        terminalStatus = 'BLOCKED_ON_APPROVAL';
        summary = `Auto-loop stopped safely: Human approval or decision required (${cycleResult.summary}).`;
        humanDecisionRequired = true;
        humanDecisionPoint = cycleResult.humanDecisionPoint;
        break;
      }

      if (cycleResult.status === 'NO_ACTION_REQUIRED') {
        terminalStatus = 'COMPLETED_SUCCESS';
        summary = `Auto-loop concluded: ${cycleResult.summary}`;
        break;
      }

      if (cycleResult.status === 'COMPLETED_SUCCESS' && cycleResult.isSuccess) {
        if (cycleResult.taskId && !tasksCompleted.includes(cycleResult.taskId)) {
          tasksCompleted.push(cycleResult.taskId);
        }

        // Check if all tasks in SpecStore are completed
        const allTasks = await this.specStore.loadTasks();
        const pendingTasks = allTasks.filter(
          (t) => t.status !== 'ACCEPTED' && !tasksCompleted.includes(t.task_id)
        );
        if (pendingTasks.length === 0) {
          terminalStatus = 'ALL_TASKS_COMPLETED';
          summary = `All tasks in project specification are completed and verified (${tasksCompleted.length} tasks completed).`;
          break;
        }

        // Reset target task ID to allow next cycle to select next ready task
        nextTargetTaskId = undefined;
      } else {
        // Cycle did not succeed
        const failedTaskId = cycleResult.taskId ?? 'unknown';
        const failCount = (taskFailureCounts.get(failedTaskId) ?? 0) + 1;
        taskFailureCounts.set(failedTaskId, failCount);

        if (failCount > maxRecoveryAttempts) {
          terminalStatus = 'MAX_ATTEMPTS_EXCEEDED';
          summary = `Auto-loop halted: Task '${failedTaskId}' exceeded maximum recovery attempts (${maxRecoveryAttempts}).`;
          humanDecisionRequired = true;
          humanDecisionPoint = { taskId: failedTaskId, attempts: failCount, reason: cycleResult.summary };
          break;
        }

        if (cycleResult.status === 'CORRECTIVE_TASK_CREATED' && cycleResult.correctiveTaskId) {
          // Point next cycle at corrective task
          nextTargetTaskId = cycleResult.correctiveTaskId;
        } else {
          terminalStatus = cycleResult.status;
          summary = `Auto-loop stopped: Cycle ${cycleNum} ended with status ${cycleResult.status} (${cycleResult.summary}).`;
          break;
        }
      }

      // Check maxCycles limit
      if (cycleNum === maxCycles) {
        terminalStatus = 'MAX_CYCLES_REACHED';
        summary = `Auto-loop reached maximum cycle limit (${maxCycles}). Stopping safely.`;
        break;
      }
    }

    const isSuccess =
      terminalStatus === 'ALL_TASKS_COMPLETED' ||
      terminalStatus === 'COMPLETED_SUCCESS';

    return {
      loopId,
      projectId,
      directorSessionId: currentSession.directorSessionId,
      terminalStatus,
      isSuccess,
      cyclesRun: completedCycles.length,
      completedCycles,
      lastCycleResult: completedCycles[completedCycles.length - 1],
      tasksCompleted,
      summary,
      humanDecisionRequired,
      humanDecisionPoint,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Helper to check if coordinator durable state is actively blocked on PROCESS_ISOLATION_UNCERTAINTY.
   */
  async isIsolationBlocked(): Promise<boolean> {
    const cur = await this.durableStateManager.load();
    return cur?.blockedState?.blockingReason === 'PROCESS_ISOLATION_UNCERTAINTY';
  }

  /**
   * G-10: Two-phase unblocking service for PROCESS_ISOLATION_UNCERTAINTY.
   * Requires BOTH:
   * 1. Condition A: Valid, authenticated Product Owner human approval record/package.
   * 2. Condition B: Independent OS-level process re-verification confirming no surviving orphan processes.
   */
  async unblockProcessIsolation(
    input: UnblockProcessIsolationInput
  ): Promise<UnblockProcessIsolationResult> {
    const parseResult = UnblockProcessIsolationInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        state: 'BLOCKED',
        reason: `Invalid unblock input: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
      };
    }

    const workspaceKey = path.resolve(this.workspaceRoot ?? process.cwd());
    if (this.isUnblockingProcess || ClosedLoopCoordinator.activeUnblockWorkspaces.has(workspaceKey)) {
      return {
        success: false,
        state: 'BLOCKED',
        reason: 'Concurrent unblock operation in progress for this workspace. Re-entrant or parallel unblock requests are rejected.',
      };
    }

    this.isUnblockingProcess = true;
    ClosedLoopCoordinator.activeUnblockWorkspaces.add(workspaceKey);
    try {
      const curDurable = await this.durableStateManager.load();
      if (!curDurable?.blockedState || curDurable.blockedState.blockingReason !== 'PROCESS_ISOLATION_UNCERTAINTY') {
        return {
          success: false,
          state: 'UNBLOCKED',
          reason: 'System is not currently blocked on PROCESS_ISOLATION_UNCERTAINTY.',
        };
      }

      const blockMetadata = (curDurable.blockedState.metadata ?? {}) as Record<string, unknown>;
      const activeBlockId = (blockMetadata.blockId as string) ?? 'active-isolation-block';

      // Strict Block ID binding verification
      if (!input.blockId || input.blockId !== activeBlockId) {
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason: `Block ID mismatch: provided proof blockId '${input.blockId}' does not match active blockId '${activeBlockId}'. Replay rejected.`,
        };
      }

      const projectId = input.projectId ?? (blockMetadata.projectId as string) ?? this.workspaceRoot;

      // ------------------------------------------------------------------------
      // Condition A: Authoritative Product Owner Approval Verification
      // ------------------------------------------------------------------------
      const poApprovalId = input.poPackageId ?? input.poApprovalId;

      // Single-use proof policy: prevent re-use of previously consumed PO approvals across cycles
      const consumedApprovals = (curDurable.metadata?.consumedPoApprovalIds as string[]) ?? [];
      if (
        consumedApprovals.includes(poApprovalId) ||
        curDurable.metadata?.unblockedByPoApprovalId === poApprovalId
      ) {
        const reason = `Condition A FAIL: Approval package '${poApprovalId}' has already been consumed to unblock a prior isolation block. Single-use proof policy strictly forbids re-using consumed approvals.`;
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      let approvalPackage = null;
      try {
        approvalPackage = await this.approvalStore.loadPackage(poApprovalId, undefined, projectId);
      } catch {
        // Fallback
      }

      if (!approvalPackage && projectId) {
        try {
          const activePkg = await this.approvalStore.getActivePackage(projectId);
          if (activePkg && (activePkg.packageId === poApprovalId || activePkg.approvalRecord?.packageId === poApprovalId)) {
            approvalPackage = activePkg;
          }
        } catch {
          // Fallback
        }
      }

      if (!approvalPackage) {
        const reason = `Condition A FAIL: Product Owner approval package '${poApprovalId}' could not be found in ApprovalStore. Client-asserted approval without authoritative record is rejected.`;
        if (this.historyManager) {
          await this.historyManager
            .appendEvent({
              eventType: 'ISOLATION_UNBLOCK_FAILED',
              actor: Actor.ORCHESTRATOR,
              payload: { blockId: activeBlockId, condition: 'A_PO_APPROVAL', reason },
            })
            .catch(() => {});
        }
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      // Cross-project scope binding check
      if (approvalPackage.projectId && projectId && approvalPackage.projectId !== projectId) {
        const reason = `Condition A FAIL: Approval package projectId '${approvalPackage.projectId}' does not match active project '${projectId}'. Cross-project approval rejected.`;
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      if (approvalPackage.status !== 'APPROVED') {
        const reason = `Condition A FAIL: Approval package '${poApprovalId}' status is '${approvalPackage.status}', expected 'APPROVED'.`;
        if (this.historyManager) {
          await this.historyManager
            .appendEvent({
              eventType: 'ISOLATION_UNBLOCK_FAILED',
              actor: Actor.ORCHESTRATOR,
              payload: { blockId: activeBlockId, condition: 'A_PO_APPROVAL', reason },
            })
            .catch(() => {});
        }
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      const appRecord = approvalPackage.approvalRecord;
      if (!appRecord) {
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason: `Condition A FAIL: Approval package '${poApprovalId}' has no authoritative approval record. Fail-closed.`,
        };
      }
      if ((appRecord.actorRole as string) !== 'PRODUCT_OWNER') {
        const reason = `Condition A FAIL: Approval record actorRole '${appRecord.actorRole}' is not an authorized Product Owner authority.`;
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      // Replay Protection: Ensure approval package is not stale compared to block timestamp
      const blockTimeMs = Date.parse(curDurable.blockedState.timestamp ?? '1970-01-01');
      const approvalTimeMs = Date.parse(appRecord?.approvedAt ?? approvalPackage.updatedAt ?? '1970-01-01');
      if (approvalTimeMs < blockTimeMs - 1000) {
        const reason = `Condition A FAIL: Approval record was created at ${appRecord?.approvedAt ?? approvalPackage.updatedAt}, before isolation block occurred at ${curDurable.blockedState.timestamp}. Replay of prior approval is forbidden.`;
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      // ------------------------------------------------------------------------
      // Condition B: Independent OS Process Re-Verification
      // ------------------------------------------------------------------------
      const pidsToCheck: number[] = [];
      if (blockMetadata.processPid && typeof blockMetadata.processPid === 'number') {
        pidsToCheck.push(blockMetadata.processPid);
      }
      if (input.processVerificationProof?.checkedPids) {
        for (const p of input.processVerificationProof.checkedPids) {
          if (!pidsToCheck.includes(p)) pidsToCheck.push(p);
        }
      }

      // ADR-15.4: re-verification must be real. With no PID to check, the verifier would report
      // "dead" vacuously, so an empty PID set is treated as unverifiable (fail-closed).
      if (pidsToCheck.length === 0) {
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason: 'Condition B FAIL: No process PID recorded for this block and none supplied for independent OS verification. Fail-closed.',
        };
      }

      // If caller provided explicit proof, check it first
      if (input.processVerificationProof) {
        if (!input.processVerificationProof.verifiedDead || input.processVerificationProof.error) {
          const reason = `Condition B FAIL: Caller processVerificationProof reported uncertainty or surviving process: ${input.processVerificationProof.error ?? 'not verified dead'}.`;
          return {
            success: false,
            blockId: activeBlockId,
            state: 'BLOCKED',
            reason,
          };
        }
      }

      // Run independent coordinator processVerifier
      const osVerif = await this.processVerifier(pidsToCheck);
      if (!osVerif.verifiedDead || osVerif.error) {
        const reason = `Condition B FAIL: Independent OS process table verification failed: ${osVerif.error ?? osVerif.output ?? 'Process still alive'}. Fail-closed.`;
        if (this.historyManager) {
          await this.historyManager
            .appendEvent({
              eventType: 'ISOLATION_UNBLOCK_FAILED',
              actor: Actor.ORCHESTRATOR,
              payload: { blockId: activeBlockId, condition: 'B_PROCESS_VERIFICATION', reason },
            })
            .catch(() => {});
        }
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason,
        };
      }

      // ------------------------------------------------------------------------
      // Both Conditions PASS -> Safely Lift Blockade
      // ------------------------------------------------------------------------
      // Optimistic concurrency double check before save
      const latestDurable = await this.durableStateManager.load();
      if (!latestDurable?.blockedState || latestDurable.blockedState.blockingReason !== 'PROCESS_ISOLATION_UNCERTAINTY') {
        return {
          success: false,
          state: 'UNBLOCKED',
          reason: 'System state was already unblocked concurrently.',
        };
      }
      const latestConsumed = (latestDurable.metadata?.consumedPoApprovalIds as string[]) ?? [];
      if (latestConsumed.includes(poApprovalId) || latestDurable.metadata?.unblockedByPoApprovalId === poApprovalId) {
        return {
          success: false,
          blockId: activeBlockId,
          state: 'BLOCKED',
          reason: `Condition A FAIL: Approval package '${poApprovalId}' was consumed concurrently. Single-use proof policy strictly forbids re-using consumed approvals.`,
        };
      }

      const unblockedAt = new Date().toISOString();
      await this.durableStateManager.save({
        ...latestDurable,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        blockedState: null,
        metadata: {
          ...(latestDurable.metadata ?? {}),
          lastUnblockedAt: unblockedAt,
          lastUnblockedBlockId: activeBlockId,
          unblockedByPoApprovalId: poApprovalId,
          consumedPoApprovalIds: [...latestConsumed, poApprovalId],
        },
      });

      if (this.historyManager) {
        await this.historyManager
          .appendEvent({
            eventType: 'PROCESS_ISOLATION_UNBLOCKED',
            actor: Actor.ORCHESTRATOR,
            payload: {
              blockId: activeBlockId,
              unblockedAt,
              poApprovalId,
              verifiedDead: true,
            },
          })
          .catch(() => {});
      }

      return {
        success: true,
        blockId: activeBlockId,
        state: 'UNBLOCKED',
        unblockedAt,
        unblockDetails: {
          poApprovalId,
          verifiedByActor: appRecord?.actor ?? 'PRODUCT_OWNER',
          processVerificationTimestamp: unblockedAt,
        },
      };
    } finally {
      ClosedLoopCoordinator.activeUnblockWorkspaces.delete(workspaceKey);
      this.isUnblockingProcess = false;
    }
  }
}
