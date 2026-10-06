/**
 * Autonomous Driver MCP Tools (Phase 17 TASK-P17-01)
 *
 * Implements governed MCP tools exposing the controlled Autonomous Driver lifecycle:
 * - driver.start
 * - driver.status
 * - driver.pause
 * - driver.resume
 * - driver.stop
 *
 * HARD GOVERNANCE RULES:
 * 1. Exposes ONLY governed driver lifecycle controls.
 * 2. Zero arbitrary shell or arbitrary process execution.
 * 3. Enforces single active driver per project.
 * 4. Fails closed on unauthorized, stale, or conflicting state.
 */

import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { DriverRuntime } from '../../driver/driver-runtime.js';
import { DriverStore } from '../../driver/driver-store.js';
import { DriverLockManager } from '../../driver/driver-lock.js';
import { DriverEngine } from '../../driver/driver-engine.js';
import { resolveCanonicalProjectIdentity } from '../../director/project-identity-resolver.js';

export const DRIVER_START_TOOL_NAME = 'driver.start';
export const DRIVER_STATUS_TOOL_NAME = 'driver.status';
export const DRIVER_PAUSE_TOOL_NAME = 'driver.pause';
export const DRIVER_RESUME_TOOL_NAME = 'driver.resume';
export const DRIVER_STOP_TOOL_NAME = 'driver.stop';

// ----------------------------------------------------------------------------
// 1. Tool Definitions
// ----------------------------------------------------------------------------

export const driverStartToolDefinition: McpToolDefinition = {
  name: DRIVER_START_TOOL_NAME,
  description:
    'Starts the governed Autonomous Driver runtime for a project. Validates single active driver and executes controlled iterations.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      projectId: { type: 'string', description: 'Canonical project identifier' },
      directorSessionId: { type: 'string', description: 'Optional active Director session ID' },
      targetTaskId: { type: 'string', description: 'Optional target task ID to execute' },
      maxIterations: { type: 'number', description: 'Maximum controlled iterations to run' },
      timeoutMs: { type: 'number', description: 'Per-cycle execution timeout in milliseconds' },
    },
  },
};

export const driverStatusToolDefinition: McpToolDefinition = {
  name: DRIVER_STATUS_TOOL_NAME,
  description:
    'Reads durable Autonomous Driver state, lifecycle status, lock information, and current progress.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      projectId: { type: 'string', description: 'Optional project identifier' },
    },
  },
};

export const driverPauseToolDefinition: McpToolDefinition = {
  name: DRIVER_PAUSE_TOOL_NAME,
  description:
    'Safely pauses the running Autonomous Driver before starting the next execution cycle.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      projectId: { type: 'string', description: 'Optional project identifier' },
    },
  },
};

export const driverResumeToolDefinition: McpToolDefinition = {
  name: DRIVER_RESUME_TOOL_NAME,
  description:
    'Resumes a paused Autonomous Driver runtime after revalidating authoritative context and authorization.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      projectId: { type: 'string', description: 'Canonical project identifier' },
      targetTaskId: { type: 'string', description: 'Optional target task ID to execute' },
      maxIterations: { type: 'number', description: 'Maximum controlled iterations to run' },
      timeoutMs: { type: 'number', description: 'Per-cycle execution timeout in milliseconds' },
    },
  },
};

export const driverStopToolDefinition: McpToolDefinition = {
  name: DRIVER_STOP_TOOL_NAME,
  description:
    'Gracefully stops the Autonomous Driver, releases the project lock, and preserves state.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Workspace root path' },
      projectId: { type: 'string', description: 'Optional project identifier' },
      reason: { type: 'string', description: 'Optional stop reason' },
    },
  },
};

// ----------------------------------------------------------------------------
// 2. Tool Handlers
// ----------------------------------------------------------------------------

function getRuntime(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): DriverRuntime {
  const historyManager = delegate?.historyManager;
  const store = new DriverStore({ workspaceRoot: resolvedRoot, historyManager });
  const lock = new DriverLockManager({ workspaceRoot: resolvedRoot });
  const engine = new DriverEngine({
    workspaceRoot: resolvedRoot,
    historyManager,
    specStore: delegate?.specStore,
    durableStateManager: delegate?.durableStateManager,
    sessionStore: delegate?.directorSessionStore,
    approvalStore: delegate?.approvalStore,
    approvalPackageEngine: delegate?.approvalPackageEngine,
    decisionStore: delegate?.directorDecisionStore,
    executorPort: delegate?.executorPort,
  });

  return new DriverRuntime({
    workspaceRoot: resolvedRoot,
    driverEngine: engine,
    lockManager: lock,
    driverStore: store,
    historyManager,
  });
}

