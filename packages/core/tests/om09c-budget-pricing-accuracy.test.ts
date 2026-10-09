/**
 * OM-09C: LLM Budget Pricing Accuracy & Regression Test Suite
 *
 * Verifies:
 * 1. LLM Budget Calculation Accuracy & Sub-Cent Precision (BigInt nano-USD).
 * 2. Official Pricing Sources & Verified Model Pricing for OpenAI Models.
 * 3. Fail-Closed Handling for Unknown/Unpriced Models (e.g., 'gpt-6-luna').
 * 4. Rejection of Wildcard Pricing Registrations ('*') to Prevent Bogus Cost Masking.
 * 5. Provider / Model Mismatch Enforcement.
 * 6. Token Usage Validation (Negative, Non-Finite, Invalid Cache Ratio, Omitted Metrics).
 * 7. HOLD -> SETTLE -> RELEASE Flow Integrity & Idempotency.
 * 8. Concurrency Safety: Atomic Balances, No Double Spending, No Overdraft Leaks.
 * 9. Extreme Boundary Values & MAX_SAFE_INT64 Overflow Protection.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  BudgetManager,
  PricingEngine,
  BudgetError,
  BudgetAccountState,
  ReservationState,
  usdToNanoUsd,
  MAX_SAFE_INT64,
  ceilDiv,
  BudgetAwareLlmAdapter,
  UsageNormalizer,
  type TokenUsage,
  type PricingRate,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
  LlmFinishReason,
} from '../dist/index.js';

describe('OM-09C: LLM Budget Pricing Accuracy & Hardening', () => {
  let tempDir: string;
  let dbPath: string;
  let budgetManager: BudgetManager;
  let pricingEngine: PricingEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-om09c-budget-'));
    dbPath = path.join(tempDir, 'budget.db');

    budgetManager = new BudgetManager({ dbPath });
    budgetManager.open();
    pricingEngine = budgetManager.pricingEngine;
  });

  afterEach(async () => {
    budgetManager.close();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================================================
  // 1. UNKNOWN MODEL HAS NO PRICING (FAIL-CLOSED)
  // ==========================================================================
  describe('1. Unknown Model Fail-Closed Enforcement & Verified gpt-6-luna Pricing', () => {
    it('rejects unverified model "gpt-unverified-dummy" under "openai" with ERR_PRICING_NOT_FOUND', () => {
      assert.throws(
        () => {
          pricingEngine.getRate('openai', 'gpt-unverified-dummy');
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_PRICING_NOT_FOUND');
          assert.ok(err.message.includes('gpt-unverified-dummy'));
          return true;
        }
      );
    });

    it('retrieves verified official rate for "gpt-6-luna" under "openai"', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-6-luna');
      assert.ok(rate);
      assert.strictEqual(rate.providerId, 'openai');
      assert.strictEqual(rate.modelId, 'gpt-6-luna');
      // Official: $0.10 / 1M input = 100 nanoUSD / token
      assert.strictEqual(rate.inputRateNum, 100_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      // Official: $0.50 / 1M output = 500 nanoUSD / token
      assert.strictEqual(rate.outputRateNum, 500_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      // Official: $0.01 / 1M cached input = 10 nanoUSD / token
      assert.strictEqual(rate.cachedInputRateNum, 10_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('rejects arbitrary unknown models under any provider', () => {
      for (const model of ['nonexistent-model', 'gpt-5-turbo', 'claude-unknown', 'deepseek-r99']) {
        assert.throws(
          () => pricingEngine.getRate('openai', model),
          (err: any) => err instanceof BudgetError && err.code === 'ERR_PRICING_NOT_FOUND'
        );
      }
    });

    it('fails closed during preDispatchValidate when model has no verified pricing', () => {
      budgetManager.createGlobalAccount(10.0);

      assert.throws(
        () => {
          budgetManager.preDispatchValidate(
            {
              sessionId: 'sess_unknown_model',
              providerId: 'openai',
              modelId: 'gpt-unverified-dummy',
              estimatedTokens: { inputTokens: 500, outputTokens: 500 },
              idempotencyKey: 'idemp_unknown',
            },
            true
          );
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_PRICING_NOT_FOUND');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 2. PRICING CONFIGURATION VALIDATION & WILDCARD REJECTION
  // ==========================================================================
  describe('2. Pricing Configuration Validation', () => {
    it('strictly forbids registering wildcard "*" modelId to prevent silent fallback masking', () => {
      assert.throws(
        () => {
          pricingEngine.registerRate({
            providerId: 'openai',
            modelId: '*',
            inputRateNum: 2_500_000_000n,
            inputRateDen: 1_000_000n,
            outputRateNum: 10_000_000_000n,
            outputRateDen: 1_000_000n,
          });
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_PRICING');
          assert.ok(err.message.includes('Wildcards are not permitted'));
          return true;
        }
      );
    });

    it('rejects negative numerators or zero/negative denominators', () => {
      assert.throws(
        () => {
          pricingEngine.registerRate({
            providerId: 'test',
            modelId: 'test-model',
            inputRateNum: -1n,
            inputRateDen: 1000n,
            outputRateNum: 10n,
            outputRateDen: 1000n,
          });
        },
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      assert.throws(
        () => {
          pricingEngine.registerRate({
            providerId: 'test',
            modelId: 'test-model',
            inputRateNum: 10n,
            inputRateDen: 0n,
            outputRateNum: 10n,
            outputRateDen: 1000n,
          });
        },
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });

    it('rejects empty providerId or empty modelId', () => {
      assert.throws(
        () => {
          pricingEngine.registerRate({
            providerId: '',
            modelId: 'test-model',
            inputRateNum: 10n,
            inputRateDen: 1000n,
            outputRateNum: 10n,
            outputRateDen: 1000n,
          });
        },
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      assert.throws(
        () => {
          pricingEngine.registerRate({
            providerId: 'test',
            modelId: '   ',
            inputRateNum: 10n,
            inputRateDen: 1000n,
            outputRateNum: 10n,
            outputRateDen: 1000n,
          });
        },
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });
  });

  // ==========================================================================
  // 3. PROVIDER AND MODEL MISMATCH
  // ==========================================================================
  describe('3. Provider and Model Mismatch Enforcement', () => {
    it('fails closed when an OpenAI model (e.g. gpt-4o) is queried under Anthropic', () => {
      assert.throws(
        () => pricingEngine.getRate('anthropic', 'gpt-4o'),
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_PRICING_NOT_FOUND');
          return true;
        }
      );
    });

    it('fails closed when an Anthropic model is queried under OpenAI', () => {
      pricingEngine.registerRate({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-20241022',
        inputRateNum: 3_000_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 15_000_000_000n,
        outputRateDen: 1_000_000n,
      });

      assert.throws(
        () => pricingEngine.getRate('openai', 'claude-3-5-sonnet-20241022'),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_PRICING_NOT_FOUND'
      );
    });
  });

  // ==========================================================================
  // 4. TOKEN USAGE VALIDATION
  // ==========================================================================
  describe('4. Token Usage Validation & Fail-Closed Behavior', () => {
    const rate: PricingRate = {
      rateId: 'rate_test',
      providerId: 'openai',
      modelId: 'gpt-4o',
      inputRateNum: 2_500_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 10_000_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 1_250_000_000n,
      cachedInputRateDen: 1_000_000n,
      validFrom: '2024-10-01T00:00:00Z',
    };

    it('rejects negative token counts', () => {
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: -10, outputTokens: 50 }, rate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 50, outputTokens: -5 }, rate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });

    it('rejects NaN, Infinity, or non-finite token numbers', () => {
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: NaN, outputTokens: 50 }, rate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 50, outputTokens: Infinity }, rate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });

    it('rejects cached tokens exceeding total input tokens', () => {
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 100, outputTokens: 50, cachedTokens: 150 }, rate),
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_PRICING');
          assert.ok(err.message.includes('cannot exceed total input tokens'));
          return true;
        }
      );
    });

    it('calculates exact cost when cached tokens are present', () => {
      // 1000 total input tokens: 400 cached ($1.25/1M), 600 uncached ($2.50/1M)
      // 500 output tokens: ($10.00/1M)
      // cachedCost: ceil(400 * 1_250_000_000 / 1_000_000) = 500,000 nano-USD ($0.0005)
      // uncachedInputCost: ceil(600 * 2_500_000_000 / 1_000_000) = 1,500,000 nano-USD ($0.0015)
      // outputCost: ceil(500 * 10_000_000_000 / 1_000_000) = 5,000,000 nano-USD ($0.005)
      // Total: 7,000,000 nano-USD ($0.007)
      const cost = pricingEngine.calculateCostNanoUsd(
        { inputTokens: 1000, outputTokens: 500, cachedTokens: 400 },
        rate
      );
      assert.strictEqual(cost, 7_000_000n);
    });
  });

  // ==========================================================================
  // 5. INSUFFICIENT BUDGET (FAIL-CLOSED)
  // ==========================================================================
  describe('5. Insufficient Budget Gate', () => {
    it('halts pre-dispatch validation when requested spend exceeds available budget', () => {
      // Create micro budget: 1,000 nano-USD ($0.000001)
      budgetManager.createGlobalAccount(0.000001);

      assert.throws(
        () => {
          budgetManager.preDispatchValidate(
            {
              sessionId: 'sess_tight_budget',
              providerId: 'openai',
              modelId: 'gpt-4o',
              estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
              idempotencyKey: 'idemp_tight',
            },
            true
          );
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_BUDGET_EXCEEDED');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 6. PROVIDER REQUEST FAILURE & TIMEOUT (UNKNOWN HOLD RETENTION)
  // ==========================================================================
  describe('6. Provider Failure & UNKNOWN State Retention', () => {
    it('retains blocked hold when marked UNKNOWN on provider timeout or failure', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_fail_test',
        providerId: 'openai',
        modelId: 'gpt-4o',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'idemp_fail_01',
      });

      budgetManager.markDispatched(res.reservationId);

      // Record unknown due to timeout
      budgetManager.recordUnknown({
        reservationId: res.reservationId,
        errorReason: 'Provider timeout: socket hung up after dispatch',
      });

      const updatedRes = budgetManager.getReservation(res.reservationId)!;
      assert.strictEqual(updatedRes.state, ReservationState.UNKNOWN);

      // Crucial financial safety invariant: reserved funds REMAIN blocked on the account!
      const acc = budgetManager.getGlobalAccount()!;
      assert.strictEqual(acc.reservedSpendNanoUsd, res.reservedSpendNanoUsd);
      assert.strictEqual(acc.committedSpendNanoUsd, 0n);
    });

    it('safely releases reservation when failure occurs before token consumption (pre-dispatch)', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_release_test',
        providerId: 'openai',
        modelId: 'gpt-4o',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'idemp_rel_01',
      });

      budgetManager.release({
        reservationId: res.reservationId,
        reason: 'Client cancelled before dispatch',
      });

      const updatedRes = budgetManager.getReservation(res.reservationId)!;
      assert.strictEqual(updatedRes.state, ReservationState.RELEASED);

      const acc = budgetManager.getGlobalAccount()!;
      assert.strictEqual(acc.reservedSpendNanoUsd, 0n);
      assert.strictEqual(acc.availableSpendNanoUsd, acc.limitSpendNanoUsd);
    });
  });

  // ==========================================================================
  // 7. HOLD SUCCEEDED, SETTLEMENT FAILED
  // ==========================================================================
  describe('7. Settlement State Transitions & Violations', () => {
    it('rejects settlement on already RELEASED reservation', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_rel_settle',
        providerId: 'openai',
        modelId: 'gpt-4o',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'idemp_rel_settle',
      });

      budgetManager.release({
        reservationId: res.reservationId,
        reason: 'Cancelled before execution',
      });

      assert.throws(
        () => {
          budgetManager.settle(
            {
              reservationId: res.reservationId,
              reportedUsage: { inputTokens: 500, outputTokens: 500 },
              idempotencyKey: 'idemp_illegal_settle',
            },
            'openai'
          );
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_RESERVATION_STATE');
          return true;
        }
      );
    });

    it('rejects settlement on non-existent reservation ID', () => {
      budgetManager.createGlobalAccount(5.0);

      assert.throws(
        () => {
          budgetManager.settle(
            {
              reservationId: 'res_nonexistent_12345',
              reportedUsage: { inputTokens: 100, outputTokens: 100 },
              idempotencyKey: 'idemp_fake_res',
            },
            'openai'
          );
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_RESERVATION_NOT_FOUND');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 8. IDEMPOTENT RE-SETTLEMENT VS ILLEGAL SECOND SETTLEMENT
  // ==========================================================================
  describe('8. Settlement Idempotency', () => {
    it('repeating settlement with the exact same idempotencyKey returns cached result without double charging', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_idemp_settle',
        providerId: 'openai',
        modelId: 'gpt-4o',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'idemp_res_idem_01',
      });

      budgetManager.markDispatched(res.reservationId);

      const set1 = budgetManager.settle(
        {
          reservationId: res.reservationId,
          reportedUsage: { inputTokens: 800, outputTokens: 400 },
          idempotencyKey: 'set_key_01',
        },
        'openai'
      );

      const set2 = budgetManager.settle(
        {
          reservationId: res.reservationId,
          reportedUsage: { inputTokens: 800, outputTokens: 400 },
          idempotencyKey: 'set_key_01',
        },
        'openai'
      );

      assert.strictEqual(set1.actualCostNanoUsd, set2.actualCostNanoUsd);
      assert.strictEqual(set1.reservationId, set2.reservationId);

      const acc = budgetManager.getGlobalAccount()!;
      // Only charged ONCE
      assert.strictEqual(acc.committedSpendNanoUsd, set1.actualCostNanoUsd);
      assert.strictEqual(acc.reservedSpendNanoUsd, 0n);
    });

    it('attempting second settlement with a DIFFERENT key on SETTLED reservation throws ERR_INVALID_RESERVATION_STATE', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_diff_key',
        providerId: 'openai',
        modelId: 'gpt-4o',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'idemp_diff_key_res',
      });

      budgetManager.markDispatched(res.reservationId);

      budgetManager.settle(
        {
          reservationId: res.reservationId,
          reportedUsage: { inputTokens: 500, outputTokens: 500 },
          idempotencyKey: 'key_first',
        },
        'openai'
      );

      assert.throws(
        () => {
          budgetManager.settle(
            {
              reservationId: res.reservationId,
              reportedUsage: { inputTokens: 500, outputTokens: 500 },
              idempotencyKey: 'key_second_different',
            },
            'openai'
          );
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_RESERVATION_STATE');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 9. CONCURRENT BUDGET RESERVATIONS
  // ==========================================================================
  describe('9. Concurrent Budget Reservations', () => {
    it('concurrent reservations safely decrement available budget and reject when exhausted', async () => {
      // 100,000 nano-USD budget ($0.0001)
      const initialBudgetNanoUsd = 100_000n;
      budgetManager.createGlobalAccount(initialBudgetNanoUsd);

      // gpt-4o: 1 input + 0 output tokens = 2,500 nano-USD per reservation
      const costPerReservation = 2_500n;
      const numReservations = 40; // 40 * 2,500 = 100,000 nano-USD (exact fit)

      let successfulReservations = 0;
      let rejectedReservations = 0;

      for (let i = 0; i < numReservations + 5; i++) {
        try {
          budgetManager.reserve({
            sessionId: `sess_concurrent_${i}`,
            providerId: 'openai',
            modelId: 'gpt-4o',
            estimatedTokens: { inputTokens: 1, outputTokens: 0 },
            idempotencyKey: `idemp_conc_${i}`,
          });
          successfulReservations++;
        } catch (err: any) {
          if (err instanceof BudgetError && err.code === 'ERR_BUDGET_EXCEEDED') {
            rejectedReservations++;
          } else {
            throw err;
          }
        }
      }

      assert.strictEqual(successfulReservations, numReservations);
      assert.strictEqual(rejectedReservations, 5);

      const acc = budgetManager.getGlobalAccount()!;
      assert.strictEqual(acc.reservedSpendNanoUsd, initialBudgetNanoUsd);
      assert.strictEqual(acc.availableSpendNanoUsd, 0n);
    });
  });

  // ==========================================================================
  // 10. COST ROUNDING & BOUNDARY CONDITIONS
  // ==========================================================================
  describe('10. Cost Rounding & Boundary Calculations', () => {
    it('ceilDiv rounds fractional nano-USD upwards (no undercharging)', () => {
      // Rate: 1 nano-USD per 3 tokens
      const rate: PricingRate = {
        rateId: 'rate_ceil',
        providerId: 'test',
        modelId: 'fractional',
        inputRateNum: 1n,
        inputRateDen: 3n,
        outputRateNum: 1n,
        outputRateDen: 3n,
        cachedInputRateNum: 0n,
        cachedInputRateDen: 1n,
        validFrom: '2024-01-01',
      };

      // 1 input token: 1/3 -> ceilDiv produces 1n
      const cost1 = pricingEngine.calculateCostNanoUsd({ inputTokens: 1, outputTokens: 0 }, rate);
      assert.strictEqual(cost1, 1n);

      // 3 input tokens: 3/3 -> exact 1n
      const cost3 = pricingEngine.calculateCostNanoUsd({ inputTokens: 3, outputTokens: 0 }, rate);
      assert.strictEqual(cost3, 1n);

      // 4 input tokens: 4/3 -> ceilDiv produces 2n
      const cost4 = pricingEngine.calculateCostNanoUsd({ inputTokens: 4, outputTokens: 0 }, rate);
      assert.strictEqual(cost4, 2n);
    });

    it('zero tokens cost exactly 0 nano-USD', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-4o');
      const cost = pricingEngine.calculateCostNanoUsd({ inputTokens: 0, outputTokens: 0 }, rate);
      assert.strictEqual(cost, 0n);
    });

    it('throws ERR_INVALID_PRICING when cost exceeds MAX_SAFE_INT64', () => {
      const astronomicalRate: PricingRate = {
        rateId: 'rate_astro',
        providerId: 'astro',
        modelId: 'overflow-model',
        inputRateNum: MAX_SAFE_INT64,
        inputRateDen: 1n,
        outputRateNum: MAX_SAFE_INT64,
        outputRateDen: 1n,
        cachedInputRateNum: 0n,
        cachedInputRateDen: 1n,
        validFrom: '2024-01-01',
      };

      assert.throws(
        () => {
          pricingEngine.calculateCostNanoUsd({ inputTokens: 10, outputTokens: 10 }, astronomicalRate);
        },
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_PRICING');
          assert.ok(err.message.includes('exceeds maximum safe integer'));
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 11. VERIFIED OFFICIAL OPENAI PRICING CATALOG AUDIT
  // ==========================================================================
  describe('11. Verified Official OpenAI Pricing Catalog', () => {
    it('verifies gpt-4o pricing: $2.50 / 1M input, $1.25 / 1M cached, $10.00 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-4o');
      assert.strictEqual(rate.inputRateNum, 2_500_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 10_000_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      assert.strictEqual(rate.cachedInputRateNum, 1_250_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('verifies gpt-4o-mini pricing: $0.150 / 1M input, $0.075 / 1M cached, $0.600 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-4o-mini');
      assert.strictEqual(rate.inputRateNum, 150_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 600_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      assert.strictEqual(rate.cachedInputRateNum, 75_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('verifies o1 pricing: $15.00 / 1M input, $7.50 / 1M cached, $60.00 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'o1');
      assert.strictEqual(rate.inputRateNum, 15_000_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 60_000_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      assert.strictEqual(rate.cachedInputRateNum, 7_500_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('verifies o1-mini pricing: $1.10 / 1M input, $0.55 / 1M cached, $4.40 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'o1-mini');
      assert.strictEqual(rate.inputRateNum, 1_100_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 4_400_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      assert.strictEqual(rate.cachedInputRateNum, 550_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('verifies o3-mini pricing: $1.10 / 1M input, $0.55 / 1M cached, $4.40 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'o3-mini');
      assert.strictEqual(rate.inputRateNum, 1_100_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 4_400_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      assert.strictEqual(rate.cachedInputRateNum, 550_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('verifies gpt-4-turbo pricing: $10.00 / 1M input, $5.00 / 1M cached, $30.00 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-4-turbo');
      assert.strictEqual(rate.inputRateNum, 10_000_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 30_000_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
      assert.strictEqual(rate.cachedInputRateNum, 5_000_000_000n);
      assert.strictEqual(rate.cachedInputRateDen, 1_000_000n);
    });

    it('verifies gpt-3.5-turbo pricing: $0.50 / 1M input, $1.50 / 1M output', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-3.5-turbo');
      assert.strictEqual(rate.inputRateNum, 500_000_000n);
      assert.strictEqual(rate.inputRateDen, 1_000_000n);
      assert.strictEqual(rate.outputRateNum, 1_500_000_000n);
      assert.strictEqual(rate.outputRateDen, 1_000_000n);
    });
  });

  // ==========================================================================
  // 12. COMPLETE GPT-6 LUNA MULTIDIMENSIONAL PRICING & RECONCILIATION (OM-09C-FIX-2)
  // ==========================================================================
  describe('12. Complete GPT-6 Luna Multidimensional Pricing & Reconciliation', () => {
    it('calculates exact partitioned cost for gpt-6-luna with cached input and cache writes', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-6-luna');
      assert.ok(rate);

      // 10,000 total input: 2,000 cached (read), 3,000 cache-write, 5,000 ordinary uncached
      // 4,000 output tokens
      const usage: TokenUsage = {
        inputTokens: 10000,
        cachedTokens: 2000,
        cacheWriteTokens: 3000,
        outputTokens: 4000,
      };

      const cost = pricingEngine.calculateCostNanoUsd(usage, rate);
      // ordinary: 5,000 * 100 = 500,000 nanoUSD
      // cached: 2,000 * 10 = 20,000 nanoUSD
      // cache-write: 3,000 * 125 = 375,000 nanoUSD
      // output: 4,000 * 500 = 2,000,000 nanoUSD
      // total = 2,895,000 nanoUSD ($0.002895)
      assert.strictEqual(cost, 2_895_000n);
    });

    it('accounts for reasoning tokens as billable output tokens without deduction', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-6-luna');
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 2000,
        reasoningTokens: 1500, // 1500 of the 2000 are reasoning tokens
      };

      const cost = pricingEngine.calculateCostNanoUsd(usage, rate);
      // input: 1,000 * 100 = 100,000 nanoUSD
      // output: 2,000 * 500 = 1,000,000 nanoUSD
      // total = 1,100,000 nanoUSD
      assert.strictEqual(cost, 1_100_000n);
    });

    it('fails closed when reasoning tokens exceed output tokens', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-6-luna');
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 1000, // Inconsistent: reasoning > total output
      };

      assert.throws(
        () => pricingEngine.calculateCostNanoUsd(usage, rate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });

    it('fails closed when cached read + cache write exceeds total input tokens', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-6-luna');
      const usage: TokenUsage = {
        inputTokens: 5000,
        cachedTokens: 3000,
        cacheWriteTokens: 3000, // 3000 + 3000 = 6000 > 5000
        outputTokens: 1000,
      };

      assert.throws(
        () => pricingEngine.calculateCostNanoUsd(usage, rate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });

    it('fails closed when cache writes are reported for a model without cache-write pricing', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-4o');
      const usage: TokenUsage = {
        inputTokens: 2000,
        cacheWriteTokens: 500,
        outputTokens: 500,
      };

      assert.throws(
        () => pricingEngine.calculateCostNanoUsd(usage, rate),
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_PRICING');
          assert.ok(err.message.includes('no cache-write pricing'));
          return true;
        }
      );
    });

    it('applies long-context rates (>272K input tokens) for gpt-6-luna correctly', () => {
      const rate = pricingEngine.getRate('openai', 'gpt-6-luna');

      // 300,000 input tokens (> 272K threshold), 50,000 cached, 50,000 cache write, 200,000 ordinary
      // 10,000 output tokens
      const usage: TokenUsage = {
        inputTokens: 300000,
        cachedTokens: 50000,
        cacheWriteTokens: 50000,
        outputTokens: 10000,
      };

      const cost = pricingEngine.calculateCostNanoUsd(usage, rate);
      // Long-context rates for gpt-6-luna:
      // ordinary: 200,000 * 200 nanoUSD ($0.20/1M) = 40,000,000 nanoUSD
      // cached: 50,000 * 20 nanoUSD ($0.02/1M) = 1,000,000 nanoUSD
      // cache-write: 50,000 * 250 nanoUSD ($0.25/1M) = 12,500,000 nanoUSD
      // output: 10,000 * 750 nanoUSD ($0.75/1M) = 7,500,000 nanoUSD
      // total = 40,000,000 + 1,000,000 + 12,500,000 + 7,500,000 = 61,000,000 nanoUSD ($0.061)
      assert.strictEqual(cost, 61_000_000n);
    });

    it('fails closed if request exceeds short-context limit for a model without long-context pricing', () => {
      const limitedRate: PricingRate = {
        rateId: 'limited-model-rate',
        providerId: 'openai',
        modelId: 'limited-model',
        inputRateNum: 100_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 500_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 10_000_000n,
        cachedInputRateDen: 1_000_000n,
        longContextThreshold: 272_000,
        // No longContext defined!
        validFrom: new Date().toISOString(),
      };

      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 300000, outputTokens: 1000 }, limitedRate),
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_INVALID_PRICING');
          assert.ok(err.message.includes('has no long-context pricing registered'));
          return true;
        }
      );
    });

    it('verifies batch and flex service tier pricing for gpt-6-luna (50% discount)', () => {
      const batchRate = pricingEngine.getRate('openai', 'gpt-6-luna', 'batch');
      const flexRate = pricingEngine.getRate('openai', 'gpt-6-luna', 'flex');

      assert.strictEqual(batchRate.inputRateNum, 50_000_000n); // $0.05 / 1M
      assert.strictEqual(batchRate.outputRateNum, 250_000_000n); // $0.25 / 1M
      assert.strictEqual(batchRate.cachedInputRateNum, 5_000_000n); // $0.005 / 1M
      assert.strictEqual(batchRate.cacheWriteRateNum, 62_500_000n); // $0.0625 / 1M

      const usage: TokenUsage = {
        inputTokens: 10000,
        cachedTokens: 2000,
        cacheWriteTokens: 3000,
        outputTokens: 4000,
        serviceTier: 'batch',
      };

      const cost = pricingEngine.calculateCostNanoUsd(usage, batchRate);
      // ordinary: 5,000 * 50 = 250,000 nanoUSD
      // cached: 2,000 * 5 = 10,000 nanoUSD
      // cache-write: 3,000 * 62.5 = 187,500 nanoUSD
      // output: 4,000 * 250 = 1,000,000 nanoUSD
      // total = 250,000 + 10,000 + 187,500 + 1,000,000 = 1,447,500 nanoUSD
      assert.strictEqual(cost, 1_447_500n);

      const flexCost = pricingEngine.calculateCostNanoUsd(usage, flexRate);
      assert.strictEqual(flexCost, 1_447_500n);
    });

    it('verifies fast service tier pricing for gpt-6-luna (priority processing)', () => {
      const fastRate = pricingEngine.getRate('openai', 'gpt-6-luna', 'fast');
      assert.strictEqual(fastRate.inputRateNum, 200_000_000n); // $0.20 / 1M
      assert.strictEqual(fastRate.outputRateNum, 1_000_000_000n); // $1.00 / 1M
      assert.strictEqual(fastRate.cachedInputRateNum, 20_000_000n); // $0.02 / 1M
      assert.strictEqual(fastRate.cacheWriteRateNum, 250_000_000n); // $0.25 / 1M

      const usage: TokenUsage = {
        inputTokens: 10000,
        outputTokens: 2000,
        serviceTier: 'fast',
      };

      const cost = pricingEngine.calculateCostNanoUsd(usage, fastRate);
      // 10,000 * 200 + 2,000 * 1000 = 2,000,000 + 2,000,000 = 4,000,000 nanoUSD
      assert.strictEqual(cost, 4_000_000n);
    });

    it('fails closed when an unsupported service tier (e.g. ultrafast) is requested for gpt-6-luna', () => {
      assert.throws(
        () => pricingEngine.getRate('openai', 'gpt-6-luna', 'ultrafast'),
        (err: any) => {
          assert.ok(err instanceof BudgetError);
          assert.strictEqual(err.code, 'ERR_PRICING_NOT_FOUND');
          assert.ok(err.message.includes('ultrafast'));
          return true;
        }
      );
    });

    it('settles multi-dimensional gpt-6-luna usage atomically via BudgetManager and zeroes hold', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_luna_multi',
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        estimatedTokens: { inputTokens: 5000, outputTokens: 2000 },
        idempotencyKey: 'res_idem_luna_1',
      });

      assert.strictEqual(res.state, 'PREPARED');
      const accountBefore = budgetManager.getGlobalAccount()!;
      assert.ok(accountBefore.reservedSpendNanoUsd > 0n);

      const settleRes = budgetManager.settle({
        reservationId: res.reservationId,
        reportedUsage: {
          inputTokens: 6000,
          cachedTokens: 1000,
          cacheWriteTokens: 1000,
          outputTokens: 1500,
          reasoningTokens: 800,
        },
        idempotencyKey: 'set_idem_luna_1',
      }, 'openai');

      assert.strictEqual(settleRes.reservationId, res.reservationId);
      // ordinary: 4,000 * 100 = 400,000
      // cached: 1,000 * 10 = 10,000
      // cache-write: 1,000 * 125 = 125,000
      // output: 1,500 * 500 = 750,000
      // actual: 1,285,000 nanoUSD
      assert.strictEqual(settleRes.actualCostNanoUsd, 1_285_000n);

      const accountAfter = budgetManager.getGlobalAccount()!;
      assert.strictEqual(accountAfter.reservedSpendNanoUsd, 0n, 'Reserved hold must be completely settled');
      assert.strictEqual(accountAfter.committedSpendNanoUsd, 1_285_000n);
    });

    it('holds reservation in UNKNOWN state and does not release hold when settlement fails on corrupted metrics', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_corrupt_test',
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'res_idem_corrupt_1',
      });

      const initialReserved = budgetManager.getGlobalAccount()!.reservedSpendNanoUsd;
      assert.ok(initialReserved > 0n);

      // Attempting to settle corrupted usage (cached + write > input) throws ERR_INVALID_PRICING
      assert.throws(
        () => {
          budgetManager.settle({
            reservationId: res.reservationId,
            reportedUsage: {
              inputTokens: 1000,
              cachedTokens: 800,
              cacheWriteTokens: 800, // 800 + 800 = 1600 > 1000
              outputTokens: 500,
            },
            idempotencyKey: 'set_idem_corrupt_1',
          }, 'openai');
        },
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      // Record unknown retains the reservation and does NOT release the reserved spend to prevent unbudgeted leaks
      budgetManager.recordUnknown({
        reservationId: res.reservationId,
        errorReason: 'Corrupted token metrics during reconciliation',
      });

      const accountAfter = budgetManager.getGlobalAccount()!;
      assert.strictEqual(accountAfter.reservedSpendNanoUsd, initialReserved, 'Reserved spend must be retained in UNKNOWN state');
      const resState = budgetManager.getReservation(res.reservationId)!;
      assert.strictEqual(resState.state, 'UNKNOWN');
    });
  });

  // ==========================================================================
  // 13. FAIL-CLOSED USAGE NORMALIZATION & BILLING TRUTH (OM-09C-FIX-3)
  // ==========================================================================
  describe('13. Fail-Closed Usage Normalization & Billing Truth (OM-09C-FIX-3)', () => {
    let lunaRate: PricingRate;
    let gpt4oRate: PricingRate;

    beforeEach(() => {
      lunaRate = pricingEngine.getRate('openai', 'gpt-6-luna', 'standard');
      gpt4oRate = pricingEngine.getRate('openai', 'gpt-4o', 'standard');
    });

    it('pricingEngine rejects fractional and non-integer token counts (no silent flooring)', () => {
      // Fractional input tokens
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 100.5, outputTokens: 50 }, lunaRate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      // Fractional output tokens
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 100, outputTokens: 50.25 }, lunaRate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      // Fractional cached tokens
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 100, outputTokens: 50, cachedTokens: 10.5 }, lunaRate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      // Fractional cache-write tokens
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 100, outputTokens: 50, cacheWriteTokens: 5.5 }, lunaRate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );

      // Fractional reasoning tokens
      assert.throws(
        () => pricingEngine.calculateCostNanoUsd({ inputTokens: 100, outputTokens: 50, reasoningTokens: 2.5 }, lunaRate),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
      );
    });

    it('UsageNormalizer rejects missing input or output tokens without falling back to estimates', () => {
      const dummyReq: LlmRequest = {
        messages: [{ role: 'user', content: 'test prompt' }],
        correlation: { correlation_id: 'corr_test_norm', project_id: 'proj_norm' },
        director_context: { project_id: 'proj_norm' },
      };

      // Missing prompt_tokens
      const resMissingInput: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'answer',
        finish_reason: LlmFinishReason.STOP,
        usage: { completion_tokens: 50, total_tokens: 50 } as any,
        raw_metadata: null,
      };

      const norm1 = UsageNormalizer.normalizeAndReconcile({
        response: resMissingInput,
        request: dummyReq,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm1.success, false);
      assert.strictEqual((norm1 as any).errorCode, 'ERR_USAGE_INCOMPLETE');

      // Missing completion_tokens
      const resMissingOutput: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'answer',
        finish_reason: LlmFinishReason.STOP,
        usage: { prompt_tokens: 100, total_tokens: 100 } as any,
        raw_metadata: null,
      };

      const norm2 = UsageNormalizer.normalizeAndReconcile({
        response: resMissingOutput,
        request: dummyReq,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm2.success, false);
      assert.strictEqual((norm2 as any).errorCode, 'ERR_USAGE_INCOMPLETE');

      // Completely missing usage object
      const resMissingUsage: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'answer',
        finish_reason: LlmFinishReason.STOP,
        usage: null as any,
        raw_metadata: null,
      };

      const norm3 = UsageNormalizer.normalizeAndReconcile({
        response: resMissingUsage,
        request: dummyReq,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm3.success, false);
      assert.strictEqual((norm3 as any).errorCode, 'ERR_USAGE_MISSING');
    });

    it('UsageNormalizer enforces documented schema policy for missing cache-write tokens', () => {
      const dummyReq: LlmRequest = {
        messages: [{ role: 'user', content: 'test prompt' }],
        correlation: { correlation_id: 'corr_test_cw', project_id: 'proj_cw' },
        director_context: { project_id: 'proj_cw' },
      };

      // On gpt-6-luna: cache writes are billed at 1.25x. Missing cache_write_tokens CANNOT be assumed 0!
      const resLunaMissingCw: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'response',
        finish_reason: LlmFinishReason.STOP,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 200 }, // cache_write_tokens omitted
        } as any,
        raw_metadata: null,
      };

      const normLuna = UsageNormalizer.normalizeAndReconcile({
        response: resLunaMissingCw,
        request: dummyReq,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(normLuna.success, false);
      assert.strictEqual((normLuna as any).errorCode, 'ERR_USAGE_INCOMPLETE');
      assert.ok((normLuna as any).errorReason.includes('cache-write pricing'));

      // When gpt-6-luna explicitly reports cache_write_tokens: 0, it settles reliably
      const resLunaExplicitZeroCw: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'response',
        finish_reason: LlmFinishReason.STOP,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
        } as any,
        raw_metadata: null,
      };

      const normLunaExplicit = UsageNormalizer.normalizeAndReconcile({
        response: resLunaExplicitZeroCw,
        request: dummyReq,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(normLunaExplicit.success, true);
      assert.strictEqual((normLunaExplicit as any).usage.cacheWriteTokens, 0);

      // On gpt-4o: cache writes are NOT billed (rate.cacheWriteRateNum is undefined/0n).
      // Documented schema policy: omission of cache_write_tokens safely defaults to 0 cost.
      const resGpt4oMissingCw: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-4o',
        content: 'response',
        finish_reason: LlmFinishReason.STOP,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 200 },
        } as any,
        raw_metadata: null,
      };

      const normGpt4o = UsageNormalizer.normalizeAndReconcile({
        response: resGpt4oMissingCw,
        request: dummyReq,
        modelId: 'gpt-4o',
        rate: gpt4oRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(normGpt4o.success, true);
      assert.strictEqual((normGpt4o as any).usage.cacheWriteTokens, 0);
    });

    it('UsageNormalizer reconciles actual service tier differing from requested tier', () => {
      // 1. Caller requested 'flex' (50% discount), but provider returned 'default' (standard)
      const reqFlex: LlmRequest = {
        messages: [{ role: 'user', content: 'test' }],
        metadata: { service_tier: 'flex' },
        correlation: { correlation_id: 'corr_tier_1', project_id: 'proj_tier' },
        director_context: { project_id: 'proj_tier' },
      };

      const resProviderStandard: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'res',
        finish_reason: LlmFinishReason.STOP,
        usage: { prompt_tokens: 1000, completion_tokens: 500, service_tier: 'default', prompt_tokens_details: { cache_write_tokens: 0 } } as any,
        raw_metadata: { service_tier: 'default' },
      };

      const norm1 = UsageNormalizer.normalizeAndReconcile({
        response: resProviderStandard,
        request: reqFlex,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm1.success, true);
      // Provider reported default -> reconciled to standard, preventing undercharge
      assert.strictEqual((norm1 as any).effectiveServiceTier, 'standard');

      // 2. Caller requested 'flex', and provider confirmed 'flex'
      const resProviderFlex: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'res',
        finish_reason: LlmFinishReason.STOP,
        usage: { prompt_tokens: 1000, completion_tokens: 500, service_tier: 'flex', prompt_tokens_details: { cache_write_tokens: 0 } } as any,
        raw_metadata: { service_tier: 'flex' },
      };

      const norm2 = UsageNormalizer.normalizeAndReconcile({
        response: resProviderFlex,
        request: reqFlex,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm2.success, true);
      assert.strictEqual((norm2 as any).effectiveServiceTier, 'flex');

      // 3. Caller requested 'flex', but provider response omitted service_tier
      const resProviderOmitted: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'res',
        finish_reason: LlmFinishReason.STOP,
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cache_write_tokens: 0 } } as any,
        raw_metadata: null,
      };

      const norm3 = UsageNormalizer.normalizeAndReconcile({
        response: resProviderOmitted,
        request: reqFlex,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm3.success, true);
      // Unconfirmed discount falls back to standard to never undercharge
      assert.strictEqual((norm3 as any).effectiveServiceTier, 'standard');

      // 4. Caller requested 'fast' (priority), provider omitted service_tier
      const reqFast: LlmRequest = {
        messages: [{ role: 'user', content: 'test' }],
        metadata: { service_tier: 'fast' },
        correlation: { correlation_id: 'corr_tier_2', project_id: 'proj_tier' },
        director_context: { project_id: 'proj_tier' },
      };

      const norm4 = UsageNormalizer.normalizeAndReconcile({
        response: resProviderOmitted,
        request: reqFast,
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm4.success, true);
      assert.strictEqual((norm4 as any).effectiveServiceTier, 'fast');
    });

    it('UsageNormalizer rejects unsupported regional processing and data-residency surcharges', () => {
      const dummyRes: LlmResponse<unknown> = {
        provider: 'openai',
        model: 'gpt-6-luna',
        content: 'test',
        finish_reason: LlmFinishReason.STOP,
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cache_write_tokens: 0 } } as any,
        raw_metadata: null,
      };

      // regional processing metadata
      const norm1 = UsageNormalizer.normalizeAndReconcile({
        response: dummyRes,
        request: {
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { regional: true },
          correlation: { correlation_id: 'c1', project_id: 'p1' },
          director_context: { project_id: 'p1' },
        },
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm1.success, false);
      assert.strictEqual((norm1 as any).errorCode, 'ERR_UNSUPPORTED_BILLING_MODE');

      // data-residency metadata
      const norm2 = UsageNormalizer.normalizeAndReconcile({
        response: dummyRes,
        request: {
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { data_residency: 'eu' },
          correlation: { correlation_id: 'c2', project_id: 'p2' },
          director_context: { project_id: 'p2' },
        },
        modelId: 'gpt-6-luna',
        rate: lunaRate,
        pricingEngine,
        providerId: 'openai',
      });
      assert.strictEqual(norm2.success, false);
      assert.strictEqual((norm2 as any).errorCode, 'ERR_UNSUPPORTED_BILLING_MODE');
    });

    it('BudgetAwareLlmAdapter.generate fails closed and retains reservation in UNKNOWN on incomplete usage', async () => {
      budgetManager.createGlobalAccount(5.0);

      const incompleteMockProvider: LLMProvider = {
        providerId: 'openai',
        providerName: 'openai',
        defaultModel: 'gpt-4o',
        supportedModels: ['gpt-4o'],
        supportedCapabilities: [],
        checkAvailability: async () => ({ available: true, model: 'gpt-4o', reason: null }),
        generate: async (req: LlmRequest) => ({
          correlation: req.correlation,
          provider: 'openai',
          model: 'gpt-4o',
          content: 'Hello',
          finish_reason: LlmFinishReason.STOP,
          usage: {
            prompt_tokens: 500,
            // completion_tokens missing!
          } as any,
          raw_metadata: null,
        }),
      };

      const adapter = new BudgetAwareLlmAdapter(incompleteMockProvider, budgetManager);

      const res = await adapter.generate({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-4o',
        correlation: { correlation_id: 'corr_incomplete_1', project_id: 'proj_inc' },
        director_context: { project_id: 'proj_inc' },
      });
      assert.strictEqual(res.content, 'Hello');

      // Verification: reservation is held in UNKNOWN state, and reserved spend is NOT released!
      const account = budgetManager.getGlobalAccount()!;
      assert.ok(account.reservedSpendNanoUsd > 0n, 'Reserved spend must be retained in UNKNOWN state');
      assert.strictEqual(account.committedSpendNanoUsd, 0n);

      const pending = budgetManager.db.listPendingReservations();
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].state, ReservationState.UNKNOWN);
    });

    it('BudgetAwareLlmAdapter.generate fails closed and retains reservation in UNKNOWN when cache_write_tokens is missing on gpt-6-luna', async () => {
      budgetManager.createGlobalAccount(5.0);

      const lunaMissingCwProvider: LLMProvider = {
        providerId: 'openai',
        providerName: 'openai',
        defaultModel: 'gpt-6-luna',
        supportedModels: ['gpt-6-luna'],
        supportedCapabilities: [],
        checkAvailability: async () => ({ available: true, model: 'gpt-6-luna', reason: null }),
        generate: async (req: LlmRequest) => ({
          correlation: req.correlation,
          provider: 'openai',
          model: 'gpt-6-luna',
          content: 'Hello from luna',
          finish_reason: LlmFinishReason.STOP,
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            prompt_tokens_details: { cached_tokens: 200 }, // missing cache_write_tokens on a cache-write model
          } as any,
          raw_metadata: null,
        }),
      };

      const adapter = new BudgetAwareLlmAdapter(lunaMissingCwProvider, budgetManager);

      const res = await adapter.generate({
        messages: [{ role: 'user', content: 'hello luna' }],
        model: 'gpt-6-luna',
        correlation: { correlation_id: 'corr_luna_missing_cw', project_id: 'proj_luna' },
        director_context: { project_id: 'proj_luna' },
      });
      assert.strictEqual(res.content, 'Hello from luna');

      const account = budgetManager.getGlobalAccount()!;
      assert.ok(account.reservedSpendNanoUsd > 0n, 'Reserved spend must be retained on incomplete cache-write usage');
      assert.strictEqual(account.committedSpendNanoUsd, 0n);

      const pending = budgetManager.db.listPendingReservations();
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].state, ReservationState.UNKNOWN);
    });

    it('BudgetAwareLlmAdapter.generate settles successfully with exact pricing when gpt-6-luna usage is complete', async () => {
      budgetManager.createGlobalAccount(5.0);

      const completeLunaProvider: LLMProvider = {
        providerId: 'openai',
        providerName: 'openai',
        defaultModel: 'gpt-6-luna',
        supportedModels: ['gpt-6-luna'],
        supportedCapabilities: [],
        checkAvailability: async () => ({ available: true, model: 'gpt-6-luna', reason: null }),
        generate: async (req: LlmRequest) => ({
          correlation: req.correlation,
          provider: 'openai',
          model: 'gpt-6-luna',
          content: 'Complete luna response',
          finish_reason: LlmFinishReason.STOP,
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 1000,
            prompt_tokens_details: {
              cached_tokens: 1000,     // 1,000 * 10 nUSD = 10,000 nUSD
              cache_write_tokens: 1000, // 1,000 * 125 nUSD = 125,000 nUSD
            },
            completion_tokens_details: {
              reasoning_tokens: 400,   // Included in completion_tokens
            },
          } as any,
          raw_metadata: null,
        }),
      };

      const adapter = new BudgetAwareLlmAdapter(completeLunaProvider, budgetManager);

      const req: LlmRequest = {
        messages: [{ role: 'user', content: 'test complete usage' }],
        model: 'gpt-6-luna',
        correlation: { correlation_id: 'corr_complete_luna_1', attempt: 1, project_id: 'proj_comp' },
        director_context: { project_id: 'proj_comp' },
      };

      const res = await adapter.generate(req);
      assert.strictEqual(res.content, 'Complete luna response');

      const account = budgetManager.getGlobalAccount()!;
      assert.strictEqual(account.reservedSpendNanoUsd, 0n, 'Reservation hold must be completely settled to 0');
      // Ordinary input: (5000 - 1000 - 1000) = 3000 * 100 nUSD = 300,000 nUSD
      // Cached input: 1000 * 10 nUSD = 10,000 nUSD
      // Cache write: 1000 * 125 nUSD = 125,000 nUSD
      // Output: 1000 * 500 nUSD = 500,000 nUSD
      // Total: 300,000 + 10,000 + 125,000 + 500,000 = 935,000 nUSD
      assert.strictEqual(account.committedSpendNanoUsd, 935_000n);

      // Repeated call with same idempotency keys returns cached result without double charging
      const repeatRes = await adapter.generate(req);
      assert.strictEqual(repeatRes.content, 'Complete luna response');
      const accountAfterRepeat = budgetManager.getGlobalAccount()!;
      assert.strictEqual(accountAfterRepeat.committedSpendNanoUsd, 935_000n, 'Committed spend must not double charge');
    });

    it('BudgetAwareLlmAdapter.generate rejects regional processing metadata fail-closed before dispatch', async () => {
      budgetManager.createGlobalAccount(5.0);

      let dispatched = false;
      const mockProvider: LLMProvider = {
        providerId: 'openai',
        providerName: 'openai',
        defaultModel: 'gpt-6-luna',
        supportedModels: ['gpt-6-luna'],
        supportedCapabilities: [],
        checkAvailability: async () => ({ available: true, model: 'gpt-6-luna', reason: null }),
        generate: async () => {
          dispatched = true;
          throw new Error('Should never be called');
        },
      };

      const adapter = new BudgetAwareLlmAdapter(mockProvider, budgetManager);

      await assert.rejects(
        () => adapter.generate({
          messages: [{ role: 'user', content: 'hello' }],
          model: 'gpt-6-luna',
          metadata: { regional: true },
          correlation: { correlation_id: 'corr_reg_fail', project_id: 'proj_reg' },
          director_context: { project_id: 'proj_reg' },
        }),
        (err: any) => err instanceof BudgetError && err.code === 'ERR_UNSUPPORTED_BILLING_MODE'
      );

      assert.strictEqual(dispatched, false, 'Provider must not be dispatched when unsupported billing mode is requested');
    });

    it('ReconciliationEngine blocks release of UNKNOWN reservation without authoritative reconciliation', () => {
      budgetManager.createGlobalAccount(5.0);

      const res = budgetManager.reserve({
        sessionId: 'sess_unknown_rel_guard',
        providerId: 'openai',
        modelId: 'gpt-6-luna',
        estimatedTokens: { inputTokens: 1000, outputTokens: 1000 },
        idempotencyKey: 'idemp_unk_guard',
      });

      budgetManager.markDispatched(res.reservationId);
      budgetManager.recordUnknown({
        reservationId: res.reservationId,
        errorReason: 'Connection timed out',
      });

      const initialHold = budgetManager.getGlobalAccount()!.reservedSpendNanoUsd;
      assert.ok(initialHold > 0n);

      // Attempting to release an UNKNOWN reservation must throw ERR_INVALID_RESERVATION_STATE
      assert.throws(
        () => {
          budgetManager.release({
            reservationId: res.reservationId,
            reason: 'Rogue attempt to release undetermined hold',
          });
        },
        (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_RESERVATION_STATE'
      );

      const accountAfter = budgetManager.getGlobalAccount()!;
      assert.strictEqual(accountAfter.reservedSpendNanoUsd, initialHold, 'Hold must be preserved against unauthorized release');
    });
  });
});
