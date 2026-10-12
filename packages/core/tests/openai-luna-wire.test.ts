/**
 * @file openai-luna-wire.test.ts
 * @description gpt-6-luna Director support: default model, reasoning_effort config and OpenAI wire
 * translation for reasoning models; plus budget-period hold preservation regression.
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ReferenceLlmAdapter } from '../dist/llm-bridge/reference-llm-adapter.js';
import {
  resolveOpenAiDirectorConfig,
  createOpenAiDirectorProvider,
} from '../dist/director/openai-director-runtime.js';
import { BudgetManager } from '../dist/budget/budget-manager.js';

const noopTransport = { send: async () => { throw new Error('not used'); } } as any;

function wire(model: string, extra: Record<string, unknown> = {}) {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: 'json_schema', name: 'director_action', schema: { type: 'object' }, strict: true },
    ...extra,
  } as any;
}

const ENV_KEYS = ['AIDM_LLM_REASONING_EFFORT', 'AIDM_LLM_MODEL', 'OPENAI_MODEL', 'AIDM_LLM_ENDPOINT', 'OPENAI_BASE_URL', 'AIDM_LLM_API_KEY'];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('gpt-6-luna OpenAI wire translation', () => {
  it('sends reasoning_effort + max_completion_tokens, drops temperature, keeps strict json_schema', () => {
    const a = new ReferenceLlmAdapter({ transport: noopTransport, providerId: 'openai', reasoningEffort: 'medium' });
    const body = a.translateToOpenAiWire(wire('gpt-6-luna')) as any;
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.max_completion_tokens, 4000);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
  });

  it("allows temperature when reasoning_effort is 'none'", () => {
    const a = new ReferenceLlmAdapter({ transport: noopTransport, providerId: 'openai', reasoningEffort: 'none' });
    const body = a.translateToOpenAiWire(wire('gpt-6-luna')) as any;
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.temperature, 0.2);
  });

  it('non-reasoning gpt-4o keeps legacy body (no reasoning_effort, max_tokens, temperature)', () => {
    const a = new ReferenceLlmAdapter({ transport: noopTransport, providerId: 'openai', reasoningEffort: 'high' });
    const body = a.translateToOpenAiWire(wire('gpt-4o')) as any;
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.max_tokens, 4000);
    assert.equal(body.temperature, 0.2);
  });

  it('o1 still forces strict:false', () => {
    const a = new ReferenceLlmAdapter({ transport: noopTransport, providerId: 'openai' });
    const body = a.translateToOpenAiWire(wire('o1')) as any;
    assert.equal(body.response_format.json_schema.strict, false);
  });
});

describe('OpenAI Director config: Luna default + AIDM_LLM_REASONING_EFFORT', () => {
  function clearEnv() {
    for (const k of ENV_KEYS) delete process.env[k];
  }

  it('defaults to gpt-6-luna with medium effort on api.openai.com', () => {
    clearEnv();
    const c = resolveOpenAiDirectorConfig();
    assert.equal(c.model, 'gpt-6-luna');
    assert.equal(c.reasoningEffort, 'medium');
    assert.equal(c.wireFormat, 'openai');
  });

  it('reads AIDM_LLM_REASONING_EFFORT and omits effort for gpt-4o', () => {
    clearEnv();
    process.env.AIDM_LLM_REASONING_EFFORT = 'XHIGH';
    assert.equal(resolveOpenAiDirectorConfig().reasoningEffort, 'xhigh');
    process.env.AIDM_LLM_MODEL = 'gpt-4o';
    assert.equal(resolveOpenAiDirectorConfig().reasoningEffort, undefined);
  });

  it('invalid effort fails closed (unconfigured provider, never silently defaulted)', async () => {
    clearEnv();
    process.env.AIDM_LLM_REASONING_EFFORT = 'turbo';
    const c = resolveOpenAiDirectorConfig({ apiKey: 'sk-test', isProduction: false });
    assert.match(c.configError ?? '', /Invalid reasoning effort/);
    const p = createOpenAiDirectorProvider({ apiKey: 'sk-test', isProduction: false });
    assert.equal(p.providerId, 'openai:unconfigured');
    assert.equal((await p.checkAvailability()).available, false);
    assert.throws(() => createOpenAiDirectorProvider({ apiKey: 'sk-test', isProduction: true }));
  });

  it('provider advertises gpt-6-luna as supported default', () => {
    clearEnv();
    const p = createOpenAiDirectorProvider({ apiKey: 'sk-test', isProduction: false });
    assert.equal(p.defaultModel, 'gpt-6-luna');
    assert.ok(p.supportedModels.includes('gpt-6-luna'));
  });
});

describe('BudgetManager.authorizeBudgetPeriod preserves outstanding holds', () => {
  it('does not zero reserved spend of an in-flight reservation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-period-'));
    const bm = new BudgetManager({ dbPath: path.join(dir, 'b.sqlite') });
    bm.open();
    try {
      bm.createGlobalAccount(5_000_000_000n);
      const res = bm.reserve({
        sessionId: 'sess-period',
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        estimatedTokens: { inputTokens: 10_000, outputTokens: 4_000 },
        idempotencyKey: 'idem-period-1',
      });
      const before = bm.getGlobalAccount()!.reservedSpendNanoUsd;
      assert.ok(before > 0n);
      bm.authorizeBudgetPeriod({ authorizedBy: 'po', limit: 2 });
      assert.equal(bm.getGlobalAccount()!.reservedSpendNanoUsd, before);
      bm.release({ reservationId: res.reservationId, reason: 'test' });
      assert.equal(bm.getGlobalAccount()!.reservedSpendNanoUsd, 0n);
    } finally {
      bm.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
