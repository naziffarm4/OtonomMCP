/**
 * Raw Executor Outcome Contract & Guard (Phase 10 TASK-P10-03)
 *
 * Defines the strongly typed raw outcome produced by the Antigravity Executor Adapter.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. UNVERIFIED RAW OUTCOME: RawExecutorOutcome is NOT SystemVerifiedEvidence.
 *    It represents executor claims only and cannot be confused with authoritative system evidence.
 * 2. NO FABRICATED VERIFICATION: Must NEVER contain fields implying system verification
 *    (e.g., verified, qaPassed, systemAccepted, taskCompleted).
 * 3. REQUEST BINDING PRESERVATION: Preserves requestId, projectId, taskId, taskRevision,
 *    contextFingerprint, understandingRevision, approvalPackageRevision immutably.
 * 4. FINITE STATUS TAXONOMY: Explicitly bounded status: SUCCESS, FAILURE, TIMEOUT, CANCELLED, ERROR.
 * 5. COMPATIBILITY: Preserves legacy Phase 3 raw outcome fields for seamless interop.
 */

import { z } from 'zod';
import type { ExecutionRequest } from './execution-request-types.js';
import { ExecutorSecurityViolationError } from '../director/director-errors.js';

// ============================================================================
// 1. TYPES & STATUS ENUM
// ============================================================================

export type RawExecutorStatus = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'CANCELLED' | 'ERROR';

export const RAW_EXECUTOR_STATUSES: readonly RawExecutorStatus[] = Object.freeze([
  'SUCCESS',
  'FAILURE',
  'TIMEOUT',
  'CANCELLED',
  'ERROR',
]);

export interface RawExecutorIdentity {
  readonly provider: string;
  readonly name: string;
  readonly version?: string | null;
}

export interface RawRequestBinding {
  readonly requestId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly contextFingerprint: string;
  readonly understandingRevision: number;
  readonly approvalPackageRevision: number;
}

export interface RawExecutorOutcome {
  /** Preserved exact requestId from ExecutionRequest */
  readonly requestId: string;
  /** Identity of the executor that executed or attempted execution */
  readonly executorIdentity: RawExecutorIdentity;
  /** Bounded execution status */
  readonly status: RawExecutorStatus;
  /** Process exit code (null if aborted or non-process execution) */
  readonly exitCode: number | null;
  /** OS signal if process was terminated (e.g. SIGTERM, SIGKILL) */
  readonly signal: string | null;
  /** Raw standard output captured from executor */
  readonly stdout: string | null;
  /** Raw standard error captured from executor */
  readonly stderr: string | null;
  /** ISO 8601 timestamp when executor was invoked */
  readonly startedAt: string;
  /** ISO 8601 timestamp when executor completed or aborted */
  readonly completedAt: string;
  /** Wall clock duration of execution in milliseconds */
  readonly durationMs: number;
  /** Flag indicating execution exceeded timeout limits */
  readonly timedOut: boolean;
  /** Flag indicating execution was cancelled via AbortSignal */
  readonly cancelled: boolean;
  /** Immutable binding linking outcome back to the authorizing ExecutionRequest */
  readonly requestBinding: RawRequestBinding;
  /** Unverified claims reported by the executor (NOT system evidence) */
  readonly unverifiedAgentClaims: readonly string[];
  /** Unverified modified files reported by the executor (NOT verified git diff) */
  readonly unverifiedModifiedFiles: readonly string[];
  /** Optional sanitized executor metadata */
  readonly executorMetadata?: Readonly<Record<string, unknown>>;
  /** Structured error information if execution failed or errored */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  } | null;

  // Compatibility fields for legacy Phase 3 callers
  readonly executor_id?: string;
  readonly command?: string | null;
  readonly exit_code?: number | null;
  readonly raw_payload?: unknown;
  readonly agent_claims?: readonly string[] | null;
  readonly unverified_changed_files?: readonly string[] | null;
  readonly timing?: {
    readonly started_at?: string | null;
    readonly completed_at?: string | null;
    readonly duration_ms?: number | null;
  } | null;
}

// ============================================================================
// 2. FORBIDDEN VERIFICATION FIELDS GUARD
// ============================================================================

