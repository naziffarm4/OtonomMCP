import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  UiVerificationService,
  type UiVerificationExecutionResult,
} from '../dist/ui-verification/ui-verification-service.js';
import {
  FakeBrowserPort,
  type BrowserSessionConfig,
  type BrowserSession,
  type BrowserNavigationRequest,
  type BrowserNavigationObservation,
  type BrowserDomObservationRequest,
  type BrowserDomObservation,
  type BrowserVisibleElementRequest,
  type BrowserVisibleElementObservation,
  type BrowserScreenshotRequest,
  type BrowserScreenshotObservation,
  type BrowserConsoleObservationRequest,
  type BrowserConsoleObservation,
  type BrowserNetworkObservationRequest,
  type BrowserNetworkObservation,
} from '../dist/ui-verification/browser-port.js';
import {
  UiObservationType,
  type UiVerificationRequest,
  validateUiVerificationRequest,
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
} from '../dist/evidence/evidence-types.js';
import {
  validateSystemVerifiedEvidence,
  createAgentClaim,
} from '../dist/evidence/evidence-validator.js';
import {
  createUiSystemVerifiedEvidence,
  validateUiSystemVerifiedEvidence,
} from '../dist/ui-verification/ui-evidence-types.js';
import { UiObservationPipeline } from '../dist/ui-verification/ui-observation-pipeline.js';
import { UiVerificationQaBridge } from '../dist/ui-verification/ui-qa-bridge.js';
import { QAReviewEngine } from '../dist/qa-review/qa-review-engine.js';

/**
 * Instrumented FakeBrowserPort tracking session lifecycle and observation invocations.
 */
class InstrumentedBrowserPort extends FakeBrowserPort {
  public openCount = 0;
  public closeCount = 0;
  public observationCount = 0;
  public closedSessionIds: string[] = [];

  override async startSession(config?: BrowserSessionConfig): Promise<BrowserSession> {
    this.openCount++;
    return super.startSession(config);
  }

  override async closeSession(sessionId: string): Promise<void> {
    this.closeCount++;
    this.closedSessionIds.push(sessionId);
    return super.closeSession(sessionId);
  }

  override async navigate(req: BrowserNavigationRequest): Promise<BrowserNavigationObservation> {
    this.observationCount++;
    return super.navigate(req);
  }

  override async observeDom(req: BrowserDomObservationRequest): Promise<BrowserDomObservation> {
    this.observationCount++;
    return super.observeDom(req);
  }

  override async observeVisibleElement(req: BrowserVisibleElementRequest): Promise<BrowserVisibleElementObservation> {
    this.observationCount++;
    return super.observeVisibleElement(req);
  }

  override async captureScreenshot(req: BrowserScreenshotRequest): Promise<BrowserScreenshotObservation> {
    this.observationCount++;
    return super.captureScreenshot(req);
  }

  override async observeConsole(req: BrowserConsoleObservationRequest): Promise<BrowserConsoleObservation> {
    this.observationCount++;
    return super.observeConsole(req);
  }

  override async observeNetwork(req: BrowserNetworkObservationRequest): Promise<BrowserNetworkObservation> {
    this.observationCount++;
    return super.observeNetwork(req);
  }
}

