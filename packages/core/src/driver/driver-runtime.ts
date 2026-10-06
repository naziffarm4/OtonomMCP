/**
 * Autonomous Driver Runtime (Phase 17 TASK-P17-01)
 *
 * Implements the durable, controllable runtime boundary:
 * - Owns running lifecycle (IDLE, STARTING, RUNNING, PAUSING, PAUSED, STOPPING, STOPPED, FAILED, RECOVERING)
 * - Single-active-driver atomic locking per project
 * - Foreground controlled iterations loop
 * - Governed pause, resume, and graceful stop
 * - Restart recovery with in-flight cycle reconciliation
 * - Durable state persistence across restarts
 * - Emits auditable HistoryManager lifecycle events
 */

import * as path from 'node:path';
import {
  type DriverLifecycleState as DriverLifecycleStateType,
  DriverLifecycleState,
  type DurableDriverState,
  type DriverIterationResult,
  type DriverHumanDecisionPoint,
  type DriverInFlightCycle,
  computeDeterministicDriverId,
  DRIVER_SCHEMA_VERSION,
} from './driver-types.js';
import {
  validateDriverLifecycleTransition,
  isValidDriverLifecycleTransition,
} from './driver-lifecycle.js';
import {
  DriverConcurrencyError,
  DriverValidationError,
  DriverAuthorizationError,
  DriverRecoveryError,
  DriverStaleStateError,
} from './driver-errors.js';
import { DriverLockManager } from './driver-lock.js';
import { DriverStore } from './driver-store.js';
import { DriverEngine } from './driver-engine.js';
import { HistoryManager } from '../storage/history-manager.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { LifecycleState } from '../lifecycle.js';

export interface DriverRuntimeOptions {
  readonly workspaceRoot?: string;
  readonly driverId?: string;
  readonly driverEngine?: DriverEngine;
  readonly lockManager?: DriverLockManager;
  readonly driverStore?: DriverStore;
  readonly historyManager?: HistoryManager;
}

export interface DriverRunOptions {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly targetTaskId?: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onIteration?: (result: DriverIterationResult) => void | Promise<void>;
}

export interface DriverRunSummary {
  readonly driverId: string;
  readonly projectId: string;
  readonly lifecycleState: DriverLifecycleStateType;
  readonly iterationsRun: number;
  readonly finalStatus?: string;
  readonly reason: string;
  readonly state: DurableDriverState;
}

export class DriverRuntime {
  readonly workspaceRoot?: string;
  readonly driverId: string;
  readonly driverEngine: DriverEngine;
  readonly lockManager: DriverLockManager;
  readonly driverStore: DriverStore;
  readonly historyManager?: HistoryManager;

  private state: DurableDriverState | null = null;
  private pauseRequested = false;
  private stopRequested = false;
  private isLoopRunning = false;

  constructor(options: DriverRuntimeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;

    const workingDir = options.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    this.driverId =
      options.driverId ?? computeDeterministicDriverId(canonical.projectId);

    this.lockManager =
      options.lockManager ??
      new DriverLockManager({ workspaceRoot: this.workspaceRoot });

    this.driverStore =
      options.driverStore ??
      new DriverStore({
        workspaceRoot: this.workspaceRoot,
        historyManager: this.historyManager,
      });

    this.driverEngine =
      options.driverEngine ??
      new DriverEngine({
        workspaceRoot: this.workspaceRoot,
        historyManager: this.historyManager,
      });
  }

  // ==========================================================================
  // 1. STATE & INSPECTION ACCESSORS
  // ==========================================================================

  get currentState(): DurableDriverState | null {
    return this.state ? { ...this.state } : null;
  }

  get currentLifecycleState(): DriverLifecycleStateType {
    return this.state?.lifecycleState ?? DriverLifecycleState.IDLE;
  }

  get isRunning(): boolean {
    return this.currentLifecycleState === DriverLifecycleState.RUNNING;
  }

  get isPaused(): boolean {
    return this.currentLifecycleState === DriverLifecycleState.PAUSED;
  }

