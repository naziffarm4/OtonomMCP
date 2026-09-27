/**
 * P12-04 — Static Plan Decomposition Verification / End-to-End Acceptance Test Suite
 *
 * Verifies the complete authoritative flow:
 * Product Owner Approved Project
 *         ↓
 * Approved Project Plan
 *         ↓
 * Active Director Session + Context
 *         ↓
 * Development Authorization
 *         ↓
 * TaskDecompositionEngine
 *         ↓
 * TaskDefinition[]
 *         ↓
 * SpecStore
 *         ↓
 * TaskDagEngine
 *         ↓
 * READY tasks
 *         ↓
 * DirectorContextSynchronizer
 *         ↓
 * Director Context Snapshot
 *
 * All 25 required test cases (T01 - T25) implemented deterministically.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  Actor,
  DurableStateManager,
  SpecStore,
  TaskDagEngine,
  HistoryManager,
  ApprovalStore,
  ApprovalPackageEngine,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorContextSynchronizer,
  TaskDecompositionEngine,
  type ProjectApprovalPackage,
  type InitialProjectUnderstanding,
  type ProposedDevelopmentPlan,
  type TaskDefinition,
  TaskDefinitionZodSchema,
  TaskDecompositionApprovalRequiredError,
  TaskDecompositionApprovalRevisionMismatchError,
  TaskDecompositionProjectBindingMismatchError,
  TaskDecompositionSessionBindingMismatchError,
  TaskDecompositionContextMismatchError,
  TaskDecompositionInvalidGraphError,
  TaskDecompositionInvalidScopeError,
  TaskDecompositionConflictError,
  TaskDecompositionOutOfScopeError,
} from '../dist/index.js';

describe('P12-04: Static Plan Decomposition Verification / End-to-End Acceptance', () => {
  let testDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let approvalStore: ApprovalStore;
  let approvalEngine: ApprovalPackageEngine;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let durableStateManager: DurableStateManager;
  let synchronizer: DirectorContextSynchronizer;
  let decompositionEngine: TaskDecompositionEngine;

  let activeSessionId: string;
  let canonicalProjectId: string;
  let approvedPackage: ProjectApprovalPackage;
  let contextFingerprint: string;

  /**
   * Helper to set up an isolated project environment with an active session,
   * approved project package, and synchronized context snapshot.
   */
  async function setupProjectEnvironment(dir: string, customPackageId = 'pkg-p1204-test') {
    fs.mkdirSync(path.join(dir, '.ai-manager', 'spec'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.ai-manager', 'approval'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.ai-manager', 'director'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.ai-manager', 'history'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.ai-manager', 'state'), { recursive: true });

    const hist = new HistoryManager({ baseDir: dir });
    const spec = new SpecStore({ baseDir: dir });
    const dag = new TaskDagEngine();
    const appStore = new ApprovalStore({ baseDir: dir, historyManager: hist });
    const appEng = new ApprovalPackageEngine();
    const sessStore = new DirectorSessionStore({ baseDir: dir, historyManager: hist });
    const sessEng = new DirectorSessionEngine({ store: sessStore, workspaceRoot: dir });

    const dState = new DurableStateManager({ baseDir: dir });
    await dState.save({
      schemaVersion: 1,
      currentLifecycleState: 'INITIALIZING',
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
      updatedAt: new Date().toISOString(),
    });

    const sync = new DirectorContextSynchronizer({
      workspaceRoot: dir,
      sessionEngine: sessEng,
      sessionStore: sessStore,
    });

    const decomp = new TaskDecompositionEngine({
      workspaceRoot: dir,
      specStore: spec,
      dagEngine: dag,
      approvalStore: appStore,
      approvalPackageEngine: appEng,
      sessionStore: sessStore,
      sessionEngine: sessEng,
      historyManager: hist,
    });

    const session = await sessEng.createSession({
      workspaceRoot: dir,
      actor: Actor.DIRECTOR,
      actorRole: 'DIRECTOR',
      approvalPackageId: customPackageId,
      approvalRevision: 1,
      understandingRevision: 1,
    });

    const understanding: InitialProjectUnderstanding = {
      projectId: session.projectId,
      projectName: 'P1204VerificationProject',
      apparentPurpose: {
        summary: 'P12-04 E2E Acceptance Project',
        classification: 'APPLICATION',
        evidence: [],
      },
      targetUsers: ['QA Engineers', 'Product Owners'],
      technologyStack: { primaryLanguages: ['TypeScript'] },
      architectureSummary: { pattern: 'Modular Clean Architecture' },
      existingCapabilities: [],
      confirmedRequirements: [
        {
          id: 'REQ-001',
          type: 'CONFIRMED_FACT',
          origin: 'EXISTING_REQUIREMENT',
          statement: 'Deterministic plan decomposition to SpecStore tasks',
          evidence: [],
          sourceReferenceId: 'REQ-001',
        },
        {
          id: 'REQ-002',
          type: 'CONFIRMED_FACT',
          origin: 'EXISTING_REQUIREMENT',
          statement: 'Full DAG integrity and Director context synchronization',
          evidence: [],
          sourceReferenceId: 'REQ-002',
        },
      ],
      clarifiedRequirements: [],
      unresolvedUnknowns: [],
      unresolvedContradictions: [],
      currentImplementationState: { state: 'Verified' },
      constraints: ['POSIX relative paths only', 'No autonomous execution'],
      assumptions: [],
      nonGoals: ['Runtime task execution', 'Continuation triggering'],
      proposedDevelopmentScope: ['Decomposition', 'SpecStore Persistence'],
      evidenceReferences: [],
      sourceDiscoveryReference: 'discovery-p1204',
      generatedAt: '2026-09-27T00:00:00.000Z',
    };

    const proposedPlan: ProposedDevelopmentPlan = {
      objectives: ['Decompose approved plan', 'Persist static DAG', 'Sync Director context'],
      proposedScope: ['Core Ingestion', 'DAG Engine'],
      proposedFeatureGroups: [
        {
          name: 'Core Ingestion Feature',
          description: 'Handles transformation from approved plan to tasks',
          targetCapabilities: ['Decompose Plan', 'Persist Tasks', 'Validate DAG'],
        },
      ],
      dependencies: [],
      constraints: ['POSIX paths only'],
      knownRisks: [],
      unresolvedIssues: [],
      excludedScope: ['legacy', 'secret'],
      suggestedImplementationOrder: ['Decompose Plan', 'Persist Tasks', 'Validate DAG'],
    };

    const unapprovedPkg = appEng.buildPackage(understanding, proposedPlan, {
      packageId: customPackageId,
    });

    const approved = appEng.approvePackage(unapprovedPkg, {
      packageId: unapprovedPkg.packageId,
      revision: 1,
      actor: 'ProductOwner',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved by Product Owner for P12-04 verification',
    });

    await appStore.savePackage(approved);

    const snapshot = await sync.synchronize({
      directorSessionId: session.directorSessionId,
      workspaceRoot: dir,
      projectId: session.projectId,
    });

    return {
      dir,
      historyManager: hist,
      specStore: spec,
      dagEngine: dag,
      approvalStore: appStore,
      approvalEngine: appEng,
      sessionStore: sessStore,
      sessionEngine: sessEng,
      durableStateManager: dState,
      synchronizer: sync,
      decompositionEngine: decomp,
      session,
      approvedPackage: approved,
      contextFingerprint: snapshot.logicalFingerprint,
    };
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p1204-e2e-'));
    const env = await setupProjectEnvironment(testDir);
    historyManager = env.historyManager;
    specStore = env.specStore;
    dagEngine = env.dagEngine;
    approvalStore = env.approvalStore;
    approvalEngine = env.approvalEngine;
    sessionStore = env.sessionStore;
    sessionEngine = env.sessionEngine;
    durableStateManager = env.durableStateManager;
    synchronizer = env.synchronizer;
    decompositionEngine = env.decompositionEngine;

    activeSessionId = env.session.directorSessionId;
    canonicalProjectId = env.session.projectId;
    approvedPackage = env.approvedPackage;
    contextFingerprint = env.contextFingerprint;
  });

  afterEach(() => {
    if (testDir) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // ==========================================================================
  // T01 — Full approved-plan-to-task pipeline
  // ==========================================================================
  it('T01 — Full approved-plan-to-task pipeline succeeds and persists valid tasks into SpecStore', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    assert.equal(result.isSuccess, true);
    assert.equal(result.isIdempotentReplay, false);
    assert.equal(result.approvalPackageId, approvedPackage.packageId);
    assert.equal(result.approvalPackageRevision, 1);
    assert.equal(result.tasksCreated.length, 3);
    assert.ok(result.topologicalOrder.length >= 3);

    // Verify tasks are persisted in SpecStore
    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 3);
    assert.deepEqual(
      loaded.map((t) => t.task_id),
      result.tasksCreated.map((t) => t.task_id)
    );

    // Verify DAG engine accepts persisted graph
    const validGraph = dagEngine.assertValidGraph(loaded, {
      parentNodes: [
        {
          task_id: 'FEAT-CORE-INGESTION-FEATURE',
          parent_feature_id: 'ROOT',
          title: 'Core Ingestion Feature',
          description: 'Feature parent',
          traceability_sources: ['REQ:APPROVED_DEVELOPMENT_PLAN'],
          dependencies: [],
          acceptance_criteria: ['Done'],
          status: 'READY',
          attempt: 0,
          max_attempts: 3,
          priority: 'MEDIUM',
          risk_level: 'SAFE',
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          hierarchy_level: 'FEATURE',
        },
      ],
      validFeatureIds: new Set(['FEAT-CORE-INGESTION-FEATURE']),
    });
    assert.equal(validGraph.length, 3);
  });

  // ==========================================================================
  // T02 — Product Owner approval is required
  // ==========================================================================
  it('T02 — Product Owner approval is required: unapproved package rejected with zero SpecStore mutation', async () => {
    // Save an unapproved package (status DRAFT / READY_FOR_APPROVAL)
    const unapproved = approvalEngine.buildPackage(
      approvedPackage.projectUnderstanding,
      approvedPackage.proposedDevelopmentPlan,
      { packageId: 'pkg-unapproved-test' }
    );
    await approvalStore.savePackage(unapproved);

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-unapproved-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionApprovalRequiredError
    );

    // Assert no tasks were persisted
    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T03 — Project binding is enforced
  // ==========================================================================
  it('T03 — Project binding is enforced: mismatched projectId rejected deterministically', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        projectId: 'foreign-project-id-999',
      }),
      TaskDecompositionProjectBindingMismatchError
    );

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T04 — Director session binding is enforced
  // ==========================================================================
  it('T04 — Director session binding is enforced: non-existent or inactive session rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: 'non-existent-session-id',
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
      }),
      TaskDecompositionSessionBindingMismatchError
    );

    // Also verify closed session rejected
    await sessionEngine.closeSession({
      directorSessionId: activeSessionId,
      reason: 'Testing closed session enforcement',
      closedBy: Actor.DIRECTOR,
    });

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
      }),
      TaskDecompositionSessionBindingMismatchError
    );

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T05 — Context fingerprint binding is enforced
  // ==========================================================================
  it('T05 — Context fingerprint binding is enforced: stale/mismatched fingerprint rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint: 'invalid-or-stale-fingerprint-000',
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
      }),
      TaskDecompositionContextMismatchError
    );

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T06 — Approval revision binding is enforced
  // ==========================================================================
  it('T06 — Approval revision binding is enforced: obsolete revision rejected with zero ingestion', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: 999, // active is 1
      }),
      TaskDecompositionApprovalRevisionMismatchError
    );

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T07 — Generated tasks satisfy TaskDefinition schema
  // ==========================================================================
  it('T07 — Generated tasks satisfy authoritative TaskDefinition schema', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    for (const task of result.tasksCreated) {
      // Validate with authoritative Zod schema
      const parseResult = TaskDefinitionZodSchema.safeParse(task);
      assert.equal(parseResult.success, true, `Task schema validation failed for ${task.task_id}`);

      // Verify explicit required fields
      assert.ok(task.task_id.length > 0);
      assert.ok(task.parent_feature_id.length > 0);
      assert.ok(task.title.length > 0);
      assert.ok(task.description.length > 0);
      assert.equal(task.status, 'READY');
      assert.ok(task.acceptance_criteria.length > 0);
      assert.ok(task.traceability_sources.length > 0);
      assert.equal(task.hierarchy_level, 'TASK');
      assert.equal(task.priority, 'MEDIUM');
      assert.equal(task.risk_level, 'SAFE');
      assert.equal(task.attempt, 0);
      assert.equal(task.max_attempts, 3);
      assert.equal(task.started_at, null);
      assert.equal(task.completed_at, null);

      // Verify metadata bindings
      assert.equal(task.metadata?.approvalPackageId, approvedPackage.packageId);
      assert.equal(task.metadata?.approvalPackageRevision, 1);
      assert.equal(task.metadata?.directorSessionId, activeSessionId);
      assert.equal(task.metadata?.contextFingerprint, contextFingerprint);
      assert.equal(task.metadata?.projectId, canonicalProjectId);
    }
  });

  // ==========================================================================
  // T08 — Traceability survives ingestion
  // ==========================================================================
  it('T08 — Traceability survives ingestion: requirement relationships and approval bindings preserved', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, result.tasksCreated.length);

    for (const task of loaded) {
      assert.ok(task.traceability_sources.length >= 2);
      assert.ok(task.traceability_sources.includes('REQ-001'));
      assert.ok(task.traceability_sources.includes('REQ-002'));
      assert.equal(task.metadata?.approvalPackageId, approvedPackage.packageId);
      assert.equal(task.metadata?.approvalPackageRevision, 1);
      assert.equal(task.metadata?.directorSessionId, activeSessionId);
    }
  });

  // ==========================================================================
  // T09 — Deterministic task identity
  // ==========================================================================
  it('T09 — Deterministic task identity: multiple runs produce identical IDs and task graphs', async () => {
    const result1 = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const result2 = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    assert.equal(result2.isIdempotentReplay, true);
    assert.deepEqual(
      result1.tasksCreated.map((t) => t.task_id),
      result2.tasksCreated.map((t) => t.task_id)
    );
    assert.deepEqual(result1.topologicalOrder, result2.topologicalOrder);

    // Verify IDs follow deterministic format: TASK-{FEATURE}-STEP-{NN}-{SLUG}-{HASH}
    for (const task of result1.tasksCreated) {
      assert.match(task.task_id, /^TASK-CORE-INGESTION-FEATURE-STEP-\d{2}-[A-Z0-9-]+-[A-F0-9]{6}$/);
    }
  });

  // ==========================================================================
  // T10 — Idempotent persistence
  // ==========================================================================
  it('T10 — Idempotent persistence: repeated execution causes no duplication or corruption', async () => {
    const r1 = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });
    assert.equal(r1.isIdempotentReplay, false);

    const r2 = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });
    assert.equal(r2.isIdempotentReplay, true);

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 3);
    assert.deepEqual(
      loaded.map((t) => t.task_id),
      r1.tasksCreated.map((t) => t.task_id)
    );
  });

  // ==========================================================================
  // T11 — DAG integrity
  // ==========================================================================
  it('T11 — DAG integrity: TaskDagEngine accepts valid multi-task dependency graph', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const loaded = await specStore.loadTasks();
    // In sequential default decomposition: task 0 has 0 deps, task 1 depends on task 0, task 2 depends on task 1
    assert.equal(loaded[0].dependencies.length, 0);
    assert.deepEqual(loaded[1].dependencies, [loaded[0].task_id]);
    assert.deepEqual(loaded[2].dependencies, [loaded[1].task_id]);

    const order = dagEngine.topologicalSort(loaded, {
      parentNodes: [
        {
          task_id: 'FEAT-CORE-INGESTION-FEATURE',
          parent_feature_id: 'ROOT',
          title: 'Core Ingestion Feature',
          description: 'Parent feature',
          traceability_sources: ['REQ:APPROVED_DEVELOPMENT_PLAN'],
          dependencies: [],
          acceptance_criteria: ['Done'],
          status: 'READY',
          attempt: 0,
          max_attempts: 3,
          priority: 'MEDIUM',
          risk_level: 'SAFE',
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          hierarchy_level: 'FEATURE',
        },
      ],
      validFeatureIds: new Set(['FEAT-CORE-INGESTION-FEATURE']),
    });

    assert.deepEqual(order, [loaded[0].task_id, loaded[1].task_id, loaded[2].task_id]);
  });

  // ==========================================================================
  // T12 — Invalid graph is rejected atomically
  // ==========================================================================
  it('T12 — Invalid graph is rejected atomically: cycle or missing dependency causes zero persistence', async () => {
    // 1. Missing dependency proposal
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        candidateTasks: [
          {
            title: 'Task Alpha',
            description: 'Alpha',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            dependencies: ['TASK-NON-EXISTENT'],
            acceptanceCriteria: ['Valid criteria'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionInvalidGraphError
    );

    let loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);

    // 2. Circular dependency proposal
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        candidateTasks: [
          {
            taskId: 'TASK-CYCLE-1',
            title: 'Cycle Task 1',
            description: 'Cycle 1',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            dependencies: ['TASK-CYCLE-2'],
            acceptanceCriteria: ['Valid criteria'],
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: 'TASK-CYCLE-2',
            title: 'Cycle Task 2',
            description: 'Cycle 2',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            dependencies: ['TASK-CYCLE-1'],
            acceptanceCriteria: ['Valid criteria'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionInvalidGraphError
    );

    loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T13 — Approved scope is preserved
  // ==========================================================================
  it('T13 — Approved scope is preserved: analysisScope, implementationScope, targetFiles correctly mapped', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
      candidateTasks: [
        {
          title: 'Scoped Task Implementation',
          description: 'Implements targeted capability',
          parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
          traceabilitySources: ['REQ:REQ-001'],
          acceptanceCriteria: ['Scope properly preserved'],
          scope: {
            analysisScope: ['packages/core/src', 'packages/core/package.json'],
            implementationScope: ['packages/core/src/task-decomposition'],
            targetFiles: ['packages/core/src/task-decomposition/task-decomposition-engine.ts'],
          },
        },
      ],
    });

    assert.equal(result.isSuccess, true);
    const task = result.tasksCreated[0];
    const taskScope = (task.metadata?.scope as any);

    assert.ok(taskScope);
    assert.deepEqual(taskScope.analysisScope, ['packages/core/package.json', 'packages/core/src']);
    assert.deepEqual(taskScope.implementationScope, ['packages/core/src/task-decomposition']);
    assert.deepEqual(taskScope.targetFiles, [
      'packages/core/src/task-decomposition/task-decomposition-engine.ts',
    ]);

    // Check round-trip from SpecStore
    const loaded = await specStore.loadTasks();
    assert.deepEqual(loaded[0].metadata?.scope, taskScope);
  });

  // ==========================================================================
  // T14 — Scope traversal is rejected
  // ==========================================================================
  it('T14 — Scope traversal is rejected: relative path traversal (..) causes deterministic error and zero persistence', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        candidateTasks: [
          {
            title: 'Traversal Task',
            description: 'Attempts path traversal',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            traceabilitySources: ['REQ:REQ-001'],
            acceptanceCriteria: ['Valid criteria'],
            scope: {
              targetFiles: ['../outside/secret.ts'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T15 — Task outside approved plan is rejected
  // ==========================================================================
  it('T15 — Task outside approved plan is rejected: referencing non-approved feature group or excluded scope', async () => {
    // 1. Unapproved parent feature group
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        candidateTasks: [
          {
            title: 'Out of scope task',
            description: 'Unapproved feature reference',
            parentFeatureId: 'FEAT-UNAPPROVED-FEATURE-GROUP',
            traceabilitySources: ['REQ:REQ-001'],
            acceptanceCriteria: ['Criteria'],
          },
        ],
      }),
      TaskDecompositionOutOfScopeError
    );

    // 2. Targeting explicitly excluded scope in approved plan ('secret/**')
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        candidateTasks: [
          {
            title: 'Excluded scope task',
            description: 'Attempts access to excluded scope',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            traceabilitySources: ['REQ:REQ-001'],
            acceptanceCriteria: ['Criteria'],
            scope: {
              targetFiles: ['secret/api-keys.json'],
            },
          },
        ],
      }),
      TaskDecompositionOutOfScopeError
    );

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 0);
  });

  // ==========================================================================
  // T16 — SpecStore remains sole task authority
  // ==========================================================================
  it('T16 — SpecStore remains sole task authority: tasks are persisted only to SpecStore and loaded authoritatively', async () => {
    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    // Check directly in SpecStore file location (.ai-manager/spec/tasks.json)
    const tasksFilePath = path.join(testDir, '.ai-manager', 'spec', 'tasks.json');
    assert.equal(fs.existsSync(tasksFilePath), true);

    const fileContent = JSON.parse(fs.readFileSync(tasksFilePath, 'utf8'));
    assert.ok(Array.isArray(fileContent));
    assert.equal(fileContent.length, 3);

    // Assert no rogue second store exists
    assert.equal(fs.existsSync(path.join(testDir, '.ai-manager', 'tasks')), false);
    assert.equal(fs.existsSync(path.join(testDir, '.tasks')), false);
  });

  // ==========================================================================
  // T17 — TaskDagEngine remains sole graph authority
  // ==========================================================================
  it('T17 — TaskDagEngine remains sole graph authority: validation, ordering, and cycle detection use TaskDagEngine', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const loaded = await specStore.loadTasks();
    // Validate that dagEngine functions as the authoritative graph validator
    const validationResult = dagEngine.validateGraph(loaded, {
      parentNodes: [
        {
          task_id: 'FEAT-CORE-INGESTION-FEATURE',
          parent_feature_id: 'ROOT',
          title: 'Core Ingestion Feature',
          description: 'Parent feature',
          traceability_sources: ['REQ:APPROVED_DEVELOPMENT_PLAN'],
          dependencies: [],
          acceptance_criteria: ['Done'],
          status: 'READY',
          attempt: 0,
          max_attempts: 3,
          priority: 'MEDIUM',
          risk_level: 'SAFE',
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          hierarchy_level: 'FEATURE',
        },
      ],
      validFeatureIds: new Set(['FEAT-CORE-INGESTION-FEATURE']),
    });

    assert.equal(validationResult.valid, true);
    assert.deepEqual(validationResult.topologicalOrder, result.topologicalOrder);
  });

  // ==========================================================================
  // T18 — Director Context Synchronization
  // ==========================================================================
  it('T18 — Director Context Synchronization: taskListSection reflects newly ingested tasks', async () => {
    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const newSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSessionId,
      workspaceRoot: testDir,
      projectId: canonicalProjectId,
    });

    assert.ok(newSnapshot.sections.taskList);
    assert.equal(newSnapshot.sections.taskList.total, 3);
    assert.equal(newSnapshot.sections.taskList.tasks.length, 3);

    const loaded = await specStore.loadTasks();
    for (let i = 0; i < loaded.length; i++) {
      assert.equal(newSnapshot.sections.taskList.tasks[i].taskId, loaded[i].task_id);
      assert.equal(newSnapshot.sections.taskList.tasks[i].status, 'READY');
      assert.equal(newSnapshot.sections.taskList.tasks[i].title, loaded[i].title);
    }
  });

  // ==========================================================================
  // T19 — Ready task determination
  // ==========================================================================
  it('T19 — Ready task determination: root tasks have satisfied dependencies and are exposed as READY', async () => {
    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const loaded = await specStore.loadTasks();

    // In sequential decomposition:
    // Task 0: dependencies = [] -> immediately READY
    // Task 1: dependencies = [Task 0] -> status READY, waiting for Task 0 ACCEPTED
    const rootTask = loaded.find((t) => t.dependencies.length === 0);
    assert.ok(rootTask);
    assert.equal(rootTask.status, 'READY');

    // Confirm that for execution, root task has no unmet dependencies
    const unmetDeps = rootTask.dependencies.filter((d) => {
      const dep = loaded.find((t) => t.task_id === d);
      return !dep || dep.status !== 'ACCEPTED';
    });
    assert.equal(unmetDeps.length, 0);

    // Dependent task has unmet dependencies until root is completed
    const dependentTask = loaded.find((t) => t.dependencies.length > 0);
    assert.ok(dependentTask);
    const dependentUnmet = dependentTask.dependencies.filter((d) => {
      const dep = loaded.find((t) => t.task_id === d);
      return !dep || dep.status !== 'ACCEPTED';
    });
    assert.ok(dependentUnmet.length > 0);
  });

  // ==========================================================================
  // T20 — Rejection leaves state unchanged
  // ==========================================================================
  it('T20 — Rejection leaves state unchanged: invalid decomposition attempt leaves SpecStore strictly untouched', async () => {
    // 1. Ingest an initial valid task
    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
      candidateTasks: [
        {
          title: 'Initial Valid Task',
          description: 'Pre-existing valid task',
          parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
          traceabilitySources: ['REQ:REQ-001'],
          acceptanceCriteria: ['Initial valid'],
        },
      ],
    });

    const preState = await specStore.loadTasks();
    assert.equal(preState.length, 1);
    const preJson = JSON.stringify(preState);

    // 2. Attempt invalid decomposition with cycle
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
        candidateTasks: [
          {
            taskId: 'TASK-FAIL-1',
            title: 'Fail 1',
            description: 'Fail 1',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            dependencies: ['TASK-FAIL-2'],
            acceptanceCriteria: ['Valid'],
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: 'TASK-FAIL-2',
            title: 'Fail 2',
            description: 'Fail 2',
            parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
            dependencies: ['TASK-FAIL-1'],
            acceptanceCriteria: ['Valid'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionInvalidGraphError
    );

    // 3. Verify post-state is byte/semantic equivalent
    const postState = await specStore.loadTasks();
    assert.equal(postState.length, 1);
    assert.equal(JSON.stringify(postState), preJson);
  });

  // ==========================================================================
  // T21 — Audit history
  // ==========================================================================
  it('T21 — Audit history: records TASK_DECOMPOSITION_INGESTED event in HistoryManager', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const events = await historyManager.readEvents();
    const decompEvent = events.find((e) => e.eventType === 'TASK_DECOMPOSITION_INGESTED');

    assert.ok(decompEvent);
    assert.equal(decompEvent.actor, Actor.DIRECTOR);
    assert.equal(decompEvent.payload.projectId, canonicalProjectId);
    assert.equal(decompEvent.payload.directorSessionId, activeSessionId);
    assert.equal(decompEvent.payload.approvalPackageId, approvedPackage.packageId);
    assert.equal(decompEvent.payload.approvalPackageRevision, 1);
    assert.equal(decompEvent.payload.contextFingerprint, contextFingerprint);
    assert.equal(decompEvent.payload.taskCount, result.tasksCreated.length);
    assert.deepEqual(decompEvent.payload.taskIds, result.tasksCreated.map((t) => t.task_id));
  });

  // ==========================================================================
  // T22 — No execution side effects
  // ==========================================================================
  it('T22 — No execution side effects: decomposition does not advance execution state or execute tasks', async () => {
    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    // Check DurableStateManager execution state
    const dState = await durableStateManager.load();
    assert.ok(dState);
    assert.equal(dState.currentLifecycleState, 'INITIALIZING');
    assert.equal(dState.activeTaskId, null);
    assert.deepEqual(dState.completedTaskIds, []);
    assert.equal(dState.continuationState, 'NONE');

    // Check task statuses: strictly READY, zero ACCEPTED or IN_PROGRESS
    const loaded = await specStore.loadTasks();
    for (const t of loaded) {
      assert.equal(t.status, 'READY');
      assert.equal(t.attempt, 0);
      assert.equal(t.started_at, null);
      assert.equal(t.completed_at, null);
    }
  });

  // ==========================================================================
  // T23 — Existing P11 scope contract remains compatible
  // ==========================================================================
  it('T23 — Existing P11 scope contract remains compatible: analysisScope/implementationScope/targetFiles valid for execution request formulation', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
      candidateTasks: [
        {
          title: 'P11 Compatible Task',
          description: 'Tests compatibility with P11 execution request builder',
          parentFeatureId: 'FEAT-CORE-INGESTION-FEATURE',
          traceabilitySources: ['REQ:REQ-001'],
          acceptanceCriteria: ['Valid criteria'],
          scope: {
            analysisScope: ['packages/core/src/task-decomposition'],
            implementationScope: ['packages/core/src/task-decomposition'],
            targetFiles: ['packages/core/src/task-decomposition/task-decomposition-engine.ts'],
          },
        },
      ],
    });

    const task = result.tasksCreated[0];
    const scope = (task.metadata?.scope as any);

    // Verify properties required by P11 ExecutionRequestBuilder canonicalizeScopePaths & canonicalizeTargetFiles
    assert.ok(Array.isArray(scope.analysisScope));
    assert.ok(Array.isArray(scope.implementationScope));
    assert.ok(Array.isArray(scope.targetFiles));

    for (const p of [...scope.analysisScope, ...scope.implementationScope, ...scope.targetFiles]) {
      // Must be relative POSIX paths without traversal or leading slash
      assert.equal(p.startsWith('/'), false);
      assert.equal(p.includes('\\'), false);
      assert.equal(p.split('/').includes('..'), false);
    }
  });

  // ==========================================================================
  // T24 — Full Director context consistency
  // ==========================================================================
  it('T24 — Full Director context consistency: snapshot remains coherent after decomposition', async () => {
    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: approvedPackage.packageId,
      approvalPackageRevision: approvedPackage.revision,
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSessionId,
      workspaceRoot: testDir,
      projectId: canonicalProjectId,
      priorFingerprint: contextFingerprint,
    });

    assert.equal(snapshot.directorSessionId, activeSessionId);
    assert.equal(snapshot.projectId, canonicalProjectId);
    assert.equal(snapshot.sections.approval?.hasApprovalPackage, true);
    assert.equal(snapshot.sections.approval?.packageId, approvedPackage.packageId);
    assert.equal(snapshot.sections.approval?.revision, 1);
    assert.equal(snapshot.sections.approval?.isExplicitlyApproved, true);
    assert.equal(snapshot.sections.authorization?.isDevelopmentAuthorized, true);
    assert.equal(snapshot.sections.authorization?.authoritySource, 'PRODUCT_OWNER');
    assert.equal(snapshot.sections.taskList?.total, 3);
    assert.equal(snapshot.syncStatus, 'CHANGED');
    assert.equal(snapshot.isComplete, true);
    assert.equal(snapshot.staleSections.length, 0);
    assert.equal(snapshot.unavailableSections.length, 0);
  });

  // ==========================================================================
  // T25 — Cross-project isolation
  // ==========================================================================
  it('T25 — Cross-project isolation: independent project contexts remain strictly isolated', async () => {
    // 1. Set up second isolated project environment
    const testDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p1204-projB-'));
    try {
      const envB = await setupProjectEnvironment(testDirB, 'pkg-projB-test');

      // 2. Decompose project A
      const resultA = await decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: approvedPackage.packageId,
        approvalPackageRevision: approvedPackage.revision,
      });

      // 3. Verify Project B SpecStore is completely unaffected
      const loadedB = await envB.specStore.loadTasks();
      assert.equal(loadedB.length, 0);

      // 4. Decompose project B
      const resultB = await envB.decompositionEngine.decomposePlan({
        directorSessionId: envB.session.directorSessionId,
        contextFingerprint: envB.contextFingerprint,
        approvalPackageId: envB.approvedPackage.packageId,
        approvalPackageRevision: envB.approvedPackage.revision,
      });

      // 5. Verify task IDs are distinct across projects due to project identity salt
      const idsA = resultA.tasksCreated.map((t) => t.task_id);
      const idsB = resultB.tasksCreated.map((t) => t.task_id);

      assert.equal(idsA.length, 3);
      assert.equal(idsB.length, 3);

      for (const idA of idsA) {
        assert.equal(idsB.includes(idA), false, `Task ID collision across projects: ${idA}`);
      }

      // Check SpecStores remain isolated
      const tasksInA = await specStore.loadTasks();
      const tasksInB = await envB.specStore.loadTasks();

      assert.equal(tasksInA.length, 3);
      assert.equal(tasksInB.length, 3);
      assert.deepEqual(
        tasksInA.map((t) => t.metadata?.projectId),
        [canonicalProjectId, canonicalProjectId, canonicalProjectId]
      );
      assert.deepEqual(
        tasksInB.map((t) => t.metadata?.projectId),
        [envB.session.projectId, envB.session.projectId, envB.session.projectId]
      );
    } finally {
      try {
        fs.rmSync(testDirB, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });
});
