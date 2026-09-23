import {
  EvidenceType,
  EvidenceSource,
  type SystemVerifiedEvidence,
  type SystemVerifiedEvidenceInput,
  type ExecutorIdentity,
} from './evidence-types.js';
import {
  assertValidSystemVerifiedEvidence,
  validateSystemVerifiedEvidence,
} from './evidence-validator.js';
import {
  type ProcessExecutorPort,
  type ProcessExecutionResult,
  NodeProcessExecutor,
} from './process-executor-port.js';
import {
  type GitObserverPort,
  type GitObservationResult,
  DefaultGitObserver,
} from './git-observer-port.js';
import {
  FileHashCollector,
  type FileHashCollectionOptions,
} from './file-hash-collector.js';
import {
  CommandCollectionError,
  InvalidCollectorInputError,
} from '../errors/collector-error.js';
import { InvalidEvidenceSourceError } from '../errors/evidence-error.js';

// ============================================================================
// CONTRACT INTERFACES FOR EVIDENCE COLLECTOR
// ============================================================================

export interface CommandObservationData {
  readonly command: string;
  readonly exit_code: number;
  readonly stdout?: string | null;
  readonly stdout_tail?: string | null;
  readonly stderr?: string | null;
  readonly working_directory: string;
  readonly execution_time_ms: number;
}

export interface CommandObservationInput {
  evidence_id?: string;
  evidenceId?: string;
  task_id: string;
  taskId?: string;
  instruction_id?: string | null;
  instructionId?: string | null;
  project_id: string;
  projectId?: string;
  correlation_id: string;
  correlationId?: string;
  command: string;
  exit_code?: number | null;
  exitCode?: number | null;
  stdout?: string | null;
  stdout_tail?: string | null;
  stdoutTail?: string | null;
  stderr?: string | null;
  working_directory: string;
  workingDirectory?: string;
  execution_time_ms?: number | null;
  executionTimeMs?: number | null;
  evidence_type?: EvidenceType;
  evidenceType?: EvidenceType;
  executor_identity?: ExecutorIdentity | null;
  executorIdentity?: ExecutorIdentity | null;
  captured_at?: string | null;
  capturedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  source?: string;
}

export interface ExecuteCommandRequest {
  evidence_id?: string;
  evidenceId?: string;
  task_id: string;
  taskId?: string;
  instruction_id?: string | null;
  instructionId?: string | null;
  project_id: string;
  projectId?: string;
  correlation_id: string;
  correlationId?: string;
  command: string;
  working_directory: string;
  workingDirectory?: string;
  timeout_ms?: number;
  evidence_type?: EvidenceType;
  evidenceType?: EvidenceType;
  executor_identity?: ExecutorIdentity | null;
  executorIdentity?: ExecutorIdentity | null;
  captured_at?: string | null;
  capturedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  source?: string;
}

export interface GitObservationData {
  readonly git_head_before?: string | null;
  readonly git_head_after?: string | null;
  readonly unified_diff?: string | null;
}

export interface ComposeEvidenceInput {
  evidence_id?: string;
  evidenceId?: string;
  task_id: string;
  taskId?: string;
  instruction_id?: string | null;
  instructionId?: string | null;
  project_id: string;
  projectId?: string;
  correlation_id: string;
  correlationId?: string;
  evidence_type?: EvidenceType;
  evidenceType?: EvidenceType;
  executor_identity?: ExecutorIdentity | null;
  executorIdentity?: ExecutorIdentity | null;
  captured_at?: string | null;
  capturedAt?: string | null;
  metadata?: Record<string, unknown> | null;

  // Command observation fields
  command?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  stdout?: string | null;
  stdout_tail?: string | null;
  stdoutTail?: string | null;
  stderr?: string | null;
  working_directory?: string;
  workingDirectory?: string;
  execution_time_ms?: number | null;
  executionTimeMs?: number | null;
  command_observation?: CommandObservationData;
  commandObservation?: CommandObservationData;

