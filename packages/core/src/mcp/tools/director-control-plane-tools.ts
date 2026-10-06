/**
 * Director MCP Control Plane Tools (Phase 22 TASK-P22-01)
 *
 * Implements the minimal, stable, high-level MCP Control Plane for ChatGPT Director
 * and external AI agents, as well as Antigravity internal client usage.
 *
 * EXACT HIGH-LEVEL TOOL SET (strictly 6 tools):
 * 1. aidm.director.open    - Open project/session or get existing session (session continuity)
 * 2. aidm.director.context - Current authoritative context snapshot (read-only)
 * 3. aidm.director.act     - Send structured action (schema + freshness + authorization + policy gate)
 * 4. aidm.director.result  - Retrieve action / cycle / evidence result
 * 5. aidm.director.status  - Unified project / session / cycle status
 * 6. aidm.director.control - Lifecycle control (pause | resume | stop) with per-action authorization
 *
 * HARD GOVERNANCE RULES:
 * 1. Reuses existing ClosedLoopCoordinator, DirectorLoopEngine, DriverRuntime, and Authorization Policy.
 * 2. Does NOT create any new Orchestrator, Task DAG, FSM, Driver, or Evidence engine.
 * 3. Zero arbitrary shell or command execution tools exposed.
 * 4. Preserves session continuity (reuses active/resumable session unless forceNew is explicit).
 * 5. Fail-closed on stale context fingerprint or revision mismatch.
 * 6. Anti-spoofing and human approval gates strictly enforced.
 * 7. All responses and error details are secret-sanitized.
 */

import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError, McpPolicyBlockedError } from '../mcp-errors.js';
import { resolveCanonicalProjectIdentity } from '../../director/project-identity-resolver.js';
import { DirectorContextSynchronizer } from '../../director/director-context-synchronizer.js';
import { ClosedLoopCoordinator } from '../../director-loop/closed-loop-coordinator.js';
import { DriverRuntime } from '../../driver/driver-runtime.js';
import { DriverStore } from '../../driver/driver-store.js';
import { DriverLockManager } from '../../driver/driver-lock.js';
import { DriverEngine } from '../../driver/driver-engine.js';
import {
  DirectorInstructionValidationError,
  DirectorInstructionUnauthorizedError,
  DirectorInstructionStaleError,
  DirectorInstructionRevisionMismatchError,
  DirectorInstructionSessionMismatchError,
  DirectorInstructionProjectMismatchError,
} from '../../director-loop/director-loop-errors.js';
import { DirectorContextUnavailableError } from '../../director/director-runtime-errors.js';
import { HistoryManager } from '../../storage/history-manager.js';
import { ApprovalStore } from '../../approval/approval-store.js';
import { ProjectMandateStore } from '../../authorization/project-mandate-store.js';
import { AuthorizationPolicyEngine } from '../../authorization/authorization-policy-engine.js';
import {
  computeDeterministicActionId,
  DirectorActionEnvelopeZodSchema,
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  type DirectorActionType,
  type DirectorActionEnvelope,
} from '../../director-action/director-action-types.js';
import { OperationActionType } from '../../policy/policy-types.js';
import { RiskLevel } from '../../risk.js';

// ============================================================================
// TOOL CONSTANTS (EXACTLY 6 HIGH-LEVEL TOOLS)
// ============================================================================

export const AIDM_DIRECTOR_OPEN_TOOL_NAME = 'aidm.director.open';
export const AIDM_DIRECTOR_CONTEXT_TOOL_NAME = 'aidm.director.context';
export const AIDM_DIRECTOR_ACT_TOOL_NAME = 'aidm.director.act';
export const AIDM_DIRECTOR_RESULT_TOOL_NAME = 'aidm.director.result';
export const AIDM_DIRECTOR_STATUS_TOOL_NAME = 'aidm.director.status';
export const AIDM_DIRECTOR_CONTROL_TOOL_NAME = 'aidm.director.control';

export const P22_DIRECTOR_CONTROL_PLANE_TOOL_NAMES = [
  AIDM_DIRECTOR_OPEN_TOOL_NAME,
  AIDM_DIRECTOR_CONTEXT_TOOL_NAME,
  AIDM_DIRECTOR_ACT_TOOL_NAME,
  AIDM_DIRECTOR_RESULT_TOOL_NAME,
  AIDM_DIRECTOR_STATUS_TOOL_NAME,
  AIDM_DIRECTOR_CONTROL_TOOL_NAME,
] as const;

// ============================================================================
// 1. TOOL DEFINITIONS
// ============================================================================

export const directorOpenToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_OPEN_TOOL_NAME,
  description:
    'Opens a new Director session or retrieves an existing active/resumable session for the project, ensuring session continuity without creating redundant sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Optional workspace root path' },
      projectId: { type: 'string', description: 'Optional canonical project identifier' },
      actor: { type: 'string', description: "Actor opening session. Must be 'DIRECTOR'. Cannot be 'USER' or 'EXECUTOR'." },
      actorRole: { type: 'string', enum: ['DIRECTOR', 'PROJECT_DIRECTOR'], description: 'Optional actor role' },
      metadata: { type: 'object', description: 'Optional session metadata (credentials redacted)' },
      forceNew: { type: 'boolean', description: 'If true, creates a new session even if an active one exists' },
    },
  },
};

