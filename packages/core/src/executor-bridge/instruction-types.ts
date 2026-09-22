import { RiskLevel, isRiskLevel } from '../risk.js';
import {
  TraceabilityCategory,
  TRACEABILITY_CATEGORIES,
} from '../task-engine/task-types.js';
import {
  InvalidExecutorInstructionError,
  type InvalidExecutorInstructionDetails,
} from '../errors/executor-error.js';
import { PolicyViolationError } from '../errors/policy-violation-error.js';

// ============================================================================
// 1. EXECUTOR OPERATION TYPES
// ============================================================================

export const ExecutorOperationType = {
  IMPLEMENT_TASK: 'IMPLEMENT_TASK',
  EXECUTE_TEST: 'EXECUTE_TEST',
  EXECUTE_BUILD: 'EXECUTE_BUILD',
  INSPECT_WORKSPACE: 'INSPECT_WORKSPACE',
  APPLY_REPAIR: 'APPLY_REPAIR',
} as const;

export type ExecutorOperationType =
  (typeof ExecutorOperationType)[keyof typeof ExecutorOperationType];
export const EXECUTOR_OPERATION_TYPES = Object.values(
  ExecutorOperationType
) as readonly ExecutorOperationType[];

export function isExecutorOperationType(value: unknown): value is ExecutorOperationType {
  return (
    typeof value === 'string' &&
    (EXECUTOR_OPERATION_TYPES as readonly string[]).includes(value)
  );
}

// ============================================================================
// 2. EXECUTOR EXECUTION STATUS
// ============================================================================

