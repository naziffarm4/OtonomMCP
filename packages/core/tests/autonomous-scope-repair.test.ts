/**
 * Scope fixes from the LLMTEST-1 live run (TASK-001 rejected by FILE_SCOPE, no IdP prompt):
 *  1. page work gets shared asset scope (assets/**, *.css) + paths required by clarification checks
 *  2. clarification criteria land in tasks.json and the instruction's acceptanceCriteria
 *  3. out-of-scope changes (no escape/binding/unsafe path) are repairable: repair cycle, files set aside
 *  4. repeated scope mismatch -> PO decision (widen / revert / stop) instead of a silent hard stop
 *  5. a BLOCKED_ON_HUMAN run can be resumed with the same runId
 * Offline (mock LLM, mock AGY).
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import { scopeExtrasForTask, scopeOnlyViolation, SHARED_PAGE_ASSET_SCOPE, loadCheckpoint, isResumableBlockedRun } from '../dist/autonomous/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const prompts = (llm: MockDirectorLlm) => llm.requests.map((r) => r.messages.map((m: Any) => String(m.content ?? '')).join('\n'));

const PAGES = `# Site\n\nKüçük bir site.\n\nNetleştirme: kapalı\n\n## Gereksinimler\n\n### Sayfalar\n\`index.html\` ve \`hakkimda.html\` sayfaları.\n`;
const LIB = `# Lib\n\nKüçük kütüphane.\n\nNetleştirme: kapalı\n\n## Gereksinimler\n\n### A\n\`src/a.js\` içinde a.\n`;

describe('scope repair + PO scope decision + resume blocked run', { concurrency: 1, timeout: 600_000 }, () => {
  let dir = '';
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;
  let out: string[];
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  const setup = (spec: string) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-scope-'));
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'user.email', 't@e.x');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'commit', '--allow-empty', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'proje.md'), spec, 'utf8');
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
    out = [];
  };
  const write = (f: string, c = 'x\n') => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c, 'utf8');
  };
  const run = async (args: string[] = [], extra: Record<string, unknown> = {}) =>
    ((await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json', ...args], {
      cwd: dir,
      env: { AIDM_WEB_CHECKS: '0' }, // stub pages: web site checks are covered in web-checks-completion.test.ts
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing, ...extra },
    })) as Any).data as Any;
  const why = (rep: Any) => `${rep?.status}: ${rep?.stopReason}\n${JSON.stringify(rep?.warnings)}\n${JSON.stringify(rep?.tasks)}\n${out.join('\n').slice(-2000)}`.slice(0, 5000);
  const answering = (selectedOptionId: string, seen: Any[]) => ({
    channel: 'OPERATOR_TTY',
    resolve: async (rec: Any) => {
      seen.push(rec);
      return { status: 'ANSWERED', answer: { selectedOptionId, actor: 'po', source: 'OPERATOR_TTY', answeredAt: new Date().toISOString() } };
    },
  });

  const impl = (taskId: string, targetFiles: string[]) => ({
    actionType: 'IMPLEMENT_TASK', rationale: 'scripted', taskId, objective: `Implement ${taskId}`, targetFiles, implementationScope: 'src/',
  });
  it('units: shared page asset scope, check paths, scope-only detection (security failures excluded)', () => {
    assert.deepEqual([...SHARED_PAGE_ASSET_SCOPE], ['assets/**', '*.css']);
    assert.deepEqual(scopeExtrasForTask(['index.html'], [{ type: 'file_exists', path: 'assets/site.js', description: 'd' } as Any]), ['assets/**', '*.css', 'assets/site.js']);
    assert.deepEqual(scopeExtrasForTask(['src/a.js'], []), []);
    const ev = (checks: Any[], failureCategory = 'SECURITY_FAILURE') => ({ systemEvidence: { verificationChecks: checks, failureCategory } }) as Any;
    const scopeFail = { type: 'FILE_SCOPE', status: 'FAIL', evidence: 'Repository changes outside allowed implementationScope: [assets/site.js, assets/style.css]' };
    assert.deepEqual(scopeOnlyViolation(ev([{ type: 'BINDING', status: 'PASS' }, scopeFail])), ['assets/site.js', 'assets/style.css']);
    assert.equal(scopeOnlyViolation(ev([{ type: 'SECURITY', status: 'FAIL', evidence: 'escape' }, scopeFail])), null, 'real security failure stays a hard stop');
    assert.equal(scopeOnlyViolation(ev([{ type: 'FILE_SCOPE', status: 'FAIL', evidence: 'outside: [../etc/passwd]' }])), null, 'traversal is never "just scope"');
    assert.equal(scopeOnlyViolation(ev([scopeFail], 'WORKSPACE_ESCAPE')), null);
    assert.equal(scopeOnlyViolation({} as Any), null);
    assert.equal(isResumableBlockedRun({ state: 'FINISHED', status: 'BLOCKED_ON_HUMAN' } as Any), true);
    assert.equal(isResumableBlockedRun({ state: 'FINISHED', status: 'COMPLETED' } as Any), false);
    assert.equal(isResumableBlockedRun({ state: 'RUNNING' } as Any), false);
  });

  it('page task: shared assets (assets/**, *.css) are in scope -> accepted on the first attempt', async () => {
    setup(PAGES);
    agy.onExecute = () => {
      write('assets/site.js');
      write('assets/images/hero-320w.png');
      write('style.css');
    };
    const rep = await run();
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(rep.tasks[0].cycles, 1);
    const scope = agy.requestsSeen[0].instruction!.implementationScope!;
    assert.ok(scope.includes('assets/**') && scope.includes('*.css') && scope.includes('index.html'), JSON.stringify(scope));
    assert.ok(git(dir, 'ls-files').includes('assets/site.js'));
  });

  it('clarification criteria + check paths land in tasks.json and the instruction', async () => {
    setup(PAGES.replace('Netleştirme: kapalı\n', ''));
    llm.clarify = () => ({
      summary: 'Ortak alanlar netleşmeli.',
      questions: [
        {
          id: 'shared', kind: 'IMPROVEMENT', question: 'Ortak alanlar için ortak bir JavaScript dosyası kullanalım mı?', reason: 'Tutarlılık için.',
          recommendedOptionId: 'evet', allowFreeText: false,
          options: [
            { id: 'evet', label: 'Evet, ortak dosya', criteria: ['Her sayfa scripts/ortak.js dosyasını kullanır'], checks: [{ type: 'file_exists', path: 'scripts/ortak.js', description: 'Ortak dosya var' }] },
            { id: 'hayir', label: 'Hayır' },
          ],
        },
      ],
    });
    agy.onExecute = () => write('scripts/ortak.js');
    const rep = await run();
    assert.equal(rep.clarification.status, 'AUTO_RECOMMENDED', why(rep));
    const ins = agy.requestsSeen[0].instruction!;
    assert.ok((ins.acceptanceCriteria as Any[]).map(String).some((c) => c.includes('scripts/ortak.js')), JSON.stringify(ins.acceptanceCriteria));
    assert.ok(ins.implementationScope!.includes('scripts/ortak.js'), JSON.stringify(ins.implementationScope));
    const tasks = JSON.parse(fs.readFileSync(path.join(dir, '.ai-manager', 'spec', 'tasks.json'), 'utf8')) as Any[];
    const t1 = tasks.find((t) => t.task_id === 'TASK-001');
    assert.ok(t1.acceptance_criteria.some((c: string) => c.includes('scripts/ortak.js')));
    assert.ok(t1.metadata.implementationScopeExtra.includes('scripts/ortak.js'));
    assert.equal(rep.status, 'COMPLETED', why(rep));
  });

  it('one out-of-scope file -> repair cycle (not BLOCKED_ON_HUMAN): file set aside, Director told, 2nd attempt accepted', async () => {
    setup(LIB);
    agy.onExecute = () => {
      if (agy.calls === 1) write('docs/notes.md');
    };
    const rep = await run();
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(rep.tasks[0].cycles, 2);
    assert.ok(prompts(llm).some((p) => p.includes('OUTSIDE') && p.includes('docs/notes.md')), 'Director gets the scope mismatch');
    assert.ok(!fs.existsSync(path.join(dir, 'docs', 'notes.md')), 'out-of-scope file set aside');
    assert.ok(!git(dir, 'ls-files').includes('docs/notes.md'), 'never committed');
    const q = path.join(dir, '.ai-manager', 'scope-quarantine');
    assert.ok(fs.existsSync(q) && JSON.stringify(fs.readdirSync(q, { recursive: true })).includes('notes.md'), 'kept recoverable');
    assert.equal(rep.decisions.length, 0);
  });

  it('repeated scope mismatch -> PO decision in Turkish; widen adds the files and the task is accepted with them', async () => {
    setup(LIB);
    agy.onExecute = () => write('docs/notes.md', `n${agy.calls}\n`);
    const seen: Any[] = [];
    const rep = await run([], { decisionResolver: answering('widen', seen) });
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].options.map((o: Any) => o.id), ['widen', 'revert', 'stop']);
    assert.deepEqual(seen[0].options.map((o: Any) => o.label), [
      'Kapsamı genişlet ve devam et (bu dosyalar göreve eklenir)',
      'Fazla dosyaları at ve tekrar dene',
      'Çalışmayı durdur',
    ]);
    assert.equal(seen[0].recommendedOptionId, 'widen');
    assert.match(seen[0].question, /kapsamının dışında.*docs\/notes\.md/s);
    assert.ok(git(dir, 'ls-files').includes('docs/notes.md'), 'widened file committed');
    const last = agy.requestsSeen[agy.requestsSeen.length - 1];
    assert.ok(last.instruction!.implementationScope!.includes('docs/notes.md'));
  });

  it('scope decision: revert sets the files aside and retries; stop -> STOPPED', async () => {
    setup(LIB);
    let decided = false;
    agy.onExecute = () => {
      if (!decided) write('docs/notes.md', `n${agy.calls}\n`);
    };
    const seen: Any[] = [];
    let rep = await run([], {
      decisionResolver: { channel: 'OPERATOR_TTY', resolve: async (rec: Any) => ((decided = true), answering('revert', seen).resolve(rec)) },
    });
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.ok(!git(dir, 'ls-files').includes('docs/notes.md'));
    assert.ok(!fs.existsSync(path.join(dir, 'docs', 'notes.md')));
    fs.rmSync(dir, { recursive: true, force: true });

    setup(LIB);
    agy.onExecute = () => write('docs/notes.md', `n${agy.calls}\n`);
    rep = await run([], { decisionResolver: answering('stop', []) });
    assert.equal(rep.status, 'STOPPED', why(rep));
  });

  it('no decision channel -> BLOCKED_ON_HUMAN with a scope reason; the blocked run resumes with the SAME runId', async () => {
    setup(LIB);
    let block = true;
    agy.onExecute = () => {
      if (block) write('docs/notes.md', `n${agy.calls}\n`);
    };
    const r1 = await run();
    assert.equal(r1.status, 'BLOCKED_ON_HUMAN', why(r1));
    assert.match(r1.stopReason, /outside its implementationScope.*docs\/notes\.md/);
    assert.doesNotMatch(r1.stopReason, /SystemExecutionEvidence/);
    const cp = loadCheckpoint(dir, r1.runId)!;
    assert.equal(cp.state, 'FINISHED');
    assert.equal(cp.status, 'BLOCKED_ON_HUMAN');
    assert.ok(git(dir, 'status', '--porcelain').length > 0, 'the blocked attempt left a dirty tree');

    block = false;
    const r2 = await run(['--resume', r1.runId]);
    assert.equal(r2.status, 'COMPLETED', why(r2));
    assert.equal(r2.runId, r1.runId, 'same runId');
    assert.equal(loadCheckpoint(dir, r1.runId)!.segment, 2);
    assert.match(git(dir, 'stash', 'list'), /aidm-resume/);
    const again = await run(['--resume', r1.runId]);
    assert.equal(again.status, 'CONFIGURATION_ERROR');
    assert.match(again.stopReason, /already finished/);
  });

  it('Director targets a path outside the mandate -> repair turn first (attempt not consumed), then accepted', async () => {
    setup(LIB);
    llm.script = ({ call, taskId }) => (call === 1 ? impl(taskId, ['gizli/x.js']) : undefined);
    agy.onExecute = () => write('src/a.js', 'a\n');
    const rep = await run();
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.ok(prompts(llm).some((p) => p.includes("target file 'gizli/x.js' is outside the allowed paths")), 'Director told');
    assert.equal(rep.decisions.length, 0);
  });

  it('repeated policy path rejection -> Turkish 3-option PO decision; revert retries within scope', async () => {
    setup(LIB);
    let decided = false;
    llm.script = ({ taskId }) => (decided ? undefined : impl(taskId, ['gizli/x.js']));
    agy.onExecute = () => write('src/a.js', 'a\n');
    const seen: Any[] = [];
    const rep = await run([], {
      decisionResolver: { channel: 'OPERATOR_TTY', resolve: async (rec: Any) => ((decided = true), answering('revert', seen).resolve(rec)) },
    });
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].options.map((o: Any) => o.id), ['widen', 'revert', 'stop']);
    assert.match(seen[0].question, /izinli yolların dışındaki.*gizli\/x\.js/s);
    assert.equal(seen[0].recommendedOptionId, 'widen');
  });

  it('policy decision widen -> path recorded for the next segment, run stops resumable (BLOCKED_ON_HUMAN)', async () => {
    setup(LIB);
    llm.script = ({ taskId }) => impl(taskId, ['gizli/x.js']);
    const rep = await run([], { decisionResolver: answering('widen', []) });
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN', why(rep));
    assert.match(rep.stopReason, /gizli\/x\.js.*Kaldığı yerden devam et/);
    const ext = JSON.parse(fs.readFileSync(path.join(dir, '.ai-manager', 'state', 'mandate-extensions.json'), 'utf8'));
    assert.equal(ext[0].path, 'gizli/x.js');
  });

  it('root page specs: page files are inside the mandate and glob targets never reach the policy', async () => {
    setup(PAGES);
    llm.script = ({ taskId }) => impl(taskId, ['*.html', 'index.html']);
    agy.onExecute = () => write('index.html', '<html></html>\n');
    const rep = await run();
    assert.equal(rep.status, 'COMPLETED', why(rep));
    assert.ok(rep.mandate.allowedDirectories.includes('hakkimda.html'), JSON.stringify(rep.mandate.allowedDirectories));
  });

  it('design direction from the spec review becomes the binding brief: stored, in AGY criteria, CSS tokens gated', async () => {
    setup(PAGES.replace('Netleştirme: kapalı\n', ''));
    const design = { name: 'Fixture yönü', rationale: 'Konu ve kitleye uygun.', palette: { 'renk-a': '#101010', 'renk-b': '#202020', 'renk-c': '#303030' }, contrastPairs: [], fonts: { heading: 'A, serif', body: 'B, sans-serif' }, layout: 'sade', imagery: 'gerçek', tone: 'sakin', emoji: 'kullanılmaz' };
    llm.clarify = () => ({
      summary: 'Site planı.',
      questions: [{ id: 'design-direction', question: 'Hangi tasarım yönü?', reason: 'Görünüm Director kararıdır.', recommendedOptionId: 'x', allowFreeText: false,
        options: [{ id: 'x', label: 'Fixture yönü', design }, { id: 'y', label: 'Diğer yön', design: { ...design, name: 'Diğer' } }] }],
    });
    const css = `:root { ${Object.entries(design.palette).map(([k, v]) => `--${k}: ${v};`).join(' ')} --font-baslik: ${design.fonts.heading}; --font-govde: ${design.fonts.body}; }\n`;
    const page = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>\n';
    agy.onExecute = () => { write('index.html', page); write('hakkimda.html', page); write('style.css', css); };
    const rep = await run();
    assert.equal(rep.designBrief?.optionId, 'x', why(rep));
    const brief = JSON.parse(fs.readFileSync(path.join(dir, '.ai-manager', 'state', 'design-brief.json'), 'utf8'));
    assert.deepEqual(Object.keys(brief.tokens).sort(), [...Object.keys(design.palette), 'font-baslik', 'font-govde'].sort());
    const crit = (agy.requestsSeen[0].instruction!.acceptanceCriteria as Any[]).map(String).join(' ');
    assert.ok(crit.includes(`--renk-a: ${design.palette['renk-a']}`) && crit.includes('uydurulmaz'), crit);
    assert.ok(crit.includes('9. En fazla 2 yazı tipi, tutarlı boşluklar.'), 'permanent rules reach AGY verbatim');
    assert.equal(rep.status, 'COMPLETED', why(rep));
  });
});
