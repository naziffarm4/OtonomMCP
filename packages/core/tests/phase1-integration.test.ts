import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  StateMachine,
  TaskLoopStateMachine,
  VALID_LIFECYCLE_TRANSITIONS,
  VALID_TASK_LOOP_TRANSITIONS,
  LifecycleState,
  TaskLoopState,
  Actor,
  InvalidStateTransitionError,
  StateValidationError,
  StorageError,
  RecoveryError,
  DurableStateManager,
  LocalRuntimeStateManager,
  HistoryManager,
  L0Database,
  L0Indexer,
  computeFileSha256,
  RecoveryEngine,
  RecoveryDecision,
  evaluateRecoveryDecision,
  type DeterministicDecisionData,
} from '../dist/index.js';

describe('Phase 1 Comprehensive Integration Test Suite (TASK-P1-06)', () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-phase1-int-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup errors
    }
  });

  // ==========================================================================
  // I1 — FSM + Durable State Integration
  // ==========================================================================
  describe('I1 — FSM + Durable State Integration', () => {
    it('I1.1: should advance FSM through lifecycle, persist to durable state, and survive process boundary', async () => {
      // 1. Initialize FSM at INITIALIZING and advance through authoritative lifecycle path
      const fsm = new StateMachine();
      assert.equal(fsm.getState(), LifecycleState.INITIALIZING);

      fsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION);
      fsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC);
      fsm.transitionTo(LifecycleState.TASK_DECOMPOSITION);
      fsm.transitionTo(LifecycleState.TASK_SELECTION);
      fsm.transitionTo(LifecycleState.TASK_LOOP);
      assert.equal(fsm.getState(), LifecycleState.TASK_LOOP);

      // 2. Persist state via real DurableStateManager
      const durableManager1 = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager1.save({
        currentLifecycleState: fsm.getState(),
        activeTaskId: 'TASK-INT-I1',
        completedTaskIds: ['TASK-INIT-00'],
        blockedState: null,
        lastCheckpoint: 'checkpoint-i1-01',
        metadata: {
          contextReference: 'ctx-i1-ref',
          resumePoint: 'IMPLEMENTATION',
        },
      });

      // 3. Simulate new process: recreate DurableStateManager and load state
      const durableManager2 = new DurableStateManager({ baseDir: tempWorkspace });
      const loadedState = await durableManager2.load();

      assert.ok(loadedState !== null);
      assert.equal(loadedState.currentLifecycleState, LifecycleState.TASK_LOOP);
      assert.equal(loadedState.activeTaskId, 'TASK-INT-I1');
      assert.deepEqual(loadedState.completedTaskIds, ['TASK-INIT-00']);
      assert.equal(loadedState.lastCheckpoint, 'checkpoint-i1-01');
      assert.equal(loadedState.metadata?.contextReference, 'ctx-i1-ref');

      // 4. Initialize a new FSM from the restored durable state
      const restoredFsm = new StateMachine({ initialState: loadedState.currentLifecycleState });
      assert.equal(restoredFsm.getState(), LifecycleState.TASK_LOOP);

      // 5. Verify valid transition succeeds
      assert.ok(restoredFsm.canTransitionTo(LifecycleState.PROJECT_COMPLETE));
    });

    it('I1.2: should reject invalid lifecycle transitions on restored FSM with InvalidStateTransitionError', async () => {
      const fsm = new StateMachine({ initialState: LifecycleState.TASK_LOOP });

      // TASK_LOOP cannot directly jump back to INITIALIZING, REQUIREMENTS_INGESTION, etc.
      assert.equal(fsm.canTransitionTo(LifecycleState.INITIALIZING), false);
      assert.equal(fsm.canTransitionTo(LifecycleState.REQUIREMENTS_INGESTION), false);
      assert.equal(fsm.canTransitionTo(LifecycleState.ARCHITECTURE_SPEC), false);

      assert.throws(
        () => fsm.transitionTo(LifecycleState.INITIALIZING),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.fromState, LifecycleState.TASK_LOOP);
          assert.equal(err.toState, LifecycleState.INITIALIZING);
          return true;
        }
      );
    });

    it('I1.3: should reject persisting invalid lifecycle states to durable storage with StateValidationError', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });

      await assert.rejects(
        async () => {
          await durableManager.save({
            currentLifecycleState: 'NON_EXISTENT_STATE' as any,
            activeTaskId: null,
            completedTaskIds: [],
            blockedState: null,
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
  // I2 — History + State Recovery Integration
  // ==========================================================================
  describe('I2 — History + State Recovery Integration', () => {
    it('I2.1: should correlate active task durable state with append-only history stream across interruption', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const historyManager = new HistoryManager({ baseDir: tempWorkspace });

      // 1. Persist active task state
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I2',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-i2-start',
        metadata: {
          contextReference: 'ctx-i2',
          resumePoint: 'IMPLEMENTATION',
        },
      });

      // 2. Append sequential lifecycle/implementation events for this task
      await historyManager.appendEvent({
        eventId: 'evt-i2-01',
        timestamp: new Date().toISOString(),
        actor: Actor.ORCHESTRATOR,
        eventType: 'TASK_SELECTED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-INT-I2',
        payload: { attempt: 1 },
      });

      await historyManager.appendEvent({
        eventId: 'evt-i2-02',
        timestamp: new Date().toISOString(),
        actor: Actor.EXECUTOR,
        eventType: 'FILES_MODIFIED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-INT-I2',
        payload: {
          files: ['src/i2-feature.ts'],
        },
      });

      await historyManager.appendEvent({
        eventId: 'evt-i2-03',
        timestamp: new Date().toISOString(),
        actor: Actor.ORCHESTRATOR,
        eventType: 'BUILD_VERIFIED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-INT-I2',
        payload: {
          compilable: true,
          buildPassed: true,
          exitCode: 0,
        },
      });

      // 3. Create workspace file matching history modification
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'i2-feature.ts'), 'export const i2 = true;');

      // 4. Re-open via fresh RecoveryEngine instance (simulating process crash and recovery startup)
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      // Verify RecoveryEngine collected snapshot matches durable state and history events
      assert.equal(snapshot.durableState?.activeTaskId, 'TASK-INT-I2');
      assert.equal(snapshot.historyEvents.length, 3);
      assert.equal(snapshot.lastEvent?.eventId, 'evt-i2-03');

      // Verify task scope was properly derived from active task's history events
      assert.ok(snapshot.taskScope?.includes('src/i2-feature.ts'));
      assert.ok(snapshot.validationEvidence?.compilable === true);
      assert.ok(snapshot.validationEvidence?.buildPassed === true);

      // 5. Reconcile should produce RESUME
      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-INT-I2');
      assert.equal(result.resumePoint, 'IMPLEMENTATION');

      recoveryEngine.close();
    });

    it('I2.2: should not correlate events from previous tasks with current active task attribution', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const historyManager = new HistoryManager({ baseDir: tempWorkspace });

      // Append event for previous task
      await historyManager.appendEvent({
        eventId: 'evt-old-task',
        timestamp: new Date().toISOString(),
        actor: Actor.EXECUTOR,
        eventType: 'FILES_MODIFIED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-OLD-PREVIOUS',
        payload: {
          files: ['src/old-file.ts'],
        },
      });

      // Current task is different
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-CURRENT-ACTIVE',
        completedTaskIds: ['TASK-OLD-PREVIOUS'],
        blockedState: null,
        lastCheckpoint: 'checkpoint-i2-prev',
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      // 'src/old-file.ts' must NOT be in current task scope
      assert.ok(!snapshot.taskScope?.includes('src/old-file.ts'));

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // I3 — Corrupted Durable State Handling
  // ==========================================================================
  describe('I3 — Corrupted Durable State Handling', () => {
    it('I3.1: should detect raw file corruption in durable-state.json and fail recovery deterministically', async () => {
      const stateDir = path.join(tempWorkspace, '.ai-manager', 'state');
      await fs.promises.mkdir(stateDir, { recursive: true });

      // Write corrupted non-JSON content
      await fs.promises.writeFile(
        path.join(stateDir, 'durable-state.json'),
        '<<< CORRUPTED NON-JSON CONTENT >>>'
      );

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await assert.rejects(
        async () => {
          await durableManager.load();
        },
        (err: unknown) => {
          assert.ok(err instanceof StorageError || err instanceof StateValidationError);
          return true;
        }
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      await assert.rejects(
        async () => {
          await recoveryEngine.collectSnapshot();
        },
        (err: unknown) => {
          assert.ok(err instanceof RecoveryError);
          assert.equal(err.category, 'UNREADABLE_DURABLE_STATE');
          return true;
        }
      );

      recoveryEngine.close();
    });

    it('I3.2: should detect schema violation in durable-state.json and reject it', async () => {
      const stateDir = path.join(tempWorkspace, '.ai-manager', 'state');
      await fs.promises.mkdir(stateDir, { recursive: true });

      // Write valid JSON with invalid schema fields
      await fs.promises.writeFile(
        path.join(stateDir, 'durable-state.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          currentLifecycleState: 'INVALID_LIFECYCLE_STATE',
          activeTaskId: null,
          completedTaskIds: 'not-an-array',
        })
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      await assert.rejects(
        async () => {
          await recoveryEngine.reconcile();
        },
        (err: unknown) => {
          assert.ok(err instanceof RecoveryError);
          assert.equal(err.category, 'UNREADABLE_DURABLE_STATE');
          return true;
        }
      );

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // I4 — SQLite L0 Hash Synchronization
  // ==========================================================================
  describe('I4 — SQLite L0 Hash Synchronization', () => {
    it('I4.1: should index files, detect hash modifications deterministically, and synchronize L0 cache', async () => {
      // 1. Create files in workspace
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.mkdir(path.join(tempWorkspace, 'config'), { recursive: true });

      const fileA = path.join(tempWorkspace, 'src', 'moduleA.ts');
      const fileB = path.join(tempWorkspace, 'src', 'moduleB.ts');
      const fileC = path.join(tempWorkspace, 'config', 'settings.json');

      await fs.promises.writeFile(fileA, 'export const a = 1;');
      await fs.promises.writeFile(fileB, 'export const b = 2;');
      await fs.promises.writeFile(fileC, '{"env": "test"}');

      // 2. Initial index through real L0Indexer
      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      const initialStats = await indexer.sync();
      assert.equal(initialStats.totalIndexed, 3);
      assert.equal(initialStats.new.length, 3);

      const db = new L0Database({
        dbPath: path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db'),
      });
      db.open();
      const recordsBefore = db.getAllFiles();
      assert.equal(recordsBefore.length, 3);

      const recordA = recordsBefore.find((r) => r.path === 'src/moduleA.ts');
      assert.ok(recordA);
      const initialHashA = recordA.sha256;

      // 3. Modify moduleA.ts
      await fs.promises.writeFile(fileA, 'export const a = 2; // modified content');
      const expectedNewHashA = await computeFileSha256(fileA);
      assert.notEqual(initialHashA, expectedNewHashA);

      // 4. Re-sync through L0Indexer
      const secondStats = await indexer.sync();
      assert.equal(secondStats.totalIndexed, 3);
      assert.equal(secondStats.modified.length, 1);
      assert.equal(secondStats.new.length, 0);
      assert.equal(secondStats.removed.length, 0);

      // 5. Verify database record updated deterministically
      const recordAAfter = db.getFile('src/moduleA.ts');
      assert.ok(recordAAfter);
      assert.equal(recordAAfter.sha256, expectedNewHashA);

      // 6. Verify untouched files did not change hashes
      const recordBAfter = db.getFile('src/moduleB.ts');
      assert.ok(recordBAfter);
      const expectedHashB = await computeFileSha256(fileB);
      assert.equal(recordBAfter.sha256, expectedHashB);

      db.close();
      indexer.close();
    });
  });

  // ==========================================================================
  // I5 — Recovery + L0 (Attributable Progress with Validation Evidence)
  // ==========================================================================
  describe('I5 — Recovery + L0', () => {
    it('I5.1: should detect L0/disk difference, verify task attribution and fresh validation evidence, producing RESUME', async () => {
      // 1. Workspace setup with initial files
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const servicePath = path.join(tempWorkspace, 'src', 'service.ts');
      await fs.promises.writeFile(servicePath, 'export class Service { run() { return 1; } }');

      // 2. Index baseline with L0Indexer
      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // 3. Update file with sound implementation progress
      const newServiceContent = 'export class Service { run() { return 2; } step2() { return true; } }';
      await fs.promises.writeFile(servicePath, newServiceContent);
      const currentServiceHash = await computeFileSha256(servicePath);

      // 4. Save durable state with active task and positive validation evidence bound to current hash
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I5',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-known-good-i5',
        metadata: {
          taskScope: ['src/service.ts'],
          contextReference: 'ctx-i5-valid',
          resumePoint: 'IMPLEMENTATION',
          validationEvidence: {
            compilable: true,
            buildPassed: true,
            fileHashes: {
              'src/service.ts': currentServiceHash,
            },
          },
        },
      });

      // 5. Run RecoveryEngine (simulating Antigravity termination recovery)
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      // Verify diff categorization
      assert.ok(snapshot.filesystemDiff.expectedChanges.includes('src/service.ts'));
      assert.equal(snapshot.filesystemDiff.unexpectedExternalChanges.length, 0);
      assert.equal(snapshot.filesystemDiff.corruptedFiles.length, 0);

      // Verify decision
      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-INT-I5');
      assert.equal(result.resumePoint, 'IMPLEMENTATION');
      assert.equal(result.contextReference, 'ctx-i5-valid');
      assert.ok(result.reason.includes('valid partial progress (verified compilable)'));
      assert.ok(result.evidenceReferences?.includes('validation-evidence:verified'));

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // I6 — Recovery of Unsafe Workspace
  // ==========================================================================
  describe('I6 — Recovery of Unsafe Workspace', () => {
    it('I6.1: should produce RESTART when an indexed file is missing from disk', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const reqPath = path.join(tempWorkspace, 'src', 'required.ts');
      await fs.promises.writeFile(reqPath, 'export const req = true;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Delete the indexed file
      await fs.promises.unlink(reqPath);

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I6-MISSING',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-i6-missing-target',
        metadata: {
          taskScope: ['src/required.ts'],
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'chk-i6-missing-target');
      assert.equal(result.resumePoint, 'PRE_FLIGHT_CHECKPOINT');
      assert.ok(result.reason.includes('missing indexed files [src/required.ts]'));

      recoveryEngine.close();
    });

    it('I6.2: should produce RESTART when a file in task scope contains corruption or conflict markers', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const corruptPath = path.join(tempWorkspace, 'src', 'corrupt.ts');
      await fs.promises.writeFile(corruptPath, 'export const valid = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Write conflict marker corruption
      await fs.promises.writeFile(
        corruptPath,
        '<<<<<<< HEAD\nexport const corrupt = 1;\n=======\nother\n>>>>>>> branch'
      );

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I6-CORRUPT',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-i6-corrupt-target',
        metadata: {
          taskScope: ['src/corrupt.ts'],
          validationEvidence: { compilable: true },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'chk-i6-corrupt-target');
      assert.ok(result.reason.includes('corrupted/malformed files [src/corrupt.ts]'));

      recoveryEngine.close();
    });

    it('I6.3: should produce RESTART when validation evidence is absent for modified files', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const fPath = path.join(tempWorkspace, 'src', 'feature.ts');
      await fs.promises.writeFile(fPath, 'export const f = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Modify file without validation evidence
      await fs.promises.writeFile(fPath, 'export const f = 2; // sound code, but unvalidated');

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I6-NO-VALIDATION',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-i6-no-val-target',
        metadata: {
          taskScope: ['src/feature.ts'],
          // validationEvidence is omitted!
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'chk-i6-no-val-target');
      assert.ok(result.evidenceReferences?.includes('validation-evidence:absent'));

      recoveryEngine.close();
    });

    it('I6.4: should produce RESTART when validation evidence is stale due to post-build hash change', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const fPath = path.join(tempWorkspace, 'src', 'stale.ts');
      await fs.promises.writeFile(fPath, 'export const s = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Modify file on disk to a different hash than recorded in evidence
      await fs.promises.writeFile(fPath, 'export const s = 999; // post-verification edits');

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I6-STALE',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-i6-stale-target',
        metadata: {
          taskScope: ['src/stale.ts'],
          validationEvidence: {
            compilable: true,
            buildPassed: true,
            fileHashes: {
              'src/stale.ts': '0000000000000000000000000000000000000000000000000000000000000000',
            },
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'chk-i6-stale-target');
      assert.ok(result.evidenceReferences?.includes('validation-evidence:stale'));

      recoveryEngine.close();
    });

    it('I6.5: should produce RESTART when an unexpected external file modification occurs outside task scope', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const scopeFile = path.join(tempWorkspace, 'src', 'in-scope.ts');
      const externalFile = path.join(tempWorkspace, 'src', 'external.ts');

      await fs.promises.writeFile(scopeFile, 'export const inScope = 1;');
      await fs.promises.writeFile(externalFile, 'export const external = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Modify the external file outside of task scope
      await fs.promises.writeFile(externalFile, 'export const external = 2;');

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-INT-I6-EXT',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-i6-ext-target',
        metadata: {
          taskScope: ['src/in-scope.ts'], // ONLY in-scope is permitted!
          validationEvidence: { compilable: true },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.ok(snapshot.filesystemDiff.unexpectedExternalChanges.includes('src/external.ts'));

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'chk-i6-ext-target');

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // I7 — BLOCKED_ON_HUMAN Exact Resume (DEC-010)
  // ==========================================================================
  describe('I7 — BLOCKED_ON_HUMAN Exact Resume', () => {
    it('I7.1: should preserve exact blocked state and resume without attempt increment upon user response', async () => {
      // 1. FSM enters BLOCKED_ON_HUMAN with exact blocked metadata
      const fsm = new StateMachine({ initialState: LifecycleState.REQUIREMENTS_INGESTION });
      const blockedPayload = {
        blockedTaskId: 'TASK-BLOCKED-I7',
        blockedIteration: 4,
        blockedContextReference: 'ctx-hash-blocked-77',
        blockingReason: 'Human approval required for architectural database migration strategy',
        resumePoint: 'INSTRUCT_ANTIGRAVITY',
      };
      fsm.blockOnHuman(blockedPayload);

      assert.equal(fsm.getState(), LifecycleState.BLOCKED_ON_HUMAN);
      assert.deepEqual(fsm.getBlockedState()?.blockedTaskId, 'TASK-BLOCKED-I7');
      assert.equal(fsm.getBlockedState()?.blockedIteration, 4);

      // 2. Persist to durable state
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-BLOCKED-I7',
        completedTaskIds: ['TASK-P1-01'],
        blockedState: fsm.getBlockedState(),
        lastCheckpoint: 'chk-pre-block-i7',
      });

      // 3. Before user response arrives -> recovery produces BLOCKED_ON_HUMAN
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const pendingResult = await recoveryEngine.reconcile();
      assert.equal(pendingResult.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.equal(pendingResult.taskId, 'TASK-BLOCKED-I7');
      assert.equal(pendingResult.iteration, 4);
      assert.equal(pendingResult.contextReference, 'ctx-hash-blocked-77');
      assert.equal(pendingResult.resumePoint, 'INSTRUCT_ANTIGRAVITY');
      assert.equal(pendingResult.targetCheckpoint, 'chk-pre-block-i7');

      // 4. Simulate human response arriving -> recovery produces exact RESUME (DEC-010)
      const resumeResult = await recoveryEngine.reconcile({
        userResponse: 'Approved: Proceed with SQLite WAL mode migration',
      });

      assert.equal(resumeResult.decision, RecoveryDecision.RESUME);
      assert.equal(resumeResult.taskId, 'TASK-BLOCKED-I7'); // Exact task preserved
      assert.equal(resumeResult.iteration, 4); // Exact iteration preserved, no increment!
      assert.equal(resumeResult.contextReference, 'ctx-hash-blocked-77'); // Exact context preserved
      assert.equal(resumeResult.resumePoint, 'INSTRUCT_ANTIGRAVITY'); // Exact resume point, no reselection!
      assert.ok(resumeResult.reason.includes('Human response received'));

      // 5. FSM resumes cleanly strictly via RESUME_EXACT_BLOCKED_POINT
      const resumeEvent = fsm.resumeFromHuman('Approved: Proceed with SQLite WAL mode migration');
      assert.equal(resumeEvent.toState, LifecycleState.RESUME_EXACT_BLOCKED_POINT);
      assert.equal(fsm.getState(), LifecycleState.RESUME_EXACT_BLOCKED_POINT);

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // I8 — Full Phase 1 Recovery Flow (End-to-End Component Interaction)
  // ==========================================================================
  describe('I8 — Full Phase 1 Recovery Flow', () => {
    it('I8.1: Full Success Path: FSM -> Durable State -> History -> L0 Indexer -> Implementation -> Reconcile -> RESUME', async () => {
      // Step 1: Initialize FSM & TaskLoop FSM
      const topFsm = new StateMachine();
      topFsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION);
      topFsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC);
      topFsm.transitionTo(LifecycleState.TASK_DECOMPOSITION);
      topFsm.transitionTo(LifecycleState.TASK_SELECTION);
      topFsm.transitionTo(LifecycleState.TASK_LOOP);

      const taskFsm = new TaskLoopStateMachine();
      taskFsm.transitionTo(TaskLoopState.PRE_FLIGHT_CHECKPOINT);
      taskFsm.transitionTo(TaskLoopState.INSTRUCT_ANTIGRAVITY);
      taskFsm.transitionTo(TaskLoopState.IMPLEMENTATION);

      // Step 2: Establish workspace and baseline L0 indexing
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const appFile = path.join(tempWorkspace, 'src', 'app.ts');
      await fs.promises.writeFile(appFile, 'export const version = "1.0.0";');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Step 3: Write durable state & history for the active task
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      const historyManager = new HistoryManager({ baseDir: tempWorkspace });
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });

      await durableManager.save({
        currentLifecycleState: topFsm.getState(),
        activeTaskId: 'TASK-E2E-SUCCESS',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-e2e',
        metadata: {
          taskScope: ['src/app.ts'],
          resumePoint: 'IMPLEMENTATION',
          contextReference: 'ctx-e2e-hash',
        },
      });

      await runtimeManager.save({
        processId: 777001,
        acquiredLock: true,
        activeAttempt: 1,
      });

      await historyManager.appendEvent({
        eventId: 'evt-e2e-01',
        timestamp: new Date().toISOString(),
        actor: Actor.ORCHESTRATOR,
        eventType: 'TASK_SELECTED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-E2E-SUCCESS',
        payload: { attempt: 1 },
      });

      // Step 4: Implementation writes valid, sound progress to app.ts
      const updatedAppContent = 'export const version = "1.0.1"; export const initialized = true;';
      await fs.promises.writeFile(appFile, updatedAppContent);
      const appHash = await computeFileSha256(appFile);

      // Step 5: Record build verification in history and durable state
      await historyManager.appendEvent({
        eventId: 'evt-e2e-02',
        timestamp: new Date().toISOString(),
        actor: Actor.ORCHESTRATOR,
        eventType: 'BUILD_VERIFIED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-E2E-SUCCESS',
        payload: {
          compilable: true,
          buildPassed: true,
          exitCode: 0,
          fileHashes: {
            'src/app.ts': appHash,
          },
        },
      });

      // Step 6: Simulate process termination (PID 777001 dies, runtime lock stale)
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false, // Dead process
      });

      // Step 7: Recovery Engine executes full reconciliation across all 6 authoritative sources
      const snapshot = await recoveryEngine.collectSnapshot();

      assert.equal(snapshot.isRuntimeStale, true);
      assert.equal(snapshot.isProcessAlive, false);
      assert.ok(snapshot.filesystemDiff.expectedChanges.includes('src/app.ts'));
      assert.equal(snapshot.filesystemDiff.unexpectedExternalChanges.length, 0);
      assert.equal(snapshot.validationEvidence?.compilable, true);

      const decisionResult = await recoveryEngine.reconcile();

      assert.equal(decisionResult.decision, RecoveryDecision.RESUME);
      assert.equal(decisionResult.taskId, 'TASK-E2E-SUCCESS');
      assert.equal(decisionResult.iteration, 1);
      assert.equal(decisionResult.resumePoint, 'IMPLEMENTATION');
      assert.equal(decisionResult.contextReference, 'ctx-e2e-hash');
      assert.ok(decisionResult.reason.includes('valid partial progress (verified compilable)'));
      assert.ok(decisionResult.evidenceReferences?.includes('validation-evidence:verified'));

      // Step 8: Determinism verification — running evaluation repeatedly produces identical data
      const eval1: DeterministicDecisionData = evaluateRecoveryDecision(snapshot);
      const eval2: DeterministicDecisionData = evaluateRecoveryDecision(snapshot);
      assert.deepEqual(eval1, eval2);

      recoveryEngine.close();
    });

    it('I8.2: Full Unsafe Path: Interrupted implementation with broken workspace produces RESTART', async () => {
      // Step 1: Establish baseline workspace and index
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const coreFile = path.join(tempWorkspace, 'src', 'core.ts');
      await fs.promises.writeFile(coreFile, 'export const core = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Step 2: Durable state with active task
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-E2E-UNSAFE',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-unsafe-e2e',
        metadata: {
          taskScope: ['src/core.ts'],
          resumePoint: 'IMPLEMENTATION',
        },
      });

      // Step 3: File is corrupted during implementation (conflict markers)
      await fs.promises.writeFile(
        coreFile,
        '<<<<<<< HEAD\nexport const core = 99;\n=======\ncorrupt\n>>>>>>> branch'
      );

      // Step 4: Recovery Engine runs
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const decisionResult = await recoveryEngine.reconcile();

      assert.equal(decisionResult.decision, RecoveryDecision.RESTART);
      assert.equal(decisionResult.taskId, 'TASK-E2E-UNSAFE');
      assert.equal(decisionResult.targetCheckpoint, 'checkpoint-known-good-unsafe-e2e');
      assert.equal(decisionResult.resumePoint, 'PRE_FLIGHT_CHECKPOINT');
      assert.ok(decisionResult.reason.includes('corrupted/malformed files'));

      recoveryEngine.close();
    });

    it('I8.3: Full Determinism: Multiple independent engine runs produce strictly identical decision data', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      const detFile = path.join(tempWorkspace, 'src', 'det-e2e.ts');
      await fs.promises.writeFile(detFile, 'export const det = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      await fs.promises.writeFile(detFile, 'export const det = 2; export const ok = true;');
      const currentHash = await computeFileSha256(detFile);

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-E2E-DET',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-det-e2e',
        metadata: {
          taskScope: ['src/det-e2e.ts'],
          resumePoint: 'IMPLEMENTATION',
          validationEvidence: {
            compilable: true,
            buildPassed: true,
            fileHashes: {
              'src/det-e2e.ts': currentHash,
            },
          },
        },
      });

      // Engine 1
      const engine1 = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });
      const res1 = await engine1.reconcile();
      engine1.close();

      // Engine 2 (completely new instance)
      const engine2 = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });
      const res2 = await engine2.reconcile();
      engine2.close();

      // Compare deterministic fields (excluding timestamp metadata)
      assert.equal(res1.decision, res2.decision);
      assert.equal(res1.reason, res2.reason);
      assert.equal(res1.taskId, res2.taskId);
      assert.equal(res1.iteration, res2.iteration);
      assert.equal(res1.contextReference, res2.contextReference);
      assert.equal(res1.resumePoint, res2.resumePoint);
      assert.equal(res1.targetCheckpoint, res2.targetCheckpoint);
      assert.deepEqual(res1.evidenceReferences, res2.evidenceReferences);
    });
  });
});
