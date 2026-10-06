/**
 * @file closed-loop-types.ts
 * @description Types, interfaces, and schemas for the Unified Closed-Loop Coordinator (Phase A4).
 *
 * Implements the domain contracts connecting:
 * Director Context Snapshot
 * ➔ Director Reasoning
 * ➔ Director Action Envelope
 * ➔ Authorization Policy Gate & Mandate
 * ➔ Execution Bridge Pre-checks & Claim
 * ➔ Driver Execution Handoff
 * ➔ Independent Evidence Verification (Zero AGY Trust)
 * ➔ State Integration & Bounded Recovery (Corrective Tasks / Max Attempts).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: AGY self-claims and raw process outputs are never success proof.
 *    Only independently collected SystemExecutionEvidence marks task success.
 * 2. SINGLE CHAT WINDOW: All director steering happens in the single ChatGPT window.
 * 3. FAIL CLOSED BOUNDARY: If human approval or valid mandate is not present, halts cleanly
 *    in BLOCKED_ON_APPROVAL (WAITING_FOR_TRUSTED_IDENTITY) or REJECTED_BY_POLICY.
 * 4. UNKNOWN STATE TERMINATION: Timeouts, aborts, or crashed processes enter EXECUTION_UNKNOWN
 *    and are NEVER automatically re-dispatched without human intervention.
 * 5. BOUNDED RECOVERY: Failures route through RecoveryPolicyEngine and CorrectiveTaskService
 *    within strict max attempts limits. No infinite retry loops.
 */

import { z } from 'zod';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';
import type { DirectorReasoningResult, DirectorDecisionContract } from '../director-reasoning/director-reasoning-types.js';
import type { DirectorActionEnvelope, ActionDispatchResult } from '../director-action/director-action-types.js';
import type { BridgeExecutionResult } from '../execution-bridge/execution-bridge-types.js';
import type { DirectorExecutionCycleResult, DirectorInstruction } from './director-loop-types.js';
import type { SystemExecutionEvidence } from '../evidence/system-execution-evidence.js';
import type { RecoveryPolicyDecision } from '../recovery/recovery-policy-types.js';

// ============================================================================
// 1. CYCLE STATUS & STEPS
// ============================================================================

export type ClosedLoopCycleStatus =
  | 'COMPLETED_SUCCESS'
  | 'BLOCKED_ON_APPROVAL'
  | 'REJECTED_BY_POLICY'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_UNKNOWN'
  | 'CORRECTIVE_TASK_CREATED'
  | 'MAX_ATTEMPTS_EXCEEDED'
  | 'NO_ACTION_REQUIRED';

export type ClosedLoopStep =
  | 'CONTEXT_SYNC'
  | 'REASONING'
  | 'ACTION_PACKAGING'
  | 'POLICY_EVALUATION'
  | 'BRIDGE_EXECUTION'
  | 'DRIVER_EXECUTION'
  | 'EVIDENCE_VERIFICATION'
  | 'STATE_INTEGRATION_RECOVERY';

// ============================================================================
// 2. INPUT CONTRACT
// ============================================================================

export interface ClosedLoopCycleInput {
  /** Target workspace root directory */
  readonly workspaceRoot?: string;
  /** Expected canonical project identifier */
  readonly projectId?: string;
  /** Active Director session identifier */
  readonly directorSessionId?: string;
  /** Optional custom instruction text or pre-constructed DirectorInstruction */
  readonly instruction?: string | DirectorInstruction;
  /** Optional authoritative Director context snapshot */
  readonly contextSnapshot?: DirectorContextSnapshot;
  /** Target task ID to implement/evaluate */
  readonly targetTaskId?: string;
  /** Execution timeout in milliseconds */
  readonly timeoutMs?: number;
  /** Abort signal for graceful cancellation */
  readonly signal?: AbortSignal;
  /** Optional Trusted IDE Authentication context (P18-04) */
  readonly authContext?: unknown;
  /** Actor issuing the cycle, defaults to 'DIRECTOR' */
  readonly actor?: string;
  /** Maximum allowable recovery / corrective task attempts (default: 2) */
  readonly maxRecoveryAttempts?: number;
  /** Optional pre-built DirectorActionEnvelope to bypass reasoning */
  readonly customEnvelope?: DirectorActionEnvelope;
  /** Optional pre-built DirectorDecisionContract */
  readonly customDecision?: DirectorDecisionContract;
  /** Custom idempotency key for the cycle */
  readonly idempotencyKey?: string;
  /** Token budget limit for reasoning step in nano-USD or tokens */
  readonly reasoningBudgetLimit?: number;
}

export const ClosedLoopCycleInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: z.string().optional(),
  instruction: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  contextSnapshot: z.record(z.string(), z.unknown()).optional(),
  targetTaskId: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  authContext: z.unknown().optional(),
  actor: z.string().optional(),
  maxRecoveryAttempts: z.number().int().nonnegative().optional(),
  customEnvelope: z.record(z.string(), z.unknown()).optional(),
  customDecision: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
  reasoningBudgetLimit: z.number().optional(),
});

// ============================================================================
// 3. RESULT CONTRACT
// ============================================================================

export interface ClosedLoopCycleResult {
  /** Deterministic unique cycle identifier */
  readonly cycleId: string;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Bound Director session identifier */
  readonly directorSessionId: string;
  /** Final terminal status of the closed-loop cycle */
  readonly status: ClosedLoopCycleStatus;
  /** Whether the cycle completed successfully */
  readonly isSuccess: boolean;
  /** Human-readable explanation of the outcome */
  readonly summary: string;
  /** Furthest step successfully or terminally reached */
  readonly stepReached: ClosedLoopStep;
  /** Target task ID */
  readonly taskId?: string;
  /** Result from Director reasoning engine (if executed) */
  readonly reasoningResult?: DirectorReasoningResult;
  /** Sealed Director action envelope (if built) */
  readonly actionEnvelope?: DirectorActionEnvelope;
  /** Result from policy gate & dispatcher (if dispatched) */
  readonly dispatchResult?: ActionDispatchResult;
  /** Result from execution bridge (if bridge executed) */
  readonly bridgeResult?: BridgeExecutionResult;
  /** Underlying Director execution cycle result (if driver ran) */
  readonly cycleResult?: DirectorExecutionCycleResult;
  /** Sole authoritative evidence independently collected */
  readonly systemEvidence?: SystemExecutionEvidence;
  /** Recovery policy decision (if recovery was evaluated) */
  readonly recoveryDecision?: RecoveryPolicyDecision;
  /** Created corrective task ID (if corrective task was generated) */
  readonly correctiveTaskId?: string;
  /** Whether human decision is required to proceed */
  readonly humanDecisionRequired: boolean;
  /** Specific human decision point metadata if blocked */
  readonly humanDecisionPoint?: unknown;
  /** Timestamp when cycle completed */
  readonly completedAt: string;
}
