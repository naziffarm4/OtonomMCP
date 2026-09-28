/**
 * Director ↔ Executor Loop Protocol Types (Phase 16 TASK-P16-01)
 *
 * Establishes the authoritative, strongly-typed domain model for the controlled
 * Director ↔ Executor feedback cycle.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. DIRECTOR INSTRUCTION IS NOT EXECUTION AUTHORITY: It is an intent proposal that MUST
 *    pass through ExecutionAuthorizer and require explicit Product Owner approval.
 * 2. EXECUTOR CLAIMS ARE NEVER PROOF: RawExecutorOutcome and stdout are never authoritative;
 *    SystemExecutionEvidence is the sole authoritative proof.
 * 3. CONTROLLED ORCHESTRATION ONLY: P16 strictly coordinates one cycle at a time;
 *    automatic continuation / daemon execution belongs strictly to P17.
 * 4. FAIL CLOSED: Any stale, conflicting, or mismatched state is rejected immediately.
 * 5. HUMAN DECISION ROUTING: Decisions requiring human authorization stop the cycle
 *    and surface the exact decision point to the Product Owner boundary.
 * 6. NO NATURAL-LANGUAGE APPROVAL: Natural-language strings ('tamam', 'devam', 'onay', 'yes', 'ok')
 *    MUST NEVER count as approval.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import type { ExecutionIntent } from '../director/execution-intent-types.js';
import type {
  ExecutionRequest,
  AcceptanceCriterionSpec,
  ExecutionAcceptanceCriterion,
} from '../executor-bridge/execution-request-types.js';
import type { RawExecutorOutcome } from '../executor-bridge/raw-executor-outcome.js';
import type {
  SystemExecutionEvidence,
  VerificationDecision,
} from '../evidence/system-execution-evidence.js';
import type { ExecutionIntegrationOutcome } from '../execution-integration/execution-integration-types.js';
import type { RecoveryPolicyDecision } from '../recovery/recovery-policy-types.js';
import type { RetryAuthorizationOutcome } from '../recovery/retry-authorization-types.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const DIRECTOR_LOOP_PROTOCOL_VERSION = 'P16-01';
export const DIRECTOR_LOOP_SCHEMA_VERSION = 1;
export const DIRECTOR_INSTRUCTION_ACTOR = 'DIRECTOR' as const;

// ============================================================================
// 2. DETERMINISTIC IDENTIFIER GENERATION
// ============================================================================

/**
 * Computes deterministic instructionId: inst-<sha256(projectId:directorSessionId:directorDecisionId:taskId:taskRevision)[:16]>
 */
export function computeDeterministicInstructionId(params: {
  projectId: string;
  directorSessionId: string;
  directorDecisionId: string;
  taskId: string;
  taskRevision: number;
}): string {
  const raw = `${params.projectId}:${params.directorSessionId}:${params.directorDecisionId}:${params.taskId}:${params.taskRevision}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
  return `inst-${hash}`;
}

/**
 * Computes deterministic cycleId: cycle-<sha256(instructionId:requestId:evidenceId)[:16]>
 */
export function computeDeterministicCycleId(params: {
  instructionId: string;
  requestId: string;
  evidenceId: string;
}): string {
  const raw = `${params.instructionId}:${params.requestId}:${params.evidenceId}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
  return `cycle-${hash}`;
}

// ============================================================================
// 3. DOMAIN MODELS
// ============================================================================