  // Git observation fields
  git_head_before?: string | null;
  gitHeadBefore?: string | null;
  git_head_after?: string | null;
  gitHeadAfter?: string | null;
  unified_diff?: string | null;
  unifiedDiff?: string | null;
  git_observation?: GitObservationData | null;
  gitObservation?: GitObservationData | null;

  // File hashes
  file_hashes_after?: Record<string, string> | null;
  fileHashesAfter?: Record<string, string> | null;
  file_hashes?: Record<string, string> | null;
  fileHashes?: Record<string, string> | null;

  // Source discriminator / claim rejection
  source?: string;
  is_agent_claim?: boolean;
  isAgentClaim?: boolean;
}

export interface FullEvidenceCollectionRequest {
  evidence_id?: string;
  task_id: string;
  instruction_id?: string | null;
  project_id: string;
  correlation_id: string;
  command: string;
  working_directory: string;
  relevant_files?: readonly string[];
  base_git_head?: string | null;
  timeout_ms?: number;
  evidence_type?: EvidenceType;
  executor_identity?: ExecutorIdentity | null;
  captured_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EvidenceCollectorOptions {
  readonly processExecutor?: ProcessExecutorPort;
  readonly gitObserver?: GitObserverPort;
  readonly fileHashCollector?: FileHashCollector;
}

/**
 * Extracts the tail of stdout text up to a maximum line and byte count.
 */
export function extractStdoutTail(
  stdout: string | null | undefined,
  maxLines = 200,
  maxBytes = 32_768
): string | null {
  if (stdout === null || stdout === undefined) {
    return null;
  }
  if (stdout.length === 0) {
    return '';
  }

  // Byte tailing if oversized
  let content = stdout;
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    const buf = Buffer.from(content, 'utf-8');
    content = buf.subarray(buf.length - maxBytes).toString('utf-8');
  }

  // Line tailing if oversized
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(lines.length - maxLines).join('\n');
  }

  return content;
}

// ============================================================================
// EVIDENCE COLLECTOR IMPLEMENTATION
// ============================================================================

/**
 * Foundational Evidence Collector that captures real, system-observable execution
 * data and produces SystemVerifiedEvidence compatible with TASK-P4-01.
 * 
 * Invariants:
 * - Collects facts: command, exit_code, stdout, stderr, working_directory, duration, Git, hashes.
 * - Source is strictly SYSTEM_VERIFIED_EVIDENCE.
 * - AGENT_CLAIM is strictly rejected and never promoted to system evidence.
 * - Uses dependency injection for OS processes, Git, and file hashing.
 * - Deterministic: identical inputs produce identical evidence.
 * - Never fabricates fake Git SHAs or file hashes.
 * - Zero Git mutations.
 */
export class EvidenceCollector {
  readonly processExecutor: ProcessExecutorPort;
  readonly gitObserver: GitObserverPort;
  readonly fileHashCollector: FileHashCollector;

  constructor(options?: EvidenceCollectorOptions) {
    this.processExecutor = options?.processExecutor ?? new NodeProcessExecutor();
    this.gitObserver = options?.gitObserver ?? new DefaultGitObserver();
    this.fileHashCollector = options?.fileHashCollector ?? new FileHashCollector();
  }

