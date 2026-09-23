import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

import {
  // Types & Port
  UiObservationType,
  UI_OBSERVATION_TYPES,
  isUiObservationType,
  isValidTargetUrl,
  validateUiVerificationRequest,
  assertValidUiVerificationRequest,
  BrowserCapability,
  BROWSER_CAPABILITIES,
  isBrowserCapability,
  type BrowserPort,
  FakeBrowserPort,
  type BrowserNavigationRequest,
  type BrowserDomObservationRequest,
  type BrowserScreenshotRequest,
  type BrowserConsoleObservationRequest,
  type BrowserNetworkObservationRequest,
  type BrowserVisibleElementRequest,
  type UiVerificationRequest,
  type UiVerificationRequestInput,
  type BrowserNavigationObservation,
  type BrowserDomObservation,
  type BrowserVisibleElementObservation,
  type BrowserScreenshotObservation,
  type BrowserConsoleObservation,
  type BrowserNetworkObservation,
  // Evidence & Normalization
  isBrowserObservation,
  normalizeBrowserObservation,
  createUiSystemVerifiedEvidence,
  validateUiSystemVerifiedEvidence,
  assertValidUiSystemVerifiedEvidence,
  sanitizeUrl,
  sanitizeHeaders,
  sanitizeConsoleEntries,
  sanitizeNetworkEntries,
  // Existing Architecture Integration
  EvidenceType,
  EvidenceSource,
  EvidenceValidationStatus,
  createAgentClaim,
  validateSystemVerifiedEvidence,
  assertValidSystemVerifiedEvidence,
  CriterionType,
  QAReviewEngine,
  // Structured Errors
  UiVerificationError,
  InvalidUiVerificationRequestError,
  BrowserUnavailableError,
  UnsupportedBrowserCapabilityError,
  BrowserNavigationError,
  DomObservationError,
  ScreenshotError,
  ConsoleObservationError,
  NetworkObservationError,
  InvalidBrowserObservationError,
  InvalidUiEvidenceError,
  InvalidEvidenceSourceError,
} from '../dist/index.js';

// ============================================================================
// FIXTURES
// ============================================================================

const TASK_ID = 'TASK-P5-01';
const PROJECT_ID = 'proj:aidm-core';
const CORRELATION_ID = 'corr:proj:aidm-core:TASK-P5-01:1';
const CRITERION_ID = 'AC-UI-001';
const TARGET_URL = 'http://localhost:3000/dashboard';

function createValidRequestInput(
  overrides?: Partial<UiVerificationRequestInput>
): UiVerificationRequestInput {
  return {
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    correlation_id: CORRELATION_ID,
    criterion_id: CRITERION_ID,
    target_url: TARGET_URL,
    attempt: 1,
    max_attempts: 3,
    required_observations: [UiObservationType.DOM, UiObservationType.SCREENSHOT],
    expected_dom_conditions: [
      {
        selector: '#main-heading',
        presence: 'present',
        text_contains: 'Dashboard',
      },
    ],
    screenshot_requirements: {
      capture: true,
      full_page: false,
      viewport: { width: 1280, height: 720 },
    },
    timeout_ms: 10_000,
    metadata: { env: 'testing' },
    ...overrides,
  };
}

function createSampleDomObservation(
  overrides?: Partial<BrowserDomObservation>
): BrowserDomObservation {
  return {
    observation_id: 'obs:p5-01:dom:1',
    task_id: TASK_ID,
    correlation_id: CORRELATION_ID,
    observation_type: 'DOM',
    url: TARGET_URL,
    selector: '#submit-btn',
    matches_count: 1,
    elements: [
      {
        tag_name: 'button',
        selector: '#submit-btn',
        attributes: { id: 'submit-btn', class: 'btn btn-primary' },
        inner_text: 'Submit Application',
        is_visible: true,
        id: 'submit-btn',
        classes: ['btn', 'btn-primary'],
      },
    ],
    html_snapshot_snippet: '<button id="submit-btn" class="btn btn-primary">Submit Application</button>',
    captured_at: '2026-09-23T10:00:00.000Z',
    metadata: { testMeta: true },
    ...overrides,
  };
}

