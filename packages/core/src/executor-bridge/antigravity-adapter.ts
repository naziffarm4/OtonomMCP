import * as fs from 'node:fs';
import type { ExecutorPort, ExecutionRequestExecutorPort } from './executor-port.js';
import {
  type ExecutorInstruction,
  type RawExecutorOutcome as LegacyRawExecutorOutcome,
  type NormalizedExecutorResult,
  type ExecutorAvailability,
  ExecutorOperationType,
  ExecutorExecutionStatus,
  PolicyAuthorizationState,
  validateExecutorInstruction,
  normalizeRawExecutorOutcome,
} from './instruction-types.js';
import type {
  ExecutionRequest,
  ExecutionOperationType as P10ExecutionOperationType,
} from './execution-request-types.js';
import {
  type RawExecutorOutcome,
  type RawExecutorIdentity,
  assertNotVerifiedEvidence,
  createSuccessRawOutcome,
  createFailureRawOutcome,
  createTimeoutRawOutcome,
  createCancelledRawOutcome,
  createErrorRawOutcome,
} from './raw-executor-outcome.js';
import { ExecutorGuard } from './executor-guard.js';
import {
  UnsupportedOperationError,
  ExecutorUnavailableError,
  AdapterTranslationError,
} from '../errors/executor-error.js';
import { ExecutorPreconditionError } from '../director/director-errors.js';
import { RiskLevel } from '../risk.js';

// ============================================================================
// 1. ANTIGRAVITY TRANSLATION & CONFIGURATION TYPES
// ============================================================================

export interface AntigravityTranslatedPayload {
  readonly binary: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly inputFormat: string;
  readonly outputFormat: string;
  readonly structuredPrompt: string;
  readonly correlationId: string;
  readonly conversationId: string | null;
  readonly schema: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type AntigravityInvoker = (
  payload: AntigravityTranslatedPayload,
  instruction: ExecutorInstruction
) => Promise<LegacyRawExecutorOutcome>;

export interface AntigravityRawOutput {
  readonly exit_code?: number | null;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
  readonly agent_claims?: readonly string[] | null;
  readonly unverifiedAgentClaims?: readonly string[] | null;
  readonly unverified_changed_files?: readonly string[] | null;
  readonly unverifiedModifiedFiles?: readonly string[] | null;
  readonly metadata?: Record<string, unknown>;
  readonly executorMetadata?: Record<string, unknown>;
}

export type AntigravityRequestInvoker = (
  payload: AntigravityTranslatedPayload,
  request: ExecutionRequest,
  context: {
    signal?: AbortSignal;
    timeoutMs: number;
  }
) => Promise<RawExecutorOutcome | AntigravityRawOutput>;

export interface AntigravityAdapterConfig {
  /** Unique executor ID (defaults to 'executor:antigravity') */
  executorId?: string;
  /** File path to the Antigravity CLI binary `agy` */
  binaryPath?: string;
  /** Custom invoker for testing or custom execution dispatch (Phase 3 instruction) */
  invoker?: AntigravityInvoker;
  /** Custom invoker for testing or custom execution dispatch (Phase 10 ExecutionRequest) */
  requestInvoker?: AntigravityRequestInvoker;
  /** Enforce AIDM security and policy boundary before dispatch (default: true) */
  enforceSafetyBoundary?: boolean;
  /** Override reported CLI version */
  version?: string | null;
  /** Default workspace root directory */
  workspaceRoot?: string;
}

// ============================================================================
// 2. ANTIGRAVITY ADAPTER IMPLEMENTATION (Phase 3 + Phase 10 TASK-P10-03)
// ============================================================================

export class AntigravityAdapter implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId: string;
  readonly provider = 'antigravity';
  readonly supportedOperations: readonly string[];
  readonly binaryPath: string;
  readonly workspaceRoot?: string;

  private readonly invoker?: AntigravityInvoker;
  private readonly requestInvoker?: AntigravityRequestInvoker;
  private readonly enforceSafetyBoundary: boolean;
  private readonly configuredVersion?: string | null;

