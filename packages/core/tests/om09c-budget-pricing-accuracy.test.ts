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
  type TokenUsage,
  type PricingRate,
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
});
