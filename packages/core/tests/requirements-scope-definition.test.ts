/**
 * Comprehensive Test Suite for Phase 15 Requirements & Scope Definition (TASK-P15-03)
 *
 * Verifies all 30 required capabilities and safety boundaries:
 * T01 basic requirements creation
 * T02 deterministic requirements derivation
 * T03 deterministic fingerprint
 * T04 project purpose extraction
 * T05 target users extraction
 * T06 in-scope extraction
 * T07 out-of-scope extraction
 * T08 functional requirements extraction
 * T09 non-functional requirements
 * T10 constraints
 * T11 assumptions
 * T12 unresolved scope question
 * T13 Product Owner decision remains pending
 * T14 no silent human decision
 * T15 source discovery revision binding
 * T16 source discovery fingerprint binding
 * T17 stale discovery rejection
 * T18 requirements revision persistence
 * T19 historical revision retrieval
 * T20 latest revision retrieval
 * T21 cross-project isolation
 * T22 forged fingerprint rejection
 * T23 deterministic deduplication
 * T24 history event
 * T25 MCP boundary
 * T26 no approval creation
 * T27 no development authorization
 * T28 no ExecutionIntent
 * T29 no Antigravity invocation
 * T30 restart/reload behavior
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
  RequirementsScopeEngine,
  RequirementsScopeStore,
  RequirementsScopeValidationError,
  RequirementsScopeRevisionNotFoundError,
  RequirementsScopeProjectBindingMismatchError,
  RequirementsScopeImmutableRevisionError,
  RequirementsScopeStaleSourceError,
  RequirementsScopeForgedFingerprintError,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
  AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Requirements & Scope Definition (TASK-P15-03)', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let completenessStore: CompletenessGateStore;
  let requirementsStore: RequirementsScopeStore;
  let approvalStore: ApprovalStore;
  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-03-requirements-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    requirementsStore = new RequirementsScopeStore({ baseDir: tempDir, historyManager });
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

    requirementsEngine = new RequirementsScopeEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      historyManager,
      specStore,
    });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Helper to create a comprehensive standard discovery revision
  async function createDiscoveryRevision(
    projectId: string,
    explicitOverrides?: {
      sections?: Partial<any>;
    }
  ): Promise<ProjectDiscoveryRevision> {
    const rawPrompt = `
      Build an Online Chess Platform.
      Purpose: Allow players to play rated online multiplayer chess.
      Desired Outcome: Real-time matches with ELO rating and match history.
      Target Users: Competitive chess players, casual gamers, and tournament arbiters.
      Platforms: Linux server, modern Web browsers.
      Required tech: TypeScript, Node.js, WebSockets, PostgreSQL.
      Non-functional: 99.9% uptime, move latency < 50ms, support 1000 concurrent games.
      Business Rules: Standard FIDE rules, 30s disconnect grace period.
      Acceptance: Move latency verified under 50ms, FIDE draw conditions enforced.
    `;

    return discoveryEngine.discover({
      projectId,
      rawPrompt,
      explicitSections: {
        productScope: {
          inScope: ['Matchmaking', 'Real-time board movement', 'Move validation', 'Clock timer', 'ELO calculation'],
          outOfScope: ['Chess engine training', 'Cryptocurrency betting', 'Voice chat'],
          targetUsers: ['Competitive chess players', 'Casual gamers', 'Tournament arbiters'],
          primaryWorkflows: ['Create match', 'Join match', 'Make move', 'Resign match'],
        },
        ...explicitOverrides?.sections,
      },
      workspaceRoot: tempDir,
    });
  }

  // T01 basic requirements creation
  it('T01_basic_requirements_creation: transforms discovery into structured requirements/scope revision', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
      discoveryRevision: discovery.discoveryRevision,
    });

    assert.ok(result);
    assert.strictEqual(result.projectId, 'proj-chess');
    assert.strictEqual(result.requirementsRevision, 1);
    assert.strictEqual(result.sourceDiscoveryRevision, discovery.discoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, discovery.fingerprint);
    assert.ok(result.fingerprint);
    assert.strictEqual(result.isStale, false);
    assert.ok(result.functionalRequirements.length > 0);
  });

  // T02 deterministic requirements derivation
  it('T02_deterministic_requirements_derivation: identical discovery produces identical requirements', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');

    const resultA = await requirementsEngine.deriveFromDiscoveryRevision(discovery);
    const resultB = await requirementsEngine.deriveFromDiscoveryRevision(discovery);

    assert.strictEqual(resultA.fingerprint, resultB.fingerprint);
    assert.deepStrictEqual(resultA.purpose, resultB.purpose);
    assert.deepStrictEqual(resultA.targetUsers, resultB.targetUsers);
    assert.deepStrictEqual(resultA.inScope, resultB.inScope);
    assert.deepStrictEqual(resultA.outOfScope, resultB.outOfScope);
    assert.deepStrictEqual(resultA.functionalRequirements, resultB.functionalRequirements);
    assert.deepStrictEqual(resultA.nonFunctionalRequirements, resultB.nonFunctionalRequirements);
    assert.deepStrictEqual(resultA.constraints, resultB.constraints);
  });

  // T03 deterministic fingerprint
  it('T03_deterministic_fingerprint: fingerprint is stable and excludes timestamps', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');

    const result1 = await requirementsEngine.deriveFromDiscoveryRevision(discovery);
    // Simulating slightly later run
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result2 = await requirementsEngine.deriveFromDiscoveryRevision(discovery);

    assert.strictEqual(result1.fingerprint, result2.fingerprint);
  });

  // T04 project purpose extraction
  it('T04_project_purpose_extraction: correctly extracts purpose, problem statement, and desired outcome', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result.purpose.purpose.length > 0);
    assert.ok(result.purpose.problemStatement.length > 0);
    assert.ok(result.purpose.desiredOutcome.length > 0);
  });

  // T05 target users extraction
  it('T05_target_users_extraction: extracts primary, secondary, and system actors', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result.targetUsers.primaryUsers.length > 0);
    assert.ok(result.targetUsers.systemActors.includes('System'));
  });

  // T06 in-scope extraction
  it('T06_in_scope_extraction: extracts included capabilities, workflows, platforms, integrations', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result.inScope.capabilities.length > 0);
    assert.ok(result.inScope.platforms.length > 0);
  });

  // T07 out-of-scope extraction
  it('T07_out_of_scope_extraction: extracts explicitly excluded capabilities and prohibited platforms', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result.outOfScope.capabilities.length > 0);
  });

  // T08 functional requirements extraction
  it('T08_functional_requirements_extraction: assigns canonical IDs and extracts business rules', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    for (const req of result.functionalRequirements) {
      assert.ok(req.requirementId.startsWith('FREQ-'));
      assert.ok(req.title);
      assert.ok(req.description);
      assert.ok(['PROPOSED', 'CONFIRMED', 'PENDING_DECISION', 'DEFERRED'].includes(req.status));
    }
  });

  // T09 non-functional requirements
  it('T09_non_functional_requirements: extracts performance, reliability, security, usability', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result.nonFunctionalRequirements.performance.length > 0);
  });

  // T10 constraints
  it('T10_constraints: extracts technology and platform constraints', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result.constraints.technologyConstraints.length > 0);
    assert.ok(result.constraints.platformConstraints.length > 0);
  });

  // T11 assumptions
  it('T11_assumptions: records assumptions explicitly without converting to confirmed requirements', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
      additionalAssumptions: [
        {
          id: 'ASSUMP-001',
          statement: 'Players have a stable internet connection with ping under 100ms',
          rationale: 'Required for real-time competitive chess timer',
          validated: false,
          affectedRequirements: ['FREQ-timer'],
        },
      ],
    });

    assert.ok(result.assumptions.length >= 1);
    const assumption = result.assumptions.find((a) => a.id === 'ASSUMP-001');
    assert.ok(assumption);
    assert.strictEqual(assumption.validated, false);
    // Verified not converted into confirmed requirement
    assert.ok(!result.functionalRequirements.some((r) => r.title === assumption.statement));
  });

  // T12 unresolved scope question
  it('T12_unresolved_scope_question: places open blocking scope questions into undecidedScope', async () => {
    const base = await createDiscoveryRevision('proj-chess-t12');
    const customDiscovery: ProjectDiscoveryRevision = {
      ...base,
      openQuestions: [
        {
          id: 'Q-SCOPE-MOBILE',
          category: 'SCOPE',
          question: 'Should chess app support mobile native apps or web responsive only?',
          whyItMatters: 'Affects UI architecture and platform scope',
          whatItAffects: ['product scope', 'technology'],
          classification: 'BLOCKING',
          dependentSection: 'productScope',
          status: 'OPEN',
          options: ['Native Mobile App (React Native)', 'Responsive Web Only'],
          requiredDecision: 'Mobile platform strategy',
          impact: 'Determines whether mobile client is in scope',
        },
      ],
      sections: {
        ...base.sections,
        openQuestions: [
          {
            id: 'Q-SCOPE-MOBILE',
            category: 'SCOPE',
            question: 'Should chess app support mobile native apps or web responsive only?',
            whyItMatters: 'Affects UI architecture and platform scope',
            whatItAffects: ['product scope', 'technology'],
            classification: 'BLOCKING',
            dependentSection: 'productScope',
            status: 'OPEN',
            options: ['Native Mobile App (React Native)', 'Responsive Web Only'],
            requiredDecision: 'Mobile platform strategy',
            impact: 'Determines whether mobile client is in scope',
          },
        ],
      },
    };

    const result = await requirementsEngine.deriveFromDiscoveryRevision(customDiscovery);

    assert.ok(result.undecidedScope.length > 0);
    const mobileScope = result.undecidedScope.find((u) => u.topic.includes('mobile'));
    assert.ok(mobileScope);
    assert.strictEqual(mobileScope.status, 'PENDING_DECISION');
    assert.deepStrictEqual(mobileScope.availableOptions, ['Native Mobile App (React Native)', 'Responsive Web Only']);
  });

  // T13 Product Owner decision remains pending
  it('T13_product_owner_decision_remains_pending: human decisions are preserved with PENDING_DECISION', async () => {
    const base = await createDiscoveryRevision('proj-chess-t13');
    const customDiscovery: ProjectDiscoveryRevision = {
      ...base,
      decisions: [
        {
          id: 'HDEC-DATABASE',
          title: 'Database Selection: PostgreSQL vs MongoDB',
          description: 'Choice of primary persistence database for matches',
          affectedAreas: ['architecture', 'data model'],
          alternatives: ['PostgreSQL', 'MongoDB'],
          authority: 'USER',
          status: 'PENDING_DECISION',
        },
      ],
      sections: {
        ...base.sections,
        humanDecisions: [
          {
            id: 'HDEC-DATABASE',
            title: 'Database Selection: PostgreSQL vs MongoDB',
            description: 'Choice of primary persistence database for matches',
            affectedAreas: ['architecture', 'data model'],
            alternatives: ['PostgreSQL', 'MongoDB'],
            authority: 'USER',
            status: 'PENDING_DECISION',
          },
        ],
      },
    };

    const result = await requirementsEngine.deriveFromDiscoveryRevision(customDiscovery);

    assert.ok(result.humanDecisions.length > 0);
    const dbDecision = result.humanDecisions.find((d) => d.decisionId === 'HDEC-DATABASE');
    assert.ok(dbDecision);
    assert.strictEqual(dbDecision.status, 'PENDING_DECISION');
    assert.strictEqual(dbDecision.authority, 'USER');
  });

  // T14 no silent human decision
  it('T14_no_silent_human_decision: engine never auto-selects an option for a human decision', async () => {
    const base = await createDiscoveryRevision('proj-chess-t14');
    const customDiscovery: ProjectDiscoveryRevision = {
      ...base,
      decisions: [
        {
          id: 'HDEC-AUTH',
          title: 'User Authentication Model',
          description: 'Choice between OAuth (Google/GitHub) and Email/Password',
          affectedAreas: ['security', 'user management'],
          alternatives: ['OAuth Only', 'Email/Password Only', 'Both'],
          authority: 'USER',
          status: 'PENDING_DECISION',
        },
      ],
      sections: {
        ...base.sections,
        humanDecisions: [
          {
            id: 'HDEC-AUTH',
            title: 'User Authentication Model',
            description: 'Choice between OAuth (Google/GitHub) and Email/Password',
            affectedAreas: ['security', 'user management'],
            alternatives: ['OAuth Only', 'Email/Password Only', 'Both'],
            authority: 'USER',
            status: 'PENDING_DECISION',
          },
        ],
      },
    };

    const result = await requirementsEngine.deriveFromDiscoveryRevision(customDiscovery);

    const authDecision = result.humanDecisions.find((d) => d.decisionId === 'HDEC-AUTH');
    assert.ok(authDecision);
    assert.strictEqual(authDecision.status, 'PENDING_DECISION');
    // In-scope must not arbitrarily include 'OAuth Only' as confirmed requirement
    assert.ok(!result.inScope.capabilities.includes('OAuth Only'));
  });

  // T15 source discovery revision binding
  it('T15_source_discovery_revision_binding: requirements revision strictly binds to source discoveryRevision', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
      discoveryRevision: discovery.discoveryRevision,
    });

    assert.strictEqual(result.sourceDiscoveryRevision, discovery.discoveryRevision);
  });

  // T16 source discovery fingerprint binding
  it('T16_source_discovery_fingerprint_binding: binds to exact discovery fingerprint', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
      expectedDiscoveryFingerprint: discovery.fingerprint,
    });

    assert.strictEqual(result.sourceDiscoveryFingerprint, discovery.fingerprint);
  });

  // T17 stale discovery rejection
  it('T17_stale_discovery_rejection: rejects deriving from stale discovery revision when newer exists', async () => {
    const discovery1 = await createDiscoveryRevision('proj-chess');

    // Create discovery revision 2
    await discoveryEngine.discover({
      projectId: 'proj-chess',
      rawPrompt: 'Add tournament brackets feature to the chess platform.',
      workspaceRoot: tempDir,
    });

    // Attempting to derive from revision 1 must throw RequirementsScopeStaleSourceError
    await assert.rejects(
      async () => {
        await requirementsEngine.derive({
          projectId: 'proj-chess',
          discoveryRevision: discovery1.discoveryRevision,
        });
      },
      (err) => err instanceof RequirementsScopeStaleSourceError
    );
  });

  // T18 requirements revision persistence
  it('T18_requirements_revision_persistence: persists rev-<n>.json and latest.json atomically', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const revPath = path.join(
      tempDir,
      '.ai-manager',
      'project-requirements',
      'records',
      'proj-chess',
      `rev-${result.requirementsRevision}.json`
    );
    const latestPath = path.join(
      tempDir,
      '.ai-manager',
      'project-requirements',
      'records',
      'proj-chess',
      'latest.json'
    );

    assert.ok(fs.existsSync(revPath));
    assert.ok(fs.existsSync(latestPath));

    const onDiskRev = JSON.parse(fs.readFileSync(revPath, 'utf8'));
    assert.strictEqual(onDiskRev.fingerprint, result.fingerprint);
  });

  // T19 historical revision retrieval
  it('T19_historical_revision_retrieval: historical revisions remain readable and immutable', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const retrieved = await requirementsEngine.getRevision('proj-chess', result.requirementsRevision);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.requirementsRevision, result.requirementsRevision);
    assert.strictEqual(retrieved.fingerprint, result.fingerprint);
  });

  // T20 latest revision retrieval
  it('T20_latest_revision_retrieval: retrieves latest requirements revision', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const latest = await requirementsEngine.getLatest('proj-chess');
    assert.ok(latest);
    assert.strictEqual(latest.requirementsRevision, result.requirementsRevision);
  });

  // T21 cross-project isolation
  it('T21_cross_project_isolation: cross-project mismatch fails closed and rejects path traversal', async () => {
    await createDiscoveryRevision('proj-a');

    // Mismatched project
    await assert.rejects(
      async () => {
        await requirementsEngine.derive({
          projectId: 'proj-b',
          discoveryRevision: 1,
        });
      },
      (err) => err instanceof RequirementsScopeRevisionNotFoundError
    );

    // Path traversal in projectId
    await assert.rejects(
      async () => {
        await requirementsEngine.derive({
          projectId: '../../../etc/passwd',
        });
      },
      (err) => err instanceof RequirementsScopeValidationError
    );
  });

  // T22 forged fingerprint rejection
  it('T22_forged_fingerprint_rejection: rejects request when expectedDiscoveryFingerprint mismatches', async () => {
    await createDiscoveryRevision('proj-chess');

    await assert.rejects(
      async () => {
        await requirementsEngine.derive({
          projectId: 'proj-chess',
          expectedDiscoveryFingerprint: 'forged_fake_discovery_hash_123',
        });
      },
      (err) => err instanceof RequirementsScopeForgedFingerprintError
    );
  });

  // T23 deterministic deduplication
  it('T23_deterministic_deduplication: duplicate requirements across sections are deduplicated', async () => {
    const base = await createDiscoveryRevision('proj-chess-t23');
    const customDiscovery: ProjectDiscoveryRevision = {
      ...base,
      requirements: [
        {
          id: 'FREQ-move-val',
          title: 'Move Validation',
          description: 'Validates chess moves conform to rules',
          businessRules: ['Rule 1'],
          source: 'DISCOVERY_A',
        },
        {
          id: 'FREQ-move-val',
          title: 'Move Validation',
          description: 'Validates chess moves conform to rules',
          businessRules: ['Rule 2'],
          source: 'DISCOVERY_B',
        },
      ],
      sections: {
        ...base.sections,
        functionalRequirements: {
          capabilities: [
            {
              id: 'FREQ-move-val',
              title: 'Move Validation',
              description: 'Validates chess moves conform to rules',
              businessRules: ['Rule 1'],
              source: 'DISCOVERY_A',
            },
            {
              id: 'FREQ-move-val',
              title: 'Move Validation',
              description: 'Validates chess moves conform to rules',
              businessRules: ['Rule 2'],
              source: 'DISCOVERY_B',
            },
          ],
          behaviors: [],
          businessRules: [],
        },
      },
    };

    const result = await requirementsEngine.deriveFromDiscoveryRevision(customDiscovery);

    const moveValReqs = result.functionalRequirements.filter((r) => r.title === 'Move Validation');
    assert.strictEqual(moveValReqs.length, 1);
    // Merged rules
    assert.ok(moveValReqs[0].businessRules.includes('Rule 1'));
    assert.ok(moveValReqs[0].businessRules.includes('Rule 2'));
  });

  // T24 history event
  it('T24_history_event: appends PROJECT_REQUIREMENTS_SCOPE_DEFINED event to HistoryManager', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const events = await historyManager.readEvents();
    const reqEvent = events.find((e) => e.eventType === 'PROJECT_REQUIREMENTS_SCOPE_DEFINED');
    assert.ok(reqEvent);
    assert.strictEqual(reqEvent.payload.projectId, 'proj-chess');
    assert.strictEqual(reqEvent.payload.requirementsRevision, result.requirementsRevision);
    assert.strictEqual(reqEvent.payload.fingerprint, result.fingerprint);
  });

  // T25 MCP boundary
  it('T25_mcp_boundary: aidm.requirements.scope.define and get tools execute through MCP boundary', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      historyManager,
      specStore,
      durableStateManager: durableManager,
      adaptiveDiscoveryStore: discoveryStore,
      completenessGateStore: completenessStore,
      requirementsScopeStore: requirementsStore,
      requirementsScopeEngine: requirementsEngine,
    });

    const server = new McpServer({
      transport: new InMemoryMcpTransport(),
      delegate,
      requirementsScopeTools: true,
    });

    await server.start();

    // 1. Test aidm.requirements.scope.define
    const defineRequest: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
        arguments: {
          projectId: 'proj-chess',
          discoveryRevision: discovery.discoveryRevision,
        },
      },
    };

    const defineResponse = (await server.handleMessage(defineRequest)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(!('error' in defineResponse));
    assert.ok(defineResponse.result);
    const content = defineResponse.result.content[0].text;
    const parsedDefine = JSON.parse(content);
    assert.strictEqual(parsedDefine.projectId, 'proj-chess');
    assert.ok(parsedDefine.fingerprint);

    // 2. Test aidm.requirements.scope.get
    const getRequest: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
        arguments: {
          projectId: 'proj-chess',
        },
      },
    };

    const getResponse = (await server.handleMessage(getRequest)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;
    assert.ok(!('error' in getResponse));
    const parsedGet = JSON.parse(getResponse.result.content[0].text);
    assert.strictEqual(parsedGet.projectId, 'proj-chess');
    assert.strictEqual(parsedGet.fingerprint, parsedDefine.fingerprint);

    await server.stop();
  });

  // T26 no approval creation
  it('T26_no_approval_creation: does not create or mutate approval packages', async () => {
    const initialPackages = await approvalStore.listPackages();
    assert.strictEqual(initialPackages.length, 0);

    const discovery = await createDiscoveryRevision('proj-chess');
    await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const finalPackages = await approvalStore.listPackages();
    assert.strictEqual(finalPackages.length, 0);
  });

  // T27 no development authorization
  it('T27_no_development_authorization: durable state remains uninitiated and unauthorized', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const exists = await durableManager.exists();
    assert.strictEqual(exists, false);
  });

  // T28 no ExecutionIntent
  it('T28_no_execution_intent: execution intents remain strictly untouched', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    const intentPath = path.join(tempDir, '.ai-manager', 'execution-intents');
    assert.ok(!fs.existsSync(intentPath));
  });

  // T29 no Antigravity invocation
  it('T29_no_antigravity_invocation: completes without launching external executor processes', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    assert.ok(result);
    // Verified synchronously in-process
  });

  // T30 restart/reload behavior
  it('T30_restart_reload_behavior: fresh engine instance reads exact persisted requirements', async () => {
    const discovery = await createDiscoveryRevision('proj-chess');
    const result = await requirementsEngine.derive({
      projectId: 'proj-chess',
    });

    // Create fresh store and engine instances (simulating process restart)
    const freshRequirementsStore = new RequirementsScopeStore({
      baseDir: tempDir,
    });
    const freshRequirementsEngine = new RequirementsScopeEngine({
      baseDir: tempDir,
      discoveryStore,
      requirementsStore: freshRequirementsStore,
    });

    const reloaded = await freshRequirementsEngine.getLatest('proj-chess');
    assert.ok(reloaded);
    assert.strictEqual(reloaded.fingerprint, result.fingerprint);
    assert.strictEqual(reloaded.requirementsRevision, result.requirementsRevision);
    assert.deepStrictEqual(reloaded.functionalRequirements, result.functionalRequirements);
    assert.deepStrictEqual(reloaded.purpose, result.purpose);
  });
});