export const ExecutorExecutionStatus = {
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED',
  REJECTED_BY_POLICY: 'REJECTED_BY_POLICY',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type ExecutorExecutionStatus =
  (typeof ExecutorExecutionStatus)[keyof typeof ExecutorExecutionStatus];
export const EXECUTOR_EXECUTION_STATUSES = Object.values(
  ExecutorExecutionStatus
) as readonly ExecutorExecutionStatus[];

export function isExecutorExecutionStatus(value: unknown): value is ExecutorExecutionStatus {
  return (
    typeof value === 'string' &&
    (EXECUTOR_EXECUTION_STATUSES as readonly string[]).includes(value)
  );
}

// ============================================================================
// 3. POLICY AUTHORIZATION STATES & DECISION CONTRACT
// ============================================================================

export const PolicyAuthorizationState = {
  AUTHORIZED: 'AUTHORIZED',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
} as const;

export type PolicyAuthorizationState =
  (typeof PolicyAuthorizationState)[keyof typeof PolicyAuthorizationState];
export const POLICY_AUTHORIZATION_STATES = Object.values(
  PolicyAuthorizationState
) as readonly PolicyAuthorizationState[];

export function isPolicyAuthorizationState(value: unknown): value is PolicyAuthorizationState {
  return (
    typeof value === 'string' &&
    (POLICY_AUTHORIZATION_STATES as readonly string[]).includes(value)
  );
}

export interface PolicyAuthorizationDecision {
  /** Explicit policy state */
  readonly state: PolicyAuthorizationState;
  /** Who authorized or evaluated: e.g. 'USER' | 'POLICY_ENGINE' */
  readonly decided_by?: string | null;
  /** ISO 8601 timestamp when the decision was rendered */
  readonly decided_at?: string | null;
  /** Policy rule identifier applied */
  readonly policy_rule?: string | null;
  /** Explanatory justification */
  readonly justification?: string | null;
  /** Cryptographic or deterministic token proving the authorization event */
  readonly decision_token?: string | null;
  /** Human or system explanation of policy state */
  readonly reason?: string | null;
}

/** Alias for backward compatibility */
export type ExecutorPolicyAuthorization = PolicyAuthorizationDecision;

// ============================================================================
// 4. RELEVANT CONTEXT & REFERENCE INFORMATION
// ============================================================================

export interface ExecutorRelevantContext {
  /** Context reference or hash from L0/L1/L2 (e.g. SHA-256 hash or DB ref) */
  readonly context_hash?: string | null;
  /** Target file paths relevant to the task */
  readonly target_files?: readonly string[];
  /** Structural interfaces, signatures, or diff chunks */
  readonly reference_code?: readonly {
    readonly path: string;
    readonly content?: string;
    readonly symbols?: readonly string[];
  }[];
  /** Relevant architecture decisions (e.g. ["DEC-001", "DEC-007"]) */
  readonly decisions?: readonly string[];
  /** Relevant user requirements (e.g. ["REQ-001"]) */
  readonly requirements?: readonly string[];
  /** Previous attempt failure summary if attempt > 1 */
  readonly previous_attempt_failure?: {
    readonly attempt: number;
    readonly error_signature?: string;
    readonly root_cause?: string;
    readonly failed_strategy?: string;
  } | null;
  /** Free-form structured metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutorTraceabilityInfo {
  readonly sources: readonly string[];
  readonly parent_feature_id?: string;
}

// ============================================================================
// 5. EXECUTOR INSTRUCTION CONTRACT (Requirement 1)
// ============================================================================

export interface ExecutorInstruction {
  readonly task_id: string;
  readonly instruction_id: string;
  readonly project_id: string;
  readonly working_directory: string;
  readonly objective: string;
  readonly acceptance_criteria: readonly string[];
  readonly constraints: readonly string[];
  readonly relevant_context: ExecutorRelevantContext;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly risk_level: RiskLevel;
  readonly requested_operation_type: ExecutorOperationType;
  readonly traceability_information: ExecutorTraceabilityInfo;
  readonly correlation_id: string;
  readonly policy_decision: PolicyAuthorizationDecision;
  /** Alias for policy_decision */
  readonly policy_authorization?: PolicyAuthorizationDecision | null;
}

export interface ExecutorInstructionInput {
  task_id?: string;
  taskId?: string;
  instruction_id?: string;
  instructionId?: string;
  project_id?: string;
  projectId?: string;
  working_directory?: string;
  workingDirectory?: string;
  objective?: string;
  acceptance_criteria?: readonly string[];
  acceptanceCriteria?: readonly string[];
  constraints?: readonly string[];
  relevant_context?: ExecutorRelevantContext;
  relevantContext?: ExecutorRelevantContext;
  attempt?: number;
  max_attempts?: number;
  maxAttempts?: number;
  risk_level?: RiskLevel;
  riskLevel?: RiskLevel;
  requested_operation_type?: ExecutorOperationType;
  requestedOperationType?: ExecutorOperationType;
  operation_type?: ExecutorOperationType;
  operationType?: ExecutorOperationType;
  traceability_information?: ExecutorTraceabilityInfo;
  traceabilityInformation?: ExecutorTraceabilityInfo;
  traceability_sources?: readonly string[];
  traceabilitySources?: readonly string[];
  parent_feature_id?: string;
  parentFeatureId?: string;
  correlation_id?: string;
  correlationId?: string;
  policy_decision?: PolicyAuthorizationDecision | null;
  policyDecision?: PolicyAuthorizationDecision | null;
  policy_authorization?: PolicyAuthorizationDecision | null;
  policyAuthorization?: PolicyAuthorizationDecision | null;
}

// ============================================================================
// 6. EXECUTOR RESULT CONTRACTS (Requirement 2 & 8)
// ============================================================================

/**
 * Raw outcome directly produced by the executor (unverified).
 * Preserved for downstream validation by the Evidence Engine (Phase 4).
 */
export interface RawExecutorOutcome {
  readonly executor_id: string;
  readonly command?: string | null;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
  readonly raw_payload?: unknown;
  readonly agent_claims?: readonly string[] | null;
  readonly unverified_changed_files?: readonly string[] | null;
  readonly timing?: {
    readonly started_at?: string | null;
    readonly completed_at?: string | null;
    readonly duration_ms?: number | null;
  } | null;
}

/**
 * Normalized executor result consumable by the Orchestrator.
 * Distinguishes execution facts without fabricating unavailable metrics.
 * Preserves raw execution outcome and isolates AGENT_CLAIM from verified evidence.
 */
export interface NormalizedExecutorResult {
  readonly success: boolean;
  readonly status: ExecutorExecutionStatus;
  readonly exit_info: {
    readonly code: number | null;
    readonly signal: string | null;
    readonly terminated: boolean;
  } | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly changed_files: readonly string[] | null;
  readonly executor_identity: {
    readonly provider: string;
    readonly name: string;
    readonly version: string | null;
  };
  readonly timing: {
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly duration_ms: number | null;
  } | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  } | null;
  readonly correlation: {
    readonly task_id: string;
    readonly instruction_id: string;
    readonly project_id: string;
    readonly attempt: number;
    readonly correlation_id: string;
  };
  readonly raw_outcome: RawExecutorOutcome;
  readonly agent_claims: readonly string[];
}

