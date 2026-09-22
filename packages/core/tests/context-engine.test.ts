import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  ContextEngine,
  ContextLayer,
  ContextIntent,
  estimateContextTokens,
  extractL1Structure,
  ContextEngineError,
  AidmError,
  L0Indexer,
  L0Database,
  computeFileSha256,
  RecoveryEngine,
  DurableStateManager,
  LifecycleState,
  type ContextRequest,
  type L0Context,
  type L1Context,
  type L2Context,
} from '../dist/index.js';

describe('Context Engine L0/L1/L2 (TASK-P2-02)', () => {
  let tempWorkspace: string;
  let cacheDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-ctx-'));
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

  // ==========================================================================
  // MANDATORY VERIFICATION SCENARIOS (C1 - C18)
  // ==========================================================================

  describe('Mandatory Verification Scenarios (C1 - C18)', () => {
    // ------------------------------------------------------------------------
    // C1: L0 Context Retrieval
    // ------------------------------------------------------------------------
    it('C1: L0 context retrieval must return metadata and SHA-256 without loading file body', async () => {
      const relPath = 'src/service.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      const sampleCode = 'export function calculateTotal(a: number, b: number): number {\n  return a + b;\n}';
      await fs.promises.writeFile(fullPath, sampleCode, 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l0 = await engine.getL0Context(relPath);

      assert.equal(l0.layer, 'L0');
      assert.equal(l0.sourcePath, relPath);
      assert.ok(l0.fileHash.length === 64, 'fileHash must be a valid 64-char hex SHA-256');
      assert.equal(l0.size, Buffer.byteLength(sampleCode));
      assert.ok(typeof l0.mtimeMs === 'number');
      assert.ok(typeof l0.indexedAt === 'string');

      // Verify L0 does NOT contain content/body
      assert.equal('content' in l0, false, 'L0Context must not contain file content body');
      assert.equal(l0.tokenInfo.is_exact_provider_metric, false);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C2: L0 query against SQLite index
    // ------------------------------------------------------------------------
    it('C2: L0 query against SQLite index returns indexed metadata without redundant disk read', async () => {
      const relPath = 'src/indexed-file.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'export const INDEXED = true;', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      await engine.syncIndex();

      const l0 = await engine.getL0Context(relPath);
      assert.equal(l0.layer, 'L0');
      assert.equal(l0.sourcePath, relPath);
      assert.ok(l0.fileHash.length === 64);
      assert.equal(l0.size, Buffer.byteLength('export const INDEXED = true;'));

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C3: L0 SHA-256 hash matching
    // ------------------------------------------------------------------------
    it('C3: L0 hash matches computeFileSha256(filePath)', async () => {
      const relPath = 'lib/crypto-test.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'export const SECRET_KEY = "xyz123";', 'utf-8');

      const expectedSha256 = await computeFileSha256(fullPath);

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l0 = await engine.getL0Context(relPath);

      assert.equal(l0.fileHash, expectedSha256);
      engine.close();
    });

    // ------------------------------------------------------------------------
    // C4: L1 focused structural retrieval
    // ------------------------------------------------------------------------
    it('C4: L1 focused structural retrieval extracts interfaces, types, signatures and omits method bodies', async () => {
      const relPath = 'src/complex-service.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

      const codeWithBodies = `
import { Config } from './config.js';

export interface UserSession {
  id: string;
  username: string;
}

export type AuthToken = string;

export class SessionManager {
  private cache: Map<string, UserSession> = new Map();

  async authenticate(token: AuthToken): Promise<UserSession> {
    const raw = doVeryLongInternalDecoding(token);
    const complexCalculations = Array.from({ length: 1000 }).map((_, i) => i * 2);
    for (const item of complexCalculations) {
      console.log(item);
    }
    return { id: 'u-1', username: 'admin' };
  }
}

export function validateInput(val: string): boolean {
  if (!val) {
    return false;
  }
  return val.length > 5;
}
`;
      await fs.promises.writeFile(fullPath, codeWithBodies, 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l1 = await engine.getL1Context(relPath);

      assert.equal(l1.layer, 'L1');
      assert.equal(l1.sourcePath, relPath);
      assert.ok(l1.interfaces.some((i) => i.includes('interface UserSession')));
      assert.ok(l1.typeDefinitions.some((t) => t.includes('type AuthToken')));
      assert.ok(l1.signatures.some((s) => s.includes('class SessionManager')));
      assert.ok(l1.signatures.some((s) => s.includes('function validateInput')));
      assert.ok(l1.imports.some((imp) => imp.includes("import { Config } from './config.js'")));

      // Verify that internal loop and heavy method implementation body are omitted from summary
      assert.equal(l1.summary.includes('doVeryLongInternalDecoding'), false);
      assert.equal(l1.summary.includes('Array.from({ length: 1000 })'), false);
      assert.equal(l1.summary.includes('console.log(item)'), false);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C5: L1 token size vs full file
    // ------------------------------------------------------------------------
    it('C5: L1 token estimate < full file token estimate for rich implementation file', async () => {
      const relPath = 'src/large-implementation.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

      const repetitiveBody = '    // Heavy internal logic\n    const x = 1 + 1;\n'.repeat(200);
      const fileContent = `
export interface WorkerTask {
  id: string;
  name: string;
}

export function processHeavyTask(task: WorkerTask): void {
${repetitiveBody}
}
`;
      await fs.promises.writeFile(fullPath, fileContent, 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l1 = await engine.getL1Context(relPath);
      const l2 = await engine.getL2Context(relPath);

      assert.ok(
        l1.tokenInfo.estimated_tokens < l2.tokenInfo.estimated_tokens,
        `Expected L1 tokens (${l1.tokenInfo.estimated_tokens}) < L2 tokens (${l2.tokenInfo.estimated_tokens})`
      );

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C6: L2 full current file retrieval
    // ------------------------------------------------------------------------
    it('C6: L2 full current file retrieval returns exact content and current disk hash', async () => {
      const relPath = 'src/target.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      const exactContent = 'export const EXACT_VALUE = 42;\nexport function getAnswer() { return 42; }\n';
      await fs.promises.writeFile(fullPath, exactContent, 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l2 = await engine.getL2Context(relPath);

      assert.equal(l2.layer, 'L2');
      assert.equal(l2.content, exactContent);
      assert.equal(l2.size, Buffer.byteLength(exactContent));
      assert.equal(l2.fileHash, await computeFileSha256(fullPath));

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C7: L2 streaming SHA-256 verification
    // ------------------------------------------------------------------------
    it('C7: L2 hash computed matches disk state at retrieval time', async () => {
      const relPath = 'src/dynamic-file.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'initial content', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const l2First = await engine.getL2Context(relPath);
      assert.equal(l2First.fileHash, await computeFileSha256(fullPath));

      // Mutate file on disk
      await fs.promises.writeFile(fullPath, 'updated content dynamically modified', 'utf-8');
      const l2Second = await engine.getL2Context(relPath);

      assert.notEqual(l2First.fileHash, l2Second.fileHash);
      assert.equal(l2Second.fileHash, await computeFileSha256(fullPath));
      assert.equal(l2Second.content, 'updated content dynamically modified');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C8: Minimum Sufficient Context — L0 Sufficient
    // ------------------------------------------------------------------------
    it('C8: Request with intent=LOCATE_FILE or METADATA returns L0 without retrieving L1 or L2', async () => {
      const relPath = 'src/module-a.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'export function a() {}', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      const resLocate = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.LOCATE_FILE,
      });

      assert.equal(resLocate.targetLayer, 'L0');
      assert.equal(resLocate.items.length, 1);
      assert.equal(resLocate.items[0].layer, 'L0');
      assert.equal('content' in resLocate.items[0], false);

      const resMeta = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      assert.equal(resMeta.targetLayer, 'L0');
      assert.equal(resMeta.items[0].layer, 'L0');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C9: Minimum Sufficient Context — L0 Insufficient -> L1 Sufficient
    // ------------------------------------------------------------------------
    it('C9: Request with intent=CONTRACT or STRUCTURAL escalates to L1 without retrieving L2', async () => {
      const relPath = 'src/contracts.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'export interface Contract { run(): void; }', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      const resContract = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.CONTRACT,
      });

      assert.equal(resContract.targetLayer, 'L1');
      assert.equal(resContract.items.length, 1);
      assert.equal(resContract.items[0].layer, 'L1');
      assert.equal('content' in resContract.items[0], false);

      const resStructural = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.STRUCTURAL,
      });

      assert.equal(resStructural.targetLayer, 'L1');
      assert.equal(resStructural.items[0].layer, 'L1');

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C10: Minimum Sufficient Context — L1 Insufficient -> L2 Required
    // ------------------------------------------------------------------------
    it('C10: Request with intent=FULL_IMPLEMENTATION escalates to L2', async () => {
      const relPath = 'src/full-code.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      const fullCode = 'export function doExecute() { return "ok"; }';
      await fs.promises.writeFile(fullPath, fullCode, 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      const resFull = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      assert.equal(resFull.targetLayer, 'L2');
      assert.equal(resFull.items.length, 1);
      assert.equal(resFull.items[0].layer, 'L2');
      assert.equal((resFull.items[0] as L2Context).content, fullCode);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C11: Deterministic resolution
    // ------------------------------------------------------------------------
    it('C11: Repeated identical requests produce identical ContextItem order and identical hash snapshots', async () => {
      const fileA = 'src/zeta.ts';
      const fileB = 'src/alpha.ts';
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, fileA), 'export const Z = 100;', 'utf-8');
      await fs.promises.writeFile(path.join(tempWorkspace, fileB), 'export const A = 200;', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      const request1: ContextRequest = {
        requestId: 'deterministic-req-1',
        sourcePaths: [fileA, fileB],
        intent: ContextIntent.METADATA,
      };

      const request2: ContextRequest = {
        requestId: 'deterministic-req-2',
        sourcePaths: [fileB, fileA], // shuffled input order
        intent: ContextIntent.METADATA,
      };

      const res1 = await engine.resolveContext(request1);
      const res2 = await engine.resolveContext(request2);

      // Deterministic sorted order
      assert.equal(res1.items[0].sourcePath, 'src/alpha.ts');
      assert.equal(res1.items[1].sourcePath, 'src/zeta.ts');
      assert.equal(res2.items[0].sourcePath, 'src/alpha.ts');
      assert.equal(res2.items[1].sourcePath, 'src/zeta.ts');

      assert.deepEqual(res1.hashSnapshots, res2.hashSnapshots);
      assert.equal(res1.totalEstimatedTokens, res2.totalEstimatedTokens);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C12: Detection of changed filesystem content
    // ------------------------------------------------------------------------
    it('C12: When disk content differs from L0 index, hash mismatch is detectable through hash snapshots (isStale=true)', async () => {
      const relPath = 'src/stale-target.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'original indexed version', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      await engine.syncIndex(); // Indexes original version

      // External tool / user modifies the file on disk without updating index
      await fs.promises.writeFile(fullPath, 'modified version on disk differing from index', 'utf-8');

      const resolved = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.METADATA,
      });

      const snapshot = resolved.hashSnapshots[relPath];
      assert.ok(snapshot, 'Snapshot must be present for file');
      assert.equal(snapshot.isStale, true, 'isStale must be true when disk != index');
      assert.notEqual(snapshot.indexedHash, snapshot.currentHash);

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C13: Missing source file handling
    // ------------------------------------------------------------------------
    it('C13: Attempting retrieval of non-existent path throws structured ContextEngineError (ERR_CONTEXT_SOURCE_NOT_FOUND)', async () => {
      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      await assert.rejects(
        async () => {
          await engine.getL0Context('non-existent-file.ts');
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_CONTEXT_SOURCE_NOT_FOUND');
          assert.ok(err instanceof AidmError);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await engine.getL1Context('non-existent-file.ts');
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_CONTEXT_SOURCE_NOT_FOUND');
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await engine.getL2Context('non-existent-file.ts');
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_CONTEXT_SOURCE_NOT_FOUND');
          return true;
        }
      );

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C14: Invalid context request handling
    // ------------------------------------------------------------------------
    it('C14: Invalid context request handling (empty sources, unsupported layer)', async () => {
      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      // Empty sources
      await assert.rejects(
        async () => {
          await engine.resolveContext({ sourcePaths: [] });
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_INVALID_CONTEXT_REQUEST');
          return true;
        }
      );

      // Unsupported layer
      await assert.rejects(
        async () => {
          await engine.resolveContext({
            sourcePaths: ['some-path.ts'],
            requiredLayer: 'L99' as any,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_UNSUPPORTED_CONTEXT_LAYER');
          return true;
        }
      );

      // Missing workspaceRoot in options
      assert.throws(
        () => {
          new ContextEngine({ workspaceRoot: '' });
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextEngineError);
          assert.equal(err.code, 'ERR_INVALID_CONTEXT_REQUEST');
          return true;
        }
      );

      engine.close();
    });

    // ------------------------------------------------------------------------
    // C15: Token telemetry compliance
    // ------------------------------------------------------------------------
    it('C15: Token telemetry compliance (Section 9)', async () => {
      const estimate = estimateContextTokens('Hello world, this is a test text.');

      assert.equal(estimate.is_exact_provider_metric, false);
      assert.equal(estimate.reported_input_tokens, null);
      assert.equal(estimate.reported_output_tokens, null);
      assert.equal(estimate.reported_cached_tokens, null);
      assert.equal(estimate.estimated_cost_usd, null);
      assert.equal(estimate.provider_name, null);
      assert.equal(estimate.model, null);
      assert.ok(estimate.estimated_tokens > 0);

      // Edge case: empty string
      const emptyEstimate = estimateContextTokens('');
      assert.equal(emptyEstimate.estimated_tokens, 0);
      assert.equal(emptyEstimate.is_exact_provider_metric, false);

      // Edge case: null / undefined
      const nullEstimate = estimateContextTokens(null);
      assert.equal(nullEstimate.estimated_tokens, 0);
    });

    // ------------------------------------------------------------------------
    // C16: Phase 1 L0 compatibility
    // ------------------------------------------------------------------------
    it('C16: Phase 1 L0Indexer / L0Database continue to function without regression', async () => {
      const testFile = path.join(tempWorkspace, 'test-p1-l0.txt');
      await fs.promises.writeFile(testFile, 'L0 compatibility verification', 'utf-8');

      const indexer = new L0Indexer({
        workspaceRoot: tempWorkspace,
        dbPath,
      });

      await indexer.initialize();
      const stats = await indexer.sync();
      assert.ok(stats.totalIndexed >= 1);

      const db = new L0Database({ dbPath });
      db.open();
      const rec = db.getFile('test-p1-l0.txt');
      assert.ok(rec);
      assert.equal(rec.path, 'test-p1-l0.txt');
      assert.ok(rec.sha256.length === 64);

      db.close();
      indexer.close();
    });

    // ------------------------------------------------------------------------
    // C17: Phase 1 recovery compatibility
    // ------------------------------------------------------------------------
    it('C17: Phase 1 RecoveryEngine continues to function without regression', async () => {
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
      assert.ok(typeof decision.reason === 'string');
      assert.ok(typeof decision.timestamp === 'string');

      recoveryEngine.close();
    });

    // ------------------------------------------------------------------------
    // C18: scanner.ts untouched
    // ------------------------------------------------------------------------
    it('C18: packages/core/src/l0/scanner.ts git diff is 0', () => {
      const scannerDiff = execSync('git diff -- packages/core/src/l0/scanner.ts', {
        encoding: 'utf-8',
      }).trim();

      assert.equal(scannerDiff, '', 'packages/core/src/l0/scanner.ts MUST have 0 diff');
    });
  });

  // ==========================================================================
  // ADDITIONAL STRUCTURAL EXTRACTION AND ESCALATION TESTS
  // ==========================================================================

  describe('Structural Extractor & Multi-format Parsing', () => {
    it('should extract JSON structure keys correctly', () => {
      const jsonContent = JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        dependencies: { a: '1' },
      });

      const extracted = extractL1Structure(jsonContent, 'package.json');
      assert.deepEqual(extracted.exports, ['name', 'version', 'dependencies']);
      assert.ok(extracted.summary.includes('[L1 JSON Structure]'));
    });

    it('should extract Markdown outlines correctly', () => {
      const mdContent = '# Title\n\nIntro text.\n\n## Section 1\nDetails.\n\n### Sub 1.1\nMore details.';
      const extracted = extractL1Structure(mdContent, 'README.md');
      assert.equal(extracted.structuralItems.length, 3);
      assert.equal(extracted.structuralItems[0].name, '# Title');
      assert.equal(extracted.structuralItems[1].name, '## Section 1');
      assert.equal(extracted.structuralItems[2].name, '### Sub 1.1');
    });

    it('should escalate to L2 when requested symbol is missing in L1', async () => {
      const relPath = 'src/symbols.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(
        fullPath,
        'export function existsSymbol() { return 1; }',
        'utf-8'
      );

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      // Request symbol that does not exist in L1 structural extract
      const res = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.CONTRACT,
        relevantSymbols: ['missingSymbol'],
      });

      // Escalated to L2 because symbol was not found in L1
      assert.equal(res.targetLayer, 'L2');
      assert.equal(res.items[0].layer, 'L2');

      engine.close();
    });

    it('should satisfy L1 when all requested symbols exist in L1', async () => {
      const relPath = 'src/symbols2.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(
        fullPath,
        'export interface RequiredContract { id: string; }\nexport function requiredFn() {}',
        'utf-8'
      );

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      const res = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.CONTRACT,
        relevantSymbols: ['RequiredContract', 'requiredFn'],
      });

      assert.equal(res.targetLayer, 'L1');
      assert.equal(res.items[0].layer, 'L1');

      engine.close();
    });

    it('should respect custom isSufficient callback if provided', async () => {
      const relPath = 'src/custom-check.ts';
      const fullPath = path.join(tempWorkspace, relPath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'export const x = 1;', 'utf-8');

      const engine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      // Custom callback decides L0 is sufficient even with AUTO intent
      const res = await engine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.AUTO,
        isSufficient: (_item, layer) => layer === 'L0',
      });

      assert.equal(res.targetLayer, 'L0');
      assert.equal(res.items[0].layer, 'L0');

      engine.close();
    });
  });
});
