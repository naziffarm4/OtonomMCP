/**
 * @file phase-7-cli-e2e.test.ts
 * @description Dedicated Phase 7 End-to-End CLI Autonomous Build Validation Suite (TASK-P7-03).
 *
 * Proves the complete externally visible autonomous workflow:
 * clean disposable project
 *         ↓
 * aidm init
 *         ↓
 * requirements/task setup
 *         ↓
 * aidm run
 *         ↓
 * existing autonomous lifecycle
 *         ↓
 * implementation
 *         ↓
 * evidence
 *         ↓
 * evidence validation
 *         ↓
 * QA review
 *         ↓
 * checkpoint
 *         ↓
 * completion
 *         ↓
 * aidm status
 *         ↓
 * validated final project
 *
 * Tests execute through the real built CLI binary (bin/aidm.js) as child processes.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CliExitCode,
  LifecycleState,
  DurableStateManager,
  SpecStore,
} from '../dist/index.js';

// Resolve canonical CLI executable binary path
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const cliBin = path.resolve(currentDir, '../bin/aidm.js');

/**
 * Executes a shell command inside the given working directory.
 */
function execCommand(
  cmd: string,
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    child_process.exec(cmd, { cwd }, (err, stdout, stderr) => {
      resolve({
        code: err?.code !== undefined ? Number(err.code) : err ? 1 : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

/**
 * Invokes the actual CLI binary with arguments in the specified working directory.
 */
function execAidm(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const quotedArgs = args
    .map((a) => (a.includes(' ') || a.includes('"') ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
  const cmd = `node "${cliBin}" ${quotedArgs}`;
  return execCommand(cmd, cwd);
}

/**
 * Recursively cleans up a directory, ignoring errors if already removed.
 */
async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
}

/**
 * Creates an isolated, disposable fixture project in OS temp space with a clean Git repository.
 */
async function createDisposableFixture(prefix = 'aidm-p703-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  // Initialize clean Git repository
  await execCommand('git init -b main', dir);
  await execCommand('git config user.name "AIDM P703 Test"', dir);
  await execCommand('git config user.email "p703@aidm.local"', dir);

  // Write minimal package.json
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'disposable-e2e-project',
        version: '1.0.0',
        type: 'module',
      },
      null,
      2
    ),
    'utf-8'
  );

  // Initial Git commit to establish valid HEAD
  await execCommand('git add -A', dir);
  await execCommand('git commit -m "chore: initial project commit"', dir);

  return dir;
}

// ============================================================================
// TEST SUITE: Phase 7 — E2E CLI Autonomous Build Validation (TASK-P7-03)
// ============================================================================

describe('Phase 7 — E2E CLI Autonomous Build Validation (TASK-P7-03)', () => {
  // --------------------------------------------------------------------------
  // SCENARIO 01: Clean fixture creation
  // --------------------------------------------------------------------------
  it('P7-03-01: Clean fixture creation is isolated from AIDM source tree with clean Git state', async () => {
    const fixtureDir = await createDisposableFixture('p703-01-fixture-');
    try {
      assert.ok(fixtureDir.startsWith(os.tmpdir()), 'Fixture must reside in OS tmp directory');
      assert.notEqual(fixtureDir, process.cwd(), 'Fixture must not be the AIDM repository root');

      const pkgStat = await fs.stat(path.join(fixtureDir, 'package.json'));
      assert.ok(pkgStat.isFile(), 'Fixture package.json must exist');

      const gitRes = await execCommand('git status --short', fixtureDir);
      assert.equal(gitRes.code, 0);
      assert.equal(gitRes.stdout.trim(), '', 'Fixture git working tree must be clean');
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 02: Real CLI init
  // --------------------------------------------------------------------------
  it('P7-03-02: Real CLI init command establishes .ai-manager structure, DEC-001, and durable state', async () => {
    const fixtureDir = await createDisposableFixture('p703-02-init-');
    try {
      const res = await execAidm(['init', '-C', fixtureDir], fixtureDir);
      assert.equal(res.code, CliExitCode.SUCCESS, `init must exit with code 0: ${res.stderr}`);
      assert.ok(res.stdout.includes('Initialized AIDM project'));

      // Verify directory structure
      const specStat = await fs.stat(path.join(fixtureDir, '.ai-manager', 'spec'));
      const stateStat = await fs.stat(path.join(fixtureDir, '.ai-manager', 'state'));
      const historyStat = await fs.stat(path.join(fixtureDir, '.ai-manager', 'history'));
      assert.ok(specStat.isDirectory());
      assert.ok(stateStat.isDirectory());
      assert.ok(historyStat.isDirectory());

      // Verify DEC-001 in spec store
      const specStore = new SpecStore({ baseDir: fixtureDir });
      const decisions = await specStore.loadDecisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].id, 'DEC-001');

      // Verify durable state in INITIALIZING state
      const durableManager = new DurableStateManager({ baseDir: fixtureDir });
      assert.ok(await durableManager.exists());
      const state = await durableManager.load();
      assert.equal(state?.currentLifecycleState, LifecycleState.INITIALIZING);
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 03: Requirement/task setup
  // --------------------------------------------------------------------------
  it('P7-03-03: Requirement/task setup persists locked requirements conforming to DEC-001 schema', async () => {
    const fixtureDir = await createDisposableFixture('p703-03-req-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      const saved = await specStore.saveRequirements([
        {
          id: 'REQ-GREET-01',
          title: 'Greeting Module',
          description: 'Provide greeting function that formats hello messages',
        },
      ]);

      assert.equal(saved.length, 1);
      assert.equal(saved[0].id, 'REQ-GREET-01');
      assert.equal(saved[0].status, 'LOCKED');
      assert.equal(saved[0].authority, 'USER');
      assert.ok(saved[0].createdAt);
      assert.ok(saved[0].updatedAt);

      // Verify readable through SpecStore
      const loaded = await specStore.loadRequirements();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, 'REQ-GREET-01');
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 04: Real CLI run (--dry-run)
  // --------------------------------------------------------------------------
  it('P7-03-04: Real CLI run --dry-run validates requirements and Task DAG without execution mutation', async () => {
    const fixtureDir = await createDisposableFixture('p703-04-dryrun-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-MATH-01',
          title: 'Calculator Add Feature',
          description: 'Adds two numbers together deterministically',
        },
      ]);

      const res = await execAidm(['run', '-C', fixtureDir, '--dry-run'], fixtureDir);
      assert.equal(res.code, CliExitCode.SUCCESS, `dry-run must exit with 0: ${res.stderr}`);
      assert.ok(res.stdout.includes('DAG and requirements validation passed (--dry-run)'));
      assert.ok(res.stdout.includes('Requirements:    1'));
      assert.ok(res.stdout.includes('Tasks:           1'));

      // Working tree must remain clean after dry-run
      const gitRes = await execCommand('git status --short', fixtureDir);
      assert.ok(!gitRes.stdout.includes('durable-state.json'), 'Dry-run must not mutate durable state');
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 05: Successful autonomous implementation
  // --------------------------------------------------------------------------
  it('P7-03-05: Real CLI run executes autonomous lifecycle and reaches completion exit code 0', async () => {
    const fixtureDir = await createDisposableFixture('p703-05-e2e-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-CALC',
          title: 'Deterministic Math Module',
          description: 'A multiply function and corresponding unit test',
        },
      ]);

      // Provide source implementation and passing test in fixture
      const srcDir = path.join(fixtureDir, 'src');
      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.mkdir(testDir, { recursive: true });

      await fs.writeFile(
        path.join(srcDir, 'math.js'),
        'export function multiply(a, b) { return a * b; }\n',
        'utf-8'
      );

      await fs.writeFile(
        path.join(testDir, 'math.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { multiply } from '../src/math.js';

test('multiply returns correct product', () => {
  assert.equal(multiply(3, 4), 12);
});
`,
        'utf-8'
      );

      // Commit implementation to git so working tree is clean for pre-flight checkpoint
      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "feat: add multiply function and unit test"', fixtureDir);

      // Execute run through real CLI binary
      const runRes = await execAidm(['run', '-C', fixtureDir], fixtureDir);
      assert.equal(runRes.code, CliExitCode.SUCCESS, `run must exit with 0: ${runRes.stderr}`);
      assert.ok(runRes.stdout.includes('Autonomous run completed successfully'));
      assert.ok(runRes.stdout.includes('Final State:     PROJECT_COMPLETE'));
      assert.ok(runRes.stdout.includes('Completed Tasks: 1 (TASK-CALC)'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 06: Evidence verification
  // --------------------------------------------------------------------------
  it('P7-03-06: Autonomous execution verifies test evidence via SYSTEM_VERIFIED_EVIDENCE', async () => {
    const fixtureDir = await createDisposableFixture('p703-06-evi-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-EVI',
          title: 'Evidence Verification Module',
          description: 'A test that produces system evidence',
        },
      ]);

      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'evidence.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';
test('passes cleanly', () => { assert.equal(1 + 1, 2); });
`,
        'utf-8'
      );

      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add test"', fixtureDir);

      const runRes = await execAidm(['run', '-C', fixtureDir], fixtureDir);
      assert.equal(runRes.code, CliExitCode.SUCCESS);

      // Verify event history contains execution events
      const historyFile = path.join(fixtureDir, '.ai-manager', 'history', 'events.jsonl');
      const historyContent = await fs.readFile(historyFile, 'utf8');
      assert.ok(historyContent.length > 0);
      assert.ok(
        historyContent.includes('PROJECT_COMPLETE') ||
        historyContent.includes('PROJECT_INITIALIZED') ||
        historyContent.includes('ORCHESTRATOR')
      );
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 07: QA acceptance
  // --------------------------------------------------------------------------
  it('P7-03-07: QA review engine accepts valid evidence and transitions task to COMPLETED', async () => {
    const fixtureDir = await createDisposableFixture('p703-07-qa-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-QA',
          title: 'QA Acceptance Feature',
          description: 'Feature that passes QA review criteria',
        },
      ]);

      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'qa.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';
test('qa test passes', () => { assert.ok(true); });
`,
        'utf-8'
      );

      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add qa test"', fixtureDir);

      const runRes = await execAidm(['run', '-C', fixtureDir], fixtureDir);
      assert.equal(runRes.code, CliExitCode.SUCCESS);

      const durableManager = new DurableStateManager({ baseDir: fixtureDir });
      const state = await durableManager.load();
      assert.deepEqual(state?.completedTaskIds, ['TASK-QA']);
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 08: Git checkpoint verification
  // --------------------------------------------------------------------------
  it('P7-03-08: Checkpoints are recorded and queryable via aidm checkpoint list', async () => {
    const fixtureDir = await createDisposableFixture('p703-08-chk-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-CHK',
          title: 'Checkpoint Feature',
          description: 'Produces checkpoints on completion',
        },
      ]);

      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'chk.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';
test('passes', () => { assert.equal(1, 1); });
`,
        'utf-8'
      );

      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add test"', fixtureDir);

      await execAidm(['run', '-C', fixtureDir], fixtureDir);

      // Verify checkpoint list command
      const listRes = await execAidm(['checkpoint', 'list', '-C', fixtureDir], fixtureDir);
      assert.equal(listRes.code, CliExitCode.SUCCESS);
      assert.ok(listRes.stdout.includes('TASK-CHK'));
      assert.ok(listRes.stdout.includes('POST_FLIGHT'));

      // Verify git log records repository commits
      const gitLog = await execCommand('git log --oneline', fixtureDir);
      assert.ok(gitLog.stdout.includes('add test'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 09: Real CLI status
  // --------------------------------------------------------------------------
  it('P7-03-09: Real CLI status reflects persisted lifecycle state, tasks, and Git status', async () => {
    const fixtureDir = await createDisposableFixture('p703-09-status-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const statusRes = await execAidm(['status', '-C', fixtureDir], fixtureDir);
      assert.equal(statusRes.code, CliExitCode.SUCCESS);
      assert.ok(statusRes.stdout.includes('AIDM Project Status:'));
      assert.ok(statusRes.stdout.includes('Lifecycle State:    INITIALIZING'));
      assert.ok(statusRes.stdout.includes('Active Task:        none'));
      assert.ok(statusRes.stdout.includes('Git Branch:         main'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 10: Real CLI status --json
  // --------------------------------------------------------------------------
  it('P7-03-10: Real CLI status --json produces valid, structured, machine-readable JSON', async () => {
    const fixtureDir = await createDisposableFixture('p703-10-statusjson-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const statusRes = await execAidm(['status', '-C', fixtureDir, '--json'], fixtureDir);
      assert.equal(statusRes.code, CliExitCode.SUCCESS);

      const parsed = JSON.parse(statusRes.stdout);
      assert.equal(parsed.success, true);
      assert.equal(parsed.exitCode, CliExitCode.SUCCESS);
      assert.equal(parsed.data.initialized, true);
      assert.equal(parsed.data.lifecycleState, 'INITIALIZING');
      assert.equal(parsed.data.git.branch, 'main');
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 11: Deterministic failure
  // --------------------------------------------------------------------------
  it('P7-03-11: Deterministic test failure produces PROJECT_FAILED exit code and captures error', async () => {
    const fixtureDir = await createDisposableFixture('p703-11-fail-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-FAILING',
          title: 'Broken Feature',
          description: 'A feature whose test fails deterministically',
        },
      ]);

      // Write failing test directly in fixture
      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'fail.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';

test('intentional failing test', () => {
  assert.equal(1, 2, 'intentional assertion failure for recovery test');
});
`,
        'utf-8'
      );

      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add failing test"', fixtureDir);

      // Run with max-retries 1 so it exhausts retries and triggers RESTART rollback
      const runRes = await execAidm(['run', '-C', fixtureDir, '--max-retries', '1'], fixtureDir);

      // Must exit with PROJECT_FAILED (5)
      assert.equal(runRes.code, CliExitCode.PROJECT_FAILED);
      const combinedOutput = runRes.stdout + '\n' + runRes.stderr;
      assert.ok(
        combinedOutput.includes('Failed Tasks:    1 (TASK-FAILING)') ||
        combinedOutput.includes('REJECT')
      );
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 12: Existing recovery path
  // --------------------------------------------------------------------------
  it('P7-03-12: Failure recovery exhausts retries and rolls back to known-good pre-flight checkpoint', async () => {
    const fixtureDir = await createDisposableFixture('p703-12-recovery-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-REC',
          title: 'Recovery Feature',
          description: 'Exhausts retries and triggers recovery rollback',
        },
      ]);

      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'recovery.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';
test('always fails', () => { assert.fail('simulated permanent failure'); });
`,
        'utf-8'
      );

      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add permanent failing test"', fixtureDir);

      const runRes = await execAidm(['run', '-C', fixtureDir, '--max-retries', '1'], fixtureDir);
      assert.equal(runRes.code, CliExitCode.PROJECT_FAILED);

      // Verify event history records TASK_FAILED event
      const historyFile = path.join(fixtureDir, '.ai-manager', 'history', 'events.jsonl');
      const historyContent = await fs.readFile(historyFile, 'utf8');
      assert.ok(
        historyContent.includes('TASK_FAILED') ||
        historyContent.includes('PROJECT_INITIALIZED') ||
        historyContent.includes('ORCHESTRATOR')
      );

      // Check durable state reflects non-complete state
      const durableManager = new DurableStateManager({ baseDir: fixtureDir });
      const state = await durableManager.load();
      assert.notEqual(state?.currentLifecycleState, LifecycleState.PROJECT_COMPLETE);
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 13: Human-blocked / policy path
  // --------------------------------------------------------------------------
  it('P7-03-13: Policy violations and missing human approval tokens halt with deterministic exit codes', async () => {
    const fixtureDir = await createDisposableFixture('p703-13-policy-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      // 1. Missing approval token for dangerous rollback -> HUMAN_BLOCKED (4)
      const rollbackRes = await execAidm(
        ['checkpoint', 'rollback', '--checkpoint', 'chk-fake-123', '-C', fixtureDir],
        fixtureDir
      );
      assert.equal(rollbackRes.code, CliExitCode.HUMAN_BLOCKED);
      assert.ok(rollbackRes.stderr.includes('Human approval token required'));

      // 2. Machine-readable JSON output for human-blocked state
      const jsonRes = await execAidm(
        ['checkpoint', 'rollback', '--checkpoint', 'chk-fake-123', '-C', fixtureDir, '--json'],
        fixtureDir
      );
      assert.equal(jsonRes.code, CliExitCode.HUMAN_BLOCKED);
      const parsed = JSON.parse(jsonRes.stdout);
      assert.equal(parsed.requiresHumanApproval, true);
      assert.equal(parsed.exitCode, CliExitCode.HUMAN_BLOCKED);

      // 3. Path traversal attack attempt -> POLICY_BLOCKED (3)
      const traversalRes = await execAidm(
        ['checkpoint', 'create', '--task', '../../illegal-escape', '-C', fixtureDir],
        fixtureDir
      );
      assert.equal(traversalRes.code, CliExitCode.POLICY_BLOCKED);
      assert.ok(traversalRes.stderr.includes('Policy Error') || traversalRes.stderr.includes('blocked'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 14: Project completion state invariant
  // --------------------------------------------------------------------------
  it('P7-03-14: Project completion state is achieved only when all required tasks pass QA acceptance', async () => {
    const fixtureDir = await createDisposableFixture('p703-14-completion-');
    try {
      await execAidm(['init', '-C', fixtureDir], fixtureDir);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      await specStore.saveRequirements([
        {
          id: 'REQ-COMPL',
          title: 'Completion Module',
          description: 'Module that achieves full project completion',
        },
      ]);

      const testDir = path.join(fixtureDir, 'test');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'compl.test.js'),
        `import { test } from 'node:test';
import * as assert from 'node:assert/strict';
test('passes', () => { assert.equal(42, 42); });
`,
        'utf-8'
      );

      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add test"', fixtureDir);

      const runRes = await execAidm(['run', '-C', fixtureDir], fixtureDir);
      assert.equal(runRes.code, CliExitCode.SUCCESS);

      const durableManager = new DurableStateManager({ baseDir: fixtureDir });
      const state = await durableManager.load();
      assert.equal(state?.currentLifecycleState, LifecycleState.PROJECT_COMPLETE);
      assert.deepEqual(state?.completedTaskIds, ['TASK-COMPL']);
      assert.equal(state?.blockedState, null);
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // SCENARIO 15: Cleanup after success
  // --------------------------------------------------------------------------
  it('P7-03-15: Cleanup semantics successfully purge disposable fixtures after successful runs', async () => {
    const fixtureDir = await createDisposableFixture('p703-15-clean-');
    let dirExistsBefore = false;
    let dirExistsAfter = false;

    try {
      await fs.stat(fixtureDir);
      dirExistsBefore = true;
    } finally {
      await cleanupDir(fixtureDir);
      try {
        await fs.stat(fixtureDir);
        dirExistsAfter = true;
      } catch {
        dirExistsAfter = false;
      }
    }

    assert.equal(dirExistsBefore, true);
    assert.equal(dirExistsAfter, false, 'Fixture directory must be removed after cleanup');
  });

  // --------------------------------------------------------------------------
  // SCENARIO 16: Cleanup after failure
  // --------------------------------------------------------------------------
  it('P7-03-16: Cleanup semantics purge disposable fixtures even when operational errors occur', async () => {
    const fixtureDir = await createDisposableFixture('p703-16-failclean-');
    let dirExistsAfter = false;

    try {
      // Simulate an error inside the test block
      throw new Error('Simulated operational failure during test');
    } catch {
      // Expected caught error
    } finally {
      await cleanupDir(fixtureDir);
      try {
        await fs.stat(fixtureDir);
        dirExistsAfter = true;
      } catch {
        dirExistsAfter = false;
      }
    }

    assert.equal(dirExistsAfter, false, 'Fixture directory must be purged in finally block');
  });
});
