/**
 * Integration tests: `aidm run --spec` through the REAL closed loop
 * (SpecIngestor -> sealed mandate -> ClosedLoopCoordinator -> DirectorRuntime -> AuthorizationPolicyEngine
 *  -> ExecutionBridge/Driver -> executor -> independent SystemEvidence -> git) with a mocked LLM
 * Director and a mocked AGY executor. Offline & deterministic.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { executeCli, CliExitCode } from '../dist/cli/index.js';
import { createAutonomousStartHandler } from '../dist/mcp/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor, type MockDirectorMode } from './helpers/autonomous-test-doubles.ts';

const SPEC = `# Mini Matematik

Küçük bir matematik kütüphanesi.

## Gereksinimler

### Toplama
\`src/add.js\` içinde add fonksiyonu.
- add fonksiyonu dışa aktarılır

### Çarpma
\`src/mul.js\` içinde mul fonksiyonu.
`;

function pricing(bm: BudgetManager) {
  bm.registerPricingRate({
    providerId: 'mock-autonomous',
    modelId: 'mock-director-1',
    inputRateNum: 1_000n,
    inputRateDen: 1n,
    outputRateNum: 2_000n,
    outputRateDen: 1n,
  });
}

describe('aidm run --spec (integration, mocked LLM + mocked AGY, real closed loop)', { concurrency: 1 }, () => {
  let dir: string;
  let out: string[];
  let llm: MockDirectorLlm;
  let agy: MockAgyExecutor;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-autorun-'));
    execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "AIDM Test"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "aidm@example.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'ignore' });
    execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    out = [];
    llm = new MockDirectorLlm();
    agy = new MockAgyExecutor(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], mode?: MockDirectorMode) => {
    if (mode) llm.mode = mode;
    return executeCli(['run', '--spec', 'proje.md', '-C', dir, ...args], {
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
      },
    });
  };
  const report = (r: { data?: unknown }) => r.data as any;

  it('--dry-run: plans only — no LLM, no AGY, no state written', async () => {
    const r = await run(['--dry-run', '--json']);
    assert.equal(r.exitCode, CliExitCode.SUCCESS, out.join('\n'));
    const rep = report(r);
    assert.equal(rep.status, 'DRY_RUN_OK');
    assert.equal(rep.tasks.length, 2);
    assert.deepEqual(rep.mandate.autoExecutableTaskClasses, ['IMPLEMENTATION']);
    assert.equal(llm.requests.length, 0);
    assert.equal(agy.calls, 0);
    assert.equal(fs.existsSync(path.join(dir, '.ai-manager')), false);
  });

  it('full run: Director (mock LLM) drives AGY (mock) end-to-end; tasks accepted only via independent evidence; commits + report', async () => {
    const r = await run(['--budget-usd', '1']);
    const rep = report(r);
    assert.equal(r.exitCode, CliExitCode.SUCCESS, `${rep?.status}: ${rep?.stopReason}\n${out.join('\n')}`);
    assert.equal(rep.status, 'COMPLETED');
    assert.deepEqual(rep.tasks.map((t: any) => t.status), ['ACCEPTED', 'ACCEPTED']);
    for (const t of rep.tasks) {
      assert.ok(t.evidenceIds.length > 0, 'evidence collected independently');
      assert.ok(t.commit, 'task committed');
      assert.ok(t.filesChanged.length > 0);
    }
    assert.ok(fs.existsSync(path.join(dir, 'src', 'add.js')));
    assert.equal(rep.authorization.authSource, 'OPERATOR_CLI_INVOCATION');
    assert.equal(rep.authorization.actorType, 'USER');
    assert.ok(rep.budget.committedUsd > 0, 'LLM spend settled through budget hold/settle');
    assert.ok(rep.budget.committedUsd <= rep.budget.limitUsd);
    assert.ok(llm.requests.length >= 2);
    assert.ok(String(llm.requests[0].messages.map((m: any) => m.content).join('\n')).includes('NO-QUESTIONS'));
    assert.equal(agy.calls, 2);
    assert.ok(fs.existsSync(rep.reportPath));
    assert.ok(fs.existsSync(rep.reportPath.replace(/\.json$/, '.md')));
    const log = execSync('git log --format=%s', { cwd: dir, encoding: 'utf8' });
    assert.match(log, /baseline for autonomous spec run/);
    assert.equal(fs.existsSync(path.join(dir, '.ai-manager', 'state', 'autonomous-run.lock')), false, 'lock released');
    const tracked = execSync('git ls-files', { cwd: dir, encoding: 'utf8' });
    assert.ok(!tracked.includes('.ai-manager'), 'AIDM state is never committed');
  });

  it('no-questions mode: clarification requests become logged assumptions and the run continues', async () => {
    const r = await run(['--budget-usd', '1'], 'clarify-once');
    const rep = report(r);
    assert.equal(rep.status, 'COMPLETED', `${rep.stopReason}`);
    assert.ok(rep.assumptions.some((a: string) => a.includes('Which output format')));
  });

  it('human-gated action (REQUEST_HUMAN_DECISION) stops fail-closed; AGY never invoked', async () => {
    const r = await run(['--budget-usd', '1'], 'human-decision');
    const rep = report(r);
    assert.equal(r.exitCode, CliExitCode.HUMAN_BLOCKED, `${rep.status}: ${rep.stopReason}`);
    assert.equal(rep.status, 'BLOCKED_ON_HUMAN');
    assert.equal(agy.calls, 0);
  });

  it('Zero Executor Trust: AGY claiming success without real changes is never accepted', async () => {
    agy.claimOnly = true;
    const r = await run(['--budget-usd', '1', '--max-cycles', '1']);
    const rep = report(r);
    assert.notEqual(rep.status, 'COMPLETED');
    assert.ok(rep.tasks.every((t: any) => t.status !== 'ACCEPTED'));
    assert.equal(rep.commits.filter((c: string) => c !== rep.commits[0]).length, 0, 'only the baseline commit');
  });

  it('live run without a budget is refused before sealing anything', async () => {
    const r = await run([]);
    assert.equal(r.exitCode, CliExitCode.USAGE_ERROR);
    assert.match(report(r).stopReason, /budget/i);
    assert.equal(fs.existsSync(path.join(dir, '.ai-manager', 'state', 'project-mandate.json')), false);
  });

  it('budget too small: LLM call is blocked pre-dispatch, run stops BUDGET_EXHAUSTED, AGY not called', async () => {
    const r = await run(['--budget-usd', '0.0000001']);
    const rep = report(r);
    assert.equal(rep.status, 'BUDGET_EXHAUSTED', rep.stopReason);
    assert.equal(r.exitCode, CliExitCode.HUMAN_BLOCKED);
    assert.equal(agy.calls, 0);
  });

  it('dirty working tree (foreign uncommitted changes) fails closed instead of being auto-committed', async () => {
    fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'wip', 'utf8');
    const r = await run(['--budget-usd', '1']);
    assert.equal(report(r).status, 'CONFIGURATION_ERROR');
    assert.match(report(r).stopReason, /uncommitted/);
    assert.equal(agy.calls, 0);
  });

  it('MCP aidm_autonomous_start: dry-run allowed; live run without human authContext is BLOCKED_ON_AUTH_CONTEXT', async () => {
    const handler = createAutonomousStartHandler({
      llmProvider: llm,
      allowMockProvider: true,
      executorPort: agy,
      identityManager: new InMemoryIdentityManager({ baseDir: dir }),
      registerBudgetTerms: pricing,
      env: {},
    });
    const ctx = { correlation: { correlationId: 'c1' } } as never;
    const dry = JSON.parse((await handler({ specPath: 'proje.md', workspaceRoot: dir, dryRun: true }, ctx)).content[0].text as string);
    assert.equal(dry.code, 'DRY_RUN_OK');

    const live = JSON.parse((await handler({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1 }, ctx)).content[0].text as string);
    assert.equal(live.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(llm.requests.length, 0);
    assert.equal(agy.calls, 0);
    assert.equal(fs.existsSync(path.join(dir, '.ai-manager', 'state', 'project-mandate.json')), false);

    const forged = JSON.parse(
      (await handler({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1, authContext: { authSource: 'OPERATOR_CLI_INVOCATION', verified: true } }, ctx)).content[0].text as string
    );
    assert.equal(forged.code, 'BLOCKED_ON_AUTH_CONTEXT');

    const llmForged = JSON.parse(
      (await handler({ specPath: 'proje.md', workspaceRoot: dir, budgetUsd: 1, authContext: { authSource: 'TRUSTED_IDE', verified: true, actor: 'DIRECTOR' } }, ctx)).content[0].text as string
    );
    assert.equal(llmForged.report?.status ?? llmForged.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(agy.calls, 0);
  });
});
