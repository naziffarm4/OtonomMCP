import type {
  ExecutorInstruction,
  NormalizedExecutorResult,
  ExecutorAvailability,
  ExecutorOperationType,
} from './instruction-types.js';

/**
 * Production-grade abstraction boundary through which the Orchestrator
 * instructs an implementation executor (e.g., Antigravity or external provider).
 * 
 * The Orchestrator depends on this interface, not directly on an Antigravity-specific
 * implementation, allowing future executors/providers without changing the orchestration domain.
 * 
 * Conceptually:
 * Orchestrator
 *     ↓
 * ExecutorPort
 *     ↓
 * AntigravityAdapter
 *     ↓
 * Antigravity / external executor
 */
export interface ExecutorPort {
  /** Unique identifier of the executor instance */
  readonly executorId: string;

  /** Canonical name of the executor provider (e.g. 'antigravity') */
  readonly provider: string;

  /** List of operations supported by this executor */
  readonly supportedOperations: readonly ExecutorOperationType[];

  /**
   * Probes the runtime environment to verify whether the executor is installed,
   * accessible, and ready to accept instructions.
   */
  checkAvailability(): Promise<ExecutorAvailability>;

  /**
   * Dispatches a strongly typed executor instruction through the adapter boundary,
   * producing a normalized execution result with preserved raw execution outcome.
   * 
   * Throws structured errors for invalid instructions, unsupported operations,
   * security violations, unavailable executors, or unhandled failures.
   */
  execute(instruction: ExecutorInstruction): Promise<NormalizedExecutorResult>;
}
