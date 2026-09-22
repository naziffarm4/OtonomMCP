import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  TokenBudgetEngine,
  TokenBudgetError,
  ContextPriority,
  BudgetSelectionStatus,
  createExactTelemetry,
  createEstimatedTelemetry,
  normalizeTelemetry,
  combineTelemetry,
  calculateTokenCost,
  estimateContextTokens,
  ContextEngine,
  ContextIntent,
  TaskDagEngine,
  RecoveryEngine,
  DurableStateManager,
  LifecycleState,
  AidmError,
  type ContextBudgetItem,
  type TokenTelemetry,
  type ModelPricing,
} from '../dist/index.js';

describe('Token Budget & Telemetry Subsystem (TASK-P2-04)', () => {
  let tempWorkspace: string;
  let cacheDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-budget-'));
    cacheDir = path.join(tempWorkspace, '.ai-manager', 'cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    dbPath = path.join(cacheDir, 'context.db');
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ==========================================================================
  // MANDATORY VERIFICATION SCENARIOS (T1 - T27)
  // ==========================================================================

  describe('Mandatory Verification Scenarios (T1 - T27)', () => {
    // ------------------------------------------------------------------------
    // T1: Exact provider input-token metric is preserved
    // ------------------------------------------------------------------------
    it('T1: Exact provider input-token metric is preserved', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 1420,
        providerName: 'openai',
        model: 'gpt-4o',
      });

      assert.equal(telemetry.reported_input_tokens, 1420);
      assert.equal(telemetry.is_exact_provider_metric, true);
      assert.equal(telemetry.provider_name, 'openai');
      assert.equal(telemetry.model, 'gpt-4o');
    });

    // ------------------------------------------------------------------------
    // T2: Exact provider output-token metric is preserved
    // ------------------------------------------------------------------------
    it('T2: Exact provider output-token metric is preserved', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 1000,
        reportedOutputTokens: 350,
      });

      assert.equal(telemetry.reported_input_tokens, 1000);
      assert.equal(telemetry.reported_output_tokens, 350);
      assert.equal(telemetry.is_exact_provider_metric, true);
    });

    // ------------------------------------------------------------------------
    // T3: Exact cached-token metric is preserved when supplied
    // ------------------------------------------------------------------------
    it('T3: Exact cached-token metric is preserved when supplied', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 2048,
        reportedCachedTokens: 1024,
      });

      assert.equal(telemetry.reported_input_tokens, 2048);
      assert.equal(telemetry.reported_cached_tokens, 1024);
      assert.equal(telemetry.is_exact_provider_metric, true);
    });

    // ------------------------------------------------------------------------
    // T4: Missing provider metrics remain unavailable rather than fabricated
    // ------------------------------------------------------------------------
    it('T4: Missing provider metrics remain unavailable rather than fabricated', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 500,
      });

      assert.equal(telemetry.reported_output_tokens, null);
      assert.equal(telemetry.reported_cached_tokens, null);
      assert.equal(telemetry.estimated_cost_usd, null);
      assert.equal(telemetry.provider_name, null);
      assert.equal(telemetry.model, null);
    });

    // ------------------------------------------------------------------------
    // T5: Estimated token count is explicitly marked as estimated
    // ------------------------------------------------------------------------
    it('T5: Estimated token count is explicitly marked as estimated (is_exact_provider_metric: false)', () => {
      const telemetry = createEstimatedTelemetry({
        text: 'This is a sample text for token estimation.',
      });

      assert.equal(telemetry.is_exact_provider_metric, false);
      assert.ok(telemetry.estimated_tokens > 0);
      assert.equal(telemetry.reported_input_tokens, null);
      assert.equal(telemetry.reported_output_tokens, null);
      assert.equal(telemetry.reported_cached_tokens, null);
      assert.equal(telemetry.estimated_cost_usd, null);
    });

    // ------------------------------------------------------------------------
    // T6: Existing deterministic token-estimation semantics are preserved
    // ------------------------------------------------------------------------
    it('T6: Existing deterministic token-estimation semantics are preserved (Math.ceil(length / 4))', () => {
      const text = 'abcdefghijklmnop'; // 16 chars -> 4 tokens
      const fromEstimator = estimateContextTokens(text);
      const fromTelemetry = createEstimatedTelemetry({ text });

      assert.equal(fromEstimator.estimated_tokens, 4);
      assert.equal(fromTelemetry.estimated_tokens, 4);
      assert.equal(fromEstimator.is_exact_provider_metric, false);
      assert.equal(fromTelemetry.is_exact_provider_metric, false);
    });

    // ------------------------------------------------------------------------
    // T7: Exact and estimated telemetry can coexist without ambiguity
    // ------------------------------------------------------------------------
    it('T7: Exact and estimated telemetry can coexist without ambiguity', () => {
      const exact = createExactTelemetry({
        reportedInputTokens: 100,
        reportedOutputTokens: 20,
      });
      const estimated = createEstimatedTelemetry({
        text: '12345678', // 2 tokens
      });

      assert.equal(exact.is_exact_provider_metric, true);
      assert.equal(exact.reported_input_tokens, 100);

      assert.equal(estimated.is_exact_provider_metric, false);
      assert.equal(estimated.reported_input_tokens, null);

      const combined = combineTelemetry(exact, estimated);
      assert.equal(combined.is_exact_provider_metric, false);
      assert.equal(combined.reported_input_tokens, null);
      assert.equal(combined.estimated_tokens, 122);
    });

    // ------------------------------------------------------------------------
    // T8: Cost remains null when pricing information is unavailable
    // ------------------------------------------------------------------------
    it('T8: Cost remains null when pricing information is unavailable', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 1000,
        reportedOutputTokens: 200,
      });

      const costNoPricing = calculateTokenCost(telemetry, null);
      const costUndefined = calculateTokenCost(telemetry, undefined);
      const costEmptyObj = calculateTokenCost(telemetry, {});

      assert.equal(costNoPricing, null);
      assert.equal(costUndefined, null);
      assert.equal(costEmptyObj, null);
    });

    // ------------------------------------------------------------------------
    // T9: Cost is calculated correctly when valid pricing and valid token metrics are explicitly supplied
    // ------------------------------------------------------------------------
    it('T9: Cost is calculated correctly when valid pricing and valid token metrics are explicitly supplied', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 1_000_000,
        reportedOutputTokens: 500_000,
        reportedCachedTokens: 200_000,
      });

      const pricing: ModelPricing = {
        promptTokenRateUsdPerMillion: 2.50,       // $2.50 / 1M prompt tokens
        completionTokenRateUsdPerMillion: 10.00,   // $10.00 / 1M completion tokens
        cachedTokenRateUsdPerMillion: 1.25,       // $1.25 / 1M cached prompt tokens
      };

      // Input calculation:
      // Non-cached: 800,000 * 2.50 / 1M = $2.00
      // Cached: 200,000 * 1.25 / 1M = $0.25
      // Output: 500,000 * 10.00 / 1M = $5.00
      // Total: 2.00 + 0.25 + 5.00 = $7.25
      const cost = calculateTokenCost(telemetry, pricing);
      assert.equal(cost, 7.25);
    });

    // ------------------------------------------------------------------------
    // T10: Incomplete pricing does not produce fabricated cost
    // ------------------------------------------------------------------------
    it('T10: Incomplete pricing does not produce fabricated cost', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 1000,
        reportedOutputTokens: 500, // Output tokens are present
      });

      // Pricing only supplies promptTokenRate, completion rate is missing
      const incompletePricing: ModelPricing = {
        promptTokenRateUsdPerMillion: 5.00,
      };

      const cost = calculateTokenCost(telemetry, incompletePricing);
      assert.equal(cost, null, 'Incomplete pricing must return null, never fabricated cost');
    });

    // ------------------------------------------------------------------------
    // T10b: Incomplete pricing for reported cached tokens returns null (no rate invention)
    // ------------------------------------------------------------------------
    it('T10b: Incomplete pricing for reported cached tokens returns null, never inventing cached rates', () => {
      const telemetry = createExactTelemetry({
        reportedInputTokens: 1000,
        reportedOutputTokens: 500,
        reportedCachedTokens: 250,
      });

      // Pricing supplies prompt and completion rates, but omits cachedTokenRateUsd / cachedTokenRateUsdPerMillion
      const pricingMissingCached: ModelPricing = {
        promptTokenRateUsdPerMillion: 3.00,
        completionTokenRateUsdPerMillion: 15.00,
      };

      const cost = calculateTokenCost(telemetry, pricingMissingCached);
      assert.equal(cost, null, 'When cached tokens are reported, missing cached rate must return null');
    });

    // ------------------------------------------------------------------------
    // T11: P0 items are mandatory
    // ------------------------------------------------------------------------
    it('T11: P0 items are mandatory and retained even under tight budget', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-p0', priority: ContextPriority.P0, tokens: 500 },
        { id: 'item-p1', priority: ContextPriority.P1, tokens: 200 },
        { id: 'item-p4', priority: ContextPriority.P4, tokens: 100 },
      ];

      // Budget is 550: fits P0 (500), cannot fit both P1 and P4
      const result = engine.applyBudget(items, 550);

      assert.ok(result.selectedItems.some((i) => i.id === 'item-p0'));
      assert.equal(result.isP0OverBudget, false);
      assert.equal(result.prunedByPriority.P0, 0);
    });

    // ------------------------------------------------------------------------
    // T12: P4 is pruned before P3
    // ------------------------------------------------------------------------
    it('T12: P4 is pruned before P3', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-p3', priority: ContextPriority.P3, tokens: 300 },
        { id: 'item-p4', priority: ContextPriority.P4, tokens: 300 },
      ];

      // Budget of 350 allows only one item: P3 must be selected, P4 must be pruned first
      const result = engine.applyBudget(items, 350);

      assert.equal(result.selectedItems.length, 1);
      assert.equal(result.selectedItems[0].id, 'item-p3');
      assert.equal(result.prunedItems.length, 1);
      assert.equal(result.prunedItems[0].id, 'item-p4');
    });

    // ------------------------------------------------------------------------
    // T13: P3 is pruned before P2
    // ------------------------------------------------------------------------
    it('T13: P3 is pruned before P2', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-p2', priority: ContextPriority.P2, tokens: 250 },
        { id: 'item-p3', priority: ContextPriority.P3, tokens: 250 },
      ];

      // Budget of 300 allows only one item: P2 must be selected, P3 must be pruned
      const result = engine.applyBudget(items, 300);

      assert.equal(result.selectedItems.length, 1);
      assert.equal(result.selectedItems[0].id, 'item-p2');
      assert.equal(result.prunedItems.length, 1);
      assert.equal(result.prunedItems[0].id, 'item-p3');
    });

    // ------------------------------------------------------------------------
    // T14: P2 is pruned before P1
    // ------------------------------------------------------------------------
    it('T14: P2 is pruned before P1', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-p1', priority: ContextPriority.P1, tokens: 200 },
        { id: 'item-p2', priority: ContextPriority.P2, tokens: 200 },
      ];

      // Budget of 250 allows only one item: P1 selected, P2 pruned
      const result = engine.applyBudget(items, 250);

      assert.equal(result.selectedItems.length, 1);
      assert.equal(result.selectedItems[0].id, 'item-p1');
      assert.equal(result.prunedItems.length, 1);
      assert.equal(result.prunedItems[0].id, 'item-p2');
    });

    // ------------------------------------------------------------------------
    // T15: P1 is pruned before P0
    // ------------------------------------------------------------------------
    it('T15: P1 is pruned before P0', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-p0', priority: ContextPriority.P0, tokens: 400 },
        { id: 'item-p1', priority: ContextPriority.P1, tokens: 400 },
      ];

      // Budget of 500: P0 fits, P1 must be pruned
      const result = engine.applyBudget(items, 500);

      assert.equal(result.selectedItems.length, 1);
      assert.equal(result.selectedItems[0].id, 'item-p0');
      assert.equal(result.prunedItems.length, 1);
      assert.equal(result.prunedItems[0].id, 'item-p1');
    });

    // ------------------------------------------------------------------------
    // T16: P0 is never silently pruned
    // ------------------------------------------------------------------------
    it('T16: P0 is never silently pruned even if budget is 0', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'mandatory-req', priority: ContextPriority.P0, tokens: 600 },
        { id: 'optional-file', priority: ContextPriority.P4, tokens: 100 },
      ];

      // Budget 100 is strictly smaller than P0 (600)
      const result = engine.applyBudget(items, 100);

      // P0 MUST NOT be pruned
      assert.equal(result.isP0OverBudget, true);
      assert.equal(result.status, BudgetSelectionStatus.P0_EXCEEDS_BUDGET);
      assert.ok(result.selectedItems.some((i) => i.id === 'mandatory-req'));
      assert.equal(result.prunedByPriority.P0, 0);
    });

    // ------------------------------------------------------------------------
    // T17: Mandatory P0 content exceeding the budget produces an explicit result or structured error
    // ------------------------------------------------------------------------
    it('T17: Mandatory P0 exceeding budget produces structured error when assertWithinBudget is called', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'p0-heavy', priority: ContextPriority.P0, tokens: 1000 },
      ];

      assert.throws(
        () => {
          engine.assertWithinBudget(items, 500);
        },
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.equal(err.code, 'ERR_MANDATORY_BUDGET_EXCEEDED');
          assert.ok(err instanceof AidmError);
          assert.equal(err.p0Tokens, 1000);
          assert.equal(err.budget, 500);
          return true;
        }
      );
    });

    // ------------------------------------------------------------------------
    // T18: Equal-priority items use a deterministic tie-break
    // ------------------------------------------------------------------------
    it('T18: Equal-priority items use a deterministic tie-break (id ascending)', () => {
      const engine = new TokenBudgetEngine();
      const itemsShuffled: ContextBudgetItem[] = [
        { id: 'z-item', priority: ContextPriority.P1, tokens: 100 },
        { id: 'a-item', priority: ContextPriority.P1, tokens: 100 },
        { id: 'm-item', priority: ContextPriority.P1, tokens: 100 },
      ];

      // Budget 150 allows only 1 item: 'a-item' must be picked over 'm-item' and 'z-item'
      const result = engine.applyBudget(itemsShuffled, 150);

      assert.equal(result.selectedItems.length, 1);
      assert.equal(result.selectedItems[0].id, 'a-item');
    });

    // ------------------------------------------------------------------------
    // T19: Repeated identical budget calculations produce identical results
    // ------------------------------------------------------------------------
    it('T19: Repeated identical budget calculations produce identical results', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-3', priority: ContextPriority.P2, tokens: 80 },
        { id: 'item-1', priority: ContextPriority.P1, tokens: 100 },
        { id: 'item-2', priority: ContextPriority.P3, tokens: 50 },
        { id: 'item-0', priority: ContextPriority.P0, tokens: 200 },
      ];

      const res1 = engine.applyBudget(items, 320);
      const res2 = engine.applyBudget(items, 320);

      assert.deepEqual(res1, res2);
    });

    // ------------------------------------------------------------------------
    // T20: Caller input is not mutated
    // ------------------------------------------------------------------------
    it('T20: Caller input is not mutated', () => {
      const engine = new TokenBudgetEngine();
      const originalItem: ContextBudgetItem = {
        id: 'orig',
        priority: ContextPriority.P1,
        tokens: 150,
      };
      const items = [originalItem];
      const itemsCopy = [{ ...originalItem }];

      engine.applyBudget(items, 100);

      assert.deepEqual(items, itemsCopy, 'Input items array and objects must remain unmodified');
    });

    // ------------------------------------------------------------------------
    // T21: Invalid budget is rejected structurally
    // ------------------------------------------------------------------------
    it('T21: Invalid budget is rejected structurally', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-1', priority: ContextPriority.P1, tokens: 50 },
      ];

      assert.throws(
        () => engine.applyBudget(items, -10),
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.equal(err.code, 'ERR_INVALID_TOKEN_BUDGET');
          return true;
        }
      );

      assert.throws(
        () => engine.applyBudget(items, NaN),
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.equal(err.code, 'ERR_INVALID_TOKEN_BUDGET');
          return true;
        }
      );
    });

    // ------------------------------------------------------------------------
    // T22: Invalid priority is rejected structurally
    // ------------------------------------------------------------------------
    it('T22: Invalid priority is rejected structurally', () => {
      const engine = new TokenBudgetEngine();
      const items = [
        { id: 'item-invalid-priority', priority: 'INVALID_P' as any, tokens: 50 },
      ];

      assert.throws(
        () => engine.applyBudget(items, 100),
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.equal(err.code, 'ERR_INVALID_CONTEXT_PRIORITY');
          return true;
        }
      );
    });

    // ------------------------------------------------------------------------
    // T23: Malformed context item is rejected structurally
    // ------------------------------------------------------------------------
    it('T23: Malformed context item is rejected structurally', () => {
      const engine = new TokenBudgetEngine();

      // Missing id
      assert.throws(
        () => engine.applyBudget([{ id: '', priority: ContextPriority.P1, tokens: 50 }], 100),
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.equal(err.code, 'ERR_MALFORMED_BUDGET_ITEM');
          return true;
        }
      );

      // Negative tokens
      assert.throws(
        () => engine.applyBudget([{ id: 'neg', priority: ContextPriority.P1, tokens: -50 }], 100),
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.equal(err.code, 'ERR_MALFORMED_BUDGET_ITEM');
          return true;
        }
      );
    });

    // ------------------------------------------------------------------------
    // T24: Phase 1 regression tests remain green
    // ------------------------------------------------------------------------
    it('T24: Phase 1 regression tests remain green', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: null,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const decision = await recoveryEngine.reconcile();
      assert.ok(decision);
      assert.ok(['RESUME', 'RESTART', 'PROCEED', 'BLOCKED_ON_HUMAN', 'RETRY'].includes(decision.decision));

      recoveryEngine.close();
    });

    // ------------------------------------------------------------------------
    // T25: P2-01 regression tests remain green
    // ------------------------------------------------------------------------
    it('T25: P2-01 regression tests remain green (TaskDagEngine)', () => {
      const dag = new TaskDagEngine();
      const task = {
        task_id: 'TASK-VERIFY-P2-04',
        parent_feature_id: 'FEAT-P2-TASK-CONTEXT-ENGINE',
        title: 'Token Budget regression check',
        description: 'Verify DAG engine remains fully operational',
        traceability_sources: ['SYSTEM_REQUIREMENT: CONTEXT_ENGINE'],
        dependencies: [],
        acceptance_criteria: ['AC-1'],
        status: 'READY' as const,
        attempt: 0,
        max_attempts: 3,
        priority: 'HIGH' as const,
        risk_level: 'SAFE' as const,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK' as const,
      };

      const res = dag.validateTask(task);
      assert.equal(res.valid, true);
    });

    // ------------------------------------------------------------------------
    // T26: P2-02 regression tests remain green
    // ------------------------------------------------------------------------
    it('T26: P2-02 regression tests remain green (ContextEngine L0/L1/L2)', async () => {
      const filePath = path.join(tempWorkspace, 'test-p2-02.ts');
      await fs.promises.writeFile(filePath, 'export function add(a: number, b: number) { return a + b; }');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l0 = await engine.getL0Context('test-p2-02.ts');
      const l1 = await engine.getL1Context('test-p2-02.ts');
      const l2 = await engine.getL2Context('test-p2-02.ts');

      assert.equal(l0.layer, 'L0');
      assert.equal(l1.layer, 'L1');
      assert.equal(l2.layer, 'L2');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // T27: P2-03 regression tests remain green
    // ------------------------------------------------------------------------
    it('T27: P2-03 regression tests remain green (Stale Context Invalidation)', async () => {
      const filePath = path.join(tempWorkspace, 'stale-check.ts');
      await fs.promises.writeFile(filePath, 'export const V1 = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const resolved = await engine.resolveContext({
        sourcePaths: ['stale-check.ts'],
        intent: ContextIntent.METADATA,
      });

      // Initially valid
      const vInitial = await engine.validateContext(resolved);
      assert.equal(vInitial.isValid, true);

      // Mutate disk
      await fs.promises.writeFile(filePath, 'export const V2 = 2;');
      const vStale = await engine.validateContext(resolved);
      assert.equal(vStale.isValid, false);
      assert.equal(vStale.action, 'CONTEXT_INVALIDATED');

      engine.close();
    });
  });

  // ==========================================================================
  // ADDITIONAL INTEGRATION & EDGE CASES
  // ==========================================================================

  describe('Budget Engine ResolvedContext Adapter & Normalization', () => {
    it('should budget a ResolvedContext instance using budgetResolvedContext', async () => {
      const fileA = path.join(tempWorkspace, 'a.ts');
      const fileB = path.join(tempWorkspace, 'b.ts');
      await fs.promises.writeFile(fileA, 'export const A = "short";');
      await fs.promises.writeFile(fileB, 'export const B = "a very long content requiring more tokens".repeat(10);');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const resolved = await engine.resolveContext({
        sourcePaths: ['a.ts', 'b.ts'],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      const budgetEngine = new TokenBudgetEngine();
      const budgeted = budgetEngine.budgetResolvedContext(
        resolved,
        resolved.totalEstimatedTokens + 10,
        {
          'a.ts': ContextPriority.P0,
          'b.ts': ContextPriority.P1,
        }
      );

      assert.equal(budgeted.status, BudgetSelectionStatus.WITHIN_BUDGET);
      assert.equal(budgeted.selectedItems.length, 2);

      engine.close();
    });

    it('should normalize partial raw telemetry correctly', () => {
      const normalized = normalizeTelemetry({
        reported_input_tokens: 150,
        is_exact_provider_metric: true,
      });

      assert.equal(normalized.reported_input_tokens, 150);
      assert.equal(normalized.reported_output_tokens, null);
      assert.equal(normalized.is_exact_provider_metric, true);
      assert.equal(normalized.estimated_tokens, 150);
    });
  });

  // ==========================================================================
  // AUTHORITATIVE PRIORITY SELECTION & PRUNING EDGE CASES (CORRECTION REVIEW)
  // ==========================================================================

  describe('Authoritative Priority Selection & Pruning Edge Cases (Correction Review)', () => {
    it('proves: P0 selected, P1 oversized pruned, P2 small enough selected, P3/P4 deterministic', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'p0-req', priority: ContextPriority.P0, tokens: 200 },
        { id: 'p1-oversized-diff', priority: ContextPriority.P1, tokens: 500 },
        { id: 'p2-small-decision', priority: ContextPriority.P2, tokens: 100 },
        { id: 'p3-small-summary', priority: ContextPriority.P3, tokens: 50 },
        { id: 'p4-history', priority: ContextPriority.P4, tokens: 50 },
      ];

      // Total tokens = 200 + 500 + 100 + 50 + 50 = 900.
      // Budget = 350.
      // 1. Mandatory P0 (200 tokens) is selected. Remaining budget = 350 - 200 = 150.
      // 2. Candidate P1 (500 tokens) > 150: oversized -> PRUNED. Remaining budget = 150.
      // 3. Candidate P2 (100 tokens) <= 150: fits -> SELECTED. Remaining budget = 150 - 100 = 50.
      // 4. Candidate P3 (50 tokens) <= 50: fits -> SELECTED. Remaining budget = 50 - 50 = 0.
      // 5. Candidate P4 (50 tokens) > 0: does not fit -> PRUNED. Remaining budget = 0.
      const result = engine.applyBudget(items, 350);

      assert.equal(result.status, BudgetSelectionStatus.PRUNED_TO_FIT);
      assert.equal(result.tokenBudget, 350);
      assert.equal(result.totalSelectedTokens, 350);
      assert.equal(result.totalPrunedTokens, 550); // 500 (P1) + 50 (P4)
      assert.equal(result.remainingBudget, 0);
      assert.equal(result.isP0OverBudget, false);

      // Verify selected items
      const selectedIds = result.selectedItems.map((i) => i.id);
      assert.deepEqual(selectedIds, ['p0-req', 'p2-small-decision', 'p3-small-summary']);

      // Verify pruned items
      const prunedIds = result.prunedItems.map((i) => i.id);
      // Pruned items reporting order is P4 -> P3 -> P2 -> P1
      assert.deepEqual(prunedIds, ['p4-history', 'p1-oversized-diff']);

      // Verify pruned count by priority
      assert.deepEqual(result.prunedByPriority, {
        P0: 0,
        P1: 1,
        P2: 0,
        P3: 0,
        P4: 1,
      });
    });

    it('proves: selected higher-priority item is never removed merely because lower priority items would fit better', () => {
      const engine = new TokenBudgetEngine();
      // Scenario: Budget = 100.
      // P1 takes 90 tokens (leaves 10 tokens unused).
      // Two P2 items take 50 tokens each (together 100 tokens, which would achieve 100% budget utilization).
      // The engine MUST retain the P1 item and prune the P2 items, NEVER swapping P1 out for P2s.
      const items: ContextBudgetItem[] = [
        { id: 'p1-item', priority: ContextPriority.P1, tokens: 90 },
        { id: 'p2-item-a', priority: ContextPriority.P2, tokens: 50 },
        { id: 'p2-item-b', priority: ContextPriority.P2, tokens: 50 },
      ];

      const result = engine.applyBudget(items, 100);

      assert.equal(result.selectedItems.length, 1);
      assert.equal(result.selectedItems[0].id, 'p1-item');
      assert.equal(result.totalSelectedTokens, 90);
      assert.equal(result.remainingBudget, 10);

      assert.equal(result.prunedItems.length, 2);
      assert.ok(result.prunedItems.some((i) => i.id === 'p2-item-a'));
      assert.ok(result.prunedItems.some((i) => i.id === 'p2-item-b'));
    });

    it('proves: repeated execution produces identical selected/pruned results across multiple iterations', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'item-d', priority: ContextPriority.P4, tokens: 30 },
        { id: 'item-b', priority: ContextPriority.P1, tokens: 80 },
        { id: 'item-c', priority: ContextPriority.P2, tokens: 40 },
        { id: 'item-a', priority: ContextPriority.P0, tokens: 100 },
      ];

      const firstRun = engine.applyBudget(items, 190);

      for (let i = 0; i < 5; i++) {
        const run = engine.applyBudget(items, 190);
        assert.deepEqual(run, firstRun);
      }
    });

    it('proves: pruning report accurately reflects priority (P4 -> P3 -> P2 -> P1)', () => {
      const engine = new TokenBudgetEngine();
      const items: ContextBudgetItem[] = [
        { id: 'p1-pruned', priority: ContextPriority.P1, tokens: 100 },
        { id: 'p2-pruned', priority: ContextPriority.P2, tokens: 100 },
        { id: 'p3-pruned', priority: ContextPriority.P3, tokens: 100 },
        { id: 'p4-pruned', priority: ContextPriority.P4, tokens: 100 },
      ];

      // Budget = 0: everything is pruned
      const result = engine.applyBudget(items, 0);

      // Pruning order must report P4 first, then P3, then P2, then P1
      const prunedPriorities = result.prunedItems.map((i) => i.priority);
      assert.deepEqual(prunedPriorities, ['P4', 'P3', 'P2', 'P1']);
    });
  });
});

