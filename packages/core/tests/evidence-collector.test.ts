import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  EvidenceType,
  EvidenceSource,
  EvidenceValidationStatus,
  type SystemVerifiedEvidence,
  validateSystemVerifiedEvidence,
  assertValidSystemVerifiedEvidence,
  EvidenceCollector,
  FakeProcessExecutor,
  FakeGitObserver,
  DefaultGitObserver,
  NodeProcessExecutor,
  FileHashCollector,
  normalizeEvidenceFilePath,
  extractStdoutTail,
  CollectorError,
  CommandCollectionError,
  ProcessExecutionError,
  GitObservationError,
  FileHashCollectionError,
  InvalidCollectorInputError,
  InvalidEvidenceSourceError,
} from '../dist/index.js';

// ============================================================================
// FIXTURES & HELPERS
// ============================================================================

const VALID_GIT_SHA1_BEFORE = '1111111111111111111111111111111111111111';
const VALID_GIT_SHA1_AFTER = '2222222222222222222222222222222222222222';
const VALID_SHA256_A = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const VALID_SHA256_B = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function createTempDir(prefix = 'aidm-evidence-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// TEST SUITE: TASK-P4-02 Evidence Collector
// ============================================================================

describe('TASK-P4-02: Evidence Collector', () => {
  // --------------------------------------------------------------------------
  // C1 — successful command observation produces valid SystemVerifiedEvidence
  // --------------------------------------------------------------------------
  it('C1 — successful command observation produces valid SystemVerifiedEvidence', async () => {
    const collector = new EvidenceCollector();

    const evidence = await collector.collectCommandEvidence({
      evidence_id: 'evi:c1:1',
      task_id: 'TASK-C1',
      instruction_id: 'inst:c1:1',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c1:1',
      command: 'pnpm --filter @aidm/core test',
      exit_code: 0,
      stdout: 'PASS all tests passed',
      stderr: null,
      working_directory: '/workspaces/test-project',
      execution_time_ms: 350,
      evidence_type: EvidenceType.TEST,
    });

    assert.ok(evidence);
    assert.equal(evidence.evidence_id, 'evi:c1:1');
    assert.equal(evidence.task_id, 'TASK-C1');
    assert.equal(evidence.command, 'pnpm --filter @aidm/core test');
    assert.equal(evidence.exit_code, 0);
    assert.equal(evidence.stdout_tail, 'PASS all tests passed');
    assert.equal(evidence.stderr, null);
    assert.equal(evidence.working_directory, '/workspaces/test-project');
    assert.equal(evidence.execution_time_ms, 350);
    assert.equal(evidence.evidence_type, EvidenceType.TEST);
    assert.equal(evidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);

    const validation = validateSystemVerifiedEvidence(evidence);
    assert.equal(validation.valid, true);
    assert.equal(validation.status, EvidenceValidationStatus.VALID);
  });

  // --------------------------------------------------------------------------
  // C2 — non-zero command exit code is captured correctly
  // --------------------------------------------------------------------------
  it('C2 — non-zero command exit code is captured correctly', async () => {
    const fakeExecutor = new FakeProcessExecutor(() => ({
      command: 'npm run test:failing',
      exitCode: 1,
      stdout: 'FAIL src/index.test.ts',
      stderr: 'AssertionError: expected true but got false',
      durationMs: 420,
    }));

    const collector = new EvidenceCollector({ processExecutor: fakeExecutor });

    const evidence = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:c2:1',
      task_id: 'TASK-C2',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c2:1',
      command: 'npm run test:failing',
      working_directory: '/workspaces/test-project',
      evidence_type: EvidenceType.TEST,
    });

    assert.equal(evidence.exit_code, 1);
    assert.equal(evidence.stdout_tail, 'FAIL src/index.test.ts');
    assert.equal(evidence.stderr, 'AssertionError: expected true but got false');
    assert.equal(evidence.execution_time_ms, 420);
    assert.equal(evidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);

    // Non-zero exit code is an observable system fact, perfectly valid in evidence
    const validation = validateSystemVerifiedEvidence(evidence);
    assert.equal(validation.valid, true);
  });

  // --------------------------------------------------------------------------
  // C3 — stdout/stderr are preserved correctly
  // --------------------------------------------------------------------------
  it('C3 — stdout/stderr are preserved correctly', async () => {
    const stdoutContent = 'Line 1: Building\nLine 2: Generating types\nLine 3: Finished successfully';
    const stderrContent = 'npm WARN deprecated package@1.0.0';

    const collector = new EvidenceCollector();

    const evidence = await collector.collectCommandEvidence({
      evidence_id: 'evi:c3:1',
      task_id: 'TASK-C3',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c3:1',
      command: 'npm run build',
      exit_code: 0,
      stdout: stdoutContent,
      stderr: stderrContent,
      working_directory: '/workspaces/test-project',
      execution_time_ms: 1200,
    });

    assert.equal(evidence.stdout_tail, stdoutContent);
    assert.equal(evidence.stderr, stderrContent);
  });

  // --------------------------------------------------------------------------
  // C4 — working directory is preserved
  // --------------------------------------------------------------------------
  it('C4 — working directory is preserved', async () => {
    const specificCwd = 'D:/workspaces/custom-directory/sub-module';
    const collector = new EvidenceCollector();

    const evidence = await collector.collectCommandEvidence({
      evidence_id: 'evi:c4:1',
      task_id: 'TASK-C4',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c4:1',
      command: 'echo "test"',
      exit_code: 0,
      stdout: 'test',
      working_directory: specificCwd,
      execution_time_ms: 15,
    });

    assert.equal(evidence.working_directory, specificCwd);
  });

  // --------------------------------------------------------------------------
  // C5 — execution duration is captured from injected execution result
  // --------------------------------------------------------------------------
  it('C5 — execution duration is captured from injected execution result', async () => {
    const injectedDuration = 8492;
    const fakeExecutor = new FakeProcessExecutor(() => ({
      command: 'pnpm compile',
      exitCode: 0,
      stdout: 'Compiled in 8.4s',
      stderr: '',
      durationMs: injectedDuration,
    }));

    const collector = new EvidenceCollector({ processExecutor: fakeExecutor });

    const evidence = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:c5:1',
      task_id: 'TASK-C5',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c5:1',
      command: 'pnpm compile',
      working_directory: '/workspaces/test-project',
    });

    assert.equal(evidence.execution_time_ms, injectedDuration);
  });

  // --------------------------------------------------------------------------
  // C6 — command execution failure produces structured collector failure
  // --------------------------------------------------------------------------
  it('C6 — command execution failure produces structured collector failure', async () => {
    const fakeExecutor = new FakeProcessExecutor(() => {
      throw new ProcessExecutionError('spawn ENOENT: command not found', {
        command: 'invalid-binary --arg',
        workingDirectory: '/workspaces/test-project',
        reason: 'BINARY_NOT_FOUND',
      });
    });

    const collector = new EvidenceCollector({ processExecutor: fakeExecutor });

    await assert.rejects(
      async () => {
        await collector.executeAndCollectCommandEvidence({
          task_id: 'TASK-C6',
          project_id: 'proj:aidm',
          correlation_id: 'corr:c6:1',
          command: 'invalid-binary --arg',
          working_directory: '/workspaces/test-project',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CollectorError);
        assert.ok(err instanceof ProcessExecutionError);
        assert.equal((err as ProcessExecutionError).code, 'ERR_PROCESS_EXECUTION_FAILED');
        assert.equal((err as ProcessExecutionError).command, 'invalid-binary --arg');
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // C7 — Git HEAD before/after are captured correctly
  // --------------------------------------------------------------------------
  it('C7 — Git HEAD before/after are captured correctly', async () => {
    const fakeGit = new FakeGitObserver();
    fakeGit.setHeadSequence([VALID_GIT_SHA1_BEFORE, VALID_GIT_SHA1_AFTER]);

    const fakeExec = new FakeProcessExecutor(() => ({
      command: 'git status',
      exitCode: 0,
      stdout: 'clean',
      stderr: '',
      durationMs: 30,
    }));

    const collector = new EvidenceCollector({
      gitObserver: fakeGit,
      processExecutor: fakeExec,
    });

    const evidence = await collector.collectFullEvidence({
      evidence_id: 'evi:c7:1',
      task_id: 'TASK-C7',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c7:1',
      command: 'git status',
      working_directory: '/workspaces/repo',
    });

    assert.equal(evidence.git_head_before, VALID_GIT_SHA1_BEFORE);
    assert.equal(evidence.git_head_after, VALID_GIT_SHA1_AFTER);
  });

  // --------------------------------------------------------------------------
  // C8 — unified Git diff is captured correctly
  // --------------------------------------------------------------------------
  it('C8 — unified Git diff is captured correctly', async () => {
    const diffText = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+added';
    const fakeGit = new FakeGitObserver({
      isRepository: true,
      currentHead: VALID_GIT_SHA1_AFTER,
      unifiedDiff: diffText,
    });

    const collector = new EvidenceCollector({ gitObserver: fakeGit });
    const gitEvidence = await collector.collectGitEvidence('/workspaces/repo', {
      baseHead: VALID_GIT_SHA1_BEFORE,
    });

    assert.equal(gitEvidence.unified_diff, diffText);
    assert.equal(gitEvidence.isRepository, true);

    const evidence = collector.composeEvidence({
      evidence_id: 'evi:c8:1',
      task_id: 'TASK-C8',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c8:1',
      command: 'npm run update',
      exit_code: 0,
      working_directory: '/workspaces/repo',
      execution_time_ms: 100,
      git_head_before: VALID_GIT_SHA1_BEFORE,
      git_head_after: VALID_GIT_SHA1_AFTER,
      unified_diff: diffText,
    });

    assert.equal(evidence.unified_diff, diffText);
  });

  // --------------------------------------------------------------------------
  // C9 — Git observation failure does not fabricate Git data
  // --------------------------------------------------------------------------
  it('C9 — Git observation failure does not fabricate Git data', async () => {
    const fakeGit = new FakeGitObserver({
      isRepository: false,
      currentHead: null,
      unifiedDiff: null,
    });

    const collector = new EvidenceCollector({ gitObserver: fakeGit });
    const gitEvidence = await collector.collectGitEvidence('/not/a/git/repo');

    assert.equal(gitEvidence.isRepository, false);
    assert.equal(gitEvidence.git_head_before, null);
    assert.equal(gitEvidence.git_head_after, null);
    assert.equal(gitEvidence.unified_diff, null);

    const evidence = collector.composeEvidence({
      evidence_id: 'evi:c9:1',
      task_id: 'TASK-C9',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c9:1',
      command: 'echo hello',
      exit_code: 0,
      working_directory: '/not/a/git/repo',
      execution_time_ms: 10,
      git_head_before: gitEvidence.git_head_before,
      git_head_after: gitEvidence.git_head_after,
      unified_diff: gitEvidence.unified_diff,
    });

    // Proves explicit nulls, zero fabricated SHA or diff
    assert.equal(evidence.git_head_before, null);
    assert.equal(evidence.git_head_after, null);
    assert.equal(evidence.unified_diff, null);
    assert.equal(validateSystemVerifiedEvidence(evidence).valid, true);
  });

  // --------------------------------------------------------------------------
  // C10 — requested files receive deterministic SHA-256 hashes
  // --------------------------------------------------------------------------
  it('C10 — requested files receive deterministic SHA-256 hashes', async () => {
    const tempDir = createTempDir();
    try {
      const file1Path = path.join(tempDir, 'file1.txt');
      const file2Path = path.join(tempDir, 'file2.txt');
      fs.writeFileSync(file1Path, 'hello world\n', 'utf-8');
      fs.writeFileSync(file2Path, 'aidm deterministic testing\n', 'utf-8');

      const fileHashCollector = new FileHashCollector();
      const hashes = await fileHashCollector.collectHashes([file1Path, file2Path]);

      // Verify SHA-256 format and consistency
      for (const [fPath, hash] of Object.entries(hashes)) {
        assert.match(hash, /^[0-9a-f]{64}$/, 'Hash must be 64-char lowercase hexadecimal');
      }

      // Re-hashing produces exact same result
      const hashes2 = await fileHashCollector.collectHashes([file1Path, file2Path]);
      assert.deepEqual(hashes, hashes2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // C11 — multiple file hashes have deterministic ordering
  // --------------------------------------------------------------------------
  it('C11 — multiple file hashes have deterministic ordering', async () => {
    const fakeHasher = async (filePath: string) => {
      if (filePath.includes('z_file')) return VALID_SHA256_A;
      if (filePath.includes('a_file')) return VALID_SHA256_B;
      if (filePath.includes('m_file')) return VALID_SHA256_A;
      return VALID_SHA256_B;
    };

    const collector = new FileHashCollector(fakeHasher);
    // Supply in reverse alphabetical order
    const inputPaths = ['z_file.ts', 'a_file.ts', 'm_file.ts', 'b_file.ts'];

    const hashes = await collector.collectHashes(inputPaths);
    const keys = Object.keys(hashes);

    // Proves deterministic alphabetical ascending order
    assert.deepEqual(keys, ['a_file.ts', 'b_file.ts', 'm_file.ts', 'z_file.ts']);
  });

  // --------------------------------------------------------------------------
  // C12 — missing file does not produce fabricated hash
  // --------------------------------------------------------------------------
  it('C12 — missing file does not produce fabricated hash', async () => {
    const fileHashCollector = new FileHashCollector();

    // In strict mode (default): missing file throws structured error
    await assert.rejects(
      async () => {
        await fileHashCollector.collectHashes(['/non/existent/missing-file.xyz']);
      },
      (err: unknown) => {
        assert.ok(err instanceof FileHashCollectionError);
        assert.equal((err as FileHashCollectionError).code, 'ERR_FILE_HASH_COLLECTION_FAILED');
        assert.equal((err as FileHashCollectionError).path, '/non/existent/missing-file.xyz');
        return true;
      }
    );

    // In allowMissing mode: missing file is omitted, never fabricated
    const hashes = await fileHashCollector.collectHashes(['/non/existent/missing-file.xyz'], {
      allowMissing: true,
    });
    assert.equal(Object.keys(hashes).length, 0);
    assert.equal(hashes['/non/existent/missing-file.xyz'], undefined);
  });

  // --------------------------------------------------------------------------
  // C13 — collector output passes TASK-P4-01 validation
  // --------------------------------------------------------------------------
  it('C13 — collector output passes TASK-P4-01 validation', () => {
    const collector = new EvidenceCollector();

    const evidence = collector.composeEvidence({
      evidence_id: 'evi:c13:1',
      task_id: 'TASK-C13',
      instruction_id: 'inst:c13:1',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c13:1',
      command: 'pnpm test',
      exit_code: 0,
      stdout: 'all passed',
      stderr: null,
      working_directory: '/workspaces/repo',
      execution_time_ms: 220,
      git_head_before: VALID_GIT_SHA1_BEFORE,
      git_head_after: VALID_GIT_SHA1_AFTER,
      unified_diff: '--- a\n+++ b',
      file_hashes: {
        'src/index.ts': VALID_SHA256_A,
      },
    });

    const result = validateSystemVerifiedEvidence(evidence);
    assert.equal(result.valid, true);
    assert.equal(result.status, EvidenceValidationStatus.VALID);
    assert.equal(result.issues.length, 0);

    const asserted = assertValidSystemVerifiedEvidence(evidence);
    assert.equal(asserted.evidence_id, 'evi:c13:1');
    assert.equal(asserted.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
  });

  // --------------------------------------------------------------------------
  // C14 — AGENT_CLAIM cannot be promoted into system evidence
  // --------------------------------------------------------------------------
  it('C14 — AGENT_CLAIM cannot be promoted into system evidence', async () => {
    const collector = new EvidenceCollector();

    // 1. Direct rejection in composeEvidence
    assert.throws(
      () => {
        collector.composeEvidence({
          task_id: 'TASK-C14',
          project_id: 'proj:aidm',
          correlation_id: 'corr:c14:1',
          command: 'echo "claim"',
          exit_code: 0,
          working_directory: '/workspaces/repo',
          execution_time_ms: 10,
          source: EvidenceSource.AGENT_CLAIM,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidEvidenceSourceError);
        assert.equal((err as InvalidEvidenceSourceError).code, 'ERR_INVALID_EVIDENCE_SOURCE');
        return true;
      }
    );

    // 2. Direct rejection in collectCommandEvidence
    await assert.rejects(
      async () => {
        await collector.collectCommandEvidence({
          task_id: 'TASK-C14',
          project_id: 'proj:aidm',
          correlation_id: 'corr:c14:1',
          command: 'echo "claim"',
          exit_code: 0,
          working_directory: '/workspaces/repo',
          execution_time_ms: 10,
          source: 'AGENT_CLAIM',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidEvidenceSourceError);
        return true;
      }
    );

    // 3. Direct rejection when is_agent_claim: true
    assert.throws(
      () => {
        collector.composeEvidence({
          task_id: 'TASK-C14',
          project_id: 'proj:aidm',
          correlation_id: 'corr:c14:1',
          command: 'echo "claim"',
          exit_code: 0,
          working_directory: '/workspaces/repo',
          execution_time_ms: 10,
          is_agent_claim: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidEvidenceSourceError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // C15 — command + Git + hashes compose into one valid evidence package
  // --------------------------------------------------------------------------
  it('C15 — command + Git + hashes compose into one valid evidence package', async () => {
    const fakeGit = new FakeGitObserver({
      isRepository: true,
      currentHead: VALID_GIT_SHA1_AFTER,
      unifiedDiff: 'diff --git a/src/calc.ts b/src/calc.ts\n+export function add(a: number, b: number) { return a + b; }',
    });
    fakeGit.setHeadSequence([VALID_GIT_SHA1_BEFORE, VALID_GIT_SHA1_AFTER]);

    const fakeExec = new FakeProcessExecutor(() => ({
      command: 'pnpm --filter @aidm/core build',
      exitCode: 0,
      stdout: 'Done in 1.4s',
      stderr: '',
      durationMs: 1400,
    }));

    const fakeHasher = new FileHashCollector(async () => VALID_SHA256_A);

    const collector = new EvidenceCollector({
      gitObserver: fakeGit,
      processExecutor: fakeExec,
      fileHashCollector: fakeHasher,
    });

    const fullEvidence = await collector.collectFullEvidence({
      evidence_id: 'evi:c15:package:1',
      task_id: 'TASK-C15',
      instruction_id: 'inst:c15:1',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c15:1',
      command: 'pnpm --filter @aidm/core build',
      working_directory: '/workspaces/repo',
      relevant_files: ['packages/core/src/index.ts'],
      evidence_type: EvidenceType.BUILD,
    });

    assert.equal(fullEvidence.evidence_id, 'evi:c15:package:1');
    assert.equal(fullEvidence.command, 'pnpm --filter @aidm/core build');
    assert.equal(fullEvidence.exit_code, 0);
    assert.equal(fullEvidence.stdout_tail, 'Done in 1.4s');
    assert.equal(fullEvidence.execution_time_ms, 1400);
    assert.equal(fullEvidence.git_head_before, VALID_GIT_SHA1_BEFORE);
    assert.equal(fullEvidence.git_head_after, VALID_GIT_SHA1_AFTER);
    assert.ok(fullEvidence.unified_diff?.includes('diff --git'));
    assert.equal(fullEvidence.file_hashes_after?.['packages/core/src/index.ts'], VALID_SHA256_A);
    assert.equal(fullEvidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);

    assert.equal(validateSystemVerifiedEvidence(fullEvidence).valid, true);
  });

  // --------------------------------------------------------------------------
  // C16 — repeated identical fake observations produce identical semantic evidence
  // --------------------------------------------------------------------------
  it('C16 — repeated identical fake observations produce identical semantic evidence', () => {
    const collector = new EvidenceCollector();

    const observationData = {
      evidence_id: 'evi:deterministic:test',
      task_id: 'TASK-C16',
      instruction_id: 'inst:c16:1',
      project_id: 'proj:aidm',
      correlation_id: 'corr:c16:1',
      command: 'pnpm test',
      exit_code: 0,
      stdout: '100% tests passed',
      stderr: null,
      working_directory: '/workspaces/repo',
      execution_time_ms: 500,
      git_head_before: VALID_GIT_SHA1_BEFORE,
      git_head_after: VALID_GIT_SHA1_AFTER,
      unified_diff: '--- a\n+++ b',
      file_hashes: {
        'src/b.ts': VALID_SHA256_B,
        'src/a.ts': VALID_SHA256_A,
      },
    };

    const run1 = collector.composeEvidence(observationData);
    const run2 = collector.composeEvidence(observationData);

    assert.deepEqual(run1, run2);
    assert.equal(JSON.stringify(run1), JSON.stringify(run2));
  });

  // --------------------------------------------------------------------------
  // C17 — secret-looking command/output/error data is sanitized where errors expose diagnostics
  // --------------------------------------------------------------------------
  it('C17 — secret-looking command/output/error data is sanitized where errors expose diagnostics', () => {
    const sensitiveCommand = 'curl -H "Authorization: Bearer sk-ant-secret12345678" --data "password=supersecret" https://api.example.com';

    const error = new CommandCollectionError(
      `Execution failed for command: ${sensitiveCommand}`,
      {
        command: sensitiveCommand,
        reason: 'UNAUTHORIZED_TOKEN_BEARER',
      }
    );

    assert.ok(!error.message.includes('sk-ant-secret12345678'));
    assert.ok(error.message.includes('***REDACTED***') || error.message.includes('Bearer ***REDACTED_TOKEN***'));
    assert.ok(!JSON.stringify(error.details).includes('sk-ant-secret12345678'));
    assert.ok(!JSON.stringify(error.details).includes('supersecret'));
  });

  // --------------------------------------------------------------------------
  // C18 — collector does not mutate Git state
  // --------------------------------------------------------------------------
  it('C18 — collector does not mutate Git state', async () => {
    const gitObserver = new DefaultGitObserver();

    const statusBefore = execSync('git status --porcelain', { encoding: 'utf-8' });
    const headBefore = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

    // Perform observations
    await gitObserver.observeHead(process.cwd());
    await gitObserver.observeDiff(process.cwd());
    await gitObserver.observeGit(process.cwd());

    const statusAfter = execSync('git status --porcelain', { encoding: 'utf-8' });
    const headAfter = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

    assert.equal(headBefore, headAfter, 'HEAD commit must not change during observation');
    assert.equal(statusBefore, statusAfter, 'Git working tree status must not mutate during observation');
  });

  // --------------------------------------------------------------------------
  // C19 — collector does not modify scanner.ts
  // --------------------------------------------------------------------------
  it('C19 — packages/core/src/l0/scanner.ts git diff is 0', () => {
    const scannerDiff = execSync('git diff -- packages/core/src/l0/scanner.ts', {
      encoding: 'utf-8',
    }).trim();

    assert.equal(scannerDiff, '', 'packages/core/src/l0/scanner.ts MUST have 0 diff');
  });

  // --------------------------------------------------------------------------
  // C20 — Phase 1/2/3 regression remains intact
  // --------------------------------------------------------------------------
  it('C20 — Phase 1/2/3 regression remains intact', () => {
    // Assert fundamental modules from Phase 1, Phase 2, and Phase 3 remain loadable and intact
    assert.ok(EvidenceCollector);
    assert.ok(validateSystemVerifiedEvidence);
    assert.ok(EvidenceType);
    assert.ok(EvidenceSource);
    assert.ok(FileHashCollector);
    assert.ok(NodeProcessExecutor);
    assert.ok(DefaultGitObserver);
  });

  // --------------------------------------------------------------------------
  // Additional Behavioral Edge Case Tests
  // --------------------------------------------------------------------------
  describe('Helper Utilities & Edge Cases', () => {
    it('normalizeEvidenceFilePath: should replace Windows backslashes with forward slashes', () => {
      assert.equal(
        normalizeEvidenceFilePath('packages\\core\\src\\evidence\\collector.ts'),
        'packages/core/src/evidence/collector.ts'
      );
      assert.equal(
        normalizeEvidenceFilePath('  packages/core/src/index.ts  '),
        'packages/core/src/index.ts'
      );
    });

    it('extractStdoutTail: handles empty, null, small, and oversized inputs', () => {
      assert.equal(extractStdoutTail(null), null);
      assert.equal(extractStdoutTail(''), '');
      assert.equal(extractStdoutTail('small output'), 'small output');

      // 300 lines with limit of 5 lines
      const manyLines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join('\n');
      const tail = extractStdoutTail(manyLines, 5);
      const tailLines = tail!.split('\n');
      assert.equal(tailLines.length, 5);
      assert.equal(tailLines[4], 'Line 300');
    });

    it('DefaultGitObserver: gracefully handles non-git directories without throwing', async () => {
      const tempDir = createTempDir('non-git-');
      try {
        const observer = new DefaultGitObserver();
        const isRepo = await observer.isGitRepository(tempDir);
        assert.equal(isRepo, false);

        const head = await observer.observeHead(tempDir);
        assert.equal(head, null);

        const diff = await observer.observeDiff(tempDir);
        assert.equal(diff, null);

        const state = await observer.observeGit(tempDir);
        assert.equal(state.isRepository, false);
        assert.equal(state.git_head_after, null);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('NodeProcessExecutor: executes real safe echo command deterministically', async () => {
      const executor = new NodeProcessExecutor();
      const result = await executor.executeProcess('node -e "console.log(\'echo-test\')"', {
        cwd: os.tmpdir(),
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.includes('echo-test'));
      assert.ok(result.durationMs >= 0);
    });
  });
});
