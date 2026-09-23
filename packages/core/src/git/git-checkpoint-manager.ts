import * as crypto from 'node:crypto';
import { RiskLevel, isRiskLevel } from '../risk.js';
import {
  type GitState,
  type GitOperationIntent,
  type GitPolicyDecision,
  type GitExecutionResult,
  type GitCheckpoint,
  type GitCheckpointPurpose,
  type GitPolicyViolation,
  type GitRollbackResult,
  type RollbackOptions,
  GitOperationType,
  GitStatus,
  GitPolicyViolationCode,
} from './git-types.js';
import { type GitPort } from './git-port.js';
import { GitRollbackManager } from './git-rollback-manager.js';
import {
  GitPolicyValidator,
  type GitPolicyConfig,
  type CheckpointIntegrityOptions,
  DEFAULT_GIT_POLICY_CONFIG,
} from './git-policy-validator.js';
import {
  createGitCheckpoint,
  validateGitCheckpointSchema,
  isValidCommitSha,
} from './git-checkpoint-factory.js';
import {
  GitPolicyError,
  GitForcePushProhibitedError,
  GitCheckpointIntegrityError,
  GitDirtyWorktreeError,
  GitDetachedHeadError,
  GitBranchMismatchError,
  GitRemoteMismatchError,
  GitRemoteVerificationError,
  GitParentMismatchError,
  type GitPolicyErrorDetails,
} from '../errors/git-policy-error.js';

// ============================================================================
// 1. MANAGER CONTRACTS & OPTIONS
// ============================================================================

export interface CreateCheckpointOptions {
  /**
   * Required task ID attributable to this checkpoint.
   */
  readonly task_id: string;

  /**
   * Purpose of the checkpoint (e.g. PRE_FLIGHT, POST_FLIGHT, TASK_BOUNDARY, RECOVERY_BASE, MANUAL).
   */
  readonly purpose: GitCheckpointPurpose;

  /**
   * Optional phase identifier (defaults to 'PHASE_6').
   */
  readonly phase?: string;

  /**
   * Optional deterministic checkpoint ID. If omitted, deterministically generated from task_id, purpose, commitSha, and metadata.
   */
  readonly checkpoint_id?: string;

  /**
   * Expected parent commit SHA. If specified, must match observed parent SHA or previous checkpoint.
   */
  readonly expected_parent_sha?: string | null;

  /**
   * Expected branch name. If specified, must match the current observed repository branch.
   */
  readonly expected_branch?: string;

  /**
   * Expected remote name (defaults to configured remote, e.g. 'origin').
   */
  readonly target_remote?: string;

  /**
   * Whether remote verification is required as part of known-good creation.
   * If true, remote verification is performed via GitPort.verifyRemote.
   */
  readonly verify_remote?: boolean;

  /**
   * Requested policy / risk level. Defaults to RiskLevel.CAUTION.
   * If CRITICAL or contains force, rejected immediately.
   */
  readonly policy_level?: RiskLevel;

  /**
   * Working directory override for this operation.
   */
  readonly working_directory?: string;

  /**
   * Optional custom metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;

  // CamelCase aliases
  readonly taskId?: string;
  readonly checkpointId?: string;
  readonly expectedParentSha?: string | null;
  readonly expectedBranch?: string;
  readonly targetRemote?: string;
  readonly verifyRemote?: boolean;
  readonly policyLevel?: RiskLevel;
  readonly workingDirectory?: string;
}

export interface VerifyCheckpointOptions {
  /**
   * Current Git state to verify against. If omitted, inspected via gitPort.inspectState.
   */
  readonly currentState?: GitState;

  /**
   * Expected parent commit SHA.
   */
  readonly expected_parent_sha?: string | null;

  /**
   * Expected branch name.
   */
  readonly expected_branch?: string;

  /**
   * Expected remote name.
   */
  readonly expected_remote?: string;

  /**
   * Require working tree to be clean. Defaults to true.
   */
  readonly require_clean_worktree?: boolean;

  /**
   * Require remote verification. Defaults to false (unless checkpoint.remote_verified is true).
   */
  readonly require_remote_verified?: boolean;

  /**
   * Expected commit SHA. Defaults to checkpoint.commit_sha.
   */
  readonly expected_commit_sha?: string;

  /**
   * Working directory override.
   */
  readonly working_directory?: string;

  /**
   * When true, throws structured GitPolicyError / GitCheckpointIntegrityError upon verification failure.
   */
  readonly throwOnError?: boolean;

  // CamelCase aliases
  readonly expectedParentSha?: string | null;
  readonly expectedBranch?: string;
  readonly expectedRemote?: string;
  readonly requireCleanWorktree?: boolean;
  readonly requireRemoteVerified?: boolean;
  readonly expectedCommitSha?: string;
  readonly workingDirectory?: string;
}

