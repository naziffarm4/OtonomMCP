import { type CliExitCode } from './exit-codes.js';
import { type ExecutorPort } from '../executor-bridge/executor-port.js';
import { type UIAdapter } from '../adapters/ui-adapter.js';

export interface CliGlobalOptions {
  readonly projectRoot: string;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export interface CliRunResult {
  readonly exitCode: CliExitCode;
  readonly message?: string;
  readonly data?: unknown;
  readonly error?: string;
}

export interface CliAppOptions {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly executorPort?: ExecutorPort;
  readonly uiAdapter?: UIAdapter;
}

export interface InitCommandOptions {
  readonly projectRoot: string;
  readonly projectName?: string;
  readonly description?: string;
  readonly force: boolean;
  readonly json: boolean;
}

export interface StatusCommandOptions {
  readonly projectRoot: string;
  readonly json: boolean;
  readonly verbose: boolean;
}

export interface CheckpointCommandOptions {
  readonly projectRoot: string;
  readonly action: 'list' | 'create' | 'rollback' | 'help';
  readonly taskId?: string;
  readonly purpose?: string;
  readonly checkpointId?: string;
  readonly approvalToken?: string;
  readonly json: boolean;
}

export interface RunCommandOptions {
  readonly projectRoot: string;
  readonly requirementsPath?: string;
  readonly tasksPath?: string;
  readonly decisionsPath?: string;
  readonly approvalToken?: string;
  readonly maxRetries: number;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly verbose: boolean;
}
