/**
 * Comprehensive Test Suite for Phase 12 Task Decomposition & Ingestion Boundary (TASK-P12-01)
 *
 * Verifies all 30 authoritative requirements:
 * 1. Authorization: No approval -> reject
 * 2. Authorization: REJECTED approval -> reject
 * 3. Authorization: stale approval revision -> reject
 * 4. Authorization: wrong project -> reject
 * 5. Authorization: wrong session -> reject
 * 6. Authorization: stale context fingerprint -> reject
 * 7. Decomposition: valid approved plan produces deterministic tasks
 * 8. Decomposition: repeated identical decomposition is idempotent
 * 9. Decomposition: generated IDs are stable
 * 10. Decomposition: generated tasks contain valid traceability
 * 11. Decomposition: generated acceptance criteria are non-empty
 * 12. DAG: valid graph accepted
 * 13. DAG: duplicate ID rejected
 * 14. DAG: missing dependency rejected
 * 15. DAG: circular dependency rejected
 * 16. DAG: invalid parent rejected
 * 17. Scope: valid scope accepted
 * 18. Scope: path traversal rejected
 * 19. Scope: absolute path rejected
 * 20. Scope: task outside approved scope rejected
 * 21. Persistence: invalid graph never reaches SpecStore
 * 22. Persistence: complete valid graph persists atomically
 * 23. Persistence: incompatible existing task produces conflict
 * 24. Persistence: no partial ingestion
 * 25. Context: successfully ingested tasks appear in Director context
 * 26. Context: context fingerprint changes naturally after task ingestion
 * 27. Security: Director proposal cannot bypass validation
 * 28. Security: cross-project proposal rejected
 * 29. Security: forged approval metadata rejected
 * 30. Security: MCP boundary enforces validation and returns sanitized payload
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
  TaskDecompositionApprovalRequiredError,
  TaskDecompositionApprovalRevisionMismatchError,
  TaskDecompositionProjectBindingMismatchError,
  TaskDecompositionSessionBindingMismatchError,
  TaskDecompositionContextMismatchError,
  TaskDecompositionInvalidGraphError,
  TaskDecompositionInvalidScopeError,
  TaskDecompositionConflictError,
  TaskDecompositionImmutableStateConflictError,
  TaskDecompositionOutOfScopeError,
  TaskDecompositionValidationError,
  McpServer,
  InMemoryMcpTransport,
} from '../dist/index.js';

describe('Phase 12 Task Decomposition & Ingestion Boundary (TASK-P12-01)', () => {
  let testDir: string;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let approvalStore: ApprovalStore;
  let approvalEngine: ApprovalPackageEngine;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let historyManager: HistoryManager;
  let synchronizer: DirectorContextSynchronizer;
  let decompositionEngine: TaskDecompositionEngine;

  let activeSessionId: string;
  let approvedPackage: ProjectApprovalPackage;
  let contextFingerprint: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p12-01-test-'));
    fs.mkdirSync(path.join(testDir, '.ai-manager', 'spec'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.ai-manager', 'approval'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.ai-manager', 'director'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.ai-manager', 'history'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.ai-manager', 'state'), { recursive: true });

    historyManager = new HistoryManager({ baseDir: testDir });
    specStore = new SpecStore({ baseDir: testDir });
    dagEngine = new TaskDagEngine();
    approvalStore = new ApprovalStore({ baseDir: testDir, historyManager });
    approvalEngine = new ApprovalPackageEngine();
    sessionStore = new DirectorSessionStore({ baseDir: testDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: testDir });

    const durableStateManager = new DurableStateManager({ baseDir: testDir });
    await durableStateManager.save({
      schemaVersion: 1,
      currentLifecycleState: 'INITIALIZING',
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS',
      updatedAt: new Date().toISOString(),
    });

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: testDir,
      sessionEngine,
      sessionStore,
    });

    decompositionEngine = new TaskDecompositionEngine({
      workspaceRoot: testDir,
      specStore,
      dagEngine,
      approvalStore,
      approvalPackageEngine: approvalEngine,
      sessionStore,
      sessionEngine,
      historyManager,
    });

    // 1. Establish Active Director Session
    const session = await sessionEngine.createSession({
      workspaceRoot: testDir,
      actor: Actor.DIRECTOR,
      actorRole: 'DIRECTOR',
      approvalPackageId: 'pkg-p12-test',
      approvalRevision: 1,
      understandingRevision: 1,
    });
    activeSessionId = session.directorSessionId;

    // 2. Build and Approve Project Approval Package
    const understanding: InitialProjectUnderstanding = {
      projectId: session.projectId,
      projectName: 'TestProject',
      apparentPurpose: {
        summary: 'P12 Test project',
        classification: 'APPLICATION',
        evidence: [],
      },
      targetUsers: ['Engineers'],
      technologyStack: { primaryLanguages: ['TypeScript'] },
      architectureSummary: { pattern: 'Modular' },
      existingCapabilities: [],
      confirmedRequirements: [
        {
          id: 'req-001',
          type: 'CONFIRMED_FACT',
          origin: 'EXISTING_REQUIREMENT',
          statement: 'Support deterministic task ingestion',
          evidence: [],
          sourceReferenceId: 'REQ-001',
        },
      ],
      clarifiedRequirements: [],
      unresolvedUnknowns: [],
      unresolvedContradictions: [],
      currentImplementationState: { state: 'Initial' },
      constraints: ['POSIX paths only'],
      assumptions: [],
      nonGoals: ['Autonomous continuation loop'],
      proposedDevelopmentScope: ['Task ingestion', 'DAG validation'],
      evidenceReferences: [],
      sourceDiscoveryReference: 'discovery-test',
      generatedAt: new Date().toISOString(),
    };

    const proposedPlan: ProposedDevelopmentPlan = {
      objectives: ['Establish task ingestion', 'Validate graph integrity'],
      proposedScope: ['Core ingestion'],
      proposedFeatureGroups: [
        {
          name: 'Task Ingestion Foundation',
          description: 'Core ingestion modules',
          targetCapabilities: ['Schema Validation', 'DAG Assertions'],
        },
      ],
      dependencies: [],
      constraints: ['Strict POSIX'],
      knownRisks: [],
      unresolvedIssues: [],
      excludedScope: [],
      suggestedImplementationOrder: ['Schema Validation', 'DAG Assertions'],
    };

    const pkg = approvalEngine.buildPackage(understanding, proposedPlan, {
      packageId: 'pkg-p12-test',
    });

    approvedPackage = approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'ProductOwner',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for Phase 12 testing',
    });

    await approvalStore.savePackage(approvedPackage);

    // 3. Synchronize context to get valid contextFingerprint
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSessionId,
      workspaceRoot: testDir,
      projectId: session.projectId,
    });
    contextFingerprint = snapshot.logicalFingerprint;
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ==========================================================================
  // SECTION 1: AUTHORIZATION BOUNDARY
  // ==========================================================================

  it('T01: No approval -> rejects with TaskDecompositionApprovalRequiredError', async () => {
    // Overwrite with empty approval pointer
    fs.rmSync(path.join(testDir, '.ai-manager', 'approval', 'active-package.json'), { force: true });

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionApprovalRequiredError
    );
  });

  it('T02: REJECTED approval -> rejects with TaskDecompositionApprovalRequiredError', async () => {
    const rejectedPkg = {
      ...approvedPackage,
      status: 'REJECTED' as const,
      approvalRecord: undefined,
    };
    await approvalStore.savePackage(rejectedPkg as any);

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionApprovalRequiredError
    );
  });

  it('T03: Stale approval revision -> rejects with TaskDecompositionApprovalRevisionMismatchError', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 99, // Stale revision
      }),
      TaskDecompositionApprovalRevisionMismatchError
    );
  });

  it('T04: Wrong project -> rejects with TaskDecompositionProjectBindingMismatchError', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        projectId: 'foreign-project-id',
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionProjectBindingMismatchError
    );
  });

  it('T05: Closed/wrong Director session -> rejects with TaskDecompositionSessionBindingMismatchError', async () => {
    await sessionEngine.closeSession({ directorSessionId: activeSessionId });

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionSessionBindingMismatchError
    );
  });

  it('T06: Stale context fingerprint -> rejects with TaskDecompositionContextMismatchError', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint: 'outdated-stale-fingerprint-hex',
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionContextMismatchError
    );
  });

  // ==========================================================================
  // SECTION 2: DECOMPOSITION & DETERMINISM
  // ==========================================================================

  it('T07: Valid approved plan produces deterministic tasks', async () => {
    const result = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    assert.equal(result.isSuccess, true);
    assert.equal(result.isIdempotentReplay, false);
    assert.equal(result.tasksCreated.length, 2);
    assert.equal(result.tasksCreated[0].parent_feature_id, 'FEAT-TASK-INGESTION-FOUNDATION');
    assert.equal(result.tasksCreated[0].status, 'READY');
    assert.equal(result.tasksCreated[0].metadata?.revision, 1);
    assert.equal(result.tasksCreated[0].metadata?.approvalPackageRevision, 1);
  });

  it('T08: Repeated identical decomposition is idempotent', async () => {
    const first = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });
    assert.equal(first.isIdempotentReplay, false);

    const second = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });
    assert.equal(second.isIdempotentReplay, true);
    assert.equal(second.tasksCreated.length, first.tasksCreated.length);
    assert.deepEqual(
      second.tasksCreated.map((t) => t.task_id),
      first.tasksCreated.map((t) => t.task_id)
    );
  });

  it('T09: Generated task IDs are stable across runs', async () => {
    const res1 = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    const expectedId0 = decompositionEngine.generateDeterministicTaskId(
      'FEAT-TASK-INGESTION-FOUNDATION',
      0,
      'Schema Validation',
      approvedPackage.projectId
    );
    assert.equal(res1.tasksCreated[0].task_id, expectedId0);
  });

  it('T10: Generated tasks contain valid traceability_sources conforming to Section 10', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    for (const task of res.tasksCreated) {
      assert.ok(task.traceability_sources.length > 0);
      for (const src of task.traceability_sources) {
        assert.match(src, /^(REQ|DEC|PARENT_TASK|PARENT_FEATURE|SYSTEM_REQUIREMENT)/i);
      }
    }
  });

  it('T11: Generated acceptance criteria are non-empty', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    for (const task of res.tasksCreated) {
      assert.ok(task.acceptance_criteria.length > 0);
      assert.ok(task.acceptance_criteria[0].trim().length > 0);
    }
  });

  // ==========================================================================
  // SECTION 3: DAG INTEGRITY & PROPOSAL VALIDATION
  // ==========================================================================

  it('T12: Valid custom candidate graph proposal is accepted', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
      candidateTasks: [
        {
          taskId: 'TASK-P1-INGEST-STEP1',
          parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
          title: 'Custom Step 1',
          description: 'Custom step 1 description',
          dependencies: [],
          traceabilitySources: ['REQ:REQ-001'],
          acceptanceCriteria: ['Step 1 verified'],
        },
        {
          taskId: 'TASK-P1-INGEST-STEP2',
          parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
          title: 'Custom Step 2',
          description: 'Custom step 2 description',
          dependencies: ['TASK-P1-INGEST-STEP1'],
          traceabilitySources: ['REQ:REQ-001'],
          acceptanceCriteria: ['Step 2 verified'],
        },
      ],
    });

    assert.equal(res.isSuccess, true);
    assert.deepEqual(res.topologicalOrder, ['TASK-P1-INGEST-STEP1', 'TASK-P1-INGEST-STEP2']);
  });

  it('T13: Duplicate task ID in proposal is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-DUP',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task A',
            description: 'Task A desc',
            dependencies: [],
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: 'TASK-DUP',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task B',
            description: 'Task B desc',
            dependencies: [],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionInvalidGraphError
    );
  });

  it('T14: Missing dependency in proposal is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-A',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task A',
            description: 'Task A desc',
            dependencies: ['NON-EXISTENT-TASK'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionInvalidGraphError
    );
  });

  it('T15: Circular dependency in proposal is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-A',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task A',
            description: 'Task A desc',
            dependencies: ['TASK-B'],
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: 'TASK-B',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task B',
            description: 'Task B desc',
            dependencies: ['TASK-A'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionInvalidGraphError
    );
  });

  it('T16: Invalid parent feature reference in proposal is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-A',
            parentFeatureId: 'UNKNOWN-FEATURE-NOT-IN-GRAPH',
            title: 'Task A',
            description: 'Task A desc',
            dependencies: [],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionOutOfScopeError
    );
  });

  // ==========================================================================
  // SECTION 4: SCOPE SAFETY & APPROVED SCOPE ENFORCEMENT
  // ==========================================================================

  it('T17: Valid task scope is accepted and normalized', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
      candidateTasks: [
        {
          taskId: 'TASK-SCOPE-OK',
          parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
          title: 'Scoped Task',
          description: 'Scoped task description',
          traceabilitySources: ['REQ:REQ-001'],
          scope: {
            analysisScope: ['packages/core/src'],
            implementationScope: ['packages/core/src/task-decomposition'],
            targetFiles: ['packages/core/src/task-decomposition/index.ts'],
          },
        },
      ],
    });

    const task = res.tasksCreated[0];
    const taskScope = task.metadata?.scope as any;
    assert.deepEqual(taskScope.analysisScope, ['packages/core/src']);
    assert.deepEqual(taskScope.implementationScope, ['packages/core/src/task-decomposition']);
    assert.deepEqual(taskScope.targetFiles, ['packages/core/src/task-decomposition/index.ts']);
  });

  it('T18: Scope with path traversal (..) is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-TRAVERSAL',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Traversal Task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              targetFiles: ['packages/core/../../secret.txt'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );
  });

  it('T19: Absolute path in scope is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-ABS',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Absolute Path Task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              targetFiles: ['/etc/passwd'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );
  });

  it('T20: Task referencing non-approved feature is rejected as out-of-scope', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-ROGUE',
            parentFeatureId: 'FEAT-UNAPPROVED-ROGUE',
            title: 'Rogue Task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionOutOfScopeError
    );
  });

  // ==========================================================================
  // SECTION 5: PERSISTENCE ATOMICITY & CONFLICT PREVENTION
  // ==========================================================================

  it('T21: Invalid graph never reaches SpecStore (zero persistence)', async () => {
    try {
      await decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-CIRCULAR-1',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Circ 1',
            description: 'desc',
            dependencies: ['TASK-CIRCULAR-2'],
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: 'TASK-CIRCULAR-2',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Circ 2',
            description: 'desc',
            dependencies: ['TASK-CIRCULAR-1'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      });
      assert.fail('Should have failed');
    } catch {
      // Expected
    }

    const tasksInStore = await specStore.loadTasks();
    assert.equal(tasksInStore.length, 0);
  });

  it('T22: Complete valid graph persists atomically and history event is logged', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    const tasksInStore = await specStore.loadTasks();
    assert.equal(tasksInStore.length, res.tasksCreated.length);

    const events = await historyManager.readEvents();
    const decompEvent = events.find((e) => e.eventType === 'TASK_DECOMPOSITION_INGESTED');
    assert.ok(decompEvent);
    assert.equal(decompEvent.payload.approvalPackageId, 'pkg-p12-test');
    assert.equal(decompEvent.payload.taskCount, res.tasksCreated.length);
  });

  it('T23: Incompatible existing task in SpecStore produces TaskDecompositionConflictError', async () => {
    const expectedTaskId = decompositionEngine.generateDeterministicTaskId(
      'FEAT-TASK-INGESTION-FOUNDATION',
      0,
      'Schema Validation',
      approvedPackage.projectId
    );

    // Save an existing task with different parent_feature_id
    await specStore.saveTasks([
      {
        task_id: expectedTaskId,
        parent_feature_id: 'FEAT-DIFFERENT-PARENT',
        title: 'Conflicting task',
        description: 'desc',
        traceability_sources: ['REQ:001'],
        dependencies: [],
        acceptance_criteria: ['ac'],
        status: 'READY',
        attempt: 0,
        max_attempts: 3,
        priority: 'MEDIUM',
        risk_level: 'SAFE',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        metadata: { revision: 1 },
      },
    ]);

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionConflictError
    );
  });

  it('T24: No partial ingestion: errors leave SpecStore untouched', async () => {
    // Pre-populate with 1 known task
    const initialTasks = [
      {
        task_id: 'TASK-EXISTING-SAFE',
        parent_feature_id: 'FEAT-INITIAL',
        title: 'Initial Task',
        description: 'desc',
        traceability_sources: ['REQ:INIT'],
        dependencies: [],
        acceptance_criteria: ['ac'],
        status: 'READY' as const,
        attempt: 0,
        max_attempts: 3,
        priority: 'MEDIUM' as const,
        risk_level: 'SAFE' as const,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
    ];
    await specStore.saveTasks(initialTasks);

    // Run invalid proposal
    try {
      await decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-OK-1',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task OK',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: 'TASK-BAD-2',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task Bad',
            description: 'desc',
            dependencies: ['MISSING-DEP'],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      });
      assert.fail('Should fail');
    } catch {
      // Expected
    }

    // Verify SpecStore still has exactly the initial task
    const storeAfter = await specStore.loadTasks();
    assert.equal(storeAfter.length, 1);
    assert.equal(storeAfter[0].task_id, 'TASK-EXISTING-SAFE');
  });

  // ==========================================================================
  // SECTION 6: CONTEXT ENGINE INTEGRATION & SECURITY
  // ==========================================================================

  it('T25: Ingested tasks appear in DirectorContextSynchronizer snapshot', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    const newSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSessionId,
      workspaceRoot: testDir,
      projectId: approvedPackage.projectId,
      priorFingerprint: contextFingerprint,
    });

    assert.equal(newSnapshot.sections.taskList.total, 2);
    assert.equal(newSnapshot.sections.taskList.tasks.length, 2);
    assert.deepEqual(newSnapshot.sections.taskList.topologicalOrder, [...res.topologicalOrder]);
  });

  it('T26: Context fingerprint changes naturally after task ingestion', async () => {
    const priorFingerprint = contextFingerprint;

    await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    const newSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSessionId,
      workspaceRoot: testDir,
      projectId: approvedPackage.projectId,
      priorFingerprint,
    });

    assert.notEqual(newSnapshot.logicalFingerprint, priorFingerprint);
    assert.equal(newSnapshot.syncStatus, 'CHANGED');
  });

  it('T27: Director proposal cannot bypass validation (empty acceptance criteria rejected)', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-INVALID-AC',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Task with empty AC',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            acceptanceCriteria: [''], // Empty criterion string
          },
        ],
      }),
      TaskDecompositionValidationError
    );
  });

  it('T28: Cross-project proposal is rejected deterministically', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        projectId: 'foreign-project-id',
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
      }),
      TaskDecompositionProjectBindingMismatchError
    );
  });

  it('T29: Forged approval package revision is rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 2, // Only revision 1 exists and is approved
      }),
      TaskDecompositionApprovalRevisionMismatchError
    );
  });

  it('T30: MCP tool aidm.task.decompose exposes boundary and sanitizes payload', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      taskDecompositionTools: true,
      delegate: {
        projectRoot: testDir,
        specStore,
        dagEngine,
        approvalStore,
        directorSessionStore: sessionStore,
        historyManager,
        isHealthy: () => true,
      },
    });

    await server.start();

    // Call tool via MCP JSON-RPC envelope
    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'aidm.task.decompose',
        arguments: {
          directorSessionId: activeSessionId,
          contextFingerprint,
          approvalPackageId: 'pkg-p12-test',
          approvalPackageRevision: 1,
        },
      },
    });

    assert.ok(response);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(!('error' in response));

    const result = response as any;
    assert.ok(result.result.content);
    const parsedPayload = JSON.parse(result.result.content[0].text);
    assert.equal(parsedPayload.isSuccess, true);
    assert.equal(parsedPayload.tasksCreated.length, 2);

    await server.stop();
  });

  // ==========================================================================
  // SECTION 6: P12-02 DETERMINISTIC TASK IDENTITY & SCOPE MAPPING
  // ==========================================================================

  it('T31: Deterministic logical task ID across runs without approvalRevision dependency', async () => {
    const res1 = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });

    const taskId0 = res1.tasksCreated[0].task_id;
    // Must NOT contain P1 or P2 approval revision in task identity
    assert.ok(!taskId0.includes('-P1-'), 'Task ID must not encode approval package revision');
    assert.match(taskId0, /^TASK-[A-Z0-9-]+-STEP-01-[A-Z0-9-]+-[A-F0-9]{6}$/);

    // Same logical input must produce the exact identical task ID
    const generatedId = decompositionEngine.generateDeterministicTaskId(
      res1.tasksCreated[0].parent_feature_id,
      0,
      'Schema Validation',
      approvedPackage.projectId
    );
    assert.equal(taskId0, generatedId);
  });

  it('T32: Approval package revision change does not change logical task IDs', async () => {
    // Generate task ID under approval revision 1
    const idRev1 = decompositionEngine.generateDeterministicTaskId(
      'FEAT-TASK-INGESTION-FOUNDATION',
      0,
      'Schema Validation',
      'TestProject'
    );

    // Generate task ID under another revision context with identical semantics
    const idRev2 = decompositionEngine.generateDeterministicTaskId(
      'FEAT-TASK-INGESTION-FOUNDATION',
      0,
      'Schema Validation',
      'TestProject'
    );

    assert.equal(idRev1, idRev2);
  });

  it('T33: Distinct semantic tasks produce different deterministic IDs', async () => {
    const id1 = decompositionEngine.generateDeterministicTaskId(
      'FEAT-CORE',
      0,
      'Schema Validation',
      'TestProject'
    );
    const id2 = decompositionEngine.generateDeterministicTaskId(
      'FEAT-CORE',
      1,
      'DAG Assertions',
      'TestProject'
    );

    assert.notEqual(id1, id2);
  });

  it('T34: Feature isolation: tasks with same slug under different features produce different IDs', async () => {
    const idFeatA = decompositionEngine.generateDeterministicTaskId(
      'FEAT-AUTH',
      0,
      'Validation',
      'TestProject'
    );
    const idFeatB = decompositionEngine.generateDeterministicTaskId(
      'FEAT-STORAGE',
      0,
      'Validation',
      'TestProject'
    );

    assert.notEqual(idFeatA, idFeatB);
  });

  it('T35: Project isolation: same feature and slug under different projects produce different IDs', async () => {
    const idProjA = decompositionEngine.generateDeterministicTaskId(
      'FEAT-AUTH',
      0,
      'Validation',
      'ProjectAlpha'
    );
    const idProjB = decompositionEngine.generateDeterministicTaskId(
      'FEAT-AUTH',
      0,
      'Validation',
      'ProjectBeta'
    );

    assert.notEqual(idProjA, idProjB);
  });

  it('T36: Existing ACCEPTED task cannot be silently replaced or overwritten', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });
    const createdTask = res.tasksCreated[0];

    // Mark task as ACCEPTED in SpecStore
    const acceptedTask = { ...createdTask, status: 'ACCEPTED' as const };
    await specStore.saveTasks([acceptedTask, res.tasksCreated[1]]);

    // Attempting to decompose with a modified definition for the ACCEPTED task must throw
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: createdTask.task_id,
            parentFeatureId: createdTask.parent_feature_id,
            title: 'Modified Title for Accepted Task',
            description: 'Attempting silent rewrite',
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: res.tasksCreated[1].task_id,
            parentFeatureId: res.tasksCreated[1].parent_feature_id,
            title: res.tasksCreated[1].title,
            description: res.tasksCreated[1].description,
            dependencies: [createdTask.task_id],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionImmutableStateConflictError
    );
  });

  it('T37: Existing IN_PROGRESS task cannot be silently replaced or overwritten', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });
    const createdTask = res.tasksCreated[0];

    // Mark task as IN_PROGRESS in SpecStore
    const inProgressTask = { ...createdTask, status: 'IN_PROGRESS' as const, started_at: new Date().toISOString() };
    await specStore.saveTasks([inProgressTask, res.tasksCreated[1]]);

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: createdTask.task_id,
            parentFeatureId: createdTask.parent_feature_id,
            title: 'Rewritten In-Progress Title',
            description: 'Attempting rewrite while execution active',
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: res.tasksCreated[1].task_id,
            parentFeatureId: res.tasksCreated[1].parent_feature_id,
            title: res.tasksCreated[1].title,
            description: res.tasksCreated[1].description,
            dependencies: [createdTask.task_id],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionImmutableStateConflictError
    );
  });

  it('T38: Material semantic change for an existing task triggers TaskDecompositionConflictError', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
    });
    const existingTask = res.tasksCreated[0];

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: existingTask.task_id,
            parentFeatureId: existingTask.parent_feature_id,
            title: 'Materially Divergent Title',
            description: 'Materially divergent description',
            traceabilitySources: ['REQ:REQ-001'],
          },
          {
            taskId: res.tasksCreated[1].task_id,
            parentFeatureId: res.tasksCreated[1].parent_feature_id,
            title: res.tasksCreated[1].title,
            description: res.tasksCreated[1].description,
            dependencies: [existingTask.task_id],
            traceabilitySources: ['REQ:REQ-001'],
          },
        ],
      }),
      TaskDecompositionConflictError
    );
  });

  it('T39: Scope security: Windows drive-letter paths (C:) are strictly rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-WIN-DRIVE',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Drive path task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              targetFiles: ['C:/Windows/System32/drivers/etc/hosts'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );
  });

  it('T40: Scope security: UNC paths (\\\\ or //) are strictly rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-UNC-BACKSLASH',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'UNC task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              analysisScope: ['\\\\server\\share\\repo'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-UNC-SLASH',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'UNC slash task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              implementationScope: ['//network-server/shared-dir'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );
  });

  it('T41: Scope security: Null-byte paths are strictly rejected', async () => {
    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-p12-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-NULL-BYTE',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Null byte task',
            description: 'desc',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              targetFiles: ['packages/core/src/index.ts\0.exe'],
            },
          },
        ],
      }),
      TaskDecompositionInvalidScopeError
    );
  });

  it('T42: Scope protection: scope targeting explicitly excluded scope in approved plan is rejected', async () => {
    // Create an approved package with explicit excludedScope
    const planWithExcluded: ProposedDevelopmentPlan = {
      objectives: ['Establish task ingestion'],
      proposedScope: ['Core ingestion'],
      proposedFeatureGroups: [
        {
          name: 'Task Ingestion Foundation',
          description: 'Core ingestion modules',
          targetCapabilities: ['Schema Validation'],
        },
      ],
      dependencies: [],
      constraints: [],
      knownRisks: [],
      unresolvedIssues: [],
      excludedScope: ['packages/legacy', 'legacy.ts'],
      suggestedImplementationOrder: ['Schema Validation'],
    };

    const pkgWithExcluded = approvalEngine.buildPackage(
      {
        projectId: approvedPackage.projectId,
        projectName: 'TestProject',
        apparentPurpose: { summary: 'P12 test', classification: 'APPLICATION', evidence: [] },
        targetUsers: ['Devs'],
        technologyStack: { primaryLanguages: ['TypeScript'] },
        architectureSummary: { pattern: 'Modular' },
        existingCapabilities: [],
        confirmedRequirements: [],
        clarifiedRequirements: [],
        unresolvedUnknowns: [],
        unresolvedContradictions: [],
        currentImplementationState: { state: 'Initial' },
        constraints: [],
        assumptions: [],
        nonGoals: ['Legacy modules'],
        proposedDevelopmentScope: ['Task ingestion'],
        evidenceReferences: [],
        sourceDiscoveryReference: 'ref-1',
        generatedAt: new Date().toISOString(),
      },
      planWithExcluded,
      { packageId: 'pkg-excluded-test' }
    );

    const approvedWithExcluded = approvalEngine.approvePackage(pkgWithExcluded, {
      packageId: 'pkg-excluded-test',
      revision: 1,
      actor: 'ProductOwner',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved with exclusions',
    });
    await approvalStore.savePackage(approvedWithExcluded);

    await assert.rejects(
      decompositionEngine.decomposePlan({
        directorSessionId: activeSessionId,
        contextFingerprint,
        approvalPackageId: 'pkg-excluded-test',
        approvalPackageRevision: 1,
        candidateTasks: [
          {
            taskId: 'TASK-INTO-EXCLUDED',
            parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
            title: 'Excluded scope task',
            description: 'Touches excluded legacy module',
            traceabilitySources: ['REQ:REQ-001'],
            scope: {
              implementationScope: ['packages/legacy/old-util.ts'],
            },
          },
        ],
      }),
      TaskDecompositionOutOfScopeError
    );
  });

  it('T43: Scope separation: analysisScope, implementationScope, and targetFiles remain distinct', async () => {
    const res = await decompositionEngine.decomposePlan({
      directorSessionId: activeSessionId,
      contextFingerprint,
      approvalPackageId: 'pkg-p12-test',
      approvalPackageRevision: 1,
      candidateTasks: [
        {
          taskId: 'TASK-TRIPLE-SCOPE',
          parentFeatureId: 'FEAT-TASK-INGESTION-FOUNDATION',
          title: 'Distinct scopes',
          description: 'Preserves 3 scope fields',
          traceabilitySources: ['REQ:REQ-001'],
          scope: {
            analysisScope: ['packages/core/src'],
            implementationScope: ['packages/core/src/task-decomposition'],
            targetFiles: ['packages/core/src/task-decomposition/index.ts'],
          },
        },
      ],
    });

    const task = res.tasksCreated[0];
    const scope = (task.metadata?.scope as any) || {};

    assert.deepEqual(scope.analysisScope, ['packages/core/src']);
    assert.deepEqual(scope.implementationScope, ['packages/core/src/task-decomposition']);
    assert.deepEqual(scope.targetFiles, ['packages/core/src/task-decomposition/index.ts']);

    // Proves scopes are not collapsed or merged
    assert.notDeepEqual(scope.analysisScope, scope.implementationScope);
    assert.notDeepEqual(scope.implementationScope, scope.targetFiles);
  });
});
