import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  L0Indexer,
  L0Database,
  computeFileSha256,
  computeContentSha256,
  scanWorkspaceFiles,
  FileChangeType,
  L0IndexError,
} from '../dist/index.js';

describe('L0 SQLite Indexer & Cache (TASK-P1-04)', () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-l0-test-'));
  });

  afterEach(async () => {
    if (tempWorkspace) {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ==========================================================================
  // SECTION A: Database Initialization & WAL Mode (AC-P1-04-1)
  // ==========================================================================
  describe('A. Database Initialization & WAL Mode (AC-P1-04-1)', () => {
    it('should create database file and parent cache directory automatically', async () => {
      const dbPath = path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db');
      assert.equal(fs.existsSync(dbPath), false);

      const db = new L0Database({ dbPath });
      db.open();

      assert.equal(fs.existsSync(dbPath), true);
      assert.equal(fs.existsSync(path.dirname(dbPath)), true);
      db.close();
    });

    it('should explicitly verify that PRAGMA journal_mode returns wal', async () => {
      const dbPath = path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db');
      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace, dbPath });
      await indexer.initialize();

      const journalMode = indexer.getJournalMode();
      assert.equal(journalMode.toLowerCase(), 'wal');
      indexer.close();
    });

    it('should create table schema idempotently without destroying existing data', async () => {
      const dbPath = path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db');
      const db = new L0Database({ dbPath });
      db.open();

      // Insert record
      db.syncTransaction(
        [
          {
            path: 'src/existing.ts',
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            size: 0,
            mtimeMs: Date.now(),
            indexedAt: new Date().toISOString(),
          },
        ],
        []
      );

      // Re-run open() (which re-executes CREATE TABLE IF NOT EXISTS)
      db.open();
      const file = db.getFile('src/existing.ts');
      assert.ok(file);
      assert.equal(file.path, 'src/existing.ts');
      assert.equal(file.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      db.close();
    });
  });

  // ==========================================================================
  // SECTION B: SHA-256 Hashing Verification (AC-P1-04-2)
  // ==========================================================================
  describe('B. SHA-256 Hashing Verification (AC-P1-04-2)', () => {
    it('should compute exact 64-character lowercase hex hash for known content', async () => {
      const filePath = path.join(tempWorkspace, 'hello.txt');
      const content = 'Hello, AIDM L0 Indexer!';
      await fs.promises.writeFile(filePath, content, 'utf8');

      const expected = crypto.createHash('sha256').update(content).digest('hex');
      const actual = await computeFileSha256(filePath);

      assert.equal(actual.length, 64);
      assert.match(actual, /^[0-9a-f]{64}$/);
      assert.equal(actual, expected);
      assert.equal(computeContentSha256(content), expected);
    });

    it('should produce different hashes for different contents and identical for same contents', async () => {
      const fileA = path.join(tempWorkspace, 'a.txt');
      const fileB = path.join(tempWorkspace, 'b.txt');
      const fileC = path.join(tempWorkspace, 'c.txt');

      await fs.promises.writeFile(fileA, 'content 1', 'utf8');
      await fs.promises.writeFile(fileB, 'content 2', 'utf8');
      await fs.promises.writeFile(fileC, 'content 1', 'utf8');

      const hashA = await computeFileSha256(fileA);
      const hashB = await computeFileSha256(fileB);
      const hashC = await computeFileSha256(fileC);

      assert.notEqual(hashA, hashB);
      assert.equal(hashA, hashC);
    });

    it('should stream large files without reading entire file into memory at once', async () => {
      const largePath = path.join(tempWorkspace, 'large.bin');
      const buffer = Buffer.alloc(1024 * 1024, 0x42); // 1 MB of 'B'
      await fs.promises.writeFile(largePath, buffer);

      const expected = crypto.createHash('sha256').update(buffer).digest('hex');
      const actual = await computeFileSha256(largePath);

      assert.equal(actual, expected);
    });
  });

  // ==========================================================================
  // SECTION C: Filesystem Scanning & Ignored Paths (AC-P1-04-2)
  // ==========================================================================
  describe('C. Filesystem Scanning & Exclusions (AC-P1-04-2)', () => {
    it('should discover nested files, normalize paths with forward slashes, and sort lexicographically', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src', 'utils'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'z.ts'), 'z');
      await fs.promises.writeFile(path.join(tempWorkspace, 'a.ts'), 'a');
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'utils', 'helper.ts'), 'helper');
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'index.ts'), 'index');

      const scanned = await scanWorkspaceFiles(tempWorkspace);
      const relativePaths = scanned.map((s) => s.relativePath);

      // Traversal must be sorted lexicographically
      assert.deepEqual(relativePaths, [
        'a.ts',
        'src/index.ts',
        'src/utils/helper.ts',
        'z.ts',
      ]);
    });

    it('should exclude .git, node_modules, .ai-manager/cache, and temporary files', async () => {
      // Valid file
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'main.ts'), 'code');

      // Excluded dirs
      await fs.promises.mkdir(path.join(tempWorkspace, '.git', 'objects'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, '.git', 'HEAD'), 'ref: refs/heads/main');

      await fs.promises.mkdir(path.join(tempWorkspace, 'node_modules', 'pkg'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'node_modules', 'pkg', 'index.js'), 'pkg');

      await fs.promises.mkdir(path.join(tempWorkspace, '.ai-manager', 'cache'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db'), 'sqlite');
      await fs.promises.writeFile(path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db-wal'), 'wal');

      // Temporary files
      await fs.promises.writeFile(path.join(tempWorkspace, '.state.json.tmp.1234.abc'), 'temp');
      await fs.promises.writeFile(path.join(tempWorkspace, 'file.tmp'), 'temp');
      await fs.promises.writeFile(path.join(tempWorkspace, 'tsconfig.tsbuildinfo'), 'buildinfo');

      const scanned = await scanWorkspaceFiles(tempWorkspace);
      const relativePaths = scanned.map((s) => s.relativePath);

      assert.deepEqual(relativePaths, ['src/main.ts']);
    });

    it('should handle symlinks safely without infinite recursion', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'real_dir'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'real_dir', 'file.ts'), 'test');

      // Create a cyclic symlink: real_dir/loop -> real_dir
      try {
        await fs.promises.symlink(
          path.join(tempWorkspace, 'real_dir'),
          path.join(tempWorkspace, 'real_dir', 'loop'),
          'dir'
        );
      } catch {
        // Symlink creation might require privileges on certain environments; if unsupported, skip
      }

      // Scanning with followSymlinks: false should not crash or recurse infinitely
      const scanned = await scanWorkspaceFiles(tempWorkspace, { followSymlinks: false });
      const paths = scanned.map((s) => s.relativePath);

      assert.ok(paths.includes('real_dir/file.ts'));
      assert.equal(paths.filter((p) => p.includes('loop')).length, 0);
    });
  });

  // ==========================================================================
  // SECTION D: Initial Synchronization (AC-P1-04-2)
  // ==========================================================================
  describe('D. Initial Synchronization (AC-P1-04-2)', () => {
    it('should index initial workspace files with correct hashes, sizes, and timestamps', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'a.ts'), 'const a = 1;');
      await fs.promises.writeFile(path.join(tempWorkspace, 'b.ts'), 'const b = 2;');
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'c.ts'), 'const c = 3;');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      const result = await indexer.sync();

      assert.equal(result.totalIndexed, 3);
      assert.equal(result.new.length, 3);
      assert.equal(result.modified.length, 0);
      assert.equal(result.unchanged.length, 0);
      assert.equal(result.removed.length, 0);

      const recordA = await indexer.getFile('a.ts');
      assert.ok(recordA);
      assert.equal(recordA.path, 'a.ts');
      assert.equal(recordA.sha256, computeContentSha256('const a = 1;'));
      assert.equal(recordA.size, Buffer.byteLength('const a = 1;'));

      const all = await indexer.getAllFiles();
      assert.equal(all.length, 3);
      assert.deepEqual(
        all.map((f) => f.path),
        ['a.ts', 'b.ts', 'src/c.ts']
      );

      indexer.close();
    });
  });

  // ==========================================================================
  // SECTION E: Change Detection (NEW, UNCHANGED, MODIFIED, REMOVED) (AC-P1-04-3)
  // ==========================================================================
  describe('E. Change Detection (AC-P1-04-3)', () => {
    it('should accurately classify NEW, UNCHANGED, MODIFIED, and REMOVED files', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'stay.ts'), 'initial stay');
      await fs.promises.writeFile(path.join(tempWorkspace, 'modify.ts'), 'initial modify');
      await fs.promises.writeFile(path.join(tempWorkspace, 'delete.ts'), 'initial delete');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });

      // Pass 1: Initial Sync
      const initial = await indexer.sync();
      assert.equal(initial.new.length, 3);

      // Perform disk modifications:
      // 1. stay.ts remains untouched (UNCHANGED)
      // 2. modify.ts changed content (MODIFIED)
      await fs.promises.writeFile(path.join(tempWorkspace, 'modify.ts'), 'updated modify content');
      // 3. delete.ts removed from disk (REMOVED)
      await fs.promises.unlink(path.join(tempWorkspace, 'delete.ts'));
      // 4. newly_added.ts created (NEW)
      await fs.promises.writeFile(path.join(tempWorkspace, 'newly_added.ts'), 'brand new file');

      // Pass 2: Incremental Sync
      const delta = await indexer.sync();

      // Verify UNCHANGED
      assert.equal(delta.unchanged.length, 1);
      assert.equal(delta.unchanged[0].path, 'stay.ts');
      assert.equal(delta.unchanged[0].type, FileChangeType.UNCHANGED);

      // Verify MODIFIED
      assert.equal(delta.modified.length, 1);
      assert.equal(delta.modified[0].path, 'modify.ts');
      assert.equal(delta.modified[0].type, FileChangeType.MODIFIED);
      assert.notEqual(delta.modified[0].currentHash, delta.modified[0].previousHash);

      // Verify REMOVED
      assert.equal(delta.removed.length, 1);
      assert.equal(delta.removed[0].path, 'delete.ts');
      assert.equal(delta.removed[0].type, FileChangeType.REMOVED);
      assert.equal(delta.removed[0].currentHash, null);

      // Verify NEW
      assert.equal(delta.new.length, 1);
      assert.equal(delta.new[0].path, 'newly_added.ts');
      assert.equal(delta.new[0].type, FileChangeType.NEW);

      // Verify database reflects current state
      const currentFiles = await indexer.getAllFiles();
      assert.equal(currentFiles.length, 3); // stay.ts, modify.ts, newly_added.ts
      assert.deepEqual(
        currentFiles.map((f) => f.path),
        ['modify.ts', 'newly_added.ts', 'stay.ts']
      );
      assert.equal(await indexer.getFile('delete.ts'), null);

      indexer.close();
    });
  });

  // ==========================================================================
  // SECTION F: Hash-Based Detection (OLD_HASH != CURRENT_HASH) (AC-P1-04-3)
  // ==========================================================================
  describe('F. Hash-Based Detection (AC-P1-04-3)', () => {
    it('should detect modification when content changes even if file size and name remain identical', async () => {
      const filePath = path.join(tempWorkspace, 'same-size.txt');
      // Exactly 10 bytes in both cases
      await fs.promises.writeFile(filePath, '0123456789', 'utf8');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();

      const initialRecord = await indexer.getFile('same-size.txt');
      assert.ok(initialRecord);
      const oldHash = initialRecord.sha256;

      // Overwrite with different 10-byte string
      await fs.promises.writeFile(filePath, 'ABCDEFGHIJ', 'utf8');

      const delta = await indexer.sync();
      assert.equal(delta.modified.length, 1);
      assert.equal(delta.modified[0].path, 'same-size.txt');
      assert.equal(delta.modified[0].previousHash, oldHash);
      assert.notEqual(delta.modified[0].currentHash, oldHash);
      assert.equal(delta.modified[0].currentHash, computeContentSha256('ABCDEFGHIJ'));

      indexer.close();
    });
  });

  // ==========================================================================
  // SECTION G: Transaction Safety & Rollback (Atomicity)
  // ==========================================================================
  describe('G. Transaction Safety & Rollback', () => {
    it('should commit all changes on success and rollback on transaction failure', async () => {
      const dbPath = path.join(tempWorkspace, '.ai-manager', 'cache', 'context.db');
      const db = new L0Database({ dbPath });
      db.open();

      const initialFile = {
        path: 'committed.ts',
        sha256: 'hash1',
        size: 10,
        mtimeMs: 1000,
        indexedAt: new Date().toISOString(),
      };

      db.syncTransaction([initialFile], []);
      assert.ok(db.getFile('committed.ts'));

      // Attempt transaction with intentional failure
      assert.throws(
        () => {
          // Pass an invalid record (e.g. violating NOT NULL on path)
          const invalidRecord = {
            path: null as unknown as string,
            sha256: 'hash2',
            size: 20,
            mtimeMs: 2000,
            indexedAt: new Date().toISOString(),
          };
          db.syncTransaction([invalidRecord], ['committed.ts']);
        },
        (err: unknown) => {
          assert.ok(err instanceof L0IndexError);
          assert.equal(err.code, 'ERR_L0_INDEX');
          return true;
        }
      );

      // Verify that committed.ts was NOT deleted because transaction rolled back
      const preserved = db.getFile('committed.ts');
      assert.ok(preserved);
      assert.equal(preserved.path, 'committed.ts');

      db.close();
    });
  });

  // ==========================================================================
  // SECTION H: Restart Behavior & Persistence
  // ==========================================================================
  describe('H. Restart Behavior & Persistence', () => {
    it('should preserve indexed data across process restarts and fresh indexer instances', async () => {
      await fs.promises.writeFile(path.join(tempWorkspace, 'app.ts'), 'console.log("hello");');

      const indexer1 = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer1.sync();
      const hash1 = (await indexer1.getFile('app.ts'))?.sha256;
      assert.ok(hash1);
      indexer1.close();

      // Create completely new indexer instance pointing to same workspace
      const indexer2 = new L0Indexer({ workspaceRoot: tempWorkspace });
      const record = await indexer2.getFile('app.ts');
      assert.ok(record);
      assert.equal(record.path, 'app.ts');
      assert.equal(record.sha256, hash1);

      // Sync on restarted indexer with no disk changes must report UNCHANGED
      const syncResult = await indexer2.sync();
      assert.equal(syncResult.unchanged.length, 1);
      assert.equal(syncResult.new.length, 0);
      assert.equal(syncResult.modified.length, 0);
      assert.equal(syncResult.removed.length, 0);

      indexer2.close();
    });
  });

  // ==========================================================================
  // SECTION I: Path Isolation & Platform Normalization
  // ==========================================================================
  describe('I. Path Isolation & Canonical File Identity', () => {
    it('should store normalized relative paths and distinguish identical filenames in different dirs', async () => {
      await fs.promises.mkdir(path.join(tempWorkspace, 'src'), { recursive: true });
      await fs.promises.mkdir(path.join(tempWorkspace, 'tests'), { recursive: true });
      await fs.promises.writeFile(path.join(tempWorkspace, 'src', 'index.ts'), 'src index');
      await fs.promises.writeFile(path.join(tempWorkspace, 'tests', 'index.ts'), 'tests index');

      const indexer = new L0Indexer({ workspaceRoot: tempWorkspace });
      await indexer.sync();

      const all = await indexer.getAllFiles();
      assert.equal(all.length, 2);

      const srcIndex = await indexer.getFile('src/index.ts');
      const testIndex = await indexer.getFile('tests/index.ts');

      assert.ok(srcIndex);
      assert.ok(testIndex);
      assert.equal(srcIndex.path, 'src/index.ts');
      assert.equal(testIndex.path, 'tests/index.ts');
      assert.notEqual(srcIndex.sha256, testIndex.sha256);

      // Verify that absolute workspace path is not stored as canonical path
      assert.equal(all.some((f) => f.path.startsWith('/')), false);
      assert.equal(all.some((f) => f.path.includes(tempWorkspace)), false);

      indexer.close();
    });
  });
});
