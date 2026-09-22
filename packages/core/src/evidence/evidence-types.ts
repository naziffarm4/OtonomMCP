/**
 * Phase 4 Evidence Domain Model & Verification Contracts
 *
 * Defines strongly typed evidence contracts, strict separation between
 * AGENT_CLAIM and SYSTEM_VERIFIED_EVIDENCE, and deterministic validation results.
 */

// ============================================================================
// 1. EVIDENCE CLASSIFICATION TYPES
// ============================================================================

export const EvidenceType = {
  COMMAND: 'COMMAND',
  TEST: 'TEST',
  BUILD: 'BUILD',
  GIT: 'GIT',
  DIFF: 'DIFF',
  FILE_HASH: 'FILE_HASH',
} as const;

export type EvidenceType = (typeof EvidenceType)[keyof typeof EvidenceType];
export const EVIDENCE_TYPES = Object.values(EvidenceType) as readonly EvidenceType[];

export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(value);
}

// ============================================================================
// 2. EVIDENCE SOURCE TYPES (AGENT_CLAIM vs SYSTEM_VERIFIED_EVIDENCE)
// ============================================================================

export const EvidenceSource = {
  SYSTEM_VERIFIED_EVIDENCE: 'SYSTEM_VERIFIED_EVIDENCE',
  AGENT_CLAIM: 'AGENT_CLAIM',
} as const;

export type EvidenceSource = (typeof EvidenceSource)[keyof typeof EvidenceSource];
export const EVIDENCE_SOURCES = Object.values(EvidenceSource) as readonly EvidenceSource[];

export function isEvidenceSource(value: unknown): value is EvidenceSource {
  return typeof value === 'string' && (EVIDENCE_SOURCES as readonly string[]).includes(value);
}

// ============================================================================
// 3. EVIDENCE VALIDATION STATUS
// ============================================================================

export const EvidenceValidationStatus = {
  VALID: 'VALID',
  INVALID: 'INVALID',
} as const;

export type EvidenceValidationStatus =
  (typeof EvidenceValidationStatus)[keyof typeof EvidenceValidationStatus];

// ============================================================================
// 4. EXECUTOR IDENTITY CONTRACT
// ============================================================================

export interface ExecutorIdentity {
  readonly provider: string;
  readonly name: string;
  readonly version?: string | null;
}

// ============================================================================
// 5. SYSTEM VERIFIED EVIDENCE CONTRACT
// ============================================================================

/**
 * Verifiable execution evidence originating deterministically from the operating system,
 * Git, or test/build runtime execution.
 *
 * An AGENT_CLAIM must NEVER satisfy this contract.
 */
export interface SystemVerifiedEvidence {
  /** Unique deterministic or cryptographic evidence identifier */
  readonly evidence_id: string;
  /** Task identifier associated with this evidence */
  readonly task_id: string;
  /** Associated instruction ID if applicable, otherwise null */
  readonly instruction_id: string | null;
  /** Project identifier */
  readonly project_id: string;
  /** Correlation identifier linking instruction and execution */
  readonly correlation_id: string;
  /** Executed OS command */
  readonly command: string;
  /** Deterministic process exit code (valid integer 0..255) */
  readonly exit_code: number;
  /** Tail of standard output, or null if unavailable / not captured */
  readonly stdout_tail: string | null;
  /** Standard error output, or null if unavailable / not captured */
  readonly stderr: string | null;
  /** Operating system working directory where command executed */
  readonly working_directory: string;
  /** Wall clock execution duration in milliseconds (>= 0) */
  readonly execution_time_ms: number;
  /** Git HEAD reference/commit SHA before command execution, or null if unavailable */
  readonly git_head_before: string | null;
  /** Git HEAD reference/commit SHA after command execution, or null if unavailable */
  readonly git_head_after: string | null;
  /** Unified diff resulting from execution, or null if unavailable / unchanged */
  readonly unified_diff: string | null;
  /** SHA-256 hashes of changed/inspected files after execution, or null if unavailable */
  readonly file_hashes_after: Readonly<Record<string, string>> | null;
  /** Classification of evidence */
  readonly evidence_type: EvidenceType;
  /** Identity of executor that captured or observed the execution, if applicable */
  readonly executor_identity: ExecutorIdentity | null;
  /** ISO 8601 timestamp when evidence was captured, or null if unavailable */
  readonly captured_at: string | null;
  /** Free-form structured metadata */
  readonly metadata: Readonly<Record<string, unknown>> | null;
  /** Explicit source discriminator: strictly SYSTEM_VERIFIED_EVIDENCE */
  readonly source: 'SYSTEM_VERIFIED_EVIDENCE';
}

// ============================================================================
// 6. AGENT CLAIM CONTRACT (EXPLICITLY SEPARATE)
// ============================================================================

/**
 * An unverified assertion made by an agent or LLM.
 * Strictly distinct from SYSTEM_VERIFIED_EVIDENCE.
 */
export interface AgentClaim {
  readonly claim_id: string;
  readonly source: 'AGENT_CLAIM';
  readonly task_id: string;
  readonly statement: string;
  readonly instruction_id: string | null;
  readonly project_id: string | null;
  readonly correlation_id: string | null;
  readonly claimed_at: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

// ============================================================================
// 7. INPUT CONTRACT (Accepts snake_case or camelCase)
// ============================================================================

export interface SystemVerifiedEvidenceInput {
  evidence_id?: string;
  evidenceId?: string;
  task_id?: string;
  taskId?: string;
  instruction_id?: string | null;
  instructionId?: string | null;
  project_id?: string;
  projectId?: string;
  correlation_id?: string;
  correlationId?: string;
  command?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  stdout_tail?: string | null;
  stdoutTail?: string | null;
  stderr?: string | null;
  working_directory?: string;
  workingDirectory?: string;
  execution_time_ms?: number | null;
  executionTimeMs?: number | null;
  git_head_before?: string | null;
  gitHeadBefore?: string | null;
  git_head_after?: string | null;
  gitHeadAfter?: string | null;
  unified_diff?: string | null;
  unifiedDiff?: string | null;
  file_hashes_after?: Record<string, string> | null;
  fileHashesAfter?: Record<string, string> | null;
  evidence_type?: EvidenceType | string;
  evidenceType?: EvidenceType | string;
  executor_identity?: ExecutorIdentity | null;
  executorIdentity?: ExecutorIdentity | null;
  captured_at?: string | null;
  capturedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  source?: string;
  source_type?: string;
  sourceType?: string;
  is_agent_claim?: boolean;
  isAgentClaim?: boolean;
}

// ============================================================================
// 8. VALIDATION DIAGNOSTICS & RESULT
// ============================================================================

export interface EvidenceValidationIssue {
  readonly code: string;
  readonly field?: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface EvidenceValidationResult {
  readonly status: EvidenceValidationStatus;
  readonly valid: boolean;
  readonly evidence?: SystemVerifiedEvidence;
  readonly issues: readonly EvidenceValidationIssue[];
}
