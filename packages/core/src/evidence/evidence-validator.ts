import {
  EvidenceType,
  isEvidenceType,
  EvidenceSource,
  EvidenceValidationStatus,
  type SystemVerifiedEvidence,
  type SystemVerifiedEvidenceInput,
  type AgentClaim,
  type EvidenceValidationIssue,
  type EvidenceValidationResult,
  EVIDENCE_TYPES,
} from './evidence-types.js';
import {
  sanitizeEvidenceSecrets,
  InvalidEvidenceError,
  MissingEvidenceFieldError,
  MalformedFileHashError,
  InvalidExecutionMetadataError,
  InvalidEvidenceSourceError,
  InvalidEvidenceTypeError,
  InvalidGitReferenceError,
  InvalidCommandError,
  InvalidExitCodeError,
} from '../errors/evidence-error.js';

// ============================================================================
// REGEX CONSTANTS & INTEGRITY PREDICATES
// ============================================================================

export const SHA256_REGEX = /^[0-9a-fA-F]{64}$/;
export const GIT_SHA1_REGEX = /^[0-9a-fA-F]{40}$/;
export const GIT_SHA256_REGEX = /^[0-9a-fA-F]{64}$/;
export const GIT_REF_FORMAT_REGEX = /^refs\/(heads|tags|remotes|notes)\/[a-zA-Z0-9_.\-\/]+$/;

/**
 * Validates whether a given string is a structurally valid 64-character SHA-256 hexadecimal hash.
 */
export function isValidSha256(hash: unknown): hash is string {
  return typeof hash === 'string' && SHA256_REGEX.test(hash);
}

/**
 * Validates whether a value follows the expected Git reference representation.
 * Must be a 40-character SHA-1 commit hash, 64-character SHA-256 commit hash,
 * 'HEAD', or a valid refs/... qualified reference.
 * Does not permit path traversal ('..'), lock files ('.lock'), control chars, or whitespace.
 */
