import * as child_process from 'node:child_process';
import type { GitState } from './types.js';
import { RecoveryError } from '../errors/recovery-error.js';

/**
 * Read-only Git observer that inspects repository HEAD and working tree status.
 * Strictly non-destructive; never executes modifying Git commands.
 */
export class GitObserver {
  /**
   * Safely inspects the Git state of the given workspace directory.
   */
  async observeGitState(workspaceRoot: string): Promise<GitState> {
    const isRepo = await this.checkIsRepository(workspaceRoot);
    if (!isRepo) {
      return {
        isRepository: false,
        currentHead: null,
        isClean: true,
        stagedFiles: [],
        unstagedFiles: [],
        untrackedFiles: [],
      };
    }

    const currentHead = await this.getCurrentHead(workspaceRoot);
    const { stagedFiles, unstagedFiles, untrackedFiles } = await this.getStatusPorcelain(workspaceRoot);
    const isClean = stagedFiles.length === 0 && unstagedFiles.length === 0 && untrackedFiles.length === 0;

    return {
      isRepository: true,
      currentHead,
      isClean,
      stagedFiles,
      unstagedFiles,
      untrackedFiles,
    };
  }

  private async checkIsRepository(workspaceRoot: string): Promise<boolean> {
    try {
      const output = await this.execGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot);
      return output.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async getCurrentHead(workspaceRoot: string): Promise<string | null> {
    try {
      const output = await this.execGit(['rev-parse', 'HEAD'], workspaceRoot);
      const trimmed = output.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      // Empty repo or uninitialized HEAD
      return null;
    }
  }

  private async getStatusPorcelain(
    workspaceRoot: string
  ): Promise<{ stagedFiles: string[]; unstagedFiles: string[]; untrackedFiles: string[] }> {
    let output: string;
    try {
      output = await this.execGit(['status', '--porcelain=v1', '-uall'], workspaceRoot);
    } catch (err) {
      throw new RecoveryError(`Failed to inspect Git status in '${workspaceRoot}'`, {
        category: 'GIT_INSPECTION_FAILURE',
        path: workspaceRoot,
        cause: err,
      });
    }

    const stagedFiles: string[] = [];
    const unstagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    const lines = output.split(/\r?\n/).filter((l) => l.length > 0);
    for (const line of lines) {
      const x = line[0];
      const y = line[1];
      const filePath = line.substring(3).trim();

      if (x === '?' && y === '?') {
        untrackedFiles.push(filePath);
      } else {
        if (x !== ' ' && x !== '?') {
          stagedFiles.push(filePath);
        }
        if (y !== ' ' && y !== '?') {
          unstagedFiles.push(filePath);
        }
      }
    }

    return {
      stagedFiles: stagedFiles.sort(),
      unstagedFiles: unstagedFiles.sort(),
      untrackedFiles: untrackedFiles.sort(),
    };
  }

  private execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      child_process.execFile(
        'git',
        args,
        {
          cwd,
          timeout: 5000,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            return reject(error);
          }
          resolve(stdout);
        }
      );
    });
  }
}
