/**
 * Director ↔ Executor Loop MCP Tools (Phase 16 TASK-P16-01)
 *
 * Implements MCP boundary tools exposing the controlled Director ↔ Executor feedback cycle.
 *
 * HARD GOVERNANCE RULES:
 * 1. Exposes ONLY the orchestration boundary.
 * 2. Zero arbitrary shell or process execution tools exposed.
 * 3. Cannot bypass ExecutionAuthorizer, ExecutorGuard, SystemEvidenceCollector, or ExecutionStateIntegrator.
 * 4. P16 executes exactly ONE cycle at a time; no automatic continuous loop or daemon.
 */

import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { DirectorLoopEngine } from '../../director-loop/director-loop-engine.js';
import { DirectorLoopStore } from '../../director-loop/director-loop-store.js';

export const DIRECTOR_INGEST_INSTRUCTION_TOOL_NAME = 'director.ingestInstruction';
export const DIRECTOR_EXECUTE_CYCLE_TOOL_NAME = 'director.executeCycle';
export const DIRECTOR_GET_CYCLE_RESULT_TOOL_NAME = 'director.getCycleResult';
export const DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME = 'director.evaluateNextAction';

// ----------------------------------------------------------------------------
// 1. Tool Definitions
// ----------------------------------------------------------------------------

export const directorIngestInstructionToolDefinition: McpToolDefinition = {
  name: DIRECTOR_INGEST_INSTRUCTION_TOOL_NAME,
  description:
    'Authoritatively ingests and validates a Director instruction bound to an active session, IMPLEMENT_TASK decision, and human Product Owner approval.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      projectId: { type: 'string', description: 'Canonical project identifier' },
      directorSessionId: { type: 'string', description: 'Active Director session ID' },
      directorDecisionId: { type: 'string', description: 'Bound Director decision ID' },
      taskId: { type: 'string', description: 'Bound task ID in SpecStore' },
      taskRevision: { type: 'number', description: 'Expected task revision' },
      contextFingerprint: { type: 'string', description: 'Context snapshot fingerprint' },
      understandingRevision: { type: 'number', description: 'Authoritative understanding revision' },
      approvalPackageRevision: { type: 'number', description: 'Bound human approval package revision' },
      objective: { type: 'string', description: 'Instruction objective' },
      targetFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target files to modify (relative POSIX paths only)',
      },
      implementationScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional allowed implementation scope',
      },
      actor: { type: 'string', description: "Must strictly be 'DIRECTOR'" },
    },
    required: [
      'directorSessionId',
      'directorDecisionId',
      'taskId',
      'taskRevision',
      'contextFingerprint',
      'understandingRevision',
      'approvalPackageRevision',
      'objective',
      'targetFiles',
    ],
  },
};

export const directorExecuteCycleToolDefinition: McpToolDefinition = {
  name: DIRECTOR_EXECUTE_CYCLE_TOOL_NAME,
  description:
    'Executes a single controlled execution cycle through the authoritative pipeline. Does NOT run continuous autonomous loops.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      instructionId: { type: 'string', description: 'ID of ingested instruction to execute' },
      timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds' },
    },
    required: ['instructionId'],
  },
};

export const directorGetCycleResultToolDefinition: McpToolDefinition = {
  name: DIRECTOR_GET_CYCLE_RESULT_TOOL_NAME,
  description:
    'Retrieves authoritative execution cycle result and independently verified system evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      cycleId: { type: 'string', description: 'Cycle identifier' },
      instructionId: { type: 'string', description: 'Instruction identifier' },
      taskId: { type: 'string', description: 'Task identifier' },
    },
  },
};

export const directorEvaluateNextActionToolDefinition: McpToolDefinition = {
  name: DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME,
  description:
    'Evaluates the next-action boundary and recovery / human decision routing without auto-continuing.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      cycleId: { type: 'string', description: 'Cycle identifier' },
      instructionId: { type: 'string', description: 'Instruction identifier' },
      taskId: { type: 'string', description: 'Task identifier' },
    },
  },
};

// ----------------------------------------------------------------------------
// 2. Tool Handlers
// ----------------------------------------------------------------------------

