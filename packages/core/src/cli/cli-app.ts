import * as path from 'node:path';
import { type CliAppOptions, type CliRunResult } from './cli-types.js';
import { CliExitCode } from './exit-codes.js';
import { CliOutputWriter } from './cli-output.js';
import { executeInit } from './commands/init.js';
import { executeStatus } from './commands/status.js';
import { executeCheckpoint } from './commands/checkpoint.js';
import { executeRun } from './commands/run.js';

export const AIDM_VERSION = '0.1.0';

export function getHelpText(): string {
  return `AI Development Manager (AIDM) CLI v${AIDM_VERSION}

Usage:
  aidm <command> [options]

Commands:
  init                           Initialize an AIDM project/workspace
  run                            Start autonomous lifecycle execution
  status                         Read current project lifecycle and Git state
  checkpoint <action>            Manage Git checkpoints (list, create, rollback)

Global Options:
  -C, --project-root <path>      Project root directory (default: current directory)
  --json                         Output result in machine-readable JSON format
  --verbose                      Show detailed execution information
  -h, --help                     Show this help message
  -v, --version                  Show AIDM version

Run "aidm <command> --help" for command-specific options.
`;
}

export function parseCliTokens(args: string[]): {
  command?: string;
  subcommand?: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      if (equalIndex > 0) {
        const key = arg.slice(2, equalIndex);
        const val = arg.slice(equalIndex + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      // Single letter aliases
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals[0];
  const subcommand = positionals[1];

  return { command, subcommand, flags, positionals };
}

export async function executeCli(
  args: string[],
  appOptions?: CliAppOptions
): Promise<CliRunResult> {
  const writer = new CliOutputWriter(appOptions?.stdout, appOptions?.stderr);
  const cwd = appOptions?.cwd ?? process.cwd();

  const { command, subcommand, flags, positionals } = parseCliTokens(args);

  // Check global help / version
  if (flags['help'] || flags['h'] || (!command && args.length === 0)) {
    const help = getHelpText();
    writer.write(help);
    return { exitCode: CliExitCode.SUCCESS, message: help };
  }

  if (flags['version'] || flags['v']) {
    writer.write(`aidm v${AIDM_VERSION}`);
    return { exitCode: CliExitCode.SUCCESS, message: AIDM_VERSION };
  }

  // Resolve project root option (-C or --project-root)
  const rawRoot = (flags['project-root'] ?? flags['C'] ?? cwd) as string;
  const projectRoot = path.resolve(cwd, rawRoot);
  const json = Boolean(flags['json']);
  const verbose = Boolean(flags['verbose']);

  try {
    switch (command) {
      case 'init': {
        return await executeInit(
          {
            projectRoot,
            projectName: typeof flags['project-name'] === 'string' ? flags['project-name'] : undefined,
            description: typeof flags['description'] === 'string' ? flags['description'] : undefined,
            force: Boolean(flags['force'] || flags['yes']),
            json,
          },
          writer
        );
      }

      case 'status': {
        return await executeStatus(
          {
            projectRoot,
            json,
            verbose,
          },
          writer
        );
      }

      case 'checkpoint': {
        const rawAction = subcommand ?? (typeof flags['action'] === 'string' ? flags['action'] : undefined);
        let action: 'list' | 'create' | 'rollback' | 'help' = 'help';

        if (rawAction === 'list' || rawAction === 'create' || rawAction === 'rollback') {
          action = rawAction;
        } else if (flags['list']) {
          action = 'list';
        } else if (flags['create']) {
          action = 'create';
        } else if (flags['rollback']) {
          action = 'rollback';
        }

        const taskId = (flags['task'] ?? flags['task-id'] ?? positionals[2]) as string | undefined;
        const checkpointId = (flags['checkpoint'] ?? flags['checkpoint-id'] ?? flags['id'] ?? positionals[2]) as string | undefined;
        const purpose = flags['purpose'] as string | undefined;
        const approvalToken = (flags['token'] ?? flags['approval-token']) as string | undefined;

        return await executeCheckpoint(
          {
            projectRoot,
            action,
            taskId,
            checkpointId,
            purpose,
            approvalToken,
            json,
          },
          writer
        );
      }

      case 'run': {
        const maxRetries = flags['max-retries'] ? parseInt(String(flags['max-retries']), 10) : 3;
        const requirementsPath = flags['requirements'] ? String(flags['requirements']) : undefined;
        const tasksPath = flags['tasks'] ? String(flags['tasks']) : undefined;
        const decisionsPath = flags['decisions'] ? String(flags['decisions']) : undefined;
        const approvalToken = (flags['token'] ?? flags['approval-token']) as string | undefined;
        const dryRun = Boolean(flags['dry-run']);

        return await executeRun(
          {
            projectRoot,
            requirementsPath,
            tasksPath,
            decisionsPath,
            approvalToken,
            maxRetries: isNaN(maxRetries) ? 3 : maxRetries,
            dryRun,
            json,
            verbose,
          },
          writer,
          appOptions
        );
      }

      default: {
        const msg = `Unknown command "${command}". Run "aidm --help" for available commands.`;
        if (json) {
          writer.writeJson({
            success: false,
            error: msg,
            exitCode: CliExitCode.USAGE_ERROR,
          });
        } else {
          writer.writeError(`Error: ${msg}`);
        }
        return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (json) {
      writer.writeJson({
        success: false,
        error: errorMsg,
        exitCode: CliExitCode.GENERAL_ERROR,
      });
    } else {
      writer.writeError(`Unexpected Error: ${errorMsg}`);
      if (verbose && err instanceof Error && err.stack) {
        writer.writeError(err.stack);
      }
    }
    return { exitCode: CliExitCode.GENERAL_ERROR, error: errorMsg };
  }
}
