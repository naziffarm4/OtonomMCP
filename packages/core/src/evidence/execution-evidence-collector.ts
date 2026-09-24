/**
 * System Evidence Collection & Verification Pipeline (Phase 10 TASK-P10-04)
 *
 * Independently collects repository, Git, test, and build facts, validates
 * request/task/context bindings, and deterministically evaluates acceptance criteria
 * to produce SystemExecutionEvidence and a typed decision ('ACCEPT' | 'REJECT' | 'BLOCK').
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. ZERO TRUST IN EXECUTOR: Executor claims (status=SUCCESS, stdout, agent claims,
 *    unverified modified files) are raw assertions only; never authoritative evidence.
 * 2. INDEPENDENT SYSTEM COLLECTION: Git state, changed files, and test/build outcomes
 *    are collected independently via GitPort and ProcessExecutorPort.
 * 3. ZERO STATE MUTATION: Does NOT mutate DurableStateManager, Task DAG, SpecStore,
 *    or ApprovalStore. Does NOT advance task status to ACCEPTED (belongs strictly to P10-05).
 * 4. NO AUTONOMOUS RETRY OR DISPATCH: Does NOT invoke Antigravity or trigger execution loops.
 * 5. PATH INTEGRITY: Paths with traversal (..) or absolute prefixes CANNOT enter evidence.
 * 6. DETERMINISTIC IDENTITY: evidenceId is deterministically derived from requestId.
 */

import * as path from 'node:path';
import type { GitPort } from '../git/git-port.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type {
  ProcessExecutorPort,
  ProcessExecutionResult,
} from './process-executor-port.js';
import { NodeProcessExecutor } from './process-executor-port.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import type {
  ExecutionRequest,
} from '../executor-bridge/execution-request-types.js';
import {
  type RawExecutorOutcome,
  assertNotVerifiedEvidence,
} from '../executor-bridge/raw-executor-outcome.js';
import {
  type SystemExecutionEvidence,
  type VerificationCheck,
  type ChangedFileEvidence,
  type RepositoryStateEvidence,
  type VerificationDecision,
  isSafeRelativePath,
  assertSafeEvidencePath,
  assertNoForbiddenEvidenceFields,
  computeDeterministicEvidenceId,
} from './system-execution-evidence.js';
import { ExecutionQaBridge } from '../qa-review/execution-qa-bridge.js';
import {
  SystemEvidenceBindingMismatchError,
  SystemEvidenceSecurityViolationError,
  SystemEvidenceInfrastructureError,
} from '../director/director-errors.js';

// ============================================================================
// 1. PIPELINE OPTIONS CONTRACT
// ============================================================================

export interface VerificationCommandSpec {
  readonly id: string;
  readonly type: 'TEST' | 'BUILD' | 'TYPECHECK' | 'LINT' | 'COMMAND';
  readonly command: string;
  readonly workingDirectory?: string;
  readonly mandatory?: boolean;
}

export interface SystemEvidenceCollectorOptions {
  /** Override working directory for Git and command execution */
  readonly workingDirectory?: string;
  /** Explicit verification commands to execute independently */
  readonly verificationCommands?: readonly VerificationCommandSpec[];
  /** Whether to throw SystemEvidenceBindingMismatchError on binding mismatch instead of returning REJECT */
  readonly throwOnBindingMismatch?: boolean;
  /** Whether to throw SystemEvidenceSecurityViolationError on unsafe path instead of failing check */
  readonly throwOnSecurityViolation?: boolean;
  /** Strict file scope enforcement (fails if unexpected files found) */
  readonly strictFileScope?: boolean;
}

export interface BindingValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly mismatchedField?: string;
}

// ============================================================================
// 2. SYSTEM EVIDENCE COLLECTOR CLASS
// ============================================================================

export class SystemEvidenceCollector {
  private readonly gitPort: GitPort;
  private readonly processExecutor: ProcessExecutorPort;
  private readonly historyManager?: HistoryManager;

  constructor(dependencies: {
    gitPort?: GitPort;
    processExecutor?: ProcessExecutorPort;
    historyManager?: HistoryManager;
  } = {}) {
    this.gitPort = dependencies.gitPort ?? new DefaultGitPort();
    this.processExecutor = dependencies.processExecutor ?? new NodeProcessExecutor();
    this.historyManager = dependencies.historyManager;
  }