export interface CheckpointVerificationResult {
  readonly valid: boolean;
  readonly is_known_good: boolean;
  readonly checkpoint_id: string;
  readonly commit_sha: string;
  readonly branch: string;
  readonly verified_at: string;
  readonly policy_decision?: GitPolicyDecision;
  readonly errors: readonly string[];
  readonly violations: readonly GitPolicyViolation[];
  readonly remote_verified: boolean;
  readonly state?: GitState;

  // Convenience aliases
  readonly checkpointId?: string;
  readonly commitSha?: string;
  readonly isKnownGood?: boolean;
}

/**
 * A known-good checkpoint that preserves full provenance:
 * - observed Git state before execution
 * - checkpoint metadata
 * - policy authorization decision
 * - execution result from GitPort
 * - verified checkpoint
 */
export interface KnownGoodCheckpoint extends GitCheckpoint {
  readonly is_known_good: true;
  readonly verified_at: string;
  readonly observed_state: GitState;
  readonly policy_decision: GitPolicyDecision;
  readonly execution_result: GitExecutionResult;
  readonly checkpoint: GitCheckpoint;

  // Aliases
  readonly isKnownGood?: true;
  readonly verifiedAt?: string;
  readonly observedState?: GitState;
  readonly policyDecision?: GitPolicyDecision;
  readonly executionResult?: GitExecutionResult;
}

export interface CheckpointFilter {
  readonly taskId?: string;
  readonly branch?: string;
  readonly purpose?: GitCheckpointPurpose;
  readonly onlyKnownGood?: boolean;
}

export interface GitCheckpointManagerOptions {
  readonly policyValidator?: GitPolicyValidator;
  readonly policyConfig?: Partial<GitPolicyConfig>;
  readonly defaultWorkingDirectory?: string;
}

// ============================================================================
// 2. DETERMINISTIC CHECKPOINT ID GENERATOR
// ============================================================================

/**
 * Deterministically generates a checkpoint ID attributable to task, purpose, commit SHA, and metadata.
 */
export function generateDeterministicCheckpointId(
  taskId: string,
  purpose: string,
  commitSha: string,
  metadata?: Readonly<Record<string, unknown>>
): string {
  const metaStr =
    metadata && Object.keys(metadata).length > 0
      ? JSON.stringify(metadata, Object.keys(metadata).sort())
      : '';
  const hash = crypto
    .createHash('sha256')
    .update(`${taskId}:${purpose}:${commitSha}:${metaStr}`)
    .digest('hex')
    .slice(0, 12);
  const cleanTask = taskId.replace(/[^a-zA-Z0-9]/g, '_');
  const cleanPurpose = purpose.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_');
  const shortHead = commitSha.slice(0, 8);
  return `chk_${cleanTask}_${cleanPurpose}_${shortHead}_${hash}`;
}

// ============================================================================
// 3. GIT CHECKPOINT MANAGER IMPLEMENTATION
// ============================================================================

/**
 * Provider-neutral production Git checkpoint manager.
 * Orchestrates checkpoint creation, verification, and inspection on top of the
 * P6-01 Git policy boundary without bypassing GitPolicyValidator or duplicating policy logic.
 *
 * Security guarantees:
 * - Depends solely on GitPort abstractions (zero process / shell dependencies)
 * - Prohibits force push, hard reset, and destructive mutations unconditionally
 * - Enforces clean working tree before checkpoint creation
 * - Verifies parent SHA integrity and branch consistency
 * - Distinguishes local checkpoint creation from remote state and verified remote state
 * - Guarantees known-good status is granted only after verification succeeds
 */
export class GitCheckpointManager {
  readonly gitPort: GitPort;
  readonly policyValidator: GitPolicyValidator;
  readonly policyConfig: GitPolicyConfig;
  readonly defaultWorkingDirectory: string;
  private readonly checkpoints = new Map<string, KnownGoodCheckpoint>();

  constructor(
    gitPort: GitPort,
    optionsOrValidator?: GitCheckpointManagerOptions | GitPolicyValidator
  ) {
    if (!gitPort) {
      throw new Error('gitPort is required for GitCheckpointManager');
    }
    this.gitPort = gitPort;

    if (optionsOrValidator instanceof GitPolicyValidator) {
      this.policyValidator = optionsOrValidator;
      this.policyConfig = DEFAULT_GIT_POLICY_CONFIG;
      this.defaultWorkingDirectory = process.cwd();
    } else {
      this.policyValidator =
        optionsOrValidator?.policyValidator ??
        new GitPolicyValidator(optionsOrValidator?.policyConfig);
      this.policyConfig = Object.freeze({
        ...DEFAULT_GIT_POLICY_CONFIG,
        ...optionsOrValidator?.policyConfig,
        prohibit_force_push: true,
      });
      this.defaultWorkingDirectory =
        optionsOrValidator?.defaultWorkingDirectory ?? process.cwd();
    }
  }

