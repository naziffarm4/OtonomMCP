/**
 * Authoritative Read-Only Project Status Tool: aidm.project.status (Phase 8 TASK-P8-02)
 *
 * Exposes authoritative project-level status including lifecycle state, active task,
 * blocked state, accepted checkpoints, Git state, and orchestrator availability.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not mutate FSM, durable state, or checkpoints.
 * 2. Reads strictly from existing authoritative AIDM components.
 * 3. Does not infer state from filenames or prose.
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
import { CheckpointStore, type PersistentCheckpointRecord } from '../../cli/checkpoint-store.js';
import { DefaultGitPort } from '../../git/default-git-port.js';
import { LifecycleState } from '../../lifecycle.js';

export const AIDM_PROJECT_STATUS_TOOL_NAME = 'aidm.project.status';

export const ProjectStatusInputZodSchema = z.object({
  projectId: z.string().optional(),
}).strict();

export type ProjectStatusInput = z.infer<typeof ProjectStatusInputZodSchema>;

export interface ProjectStatusOutput {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly initialized: boolean;
  readonly orchestrator: {
    readonly available: boolean;
    readonly connected: boolean;
  };
  readonly lifecycle: {
    readonly state: string;
    readonly isCompleted: boolean;
    readonly isBlocked: boolean;
    readonly blockedState: {
      readonly blockedTaskId: string | null;
      readonly blockedIteration: number;
      readonly blockedContextReference: string;
      readonly blockingReason: string;
      readonly resumePoint: string;
    } | null;
  };
  readonly tasks: {
    readonly activeTaskId: string | null;
    readonly completedTasksCount: number;
    readonly completedTaskIds: readonly string[];
  };
  readonly checkpoints: {
    readonly lastCheckpoint: string | null;
    readonly totalCheckpoints: number;
    readonly lastAcceptedCheckpoint: PersistentCheckpointRecord | null;
  };
  readonly git: {
    readonly head: string | null;
    readonly branch: string | null;
    readonly isClean: boolean | null;
  };
  readonly updatedAt: string | null;
  readonly correlationId: string;
}

export const projectStatusToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_PROJECT_STATUS_TOOL_NAME,
  description:
    'Returns authoritative project-level status including lifecycle state, active task, blocked state, checkpoints, and Git HEAD. Strictly read-only; delegates to authoritative AIDM stores without state mutation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional project identifier to query or verify against.',
      },
    },
    additionalProperties: false,
  },
});

export function createProjectStatusTool(): McpToolRegistration {
  return {
    definition: projectStatusToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      // 1. Strict input validation
      const parseResult = ProjectStatusInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_PROJECT_STATUS_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();
      const projectId = input.projectId ?? (delegate?.projectRoot ? path.basename(projectRoot) : 'default');

      // 2. Query orchestrator availability
      let orchestratorAvailable = false;
      let orchestratorConnected = false;
      if (delegate) {
        try {
          orchestratorConnected = await delegate.isHealthy();
          orchestratorAvailable = orchestratorConnected;
        } catch {
          orchestratorConnected = false;
          orchestratorAvailable = false;
        }
      }

      // 3. Query DurableStateManager
      const durableManager =
        delegate?.durableStateManager ?? new DurableStateManager({ baseDir: projectRoot });

      let initialized = false;
      let lifecycleState: string = LifecycleState.INITIALIZING;
      let activeTaskId: string | null = null;
      let completedTaskIds: string[] = [];
      let isBlocked = false;
      let blockedStatePayload: ProjectStatusOutput['lifecycle']['blockedState'] = null;
      let lastCheckpoint: string | null = null;
      let updatedAt: string | null = null;

      try {
        initialized = await durableManager.exists();
        if (initialized) {
          const state = await durableManager.load();
          if (state) {
            lifecycleState = state.currentLifecycleState;
            activeTaskId = state.activeTaskId ?? null;
            completedTaskIds = [...state.completedTaskIds];
            lastCheckpoint = state.lastCheckpoint ?? null;
            updatedAt = state.updatedAt;

            if (state.blockedState) {
              isBlocked = true;
              blockedStatePayload = {
                blockedTaskId: state.blockedState.blockedTaskId ?? null,
                blockedIteration: state.blockedState.blockedIteration,
                blockedContextReference: state.blockedState.blockedContextReference,
                blockingReason: state.blockedState.blockingReason,
                resumePoint: state.blockedState.resumePoint,
              };
            }
          }
        } else {
          lifecycleState = 'UNINITIALIZED';
        }
      } catch {
        initialized = false;
        lifecycleState = 'UNINITIALIZED';
      }

      // 4. Query CheckpointStore
      const checkpointStore =
        delegate?.checkpointStore ?? new CheckpointStore(projectRoot);

      let totalCheckpoints = 0;
      let lastAcceptedCheckpoint: PersistentCheckpointRecord | null = null;

      try {
        const checkpoints = await checkpointStore.loadCheckpoints();
        totalCheckpoints = checkpoints.length;
        if (checkpoints.length > 0) {
          // Stable sort by creation date ascending, pick the last
          const sorted = [...checkpoints].sort((a, b) => a.created_at.localeCompare(b.created_at));
          lastAcceptedCheckpoint = sorted[sorted.length - 1];
        }
      } catch {
        // Leave defaults if unavailable
      }

      // 5. Query Git State safely (read-only inspectState)
      const gitPort = delegate?.gitPort ?? new DefaultGitPort();
      let headSha: string | null = null;
      let branchName: string | null = null;
      let cleanTree: boolean | null = null;

      try {
        const gitState = await gitPort.inspectState(projectRoot);
        headSha = gitState.head_sha ?? null;
        branchName = gitState.current_branch ?? null;
        cleanTree = gitState.working_tree_clean;
      } catch {
        // Not a git repo or git uninitialized
      }

      const isCompleted = lifecycleState === LifecycleState.PROJECT_COMPLETE;

      const payload: ProjectStatusOutput = {
        projectId,
        projectRoot,
        initialized,
        orchestrator: {
          available: orchestratorAvailable,
          connected: orchestratorConnected,
        },
        lifecycle: {
          state: lifecycleState,
          isCompleted,
          isBlocked,
          blockedState: blockedStatePayload,
        },
        tasks: {
          activeTaskId,
          completedTasksCount: completedTaskIds.length,
          completedTaskIds,
        },
        checkpoints: {
          lastCheckpoint,
          totalCheckpoints,
          lastAcceptedCheckpoint,
        },
        git: {
          head: headSha,
          branch: branchName,
          isClean: cleanTree,
        },
        updatedAt,
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
