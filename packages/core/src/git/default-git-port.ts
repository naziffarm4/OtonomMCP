import * as child_process from 'node:child_process';
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
  GitRemoteSyncStatus,
  createGitState,
} from './git-types.js';
import {
  GitPolicyError,
  GitForcePushProhibitedError,
} from '../errors/git-policy-error.js';
import { createGitCheckpoint, isValidCommitSha } from './git-checkpoint-factory.js';

export interface DefaultGitPortOptions {
  timeoutMs?: number;
}

/**
 * Production provider-neutral GitPort using child_process.execFile.
 * Separates policy validation from command execution.
 *
 * Strict Security Rules:
 * 1. Requires valid policy authorization before executing mutating commands.
 * 2. Unconditionally forbids force push (--force, --force-with-lease, -f).
 * 3. Never passes shell strings; uses strict argument arrays to prevent injection.
 */
export class DefaultGitPort implements GitPort {
  private readonly timeoutMs: number;

  constructor(options?: DefaultGitPortOptions) {
    this.timeoutMs = options?.timeoutMs ?? 15_000;
  }

  async inspectState(workingDirectory: string): Promise<GitState> {
    const isRepo = await this.checkIsRepository(workingDirectory);
    if (!isRepo) {
      return createGitState({
        isRepository: false,
        head_sha: null,
        current_branch: null,
        remote_head_sha: null,
        working_tree_clean: true,
        staged_changes: [],
        unstaged_changes: [],
        untracked_files: [],
        is_detached_head: false,
      });
    }

    const head_sha = await this.getHeadSha(workingDirectory);
    const { branch: current_branch, isDetached: is_detached_head } = await this.getCurrentBranch(workingDirectory);
    const { staged, unstaged, untracked } = await this.getStatusPorcelain(workingDirectory);
    const { ahead, behind, remoteHeadSha, syncState } = await this.getRemoteSyncInfo(workingDirectory, current_branch, head_sha);

    return createGitState({
      isRepository: true,
      head_sha,
      current_branch,
      remote_head_sha: remoteHeadSha,
      working_tree_clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      staged_changes: staged,
      unstaged_changes: unstaged,
      untracked_files: untracked,
      divergence: {
        ahead,
        behind,
        diverged: ahead > 0 && behind > 0,
      },
      is_detached_head,
      remote_sync_state: syncState,
    });
  }

  async verifyRemote(
    workingDirectory: string,
    remote: string,
    branch: string,
    expectedCommitSha?: string
  ): Promise<RemoteVerificationResult> {
    try {
      const output = await this.execGit(['ls-remote', '--heads', remote, branch], workingDirectory);
      const trimmed = output.trim();
      if (!trimmed) {
        return {
          verified: false,
          remoteHeadSha: null,
          error: `Remote '${remote}' branch '${branch}' not found`,
        };
      }

      const match = trimmed.match(/^([0-9a-fA-F]{40,64})\s+/);
      const remoteHeadSha = match ? match[1] : null;

      if (!remoteHeadSha) {
        return {
          verified: false,
          remoteHeadSha: null,
          error: `Could not parse remote HEAD SHA from '${trimmed}'`,
        };
      }

      if (expectedCommitSha && remoteHeadSha !== expectedCommitSha) {
        return {
          verified: false,
          remoteHeadSha,
          error: `Remote HEAD SHA '${remoteHeadSha}' does not match expected commit '${expectedCommitSha}'`,
        };
      }

      return {
        verified: true,
        remoteHeadSha,
      };
    } catch (err) {
      return {
        verified: false,
        remoteHeadSha: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async executeAuthorizedOperation(
    intent: GitOperationIntent,
    authorization: GitPolicyDecision,
    workingDirectory: string
  ): Promise<GitExecutionResult> {
    // 1. Force push prohibition: unconditional guard
    if (
      intent.force === true ||
      intent.operation === GitOperationType.FORCE_PUSH ||
      intent.operation === GitOperationType.DESTRUCTIVE_REMOTE_REWRITE ||
      intent.operation === GitOperationType.DESTROY_PROJECT_HISTORY
    ) {
      throw new GitForcePushProhibitedError(
        'Force push is prohibited by policy and cannot be executed',
        {
          operation: intent.operation,
          riskLevel: authorization.risk_level,
        }
      );
    }

    // 2. Authorization check
    if (!authorization.allowed) {
      throw new GitPolicyError(
        `Cannot execute unauthorized Git operation '${intent.operation}'`,
        'ERR_GIT_OPERATION_NOT_AUTHORIZED',
        {
          operation: intent.operation,
          riskLevel: authorization.risk_level,
          violations: authorization.violations,
        }
      );
    }

    const executedAt = new Date().toISOString();

    switch (intent.operation) {
      case GitOperationType.STATUS_INSPECTION: {
        const stdout = await this.execGit(['status', '--porcelain=v1', '-uall'], workingDirectory);
        const stateAfter = await this.inspectState(workingDirectory);
        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          stdout,
          state_after: stateAfter,
          executed_at: executedAt,
        };
      }

      case GitOperationType.DIFF_INSPECTION: {
        const stdout = await this.execGit(['diff'], workingDirectory);
        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          stdout,
          executed_at: executedAt,
        };
      }

      case GitOperationType.LOG_INSPECTION: {
        const stdout = await this.execGit(['log', '-n', '10', '--oneline'], workingDirectory);
        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          stdout,
          executed_at: executedAt,
        };
      }

      case GitOperationType.COMMIT: {
        const message = intent.commit_message ?? 'aidm: automated checkpoint commit';
        const stdout = await this.execGit(['commit', '-m', message], workingDirectory);
        const headSha = await this.getHeadSha(workingDirectory);
        const stateAfter = await this.inspectState(workingDirectory);
        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          commit_sha: headSha,
          state_after: stateAfter,
          stdout,
          executed_at: executedAt,
        };
      }

      case GitOperationType.PUSH: {
        const remote = intent.target_remote ?? 'origin';
        const branch = intent.target_branch ?? (await this.getCurrentBranch(workingDirectory)).branch ?? 'main';
        // Note: NEVER pass --force or --force-with-lease
        const stdout = await this.execGit(['push', remote, branch], workingDirectory);
        const stateAfter = await this.inspectState(workingDirectory);
        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          state_after: stateAfter,
          stdout,
          executed_at: executedAt,
        };
      }

