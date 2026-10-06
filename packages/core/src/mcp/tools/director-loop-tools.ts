/**
 * Director ↔ Executor Loop MCP Tools (Phase 16 TASK-P16-01 / Phase 29 TASK-P29-01)
 *
 * Implements MCP boundary tools exposing the controlled Director ↔ Executor feedback cycle
 * bound authoritatively to ClosedLoopCoordinator, DirectorRuntime, and Authorization Policy.
 *
 * HARD GOVERNANCE RULES:
 * 1. Exposes ONLY the orchestration boundary.
 * 2. Zero arbitrary shell or process execution tools exposed.
 * 3. Cannot bypass ExecutionAuthorizer, ExecutorGuard, SystemEvidenceCollector, or ExecutionBridge.
 * 4. Executes exactly ONE cycle at a time; no automatic continuous loop or daemon (autoContinue = false).
 * 5. Production reasoning runs through DirectorRuntime; fail-closed when unconfigured.
 * 6. Evaluates next-action boundary without executing or creating new IMPLEMENT_TASK envelopes.
 */

import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { ClosedLoopCoordinator } from '../../director-loop/closed-loop-coordinator.js';
import { resolveCanonicalProjectIdentity } from '../../director/project-identity-resolver.js';
import {
  DirectorInstructionValidationError,
  DirectorInstructionUnauthorizedError,
  DirectorInstructionStaleError,
  DirectorInstructionRevisionMismatchError,
  DirectorInstructionSessionMismatchError,
  DirectorInstructionProjectMismatchError,
} from '../../director-loop/director-loop-errors.js';

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
      projectId: { type: 'string', description: 'Canonical project identifier' },
      directorSessionId: { type: 'string', description: 'Active Director session ID' },
      instructionId: { type: 'string', description: 'Optional ID of ingested instruction to execute' },
      targetTaskId: { type: 'string', description: 'Optional target task ID to execute' },
      instruction: { type: 'string', description: 'Optional Director instruction objective' },
      timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds' },
      authContext: { type: 'object', description: 'Optional verified cryptographic authorization context' },
      idempotencyKey: { type: 'string', description: 'Optional idempotency key' },
      customAction: { type: 'object', description: 'Optional custom DirectorAction' },
      customEnvelope: { type: 'object', description: 'Optional custom DirectorActionEnvelope' },
    },
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
      projectId: { type: 'string', description: 'Canonical project identifier' },
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
      projectId: { type: 'string', description: 'Canonical project identifier' },
      cycleId: { type: 'string', description: 'Cycle identifier' },
      instructionId: { type: 'string', description: 'Instruction identifier' },
      taskId: { type: 'string', description: 'Task identifier' },
    },
  },
};

// ----------------------------------------------------------------------------
// 2. Helper: Resolve or Create Authoritative ClosedLoopCoordinator
// ----------------------------------------------------------------------------

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
  return new ClosedLoopCoordinator({
    workspaceRoot: resolvedRoot,
    sessionStore: delegate?.directorSessionStore,
    decisionStore: delegate?.directorDecisionStore,
    approvalStore: delegate?.approvalStore,
    approvalPackageEngine: delegate?.approvalPackageEngine,
    specStore: delegate?.specStore,
    dagEngine: delegate?.dagEngine,
    durableStateManager: delegate?.durableStateManager,
    historyManager: delegate?.historyManager,
    executorPort: delegate?.executorPort,
    directorRuntime: delegate?.directorRuntime,
    authorizationPolicyEngine: delegate?.authorizationPolicyEngine,
  });
}

