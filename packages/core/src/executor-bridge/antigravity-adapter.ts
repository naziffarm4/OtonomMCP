import * as fs from 'node:fs';
import type { ExecutorPort } from './executor-port.js';
import {
  type ExecutorInstruction,
  type RawExecutorOutcome,
  type NormalizedExecutorResult,
  type ExecutorAvailability,
  ExecutorOperationType,
  ExecutorExecutionStatus,
  PolicyAuthorizationState,
  validateExecutorInstruction,
  normalizeRawExecutorOutcome,
} from './instruction-types.js';
import {
  UnsupportedOperationError,
  ExecutorUnavailableError,
  AdapterTranslationError,
} from '../errors/executor-error.js';
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
) => Promise<RawExecutorOutcome>;

export interface AntigravityAdapterConfig {
  /** Unique executor ID (defaults to 'executor:antigravity') */
  executorId?: string;
  /** File path to the Antigravity CLI binary `agy` */
  binaryPath?: string;
  /** Custom invoker for testing or custom execution dispatch */
  invoker?: AntigravityInvoker;
  /** Enforce AIDM security and policy boundary before dispatch (default: true) */
  enforceSafetyBoundary?: boolean;
  /** Override reported CLI version */
  version?: string | null;
}

// ============================================================================
// 2. ANTIGRAVITY ADAPTER IMPLEMENTATION (Requirement 4, DEC-007)
// ============================================================================

export class AntigravityAdapter implements ExecutorPort {
  readonly executorId: string;
  readonly provider = 'antigravity';
  readonly supportedOperations: readonly ExecutorOperationType[];
  readonly binaryPath: string;

  private readonly invoker?: AntigravityInvoker;
  private readonly enforceSafetyBoundary: boolean;
  private readonly configuredVersion?: string | null;

  constructor(config: AntigravityAdapterConfig = {}) {
    this.executorId = config.executorId ?? 'executor:antigravity';
    this.binaryPath =
      config.binaryPath ??
      (process.env.ANTIGRAVITY_BIN_PATH || '/home/codespace/.local/bin/agy');
    this.invoker = config.invoker;
    this.enforceSafetyBoundary = config.enforceSafetyBoundary ?? true;
    this.configuredVersion = config.version;

    // All standard AIDM executor operations supported by the Antigravity adapter boundary
    this.supportedOperations = Object.freeze([
      ExecutorOperationType.IMPLEMENT_TASK,
      ExecutorOperationType.EXECUTE_TEST,
      ExecutorOperationType.EXECUTE_BUILD,
      ExecutorOperationType.INSPECT_WORKSPACE,
      ExecutorOperationType.APPLY_REPAIR,
    ]);
  }

  /**
   * Translates the generic ExecutorInstruction into the Antigravity CLI representation.
   * Deterministic: Given identical instructions, produces identical payloads.
   * 
   * DEC-007 Architectural Invariant:
   * The adapter MUST NOT include --dangerously-skip-permissions or any permission bypass.
   * Antigravity is invoked exclusively through its normal supported interface.
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
      // 2. Assemble deterministic CLI arguments (NORMAL supported interface; NO permission bypass!)
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

      // Check for conversation continuation if provided in context metadata
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
   * Deterministic: Repeated calls with identical arguments return identical results.
   */
  normalize(
    outcome: RawExecutorOutcome,
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
      if (this.invoker) {
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
   * Executes an instruction through the Antigravity adapter boundary.
   * 
   * Enforces security/authorization boundary:
   * "No valid authorization decision => do not execute."
   * Returns explicit blocked/requires-authorization result when not authorized.
   * Never weakens or bypasses executor permissions.
   */
  async execute(instruction: ExecutorInstruction): Promise<NormalizedExecutorResult> {
    // 1. Validate instruction structure & invariants
    const validatedInstruction = validateExecutorInstruction(instruction);

    // 2. Enforce Policy Authorization Boundary
    if (this.enforceSafetyBoundary) {
      const policyDecision = validatedInstruction.policy_decision;
      const isAuthorized = policyDecision.state === PolicyAuthorizationState.AUTHORIZED;

      // CRITICAL operations require verified human authorization with a non-empty decision token
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

      // Working directory path traversal check
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

        // Return explicit blocked / requires-authorization normalized result without executing
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

    // 3. Translate instruction (also checks supported operations)
    const translatedPayload = this.translate(validatedInstruction);

    // 4. Verify executor availability
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

    // 5. Invoke executor through normal supported interface (NO permission bypass!)
    let outcome: RawExecutorOutcome;
    if (this.invoker) {
      outcome = await this.invoker(translatedPayload, validatedInstruction);
    } else {
      // Safe boundary fallback when external process invocation is not wired:
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

    // 6. Normalize raw outcome into canonical result
    return this.normalize(outcome, validatedInstruction);
  }
}
