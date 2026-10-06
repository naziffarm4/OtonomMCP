/**
 * Autonomous Driver Protocol & State Types (Phase 17 TASK-P17-01)
 *
 * Establishes the authoritative domain types for the durable, controllable Driver Runtime.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. SEPARATION OF CONCERNS: Driver Engine (orchestration policy) is strictly separated
 *    from Driver Runtime (process lifecycle, lock, start/pause/resume/stop/recovery).
 * 2. REUSE P16: The Driver coordinates the existing Director ↔ Executor Loop (P16);
 *    it does NOT implement a secondary execution pipeline.
 * 3. ZERO EXECUTOR TRUST: Raw executor output is never proof; only SystemExecutionEvidence is proof.
 * 4. GOVERNED CONTINUATION: Automatic continuation requires fresh validation of development
 *    authorization, task revision, dependencies, scope, and no blocking human decisions.
 * 5. SINGLE ACTIVE DRIVER: Only one active driver may run per project at any given time.
 * 6. FAIL CLOSED: Any stale, inconsistent, or unauthorized state halts the driver immediately.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import type {
  DirectorInstruction,
  DirectorExecutionCycleResult,
  DirectorNextActionBoundary,
} from '../director-loop/director-loop-types.js';
import type { RecoveryPolicyDecision } from '../recovery/recovery-policy-types.js';
import type { RetryAuthorizationOutcome } from '../recovery/retry-authorization-types.js';

// ============================================================================
// 1. LIFECYCLE & CONTINUATION CONSTANTS
// ============================================================================

export const DRIVER_PROTOCOL_VERSION = 'P17-01';
export const DRIVER_SCHEMA_VERSION = 1;

export const DriverLifecycleState = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  PAUSING: 'PAUSING',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
  RECOVERING: 'RECOVERING',
} as const;

export type DriverLifecycleState =
  (typeof DriverLifecycleState)[keyof typeof DriverLifecycleState];

export const DRIVER_LIFECYCLE_STATES = Object.values(
  DriverLifecycleState
) as readonly DriverLifecycleState[];

export const DriverContinuationState = {
  NONE: 'NONE',
  CONTINUING: 'CONTINUING',
  WAITING_HUMAN: 'WAITING_HUMAN',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
} as const;

export type DriverContinuationState =
  (typeof DriverContinuationState)[keyof typeof DriverContinuationState];

export const DRIVER_CONTINUATION_STATES = Object.values(
  DriverContinuationState
) as readonly DriverContinuationState[];

export const DriverContinuationPolicy = {
  GOVERNED_AUTONOMOUS: 'GOVERNED_AUTONOMOUS',
  CONTROLLED_MANUAL: 'CONTROLLED_MANUAL',
} as const;

export type DriverContinuationPolicy =
  (typeof DriverContinuationPolicy)[keyof typeof DriverContinuationPolicy];

export const DRIVER_CONTINUATION_POLICIES = Object.values(
  DriverContinuationPolicy
) as readonly DriverContinuationPolicy[];

// ============================================================================
// 2. DETERMINISTIC IDENTIFIER GENERATION
// ============================================================================

/**
 * Computes deterministic driverId: driver-<sha256(projectId:seed)[:16]>
 */