export const directorContextToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_CONTEXT_TOOL_NAME,
  description:
    'Retrieves the current authoritative context snapshot, fingerprint, understanding revision, and aggregate project status. Strictly read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Optional workspace root path' },
      projectId: { type: 'string', description: 'Optional canonical project identifier' },
      directorSessionId: { type: 'string', description: 'Optional Director session ID. Defaults to active session.' },
      refresh: { type: 'boolean', description: 'Optional flag to refresh snapshot before returning' },
    },
  },
};

export const directorActToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_ACT_TOOL_NAME,
  description:
    'Submits a structured Director action conforming to the P19/P26 specification. Enforces schema validation, active session binding, context freshness, anti-spoofing, and policy authorization.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Optional workspace root path' },
      projectId: { type: 'string', description: 'Optional canonical project identifier' },
      directorSessionId: { type: 'string', description: 'Active Director session ID' },
      actionType: {
        type: 'string',
        enum: [...DIRECTOR_ACTION_TYPES],
        description: 'Structured Director action type',
      },
      payload: { type: 'object', description: 'Action payload conforming to action schema' },
      basedOnContextFingerprint: { type: 'string', description: 'Context snapshot fingerprint the action was based on' },
      contextFingerprint: { type: 'string', description: 'Alias for basedOnContextFingerprint' },
      understandingRevision: { type: 'number', description: 'Expected understanding revision' },
      idempotencyKey: { type: 'string', description: 'Optional idempotency key' },
      authContext: { type: 'object', description: 'Optional cryptographic authorization context' },
      timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds' },
    },
    required: ['directorSessionId', 'actionType', 'payload'],
  },
};

export const directorResultToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_RESULT_TOOL_NAME,
  description:
    'Retrieves authoritative execution cycle results, action dispatch outcomes, and independently verified system evidence references.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Optional workspace root path' },
      projectId: { type: 'string', description: 'Optional canonical project identifier' },
      cycleId: { type: 'string', description: 'Optional cycle identifier' },
      actionId: { type: 'string', description: 'Optional action identifier' },
      instructionId: { type: 'string', description: 'Optional instruction identifier alias for actionId' },
      taskId: { type: 'string', description: 'Optional task identifier' },
    },
  },
};

export const directorStatusToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_STATUS_TOOL_NAME,
  description:
    'Retrieves unified high-level lifecycle status across project, session, DAG, driver, and human approval gates. Returns standard status enum (RUNNING | WAITING_HUMAN | PAUSED | FAILED | COMPLETED | IDLE).',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Optional workspace root path' },
      projectId: { type: 'string', description: 'Optional canonical project identifier' },
      directorSessionId: { type: 'string', description: 'Optional Director session ID' },
    },
  },
};

export const directorControlToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_CONTROL_TOOL_NAME,
  description:
    'Executes governed lifecycle control operations (pause | resume | stop) over project execution. Each sub-action undergoes fine-grained authorization checks.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', description: 'Optional workspace root path' },
      projectId: { type: 'string', description: 'Optional canonical project identifier' },
      action: {
        type: 'string',
        enum: ['pause', 'resume', 'stop'],
        description: 'Lifecycle control operation to perform',
      },
      reason: { type: 'string', description: 'Optional reason for control action' },
      targetTaskId: { type: 'string', description: 'Optional target task ID for resume' },
      maxIterations: { type: 'number', description: 'Optional maximum iterations for resume' },
      timeoutMs: { type: 'number', description: 'Optional per-cycle timeout in milliseconds' },
    },
    required: ['action'],
  },
};

// ============================================================================
// 2. HELPER FUNCTIONS
// ============================================================================

function getCoordinator(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): ClosedLoopCoordinator {
  if (delegate?.getClosedLoopCoordinator) {
    return delegate.getClosedLoopCoordinator(resolvedRoot);
  }
  if (delegate?.closedLoopCoordinator) {
    return delegate.closedLoopCoordinator;
  }
  const historyManager = delegate?.historyManager ?? new HistoryManager({ baseDir: resolvedRoot });
  const approvalStore =
    delegate?.approvalStore ?? new ApprovalStore({ baseDir: resolvedRoot, historyManager });
  const mandateStore = new ProjectMandateStore({ baseDir: resolvedRoot });
  const authEngine =
    delegate?.authorizationPolicyEngine ??
    new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
    });

  return new ClosedLoopCoordinator({
    workspaceRoot: resolvedRoot,
    sessionStore: delegate?.directorSessionStore,
    decisionStore: delegate?.directorDecisionStore,
    approvalStore,
    approvalPackageEngine: delegate?.approvalPackageEngine,
    specStore: delegate?.specStore,
    dagEngine: delegate?.dagEngine,
    durableStateManager: delegate?.durableStateManager,
    historyManager,
    executorPort: delegate?.executorPort,
    directorRuntime: delegate?.directorRuntime,
    authorizationPolicyEngine: authEngine,
  });
}