  get isStopped(): boolean {
    return this.currentLifecycleState === DriverLifecycleState.STOPPED;
  }

  // ==========================================================================
  // 2. RESTART RECOVERY
  // ==========================================================================

  /**
   * Discovers and reconciles persisted driver state across restarts.
   * 1. Reads persisted driver state from disk.
   * 2. Checks previous lifecycle state.
   * 3. Checks whether a cycle was in-flight when previous process died.
   * 4. Reconciles with authoritative execution/evidence store to prevent duplicate execution.
   * 5. Recovers to a safe, auditable state (PAUSED or IDLE).
   */
  async recover(): Promise<DurableDriverState> {
    const loaded = await this.driverStore.loadState();
    const now = new Date().toISOString();

    if (!loaded) {
      // Clean initial state
      const canonical = resolveCanonicalProjectIdentity(this.workspaceRoot ?? process.cwd());
      const initialState: DurableDriverState = {
        schemaVersion: DRIVER_SCHEMA_VERSION,
        driverId: this.driverId,
        projectId: canonical.projectId,
        lifecycleState: DriverLifecycleState.IDLE,
        currentIteration: 0,
        continuationState: 'NONE',
        continuationPolicy: 'GOVERNED_AUTONOMOUS',
        startedAt: now,
        updatedAt: now,
      };
      this.state = initialState;
      await this.driverStore.saveState(initialState);
      return initialState;
    }

    this.state = loaded;

    // Check if recovery is required (e.g. process died while STARTING, RUNNING, PAUSING, RECOVERING)
    const wasRunning =
      loaded.lifecycleState === DriverLifecycleState.RUNNING ||
      loaded.lifecycleState === DriverLifecycleState.STARTING ||
      loaded.lifecycleState === DriverLifecycleState.PAUSING ||
      loaded.lifecycleState === DriverLifecycleState.RECOVERING;

    if (wasRunning) {
      // Transition to RECOVERING
      validateDriverLifecycleTransition(
        loaded.lifecycleState,
        DriverLifecycleState.RECOVERING,
        { driverId: loaded.driverId, reason: 'Restart recovery initiated' }
      );

      await this.driverStore.recordHistoryEvent(
        'DRIVER_RECOVERING',
        {
          driverId: loaded.driverId,
          projectId: loaded.projectId,
          previousState: loaded.lifecycleState,
          currentIteration: loaded.currentIteration,
          inFlightCycle: loaded.inFlightCycle ?? null,
        },
        loaded.currentTaskId
      );

      // Reconcile in-flight cycle if one was recorded
      let reconciledLastCycleId = loaded.lastCompletedCycleId;
      let reconciledEvidenceId = loaded.lastEvidenceId;
      let reconciledStatus: any = loaded.lastTerminalStatus;
      let existingCycle: any = null;
      if (loaded.inFlightCycle) {
        const inFlight = loaded.inFlightCycle;
        // Check if cycle result was completed and saved in loopStore
        existingCycle = await this.driverEngine.loopStore.getCycleResultByInstructionId(
          inFlight.instructionId
        );

        if (existingCycle) {
          // Execution completed before crash: adopt authoritative cycle result
          reconciledLastCycleId = existingCycle.cycleId;
          reconciledEvidenceId = existingCycle.systemEvidence.evidenceId;
          reconciledStatus = existingCycle.terminalStatus;
        } else {
          // In-flight cycle lacked authoritative completion evidence -> EXECUTION_UNKNOWN
          reconciledStatus = 'EXECUTION_UNKNOWN';
        }
      }

      // Check authoritative DurableStateManager for in-flight execution intent
      try {
        const durableState = await this.driverEngine.durableStateManager.load();
        if (durableState) {
          const rawIntent = durableState.metadata?.executionIntent as any;
          if (
            rawIntent?.lifecycleState === 'EXECUTING' ||
            durableState.metadata?.executionLifecycleState === 'EXECUTION_UNKNOWN' ||
            (loaded.inFlightCycle && !existingCycle)
          ) {
            reconciledStatus = 'EXECUTION_UNKNOWN';
            const blockedState = {
              blockedTaskId: loaded.currentTaskId ?? durableState.activeTaskId ?? 'unknown',
              blockedIteration: loaded.currentIteration,
              blockedContextReference: (durableState.metadata?.contextReference as string) ?? 'unknown-context',
              blockingReason:
                'EXECUTION_UNKNOWN: In-flight execution interrupted by crash without verified completion evidence. Zombie takeover prevented.',
              resumePoint: 'RESUME_EXACT_BLOCKED_POINT',
            };
            await this.driverEngine.durableStateManager.save({
              currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
              activeTaskId: loaded.currentTaskId ?? durableState.activeTaskId,
              completedTaskIds: durableState.completedTaskIds,
              blockedState,
              metadata: {
                ...(durableState.metadata ?? {}),
                executionLifecycleState: 'EXECUTION_UNKNOWN',
                ...(rawIntent
                  ? {
                      executionIntent: {
                        ...rawIntent,
                        lifecycleState: 'EXECUTION_UNKNOWN',
                      },
                    }
                  : {}),
              },
            });
          }
        }
      } catch {
        // Non-fatal
      }

      // Safe recovered state: PAUSED (prevents unintended execution after crash)
      const recoveredState: DurableDriverState = {
        ...loaded,
        lifecycleState: DriverLifecycleState.PAUSED,
        lastCompletedCycleId: reconciledLastCycleId,
        lastEvidenceId: reconciledEvidenceId,
        lastTerminalStatus: reconciledStatus,
        continuationState: 'PAUSED',
        inFlightCycle: null, // cleared
        updatedAt: now,
        recoveryInfo: {
          retryCount: loaded.recoveryInfo?.retryCount ?? 0,
          maxRetries: loaded.recoveryInfo?.maxRetries ?? 3,
          lastStrategy:
            reconciledStatus === 'EXECUTION_UNKNOWN'
              ? 'BLOCKED_ON_HUMAN'
              : 'RESTART_RECOVERY_RECONCILED',
        },
      };

      this.state = recoveredState;
      await this.driverStore.saveState(recoveredState);

      await this.driverStore.recordHistoryEvent(
        'DRIVER_PAUSED',
        {
          driverId: loaded.driverId,
          projectId: loaded.projectId,
          reason: 'Safely paused following restart recovery reconciliation.',
        },
        recoveredState.currentTaskId
      );

      // If stale lock exists from the previous dead PID, force release it so driver can resume cleanly
      await this.lockManager.forceRelease();

      return recoveredState;
    }

    return loaded;
  }

