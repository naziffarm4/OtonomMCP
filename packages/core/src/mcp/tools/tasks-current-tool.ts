/**
 * Authoritative Read-Only Current Task Tool: aidm.tasks.current (Phase 8 TASK-P8-02)
 *
 * Exposes current active task selection, attempt, acceptance criteria, dependencies,
 * traceability, and blocked state. Returns explicit null when no active task exists.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not invent or activate tasks.
 * 2. Reads strictly from DurableStateManager and SpecStore.
 * 3. Returns explicit null semantics when no task is active.
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
import { DurableStateManager } from '../../storage/durable-state.js';
import { SpecStore } from '../../storage/spec-store.js';
import { type TaskDefinition, TaskStatus } from '../../task-engine/task-types.js';

export const AIDM_TASKS_CURRENT_TOOL_NAME = 'aidm.tasks.current';

export const TasksCurrentInputZodSchema = z.object({}).strict();

export type TasksCurrentInput = z.infer<typeof TasksCurrentInputZodSchema>;

export interface CurrentTaskOutput {
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
  readonly iteration?: number;
  readonly blockedState?: {
    readonly blockedTaskId: string | null;
    readonly blockedIteration: number;
    readonly blockedContextReference: string;
    readonly blockingReason: string;
    readonly resumePoint: string;
  } | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TasksCurrentResult {
  readonly hasActiveTask: boolean;
  readonly task: CurrentTaskOutput | null;
  readonly reason?: string;
  readonly correlationId: string;
}

export const tasksCurrentToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_TASKS_CURRENT_TOOL_NAME,
  description:
    'Returns the current task selection and state from durable state. Returns explicit null if no task is active. Strictly read-only; never invents a task.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
});

export function createTasksCurrentTool(): McpToolRegistration {
  return {
    definition: tasksCurrentToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = TasksCurrentInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_TASKS_CURRENT_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      // 1. Authoritative DurableStateManager
      const durableManager =
        delegate?.durableStateManager ?? new DurableStateManager({ baseDir: projectRoot });

      let activeTaskId: string | null = null;
      let blockedState: CurrentTaskOutput['blockedState'] = null;

      try {
        const state = await durableManager.load();
        if (state) {
          activeTaskId = state.activeTaskId ?? null;
          if (state.blockedState) {
            blockedState = {
              blockedTaskId: state.blockedState.blockedTaskId ?? null,
              blockedIteration: state.blockedState.blockedIteration,
              blockedContextReference: state.blockedState.blockedContextReference,
              blockingReason: state.blockedState.blockingReason,
              resumePoint: state.blockedState.resumePoint,
            };
          }
        }
      } catch {
        activeTaskId = null;
      }

      // If no active task, return explicit null
      if (!activeTaskId) {
        const nullPayload: TasksCurrentResult = {
          hasActiveTask: false,
          task: null,
          reason: 'NO_ACTIVE_TASK',
          correlationId: context.correlation.correlationId,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(nullPayload, null, 2),
            },
          ],
          isError: false,
        };
      }

      // 2. Load task definition from SpecStore
      const specStore = delegate?.specStore ?? new SpecStore({ baseDir: projectRoot });
      let loadedTasks: TaskDefinition[] = [];
      try {
        loadedTasks = await specStore.loadTasks();
      } catch {
        loadedTasks = [];
      }

      const foundTask = loadedTasks.find((t) => t.task_id === activeTaskId);

      const taskPayload: CurrentTaskOutput = {
        taskId: activeTaskId,
        hierarchyLevel: foundTask?.hierarchy_level ?? 'TASK',
        title: foundTask?.title ?? `Active Task ${activeTaskId}`,
        description: foundTask?.description ?? '',
        parentFeatureId: foundTask?.parent_feature_id ?? null,
        dependencies: foundTask?.dependencies ?? [],
        status: foundTask?.status ?? TaskStatus.IN_PROGRESS,
        priority: foundTask?.priority ?? 'MEDIUM',
        riskLevel: foundTask?.risk_level ?? 'CAUTION',
        acceptanceCriteria: foundTask?.acceptance_criteria ?? [],
        traceabilitySources: foundTask?.traceability_sources ?? [],
        attempt: foundTask?.attempt ?? 0,
        maxAttempts: foundTask?.max_attempts ?? 3,
        iteration: blockedState?.blockedIteration ?? 1,
        blockedState,
        metadata: foundTask?.metadata,
      };

      const payload: TasksCurrentResult = {
        hasActiveTask: true,
        task: taskPayload,
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
