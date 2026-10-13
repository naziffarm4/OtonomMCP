/** Approach plan, progress notes, preference memory, self-check, stable prompt prefix, parallel gate. Offline (mock LLM, simulated IDE). */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import { AntigravityAdapter, createIdeRequestInvoker, IDE_EXECUTOR_ID, ideNextTask, ideSubmit, ideAwaitVerdict } from '../dist/executor-bridge/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import {
  progressEvery, normalizeApproachPlan, planQuestion, learnPreferences, syncPreferences, parseSelfCheck, preferencesPath, PLAN_QUESTION_ID,
} from '../dist/autonomous/director-extras.js';
import { DirectorPromptBuilder } from '../dist/director/director-prompt-builder.js';
import { InMemoryIdentityManager, MockDirectorLlm } from './helpers/autonomous-test-doubles.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('director improvements (units)', () => {
  it('progress note frequency: spec line, env, default 3, off', () => {
    assert.equal(progressEvery('# x\n'), 3);
    assert.equal(progressEvery('- **İlerleme notu:** 2\n'), 2);
    assert.equal(progressEvery('İlerleme notu: kapalı\n'), 0);
    assert.equal(progressEvery('', { AIDM_PROGRESS_NOTE_EVERY: '5' }), 5);
  });

  it('plan becomes one IdP item (≤1000 char texts); self-check parsing never blocks on garbage', () => {
    const p = normalizeApproachPlan({ approach: 'Önce menü, sonra sayfalar.', risks: ['Renk uyumu'], order: ['TASK-001: menü'], assumedFromPreferences: ['Pembe yok'] })!;
    const q = planQuestion(p);
    assert.equal(q.id, PLAN_QUESTION_ID);
    assert.ok(q.options.every((o: Any) => !o.description || o.description.length <= 1000));
    assert.match(q.reason, /Önceki tercihlerinizden varsaydıklarım: Pembe yok/);
    assert.equal(normalizeApproachPlan({}), null);
    assert.deepEqual(parseSelfCheck(null), { ok: true, doubts: [] });
    assert.equal(parseSelfCheck({ ok: false, doubts: [] }).ok, true, 'no concrete doubt -> pass');
    assert.equal(parseSelfCheck({ ok: false, doubts: ['menü eksik'] }).ok, false);
  });

  it('preferences: learned from PO answers (not the plan), local file + IdP sync honours deletions', async () => {
    const dir = tmp('aidm-pref-');
    const file = path.join(dir, 'p.json');
    const env = { AIDM_PREFERENCES_PATH: file, AIDM_IDP_URL: 'http://127.0.0.1:9', AIDM_IDP_CLIENT_TOKEN: 'tok-123456789012345' };
    assert.equal(preferencesPath({}), null, 'no home, no path -> disabled');
    const qs: Any[] = [
      { id: 'renk', kind: 'CLARIFICATION', question: 'Renkler nasıl olsun?', reason: '', options: [{ id: 'a', label: 'Sıcak tonlar', criteria: [], appliesTo: [], checks: [], newTasks: [] }, { id: 'b', label: 'Pembe', criteria: [], appliesTo: [], checks: [], newTasks: [] }], recommendedOptionId: 'a', allowFreeText: true },
      planQuestion(normalizeApproachPlan({ approach: 'x' })!),
    ];
    const learned = learnPreferences(qs, [{ questionId: 'renk', selectedOptionId: 'a', freeText: 'pembe asla' }, { questionId: PLAN_QUESTION_ID, selectedOptionId: 'onay' }], 'kuafor');
    assert.equal(learned.length, 1);
    assert.match(learned[0].text, /Sıcak tonlar.*pembe asla/);
    const calls: Any[] = [];
    let remote: Any = { items: [{ id: 'u-1', topic: 'Yazı', text: 'Büyük', source: 'ui', project: null, updatedAt: new Date().toISOString() }], deletedIds: ['clar-old'] };
    const fetchFn = (async (url: string, init: Any) => {
      calls.push({ url, method: init.method, body: init.body });
      if (init.method === 'GET') return new Response(JSON.stringify(remote), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as Any;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, items: [{ id: 'clar-old', topic: 'eski', text: 'silinmiş', source: 'clarification', updatedAt: '' }], deletedIds: [] }));
    const merged = await syncPreferences(env, fetchFn, learned);
    assert.deepEqual(merged.items.map((i) => i.id).sort(), ['u-1', learned[0].id].sort());
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'new local item pushed');
    assert.deepEqual(JSON.parse(put.body).items.map((i: Any) => i.id), [learned[0].id]);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).deletedIds.includes('clar-old'));
    remote = null;
  });

  it('stable run context comes first in the Director prompt and is not cut to the field limit', () => {
    const b = new DirectorPromptBuilder();
    (b as Any).serializeContextSnapshot = () => '{}';
    const long = `KURAL ${'x'.repeat(5000)} SON`;
    const u = b.buildUserPrompt({ logicalFingerprint: 'fp', sections: {} } as Any, { projectId: 'p', directorSessionId: 's', trigger: 'TASK_READY', objective: 'görev', stableContext: long } as Any);
    assert.ok(u.startsWith('=== RUN CONTEXT'));
    assert.ok(u.includes(' SON'));
  });
});

