/**
 * @file worker.ts
 * @description Detached autonomous worker processes (Antigravity / MCP-server independent runs).
 *
 * `aidm_autonomous_start` / `_resume` launched through the MCP server spawn a detached Node process
 * (`worker-main.js <job.json>`) that owns the run: it waits for the passkey approval (when the IdP is
 * used) and then runs the same AutonomousSpecRunner. The MCP server (and Antigravity) may exit;
 * the worker keeps going. stdout/stderr go to .ai-manager/logs/worker-<id>.log; state is on disk
 * (approval records, run checkpoints) so aidm_autonomous_status works from any process.
 *
 * Windows: by default the worker is spawned with DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP
 * (`detached: true`, `windowsHide`). If the parent lives inside a kill-on-close Job object, set
 * AIDM_WORKER_LAUNCH=wmi to create the worker through WMI (Win32_Process.Create), which places it
 * outside the parent's job; its environment is then handed over through a one-shot env file that the
 * worker deletes on start.
 *
 * Job files contain no secrets (no API keys / client tokens); an authContext token, when present, is a
 * single-use, short-lived, binding-checked assertion.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORKER_JOB_DIR = path.join('.ai-manager', 'state', 'worker-jobs');
export const WORKER_LOG_DIR = path.join('.ai-manager', 'logs');

export type WorkerJob =
  | {
      readonly kind: 'approval';
      readonly jobId: string;
      readonly projectRoot: string;
      readonly requestId: string;
      readonly logPath: string;
      envFile?: string;
    }
  | {
      readonly kind: 'run';
      readonly jobId: string;
      readonly projectRoot: string;
      readonly specPath: string;
      readonly runId?: string;
      readonly budgetUsd?: number;
      readonly maxCyclesPerTask?: number;
      readonly mandateHours?: number;
      readonly authContext?: Record<string, unknown>;
      readonly resumeRunId?: string;
      readonly abandonInterrupted?: boolean;
      readonly logPath: string;
      envFile?: string;
    };

export type WorkerJobInput = Omit<Extract<WorkerJob, { kind: 'approval' }>, 'jobId' | 'logPath' | 'envFile'> | Omit<Extract<WorkerJob, { kind: 'run' }>, 'jobId' | 'logPath' | 'envFile'>;

export interface SpawnedWorker {
  readonly pid: number | undefined;
  readonly jobId: string;
  readonly jobPath: string;
  readonly logPath: string;
  readonly launch: 'direct' | 'wmi';
}

export function workerMainPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker-main.js');
}

/** Detached workers are used unless disabled (AIDM_MCP_DETACHED_RUNS=off) or deps are injected (tests). */
export function detachedRunsEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return !/^(0|off|false|no)$/i.test((env.AIDM_MCP_DETACHED_RUNS ?? '').trim());
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function winQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export async function spawnDetachedWorker(
  input: WorkerJobInput,
  opts: { env?: Readonly<Record<string, string | undefined>>; launch?: 'direct' | 'wmi'; execArgv?: string[] } = {}
): Promise<SpawnedWorker> {
  const env = { ...(opts.env ?? process.env) } as Record<string, string | undefined>;
  const projectRoot = path.resolve(input.projectRoot);
  const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const logDir = path.join(projectRoot, WORKER_LOG_DIR);
  const jobDir = path.join(projectRoot, WORKER_JOB_DIR);
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(jobDir, { recursive: true });
  const logPath = path.join(logDir, `worker-${jobId}.log`);
  const jobPath = path.join(jobDir, `${jobId}.json`);
  const launch =
    opts.launch ?? (process.platform === 'win32' && /^wmi$/i.test(env.AIDM_WORKER_LAUNCH ?? '') ? 'wmi' : 'direct');
  const job: WorkerJob = { ...input, projectRoot, jobId, logPath } as WorkerJob;
  if (launch === 'wmi') {
    // WMI-created processes do not inherit our environment: one-shot env file, deleted by the worker.
    const envFile = path.join(jobDir, `${jobId}.env.json`);
    fs.writeFileSync(envFile, JSON.stringify(env), { encoding: 'utf8', mode: 0o600 });
    job.envFile = envFile;
  }
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), { encoding: 'utf8', mode: 0o600 });
  const execArgv = opts.execArgv ?? [];
  const args = [...execArgv, workerMainPath(), jobPath];

  if (launch === 'wmi') {
    const cmdLine = [process.execPath, ...args].map(winQuote).join(' ');
    // Win32_Process.Create: parent is WmiPrvSE, outside our Job object. stdio is redirected by the worker itself.
    const ps =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(cmdLine)}; CurrentDirectory = ${psQuote(projectRoot)} }; ` +
      'if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId';
    const pid = await new Promise<number | undefined>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30_000 }, (err, stdout) => {
        if (err) reject(new Error(`WMI worker launch failed: ${err.message}`));
        else resolve(Number(String(stdout).trim()) || undefined);
      });
    });
    return { pid, jobId, jobPath, logPath, launch };
  }

  const fd = fs.openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
    return { pid: child.pid, jobId, jobPath, logPath, launch };
  } finally {
    fs.closeSync(fd);
  }
}
