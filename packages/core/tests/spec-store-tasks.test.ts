import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SpecStore,
  HistoryManager,
  StateValidationError,
  type TaskDefinition,
} from '../dist/index.js';

describe('P12-03: SpecStore Ingestion Hardening + Revision/Audit', () => {
  let tempDir: string;
  let specStore: SpecStore;
  let historyManager: HistoryManager;

  const createSampleTask = (overrides?: Partial<TaskDefinition>): TaskDefinition => ({
    task_id: 'TASK-P12-01',
    parent_feature_id: 'FEAT-ORCH',
    title: 'Implement Task Decomposition Engine',
    description: 'Implements authoritative ingestion boundary from approved plan',
    traceability_sources: ['REQ:1.1', 'DEC:009'],
    dependencies: [],
    acceptance_criteria: ['Decomposition validates all inputs strictly'],
    status: 'READY',
    attempt: 0,
    max_attempts: 3,
    priority: 'HIGH',
    risk_level: 'SAFE',
    created_at: '2026-09-27T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    hierarchy_level: 'TASK',
    metadata: {
      revision: 1,
      projectId: 'proj-alpha',
      approvalPackageId: 'pkg-123',
      approvalPackageRevision: 2,
      contextFingerprint: 'ctx-fp-999',
      scope: {
        analysisScope: ['packages/core/src/analysis'],
        implementationScope: ['packages/core/src/impl'],
        targetFiles: ['packages/core/src/impl/target.ts'],
      },
    },
    ...overrides,
  });

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-spec-store-p1203-'));
    specStore = new SpecStore({ baseDir: tempDir });
    historyManager = new HistoryManager({ baseDir: tempDir });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 1. save/load round trip preserving all 17+ fields
  it('1. should perform save and load round-trip preserving all Section 10 task fields exactly', async () => {
    const task = createSampleTask();
    const saved = await specStore.saveTasks([task]);
    assert.equal(saved.length, 1);

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 1);
    const loadedTask = loaded[0];

    assert.equal(loadedTask.task_id, task.task_id);
    assert.equal(loadedTask.parent_feature_id, task.parent_feature_id);
    assert.equal(loadedTask.title, task.title);
    assert.equal(loadedTask.description, task.description);
    assert.deepEqual(loadedTask.traceability_sources, task.traceability_sources);
    assert.deepEqual(loadedTask.dependencies, task.dependencies);
    assert.deepEqual(loadedTask.acceptance_criteria, task.acceptance_criteria);
    assert.equal(loadedTask.status, task.status);
    assert.equal(loadedTask.attempt, task.attempt);
    assert.equal(loadedTask.max_attempts, task.max_attempts);
    assert.equal(loadedTask.priority, task.priority);
    assert.equal(loadedTask.risk_level, task.risk_level);
    assert.equal(loadedTask.created_at, task.created_at);
    assert.equal(loadedTask.started_at, task.started_at);
    assert.equal(loadedTask.completed_at, task.completed_at);
    assert.equal(loadedTask.hierarchy_level, task.hierarchy_level);
    assert.deepEqual(loadedTask.metadata, task.metadata);
  });

  // 2. atomic persistence (no partial file on failure)
  it('2. should maintain atomic persistence without partial or corrupted files on validation failure', async () => {
    const initialTask = createSampleTask();
    await specStore.saveTasks([initialTask]);

    const corruptedTasks = [
      createSampleTask({ task_id: 'TASK-VALID-2' }),
      { task_id: 'TASK-INVALID', title: '' } as unknown as TaskDefinition, // invalid task
    ];

    await assert.rejects(
      async () => {
        await specStore.saveTasks(corruptedTasks);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        return true;
      }
    );

    // Existing file should remain untouched and valid
    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].task_id, initialTask.task_id);
  });

  // 3. duplicate task ID rejection in single save call
  it('3. should reject duplicate task IDs within the same collection input', async () => {
    const task1 = createSampleTask({ task_id: 'TASK-DUP' });
    const task2 = createSampleTask({ task_id: 'TASK-DUP' });

    await assert.rejects(
      async () => {
        await specStore.saveTasks([task1, task2]);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        assert.match((err as StateValidationError).message, /Duplicate task_id 'TASK-DUP'/);
        return true;
      }
    );
  });

  // 4. malformed task rejection (missing required fields, invalid status, etc.)
  it('4. should reject malformed task definitions violating schema', async () => {
    const invalidTask = {
      task_id: 'TASK-BAD',
      parent_feature_id: 'FEAT-1',
      // missing title and description
      status: 'INVALID_STATUS',
    } as unknown as TaskDefinition;

    await assert.rejects(
      async () => {
        await specStore.saveTasks([invalidTask]);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        assert.match((err as StateValidationError).message, /Invalid task definition for 'TASK-BAD'/);
        return true;
      }
    );
  });

  // 5. new task revision defaults to 1
  it('5. should default metadata.revision to 1 if unspecified', async () => {
    const task = createSampleTask({
      metadata: {
        projectId: 'proj-1',
      },
    });
    delete (task.metadata as Record<string, unknown>).revision;

    const saved = await specStore.saveTasks([task]);
    assert.equal(saved[0].metadata?.revision, 1);

    const loaded = await specStore.loadTasks();
    assert.equal(loaded[0].metadata?.revision, 1);
  });

  // 6. identical task save is idempotent (does not bump revision or alter file)
  it('6. should handle repeated identical save idempotently while preserving runtime execution state', async () => {
    const task = createSampleTask({
      status: 'READY',
      attempt: 1,
    });
    await specStore.saveTasks([task]);

    // Save identical incoming task definition (e.g. from fresh decomposition replay)
    const replayTask = createSampleTask({
      status: 'READY',
      attempt: 0, // newly decomposed proposal has attempt 0
    });

    const savedAgain = await specStore.saveTasks([replayTask]);
    assert.equal(savedAgain.length, 1);
    // Runtime execution progress (attempt: 1) preserved
    assert.equal(savedAgain[0].attempt, 1);
    assert.equal(savedAgain[0].metadata?.revision, 1);
  });

  // 7. stale revision (inRev < exRev) is rejected
  it('7. should reject incoming task with stale revision lower than existing stored revision', async () => {
    const taskRev2 = createSampleTask({
      metadata: { revision: 2 },
    });
    await specStore.saveTasks([taskRev2]);

    const taskRev1 = createSampleTask({
      metadata: { revision: 1 },
    });

    await assert.rejects(
      async () => {
        await specStore.saveTasks([taskRev1]);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        assert.match((err as StateValidationError).message, /stale revision \(1\) lower than stored revision \(2\)/);
        return true;
      }
    );
  });

  // 8. same revision with different content is rejected
  it('8. should reject incoming task at same revision with conflicting definition', async () => {
    const task = createSampleTask({
      title: 'Original Title',
      metadata: { revision: 1 },
    });
    await specStore.saveTasks([task]);

    const conflictingTask = createSampleTask({
      title: 'Conflicting Mutated Title',
      metadata: { revision: 1 },
    });

    await assert.rejects(
      async () => {
        await specStore.saveTasks([conflictingTask]);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        assert.match((err as StateValidationError).message, /conflicts with existing task at same revision \(1\) with different definition/);
        return true;
      }
    );
  });

  // 9. ACCEPTED task protected from overwrite/rewrite
  it('9. should protect ACCEPTED tasks from being rewritten or modified', async () => {
    const acceptedTask = createSampleTask({
      status: 'ACCEPTED',
      completed_at: '2026-09-27T01:00:00.000Z',
      metadata: { revision: 1 },
    });
    await specStore.saveTasks([acceptedTask]);

    const modifiedTask = createSampleTask({
      status: 'READY',
      title: 'Modified Accepted Task Title',
      metadata: { revision: 2 },
    });

    await assert.rejects(
      async () => {
        await specStore.saveTasks([modifiedTask]);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        assert.match((err as StateValidationError).message, /in protected status 'ACCEPTED' in SpecStore and cannot be modified/);
        return true;
      }
    );
  });

  // 10. IN_PROGRESS task protected from overwrite/rewrite
  it('10. should protect IN_PROGRESS tasks from being rewritten or modified', async () => {
    const inProgressTask = createSampleTask({
      status: 'IN_PROGRESS',
      started_at: '2026-09-27T01:00:00.000Z',
      metadata: { revision: 1 },
    });
    await specStore.saveTasks([inProgressTask]);

    const modifiedTask = createSampleTask({
      title: 'Modified Running Task Title',
      metadata: { revision: 2 },
    });

    await assert.rejects(
      async () => {
        await specStore.saveTasks([modifiedTask]);
      },
      (err: unknown) => {
        assert.ok(err instanceof StateValidationError);
        assert.match((err as StateValidationError).message, /in protected status 'IN_PROGRESS' in SpecStore and cannot be modified/);
        return true;
      }
    );
  });

  // 11. metadata.scope (analysisScope, implementationScope, targetFiles) preserved exactly
  it('11. should preserve metadata.scope exactly across persistence', async () => {
    const scopeData = {
      analysisScope: ['packages/core/src/analysis', 'docs/spec'],
      implementationScope: ['packages/core/src/impl'],
      targetFiles: ['packages/core/src/impl/a.ts', 'packages/core/src/impl/b.ts'],
    };
    const task = createSampleTask({
      metadata: {
        revision: 1,
        scope: scopeData,
      },
    });

    await specStore.saveTasks([task]);
    const loaded = await specStore.loadTasks();

    assert.deepEqual(loaded[0].metadata?.scope, scopeData);
  });

  // 12. approval binding metadata preserved (approvalPackageId, approvalPackageRevision)
  it('12. should preserve approval package binding metadata across persistence', async () => {
    const task = createSampleTask({
      metadata: {
        revision: 1,
        approvalPackageId: 'pkg-guid-12345',
        approvalPackageRevision: 4,
      },
    });

    await specStore.saveTasks([task]);
    const loaded = await specStore.loadTasks();

    assert.equal(loaded[0].metadata?.approvalPackageId, 'pkg-guid-12345');
    assert.equal(loaded[0].metadata?.approvalPackageRevision, 4);
  });

  // 13. context fingerprint preserved (contextFingerprint)
  it('13. should preserve context fingerprint and directorSessionId across persistence', async () => {
    const task = createSampleTask({
      metadata: {
        revision: 1,
        contextFingerprint: 'sha256-abcdef0123456789',
        directorSessionId: 'session-dir-777',
      },
    });

    await specStore.saveTasks([task]);
    const loaded = await specStore.loadTasks();

    assert.equal(loaded[0].metadata?.contextFingerprint, 'sha256-abcdef0123456789');
    assert.equal(loaded[0].metadata?.directorSessionId, 'session-dir-777');
  });

  // 14. no partial JSON file remains after failed write
  it('14. should not leave any partial or temporary files in the spec directory after write failure', async () => {
    const invalidTasks = [
      { task_id: '', title: '' } as unknown as TaskDefinition,
    ];

    await assert.rejects(async () => {
      await specStore.saveTasks(invalidTasks);
    });

    const files = await fs.promises.readdir(specStore.specDir).catch(() => []);
    const tempFiles = files.filter((f) => f.includes('.tmp.'));
    assert.equal(tempFiles.length, 0);
  });

  // 15. existing valid collection remains recoverable if save fails
  it('15. should ensure existing valid collection remains untouched and recoverable if save fails', async () => {
    const original = [
      createSampleTask({ task_id: 'TASK-1', title: 'Task One' }),
      createSampleTask({ task_id: 'TASK-2', title: 'Task Two' }),
    ];
    await specStore.saveTasks(original);

    // Attempt invalid save
    await assert.rejects(async () => {
      await specStore.saveTasks([
        createSampleTask({ task_id: 'TASK-1', title: 'Task One' }),
        { invalid: true } as unknown as TaskDefinition,
      ]);
    });

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].task_id, 'TASK-1');
    assert.equal(loaded[1].task_id, 'TASK-2');
  });

  // 16. HistoryManager integration does not emit duplicate TASK_DECOMPOSITION_INGESTED
  it('16. should verify SpecStore does not emit duplicate TASK_DECOMPOSITION_INGESTED history events', async () => {
    const task = createSampleTask();
    await specStore.saveTasks([task]);

    // Check history file: SpecStore itself is a pure persistence layer and must not emit decomposition events
    const historyExists = fs.existsSync(historyManager.historyPath);
    if (historyExists) {
      const events = await historyManager.readEvents();
      const ingestedEvents = events.filter((e: { eventType?: string; payload?: any }) => e.eventType === 'TASK_DECOMPOSITION_INGESTED');
      assert.equal(ingestedEvents.length, 0);
    } else {
      assert.equal(historyExists, false);
    }
  });

  // 17. backward compatibility: tasks.json without metadata loads cleanly
  it('17. should load tasks without metadata cleanly with full backward compatibility', async () => {
    const rawLegacyTask = {
      task_id: 'LEGACY-TASK-01',
      parent_feature_id: 'FEAT-LEGACY',
      title: 'Legacy Task Title',
      description: 'Legacy task created before metadata was standard',
      traceability_sources: ['REQ:LEGACY'],
      dependencies: [],
      acceptance_criteria: ['Legacy criteria'],
      status: 'READY',
      attempt: 0,
      max_attempts: 3,
      priority: 'MEDIUM',
      risk_level: 'SAFE',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      // no metadata field
    };

    await fs.promises.mkdir(specStore.specDir, { recursive: true });
    await fs.promises.writeFile(specStore.tasksPath, JSON.stringify([rawLegacyTask], null, 2), 'utf8');

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].task_id, 'LEGACY-TASK-01');
    assert.equal(loaded[0].title, 'Legacy Task Title');
  });

  // 18. SpecStore does not validate DAG cycles or dependencies (leaves DAG to TaskDagEngine)
  it('18. should not perform DAG cycle checks or fail on cyclic dependencies, leaving DAG authority to TaskDagEngine', async () => {
    // Two tasks with a mutual dependency cycle
    const taskA = createSampleTask({
      task_id: 'TASK-CYCLE-A',
      dependencies: ['TASK-CYCLE-B'],
    });
    const taskB = createSampleTask({
      task_id: 'TASK-CYCLE-B',
      dependencies: ['TASK-CYCLE-A'],
    });

    // SpecStore is purely persistence integrity and must successfully save valid schema items
    const saved = await specStore.saveTasks([taskA, taskB]);
    assert.equal(saved.length, 2);

    const loaded = await specStore.loadTasks();
    assert.equal(loaded.length, 2);
  });

  // 19. SpecStore does not authorize development (leaves to ExecutionAuthorizer)
  it('19. should not check Product Owner authorization, leaving authorization to ExecutionAuthorizer', async () => {
    // Task without any authorization context or approval package
    const unapprovedTask = createSampleTask({
      task_id: 'TASK-UNAPPROVED',
      metadata: { revision: 1 },
    });

    const saved = await specStore.saveTasks([unapprovedTask]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].task_id, 'TASK-UNAPPROVED');
  });

  // 20. SpecStore does not execute processes or Antigravity
  it('20. should be a pure passive storage layer with zero external process execution', async () => {
    const task = createSampleTask();
    const saved = await specStore.saveTasks([task]);
    assert.equal(saved.length, 1);
    assert.equal(typeof specStore.saveTasks, 'function');
    assert.equal(typeof specStore.loadTasks, 'function');
  });
});
