/**
 * Director Context Synchronizer (Phase 9 TASK-P9-02)
 *
 * Implements deterministic, auditable, project-bound synchronization of
 * authoritative AIDM state for ChatGPT Director reasoning.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. CONTEXT ONLY: purely derived/read-oriented protocol boundary over authoritative sources.
 * 2. It must NOT become a second source of truth.
 * 3. Authoritative AIDM state strictly wins over any cached/snapshot representation.
 * 4. Strictly read-only: does NOT mutate requirements, decisions, Task DAG, approvals, clarifications, Git, or OS.
 * 5. Does NOT grant development authorization (isDevelopmentAuthorized() remains unchanged).
 * 6. Does NOT invoke Antigravity or autonomous iteration loops.
 * 7. Enforces Director session identity and rejects closed or cross-project sessions.
 * 8. Produces deterministic ordering and stable logical fingerprints.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Actor } from '../actors.js';
import { sanitizeMcpPayload } from '../mcp/mcp-errors.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { SpecStore } from '../storage/spec-store.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import { ContextEngine } from '../context-engine/context-engine.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type { GitPort } from '../git/git-port.js';
import { HistoryManager } from '../storage/history-manager.js';
import { ClarificationStore } from '../clarification/clarification-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { DirectorSessionStore } from './director-session-store.js';
import { DirectorSessionEngine } from './director-session-engine.js';
import { validateProjectBinding, resolveCanonicalProjectIdentity } from './project-identity-resolver.js';
import {
  type DirectorContextSnapshot,
  type DirectorContextSections,
  type DirectorContextSyncInput,
  type SyncSectionMetadata,
  type DirectorSyncStatus,
  type DirectorProjectStatusSection,
  type DirectorRequirementsSection,
  type DirectorDecisionsSection,
  type DirectorCurrentTaskSection,
  type DirectorTaskListSection,
  type DirectorContextEngineSection,
  type DirectorEvidenceSection,
  type DirectorHistorySection,
  type DirectorGitSection,
  type DirectorDiscoverySection,
  type DirectorClarificationSection,
  type DirectorApprovalSection,
  type DirectorAuthorizationSection,
  DIRECTOR_CONTEXT_PROTOCOL_VERSION,
  DIRECTOR_CONTEXT_SCHEMA_VERSION,
  DirectorContextSyncInputZodSchema,
} from './director-context-types.js';
import {
  DirectorSessionError,
  DirectorValidationError,
  DirectorSessionNotFoundError,
  DirectorInvalidTransitionError,
  DirectorProjectBindingMismatchError,
} from './director-errors.js';

export interface DirectorContextSynchronizerOptions {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly sessionStore?: DirectorSessionStore;
}

export class DirectorContextSynchronizer {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly sessionEngine: DirectorSessionEngine;
  readonly sessionStore: DirectorSessionStore;

  constructor(options: DirectorContextSynchronizerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.delegate = options.delegate;
    this.sessionStore =
      options.sessionStore ??
      options.delegate?.directorSessionStore ??
      new DirectorSessionStore({
        baseDir: this.workspaceRoot,
        historyManager: options.delegate?.historyManager,
      });
    this.sessionEngine =
      options.sessionEngine ??
      new DirectorSessionEngine({
        store: this.sessionStore,
        workspaceRoot: this.workspaceRoot,
      });
  }

  /**
   * Computes a deterministic SHA-256 fingerprint for arbitrary structured payload.
   * Keys are sorted recursively; volatile metadata like request timestamps are excluded.
   */
  computeDeterministicFingerprint(payload: unknown): string {
    const canonical = this.canonicalizeForHashing(payload);
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  private canonicalizeForHashing(val: unknown): string {
    if (val === null || val === undefined) {
      return 'null';
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      return JSON.stringify(val);
    }
    if (typeof val === 'string') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return '[' + val.map((item) => this.canonicalizeForHashing(item)).join(',') + ']';
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const entries = sortedKeys.map(
        (k) => `${JSON.stringify(k)}:${this.canonicalizeForHashing(obj[k])}`
      );
      return '{' + entries.join(',') + '}';
    }
    return JSON.stringify(String(val));
  }

  /**
   * Synchronizes authoritative AIDM state into a typed, derived Director context snapshot.
   */
  async synchronize(input: DirectorContextSyncInput = {}): Promise<DirectorContextSnapshot> {
    // 1. Validate sync input schema
    const parsedInput = DirectorContextSyncInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new DirectorValidationError(
        `Invalid Director context sync input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    // 2. Resolve Director session
    let session;
    try {
      session = await this.sessionEngine.getSession(input.directorSessionId, {
        workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
        projectId: input.projectId,
      });
    } catch (err) {
      if (this.sessionStore['historyManager']) {
        try {
          await this.sessionStore['historyManager'].appendEvent({
            eventType: 'DIRECTOR_CONTEXT_SYNC_FAILED',
            actor: Actor.DIRECTOR,
            payload: {
              directorSessionId: input.directorSessionId ?? null,
              projectId: input.projectId ?? null,
              reason: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // ignore
        }
      }
      throw err;
    }

    // 3. Closed sessions cannot synchronize
    if (session.status === 'CLOSED') {
      const closedErr = new DirectorInvalidTransitionError('CLOSED', 'SYNCHRONIZE', {
        reason: 'Closed Director sessions are terminal and cannot perform context synchronization. A new session must be established.',
        directorSessionId: session.directorSessionId,
      });

      if (this.sessionStore['historyManager']) {
        try {
          await this.sessionStore['historyManager'].appendEvent({
            eventType: 'DIRECTOR_CONTEXT_SYNC_FAILED',
            actor: Actor.DIRECTOR,
            payload: {
              directorSessionId: session.directorSessionId,
              projectId: session.projectId,
              reason: closedErr.message,
            },
          });
        } catch {
          // ignore
        }
      }

      throw closedErr;
    }

    // 4. Validate project binding (prevent cross-project sync)
    validateProjectBinding(session, {
      workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
      projectId: input.projectId,
    });

    const projectRoot = path.resolve(session.projectRoot);
    const projectId = session.projectId;

    // 5. Gather authoritative components from delegate or project root
    const durableManager =
      this.delegate?.durableStateManager ?? new DurableStateManager({ baseDir: projectRoot });
    const specStore = this.delegate?.specStore ?? new SpecStore({ baseDir: projectRoot });
    const dagEngine = this.delegate?.dagEngine ?? new TaskDagEngine();
    const contextEngine =
      this.delegate?.contextEngine ?? new ContextEngine({ workspaceRoot: projectRoot });
    const gitPort = this.delegate?.gitPort ?? new DefaultGitPort();
    const historyManager =
      this.delegate?.historyManager ?? new HistoryManager({ baseDir: projectRoot });
    const clarificationStore =
      this.delegate?.clarificationStore ??
      new ClarificationStore({ baseDir: projectRoot, historyManager });
    const approvalStore =
      this.delegate?.approvalStore ??
      new ApprovalStore({ baseDir: projectRoot, historyManager });

    const unavailableSections: string[] = [];
    const staleSections: string[] = [];

    // --- Section 1: Project Status ---
    let projectStatusSection: DirectorProjectStatusSection;
    let projectStatusMeta: SyncSectionMetadata;
    try {
      const exists = await durableManager.exists();
      if (exists) {
        const state = await durableManager.load();
        if (state) {
          projectStatusSection = {
            initialized: true,
            lifecycleState: state.currentLifecycleState,
            isCompleted: state.currentLifecycleState === 'PROJECT_COMPLETE',
            isBlocked: !!state.blockedState,
            blockedReason: state.blockedState?.blockingReason ?? null,
            activeTaskId: state.activeTaskId ?? null,
            lastCheckpoint: state.lastCheckpoint ?? null,
          };
          projectStatusMeta = {
            synchronized: true,
            available: true,
            isStale: false,
            revision: state.schemaVersion,
            fingerprint: this.computeDeterministicFingerprint(projectStatusSection),
          };
        } else {
          projectStatusSection = {
            initialized: false,
            lifecycleState: 'UNINITIALIZED',
            isCompleted: false,
            isBlocked: false,
            blockedReason: null,
            activeTaskId: null,
            lastCheckpoint: null,
          };
          projectStatusMeta = {
            synchronized: true,
            available: true,
            isStale: false,
            revision: null,
            fingerprint: this.computeDeterministicFingerprint(projectStatusSection),
          };
        }
      } else {
        projectStatusSection = {
          initialized: false,
          lifecycleState: 'UNINITIALIZED',
          isCompleted: false,
          isBlocked: false,
          blockedReason: null,
          activeTaskId: null,
          lastCheckpoint: null,
        };
        projectStatusMeta = {
          synchronized: true,
          available: true,
          isStale: false,
          revision: null,
          fingerprint: this.computeDeterministicFingerprint(projectStatusSection),
        };
      }
    } catch (err) {
      unavailableSections.push('projectStatus');
      projectStatusSection = {
        initialized: false,
        lifecycleState: 'ERROR',
        isCompleted: false,
        isBlocked: false,
        blockedReason: null,
        activeTaskId: null,
        lastCheckpoint: null,
      };
      projectStatusMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 2: Requirements ---
    let requirementsSection: DirectorRequirementsSection;
    let requirementsMeta: SyncSectionMetadata;
    try {
      const reqs = await specStore.loadRequirements();
      const sortedReqs = [...reqs]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          authority: r.authority,
          status: r.status,
          acceptanceCriteria: (r as unknown as { acceptanceCriteria?: string[] }).acceptanceCriteria,
          metadata: (r as unknown as { metadata?: Record<string, unknown> }).metadata,
        }));
      requirementsSection = {
        total: sortedReqs.length,
        items: sortedReqs,
      };
      requirementsMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        revision: sortedReqs.length,
        fingerprint: this.computeDeterministicFingerprint(requirementsSection),
      };
    } catch (err) {
      unavailableSections.push('requirements');
      requirementsSection = { total: 0, items: [] };
      requirementsMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 3: Decisions ---
    let decisionsSection: DirectorDecisionsSection;
    let decisionsMeta: SyncSectionMetadata;
    try {
      const decs = await specStore.loadDecisions();
      const sortedDecs = [...decs]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((d) => ({
          id: d.id,
          title: d.title,
          description: d.description,
          authority: d.authority,
          status: d.status,
          rationale: d.rationale,
          metadata: d.metadata,
        }));
      decisionsSection = {
        total: sortedDecs.length,
        items: sortedDecs,
      };
      decisionsMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        revision: sortedDecs.length,
        fingerprint: this.computeDeterministicFingerprint(decisionsSection),
      };
    } catch (err) {
      unavailableSections.push('decisions');
      decisionsSection = { total: 0, items: [] };
      decisionsMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 4 & 5: Current Task & Task List ---
    let currentTaskSection: DirectorCurrentTaskSection;
    let currentTaskMeta: SyncSectionMetadata;
    let taskListSection: DirectorTaskListSection;
    let taskListMeta: SyncSectionMetadata;
    try {
      const allTasks = await specStore.loadTasks();
      const sortedTasks = [...allTasks].sort((a, b) => a.task_id.localeCompare(b.task_id));

      let topologicalOrder: string[] = [];
      try {
        if (sortedTasks.length > 0) {
          const validation = dagEngine.validateGraph(sortedTasks);
          if (validation.topologicalOrder) {
            topologicalOrder = validation.topologicalOrder;
          } else {
            topologicalOrder = sortedTasks.map((t) => t.task_id);
          }
        }
      } catch {
        topologicalOrder = sortedTasks.map((t) => t.task_id);
      }

      taskListSection = {
        total: sortedTasks.length,
        topologicalOrder,
        tasks: sortedTasks.map((t) => ({
          taskId: t.task_id,
          title: t.title,
          status: t.status,
          hierarchyLevel: t.hierarchy_level ?? 'TASK',
          dependencies: [...t.dependencies].sort(),
          priority: t.priority,
        })),
      };
      taskListMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        revision: sortedTasks.length,
        fingerprint: this.computeDeterministicFingerprint(taskListSection),
      };

      const activeId = projectStatusSection.activeTaskId;
      const activeTask = activeId ? sortedTasks.find((t) => t.task_id === activeId) : null;
      if (activeTask) {
        currentTaskSection = {
          hasActiveTask: true,
          task: {
            taskId: activeTask.task_id,
            title: activeTask.title,
            description: activeTask.description,
            hierarchyLevel: activeTask.hierarchy_level ?? 'TASK',
            status: activeTask.status,
            priority: activeTask.priority,
            riskLevel: activeTask.risk_level,
            dependencies: [...activeTask.dependencies].sort(),
            acceptanceCriteria: [...activeTask.acceptance_criteria].sort(),
            traceabilitySources: [...activeTask.traceability_sources].sort(),
            attempt: activeTask.attempt,
            maxAttempts: activeTask.max_attempts,
          },
        };
      } else {
        currentTaskSection = {
          hasActiveTask: false,
          task: null,
        };
      }
      currentTaskMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        fingerprint: this.computeDeterministicFingerprint(currentTaskSection),
      };
    } catch (err) {
      unavailableSections.push('taskList', 'currentTask');
      taskListSection = { total: 0, topologicalOrder: [], tasks: [] };
      taskListMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
      currentTaskSection = { hasActiveTask: false, task: null };
      currentTaskMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 6: ContextEngine ---
    let contextEngineSection: DirectorContextEngineSection;
    let contextEngineMeta: SyncSectionMetadata;
    try {
      const targetPaths = input.targetPaths ?? [];
      const inspected: Array<{
        sourcePath: string;
        layer: string;
        fileHash: string;
        isStale: boolean;
      }> = [];

      let hasStale = false;
      for (const p of targetPaths) {
        try {
          const l0 = await contextEngine.getL0Context(p);
          const fullPath = path.join(projectRoot, p);
          let diskHash = '';
          if (fs.existsSync(fullPath)) {
            const { computeFileSha256 } = await import('../l0/hasher.js');
            diskHash = await computeFileSha256(fullPath);
          }
          const isStale = Boolean(diskHash && l0.fileHash !== diskHash);
          if (isStale) {
            hasStale = true;
          }
          inspected.push({
            sourcePath: p,
            layer: 'L0',
            fileHash: l0.fileHash,
            isStale,
          });
        } catch {
          inspected.push({
            sourcePath: p,
            layer: 'L0',
            fileHash: 'unknown',
            isStale: true,
          });
          hasStale = true;
        }
      }

      inspected.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
      if (hasStale) {
        staleSections.push('contextEngine');
      }

      contextEngineSection = {
        isAvailable: true,
        hasL0Cache: fs.existsSync(contextEngine.dbPath),
        inspectedPaths: inspected,
      };
      contextEngineMeta = {
        synchronized: true,
        available: true,
        isStale: hasStale,
        fingerprint: this.computeDeterministicFingerprint(contextEngineSection),
      };
    } catch (err) {
      unavailableSections.push('contextEngine');
      contextEngineSection = { isAvailable: false, hasL0Cache: false, inspectedPaths: [] };
      contextEngineMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 7: Evidence ---
    let evidenceSection: DirectorEvidenceSection;
    let evidenceMeta: SyncSectionMetadata;
    try {
      let rawEvidence: readonly unknown[] = [];
      if (this.delegate?.getEvidence) {
        rawEvidence = await this.delegate.getEvidence(
          { limit: input.evidenceLimit ?? 20 },
          { correlationId: 'director-sync', receivedAt: new Date().toISOString() }
        );
      }
      const items = (rawEvidence as Array<Record<string, unknown>>).map((e) => ({
        evidenceId: String(e.evidenceId ?? e.id ?? 'unknown'),
        taskId: String(e.taskId ?? 'unknown'),
        evidenceType: String(e.evidenceType ?? 'unknown'),
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : undefined,
        command: typeof e.command === 'string' ? e.command : undefined,
        isSystemVerified: e.isSystemVerified !== false,
      }));
      items.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
      evidenceSection = {
        totalAvailable: items.length,
        items,
      };
      evidenceMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        fingerprint: this.computeDeterministicFingerprint(evidenceSection),
      };
    } catch (err) {
      unavailableSections.push('evidence');
      evidenceSection = { totalAvailable: 0, items: [] };
      evidenceMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 8: History ---
    let historySection: DirectorHistorySection;
    let historyMeta: SyncSectionMetadata;
    try {
      const allEvents = await historyManager.readEvents();
      // Exclude self-referential director sync and touch events to maintain stable logical fingerprint
      const relevantEvents = allEvents.filter(
        (ev: { eventType: string }) =>
          !ev.eventType.startsWith('DIRECTOR_CONTEXT_') &&
          ev.eventType !== 'DIRECTOR_SESSION_ACTIVITY_UPDATED'
      );
      const limit = input.historyLimit ?? 20;
      const recent = relevantEvents.slice(-limit);
      historySection = {
        totalEvents: relevantEvents.length,
        recentEvents: recent.map((ev: { eventId: string; timestamp: string; eventType: string; actor: string; taskId?: string | null }) => ({
          eventId: ev.eventId,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          actor: ev.actor,
          taskId: ev.taskId ?? null,
        })),
      };
      historyMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        fingerprint: this.computeDeterministicFingerprint(
          recent.map((ev: { eventId: string; eventType: string; actor: string }) => ({
            eventId: ev.eventId,
            eventType: ev.eventType,
            actor: ev.actor,
          }))
        ),
      };
    } catch (err) {
      unavailableSections.push('history');
      historySection = { totalEvents: 0, recentEvents: [] };
      historyMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 9: Git Status ---
    let gitSection: DirectorGitSection;
    let gitMeta: SyncSectionMetadata;
    try {
      const gitState = await gitPort.inspectState(projectRoot);
      const checkpointStore = this.delegate?.checkpointStore;
      const allCps = checkpointStore ? await checkpointStore.loadCheckpoints() : [];
      const lastCp = allCps.length > 0 ? allCps[allCps.length - 1] : null;

      gitSection = {
        isGitRepository: Boolean(gitState.isRepository),
        head: gitState.head_sha ?? null,
        branch: gitState.current_branch ?? null,
        workingTreeClean: gitState.working_tree_clean ?? null,
        totalAcceptedCheckpoints: allCps.length,
        lastCheckpointId: lastCp?.checkpoint_id ?? null,
      };
      gitMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        revision: gitState.head_sha ?? null,
        fingerprint: this.computeDeterministicFingerprint(gitSection),
      };
    } catch (err) {
      unavailableSections.push('git');
      gitSection = {
        isGitRepository: false,
        head: null,
        branch: null,
        workingTreeClean: null,
        totalAcceptedCheckpoints: 0,
      };
      gitMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 10: Discovery ---
    let discoverySection: DirectorDiscoverySection;
    let discoveryMeta: SyncSectionMetadata;
    try {
      const canonical = resolveCanonicalProjectIdentity(projectRoot);
      discoverySection = {
        isDiscovered: true,
        projectName: canonical.projectName,
        apparentPurposeClassification: 'KNOWN',
        technologyStack: [{ name: canonical.ecosystem }],
        entryPointsCount: 1,
        unknownsCount: 0,
        contradictionsCount: 0,
      };
      discoveryMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        fingerprint: this.computeDeterministicFingerprint(discoverySection),
      };
    } catch (err) {
      unavailableSections.push('discovery');
      discoverySection = {
        isDiscovered: false,
        projectName: projectId,
        apparentPurposeClassification: 'UNKNOWN',
        technologyStack: [],
        entryPointsCount: 0,
        unknownsCount: 0,
        contradictionsCount: 0,
      };
      discoveryMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 11: Clarification ---
    let clarificationSection: DirectorClarificationSection;
    let clarificationMeta: SyncSectionMetadata;
    try {
      const activeClarification = await clarificationStore.getActiveSession();
      if (activeClarification) {
        clarificationSection = {
          hasActiveSession: true,
          sessionId: activeClarification.sessionId,
          status: activeClarification.status,
          totalCount: activeClarification.totalCount,
          resolvedCount: activeClarification.resolvedCount,
          blockingOpenCount: activeClarification.blockingOpenCount,
          hasUnresolvedBlocking: activeClarification.blockingOpenCount > 0,
        };
      } else {
        clarificationSection = {
          hasActiveSession: false,
          sessionId: null,
          status: null,
          totalCount: 0,
          resolvedCount: 0,
          blockingOpenCount: 0,
          hasUnresolvedBlocking: false,
        };
      }
      clarificationMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        revision: activeClarification?.sessionId ?? null,
        fingerprint: this.computeDeterministicFingerprint(clarificationSection),
      };
    } catch (err) {
      unavailableSections.push('clarification');
      clarificationSection = {
        hasActiveSession: false,
        totalCount: 0,
        resolvedCount: 0,
        blockingOpenCount: 0,
        hasUnresolvedBlocking: false,
      };
      clarificationMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // --- Section 12 & 13: Approval & Authorization ---
    let approvalSection: DirectorApprovalSection;
    let approvalMeta: SyncSectionMetadata;
    let authorizationSection: DirectorAuthorizationSection;
    let authorizationMeta: SyncSectionMetadata;
    try {
      const activePkg = await approvalStore.getActivePackage();
      const approvalEngine = new ApprovalPackageEngine();

      const isDevAuth = activePkg ? approvalEngine.isDevelopmentAuthorized(activePkg) : false;

      if (activePkg) {
        approvalSection = {
          hasApprovalPackage: true,
          packageId: activePkg.packageId,
          revision: activePkg.revision,
          status: activePkg.status,
          isReadyForApproval: activePkg.status === 'READY_FOR_APPROVAL',
          isExplicitlyApproved: activePkg.status === 'APPROVED',
          approvedAt: activePkg.approvalRecord?.approvedAt ?? null,
        };
      } else {
        approvalSection = {
          hasApprovalPackage: false,
          packageId: null,
          revision: null,
          status: null,
          isReadyForApproval: false,
          isExplicitlyApproved: false,
          approvedAt: null,
        };
      }
      approvalMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        revision: activePkg?.revision ?? null,
        fingerprint: this.computeDeterministicFingerprint(approvalSection),
      };

      // INVARIANT: isDevelopmentAuthorized is strictly reported. Never modified.
      authorizationSection = {
        isDevelopmentAuthorized: isDevAuth,
        authoritySource: 'PRODUCT_OWNER',
        requiresHumanApproval: true,
      };
      authorizationMeta = {
        synchronized: true,
        available: true,
        isStale: false,
        fingerprint: this.computeDeterministicFingerprint(authorizationSection),
      };
    } catch (err) {
      unavailableSections.push('approval', 'authorization');
      approvalSection = {
        hasApprovalPackage: false,
        isReadyForApproval: false,
        isExplicitlyApproved: false,
      };
      approvalMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
      authorizationSection = {
        isDevelopmentAuthorized: false,
        authoritySource: 'PRODUCT_OWNER',
        requiresHumanApproval: true,
      };
      authorizationMeta = {
        synchronized: false,
        available: false,
        isStale: false,
        fingerprint: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const sections: DirectorContextSections = {
      projectStatus: projectStatusSection,
      requirements: requirementsSection,
      decisions: decisionsSection,
      currentTask: currentTaskSection,
      taskList: taskListSection,
      contextEngine: contextEngineSection,
      evidence: evidenceSection,
      history: historySection,
      git: gitSection,
      discovery: discoverySection,
      clarification: clarificationSection,
      approval: approvalSection,
      authorization: authorizationSection,
    };

    const sectionMetadata: Record<keyof DirectorContextSections, SyncSectionMetadata> = {
      projectStatus: projectStatusMeta,
      requirements: requirementsMeta,
      decisions: decisionsMeta,
      currentTask: currentTaskMeta,
      taskList: taskListMeta,
      contextEngine: contextEngineMeta,
      evidence: evidenceMeta,
      history: historyMeta,
      git: gitMeta,
      discovery: discoveryMeta,
      clarification: clarificationMeta,
      approval: approvalMeta,
      authorization: authorizationMeta,
    };

    // Calculate deterministic logical fingerprint (excludes volatile timestamps & request IDs)
    const fingerprintMaterial = {
      projectId,
      projectStatus: projectStatusMeta.fingerprint,
      requirements: requirementsMeta.fingerprint,
      decisions: decisionsMeta.fingerprint,
      currentTask: currentTaskMeta.fingerprint,
      taskList: taskListMeta.fingerprint,
      contextEngine: contextEngineMeta.fingerprint,
      evidence: evidenceMeta.fingerprint,
      history: historyMeta.fingerprint,
      git: gitMeta.fingerprint,
      discovery: discoveryMeta.fingerprint,
      clarification: clarificationMeta.fingerprint,
      approval: approvalMeta.fingerprint,
      authorization: authorizationMeta.fingerprint,
    };
    const logicalFingerprint = this.computeDeterministicFingerprint(fingerprintMaterial);

    const isComplete = unavailableSections.length === 0;

    // Determine sync status
    let syncStatus: DirectorSyncStatus;
    if (!isComplete) {
      syncStatus = 'INCOMPLETE';
    } else if (staleSections.length > 0) {
      syncStatus = 'STALE';
    } else if (!input.priorFingerprint) {
      syncStatus = 'INITIAL';
    } else if (input.priorFingerprint === logicalFingerprint) {
      syncStatus = 'UNCHANGED';
    } else {
      syncStatus = 'CHANGED';
    }

    const now = new Date().toISOString();
    const snapshot: DirectorContextSnapshot = {
      directorSessionId: session.directorSessionId,
      projectId,
      projectRoot,
      protocolVersion: DIRECTOR_CONTEXT_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_CONTEXT_SCHEMA_VERSION,
      synchronizedAt: now,
      syncStatus,
      isComplete,
      unavailableSections: [...unavailableSections].sort(),
      staleSections: [...staleSections].sort(),
      sectionMetadata,
      logicalFingerprint,
      priorFingerprint: input.priorFingerprint ?? null,
      sections,
      isDerived: true,
    };

    // Persist snapshot to store
    await this.sessionStore.saveSnapshot(snapshot);

    // Update Director session last activity
    await this.sessionEngine.touchSession({
      directorSessionId: session.directorSessionId,
      workspaceRoot: projectRoot,
      projectId,
    });

    return snapshot;
  }
}
