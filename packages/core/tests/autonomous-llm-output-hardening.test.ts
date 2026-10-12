/**
 * Regression tests for the live gpt-4o failure of `aidm run --spec`:
 * - real-world LLM output WITHOUT envelope fields must succeed through the real closed loop
 *   (real ReferenceLlmAdapter wire path + BudgetAwareLlmAdapter, fake HTTP, mocked AGY);
 * - spoofed projectId / context fingerprint stays rejected fail-closed (never repaired);
 * - every LLM request gets its own reservation and is settled (no UNKNOWN hold left behind);
 * - validation failures are repaired by feeding the error back to the LLM.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { executeCli } from '../dist/cli/index.js';
import {
  resolveLlmProviderConfig,
  createConfiguredLlmProvider,
  registerProviderBudgetTerms,
  bindDecisionToEnvelope,
  DecisionEnvelopeSpoofError,
  DIRECTOR_DECISION_JSON_SCHEMA,
  describeLlmProviderConfig,
} from '../dist/autonomous/index.js';
import { BudgetManager, BudgetAwareLlmAdapter } from '../dist/budget/index.js';
import { InMemoryIdentityManager, MockAgyExecutor } from './helpers/autonomous-test-doubles.ts';

const SPEC = `# Mini Matematik

Netleştirme: kapalı

## Gereksinimler

### Toplama
\`src/add.js\` içinde add fonksiyonu.

### Çarpma
\`src/mul.js\` içinde mul fonksiyonu.
`;

const ENV = { AIDM_LLM_API_KEY: 'sk-test-0000000000000000', AIDM_LLM_MODEL: 'gpt-4o' };
type Scenario = 'gpt4o' | 'live-repro' | 'invalid-payload-once' | 'spoof-project' | 'spoof-fingerprint' | 'no-json-schema';

function nullDecision(): Record<string, unknown> {
  const props = (DIRECTOR_DECISION_JSON_SCHEMA as { properties: Record<string, unknown> }).properties;
  return Object.fromEntries(Object.keys(props).map((k) => [k, null]));
}

function implement(taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...nullDecision(),
    actionType: 'IMPLEMENT_TASK',
    rationale: `The task ${taskId} is READY and authorized; implement it.`,
    confidence: 0.86,
    expectedOutcome: 'Files created and verified by AIDM evidence.',
    taskId,
    objective: `Implement ${taskId} as described in the spec.`,
    implementationScope: 'src/',
    targetFiles: [`src/${taskId.toLowerCase()}.js`],
    acceptanceCriteria: ['module exports the function'],
    constraints: null,
    assumptions: ['CommonJS-free ESM module layout'],
    ...extra,
  };
}

class FakeOpenAi {
  scenario: Scenario = 'gpt4o';
  bodies: any[] = [];
  private seen = new Set<string>();

  fetch = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    this.bodies.push(body);
    const text = body.messages.map((m: any) => m.content).join('\n');
    const taskId = /taskId: (TASK-\d+)/.exec(text)?.[1] ?? 'TASK-001';
    const fp = /contextFingerprint: (\S+)/.exec(text)?.[1] ?? '';
    const first = !this.seen.has(taskId);
    this.seen.add(taskId);
    let content: Record<string, unknown>;
    if (this.scenario === 'no-json-schema' && body.response_format?.type === 'json_schema') {
      return new Response(
        JSON.stringify({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    if (this.scenario === 'live-repro' && first) {
      // What gpt-4o returned live: decision fields only, subset of keys, no envelope.
      content = { actionType: 'IMPLEMENT_TASK', rationale: 'Implement the ready task.', confidence: 0.9, taskId, objective: 'Implement it' };
    } else if (this.scenario === 'invalid-payload-once' && first) {
      content = implement(taskId, { objective: null, implementationScope: null });
    } else if (this.scenario === 'spoof-project') {
      content = implement(taskId, { projectId: 'someone-elses-project' });
    } else if (this.scenario === 'spoof-fingerprint') {
      content = implement(taskId, { basedOnContextFingerprint: `${fp}-forged` });
    } else {
      content = implement(taskId);
    }
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${this.bodies.length}`,
        object: 'chat.completion',
        created: 1760000000,
        model: 'gpt-4o-2024-08-06',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1500, completion_tokens: 200, total_tokens: 1700 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
}

describe('autonomous run: real-world LLM output hardening (gpt-4o style, real adapter + budget)', { concurrency: 1 }, () => {
  let dir: string;
  let agy: MockAgyExecutor;
  let llm: FakeOpenAi;
  let out: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-llmhard-'));
    for (const c of ['git init -b main', 'git config user.name T', 'git config user.email t@example.com', 'git config commit.gpgsign false', 'git commit --allow-empty -m init']) {
      execSync(c, { cwd: dir, stdio: 'ignore' });
    }
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    agy = new MockAgyExecutor(dir);
    llm = new FakeOpenAi();
    out = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (scenario: Scenario) => {
    llm.scenario = scenario;
    const cfg = resolveLlmProviderConfig(ENV);
    const provider = createConfiguredLlmProvider(cfg, ENV, { fetchFn: llm.fetch as typeof fetch });
    const r = await executeCli(['run', '--spec', 'proje.md', '-C', dir, '--budget-usd', '1', '--json'], {
      cwd: dir,
      env: ENV,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      executorPort: agy,
      autonomous: {
        llmProvider: provider,
        identityManager: new InMemoryIdentityManager({ baseDir: dir }),
        registerBudgetTerms: (bm) => registerProviderBudgetTerms(cfg, bm),
      },
    });
    return r.data as any;
  };

  it('gpt-4o style output without envelope fields reaches AGY and is accepted only via independent evidence', async () => {
    const rep = await run('gpt4o');
    assert.equal(rep.status, 'COMPLETED', `${rep.stopReason} | ${rep.tasks?.map((t: any) => t.lastSummary).join(' | ')}`);
    assert.equal(agy.calls, 2);
    assert.ok(rep.tasks.every((t: any) => t.evidenceIds.length > 0));
    const rf = llm.bodies[0].response_format;
    assert.equal(rf.type, 'json_schema');
    assert.equal(rf.json_schema.strict, true, 'strict structured output requested');
    assert.ok(!rf.json_schema.schema.required.includes('projectId'), 'envelope never required of the LLM');
    assert.ok(llm.bodies[0].messages.some((m: any) => String(m.content).includes('RESPONSE FORMAT')));
    assert.equal(rep.budget.reservedUsd, 0, 'every request settled; no UNKNOWN hold');
    assert.ok(rep.budget.committedUsd > 0);
  });

  it('live repro: envelope-less partial output is repaired; each request gets its own reservation and is settled (cost incurred is booked)', async () => {
    const baseline = await run('gpt4o');
    const baselineRequests = llm.bodies.length;
    fs.rmSync(dir, { recursive: true, force: true });
    // fresh project for the repro run
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-llmhard-'));
    for (const c of ['git init -b main', 'git config user.name T', 'git config user.email t@example.com', 'git config commit.gpgsign false', 'git commit --allow-empty -m init']) {
      execSync(c, { cwd: dir, stdio: 'ignore' });
    }
    fs.writeFileSync(path.join(dir, 'proje.md'), SPEC, 'utf8');
    agy = new MockAgyExecutor(dir);
    llm = new FakeOpenAi();
    const rep = await run('live-repro');
    assert.equal(rep.status, 'COMPLETED', `${rep.stopReason} | ${rep.tasks?.map((t: any) => t.lastSummary).join(' | ')}`);
    assert.equal(llm.bodies.length, baselineRequests + 2, 'one repair request per task');
    const repair = llm.bodies[1].messages.at(-1).content;
    assert.match(repair, /rejected by the AIDM validator/);
    assert.match(repair, /missing required schema fields/);
    assert.equal(rep.budget.reservedUsd, 0, 'rejected-but-billed responses are settled, not left UNKNOWN');
    const perRequest = baseline.budget.committedUsd / baselineRequests;
    assert.ok(Math.abs(rep.budget.committedUsd - perRequest * llm.bodies.length) < 1e-9, 'every distinct request charged exactly once');
  });

  it('schema-invalid decision payload is repaired with the validation error fed back', async () => {
    const rep = await run('invalid-payload-once');
    assert.equal(rep.status, 'COMPLETED', rep.stopReason);
    assert.match(llm.bodies[1].messages.at(-1).content, /objective|implementationScope/);
  });

  for (const s of ['spoof-project', 'spoof-fingerprint'] as const) {
    it(`${s}: conflicting LLM-supplied identity is rejected fail-closed, never repaired, AGY never invoked`, async () => {
      const rep = await run(s);
      assert.notEqual(rep.status, 'COMPLETED');
      assert.equal(agy.calls, 0);
      assert.match(rep.tasks[0].lastSummary, s === 'spoof-project' ? /projectId/ : /fingerprint mismatch/);
      assert.ok(llm.bodies.every((b) => !String(b.messages.at(-1).content).includes('rejected by the AIDM validator')));
    });
  }

  it('provider without json_schema support falls back to json_object + local validation', async () => {
    const rep = await run('no-json-schema');
    assert.equal(rep.status, 'COMPLETED', `${rep.stopReason} | ${rep.tasks?.map((t: any) => t.lastSummary).join(' | ')}`);
    assert.ok(llm.bodies.some((b) => b.response_format?.type === 'json_object'));
  });
});

describe('pricingConfigured / pricingSource (report flag)', () => {
  it('gpt-4o without operator pricing env reports BUILT_IN_VERIFIED (was misleadingly false)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-price-'));
    const bm = new BudgetManager({ dbPath: path.join(tmp, 'b.db') });
    bm.open();
    try {
      const cfg = resolveLlmProviderConfig(ENV);
      assert.equal(describeLlmProviderConfig(cfg).pricingSource, 'NOT_CHECKED');
      registerProviderBudgetTerms(cfg, bm);
      const d = describeLlmProviderConfig(cfg, bm);
      assert.equal(d.pricingSource, 'BUILT_IN_VERIFIED');
      assert.equal(d.pricingConfigured, true);
      const x = resolveLlmProviderConfig({ ...ENV, AIDM_LLM_INPUT_USD_PER_MTOK: '2.5', AIDM_LLM_OUTPUT_USD_PER_MTOK: '10' });
      assert.equal(describeLlmProviderConfig(x, bm).pricingSource, 'OPERATOR_ENV');
    } finally {
      bm.close?.();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('bindDecisionToEnvelope (unit)', () => {
  const ctx = { projectId: 'p1', directorSessionId: 'dsess-1', contextFingerprint: 'fp-1' };
  it('fills system envelope, strips authority fields, keeps LLM actionId only for audit', () => {
    const b = bindDecisionToEnvelope(
      { actionType: 'BLOCK', rationale: 'r', confidence: 0.5, actionId: 'act-llm', hasImplementationAuthority: true, protocolVersion: 'x', reason: null, assumptions: ['a1'] },
      ctx
    ) as any;
    assert.equal(b.projectId, 'p1');
    assert.equal(b.basedOnContextFingerprint, 'fp-1');
    assert.equal(b.protocolVersion, 'AIDM-DIRECTOR-ACTION-1');
    assert.match(b.actionId, /^dact-/);
    assert.equal(b.metadata.llmProposedActionId, 'act-llm');
    assert.deepEqual(b.metadata.assumptions, ['a1']);
    assert.equal('hasImplementationAuthority' in b, false);
    assert.equal('reason' in b, false);
  });
  it('matching echoed identity is accepted; conflicting identity throws', () => {
    assert.doesNotThrow(() => bindDecisionToEnvelope({ projectId: 'p1', basedOnContextFingerprint: 'fp-1' }, ctx));
    assert.throws(() => bindDecisionToEnvelope({ directorSessionId: 'other' }, ctx), DecisionEnvelopeSpoofError);
  });
});

describe('BudgetAwareLlmAdapter correlation (unit)', () => {
  it('distinct llm_invocation_id => distinct reservations; replay of an UNKNOWN reservation fails closed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-bud-'));
    const bm = new BudgetManager({ dbPath: path.join(tmp, 'b.db') });
    bm.open();
    try {
      registerProviderBudgetTerms(resolveLlmProviderConfig(ENV), bm);
      bm.createGlobalAccount(1);
      let calls = 0;
      let failNext = false;
      const inner: any = {
        providerId: 'openai', providerName: 'openai', defaultModel: 'gpt-4o', supportedModels: ['gpt-4o'], supportedCapabilities: [],
        checkAvailability: async () => ({ available: true, model: 'gpt-4o', reason: null }),
        generate: async (req: any) => {
          calls++;
          if (failNext) throw new Error('socket hang up');
          return { correlation: req.correlation, provider: 'openai', model: 'gpt-4o', content: 'x', structured_output: null, finish_reason: 'STOP',
            usage: { prompt_tokens: 100, completion_tokens: 10 }, raw_metadata: null, error: null };
        },
      };
      const adapter = new BudgetAwareLlmAdapter(inner, bm);
      const req = (inv?: string) => ({
        messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o', response_format: 'TEXT',
        correlation: { correlation_id: 'corr:llm:p:TASK-001:director-reasoning:TASK_READY:1', attempt: 1, project_id: 'p' },
        director_context: { project_id: 'p' }, metadata: inv ? { llm_invocation_id: inv } : {},
      }) as any;
      await adapter.generate(req('cycle1'));
      const after1 = bm.getGlobalAccount()!.committedSpendNanoUsd;
      await adapter.generate(req('cycle2'));
      const after2 = bm.getGlobalAccount()!.committedSpendNanoUsd;
      assert.equal(after2, after1 * 2n, 'second cycle charged under its own reservation');
      failNext = true;
      await assert.rejects(adapter.generate(req('cycle3')));
      const before = calls;
      await assert.rejects(adapter.generate(req('cycle3')), /ERR_BUDGET_DUPLICATE_DISPATCH|unreconciled/);
      assert.equal(calls, before, 'no second provider call under an UNKNOWN reservation');
    } finally {
      bm.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
