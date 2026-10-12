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
import { TtyDecisionResolver } from '../../autonomous/decision-requests.js';
import { isExternalIdpConfigured } from '../../autonomous/idp-client.js';
import { resumeExternalApproval, startExternalApproval } from '../../autonomous/external-approval.js';

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
  /** 'cli' (default): the operator's explicit invocation authorizes. 'idp': passkey approval via the external IdP. */
  readonly approval?: 'cli' | 'idp';
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
  const approval = flags['approval'] === undefined ? 'cli' : str('approval');
  if (approval !== 'cli' && approval !== 'idp') return { ok: false, error: "--approval must be 'cli' or 'idp'" };

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
      ...(approval === 'idp' ? { approval: 'idp' as const } : {}),
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

  const onEvent = options.json
    ? undefined
    : (e: { type: string; taskId?: string; message: string }) => {
        if (options.verbose || e.type !== 'CYCLE_START') {
          writer.write(`[AIDM] ${e.type}${e.taskId ? ` [${e.taskId}]` : ''} ${e.message}`);
        }
      };
  // Human decisions: external IdP when configured (runner default); otherwise an interactive
  // terminal prompt when stdin is a TTY; otherwise none (BLOCKED_ON_HUMAN). AGY never asks.
  const ttyResolver =
    !options.json && !isExternalIdpConfigured(env) && process.stdin.isTTY ? { decisionResolver: new TtyDecisionResolver() } : {};

  let report: AutonomousRunReport;
  if (options.approval === 'idp' && !options.dryRun) {
    if (!isExternalIdpConfigured(env)) {
      const msg = '--approval idp requires AIDM_IDP_URL/ISSUER/AUDIENCE, a public key (PEM/JWKS) and AIDM_IDP_CLIENT_TOKEN.';
      if (options.json) writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
      else writer.writeError(`Error: ${msg}`);
      return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
    }
    const started = await startExternalApproval({
      projectRoot: options.projectRoot,
      specPath: options.specPath,
      budgetUsd: options.budgetUsd,
      maxCyclesPerTask: options.maxCyclesPerTask,
      mandateHours: options.mandateValidityHours,
      env,
    });
    if (!started.success || !started.requestId) {
      const msg = `${started.code}: ${started.message ?? ''}`;
      if (options.json) writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.HUMAN_BLOCKED });
      else writer.writeError(`Error: ${msg}`);
      return { exitCode: CliExitCode.HUMAN_BLOCKED, error: msg };
    }
    if (!options.json) {
      writer.write(`Onay bekleniyor (passkey): ${started.approvalUrl ?? '(IdP arayüzü)'}`);
      writer.write(`  requestId: ${started.requestId}`);
    }
    const pollMs = Number((env as Record<string, string | undefined>).AIDM_IDP_POLL_INTERVAL_MS ?? '3000') || 3000;
    for (;;) {
      const res = await resumeExternalApproval({
        projectRoot: options.projectRoot,
        requestId: started.requestId,
        env,
        background: false,
        runnerDeps: {
          commit: options.commit,
          executorPort: appOptions?.executorPort,
          ...(appOptions?.autonomous ?? {}),
          onEvent,
        },
      });
      if (res.code === 'PENDING_EXTERNAL_APPROVAL') {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (!res.report) {
        const msg = `${res.code}: ${res.message ?? ''}`;
        if (options.json) writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.HUMAN_BLOCKED });
        else writer.writeError(`Error: ${msg}`);
        return { exitCode: CliExitCode.HUMAN_BLOCKED, error: msg };
      }
      report = res.report;
      break;
    }
    return renderReport(report, options, writer);
  }
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
      ...ttyResolver,
      ...(appOptions?.autonomous ?? {}),
      onEvent,
    }).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const usage = err instanceof SpecIngestionError || err instanceof AutonomousRunError;
    const exitCode = usage ? CliExitCode.USAGE_ERROR : CliExitCode.GENERAL_ERROR;
    if (options.json) writer.writeJson({ success: false, error: msg, exitCode });
    else writer.writeError(`Error: ${msg}`);
    return { exitCode, error: msg };
  }

  return renderReport(report, options, writer);
}

function renderReport(report: AutonomousRunReport, options: RunSpecCommandOptions, writer: CliOutputWriter): CliRunResult {
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
    const pending = report.decisions.filter((d) => d.state !== 'ANSWERED');
    if (report.decisions.length) writer.write(`  Kararlar:  ${report.decisions.length} soruldu, ${pending.length} cevapsız`);
    if (report.assumptions.length) writer.write(`  Varsayım:  ${report.assumptions.length} adet (rapora bakın)`);
    if (report.reportPath) writer.write(`  Rapor:     ${report.reportPath}`);
  }
  return { exitCode, data: report, error: report.stopReason };
}
