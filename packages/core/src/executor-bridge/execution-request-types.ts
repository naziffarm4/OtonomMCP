/**
 * Deterministic Execution Request Contract Types (Phase 10 TASK-P10-02)
 *
 * Establishes the strongly typed, deterministic contract for converting
 * an authorized ExecutionIntent into an immutable ExecutionRequest.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. CONTRACT ONLY: Zero execution dispatch, no subagents, no shell spawn.
 * 2. DETERMINISTIC IDENTIFIERS: requestId is derived deterministically from canonical SHA-256.
 * 3. BINDING FIDELITY: Sensitive binding fields (project, session, decision, task, revisions)
 *    are immutably bound to the verified ExecutionIntent; caller overrides are strictly rejected.
 * 4. PATH SANITIZATION: targetFiles must be relative POSIX paths; path traversal (..)
 *    and absolute external paths are strictly prohibited and rejected.
 * 5. REPOSITORY STATE AUTHORITY: expectedRepositoryState must match authoritative Git state;
 *    unauthorized caller forgery is detected and rejected.
 * 6. FINITE BOUNDS: executionLimits (timeoutMs, maxFileModifications) are strictly bounded.
 * 7. ZERO STATE MUTATION: Does NOT mutate DurableStateManager, Task DAG, SpecStore, or ApprovalStore.
 */

import { z } from 'zod';
import {
  type ExecutionOperationType,
  ExecutionOperationTypeZodSchema,
  type ExecutionIntent,
  ExecutionIntentZodSchema,
} from '../director/execution-intent-types.js';
import {
  ExecutionRequestError,
  ExecutionRequestValidationError,
  ExecutionRequestInvalidPathError,
  ExecutionRequestRepositoryForgeryError,
  ExecutionRequestIntentMismatchError,
  ExecutionRequestLimitsInvalidError,
  ExecutionRequestTaskRevisionMismatchError,
} from '../director/director-errors.js';


// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const EXECUTION_REQUEST_PROTOCOL_VERSION = 'P10-02';
export const EXECUTION_REQUEST_SCHEMA_VERSION = 1;

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000; // 5 minutes
export const MIN_EXECUTION_TIMEOUT_MS = 1_000; // 1 second
export const MAX_EXECUTION_TIMEOUT_MS = 3_600_000; // 1 hour

export const DEFAULT_MAX_FILE_MODIFICATIONS = 20;
export const MIN_MAX_FILE_MODIFICATIONS = 1;
export const MAX_MAX_FILE_MODIFICATIONS = 100;

// ============================================================================
// 2. DOMAIN MODEL & SUB-TYPES
// ============================================================================

export interface AcceptanceCriterionSpec {
  readonly criterionId?: string;
  readonly id?: string;
  readonly description: string;
  readonly type?: string;
  readonly mandatory?: boolean;
}

export type ExecutionAcceptanceCriterion = string | AcceptanceCriterionSpec;

export interface ExecutionInstruction {
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly targetFiles: readonly string[];
  readonly acceptanceCriteria: readonly ExecutionAcceptanceCriterion[];
}

export interface ExpectedRepositoryState {
  readonly baseCommit: string;
  readonly isClean: boolean;
}

export interface ExecutionLimits {
  readonly timeoutMs: number;
  readonly maxFileModifications: number;
}

