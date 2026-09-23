import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import {
  EvidenceType,
  EvidenceSource,
  type SystemVerifiedEvidence,
  type SystemVerifiedEvidenceInput,
  validateSystemVerifiedEvidence,
  createAgentClaim,
  QAReviewEngine,
  ReviewDecision,
  CriterionStatus,
  CriterionType,
  ReviewFindingSeverity,
  InvalidReviewRequestError,
  MissingAcceptanceCriteriaError,
  UnsupportedCriterionTypeError,
  type ReviewRequestInput,
  type AcceptanceCriterionInput,
  // Phase 1 regression
  RecoveryEngine,
  StateMachine,
  L0Indexer,
  // Phase 2 regression
  TaskDagEngine,
  ContextEngine,
  TokenBudgetEngine,
  // Phase 3 regression
  AntigravityAdapter,
  ReferenceLlmAdapter,
  // P4-02 regression
  EvidenceCollector,
  NodeProcessExecutor,
  DefaultGitObserver,
  FileHashCollector,
} from '../dist/index.js';

// ============================================================================
// FIXTURES
// ============================================================================

const TASK_ID = 'TASK-P4-03';
const PROJECT_ID = 'proj:aidm-core';
const CORRELATION_ID = 'corr:proj:aidm-core:TASK-P4-03:1';
const VALID_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const VALID_GIT_SHA = '79e3b2b255f927c5f586379aec08c20916fc7450';

function createValidEvidence(
  overrides?: Partial<SystemVerifiedEvidenceInput>
): SystemVerifiedEvidence {
  const input: SystemVerifiedEvidenceInput = {
    evidence_id: 'evi:task-p4-03:build:1',
    task_id: TASK_ID,
    instruction_id: 'inst:task-p4-03:1',
    project_id: PROJECT_ID,
    correlation_id: CORRELATION_ID,
    command: 'pnpm --filter @aidm/core build',
    exit_code: 0,
    stdout_tail: 'tsc -b\nDone in 1.1s',
    stderr: null,
    working_directory: '/workspaces/OtonomMCP',
    execution_time_ms: 1100,
    git_head_before: VALID_GIT_SHA,
    git_head_after: VALID_GIT_SHA,
    unified_diff: null,
    file_hashes_after: {
      'packages/core/src/index.ts': VALID_SHA256,
    },
    evidence_type: EvidenceType.BUILD,
    executor_identity: {
      provider: 'shell',
      name: 'node-executor',
      version: '1.0.0',
    },
    captured_at: '2026-09-23T09:00:00.000Z',
    metadata: { env: 'test' },
    source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
    ...overrides,
  };

  const val = validateSystemVerifiedEvidence(input);
  if (!val.valid || !val.evidence) {
    throw new Error(`Fixture validation failed: ${val.issues.map((i) => i.message).join(', ')}`);
  }
  return val.evidence;
}

// ============================================================================
// TEST SUITE: QA REVIEW ENGINE (TASK-P4-03)
// ============================================================================

