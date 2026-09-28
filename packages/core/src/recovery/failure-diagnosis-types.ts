/**
 * Failure Diagnosis Domain Types (Phase 13 TASK-P13-01)
 *
 * Defines the strongly typed domain model for diagnosing verified execution failures
 * and evaluating deterministic recovery strategies.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO TRUST IN EXECUTOR: Only independently verified SystemExecutionEvidence is diagnosed.
 * 2. DETERMINISTIC TAXONOMY: Explicit failure categories derived strictly from verified checks and repository facts.
 * 3. NO EXECUTION / NO MUTATION: Pure diagnosis data structures.
 */

import { z } from 'zod';
import type { VerificationCheck } from '../evidence/system-execution-evidence.js';

// ============================================================================
// 1. FAILURE CATEGORY TAXONOMY
// ============================================================================

export const FailureCategory = {
  SECURITY_VIOLATION: 'SECURITY_VIOLATION',
  STALE_BINDING: 'STALE_BINDING',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  INFRASTRUCTURE_FAILURE: 'INFRASTRUCTURE_FAILURE',
  TIMEOUT: 'TIMEOUT',
  BUILD_FAILURE: 'BUILD_FAILURE',
  TYPECHECK_FAILURE: 'TYPECHECK_FAILURE',
  TEST_FAILURE: 'TEST_FAILURE',
  LINT_FAILURE: 'LINT_FAILURE',
  ACCEPTANCE_CRITERIA_FAILURE: 'ACCEPTANCE_CRITERIA_FAILURE',
  EXECUTOR_FAILURE: 'EXECUTOR_FAILURE',
  UNKNOWN: 'UNKNOWN',

  // P14-04 Execution Failure Categories
  EXECUTOR_START_FAILURE: 'EXECUTOR_START_FAILURE',
  EXECUTOR_PROTOCOL_FAILURE: 'EXECUTOR_PROTOCOL_FAILURE',
  EXECUTOR_TIMEOUT: 'EXECUTOR_TIMEOUT',
  EXECUTOR_CANCELLED: 'EXECUTOR_CANCELLED',
  EXECUTOR_EXIT_FAILURE: 'EXECUTOR_EXIT_FAILURE',
  EXECUTOR_OUTPUT_FAILURE: 'EXECUTOR_OUTPUT_FAILURE',
  VERIFICATION_FAILURE: 'VERIFICATION_FAILURE',
  INFRASTRUCTURE_BLOCK: 'INFRASTRUCTURE_BLOCK',
  SECURITY_FAILURE: 'SECURITY_FAILURE',
} as const;

export type FailureCategory = (typeof FailureCategory)[keyof typeof FailureCategory];

export const FAILURE_CATEGORIES = Object.values(FailureCategory) as readonly FailureCategory[];

export function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

// ============================================================================
// 2. FAILURE SEVERITY TAXONOMY
// ============================================================================

export const FailureSeverity = {
  FATAL: 'FATAL',
  CRITICAL: 'CRITICAL',
  RETRYABLE: 'RETRYABLE',
  STRUCTURAL: 'STRUCTURAL',
} as const;

export type FailureSeverity = (typeof FailureSeverity)[keyof typeof FailureSeverity];

export const FAILURE_SEVERITIES = Object.values(FailureSeverity) as readonly FailureSeverity[];

export function isFailureSeverity(value: unknown): value is FailureSeverity {
  return typeof value === 'string' && (FAILURE_SEVERITIES as readonly string[]).includes(value);
}

// ============================================================================
// 3. FAILURE DIAGNOSIS ITEM & REPORT
// ============================================================================

export interface FailureDiagnosisItem {
  readonly checkId?: string;
  readonly category: FailureCategory;
  readonly severity: FailureSeverity;
  readonly message: string;
  readonly details?: unknown;
}

export interface FailureDiagnosis {
  readonly isFailure: boolean;
  readonly primaryCategory: FailureCategory;
  readonly primarySeverity: FailureSeverity;
  readonly isRetryable: boolean;
  readonly isReplannable: boolean;
  readonly requiresHuman: boolean;
  readonly issues: readonly FailureDiagnosisItem[];
  readonly rootCauses: readonly string[];
  readonly summary: string;
}

// ============================================================================
// 4. ZOD SCHEMAS FOR RUNTIME VALIDATION
// ============================================================================

export const FailureDiagnosisItemZodSchema = z.object({
  checkId: z.string().optional(),
  category: z.enum(FAILURE_CATEGORIES as [string, ...string[]]),
  severity: z.enum(FAILURE_SEVERITIES as [string, ...string[]]),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

export const FailureDiagnosisZodSchema = z.object({
  isFailure: z.boolean(),
  primaryCategory: z.enum(FAILURE_CATEGORIES as [string, ...string[]]),
  primarySeverity: z.enum(FAILURE_SEVERITIES as [string, ...string[]]),
  isRetryable: z.boolean(),
  isReplannable: z.boolean(),
  requiresHuman: z.boolean(),
  issues: z.array(FailureDiagnosisItemZodSchema),
  rootCauses: z.array(z.string()),
  summary: z.string(),
});
