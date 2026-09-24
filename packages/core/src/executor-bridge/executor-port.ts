import type {
  ExecutorInstruction,
  NormalizedExecutorResult,
  ExecutorAvailability,
  ExecutorOperationType,
} from './instruction-types.js';
import type { ExecutionRequest } from './execution-request-types.js';
import type { RawExecutorOutcome } from './raw-executor-outcome.js';

/**
 * Production-grade abstraction boundary through which the Orchestrator
 * instructs an implementation executor (e.g., Antigravity or external provider).
 *
 * Conceptually:
 * Director Decision (P9-03)
 *     ↓
 * ExecutionIntent Authorization (P10-01)
 *     ↓
 * Deterministic ExecutionRequest (P10-02)
 *     ↓
 * ExecutorPort (P10-03)
 *     ↓
 * AntigravityAdapter
 *     ↓
 * RawExecutorOutcome (P10-03)
 *     ↓
 * System Evidence Verification (P10-04)
 */
export interface ExecutorPort<TInput = any, TOutput = any> {
  /** Unique identifier of the executor instance */
  readonly executorId: string;

  /** Canonical name of the executor provider (e.g. 'antigravity') */
  readonly provider: string;

  /** List of operations supported by this executor */
  readonly supportedOperations?: readonly (ExecutorOperationType | string)[];

  /**
   * Probes the runtime environment to verify whether the executor is installed,
   * accessible, and ready to accept instructions.
   */
  checkAvailability?(): Promise<ExecutorAvailability>;

  /**
   * Dispatches an execution request or instruction through the adapter boundary.
   * Phase 10 boundary: ExecutionRequest -> Promise<RawExecutorOutcome>
   * Phase 3 boundary: ExecutorInstruction -> Promise<NormalizedExecutorResult>
   */
  execute(input: TInput): Promise<TOutput>;
}

/**
 * Dedicated strongly typed port contract for Phase 10 ExecutionRequest execution.
 */
export interface ExecutionRequestExecutorPort {
  readonly executorId: string;
  readonly provider: string;
  readonly supportedOperations?: readonly string[];
  checkAvailability?(): Promise<ExecutorAvailability>;
  execute(request: ExecutionRequest, options?: { signal?: AbortSignal }): Promise<RawExecutorOutcome>;
}