export function createDirectorIngestInstructionHandler(
  serverRoot?: string,
  serverDelegate?: McpOrchestratorDelegate
): McpToolHandler {
  return async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
    const delegate = context.delegate ?? serverDelegate;
    const resolvedRoot =
      (rawArgs.workspaceRoot as string | undefined) ??
      serverRoot ??
      delegate?.projectRoot ??
      process.cwd();

    const engine = new DirectorLoopEngine({
      workspaceRoot: resolvedRoot,
      delegate,
    });

    try {
      const instruction = await engine.ingestInstruction({
        workspaceRoot: resolvedRoot,
        projectId: rawArgs.projectId as string | undefined,
        directorSessionId: String(rawArgs.directorSessionId ?? ''),
        directorDecisionId: String(rawArgs.directorDecisionId ?? ''),
        taskId: String(rawArgs.taskId ?? ''),
        taskRevision: Number(rawArgs.taskRevision ?? 0),
        contextFingerprint: String(rawArgs.contextFingerprint ?? ''),
        understandingRevision: Number(rawArgs.understandingRevision ?? 0),
        approvalPackageRevision: Number(rawArgs.approvalPackageRevision ?? 0),
        objective: String(rawArgs.objective ?? ''),
        targetFiles: (rawArgs.targetFiles as string[]) ?? [],
        implementationScope: rawArgs.implementationScope as string[] | undefined,
        actor: rawArgs.actor as string | undefined,
      });

      const payload = {
        success: true,
        instruction: sanitizeMcpPayload(instruction),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? 'ERR_DIRECTOR_INSTRUCTION_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: true,
      };
    }
  };
}

export function createDirectorExecuteCycleHandler(
  serverRoot?: string,
  serverDelegate?: McpOrchestratorDelegate
): McpToolHandler {
  return async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
    const delegate = context.delegate ?? serverDelegate;
    const resolvedRoot =
      (rawArgs.workspaceRoot as string | undefined) ??
      serverRoot ??
      delegate?.projectRoot ??
      process.cwd();

    const engine = new DirectorLoopEngine({
      workspaceRoot: resolvedRoot,
      delegate,
    });

    try {
      const result = await engine.executeCycle({
        workspaceRoot: resolvedRoot,
        instructionId: String(rawArgs.instructionId ?? ''),
        timeoutMs: rawArgs.timeoutMs ? Number(rawArgs.timeoutMs) : undefined,
      });

      const payload = {
        success: true,
        cycleResult: sanitizeMcpPayload(result),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? 'ERR_DIRECTOR_EXECUTION_CYCLE_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: true,
      };
    }
  };
}

export function createDirectorGetCycleResultHandler(
  serverRoot?: string,
  serverDelegate?: McpOrchestratorDelegate
): McpToolHandler {
  return async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
    const delegate = context.delegate ?? serverDelegate;
    const resolvedRoot =
      (rawArgs.workspaceRoot as string | undefined) ??
      serverRoot ??
      delegate?.projectRoot ??
      process.cwd();

    const store = new DirectorLoopStore({
      baseDir: resolvedRoot,
      historyManager: delegate?.historyManager,
    });

    try {
      let cycleResult = null;
      if (rawArgs.cycleId) {
        cycleResult = await store.getCycleResult(String(rawArgs.cycleId));
      } else if (rawArgs.instructionId) {
        cycleResult = await store.getCycleResultByInstructionId(String(rawArgs.instructionId));
      } else if (rawArgs.taskId) {
        const canonical = (rawArgs.projectId as string) ?? 'default';
        cycleResult = await store.getLatestCycleResultForTask(canonical, String(rawArgs.taskId));
      }

      const payload = {
        success: cycleResult !== null,
        cycleResult: sanitizeMcpPayload(cycleResult),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? 'ERR_GET_CYCLE_RESULT_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: true,
      };
    }
  };
}

export function createDirectorEvaluateNextActionHandler(
  serverRoot?: string,
  serverDelegate?: McpOrchestratorDelegate
): McpToolHandler {
  return async (rawArgs: Readonly<Record<string, unknown>>, context: McpRequestContext) => {
    const delegate = context.delegate ?? serverDelegate;
    const resolvedRoot =
      (rawArgs.workspaceRoot as string | undefined) ??
      serverRoot ??
      delegate?.projectRoot ??
      process.cwd();

    const engine = new DirectorLoopEngine({
      workspaceRoot: resolvedRoot,
      delegate,
    });

    try {
      const boundary = await engine.evaluateNextAction({
        workspaceRoot: resolvedRoot,
        projectId: rawArgs.projectId as string | undefined,
        cycleId: rawArgs.cycleId as string | undefined,
        instructionId: rawArgs.instructionId as string | undefined,
        taskId: rawArgs.taskId as string | undefined,
      });

      const payload = {
        success: true,
        boundary: sanitizeMcpPayload(boundary),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? 'ERR_EVALUATE_NEXT_ACTION_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        isError: true,
      };
    }
  };
}

// ----------------------------------------------------------------------------
// 3. Server Registration Function
// ----------------------------------------------------------------------------

export function registerDirectorLoopTools(server: McpServer): void {
  server.registerTool(
    directorIngestInstructionToolDefinition,
    createDirectorIngestInstructionHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorExecuteCycleToolDefinition,
    createDirectorExecuteCycleHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorGetCycleResultToolDefinition,
    createDirectorGetCycleResultHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorEvaluateNextActionToolDefinition,
    createDirectorEvaluateNextActionHandler(undefined, server.delegate)
  );
}