  /**
   * Creates a verified known-good Git checkpoint.
   *
   * Architectural flow:
   * 1. Validate request preconditions (task_id, purpose, valid SHA format, non-critical policy)
   * 2. Observe repository state via GitPort.inspectState
   * 3. Verify clean worktree, valid HEAD, valid branch, non-detached HEAD, parent consistency
   * 4. Perform remote verification if requested
   * 5. Construct checkpoint intent and deterministic checkpoint ID
   * 6. Authorize intent via GitPolicyValidator
   * 7. Execute authorized operation via GitPort
   * 8. Verify checkpoint integrity
   * 9. Record and return known-good checkpoint
   */
  async createCheckpoint(options: CreateCheckpointOptions): Promise<KnownGoodCheckpoint> {
    // 1. Precondition checks on input options
    const taskId = options.task_id ?? options.taskId;
    if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new GitCheckpointIntegrityError(
        'Checkpoint task_id is required and must be a non-empty string',
        { violations: [{ code: 'MISSING_TASK_ID', message: 'task_id is required' }] }
      );
    }

    const purpose = options.purpose;
    if (!purpose || typeof purpose !== 'string' || purpose.trim().length === 0) {
      throw new GitCheckpointIntegrityError(
        'Checkpoint purpose is required and must be a non-empty string',
        { taskId, violations: [{ code: 'MISSING_PURPOSE', message: 'purpose is required' }] }
      );
    }

    const expectedParentSha =
      options.expected_parent_sha !== undefined
        ? options.expected_parent_sha
        : options.expectedParentSha;

    if (
      expectedParentSha !== undefined &&
      expectedParentSha !== null &&
      !isValidCommitSha(expectedParentSha)
    ) {
      throw new GitCheckpointIntegrityError(
        `expected_parent_sha must be a valid 40-char SHA-1 or 64-char SHA-256 hex string or null, received: ${String(expectedParentSha)}`,
        {
          taskId,
          parentSha: String(expectedParentSha),
          violations: [
            {
              code: 'INVALID_PARENT_SHA',
              message: 'Invalid parent commit SHA format',
              field: 'expected_parent_sha',
            },
          ],
        }
      );
    }

    const requestedPolicyLevel =
      options.policy_level ?? options.policyLevel ?? RiskLevel.CAUTION;
    if (!isRiskLevel(requestedPolicyLevel)) {
      throw new GitPolicyError(
        `Invalid policy_level requested: ${String(requestedPolicyLevel)}`,
        'ERR_GIT_POLICY_VIOLATION',
        { riskLevel: requestedPolicyLevel as RiskLevel }
      );
    }
    if (requestedPolicyLevel === RiskLevel.CRITICAL) {
      throw new GitForcePushProhibitedError(
        'CRITICAL policy level is prohibited for checkpoint creation',
        { operation: GitOperationType.CHECKPOINT_CREATION, riskLevel: requestedPolicyLevel }
      );
    }

    const workingDir =
      options.working_directory ?? options.workingDirectory ?? this.defaultWorkingDirectory;

    // 2. Observe repository state via GitPort
    const observedState = await this.gitPort.inspectState(workingDir);
    if (!observedState || observedState.isRepository === false) {
      throw new GitPolicyError(
        'Repository state cannot be observed or target is not a valid Git repository',
        'ERR_GIT_INVALID_STATE',
        { operation: GitOperationType.CHECKPOINT_CREATION }
      );
    }

    // Verify HEAD exists and is valid
    const headSha = observedState.head_sha ?? observedState.currentHead;
    if (!headSha || !isValidCommitSha(headSha)) {
      throw new GitCheckpointIntegrityError(
        `Repository HEAD does not exist or is not a valid commit SHA, received: ${String(headSha)}`,
        {
          taskId,
          commitSha: String(headSha),
          violations: [
            {
              code: GitPolicyViolationCode.MISSING_COMMIT,
              message: 'Repository HEAD commit SHA is missing or invalid',
              field: 'head_sha',
            },
          ],
        }
      );
    }

    // Verify not detached HEAD
    if (
      observedState.is_detached_head ||
      observedState.isDetached ||
      observedState.status === GitStatus.DETACHED ||
      !observedState.current_branch
    ) {
      throw new GitDetachedHeadError('Cannot create checkpoint in detached HEAD state', {
        operation: GitOperationType.CHECKPOINT_CREATION,
        currentBranch: observedState.current_branch,
        violations: [
          {
            code: GitPolicyViolationCode.DETACHED_HEAD_PROHIBITED,
            message: 'Detached HEAD is prohibited for checkpoint creation',
            field: 'is_detached_head',
          },
        ],
      });
    }