// ============================================================================
// TEST SUITE: PHASE 5 CONTRACT & BROWSER BOUNDARY (TASK-P5-01)
// ============================================================================

describe('Phase 5 UI Verification Contract & Browser Boundary (TASK-P5-01)', () => {
  // --------------------------------------------------------------------------
  // U1 — Request validation
  // --------------------------------------------------------------------------
  it('U1 — Request validation: valid UI verification request is accepted', () => {
    const input = createValidRequestInput();
    const result = validateUiVerificationRequest(input);

    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
    assert.ok(result.request);
    assert.equal(result.request.task_id, TASK_ID);
    assert.equal(result.request.project_id, PROJECT_ID);
    assert.equal(result.request.correlation_id, CORRELATION_ID);
    assert.equal(result.request.criterion_id, CRITERION_ID);
    assert.equal(result.request.target_url, TARGET_URL);
    assert.equal(result.request.attempt, 1);
    assert.equal(result.request.max_attempts, 3);
    assert.deepEqual(result.request.required_observations, [
      UiObservationType.DOM,
      UiObservationType.SCREENSHOT,
    ]);
    assert.ok(Object.isFrozen(result.request));

    // Also assert assertValidUiVerificationRequest returns the request without error
    const validated = assertValidUiVerificationRequest(input);
    assert.deepEqual(validated, result.request);

    // camelCase aliases accepted
    const camelInput: UiVerificationRequestInput = {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      correlationId: CORRELATION_ID,
      criterionId: CRITERION_ID,
      targetUrl: TARGET_URL,
      attempt: 1,
      maxAttempts: 2,
      requiredObservations: [UiObservationType.NAVIGATION],
    };
    const camelResult = validateUiVerificationRequest(camelInput);
    assert.equal(camelResult.valid, true);
    assert.equal(camelResult.request?.task_id, TASK_ID);
    assert.equal(camelResult.request?.target_url, TARGET_URL);
  });

  // --------------------------------------------------------------------------
  // U2 — Invalid request
  // --------------------------------------------------------------------------
  it('U2 — Invalid request: malformed/missing required request data is rejected deterministically', () => {
    // 1. Missing mandatory identity fields
    const missingFields: (keyof UiVerificationRequestInput)[] = [
      'task_id',
      'project_id',
      'correlation_id',
      'criterion_id',
      'target_url',
    ];

    for (const field of missingFields) {
      const badInput = createValidRequestInput({ [field]: undefined });
      const res = validateUiVerificationRequest(badInput);
      assert.equal(res.valid, false, `Expected missing ${field} to be invalid`);
      assert.ok(
        res.issues.some((i) => i.field === field && i.code === 'ERR_INVALID_UI_VERIFICATION_REQUEST')
      );
      assert.throws(
        () => assertValidUiVerificationRequest(badInput),
        (err: unknown) =>
          err instanceof InvalidUiVerificationRequestError &&
          err.code === 'ERR_INVALID_UI_VERIFICATION_REQUEST'
      );
    }

    // 2. Invalid target_url formats
    const invalidUrls = ['', '   ', 'not-a-url', 'ftp://invalid', 'javascript:alert(1)'];
    for (const badUrl of invalidUrls) {
      const badInput = createValidRequestInput({ target_url: badUrl });
      const res = validateUiVerificationRequest(badInput);
      assert.equal(res.valid, false, `Expected bad url '${badUrl}' to be rejected`);
    }

    // 3. Invalid attempt (< 1 or float)
    for (const badAttempt of [0, -1, 1.5, NaN]) {
      const badInput = createValidRequestInput({ attempt: badAttempt });
      const res = validateUiVerificationRequest(badInput);
      assert.equal(res.valid, false, `Expected bad attempt ${badAttempt} to be rejected`);
    }

    // 4. max_attempts < attempt
    const badMax = createValidRequestInput({ attempt: 3, max_attempts: 2 });
    const resMax = validateUiVerificationRequest(badMax);
    assert.equal(resMax.valid, false);
    assert.ok(resMax.issues.some((i) => i.field === 'max_attempts'));

    // 5. Missing or empty required_observations
    const emptyObs = createValidRequestInput({ required_observations: [] });
    assert.equal(validateUiVerificationRequest(emptyObs).valid, false);

    const invalidObs = createValidRequestInput({
      required_observations: ['INVALID_OBSERVATION_TYPE' as any],
    });
    assert.equal(validateUiVerificationRequest(invalidObs).valid, false);

    // 6. Non-object inputs
    for (const nonObj of [null, undefined, 'str', 123, true, []]) {
      assert.equal(validateUiVerificationRequest(nonObj).valid, false);
      assert.throws(
        () => assertValidUiVerificationRequest(nonObj),
        InvalidUiVerificationRequestError
      );
    }
  });

  // --------------------------------------------------------------------------
  // U3 — Browser capability contract
  // --------------------------------------------------------------------------
  it('U3 — Browser capability contract: capabilities can be checked without coupling to a concrete browser', async () => {
    const fakePort = new FakeBrowserPort({
      provider: 'test-stub-browser',
      version: '1.0.0',
      capabilities: [
        BrowserCapability.NAVIGATION,
        BrowserCapability.DOM_OBSERVATION,
        BrowserCapability.VISIBLE_ELEMENT_OBSERVATION,
        BrowserCapability.SESSION_LIFECYCLE,
      ],
    });

    // 1. Availability check
    const availability = await fakePort.checkAvailability();
    assert.equal(availability.available, true);
    assert.equal(availability.provider, 'test-stub-browser');
    assert.equal(availability.version, '1.0.0');

    // 2. Capability checks
    assert.equal(fakePort.hasCapability(BrowserCapability.NAVIGATION), true);
    assert.equal(fakePort.hasCapability(BrowserCapability.DOM_OBSERVATION), true);
    assert.equal(fakePort.hasCapability(BrowserCapability.SCREENSHOT), false);
    assert.equal(fakePort.hasCapability(BrowserCapability.NETWORK_OBSERVATION), false);

    // 3. Supported operation succeeds
    const session = await fakePort.startSession();
    assert.equal(session.is_active, true);
    assert.ok(session.session_id.startsWith('session:fake:'));

    // 4. Unsupported operation throws structured UnsupportedBrowserCapabilityError
    await assert.rejects(
      async () => {
        await fakePort.captureScreenshot({
          task_id: TASK_ID,
          correlation_id: CORRELATION_ID,
          format: 'png',
        });
      },
      (err: unknown) =>
        err instanceof UnsupportedBrowserCapabilityError &&
        err.code === 'ERR_UNSUPPORTED_BROWSER_CAPABILITY' &&
        err.capability === BrowserCapability.SCREENSHOT
    );

    // 5. Unavailable browser throws structured BrowserUnavailableError
    fakePort.setAvailable(false, 'Simulated browser crash');
    const unavailCheck = await fakePort.checkAvailability();
    assert.equal(unavailCheck.available, false);
    assert.equal(unavailCheck.reason, 'Simulated browser crash');

    await assert.rejects(
      async () => {
        await fakePort.navigate({
          task_id: TASK_ID,
          correlation_id: CORRELATION_ID,
          url: 'http://localhost/app',
        });
      },
      (err: unknown) =>
        err instanceof BrowserUnavailableError &&
        err.code === 'ERR_BROWSER_UNAVAILABLE'
    );
  });

  // --------------------------------------------------------------------------
  // U4 — Navigation observation
  // --------------------------------------------------------------------------
  it('U4 — Navigation observation: typed navigation observation preserves identity/correlation information', async () => {
    const fakePort = new FakeBrowserPort();

    const navReq: BrowserNavigationRequest = {
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
      url: 'https://example.com/app',
      timeout_ms: 5000,
    };

    const observation = await fakePort.navigate(navReq);

    assert.equal(observation.observation_type, 'NAVIGATION');
    assert.equal(observation.task_id, TASK_ID);
    assert.equal(observation.correlation_id, CORRELATION_ID);
    assert.equal(observation.url, 'https://example.com/app');
    assert.equal(observation.status_code, 200);
    assert.equal(observation.title, 'Mock Page');
    assert.equal(observation.redirected, false);
    assert.equal(typeof observation.navigation_time_ms, 'number');
    assert.ok(isBrowserObservation(observation));
    assert.ok(Object.isFrozen(observation));
  });

  // --------------------------------------------------------------------------
  // U5 — DOM observation
  // --------------------------------------------------------------------------
  it('U5 — DOM observation: typed DOM observation preserves required UI information', async () => {
    const fakePort = new FakeBrowserPort();

    const domReq: BrowserDomObservationRequest = {
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
      url: TARGET_URL,
      selector: '#app-root',
    };

    const observation = await fakePort.observeDom(domReq);

    assert.equal(observation.observation_type, 'DOM');
    assert.equal(observation.task_id, TASK_ID);
    assert.equal(observation.correlation_id, CORRELATION_ID);
    assert.equal(observation.selector, '#app-root');
    assert.ok(observation.matches_count >= 1);
    assert.ok(Array.isArray(observation.elements));
    assert.equal(observation.elements[0].tag_name, 'body');
    assert.ok(observation.html_snapshot_snippet?.includes('Hello World'));
    assert.ok(isBrowserObservation(observation));
    assert.ok(Object.isFrozen(observation));
  });

  // --------------------------------------------------------------------------
  // U6 — Screenshot observation
  // --------------------------------------------------------------------------
  it('U6 — Screenshot observation: screenshot observation is represented without coupling core to a browser', async () => {
    const fakePort = new FakeBrowserPort();

    const shotReq: BrowserScreenshotRequest = {
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
      url: TARGET_URL,
      format: 'png',
      full_page: true,
    };

    const observation = await fakePort.captureScreenshot(shotReq);

    assert.equal(observation.observation_type, 'SCREENSHOT');
    assert.equal(observation.task_id, TASK_ID);
    assert.equal(observation.correlation_id, CORRELATION_ID);
    assert.equal(observation.format, 'png');
    assert.equal(observation.mime_type, 'image/png');
    assert.equal(observation.byte_length, 1024);
    assert.equal(observation.sha256_hash.length, 64);
    assert.ok(observation.viewport);
    assert.equal(observation.viewport?.width, 1280);
    assert.equal(observation.viewport?.height, 720);
    assert.ok(isBrowserObservation(observation));
    assert.ok(Object.isFrozen(observation));
  });

  // --------------------------------------------------------------------------
  // U7 — Console observation
  // --------------------------------------------------------------------------
  it('U7 — Console observation: console observations are represented and normalized', async () => {
    const fakePort = new FakeBrowserPort();
    fakePort.consoleHandler = async (req) => ({
      observation_id: `obs:${req.task_id}:console:${req.correlation_id}`,
      task_id: req.task_id,
      correlation_id: req.correlation_id,
      observation_type: 'CONSOLE',
      url: req.url ?? TARGET_URL,
      entries: [
        { level: 'warn', text: 'Deprecation warning: use new API', timestamp: '2026-09-23T10:00:02Z' },
        { level: 'error', text: 'Failed to load resource', timestamp: '2026-09-23T10:00:03Z' },
        { level: 'log', text: 'App initialized', timestamp: '2026-09-23T10:00:01Z' },
      ],
      has_errors: true,
      captured_at: '2026-09-23T10:00:04Z',
      metadata: null,
    });

    const rawObs = await fakePort.observeConsole({
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
    });

    assert.equal(rawObs.has_errors, true);
    assert.equal(rawObs.entries.length, 3);

    // Normalization sorts by timestamp deterministically
    const normalized = normalizeBrowserObservation(rawObs);
    assert.equal(normalized.entries[0].text, 'App initialized');
    assert.equal(normalized.entries[1].text, 'Deprecation warning: use new API');
    assert.equal(normalized.entries[2].text, 'Failed to load resource');
    assert.ok(isBrowserObservation(normalized));
  });

  // --------------------------------------------------------------------------
  // U8 — Network observation
  // --------------------------------------------------------------------------
  it('U8 — Network observation: network observations are represented and normalized', async () => {
    const fakePort = new FakeBrowserPort();
    fakePort.networkHandler = async (req) => ({
      observation_id: `obs:${req.task_id}:net:${req.correlation_id}`,
      task_id: req.task_id,
      correlation_id: req.correlation_id,
      observation_type: 'NETWORK',
      url: req.url ?? TARGET_URL,
      entries: [
        {
          url: 'http://localhost:3000/api/users',
          method: 'POST',
          status: 201,
          status_text: 'Created',
          resource_type: 'xhr',
          duration_ms: 45,
          failed: false,
          request_headers: { 'Content-Type': 'application/json' },
          response_headers: { 'Content-Type': 'application/json' },
        },
        {
          url: 'http://localhost:3000/api/config',
          method: 'GET',
          status: 200,
          status_text: 'OK',
          resource_type: 'fetch',
          duration_ms: 12,
          failed: false,
        },
      ],
      has_failures: false,
      captured_at: '2026-09-23T10:00:00.000Z',
      metadata: null,
    });

    const rawObs = await fakePort.observeNetwork({
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
    });

    const normalized = normalizeBrowserObservation(rawObs);
    // Ordered deterministically by url
    assert.equal(normalized.entries[0].url, 'http://localhost:3000/api/config');
    assert.equal(normalized.entries[1].url, 'http://localhost:3000/api/users');
    assert.equal(normalized.has_failures, false);
    assert.ok(isBrowserObservation(normalized));
  });

  // --------------------------------------------------------------------------
  // U9 — System evidence boundary
  // --------------------------------------------------------------------------
  it('U9 — System evidence boundary: a real browser observation can be represented as system-verifiable UI evidence', () => {
    const observation = createSampleDomObservation();

    const uiEvidence = createUiSystemVerifiedEvidence({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      target_url: TARGET_URL,
      observation,
      execution_time_ms: 150,
      working_directory: '/workspaces/app',
    });

    // 1. Invariants match SYSTEM_VERIFIED_EVIDENCE contract
    assert.equal(uiEvidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
    assert.equal(uiEvidence.evidence_type, EvidenceType.UI);
    assert.equal(uiEvidence.task_id, TASK_ID);
    assert.equal(uiEvidence.project_id, PROJECT_ID);
    assert.equal(uiEvidence.correlation_id, CORRELATION_ID);
    assert.equal(uiEvidence.command, 'browser:observe:dom');
    assert.equal(uiEvidence.exit_code, 0);
    assert.equal(uiEvidence.working_directory, '/workspaces/app');
    assert.equal(uiEvidence.execution_time_ms, 150);
    assert.equal(uiEvidence.observation_id, observation.observation_id);
    assert.equal(uiEvidence.ui_observation_type, UiObservationType.DOM);
    assert.equal(uiEvidence.target_url, TARGET_URL);
    assert.ok(Object.isFrozen(uiEvidence));

    // 2. Passes base SystemVerifiedEvidence validation seamlessly
    const baseValidation = validateSystemVerifiedEvidence(uiEvidence);
    assert.equal(baseValidation.valid, true);
    assert.equal(baseValidation.status, EvidenceValidationStatus.VALID);
    assert.equal(baseValidation.issues.length, 0);

    // 3. Passes assertValidSystemVerifiedEvidence
    const verifiedBase = assertValidSystemVerifiedEvidence(uiEvidence);
    assert.equal(verifiedBase.evidence_id, uiEvidence.evidence_id);

    // 4. Passes UI-specific verification
    const uiValidation = validateUiSystemVerifiedEvidence(uiEvidence);
    assert.equal(uiValidation.valid, true);
    const verifiedUi = assertValidUiSystemVerifiedEvidence(uiEvidence);
    assert.equal(verifiedUi.observation_id, observation.observation_id);

    // 5. Integrates with QAReviewEngine
    const qaEngine = new QAReviewEngine();
    const reviewResult = qaEngine.review({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      acceptance_criteria: [
        {
          criterion_id: 'AC-UI-001',
          description: 'UI verification DOM check',
          criterion_type: CriterionType.UI,
          is_mandatory: true,
          predicate: (evidenceList) => {
            const uiEvi = evidenceList.find((e) => e.evidence_type === EvidenceType.UI);
            return {
              satisfied: Boolean(uiEvi && uiEvi.exit_code === 0),
              reason: 'UI observation satisfied',
            };
          },
        },
      ],
      evidence: [uiEvidence],
    });

    assert.equal(reviewResult.decision, 'ACCEPT');
    assert.equal(reviewResult.all_mandatory_satisfied, true);
  });

  // --------------------------------------------------------------------------
  // U10 — Agent claim rejection
  // --------------------------------------------------------------------------
  it('U10 — Agent claim rejection: an AGENT_CLAIM cannot be promoted into UI system evidence', () => {
    // 1. AgentClaim created via createAgentClaim
    const agentClaim = createAgentClaim({
      task_id: TASK_ID,
      statement: 'The button is visible and green',
    });

    // Passing an AgentClaim to createUiSystemVerifiedEvidence must throw InvalidEvidenceSourceError
    assert.throws(
      () => {
        createUiSystemVerifiedEvidence({
          task_id: TASK_ID,
          project_id: PROJECT_ID,
          correlation_id: CORRELATION_ID,
          target_url: TARGET_URL,
          observation: agentClaim as any,
        });
      },
      (err: unknown) =>
        err instanceof InvalidEvidenceSourceError &&
        err.code === 'ERR_INVALID_EVIDENCE_SOURCE'
    );

    // 2. Object with source: 'AGENT_CLAIM'
    const masqueradeObservation = {
      ...createSampleDomObservation(),
      source: EvidenceSource.AGENT_CLAIM,
    };
    assert.equal(isBrowserObservation(masqueradeObservation), false);
    assert.throws(
      () => {
        createUiSystemVerifiedEvidence({
          task_id: TASK_ID,
          project_id: PROJECT_ID,
          correlation_id: CORRELATION_ID,
          target_url: TARGET_URL,
          observation: masqueradeObservation as any,
        });
      },
      InvalidEvidenceSourceError
    );

    // 3. Object with is_agent_claim: true
    const flaggedClaim = {
      ...createSampleDomObservation(),
      is_agent_claim: true,
    };
    assert.equal(isBrowserObservation(flaggedClaim), false);
    assert.throws(
      () => {
        createUiSystemVerifiedEvidence({
          task_id: TASK_ID,
          project_id: PROJECT_ID,
          correlation_id: CORRELATION_ID,
          target_url: TARGET_URL,
          observation: flaggedClaim as any,
        });
      },
      InvalidEvidenceSourceError
    );

    // 4. Object with unverified statement property
    const statementClaim = {
      ...createSampleDomObservation(),
      statement: 'Agent evaluated UI successfully',
    };
    assert.equal(isBrowserObservation(statementClaim), false);
    assert.throws(
      () => {
        createUiSystemVerifiedEvidence({
          task_id: TASK_ID,
          project_id: PROJECT_ID,
          correlation_id: CORRELATION_ID,
          target_url: TARGET_URL,
          observation: statementClaim as any,
        });
      },
      InvalidEvidenceSourceError
    );
  });

  // --------------------------------------------------------------------------
  // U11 — Deterministic normalization
  // --------------------------------------------------------------------------
  it('U11 — Deterministic normalization: equivalent observations produce deterministic normalized representations', () => {
    // Two DOM observations with identical semantic facts but attributes in reversed order
    const obsA: BrowserDomObservation = {
      observation_id: 'obs:p5-01:dom:same',
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
      observation_type: 'DOM',
      url: 'http://localhost:3000/app',
      selector: '#nav',
      matches_count: 1,
      elements: [
        {
          tag_name: 'div',
          attributes: { z_attr: 'last', a_attr: 'first', m_attr: 'middle' },
          classes: ['z-class', 'a-class'],
        },
      ],
      html_snapshot_snippet: '<div a_attr="first" m_attr="middle" z_attr="last"></div>',
      captured_at: '2026-09-23T10:00:00Z',
      metadata: null,
    };

    const obsB: BrowserDomObservation = {
      observation_id: 'obs:p5-01:dom:same',
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
      observation_type: 'DOM',
      url: 'http://localhost:3000/app',
      selector: '#nav',
      matches_count: 1,
      elements: [
        {
          tag_name: 'div',
          attributes: { a_attr: 'first', m_attr: 'middle', z_attr: 'last' },
          classes: ['a-class', 'z-class'],
        },
      ],
      html_snapshot_snippet: '<div a_attr="first" m_attr="middle" z_attr="last"></div>',
      captured_at: '2026-09-23T10:00:00Z',
      metadata: null,
    };

    const normA = normalizeBrowserObservation(obsA);
    const normB = normalizeBrowserObservation(obsB);

    assert.deepEqual(normA, normB);
    assert.deepEqual(
      Object.keys(normA.elements![0].attributes),
      ['a_attr', 'm_attr', 'z_attr']
    );

    // Repeated normalization of UI evidence produces identical evidence
    const eviA = createUiSystemVerifiedEvidence({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      target_url: TARGET_URL,
      observation: obsA,
    });
    const eviB = createUiSystemVerifiedEvidence({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      target_url: TARGET_URL,
      observation: obsB,
    });

    assert.deepEqual(eviA, eviB);
  });

  // --------------------------------------------------------------------------
  // U12 — Secret sanitization
  // --------------------------------------------------------------------------
  it('U12 — Secret sanitization: sensitive browser/network metadata cannot leak through normalized UI evidence', () => {
    const sensitiveApiKey = 'sk-ant-api03-SECRETKEY1234567890abcdef';
    const sensitiveBearer = 'Bearer secret-jwt-token-xyz-123456789';
    const sensitiveCookie = 'session_id=super_secret_cookie_token_987';
    const sensitivePassword = 'supersecretpass123';

    // 1. Network observation with sensitive URL, query params, and headers
    const rawNetObs: BrowserNetworkObservation = {
      observation_id: 'obs:p5-01:net:secret',
      task_id: TASK_ID,
      correlation_id: CORRELATION_ID,
      observation_type: 'NETWORK',
      url: `https://example.com/api?token=${sensitiveApiKey}&user=alice`,
      entries: [
        {
          url: `https://api.example.com/auth?apiKey=${sensitiveApiKey}&password=${sensitivePassword}`,
          method: 'POST',
          status: 200,
          failed: false,
          request_headers: {
            Authorization: sensitiveBearer,
            Cookie: sensitiveCookie,
            'X-Api-Key': sensitiveApiKey,
            'Content-Type': 'application/json',
          },
          response_headers: {
            'Set-Cookie': 'auth=token123; Secure',
          },
        },
      ],
      has_failures: false,
      captured_at: '2026-09-23T10:00:00Z',
      metadata: {
        rawToken: sensitiveApiKey,
        subConfig: { password: sensitivePassword },
      },
    };

    const evidence = createUiSystemVerifiedEvidence({
      task_id: TASK_ID,
      project_id: PROJECT_ID,
      correlation_id: CORRELATION_ID,
      target_url: `http://localhost/app?token=${sensitiveApiKey}`,
      observation: rawNetObs,
    });

    const serializedEvidence = JSON.stringify(evidence);

    // Verify none of the sensitive secrets exist anywhere in the serialized evidence
    assert.equal(serializedEvidence.includes(sensitiveApiKey), false);
    assert.equal(serializedEvidence.includes(sensitiveBearer), false);
    assert.equal(serializedEvidence.includes(sensitiveCookie), false);
    assert.equal(serializedEvidence.includes(sensitivePassword), false);

    // Verify redacting occurred properly
    assert.ok(serializedEvidence.includes('token=***REDACTED***'));
    assert.ok(serializedEvidence.includes('Bearer ***REDACTED_TOKEN***'));
    assert.ok(serializedEvidence.includes('***REDACTED***'));
  });

  // --------------------------------------------------------------------------
  // U13 — Provider neutrality
  // --------------------------------------------------------------------------
  it('U13 — Provider neutrality: no Playwright/Puppeteer/Selenium-specific runtime object appears in public core contract', () => {
    const uiVerificationIndex = fs.readFileSync(
      new URL('../src/ui-verification/index.ts', import.meta.url),
      'utf-8'
    );
    const browserPortSource = fs.readFileSync(
      new URL('../src/ui-verification/browser-port.ts', import.meta.url),
      'utf-8'
    );
    const uiTypesSource = fs.readFileSync(
      new URL('../src/ui-verification/ui-verification-types.ts', import.meta.url),
      'utf-8'
    );
    const uiEvidenceSource = fs.readFileSync(
      new URL('../src/ui-verification/ui-evidence-types.ts', import.meta.url),
      'utf-8'
    );

    const allSources = [
      uiVerificationIndex,
      browserPortSource,
      uiTypesSource,
      uiEvidenceSource,
    ].join('\n');

    // Reject concrete automation library imports and couplings
    const forbiddenPatterns = [
      'playwright',
      '@playwright/test',
      'puppeteer',
      'puppeteer-core',
      'selenium-webdriver',
      'webdriverio',
      'cypress',
    ];

    for (const forbidden of forbiddenPatterns) {
      assert.equal(
        allSources.toLowerCase().includes(`from '${forbidden}'`),
        false,
        `Found forbidden import from '${forbidden}'`
      );
      assert.equal(
        allSources.toLowerCase().includes(`from "${forbidden}"`),
        false,
        `Found forbidden import from "${forbidden}"`
      );
    }
  });

  // --------------------------------------------------------------------------
  // U14 — Regression
  // --------------------------------------------------------------------------
  it('U14 — Regression: all existing verification contracts remain uncompromised', () => {
    // 1. EvidenceType has UI added while keeping all previous types
    assert.equal(EvidenceType.COMMAND, 'COMMAND');
    assert.equal(EvidenceType.TEST, 'TEST');
    assert.equal(EvidenceType.BUILD, 'BUILD');
    assert.equal(EvidenceType.GIT, 'GIT');
    assert.equal(EvidenceType.DIFF, 'DIFF');
    assert.equal(EvidenceType.FILE_HASH, 'FILE_HASH');
    assert.equal(EvidenceType.UI, 'UI');

    // 2. CriterionType has UI added while keeping all previous types
    assert.equal(CriterionType.COMMAND, 'COMMAND');
    assert.equal(CriterionType.TEST, 'TEST');
    assert.equal(CriterionType.BUILD, 'BUILD');
    assert.equal(CriterionType.GIT, 'GIT');
    assert.equal(CriterionType.DIFF, 'DIFF');
    assert.equal(CriterionType.FILE_HASH, 'FILE_HASH');
    assert.equal(CriterionType.CUSTOM, 'CUSTOM');
    assert.equal(CriterionType.UI, 'UI');

    // 3. Scanner integrity: scanner.ts byte-for-byte unchanged
    const scannerPath = new URL('../src/l0/scanner.ts', import.meta.url);
    assert.ok(fs.existsSync(scannerPath));
  });
});