  /**
   * Collects command evidence around an already-observed process outcome.
   * Validates command facts, captures duration, stdout tail, and stderr.
   */
  async collectCommandEvidence(
    input: CommandObservationInput
  ): Promise<SystemVerifiedEvidence> {
    this.assertNotAgentClaim(input);

    const taskId = input.task_id ?? input.taskId;
    const projectId = input.project_id ?? input.projectId;
    const correlationId = input.correlation_id ?? input.correlationId;
    const workingDir = input.working_directory ?? input.workingDirectory;
    const command = input.command;
    const exitCode = input.exit_code !== undefined ? input.exit_code : input.exitCode;
    const executionTimeMs =
      input.execution_time_ms !== undefined ? input.execution_time_ms : input.executionTimeMs;

    if (!taskId || !projectId || !correlationId || !workingDir || !command) {
      throw new CommandCollectionError('Missing required fields for command evidence collection', {
        taskId,
        correlationId,
        command,
        workingDirectory: workingDir,
        reason: 'MISSING_REQUIRED_FIELDS',
      });
    }

    if (exitCode === undefined || exitCode === null || executionTimeMs === undefined || executionTimeMs === null) {
      throw new CommandCollectionError(
        'Exit code and execution duration are mandatory for already-executed command observation',
        {
          taskId,
          correlationId,
          command,
          workingDirectory: workingDir,
          reason: 'MISSING_EXECUTION_OUTCOME',
        }
      );
    }

    const stdoutTail = input.stdout_tail !== undefined
      ? input.stdout_tail
      : (input.stdoutTail !== undefined ? input.stdoutTail : extractStdoutTail(input.stdout));

    return this.composeEvidence({
      evidence_id: input.evidence_id ?? input.evidenceId,
      task_id: taskId,
      instruction_id: input.instruction_id ?? input.instructionId ?? null,
      project_id: projectId,
      correlation_id: correlationId,
      command,
      exit_code: exitCode,
      stdout_tail: stdoutTail,
      stderr: input.stderr ?? null,
      working_directory: workingDir,
      execution_time_ms: executionTimeMs,
      evidence_type: input.evidence_type ?? input.evidenceType ?? EvidenceType.COMMAND,
      executor_identity: input.executor_identity ?? input.executorIdentity ?? null,
      captured_at: input.captured_at ?? input.capturedAt ?? null,
      metadata: input.metadata ?? null,
    });
  }

  /**
   * Executes an authorized command via the injected process executor and captures
   * the observable outcome as SystemVerifiedEvidence.
   */
  async executeAndCollectCommandEvidence(
    request: ExecuteCommandRequest
  ): Promise<SystemVerifiedEvidence> {
    this.assertNotAgentClaim(request);

    const taskId = request.task_id ?? request.taskId;
    const projectId = request.project_id ?? request.projectId;
    const correlationId = request.correlation_id ?? request.correlationId;
    const workingDir = request.working_directory ?? request.workingDirectory;
    const command = request.command;

    if (!taskId || !projectId || !correlationId || !workingDir || !command) {
      throw new CommandCollectionError('Missing required fields for command execution and collection', {
        taskId,
        correlationId,
        command,
        workingDirectory: workingDir,
        reason: 'MISSING_REQUIRED_FIELDS',
      });
    }

    const execResult = await this.processExecutor.executeProcess(command, {
      cwd: workingDir,
      timeoutMs: request.timeout_ms,
    });

    const stdoutTail = extractStdoutTail(execResult.stdout);

    return this.composeEvidence({
      evidence_id: request.evidence_id ?? request.evidenceId,
      task_id: taskId,
      instruction_id: request.instruction_id ?? request.instructionId ?? null,
      project_id: projectId,
      correlation_id: correlationId,
      command: execResult.command,
      exit_code: execResult.exitCode,
      stdout_tail: stdoutTail,
      stderr: execResult.stderr.length > 0 ? execResult.stderr : null,
      working_directory: workingDir,
      execution_time_ms: execResult.durationMs,
      evidence_type: request.evidence_type ?? request.evidenceType ?? EvidenceType.COMMAND,
      executor_identity: request.executor_identity ?? request.executorIdentity ?? null,
      captured_at: request.captured_at ?? request.capturedAt ?? execResult.completedAt ?? null,
      metadata: request.metadata ?? null,
    });
  }

