/**
 * Antigravity Process Spawning & Resolution Boundary (Phase 14 TASK-P14-01)
 *
 * Implements real OS process spawning and executable resolution for the
 * Antigravity CLI (`agy`) boundary, with full support for deterministic
 * in-memory testing without requiring a real Antigravity installation.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. NO ARBITRARY SHELL EXECUTION: Spawns the resolved Antigravity executable
 *    directly without shell interpolation (shell: false).
 * 2. PORT ABSTRACTION: Decouples OS process facilities from adapter logic
 *    via AntigravityProcessRunner port.
 * 3. PORTABLE RESOLUTION: Resolves `agy` via configured paths, environment
 *    variables, or system PATH across Windows and POSIX without hardcoded
 *    machine paths.
 * 4. LIFECYCLE MANAGEMENT: Handles stdin piping, stdout/stderr chunk capture,
 *    timeout termination, AbortSignal cancellation, and deterministic cleanup.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// 1. TYPES & CONTRACTS
// ============================================================================

export interface AntigravityProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly stdinInput?: string | null;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AntigravityProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError?: Error | null;
}

export interface AntigravityProcessRunner {
  run(options: AntigravityProcessOptions): Promise<AntigravityProcessResult>;
}

export interface AntigravityResolutionResult {
  readonly found: boolean;
  readonly executablePath: string | null;
  readonly searchSource: 'explicit' | 'env' | 'path' | 'none';
  readonly reason: string | null;
}

export interface AntigravityResolutionOptions {
  readonly configuredBinaryPath?: string | null;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

// ============================================================================
// 2. EXECUTABLE RESOLUTION
// ============================================================================

/**
 * Searches system PATH for a command binary, taking into account platform-specific
 * extensions (.exe, .cmd, .bat on Windows).
 */
export function findExecutableOnPath(
  commandName: string,
  pathEnv: string = process.env.PATH || '',
  isWindows: boolean = process.platform === 'win32'
): string | null {
  if (!commandName || !pathEnv) return null;

  const delimiter = isWindows ? ';' : ':';
  const directories = pathEnv.split(delimiter).filter(Boolean);

  const extensions = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  const hasExt = isWindows && extensions.some((ext) => commandName.toLowerCase().endsWith(ext.toLowerCase()));

  for (const dir of directories) {
    if (hasExt || !isWindows) {
      const fullPath = path.join(dir, commandName);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // Continue searching next directory
      }
    } else {
      for (const ext of extensions) {
        const fullPath = path.join(dir, `${commandName}${ext.toLowerCase()}`);
        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            return fullPath;
          }
        } catch {
          // Continue searching next extension
        }
        const fullPathUpper = path.join(dir, `${commandName}${ext.toUpperCase()}`);
        try {
          if (fs.existsSync(fullPathUpper) && fs.statSync(fullPathUpper).isFile()) {
            return fullPathUpper;
          }
        } catch {
          // Continue searching next extension
        }
      }
    }
  }

  return null;
}

/**
 * Resolves the Antigravity CLI executable without hardcoding machine-specific paths.
 * Search order:
 * 1. Explicit configuredBinaryPath (file path or command name)
 * 2. ANTIGRAVITY_BIN_PATH, AGY_BIN_PATH, or AGY_PATH environment variables
 * 3. Default `agy` command on system PATH
 */
