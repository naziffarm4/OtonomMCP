import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  EvidenceType,
  EvidenceSource,
  EvidenceValidationStatus,
  type SystemVerifiedEvidence,
  type SystemVerifiedEvidenceInput,
  type AgentClaim,
  validateSystemVerifiedEvidence,
  assertValidSystemVerifiedEvidence,
  createAgentClaim,
  isValidSha256,
  isValidGitReference,
  isValidExitCode,
  isValidExecutionTimeMs,
  AidmError,
  EvidenceError,
  InvalidEvidenceError,
  MissingEvidenceFieldError,
  MalformedFileHashError,
  InvalidExecutionMetadataError,
  InvalidEvidenceSourceError,
  InvalidEvidenceTypeError,
  InvalidGitReferenceError,
  InvalidCommandError,
  InvalidExitCodeError,
} from '../dist/index.js';

// ============================================================================
// FIXTURES
// ============================================================================

const VALID_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const VALID_SHA256_UPPER = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';
const VALID_GIT_SHA1 = 'd147c935156ccfa3fbb94744532bab22970cd3bc';
const VALID_GIT_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function createValidEvidenceInput(overrides?: Partial<SystemVerifiedEvidenceInput>): SystemVerifiedEvidenceInput {
  return {
    evidence_id: 'evi:task-p4-01:build:1',
    task_id: 'TASK-P4-01',
    instruction_id: 'inst:task-p4-01:1',
    project_id: 'proj:aidm-core',
    correlation_id: 'corr:proj:aidm-core:TASK-P4-01:1',
    command: 'pnpm --filter @aidm/core build',
    exit_code: 0,
    stdout_tail: 'tsc -b\nDone in 1.2s',
    stderr: null,
    working_directory: '/workspaces/OtonomMCP',
    execution_time_ms: 1250,
    git_head_before: VALID_GIT_SHA1,
    git_head_after: VALID_GIT_SHA1,
    unified_diff: null,
    file_hashes_after: {
      'packages/core/src/index.ts': VALID_SHA256,
    },
    evidence_type: EvidenceType.BUILD,
    executor_identity: {
      provider: 'shell',
      name: 'posix-exec',
      version: '1.0.0',
    },
    captured_at: '2026-09-22T22:00:00.000Z',
    metadata: {
      runner: 'github-actions',
    },
    ...overrides,
  };
}

// ============================================================================
// TEST SUITE: TASK-P4-01 Evidence Model & Verification Engine
// ============================================================================

