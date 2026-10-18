/**
 * Speed: the separate read-only AGY analysis subtask runs only for the first task of a run segment
 * and after a failed attempt (spec `İnceleme:` overrides: her görev | gerektiğinde | hiç).
 * Offline (mock LLM, mock AGY).
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import { SpecIngestor, parseAnalysisPolicy, isAnalysisAllowed, evaluateAnalysis, NO_ANALYSIS_DIRECTOR_INSTRUCTION } from '../dist/autonomous/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
function gitRepo(spec: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-anl-'));
  fs.writeFileSync(path.join(dir, 'proje.md'), spec, 'utf8');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@e.x');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '--allow-empty', '-qm', 'init');
  return dir;
}
const SPEC = (extra = '') =>
  `# P\n\nx.\n${extra}\n## Gereksinimler\n\n### A\n\`src/a.js\`\n- a var\n\n### B\n\`src/b.js\`\n- b var\n\n### C\n\`src/c.js\`\n- c var\n`;

describe('analysis policy', { concurrency: 1, timeout: 600_000 }, () => {
  let dir = '';
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it('parses İnceleme values; default gerektiğinde; line is not a criterion', () => {
    assert.equal(parseAnalysisPolicy('her görev'), 'EVERY_TASK');
    assert.equal(parseAnalysisPolicy('her-gorev'), 'EVERY_TASK');
    assert.equal(parseAnalysisPolicy('Gerektiğinde'), 'ON_DEMAND');
    assert.equal(parseAnalysisPolicy('hiç'), 'NEVER');
    assert.equal(parseAnalysisPolicy('hic'), 'NEVER');
    assert.equal(parseAnalysisPolicy('bazen'), undefined);
    const ing = (s: string) => new SpecIngestor().ingest(s, { projectId: 'p' });
    assert.equal(ing(SPEC()).analysisPolicy, 'ON_DEMAND');
    assert.equal(ing(SPEC('\n- İnceleme: her görev\n')).analysisPolicy, 'EVERY_TASK');
    assert.equal(ing(SPEC('\nİnceleme: hiç\n')).analysisPolicy, 'NEVER');
    const r = ing(SPEC().replace('- a var', '- a var\n- İnceleme: hic'));
    assert.equal(r.analysisPolicy, 'NEVER');
    assert.ok(!r.requirements[0].acceptanceCriteria.some((c: string) => /nceleme/i.test(c)));
    const bad = ing(SPEC('\n- İnceleme: bazen\n'));
    assert.equal(bad.analysisPolicy, 'ON_DEMAND');
    assert.ok(bad.warnings.some((w: string) => w.includes('bazen')));
  });

  it('isAnalysisAllowed matrix', () => {
    const c = (f: boolean, a: boolean) => ({ firstTaskOfSegment: f, afterFailedAttempt: a });
    assert.equal(isAnalysisAllowed('ON_DEMAND', c(true, false)), true);
    assert.equal(isAnalysisAllowed('ON_DEMAND', c(false, true)), true);
    assert.equal(isAnalysisAllowed('ON_DEMAND', c(false, false)), false);
    assert.equal(isAnalysisAllowed('EVERY_TASK', c(false, false)), true);
    assert.equal(isAnalysisAllowed('NEVER', c(true, true)), false);
  });

  it('evaluateAnalysis parametric table test', () => {
    // isAnalysisTask: true -> refused
    assert.deepEqual(
      evaluateAnalysis('EVERY_TASK', { firstTaskOfSegment: true, afterFailedAttempt: false, isAnalysisTask: true }),
      { allowed: false, reason: 'is_analysis_task' }
    );
    // isGreenfield: true -> refused
    assert.deepEqual(
      evaluateAnalysis('EVERY_TASK', { firstTaskOfSegment: true, afterFailedAttempt: false, isGreenfield: true }),
      { allowed: false, reason: 'greenfield' }
    );
    // policy: NEVER -> refused
    assert.deepEqual(
      evaluateAnalysis('NEVER', { firstTaskOfSegment: true, afterFailedAttempt: true }),
      { allowed: false, reason: 'policy_never' }
    );
    // quota_exhausted (done >= max)
    assert.deepEqual(
      evaluateAnalysis('EVERY_TASK', { firstTaskOfSegment: true, afterFailedAttempt: true, analysesDone: 2, maxAnalyses: 2 }),
      { allowed: false, reason: 'quota_exhausted' }
    );
    // analysis_already_done_no_failed_attempt (done >= 1 && !afterFailedAttempt)
    assert.deepEqual(
      evaluateAnalysis('EVERY_TASK', { firstTaskOfSegment: true, afterFailedAttempt: false, analysesDone: 1, maxAnalyses: 2 }),
      { allowed: false, reason: 'analysis_already_done_no_failed_attempt' }
    );
    // allowed after failure when quota not exhausted
    assert.deepEqual(
      evaluateAnalysis('EVERY_TASK', { firstTaskOfSegment: true, afterFailedAttempt: true, analysesDone: 1, maxAnalyses: 2 }),
      { allowed: true }
    );
    // ON_DEMAND: first task of segment -> allowed
    assert.deepEqual(
      evaluateAnalysis('ON_DEMAND', { firstTaskOfSegment: true, afterFailedAttempt: false, analysesDone: 0 }),
      { allowed: true }
    );
    // ON_DEMAND: not first and not failed -> refused
    assert.deepEqual(
      evaluateAnalysis('ON_DEMAND', { firstTaskOfSegment: false, afterFailedAttempt: false, analysesDone: 0 }),
      { allowed: false, reason: 'policy_on_demand_not_first_or_failed' }
    );
    // ON_DEMAND: after failed attempt -> allowed
    assert.deepEqual(
      evaluateAnalysis('ON_DEMAND', { firstTaskOfSegment: false, afterFailedAttempt: true, analysesDone: 0 }),
      { allowed: true }
    );
  });

  const runWith = async (spec: string, alwaysAnalyze: boolean) => {
    dir = gitRepo(spec);
    const llm = new MockDirectorLlm();
    const agy = new MockAgyExecutor(dir);
    llm.script = ({ taskId, prompt }) => {
      if (/-A\d+$/.test(taskId)) return undefined;
      const answered = prompt.includes(`Analysis ${taskId}-A`) || prompt.includes('not available for');
      if (alwaysAnalyze || !answered) return { actionType: 'ANALYZE_PROJECT', rationale: 'look first', analysisScope: 'layout' };
      return undefined;
    };
    agy.stdoutFor = (req: Any) => (/read-only/i.test(String(req.instruction?.objective)) ? 'FINDINGS: ok' : undefined);
    const out: string[] = [];
    const r = await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
      cwd: dir,
      env: {},
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
    } as Any);
    const rep = ((r as Any).data ?? {}) as Any;
    void out;
    const prompts = llm.requests.map((r) => r.messages.map((m: Any) => String(m.content ?? '')).join('\n'));
    return { rep, prompts, analyses: (rep.tasks ?? []).filter((t: Any) => t.kind === 'ANALYSIS').map((t: Any) => t.taskId) };
  };

  it('default: analysis only for the first task; later requests refused once (not counted) and the prompt says so', async () => {
    const { rep, prompts, analyses } = await runWith(SPEC(), false);
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.equal(analyses.length, 1, JSON.stringify(analyses));
    assert.ok(prompts.some((p) => p.includes(NO_ANALYSIS_DIRECTOR_INSTRUCTION)));
    assert.ok(prompts.some((p) => p.includes('not available for')));
    for (const t of rep.tasks.filter((x: Any) => x.kind !== 'ANALYSIS' && x.status === 'ACCEPTED')) assert.equal(t.cycles, 1, JSON.stringify(t));
    // No commands / command-like criteria in the spec: COMPLETED must not read as fully verified.
    assert.equal(rep.finalGate.status, 'NO_CHECKS');
    assert.ok(rep.warnings.some((w: string) => w.includes('Son kabul kapısı çalıştırılamadı')));
  });

  it('İnceleme: her görev → analysis for every task', async () => {
    const { rep, analyses } = await runWith(SPEC('\n- İnceleme: her görev\n'), false);
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.ok(analyses.length >= 3, JSON.stringify(analyses));
  });

  it('İnceleme: hiç → no analysis at all', async () => {
    const { rep, analyses } = await runWith(SPEC('\n- İnceleme: hiç\n'), false);
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.equal(analyses.length, 0);
  });

  it('a Director that keeps asking cannot loop: refused once, then normal (counted) handling', async () => {
    const { rep, analyses } = await runWith(SPEC('\n- İnceleme: hiç\n'), true);
    assert.equal(analyses.length, 0);
    assert.notEqual(rep.status, 'COMPLETED');
  });

  it('REPRO: persistent ANALYZE_PROJECT on empty repo / exhausted quota must not halt in BLOCKED_ON_APPROVAL', async () => {
    // Empty repo (greenfield) with a Director that persistently requests ANALYZE_PROJECT
    const { rep } = await runWith(SPEC(), true);
    // In current unpatched code, this halts in BLOCKED_ON_HUMAN with stopReason:
    // "Action type 'ANALYZE_PROJECT' is a governance/lifecycle action and cannot be autonomously dispatched at this gate."
    // Once Steps 2 & 3 are implemented, the run must complete without blocking on the governance approval gate.
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
  });
});
