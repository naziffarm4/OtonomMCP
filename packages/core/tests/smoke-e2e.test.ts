/**
 * End-to-end smoke (run before every install: `npm run smoke`). Mock Director LLM + simulated IDE:
 * spec -> tasks -> IDE mailbox -> Director verification -> web final gate (PASS) -> completion report.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeCli } from '../dist/cli/index.js';
import { AntigravityAdapter, createIdeRequestInvoker, IDE_EXECUTOR_ID, ideNextTask, ideSubmit, ideAwaitVerdict } from '../dist/executor-bridge/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm } from './helpers/autonomous-test-doubles.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = fs.readFileSync(path.join(here, '..', 'scripts', 'smoke', 'proje.md'), 'utf8');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NAV = '<nav><a href="index.html">Ana sayfa</a><a href="hakkimizda.html">Hakkımızda</a></nav>';
const page = (h: string) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h}</title><link rel="stylesheet" href="style.css"></head><body>${NAV}<h1>${h}</h1></body></html>\n`;

const FILES: Record<string, string[]> = { 'TASK-001': ['index.html'], 'TASK-002': ['hakkimizda.html', 'style.css'] };
const CONTENT: Record<string, string> = {
  'index.html': page('Smoke Kuaför'),
  'hakkimizda.html': page('Hakkımızda'),
  'style.css': 'body{font-family:sans-serif;margin:0}nav{display:flex;gap:1rem;padding:1rem}\n',
};

describe('smoke e2e', { timeout: 300_000 }, () => {
  it('web spec runs to COMPLETED with a real final gate and a Turkish completion report', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-smoke-'));
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.name', 't');
      git(dir, 'config', 'user.email', 't@e.x');
      git(dir, 'config', 'commit.gpgsign', 'false');
      git(dir, 'commit', '--allow-empty', '-qm', 'init');
      fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
      const adapter = new AntigravityAdapter({ workspaceRoot: dir, executorId: IDE_EXECUTOR_ID, requestInvoker: createIdeRequestInvoker(dir, { pollMs: 10 }) });
      let stop = false;
      const ide = (async () => {
        while (!stop) {
          const n = ideNextTask(dir) as Any;
          if (n.state !== 'TASK') { await new Promise((r) => setTimeout(r, 20)); continue; }
          // Simulated IDE: writes exactly the files of the current task.
          const files = FILES[n.task.taskId] ?? [];
          for (const f of files) fs.writeFileSync(path.join(dir, f), CONTENT[f]);
          ideSubmit(dir, n.task.seq, `${files.join(', ')} yazıldı`, files);
          const v = (await ideAwaitVerdict(dir, n.task.seq, 20_000, 20)) as Any;
          if (v.verdict === 'DONE') break;
        }
      })();
      const llm = new MockDirectorLlm();
      llm.script = ({ call, taskId }: Any) => ({ actionType: 'IMPLEMENT_TASK', rationale: 's', taskId, objective: `Implement ${taskId} (${call})`, targetFiles: FILES[taskId] ?? [], implementationScope: '.' });
      const out: string[] = [];
      const rep = ((await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
        cwd: dir, env: { AIDM_VISUAL_REVIEW: '0' }, stdout: (t) => out.push(t), stderr: (t) => out.push(t), executorPort: adapter as Any,
        autonomous: {
          llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }),
          registerBudgetTerms: (bm: BudgetManager) => bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n }),
        },
      })) as Any).data as Any;
      stop = true;
      await ide;
      const why = `${rep?.status}: ${rep?.stopReason}\n${JSON.stringify(rep?.finalGate)}\n${out.join('\n').slice(-2000)}`;
      assert.equal(rep.status, 'COMPLETED', why);
      assert.equal(rep.finalGate?.status, 'PASS', why);
      assert.ok(rep.finalGate.checks.some((c: Any) => /web-site-check/.test(c.command)), why);
      assert.ok(rep.completionReportPath && fs.existsSync(rep.completionReportPath), why);
      const md = fs.readFileSync(rep.completionReportPath, 'utf8');
      assert.match(md, /Tamamlama raporu[\s\S]*Yapılanlar[\s\S]*GEÇTİ/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