function getDriverRuntime(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate,
  coordinator?: ClosedLoopCoordinator
): DriverRuntime {
  const historyManager = delegate?.historyManager ?? coordinator?.historyManager;
  const store = new DriverStore({ workspaceRoot: resolvedRoot, historyManager });
  const lock = new DriverLockManager({ workspaceRoot: resolvedRoot });
  const engine =
    coordinator?.driverEngine ??
    new DriverEngine({
      workspaceRoot: resolvedRoot,
      historyManager,
      specStore: delegate?.specStore ?? coordinator?.specStore,
      durableStateManager: delegate?.durableStateManager ?? coordinator?.durableStateManager,
      sessionStore: delegate?.directorSessionStore ?? coordinator?.sessionStore,
      approvalStore: delegate?.approvalStore ?? coordinator?.approvalStore,
      approvalPackageEngine: delegate?.approvalPackageEngine ?? coordinator?.approvalPackageEngine,
      decisionStore: delegate?.directorDecisionStore ?? coordinator?.decisionStore,
      executorPort: delegate?.executorPort ?? coordinator?.executorPort,
    });

  return new DriverRuntime({
    workspaceRoot: resolvedRoot,
    driverEngine: engine,
    lockManager: lock,
    driverStore: store,
    historyManager,
  });
}

// ============================================================================
// 3. TOOL HANDLERS
// ============================================================================

/**
 * Handler for aidm.director.open
 */