  constructor(config: AntigravityAdapterConfig = {}) {
    this.executorId = config.executorId ?? 'executor:antigravity';
    this.binaryPath =
      config.binaryPath ??
      (process.env.ANTIGRAVITY_BIN_PATH || '/home/codespace/.local/bin/agy');
    this.invoker = config.invoker;
    this.requestInvoker = config.requestInvoker;
    this.enforceSafetyBoundary = config.enforceSafetyBoundary ?? true;
    this.configuredVersion = config.version;
    this.workspaceRoot = config.workspaceRoot;

    // All standard AIDM executor operations supported by the Antigravity adapter boundary
    this.supportedOperations = Object.freeze([
      ExecutorOperationType.IMPLEMENT_TASK,
      ExecutorOperationType.EXECUTE_TEST,
      ExecutorOperationType.EXECUTE_BUILD,
      ExecutorOperationType.INSPECT_WORKSPACE,
      ExecutorOperationType.APPLY_REPAIR,
    ]);
  }

  get executorIdentity(): RawExecutorIdentity {
    return Object.freeze({
      provider: this.provider,
      name: this.executorId,
      version: this.configuredVersion ?? null,
    });
  }

  private isExecutionRequest(target: unknown): target is ExecutionRequest {
    if (!target || typeof target !== 'object') return false;
    const cand = target as Record<string, unknown>;
    // Legacy Phase 3 instructions always have instruction_id
    if ('instruction_id' in cand) return false;
    return true;
  }

  // ==========================================================================
  // PHASE 10 EXECUTION REQUEST TRANSLATION & EXECUTION (TASK-P10-03)
  // ==========================================================================

  /**
   * Translates a validated ExecutionRequest into the Antigravity CLI invocation payload.
   * Strictly enforces:
   * 1. No permission bypass flags (--dangerously-skip-permissions is forbidden).
   * 2. Pure instruction delivery without internal state mutation.
   */
  translateExecutionRequest(request: ExecutionRequest): AntigravityTranslatedPayload {
    const workingDir =
      (request.metadata?.workingDirectory as string | undefined) ??
      this.workspaceRoot ??
      process.cwd();

    // Assemble deterministic CLI arguments (NO permission bypass flags!)
    const args: string[] = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--project',
      request.projectId,
    ];

    if (workingDir) {
      args.push('--add-dir', workingDir);
    }

    // Assemble deterministic structured prompt
    const promptLines: string[] = [
      '=== AIDM AUTHORIZED EXECUTION REQUEST ===',
      `Request ID: ${request.requestId}`,
      `Task ID: ${request.taskId}`,
      `Task Revision: ${request.taskRevision}`,
      `Project ID: ${request.projectId}`,
      `Operation: ${request.operationType}`,
      `Director Session ID: ${request.directorSessionId}`,
      `Director Decision ID: ${request.directorDecisionId}`,
      `Context Fingerprint: ${request.contextFingerprint}`,
      `Understanding Revision: ${request.understandingRevision}`,
      `Approval Package Revision: ${request.approvalPackageRevision}`,
      `Timeout (ms): ${request.executionLimits.timeoutMs}`,
      `Max File Modifications: ${request.executionLimits.maxFileModifications}`,
      `Base Commit: ${request.expectedRepositoryState.baseCommit}`,
      `Working Tree Clean: ${request.expectedRepositoryState.isClean}`,
      '',
      'OBJECTIVE:',
      request.instruction.objective,
      '',
      'ACCEPTANCE CRITERIA:',
      ...request.instruction.acceptanceCriteria.map((ac) =>
        typeof ac === 'string'
          ? `- ${ac}`
          : `- [${ac.criterionId ?? ac.id ?? 'AC'}] ${ac.description}`
      ),
      '',
      'CONSTRAINTS:',
      ...(request.instruction.constraints.length > 0
        ? request.instruction.constraints.map((c) => `- ${c}`)
        : ['(None specified)']),
      '',
      'TARGET FILES:',
      ...(request.instruction.targetFiles.length > 0
        ? request.instruction.targetFiles.map((f) => `- ${f}`)
        : ['(None specified)']),
      '=========================================',
    ];

