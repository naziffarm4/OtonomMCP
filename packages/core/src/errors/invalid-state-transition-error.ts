import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import type { LifecycleState } from '../lifecycle.js';

export interface InvalidStateTransitionDetails extends AidmErrorDetails {
  fromState?: LifecycleState | string;
  toState?: LifecycleState | string;
  allowedTransitions?: readonly (LifecycleState | string)[];
  reason?: string;
}

/**
 * Thrown when an invalid or disallowed state machine transition is attempted.
 * Distinct error code: ERR_INVALID_STATE_TRANSITION
 */
export class InvalidStateTransitionError extends AidmError {
  readonly fromState?: LifecycleState | string;
  readonly toState?: LifecycleState | string;

  constructor(
    message: string,
    details?: InvalidStateTransitionDetails,
    code = 'ERR_INVALID_STATE_TRANSITION'
  ) {
    super(message, code, details);
    this.fromState = details?.fromState;
    this.toState = details?.toState;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