const SPEC = `# Üç Dosya

Küçük kütüphane.

- **Yürütücü:** ide
- **İlerleme notu:** 2

## Gereksinimler

### A
\`src/a.js\` içinde a.

### B
\`src/b.js\` içinde b.

### C
\`src/c.js\` içinde c.
`;

describe('director improvements (end to end)', { timeout: 300_000 }, () => {
  it('plan approved+corrected in one round, preferences used and learned, self-check repair, progress note, stable prefix', async () => {
    const dir = tmp('aidm-dirimp-');
    const home = tmp('aidm-home-');
    const prefFile = path.join(home, 'preferences.json');
    fs.writeFileSync(prefFile, JSON.stringify({ schemaVersion: 1, items: [{ id: 'clar-dil', topic: 'Kod dili', text: 'Açıklamalar Türkçe', source: 'clarification', updatedAt: '' }], deletedIds: [] }));
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.name', 't');
      git(dir, 'config', 'user.email', 't@e.x');
      git(dir, 'config', 'commit.gpgsign', 'false');
      git(dir, 'commit', '--allow-empty', '-qm', 'init');
      fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
      const FILES: Record<string, string> = { 'TASK-001': 'src/a.js', 'TASK-002': 'src/b.js', 'TASK-003': 'src/c.js' };
      const adapter = new AntigravityAdapter({ workspaceRoot: dir, executorId: IDE_EXECUTOR_ID, requestInvoker: createIdeRequestInvoker(dir, { pollMs: 10 }) });
      let stop = false;
      const writes: Record<string, number> = {};
      const ide = (async () => {
        while (!stop) {
          const n = ideNextTask(dir) as Any;
          if (n.state !== 'TASK') { await new Promise((r) => setTimeout(r, 20)); continue; }
          const f = FILES[n.task.taskId];
          writes[n.task.taskId] = (writes[n.task.taskId] ?? 0) + 1;
          fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
          fs.writeFileSync(path.join(dir, f), `// sürüm ${writes[n.task.taskId]}\nexport const v = ${writes[n.task.taskId]};\n`);
          ideSubmit(dir, n.task.seq, `${f} yazıldı`, [f]);
          const v = (await ideAwaitVerdict(dir, n.task.seq, 20_000, 20)) as Any;
          if (v.verdict === 'DONE') break;
        }
      })();
      const llm = new MockDirectorLlm();
      llm.script = ({ call, taskId }: Any) => ({ actionType: 'IMPLEMENT_TASK', rationale: 's', taskId, objective: `Implement ${taskId} (${call})`, targetFiles: [FILES[taskId]], implementationScope: 'src/' });
      let clarPrompt = '';
      llm.clarify = ({ prompt }: Any) => {
        clarPrompt = prompt;
        return { summary: 'Üç küçük dosya.', questions: [], plan: { approach: 'Önce a, sonra b, en son c dosyası.', risks: ['Dosya adları karışabilir'], order: ['TASK-001: a', 'TASK-002: b', 'TASK-003: c'], assumedFromPreferences: ['Açıklamalar Türkçe'] } };
      };
      let selfChecks = 0;
      llm.extra = ({ taskId }: Any) => {
        if (taskId !== 'SELF-CHECK') return undefined;
        selfChecks++;
        return selfChecks === 1 ? { ok: false, doubts: ['a.js içinde a dışa aktarılmıyor; export const a ekle'] } : { ok: true, doubts: [] };
      };
      const asked: Any[] = [];
      const clarificationResolver = {
        channel: 'EXTERNAL_IDP',
        resolve: async (req: Any) => {
          asked.push(req);
          return { status: 'ANSWERED', answers: [{ questionId: PLAN_QUESTION_ID, selectedOptionId: 'duzelt', freeText: 'c dosyasına kısa bir açıklama yorumu ekle' }], answeredBy: 'po', answeredAt: new Date().toISOString() };
        },
      };
      const out: string[] = [];
      const rep = ((await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
        cwd: dir, env: { AIDM_PREFERENCES_PATH: prefFile }, stdout: (t) => out.push(t), stderr: (t) => out.push(t), executorPort: adapter as Any,
        autonomous: {
          llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), clarificationResolver,
          registerBudgetTerms: (bm: BudgetManager) => bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n }),
        } as Any,
      })) as Any).data as Any;
      stop = true;
      await ide;
      const why = `${rep?.status}: ${rep?.stopReason}\n${JSON.stringify(rep?.tasks?.map((t: Any) => [t.taskId, t.status, t.cycles]))}\n${out.join('\n').slice(-1500)}`;
      assert.equal(rep.status, 'COMPLETED', why);
      // 1. plan in the same single IdP round, correction binding for the Director
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0].questions.map((q: Any) => q.id), [PLAN_QUESTION_ID]);
      assert.match(rep.approachPlan, /Önce a, sonra b/);
      // 3. memory: known preference given to the review; the correction is learned
      assert.match(clarPrompt, /KNOWN USER PREFERENCES[\s\S]*Açıklamalar Türkçe/);
      assert.deepEqual(rep.preferencesUsed, ['clar-dil']);
      const saved = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
      assert.ok(saved.items.some((i: Any) => i.source === 'note' && /açıklama yorumu/.test(i.text)), JSON.stringify(saved));
      // 7. stable prefix: run context first, includes plan + correction + spec
      const dirReq = llm.requests.find((r: Any) => String(r.messages[1]?.content ?? '').includes('=== RUN CONTEXT')) as Any;
      assert.ok(dirReq, 'director prompt has the stable run context');
      const u = String(dirReq.messages[1].content);
      assert.ok(u.startsWith('=== RUN CONTEXT'));
      assert.match(u, /APPROVED APPROACH PLAN[\s\S]*Önce a/);
      assert.match(u, /açıklama yorumu/);
      assert.ok(rep.promptCache.calls > 3);
      // 4. self-check: first acceptance of TASK-001 repaired once
      assert.equal(rep.selfChecks[0].taskId, 'TASK-001');
      assert.equal(rep.selfChecks[0].ok, false);
      assert.equal(writes['TASK-001'], 2, 'TASK-001 re-done after the self-check');
      assert.equal(rep.tasks.find((t: Any) => t.taskId === 'TASK-001').status, 'ACCEPTED');
      // 2. one progress note after 2 accepted tasks (TASK-003 still pending)
      assert.equal(rep.progressNotes?.length, 1, why);
      assert.match(rep.progressNotes[0], /Ne oldu:[\s\S]*Sıradaki:/);
      const md = fs.readFileSync(rep.completionReportPath, 'utf8');
      assert.match(md, /Yaklaşım planı[\s\S]*Director öz kontrolü[\s\S]*İlerleme notları/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('parallel final checks', () => {
  it('gate commands run concurrently, keep their order, and report each completion', async () => {
    const { runGateCommands } = await import('../dist/autonomous/autonomous-runner.js');
    const slow = (ms: number, code: number) => `node -e "setTimeout(()=>process.exit(${code}),${ms})"`;
    const done: string[] = [];
    const t0 = Date.now();
    const res = await runGateCommands(os.tmpdir(), [slow(900, 0), slow(900, 1), slow(100, 0)], { onDone: (c: string) => done.push(c) });
    const ms = Date.now() - t0;
    assert.ok(ms < 1700, `parallel (${ms} ms)`);
    assert.deepEqual(res.map((r: Any) => r.exitCode), [0, 1, 0]);
    assert.equal(done[0], slow(100, 0), 'fast check reported first');
    const seq = Date.now();
    await runGateCommands(os.tmpdir(), [slow(400, 0), slow(400, 0)], { parallel: false });
    assert.ok(Date.now() - seq >= 790);
  });
});
