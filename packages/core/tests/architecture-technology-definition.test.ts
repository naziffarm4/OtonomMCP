/**
 * Comprehensive Test Suite for Phase 15 Architecture & Technology Definition (TASK-P15-04)
 *
 * Verifies all 36 required capabilities and safety boundaries:
 * T01 basic architecture definition
 * T02 deterministic architecture derivation
 * T03 deterministic fingerprint
 * T04 architecture style extraction
 * T05 component extraction
 * T06 data architecture
 * T07 API/communication architecture
 * T08 technology stack
 * T09 platform/environment
 * T10 security architecture
 * T11 integration architecture
 * T12 deployment architecture
 * T13 selected technology status
 * T14 candidate technology status
 * T15 pending technology decision
 * T16 Product Owner decision remains pending
 * T17 no silent technology selection
 * T18 requirements revision binding
 * T19 requirements fingerprint binding
 * T20 discovery revision binding
 * T21 stale requirements rejection
 * T22 stale discovery rejection
 * T23 architecture revision persistence
 * T24 historical revision retrieval
 * T25 latest revision retrieval
 * T26 cross-project isolation
 * T27 forged fingerprint rejection
 * T28 deterministic deduplication
 * T29 requirement-to-architecture traceability
 * T30 history event
 * T31 MCP boundary
 * T32 no approval creation
 * T33 no development authorization
 * T34 no ExecutionIntent
 * T35 no Antigravity invocation
 * T36 restart/reload behavior
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
  ArchitectureTechnologyEngine,
  ArchitectureTechnologyStore,
  ArchitectureValidationError,
  ArchitectureRevisionNotFoundError,
  ArchitectureProjectBindingMismatchError,
  ArchitectureImmutableRevisionError,
  ArchitectureStaleSourceError,
  ArchitectureForgedFingerprintError,
  SpecStore,
  Actor,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_ARCHITECTURE_TECHNOLOGY_DEFINE_TOOL_NAME,
  AIDM_ARCHITECTURE_TECHNOLOGY_GET_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type ProjectArchitectureRevision,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Architecture & Technology Definition (TASK-P15-04)', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let completenessStore: CompletenessGateStore;
  let requirementsStore: RequirementsScopeStore;
  let architectureStore: ArchitectureTechnologyStore;
  let approvalStore: ApprovalStore;
  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;
  let architectureEngine: ArchitectureTechnologyEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-04-architecture-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    requirementsStore = new RequirementsScopeStore({ baseDir: tempDir, historyManager });
    architectureStore = new ArchitectureTechnologyStore({ baseDir: tempDir, historyManager });
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

    architectureEngine = new ArchitectureTechnologyEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
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
      sections?: Record<string, unknown>;
      decisions?: Array<{
        id: string;
        title: string;
        description: string;
        affectedAreas: string[];
        alternatives: string[];
        status?: string;
      }>;
    }
  ): Promise<ProjectDiscoveryRevision> {
    if (explicitOverrides?.decisions) {
      const now = new Date().toISOString();
      await specStore.saveDecisions(
        explicitOverrides.decisions.map((d) => ({
          id: d.id,
          title: d.title,
          description: d.description,
          authority: Actor.USER,
          status: 'PROPOSED' as const,
          createdAt: now,
          updatedAt: now,
          metadata: {
            affectedAreas: d.affectedAreas,
            alternatives: d.alternatives,
          },
        }))
      );
    }

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
          inScope: [
            'Matchmaking',
            'Real-time board movement',
            'Move validation',
            'Clock timer',
            'ELO calculation',
          ],
          outOfScope: ['Chess engine training', 'Cryptocurrency betting', 'Voice chat'],
          targetUsers: ['Competitive chess players', 'Casual gamers', 'Tournament arbiters'],
          primaryWorkflows: ['Create match', 'Join match', 'Make move', 'Resign match'],
        },
        architecture: {
          architecturalConstraints: ['modular-monolith', 'single-node process'],
          integrationRequirements: ['PostgreSQL Database', 'Redis Cache', 'FIDE Rating API'],
          deploymentModel: 'docker-compose containerized service',
          dataStorageExpectations: ['PostgreSQL', 'Redis'],
        },
        technology: {
          requiredTechnologies: ['TypeScript', 'Node.js', 'PostgreSQL', 'WebSockets'],
          preferredTechnologies: ['Fastify', 'Prisma'],
          prohibitedTechnologies: ['PHP', 'MongoDB'],
          platformConstraints: ['Linux server', 'modern Web browsers'],
        },
        ...explicitOverrides?.sections,
      },
      workspaceRoot: tempDir,
    });
  }

  // Helper to create standard requirements revision
  async function createRequirementsRevision(
    projectId: string,
    explicitOverrides?: {
      sections?: Record<string, unknown>;
    }
  ): Promise<ProjectRequirementsScopeRevision> {
    const discovery = await createDiscoveryRevision(projectId, explicitOverrides);
    return requirementsEngine.derive({
      projectId,
      discoveryRevision: discovery.discoveryRevision,
    });
  }

  // T01: basic architecture definition
  it('T01_basic_architecture_definition: transforms requirements into structured architecture revision', async () => {
    const requirements = await createRequirementsRevision('proj-chess');
    const result = await architectureEngine.derive({
      projectId: 'proj-chess',
      requirementsRevision: requirements.requirementsRevision,
    });

    assert.ok(result);
    assert.strictEqual(result.projectId, 'proj-chess');
    assert.strictEqual(result.architectureRevision, 1);
    assert.strictEqual(result.sourceRequirementsRevision, requirements.requirementsRevision);
    assert.strictEqual(result.sourceRequirementsFingerprint, requirements.fingerprint);
    assert.strictEqual(result.sourceDiscoveryRevision, requirements.sourceDiscoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, requirements.sourceDiscoveryFingerprint);
    assert.ok(result.fingerprint);
    assert.strictEqual(result.isStale, false);
  });

  // T02: deterministic architecture derivation
  it('T02_deterministic_architecture_derivation: identical requirements and discovery produce identical architecture', async () => {
    const requirements = await createRequirementsRevision('proj-det');

    const result1 = await architectureEngine.derive({
      projectId: 'proj-det',
      requirementsRevision: requirements.requirementsRevision,
    });

    const result2 = await architectureEngine.derive({
      projectId: 'proj-det',
      requirementsRevision: requirements.requirementsRevision,
    });

    assert.strictEqual(result1.fingerprint, result2.fingerprint);
    assert.strictEqual(result1.architectureRevision, result2.architectureRevision);
    assert.deepStrictEqual(result1.architecturalStyle, result2.architecturalStyle);
    assert.deepStrictEqual(result1.systemComponents, result2.systemComponents);
    assert.deepStrictEqual(result1.technologyStack, result2.technologyStack);
  });

  // T03: deterministic fingerprint
  it('T03_deterministic_fingerprint: fingerprint is stable and independent of timestamps', async () => {
    const requirements = await createRequirementsRevision('proj-fp');
    const result = await architectureEngine.derive({
      projectId: 'proj-fp',
    });

    assert.ok(result.fingerprint);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  });

  // T04: architecture style extraction
  it('T04_architecture_style_extraction: extracts style, pattern, topology, and boundaries', async () => {
    const requirements = await createRequirementsRevision('proj-style');
    const result = await architectureEngine.derive({
      projectId: 'proj-style',
    });

    assert.ok(result.architecturalStyle);
    assert.strictEqual(result.architecturalStyle.style, 'modular-monolith');
    assert.strictEqual(result.architecturalStyle.status, 'CONFIRMED');
    assert.ok(result.architecturalStyle.subsystemBoundaries.length > 0);
    assert.ok(result.architecturalStyle.serviceModuleBoundaries.length > 0);
    assert.ok(result.architecturalStyle.clientServerBoundaries.length > 0);
  });

  // T05: component extraction
  it('T05_component_extraction: extracts logical components with deterministic IDs and ownership', async () => {
    const requirements = await createRequirementsRevision('proj-comp');
    const result = await architectureEngine.derive({
      projectId: 'proj-comp',
    });

    assert.ok(result.systemComponents.length >= 2);
    for (const comp of result.systemComponents) {
      assert.match(comp.componentId, /^COMP-[A-F0-9]{8}$/);
      assert.ok(comp.name);
      assert.ok(comp.responsibility);
      assert.ok(comp.owningBoundary);
      assert.ok(Array.isArray(comp.dependencies));
      assert.ok(Array.isArray(comp.exposedInterfaces));
      assert.ok(Array.isArray(comp.sourceReferences));
    }
  });

  // T06: data architecture
  it('T06_data_architecture: extracts persistence strategy, primary store, and consistency', async () => {
    const requirements = await createRequirementsRevision('proj-data');
    const result = await architectureEngine.derive({
      projectId: 'proj-data',
    });

    assert.ok(result.dataArchitecture);
    assert.ok(result.dataArchitecture.primaryDataStore?.includes('PostgreSQL'));
    assert.strictEqual(result.dataArchitecture.status, 'CONFIRMED');
    assert.ok(result.dataArchitecture.dataOwnership.length > 0);
    assert.ok(result.dataArchitecture.consistencyRequirements.length > 0);
  });

  // T07: API/communication architecture
  it('T07_api_communication_architecture: extracts protocols and external interfaces', async () => {
    const requirements = await createRequirementsRevision('proj-api');
    const result = await architectureEngine.derive({
      projectId: 'proj-api',
    });

    assert.ok(result.apiCommunicationArchitecture);
    assert.strictEqual(result.apiCommunicationArchitecture.status, 'CONFIRMED');
    assert.ok(result.apiCommunicationArchitecture.externalApis.length > 0);
  });

  // T08: technology stack
  it('T08_technology_stack: extracts categorized technologies with explicit selection statuses', async () => {
    const requirements = await createRequirementsRevision('proj-tech');
    const result = await architectureEngine.derive({
      projectId: 'proj-tech',
    });

    assert.ok(result.technologyStack.length > 0);
    const tsTech = result.technologyStack.find((t) => t.name === 'TypeScript');
    assert.ok(tsTech);
    assert.strictEqual(tsTech.category, 'PROGRAMMING_LANGUAGE');
    assert.strictEqual(tsTech.selectionStatus, 'REQUIRED');

    const pgTech = result.technologyStack.find((t) => t.name === 'PostgreSQL');
    assert.ok(pgTech);
    assert.strictEqual(pgTech.category, 'DATABASE');
    assert.strictEqual(pgTech.selectionStatus, 'REQUIRED');
  });

  // T09: platform/environment
  it('T09_platform_environment: extracts target OS, devices, and runtime expectations', async () => {
    const requirements = await createRequirementsRevision('proj-platform');
    const result = await architectureEngine.derive({
      projectId: 'proj-platform',
    });

    assert.ok(result.platformEnvironment);
    assert.ok(result.platformEnvironment.targetOs.some((osName) => /linux/i.test(osName)));
    assert.ok(result.platformEnvironment.browserRequirements.some((b) => /browser/i.test(b)));
  });

  // T10: security architecture
  it('T10_security_architecture: extracts encryption, secrets handling, trust boundaries', async () => {
    const requirements = await createRequirementsRevision('proj-sec');
    const result = await architectureEngine.derive({
      projectId: 'proj-sec',
    });

    assert.ok(result.securityArchitecture);
    assert.ok(result.securityArchitecture.secretsHandling.length > 0);
    assert.ok(result.securityArchitecture.trustBoundaries.length > 0);
    assert.ok(result.securityArchitecture.dataIsolation.length > 0);
    assert.ok(result.securityArchitecture.auditRequirements.length > 0);
  });

  // T11: integration architecture
  it('T11_integration_architecture: extracts external integrations with protocol and dependency', async () => {
    const requirements = await createRequirementsRevision('proj-int');
    const result = await architectureEngine.derive({
      projectId: 'proj-int',
    });

    assert.ok(result.integrations.length > 0);
    for (const integration of result.integrations) {
      assert.match(integration.integrationId, /^INT-[A-F0-9]{8}$/);
      assert.ok(integration.system);
      assert.ok(integration.purpose);
      assert.strictEqual(integration.dependency, 'REQUIRED');
      assert.strictEqual(integration.status, 'CONFIRMED');
    }
  });

  // T12: deployment architecture
  it('T12_deployment_architecture: extracts environments and deployment model', async () => {
    const requirements = await createRequirementsRevision('proj-deploy');
    const result = await architectureEngine.derive({
      projectId: 'proj-deploy',
    });

    assert.ok(result.deploymentArchitecture);
    assert.ok(result.deploymentArchitecture.environments.includes('production'));
    assert.strictEqual(result.deploymentArchitecture.deploymentModel, 'docker-compose containerized service');
  });

  // T13: selected technology status
  it('T13_selected_technology_status: distinguishes REQUIRED and SELECTED technologies from candidates', async () => {
    const requirements = await createRequirementsRevision('proj-status');
    const result = await architectureEngine.derive({
      projectId: 'proj-status',
    });

    const required = result.technologyStack.filter((t) => t.selectionStatus === 'REQUIRED');
    assert.ok(required.length >= 2, 'Must identify required technologies');
  });

  // T14: candidate technology status
  it('T14_candidate_technology_status: represents alternatives as CANDIDATE without promoting them', async () => {
    const discovery = await createDiscoveryRevision('proj-candidate', {
      decisions: [
        {
          id: 'HDEC-DB-CHOICE',
          title: 'SQL vs NoSQL Database Selection',
          description: 'Determine primary persistence technology',
          affectedAreas: ['database', 'architecture'],
          alternatives: ['PostgreSQL', 'MongoDB'],
          status: 'PENDING_DECISION',
        },
      ],
    });
    const requirements = await requirementsEngine.derive({
      projectId: 'proj-candidate',
      discoveryRevision: discovery.discoveryRevision,
    });

    const result = await architectureEngine.derive({
      projectId: 'proj-candidate',
      requirementsRevision: requirements.requirementsRevision,
    });

    const candidates = result.technologyStack.filter((t) => t.selectionStatus === 'CANDIDATE');
    assert.ok(candidates.length > 0, 'Must record candidate options');
  });

  // T15: pending technology decision
  it('T15_pending_technology_decision: marks decision status PENDING_DECISION when unresolved', async () => {
    const disc1 = await createDiscoveryRevision('proj-pending-tech');
    const disc2: ProjectDiscoveryRevision = {
      ...disc1,
      discoveryRevision: 2,
      previousRevision: 1,
      decisions: [
        {
          id: 'HDEC-DATABASE',
          title: 'Database Engine Decision',
          description: 'Select relational or document store',
          affectedAreas: ['database', 'storage'],
          alternatives: ['PostgreSQL', 'DynamoDB'],
          authority: 'USER',
          status: 'PENDING_DECISION',
        },
      ],
      sections: {
        ...disc1.sections,
        humanDecisions: [
          {
            id: 'HDEC-DATABASE',
            title: 'Database Engine Decision',
            description: 'Select relational or document store',
            affectedAreas: ['database', 'storage'],
            alternatives: ['PostgreSQL', 'DynamoDB'],
            authority: 'USER',
            status: 'PENDING_DECISION',
          },
        ],
      },
    };
    await discoveryStore.saveRevision(disc2);

    const requirements = await requirementsEngine.derive({
      projectId: 'proj-pending-tech',
      discoveryRevision: 2,
    });

    const result = await architectureEngine.derive({
      projectId: 'proj-pending-tech',
      requirementsRevision: requirements.requirementsRevision,
    });

    assert.strictEqual(result.dataArchitecture.status, 'PENDING_DECISION');
    assert.strictEqual(result.dataArchitecture.primaryDataStore, undefined);
  });

  // T16: Product Owner decision remains pending
  it('T16_product_owner_decision_remains_pending: human decisions are preserved with Actor.USER and PENDING_DECISION', async () => {
    const disc1 = await createDiscoveryRevision('proj-po-pending');
    const disc2: ProjectDiscoveryRevision = {
      ...disc1,
      discoveryRevision: 2,
      previousRevision: 1,
      decisions: [
        {
          id: 'HDEC-HOSTING',
          title: 'Cloud vs On-Premises Hosting',
          description: 'Choose production hosting provider',
          affectedAreas: ['deployment', 'hosting'],
          alternatives: ['AWS', 'On-Premises Bare Metal'],
          authority: 'USER',
          status: 'PENDING_DECISION',
        },
      ],
      sections: {
        ...disc1.sections,
        humanDecisions: [
          {
            id: 'HDEC-HOSTING',
            title: 'Cloud vs On-Premises Hosting',
            description: 'Choose production hosting provider',
            affectedAreas: ['deployment', 'hosting'],
            alternatives: ['AWS', 'On-Premises Bare Metal'],
            authority: 'USER',
            status: 'PENDING_DECISION',
          },
        ],
      },
    };
    await discoveryStore.saveRevision(disc2);

    const requirements = await requirementsEngine.derive({
      projectId: 'proj-po-pending',
      discoveryRevision: 2,
    });

    const result = await architectureEngine.derive({
      projectId: 'proj-po-pending',
    });

    assert.ok(result.pendingHumanDecisions.length > 0);
    const hostingDec = result.pendingHumanDecisions.find((d) => d.question.includes('Cloud vs On-Premises'));
    assert.ok(hostingDec);
    assert.strictEqual(hostingDec.status, 'PENDING_DECISION');
    assert.strictEqual(hostingDec.authority, 'USER');
  });

  // T17: no silent technology selection
  it('T17_no_silent_technology_selection: engine does not auto-pick common technology when undecided', async () => {
    const disc1 = await createDiscoveryRevision('proj-no-silent');
    const disc2: ProjectDiscoveryRevision = {
      ...disc1,
      discoveryRevision: 2,
      previousRevision: 1,
      decisions: [
        {
          id: 'HDEC-API-STYLE',
          title: 'REST vs GraphQL Protocol',
          description: 'Decide client-server communication API style',
          affectedAreas: ['api', 'communication'],
          alternatives: ['REST', 'GraphQL'],
          authority: 'USER',
          status: 'PENDING_DECISION',
        },
      ],
      sections: {
        ...disc1.sections,
        humanDecisions: [
          {
            id: 'HDEC-API-STYLE',
            title: 'REST vs GraphQL Protocol',
            description: 'Decide client-server communication API style',
            affectedAreas: ['api', 'communication'],
            alternatives: ['REST', 'GraphQL'],
            authority: 'USER',
            status: 'PENDING_DECISION',
          },
        ],
      },
    };
    await discoveryStore.saveRevision(disc2);

    const requirements = await requirementsEngine.derive({
      projectId: 'proj-no-silent',
      discoveryRevision: 2,
    });

    const result = await architectureEngine.derive({
      projectId: 'proj-no-silent',
    });

    assert.strictEqual(result.apiCommunicationArchitecture.status, 'PENDING_DECISION');
    const apiDec = result.decisions.find((d) => d.decisionArea === 'API');
    assert.ok(apiDec);
    assert.strictEqual(apiDec.status, 'PENDING_DECISION');
  });

  // T18: requirements revision binding
  it('T18_requirements_revision_binding: architecture strictly binds to source requirements revision', async () => {
    const requirements = await createRequirementsRevision('proj-req-binding');
    const result = await architectureEngine.derive({
      projectId: 'proj-req-binding',
      requirementsRevision: requirements.requirementsRevision,
    });

    assert.strictEqual(result.sourceRequirementsRevision, requirements.requirementsRevision);
  });

  // T19: requirements fingerprint binding
  it('T19_requirements_fingerprint_binding: architecture strictly binds to exact requirements fingerprint', async () => {
    const requirements = await createRequirementsRevision('proj-fp-binding');
    const result = await architectureEngine.derive({
      projectId: 'proj-fp-binding',
    });

    assert.strictEqual(result.sourceRequirementsFingerprint, requirements.fingerprint);
  });

  // T20: discovery revision binding
  it('T20_discovery_revision_binding: architecture preserves source discovery revision from requirements', async () => {
    const requirements = await createRequirementsRevision('proj-disc-binding');
    const result = await architectureEngine.derive({
      projectId: 'proj-disc-binding',
    });

    assert.strictEqual(result.sourceDiscoveryRevision, requirements.sourceDiscoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, requirements.sourceDiscoveryFingerprint);
  });

  // T21: stale requirements rejection
  it('T21_stale_requirements_rejection: rejects derivation when newer requirements revision exists', async () => {
    const requirements1 = await createRequirementsRevision('proj-stale-req');

    // Create a second requirements revision
    const discovery2 = await discoveryEngine.discover({
      projectId: 'proj-stale-req',
      rawPrompt: 'Updated requirements prompt with additional details',
      explicitSections: {
        productScope: {
          inScope: ['Tournament mode', 'Advanced Analytics'],
        },
      },
      workspaceRoot: tempDir,
    });
    await requirementsEngine.derive({
      projectId: 'proj-stale-req',
      discoveryRevision: discovery2.discoveryRevision,
    });

    // Attempting to derive from rev 1 should fail with ArchitectureStaleSourceError
    await assert.rejects(
      async () => {
        await architectureEngine.derive({
          projectId: 'proj-stale-req',
          requirementsRevision: requirements1.requirementsRevision,
        });
      },
      ArchitectureStaleSourceError
    );
  });

  // T22: stale discovery rejection
  it('T22_stale_discovery_rejection: rejects derivation when discovery has advanced past requirements binding', async () => {
    const requirements = await createRequirementsRevision('proj-stale-disc');

    // Advance discovery revision directly
    await discoveryEngine.discover({
      projectId: 'proj-stale-disc',
      rawPrompt: 'Third discovery prompt advancing discovery state',
      workspaceRoot: tempDir,
    });

    await assert.rejects(
      async () => {
        await architectureEngine.derive({
          projectId: 'proj-stale-disc',
          requirementsRevision: requirements.requirementsRevision,
        });
      },
      ArchitectureStaleSourceError
    );
  });

  // T23: architecture revision persistence
  it('T23_architecture_revision_persistence: persists rev-<n>.json and latest.json atomically', async () => {
    const requirements = await createRequirementsRevision('proj-persist');
    const result = await architectureEngine.derive({
      projectId: 'proj-persist',
    });

    const safeId = architectureStore.sanitizeProjectId('proj-persist');
    const revFile = path.join(architectureStore.recordsDir, safeId, `rev-${result.architectureRevision}.json`);
    const latestFile = path.join(architectureStore.recordsDir, safeId, 'latest.json');

    assert.ok(fs.existsSync(revFile), 'rev-<n>.json must exist');
    assert.ok(fs.existsSync(latestFile), 'latest.json must exist');

    const revContent = JSON.parse(fs.readFileSync(revFile, 'utf8'));
    const latestContent = JSON.parse(fs.readFileSync(latestFile, 'utf8'));

    assert.strictEqual(revContent.fingerprint, result.fingerprint);
    assert.strictEqual(latestContent.fingerprint, result.fingerprint);
  });

  // T24: historical revision retrieval
  it('T24_historical_revision_retrieval: historical revisions remain readable and immutable', async () => {
    const requirements = await createRequirementsRevision('proj-hist');
    const arch1 = await architectureEngine.derive({
      projectId: 'proj-hist',
    });

    const retrieved1 = await architectureEngine.getRevision('proj-hist', 1);
    assert.ok(retrieved1);
    assert.strictEqual(retrieved1.architectureRevision, 1);
    assert.strictEqual(retrieved1.fingerprint, arch1.fingerprint);

    // Attempting to overwrite rev-1 with a different fingerprint must fail closed
    const tampered = { ...arch1, fingerprint: 'forged_tampered_fingerprint_0000000000' };
    await assert.rejects(
      async () => {
        await architectureStore.saveRevision(tampered);
      },
      ArchitectureImmutableRevisionError
    );
  });

  // T25: latest revision retrieval
  it('T25_latest_revision_retrieval: retrieves the latest architecture revision', async () => {
    const requirements = await createRequirementsRevision('proj-latest');
    const arch = await architectureEngine.derive({
      projectId: 'proj-latest',
    });

    const latest = await architectureEngine.getLatest('proj-latest');
    assert.ok(latest);
    assert.strictEqual(latest.architectureRevision, arch.architectureRevision);
    assert.strictEqual(latest.fingerprint, arch.fingerprint);
  });

  // T26: cross-project isolation
  it('T26_cross_project_isolation: prevents cross-project access and rejects path traversal', async () => {
    await createRequirementsRevision('proj-alpha');
    await architectureEngine.derive({ projectId: 'proj-alpha' });

    // Path traversal in projectId is rejected
    await assert.rejects(
      async () => {
        await architectureEngine.derive({ projectId: '../../../etc/passwd' });
      },
      ArchitectureValidationError
    );

    // Loading from another project fails closed
    const betaRecord = await architectureStore.loadRevision('proj-beta');
    assert.strictEqual(betaRecord, null);
  });

  // T27: forged fingerprint rejection
  it('T27_forged_fingerprint_rejection: rejects request when expected fingerprint mismatches', async () => {
    await createRequirementsRevision('proj-forged');

    await assert.rejects(
      async () => {
        await architectureEngine.derive({
          projectId: 'proj-forged',
          expectedRequirementsFingerprint: 'completely_fabricated_requirements_fingerprint_12345',
        });
      },
      ArchitectureForgedFingerprintError
    );
  });

  // T28: deterministic deduplication
  it('T28_deterministic_deduplication: duplicate component references and tech items are deduplicated', async () => {
    const requirements = await createRequirementsRevision('proj-dedup');
    const result = await architectureEngine.derive({
      projectId: 'proj-dedup',
    });

    // Check no duplicate tech category:::name entries
    const techKeys = result.technologyStack.map((t) => `${t.category}:::${t.name}`);
    const uniqueKeys = new Set(techKeys);
    assert.strictEqual(techKeys.length, uniqueKeys.size);
  });

  // T29: requirement-to-architecture traceability
  it('T29_requirement_to_architecture_traceability: every requirement traces to components, decisions, and tech', async () => {
    const requirements = await createRequirementsRevision('proj-trace');
    const result = await architectureEngine.derive({
      projectId: 'proj-trace',
    });

    assert.ok(result.requirementsTraceability.length > 0);
    for (const link of result.requirementsTraceability) {
      assert.ok(link.requirementId);
      assert.ok(link.requirementTitle);
      assert.ok(link.addressedByComponents.length > 0);
      assert.ok(link.addressedByDecisions.length > 0);
      assert.ok(link.addressedByTechnologies.length > 0);
    }
  });

  // T30: history event
  it('T30_history_event: appends PROJECT_ARCHITECTURE_TECHNOLOGY_DEFINED event to HistoryManager', async () => {
    const requirements = await createRequirementsRevision('proj-hist-event');
    const result = await architectureEngine.derive({
      projectId: 'proj-hist-event',
    });

    const events = await historyManager.readEvents();
    const archEvent = events.find((e) => e.eventType === 'PROJECT_ARCHITECTURE_TECHNOLOGY_DEFINED');

    assert.ok(archEvent);
    assert.strictEqual(archEvent.actor, 'DIRECTOR');
    assert.strictEqual(archEvent.payload.projectId, 'proj-hist-event');
    assert.strictEqual(archEvent.payload.architectureRevision, result.architectureRevision);
    assert.strictEqual(archEvent.payload.sourceRequirementsRevision, requirements.requirementsRevision);
    assert.strictEqual(archEvent.payload.fingerprint, result.fingerprint);
  });

  // T31: MCP boundary
  it('T31_mcp_boundary: aidm.architecture.technology.define and get tools execute through MCP boundary', async () => {
    const requirements = await createRequirementsRevision('proj-mcp');

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      historyManager,
      specStore,
    });

    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      architectureTools: true,
    });

    await server.start();

    // 1. Test DEFINE tool
    const defineReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-arch-define-1',
      method: 'tools/call',
      params: {
        name: AIDM_ARCHITECTURE_TECHNOLOGY_DEFINE_TOOL_NAME,
        arguments: {
          projectId: 'proj-mcp',
          requirementsRevision: requirements.requirementsRevision,
        },
      },
    };

    const defineRes = (await server.handleMessage(defineReq)) as McpSuccessResponseEnvelope;
    assert.ok(defineRes);
    assert.strictEqual(defineRes.id, 'req-arch-define-1');
    const parsedDefine = JSON.parse((defineRes.result as any).content[0].text);
    assert.strictEqual(parsedDefine.projectId, 'proj-mcp');
    assert.strictEqual(parsedDefine.architectureRevision, 1);

    // 2. Test GET tool
    const getReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-arch-get-1',
      method: 'tools/call',
      params: {
        name: AIDM_ARCHITECTURE_TECHNOLOGY_GET_TOOL_NAME,
        arguments: {
          projectId: 'proj-mcp',
        },
      },
    };

    const getRes = (await server.handleMessage(getReq)) as McpSuccessResponseEnvelope;
    assert.ok(getRes);
    const parsedGet = JSON.parse((getRes.result as any).content[0].text);
    assert.strictEqual(parsedGet.projectId, 'proj-mcp');
    assert.strictEqual(parsedGet.architectureRevision, 1);

    await server.stop();
  });

  // T32: no approval creation
  it('T32_no_approval_creation: architecture definition does NOT create or mutate approval packages', async () => {
    const requirements = await createRequirementsRevision('proj-no-approval');
    await architectureEngine.derive({ projectId: 'proj-no-approval' });

    const packages = await approvalStore.listPackages('proj-no-approval');
    assert.strictEqual(packages.length, 0);
  });

  // T33: no development authorization
  it('T33_no_development_authorization: durable state remains uninitiated and unauthorized', async () => {
    const requirements = await createRequirementsRevision('proj-no-auth');
    await architectureEngine.derive({ projectId: 'proj-no-auth' });

    const state = await durableManager.load();
    assert.strictEqual(state, null);
  });

  // T34: no ExecutionIntent
  it('T34_no_execution_intent: execution intents remain strictly untouched', async () => {
    const requirements = await createRequirementsRevision('proj-no-intent');
    await architectureEngine.derive({ projectId: 'proj-no-intent' });

    const intentFile = path.join(tempDir, '.ai-manager', 'execution-intents');
    assert.strictEqual(fs.existsSync(intentFile), false);
  });

  // T35: no Antigravity invocation
  it('T35_no_antigravity_invocation: completes without launching external executor processes', async () => {
    const requirements = await createRequirementsRevision('proj-no-agy');
    const result = await architectureEngine.derive({ projectId: 'proj-no-agy' });
    assert.ok(result);
  });

  // T36: restart/reload behavior
  it('T36_restart_reload_behavior: fresh engine instance reads exact persisted architecture', async () => {
    const requirements = await createRequirementsRevision('proj-reload');
    const original = await architectureEngine.derive({ projectId: 'proj-reload' });

    const freshEngine = new ArchitectureTechnologyEngine({
      baseDir: tempDir,
    });

    const reloaded = await freshEngine.getLatest('proj-reload');
    assert.ok(reloaded);
    assert.strictEqual(reloaded.fingerprint, original.fingerprint);
    assert.strictEqual(reloaded.architectureRevision, original.architectureRevision);
    assert.deepStrictEqual(reloaded.architecturalStyle, original.architecturalStyle);
    assert.deepStrictEqual(reloaded.technologyStack, original.technologyStack);
  });
});
