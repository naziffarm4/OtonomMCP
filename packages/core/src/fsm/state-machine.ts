import { LifecycleState, TaskLoopState } from '../lifecycle.js';
import { InvalidStateTransitionError } from '../errors/invalid-state-transition-error.js';
import type {
  BlockedStateData,
  StateTransitionEvent,
  StateTransitionListener,
  StateMachineOptions,
  TaskLoopTransitionEvent,
  TaskLoopTransitionListener,
} from './fsm-types.js';

// ============================================================================
// 1. AUTHORITATIVE TOP-LEVEL LIFECYCLE TRANSITION TABLE
// ============================================================================

/**
 * Authoritative, deterministic transition table for AIDM Top-Level Lifecycle.
 * Directly reflects Technical Discovery Section 2 & Section 33.
 * 
 * Strict progression:
 * INITIALIZING
 *   ↓
 * REQUIREMENTS_INGESTION
 *   ↓
 * ARCHITECTURE_SPEC
 *   ↓
 * TASK_DECOMPOSITION
 *   ↓
 * TASK_SELECTION
 *   ↓
 * TASK_LOOP ───► PROJECT_COMPLETE
 *   │    ▲
 *   │    │
 *   ▼    │
 * BLOCKED_ON_HUMAN ──► RESUME_EXACT_BLOCKED_POINT
 */
export const VALID_LIFECYCLE_TRANSITIONS: ReadonlyMap<LifecycleState, ReadonlySet<LifecycleState>> = new Map<
  LifecycleState,
  ReadonlySet<LifecycleState>
>([
  [
    LifecycleState.INITIALIZING,
    new Set<LifecycleState>([
      LifecycleState.REQUIREMENTS_INGESTION,
      // CRITICAL PROHIBITION: INITIALIZING cannot jump directly to TASK_LOOP or BLOCKED_ON_HUMAN
    ]),
  ],
  [
    LifecycleState.REQUIREMENTS_INGESTION,
    new Set<LifecycleState>([
      LifecycleState.ARCHITECTURE_SPEC,
      LifecycleState.BLOCKED_ON_HUMAN,
    ]),
  ],
  [
    LifecycleState.ARCHITECTURE_SPEC,
    new Set<LifecycleState>([
      LifecycleState.TASK_DECOMPOSITION,
      LifecycleState.BLOCKED_ON_HUMAN,
    ]),
  ],
  [
    LifecycleState.TASK_DECOMPOSITION,
    new Set<LifecycleState>([
      LifecycleState.TASK_SELECTION,
      LifecycleState.BLOCKED_ON_HUMAN,
    ]),
  ],
  [
    LifecycleState.TASK_SELECTION,
    new Set<LifecycleState>([
      LifecycleState.TASK_LOOP,
      LifecycleState.BLOCKED_ON_HUMAN,
    ]),
  ],
  [
    LifecycleState.TASK_LOOP,
    new Set<LifecycleState>([
      LifecycleState.TASK_LOOP, // Self-iteration for next tasks
      LifecycleState.BLOCKED_ON_HUMAN,
      LifecycleState.PROJECT_COMPLETE,
    ]),
  ],
  [
    LifecycleState.BLOCKED_ON_HUMAN,
    new Set<LifecycleState>([
      // CRITICAL REQUIREMENT: BLOCKED_ON_HUMAN can ONLY transition to RESUME_EXACT_BLOCKED_POINT
      LifecycleState.RESUME_EXACT_BLOCKED_POINT,
    ]),
  ],
  [
    LifecycleState.RESUME_EXACT_BLOCKED_POINT,
    new Set<LifecycleState>([
      // Resume point transitions strictly back to the active TASK_LOOP
      LifecycleState.TASK_LOOP,
    ]),
  ],
  [
    LifecycleState.PROJECT_COMPLETE,
    new Set<LifecycleState>(), // Terminal state; zero transitions allowed
  ],
]);

export const VALID_TRANSITIONS = VALID_LIFECYCLE_TRANSITIONS;

