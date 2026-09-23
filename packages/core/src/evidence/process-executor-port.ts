import * as child_process from 'node:child_process';
import { ProcessExecutionError } from '../errors/collector-error.js';

export interface ProcessExecutionOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly windowsHide?: boolean;
}

export interface ProcessExecutionResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

/**
 * Abstraction port for injecting process execution capabilities into the Evidence Collector.
 * Decouples evidence collection from concrete OS process spawning for deterministic testing.
 */
export interface ProcessExecutorPort {
  executeProcess(
    command: string,
    options: ProcessExecutionOptions
  ): Promise<ProcessExecutionResult>;
}

/**
 * Production process executor utilizing Node.js child_process facilities.
 * Captures observable process facts: command, exit code, stdout, stderr, duration.
 * Does NOT contain hidden network access or permission-bypass flags.
 */
export class NodeProcessExecutor implements ProcessExecutorPort {
  async executeProcess(
    command: string,
    options: ProcessExecutionOptions
  ): Promise<ProcessExecutionResult> {
    const startHr = process.hrtime.bigint();
    const startedAt = new Date().toISOString();

    return new Promise<ProcessExecutionResult>((resolve, reject) => {
      child_process.exec(
        command,
        {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: options.maxBufferBytes ?? 10 * 1024 * 1024,
          windowsHide: options.windowsHide ?? true,
        },
        (error, stdout, stderr) => {
          const endHr = process.hrtime.bigint();
          const durationMs = Math.max(0, Math.round(Number(endHr - startHr) / 1_000_000));
          const completedAt = new Date().toISOString();
          const stdoutStr = String(stdout ?? '');
          const stderrStr = String(stderr ?? '');

          if (error) {
            // In Node.js child_process.exec, when a command exits with a non-zero exit code (e.g. 1),
            // error.code is the numerical exit code. This is an execution fact, not an executor crash.
            if (typeof error.code === 'number' && Number.isInteger(error.code) && error.code >= 0 && error.code <= 255) {
              return resolve({
                command,
                exitCode: error.code,
                stdout: stdoutStr,
                stderr: stderrStr,
                durationMs,
                startedAt,
                completedAt,
              });
            }

            // Otherwise, it was a spawn error (command not found, permission denied, killed by signal, etc.)
            return reject(
              new ProcessExecutionError(
                `Process execution failed for command '${command}': ${error.message}`,
                {
                  command,
                  workingDirectory: options.cwd,
                  reason: error.name || 'EXECUTION_FAILURE',
                  cause: error,
                }
              )
            );
          }

          resolve({
            command,
            exitCode: 0,
            stdout: stdoutStr,
            stderr: stderrStr,
            durationMs,
            startedAt,
            completedAt,
          });
        }
      );
    });
  }
}

/**
 * Deterministic in-memory fake process executor for unit and behavioral tests.
 */
export class FakeProcessExecutor implements ProcessExecutorPort {
  readonly executedCalls: { command: string; options: ProcessExecutionOptions }[] = [];
  private handler?: (command: string, options: ProcessExecutionOptions) => Promise<ProcessExecutionResult> | ProcessExecutionResult;

  constructor(
    handler?: (command: string, options: ProcessExecutionOptions) => Promise<ProcessExecutionResult> | ProcessExecutionResult
  ) {
    this.handler = handler;
  }

  setHandler(
    handler: (command: string, options: ProcessExecutionOptions) => Promise<ProcessExecutionResult> | ProcessExecutionResult
  ): void {
    this.handler = handler;
  }

  async executeProcess(
    command: string,
    options: ProcessExecutionOptions
  ): Promise<ProcessExecutionResult> {
    this.executedCalls.push({ command, options });
    if (this.handler) {
      return await this.handler(command, options);
    }
    return {
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 50,
      startedAt: null,
      completedAt: null,
    };
  }
}