export interface ExecutorAvailability {
  readonly available: boolean;
  readonly reason?: string | null;
  readonly version?: string | null;
}

// ============================================================================
// 7. DETERMINISTIC HELPERS & VALIDATION
// ============================================================================

export function generateDeterministicCorrelationId(
  projectId: string,
  taskId: string,
  instructionId: string,
  attempt: number
): string {
  return `corr:${projectId}:${taskId}:${instructionId}:${attempt}`;
}

export function validateExecutorInstruction(input: unknown): ExecutorInstruction {
  if (!input || typeof input !== 'object') {
    throw new InvalidExecutorInstructionError('Executor instruction must be a non-null object', {
      reason: 'NON_OBJECT_INPUT',
    });
  }

  const raw = input as ExecutorInstructionInput;

  // 1. Task ID & Instruction ID
  const taskId = (raw.task_id ?? raw.taskId)?.trim();
  const instructionId = (raw.instruction_id ?? raw.instructionId)?.trim();

  if (!taskId) {
    throw new InvalidExecutorInstructionError('Instruction task_id is required and cannot be empty', {
      field: 'task_id',
      taskId,
      instructionId,
      reason: 'MISSING_TASK_ID',
    });
  }

  if (!instructionId) {
    throw new InvalidExecutorInstructionError('Instruction instruction_id is required and cannot be empty', {
      field: 'instruction_id',
      taskId,
      instructionId,
      reason: 'MISSING_INSTRUCTION_ID',
    });
  }

  // 2. Project ID
  const projectId = (raw.project_id ?? raw.projectId)?.trim();
  if (!projectId) {
    throw new InvalidExecutorInstructionError('Instruction project_id is required and cannot be empty', {
      field: 'project_id',
      taskId,
      instructionId,
      reason: 'MISSING_PROJECT_ID',
    });
  }

  // 3. Working Directory
  const workingDir = (raw.working_directory ?? raw.workingDirectory)?.trim();
  if (!workingDir) {
    throw new InvalidExecutorInstructionError('Instruction working_directory is required and cannot be empty', {
      field: 'working_directory',
      taskId,
      instructionId,
      reason: 'MISSING_WORKING_DIRECTORY',
    });
  }

  // 4. Objective
  const objective = raw.objective?.trim();
  if (!objective) {
    throw new InvalidExecutorInstructionError('Instruction objective is required and cannot be empty', {
      field: 'objective',
      taskId,
      instructionId,
      reason: 'MISSING_OBJECTIVE',
    });
  }

  // 5. Acceptance Criteria
  const rawAc = raw.acceptance_criteria ?? raw.acceptanceCriteria;
  if (!Array.isArray(rawAc) || rawAc.length === 0) {
    throw new InvalidExecutorInstructionError(
      'Instruction acceptance_criteria must be a non-empty array of criteria strings',
      {
        field: 'acceptance_criteria',
        taskId,
        instructionId,
        reason: 'EMPTY_ACCEPTANCE_CRITERIA',
      }
    );
  }
  const acceptanceCriteria = rawAc.map((ac, idx) => {
    if (typeof ac !== 'string' || !ac.trim()) {
      throw new InvalidExecutorInstructionError(
        `Acceptance criterion at index ${idx} must be a non-empty string`,
        {
          field: `acceptance_criteria[${idx}]`,
          taskId,
          instructionId,
          reason: 'INVALID_ACCEPTANCE_CRITERION',
        }
      );
    }
    return ac.trim();
  });

  // 6. Constraints
  const rawConstraints = raw.constraints;
  const constraints: string[] = [];
  if (rawConstraints !== undefined) {
    if (!Array.isArray(rawConstraints)) {
      throw new InvalidExecutorInstructionError('Instruction constraints must be an array of strings', {
        field: 'constraints',
        taskId,
        instructionId,
        reason: 'INVALID_CONSTRAINTS',
      });
    }
    for (let i = 0; i < rawConstraints.length; i++) {
      const c = rawConstraints[i];
      if (typeof c !== 'string') {
        throw new InvalidExecutorInstructionError(`Constraint at index ${i} must be a string`, {
          field: `constraints[${i}]`,
          taskId,
          instructionId,
          reason: 'INVALID_CONSTRAINT_TYPE',
        });
      }
      constraints.push(c.trim());
    }
  }

  // 7. Attempt and Max Attempts (Invariants: integers >= 1, attempt <= max_attempts)
  const attempt = raw.attempt;
  const maxAttempts = raw.max_attempts ?? raw.maxAttempts;

  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidExecutorInstructionError(
      `Instruction attempt must be a positive integer >= 1 (received: ${attempt})`,
      {
        field: 'attempt',
        taskId,
        instructionId,
        reason: 'INVALID_ATTEMPT_NUMBER',
      }
    );
  }

  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InvalidExecutorInstructionError(
      `Instruction max_attempts must be a positive integer >= 1 (received: ${maxAttempts})`,
      {
        field: 'max_attempts',
        taskId,
        instructionId,
        reason: 'INVALID_MAX_ATTEMPTS',
      }
    );
  }

  if (attempt > maxAttempts) {
    throw new InvalidExecutorInstructionError(
      `Instruction attempt (${attempt}) cannot exceed max_attempts (${maxAttempts})`,
      {
        field: 'attempt',
        taskId,
        instructionId,
        reason: 'ATTEMPT_EXCEEDS_MAX_ATTEMPTS',
      }
    );
  }

  // 8. Risk Level Classification (Separate from authorization decision!)
  const riskLevel = raw.risk_level ?? raw.riskLevel;
  if (!isRiskLevel(riskLevel)) {
    throw new InvalidExecutorInstructionError(
      `Instruction risk_level must be a valid RiskLevel (SAFE, CAUTION, DANGEROUS, CRITICAL), received: ${riskLevel}`,
      {
        field: 'risk_level',
        taskId,
        instructionId,
        reason: 'INVALID_RISK_LEVEL',
      }
    );
  }

  // 9. Requested Operation Type
  const opType =
    raw.requested_operation_type ??
    raw.requestedOperationType ??
    raw.operation_type ??
    raw.operationType;

  if (!isExecutorOperationType(opType)) {
    throw new InvalidExecutorInstructionError(
      `Instruction requested_operation_type must be a valid ExecutorOperationType, received: ${opType}`,
      {
        field: 'requested_operation_type',
        taskId,
        instructionId,
        reason: 'INVALID_OPERATION_TYPE',
      }
    );
  }

  // 10. Traceability Information (Must have at least 1 valid source)
  const traceabilitySources =
    raw.traceability_information?.sources ??
    raw.traceabilityInformation?.sources ??
    raw.traceability_sources ??
    raw.traceabilitySources ??
    [];

  if (!Array.isArray(traceabilitySources) || traceabilitySources.length === 0) {
    throw new InvalidExecutorInstructionError(
      'Instruction traceability_information must contain at least one traceability source (REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT)',
      {
        field: 'traceability_information.sources',
        taskId,
        instructionId,
        reason: 'MISSING_TRACEABILITY_SOURCES',
      }
    );
  }

  const validCategories = TRACEABILITY_CATEGORIES as readonly string[];
  for (const src of traceabilitySources) {
    if (typeof src !== 'string' || !src.trim()) {
      throw new InvalidExecutorInstructionError('Traceability source must be a non-empty string', {
        field: 'traceability_information.sources',
        taskId,
        instructionId,
        reason: 'INVALID_TRACEABILITY_SOURCE',
      });
    }
    const hasValidPrefix = validCategories.some((cat) =>
      src.startsWith(`${cat}:`) || src.startsWith(`${cat}-`) || src === cat
    );
    if (!hasValidPrefix) {
      throw new InvalidExecutorInstructionError(
        `Traceability source "${src}" does not match recognized categories (${validCategories.join(', ')})`,
        {
          field: 'traceability_information.sources',
          taskId,
          instructionId,
          reason: 'INVALID_TRACEABILITY_CATEGORY',
        }
      );
    }
  }

  const parentFeatureId =
    raw.traceability_information?.parent_feature_id ??
    raw.traceabilityInformation?.parent_feature_id ??
    raw.parent_feature_id ??
    raw.parentFeatureId;

  // 11. Relevant Context
  const relevantContext = raw.relevant_context ?? raw.relevantContext ?? {};

  // 12. Correlation ID
  const correlationId =
    (raw.correlation_id ?? raw.correlationId)?.trim() ||
    generateDeterministicCorrelationId(projectId, taskId, instructionId, attempt);

  // 13. Policy Authorization Decision (Crucial: NEVER fabricated as AUTHORIZED!)
  const rawPolicy =
    raw.policy_decision ??
    raw.policyDecision ??
    raw.policy_authorization ??
    raw.policyAuthorization;

  let policyDecision: PolicyAuthorizationDecision;
  if (rawPolicy && typeof rawPolicy === 'object' && isPolicyAuthorizationState(rawPolicy.state)) {
    policyDecision = Object.freeze({
      state: rawPolicy.state,
      decided_by: rawPolicy.decided_by ?? null,
      decided_at: rawPolicy.decided_at ?? null,
      policy_rule: rawPolicy.policy_rule ?? null,
      justification: rawPolicy.justification ?? null,
      decision_token: rawPolicy.decision_token ?? null,
      reason: rawPolicy.reason ?? null,
    });
  } else {
    // When no policy decision is supplied, represent state explicitly as POLICY_UNAVAILABLE.
    // Do NOT fabricate AUTHORIZED even for SAFE or CAUTION tasks.
    policyDecision = Object.freeze({
      state: PolicyAuthorizationState.POLICY_UNAVAILABLE,
      decided_by: null,
      decided_at: null,
      policy_rule: null,
      justification: null,
      decision_token: null,
      reason: 'No policy authorization decision supplied; policy engine unavailable at this phase',
    });
  }

  return Object.freeze({
    task_id: taskId,
    instruction_id: instructionId,
    project_id: projectId,
    working_directory: workingDir,
    objective,
    acceptance_criteria: Object.freeze([...acceptanceCriteria]),
    constraints: Object.freeze([...constraints]),
    relevant_context: Object.freeze({ ...relevantContext }),
    attempt,
    max_attempts: maxAttempts,
    risk_level: riskLevel,
    requested_operation_type: opType,
    traceability_information: Object.freeze({
      sources: Object.freeze([...traceabilitySources]),
      parent_feature_id: parentFeatureId,
    }),
    correlation_id: correlationId,
    policy_decision: policyDecision,
    policy_authorization: policyDecision,
  });
}

