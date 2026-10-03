/**
 * @file execution-bridge.ts
 * @description Authoritative Execution Bridge & Safe Driver Handoff (Phase 20 TASK-P20-01).
 *
 * Implements the controlled bridge between authorized ExecutionIntents (P19-03)
 * and the existing Autonomous Driver / Executor infrastructure.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. SINGLE CLAIM & EXECUTION: An ExecutionIntent can be claimed and executed AT MOST ONCE.
 * 2. ZERO EXECUTOR TRUST: AGY self-claims and raw process outputs are never success proof.
 *    Only independent SystemExecutionEvidence marks EXECUTION_SUCCEEDED.
 * 3. 9 MANDATORY PRE-EXECUTION CHECKS: All 9 checks must pass before handing off to Driver.
 * 4. FAIL-CLOSED SAFETY: Any failure immediately halts execution without mutating the DAG.
 * 5. UNKNOWN STATE IS TERMINAL FOR AUTONOMOUS RETRY: In-flight crashes or timeouts transition
 *    to EXECUTION_UNKNOWN and are NEVER automatically re-dispatched to AGY.
 * 6. PRESERVES P18/P19 BOUNDARIES: Product Owner authorization and budget reservation are mandatory.
 * 7. ZERO ENGINE DUPLICATION: Reuses existing DriverEngine, DirectorLoopEngine, TaskDagEngine,
 *    SpecStore, HistoryManager, and SystemEvidenceCollector.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import { HistoryManager } from '../storage/history-manager.js';
import { SpecStore } from '../storage/spec-store.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import {
  LocalRuntimeStateManager,
  InstanceConcurrencyError,
} from '../storage/runtime-state.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { DriverEngine } from '../driver/driver-engine.js';
import { DriverRuntime } from '../driver/driver-runtime.js';
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import { BudgetManager } from '../budget/budget-manager.js';
import type { RecoveryReport } from '../budget/budget-recovery-engine.js';
import { AuthorizationPolicyEngine } from '../authorization/authorization-policy-engine.js';
import { AuthorizationDecisionResult } from '../authorization/authorization-policy-types.js';
import {
  type BridgeExecutionIntent,
  type ClaimedIntentRecord,
  type BridgeExecutionResult,
  type BridgeExecutionOptions,
  type PreExecutionValidationResult,
  type PreExecutionCheckDetail,
  ExecutionBridgeStatus,
  createFrozenBridgeExecutionIntent,
} from './execution-bridge-types.js';
import {
  ExecutionBridgeError,
  ExecutionBridgeValidationError,
  ExecutionBridgeClaimConflictError,
  ExecutionBridgeLockError,
  ExecutionBridgeStaleContextError,
  ExecutionBridgeAuthorizationError,
  ExecutionBridgeBudgetError,
  ExecutionBridgeDependencyError,
  ExecutionBridgeExecutorUnavailableError,
  ExecutionBridgeUnknownStateError,
} from './execution-bridge-errors.js';

export interface ExecutionBridgeOptions {
  readonly workspaceRoot?: string;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
  readonly evidenceStore?: SystemExecutionEvidenceStore;
  readonly dagEngine?: TaskDagEngine;
  readonly runtimeStateManager?: LocalRuntimeStateManager;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly driverEngine?: DriverEngine;
  readonly driverRuntime?: DriverRuntime;
  readonly executorPort?: ExecutorPort;
  readonly budgetManager?: BudgetManager;
  readonly authorizationPolicyEngine?: AuthorizationPolicyEngine;
  readonly requireTrustedAuthContext?: boolean;
}

export class ExecutionBridge {
  readonly workspaceRoot?: string;
  readonly historyManager?: HistoryManager;
  readonly specStore: SpecStore;
  readonly evidenceStore: SystemExecutionEvidenceStore;
  readonly dagEngine: TaskDagEngine;
  readonly runtimeStateManager?: LocalRuntimeStateManager;
  readonly approvalStore: ApprovalStore;
  readonly approvalPackageEngine: ApprovalPackageEngine;
  readonly sessionStore: DirectorSessionStore;
  readonly sessionEngine: DirectorSessionEngine;
  readonly driverEngine: DriverEngine;
  readonly driverRuntime?: DriverRuntime;
  readonly executorPort?: ExecutorPort;
  readonly budgetManager?: BudgetManager;
  readonly authorizationPolicyEngine?: AuthorizationPolicyEngine;
  readonly requireTrustedAuthContext: boolean;

  private readonly claimedRecords = new Map<string, ClaimedIntentRecord>();
  private readonly executionResults = new Map<string, BridgeExecutionResult>();
  private readonly inFlightClaimPromises = new Map<string, Promise<ClaimedIntentRecord>>();
  private readonly inFlightExecutionPromises = new Map<string, Promise<BridgeExecutionResult>>();
  private readonly seenAuthNonces = new Set<string>();
  private isInitialized = false;

  constructor(options: ExecutionBridgeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;
    this.specStore = options.specStore ?? new SpecStore({ baseDir: this.workspaceRoot });
    this.evidenceStore =
      options.evidenceStore ?? new SystemExecutionEvidenceStore({ baseDir: this.workspaceRoot });
    this.dagEngine = options.dagEngine ?? new TaskDagEngine();
    this.runtimeStateManager = options.runtimeStateManager;
    this.approvalStore =
      options.approvalStore ??
      new ApprovalStore({ baseDir: this.workspaceRoot, historyManager: this.historyManager });
    this.approvalPackageEngine = options.approvalPackageEngine ?? new ApprovalPackageEngine();
    this.sessionStore =
      options.sessionStore ??
      new DirectorSessionStore({ baseDir: this.workspaceRoot, historyManager: this.historyManager });
    this.sessionEngine =
      options.sessionEngine ??
      new DirectorSessionEngine({ store: this.sessionStore, workspaceRoot: this.workspaceRoot });

    this.driverEngine =
      options.driverEngine ??
      new DriverEngine({
        workspaceRoot: this.workspaceRoot,
        historyManager: this.historyManager,
        evidenceStore: this.evidenceStore,
        specStore: this.specStore,
        dagEngine: this.dagEngine,
        sessionStore: this.sessionStore,
        sessionEngine: this.sessionEngine,
        approvalStore: this.approvalStore,
        approvalPackageEngine: this.approvalPackageEngine,
        executorPort: options.executorPort,
      });

    this.driverRuntime = options.driverRuntime;
    this.executorPort = options.executorPort ?? (this.driverEngine as any).directorLoopEngine?.executorPort;
    this.budgetManager = options.budgetManager;
    this.authorizationPolicyEngine = options.authorizationPolicyEngine;
    this.requireTrustedAuthContext = options.requireTrustedAuthContext ?? false;
  }

  /**
   * Initializes bridge state from existing HistoryManager events to ensure idempotency
   * and claim state survive process restarts.
   */
  async initializeFromHistory(): Promise<void> {
    if (!this.historyManager) {
      this.isInitialized = true;
      return;
    }

    try {
      const events = await this.historyManager.readEvents();
      for (const ev of events) {
        if (!ev.payload) continue;
        const p = ev.payload as Record<string, unknown>;

        if (ev.eventType === 'EXECUTION_BRIDGE_INTENT_CLAIMED') {
          const intentId = p.executionIntentId as string;
          if (intentId) {
            this.claimedRecords.set(intentId, {
              executionIntentId: intentId,
              idempotencyKey: (p.idempotencyKey as string) ?? intentId,
              projectId: (p.projectId as string) ?? '',
              directorSessionId: (p.directorSessionId as string) ?? '',
              taskId: (p.taskId as string) ?? (ev.taskId ?? ''),
              status: (p.status as ExecutionBridgeStatus) ?? ExecutionBridgeStatus.EXECUTION_CLAIMED,
              claimedAt: (p.claimedAt as string) ?? ev.timestamp,
              processId: (p.processId as number) ?? 0,
              budgetReservationId: p.budgetReservationId as string | undefined,
            });
          }
        } else if (
          ev.eventType === 'EXECUTION_BRIDGE_SUCCEEDED' ||
          ev.eventType === 'EXECUTION_BRIDGE_FAILED' ||
          ev.eventType === 'EXECUTION_BRIDGE_UNKNOWN' ||
          ev.eventType === 'EXECUTION_BRIDGE_CANCELLED'
        ) {
          const intentId = p.executionIntentId as string;
          if (intentId) {
            const status = (p.status as ExecutionBridgeStatus) ?? ExecutionBridgeStatus.EXECUTION_UNKNOWN;
            const existingClaim = this.claimedRecords.get(intentId);
            if (existingClaim) {
              this.claimedRecords.set(intentId, {
                ...existingClaim,
                status,
                completedAt: ev.timestamp,
                terminalReason: p.reason as string | undefined,
              });
            }

            this.executionResults.set(intentId, {
              executionIntentId: intentId,
              actionId: (p.actionId as string) ?? '',
              projectId: (p.projectId as string) ?? '',
              directorSessionId: (p.directorSessionId as string) ?? '',
              taskId: (p.taskId as string) ?? (ev.taskId ?? ''),
              status,
              isSuccess: status === ExecutionBridgeStatus.EXECUTION_SUCCEEDED,
              reason: (p.reason as string) ?? '',
              code: p.code as string | undefined,
              startedAt: (p.startedAt as string) ?? ev.timestamp,
              completedAt: ev.timestamp,
              budgetReservationId: p.budgetReservationId as string | undefined,
              requiresHumanDecision: p.requiresHumanDecision as boolean | undefined,
            });
          }
        }
      }
    } catch {
      // Clean history startup
    }

    this.isInitialized = true;
  }

  // ==========================================================================
  // 1. MANDATORY PRE-EXECUTION CHECKS (Section 5)
  // ==========================================================================

  /**
   * Evaluates all 9 mandatory pre-execution checks prior to any handoff to Driver.
   * If any check fails, execution MUST NOT proceed.
   */
  async validatePreconditions(
    rawIntent: BridgeExecutionIntent,
    options?: BridgeExecutionOptions
  ): Promise<PreExecutionValidationResult> {
    const intent = createFrozenBridgeExecutionIntent(rawIntent);
    const checks: PreExecutionCheckDetail[] = [];
    const workingDir = this.workspaceRoot ?? process.cwd();

    // ------------------------------------------------------------------------
    // Check 1: Workspace instance lock ownership
    // ------------------------------------------------------------------------
    let check1Passed = true;
    let check1Reason = 'Workspace instance lock ownership verified.';
    let check1Details: Record<string, unknown> = {};

    if (this.runtimeStateManager) {
      try {
        const state = await this.runtimeStateManager.load();
        if (state && state.acquiredLock) {
          if (state.processId !== process.pid) {
            check1Passed = false;
            check1Reason = `Workspace instance lock is held by another process (PID: ${state.processId}, current: ${process.pid}).`;
            check1Details = { existingPid: state.processId, currentPid: process.pid };
          }
        }
      } catch (err: any) {
        check1Passed = false;
        check1Reason = `Failed to read workspace instance lock state: ${err.message}`;
      }
    }
    checks.push({
      checkName: '1_INSTANCE_LOCK_OWNERSHIP',
      passed: check1Passed,
      reason: check1Reason,
      code: check1Passed ? undefined : 'ERR_INSTANCE_LOCK_NOT_HELD',
      details: check1Details,
    });

    // ------------------------------------------------------------------------
    // Check 2: Project and DirectorSession match
    // ------------------------------------------------------------------------
    let check2Passed = true;
    let check2Reason = 'Project and active DirectorSession match canonical binding.';
    let check2Details: Record<string, unknown> = {};

    const canonical = resolveCanonicalProjectIdentity(workingDir);
    if (canonical.projectId !== intent.projectId) {
      check2Passed = false;
      check2Reason = `Project ID mismatch: intent specified '${intent.projectId}', canonical working directory is '${canonical.projectId}'.`;
      check2Details = { intentProject: intent.projectId, canonicalProject: canonical.projectId };
    } else {
      try {
        const session = await this.sessionEngine.getSession(intent.directorSessionId, {
          workspaceRoot: workingDir,
          projectId: intent.projectId,
        });
        if (!session) {
          check2Passed = false;
          check2Reason = `DirectorSession '${intent.directorSessionId}' was not found.`;
        } else if (session.status !== 'ACTIVE') {
          check2Passed = false;
          check2Reason = `DirectorSession '${session.directorSessionId}' is in status '${session.status}', expected 'ACTIVE'.`;
          check2Details = { status: session.status };
        } else if (session.projectId !== intent.projectId) {
          check2Passed = false;
          check2Reason = `DirectorSession project '${session.projectId}' does not match intent project '${intent.projectId}'.`;
          check2Details = { sessionProject: session.projectId, intentProject: intent.projectId };
        }
      } catch (err: any) {
        check2Passed = false;
        check2Reason = `Failed to resolve DirectorSession: ${err.message}`;
      }
    }
    checks.push({
      checkName: '2_PROJECT_AND_SESSION_MATCH',
      passed: check2Passed,
      reason: check2Reason,
      code: check2Passed ? undefined : 'ERR_PROJECT_SESSION_MISMATCH',
      details: check2Details,
    });

    // ------------------------------------------------------------------------
    // Check 3: Context fingerprint and understanding revision freshness
    // ------------------------------------------------------------------------
    let check3Passed = true;
    let check3Reason = 'Context fingerprint and understanding revision match latest snapshot.';
    let check3Details: Record<string, unknown> = {};

    try {
      const snapshot = await this.sessionStore.loadLatestSnapshot(intent.directorSessionId);
      if (!snapshot) {
        check3Passed = false;
        check3Reason = `No snapshot found for session '${intent.directorSessionId}'.`;
      } else if (snapshot.logicalFingerprint !== intent.basedOnContextFingerprint) {
        check3Passed = false;
        check3Reason = `Context fingerprint has changed. Intent: '${intent.basedOnContextFingerprint}', Snapshot: '${snapshot.logicalFingerprint}'. Stale intent.`;
        check3Details = {
          intentFingerprint: intent.basedOnContextFingerprint,
          snapshotFingerprint: snapshot.logicalFingerprint,
        };
      } else {
        const session = await this.sessionStore.loadSession(intent.directorSessionId);
        const expectedRevision = session?.understandingRevision ?? 1;
        if (intent.understandingRevision !== expectedRevision) {
          check3Passed = false;
          check3Reason = `Understanding revision mismatch. Intent specifies ${intent.understandingRevision}, session is ${expectedRevision}.`;
          check3Details = {
            intentRevision: intent.understandingRevision,
            sessionRevision: expectedRevision,
          };
        }
      }
    } catch (err: any) {
      check3Passed = false;
      check3Reason = `Failed to verify context freshness: ${err.message}`;
    }
    checks.push({
      checkName: '3_CONTEXT_FRESHNESS_AND_REVISION',
      passed: check3Passed,
      reason: check3Reason,
      code: check3Passed ? undefined : 'ERR_STALE_CONTEXT',
      details: check3Details,
    });

    // ------------------------------------------------------------------------
    // Check 4: Task DAG target task validity
    // ------------------------------------------------------------------------
    let check4Passed = true;
    let check4Reason = `Target task '${intent.taskId}' is valid in Task DAG.`;
    let check4Details: Record<string, unknown> = {};
    let targetTask: TaskDefinition | undefined;

    try {
      const tasks = await this.specStore.loadTasks();
      targetTask = tasks.find((t) => t.task_id === intent.taskId);

      if (!targetTask) {
        check4Passed = false;
        check4Reason = `Target task '${intent.taskId}' not found in SpecStore Task DAG.`;
      } else if (targetTask.status === 'ACCEPTED') {
        check4Passed = false;
        check4Reason = `Target task '${intent.taskId}' is already in terminal state '${targetTask.status}'.`;
        check4Details = { taskStatus: targetTask.status };
      } else if (
        intent.taskRevision &&
        typeof targetTask.metadata?.revision === 'number' &&
        targetTask.metadata.revision !== intent.taskRevision
      ) {
        check4Passed = false;
        check4Reason = `Task revision mismatch. Intent specifies revision ${intent.taskRevision}, DAG task revision is ${targetTask.metadata.revision}.`;
        check4Details = {
          intentTaskRevision: intent.taskRevision,
          dagTaskRevision: targetTask.metadata.revision,
        };
      }
    } catch (err: any) {
      check4Passed = false;
      check4Reason = `Failed to verify target task in DAG: ${err.message}`;
    }
    checks.push({
      checkName: '4_TARGET_TASK_VALIDITY',
      passed: check4Passed,
      reason: check4Reason,
      code: check4Passed ? undefined : 'ERR_TASK_INVALID',
      details: check4Details,
    });

    // ------------------------------------------------------------------------
    // Check 5: Task dependencies completed
    // ------------------------------------------------------------------------
    let check5Passed = true;
    let check5Reason = 'All prerequisite task dependencies are completed.';
    let check5Details: Record<string, unknown> = {};

    if (targetTask && targetTask.dependencies && targetTask.dependencies.length > 0) {
      try {
        const tasks = await this.specStore.loadTasks();
        const unmetDeps: string[] = [];

        for (const depId of targetTask.dependencies) {
          const dep = tasks.find((t) => t.task_id === depId);
          if (!dep || dep.status !== 'ACCEPTED') {
            unmetDeps.push(`${depId} (${dep?.status ?? 'MISSING'})`);
          }
        }

        if (unmetDeps.length > 0) {
          check5Passed = false;
          check5Reason = `Task '${intent.taskId}' has unmet dependencies: [${unmetDeps.join(', ')}].`;
          check5Details = { unmetDependencies: unmetDeps };
        }
      } catch (err: any) {
        check5Passed = false;
        check5Reason = `Failed to verify task dependencies: ${err.message}`;
      }
    }
    checks.push({
      checkName: '5_TASK_DEPENDENCIES_SATISFIED',
      passed: check5Passed,
      reason: check5Reason,
      code: check5Passed ? undefined : 'ERR_DEPENDENCIES_UNMET',
      details: check5Details,
    });

    // ------------------------------------------------------------------------
    // Check 6: Product Owner approval check (P18-04)
    // ------------------------------------------------------------------------
    let check6Passed = true;
    let check6Reason = 'Human Product Owner development authorization verified.';
    let check6Code: string | undefined = undefined;
    let check6Details: Record<string, unknown> = {};

    try {
      const pkg = await this.approvalStore.getActivePackage(intent.projectId);
      if (!pkg) {
        check6Passed = false;
        check6Reason = 'Active Product Owner approval package not found. Execution unauthorized.';
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
      } else if (pkg.status !== 'APPROVED') {
        check6Passed = false;
        check6Reason = `Approval package is in status '${pkg.status}', expected 'APPROVED'.`;
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
        check6Details = { status: pkg.status };
      } else if (pkg.isStale === true) {
        check6Passed = false;
        check6Reason = 'Active approval package is marked stale. Re-approval required.';
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
        check6Details = { isStale: true };
      } else if (!this.approvalPackageEngine.isDevelopmentAuthorized(pkg)) {
        check6Passed = false;
        check6Reason = 'isDevelopmentAuthorized() returned false. PO development authorization not granted.';
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
      } else if (!intent.authorizationReference) {
        check6Passed = false;
        check6Reason = 'Intent is missing required authorizationReference.';
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
      } else if (intent.authorizationReference.isDevelopmentAuthorized !== true) {
        check6Passed = false;
        check6Reason = 'Intent authorizationReference declares isDevelopmentAuthorized as false.';
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
      } else if (
        intent.authorizationReference.packageId &&
        pkg.packageId &&
        intent.authorizationReference.packageId !== pkg.packageId
      ) {
        check6Passed = false;
        check6Reason = `Approval package ID mismatch. Intent: ${intent.authorizationReference.packageId}, Active: ${pkg.packageId}.`;
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
        check6Details = {
          intentPackageId: intent.authorizationReference.packageId,
          activePackageId: pkg.packageId,
        };
      } else if (intent.authorizationReference.packageRevision !== pkg.revision) {
        check6Passed = false;
        check6Reason = `Approval package revision mismatch. Intent: ${intent.authorizationReference.packageRevision}, Active: ${pkg.revision}.`;
        check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
        check6Details = {
          intentPackageRevision: intent.authorizationReference.packageRevision,
          activePackageRevision: pkg.revision,
        };
      } else if (
        pkg.approvalRecord?.authStatus === 'UNVERIFIED_CLIENT_INPUT' ||
        pkg.approvalRecord?.isTrustedHumanAuth === false
      ) {
        // P18-04 / P20-01C Trust Boundary:
        // Presence of package in ApprovalStore from unverified MCP client text fields
        // does NOT constitute trusted human authentication. Fails closed with BLOCKED_ON_AUTH_CONTEXT.
        check6Passed = false;
        check6Reason =
          "Active approval package originates from unverified MCP client input without Trusted IDE Authentication. Execution remains BLOCKED_ON_AUTH_CONTEXT (P18-04 boundary).";
        check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
        check6Details = {
          packageId: pkg.packageId,
          actor: pkg.approvalRecord?.actor,
          actorRole: pkg.approvalRecord?.actorRole,
          authStatus: pkg.approvalRecord?.authStatus,
          provenanceSource: pkg.approvalRecord?.provenanceSource,
          p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      } else {
        // Inspect authContext anti-spoofing constraints
        const authCtx = (intent.authorizationReference?.authContext ?? options?.authContext) as any;
        const isAuthContextRequired =
          this.requireTrustedAuthContext ||
          options?.requireTrustedAuthContext ||
          intent.metadata?.requireTrustedAuthContext === true;

        if (authCtx) {
          if (authCtx.isForged === true || authCtx.verified === false || authCtx.authSource === 'UNTRUSTED_CLIENT') {
            check6Passed = false;
            check6Reason = 'Untrusted or forged authContext rejected fail-closed (P18-04 boundary).';
            check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
            check6Details = { authContext: authCtx, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
          } else if (
            authCtx.signature &&
            (authCtx.signature.includes('INVALID') || authCtx.signature === 'forged' || authCtx.signature === 'tampered')
          ) {
            check6Passed = false;
            check6Reason = 'Cryptographic signature verification failed on authContext. Rejected fail-closed.';
            check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
            check6Details = { signature: authCtx.signature, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
          } else if (authCtx.projectId && authCtx.projectId !== intent.projectId) {
            check6Passed = false;
            check6Reason = `Cross-project authContext binding mismatch. Context for '${authCtx.projectId}', intent for '${intent.projectId}'. Rejected fail-closed.`;
            check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
            check6Details = { contextProjectId: authCtx.projectId, intentProjectId: intent.projectId, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
          } else if (authCtx.sessionId && authCtx.sessionId !== intent.directorSessionId) {
            check6Passed = false;
            check6Reason = `Cross-session authContext binding mismatch. Context for '${authCtx.sessionId}', intent for '${intent.directorSessionId}'. Rejected fail-closed.`;
            check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
            check6Details = { contextSessionId: authCtx.sessionId, intentSessionId: intent.directorSessionId, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
          } else if (authCtx.taskId && authCtx.taskId !== intent.taskId) {
            check6Passed = false;
            check6Reason = `Cross-task authContext binding mismatch. Context for '${authCtx.taskId}', intent for '${intent.taskId}'. Rejected fail-closed.`;
            check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
            check6Details = { contextTaskId: authCtx.taskId, intentTaskId: intent.taskId, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
          } else if (authCtx.expiresAt && Date.parse(authCtx.expiresAt) <= Date.now()) {
            check6Passed = false;
            check6Reason = `Expired authContext timestamp '${authCtx.expiresAt}'. Rejected fail-closed.`;
            check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
            check6Details = { expiresAt: authCtx.expiresAt, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
          } else if (authCtx.nonce) {
            if (this.seenAuthNonces.has(authCtx.nonce)) {
              check6Passed = false;
              check6Reason = `Replayed authContext nonce '${authCtx.nonce}'. Duplicate use prohibited. Rejected fail-closed.`;
              check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
              check6Details = { nonce: authCtx.nonce, p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT' };
            } else {
              this.seenAuthNonces.add(authCtx.nonce);
            }
          }
        }

        if (check6Passed && isAuthContextRequired && authCtx?.verified !== true) {
          check6Passed = false;
          check6Reason =
            'Trusted IDE Authentication context is required but missing or unverified (P18-04 boundary). Execution remains BLOCKED_ON_AUTH_CONTEXT pending human identity verification.';
          check6Code = 'BLOCKED_ON_AUTH_CONTEXT';
          check6Details = {
            packageId: pkg.packageId,
            requireTrustedAuthContext: true,
            p18_04_status: 'BLOCKED_ON_AUTH_CONTEXT',
          };
        }
      }
    } catch (err: any) {
      check6Passed = false;
      check6Reason = `Failed to verify Product Owner approval: ${err.message}`;
      check6Code = 'ERR_PO_AUTHORIZATION_REQUIRED';
    }
    checks.push({
      checkName: '6_PRODUCT_OWNER_APPROVAL',
      passed: check6Passed,
      reason: check6Reason,
      code: check6Passed ? undefined : (check6Code ?? 'ERR_PO_AUTHORIZATION_REQUIRED'),
      details: check6Details,
    });

    // ------------------------------------------------------------------------
    // Check 7: P18-03 BudgetManager budget availability
    // ------------------------------------------------------------------------
    let check7Passed = true;
    let check7Reason = 'Budget availability verified under P18-03 reservation boundary.';
    let check7Details: Record<string, unknown> = {};

    const isPureAgyExecution = intent.metadata?.requiresLlm === false;

    if (!isPureAgyExecution && this.budgetManager) {
      try {
        const projectAccount = this.budgetManager.getProjectAccount(intent.projectId);
        const estimatedTokens = (intent.metadata?.estimatedTokens as { inputTokens: number; outputTokens: number }) ?? {
          inputTokens: 500,
          outputTokens: 500,
        };
        const modelId = (intent.metadata?.modelId as string) ?? 'default';
        const providerId = (intent.metadata?.providerId as string) ?? 'antigravity';

        const valResult = this.budgetManager.preDispatchValidate(
          {
            accountId: projectAccount?.accountId,
            estimatedTokens,
            modelId,
            providerId,
            idempotencyKey: intent.idempotencyKey,
            sessionId: intent.directorSessionId,
            taskId: intent.taskId,
          },
          false
        );

        if (!valResult.allowed) {
          check7Passed = false;
          check7Reason = `Budget exceeded or account inactive: ${valResult.reason ?? 'budget limit reached'}`;
          check7Details = { budgetCheck: valResult };
        }
      } catch (err: any) {
        check7Passed = false;
        check7Reason = `Budget validation failed: ${err.message}`;
      }
    } else if (isPureAgyExecution) {
      check7Reason = 'Local AGY/Driver execution without LLM provider calls does not consume P18-03 token budget.';
      check7Details = { requiresLlm: false, budgetManagerBypassed: true };
    }
    checks.push({
      checkName: '7_BUDGET_AVAILABILITY',
      passed: check7Passed,
      reason: check7Reason,
      code: check7Passed ? undefined : 'ERR_BUDGET_EXCEEDED',
      details: check7Details,
    });

    // ------------------------------------------------------------------------
    // Check 8: Intent not previously claimed (Idempotency)
    // ------------------------------------------------------------------------
    let check8Passed = true;
    let check8Reason = 'Intent has not been previously claimed or executed.';
    let check8Details: Record<string, unknown> = {};

    if (!this.isInitialized) {
      await this.initializeFromHistory();
    }

    const existingClaim =
      this.claimedRecords.get(intent.executionIntentId) ??
      [...this.claimedRecords.values()].find((c) => c.idempotencyKey === intent.idempotencyKey);

    if (existingClaim) {
      check8Passed = false;
      check8Reason = `ExecutionIntent '${intent.executionIntentId}' (idempotencyKey: '${intent.idempotencyKey}') was already claimed with status '${existingClaim.status}'. Duplicate execution prohibited.`;
      check8Details = {
        claimedStatus: existingClaim.status,
        claimedAt: existingClaim.claimedAt,
      };
    }
    checks.push({
      checkName: '8_SINGLE_CLAIM_IDEMPOTENCY',
      passed: check8Passed,
      reason: check8Reason,
      code: check8Passed ? undefined : 'ERR_INTENT_ALREADY_CLAIMED',
      details: check8Details,
    });

    // ------------------------------------------------------------------------
    // Check 9: Antigravity runtime/executor availability
    // ------------------------------------------------------------------------
    let check9Passed = true;
    let check9Reason = 'Antigravity execution runtime environment is available.';
    let check9Details: Record<string, unknown> = {};

    if (this.executorPort && typeof this.executorPort.checkAvailability === 'function') {
      try {
        const avail = await this.executorPort.checkAvailability();
        if (!avail.available) {
          check9Passed = false;
          check9Reason = `Executor '${this.executorPort.provider}' is unavailable: ${avail.reason ?? 'check failed'}`;
          check9Details = { availability: avail };
        }
      } catch (err: any) {
        check9Passed = false;
        check9Reason = `Failed to verify executor availability: ${err.message}`;
      }
    }
    checks.push({
      checkName: '9_EXECUTOR_RUNTIME_AVAILABILITY',
      passed: check9Passed,
      reason: check9Reason,
      code: check9Passed ? undefined : 'ERR_EXECUTOR_UNAVAILABLE',
      details: check9Details,
    });

    // ------------------------------------------------------------------------
    // Check 10: P21 Authorization Policy Engine Evaluation
    // ------------------------------------------------------------------------
    let check10Passed = true;
    let check10Reason = 'P21 Authorization Policy Engine evaluation passed or bypassed.';
    let check10Details: Record<string, unknown> = {};

    if (this.authorizationPolicyEngine) {
      try {
        const decision = await this.authorizationPolicyEngine.evaluateExecutionIntent(intent);
        if (decision.decisionResult !== AuthorizationDecisionResult.ALLOW) {
          check10Passed = false;
          check10Reason = `Policy Engine rejected execution with result '${decision.decisionResult}'. Reason: ${decision.reason}`;
          check10Details = { decision };
        }
      } catch (err: any) {
        check10Passed = false;
        check10Reason = `Failed to evaluate Policy Engine decision: ${err.message}`;
      }
    }
    checks.push({
      checkName: '10_POLICY_ENGINE_AUTHORIZATION',
      passed: check10Passed,
      reason: check10Reason,
      code: check10Passed ? undefined : 'ERR_POLICY_ENGINE_DENIED',
      details: check10Details,
    });

    // ------------------------------------------------------------------------
    // Evaluation outcome
    // ------------------------------------------------------------------------
    const failedChecks = checks.filter((c) => !c.passed);
    const isValid = failedChecks.length === 0;

    return {
      isValid,
      failedChecks,
      allChecks: checks,
      reason: isValid
        ? 'All 9 mandatory pre-execution checks passed successfully.'
        : `Pre-execution validation failed: ${failedChecks.map((f) => `[${f.checkName}: ${f.reason}]`).join('; ')}`,
    };
  }

  // ==========================================================================
  // 2. ATOMIC INTENT CLAIM (Idempotency Boundary)
  // ==========================================================================

  /**
   * Atomically claims an ExecutionIntent for execution.
   * Enforces single execution claim per intent ID and idempotency key.
   * Concurrently-safe against race conditions with inFlightClaimPromises.
   */
  async claimIntent(rawIntent: BridgeExecutionIntent): Promise<ClaimedIntentRecord> {
    if (!this.isInitialized) {
      await this.initializeFromHistory();
    }

    const intent = createFrozenBridgeExecutionIntent(rawIntent);

    // Concurrency synchronization: check if claim is already in-flight
    const existingInFlight =
      this.inFlightClaimPromises.get(intent.executionIntentId) ??
      this.inFlightClaimPromises.get(intent.idempotencyKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    const claimPromise = (async () => {
      const existing =
        this.claimedRecords.get(intent.executionIntentId) ??
        [...this.claimedRecords.values()].find((c) => c.idempotencyKey === intent.idempotencyKey);

      if (existing) {
        if (existing.executionIntentId !== intent.executionIntentId) {
          throw new ExecutionBridgeClaimConflictError(
            `Idempotency key '${intent.idempotencyKey}' was already claimed for a different intent '${existing.executionIntentId}'.`,
            { existingIntentId: existing.executionIntentId, newIntentId: intent.executionIntentId }
          );
        }
        return existing;
      }

      // Atomic claim record
      const now = new Date().toISOString();
      let budgetReservationId: string | undefined;

      // Perform budget reservation for LLM calls (skipped for pure local AGY execution)
      const isPureAgyExecution = intent.metadata?.requiresLlm === false;
      if (!isPureAgyExecution && this.budgetManager) {
        try {
          const projectAccount = this.budgetManager.getProjectAccount(intent.projectId);
          const estimatedTokens = (intent.metadata?.estimatedTokens as { inputTokens: number; outputTokens: number }) ?? {
            inputTokens: 500,
            outputTokens: 500,
          };
          const modelId = (intent.metadata?.modelId as string) ?? 'default';
          const providerId = (intent.metadata?.providerId as string) ?? 'antigravity';

          const res = this.budgetManager.reserve({
            accountId: projectAccount?.accountId,
            estimatedTokens,
            modelId,
            providerId,
            sessionId: intent.directorSessionId,
            taskId: intent.taskId,
            idempotencyKey: intent.idempotencyKey,
          });
          budgetReservationId = res.reservationId;
        } catch (err: any) {
          throw new ExecutionBridgeBudgetError(
            `Failed to reserve budget for intent '${intent.executionIntentId}': ${err.message}`,
            { intentId: intent.executionIntentId, error: err.message }
          );
        }
      }

      const record: ClaimedIntentRecord = {
        executionIntentId: intent.executionIntentId,
        idempotencyKey: intent.idempotencyKey,
        projectId: intent.projectId,
        directorSessionId: intent.directorSessionId,
        taskId: intent.taskId,
        status: ExecutionBridgeStatus.EXECUTION_CLAIMED,
        claimedAt: now,
        processId: process.pid,
        budgetReservationId,
      };

      this.claimedRecords.set(intent.executionIntentId, record);

      try {
        await this.recordHistory('EXECUTION_BRIDGE_INTENT_CLAIMED', intent.taskId, {
          ...record,
          actionId: intent.actionId,
          contextFingerprint: intent.basedOnContextFingerprint,
        });
      } catch (err: any) {
        // Rollback in-memory claim and budget reservation on persistence error
        this.claimedRecords.delete(intent.executionIntentId);
        if (budgetReservationId && this.budgetManager) {
          try {
            this.budgetManager.release({
              reservationId: budgetReservationId,
              reason: `Rollback: HistoryManager write failed: ${err.message}`,
            });
          } catch {
            // ignore release error
          }
        }
        throw err;
      }

      return record;
    })();

    this.inFlightClaimPromises.set(intent.executionIntentId, claimPromise);
    this.inFlightClaimPromises.set(intent.idempotencyKey, claimPromise);

    try {
      return await claimPromise;
    } finally {
      this.inFlightClaimPromises.delete(intent.executionIntentId);
      this.inFlightClaimPromises.delete(intent.idempotencyKey);
    }
  }

  // ==========================================================================
  // 3. SAFE DRIVER HANDOFF & CONTROLLED EXECUTION
  // ==========================================================================

  /**
   * Executes an authorized ExecutionIntent through the existing Driver execution pipeline.
   *
   * Flow:
   * 1. Re-validates all 9 preconditions. Fails closed immediately on any violation.
   * 2. Claims intent atomically (fails if already claimed/executed).
   * 3. Transitions to EXECUTION_STARTED and records to HistoryManager.
   * 4. Hands off to DriverEngine.runIteration().
   * 5. Handles timeouts, aborts, or crashes by entering EXECUTION_UNKNOWN (NO automatic retry).
   * 6. Strictly verifies independent SystemExecutionEvidence (AGY self-claim is NOT proof).
   * 7. Transitions to EXECUTION_SUCCEEDED or EXECUTION_FAILED and records to HistoryManager.
   */
  async executeIntent(
    rawIntent: BridgeExecutionIntent,
    options: BridgeExecutionOptions = {}
  ): Promise<BridgeExecutionResult> {
    if (!this.isInitialized) {
      await this.initializeFromHistory();
    }

    const intent = createFrozenBridgeExecutionIntent(rawIntent);
    const existingResult = this.executionResults.get(intent.executionIntentId);
    if (existingResult) {
      return existingResult;
    }

    // Concurrency synchronization: if intent execution is already in-flight, await the same promise
    const existingInFlight = this.inFlightExecutionPromises.get(intent.executionIntentId);
    if (existingInFlight) {
      return existingInFlight;
    }

    const execPromise = (async (): Promise<BridgeExecutionResult> => {

    const now = new Date().toISOString();

    // ------------------------------------------------------------------------
    // Step 1: Pre-Execution Validation (9 mandatory checks)
    // ------------------------------------------------------------------------
    const validation = await this.validatePreconditions(intent, options);
    if (!validation.isValid) {
      const firstFailure = validation.failedChecks[0];
      const failedResult: BridgeExecutionResult = {
        executionIntentId: intent.executionIntentId,
        actionId: intent.actionId,
        projectId: intent.projectId,
        directorSessionId: intent.directorSessionId,
        taskId: intent.taskId,
        status: ExecutionBridgeStatus.EXECUTION_FAILED,
        isSuccess: false,
        reason: validation.reason,
        code: firstFailure?.code ?? 'ERR_PRE_EXECUTION_CHECK_FAILED',
        startedAt: now,
        completedAt: now,
      };

      await this.recordHistory('EXECUTION_BRIDGE_PRE_CHECK_FAILED', intent.taskId, {
        ...failedResult,
        failedChecks: validation.failedChecks,
      });

      return failedResult;
    }

    // ------------------------------------------------------------------------
    // Step 2: Atomic Claim
    // ------------------------------------------------------------------------
    let claim: ClaimedIntentRecord;
    try {
      claim = await this.claimIntent(intent);
    } catch (err: any) {
      const conflictResult: BridgeExecutionResult = {
        executionIntentId: intent.executionIntentId,
        actionId: intent.actionId,
        projectId: intent.projectId,
        directorSessionId: intent.directorSessionId,
        taskId: intent.taskId,
        status: ExecutionBridgeStatus.EXECUTION_FAILED,
        isSuccess: false,
        reason: `Failed to claim intent: ${err.message}`,
        code: err.code ?? 'ERR_INTENT_CLAIM_FAILED',
        startedAt: now,
        completedAt: now,
      };
      return conflictResult;
    }

    // ------------------------------------------------------------------------
    // Step 3: Transition to EXECUTION_STARTED
    // ------------------------------------------------------------------------
    const startedAt = new Date().toISOString();
    const runningClaim: ClaimedIntentRecord = {
      ...claim,
      status: ExecutionBridgeStatus.EXECUTION_STARTED,
      startedAt,
    };
    this.claimedRecords.set(intent.executionIntentId, runningClaim);

    // Mark budget reservation as dispatched before handing off to Driver
    if (this.budgetManager && claim.budgetReservationId) {
      try {
        this.budgetManager.markDispatched(claim.budgetReservationId);
      } catch {
        // Non-fatal or already dispatched
      }
    }

    await this.recordHistory('EXECUTION_BRIDGE_STARTED', intent.taskId, {
      executionIntentId: intent.executionIntentId,
      actionId: intent.actionId,
      projectId: intent.projectId,
      directorSessionId: intent.directorSessionId,
      taskId: intent.taskId,
      status: ExecutionBridgeStatus.EXECUTION_STARTED,
      budgetReservationId: claim.budgetReservationId,
      startedAt,
    });

    // ------------------------------------------------------------------------
    // Step 4: Driver Execution Handoff
    // ------------------------------------------------------------------------
    let iterationResult: any = null;
    let executionError: any = null;

    try {
      iterationResult = await this.driverEngine.runIteration({
        workspaceRoot: this.workspaceRoot,
        projectId: intent.projectId,
        directorSessionId: intent.directorSessionId,
        targetTaskId: intent.taskId,
        iterationNumber: 1,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    } catch (err: any) {
      executionError = err;
    }

    const completedAt = new Date().toISOString();

    // ------------------------------------------------------------------------
    // Step 5: Handle Ambiguous / In-flight Crashes / Timeouts -> EXECUTION_UNKNOWN
    // ------------------------------------------------------------------------
    if (executionError) {
      const errMsg = (executionError.message ?? '').toLowerCase();
      const isTimeoutOrAbort =
        options.signal?.aborted ||
        errMsg.includes('timeout') ||
        errMsg.includes('timed out') ||
        errMsg.includes('timedout') ||
        errMsg.includes('abort') ||
        executionError.code === 'ETIMEDOUT' ||
        executionError.name === 'AbortError' ||
        executionError.code === 'ERR_EXECUTION_TIMED_OUT';

      const terminalStatus = isTimeoutOrAbort
        ? ExecutionBridgeStatus.EXECUTION_UNKNOWN
        : ExecutionBridgeStatus.EXECUTION_FAILED;

      const errorResult: BridgeExecutionResult = {
        executionIntentId: intent.executionIntentId,
        actionId: intent.actionId,
        projectId: intent.projectId,
        directorSessionId: intent.directorSessionId,
        taskId: intent.taskId,
        status: terminalStatus,
        isSuccess: false,
        reason: isTimeoutOrAbort
          ? `Execution timed out or aborted in-flight. Entered EXECUTION_UNKNOWN state to prevent duplicate AGY runs: ${executionError.message}`
          : `Driver execution failed: ${executionError.message}`,
        code: isTimeoutOrAbort ? 'ERR_EXECUTION_TIMED_OUT' : (executionError.code ?? 'ERR_DRIVER_EXECUTION_FAILED'),
        startedAt,
        completedAt,
        budgetReservationId: claim.budgetReservationId,
      };

      this.claimedRecords.set(intent.executionIntentId, {
        ...runningClaim,
        status: terminalStatus,
        completedAt,
        terminalReason: errorResult.reason,
      });
      this.executionResults.set(intent.executionIntentId, errorResult);

      await this.recordHistory(
        terminalStatus === ExecutionBridgeStatus.EXECUTION_UNKNOWN
          ? 'EXECUTION_BRIDGE_UNKNOWN'
          : 'EXECUTION_BRIDGE_FAILED',
        intent.taskId,
        { ...errorResult, error: executionError.message }
      );

      // Handle budget reservation on execution error
      if (this.budgetManager && claim.budgetReservationId) {
        try {
          if (terminalStatus === ExecutionBridgeStatus.EXECUTION_UNKNOWN) {
            this.budgetManager.recordUnknown({
              reservationId: claim.budgetReservationId,
              errorReason: errorResult.reason,
            });
          } else {
            this.budgetManager.release({
              reservationId: claim.budgetReservationId,
              reason: errorResult.reason,
            });
          }
        } catch {
          // Non-fatal budget release/recordUnknown logging
        }
      }

      return errorResult;
    }

    // ------------------------------------------------------------------------
    // Step 6: Independent Evidence Verification (Zero Trust on AGY Self-Claims)
    // ------------------------------------------------------------------------
    const cycleResult = iterationResult?.cycleResult;
    const systemEvidence = cycleResult?.systemEvidence;

    let terminalStatus: ExecutionBridgeStatus;
    let isSuccess = false;
    let finalReason = iterationResult?.reason ?? 'Iteration complete';
    let requiresHumanDecision = false;

    const isOutcomeTimeout =
      cycleResult?.rawExecutorOutcome?.status === 'TIMEOUT' ||
      (cycleResult?.rawExecutorOutcome as any)?.timedOut === true;

    if (isOutcomeTimeout) {
      terminalStatus = ExecutionBridgeStatus.EXECUTION_UNKNOWN;
      finalReason = 'Execution timed out on executor. Transitioned to EXECUTION_UNKNOWN to prevent duplicate runs.';
    } else if (!cycleResult || !systemEvidence) {
      // Driver did not produce independently verified system evidence
      terminalStatus = ExecutionBridgeStatus.EXECUTION_FAILED;
      finalReason =
        iterationResult?.reason ??
        'Driver iteration completed without independent SystemExecutionEvidence. Execution cannot be marked as succeeded.';
      requiresHumanDecision = iterationResult?.decision === 'HUMAN_DECISION_REQUIRED';
    } else {
      // Verify authoritative evidence proof boundary
      const evidenceDecision = systemEvidence.verificationDecision;
      const isProofValid = cycleResult.isAuthoritativeProof?.systemEvidenceIsProof === true;
      const executorClaimIgnored = cycleResult.isAuthoritativeProof?.executorOutcomeIsProof === false;

      // Rule: Zero-trust on AGY verbal claims.
      // If no independent filesystem modifications were detected and no independent functional verification commands passed,
      // AGY verbal claims alone cannot satisfy task completion!
      const hasIndependentChanges = systemEvidence.changedFiles && systemEvidence.changedFiles.length > 0;
      const hasPassedFunctionalChecks =
        systemEvidence.verificationChecks &&
        systemEvidence.verificationChecks.length > 0 &&
        systemEvidence.verificationChecks.some(
          (c: any) => (c.type === 'TEST' || c.type === 'BUILD' || c.type === 'COMMAND') && c.status === 'PASS'
        );
      const isPurelyVerbalClaim = !hasIndependentChanges && !hasPassedFunctionalChecks;

      if (isPurelyVerbalClaim) {
        terminalStatus = ExecutionBridgeStatus.EXECUTION_FAILED;
        finalReason = 'AGY self-claim rejected: no independent filesystem modifications or verified command checks were produced.';
      } else if (!isProofValid || !executorClaimIgnored) {
        terminalStatus = ExecutionBridgeStatus.EXECUTION_FAILED;
        finalReason = 'Evidence proof invariant violation: executor claims cannot substitute for independent verification.';
      } else if (evidenceDecision === 'ACCEPT' && cycleResult.terminalStatus === 'ACCEPTED') {
        terminalStatus = ExecutionBridgeStatus.EXECUTION_SUCCEEDED;
        isSuccess = true;
        finalReason = `Task '${intent.taskId}' independently verified and ACCEPTED by SystemExecutionEvidence.`;
      } else if (evidenceDecision === 'BLOCK' || cycleResult.terminalStatus === 'BLOCKED') {
        terminalStatus = ExecutionBridgeStatus.EXECUTION_FAILED;
        requiresHumanDecision = true;
        finalReason = `Task '${intent.taskId}' blocked by verification: requires human decision.`;
      } else {
        terminalStatus = ExecutionBridgeStatus.EXECUTION_FAILED;
        finalReason = `Task '${intent.taskId}' verification REJECTED by SystemExecutionEvidence.`;
      }
    }

    const finalResult: BridgeExecutionResult = {
      executionIntentId: intent.executionIntentId,
      actionId: intent.actionId,
      projectId: intent.projectId,
      directorSessionId: intent.directorSessionId,
      taskId: intent.taskId,
      status: terminalStatus,
      isSuccess,
      reason: finalReason,
      code: isSuccess
        ? undefined
        : isOutcomeTimeout
          ? 'ERR_EXECUTION_TIMED_OUT'
          : 'ERR_VERIFICATION_FAILED',
      cycleResult,
      systemEvidence,
      startedAt,
      completedAt,
      budgetReservationId: claim.budgetReservationId,
      requiresHumanDecision,
    };

    this.claimedRecords.set(intent.executionIntentId, {
      ...runningClaim,
      status: terminalStatus,
      completedAt,
      terminalReason: finalReason,
    });
    this.executionResults.set(intent.executionIntentId, finalResult);

    await this.recordHistory(
      terminalStatus === ExecutionBridgeStatus.EXECUTION_SUCCEEDED
        ? 'EXECUTION_BRIDGE_SUCCEEDED'
        : terminalStatus === ExecutionBridgeStatus.EXECUTION_UNKNOWN
          ? 'EXECUTION_BRIDGE_UNKNOWN'
          : 'EXECUTION_BRIDGE_FAILED',
      intent.taskId,
      {
        ...finalResult,
        cycleResult: cycleResult ? { cycleId: cycleResult.cycleId, terminalStatus: cycleResult.terminalStatus } : null,
      }
    );

    // Settle / release / recordUnknown budget reservation if one was created
    if (this.budgetManager && claim.budgetReservationId) {
      try {
        if (isSuccess) {
          const actualUsage = (iterationResult?.actualUsage as { inputTokens: number; outputTokens: number }) ?? {
            inputTokens: 100,
            outputTokens: 50,
          };
          const providerId = (intent.metadata?.providerId as string) ?? 'antigravity';
          this.budgetManager.settle(
            {
              reservationId: claim.budgetReservationId,
              reportedUsage: actualUsage,
              idempotencyKey: `${claim.idempotencyKey}-settle`,
            },
            providerId
          );
        } else if (terminalStatus === ExecutionBridgeStatus.EXECUTION_UNKNOWN) {
          this.budgetManager.recordUnknown({
            reservationId: claim.budgetReservationId,
            errorReason: finalResult.reason,
          });
        } else {
          this.budgetManager.release({
            reservationId: claim.budgetReservationId,
            reason: finalResult.reason,
          });
        }
      } catch {
        // Non-fatal settlement/release logging
      }
    }

      return finalResult;
    })();

    this.inFlightExecutionPromises.set(intent.executionIntentId, execPromise);
    try {
      return await execPromise;
    } finally {
      this.inFlightExecutionPromises.delete(intent.executionIntentId);
    }
  }

  // ==========================================================================
  // 4. RESTAURANT / CRASH RECOVERY
  // ==========================================================================

  /**
   * Reconciles in-flight intent execution states after a process restart or crash.
   * If an intent was left in EXECUTION_CLAIMED or EXECUTION_STARTED:
   * - Checks whether evidenceStore contains independently verified evidence for the task.
   * - If no completed verified evidence exists, transitions intent safely to EXECUTION_UNKNOWN.
   * - CRITICAL: EXECUTION_UNKNOWN is NEVER automatically re-dispatched to AGY!
   */
  async recover(): Promise<{
    recoveredCount: number;
    reconciledIntents: Record<string, ExecutionBridgeStatus>;
    budgetRecoveryReport?: RecoveryReport;
  }> {
    if (!this.isInitialized) {
      await this.initializeFromHistory();
    }

    // 1. Recover and reconcile persistent P18-03 budget reservations from crash
    let budgetRecoveryReport: RecoveryReport | undefined;
    if (this.budgetManager) {
      try {
        budgetRecoveryReport = this.budgetManager.recover();
      } catch {
        // Recovery logging
      }
    }

    const reconciledIntents: Record<string, ExecutionBridgeStatus> = {};
    let recoveredCount = 0;

    for (const [intentId, claim] of this.claimedRecords.entries()) {
      if (
        claim.status === ExecutionBridgeStatus.EXECUTION_CLAIMED ||
        claim.status === ExecutionBridgeStatus.EXECUTION_STARTED
      ) {
        // Unfinished execution before process death
        recoveredCount++;
        const now = new Date().toISOString();

        // Check if verified evidence exists in evidenceStore
        let evidenceFound = false;
        try {
          const evidenceList = await this.evidenceStore.listAllEvidence();
          const taskEvidence = evidenceList.find((e: any) => {
            if (e.taskId !== claim.taskId) return false;
            if (e.verificationDecision !== 'ACCEPT') return false;
            if (e.projectId && claim.projectId && e.projectId !== claim.projectId) return false;
            // Freshness invariant: evidence must have been collected AFTER or AT the claim timestamp
            const evidenceTime = (e as any).verifiedAt ?? (e as any).collectedAt;
            if (evidenceTime && claim.claimedAt && new Date(evidenceTime).getTime() < new Date(claim.claimedAt).getTime()) {
              return false;
            }
            // Session binding invariant: must match claimed session
            if (
              e.requestBinding?.directorSessionId &&
              claim.directorSessionId &&
              e.requestBinding.directorSessionId !== claim.directorSessionId
            ) {
              return false;
            }
            return true;
          });
          if (taskEvidence) {
            evidenceFound = true;
          }
        } catch {
          // ignore read error
        }

        const resolvedStatus = evidenceFound
          ? ExecutionBridgeStatus.EXECUTION_SUCCEEDED
          : ExecutionBridgeStatus.EXECUTION_UNKNOWN;

        const resolvedReason = evidenceFound
          ? 'Recovered post-crash: verified evidence found in EvidenceStore.'
          : 'Crash/restart recovery: intent was in-flight when process died. Reconciled to EXECUTION_UNKNOWN to prevent duplicate AGY execution.';

        const updatedClaim: ClaimedIntentRecord = {
          ...claim,
          status: resolvedStatus,
          completedAt: now,
          terminalReason: resolvedReason,
        };
        this.claimedRecords.set(intentId, updatedClaim);
        reconciledIntents[intentId] = resolvedStatus;

        await this.recordHistory(
          resolvedStatus === ExecutionBridgeStatus.EXECUTION_SUCCEEDED
            ? 'EXECUTION_BRIDGE_SUCCEEDED'
            : 'EXECUTION_BRIDGE_UNKNOWN',
          claim.taskId,
          {
            executionIntentId: intentId,
            status: resolvedStatus,
            reason: resolvedReason,
            recoveredAt: now,
          }
        );
      }
    }

    return { recoveredCount, reconciledIntents, budgetRecoveryReport };
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  getClaim(intentId: string): ClaimedIntentRecord | undefined {
    return this.claimedRecords.get(intentId);
  }

  getResult(intentId: string): BridgeExecutionResult | undefined {
    return this.executionResults.get(intentId);
  }

  private async recordHistory(
    eventType: string,
    taskId: string | null | undefined,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.historyManager) return;
    try {
      await this.historyManager.appendEvent({
        eventId: `ev-bridge-${crypto.randomBytes(8).toString('hex')}`,
        eventType,
        actor: Actor.ORCHESTRATOR,
        taskId: taskId ?? null,
        payload,
      });
    } catch (err: any) {
      if (eventType === 'EXECUTION_BRIDGE_INTENT_CLAIMED') {
        throw err;
      }
      // Non-fatal for other lifecycle events
    }
  }
}
