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
  ExecutionFailureCategory,
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
import { ExecutorContextService } from './executor-context-service.js';
import {
  ExecutorContextError,
  ExecutorContextStaleError,
  ExecutorContextSourceUnavailableError,
  ExecutorContextValidationError,
} from './executor-context-errors.js';
import { RiskLevel } from '../risk.js';
import {
  type AntigravityProcessRunner,
  type AntigravityProcessResult,
  NodeAntigravityProcessRunner,
  FakeAntigravityProcessRunner,
  resolveAntigravityExecutable,
  type AntigravityResolutionResult,
} from './antigravity-process-runner.js';
import {
  type ExecutorCompatibility,
  type CompatibilityCheckOptions,
  AntigravityCompatibilityChecker,
  DEFAULT_ANTIGRAVITY_PROTOCOL,
} from './antigravity-compatibility.js';

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
  /** File path to the Antigravity CLI binary `agy` (or command name) */
  binaryPath?: string;
  /** Custom invoker for testing or custom execution dispatch (Phase 3 instruction) */
  invoker?: AntigravityInvoker;
  /** Custom invoker for testing or custom execution dispatch (Phase 10 ExecutionRequest) */
  requestInvoker?: AntigravityRequestInvoker;
  /** Custom process runner for executing CLI processes (defaults to NodeAntigravityProcessRunner) */
  processRunner?: AntigravityProcessRunner;
  /** Enforce AIDM security and policy boundary before dispatch (default: true) */
  enforceSafetyBoundary?: boolean;
  /** Override reported CLI version */
  version?: string | null;
  /** Default workspace root directory */
  workspaceRoot?: string;
  /** Authoritative ExecutorContextService instance */
  contextService?: ExecutorContextService;
  /** Auto-resolve context package if omitted from ExecutionRequest (default: true if contextService provided) */
  autoResolveContext?: boolean;
  /** Validate context package disk freshness before execution (default: true) */
  validateContextFreshness?: boolean;
  /** Skip compatibility probe before dispatching (default: false) */
  skipCompatibilityProbe?: boolean;
}

export interface ParsedExecutorOutput {
  readonly safe: boolean;
  readonly reason: string | null;
  readonly agentClaims: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Safely parses stdout from an Antigravity CLI process execution.
 * Distinguishes safe output from corrupted / malformed output.
 */
export function parseExecutorProcessOutput(
  stdout: string,
  request: ExecutionRequest
): ParsedExecutorOutput {
  // Check for binary garbage or null bytes
  if (stdout.includes('\0')) {
    return {
      safe: false,
      reason: 'Process output contains null bytes or binary corruption',
      agentClaims: Object.freeze([]),
      modifiedFiles: Object.freeze([]),
    };
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      safe: true,
      reason: null,
      agentClaims: Object.freeze(['Task implementation executed without textual claims']),
      modifiedFiles: Object.freeze([...request.instruction.targetFiles]),
    };
  }

  const discoveredClaims: string[] = [];
  const discoveredFiles: string[] = [];
  let discoveredMetadata: Record<string, unknown> | undefined;