export interface DirectorInstruction {
  /** Deterministic identifier for this instruction */
  readonly instructionId: string;
  /** Bound canonical project ID */
  readonly projectId: string;
  /** Active Director session ID */
  readonly directorSessionId: string;
  /** Bound Director decision ID (must be IMPLEMENT_TASK) */
  readonly directorDecisionId: string;
  /** Target task ID in SpecStore */
  readonly taskId: string;
  /** Expected task revision */
  readonly taskRevision: number;
  /** Bound context fingerprint */
  readonly contextFingerprint: string;
  /** Authoritative understanding revision */
  readonly understandingRevision: number;
  /** Bound human approval package revision */
  readonly approvalPackageRevision: number;
  /** Clear objective for the instruction */
  readonly objective: string;
  /** Target files to modify (relative POSIX paths only) */
  readonly targetFiles: readonly string[];
  /** Optional allowed implementation scope files */
  readonly implementationScope?: readonly string[];
  /** Optional acceptance criteria */
  readonly acceptanceCriteria?: readonly ExecutionAcceptanceCriterion[];
  /** Optional execution constraints */
  readonly constraints?: readonly string[];
  /** Strictly 'DIRECTOR' */
  readonly actor: 'DIRECTOR';
  /** Creation timestamp */
  readonly createdAt: string;
  /** Optional metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface IngestDirectorInstructionInput {
  readonly workspaceRoot?: string;
  readonly instructionId?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly directorDecisionId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly contextFingerprint: string;
  readonly understandingRevision: number;
  readonly approvalPackageRevision: number;
  readonly objective: string;
  readonly targetFiles: readonly string[];
  readonly implementationScope?: readonly string[];
  readonly acceptanceCriteria?: readonly ExecutionAcceptanceCriterion[];
  readonly constraints?: readonly string[];
  readonly actor?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecuteDirectorCycleInput {
  readonly workspaceRoot?: string;
  readonly instructionId: string;
  readonly instruction?: DirectorInstruction;
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DirectorExecutionCycleResult {
  /** Deterministic cycle identifier */
  readonly cycleId: string;
  /** Bound instruction identifier */
  readonly instructionId: string;
  /** Canonical project ID */
  readonly projectId: string;
  /** Bound task identifier */
  readonly taskId: string;
  /** Bound task revision */
  readonly taskRevision: number;
  /** Bound Director session ID */
  readonly directorSessionId: string;
  /** Bound Director decision ID */
  readonly directorDecisionId: string;
  /** Authorized execution intent */
  readonly executionIntent: ExecutionIntent;
  /** Bound execution request */
  readonly executionRequest: ExecutionRequest;
  /** Raw executor outcome (for reference/audit only; NEVER proof) */
  readonly rawExecutorOutcome: RawExecutorOutcome;
  /** Sole authoritative evidence independently collected by the system */
  readonly systemEvidence: SystemExecutionEvidence;
  /** Verification decision: 'ACCEPT' | 'REJECT' | 'BLOCK' */
  readonly verificationDecision: VerificationDecision;
  /** Authoritative state integration outcome */
  readonly integrationOutcome: ExecutionIntegrationOutcome;
  /** Terminal execution status */
  readonly terminalStatus: 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
  /** Completion timestamp */
  readonly completedAt: string;
  /** Explicit verification boundary asserting raw executor outcome is NOT proof */
  readonly isAuthoritativeProof: {
    readonly executorOutcomeIsProof: false;
    readonly systemEvidenceIsProof: true;
  };
  /** Additional cycle metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type DirectorNextActionStatus =
  | 'EXECUTION_ACCEPTED'
  | 'EXECUTION_REJECTED'
  | 'EXECUTION_BLOCKED'
  | 'HUMAN_DECISION_REQUIRED'
  | 'NO_AUTHORIZED_ACTION';

export interface DirectorNextActionBoundary {
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly latestCycleResult: DirectorExecutionCycleResult;
  readonly actionStatus: DirectorNextActionStatus;
  readonly taskCompleted: boolean;
  readonly canIssueNextInstruction: boolean;
  /** STRICT INVARIANT: P16 orchestration NEVER automatically continues. */
  readonly autoContinue: false;
  readonly continuationPolicy: 'CONTROLLED_MANUAL';
  readonly recoveryRecommendation?: RecoveryPolicyDecision;
  readonly retryAuthorization?: RetryAuthorizationOutcome;
  readonly humanDecisionRequired: boolean;
  readonly humanDecisionPoint?: {
    readonly decisionId: string;
    readonly category: string;
    readonly description: string;
    readonly reason: string;
    readonly blockedState?: unknown;
  };
}

export interface EvaluateDirectorNextActionInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId?: string;
  readonly instructionId?: string;
  readonly cycleId?: string;
  readonly taskId?: string;
}

// ============================================================================
// 4. ZOD SCHEMAS
// ============================================================================

export const DirectorInstructionZodSchema = z.object({
  instructionId: z.string().min(1),
  projectId: z.string().min(1),
  directorSessionId: z.string().min(1),
  directorDecisionId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  contextFingerprint: z.string().min(1),
  understandingRevision: z.number().int().nonnegative(),
  approvalPackageRevision: z.number().int().nonnegative(),
  objective: z.string().min(1),
  targetFiles: z.array(z.string()),
  implementationScope: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  constraints: z.array(z.string()).optional(),
  actor: z.literal(DIRECTOR_INSTRUCTION_ACTOR),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const IngestDirectorInstructionInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  instructionId: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: z.string().min(1),
  directorDecisionId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  contextFingerprint: z.string().min(1),
  understandingRevision: z.number().int().nonnegative(),
  approvalPackageRevision: z.number().int().nonnegative(),
  objective: z.string().min(1),
  targetFiles: z.array(z.string()),
  implementationScope: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  constraints: z.array(z.string()).optional(),
  actor: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ExecuteDirectorCycleInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  instructionId: z.string().min(1),
  instruction: DirectorInstructionZodSchema.optional(),
  workingDirectory: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const EvaluateDirectorNextActionInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: z.string().optional(),
  instructionId: z.string().optional(),
  cycleId: z.string().optional(),
  taskId: z.string().optional(),
});
