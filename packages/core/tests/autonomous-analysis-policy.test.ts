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
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import {
  SpecIngestor,
  parseAnalysisPolicy,
  isAnalysisAllowed,
  evaluateAnalysis,
  isGreenfieldWorkspace,
  formatAnalysisRefusal,
  saveCheckpoint,
  type RunCheckpoint,
  NO_ANALYSIS_DIRECTOR_INSTRUCTION,
  DEFAULT_SYNTHETIC_ACCEPTANCE_CRITERION,
  isSyntheticDefaultAcceptanceCriteria,
  isSyntheticDefaultDescription,
} from '../dist/autonomous/index.js';
import { DirectorActionDispatcher } from '../dist/director-action/director-action-dispatcher.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}
function gitRepo(spec: string, isGreenfield = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-anl-'));
  fs.writeFileSync(path.join(dir, 'proje.md'), spec, 'utf8');
  if (!isGreenfield) {
    fs.writeFileSync(path.join(dir, 'index.js'), '// baseline codebase\n', 'utf8');
  }
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

describe('analysis policy', { concurrency: 1, timeout: 1_200_000 }, () => {
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

  it('formatAnalysisRefusal maps all reasons to English instruction and Turkish reason-tagged log', () => {
    const reasons = [
      'greenfield',
      'policy_never',
      'quota_exhausted',
      'analysis_already_done_no_failed_attempt',
      'is_analysis_task',
      'policy_on_demand_not_first_or_failed',
    ] as const;

    for (const r of reasons) {
      const formatted = formatAnalysisRefusal(r, 'gerektiğinde');
      assert.ok(formatted.directorInstruction.length > 10);
      assert.ok(formatted.logMessage.includes(`reason: ${r}`));
    }
  });

  it('isGreenfieldWorkspace detects greenfield vs non-greenfield with untracked/unusual files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-gf-'));
    try {
      // 1. Non-git directory -> false
      assert.equal(await isGreenfieldWorkspace(tempDir), false);

      // 2. Initialized git repo with only spec/md and assets -> true
      execFileSync('git', ['init', '-b', 'main'], { cwd: tempDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Title\n', 'utf8');
      fs.writeFileSync(path.join(tempDir, 'spec.markdown'), '# Spec\n', 'utf8');
      fs.writeFileSync(path.join(tempDir, 'logo.png'), 'fake-image-bytes', 'utf8');
      fs.writeFileSync(path.join(tempDir, 'LICENSE'), 'MIT', 'utf8');
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n', 'utf8');
      assert.equal(await isGreenfieldWorkspace(tempDir), true);

      // 3a. Single .cs file -> false
      fs.writeFileSync(path.join(tempDir, 'app.cs'), 'class App {}', 'utf8');
      assert.equal(await isGreenfieldWorkspace(tempDir), false);
      fs.unlinkSync(path.join(tempDir, 'app.cs'));

      // 3b. Single .bas file -> false
      fs.writeFileSync(path.join(tempDir, 'module.bas'), 'Attribute VB_Name = "Module1"', 'utf8');
      assert.equal(await isGreenfieldWorkspace(tempDir), false);
      fs.unlinkSync(path.join(tempDir, 'module.bas'));

      // 3c. Turkish character filenames: "çalışma.cs", "Öğrenci.bas" -> false
      fs.writeFileSync(path.join(tempDir, 'çalışma.cs'), '// dosya', 'utf8');
      assert.equal(await isGreenfieldWorkspace(tempDir), false);
      fs.unlinkSync(path.join(tempDir, 'çalışma.cs'));

      fs.writeFileSync(path.join(tempDir, 'Öğrenci.bas'), '// dosya', 'utf8');
      assert.equal(await isGreenfieldWorkspace(tempDir), false);
      fs.unlinkSync(path.join(tempDir, 'Öğrenci.bas'));

      // 4. Untracked file inside folder
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'App.cs'), 'class App {}', 'utf8');
      assert.equal(await isGreenfieldWorkspace(tempDir), false);

      // 5. Clean it up -> true again
      fs.unlinkSync(path.join(tempDir, 'src', 'App.cs'));
      assert.equal(await isGreenfieldWorkspace(tempDir), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const runWith = async (
    spec: string,
    alwaysAnalyze: boolean,
    isGreenfield = false,
    extraAutonomousOptions?: Record<string, unknown>,
    executorOverride?: MockAgyExecutor
  ) => {
    dir = gitRepo(spec, isGreenfield);
    const llm = (extraAutonomousOptions?.llmProvider as MockDirectorLlm | undefined) ?? new MockDirectorLlm();
    const agy = executorOverride ?? new MockAgyExecutor(dir);
    if (!extraAutonomousOptions?.llmProvider) {
      llm.script = ({ taskId, prompt }) => {
        if (/-A\d+$/.test(taskId)) return undefined;
        const answered = prompt.includes(`Analysis ${taskId}-A`) || prompt.includes('not available for');
        if (alwaysAnalyze || !answered) return { actionType: 'ANALYZE_PROJECT', rationale: 'look first', analysisScope: 'layout' };
        return undefined;
      };
    }
    agy.stdoutFor = (req: Any) => (/read-only/i.test(String(req.instruction?.objective)) ? 'FINDINGS: ok' : undefined);
    const out: string[] = [];
    const r = await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
      cwd: dir,
      env: {},
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: {
        llmProvider: llm,
        allowMockProvider: true,
        identityManager: new InMemoryIdentityManager({ baseDir: dir }),
        registerBudgetTerms: pricing,
        ...(extraAutonomousOptions ?? {}),
      },
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

  it('a Director that keeps asking cannot loop: refused once, then fallback IMPLEMENT_TASK synthesizes and completes', async () => {
    const { rep, analyses } = await runWith(SPEC('\n- İnceleme: hiç\n'), true);
    assert.equal(analyses.length, 0);
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.ok(rep.tasks.some((t: Any) => t.metadata?.fallbackSynthesized === true));
  });

  it('greenfield run: first task prompt contains GREENFIELD instruction and no separate analysis is dispatched', async () => {
    const { rep, prompts, analyses } = await runWith(SPEC(), false, true);
    assert.equal(analyses.length, 0);
    assert.ok(prompts.some((p) => p.includes('GREENFIELD PROJECT')));
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
  });

  it('REPRO: persistent ANALYZE_PROJECT on empty repo / exhausted quota must not halt in BLOCKED_ON_APPROVAL', async () => {
    // Empty repo (greenfield) with a Director that persistently requests ANALYZE_PROJECT
    const { rep } = await runWith(SPEC(), true, true);
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.ok(rep.tasks.some((t: Any) => t.metadata?.fallbackSynthesized === true));
  });

  it('1. kota dolu + Director sürekli ANALYZE_PROJECT: greenfield olmayan depoda da BLOCKED_ON_APPROVAL olmadan IMPLEMENT_TASK ile tamamlanır', async () => {
    const { rep } = await runWith(SPEC(), true, false);
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.ok(rep.tasks.some((t: Any) => t.metadata?.fallbackSynthesized === true));
  });

  it('2. yetersiz spec: tanım, kabul kriteri ve hedef dosya yoksa INSUFFICIENT_TASK_SPECIFICATION ile durur', async () => {
    const insufficientSpec = [
      '# Proje: Boş Görev',
      '- İnceleme: hiç',
      '## Gereksinimler',
      '### TASK-EMPTY: ',
    ].join('\n');
    const { rep } = await runWith(insufficientSpec, true, false);
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN');
    assert.ok(rep.stopReason?.includes('INSUFFICIENT_TASK_SPECIFICATION'), `Expected INSUFFICIENT_TASK_SPECIFICATION, got: ${rep.stopReason}`);
  });

  it('yetersiz-spec kuralı: gerçek spec şablonu yeterli bulunur, yalnızca başlıklı TASK yetersiz bulunur', async () => {
    // 1. Gerçek spec şablonu (docs/spec-sablonu.md)
    const sablonPath = path.resolve(import.meta.dirname, '../../../docs/spec-sablonu.md');
    if (fs.existsSync(sablonPath)) {
      const sablonMd = fs.readFileSync(sablonPath, 'utf8');
      const sablonIngested = new SpecIngestor().ingest(sablonMd, { projectId: 'p' });
      for (const t of sablonIngested.tasks.filter((x) => x.task_id.startsWith('TASK-'))) {
        const desc = (t.description ?? '').trim();
        const acc = (t.acceptance_criteria ?? []).filter((c: string) => c.trim().length > 0);
        const tf = Array.isArray(t.metadata?.targetFiles) ? (t.metadata.targetFiles as string[]) : [];
        const isSyntheticAC = isSyntheticDefaultAcceptanceCriteria(acc);
        const hasRealDesc = !isSyntheticDefaultDescription(desc, t.title, t.task_id);
        const hasRealAcc = acc.length > 0 && !isSyntheticAC;
        const hasTf = tf.length > 0;
        const isInsufficient = !hasRealDesc && !hasRealAcc && !hasTf;
        assert.equal(isInsufficient, false, `Task ${t.task_id} in spec-sablonu must NOT be flagged as insufficient`);
      }
    }

    // 2. Yalnızca başlıklı bir TASK örneği
    const titleOnlySpec = [
      '# Proje: Sadece Başlık',
      '## Gereksinimler',
      '### Sadece Başlık Görevi',
    ].join('\n');
    const titleOnlyIngested = new SpecIngestor().ingest(titleOnlySpec, { projectId: 'p' });
    const emptyTask = titleOnlyIngested.tasks.find((t) => t.task_id.startsWith('TASK-'));
    assert.ok(emptyTask);
    const desc = (emptyTask.description ?? '').trim();
    const acc = (emptyTask.acceptance_criteria ?? []).filter((c: string) => c.trim().length > 0);
    const tf = Array.isArray(emptyTask.metadata?.targetFiles) ? (emptyTask.metadata.targetFiles as string[]) : [];
    const isSyntheticAC = isSyntheticDefaultAcceptanceCriteria(acc);
    const hasRealDesc = !isSyntheticDefaultDescription(desc, emptyTask.title, emptyTask.task_id);
    const hasRealAcc = acc.length > 0 && !isSyntheticAC;
    const hasTf = tf.length > 0;
    const isInsufficient = !hasRealDesc && !hasRealAcc && !hasTf;
    assert.equal(isInsufficient, true, 'Title-only task must be flagged as insufficient');
  });

  it('3. fallback eyleminin normal dispatch fonksiyonunu çağırdığını doğrulayan spy testi', async () => {
    let fallbackDispatched = false;
    class SpyDispatcher extends DirectorActionDispatcher {
      override async dispatch(input: Any): Promise<Any> {
        const env = input.validatedResult?.envelope;
        if (
          env?.idempotencyKey?.includes(':fallback-') ||
          (env?.actionType === 'IMPLEMENT_TASK' && String(env?.payload?.rationale).includes('Direct implementation fallback'))
        ) {
          fallbackDispatched = true;
        }
        return super.dispatch(input);
      }
    }
    const { rep } = await runWith(SPEC(), true, true, {
      actionDispatcher: (deps: Any) => new SpyDispatcher(deps),
    });
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.equal(fallbackDispatched, true, 'Fallback action must be dispatched through DirectorActionDispatcher.dispatch');
  });

  it('4. resume sonrası analysisRefusals korunur', async () => {
    const spec = SPEC();
    dir = gitRepo(spec, true);
    const specFingerprint = crypto.createHash('sha256').update(spec, 'utf8').digest('hex');
    const cp: RunCheckpoint = {
      runId: 'run-resume-refusal-1',
      projectRoot: dir,
      specPath: path.join(dir, 'proje.md'),
      specFingerprint,
      entryPoint: 'aidm run --spec',
      approval: 'cli',
      budgetUsd: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'RUNNING',
      segment: 1,
      pid: 999999,
      currentTaskId: 'TASK-001',
      inCycle: false,
      tasks: [{ taskId: 'TASK-001', status: 'PENDING', cycles: 1, metadata: { analysisRefusals: 1 } }],
      commits: [],
      monitorSeq: 0,
    };
    saveCheckpoint(cp);

    const llm = new MockDirectorLlm();
    const agy = new MockAgyExecutor(dir);
    llm.script = () => ({ actionType: 'ANALYZE_PROJECT', rationale: 'look first', analysisScope: 'layout' });

    const r = await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--resume', 'run-resume-refusal-1', '--budget-usd', '1', '--json'], {
      cwd: dir,
      env: {},
      stdout: () => {},
      stderr: () => {},
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
    } as Any);
    const rep = ((r as Any).data ?? {}) as Any;
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    const t1 = rep.tasks.find((t: Any) => t.taskId === 'TASK-001');
    assert.equal(t1?.metadata?.fallbackSynthesized, true);
    assert.equal(t1?.metadata?.analysisRefusals, 2);
  });

  it('5. eski formatlı checkpoint ile resume: metadata alanı yoksa 0 kabul edilir ve çökmek yerine sorunsuz çalışır', async () => {
    const spec = SPEC();
    dir = gitRepo(spec, true);
    const specFingerprint = crypto.createHash('sha256').update(spec, 'utf8').digest('hex');
    const cp: RunCheckpoint = {
      runId: 'run-resume-legacy-1',
      projectRoot: dir,
      specPath: path.join(dir, 'proje.md'),
      specFingerprint,
      entryPoint: 'aidm run --spec',
      approval: 'cli',
      budgetUsd: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'RUNNING',
      segment: 1,
      pid: 999999,
      currentTaskId: 'TASK-001',
      inCycle: false,
      tasks: [{ taskId: 'TASK-001', status: 'PENDING', cycles: 1 } as Any],
      commits: [],
      monitorSeq: 0,
    };
    saveCheckpoint(cp);

    const llm = new MockDirectorLlm();
    const agy = new MockAgyExecutor(dir);
    llm.script = () => ({ actionType: 'ANALYZE_PROJECT', rationale: 'look first', analysisScope: 'layout' });

    const r = await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--resume', 'run-resume-legacy-1', '--budget-usd', '1', '--json'], {
      cwd: dir,
      env: {},
      stdout: () => {},
      stderr: () => {},
      executorPort: agy,
      autonomous: { llmProvider: llm, allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
    } as Any);
    const rep = ((r as Any).data ?? {}) as Any;
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    const t1 = rep.tasks.find((t: Any) => t.taskId === 'TASK-001');
    assert.ok(t1?.metadata?.analysisRefusals !== undefined);
  });

  it('6. hedef dosyasız görevde fallback eyleminin implementationScope mandate yollarından gelir ve targetFiles boş kalır', async () => {
    let capturedFallbackPayload: Any = null;
    class ScopeSpyDispatcher extends DirectorActionDispatcher {
      override async dispatch(input: Any): Promise<Any> {
        const env = input.validatedResult?.envelope;
        if (env?.actionType === 'IMPLEMENT_TASK' && String(env?.payload?.rationale).includes('Direct implementation fallback')) {
          capturedFallbackPayload = env.payload;
        }
        return super.dispatch(input);
      }
    }
    const specNoTarget = `# P\n\n## Gereksinimler\n\n### Kurulum\nTemel proje iskeletini ve konfigürasyonunu kur.\n- index çalışmalı\n`;
    const { rep } = await runWith(specNoTarget, true, false, {
      actionDispatcher: (deps: Any) => new ScopeSpyDispatcher(deps),
    });
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.ok(capturedFallbackPayload, 'Fallback IMPLEMENT_TASK must have been dispatched');
    assert.deepEqual(capturedFallbackPayload.targetFiles, [], 'targetFiles must be empty when spec defines no target files');
    assert.ok(capturedFallbackPayload.implementationScope.includes('package.json'), 'implementationScope must include mandate root files');
    assert.ok(capturedFallbackPayload.implementationScope.includes('src'), 'implementationScope must include mandate directories');
  });

  it('7. fallback eylemi confidence değerini Director eyleminden miras alır ve [0, 1] aralığında kalır', async () => {
    let capturedConfidence: number | undefined;
    class ConfSpyDispatcher extends DirectorActionDispatcher {
      override async dispatch(input: Any): Promise<Any> {
        const env = input.validatedResult?.envelope;
        if (env?.actionType === 'IMPLEMENT_TASK' && String(env?.payload?.rationale).includes('Direct implementation fallback')) {
          capturedConfidence = env.payload?.confidence;
        }
        return super.dispatch(input);
      }
    }
    const llm = new MockDirectorLlm();
    llm.script = () => ({
      actionType: 'ANALYZE_PROJECT',
      confidence: 0.88,
      rationale: 'persistent code analysis',
      analysisScope: 'inspect codebase',
    });
    const { rep } = await runWith(SPEC(), true, true, {
      llmProvider: llm,
      actionDispatcher: (deps: Any) => new ConfSpyDispatcher(deps),
    });
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.equal(capturedConfidence, 0.88, 'Fallback must inherit valid confidence from rejected Director action');
  });

  it('8. REVIEW_EVIDENCE 1. redde yönlendirme alır; 2. redde fallback eylemine ÇEVRİLMEZ ve BLOCKED_ON_HUMAN ile durur (db78416 baz davranışı)', async () => {
    class ReviewDispatcher extends DirectorActionDispatcher {
      override async dispatch(input: Any): Promise<Any> {
        if (input.validatedResult?.envelope?.actionType === 'REVIEW_EVIDENCE') {
          return {
            status: ActionDispatchStatus.PENDING_AUTHORIZATION,
            reason: 'REVIEW_EVIDENCE requires human approval at this gate',
            actionType: 'REVIEW_EVIDENCE',
            actionId: input.validatedResult.envelope.actionId,
            dispatchId: 'disp-test-review',
            isAuthorized: false,
            requiresHumanApproval: true,
            dispatchedAt: new Date().toISOString(),
          };
        }
        return super.dispatch(input);
      }
    }
    const llm = new MockDirectorLlm();
    llm.script = () => ({
      actionType: 'REVIEW_EVIDENCE',
      taskId: 'TASK-001',
      evidenceIds: ['ev-001'],
      confidence: 0.9,
      rationale: 'insisting on reviewing evidence',
      reviewObjective: 'check test outcomes',
    });
    const { rep } = await runWith(SPEC(), true, true, {
      llmProvider: llm,
      actionDispatcher: (deps: Any) => new ReviewDispatcher(deps),
    });
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN', rep.stopReason);
    assert.match(rep.stopReason ?? '', /deneme hakkı içinde bağımsız doğrulamayı geçemedi|BLOCKED_ON_HUMAN/);
    const t1 = rep.tasks.find((t: Any) => t.taskId === 'TASK-001');
    assert.equal(t1?.metadata?.fallbackSynthesized, undefined, 'REVIEW_EVIDENCE must NOT trigger IMPLEMENT_TASK synthesis');
    assert.ok((t1?.metadata?.analysisRefusals ?? 0) >= 2, `Refusal counter should be >= 2, got ${t1?.metadata?.analysisRefusals}`);
  });
});
