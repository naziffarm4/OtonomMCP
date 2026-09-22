import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFile,
  DurableStateManager,
  LocalRuntimeStateManager,
  HistoryManager,
  SpecStore,
  LifecycleState,
  Actor,
  CURRENT_DURABLE_STATE_SCHEMA_VERSION,
  CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION,
  StateValidationError,
  SchemaVersionError,
  HistoryCorruptError,
  StorageError,
} from '../dist/index.js';

describe('Storage & Durable State Architecture (TASK-P1-03)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-storage-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ==========================================================================
  // SECTION A: Durable State Manager
  // ==========================================================================
  describe('A. Durable State Manager (.ai-manager/state/durable-state.json)', () => {
    it('should save and load a valid durable state with default values', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });
      assert.equal(await manager.exists(), false);

      const saved = await manager.save({
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      assert.equal(saved.schemaVersion, CURRENT_DURABLE_STATE_SCHEMA_VERSION);
      assert.equal(saved.currentLifecycleState, LifecycleState.INITIALIZING);
      assert.equal(saved.activeTaskId, null);
      assert.deepEqual(saved.completedTaskIds, []);
      assert.equal(saved.blockedState, null);
      assert.ok(saved.updatedAt);
      assert.equal(await manager.exists(), true);

      const loaded = await manager.load();
      assert.ok(loaded);
      assert.equal(loaded.schemaVersion, CURRENT_DURABLE_STATE_SCHEMA_VERSION);
      assert.equal(loaded.currentLifecycleState, LifecycleState.INITIALIZING);
      assert.equal(loaded.activeTaskId, null);
      assert.deepEqual(loaded.completedTaskIds, []);
    });

    it('should reject invalid lifecycle state string enum values (AC-P1-03-3)', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });

      await assert.rejects(
        async () => {
          await manager.save({
            currentLifecycleState: 'INVALID_STATE_NAME' as unknown as LifecycleState,
            activeTaskId: null,
            completedTaskIds: [],
            blockedState: null,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StateValidationError);
          assert.equal(err.code, 'ERR_STATE_VALIDATION');
          return true;
        }
      );
    });

    it('should reject missing required fields such as currentLifecycleState (AC-P1-03-3)', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });

      await assert.rejects(
        async () => {
          await manager.save({} as unknown as { currentLifecycleState: LifecycleState });
        },
        (err: unknown) => {
          assert.ok(err instanceof StateValidationError);
          return true;
        }
      );
    });

    it('should validate and persist full blocked_state data (AC-P1-03-4)', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });

      const blockedStateInput = {
        blockedTaskId: 'TASK-AUTH-001',
        blockedIteration: 2,
        blockedContextReference: 'ctx-hash-sha256-abc123',
        blockingReason: 'CONTRADICTORY_REQUIREMENTS: REQ-001 vs REQ-002',
        resumePoint: 'INSTRUCT_ANTIGRAVITY',
        metadata: { attemptedResolutions: 1 },
      };

      const saved = await manager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-AUTH-001',
        completedTaskIds: ['TASK-SETUP-001'],
        blockedState: blockedStateInput,
      });

      assert.ok(saved.blockedState);
      assert.equal(saved.blockedState.blockedTaskId, 'TASK-AUTH-001');
      assert.equal(saved.blockedState.blockedIteration, 2);
      assert.equal(saved.blockedState.blockedContextReference, 'ctx-hash-sha256-abc123');
      assert.equal(saved.blockedState.blockingReason, 'CONTRADICTORY_REQUIREMENTS: REQ-001 vs REQ-002');
      assert.equal(saved.blockedState.resumePoint, 'INSTRUCT_ANTIGRAVITY');

      // Verify on disk JSON format includes both snake_case and camelCase
      const diskContent = JSON.parse(await fs.promises.readFile(manager.filePath, 'utf8'));
      assert.equal(diskContent.blocked_state.blocked_task_id, 'TASK-AUTH-001');
      assert.equal(diskContent.blocked_state.blocked_iteration, 2);
      assert.equal(diskContent.blocked_state.blocked_context_reference, 'ctx-hash-sha256-abc123');
      assert.equal(diskContent.blocked_state.blocking_reason, 'CONTRADICTORY_REQUIREMENTS: REQ-001 vs REQ-002');
      assert.equal(diskContent.blocked_state.resume_point, 'INSTRUCT_ANTIGRAVITY');

      // Verify loading
      const loaded = await manager.load();
      assert.ok(loaded);
      assert.ok(loaded.blockedState);
      assert.equal(loaded.blockedState.blockedTaskId, 'TASK-AUTH-001');
      assert.equal(loaded.blockedState.blockedIteration, 2);
    });

    it('should support snake_case blocked_state inputs seamlessly (AC-P1-03-4)', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });

      const snakeInput = {
        blocked_task_id: 'TASK-AUTH-002',
        blocked_iteration: 1,
        blocked_context_reference: 'ref-ctx-99',
        blocking_reason: 'TEST_FAILURES',
        resume_point: 'IMPLEMENTATION',
      };

      const saved = await manager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-AUTH-002',
        completedTaskIds: [],
        blocked_state: snakeInput,
      });

      assert.ok(saved.blockedState);
      assert.equal(saved.blockedState.blockedTaskId, 'TASK-AUTH-002');
      assert.equal(saved.blockedState.blockedIteration, 1);
      assert.equal(saved.blockedState.blockedContextReference, 'ref-ctx-99');
    });

    it('should reject invalid blocked_state with negative iteration or missing resume point', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });

      await assert.rejects(
        async () => {
          await manager.save({
            currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
            activeTaskId: 'TASK-X',
            completedTaskIds: [],
            blockedState: {
              blockedTaskId: 'TASK-X',
              blockedIteration: -1, // invalid negative number
              blockedContextReference: 'ref',
              blockingReason: 'reason',
              resumePoint: 'point',
            },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StateValidationError);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // SECTION B: Local Runtime State & Separation
  // ==========================================================================
  describe('B. Local Runtime State (.ai-manager/state/local-runtime.json)', () => {
    it('should save and load valid local runtime state', async () => {
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempDir });
      assert.equal(await runtimeManager.exists(), false);

      const saved = await runtimeManager.save({
        processId: 12345,
        acquiredLock: true,
        activeAttempt: 1,
      });

      assert.equal(saved.schemaVersion, CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION);
      assert.equal(saved.processId, 12345);
      assert.equal(saved.acquiredLock, true);
      assert.equal(saved.activeAttempt, 1);
      assert.ok(saved.startedAt);
      assert.ok(saved.lastHeartbeat);

      const loaded = await runtimeManager.load();
      assert.ok(loaded);
      assert.equal(loaded.processId, 12345);
      assert.equal(loaded.acquiredLock, true);
      assert.equal(loaded.activeAttempt, 1);
    });

    it('should reject invalid local runtime state (missing processId)', async () => {
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempDir });

      await assert.rejects(
        async () => {
          await runtimeManager.save({
            acquiredLock: true,
            activeAttempt: 1,
          } as unknown as { processId: number; acquiredLock: boolean; activeAttempt: number });
        },
        (err: unknown) => {
          assert.ok(err instanceof StateValidationError);
          return true;
        }
      );
    });

    it('should maintain strict physical and semantic separation between durable-state and local-runtime', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempDir });
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempDir });

      assert.notEqual(durableManager.filePath, runtimeManager.filePath);
      assert.ok(durableManager.filePath.endsWith('durable-state.json'));
      assert.ok(runtimeManager.filePath.endsWith('local-runtime.json'));

      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-03',
        completedTaskIds: ['TASK-P1-01', 'TASK-P1-02'],
        blockedState: null,
      });

      await runtimeManager.save({
        processId: 9876,
        acquiredLock: true,
        activeAttempt: 3,
      });

      const durableData = await durableManager.load();
      const runtimeData = await runtimeManager.load();

      assert.ok(durableData);
      assert.ok(runtimeData);
      assert.equal(durableData.currentLifecycleState, LifecycleState.TASK_LOOP);
      assert.equal(runtimeData.processId, 9876);
      assert.equal((durableData as Record<string, unknown>).processId, undefined);
      assert.equal((runtimeData as Record<string, unknown>).currentLifecycleState, undefined);

      // Clearing runtime does not affect durable
      await runtimeManager.clear();
      assert.equal(await runtimeManager.exists(), false);
      assert.equal(await durableManager.exists(), true);
      assert.ok(await durableManager.load());
    });
  });

  // ==========================================================================
  // SECTION C: Atomic File Persistence (AC-P1-03-1)
  // ==========================================================================
  describe('C. Atomic File Persistence (AC-P1-03-1)', () => {
    it('should atomically write file replacing target cleanly', async () => {
      const target = path.join(tempDir, 'state', 'test.json');
      await atomicWriteJson(target, { v: 1 });
      const first = await readJsonFile<{ v: number }>(target);
      assert.deepEqual(first, { v: 1 });

      await atomicWriteJson(target, { v: 2 });
      const second = await readJsonFile<{ v: number }>(target);
      assert.deepEqual(second, { v: 2 });
    });

    it('should not destroy previous valid file if serialization fails', async () => {
      const target = path.join(tempDir, 'state', 'safe-state.json');
      await atomicWriteJson(target, { safe: 'initial' });

      // Create a circular structure that fails JSON.stringify
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await assert.rejects(
        async () => {
          await atomicWriteJson(target, circular);
        },
        (err: unknown) => {
          assert.ok(err instanceof StorageError);
          assert.equal(err.code, 'ERR_STORAGE_IO');
          return true;
        }
      );

      // Previous file must be completely intact
      const preserved = await readJsonFile<{ safe: string }>(target);
      assert.deepEqual(preserved, { safe: 'initial' });
    });

    it('should clean up temporary files and not leave orphaned artifacts', async () => {
      const stateDir = path.join(tempDir, 'state');
      const target = path.join(stateDir, 'durable-state.json');
      const manager = new DurableStateManager({ filePath: target });

      await manager.save({
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      const files = await fs.promises.readdir(stateDir);
      // Only target file should exist; no .tmp files
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      assert.equal(tmpFiles.length, 0);
      assert.deepEqual(files, ['durable-state.json']);
    });
  });

  // ==========================================================================
  // SECTION D: Append-only History Manager (AC-P1-03-2)
  // ==========================================================================
  describe('D. Append-only History Manager (AC-P1-03-2)', () => {
    it('should append valid events and preserve sequential order', async () => {
      const historyManager = new HistoryManager({ baseDir: tempDir });
      assert.equal(await historyManager.exists(), false);

      const e1 = await historyManager.appendEvent({
        eventType: 'TASK_STARTED',
        actor: Actor.ORCHESTRATOR,
        taskId: 'TASK-P1-03',
        payload: { attempt: 1 },
      });

      const e2 = await historyManager.appendEvent({
        eventType: 'TEST_PASSED',
        actor: Actor.EXECUTOR,
        taskId: 'TASK-P1-03',
        payload: { testsPassed: 40 },
      });

      const e3 = await historyManager.appendEvent({
        eventType: 'TASK_COMPLETED',
        actor: Actor.DIRECTOR,
        taskId: 'TASK-P1-03',
        payload: { verdict: 'ACCEPTED' },
      });

      assert.equal(await historyManager.exists(), true);
      const events = await historyManager.readEvents();
      assert.equal(events.length, 3);
      assert.equal(events[0].eventId, e1.eventId);
      assert.equal(events[0].eventType, 'TASK_STARTED');
      assert.equal(events[1].eventId, e2.eventId);
      assert.equal(events[1].eventType, 'TEST_PASSED');
      assert.equal(events[2].eventId, e3.eventId);
      assert.equal(events[2].eventType, 'TASK_COMPLETED');
    });

    it('should guarantee existing events remain unchanged upon new appends', async () => {
      const historyManager = new HistoryManager({ baseDir: tempDir });

      await historyManager.appendEvent({
        eventId: 'FIXED-UUID-1',
        eventType: 'EVENT_ONE',
        actor: Actor.USER,
        payload: { count: 1 },
      });

      const afterFirst = await fs.promises.readFile(historyManager.historyPath, 'utf8');

      await historyManager.appendEvent({
        eventId: 'FIXED-UUID-2',
        eventType: 'EVENT_TWO',
        actor: Actor.ORCHESTRATOR,
        payload: { count: 2 },
      });

      const afterSecond = await fs.promises.readFile(historyManager.historyPath, 'utf8');
      assert.ok(afterSecond.startsWith(afterFirst));
    });

    it('should reject invalid event on append (invalid actor)', async () => {
      const historyManager = new HistoryManager({ baseDir: tempDir });

      await assert.rejects(
        async () => {
          await historyManager.appendEvent({
            eventType: 'INVALID_EVENT',
            actor: 'NON_EXISTENT_ACTOR' as unknown as Actor,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof StorageError);
          return true;
        }
      );
    });

    it('should throw HistoryCorruptError deterministically on malformed JSON line', async () => {
      const historyManager = new HistoryManager({ baseDir: tempDir });

      await historyManager.appendEvent({
        eventType: 'VALID_EVENT',
        actor: Actor.USER,
      });

      // Inject a corrupt non-JSON line
      await fs.promises.appendFile(historyManager.historyPath, 'CORRUPT_NON_JSON_LINE\n', 'utf8');

      await assert.rejects(
        async () => {
          await historyManager.readEvents();
        },
        (err: unknown) => {
          assert.ok(err instanceof HistoryCorruptError);
          assert.equal(err.code, 'ERR_HISTORY_CORRUPT');
          assert.equal(err.lineNumber, 2);
          assert.equal(err.rawLine, 'CORRUPT_NON_JSON_LINE');
          return true;
        }
      );
    });

    it('should throw HistoryCorruptError on schema violation inside existing record', async () => {
      const historyManager = new HistoryManager({ baseDir: tempDir });

      await historyManager.appendEvent({
        eventType: 'VALID_EVENT',
        actor: Actor.USER,
      });

      // Inject a JSON line missing required actor field
      await fs.promises.appendFile(
        historyManager.historyPath,
        JSON.stringify({ eventId: 'bad-1', timestamp: new Date().toISOString(), eventType: 'TEST' }) + '\n',
        'utf8'
      );

      await assert.rejects(
        async () => {
          await historyManager.readEvents();
        },
        (err: unknown) => {
          assert.ok(err instanceof HistoryCorruptError);
          assert.equal(err.lineNumber, 2);
          return true;
        }
      );
    });

    it('should stream events sequentially using streamEvents generator', async () => {
      const historyManager = new HistoryManager({ baseDir: tempDir });
      await historyManager.appendEvent({ eventType: 'E1', actor: Actor.USER });
      await historyManager.appendEvent({ eventType: 'E2', actor: Actor.DIRECTOR });

      const streamed: string[] = [];
      for await (const event of historyManager.streamEvents()) {
        streamed.push(event.eventType);
      }
      assert.deepEqual(streamed, ['E1', 'E2']);
    });
  });

  // ==========================================================================
  // SECTION E: Schema Versioning & Validation
  // ==========================================================================
  describe('E. Schema Versioning & Malformed Data Handling', () => {
    it('should throw SchemaVersionError when durable state has unsupported schema version', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });

      // Save a future schema version directly
      await fs.promises.mkdir(path.dirname(manager.filePath), { recursive: true });
      await fs.promises.writeFile(
        manager.filePath,
        JSON.stringify({
          schemaVersion: 99,
          currentLifecycleState: LifecycleState.INITIALIZING,
          activeTaskId: null,
          completedTaskIds: [],
          blockedState: null,
          updatedAt: new Date().toISOString(),
        }),
        'utf8'
      );

      await assert.rejects(
        async () => {
          await manager.load();
        },
        (err: unknown) => {
          assert.ok(err instanceof SchemaVersionError);
          assert.equal(err.code, 'ERR_SCHEMA_VERSION');
          assert.equal(err.expectedVersion, 1);
          assert.equal(err.actualVersion, 99);
          return true;
        }
      );
    });

    it('should throw SchemaVersionError when local runtime state has unsupported version', async () => {
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempDir });

      await fs.promises.mkdir(path.dirname(runtimeManager.filePath), { recursive: true });
      await fs.promises.writeFile(
        runtimeManager.filePath,
        JSON.stringify({
          schemaVersion: 5,
          processId: 100,
          acquiredLock: true,
          activeAttempt: 1,
          startedAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        }),
        'utf8'
      );

      await assert.rejects(
        async () => {
          await runtimeManager.load();
        },
        (err: unknown) => {
          assert.ok(err instanceof SchemaVersionError);
          assert.equal(err.expectedVersion, 1);
          assert.equal(err.actualVersion, 5);
          return true;
        }
      );
    });

    it('should throw StateValidationError when durable state contains malformed non-object JSON', async () => {
      const manager = new DurableStateManager({ baseDir: tempDir });
      await fs.promises.mkdir(path.dirname(manager.filePath), { recursive: true });
      await fs.promises.writeFile(manager.filePath, JSON.stringify(['array', 'not', 'object']), 'utf8');

      await assert.rejects(
        async () => {
          await manager.load();
        },
        (err: unknown) => {
          assert.ok(err instanceof StateValidationError);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // SECTION F: Restart / Persistence Verification
  // ==========================================================================
  describe('F. Restart / Persistence Lifecycle Simulation', () => {
    it('should reconstruct identical validated state across fresh manager instances', async () => {
      const originalManager = new DurableStateManager({ baseDir: tempDir });
      const originalRuntime = new LocalRuntimeStateManager({ baseDir: tempDir });

      const blockedData = {
        blockedTaskId: 'TASK-P1-02',
        blockedIteration: 3,
        blockedContextReference: 'sha256:ref-999',
        blockingReason: 'REVIEW_REJECTION_ESCALATED',
        resumePoint: 'INSTRUCT_ANTIGRAVITY',
      };

      await originalManager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-P1-02',
        completedTaskIds: ['TASK-P1-01'],
        blockedState: blockedData,
      });

      await originalRuntime.save({
        processId: 4433,
        acquiredLock: true,
        activeAttempt: 3,
        blockedState: blockedData,
      });

      // Simulate system process exit and restart with fresh manager instances
      const restartedManager = new DurableStateManager({ baseDir: tempDir });
      const restartedRuntime = new LocalRuntimeStateManager({ baseDir: tempDir });

      const reloadedDurable = await restartedManager.load();
      const reloadedRuntime = await restartedRuntime.load();

      assert.ok(reloadedDurable);
      assert.ok(reloadedRuntime);

      assert.equal(reloadedDurable.currentLifecycleState, LifecycleState.BLOCKED_ON_HUMAN);
      assert.equal(reloadedDurable.activeTaskId, 'TASK-P1-02');
      assert.deepEqual(reloadedDurable.completedTaskIds, ['TASK-P1-01']);
      assert.ok(reloadedDurable.blockedState);
      assert.equal(reloadedDurable.blockedState.blockedTaskId, 'TASK-P1-02');
      assert.equal(reloadedDurable.blockedState.blockedIteration, 3);
      assert.equal(reloadedDurable.blockedState.resumePoint, 'INSTRUCT_ANTIGRAVITY');

      assert.equal(reloadedRuntime.processId, 4433);
      assert.equal(reloadedRuntime.activeAttempt, 3);
      assert.ok(reloadedRuntime.blockedState);
      assert.equal(reloadedRuntime.blockedState.blockedTaskId, 'TASK-P1-02');
    });
  });

  // ==========================================================================
  // SECTION G: Hybrid Memory / Spec Store (.ai-manager/spec/)
  // ==========================================================================
  describe('G. Hybrid Memory Spec Store (.ai-manager/spec/)', () => {
    it('should save and load requirements and decisions with Zod validation', async () => {
      const specStore = new SpecStore({ baseDir: tempDir });

      const reqs = await specStore.saveRequirements([
        {
          id: 'REQ-001',
          title: 'Deterministic State Machine',
          description: 'FSM must strictly prevent illegal jumps',
          authority: Actor.USER,
        },
      ]);
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0].id, 'REQ-001');
      assert.equal(reqs[0].status, 'LOCKED');

      const loadedReqs = await specStore.loadRequirements();
      assert.equal(loadedReqs.length, 1);
      assert.equal(loadedReqs[0].title, 'Deterministic State Machine');

      const decs = await specStore.saveDecisions([
        {
          id: 'DEC-005',
          title: 'Hybrid Memory Architecture',
          description: 'Durable state Git tracked, local runtime Git ignored',
          authority: Actor.DIRECTOR,
        },
      ]);
      assert.equal(decs.length, 1);
      assert.equal(decs[0].id, 'DEC-005');
      assert.equal(decs[0].status, 'LOCKED');

      const loadedDecs = await specStore.loadDecisions();
      assert.equal(loadedDecs.length, 1);
      assert.equal(loadedDecs[0].id, 'DEC-005');
    });

    it('should reject invalid requirement with missing title', async () => {
      const specStore = new SpecStore({ baseDir: tempDir });

      await assert.rejects(
        async () => {
          await specStore.saveRequirements([
            {
              id: 'REQ-002',
              title: '', // empty title violates min(1)
              description: 'Desc',
            },
          ]);
        },
        (err: unknown) => {
          assert.ok(err instanceof StateValidationError);
          return true;
        }
      );
    });
  });
});
