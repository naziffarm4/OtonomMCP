import {
  type TaskDefinition,
  type TaskHierarchyLevel,
  type TaskGraphModel,
  type TaskGraphInput,
  type TaskGraphOptions,
  type TaskGraphValidationIssue,
  type GraphValidationResult,
  type TaskValidationResult,
} from './task-types.js';
import { validateTask, assertValidTask, isTraceabilitySourceValid } from './task-schema.js';
import {
  TaskGraphValidationError,
  type TaskGraphValidationCategory,
} from '../errors/task-graph-validation-error.js';

/**
 * Traces a deterministic cycle path among identified cycle candidate tasks.
 */
function traceDeterministicCycle(
  cycleCandidates: string[],
  tasksMap: Map<string, TaskDefinition>
): string[] {
  if (cycleCandidates.length === 0) return [];
  const candidateSet = new Set(cycleCandidates);

  // Start with the lexicographically first candidate
  let current = cycleCandidates[0];
  const path: string[] = [];
  const indexMap = new Map<string, number>();

  while (!indexMap.has(current)) {
    indexMap.set(current, path.length);
    path.push(current);

    const task = tasksMap.get(current);
    if (!task) break;

    // Pick the first dependency that is in the cycle candidate set (sorted alphabetically)
    const validDeps = task.dependencies
      .filter((dep) => candidateSet.has(dep))
      .sort((a, b) => a.localeCompare(b));

    if (validDeps.length === 0) break;
    current = validDeps[0];
  }

  const cycleStartIndex = indexMap.get(current) ?? 0;
  const cycle = path.slice(cycleStartIndex);
  cycle.push(current); // close the cycle (e.g. ['B', 'C', 'D', 'B'])
  return cycle;
}

/**
 * Executes Kahn's topological sorting algorithm on a validated collection of tasks.
 *
 * Deterministic tie-breaking rule:
 * When multiple tasks have in-degree 0 (no remaining prerequisites), they are selected
 * in lexicographical order by task_id ascending. This guarantees 100% reproducible ordering.
 *
 * Throws TaskGraphValidationError with category 'CIRCULAR_DEPENDENCY_CHECK' if a cycle exists.
 */
