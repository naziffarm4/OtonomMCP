/**
 * Recovery Policy Domain Types (Phase 13 TASK-P13-01)
 *
 * Defines the strongly typed policy decisions and evaluation options.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. STRICT DECISIONS: Strategy is strictly one of 'RETRY' | 'REPLAN' | 'BLOCK_ON_HUMAN' | 'ABORT'.
 * 2. NO DIRECT EXECUTION: Decisions represent authorized strategies, not execution triggers.
 * 3. IMMUTABILITY: Decisions are frozen, deterministic records.
 */

import { z } from 'zod';
import {
  FailureCategory,
  FAILURE_CATEGORIES,
  type FailureDiagnosis,
} from './failure-diagnosis-types.js';

// ============================================================================
// 1. RECOVERY POLICY STRATEGY ENUM
// ============================================================================

export const RecoveryStrategy = {
  RETRY: 'RETRY',
  REPLAN: 'REPLAN',
  BLOCK_ON_HUMAN: 'BLOCK_ON_HUMAN',
  ABORT: 'ABORT',
} as const;

export type RecoveryStrategy = (typeof RecoveryStrategy)[keyof typeof RecoveryStrategy];

export const RECOVERY_STRATEGIES = Object.values(RecoveryStrategy) as readonly RecoveryStrategy[];

export function isRecoveryStrategy(value: unknown): value is RecoveryStrategy {
  return typeof value === 'string' && (RECOVERY_STRATEGIES as readonly string[]).includes(value);
}

// ============================================================================
// 2. RECOVERY POLICY DECISION CONTRACT
// ============================================================================

export interface RecoveryPolicyDecision {
  /** The authorized recovery strategy */
  readonly decision: RecoveryStrategy;
  /** Primary classified failure category */
  readonly failureCategory: FailureCategory;
  /** Whether retry is legally allowed under policy and budget */
  readonly retryAllowed: boolean;
  /** Whether replanning is legally allowed under policy */
  readonly replanAllowed: boolean;
  /** Whether human intervention is required */
  readonly humanRequired: boolean;
  /** Current attempt from authoritative task state */
  readonly attempt: number;
  /** Maximum retry attempts from authoritative task state */
  readonly maxAttempts: number;
  /** Preserved project identifier */
  readonly projectId: string;
  /** Preserved task identifier */
  readonly taskId: string;
  /** Preserved task revision */
  readonly taskRevision: number;
  /** Traceable evidence ID that produced this evaluation */
  readonly evidenceId: string;
  /** Deterministic reason codes justifying the decision */
  readonly reasonCodes: readonly string[];
  /** Detailed human-readable justification */
  readonly justification: string;
  /** Full failure diagnosis report */
  readonly diagnosis: FailureDiagnosis;
}

// ============================================================================
// 3. ZOD SCHEMA
// ============================================================================

export const RecoveryPolicyDecisionZodSchema = z.object({
  decision: z.enum(RECOVERY_STRATEGIES as [string, ...string[]]),
  failureCategory: z.enum(FAILURE_CATEGORIES as [string, ...string[]]),
  retryAllowed: z.boolean(),
  replanAllowed: z.boolean(),
  humanRequired: z.boolean(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  evidenceId: z.string().min(1),
  reasonCodes: z.array(z.string()),
  justification: z.string().min(1),
});