    // Verify branch
    const currentBranch = observedState.current_branch;
    const expectedBranch = options.expected_branch ?? options.expectedBranch;
    if (expectedBranch && currentBranch !== expectedBranch) {
      throw new GitBranchMismatchError(
        `Current repository branch '${currentBranch}' does not match expected branch '${expectedBranch}'`,
        {
          operation: GitOperationType.CHECKPOINT_CREATION,
          currentBranch,
          configuredBranch: expectedBranch,
          violations: [
            {
              code: GitPolicyViolationCode.BRANCH_MISMATCH,
              message: `Branch mismatch: current branch is '${currentBranch}', expected '${expectedBranch}'`,
              field: 'branch',
            },
          ],
        }
      );
    }

    if (
      this.policyConfig.configured_branch &&
      currentBranch !== this.policyConfig.configured_branch
    ) {
      throw new GitBranchMismatchError(
        `Current repository branch '${currentBranch}' does not match configured policy branch '${this.policyConfig.configured_branch}'`,
        {
          operation: GitOperationType.CHECKPOINT_CREATION,
          currentBranch,
          configuredBranch: this.policyConfig.configured_branch,
          violations: [
            {
              code: GitPolicyViolationCode.BRANCH_MISMATCH,
              message: `Branch mismatch: current branch is '${currentBranch}', expected '${this.policyConfig.configured_branch}'`,
              field: 'current_branch',
            },
          ],
        }
      );
    }

    // Verify remote if target_remote is specified
    const targetRemote =
      options.target_remote ??
      options.targetRemote ??
      this.policyConfig.configured_remote ??
      'origin';
    if (
      this.policyConfig.configured_remote &&
      targetRemote !== this.policyConfig.configured_remote
    ) {
      throw new GitRemoteMismatchError(
        `Target remote '${targetRemote}' does not match configured policy remote '${this.policyConfig.configured_remote}'`,
        {
          operation: GitOperationType.CHECKPOINT_CREATION,
          configuredRemote: this.policyConfig.configured_remote,
          violations: [
            {
              code: GitPolicyViolationCode.REMOTE_MISMATCH,
              message: `Remote mismatch: target remote is '${targetRemote}', expected '${this.policyConfig.configured_remote}'`,
              field: 'target_remote',
            },
          ],
        }
      );
    }

    // Verify clean working tree (unstaged, staged, untracked)
    const hasUnstaged =
      observedState.unstaged_changes.length > 0 ||
      (observedState.unstagedFiles && observedState.unstagedFiles.length > 0);
    const hasStaged =
      observedState.staged_changes.length > 0 ||
      (observedState.stagedFiles && observedState.stagedFiles.length > 0);
    const hasUntracked =
      observedState.untracked_files.length > 0 ||
      (observedState.untrackedFiles && observedState.untrackedFiles.length > 0);
    const isClean =
      observedState.working_tree_clean &&
      observedState.status !== GitStatus.DIRTY &&
      !hasUnstaged &&
      !hasStaged &&
      !hasUntracked;

    if (!isClean) {
      let dirtyReason = 'working tree is dirty';
      if (hasUnstaged) dirtyReason = 'uncommitted unstaged changes detected';
      else if (hasStaged) dirtyReason = 'staged changes detected';
      else if (hasUntracked) dirtyReason = 'untracked files detected';

      throw new GitDirtyWorktreeError(`Cannot create checkpoint: ${dirtyReason}`, {
        operation: GitOperationType.CHECKPOINT_CREATION,
        violations: [
          {
            code: GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED,
            message: `Working tree is not clean: ${dirtyReason}`,
            field: 'working_tree_clean',
            details: {
              staged: observedState.staged_changes.length,
              unstaged: observedState.unstaged_changes.length,
              untracked: observedState.untracked_files.length,
            },
          },
        ],
      });
    }

    // Verify parent SHA consistency against observed state
    if (expectedParentSha !== undefined) {
      if (
        observedState.parent_sha !== undefined &&
        observedState.parent_sha !== null &&
        expectedParentSha !== observedState.parent_sha
      ) {
        throw new GitParentMismatchError(
          `Checkpoint expected_parent_sha '${expectedParentSha}' does not match observed repository parent SHA '${observedState.parent_sha}'`,
          {
            operation: GitOperationType.CHECKPOINT_CREATION,
            parentSha: expectedParentSha,
            violations: [
              {
                code: GitPolicyViolationCode.WRONG_PARENT_SHA,
                message: `Parent mismatch: expected '${expectedParentSha}', observed '${observedState.parent_sha}'`,
                field: 'parent_sha',
              },
            ],
          }
        );
      }
    }