export function createDriverStartHandler(
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

    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    if (rawArgs.projectId && rawArgs.projectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${rawArgs.projectId}' at '${canonical.projectRoot}'. Accidental cross-project driver execution rejected.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId: rawArgs.projectId },
          correlationId: context.correlation.correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    if (rawArgs.directorSessionId && delegate?.directorSessionStore) {
      const session = await delegate.directorSessionStore.loadSession(String(rawArgs.directorSessionId));
      if (!session || session.status !== 'ACTIVE') {
        const payload = {
          success: false,
          error: {
            code: 'ERR_SESSION_NOT_ACTIVE',
            message: `Director session '${rawArgs.directorSessionId}' is ${session?.status ?? 'MISSING'}. Driver execution requires an ACTIVE session.`,
            details: { directorSessionId: rawArgs.directorSessionId, status: session?.status },
            correlationId: context.correlation.correlationId,
          },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          isError: true,
        };
      }
      if (session.projectId !== canonical.projectId) {
        const payload = {
          success: false,
          error: {
            code: 'ERR_PROJECT_MISMATCH',
            message: `Director session '${rawArgs.directorSessionId}' belongs to project '${session.projectId}', not '${canonical.projectId}'.`,
            details: { sessionProjectId: session.projectId, canonicalProjectId: canonical.projectId },
            correlationId: context.correlation.correlationId,
          },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          isError: true,
        };
      }
    }

    const runtime = getRuntime(resolvedRoot, delegate);

    try {
      const summary = await runtime.start({
        workspaceRoot: resolvedRoot,
        projectId: canonical.projectId,
        directorSessionId: rawArgs.directorSessionId as string | undefined,
        targetTaskId: rawArgs.targetTaskId as string | undefined,
        maxIterations:
          typeof rawArgs.maxIterations === 'number'
            ? rawArgs.maxIterations
            : undefined,
        timeoutMs:
          typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      });

      const payload = {
        success: true,
        summary: sanitizeMcpPayload(summary),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.name ?? 'ERR_DRIVER_START_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

export function createDriverStatusHandler(
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

    const store = new DriverStore({
      workspaceRoot: resolvedRoot,
      historyManager: delegate?.historyManager,
    });
    const lock = new DriverLockManager({ workspaceRoot: resolvedRoot });

    try {
      const state = await store.loadState();
      const lockInfo = await lock.getLockInfo();
      const isLocked = await lock.isLocked();

      const payload = {
        success: true,
        driverState: state ? sanitizeMcpPayload(state) : null,
        lock: lockInfo ? sanitizeMcpPayload(lockInfo) : null,
        isLocked,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.name ?? 'ERR_DRIVER_STATUS_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

export function createDriverPauseHandler(
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

    const runtime = getRuntime(resolvedRoot, delegate);

    try {
      await runtime.recover();
      await runtime.pause();

      const payload = {
        success: true,
        message: 'Driver paused successfully.',
        currentState: runtime.currentState,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.name ?? 'ERR_DRIVER_PAUSE_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

export function createDriverResumeHandler(
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

    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    if (rawArgs.projectId && rawArgs.projectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${rawArgs.projectId}' at '${canonical.projectRoot}'. Accidental cross-project driver resume rejected.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId: rawArgs.projectId },
          correlationId: context.correlation.correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const runtime = getRuntime(resolvedRoot, delegate);

    try {
      await runtime.recover();
      const summary = await runtime.resume({
        workspaceRoot: resolvedRoot,
        projectId: canonical.projectId,
        targetTaskId: rawArgs.targetTaskId as string | undefined,
        maxIterations:
          typeof rawArgs.maxIterations === 'number'
            ? rawArgs.maxIterations
            : undefined,
        timeoutMs:
          typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      });

      const payload = {
        success: true,
        summary: sanitizeMcpPayload(summary),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.name ?? 'ERR_DRIVER_RESUME_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

export function createDriverStopHandler(
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

    const runtime = getRuntime(resolvedRoot, delegate);

    try {
      await runtime.recover();
      await runtime.stop(
        typeof rawArgs.reason === 'string' ? rawArgs.reason : 'Stopped via MCP tool'
      );

      const payload = {
        success: true,
        message: 'Driver stopped gracefully.',
        currentState: runtime.currentState,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.name ?? 'ERR_DRIVER_STOP_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

// ----------------------------------------------------------------------------
// 3. Server Registration Function
// ----------------------------------------------------------------------------

export function registerDriverTools(server: McpServer): void {
  server.registerTool(
    driverStartToolDefinition,
    createDriverStartHandler(undefined, server.delegate)
  );
  server.registerTool(
    driverStatusToolDefinition,
    createDriverStatusHandler(undefined, server.delegate)
  );
  server.registerTool(
    driverPauseToolDefinition,
    createDriverPauseHandler(undefined, server.delegate)
  );
  server.registerTool(
    driverResumeToolDefinition,
    createDriverResumeHandler(undefined, server.delegate)
  );
  server.registerTool(
    driverStopToolDefinition,
    createDriverStopHandler(undefined, server.delegate)
  );
}
