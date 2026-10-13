/** IDE pull mode, cli-session reuse, EXECUTION_UNKNOWN decision. Offline (mock LLM). */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import {
  AntigravityAdapter, createIdeRequestInvoker, IDE_EXECUTOR_ID, resolveExecutorMode, ideNextTask, ideSubmit, ideVerdict, ideAwaitVerdict,
  noteIdeEvent, readAgySession, writeAgySession, createTimeoutRawOutcome,
} from '../dist/executor-bridge/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { isVerificationOnlyTask } from '../dist/autonomous/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
const LIB = `# Lib\n\nKüçük kütüphane.\n\nNetleştirme: kapalı\n\n## Gereksinimler\n\n### A\n\`src/a.js\` içinde a.\n`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-ide-'));

describe('executor modes', { concurrency: 1, timeout: 600_000 }, () => {
  let dir = '';
  let out: string[] = [];
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
  const setup = (spec = LIB) => {
    dir = tmp();
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'user.email', 't@e.x');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'commit', '--allow-empty', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'proje.md'), spec, 'utf8');
    out = [];
  };
  const run = async (executorPort: Any, extra: Record<string, unknown> = {}, llm = new MockDirectorLlm()) =>
    ((await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
      cwd: dir, env: {}, stdout: (t) => out.push(t), stderr: (t) => out.push(t), executorPort,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing, ...extra },
    })) as Any).data as Any;
  const why = (rep: Any) => `${rep?.status}: ${rep?.stopReason}\n${JSON.stringify(rep?.tasks)}\n${out.join('\n').slice(-1500)}`;

  it('spec line / env select the mode; ide is the default', () => {
    assert.equal(resolveExecutorMode('# x\n'), 'ide');
    assert.equal(resolveExecutorMode('Yürütücü: cli\n'), 'cli');
    assert.equal(resolveExecutorMode('- **Yürütücü:** cli-oturum\n'), 'cli-session');
    assert.equal(resolveExecutorMode('Yürütücü: ide\n', { AIDM_EXECUTOR_MODE: 'cli' }), 'ide', 'spec wins');
    assert.equal(resolveExecutorMode('', { AIDM_EXECUTOR_MODE: 'cli' }), 'cli');
  });

  it('mailbox: next -> submit -> verdict (REPAIR same task, ACCEPTED next task, WAIT decision, DONE)', async () => {
    dir = tmp();
    const ac = new AbortController();
    const inv = createIdeRequestInvoker(dir, { pollMs: 10 });
    const req = (taskId: string) => [{ structuredPrompt: `do ${taskId}`, correlationId: 'c' } as Any, { taskId } as Any, { signal: ac.signal, timeoutMs: 1000 }] as const;
    assert.equal(ideNextTask(dir).state, 'NONE');
    const p1 = inv(...req('TASK-001'));
    await new Promise((r) => setTimeout(r, 30));
    const n1 = ideNextTask(dir) as Any;
    assert.equal(n1.state, 'TASK');
    assert.match(n1.text, /TASK-001[\s\S]*agy çalıştırma[\s\S]*do TASK-001/);
    assert.equal(ideSubmit(dir, 99, 'x').ok, false, 'wrong seq refused');
    assert.ok(ideSubmit(dir, n1.task.seq, 'yaptım', ['src/a.js']).ok);
    const r1 = (await p1) as Any;
    assert.equal(r1.exit_code, 0);
    assert.deepEqual(JSON.parse(r1.stdout).unverified_changed_files, ['src/a.js']);
    assert.equal(ideVerdict(dir, n1.task.seq).verdict, 'PENDING');
    noteIdeEvent(dir, { type: 'VERIFICATION', message: 'src/a.js eksik', taskId: 'TASK-001', level: 'warn' });
    const p2 = inv(...req('TASK-001'));
    await new Promise((r) => setTimeout(r, 30));
    const v1 = ideVerdict(dir, n1.task.seq) as Any;
    assert.equal(v1.verdict, 'REPAIR');
    assert.match(v1.message, /src\/a\.js eksik/);
    ideSubmit(dir, v1.next.seq, 'düzelttim');
    await p2;
    noteIdeEvent(dir, { type: 'TASK_ACCEPTED', message: 'ok', taskId: 'TASK-001', level: 'info' });
    const p3 = inv(...req('TASK-002'));
    const v2 = (await ideAwaitVerdict(dir, v1.next.seq, 2000, 10)) as Any;
    assert.equal(v2.verdict, 'ACCEPTED');
    assert.equal(v2.next.taskId, 'TASK-002');
    ideSubmit(dir, v2.next.seq, 'bitti');
    await p3;
    noteIdeEvent(dir, { type: 'DECISION_REQUESTED', message: 'Kapsam genişlesin mi?', taskId: 'TASK-002', level: 'warn' });
    assert.equal(ideVerdict(dir, v2.next.seq).verdict, 'WAIT');
    noteIdeEvent(dir, { type: 'RUN_FINISHED', message: 'COMPLETED', taskId: null, level: 'info' });
    assert.equal(ideVerdict(dir, v2.next.seq).verdict, 'DONE');
    // IDE disappears: the invoker gives up when the adapter's deadline aborts it.
    const p4 = inv(...req('TASK-003'));
    ac.abort();
    assert.equal(((await p4) as Any).exit_code, 1);
  });

  it('ide mode end to end: Director verifies the IDE work independently; an empty claim is repaired', async () => {
    setup();
    const adapter = new AntigravityAdapter({ workspaceRoot: dir, executorId: IDE_EXECUTOR_ID, requestInvoker: createIdeRequestInvoker(dir, { pollMs: 10 }) });
    const verdicts: string[] = [];
    let stop = false;
    const ide = (async () => {
      let submits = 0;
      while (!stop) {
        const n = ideNextTask(dir) as Any;
        if (n.state !== 'TASK') { await new Promise((r) => setTimeout(r, 20)); continue; }
        submits++;
        if (submits > 1) { fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n'); }
        ideSubmit(dir, n.task.seq, submits > 1 ? 'a.js yazıldı' : 'yaptım (aslında yapmadım)', ['src/a.js']);
        const v = (await ideAwaitVerdict(dir, n.task.seq, 20_000, 20)) as Any;
        verdicts.push(v.verdict);
        if (v.verdict === 'DONE') break;
      }
    })();
    const llm = new MockDirectorLlm();
    // a real Director re-instructs differently after a rejection (new request, not an idempotent replay)
    llm.script = ({ call, taskId }: Any) => ({ actionType: 'IMPLEMENT_TASK', rationale: 's', taskId, objective: `Implement ${taskId} (deneme ${call})`, targetFiles: ['src/a.js'], implementationScope: 'src/' });
    const rep = await run(adapter, {}, llm);
    stop = true;
    await ide;
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(rep.executorMode, 'ide');
    assert.equal(verdicts[0], 'REPAIR', `claim without work is not trusted: ${verdicts}`);
    assert.ok(git(dir, 'ls-files').includes('src/a.js'));
  });

  it('cli-session: agy conversation id is saved and reused via --conversation', () => {
    dir = tmp();
    const f = path.join(dir, 'agy-session.json');
    assert.equal(readAgySession(f), null);
    writeAgySession(f, 'bad id; rm -rf');
    assert.equal(readAgySession(f), null, 'unsafe ids are never stored');
    writeAgySession(f, 'conv-123');
    assert.equal(readAgySession(f), 'conv-123');
    const a = new AntigravityAdapter({ workspaceRoot: dir, sessionFile: f });
    const args = a.translateExecutionRequest({ projectId: 'p', requestId: 'r', taskId: 't', instruction: { objective: 'o', targetFiles: [], acceptanceCriteria: [], constraints: [] }, executionLimits: { timeoutMs: 1000 }, expectedRepositoryState: { baseCommit: 'abc', branch: 'main' }, metadata: {} } as Any).args;
    assert.deepEqual(args.slice(args.indexOf('--conversation'), args.indexOf('--conversation') + 2), ['--conversation', 'conv-123']);
  });

  it('EXECUTION_UNKNOWN with leftovers -> Turkish 3-option decision; stop -> STOPPED; no channel -> resumable BLOCKED', async () => {
    for (const answer of ['stop', null] as const) {
      setup();
      const agy = new MockAgyExecutor(dir);
      const timeout = { execute: async (req: Any) => {
        await agy.execute(req); // leaves src/a.js behind
        const now = new Date().toISOString();
        return createTimeoutRawOutcome({ request: req, executorIdentity: { provider: 'antigravity', name: 'mock', version: '1' } as Any, startedAt: now, completedAt: now, durationMs: 1 });
      }, executorId: 'mock-timeout', provider: 'antigravity', supportedOperations: ['IMPLEMENT_TASK'], checkAvailability: async () => ({ available: true }) };
      const seen: Any[] = [];
      const extra = answer
        ? { decisionResolver: { channel: 'OPERATOR_TTY', resolve: async (rec: Any) => (seen.push(rec), { status: 'ANSWERED', answer: { selectedOptionId: answer, actor: 'po', source: 'OPERATOR_TTY', answeredAt: new Date().toISOString() } }) } }
        : { decisionResolver: null };
      const rep = await run(timeout, extra);
      if (answer) {
        assert.equal(rep.status, 'STOPPED', why(rep));
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].options.map((o: Any) => o.id), ['retry', 'verify', 'stop']);
        assert.match(seen[0].question, /[çğıöşü]/, 'Turkish question');
      } else {
        assert.equal(rep.status, 'BLOCKED_ON_HUMAN', why(rep));
        assert.match(rep.stopReason, /[çğıöşü]/);
        assert.match(rep.stopReason, /\(.*EXECUTION_UNKNOWN|devam/);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('verification-only task: no file change -> re-run as read-only verification -> accepted; a normal task is not', async () => {
    const AUDIT = `# Site\n\nKüçük site.\n\nNetleştirme: kapalı\n\n## Gereksinimler\n\n### Denetim\n\`src/a.js\` için Lighthouse ile doğrula, konsolda hata olmasın.\n`;
    setup(AUDIT);
    fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'a');
    const agy = new MockAgyExecutor(dir);
    agy.claimOnly = true;
    agy.stdoutFor = () => 'FINDINGS: Lighthouse 98, konsol hatası yok';
    const rep = await run(agy);
    const cons = agy.requestsSeen.map((r: Any) => JSON.stringify(r.instruction?.constraints ?? []));
    assert.ok(cons.some((c) => /verification only/.test(c)), JSON.stringify(cons) + why(rep));
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(isVerificationOnlyTask({ title: 'A', description: '`src/a.js` içinde a.' }), false, 'implementation tasks never become read-only');
  });

  it('spec review: truncated JSON is retried once with a larger token limit', async () => {
    setup(LIB.replace('Netleştirme: kapalı\n', ''));
    const llm = new MockDirectorLlm();
    llm.clarify = ({ call }) => {
      if (call === 1) throw new Error('[ERR_STRUCTURED_OUTPUT_VALIDATION] Failed to parse structured output as valid JSON: Unexpected end of JSON input');
      return { summary: 'Plan açık.', questions: [] };
    };
    const rep = await run(new MockAgyExecutor(dir), {}, llm);
    assert.equal(llm.clarifyRequests.length, 2);
    assert.equal((llm.clarifyRequests[1] as Any).max_tokens, 16000);
    assert.notEqual(rep.clarification.status, 'FAILED', why(rep));
  });
});