    // 3. Remote verification if requested
    const shouldVerifyRemote = Boolean(options.verify_remote ?? options.verifyRemote);
    let remoteVerified = false;

    if (shouldVerifyRemote) {
      const remoteVerification = await this.gitPort.verifyRemote(
        workingDir,
        targetRemote,
        currentBranch,
        headSha
      );

      if (!remoteVerification.verified || remoteVerification.remoteHeadSha !== headSha) {
        throw new GitRemoteVerificationError(
          `Remote verification failed: commit '${headSha}' not verified on remote '${targetRemote}/${currentBranch}' (${remoteVerification.error ?? 'mismatch'})`,
          {
            operation: GitOperationType.CHECKPOINT_CREATION,
            commitSha: headSha,
            configuredRemote: targetRemote,
            configuredBranch: currentBranch,
            violations: [
              {
                code: GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED,
                message:
                  remoteVerification.error ??
                  `Remote HEAD does not match '${headSha}'`,
                field: 'remote_verified',
                details: {
                  expectedSha: headSha,
                  remoteHeadSha: remoteVerification.remoteHeadSha,
                },
              },
            ],
          }
        );
      }
      remoteVerified = true;
    }

    // 4. Deterministic Checkpoint ID
    const rawId = options.checkpoint_id ?? options.checkpointId;
    const checkpointId =
      typeof rawId === 'string' && rawId.trim().length > 0
        ? rawId.trim()
        : generateDeterministicCheckpointId(taskId, purpose, headSha, options.metadata);

    // 5. Construct intent & invoke Policy Validator
    const intent: GitOperationIntent = Object.freeze({
      operation: GitOperationType.CHECKPOINT_CREATION,
      checkpoint_id: checkpointId,
      task_id: taskId,
      phase: options.phase ?? 'PHASE_6',
      purpose,
      target_branch: currentBranch,
      target_remote: targetRemote,
      expected_commit_sha: headSha,
      expected_parent_sha: expectedParentSha ?? observedState.parent_sha ?? null,
      force: false,
      metadata: options.metadata ? Object.freeze({ ...options.metadata }) : undefined,
    });

    const policyDecision = this.policyValidator.validateOperation(
      intent,
      observedState,
      this.policyConfig
    );

    if (!policyDecision.allowed) {
      throw new GitPolicyError(
        `Checkpoint creation not authorized by policy: ${policyDecision.reasons.join('; ')}`,
        'ERR_GIT_OPERATION_NOT_AUTHORIZED',
        {
          operation: intent.operation,
          riskLevel: policyDecision.risk_level,
          violations: policyDecision.violations,
        }
      );
    }

    // 6. Execute authorized operation via GitPort
    const executionResult = await this.gitPort.executeAuthorizedOperation(
      intent,
      policyDecision,
      workingDir
    );

    if (!executionResult.success) {
      throw new GitPolicyError(
        `GitPort execution failed for checkpoint creation: ${executionResult.error ?? 'unknown execution error'}`,
        'ERR_GIT_OPERATION_NOT_AUTHORIZED',
        {
          operation: intent.operation,
          riskLevel: policyDecision.risk_level,
        }
      );
    }

    // 7. Checkpoint construction & verification
    const rawCp =
      executionResult.checkpoint ??
      createGitCheckpoint({
        checkpoint_id: checkpointId,
        task_id: taskId,
        phase: intent.phase ?? 'PHASE_6',
        purpose,
        commit_sha: headSha,
        parent_sha: expectedParentSha ?? observedState.parent_sha ?? null,
        branch: currentBranch,
        remote: targetRemote,
        working_tree_clean: true,
        remote_verified: remoteVerified,
        policy_level: policyDecision.risk_level,
        metadata: options.metadata,
      });

    // Re-wrap checkpoint to ensure remote_verified truthfully reflects verified state
    const verifiedCheckpoint: GitCheckpoint = createGitCheckpoint({
      checkpoint_id: rawCp.checkpoint_id,
      task_id: rawCp.task_id,
      phase: rawCp.phase,
      purpose: rawCp.purpose,
      commit_sha: rawCp.commit_sha,
      parent_sha: rawCp.parent_sha,
      branch: rawCp.branch,
      remote: rawCp.remote,
      created_at: rawCp.created_at,
      working_tree_clean: rawCp.working_tree_clean,
      remote_verified: remoteVerified,
      policy_level: rawCp.policy_level,
      metadata: options.metadata ?? rawCp.metadata,
    });

