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
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { GitPort } from '../git/git-port.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type {
  ProcessExecutorPort,
  ProcessExecutionResult,
} from './process-executor-port.js';
import { NodeProcessExecutor } from './process-executor-port.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import { Actor } from '../actors.js';
import type {
  ExecutionRequest,
} from '../executor-bridge/execution-request-types.js';
import {
  type RawExecutorOutcome,
  ExecutionFailureCategory,
  isExecutionFailureCategory,
  assertNotVerifiedEvidence,
} from '../executor-bridge/raw-executor-outcome.js';
import {
  type SystemExecutionEvidence,
  type VerificationCheck,
  type VerificationCheckStatus,
  type ChangedFileEvidence,
  type RepositoryStateEvidence,
  type VerificationDecision,
  type ExecutorOutcomeReference,
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
import { sanitizeEvidenceSecrets, sanitizeEvidenceDetails } from '../errors/evidence-error.js';

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

/**
 * Safely computes SHA-256 hash for a file. Returns null if file does not exist or cannot be read.
 */
export function computeFileSha256Sync(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Captures pre-execution baseline SHA-256 hashes for target/candidate paths in the workspace.
 */
export function capturePreExecutionBaseline(
  workingDir: string,
  relativePaths: readonly string[]
): Map<string, string | null> {
  const baseline = new Map<string, string | null>();
  for (const rel of relativePaths) {
    const normalized = rel.replace(/\\/g, '/').trim();
    const full = path.resolve(workingDir, normalized);
    baseline.set(normalized, computeFileSha256Sync(full));
  }
  return baseline;
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
  /** Optional durable evidence store to persist verified evidence automatically */
  readonly evidenceStore?: SystemExecutionEvidenceStore;
  /** Pre-execution file SHA-256 baseline to differentiate pre-existing modifications from task mutations */
  readonly preExecutionBaseline?: ReadonlyMap<string, string | null> | Record<string, string | null>;
  /** Whether to enforce the workspace mandate scope ('packages' and 'docs'). Defaults to true if in workspace root. */
  readonly enforceMandateScope?: boolean;
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
  private readonly evidenceStore?: SystemExecutionEvidenceStore;

  constructor(dependencies: {
    gitPort?: GitPort;
    processExecutor?: ProcessExecutorPort;
    historyManager?: HistoryManager;
    evidenceStore?: SystemExecutionEvidenceStore;
  } = {}) {
    this.gitPort = dependencies.gitPort ?? new DefaultGitPort();
    this.processExecutor = dependencies.processExecutor ?? new NodeProcessExecutor();
    this.historyManager = dependencies.historyManager;
    this.evidenceStore = dependencies.evidenceStore;
  }

  /**
   * Captures the pre-execution SHA-256 baseline of any dirty, staged, or untracked files
   * currently existing in the repository before task execution starts.
   */
  async captureBaseline(workingDir: string): Promise<Map<string, string | null>> {
    try {
      const gitState = await this.gitPort.inspectState(workingDir);
      const dirty = [
        ...gitState.staged_changes,
        ...gitState.unstaged_changes,
        ...gitState.untracked_files,
      ];
      return capturePreExecutionBaseline(workingDir, dirty);
    } catch {
      return new Map();
    }
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

    // Check Git baseline match if expected base commit is specified
    if (request.expectedRepositoryState?.baseCommit) {
      const expectedBase = request.expectedRepositoryState.baseCommit;
      if (headCommit !== expectedBase) {
        verificationChecks.push({
          checkId: 'CHECK_GIT_BASELINE',
          type: 'GIT',
          status: 'FAIL',
          evidence: `Git baseline mismatch: expected base commit '${expectedBase}', but repository HEAD is '${headCommit}'`,
        });
      } else {
        verificationChecks.push({
          checkId: 'CHECK_GIT_BASELINE',
          type: 'GIT',
          status: 'PASS',
          evidence: `Repository state verified matching expected base commit '${expectedBase}'`,
        });
      }
    }

    // 4. Independent Changed Files Collection & Path Safety Enforcement
    const changedFiles: ChangedFileEvidence[] = [];
    const seenPaths = new Set<string>();
    const unsafePathsFound: string[] = [];
    const workspaceEscapesFound: string[] = [];

    let realWorkingDir: string;
    try {
      realWorkingDir = fs.realpathSync(workingDir);
    } catch {
      realWorkingDir = path.resolve(workingDir);
    }

    const preBaseline = options.preExecutionBaseline;

    // Helper to process changed file safely
    const processPath = (rawPath: string, status: string) => {
      const normalized = rawPath.replace(/\\/g, '/').trim();
      // Internal AIDM state stores: only narrow, explicit metadata exceptions are recognized.
      // Unexpected modifications (e.g. non-metadata scripts, backdoors) or VCS (.git/) mutations must NOT be silently ignored.
      const isAidmMetadataException = (p: string): boolean => {
        if (!p.startsWith('.ai-manager/')) return false;
        const sub = p.slice('.ai-manager/'.length);
        const allowedSubdirs = [
          'sessions/',
          'decisions/',
          'evidence/',
          'specs/',
          'runtime/',
          'durable-state/',
          'approvals/',
          'clarifications/',
          'history/',
          'locks/',
          'logs/',
          'checkpoints/',
          'driver/',
          'budget/',
        ];
        const inAllowedDir = allowedSubdirs.some((dir) => sub.startsWith(dir));
        const hasAllowedExt = /\.(json|db|lock|log|sqlite|sqlite-journal|sqlite-wal|sqlite-shm|ndjson)$/i.test(sub);
        return inAllowedDir && hasAllowedExt;
      };

      if (isAidmMetadataException(normalized)) {
        return;
      }
      if (normalized.includes(' -> ')) {
        const parts = normalized.split(' -> ');
        const oldP = parts[0]?.trim() ?? '';
        const newP = parts[1]?.trim() ?? '';

        const oldSafe = isSafeRelativePath(oldP);
        const newSafe = isSafeRelativePath(newP);

        if (!oldSafe || !newSafe) {
          if (!oldSafe) unsafePathsFound.push(oldP);
          if (!newSafe) unsafePathsFound.push(newP);
          if (options.throwOnSecurityViolation) {
            throw new SystemEvidenceSecurityViolationError(
              `Unsafe path detected in repository changes: '${normalized}'. Path traversal and absolute paths cannot enter evidence.`,
              { path: normalized }
            );
          }
          return;
        }

        if (!seenPaths.has(normalized)) {
          seenPaths.add(normalized);
          const fullNew = path.resolve(workingDir, newP);
          const postHash = computeFileSha256Sync(fullNew);
          changedFiles.push({ path: normalized, status, sha256: postHash });
        }
        return;
      }

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

      // Check symlink, junction or escape outside workspace
      const fullPath = path.resolve(workingDir, normalized);
      let isEscape = false;
      try {
        if (fs.existsSync(fullPath)) {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isSymbolicLink()) {
            isEscape = true;
          }
          const realTarget = fs.realpathSync(fullPath);
          const relToWorking = path.relative(realWorkingDir, realTarget);
          if (relToWorking.startsWith('..') || path.isAbsolute(relToWorking)) {
            isEscape = true;
          }
        }
      } catch {
        // ignore fs errors
      }

      if (isEscape) {
        workspaceEscapesFound.push(normalized);
        if (options.throwOnSecurityViolation) {
          throw new SystemEvidenceSecurityViolationError(
            `Symlink, junction, or workspace escape detected: '${normalized}'. Path resolves outside workspace.`,
            { path: normalized }
          );
        }
        return;
      }

      // Pre-execution baseline check: filter out pre-existing dirty files with identical SHA-256
      const postHash = computeFileSha256Sync(fullPath);
      if (preBaseline) {
        const preHash = preBaseline instanceof Map
          ? preBaseline.get(normalized)
          : (preBaseline as Record<string, string | null>)[normalized];
        if (preHash !== undefined && preHash !== null && postHash !== null && preHash === postHash) {
          // File was already modified before task execution and was NOT mutated by this task.
          return;
        }
      }

      if (!seenPaths.has(normalized)) {
        seenPaths.add(normalized);
        changedFiles.push({ path: normalized, status, sha256: postHash });
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

    // Symlink / Workspace escape check record
    if (workspaceEscapesFound.length > 0) {
      verificationChecks.push({
        checkId: 'CHECK_WORKSPACE_ESCAPE',
        type: 'SECURITY',
        status: 'FAIL',
        evidence: `Symlink, junction, or workspace escape detected: [${workspaceEscapesFound.join(', ')}]`,
      });
    } else {
      verificationChecks.push({
        checkId: 'CHECK_WORKSPACE_ESCAPE',
        type: 'SECURITY',
        status: 'PASS',
        evidence: 'All changed files verified within workspace boundaries without symlink/junction escapes',
      });
    }

    // Pre-execution baseline check record
    if (preBaseline) {
      verificationChecks.push({
        checkId: 'CHECK_SHA256_BASELINE',
        type: 'BASELINE',
        status: 'PASS',
        evidence: `Verified net file mutations against pre-execution baseline: ${changedFiles.length} actual mutation(s)`,
      });
    }

    // 5. Scope Leak, Implementation Scope & Target Files Validation
    const implementationScope = request.instruction?.implementationScope;
    const targetFiles = request.instruction?.targetFiles ?? [];
    let unexpectedFiles: string[] = [];

    if (implementationScope !== undefined) {
      // CASE 1 & CASE 2: implementationScope is defined
      const normalizedScopeEntries = implementationScope.map((s) => s.replace(/\\/g, '/').trim());

      // Scope entries are exact files, directory prefixes, or simple globs ('*' = one path segment,
      // '**' = any depth, e.g. 'assets/**', '*.css').
      const scopeGlob = (g: string): RegExp => {
        let r = '';
        for (let i = 0; i < g.length; i++) {
          const ch = g[i]!;
          if (ch === '*') {
            if (g[i + 1] === '*') {
              i++;
              if (g[i + 1] === '/') {
                i++;
                r += '(?:.*/)?';
              } else r += '.*';
            } else r += '[^/]*';
          } else if (ch === '?') r += '[^/]';
          else r += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp(`^${r}$`);
      };
      const isPathInScope = (filePath: string): boolean => {
        return normalizedScopeEntries.some((scope) => {
          if (scope.includes('*') || scope.includes('?')) return scopeGlob(scope).test(filePath);
          return filePath === scope || filePath.startsWith(scope.replace(/\/+$/, '') + '/');
        });
      };

      const outOfScopePaths: string[] = [];

      for (const changed of changedFiles) {
        if (changed.path.includes(' -> ')) {
          const parts = changed.path.split(' -> ');
          const oldPath = parts[0]?.trim() ?? '';
          const newPath = parts[1]?.trim() ?? '';

          if (oldPath.length > 0 && !isPathInScope(oldPath)) {
            if (!outOfScopePaths.includes(oldPath)) {
              outOfScopePaths.push(oldPath);
            }
          }
          if (newPath.length > 0 && !isPathInScope(newPath)) {
            if (!outOfScopePaths.includes(newPath)) {
              outOfScopePaths.push(newPath);
            }
          }
        } else {
          if (!isPathInScope(changed.path)) {
            if (!outOfScopePaths.includes(changed.path)) {
              outOfScopePaths.push(changed.path);
            }
          }
        }
      }

      unexpectedFiles = outOfScopePaths;

      if (unexpectedFiles.length > 0) {
        verificationChecks.push({
          checkId: 'CHECK_IMPLEMENTATION_SCOPE',
          type: 'FILE_SCOPE',
          status: 'FAIL',
          evidence: `Repository changes outside allowed implementationScope: [${unexpectedFiles.join(', ')}]`,
        });
      } else {
        verificationChecks.push({
          checkId: 'CHECK_IMPLEMENTATION_SCOPE',
          type: 'FILE_SCOPE',
          status: 'PASS',
          evidence: `All changed files strictly match implementationScope: [${changedFiles.map((c) => c.path).join(', ')}]`,
        });
      }
    } else {
      // CASE 3: implementationScope is undefined (preserve backward compatibility)
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
    }

    // 5b. Workspace Mandate Scope Verification ('packages' and 'docs')
    let isWorkspaceRoot = false;
    try {
      isWorkspaceRoot =
        fs.existsSync(path.resolve(workingDir, 'packages')) &&
        fs.existsSync(path.resolve(workingDir, 'docs'));
    } catch {
      isWorkspaceRoot = false;
    }
    const shouldEnforceMandate = options.enforceMandateScope ?? isWorkspaceRoot;

    if (shouldEnforceMandate && changedFiles.length > 0) {
      const outOfMandate = changedFiles.filter((c) => {
        const p = c.path;
        return !p.startsWith('packages/') && !p.startsWith('docs/');
      });

      if (outOfMandate.length > 0) {
        verificationChecks.push({
          checkId: 'CHECK_MANDATE_SCOPE',
          type: 'FILE_SCOPE',
          status: 'FAIL',
          evidence: `Changes detected outside authorized mandate scope ('packages' and 'docs'): [${outOfMandate.map((c) => c.path).join(', ')}]`,
        });
        for (const f of outOfMandate) {
          if (!unexpectedFiles.includes(f.path)) {
            unexpectedFiles.push(f.path);
          }
        }
      } else {
        verificationChecks.push({
          checkId: 'CHECK_MANDATE_SCOPE',
          type: 'FILE_SCOPE',
          status: 'PASS',
          evidence: `All changed files are within authorized mandate scope ('packages' and 'docs')`,
        });
      }
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
                type: (spec.type as VerificationCommandSpec['type']) ?? 'COMMAND',
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

        const isMissingBinary =
          res.exitCode === 127 ||
          (Boolean(res.stderr) && res.stderr.includes('is not recognized as an internal or external command'));
        const passed = res.exitCode === 0;
        const checkStatus: VerificationCheckStatus = passed
          ? 'PASS'
          : isMissingBinary
          ? 'BLOCK'
          : 'FAIL';

        verificationChecks.push({
          checkId: `CHECK_${cmdSpec.id}`,
          type: cmdSpec.type,
          status: checkStatus,
          command: cmdSpec.command,
          durationMs: res.durationMs,
          evidence: passed
            ? `Command '${cmdSpec.command}' exited 0 in ${res.durationMs}ms`
            : isMissingBinary
            ? `Verification command failed due to missing tool binary: ${(res.stderr || res.stdout).slice(0, 300)}`
            : `Command '${cmdSpec.command}' failed with exit code ${res.exitCode}. stderr: ${(res.stderr || res.stdout).slice(0, 300)}`,
          details: {
            exitCode: res.exitCode,
            stdoutSnippet: res.stdout.slice(0, 500),
            // Tails carry the actual failure (test runners print summaries last); fed back to the Director.
            ...(passed ? {} : { stdoutTail: res.stdout.slice(-2000), stderrTail: (res.stderr ?? '').slice(-2000) }),
          },
        });
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        // Infrastructure failure (spawn error, missing binary, execution failure) -> BLOCK
        verificationChecks.push({
          checkId: `CHECK_${cmdSpec.id}`,
          type: cmdSpec.type,
          status: 'BLOCK',
          command: cmdSpec.command,
          evidence: `Verification command execution failed due to infrastructure error: ${errMessage}`,
          details: { error: errMessage },
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

    const gitBaselineMismatch = Boolean(
      request.expectedRepositoryState?.baseCommit &&
      headCommit !== request.expectedRepositoryState.baseCommit
    );

    let failureCategory: ExecutionFailureCategory | undefined;
    if (verificationDecision !== 'ACCEPT') {
      failureCategory = this.determineFailureCategory({
        rawOutcome,
        bindingValid: bindingResult.valid,
        gitBaselineMismatch,
        unsafePathsFound: unsafePathsFound.length > 0,
        workspaceEscapesFound: workspaceEscapesFound.length > 0,
        unexpectedFiles: unexpectedFiles.length > 0,
        verificationChecks,
        verificationDecision,
      });
    }

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
    const executorOutcomeReference: ExecutorOutcomeReference = Object.freeze({
      status: rawOutcome.status,
      exitCode: rawOutcome.exitCode,
      durationMs: rawOutcome.durationMs,
      timedOut: rawOutcome.timedOut,
      cancelled: rawOutcome.cancelled,
      signal: rawOutcome.signal,
      failureCategory,
      errorCode: rawOutcome.error?.code ?? null,
      errorMessage: rawOutcome.error?.message ? sanitizeEvidenceSecrets(rawOutcome.error.message) : null,
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
            failureCategory,
            criteriaCount: evalResult.criteriaResults.length,
            checksCount: verificationChecks.length,
            changedFilesCount: changedFiles.length,
          },
        });
      } catch {
        // Logging failure must not alter verification decision
      }
    }

    const sanitizedDiagnostics = sanitizeEvidenceSecrets(
      rawOutcome.error?.message ||
      rawOutcome.stderr ||
      evalResult.summary
    );

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
      failureCategory,
      executionIntentBinding: Object.freeze({
        directorSessionId: request.directorSessionId,
        directorDecisionId: request.directorDecisionId,
      }),
      metadata: Object.freeze({
        summary: evalResult.summary,
        evaluationSummary: evalResult.summary,
        failureCategory,
        executionIntentBinding: {
          directorSessionId: request.directorSessionId,
          directorDecisionId: request.directorDecisionId,
        },
        diagnostics: sanitizedDiagnostics,
        untrustedExecutorClaims: rawOutcome.unverifiedAgentClaims,
      }),
    });

    // 12. Persist evidence if evidenceStore is configured
    const storeToUse = options.evidenceStore ?? this.evidenceStore;
    if (storeToUse) {
      await storeToUse.saveEvidence(evidence);
    }

    return evidence;
  }

  /**
   * Derives deterministic failure category for rejected or blocked verification results (P14-04).
   */
  private determineFailureCategory(params: {
    rawOutcome: RawExecutorOutcome;
    bindingValid: boolean;
    gitBaselineMismatch: boolean;
    unsafePathsFound: boolean;
    workspaceEscapesFound?: boolean;
    unexpectedFiles: boolean;
    verificationChecks: readonly VerificationCheck[];
    verificationDecision: VerificationDecision;
  }): ExecutionFailureCategory {
    // 1. Workspace escape or security failure has highest priority
    if (params.workspaceEscapesFound) {
      return ExecutionFailureCategory.WORKSPACE_ESCAPE;
    }

    if (
      !params.bindingValid ||
      params.gitBaselineMismatch ||
      params.unsafePathsFound ||
      params.unexpectedFiles
    ) {
      return ExecutionFailureCategory.SECURITY_FAILURE;
    }

    // 2. Infrastructure block
    if (
      params.verificationDecision === 'BLOCK' ||
      params.verificationChecks.some((c) => c.status === 'BLOCK')
    ) {
      return ExecutionFailureCategory.INFRASTRUCTURE_BLOCK;
    }

    // 3. Explicit raw outcome failure category if specified
    if (params.rawOutcome.failureCategory && isExecutionFailureCategory(params.rawOutcome.failureCategory)) {
      return params.rawOutcome.failureCategory;
    }

    // 4. Trace from raw executor status/error
    const status = params.rawOutcome.status;
    const errorCode = params.rawOutcome.error?.code;

    if (errorCode === 'ERR_EXECUTOR_NOT_FOUND' || errorCode === 'ERR_EXECUTOR_SPAWN_FAILED') {
      return ExecutionFailureCategory.EXECUTOR_START_FAILURE;
    }

    if (errorCode === 'ERR_EXECUTOR_INCOMPATIBLE' || errorCode === 'ERR_EXECUTOR_PROTOCOL_FAILURE') {
      return ExecutionFailureCategory.EXECUTOR_PROTOCOL_FAILURE;
    }

    if (errorCode === 'ERR_EXECUTOR_OUTPUT_FAILURE') {
      return ExecutionFailureCategory.EXECUTOR_OUTPUT_FAILURE;
    }

    if (params.rawOutcome.timedOut || status === 'TIMEOUT' || errorCode === 'ERR_EXECUTOR_TIMEOUT') {
      return ExecutionFailureCategory.EXECUTOR_TIMEOUT;
    }

    if (params.rawOutcome.cancelled || status === 'CANCELLED' || errorCode === 'ERR_EXECUTOR_CANCELLED') {
      return ExecutionFailureCategory.EXECUTOR_CANCELLED;
    }

    if (status === 'FAILURE' || (params.rawOutcome.exitCode !== null && params.rawOutcome.exitCode !== 0)) {
      return ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE;
    }

    if (status === 'ERROR') {
      return ExecutionFailureCategory.EXECUTOR_START_FAILURE;
    }

    // 5. Default when executor finished SUCCESS but verification rejected result
    return ExecutionFailureCategory.VERIFICATION_FAILURE;
  }
}
