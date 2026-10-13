import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { webGateCommands, listHtmlPages, WEB_SITE_CHECK_PATH } from '../dist/autonomous/web-checks.js';
import { renderCompletionReportTr, runVisualReview, collectScreenshots } from '../dist/autonomous/completion-report.js';
import { RunMonitor } from '../dist/autonomous/run-monitor.js';
import { ReferenceLlmAdapter } from '../dist/llm-bridge/reference-llm-adapter.js';
import { validateLlmRequest } from '../dist/llm-bridge/llm-types.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webchk-'));
const page = (links: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="style.css"></head><body><nav><a href="index.html">A</a><a href="b.html">B</a></nav>${links}</body></html>`;
const runSite = (root: string) => {
  try { return { code: 0, out: execFileSync(process.execPath, [WEB_SITE_CHECK_PATH], { cwd: root, encoding: 'utf8' }) }; }
  catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout }; }
};

test('non-web project gets no web gate commands', () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, 'a.ts'), 'x');
  assert.deepEqual(webGateCommands(r), []);
});

test('web project: site check passes, then fails on broken link / missing nav', () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, 'index.html'), page(''));
  fs.writeFileSync(path.join(r, 'b.html'), page(''));
  fs.writeFileSync(path.join(r, 'style.css'), 'body{}');
  fs.mkdirSync(path.join(r, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(r, 'node_modules', 'x', 'junk.html'), '<p>');
  assert.deepEqual(listHtmlPages(r), ['b.html', 'index.html']);
  const cmds = webGateCommands(r, { browser: false });
  assert.equal(cmds.length, 1);
  assert.equal(runSite(r).code, 0);
  fs.writeFileSync(path.join(r, 'b.html'), page('<a href="yok.html">x</a>'));
  const f = runSite(r);
  assert.equal(f.code, 1);
  assert.match(f.out, /yok\.html/);
  fs.writeFileSync(path.join(r, 'b.html'), '<html><head><meta name="viewport" content="x"></head><body>x</body></html>');
  assert.equal(runSite(r).code, 1);
});

test('completion report is Turkish and lists gaps', () => {
  const md = renderCompletionReportTr({
    runId: 'run-1', projectName: 'Kuaför', status: 'PARTIAL', startedAt: '2026-10-13T10:00:00Z', finishedAt: '2026-10-13T10:30:00Z',
    tasks: [{ taskId: 'T1', title: 'Ana sayfa', status: 'ACCEPTED' }, { taskId: 'T2', title: 'İletişim', status: 'FAILED' }],
    decisions: [], clarification: { status: 'ANSWERED', lines: ['Randevu formu: telefon zorunlu'] },
    budget: { limitUsd: 2, committedUsd: 0.1234 },
    finalGate: { status: 'FAIL', repairs: 1, checks: [{ command: 'node x', exitCode: 1 }] },
    visualReview: { status: 'SORUNLU', notes: ['Ana sayfa telefonda taşıyor'], screenshots: 2 }, commits: ['a'],
  }, [{ caption: 'index.html — telefon', file: 'x.jpg' }]);
  for (const s of ['Tamamlama raporu', 'Kısmen tamamlandı', '30 dk', '$0.123', 'T2 tamamlanmadı', 'KALDI', 'telefonda taşıyor', 'Randevu formu', 'Bilinen eksikler', 'index.html — telefon']) assert.ok(md.includes(s), s);
});

test('visual review sends images and parses Turkish verdict; no shots → YAPILMADI', async () => {
  const r = tmp();
  const dir = path.join(r, '.ai-manager', 'reports', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index-mobil.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  fs.writeFileSync(path.join(dir, 'browser-check.json'), JSON.stringify({ available: true, pages: ['index.html'], consoleErrors: [], screenshots: [{ file: 'index-mobil.jpg', page: 'index.html', view: 'mobil' }] }));
  const shots = collectScreenshots(r);
  assert.equal(shots.length, 1);
  assert.match(shots[0].dataUrl, /^data:image\/jpeg;base64,/);
  let seen: { messages: Array<{ images?: string[] }> } | null = null;
  const provider = { generate: async (req: never) => { seen = req; return { content: '{"verdict":"SORUNLU","notes":["Menü telefonda sığmıyor"]}' }; } };
  const v = await runVisualReview({ provider, model: 'm', projectId: 'p', runId: 'r', shots, isBudgetExhausted: () => false });
  assert.equal(v.status, 'SORUNLU');
  assert.deepEqual(v.notes, ['Menü telefonda sığmıyor']);
  assert.equal(seen!.messages[1].images!.length, 1);
  const none = await runVisualReview({ provider, model: 'm', projectId: 'p', runId: 'r', shots: [], isBudgetExhausted: () => false });
  assert.equal(none.status, 'YAPILMADI');
  const broke = await runVisualReview({ provider, model: 'm', projectId: 'p', runId: 'r', shots, isBudgetExhausted: () => true });
  assert.equal(broke.status, 'YAPILMADI');
});

test('LLM bridge maps images to OpenAI image_url parts', () => {
  const req = validateLlmRequest({
    correlation: { correlation_id: 'c1', project_id: 'p', task_id: 't', attempt: 1 },
    messages: [{ role: 'user', content: 'bak', images: ['data:image/jpeg;base64,AAAA', 'javascript:x'] }],
    director_context: { project_id: 'p', task_id: 't', objective: 'o', acceptance_criteria: null, attempt: 1, max_attempts: 1, relevant_context: null },
    model: 'gpt-4o',
  });
  const adapter = new ReferenceLlmAdapter({ providerId: 'x', providerName: 'openai', defaultModel: 'gpt-4o', transport: { send: async () => ({}) } as never, wireFormat: 'openai' } as never);
  const wire = adapter.translateToWire(req) as { messages: Array<{ content: unknown }> };
  const parts = wire.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts.length, 2);
  assert.equal(parts[1].image_url!.url, 'data:image/jpeg;base64,AAAA');
});

test('run monitor uploads completion report and screenshots with bearer', async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetchFn = (async (url: string, init: { method: string; body: string }) => { calls.push({ url, method: init.method, body: init.body }); return new Response('{}', { status: 200 }); }) as never;
  const m = RunMonitor.create({ env: { AIDM_IDP_URL: 'http://127.0.0.1:9', AIDM_IDP_CLIENT_TOKEN: 'tok' }, runId: 'run-abc', fetchFn })!;
  assert.ok(m);
  const out = await m.uploadCompletion('# Rapor', [
    { name: 'index-mobil.jpg', caption: 'c', dataUrl: 'data:image/jpeg;base64,AAAA' },
    { name: '../bad', caption: 'c', dataUrl: 'data:image/jpeg;base64,AAAA' },
  ]);
  assert.deepEqual(out, { report: true, screenshots: 1 });
  assert.ok(calls[0].url.endsWith('/api/runs/run-abc/report'));
  assert.ok(calls[1].url.endsWith('/api/runs/run-abc/screenshots/index-mobil.jpg'));
  assert.equal(calls.length, 2);
});

test('docs/spec-sablonu.md ingests cleanly (template and fenced example)', async () => {
  const { SpecIngestor } = await import('../dist/autonomous/spec-ingestor.js');
  const md = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'docs', 'spec-sablonu.md'), 'utf8');
  const r = new SpecIngestor().ingest(md, { projectId: 'p' });
  assert.deepEqual(r.warnings, []);
  assert.ok(r.tasks.some((t: { title: string }) => t.title === 'Ana sayfa'));
  const ex = md.split('```markdown\n')[1].split('```')[0];
  const r2 = new SpecIngestor().ingest(ex, { projectId: 'p' });
  assert.equal(r2.tasks.filter((t: { task_id: string }) => /^TASK-/.test(t.task_id)).length, 3);
});
