/**
 * Detached autonomous worker entry point: `node worker-main.js <job.json>` (see worker.ts).
 * Never prints secrets; all progress goes to the log file and the on-disk run state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerJob } from './worker.js';
import { AutonomousSpecRunner, type AutonomousRunOptions } from './autonomous-runner.js';
import { loadExternalApprovalRecord, resumeExternalApproval } from './external-approval.js';

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} [aidm-worker ${process.pid}] ${msg}\n`);
}

/**
 * Test-only dependency injection (mock LLM / executor). Honoured ONLY when the environment explicitly
 * allows it; production workers never load code from the environment.
 */
async function testDoubles(projectRoot: string): Promise<Partial<AutonomousRunOptions>> {
  const mod = process.env.AIDM_WORKER_TEST_DOUBLES;
  if (!mod || process.env.AIDM_WORKER_ALLOW_TEST_DOUBLES !== '1') return {};
  const m = (await import(pathToFileURL(path.resolve(mod)).href)) as { createWorkerDoubles: (root: string) => Partial<AutonomousRunOptions> };
  log('TEST DOUBLES ACTIVE (mock LLM/executor)');
  return m.createWorkerDoubles(projectRoot);
}

async function main(): Promise<number> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    log('usage: worker-main.js <job.json>');
    return 2;
  }
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8')) as WorkerJob;
  if (job.envFile) {
    // WMI launch: environment hand-over (deleted immediately).
    try {
      const env = JSON.parse(fs.readFileSync(job.envFile, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
    } finally {
      fs.rmSync(job.envFile, { force: true });
    }
  }
  if (!fs.existsSync(job.logPath) || process.stdout.isTTY || !process.stdout.writable) {
    // WMI launch has no stdio: append to the log ourselves.
    const fd = fs.openSync(job.logPath, 'a');
    const w = (chunk: unknown) => {
      try {
        fs.writeSync(fd, typeof chunk === 'string' ? chunk : String(chunk));
      } catch {
        /* ignore */
      }
      return true;
    };
    process.stdout.write = w as never;
    process.stderr.write = w as never;
  }
  log(`job ${job.jobId} (${job.kind}) in ${job.projectRoot}`);
  const deps = await testDoubles(job.projectRoot);
  const onEvent = (e: { type: string; taskId?: string; message: string }) =>
    log(`${e.type}${e.taskId ? ` [${e.taskId}]` : ''} ${e.message.slice(0, 500)}`);

  if (job.kind === 'approval') {
    const pollMs = Math.max(500, Number(process.env.AIDM_IDP_POLL_INTERVAL_MS ?? '3000') || 3000);
    for (;;) {
      const rec = await loadExternalApprovalRecord(job.projectRoot, job.requestId);
      if (!rec) {
        log(`approval ${job.requestId} not found`);
        return 1;
      }
      if (rec.state !== 'PENDING') {
        log(`approval ${job.requestId} is ${rec.state}; nothing to do`);
        return 0;
      }
      const res = await resumeExternalApproval({
        projectRoot: job.projectRoot,
        requestId: job.requestId,
        background: false,
        runnerDeps: { ...deps, onEvent, logPath: job.logPath },
      });
      if (res.code === 'PENDING_EXTERNAL_APPROVAL' || res.code === 'IDP_UNREACHABLE' || res.code === 'IDP_STATUS_FAILED') {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      // An invalid/forged token does not burn the request: keep waiting for the real approval.
      if (!res.report && !res.success && res.record?.state === 'PENDING') {
        log(`approval not accepted yet: ${res.code} ${res.message ?? ''}`);
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      log(`finished: ${res.code}${res.report?.stopReason ? ` — ${res.report.stopReason}` : res.message ? ` — ${res.message}` : ''}`);
      return res.report ? 0 : 1;
    }
  }

  const report = await new AutonomousSpecRunner({
    ...deps,
    projectRoot: job.projectRoot,
    specPath: job.specPath,
    budgetUsd: job.budgetUsd,
    maxCyclesPerTask: job.maxCyclesPerTask,
    mandateValidityHours: job.mandateHours,
    entryPoint: 'aidm_autonomous_start',
    authContext: job.authContext,
    ...(job.runId ? { runId: job.runId } : {}),
    ...(job.resumeRunId ? { resumeRunId: job.resumeRunId } : {}),
    ...(job.abandonInterrupted ? { abandonInterrupted: true } : {}),
    logPath: job.logPath,
    onEvent,
  }).run();
  log(`finished: ${report.status}${report.stopReason ? ` — ${report.stopReason}` : ''}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });
