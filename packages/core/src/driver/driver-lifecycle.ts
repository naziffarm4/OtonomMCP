/**
 * Autonomous Driver Lifecycle State Machine (Phase 17 TASK-P17-01)
 *
 * Enforces deterministic transitions between durable Driver lifecycle states.
 * Fails closed on any invalid or unauthorized transition.
 */

import {
  DriverLifecycleState,
  type DriverLifecycleState as DriverLifecycleStateType,
} from './driver-types.js';
import { InvalidDriverLifecycleTransitionError } from './driver-errors.js';

export const VALID_DRIVER_LIFECYCLE_TRANSITIONS: Readonly<
  Record<DriverLifecycleStateType, readonly DriverLifecycleStateType[]>
> = Object.freeze({
  [DriverLifecycleState.IDLE]: Object.freeze([
    DriverLifecycleState.STARTING,
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
  ]),
  [DriverLifecycleState.STARTING]: Object.freeze([
    DriverLifecycleState.RUNNING,
    DriverLifecycleState.RECOVERING,
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
  ]),
  [DriverLifecycleState.RUNNING]: Object.freeze([
    DriverLifecycleState.PAUSING,
    DriverLifecycleState.STOPPING,
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
    DriverLifecycleState.RECOVERING,
  ]),
  [DriverLifecycleState.PAUSING]: Object.freeze([
    DriverLifecycleState.PAUSED,
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
    DriverLifecycleState.RECOVERING,
  ]),
  [DriverLifecycleState.PAUSED]: Object.freeze([
    DriverLifecycleState.RUNNING,
    DriverLifecycleState.STOPPING,
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
  ]),
  [DriverLifecycleState.STOPPING]: Object.freeze([
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
  ]),
  [DriverLifecycleState.STOPPED]: Object.freeze([]), // Terminal state
  [DriverLifecycleState.FAILED]: Object.freeze([
    DriverLifecycleState.RECOVERING,
    DriverLifecycleState.STOPPED,
  ]),
  [DriverLifecycleState.RECOVERING]: Object.freeze([
    DriverLifecycleState.RUNNING,
    DriverLifecycleState.PAUSED,
    DriverLifecycleState.STOPPED,
    DriverLifecycleState.FAILED,
  ]),
});

/**
 * Validates whether a state transition from `fromState` to `toState` is allowed.
 * Throws InvalidDriverLifecycleTransitionError if invalid (fails closed).
 */
export function validateDriverLifecycleTransition(
  fromState: DriverLifecycleStateType,
  toState: DriverLifecycleStateType,
  context?: { driverId?: string; reason?: string }
): void {
  // Idempotent transition to same state is allowed
  if (fromState === toState) {
    return;
  }

  const allowed = VALID_DRIVER_LIFECYCLE_TRANSITIONS[fromState];
  if (!allowed || !allowed.includes(toState)) {
    throw new InvalidDriverLifecycleTransitionError(
      `Invalid driver lifecycle transition from '${fromState}' to '${toState}'. Allowed transitions: [${(allowed ?? []).join(', ')}]`,
      {
        fromState,
        toState,
        driverId: context?.driverId,
        reason: context?.reason,
      }
    );
  }
}

/**
 * Checks if a transition is valid without throwing.
 */
export function isValidDriverLifecycleTransition(
  fromState: DriverLifecycleStateType,
  toState: DriverLifecycleStateType
): boolean {
  if (fromState === toState) {
    return true;
  }
  const allowed = VALID_DRIVER_LIFECYCLE_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.includes(toState));
}

/**
 * Checks if the state is terminal (STOPPED).
 */
export function isTerminalDriverLifecycleState(state: DriverLifecycleStateType): boolean {
  return state === DriverLifecycleState.STOPPED;
}
