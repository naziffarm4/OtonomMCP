/**
 * Recovery Policy Errors (Phase 13 TASK-P13-01)
 *
 * Defines deterministic, typed errors for the Recovery Policy boundary.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class RecoveryPolicyError extends AidmError {
  constructor(message: string, code = 'ERR_RECOVERY_POLICY', details?: AidmErrorDetails) {
    super(message, code, details);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RecoveryPolicyValidationError extends RecoveryPolicyError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RECOVERY_POLICY_VALIDATION', details);
  }
}

export class RecoveryPolicySecurityViolationError extends RecoveryPolicyError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RECOVERY_POLICY_SECURITY_VIOLATION', details);
  }
}

export class RecoveryPolicyBindingMismatchError extends RecoveryPolicyError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_RECOVERY_POLICY_BINDING_MISMATCH', details);
  }
}