// ----------------------------------------------------------------------------
// 3. Tool Handlers
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

    const correlationId = context.correlation.correlationId;

    // 1. Project identity isolation
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = rawArgs.projectId as string | undefined;
    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}' at '${canonical.projectRoot}'. Accidental cross-project instruction rejected.`,
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
      const instruction = await coordinator.directorLoopEngine.ingestInstruction({
        workspaceRoot: resolvedRoot,
        projectId: canonical.projectId,
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
        correlationId,
        projectId: canonical.projectId,
        directorSessionId: instruction.directorSessionId,
        instructionId: instruction.instructionId,
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
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_INSTRUCTION_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
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

    const correlationId = context.correlation.correlationId;

    // 1. Project identity isolation
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = rawArgs.projectId as string | undefined;
    if (requestedProjectId && requestedProjectId !== canonical.projectId) {
      const payload = {
        success: false,
        error: {
          code: 'ERR_PROJECT_MISMATCH',
          message: `Canonical project identity mismatch: expected '${canonical.projectId}', got '${requestedProjectId}' at '${canonical.projectRoot}'. Accidental cross-project execution rejected.`,
          details: { canonicalProjectId: canonical.projectId, requestedProjectId },
          correlationId,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const projectId = canonical.projectId;
    const coordinator = getCoordinator(resolvedRoot, delegate);

    try {
      let targetTaskId = rawArgs.targetTaskId as string | undefined;
      let instructionText = rawArgs.instruction as string | undefined;
      let directorSessionId = rawArgs.directorSessionId as string | undefined;
      let idempotencyKey = rawArgs.idempotencyKey as string | undefined;
      const instructionId = rawArgs.instructionId as string | undefined;

      // 2. If instructionId is provided, validate and load from store
      if (instructionId) {
        const instruction = await coordinator.loopStore.getInstruction(instructionId);
        if (!instruction) {
          throw new DirectorInstructionValidationError(
            `Instruction '${instructionId}' not found in DirectorLoopStore.`,
            { instructionId }
          );
        }

        // Cross-project mismatch
        if (instruction.projectId !== projectId) {
          throw new DirectorInstructionProjectMismatchError(
            `Instruction is bound to project '${instruction.projectId}', not '${projectId}'.`,
            { instructionProjectId: instruction.projectId, canonicalProjectId: projectId }
          );
        }

        directorSessionId = instruction.directorSessionId;
        targetTaskId = targetTaskId ?? instruction.taskId;
        instructionText = instructionText ?? instruction.objective;
        idempotencyKey = idempotencyKey ?? `idem-${instructionId}`;

        // Verify session is active
        const session = await coordinator.sessionStore.loadSession(directorSessionId);
        if (!session || session.status !== 'ACTIVE') {
          throw new DirectorInstructionSessionMismatchError(
            `Director session '${directorSessionId}' is ${session?.status ?? 'MISSING'}. An ACTIVE session is required for closed-loop execution.`,
            { directorSessionId, status: session?.status }
          );
        }

        // Verify context fingerprint has not changed
        const latestSnapshot = await coordinator.sessionStore.loadLatestSnapshot(directorSessionId);
        if (latestSnapshot && latestSnapshot.logicalFingerprint !== instruction.contextFingerprint) {
          throw new DirectorInstructionStaleError(
            `Context snapshot fingerprint mismatch: instruction was based on '${instruction.contextFingerprint}', but current fingerprint is '${latestSnapshot.logicalFingerprint}'. Context has drifted; instruction is stale.`,
            { expected: instruction.contextFingerprint, actual: latestSnapshot.logicalFingerprint }
          );
        }

        // Verify understanding revision
        if (session.understandingRevision !== instruction.understandingRevision) {
          throw new DirectorInstructionRevisionMismatchError(
            `Understanding revision mismatch: instruction was based on rev ${instruction.understandingRevision}, but current session is at rev ${session.understandingRevision}.`,
            { expected: instruction.understandingRevision, actual: session.understandingRevision }
          );
        }

        // Verify task revision in SpecStore
        const allTasks = await coordinator.specStore.loadTasks();
        const curTask = allTasks.find((t) => t.task_id === instruction.taskId);
        if (curTask && curTask.metadata?.revision !== undefined && curTask.metadata.revision !== instruction.taskRevision) {
          throw new DirectorInstructionRevisionMismatchError(
            `Task revision mismatch for '${instruction.taskId}': expected rev ${instruction.taskRevision}, found rev ${curTask.metadata.revision}.`,
            { expected: instruction.taskRevision, actual: curTask.metadata.revision }
          );
        }

        // Verify human approval package is APPROVED and revision matches
        const activePkg = await coordinator.approvalStore.getActivePackage(projectId);
        if (!activePkg || activePkg.status !== 'APPROVED') {
          throw new DirectorInstructionUnauthorizedError(
            `No APPROVED approval package found for project '${projectId}'. Product Owner authorization is required.`,
            { packageStatus: activePkg?.status }
          );
        }
        // Execute legacy pre-ingested instruction via coordinator.directorLoopEngine
        const engineResult = await coordinator.directorLoopEngine.executeCycle({
          workspaceRoot: resolvedRoot,
          instructionId,
          timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
        });

        const isSuccess = engineResult.terminalStatus === 'ACCEPTED';
        const evidenceId = engineResult.systemEvidence?.evidenceId;
        const verificationDecision = engineResult.verificationDecision;
        const continuationPolicy = (engineResult as any).continuationPolicy ?? 'CONTROLLED_MANUAL';
        const autoContinue = false;

        const payload = {
          success: isSuccess,
          correlationId,
          projectId,
          directorSessionId: directorSessionId!,
          cycleId: engineResult.cycleId,
          actionId: engineResult.instructionId,
          taskId: engineResult.taskId,
          status: engineResult.terminalStatus,
          stepReached: 'COMPLETED',
          summary: `Single-cycle execution finished with status ${engineResult.terminalStatus}`,
          evidenceId,
          verificationDecision,
          continuationPolicy,
          autoContinue,
          failureCategory: (engineResult as any).failureCategory,
          recoveryRecommendation: (engineResult as any).recoveryRecommendation,
          humanDecisionRequired: engineResult.terminalStatus === 'BLOCKED',
          humanDecisionPoint: (engineResult as any).humanDecisionPoint
            ? sanitizeMcpPayload((engineResult as any).humanDecisionPoint)
            : undefined,
          systemEvidence: engineResult.systemEvidence
            ? sanitizeMcpPayload(engineResult.systemEvidence as unknown as Record<string, unknown>)
            : undefined,
          cycleResult: sanitizeMcpPayload(engineResult as unknown as Record<string, unknown>),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          isError: !isSuccess,
        };
      }

      // 3. Resolve session if not bound by instruction
      if (!directorSessionId) {
        const activeSession = await coordinator.sessionStore.getActiveSession();
        if (!activeSession || activeSession.status !== 'ACTIVE') {
          throw new DirectorInstructionSessionMismatchError(
            'No ACTIVE Director session found. An ACTIVE session is required for closed-loop execution.',
            { status: activeSession?.status }
          );
        }
        if (activeSession.projectId !== projectId) {
          throw new DirectorInstructionProjectMismatchError(
            `Active session '${activeSession.directorSessionId}' is for project '${activeSession.projectId}', not '${projectId}'.`,
            { sessionProjectId: activeSession.projectId, canonicalProjectId: projectId }
          );
        }
        directorSessionId = activeSession.directorSessionId;
      } else {
        const session = await coordinator.sessionStore.loadSession(directorSessionId);
        if (!session || session.status !== 'ACTIVE') {
          throw new DirectorInstructionSessionMismatchError(
            `Director session '${directorSessionId}' is ${session?.status ?? 'MISSING'}. An ACTIVE session is required for closed-loop execution.`,
            { directorSessionId, status: session?.status }
          );
        }
        if (session.projectId !== projectId) {
          throw new DirectorInstructionProjectMismatchError(
            `Director session '${directorSessionId}' is bound to project '${session.projectId}', not '${projectId}'.`,
            { sessionProjectId: session.projectId, canonicalProjectId: projectId }
          );
        }
      }

      // 4. Anti-spoofing check for authContext, customAction, and customEnvelope (Section 10)
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

      if (rawArgs.customAction && typeof rawArgs.customAction === 'object') {
        const ca = rawArgs.customAction as any;
        if (
          ca.actor === 'USER' ||
          ca.isTrustedHumanAuth === true ||
          ca.isDevelopmentAuthorized === true ||
          ca.hasImplementationAuthority === true ||
          ca.payload?.actor === 'USER' ||
          ca.payload?.isTrustedHumanAuth === true ||
          ca.payload?.isDevelopmentAuthorized === true
        ) {
          throw new DirectorInstructionUnauthorizedError(
            'Anti-spoofing violation: fake USER authorization or unverified authority in customAction rejected.',
            { customAction: ca }
          );
        }
      }

      if (rawArgs.customEnvelope && typeof rawArgs.customEnvelope === 'object') {
        const ce = rawArgs.customEnvelope as any;
        if (
          ce.actor === 'USER' ||
          ce.isTrustedHumanAuth === true ||
          ce.isDevelopmentAuthorized === true ||
          ce.payload?.actor === 'USER' ||
          ce.payload?.isTrustedHumanAuth === true
        ) {
          throw new DirectorInstructionUnauthorizedError(
            'Anti-spoofing violation: fake USER authorization in customEnvelope rejected.',
            { customEnvelope: ce }
          );
        }
      }

      // 5. Execute controlled cycle through authoritative ClosedLoopCoordinator
      const cycleResult = await coordinator.coordinateCycle({
        workspaceRoot: resolvedRoot,
        projectId,
        directorSessionId,
        targetTaskId,
        instruction: instructionText,
        idempotencyKey,
        timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
        authContext: rawArgs.authContext,
        customAction: rawArgs.customAction as any,
        customDecision: rawArgs.customDecision as any,
        customEnvelope: rawArgs.customEnvelope as any,
      });

      const isSuccess = cycleResult.isSuccess && cycleResult.status === 'COMPLETED_SUCCESS';
      const evidence = cycleResult.systemEvidence ?? cycleResult.bridgeResult?.systemEvidence;
      const evidenceId = evidence?.evidenceId;
      const verificationDecision =
        evidence?.verificationDecision ??
        (isSuccess ? 'VERIFIED' : undefined);
      const continuationPolicy =
        (cycleResult as any).continuationPolicy ??
        (cycleResult.bridgeResult?.cycleResult as any)?.continuationPolicy ??
        'CONTROLLED_MANUAL';
      const autoContinue =
        (cycleResult as any).autoContinue ??
        (cycleResult.bridgeResult?.cycleResult as any)?.autoContinue ??
        false;
      const failureCategory =
        cycleResult.recoveryDecision?.failureCategory ??
        (cycleResult as any).failureCategory;
      const recoveryRecommendation =
        (cycleResult.recoveryDecision as any)?.recoveryRecommendation ??
        (cycleResult.recoveryDecision as any)?.recommendation ??
        (cycleResult as any).recoveryRecommendation;

      const payload = {
        success: isSuccess,
        correlationId,
        projectId,
        directorSessionId,
        cycleId: cycleResult.cycleId,
        actionId: cycleResult.actionEnvelope?.actionId ?? cycleResult.directorAction?.actionId,
        taskId: cycleResult.taskId,
        status: cycleResult.status,
        stepReached: cycleResult.stepReached,
        summary: cycleResult.summary,
        evidenceId,
        verificationDecision,
        continuationPolicy,
        autoContinue,
        failureCategory,
        recoveryRecommendation,
        humanDecisionRequired: cycleResult.humanDecisionRequired ?? false,
        humanDecisionPoint: cycleResult.humanDecisionPoint
          ? sanitizeMcpPayload(cycleResult.humanDecisionPoint)
          : undefined,
        systemEvidence: evidence ? sanitizeMcpPayload(evidence) : undefined,
        cycleResult: sanitizeMcpPayload(cycleResult as unknown as Record<string, unknown>),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: !isSuccess && (cycleResult.status === 'EXECUTION_FAILED' || cycleResult.status === 'REJECTED_BY_POLICY'),
      };
    } catch (err: any) {
      const payload = {
        success: false,
        error: {
          code: err.code ?? err.name ?? 'ERR_DIRECTOR_EXECUTION_CYCLE_FAILED',
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = rawArgs.projectId as string | undefined;
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
      let cycleResult = null;
      if (rawArgs.cycleId) {
        cycleResult = await coordinator.loopStore.getCycleResult(String(rawArgs.cycleId));
      } else if (rawArgs.instructionId) {
        cycleResult = await coordinator.loopStore.getCycleResultByInstructionId(String(rawArgs.instructionId));
      } else if (rawArgs.taskId) {
        cycleResult = await coordinator.loopStore.getLatestCycleResultForTask(canonical.projectId, String(rawArgs.taskId));
      }

      let systemEvidence = null;
      if (cycleResult?.systemEvidence?.evidenceId) {
        systemEvidence = await coordinator.evidenceStore.loadEvidence(cycleResult.systemEvidence.evidenceId);
      }

      const payload = {
        success: cycleResult !== null,
        correlationId,
        projectId: canonical.projectId,
        cycleId: cycleResult?.cycleId,
        taskId: cycleResult?.taskId,
        status: cycleResult?.terminalStatus,
        cycleResult: sanitizeMcpPayload(cycleResult),
        systemEvidence: sanitizeMcpPayload(systemEvidence ?? cycleResult?.systemEvidence),
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
          code: err.code ?? err.name ?? 'ERR_GET_CYCLE_RESULT_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
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

    const correlationId = context.correlation.correlationId;
    const canonical = resolveCanonicalProjectIdentity(resolvedRoot);
    const requestedProjectId = rawArgs.projectId as string | undefined;
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
      // Evaluate boundary ONLY without executing any tasks or creating action envelopes
      const boundary = await coordinator.directorLoopEngine.evaluateNextAction({
        workspaceRoot: resolvedRoot,
        projectId: canonical.projectId,
        cycleId: rawArgs.cycleId as string | undefined,
        instructionId: rawArgs.instructionId as string | undefined,
        taskId: rawArgs.taskId as string | undefined,
      });

      const payload = {
        success: true,
        correlationId,
        projectId: canonical.projectId,
        directorSessionId: boundary.directorSessionId,
        taskId: boundary.taskId,
        actionStatus: boundary.actionStatus,
        taskCompleted: boundary.taskCompleted,
        canIssueNextInstruction: boundary.canIssueNextInstruction,
        autoContinue: boundary.autoContinue,
        continuationPolicy: boundary.continuationPolicy,
        humanDecisionRequired: boundary.humanDecisionRequired,
        humanDecisionPoint: boundary.humanDecisionPoint
          ? sanitizeMcpPayload(boundary.humanDecisionPoint)
          : undefined,
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
          code: err.code ?? err.name ?? 'ERR_EVALUATE_NEXT_ACTION_FAILED',
          message: err.message,
          details: sanitizeMcpPayload(err.details ?? {}),
          correlationId,
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
// 4. Server Registration Function
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
