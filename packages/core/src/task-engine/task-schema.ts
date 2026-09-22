import { z } from 'zod';
import {
  TASK_HIERARCHY_LEVELS,
  TASK_STATUSES,
  TASK_PRIORITIES,
  type TaskDefinition,
  type TaskValidationResult,
  type TaskGraphValidationIssue,
} from './task-types.js';
import { RISK_LEVELS } from '../risk.js';
import { TaskGraphValidationError } from '../errors/task-graph-validation-error.js';

// Traceability source regex strictly enforcing DEC-009 categories:
// REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT
export const TRACEABILITY_SOURCE_REGEX =
  /^(REQ|DEC|PARENT_TASK|PARENT_FEATURE|SYSTEM_REQUIREMENT)([-:_ ].*)?$/i;

/**
 * Checks whether a single traceability source string conforms to DEC-009 / Section 10.
 */
export function isTraceabilitySourceValid(source: unknown): boolean {
  if (typeof source !== 'string') return false;
  const trimmed = source.trim();
  if (trimmed.length === 0) return false;
  return TRACEABILITY_SOURCE_REGEX.test(trimmed);
}

/**
 * Zod schema for validating a TaskDefinition.
 * Preprocesses camelCase properties to canonical snake_case properties.
 */
export const TaskDefinitionZodSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const raw = val as Record<string, unknown>;
    const rawHierarchy = raw.hierarchy_level ?? raw.hierarchyLevel ?? raw.level ?? 'TASK';
    const rawParent = raw.parent_feature_id ?? raw.parentFeatureId;
    const resolvedParent = (rawHierarchy === 'EPIC' && (!rawParent || String(rawParent).trim() === ''))
      ? 'ROOT'
      : rawParent;

    return {
      task_id: raw.task_id ?? raw.taskId,
      parent_feature_id: resolvedParent,
      title: raw.title,
      description: raw.description,
      traceability_sources: raw.traceability_sources ?? raw.traceabilitySources,
      dependencies: raw.dependencies ?? [],
      acceptance_criteria: raw.acceptance_criteria ?? raw.acceptanceCriteria ?? [],
      status: raw.status ?? 'READY',
      attempt: raw.attempt ?? 0,
      max_attempts: raw.max_attempts ?? raw.maxAttempts ?? 3,
      priority: raw.priority ?? 'MEDIUM',
      risk_level: raw.risk_level ?? raw.riskLevel ?? 'SAFE',
      created_at: raw.created_at ?? raw.createdAt ?? new Date().toISOString(),
      started_at: raw.started_at !== undefined ? raw.started_at : (raw.startedAt ?? null),
      completed_at: raw.completed_at !== undefined ? raw.completed_at : (raw.completedAt ?? null),
      hierarchy_level: raw.hierarchy_level ?? raw.hierarchyLevel ?? raw.level ?? 'TASK',
      metadata: raw.metadata,
    };
  }
  return val;
}, z.object({
  task_id: z.string({ message: 'task_id is required' }).trim().min(1, 'task_id cannot be empty'),
  parent_feature_id: z
    .string({ message: 'parent_feature_id is required' })
    .trim()
    .min(1, 'parent_feature_id cannot be empty'),
  title: z.string({ message: 'title is required' }).trim().min(1, 'title cannot be empty'),
  description: z.string({ message: 'description is required' }).trim().min(1, 'description cannot be empty'),
  traceability_sources: z
    .array(z.string(), { message: 'traceability_sources must be an array' })
    .min(1, 'traceability_sources must contain at least one valid source'),
  dependencies: z.array(z.string().trim().min(1, 'dependency task_id cannot be empty')).default([]),
  acceptance_criteria: z
    .array(z.string().trim().min(1, 'acceptance criteria item cannot be empty'))
    .min(1, 'acceptance_criteria must contain at least one criterion'),
  status: z.enum(TASK_STATUSES as [string, ...string[]], {
    message: `status must be one of: ${TASK_STATUSES.join(', ')}`,
  }),
  attempt: z.number().int().nonnegative('attempt must be >= 0'),
  max_attempts: z.number().int().positive('max_attempts must be >= 1'),
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]], {
    message: `priority must be one of: ${TASK_PRIORITIES.join(', ')}`,
  }),
  risk_level: z.enum(RISK_LEVELS as [string, ...string[]], {
    message: `risk_level must be one of: ${RISK_LEVELS.join(', ')}`,
  }),
  created_at: z.string().trim().min(1, 'created_at cannot be empty'),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  hierarchy_level: z.enum(TASK_HIERARCHY_LEVELS as [string, ...string[]]).optional().default('TASK'),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
  // Check that parent_feature_id is not identical to task_id
  if (data.task_id && data.parent_feature_id && data.task_id === data.parent_feature_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Task cannot reference itself as parent_feature_id: "${data.task_id}"`,
      path: ['parent_feature_id'],
    });
  }

  // Validate each traceability source against DEC-009 / Section 10 categories
  if (data.traceability_sources && data.traceability_sources.length > 0) {
    for (let i = 0; i < data.traceability_sources.length; i++) {
      const src = data.traceability_sources[i];
      if (!isTraceabilitySourceValid(src)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid traceability source: "${src}". Must reference REQ, DEC, PARENT_TASK, PARENT_FEATURE, or SYSTEM_REQUIREMENT`,
          path: ['traceability_sources', i],
        });
      }
    }
  }
}));

/**
 * Validates a single task input against the Authoritative Section 10 model.
 */
export function validateTask(input: unknown): TaskValidationResult {
  const parseResult = TaskDefinitionZodSchema.safeParse(input);
  if (parseResult.success) {
    return {
      valid: true,
      task: parseResult.data as TaskDefinition,
      errors: [],
    };
  }

  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const taskId = (raw.task_id ?? raw.taskId ?? 'UNKNOWN') as string;
  const issues: TaskGraphValidationIssue[] = [];

  for (const issue of parseResult.error.issues) {
    const path0 = issue.path[0];
    if (path0 === 'parent_feature_id') {
      issues.push({
        category: 'INVALID_PARENT_CHECK',
        taskId,
        message: issue.message,
        details: { path: issue.path, rawValue: raw.parent_feature_id ?? raw.parentFeatureId },
      });
    } else if (path0 === 'traceability_sources') {
      issues.push({
        category: 'TRACEABILITY_SOURCE_CHECK',
        taskId,
        message: issue.message,
        details: { path: issue.path, rawValue: raw.traceability_sources ?? raw.traceabilitySources },
      });
    } else {
      issues.push({
        category: 'INVALID_PARENT_CHECK', // fallback category if parent is completely missing or malformed
        taskId,
        message: `Field '${issue.path.join('.')}': ${issue.message}`,
        details: { path: issue.path },
      });
    }
  }

  return {
    valid: false,
    errors: issues,
  };
}

/**
 * Validates a single task input or throws a deterministic TaskGraphValidationError.
 */
export function assertValidTask(input: unknown): TaskDefinition {
  const result = validateTask(input);
  if (!result.valid) {
    const firstIssue = result.errors[0];
    throw new TaskGraphValidationError(firstIssue.category, firstIssue.message, {
      taskId: firstIssue.taskId,
      ...firstIssue.details,
    });
  }
  return result.task!;
}
