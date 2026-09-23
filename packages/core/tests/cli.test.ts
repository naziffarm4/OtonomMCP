import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  executeCli,
  parseCliTokens,
  CliExitCode,
  sanitizeSecrets,
  sanitizeCliSecrets,
  DurableStateManager,
  SpecStore,
  LifecycleState,
  Actor,
} from '../dist/index.js';

interface TestCapture {
  stdout: string[];
  stderr: string[];
  capture: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
}

function createCapture(): TestCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    capture: {
      stdout: (t: string) => stdout.push(t),
      stderr: (t: string) => stderr.push(t),
    },
  };
}

async function createTempFixture(prefix = 'aidm-cli-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // Initialize git repository
  await execCommand('git init -b main', dir);
  await execCommand('git config user.name "AIDM Test"', dir);
  await execCommand('git config user.email "test@aidm.local"', dir);

  // Initial package.json
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'disposable-fixture', version: '1.0.0', type: 'module' }, null, 2)
  );

  // Initial commit
  await execCommand('git add -A', dir);
  await execCommand('git commit -m "init fixture"', dir);

  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Retry on Windows in case of transient locks
    await new Promise((r) => setTimeout(r, 200));
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

function execCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    child_process.exec(cmd, { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: error?.code ?? 0,
      });
    });
  });
}

