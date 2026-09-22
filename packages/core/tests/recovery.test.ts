import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  RecoveryEngine,
  RecoveryDecision,
  DurableStateManager,
  LocalRuntimeStateManager,
  HistoryManager,
  L0Database,
  L0Indexer,
  LifecycleState,
  Actor,
  RecoveryError,
  scanWorkspaceFiles,
  shouldIgnorePath,
  evaluateRecoveryDecision,
  RecoveryFileChangeType,
  computeFileSha256,
  type DeterministicDecisionData,
} from '../dist/index.js';

describe('Recovery & Reconciliation Foundation (TASK-P1-05)', () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-recovery-test-'));
  });

  afterEach(async () => {
    if (tempWorkspace) {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ==========================================================================
  // SECTION A: Clean Interrupted Execution -> RESUME (AC-P1-05-1)
  // ==========================================================================
  describe('A. Clean Interrupted Execution -> RESUME (AC-P1-05-1)', () => {
    it('should deterministically produce RESUME preserving exact task, attempt, and context', async () => {
      // 1. Setup workspace with valid file
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'app.ts'), 'export const app = 1;');

      // 2. Index with L0
      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // 3. Setup durable state (in progress task)
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-01',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-sha256-abc12345',
          resumePoint: 'IMPLEMENTATION',
        },
      });

      // 4. Setup runtime state with dead PID (simulating process crash)
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 999999, // guaranteed dead/stale PID
        acquiredLock: true,
        activeAttempt: 2,
      });

      // 5. Run Recovery Engine with mock liveness checker (PID 999999 is dead)
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-P1-01');
      assert.equal(result.iteration, 2);
      assert.equal(result.contextReference, 'ctx-sha256-abc12345');
      assert.equal(result.resumePoint, 'IMPLEMENTATION');
      assert.ok(result.reason.includes('consistent'));

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION B: Workspace Inconsistency -> RESTART (AC-P1-05-2)
  // ==========================================================================
  describe('B. Workspace Inconsistency -> RESTART (AC-P1-05-2)', () => {
    it('should produce RESTART when unexpected file modification occurs', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'core.ts'), 'original code');

      // 1. Index baseline in L0
      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // 2. Setup durable state
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-02',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-001',
      });

      // 3. Corrupt/modify file on disk without indexing
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'core.ts'), 'CORRUPTED SYNTAX ERROR');

      // 4. Run Recovery Engine
      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.taskId, 'TASK-P1-02');
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-001');
      assert.ok(result.reason.includes('unexpected modified files [src/core.ts]'));

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION C: Retryable Failure -> RETRY
  // ==========================================================================
  describe('C. Retryable Failure -> RETRY', () => {
    it('should produce RETRY when workspace is consistent and state/history indicates retryable failure', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'index.ts'), 'clean code');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-03',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          retryableFailure: true,
          contextReference: 'ctx-ref-003',
        },
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 888888,
        acquiredLock: false,
        activeAttempt: 1,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RETRY);
      assert.equal(result.taskId, 'TASK-P1-03');
      assert.equal(result.iteration, 1);
      assert.equal(result.contextReference, 'ctx-ref-003');
      assert.equal(result.resumePoint, 'INSTRUCT_ANTIGRAVITY');

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION D: BLOCKED_ON_HUMAN Exact Resume (AC-P1-05-3)
  // ==========================================================================
  describe('D. BLOCKED_ON_HUMAN Exact Resume (AC-P1-05-3)', () => {
    it('should preserve exact blocked task, iteration, context, and resume point', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'AUTH-003',
        completedTaskIds: ['AUTH-001', 'AUTH-002'],
        blockedState: {
          blockedTaskId: 'AUTH-003',
          blockedIteration: 2,
          blockedContextReference: 'ctx-hash-8f4a9b1c',
          blockingReason: 'CONTRADICTORY_REQUIREMENTS: REQ-004 vs REQ-007',
          resumePoint: 'INSTRUCT_ANTIGRAVITY',
        },
        lastCheckpoint: 'chk-auth-002',
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 777777,
        acquiredLock: true,
        activeAttempt: 2,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.equal(result.taskId, 'AUTH-003');
      assert.equal(result.iteration, 2);
      assert.equal(result.contextReference, 'ctx-hash-8f4a9b1c');
      assert.equal(result.resumePoint, 'INSTRUCT_ANTIGRAVITY');
      assert.ok(result.reason.includes('CONTRADICTORY_REQUIREMENTS'));

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION E: Stale Runtime Process Lock Detection
  // ==========================================================================
  describe('E. Stale Runtime Process Lock Detection', () => {
    it('should detect stale runtime lock without permanently blocking recovery', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.REQUIREMENTS_INGESTION,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 112233,
        acquiredLock: true,
        activeAttempt: 1,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: (pid) => pid !== 112233, // PID 112233 is dead
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.equal(snapshot.isRuntimeStale, true);
      assert.equal(snapshot.isProcessAlive, false);

      const result = await recoveryEngine.reconcile();
      // Must not be stuck in an error or infinite lock loop
      assert.equal(result.decision, RecoveryDecision.RESUME);

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION F: Corrupt Durable State Handling
  // ==========================================================================
  describe('F. Corrupt Durable State Handling', () => {
    it('should throw deterministic RecoveryError when durable state is corrupt', async () => {
      const durablePath = path.join(tempWorkspace, '.ai-manager', 'state', 'durable-state.json');
      await fs.promises.mkdir(path.dirname(durablePath), { recursive: true });
      await fs.promises.writeFile(durablePath, 'INVALID_CORRUPT_JSON_DATA', 'utf8');

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      await assert.rejects(
        async () => {
          await recoveryEngine.reconcile();
        },
        (err: unknown) => {
          assert.ok(err instanceof RecoveryError);
          assert.equal(err.code, 'ERR_RECOVERY');
          return true;
        }
      );

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION G: Corrupt History Stream Handling
  // ==========================================================================
  describe('G. Corrupt History Stream Handling', () => {
    it('should throw deterministic RecoveryError with category CORRUPT_HISTORY on malformed events.jsonl', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      const historyPath = path.join(tempWorkspace, '.ai-manager', 'history', 'events.jsonl');
      await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.promises.writeFile(historyPath, 'CORRUPT_NON_JSON_EVENT_LINE\n', 'utf8');

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      await assert.rejects(
        async () => {
          await recoveryEngine.reconcile();
        },
        (err: unknown) => {
          assert.ok(err instanceof RecoveryError);
          assert.equal(err.code, 'ERR_RECOVERY');
          assert.equal(err.category, 'CORRUPT_HISTORY');
          return true;
        }
      );

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION H: Missing Indexed File Handling
  // ==========================================================================
  describe('H. Missing Indexed File Handling', () => {
    it('should detect missing indexed file and produce RESTART decision', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'deleted.ts'), 'will be deleted');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-04',
        completedTaskIds: [],
        blockedState: null,
      });

      // Physically delete the indexed file
      await fs.promises.unlink(path.join(tempWorkspace, 'src', 'deleted.ts'));

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.ok(result.reason.includes('missing indexed files [src/deleted.ts]'));

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION I: Unexpected New File Detection
  // ==========================================================================
  describe('I. Unexpected New File Detection', () => {
    it('should detect new untracked files in snapshot diff', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'existing.ts'), 'existing');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      // Add unexpected file
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'unexpected.ts'), 'unexpected');

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.deepEqual(snapshot.filesystemDiff.unexpectedAdded, ['src/unexpected.ts']);

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION J: Git Dirty State Observation
  // ==========================================================================
  describe('J. Git Dirty State Observation', () => {
    it('should observe Git state without automatically treating every dirty tree as fatal corruption', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.ok(typeof snapshot.gitState.isClean === 'boolean');

      const result = await recoveryEngine.reconcile();
      // Initializing state with consistent workspace produces RESUME
      assert.equal(result.decision, RecoveryDecision.RESUME);

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION K: Determinism
  // ==========================================================================
  describe('K. Determinism Verification', () => {
    it('should produce identical decision results across multiple invocations with identical inputs', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-DETERMINISM',
        completedTaskIds: ['P1-01'],
        blockedState: null,
        metadata: {
          contextReference: 'ref-det-1',
          resumePoint: 'ANALYSIS',
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const run1 = await recoveryEngine.reconcile();
      const run2 = await recoveryEngine.reconcile();

      assert.equal(run1.decision, run2.decision);
      assert.equal(run1.reason, run2.reason);
      assert.equal(run1.taskId, run2.taskId);
      assert.equal(run1.iteration, run2.iteration);
      assert.equal(run1.contextReference, run2.contextReference);
      assert.equal(run1.resumePoint, run2.resumePoint);

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION L: Restart Persistence
  // ==========================================================================
  describe('L. Restart Persistence', () => {
    it('should produce identical recovery results across fresh engine instances', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-PERSIST',
        completedTaskIds: [],
        blockedState: {
          blockedTaskId: 'TASK-PERSIST',
          blockedIteration: 1,
          blockedContextReference: 'ctx-persist-99',
          blockingReason: 'HUMAN_INPUT_NEEDED',
          resumePoint: 'RESUME_EXACT_BLOCKED_POINT',
        },
      });

      const engine1 = new RecoveryEngine({ workspaceRoot: tempWorkspace });
      const result1 = await engine1.reconcile();
      engine1.close();

      // Completely fresh engine instance
      const engine2 = new RecoveryEngine({ workspaceRoot: tempWorkspace });
      const result2 = await engine2.reconcile();
      engine2.close();

      assert.equal(result1.decision, result2.decision);
      assert.equal(result1.taskId, result2.taskId);
      assert.equal(result1.iteration, result2.iteration);
      assert.equal(result1.contextReference, result2.contextReference);
      assert.equal(result1.resumePoint, result2.resumePoint);
    });
  });

  // ==========================================================================
  // SECTION M: Explicit Correction Pass Verifications (TEST 1 - TEST 8)
  // ==========================================================================
  describe('M. Explicit Correction Pass Verifications (TEST 1 - TEST 8)', () => {
    // TEST 1 — ACCEPTED P1-04 BEHAVIOR
    it('TEST 1: should verify scanner.ts retains accepted P1-04 behavior and .ai-manager is handled at caller level', async () => {
      // P1-04 accepted behavior: .git and node_modules are in DEFAULT_IGNORED_SEGMENTS;
      // .ai-manager/cache is ignored, but general .ai-manager paths are not ignored by default.
      assert.equal(shouldIgnorePath('.git/HEAD'), true);
      assert.equal(shouldIgnorePath('node_modules/pkg/index.js'), true);
      assert.equal(shouldIgnorePath('.ai-manager/cache/context.db'), true);
      assert.equal(shouldIgnorePath('.ai-manager/state/durable-state.json'), false);

      // Caller level ignore (as used in RecoveryEngine):
      assert.equal(shouldIgnorePath('.ai-manager/state/durable-state.json', ['.ai-manager']), true);
    });

    // TEST 2 — INTERRUPTED IMPLEMENTATION WITH VALID PARTIAL PROGRESS (DEC-011)
    it('TEST 2: should produce RESUME with exact task, iteration, context, and resume point on valid partial progress', async () => {
      // 1. Initial workspace setup and L0 indexing
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'app.ts'), 'export const app = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // 2. Active implementation task in TASK_LOOP
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-02',
        completedTaskIds: ['TASK-P1-01'],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-100',
        metadata: {
          contextReference: 'ctx-progress-active-42',
          resumePoint: 'IMPLEMENTATION',
          taskScope: ['src/app.ts', 'src/helper.ts'],
          validationEvidence: { compilable: true },
        },
      });

      // 3. Stale/dead runtime process (simulating Antigravity termination)
      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 999991,
        acquiredLock: true,
        activeAttempt: 2,
      });

      // 4. Simulate interrupted implementation: files modified/added with valid sound code
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'app.ts'),
        'export const app = 1; export const extraFeature = true;'
      );
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'helper.ts'),
        'export function helper(): number { return 42; }'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false, // dead process
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-P1-02');
      assert.equal(result.iteration, 2); // No attempt increment!
      assert.equal(result.contextReference, 'ctx-progress-active-42');
      assert.equal(result.resumePoint, 'IMPLEMENTATION');
      assert.ok(result.reason.includes('valid partial progress'));

      recoveryEngine.close();
    });

    // TEST 3 — INTERRUPTED IMPLEMENTATION WITH CORRUPTED WORKSPACE
    it('TEST 3: should produce RESTART and identify target checkpoint when workspace is corrupted/malformed', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'service.ts'), 'export const service = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-03',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-200',
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 999992,
        acquiredLock: true,
        activeAttempt: 1,
      });

      // Corrupt file with syntax error / conflict markers
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'service.ts'),
        '<<<<<<< HEAD\nSYNTAX ERROR MALFORMED\n=======\n>>>>>>> branch'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.taskId, 'TASK-P1-03');
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-200');
      assert.ok(result.reason.includes('corrupted') || result.reason.includes('inconsistent'));

      recoveryEngine.close();
    });

    // TEST 4 — HASH DIFFERENCE ALONE
    it('TEST 4: should not automatically return RESTART when hash differs if implementation progress is sound', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'mod.ts'), 'export const v = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-P1-04',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          taskScope: ['src/mod.ts'],
          validationEvidence: { compilable: true },
        },
      });

      // Change content to sound code (causing L0 hash diff)
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'mod.ts'), 'export const v = 2;');

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      // Hash difference alone must not force RESTART!
      assert.notEqual(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.decision, RecoveryDecision.RESUME);

      recoveryEngine.close();
    });

    // TEST 5 — DIRTY GIT ALONE
    it('TEST 5: should verify dirty Git state alone does not imply RESTART', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Even if gitState has untracked or modified files, it does not force RESTART
      const decisionData = evaluateRecoveryDecision({
        ...snapshot,
        gitState: {
          isRepository: true,
          currentHead: 'commit-hash-abc',
          isClean: false,
          stagedFiles: ['src/staged.ts'],
          unstagedFiles: ['src/unstaged.ts'],
          untrackedFiles: ['src/untracked.ts'],
        },
      });

      assert.notEqual(decisionData.decision, RecoveryDecision.RESTART);
      assert.equal(decisionData.decision, RecoveryDecision.RESUME);

      recoveryEngine.close();
    });

    // TEST 6 — BLOCKED HUMAN EXACT RESUME (DEC-010)
    it('TEST 6: should preserve exact blocked state and resume exact point after user response arrives', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-BLOCKED-42',
        completedTaskIds: ['TASK-P1-01'],
        blockedState: {
          blockedTaskId: 'TASK-BLOCKED-42',
          blockedIteration: 3,
          blockedContextReference: 'ctx-blocked-hash-99',
          blockingReason: 'Waiting for architectural clarification on auth strategy',
          resumePoint: 'INSTRUCT_ANTIGRAVITY',
        },
        lastCheckpoint: 'chk-pre-block-10',
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      // 6A. Before human response arrives -> BLOCKED_ON_HUMAN
      const pendingResult = await recoveryEngine.reconcile();
      assert.equal(pendingResult.decision, RecoveryDecision.BLOCKED_ON_HUMAN);
      assert.equal(pendingResult.taskId, 'TASK-BLOCKED-42');
      assert.equal(pendingResult.iteration, 3);
      assert.equal(pendingResult.contextReference, 'ctx-blocked-hash-99');
      assert.equal(pendingResult.resumePoint, 'INSTRUCT_ANTIGRAVITY');

      // 6B. When human response is received -> RESUME at exact blocked point (DEC-010)
      const resumeResult = await recoveryEngine.reconcile({
        userResponse: 'Approved: proceed with OAuth2 adapter strategy',
      });
      assert.equal(resumeResult.decision, RecoveryDecision.RESUME);
      assert.equal(resumeResult.taskId, 'TASK-BLOCKED-42'); // Exact task preserved
      assert.equal(resumeResult.iteration, 3); // No attempt increment!
      assert.equal(resumeResult.contextReference, 'ctx-blocked-hash-99'); // Exact context preserved
      assert.equal(resumeResult.resumePoint, 'INSTRUCT_ANTIGRAVITY'); // Exact resume point, no task reselection!
      assert.ok(resumeResult.reason.includes('Human response received'));

      recoveryEngine.close();
    });

    // TEST 7 — DETERMINISTIC DECISION (DECISION VS TIMESTAMP)
    it('TEST 7: should produce strictly identical decision data across multiple evaluations excluding timestamp metadata', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-DET-007',
        completedTaskIds: [],
        blockedState: null,
        metadata: {
          contextReference: 'ctx-ref-det-7',
          resumePoint: 'IMPLEMENTATION',
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      // Evaluate pure function multiple times
      const eval1: DeterministicDecisionData = evaluateRecoveryDecision(snapshot);
      const eval2: DeterministicDecisionData = evaluateRecoveryDecision(snapshot);

      // Must be 100% deep strictly equal
      assert.deepEqual(eval1, eval2);

      // Reconcile attaches timestamp as observational metadata
      const rec1 = await recoveryEngine.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const rec2 = await recoveryEngine.reconcile();

      assert.equal(rec1.decision, rec2.decision);
      assert.equal(rec1.reason, rec2.reason);
      assert.equal(rec1.taskId, rec2.taskId);
      assert.equal(rec1.iteration, rec2.iteration);
      assert.equal(rec1.contextReference, rec2.contextReference);
      assert.equal(rec1.resumePoint, rec2.resumePoint);
      assert.equal(rec1.targetCheckpoint, rec2.targetCheckpoint);
      assert.deepEqual(rec1.evidenceReferences, rec2.evidenceReferences);

      // Timestamps are execution metadata, not part of deterministic decision data
      assert.ok(typeof rec1.timestamp === 'string');
      assert.ok(typeof rec2.timestamp === 'string');

      recoveryEngine.close();
    });

    // TEST 8 — STALE RUNTIME INFORMATION DOES NOT FORCE RESTART
    it('TEST 8: should verify dead/stale runtime process does not force RESTART but produces RESUME', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-STALE-PROC',
        completedTaskIds: [],
        blockedState: null,
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 888111,
        acquiredLock: true,
        activeAttempt: 1,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false, // Dead process -> isRuntimeStale: true
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.equal(snapshot.isRuntimeStale, true);

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.notEqual(result.decision, RecoveryDecision.RESTART);

      recoveryEngine.close();
    });
  });

  // ==========================================================================
  // SECTION N: Reliable Partial Progress vs Unrelated External Changes (TEST N1 - TEST N7)
  // ==========================================================================
  describe('N. Reliable Partial Progress vs Unrelated External Changes (TEST N1 - TEST N7)', () => {
    // TEST N1 — VALID IMPLEMENTATION CHANGE
    it('TEST N1: should return RESUME when changed files are attributable to interrupted implementation and compilable', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'feature.ts'), 'export const feature = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N1',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n1',
        metadata: {
          contextReference: 'ctx-n1-valid',
          resumePoint: 'IMPLEMENTATION',
          taskScope: ['src/feature.ts'],
          validationEvidence: { compilable: true, buildPassed: true },
        },
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 999901,
        acquiredLock: true,
        activeAttempt: 2,
      });

      // Valid implementation change in feature.ts (attributable to task)
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'feature.ts'),
        'export const feature = 1; export const step2 = true;'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false, // Antigravity termination
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-N1');
      assert.equal(result.iteration, 2); // Exact iteration preserved, no attempt increment!
      assert.equal(result.contextReference, 'ctx-n1-valid');
      assert.equal(result.resumePoint, 'IMPLEMENTATION');
      assert.ok(result.reason.includes('valid partial progress'));

      recoveryEngine.close();
    });

    // TEST N2 — UNRELATED EXTERNAL CHANGE DURING ACTIVE TASK
    it('TEST N2: must not blindly return RESUME when changed file is outside task scope and not attributable', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'allowed.ts'), 'export const allowed = 1;');
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'unrelated.ts'), 'export const unrelated = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N2',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n2',
        metadata: {
          contextReference: 'ctx-n2-scope',
          resumePoint: 'IMPLEMENTATION',
          taskScope: ['src/allowed.ts'], // ONLY allowed.ts is in scope!
        },
      });

      const runtimeManager = new LocalRuntimeStateManager({ baseDir: tempWorkspace });
      await runtimeManager.save({
        processId: 999902,
        acquiredLock: true,
        activeAttempt: 1,
      });

      // Modifying unrelated.ts (outside task scope, no corruption marker)
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'unrelated.ts'),
        'export const unrelated = 2; // cleanly modified outside scope'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      assert.ok(snapshot.filesystemDiff.unexpectedExternalChanges.includes('src/unrelated.ts'));

      const result = await recoveryEngine.reconcile();

      // Must NOT return RESUME! Safe deterministic recovery path is RESTART
      assert.notEqual(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n2');
      assert.ok(
        result.reason.includes('unexpected external modifications not attributable') ||
        result.reason.includes('unexpected modified files')
      );

      recoveryEngine.close();
    });

    // TEST N3 — VALID CHANGE BUT NO CORRUPTION MARKER
    it('TEST N3: must not classify file as reliable progress solely because it looks healthy when attribution is unavailable', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'component.ts'), 'export const c = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N3',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n3',
        metadata: {
          contextReference: 'ctx-n3',
          resumePoint: 'IMPLEMENTATION',
          // NO taskScope or attributable files specified!
        },
      });

      // Modifying component.ts with completely valid, healthy syntax (no corruption markers)
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'component.ts'),
        'export const c = 2; export const healthyFunction = () => true;'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      // Healthy-looking file without attribution must NOT be silently accepted as RESUME
      assert.notEqual(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n3');

      recoveryEngine.close();
    });

    // TEST N4 — MISSING REQUIRED FILE
    it('TEST N4: should produce RESTART when required/indexed file is missing even if active task exists', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'required.ts'), 'export const req = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N4',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n4',
        metadata: {
          taskScope: ['src/required.ts'],
        },
      });

      // Delete required file
      await fs.promises.unlink(path.join(tempWorkspace, 'src', 'required.ts'));

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n4');
      assert.ok(result.reason.includes('missing indexed files [src/required.ts]'));

      recoveryEngine.close();
    });

    // TEST N5 — CORRUPTED WORKSPACE
    it('TEST N5: should produce RESTART when file in task scope contains explicit corruption or conflict markers', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'corrupt.ts'), 'export const ok = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N5',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n5',
        metadata: {
          taskScope: ['src/corrupt.ts'],
        },
      });

      // Write corrupt content with conflict marker
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'corrupt.ts'),
        '<<<<<<< HEAD\ncorrupt content\n=======\nother\n>>>>>>> branch'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n5');
      assert.ok(result.reason.includes('corrupted/malformed files [src/corrupt.ts]'));

      recoveryEngine.close();
    });

    // TEST N6 — DIRTY GIT ALONE
    it('TEST N6: should verify dirty Git state alone does not automatically force RESTART', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.REQUIREMENTS_INGESTION,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      const decisionData = evaluateRecoveryDecision({
        ...snapshot,
        gitState: {
          isRepository: true,
          currentHead: 'commit-hash-n6',
          isClean: false,
          stagedFiles: ['package.json'],
          unstagedFiles: [],
          untrackedFiles: [],
        },
      });

      assert.notEqual(decisionData.decision, RecoveryDecision.RESTART);
      assert.equal(decisionData.decision, RecoveryDecision.RESUME);

      recoveryEngine.close();
    });

    // TEST N7 — DETERMINISM
    it('TEST N7: should produce identical deterministic decision data across repeated evaluations', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'det.ts'), 'export const d = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N7-DET',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'chk-det-n7',
        metadata: {
          taskScope: ['src/det.ts'],
          validationEvidence: { compilable: true },
        },
      });

      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'det.ts'), 'export const d = 2;');

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      const run1 = evaluateRecoveryDecision(snapshot);
      const run2 = evaluateRecoveryDecision(snapshot);

      assert.deepEqual(run1, run2);
      assert.equal(run1.decision, RecoveryDecision.RESUME);
      assert.equal(run1.taskId, 'TASK-N7-DET');

      recoveryEngine.close();
    });

    // TEST N8 — ABSENT VALIDATION EVIDENCE WITH ATTRIBUTABLE DISK CHANGES -> RESTART
    it('TEST N8: should produce RESTART when attributable implementation change exists but validation evidence is absent', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'feature.ts'), 'export const f = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N8',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n8',
        metadata: {
          taskScope: ['src/feature.ts'],
          resumePoint: 'IMPLEMENTATION',
          // NO validationEvidence!
        },
      });

      // Valid implementation change in feature.ts within task scope
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'feature.ts'),
        'export const f = 2; export const additional = true;'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      // Reliable continuation cannot be established without positive validation evidence
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n8');
      assert.equal(result.resumePoint, 'PRE_FLIGHT_CHECKPOINT');
      assert.ok(result.reason.includes('validation evidence is absent'));
      assert.ok(result.evidenceReferences?.includes('validation-evidence:absent'));

      recoveryEngine.close();
    });

    // TEST N9 — STALE VALIDATION EVIDENCE (FILE HASH MISMATCH) -> RESTART
    it('TEST N9: should produce RESTART when validation evidence is stale due to file hash mismatch', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'feature.ts'), 'export const f = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N9',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n9',
        metadata: {
          taskScope: ['src/feature.ts'],
          resumePoint: 'IMPLEMENTATION',
          validationEvidence: {
            compilable: true,
            buildPassed: true,
            fileHashes: {
              'src/feature.ts': '0000000000000000000000000000000000000000000000000000000000000000', // stale hash
            },
          },
        },
      });

      // Modified on disk
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'feature.ts'),
        'export const f = 3; export const updatedAfterBuild = true;'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n9');
      assert.equal(result.resumePoint, 'PRE_FLIGHT_CHECKPOINT');
      assert.ok(result.reason.includes('stale'));
      assert.ok(result.evidenceReferences?.includes('validation-evidence:stale'));

      recoveryEngine.close();
    });

    // TEST N10 — VALID CURRENT VALIDATION EVIDENCE (MATCHING FILE HASHES) -> RESUME
    it('TEST N10: should produce RESUME when validation evidence is fresh and matches current workspace file hashes', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'feature.ts'), 'export const f = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Modify file on disk
      const newContent = 'export const f = 2; export const validatedContent = true;';
      const filePath = path.join(tempWorkspace, 'src', 'feature.ts');
      await fs.promises.writeFile(filePath, newContent);

      const expectedHash = await computeFileSha256(filePath);

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N10',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n10',
        metadata: {
          taskScope: ['src/feature.ts'],
          resumePoint: 'IMPLEMENTATION',
          validationEvidence: {
            compilable: true,
            buildPassed: true,
            fileHashes: {
              'src/feature.ts': expectedHash,
            },
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const result = await recoveryEngine.reconcile();

      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-N10');
      assert.equal(result.resumePoint, 'IMPLEMENTATION');
      assert.ok(result.reason.includes('valid partial progress'));
      assert.ok(result.evidenceReferences?.includes('validation-evidence:verified'));

      recoveryEngine.close();
    });

    // TEST N11 — STRICT CURRENT-TASK ATTRIBUTION (UNRELATED TASK HISTORY IGNORED) -> RESTART
    it('TEST N11: should not attribute file from unrelated previous task history and produce RESTART', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'prev.ts'), 'export const prev = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      // Append history event belonging to an unrelated previous task
      const historyManager = new HistoryManager({ baseDir: tempWorkspace });
      await historyManager.appendEvent({
        eventId: 'evt-unrelated-01',
        timestamp: new Date().toISOString(),
        actor: Actor.ORCHESTRATOR,
        eventType: 'TASK_IMPLEMENTED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-OLD-UNRELATED',
        payload: {
          files: ['src/prev.ts'],
        },
      });

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-CURRENT-ACTIVE',
        completedTaskIds: ['TASK-OLD-UNRELATED'],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n11',
        metadata: {
          // Current task has no attribution for prev.ts!
          resumePoint: 'IMPLEMENTATION',
        },
      });

      // Modify prev.ts on disk
      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'prev.ts'),
        'export const prev = 2; // modified outside current task scope'
      );

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      // prev.ts must NOT be in expectedChanges; must be in unexpectedExternalChanges
      assert.ok(snapshot.filesystemDiff.unexpectedExternalChanges.includes('src/prev.ts'));
      assert.ok(!snapshot.filesystemDiff.expectedChanges.includes('src/prev.ts'));

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESTART);
      assert.equal(result.targetCheckpoint, 'checkpoint-known-good-n11');

      recoveryEngine.close();
    });

    // TEST N12 — CURRENT-TASK-SPECIFIC HISTORY ATTRIBUTION -> RESUME
    it('TEST N12: should attribute changes from history matching current active task and produce RESUME', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'task12.ts'), 'export const t = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const newContent = 'export const t = 2; export const task12Updated = true;';
      const filePath = path.join(tempWorkspace, 'src', 'task12.ts');
      await fs.promises.writeFile(filePath, newContent);
      const expectedHash = await computeFileSha256(filePath);

      // Append history event specifically for current active task
      const historyManager = new HistoryManager({ baseDir: tempWorkspace });
      await historyManager.appendEvent({
        eventId: 'evt-task12-scope',
        timestamp: new Date().toISOString(),
        actor: Actor.EXECUTOR,
        eventType: 'FILES_MODIFIED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-N12',
        payload: {
          files: ['src/task12.ts'],
        },
      });
      await historyManager.appendEvent({
        eventId: 'evt-task12-verified',
        timestamp: new Date().toISOString(),
        actor: Actor.ORCHESTRATOR,
        eventType: 'BUILD_VERIFIED',
        lifecycleState: LifecycleState.TASK_LOOP,
        taskId: 'TASK-N12',
        payload: {
          compilable: true,
          buildPassed: true,
          exitCode: 0,
          fileHashes: {
            'src/task12.ts': expectedHash,
          },
        },
      });

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N12',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n12',
        metadata: {
          resumePoint: 'IMPLEMENTATION',
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      // task12.ts must be attributed from history to expectedChanges
      assert.ok(snapshot.filesystemDiff.expectedChanges.includes('src/task12.ts'));
      assert.ok(snapshot.validationEvidence?.compilable === true);

      const result = await recoveryEngine.reconcile();
      assert.equal(result.decision, RecoveryDecision.RESUME);
      assert.equal(result.taskId, 'TASK-N12');

      recoveryEngine.close();
    });

    // TEST N13 — DIRTY GIT ALONE DOES NOT PREVENT RESUME WITH VALID PROGRESS
    it('TEST N13: should produce RESUME with valid implementation progress even if Git is dirty', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'feature13.ts'), 'export const f13 = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      await fs.promises.writeFile(
        path.join(tempWorkspace, 'src', 'feature13.ts'),
        'export const f13 = 2; export const progress = true;'
      );

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N13',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n13',
        metadata: {
          taskScope: ['src/feature13.ts'],
          resumePoint: 'IMPLEMENTATION',
          validationEvidence: {
            compilable: true,
            buildPassed: true,
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();
      // Simulate dirty Git state with unstaged, staged, untracked files
      const decisionData = evaluateRecoveryDecision({
        ...snapshot,
        gitState: {
          isRepository: true,
          currentHead: 'commit-hash-n13',
          isClean: false,
          stagedFiles: ['src/feature13.ts'],
          unstagedFiles: ['package.json'],
          untrackedFiles: ['scratch.txt'],
        },
      });

      assert.notEqual(decisionData.decision, RecoveryDecision.RESTART);
      assert.equal(decisionData.decision, RecoveryDecision.RESUME);
      assert.equal(decisionData.taskId, 'TASK-N13');

      recoveryEngine.close();
    });

    // TEST N14 — REPEATED EVALUATION DETERMINISM
    it('TEST N14: should produce strictly identical deterministic decision data across repeated evaluations of identical snapshots', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'det14.ts'), 'export const d14 = 1;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();
      indexer.close();

      const newContent = 'export const d14 = 2; export const confirmed = true;';
      const filePath = path.join(tempWorkspace, 'src', 'det14.ts');
      await fs.promises.writeFile(filePath, newContent);
      const fileHash = await computeFileSha256(filePath);

      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        activeTaskId: 'TASK-N14',
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: 'checkpoint-known-good-n14',
        metadata: {
          taskScope: ['src/det14.ts'],
          resumePoint: 'IMPLEMENTATION',
          validationEvidence: {
            compilable: true,
            buildPassed: true,
            fileHashes: {
              'src/det14.ts': fileHash,
            },
          },
        },
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const snapshot = await recoveryEngine.collectSnapshot();

      const eval1 = evaluateRecoveryDecision(snapshot);
      const eval2 = evaluateRecoveryDecision(snapshot);
      const eval3 = evaluateRecoveryDecision(snapshot);

      assert.deepEqual(eval1, eval2);
      assert.deepEqual(eval2, eval3);
      assert.equal(eval1.decision, RecoveryDecision.RESUME);
      assert.equal(eval1.taskId, 'TASK-N14');
      assert.equal(eval1.resumePoint, 'IMPLEMENTATION');
      assert.deepEqual(eval1.evidenceReferences, eval2.evidenceReferences);

      recoveryEngine.close();
    });
  });
});