export function kahnTopologicalSort(tasks: TaskDefinition[]): string[] {
  if (tasks.length === 0) return [];

  const taskCount = tasks.length;
  const tasksMap = new Map<string, TaskDefinition>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    tasksMap.set(task.task_id, task);
    inDegree.set(task.task_id, task.dependencies.length);
    dependents.set(task.task_id, []);
  }

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      dependents.get(depId)?.push(task.task_id);
    }
  }

  // Initial ready queue: all tasks with 0 dependencies
  const readyQueue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      readyQueue.push(id);
    }
  }

  // Deterministic tie-breaking: sort lexicographically by task_id ascending
  readyQueue.sort((a, b) => a.localeCompare(b));

  const topologicalOrder: string[] = [];

  while (readyQueue.length > 0) {
    // Deterministically shift the smallest task_id
    const currentId = readyQueue.shift()!;
    topologicalOrder.push(currentId);

    const depList = dependents.get(currentId) || [];
    for (const dependentId of depList) {
      const currentDeg = inDegree.get(dependentId) ?? 0;
      const newDeg = currentDeg - 1;
      inDegree.set(dependentId, newDeg);

      if (newDeg === 0) {
        readyQueue.push(dependentId);
        // Maintain deterministic ordering in the ready queue
        readyQueue.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (topologicalOrder.length < taskCount) {
    const cycleCandidates = tasks
      .filter((t) => (inDegree.get(t.task_id) ?? 0) > 0)
      .map((t) => t.task_id)
      .sort((a, b) => a.localeCompare(b));

    const cyclePath = traceDeterministicCycle(cycleCandidates, tasksMap);

    throw new TaskGraphValidationError(
      'CIRCULAR_DEPENDENCY_CHECK',
      `Circular dependency detected involving tasks: ${cycleCandidates.join(', ')}`,
      {
        taskId: cycleCandidates[0],
        cycleTasks: cycleCandidates,
        cyclePath,
      }
    );
  }

  return topologicalOrder;
}

/**
 * Normalizes TaskGraphInput into tasks to validate and a parent node registry.
 */
function normalizeTaskGraphInput(
  tasksInput: TaskGraphInput,
  options?: TaskGraphOptions
): {
  tasksToValidate: unknown[];
  parentRegistry: Map<string, { id: string; hierarchy_level: TaskHierarchyLevel }>;
} {
  const parentRegistry = new Map<string, { id: string; hierarchy_level: TaskHierarchyLevel }>();

  // 1. Ingest explicit options
  if (options?.validFeatureIds) {
    const featList = options.validFeatureIds instanceof Set
      ? Array.from(options.validFeatureIds)
      : options.validFeatureIds;
    for (const fId of featList) {
      parentRegistry.set(fId, { id: fId, hierarchy_level: 'FEATURE' });
    }
  }
  if (options?.validEpicIds) {
    const epicList = options.validEpicIds instanceof Set
      ? Array.from(options.validEpicIds)
      : options.validEpicIds;
    for (const eId of epicList) {
      parentRegistry.set(eId, { id: eId, hierarchy_level: 'EPIC' });
    }
  }
  if (options?.parentNodes) {
    for (const pNode of options.parentNodes) {
      const pId = pNode.task_id ?? (pNode as any).taskId;
      const pLevel = ((pNode.hierarchy_level ?? (pNode as any).hierarchyLevel ?? 'FEATURE') as TaskHierarchyLevel);
      if (pId) {
        parentRegistry.set(pId, { id: pId, hierarchy_level: pLevel });
      }
    }
  }

  // 2. Ingest graph model or array
  let tasksToValidate: unknown[] = [];

  if (Array.isArray(tasksInput)) {
    tasksToValidate = tasksInput;
    for (const n of tasksInput) {
      if (n && typeof n === 'object') {
        const raw = n as Record<string, unknown>;
        const nId = (raw.task_id ?? raw.taskId) as string | undefined;
        const nLevel = ((raw.hierarchy_level ?? raw.hierarchyLevel ?? raw.level ?? 'TASK') as TaskHierarchyLevel);
        if (nId && !parentRegistry.has(nId)) {
          parentRegistry.set(nId, { id: nId, hierarchy_level: nLevel });
        }
      }
    }
  } else if (tasksInput && typeof tasksInput === 'object') {
    const model = tasksInput as TaskGraphModel;
    if (model.epics) {
      for (const e of model.epics) {
        if (typeof e === 'string') {
          parentRegistry.set(e, { id: e, hierarchy_level: 'EPIC' });
        } else if (e && typeof e === 'object') {
          const raw = e as Record<string, unknown>;
          const eId = (raw.task_id ?? raw.taskId) as string | undefined;
          const eLevel = ((raw.hierarchy_level ?? raw.hierarchyLevel ?? 'EPIC') as TaskHierarchyLevel);
          if (eId) {
            parentRegistry.set(eId, { id: eId, hierarchy_level: eLevel });
          }
        }
      }
    }
    if (model.features) {
      for (const f of model.features) {
        if (typeof f === 'string') {
          parentRegistry.set(f, { id: f, hierarchy_level: 'FEATURE' });
        } else if (f && typeof f === 'object') {
          const raw = f as Record<string, unknown>;
          const fId = (raw.task_id ?? raw.taskId) as string | undefined;
          const fLevel = ((raw.hierarchy_level ?? raw.hierarchyLevel ?? 'FEATURE') as TaskHierarchyLevel);
          if (fId) {
            parentRegistry.set(fId, { id: fId, hierarchy_level: fLevel });
          }
        }
      }
    }
    const modelTasks = model.tasks ?? [];
    const modelSubtasks = model.subtasks ?? [];
    tasksToValidate = [...modelTasks, ...modelSubtasks];

    for (const n of tasksToValidate) {
      if (n && typeof n === 'object') {
        const raw = n as Record<string, unknown>;
        const nId = (raw.task_id ?? raw.taskId) as string | undefined;
        const nLevel = ((raw.hierarchy_level ?? raw.hierarchyLevel ?? raw.level ?? 'TASK') as TaskHierarchyLevel);
        if (nId && !parentRegistry.has(nId)) {
          parentRegistry.set(nId, { id: nId, hierarchy_level: nLevel });
        }
      }
    }
  }

  return { tasksToValidate, parentRegistry };
}

/**
 * Validates a complete Task Graph against the 5 Authoritative Graph Integrity Checks:
 * 1. DUPLICATE_ID_CHECK
 * 2. INVALID_PARENT_CHECK
 * 3. TRACEABILITY_SOURCE_CHECK
 * 4. MISSING_DEPENDENCY_CHECK
 * 5. CIRCULAR_DEPENDENCY_CHECK (Kahn algorithm)
 */
export function validateTaskGraph(
  tasksInput: TaskGraphInput,
  options?: TaskGraphOptions
): GraphValidationResult {
  const { tasksToValidate, parentRegistry } = normalizeTaskGraphInput(tasksInput, options);

  const issues: TaskGraphValidationIssue[] = [];
  const validatedTasks: TaskDefinition[] = [];
  const seenIds = new Set<string>();

  // 1. Validate individual task schemas and check for duplicate IDs
  for (let i = 0; i < tasksToValidate.length; i++) {
    const item = tasksToValidate[i];
    const validation = validateTask(item);

    if (!validation.valid) {
      issues.push(...validation.errors);
      continue;
    }

    const task = validation.task!;
    if (seenIds.has(task.task_id)) {
      issues.push({
        category: 'DUPLICATE_ID_CHECK',
        taskId: task.task_id,
        message: `Duplicate task_id detected: "${task.task_id}"`,
        details: { duplicateId: task.task_id, index: i },
      });
    } else {
      seenIds.add(task.task_id);
      validatedTasks.push(task);
    }
  }

  // If there are duplicate IDs or individual schema errors, report immediately before graph checks
  const duplicateErrors = issues.filter((e) => e.category === 'DUPLICATE_ID_CHECK');
  if (duplicateErrors.length > 0) {
    return {
      valid: false,
      errors: issues,
      taskCount: tasksToValidate.length,
    };
  }

  const tasksMap = new Map<string, TaskDefinition>();
  for (const t of validatedTasks) {
    tasksMap.set(t.task_id, t);
  }

  // 2. INVALID_PARENT_CHECK: Strict Authoritative Hierarchy Validation (Section 10)
  // Architecture: EPIC -> FEATURE -> TASK -> SUBTASK
  // "parent_feature_id: Ait olduğu Feature/Epic kimliği."
  for (const task of validatedTasks) {
    const parentId = task.parent_feature_id ? task.parent_feature_id.trim() : '';
    const childLevel = task.hierarchy_level ?? 'TASK';

    if (childLevel === 'EPIC') {
      // An Epic is root in Section 10 hierarchy. If parentId is specified and not ROOT, it must be another Epic
      if (parentId && parentId !== 'ROOT') {
        if (!parentRegistry.has(parentId)) {
          issues.push({
            category: 'INVALID_PARENT_CHECK',
            taskId: task.task_id,
            message: `Epic "${task.task_id}" references unknown parent_feature_id: "${parentId}". Parent must be represented in the graph/model`,
            details: { parent_feature_id: parentId },
          });
        } else if (parentRegistry.get(parentId)!.hierarchy_level !== 'EPIC') {
          issues.push({
            category: 'INVALID_PARENT_CHECK',
            taskId: task.task_id,
            message: `Epic "${task.task_id}" has incompatible parent hierarchy level: "${parentRegistry.get(parentId)!.hierarchy_level}"`,
            details: { parent_feature_id: parentId },
          });
        }
      }
    } else if (childLevel === 'FEATURE') {
      // A Feature belongs to an Epic (or root if epics are not modeled).
      if (parentId && parentId !== 'ROOT') {
        if (!parentRegistry.has(parentId)) {
          issues.push({
            category: 'INVALID_PARENT_CHECK',
            taskId: task.task_id,
            message: `Feature "${task.task_id}" references unknown parent_feature_id: "${parentId}". Parent must be represented in the graph/model`,
            details: { parent_feature_id: parentId },
          });
        } else if (parentRegistry.get(parentId)!.hierarchy_level !== 'EPIC') {
          issues.push({
            category: 'INVALID_PARENT_CHECK',
            taskId: task.task_id,
            message: `Feature "${task.task_id}" has incompatible parent hierarchy: parent "${parentId}" has hierarchy level "${parentRegistry.get(parentId)!.hierarchy_level}", but a FEATURE must have an EPIC parent`,
            details: { parent_feature_id: parentId },
          });
        }
      }
    } else if (childLevel === 'TASK') {
      // Mandatory parent: Section 10: "parent_feature_id: Ait olduğu Feature/Epic kimliği."
      if (!parentId || parentId.length === 0) {
        issues.push({
          category: 'INVALID_PARENT_CHECK',
          taskId: task.task_id,
          message: `Task "${task.task_id}" has missing or empty parent_feature_id`,
          details: { parent_feature_id: task.parent_feature_id },
        });
      } else if (parentId === task.task_id) {
        issues.push({
          category: 'INVALID_PARENT_CHECK',
          taskId: task.task_id,
          message: `Task "${task.task_id}" cannot reference itself as parent_feature_id`,
          details: { parent_feature_id: task.parent_feature_id },
        });
      } else if (!parentRegistry.has(parentId)) {
        issues.push({
          category: 'INVALID_PARENT_CHECK',
          taskId: task.task_id,
          message: `Task "${task.task_id}" references unknown parent_feature_id: "${parentId}". Parent must be represented in the graph/model`,
          details: { parent_feature_id: parentId },
        });
      } else {
        const parentNode = parentRegistry.get(parentId)!;
        if (parentNode.hierarchy_level !== 'FEATURE' && parentNode.hierarchy_level !== 'EPIC') {
          issues.push({
            category: 'INVALID_PARENT_CHECK',
            taskId: task.task_id,
            message: `Task "${task.task_id}" has incompatible parent hierarchy: parent "${parentId}" has hierarchy level "${parentNode.hierarchy_level}", but parent_feature_id must reference a Feature or Epic`,
            details: { parent_feature_id: parentId, parentHierarchyLevel: parentNode.hierarchy_level },
          });
        }
      }
    } else if (childLevel === 'SUBTASK') {
      // A subtask belongs to a TASK (or FEATURE/EPIC)
      if (!parentId || parentId.length === 0) {
        issues.push({
          category: 'INVALID_PARENT_CHECK',
          taskId: task.task_id,
          message: `Subtask "${task.task_id}" has missing or empty parent_feature_id`,
          details: { parent_feature_id: task.parent_feature_id },
        });
      } else if (parentId === task.task_id) {
        issues.push({
          category: 'INVALID_PARENT_CHECK',
          taskId: task.task_id,
          message: `Subtask "${task.task_id}" cannot reference itself as parent_feature_id`,
          details: { parent_feature_id: task.parent_feature_id },
        });
      } else if (!parentRegistry.has(parentId)) {
        issues.push({
          category: 'INVALID_PARENT_CHECK',
          taskId: task.task_id,
          message: `Subtask "${task.task_id}" references unknown parent_feature_id: "${parentId}". Parent must be represented in the graph/model`,
          details: { parent_feature_id: parentId },
        });
      } else {
        const parentNode = parentRegistry.get(parentId)!;
        if (parentNode.hierarchy_level === 'SUBTASK') {
          issues.push({
            category: 'INVALID_PARENT_CHECK',
            taskId: task.task_id,
            message: `Subtask "${task.task_id}" has incompatible parent hierarchy: parent "${parentId}" has hierarchy level "SUBTASK"`,
            details: { parent_feature_id: parentId, parentHierarchyLevel: parentNode.hierarchy_level },
          });
        }
      }
    }
  }

  // 3. TRACEABILITY_SOURCE_CHECK: Ensure every task has at least one valid source
  for (const task of validatedTasks) {
    if (!task.traceability_sources || task.traceability_sources.length === 0) {
      issues.push({
        category: 'TRACEABILITY_SOURCE_CHECK',
        taskId: task.task_id,
        message: `Task "${task.task_id}" has no traceability sources`,
        details: { sources: task.traceability_sources },
      });
    } else {
      for (const src of task.traceability_sources) {
        if (!isTraceabilitySourceValid(src)) {
          issues.push({
            category: 'TRACEABILITY_SOURCE_CHECK',
            taskId: task.task_id,
            message: `Task "${task.task_id}" contains invalid traceability source: "${src}"`,
            details: { invalidSource: src },
          });
        }
      }
    }
  }

  // 4. MISSING_DEPENDENCY_CHECK: Ensure all dependencies exist in the graph
  for (const task of validatedTasks) {
    for (const depId of task.dependencies) {
      if (!tasksMap.has(depId)) {
        issues.push({
          category: 'MISSING_DEPENDENCY_CHECK',
          taskId: task.task_id,
          message: `Task "${task.task_id}" references missing dependency: "${depId}"`,
          details: { missingDependency: depId },
        });
      }
    }
  }

  // If there are structural errors (parent, traceability, missing dependency), do not attempt cycle detection yet
  if (issues.length > 0) {
    return {
      valid: false,
      errors: issues,
      taskCount: validatedTasks.length,
    };
  }

  // 5. CIRCULAR_DEPENDENCY_CHECK: Kahn's topological sort
  try {
    const topologicalOrder = kahnTopologicalSort(validatedTasks);
    return {
      valid: true,
      errors: [],
      topologicalOrder,
      taskCount: validatedTasks.length,
    };
  } catch (err) {
    if (err instanceof TaskGraphValidationError && err.category === 'CIRCULAR_DEPENDENCY_CHECK') {
      issues.push({
        category: 'CIRCULAR_DEPENDENCY_CHECK',
        taskId: err.taskId,
        message: err.message,
        details: err.details,
      });
      return {
        valid: false,
        errors: issues,
        taskCount: validatedTasks.length,
      };
    }
    throw err;
  }
}

/**
 * Validates a task graph or throws a deterministic TaskGraphValidationError.
 */
export function assertValidTaskGraph(
  tasksInput: TaskGraphInput,
  options?: TaskGraphOptions
): TaskDefinition[] {
  const result = validateTaskGraph(tasksInput, options);
  if (!result.valid) {
    // Sort issues deterministically by category priority and taskId
    const categoryPriority: Record<TaskGraphValidationCategory, number> = {
      DUPLICATE_ID_CHECK: 1,
      INVALID_PARENT_CHECK: 2,
      TRACEABILITY_SOURCE_CHECK: 3,
      MISSING_DEPENDENCY_CHECK: 4,
      CIRCULAR_DEPENDENCY_CHECK: 5,
    };

    const sortedIssues = [...result.errors].sort((a, b) => {
      const pA = categoryPriority[a.category] ?? 99;
      const pB = categoryPriority[b.category] ?? 99;
      if (pA !== pB) return pA - pB;
      return (a.taskId ?? '').localeCompare(b.taskId ?? '');
    });

    const first = sortedIssues[0];
    throw new TaskGraphValidationError(first.category, first.message, {
      taskId: first.taskId,
      ...first.details,
    });
  }

  const { tasksToValidate } = normalizeTaskGraphInput(tasksInput, options);
  return tasksToValidate.map((t) => assertValidTask(t));
}

/**
 * Task DAG Engine providing graph validation, cycle detection, and topological ordering.
 */
export class TaskDagEngine {
  private readonly defaultOptions?: TaskGraphOptions;

  constructor(options?: TaskGraphOptions) {
    this.defaultOptions = options;
  }

  validateTask(task: unknown): TaskValidationResult {
    return validateTask(task);
  }

  assertValidTask(task: unknown): TaskDefinition {
    return assertValidTask(task);
  }

  validateGraph(tasks: TaskGraphInput, options?: TaskGraphOptions): GraphValidationResult {
    return validateTaskGraph(tasks, options ?? this.defaultOptions);
  }

  assertValidGraph(tasks: TaskGraphInput, options?: TaskGraphOptions): TaskDefinition[] {
    return assertValidTaskGraph(tasks, options ?? this.defaultOptions);
  }

  topologicalSort(tasks: TaskGraphInput, options?: TaskGraphOptions): string[] {
    const validated = this.assertValidGraph(tasks, options);
    return kahnTopologicalSort(validated);
  }

  detectCycles(tasks: TaskDefinition[]): string[] | null {
    try {
      kahnTopologicalSort(tasks);
      return null;
    } catch (err) {
      if (err instanceof TaskGraphValidationError && err.category === 'CIRCULAR_DEPENDENCY_CHECK') {
        return (err.details?.cycleTasks as string[]) ?? [];
      }
      throw err;
    }
  }

  getDependencies(tasks: TaskDefinition[], taskId: string): string[] {
    const task = tasks.find((t) => t.task_id === taskId);
    return task ? [...task.dependencies] : [];
  }

  getDependents(tasks: TaskDefinition[], taskId: string): string[] {
    return tasks
      .filter((t) => t.dependencies.includes(taskId))
      .map((t) => t.task_id)
      .sort((a, b) => a.localeCompare(b));
  }
}
