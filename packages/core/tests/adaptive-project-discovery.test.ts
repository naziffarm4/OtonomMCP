/**
 * Comprehensive Test Suite for Phase 15 Adaptive Project Discovery (TASK-P15-01)
 *
 * Verifies all 22 required discovery capabilities and security invariants:
 * 1. minimal project discovery
 * 2. full project discovery
 * 3. partial project discovery
 * 4. existing known information is preserved
 * 5. duplicate information does not create duplicate requirements
 * 6. deterministic normalization
 * 7. deterministic question identity
 * 8. blocking question detection
 * 9. non-blocking question detection
 * 10. informational question detection
 * 11. architecture-dependent question
 * 12. acceptance-dependent question
 * 13. business-rule-dependent question
 * 14. human decision detection
 * 15. revision creation
 * 16. previous revision preservation
 * 17. cross-project isolation
 * 18. malformed discovery input rejection
 * 19. deterministic fingerprint
 * 20. discovery does not create approval
 * 21. discovery does not create execution intent
 * 22. discovery does not invoke Antigravity
 * 23. MCP tool integration (aidm.project.discover with prompt)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  AdaptiveDiscoveryEngine,
  AdaptiveDiscoveryStore,
  DiscoveryValidationError,
  DiscoveryProjectBindingMismatchError,
  DiscoveryImmutableRevisionError,
  computeDeterministicFingerprint,
  createDeterministicQuestionId,
  createDeterministicRequirementId,
  deduplicateRequirements,
  deduplicateStrings,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_PROJECT_DISCOVER_TOOL_NAME,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Adaptive Project Discovery (TASK-P15-01)', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let approvalStore: ApprovalStore;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-01-discovery-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup fallback
    }
  });

  // ==========================================================================
  // 1. MINIMAL PROJECT DISCOVERY
  // ==========================================================================
  it('T01_minimal_project_discovery: executes discovery on minimal input and initializes all sections', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'minimal-cli',
      rawPrompt: 'Build a CLI utility tool',
    });

    assert.equal(revision.discoveryRevision, 1);
    assert.equal(revision.previousRevision, null);
    assert.equal(revision.projectId, 'minimal-cli');
    assert.ok(revision.sections.projectIdentity.name);
    assert.ok(revision.sections.projectIdentity.purpose);
    assert.ok(revision.sections.functionalRequirements.capabilities.length >= 1);
    assert.ok(revision.openQuestions.length > 0);
    assert.ok(revision.fingerprint.length === 64);
  });

  // ==========================================================================
  // 2. FULL PROJECT DISCOVERY
  // ==========================================================================
  it('T02_full_project_discovery: full specification resolves questions without redundant queries', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'full-okey-game',
      rawPrompt: 'I want to build a 4-player online Okey game with mobile support, accounts, rooms, scoring and reconnect using TypeScript and PostgreSQL deployed to local Docker container.',
      explicitSections: {
        technology: {
          requiredTechnologies: ['TypeScript', 'Node.js'],
          preferredTechnologies: ['PostgreSQL'],
          prohibitedTechnologies: [],
          platformConstraints: ['Mobile', 'Web'],
        },
        architecture: {
          architecturalConstraints: ['WebSocket server-authoritative engine'],
          integrationRequirements: [],
          deploymentModel: 'Local / Self-Hosted Docker Container',
          dataStorageExpectations: ['PostgreSQL relational database for accounts and match results'],
        },
        acceptance: {
          expectedBehavior: ['4-player game runs end-to-end with reconnect and scoring'],
          measurableCriteria: ['100% unit and integration test coverage', 'Reconnect restores state within 500ms'],
          definitionOfCompletion: ['All criteria satisfied and verified by automated QA'],
        },
        functionalRequirements: {
          capabilities: [],
          behaviors: [],
          businessRules: ['Player disconnect allows 60s grace duration before forfeit'],
        },
      },
    });

    assert.equal(revision.discoveryRevision, 1);
    assert.equal(revision.sections.technology.requiredTechnologies.includes('TypeScript'), true);
    assert.equal(revision.sections.architecture.deploymentModel, 'Local / Self-Hosted Docker Container');

    // Because platform, language, storage, and acceptance criteria were fully provided,
    // those specific questions are NOT generated.
    const platformQ = revision.openQuestions.find((q) => q.category === 'TECHNOLOGY' && q.question.includes('platform'));
    assert.equal(platformQ, undefined, 'Engine should not ask for platform when already specified');

    const storageQ = revision.openQuestions.find((q) => q.category === 'ARCHITECTURE' && q.question.includes('persistence engine'));
    assert.equal(storageQ, undefined, 'Engine should not ask for storage when PostgreSQL was already selected');
  });

  // ==========================================================================
  // 3. PARTIAL PROJECT DISCOVERY
  // ==========================================================================
  it('T03_partial_project_discovery: identifies specified vs missing information adaptively', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'partial-okey',
      rawPrompt: 'I want to build a 4-player online Okey game with mobile support, accounts, rooms, scoring and reconnect.',
    });

    // Specified in prompt:
    assert.ok(revision.sections.technology.platformConstraints.some((p) => p.includes('Mobile')));
    assert.ok(revision.sections.functionalRequirements.capabilities.some((c) => c.title.includes('Account')));
    assert.ok(revision.sections.functionalRequirements.capabilities.some((c) => c.title.includes('Room')));
    assert.ok(revision.sections.functionalRequirements.capabilities.some((c) => c.title.includes('Scoring')));
    assert.ok(revision.sections.functionalRequirements.capabilities.some((c) => c.title.includes('Reconnect')));

    // Unspecified in prompt (missing details that require decisions):
    // Data storage architecture (SQL vs NoSQL) is missing
    const dbQuestion = revision.openQuestions.find((q) => q.category === 'ARCHITECTURE');
    assert.ok(dbQuestion, 'Expected storage architecture question for accounts/rooms/scores');
    assert.equal(dbQuestion?.classification, 'BLOCKING');

    // Platform question should NOT be asked because mobile was specified
    const platformQ = revision.openQuestions.find((q) => q.category === 'TECHNOLOGY' && q.question.includes('platform'));
    assert.equal(platformQ, undefined, 'Platform question should not be asked when mobile was specified');
  });

  // ==========================================================================
  // 4. EXISTING KNOWN INFORMATION IS PRESERVED
  // ==========================================================================
  it('T04_existing_known_information_preserved: integrates existing SpecStore requirements and decisions', async () => {
    await specStore.saveRequirements([
      {
        id: 'REQ-101',
        title: 'Player Session Security',
        description: 'Session tokens must be signed with HMAC-SHA256.',
        status: 'LOCKED',
      },
    ]);
    await specStore.saveDecisions([
      {
        id: 'DEC-101',
        title: 'Use Redis for Session Caching',
        description: 'Store volatile game room state in Redis.',
        status: 'LOCKED',
      },
    ]);

    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'preservation-test',
      rawPrompt: 'Add tournament matchmaking',
    });

    // Existing requirement from SpecStore must be preserved
    assert.ok(
      revision.requirements.some((r) => r.id === 'REQ-101' && r.title === 'Player Session Security'),
      'Existing SpecStore requirement must be preserved'
    );
    // Existing decision from SpecStore must be preserved
    assert.ok(
      revision.decisions.some((d) => d.id === 'DEC-101' && d.title === 'Use Redis for Session Caching'),
      'Existing SpecStore decision must be preserved'
    );
  });

  // ==========================================================================
  // 5. DUPLICATE INFORMATION DOES NOT CREATE DUPLICATE REQUIREMENTS
  // ==========================================================================
  it('T05_duplicate_information_deduplication: deduplicates repeated requirements deterministically', async () => {
    const rawReqs = [
      {
        id: 'REQ-01',
        title: 'User Login',
        description: 'Authenticate user with username and password',
        businessRules: ['Rule 1', 'Rule 1', 'Rule 2'],
        source: 'TEST',
      },
      {
        id: 'REQ-02',
        title: 'User Login',
        description: 'Authenticate user with username and password',
        businessRules: ['Rule 2'],
        source: 'TEST',
      },
      {
        id: 'REQ-03',
        title: 'User Logout',
        description: 'Terminate active session',
        businessRules: [],
        source: 'TEST',
      },
    ];

    const deduplicated = deduplicateRequirements(rawReqs);
    assert.equal(deduplicated.length, 2, 'Should deduplicate identical title + description');
    assert.equal(deduplicated[0].businessRules.length, 2, 'Should deduplicate business rules');

    // Also verify via engine
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'dedup-test',
      explicitSections: {
        functionalRequirements: {
          capabilities: rawReqs,
          behaviors: ['Login', 'Login'],
          businessRules: ['Rule A', 'Rule A', 'Rule B'],
        },
      },
    });

    assert.equal(revision.requirements.length, 2);
    assert.equal(revision.sections.functionalRequirements.behaviors.length, 1);
    assert.equal(revision.sections.functionalRequirements.businessRules.length, 2);
  });

  // ==========================================================================
  // 6. DETERMINISTIC NORMALIZATION
  // ==========================================================================
  it('T06_deterministic_normalization: equivalent input with different whitespace/ordering normalizes identically', () => {
    const stringsA = ['  alpha ', 'BETA', '  gamma  '];
    const stringsB = ['alpha', '  BETA  ', 'gamma'];

    const dedupA = deduplicateStrings(stringsA);
    const dedupB = deduplicateStrings(stringsB);

    assert.deepEqual(dedupA, dedupB);

    const fpA = computeDeterministicFingerprint({ items: dedupA, flag: true });
    const fpB = computeDeterministicFingerprint({ flag: true, items: dedupB });

    assert.equal(fpA, fpB, 'Fingerprints of equivalent normalized structures must match exactly');
  });

  // ==========================================================================
  // 7. DETERMINISTIC QUESTION IDENTITY
  // ==========================================================================
  it('T07_deterministic_question_identity: question IDs are stable, repeatable, and non-random', () => {
    const id1 = createDeterministicQuestionId(
      'ARCHITECTURE',
      'What data storage architecture and persistence engine should be adopted?',
      'architecture'
    );
    const id2 = createDeterministicQuestionId(
      'ARCHITECTURE',
      'What data storage architecture and persistence engine should be adopted?',
      'architecture'
    );
    const idDiff = createDeterministicQuestionId(
      'ARCHITECTURE',
      'Different question text?',
      'architecture'
    );

    assert.equal(id1, id2, 'Identical questions must have strictly identical IDs');
    assert.notEqual(id1, idDiff, 'Different questions must have different IDs');
    assert.ok(id1.startsWith('Q-ARCHITECTURE-'));
  });

  // ==========================================================================
  // 8. BLOCKING QUESTION DETECTION
  // ==========================================================================
  it('T08_blocking_question_detection: critical missing architecture or scope is classified as BLOCKING', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'blocking-test',
      rawPrompt: 'Build an online multiplayer trading platform',
    });

    const blockingQuestions = revision.openQuestions.filter((q) => q.classification === 'BLOCKING');
    assert.ok(blockingQuestions.length > 0, 'Expected at least one BLOCKING question for unstated architecture/database');
    assert.ok(blockingQuestions.some((q) => q.category === 'ARCHITECTURE' || q.category === 'TECHNOLOGY'));
  });

  // ==========================================================================
  // 9. NON-BLOCKING QUESTION DETECTION
  // ==========================================================================
  it('T09_non_blocking_question_detection: optional integrations are classified as NON_BLOCKING', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'non-blocking-test',
      rawPrompt: 'Build a calculator CLI',
    });

    const nonBlocking = revision.openQuestions.filter((q) => q.classification === 'NON_BLOCKING');
    assert.ok(nonBlocking.length > 0, 'Expected at least one NON_BLOCKING question');
    assert.ok(nonBlocking.some((q) => q.category === 'NON_FUNCTIONAL_REQUIREMENTS'));
  });

  // ==========================================================================
  // 10. INFORMATIONAL QUESTION DETECTION
  // ==========================================================================
  it('T10_informational_question_detection: cosmetic/doc preferences are classified as INFORMATIONAL', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'info-test',
      rawPrompt: 'Simple helper script',
    });

    const informational = revision.openQuestions.filter((q) => q.classification === 'INFORMATIONAL');
    assert.ok(informational.length > 0, 'Expected at least one INFORMATIONAL question');
    assert.ok(informational.some((q) => q.category === 'PROJECT_IDENTITY'));
  });

  // ==========================================================================
  // 11. ARCHITECTURE-DEPENDENT QUESTION
  // ==========================================================================
  it('T11_architecture_dependent_question: accounts and rooms trigger explicit storage architecture question', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'arch-dep-test',
      rawPrompt: 'Game with player accounts, rooms, and high scores',
    });

    const archQ = revision.openQuestions.find((q) => q.category === 'ARCHITECTURE');
    assert.ok(archQ, 'Expected architecture question');
    assert.equal(archQ?.classification, 'BLOCKING');
    assert.equal(archQ?.dependentSection, 'architecture');
    assert.ok(archQ?.whatItAffects.includes('architecture'));
  });

  // ==========================================================================
  // 12. ACCEPTANCE-DEPENDENT QUESTION
  // ==========================================================================
  it('T12_acceptance_dependent_question: missing measurable criteria triggers acceptance question', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'acceptance-dep-test',
      explicitSections: {
        acceptance: {
          expectedBehavior: ['Works as expected'],
          measurableCriteria: [], // Missing!
          definitionOfCompletion: [],
        },
      },
    });

    const acceptQ = revision.openQuestions.find((q) => q.category === 'ACCEPTANCE');
    assert.ok(acceptQ, 'Expected acceptance-dependent question');
    assert.equal(acceptQ?.classification, 'BLOCKING');
    assert.equal(acceptQ?.dependentSection, 'acceptance');
  });

  // ==========================================================================
  // 13. BUSINESS-RULE-DEPENDENT QUESTION
  // ==========================================================================
  it('T13_business_rule_dependent_question: reconnect feature without disconnect grace rule triggers question', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'business-rule-test',
      rawPrompt: 'Game with live reconnect',
    });

    const ruleQ = revision.openQuestions.find(
      (q) => q.category === 'FUNCTIONAL_REQUIREMENTS' && q.question.includes('grace period')
    );
    assert.ok(ruleQ, 'Expected business-rule-dependent question for reconnect grace duration');
    assert.equal(ruleQ?.classification, 'BLOCKING');
    assert.equal(ruleQ?.dependentSection, 'functionalRequirements');
  });

  // ==========================================================================
  // 14. HUMAN DECISION DETECTION
  // ==========================================================================
  it('T14_human_decision_detection: identifies choices reserved strictly for Product Owner authority', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'human-decision-test',
      rawPrompt: 'Online multiplayer card game with player accounts',
    });

    assert.ok(revision.decisions.length >= 1, 'Expected at least 1 Human Decision Point');
    const storageDecision = revision.decisions.find((d) => d.title.includes('Database'));
    assert.ok(storageDecision, 'Expected Database paradigm selection decision');
    assert.equal(storageDecision?.authority, 'USER', 'Human decision must have USER/PO authority');
    assert.ok(
      storageDecision?.status === 'PENDING_DECISION' || storageDecision?.status === 'PROPOSED',
      'Engine must not silently pick an alternative (expected PENDING_DECISION or PROPOSED)'
    );
    assert.ok((storageDecision?.alternatives.length ?? 0) >= 2);
  });

  // ==========================================================================
  // 15. REVISION CREATION
  // ==========================================================================
  it('T15_revision_creation: creates sequential discovery revisions on incremental discovery', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    // Revision 1: initial discovery
    const rev1 = await engine.discover({
      projectId: 'rev-test',
      rawPrompt: 'Build an inventory manager',
    });
    assert.equal(rev1.discoveryRevision, 1);
    assert.equal(rev1.previousRevision, null);

    // Revision 2: provide answers to questions
    const q1 = rev1.openQuestions[0];
    const answers: Record<string, string> = {};
    if (q1) answers[q1.id] = 'Selected answer for testing';

    const rev2 = await engine.discover({
      projectId: 'rev-test',
      resolvedAnswers: answers,
    });
    assert.equal(rev2.discoveryRevision, 2);
    assert.equal(rev2.previousRevision, 1);
    assert.ok(rev2.changedSections.length > 0);
  });

  // ==========================================================================
  // 16. PREVIOUS REVISION PRESERVATION
  // ==========================================================================
  it('T16_previous_revision_preservation: historical discovery revision is immutable and preserved intact', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const rev1 = await engine.discover({
      projectId: 'immutability-test',
      rawPrompt: 'Initial concept description',
    });

    await engine.discover({
      projectId: 'immutability-test',
      rawPrompt: 'Updated progressive refinement with additional constraints',
    });

    // Load historical revision 1
    const loadedRev1 = await discoveryStore.loadRevision('immutability-test', 1);
    assert.ok(loadedRev1);
    assert.equal(loadedRev1.discoveryRevision, 1);
    assert.equal(loadedRev1.fingerprint, rev1.fingerprint);

    // Attempting to overwrite rev1 directly via store must fail
    await assert.rejects(
      async () => {
        await discoveryStore.saveRevision(rev1);
      },
      (err) => err instanceof DiscoveryImmutableRevisionError
    );
  });

  // ==========================================================================
  // 17. CROSS-PROJECT ISOLATION
  // ==========================================================================
  it('T17_cross_project_isolation: prevents cross-project discovery contamination and path traversal', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    await engine.discover({
      projectId: 'project-alpha',
      rawPrompt: 'Alpha project intent',
    });
    await engine.discover({
      projectId: 'project-beta',
      rawPrompt: 'Beta project intent',
    });

    const alphaRevs = await discoveryStore.listRevisions('project-alpha');
    const betaRevs = await discoveryStore.listRevisions('project-beta');

    assert.equal(alphaRevs.length, 1);
    assert.equal(betaRevs.length, 1);

    // Path traversal in projectId must be rejected
    assert.throws(
      () => {
        discoveryStore.sanitizeProjectId('../../../etc/passwd');
      },
      (err) => err instanceof DiscoveryValidationError
    );
  });

  // ==========================================================================
  // 18. MALFORMED DISCOVERY INPUT REJECTION
  // ==========================================================================
  it('T18_malformed_discovery_input_rejection: malformed schema or invalid revision throws DiscoveryValidationError', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    await assert.rejects(
      async () => {
        await engine.discover({
          projectId: 'valid-id',
          resolvedAnswers: 12345 as unknown as Record<string, string>,
        });
      },
      (err) => err instanceof DiscoveryValidationError
    );

    await assert.rejects(
      async () => {
        await discoveryStore.loadRevision('valid-id', -1);
      },
      (err) => err instanceof DiscoveryValidationError
    );
  });

  // ==========================================================================
  // 19. DETERMINISTIC FINGERPRINT
  // ==========================================================================
  it('T19_deterministic_fingerprint: identical normalized discovery input produces identical fingerprint', () => {
    const dataA = {
      projectId: 'proj-1',
      purpose: 'Online store',
      scope: ['Cart', 'Checkout'],
    };
    const dataB = {
      scope: ['Cart', 'Checkout'],
      projectId: 'proj-1',
      purpose: 'Online store',
    };

    const fpA = computeDeterministicFingerprint(dataA);
    const fpB = computeDeterministicFingerprint(dataB);

    assert.equal(fpA, fpB, 'Fingerprint must be independent of key insertion order');
  });

  // ==========================================================================
  // 20. DISCOVERY DOES NOT CREATE APPROVAL
  // ==========================================================================
  it('T20_discovery_does_not_create_approval: approval packages remain untouched during discovery', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    await engine.discover({
      projectId: 'no-approval-test',
      rawPrompt: 'Ready to build project',
    });

    const activePkg = await approvalStore.getActivePackage();
    assert.equal(activePkg, null, 'Discovery must NOT create or approve an ApprovalPackage');
  });

  // ==========================================================================
  // 21. DISCOVERY DOES NOT CREATE EXECUTION INTENT
  // ==========================================================================
  it('T21_discovery_does_not_create_execution_intent: durable state and task DAG remain unexecuted', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
      durableStateManager: durableManager,
    });

    await engine.discover({
      projectId: 'no-intent-test',
      rawPrompt: 'Implement task 1 immediately',
    });

    const stateExists = await durableManager.exists();
    assert.equal(stateExists, false, 'Discovery must NOT mutate durable state or create execution intent');
  });

  // ==========================================================================
  // 22. DISCOVERY DOES NOT INVOKE ANTIGRAVITY
  // ==========================================================================
  it('T22_discovery_does_not_invoke_antigravity: discovery completes without calling executor processes', async () => {
    const engine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    const revision = await engine.discover({
      projectId: 'no-antigravity-test',
      rawPrompt: 'Run antigravity executor now',
    });

    const json = JSON.stringify(revision);
    assert.equal(json.includes('ANTIGRAVITY_RUN'), false);
    assert.equal(json.includes('EXECUTION_DISPATCH'), false);
  });

  // ==========================================================================
  // 23. MCP TOOL INTEGRATION (aidm.project.discover with prompt)
  // ==========================================================================
  it('T23_mcp_tool_adaptive_discover: executes adaptive discovery through MCP boundary', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
    });
    await server.start();

    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          projectId: 'mcp-adaptive-project',
          prompt: 'I want to build a real-time chat application with web and mobile support.',
        },
      },
    };

    const res = (await server.handleMessage(req)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    await server.stop();

    assert.ok(res.result?.content?.[0]?.text);
    const parsedRevision = JSON.parse(res.result.content[0].text);

    assert.equal(parsedRevision.projectId, 'mcp-adaptive-project');
    assert.equal(parsedRevision.discoveryRevision, 1);
    assert.ok(parsedRevision.sections.projectIdentity.name);
    assert.ok(parsedRevision.openQuestions.length > 0);
  });
});
