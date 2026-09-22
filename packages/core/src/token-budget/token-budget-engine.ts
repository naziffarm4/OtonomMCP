import type {
  ContextBudgetItem,
  BudgetResult,
  BudgetOptions,
  ContextPriority,
} from './budget-types.js';
import {
  ContextPriority as Priorities,
  BudgetSelectionStatus,
  isContextPriority,
  PRIORITY_RETENTION_RANK,
} from './budget-types.js';
import { TokenBudgetError } from '../errors/token-budget-error.js';
import type { ResolvedContext, ContextItem } from '../context-engine/context-types.js';

/**
 * Priority-Weighted Context Budget Engine (Architecture Section 8 & Section 9).
 * 
 * Authoritative Budget Selection Semantics:
 * 1. Retain all P0: Mandatory P0 items are retained and never silently pruned.
 * 2. Process non-P0 items in strict priority order: P1, then P2, then P3, then P4.
 * 3. For each candidate item, include it if it fits the remaining budget (item.tokens <= remainingBudget).
 * 4. If a candidate item does not fit the remaining budget, prune it.
 * 5. Never remove an already-selected higher-priority item merely to fit one or more lower-priority items.
 * 6. Lower-priority items may still be selected into remaining budget even if an earlier higher-priority item was pruned because it was oversized.
 * 7. Pruning order/reporting order is deterministically sorted: P4 -> P3 -> P2 -> P1 (with deterministic tie-breaker).
 * 8. The result explicitly exposes status, selectedItems, prunedItems, and prunedByPriority so decisions are fully auditable.
 */
export class TokenBudgetEngine {
  /**
   * Applies priority-weighted pruning and selection to context budget items according to the 8 authoritative rules.
   *
   * @param items Context items classified by ContextPriority (P0, P1, P2, P3, P4)
   * @param tokenBudget Maximum allowed token count
   * @param options Budget configuration options (throwOnP0OverBudget, tieBreaker)
   * @returns BudgetResult with selectedItems, prunedItems, and audit metrics
   */
  applyBudget<T = unknown>(
    items: ContextBudgetItem<T>[],
    tokenBudget: number,
    options?: BudgetOptions
  ): BudgetResult<T> {
    // 1. Validate tokenBudget
    if (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget < 0) {
      throw new TokenBudgetError(
        `Token budget must be a non-negative finite number, received: ${tokenBudget}`,
        'ERR_INVALID_TOKEN_BUDGET',
        { budget: tokenBudget }
      );
    }

    if (!Array.isArray(items)) {
      throw new TokenBudgetError(
        'Context budget items must be provided as an array',
        'ERR_MALFORMED_BUDGET_ITEM'
      );
    }

    // 2. Validate items
    for (const item of items) {
      this.validateItem(item);
    }

    // 3. Clone and group items without mutating caller input
    const clonedItems = items.map((item) => ({ ...item }));

    const p0Items: ContextBudgetItem<T>[] = [];
    const nonP0Items: ContextBudgetItem<T>[] = [];

    for (const item of clonedItems) {
      if (item.priority === Priorities.P0) {
        p0Items.push(item);
      } else {
        nonP0Items.push(item);
      }
    }

    // 4. Calculate P0 mandatory tokens
    const p0Tokens = p0Items.reduce((sum, item) => sum + item.tokens, 0);
    const isP0OverBudget = p0Tokens > tokenBudget;

    const prunedByPriority: Record<ContextPriority, number> = {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
      P4: 0,
    };

    // 5. If P0 alone exceeds budget:
    // P0 content is mandatory and NEVER silently dropped.
    // All non-P0 content is pruned.
    if (isP0OverBudget) {
      if (options?.throwOnP0OverBudget) {
        throw new TokenBudgetError(
          `Mandatory P0 context tokens (${p0Tokens}) exceeds configured token budget (${tokenBudget})`,
          'ERR_MANDATORY_BUDGET_EXCEEDED',
          {
            budget: tokenBudget,
            p0Tokens,
            totalTokens: p0Tokens,
          }
        );
      }

      // Sort P0 items deterministically by id
      p0Items.sort((a, b) => a.id.localeCompare(b.id));

      // All non-P0 items are pruned
      const prunedItems = [...nonP0Items];
      this.sortPrunedItems(prunedItems, options?.tieBreaker);

      for (const item of prunedItems) {
        prunedByPriority[item.priority] = (prunedByPriority[item.priority] || 0) + 1;
      }

      const totalPrunedTokens = prunedItems.reduce((sum, item) => sum + item.tokens, 0);

      return {
        status: BudgetSelectionStatus.P0_EXCEEDS_BUDGET,
        tokenBudget,
        totalSelectedTokens: p0Tokens,
        totalPrunedTokens,
        remainingBudget: tokenBudget - p0Tokens, // negative remaining budget indicates deficit
        isP0OverBudget: true,
        selectedItems: p0Items,
        prunedItems,
        prunedByPriority,
      };
    }

    // 6. When P0 is within budget:
    // P0 items are retained
    const selectedItems: ContextBudgetItem<T>[] = [...p0Items];
    let remainingBudget = tokenBudget - p0Tokens;

    // 7. Sort candidate non-P0 items for retention:
    // Higher priority retained first: P1 before P2 before P3 before P4.
    // Equal priority uses deterministic tie-breaker (id ascending).
    nonP0Items.sort((a, b) => {
      const rankDiff = PRIORITY_RETENTION_RANK[a.priority] - PRIORITY_RETENTION_RANK[b.priority];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      if (options?.tieBreaker) {
        return options.tieBreaker(a, b);
      }
      return a.id.localeCompare(b.id);
    });

    const prunedItems: ContextBudgetItem<T>[] = [];

    // 8. Select items until budget is reached
    for (const item of nonP0Items) {
      if (item.tokens <= remainingBudget) {
        selectedItems.push(item);
        remainingBudget -= item.tokens;
      } else {
        prunedItems.push(item);
        prunedByPriority[item.priority] = (prunedByPriority[item.priority] || 0) + 1;
      }
    }

    // Deterministically sort final selectedItems: priority ascending (P0 -> P1 -> P2 -> P3 -> P4), then tie-breaker
    selectedItems.sort((a, b) => {
      const rankDiff = PRIORITY_RETENTION_RANK[a.priority] - PRIORITY_RETENTION_RANK[b.priority];
      if (rankDiff !== 0) return rankDiff;
      return a.id.localeCompare(b.id);
    });

    // Deterministically sort prunedItems: priority descending (P4 -> P3 -> P2 -> P1), then tie-breaker
    this.sortPrunedItems(prunedItems, options?.tieBreaker);

    const totalSelectedTokens = selectedItems.reduce((sum, item) => sum + item.tokens, 0);
    const totalPrunedTokens = prunedItems.reduce((sum, item) => sum + item.tokens, 0);

    const status: BudgetSelectionStatus =
      prunedItems.length > 0
        ? BudgetSelectionStatus.PRUNED_TO_FIT
        : BudgetSelectionStatus.WITHIN_BUDGET;

    return {
      status,
      tokenBudget,
      totalSelectedTokens,
      totalPrunedTokens,
      remainingBudget,
      isP0OverBudget: false,
      selectedItems,
      prunedItems,
      prunedByPriority,
    };
  }

