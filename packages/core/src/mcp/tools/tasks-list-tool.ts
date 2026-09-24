/**
 * Authoritative Read-Only Tasks List Tool: aidm.tasks.list (Phase 8 TASK-P8-02)
 *
 * Exposes the project task DAG using existing TaskDagEngine and SpecStore without
 * mutating or creating a second DAG engine.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not create or mutate tasks or dependencies.
 * 2. Uses existing TaskDagEngine for validation and topological ordering.
 * 3. Incorporates completed / active status from DurableStateManager where available.
 * 4. Applies MCP secret sanitization.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  type McpToolDefinition,
  type McpToolRegistration,
  type McpToolResult,
  type McpRequestContext,
} from '../mcp-types.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { SpecStore } from '../../storage/spec-store.js';
import { DurableStateManager } from '../../storage/durable-state.js';
import { TaskDagEngine } from '../../task-engine/dag-engine.js';
import { type TaskDefinition, TaskStatus } from '../../task-engine/task-types.js';

export const AIDM_TASKS_LIST_TOOL_NAME = 'aidm.tasks.list';

export const TasksListInputZodSchema = z.object({
  hierarchyLevel: z.enum(['EPIC', 'FEATURE', 'TASK', 'SUBTASK']).optional(),
  status: z.string().optional(),
  parentId: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

export type TasksListInput = z.infer<typeof TasksListInputZodSchema>;

export interface TaskItemOutput {
  readonly taskId: string;
  readonly hierarchyLevel: string;
  readonly title: string;
  readonly description: string;
  readonly parentFeatureId: string | null;
  readonly dependencies: readonly string[];
  readonly status: string;
  readonly priority: string;
  readonly riskLevel: string;
  readonly acceptanceCriteria: readonly string[];
  readonly traceabilitySources: readonly string[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TasksListOutput {
  readonly tasks: readonly TaskItemOutput[];
  readonly total: number;
  readonly topologicalOrder: readonly string[];
  readonly validation: {
    readonly valid: boolean;
    readonly issues: ReadonlyArray<{
      readonly category: string;
      readonly message: string;
      readonly taskId?: string;
    }>;
  };
  readonly correlationId: string;
}

export const tasksListToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_TASKS_LIST_TOOL_NAME,
  description:
    'Returns the task DAG in a Director-readable representation using the authoritative TaskDagEngine and .ai-manager/spec/tasks.json. Strictly read-only; does not mutate dependencies or state.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      hierarchyLevel: {
        type: 'string',
        enum: ['EPIC', 'FEATURE', 'TASK', 'SUBTASK'],
        description: 'Optional hierarchy level filter.',
      },
      status: {
        type: 'string',
        description: 'Optional task status filter (e.g. COMPLETED, READY, IN_PROGRESS).',
      },
      parentId: {
        type: 'string',
        description: 'Optional parent feature or epic identifier filter.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'Maximum number of tasks to return (default 100).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Offset for pagination (default 0).',
      },
    },
    additionalProperties: false,
  },
});

export function createTasksListTool(): McpToolRegistration {
  return {
    definition: tasksListToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = TasksListInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_TASKS_LIST_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      // 1. Authoritative sources
      const specStore = delegate?.specStore ?? new SpecStore({ baseDir: projectRoot });
      const dagEngine = delegate?.dagEngine ?? new TaskDagEngine();
      const durableManager =
        delegate?.durableStateManager ?? new DurableStateManager({ baseDir: projectRoot });

      // 2. Load tasks
      let loadedTasks: TaskDefinition[] = [];
      try {
        loadedTasks = await specStore.loadTasks();
      } catch {
        loadedTasks = [];
      }

      // 3. Reconcile runtime status from DurableStateManager if available
      let completedSet = new Set<string>();
      let activeTaskId: string | null = null;
      try {
        const durableState = await durableManager.load();
        if (durableState) {
          completedSet = new Set(durableState.completedTaskIds ?? []);
          activeTaskId = durableState.activeTaskId ?? null;
        }
      } catch {
        // durable state unreadable or missing
      }

      // 4. Validate graph using existing TaskDagEngine
      let topologicalOrder: string[] = [];
      let graphValid = true;
      let issues: Array<{ category: string; message: string; taskId?: string }> = [];

      if (loadedTasks.length > 0) {
        try {
          const validationResult = dagEngine.validateGraph(loadedTasks);
          graphValid = validationResult.valid;
          if (validationResult.topologicalOrder) {
            topologicalOrder = validationResult.topologicalOrder;
          }
          if (validationResult.errors) {
            issues = validationResult.errors.map((e) => ({
              category: e.category,
              message: e.message,
              taskId: e.taskId,
            }));
          }
        } catch (err) {
          graphValid = false;
          issues = [
            {
              category: 'DAG_VALIDATION_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          ];
        }
      }

      // 5. Apply filters without altering original graph order
      let filtered = loadedTasks;
      if (input.hierarchyLevel) {
        filtered = filtered.filter((t) => (t.hierarchy_level ?? 'TASK') === input.hierarchyLevel);
      }
      if (input.parentId) {
        filtered = filtered.filter((t) => t.parent_feature_id === input.parentId);
      }
      if (input.status) {
        filtered = filtered.filter((t) => {
          let currentStatus: string = t.status;
          if (completedSet.has(t.task_id)) {
            currentStatus = TaskStatus.ACCEPTED;
          } else if (activeTaskId === t.task_id) {
            currentStatus = TaskStatus.IN_PROGRESS;
          }
          return currentStatus === input.status;
        });
      }

      const total = filtered.length;
      const paginated = filtered.slice(input.offset, input.offset + input.limit);

      const mapped: TaskItemOutput[] = paginated.map((t) => {
        let currentStatus: string = t.status;
        if (completedSet.has(t.task_id)) {
          currentStatus = TaskStatus.ACCEPTED;
        } else if (activeTaskId === t.task_id) {
          currentStatus = TaskStatus.IN_PROGRESS;
        }

        return {
          taskId: t.task_id,
          hierarchyLevel: t.hierarchy_level ?? 'TASK',
          title: t.title,
          description: t.description ?? '',
          parentFeatureId: t.parent_feature_id ?? null,
          dependencies: t.dependencies ?? [],
          status: currentStatus,
          priority: t.priority ?? 'MEDIUM',
          riskLevel: t.risk_level ?? 'CAUTION',
          acceptanceCriteria: t.acceptance_criteria ?? [],
          traceabilitySources: t.traceability_sources ?? [],
          attempt: t.attempt ?? 0,
          maxAttempts: t.max_attempts ?? 3,
          metadata: t.metadata,
        };
      });

      const payload: TasksListOutput = {
        tasks: mapped,
        total,
        topologicalOrder,
        validation: {
          valid: graphValid,
          issues,
        },
        correlationId: context.correlation.correlationId,
      };

      const sanitized = sanitizeMcpPayload(payload);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
        isError: false,
      };
    },
  };
}
