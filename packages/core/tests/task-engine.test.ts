import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TaskDagEngine,
  validateTask,
  assertValidTask,
  validateTaskGraph,
  assertValidTaskGraph,
  kahnTopologicalSort,
  TaskGraphValidationError,
  AidmError,
  TaskHierarchyLevel,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type TaskDefinition,
  type TaskDefinitionInput,
  type TaskGraphModel,
} from '../dist/index.js';

function createValidTask(overrides?: Partial<TaskDefinitionInput>): TaskDefinitionInput {
  return {
    task_id: 'TASK-P2-01',
    parent_feature_id: 'FEAT-P2-TASK-CONTEXT-ENGINE',
    title: 'Task Model & DAG Engine',
    description: 'Implement Task Model and DAG Engine foundation according to Section 10',
    traceability_sources: ['SYSTEM_REQUIREMENT: TASK_MANAGEMENT', 'DEC: DEC-009'],
    dependencies: [],
    acceptance_criteria: [
      'AC-P2-01-1: Hierarchy represented',
      'AC-P2-01-2: Mandatory fields validated',
    ],
    status: 'READY',
    attempt: 0,
    max_attempts: 3,
    priority: 'HIGH',
    risk_level: 'SAFE',
    created_at: '2026-09-22T04:00:00.000Z',
    started_at: null,
    completed_at: null,
    hierarchy_level: 'TASK',
    ...overrides,
  };
}