export const FORBIDDEN_VERIFICATION_FIELDS = Object.freeze([
  'verified',
  'qaPassed',
  'systemAccepted',
  'taskCompleted',
  'systemVerifiedEvidence',
  'isVerified',
  'systemApproved',
]);

/**
 * Asserts that the given outcome does not contain any fields that imply system verification.
 * Strict architectural invariant: RawExecutorOutcome MUST NOT be SystemVerifiedEvidence.
 */
export function assertNotVerifiedEvidence(outcome: unknown): void {
  if (!outcome || typeof outcome !== 'object') {
    return;
  }
  const rec = outcome as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_VERIFICATION_FIELDS) {
    if (forbidden in rec && rec[forbidden] !== undefined) {
      throw new ExecutorSecurityViolationError(
        `RawExecutorOutcome contains forbidden system verification field: '${forbidden}'. Raw executor outcome cannot claim authoritative verification.`,
        { forbiddenField: forbidden, outcomeKeys: Object.keys(rec) }
      );
    }
  }
}

// ============================================================================
// 3. ZOD VALIDATION SCHEMA
// ============================================================================

export const RawExecutorIdentityZodSchema = z.object({
  provider: z.string().min(1, 'provider is required'),
  name: z.string().min(1, 'name is required'),
  version: z.string().nullable().optional(),
});

export const RawRequestBindingZodSchema = z.object({
  requestId: z.string().regex(/^req-[a-f0-9]{24,64}$/, 'requestId must match req-<sha256-hex>'),
  projectId: z.string().min(1, 'projectId is required'),
  taskId: z.string().min(1, 'taskId is required'),
  taskRevision: z.number().int().nonnegative(),
  contextFingerprint: z.string().min(1, 'contextFingerprint is required'),
  understandingRevision: z.number().int().nonnegative(),
  approvalPackageRevision: z.number().int().positive(),
});

export const RawExecutorOutcomeZodSchema = z
  .object({
    requestId: z.string().regex(/^req-[a-f0-9]{24,64}$/, 'requestId must match req-<sha256-hex>'),
    executorIdentity: RawExecutorIdentityZodSchema,
    status: z.enum(['SUCCESS', 'FAILURE', 'TIMEOUT', 'CANCELLED', 'ERROR']),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
    startedAt: z.string().min(1, 'startedAt cannot be empty'),
    completedAt: z.string().min(1, 'completedAt cannot be empty'),
    durationMs: z.number().nonnegative(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    requestBinding: RawRequestBindingZodSchema,
    unverifiedAgentClaims: z.array(z.string()),
    unverifiedModifiedFiles: z.array(z.string()),
    executorMetadata: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .nullable()
      .optional(),

    // Legacy Phase 3 compatibility
    executor_id: z.string().optional(),
    command: z.string().nullable().optional(),
    exit_code: z.number().nullable().optional(),
    raw_payload: z.unknown().optional(),
    agent_claims: z.array(z.string()).nullable().optional(),
    unverified_changed_files: z.array(z.string()).nullable().optional(),
    timing: z
      .object({
        started_at: z.string().nullable().optional(),
        completed_at: z.string().nullable().optional(),
        duration_ms: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    // Enforce that NO system verification fields exist on the raw outcome
    const rawObj = val as Record<string, unknown>;
    for (const forbidden of FORBIDDEN_VERIFICATION_FIELDS) {
      if (forbidden in rawObj && rawObj[forbidden] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `RawExecutorOutcome MUST NOT contain system verification field '${forbidden}'`,
          path: [forbidden],
        });
      }
    }
  });

// ============================================================================
// 4. FACTORY HELPERS
// ============================================================================

export function extractRequestBinding(request: ExecutionRequest): RawRequestBinding {
  return Object.freeze({
    requestId: request.requestId,
    projectId: request.projectId,
    taskId: request.taskId,
    taskRevision: request.taskRevision,
    contextFingerprint: request.contextFingerprint,
    understandingRevision: request.understandingRevision,
    approvalPackageRevision: request.approvalPackageRevision,
  });
}

export function createSuccessRawOutcome(params: {
  request: ExecutionRequest;
  executorIdentity: RawExecutorIdentity;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
  unverifiedAgentClaims?: readonly string[];
  unverifiedModifiedFiles?: readonly string[];
  executorMetadata?: Record<string, unknown>;
}): RawExecutorOutcome {
  const binding = extractRequestBinding(params.request);
  const claims = Object.freeze([...(params.unverifiedAgentClaims ?? [])]);
  const files = Object.freeze([...(params.unverifiedModifiedFiles ?? [])]);

  const outcome: RawExecutorOutcome = Object.freeze({
    requestId: params.request.requestId,
    executorIdentity: Object.freeze({ ...params.executorIdentity }),
    status: 'SUCCESS',
    exitCode: params.exitCode !== undefined ? params.exitCode : 0,
    signal: null,
    stdout: params.stdout ?? '',
    stderr: params.stderr ?? null,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.durationMs),
    timedOut: false,
    cancelled: false,
    requestBinding: binding,
    unverifiedAgentClaims: claims,
    unverifiedModifiedFiles: files,
    executorMetadata: params.executorMetadata ? Object.freeze({ ...params.executorMetadata }) : undefined,
    error: null,

    // Legacy Phase 3 compatibility
    executor_id: params.executorIdentity.name,
    exit_code: params.exitCode !== undefined ? params.exitCode : 0,
    agent_claims: claims,
    unverified_changed_files: files,
    timing: Object.freeze({
      started_at: params.startedAt,
      completed_at: params.completedAt,
      duration_ms: params.durationMs,
    }),
  });

  assertNotVerifiedEvidence(outcome);
  return outcome;
}

