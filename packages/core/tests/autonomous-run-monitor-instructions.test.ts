/**
 * Live run monitor (fire-and-forget reporter) and live PO instructions over the external IdP
 * contracts, against an in-process fake IdP. Offline & deterministic (mock LLM + mock AGY).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Cross-platform (no shell): works on Windows where /bin/sh does not exist.
function initTestRepo(cwd: string, addAll = false): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@e.x');
  git('config', 'commit.gpgsign', 'false');
  if (addAll) git('add', '-A');
  git('commit', '--allow-empty', '-qm', 'init');
}
import { executeCli } from '../dist/cli/index.js';
import { createAutonomousStartHandler, createAutonomousResumeHandler } from '../dist/mcp/index.js';
import { RUN_MONITOR_EVENT_TYPES, RunMonitor, runMonitorUrl, isRunMonitorEnabled, monitorText, InstructionChannel } from '../dist/autonomous/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';
import { FakeIdp, CLIENT_TOKEN } from './helpers/fake-idp.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
const parse = (r: Any) => JSON.parse(r.content[0].text);
const SECRET_KEY = 'sk-test-SECRETSECRETSECRET1234567890';
const SPEC = `# İzleme Projesi\n\nGIZLI_PROMPT_ICERIGI amaç.\n\n## Gereksinimler\n\n### Birinci\n\`src/a.js\` GIZLI_PROMPT_ICERIGI.\n\n### İkinci\n\`src/b.js\` ikinci.\n`;
const SNAPSHOT_KEYS = ['model', 'runId', 'seq', 'projectId', 'projectName', 'entryPoint', 'status', 'startedAt', 'updatedAt', 'finishedAt', 'budget', 'currentTaskId', 'tasks', 'lastDirectorAction', 'pendingApprovalId', 'pendingDecisionIds', 'stopReason'];
const EVENT_KEYS = ['seq', 'at', 'type', 'level', 'taskId', 'message'];
const prompts = (llm: MockDirectorLlm) => llm.requests.map((r) => r.messages.map((m: Any) => String(m.content ?? '')).join('\n'));

describe('run monitor + live PO instructions', { concurrency: 1, timeout: 600_000 }, () => {
  let idp: FakeIdp;
  let dir: string;
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;
  let out: string[];
  before(async () => {
    idp = new FakeIdp();
    await idp.start();
  });
  after(async () => idp.stop());
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-mon-'));
    initTestRepo(dir);
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    agy.contentFor = (req) => `// ${req.taskId} FILE_CONTENT_MARKER\n`;
    out = [];
    idp.monitorPuts.length = 0;
    idp.monitorEvents.length = 0;
    idp.rawBodies.length = 0;
    idp.monitorStatus = 200;
    idp.monitorDelayMs = 0;
    idp.instructions.clear();
    idp.channels.clear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cli = (env: Record<string, string>) =>
    executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1'], {
      cwd: dir,
      env,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
    });
  const monEnv = (extra: Record<string, string> = {}) => ({ AIDM_IDP_URL: idp.url, AIDM_IDP_CLIENT_TOKEN: CLIENT_TOKEN, OPENAI_API_KEY: SECRET_KEY, ...extra });

  // ------------------------------------------------------------------ monitor
  it('helpers: enablement, URL, text hygiene', () => {
    assert.equal(isRunMonitorEnabled({}), false);
    assert.equal(isRunMonitorEnabled({ AIDM_IDP_URL: 'https://idp.example' }), false);
    assert.equal(isRunMonitorEnabled({ AIDM_IDP_URL: 'https://idp.example', AIDM_IDP_CLIENT_TOKEN: 'x' }), true);
    assert.equal(isRunMonitorEnabled({ AIDM_IDP_URL: 'https://idp.example', AIDM_IDP_CLIENT_TOKEN: 'x', AIDM_IDP_RUN_MONITOR: 'off' }), false);
    assert.equal(runMonitorUrl({ AIDM_IDP_URL: 'https://idp.example/', AIDM_IDP_CLIENT_TOKEN: 'x' }, 'run a/b'), 'https://idp.example/#/runs/run%20a%2Fb');
    assert.equal(RunMonitor.create({ env: {}, runId: 'r' }), null);
    const t = monitorText(`key ${SECRET_KEY} Bearer abc.def.ghi \u202Eevil\u0007 ${'x'.repeat(600)}`, 100);
    assert.ok(!t.includes('SECRET') && !t.includes('\u202E') && !t.includes('\u0007'));
    assert.ok(t.length <= 100);
  });

  it('CLI run: prints monitor URL, sends contract-shaped snapshots/events in seq order, final COMPLETED, no secrets or contents', async () => {
    const r = await cli(monEnv());
    assert.equal(r.exitCode, 0, out.join('\n'));
    const line = out.find((l) => l.includes('Canlı izleme:'));
    assert.ok(line && line.includes(`${idp.url}/#/runs/`), out.join('\n'));
    assert.ok(idp.monitorPuts.length >= 2);
    for (const p of idp.monitorPuts) {
      for (const k of Object.keys(p)) assert.ok(SNAPSHOT_KEYS.includes(k), `unexpected snapshot key ${k}`);
      for (const t of p.tasks as Any[]) for (const k of Object.keys(t)) assert.ok(['taskId', 'title', 'status', 'cycles', 'maxAttempts', 'lastSummary'].includes(k), k);
    }
    const last = idp.monitorPuts.at(-1)!;
    assert.equal(last.status, 'COMPLETED');
    assert.ok(last.finishedAt);
    assert.equal(line!.split('/#/runs/')[1], encodeURIComponent(String(last.runId)));
    const types = idp.monitorEvents.map((e) => e.type);
    assert.ok(types.includes('RUN_STARTED') && types.includes('RUN_FINISHED') && types.includes('TASK_ACCEPTED'), types.join(','));
    for (const e of idp.monitorEvents) {
      for (const k of Object.keys(e)) assert.ok(EVENT_KEYS.includes(k), k);
      assert.ok((RUN_MONITOR_EVENT_TYPES as readonly string[]).includes(String(e.type)));
    }
    const seqs = [...idp.monitorPuts, ...idp.monitorEvents].map((x) => Number(x.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'seq unique');
    const evSeqs = idp.monitorEvents.map((e) => Number(e.seq));
    assert.deepEqual(evSeqs, [...evSeqs].sort((a, b) => a - b), 'events delivered in seq order');
    const all = idp.rawBodies.join('\n');
    for (const bad of [SECRET_KEY, CLIENT_TOKEN, 'FILE_CONTENT_MARKER', 'GIZLI_PROMPT_ICERIGI']) assert.ok(!all.includes(bad), `leaked ${bad}`);
  });

  it('AIDM_IDP_RUN_MONITOR=off disables the reporter entirely', async () => {
    const r = await cli(monEnv({ AIDM_IDP_RUN_MONITOR: 'off' }));
    assert.equal(r.exitCode, 0);
    assert.equal(idp.monitorPuts.length + idp.monitorEvents.length, 0);
    assert.ok(!out.some((l) => l.includes('Canlı izleme')));
  });

  it('failure isolation: IdP down, 500, or slow never blocks or changes the run', async () => {
    const fresh = async (env: Record<string, string>) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-mon-iso-'));
      initTestRepo(d);
      fs.writeFileSync(path.join(d, 'proje.md'), SPEC, 'utf8');
      const t0 = Date.now();
      const lines: string[] = [];
      const r = await executeCli(['run', '--spec', 'proje.md', '-C', d, '--budget-usd', '1', '--json'], {
        cwd: d,
        env,
        stdout: (t) => lines.push(t),
        stderr: (t) => lines.push(t),
        executorPort: new MockAgyExecutor(d),
        autonomous: { llmProvider: new MockDirectorLlm(), allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: d }), registerBudgetTerms: pricing },
      });
      fs.rmSync(d, { recursive: true, force: true });
      return { r, ms: Date.now() - t0, lines };
    };
    const down = await fresh(monEnv({ AIDM_IDP_URL: 'http://127.0.0.1:1' }));
    assert.equal(down.r.exitCode, 0, down.lines.join('\n'));
    assert.equal((down.r.data as Any).status, 'COMPLETED');
    idp.monitorStatus = 500;
    const err = await fresh(monEnv());
    assert.equal((err.r.data as Any).status, 'COMPLETED');
    idp.monitorStatus = 200;
    idp.monitorDelayMs = 8000;
    const slow = await fresh(monEnv());
    idp.monitorDelayMs = 0;
    assert.equal((slow.r.data as Any).status, 'COMPLETED');
    assert.ok(slow.ms < 20_000, `slow IdP must not stall the run (${slow.ms} ms)`);
    await new Promise((r) => setTimeout(r, 8500)); // let the fake server drain delayed requests
  });

  // ------------------------------------------------------------------ instructions (MCP background flow)
  const deps = (env: Record<string, string>) => ({
    llmProvider: llm,
    allowMockProvider: true,
    identityManager: new InMemoryIdentityManager({ baseDir: dir }),
    registerBudgetTerms: pricing,
    executorPort: agy,
    env,
    foregroundResume: true,
  });
  async function approvedRun(onFirstExecute: (runId: string) => void, extraEnv: Record<string, string> = {}) {
    const env = idp.env({ AIDM_IDP_POLL_INTERVAL_MS: '500', ...extraEnv });
    const s = parse(await createAutonomousStartHandler(deps(env) as never)({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, {} as never));
    assert.equal(s.code, 'PENDING_EXTERNAL_APPROVAL', JSON.stringify(s));
    assert.ok(String(s.monitorUrl).includes('/#/runs/'), 'monitor URL returned with the approval request');
    assert.ok(idp.monitorPuts.some((p) => p.status === 'PENDING_APPROVAL' && p.pendingApprovalId === s.requestId), 'PENDING_APPROVAL snapshot');
    idp.approve(s.requestId);
    let fired = false;
    agy.onExecute = () => {
      if (fired) return;
      fired = true;
      const runId = [...idp.channels.entries()].find(([, v]) => v)?.[0] as string;
      assert.ok(runId, 'instruction channel opened before execution');
      onFirstExecute(runId);
    };
    const r = parse(await createAutonomousResumeHandler(deps(env) as never)({ workspaceRoot: dir, requestId: s.requestId }, {} as never));
    return r;
  }
  const acks = (id: string) => idp.instructions.get(id)!.acks.map((a) => a.status);

  it('NOTE: verified, ack RECEIVED→APPLIED, reaches the NEXT Director call (step boundary, AGY not interrupted)', async () => {
    let id = '';
    const r = await approvedRun((runId) => {
      id = idp.addInstruction(runId, 'NOTE', 'PO_NOTE_77 tarih biçimi GG.AA.YYYY');
    });
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason}`);
    assert.deepEqual(acks(id), ['RECEIVED', 'APPLIED']);
    const p = prompts(llm);
    assert.ok(!p[0].includes('PO_NOTE_77'));
    assert.ok(p.slice(1).some((x) => x.includes('PO_NOTE_77')));
    assert.ok(fs.existsSync(path.join(dir, 'src', 'a.js')), 'in-flight AGY step completed');
    assert.equal(r.report.instructions.find((i: Any) => i.instructionId === id).state, 'APPLIED');
    const ch = [...idp.channels.values()][0];
    assert.equal(ch, null, 'channel closed at run end');
  });

  it('STOP (empty text): graceful STOPPED, report written, ack APPLIED, remaining task not executed', async () => {
    let id = '';
    const r = await approvedRun((runId) => {
      id = idp.addInstruction(runId, 'STOP', '');
    });
    assert.equal(r.report.status, 'STOPPED', r.report.stopReason);
    assert.deepEqual(acks(id), ['RECEIVED', 'APPLIED']);
    assert.equal(agy.calls, 1);
    assert.ok(fs.readdirSync(path.join(dir, '.ai-manager')).length > 0);
  });

  it('forged / wrong-run / expired / replayed / unknown-target tokens are REJECTED; a valid targeted note is applied', async () => {
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ids: Record<string, string> = {};
    const r = await approvedRun((runId) => {
      ids.forged = idp.addInstruction(runId, 'NOTE', 'x', {}, { key: other.privateKey });
      ids.wrongRun = idp.addInstruction(runId, 'NOTE', 'x', { runId: 'run-other' });
      ids.expired = idp.addInstruction(runId, 'NOTE', 'x', { iat: 1_000, nbf: 1_000, exp: 2_000 });
      ids.unknownTask = idp.addInstruction(runId, 'NOTE', 'x', { taskId: 'TASK-999' });
      ids.badMode = idp.addInstruction(runId, 'NOTE', 'x', { mode: 'GRANT_BUDGET' });
      ids.targeted = idp.addInstruction(runId, 'NOTE', 'TARGETED_NOTE_5', { taskId: 'TASK-002' });
      // Replay: the targeted token re-delivered under a new id.
      const replayId = crypto.randomUUID();
      idp.instructions.set(replayId, { ...idp.instructions.get(ids.targeted)!, state: 'PENDING_DELIVERY', acks: [] });
      ids.replay = replayId;
    });
    assert.equal(r.code, 'COMPLETED', r.report?.stopReason);
    for (const k of ['forged', 'wrongRun', 'expired', 'unknownTask', 'badMode', 'replay']) assert.deepEqual(acks(ids[k]), ['REJECTED'], k);
    assert.deepEqual(acks(ids.targeted), ['RECEIVED', 'APPLIED']);
    assert.ok(prompts(llm).some((x) => x.includes('TARGETED_NOTE_5')));
  });

  it('PAUSE_AND_APPLY: applied at the next step boundary within the mandate; out-of-mandate request is REJECTED, never self-granted', async () => {
    let id = '';
    const r = await approvedRun((runId) => {
      id = idp.addInstruction(runId, 'PAUSE_AND_APPLY', 'PAUSE_TEXT_9 önce testleri yaz');
    });
    assert.equal(r.code, 'COMPLETED', r.report?.stopReason);
    assert.deepEqual(acks(id), ['RECEIVED', 'APPLIED']);
    const p = prompts(llm);
    const i = p.findIndex((x) => x.includes('PAUSE_TEXT_9'));
    assert.ok(i >= 1);

    // Out of mandate: the Director can only escalate → instruction REJECTED, nothing granted.
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-mon-'));
    initTestRepo(dir);
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    let escalated = false;
    llm.script = ({ prompt }) => {
      if (!escalated && prompt.includes('BUTCEYI_ARTIR')) {
        escalated = true;
        return {
          actionType: 'REQUEST_HUMAN_DECISION',
          rationale: 'Outside mandate.',
          question: 'Bütçe artırılsın mı?',
          reason: 'Mandate dışı.',
          blocking: true,
          options: [
            { id: 'yes', label: 'Evet' },
            { id: 'no', label: 'Hayır' },
          ],
        };
      }
      return undefined;
    };
    let id2 = '';
    const r2 = await approvedRun(
      (runId) => {
        id2 = idp.addInstruction(runId, 'PAUSE_AND_APPLY', 'BUTCEYI_ARTIR 10 USD yap');
      },
      { AIDM_DECISION_MODE: 'assume' }
    );
    assert.deepEqual(acks(id2).slice(0, 1), ['RECEIVED']);
    assert.equal(acks(id2).at(-1), 'REJECTED', JSON.stringify(idp.instructions.get(id2)!.acks));
    assert.equal(r2.report.budget.limitUsd, 1, 'budget never self-granted');
  });

  it('InstructionChannel is exported and inert without IdP config', () => {
    assert.equal(InstructionChannel.create({ env: {}, provider: undefined as never, binding: {} as never }), null);
  });
});
