/**
 * Deterministic Execution Request Builder (Phase 10 TASK-P10-02)
 *
 * Implements the deterministic contract generation layer converting an
 * authorized ExecutionIntent into an immutable ExecutionRequest.
 *
 * STRICT GOVERNANCE RULES:
 * 1. CONTRACT ONLY: Zero executor invocation, zero subagent spawn, zero shell commands.
 * 2. DETERMINISTIC IDENTIFIERS: requestId is computed deterministically via canonical JSON + SHA-256.
 * 3. AUTHORITATIVE INTENT VERIFICATION: Every intent must be authoritatively verified by
 *    the P10-01 ExecutionAuthorizer before request generation; caller forgery is strictly rejected.
 * 4. TASK REVISION & SPECSTORE BINDING: When instruction fields are derived from SpecStore,
 *    the task must exist and task.metadata.revision must match intent.taskRevision exactly.
 *    Mixing stale intents with newer task revisions is strictly prohibited and rejected.
 * 5. PATH RESTRICTIONS: targetFiles must be strictly relative POSIX paths; path traversal (..)
 *    and absolute paths (Unix or Windows) are strictly prohibited and rejected.
 * 6. REPOSITORY STATE FIDELITY: expectedRepositoryState is verified against authoritative
 *    Git state; baseline forgery is rejected.
 * 7. FINITE BOUNDS: executionLimits (timeoutMs, maxFileModifications) are strictly bounded.
 * 8. ZERO STATE MUTATION: Does NOT mutate DurableStateManager global FSM, Task DAG,
 *    SpecStore, or ApprovalStore.
 */

