// ============================================================================
// 1. CONTEXT PRIORITY MATRIX (Architecture Section 8 & Section 9)
// ============================================================================

/**
 * Authoritative Context Priority Matrix (Architecture Section 8):
 * 
 * P0 (Mandatory / Never Pruned):
 *   - User requirements (REQ-xxx)
 *   - Active acceptance criteria (AC-xxx)
 *   - Active error message and full stack trace
 * 
 * P1 (High Priority):
 *   - Latest unified diff chunk
 *   - Target file interfaces and method signatures
 *   - Directly relevant source files
 * 
 * P2 (Medium Priority):
 *   - Relevant architectural decisions (DEC-xxx)
 *   - Directly dependent task states
 * 
 * P3 (Low Priority):
 *   - Last two attempt error and strategy summaries
 * 
 * P4 (First to Prune):
 *   - Old task history
 *   - Unrelated file lists
 * 
 * Subsystem Boundary:
 * The Token Budget subsystem accepts already-classified context items (or explicit priority mappings).
 * It enforces deterministic selection, retention, and pruning according to these priority levels
 * without inventing ad-hoc heuristic classification logic.
 */
export const ContextPriority = {
  P0: 'P0', // Mandatory — cannot be pruned merely because budget is exceeded
  P1: 'P1', // High priority — unified diffs, targeted interfaces, direct source files
  P2: 'P2', // Medium priority — architectural decisions (DEC-xxx), dependent task states
  P3: 'P3', // Low priority — recent 2-attempt error & strategy summary
  P4: 'P4', // First to prune — legacy task history, unrelated file lists
} as const;

export type ContextPriority = (typeof ContextPriority)[keyof typeof ContextPriority];
export const CONTEXT_PRIORITIES = Object.values(ContextPriority) as readonly ContextPriority[];

export function isContextPriority(value: unknown): value is ContextPriority {
  return typeof value === 'string' && (CONTEXT_PRIORITIES as readonly string[]).includes(value);
}

// Numerical rank for retention priority (lower rank = retained first; P0 highest, P4 lowest)
export const PRIORITY_RETENTION_RANK: Record<ContextPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

// Numerical rank for pruning order (higher rank = pruned first; P4 pruned before P3 before P2 before P1)
export const PRIORITY_PRUNE_ORDER: Record<ContextPriority, number> = {
  P4: 0,
  P3: 1,
  P2: 2,
  P1: 3,
  P0: 4, // Never pruned
};

// ============================================================================
// 2. TOKEN TELEMETRY MODEL (Architecture Section 9)
// ============================================================================

export interface TokenTelemetry {
  reported_input_tokens: number | null;
  reported_output_tokens: number | null;
  reported_cached_tokens: number | null;
  estimated_tokens: number;
  estimated_cost_usd: number | null;
  provider_name: string | null;
  model: string | null;
  is_exact_provider_metric: boolean;
}

// ============================================================================
// 3. MODEL PRICING SPECIFICATION (Explicit Rates for Defensible Calculation)
// ============================================================================

export interface ModelPricing {
  promptTokenRateUsdPerMillion?: number;
  completionTokenRateUsdPerMillion?: number;
  cachedTokenRateUsdPerMillion?: number;
  promptTokenRateUsd?: number;
  completionTokenRateUsd?: number;
  cachedTokenRateUsd?: number;
}

// ============================================================================
// 4. CONTEXT BUDGET ITEM & RESULT
// ============================================================================

export interface ContextBudgetItem<T = unknown> {
  id: string;
  priority: ContextPriority;
  tokens: number;
  content?: string;
  data?: T;
}

export const BudgetSelectionStatus = {
  WITHIN_BUDGET: 'WITHIN_BUDGET',
  PRUNED_TO_FIT: 'PRUNED_TO_FIT',
  P0_EXCEEDS_BUDGET: 'P0_EXCEEDS_BUDGET',
} as const;

export type BudgetSelectionStatus =
  (typeof BudgetSelectionStatus)[keyof typeof BudgetSelectionStatus];

export interface BudgetResult<T = unknown> {
  status: BudgetSelectionStatus;
  tokenBudget: number;
  totalSelectedTokens: number;
  totalPrunedTokens: number;
  remainingBudget: number;
  isP0OverBudget: boolean;
  selectedItems: ContextBudgetItem<T>[];
  prunedItems: ContextBudgetItem<T>[];
  prunedByPriority: Record<ContextPriority, number>;
}

export interface BudgetOptions {
  throwOnP0OverBudget?: boolean;
  tieBreaker?: (a: ContextBudgetItem, b: ContextBudgetItem) => number;
}
