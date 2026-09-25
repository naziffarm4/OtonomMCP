/**
 * Verified Execution State Integration Types (Phase 10 TASK-P10-05)
 *
 * Defines the authoritative, strongly-typed contracts for integrating
 * P10-04 verified execution results into durable system state, Task DAG,
 * and History audit log.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO EXECUTOR TRUST: Only P10-04 system verified evidence can be integrated.
 * 2. NO FABRICATED VERIFICATION: Rejects any fake verification flags or raw executor claims.
 * 3. STRICT DECISION BOUNDS: verificationDecision is strictly one of 'ACCEPT' | 'REJECT' | 'BLOCK'.
 * 4. COMPLETE EXECUTION BINDING: requestId, projectId, taskId, taskRevision, contextFingerprint,
 *    understandingRevision, and approvalPackageRevision are mandatory.
 * 5. DETERMINISTIC IDEMPOTENCY: integrationKey is derived deterministically from canonical SHA-256
 *    over the execution binding tuple.
 * 6. ZERO AUTONOMOUS RETRY / ZERO ANTIGRAVITY INVOCATION: P10-05 is purely a state update and
 *    recovery bridge; it never invokes Antigravity or dispatches execution.
 * 7. PRESERVES AUTHORITATIVE ROLES:
 *    - DurableStateManager remains sole global FSM authority.
 *    - TaskDagEngine remains sole DAG authority.
 *    - SpecStore remains authoritative task specification store.
 *    - ApprovalStore / HumanApprovalEngine remain authoritative for approvals.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import {
  type SystemExecutionEvidence,
  SystemExecutionEvidenceZodSchema,
  type VerificationDecision,
  VERIFICATION_DECISIONS,
  isVerificationDecision,
} from '../evidence/system-execution-evidence.js';
import { FORBIDDEN_VERIFICATION_FIELDS } from '../executor-bridge/raw-executor-outcome.js';
import { TaskStatus, TASK_STATUSES, type TaskStatus as TaskStatusType } from '../task-engine/task-types.js';
import {
  ExecutionIntegrationSecurityViolationError,
} from '../director/director-errors.js';

export const EXECUTION_INTEGRATION_PROTOCOL_VERSION = 'P10-05';
export const EXECUTION_INTEGRATION_SCHEMA_VERSION = 1;

// ============================================================================
// 1. FORBIDDEN VERIFICATION FIELDS GUARD
// ============================================================================

export function assertNoForbiddenIntegrationFields(data: unknown): void {
  if (!data || typeof data !== 'object') {
    return;
  }
  const record = data as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_VERIFICATION_FIELDS) {
    if (forbidden in record && record[forbidden] !== undefined) {
      throw new ExecutionIntegrationSecurityViolationError(
        `Forbidden fake verification field '${forbidden}' detected in integration input. Caller cannot fabricate verification claims.`,
        { forbiddenField: forbidden }
      );
    }
  }
}

// ============================================================================
// 2. CANONICAL EXECUTION BINDING CONTRACT
// ============================================================================

export interface ExecutionBinding {
  /** Preserved execution request identifier */
  readonly requestId: string;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Canonical task identifier from Task DAG */
  readonly taskId: string;
  /** Monotonic task revision */
  readonly taskRevision: number;
  /** Logical fingerprint of the authorized context */
  readonly contextFingerprint: string;
  /** Authoritative project understanding revision */
  readonly understandingRevision: number;
  /** Authoritative human approval package revision */
  readonly approvalPackageRevision: number;
}

export const ExecutionBindingZodSchema = z.object({
  requestId: z.string().min(1, 'requestId cannot be empty'),
  projectId: z.string().min(1, 'projectId cannot be empty'),
  taskId: z.string().min(1, 'taskId cannot be empty'),
  taskRevision: z.number().int().positive('taskRevision must be a positive integer'),
  contextFingerprint: z.string().min(1, 'contextFingerprint cannot be empty'),
  understandingRevision: z.number().int().positive('understandingRevision must be a positive integer'),
  approvalPackageRevision: z.number().int().positive('approvalPackageRevision must be a positive integer'),
});

// ============================================================================
// 3. CANONICAL VERIFIED EXECUTION RESULT ENVELOPE
// ============================================================================