export function resolveAntigravityExecutable(
  options: AntigravityResolutionOptions = {}
): AntigravityResolutionResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const isWindows = process.platform === 'win32';
  const pathEnv = env.PATH || '';

  // 1. Check explicit configuredBinaryPath
  if (options.configuredBinaryPath && options.configuredBinaryPath.trim().length > 0) {
    const rawPath = options.configuredBinaryPath.trim();
    const hasSeparator = rawPath.includes('/') || rawPath.includes('\\');

    if (hasSeparator) {
      const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
      if (fs.existsSync(resolved)) {
        return Object.freeze({
          found: true,
          executablePath: resolved,
          searchSource: 'explicit',
          reason: null,
        });
      }
      if (isWindows && !rawPath.toLowerCase().endsWith('.exe')) {
        const withExe = `${resolved}.exe`;
        if (fs.existsSync(withExe)) {
          return Object.freeze({
            found: true,
            executablePath: withExe,
            searchSource: 'explicit',
            reason: null,
          });
        }
      }
      return Object.freeze({
        found: false,
        executablePath: null,
        searchSource: 'explicit',
        reason: `Configured Antigravity binary not found at "${rawPath}"`,
      });
    }

    // Bare command name: look on PATH
    const onPath = findExecutableOnPath(rawPath, pathEnv, isWindows);
    if (onPath) {
      return Object.freeze({
        found: true,
        executablePath: onPath,
        searchSource: 'explicit',
        reason: null,
      });
    }
    return Object.freeze({
      found: false,
      executablePath: null,
      searchSource: 'explicit',
      reason: `Configured Antigravity command "${rawPath}" not found on PATH`,
    });
  }

  // 2. Check environment variables
  const envCandidate = env.ANTIGRAVITY_BIN_PATH || env.AGY_BIN_PATH || env.AGY_PATH;
  if (envCandidate && envCandidate.trim().length > 0) {
    const rawEnv = envCandidate.trim();
    const hasSeparator = rawEnv.includes('/') || rawEnv.includes('\\');

    if (hasSeparator) {
      const resolved = path.isAbsolute(rawEnv) ? rawEnv : path.resolve(cwd, rawEnv);
      if (fs.existsSync(resolved)) {
        return Object.freeze({
          found: true,
          executablePath: resolved,
          searchSource: 'env',
          reason: null,
        });
      }
      if (isWindows && !rawEnv.toLowerCase().endsWith('.exe')) {
        const withExe = `${resolved}.exe`;
        if (fs.existsSync(withExe)) {
          return Object.freeze({
            found: true,
            executablePath: withExe,
            searchSource: 'env',
            reason: null,
          });
        }
      }
      return Object.freeze({
        found: false,
        executablePath: null,
        searchSource: 'env',
        reason: `Environment Antigravity binary not found at "${rawEnv}"`,
      });
    }

    const onPath = findExecutableOnPath(rawEnv, pathEnv, isWindows);
    if (onPath) {
      return Object.freeze({
        found: true,
        executablePath: onPath,
        searchSource: 'env',
        reason: null,
      });
    }
    return Object.freeze({
      found: false,
      executablePath: null,
      searchSource: 'env',
      reason: `Environment Antigravity command "${rawEnv}" not found on PATH`,
    });
  }

  // 3. Default: search standard `agy` executable on PATH
  const defaultOnPath = findExecutableOnPath('agy', pathEnv, isWindows);
  if (defaultOnPath) {
    return Object.freeze({
      found: true,
      executablePath: defaultOnPath,
      searchSource: 'path',
      reason: null,
    });
  }

  return Object.freeze({
    found: false,
    executablePath: null,
    searchSource: 'none',
    reason: 'Antigravity CLI executable "agy" not found on system PATH or via environment configuration',
  });
}

// ============================================================================
// 3. PRODUCTION NODE PROCESS RUNNER
// ============================================================================

/**
 * Production process runner that spawns the real Antigravity executable
 * using direct process execution (no shell interpolation).
 */
export class NodeAntigravityProcessRunner implements AntigravityProcessRunner {
  async run(options: AntigravityProcessOptions): Promise<AntigravityProcessResult> {
    const startedAt = new Date().toISOString();
    const startHr = process.hrtime.bigint();

    if (options.signal?.aborted) {
      const completedAt = new Date().toISOString();
      return Object.freeze({
        exitCode: null,
        signal: 'SIGABRT',
        stdout: '',
        stderr: 'Process cancelled by caller signal before start',
        durationMs: 0,
        startedAt,
        completedAt,
        timedOut: false,
        cancelled: true,
      });
    }

    return new Promise<AntigravityProcessResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let didTimeout = false;
      let didCancel = false;
      let spawnError: Error | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const childEnv = options.env ? { ...process.env, ...options.env } : { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;

      let child: child_process.ChildProcess;
      try {
        child = child_process.spawn(options.executable, [...options.args], {
          cwd: options.cwd,
          env: childEnv,
          windowsHide: true,
          shell: false, // Strict: direct execution, no shell interpretation
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const endHr = process.hrtime.bigint();
        const durationMs = Math.max(0, Math.round(Number(endHr - startHr) / 1_000_000));
        const completedAt = new Date().toISOString();
        return resolve(
          Object.freeze({
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: err instanceof Error ? err.message : String(err),
            durationMs,
            startedAt,
            completedAt,
            timedOut: false,
            cancelled: false,
            spawnError: err instanceof Error ? err : new Error(String(err)),
          })
        );
      }

      // Handler for abort / cancellation
      const onCallerAbort = () => {
        didCancel = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          } catch {
            // ignore
          }
        }, 1000).unref();
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onCallerAbort, { once: true });
      }