export function createFailureRawOutcome(params: {
  request: ExecutionRequest;
  executorIdentity: RawExecutorIdentity;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: { code: string; message: string; details?: unknown };
  unverifiedAgentClaims?: readonly string[];
  unverifiedModifiedFiles?: readonly string[];
  executorMetadata?: Record<string, unknown>;
}): RawExecutorOutcome {
  const binding = extractRequestBinding(params.request);
  const claims = Object.freeze([...(params.unverifiedAgentClaims ?? [])]);
  const files = Object.freeze([...(params.unverifiedModifiedFiles ?? [])]);

  const outcome: RawExecutorOutcome = Object.freeze({
    requestId: params.request.requestId,
    executorIdentity: Object.freeze({ ...params.executorIdentity }),
    status: 'FAILURE',
    exitCode: params.exitCode !== undefined ? params.exitCode : 1,
    signal: params.signal ?? null,
    stdout: params.stdout ?? null,
    stderr: params.stderr ?? null,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.durationMs),
    timedOut: false,
    cancelled: false,
    requestBinding: binding,
    unverifiedAgentClaims: claims,
    unverifiedModifiedFiles: files,
    executorMetadata: params.executorMetadata ? Object.freeze({ ...params.executorMetadata }) : undefined,
    error: params.error
      ? Object.freeze({
          code: params.error.code,
          message: params.error.message,
          details: params.error.details,
        })
      : Object.freeze({
          code: 'ERR_EXECUTOR_FAILED',
          message: params.stderr || 'Executor completed with non-zero exit code',
        }),

    // Legacy Phase 3 compatibility
    executor_id: params.executorIdentity.name,
    exit_code: params.exitCode !== undefined ? params.exitCode : 1,
    agent_claims: claims,
    unverified_changed_files: files,
    timing: Object.freeze({
      started_at: params.startedAt,
      completed_at: params.completedAt,
      duration_ms: params.durationMs,
    }),
  });

  assertNotVerifiedEvidence(outcome);
  return outcome;
}

