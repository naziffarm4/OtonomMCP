/**
 * `aidm run --spec <file.md> [--budget-usd N] [--dry-run]`
 *
 * Fully autonomous spec-driven development. The explicit invocation of this command by the
 * human operator is the authorization source for the auto-generated Project Mandate
 * (signed OPERATOR_CLI_INVOCATION context, see autonomous-mandate.ts). The LLM never
 * authorizes anything.
 */

import * as path from 'node:path';
import { type CliRunResult, type CliAppOptions } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import {
  AutonomousSpecRunner,
  AutonomousRunError,
  type AutonomousRunReport,
  type AutonomousRunStatus,
} from '../../autonomous/autonomous-runner.js';
import { SpecIngestionError } from '../../autonomous/spec-ingestor.js';

export interface RunSpecCommandOptions {
  readonly projectRoot: string;
  readonly specPath: string;
  readonly budgetUsd?: number;
  readonly dryRun: boolean;
  readonly maxCyclesPerTask?: number;
  readonly mandateValidityHours?: number;
  readonly commit: boolean;
  readonly llmEndpoint?: string;
  readonly llmModel?: string;
  readonly json: boolean;
  readonly verbose: boolean;
}

export type ParseRunSpecResult =
  | { readonly ok: true; readonly options: RunSpecCommandOptions }
  | { readonly ok: false; readonly error: string };

function positiveNumber(name: string, raw: string | boolean | undefined): number | undefined | Error {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return new Error(`--${name} requires a value`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return new Error(`--${name} must be a positive number, got '${raw}'`);
  return n;
}

/** Pure argument parsing for `aidm run --spec` (unit tested). */
export function parseRunSpecArgs(
  flags: Readonly<Record<string, string | boolean>>,
  ctx: { projectRoot: string; cwd: string; json: boolean; verbose: boolean }
): ParseRunSpecResult {
  const spec = flags['spec'];
  if (typeof spec !== 'string' || spec.trim().length === 0) {
    return { ok: false, error: '--spec requires a path to a Markdown file' };
  }
  if (!/\.(md|markdown)$/i.test(spec.trim())) {
    return { ok: false, error: `--spec must point to a Markdown file (.md), got '${spec}'` };
  }
  const budget = positiveNumber('budget-usd', flags['budget-usd']);
  if (budget instanceof Error) return { ok: false, error: budget.message };
  const cycles = positiveNumber('max-cycles', flags['max-cycles']);
  if (cycles instanceof Error) return { ok: false, error: cycles.message };
  if (cycles !== undefined && (!Number.isInteger(cycles) || cycles > 20)) {
    return { ok: false, error: '--max-cycles must be an integer between 1 and 20' };
  }
  const hours = positiveNumber('mandate-hours', flags['mandate-hours']);
  if (hours instanceof Error) return { ok: false, error: hours.message };
  if (hours !== undefined && hours > 24) return { ok: false, error: '--mandate-hours must be <= 24' };

  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);

  return {
    ok: true,
    options: {
      projectRoot: ctx.projectRoot,
      specPath: path.resolve(ctx.cwd, spec.trim()),
      budgetUsd: budget,
      dryRun: Boolean(flags['dry-run']),
      maxCyclesPerTask: cycles,
      mandateValidityHours: hours,
      commit: !flags['no-commit'],
      llmEndpoint: str('llm-endpoint'),
      llmModel: str('llm-model'),
      json: ctx.json,
      verbose: ctx.verbose,
    },
  };
}

export function exitCodeForAutonomousStatus(status: AutonomousRunStatus): CliExitCode {
  switch (status) {
    case 'DRY_RUN_OK':
    case 'COMPLETED':
      return CliExitCode.SUCCESS;
    case 'BLOCKED_ON_AUTH_CONTEXT':
    case 'BLOCKED_ON_HUMAN':
    case 'BUDGET_EXHAUSTED':
      return CliExitCode.HUMAN_BLOCKED;
    case 'CONFIGURATION_ERROR':
      return CliExitCode.USAGE_ERROR;
    case 'PARTIAL':
      return CliExitCode.PROJECT_FAILED;
    default:
      return CliExitCode.GENERAL_ERROR;
  }
}

export async function executeRunSpec(
  options: RunSpecCommandOptions,
  writer: CliOutputWriter,
  appOptions?: CliAppOptions
): Promise<CliRunResult> {
  const baseEnv = appOptions?.env ?? process.env;
  const env = {
    ...baseEnv,
    ...(options.llmEndpoint ? { AIDM_LLM_ENDPOINT: options.llmEndpoint } : {}),
    ...(options.llmModel ? { AIDM_LLM_MODEL: options.llmModel } : {}),
  };

  let report: AutonomousRunReport;
  try {
    report = await new AutonomousSpecRunner({
      projectRoot: options.projectRoot,
      specPath: options.specPath,
      budgetUsd: options.budgetUsd,
      dryRun: options.dryRun,
      maxCyclesPerTask: options.maxCyclesPerTask,
      mandateValidityHours: options.mandateValidityHours,
      commit: options.commit,
      entryPoint: 'aidm run --spec',
      env,
      executorPort: appOptions?.executorPort,
      ...(appOptions?.autonomous ?? {}),
      onEvent: options.json
        ? undefined
        : (e) => {
            if (options.verbose || e.type !== 'CYCLE_START') {
              writer.write(`[AIDM] ${e.type}${e.taskId ? ` [${e.taskId}]` : ''} ${e.message}`);
            }
          },
    }).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const usage = err instanceof SpecIngestionError || err instanceof AutonomousRunError;
    const exitCode = usage ? CliExitCode.USAGE_ERROR : CliExitCode.GENERAL_ERROR;
    if (options.json) writer.writeJson({ success: false, error: msg, exitCode });
    else writer.writeError(`Error: ${msg}`);
    return { exitCode, error: msg };
  }

  const exitCode = exitCodeForAutonomousStatus(report.status);
  if (options.json) {
    writer.writeJson({ success: exitCode === CliExitCode.SUCCESS, exitCode, data: report });
  } else {
    writer.write('');
    writer.write(`Otonom çalışma: ${report.status}${report.dryRun ? ' (dry-run: hiçbir dosya/LLM/AGY çağrısı yapılmadı)' : ''}`);
    if (report.stopReason) writer.write(`  Neden:     ${report.stopReason}`);
    writer.write(`  Proje:     ${report.projectName} (${report.projectId})`);
    writer.write(`  Spec:      ${report.specPath} sha256=${report.specFingerprint.slice(0, 16)}…`);
    writer.write(`  Görevler:  ${report.tasks.map((t) => `${t.taskId}=${t.status}`).join(', ')}`);
    if (report.mandate) {
      writer.write(`  Mandate:   ALLOW=${report.mandate.autoExecutableTaskClasses.join(',')}; insan onayı: ${report.mandate.humanApprovalRequiredOperations.join(',')}`);
    }
    if (report.budget) {
      writer.write(`  Bütçe:     $${report.budget.committedUsd.toFixed(4)} / $${report.budget.limitUsd.toFixed(2)} (rezerve $${report.budget.reservedUsd.toFixed(4)})`);
    }
    if (report.commits.length) writer.write(`  Commitler: ${report.commits.map((c) => c.slice(0, 10)).join(', ')}`);
    if (report.assumptions.length) writer.write(`  Varsayım:  ${report.assumptions.length} adet (rapora bakın)`);
    if (report.reportPath) writer.write(`  Rapor:     ${report.reportPath}`);
  }
  return { exitCode, data: report, error: report.stopReason };
}
