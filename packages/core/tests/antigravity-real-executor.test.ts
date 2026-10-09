/**
 * Phase 14 TASK-P14-01: Real Antigravity Executor Test Suite
 *
 * Verifies the production Antigravity execution boundary:
 * 1. Real executable resolution (explicit path, environment, PATH, Windows extensions).
 * 2. Process runner abstraction (direct spawning, stdin piping, stdout/stderr capture, timeout, cancellation).
 * 3. CLI compatibility checking (version, protocol, required capabilities, auditability).
 * 4. Six execution states:
 *    - Executable not found (ERR_EXECUTOR_NOT_FOUND)
 *    - Process could not start (ERR_EXECUTOR_SPAWN_FAILED)
 *    - Process started and exited non-zero (FAILURE)
 *    - Process timed out (TIMEOUT)
 *    - Process exited successfully (SUCCESS)
 *    - Process output could not be interpreted safely (ERR_EXECUTOR_MALFORMED_OUTPUT)
 * 5. Safe output interpretation (NDJSON, single JSON, text, rejecting binary corruption / malformed frames).
 * 6. Strict architectural invariants (no permission bypass, no fake fallback in production, no workflow control).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  type ExecutionRequest,
  computeDeterministicRequestId,
  AntigravityAdapter,
  NodeAntigravityProcessRunner,
  FakeAntigravityProcessRunner,
  resolveAntigravityExecutable,
  findExecutableOnPath,
  AntigravityCompatibilityChecker,
  REQUIRED_ANTIGRAVITY_CAPABILITIES,
  DEFAULT_ANTIGRAVITY_PROTOCOL,
  parseExecutorProcessOutput,
  type RawExecutorOutcome,
  assertNotVerifiedEvidence,
  FakeGitPort,
  DurableStateManager,
  SpecStore,
  HistoryManager,
  ApprovalStore,
  ApprovalPackageEngine,
  HumanApprovalEngine,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  DirectorContextSynchronizer,
  InitialProjectUnderstandingBuilder,
  ExecutionAuthorizer,
  ExecutionRequestBuilder,
  TaskDagEngine,
  DefaultMcpOrchestratorDelegate,
  ContextEngine,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type ProjectDiscoveryReport,
} from '../dist/index.js';

describe('Phase 14 TASK-P14-01: Real Antigravity Executor Boundary', () => {
  let tempDir: string;
  let sampleRequest: ExecutionRequest;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p14-exec-'));

    const baseCommit = '1111222233334444555566667777888899990000';
    const computedId = computeDeterministicRequestId({
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      projectId: 'test-project',
      taskId: 'TASK-P14-01',
      taskRevision: 1,
      directorSessionId: 'sess-p14-01',
      directorDecisionId: 'dec-p14-01',
      contextFingerprint: 'ctx-p14-fp-01',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'EXECUTE_TEST',
      instruction: {
        objective: 'Implement real process executor boundary',
        acceptanceCriteria: ['Must execute real process', 'Must check compatibility'],
        constraints: ['Direct process spawning only'],
        targetFiles: ['src/executor.ts'],
        analysisScope: ['src/executor.ts'],
        implementationScope: ['src/executor.ts'],
      },
      executionLimits: {
        timeoutMs: 10_000,
        maxFileModifications: 5,
      },
      expectedRepositoryState: {
        baseCommit,
        isClean: true,
      },
    });

    sampleRequest = Object.freeze({
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      requestId: computedId,
      projectId: 'test-project',
      taskId: 'TASK-P14-01',
      taskRevision: 1,
      directorSessionId: 'sess-p14-01',
      directorDecisionId: 'dec-p14-01',
      contextFingerprint: 'ctx-p14-fp-01',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'EXECUTE_TEST',
      instruction: {
        objective: 'Implement real process executor boundary',
        acceptanceCriteria: ['Must execute real process', 'Must check compatibility'],
        constraints: ['Direct process spawning only'],
        targetFiles: ['src/executor.ts'],
        analysisScope: ['src/executor.ts'],
        implementationScope: ['src/executor.ts'],
      },
      executionLimits: {
        timeoutMs: 10_000,
        maxFileModifications: 5,
      },
      expectedRepositoryState: {
        baseCommit,
        isClean: true,
      },
    });
  });




  afterEach(() => {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================================================
  // 1. REAL AGY RESOLUTION
  // ==========================================================================
  describe('1. Real Executable Resolution', () => {
    it('resolves explicit binary path when file exists', () => {
      const dummyBin = path.join(tempDir, process.platform === 'win32' ? 'dummy.exe' : 'dummy');
      fs.writeFileSync(dummyBin, '#!/bin/sh\nexit 0\n');

      const res = resolveAntigravityExecutable({
        configuredBinaryPath: dummyBin,
        cwd: tempDir,
      });

      assert.strictEqual(res.found, true);
      assert.strictEqual(res.executablePath, dummyBin);
      assert.strictEqual(res.searchSource, 'explicit');
      assert.strictEqual(res.reason, null);
    });

    it('reports found: false when configured binary path does not exist', () => {
      const nonExistent = path.join(tempDir, 'does-not-exist-agy');

      const res = resolveAntigravityExecutable({
        configuredBinaryPath: nonExistent,
        cwd: tempDir,
      });

      assert.strictEqual(res.found, false);
      assert.strictEqual(res.executablePath, null);
      assert.strictEqual(res.searchSource, 'explicit');
      assert.ok(res.reason?.includes('not found'));
    });

    it('resolves via ANTIGRAVITY_BIN_PATH environment variable', () => {
      const envBin = path.join(tempDir, process.platform === 'win32' ? 'env-agy.exe' : 'env-agy');
      fs.writeFileSync(envBin, '#!/bin/sh\nexit 0\n');

      const res = resolveAntigravityExecutable({
        env: { ANTIGRAVITY_BIN_PATH: envBin },
        cwd: tempDir,
      });

      assert.strictEqual(res.found, true);
      assert.strictEqual(res.executablePath, envBin);
      assert.strictEqual(res.searchSource, 'env');
    });

    it('resolves via AGY_BIN_PATH environment variable', () => {
      const envBin = path.join(tempDir, process.platform === 'win32' ? 'agy-env.exe' : 'agy-env');
      fs.writeFileSync(envBin, '#!/bin/sh\nexit 0\n');

      const res = resolveAntigravityExecutable({
        env: { AGY_BIN_PATH: envBin },
        cwd: tempDir,
      });

      assert.strictEqual(res.found, true);
      assert.strictEqual(res.executablePath, envBin);
      assert.strictEqual(res.searchSource, 'env');
    });

    it('resolves bare command on custom PATH', () => {
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const commandName = process.platform === 'win32' ? 'custom-agy.exe' : 'custom-agy';
      const commandPath = path.join(binDir, commandName);
      fs.writeFileSync(commandPath, '#!/bin/sh\nexit 0\n');

      const resolved = findExecutableOnPath(
        'custom-agy',
        binDir,
        process.platform === 'win32'
      );

      assert.ok(resolved);
      assert.strictEqual(path.resolve(resolved!), path.resolve(commandPath));
    });

    it('reports found: false when bare command is not on PATH', () => {
      const res = resolveAntigravityExecutable({
        configuredBinaryPath: 'definitely-not-installed-command-999',
        env: { PATH: '' },
      });

      assert.strictEqual(res.found, false);
      assert.strictEqual(res.executablePath, null);
    });
  });

  // ==========================================================================
  // 2. PROCESS RUNNER ABSTRACTION & OS PROCESS SPAWNING
  // ==========================================================================
  describe('2. Process Runner Abstraction', () => {
    it('NodeAntigravityProcessRunner spawns real process, captures stdout, and measures duration', async () => {
      const runner = new NodeAntigravityProcessRunner();

      // Use node executable to test real process spawning cross-platform
      const nodeExe = process.execPath;
      const res = await runner.run({
        executable: nodeExe,
        args: ['-e', 'console.log("hello from real process")'],
        cwd: tempDir,
      });

      assert.strictEqual(res.exitCode, 0);
      assert.strictEqual(res.signal, null);
      assert.ok(res.stdout.includes('hello from real process'));
      assert.strictEqual(res.timedOut, false);
      assert.strictEqual(res.cancelled, false);
      assert.ok(res.durationMs >= 0);
    });

    it('NodeAntigravityProcessRunner captures stderr and non-zero exit code', async () => {
      const runner = new NodeAntigravityProcessRunner();
      const nodeExe = process.execPath;

      const res = await runner.run({
        executable: nodeExe,
        args: ['-e', 'console.error("fatal failure"); process.exit(42)'],
        cwd: tempDir,
      });

      assert.strictEqual(res.exitCode, 42);
      assert.ok(res.stderr.includes('fatal failure'));
      assert.strictEqual(res.timedOut, false);
    });

    it('NodeAntigravityProcessRunner pipes stdin input stream correctly', async () => {
      const runner = new NodeAntigravityProcessRunner();
      const nodeExe = process.execPath;

      const res = await runner.run({
        executable: nodeExe,
        args: ['-e', 'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data", d => s+=d); process.stdin.on("end", () => console.log("STDIN:" + s))'],
        cwd: tempDir,
        stdinInput: '{"test":"payload"}\n',
      });

      assert.strictEqual(res.exitCode, 0);
      assert.ok(res.stdout.includes('STDIN:{"test":"payload"}'));
    });

    it('NodeAntigravityProcessRunner enforces timeout termination', async () => {
      const runner = new NodeAntigravityProcessRunner();
      const nodeExe = process.execPath;

      const res = await runner.run({
        executable: nodeExe,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: tempDir,
        timeoutMs: 300,
      });

      assert.strictEqual(res.timedOut, true);
    });

    it('NodeAntigravityProcessRunner handles AbortSignal cancellation', async () => {
      const runner = new NodeAntigravityProcessRunner();
      const nodeExe = process.execPath;
      const abortController = new AbortController();

      setTimeout(() => abortController.abort(), 100);

      const res = await runner.run({
        executable: nodeExe,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: tempDir,
        timeoutMs: 10000,
        signal: abortController.signal,
      });

      assert.strictEqual(res.cancelled, true);
    });

    it('NodeAntigravityProcessRunner captures spawn error for non-existent executable', async () => {
      const runner = new NodeAntigravityProcessRunner();

      const res = await runner.run({
        executable: path.join(tempDir, 'does-not-exist-bin-exe'),
        args: [],
        cwd: tempDir,
      });

      assert.ok(res.spawnError);
      assert.strictEqual(res.exitCode, null);
    });

    it('FakeAntigravityProcessRunner operates deterministically in memory', async () => {
      const fake = new FakeAntigravityProcessRunner(async (opts) => {
        assert.ok(opts.args.includes('--print'));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ agent_claims: ['Deterministic fake claim'] }),
        };
      });

      const res = await fake.run({
        executable: 'agy',
        args: ['--print'],
        cwd: tempDir,
      });

      assert.strictEqual(res.exitCode, 0);
      assert.ok(res.stdout.includes('Deterministic fake claim'));
      assert.strictEqual(fake.executedCalls.length, 1);
    });
  });

  // ==========================================================================
  // 3. CLI COMPATIBILITY BOUNDARY
  // ==========================================================================
  describe('3. CLI Compatibility Boundary', () => {
    it('detects compatible executable when all contract capabilities are present', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        if (opts.args.includes('--version')) {
          return { exitCode: 0, stdout: '1.2.11\n' };
        }
        if (opts.args.includes('--help')) {
          return {
            exitCode: 0,
            stdout: `Usage of agy:
  --add-dir                       Add a directory to the workspace
  --input-format                  Input format for print mode (text, stream-json)
  --output-format                 Output format for print mode (text, json, stream-json)
  --print                         Run a single prompt non-interactively
  --project                       Project ID for session`,
          };
        }
        return { exitCode: 0, stdout: '' };
      });

      const checker = new AntigravityCompatibilityChecker(fakeRunner);
      const compat = await checker.checkCompatibility({
        executablePath: 'agy',
        found: true,
        resolvedVia: 'CONFIGURED',
      });

      assert.strictEqual(compat.compatible, true);
      assert.strictEqual(compat.version, '1.2.11');
      assert.strictEqual(compat.protocol, DEFAULT_ANTIGRAVITY_PROTOCOL);
      assert.strictEqual(compat.reason, null);
      for (const req of REQUIRED_ANTIGRAVITY_CAPABILITIES) {
        assert.ok(compat.capabilities.includes(req), `Expected capability ${req}`);
      }
    });

    it('detects incompatibility when required capability is missing', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        if (opts.args.includes('--version')) {
          return { exitCode: 0, stdout: '0.9.0\n' };
        }
        if (opts.args.includes('--help')) {
          // Missing --input-format stream-json
          return {
            exitCode: 0,
            stdout: `Usage of legacy-cli:
  --print     Run non-interactively`,
          };
        }
        return { exitCode: 0, stdout: '' };
      });

      const checker = new AntigravityCompatibilityChecker(fakeRunner);
      const compat = await checker.checkCompatibility({
        executablePath: 'legacy-agy',
        found: true,
        resolvedVia: 'CONFIGURED',
      });

      assert.strictEqual(compat.compatible, false);
      assert.ok(compat.reason?.includes('missing required capabilities'));
      assert.ok(!compat.capabilities.includes('input-format:stream-json'));
    });

    it('reports incompatible when executable is not found', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner();
      const checker = new AntigravityCompatibilityChecker(fakeRunner);
      const compat = await checker.checkCompatibility(path.join(tempDir, 'missing-agy'));

      assert.strictEqual(compat.compatible, false);
      assert.strictEqual(compat.version, null);
      assert.ok(compat.reason?.includes('not found'));
    });

    it('probes real installed agy CLI if present on this host system', async () => {
      if (process.env.AIDM_LIVE_E2E !== '1') {
        // Opt-in live test only; skipped in deterministic offline test runs
        return;
      }
      const realResolution = resolveAntigravityExecutable();
      if (!realResolution.found || !realResolution.executablePath) {
        // Skip live CLI check if not installed in this environment
        return;
      }

      const realRunner = new NodeAntigravityProcessRunner();
      const checker = new AntigravityCompatibilityChecker(realRunner);
      const compat = await checker.checkCompatibility(realResolution.executablePath);

      assert.strictEqual(compat.compatible, true);
      assert.ok(compat.version);
      assert.ok(compat.capabilities.includes('print'));
      assert.ok(compat.capabilities.includes('input-format:stream-json'));
      assert.ok(compat.capabilities.includes('output-format:stream-json'));
      assert.ok(compat.capabilities.includes('project'));
      assert.ok(compat.capabilities.includes('add-dir'));
    });
  });

  // ==========================================================================
  // 4. SIX EXECUTION STATES IN ANTIGRAVITY ADAPTER
  // ==========================================================================
  describe('4. Six Execution States Distinction', () => {
    it('State 1: Executable not found produces ERR_EXECUTOR_NOT_FOUND', async () => {
      const nonExistent = path.join(tempDir, 'no-such-binary-agy');
      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: nonExistent,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'ERROR');
      assert.strictEqual(outcome.error?.code, 'ERR_EXECUTOR_NOT_FOUND');
      assert.ok(outcome.error?.message.includes('not found'));
      assertNotVerifiedEvidence(outcome);
    });

    it('State 2: Process could not start produces ERR_EXECUTOR_SPAWN_FAILED', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => {
        return {
          spawnError: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
          exitCode: null,
          stdout: '',
          stderr: 'permission denied',
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'ERROR');
      assert.strictEqual(outcome.error?.code, 'ERR_EXECUTOR_SPAWN_FAILED');
      assert.ok(outcome.error?.message.includes('Process could not start'));
      assertNotVerifiedEvidence(outcome);
    });

    it('State 3: Process started and exited non-zero produces FAILURE', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => {
        return {
          exitCode: 1,
          signal: null,
          stdout: 'Execution failed during task implementation',
          stderr: 'Error: Module not found',
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'FAILURE');
      assert.strictEqual(outcome.exitCode, 1);
      assert.ok(outcome.stderr?.includes('Error: Module not found'));
      assert.strictEqual(outcome.timedOut, false);
      assertNotVerifiedEvidence(outcome);
    });

    it('State 4: Process timed out produces TIMEOUT', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => {
        return {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: 'Execution timed out',
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'TIMEOUT');
      assert.strictEqual(outcome.timedOut, true);
      assert.strictEqual(outcome.exitCode, null);
      assertNotVerifiedEvidence(outcome);
    });

    it('State 5: Process exited successfully produces SUCCESS with safe claims', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        assert.ok(opts.stdinInput);
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            agent_claims: ['Created adapter boundary', 'Updated exports'],
            unverified_changed_files: ['src/executor.ts'],
            metadata: { turns: 3 },
          }),
          stderr: '',
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'SUCCESS');
      assert.strictEqual(outcome.exitCode, 0);
      assert.deepStrictEqual(outcome.unverifiedAgentClaims, ['Created adapter boundary', 'Updated exports']);
      assert.deepStrictEqual(outcome.unverifiedModifiedFiles, ['src/executor.ts']);
      assert.strictEqual(outcome.executorMetadata?.turns, 3);
      assertNotVerifiedEvidence(outcome);
    });

    it('State 6: Process output could not be interpreted safely produces ERR_EXECUTOR_MALFORMED_OUTPUT', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => {
        return {
          exitCode: 0,
          signal: null,
          // Corrupted stream-json frame (truncated JSON)
          stdout: '{"type":"turn","truncated_json":',
          stderr: '',
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'ERROR');
      assert.strictEqual(outcome.error?.code, 'ERR_EXECUTOR_MALFORMED_OUTPUT');
      assert.ok(outcome.error?.message.includes('could not be interpreted safely'));
      assertNotVerifiedEvidence(outcome);
    });
  });

  // ==========================================================================
  // 5. SAFE OUTPUT INTERPRETATION
  // ==========================================================================
  describe('5. Safe Output Interpretation', () => {
    it('parses valid single JSON object with claims and files', () => {
      const stdout = JSON.stringify({
        agent_claims: ['Claim A', 'Claim B'],
        unverified_changed_files: ['file1.ts', 'file2.ts'],
        metadata: { runId: 'r1' },
      });

      const parsed = parseExecutorProcessOutput(stdout, sampleRequest);

      assert.strictEqual(parsed.safe, true);
      assert.deepStrictEqual(parsed.agentClaims, ['Claim A', 'Claim B']);
      assert.deepStrictEqual(parsed.modifiedFiles, ['file1.ts', 'file2.ts']);
      assert.strictEqual(parsed.metadata?.runId, 'r1');
    });

    it('parses stream-json NDJSON lines safely', () => {
      const stdout = [
        JSON.stringify({ type: 'turn_start', turn: 1 }),
        JSON.stringify({ type: 'turn_event', agent_claims: ['Claim 1'], unverified_changed_files: ['a.ts'] }),
        JSON.stringify({ type: 'turn_complete', agent_claims: ['Claim 2'], unverified_changed_files: ['b.ts'] }),
      ].join('\n');

      const parsed = parseExecutorProcessOutput(stdout, sampleRequest);

      assert.strictEqual(parsed.safe, true);
      assert.deepStrictEqual(parsed.agentClaims, ['Claim 1', 'Claim 2']);
      assert.deepStrictEqual(parsed.modifiedFiles, ['a.ts', 'b.ts']);
    });

    it('rejects output containing null bytes or binary corruption', () => {
      const stdout = 'Binary output with null \0 byte';
      const parsed = parseExecutorProcessOutput(stdout, sampleRequest);

      assert.strictEqual(parsed.safe, false);
      assert.ok(parsed.reason?.includes('null bytes'));
    });

    it('handles empty stdout safely with fallback to targetFiles', () => {
      const stdout = '   ';
      const parsed = parseExecutorProcessOutput(stdout, sampleRequest);

      assert.strictEqual(parsed.safe, true);
      assert.deepStrictEqual(parsed.modifiedFiles, sampleRequest.instruction.targetFiles);
    });
  });

  // ==========================================================================
  // 6. ARCHITECTURAL INVARIANTS & INTEGRATION
  // ==========================================================================
  describe('6. Architectural Invariants & Integration', () => {
    it('never includes --dangerously-skip-permissions in spawned arguments', async () => {
      let capturedArgs: readonly string[] = [];
      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        capturedArgs = opts.args;
        return { exitCode: 0, stdout: JSON.stringify({ agent_claims: [] }) };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      await adapter.execute(sampleRequest);

      assert.strictEqual(capturedArgs.includes('--dangerously-skip-permissions'), false);
      assert.ok(capturedArgs.includes('--print'));
      assert.ok(capturedArgs.includes('--input-format'));
      assert.ok(capturedArgs.includes('--output-format'));
    });

    it('preserves immutable requestBinding in real process outcome', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ agent_claims: ['Completed'] }),
      }));

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.requestId, sampleRequest.requestId);
      assert.strictEqual(outcome.requestBinding.requestId, sampleRequest.requestId);
      assert.strictEqual(outcome.requestBinding.taskId, sampleRequest.taskId);
      assert.strictEqual(outcome.requestBinding.taskRevision, sampleRequest.taskRevision);
      assert.strictEqual(outcome.requestBinding.projectId, sampleRequest.projectId);
      assert.strictEqual(outcome.requestBinding.contextFingerprint, sampleRequest.contextFingerprint);
    });

    it('checkAvailability integrates compatibility checking cleanly', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        if (opts.args.includes('--version')) return { exitCode: 0, stdout: '1.2.11\n' };
        if (opts.args.includes('--help')) {
          return {
            exitCode: 0,
            stdout: '--print --input-format stream-json --output-format stream-json --project --add-dir',
          };
        }
        return { exitCode: 0, stdout: '' };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
      });

      const avail = await adapter.checkAvailability();
      assert.strictEqual(avail.available, true);
    });
  });
});
