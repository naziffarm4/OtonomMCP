import { AidmError, type AidmErrorDetails } from './aidm-error.js';

/**
 * The 5 Authoritative Task Graph Integrity Check Categories specified in
 * Technical Discovery Section 10:
 * 1. DUPLICATE_ID_CHECK: Every task_id must be unique.
 * 2. MISSING_DEPENDENCY_CHECK: Listed dependencies must exist in the graph.
 * 3. CIRCULAR_DEPENDENCY_CHECK: Cycles detected via Kahn's algorithm.
 * 4. INVALID_PARENT_CHECK: Every task must reference a valid parent_feature_id.
 * 5. TRACEABILITY_SOURCE_CHECK: Every task must have at least one valid traceability source.
 */
export type TaskGraphValidationCategory =
  | 'DUPLICATE_ID_CHECK'
  | 'MISSING_DEPENDENCY_CHECK'
  | 'CIRCULAR_DEPENDENCY_CHECK'
  | 'INVALID_PARENT_CHECK'
  | 'TRACEABILITY_SOURCE_CHECK';

export interface TaskGraphValidationDetails extends AidmErrorDetails {
  category: TaskGraphValidationCategory;
  taskId?: string;
  duplicateId?: string;
  missingDependency?: string;
  missingDependencies?: string[];
  invalidParent?: string;
  invalidSource?: string;
  cycleTasks?: string[];
  cyclePath?: string[];
  reason: string;
}

/**
 * Thrown when a task definition or task graph violates any of the 5 graph integrity checks
 * defined in Technical Discovery Section 10.
 */
export class TaskGraphValidationError extends AidmError {
  readonly category: TaskGraphValidationCategory;
  readonly taskId?: string;

  constructor(
    category: TaskGraphValidationCategory,
    message: string,
    details?: Omit<TaskGraphValidationDetails, 'category' | 'reason'> & {
      taskId?: string;
      reason?: string;
      [key: string]: unknown;
    }
  ) {
    const formattedMessage = message.startsWith(`[${category}]`)
      ? message
      : `[${category}] ${message}`;

    const structuredDetails: TaskGraphValidationDetails = {
      category,
      reason: message,
      ...details,
    };

    super(formattedMessage, 'ERR_TASK_GRAPH_VALIDATION', structuredDetails);
    this.name = 'TaskGraphValidationError';
    this.category = category;
    this.taskId = details?.taskId ?? (details?.duplicateId as string | undefined);

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
