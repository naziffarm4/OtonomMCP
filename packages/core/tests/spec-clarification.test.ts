/**
 * Spec clarification ("Netleştirme"): before any implementation the Director reviews the whole plan,
 * asks the PO (IdP only, ONE SPEC_CLARIFICATION package, Turkish text) and proposes improvements;
 * answers become per-task acceptance criteria, a generated check script on the final gate and
 * optional new tasks. Offline (mock LLM, mock AGY, fake IdP).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { createAutonomousStartHandler, createAutonomousResumeHandler } from '../dist/mcp/index.js';
import { executeCli } from '../dist/cli/index.js';
import {
  SpecIngestor,
  IdpClarificationResolver,
  parseClarificationSetting,
  looksTurkish,
  normalizeClarificationProposal,
  partitionTurkish,
  validateClarificationAnswers,
  renderChecksScript,
  CHECKS_SCRIPT_PATH,
} from '../dist/autonomous/index.js';
import { NonceStore, createTrustedIdentityProvider } from '../dist/authorization/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';
import { FakeIdp } from './helpers/fake-idp.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const SPEC = `# Mini Site\n\nKüçük bir site.\n\n## Gereksinimler\n\n### Toplama\n\`src/add.js\` içinde add fonksiyonu.\n\n### Çarpma\n\`src/mul.js\` içinde mul fonksiyonu.\n`;
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
const parse = (r: Any) => JSON.parse(r.content[0].text);
const ctx = {} as never;

const REVIEW = {
  summary: 'İki küçük modül yazılacak; ortak bir dışa aktarım biçimi netleşmeli.',
  questions: [
    {
      id: 'export', kind: 'CLARIFICATION', question: 'Modüller hangi biçimde dışa aktarılsın?', reason: 'Spec bunu belirtmiyor; yanlış seçim sonradan her dosyayı değiştirmeyi gerektirir.',
      recommendedOptionId: 'esm', allowFreeText: true,
      options: [
        { id: 'esm', label: 'Modern (export) biçimi', description: 'Her dosya export ile dışa aktarır', criteria: ['Her src/*.js dosyası export içerir'],
          checks: [{ type: 'each_file_contains', glob: 'src/*.js', pattern: 'export', description: 'Her modül export içerir' }, { type: 'glob_count', glob: 'src/*.js', min: 2, description: 'En az iki modül var' }] },
        { id: 'cjs', label: 'Eski (module.exports) biçimi', criteria: ['Her src/*.js dosyası module.exports içerir'],
          checks: [{ type: 'each_file_contains', glob: 'src/*.js', pattern: 'module.exports', description: 'module.exports var' }] },
      ],
    },
    {
      id: 'readme', kind: 'IMPROVEMENT', question: 'Kısa bir kullanım notu (README) da ekleyelim mi?', reason: 'Projeyi sonra açan kişinin işini kolaylaştırır.',
      recommendedOptionId: 'evet', allowFreeText: false,
      options: [
        { id: 'evet', label: 'Evet, ekle', newTasks: [{ title: 'Kullanım notu ekle', description: 'src/README.md dosyasına iki fonksiyonun kısa kullanımını yaz.', targetFiles: ['src/README.md'], criteria: ['src/README.md var'] }],
          checks: [{ type: 'file_exists', path: 'src/README.md', description: 'Kullanım notu var' }] },
        { id: 'hayir', label: 'Hayır, spec\'teki gibi kalsın' },
      ],
    },
  ],
};

describe('spec clarification: units', () => {
  it('Netleştirme setting + ingestor default on; line is not a criterion', () => {
    assert.equal(parseClarificationSetting('açık'), true);
    assert.equal(parseClarificationSetting('KAPALI'), false);
    assert.equal(parseClarificationSetting('kapali'), false);
    assert.equal(parseClarificationSetting('belki'), undefined);
    const ing = (s: string) => new SpecIngestor().ingest(s, { projectId: 'p' });
    assert.equal(ing(SPEC).clarification, true);
    const off = ing(SPEC.replace('Küçük bir site.', 'Küçük bir site.\n\n- Netlestirme: kapalı'));
    assert.equal(off.clarification, false);
    assert.ok(!JSON.stringify(off.requirements).includes('Netle'));
  });

  it('normalization bounds options/checks; non-Turkish questions are separated', () => {
    const p = normalizeClarificationProposal(
      {
        questions: [
          REVIEW.questions[0],
          { question: 'Which framework?', reason: 'Not specified', options: [{ label: 'React' }, { label: 'Vue' }] },
          { question: 'Tek seçenekli soru mu?', options: [{ label: 'Evet' }] },
          { question: 'Kötü kontrol olur mu?', reason: 'Deneme için', options: [{ label: 'Evet', checks: [{ type: 'file_exists', path: '../x' }, { type: 'file_contains', path: 'a', pattern: '(', regex: true }, { type: 'rm -rf' }] }, { label: 'Hayır' }] },
        ],
      },
      ['TASK-001']
    );
    assert.equal(p.questions.length, 3);
    assert.ok(p.warnings.some((w) => w.includes('en az 2')));
    assert.equal(p.questions[2].options[0].checks.length, 0, 'unsafe path / bad regex / unknown type dropped');
    const { ok, bad } = partitionTurkish(p);
    assert.deepEqual(bad.map((q) => q.question), ['Which framework?']);
    assert.equal(ok.length, 2);
    assert.equal(looksTurkish('Hangi biçim?'), true);
    assert.equal(looksTurkish(''), false);
  });

  it('answers claim: every question answered with valid ids', () => {
    const req = { questions: normalizeClarificationProposal(REVIEW, []).questions };
    assert.ok(validateClarificationAnswers(req, [{ questionId: 'export', selectedOptionId: 'esm' }]).error);
    assert.ok(validateClarificationAnswers(req, [{ questionId: 'export', selectedOptionId: 'x' }, { questionId: 'readme', selectedOptionId: 'evet' }]).error);
    assert.ok(validateClarificationAnswers(req, [{ questionId: 'export', selectedOptionId: 'esm' }, { questionId: 'readme', freeText: 'x' }]).error, 'free text not allowed');
    assert.ok(validateClarificationAnswers(req, 'nope').error);
    const ok = validateClarificationAnswers(req, [{ questionId: 'readme', selectedOptionId: 'hayir' }, { questionId: 'export', freeText: 'ESM ama default export yok' }]);
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.answers!.map((a: Any) => a.questionId), ['export', 'readme']);
  });

  it('generated check script is dependency-free and evaluates the checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-chk-'));
    try {
      fs.mkdirSync(path.join(dir, 'pages', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pages', 'a.html'), '<div data-include="nav.html"></div>');
      fs.writeFileSync(path.join(dir, 'pages', 'sub', 'b.html'), 'no nav');
      fs.writeFileSync(path.join(dir, 'style.css'), 'x');
      const script = (checks: unknown[]) => {
        fs.mkdirSync(path.join(dir, 'scripts', 'aidm-checks'), { recursive: true });
        fs.writeFileSync(path.join(dir, CHECKS_SCRIPT_PATH), renderChecksScript(checks as never));
        try {
          return { code: 0, out: execFileSync(process.execPath, [CHECKS_SCRIPT_PATH], { cwd: dir, encoding: 'utf8' }) };
        } catch (e: Any) {
          return { code: e.status, out: String(e.stdout) };
        }
      };
      assert.equal(script([{ type: 'glob_count', glob: '**/*.css', max: 1, description: 'tek css' }, { type: 'file_exists', path: 'style.css', description: 'css var' }]).code, 0);
      const r = script([{ type: 'each_file_contains', glob: 'pages/**/*.html', pattern: 'nav.html', regex: false, description: 'her sayfa nav içerir' }]);
      assert.equal(r.code, 1);
      assert.match(r.out, /FAIL her sayfa nav içerir — eksik: pages\/sub\/b\.html/);
      assert.equal(script([{ type: 'no_file_contains', glob: '**/*.html', pattern: 'data-include="[a-z]+\\.html"', regex: true, description: 'include yok' }]).code, 1);
      assert.equal(script([{ type: 'each_file_contains', glob: 'none/*.html', pattern: 'x', regex: false, description: 'boş eşleşme FAIL' }]).code, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spec clarification: runs', { concurrency: 1, timeout: 600_000 }, () => {
  let idp: FakeIdp;
  let dir: string;
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;
  before(async () => {
    idp = new FakeIdp();
    await idp.start();
  });
  after(async () => idp.stop());
  const fresh = (spec = SPEC) => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-clar-'));
    for (const c of ['git init -b main', 'git config user.name t', 'git config user.email t@e.x', 'git config commit.gpgsign false', 'git commit --allow-empty -m init']) execSync(c, { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'proje.md'), spec, 'utf8');
    agy = new MockAgyExecutor(dir);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-clar-'));
    for (const c of ['git init -b main', 'git config user.name t', 'git config user.email t@e.x', 'git config commit.gpgsign false', 'git commit --allow-empty -m init']) execSync(c, { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    agy.contentFor = (_req, file) => (file.endsWith('.md') ? '# Kullanım\n' : `export const f = 1;\n`);
  });
  afterEach(() => {
    idp.onDecisionPoll = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deps = (env: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing,
    executorPort: agy, env, foregroundResume: true, ...extra,
  });
  const startAndApprove = async (env: Record<string, string>, extra: Record<string, unknown>) => {
    const r = parse(await createAutonomousStartHandler(deps(env) as never)({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, ctx));
    assert.equal(r.code, 'PENDING_EXTERNAL_APPROVAL', JSON.stringify(r));
    idp.approve(r.requestId);
    return parse(await createAutonomousResumeHandler(deps(env, extra) as never)({ workspaceRoot: dir, requestId: r.requestId }, ctx));
  };
  const clarResolver = (env: Record<string, string>) =>
    new IdpClarificationResolver({ env, provider: createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: dir }) }), pollIntervalMs: 20 });

  it('ONE IdP package before any AGY call; answers -> criteria, generated gate checks, accepted improvement adds a task', async () => {
    const env = idp.env();
    llm.clarify = () => REVIEW;
    let agyCallsAtAnswer = -1;
    idp.onDecisionPoll = (id) => {
      const e = idp.decisions.get(id);
      if (e && e.st.status === 'PENDING' && e.body.operation === 'SPEC_CLARIFICATION') {
        agyCallsAtAnswer = agy.calls;
        idp.answer(id, {}, { answers: [{ questionId: 'export', selectedOptionId: 'esm' }, { questionId: 'readme', selectedOptionId: 'evet' }] });
      }
    };
    const r = await startAndApprove(env, { clarificationResolver: clarResolver(env) });
    assert.equal(r.code, "COMPLETED", `${r.report?.stopReason} ${JSON.stringify(r.report?.warnings)}`);
    assert.equal(agyCallsAtAnswer, 0, 'nothing implemented before the PO answered');
    const bodies = [...idp.decisions.values()].map((d) => d.body);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].operation, 'SPEC_CLARIFICATION');
    assert.equal(bodies[0].taskId, 'SPEC-CLARIFY');
    const qs = bodies[0].questions as Any[];
    assert.deepEqual(qs.map((q) => q.kind), ['CLARIFICATION', 'IMPROVEMENT']);
    assert.ok(qs[0].options[0].criteria.includes('Her src/*.js dosyası export içerir'));
    assert.ok(qs[1].options[0].criteria.some((c: string) => c.startsWith('Yeni görev:')));
    const c = r.report.clarification;
    assert.equal(c.status, 'ANSWERED');
    assert.equal(c.checksScript, CHECKS_SCRIPT_PATH);
    assert.deepEqual(c.newTasks, ['TASK-C01: Kullanım notu ekle']);
    assert.ok(c.criteriaAdded >= 2);
    assert.ok(r.report.finalGate.checks.some((x: Any) => x.command === `node ${CHECKS_SCRIPT_PATH}` && x.exitCode === 0), JSON.stringify(r.report.finalGate));
    assert.ok(agy.requestsSeen.some((q) => q.taskId === 'TASK-C01'));
    const prompts = llm.requests.map((q) => JSON.stringify(q.messages));
    assert.ok(prompts.every((p) => p.includes('BINDING PRODUCT_OWNER SPEC CLARIFICATIONS')));
    assert.ok(prompts.some((p) => p.includes('Her src/*.js dosyası export içerir')));
    assert.ok(execSync('git log --format=%s', { cwd: dir, encoding: 'utf8' }).includes('spec clarification checks'));
    const st = fs.readdirSync(path.join(dir, '.ai-manager', 'state', 'spec-clarification'));
    assert.equal(st.length, 1);
    assert.ok(fs.readFileSync(path.join(dir, '.ai-manager', 'reports', fs.readdirSync(path.join(dir, '.ai-manager', 'reports')).find((f) => f.endsWith('.md'))!), 'utf8').includes('## Spec netleştirme'));
  });

  it('expiry -> BLOCKED_ON_HUMAN, nothing implemented; restart re-sends the SAME questions without a new Director call; answered state is never re-asked', async () => {
    const env = idp.env();
    llm.clarify = () => REVIEW;
    idp.onDecisionPoll = (id) => {
      const e = idp.decisions.get(id);
      if (e && e.st.status === 'PENDING') e.st = { status: 'EXPIRED' } as Any;
    };
    const base = idp.decisions.size;
    const r1 = await startAndApprove(env, { clarificationResolver: clarResolver(env) });
    assert.equal(r1.report.status, 'BLOCKED_ON_HUMAN', JSON.stringify(r1.report?.stopReason));
    assert.match(r1.report.stopReason, /Netleştirme|netleştirme/);
    assert.equal(agy.calls, 0);
    assert.equal(r1.report.clarification.status, 'EXPIRED');
    idp.onDecisionPoll = (id) => {
      const e = idp.decisions.get(id);
      if (e && e.st.status === 'PENDING') idp.answer(id, {}, { answers: [{ questionId: 'export', selectedOptionId: 'esm' }, { questionId: 'readme', selectedOptionId: 'hayir' }] });
    };
    const r2 = await startAndApprove(env, { clarificationResolver: clarResolver(env) });
    assert.equal(r2.code, 'COMPLETED', r2.report?.stopReason);
    assert.equal(llm.clarifyRequests.length, 1, 'Director review not repeated');
    assert.equal(idp.decisions.size - base, 2);
    assert.deepEqual(r2.report.clarification.newTasks, [], 'declined improvement adds nothing');
    // Same spec again: answers reused, nothing asked.
    const before = idp.decisions.size;
    const r3 = await startAndApprove(env, { clarificationResolver: clarResolver(env) });
    assert.equal(r3.report.clarification.status, 'REUSED');
    assert.equal(idp.decisions.size, before);
  });

  it('Netleştirme: kapalı -> no review call; no questions -> NONE without IdP; no channel -> recommended options as assumptions', async () => {
    fresh(SPEC.replace('Küçük bir site.', 'Küçük bir site.\n\nNetleştirme: kapalı'));
    const run = async () => {
      const out: string[] = [];
      const res = (await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
        cwd: dir, env: {}, stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t), executorPort: agy,
        autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
      } as Any)) as Any;
      assert.ok(res.data, out.join('\n').slice(0, 3000));
      return res.data;
    };
    llm.clarify = () => REVIEW;
    let rep = await run();
    assert.equal(rep.clarification.status, 'DISABLED');
    assert.equal(llm.clarifyRequests.length, 0);

    fresh();
    rep = await run();
    assert.equal(rep.clarification?.status, 'AUTO_RECOMMENDED', JSON.stringify([rep.status, rep.stopReason]));
    assert.ok(rep.assumptions.some((a: string) => a.includes('önerilen seçenekler uygulandı')));
    assert.ok(rep.clarification.lines.some((l: string) => l.includes('Modern (export) biçimi')));

    fresh();
    llm.clarify = () => ({ summary: 'Her şey açık.', questions: [] });
    rep = await run();
    assert.equal(rep.clarification.status, 'NONE');
  });

  it('English questions: one Turkish repair call; still-English items are dropped', async () => {
    const english = { questions: [{ id: 'fw', question: 'Which framework?', reason: 'Not specified', options: [{ id: 'a', label: 'React' }, { id: 'b', label: 'Vue' }] }] };
    llm.clarify = () => english;
    const out: string[] = [];
    const rep = (await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
      cwd: dir, env: {}, stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t), executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
    } as Any)).data as Any;
    assert.equal(llm.clarifyRequests.length, 2);
    assert.ok(JSON.stringify(llm.clarifyRequests[1].messages).includes('Turkish'));
    assert.equal(rep.clarification.status, 'NONE');
    assert.ok(rep.assumptions.some((a: string) => a.includes('Türkçe olmayan soru atlandı')));
  });
});