      // Handler for timeout
      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          didTimeout = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            } catch {
              // ignore
            }
          }, 1000).unref();
        }, options.timeoutMs);
      }

      // Stdin piping
      if (child.stdin) {
        child.stdin.on('error', () => {
          // Ignore EPIPE or write errors if child closes stdin early
        });

        if (options.stdinInput !== undefined && options.stdinInput !== null) {
          child.stdin.write(options.stdinInput, 'utf8');
        }
        child.stdin.end();
      }

      // Stdout capture
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
      }

      // Stderr capture
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
      }

      // Spawn error capture (e.g. ENOENT, EACCES)
      child.on('error', (err) => {
        spawnError = err;
      });

      // Process close cleanup
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;

        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);

        const endHr = process.hrtime.bigint();
        const durationMs = Math.max(0, Math.round(Number(endHr - startHr) / 1_000_000));
        const completedAt = new Date().toISOString();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        resolve(
          Object.freeze({
            exitCode: spawnError ? null : code,
            signal: signal ? String(signal) : null,
            stdout,
            stderr,
            durationMs,
            startedAt,
            completedAt,
            timedOut: didTimeout,
            cancelled: didCancel,
            spawnError,
          })
        );
      });
    });
  }
}

// ============================================================================
// 4. FAKE PROCESS RUNNER FOR DETERMINISTIC TESTING
// ============================================================================

export type FakeAntigravityProcessHandler = (
  options: AntigravityProcessOptions
) => Promise<Partial<AntigravityProcessResult>> | Partial<AntigravityProcessResult>;

/**
 * Deterministic in-memory fake process runner for unit and behavioral tests.
 * Enables full end-to-end adapter testing without requiring a real Antigravity installation.
 */
export class FakeAntigravityProcessRunner implements AntigravityProcessRunner {
  readonly executedCalls: AntigravityProcessOptions[] = [];
  private handler?: FakeAntigravityProcessHandler;

  constructor(handler?: FakeAntigravityProcessHandler) {
    this.handler = handler;
  }

  setHandler(handler: FakeAntigravityProcessHandler): void {
    this.handler = handler;
  }

  async run(options: AntigravityProcessOptions): Promise<AntigravityProcessResult> {
    this.executedCalls.push({ ...options });
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    if (options.signal?.aborted) {
      return Object.freeze({
        exitCode: null,
        signal: 'SIGABRT',
        stdout: '',
        stderr: 'Process cancelled by caller signal',
        durationMs: 5,
        startedAt,
        completedAt: new Date().toISOString(),
        timedOut: false,
        cancelled: true,
      });
    }

    if (this.handler) {
      const partial = await this.handler(options);
      const completedAt = partial.completedAt ?? new Date().toISOString();
      return Object.freeze({
        exitCode: partial.exitCode !== undefined ? partial.exitCode : 0,
        signal: partial.signal ?? null,
        stdout: partial.stdout ?? '',
        stderr: partial.stderr ?? '',
        durationMs: partial.durationMs ?? Math.max(1, Date.now() - startTime),
        startedAt,
        completedAt,
        timedOut: partial.timedOut ?? false,
        cancelled: partial.cancelled ?? false,
        spawnError: partial.spawnError ?? null,
      });
    }

    // Default mock response: valid stream-json turn completion
    const mockOutput = JSON.stringify({
      agent_claims: ['Task implementation verified via deterministic test runner'],
      unverified_changed_files: [],
      metadata: { mock: true },
    });

    return Object.freeze({
      exitCode: 0,
      signal: null,
      stdout: mockOutput,
      stderr: '',
      durationMs: 10,
      startedAt,
      completedAt: new Date().toISOString(),
      timedOut: false,
      cancelled: false,
    });
  }
}