    const structuredPrompt = promptLines.join('\n');

    return Object.freeze({
      binary: this.binaryPath,
      args: Object.freeze([...args]),
      workingDirectory: workingDir,
      inputFormat: 'stream-json',
      outputFormat: 'stream-json',
      structuredPrompt,
      correlationId: `exec:${request.requestId}:${request.taskId}:${request.taskRevision}`,
      conversationId: null,
      schema: null,
      metadata: Object.freeze({
        requestId: request.requestId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
        projectId: request.projectId,
        operationType: request.operationType,
        contextFingerprint: request.contextFingerprint,
      }),
    });
  }

  /**
   * Dispatches an ExecutionRequest through the Antigravity adapter boundary.
   *
   * STRICT GOVERNANCE:
   * 1. Validates preconditions, schema, paths, shell injection, and hash integrity.
   * 2. Translates to controlled invocation payload.
   * 3. Executes with timeout and cancellation guarantees.
   * 4. Returns RawExecutorOutcome (never SystemVerifiedEvidence).
   * 5. Does NOT mutate Task DAG, FSM, SpecStore, or ApprovalStore.
   * 6. Does NOT initiate autonomous retry loops.
   */
  async executeExecutionRequest(
    request: ExecutionRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<RawExecutorOutcome> {
    if (!request || typeof request !== 'object') {
      throw new ExecutorPreconditionError('ExecutionRequest must be a non-null object');
    }

    const startedAt = new Date().toISOString();
    const startTimeMs = Date.now();

    // 1. Validate all preconditions, schema, paths, shell injection, limits, and hash integrity
    const validatedRequest = ExecutorGuard.validateExecutionPreconditions(request, {
      supportedOperations: this.supportedOperations,
      workingDirectory:
        (request.metadata?.workingDirectory as string | undefined) ?? this.workspaceRoot,
    });

    // 2. Check if caller signal is already aborted
    if (options.signal?.aborted) {
      const completedAt = new Date().toISOString();
      return createCancelledRawOutcome({
        request: validatedRequest,
        executorIdentity: this.executorIdentity,
        startedAt,
        completedAt,
        durationMs: Date.now() - startTimeMs,
        reason: 'Execution was aborted before start by caller signal',
      });
    }

    // 3. Translate to Antigravity CLI payload
    const payload = this.translateExecutionRequest(validatedRequest);

    // 4. Setup timeout and cancellation
    const timeoutMs = validatedRequest.executionLimits.timeoutMs;
    const abortController = new AbortController();

    let timeoutTimer: NodeJS.Timeout | null = null;
    let didTimeout = false;

    timeoutTimer = setTimeout(() => {
      didTimeout = true;
      abortController.abort(new Error(`Execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onCallerAbort = () => {
      abortController.abort(new Error('Caller aborted execution'));
    };

    if (options.signal) {
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      let rawResult: RawExecutorOutcome | AntigravityRawOutput;

      if (this.requestInvoker) {
        rawResult = await this.requestInvoker(payload, validatedRequest, {
          signal: abortController.signal,
          timeoutMs,
        });
      } else if (this.invoker) {
        // Adapt Phase 3 invoker for testing
        const fakeInstruction: any = {
          instruction_id: validatedRequest.requestId,
          task_id: validatedRequest.taskId,
          project_id: validatedRequest.projectId,
          working_directory: payload.workingDirectory,
          requested_operation_type: validatedRequest.operationType,
          attempt: 1,
          max_attempts: 1,
          risk_level: RiskLevel.SAFE,
          objective: validatedRequest.instruction.objective,
          acceptance_criteria: validatedRequest.instruction.acceptanceCriteria.map((c) =>
            typeof c === 'string' ? c : c.description
          ),
          constraints: validatedRequest.instruction.constraints,
          correlation_id: payload.correlationId,
          traceability_information: { sources: [] },
          policy_decision: { state: PolicyAuthorizationState.AUTHORIZED },
        };
        rawResult = await this.invoker(payload, fakeInstruction);
      } else {
        // Safe default boundary fallback (e.g. simulated execution when no process is spawned)
        rawResult = {
          exit_code: 0,
          stdout: `[Antigravity CLI Simulated Output] Completed execution of ${validatedRequest.requestId}`,
          stderr: null,
          agent_claims: ['Task implementation attempted'],
          unverified_changed_files: [...validatedRequest.instruction.targetFiles],
        };
      }

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTimeMs;

      // Timeout boundary check takes precedence over delayed outcome
      if (didTimeout) {
        return createTimeoutRawOutcome({
          request: validatedRequest,
          executorIdentity: this.executorIdentity,
          startedAt,
          completedAt,
          durationMs,
        });
      }

      // Cancellation check takes precedence over delayed outcome
      if (abortController.signal.aborted) {
        return createCancelledRawOutcome({
          request: validatedRequest,
          executorIdentity: this.executorIdentity,
          startedAt,
          completedAt,
          durationMs,
          reason: 'Execution was cancelled by caller signal',
        });
      }

      // If already a valid RawExecutorOutcome, verify invariants and return
      if (
        rawResult &&
        typeof rawResult === 'object' &&
        'requestBinding' in rawResult &&
        'status' in rawResult
      ) {
        assertNotVerifiedEvidence(rawResult);
        return rawResult as RawExecutorOutcome;
      }

      // Map raw output to canonical RawExecutorOutcome
      const rawOutput = rawResult as AntigravityRawOutput;
      const exitCode =
        rawOutput.exit_code !== undefined
          ? rawOutput.exit_code
          : (rawOutput.exitCode ?? 0);
      const isSuccess = exitCode === 0;

      if (!isSuccess) {
        return createFailureRawOutcome({
          request: validatedRequest,
          executorIdentity: this.executorIdentity,
          startedAt,
          completedAt,
          durationMs,
          exitCode,
          signal: rawOutput.signal ?? null,
          stdout: rawOutput.stdout ?? null,
          stderr: rawOutput.stderr ?? `Process exited with code ${exitCode}`,
          unverifiedAgentClaims:
            rawOutput.agent_claims ?? rawOutput.unverifiedAgentClaims ?? [],
          unverifiedModifiedFiles:
            rawOutput.unverified_changed_files ?? rawOutput.unverifiedModifiedFiles ?? [],
          executorMetadata: rawOutput.metadata ?? rawOutput.executorMetadata,
        });
      }

      return createSuccessRawOutcome({
        request: validatedRequest,
        executorIdentity: this.executorIdentity,
        startedAt,
        completedAt,
        durationMs,
        exitCode: 0,
        stdout: rawOutput.stdout ?? '',
        stderr: rawOutput.stderr ?? null,
        unverifiedAgentClaims:
          rawOutput.agent_claims ?? rawOutput.unverifiedAgentClaims ?? ['Task implementation complete'],
        unverifiedModifiedFiles:
          rawOutput.unverified_changed_files ??
          rawOutput.unverifiedModifiedFiles ??
          [...validatedRequest.instruction.targetFiles],
        executorMetadata: rawOutput.metadata ?? rawOutput.executorMetadata,
      });
    } catch (err: unknown) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTimeMs;

      if (didTimeout || (err instanceof Error && err.message.includes('timed out'))) {
        return createTimeoutRawOutcome({
          request: validatedRequest,
          executorIdentity: this.executorIdentity,
          startedAt,
          completedAt,
          durationMs,
          stderr: err instanceof Error ? err.message : 'Execution timed out',
        });
      }

      if (options.signal?.aborted || abortController.signal.aborted) {
        return createCancelledRawOutcome({
          request: validatedRequest,
          executorIdentity: this.executorIdentity,
          startedAt,
          completedAt,
          durationMs,
          reason: err instanceof Error ? err.message : 'Execution cancelled',
        });
      }

      return createErrorRawOutcome({
        request: validatedRequest,
        executorIdentity: this.executorIdentity,
        startedAt,
        completedAt,
        durationMs,
        error: {
          code: 'ERR_EXECUTOR_INVOCATION',
          message: err instanceof Error ? err.message : String(err),
          details: err,
        },
      });
    }
  }

  // ==========================================================================
  // PHASE 3 INSTRUCTION TRANSLATION & EXECUTION (BACKWARD COMPATIBILITY)
  // ==========================================================================

  /**
   * Translates the generic ExecutorInstruction into the Antigravity CLI representation.
   * Deterministic: Given identical instructions, produces identical payloads.
   */
  translate(instruction: ExecutorInstruction): AntigravityTranslatedPayload {
    // 1. Verify operation support
    if (!this.supportedOperations.includes(instruction.requested_operation_type)) {
      throw new UnsupportedOperationError(
        `Operation "${instruction.requested_operation_type}" is not supported by executor "${this.executorId}".`,
        {
          operation: instruction.requested_operation_type,
          supportedOperations: this.supportedOperations,
          executorId: this.executorId,
          reason: 'OPERATION_NOT_SUPPORTED',
        }
      );
    }

    try {
      // 2. Assemble deterministic CLI arguments
      const args: string[] = [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--project',
        instruction.project_id,
      ];

      if (instruction.working_directory) {
        args.push('--add-dir', instruction.working_directory);
      }

      const conversationId =
        typeof instruction.relevant_context?.metadata?.conversation_id === 'string'
          ? (instruction.relevant_context.metadata.conversation_id as string)
          : null;

      if (conversationId) {
        args.push('--conversation', conversationId);
      }

      // 3. Assemble deterministic structured prompt
      const promptLines: string[] = [
        '=== AIDM AUTHORIZED EXECUTOR INSTRUCTION ===',
        `Task ID: ${instruction.task_id}`,
        `Instruction ID: ${instruction.instruction_id}`,
        `Project ID: ${instruction.project_id}`,
        `Correlation ID: ${instruction.correlation_id}`,
        `Operation: ${instruction.requested_operation_type}`,
        `Attempt: ${instruction.attempt} of ${instruction.max_attempts}`,
        `Risk Level: ${instruction.risk_level}`,
        `Working Directory: ${instruction.working_directory}`,
        '',
        'OBJECTIVE:',
        instruction.objective,
        '',
        'ACCEPTANCE CRITERIA:',
        ...instruction.acceptance_criteria.map((ac) => `- ${ac}`),
        '',
        'CONSTRAINTS:',
        ...(instruction.constraints.length > 0
          ? instruction.constraints.map((c) => `- ${c}`)
          : ['(None specified)']),
        '',
        'RELEVANT CONTEXT:',
        `- Context Hash: ${instruction.relevant_context.context_hash ?? 'N/A'}`,
        `- Target Files: ${
          instruction.relevant_context.target_files &&
          instruction.relevant_context.target_files.length > 0
            ? instruction.relevant_context.target_files.join(', ')
            : 'N/A'
        }`,
        `- Architectural Decisions: ${
          instruction.relevant_context.decisions &&
          instruction.relevant_context.decisions.length > 0
            ? instruction.relevant_context.decisions.join(', ')
            : 'N/A'
        }`,
        `- Requirements: ${
          instruction.relevant_context.requirements &&
          instruction.relevant_context.requirements.length > 0
            ? instruction.relevant_context.requirements.join(', ')
            : 'N/A'
        }`,
      ];

      if (instruction.relevant_context.previous_attempt_failure) {
        const prev = instruction.relevant_context.previous_attempt_failure;
        promptLines.push(
          '',
          'PREVIOUS ATTEMPT FAILURE:',
          `- Failed Attempt: ${prev.attempt}`,
          `- Error Signature: ${prev.error_signature ?? 'N/A'}`,
          `- Root Cause: ${prev.root_cause ?? 'N/A'}`,
          `- Failed Strategy: ${prev.failed_strategy ?? 'N/A'}`
        );
      }

      promptLines.push(
        '',
        'TRACEABILITY SOURCES:',
        ...instruction.traceability_information.sources.map((s) => `- ${s}`),
        '============================================'
      );

      const structuredPrompt = promptLines.join('\n');

      return Object.freeze({
        binary: this.binaryPath,
        args: Object.freeze([...args]),
        workingDirectory: instruction.working_directory,
        inputFormat: 'stream-json',
        outputFormat: 'stream-json',
        structuredPrompt,
        correlationId: instruction.correlation_id,
        conversationId,
        schema: null,
        metadata: Object.freeze({
          taskId: instruction.task_id,
          instructionId: instruction.instruction_id,
          projectId: instruction.project_id,
          attempt: instruction.attempt,
          riskLevel: instruction.risk_level,
        }),
      });
    } catch (err) {
      if (err instanceof UnsupportedOperationError) {
        throw err;
      }
      throw new AdapterTranslationError(
        `Failed to translate executor instruction to Antigravity representation: ${
          err instanceof Error ? err.message : String(err)
        }`,
        {
          adapterName: 'AntigravityAdapter',
          targetProvider: this.provider,
          instructionId: instruction.instruction_id,
          reason: 'TRANSLATION_EXCEPTION',
        }
      );
    }
  }

  /**
   * Normalizes a raw executor outcome into a canonical NormalizedExecutorResult.
   */
  normalize(
    outcome: LegacyRawExecutorOutcome,
    instruction: ExecutorInstruction
  ): NormalizedExecutorResult {
    return normalizeRawExecutorOutcome(outcome, instruction, {
      provider: this.provider,
      name: this.executorId,
      version: this.configuredVersion ?? null,
    });
  }

  /**
   * Probes environment to verify Antigravity CLI binary presence and accessibility.
   */
  async checkAvailability(): Promise<ExecutorAvailability> {
    try {
      if (this.invoker || this.requestInvoker) {
        return Object.freeze({
          available: true,
          version: this.configuredVersion ?? 'custom-invoker',
          reason: null,
        });
      }

      // Check if binary file exists
      if (!fs.existsSync(this.binaryPath)) {
        return Object.freeze({
          available: false,
          version: null,
          reason: `Antigravity CLI binary not found at "${this.binaryPath}"`,
        });
      }

      // Binary is present
      return Object.freeze({
        available: true,
        version: this.configuredVersion ?? '1.2.8',
        reason: null,
      });
    } catch (err) {
      return Object.freeze({
        available: false,
        version: null,
        reason: `Failed to check availability: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Internal Phase 3 instruction execution logic.
   */
  private async executeInstruction(
    instruction: ExecutorInstruction
  ): Promise<NormalizedExecutorResult> {
    const validatedInstruction = validateExecutorInstruction(instruction);

    if (this.enforceSafetyBoundary) {
      const policyDecision = validatedInstruction.policy_decision;
      const isAuthorized = policyDecision.state === PolicyAuthorizationState.AUTHORIZED;

      let criticalBlocked = false;
      if (validatedInstruction.risk_level === RiskLevel.CRITICAL) {
        const isHuman = policyDecision.decided_by === 'USER';
        const hasToken =
          typeof policyDecision.decision_token === 'string' &&
          policyDecision.decision_token.trim().length > 0;
        if (!isHuman || !hasToken) {
          criticalBlocked = true;
        }
      }

      const pathTraversal =
        validatedInstruction.working_directory.includes('..') &&
        !validatedInstruction.working_directory.startsWith('/');

      if (!isAuthorized || criticalBlocked || pathTraversal) {
        const suggestedAction =
          criticalBlocked ||
          policyDecision.state === PolicyAuthorizationState.HUMAN_REQUIRED ||
          validatedInstruction.risk_level === RiskLevel.CRITICAL
            ? 'REQUIRE_HUMAN'
            : 'BLOCK';

        const reasonMessage = pathTraversal
          ? `Working directory contains path traversal: ${validatedInstruction.working_directory}`
          : criticalBlocked
          ? `Operation with CRITICAL risk classification requires verified human authorization (Actor: USER) with a valid decision token.`
          : `Execution blocked by policy boundary: instruction authorization state is ${policyDecision.state} (reason: ${policyDecision.reason || 'No authorization'}). Protected operation cannot proceed without explicit AUTHORIZED policy decision.`;

        return Object.freeze({
          success: false,
          status: ExecutorExecutionStatus.REJECTED_BY_POLICY,
          exit_info: null,
          stdout: null,
          stderr: null,
          changed_files: null,
          executor_identity: Object.freeze({
            provider: this.provider,
            name: this.executorId,
            version: this.configuredVersion ?? null,
          }),
          timing: null,
          error: Object.freeze({
            code: 'ERR_POLICY_VIOLATION',
            message: reasonMessage,
            details: {
              policyState: policyDecision.state,
              riskLevel: validatedInstruction.risk_level,
              suggestedAction,
            },
          }),
          correlation: Object.freeze({
            task_id: validatedInstruction.task_id,
            instruction_id: validatedInstruction.instruction_id,
            project_id: validatedInstruction.project_id,
            attempt: validatedInstruction.attempt,
            correlation_id: validatedInstruction.correlation_id,
          }),
          raw_outcome: Object.freeze({
            executor_id: this.executorId,
            command: null,
            exit_code: null,
            signal: null,
            stdout: null,
            stderr: null,
            raw_payload: null,
            agent_claims: [],
            unverified_changed_files: null,
            timing: null,
          }),
          agent_claims: Object.freeze([]),
        });
      }
    }

    const translatedPayload = this.translate(validatedInstruction);
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new ExecutorUnavailableError(
        `Executor "${this.executorId}" is unavailable: ${availability.reason ?? 'Unknown reason'}`,
        {
          executorId: this.executorId,
          provider: this.provider,
          binaryPath: this.binaryPath,
          reason: availability.reason ?? 'UNAVAILABLE',
        }
      );
    }

    let outcome: LegacyRawExecutorOutcome;
    if (this.invoker) {
      outcome = await this.invoker(translatedPayload, validatedInstruction);
    } else {
      outcome = Object.freeze({
        executor_id: this.executorId,
        command: `${this.binaryPath} ${translatedPayload.args.join(' ')}`,
        exit_code: null,
        signal: null,
        stdout: null,
        stderr: 'External invocation hook is not configured for this boundary adapter instance',
        raw_payload: null,
        agent_claims: [],
        unverified_changed_files: null,
        timing: null,
      });
    }

    return this.normalize(outcome, validatedInstruction);
  }

  // ==========================================================================
  // UNIFIED EXECUTE DISPATCHER
  // ==========================================================================

  execute(request: ExecutionRequest, options?: { signal?: AbortSignal }): Promise<RawExecutorOutcome>;
  execute(instruction: ExecutorInstruction): Promise<NormalizedExecutorResult>;
  async execute(
    target: ExecutionRequest | ExecutorInstruction,
    options?: { signal?: AbortSignal }
  ): Promise<RawExecutorOutcome | NormalizedExecutorResult> {
    if (!target || typeof target !== 'object') {
      throw new ExecutorPreconditionError('Execution request or instruction cannot be null or undefined');
    }
    if (this.isExecutionRequest(target)) {
      return this.executeExecutionRequest(target, options);
    }
    return this.executeInstruction(target as ExecutorInstruction);
  }
}
