/**
 * Fixes from the first live run (Nazif-PC): per-task applicability of global commands + final
 * run-level gate, 3-attempt default with failure tails fed back to the Director, filesChanged
 * counting untracked files, provider preflight before any IdP request, spec "Deneme: N" override,
 * and the system-raised attempts-exhausted decision. Offline (mock LLM, mock AGY, fake IdP).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { executeCli, parseRunSpecArgs } from '../dist/cli/index.js';
import { createAutonomousStartHandler, createAutonomousResumeHandler } from '../dist/mcp/index.js';
import { SpecIngestor, IdpDecisionResolver, preflightLlmProvider, DEFAULT_MAX_ATTEMPTS_PER_TASK } from '../dist/autonomous/index.js';
import { NonceStore, createTrustedIdentityProvider } from '../dist/authorization/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';
import { FakeIdp } from './helpers/fake-idp.ts';

function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const parse = (r: Any) => JSON.parse(r.content[0].text);
const prompts = (llm: MockDirectorLlm) => llm.requests.map((r) => r.messages.map((m: Any) => String(m.content ?? '')).join('\n'));

/** check.cjs fails (stderr marker) until src/a.js contains FIXED. */
const CHECK_A = `const fs=require('fs');const s=fs.existsSync('src/a.js')?fs.readFileSync('src/a.js','utf8'):'';if(!s.includes('FIXED')){console.error('MARKER_A_NOT_FIXED');process.exit(1)}`;

function gitRepo(prefix: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c, 'utf8');
  }
  initTestRepo(dir, true);
  return dir;
}

