import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  ContextEngine,
  ContextInvalidator,
  ContextValidationAction,
  StaleFileStatus,
  ContextInvalidationError,
  ContextEngineError,
  AidmError,
  ContextIntent,
  computeFileSha256,
  L0Indexer,
  L0Database,
  RecoveryEngine,
  DurableStateManager,
  LifecycleState,
  TaskDagEngine,
  type ResolvedContext,
  type L1Context,
  type L2Context,
} from '../dist/index.js';

describe('Stale Context Invalidation Engine (TASK-P2-03)', () => {
  let tempWorkspace: string;
  let cacheDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-stale-ctx-'));
    cacheDir = path.join(tempWorkspace, '.ai-manager', 'cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    dbPath = path.join(cacheDir, 'context.db');
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Helper to create a source file in temp workspace
  async function createWorkspaceFile(relPath: string, content: string): Promise<string> {
    const fullPath = path.join(tempWorkspace, relPath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content, 'utf-8');
    return fullPath;
  }

  // ==========================================================================
  // MANDATORY VERIFICATION SCENARIOS (S1 - S21)
  // ==========================================================================

  describe('Mandatory Verification Scenarios (S1 - S21)', () => {
    // ------------------------------------------------------------------------
    // S1: Unchanged context remains valid
    // ------------------------------------------------------------------------
    it('S1: Unchanged context remains valid with action CONTINUE', async () => {
      const relPath = 'src/service.ts';
      await createWorkspaceFile(relPath, 'export function getService() { return "v1"; }');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, true);
      assert.equal(validation.action, ContextValidationAction.CONTINUE);
      assert.deepEqual(validation.affectedFiles, []);
      assert.ok(validation.reason.includes('match current disk'));

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S2: Single changed file produces CONTEXT_INVALIDATED
    // ------------------------------------------------------------------------
    it('S2: Single changed file produces CONTEXT_INVALIDATED and stops operation', async () => {
      const relPath = 'src/model.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export interface ModelV1 { id: string; }');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.CONTRACT,
      });

      // External edit occurs
      await fs.promises.writeFile(fullPath, 'export interface ModelV2 { id: string; version: 2; }', 'utf-8');

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, false);
      assert.equal(validation.action, ContextValidationAction.CONTEXT_INVALIDATED);
      assert.equal(validation.affectedFiles.length, 1);
      assert.equal(validation.affectedFiles[0].sourcePath, relPath);
      assert.equal(validation.affectedFiles[0].status, StaleFileStatus.MODIFIED);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S3: Old hash and current hash are both exposed
    // ------------------------------------------------------------------------
    it('S3: Invalidation result exposes both old hash and current hash', async () => {
      const relPath = 'src/hasher-test.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const ORIGINAL = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      const originalHash = context.items[0].fileHash;

      // Mutate disk content
      await fs.promises.writeFile(fullPath, 'export const MODIFIED = 2;', 'utf-8');
      const expectedNewHash = await computeFileSha256(fullPath);

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, false);
      assert.equal(validation.affectedFiles[0].oldHash, originalHash);
      assert.equal(validation.affectedFiles[0].currentHash, expectedNewHash);
      assert.notEqual(validation.affectedFiles[0].oldHash, validation.affectedFiles[0].currentHash);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S4: Missing/deleted context file produces invalidation
    // ------------------------------------------------------------------------
    it('S4: Deleted context file produces invalidation with status DELETED and currentHash null', async () => {
      const relPath = 'src/deleted-file.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const TO_BE_DELETED = true;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      const oldHash = context.items[0].fileHash;

      // Delete file from disk
      await fs.promises.unlink(fullPath);

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, false);
      assert.equal(validation.action, ContextValidationAction.CONTEXT_INVALIDATED);
      assert.equal(validation.affectedFiles.length, 1);
      assert.equal(validation.affectedFiles[0].sourcePath, relPath);
      assert.equal(validation.affectedFiles[0].oldHash, oldHash);
      assert.equal(validation.affectedFiles[0].currentHash, null);
      assert.equal(validation.affectedFiles[0].status, StaleFileStatus.DELETED);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S5: Multi-file context with one stale file invalidates entire context
    // ------------------------------------------------------------------------
    it('S5: Multi-file context with one stale file invalidates entire context', async () => {
      const fileA = 'src/stable.ts';
      const fileB = 'src/changing.ts';
      await createWorkspaceFile(fileA, 'export const STABLE = true;');
      const fullB = await createWorkspaceFile(fileB, 'export const CHANGING = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [fileA, fileB],
        intent: ContextIntent.METADATA,
      });

      // Modify only file B
      await fs.promises.writeFile(fullB, 'export const CHANGING = 2;', 'utf-8');

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, false, 'Entire multi-file context must be invalidated');
      assert.equal(validation.action, ContextValidationAction.CONTEXT_INVALIDATED);
      assert.equal(validation.affectedFiles.length, 1);
      assert.equal(validation.affectedFiles[0].sourcePath, fileB);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S6: Multi-file context with multiple stale files returns deterministic sorted affected files
    // ------------------------------------------------------------------------
    it('S6: Multiple stale files return deterministic sorted affected files', async () => {
      const fileZ = 'src/z-module.ts';
      const fileA = 'src/a-module.ts';
      const fileM = 'src/m-module.ts';

      const fullZ = await createWorkspaceFile(fileZ, 'export const Z = 1;');
      const fullA = await createWorkspaceFile(fileA, 'export const A = 1;');
      const fullM = await createWorkspaceFile(fileM, 'export const M = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [fileZ, fileA, fileM],
        intent: ContextIntent.METADATA,
      });

      // Modify all 3 files
      await fs.promises.writeFile(fullZ, 'export const Z = 2;', 'utf-8');
      await fs.promises.writeFile(fullA, 'export const A = 2;', 'utf-8');
      await fs.promises.writeFile(fullM, 'export const M = 2;', 'utf-8');

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, false);
      assert.equal(validation.affectedFiles.length, 3);
      // Deterministic alphabetical sorting: a, m, z
      assert.equal(validation.affectedFiles[0].sourcePath, fileA);
      assert.equal(validation.affectedFiles[1].sourcePath, fileM);
      assert.equal(validation.affectedFiles[2].sourcePath, fileZ);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S7: Unrelated changed file does NOT invalidate context
    // ------------------------------------------------------------------------
    it('S7: Unrelated changed file in workspace does NOT invalidate context', async () => {
      const targetFile = 'src/target.ts';
      const unrelatedFile = 'src/unrelated.ts';

      await createWorkspaceFile(targetFile, 'export const TARGET = 1;');
      const fullUnrelated = await createWorkspaceFile(unrelatedFile, 'export const UNRELATED = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      // Context relies ONLY on targetFile
      const context = await engine.resolveContext({
        sourcePaths: [targetFile],
        intent: ContextIntent.METADATA,
      });

      // Modify unrelated file
      await fs.promises.writeFile(fullUnrelated, 'export const UNRELATED = 999;', 'utf-8');

      const validation = await engine.validateContext(context);

      assert.equal(validation.isValid, true);
      assert.equal(validation.action, ContextValidationAction.CONTINUE);
      assert.deepEqual(validation.affectedFiles, []);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S8: Stale context cannot pass the write/operation guard
    // ------------------------------------------------------------------------
    it('S8: Stale context cannot pass the write/operation guard (assertValidForWrite / guardOperation)', async () => {
      const relPath = 'src/guarded.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const GUARDED = "v1";');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      // Modify file on disk to make context stale
      await fs.promises.writeFile(fullPath, 'export const GUARDED = "v2_external_change";', 'utf-8');

      // assertValidForWrite must throw ContextInvalidationError
      await assert.rejects(
        async () => {
          await engine.assertValidForWrite(context, relPath);
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextInvalidationError);
          assert.equal(err.code, 'ERR_CONTEXT_STALE_WRITE_REJECTED');
          assert.equal(err.action, 'CONTEXT_INVALIDATED');
          assert.equal(err.sourcePath, relPath);
          return true;
        }
      );

      // checkWriteGuard must report allowed: false
      const guardCheck = await engine.checkWriteGuard(context, relPath);
      assert.equal(guardCheck.allowed, false);
      assert.equal(guardCheck.validation.isValid, false);

      // guardOperation must abort before executing callback
      let operationExecuted = false;
      await assert.rejects(
        async () => {
          await engine.guardOperation(
            context,
            async () => {
              operationExecuted = true;
              return 'written';
            },
            relPath
          );
        },
        ContextInvalidationError
      );
      assert.equal(operationExecuted, false, 'Operation must NOT execute when context is stale');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S9: Refreshed context uses current filesystem content
    // ------------------------------------------------------------------------
    it('S9: Refreshed context uses current filesystem content', async () => {
      const relPath = 'src/refreshed-content.ts';
      const fullPath = await createWorkspaceFile(
        relPath,
        'export function execute(): string { return "original"; }'
      );

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      // File modified on disk
      const newContent = 'export function execute(): string { return "refreshed_content"; }';
      await fs.promises.writeFile(fullPath, newContent, 'utf-8');

      // Refresh stale context
      const refreshResult = await engine.refreshContext(oldContext);

      assert.equal(refreshResult.action, ContextValidationAction.RE_EVALUATE);
      assert.equal(refreshResult.refreshedContext.items.length, 1);
      const l2 = refreshResult.refreshedContext.items[0] as L2Context;
      assert.equal(l2.content, newContent);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S10: Refreshed context hash matches current file
    // ------------------------------------------------------------------------
    it('S10: Refreshed context hash matches current file hash on disk', async () => {
      const relPath = 'src/hash-match.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const HASH_V1 = 100;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      // Modify disk
      await fs.promises.writeFile(fullPath, 'export const HASH_V2 = 200;', 'utf-8');
      const expectedDiskHash = await computeFileSha256(fullPath);

      const refreshResult = await engine.refreshContext(oldContext);
      assert.equal(refreshResult.refreshedContext.items[0].fileHash, expectedDiskHash);

      // Newly refreshed context must pass validation
      const postValidation = await engine.validateContext(refreshResult.refreshedContext);
      assert.equal(postValidation.isValid, true);
      assert.equal(postValidation.action, ContextValidationAction.CONTINUE);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S11: CONTRACT context refreshes through L1
    // ------------------------------------------------------------------------
    it('S11: CONTRACT context refreshes through L1', async () => {
      const relPath = 'src/contract-refresh.ts';
      const fullPath = await createWorkspaceFile(
        relPath,
        'export interface IService { run(): void; }\nexport function run() { return 1; }'
      );

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.CONTRACT,
      });
      assert.equal(oldContext.targetLayer, 'L1');

      // Modify file structure on disk
      await fs.promises.writeFile(
        fullPath,
        'export interface IService { run(): void; stop(): void; }\nexport function run() { return 2; }',
        'utf-8'
      );

      const refreshResult = await engine.refreshContext(oldContext);

      assert.equal(refreshResult.refreshedContext.targetLayer, 'L1');
      assert.equal(refreshResult.refreshedContext.items[0].layer, 'L1');
      const l1 = refreshResult.refreshedContext.items[0] as L1Context;
      assert.ok(l1.interfaces.some((i) => i.includes('stop(): void')));

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S12: FULL_IMPLEMENTATION context refreshes through L2
    // ------------------------------------------------------------------------
    it('S12: FULL_IMPLEMENTATION context refreshes through L2', async () => {
      const relPath = 'src/impl-refresh.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const A = 10;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });
      assert.equal(oldContext.targetLayer, 'L2');

      await fs.promises.writeFile(fullPath, 'export const A = 20;', 'utf-8');

      const refreshResult = await engine.refreshContext(oldContext);

      assert.equal(refreshResult.refreshedContext.targetLayer, 'L2');
      assert.equal(refreshResult.refreshedContext.items[0].layer, 'L2');
      const l2 = refreshResult.refreshedContext.items[0] as L2Context;
      assert.equal(l2.content, 'export const A = 20;');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S13: L1 insufficiency may escalate to L2
    // ------------------------------------------------------------------------
    it('S13: Refreshed L1 insufficiency escalates to L2 when required symbols are not in structural extract', async () => {
      const relPath = 'src/escalate-on-refresh.ts';
      const fullPath = await createWorkspaceFile(
        relPath,
        'export interface ExistingInterface { a: string; }'
      );

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.CONTRACT,
        relevantSymbols: ['ExistingInterface'],
      });
      assert.equal(oldContext.targetLayer, 'L1');

      // Edit file on disk removing ExistingInterface and replacing with something else
      await fs.promises.writeFile(fullPath, 'export const OtherVar = 99;', 'utf-8');

      // Refresh with original symbol requirement
      const refreshResult = await engine.refreshContext(oldContext, {
        relevantSymbols: ['ExistingInterface'],
      });

      // Escalates to L2 because ExistingInterface was not found in refreshed L1
      assert.equal(refreshResult.refreshedContext.targetLayer, 'L2');
      assert.equal(refreshResult.refreshedContext.items[0].layer, 'L2');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S14: Re-evaluation is explicitly required after invalidation
    // ------------------------------------------------------------------------
    it('S14: Re-evaluation is explicitly required after invalidation (action RE-EVALUATE)', async () => {
      const relPath = 'src/reevaluate.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const V = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      await fs.promises.writeFile(fullPath, 'export const V = 2;', 'utf-8');

      const refreshResult = await engine.refreshContext(oldContext);

      assert.equal(refreshResult.action, 'RE-EVALUATE');
      assert.ok(refreshResult.reason.includes('Re-evaluation is required'));

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S15: Old context payload is not reused after invalidation
    // ------------------------------------------------------------------------
    it('S15: Old context payload is discarded and not reused after invalidation', async () => {
      const relPath = 'src/no-reuse.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const ORIGINAL_PAYLOAD = "old";');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const oldContext = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      await fs.promises.writeFile(fullPath, 'export const NEW_PAYLOAD = "new";', 'utf-8');

      const refreshResult = await engine.refreshContext(oldContext);

      assert.notEqual(refreshResult.refreshedContext, oldContext);
      assert.notEqual(
        (refreshResult.refreshedContext.items[0] as L2Context).content,
        (oldContext.items[0] as L2Context).content
      );
      assert.equal(
        (refreshResult.refreshedContext.items[0] as L2Context).content,
        'export const NEW_PAYLOAD = "new";'
      );

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S16: Repeated identical validation is deterministic
    // ------------------------------------------------------------------------
    it('S16: Repeated identical validation calls produce strictly identical deterministic results', async () => {
      const relPath1 = 'src/det-1.ts';
      const relPath2 = 'src/det-2.ts';
      const full1 = await createWorkspaceFile(relPath1, 'export const D1 = 1;');
      const full2 = await createWorkspaceFile(relPath2, 'export const D2 = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath1, relPath2],
        intent: ContextIntent.METADATA,
      });

      // Modify both files
      await fs.promises.writeFile(full1, 'export const D1 = 99;', 'utf-8');
      await fs.promises.writeFile(full2, 'export const D2 = 99;', 'utf-8');

      const val1 = await engine.validateContext(context);
      const val2 = await engine.validateContext(context);

      assert.deepEqual(val1, val2);
      assert.equal(val1.isValid, false);
      assert.equal(val1.affectedFiles.length, 2);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S17: Structured invalidation error/result
    // ------------------------------------------------------------------------
    it('S17: ContextInvalidationError provides structured machine-readable fields', () => {
      const err = new ContextInvalidationError(
        'Context has become invalid',
        'ERR_CONTEXT_INVALIDATED',
        {
          action: ContextValidationAction.CONTEXT_INVALIDATED,
          contextReference: 'req-12345',
          sourcePath: 'src/file.ts',
          oldHash: 'a'.repeat(64),
          currentHash: 'b'.repeat(64),
          affectedFiles: [
            {
              sourcePath: 'src/file.ts',
              oldHash: 'a'.repeat(64),
              currentHash: 'b'.repeat(64),
              status: StaleFileStatus.MODIFIED,
            },
          ],
        }
      );

      assert.ok(err instanceof AidmError);
      assert.equal(err.code, 'ERR_CONTEXT_INVALIDATED');
      assert.equal(err.action, 'CONTEXT_INVALIDATED');
      assert.equal(err.contextReference, 'req-12345');
      assert.equal(err.sourcePath, 'src/file.ts');
      assert.equal(err.oldHash, 'a'.repeat(64));
      assert.equal(err.currentHash, 'b'.repeat(64));
      assert.equal(err.affectedFiles.length, 1);
    });

    // ------------------------------------------------------------------------
    // S18: No timestamps/randomness in deterministic decision result
    // ------------------------------------------------------------------------
    it('S18: ContextValidationResult strictly excludes timestamps and random IDs', async () => {
      const relPath = 'src/pure-check.ts';
      const fullPath = await createWorkspaceFile(relPath, 'export const X = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      await fs.promises.writeFile(fullPath, 'export const X = 2;', 'utf-8');

      const validation = await engine.validateContext(context);

      assert.equal('timestamp' in validation, false, 'validation result must not have timestamp');
      assert.equal('validatedAt' in validation, false, 'validation result must not have validatedAt');
      assert.equal('uuid' in validation, false, 'validation result must not have random uuid');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // S19: Phase 1 regression verification
    // ------------------------------------------------------------------------
    it('S19: Phase 1 recovery and durable state continue to function without regression', async () => {
      const durableManager = new DurableStateManager({ baseDir: tempWorkspace });
      await durableManager.save({
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: null,
      });

      const recoveryEngine = new RecoveryEngine({
        workspaceRoot: tempWorkspace,
        processLivenessChecker: () => false,
      });

      const decision = await recoveryEngine.reconcile();
      assert.ok(decision);
      assert.ok(['RESUME', 'RESTART', 'PROCEED', 'BLOCKED_ON_HUMAN', 'RETRY'].includes(decision.decision));

      recoveryEngine.close();
    });

    // ------------------------------------------------------------------------
    // S20: P2-01 regression verification
    // ------------------------------------------------------------------------
    it('S20: TASK-P2-01 TaskDagEngine functions without regression', () => {
      const dag = new TaskDagEngine();
      const task = {
        task_id: 'TASK-VERIFY',
        parent_feature_id: 'FEAT-P2-TASK-CONTEXT-ENGINE',
        title: 'Verify task',
        description: 'Testing dag engine regression',
        traceability_sources: ['SYSTEM_REQUIREMENT: CONTEXT_ENGINE'],
        dependencies: [],
        acceptance_criteria: ['AC-1'],
        status: 'READY' as const,
        attempt: 0,
        max_attempts: 3,
        priority: 'MEDIUM' as const,
        risk_level: 'SAFE' as const,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        hierarchy_level: 'TASK' as const,
      };

      const result = dag.validateTask(task);
      assert.equal(result.valid, true);
    });

    // ------------------------------------------------------------------------
    // S21: P2-02 regression verification
    // ------------------------------------------------------------------------
    it('S21: TASK-P2-02 ContextEngine L0/L1/L2 continues to function without regression', async () => {
      const relPath = 'src/p2-02-compat.ts';
      await createWorkspaceFile(relPath, 'export interface Compat { id: number; }');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l0 = await engine.getL0Context(relPath);
      assert.equal(l0.layer, 'L0');

      const l1 = await engine.getL1Context(relPath);
      assert.equal(l1.layer, 'L1');

      const l2 = await engine.getL2Context(relPath);
      assert.equal(l2.layer, 'L2');

      engine.close();
    });
  });

  // ==========================================================================
  // STANDALONE CONTEXT INVALIDATOR & GUARD UNIT TESTS
  // ==========================================================================

  describe('Standalone ContextInvalidator & Guard Operations', () => {
    it('should support standalone ContextInvalidator instantiation and validation', async () => {
      const relPath = 'src/standalone.ts';
      await createWorkspaceFile(relPath, 'export const S = 1;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      const invalidator = new ContextInvalidator({ workspaceRoot: tempWorkspace });
      const validation = await invalidator.validateContext(context);

      assert.equal(validation.isValid, true);
      assert.equal(validation.action, ContextValidationAction.CONTINUE);

      engine.close();
    });

    it('should reject invalid context object passed to validateContext', async () => {
      const invalidator = new ContextInvalidator({ workspaceRoot: tempWorkspace });

      await assert.rejects(
        async () => {
          await invalidator.validateContext(null as any);
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_INVALID_CONTEXT_REQUEST');
          return true;
        }
      );
    });

    it('should throw when refreshContext is called without ContextEngine', async () => {
      const invalidator = new ContextInvalidator({ workspaceRoot: tempWorkspace });
      const fakeContext = {
        requestId: 'fake-1',
        targetLayer: 'L0' as const,
        items: [],
        resolvedAt: new Date().toISOString(),
        sufficiencyReason: 'none',
        isSufficient: true,
        totalEstimatedTokens: 0,
        hashSnapshots: {},
      };

      await assert.rejects(
        async () => {
          await invalidator.refreshContext(fakeContext);
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_INVALID_CONTEXT_REQUEST');
          return true;
        }
      );
    });

    it('should pass checkWriteGuard when context is clean and allowed is true', async () => {
      const relPath = 'src/clean.ts';
      await createWorkspaceFile(relPath, 'export const CLEAN = true;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      const guard = await engine.checkWriteGuard(context, relPath);
      assert.equal(guard.allowed, true);
      assert.equal(guard.validation.isValid, true);
      assert.equal(guard.targetPath, relPath);

      engine.close();
    });

    it('should execute guardOperation when context is clean and return operation value', async () => {
      const relPath = 'src/safe-op.ts';
      await createWorkspaceFile(relPath, 'export const SAFE = true;');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const context = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      const res = await engine.guardOperation(
        context,
        async () => {
          return 'operation_successful';
        },
        relPath
      );

      assert.equal(res, 'operation_successful');
      engine.close();
    });
  });
});