export function computeDeterministicDriverId(projectId: string, seed = 'default'): string {
  const raw = `${projectId}:${seed}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
  return `driver-${hash}`;
}

// ============================================================================
// 3. LOCK & LEASE CONTRACTS
// ============================================================================

export interface DriverLockInfo {
  readonly lockId: string;
  readonly driverId: string;
  readonly projectId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly pid: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const DriverLockInfoZodSchema = z.object({
  lockId: z.string().min(1),
  driverId: z.string().min(1),
  projectId: z.string().min(1),
  acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  pid: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// 4. DURABLE DRIVER STATE
// ============================================================================

export interface DriverInFlightCycle {
  readonly instructionId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly startedAt: string;
}

export interface DriverHumanDecisionPoint {
  readonly decisionId: string;
  readonly category: string;
  readonly description: string;
  readonly reason: string;
  readonly blockedState?: unknown;
}

export interface DriverRecoveryInfo {
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly lastStrategy?: string;
  readonly replanCount?: number;
  readonly lastError?: string;
}

export interface DurableDriverState {
  readonly schemaVersion: number;
  readonly driverId: string;
  readonly projectId: string;
  readonly directorSessionId?: string;
  readonly lifecycleState: DriverLifecycleState;
  readonly currentTaskId?: string | null;
  readonly currentIteration: number;
  readonly lastCompletedCycleId?: string | null;
  readonly lastInstructionId?: string | null;
  readonly lastEvidenceId?: string | null;
  readonly lastExecutionRequestId?: string | null;
  readonly lastTerminalStatus?: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'EXECUTION_UNKNOWN' | null;
  readonly continuationState: DriverContinuationState;
  readonly continuationPolicy: DriverContinuationPolicy;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
  readonly failureReason?: string | null;
  readonly blockReason?: string | null;
  readonly humanDecisionPoint?: DriverHumanDecisionPoint | null;
  readonly recoveryInfo?: DriverRecoveryInfo | null;
  readonly inFlightCycle?: DriverInFlightCycle | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const DriverInFlightCycleZodSchema = z.object({
  instructionId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
});

export const DriverHumanDecisionPointZodSchema = z.object({
  decisionId: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1),
  reason: z.string().min(1),
  blockedState: z.unknown().optional(),
});

export const DriverRecoveryInfoZodSchema = z.object({
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  lastStrategy: z.string().optional(),
  replanCount: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
});

export const DurableDriverStateZodSchema = z.object({
  schemaVersion: z.number().int().positive(),
  driverId: z.string().min(1),
  projectId: z.string().min(1),
  directorSessionId: z.string().optional(),
  lifecycleState: z.enum(DRIVER_LIFECYCLE_STATES as [string, ...string[]]),
  currentTaskId: z.string().nullable().optional(),
  currentIteration: z.number().int().nonnegative(),
  lastCompletedCycleId: z.string().nullable().optional(),
  lastInstructionId: z.string().nullable().optional(),
  lastEvidenceId: z.string().nullable().optional(),
  lastExecutionRequestId: z.string().nullable().optional(),
  lastTerminalStatus: z.enum(['ACCEPTED', 'REJECTED', 'BLOCKED', 'EXECUTION_UNKNOWN']).nullable().optional(),
  continuationState: z.enum(DRIVER_CONTINUATION_STATES as [string, ...string[]]),
  continuationPolicy: z.enum(DRIVER_CONTINUATION_POLICIES as [string, ...string[]]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  blockReason: z.string().nullable().optional(),
  humanDecisionPoint: DriverHumanDecisionPointZodSchema.nullable().optional(),
  recoveryInfo: DriverRecoveryInfoZodSchema.nullable().optional(),
  inFlightCycle: DriverInFlightCycleZodSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// 5. DRIVER ITERATION & ENGINE CONTRACTS
// ============================================================================

export type DriverIterationDecision =
  | 'CONTINUE'
  | 'PAUSE'
  | 'STOP'
  | 'HUMAN_DECISION_REQUIRED'
  | 'FAILED';

export interface DriverIterationResult {
  readonly iteration: number;
  readonly taskId: string;
  readonly instructionId: string;
  readonly cycleResult: DirectorExecutionCycleResult;
  readonly nextAction: DirectorNextActionBoundary;
  readonly decision: DriverIterationDecision;
  readonly reason: string;
  readonly recoveryDecision?: RecoveryPolicyDecision;
  readonly retryAuthorization?: RetryAuthorizationOutcome;
}

export interface DriverRunIterationInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly targetTaskId?: string;
  readonly iterationNumber: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DriverContinuationValidationResult {
  readonly isAllowed: boolean;
  readonly reason: string;
  readonly nextTaskId?: string;
  readonly requiresHumanDecision: boolean;
  readonly humanDecisionPoint?: DriverHumanDecisionPoint;
}
