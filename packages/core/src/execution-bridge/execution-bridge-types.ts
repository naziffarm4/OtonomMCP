/**
 * @file execution-bridge-types.ts
 * @description Strongly-typed domain models, protocol constants, and schemas
 * for the Execution Bridge & Safe Driver Handoff (Phase 20 TASK-P20-01).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. SINGLE EXECUTION CLAIM: An ExecutionIntent can be claimed and executed AT MOST ONCE.
 * 2. ZERO EXECUTOR TRUST: Neither AGY process exit nor AGY self-claims constitute success proof.
 *    Only independent SystemExecutionEvidence can declare success.
 * 3. FAIL-CLOSED PRE-EXECUTION CHECKS: All 9 mandatory pre-execution checks must pass
 *    before handing off to DriverEngine/DriverRuntime.
 * 4. STRICT UNKNOWN-STATE SAFETY: Any in-flight process crash, timeout, or ambiguity enters
 *    EXECUTION_UNKNOWN and is NEVER automatically re-dispatched to AGY.
 * 5. IMMUTABLE CONTRACTS: Model or client cannot mutate ExecutionIntent fields post-creation.
 * 6. NO NEW DRIVER/DAG/EVIDENCE ENGINES: Reuses existing DriverEngine, TaskDagEngine,
 *    SpecStore, HistoryManager, and SystemEvidenceCollector.
 */

import { z } from 'zod';
import type { Actor } from '../actors.js';
import type { DirectorExecutionCycleResult } from '../director-loop/director-loop-types.js';
import type { SystemExecutionEvidence } from '../evidence/system-execution-evidence.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const EXECUTION_BRIDGE_PROTOCOL_VERSION = 'P20-01';
export const EXECUTION_BRIDGE_SCHEMA_VERSION = 1;

/**
 * Execution Bridge Intent Lifecycle States.
 */
export const ExecutionBridgeStatus = {
  AUTHORIZED_PENDING_EXECUTION: 'AUTHORIZED_PENDING_EXECUTION',
  EXECUTION_CLAIMED: 'EXECUTION_CLAIMED',
  EXECUTION_STARTED: 'EXECUTION_STARTED',
  EXECUTION_SUCCEEDED: 'EXECUTION_SUCCEEDED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  EXECUTION_UNKNOWN: 'EXECUTION_UNKNOWN',
  EXECUTION_CANCELLED: 'EXECUTION_CANCELLED',
} as const;

export type ExecutionBridgeStatus =
  (typeof ExecutionBridgeStatus)[keyof typeof ExecutionBridgeStatus];

export const EXECUTION_BRIDGE_STATUSES = Object.values(
  ExecutionBridgeStatus
) as readonly ExecutionBridgeStatus[];

// ============================================================================
// 2. AUTHORIZATION REFERENCE SCHEMA
// ============================================================================

export const AuthorizationReferenceZodSchema = z
  .object({
    packageId: z.string().optional(),
    packageRevision: z.number().int().positive('packageRevision must be positive'),
    isDevelopmentAuthorized: z.boolean(),
    authorizedAt: z.string().optional(),
    authorizedByRole: z.enum(['PRODUCT_OWNER', 'USER']).optional(),
    authContext: z
      .object({
        verified: z.boolean(),
        authSource: z.string().optional(),
        token: z.string().optional(),
        actorId: z.string().optional(),
        verifiedAt: z.string().optional(),
        signature: z.string().optional(),
        projectId: z.string().optional(),
        sessionId: z.string().optional(),
        taskId: z.string().optional(),
        expiresAt: z.string().optional(),
        nonce: z.string().optional(),
        isForged: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export type AuthorizationReference = z.infer<typeof AuthorizationReferenceZodSchema>;

// ============================================================================
// 3. BRIDGE EXECUTION INTENT SCHEMA
// ============================================================================

export const BridgeExecutionIntentZodSchema = z
  .object({
    executionIntentId: z.string().min(1, 'executionIntentId is required'),
    actionId: z.string().min(1, 'actionId is required'),
    idempotencyKey: z.string().min(1, 'idempotencyKey is required'),
    projectId: z.string().min(1, 'projectId is required'),
    directorSessionId: z.string().min(1, 'directorSessionId is required'),
    taskId: z.string().min(1, 'taskId is required'),
    taskRevision: z.number().int().positive().optional().default(1),
    basedOnContextFingerprint: z.string().min(1, 'basedOnContextFingerprint is required'),
    understandingRevision: z.number().int().positive('understandingRevision must be positive'),
    authorizationReference: AuthorizationReferenceZodSchema,
    createdAt: z.string().min(1, 'createdAt timestamp is required'),
    executionPlan: z.string().min(1, 'executionPlan is required'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type BridgeExecutionIntent = Readonly<z.infer<typeof BridgeExecutionIntentZodSchema>>;

/**
 * Creates an immutable, deep-frozen BridgeExecutionIntent instance.
 */
export function createFrozenBridgeExecutionIntent(
  raw: BridgeExecutionIntent
): BridgeExecutionIntent {
  const parsed = BridgeExecutionIntentZodSchema.parse(raw);
  return Object.freeze({
    ...parsed,
    authorizationReference: Object.freeze({ ...parsed.authorizationReference }),
    metadata: parsed.metadata ? Object.freeze({ ...parsed.metadata }) : undefined,
  });
}

// ============================================================================
// 4. PRE-EXECUTION VALIDATION CONTRACTS
// ============================================================================

export interface PreExecutionCheckDetail {
  readonly checkName: string;
  readonly passed: boolean;
  readonly reason: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}

export interface PreExecutionValidationResult {
  readonly isValid: boolean;
  readonly failedChecks: readonly PreExecutionCheckDetail[];
  readonly allChecks: readonly PreExecutionCheckDetail[];
  readonly reason: string;
}

// ============================================================================
// 5. BRIDGE CLAIM & EXECUTION RESULT CONTRACTS
// ============================================================================

export interface ClaimedIntentRecord {
  readonly executionIntentId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly taskId: string;
  readonly status: ExecutionBridgeStatus;
  readonly claimedAt: string;
  readonly processId: number;
  readonly budgetReservationId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly terminalReason?: string;
}

export interface BridgeExecutionResult {
  readonly executionIntentId: string;
  readonly actionId: string;
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly taskId: string;
  readonly status: ExecutionBridgeStatus;
  readonly isSuccess: boolean;
  readonly reason: string;
  readonly code?: string;
  readonly cycleResult?: DirectorExecutionCycleResult;
  readonly systemEvidence?: SystemExecutionEvidence;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly budgetReservationId?: string;
  readonly requiresHumanDecision?: boolean;
}

export interface BridgeExecutionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly skipBudgetReservation?: boolean;
  readonly requireTrustedAuthContext?: boolean;
  readonly authContext?: {
    readonly verified: boolean;
    readonly authSource?: string;
    readonly token?: string;
    readonly actorId?: string;
    readonly verifiedAt?: string;
  };
}