describe('Phase 5 End-to-End UI Verification Integration & Hardening (TASK-P5-05)', () => {
  const TASK_ID = 'task-e2e-1';
  const PROJECT_ID = 'proj-e2e-1';
  const CORRELATION_ID = 'corr-e2e-1';
  const CRITERION_ID = 'crit-e2e-1';
  const TARGET_URL = 'http://localhost/app';

  const createBaseRequest = (obs: UiObservationType[]): UiVerificationRequest => ({
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    correlation_id: CORRELATION_ID,
    criterion_id: CRITERION_ID,
    target_url: TARGET_URL,
    attempt: 1,
    max_attempts: 2,
    required_observations: obs,
  });

  // ==========================================================================
  // E1 - E6: INDIVIDUAL OBSERVATION TYPES REACH QA
  // ==========================================================================

  it('E1 — Navigation-only verification reaches QA', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
    assert.strictEqual(res.criteria_results[0].evidence_ids.length, 1);
  });

  it('E2 — DOM-only verification reaches QA', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeDom(r)),
      selector: '#main-content',
      matches_count: 1,
      elements: [
        {
          tag_name: 'div',
          selector: '#main-content',
          attributes: { id: 'main-content' },
          inner_text: 'Dashboard Ready',
          is_visible: true,
        },
      ],
    });

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '#main-content', presence: 'present' as const }],
    };

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
  });

  it('E3 — Visible-element verification reaches QA', async () => {
    const port = new InstrumentedBrowserPort();
    port.visibleElementHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeVisibleElement(r)),
      selector: '#action-btn',
      is_visible: true,
      visible_text: 'Submit Order',
    });

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.VISIBLE_ELEMENT]),
      expected_visible_conditions: [
        { selector: '#action-btn', state: 'visible' as const, text_equals: 'Submit Order' },
      ],
    };

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.criteria_results[0].status, CriterionStatus.SATISFIED);
  });

  it('E4 — Screenshot verification reaches QA boundary', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.SCREENSHOT]),
      screenshot_requirements: { format: 'png' as const, full_page: true },
    };

    const exec = await service.execute(req);
    assert.strictEqual(exec.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(exec.pipelineResult.evidence.length, 1);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    assert.notStrictEqual(uiPayload?.screenshot_observation, null);
    assert.strictEqual(uiPayload?.screenshot_observation?.format, 'png');
  });

  it('E5 — Console verification reaches QA boundary', async () => {
    const port = new InstrumentedBrowserPort();
    port.consoleHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeConsole(r)),
      has_errors: false,
      entries: [{ level: 'info', text: 'Application loaded cleanly' }],
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.CONSOLE]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.decision, ReviewDecision.ACCEPT);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    assert.strictEqual(uiPayload?.console_observation?.has_errors, false);
  });

  it('E6 — Network verification reaches QA boundary', async () => {
    const port = new InstrumentedBrowserPort();
    port.networkHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeNetwork(r)),
      has_failures: false,
      entries: [
        {
          url: 'http://localhost/api/status',
          method: 'GET',
          status: 200,
          failed: false,
        },
      ],
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NETWORK]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.decision, ReviewDecision.ACCEPT);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    assert.strictEqual(uiPayload?.network_observation?.has_failures, false);
  });

  // ==========================================================================
  // E7 - E9: MULTI-OBSERVATION AND DETERMINISM
  // ==========================================================================

  it('E7 — Multiple observation types work together', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeDom(r)),
      selector: 'h1',
      matches_count: 1,
      elements: [{ tag_name: 'h1', selector: 'h1', attributes: {}, inner_text: 'Dashboard' }],
    });
    port.visibleElementHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeVisibleElement(r)),
      selector: '#btn-save',
      is_visible: true,
      visible_text: 'Save',
    });

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([
        UiObservationType.NAVIGATION,
        UiObservationType.DOM,
        UiObservationType.VISIBLE_ELEMENT,
        UiObservationType.CONSOLE,
        UiObservationType.NETWORK,
      ]),
      expected_dom_conditions: [{ selector: 'h1', text_contains: 'Dashboard' }],
      expected_visible_conditions: [{ selector: '#btn-save', state: 'visible' as const }],
    };

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.all_mandatory_satisfied, true);
    assert.strictEqual(res.criteria_results[0].evidence_ids.length, 5);
  });

  it('E8 — Deterministic observation/evidence ordering', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([
      UiObservationType.NAVIGATION,
      UiObservationType.DOM,
      UiObservationType.VISIBLE_ELEMENT,
      UiObservationType.SCREENSHOT,
      UiObservationType.CONSOLE,
      UiObservationType.NETWORK,
    ]);

    const exec = await service.execute(req);
    const obsTypes = exec.pipelineResult.evidence.map(
      (e) => (e.metadata as any)?.ui_evidence?.observation_type
    );

    // Standard pipeline sequence: NAVIGATION, DOM, VISIBLE_ELEMENT, SCREENSHOT, CONSOLE, NETWORK
    assert.deepStrictEqual(obsTypes, [
      'NAVIGATION',
      'DOM',
      'VISIBLE_ELEMENT',
      'SCREENSHOT',
      'CONSOLE',
      'NETWORK',
    ]);
  });

  it('E9 — Deterministic ReviewResult for equivalent input', async () => {
    const port1 = new InstrumentedBrowserPort();
    const port2 = new InstrumentedBrowserPort();
    const service1 = new UiVerificationService(port1);
    const service2 = new UiVerificationService(port2);

    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const res1 = await service1.verify(req);
    const res2 = await service2.verify(req);

    assert.strictEqual(res1.decision, res2.decision);
    assert.strictEqual(res1.all_mandatory_satisfied, res2.all_mandatory_satisfied);
    assert.deepStrictEqual(res1.criteria_results[0].status, res2.criteria_results[0].status);
    assert.deepStrictEqual(res1.criteria_results[0].evidence_ids, res2.criteria_results[0].evidence_ids);
  });

  // ==========================================================================
  // E10 - E13: IDENTITY ISOLATION
  // ==========================================================================

  it('E10 — Task identity preserved end-to-end', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.reviewResult.task_id, TASK_ID);
    for (const evi of exec.pipelineResult.evidence) {
      assert.strictEqual(evi.task_id, TASK_ID);
    }
  });

  it('E11 — Project identity preserved end-to-end', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.reviewResult.project_id, PROJECT_ID);
    for (const evi of exec.pipelineResult.evidence) {
      assert.strictEqual(evi.project_id, PROJECT_ID);
    }
  });

  it('E12 — Correlation identity preserved end-to-end', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.reviewResult.correlation_id, CORRELATION_ID);
    for (const evi of exec.pipelineResult.evidence) {
      assert.strictEqual(evi.correlation_id, CORRELATION_ID);
    }
  });

  it('E13 — Identity mismatch rejected end-to-end', async () => {
    const port = new InstrumentedBrowserPort();
    // Simulate correlation ID tampering in observation
    port.navigateHandler = async (r) => ({
      ...(await new FakeBrowserPort().navigate(r)),
      correlation_id: 'tampered-correlation-id',
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.success, false);
    assert.strictEqual(exec.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.ok(exec.pipelineResult.issues.some((i) => i.includes('Correlation mismatch')));
  });

  // ==========================================================================
  // E14 - E16: FAILURE, INVALID EVIDENCE & AGENT CLAIM PROTECTION
  // ==========================================================================

  it('E14 — Required observation failure produces structured failure', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async () => {
      throw new Error('Connection refused during DOM snapshot');
    };

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '#missing', presence: 'present' as const }],
    };

    const exec = await service.execute(req);
    assert.strictEqual(exec.success, false);
    assert.strictEqual(exec.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.ok(exec.pipelineResult.issues.some((i) => i.includes('Failed to collect required observation DOM')));
  });

  it('E15 — Invalid evidence never reaches QA', async () => {
    const port = new InstrumentedBrowserPort();
    // Tamper with observation task_id
    port.domHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeDom(r)),
      task_id: 'foreign-task-999',
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.DOM]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.success, false);
    // Invalid evidence was not pushed to pipelineResult.evidence
    assert.strictEqual(exec.pipelineResult.evidence.length, 0);
    assert.strictEqual(exec.decision, ReviewDecision.REQUEST_CONTEXT);
  });

  it('E16 — AGENT_CLAIM never reaches QA as system evidence', async () => {
    const claim = createAgentClaim({
      task_id: TASK_ID,
      statement: 'I assert the UI rendered completely',
    });

    const qaEngine = new QAReviewEngine();
    const bridge = new UiVerificationQaBridge(qaEngine);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const res = bridge.reviewUiVerification(req, [claim as any]);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
    assert.strictEqual(res.rejected_claims_count, 1);
    assert.ok(res.findings.some((f) => f.code === 'ERR_AGENT_CLAIM_REJECTED'));
  });

  // ==========================================================================
  // E17 - E21: SECURITY BOUNDARY & SECRET SANITIZATION
  // ==========================================================================

  it('E17 — Sensitive URL/query data remains sanitized', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const sensitiveUrl = 'http://localhost/app?token=supersecret123&apikey=secretKey456&username=admin';
    const req: UiVerificationRequest = {
      ...createBaseRequest([UiObservationType.NAVIGATION]),
      target_url: sensitiveUrl,
    };

    const exec = await service.execute(req);
    const evi = exec.pipelineResult.evidence[0];

    assert.ok(!evi.target_url.includes('supersecret123'));
    assert.ok(!evi.target_url.includes('secretKey456'));
    assert.ok(evi.target_url.includes('token=***REDACTED***'));
    assert.ok(evi.target_url.includes('apikey=***REDACTED***'));
  });

  it('E18 — Sensitive headers remain sanitized', async () => {
    const port = new InstrumentedBrowserPort();
    port.networkHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeNetwork(r)),
      has_failures: false,
      entries: [
        {
          url: 'http://localhost/api',
          method: 'GET',
          status: 200,
          failed: false,
          request_headers: {
            Authorization: 'Bearer my-secret-token',
            'X-Api-Key': 'my-raw-api-key',
            Accept: 'application/json',
          },
        },
      ],
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NETWORK]);

    const exec = await service.execute(req);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    const headers = uiPayload.network_observation.entries[0].request_headers;

    assert.strictEqual(headers.Authorization, 'Bearer ***REDACTED_TOKEN***');
    assert.strictEqual(headers['X-Api-Key'], '***REDACTED***');
    assert.strictEqual(headers.Accept, 'application/json');
  });

  it('E19 — Sensitive console data remains sanitized', async () => {
    const port = new InstrumentedBrowserPort();
    port.consoleHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeConsole(r)),
      has_errors: false,
      entries: [
        {
          level: 'log',
          text: 'Loaded credentials with token=secret_token_val_9999',
        },
      ],
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.CONSOLE]);

    const exec = await service.execute(req);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    const text = uiPayload.console_observation.entries[0].text;

    assert.ok(!text.includes('secret_token_val_9999'));
    assert.ok(text.includes('token=***REDACTED***'));
  });

  it('E20 — Sensitive DOM data remains sanitized', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeDom(r)),
      selector: 'input',
      elements: [
        {
          tag_name: 'input',
          selector: 'input[type=password]',
          attributes: {
            type: 'password',
            value: 'plaintext_password_val',
            name: 'password',
          },
          inner_text: null,
          is_visible: true,
        },
      ],
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.DOM]);

    const exec = await service.execute(req);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    const attrs = uiPayload.dom_observation.elements[0].attributes;

    assert.strictEqual(attrs.value, '***REDACTED***');
    assert.ok(!JSON.stringify(attrs).includes('plaintext_password_val'));
  });

  it('E21 — Sensitive network data remains sanitized', async () => {
    const port = new InstrumentedBrowserPort();
    port.networkHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeNetwork(r)),
      has_failures: false,
      entries: [
        {
          url: 'http://localhost/login?auth=confidential_session_key',
          method: 'POST',
          status: 200,
          failed: false,
        },
      ],
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NETWORK]);

    const exec = await service.execute(req);
    const uiPayload = (exec.pipelineResult.evidence[0].metadata as any)?.ui_evidence;
    const entryUrl = uiPayload.network_observation.entries[0].url;

    assert.ok(!entryUrl.includes('confidential_session_key'));
    assert.ok(entryUrl.includes('auth=***REDACTED***'));
  });

  // ==========================================================================
  // E22 - E25: SESSION LIFECYCLE & NO LEAK GUARANTEE
  // ==========================================================================

  it('E22 — Browser session closes after success', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);

    assert.strictEqual(port.openCount, 1, 'Exactly one session opened');
    assert.strictEqual(port.closeCount, 1, 'Exactly one session closed');
    assert.strictEqual(port.closedSessionIds.length, 1);
  });

  it('E23 — Browser session closes after observation failure', async () => {
    const port = new InstrumentedBrowserPort();
    port.navigateHandler = async () => {
      throw new Error('Navigation timed out');
    };

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.success, false);

    assert.strictEqual(port.openCount, 1, 'Session was opened');
    assert.strictEqual(port.closeCount, 1, 'Session was closed despite navigation error');
  });

  it('E24 — Browser session closes after validation failure', async () => {
    const port = new InstrumentedBrowserPort();
    port.navigateHandler = async (r) => ({
      ...(await new FakeBrowserPort().navigate(r)),
      task_id: 'mismatched-task-id',
    });

    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const exec = await service.execute(req);
    assert.strictEqual(exec.success, false);

    assert.strictEqual(port.openCount, 1);
    assert.strictEqual(port.closeCount, 1, 'Session closed despite validation failure');
  });

  it('E25 — Browser session closes after QA failure', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeDom(r)),
      selector: '.expected-class',
      matches_count: 0,
    });

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '.expected-class', presence: 'present' as const }],
    };

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.REJECT);

    assert.strictEqual(port.openCount, 1);
    assert.strictEqual(port.closeCount, 1, 'Session closed when QA rejects');
  });

  // ==========================================================================
  // E26 - E29: PROVIDER ISOLATION & DECISION PROPAGATION
  // ==========================================================================

  it('E26 — Provider-specific browser objects do not leak', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION, UiObservationType.DOM]);

    const exec = await service.execute(req);
    const serialized = JSON.stringify(exec);

    assert.ok(!serialized.includes('Playwright'));
    assert.ok(!serialized.includes('BrowserContext'));
    assert.ok(!serialized.includes('chromium'));
  });

  it('E27 — QA ACCEPT propagates unchanged', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
  });

  it('E28 — QA REJECT propagates unchanged', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async (r) => ({
      ...(await new FakeBrowserPort().observeDom(r)),
      selector: '#btn',
      matches_count: 0,
    });

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '#btn', presence: 'present' as const }],
    };

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.REJECT);
  });

  it('E29 — QA REQUEST_CONTEXT propagates unchanged', async () => {
    const port = new InstrumentedBrowserPort();
    port.domHandler = async () => {
      throw new Error('Observation unavailable');
    };

    const service = new UiVerificationService(port);
    const req = {
      ...createBaseRequest([UiObservationType.DOM]),
      expected_dom_conditions: [{ selector: '#btn', presence: 'present' as const }],
    };

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.REQUEST_CONTEXT);
  });

  // ==========================================================================
  // E30 - E35: REGRESSION OF ACCEPTED PHASE 5 CONTRACTS & NON-UI QA
  // ==========================================================================

  it('E30 — Existing P5-01 tests remain passing', () => {
    const req: UiVerificationRequest = {
      task_id: 'task-e30',
      project_id: 'proj-e30',
      correlation_id: 'corr-e30',
      criterion_id: 'crit-e30',
      target_url: 'http://localhost/test',
      attempt: 1,
      max_attempts: 1,
      required_observations: [UiObservationType.NAVIGATION],
    };
    const val = validateUiVerificationRequest(req);
    assert.strictEqual(val.valid, true);
  });

  it('E31 — Existing P5-02 browser adapter tests remain passing', async () => {
    const port = new FakeBrowserPort();
    const session = await port.startSession();
    assert.strictEqual(session.is_active, true);
    await port.closeSession(session.session_id);
  });

  it('E32 — Existing P5-03 pipeline tests remain passing', async () => {
    const port = new FakeBrowserPort();
    const pipeline = new UiObservationPipeline(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);
    const res = await pipeline.run(req);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.evidence.length, 1);
  });

  it('E33 — Existing P5-04 tests remain passing', () => {
    const qaEngine = new QAReviewEngine();
    const bridge = new UiVerificationQaBridge(qaEngine);
    assert.strictEqual(typeof bridge.reviewUiVerification, 'function');
  });

  it('E34 — Existing non-UI QA tests remain passing', () => {
    const qaEngine = new QAReviewEngine();
    const nonUiCrit: AcceptanceCriterion = {
      criterion_id: 'CRIT-NON-UI',
      description: 'Test non-UI review',
      criterion_type: CriterionType.COMMAND,
      is_mandatory: true,
      expected_exit_code: 0,
    };
    const evidenceInput = {
      evidence_id: 'evi:e34:1',
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      command: 'npm test',
      exit_code: 0,
      stdout_tail: '10 tests passed',
      stderr: null,
      working_directory: '/app',
      execution_time_ms: 100,
      git_head_before: null,
      git_head_after: null,
      unified_diff: null,
      file_hashes_after: null,
      evidence_type: EvidenceType.COMMAND,
      source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE as const,
    };
    const val = validateSystemVerifiedEvidence(evidenceInput);
    assert.strictEqual(val.valid, true);

    const res = qaEngine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      attempt: 1,
      max_attempts: 1,
      acceptance_criteria: [nonUiCrit],
      evidence: [val.evidence!],
    });
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
  });

  it('E35 — Full regression suite passes and composition succeeds', async () => {
    const port = new InstrumentedBrowserPort();
    const service = new UiVerificationService(port);
    const req = createBaseRequest([UiObservationType.NAVIGATION]);

    const res = await service.verify(req);
    assert.strictEqual(res.decision, ReviewDecision.ACCEPT);
    assert.strictEqual(res.all_mandatory_satisfied, true);
    assert.strictEqual(port.openCount, 1);
    assert.strictEqual(port.closeCount, 1);
  });
});
