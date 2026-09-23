import * as child_process from 'node:child_process';
import { GitObservationError } from '../errors/collector-error.js';
import { isValidGitReference } from './evidence-validator.js';

export interface GitObservationResult {
  readonly isRepository: boolean;
  readonly git_head_before: string | null;
  readonly git_head_after: string | null;
  readonly unified_diff: string | null;
}

/**
 * Read-only abstraction port for observing Git state without mutation.
 * Strictly avoids mutating commands (no commit, push, rollback, checkout, stash).
 */
export interface GitObserverPort {
  isGitRepository(workingDirectory: string): Promise<boolean>;
  observeHead(workingDirectory: string): Promise<string | null>;
  observeDiff(workingDirectory: string, baseHead?: string | null): Promise<string | null>;
  observeGit(workingDirectory: string, baseHead?: string | null): Promise<GitObservationResult>;
}

/**
 * Production read-only Git observer using child_process.execFile.
 * Never performs mutating operations. Explicitly returns null on Git absence or failure;
 * never fabricates fake Git SHAs or diffs.
 */
export class DefaultGitObserver implements GitObserverPort {
  private readonly timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  async isGitRepository(workingDirectory: string): Promise<boolean> {
    try {
      const output = await this.execGit(['rev-parse', '--is-inside-work-tree'], workingDirectory);
      return output.trim() === 'true';
    } catch {
      return false;
    }
  }

  async observeHead(workingDirectory: string): Promise<string | null> {
    const isRepo = await this.isGitRepository(workingDirectory);
    if (!isRepo) {
      return null;
    }

    try {
      const output = await this.execGit(['rev-parse', 'HEAD'], workingDirectory);
      const trimmed = output.trim();
      if (trimmed.length > 0 && isValidGitReference(trimmed)) {
        return trimmed;
      }
      return null;
    } catch {
      // Uninitialized repo or empty HEAD - explicit null, never fabricate
      return null;
    }
  }

  async observeDiff(workingDirectory: string, baseHead?: string | null): Promise<string | null> {
    const isRepo = await this.isGitRepository(workingDirectory);
    if (!isRepo) {
      return null;
    }

    try {
      const args: string[] = ['diff'];
      if (baseHead && isValidGitReference(baseHead)) {
        args.push(baseHead);
      } else {
        args.push('HEAD');
      }

      const output = await this.execGit(args, workingDirectory);
      const trimmed = output.trim();
      return trimmed.length > 0 ? output : null;
    } catch {
      // Fall back to plain git diff if HEAD diff failed (e.g. unborn branch)
      try {
        const output = await this.execGit(['diff'], workingDirectory);
        const trimmed = output.trim();
        return trimmed.length > 0 ? output : null;
      } catch {
        return null;
      }
    }
  }

  async observeGit(workingDirectory: string, baseHead?: string | null): Promise<GitObservationResult> {
    const isRepo = await this.isGitRepository(workingDirectory);
    if (!isRepo) {
      return Object.freeze({
        isRepository: false,
        git_head_before: baseHead ?? null,
        git_head_after: null,
        unified_diff: null,
      });
    }

    const currentHead = await this.observeHead(workingDirectory);
    const diff = await this.observeDiff(workingDirectory, baseHead);

    return Object.freeze({
      isRepository: true,
      git_head_before: baseHead ?? null,
      git_head_after: currentHead,
      unified_diff: diff,
    });
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

/**
 * Deterministic test fake Git observer.
 */
export class FakeGitObserver implements GitObserverPort {
  isRepo: boolean = true;
  headSequence: (string | null)[] = [];
  diffToReturn: string | null = null;
  shouldThrow: boolean = false;
  readonly calls: { method: string; workingDirectory: string; baseHead?: string | null }[] = [];

  constructor(options?: {
    isRepository?: boolean;
    currentHead?: string | null;
    unifiedDiff?: string | null;
  }) {
    if (options?.isRepository !== undefined) this.isRepo = options.isRepository;
    if (options?.currentHead !== undefined) this.headSequence = [options.currentHead];
    if (options?.unifiedDiff !== undefined) this.diffToReturn = options.unifiedDiff;
  }

  setHeadSequence(sequence: (string | null)[]): void {
    this.headSequence = [...sequence];
  }

  setDiff(diff: string | null): void {
    this.diffToReturn = diff;
  }

  async isGitRepository(workingDirectory: string): Promise<boolean> {
    this.calls.push({ method: 'isGitRepository', workingDirectory });
    if (this.shouldThrow) throw new GitObservationError('Fake Git failure');
    return this.isRepo;
  }

  async observeHead(workingDirectory: string): Promise<string | null> {
    this.calls.push({ method: 'observeHead', workingDirectory });
    if (this.shouldThrow) throw new GitObservationError('Fake Git failure');
    if (!this.isRepo) return null;
    return this.headSequence.length > 0 ? this.headSequence.shift()! : null;
  }

  async observeDiff(workingDirectory: string, baseHead?: string | null): Promise<string | null> {
    this.calls.push({ method: 'observeDiff', workingDirectory, baseHead });
    if (this.shouldThrow) throw new GitObservationError('Fake Git failure');
    if (!this.isRepo) return null;
    return this.diffToReturn;
  }

  async observeGit(workingDirectory: string, baseHead?: string | null): Promise<GitObservationResult> {
    this.calls.push({ method: 'observeGit', workingDirectory, baseHead });
    if (this.shouldThrow) throw new GitObservationError('Fake Git failure');
    if (!this.isRepo) {
      return Object.freeze({
        isRepository: false,
        git_head_before: baseHead ?? null,
        git_head_after: null,
        unified_diff: null,
      });
    }

    const currentHead = this.headSequence.length > 0 ? this.headSequence.shift()! : null;
    return Object.freeze({
      isRepository: true,
      git_head_before: baseHead ?? null,
      git_head_after: currentHead,
      unified_diff: this.diffToReturn,
    });
  }
}