  /**
   * Collects read-only Git observation facts (HEAD before/after and unified diff).
   * Does NOT perform any mutating Git operations.
   */
  async collectGitEvidence(
    workingDirectory: string,
    options?: { baseHead?: string | null }
  ): Promise<GitObservationResult> {
    return this.gitObserver.observeGit(workingDirectory, options?.baseHead);
  }

  /**
   * Collects SHA-256 hashes for explicitly supplied relevant file paths.
   * Produces a deterministically sorted map with lowercase hexadecimal SHA-256 strings.
   */
  async collectFileHashEvidence(
    filePaths: readonly string[],
    options?: FileHashCollectionOptions
  ): Promise<Readonly<Record<string, string>>> {
    return this.fileHashCollector.collectHashes(filePaths, options);
  }

  /**
   * Deterministically composes command observation, Git observation, and file hash observation
   * into a canonical SystemVerifiedEvidence object verified by TASK-P4-01 validator.
   */
  composeEvidence(input: ComposeEvidenceInput): SystemVerifiedEvidence {
    this.assertNotAgentClaim(input);

    const taskId = input.task_id ?? input.taskId;
    const projectId = input.project_id ?? input.projectId;
    const correlationId = input.correlation_id ?? input.correlationId;
    const instructionId = input.instruction_id ?? input.instructionId ?? null;

    // Command fields resolution
    const cmdObs = input.command_observation ?? input.commandObservation;
    const command = cmdObs?.command ?? input.command;
    const exitCode = cmdObs?.exit_code !== undefined
      ? cmdObs.exit_code
      : (input.exit_code !== undefined ? input.exit_code : input.exitCode);
    const stdoutTail = input.stdout_tail !== undefined
      ? input.stdout_tail
      : (input.stdoutTail !== undefined
          ? input.stdoutTail
          : (cmdObs?.stdout_tail !== undefined
              ? cmdObs.stdout_tail
              : extractStdoutTail(cmdObs?.stdout ?? input.stdout)));
    const stderr = cmdObs?.stderr !== undefined ? cmdObs.stderr : (input.stderr ?? null);
    const workingDir = cmdObs?.working_directory ?? input.working_directory ?? input.workingDirectory;
    const executionTimeMs = cmdObs?.execution_time_ms !== undefined
      ? cmdObs.execution_time_ms
      : (input.execution_time_ms !== undefined ? input.execution_time_ms : input.executionTimeMs);

    // Git observation resolution
    const gitObs = input.git_observation ?? input.gitObservation;
    const gitHeadBefore = gitObs?.git_head_before !== undefined
      ? gitObs.git_head_before
      : (input.git_head_before !== undefined ? input.git_head_before : input.gitHeadBefore);
    const gitHeadAfter = gitObs?.git_head_after !== undefined
      ? gitObs.git_head_after
      : (input.git_head_after !== undefined ? input.git_head_after : input.gitHeadAfter);
    const unifiedDiff = gitObs?.unified_diff !== undefined
      ? gitObs.unified_diff
      : (input.unified_diff !== undefined ? input.unified_diff : input.unifiedDiff);

    // File hashes resolution
    const fileHashes =
      input.file_hashes_after ??
      input.fileHashesAfter ??
      input.file_hashes ??
      input.fileHashes ??
      null;

    // Deterministic evidence_id generation fallback if caller did not supply one
    const rawEvidenceId = input.evidence_id ?? input.evidenceId;
    const evidenceType = (input.evidence_type ?? input.evidenceType ?? EvidenceType.COMMAND) as EvidenceType;
    const evidenceId = rawEvidenceId && rawEvidenceId.trim().length > 0
      ? rawEvidenceId.trim()
      : `evi:${taskId}:${evidenceType.toLowerCase()}:${correlationId}`;

    const evidencePayload: SystemVerifiedEvidenceInput = {
      evidence_id: evidenceId,
      task_id: taskId,
      instruction_id: instructionId,
      project_id: projectId,
      correlation_id: correlationId,
      command,
      exit_code: exitCode,
      stdout_tail: stdoutTail,
      stderr,
      working_directory: workingDir,
      execution_time_ms: executionTimeMs,
      git_head_before: gitHeadBefore ?? null,
      git_head_after: gitHeadAfter ?? null,
      unified_diff: unifiedDiff ?? null,
      file_hashes_after: fileHashes ? { ...fileHashes } : null,
      evidence_type: evidenceType,
      executor_identity: input.executor_identity ?? input.executorIdentity ?? null,
      captured_at: input.captured_at ?? input.capturedAt ?? null,
      metadata: input.metadata ?? null,
      source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
    };

    // Validates against TASK-P4-01 specification
    return assertValidSystemVerifiedEvidence(evidencePayload);
  }

