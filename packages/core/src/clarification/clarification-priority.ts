/**
 * Clarification Deterministic Ordering & Semantic Priority (Phase 8 TASK-P8-04)
 *
 * Implements deterministic ordering according to explicit semantic rules:
 * 1. Product intent / scope ambiguity (UNKNOWN_PRODUCT_INTENT)
 * 2. Contradictory authoritative requirements (CONTRADICTORY_REQUIREMENT, CONFLICTING_DOCUMENTATION, CONFLICTING_IMPLEMENTATION)
 * 3. Architecture-impacting ambiguity (UNCLEAR_ENTRYPOINT)
 * 4. Core feature behavior ambiguity (AMBIGUOUS_REQUIREMENT)
 * 5. Runtime/deployment ambiguity (UNCLEAR_RUNTIME_BEHAVIOR)
 * 6. Secondary feature ambiguity (MISSING_REQUIREMENT)
 * 7. Documentation-only uncertainty (OTHER)
 *
 * Tie-breaking rules:
 * - Blocking questions strictly precede non-blocking questions
 * - REQUIRED precedes IMPORTANT, which precedes OPTIONAL
 * - clarificationId lexicographical comparison as final deterministic tie-breaker
 *
 * INVARIANT: No arbitrary numeric scoring system.
 */

import type {
  ClarificationQuestion,
  ClarificationKind,
  ClarificationPriority,
} from './clarification-types.js';

/**
 * Maps ClarificationKind to semantic hierarchy level (1 to 7).
 */
export function getSemanticKindRank(kind: ClarificationKind): number {
  switch (kind) {
    case 'UNKNOWN_PRODUCT_INTENT':
      return 1;
    case 'CONTRADICTORY_REQUIREMENT':
    case 'CONFLICTING_DOCUMENTATION':
    case 'CONFLICTING_IMPLEMENTATION':
      return 2;
    case 'UNCLEAR_ENTRYPOINT':
      return 3;
    case 'AMBIGUOUS_REQUIREMENT':
      return 4;
    case 'UNCLEAR_RUNTIME_BEHAVIOR':
      return 5;
    case 'MISSING_REQUIREMENT':
      return 6;
    case 'OTHER':
    default:
      return 7;
  }
}

/**
 * Maps ClarificationPriority to deterministic order (1 to 3).
 */
export function getPriorityRank(priority: ClarificationPriority): number {
  switch (priority) {
    case 'REQUIRED':
      return 1;
    case 'IMPORTANT':
      return 2;
    case 'OPTIONAL':
      return 3;
    default:
      return 4;
  }
}

/**
 * Deterministically sorts clarification questions according to authoritative semantic rules.
 * Does not mutate the input array; returns a new sorted array.
 */
export function sortClarificationQuestions(
  questions: readonly ClarificationQuestion[]
): ClarificationQuestion[] {
  return [...questions].sort((a, b) => {
    // 1. Semantic category rank
    const rankA = getSemanticKindRank(a.kind);
    const rankB = getSemanticKindRank(b.kind);
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    // 2. Blocking status (blocking first)
    if (a.blocking !== b.blocking) {
      return a.blocking ? -1 : 1;
    }

    // 3. Priority level (REQUIRED > IMPORTANT > OPTIONAL)
    const prioA = getPriorityRank(a.priority);
    const prioB = getPriorityRank(b.priority);
    if (prioA !== prioB) {
      return prioA - prioB;
    }

    // 4. Lexicographical tie-breaker on clarificationId
    return a.clarificationId.localeCompare(b.clarificationId);
  });
}
