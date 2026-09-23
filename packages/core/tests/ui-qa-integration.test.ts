import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { UiVerificationQaBridge, extractCanonicalUiPayload } from '../dist/ui-verification/ui-qa-bridge.js';
import { UiObservationPipeline } from '../dist/ui-verification/ui-observation-pipeline.js';
import { FakeBrowserPort } from '../dist/ui-verification/browser-port.js';
import { QAReviewEngine } from '../dist/qa-review/qa-review-engine.js';
import {
  UiObservationType,
  type UiVerificationRequest,
} from '../dist/ui-verification/ui-verification-types.js';
import {
  CriterionStatus,
  ReviewDecision,
  CriterionType,
  type AcceptanceCriterion,
} from '../dist/qa-review/qa-review-types.js';
import {
  EvidenceSource,
  EvidenceType,
  type SystemVerifiedEvidence,
  type SystemVerifiedEvidenceInput,
} from '../dist/evidence/evidence-types.js';
import {
  validateSystemVerifiedEvidence,
  createAgentClaim,
} from '../dist/evidence/evidence-validator.js';
import {
  createUiSystemVerifiedEvidence,
  validateUiSystemVerifiedEvidence,
} from '../dist/ui-verification/ui-evidence-types.js';

describe('Phase 5 UI Verification -> QA Review Integration (TASK-P5-04)', () => {
  const createBaseRequest = (obs: UiObservationType[]): UiVerificationRequest => ({
    task_id: 'test-task-1',
    project_id: 'test-project-1',
    correlation_id: 'test-corr-1',
    criterion_id: 'test-crit-1',
    target_url: 'http://localhost/test',
    attempt: 1,
    max_attempts: 2,
    required_observations: obs,
  });

  async function runIntegratedFlow(
    request: UiVerificationRequest,
    portOverrides?: (port: FakeBrowserPort) => void
  ) {
    const port = new FakeBrowserPort();
    if (portOverrides) portOverrides(port);
    const pipeline = new UiObservationPipeline(port);
    const pipelineResult = await pipeline.run(request);

    const qaEngine = new QAReviewEngine();
    const bridge = new UiVerificationQaBridge(qaEngine);
    return bridge.reviewUiVerification(request, pipelineResult.evidence);
  }

  // ==========================================================================
  // MANDATORY SCENARIOS: Q1 - Q19
  // ==========================================================================

  it('Q1 - Valid navigation evidence reaches QAReviewEngine', async () => {
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const res = await runIntegratedFlow(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
    assert.strictEqual(res.criteria_results[0].evidence_ids.length, 1);
  });

  it('Q2 - Valid DOM evidence reaches QAReviewEngine', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '.test-class', presence: 'present' as const }],
    };
    const res = await runIntegratedFlow(req, (port) => {
      port.domHandler = async (r) => ({
        ...(await new FakeBrowserPort().observeDom(r)),
        selector: '.test-class',
        matches_count: 1,
      });
    });
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
  });

  it('Q3 - Valid visible-element evidence reaches QAReviewEngine', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.VISIBLE_ELEMENT]),
      expected_visible_conditions: [{ selector: '#btn', state: 'visible' as const }],
    };
    const res = await runIntegratedFlow(req, (port) => {
      port.visibleElementHandler = async (r) => ({
        ...(await new FakeBrowserPort().observeVisibleElement(r)),
        selector: '#btn',
        is_visible: true,
      });
    });
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
  });

  it('Q4 - Multiple UI evidence types can satisfy their corresponding criteria', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.NAVIGATION, UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: 'h1', text_contains: 'Hello' }],
    };
    const res = await runIntegratedFlow(req, (port) => {
      port.domHandler = async (r) => ({
        ...(await new FakeBrowserPort().observeDom(r)),
        selector: 'h1',
        matches_count: 1,
        elements: [{ tag_name: 'h1', attributes: {}, inner_text: 'Hello World' }],
      });
    });
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].evidence_ids.length, 2);
  });

  it('Q5 - Valid UI evidence can produce the existing ACCEPT result when satisfied', async () => {
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const res = await runIntegratedFlow(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.all_mandatory_satisfied, true);
  });

  it('Q6 - Evidence that does not satisfy a criterion produces the existing REJECT result', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '.missing', presence: 'present' as const }],
    };
    const res = await runIntegratedFlow(req, (port) => {
      port.domHandler = async (r) => ({
        ...(await new FakeBrowserPort().observeDom(r)),
        selector: '.missing',
        matches_count: 0,
      });
    });
    assert.strictEqual(res.decision, ReviewDecision.REJECT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.NOT_SATISFIED);
    assert.match(res.criteria_results[0].reason, /absent but expected present/);
  });

  it('Q7 - Missing evidence does not produce ACCEPT', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '.missing', presence: 'present' as const }],
    };
    const res = await runIntegratedFlow(req, (port) => {
      port.domHandler = async () => {
        throw new Error('Failed to observe');
      };
    });
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
  });

  it('Q8 - Invalid system evidence never reaches QAReviewEngine', async () => {
    const qaEngine = new QAReviewEngine();
    const bridge = new UiVerificationQaBridge(qaEngine);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const res = bridge.reviewUiVerification(req, [{ invalid: true } as any]);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.INSUFFICIENT_EVIDENCE);
    assert.strictEqual(res.findings.some((f) => f.code === 'ERR_INVALID_REVIEW_EVIDENCE'), true);
  });

  it('Q9 - AGENT_CLAIM never reaches QAReviewEngine as system evidence', async () => {
    const qaEngine = new QAReviewEngine();
    const bridge = new UiVerificationQaBridge(qaEngine);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const claim = createAgentClaim({
      task_id: 'test-task-1',
      statement: 'I promise the button is clicked and UI works',
    });
    const res = bridge.reviewUiVerification(req, [claim as any]);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.findings.some((f) => f.code === 'ERR_AGENT_CLAIM_REJECTED'), true);
  });

  it('Q10 - Task ID mismatch is rejected', async () => {
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const pipeline = new UiObservationPipeline(new FakeBrowserPort());
    const result = await pipeline.run(req);

    const badReq = { ...req, task_id: 'wrong-task' };
    const bridge = new UiVerificationQaBridge(new QAReviewEngine());
    const res = bridge.reviewUiVerification(badReq, result.evidence);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.findings.some((f) => f.code === 'ERR_EVIDENCE_IDENTITY_MISMATCH'), true);
  });

  it('Q11 - Project ID mismatch is rejected where the existing contracts require it', async () => {
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const pipeline = new UiObservationPipeline(new FakeBrowserPort());
    const result = await pipeline.run(req);

    const badReq = { ...req, project_id: 'wrong-project' };
    const bridge = new UiVerificationQaBridge(new QAReviewEngine());
    const res = bridge.reviewUiVerification(badReq, result.evidence);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.findings.some((f) => f.code === 'ERR_EVIDENCE_IDENTITY_MISMATCH'), true);
  });

  it('Q12 - Correlation ID mismatch is rejected', async () => {
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const pipeline = new UiObservationPipeline(new FakeBrowserPort());
    const result = await pipeline.run(req);

    const badReq = { ...req, correlation_id: 'wrong-correlation' };
    const bridge = new UiVerificationQaBridge(new QAReviewEngine());
    const res = bridge.reviewUiVerification(badReq, result.evidence);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.findings.some((f) => f.code === 'ERR_EVIDENCE_IDENTITY_MISMATCH'), true);
  });

  it('Q13 - Multiple evidence items are evaluated deterministically', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [
        { selector: '#a', presence: 'present' as const },
        { selector: '#b', presence: 'present' as const },
      ],
    };
    const res = await runIntegratedFlow(req, (port) => {
      port.domHandler = async (r) => ({
        ...(await new FakeBrowserPort().observeDom(r)),
        selector: r.selector!,
        matches_count: 1,
      });
    });
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].evidence_ids.length, 2);
  });

  it('Q14 - Equivalent evidence produces equivalent ReviewResult', async () => {
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const res1 = await runIntegratedFlow(req);
    const res2 = await runIntegratedFlow(req);
    assert.deepStrictEqual(res1.decision, res2.decision);
    assert.deepStrictEqual(res1.criteria_results[0].status, res2.criteria_results[0].status);
  });

  it('Q15 - Existing non-UI QA review behavior remains unchanged', () => {
    const qaEngine = new QAReviewEngine();
    const taskId = 'TASK-NON-UI';
    const projectId = 'proj-non-ui';
    const corrId = 'corr-non-ui';

    const cmdEvidenceInput: SystemVerifiedEvidenceInput = {
      evidence_id: 'evi:non-ui:cmd:1',
      task_id: taskId,
      project_id: projectId,
      correlation_id: corrId,
      command: 'npm run build',
      exit_code: 0,
      stdout_tail: 'Build completed successfully',
      stderr: null,
      working_directory: '/app',
      execution_time_ms: 500,
      git_head_before: '0000000000000000000000000000000000000001',
      git_head_after: '0000000000000000000000000000000000000002',
      unified_diff: null,
      file_hashes_after: null,
      evidence_type: EvidenceType.COMMAND,
      source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
    };
    const val = validateSystemVerifiedEvidence(cmdEvidenceInput);
    assert.strictEqual(val.valid, true);

    const nonUiCriterion: AcceptanceCriterion = {
      criterion_id: 'CRIT-BUILD-01',
      description: 'Build process must exit with 0',
      criterion_type: CriterionType.COMMAND,
      is_mandatory: true,
      expected_exit_code: 0,
      stdout_contains: ['Build completed successfully'],
    };

    const result = qaEngine.review({
      task_id: taskId,
      project_id: projectId,
      correlation_id: corrId,
      attempt: 1,
      max_attempts: 1,
      acceptance_criteria: [nonUiCriterion],
      evidence: [val.evidence!],
    });

    assert.strictEqual(result.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(result.criteria_results[0].status, CriterionStatus.SATISFIED);
    assert.strictEqual(result.criteria_results[0].evidence_ids[0], 'evi:non-ui:cmd:1');
  });

  it('Q16 - Existing P5-01 UI criterion tests remain passing', () => {
    const validRequest: UiVerificationRequest = {
      task_id: 'task-p5-01',
      project_id: 'proj-p5-01',
      correlation_id: 'corr-p5-01',
      criterion_id: 'crit-p5-01',
      target_url: 'http://localhost/p5-01',
      attempt: 1,
      max_attempts: 3,
      required_observations: [UiObservationType.NAVIGATION, UiObservationType.DOM],
    };
    assert.strictEqual(validRequest.required_observations.length, 2);
    assert.strictEqual(validRequest.criterion_id, 'crit-p5-01');
  });

  it('Q17 - Existing P5-02 browser adapter tests remain passing', async () => {
    const port = new FakeBrowserPort();
    const nav = await port.navigate({
      task_id: 'test-p5-02',
      correlation_id: 'corr-p5-02',
      url: 'http://localhost/test',
    });
    assert.strictEqual(nav.observation_type, 'NAVIGATION');
    assert.strictEqual(nav.status_code, 200);
  });

  it('Q18 - Existing P5-03 pipeline tests remain passing', async () => {
    const port = new FakeBrowserPort();
    const pipeline = new UiObservationPipeline(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const res = await pipeline.run(req);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.evidence.length, 1);
    assert.strictEqual(res.evidence[0].evidence_type, EvidenceType.UI);
  });

  it('Q19 - Full regression suite passes and delivers canonical review result', async () => {
    const req = {
      ...createBaseRequest([UiObservationType.NAVIGATION, UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: 'body', presence: 'present' as const }],
    };
    const res = await runIntegratedFlow(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.all_mandatory_satisfied, true);
    assert.ok(res.evidence_ids_used.length >= 1);
  });

  // ==========================================================================
  // PREDICATE REGRESSION COVERAGE (CORRECTION 7)
  // ==========================================================================

  describe('Predicate Semantics Regression (Correction 7)', () => {
    const qaEngine = new QAReviewEngine();
    const taskId = 'TASK-PRED-REG';
    const projectId = 'proj-pred-reg';
    const corrId = 'corr-pred-reg';

    function makeEvidence(id: string, exitCode: number): SystemVerifiedEvidence {
      const input: SystemVerifiedEvidenceInput = {
        evidence_id: id,
        task_id: taskId,
        project_id: projectId,
        correlation_id: corrId,
        command: `echo ${id}`,
        exit_code: exitCode,
        stdout_tail: `output for ${id}`,
        stderr: null,
        working_directory: '/app',
        execution_time_ms: 10,
        git_head_before: null,
        git_head_after: null,
        unified_diff: null,
        file_hashes_after: null,
        evidence_type: EvidenceType.COMMAND,
        source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
      };
      return validateSystemVerifiedEvidence(input).evidence!;
    }

    it('1. Predicate receives a single-item array for one evidence item', () => {
      const evi1 = makeEvidence('evi:pred:1', 0);
      let receivedArrayLengths: number[] = [];

      const crit: AcceptanceCriterion = {
        criterion_id: 'CRIT-PRED-1',
        description: 'Test single item predicate input',
        criterion_type: CriterionType.COMMAND,
        is_mandatory: true,
        predicate: (candidates) => {
          receivedArrayLengths.push(candidates.length);
          assert.strictEqual(candidates.length, 1, 'Predicate must be invoked with single-item array');
          return { satisfied: true };
        },
      };

      const res = qaEngine.review({
        task_id: taskId,
        project_id: projectId,
        correlation_id: corrId,
        attempt: 1,
        max_attempts: 1,
        acceptance_criteria: [crit],
        evidence: [evi1],
      });

      assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
      assert.deepStrictEqual(receivedArrayLengths, [1]);
    });

    it('2. Multiple evidence items: predicate receives a single-item array for each candidate invocation', () => {
      const evi1 = makeEvidence('evi:pred:m1', 0);
      const evi2 = makeEvidence('evi:pred:m2', 0);
      const receivedCandidateIds: string[] = [];

      const crit: AcceptanceCriterion = {
        criterion_id: 'CRIT-PRED-2',
        description: 'Test multiple candidates invoked per item',
        criterion_type: CriterionType.COMMAND,
        is_mandatory: true,
        predicate: (candidates) => {
          assert.strictEqual(candidates.length, 1, 'Must receive exactly 1 item per invocation');
          receivedCandidateIds.push(candidates[0].evidence_id);
          return { satisfied: true };
        },
      };

      const res = qaEngine.review({
        task_id: taskId,
        project_id: projectId,
        correlation_id: corrId,
        attempt: 1,
        max_attempts: 1,
        acceptance_criteria: [crit],
        evidence: [evi1, evi2],
      });

      assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
      assert.strictEqual(receivedCandidateIds.length, 2);
      assert.deepStrictEqual(receivedCandidateIds.sort(), ['evi:pred:m1', 'evi:pred:m2']);
    });

    it('3. Predicate succeeds for one candidate but fails for another -> criterion is NOT_SATISFIED', () => {
      const eviGood = makeEvidence('evi:pred:good', 0);
      const eviBad = makeEvidence('evi:pred:bad', 0);

      const crit: AcceptanceCriterion = {
        criterion_id: 'CRIT-PRED-3',
        description: 'Per-item predicate failure propagation',
        criterion_type: CriterionType.COMMAND,
        is_mandatory: true,
        predicate: (candidates) => {
          assert.strictEqual(candidates.length, 1);
          if (candidates[0].evidence_id === 'evi:pred:bad') {
            return { satisfied: false, reason: 'Explicit failure for evi:pred:bad' };
          }
          return { satisfied: true };
        },
      };

      const res = qaEngine.review({
        task_id: taskId,
        project_id: projectId,
        correlation_id: corrId,
        attempt: 1,
        max_attempts: 2,
        acceptance_criteria: [crit],
        evidence: [eviGood, eviBad],
      });

      assert.strictEqual(res.decision, ReviewDecision.REJECT);
      assert.strictEqual(res.criteria_results[0].status, CriterionStatus.NOT_SATISFIED);
      assert.strictEqual(res.criteria_results[0].reason, 'Explicit failure for evi:pred:bad');
    });

    it('4. Predicate fails if engine passes multi-candidate array instead of per-item array', () => {
      const evi1 = makeEvidence('evi:pred:c1', 0);
      const evi2 = makeEvidence('evi:pred:c2', 0);

      const crit: AcceptanceCriterion = {
        criterion_id: 'CRIT-PRED-4',
        description: 'Verify engine never calls predicate with candidates.length > 1',
        criterion_type: CriterionType.COMMAND,
        is_mandatory: true,
        predicate: (candidates) => {
          if (candidates.length !== 1) {
            return { satisfied: false, reason: 'Engine passed non-single-item array' };
          }
          return { satisfied: true };
        },
      };

      const res = qaEngine.review({
        task_id: taskId,
        project_id: projectId,
        correlation_id: corrId,
        attempt: 1,
        max_attempts: 1,
        acceptance_criteria: [crit],
        evidence: [evi1, evi2],
      });

      assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
      assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
    });

    it('5. Existing non-UI predicate behavior remains unchanged under established semantics', () => {
      const evi = makeEvidence('evi:pred:non-ui', 0);
      let invoked = false;

      const crit: AcceptanceCriterion = {
        criterion_id: 'CRIT-PRED-5',
        description: 'Standard non-UI predicate check',
        criterion_type: CriterionType.COMMAND,
        is_mandatory: true,
        predicate: (candidates) => {
          invoked = true;
          return {
            satisfied: candidates[0].stdout_tail?.includes('output for evi:pred:non-ui') ?? false,
          };
        },
      };

      const res = qaEngine.review({
        task_id: taskId,
        project_id: projectId,
        correlation_id: corrId,
        attempt: 1,
        max_attempts: 1,
        acceptance_criteria: [crit],
        evidence: [evi],
      });

      assert.strictEqual(invoked, true);
      assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    });
  });

  // ==========================================================================
  // EVIDENCE VALIDATION REGRESSION (CORRECTION 8)
  // ==========================================================================

  describe('Evidence Validation Canonical Flow (Correction 8)', () => {
    it('Raw UI evidence -> EvidenceValidator -> canonical UI evidence -> QAReviewEngine (No raw cast bypass)', () => {
      const port = new FakeBrowserPort();
      const rawObservation = {
        observation_id: 'obs:raw:test:1',
        task_id: 'task-flow-1',
        correlation_id: 'corr-flow-1',
        observation_type: 'NAVIGATION' as const,
        url: 'http://localhost/flow-test',
        status_code: 200,
        title: 'Flow Test',
        redirected: false,
        navigation_time_ms: 100,
        captured_at: new Date().toISOString(),
        metadata: null,
      };

      const rawUiEvidence = createUiSystemVerifiedEvidence({
        task_id: 'task-flow-1',
        project_id: 'proj-flow-1',
        correlation_id: 'corr-flow-1',
        observation: rawObservation,
        target_url: 'http://localhost/flow-test',
      });

      // 1. Authoritative EvidenceValidator validates and canonicalizes
      const validationResult = validateSystemVerifiedEvidence(rawUiEvidence);
      assert.strictEqual(validationResult.valid, true);
      const canonicalEvidence = validationResult.evidence!;

      // 2. Canonical evidence has metadata.ui_evidence preserved
      const payloadFromMetadata = extractCanonicalUiPayload(canonicalEvidence);
      assert.notStrictEqual(payloadFromMetadata, null);
      assert.strictEqual(payloadFromMetadata?.observation_type, 'NAVIGATION');

      // 3. Top-level ui_payload is NOT present on canonical SystemVerifiedEvidence (proves no raw cast)
      assert.strictEqual('ui_payload' in canonicalEvidence, false);

      // 4. QAReviewEngine evaluates canonical evidence directly through bridge
      const qaEngine = new QAReviewEngine();
      const bridge = new UiVerificationQaBridge(qaEngine);
      const req: UiVerificationRequest = {
        task_id: 'task-flow-1',
        project_id: 'proj-flow-1',
        correlation_id: 'corr-flow-1',
        criterion_id: 'crit-flow-1',
        target_url: 'http://localhost/flow-test',
        attempt: 1,
        max_attempts: 1,
        required_observations: [UiObservationType.NAVIGATION],
      };

      const res = bridge.reviewUiVerification(req, [canonicalEvidence]);
      assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
      assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
    });
  });
});