  // ==========================================================================
  // 3. START & FOREGROUND EXECUTION LOOP
  // ==========================================================================

  /**
   * Starts the governed foreground runtime.
   * Acquires single-active-driver lock, performs recovery if needed,
   * runs controlled iterations, revalidating authoritative state before each cycle.
   */
  async start(options: DriverRunOptions = {}): Promise<DriverRunSummary> {
    if (this.isLoopRunning) {
      throw new DriverConcurrencyError(
        `Driver '${this.driverId}' is already running in this process.`
      );
    }

    const workingDir = options.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(workingDir);
    const projectId = options.projectId ?? canonical.projectId;

    if (canonical.projectId !== projectId) {
      throw new DriverValidationError(
        `Project identity mismatch: requested '${projectId}', working dir is '${canonical.projectId}'`,
        { expectedProjectId: projectId, actualProjectId: canonical.projectId }
      );
    }

    // 1. Single Active Driver Protection: Acquire Lock
    await this.lockManager.acquireLock(this.driverId, projectId);

    // 2. Discover/Recover Durable State
    await this.recover();

    // Zombie takeover prevention: If recovered state is EXECUTION_UNKNOWN or BLOCKED_ON_HUMAN, halt fail-closed
    if (
      (this.state?.lastTerminalStatus as any) === 'EXECUTION_UNKNOWN' ||
      this.state?.recoveryInfo?.lastStrategy === 'BLOCKED_ON_HUMAN'
    ) {
      return {
        driverId: this.driverId,
        projectId,
        lifecycleState: DriverLifecycleState.PAUSED,
        iterationsRun: 0,
        finalStatus: 'EXECUTION_UNKNOWN',
        reason:
          'Driver recovered from crash with in-flight execution in EXECUTION_UNKNOWN state. Zombie takeover prevented; human authorization required to resume.',
        state: this.state!,
      };
    }

    // 3. Lifecycle Transition to STARTING -> RUNNING
    const currentState = this.currentLifecycleState;
    if (currentState === DriverLifecycleState.PAUSED) {
      validateDriverLifecycleTransition(currentState, DriverLifecycleState.RUNNING, {
        driverId: this.driverId,
      });
    } else {
      validateDriverLifecycleTransition(currentState, DriverLifecycleState.STARTING, {
        driverId: this.driverId,
      });
      validateDriverLifecycleTransition(
        DriverLifecycleState.STARTING,
        DriverLifecycleState.RUNNING,
        { driverId: this.driverId }
      );
    }

    const now = new Date().toISOString();
    this.state = {
      ...(this.state ?? {
        schemaVersion: DRIVER_SCHEMA_VERSION,
        driverId: this.driverId,
        projectId,
        currentIteration: 0,
        continuationState: 'CONTINUING',
        continuationPolicy: 'GOVERNED_AUTONOMOUS',
        startedAt: now,
        updatedAt: now,
      }),
      projectId,
      directorSessionId: options.directorSessionId ?? this.state?.directorSessionId,
      lifecycleState: DriverLifecycleState.RUNNING,
      continuationState: 'CONTINUING',
      updatedAt: now,
    };
    await this.driverStore.saveState(this.state);

    await this.driverStore.recordHistoryEvent(
      'DRIVER_STARTED',
      {
        driverId: this.driverId,
        projectId,
        directorSessionId: this.state.directorSessionId,
        continuationPolicy: this.state.continuationPolicy,
      },
      this.state.currentTaskId
    );

    // 4. Hook AbortSignal for graceful stop
    const signalListener = () => {
      this.stopRequested = true;
    };
    if (options.signal) {
      if (options.signal.aborted) {
        this.stopRequested = true;
      } else {
        options.signal.addEventListener('abort', signalListener, { once: true });
      }
    }

    this.pauseRequested = false;
    this.stopRequested = false;
    this.isLoopRunning = true;

    let iterationsRun = 0;
    let finalReason = '';
    const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;

    try {
      while (
        this.state?.lifecycleState === DriverLifecycleState.RUNNING &&
        iterationsRun < maxIterations
      ) {
        // A. Check Pause Request
        if (this.pauseRequested) {
          await this.transitionTo(DriverLifecycleState.PAUSING, 'Pause requested before cycle');
          await this.transitionTo(DriverLifecycleState.PAUSED, 'Driver safely paused');
          await this.driverStore.recordHistoryEvent(
            'DRIVER_PAUSED',
            { driverId: this.driverId, projectId, reason: 'Pause requested' },
            this.state?.currentTaskId
          );
          finalReason = 'Execution paused by request.';
          break;
        }

        // B. Check Stop Request / Abort Signal
        if (this.stopRequested || options.signal?.aborted) {
          await this.transitionTo(DriverLifecycleState.STOPPING, 'Stop requested before cycle');
          await this.transitionTo(DriverLifecycleState.STOPPED, 'Driver gracefully stopped');
          await this.driverStore.recordHistoryEvent(
            'DRIVER_STOPPED',
            { driverId: this.driverId, projectId, reason: 'Stop requested or aborted' },
            this.state?.currentTaskId
          );
          await this.lockManager.releaseLock(this.driverId);
          finalReason = 'Execution stopped gracefully.';
          break;
        }

        // C. Record Iteration Start
        const iterationNumber: number = (this.state?.currentIteration ?? 0) + 1;
        iterationsRun++;

        await this.driverStore.recordHistoryEvent(
          'DRIVER_ITERATION_STARTED',
          {
            driverId: this.driverId,
            projectId,
            iteration: iterationNumber,
          },
          this.state?.currentTaskId
        );

        // Update inFlightCycle to guarantee restart recovery safety
        this.state = {
          ...this.state!,
          currentIteration: iterationNumber,
          updatedAt: new Date().toISOString(),
          inFlightCycle: {
            instructionId: `in-flight-${iterationNumber}`,
            taskId: options.targetTaskId ?? this.state?.currentTaskId ?? 'pending',
            taskRevision: 1,
            startedAt: new Date().toISOString(),
          },
        };
        await this.driverStore.saveState(this.state);

        // Renew Lock Heartbeat
        await this.lockManager.renewHeartbeat(this.driverId).catch(() => {});

        // D. Execute Governed Iteration via DriverEngine
        let iterationResult: DriverIterationResult;
        try {
          iterationResult = await this.driverEngine.runIteration({
            workspaceRoot: workingDir,
            projectId,
            directorSessionId: this.state?.directorSessionId,
            targetTaskId: options.targetTaskId ?? undefined,
            iterationNumber,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
          });
        } catch (err: any) {
          // Iteration execution error
          this.state = {
            ...this.state!,
            lifecycleState: DriverLifecycleState.FAILED,
            failureReason: err.message,
            inFlightCycle: null,
            updatedAt: new Date().toISOString(),
          };
          await this.driverStore.saveState(this.state);
          await this.driverStore.recordHistoryEvent(
            'DRIVER_FAILED',
            { driverId: this.driverId, projectId, error: err.message },
            this.state.currentTaskId
          );
          await this.lockManager.releaseLock(this.driverId);
          throw err;
        }

        // E. Clear inFlightCycle and update durable state with cycle result
        const completedAt = new Date().toISOString();
        this.state = {
          ...this.state!,
          currentTaskId: iterationResult.taskId,
          lastInstructionId: iterationResult.instructionId,
          lastCompletedCycleId: iterationResult.cycleResult?.cycleId ?? this.state?.lastCompletedCycleId,
          lastEvidenceId:
            iterationResult.cycleResult?.systemEvidence?.evidenceId ??
            this.state?.lastEvidenceId,
          lastExecutionRequestId:
            iterationResult.cycleResult?.executionRequest?.requestId ??
            this.state?.lastExecutionRequestId,
          lastTerminalStatus:
            iterationResult.cycleResult?.terminalStatus ?? this.state?.lastTerminalStatus,
          inFlightCycle: null,
          updatedAt: completedAt,
        };
        await this.driverStore.saveState(this.state);

        await this.driverStore.recordHistoryEvent(
          'DRIVER_ITERATION_COMPLETED',
          {
            driverId: this.driverId,
            projectId,
            iteration: iterationNumber,
            taskId: iterationResult.taskId,
            decision: iterationResult.decision,
            reason: iterationResult.reason,
            terminalStatus: iterationResult.cycleResult?.terminalStatus,
          },
          iterationResult.taskId
        );

        if (options.onIteration) {
          await options.onIteration(iterationResult);
        }

        // F. Handle Iteration Decision
        if (iterationResult.decision === 'STOP') {
          await this.transitionTo(DriverLifecycleState.STOPPING, iterationResult.reason);
          await this.transitionTo(DriverLifecycleState.STOPPED, iterationResult.reason);
          await this.driverStore.recordHistoryEvent(
            'DRIVER_STOPPED',
            {
              driverId: this.driverId,
              projectId,
              reason: iterationResult.reason,
            },
            iterationResult.taskId
          );
          await this.lockManager.releaseLock(this.driverId);
          finalReason = iterationResult.reason;
          break;
        }

        if (iterationResult.decision === 'PAUSE') {
          await this.transitionTo(DriverLifecycleState.PAUSING, iterationResult.reason);
          await this.transitionTo(DriverLifecycleState.PAUSED, iterationResult.reason);
          await this.driverStore.recordHistoryEvent(
            'DRIVER_PAUSED',
            {
              driverId: this.driverId,
              projectId,
              reason: iterationResult.reason,
            },
            iterationResult.taskId
          );
          finalReason = iterationResult.reason;
          break;
        }

        if (iterationResult.decision === 'HUMAN_DECISION_REQUIRED') {
          // Human decision required: record in durable state and transition to PAUSED
          const decisionPoint = iterationResult.nextAction?.humanDecisionPoint;
          await this.transitionTo(DriverLifecycleState.PAUSING, iterationResult.reason);
          await this.transitionTo(DriverLifecycleState.PAUSED, iterationResult.reason);
          this.state = {
            ...this.state!,
            continuationState: 'WAITING_HUMAN',
            blockReason: iterationResult.reason,
            humanDecisionPoint: decisionPoint
              ? {
                  decisionId: decisionPoint.decisionId,
                  category: decisionPoint.category,
                  description: decisionPoint.description,
                  reason: decisionPoint.reason,
                  blockedState: decisionPoint.blockedState,
                }
              : {
                  decisionId: `decision-${iterationResult.taskId}-blocked`,
                  category: 'HUMAN_DECISION_REQUIRED',
                  description: iterationResult.reason,
                  reason: iterationResult.reason,
                },
            updatedAt: new Date().toISOString(),
          };
          await this.driverStore.saveState(this.state);

          await this.driverStore.recordHistoryEvent(
            'DRIVER_BLOCKED',
            {
              driverId: this.driverId,
              projectId,
              reason: iterationResult.reason,
              humanDecisionPoint: this.state.humanDecisionPoint,
            },
            iterationResult.taskId
          );
          finalReason = iterationResult.reason;
          break;
        }

        if (iterationResult.decision === 'FAILED') {
          await this.transitionTo(DriverLifecycleState.FAILED, iterationResult.reason);
          await this.driverStore.recordHistoryEvent(
            'DRIVER_FAILED',
            {
              driverId: this.driverId,
              projectId,
              reason: iterationResult.reason,
            },
            iterationResult.taskId
          );
          await this.lockManager.releaseLock(this.driverId);
          finalReason = iterationResult.reason;
          break;
        }

        // Decision is 'CONTINUE': loop continues
      }

      if (iterationsRun >= maxIterations && this.state?.lifecycleState === DriverLifecycleState.RUNNING) {
        finalReason = `Reached maximum iterations limit (${maxIterations}).`;
        await this.transitionTo(DriverLifecycleState.PAUSING, finalReason);
        await this.transitionTo(DriverLifecycleState.PAUSED, finalReason);
        await this.driverStore.recordHistoryEvent(
          'DRIVER_PAUSED',
          { driverId: this.driverId, projectId, reason: finalReason },
          this.state?.currentTaskId
        );
      }
    } finally {
      this.isLoopRunning = false;
      if (options.signal) {
        options.signal.removeEventListener('abort', signalListener);
      }
      // If terminal state reached, ensure lock is released
      if (
        this.state?.lifecycleState === DriverLifecycleState.STOPPED ||
        this.state?.lifecycleState === DriverLifecycleState.FAILED
      ) {
        await this.lockManager.releaseLock(this.driverId).catch(() => {});
      }
    }

    return {
      driverId: this.driverId,
      projectId,
      lifecycleState: this.currentLifecycleState,
      iterationsRun,
      finalStatus: this.state?.lastTerminalStatus ?? undefined,
      reason: finalReason,
      state: this.state!,
    };
  }

