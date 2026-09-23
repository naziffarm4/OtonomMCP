/**
 * @file phase-4-integration.test.ts
 * @description Dedicated Phase 4 Integration & Evidence/QA Boundary Test Suite (TASK-P4-04).
 *
 * Demonstrates the semantic end-to-end integration flow across Phase 4 subsystems:
 * Injected Process/Git/Hash Observation
 *      ↓
 * EvidenceCollector (P4-02)
 *      ↓
 * SystemVerifiedEvidence (P4-01)
 *      ↓
 * EvidenceValidator (P4-01)
 *      ↓
 * QAReviewEngine (P4-03)
 *      ↓
 * Deterministic ReviewResult
 *      ↓
 * Director / Orchestrator decision boundary (DEC-003)
 *
 * Verifies:
 * - I1: Successful Evidence -> QA ACCEPT
 * - I2: Process Failure -> QA REJECT
 * - I3: Missing Evidence -> REQUEST_CONTEXT
 * - I4: Invalid / Agent Claim Evidence Cannot Satisfy QA
 * - I5: Stale / Invalid Evidence Cannot Be Accepted
 * - I6: Multi-Evidence Evaluation & Order Independence
 * - I7: Conflicting Evidence -> CONFLICTING_EVIDENCE & REQUEST_CONTEXT
 * - I8: Collector Metadata Preservation (zero fabrication)
 * - I9: Deterministic Integration (5x repeated pipeline execution)
 * - I10: Regression (Phase 1, Phase 2, Phase 3, P4-01, P4-02, P4-03)
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  // P4-01 Evidence Domain & Validator
  EvidenceType,
  EvidenceSource,
  EvidenceValidationStatus,
  type SystemVerifiedEvidence,
  validateSystemVerifiedEvidence,
  assertValidSystemVerifiedEvidence,
  createAgentClaim,

  // P4-02 Evidence Collector & Ports
  EvidenceCollector,
  FakeProcessExecutor,
  FakeGitObserver,
  FileHashCollector,

  // P4-03 QA Review Engine
  QAReviewEngine,
  ReviewDecision,
  CriterionStatus,
  CriterionType,
  type ReviewRequestInput,
  type ReviewResult,

  // Phase 1 Foundation & Recovery
  RecoveryEngine,
  StateMachine,
  L0Indexer,

  // Phase 2 Context & DAG Engine
  TaskDagEngine,
  ContextEngine,
  TokenBudgetEngine,

  // Phase 3 Bridges
  AntigravityAdapter,
  ReferenceLlmAdapter,
} from '../dist/index.js';

// ============================================================================
// FIXTURES & CONSTANTS
// ============================================================================

const INTEGRATION_TASK_ID = 'TASK-P4-04';
const INTEGRATION_PROJECT_ID = 'proj:aidm-core';
const INTEGRATION_CORRELATION_ID = 'corr:proj:aidm-core:TASK-P4-04:integration';
const VALID_SHA256_A = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const VALID_SHA256_B = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const VALID_GIT_HEAD_BEFORE = 'e6fb10009791959048924a85b4a08ad57c750c85';
const VALID_GIT_HEAD_AFTER = 'fe5091771e9f2011412b2f5a3557241ee039dc54';

function createTempDir(prefix = 'aidm-p4-int-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// PHASE 4 INTEGRATION SUITE
// ============================================================================

describe('Phase 4 Subsystem Integration & QA Boundary (TASK-P4-04)', () => {
  // --------------------------------------------------------------------------
  // I1 — Successful Evidence -> QA ACCEPT
  // --------------------------------------------------------------------------
  it('I1 — Successful Evidence -> QA ACCEPT', async () => {
    // 1. Setup injected fake process executor simulating successful test & build
    const fakeExecutor = new FakeProcessExecutor((cmd) => {
      if (cmd.includes('build')) {
        return {
          command: cmd,
          exitCode: 0,
          stdout: '$ tsc -b\nCompilation successful',
          stderr: '',
          durationMs: 420,
        };
      }
      return {
        command: cmd,
        exitCode: 0,
        stdout: '# tests 439\n# suites 111\n# pass 439\n# fail 0',
        stderr: '',
        durationMs: 780,
      };
    });

    const collector = new EvidenceCollector({ processExecutor: fakeExecutor });

    // 2. Collector executes and gathers system evidence for build
    const buildEvi = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:i1:build',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm --filter @aidm/core build',
      working_directory: '/workspaces/OtonomMCP',
      evidence_type: EvidenceType.BUILD,
    });

    // 3. Collector executes and gathers system evidence for test
    const testEvi = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:i1:test',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm test',
      working_directory: '/workspaces/OtonomMCP',
      evidence_type: EvidenceType.TEST,
    });

    // 4. P4-01 validation of collected evidence
    const valBuild = validateSystemVerifiedEvidence(buildEvi);
    assert.equal(valBuild.valid, true);
    assert.equal(valBuild.evidence?.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);

    const valTest = validateSystemVerifiedEvidence(testEvi);
    assert.equal(valTest.valid, true);
    assert.equal(valTest.evidence?.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);

    // 5. Feed into P4-03 QA Review Engine
    const reviewer = new QAReviewEngine();
    const reviewResult = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-001',
          description: 'Production build compiles cleanly without errors',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm --filter @aidm/core build',
          expected_exit_code: 0,
        },
        {
          criterion_id: 'AC-002',
          description: 'Full test suite passes 100%',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
          expected_exit_code: 0,
          stdout_contains: ['# pass 439', '# fail 0'],
        },
      ],
      evidence: [valBuild.evidence!, valTest.evidence!],
    });

    // 6. Verify end-to-end outcome
    assert.equal(reviewResult.decision, ReviewDecision.ACCEPT);
    assert.equal(reviewResult.all_mandatory_satisfied, true);
    assert.equal(reviewResult.criteria_results.length, 2);
    assert.equal(reviewResult.criteria_results[0].status, CriterionStatus.SATISFIED);
    assert.equal(reviewResult.criteria_results[1].status, CriterionStatus.SATISFIED);
    assert.deepEqual(reviewResult.evidence_ids_used, ['evi:i1:build', 'evi:i1:test']);
  });

  // --------------------------------------------------------------------------
  // I2 — Process Failure -> QA REJECT
  // --------------------------------------------------------------------------
  it('I2 — Process Failure -> QA REJECT', async () => {
    // Fake executor simulates compilation error (exit code 1)
    const fakeExecutor = new FakeProcessExecutor((cmd) => ({
      command: cmd,
      exitCode: 1,
      stdout: '',
      stderr: 'error TS2322: Type string is not assignable to type number',
      durationMs: 310,
    }));

    const collector = new EvidenceCollector({ processExecutor: fakeExecutor });
    const failedEvi = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:i2:failed-build',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm --filter @aidm/core build',
      working_directory: '/workspaces/OtonomMCP',
      evidence_type: EvidenceType.BUILD,
    });

    // Structurally valid system evidence
    assert.equal(failedEvi.exit_code, 1);
    assert.equal(failedEvi.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);

    const reviewer = new QAReviewEngine();
    const reviewResult = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-BUILD',
          description: 'Build must succeed',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm --filter @aidm/core build',
          expected_exit_code: 0,
        },
      ],
      evidence: [failedEvi],
    });

    // Explicit failure evidence triggers REJECT
    assert.equal(reviewResult.decision, ReviewDecision.REJECT);
    assert.equal(reviewResult.all_mandatory_satisfied, false);
    assert.equal(reviewResult.criteria_results[0].status, CriterionStatus.NOT_SATISFIED);
    assert.match(reviewResult.criteria_results[0].reason, /exited with code 1/);
  });

  // --------------------------------------------------------------------------
  // I3 — Missing Evidence -> REQUEST_CONTEXT
  // --------------------------------------------------------------------------
  it('I3 — Missing Evidence -> REQUEST_CONTEXT', async () => {
    const reviewer = new QAReviewEngine();

    // Acceptance criterion requires build and tests, but no evidence supplied
    const reviewResult = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-LINT',
          description: 'Linter verification check',
          criterion_type: CriterionType.COMMAND,
          expected_command: 'pnpm lint',
        },
      ],
      evidence: [], // Missing evidence
    });

    // Must produce REQUEST_CONTEXT and NOT REJECT
    assert.equal(reviewResult.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.equal(reviewResult.all_mandatory_satisfied, false);
    assert.equal(reviewResult.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    assert.deepEqual(reviewResult.criteria_results[0].missing_evidence, ['AC-LINT']);
  });

  // --------------------------------------------------------------------------
  // I4 — Invalid / Agent Claim Evidence Cannot Satisfy QA
  // --------------------------------------------------------------------------
  it('I4 — Invalid / Agent Claim Evidence Cannot Satisfy QA', async () => {
    // 1. Agent claim attempting to masquerade as verification
    const claim = createAgentClaim({
      task_id: INTEGRATION_TASK_ID,
      statement: 'Task is 100% complete, tests passed, and scanner is untouched.',
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
    });

    // 2. Collector strictly rejects agent claims
    const collector = new EvidenceCollector();
    await assert.rejects(
      async () => {
        await collector.collectCommandEvidence({
          task_id: INTEGRATION_TASK_ID,
          project_id: INTEGRATION_PROJECT_ID,
          correlation_id: INTEGRATION_CORRELATION_ID,
          command: 'echo fake',
          source: EvidenceSource.AGENT_CLAIM,
          working_directory: '/workspaces/OtonomMCP',
          exit_code: 0,
          execution_time_ms: 10,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );

    // 3. QA Review Engine strictly rejects agent claims
    const reviewer = new QAReviewEngine();
    const reviewResult = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-TESTS',
          description: 'All tests pass',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
        },
      ],
      evidence: [claim],
    });

    // Claim cannot satisfy verification -> REQUEST_CONTEXT
    assert.notEqual(reviewResult.decision, ReviewDecision.ACCEPT);
    assert.equal(reviewResult.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.equal(reviewResult.rejected_claims_count, 1);
    assert.equal(reviewResult.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
  });

  // --------------------------------------------------------------------------
  // I5 — Stale/Invalid Evidence Cannot Be Accepted
  // --------------------------------------------------------------------------
  it('I5 — Stale/Invalid Evidence Cannot Be Accepted', async () => {
    const tempDir = createTempDir();
    const targetFile = path.join(tempDir, 'state.json');
    fs.writeFileSync(targetFile, JSON.stringify({ version: '1.0.0' }));

    const hashCollector = new FileHashCollector();
    const originalHashes = await hashCollector.collectHashes(['state.json'], {
      workingDirectory: tempDir,
    });

    const collector = new EvidenceCollector();
    const initialEvidence = collector.composeEvidence({
      evidence_id: 'evi:i5:hash',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'generate_state',
      exit_code: 0,
      execution_time_ms: 50,
      working_directory: tempDir,
      file_hashes_after: originalHashes,
      evidence_type: EvidenceType.FILE_HASH,
    });

    // Mutate the file so that the original evidence becomes stale
    fs.writeFileSync(targetFile, JSON.stringify({ version: '2.0.0-tampered' }));
    const newHashes = await hashCollector.collectHashes(['state.json'], {
      workingDirectory: tempDir,
    });

    // QA Review requires the new hash; old evidence fails to satisfy
    const reviewer = new QAReviewEngine();
    const reviewResult = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-HASH',
          description: 'State file matches current hash',
          criterion_type: CriterionType.FILE_HASH,
          required_files: ['state.json'],
          file_hashes: {
            'state.json': newHashes['state.json'], // Current expected hash
          },
        },
      ],
      evidence: [initialEvidence], // Stale evidence supplied
    });

    assert.equal(reviewResult.decision, ReviewDecision.REJECT);
    assert.equal(reviewResult.criteria_results[0].status, CriterionStatus.NOT_SATISFIED);
    assert.match(reviewResult.criteria_results[0].reason, /File hash mismatch/);

    // Clean up
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // I6 — Multi-Evidence Evaluation & Order Independence
  // --------------------------------------------------------------------------
  it('I6 — Multi-Evidence Evaluation & Order Independence', async () => {
    const fakeExecutor = new FakeProcessExecutor((cmd) => ({
      command: cmd,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 100,
    }));

    const collector = new EvidenceCollector({
      processExecutor: fakeExecutor,
    });

    const evi1 = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:1:build',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm build',
      working_directory: '/workspaces/app',
      evidence_type: EvidenceType.BUILD,
    });

    const evi2 = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:2:test',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm test',
      working_directory: '/workspaces/app',
      evidence_type: EvidenceType.TEST,
    });

    const evi3 = collector.composeEvidence({
      evidence_id: 'evi:3:git',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'git diff',
      exit_code: 0,
      execution_time_ms: 25,
      working_directory: '/workspaces/app',
      evidence_type: EvidenceType.GIT,
      git_head_before: VALID_GIT_HEAD_BEFORE,
      git_head_after: VALID_GIT_HEAD_AFTER,
      unified_diff: 'diff --git a/file b/file\n+added',
    });

    const reviewer = new QAReviewEngine();
    const baseRequest: ReviewRequestInput = {
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-1',
          description: 'Build',
          criterion_type: CriterionType.BUILD,
          expected_command: 'pnpm build',
        },
        {
          criterion_id: 'AC-2',
          description: 'Test',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
        },
        {
          criterion_id: 'AC-3',
          description: 'Git diff',
          criterion_type: CriterionType.GIT,
          require_diff: true,
        },
      ],
      evidence: [evi1, evi2, evi3],
    };

    const resForward = reviewer.review(baseRequest);
    const resReverse = reviewer.review({
      ...baseRequest,
      evidence: [evi3, evi1, evi2], // Reversed order
    });

    assert.equal(resForward.decision, ReviewDecision.ACCEPT);
    assert.equal(resReverse.decision, ReviewDecision.ACCEPT);
    assert.deepEqual(resForward.criteria_results, resReverse.criteria_results);
    assert.deepEqual(resForward.evidence_ids_used, resReverse.evidence_ids_used);
  });

  // --------------------------------------------------------------------------
  // I7 — Conflicting Evidence -> CONFLICTING_EVIDENCE & REQUEST_CONTEXT
  // --------------------------------------------------------------------------
  it('I7 — Conflicting Evidence -> CONFLICTING_EVIDENCE & REQUEST_CONTEXT', async () => {
    const collector = new EvidenceCollector();

    const eviA = await collector.collectCommandEvidence({
      evidence_id: 'evi:test:pass',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm test',
      exit_code: 0,
      execution_time_ms: 200,
      working_directory: '/workspaces/OtonomMCP',
      evidence_type: EvidenceType.TEST,
    });

    const eviB = await collector.collectCommandEvidence({
      evidence_id: 'evi:test:fail',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm test',
      exit_code: 1,
      execution_time_ms: 200,
      working_directory: '/workspaces/OtonomMCP',
      evidence_type: EvidenceType.TEST,
    });

    const reviewer = new QAReviewEngine();
    const reviewResult = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-TESTS',
          description: 'Deterministic test execution',
          criterion_type: CriterionType.TEST,
          expected_command: 'pnpm test',
          expected_exit_code: 0,
        },
      ],
      evidence: [eviA, eviB],
    });

    assert.equal(reviewResult.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.equal(reviewResult.criteria_results[0].status, CriterionStatus.CONFLICTING_EVIDENCE);
    assert.deepEqual(reviewResult.criteria_results[0].conflicting_evidence, [
      'evi:test:fail',
      'evi:test:pass',
    ]);
  });

  // --------------------------------------------------------------------------
  // I8 — Collector Metadata Preservation (zero fabrication)
  // --------------------------------------------------------------------------
  it('I8 — Collector Metadata Preservation (zero fabrication)', async () => {
    const fakeExecutor = new FakeProcessExecutor((cmd) => ({
      command: cmd,
      exitCode: 0,
      stdout: 'build output line 1\nbuild output line 2',
      stderr: 'warning: experimental feature',
      durationMs: 250,
      startedAt: '2026-09-23T10:00:00.000Z',
      completedAt: '2026-09-23T10:00:00.250Z',
    }));

    const collector = new EvidenceCollector({ processExecutor: fakeExecutor });
    const evidence = await collector.executeAndCollectCommandEvidence({
      evidence_id: 'evi:meta:preservation',
      task_id: INTEGRATION_TASK_ID,
      instruction_id: 'inst:meta:1',
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm build:meta',
      working_directory: '/workspaces/aidm',
      evidence_type: EvidenceType.BUILD,
      metadata: { author: 'aidm-core' },
    });

    // Verify all original fields are preserved without distortion
    assert.equal(evidence.evidence_id, 'evi:meta:preservation');
    assert.equal(evidence.task_id, INTEGRATION_TASK_ID);
    assert.equal(evidence.instruction_id, 'inst:meta:1');
    assert.equal(evidence.project_id, INTEGRATION_PROJECT_ID);
    assert.equal(evidence.correlation_id, INTEGRATION_CORRELATION_ID);
    assert.equal(evidence.command, 'pnpm build:meta');
    assert.equal(evidence.working_directory, '/workspaces/aidm');
    assert.equal(evidence.exit_code, 0);
    assert.equal(evidence.stdout_tail, 'build output line 1\nbuild output line 2');
    assert.equal(evidence.stderr, 'warning: experimental feature');
    assert.equal(evidence.execution_time_ms, 250);
    assert.equal(evidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
    assert.deepEqual(evidence.metadata, { author: 'aidm-core' });

    // ReviewEngine consumes this evidence and reflects the exact evidence ID
    const reviewer = new QAReviewEngine();
    const res = reviewer.review({
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-META',
          description: 'Meta preservation',
          expected_command: 'pnpm build:meta',
        },
      ],
      evidence: [evidence],
    });

    assert.equal(res.decision, ReviewDecision.ACCEPT);
    assert.deepEqual(res.evidence_ids_used, ['evi:meta:preservation']);
  });

  // --------------------------------------------------------------------------
  // I9 — Deterministic Integration (5x repeated execution)
  // --------------------------------------------------------------------------
  it('I9 — Deterministic Integration (5x repeated execution)', async () => {
    const collector = new EvidenceCollector();
    const evidence = await collector.collectCommandEvidence({
      evidence_id: 'evi:det:1',
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      command: 'pnpm test',
      exit_code: 0,
      execution_time_ms: 150,
      working_directory: '/workspaces/OtonomMCP',
      evidence_type: EvidenceType.TEST,
    });

    const reviewer = new QAReviewEngine();
    const request: ReviewRequestInput = {
      task_id: INTEGRATION_TASK_ID,
      project_id: INTEGRATION_PROJECT_ID,
      correlation_id: INTEGRATION_CORRELATION_ID,
      attempt: 1,
      max_attempts: 3,
      acceptance_criteria: [
        {
          criterion_id: 'AC-DET',
          description: 'Deterministic run',
          expected_command: 'pnpm test',
        },
      ],
      evidence: [evidence],
    };

    const firstRun = reviewer.review(request);

    for (let i = 0; i < 5; i++) {
      const run = reviewer.review(request);
      assert.deepEqual(run, firstRun);
      assert.equal(JSON.stringify(run), JSON.stringify(firstRun));
    }
  });

  // --------------------------------------------------------------------------
  // I10 — Regression across all phases
  // --------------------------------------------------------------------------
  it('I10 — Regression across all phases (Phase 1, 2, 3, P4-01, P4-02, P4-03)', () => {
    // Phase 1 regression
    assert.equal(typeof RecoveryEngine, 'function');
    assert.equal(typeof StateMachine, 'function');
    assert.equal(typeof L0Indexer, 'function');

    // Phase 2 regression
    assert.equal(typeof TaskDagEngine, 'function');
    assert.equal(typeof ContextEngine, 'function');
    assert.equal(typeof TokenBudgetEngine, 'function');

    // Phase 3 regression
    assert.equal(typeof AntigravityAdapter, 'function');
    assert.equal(typeof ReferenceLlmAdapter, 'function');

    // P4-01 regression
    assert.equal(typeof validateSystemVerifiedEvidence, 'function');
    assert.equal(typeof assertValidSystemVerifiedEvidence, 'function');

    // P4-02 regression
    assert.equal(typeof EvidenceCollector, 'function');
    assert.equal(typeof FakeProcessExecutor, 'function');
    assert.equal(typeof FileHashCollector, 'function');

    // P4-03 regression
    assert.equal(typeof QAReviewEngine, 'function');
  });
});
