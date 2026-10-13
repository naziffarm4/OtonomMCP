/**
 * Regression: a run configured with an explicit env must not be affected by ambient
 * process.env LLM settings (OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, AIDM_LLM_*).
 * Previously BudgetAwareLlmAdapter read AIDM_LLM_ENDPOINT / OPENAI_BASE_URL from process.env,
 * so a developer machine with those set failed pre-dispatch with ERR_UNSUPPORTED_BILLING_MODE.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { executeCli } from '../dist/cli/index.js';
import type { BudgetManager } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockDirectorLlm, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';

const AMBIENT: Record<string, string> = {
  OPENAI_API_KEY: 'sk-ambient-should-not-be-used-0000000000',
  OPENAI_MODEL: 'ambient-model',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  AIDM_LLM_ENDPOINT: 'https://api.openai.com/v1/chat/completions',
  AIDM_LLM_MODEL: 'ambient-model',
  AIDM_LLM_API_KEY: 'sk-ambient-should-not-be-used-1111111111',
};
const SPEC = `# Ortam Projesi\n\nAmaç.\n\n## Gereksinimler\n\n### Birinci\n\`src/a.js\` bir.\n`;

function initTestRepo(cwd: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@e.x');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'init');
}
function pricing(bm: BudgetManager) {
  bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n });
}

describe('autonomous run ignores ambient LLM env when given an explicit env', { timeout: 300_000 }, () => {
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const [k, v] of Object.entries(AMBIENT)) { saved[k] = process.env[k]; process.env[k] = v; }
  });
  after(() => {
    for (const k of Object.keys(AMBIENT)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('CLI run with mock provider completes despite ambient OPENAI/AIDM_LLM vars', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-ambient-'));
    try {
      initTestRepo(dir);
      fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
      const out: string[] = [];
      const r = await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
        cwd: dir,
        env: {},
        stdout: (t) => out.push(t),
        stderr: (t) => out.push(t),
        executorPort: new MockAgyExecutor(dir),
        autonomous: { llmProvider: new MockDirectorLlm(), allowMockProvider: true, identityManager: new InMemoryIdentityManager({ baseDir: dir }), registerBudgetTerms: pricing },
      });
      const text = out.join('\n');
      assert.ok(!text.includes('ERR_UNSUPPORTED_BILLING_MODE'), text);
      assert.equal(r.exitCode, 0, text);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.equal((r.data as any).status, 'COMPLETED', text);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
