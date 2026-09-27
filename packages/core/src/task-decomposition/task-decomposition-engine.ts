/**
 * Task Decomposition & Authoritative Ingestion Engine (Phase 12 TASK-P12-01)
 *
 * Implements the authoritative ingestion boundary bridging an approved development plan
 * (and untrusted Director proposals) to validated, persistent TaskDefinition[] in SpecStore.
 *
 * STRICT GOVERNANCE RULES:
 * 1. Product Owner Approval Gate: requires isDevelopmentAuthorized() === true.
 * 2. Revision & Fingerprint Binding: strictly binds to approvalPackageRevision, directorSessionId, contextFingerprint.
 * 3. Static Decomposition: produces complete initial DAG; zero runtime DAG mutations.
 * 4. Deterministic Identity: uses stable slug hashing from approved features / semantic keys.
 * 5. Scope Safety: rejects path traversal ('..'), absolute paths, and scope expanding beyond PO approval.
 * 6. DAG Authority: asserts full graph validity via TaskDagEngine before persistence.
 * 7. SpecStore Ingestion: writes complete valid task list atomically.
 * 8. Idempotency: repeated identical decompositions are safe, deterministic no-ops.
 * 9. History Manager: emits TASK_DECOMPOSITION_INGESTED audit events.
 * 10. Zero Task Execution: never invokes Antigravity or OS processes.
 */

import * as crypto from 'node:crypto';
import { Actor } from '../actors.js';
import type { TaskDefinition, TaskHierarchyLevel, TaskPriority } from '../task-engine/task-types.js';
import type { RiskLevel } from '../risk.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import { SpecStore } from '../storage/spec-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { resolveCanonicalProjectIdentity, validateProjectBinding } from '../director/project-identity-resolver.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import type { ProjectApprovalPackage, ProposedFeatureGroup } from '../approval/approval-types.js';
import {
  type DecomposePlanInput,
  type DecomposePlanResult,
  type CandidateTaskProposal,
  type CandidateTaskScope,
  DecomposePlanInputZodSchema,
} from './task-decomposition-types.js';
import {
  TaskDecompositionValidationError,
  TaskDecompositionApprovalRequiredError,
  TaskDecompositionApprovalRevisionMismatchError,
  TaskDecompositionProjectBindingMismatchError,
  TaskDecompositionSessionBindingMismatchError,
  TaskDecompositionContextMismatchError,
  TaskDecompositionContextStaleError,
  TaskDecompositionContextIncompleteError,
  TaskDecompositionInvalidTaskDefinitionError,
  TaskDecompositionInvalidTraceabilityError,
  TaskDecompositionInvalidScopeError,
  TaskDecompositionConflictError,
  TaskDecompositionInvalidGraphError,
  TaskDecompositionOutOfScopeError,
} from './task-decomposition-errors.js';
import { TaskGraphValidationError } from '../errors/task-graph-validation-error.js';

export interface TaskDecompositionEngineOptions {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly specStore?: SpecStore;
  readonly dagEngine?: TaskDagEngine;
  readonly approvalStore?: ApprovalStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly sessionStore?: DirectorSessionStore;
  readonly sessionEngine?: DirectorSessionEngine;
  readonly historyManager?: HistoryManager;
}

export class TaskDecompositionEngine {
  readonly workspaceRoot?: string;
  readonly delegate?: McpOrchestratorDelegate;
  readonly specStore: SpecStore;
  readonly dagEngine: TaskDagEngine;
  readonly approvalStore: ApprovalStore;
  readonly approvalPackageEngine: ApprovalPackageEngine;
  readonly sessionStore: DirectorSessionStore;
  readonly sessionEngine: DirectorSessionEngine;
  readonly historyManager?: HistoryManager;