  // ==========================================================================
  // 4. PAUSE, RESUME, AND STOP CONTROLS
  // ==========================================================================

  /**
   * Requests the running driver to pause safely before the next execution cycle.
   */
  async pause(): Promise<void> {
    if (this.currentLifecycleState === DriverLifecycleState.PAUSED) {
      return; // idempotent
    }

    this.pauseRequested = true;

    // If loop is not active in this process, perform immediate safe state transition
    if (!this.isLoopRunning && this.state?.lifecycleState === DriverLifecycleState.RUNNING) {
      await this.transitionTo(DriverLifecycleState.PAUSING, 'External pause request');
      await this.transitionTo(DriverLifecycleState.PAUSED, 'External pause request completed');
      await this.driverStore.recordHistoryEvent(
        'DRIVER_PAUSED',
        { driverId: this.driverId, projectId: this.state.projectId, reason: 'External pause request' },
        this.state.currentTaskId
      );
    }
  }

  /**
   * Resumes execution from PAUSED state after re-validating authoritative context.
   */
  async resume(options: DriverRunOptions = {}): Promise<DriverRunSummary> {
    if (this.currentLifecycleState !== DriverLifecycleState.PAUSED) {
      throw new DriverValidationError(
        `Cannot resume driver from state '${this.currentLifecycleState}'. Driver must be in PAUSED state.`,
        { currentState: this.currentLifecycleState }
      );
    }

    const workingDir = options.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const projectId = this.state?.projectId ?? resolveCanonicalProjectIdentity(workingDir).projectId;

    // Revalidate continuation before transitioning
    const validation = await this.driverEngine.validateContinuation(
      workingDir,
      projectId,
      options.targetTaskId ?? this.state?.currentTaskId ?? undefined
    );

    if (!validation.isAllowed) {
      throw new DriverStaleStateError(
        `Cannot resume driver: authoritative state validation failed: ${validation.reason}`,
        { reason: validation.reason, requiresHumanDecision: validation.requiresHumanDecision }
      );
    }

    await this.driverStore.recordHistoryEvent(
      'DRIVER_RESUMED',
      {
        driverId: this.driverId,
        projectId,
        taskId: validation.nextTaskId,
        reason: 'Driver resumed by authorized request.',
      },
      validation.nextTaskId
    );

    return await this.start(options);
  }