// ============================================================================
// 8. SECURITY & POLICY BOUNDARY VALIDATOR (Requirement 7)
// ============================================================================

export function validateInstructionSecurity(instruction: ExecutorInstruction): void {
  // 1. Working directory path traversal safety check
  if (instruction.working_directory.includes('..') && !instruction.working_directory.startsWith('/')) {
    throw new PolicyViolationError(
      `Working directory contains path traversal and is not a safe normalized path: ${instruction.working_directory}`,
      {
        operation: instruction.requested_operation_type,
        target: instruction.working_directory,
        suggestedAction: 'BLOCK',
        policyRule: 'WORKSPACE_ESCAPE_PREVENTION',
      }
    );
  }

  // 2. Policy Authorization Boundary: Must be explicitly AUTHORIZED
  if (instruction.policy_decision.state !== PolicyAuthorizationState.AUTHORIZED) {
    const suggestedAction =
      instruction.policy_decision.state === PolicyAuthorizationState.HUMAN_REQUIRED ||
      instruction.risk_level === RiskLevel.CRITICAL
        ? 'REQUIRE_HUMAN'
        : 'BLOCK';

    throw new PolicyViolationError(
      `Execution blocked by policy boundary: instruction authorization state is ${instruction.policy_decision.state} (reason: ${instruction.policy_decision.reason || 'No authorization'}). Protected operation cannot proceed without explicit AUTHORIZED policy decision.`,
      {
        operation: instruction.requested_operation_type,
        riskLevel: instruction.risk_level,
        policyState: instruction.policy_decision.state,
        suggestedAction,
        policyRule: 'POLICY_DECISION_REQUIRED',
      }
    );
  }

  // 3. CRITICAL operations strictly require verified human authorization (Actor: USER) and a valid decision token
  if (instruction.risk_level === RiskLevel.CRITICAL) {
    const isHuman = instruction.policy_decision.decided_by === 'USER';
    const hasToken =
      typeof instruction.policy_decision.decision_token === 'string' &&
      instruction.policy_decision.decision_token.trim().length > 0;

    if (!isHuman || !hasToken) {
      throw new PolicyViolationError(
        `Operation with CRITICAL risk classification requires verified human authorization (Actor: USER) with a valid decision token. A mere string claim is insufficient proof.`,
        {
          operation: instruction.requested_operation_type,
          riskLevel: RiskLevel.CRITICAL,
          policyState: instruction.policy_decision.state,
          suggestedAction: 'REQUIRE_HUMAN',
          policyRule: 'CRITICAL_RISK_REQUIRES_HUMAN_PROOF',
        }
      );
    }
  }
}