import * as crypto from 'node:crypto';
import type { GitPort } from '../git/git-port.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import type { DirectorSessionStore } from '../director/director-session-store.js';
import type { DirectorSessionEngine } from '../director/director-session-engine.js';
import type { DirectorDecisionStore } from '../director/director-decision-store.js';
import type { ApprovalStore } from '../approval/approval-store.js';
import type { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import type { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { ExecutionAuthorizer } from '../director/execution-authorizer.js';
import {
  type ExecutionIntentValidationResult,
  ExecutionIntentZodSchema,
} from '../director/execution-intent-types.js';
import {
  ExecutionIntentSessionMismatchError,
  ExecutionIntentDecisionInvalidError,
  ExecutionIntentProjectMismatchError,
  ExecutionIntentContextMismatchError,
  ExecutionIntentContextStaleError,
  ExecutionIntentContextIncompleteError,
  ExecutionIntentRevisionMismatchError,
  ExecutionIntentUnauthorizedError,
  ExecutionIntentTaskInvalidError,
} from '../director/director-errors.js';
import {
  EXECUTION_REQUEST_PROTOCOL_VERSION,
  EXECUTION_REQUEST_SCHEMA_VERSION,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  MIN_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  DEFAULT_MAX_FILE_MODIFICATIONS,
  MIN_MAX_FILE_MODIFICATIONS,
  MAX_MAX_FILE_MODIFICATIONS,
  type AcceptanceCriterionSpec,
  type ExecutionAcceptanceCriterion,
  type ExecutionInstruction,
  type ExpectedRepositoryState,
  type ExecutionLimits,
  type ExecutionRequest,
  type BuildExecutionRequestInput,
  type ExecutionRequestValidationResult,
  ExecutionRequestZodSchema,
  ExecutionRequestValidationError,
  ExecutionRequestInvalidPathError,
  ExecutionRequestRepositoryForgeryError,
  ExecutionRequestIntentMismatchError,
  ExecutionRequestLimitsInvalidError,
  ExecutionRequestTaskRevisionMismatchError,
} from './execution-request-types.js';

export interface ExecutionRequestBuilderOptions {
  readonly workspaceRoot?: string;
  readonly gitPort?: GitPort;
  readonly specStore?: SpecStore;
  readonly authorizer?: ExecutionAuthorizer;
  readonly delegate?: McpOrchestratorDelegate;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly decisionStore?: DirectorDecisionStore;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly dagEngine?: TaskDagEngine;
  readonly historyManager?: HistoryManager;
}

/**
 * Deterministically stringifies an arbitrary value into canonical JSON,
 * sorting all object keys recursively.
 */
export function canonicalStringify(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalStringify(item)).join(',') + ']';
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const entries = sortedKeys.map(
      (k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`
    );
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Computes a deterministic, collision-resistant requestId from authoritative payload fields.
 * Format: req-<sha256-hex(32)>
 */
export function computeDeterministicRequestId(payload: {
  readonly approvalPackageRevision: number;
  readonly contextFingerprint: string;
  readonly directorDecisionId: string;
  readonly directorSessionId: string;
  readonly executionLimits: ExecutionLimits;
  readonly expectedRepositoryState: ExpectedRepositoryState;
  readonly instruction: ExecutionInstruction;
  readonly operationType: string;
  readonly projectId: string;
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly understandingRevision: number;
}): string {
  const canonicalJson = canonicalStringify(payload);
  const hash = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return `req-${hash.substring(0, 32)}`;
}

export class ExecutionRequestBuilder {
  readonly workspaceRoot?: string;
  readonly gitPort: GitPort;
  readonly specStore?: SpecStore;
  readonly authorizer: ExecutionAuthorizer;

  constructor(options: ExecutionRequestBuilderOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.gitPort = options.gitPort ?? options.delegate?.gitPort ?? new DefaultGitPort();
    this.specStore = options.specStore ?? options.delegate?.specStore;
    this.authorizer =
      options.authorizer ??
      new ExecutionAuthorizer({
        workspaceRoot: this.workspaceRoot,
        delegate: options.delegate,
        sessionStore: options.sessionStore,
        sessionEngine: options.sessionEngine,
        decisionStore: options.decisionStore,
        approvalStore: options.approvalStore,
        approvalPackageEngine: options.approvalPackageEngine,
        specStore: this.specStore,
        dagEngine: options.dagEngine,
        historyManager: options.historyManager,
      });
  }

  /**
   * Throws the appropriate typed domain error based on P10-01 validation code.
   */
  private throwAuthorizationFailure(result: ExecutionIntentValidationResult): never {
    switch (result.code) {
      case 'SESSION_INVALID':
      case 'SESSION_NOT_ACTIVE':
      case 'DECISION_SESSION_MISMATCH':
        throw new ExecutionIntentSessionMismatchError(result.message, result.details);
      case 'DECISION_INVALID':
      case 'DECISION_TYPE_INVALID':
        throw new ExecutionIntentDecisionInvalidError(result.message, result.details);
      case 'PROJECT_BINDING_MISMATCH':
      case 'APPROVAL_PROJECT_MISMATCH':
      case 'TASK_PROJECT_MISMATCH':
        throw new ExecutionIntentProjectMismatchError(result.message, result.details);
      case 'CONTEXT_NOT_FOUND':
      case 'CONTEXT_FINGERPRINT_MISMATCH':
        throw new ExecutionIntentContextMismatchError(result.message, result.details);
      case 'CONTEXT_STALE':
        throw new ExecutionIntentContextStaleError(result.message, result.details);
      case 'CONTEXT_INCOMPLETE':
        throw new ExecutionIntentContextIncompleteError(result.message, result.details);
      case 'UNDERSTANDING_REVISION_MISMATCH':
      case 'APPROVAL_REVISION_MISMATCH':
        throw new ExecutionIntentRevisionMismatchError(result.message, result.details);
      case 'TASK_REVISION_MISMATCH':
        throw new ExecutionRequestTaskRevisionMismatchError(result.message, result.details);
      case 'APPROVAL_NOT_FOUND':
      case 'APPROVAL_INVALID':
      case 'APPROVAL_NOT_AUTHORIZED':
        throw new ExecutionIntentUnauthorizedError(result.message, result.details);
      case 'TASK_NOT_FOUND':
      case 'TASK_STATE_INVALID':
        throw new ExecutionIntentTaskInvalidError(result.message, result.details);
      case 'SECURITY_VIOLATION':
        throw new ExecutionIntentUnauthorizedError(result.message, result.details);
      default:
        throw new ExecutionRequestValidationError(result.message, result.details);
    }
  }

  /**
   * Normalizes and validates target file paths.
   * Enforces relative POSIX paths, rejects traversal (..) and absolute paths,
   * deduplicates, and sorts lexicographically.
   */
  canonicalizeTargetFiles(rawFiles?: readonly string[]): readonly string[] {
    if (!rawFiles || rawFiles.length === 0) {
      return Object.freeze([]);
    }

    const normalizedSet = new Set<string>();

    for (const raw of rawFiles) {
      if (typeof raw !== 'string') {
        throw new ExecutionRequestInvalidPathError(
          `Target file path must be a string, got ${typeof raw}`,
          { targetFile: raw }
        );
      }

      // Convert backslashes to forward slashes and trim
      const posixPath = raw.replace(/\\/g, '/').trim();

      if (posixPath.length === 0) {
        throw new ExecutionRequestInvalidPathError(
          'Target file path cannot be empty or whitespace only',
          { targetFile: raw }
        );
      }

      // Reject path traversal ('..')
      const segments = posixPath.split('/');
      if (segments.includes('..')) {
        throw new ExecutionRequestInvalidPathError(
          `Path traversal ('..') is strictly prohibited in targetFiles: '${raw}'`,
          { targetFile: raw }
        );
      }

      // Reject absolute paths: Unix leading '/', Windows drive letter ('C:'), or UNC ('//')
      if (
        posixPath.startsWith('/') ||
        /^[a-zA-Z]:/.test(posixPath) ||
        posixPath.startsWith('//')
      ) {
        throw new ExecutionRequestInvalidPathError(
          `Absolute paths are strictly prohibited in targetFiles: '${raw}'`,
          { targetFile: raw }
        );
      }

      // Remove redundant leading './'
      const cleanPath = posixPath.replace(/^\.\//, '');
      if (cleanPath.length === 0) {
        throw new ExecutionRequestInvalidPathError(
          `Target file path resolved to empty after normalization: '${raw}'`,
          { targetFile: raw }
        );
      }

      normalizedSet.add(cleanPath);
    }

    const sortedFiles = Array.from(normalizedSet).sort();
    return Object.freeze(sortedFiles);
  }

  /**
   * Normalizes and validates execution constraints.
   * Trims whitespace, removes empties, deduplicates, and sorts lexicographically.
   */
  canonicalizeConstraints(rawConstraints?: readonly string[]): readonly string[] {
    if (!rawConstraints || rawConstraints.length === 0) {
      return Object.freeze([]);
    }

    const constraintSet = new Set<string>();

    for (const c of rawConstraints) {
      if (typeof c !== 'string') {
        continue;
      }
      const trimmed = c.trim();
      if (trimmed.length > 0) {
        constraintSet.add(trimmed);
      }
    }

    const sorted = Array.from(constraintSet).sort();
    return Object.freeze(sorted);
  }

  /**
   * Normalizes and validates acceptance criteria.
   * Ensures at least one criterion, validates schema, deduplicates, and sorts deterministically.
   */
  canonicalizeAcceptanceCriteria(
    rawCriteria?: readonly ExecutionAcceptanceCriterion[]
  ): readonly ExecutionAcceptanceCriterion[] {
    if (!rawCriteria || rawCriteria.length === 0) {
      throw new ExecutionRequestValidationError(
        'acceptanceCriteria must contain at least one criterion'
      );
    }

    const canonicalList: ExecutionAcceptanceCriterion[] = [];
    const seenSignatures = new Set<string>();

    for (const item of rawCriteria) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length === 0) {
          throw new ExecutionRequestValidationError(
            'Acceptance criterion string cannot be empty'
          );
        }
        const sig = `str:${trimmed}`;
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          canonicalList.push(trimmed);
        }
      } else if (typeof item === 'object' && item !== null) {
        const spec = item as AcceptanceCriterionSpec;
        if (!spec.description || typeof spec.description !== 'string' || spec.description.trim().length === 0) {
          throw new ExecutionRequestValidationError(
            'Acceptance criterion object must have a non-empty description'
          );
        }
        const normalizedSpec: AcceptanceCriterionSpec = {
          description: spec.description.trim(),
          ...(spec.criterionId ? { criterionId: spec.criterionId.trim() } : {}),
          ...(spec.id ? { id: spec.id.trim() } : {}),
          ...(spec.type ? { type: spec.type.trim() } : {}),
          ...(typeof spec.mandatory === 'boolean' ? { mandatory: spec.mandatory } : {}),
        };
        const sig = `obj:${canonicalStringify(normalizedSpec)}`;
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          canonicalList.push(Object.freeze(normalizedSpec));
        }
      } else {
        throw new ExecutionRequestValidationError(
          `Invalid acceptance criterion format: expected string or object, got ${typeof item}`
        );
      }
    }

    if (canonicalList.length === 0) {
      throw new ExecutionRequestValidationError(
        'acceptanceCriteria must contain at least one valid criterion'
      );
    }

    // Sort deterministically based on canonical string representation
    canonicalList.sort((a, b) => {
      const reprA = typeof a === 'string' ? a : canonicalStringify(a);
      const reprB = typeof b === 'string' ? b : canonicalStringify(b);
      return reprA.localeCompare(reprB);
    });

    return Object.freeze(canonicalList);
  }

  /**
   * Validates and normalizes execution limits.
   * Applies defaults and enforces strictly positive, bounded integers.
   */
  canonicalizeExecutionLimits(limitsInput?: Partial<ExecutionLimits>): ExecutionLimits {
    let timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS;
    if (limitsInput?.timeoutMs !== undefined) {
      const t = limitsInput.timeoutMs;
      if (
        typeof t !== 'number' ||
        !Number.isInteger(t) ||
        isNaN(t) ||
        !isFinite(t) ||
        t < MIN_EXECUTION_TIMEOUT_MS ||
        t > MAX_EXECUTION_TIMEOUT_MS
      ) {
        throw new ExecutionRequestLimitsInvalidError(
          `Invalid execution timeoutMs: ${t}. Must be an integer between ${MIN_EXECUTION_TIMEOUT_MS} and ${MAX_EXECUTION_TIMEOUT_MS} ms.`,
          { timeoutMs: t, min: MIN_EXECUTION_TIMEOUT_MS, max: MAX_EXECUTION_TIMEOUT_MS }
        );
      }
      timeoutMs = t;
    }

    let maxFileModifications = DEFAULT_MAX_FILE_MODIFICATIONS;
    if (limitsInput?.maxFileModifications !== undefined) {
      const m = limitsInput.maxFileModifications;
      if (
        typeof m !== 'number' ||
        !Number.isInteger(m) ||
        isNaN(m) ||
        !isFinite(m) ||
        m < MIN_MAX_FILE_MODIFICATIONS ||
        m > MAX_MAX_FILE_MODIFICATIONS
      ) {
        throw new ExecutionRequestLimitsInvalidError(
          `Invalid execution maxFileModifications: ${m}. Must be an integer between ${MIN_MAX_FILE_MODIFICATIONS} and ${MAX_MAX_FILE_MODIFICATIONS}.`,
          { maxFileModifications: m, min: MIN_MAX_FILE_MODIFICATIONS, max: MAX_MAX_FILE_MODIFICATIONS }
        );
      }
      maxFileModifications = m;
    }

    return Object.freeze({
      timeoutMs,
      maxFileModifications,
    });
  }

  /**
   * Captures and/or validates the expected repository state against authoritative Git state.
   * Detects and rejects caller forgery attempts.
   */
  async resolveExpectedRepositoryState(
    targetDir: string,
    expectedState?: ExpectedRepositoryState
  ): Promise<ExpectedRepositoryState> {
    const actualGitState = await this.gitPort.inspectState(targetDir);
    const actualBaseCommit = actualGitState.head_sha ?? actualGitState.headSha;
    const actualIsClean = actualGitState.working_tree_clean ?? actualGitState.isClean ?? false;

    if (!actualBaseCommit) {
      throw new ExecutionRequestRepositoryForgeryError(
        'Authoritative Git HEAD commit could not be determined for repository state binding',
        { workingDirectory: targetDir }
      );
    }

    if (expectedState) {
      if (expectedState.baseCommit !== actualBaseCommit) {
        throw new ExecutionRequestRepositoryForgeryError(
          `Repository state forgery detected: caller expected baseCommit '${expectedState.baseCommit}', but authoritative Git HEAD is '${actualBaseCommit}'`,
          {
            expectedBaseCommit: expectedState.baseCommit,
            actualBaseCommit,
            workingDirectory: targetDir,
          }
        );
      }

      if (expectedState.isClean !== actualIsClean) {
        throw new ExecutionRequestRepositoryForgeryError(
          `Repository state forgery detected: caller expected isClean '${expectedState.isClean}', but authoritative Git working tree clean status is '${actualIsClean}'`,
          {
            expectedIsClean: expectedState.isClean,
            actualIsClean,
            workingDirectory: targetDir,
          }
        );
      }

      return Object.freeze({
        baseCommit: expectedState.baseCommit,
        isClean: expectedState.isClean,
      });
    }

    // Auto-captured authoritative state
    return Object.freeze({
      baseCommit: actualBaseCommit,
      isClean: actualIsClean,
    });
  }

  /**
   * Builds an authoritative, deterministic ExecutionRequest from a verified ExecutionIntent.
   * Strictly enforces P10-01 authorization, rejection of forged intents, and task revision integrity.
   */
  async buildExecutionRequest(input: BuildExecutionRequestInput): Promise<ExecutionRequest> {
    // 1. Validate intent structure
    if (!input || !input.intent) {
      throw new ExecutionRequestValidationError('ExecutionIntent is required to build ExecutionRequest');
    }

    const intentParsed = ExecutionIntentZodSchema.safeParse(input.intent);
    if (!intentParsed.success) {
      throw new ExecutionRequestValidationError(
        `Invalid ExecutionIntent provided: ${intentParsed.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: intentParsed.error.issues }
      );
    }
    const rawIntent = intentParsed.data;

    // 2. Strict Intent Binding Invariants (Reject caller forgery / overrides)
    if (input.projectId !== undefined && input.projectId !== rawIntent.projectId) {
      throw new ExecutionRequestIntentMismatchError(
        `projectId override mismatch: intent specifies '${rawIntent.projectId}', caller provided '${input.projectId}'`,
        { intentProjectId: rawIntent.projectId, callerProjectId: input.projectId }
      );
    }
    if (input.directorSessionId !== undefined && input.directorSessionId !== rawIntent.directorSessionId) {
      throw new ExecutionRequestIntentMismatchError(
        `directorSessionId override mismatch: intent specifies '${rawIntent.directorSessionId}', caller provided '${input.directorSessionId}'`,
        { intentSessionId: rawIntent.directorSessionId, callerSessionId: input.directorSessionId }
      );
    }
    if (input.directorDecisionId !== undefined && input.directorDecisionId !== rawIntent.directorDecisionId) {
      throw new ExecutionRequestIntentMismatchError(
        `directorDecisionId override mismatch: intent specifies '${rawIntent.directorDecisionId}', caller provided '${input.directorDecisionId}'`,
        { intentDecisionId: rawIntent.directorDecisionId, callerDecisionId: input.directorDecisionId }
      );
    }
    if (input.taskId !== undefined && input.taskId !== rawIntent.taskId) {
      throw new ExecutionRequestIntentMismatchError(
        `taskId override mismatch: intent specifies '${rawIntent.taskId}', caller provided '${input.taskId}'`,
        { intentTaskId: rawIntent.taskId, callerTaskId: input.taskId }
      );
    }
    if (input.taskRevision !== undefined && input.taskRevision !== rawIntent.taskRevision) {
      throw new ExecutionRequestIntentMismatchError(
        `taskRevision override mismatch: intent specifies ${rawIntent.taskRevision}, caller provided ${input.taskRevision}`,
        { intentTaskRevision: rawIntent.taskRevision, callerTaskRevision: input.taskRevision }
      );
    }
    if (input.contextFingerprint !== undefined && input.contextFingerprint !== rawIntent.contextFingerprint) {
      throw new ExecutionRequestIntentMismatchError(
        `contextFingerprint override mismatch: intent specifies '${rawIntent.contextFingerprint}', caller provided '${input.contextFingerprint}'`,
        { intentFingerprint: rawIntent.contextFingerprint, callerFingerprint: input.contextFingerprint }
      );
    }
    if (input.understandingRevision !== undefined && input.understandingRevision !== rawIntent.understandingRevision) {
      throw new ExecutionRequestIntentMismatchError(
        `understandingRevision override mismatch: intent specifies ${rawIntent.understandingRevision}, caller provided ${input.understandingRevision}`,
        { intentUnderstandingRevision: rawIntent.understandingRevision, callerUnderstandingRevision: input.understandingRevision }
      );
    }
    if (input.approvalPackageRevision !== undefined && input.approvalPackageRevision !== rawIntent.approvalPackageRevision) {
      throw new ExecutionRequestIntentMismatchError(
        `approvalPackageRevision override mismatch: intent specifies ${rawIntent.approvalPackageRevision}, caller provided ${input.approvalPackageRevision}`,
        { intentApprovalRevision: rawIntent.approvalPackageRevision, callerApprovalRevision: input.approvalPackageRevision }
      );
    }
    if (input.operationType !== undefined && input.operationType !== rawIntent.operationType) {
      throw new ExecutionRequestIntentMismatchError(
        `operationType override mismatch: intent specifies '${rawIntent.operationType}', caller provided '${input.operationType}'`,
        { intentOperationType: rawIntent.operationType, callerOperationType: input.operationType }
      );
    }
    if (input.protocolVersion !== undefined && input.protocolVersion !== EXECUTION_REQUEST_PROTOCOL_VERSION) {
      throw new ExecutionRequestValidationError(
        `protocolVersion override mismatch: expected '${EXECUTION_REQUEST_PROTOCOL_VERSION}', caller provided '${input.protocolVersion}'`,
        { expectedVersion: EXECUTION_REQUEST_PROTOCOL_VERSION, callerVersion: input.protocolVersion }
      );
    }
    if (input.schemaVersion !== undefined && input.schemaVersion !== EXECUTION_REQUEST_SCHEMA_VERSION) {
      throw new ExecutionRequestValidationError(
        `schemaVersion override mismatch: expected ${EXECUTION_REQUEST_SCHEMA_VERSION}, caller provided ${input.schemaVersion}`,
        { expectedVersion: EXECUTION_REQUEST_SCHEMA_VERSION, callerVersion: input.schemaVersion }
      );
    }

    // 3. Authoritative P10-01 Verification
    // Every ExecutionIntent must pass through the authoritative P10-01 boundary.
    // Callers cannot bypass authorization by sending arbitrary raw intent objects.
    const targetDir = input.workingDirectory ?? this.workspaceRoot ?? process.cwd();
    const authResult = await this.authorizer.validateExecutionIntent({
      workspaceRoot: targetDir,
      projectId: rawIntent.projectId,
      directorSessionId: rawIntent.directorSessionId,
      directorDecisionId: rawIntent.directorDecisionId,
      taskId: rawIntent.taskId,
      taskRevision: rawIntent.taskRevision,
      contextFingerprint: rawIntent.contextFingerprint,
      understandingRevision: rawIntent.understandingRevision,
      approvalPackageRevision: rawIntent.approvalPackageRevision,
      operationType: rawIntent.operationType,
      intentId: rawIntent.intentId,
      metadata: rawIntent.metadata,
    });

    if (!authResult.isValid || !authResult.intent) {
      this.throwAuthorizationFailure(authResult);
    }

    const verifiedIntent = authResult.intent;

    // 4. Instruction Formulation & Authoritative Task Revision Binding
    let objective: string | undefined = input.instruction?.objective !== undefined
      ? input.instruction.objective.trim()
      : undefined;
    let acceptanceCriteriaInput = input.instruction?.acceptanceCriteria;

    // Verify task revision and derive instruction fields if available from SpecStore
    if (this.specStore) {
      const tasks = await this.specStore.loadTasks().catch(() => []);
      const task = tasks.find((t) => t.task_id === verifiedIntent.taskId);
      if (task) {
        const authoritativeTaskRevision = (task.metadata?.revision as number | undefined) ?? 1;
        if (authoritativeTaskRevision !== verifiedIntent.taskRevision) {
          throw new ExecutionRequestTaskRevisionMismatchError(
            `Task revision mismatch: intent was formulated on taskRevision ${verifiedIntent.taskRevision}, but authoritative task in SpecStore has revision ${authoritativeTaskRevision}. Cannot mix stale intent binding with newer task definition.`,
            {
              intentTaskRevision: verifiedIntent.taskRevision,
              authoritativeTaskRevision,
              taskId: verifiedIntent.taskId,
            }
          );
        }

        if (objective === undefined) {
          objective = (task.description || task.title || '').trim();
        }
        if (acceptanceCriteriaInput === undefined && task.acceptance_criteria) {
          acceptanceCriteriaInput = task.acceptance_criteria;
        }
      } else if (objective === undefined || acceptanceCriteriaInput === undefined) {
        throw new ExecutionIntentTaskInvalidError(
          `Task '${verifiedIntent.taskId}' not found in authoritative Task DAG.`,
          { taskId: verifiedIntent.taskId }
        );
      }
    }

    if (!objective || objective.length === 0) {
      throw new ExecutionRequestValidationError(
        'Instruction objective cannot be empty. Must be provided explicitly or present in Task DAG.'
      );
    }

    const canonicalConstraints = this.canonicalizeConstraints(input.instruction?.constraints);
    const canonicalTargetFiles = this.canonicalizeTargetFiles(input.instruction?.targetFiles);
    const canonicalAcceptanceCriteria = this.canonicalizeAcceptanceCriteria(acceptanceCriteriaInput);

    const canonicalInstruction: ExecutionInstruction = Object.freeze({
      objective,
      constraints: canonicalConstraints,
      targetFiles: canonicalTargetFiles,
      acceptanceCriteria: canonicalAcceptanceCriteria,
    });

    // 5. Expected Repository State (Authoritative Git inspection)
    const canonicalRepoState = await this.resolveExpectedRepositoryState(
      targetDir,
      input.expectedRepositoryState
    );

    // 6. Execution Limits (Strict bounds & defaults)
    const canonicalLimits = this.canonicalizeExecutionLimits(input.executionLimits);

    // 7. Compute Deterministic requestId
    const hashingPayload = {
      approvalPackageRevision: verifiedIntent.approvalPackageRevision,
      contextFingerprint: verifiedIntent.contextFingerprint,
      directorDecisionId: verifiedIntent.directorDecisionId,
      directorSessionId: verifiedIntent.directorSessionId,
      executionLimits: canonicalLimits,
      expectedRepositoryState: canonicalRepoState,
      instruction: canonicalInstruction,
      operationType: verifiedIntent.operationType,
      projectId: verifiedIntent.projectId,
      protocolVersion: EXECUTION_REQUEST_PROTOCOL_VERSION,
      schemaVersion: EXECUTION_REQUEST_SCHEMA_VERSION,
      taskId: verifiedIntent.taskId,
      taskRevision: verifiedIntent.taskRevision,
      understandingRevision: verifiedIntent.understandingRevision,
    };

    const requestId = computeDeterministicRequestId(hashingPayload);

    // 8. Formulate Complete ExecutionRequest Contract
    const request: ExecutionRequest = Object.freeze({
      requestId,
      projectId: verifiedIntent.projectId,
      directorSessionId: verifiedIntent.directorSessionId,
      directorDecisionId: verifiedIntent.directorDecisionId,
      taskId: verifiedIntent.taskId,
      taskRevision: verifiedIntent.taskRevision,
      contextFingerprint: verifiedIntent.contextFingerprint,
      understandingRevision: verifiedIntent.understandingRevision,
      approvalPackageRevision: verifiedIntent.approvalPackageRevision,
      operationType: verifiedIntent.operationType,
      instruction: canonicalInstruction,
      expectedRepositoryState: canonicalRepoState,
      executionLimits: canonicalLimits,
      protocolVersion: EXECUTION_REQUEST_PROTOCOL_VERSION,
      schemaVersion: EXECUTION_REQUEST_SCHEMA_VERSION,
      intentId: verifiedIntent.intentId,
      createdAt: new Date().toISOString(),
      metadata: input.metadata ? Object.freeze({ ...input.metadata }) : undefined,
    });

    // 9. Validate against Zod schema
    const validatedRequest = ExecutionRequestZodSchema.parse(request) as ExecutionRequest;
    return Object.freeze(validatedRequest);
  }

  /**
   * Validates an existing ExecutionRequest structure against all deterministic invariants.
   */
  validateExecutionRequest(request: unknown): ExecutionRequestValidationResult {
    const parseResult = ExecutionRequestZodSchema.safeParse(request);
    if (!parseResult.success) {
      return {
        isValid: false,
        code: 'VALIDATION_ERROR',
        message: `ExecutionRequest schema validation failed: ${parseResult.error.issues[0]?.message ?? 'invalid schema'}`,
        details: { issues: parseResult.error.issues },
      };
    }

    const req = parseResult.data as ExecutionRequest;

    // 1. Verify target file path safety
    try {
      this.canonicalizeTargetFiles(req.instruction.targetFiles);
    } catch (err) {
      return {
        isValid: false,
        code: 'INVALID_PATH',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. Verify deterministic hash integrity
    const hashingPayload = {
      approvalPackageRevision: req.approvalPackageRevision,
      contextFingerprint: req.contextFingerprint,
      directorDecisionId: req.directorDecisionId,
      directorSessionId: req.directorSessionId,
      executionLimits: req.executionLimits,
      expectedRepositoryState: req.expectedRepositoryState,
      instruction: req.instruction,
      operationType: req.operationType,
      projectId: req.projectId,
      protocolVersion: req.protocolVersion,
      schemaVersion: req.schemaVersion,
      taskId: req.taskId,
      taskRevision: req.taskRevision,
      understandingRevision: req.understandingRevision,
    };

    const expectedRequestId = computeDeterministicRequestId(hashingPayload);
    if (req.requestId !== expectedRequestId) {
      return {
        isValid: false,
        code: 'VALIDATION_ERROR',
        message: `requestId hash mismatch: expected '${expectedRequestId}', found '${req.requestId}'`,
        details: { expectedRequestId, actualRequestId: req.requestId },
      };
    }

    return {
      isValid: true,
      code: 'VALID',
      message: 'ExecutionRequest is valid and conforms to deterministic contract.',
      request: req,
    };
  }
}