export function createDirectorOpenHandler(
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = (rawArgs.projectId as string | undefined) ?? (context.correlation.projectId ?? undefined);

    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}' at '${canonical.projectRoot}'. Accidental cross-project session rejected.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    // Anti-spoofing check
    const actor = (rawArgs.actor as string | undefined) ?? 'DIRECTOR';
    if (actor === 'USER' || actor === 'EXECUTOR') {
      const payload = {
        success: false,
        error: {
          code: 'ERR_UNAUTHORIZED_ACTOR',
          message: `Anti-spoofing violation: Director session actor cannot be '${actor}'. Must be 'DIRECTOR'.`,
          details: { actor },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const coordinator = getCoordinator(resolvedRoot, delegate);
    const forceNew = Boolean(rawArgs.forceNew);

    try {
      // 1. Session continuity: check if active session already exists for this project
      if (!forceNew) {
        const activeSession = await coordinator.sessionStore.getActiveSession();
        if (activeSession && activeSession.projectId === canonical.projectId && activeSession.status === 'ACTIVE') {
          const snapshot = await coordinator.sessionStore.loadLatestSnapshot(activeSession.directorSessionId);
          const payload = {
            success: true,
            correlationId,
            projectId: canonical.projectId,
            directorSessionId: activeSession.directorSessionId,
            session: sanitizeMcpPayload(activeSession),
            isNewSession: false,
            sessionContinuity: true,
            contextFingerprint: snapshot?.logicalFingerprint ?? '',
            understandingRevision: activeSession.understandingRevision ?? 1,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        }

        // Check if there is a suspended session we can resume
        const allSessions = await coordinator.sessionStore.listSessions();
        const suspendedSession = [...allSessions].find(
          (s) => s.projectId === canonical.projectId && s.status === 'SUSPENDED'
        );

        if (suspendedSession) {
          const resumed = await coordinator.sessionEngine.resumeSession({
            directorSessionId: suspendedSession.directorSessionId,
            workspaceRoot: resolvedRoot,
            projectId: canonical.projectId,
          });
          const snapshot = await coordinator.sessionStore.loadLatestSnapshot(resumed.directorSessionId);
          const payload = {
            success: true,
            correlationId,
            projectId: canonical.projectId,
            directorSessionId: resumed.directorSessionId,
            session: sanitizeMcpPayload(resumed),
            isNewSession: false,
            sessionContinuity: true,
            resumedFromSuspended: true,
            contextFingerprint: snapshot?.logicalFingerprint ?? '',
            understandingRevision: resumed.understandingRevision ?? 1,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        }
      }

      // 2. Create controlled new session
      const newSession = await coordinator.sessionEngine.createSession({
        workspaceRoot: resolvedRoot,
        projectId: canonical.projectId,
        actor: 'DIRECTOR',
        actorRole: (rawArgs.actorRole as 'DIRECTOR' | 'PROJECT_DIRECTOR') ?? 'DIRECTOR',
        metadata: (rawArgs.metadata as Record<string, unknown>) ?? undefined,
      });

      // Synchronize initial context snapshot
      const synchronizer = new DirectorContextSynchronizer({
        workspaceRoot: resolvedRoot,
        sessionStore: coordinator.sessionStore,
        sessionEngine: coordinator.sessionEngine,
      });

      const syncResult = await synchronizer.synchronize({
        workspaceRoot: resolvedRoot,
        projectId: canonical.projectId,
        directorSessionId: newSession.directorSessionId,
      });

      const payload = {
        success: true,
        correlationId,
        projectId: canonical.projectId,
        directorSessionId: newSession.directorSessionId,
        session: sanitizeMcpPayload(newSession),
        isNewSession: true,
        sessionContinuity: false,
        contextFingerprint: syncResult.logicalFingerprint,
        understandingRevision: newSession.understandingRevision ?? 1,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_OPEN_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

/**
 * Handler for aidm.director.context
 */
export function createDirectorContextHandler(
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = (rawArgs.projectId as string | undefined) ?? (context.correlation.projectId ?? undefined);

    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}'.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const coordinator = getCoordinator(resolvedRoot, delegate);

    try {
      let targetSessionId = rawArgs.directorSessionId as string | undefined;
      let session = null;

      if (targetSessionId) {
        session = await coordinator.sessionStore.loadSession(targetSessionId);
        if (!session) {
          throw new DirectorInstructionSessionMismatchError(
            `Director session '${targetSessionId}' not found.`,
            { directorSessionId: targetSessionId }
          );
        }
      } else {
        session = await coordinator.sessionStore.getActiveSession();
        if (!session) {
          throw new DirectorInstructionSessionMismatchError(
            'No active Director session found. Please open a session using aidm.director.open.',
            { status: 'MISSING' }
          );
        }
        targetSessionId = session.directorSessionId;
      }

      // Check project binding
      if (session.projectId !== canonical.projectId) {
        throw new DirectorInstructionProjectMismatchError(
          `Director session '${session.directorSessionId}' is bound to project '${session.projectId}', not '${canonical.projectId}'.`,
          { sessionProjectId: session.projectId, canonicalProjectId: canonical.projectId }
        );
      }

      // If refresh requested, run synchronizer
      if (rawArgs.refresh) {
        const synchronizer = new DirectorContextSynchronizer({
          workspaceRoot: resolvedRoot,
          sessionStore: coordinator.sessionStore,
          sessionEngine: coordinator.sessionEngine,
        });
        await synchronizer.synchronize({
          workspaceRoot: resolvedRoot,
          projectId: canonical.projectId,
          directorSessionId: targetSessionId!,
        });
      }

      const snapshot = await coordinator.sessionStore.loadLatestSnapshot(targetSessionId!);
      const activeApproval = await coordinator.approvalStore.getActivePackage(canonical.projectId);
      const allTasks = await coordinator.specStore.loadTasks();

      const tasksSummary = {
        total: allTasks.length,
        pending: allTasks.filter((t) => t.status === 'READY').length,
        inProgress: allTasks.filter((t) => t.status === 'IN_PROGRESS' || t.status === 'REVIEW').length,
        completed: allTasks.filter((t) => t.status === 'ACCEPTED').length,
        failed: allTasks.filter((t) => t.status === 'REJECTED').length,
        blocked: allTasks.filter((t) => t.status === 'BLOCKED').length,
      };

      const payload = {
        success: true,
        correlationId,
        projectId: canonical.projectId,
        directorSessionId: targetSessionId,
        sessionStatus: session.status,
        contextFingerprint: snapshot?.logicalFingerprint ?? '',
        understandingRevision: session.understandingRevision ?? 1,
        approvalPackage: activeApproval
          ? {
              packageId: activeApproval.packageId,
              status: activeApproval.status,
              revision: activeApproval.revision,
            }
          : null,
        tasksSummary,
        snapshot: snapshot ? sanitizeMcpPayload(snapshot) : null,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_CONTEXT_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

/**
 * Handler for aidm.director.act
 */
export function createDirectorActHandler(
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = (rawArgs.projectId as string | undefined) ?? (context.correlation.projectId ?? undefined);

    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}'. Accidental cross-project action rejected.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const coordinator = getCoordinator(resolvedRoot, delegate);

    try {
      const directorSessionId = String(rawArgs.directorSessionId ?? '');
      if (!directorSessionId) {
        throw new McpInvalidRequestError('Parameter "directorSessionId" is required for aidm.director.act');
      }

      // 1. Session verification: active session required
      const session = await coordinator.sessionStore.loadSession(directorSessionId);
      if (!session || session.status !== 'ACTIVE') {
        throw new DirectorInstructionSessionMismatchError(
          `Director session '${directorSessionId}' is ${session?.status ?? 'MISSING'}. An ACTIVE session is required for director.act.`,
          { directorSessionId, status: session?.status }
        );
      }

      if (session.projectId !== canonical.projectId) {
        throw new DirectorInstructionProjectMismatchError(
          `Director session '${directorSessionId}' belongs to project '${session.projectId}', not '${canonical.projectId}'.`,
          { sessionProjectId: session.projectId, canonicalProjectId: canonical.projectId }
        );
      }

      // 2. Anti-spoofing verification
      if (rawArgs.authContext && typeof rawArgs.authContext === 'object') {
        const ac = rawArgs.authContext as any;
        if (
          (ac.actor === 'USER' || ac.isTrustedHumanAuth === true || ac.hasImplementationAuthority === true) &&
          !ac.signature
        ) {
          throw new DirectorInstructionUnauthorizedError(
            'Unsigned or spoofed USER authorization context rejected. Trusted human auth requires valid cryptographic signature.',
            { authContext: ac }
          );
        }
      }

      const rawPayload = (rawArgs.payload as Record<string, unknown>) ?? {};
      if (
        (rawPayload as any).actor === 'USER' ||
        (rawPayload as any).actorRole === 'PRODUCT_OWNER' ||
        (rawPayload as any).isTrustedHumanAuth === true ||
        (rawPayload as any).authStatus === 'VERIFIED_HUMAN' ||
        (rawPayload as any).isDevelopmentAuthorized === true ||
        (rawPayload as any).hasImplementationAuthority === true ||
        (rawPayload as any).selfApproved === true ||
        (rawPayload as any).claimImplementationAuthority === true
      ) {
        throw new DirectorInstructionUnauthorizedError(
          'Anti-spoofing violation: fake USER authorization or unverified implementation authority in payload rejected.',
          { payload: rawPayload }
        );
      }

      // 3. Stale context & revision verification (Authoritative complete context snapshot strictly required)
      const latestSnapshot = await coordinator.sessionStore.loadLatestSnapshot(directorSessionId);

      if (
        !latestSnapshot ||
        !latestSnapshot.logicalFingerprint ||
        latestSnapshot.isComplete !== true ||
        latestSnapshot.projectId !== canonical.projectId ||
        latestSnapshot.directorSessionId !== directorSessionId ||
        latestSnapshot.logicalFingerprint.endsWith('-auto') ||
        latestSnapshot.logicalFingerprint.endsWith('-recovery') ||
        (Array.isArray(latestSnapshot.unavailableSections) && latestSnapshot.unavailableSections.length > 0)
      ) {
        throw new DirectorContextUnavailableError(
          'CONTEXT_UNAVAILABLE: Authoritative complete context snapshot is unavailable or synthetic for director action.',
          {
            code: 'CONTEXT_UNAVAILABLE',
            directorSessionId,
            projectId: canonical.projectId,
          }
        );
      }

      if (
        (latestSnapshot as any).isStale === true ||
        (Array.isArray(latestSnapshot.staleSections) && latestSnapshot.staleSections.length > 0)
      ) {
        throw new DirectorInstructionStaleError(
          `Context snapshot is stale: current snapshot contains stale sections (${(latestSnapshot.staleSections ?? []).join(', ')}).`,
          {
            expected: latestSnapshot.logicalFingerprint,
            actual: latestSnapshot.logicalFingerprint,
            staleSections: latestSnapshot.staleSections,
          }
        );
      }

      const expectedFingerprint =
        (rawArgs.basedOnContextFingerprint as string | undefined) ??
        (rawArgs.contextFingerprint as string | undefined);

      if (expectedFingerprint && latestSnapshot.logicalFingerprint !== expectedFingerprint) {
        throw new DirectorInstructionStaleError(
          `Context snapshot fingerprint mismatch: action was based on '${expectedFingerprint}', but current fingerprint is '${latestSnapshot.logicalFingerprint}'. Context has drifted; action is stale.`,
          { expected: expectedFingerprint, actual: latestSnapshot.logicalFingerprint }
        );
      }

      const expectedRevision =
        typeof rawArgs.understandingRevision === 'number'
          ? (rawArgs.understandingRevision as number)
          : undefined;

      const currentRevision = session.understandingRevision ?? 1;
      if (typeof expectedRevision === 'number' && currentRevision !== expectedRevision) {
        throw new DirectorInstructionRevisionMismatchError(
          `Understanding revision mismatch: action was based on rev ${expectedRevision}, but current session is at rev ${currentRevision}.`,
          { expected: expectedRevision, actual: currentRevision }
        );
      }

      const actionType = String(rawArgs.actionType ?? '') as DirectorActionType;
      const idempotencyKey =
        (rawArgs.idempotencyKey as string | undefined) ??
        `act-${canonical.projectId}-${directorSessionId}-${actionType}-${Date.now()}`;

      const actionId = computeDeterministicActionId({
        projectId: canonical.projectId,
        directorSessionId,
        actionType,
        idempotencyKey,
      });

      // 4. Construct and validate DirectorActionEnvelope
      const envelopeData: DirectorActionEnvelope = {
        protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
        schemaVersion: 1,
        actionId,
        idempotencyKey,
        projectId: canonical.projectId,
        directorSessionId,
        actionType,
        actor: 'DIRECTOR',
        actorRole: 'DIRECTOR',
        timestamp: new Date().toISOString(),
        basedOnContextFingerprint: expectedFingerprint ?? latestSnapshot.logicalFingerprint,
        understandingRevision: expectedRevision ?? currentRevision,
        payload: rawPayload,
      };

      const parseResult = DirectorActionEnvelopeZodSchema.safeParse(envelopeData);
      if (!parseResult.success) {
        throw new DirectorInstructionValidationError(
          `Action envelope schema validation failed: ${parseResult.error.message}`,
          { errors: parseResult.error.issues }
        );
      }

      // Check DECLARE_PROJECT_COMPLETE prerequisites
      if (actionType === 'DECLARE_PROJECT_COMPLETE') {
        if (rawPayload.finalVerificationRequested !== true) {
          throw new DirectorInstructionValidationError(
            'DECLARE_PROJECT_COMPLETE must explicitly request final verification (finalVerificationRequested: true).',
            { actionType, payload: rawPayload }
          );
        }
      }

      // 5. Execution vs Non-execution dispatch
      const isExecutionAction =
        actionType === 'IMPLEMENT_TASK' || actionType === 'RETRY_TASK' || actionType === 'CORRECT_TASK';

      if (isExecutionAction) {
        // Must pass through authoritative ClosedLoopCoordinator
        const targetTaskId = (rawPayload.taskId as string | undefined) ?? undefined;
        const instructionText =
          (rawPayload.executionPlan as string | undefined) ??
          (rawPayload.objective as string | undefined) ??
          (rawPayload.reason as string | undefined) ??
          actionType;

        const cycleResult = await coordinator.coordinateCycle({
          workspaceRoot: resolvedRoot,
          projectId: canonical.projectId,
          directorSessionId,
          targetTaskId,
          instruction: instructionText,
          idempotencyKey,
          authContext: rawArgs.authContext,
          timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
          customEnvelope: envelopeData,
        });

        const isSuccess = cycleResult.isSuccess && cycleResult.status === 'COMPLETED_SUCCESS';
        const evidence = cycleResult.systemEvidence ?? cycleResult.bridgeResult?.systemEvidence;

        const payload = {
          success: isSuccess,
          correlationId,
          projectId: canonical.projectId,
          directorSessionId,
          actionId,
          actionType,
          cycleId: cycleResult.cycleId,
          taskId: cycleResult.taskId,
          status: cycleResult.status,
          stepReached: cycleResult.stepReached,
          isAuthorized: cycleResult.status !== 'REJECTED_BY_POLICY',
          requiresHumanApproval: cycleResult.humanDecisionRequired ?? false,
          summary: cycleResult.summary,
          evidenceId: evidence?.evidenceId,
          verificationDecision: evidence?.verificationDecision,
          systemEvidence: evidence ? sanitizeMcpPayload(evidence as unknown as Record<string, unknown>) : undefined,
          cycleResult: sanitizeMcpPayload(cycleResult as unknown as Record<string, unknown>),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          isError: !isSuccess && (cycleResult.status === 'EXECUTION_FAILED' || cycleResult.status === 'REJECTED_BY_POLICY'),
        };
      }

      // Non-execution action: validate and dispatch through authoritative action pipeline
      const activePkg = await coordinator.approvalStore.getActivePackage(canonical.projectId);
      const mandate = await (coordinator.authorizationPolicyEngine as any)?.mandateStore?.loadMandate?.();

      const validationContext = {
        currentFingerprint: latestSnapshot.logicalFingerprint,
        currentUnderstandingRevision: currentRevision,
        currentDirectorSessionId: directorSessionId,
        currentProjectId: canonical.projectId,
        expectedApprovalRevision:
          typeof rawPayload.expectedApprovalRevision === 'number'
            ? (rawPayload.expectedApprovalRevision as number)
            : undefined,
        actualApprovalRevision: activePkg?.revision,
        expectedMandateRevision:
          typeof rawPayload.expectedMandateRevision === 'number'
            ? (rawPayload.expectedMandateRevision as number)
            : undefined,
        actualMandateRevision: mandate?.mandateRevision,
      };

      const validation = await coordinator.actionValidator.validateAsync(envelopeData, validationContext);

      const dispatchResult = await coordinator.actionDispatcher.dispatch({
        validatedResult: {
          success: true,
          envelope: validation.envelope,
          validationResult: validation,
          reasoningResult: {
            rawResponse: '',
            parsedDecision: {
              decisionType: envelopeData.actionType,
              payload: envelopeData.payload,
            },
          } as any,
          isDuplicate: validation.isDuplicate,
        },
        snapshot: latestSnapshot,
        correlationId,
      });

      const payload = {
        success: dispatchResult.status !== 'REJECTED',
        correlationId,
        projectId: canonical.projectId,
        directorSessionId,
        actionId,
        actionType,
        dispatchId: dispatchResult.dispatchId,
        status: dispatchResult.status,
        isAuthorized: dispatchResult.isAuthorized,
        requiresHumanApproval: dispatchResult.requiresHumanApproval,
        reason: dispatchResult.reason,
        dispatchResult: sanitizeMcpPayload(dispatchResult as unknown as Record<string, unknown>),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: dispatchResult.status === 'REJECTED',
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_ACT_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

/**
 * Handler for aidm.director.result
 */
export function createDirectorResultHandler(
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = (rawArgs.projectId as string | undefined) ?? (context.correlation.projectId ?? undefined);

    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}'.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const coordinator = getCoordinator(resolvedRoot, delegate);

    try {
      let cycleResult: any = null;
      const targetCycleId = rawArgs.cycleId as string | undefined;
      const targetActionId = (rawArgs.actionId as string | undefined) ?? (rawArgs.instructionId as string | undefined);
      const targetTaskId = rawArgs.taskId as string | undefined;

      if (targetCycleId) {
        cycleResult = await coordinator.loopStore.getCycleResult(targetCycleId);
      } else if (targetActionId) {
        cycleResult = await coordinator.loopStore.getCycleResultByInstructionId(targetActionId);
      } else if (targetTaskId) {
        cycleResult = await coordinator.loopStore.getLatestCycleResultForTask(canonical.projectId, targetTaskId);
      }

      let systemEvidence: any = null;
      const evidenceId = cycleResult?.systemEvidence?.evidenceId;
      if (evidenceId) {
        systemEvidence = await coordinator.evidenceStore.loadEvidence(evidenceId);
      }

      const found = cycleResult !== null;
      const payload = {
        success: found,
        correlationId,
        projectId: canonical.projectId,
        cycleId: cycleResult?.cycleId ?? targetCycleId,
        actionId: cycleResult?.instructionId ?? cycleResult?.actionId ?? targetActionId,
        taskId: cycleResult?.taskId ?? targetTaskId,
        status: cycleResult?.terminalStatus ?? cycleResult?.status ?? (found ? 'COMPLETED' : 'NOT_FOUND'),
        evidenceId: evidenceId ?? (systemEvidence?.evidenceId as string | undefined),
        verificationDecision: cycleResult?.verificationDecision ?? systemEvidence?.verificationDecision,
        summary: cycleResult?.summary,
        systemEvidence: systemEvidence ? sanitizeMcpPayload(systemEvidence) : undefined,
        cycleResult: cycleResult ? sanitizeMcpPayload(cycleResult) : null,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_RESULT_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

/**
 * Handler for aidm.director.status
 */
export function createDirectorStatusHandler(
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = (rawArgs.projectId as string | undefined) ?? (context.correlation.projectId ?? undefined);

    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}'.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const coordinator = getCoordinator(resolvedRoot, delegate);
    const lock = new DriverLockManager({ workspaceRoot: resolvedRoot });
    const store = new DriverStore({ workspaceRoot: resolvedRoot, historyManager: coordinator.historyManager });

    try {
      const activeSession = await coordinator.sessionStore.getActiveSession();
      const driverState = await store.loadState();
      const isLocked = await lock.isLocked();
      const activeApproval = await coordinator.approvalStore.getActivePackage(canonical.projectId);
      const allTasks = await coordinator.specStore.loadTasks();

      const completedCount = allTasks.filter((t) => t.status === 'ACCEPTED').length;
      const failedCount = allTasks.filter((t) => t.status === 'REJECTED').length;
      const blockedCount = allTasks.filter((t) => t.status === 'BLOCKED').length;
      const pendingCount = allTasks.filter((t) => t.status === 'READY').length;

      // Determine standard status enum
      let status: 'RUNNING' | 'WAITING_HUMAN' | 'PAUSED' | 'FAILED' | 'COMPLETED' | 'IDLE';

      if (
        activeApproval &&
        (activeApproval.status === 'PENDING' ||
          activeApproval.status === 'BLOCKED_ON_HUMAN' ||
          activeApproval.status === 'READY_FOR_APPROVAL')
      ) {
        status = 'WAITING_HUMAN';
      } else if (driverState?.lifecycleState === 'PAUSED' || activeSession?.status === 'SUSPENDED') {
        status = 'PAUSED';
      } else if (driverState?.lifecycleState === 'RUNNING' || isLocked) {
        status = 'RUNNING';
      } else if (driverState?.lifecycleState === 'FAILED' || (failedCount > 0 && pendingCount === 0)) {
        status = 'FAILED';
      } else if (allTasks.length > 0 && completedCount === allTasks.length && activeApproval?.status === 'APPROVED') {
        status = 'COMPLETED';
      } else {
        status = 'IDLE';
      }

      const payload = {
        success: true,
        correlationId,
        projectId: canonical.projectId,
        directorSessionId: activeSession?.directorSessionId ?? (rawArgs.directorSessionId as string | undefined),
        status,
        sessionStatus: activeSession?.status ?? 'NONE',
        driverStatus: driverState?.lifecycleState ?? (isLocked ? 'RUNNING' : 'STOPPED'),
        approvalStatus: {
          packageId: activeApproval?.packageId,
          status: activeApproval?.status ?? 'NONE',
          pendingHumanApproval:
            activeApproval?.status === 'PENDING' ||
            activeApproval?.status === 'BLOCKED_ON_HUMAN' ||
            activeApproval?.status === 'READY_FOR_APPROVAL',
        },
        tasks: {
          total: allTasks.length,
          completed: completedCount,
          pending: pendingCount,
          failed: failedCount,
          blocked: blockedCount,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_STATUS_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

/**
 * Handler for aidm.director.control
 */
export function createDirectorControlHandler(
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = (rawArgs.projectId as string | undefined) ?? (context.correlation.projectId ?? undefined);

    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}'.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const controlAction = rawArgs.action as string | undefined;
    if (controlAction !== 'pause' && controlAction !== 'resume' && controlAction !== 'stop') {
      const payload = {
        success: false,
        error: {
          code: 'ERR_INVALID_CONTROL_ACTION',
          message: `Invalid control action: '${controlAction}'. Must be strictly 'pause', 'resume', or 'stop'.`,
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    // Fine-grained per-action authorization evaluation
    const policyEngine = delegate?.policyEngine;
    if (policyEngine) {
      let actionType: OperationActionType;
      let requestedRiskLevel: RiskLevel;

      if (controlAction === 'resume') {
        actionType = OperationActionType.COMMAND_EXECUTION;
        requestedRiskLevel = RiskLevel.CRITICAL;
      } else if (controlAction === 'pause') {
        actionType = OperationActionType.SOURCE_MUTATION;
        requestedRiskLevel = RiskLevel.CAUTION;
      } else {
        actionType = OperationActionType.SOURCE_MUTATION;
        requestedRiskLevel = RiskLevel.CAUTION;
      }

      const policyDecision = policyEngine.evaluate({
        command: `mcp tools/call aidm.director.control action=${controlAction}`,
        action_type: actionType,
        actionType,
        is_read_only: false,
        isReadOnly: false,
        mutates_source: controlAction === 'resume',
        mutatesSource: controlAction === 'resume',
        requested_risk_level: requestedRiskLevel,
        requestedRiskLevel,
        project_root: resolvedRoot,
        projectRoot: resolvedRoot,
        metadata: {
          toolName: AIDM_DIRECTOR_CONTROL_TOOL_NAME,
          subAction: controlAction,
          correlationId,
          projectId: canonical.projectId,
        },
      });

      if (!policyDecision.allowed) {
        throw new McpPolicyBlockedError(
          `Control sub-action '${controlAction}' blocked by authorization policy: ${policyDecision.reason}`,
          {
            toolName: AIDM_DIRECTOR_CONTROL_TOOL_NAME,
            subAction: controlAction,
            code: policyDecision.code,
            reason: policyDecision.reason,
            violations: policyDecision.violations,
          },
          correlationId
        );
      }
    }

    const coordinator = getCoordinator(resolvedRoot, delegate);
    const runtime = getDriverRuntime(resolvedRoot, delegate, coordinator);

    try {
      await runtime.recover();

      let message: string;
      let summary: any = undefined;

      switch (controlAction) {
        case 'pause': {
          await runtime.pause();
          message = 'Project execution paused successfully.';
          break;
        }

        case 'resume': {
          const activeSess = await coordinator.sessionStore.getActiveSession();
          const targetSessionId =
            (rawArgs.directorSessionId as string | undefined) ??
            activeSess?.directorSessionId ??
            runtime.currentState?.directorSessionId ??
            undefined;

          summary = await runtime.resume({
            workspaceRoot: resolvedRoot,
            projectId: canonical.projectId,
            directorSessionId: targetSessionId,
            targetTaskId: rawArgs.targetTaskId as string | undefined,
            maxIterations: typeof rawArgs.maxIterations === 'number' ? rawArgs.maxIterations : undefined,
            timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
          });
          message = 'Project execution resumed successfully.';
          break;
        }

        case 'stop': {
          const reason = typeof rawArgs.reason === 'string' ? rawArgs.reason : 'Stopped via aidm.director.control';
          await runtime.stop(reason);
          message = 'Project execution stopped gracefully.';
          break;
        }
      }

      const payload = {
        success: true,
        correlationId,
        projectId: canonical.projectId,
        action: controlAction,
        currentState: runtime.currentLifecycleState,
        driverState: runtime.currentState ? sanitizeMcpPayload(runtime.currentState as unknown as Record<string, unknown>) : null,
        message,
        summary: summary ? sanitizeMcpPayload(summary) : undefined,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.name ?? 'ERR_DIRECTOR_CONTROL_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// 4. SERVER REGISTRATION
// ============================================================================

/**
 * Registers all 6 high-level Director MCP Control Plane tools on the McpServer.
 */
export function registerDirectorControlPlaneTools(server: McpServer): void {
  server.registerTool(
    directorOpenToolDefinition,
    createDirectorOpenHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorContextToolDefinition,
    createDirectorContextHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorActToolDefinition,
    createDirectorActHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorResultToolDefinition,
    createDirectorResultHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorStatusToolDefinition,
    createDirectorStatusHandler(undefined, server.delegate)
  );
  server.registerTool(
    directorControlToolDefinition,
    createDirectorControlHandler(undefined, server.delegate)
  );
}