  /**
   * Convenience adapter to apply priority-weighted budget selection to a ResolvedContext.
   */
  budgetResolvedContext(
    resolvedContext: ResolvedContext,
    tokenBudget: number,
    priorityMap?: Record<string, ContextPriority>,
    options?: BudgetOptions
  ): BudgetResult<ContextItem> {
    const budgetItems: ContextBudgetItem<ContextItem>[] = resolvedContext.items.map((item) => {
      const priority = priorityMap?.[item.sourcePath] ?? Priorities.P1;
      return {
        id: item.sourcePath,
        priority,
        tokens: item.tokenInfo.estimated_tokens,
        data: item,
      };
    });

    return this.applyBudget(budgetItems, tokenBudget, options);
  }

  /**
   * Asserts that context items fit within the token budget.
   * Throws TokenBudgetError if P0 exceeds budget.
   */
  assertWithinBudget<T = unknown>(
    items: ContextBudgetItem<T>[],
    tokenBudget: number
  ): BudgetResult<T> {
    return this.applyBudget(items, tokenBudget, { throwOnP0OverBudget: true });
  }

  private validateItem(item: unknown): asserts item is ContextBudgetItem {
    if (!item || typeof item !== 'object') {
      throw new TokenBudgetError(
        'Budget item must be an object',
        'ERR_MALFORMED_BUDGET_ITEM'
      );
    }

    const candidate = item as Record<string, unknown>;

    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
      throw new TokenBudgetError(
        'Budget item must have a non-empty string id',
        'ERR_MALFORMED_BUDGET_ITEM',
        { itemId: String(candidate.id) }
      );
    }

    if (!isContextPriority(candidate.priority)) {
      throw new TokenBudgetError(
        `Invalid context priority: '${String(candidate.priority)}'. Expected one of: P0, P1, P2, P3, P4`,
        'ERR_INVALID_CONTEXT_PRIORITY',
        { itemId: candidate.id, priority: String(candidate.priority) }
      );
    }

    if (
      typeof candidate.tokens !== 'number' ||
      !Number.isFinite(candidate.tokens) ||
      candidate.tokens < 0
    ) {
      throw new TokenBudgetError(
        `Budget item '${candidate.id}' tokens must be a non-negative finite number, received: ${candidate.tokens}`,
        'ERR_MALFORMED_BUDGET_ITEM',
        { itemId: candidate.id, field: 'tokens' }
      );
    }
  }

  private sortPrunedItems<T>(
    items: ContextBudgetItem<T>[],
    tieBreaker?: (a: ContextBudgetItem<T>, b: ContextBudgetItem<T>) => number
  ): void {
    // Pruned order: P4 first, then P3, then P2, then P1, then P0
    const pruneOrder: Record<ContextPriority, number> = {
      P4: 0,
      P3: 1,
      P2: 2,
      P1: 3,
      P0: 4,
    };

    items.sort((a, b) => {
      const orderDiff = pruneOrder[a.priority] - pruneOrder[b.priority];
      if (orderDiff !== 0) return orderDiff;
      if (tieBreaker) return tieBreaker(a, b);
      return a.id.localeCompare(b.id);
    });
  }
}