export interface VerifiedExecutionResult {
  /** Authoritative independently verified system evidence produced by P10-04 */
  readonly evidence: SystemExecutionEvidence;
  /** Authoritative verification decision: ACCEPT | REJECT | BLOCK */
  readonly verificationDecision: VerificationDecision;
  /** Immutable execution binding asserting exact request, task, and project context */
  readonly executionBinding: ExecutionBinding;
  /** Optional sanitized metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const VerifiedExecutionResultZodSchema = z
  .object({
    evidence: SystemExecutionEvidenceZodSchema,
    verificationDecision: z.enum(['ACCEPT', 'REJECT', 'BLOCK']),
    executionBinding: ExecutionBindingZodSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((val, ctx) => {
    // Assert no forbidden fields anywhere in the envelope
    for (const forbidden of FORBIDDEN_VERIFICATION_FIELDS) {
      if (forbidden in val && (val as Record<string, unknown>)[forbidden] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Forbidden field '${forbidden}' detected in VerifiedExecutionResult envelope.`,
          path: [forbidden],
        });
      }
    }

    // Verify internal binding consistency between evidence and executionBinding
    if (val.evidence.requestId !== val.executionBinding.requestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.requestId '${val.evidence.requestId}' !== executionBinding.requestId '${val.executionBinding.requestId}'`,
        path: ['executionBinding', 'requestId'],
      });
    }

    if (val.evidence.projectId !== val.executionBinding.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.projectId '${val.evidence.projectId}' !== executionBinding.projectId '${val.executionBinding.projectId}'`,
        path: ['executionBinding', 'projectId'],
      });
    }

    if (val.evidence.taskId !== val.executionBinding.taskId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.taskId '${val.evidence.taskId}' !== executionBinding.taskId '${val.executionBinding.taskId}'`,
        path: ['executionBinding', 'taskId'],
      });
    }

    if (val.evidence.taskRevision !== val.executionBinding.taskRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.taskRevision ${val.evidence.taskRevision} !== executionBinding.taskRevision ${val.executionBinding.taskRevision}`,
        path: ['executionBinding', 'taskRevision'],
      });
    }

    if (val.evidence.contextFingerprint !== val.executionBinding.contextFingerprint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.contextFingerprint '${val.evidence.contextFingerprint}' !== executionBinding.contextFingerprint '${val.executionBinding.contextFingerprint}'`,
        path: ['executionBinding', 'contextFingerprint'],
      });
    }

    if (val.evidence.understandingRevision !== val.executionBinding.understandingRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.understandingRevision ${val.evidence.understandingRevision} !== executionBinding.understandingRevision ${val.executionBinding.understandingRevision}`,
        path: ['executionBinding', 'understandingRevision'],
      });
    }

    if (val.evidence.approvalPackageRevision !== val.executionBinding.approvalPackageRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Binding mismatch: evidence.approvalPackageRevision ${val.evidence.approvalPackageRevision} !== executionBinding.approvalPackageRevision ${val.executionBinding.approvalPackageRevision}`,
        path: ['executionBinding', 'approvalPackageRevision'],
      });
    }

    if (val.evidence.verificationDecision !== val.verificationDecision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Decision mismatch: evidence.verificationDecision '${val.evidence.verificationDecision}' !== verificationDecision '${val.verificationDecision}'`,
        path: ['verificationDecision'],
      });
    }
  });

// ============================================================================
// 4. FACTORY HELPER
// ============================================================================

/**
 * Creates a canonical VerifiedExecutionResult envelope from P10-04 SystemExecutionEvidence.
 * Automatically binds all required authority attributes from the evidence unless explicitly overridden.
 */
export function createVerifiedExecutionResult(
  evidence: SystemExecutionEvidence,
  overrides?: {
    verificationDecision?: VerificationDecision;
    executionBinding?: Partial<ExecutionBinding>;
    metadata?: Record<string, unknown>;
  }
): VerifiedExecutionResult {
  assertNoForbiddenIntegrationFields(evidence);
  if (overrides) {
    assertNoForbiddenIntegrationFields(overrides);
  }

  const executionBinding: ExecutionBinding = {
    requestId: overrides?.executionBinding?.requestId ?? evidence.requestId,
    projectId: overrides?.executionBinding?.projectId ?? evidence.projectId,
    taskId: overrides?.executionBinding?.taskId ?? evidence.taskId,
    taskRevision: overrides?.executionBinding?.taskRevision ?? evidence.taskRevision,
    contextFingerprint: overrides?.executionBinding?.contextFingerprint ?? evidence.contextFingerprint,
    understandingRevision: overrides?.executionBinding?.understandingRevision ?? evidence.understandingRevision,
    approvalPackageRevision: overrides?.executionBinding?.approvalPackageRevision ?? evidence.approvalPackageRevision,
  };

  return {
    evidence,
    verificationDecision: overrides?.verificationDecision ?? evidence.verificationDecision,
    executionBinding,
    metadata: overrides?.metadata ?? evidence.metadata,
  };
}

// ============================================================================
// 5. DETERMINISTIC INTEGRATION KEY COMPUTATION
// ============================================================================

export interface ComputeIntegrationKeyInput {
  readonly projectId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly taskRevision: number;
}

/**
 * Computes a deterministic idempotency key for state integration.
 * Derived from canonical SHA-256 of the execution binding tuple.
 */
export function computeDeterministicIntegrationKey(input: ComputeIntegrationKeyInput): string {
  const canonical = JSON.stringify({
    projectId: input.projectId,
    requestId: input.requestId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
  });
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  const sanitizedTask = input.taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `int_${sanitizedTask}_rev${input.taskRevision}_${hash.slice(0, 16)}`;
}

/**
 * Computes a deterministic HistoryManager event ID for state integration audit.
 */
export function computeDeterministicIntegrationEventId(
  integrationKey: string,
  eventType: string
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${integrationKey}:${eventType}`, 'utf8')
    .digest('hex');
  return `evt_int_${hash.slice(0, 24)}`;
}

// ============================================================================
// 6. PERSISTENT IDEMPOTENCY JOURNAL RECORD
// ============================================================================

export interface ExecutionIntegrationRecord {
  readonly integrationKey: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly evidenceId: string;
  readonly contextFingerprint: string;
  readonly understandingRevision: number;
  readonly approvalPackageRevision: number;
  readonly verificationDecision: VerificationDecision;
  readonly taskStatus: TaskStatusType;
  readonly status: 'INTEGRATED' | 'REJECTED' | 'BLOCKED';
  readonly integratedAt: string;
  readonly historyEventId?: string;
  readonly affectedReadyTasks?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export const ExecutionIntegrationRecordZodSchema = z.object({
  integrationKey: z.string().min(1),
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  evidenceId: z.string().min(1),
  contextFingerprint: z.string().min(1),
  understandingRevision: z.number().int().positive(),
  approvalPackageRevision: z.number().int().positive(),
  verificationDecision: z.enum(['ACCEPT', 'REJECT', 'BLOCK']),
  taskStatus: z.enum(TASK_STATUSES as [string, ...string[]]),
  status: z.enum(['INTEGRATED', 'REJECTED', 'BLOCKED']),
  integratedAt: z.string().min(1),
  historyEventId: z.string().optional(),
  affectedReadyTasks: z.array(z.string()).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// 7. INTEGRATION SERVICE OUTCOME & RECONCILIATION REPORT
// ============================================================================

export interface ExecutionIntegrationOutcome {
  /** Whether the integration succeeded (or safely resolved duplicate) */
  readonly success: boolean;
  /** Deterministic integration idempotency key */
  readonly integrationKey: string;
  /** Authoritative decision that was integrated */
  readonly verificationDecision: VerificationDecision;
  /** Authoritative task status resulting from integration */
  readonly taskStatus: TaskStatusType;
  /** Task identifier */
  readonly taskId: string;
  /** Task revision */
  readonly taskRevision: number;
  /** ISO 8601 timestamp of integration */
  readonly integratedAt: string;
  /** Deterministic history event ID if recorded */
  readonly historyEventId?: string;
  /** Whether this integration was an idempotent replay of an already-integrated result */
  readonly isDuplicate: boolean;
  /** Subsequent tasks in the DAG that transitioned to ready status (ACCEPT only) */
  readonly affectedReadyTasks?: readonly string[];
  /** Informational message */
  readonly message: string;
  /** Sanitized outcome details */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ReconciliationDiscrepancy {
  readonly taskId: string;
  readonly type: 'COMPLETION_STATE_MISMATCH' | 'BLOCKED_STATE_MISMATCH' | 'ORPHAN_INTEGRATION_RECORD' | 'UNRECORDED_ACCEPTED_TASK';
  readonly description: string;
  readonly actionTaken: string;
}

export interface ReconciliationReport {
  readonly timestamp: string;
  readonly reconciledCount: number;
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
  readonly totalCompletedTasks: number;
  readonly activeTaskId: string | null;
  readonly isConsistent: boolean;
}
