/**
 * Risk & Human Decision Points Errors (Phase 15 TASK-P15-07)
 *
 * Defines domain-specific error classes for the Risk & Human Decision Points subsystem.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class RiskHumanDecisionError extends AidmError {
  constructor(message: string, code = 'ERR_RISK_HUMAN_DECISION', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class RiskValidationError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_VALIDATION', details);
  }
}

export class RiskRevisionNotFoundError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_REVISION_NOT_FOUND', details);
  }
}

export class RiskProjectBindingMismatchError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_PROJECT_BINDING_MISMATCH', details);
  }
}

export class RiskImmutableRevisionError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_IMMUTABLE_REVISION', details);
  }
}

export class RiskStaleSourceError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_STALE_SOURCE', details);
  }
}

export class RiskForgedFingerprintError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_FORGED_FINGERPRINT', details);
  }
}

export class RiskTraceabilityError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_TRACEABILITY', details);
  }
}

export class RiskSeverityMismatchError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_SEVERITY_MISMATCH', details);
  }
}

export class HumanDecisionAuthorityError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_HUMAN_DECISION_AUTHORITY', details);
  }
}

export class RiskDependencyError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_DEPENDENCY', details);
  }
}

export class RiskStorageError extends RiskHumanDecisionError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RISK_STORAGE', details);
  }
}