// ============================================================================
// 9. DETERMINISTIC NORMALIZATION FUNCTION (Requirement 2, 6, 8)
// ============================================================================

export function normalizeRawExecutorOutcome(
  outcome: RawExecutorOutcome,
  instruction: ExecutorInstruction,
  providerIdentity: { provider: string; name: string; version?: string | null }
): NormalizedExecutorResult {
  // Determine exit termination information without fabricating metrics
  const hasCode = typeof outcome.exit_code === 'number';
  const hasSignal = typeof outcome.signal === 'string' && outcome.signal.length > 0;
  const exitInfo =
    hasCode || hasSignal
      ? Object.freeze({
          code: hasCode ? outcome.exit_code! : null,
          signal: hasSignal ? outcome.signal! : null,
          terminated: true,
        })
      : null;

  // Determine success and status deterministically
  let success = false;
  let status: ExecutorExecutionStatus = ExecutorExecutionStatus.FAILED;

  if (hasCode && outcome.exit_code === 0) {
    success = true;
    status = ExecutorExecutionStatus.COMPLETED;
  } else if (hasSignal) {
    success = false;
    status =
      outcome.signal === 'SIGTERM' || outcome.signal === 'SIGINT'
        ? ExecutorExecutionStatus.CANCELLED
        : ExecutorExecutionStatus.FAILED;
  } else if (hasCode && outcome.exit_code !== 0) {
    success = false;
    status = ExecutorExecutionStatus.FAILED;
  }

  // Stdout & Stderr: strictly preserve or null (no fabrication)
  const stdout = outcome.stdout !== undefined && outcome.stdout !== null ? outcome.stdout : null;
  const stderr = outcome.stderr !== undefined && outcome.stderr !== null ? outcome.stderr : null;

  // Changed files: preserve unverified changed files or null (do NOT fabricate empty array if unavailable)
  const changedFiles =
    outcome.unverified_changed_files !== undefined && outcome.unverified_changed_files !== null
      ? Object.freeze([...outcome.unverified_changed_files])
      : null;

  // Execution timing: preserve only what is actually provided
  const timing = outcome.timing
    ? Object.freeze({
        started_at: outcome.timing.started_at ?? null,
        completed_at: outcome.timing.completed_at ?? null,
        duration_ms:
          typeof outcome.timing.duration_ms === 'number' ? outcome.timing.duration_ms : null,
      })
    : null;

  // Error details: populated when not successful
  let error: { code: string; message: string; details?: unknown } | null = null;
  if (!success) {
    const errorMsg =
      stderr?.trim() ||
      (hasSignal ? `Terminated with signal ${outcome.signal}` : null) ||
      (hasCode ? `Executor process exited with non-zero code ${outcome.exit_code}` : null) ||
      'Executor execution failed';

    error = Object.freeze({
      code: 'ERR_EXECUTOR_EXECUTION_FAILURE',
      message: errorMsg,
      details: {
        exitCode: outcome.exit_code ?? null,
        signal: outcome.signal ?? null,
        executorId: outcome.executor_id,
      },
    });
  }

  // Correlation identifiers
  const correlation = Object.freeze({
    task_id: instruction.task_id,
    instruction_id: instruction.instruction_id,
    project_id: instruction.project_id,
    attempt: instruction.attempt,
    correlation_id: instruction.correlation_id,
  });

  // Agent claims: explicitly isolated as unverified strings
  const agentClaims = outcome.agent_claims ? Object.freeze([...outcome.agent_claims]) : Object.freeze([]);

  return Object.freeze({
    success,
    status,
    exit_info: exitInfo,
    stdout,
    stderr,
    changed_files: changedFiles,
    executor_identity: Object.freeze({
      provider: providerIdentity.provider,
      name: providerIdentity.name,
      version: providerIdentity.version ?? null,
    }),
    timing,
    error,
    correlation,
    raw_outcome: outcome,
    agent_claims: agentClaims,
  });
}
