import type { LifecycleState, TaskLoopState } from '../lifecycle.js';

/**
 * Data captured and preserved when the FSM enters BLOCKED_ON_HUMAN.
 * Enables deterministic resumption without restarting or re-running task selection.
 */
export interface BlockedStateData {
  blockedTaskId: string;
  blockedIteration: number;
  blockedContextReference: string;
  blockingReason: string;
  resumePoint: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Event emitted upon every successful macro FSM transition.
 */
export interface StateTransitionEvent {
  eventId: string;
  fromState: LifecycleState;
  toState: LifecycleState;
  timestamp: string;
  payload?: unknown;
  blockedState?: BlockedStateData;
}

/**
 * Synchronous listener for state transition events.
 */
export type StateTransitionListener = (event: StateTransitionEvent) => void;

/**
 * Configuration options for initializing the StateMachine.
 */
export interface StateMachineOptions {
  initialState?: LifecycleState;
  initialBlockedState?: BlockedStateData;
}

/**
 * Event emitted upon every nested TaskLoop FSM transition.
 */
export interface TaskLoopTransitionEvent {
  eventId: string;
  fromState: TaskLoopState;
  toState: TaskLoopState;
  timestamp: string;
  payload?: unknown;
}

export type TaskLoopTransitionListener = (event: TaskLoopTransitionEvent) => void;
