/**
 * Test doubles loaded by a detached worker (worker-main.js) when AIDM_WORKER_ALLOW_TEST_DOUBLES=1 and
 * AIDM_WORKER_TEST_DOUBLES points here. Mock Director LLM + mock AGY (optionally slow), no paid calls.
 */
import { InMemoryIdentityManager, MockAgyExecutor, MockDirectorLlm } from './autonomous-test-doubles.ts';
import type { BudgetManager } from '../../dist/budget/index.js';

export function createWorkerDoubles(root: string) {
  const agy = new MockAgyExecutor(root);
  const delay = Number(process.env.AIDM_TEST_AGY_DELAY_MS ?? '0') || 0;
  if (delay > 0) agy.onExecute = () => new Promise((r) => setTimeout(r, delay));
  return {
    llmProvider: new MockDirectorLlm(),
    allowMockProvider: true,
    executorPort: agy,
    identityManager: new InMemoryIdentityManager({ baseDir: root }),
    registerBudgetTerms: (bm: BudgetManager) =>
      bm.registerPricingRate({ providerId: 'mock-autonomous', modelId: 'mock-director-1', inputRateNum: 1_000n, inputRateDen: 1n, outputRateNum: 2_000n, outputRateDen: 1n }),
  };
}
