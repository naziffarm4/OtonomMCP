import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import type { RiskLevel } from '../risk.js';

export interface PolicyViolationDetails extends AidmErrorDetails {
  operation?: string;
  target?: string;
  riskLevel?: RiskLevel;
  policyRule?: string;
  suggestedAction?: 'REQUIRE_HUMAN' | 'BLOCK' | 'DENY';
}

/**
 * Thrown when an action or command violates AIDM Policy rules.
 * Distinct error code: ERR_POLICY_VIOLATION
 */
export class PolicyViolationError extends AidmError {
  readonly operation?: string;
  readonly riskLevel?: RiskLevel;

  constructor(
    message: string,
    details?: PolicyViolationDetails,
    code = 'ERR_POLICY_VIOLATION'
  ) {
    super(message, code, details);
    this.operation = details?.operation;
    this.riskLevel = details?.riskLevel;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