  /**
   * Authoritative binding verification between ExecutionRequest and RawExecutorOutcome.
   * Ensures outcome cannot be accepted from another request, task, project, or revision.
   */
  validateRequestBinding(
    request: ExecutionRequest,
    outcome: RawExecutorOutcome
  ): BindingValidationResult {
    // 1. Request ID match
    if (outcome.requestId !== request.requestId) {
      return {
        valid: false,
        reason: `requestId mismatch: outcome has '${outcome.requestId}', request requires '${request.requestId}'`,
        mismatchedField: 'requestId',
      };
    }

    const binding = outcome.requestBinding;
    if (!binding) {
      return {
        valid: false,
        reason: 'RawExecutorOutcome is missing required requestBinding object',
        mismatchedField: 'requestBinding',
      };
    }

    // 2. RequestBinding requestId match
    if (binding.requestId !== request.requestId) {
      return {
        valid: false,
        reason: `requestBinding.requestId mismatch: outcome has '${binding.requestId}', request requires '${request.requestId}'`,
        mismatchedField: 'requestBinding.requestId',
      };
    }

    // 3. Project ID match
    if (binding.projectId !== request.projectId) {
      return {
        valid: false,
        reason: `projectId mismatch: outcome has '${binding.projectId}', request requires '${request.projectId}'`,
        mismatchedField: 'projectId',
      };
    }

    // 4. Task ID match
    if (binding.taskId !== request.taskId) {
      return {
        valid: false,
        reason: `taskId mismatch: outcome has '${binding.taskId}', request requires '${request.taskId}'`,
        mismatchedField: 'taskId',
      };
    }

    // 5. Task revision match
    if (binding.taskRevision !== request.taskRevision) {
      return {
        valid: false,
        reason: `taskRevision mismatch: outcome has revision ${binding.taskRevision}, request requires revision ${request.taskRevision}`,
        mismatchedField: 'taskRevision',
      };
    }

    // 6. Context fingerprint match
    if (binding.contextFingerprint !== request.contextFingerprint) {
      return {
        valid: false,
        reason: `contextFingerprint mismatch: outcome has '${binding.contextFingerprint}', request requires '${request.contextFingerprint}'`,
        mismatchedField: 'contextFingerprint',
      };
    }

    // 7. Understanding revision match
    if (binding.understandingRevision !== request.understandingRevision) {
      return {
        valid: false,
        reason: `understandingRevision mismatch: outcome has revision ${binding.understandingRevision}, request requires revision ${request.understandingRevision}`,
        mismatchedField: 'understandingRevision',
      };
    }

    // 8. Approval package revision match
    if (binding.approvalPackageRevision !== request.approvalPackageRevision) {
      return {
        valid: false,
        reason: `approvalPackageRevision mismatch: outcome has revision ${binding.approvalPackageRevision}, request requires revision ${request.approvalPackageRevision}`,
        mismatchedField: 'approvalPackageRevision',
      };
    }

    return { valid: true };
  }

  /**
   * Asserts valid request binding or throws SystemEvidenceBindingMismatchError.
   */
  assertValidRequestBinding(
    request: ExecutionRequest,
    outcome: RawExecutorOutcome
  ): void {
    const res = this.validateRequestBinding(request, outcome);
    if (!res.valid) {
      throw new SystemEvidenceBindingMismatchError(
        `Execution binding validation failed: ${res.reason}`,
        {
          requestId: request.requestId,
          mismatchedField: res.mismatchedField,
          reason: res.reason,
        }
      );
    }
  }

