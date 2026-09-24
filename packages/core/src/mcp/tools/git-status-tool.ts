/**
 * Authoritative Read-Only Git Status Tool: aidm.git.status (Phase 8 TASK-P8-02)
 *
 * Exposes authoritative Git status (HEAD, branch, working tree clean/dirty, accepted checkpoints).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not commit, checkout, stage, or mutate Git.
 * 2. Reads strictly via GitPort.inspectState and CheckpointStore.
 * 3. Applies MCP secret sanitization.
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
import { DefaultGitPort } from '../../git/default-git-port.js';
import { CheckpointStore, type PersistentCheckpointRecord } from '../../cli/checkpoint-store.js';

export const AIDM_GIT_STATUS_TOOL_NAME = 'aidm.git.status';

export const GitStatusInputZodSchema = z.object({}).strict();

export type GitStatusInput = z.infer<typeof GitStatusInputZodSchema>;

export interface GitStatusOutput {
  readonly isGitRepository: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly workingTreeClean: boolean | null;
  readonly trackingBranch: string | null;
  readonly lastAcceptedCheckpoint: {
    readonly checkpointId: string;
    readonly commitSha: string;
    readonly branch: string;
    readonly purpose: string;
    readonly createdAt: string;
    readonly taskId: string | null;
  } | null;
  readonly totalAcceptedCheckpoints: number;
  readonly correlationId: string;
}

export const gitStatusToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_GIT_STATUS_TOOL_NAME,
  description:
    'Returns authoritative current Git state (HEAD commit SHA, branch, clean/dirty state, and accepted checkpoints). Strictly read-only; executes zero Git mutations.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
});

export function createGitStatusTool(): McpToolRegistration {
  return {
    definition: gitStatusToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = GitStatusInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_GIT_STATUS_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      // 1. Inspect Git state safely (read-only inspectState)
      const gitPort = delegate?.gitPort ?? new DefaultGitPort();
      let isGitRepo = false;
      let headSha: string | null = null;
      let branchName: string | null = null;
      let cleanTree: boolean | null = null;

      try {
        const gitState = await gitPort.inspectState(projectRoot);
        isGitRepo = true;
        headSha = gitState.head_sha ?? null;
        branchName = gitState.current_branch ?? null;
        cleanTree = gitState.working_tree_clean;
      } catch {
        isGitRepo = false;
      }

      // 2. Load Checkpoint records
      const checkpointStore =
        delegate?.checkpointStore ?? new CheckpointStore(projectRoot);

      let totalAccepted = 0;
      let lastCheckpoint: GitStatusOutput['lastAcceptedCheckpoint'] = null;

      try {
        const checkpoints = await checkpointStore.loadCheckpoints();
        totalAccepted = checkpoints.length;
        if (checkpoints.length > 0) {
          const sorted = [...checkpoints].sort((a, b) => a.created_at.localeCompare(b.created_at));
          const latest = sorted[sorted.length - 1];
          lastCheckpoint = {
            checkpointId: latest.checkpoint_id,
            commitSha: latest.commit_sha,
            branch: latest.branch,
            purpose: latest.purpose,
            createdAt: latest.created_at,
            taskId: latest.task_id,
          };
        }
      } catch {
        // No checkpoint store or unreadable
      }

      const payload: GitStatusOutput = {
        isGitRepository: isGitRepo,
        head: headSha,
        branch: branchName,
        workingTreeClean: cleanTree,
        trackingBranch: null,
        lastAcceptedCheckpoint: lastCheckpoint,
        totalAcceptedCheckpoints: totalAccepted,
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
