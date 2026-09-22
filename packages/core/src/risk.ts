/**
 * AIDM Security and Risk Classification Levels.
 * 
 * Used by the AIDM Policy Engine to classify operations:
 * - SAFE: Read-only, status checks, non-mutating operations (auto-approved)
 * - CAUTION: Normal source code modifications, standard test runs (auto-approved within workspace)
 * - DANGEROUS: Configuration changes, package installations, DB migrations (policy-restricted)
 * - CRITICAL: Destructive operations, outside-workspace access, secrets exfiltration (REQUIRES HUMAN)
 */

export const RiskLevel = {
  SAFE: 'SAFE',
  CAUTION: 'CAUTION',
  DANGEROUS: 'DANGEROUS',
  CRITICAL: 'CRITICAL',
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RISK_LEVELS = Object.values(RiskLevel) as readonly RiskLevel[];

export const SAFE = RiskLevel.SAFE;
export const CAUTION = RiskLevel.CAUTION;
export const DANGEROUS = RiskLevel.DANGEROUS;
export const CRITICAL = RiskLevel.CRITICAL;

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}
