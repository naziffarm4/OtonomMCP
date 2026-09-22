import type { ResolvedContext } from './context-types.js';

// ============================================================================
// 1. CONTEXT VALIDATION ACTIONS (Architecture Section 8)
// ============================================================================

export const ContextValidationAction = {
  CONTINUE: 'CONTINUE',                         // OLD_HASH == CURRENT_HASH -> Safe to proceed
  CONTEXT_INVALIDATED: 'CONTEXT_INVALIDATED',   // OLD_HASH != CURRENT_HASH -> Stop operation
  RE_EVALUATE: 'RE-EVALUATE',                   // Context refreshed -> Force model re-evaluation
} as const;

export type ContextValidationAction =
  (typeof ContextValidationAction)[keyof typeof ContextValidationAction];

export const CONTEXT_VALIDATION_ACTIONS = Object.values(
  ContextValidationAction
) as readonly ContextValidationAction[];

export function isContextValidationAction(value: unknown): value is ContextValidationAction {
  return (
    typeof value === 'string' &&
    (CONTEXT_VALIDATION_ACTIONS as readonly string[]).includes(value)
  );
}

// ============================================================================
// 2. STALE FILE DETAIL MODEL
// ============================================================================

export const StaleFileStatus = {
  MODIFIED: 'MODIFIED',
  DELETED: 'DELETED',
  UNREADABLE: 'UNREADABLE',
} as const;

export type StaleFileStatus = (typeof StaleFileStatus)[keyof typeof StaleFileStatus];

export interface StaleFileDetail {
  sourcePath: string;
  oldHash: string;
  currentHash: string | null;
  status: StaleFileStatus;
  reason?: string;
}

// ============================================================================
// 3. PURE DETERMINISTIC VALIDATION RESULT (Architecture Section 10)
// ============================================================================

/**
 * Pure deterministic validation decision result.
 * Strictly excludes non-deterministic execution metadata such as timestamps or random IDs.
 */
export interface ContextValidationResult {
  isValid: boolean;
  action: ContextValidationAction;
  affectedFiles: StaleFileDetail[];
  reason: string;
  contextRequestId?: string;
  taskId?: string;
}

// ============================================================================
// 4. CONTEXT REFRESH RESULT
// ============================================================================

export interface ContextRefreshResult {
  invalidation: ContextValidationResult;
  refreshedContext: ResolvedContext;
  action: 'RE-EVALUATE';
  reason: string;
}

// ============================================================================
// 5. WRITE & OPERATION GUARD RESULT
// ============================================================================

export interface ContextGuardResult {
  allowed: boolean;
  validation: ContextValidationResult;
  targetPath?: string;
}

export interface ContextInvalidatorOptions {
  workspaceRoot: string;
}
