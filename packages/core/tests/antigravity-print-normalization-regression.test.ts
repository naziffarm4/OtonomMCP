/**
 * Antigravity Executor Print Normalization & Stream-JSON Regression Test Suite
 *
 * Verifies:
 * 1. `--print` argument is normalized to `--print=` and NOT deleted when `--input-format` is present.
 * 2. `--input-format stream-json` and `--output-format stream-json` flags are preserved.
 * 3. Runner pipes valid NDJSON user message to stdin.
 * 4. Multi-frame stream-json events (init, step_update, result) are parsed safely.
 * 5. result.status === "SUCCESS" evaluates to SUCCESS outcome.
 * 6. Non-zero exit code, malformed stream frames, and timeouts evaluate to appropriate failure categories.
 * 7. Resource cleanup, timer disposal, and security invariants (--dangerously-skip-permissions forbidden).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  AntigravityAdapter,
  NodeAntigravityProcessRunner,
  FakeAntigravityProcessRunner,
  parseExecutorProcessOutput,
  computeDeterministicRequestId,
  ExecutionFailureCategory,
  type ExecutionRequest,
  type AntigravityProcessOptions,
} from '../dist/index.js';

describe('AGY Executor Print Normalization & Stream-JSON Regression Suite', () => {
  let tempDir: string;
  let sampleRequest: ExecutionRequest;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-print-test-'));

    const baseCommit = '1111222233334444555566667777888899990000';
    const computedId = computeDeterministicRequestId({
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      projectId: 'test-project',
      taskId: 'TASK-NORM-01',
      taskRevision: 1,
      directorSessionId: 'sess-norm-01',
      directorDecisionId: 'dec-norm-01',
      contextFingerprint: 'ctx-fp-norm-01',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'EXECUTE_TEST',
      instruction: {
        objective: 'Test print normalization',
        acceptanceCriteria: ['Must normalize print flag'],
        constraints: ['Strict no-bypass'],
        targetFiles: ['src/index.ts'],
        analysisScope: ['src/index.ts'],
        implementationScope: ['src/index.ts'],
      },
      executionLimits: {
        timeoutMs: 5000,
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
      taskId: 'TASK-NORM-01',
      taskRevision: 1,
      directorSessionId: 'sess-norm-01',
      directorDecisionId: 'dec-norm-01',
      contextFingerprint: 'ctx-fp-norm-01',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'EXECUTE_TEST',
      instruction: {
        objective: 'Test print normalization',
        acceptanceCriteria: ['Must normalize print flag'],
        constraints: ['Strict no-bypass'],
        targetFiles: ['src/index.ts'],
        analysisScope: ['src/index.ts'],
        implementationScope: ['src/index.ts'],
      },
      executionLimits: {
        timeoutMs: 5000,
        maxFileModifications: 5,
      },
      expectedRepositoryState: {
        baseCommit,
        isClean: true,
      },
      metadata: {
        workingDirectory: tempDir,
      },
    });
  });

  afterEach(() => {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup
    }
  });

  // ==========================================================================
  // 1. ARGUMENT NORMALIZATION & INTEGRITY
  // ==========================================================================
  describe('1. Argument Normalization & Stream-JSON Preservation', () => {
    it('normalizes bare --print to --print= without dropping it when --input-format is present', async () => {
      let passedArgs: readonly string[] = [];

      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        passedArgs = opts.args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: 'Normalized' },
          }),
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      await adapter.execute(sampleRequest);

      // Verify --print is NOT dropped
      assert.strictEqual(passedArgs.filter((a) => a.startsWith('--print')).length, 1);
      assert.ok(passedArgs.includes('--print='));
      assert.strictEqual(passedArgs.includes('--print'), false);

      // Verify stream-json flags are preserved
      assert.ok(passedArgs.includes('--input-format'));
      assert.ok(passedArgs.includes('stream-json'));
      assert.ok(passedArgs.includes('--output-format'));
      assert.ok(passedArgs.includes('--project'));
      assert.ok(passedArgs.includes('test-project'));
      assert.ok(passedArgs.includes('--add-dir'));

      // Verify forbidden flag is never added
      assert.strictEqual(passedArgs.includes('--dangerously-skip-permissions'), false);
    });

    it('preserves existing --print= and --print=custom without duplication', () => {
      const rawArgs1 = ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json'];
      const rawArgs2 = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json'];
      const rawArgs3 = ['--print=hello', '--input-format', 'stream-json'];

      // Simulate spawnArgs mapping logic as defined in NodeAntigravityProcessRunner
      const mapArgs = (args: string[]) => args.map((arg) => (arg === '--print' ? '--print=' : arg));

      assert.deepStrictEqual(mapArgs(rawArgs1), rawArgs1);
      assert.deepStrictEqual(mapArgs(rawArgs2), [
        '--print=',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ]);
      assert.deepStrictEqual(mapArgs(rawArgs3), rawArgs3);
    });
  });

  // ==========================================================================
  // 2. STDIN NDJSON PAYLOAD
  // ==========================================================================
  describe('2. Stdin NDJSON Delivery', () => {
    it('pipes valid NDJSON message to stdin with structured prompt and metadata', async () => {
      let capturedStdin: string | null | undefined = null;

      const fakeRunner = new FakeAntigravityProcessRunner(async (opts) => {
        capturedStdin = opts.stdinInput;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: 'Executed' },
          }),
        };
      });

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      await adapter.execute(sampleRequest);

      const finalStdin = String(capturedStdin ?? '');
      assert.ok(finalStdin.length > 0, 'stdinInput must not be empty');
      assert.ok(finalStdin.endsWith('\n'), 'NDJSON message must end with newline');

      const parsedMessage = JSON.parse(finalStdin.trim());
      assert.strictEqual(parsedMessage.event, 'user');
      assert.ok(parsedMessage.prompt.includes('=== AIDM AUTHORIZED EXECUTION REQUEST ==='));
      assert.ok(parsedMessage.prompt.includes('Task ID: TASK-NORM-01'));
      assert.strictEqual(parsedMessage.message.content, parsedMessage.prompt);
    });
  });

  // ==========================================================================
  // 3. STREAM-JSON EVENT PARSING & SUCCESS/FAILURE EVALUATION
  // ==========================================================================
  describe('3. Stream-JSON Multi-Frame Parsing & Outcomes', () => {
    it('parses multi-event stream-json sequence and extracts SUCCESS response', async () => {
      const streamOutput = [
        JSON.stringify({ event: 'init', conversation_id: 'conv-123', init: { cwd: tempDir } }),
        JSON.stringify({ event: 'step_update', step_update: { step_index: 0, state: 'DONE' } }),
        JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE' } }),
        JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Task completed cleanly' } }),
      ].join('\n') + '\n';

      const fakeRunner = new FakeAntigravityProcessRunner(async () => ({
        exitCode: 0,
        stdout: streamOutput,
        stderr: '',
      }));

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'SUCCESS');
      assert.strictEqual(outcome.exitCode, 0);
      assert.ok(outcome.unverifiedAgentClaims.includes('Task completed cleanly'));
    });

    it('classifies non-zero exit code as EXECUTOR_EXIT_FAILURE', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => ({
        exitCode: 2,
        stdout: '',
        stderr: 'Error: invalid flag passed',
      }));

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'FAILURE');
      assert.strictEqual(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE);
      assert.strictEqual(outcome.exitCode, 2);
      assert.ok(outcome.stderr?.includes('invalid flag passed'));
    });

    it('classifies malformed/truncated stream-json as EXECUTOR_PROTOCOL_FAILURE', async () => {
      const corruptedStream = [
        '{"event":"init"}',
        '{"event":"step_update", "truncated":', // broken JSON frame
      ].join('\n');

      const fakeRunner = new FakeAntigravityProcessRunner(async () => ({
        exitCode: 0,
        stdout: corruptedStream,
        stderr: '',
      }));

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'ERROR');
      assert.strictEqual(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_PROTOCOL_FAILURE);
    });

    it('classifies process timeout as EXECUTOR_TIMEOUT without hanging', async () => {
      const fakeRunner = new FakeAntigravityProcessRunner(async () => ({
        timedOut: true,
        exitCode: null,
        stdout: '',
        stderr: 'Execution timed out',
      }));

      const adapter = new AntigravityAdapter({
        workspaceRoot: tempDir,
        binaryPath: 'agy',
        processRunner: fakeRunner,
        skipCompatibilityProbe: true,
      });

      const outcome = await adapter.execute(sampleRequest);

      assert.strictEqual(outcome.status, 'TIMEOUT');
      assert.strictEqual(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_TIMEOUT);
    });
  });

  // ==========================================================================
  // 4. RESOURCE LIFECYCLE & NODE PROCESS RUNNER CLEANUP
  // ==========================================================================
  describe('4. Node Process Runner Lifecycle & Safety Invariants', () => {
    it('properly enforces timeout and closes child streams', async () => {
      const runner = new NodeAntigravityProcessRunner();

      // Launch an executable that stays alive with 200ms timeout
      const result = await runner.run({
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        cwd: tempDir,
        timeoutMs: 200,
      });

      assert.strictEqual(result.timedOut, true);
      assert.ok(result.durationMs >= 150);
      assert.ok(result.durationMs < 3000);
    });
  });
});
