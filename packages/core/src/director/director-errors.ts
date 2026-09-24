/**
 * Director Session Domain Errors (Phase 9 TASK-P9-01)
 *
 * Defines deterministic, typed errors for Director session identity, lifecycle,
 * project binding, and security violations.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class DirectorSessionError extends AidmError {
  constructor(message: string, code = 'ERR_DIRECTOR_SESSION', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorValidationError extends DirectorSessionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_VALIDATION', details);
  }
}

export class DirectorSessionNotFoundError extends DirectorSessionError {
  constructor(sessionId: string, details?: AidmErrorDetails) {
    super(`Director session not found: '${sessionId}'`, 'ERR_DIRECTOR_SESSION_NOT_FOUND', {
      sessionId,
      ...details,
    });
  }
}

export class DirectorSessionAlreadyExistsError extends DirectorSessionError {
  constructor(sessionId: string, details?: AidmErrorDetails) {
    super(`Director session already exists: '${sessionId}'`, 'ERR_DIRECTOR_SESSION_ALREADY_EXISTS', {
      sessionId,
      ...details,
    });
  }
}

export class DirectorProjectBindingMismatchError extends DirectorSessionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_PROJECT_BINDING_MISMATCH', details);
  }
}

export class DirectorInvalidTransitionError extends DirectorSessionError {
  constructor(fromStatus: string, toStatus: string, details?: AidmErrorDetails) {
    super(
      `Invalid Director session lifecycle transition from '${fromStatus}' to '${toStatus}'`,
      'ERR_DIRECTOR_INVALID_TRANSITION',
      { fromStatus, toStatus, ...details }
    );
  }
}

export class DirectorSecurityError extends DirectorSessionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_SECURITY_VIOLATION', details);
  }
}

export class DirectorDecisionError extends DirectorSessionError {
  constructor(message: string, code = 'ERR_DIRECTOR_DECISION', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectorDecisionNotFoundError extends DirectorDecisionError {
  constructor(decisionId: string, details?: AidmErrorDetails) {
    super(`Director decision not found: '${decisionId}'`, 'ERR_DIRECTOR_DECISION_NOT_FOUND', {
      decisionId,
      ...details,
    });
  }
}

export class DirectorDecisionAlreadyExistsError extends DirectorDecisionError {
  constructor(decisionId: string, details?: AidmErrorDetails) {
    super(`Director decision already exists: '${decisionId}'`, 'ERR_DIRECTOR_DECISION_ALREADY_EXISTS', {
      decisionId,
      ...details,
    });
  }
}

export class DirectorContextMismatchError extends DirectorDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_CONTEXT_MISMATCH', details);
  }
}

export class DirectorContextStaleError extends DirectorDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_CONTEXT_STALE', details);
  }
}

export class DirectorContextIncompleteError extends DirectorDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_CONTEXT_INCOMPLETE', details);
  }
}

export class DirectorApprovalRevisionMismatchError extends DirectorDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_APPROVAL_REVISION_MISMATCH', details);
  }
}

export class DirectorUnderstandingRevisionMismatchError extends DirectorDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DIRECTOR_UNDERSTANDING_REVISION_MISMATCH', details);
  }
}

// ============================================================================
// P9-04 HUMAN APPROVAL & RESUME ERRORS
// ============================================================================

export class HumanApprovalError extends AidmError {
  constructor(message: string, code = 'ERR_HUMAN_APPROVAL', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HumanApprovalValidationError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_VALIDATION', details);
  }
}

export class HumanApprovalUnauthorizedActorError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_UNAUTHORIZED_ACTOR', details);
  }
}

export class HumanApprovalProjectBindingMismatchError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_PROJECT_BINDING_MISMATCH', details);
  }
}

export class HumanApprovalContextMismatchError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_CONTEXT_MISMATCH', details);
  }
}

export class HumanApprovalContextStaleError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_CONTEXT_STALE', details);
  }
}

export class HumanApprovalContextIncompleteError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_CONTEXT_INCOMPLETE', details);
  }
}

export class HumanApprovalRevisionMismatchError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_REVISION_MISMATCH', details);
  }
}

export class HumanApprovalReplayError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_APPROVAL_REPLAY', details);
  }
}

export class ResumeUnauthorizedError extends HumanApprovalError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RESUME_UNAUTHORIZED', details);
  }
}

// ============================================================================
// P10-01 EXECUTION INTENT & AUTHORIZATION ERRORS
// ============================================================================

export class ExecutionIntentError extends AidmError {
  constructor(message: string, code = 'ERR_EXECUTION_INTENT', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ExecutionIntentValidationError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_VALIDATION', details);
  }
}

export class ExecutionIntentUnauthorizedError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_UNAUTHORIZED', details);
  }
}

export class ExecutionIntentSessionMismatchError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_SESSION_MISMATCH', details);
  }
}

export class ExecutionIntentProjectMismatchError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_PROJECT_MISMATCH', details);
  }
}

export class ExecutionIntentContextMismatchError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_CONTEXT_MISMATCH', details);
  }
}

export class ExecutionIntentContextStaleError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_CONTEXT_STALE', details);
  }
}

export class ExecutionIntentContextIncompleteError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_CONTEXT_INCOMPLETE', details);
  }
}

export class ExecutionIntentRevisionMismatchError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_REVISION_MISMATCH', details);
  }
}

export class ExecutionIntentTaskInvalidError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_TASK_INVALID', details);
  }
}

export class ExecutionIntentDecisionInvalidError extends ExecutionIntentError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_INTENT_DECISION_INVALID', details);
  }
}

// ============================================================================
// P10-02 EXECUTION REQUEST ERRORS
// ============================================================================

export class ExecutionRequestError extends AidmError {
  constructor(message: string, code = 'ERR_EXECUTION_REQUEST', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ExecutionRequestValidationError extends ExecutionRequestError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_REQUEST_VALIDATION', details);
  }
}

export class ExecutionRequestInvalidPathError extends ExecutionRequestError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_REQUEST_INVALID_PATH', details);
  }
}

export class ExecutionRequestRepositoryForgeryError extends ExecutionRequestError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY', details);
  }
}

export class ExecutionRequestIntentMismatchError extends ExecutionRequestError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_REQUEST_INTENT_MISMATCH', details);
  }
}

export class ExecutionRequestLimitsInvalidError extends ExecutionRequestError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID', details);
  }
}