      case GitOperationType.PRE_FLIGHT_CHECKPOINT:
      case GitOperationType.POST_FLIGHT_CHECKPOINT:
      case GitOperationType.CHECKPOINT_CREATION: {
        const headSha = await this.getHeadSha(workingDirectory);
        const { branch } = await this.getCurrentBranch(workingDirectory);
        const state = await this.inspectState(workingDirectory);

        const checkpoint = createGitCheckpoint({
          checkpoint_id: intent.checkpoint_id,
          task_id: intent.task_id,
          phase: intent.phase ?? 'PHASE_6',
          purpose: intent.purpose ?? intent.operation,
          commit_sha: headSha ?? '0000000000000000000000000000000000000000',
          parent_sha: intent.expected_parent_sha ?? null,
          branch: branch ?? 'main',
          remote: intent.target_remote ?? 'origin',
          working_tree_clean: state.working_tree_clean,
          remote_verified: false,
          policy_level: authorization.risk_level,
        });

        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          commit_sha: headSha,
          checkpoint,
          state_after: state,
          executed_at: executedAt,
        };
      }

      default: {
        // Safe placeholder for other operations in later Phase 6 tasks
        const stateAfter = await this.inspectState(workingDirectory);
        return {
          success: true,
          operation: intent.operation,
          policy_level: authorization.risk_level,
          state_after: stateAfter,
          executed_at: executedAt,
        };
      }
    }
  }

  private async checkIsRepository(workingDirectory: string): Promise<boolean> {
    try {
      const output = await this.execGit(['rev-parse', '--is-inside-work-tree'], workingDirectory);
      return output.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async getHeadSha(workingDirectory: string): Promise<string | null> {
    try {
      const output = await this.execGit(['rev-parse', 'HEAD'], workingDirectory);
      const trimmed = output.trim();
      return isValidCommitSha(trimmed) ? trimmed : null;
    } catch {
      return null;
    }
  }

  private async getCurrentBranch(workingDirectory: string): Promise<{ branch: string | null; isDetached: boolean }> {
    try {
      const output = await this.execGit(['symbolic-ref', '--short', 'HEAD'], workingDirectory);
      const branch = output.trim();
      return { branch: branch.length > 0 ? branch : null, isDetached: false };
    } catch {
      // Detached HEAD or unborn branch
      return { branch: null, isDetached: true };
    }
  }

  private async getStatusPorcelain(
    workingDirectory: string
  ): Promise<{ staged: string[]; unstaged: string[]; untracked: string[] }> {
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    try {
      const output = await this.execGit(['status', '--porcelain=v1', '-uall'], workingDirectory);
      const lines = output.split(/\r?\n/).filter((l) => l.length > 0);
      for (const line of lines) {
        const x = line[0];
        const y = line[1];
        const filePath = line.substring(3).trim();

        if (x === '?' && y === '?') {
          untracked.push(filePath);
        } else {
          if (x !== ' ' && x !== '?') {
            staged.push(filePath);
          }
          if (y !== ' ' && y !== '?') {
            unstaged.push(filePath);
          }
        }
      }
    } catch {
      // Repos with errors or empty
    }

    return {
      staged: staged.sort(),
      unstaged: unstaged.sort(),
      untracked: untracked.sort(),
    };
  }

  private async getRemoteSyncInfo(
    workingDirectory: string,
    currentBranch: string | null,
    headSha: string | null
  ): Promise<{ ahead: number; behind: number; remoteHeadSha: string | null; syncState: GitRemoteSyncStatus }> {
    if (!currentBranch || !headSha) {
      return { ahead: 0, behind: 0, remoteHeadSha: null, syncState: GitRemoteSyncStatus.DETACHED };
    }

    let remoteHeadSha: string | null = null;
    try {
      const revOutput = await this.execGit(['rev-parse', '@{u}'], workingDirectory);
      const trimmed = revOutput.trim();
      if (isValidCommitSha(trimmed)) {
        remoteHeadSha = trimmed;
      }
    } catch {
      // No upstream tracking branch configured
      return { ahead: 0, behind: 0, remoteHeadSha: null, syncState: GitRemoteSyncStatus.UNKNOWN };
    }

    let ahead = 0;
    let behind = 0;
    try {
      const countOutput = await this.execGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], workingDirectory);
      const parts = countOutput.trim().split(/\s+/);
      if (parts.length >= 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    } catch {
      // rev-list failed
    }

    let syncState: GitRemoteSyncStatus;
    if (ahead > 0 && behind > 0) {
      syncState = GitRemoteSyncStatus.DIVERGED;
    } else if (ahead > 0) {
      syncState = GitRemoteSyncStatus.AHEAD;
    } else if (behind > 0) {
      syncState = GitRemoteSyncStatus.BEHIND;
    } else {
      syncState = GitRemoteSyncStatus.UP_TO_DATE;
    }

    return { ahead, behind, remoteHeadSha, syncState };
  }

  private execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      child_process.execFile(
        'git',
        args,
        {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            return reject(error);
          }
          resolve(String(stdout ?? ''));
        }
      );
    });
  }
}