    // Verify parent integrity of created checkpoint
    if (
      expectedParentSha !== undefined &&
      verifiedCheckpoint.parent_sha !== expectedParentSha
    ) {
      throw new GitParentMismatchError(
        `Created checkpoint parent SHA '${verifiedCheckpoint.parent_sha}' does not match expected parent SHA '${expectedParentSha}'`,
        {
          checkpointId: verifiedCheckpoint.checkpoint_id,
          commitSha: verifiedCheckpoint.commit_sha,
          parentSha: verifiedCheckpoint.parent_sha,
          violations: [
            {
              code: GitPolicyViolationCode.WRONG_PARENT_SHA,
              message: `Parent mismatch: checkpoint parent is '${verifiedCheckpoint.parent_sha}', expected '${expectedParentSha}'`,
              field: 'parent_sha',
            },
          ],
        }
      );
    }

    // Full checkpoint integrity validation
    const verification = this.validateCheckpoint(verifiedCheckpoint, observedState, {
      expected_commit_sha: headSha,
      expected_parent_sha: expectedParentSha,
      expected_branch: currentBranch,
      expected_remote: targetRemote,
      require_clean_worktree: true,
      require_remote_verified: shouldVerifyRemote,
    });

    if (!verification.valid) {
      this.throwIntegrityErrorFromViolations(
        verification.violations,
        `Checkpoint verification failed: ${verification.errors.join('; ')}`,
        {
          checkpointId: verifiedCheckpoint.checkpoint_id,
          commitSha: verifiedCheckpoint.commit_sha,
          parentSha: verifiedCheckpoint.parent_sha,
        }
      );
    }

    // 8. Known-good checkpoint assembly and storage
    const verifiedAt = new Date().toISOString();
    const knownGood: KnownGoodCheckpoint = Object.freeze({
      ...verifiedCheckpoint,
      is_known_good: true,
      verified_at: verifiedAt,
      observed_state: observedState,
      policy_decision: policyDecision,
      execution_result: executionResult,
      checkpoint: verifiedCheckpoint,

      // Aliases
      isKnownGood: true,
      verifiedAt,
      observedState,
      policyDecision,
      executionResult,
    });