export function isValidGitReference(ref: unknown): ref is string {
  if (typeof ref !== 'string') return false;
  if (ref.length === 0) return false;

  // Reject whitespace or control characters
  if (/\s|[\x00-\x1f\x7f]/.test(ref)) return false;

  // Reject invalid git reference characters or patterns: ~, ^, :, ?, *, [, \, @{, ..
  if (/[~^:?*\[\\]|@{|\.\./.test(ref)) return false;

  // Cannot end with .lock or slash, or contain consecutive slashes
  if (ref.endsWith('.lock') || ref.endsWith('/') || ref.includes('//')) return false;

  // Direct commit hash match (SHA-1 40-hex or SHA-256 64-hex)
  if (GIT_SHA1_REGEX.test(ref) || GIT_SHA256_REGEX.test(ref)) {
    return true;
  }

  // Symbolic HEAD reference
  if (ref === 'HEAD') {
    return true;
  }

  // Qualified refs/... format
  if (GIT_REF_FORMAT_REGEX.test(ref)) {
    const parts = ref.split('/');
    for (const part of parts) {
      if (part.startsWith('.') || part.endsWith('.')) return false;
    }
    return true;
  }

  return false;
}

/**
 * Validates whether a value is a valid process exit code representation (integer between 0 and 255).
 */
export function isValidExitCode(code: unknown): code is number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255;
}

/**
 * Validates whether execution duration in milliseconds is a valid non-negative finite number.
 */
export function isValidExecutionTimeMs(time: unknown): time is number {
  return typeof time === 'number' && Number.isFinite(time) && !Number.isNaN(time) && time >= 0;
}

/**
 * Creates an AgentClaim object.
 * An AgentClaim is an unverified assertion and can never be accepted as SystemVerifiedEvidence.
 */
export function createAgentClaim(input: {
  claim_id?: string;
  task_id: string;
  statement: string;
  instruction_id?: string | null;
  project_id?: string | null;
  correlation_id?: string | null;
  claimed_at?: string | null;
  metadata?: Record<string, unknown> | null;
}): AgentClaim {
  return Object.freeze({
    claim_id: input.claim_id ?? `claim:${input.task_id}:unverified`,
    source: EvidenceSource.AGENT_CLAIM,
    task_id: input.task_id,
    statement: input.statement,
    instruction_id: input.instruction_id ?? null,
    project_id: input.project_id ?? null,
    correlation_id: input.correlation_id ?? null,
    claimed_at: input.claimed_at ?? null,
    metadata: input.metadata ? Object.freeze({ ...input.metadata }) : null,
  });
}

// ============================================================================
// DETERMINISTIC EVIDENCE VALIDATOR
// ============================================================================

/**
 * Deterministically validates an evidence payload against SystemVerifiedEvidence integrity rules.
 * Does not depend on external state, current time, or randomness.
 * Sanitizes any secret-like strings so they are never exposed in issues.
 */
export function validateSystemVerifiedEvidence(input: unknown): EvidenceValidationResult {
  // 1. Structure check: input must be a non-null object
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      status: EvidenceValidationStatus.INVALID,
      valid: false,
      issues: Object.freeze([
        {
          code: 'ERR_INVALID_EVIDENCE',
          message: 'Evidence must be a non-null object',
        },
      ]),
    };
  }

  const raw = input as SystemVerifiedEvidenceInput & Record<string, unknown>;
  const issues: EvidenceValidationIssue[] = [];

  function addIssue(code: string, field: string | undefined, rawMessage: string, details?: Record<string, unknown>): void {
    issues.push(
      Object.freeze({
        code,
        field,
        message: sanitizeEvidenceSecrets(rawMessage),
        details: details ? Object.freeze({ ...details }) : undefined,
      })
    );
  }

  // 2. Evidence Separation: AGENT_CLAIM must NEVER validate as SYSTEM_VERIFIED_EVIDENCE
  const isAgentClaimSource =
    raw.source === EvidenceSource.AGENT_CLAIM ||
    raw.source_type === EvidenceSource.AGENT_CLAIM ||
    raw.sourceType === EvidenceSource.AGENT_CLAIM ||
    raw.is_agent_claim === true ||
    raw.isAgentClaim === true;

  if (isAgentClaimSource) {
    addIssue(
      'ERR_INVALID_EVIDENCE_SOURCE',
      'source',
      'AGENT_CLAIM cannot satisfy SYSTEM_VERIFIED_EVIDENCE validation. Agent claims are unverified assertions and cannot be accepted as system evidence.',
      { source: raw.source ?? raw.source_type ?? raw.sourceType }
    );
    return {
      status: EvidenceValidationStatus.INVALID,
      valid: false,
      issues: Object.freeze(issues),
    };
  }

  // Check explicit source if provided
  if (raw.source !== undefined && raw.source !== null && raw.source !== EvidenceSource.SYSTEM_VERIFIED_EVIDENCE) {
    addIssue(
      'ERR_INVALID_EVIDENCE_SOURCE',
      'source',
      `Invalid evidence source '${String(raw.source)}'. Expected '${EvidenceSource.SYSTEM_VERIFIED_EVIDENCE}'.`,
      { source: raw.source }
    );
  }

  // 3. Evidence Type check
  const rawType = raw.evidence_type ?? raw.evidenceType ?? EvidenceType.COMMAND;
  if (!isEvidenceType(rawType)) {
    addIssue(
      'ERR_INVALID_EVIDENCE_TYPE',
      'evidence_type',
      `Invalid evidence_type '${String(rawType)}'. Must be one of: ${EVIDENCE_TYPES.join(', ')}.`,
      { evidence_type: rawType }
    );
  }

  // 4. Identity Integrity (Rule A)
  // evidence_id
  const evidenceId = (raw.evidence_id ?? raw.evidenceId);
  if (evidenceId === undefined || evidenceId === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'evidence_id', 'Missing mandatory evidence field: evidence_id');
  } else if (typeof evidenceId !== 'string' || evidenceId.trim().length === 0) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'evidence_id', 'Evidence evidence_id cannot be an empty string');
  }

  // task_id
  const taskId = (raw.task_id ?? raw.taskId);
  if (taskId === undefined || taskId === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'task_id', 'Missing mandatory evidence field: task_id');
  } else if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'task_id', 'Evidence task_id cannot be an empty string');
  }

  // project_id
  const projectId = (raw.project_id ?? raw.projectId);
  if (projectId === undefined || projectId === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'project_id', 'Missing mandatory evidence field: project_id');
  } else if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'project_id', 'Evidence project_id cannot be an empty string');
  }

  // correlation_id
  const correlationId = (raw.correlation_id ?? raw.correlationId);
  if (correlationId === undefined || correlationId === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'correlation_id', 'Missing mandatory evidence field: correlation_id');
  } else if (typeof correlationId !== 'string' || correlationId.trim().length === 0) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'correlation_id', 'Evidence correlation_id cannot be an empty string');
  }

  // instruction_id (optional semantic field, preserved if provided)
  const rawInstructionId = raw.instruction_id ?? raw.instructionId;
  const instructionId = rawInstructionId !== undefined && rawInstructionId !== null
    ? String(rawInstructionId).trim()
    : null;

  // 5. Command Integrity (Rule B)
  // command
  if (raw.command === undefined || raw.command === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'command', 'Missing mandatory evidence field: command');
  } else if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    addIssue('ERR_INVALID_COMMAND', 'command', 'Evidence command must be a non-empty string');
  }

  // working_directory
  const workingDir = (raw.working_directory ?? raw.workingDirectory);
  if (workingDir === undefined || workingDir === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'working_directory', 'Missing mandatory evidence field: working_directory');
  } else if (typeof workingDir !== 'string' || workingDir.trim().length === 0) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'working_directory', 'Evidence working_directory cannot be an empty string');
  }

  // exit_code
  const exitCode = raw.exit_code !== undefined ? raw.exit_code : raw.exitCode;
  if (exitCode === undefined || exitCode === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'exit_code', 'Missing mandatory evidence field: exit_code');
  } else if (!isValidExitCode(exitCode)) {
    addIssue(
      'ERR_INVALID_EXIT_CODE',
      'exit_code',
      `Invalid process exit representation: ${String(exitCode)}. Exit code must be a non-negative integer between 0 and 255.`,
      { exit_code: exitCode }
    );
  }

  // 6. Execution Integrity (Rule C)
  // execution_time_ms
  const executionTimeMs = raw.execution_time_ms !== undefined ? raw.execution_time_ms : raw.executionTimeMs;
  if (executionTimeMs === undefined || executionTimeMs === null) {
    addIssue('ERR_MISSING_EVIDENCE_FIELD', 'execution_time_ms', 'Missing mandatory evidence field: execution_time_ms');
  } else if (!isValidExecutionTimeMs(executionTimeMs)) {
    addIssue(
      'ERR_INVALID_EXECUTION_METADATA',
      'execution_time_ms',
      `Invalid execution metadata: execution_time_ms must be a non-negative finite number (received: ${String(executionTimeMs)})`,
      { execution_time_ms: executionTimeMs }
    );
  }

  // 7. Git Integrity (Rule D)
  // git_head_before
  const gitHeadBefore = raw.git_head_before !== undefined ? raw.git_head_before : raw.gitHeadBefore;
  if (gitHeadBefore !== undefined && gitHeadBefore !== null) {
    if (!isValidGitReference(gitHeadBefore)) {
      addIssue(
        'ERR_INVALID_GIT_REFERENCE',
        'git_head_before',
        `Invalid Git reference representation for git_head_before: '${String(gitHeadBefore)}'`,
        { git_head_before: gitHeadBefore }
      );
    }
  }

  // git_head_after
  const gitHeadAfter = raw.git_head_after !== undefined ? raw.git_head_after : raw.gitHeadAfter;
  if (gitHeadAfter !== undefined && gitHeadAfter !== null) {
    if (!isValidGitReference(gitHeadAfter)) {
      addIssue(
        'ERR_INVALID_GIT_REFERENCE',
        'git_head_after',
        `Invalid Git reference representation for git_head_after: '${String(gitHeadAfter)}'`,
        { git_head_after: gitHeadAfter }
      );
    }
  }

  // 8. File Integrity (Rule E)
  // file_hashes_after
  const rawHashes = raw.file_hashes_after !== undefined ? raw.file_hashes_after : raw.fileHashesAfter;
  let fileHashesAfter: Record<string, string> | null = null;
  if (rawHashes !== undefined && rawHashes !== null) {
    if (typeof rawHashes !== 'object' || Array.isArray(rawHashes)) {
      addIssue(
        'ERR_INVALID_EVIDENCE',
        'file_hashes_after',
        'file_hashes_after must be an object map of file paths to SHA-256 hashes'
      );
    } else {
      fileHashesAfter = {};
      const sortedKeys = Object.keys(rawHashes).sort();
      for (const filePath of sortedKeys) {
        const hashValue = (rawHashes as Record<string, unknown>)[filePath];
        if (!isValidSha256(hashValue)) {
          addIssue(
            'ERR_MALFORMED_FILE_HASH',
            `file_hashes_after[${filePath}]`,
            `Malformed SHA-256 file hash for '${filePath}': '${String(hashValue)}'. Must be a 64-character hexadecimal string.`,
            { filePath, hash: hashValue }
          );
        } else {
          fileHashesAfter[filePath] = hashValue;
        }
      }
    }
  }

  // 9. Evaluate validation verdict
  if (issues.length > 0) {
    return {
      status: EvidenceValidationStatus.INVALID,
      valid: false,
      issues: Object.freeze(issues),
    };
  }

  // Build canonical, deeply frozen SystemVerifiedEvidence instance
  const stdoutTail = raw.stdout_tail !== undefined
    ? (raw.stdout_tail ?? null)
    : (raw.stdoutTail !== undefined ? (raw.stdoutTail ?? null) : null);

  const stderr = raw.stderr !== undefined ? (raw.stderr ?? null) : null;

  const unifiedDiff = raw.unified_diff !== undefined
    ? (raw.unified_diff ?? null)
    : (raw.unifiedDiff !== undefined ? (raw.unifiedDiff ?? null) : null);

  const rawExecutor = raw.executor_identity ?? raw.executorIdentity;
  const executorIdentity = rawExecutor && typeof rawExecutor === 'object'
    ? Object.freeze({
        provider: String(rawExecutor.provider),
        name: String(rawExecutor.name),
        version: rawExecutor.version ? String(rawExecutor.version) : null,
      })
    : null;

  const capturedAt = raw.captured_at ?? raw.capturedAt ?? null;
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? Object.freeze({ ...raw.metadata })
    : null;

  const canonicalEvidence: SystemVerifiedEvidence = Object.freeze({
    evidence_id: String(evidenceId).trim(),
    task_id: String(taskId).trim(),
    instruction_id: instructionId,
    project_id: String(projectId).trim(),
    correlation_id: String(correlationId).trim(),
    command: String(raw.command).trim(),
    exit_code: exitCode as number,
    stdout_tail: stdoutTail !== null ? String(stdoutTail) : null,
    stderr: stderr !== null ? String(stderr) : null,
    working_directory: String(workingDir).trim(),
    execution_time_ms: executionTimeMs as number,
    git_head_before: gitHeadBefore ? String(gitHeadBefore) : null,
    git_head_after: gitHeadAfter ? String(gitHeadAfter) : null,
    unified_diff: unifiedDiff !== null ? String(unifiedDiff) : null,
    file_hashes_after: fileHashesAfter ? Object.freeze({ ...fileHashesAfter }) : null,
    evidence_type: rawType as EvidenceType,
    executor_identity: executorIdentity,
    captured_at: capturedAt ? String(capturedAt) : null,
    metadata,
    source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
  });

  return {
    status: EvidenceValidationStatus.VALID,
    valid: true,
    evidence: canonicalEvidence,
    issues: Object.freeze([]),
  };
}