describe('TASK-P4-01: Evidence Model & Verification Engine', () => {
  // --------------------------------------------------------------------------
  // E1 — valid system evidence accepted
  // --------------------------------------------------------------------------
  it('E1 — valid system evidence accepted', () => {
    const input = createValidEvidenceInput();
    const result = validateSystemVerifiedEvidence(input);

    assert.equal(result.valid, true);
    assert.equal(result.status, EvidenceValidationStatus.VALID);
    assert.equal(result.issues.length, 0);
    assert.ok(result.evidence);

    const verified = assertValidSystemVerifiedEvidence(input);
    assert.equal(verified.evidence_id, 'evi:task-p4-01:build:1');
    assert.equal(verified.task_id, 'TASK-P4-01');
    assert.equal(verified.instruction_id, 'inst:task-p4-01:1');
    assert.equal(verified.project_id, 'proj:aidm-core');
    assert.equal(verified.correlation_id, 'corr:proj:aidm-core:TASK-P4-01:1');
    assert.equal(verified.command, 'pnpm --filter @aidm/core build');
    assert.equal(verified.exit_code, 0);
    assert.equal(verified.stdout_tail, 'tsc -b\nDone in 1.2s');
    assert.equal(verified.stderr, null);
    assert.equal(verified.working_directory, '/workspaces/OtonomMCP');
    assert.equal(verified.execution_time_ms, 1250);
    assert.equal(verified.git_head_before, VALID_GIT_SHA1);
    assert.equal(verified.git_head_after, VALID_GIT_SHA1);
    assert.equal(verified.unified_diff, null);
    assert.deepEqual(verified.file_hashes_after, {
      'packages/core/src/index.ts': VALID_SHA256,
    });
    assert.equal(verified.evidence_type, EvidenceType.BUILD);
    assert.equal(verified.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
    assert.ok(Object.isFrozen(verified));
    assert.ok(Object.isFrozen(verified.file_hashes_after));
  });

  // --------------------------------------------------------------------------
  // E2 — missing evidence_id rejected
  // --------------------------------------------------------------------------
  it('E2 — missing evidence_id rejected', () => {
    // Undefined
    const inputUndefined = createValidEvidenceInput({ evidence_id: undefined });
    const resUndefined = validateSystemVerifiedEvidence(inputUndefined);
    assert.equal(resUndefined.valid, false);
    assert.equal(resUndefined.status, EvidenceValidationStatus.INVALID);
    assert.ok(resUndefined.issues.some((i) => i.code === 'ERR_MISSING_EVIDENCE_FIELD' && i.field === 'evidence_id'));
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputUndefined),
      (err: unknown) => err instanceof MissingEvidenceFieldError && err.code === 'ERR_MISSING_EVIDENCE_FIELD'
    );

    // Empty string
    const inputEmpty = createValidEvidenceInput({ evidence_id: '   ' });
    const resEmpty = validateSystemVerifiedEvidence(inputEmpty);
    assert.equal(resEmpty.valid, false);
    assert.ok(resEmpty.issues.some((i) => i.code === 'ERR_MISSING_EVIDENCE_FIELD' && i.field === 'evidence_id'));
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputEmpty),
      MissingEvidenceFieldError
    );
  });

  // --------------------------------------------------------------------------
  // E3 — missing task/project/correlation identity rejected
  // --------------------------------------------------------------------------
  it('E3 — missing task/project/correlation identity rejected', () => {
    // Missing task_id
    const inputNoTask = createValidEvidenceInput({ task_id: undefined });
    assert.equal(validateSystemVerifiedEvidence(inputNoTask).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputNoTask),
      (err: unknown) => err instanceof MissingEvidenceFieldError && err.field === 'task_id'
    );

    // Missing project_id
    const inputNoProject = createValidEvidenceInput({ project_id: undefined });
    assert.equal(validateSystemVerifiedEvidence(inputNoProject).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputNoProject),
      (err: unknown) => err instanceof MissingEvidenceFieldError && err.field === 'project_id'
    );

    // Missing correlation_id
    const inputNoCorrelation = createValidEvidenceInput({ correlation_id: undefined });
    assert.equal(validateSystemVerifiedEvidence(inputNoCorrelation).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputNoCorrelation),
      (err: unknown) => err instanceof MissingEvidenceFieldError && err.field === 'correlation_id'
    );
  });

  // --------------------------------------------------------------------------
  // E4 — empty command rejected
  // --------------------------------------------------------------------------
  it('E4 — empty command rejected', () => {
    // Missing command
    const inputMissing = createValidEvidenceInput({ command: undefined });
    assert.equal(validateSystemVerifiedEvidence(inputMissing).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputMissing),
      MissingEvidenceFieldError
    );

    // Empty string command
    const inputEmpty = createValidEvidenceInput({ command: '' });
    const resEmpty = validateSystemVerifiedEvidence(inputEmpty);
    assert.equal(resEmpty.valid, false);
    assert.ok(resEmpty.issues.some((i) => i.code === 'ERR_INVALID_COMMAND'));
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputEmpty),
      (err: unknown) => err instanceof InvalidCommandError && err.code === 'ERR_INVALID_COMMAND'
    );

    // Whitespace-only command
    const inputWhitespace = createValidEvidenceInput({ command: '   \t\n  ' });
    assert.equal(validateSystemVerifiedEvidence(inputWhitespace).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputWhitespace),
      InvalidCommandError
    );
  });

  // --------------------------------------------------------------------------
  // E5 — invalid exit_code rejected
  // --------------------------------------------------------------------------
  it('E5 — invalid exit_code rejected', () => {
    const invalidCodes = [-1, 256, 1.5, NaN, Infinity, '0' as unknown as number, null as unknown as number];

    for (const code of invalidCodes) {
      const input = createValidEvidenceInput({ exit_code: code });
      const result = validateSystemVerifiedEvidence(input);
      assert.equal(result.valid, false, `Expected exit_code ${code} to be rejected`);

      if (code === null) {
        assert.throws(() => assertValidSystemVerifiedEvidence(input), MissingEvidenceFieldError);
      } else {
        assert.throws(
          () => assertValidSystemVerifiedEvidence(input),
          (err: unknown) => err instanceof InvalidExitCodeError && err.code === 'ERR_INVALID_EXIT_CODE'
        );
      }
    }

    // Valid boundaries: 0, 1, 255
    for (const validCode of [0, 1, 127, 255]) {
      const input = createValidEvidenceInput({ exit_code: validCode });
      const result = validateSystemVerifiedEvidence(input);
      assert.equal(result.valid, true, `Expected exit_code ${validCode} to be valid`);
    }
  });

  // --------------------------------------------------------------------------
  // E6 — missing working_directory rejected
  // --------------------------------------------------------------------------
  it('E6 — missing working_directory rejected', () => {
    // Missing
    const inputMissing = createValidEvidenceInput({ working_directory: undefined });
    assert.equal(validateSystemVerifiedEvidence(inputMissing).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputMissing),
      (err: unknown) => err instanceof MissingEvidenceFieldError && err.field === 'working_directory'
    );

    // Empty
    const inputEmpty = createValidEvidenceInput({ working_directory: '   ' });
    assert.equal(validateSystemVerifiedEvidence(inputEmpty).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputEmpty),
      (err: unknown) => err instanceof MissingEvidenceFieldError && err.field === 'working_directory'
    );
  });

  // --------------------------------------------------------------------------
  // E7 — invalid execution_time_ms rejected
  // --------------------------------------------------------------------------
  it('E7 — invalid execution_time_ms rejected', () => {
    const invalidTimes = [-10, -0.001, NaN, Infinity, -Infinity, '100' as unknown as number];

    for (const time of invalidTimes) {
      const input = createValidEvidenceInput({ execution_time_ms: time });
      assert.equal(validateSystemVerifiedEvidence(input).valid, false, `Expected time ${time} to be rejected`);
      assert.throws(
        () => assertValidSystemVerifiedEvidence(input),
        (err: unknown) => err instanceof InvalidExecutionMetadataError && err.code === 'ERR_INVALID_EXECUTION_METADATA'
      );
    }

    // Missing execution_time_ms
    const inputMissing = createValidEvidenceInput({ execution_time_ms: undefined });
    assert.equal(validateSystemVerifiedEvidence(inputMissing).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(inputMissing),
      MissingEvidenceFieldError
    );

    // Valid non-negative times
    for (const validTime of [0, 0.5, 1200, 999999]) {
      const input = createValidEvidenceInput({ execution_time_ms: validTime });
      assert.equal(validateSystemVerifiedEvidence(input).valid, true);
    }
  });

  // --------------------------------------------------------------------------
  // E8 — malformed SHA-256 file hash rejected
  // --------------------------------------------------------------------------
  it('E8 — malformed SHA-256 file hash rejected', () => {
    const malformedHashes = [
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85', // 63 chars
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555', // 65 chars
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85z', // invalid char 'z'
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85G', // invalid char 'G'
      '', // empty
      'not-a-hash',
    ];

    for (const badHash of malformedHashes) {
      const input = createValidEvidenceInput({
        file_hashes_after: { 'src/app.ts': badHash },
      });
      const result = validateSystemVerifiedEvidence(input);
      assert.equal(result.valid, false, `Expected malformed hash '${badHash}' to be rejected`);
      assert.ok(result.issues.some((i) => i.code === 'ERR_MALFORMED_FILE_HASH'));
      assert.throws(
        () => assertValidSystemVerifiedEvidence(input),
        (err: unknown) => err instanceof MalformedFileHashError && err.code === 'ERR_MALFORMED_FILE_HASH'
      );
    }
  });

  // --------------------------------------------------------------------------
  // E9 — valid SHA-256 file hash accepted
  // --------------------------------------------------------------------------
  it('E9 — valid SHA-256 file hash accepted', () => {
    assert.equal(isValidSha256(VALID_SHA256), true);
    assert.equal(isValidSha256(VALID_SHA256_UPPER), true);

    const input = createValidEvidenceInput({
      file_hashes_after: {
        'src/lower.ts': VALID_SHA256,
        'src/upper.ts': VALID_SHA256_UPPER,
      },
    });

    const result = validateSystemVerifiedEvidence(input);
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);

    const verified = assertValidSystemVerifiedEvidence(input);
    assert.equal(verified.file_hashes_after?.['src/lower.ts'], VALID_SHA256);
    assert.equal(verified.file_hashes_after?.['src/upper.ts'], VALID_SHA256_UPPER);
  });

  // --------------------------------------------------------------------------
  // E10 — invalid Git reference rejected when Git reference is supplied
  // --------------------------------------------------------------------------
  it('E10 — invalid Git reference rejected when Git reference is supplied', () => {
    const invalidGitRefs = [
      'not-a-valid-sha',
      'invalid..ref',
      'HEAD~1',
      'refs/heads/feature.lock',
      'refs/heads//main',
      'commit-hash-abc',
      '   ',
      'refs/heads/.hidden',
      'refs/heads/trailing/',
    ];

    for (const badRef of invalidGitRefs) {
      const inputBefore = createValidEvidenceInput({ git_head_before: badRef });
      assert.equal(validateSystemVerifiedEvidence(inputBefore).valid, false, `Expected git_head_before '${badRef}' to be rejected`);
      assert.throws(
        () => assertValidSystemVerifiedEvidence(inputBefore),
        (err: unknown) => err instanceof InvalidGitReferenceError && err.code === 'ERR_INVALID_GIT_REFERENCE'
      );

      const inputAfter = createValidEvidenceInput({ git_head_after: badRef });
      assert.equal(validateSystemVerifiedEvidence(inputAfter).valid, false, `Expected git_head_after '${badRef}' to be rejected`);
      assert.throws(
        () => assertValidSystemVerifiedEvidence(inputAfter),
        InvalidGitReferenceError
      );
    }

    // Valid Git references accepted
    const validGitRefs = [
      VALID_GIT_SHA1,
      VALID_GIT_SHA256,
      'HEAD',
      'refs/heads/main',
      'refs/heads/feature/task-p4-01',
      'refs/tags/v1.0.0',
    ];

    for (const goodRef of validGitRefs) {
      const input = createValidEvidenceInput({
        git_head_before: goodRef,
        git_head_after: goodRef,
      });
      assert.equal(validateSystemVerifiedEvidence(input).valid, true, `Expected ref '${goodRef}' to be accepted`);
    }

    // Unavailable git reference represented explicitly as null accepted
    const inputNullGit = createValidEvidenceInput({
      git_head_before: null,
      git_head_after: null,
    });
    const resNullGit = validateSystemVerifiedEvidence(inputNullGit);
    assert.equal(resNullGit.valid, true);
    assert.equal(resNullGit.evidence?.git_head_before, null);
    assert.equal(resNullGit.evidence?.git_head_after, null);
  });

  // --------------------------------------------------------------------------
  // E11 — agent claim cannot validate as system evidence
  // --------------------------------------------------------------------------
  it('E11 — agent claim cannot validate as system evidence', () => {
    // 1. AgentClaim instance created with createAgentClaim
    const claim: AgentClaim = createAgentClaim({
      task_id: 'TASK-P4-01',
      statement: 'I ran the tests and verified they all pass 100%',
    });

    const resClaim = validateSystemVerifiedEvidence(claim);
    assert.equal(resClaim.valid, false);
    assert.equal(resClaim.status, EvidenceValidationStatus.INVALID);
    assert.ok(resClaim.issues.some((i) => i.code === 'ERR_INVALID_EVIDENCE_SOURCE'));
    assert.throws(
      () => assertValidSystemVerifiedEvidence(claim),
      (err: unknown) => err instanceof InvalidEvidenceSourceError && err.code === 'ERR_INVALID_EVIDENCE_SOURCE'
    );

    // 2. Evidence-like object attempting to masquerade with AGENT_CLAIM source
    const masqueradingInput = createValidEvidenceInput({
      source: EvidenceSource.AGENT_CLAIM,
    });
    const resMasquerade = validateSystemVerifiedEvidence(masqueradingInput);
    assert.equal(resMasquerade.valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(masqueradingInput),
      InvalidEvidenceSourceError
    );

    // 3. Object with is_agent_claim: true
    const flaggedClaim = createValidEvidenceInput({
      is_agent_claim: true,
    });
    assert.equal(validateSystemVerifiedEvidence(flaggedClaim).valid, false);
    assert.throws(
      () => assertValidSystemVerifiedEvidence(flaggedClaim),
      InvalidEvidenceSourceError
    );
  });

  // --------------------------------------------------------------------------
  // E12 — structured validation errors contain deterministic error codes/reasons
  // --------------------------------------------------------------------------
  it('E12 — structured validation errors contain deterministic error codes/reasons', () => {
    const input = createValidEvidenceInput({
      evidence_id: undefined,
      command: '',
      exit_code: -5,
    });

    const result = validateSystemVerifiedEvidence(input);
    assert.equal(result.valid, false);
    assert.ok(result.issues.length >= 3);

    // Check deterministic codes
    const codes = result.issues.map((i) => i.code);
    assert.ok(codes.includes('ERR_MISSING_EVIDENCE_FIELD'));
    assert.ok(codes.includes('ERR_INVALID_COMMAND'));
    assert.ok(codes.includes('ERR_INVALID_EXIT_CODE'));

    // Check toJSON serialization on EvidenceError
    const err = new InvalidExitCodeError('Exit code must be between 0 and 255', {
      field: 'exit_code',
      reason: 'NEGATIVE_CODE',
      evidenceId: 'evi-1',
      taskId: 'TASK-P4-01',
    });

    assert.ok(err instanceof AidmError);
    assert.ok(err instanceof EvidenceError);
    assert.equal(err.code, 'ERR_INVALID_EXIT_CODE');
    assert.equal(err.field, 'exit_code');
    assert.equal(err.reason, 'NEGATIVE_CODE');
    assert.equal(err.taskId, 'TASK-P4-01');

    const json = err.toJSON();
    assert.equal(json.name, 'InvalidExitCodeError');
    assert.equal(json.code, 'ERR_INVALID_EXIT_CODE');
    assert.ok(typeof json.message === 'string');
    assert.deepEqual(json.details, {
      field: 'exit_code',
      reason: 'NEGATIVE_CODE',
      evidenceId: 'evi-1',
      taskId: 'TASK-P4-01',
    });
  });

  // --------------------------------------------------------------------------
  // E13 — same evidence input produces identical validation result
  // --------------------------------------------------------------------------
  it('E13 — same evidence input produces identical validation result', () => {
    const input = createValidEvidenceInput();

    const results = Array.from({ length: 10 }, () => validateSystemVerifiedEvidence(input));

    for (let i = 1; i < results.length; i++) {
      assert.deepEqual(results[i], results[0]);
    }

    const invalidInput = createValidEvidenceInput({
      exit_code: 999,
      command: '   ',
    });

    const invalidResults = Array.from({ length: 10 }, () => validateSystemVerifiedEvidence(invalidInput));
    for (let i = 1; i < invalidResults.length; i++) {
      assert.deepEqual(invalidResults[i], invalidResults[0]);
    }
  });

  // --------------------------------------------------------------------------
  // E14 — multiple file hashes are validated deterministically
  // --------------------------------------------------------------------------
  it('E14 — multiple file hashes are validated deterministically', () => {
    // Input with mixed valid and invalid hashes in different key orders
    const hashesA: Record<string, string> = {
      'z_file.ts': 'invalid_hash_z',
      'a_file.ts': 'invalid_hash_a',
      'm_file.ts': VALID_SHA256,
      'b_file.ts': 'invalid_hash_b',
    };

    const hashesB: Record<string, string> = {
      'b_file.ts': 'invalid_hash_b',
      'a_file.ts': 'invalid_hash_a',
      'z_file.ts': 'invalid_hash_z',
      'm_file.ts': VALID_SHA256,
    };

    const resultA = validateSystemVerifiedEvidence(createValidEvidenceInput({ file_hashes_after: hashesA }));
    const resultB = validateSystemVerifiedEvidence(createValidEvidenceInput({ file_hashes_after: hashesB }));

    assert.equal(resultA.valid, false);
    assert.equal(resultB.valid, false);

    // In both cases, issues must be ordered deterministically by key: a_file.ts, b_file.ts, z_file.ts
    const fieldsA = resultA.issues.map((i) => i.field);
    const fieldsB = resultB.issues.map((i) => i.field);

    assert.deepEqual(fieldsA, [
      'file_hashes_after[a_file.ts]',
      'file_hashes_after[b_file.ts]',
      'file_hashes_after[z_file.ts]',
    ]);
    assert.deepEqual(fieldsB, fieldsA);
    assert.deepEqual(resultA.issues, resultB.issues);
  });

  // --------------------------------------------------------------------------
  // E15 — secret-looking data is not leaked through validation errors
  // --------------------------------------------------------------------------
  it('E15 — secret-looking data is not leaked through validation errors', () => {
    const sensitiveApiKey = 'sk-ant-api03-SECRETKEY1234567890abcdef';
    const sensitiveBearer = 'Bearer secret-bearer-token-1234567890';
    const sensitiveToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    // Malformed file hash containing sensitive key
    const inputWithSecretHash = createValidEvidenceInput({
      file_hashes_after: {
        'secrets.env': sensitiveApiKey,
      },
    });

    const result = validateSystemVerifiedEvidence(inputWithSecretHash);
    assert.equal(result.valid, false);
    const issueMsg = result.issues[0].message;
    assert.ok(!issueMsg.includes(sensitiveApiKey), 'Sensitive API key must not appear in validation message');
    assert.ok(issueMsg.includes('***REDACTED_KEY***'));

    // Command containing Bearer token and password
    const err = new InvalidCommandError(`Execution failed with ${sensitiveBearer} and password=supersecretpass`, {
      field: 'command',
      reason: 'FAILED',
      evidenceId: 'evi-secret',
      apiKey: sensitiveToken,
      secretToken: sensitiveApiKey,
    });

    assert.ok(!err.message.includes('supersecretpass'));
    assert.ok(!err.message.includes('secret-bearer-token'));
    assert.ok(err.message.includes('Bearer ***REDACTED_TOKEN***'));
    assert.ok(err.message.includes('password=***REDACTED***'));

    const json = err.toJSON();
    const details = json.details as Record<string, unknown>;
    assert.equal(details.apiKey, '***REDACTED***');
    assert.equal(details.secretToken, '***REDACTED***');
  });

  // --------------------------------------------------------------------------
  // Non-object and edge case inputs
  // --------------------------------------------------------------------------
  it('should reject non-object and array inputs gracefully', () => {
    const invalidInputs = [null, undefined, 'string', 123, true, [], ['not', 'an', 'object']];
    for (const inv of invalidInputs) {
      const res = validateSystemVerifiedEvidence(inv);
      assert.equal(res.valid, false);
      assert.equal(res.status, EvidenceValidationStatus.INVALID);
      assert.throws(
        () => assertValidSystemVerifiedEvidence(inv),
        InvalidEvidenceError
      );
    }
  });

  // --------------------------------------------------------------------------
  // Optional and unavailable fields preserved explicitly
  // --------------------------------------------------------------------------
  it('should preserve unavailable facts explicitly as null without fabricating values', () => {
    const minimalInput: SystemVerifiedEvidenceInput = {
      evidence_id: 'evi:min:1',
      task_id: 'TASK-MIN',
      project_id: 'proj:test',
      correlation_id: 'corr:1',
      command: 'echo hello',
      exit_code: 0,
      working_directory: '/app',
      execution_time_ms: 10,
    };

    const res = validateSystemVerifiedEvidence(minimalInput);
    assert.equal(res.valid, true);
    assert.ok(res.evidence);

    assert.equal(res.evidence.instruction_id, null);
    assert.equal(res.evidence.stdout_tail, null);
    assert.equal(res.evidence.stderr, null);
    assert.equal(res.evidence.git_head_before, null);
    assert.equal(res.evidence.git_head_after, null);
    assert.equal(res.evidence.unified_diff, null);
    assert.equal(res.evidence.file_hashes_after, null);
    assert.equal(res.evidence.executor_identity, null);
    assert.equal(res.evidence.captured_at, null);
    assert.equal(res.evidence.metadata, null);
    assert.equal(res.evidence.evidence_type, EvidenceType.COMMAND);
    assert.equal(res.evidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
  });
});
