/**
 * Unit tests: configurable OpenAI-compatible provider (OpenAI / Grok xAI) + budget terms
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  resolveLlmProviderConfig,
  registerProviderBudgetTerms,
  createConfiguredLlmProvider,
  describeLlmProviderConfig,
  LlmProviderConfigError,
  DEFAULT_XAI_ENDPOINT,
} from '../dist/autonomous/index.js';
import { BudgetManager } from '../dist/budget/index.js';

describe('Autonomous LLM provider config', () => {
  it('defaults to OpenAI chat completions + gpt-4o with AIDM_LLM_API_KEY', () => {
    const c = resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'sk-test' });
    assert.equal(c.kind, 'openai');
    assert.equal(c.endpoint, 'https://api.openai.com/v1/chat/completions');
    assert.equal(c.model, 'gpt-4o');
    assert.equal(c.apiKeyEnvVar, 'AIDM_LLM_API_KEY');
  });

  it('key precedence: AIDM_LLM_API_KEY > OPENAI_API_KEY > XAI_API_KEY', () => {
    assert.equal(resolveLlmProviderConfig({ OPENAI_API_KEY: 'a', XAI_API_KEY: 'b' }).apiKeyEnvVar, 'OPENAI_API_KEY');
    assert.equal(resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'x', OPENAI_API_KEY: 'a' }).apiKeyEnvVar, 'AIDM_LLM_API_KEY');
  });

  it('Grok/xAI via AIDM_LLM_ENDPOINT + AIDM_LLM_MODEL, or XAI_API_KEY alone', () => {
    const c = resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'k', AIDM_LLM_ENDPOINT: DEFAULT_XAI_ENDPOINT, AIDM_LLM_MODEL: 'grok-4-fast' });
    assert.equal(c.kind, 'xai');
    assert.equal(c.model, 'grok-4-fast');
    assert.equal(c.billingProviderId, 'api.x.ai');
    const x = resolveLlmProviderConfig({ XAI_API_KEY: 'k' });
    assert.equal(x.endpoint, DEFAULT_XAI_ENDPOINT);
    assert.equal(x.kind, 'xai');
  });

  it('CLI overrides win over env', () => {
    const c = resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'k', AIDM_LLM_MODEL: 'a' }, { model: 'b', endpoint: DEFAULT_XAI_ENDPOINT });
    assert.equal(c.model, 'b');
    assert.equal(c.kind, 'xai');
  });

  it('rejects insecure, credentialed, non-chat or malformed endpoints', () => {
    for (const e of ['http://api.x.ai/v1/chat/completions', 'https://u:p@api.x.ai/v1/chat/completions', 'https://api.x.ai/v1/responses', 'not a url']) {
      assert.throws(() => resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'k', AIDM_LLM_ENDPOINT: e }), LlmProviderConfigError, e);
    }
    assert.doesNotThrow(() => resolveLlmProviderConfig({ AIDM_LLM_ENDPOINT: 'http://localhost:8080/v1/chat/completions', AIDM_LLM_MODEL: 'm' }));
    assert.throws(() => resolveLlmProviderConfig({ AIDM_LLM_ENDPOINT: 'https://llm.example.com/v1/chat/completions' }), /AIDM_LLM_MODEL/);
  });

  it('pricing env: both values required; non-negative', () => {
    assert.throws(() => resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'k', AIDM_LLM_INPUT_USD_PER_MTOK: '1' }), /together/);
    assert.throws(() => resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'k', AIDM_LLM_INPUT_USD_PER_MTOK: '-1', AIDM_LLM_OUTPUT_USD_PER_MTOK: '1' }), /non-negative/);
    const c = resolveLlmProviderConfig({ AIDM_LLM_API_KEY: 'k', AIDM_LLM_INPUT_USD_PER_MTOK: '3', AIDM_LLM_OUTPUT_USD_PER_MTOK: '15' });
    assert.deepEqual(c.pricing, { input: 3, output: 15, cachedInput: undefined });
  });

  it('budget cannot be bypassed: xAI without declared pricing fails closed; with pricing it registers host-scoped rate', () => {
    const bm = new BudgetManager();
    bm.open();
    const noPrice = resolveLlmProviderConfig({ XAI_API_KEY: 'k' });
    assert.throws(() => registerProviderBudgetTerms(noPrice, bm), /pricing/i);
    const priced = resolveLlmProviderConfig({ XAI_API_KEY: 'k', AIDM_LLM_INPUT_USD_PER_MTOK: '3', AIDM_LLM_OUTPUT_USD_PER_MTOK: '15' });
    registerProviderBudgetTerms(priced, bm);
    const rate = bm.getPricingRate('api.x.ai', 'grok-4');
    assert.ok(rate);
    assert.equal(rate!.inputRateNum * 1_000_000n / rate!.inputRateDen, 3_000_000_000n); // $3 / 1M tokens in nano-USD per 1M
    assert.ok(bm.getPricingRate('xai', 'grok-4'));
    bm.close();
  });

  it('OpenAI gpt-4o uses built-in verified pricing (no env pricing needed)', () => {
    const bm = new BudgetManager();
    bm.open();
    assert.doesNotThrow(() => registerProviderBudgetTerms(resolveLlmProviderConfig({ OPENAI_API_KEY: 'k' }), bm));
    bm.close();
  });

  it('provider creation needs a key; description never leaks the secret', () => {
    assert.throws(() => createConfiguredLlmProvider(resolveLlmProviderConfig({}), {}), /API key/);
    const env = { XAI_API_KEY: 'xai-SECRET-123' };
    const c = resolveLlmProviderConfig(env);
    const p = createConfiguredLlmProvider(c, env);
    assert.equal(p.defaultModel, 'grok-4');
    const desc = JSON.stringify(describeLlmProviderConfig(c));
    assert.ok(!desc.includes('SECRET'));
    assert.ok(desc.includes('XAI_API_KEY'));
  });
});
