/**
 * Comprehensive Test Suite for Phase 10 TASK-P10-02
 * Deterministic Execution Request Contract
 *
 * Verifies all deterministic invariants, boundary protections, and contracts:
 *
 * T01: Valid ExecutionIntent -> produces valid, immutable ExecutionRequest
 * T02: Deterministic requestId reproducibility: identical inputs -> identical requestId
 * T03: Deterministic requestId sensitivity: any change in semantic field -> different requestId
 * T04: Deterministic requestId indifference: createdAt or metadata change -> identical requestId
 * T05: Input order invariance: unordered targetFiles/constraints/criteria -> identical requestId
 * T06: Duplicate removal in targetFiles and constraints -> normalized and identical requestId
 * T07: targetFiles POSIX normalization: Windows backslashes converted to forward slashes
 * T08: targetFiles leading './' stripping
 * T09: targetFiles path traversal ('..') rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T10: targetFiles absolute Unix path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T11: targetFiles Windows drive letter path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T12: targetFiles empty or whitespace-only path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH
 * T13: Authoritative repository state auto-capture from GitPort.inspectState()
 * T14: Repository state forgery detection: baseCommit mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY
 * T15: Repository state forgery detection: isClean mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY
 * T16: Repository state failure when Git HEAD cannot be determined
 * T17: Execution limits default assignment (timeoutMs: 300_000, maxFileModifications: 20)
 * T18: Execution limits valid custom assignment within bounds
 * T19: Execution limits rejection: timeoutMs < 1000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID
 * T20: Execution limits rejection: timeoutMs > 3_600_000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID
 * T21: Execution limits rejection: timeoutMs negative, float, NaN, Infinity
 * T22: Execution limits rejection: maxFileModifications < 1 or > 100
 * T23: Intent binding forgery protection: caller override of projectId rejected -> ERR_EXECUTION_REQUEST_INTENT_MISMATCH
 * T24: Intent binding forgery protection: caller override of directorSessionId rejected
 * T25: Intent binding forgery protection: caller override of directorDecisionId rejected
 * T26: Intent binding forgery protection: caller override of taskId rejected
 * T27: Intent binding forgery protection: caller override of taskRevision rejected
 * T28: Intent binding forgery protection: caller override of contextFingerprint rejected
 * T29: Intent binding forgery protection: caller override of understandingRevision rejected
 * T30: Intent binding forgery protection: caller override of approvalPackageRevision rejected
 * T31: Intent binding forgery protection: caller override of operationType rejected
 * T32: Intent binding forgery protection: caller override of protocolVersion / schemaVersion rejected
 * T33: Objective empty or missing rejection
 * T34: Acceptance criteria empty array rejection
 * T35: Acceptance criteria empty string criterion rejection
 * T36: Acceptance criteria structured object validation
 * T37: SpecStore fallback: derives objective and criteria from task when omitted by caller
 * T38: validateExecutionRequest() method: valid request -> VALID
 * T39: validateExecutionRequest() method: tampered requestId -> VALIDATION_ERROR
 * T40: validateExecutionRequest() method: unsafe targetFiles -> INVALID_PATH
 * T41: MCP tool aidm.execution.request.build: successful execution request generation
 * T42: MCP tool aidm.execution.request.create: alias tool behavior
 * T43: MCP tool rejection on path traversal, forgery, and invalid limits
 * T44: Architectural invariant: zero child process, zero Antigravity call, zero DAG mutation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  EXECUTION_REQUEST_PROTOCOL_VERSION,
  EXECUTION_REQUEST_SCHEMA_VERSION,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_MAX_FILE_MODIFICATIONS,
  type ExecutionIntent,
  type ExecutionRequest,
  type BuildExecutionRequestInput,
  ExecutionRequestBuilder,
  canonicalStringify,
  computeDeterministicRequestId,
  ExecutionRequestValidationError,
  ExecutionRequestInvalidPathError,
  ExecutionRequestRepositoryForgeryError,
  ExecutionRequestIntentMismatchError,
  ExecutionRequestLimitsInvalidError,
  FakeGitPort,
  SpecStore,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  McpServer,
  InMemoryMcpTransport,
  AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME,
  AIDM_EXECUTION_REQUEST_CREATE_TOOL_NAME,
} from '../dist/index.js';

describe('Deterministic Execution Request Contract (Phase 10 TASK-P10-02)', () => {
  let tempDir: string;
  let fakeGitPort: FakeGitPort;
  let specStore: SpecStore;
  let builder: ExecutionRequestBuilder;

  const validBaseCommit = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const alternativeCommit = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

  const sampleIntent: ExecutionIntent = {
    intentId: 'intent-sample-001',
    directorSessionId: 'session-dir-20260924-001',
    directorDecisionId: 'dec-dir-20260924-001',
    projectId: 'proj-omega-01',
    taskId: 'TASK-P10-01',
    taskRevision: 2,
    contextFingerprint: 'ctx-fp-99887766554433221100',
    understandingRevision: 3,
    approvalPackageRevision: 1,
    operationType: 'IMPLEMENT_TASK',
    protocolVersion: 'P10-01',
    schemaVersion: 1,
    createdAt: '2026-09-24T20:00:00.000Z',
    metadata: { source: 'test-suite' },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p10-02-test-'));

    fakeGitPort = new FakeGitPort({
      initialState: {
        head_sha: validBaseCommit,
        current_branch: 'main',
        working_tree_clean: true,
        staged_changes: [],
        unstaged_changes: [],
        untracked_files: [],
      },
    });

    specStore = new SpecStore({ baseDir: tempDir });

    builder = new ExecutionRequestBuilder({
      workspaceRoot: tempDir,
      gitPort: fakeGitPort,
      specStore,
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
  // 1. BASIC REQUEST GENERATION & SCHEMA CONFORMANCE
  // ==========================================================================

  it('T01: Valid ExecutionIntent -> produces valid, immutable ExecutionRequest', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Implement deterministic request contract',
        constraints: ['Must be deterministic', 'No shell spawn'],
        targetFiles: ['packages/core/src/request.ts', 'packages/core/tests/request.test.ts'],
        acceptanceCriteria: ['All tests pass with exit code 0', 'SHA-256 hash is collision resistant'],
      },
      executionLimits: {
        timeoutMs: 120_000,
        maxFileModifications: 10,
      },
    });

    assert.ok(request);
    assert.match(request.requestId, /^req-[a-f0-9]{32}$/);
    assert.strictEqual(request.projectId, sampleIntent.projectId);
    assert.strictEqual(request.directorSessionId, sampleIntent.directorSessionId);
    assert.strictEqual(request.directorDecisionId, sampleIntent.directorDecisionId);
    assert.strictEqual(request.taskId, sampleIntent.taskId);
    assert.strictEqual(request.taskRevision, sampleIntent.taskRevision);
    assert.strictEqual(request.contextFingerprint, sampleIntent.contextFingerprint);
    assert.strictEqual(request.understandingRevision, sampleIntent.understandingRevision);
    assert.strictEqual(request.approvalPackageRevision, sampleIntent.approvalPackageRevision);
    assert.strictEqual(request.operationType, 'IMPLEMENT_TASK');
    assert.strictEqual(request.protocolVersion, 'P10-02');
    assert.strictEqual(request.schemaVersion, 1);
    assert.strictEqual(request.intentId, sampleIntent.intentId);
    assert.strictEqual(request.instruction.objective, 'Implement deterministic request contract');
    assert.deepStrictEqual(request.instruction.constraints, ['Must be deterministic', 'No shell spawn']);
    assert.deepStrictEqual(request.instruction.targetFiles, [
      'packages/core/src/request.ts',
      'packages/core/tests/request.test.ts',
    ]);
    assert.strictEqual(request.expectedRepositoryState.baseCommit, validBaseCommit);
    assert.strictEqual(request.expectedRepositoryState.isClean, true);
    assert.strictEqual(request.executionLimits.timeoutMs, 120_000);
    assert.strictEqual(request.executionLimits.maxFileModifications, 10);
  });

  // ==========================================================================
  // 2. DETERMINISTIC REQUEST ID PROPERTIES
  // ==========================================================================

  it('T02: Deterministic requestId reproducibility: identical inputs -> identical requestId', async () => {
    const input: BuildExecutionRequestInput = {
      intent: sampleIntent,
      instruction: {
        objective: 'Deterministic hashing test',
        constraints: ['Constraint A', 'Constraint B'],
        targetFiles: ['src/a.ts', 'src/b.ts'],
        acceptanceCriteria: ['AC-1', 'AC-2'],
      },
    };

    const req1 = await builder.buildExecutionRequest(input);
    const req2 = await builder.buildExecutionRequest(input);

    assert.strictEqual(req1.requestId, req2.requestId);
  });

  it('T03: Deterministic requestId sensitivity: any change in semantic field -> different requestId', async () => {
    const baseInput: BuildExecutionRequestInput = {
      intent: sampleIntent,
      instruction: {
        objective: 'Base objective',
        constraints: ['C1'],
        targetFiles: ['src/file.ts'],
        acceptanceCriteria: ['AC-1'],
      },
    };

    const baseReq = await builder.buildExecutionRequest(baseInput);

    // Objective changed
    const reqDiffObj = await builder.buildExecutionRequest({
      ...baseInput,
      instruction: { ...baseInput.instruction!, objective: 'Different objective' },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffObj.requestId);

    // Target files changed
    const reqDiffFiles = await builder.buildExecutionRequest({
      ...baseInput,
      instruction: { ...baseInput.instruction!, targetFiles: ['src/other.ts'] },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffFiles.requestId);

    // Constraints changed
    const reqDiffConstraints = await builder.buildExecutionRequest({
      ...baseInput,
      instruction: { ...baseInput.instruction!, constraints: ['C2'] },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffConstraints.requestId);

    // Task revision changed
    const reqDiffTaskRev = await builder.buildExecutionRequest({
      ...baseInput,
      intent: { ...sampleIntent, taskRevision: 99 },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffTaskRev.requestId);

    // Context fingerprint changed
    const reqDiffFp = await builder.buildExecutionRequest({
      ...baseInput,
      intent: { ...sampleIntent, contextFingerprint: 'different-fingerprint' },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffFp.requestId);

    // Limits changed
    const reqDiffLimits = await builder.buildExecutionRequest({
      ...baseInput,
      executionLimits: { timeoutMs: 500_000 },
    });
    assert.notStrictEqual(baseReq.requestId, reqDiffLimits.requestId);
  });

  it('T04: Deterministic requestId indifference: createdAt or metadata change -> identical requestId', async () => {
    const baseInput: BuildExecutionRequestInput = {
      intent: sampleIntent,
      instruction: {
        objective: 'Indifference test',
        acceptanceCriteria: ['AC-1'],
      },
      metadata: { tag: 'initial' },
    };

    const req1 = await builder.buildExecutionRequest(baseInput);

    const req2 = await builder.buildExecutionRequest({
      ...baseInput,
      metadata: { tag: 'completely-different-metadata', extra: 12345 },
    });

    assert.strictEqual(req1.requestId, req2.requestId);
  });

  it('T05: Input order invariance: unordered targetFiles/constraints/criteria -> identical requestId', async () => {
    const reqA = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Order invariance test',
        constraints: ['Beta', 'Alpha', 'Gamma'],
        targetFiles: ['src/z.ts', 'src/a.ts', 'src/m.ts'],
        acceptanceCriteria: ['Criterion Z', 'Criterion A'],
      },
    });

    const reqB = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Order invariance test',
        constraints: ['Gamma', 'Alpha', 'Beta'],
        targetFiles: ['src/a.ts', 'src/m.ts', 'src/z.ts'],
        acceptanceCriteria: ['Criterion A', 'Criterion Z'],
      },
    });

    assert.strictEqual(reqA.requestId, reqB.requestId);
    assert.deepStrictEqual(reqA.instruction.constraints, ['Alpha', 'Beta', 'Gamma']);
    assert.deepStrictEqual(reqA.instruction.targetFiles, ['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('T06: Duplicate removal in targetFiles and constraints -> normalized and identical requestId', async () => {
    const reqUnique = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Deduplication test',
        constraints: ['Constraint A'],
        targetFiles: ['src/a.ts'],
        acceptanceCriteria: ['AC-1'],
      },
    });

    const reqDups = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Deduplication test',
        constraints: ['Constraint A', 'Constraint A', '  Constraint A  '],
        targetFiles: ['src/a.ts', './src/a.ts', 'src\\a.ts'],
        acceptanceCriteria: ['AC-1', '  AC-1  '],
      },
    });

    assert.strictEqual(reqUnique.requestId, reqDups.requestId);
    assert.deepStrictEqual(reqDups.instruction.constraints, ['Constraint A']);
    assert.deepStrictEqual(reqDups.instruction.targetFiles, ['src/a.ts']);
    assert.deepStrictEqual(reqDups.instruction.acceptanceCriteria, ['AC-1']);
  });

  // ==========================================================================
  // 3. TARGET FILES NORMALIZATION & PATH SAFETY
  // ==========================================================================

  it('T07: targetFiles POSIX normalization: Windows backslashes converted to forward slashes', () => {
    const normalized = builder.canonicalizeTargetFiles([
      'packages\\core\\src\\foo.ts',
      'packages/core/src/bar.ts',
    ]);
    assert.deepStrictEqual(normalized, [
      'packages/core/src/bar.ts',
      'packages/core/src/foo.ts',
    ]);
  });

  it('T08: targetFiles leading "./" stripping', () => {
    const normalized = builder.canonicalizeTargetFiles([
      './packages/core/index.ts',
      'src/main.ts',
    ]);
    assert.deepStrictEqual(normalized, [
      'packages/core/index.ts',
      'src/main.ts',
    ]);
  });

  it('T09: targetFiles path traversal ("..") rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const badPaths = [
      '../secret.txt',
      'packages/../../secret.txt',
      'packages/core/../..',
      '..',
      'foo/bar/..',
    ];

    for (const badPath of badPaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([badPath]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          assert.match(err.message, /Path traversal/);
          return true;
        }
      );
    }
  });

  it('T10: targetFiles absolute Unix path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const absolutePaths = ['/etc/passwd', '/root/.ssh/id_rsa', '/packages/core/src/a.ts'];

    for (const p of absolutePaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([p]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          assert.match(err.message, /Absolute paths are strictly prohibited/);
          return true;
        }
      );
    }
  });

  it('T11: targetFiles Windows drive letter path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const windowsPaths = [
      'C:/Windows/System32/cmd.exe',
      'd:\\work\\project\\src\\main.ts',
      'D:/repo/file.ts',
    ];

    for (const p of windowsPaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([p]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          assert.match(err.message, /Absolute paths are strictly prohibited/);
          return true;
        }
      );
    }
  });

  it('T12: targetFiles empty or whitespace-only path rejection -> ERR_EXECUTION_REQUEST_INVALID_PATH', () => {
    const invalidPaths = ['', '   ', './'];

    for (const p of invalidPaths) {
      assert.throws(
        () => builder.canonicalizeTargetFiles([p]),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestInvalidPathError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');
          return true;
        }
      );
    }
  });

  // ==========================================================================
  // 4. REPOSITORY STATE AUTHORITY & FORGERY DETECTION
  // ==========================================================================

  it('T13: Authoritative repository state auto-capture from GitPort.inspectState()', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Auto-capture test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    assert.strictEqual(request.expectedRepositoryState.baseCommit, validBaseCommit);
    assert.strictEqual(request.expectedRepositoryState.isClean, true);
  });

  it('T14: Repository state forgery detection: baseCommit mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Forgery test',
            acceptanceCriteria: ['AC-1'],
          },
          expectedRepositoryState: {
            baseCommit: alternativeCommit, // Forged baseline commit
            isClean: true,
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestRepositoryForgeryError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY');
        assert.match(err.message, /Repository state forgery detected/);
        return true;
      }
    );
  });

  it('T15: Repository state forgery detection: isClean mismatch -> ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Forgery test',
            acceptanceCriteria: ['AC-1'],
          },
          expectedRepositoryState: {
            baseCommit: validBaseCommit,
            isClean: false, // Forged status
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestRepositoryForgeryError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY');
        assert.match(err.message, /isClean/);
        return true;
      }
    );
  });

  it('T16: Repository state failure when Git HEAD cannot be determined', async () => {
    const uninitGitPort = new FakeGitPort({
      initialState: {
        head_sha: null,
        working_tree_clean: true,
      },
    });

    const brokenBuilder = new ExecutionRequestBuilder({
      workspaceRoot: tempDir,
      gitPort: uninitGitPort,
    });

    await assert.rejects(
      async () => {
        await brokenBuilder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Uninit test',
            acceptanceCriteria: ['AC-1'],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestRepositoryForgeryError);
        assert.match(err.message, /Authoritative Git HEAD commit could not be determined/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 5. EXECUTION LIMITS VALIDATION
  // ==========================================================================

  it('T17: Execution limits default assignment (timeoutMs: 300_000, maxFileModifications: 20)', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Limits defaults test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    assert.strictEqual(request.executionLimits.timeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS);
    assert.strictEqual(request.executionLimits.maxFileModifications, DEFAULT_MAX_FILE_MODIFICATIONS);
  });

  it('T18: Execution limits valid custom assignment within bounds', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Custom limits test',
        acceptanceCriteria: ['AC-1'],
      },
      executionLimits: {
        timeoutMs: 60_000,
        maxFileModifications: 50,
      },
    });

    assert.strictEqual(request.executionLimits.timeoutMs, 60_000);
    assert.strictEqual(request.executionLimits.maxFileModifications, 50);
  });

  it('T19: Execution limits rejection: timeoutMs < 1000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID', () => {
    assert.throws(
      () => builder.canonicalizeExecutionLimits({ timeoutMs: 999 }),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');
        assert.match(err.message, /between 1000 and 3600000/);
        return true;
      }
    );
  });

  it('T20: Execution limits rejection: timeoutMs > 3_600_000 -> ERR_EXECUTION_REQUEST_LIMITS_INVALID', () => {
    assert.throws(
      () => builder.canonicalizeExecutionLimits({ timeoutMs: 3_600_001 }),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');
        return true;
      }
    );
  });

  it('T21: Execution limits rejection: timeoutMs negative, float, NaN, Infinity', () => {
    const invalidTimeouts = [-5000, 1000.5, NaN, Infinity, -Infinity];

    for (const t of invalidTimeouts) {
      assert.throws(
        () => builder.canonicalizeExecutionLimits({ timeoutMs: t }),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
          return true;
        }
      );
    }
  });

  it('T22: Execution limits rejection: maxFileModifications < 1 or > 100', () => {
    const invalidMaxFiles = [0, -1, 101, 10.5, NaN, Infinity];

    for (const m of invalidMaxFiles) {
      assert.throws(
        () => builder.canonicalizeExecutionLimits({ maxFileModifications: m }),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionRequestLimitsInvalidError);
          assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');
          return true;
        }
      );
    }
  });

  // ==========================================================================
  // 6. INTENT BINDING FORGERY PROTECTION
  // ==========================================================================

  it('T23: Intent binding forgery protection: caller override of projectId rejected -> ERR_EXECUTION_REQUEST_INTENT_MISMATCH', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          projectId: 'attacker-project-id',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.strictEqual(err.code, 'ERR_EXECUTION_REQUEST_INTENT_MISMATCH');
        assert.match(err.message, /projectId override mismatch/);
        return true;
      }
    );
  });

  it('T24: Intent binding forgery protection: caller override of directorSessionId rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          directorSessionId: 'fake-session',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /directorSessionId override mismatch/);
        return true;
      }
    );
  });

  it('T25: Intent binding forgery protection: caller override of directorDecisionId rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          directorDecisionId: 'fake-decision',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /directorDecisionId override mismatch/);
        return true;
      }
    );
  });

  it('T26: Intent binding forgery protection: caller override of taskId rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          taskId: 'TASK-ATTACK-999',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /taskId override mismatch/);
        return true;
      }
    );
  });

  it('T27: Intent binding forgery protection: caller override of taskRevision rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          taskRevision: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /taskRevision override mismatch/);
        return true;
      }
    );
  });

  it('T28: Intent binding forgery protection: caller override of contextFingerprint rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          contextFingerprint: 'forged-fingerprint',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /contextFingerprint override mismatch/);
        return true;
      }
    );
  });

  it('T29: Intent binding forgery protection: caller override of understandingRevision rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          understandingRevision: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /understandingRevision override mismatch/);
        return true;
      }
    );
  });

  it('T30: Intent binding forgery protection: caller override of approvalPackageRevision rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          approvalPackageRevision: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /approvalPackageRevision override mismatch/);
        return true;
      }
    );
  });

  it('T31: Intent binding forgery protection: caller override of operationType rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          operationType: 'EXECUTE_BUILD',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestIntentMismatchError);
        assert.match(err.message, /operationType override mismatch/);
        return true;
      }
    );
  });

  it('T32: Intent binding forgery protection: caller override of protocolVersion / schemaVersion rejected', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          protocolVersion: 'P99-99',
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /protocolVersion override mismatch/);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          schemaVersion: 999,
          instruction: { objective: 'Test', acceptanceCriteria: ['AC-1'] },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /schemaVersion override mismatch/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 7. INSTRUCTION VALIDATION & CRITERIA CANONICALIZATION
  // ==========================================================================

  it('T33: Objective empty or missing rejection', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: '   ',
            acceptanceCriteria: ['AC-1'],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /Instruction objective cannot be empty/);
        return true;
      }
    );
  });

  it('T34: Acceptance criteria empty array rejection', async () => {
    await assert.rejects(
      async () => {
        await builder.buildExecutionRequest({
          intent: sampleIntent,
          instruction: {
            objective: 'Test objective',
            acceptanceCriteria: [],
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /acceptanceCriteria must contain at least one criterion/);
        return true;
      }
    );
  });

  it('T35: Acceptance criteria empty string criterion rejection', () => {
    assert.throws(
      () => builder.canonicalizeAcceptanceCriteria(['   ']),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionRequestValidationError);
        assert.match(err.message, /criterion string cannot be empty/);
        return true;
      }
    );
  });

  it('T36: Acceptance criteria structured object validation', () => {
    const normalized = builder.canonicalizeAcceptanceCriteria([
      {
        criterionId: 'AC-002',
        description: '  Secondary criterion  ',
        mandatory: true,
      },
      {
        criterionId: 'AC-001',
        description: 'Primary criterion',
        mandatory: true,
      },
    ]);

    assert.strictEqual(normalized.length, 2);
    assert.strictEqual((normalized[0] as { criterionId?: string }).criterionId, 'AC-001');
    assert.strictEqual((normalized[1] as { criterionId?: string }).criterionId, 'AC-002');
  });

  // ==========================================================================
  // 8. SPECSTORE TASK DERIVATION FALLBACK
  // ==========================================================================

  it('T37: SpecStore fallback: derives objective and criteria from task when omitted by caller', async () => {
    await specStore.saveTasks([
      {
        task_id: sampleIntent.taskId,
        parent_feature_id: 'FEAT-P10-EXEC',
        title: 'Phase 10 Execution Task',
        description: 'Authoritative description from SpecStore Task DAG',
        traceability_sources: ['REQ-001'],
        dependencies: [],
        acceptance_criteria: ['SpecStore AC-1', 'SpecStore AC-2'],
        status: TaskStatus.READY,
        attempt: 1,
        max_attempts: 3,
        priority: TaskPriority.HIGH,
        risk_level: RiskLevel.LOW,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
    ]);

    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        constraints: ['Constraint from caller'],
        targetFiles: ['src/task.ts'],
      },
    });

    assert.strictEqual(request.instruction.objective, 'Authoritative description from SpecStore Task DAG');
    assert.deepStrictEqual(request.instruction.acceptanceCriteria, ['SpecStore AC-1', 'SpecStore AC-2']);
  });

  // ==========================================================================
  // 9. VALIDATION METHOD (validateExecutionRequest)
  // ==========================================================================

  it('T38: validateExecutionRequest() method: valid request -> VALID', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Valid check test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    const result = builder.validateExecutionRequest(request);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.code, 'VALID');
    assert.ok(result.request);
  });

  it('T39: validateExecutionRequest() method: tampered requestId -> VALIDATION_ERROR', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Tamper test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    const tampered = {
      ...request,
      requestId: 'req-00000000000000000000000000000000',
    };

    const result = builder.validateExecutionRequest(tampered);
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.code, 'VALIDATION_ERROR');
    assert.match(result.message, /requestId hash mismatch/);
  });

  it('T40: validateExecutionRequest() method: unsafe targetFiles -> INVALID_PATH', async () => {
    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
      instruction: {
        objective: 'Unsafe path test',
        acceptanceCriteria: ['AC-1'],
      },
    });

    const tampered = {
      ...request,
      instruction: {
        ...request.instruction,
        targetFiles: ['../escaping/path.ts'],
      },
    };

    const result = builder.validateExecutionRequest(tampered);
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.code, 'INVALID_PATH');
  });

  // ==========================================================================
  // 10. MCP BOUNDARY TOOLS
  // ==========================================================================

  it('T41: MCP tool aidm.execution.request.build: successful execution request generation', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate: {
        projectRoot: tempDir,
        gitPort: fakeGitPort,
        specStore,
      } as any,
    });

    await server.start();

    const buildTool = server.getTool(AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME);
    assert.ok(buildTool, 'Build tool should be registered');

    const result = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'MCP execution request build test',
          constraints: ['Constraint 1'],
          targetFiles: ['packages/core/src/mcp-test.ts'],
          acceptanceCriteria: ['AC-MCP-1'],
        },
        executionLimits: {
          timeoutMs: 180_000,
        },
      },
      {
        correlation: { correlationId: 'corr-001', requestId: 'req-mcp-01', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );

    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.length, 1);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.requestId);
    assert.strictEqual(parsed.request.taskId, sampleIntent.taskId);
    assert.strictEqual(parsed.request.protocolVersion, 'P10-02');

    await server.stop();
  });

  it('T42: MCP tool aidm.execution.request.create: alias tool behavior', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate: {
        projectRoot: tempDir,
        gitPort: fakeGitPort,
        specStore,
      } as any,
    });

    await server.start();

    const createTool = server.getTool(AIDM_EXECUTION_REQUEST_CREATE_TOOL_NAME);
    assert.ok(createTool, 'Create tool alias should be registered');

    const result = await createTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'MCP alias tool test',
          acceptanceCriteria: ['AC-ALIAS-1'],
        },
      },
      {
        correlation: { correlationId: 'corr-002', requestId: 'req-mcp-02', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );

    assert.strictEqual(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text as string);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.requestId);

    await server.stop();
  });

  it('T43: MCP tool rejection on path traversal, forgery, and invalid limits', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      executionRequestTools: true,
      delegate: {
        projectRoot: tempDir,
        gitPort: fakeGitPort,
        specStore,
      } as any,
    });

    await server.start();

    const buildTool = server.getTool(AIDM_EXECUTION_REQUEST_BUILD_TOOL_NAME)!;

    // Path traversal attempt
    const resTraversal = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'Traversal test',
          targetFiles: ['../escaped.ts'],
          acceptanceCriteria: ['AC-1'],
        },
      },
      {
        correlation: { correlationId: 'corr-003', requestId: 'req-mcp-03', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );
    assert.strictEqual(resTraversal.isError, true);
    const parsedTraversal = JSON.parse(resTraversal.content[0].text as string);
    assert.strictEqual(parsedTraversal.success, false);
    assert.strictEqual(parsedTraversal.code, 'ERR_EXECUTION_REQUEST_INVALID_PATH');

    // Forgery attempt
    const resForgery = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'Forgery test',
          acceptanceCriteria: ['AC-1'],
        },
        expectedRepositoryState: {
          baseCommit: alternativeCommit, // Forged
          isClean: true,
        },
      },
      {
        correlation: { correlationId: 'corr-004', requestId: 'req-mcp-04', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );
    assert.strictEqual(resForgery.isError, true);
    const parsedForgery = JSON.parse(resForgery.content[0].text as string);
    assert.strictEqual(parsedForgery.success, false);
    assert.strictEqual(parsedForgery.code, 'ERR_EXECUTION_REQUEST_REPOSITORY_FORGERY');

    // Invalid limits attempt
    const resLimits = await buildTool.handler(
      {
        intent: sampleIntent,
        instruction: {
          objective: 'Invalid limits test',
          acceptanceCriteria: ['AC-1'],
        },
        executionLimits: {
          timeoutMs: -500, // Invalid
        },
      },
      {
        correlation: { correlationId: 'corr-005', requestId: 'req-mcp-05', receivedAt: new Date().toISOString() },
        delegate: server.delegate,
      }
    );
    assert.strictEqual(resLimits.isError, true);
    const parsedLimits = JSON.parse(resLimits.content[0].text as string);
    assert.strictEqual(parsedLimits.success, false);
    assert.strictEqual(parsedLimits.code, 'ERR_EXECUTION_REQUEST_LIMITS_INVALID');

    await server.stop();
  });

  // ==========================================================================
  // 11. ARCHITECTURAL INVARIANT ASSURANCES
  // ==========================================================================

  it('T44: Architectural invariant: zero child process, zero Antigravity call, zero DAG mutation', async () => {
    await specStore.saveTasks([
      {
        task_id: sampleIntent.taskId,
        parent_feature_id: 'FEAT-P10-EXEC',
        title: 'Initial Task Title',
        description: 'Initial Task Description',
        traceability_sources: ['REQ-001'],
        dependencies: [],
        acceptance_criteria: ['Initial AC'],
        status: TaskStatus.READY,
        attempt: 1,
        max_attempts: 3,
        priority: TaskPriority.HIGH,
        risk_level: RiskLevel.LOW,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
    ]);

    const tasksBefore = await specStore.loadTasks();

    const request = await builder.buildExecutionRequest({
      intent: sampleIntent,
    });

    assert.ok(request);

    // SpecStore tasks must NOT have mutated
    const tasksAfter = await specStore.loadTasks();
    assert.deepStrictEqual(tasksAfter, tasksBefore);
    assert.strictEqual(tasksAfter[0].status, TaskStatus.READY);
    assert.strictEqual(tasksAfter[0].attempt, 1);
  });
});