  /**
   * Main pipeline entry point: collects independent facts and verifies against acceptance criteria.
   */
  async collectAndVerify(
    request: ExecutionRequest,
    rawOutcome: RawExecutorOutcome,
    options: SystemEvidenceCollectorOptions = {}
  ): Promise<SystemExecutionEvidence> {
    const verifiedAt = new Date().toISOString();
    const workingDir =
      options.workingDirectory ??
      (request.metadata?.workingDirectory as string | undefined) ??
      process.cwd();

    // 1. Guard against forbidden fake verification flags in outcome or metadata
    assertNotVerifiedEvidence(rawOutcome);
    assertNoForbiddenEvidenceFields(rawOutcome);
    if (rawOutcome.executorMetadata) {
      assertNoForbiddenEvidenceFields(rawOutcome.executorMetadata);
    }

    // 2. Validate Request Binding
    const bindingResult = this.validateRequestBinding(request, rawOutcome);
    if (!bindingResult.valid && options.throwOnBindingMismatch) {
      throw new SystemEvidenceBindingMismatchError(
        `Execution request binding mismatch: ${bindingResult.reason}`,
        { requestId: request.requestId, reason: bindingResult.reason }
      );
    }

    const verificationChecks: VerificationCheck[] = [];

    // Add binding verification check
    verificationChecks.push({
      checkId: 'CHECK_REQUEST_BINDING',
      type: 'BINDING',
      status: bindingResult.valid ? 'PASS' : 'FAIL',
      evidence: bindingResult.valid
        ? 'Request, session, project, task revision, context fingerprint, and approval bindings verified matching'
        : `Binding mismatch: ${bindingResult.reason}`,
    });

    // 3. Independent Git Repository State Inspection
    const gitState = await this.gitPort.inspectState(workingDir);
    const headCommit = gitState.head_sha ?? 'UNKNOWN';
    const isClean = gitState.working_tree_clean;
    const baseCommit = request.expectedRepositoryState?.baseCommit ?? headCommit;

    const repositoryState: RepositoryStateEvidence = Object.freeze({
      baseCommit,
      headCommit,
      isClean,
    });

    // 4. Independent Changed Files Collection & Path Safety Enforcement
    const changedFiles: ChangedFileEvidence[] = [];
    const seenPaths = new Set<string>();
    const unsafePathsFound: string[] = [];

    // Helper to process changed file safely
    const processPath = (rawPath: string, status: string) => {
      const normalized = rawPath.replace(/\\/g, '/').trim();
      if (!isSafeRelativePath(normalized)) {
        unsafePathsFound.push(normalized);
        if (options.throwOnSecurityViolation) {
          throw new SystemEvidenceSecurityViolationError(
            `Unsafe path detected in repository changes: '${normalized}'. Path traversal and absolute paths cannot enter evidence.`,
            { path: normalized }
          );
        }
        return; // strictly exclude unsafe path from verified changedFiles!
      }
      if (!seenPaths.has(normalized)) {
        seenPaths.add(normalized);
        changedFiles.push({ path: normalized, status });
      }
    };

    // Staged changes
    for (const p of gitState.staged_changes) {
      processPath(p, 'STAGED');
    }
    // Unstaged changes
    for (const p of gitState.unstaged_changes) {
      processPath(p, 'MODIFIED');
    }
    // Untracked files
    for (const p of gitState.untracked_files) {
      processPath(p, 'UNTRACKED');
    }

    // Path safety check record
    if (unsafePathsFound.length > 0) {
      verificationChecks.push({
        checkId: 'CHECK_PATH_SAFETY',
        type: 'SECURITY',
        status: 'FAIL',
        evidence: `Unsafe path(s) detected and blocked from evidence: [${unsafePathsFound.join(', ')}]`,
      });
    } else {
      verificationChecks.push({
        checkId: 'CHECK_PATH_SAFETY',
        type: 'SECURITY',
        status: 'PASS',
        evidence: 'All changed file paths verified as safe relative POSIX paths',
      });
    }

    // 5. Scope Leak & Target Files Validation
    const targetFiles = request.instruction?.targetFiles ?? [];
    let unexpectedFiles: string[] = [];

    if (targetFiles.length > 0) {
      const targetNormalized = targetFiles.map((f) => f.replace(/\\/g, '/').trim());
      unexpectedFiles = changedFiles
        .map((c) => c.path)
        .filter((p) => !targetNormalized.includes(p));

      if (unexpectedFiles.length > 0) {
        verificationChecks.push({
          checkId: 'CHECK_TARGET_FILES_SCOPE',
          type: 'FILE_SCOPE',
          status: 'FAIL',
          evidence: `Unexpected file modification outside allowed targetFiles: [${unexpectedFiles.join(', ')}]`,
        });
      } else {
        verificationChecks.push({
          checkId: 'CHECK_TARGET_FILES_SCOPE',
          type: 'FILE_SCOPE',
          status: 'PASS',
          evidence: `All changed files strictly match targetFiles scope: [${changedFiles.map((c) => c.path).join(', ')}]`,
        });
      }
    } else {
      // If targetFiles is not specified, record info
      verificationChecks.push({
        checkId: 'CHECK_TARGET_FILES_SCOPE',
        type: 'FILE_SCOPE',
        status: 'PASS',
        evidence: `No explicit targetFiles restriction; recorded ${changedFiles.length} modified file(s)`,
      });
    }

    // 6. Independent Test & Build Verification Execution
    // Check if explicit verification commands are supplied in options
    const commandsToRun: VerificationCommandSpec[] = [...(options.verificationCommands ?? [])];

    // If request acceptanceCriteria specifies explicit expected_commands or types, extract them
    if (request.instruction?.acceptanceCriteria) {
      for (let i = 0; i < request.instruction.acceptanceCriteria.length; i++) {
        const crit = request.instruction.acceptanceCriteria[i];
        if (typeof crit === 'object' && crit !== null) {
          const spec = crit as { expected_command?: string; type?: string; id?: string; criterionId?: string };
          if (spec.expected_command) {
            const cid = spec.id ?? spec.criterionId ?? `CRIT_CMD_${i + 1}`;
            // Avoid duplicate commands
            if (!commandsToRun.some((c) => c.command === spec.expected_command)) {
              commandsToRun.push({
                id: cid,
                type: (spec.type as any) ?? 'COMMAND',
                command: spec.expected_command,
              });
            }
          }
        }
      }
    }

    // Run independent commands
    for (const cmdSpec of commandsToRun) {
      try {
        const cmdCwd = cmdSpec.workingDirectory ?? workingDir;
        const res: ProcessExecutionResult = await this.processExecutor.executeProcess(
          cmdSpec.command,
          { cwd: cmdCwd }
        );

        const passed = res.exitCode === 0;
        verificationChecks.push({
          checkId: `CHECK_${cmdSpec.id}`,
          type: cmdSpec.type,
          status: passed ? 'PASS' : 'FAIL',
          command: cmdSpec.command,
          durationMs: res.durationMs,
          evidence: passed
            ? `Command '${cmdSpec.command}' exited 0 in ${res.durationMs}ms`
            : `Command '${cmdSpec.command}' failed with exit code ${res.exitCode}. stderr: ${(res.stderr || res.stdout).slice(0, 300)}`,
          details: { exitCode: res.exitCode, stdoutSnippet: res.stdout.slice(0, 500) },
        });
      } catch (err: any) {
        // Infrastructure failure (spawn error, missing binary, execution failure) -> BLOCK
        verificationChecks.push({
          checkId: `CHECK_${cmdSpec.id}`,
          type: cmdSpec.type,
          status: 'BLOCK',
          command: cmdSpec.command,
          evidence: `Verification command execution failed due to infrastructure error: ${err.message ?? String(err)}`,
          details: { error: err.message },
        });
      }
    }

    // 7. Objective Acceptance Criteria Evaluation
    const evalResult = ExecutionQaBridge.evaluate({
      request,
      outcome: rawOutcome,
      verificationChecks,
      changedFiles,
      repositoryState,
      isBindingValid: bindingResult.valid,
      bindingMismatchReason: bindingResult.reason,
      unexpectedFiles,
    });

    const verificationDecision: VerificationDecision = evalResult.decision;

    // 8. Deterministic Evidence Identifier
    const evidenceId = computeDeterministicEvidenceId({
      requestId: request.requestId,
      projectId: request.projectId,
      taskId: request.taskId,
      taskRevision: request.taskRevision,
      contextFingerprint: request.contextFingerprint,
      headCommit,
      verificationDecision,
      checkSummary: evalResult.summary,
    });

    // 9. Non-authoritative Executor Reference
    const executorOutcomeReference = Object.freeze({
      status: rawOutcome.status,
      exitCode: rawOutcome.exitCode,
      durationMs: rawOutcome.durationMs,
    });

    // 10. Record verification audit event if HistoryManager is configured
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'SYSTEM_EVIDENCE_VERIFIED',
          actor: Actor.ORCHESTRATOR,
          taskId: request.taskId,
          payload: {
            evidenceId,
            requestId: request.requestId,
            projectId: request.projectId,
            verificationDecision,
            criteriaCount: evalResult.criteriaResults.length,
            checksCount: verificationChecks.length,
            changedFilesCount: changedFiles.length,
          },
        });
      } catch {
        // Logging failure must not alter verification decision
      }
    }

    // 11. Return immutable SystemExecutionEvidence
    const evidence: SystemExecutionEvidence = Object.freeze({
      evidenceId,
      requestId: request.requestId,
      projectId: request.projectId,
      taskId: request.taskId,
      taskRevision: request.taskRevision,
      contextFingerprint: request.contextFingerprint,
      understandingRevision: request.understandingRevision,
      approvalPackageRevision: request.approvalPackageRevision,
      repositoryState,
      changedFiles: Object.freeze(changedFiles),
      verificationChecks: Object.freeze(verificationChecks),
      acceptanceCriteria: evalResult.criteriaResults,
      executorOutcomeReference,
      verificationDecision,
      verifiedAt,
      metadata: Object.freeze({
        summary: evalResult.summary,
        untrustedExecutorClaims: rawOutcome.unverifiedAgentClaims,
      }),
    });

    return evidence;
  }
}