export function createTimeoutRawOutcome(params: {
  request: ExecutionRequest;
  executorIdentity: RawExecutorIdentity;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout?: string | null;
  stderr?: string | null;
  executorMetadata?: Record<string, unknown>;
}): RawExecutorOutcome {
  const binding = extractRequestBinding(params.request);

  const outcome: RawExecutorOutcome = Object.freeze({
    requestId: params.request.requestId,
    executorIdentity: Object.freeze({ ...params.executorIdentity }),
    status: 'TIMEOUT',
    exitCode: null,
    signal: 'SIGKILL',
    stdout: params.stdout ?? null,
    stderr: params.stderr ?? 'Execution timed out',
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.durationMs),
    timedOut: true,
    cancelled: false,
    requestBinding: binding,
    unverifiedAgentClaims: Object.freeze([]),
    unverifiedModifiedFiles: Object.freeze([]),
    executorMetadata: params.executorMetadata ? Object.freeze({ ...params.executorMetadata }) : undefined,
    error: Object.freeze({
      code: 'ERR_EXECUTOR_TIMEOUT',
      message: `Execution exceeded timeout limit of ${params.request.executionLimits.timeoutMs}ms`,
      details: { timeoutMs: params.request.executionLimits.timeoutMs, durationMs: params.durationMs },
    }),

    // Legacy Phase 3 compatibility
    executor_id: params.executorIdentity.name,
    exit_code: null,
    agent_claims: [],
    unverified_changed_files: [],
    timing: Object.freeze({
      started_at: params.startedAt,
      completed_at: params.completedAt,
      duration_ms: params.durationMs,
    }),
  });

  assertNotVerifiedEvidence(outcome);
  return outcome;
}

export function createCancelledRawOutcome(params: {
  request: ExecutionRequest;
  executorIdentity: RawExecutorIdentity;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout?: string | null;
  stderr?: string | null;
  reason?: string;
  executorMetadata?: Record<string, unknown>;
}): RawExecutorOutcome {
  const binding = extractRequestBinding(params.request);

  const outcome: RawExecutorOutcome = Object.freeze({
    requestId: params.request.requestId,
    executorIdentity: Object.freeze({ ...params.executorIdentity }),
    status: 'CANCELLED',
    exitCode: null,
    signal: 'SIGTERM',
    stdout: params.stdout ?? null,
    stderr: params.stderr ?? 'Execution was cancelled by caller',
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.durationMs),
    timedOut: false,
    cancelled: true,
    requestBinding: binding,
    unverifiedAgentClaims: Object.freeze([]),
    unverifiedModifiedFiles: Object.freeze([]),
    executorMetadata: params.executorMetadata ? Object.freeze({ ...params.executorMetadata }) : undefined,
    error: Object.freeze({
      code: 'ERR_EXECUTOR_CANCELLED',
      message: params.reason ?? 'Execution was cancelled by caller signal',
    }),

    // Legacy Phase 3 compatibility
    executor_id: params.executorIdentity.name,
    exit_code: null,
    agent_claims: [],
    unverified_changed_files: [],
    timing: Object.freeze({
      started_at: params.startedAt,
      completed_at: params.completedAt,
      duration_ms: params.durationMs,
    }),
  });

  assertNotVerifiedEvidence(outcome);
  return outcome;
}

export function createErrorRawOutcome(params: {
  request: ExecutionRequest;
  executorIdentity: RawExecutorIdentity;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: { code: string; message: string; details?: unknown };
  stdout?: string | null;
  stderr?: string | null;
  executorMetadata?: Record<string, unknown>;
}): RawExecutorOutcome {
  const binding = extractRequestBinding(params.request);

  const outcome: RawExecutorOutcome = Object.freeze({
    requestId: params.request.requestId,
    executorIdentity: Object.freeze({ ...params.executorIdentity }),
    status: 'ERROR',
    exitCode: null,
    signal: null,
    stdout: params.stdout ?? null,
    stderr: params.stderr ?? params.error.message,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.durationMs),
    timedOut: false,
    cancelled: false,
    requestBinding: binding,
    unverifiedAgentClaims: Object.freeze([]),
    unverifiedModifiedFiles: Object.freeze([]),
    executorMetadata: params.executorMetadata ? Object.freeze({ ...params.executorMetadata }) : undefined,
    error: Object.freeze({
      code: params.error.code,
      message: params.error.message,
      details: params.error.details,
    }),

    // Legacy Phase 3 compatibility
    executor_id: params.executorIdentity.name,
    exit_code: null,
    agent_claims: [],
    unverified_changed_files: [],
    timing: Object.freeze({
      started_at: params.startedAt,
      completed_at: params.completedAt,
      duration_ms: params.durationMs,
    }),
  });

  assertNotVerifiedEvidence(outcome);
  return outcome;
}