  constructor(options: TaskDecompositionEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.delegate = options.delegate;
    this.historyManager = options.historyManager ?? options.delegate?.historyManager;

    this.specStore =
      options.specStore ??
      options.delegate?.specStore ??
      new SpecStore({ baseDir: this.workspaceRoot });

    this.dagEngine =
      options.dagEngine ??
      options.delegate?.dagEngine ??
      new TaskDagEngine();

    this.approvalStore =
      options.approvalStore ??
      options.delegate?.approvalStore ??
      new ApprovalStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });

    this.approvalPackageEngine =
      options.approvalPackageEngine ?? new ApprovalPackageEngine();

    this.sessionStore =
      options.sessionStore ??
      options.delegate?.directorSessionStore ??
      new DirectorSessionStore({
        baseDir: this.workspaceRoot,
        historyManager: this.historyManager,
      });

    this.sessionEngine =
      options.sessionEngine ??
      new DirectorSessionEngine({
        store: this.sessionStore,
        workspaceRoot: this.workspaceRoot,
      });
  }

  /**
   * Sanitizes and validates scope paths.
   * Prohibits path traversal (..) and absolute paths.
   */
  canonicalizeScopePaths(
    rawPaths?: readonly string[],
    scopeName = 'scope'
  ): readonly string[] | undefined {
    if (rawPaths === undefined) {
      return undefined;
    }
    if (rawPaths.length === 0) {
      return Object.freeze([]);
    }

    const normalizedSet = new Set<string>();

    for (const raw of rawPaths) {
      if (typeof raw !== 'string') {
        throw new TaskDecompositionInvalidScopeError(
          `Scope path in ${scopeName} must be a string, got ${typeof raw}`,
          { [scopeName]: raw }
        );
      }

      const posixPath = raw.replace(/\\/g, '/').trim();
      if (posixPath.length === 0) {
        throw new TaskDecompositionInvalidScopeError(
          `Scope path in ${scopeName} cannot be empty or whitespace only`,
          { [scopeName]: raw }
        );
      }

      const segments = posixPath.split('/');
      if (segments.includes('..')) {
        throw new TaskDecompositionInvalidScopeError(
          `Path traversal ('..') is strictly prohibited in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      if (
        posixPath.startsWith('/') ||
        /^[a-zA-Z]:/.test(posixPath) ||
        posixPath.startsWith('//')
      ) {
        throw new TaskDecompositionInvalidScopeError(
          `Absolute paths are strictly prohibited in ${scopeName}: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      const cleanPath = posixPath.replace(/^\.\//, '');
      if (cleanPath.length === 0) {
        throw new TaskDecompositionInvalidScopeError(
          `Scope path in ${scopeName} resolved to empty after normalization: '${raw}'`,
          { [scopeName]: raw }
        );
      }

      normalizedSet.add(cleanPath);
    }

    const sorted = Array.from(normalizedSet).sort();
    return Object.freeze(sorted);
  }

  /**
   * Generates a deterministic, stable task ID.
   * Format: TASK-P{decompRev}-{featureIndex}-{slug}
   */
  generateDeterministicTaskId(
    featureId: string,
    index: number,
    semanticKey?: string,
    decompositionRevision = 1
  ): string {
    const cleanFeature = featureId
      .replace(/^(FEAT-|FEATURE-|EPIC-)/i, '')
      .replace(/[^a-zA-Z0-9]/g, '-')
      .toUpperCase();

    let slug = '';
    const stepNum = String(index + 1).padStart(2, '0');
    if (semanticKey && semanticKey.trim().length > 0) {
      const cleanKey = semanticKey
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 24)
        .toUpperCase();
      slug = `STEP-${stepNum}-${cleanKey}`;
    } else {
      slug = `STEP-${stepNum}`;
    }

    return `TASK-P${decompositionRevision}-${cleanFeature}-${slug}`;
  }

  /**
   * Transforms an approved development plan (and optional Director candidate proposals)
   * into validated, persisted TaskDefinition[] in SpecStore.
   */
  async decomposePlan(input: DecomposePlanInput): Promise<DecomposePlanResult> {
    // 1. Validate input schema
    const parsedInput = DecomposePlanInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new TaskDecompositionValidationError(
        `Invalid decomposition input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    const targetRoot = input.workspaceRoot ?? this.workspaceRoot ?? process.cwd();
    const canonical = resolveCanonicalProjectIdentity(targetRoot);

    if (input.projectId !== undefined && input.projectId !== null) {
      const trimmed = input.projectId.trim();
      if (trimmed.length > 0 && trimmed !== canonical.projectId) {
        throw new TaskDecompositionProjectBindingMismatchError(
          `Specified projectId '${trimmed}' does not match canonical project '${canonical.projectId}' at '${canonical.projectRoot}'. Accidental cross-project decomposition rejected.`,
          {
            specifiedProjectId: trimmed,
            canonicalProjectId: canonical.projectId,
            canonicalProjectRoot: canonical.projectRoot,
          }
        );
      }
    }

    // 2. Validate Director Session
    let session;
    try {
      session = await this.sessionEngine.getSession(input.directorSessionId, {
        workspaceRoot: targetRoot,
        projectId: canonical.projectId,
      });
    } catch (err) {
      throw new TaskDecompositionSessionBindingMismatchError(
        `Failed to resolve Director session '${input.directorSessionId}': ${err instanceof Error ? err.message : String(err)}`,
        { directorSessionId: input.directorSessionId }
      );
    }

    if (session.status !== 'ACTIVE') {
      throw new TaskDecompositionSessionBindingMismatchError(
        `Director session '${session.directorSessionId}' is ${session.status}. Decomposition requires an ACTIVE Director session.`,
        { directorSessionId: session.directorSessionId, status: session.status }
      );
    }

    validateProjectBinding(session, {
      workspaceRoot: targetRoot,
      projectId: canonical.projectId,
    });

    // 3. Validate Context Snapshot Freshness & Completeness
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(session.directorSessionId);
    if (!latestSnapshot) {
      throw new TaskDecompositionContextMismatchError(
        `No context snapshot found for session '${session.directorSessionId}'. Context synchronization must precede decomposition.`,
        { directorSessionId: session.directorSessionId }
      );
    }

    if (latestSnapshot.logicalFingerprint !== input.contextFingerprint) {
      throw new TaskDecompositionContextMismatchError(
        `Context fingerprint mismatch: request specifies '${input.contextFingerprint}', but authoritative snapshot fingerprint is '${latestSnapshot.logicalFingerprint}'. Context has changed; resynchronization required.`,
        {
          specifiedFingerprint: input.contextFingerprint,
          authoritativeFingerprint: latestSnapshot.logicalFingerprint,
        }
      );
    }

    if (latestSnapshot.syncStatus === 'STALE' || latestSnapshot.staleSections.length > 0) {
      throw new TaskDecompositionContextStaleError(
        `Context snapshot is stale (stale sections: ${latestSnapshot.staleSections.join(', ')}). Decomposition cannot proceed on a stale context snapshot.`,
        { staleSections: latestSnapshot.staleSections }
      );
    }

    if (
      latestSnapshot.syncStatus === 'INCOMPLETE' ||
      !latestSnapshot.isComplete ||
      latestSnapshot.unavailableSections.length > 0
    ) {
      throw new TaskDecompositionContextIncompleteError(
        `Context snapshot is incomplete (unavailable sections: ${latestSnapshot.unavailableSections.join(', ')}). Decomposition cannot proceed on an incomplete context snapshot.`,
        { unavailableSections: latestSnapshot.unavailableSections }
      );
    }

    // 4. Validate Understanding Revision
    if (session.understandingRevision !== null && session.understandingRevision !== undefined) {
      if (
        input.understandingRevision !== undefined &&
        input.understandingRevision !== null &&
        input.understandingRevision !== session.understandingRevision
      ) {
        throw new TaskDecompositionApprovalRevisionMismatchError(
          `Understanding revision mismatch: request specifies ${input.understandingRevision}, but session understanding revision is ${session.understandingRevision}.`,
          {
            specifiedUnderstandingRevision: input.understandingRevision,
            sessionUnderstandingRevision: session.understandingRevision,
          }
        );
      }
    }

    // 5. Validate Product Owner Approval & Development Authorization
    const pkg = await this.approvalStore.getActivePackage();
    if (!pkg) {
      throw new TaskDecompositionApprovalRequiredError(
        'No approval package found. Task decomposition cannot proceed without explicit Product Owner approval.'
      );
    }

    if (pkg.packageId !== input.approvalPackageId) {
      throw new TaskDecompositionApprovalRevisionMismatchError(
        `Approval package mismatch: request specifies packageId '${input.approvalPackageId}', but active approval package is '${pkg.packageId}'.`,
        {
          specifiedPackageId: input.approvalPackageId,
          activePackageId: pkg.packageId,
        }
      );
    }

    if (pkg.projectId !== canonical.projectId) {
      throw new TaskDecompositionProjectBindingMismatchError(
        `Approval package '${pkg.packageId}' belongs to project '${pkg.projectId}', not canonical project '${canonical.projectId}'.`,
        { packageProjectId: pkg.projectId, canonicalProjectId: canonical.projectId }
      );
    }

    if (pkg.status !== 'APPROVED' || !pkg.approvalRecord) {
      throw new TaskDecompositionApprovalRequiredError(
        `Package '${pkg.packageId}' is in status '${pkg.status}'. Decomposition requires an APPROVED package with a valid approval record.`,
        { packageId: pkg.packageId, status: pkg.status }
      );
    }

    if (input.approvalPackageRevision !== pkg.revision) {
      throw new TaskDecompositionApprovalRevisionMismatchError(
        `Approval revision mismatch: request specifies revision ${input.approvalPackageRevision}, but active approved package revision is ${pkg.revision}.`,
        {
          specifiedRevision: input.approvalPackageRevision,
          activePackageRevision: pkg.revision,
        }
      );
    }

    const isAuthorized = this.approvalPackageEngine.isDevelopmentAuthorized(pkg);
    if (!isAuthorized) {
      throw new TaskDecompositionApprovalRequiredError(
        'Development is not authorized under authoritative isDevelopmentAuthorized() boundary.'
      );
    }

    // 6. Generate Candidate Task Graph
    const decompositionRevision = input.decompositionRevision ?? 1;
    const candidateTasks = this.generateCandidateTasks(
      pkg,
      input.candidateTasks,
      canonical.projectId,
      session.directorSessionId,
      latestSnapshot.logicalFingerprint,
      decompositionRevision
    );

    // 7. Validate Task Definitions & Graph via TaskDagEngine
    const parentNodes = this.extractParentNodes(pkg);
    const validFeatureIds = new Set(parentNodes.map((p) => p.task_id));

    let validatedTasks: TaskDefinition[];
    let topologicalOrder: string[];
    try {
      validatedTasks = this.dagEngine.assertValidGraph(candidateTasks, {
        parentNodes,
        validFeatureIds,
      });
      topologicalOrder = this.dagEngine.topologicalSort(candidateTasks, {
        parentNodes,
        validFeatureIds,
      });
    } catch (err) {
      if (err instanceof TaskGraphValidationError) {
        throw new TaskDecompositionInvalidGraphError(err.message, {
          category: err.category,
          taskId: err.taskId,
          details: err.details,
        });
      }
      throw err;
    }

    // 8. Idempotency Check Against Existing SpecStore Tasks
    const existingTasks = await this.specStore.loadTasks().catch(() => []);
    const idempotency = this.checkIdempotency(existingTasks, validatedTasks);

    if (idempotency.hasConflict) {
      throw new TaskDecompositionConflictError(idempotency.conflictReason!, {
        conflictingTaskId: idempotency.conflictingTaskId,
      });
    }

    if (idempotency.isIdenticalReplay) {
      return {
        isSuccess: true,
        projectId: canonical.projectId,
        approvalPackageId: pkg.packageId,
        approvalPackageRevision: pkg.revision,
        contextFingerprint: latestSnapshot.logicalFingerprint,
        decompositionRevision,
        tasksCreated: existingTasks,
        isIdempotentReplay: true,
        topologicalOrder,
        message: 'Task graph already ingested with identical definitions. Idempotent replay successful.',
      };
    }

    // 9. Atomic Persistence to SpecStore
    await this.specStore.saveTasks(validatedTasks);

    // 10. Audit Event Logging via HistoryManager
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'TASK_DECOMPOSITION_INGESTED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: canonical.projectId,
            directorSessionId: session.directorSessionId,
            approvalPackageId: pkg.packageId,
            approvalPackageRevision: pkg.revision,
            contextFingerprint: latestSnapshot.logicalFingerprint,
            decompositionRevision,
            taskCount: validatedTasks.length,
            taskIds: validatedTasks.map((t) => t.task_id),
            topologicalOrder,
          },
        });
      } catch {
        // Non-blocking audit logging
      }
    }

    return {
      isSuccess: true,
      projectId: canonical.projectId,
      approvalPackageId: pkg.packageId,
      approvalPackageRevision: pkg.revision,
      contextFingerprint: latestSnapshot.logicalFingerprint,
      decompositionRevision,
      tasksCreated: validatedTasks,
      isIdempotentReplay: false,
      topologicalOrder,
      message: `Successfully ingested ${validatedTasks.length} tasks into SpecStore under approved package '${pkg.packageId}'.`,
    };
  }

  /**
   * Extracts parent Feature / Epic nodes from the approved package.
   */
  private extractParentNodes(pkg: ProjectApprovalPackage): TaskDefinition[] {
    const parentNodes: TaskDefinition[] = [];
    const groups = pkg.proposedDevelopmentPlan.proposedFeatureGroups ?? [];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const featId = `FEAT-${g.name.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`;
      parentNodes.push({
        task_id: featId,
        parent_feature_id: 'ROOT',
        title: g.name,
        description: g.description,
        traceability_sources: ['REQ:APPROVED_DEVELOPMENT_PLAN'],
        dependencies: [],
        acceptance_criteria: ['Feature capabilities completed and verified'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'MEDIUM',
        risk_level: 'SAFE',
        created_at: pkg.createdAt,
        started_at: null,
        completed_at: null,
        hierarchy_level: 'FEATURE',
      });
    }

    // Default core feature if none defined
    if (parentNodes.length === 0) {
      parentNodes.push({
        task_id: 'FEAT-CORE-DEVELOPMENT',
        parent_feature_id: 'ROOT',
        title: 'Core Development',
        description: 'Core project capabilities from approved plan',
        traceability_sources: ['REQ:APPROVED_DEVELOPMENT_PLAN'],
        dependencies: [],
        acceptance_criteria: ['Core capabilities implemented'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'MEDIUM',
        risk_level: 'SAFE',
        created_at: pkg.createdAt,
        started_at: null,
        completed_at: null,
        hierarchy_level: 'FEATURE',
      });
    }

    return parentNodes;
  }

  /**
   * Generates candidate tasks from either Director proposals or the approved plan.
   */
  private generateCandidateTasks(
    pkg: ProjectApprovalPackage,
    candidateProposals: readonly CandidateTaskProposal[] | undefined,
    projectId: string,
    directorSessionId: string,
    contextFingerprint: string,
    decompositionRevision: number
  ): TaskDefinition[] {
    const parentNodes = this.extractParentNodes(pkg);
    const primaryFeatureId = parentNodes[0].task_id;
    const now = new Date().toISOString();

    const confirmedReqIds = (pkg.projectUnderstanding.confirmedRequirements ?? []).map((r) => r.sourceReferenceId ?? r.id);
    const defaultTraceability = confirmedReqIds.length > 0
      ? confirmedReqIds.map((id) => (id.startsWith('REQ') ? id : `REQ:${id}`))
      : ['REQ:APPROVED_PLAN'];

    // CASE A: Caller/Director provided explicit candidate proposals
    if (candidateProposals && candidateProposals.length > 0) {
      const generated: TaskDefinition[] = [];

      for (let i = 0; i < candidateProposals.length; i++) {
        const prop = candidateProposals[i];

        // 1. Parent Feature mapping
        const parentId = prop.parentFeatureId && prop.parentFeatureId.trim().length > 0
          ? prop.parentFeatureId.trim()
          : primaryFeatureId;

        // Verify parent is within approved feature groups
        const isApprovedParent = parentNodes.some((p) => p.task_id === parentId);
        if (!isApprovedParent) {
          throw new TaskDecompositionOutOfScopeError(
            `Task '${prop.title}' references parentFeatureId '${parentId}', which is not an approved feature in this project plan.`,
            { parentFeatureId: parentId, approvedParents: parentNodes.map((p) => p.task_id) }
          );
        }

        // 2. Deterministic Task ID
        const taskId = prop.taskId && prop.taskId.trim().length > 0
          ? prop.taskId.trim()
          : this.generateDeterministicTaskId(parentId, i, prop.semanticKey, decompositionRevision);

        // 3. Traceability Validation
        let traceability = prop.traceabilitySources ? [...prop.traceabilitySources] : [...defaultTraceability];
        if (traceability.length === 0) {
          throw new TaskDecompositionInvalidTraceabilityError(
            `Task '${taskId}' must have at least one traceability source.`,
            { taskId }
          );
        }

        // 4. Acceptance Criteria Validation
        const acceptanceCriteria = prop.acceptanceCriteria && prop.acceptanceCriteria.length > 0
          ? [...prop.acceptanceCriteria]
          : [`Verify implementation of ${prop.title}`];

        // 5. Scope Validation & Normalization
        let canonicalScope: CandidateTaskScope | undefined = undefined;
        if (prop.scope) {
          const analysisScope = this.canonicalizeScopePaths(prop.scope.analysisScope, 'analysisScope');
          const implementationScope = this.canonicalizeScopePaths(prop.scope.implementationScope, 'implementationScope');
          const targetFiles = this.canonicalizeScopePaths(prop.scope.targetFiles, 'targetFiles');
          canonicalScope = {
            ...(analysisScope !== undefined ? { analysisScope } : {}),
            ...(implementationScope !== undefined ? { implementationScope } : {}),
            ...(targetFiles !== undefined ? { targetFiles } : {}),
          };
        }

        // 6. Metadata formulation
        const metadata: Record<string, unknown> = {
          revision: 1,
          approvalPackageId: pkg.packageId,
          approvalPackageRevision: pkg.revision,
          directorSessionId,
          contextFingerprint,
          decompositionRevision,
          projectId,
          ...(canonicalScope ? { scope: canonicalScope } : {}),
          ...(prop.metadata ?? {}),
        };

        generated.push({
          task_id: taskId,
          parent_feature_id: parentId,
          title: prop.title,
          description: prop.description,
          traceability_sources: traceability,
          dependencies: prop.dependencies ? [...prop.dependencies] : [],
          acceptance_criteria: acceptanceCriteria,
          status: 'READY',
          attempt: 0,
          max_attempts: 3,
          priority: prop.priority ?? 'MEDIUM',
          risk_level: prop.riskLevel ?? 'SAFE',
          created_at: now,
          started_at: null,
          completed_at: null,
          hierarchy_level: prop.hierarchyLevel ?? 'TASK',
          metadata,
        });
      }

      return generated;
    }

    // CASE B: Default Decomposition directly from approved ProposedDevelopmentPlan
    const plan = pkg.proposedDevelopmentPlan;
    const generated: TaskDefinition[] = [];
    let taskCounter = 0;

    for (let fIdx = 0; fIdx < parentNodes.length; fIdx++) {
      const featNode = parentNodes[fIdx];
      const group = plan.proposedFeatureGroups[fIdx];
      const capabilities = group?.targetCapabilities && group.targetCapabilities.length > 0
        ? group.targetCapabilities
        : plan.proposedScope;

      for (let cIdx = 0; cIdx < capabilities.length; cIdx++) {
        const capability = capabilities[cIdx];
        const taskId = this.generateDeterministicTaskId(
          featNode.task_id,
          taskCounter,
          capability,
          decompositionRevision
        );

        // Previous task within same feature forms sequential dependency
        const dependencies: string[] = [];
        if (taskCounter > 0) {
          dependencies.push(generated[taskCounter - 1].task_id);
        }

        const metadata: Record<string, unknown> = {
          revision: 1,
          approvalPackageId: pkg.packageId,
          approvalPackageRevision: pkg.revision,
          directorSessionId,
          contextFingerprint,
          decompositionRevision,
          projectId,
        };

        generated.push({
          task_id: taskId,
          parent_feature_id: featNode.task_id,
          title: `Implement ${capability}`,
          description: `Deliver target capability '${capability}' under feature '${featNode.title}'.`,
          traceability_sources: defaultTraceability,
          dependencies,
          acceptance_criteria: [
            `Capability '${capability}' is fully implemented and passes test verification.`,
          ],
          status: 'READY',
          attempt: 0,
          max_attempts: 3,
          priority: 'MEDIUM',
          risk_level: 'SAFE',
          created_at: now,
          started_at: null,
          completed_at: null,
          hierarchy_level: 'TASK',
          metadata,
        });

        taskCounter++;
      }
    }

    return generated;
  }

  /**
   * Compares existing tasks in SpecStore against newly generated tasks for idempotency.
   */
  private checkIdempotency(
    existing: readonly TaskDefinition[],
    incoming: readonly TaskDefinition[]
  ): {
    isIdenticalReplay: boolean;
    hasConflict: boolean;
    conflictingTaskId?: string;
    conflictReason?: string;
  } {
    if (existing.length === 0) {
      return { isIdenticalReplay: false, hasConflict: false };
    }

    // Check if incoming IDs exist and whether definitions match
    const existingMap = new Map<string, TaskDefinition>();
    for (const t of existing) {
      existingMap.set(t.task_id, t);
    }

    let allMatched = true;

    for (const inTask of incoming) {
      const exTask = existingMap.get(inTask.task_id);
      if (!exTask) {
        allMatched = false;
        continue;
      }

      // Check for incompatible conflict
      if (exTask.parent_feature_id !== inTask.parent_feature_id) {
        return {
          isIdenticalReplay: false,
          hasConflict: true,
          conflictingTaskId: inTask.task_id,
          conflictReason: `Task '${inTask.task_id}' already exists in SpecStore with different parent_feature_id ('${exTask.parent_feature_id}' vs incoming '${inTask.parent_feature_id}').`,
        };
      }

      const inRev = (inTask.metadata?.revision as number) ?? 1;
      const exRev = (exTask.metadata?.revision as number) ?? 1;
      if (inRev !== exRev) {
        return {
          isIdenticalReplay: false,
          hasConflict: true,
          conflictingTaskId: inTask.task_id,
          conflictReason: `Task '${inTask.task_id}' already exists in SpecStore with different revision (${exRev} vs incoming ${inRev}).`,
        };
      }

      const inAppRev = (inTask.metadata?.approvalPackageRevision as number) ?? null;
      const exAppRev = (exTask.metadata?.approvalPackageRevision as number) ?? null;
      if (inAppRev !== exAppRev) {
        return {
          isIdenticalReplay: false,
          hasConflict: true,
          conflictingTaskId: inTask.task_id,
          conflictReason: `Task '${inTask.task_id}' is bound to approvalPackageRevision ${exAppRev}, incoming references ${inAppRev}.`,
        };
      }
    }

    if (allMatched && existing.length === incoming.length) {
      return { isIdenticalReplay: true, hasConflict: false };
    }

    return { isIdenticalReplay: false, hasConflict: false };
  }
}