/**
 * Validates an evidence input or throws a structured, typed EvidenceError subclass.
 */
export function assertValidSystemVerifiedEvidence(input: unknown): SystemVerifiedEvidence {
  const result = validateSystemVerifiedEvidence(input);
  if (!result.valid) {
    const firstIssue = result.issues[0];
    const details = {
      field: firstIssue.field,
      reason: firstIssue.message,
      validationErrors: result.issues.map((i) => `[${i.code}] ${i.message}`),
      ...firstIssue.details,
    };

    switch (firstIssue.code) {
      case 'ERR_MISSING_EVIDENCE_FIELD':
        throw new MissingEvidenceFieldError(firstIssue.message, details);
      case 'ERR_MALFORMED_FILE_HASH':
        throw new MalformedFileHashError(firstIssue.message, details);
      case 'ERR_INVALID_EXECUTION_METADATA':
        throw new InvalidExecutionMetadataError(firstIssue.message, details);
      case 'ERR_INVALID_EVIDENCE_SOURCE':
        throw new InvalidEvidenceSourceError(firstIssue.message, details);
      case 'ERR_INVALID_EVIDENCE_TYPE':
        throw new InvalidEvidenceTypeError(firstIssue.message, details);
      case 'ERR_INVALID_GIT_REFERENCE':
        throw new InvalidGitReferenceError(firstIssue.message, details);
      case 'ERR_INVALID_COMMAND':
        throw new InvalidCommandError(firstIssue.message, details);
      case 'ERR_INVALID_EXIT_CODE':
        throw new InvalidExitCodeError(firstIssue.message, details);
      default:
        throw new InvalidEvidenceError(firstIssue.message, details);
    }
  }

  return result.evidence!;
}