describe('Task Model & DAG Engine (TASK-P2-01)', () => {
  const engine = new TaskDagEngine();

  // ==========================================================================
  // MANDATORY SCENARIOS T1 TO T10
  // ==========================================================================

  describe('Mandatory Verification Scenarios (T1 - T10)', () => {
    it('T1: Valid hierarchy and valid acyclic graph must PASS', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-CORE'],
        tasks: [
          createValidTask({
            task_id: 'TASK-01',
            parent_feature_id: 'FEAT-CORE',
            dependencies: [],
          }),
          createValidTask({
            task_id: 'TASK-02',
            parent_feature_id: 'FEAT-CORE',
            dependencies: ['TASK-01'],
          }),
          createValidTask({
            task_id: 'TASK-03',
            parent_feature_id: 'FEAT-CORE',
            dependencies: ['TASK-01'],
          }),
          createValidTask({
            task_id: 'TASK-04',
            parent_feature_id: 'FEAT-CORE',
            dependencies: ['TASK-02', 'TASK-03'],
          }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, true);
      assert.equal(validation.errors.length, 0);
      assert.ok(validation.topologicalOrder);

      const order = validation.topologicalOrder!;
      assert.equal(order.length, 4);
      assert.equal(order[0], 'TASK-01');
      assert.ok(order.indexOf('TASK-01') < order.indexOf('TASK-02'));
      assert.ok(order.indexOf('TASK-01') < order.indexOf('TASK-03'));
      assert.ok(order.indexOf('TASK-02') < order.indexOf('TASK-04'));
      assert.ok(order.indexOf('TASK-03') < order.indexOf('TASK-04'));

      // assertValidTaskGraph should succeed and return validated tasks
      const validated = assertValidTaskGraph(graph);
      assert.equal(validated.length, 4);
    });

    it('T2: Duplicate task_id must FAIL with DUPLICATE_ID_CHECK', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({ task_id: 'TASK-01', title: 'First Task' }),
          createValidTask({ task_id: 'TASK-01', title: 'Duplicate Task' }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, false);
      const duplicateError = validation.errors.find((e) => e.category === 'DUPLICATE_ID_CHECK');
      assert.ok(duplicateError, 'Expected DUPLICATE_ID_CHECK error in validation issues');
      assert.equal(duplicateError?.taskId, 'TASK-01');

      assert.throws(
        () => assertValidTaskGraph(graph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'DUPLICATE_ID_CHECK');
          assert.equal(err.code, 'ERR_TASK_GRAPH_VALIDATION');
          assert.ok(err.message.includes('DUPLICATE_ID_CHECK'));
          return true;
        }
      );
    });

    it('T3: Missing dependency must FAIL with MISSING_DEPENDENCY_CHECK', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({
            task_id: 'TASK-01',
            dependencies: ['TASK-NONEXISTENT'],
          }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, false);
      const missingError = validation.errors.find((e) => e.category === 'MISSING_DEPENDENCY_CHECK');
      assert.ok(missingError, 'Expected MISSING_DEPENDENCY_CHECK error');
      assert.equal(missingError?.taskId, 'TASK-01');

      assert.throws(
        () => assertValidTaskGraph(graph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'MISSING_DEPENDENCY_CHECK');
          assert.ok(err.message.includes('MISSING_DEPENDENCY_CHECK'));
          return true;
        }
      );
    });

    it('T4: Simple A -> B -> A cycle must FAIL with CIRCULAR_DEPENDENCY_CHECK', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({
            task_id: 'TASK-A',
            dependencies: ['TASK-B'],
          }),
          createValidTask({
            task_id: 'TASK-B',
            dependencies: ['TASK-A'],
          }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, false);
      const cycleError = validation.errors.find((e) => e.category === 'CIRCULAR_DEPENDENCY_CHECK');
      assert.ok(cycleError, 'Expected CIRCULAR_DEPENDENCY_CHECK error');

      assert.throws(
        () => assertValidTaskGraph(graph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'CIRCULAR_DEPENDENCY_CHECK');
          assert.ok(err.message.includes('CIRCULAR_DEPENDENCY_CHECK'));
          const cycleTasks = err.details?.cycleTasks as string[];
          assert.ok(cycleTasks.includes('TASK-A'));
          assert.ok(cycleTasks.includes('TASK-B'));
          return true;
        }
      );
    });

    it('T5: Longer cycle (A -> B, B -> C, C -> D, D -> B) must FAIL with CIRCULAR_DEPENDENCY_CHECK', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({
            task_id: 'TASK-A',
            dependencies: [],
          }),
          createValidTask({
            task_id: 'TASK-B',
            dependencies: ['TASK-A', 'TASK-D'],
          }),
          createValidTask({
            task_id: 'TASK-C',
            dependencies: ['TASK-B'],
          }),
          createValidTask({
            task_id: 'TASK-D',
            dependencies: ['TASK-C'],
          }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, false);
      const cycleError = validation.errors.find((e) => e.category === 'CIRCULAR_DEPENDENCY_CHECK');
      assert.ok(cycleError, 'Expected CIRCULAR_DEPENDENCY_CHECK error');

      assert.throws(
        () => assertValidTaskGraph(graph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'CIRCULAR_DEPENDENCY_CHECK');
          assert.ok(err.message.includes('CIRCULAR_DEPENDENCY_CHECK'));
          const cycleTasks = err.details?.cycleTasks as string[];
          assert.ok(cycleTasks.includes('TASK-B'));
          assert.ok(cycleTasks.includes('TASK-C'));
          assert.ok(cycleTasks.includes('TASK-D'));
          assert.ok(!cycleTasks.includes('TASK-A'));
          return true;
        }
      );
    });

    it('T6: Invalid parent_feature_id must FAIL with INVALID_PARENT_CHECK', () => {
      // 1. Empty parent_feature_id
      const emptyParentGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: '' }),
      ];
      const emptyRes = validateTaskGraph(emptyParentGraph);
      assert.equal(emptyRes.valid, false);
      assert.ok(emptyRes.errors.some((e) => e.category === 'INVALID_PARENT_CHECK'));

      assert.throws(
        () => assertValidTaskGraph(emptyParentGraph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'INVALID_PARENT_CHECK');
          return true;
        }
      );

      // 2. Self reference as parent
      const selfParentGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: 'TASK-01' }),
      ];
      const selfRes = validateTaskGraph(selfParentGraph);
      assert.equal(selfRes.valid, false);
      assert.ok(selfRes.errors.some((e) => e.category === 'INVALID_PARENT_CHECK'));

      // 3. Parent pointing to another regular task in the graph
      const taskAsParentGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: 'FEAT-01' }),
        createValidTask({ task_id: 'TASK-02', parent_feature_id: 'TASK-01' }),
      ];
      const taskParentRes = validateTaskGraph(taskAsParentGraph, { validFeatureIds: ['FEAT-01'] });
      assert.equal(taskParentRes.valid, false);
      assert.ok(taskParentRes.errors.some((e) => e.category === 'INVALID_PARENT_CHECK'));

      // 4. Unknown parent feature without requiring validFeatureIds
      const unknownParentGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: 'FEAT-UNKNOWN' }),
      ];
      const unknownRes = validateTaskGraph(unknownParentGraph);
      assert.equal(unknownRes.valid, false);
      assert.ok(unknownRes.errors.some((e) => e.category === 'INVALID_PARENT_CHECK'));
    });

    it('T7: Missing traceability source must FAIL with TRACEABILITY_SOURCE_CHECK', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({
            task_id: 'TASK-01',
            traceability_sources: [],
          }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, false);
      const traceError = validation.errors.find((e) => e.category === 'TRACEABILITY_SOURCE_CHECK');
      assert.ok(traceError, 'Expected TRACEABILITY_SOURCE_CHECK error');

      assert.throws(
        () => assertValidTaskGraph(graph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'TRACEABILITY_SOURCE_CHECK');
          assert.ok(err.message.includes('TRACEABILITY_SOURCE_CHECK'));
          return true;
        }
      );
    });

    it('T8: Invalid traceability source must FAIL with TRACEABILITY_SOURCE_CHECK', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({
            task_id: 'TASK-01',
            traceability_sources: ['UNAUTHORIZED_SOURCE: random_note', 'FOOBAR'],
          }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, false);
      const traceError = validation.errors.find((e) => e.category === 'TRACEABILITY_SOURCE_CHECK');
      assert.ok(traceError, 'Expected TRACEABILITY_SOURCE_CHECK error on invalid source');

      assert.throws(
        () => assertValidTaskGraph(graph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'TRACEABILITY_SOURCE_CHECK');
          assert.ok(err.message.includes('TRACEABILITY_SOURCE_CHECK'));
          return true;
        }
      );
    });

    it('T9: Valid graph with multiple independent branches must PASS with deterministic topological order', () => {
      const graph: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: [
          createValidTask({ task_id: 'TASK-B2-02', dependencies: ['TASK-B2-01'] }),
          createValidTask({ task_id: 'TASK-B1-02', dependencies: ['TASK-B1-01'] }),
          createValidTask({ task_id: 'TASK-B2-01', dependencies: [] }),
          createValidTask({ task_id: 'TASK-B1-01', dependencies: [] }),
        ],
      };

      const validation = validateTaskGraph(graph);
      assert.equal(validation.valid, true);

      // Lexicographical tie-breaking rule ensures TASK-B1-01 comes before TASK-B2-01,
      // and TASK-B1-02 comes before TASK-B2-02
      const expectedOrder = ['TASK-B1-01', 'TASK-B1-02', 'TASK-B2-01', 'TASK-B2-02'];
      assert.deepEqual(validation.topologicalOrder, expectedOrder);
    });

    it('T10: Repeated graph validation with shuffled input order must produce identical topological ordering', () => {
      const baseTasks: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-D', dependencies: ['TASK-B', 'TASK-C'] }),
        createValidTask({ task_id: 'TASK-A', dependencies: [] }),
        createValidTask({ task_id: 'TASK-C', dependencies: ['TASK-A'] }),
        createValidTask({ task_id: 'TASK-B', dependencies: ['TASK-A'] }),
        createValidTask({ task_id: 'TASK-E', dependencies: ['TASK-D'] }),
      ];

      const model: TaskGraphModel = {
        features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
        tasks: baseTasks,
      };

      const firstOrder = engine.topologicalSort(model);

      // Run 30 iterations with randomized shuffles
      for (let i = 0; i < 30; i++) {
        const shuffledTasks = [...baseTasks].sort(() => Math.random() - 0.5);
        const shuffledModel: TaskGraphModel = {
          features: ['FEAT-P2-TASK-CONTEXT-ENGINE'],
          tasks: shuffledTasks,
        };
        const order = engine.topologicalSort(shuffledModel);
        assert.deepEqual(
          order,
          firstOrder,
          `Topological ordering diverged on iteration ${i}`
        );
      }
    });
  });

  // ==========================================================================
  // MANDATORY 15 TASK FIELDS RUNTIME VALIDATION (Architecture Section 10)
  // ==========================================================================

  describe('Authoritative Section 10 Mandatory Task Fields Validation', () => {
    it('should validate all 15 mandatory fields when valid', () => {
      const taskInput = createValidTask();
      const res = validateTask(taskInput);
      assert.equal(res.valid, true);
      assert.ok(res.task);

      const t = res.task!;
      assert.equal(t.task_id, 'TASK-P2-01');
      assert.equal(t.parent_feature_id, 'FEAT-P2-TASK-CONTEXT-ENGINE');
      assert.equal(t.title, 'Task Model & DAG Engine');
      assert.equal(t.description, 'Implement Task Model and DAG Engine foundation according to Section 10');
      assert.deepEqual(t.traceability_sources, ['SYSTEM_REQUIREMENT: TASK_MANAGEMENT', 'DEC: DEC-009']);
      assert.deepEqual(t.dependencies, []);
      assert.equal(t.status, 'READY');
      assert.equal(t.attempt, 0);
      assert.equal(t.max_attempts, 3);
      assert.equal(t.priority, 'HIGH');
      assert.equal(t.risk_level, 'SAFE');
      assert.ok(typeof t.created_at === 'string');
      assert.equal(t.started_at, null);
      assert.equal(t.completed_at, null);
    });

    it('should accept camelCase inputs and normalize to canonical snake_case TaskDefinition', () => {
      const camelCaseInput = {
        taskId: 'TASK-P2-01',
        parentFeatureId: 'FEAT-P2-TASK-CONTEXT-ENGINE',
        title: 'Task Model & DAG Engine',
        description: 'CamelCase input test',
        traceabilitySources: ['SYSTEM_REQUIREMENT: TASK_MANAGEMENT', 'DEC: DEC-009'],
        dependencies: [],
        acceptanceCriteria: ['AC-01: Validated'],
        status: 'READY' as const,
        attempt: 1,
        maxAttempts: 4,
        priority: 'MEDIUM' as const,
        riskLevel: 'CAUTION' as const,
        createdAt: '2026-09-22T04:30:00.000Z',
        startedAt: '2026-09-22T04:31:00.000Z',
        completedAt: null,
      };

      const task = assertValidTask(camelCaseInput);
      assert.equal(task.task_id, 'TASK-P2-01');
      assert.equal(task.parent_feature_id, 'FEAT-P2-TASK-CONTEXT-ENGINE');
      assert.deepEqual(task.traceability_sources, ['SYSTEM_REQUIREMENT: TASK_MANAGEMENT', 'DEC: DEC-009']);
      assert.equal(task.max_attempts, 4);
      assert.equal(task.risk_level, 'CAUTION');
      assert.equal(task.started_at, '2026-09-22T04:31:00.000Z');
    });

    it('should reject invalid status string', () => {
      const invalid = createValidTask({ status: 'INVALID_STATUS' as any });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject negative attempt count', () => {
      const invalid = createValidTask({ attempt: -1 });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject non-positive max_attempts', () => {
      const invalid = createValidTask({ max_attempts: 0 });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject invalid priority value', () => {
      const invalid = createValidTask({ priority: 'SUPER_URGENT' as any });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject invalid risk_level value', () => {
      const invalid = createValidTask({ risk_level: 'EXTREME' as any });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject missing title or empty title', () => {
      const invalid = createValidTask({ title: '   ' });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject missing description or empty description', () => {
      const invalid = createValidTask({ description: '' });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });

    it('should reject empty acceptance criteria array', () => {
      const invalid = createValidTask({ acceptance_criteria: [] });
      const res = validateTask(invalid);
      assert.equal(res.valid, false);
    });
  });

  // ==========================================================================
  // TASK HIERARCHY (EPIC -> FEATURE -> TASK -> SUBTASK)
  // ==========================================================================

  describe('Task Hierarchy Support (EPIC -> FEATURE -> TASK -> SUBTASK)', () => {
    it('should support all four hierarchy levels', () => {
      assert.equal(TaskHierarchyLevel.EPIC, 'EPIC');
      assert.equal(TaskHierarchyLevel.FEATURE, 'FEATURE');
      assert.equal(TaskHierarchyLevel.TASK, 'TASK');
      assert.equal(TaskHierarchyLevel.SUBTASK, 'SUBTASK');
    });

    it('should represent and validate task with explicit hierarchy level', () => {
      const subtask = createValidTask({
        task_id: 'SUBTASK-P2-01-A',
        parent_feature_id: 'FEAT-P2-TASK-CONTEXT-ENGINE',
        hierarchy_level: 'SUBTASK',
        traceability_sources: ['PARENT_TASK: TASK-P2-01'],
      });

      const validated = assertValidTask(subtask);
      assert.equal(validated.hierarchy_level, 'SUBTASK');
    });
  });

  // ==========================================================================
  // CORRECTION #1 REGRESSION TESTS: DEC-009 CATEGORIES (R1 - R4)
  // ==========================================================================

  describe('Correction #1: DEC-009 Traceability Categories Strictness (R1 - R4)', () => {
    it('R1: Valid DEC-009 category set must all PASS (REQ, DEC, PARENT_TASK, PARENT_FEATURE, SYSTEM_REQUIREMENT)', () => {
      const validCases = [
        'REQ',
        'REQ-001',
        'REQ: AUTHENTICATION_FLOW',
        'DEC',
        'DEC-009',
        'DEC: DEC-009',
        'PARENT_TASK',
        'PARENT_TASK: TASK-P1-01',
        'PARENT_FEATURE',
        'PARENT_FEATURE: FEAT-P1-CORE-FOUNDATION',
        'SYSTEM_REQUIREMENT',
        'SYSTEM_REQUIREMENT: TASK_MANAGEMENT',
      ];

      for (const src of validCases) {
        const task = createValidTask({ traceability_sources: [src] });
        const res = validateTask(task);
        assert.equal(res.valid, true, `Expected "${src}" to be valid under DEC-009`);
      }
    });

    it('R2: DECISION category must be REJECTED (DEC-009 specifies DEC only)', () => {
      const decisionCases = [
        'DECISION',
        'DECISION: DEC-009',
        'DECISION-001',
      ];

      for (const src of decisionCases) {
        const task = createValidTask({ traceability_sources: [src] });
        const res = validateTask(task);
        assert.equal(res.valid, false, `Expected "${src}" to be rejected`);
        const traceError = res.errors.find((e) => e.category === 'TRACEABILITY_SOURCE_CHECK');
        assert.ok(traceError, `Expected TRACEABILITY_SOURCE_CHECK error for "${src}"`);
      }
    });

    it('R3: ARCHITECTURE category must be REJECTED (DEC-009 does not permit ARCHITECTURE)', () => {
      const archCases = [
        'ARCHITECTURE',
        'ARCHITECTURE: SECTION_10',
        'ARCHITECTURE-001',
      ];

      for (const src of archCases) {
        const task = createValidTask({ traceability_sources: [src] });
        const res = validateTask(task);
        assert.equal(res.valid, false, `Expected "${src}" to be rejected`);
        const traceError = res.errors.find((e) => e.category === 'TRACEABILITY_SOURCE_CHECK');
        assert.ok(traceError, `Expected TRACEABILITY_SOURCE_CHECK error for "${src}"`);
      }
    });

    it('R4: Arbitrary traceability category must be REJECTED', () => {
      const arbitraryCases = [
        '',
        '   ',
        'USER_STORY_123',
        'RANDOM_IDEA: make it faster',
        'BUGFIX: 99',
        'EXTERNAL_PR: #42',
        'CUSTOM_SOURCE: notes',
      ];

      for (const src of arbitraryCases) {
        const task = createValidTask({ traceability_sources: [src] });
        const res = validateTask(task);
        assert.equal(res.valid, false, `Expected arbitrary source "${src}" to be rejected`);
        assert.ok(res.errors.some((e) => e.category === 'TRACEABILITY_SOURCE_CHECK'));
      }
    });
  });

  // ==========================================================================
  // CORRECTION #1 REGRESSION TESTS: AUTHORITATIVE INVALID_PARENT_CHECK (R5 - R10)
  // ==========================================================================

  describe('Correction #1: Authoritative INVALID_PARENT_CHECK (R5 - R10)', () => {
    it('R5: Valid Feature parent and valid Epic parent must be ACCEPTED', () => {
      // 1. Valid Feature parent represented in TaskGraphModel
      const graphWithFeature: TaskGraphModel = {
        features: ['FEAT-CORE'],
        tasks: [
          createValidTask({ task_id: 'TASK-01', parent_feature_id: 'FEAT-CORE' }),
        ],
      };
      const res1 = validateTaskGraph(graphWithFeature);
      assert.equal(res1.valid, true);

      // 2. Valid Epic parent where architecture permits it (Section 10: "Ait olduğu Feature/Epic kimliği")
      const graphWithEpic: TaskGraphModel = {
        epics: ['EPIC-FOUNDATION'],
        tasks: [
          createValidTask({ task_id: 'TASK-02', parent_feature_id: 'EPIC-FOUNDATION' }),
        ],
      };
      const res2 = validateTaskGraph(graphWithEpic);
      assert.equal(res2.valid, true);

      // 3. Valid Feature and Epic in flat array nodes
      const flatGraph: TaskDefinitionInput[] = [
        createValidTask({
          task_id: 'EPIC-01',
          hierarchy_level: 'EPIC',
          parent_feature_id: 'ROOT',
        }),
        createValidTask({
          task_id: 'FEAT-01',
          hierarchy_level: 'FEATURE',
          parent_feature_id: 'EPIC-01',
        }),
        createValidTask({
          task_id: 'TASK-03',
          hierarchy_level: 'TASK',
          parent_feature_id: 'FEAT-01',
        }),
      ];
      const res3 = validateTaskGraph(flatGraph);
      assert.equal(res3.valid, true);
    });

    it('R6: Unknown parent must be REJECTED (without requiring validFeatureIds)', () => {
      const graphWithoutKnownParents: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: 'FEAT-NONEXISTENT' }),
      ];

      // Call validateTaskGraph without any options
      const res = validateTaskGraph(graphWithoutKnownParents);
      assert.equal(res.valid, false);
      const parentIssue = res.errors.find((e) => e.category === 'INVALID_PARENT_CHECK');
      assert.ok(parentIssue, 'Expected INVALID_PARENT_CHECK error for unknown parent');
      assert.ok(parentIssue?.message.includes('unknown parent_feature_id'));

      assert.throws(
        () => assertValidTaskGraph(graphWithoutKnownParents),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'INVALID_PARENT_CHECK');
          return true;
        }
      );
    });

    it('R7: Self-parent must be REJECTED', () => {
      const selfParentGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: 'TASK-01' }),
      ];

      const res = validateTaskGraph(selfParentGraph);
      assert.equal(res.valid, false);
      const parentIssue = res.errors.find((e) => e.category === 'INVALID_PARENT_CHECK');
      assert.ok(parentIssue, 'Expected INVALID_PARENT_CHECK for self-parent');
      assert.ok(parentIssue?.message.includes('cannot reference itself'));

      assert.throws(
        () => assertValidTaskGraph(selfParentGraph),
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'INVALID_PARENT_CHECK');
          return true;
        }
      );
    });

    it('R8: Incompatible parent hierarchy must be REJECTED', () => {
      // 1. TASK referencing another TASK as parent
      const taskParentingTask: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-PARENT', hierarchy_level: 'TASK', parent_feature_id: 'FEAT-CORE' }),
        createValidTask({ task_id: 'TASK-CHILD', hierarchy_level: 'TASK', parent_feature_id: 'TASK-PARENT' }),
      ];
      const res1 = validateTaskGraph(taskParentingTask, { validFeatureIds: ['FEAT-CORE'] });
      assert.equal(res1.valid, false);
      const issue1 = res1.errors.find((e) => e.taskId === 'TASK-CHILD' && e.category === 'INVALID_PARENT_CHECK');
      assert.ok(issue1, 'Expected INVALID_PARENT_CHECK for TASK referencing TASK parent');
      assert.ok(issue1?.message.includes('incompatible parent hierarchy'));

      // 2. FEATURE referencing a TASK as parent (FEATURE parent must be EPIC)
      const featureParentingTask: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-NODE', hierarchy_level: 'TASK', parent_feature_id: 'FEAT-CORE' }),
        createValidTask({ task_id: 'FEAT-INVALID', hierarchy_level: 'FEATURE', parent_feature_id: 'TASK-NODE' }),
      ];
      const res2 = validateTaskGraph(featureParentingTask, { validFeatureIds: ['FEAT-CORE'] });
      assert.equal(res2.valid, false);
      const issue2 = res2.errors.find((e) => e.taskId === 'FEAT-INVALID' && e.category === 'INVALID_PARENT_CHECK');
      assert.ok(issue2, 'Expected INVALID_PARENT_CHECK for FEATURE referencing TASK parent');
    });

    it('R9: Missing parent must be REJECTED', () => {
      // Empty string
      const emptyGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: '' }),
      ];
      const res1 = validateTaskGraph(emptyGraph);
      assert.equal(res1.valid, false);
      assert.ok(res1.errors.some((e) => e.category === 'INVALID_PARENT_CHECK'));

      // Whitespace only
      const whitespaceGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-02', parent_feature_id: '   ' }),
      ];
      const res2 = validateTaskGraph(whitespaceGraph);
      assert.equal(res2.valid, false);
      assert.ok(res2.errors.some((e) => e.category === 'INVALID_PARENT_CHECK'));
    });

    it('R10: Deterministic parent validation result across repeated runs', () => {
      const invalidGraph: TaskDefinitionInput[] = [
        createValidTask({ task_id: 'TASK-01', parent_feature_id: 'FEAT-NONEXISTENT' }),
      ];

      const firstResult = validateTaskGraph(invalidGraph);
      assert.equal(firstResult.valid, false);
      const firstError = firstResult.errors[0];

      // Run 25 times and verify strict identity of error messages and categories
      for (let i = 0; i < 25; i++) {
        const nextResult = validateTaskGraph(invalidGraph);
        assert.equal(nextResult.valid, false);
        assert.equal(nextResult.errors[0].category, firstError.category);
        assert.equal(nextResult.errors[0].message, firstError.message);
        assert.deepEqual(nextResult.errors[0].details, firstError.details);
      }
    });
  });

  // ==========================================================================
  // ERROR HIERARCHY AND STRUCTURE
  // ==========================================================================

  describe('TaskGraphValidationError Hierarchy & Structured Data', () => {
    it('should extend AidmError and serialize properly', () => {
      const err = new TaskGraphValidationError('DUPLICATE_ID_CHECK', 'Duplicate task found', {
        taskId: 'TASK-DUP',
        duplicateId: 'TASK-DUP',
      });

      assert.ok(err instanceof Error);
      assert.ok(err instanceof AidmError);
      assert.ok(err instanceof TaskGraphValidationError);
      assert.equal(err.code, 'ERR_TASK_GRAPH_VALIDATION');
      assert.equal(err.category, 'DUPLICATE_ID_CHECK');
      assert.equal(err.taskId, 'TASK-DUP');
      assert.ok(err.message.includes('[DUPLICATE_ID_CHECK]'));

      const json = err.toJSON();
      assert.equal(json.code, 'ERR_TASK_GRAPH_VALIDATION');
      assert.equal(json.name, 'TaskGraphValidationError');
      assert.ok(json.details);
    });
  });

  // ==========================================================================
  // DAG ENGINE UTILITIES (Dependencies, Dependents, Cycle Detection)
  // ==========================================================================

  describe('DAG Engine Queries and Operations', () => {
    const tasks: TaskDefinition[] = [
      assertValidTask(createValidTask({ task_id: 'T1', dependencies: [] })),
      assertValidTask(createValidTask({ task_id: 'T2', dependencies: ['T1'] })),
      assertValidTask(createValidTask({ task_id: 'T3', dependencies: ['T1'] })),
      assertValidTask(createValidTask({ task_id: 'T4', dependencies: ['T2', 'T3'] })),
    ];

    it('should correctly report task dependencies', () => {
      assert.deepEqual(engine.getDependencies(tasks, 'T1'), []);
      assert.deepEqual(engine.getDependencies(tasks, 'T4'), ['T2', 'T3']);
    });

    it('should correctly report task dependents in deterministic order', () => {
      assert.deepEqual(engine.getDependents(tasks, 'T1'), ['T2', 'T3']);
      assert.deepEqual(engine.getDependents(tasks, 'T2'), ['T4']);
      assert.deepEqual(engine.getDependents(tasks, 'T4'), []);
    });

    it('should return null when detecting cycles on an acyclic graph', () => {
      assert.equal(engine.detectCycles(tasks), null);
    });

    it('should return cycle candidate task IDs when detecting cycles on cyclic graph', () => {
      const cyclicTasks: TaskDefinition[] = [
        assertValidTask(createValidTask({ task_id: 'X', dependencies: ['Y'] })),
        assertValidTask(createValidTask({ task_id: 'Y', dependencies: ['X'] })),
      ];
      const cycle = engine.detectCycles(cyclicTasks);
      assert.ok(cycle);
      assert.ok(cycle?.includes('X'));
      assert.ok(cycle?.includes('Y'));
    });
  });
});
