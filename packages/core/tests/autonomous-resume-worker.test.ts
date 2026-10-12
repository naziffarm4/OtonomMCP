/**
 * Resume after interruption + Antigravity-independent detached workers.
 *  - lock liveness (pid + heartbeat), interrupted-run detection
 *  - real interruption (child process SIGKILLed mid-task) -> fresh start refused -> --resume continues
 *    the SAME run: accepted tasks skipped, interrupted attempt stashed, budget ledger carried over,
 *    in-flight attempt not counted, spec fingerprint enforced, IdP-approved runs need a NEW passkey
 *  - MCP: resumeRunId -> new IdP approval bound to the run (pkg-resume, resumeOfRunId in fingerprint)
 *  - detached worker survives its parent being killed, waits for the passkey approval, then completes
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import { createAutonomousStartHandler, createAutonomousResumeHandler, createAutonomousStatusHandler } from '../dist/mcp/index.js';
import { BudgetManager } from '../dist/budget/index.js';
import {
  lockLiveness,
  listInterruptedRuns,
  loadCheckpoint,
  readRunLock,
  computeApprovalContextFingerprint,
} from '../dist/autonomous/index.js';
import { InMemoryIdentityManager, MockAgyExecutor, MockDirectorLlm } from './helpers/autonomous-test-doubles.ts';
import { FakeIdp } from './helpers/fake-idp.ts';

const HERE = import.meta.dirname;
const SPEC = `# Mini Matematik

Küçük bir matematik kütüphanesi.

## Gereksinimler

### Toplama
\`src/add.js\` içinde add fonksiyonu.
- add fonksiyonu dışa aktarılır

### Çarpma
\`src/mul.js\` içinde mul fonksiyonu.
`;

function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (r: any) => JSON.parse(r.content[0].text);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function newProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-resume-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@e.x');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'commit', '--allow-empty', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
  return dir;
}

const TS = ['--experimental-strip-types', '--no-warnings'];

/** Runs a real `aidm run --spec` in a child that SIGKILLs itself during the 2nd task. */
function crashRun(dir: string): void {
  const r = spawnSync(process.execPath, [...TS, path.join(HERE, 'helpers', 'crash-run.ts'), dir], { encoding: 'utf8', timeout: 120_000 });
  assert.ok(!String(r.stdout).includes('NOT_CRASHED'), `child should have been killed: ${r.stdout} ${r.stderr}`);
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

describe('resume after interruption + detached workers', { concurrency: 1 }, () => {
  let dir: string;
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;
  let out: string[];
  beforeEach(() => {
    dir = newProject();
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    out = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cli = (args: string[]) =>
    executeCli(['run', '--spec', 'proje.md', '-C', dir, ...args, '--json'], {
      cwd: dir,
      env: {},
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rep = (r: any) => r.data as any;

  it('lock liveness: dead pid / old heartbeat => STALE; own pid, fresh heartbeat or unattributable lock => ALIVE', () => {
    const now = new Date().toISOString();
    assert.equal(lockLiveness(null), 'NONE');
    assert.equal(lockLiveness({ runId: 'r', pid: deadPid(), startedAt: now, heartbeatAt: now }), 'STALE');
    assert.equal(lockLiveness({ runId: 'r', pid: process.pid, startedAt: now, heartbeatAt: now }), 'ALIVE');
    assert.equal(lockLiveness({ runId: 'r', pid: process.ppid, startedAt: now, heartbeatAt: now }), 'ALIVE');
    assert.equal(lockLiveness({ runId: 'r', pid: process.ppid, startedAt: now, heartbeatAt: new Date(Date.now() - 3_600_000).toISOString() }), 'STALE');
    assert.equal(lockLiveness({ runId: '', pid: -1, startedAt: '' }), 'ALIVE', 'garbled lock fails closed');
    // resumeOfRunId is part of the approval fingerprint only when set (fresh-run fingerprints unchanged).
    const base = { operation: 'AUTONOMOUS_SPEC_RUN', projectId: 'p', specFingerprint: 'f', packageId: 'k', revision: 1, budgetUsd: 1, allowedPaths: ['src'], mandateHours: 8, maxCyclesPerTask: 3 };
    assert.equal(computeApprovalContextFingerprint(base), computeApprovalContextFingerprint({ ...base, resumeOfRunId: undefined }));
    assert.notEqual(computeApprovalContextFingerprint(base), computeApprovalContextFingerprint({ ...base, resumeOfRunId: 'run-x' }));
  });

  it('killed mid-task: fresh start refused; --resume continues the SAME run (skip accepted, stash attempt, budget carried, attempt not counted)', async () => {
    crashRun(dir);
    const interrupted = listInterruptedRuns(dir);
    assert.equal(interrupted.length, 1, 'checkpoint + stale lock => interrupted');
    const cp = interrupted[0];
    assert.equal(cp.state, 'RUNNING');
    assert.equal(cp.inCycle, true);
    assert.equal(lockLiveness(readRunLock(dir)), 'STALE');
    assert.ok(git(dir, 'status', '--porcelain').includes('src/mul.js'), 'interrupted attempt left uncommitted files');
    const accepted = cp.tasks.filter((t) => t.status === 'ACCEPTED').map((t) => t.taskId);
    assert.equal(accepted.length, 1);
    const db = new BudgetManager({ dbPath: path.join(dir, '.ai-manager', 'state', 'budget', `${cp.runId}.db`) });
    db.open();
    const spentBefore = db.getGlobalAccount()!.committedSpendNanoUsd;
    db.close();
    assert.ok(spentBefore > 0n);

    // A fresh run must not silently clobber the interrupted one.
    const fresh = rep(await cli(['--budget-usd', '1']));
    assert.equal(fresh.status, 'CONFIGURATION_ERROR');
    assert.match(fresh.stopReason, new RegExp(`interrupted run exists.*${cp.runId.replace(/[.]/g, '\\.')}`));
    assert.match(fresh.stopReason, /--resume/);
    assert.equal(agy.calls, 0);

    // Budget cap is fixed for the run.
    const wrongBudget = rep(await cli(['--resume', cp.runId, '--budget-usd', '2']));
    assert.equal(wrongBudget.status, 'CONFIGURATION_ERROR');
    assert.match(wrongBudget.stopReason, /budget cap is fixed/);

    // Spec changed => refused.
    fs.appendFileSync(path.join(dir, 'proje.md'), '\n### Bölme\n`src/div.js` içinde div.\n');
    const changed = rep(await cli(['--resume']));
    assert.equal(changed.status, 'CONFIGURATION_ERROR');
    assert.match(changed.stopReason, /fingerprint mismatch/);
    // Restore byte-exact (git checkout could re-add CRLF with core.autocrlf on Windows).
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');

    const r = rep(await cli(['--resume']));
    assert.equal(r.status, 'COMPLETED', `${r.stopReason}\n${out.join('\n').slice(-3000)}`);
    assert.equal(r.runId, cp.runId, 'same runId');
    const byId = Object.fromEntries(r.tasks.map((t: any) => [t.taskId, t]));
    assert.equal(byId[accepted[0]].status, 'SKIPPED', 'completed task skipped');
    const other = r.tasks.find((t: any) => t.taskId !== accepted[0]);
    assert.equal(other.status, 'ACCEPTED');
    assert.equal(other.cycles, 1, 'the in-flight attempt of the killed process is not counted');
    assert.equal(agy.calls, 1, 'only the interrupted task was executed again');
    assert.match(git(dir, 'stash', 'list'), /aidm-resume .*interrupted attempt/);
    assert.ok(r.commits.length >= cp.commits.length);
    for (const c of cp.commits) assert.ok(r.commits.includes(c), 'earlier commits carried in the report');
    // Budget: same ledger, same cap, spend carried over.
    assert.equal(r.budget.limitUsd, 1);
    assert.ok(BigInt(Math.round(r.budget.committedUsd * 1e9)) > spentBefore, `${r.budget.committedUsd} > ${spentBefore}`);
    const fin = loadCheckpoint(dir, cp.runId)!;
    assert.equal(fin.state, 'FINISHED');
    assert.equal(fin.status, 'COMPLETED');
    assert.equal(fin.segment, 2);
    assert.equal(listInterruptedRuns(dir).length, 0);
    // Nothing left to resume.
    const again = rep(await cli(['--resume', cp.runId]));
    assert.equal(again.status, 'CONFIGURATION_ERROR');
    assert.match(again.stopReason, /already finished/);
  });

  it('a live run is never double-run; IdP-approved runs cannot be resumed with operator (CLI) approval; abandon starts fresh', async () => {
    crashRun(dir);
    const cp = listInterruptedRuns(dir)[0];
    // Pretend it is alive (heartbeat of a live pid).
    const lockFile = path.join(dir, '.ai-manager', 'state', 'autonomous-run.lock');
    const saved = fs.readFileSync(lockFile, 'utf8');
    fs.writeFileSync(lockFile, JSON.stringify({ runId: cp.runId, pid: process.pid, startedAt: cp.startedAt, heartbeatAt: new Date().toISOString() }));
    const alive = rep(await cli(['--resume', cp.runId]));
    assert.equal(alive.status, 'CONFIGURATION_ERROR');
    assert.match(alive.stopReason, /still active/);
    const nested = rep(await cli(['--budget-usd', '1']));
    assert.equal(nested.status, 'BLOCKED_ON_AUTH_CONTEXT');
    fs.writeFileSync(lockFile, saved);

    const cpFile = path.join(dir, '.ai-manager', 'state', 'autonomous-runs', `${cp.runId}.json`);
    const j = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
    fs.writeFileSync(cpFile, JSON.stringify({ ...j, approval: 'idp' }));
    const cliResume = rep(await cli(['--resume', cp.runId]));
    assert.equal(cliResume.status, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.match(cliResume.stopReason, /NEW IdP passkey approval/);
    assert.equal(agy.calls, 0);
    fs.writeFileSync(cpFile, JSON.stringify(j));

    git(dir, 'stash', '-u');
    const ab = rep(await cli(['--budget-usd', '1', '--abandon-interrupted']));
    assert.equal(ab.status, 'COMPLETED', ab.stopReason);
    assert.notEqual(ab.runId, cp.runId);
    assert.equal(loadCheckpoint(dir, cp.runId)!.status, 'ABANDONED');
  });

  describe('with the external IdP', () => {
    let idp: FakeIdp;
    before(async () => {
      idp = new FakeIdp();
      await idp.start();
    });
    after(async () => idp.stop());

    it('MCP resumeRunId: NEW passkey approval bound to the run (pkg-resume + resumeOfRunId), monitor seq continues, same runId', async () => {
      crashRun(dir);
      const cp = listInterruptedRuns(dir)[0];
      const env = idp.env();
      const deps = { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing, executorPort: agy, env, foregroundResume: true };
      const st0 = parse(await createAutonomousStatusHandler()({ workspaceRoot: dir }, {} as never));
      assert.equal(st0.runs[0].liveness, 'INTERRUPTED');
      assert.match(st0.resumeHint, new RegExp(cp.runId.replace(/[.]/g, '\\.')));

      // Through aidm_autonomous_resume { runId } (delegates to start with resumeRunId).
      const start = parse(await createAutonomousResumeHandler(deps as never)({ workspaceRoot: dir, runId: cp.runId }, {} as never));
      assert.equal(start.code, 'PENDING_EXTERNAL_APPROVAL', JSON.stringify(start));
      assert.equal(start.runId, cp.runId);
      const body = idp.approvals.get(start.requestId)!.body as any;
      assert.match(body.packageId, /^pkg-resume-/);
      assert.equal(body.summary.resumeOfRunId, cp.runId);
      assert.match(body.summary.text, /RESUME of interrupted run/);
      assert.equal(agy.calls, 0, 'nothing runs before the passkey approval');

      const putsBefore = idp.monitorPuts.length;
      idp.approve(start.requestId);
      const res = parse(await createAutonomousResumeHandler(deps as never)({ workspaceRoot: dir, requestId: start.requestId }, {} as never));
      assert.equal(res.code, 'COMPLETED', JSON.stringify(res).slice(0, 2000));
      assert.equal(res.report.runId, cp.runId);
      assert.equal(res.report.authorization.authSource, 'EXTERNAL_IDP');
      const seqs = idp.monitorPuts.slice(putsBefore).map((p: any) => p.seq as number);
      assert.ok(seqs.length > 0 && Math.min(...seqs) > cp.monitorSeq, 'resumed segment continues above the previous seq');
      assert.equal(loadCheckpoint(dir, cp.runId)!.approval, 'idp');
    });

    it('detached worker: survives its parent (MCP server stand-in) being killed, waits for the passkey, completes; status from disk', async () => {
      const env = {
        ...process.env,
        ...idp.env(),
        AIDM_IDP_POLL_INTERVAL_MS: '300',
        AIDM_WORKER_ALLOW_TEST_DOUBLES: '1',
        AIDM_WORKER_TEST_DOUBLES: path.join(HERE, 'helpers', 'worker-doubles.ts'),
        AIDM_TEST_AGY_DELAY_MS: '300',
      };
      const parent = spawn(process.execPath, [...TS, path.join(HERE, 'helpers', 'worker-parent.ts'), dir, 'proje.md'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      let err = '';
      parent.stderr.on('data', (d) => (err += d));
      const line = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`parent timeout: ${buf} ${err}`)), 60_000);
        parent.stdout.on('data', (d) => {
          buf += d;
          const m = /RESULT (.*)\n/.exec(buf);
          if (m) {
            clearTimeout(t);
            resolve(m[1]);
          }
        });
      });
      const res = JSON.parse(line);
      assert.equal(res.code, 'PENDING_EXTERNAL_APPROVAL', line);
      assert.ok(res.workerPid > 0 && res.logPath && res.approvalUrl && res.runId);
      // "Antigravity exits": kill the parent hard.
      parent.kill('SIGKILL');
      await new Promise((r) => parent.once('exit', r));
      await new Promise((r) => setTimeout(r, 1000));
      assert.doesNotThrow(() => process.kill(res.workerPid, 0), 'worker survived the parent');

      const status = async () => parse(await createAutonomousStatusHandler()({ workspaceRoot: dir }, {} as never));
      let st = await status();
      assert.equal(st.approvals[0].state, 'PENDING');
      assert.equal(st.approvals[0].workerAlive, true);
      assert.ok(st.approvals[0].approvalUrl);

      idp.approve(res.requestId);
      const deadline = Date.now() + 90_000;
      for (;;) {
        st = await status();
        const run = st.runs.find((r: any) => r.runId === res.runId);
        if (run?.liveness === 'FINISHED') {
          assert.equal(run.status, 'COMPLETED', fs.readFileSync(res.logPath, 'utf8').slice(-3000));
          break;
        }
        if (Date.now() > deadline) assert.fail(`worker did not finish: ${JSON.stringify(st).slice(0, 1500)}\n${fs.readFileSync(res.logPath, 'utf8').slice(-3000)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(st.approvals[0].state, 'FINISHED');
      assert.equal(st.approvals[0].runStatus, 'COMPLETED');
      const log = fs.readFileSync(res.logPath, 'utf8');
      assert.match(log, /TEST DOUBLES ACTIVE/);
      assert.match(log, /finished: COMPLETED/);
      assert.ok(!log.includes(String(idp.env().AIDM_IDP_CLIENT_TOKEN)), 'no client token in the log');
      // worker exits after the run
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        try {
          process.kill(res.workerPid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.throws(() => process.kill(res.workerPid, 0), 'worker exited after finishing');
    });
  });
});
