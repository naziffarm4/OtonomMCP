/**
 * CLI Driver Command Implementation (Phase 17 TASK-P17-01)
 *
 * Implements the foreground runtime command:
 * aidm driver run
 *
 * Features:
 * - Load/create the governed driver runtime
 * - Prevent duplicate driver instances (single active driver lock)
 * - Run controlled iterations in foreground
 * - Display meaningful lifecycle progress
 * - React to graceful stop via SIGINT / SIGTERM
 * - Persist durable driver state
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { type CliRunResult, type CliAppOptions } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import { DriverRuntime } from '../../driver/driver-runtime.js';
import { DriverStore } from '../../driver/driver-store.js';
import { DriverLockManager } from '../../driver/driver-lock.js';
import { DriverEngine } from '../../driver/driver-engine.js';
import { HistoryManager } from '../../storage/history-manager.js';
import { SpecStore } from '../../storage/spec-store.js';
import { DurableStateManager } from '../../storage/durable-state.js';
import { resolveCanonicalProjectIdentity } from '../../director/project-identity-resolver.js';
import { DriverConcurrencyError } from '../../driver/driver-errors.js';
import type { ExecutorPort } from '../../executor-bridge/executor-port.js';

export interface DriverCommandOptions {
  readonly projectRoot: string;
  readonly subcommand?: string;
  readonly targetTaskId?: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  readonly executorPort?: ExecutorPort;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

export async function executeDriver(
  options: DriverCommandOptions,
  writer: CliOutputWriter,
  appOptions?: CliAppOptions
): Promise<CliRunResult> {
  const projectRoot = path.resolve(options.projectRoot);

  try {
    await fs.promises.access(projectRoot, fs.constants.F_OK);
  } catch {
    const msg = `Target project directory does not exist: ${projectRoot}`;
    if (options.json) {
      writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
    } else {
      writer.writeError(`Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  const action = options.subcommand ?? 'run';

  const historyManager = new HistoryManager({ baseDir: projectRoot });
  const driverStore = new DriverStore({ workspaceRoot: projectRoot, historyManager });
  const lockManager = new DriverLockManager({ workspaceRoot: projectRoot });
  const specStore = new SpecStore({ baseDir: projectRoot });
  const durableStateManager = new DurableStateManager({ baseDir: projectRoot });

  const driverEngine = new DriverEngine({
    workspaceRoot: projectRoot,
    historyManager,
    specStore,
    durableStateManager,
    executorPort: options.executorPort,
  });

  const runtime = new DriverRuntime({
    workspaceRoot: projectRoot,
    driverEngine,
    lockManager,
    driverStore,
    historyManager,
  });

  if (action === 'status') {
    const state = await driverStore.loadState();
    const lock = await lockManager.getLockInfo();
    const isLocked = await lockManager.isLocked();

    const data = {
      projectRoot,
      driverState: state,
      lock,
      isLocked,
    };

    if (options.json) {
      writer.writeJson({ success: true, exitCode: CliExitCode.SUCCESS, data });
    } else {
      writer.write(`AIDM Autonomous Driver Status`);
      writer.write(`----------------------------`);
      writer.write(`Lifecycle State:   ${state?.lifecycleState ?? 'IDLE'}`);
      writer.write(`Active Task:       ${state?.currentTaskId ?? 'none'}`);
      writer.write(`Iteration:         ${state?.currentIteration ?? 0}`);
      writer.write(`Continuation:      ${state?.continuationState ?? 'NONE'}`);
      writer.write(`Last Terminal:     ${state?.lastTerminalStatus ?? 'none'}`);
      writer.write(`Driver Lock Held:  ${isLocked ? `YES (PID: ${lock?.pid})` : 'NO'}`);
    }
    return { exitCode: CliExitCode.SUCCESS, data };
  }

  if (action === 'stop') {
    await runtime.recover();
    await runtime.stop('Stopped via CLI');
    const msg = 'Driver stopped gracefully.';
    if (options.json) {
      writer.writeJson({ success: true, exitCode: CliExitCode.SUCCESS, message: msg });
    } else {
      writer.write(msg);
    }
    return { exitCode: CliExitCode.SUCCESS, message: msg };
  }

  if (action !== 'run') {
    const msg = `Unknown driver subcommand "${action}". Expected "run" or "status".`;
    if (options.json) {
      writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
    } else {
      writer.writeError(`Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  // Action is 'run'
  if (!options.json) {
    writer.write(`Starting Autonomous Driver (Foreground Runtime)...`);
    writer.write(`Project Root: ${projectRoot}`);
  }

  const abortController = new AbortController();
  const onSigInt = () => {
    if (!options.json) {
      writer.write('\nReceived interrupt signal (SIGINT). Stopping driver gracefully...');
    }
    abortController.abort();
  };
  const onSigTerm = () => {
    if (!options.json) {
      writer.write('\nReceived termination signal (SIGTERM). Stopping driver gracefully...');
    }
    abortController.abort();
  };

  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);

  try {
    const summary = await runtime.start({
      workspaceRoot: projectRoot,
      targetTaskId: options.targetTaskId,
      maxIterations: options.maxIterations,
      timeoutMs: options.timeoutMs,
      signal: abortController.signal,
      onIteration: (result) => {
        if (!options.json) {
          writer.write(
            `[Iteration ${result.iteration}] Task '${result.taskId}': ${result.cycleResult?.terminalStatus ?? result.decision} -> ${result.reason}`
          );
        }
      },
    });

    if (options.json) {
      writer.writeJson({
        success: true,
        exitCode: CliExitCode.SUCCESS,
        data: summary,
      });
    } else {
      writer.write(`\nDriver execution completed.`);
      writer.write(`Final State:    ${summary.lifecycleState}`);
      writer.write(`Iterations Run: ${summary.iterationsRun}`);
      writer.write(`Reason:         ${summary.reason}`);
    }

    return { exitCode: CliExitCode.SUCCESS, data: summary };
  } catch (err: any) {
    const isConcurrency = err instanceof DriverConcurrencyError;
    const exitCode = isConcurrency ? CliExitCode.USAGE_ERROR : CliExitCode.GENERAL_ERROR;
    const msg = err.message || String(err);

    if (options.json) {
      writer.writeJson({
        success: false,
        error: msg,
        exitCode,
      });
    } else {
      writer.writeError(`Driver Error: ${msg}`);
      if (options.verbose && err.stack) {
        writer.writeError(err.stack);
      }
    }

    return { exitCode, error: msg };
  } finally {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
  }
}