// ============================================================================
// 2. AUTHORITATIVE NESTED TASK_LOOP PROCESS TRANSITION TABLE
// ============================================================================

/**
 * Detailed nested transitions within the TASK_LOOP lifecycle, as documented
 * in Technical Discovery Section 2.
 */
export const VALID_TASK_LOOP_TRANSITIONS: ReadonlyMap<TaskLoopState, ReadonlySet<TaskLoopState>> = new Map<
  TaskLoopState,
  ReadonlySet<TaskLoopState>
>([
  [
    TaskLoopState.TASK_SELECTION,
    new Set<TaskLoopState>([TaskLoopState.PRE_FLIGHT_CHECKPOINT, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.PRE_FLIGHT_CHECKPOINT,
    new Set<TaskLoopState>([TaskLoopState.INSTRUCT_ANTIGRAVITY, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.INSTRUCT_ANTIGRAVITY,
    new Set<TaskLoopState>([TaskLoopState.IMPLEMENTATION, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.IMPLEMENTATION,
    new Set<TaskLoopState>([TaskLoopState.EVIDENCE_COLLECTION, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.EVIDENCE_COLLECTION,
    new Set<TaskLoopState>([TaskLoopState.ORCHESTRATOR_EVIDENCE_VALIDATION, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.ORCHESTRATOR_EVIDENCE_VALIDATION,
    new Set<TaskLoopState>([TaskLoopState.CHATGPT_REVIEW, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.CHATGPT_REVIEW,
    new Set<TaskLoopState>([TaskLoopState.ANALYZE_EVIDENCE, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.ANALYZE_EVIDENCE,
    new Set<TaskLoopState>([
      TaskLoopState.ACCEPT,
      TaskLoopState.REJECT,
      TaskLoopState.REQUEST_CONTEXT,
      TaskLoopState.BLOCKED_ON_HUMAN,
    ]),
  ],
  [
    TaskLoopState.REQUEST_CONTEXT,
    new Set<TaskLoopState>([TaskLoopState.INSTRUCT_ANTIGRAVITY, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.REJECT,
    new Set<TaskLoopState>([TaskLoopState.ROOT_CAUSE_ANALYSIS, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.ROOT_CAUSE_ANALYSIS,
    new Set<TaskLoopState>([TaskLoopState.RETRY_STRATEGY_CHECK, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.RETRY_STRATEGY_CHECK,
    new Set<TaskLoopState>([TaskLoopState.INSTRUCT_ANTIGRAVITY, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.ACCEPT,
    new Set<TaskLoopState>([TaskLoopState.POST_FLIGHT_COMMIT, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.POST_FLIGHT_COMMIT,
    new Set<TaskLoopState>([TaskLoopState.CHECK_DAG_COMPLETION, TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.CHECK_DAG_COMPLETION,
    new Set<TaskLoopState>([
      TaskLoopState.TASK_SELECTION,
      TaskLoopState.PROJECT_COMPLETE_VALIDATION,
      TaskLoopState.BLOCKED_ON_HUMAN,
    ]),
  ],
  [
    TaskLoopState.PROJECT_COMPLETE_VALIDATION,
    new Set<TaskLoopState>([TaskLoopState.BLOCKED_ON_HUMAN]),
  ],
  [
    TaskLoopState.BLOCKED_ON_HUMAN,
    new Set<TaskLoopState>([
      TaskLoopState.INSTRUCT_ANTIGRAVITY,
      TaskLoopState.IMPLEMENTATION,
      TaskLoopState.EVIDENCE_COLLECTION,
      TaskLoopState.CHATGPT_REVIEW,
    ]),
  ],
]);

// ============================================================================
// 3. TOP-LEVEL STATE MACHINE IMPLEMENTATION
// ============================================================================

/**
 * Deterministic Finite State Machine (FSM) Engine for AI Development Manager.
 * 
 * Enforces valid transitions, notifies subscribers in deterministic order,
 * and maintains exact blocked state data when paused on human intervention.
 */
export class StateMachine {
  private currentState: LifecycleState;
  private blockedState: BlockedStateData | null = null;
  private listeners: StateTransitionListener[] = [];
  private eventCounter = 0;

  constructor(options?: StateMachineOptions) {
    this.currentState = options?.initialState ?? LifecycleState.INITIALIZING;
    if (options?.initialBlockedState) {
      this.blockedState = { ...options.initialBlockedState };
    }
  }

  /**
   * Returns the current lifecycle state of the machine.
   */
  getState(): LifecycleState {
    return this.currentState;
  }

  /**
   * Returns the currently stored blocked state data, if any.
   */
  getBlockedState(): Readonly<BlockedStateData> | null {
    return this.blockedState ? { ...this.blockedState } : null;
  }

  /**
   * Checks whether a transition from current state to target state is valid.
   */
  canTransitionTo(toState: LifecycleState): boolean {
    const allowed = VALID_LIFECYCLE_TRANSITIONS.get(this.currentState);
    return allowed ? allowed.has(toState) : false;
  }

  /**
   * Returns all allowed target states from the current state.
   */
  getAllowedTransitions(): readonly LifecycleState[] {
    const allowed = VALID_LIFECYCLE_TRANSITIONS.get(this.currentState);
    return allowed ? Array.from(allowed) : [];
  }

  /**
   * Transitions the machine to a new state if valid.
   * Throws InvalidStateTransitionError if the transition is disallowed.
   */
  transitionTo(toState: LifecycleState, payload?: unknown): StateTransitionEvent {
    if (!this.canTransitionTo(toState)) {
      const allowed = this.getAllowedTransitions();
      throw new InvalidStateTransitionError(
        `Invalid state transition: Cannot transition from '${this.currentState}' to '${toState}'. Allowed transitions: [${allowed.join(', ')}]`,
        {
          fromState: this.currentState,
          toState,
          allowedTransitions: allowed,
          reason: `Transition from ${this.currentState} to ${toState} is disallowed by the authoritative transition table.`,
        }
      );
    }

    const fromState = this.currentState;
    let eventBlockedState: BlockedStateData | undefined;

    // Handle entering BLOCKED_ON_HUMAN
    if (toState === LifecycleState.BLOCKED_ON_HUMAN) {
      if (this.isBlockedStateData(payload)) {
        this.blockedState = {
          ...payload,
          timestamp: payload.timestamp ?? new Date().toISOString(),
        };
      }
      eventBlockedState = this.blockedState ?? undefined;
    }

    // When transitioning into RESUME_EXACT_BLOCKED_POINT, preserve blockedState in the event
    if (toState === LifecycleState.RESUME_EXACT_BLOCKED_POINT) {
      eventBlockedState = this.blockedState ?? undefined;
    }

    // When transitioning out of RESUME_EXACT_BLOCKED_POINT into TASK_LOOP, carry it then clear
    if (fromState === LifecycleState.RESUME_EXACT_BLOCKED_POINT) {
      eventBlockedState = this.blockedState ?? undefined;
      this.blockedState = null;
    }

    this.currentState = toState;
    this.eventCounter++;

    const event: StateTransitionEvent = {
      eventId: `fsm-evt-${Date.now()}-${this.eventCounter}`,
      fromState,
      toState,
      timestamp: new Date().toISOString(),
      payload,
      blockedState: eventBlockedState,
    };

    // Notify registered listeners in deterministic order
    this.notifyListeners(event);

    return event;
  }

  /**
   * Helper to enter BLOCKED_ON_HUMAN with structured blocked state data.
   */
  blockOnHuman(blockedData: BlockedStateData, payload?: unknown): StateTransitionEvent {
    this.blockedState = {
      ...blockedData,
      timestamp: blockedData.timestamp ?? new Date().toISOString(),
    };
    return this.transitionTo(LifecycleState.BLOCKED_ON_HUMAN, payload);
  }

  /**
   * Resumes execution from BLOCKED_ON_HUMAN strictly via RESUME_EXACT_BLOCKED_POINT
   * preserving exact blocked task, iteration, and context reference.
   * 
   * Strict progression: BLOCKED_ON_HUMAN → RESUME_EXACT_BLOCKED_POINT (→ TASK_LOOP)
   */
  resumeFromHuman(userResponse?: unknown): StateTransitionEvent {
    if (this.currentState !== LifecycleState.BLOCKED_ON_HUMAN) {
      throw new InvalidStateTransitionError(
        `Cannot resume from human: Current state is '${this.currentState}', expected '${LifecycleState.BLOCKED_ON_HUMAN}'.`,
        {
          fromState: this.currentState,
          toState: LifecycleState.RESUME_EXACT_BLOCKED_POINT,
          reason: 'resumeFromHuman can only be called when state is BLOCKED_ON_HUMAN.',
        }
      );
    }

    const previousBlockedState = this.blockedState ? { ...this.blockedState } : null;
    const resumePayload = {
      userResponse,
      resumedBlockedState: previousBlockedState,
    };

    return this.transitionTo(LifecycleState.RESUME_EXACT_BLOCKED_POINT, resumePayload);
  }

  /**
   * Subscribes a listener function to state transition events.
   * Returns an unsubscribe function.
   */
  subscribe(listener: StateTransitionListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private notifyListeners(event: StateTransitionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[StateMachine] Error in state transition listener:', err);
      }
    }
  }

  private isBlockedStateData(value: unknown): value is BlockedStateData {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.blockedTaskId === 'string' &&
      typeof candidate.blockedIteration === 'number' &&
      typeof candidate.blockedContextReference === 'string' &&
      typeof candidate.blockingReason === 'string' &&
      typeof candidate.resumePoint === 'string'
    );
  }
}

// ============================================================================
// 4. NESTED TASK_LOOP STATE MACHINE IMPLEMENTATION
// ============================================================================

/**
 * Nested State Machine managing the granular execution steps inside TASK_LOOP.
 */
export class TaskLoopStateMachine {
  private currentState: TaskLoopState;
  private listeners: TaskLoopTransitionListener[] = [];
  private eventCounter = 0;

  constructor(initialState: TaskLoopState = TaskLoopState.TASK_SELECTION) {
    this.currentState = initialState;
  }

  getState(): TaskLoopState {
    return this.currentState;
  }

  canTransitionTo(toState: TaskLoopState): boolean {
    const allowed = VALID_TASK_LOOP_TRANSITIONS.get(this.currentState);
    return allowed ? allowed.has(toState) : false;
  }

  getAllowedTransitions(): readonly TaskLoopState[] {
    const allowed = VALID_TASK_LOOP_TRANSITIONS.get(this.currentState);
    return allowed ? Array.from(allowed) : [];
  }

  transitionTo(toState: TaskLoopState, payload?: unknown): TaskLoopTransitionEvent {
    if (!this.canTransitionTo(toState)) {
      const allowed = this.getAllowedTransitions();
      throw new InvalidStateTransitionError(
        `Invalid task loop transition: Cannot transition from '${this.currentState}' to '${toState}'. Allowed: [${allowed.join(', ')}]`,
        {
          fromState: this.currentState,
          toState,
          allowedTransitions: allowed,
          reason: `Transition from ${this.currentState} to ${toState} is disallowed in TaskLoop FSM.`,
        }
      );
    }

    const fromState = this.currentState;
    this.currentState = toState;
    this.eventCounter++;

    const event: TaskLoopTransitionEvent = {
      eventId: `task-loop-evt-${Date.now()}-${this.eventCounter}`,
      fromState,
      toState,
      timestamp: new Date().toISOString(),
      payload,
    };

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[TaskLoopStateMachine] Listener error:', err);
      }
    }

    return event;
  }

  subscribe(listener: TaskLoopTransitionListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }
}
