import type { RiskLevel } from '../risk.js';
import type { TaskGraphValidationCategory } from '../errors/task-graph-validation-error.js';

// ============================================================================
// 1. HIERARCHY LEVELS (Section 10: EPIC -> FEATURE -> TASK -> SUBTASK)
// ============================================================================

export const TaskHierarchyLevel = {
  EPIC: 'EPIC',
  FEATURE: 'FEATURE',
  TASK: 'TASK',
  SUBTASK: 'SUBTASK',
} as const;

export type TaskHierarchyLevel = (typeof TaskHierarchyLevel)[keyof typeof TaskHierarchyLevel];
export const TASK_HIERARCHY_LEVELS = Object.values(TaskHierarchyLevel) as readonly TaskHierarchyLevel[];

export function isTaskHierarchyLevel(value: unknown): value is TaskHierarchyLevel {
  return typeof value === 'string' && (TASK_HIERARCHY_LEVELS as readonly string[]).includes(value);
}

// ============================================================================
// 2. TASK STATUS (Section 10: READY, IN_PROGRESS, REVIEW, ACCEPTED, REJECTED, BLOCKED)
// ============================================================================

export const TaskStatus = {
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  REVIEW: 'REVIEW',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  BLOCKED: 'BLOCKED',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const TASK_STATUSES = Object.values(TaskStatus) as readonly TaskStatus[];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

// ============================================================================
// 3. TASK PRIORITY (Section 10: CRITICAL, HIGH, MEDIUM, LOW)
// ============================================================================

export const TaskPriority = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;

export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];
export const TASK_PRIORITIES = Object.values(TaskPriority) as readonly TaskPriority[];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

// ============================================================================
// 4. TRACEABILITY SOURCES (Section 10 & DEC-009: REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT)
// ============================================================================

export const TraceabilityCategory = {
  REQ: 'REQ',
  DEC: 'DEC',
  PARENT_TASK: 'PARENT_TASK',
  PARENT_FEATURE: 'PARENT_FEATURE',
  SYSTEM_REQUIREMENT: 'SYSTEM_REQUIREMENT',
} as const;

export type TraceabilityCategory = (typeof TraceabilityCategory)[keyof typeof TraceabilityCategory];
export const TRACEABILITY_CATEGORIES = Object.values(TraceabilityCategory) as readonly TraceabilityCategory[];

// ============================================================================
// 5. TASK MODEL (Mandatory 15 fields defined in Section 10)
// ============================================================================

export interface TaskDefinition {
  /** Unique task identifier (e.g. "TASK-P1-01") */
  task_id: string;
  /** Parent feature / epic identifier (e.g. "FEAT-P1-CORE-FOUNDATION") */
  parent_feature_id: string;
  /** Descriptive task title */
  title: string;
  /** Technical task description */
  description: string;
  /** Traceability sources: at least one legitimate source (REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT) */
  traceability_sources: string[];
  /** List of prerequisite task IDs */
  dependencies: string[];
  /** Measurable acceptance criteria list (e.g. ["AC-P1-01-1"]) */
  acceptance_criteria: string[];
  /** Execution status */
  status: TaskStatus;
  /** Current attempt counter */
  attempt: number;
  /** Maximum retry attempts */
  max_attempts: number;
  /** Priority level */
  priority: TaskPriority;
  /** AIDM Risk level */
  risk_level: RiskLevel;
  /** ISO 8601 creation timestamp */
  created_at: string;
  /** ISO 8601 start timestamp or null */
  started_at: string | null;
  /** ISO 8601 completion timestamp or null */
  completed_at: string | null;
  /** Structural hierarchy level (EPIC, FEATURE, TASK, SUBTASK) */
  hierarchy_level?: TaskHierarchyLevel;
  /** Extensible metadata */
  metadata?: Record<string, unknown>;
}

export type TaskDefinitionInput = Partial<
  Omit<
    TaskDefinition,
    'task_id' | 'parent_feature_id' | 'title' | 'description' | 'traceability_sources' | 'acceptance_criteria'
  >
> & {
  task_id?: string;
  taskId?: string;
  parent_feature_id?: string;
  parentFeatureId?: string;
  title: string;
  description: string;
  traceability_sources?: string[];
  traceabilitySources?: string[];
  dependencies?: string[];
  acceptance_criteria?: string[];
  acceptanceCriteria?: string[];
  status?: TaskStatus;
  attempt?: number;
  max_attempts?: number;
  maxAttempts?: number;
  priority?: TaskPriority;
  risk_level?: RiskLevel;
  riskLevel?: RiskLevel;
  created_at?: string;
  createdAt?: string;
  started_at?: string | null;
  startedAt?: string | null;
  completed_at?: string | null;
  completedAt?: string | null;
  hierarchy_level?: TaskHierarchyLevel;
  hierarchyLevel?: TaskHierarchyLevel;
  level?: TaskHierarchyLevel;
  metadata?: Record<string, unknown>;
};

// ============================================================================
// 6. VALIDATION RESULT INTERFACES
// ============================================================================

export interface TaskGraphValidationIssue {
  category: TaskGraphValidationCategory;
  taskId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TaskValidationResult {
  valid: boolean;
  task?: TaskDefinition;
  errors: TaskGraphValidationIssue[];
}

export interface GraphValidationResult {
  valid: boolean;
  errors: TaskGraphValidationIssue[];
  topologicalOrder?: string[];
  taskCount: number;
}

export interface TaskGraphModel {
  /** Epics represented in the graph */
  epics?: (TaskDefinitionInput | string)[];
  /** Features represented in the graph */
  features?: (TaskDefinitionInput | string)[];
  /** Tasks to be validated and scheduled in the DAG */
  tasks: TaskDefinitionInput[];
  /** Optional subtasks */
  subtasks?: TaskDefinitionInput[];
}

export type TaskGraphInput = TaskDefinitionInput[] | TaskGraphModel;

export interface TaskGraphOptions {
  /** Known valid feature IDs represented in the graph/model */
  validFeatureIds?: string[] | Set<string>;
  /** Known valid epic IDs represented in the graph/model */
  validEpicIds?: string[] | Set<string>;
  /** Explicit parent nodes represented in the graph/model */
  parentNodes?: TaskDefinitionInput[];
  /** Strict check ensuring parent_feature_id does not reference another task */
  strictHierarchy?: boolean;
}
