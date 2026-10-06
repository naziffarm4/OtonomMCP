/**
 * Task Decomposition MCP Tools (Phase 12 TASK-P12-01)
 *
 * Exposes bounded, strictly typed Task Decomposition operations through the MCP boundary:
 * 1. aidm.task.decompose
 *
 * STRICT GOVERNANCE RULES:
 * 1. Requires an active, approved project package (isDevelopmentAuthorized() === true).
 * 2. Director output is strictly untrusted candidate data and must pass full deterministic DAG checks.
 * 3. Does NOT invoke Antigravity execution or autonomous iteration loops.
 * 4. Strictly sanitizes secrets and redacts tokens/credentials.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { TaskDecompositionEngine } from '../../task-decomposition/task-decomposition-engine.js';
import {
  DecomposePlanInputZodSchema,
} from '../../task-decomposition/task-decomposition-types.js';
import { resolveTargetProjectRoot } from '../project-root-resolver.js';
import { TaskDecompositionError } from '../../task-decomposition/task-decomposition-errors.js';

export const AIDM_TASK_DECOMPOSE_TOOL_NAME = 'aidm.task.decompose';

function getDecompositionEngine(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): TaskDecompositionEngine {
  const isSameRoot = delegate?.projectRoot === resolvedRoot;
  return new TaskDecompositionEngine({
    workspaceRoot: resolvedRoot,
    delegate: isSameRoot ? delegate : undefined,
    specStore: (isSameRoot && delegate?.specStore) ? delegate.specStore : undefined,
    dagEngine: (isSameRoot && delegate?.dagEngine) ? delegate.dagEngine : undefined,
    approvalStore: (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : undefined,
    sessionStore: (isSameRoot && delegate?.directorSessionStore) ? delegate.directorSessionStore : undefined,
    historyManager: (isSameRoot && delegate?.historyManager) ? delegate.historyManager : undefined,
  });
}

export const taskDecomposeToolDefinition: McpToolDefinition = {
  name: AIDM_TASK_DECOMPOSE_TOOL_NAME,
  description:
    'Decomposes an approved development plan into authoritative, validated, persistent tasks in SpecStore and TaskDagEngine. Requires explicit Product Owner approval. Does NOT execute tasks.',
  inputSchema: {
    type: 'object',
    required: ['directorSessionId', 'contextFingerprint', 'approvalPackageId', 'approvalPackageRevision'],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier. Must match canonical project identity if provided.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Active Director session identifier.',
      },
      contextFingerprint: {
        type: 'string',
        description: 'Deterministic fingerprint of the latest complete Director Context Snapshot.',
      },
      approvalPackageId: {
        type: 'string',
        description: 'Identifier of the approved project package.',
      },
      approvalPackageRevision: {
        type: 'number',
        description: 'Exact revision number of the approved package.',
      },
      understandingRevision: {
        type: 'number',
        description: 'Optional project understanding revision number.',
      },
      decompositionRevision: {
        type: 'number',
        description: 'Optional decomposition revision number (defaults to 1).',
      },
      candidateTasks: {
        type: 'array',
        items: { type: 'object' },
        description: 'Optional candidate task proposals from the Director. Validated before persistence.',
      },
      metadata: {
        type: 'object',
        description: 'Optional decomposition metadata. Sensitive credentials and tokens are redacted.',
      },
    },
  },
};

export function createTaskDecomposeTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: taskDecomposeToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof DecomposePlanInputZodSchema>;
      try {
        parsed = DecomposePlanInputZodSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid task decomposition request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate,
      });
      const engine = getDecompositionEngine(resolvedRoot, delegate);

      try {
        const result = await engine.decomposePlan({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(result), null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof TaskDecompositionError) {
          throw new McpInvalidRequestError(err.message, { code: err.code, details: err.details });
        }
        throw err;
      }
    },
  };
}

export function registerTaskDecompositionTools(server: McpServer): void {
  const tool = createTaskDecomposeTool(server.delegate);
  server.registerTool(tool.definition, tool.handler);
}