  /**
   * Gracefully stops the driver, halts future cycles, releases the lock, and sets STOPPED.
   */
  async stop(reason = 'Driver stopped by request'): Promise<void> {
    if (this.currentLifecycleState === DriverLifecycleState.STOPPED) {
      return; // idempotent
    }

    this.stopRequested = true;

    // If loop is not actively running, perform clean stop immediately
    if (!this.isLoopRunning) {
      const currentState = this.currentLifecycleState;
      if (isValidDriverLifecycleTransition(currentState, DriverLifecycleState.STOPPING)) {
        await this.transitionTo(DriverLifecycleState.STOPPING, reason);
      }
      await this.transitionTo(DriverLifecycleState.STOPPED, reason);
      await this.lockManager.releaseLock(this.driverId);

      if (this.state) {
        await this.driverStore.recordHistoryEvent(
          'DRIVER_STOPPED',
          { driverId: this.driverId, projectId: this.state.projectId, reason },
          this.state.currentTaskId
        );
      }
    }
  }

  // ==========================================================================
  // 5. HELPER METHODS
  // ==========================================================================

  private async transitionTo(
    nextState: DriverLifecycleStateType,
    reason?: string
  ): Promise<void> {
    const current = this.currentLifecycleState;
    validateDriverLifecycleTransition(current, nextState, {
      driverId: this.driverId,
      reason,
    });

    const now = new Date().toISOString();
    this.state = {
      ...(this.state ?? {
        schemaVersion: DRIVER_SCHEMA_VERSION,
        driverId: this.driverId,
        projectId: resolveCanonicalProjectIdentity(this.workspaceRoot ?? process.cwd()).projectId,
        currentIteration: 0,
        continuationState: 'NONE',
        continuationPolicy: 'GOVERNED_AUTONOMOUS',
        startedAt: now,
        updatedAt: now,
      }),
      lifecycleState: nextState,
      updatedAt: now,
      completedAt: nextState === DriverLifecycleState.STOPPED ? now : this.state?.completedAt,
    };

    await this.driverStore.saveState(this.state);
  }
}