describe('live-run fixes', { concurrency: 1, timeout: 600_000 }, () => {
  let dir: string;
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;
  let out: string[];
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  const setup = (spec: string, files: Record<string, string> = {}, targets: Record<string, string[]> = {}) => {
    dir = gitRepo('aidm-fix-', files);
    fs.writeFileSync(path.join(dir, 'proje.md'), spec, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    out = [];
    llm.script = ({ taskId }) => {
      const key = Object.keys(targets).find((k) => taskId.startsWith(k));
      return key ? { actionType: 'IMPLEMENT_TASK', rationale: 'x', taskId, objective: `Implement ${taskId}`, targetFiles: targets[key], implementationScope: '.', acceptanceCriteria: ['ok'], constraints: ['root'] } : undefined;
    };
  };
  const run = (args: string[] = [], env: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json', ...args], {
      cwd: dir,
      env,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing, ...extra },
    });
  const why = (rep: Any) => `${rep?.status}: ${rep?.stopReason}\n${JSON.stringify(rep?.tasks)}`.slice(0, 3000);

  it('spec: default 3 attempts per task; "Deneme: N" overrides per task; global criteria are not per-task', () => {
    const r = new SpecIngestor().ingest(
      `# P\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n- Deneme: 5\n- a çalışır\n\n### B\n\`src/b.js\`\nMax attempts: 1\n\n## Kabul Kriterleri\n- \`node all.js\` geçer\n`,
      { projectId: 'p' }
    );
    assert.equal(DEFAULT_MAX_ATTEMPTS_PER_TASK, 3);
    assert.equal(r.requirements[0].maxAttempts, 5);
    assert.equal(r.requirements[1].maxAttempts, 1);
    assert.deepEqual([...r.requirements[0].acceptanceCriteria], ['a çalışır']);
    assert.ok(!r.requirements[1].acceptanceCriteria.some((c: string) => c.includes('all.js')));
    assert.deepEqual([...r.globalAcceptanceCriteria], ['`node all.js` geçer']);
    const r2 = new SpecIngestor().ingest(`# P\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n`, { projectId: 'p' });
    assert.equal(r2.tasks[0].max_attempts, 3);
  });

  it('global command referencing a not-yet-created file is deferred per task and enforced by the final gate', async () => {
    setup(
      `# Kapı\n\nx.\n\n## Gereksinimler\n\n### Çekirdek\n\`src/core.js\` çekirdek.\n\n### Kontrol\n\`scripts/check.cjs\` kontrol betiği.\n\n## Komutlar\n- \`node scripts/check.cjs\`\n`,
      {},
      { 'TASK-002': ['scripts/check.cjs'] }
    );
    agy.contentFor = (req, f) => (f.endsWith('.cjs') ? 'process.exit(0)\n' : `// ${req.taskId}\n`);
    const r = await run();
    const rep = r.data as Any;
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.deepEqual(rep.tasks.map((t: Any) => t.status), ['ACCEPTED', 'ACCEPTED']);
    assert.ok(rep.deferredCommands.some((d: Any) => d.taskId === 'TASK-001' && d.commands.some((c: string) => /check\.cjs/.test(c))), JSON.stringify(rep.deferredCommands));
    assert.equal(rep.finalGate.status, 'PASS');
    assert.ok(rep.finalGate.checks.some((c: Any) => /check\.cjs/.test(c.command) && c.exitCode === 0));
  });

  it('final gate failure gets GATE-FIX repair; persistent failure ends PARTIAL (fail-closed)', async () => {
    const gate = `process.exit(require('fs').readFileSync('src/a.js','utf8').includes('GATE')?0:1)`;
    const spec = `# G\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n\n## Kabul Kriterleri\n- \`node gate.cjs\` geçer\n`;
    setup(spec, { 'gate.cjs': gate }, { 'TASK-001': ['src/a.js'], 'GATE-FIX': ['src/a.js'] });
    agy.contentFor = (req) => (req.taskId.startsWith('GATE-FIX') ? '// GATE\n' : '// a\n');
    let rep = (await run()).data as Any;
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(rep.finalGate.status, 'PASS');
    assert.ok(rep.finalGate.repairs >= 1);
    assert.ok(agy.requestsSeen.some((q) => q.taskId.startsWith('GATE-FIX')));
    fs.rmSync(dir, { recursive: true, force: true });

    setup(spec, { 'gate.cjs': 'process.exit(3)' });
    rep = (await run()).data as Any;
    assert.equal(rep.status, 'PARTIAL', why(rep));
    assert.equal(rep.finalGate.status, 'FAIL');
    assert.match(rep.stopReason, /Final acceptance gate failed/);
  });

  it('attempt 1 failure → repair cycle with AIDM-collected stderr tail in the Director prompt (not BLOCKED_ON_HUMAN)', async () => {
    setup(`# R\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n\n## Komutlar\n- \`node check.cjs\`\n`, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'] });
    agy.contentFor = (_r, _f, call) => (call >= 2 ? '// FIXED\n' : '// first try\n');
    const rep = (await run()).data as Any;
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(rep.tasks[0].status, 'ACCEPTED');
    assert.equal(rep.tasks[0].cycles, 2);
    const p = prompts(llm);
    assert.ok(p.some((x) => x.includes('MARKER_A_NOT_FIXED') && /Attempt 1\/3/.test(x)), 'failure tail fed back to the Director');
  });

  it('exhausted attempts without a decision channel → BLOCKED_ON_HUMAN; spec override honored; untracked files counted', async () => {
    setup(`# R\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\nDeneme: 2\n\n## Komutlar\n- \`node check.cjs\`\n`, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'] });
    const rep = (await run()).data as Any;
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN', why(rep));
    assert.equal(rep.tasks[0].cycles, 2);
    assert.equal(agy.calls, 2);
    assert.ok(rep.tasks[0].filesChanged.includes('src/a.js'), JSON.stringify(rep.tasks[0]));
    assert.match(rep.stopReason, /2 attempt/);
    assert.equal(rep.decisions.length, 0);
  });

  it('assume mode never auto-retries past the budget; no decision is raised', async () => {
    setup(`# R\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n\n## Komutlar\n- \`node check.cjs\`\n`, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'] });
    let asked = 0;
    const rep = (await run([], { AIDM_DECISION_MODE: 'assume' }, { decisionResolver: { channel: 'OPERATOR_TTY', resolve: async () => (asked++, { status: 'UNAVAILABLE', reason: 'x' }) } })).data as Any;
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN', why(rep));
    assert.equal(agy.calls, 3);
    assert.equal(asked, 0);
    assert.match(rep.stopReason, /assume/);
  });

  const exhaustedSpec = `# R\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\nDeneme: 1\n\n### B\n\`src/b.js\`\nDeneme: 1\n\n## Komutlar\n- \`node check.cjs\`\n`;
  const answering = (answer: Record<string, unknown>, seen: Any[]) => ({
    channel: 'OPERATOR_TTY',
    resolve: async (rec: Any) => {
      seen.push(rec);
      return { status: 'ANSWERED', answer: { ...answer, actor: 'po', source: 'OPERATOR_TTY', answeredAt: new Date().toISOString() } };
    },
  });

  it('exhausted → system decision; retry_2 grants exactly +2 attempts with PO free text; budget unchanged', async () => {
    setup(exhaustedSpec, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'], 'TASK-002': ['src/b.js'] });
    const seen: Any[] = [];
    // Attempt 1 fails → decision retry_2 → attempt 2 (first granted extra attempt) is FIXED.
    // Counted per task: tasks run strictly serially, nothing else runs while the decision is pending.
    let task1Calls = 0;
    agy.contentFor = (req) => (req.taskId === 'TASK-001' && ++task1Calls >= 2 ? '// FIXED\n' : `// ${req.taskId}\n`);
    const rep = (await run([], {}, { decisionResolver: answering({ selectedOptionId: 'retry_2', freeText: 'PO_HINT_42 ekle' }, seen) })).data as Any;
    assert.equal(rep.status, 'COMPLETED', why(rep));
    const rec = seen[0];
    assert.deepEqual(rec.options.map((o: Any) => o.id), ['retry_2', 'skip', 'stop']);
    assert.deepEqual(rec.options.map((o: Any) => o.label), ['Bu göreve 2 deneme daha ver', 'Görevi atla (bağımlı görevler de atlanır)', 'Çalışmayı durdur']);
    assert.equal(rec.allowFreeText, true);
    assert.equal(rec.recommendedOptionId, 'retry_2');
    assert.equal(rec.taskId, 'TASK-001');
    assert.match(rec.question, /TASK-001.*1 denemede.*MARKER_A_NOT_FIXED/s);
    assert.ok(!/sk-|Bearer/.test(rec.question));
    assert.equal(rep.tasks[0].cycles, 2, 'attempt 2 = first granted extra attempt');
    assert.ok(prompts(llm).some((p) => p.includes('PO_HINT_42')), 'free text reaches the Director');
    assert.equal(rep.budget.limitUsd, 1, 'budget cap never raised');
  });

  it('exhausted → skip skips the task (dependents too) and independent tasks still run; stop → STOPPED', async () => {
    setup(exhaustedSpec, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'], 'TASK-002': ['src/b.js'] });
    const seen: Any[] = [];
    let rep = (await run([], {}, { decisionResolver: answering({ selectedOptionId: 'skip' }, seen) })).data as Any;
    assert.ok(['PARTIAL', 'COMPLETED'].includes(rep.status) && rep.status !== 'COMPLETED', why(rep));
    assert.equal(rep.tasks.find((t: Any) => t.taskId === 'TASK-001').status, 'SKIPPED');
    assert.ok(rep.skippedByPo.includes('TASK-001'));
    // TASK-002 also fails verification here (check.cjs only checks a.js) → its own decision → skip as well.
    assert.ok(agy.requestsSeen.some((q) => q.taskId === 'TASK-002'), 'independent task still ran');
    fs.rmSync(dir, { recursive: true, force: true });

    setup(exhaustedSpec, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'], 'TASK-002': ['src/b.js'] });
    rep = (await run([], {}, { decisionResolver: answering({ selectedOptionId: 'stop' }, []) })).data as Any;
    assert.equal(rep.status, 'STOPPED', why(rep));
  });

  it('exhausted → free text only grants nothing; resolver EXPIRED → BLOCKED_ON_HUMAN', async () => {
    setup(exhaustedSpec, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'] });
    let rep = (await run([], {}, { decisionResolver: answering({ freeText: 'bilmiyorum' }, []) })).data as Any;
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN', why(rep));
    fs.rmSync(dir, { recursive: true, force: true });
    setup(exhaustedSpec, { 'check.cjs': CHECK_A }, { 'TASK-001': ['src/a.js'] });
    rep = (await run([], {}, { decisionResolver: { channel: 'EXTERNAL_IDP', resolve: async () => ({ status: 'EXPIRED', reason: 'süre doldu' }) } })).data as Any;
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN', why(rep));
    assert.equal(agy.requestsSeen.filter((q) => q.taskId === 'TASK-001').length, 1, 'no auto-retry');
  });
});

describe('project root defaults to the spec folder', { concurrency: 1, timeout: 120_000 }, () => {
  it('CLI: no -C → spec folder (previously cwd); explicit -C wins', () => {
    const ctx = { projectRoot: '/w', cwd: '/w', json: true, verbose: false };
    const a = parseRunSpecArgs({ spec: 'sub/dir/proje.md' }, ctx) as Any;
    assert.equal(a.options.projectRoot, path.resolve('/w/sub/dir'));
    const b = parseRunSpecArgs({ spec: 'sub/dir/proje.md' }, { ...ctx, projectRoot: '/other', explicitRoot: true }) as Any;
    assert.equal(b.options.projectRoot, '/other');
  });

  it('CLI + MCP dry run without a target use the spec folder', async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-root-'));
    const proj = path.join(outer, 'proj');
    fs.mkdirSync(proj);
    initTestRepo(proj);
    fs.writeFileSync(path.join(proj, 'proje.md'), `# P\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n`, 'utf8');
    try {
      const r = await executeCli(['run', '--spec', 'proj/proje.md', '--dry-run', '--json'], { cwd: outer, env: {}, stdout: () => {}, stderr: () => {} });
      assert.equal((r.data as Any).projectRoot, proj, 'project root = folder of the spec');
      const start = createAutonomousStartHandler({ env: {} } as never);
      const m = parse(await start({ specPath: path.join(proj, 'proje.md'), dryRun: true }, {} as never));
      assert.equal(m.report?.projectRoot ?? m.projectRoot, proj, JSON.stringify(m).slice(0, 500));
      assert.ok(!fs.existsSync(path.join(outer, '.ai-manager')));
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it('the executor may not modify the spec: restored, BLOCKED_ON_HUMAN', async () => {
    const dir = gitRepo('aidm-specguard-');
    fs.mkdirSync(path.join(dir, 'docs'));
    const spec = `# P\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\n`;
    fs.writeFileSync(path.join(dir, 'docs', 'proje.md'), spec, 'utf8');
    const llm = new MockDirectorLlm();
    llm.script = ({ taskId }) => ({ actionType: 'IMPLEMENT_TASK', rationale: 'x', taskId, objective: 'o', targetFiles: ['src/a.js'], implementationScope: 'src/', acceptanceCriteria: ['ok'], constraints: ['root'] });
    const agy = new MockAgyExecutor(dir);
    agy.onExecute = () => fs.writeFileSync(path.join(dir, 'docs', 'proje.md'), spec + '\n- Deneme: 10\n', 'utf8');
    try {
      const r = await executeCli(['run', '--spec', 'docs/proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
        cwd: dir,
        env: {},
        stdout: () => {},
        stderr: () => {},
        executorPort: agy,
        autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
      });
      const rep = r.data as Any;
      assert.equal(rep.status, 'BLOCKED_ON_HUMAN', rep.stopReason);
      assert.match(rep.stopReason, /Spec file/);
      assert.equal(fs.readFileSync(path.join(dir, 'docs', 'proje.md'), 'utf8'), spec, 'spec restored');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live-run fixes with the external IdP', { concurrency: 1, timeout: 600_000 }, () => {
  let idp: FakeIdp;
  let dir: string;
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;
  before(async () => {
    idp = new FakeIdp();
    await idp.start();
  });
  after(async () => idp.stop());
  beforeEach(() => {
    dir = gitRepo('aidm-fix-idp-', { 'check.cjs': CHECK_A });
    fs.writeFileSync(path.join(dir, 'proje.md'), `# R\n\nx.\n\n## Gereksinimler\n\n### A\n\`src/a.js\`\nDeneme: 1\n\n## Komutlar\n- \`node check.cjs\`\n`, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    llm.script = ({ taskId }) => ({ actionType: 'IMPLEMENT_TASK', rationale: 'x', taskId, objective: 'o', targetFiles: ['src/a.js'], implementationScope: 'src/', acceptanceCriteria: ['ok'], constraints: ['root'] });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deps = (env: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    llmProvider: llm,
    allowMockProvider: true,
    identityManager: new InMemoryIdentityManager({ baseDir: dir }),
    registerBudgetTerms: pricing,
    executorPort: agy,
    env,
    foregroundResume: true,
    ...extra,
  });

  it('provider preflight runs BEFORE the IdP approval request (no key → CONFIGURATION_ERROR, nothing posted)', async () => {
    const before = idp.approvals.size;
    const env = idp.env({ AIDM_LLM_PROVIDER: 'openai' });
    const pf = preflightLlmProvider(env);
    assert.equal(pf.ok, false);
    const start = createAutonomousStartHandler({ ...deps(env), llmProvider: undefined, allowMockProvider: false } as never);
    const r = parse(await start({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, {} as never));
    assert.equal(r.code, 'CONFIGURATION_ERROR', JSON.stringify(r));
    assert.equal(idp.approvals.size, before, 'no approval request created');
    assert.ok(!fs.existsSync(path.join(dir, '.ai-manager', 'state', 'mandates')), 'nothing sealed');
    const ok = preflightLlmProvider({ AIDM_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'x'.repeat(20), AIDM_LLM_INPUT_USD_PER_MTOK: '1', AIDM_LLM_OUTPUT_USD_PER_MTOK: '2' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  it('exhausted decision via the verified IdP path: forged answer ignored, valid retry_2 accepted; expiry → BLOCKED_ON_HUMAN', async () => {
    const env = idp.env();
    const provider = createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) });
    agy.contentFor = (_r, _f, call) => (call >= 2 ? '// FIXED\n' : '// nope\n');
    let polls = 0;
    idp.onDecisionPoll = (id) => {
      const e = idp.decisions.get(id)!;
      polls++;
      if (polls === 1) e.st = { status: 'ANSWERED', token: idp.decisionToken(id, { selectedOptionId: 'retry_2' }, { contextFingerprint: '0'.repeat(64) }) };
      else idp.answer(id, { selectedOptionId: 'retry_2' });
    };
    const start = createAutonomousStartHandler(deps(env) as never);
    const s = parse(await start({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, {} as never));
    idp.approve(s.requestId);
    const r = parse(await createAutonomousResumeHandler(deps(env, { decisionResolver: new IdpDecisionResolver({ env, provider, pollIntervalMs: 10 }) }) as never)({ workspaceRoot: dir, requestId: s.requestId }, {} as never));
    idp.onDecisionPoll = undefined;
    assert.equal(r.code, 'COMPLETED', `${r.report?.stopReason} ${JSON.stringify(r.report?.decisions)}`);
    const body = [...idp.decisions.values()].at(-1)!.body;
    assert.equal(body.operation, 'AUTONOMOUS_DECISION');
    assert.deepEqual((body.options as Any[]).map((o) => o.id), ['retry_2', 'skip', 'stop']);
    assert.ok(polls >= 2, 'forged answer was not accepted');
    assert.equal(r.report.tasks[0].cycles, 2);
  });

  it('exhausted decision expiry at the IdP → BLOCKED_ON_HUMAN', async () => {
    const env = idp.env();
    const provider = createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) });
    idp.onDecisionPoll = (id) => {
      idp.decisions.get(id)!.st = { status: 'EXPIRED' };
    };
    const start = createAutonomousStartHandler(deps(env) as never);
    const s = parse(await start({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, {} as never));
    idp.approve(s.requestId);
    const r = parse(await createAutonomousResumeHandler(deps(env, { decisionResolver: new IdpDecisionResolver({ env, provider, pollIntervalMs: 10 }) }) as never)({ workspaceRoot: dir, requestId: s.requestId }, {} as never));
    idp.onDecisionPoll = undefined;
    assert.equal(r.report.status, 'BLOCKED_ON_HUMAN', r.report?.stopReason);
    assert.equal(agy.calls, 1);
  });
});