  let parsedSingle = false;
  if (trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.includes('\n')) {
    try {
      const parsed = JSON.parse(trimmed);
      parsedSingle = true;
      if (Array.isArray(parsed.agent_claims)) discoveredClaims.push(...parsed.agent_claims);
      if (Array.isArray(parsed.unverifiedAgentClaims)) discoveredClaims.push(...parsed.unverifiedAgentClaims);
      if (Array.isArray(parsed.unverified_changed_files)) discoveredFiles.push(...parsed.unverified_changed_files);
      if (Array.isArray(parsed.unverifiedModifiedFiles)) discoveredFiles.push(...parsed.unverifiedModifiedFiles);
      if (parsed.metadata && typeof parsed.metadata === 'object') discoveredMetadata = parsed.metadata;
    } catch (err) {
      return {
        safe: false,
        reason: `Process output starts with '{' but contains malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
        agentClaims: Object.freeze([]),
        modifiedFiles: Object.freeze([]),
      };
    }
  }

  if (!parsedSingle) {

    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let hadMalformedJsonLine = false;
    let malformedError = '';

    for (const line of lines) {
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed.agent_claims)) discoveredClaims.push(...parsed.agent_claims);
          if (Array.isArray(parsed.unverifiedAgentClaims)) discoveredClaims.push(...parsed.unverifiedAgentClaims);
          if (Array.isArray(parsed.unverified_changed_files)) discoveredFiles.push(...parsed.unverified_changed_files);
          if (Array.isArray(parsed.unverifiedModifiedFiles)) discoveredFiles.push(...parsed.unverifiedModifiedFiles);
          if (parsed.event === 'result' && parsed.result && typeof parsed.result === 'object') {
            const resObj = parsed.result as Record<string, unknown>;
            if (typeof resObj.response === 'string' && resObj.response.trim().length > 0) {
              discoveredClaims.push(resObj.response.trim());
            }
            if (typeof resObj.conversation_id === 'string') {
              discoveredMetadata = { ...discoveredMetadata, conversationId: resObj.conversation_id };
            }
          }
          if (parsed.metadata && typeof parsed.metadata === 'object') {
            discoveredMetadata = { ...discoveredMetadata, ...parsed.metadata };
          }
        } catch (err) {
          hadMalformedJsonLine = true;
          malformedError = err instanceof Error ? err.message : String(err);
        }
      } else if (line.startsWith('{') && !line.endsWith('}')) {
        hadMalformedJsonLine = true;
        malformedError = 'Truncated JSON frame detected in output stream';
      }
    }

    if (hadMalformedJsonLine) {
      return {
        safe: false,
        reason: `Process output contained malformed stream-json frame: ${malformedError}`,
        agentClaims: Object.freeze([]),
        modifiedFiles: Object.freeze([]),
      };
    }
  }

  const finalClaims = discoveredClaims.length > 0
    ? Object.freeze([...new Set(discoveredClaims)])
    : Object.freeze(['Task implementation executed']);

  const finalFiles = discoveredFiles.length > 0
    ? Object.freeze([...new Set(discoveredFiles)])
    : Object.freeze([...request.instruction.targetFiles]);

  return {
    safe: true,
    reason: null,
    agentClaims: finalClaims,
    modifiedFiles: finalFiles,
    metadata: discoveredMetadata ? Object.freeze(discoveredMetadata) : undefined,
  };
}

// ============================================================================
// 2. ANTIGRAVITY ADAPTER IMPLEMENTATION (Phase 3 + Phase 10 TASK-P10-03 + Phase 14 TASK-P14-01)
// ============================================================================

export class AntigravityAdapter implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId: string;
  readonly provider = 'antigravity';
  readonly supportedOperations: readonly string[];
  readonly binaryPath: string;
  readonly configuredBinaryPath?: string;
  readonly workspaceRoot?: string;
  readonly contextService?: ExecutorContextService;
  readonly autoResolveContext: boolean;
  readonly validateContextFreshness: boolean;
  readonly processRunner: AntigravityProcessRunner;
  readonly compatibilityChecker: AntigravityCompatibilityChecker;
  readonly skipCompatibilityProbe: boolean;

  private readonly invoker?: AntigravityInvoker;
  private readonly requestInvoker?: AntigravityRequestInvoker;
  private readonly enforceSafetyBoundary: boolean;
  private readonly configuredVersion?: string | null;

  constructor(config: AntigravityAdapterConfig = {}) {
    this.executorId = config.executorId ?? 'executor:antigravity';
    this.configuredBinaryPath = config.binaryPath;
    this.invoker = config.invoker;
    this.requestInvoker = config.requestInvoker;
    this.enforceSafetyBoundary = config.enforceSafetyBoundary ?? true;
    this.configuredVersion = config.version;
    this.workspaceRoot = config.workspaceRoot;
    this.contextService = config.contextService;
    this.autoResolveContext = config.autoResolveContext ?? (this.contextService !== undefined);
    this.validateContextFreshness = config.validateContextFreshness ?? true;
    this.processRunner = config.processRunner ?? new NodeAntigravityProcessRunner();
    this.compatibilityChecker = new AntigravityCompatibilityChecker(this.processRunner);
    this.skipCompatibilityProbe = config.skipCompatibilityProbe ?? false;

    // Portable executable resolution: resolve explicit path, env, or PATH
    const resolution = resolveAntigravityExecutable({
      configuredBinaryPath: config.binaryPath,
      cwd: config.workspaceRoot,
    });
    this.binaryPath = resolution.executablePath ?? (config.binaryPath || 'agy');

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
      '',
      'ANALYSIS SCOPE:',
      ...(request.instruction.analysisScope !== undefined
        ? request.instruction.analysisScope.length > 0
          ? request.instruction.analysisScope.map((s) => `- ${s}`)
          : ['(None specified)']
        : ['(Not specified)']),
      '',
      'IMPLEMENTATION SCOPE:',
      ...(request.instruction.implementationScope !== undefined
        ? request.instruction.implementationScope.length > 0
          ? request.instruction.implementationScope.map((s) => `- ${s}`)
          : ['(None specified — repository modifications are not permitted)']
        : ['(Not specified — existing targetFiles behavior applies)']),
      '=========================================',
    ];

    if (request.contextPackage) {
      const cp = request.contextPackage;
      promptLines.push(
        '',
        '=== AUTHORITATIVE EXECUTOR CONTEXT PACKAGE ===',
        `Package ID: ${cp.packageId}`,
        `Content Hash: ${cp.contentHash}`,
        `Context Fingerprint: ${cp.contextFingerprint}`
      );

      if (cp.projectBaseline.technologyStack.runtime || cp.projectBaseline.technologyStack.languages?.length) {
        promptLines.push(
          '',
          'TECHNOLOGY STACK & ENVIRONMENT:',
          `- Runtime: ${cp.projectBaseline.technologyStack.runtime ?? 'Unknown'}`,
          `- Package Manager: ${cp.projectBaseline.technologyStack.packageManager ?? 'Unknown'}`,
          `- Languages: ${(cp.projectBaseline.technologyStack.languages ?? []).join(', ') || 'N/A'}`,
          `- Frameworks: ${(cp.projectBaseline.technologyStack.frameworks ?? []).join(', ') || 'N/A'}`
        );
      }

      if (cp.specContext.requirements.length > 0) {
        promptLines.push(
          '',
          'GOVERNING REQUIREMENTS (AUTHORITATIVE):',
          ...cp.specContext.requirements.map(
            (r) => `- [${r.id}] ${r.title}: ${r.description}`
          )
        );
      }

      if (cp.specContext.decisions.length > 0) {
        promptLines.push(
          '',
          'GOVERNING ARCHITECTURAL DECISIONS (AUTHORITATIVE):',
          ...cp.specContext.decisions.map(
            (d) => `- [${d.id}] ${d.title}${d.rationale ? ` (Rationale: ${d.rationale})` : ''}`
          )
        );
      }

      if (cp.codeContext.targetFileStructures.length > 0) {
        promptLines.push(
          '',
          'TARGET FILE STRUCTURAL CONTRACTS & INTERFACES (L1 AST):',
          ...cp.codeContext.targetFileStructures.flatMap((fs) => {
            const lines = [`File: ${fs.path} (${fs.layer}, hash: ${fs.sha256.substring(0, 12)}...)`];
            if (fs.interfaces && fs.interfaces.length > 0) {
              lines.push('  Interfaces:');
              for (const iface of fs.interfaces.slice(0, 10)) {
                lines.push(`    ${iface.replace(/\n/g, '\n    ')}`);
              }
            }
            if (fs.typeDefinitions && fs.typeDefinitions.length > 0) {
              lines.push('  Types:');
              for (const t of fs.typeDefinitions.slice(0, 10)) {
                lines.push(`    ${t.replace(/\n/g, '\n    ')}`);
              }
            }
            if (fs.signatures && fs.signatures.length > 0) {
              lines.push('  Signatures:');
              for (const sig of fs.signatures.slice(0, 10)) {
                lines.push(`    ${sig}`);
              }
            }
            if (fs.exports && fs.exports.length > 0) {
              lines.push(`  Exports: ${fs.exports.slice(0, 10).join(', ')}`);
            }
            return lines;
          })
        );
      }

      if (cp.recoveryContext) {
        promptLines.push(
          '',
          'RECOVERY & LINEAGE CONTEXT:',
          `- Attempt: ${cp.recoveryContext.attempt}/${cp.recoveryContext.maxAttempts}`,
          `- Is Retry: ${cp.recoveryContext.isRetry}`,
          ...(cp.recoveryContext.parentTaskId ? [`- Parent Task: ${cp.recoveryContext.parentTaskId}`] : []),
          ...(cp.recoveryContext.priorFailureDiagnosis?.reason
            ? [`- Prior Failure Reason: ${cp.recoveryContext.priorFailureDiagnosis.reason}`]
            : []),
          ...(cp.recoveryContext.priorFailureDiagnosis?.prescribedAction
            ? [`- Prescribed Recovery Action: ${cp.recoveryContext.priorFailureDiagnosis.prescribedAction}`]
            : [])
        );
      }
    }

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
        contextPackageId: request.contextPackage?.packageId,
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
    let validatedRequest = ExecutorGuard.validateExecutionPreconditions(request, {
      supportedOperations: this.supportedOperations,
      workingDirectory:
        (request.metadata?.workingDirectory as string | undefined) ?? this.workspaceRoot,
    });

    // 1.5 Auto-resolve context package if omitted and service is configured
    if (!validatedRequest.contextPackage && this.contextService && this.autoResolveContext) {
      try {
        const autoPkg = await this.contextService.packageContextForExecutionRequest(validatedRequest);
        validatedRequest = Object.freeze({
          ...validatedRequest,
          contextPackage: autoPkg,
        });
      } catch (err) {
        if (validatedRequest.operationType === 'IMPLEMENT_TASK') {
          if (err instanceof ExecutorContextError) {
            throw err;
          }
          throw new ExecutorContextSourceUnavailableError(
            `Failed to construct authoritative context package for IMPLEMENT_TASK: ${err instanceof Error ? err.message : String(err)}`,
            { error: err instanceof Error ? err.message : String(err), taskId: validatedRequest.taskId }
          );
        }
      }
    }

    // 1.5.1 Fail-closed: IMPLEMENT_TASK requires an authoritative context package
    if (validatedRequest.operationType === 'IMPLEMENT_TASK' && !validatedRequest.contextPackage) {
      throw new ExecutorContextSourceUnavailableError(
        'Authoritative ExecutorContextPackage is required for IMPLEMENT_TASK execution, but none was provided or constructed',
        { requestId: validatedRequest.requestId, taskId: validatedRequest.taskId }
      );
    }

    // 1.6 Freshness validation if contextPackage is present
    if (validatedRequest.contextPackage && this.validateContextFreshness) {
      const validator =
        this.contextService ??
        new ExecutorContextService({
          workspaceRoot:
            (validatedRequest.metadata?.workingDirectory as string | undefined) ?? this.workspaceRoot,
        });
      const freshness = await validator.validateContextPackage(validatedRequest.contextPackage);
      if (freshness.isStale) {
        throw new ExecutorContextStaleError(
          freshness.message ?? 'Context package is stale',
          freshness.details
        );
      }
      if (!freshness.isValid) {
        throw new ExecutorContextValidationError(
          freshness.message ?? 'Context package validation failed',
          freshness.details
        );
      }
    }

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
        // ====================================================================
        // REAL PROCESS EXECUTION BOUNDARY (Phase 14 TASK-P14-01)
        // ====================================================================

        // 1. Resolve executable
        const resolution = resolveAntigravityExecutable({
          configuredBinaryPath: this.configuredBinaryPath ?? this.binaryPath,
          cwd: payload.workingDirectory,
        });

        if (!resolution.found || !resolution.executablePath) {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);

          const completedAt = new Date().toISOString();
          return createErrorRawOutcome({
            request: validatedRequest,
            executorIdentity: this.executorIdentity,
            startedAt,
            completedAt,
            durationMs: Date.now() - startTimeMs,
            failureCategory: ExecutionFailureCategory.EXECUTOR_START_FAILURE,
            error: {
              code: 'ERR_EXECUTOR_NOT_FOUND',
              message: resolution.reason ?? `Antigravity CLI executable not found`,
              details: { resolution },
            },
          });
        }

        // 2. Compatibility probe (unless skipped or fake process runner)
        if (!this.skipCompatibilityProbe && !(this.processRunner instanceof FakeAntigravityProcessRunner)) {
          const compat = await this.compatibilityChecker.checkCompatibility(resolution, {
            cwd: payload.workingDirectory,
            timeoutMs: 5_000,
            signal: options.signal,
          });

          if (!compat.compatible) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);

            const completedAt = new Date().toISOString();
            return createErrorRawOutcome({
              request: validatedRequest,
              executorIdentity: this.executorIdentity,
              startedAt,
              completedAt,
              durationMs: Date.now() - startTimeMs,
              failureCategory: ExecutionFailureCategory.EXECUTOR_PROTOCOL_FAILURE,
              error: {
                code: 'ERR_EXECUTOR_INCOMPATIBLE',
                message: compat.reason ?? 'Antigravity CLI is incompatible with execution contract',
                details: { compatibility: compat },
              },
            });
          }
        }

        // 3. Prepare stream-json stdin protocol payload conforming to agy CLI schema
        const stdinInput = JSON.stringify({
          event: 'user',
          message: {
            content: payload.structuredPrompt,
          },
          prompt: payload.structuredPrompt,
          correlationId: payload.correlationId,
          conversationId: payload.conversationId,
          metadata: payload.metadata,
        }) + '\n';

        // 4. Launch real OS process via processRunner
        const procResult = await this.processRunner.run({
          executable: resolution.executablePath,
          args: payload.args,
          cwd: payload.workingDirectory,
          stdinInput,
          timeoutMs,
          signal: abortController.signal,
        });

        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);

        const completedAt = procResult.completedAt;
        const durationMs = procResult.durationMs;

        // Condition 1 & 2: Process could not start / spawn error
        if (procResult.spawnError) {
          const errCode = (procResult.spawnError as any).code === 'ENOENT'
            ? 'ERR_EXECUTOR_NOT_FOUND'
            : 'ERR_EXECUTOR_SPAWN_FAILED';
          return createErrorRawOutcome({
            request: validatedRequest,
            executorIdentity: this.executorIdentity,
            startedAt,
            completedAt,
            durationMs,
            failureCategory: ExecutionFailureCategory.EXECUTOR_START_FAILURE,
            error: {
              code: errCode,
              message: `Process could not start: ${procResult.spawnError.message}`,
              details: procResult.spawnError,
            },
          });
        }

        // Condition 4: Timeout
        if (procResult.timedOut || didTimeout) {
          return createTimeoutRawOutcome({
            request: validatedRequest,
            executorIdentity: this.executorIdentity,
            startedAt,
            completedAt,
            durationMs,
            failureCategory: ExecutionFailureCategory.EXECUTOR_TIMEOUT,
            stderr: procResult.stderr || `Execution timed out after ${timeoutMs}ms`,
          });
        }

        // Cancellation
        if (procResult.cancelled || abortController.signal.aborted || options.signal?.aborted) {
          return createCancelledRawOutcome({
            request: validatedRequest,
            executorIdentity: this.executorIdentity,
            startedAt,
            completedAt,
            durationMs,
            failureCategory: ExecutionFailureCategory.EXECUTOR_CANCELLED,
            reason: procResult.stderr || 'Execution was cancelled by caller signal',
          });
        }

        // Condition 3: Process started and exited non-zero
        if (procResult.exitCode !== 0) {
          return createFailureRawOutcome({
            request: validatedRequest,
            executorIdentity: this.executorIdentity,
            startedAt,
            completedAt,
            durationMs,
            exitCode: procResult.exitCode ?? 1,
            signal: procResult.signal,
            stdout: procResult.stdout,
            stderr: procResult.stderr || `Process exited with code ${procResult.exitCode}`,
            failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
            unverifiedAgentClaims: [],
            unverifiedModifiedFiles: [],
          });
        }

        // Condition 5 & 6: Process exited successfully, parse output safely
        const parsed = parseExecutorProcessOutput(procResult.stdout, validatedRequest);
        if (!parsed.safe) {
          const isOutputFailure = parsed.reason?.includes('null bytes') || parsed.reason?.includes('binary');
          return createErrorRawOutcome({
            request: validatedRequest,
            executorIdentity: this.executorIdentity,
            startedAt,
            completedAt,
            durationMs,
            failureCategory: isOutputFailure
              ? ExecutionFailureCategory.EXECUTOR_OUTPUT_FAILURE
              : ExecutionFailureCategory.EXECUTOR_PROTOCOL_FAILURE,
            error: {
              code: isOutputFailure ? 'ERR_EXECUTOR_OUTPUT_FAILURE' : 'ERR_EXECUTOR_MALFORMED_OUTPUT',
              message: parsed.reason
                ? `Process output could not be interpreted safely: ${parsed.reason}`
                : 'Process output could not be interpreted safely',
              details: { stdoutSnippet: procResult.stdout.substring(0, 500) },
            },
          });
        }

        return createSuccessRawOutcome({
          request: validatedRequest,
          executorIdentity: this.executorIdentity,
          startedAt,
          completedAt,
          durationMs,
          exitCode: 0,
          stdout: procResult.stdout,
          stderr: procResult.stderr || null,
          unverifiedAgentClaims: parsed.agentClaims,
          unverifiedModifiedFiles: parsed.modifiedFiles,
          executorMetadata: parsed.metadata,
        });
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
          failureCategory: ExecutionFailureCategory.EXECUTOR_TIMEOUT,
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
          failureCategory: ExecutionFailureCategory.EXECUTOR_CANCELLED,
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
          failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
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
          failureCategory: ExecutionFailureCategory.EXECUTOR_TIMEOUT,
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
          failureCategory: ExecutionFailureCategory.EXECUTOR_CANCELLED,
          reason: err instanceof Error ? err.message : 'Execution cancelled',
        });
      }

      return createErrorRawOutcome({
        request: validatedRequest,
        executorIdentity: this.executorIdentity,
        startedAt,
        completedAt,
        durationMs,
        failureCategory: ExecutionFailureCategory.EXECUTOR_START_FAILURE,
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
        `- Target Files: ${instruction.relevant_context.target_files &&
          instruction.relevant_context.target_files.length > 0
          ? instruction.relevant_context.target_files.join(', ')
          : 'N/A'
        }`,
        `- Architectural Decisions: ${instruction.relevant_context.decisions &&
          instruction.relevant_context.decisions.length > 0
          ? instruction.relevant_context.decisions.join(', ')
          : 'N/A'
        }`,
        `- Requirements: ${instruction.relevant_context.requirements &&
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
        `Failed to translate executor instruction to Antigravity representation: ${err instanceof Error ? err.message : String(err)
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
   * Probes environment to verify Antigravity CLI binary presence, accessibility, and compatibility.
   */
  async checkCompatibility(options?: CompatibilityCheckOptions): Promise<ExecutorCompatibility> {
    return this.compatibilityChecker.checkCompatibility(
      this.configuredBinaryPath ?? this.binaryPath,
      {
        ...options,
        cwd: this.workspaceRoot,
      }
    );
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

      if (this.processRunner instanceof FakeAntigravityProcessRunner) {
        return Object.freeze({
          available: true,
          version: this.configuredVersion ?? '1.2.8',
          reason: null,
        });
      }

      const compatibility = await this.checkCompatibility();
      if (!compatibility.compatible) {
        return Object.freeze({
          available: false,
          version: compatibility.version ?? this.configuredVersion ?? null,
          reason: compatibility.reason ?? 'Antigravity CLI is not available or compatible',
        });
      }

      return Object.freeze({
        available: true,
        version: this.configuredVersion ?? compatibility.version ?? '1.2.8',
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
      const resolution = resolveAntigravityExecutable({
        configuredBinaryPath: this.configuredBinaryPath ?? this.binaryPath,
        cwd: translatedPayload.workingDirectory,
      });

      if (!resolution.found || !resolution.executablePath) {
        outcome = Object.freeze({
          executor_id: this.executorId,
          command: `${this.binaryPath} ${translatedPayload.args.join(' ')}`,
          exit_code: null,
          signal: null,
          stdout: null,
          stderr: resolution.reason ?? 'Antigravity CLI binary not found',
          raw_payload: null,
          agent_claims: [],
          unverified_changed_files: null,
          timing: null,
        });
      } else {
        const procResult = await this.processRunner.run({
          executable: resolution.executablePath,
          args: translatedPayload.args,
          cwd: translatedPayload.workingDirectory,
          stdinInput: JSON.stringify({ prompt: translatedPayload.structuredPrompt }) + '\n',
          timeoutMs: 60_000,
        });

        outcome = Object.freeze({
          executor_id: this.executorId,
          command: `${resolution.executablePath} ${translatedPayload.args.join(' ')}`,
          exit_code: procResult.exitCode,
          signal: procResult.signal,
          stdout: procResult.stdout,
          stderr: procResult.stderr,
          raw_payload: null,
          agent_claims: [],
          unverified_changed_files: null,
          timing: {
            started_at: procResult.startedAt,
            completed_at: procResult.completedAt,
            duration_ms: procResult.durationMs,
          },
        });
      }
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