export interface ExecutionRequest {
  /** Deterministic UUID / Hash (Idempotency key derived from canonical SHA-256) */
  readonly requestId: string;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Active Director session identifier */
  readonly directorSessionId: string;
  /** Triggering Director decision identifier */
  readonly directorDecisionId: string;
  /** Task identifier from Task DAG */
  readonly taskId: string;
  /** Monotonic task revision */
  readonly taskRevision: number;
  /** Logical fingerprint of the authoritative context snapshot */
  readonly contextFingerprint: string;
  /** Authoritative understanding baseline revision */
  readonly understandingRevision: number;
  /** Bound human approval package revision */
  readonly approvalPackageRevision: number;
  /** Executor operation type */
  readonly operationType: ExecutionOperationType;
  /** Strongly typed, normalized execution instruction */
  readonly instruction: ExecutionInstruction;
  /** Authoritative Git repository baseline state */
  readonly expectedRepositoryState: ExpectedRepositoryState;
  /** Strictly bounded execution limits */
  readonly executionLimits: ExecutionLimits;
  /** Protocol version string (P10-02) */
  readonly protocolVersion: 'P10-02';
  /** Schema version integer (1) */
  readonly schemaVersion: 1;
  /** Associated ExecutionIntent identifier */
  readonly intentId?: string;
  /** ISO 8601 creation timestamp (excluded from hash computation) */
  readonly createdAt?: string;
  /** Optional sanitized metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 3. BUILD INPUT CONTRACT
// ============================================================================

export interface ExecutionInstructionInput {
  readonly objective?: string;
  readonly constraints?: readonly string[];
  readonly targetFiles?: readonly string[];
  readonly acceptanceCriteria?: readonly ExecutionAcceptanceCriterion[];
}

export interface BuildExecutionRequestInput {
  /** Authoritative, verified ExecutionIntent from P10-01 */
  readonly intent: ExecutionIntent;
  /** Execution instruction details (optional if derived from task in SpecStore) */
  readonly instruction?: ExecutionInstructionInput;
  /** Expected repository baseline (validated against Git state or auto-captured) */
  readonly expectedRepositoryState?: ExpectedRepositoryState;
  /** Bounded execution limits (defaults applied if omitted) */
  readonly executionLimits?: Partial<ExecutionLimits>;
  /** Working directory for inspecting Git state */
  readonly workingDirectory?: string;
  /** Optional sanitized metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;

  // Invariant validation: If caller explicitly passes binding overrides,
  // they MUST match the intent exactly or will be rejected as forgery.
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly directorDecisionId?: string;
  readonly taskId?: string;
  readonly taskRevision?: number;
  readonly contextFingerprint?: string;
  readonly understandingRevision?: number;
  readonly approvalPackageRevision?: number;
  readonly operationType?: ExecutionOperationType;
  readonly protocolVersion?: string;
  readonly schemaVersion?: number;
}

export interface ExecutionRequestValidationResult {
  readonly isValid: boolean;
  readonly code: 'VALID' | 'INVALID_INTENT' | 'INVALID_PATH' | 'REPOSITORY_FORGERY' | 'INTENT_MISMATCH' | 'LIMITS_INVALID' | 'VALIDATION_ERROR';
  readonly message: string;
  readonly request?: ExecutionRequest;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 4. ZOD VALIDATION SCHEMAS
// ============================================================================

export const AcceptanceCriterionSpecZodSchema = z.object({
  criterionId: z.string().optional(),
  id: z.string().optional(),
  description: z.string().min(1, 'Acceptance criterion description cannot be empty'),
  type: z.string().optional(),
  mandatory: z.boolean().optional(),
});

export const ExecutionAcceptanceCriterionZodSchema = z.union([
  z.string().min(1, 'Acceptance criterion string cannot be empty'),
  AcceptanceCriterionSpecZodSchema,
]);

export const ExecutionInstructionZodSchema = z.object({
  objective: z.string().min(1, 'Instruction objective cannot be empty'),
  constraints: z.array(z.string()),
  targetFiles: z.array(z.string()),
  acceptanceCriteria: z.array(ExecutionAcceptanceCriterionZodSchema).min(1, 'acceptanceCriteria must contain at least one criterion'),
});

export const ExpectedRepositoryStateZodSchema = z.object({
  baseCommit: z.string().min(1, 'baseCommit must be a non-empty Git commit SHA'),
  isClean: z.boolean(),
});

export const ExecutionLimitsZodSchema = z.object({
  timeoutMs: z
    .number()
    .int('timeoutMs must be an integer')
    .min(MIN_EXECUTION_TIMEOUT_MS, `timeoutMs must be at least ${MIN_EXECUTION_TIMEOUT_MS}ms`)
    .max(MAX_EXECUTION_TIMEOUT_MS, `timeoutMs cannot exceed ${MAX_EXECUTION_TIMEOUT_MS}ms`),
  maxFileModifications: z
    .number()
    .int('maxFileModifications must be an integer')
    .min(MIN_MAX_FILE_MODIFICATIONS, `maxFileModifications must be at least ${MIN_MAX_FILE_MODIFICATIONS}`)
    .max(MAX_MAX_FILE_MODIFICATIONS, `maxFileModifications cannot exceed ${MAX_MAX_FILE_MODIFICATIONS}`),
});

export const ExecutionRequestZodSchema = z.object({
  requestId: z.string().regex(/^req-[a-f0-9]{24,64}$/, 'requestId must match req-<sha256-hex>'),
  projectId: z.string().min(1, 'projectId is required'),
  directorSessionId: z.string().min(1, 'directorSessionId is required'),
  directorDecisionId: z.string().min(1, 'directorDecisionId is required'),
  taskId: z.string().min(1, 'taskId is required'),
  taskRevision: z.number().int().nonnegative('taskRevision must be a non-negative integer'),
  contextFingerprint: z.string().min(1, 'contextFingerprint is required'),
  understandingRevision: z.number().int().nonnegative('understandingRevision must be a non-negative integer'),
  approvalPackageRevision: z.number().int().positive('approvalPackageRevision must be a positive integer'),
  operationType: ExecutionOperationTypeZodSchema,
  instruction: ExecutionInstructionZodSchema,
  expectedRepositoryState: ExpectedRepositoryStateZodSchema,
  executionLimits: ExecutionLimitsZodSchema,
  protocolVersion: z.literal(EXECUTION_REQUEST_PROTOCOL_VERSION),
  schemaVersion: z.literal(EXECUTION_REQUEST_SCHEMA_VERSION),
  intentId: z.string().optional(),
  createdAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BuildExecutionRequestInputZodSchema = z.object({
  intent: ExecutionIntentZodSchema,
  instruction: z
    .object({
      objective: z.string().optional(),
      constraints: z.array(z.string()).optional(),
      targetFiles: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(ExecutionAcceptanceCriterionZodSchema).optional(),
    })
    .optional(),
  expectedRepositoryState: ExpectedRepositoryStateZodSchema.optional(),
  executionLimits: z
    .object({
      timeoutMs: z.number().optional(),
      maxFileModifications: z.number().optional(),
    })
    .optional(),
  workingDirectory: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  projectId: z.string().optional(),
  directorSessionId: z.string().optional(),
  directorDecisionId: z.string().optional(),
  taskId: z.string().optional(),
  taskRevision: z.number().optional(),
  contextFingerprint: z.string().optional(),
  understandingRevision: z.number().optional(),
  approvalPackageRevision: z.number().optional(),
  operationType: ExecutionOperationTypeZodSchema.optional(),
  protocolVersion: z.string().optional(),
  schemaVersion: z.number().optional(),
});

// Re-export error classes for convenience
export {
  ExecutionRequestError,
  ExecutionRequestValidationError,
  ExecutionRequestInvalidPathError,
  ExecutionRequestRepositoryForgeryError,
  ExecutionRequestIntentMismatchError,
  ExecutionRequestLimitsInvalidError,
  ExecutionRequestTaskRevisionMismatchError,
};