describe('Phase 7 — AIDM CLI Hardening & Packaging (TASK-P7-02)', () => {
  // --------------------------------------------------------------------------
  // TEST 1: aidm --help
  // --------------------------------------------------------------------------
  it('T01_help: --help displays usage, commands, and global options', async () => {
    const { stdout, capture } = createCapture();
    const result = await executeCli(['--help'], capture);

    assert.equal(result.exitCode, CliExitCode.SUCCESS);
    const output = stdout.join('\n');
    assert.ok(output.includes('Usage:'));
    assert.ok(output.includes('aidm <command> [options]'));
    assert.ok(output.includes('init'));
    assert.ok(output.includes('run'));
    assert.ok(output.includes('status'));
    assert.ok(output.includes('checkpoint'));
    assert.ok(output.includes('--json'));
  });

  // --------------------------------------------------------------------------
  // TEST 2: aidm --version
  // --------------------------------------------------------------------------
  it('T02_version: --version displays semantic version', async () => {
    const { stdout, capture } = createCapture();
    const result = await executeCli(['--version'], capture);

    assert.equal(result.exitCode, CliExitCode.SUCCESS);
    assert.ok(stdout.some((line) => line.includes('v0.1.0')));
  });

  // --------------------------------------------------------------------------
  // TEST 3: unknown command returns USAGE_ERROR (exit code 2)
  // --------------------------------------------------------------------------
  it('T03_unknown_command: unknown command outputs safe error and returns USAGE_ERROR (2)', async () => {
    const { stderr, capture } = createCapture();
    const result = await executeCli(['unknown-subcommand'], capture);

    assert.equal(result.exitCode, CliExitCode.USAGE_ERROR);
    assert.ok(result.error?.includes('Unknown command'));
    assert.ok(stderr.some((line) => line.includes('Unknown command')));
  });

  // --------------------------------------------------------------------------
  // TEST 4: aidm init
  // --------------------------------------------------------------------------
  it('T04_init: aidm init creates .ai-manager structure and baseline governance (DEC-001)', async () => {
    const fixtureDir = await createTempFixture('t04-init-');
    try {
      const { stdout, capture } = createCapture();
      const result = await executeCli(['init', '-C', fixtureDir], capture);

      assert.equal(result.exitCode, CliExitCode.SUCCESS);
      assert.ok(stdout.some((l) => l.includes('Initialized AIDM project')));

      // Verify files created
      const durableManager = new DurableStateManager({ baseDir: fixtureDir });
      assert.equal(await durableManager.exists(), true);
      const state = await durableManager.load();
      assert.ok(state);
      assert.equal(state.currentLifecycleState, LifecycleState.INITIALIZING);
      assert.deepEqual(state.completedTaskIds, []);

      const specStore = new SpecStore({ baseDir: fixtureDir });
      const decisions = await specStore.loadDecisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].id, 'DEC-001');
      assert.equal(decisions[0].status, 'LOCKED');
      assert.equal(decisions[0].authority, Actor.DIRECTOR);

      // Re-running without --force must fail with USAGE_ERROR
      const secondRun = await executeCli(['init', '-C', fixtureDir], createCapture().capture);
      assert.equal(secondRun.exitCode, CliExitCode.USAGE_ERROR);

      // Re-running with --force must succeed
      const forcedRun = await executeCli(['init', '-C', fixtureDir, '--force'], createCapture().capture);
      assert.equal(forcedRun.exitCode, CliExitCode.SUCCESS);
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 5: aidm status (read-only)
  // --------------------------------------------------------------------------
  it('T05_status: aidm status reads lifecycle state and git information without mutation', async () => {
    const fixtureDir = await createTempFixture('t05-status-');
    try {
      // Uninitialized status check
      const uninitRes = await executeCli(['status', '-C', fixtureDir], createCapture().capture);
      assert.equal(uninitRes.exitCode, CliExitCode.USAGE_ERROR);

      // Initialize
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);
      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "commit init"', fixtureDir);

      // Status check
      const { stdout, capture } = createCapture();
      const result = await executeCli(['status', '-C', fixtureDir], capture);

      assert.equal(result.exitCode, CliExitCode.SUCCESS);
      const output = stdout.join('\n');
      assert.ok(output.includes('AIDM Project Status:'));
      assert.ok(output.includes('Lifecycle State:'));
      assert.ok(output.includes('Working Tree Clean: YES'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 6: aidm status displays blocked state
  // --------------------------------------------------------------------------
  it('T06_status_blocked: aidm status surfaces blocked state details without mutating state', async () => {
    const fixtureDir = await createTempFixture('t06-blocked-');
    try {
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);

      // Simulate a blocked state recorded in durable-state.json
      const durableManager = new DurableStateManager({ baseDir: fixtureDir });
      const current = await durableManager.load();
      await durableManager.save({
        ...current!,
        currentLifecycleState: LifecycleState.BLOCKED_ON_HUMAN,
        activeTaskId: 'TASK-001',
        blockedState: {
          blockedTaskId: 'TASK-001',
          blockedIteration: 2,
          blockedContextReference: 'ctx-ref-001',
          blockingReason: 'Critical architectural decision required regarding database engine',
          resumePoint: 'INSTRUCT_ANTIGRAVITY',
          timestamp: new Date().toISOString(),
        },
      });

      const { stdout, capture } = createCapture();
      const result = await executeCli(['status', '-C', fixtureDir], capture);

      assert.equal(result.exitCode, CliExitCode.SUCCESS);
      const output = stdout.join('\n');
      assert.ok(output.includes('[BLOCKED STATE]'));
      assert.ok(output.includes('Critical architectural decision required'));
      assert.ok(output.includes('TASK-001'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 7: aidm checkpoint (list, create)
  // --------------------------------------------------------------------------
  it('T07_checkpoint_create_and_list: creates and lists checkpoints via GitCheckpointManager', async () => {
    const fixtureDir = await createTempFixture('t07-cp-');
    try {
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);
      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "commit init"', fixtureDir);

      // 1. Create a checkpoint
      const { stdout: createOut, capture: createCaptureObj } = createCapture();
      const createRes = await executeCli(
        ['checkpoint', 'create', '-C', fixtureDir, '--task', 'TASK-P7-TEST', '--purpose', 'PRE_FLIGHT'],
        createCaptureObj
      );

      assert.equal(createRes.exitCode, CliExitCode.SUCCESS);
      assert.ok(createOut.some((l) => l.includes('Created checkpoint')));

      // 2. List checkpoints
      const { stdout: listOut, capture: listCaptureObj } = createCapture();
      const listRes = await executeCli(['checkpoint', 'list', '-C', fixtureDir], listCaptureObj);

      assert.equal(listRes.exitCode, CliExitCode.SUCCESS);
      assert.ok(listOut.some((l) => l.includes('TASK-P7-TEST')));
      assert.ok(listOut.some((l) => l.includes('PRE_FLIGHT')));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 8: aidm checkpoint rollback requires authorization token (HUMAN_BLOCKED / 4)
  // --------------------------------------------------------------------------
  it('T08_checkpoint_rollback_requires_token: rollback without approval token is blocked by PolicyEngine', async () => {
    const fixtureDir = await createTempFixture('t08-rb-');
    try {
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);
      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "commit init"', fixtureDir);

      // Create a checkpoint
      const createRes = await executeCli(
        ['checkpoint', 'create', '-C', fixtureDir, '--task', 'TASK-P7-RB'],
        createCapture().capture
      );
      assert.equal(createRes.exitCode, CliExitCode.SUCCESS);
      const checkpointId = (createRes.data as any).checkpointId;

      // Attempt rollback without token -> must be blocked
      const { stderr, capture } = createCapture();
      const blockedRes = await executeCli(
        ['checkpoint', 'rollback', '-C', fixtureDir, '--checkpoint', checkpointId],
        capture
      );

      // Exit code 4 (HUMAN_BLOCKED) because dangerous operation requires human approval token
      assert.equal(blockedRes.exitCode, CliExitCode.HUMAN_BLOCKED);
      assert.ok(stderr.some((l) => l.includes('approval token required')));

      // Attempt rollback with valid token -> must succeed
      const { stdout: successOut, capture: successCapture } = createCapture();
      const successRes = await executeCli(
        [
          'checkpoint',
          'rollback',
          '-C',
          fixtureDir,
          '--checkpoint',
          checkpointId,
          '--token',
          'VALID_HUMAN_APPROVAL_TOKEN',
        ],
        successCapture
      );

      assert.equal(successRes.exitCode, CliExitCode.SUCCESS);
      assert.ok(successOut.some((l) => l.includes('Successfully rolled back')));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 9: aidm run (dry run)
  // --------------------------------------------------------------------------
  it('T09_run_dry_run: aidm run --dry-run validates requirements and DAG without executing tasks', async () => {
    const fixtureDir = await createTempFixture('t09-dry-');
    try {
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);

      // Write a sample requirements file
      const reqFile = path.join(fixtureDir, 'requirements.json');
      await fs.writeFile(
        reqFile,
        JSON.stringify(
          [
            {
              id: 'REQ-001',
              title: 'Math Utility',
              description: 'Compute square roots and squares',
              acceptance_criteria: ['Returns correct square'],
            },
          ],
          null,
          2
        )
      );

      const { stdout, capture } = createCapture();
      const result = await executeCli(
        ['run', '-C', fixtureDir, '--requirements', reqFile, '--dry-run'],
        capture
      );

      assert.equal(result.exitCode, CliExitCode.SUCCESS);
      const output = stdout.join('\n');
      assert.ok(output.includes('DAG and requirements validation passed (--dry-run)'));
      assert.ok(output.includes('Requirements:    1'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 10: aidm run (successful execution -> exit code 0)
  // --------------------------------------------------------------------------
  it('T10_run_success: autonomous lifecycle execution delegates to AutonomousLifecycleHarness and exits with 0', async () => {
    const fixtureDir = await createTempFixture('t10-run-');
    try {
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);

      // Write test source and passing test file
      const reqFile = path.join(fixtureDir, 'requirements.json');
      await fs.writeFile(
        reqFile,
        JSON.stringify(
          [
            {
              id: 'REQ-ADD',
              title: 'Adder Function',
              description: 'Adds two numbers',
              acceptance_criteria: ['test passed'],
            },
          ],
          null,
          2
        )
      );

      // Write implementation and test files directly so test runner will pass
      await fs.mkdir(path.join(fixtureDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(fixtureDir, 'test'), { recursive: true });
      await fs.writeFile(
        path.join(fixtureDir, 'src', 'add.js'),
        'export function add(a, b) { return a + b; }\n'
      );
      await fs.writeFile(
        path.join(fixtureDir, 'test', 'add.test.js'),
        `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/add.js';

describe('add', () => {
  it('adds two numbers', () => {
    assert.equal(add(1, 2), 3);
  });
});
`
      );

      // Commit changes so working tree is clean for pre-flight checkpoint
      await execCommand('git add -A', fixtureDir);
      await execCommand('git commit -m "add test and implementation"', fixtureDir);

      const { stdout, capture } = createCapture();
      const result = await executeCli(
        ['run', '-C', fixtureDir, '--requirements', reqFile],
        capture
      );

      assert.equal(result.exitCode, CliExitCode.SUCCESS);
      const output = stdout.join('\n');
      assert.ok(output.includes('Autonomous run completed successfully'));
      assert.ok(output.includes('PROJECT_COMPLETE'));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 11: Machine-readable JSON output (--json)
  // --------------------------------------------------------------------------
  it('T11_json_output: --json produces valid, structured, machine-readable JSON', async () => {
    const fixtureDir = await createTempFixture('t11-json-');
    try {
      const { stdout, capture } = createCapture();
      const result = await executeCli(['init', '-C', fixtureDir, '--json'], capture);

      assert.equal(result.exitCode, CliExitCode.SUCCESS);
      const parsed = JSON.parse(stdout.join(''));
      assert.equal(parsed.success, true);
      assert.equal(parsed.exitCode, 0);
      assert.equal(parsed.data.initialized, true);
      assert.equal(parsed.data.lifecycleState, LifecycleState.INITIALIZING);
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 12: Secret redaction in output
  // --------------------------------------------------------------------------
  it('T12_secret_redaction: API keys, tokens, and credentials are redacted from CLI output', () => {
    const rawWithSecrets =
      'Authorization: Bearer sk-ant-api03-abcdef12345678901234567890 and password=mySecretPassword123';
    const sanitized = sanitizeCliSecrets(rawWithSecrets);

    assert.ok(!sanitized.includes('sk-ant-api03-abcdef12345678901234567890'));
    assert.ok(!sanitized.includes('mySecretPassword123'));
    assert.ok(sanitized.includes('REDACTED'));
  });

  // --------------------------------------------------------------------------
  // TEST 13: PolicyEngine enforcement (path traversal outside workspace blocked)
  // --------------------------------------------------------------------------
  it('T13_policy_enforcement: operations attempting to traverse outside project root are blocked', async () => {
    const fixtureDir = await createTempFixture('t13-policy-');
    try {
      await executeCli(['init', '-C', fixtureDir], createCapture().capture);

      // Attempt to access parent path outside fixture root
      const { stderr, capture } = createCapture();
      const result = await executeCli(
        ['checkpoint', 'create', '-C', fixtureDir, '--task', '../../illegal-task'],
        capture
      );

      // Traversal blocked by policy
      assert.equal(result.exitCode, CliExitCode.POLICY_BLOCKED);
      assert.ok(stderr.some((l) => l.includes('Policy Error') || l.includes('blocked')));
    } finally {
      await cleanupDir(fixtureDir);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 14: Executable packaging & subprocess invocation
  // --------------------------------------------------------------------------
  it('T14_executable_subprocess: bin/aidm.js executable script runs via Node child process', async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const cliBin = path.resolve(testDir, '../bin/aidm.js');
    const res = await execCommand(`node "${cliBin}" --version`, process.cwd());

    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('v0.1.0'));
  });
});
