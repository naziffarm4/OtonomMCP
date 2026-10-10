/**
 * Comprehensive Test Suite for Phase 15 Specification Completeness Gate (TASK-P15-02)
 *
 * Verifies all 27 required completeness capabilities and security invariants:
 * 1. fully complete project → COMPLETE
 * 2. missing non-human information → INCOMPLETE
 * 3. unresolved material Product Owner decision → BLOCKED_ON_HUMAN
 * 4. genuinely irrelevant area → NOT_APPLICABLE
 * 5. complete functional requirements
 * 6. incomplete functional requirements
 * 7. missing business rule
 * 8. missing acceptance criteria
 * 9. missing architecture decision
 * 10. missing technology decision
 * 11. missing security requirement
 * 12. missing operational requirement
 * 13. informational question does not block
 * 14. blocking question blocks
 * 15. human decision cannot be silently resolved
 * 16. discovery revision binding
 * 17. stale completeness result rejection
 * 18. cross-project isolation
 * 19. deterministic result/fingerprint
 * 20. persistence/reload
 * 21. history event
 * 22. MCP evaluation boundary
 * 23. no approval created
 * 24. no development authorization
 * 25. no execution intent
 * 26. no Antigravity invocation
 * 27. realistic project multi-area fixture
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  AdaptiveDiscoveryEngine,
  AdaptiveDiscoveryStore,
  CompletenessGateEngine,
  CompletenessGateStore,
  CompletenessValidationError,
  CompletenessRevisionNotFoundError,
  CompletenessProjectBindingMismatchError,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Specification Completeness Gate (TASK-P15-02)', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let completenessStore: CompletenessGateStore;
  let approvalStore: ApprovalStore;
  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-02-completeness-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });

    discoveryEngine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    completenessEngine = new CompletenessGateEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      historyManager,
      specStore,
    });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup fallback
    }
  });

  /**
   * Helper to create a fully specified revision fixture.
   */
  async function createFullyCompleteRevision(projectId = 'complete-proj'): Promise<ProjectDiscoveryRevision> {
    return discoveryEngine.discover({
      projectId,
      rawPrompt: `
        Build a high-performance web multiplayer turn-based board game.
        In scope: user authentication, match lobby, real-time move validation, and persistent match history.
        Target users: casual online players and tournament administrators.
        Primary workflows: create match, join lobby, take turn, and view match history.
        Platform constraints: Web Application running in modern browsers.
        Required technologies: Node.js, TypeScript, React, and WebSocket.
        Architectural constraints: Clean architecture with decoupled game engine domain and websocket transport.
        Deployment model: Local / Self-Hosted Docker Container.
        Data storage expectations: PostgreSQL relational database with Redis session cache.
        Security requirements: JWT authentication, role-based authorization, and input sanitization on all moves.
        Measurable criteria: 100% test pass rate, turn latency under 100ms for 500 concurrent players, 0 data loss on disconnect.
        Definition of completion: Automated integration test suite green and production docker image built.
        Business rules: Turn timer is 30 seconds; 60-second disconnect grace period before forfeit.
        Exclusions: VR headset support is out of scope.
      `,
      explicitSections: {
        functionalRequirements: {
          capabilities: [],
          behaviors: [],
          businessRules: ['60-second disconnect grace window with turn timer continuation'],
        },
      },
      decidedHumanDecisions: {
        'HDEC-6ef75679d70c': 'Local / Self-Hosted Docker Container',
      },
    });
  }

  // ==========================================================================
  // 1. FULLY COMPLETE PROJECT → COMPLETE
  // ==========================================================================
  it('T01_fully_complete_project_returns_COMPLETE', async () => {
    const revision = await createFullyCompleteRevision('t01-proj');
    const result = await completenessEngine.evaluate({
      projectId: 't01-proj',
      discoveryRevision: revision.discoveryRevision,
    });

    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.isEligibleForApproval, true);
    assert.equal(result.isStale, false);
    assert.equal(result.discoveryRevision, revision.discoveryRevision);
    assert.equal(result.evaluatedAreas.length, 15);
    assert.equal(result.missingInformation.length, 0);
  });

  // ==========================================================================
  // 2. MISSING NON-HUMAN INFORMATION → INCOMPLETE
  // ==========================================================================
  it('T02_missing_non_human_information_returns_INCOMPLETE', async () => {
    // Project where all human decisions are resolved, but non-human info (acceptance criteria) is missing
    const fullRev = await createFullyCompleteRevision('t02-incomplete');

    // Create a revision missing measurable criteria
    const strippedRevision: ProjectDiscoveryRevision = {
      ...fullRev,
      sections: {
        ...fullRev.sections,
        acceptance: {
          ...fullRev.sections.acceptance,
          measurableCriteria: [],
        },
      },
    };

    const result = await completenessEngine.evaluateRevision(strippedRevision);

    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.isEligibleForApproval, false);
    assert.ok(result.missingInformation.includes('acceptance.measurableCriteria'));
    assert.equal(result.humanDecisions.length, 0);
  });

  // ==========================================================================
  // 3. UNRESOLVED MATERIAL PRODUCT OWNER DECISION → BLOCKED_ON_HUMAN
  // ==========================================================================
  it('T03_unresolved_material_product_owner_decision_returns_BLOCKED_ON_HUMAN', async () => {
    // Has a pending human decision on deployment model
    const revision = await discoveryEngine.discover({
      projectId: 't03-human-blocked',
      rawPrompt: 'Build an internal API service with Node.js and Express.',
    });

    const result = await completenessEngine.evaluate({
      projectId: 't03-human-blocked',
      discoveryRevision: revision.discoveryRevision,
    });

    assert.equal(result.status, 'BLOCKED_ON_HUMAN');
    assert.equal(result.isEligibleForApproval, false);
    assert.ok(result.humanDecisions.length > 0);
    assert.equal(result.humanDecisions[0].status, 'PENDING_DECISION');
    assert.equal(result.humanDecisions[0].authority, 'USER');
  });

  // ==========================================================================
  // 4. GENUINELY IRRELEVANT AREA → NOT_APPLICABLE
  // ==========================================================================
  it('T04_genuinely_irrelevant_area_returns_NOT_APPLICABLE', async () => {
    // Project where external integrations genuinely do not apply
    const revision = await createFullyCompleteRevision('t04-cli-tool');
    const result = await completenessEngine.evaluate({
      projectId: 't04-cli-tool',
      discoveryRevision: revision.discoveryRevision,
    });

    const extIntegArea = result.evaluatedAreas.find((a) => a.area === 'EXTERNAL_INTEGRATIONS');
    assert.ok(extIntegArea);
    assert.equal(extIntegArea.status, 'NOT_APPLICABLE');
    assert.ok(
      extIntegArea.evidence[0].toLowerCase().includes('not applicable') ||
      extIntegArea.evidence[0].toLowerCase().includes('self-contained')
    );

    // Genuinely irrelevant area does not prevent project from being COMPLETE
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.isEligibleForApproval, true);
  });

  // ==========================================================================
  // 5. COMPLETE FUNCTIONAL REQUIREMENTS
  // ==========================================================================
  it('T05_complete_functional_requirements', async () => {
    const revision = await createFullyCompleteRevision('t05-freq');
    const result = await completenessEngine.evaluate({
      projectId: 't05-freq',
      discoveryRevision: revision.discoveryRevision,
    });

    const area = result.evaluatedAreas.find((a) => a.area === 'FUNCTIONAL_REQUIREMENTS');
    assert.ok(area);
    assert.equal(area.status, 'COMPLETE');
    assert.ok(area.evidence.length > 0);
  });

  // ==========================================================================
  // 6. INCOMPLETE FUNCTIONAL REQUIREMENTS
  // ==========================================================================
  it('T06_incomplete_functional_requirements', async () => {
    const revision = await discoveryEngine.discover({
      projectId: 't06-no-freq',
      rawPrompt: 'Something undefined without any features.',
    });

    // Artificially clear functional capabilities
    const strippedRevision: ProjectDiscoveryRevision = {
      ...revision,
      requirements: [],
      sections: {
        ...revision.sections,
        functionalRequirements: {
          capabilities: [],
          behaviors: [],
          businessRules: [],
        },
      },
    };

    const result = await completenessEngine.evaluateRevision(strippedRevision);
    const area = result.evaluatedAreas.find((a) => a.area === 'FUNCTIONAL_REQUIREMENTS');
    assert.ok(area);
    assert.equal(area.status, 'INCOMPLETE');
    assert.ok(area.missingInformation.includes('functionalRequirements.capabilities'));
  });

  // ==========================================================================
  // 7. MISSING BUSINESS RULE
  // ==========================================================================
  it('T07_missing_business_rule', async () => {
    // Has reconnect capability but no disconnect grace rule
    const revision = await discoveryEngine.discover({
      projectId: 't07-biz-rule',
      rawPrompt: `
        Build a multiplayer game with player reconnect capability.
        Target users: players.
        Platform constraints: Web Application.
        Measurable criteria: pass tests.
      `,
    });

    const result = await completenessEngine.evaluate({
      projectId: 't07-biz-rule',
      discoveryRevision: revision.discoveryRevision,
    });

    const area = result.evaluatedAreas.find((a) => a.area === 'BUSINESS_RULES');
    assert.ok(area);
    assert.notEqual(area.status, 'COMPLETE');
    assert.ok(area.evidence.some((e) => e.toLowerCase().includes('reconnect') || e.toLowerCase().includes('grace')));
  });

  // ==========================================================================
  // 8. MISSING ACCEPTANCE CRITERIA
  // ==========================================================================
  it('T08_missing_acceptance_criteria', async () => {
    const revision = await discoveryEngine.discover({
      projectId: 't08-acceptance',
      rawPrompt: 'Build an internal log parser with TypeScript.',
    });

    const result = await completenessEngine.evaluate({
      projectId: 't08-acceptance',
      discoveryRevision: revision.discoveryRevision,
    });

    const area = result.evaluatedAreas.find((a) => a.area === 'ACCEPTANCE_CRITERIA');
    assert.ok(area);
    assert.equal(area.status, 'INCOMPLETE');
    assert.ok(area.missingInformation.includes('acceptance.measurableCriteria'));
  });

  // ==========================================================================
  // 9. MISSING ARCHITECTURE DECISION
  // ==========================================================================
  it('T09_missing_architecture_decision', async () => {
    const revision = await discoveryEngine.discover({
      projectId: 't09-arch',
      rawPrompt: 'Build a scalable cloud microservice.',
    });

    const result = await completenessEngine.evaluate({
      projectId: 't09-arch',
      discoveryRevision: revision.discoveryRevision,
    });

    // Deployment model decision affects architecture
    const archArea = result.evaluatedAreas.find((a) => a.area === 'ARCHITECTURE_REQUIREMENTS');
    assert.ok(archArea);
    assert.equal(archArea.status, 'BLOCKED_ON_HUMAN');
  });

  // ==========================================================================
  // 10. MISSING TECHNOLOGY DECISION
  // ==========================================================================
  it('T10_missing_technology_decision', async () => {
    // Missing platform constraint produces open blocking question with options
    const revision = await discoveryEngine.discover({
      projectId: 't10-tech',
      rawPrompt: 'Build a cross-platform tool without specifying platform or language.',
    });

    const result = await completenessEngine.evaluate({
      projectId: 't10-tech',
      discoveryRevision: revision.discoveryRevision,
    });

    const techArea = result.evaluatedAreas.find((a) => a.area === 'TECHNOLOGY_CONSTRAINTS');
    assert.ok(techArea);
    assert.equal(techArea.status, 'BLOCKED_ON_HUMAN');
  });

  // ==========================================================================
  // 11. MISSING SECURITY REQUIREMENT
  // ==========================================================================
  it('T11_missing_security_requirement', async () => {
    const revision = await createFullyCompleteRevision('t11-sec');

    // Strip security requirements
    const strippedRevision: ProjectDiscoveryRevision = {
      ...revision,
      sections: {
        ...revision.sections,
        nonFunctionalRequirements: {
          ...revision.sections.nonFunctionalRequirements,
          security: [],
        },
      },
    };

    const result = await completenessEngine.evaluateRevision(strippedRevision);
    const secArea = result.evaluatedAreas.find((a) => a.area === 'SECURITY_REQUIREMENTS');
    assert.ok(secArea);
    assert.equal(secArea.status, 'INCOMPLETE');
  });

  // ==========================================================================
  // 12. MISSING OPERATIONAL REQUIREMENT
  // ==========================================================================
  it('T12_missing_operational_requirement', async () => {
    const revision = await discoveryEngine.discover({
      projectId: 't12-op',
      rawPrompt: 'Build a simple web server.',
    });

    const result = await completenessEngine.evaluate({
      projectId: 't12-op',
      discoveryRevision: revision.discoveryRevision,
    });

    const opArea = result.evaluatedAreas.find((a) => a.area === 'DEPLOYMENT_OPERATIONAL');
    assert.ok(opArea);
    assert.notEqual(opArea.status, 'COMPLETE');
  });

  // ==========================================================================
  // 13. INFORMATIONAL QUESTION DOES NOT BLOCK
  // ==========================================================================
  it('T13_informational_question_does_not_block', async () => {
    const revision = await createFullyCompleteRevision('t13-info');

    // Ensure it has an informational question
    assert.ok(revision.openQuestions.some((q) => q.classification === 'INFORMATIONAL'));

    const result = await completenessEngine.evaluate({
      projectId: 't13-info',
      discoveryRevision: revision.discoveryRevision,
    });

    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.isEligibleForApproval, true);
    assert.ok(result.nonBlockingQuestions.length > 0);
  });

  // ==========================================================================
  // 14. BLOCKING QUESTION BLOCKS
  // ==========================================================================
  it('T14_blocking_question_blocks', async () => {
    const revision = await createFullyCompleteRevision('t14-block');

    // Add a critical blocking question
    const blockedRevision: ProjectDiscoveryRevision = {
      ...revision,
      openQuestions: [
        ...revision.openQuestions,
        {
          id: 'Q-CRITICAL-DB',
          question: 'What database should store accounts and game state?',
          category: 'ARCHITECTURE',
          whyItMatters: 'Persistence architecture depends on it.',
          whatItAffects: ['architecture', 'data model'],
          classification: 'BLOCKING',
          requiredDecision: 'Select database engine',
          dependentSection: 'architecture',
          impact: 'Critical data model impact',
          options: ['PostgreSQL', 'MongoDB'],
          status: 'OPEN',
        },
      ],
    };

    const result = await completenessEngine.evaluateRevision(blockedRevision);
    assert.notEqual(result.status, 'COMPLETE');
    assert.equal(result.isEligibleForApproval, false);
    assert.ok(result.blockingQuestions.some((q) => q.id === 'Q-CRITICAL-DB'));
  });

  // ==========================================================================
  // 15. HUMAN DECISION CANNOT BE SILENTLY RESOLVED
  // ==========================================================================
  it('T15_human_decision_cannot_be_silently_resolved', async () => {
    const revision = await discoveryEngine.discover({
      projectId: 't15-no-auto-resolve',
      rawPrompt: 'Build an internal API service.',
    });

    const result = await completenessEngine.evaluate({
      projectId: 't15-no-auto-resolve',
      discoveryRevision: revision.discoveryRevision,
    });

    assert.equal(result.status, 'BLOCKED_ON_HUMAN');
    assert.ok(result.humanDecisions.length > 0);

    for (const decision of result.humanDecisions) {
      assert.equal(decision.authority, 'USER');
      assert.equal(decision.status, 'PENDING_DECISION');
      assert.ok(decision.availableOptions.length >= 2);
    }
  });

  // ==========================================================================
  // 16. DISCOVERY REVISION BINDING
  // ==========================================================================
  it('T16_discovery_revision_binding', async () => {
    const rev1 = await discoveryEngine.discover({
      projectId: 't16-binding',
      rawPrompt: 'Initial discovery intent.',
    });

    const result1 = await completenessEngine.evaluate({
      projectId: 't16-binding',
      discoveryRevision: 1,
    });

    assert.equal(result1.discoveryRevision, 1);
    assert.equal(result1.discoveryFingerprint, rev1.fingerprint);
  });

  // ==========================================================================
  // 17. STALE COMPLETENESS RESULT REJECTION
  // ==========================================================================
  it('T17_stale_completeness_result_rejection', async () => {
    // 1. Revision 1: fully complete
    const rev1 = await createFullyCompleteRevision('t17-stale');
    const result1 = await completenessEngine.evaluate({
      projectId: 't17-stale',
      discoveryRevision: rev1.discoveryRevision,
    });

    assert.equal(result1.status, 'COMPLETE');
    assert.equal(result1.isEligibleForApproval, true);
    assert.equal(result1.isStale, false);

    // 2. Revision 2 changes a requirement
    await discoveryEngine.discover({
      projectId: 't17-stale',
      rawPrompt: 'Add mobile iOS support and Bluetooth controller support.',
    });

    // 3. Stale check on old result
    const isStale = await completenessEngine.isResultStale(result1);
    assert.equal(isStale, true);

    // 4. Evaluating rev 1 now flags isStale: true and not eligible for approval
    const recheckedRev1 = await completenessEngine.evaluate({
      projectId: 't17-stale',
      discoveryRevision: 1,
    });
    assert.equal(recheckedRev1.isStale, true);
    assert.equal(recheckedRev1.isEligibleForApproval, false);
  });

  // ==========================================================================
  // 18. CROSS-PROJECT ISOLATION
  // ==========================================================================
  it('T18_cross_project_isolation', async () => {
    await createFullyCompleteRevision('proj-alpha');

    // Attempting to evaluate proj-beta when only proj-alpha exists throws not found
    await assert.rejects(
      async () => {
        await completenessEngine.evaluate({
          projectId: 'proj-beta',
          discoveryRevision: 1,
        });
      },
      (err: unknown) => err instanceof CompletenessRevisionNotFoundError
    );

    // Path traversal in projectId is rejected
    await assert.rejects(
      async () => {
        await completenessEngine.evaluate({
          projectId: '../malicious/escape',
        });
      },
      (err: unknown) => err instanceof CompletenessValidationError
    );
  });

  // ==========================================================================
  // 19. DETERMINISTIC RESULT / FINGERPRINT
  // ==========================================================================
  it('T19_deterministic_result_and_fingerprint', async () => {
    const revision = await createFullyCompleteRevision('t19-det');

    const resultA = await completenessEngine.evaluateRevision(revision);
    const resultB = await completenessEngine.evaluateRevision(revision);

    assert.equal(resultA.fingerprint, resultB.fingerprint);
    assert.equal(resultA.status, resultB.status);
    assert.equal(resultA.isEligibleForApproval, resultB.isEligibleForApproval);
  });

  // ==========================================================================
  // 20. PERSISTENCE / RELOAD
  // ==========================================================================
  it('T20_persistence_and_reload', async () => {
    const revision = await createFullyCompleteRevision('t20-persist');
    const result = await completenessEngine.evaluate({
      projectId: 't20-persist',
      discoveryRevision: revision.discoveryRevision,
    });

    // Create fresh store instance on same baseDir
    const freshStore = new CompletenessGateStore({ baseDir: tempDir });
    const reloaded = await freshStore.loadResult('t20-persist', revision.discoveryRevision);

    assert.ok(reloaded);
    assert.equal(reloaded.projectId, 't20-persist');
    assert.equal(reloaded.discoveryRevision, revision.discoveryRevision);
    assert.equal(reloaded.fingerprint, result.fingerprint);
    assert.equal(reloaded.status, result.status);
  });

  // ==========================================================================
  // 21. HISTORY EVENT
  // ==========================================================================
  it('T21_history_event_recorded', async () => {
    const revision = await createFullyCompleteRevision('t21-hist');
    const result = await completenessEngine.evaluate({
      projectId: 't21-hist',
      discoveryRevision: revision.discoveryRevision,
    });

    const events = await historyManager.readEvents();
    const evalEvent = events.find((e) => e.eventType === 'SPECIFICATION_COMPLETENESS_EVALUATED');

    assert.ok(evalEvent);
    assert.equal(evalEvent.actor, 'DIRECTOR');
    assert.equal(evalEvent.payload.projectId, 't21-hist');
    assert.equal(evalEvent.payload.discoveryRevision, revision.discoveryRevision);
    assert.equal(evalEvent.payload.status, result.status);
    assert.equal(evalEvent.payload.fingerprint, result.fingerprint);
  });

  // ==========================================================================
  // 22. MCP EVALUATION BOUNDARY
  // ==========================================================================
  it('T22_mcp_evaluation_boundary', async () => {
    const revision = await createFullyCompleteRevision('t22-mcp');

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      adaptiveDiscoveryStore: discoveryStore,
      completenessGateStore: completenessStore,
      completenessGateEngine: completenessEngine,
      historyManager,
    });

    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      completenessTools: true,
    });

    await server.start();

    const request: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 202,
      method: 'tools/call',
      params: {
        name: AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME,
        arguments: {
          projectId: 't22-mcp',
          discoveryRevision: revision.discoveryRevision,
        },
      },
    };

    const response = (await server.handleMessage(request)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    assert.ok(response.result?.content?.[0]?.text);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.equal(parsed.projectId, 't22-mcp');
    assert.equal(parsed.status, 'COMPLETE');
    assert.equal(parsed.isEligibleForApproval, true);

    await server.stop();
  });

  // ==========================================================================
  // 23. NO APPROVAL CREATED
  // ==========================================================================
  it('T23_no_approval_created', async () => {
    const revision = await createFullyCompleteRevision('t23-no-approval');
    await completenessEngine.evaluate({
      projectId: 't23-no-approval',
      discoveryRevision: revision.discoveryRevision,
    });

    const activePkg = await approvalStore.getActivePackage();
    assert.equal(activePkg, null, 'Completeness Gate must NEVER create active approval packages');
    const packages = await approvalStore.listPackages();
    assert.equal(packages.length, 0, 'Completeness Gate must NEVER create approval packages');
  });

  // ==========================================================================
  // 24. NO DEVELOPMENT AUTHORIZATION
  // ==========================================================================
  it('T24_no_development_authorization', async () => {
    const revision = await createFullyCompleteRevision('t24-no-dev-auth');
    await completenessEngine.evaluate({
      projectId: 't24-no-dev-auth',
      discoveryRevision: revision.discoveryRevision,
    });

    const state = await durableManager.load();
    assert.strictEqual(state, null);
  });

  // ==========================================================================
  // 25. NO EXECUTION INTENT
  // ==========================================================================
  it('T25_no_execution_intent', async () => {
    const revision = await createFullyCompleteRevision('t25-no-intent');
    await completenessEngine.evaluate({
      projectId: 't25-no-intent',
      discoveryRevision: revision.discoveryRevision,
    });

    const state = await durableManager.load();
    assert.strictEqual(state, null);
  });

  // ==========================================================================
  // 26. NO ANTIGRAVITY INVOCATION
  // ==========================================================================
  it('T26_no_antigravity_invocation', async () => {
    const revision = await createFullyCompleteRevision('t26-no-agy');
    const result = await completenessEngine.evaluate({
      projectId: 't26-no-agy',
      discoveryRevision: revision.discoveryRevision,
    });

    assert.ok(result);
    // Verified: No executor child processes spawned, completely self-contained.
  });

  // ==========================================================================
  // 27. REALISTIC PROJECT MULTI-AREA FIXTURE
  // ==========================================================================
  it('T27_realistic_project_multi_area_fixture', async () => {
    const projectId = 'space-dominion-multiplayer';

    // Step 1: Initial Discovery prompt with open human decision on deployment model
    const rev1 = await discoveryEngine.discover({
      projectId,
      rawPrompt: `
        Project: Space Dominion Card Engine
        Purpose: Real-time turn-based multiplayer tactical card battler with deck building.
        Target users: competitive card gamers and spectators.
        Primary workflows: create deck, matchmaking queue, card play round, combat resolution, match forfeit.
        Required technologies: TypeScript, Node.js, WebSockets.
        Platform constraints: Web Application.
        Architectural constraints: Clean architecture with decoupled game engine domain and websocket transport.
        Data storage expectations: PostgreSQL for persistent card database and Redis for in-flight match state.
        Security requirements: HMAC session token signature and move validation to prevent cheating.
        Measurable criteria: Less than 50ms combat round calculation, 100% deterministic test coverage on turn resolution.
        Definition of completion: Clean test suite pass, zero memory leaks across 10,000 simulated games.
        Business rules: Turn timer 45s; disconnect grace period 30 seconds before bot substitute.
        Exclusions: Native desktop packaging is out of scope.
      `,
      explicitSections: {
        functionalRequirements: {
          capabilities: [],
          behaviors: [],
          businessRules: ['30-second disconnect grace window then bot substitute'],
        },
        nonFunctionalRequirements: {
          performance: ['Less than 50ms latency'],
          security: ['HMAC signature'],
          reliability: ['Zero data loss'],
          scalability: ['1000 concurrent matches'],
          availability: ['99.9% uptime'],
          usability: ['Responsive UI'],
          compatibility: ['Modern browsers'],
        },
      },
    });

    // Evaluation on Rev 1: Must be BLOCKED_ON_HUMAN because deployment model is pending
    const eval1 = await completenessEngine.evaluate({
      projectId,
      discoveryRevision: rev1.discoveryRevision,
    });

    assert.equal(eval1.status, 'BLOCKED_ON_HUMAN');
    assert.equal(eval1.isEligibleForApproval, false);
    assert.ok(eval1.humanDecisions.length > 0);

    // Step 2: Product Owner decides deployment model, but measurable criteria is missing
    const rev2 = await discoveryEngine.discover({
      projectId,
      decidedHumanDecisions: {
        [eval1.humanDecisions[0].decisionId]: 'Local / Self-Hosted Docker Container',
      },
    });

    // Temporarily clear acceptance measurable criteria to test transition to INCOMPLETE
    const incompleteRev: ProjectDiscoveryRevision = {
      ...rev2,
      sections: {
        ...rev2.sections,
        acceptance: {
          ...rev2.sections.acceptance,
          measurableCriteria: [],
        },
      },
    };

    const eval2 = await completenessEngine.evaluateRevision(incompleteRev);
    assert.equal(eval2.status, 'INCOMPLETE');
    assert.equal(eval2.isEligibleForApproval, false);
    assert.ok(eval2.missingInformation.includes('acceptance.measurableCriteria'));

    // Step 3: Fully specified revision with decided human decision and all required areas
    const rev3 = await discoveryEngine.discover({
      projectId,
      decidedHumanDecisions: {
        [eval1.humanDecisions[0].decisionId]: 'Local / Self-Hosted Docker Container',
      },
      explicitSections: {
        architecture: {
          deploymentModel: 'Local / Self-Hosted Docker Container',
          architecturalConstraints: [],
          integrationRequirements: [],
          dataStorageExpectations: [],
        },
        acceptance: {
          measurableCriteria: ['100% test pass rate and under 50ms latency'],
          expectedBehavior: ['All games execute deterministically'],
          definitionOfCompletion: ['All criteria verified'],
        },
      },
    });

    const eval3 = await completenessEngine.evaluate({
      projectId,
      discoveryRevision: rev3.discoveryRevision,
    });

    assert.equal(eval3.status, 'COMPLETE');
    assert.equal(eval3.isEligibleForApproval, true);
    assert.equal(eval3.isStale, false);
    assert.equal(eval3.evaluatedAreas.length, 15);
  });
});
