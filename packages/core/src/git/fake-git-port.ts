import {
  type GitPort,
  type RemoteVerificationResult,
} from './git-port.js';
import {
  type GitState,
  type GitOperationIntent,
  type GitPolicyDecision,
  type GitExecutionResult,
  GitOperationType,
  createGitState,
} from './git-types.js';
import {
  GitPolicyError,
  GitForcePushProhibitedError,
} from '../errors/git-policy-error.js';
import { createGitCheckpoint } from './git-checkpoint-factory.js';

export interface FakeGitPortOptions {
  initialState?: Partial<GitState>;
  remoteVerificationResult?: Partial<RemoteVerificationResult>;
}

/**
 * Deterministic in-memory fake GitPort implementation for testing.
 * Guarantees zero external network or process dependencies.
 * Enforces execution security rules:
 * - Reject unauthorized executions
 * - Reject force-push executions unconditionally
 */
export class FakeGitPort implements GitPort {
  currentState: GitState;
  remoteVerificationResult: RemoteVerificationResult;

  readonly inspectedPaths: string[] = [];
  readonly remoteVerifications: {
    workingDirectory: string;
    remote: string;
    branch: string;
    expectedCommitSha?: string;
  }[] = [];
  readonly executedOperations: {
    intent: GitOperationIntent;
    authorization: GitPolicyDecision;
    workingDirectory: string;
  }[] = [];

  constructor(options?: FakeGitPortOptions) {
    this.currentState = createGitState({
      head_sha: '0000000000000000000000000000000000000001',
      current_branch: 'main',
      remote_head_sha: '0000000000000000000000000000000000000001',
      working_tree_clean: true,
      staged_changes: [],
      unstaged_changes: [],
      untracked_files: [],
      is_detached_head: false,
      ...options?.initialState,
    });

    this.remoteVerificationResult = Object.freeze({
      verified: true,
      remoteHeadSha: '0000000000000000000000000000000000000001',
      ...options?.remoteVerificationResult,
    });
  }

  async inspectState(workingDirectory: string): Promise<GitState> {
    this.inspectedPaths.push(workingDirectory);
    return this.currentState;
  }

  async verifyRemote(
    workingDirectory: string,
    remote: string,
    branch: string,
    expectedCommitSha?: string
  ): Promise<RemoteVerificationResult> {
    this.remoteVerifications.push({
      workingDirectory,
      remote,
      branch,
      expectedCommitSha,
    });
    return this.remoteVerificationResult;
  }

  async executeAuthorizedOperation(
    intent: GitOperationIntent,
    authorization: GitPolicyDecision,
    workingDirectory: string
  ): Promise<GitExecutionResult> {
    // 1. Force push rejection: unconditionally prohibited even if authorization object is forged
    if (
      intent.force === true ||
      intent.operation === GitOperationType.FORCE_PUSH ||
      intent.operation === GitOperationType.DESTRUCTIVE_REMOTE_REWRITE ||
      intent.operation === GitOperationType.DESTROY_PROJECT_HISTORY
    ) {
      throw new GitForcePushProhibitedError(
        'FakeGitPort refused force push: force push execution path does not exist',
        {
          operation: intent.operation,
          riskLevel: authorization.risk_level,
        }
      );
    }

    // 2. Reject unauthorized operations
    if (!authorization.allowed) {
      throw new GitPolicyError(
        `FakeGitPort refused unauthorized operation '${intent.operation}'`,
        'ERR_GIT_OPERATION_NOT_AUTHORIZED',
        {
          operation: intent.operation,
          riskLevel: authorization.risk_level,
          violations: authorization.violations,
        }
      );
    }

    this.executedOperations.push({
      intent,
      authorization,
      workingDirectory,
    });

    let checkpoint = null;
    if (
      intent.operation === GitOperationType.PRE_FLIGHT_CHECKPOINT ||
      intent.operation === GitOperationType.POST_FLIGHT_CHECKPOINT ||
      intent.operation === GitOperationType.CHECKPOINT_CREATION
    ) {
      checkpoint = createGitCheckpoint({
        checkpoint_id: intent.checkpoint_id,
        task_id: intent.task_id,
        phase: intent.phase ?? 'PHASE_6',
        purpose: intent.purpose ?? intent.operation,
        commit_sha: intent.expected_commit_sha ?? this.currentState.head_sha ?? '0000000000000000000000000000000000000001',
        parent_sha: intent.expected_parent_sha ?? this.currentState.parent_sha ?? null,
        branch: intent.target_branch ?? this.currentState.current_branch ?? 'main',
        remote: intent.target_remote ?? 'origin',
        working_tree_clean: this.currentState.working_tree_clean,
        remote_verified: this.remoteVerificationResult.verified,
        policy_level: authorization.risk_level,
        metadata: intent.metadata,
      });
    }

    return Object.freeze({
      success: true,
      operation: intent.operation,
      policy_level: authorization.risk_level,
      commit_sha: intent.expected_commit_sha ?? this.currentState.head_sha,
      checkpoint,
      state_after: this.currentState,
      executed_at: new Date().toISOString(),
    });
  }
}
