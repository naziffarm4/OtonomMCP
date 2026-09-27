/**
 * Bounded Task Retry Authorization Types (Phase 13 TASK-P13-02)
 *
 * Defines the authoritative, strongly-typed contracts for authorizing and
 * persisting bounded task retry state transitions.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. STRICT DECISIONS: Only RecoveryPolicyDecision with strategy 'RETRY' and retryAllowed: true can be authorized.
 * 2. ZERO EXECUTOR TRUST: Rejects raw executor outcomes and caller-fabricated verification flags.
 * 3. STRICT BOUNDS: Task attempt must be strictly less than max_attempts.
 * 4. ATOMIC TRANSITION: Increments attempt exactly once, moves status to READY.
 * 5. PRESERVES IDENTITY: Task ID, taskRevision, contextFingerprint, approvalPackageRevision,
 *    acceptance criteria, dependencies, and scope remain unchanged.
 * 6. IDEMPOTENT: Retrying with the same evidence/decision returns idempotent outcome without double increment.
 * 7. NO EXECUTION: Does not invoke Antigravity or create ExecutionIntent / ExecutionRequest.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import type { TaskDefinition, TaskStatus } from '../task-engine/task-types.js';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
} from '../evidence/system-execution-evidence.js';
import {
  type RecoveryPolicyDecision,
  RecoveryPolicyDecisionZodSchema,
  RecoveryStrategy,
} from './recovery-policy-types.js';
import type { FailureCategory } from './failure-diagnosis-types.js';

// ============================================================================
// 1. RETRY AUTHORIZATION INPUT CONTRACT
// ============================================================================

export interface RetryAuthorizationInput {
  /** Authoritative SystemExecutionEvidence verifying the failure */
  readonly evidence: unknown;
  /** Authoritative RecoveryPolicyDecision from P13-01 */
  readonly decision?: unknown;
  /** Optional canonical project identifier for cross-project safety check */
  readonly expectedProjectId?: string;
  /** Optional active Director session identifier */
  readonly directorSessionId?: string;
  /** Optional context fingerprint assertion */
  readonly contextFingerprint?: string;
  /** Optional understanding revision assertion */
  readonly understandingRevision?: number;
  /** Optional approval package revision assertion */
  readonly approvalPackageRevision?: number;
  /** Optional workspace root directory */
  readonly workspaceRoot?: string;
}

export const RetryAuthorizationInputZodSchema = z.object({
  evidence: z.unknown(),
  decision: z.unknown().optional(),
  expectedProjectId: z.string().min(1).optional(),
  directorSessionId: z.string().min(1).optional(),
  contextFingerprint: z.string().min(1).optional(),
  understandingRevision: z.number().int().positive().optional(),
  approvalPackageRevision: z.number().int().positive().optional(),
  workspaceRoot: z.string().min(1).optional(),
});

// ============================================================================
// 2. RETRY RECORD PERSISTED IN DURABLE STATE METADATA
// ============================================================================

export interface RetryTransitionRecord {
  /** Deterministic retry key derived from evidence and attempt */
  readonly retryKey: string;
  /** Project identifier */
  readonly projectId: string;
  /** Task identifier */
  readonly taskId: string;
  /** Authoritative task revision (unchanged) */
  readonly taskRevision: number;
  /** Previous attempt count */
  readonly previousAttempt: number;
  /** New incremented attempt count */
  readonly newAttempt: number;
  /** Maximum retry attempts (unchanged) */
  readonly maxAttempts: number;
  /** Failure category from diagnosis */
  readonly failureCategory: FailureCategory;
  /** Recovery strategy (RETRY) */
  readonly recoveryStrategy: typeof RecoveryStrategy.RETRY;
  /** Evidence identifier */
  readonly evidenceId: string;
  /** Request identifier */
  readonly requestId: string;
  /** Resulting task status (READY) */
  readonly taskStatus: TaskStatus;
  /** ISO timestamp when retry was authorized */
  readonly authorizedAt: string;
  /** Associated history event identifier */
  readonly historyEventId?: string;
}

// ============================================================================
// 3. RETRY AUTHORIZATION OUTCOME
// ============================================================================

export interface RetryAuthorizationOutcome {
  /** Whether the retry authorization and transition succeeded */
  readonly success: boolean;
  /** Deterministic retry key */
  readonly retryKey: string;
  /** Project identifier */
  readonly projectId: string;
  /** Task identifier */
  readonly taskId: string;
  /** Authoritative task revision */
  readonly taskRevision: number;
  /** Previous attempt count */
  readonly previousAttempt: number;
  /** New authoritative attempt count */
  readonly newAttempt: number;
  /** Maximum allowed attempts */
  readonly maxAttempts: number;
  /** Remaining retry attempts after this transition */
  readonly remainingAttempts: number;
  /** Resulting authoritative task status */
  readonly taskStatus: TaskStatus;
  /** Whether this call was a duplicate/idempotent execution */
  readonly isDuplicate: boolean;
  /** Evidence ID bound to this retry */
  readonly evidenceId: string;
  /** Associated history event ID */
  readonly historyEventId?: string;
  /** Descriptive message */
  readonly message: string;
  /** The updated task definition in SpecStore */
  readonly task?: TaskDefinition;
}

// ============================================================================
// 4. DETERMINISTIC RETRY KEY COMPUTATION
// ============================================================================

export interface RetryKeyComponents {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly evidenceId: string;
}

/**
 * Computes deterministic retry idempotency key:
 * retry-<sha256(projectId:taskId:taskRevision:evidenceId)[:16]>
 */
export function computeDeterministicRetryKey(components: RetryKeyComponents): string {
  const raw = `${components.projectId}:${components.taskId}:${components.taskRevision}:${components.evidenceId}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
  return `retry-${hash}`;
}

/**
 * Computes deterministic history event ID for retry transition.
 */
export function computeDeterministicRetryEventId(retryKey: string): string {
  const hash = crypto.createHash('sha256').update(`${retryKey}:TASK_RETRY_AUTHORIZED`, 'utf8').digest('hex').substring(0, 16);
  return `evt-retry-${hash}`;
}