  /**
   * Full evidence collection workflow:
   * 1. Observes Git HEAD before command
   * 2. Executes authorized command
   * 3. Observes Git HEAD after command and unified diff
   * 4. Collects SHA-256 file hashes for relevant files
   * 5. Composes and validates SystemVerifiedEvidence
   */
  async collectFullEvidence(
    request: FullEvidenceCollectionRequest
  ): Promise<SystemVerifiedEvidence> {
    this.assertNotAgentClaim(request);

    // 1. Git observation before
    const headBefore = request.base_git_head !== undefined
      ? request.base_git_head
      : await this.gitObserver.observeHead(request.working_directory);

    // 2. Command execution
    const execResult = await this.processExecutor.executeProcess(request.command, {
      cwd: request.working_directory,
      timeoutMs: request.timeout_ms,
    });

    // 3. Git observation after
    const gitResult = await this.gitObserver.observeGit(request.working_directory, headBefore);

    // 4. File hash collection
    let fileHashes: Record<string, string> | null = null;
    if (request.relevant_files && request.relevant_files.length > 0) {
      fileHashes = {
        ...(await this.fileHashCollector.collectHashes(request.relevant_files, {
          workingDirectory: request.working_directory,
        })),
      };
    }

    // 5. Evidence composition & validation
    return this.composeEvidence({
      evidence_id: request.evidence_id,
      task_id: request.task_id,
      instruction_id: request.instruction_id ?? null,
      project_id: request.project_id,
      correlation_id: request.correlation_id,
      command: execResult.command,
      exit_code: execResult.exitCode,
      stdout_tail: extractStdoutTail(execResult.stdout),
      stderr: execResult.stderr.length > 0 ? execResult.stderr : null,
      working_directory: request.working_directory,
      execution_time_ms: execResult.durationMs,
      git_head_before: gitResult.git_head_before,
      git_head_after: gitResult.git_head_after,
      unified_diff: gitResult.unified_diff,
      file_hashes_after: fileHashes,
      evidence_type: request.evidence_type ?? EvidenceType.COMMAND,
      executor_identity: request.executor_identity ?? null,
      captured_at: request.captured_at ?? execResult.completedAt ?? null,
      metadata: request.metadata ?? null,
    });
  }

  /**
   * Strictly asserts that the input is NOT an AGENT_CLAIM.
   */
  private assertNotAgentClaim(input: {
    source?: string;
    is_agent_claim?: boolean;
    isAgentClaim?: boolean;
    task_id?: string;
    taskId?: string;
    correlation_id?: string;
    correlationId?: string;
  }): void {
    if (
      input.source === 'AGENT_CLAIM' ||
      input.source === EvidenceSource.AGENT_CLAIM ||
      input.is_agent_claim === true ||
      input.isAgentClaim === true
    ) {
      throw new InvalidEvidenceSourceError(
        'AGENT_CLAIM cannot be promoted into system evidence. Agent claims are unverified assertions.',
        {
          taskId: input.task_id ?? input.taskId,
          reason: 'AGENT_CLAIM_REJECTED',
        }
      );
    }
  }
}