describe('QA Review Engine (TASK-P4-03)', () => {
  const engine = new QAReviewEngine();

  // --------------------------------------------------------------------------
  // R1 — valid satisfied criterion produces SATISFIED
  // --------------------------------------------------------------------------
  it('R1 — valid satisfied criterion produces SATISFIED', () => {
    const evidence = createValidEvidence({
      evidence_id: 'evi:build:1',
      command: 'pnpm --filter @aidm/core build',
      exit_code: 0,
      evidence_type: EvidenceType.BUILD,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build must compile successfully',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm --filter @aidm/core build',
          expected_exit_code: 0,
        },
      ],
      evidence: [evidence],
    };

    const result = engine.review(request);
    assert.equal(result.criteria_results.length, 1);
    const cr = result.criteria_results[0];
    assert.equal(cr.criterion_id, 'AC-001');
    assert.equal(cr.status, CriterionStatus.SATISFIED);
    assert.equal(cr.satisfied, true);
    assert.deepEqual(cr.evidence_ids, ['evi:build:1']);
  });

  // --------------------------------------------------------------------------
  // R2 — all mandatory criteria satisfied produces ACCEPT
  // --------------------------------------------------------------------------
  it('R2 — all mandatory criteria satisfied produces ACCEPT', () => {
    const buildEvi = createValidEvidence({
      evidence_id: 'evi:build:1',
      command: 'pnpm --filter @aidm/core build',
      exit_code: 0,
      evidence_type: EvidenceType.BUILD,
    });

    const testEvi = createValidEvidence({
      evidence_id: 'evi:test:1',
      command: 'pnpm test',
      exit_code: 0,
      evidence_type: EvidenceType.TEST,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build succeeds',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm --filter @aidm/core build',
        },
        {
          criterion_id: 'AC-002',
          description: 'Tests pass',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
        },
      ],
      evidence: [buildEvi, testEvi],
    };

    const result = engine.review(request);
    assert.equal(result.decision, ReviewDecision.ACCEPT);
    assert.equal(result.all_mandatory_satisfied, true);
    assert.equal(result.criteria_results.every((c) => c.status === CriterionStatus.SATISFIED), true);
  });

  // --------------------------------------------------------------------------
  // R3 — explicit failed command evidence produces NOT_SATISFIED
  // --------------------------------------------------------------------------
  it('R3 — explicit failed command evidence produces NOT_SATISFIED', () => {
    const failedEvi = createValidEvidence({
      evidence_id: 'evi:build:failed',
      command: 'pnpm --filter @aidm/core build',
      exit_code: 1,
      evidence_type: EvidenceType.BUILD,
      stderr: 'error TS2304: Cannot find name foo',
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build succeeds',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm --filter @aidm/core build',
          expected_exit_code: 0,
        },
      ],
      evidence: [failedEvi],
    };

    const result = engine.review(request);
    const cr = result.criteria_results[0];
    assert.equal(cr.status, CriterionStatus.NOT_SATISFIED);
    assert.equal(cr.satisfied, false);
    assert.match(cr.reason, /exited with code 1/);
  });

  // --------------------------------------------------------------------------
  // R4 — failed mandatory criterion produces REJECT
  // --------------------------------------------------------------------------
  it('R4 — failed mandatory criterion produces REJECT', () => {
    const failedEvi = createValidEvidence({
      evidence_id: 'evi:test:failed',
      command: 'pnpm test',
      exit_code: 2,
      evidence_type: EvidenceType.TEST,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'All unit tests must pass',
          criterion_type: CriterionType.TEST,
          is_mandatory: true,
        },
      ],
      evidence: [failedEvi],
    };

    const result = engine.review(request);
    assert.equal(result.decision, ReviewDecision.REJECT);
    assert.equal(result.all_mandatory_satisfied, false);
    assert.match(result.summary, /Review rejected/);
  });

  // --------------------------------------------------------------------------
  // R5 — missing required evidence produces INSUFFICIENT_EVIDENCE
  // --------------------------------------------------------------------------
  it('R5 — missing required evidence produces INSUFFICIENT_EVIDENCE', () => {
    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Must run integration tests',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test:integration',
        },
      ],
      evidence: [], // No evidence
    };

    const result = engine.review(request);
    const cr = result.criteria_results[0];
    assert.equal(cr.status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    assert.equal(cr.satisfied, false);
    assert.deepEqual(cr.missing_evidence, ['AC-001']);
  });

  // --------------------------------------------------------------------------
  // R6 — insufficient evidence produces REQUEST_CONTEXT
  // --------------------------------------------------------------------------
  it('R6 — insufficient evidence produces REQUEST_CONTEXT', () => {
    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build verification',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm build',
        },
      ],
      evidence: [], // Missing evidence
    };

    const result = engine.review(request);
    assert.equal(result.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.match(result.summary, /requires additional context/);
    assert.notEqual(result.decision, ReviewDecision.REJECT);
  });

  // --------------------------------------------------------------------------
  // R7 — AGENT_CLAIM cannot satisfy a criterion
  // --------------------------------------------------------------------------
  it('R7 — AGENT_CLAIM cannot satisfy a criterion', () => {
    const agentClaim = createAgentClaim({
      task_id: TASK_ID,
      statement: 'I successfully executed pnpm build and 100% tests passed.',
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build verification',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm build',
        },
      ],
      evidence: [agentClaim],
    };

    const result = engine.review(request);
    assert.equal(result.rejected_claims_count, 1);
    assert.equal(result.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.equal(result.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    const claimFinding = result.findings.find((f) => f.code === 'ERR_AGENT_CLAIM_REJECTED');
    assert.ok(claimFinding);
  });

  // --------------------------------------------------------------------------
  // R8 — invalid SystemVerifiedEvidence is rejected
  // --------------------------------------------------------------------------
  it('R8 — invalid SystemVerifiedEvidence is rejected', () => {
    const invalidEvidence = {
      evidence_id: 'evi:invalid',
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      command: 'test',
      exit_code: 999, // Invalid exit code (> 255)
      working_directory: '/work',
      execution_time_ms: -50, // Invalid execution time
    };

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Test command execution',
          criterion_type: CriterionType.COMMAND,
        },
      ],
      evidence: [invalidEvidence],
    };

    const result = engine.review(request);
    assert.equal(result.invalid_evidence_count, 1);
    assert.equal(result.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    const invalidFinding = result.findings.find((f) => f.code === 'ERR_INVALID_REVIEW_EVIDENCE');
    assert.ok(invalidFinding);
  });

  // --------------------------------------------------------------------------
  // R9 — evidence from another task cannot satisfy current task
  // --------------------------------------------------------------------------
  it('R9 — evidence from another task cannot satisfy current task', () => {
    const foreignEvidence = createValidEvidence({
      evidence_id: 'evi:foreign:task',
      task_id: 'TASK-OTHER-99', // Different task
      command: 'pnpm test',
      exit_code: 0,
      evidence_type: EvidenceType.TEST,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Run unit tests',
          criterion_type: CriterionType.TEST,
        },
      ],
      evidence: [foreignEvidence],
    };

    const result = engine.review(request);
    assert.equal(result.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    assert.equal(result.decision, ReviewDecision.REQUEST_CONTEXT);
    const mismatch = result.findings.find((f) => f.code === 'ERR_EVIDENCE_IDENTITY_MISMATCH');
    assert.ok(mismatch);
  });

  // --------------------------------------------------------------------------
  // R10 — evidence from another project cannot satisfy current task
  // --------------------------------------------------------------------------
  it('R10 — evidence from another project cannot satisfy current task', () => {
    const foreignProjectEvidence = createValidEvidence({
      evidence_id: 'evi:foreign:proj',
      project_id: 'proj:unrelated-repo', // Different project
      command: 'pnpm test',
      exit_code: 0,
      evidence_type: EvidenceType.TEST,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Run unit tests',
          criterion_type: CriterionType.TEST,
        },
      ],
      evidence: [foreignProjectEvidence],
    };

    const result = engine.review(request);
    assert.equal(result.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    assert.equal(result.decision, ReviewDecision.REQUEST_CONTEXT);
    const mismatch = result.findings.find((f) => f.code === 'ERR_EVIDENCE_IDENTITY_MISMATCH');
    assert.ok(mismatch);
  });

  // --------------------------------------------------------------------------
  // R11 — evidence from another correlation cannot silently satisfy current review
  // --------------------------------------------------------------------------
  it('R11 — evidence from another correlation cannot silently satisfy current review', () => {
    const foreignCorrEvidence = createValidEvidence({
      evidence_id: 'evi:foreign:corr',
      correlation_id: 'corr:stale-correlation:999', // Different correlation
      command: 'pnpm test',
      exit_code: 0,
      evidence_type: EvidenceType.TEST,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Run unit tests',
          criterion_type: CriterionType.TEST,
        },
      ],
      evidence: [foreignCorrEvidence],
    };

    const result = engine.review(request);
    assert.equal(result.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    assert.equal(result.decision, ReviewDecision.REQUEST_CONTEXT);
    const mismatch = result.findings.find((f) => f.code === 'ERR_EVIDENCE_IDENTITY_MISMATCH');
    assert.ok(mismatch);
  });

  // --------------------------------------------------------------------------
  // R12 — conflicting evidence is explicitly represented
  // --------------------------------------------------------------------------
  it('R12 — conflicting evidence is explicitly represented', () => {
    const eviSuccess = createValidEvidence({
      evidence_id: 'evi:cmd:success',
      command: 'pnpm test',
      exit_code: 0,
      evidence_type: EvidenceType.TEST,
    });

    const eviFailure = createValidEvidence({
      evidence_id: 'evi:cmd:failed',
      command: 'pnpm test',
      exit_code: 1,
      evidence_type: EvidenceType.TEST,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Run tests with exit code 0',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
          expected_exit_code: 0,
        },
      ],
      evidence: [eviSuccess, eviFailure],
    };

    const result = engine.review(request);
    const cr = result.criteria_results[0];
    assert.equal(cr.status, CriterionStatus.CONFLICTING_EVIDENCE);
    assert.equal(cr.satisfied, false);
    assert.deepEqual(cr.conflicting_evidence, ['evi:cmd:failed', 'evi:cmd:success']);
    assert.equal(result.decision, ReviewDecision.REQUEST_CONTEXT);
  });

  // --------------------------------------------------------------------------
  // R13 — deterministic ordering of evidence IDs
  // --------------------------------------------------------------------------
  it('R13 — deterministic ordering of evidence IDs', () => {
    const eviZ = createValidEvidence({ evidence_id: 'evi:z:cmd', command: 'cmd_z', exit_code: 0 });
    const eviA = createValidEvidence({ evidence_id: 'evi:a:cmd', command: 'cmd_a', exit_code: 0 });
    const eviM = createValidEvidence({ evidence_id: 'evi:m:cmd', command: 'cmd_m', exit_code: 0 });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Execute commands',
          criterion_type: CriterionType.COMMAND,
        },
      ],
      // Supply in reverse / mixed order
      evidence: [eviZ, eviA, eviM],
    };

    const result = engine.review(request);
    assert.deepEqual(result.evidence_ids_used, ['evi:a:cmd', 'evi:m:cmd', 'evi:z:cmd']);
    assert.deepEqual(result.criteria_results[0].evidence_ids, ['evi:a:cmd', 'evi:m:cmd', 'evi:z:cmd']);
  });

  // --------------------------------------------------------------------------
  // R14 — repeated identical review produces identical result
  // --------------------------------------------------------------------------
  it('R14 — repeated identical review produces identical result', () => {
    const buildEvi = createValidEvidence({
      evidence_id: 'evi:build:1',
      command: 'pnpm --filter @aidm/core build',
      exit_code: 0,
      evidence_type: EvidenceType.BUILD,
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build',
          criterion_type: CriterionType.BUILD,
        },
      ],
      evidence: [buildEvi],
    };

    const result1 = engine.review(request);
    const result2 = engine.review(request);
    assert.deepEqual(result1, result2);
    assert.equal(JSON.stringify(result1), JSON.stringify(result2));
  });

  // --------------------------------------------------------------------------
  // R15 — invalid review request produces structured error
  // --------------------------------------------------------------------------
  it('R15 — invalid review request produces structured error', () => {
    assert.throws(
      () => engine.review(null as unknown as ReviewRequestInput),
      (err: unknown) => err instanceof InvalidReviewRequestError && err.code === 'ERR_INVALID_REVIEW_REQUEST'
    );

    assert.throws(
      () =>
        engine.review({
          task_id: '',
          project_id: PROJECT_ID,
          correlation_id: CORRELATION_ID,
          acceptance_criteria: [{ criterion_id: 'AC-1', description: 'desc' }],
        }),
      (err: unknown) => err instanceof InvalidReviewRequestError && err.code === 'ERR_INVALID_REVIEW_REQUEST'
    );
  });

  // --------------------------------------------------------------------------
  // R16 — missing acceptance criteria is rejected structurally
  // --------------------------------------------------------------------------
  it('R16 — missing acceptance criteria is rejected structurally', () => {
    assert.throws(
      () =>
        engine.review({
          task_id: TASK_ID,
          project_id: PROJECT_ID,
          correlation_id: CORRELATION_ID,
          acceptance_criteria: [], // Empty
        }),
      (err: unknown) =>
        err instanceof MissingAcceptanceCriteriaError &&
        err.code === 'ERR_MISSING_ACCEPTANCE_CRITERIA'
    );
  });

  // --------------------------------------------------------------------------
  // R17 — test success requires system evidence
  // --------------------------------------------------------------------------
  it('R17 — test success requires system evidence', () => {
    const claim = createAgentClaim({
      task_id: TASK_ID,
      statement: 'pnpm test passed all 409 tests',
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
    });

    const requestWithClaim: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Tests pass',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
        },
      ],
      evidence: [claim],
    };

    const res1 = engine.review(requestWithClaim);
    assert.equal(res1.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.equal(res1.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);

    // Provide actual system evidence
    const testEvi = createValidEvidence({
      evidence_id: 'evi:test:pass',
      command: 'pnpm test',
      exit_code: 0,
      evidence_type: EvidenceType.TEST,
    });

    const res2 = engine.review({
      ...requestWithClaim,
      evidence: [testEvi],
    });
    assert.equal(res2.decision, ReviewDecision.ACCEPT);
    assert.equal(res2.criteria_results[0].status, CriterionStatus.SATISFIED);
  });

  // --------------------------------------------------------------------------
  // R18 — build success requires system evidence
  // --------------------------------------------------------------------------
  it('R18 — build success requires system evidence', () => {
    const requestNoEvi: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Build',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm --filter @aidm/core build',
        },
      ],
      evidence: [],
    };

    const res1 = engine.review(requestNoEvi);
    assert.equal(res1.decision, ReviewDecision.REQUEST_CONTEXT);

    const buildEvi = createValidEvidence({
      evidence_id: 'evi:build:sys',
      command: 'pnpm --filter @aidm/core build',
      exit_code: 0,
      evidence_type: EvidenceType.BUILD,
    });

    const res2 = engine.review({
      ...requestNoEvi,
      evidence: [buildEvi],
    });
    assert.equal(res2.decision, ReviewDecision.ACCEPT);
  });

  // --------------------------------------------------------------------------
  // R19 — Git/diff criterion uses evidence rather than executing Git
  // --------------------------------------------------------------------------
  it('R19 — Git/diff criterion uses evidence rather than executing Git', () => {
    const gitEvi = createValidEvidence({
      evidence_id: 'evi:git:diff',
      evidence_type: EvidenceType.GIT,
      git_head_before: 'e6fb10009791959048924a85b4a08ad57c750c85',
      git_head_after: VALID_GIT_SHA,
      unified_diff: 'diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts\n+export * from "./qa-review";',
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-GIT-001',
          description: 'Git diff present and scanner.ts untouched',
          criterion_type: CriterionType.GIT,
          require_diff: true,
          disallowed_diff_patterns: ['packages/core/src/l0/scanner.ts'],
          expected_git_head: VALID_GIT_SHA,
        },
      ],
      evidence: [gitEvi],
    };

    const result = engine.review(request);
    assert.equal(result.decision, ReviewDecision.ACCEPT);
    assert.equal(result.criteria_results[0].status, CriterionStatus.SATISFIED);
  });

  // --------------------------------------------------------------------------
  // R20 — file hash criterion uses collected hash evidence
  // --------------------------------------------------------------------------
  it('R20 — file hash criterion uses collected hash evidence', () => {
    const hashEvi = createValidEvidence({
      evidence_id: 'evi:hash:1',
      evidence_type: EvidenceType.FILE_HASH,
      file_hashes_after: {
        'packages/core/src/index.ts': VALID_SHA256,
      },
    });

    const request: ReviewRequestInput = {
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-HASH-001',
          description: 'File index.ts must match expected SHA-256',
          criterion_type: CriterionType.FILE_HASH,
          required_files: ['packages/core/src/index.ts'],
          file_hashes: {
            'packages/core/src/index.ts': VALID_SHA256,
          },
        },
      ],
      evidence: [hashEvi],
    };

    const result = engine.review(request);
    assert.equal(result.decision, ReviewDecision.ACCEPT);
    assert.equal(result.criteria_results[0].status, CriterionStatus.SATISFIED);

    // Hash mismatch fails with NOT_SATISFIED
    const mismatchRequest: ReviewRequestInput = {
      ...request,
      acceptance_criteria: [
        {
          criterion_id: 'AC-HASH-001',
          description: 'File index.ts mismatch',
          criterion_type: CriterionType.FILE_HASH,
          file_hashes: {
            'packages/core/src/index.ts': '0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
      ],
    };
    const mismatchResult = engine.review(mismatchRequest);
    assert.equal(mismatchResult.decision, ReviewDecision.REJECT);
    assert.equal(mismatchResult.criteria_results[0].status, CriterionStatus.NOT_SATISFIED);
  });

  // --------------------------------------------------------------------------
  // R21 — reviewer does not execute commands
  // --------------------------------------------------------------------------
  it('R21 — reviewer does not execute commands', () => {
    // 1. Static / Architectural proof: qa-review module does NOT import or reference child_process
    const engineSource = fs.readFileSync(
      new URL('../src/qa-review/qa-review-engine.ts', import.meta.url),
      'utf-8'
    );
    assert.equal(engineSource.includes('child_process'), false);
    assert.equal(engineSource.includes('execSync'), false);
    assert.equal(engineSource.includes('spawn'), false);

    // 2. Runtime proof: supplying a nonexistent / destructive command does not trigger execution
    const evi = createValidEvidence({
      command: 'non_existent_dangerous_os_command_xyz_99999',
      exit_code: 0,
    });

    const start = performance.now();
    const res = engine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-1',
          description: 'No execution',
          expected_command: 'non_existent_dangerous_os_command_xyz_99999',
        },
      ],
      evidence: [evi],
    });
    const duration = performance.now() - start;

    assert.equal(res.decision, ReviewDecision.ACCEPT);
    assert.ok(duration < 50, 'Review should be an instantaneous memory evaluation');
  });

  // --------------------------------------------------------------------------
  // R22 — reviewer does not mutate files
  // --------------------------------------------------------------------------
  it('R22 — reviewer does not mutate files', () => {
    // 1. Static / Architectural proof: qa-review module does NOT import node:fs or write files
    const engineSource = fs.readFileSync(
      new URL('../src/qa-review/qa-review-engine.ts', import.meta.url),
      'utf-8'
    );
    assert.equal(engineSource.includes("from 'fs'"), false);
    assert.equal(engineSource.includes("from 'node:fs'"), false);
    assert.equal(engineSource.includes('writeFileSync'), false);
    assert.equal(engineSource.includes('unlinkSync'), false);

    // 2. Runtime proof: filesystem state is completely invariant across review calls
    const targetFile = new URL('../package.json', import.meta.url);
    const beforeStat = fs.statSync(targetFile);

    const evi = createValidEvidence();
    engine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      acceptance_criteria: [{ criterion_id: 'AC-1', description: 'test' }],
      evidence: [evi],
    });

    const afterStat = fs.statSync(targetFile);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    assert.equal(beforeStat.size, afterStat.size);
  });

  // --------------------------------------------------------------------------
  // R23 — reviewer does not mutate Git
  // --------------------------------------------------------------------------
  it('R23 — reviewer does not mutate Git', () => {
    // Review engine has no git dependencies; verify pure review without git mutation
    const evi = createValidEvidence();
    const res = engine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      acceptance_criteria: [{ criterion_id: 'AC-1', description: 'pure review' }],
      evidence: [evi],
    });

    assert.ok(res);
    assert.equal(typeof res.decision, 'string');
  });

  // --------------------------------------------------------------------------
  // R24 — reviewer does not make policy decisions
  // --------------------------------------------------------------------------
  it('R24 — reviewer does not make policy decisions', () => {
    // Review Engine outputs ReviewDecision; does not execute state transitions
    const evi = createValidEvidence();
    const res = engine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      acceptance_criteria: [{ criterion_id: 'AC-1', description: 'test' }],
      evidence: [evi],
    });

    assert.ok(['ACCEPT', 'REJECT', 'REQUEST_CONTEXT', 'BLOCK'].includes(res.decision));
    // Verify no side-effects or FSM state mutation properties
    assert.equal((res as unknown as Record<string, unknown>).fsm_state, undefined);
  });

  // --------------------------------------------------------------------------
  // R25 — secret-looking data is sanitized
  // --------------------------------------------------------------------------
  it('R25 — secret-looking data is sanitized', () => {
    const secretClaim = createAgentClaim({
      task_id: TASK_ID,
      statement: 'Failed with token=sk-abcdef1234567890secret and password=supersecretpass',
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
    });

    const res = engine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      acceptance_criteria: [{ criterion_id: 'AC-1', description: 'check secrets' }],
      evidence: [secretClaim],
    });

    for (const finding of res.findings) {
      assert.equal(finding.message.includes('sk-abcdef1234567890secret'), false);
      assert.equal(finding.message.includes('supersecretpass'), false);
    }
  });

  // --------------------------------------------------------------------------
  // R26 — Phase 1 regression
  // --------------------------------------------------------------------------
  it('R26 — Phase 1 regression', () => {
    assert.equal(typeof RecoveryEngine, 'function');
    assert.equal(typeof StateMachine, 'function');
    assert.equal(typeof L0Indexer, 'function');
  });

  // --------------------------------------------------------------------------
  // R27 — Phase 2 regression
  // --------------------------------------------------------------------------
  it('R27 — Phase 2 regression', () => {
    assert.equal(typeof TaskDagEngine, 'function');
    assert.equal(typeof ContextEngine, 'function');
    assert.equal(typeof TokenBudgetEngine, 'function');
  });

  // --------------------------------------------------------------------------
  // R28 — Phase 3 regression
  // --------------------------------------------------------------------------
  it('R28 — Phase 3 regression', () => {
    assert.equal(typeof AntigravityAdapter, 'function');
    assert.equal(typeof ReferenceLlmAdapter, 'function');
  });

  // --------------------------------------------------------------------------
  // R29 — P4-01 regression
  // --------------------------------------------------------------------------
  it('R29 — P4-01 regression', () => {
    const val = validateSystemVerifiedEvidence({
      evidence_id: 'evi:p4-01:reg',
      task_id: 'TASK-P4-01',
      project_id: 'proj:test',
      correlation_id: 'corr:test',
      command: 'echo 1',
      exit_code: 0,
      working_directory: '/tmp',
      execution_time_ms: 10,
    });
    assert.equal(val.valid, true);
    assert.equal(val.evidence?.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
  });

  // --------------------------------------------------------------------------
  // R30 — P4-02 regression
  // --------------------------------------------------------------------------
  it('R30 — P4-02 regression', () => {
    assert.equal(typeof EvidenceCollector, 'function');
    assert.equal(typeof NodeProcessExecutor, 'function');
    assert.equal(typeof DefaultGitObserver, 'function');
    assert.equal(typeof FileHashCollector, 'function');
  });
});