    this.checkpoints.set(knownGood.checkpoint_id, knownGood);
    return knownGood;
  }

  /**
   * Deterministically validates a checkpoint against repository state and expectations without mutation.
   */
  validateCheckpoint(
    checkpoint: GitCheckpoint,
    currentState: GitState,
    options?: CheckpointIntegrityOptions
  ): CheckpointVerificationResult {
    const errors: string[] = [];
    const violations: GitPolicyViolation[] = [];

    // 1. Schema check
    const schemaResult = validateGitCheckpointSchema(checkpoint);
    if (!schemaResult.valid) {
      for (const err of schemaResult.errors) {
        errors.push(err);
        violations.push({
          code: GitPolicyViolationCode.MISSING_COMMIT,
          message: err,
        });
      }
    }

    // 2. Delegate to policyValidator.validateCheckpointIntegrity
    const policyResult = this.policyValidator.validateCheckpointIntegrity(
      checkpoint,
      currentState,
      options
    );

    if (!policyResult.allowed) {
      for (const v of policyResult.violations) {
        violations.push(v);
        errors.push(v.message);
      }
    }

    // 3. Additional domain invariants
    if (
      !checkpoint.task_id ||
      typeof checkpoint.task_id !== 'string' ||
      checkpoint.task_id.trim().length === 0
    ) {
      errors.push('Checkpoint task_id is required');
      violations.push({
        code: 'MISSING_TASK_ID',
        message: 'Checkpoint task_id is required and must be non-empty',
        field: 'task_id',
      });
    }

    if (
      !checkpoint.purpose ||
      typeof checkpoint.purpose !== 'string' ||
      checkpoint.purpose.trim().length === 0
    ) {
      errors.push('Checkpoint purpose is required');
      violations.push({
        code: 'MISSING_PURPOSE',
        message: 'Checkpoint purpose is required and must be non-empty',
        field: 'purpose',
      });
    }

    // Check parent SHA format if present
    if (
      checkpoint.parent_sha !== null &&
      checkpoint.parent_sha !== undefined &&
      !isValidCommitSha(checkpoint.parent_sha)
    ) {
      errors.push(`Checkpoint parent_sha '${checkpoint.parent_sha}' is invalid`);
      violations.push({
        code: 'INVALID_PARENT_SHA',
        message: `Checkpoint parent_sha '${checkpoint.parent_sha}' is invalid`,
        field: 'parent_sha',
      });
    }

    // Check parent against currentState if currentState has parent_sha and expected_parent_sha was omitted
    if (
      options?.expected_parent_sha === undefined &&
      currentState?.parent_sha !== undefined &&
      currentState.parent_sha !== null &&
      checkpoint.parent_sha !== currentState.parent_sha
    ) {
      errors.push(
        `Checkpoint parent SHA '${checkpoint.parent_sha}' does not match repository parent SHA '${currentState.parent_sha}'`
      );
      violations.push({
        code: GitPolicyViolationCode.WRONG_PARENT_SHA,
        message: `Parent mismatch: checkpoint parent is '${checkpoint.parent_sha}', repo parent is '${currentState.parent_sha}'`,
        field: 'parent_sha',
      });
    }

    const valid = violations.length === 0;
    const verifiedAt = new Date().toISOString();

    return Object.freeze({
      valid,
      is_known_good: valid,
      checkpoint_id: checkpoint.checkpoint_id,
      commit_sha: checkpoint.commit_sha,
      branch: checkpoint.branch,
      verified_at: verifiedAt,
      policy_decision: policyResult,
      errors: Object.freeze(errors),
      violations: Object.freeze(violations),
      remote_verified: checkpoint.remote_verified,
      state: currentState,

      // Aliases
      checkpointId: checkpoint.checkpoint_id,
      commitSha: checkpoint.commit_sha,
      isKnownGood: valid,
    });
  }

  /**
   * Verifies an existing checkpoint or looked-up checkpoint ID against live or provided repository state.
   */
  async verifyCheckpoint(
    checkpointOrId: GitCheckpoint | string,
    options?: VerifyCheckpointOptions
  ): Promise<CheckpointVerificationResult> {
    let checkpoint: GitCheckpoint;

    if (typeof checkpointOrId === 'string') {
      const found = this.checkpoints.get(checkpointOrId);
      if (!found) {
        const notFoundResult: CheckpointVerificationResult = Object.freeze({
          valid: false,
          is_known_good: false,
          checkpoint_id: checkpointOrId,
          commit_sha: '',
          branch: '',
          verified_at: new Date().toISOString(),
          errors: Object.freeze([
            `Checkpoint with ID '${checkpointOrId}' not found in manager`,
          ]),
          violations: Object.freeze([
            {
              code: 'CHECKPOINT_NOT_FOUND',
              message: `Checkpoint '${checkpointOrId}' not found in manager`,
            },
          ]),
          remote_verified: false,
        });

        if (options?.throwOnError) {
          throw new GitCheckpointIntegrityError(
            `Checkpoint with ID '${checkpointOrId}' not found in manager`,
            { checkpointId: checkpointOrId }
          );
        }
        return notFoundResult;
      }
      checkpoint = found;
    } else {
      checkpoint = checkpointOrId;
    }

    const workingDir =
      options?.working_directory ??
      options?.workingDirectory ??
      this.defaultWorkingDirectory;

    const currentState =
      options?.currentState ?? (await this.gitPort.inspectState(workingDir));

    const shouldVerifyRemote = Boolean(
      options?.require_remote_verified ??
        options?.requireRemoteVerified ??
        checkpoint.remote_verified
    );

    const extraViolations: GitPolicyViolation[] = [];
    const extraErrors: string[] = [];

    if (shouldVerifyRemote) {
      const remote =
        options?.expected_remote ??
        options?.expectedRemote ??
        checkpoint.remote ??
        'origin';
      const remoteResult = await this.gitPort.verifyRemote(
        workingDir,
        remote,
        checkpoint.branch,
        checkpoint.commit_sha
      );

      if (!remoteResult.verified || remoteResult.remoteHeadSha !== checkpoint.commit_sha) {
        const msg =
          remoteResult.error ??
          `Remote commit verification failed for '${checkpoint.commit_sha}' on '${remote}/${checkpoint.branch}'`;
        extraErrors.push(msg);
        extraViolations.push({
          code: GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED,
          message: msg,
          field: 'remote_verified',
        });
      }
    }

    const baseResult = this.validateCheckpoint(checkpoint, currentState, {
      expected_parent_sha:
        options?.expected_parent_sha ?? options?.expectedParentSha,
      expected_branch: options?.expected_branch ?? options?.expectedBranch,
      expected_remote: options?.expected_remote ?? options?.expectedRemote,
      require_clean_worktree:
        options?.require_clean_worktree ??
        options?.requireCleanWorktree ??
        true,
      require_remote_verified: shouldVerifyRemote,
      expected_commit_sha:
        options?.expected_commit_sha ?? options?.expectedCommitSha,
    });

    const allErrors = Object.freeze([...baseResult.errors, ...extraErrors]);
    const allViolations = Object.freeze([
      ...baseResult.violations,
      ...extraViolations,
    ]);
    const valid = allViolations.length === 0;

    const finalResult: CheckpointVerificationResult = Object.freeze({
      valid,
      is_known_good: valid,
      checkpoint_id: checkpoint.checkpoint_id,
      commit_sha: checkpoint.commit_sha,
      branch: checkpoint.branch,
      verified_at: new Date().toISOString(),
      policy_decision: baseResult.policy_decision,
      errors: allErrors,
      violations: allViolations,
      remote_verified: shouldVerifyRemote
        ? valid && checkpoint.remote_verified
        : checkpoint.remote_verified,
      state: currentState,

      // Aliases
      checkpointId: checkpoint.checkpoint_id,
      commitSha: checkpoint.commit_sha,
      isKnownGood: valid,
    });

    if (!valid && options?.throwOnError) {
      this.throwIntegrityErrorFromViolations(
        allViolations,
        `Checkpoint verification failed: ${allErrors.join('; ')}`,
        {
          checkpointId: checkpoint.checkpoint_id,
          commitSha: checkpoint.commit_sha,
          parentSha: checkpoint.parent_sha,
          configuredBranch: checkpoint.branch,
          currentBranch: currentState?.current_branch,
        }
      );
    }

    return finalResult;
  }

  /**
   * Retrieves a verified checkpoint by ID from the manager's memory store.
   */
  getCheckpoint(checkpointId: string): KnownGoodCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * Lists checkpoints filtered by task, branch, or purpose.
   */
  listCheckpoints(filter?: CheckpointFilter): readonly KnownGoodCheckpoint[] {
    let list = Array.from(this.checkpoints.values());

    if (filter?.taskId) {
      list = list.filter(
        (cp) => cp.task_id === filter.taskId || cp.taskId === filter.taskId
      );
    }
    if (filter?.branch) {
      list = list.filter((cp) => cp.branch === filter.branch);
    }
    if (filter?.purpose) {
      list = list.filter((cp) => cp.purpose === filter.purpose);
    }
    if (filter?.onlyKnownGood !== undefined && filter.onlyKnownGood) {
      list = list.filter((cp) => cp.is_known_good);
    }

    return Object.freeze(list);
  }

  /**
   * Clears the in-memory checkpoint store.
   */
  clearCheckpoints(): void {
    this.checkpoints.clear();
  }

  /**
   * Obtains a GitRollbackManager instance bound to this checkpoint manager and its configured policy.
   */
  getRollbackManager(): GitRollbackManager {
    return new GitRollbackManager(this.gitPort, {
      policyValidator: this.policyValidator,
      policyConfig: this.policyConfig,
      defaultWorkingDirectory: this.defaultWorkingDirectory,
      checkpointManager: this,
    });
  }

  /**
   * Performs an atomic recovery rollback to an exact known-good checkpoint.
   * Enforces DANGEROUS policy classification and requires verified human authorization token.
   * Guarantees safe local restoration with full post-rollback verification and remote safety.
   */
  async rollbackToCheckpoint(
    checkpointOrIdOrOptions: GitCheckpoint | string | RollbackOptions,
    options?: RollbackOptions
  ): Promise<GitRollbackResult> {
    const rollbackManager = this.getRollbackManager();
    return rollbackManager.rollbackToCheckpoint(checkpointOrIdOrOptions, options);
  }

  /**
   * Maps violations to structured domain error subclasses.
   */
  private throwIntegrityErrorFromViolations(
    violations: readonly GitPolicyViolation[],
    fallbackMessage: string,
    details?: GitPolicyErrorDetails
  ): never {
    const primary = violations[0];
    const code = primary?.code;
    const msg = primary?.message ?? fallbackMessage;
    const errorDetails: GitPolicyErrorDetails = {
      ...details,
      violations: violations.map((v) => ({
        code: String(v.code),
        message: v.message,
        field: v.field,
        details: v.details,
      })),
    };

    switch (code) {
      case GitPolicyViolationCode.DIRTY_WORKTREE_PROHIBITED:
        throw new GitDirtyWorktreeError(msg, errorDetails);
      case GitPolicyViolationCode.DETACHED_HEAD_PROHIBITED:
        throw new GitDetachedHeadError(msg, errorDetails);
      case GitPolicyViolationCode.BRANCH_MISMATCH:
        throw new GitBranchMismatchError(msg, errorDetails);
      case GitPolicyViolationCode.REMOTE_MISMATCH:
        throw new GitRemoteMismatchError(msg, errorDetails);
      case GitPolicyViolationCode.REMOTE_VERIFICATION_FAILED:
        throw new GitRemoteVerificationError(msg, errorDetails);
      case GitPolicyViolationCode.WRONG_PARENT_SHA:
        throw new GitParentMismatchError(msg, errorDetails);
      case GitPolicyViolationCode.FORCE_PUSH_PROHIBITED:
        throw new GitForcePushProhibitedError(msg, errorDetails);
      default:
        throw new GitCheckpointIntegrityError(msg, errorDetails);
    }
  }
}
