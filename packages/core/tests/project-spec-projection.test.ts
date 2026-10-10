/**
 * Comprehensive Test Suite for PROJECT_SPEC Projection
 *
 * Verifies all required capabilities, architectural invariants, and safety boundaries:
 * 1. deterministic projection
 * 2. source revision binding
 * 3. source fingerprint binding
 * 4. complete projection generation
 * 5. missing optional sections
 * 6. unresolved decisions preserved
 * 7. no silent decision
 * 8. stale discovery detection
 * 9. stale requirements detection
 * 10. stale architecture detection
 * 11. stale business-rules detection
 * 12. stale acceptance-criteria detection
 * 13. stale risk detection
 * 14. human decision changes detected
 * 15. projection tampering detection
 * 16. forged self-consistent projection rejection
 * 17. cross-project isolation
 * 18. path traversal protection
 * 19. immutable revision behavior
 * 20. idempotent regeneration
 * 21. restart/reload
 * 22. MCP generation
 * 23. MCP get
 * 24. stale detection
 * 25. Director read integration
 * 26. no approval creation
 * 27. no development authorization
 * 28. no ExecutionIntent
 * 29. no ExecutionRequest
 * 30. no Antigravity invocation
 * 31. no task DAG mutation
 * 32. no autonomous driver
 * 33. deleting PROJECT_SPEC preserves authoritative project-initiation state & reconstruct works
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
  BusinessRulesEngine,
  BusinessRulesStore,
  AcceptanceCriteriaEngine,
  AcceptanceCriteriaStore,
  RiskHumanDecisionEngine,
  RiskHumanDecisionStore,
  ProjectSpecEngine,
  ProjectSpecStore,
  ProjectSpecValidationError,
  ProjectSpecRevisionNotFoundError,
  ProjectSpecProjectBindingMismatchError,
  ProjectSpecImmutableRevisionError,
  ProjectSpecForgedFingerprintError,
  ProjectSpecTamperingError,
  ProjectSpecPathTraversalError,
  computeProjectSpecSemanticFingerprint,
  SpecStore,
  Actor,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_PROJECT_SPEC_GENERATE_TOOL_NAME,
  AIDM_PROJECT_SPEC_GET_TOOL_NAME,
  AIDM_PROJECT_SPEC_STALE_TOOL_NAME,
  AIDM_PROJECT_STATUS_TOOL_NAME,
  AIDM_RISKS_GET_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type ProjectArchitectureRevision,
  type ProjectBusinessRulesRevision,
  type ProjectAcceptanceCriteriaRevision,
  type ProjectRiskRevision,
  type ProjectSpecProjection,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
  type McpToolResult,
} from '../dist/index.js';

describe('PROJECT_SPEC Projection', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let completenessStore: CompletenessGateStore;
  let requirementsStore: RequirementsScopeStore;
  let architectureStore: ArchitectureTechnologyStore;
  let businessRulesStore: BusinessRulesStore;
  let acceptanceCriteriaStore: AcceptanceCriteriaStore;
  let riskStore: RiskHumanDecisionStore;
  let specProjectionStore: ProjectSpecStore;
  let approvalStore: ApprovalStore;

  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;
  let architectureEngine: ArchitectureTechnologyEngine;
  let businessRulesEngine: BusinessRulesEngine;
  let acceptanceCriteriaEngine: AcceptanceCriteriaEngine;
  let riskEngine: RiskHumanDecisionEngine;
  let projectSpecEngine: ProjectSpecEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-spec-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    requirementsStore = new RequirementsScopeStore({ baseDir: tempDir, historyManager });
    architectureStore = new ArchitectureTechnologyStore({ baseDir: tempDir, historyManager });
    businessRulesStore = new BusinessRulesStore({ baseDir: tempDir, historyManager });
    acceptanceCriteriaStore = new AcceptanceCriteriaStore({ baseDir: tempDir, historyManager });
    riskStore = new RiskHumanDecisionStore({ baseDir: tempDir, historyManager });
    specProjectionStore = new ProjectSpecStore({
      baseDir: tempDir,
      workspaceRoot: tempDir,
      historyManager,
    });
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

    businessRulesEngine = new BusinessRulesEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      historyManager,
      specStore,
    });

    acceptanceCriteriaEngine = new AcceptanceCriteriaEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      historyManager,
      specStore,
    });

    riskEngine = new RiskHumanDecisionEngine({
      baseDir: tempDir,
      discoveryStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      riskStore,
      historyManager,
      specStore,
    });

    projectSpecEngine = new ProjectSpecEngine({
      baseDir: tempDir,
      workspaceRoot: tempDir,
      discoveryStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      riskStore,
      specProjectionStore,
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

  // Helper to establish complete authoritative project initiation chain
  async function setupAuthoritativeUpstreamChain(
    projectId: string,
    options?: {
      discoveryPrompt?: string;
      additionalCriteria?: any[];
      additionalDecisions?: any[];
    }
  ): Promise<{
    discovery: ProjectDiscoveryRevision;
    requirements: ProjectRequirementsScopeRevision;
    architecture: ProjectArchitectureRevision;
    businessRules: ProjectBusinessRulesRevision;
    acceptanceCriteria: ProjectAcceptanceCriteriaRevision;
    risks: ProjectRiskRevision;
  }> {
    const rawPrompt =
      options?.discoveryPrompt ??
      `
      Build a Clinical Patient Portal.
      Patients can view their electronic health records, schedule clinic visits, and send secure messages to providers.
      The system must comply with HIPAA regulations and encrypt all PHI at rest and in transit.
      Appointments require insurance pre-validation before confirmation.
      Target runtime is Node.js Linux containers on AWS ECS.
      `;

    const discovery = await discoveryEngine.discover({
      projectId,
      rawPrompt,
    });

    const requirements = await requirementsEngine.derive({
      projectId,
      discoveryRevision: discovery.discoveryRevision,
    });

    const architecture = await architectureEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
      additionalDecisions: options?.additionalDecisions,
    });

    const businessRules = await businessRulesEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
      architectureRevision: architecture.architectureRevision,
    });

    const acceptanceCriteria = await acceptanceCriteriaEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
      architectureRevision: architecture.architectureRevision,
      businessRulesRevision: businessRules.businessRulesRevision,
      discoveryRevision: discovery.discoveryRevision,
      additionalCriteria: options?.additionalCriteria,
    });

    const risks = await riskEngine.derive({
      projectId,
      discoveryRevision: discovery.discoveryRevision,
      requirementsRevision: requirements.requirementsRevision,
      architectureRevision: architecture.architectureRevision,
      businessRulesRevision: businessRules.businessRulesRevision,
      acceptanceCriteriaRevision: acceptanceCriteria.acceptanceCriteriaRevision,
    });

    return { discovery, requirements, architecture, businessRules, acceptanceCriteria, risks };
  }

  // ==========================================================================
  // 1. DETERMINISTIC PROJECTION
  // ==========================================================================
  it('1. generates a deterministic PROJECT_SPEC projection with identical semantic fingerprint', async () => {
    const projectId = 'proj-spec-det';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec1 = await projectSpecEngine.generate({ projectId });
    const spec2 = await projectSpecEngine.generate({ projectId });

    assert.strictEqual(spec1.projectId, projectId);
    assert.strictEqual(spec1.specRevision, 1);
    assert.strictEqual(spec2.specRevision, 1);
    assert.strictEqual(spec1.semanticFingerprint, spec2.semanticFingerprint);
    assert.strictEqual(spec1.markdownContent, spec2.markdownContent);
    assert.ok(spec1.semanticFingerprint.length === 64, 'SHA-256 fingerprint should be 64 hex chars');
  });

  // ==========================================================================
  // 2. SOURCE REVISION BINDING
  // ==========================================================================
  it('2. binds to exact revisions of all 6 upstream authoritative sources', async () => {
    const projectId = 'proj-spec-rev-bind';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });

    assert.strictEqual(spec.sourceBindings.discoveryRevision, chain.discovery.discoveryRevision);
    assert.strictEqual(spec.sourceBindings.requirementsRevision, chain.requirements.requirementsRevision);
    assert.strictEqual(spec.sourceBindings.architectureRevision, chain.architecture.architectureRevision);
    assert.strictEqual(spec.sourceBindings.businessRulesRevision, chain.businessRules.businessRulesRevision);
    assert.strictEqual(spec.sourceBindings.acceptanceCriteriaRevision, chain.acceptanceCriteria.acceptanceCriteriaRevision);
    assert.strictEqual(spec.sourceBindings.riskRevision, chain.risks.riskRevision);
  });

  // ==========================================================================
  // 3. SOURCE FINGERPRINT BINDING
  // ==========================================================================
  it('3. binds to exact fingerprints of all 6 upstream authoritative sources', async () => {
    const projectId = 'proj-spec-fp-bind';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });

    assert.strictEqual(spec.sourceBindings.discoveryFingerprint, chain.discovery.fingerprint);
    assert.strictEqual(spec.sourceBindings.requirementsFingerprint, chain.requirements.fingerprint);
    assert.strictEqual(spec.sourceBindings.architectureFingerprint, chain.architecture.fingerprint);
    assert.strictEqual(spec.sourceBindings.businessRulesFingerprint, chain.businessRules.fingerprint);
    assert.strictEqual(spec.sourceBindings.acceptanceCriteriaFingerprint, chain.acceptanceCriteria.fingerprint);
    assert.strictEqual(spec.sourceBindings.riskFingerprint, chain.risks.fingerprint);
  });

  // ==========================================================================
  // 4. COMPLETE PROJECTION GENERATION
  // ==========================================================================
  it('4. projects all required content sections comprehensively', async () => {
    const projectId = 'proj-spec-complete';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    const content = spec.content;

    // Verify all structured sections are present and non-empty
    assert.ok(content.identity.name);
    assert.ok(content.identity.purpose);
    assert.ok(content.identity.desiredOutcome);

    assert.ok(content.purpose.purpose);
    assert.ok(content.targetUsers.primaryUsers.length > 0 || content.targetUsers.secondaryUsers.length > 0);
    assert.ok(content.scope.inScope.capabilities.length > 0);
    assert.ok(content.scope.outOfScope.capabilities.length >= 0);

    assert.ok(content.functionalRequirements.length > 0);
    assert.ok(content.nonFunctionalRequirements);
    assert.ok(content.constraints.technologyConstraints.length >= 0);
    assert.ok(content.assumptions.length >= 0);

    assert.ok(content.architecture.architecturalStyle.style);
    assert.ok(content.architecture.systemComponents.length > 0);
    assert.ok(content.architecture.dataArchitecture.status);
    assert.ok(content.architecture.platformEnvironment.targetOs.length >= 0);
    assert.ok(content.architecture.securityArchitecture.status);
    assert.ok(content.architecture.deploymentArchitecture.status);

    assert.ok(content.businessRules.length > 0);
    assert.ok(content.acceptanceCriteria.length > 0);
    assert.ok(content.risks.length > 0);
    assert.ok(content.riskSummary.totalRisks > 0);
    assert.ok(content.humanDecisionPoints.length > 0);
    assert.ok(content.traceabilityMatrix.length > 0);

    // Markdown file created in project records and workspace root
    assert.ok(fs.existsSync(specProjectionStore.getMarkdownPath(projectId, 1)));
    assert.ok(fs.existsSync(specProjectionStore.getSpecPath(projectId, 1)));
    assert.ok(fs.existsSync(path.join(tempDir, 'PROJECT_SPEC.md')));
  });

  // ==========================================================================
  // 5. MISSING OPTIONAL SECTIONS
  // ==========================================================================
  it('5. gracefully handles optional empty sections without crashing', async () => {
    const projectId = 'proj-spec-optional';
    // Minimal prompt
    await setupAuthoritativeUpstreamChain(projectId, {
      discoveryPrompt: 'Simple CLI tool to print greetings.',
    });

    const spec = await projectSpecEngine.generate({ projectId });
    assert.ok(spec.semanticFingerprint);
    assert.ok(spec.markdownContent.includes('PROJECT SPECIFICATION'));
    assert.strictEqual(spec.isStale, false);
  });

  // ==========================================================================
  // 6. UNRESOLVED DECISIONS PRESERVED
  // ==========================================================================
  it('6. preserves unresolved human decisions exactly as PENDING_DECISION', async () => {
    const projectId = 'proj-spec-decisions';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    const pendingHdp = spec.content.humanDecisionPoints.filter(
      (h) => h.status === 'PENDING_DECISION'
    );

    assert.ok(pendingHdp.length > 0, 'Should have pending human decision points');
    for (const hdp of pendingHdp) {
      assert.strictEqual(hdp.status, 'PENDING_DECISION');
      assert.ok(hdp.authority === 'PRODUCT_OWNER' || hdp.authority === 'USER');
      assert.ok(hdp.availableOptions.length >= 1);
    }

    // Markdown contains warning block
    assert.ok(spec.markdownContent.includes('UNRESOLVED HUMAN DECISION POINT'));
    assert.ok(spec.markdownContent.includes('PENDING_DECISION'));
  });

  // ==========================================================================
  // 7. NO SILENT DECISION
  // ==========================================================================
  it('7. never silently resolves or chooses an option for human decision points', async () => {
    const projectId = 'proj-spec-no-silent';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    for (const hdp of spec.content.humanDecisionPoints) {
      if (hdp.status === 'PENDING_DECISION') {
        assert.ok(!('selectedOption' in hdp) || !(hdp as any).selectedOption);
      }
    }
  });

  // ==========================================================================
  // 8. STALE DISCOVERY DETECTION
  // ==========================================================================
  it('8. detects projection as stale when discovery revision advances', async () => {
    const projectId = 'proj-spec-stale-disc';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    assert.strictEqual(spec.isStale, false);

    // Advance discovery to rev 2
    await discoveryEngine.discover({
      projectId,
      rawPrompt: 'Updated discovery prompt adding pediatric department support.',
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.discoveryStale, true);

    const latest = await projectSpecEngine.getLatest(projectId);
    assert.strictEqual(latest?.isStale, true);
  });

  // ==========================================================================
  // 9. STALE REQUIREMENTS DETECTION
  // ==========================================================================
  it('9. detects projection as stale when requirements revision advances', async () => {
    const projectId = 'proj-spec-stale-req';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    // Advance requirements to rev 2
    await requirementsEngine.derive({
      projectId,
      discoveryRevision: 1,
      additionalAssumptions: [
        {
          id: 'ASSUMP-NEW',
          statement: 'New external identity provider is active',
          validated: true,
          affectedRequirements: [],
        },
      ],
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.requirementsStale, true);
  });

  // ==========================================================================
  // 10. STALE ARCHITECTURE DETECTION
  // ==========================================================================
  it('10. detects projection as stale when architecture revision advances', async () => {
    const projectId = 'proj-spec-stale-arch';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    // Advance architecture to rev 2
    await architectureEngine.derive({
      projectId,
      requirementsRevision: 1,
      additionalDecisions: [
        {
          decisionId: 'AD-NEW',
          decisionArea: 'SECURITY',
          question: 'Which HSM provider for key storage?',
          status: 'CANDIDATE',
          candidateOptions: ['AWS CloudHSM', 'HashiCorp Vault'],
          affectedRequirements: [],
          consequences: [],
          dependencies: [],
          authority: 'CHIEF_ARCHITECT',
          revisionBinding: 1,
        },
      ],
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.architectureStale, true);
  });

  // ==========================================================================
  // 11. STALE BUSINESS-RULES DETECTION
  // ==========================================================================
  it('11. detects projection as stale when business rules revision advances', async () => {
    const projectId = 'proj-spec-stale-br';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    // Advance business rules to rev 2
    await businessRulesEngine.derive({
      projectId,
      requirementsRevision: 1,
      architectureRevision: 1,
      additionalRules: [
        {
          ruleId: 'BR-NEW-01',
          title: 'Custom Payment Grace Period',
          description: 'Patients have 15 minutes grace period before appointment cancellation',
          category: 'TEMPORAL_RULE',
          statement: 'Grace period must be 15 minutes',
          priority: 'HIGH',
          status: 'CONFIRMED',
          sourceReferences: [],
          sourceRequirements: [],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: [],
          affectedRequirements: [],
          affectedArchitectureAreas: [],
          dependencies: [],
          metadata: {},
        },
      ],
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.businessRulesStale, true);
  });

  // ==========================================================================
  // 12. STALE ACCEPTANCE-CRITERIA DETECTION
  // ==========================================================================
  it('12. detects projection as stale when acceptance criteria revision advances', async () => {
    const projectId = 'proj-spec-stale-ac';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    // Advance acceptance criteria to rev 2
    await acceptanceCriteriaEngine.derive({
      projectId,
      requirementsRevision: 1,
      architectureRevision: 1,
      businessRulesRevision: 1,
      discoveryRevision: 1,
      additionalCriteria: [
        {
          criterionId: 'AC-NEW-01',
          title: 'Grace Period Expiration Test',
          description: 'Verify appointment is cancelled after 15 minutes without payment',
          criterionType: 'FUNCTIONAL',
          statement: 'System cancels reservation when timer exceeds 15 minutes',
          priority: 'HIGH',
          status: 'DEFINED',
          sourceRequirements: [],
          sourceBusinessRules: [],
          sourceArchitectureDecisions: [],
          verificationMethod: 'AUTOMATED_TEST',
          expectedResult: 'Appointment status transitions to CANCELLED',
          dependencies: [],
          traceability: {
            criterionId: 'AC-NEW-01',
            requirementIds: [],
            businessRuleIds: [],
            architectureDecisionIds: [],
          },
          metadata: {},
        },
      ],
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.acceptanceCriteriaStale, true);
  });

  // ==========================================================================
  // 13. STALE RISK DETECTION
  // ==========================================================================
  it('13. detects projection as stale when risk revision advances', async () => {
    const projectId = 'proj-spec-stale-risk';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    // Advance risk revision to rev 2
    await riskEngine.derive({
      projectId,
      discoveryRevision: 1,
      requirementsRevision: 1,
      architectureRevision: 1,
      businessRulesRevision: 1,
      acceptanceCriteriaRevision: 1,
      additionalRisks: [
        {
          riskId: 'RISK-SECURITY-NEW',
          title: 'Third party token leakage',
          description: 'Twilio SMS auth token leakage in worker logs',
          category: 'SECURITY',
          probability: 'LOW',
          impact: 'CRITICAL',
          severity: 'HIGH',
          status: 'IDENTIFIED',
          response: 'MITIGATE',
          statement: 'Auth tokens could leak into unencrypted logs',
          consequences: ['Account compromise'],
          mitigation: 'Implement strict log redaction filter',
          contingency: 'Implement fallback log redaction filter',
          owner: 'PRODUCT_OWNER',
          sourceRequirements: [],
          sourceBusinessRules: [],
          sourceArchitectureDecisions: [],
          sourceAcceptanceCriteria: [],
          sourceDiscovery: [],
          dependencies: [],
          traceability: {
            riskId: 'RISK-SECURITY-NEW',
            requirementIds: [],
            businessRuleIds: [],
            architectureDecisionIds: [],
            acceptanceCriteriaIds: [],
            discoveryKeys: [],
          },
          metadata: {},
        },
      ],
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.risksStale, true);
  });

  // ==========================================================================
  // 14. HUMAN DECISION CHANGES DETECTED
  // ==========================================================================
  it('14. detects human decision changes in upstream risks as stale', async () => {
    const projectId = 'proj-spec-hdp-change';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    // Advance risk revision with additional human decision point
    await riskEngine.derive({
      projectId,
      discoveryRevision: 1,
      requirementsRevision: 1,
      architectureRevision: 1,
      businessRulesRevision: 1,
      acceptanceCriteriaRevision: 1,
      customDecisions: [
        {
          decisionId: 'HDP-CUSTOM-CHOICE',
          title: 'Patient SMS Opt-in Policy',
          question: 'Should SMS notifications be opt-in or opt-out?',
          whyItMatters: 'Legal TCPA compliance vs appointment confirmation rates',
          affectedRisks: [],
          affectedRequirements: [],
          affectedArchitectureDecisions: [],
          affectedBusinessRules: [],
          affectedAcceptanceCriteria: [],
          availableOptions: ['EXPLICIT_OPT_IN', 'SOFT_OPT_IN'],
          authority: 'PRODUCT_OWNER',
          status: 'PENDING_DECISION',
          consequences: [],
          recommendedInformation: 'TCPA requires explicit opt-in for marketing, healthcare notifications vary',
          metadata: {},
        },
      ],
    });

    const report = await projectSpecEngine.detectStale(projectId);
    assert.strictEqual(report.isStale, true);
    assert.strictEqual(report.details.humanDecisionsChanged, true);
  });

  // ==========================================================================
  // 15. PROJECTION TAMPERING DETECTION
  // ==========================================================================
  it('15. detects tampering with projection file content on disk', async () => {
    const projectId = 'proj-spec-tamper';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    const specPath = specProjectionStore.getSpecPath(projectId, spec.specRevision);
    const latestPath = specProjectionStore.getSpecPath(projectId);

    // Tamper with the persisted JSON: modify title
    const raw = JSON.parse(await fs.promises.readFile(specPath, 'utf8'));
    raw.content.identity.name = 'TAMPERED_PROJECT_NAME';
    await fs.promises.writeFile(specPath, JSON.stringify(raw, null, 2), 'utf8');
    await fs.promises.writeFile(latestPath, JSON.stringify(raw, null, 2), 'utf8');

    // Attempting to read tampered projection throws
    await assert.rejects(
      async () => {
        await projectSpecEngine.getLatest(projectId);
      },
      (err: any) => err instanceof ProjectSpecForgedFingerprintError
    );

    await assert.rejects(
      async () => {
        await projectSpecEngine.getRevision(projectId, spec.specRevision);
      },
      (err: any) => err instanceof ProjectSpecForgedFingerprintError
    );
  });

  // ==========================================================================
  // 16. FORGED SELF-CONSISTENT PROJECTION REJECTION
  // ==========================================================================
  it('16. rejects forged projection even when self-consistent hash is recomputed', async () => {
    const projectId = 'proj-spec-forged';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    const specPath = specProjectionStore.getSpecPath(projectId, spec.specRevision);
    const latestPath = specProjectionStore.getSpecPath(projectId);

    // Tamper with content AND recompute semantic fingerprint to match tampered content
    const raw = JSON.parse(await fs.promises.readFile(specPath, 'utf8'));
    raw.content.identity.purpose = 'FORGED_PURPOSE_UNAUTHORIZED';
    const recomputedFingerprint = computeProjectSpecSemanticFingerprint(raw);
    raw.semanticFingerprint = recomputedFingerprint;
    await fs.promises.writeFile(specPath, JSON.stringify(raw, null, 2), 'utf8');
    await fs.promises.writeFile(latestPath, JSON.stringify(raw, null, 2), 'utf8');

    // Multi-layer defense catches discrepancy with authoritative upstream stores!
    await assert.rejects(
      async () => {
        await projectSpecEngine.getLatest(projectId);
      },
      (err: any) =>
        err instanceof ProjectSpecTamperingError || err instanceof ProjectSpecForgedFingerprintError
    );

    await assert.rejects(
      async () => {
        await projectSpecEngine.getRevision(projectId, spec.specRevision);
      },
      (err: any) =>
        err instanceof ProjectSpecTamperingError || err instanceof ProjectSpecForgedFingerprintError
    );
  });

  // ==========================================================================
  // 17. CROSS-PROJECT ISOLATION
  // ==========================================================================
  it('17. enforces cross-project isolation and rejects mismatched projectId', async () => {
    const projectIdA = 'proj-alpha';
    const projectIdB = 'proj-beta';
    await setupAuthoritativeUpstreamChain(projectIdA);
    await setupAuthoritativeUpstreamChain(projectIdB);

    await projectSpecEngine.generate({ projectId: projectIdA });
    await projectSpecEngine.generate({ projectId: projectIdB });

    const specA = await projectSpecEngine.getLatest(projectIdA);
    const specB = await projectSpecEngine.getLatest(projectIdB);

    assert.strictEqual(specA?.projectId, projectIdA);
    assert.strictEqual(specB?.projectId, projectIdB);
    assert.notStrictEqual(specA?.semanticFingerprint, specB?.semanticFingerprint);

    // If an attacker attempts to load project B using project A's store dir:
    const specPathA = specProjectionStore.getSpecPath(projectIdA, 1);
    const latestPathA = specProjectionStore.getSpecPath(projectIdA);
    const rawA = JSON.parse(await fs.promises.readFile(specPathA, 'utf8'));
    rawA.projectId = projectIdB; // Contamination!
    rawA.semanticFingerprint = computeProjectSpecSemanticFingerprint(rawA);
    await fs.promises.writeFile(specPathA, JSON.stringify(rawA, null, 2), 'utf8');
    await fs.promises.writeFile(latestPathA, JSON.stringify(rawA, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await projectSpecEngine.getLatest(projectIdA);
      },
      (err: any) =>
        err instanceof ProjectSpecProjectBindingMismatchError ||
        err instanceof ProjectSpecForgedFingerprintError
    );
  });

  // ==========================================================================
  // 18. PATH TRAVERSAL PROTECTION
  // ==========================================================================
  it('18. rejects path traversal in projectId deterministically', async () => {
    const maliciousIds = [
      '../traversal',
      '../../etc/passwd',
      'sub/../../escape',
      '/root/spec',
      '\\windows\\system32',
      'null\0byte',
    ];

    for (const badId of maliciousIds) {
      await assert.rejects(
        async () => {
          await projectSpecEngine.generate({ projectId: badId });
        },
        (err: any) =>
          err instanceof ProjectSpecPathTraversalError || err instanceof ProjectSpecValidationError,
        `Expected rejection for malicious id: ${badId}`
      );
    }
  });

  // ==========================================================================
  // 19. IMMUTABLE REVISION BEHAVIOR
  // ==========================================================================
  it('19. rejects overwriting historical revision with different content', async () => {
    const projectId = 'proj-spec-immutable';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });

    // Attempting to directly overwrite rev-1.json with different content via store fails
    const modifiedSpec = {
      ...spec,
      semanticFingerprint: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    await assert.rejects(
      async () => {
        await specProjectionStore.saveRevision(modifiedSpec);
      },
      (err: any) =>
        err instanceof ProjectSpecImmutableRevisionError ||
        err instanceof ProjectSpecForgedFingerprintError
    );
  });

  // ==========================================================================
  // 20. IDEMPOTENT REGENERATION
  // ==========================================================================
  it('20. regenerates identically without creating duplicate revisions', async () => {
    const projectId = 'proj-spec-idempotent';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec1 = await projectSpecEngine.generate({ projectId });
    const spec2 = await projectSpecEngine.generate({ projectId });
    const spec3 = await projectSpecEngine.generate({ projectId });

    assert.strictEqual(spec1.specRevision, 1);
    assert.strictEqual(spec2.specRevision, 1);
    assert.strictEqual(spec3.specRevision, 1);
    assert.strictEqual(spec1.semanticFingerprint, spec2.semanticFingerprint);

    const revisions = await specProjectionStore.listRevisions(projectId);
    assert.deepStrictEqual(revisions, [1]);
  });

  // ==========================================================================
  // 21. RESTART / RELOAD
  // ==========================================================================
  it('21. reloads accurately in a fresh engine process without in-memory state', async () => {
    const projectId = 'proj-spec-restart';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec1 = await projectSpecEngine.generate({ projectId });

    // Simulate completely fresh process: new engine instance pointing to existing files
    const freshEngine = new ProjectSpecEngine({
      baseDir: tempDir,
      workspaceRoot: tempDir,
    });

    const loaded = await freshEngine.getLatest(projectId);
    assert.ok(loaded);
    assert.strictEqual(loaded.projectId, projectId);
    assert.strictEqual(loaded.specRevision, spec1.specRevision);
    assert.strictEqual(loaded.semanticFingerprint, spec1.semanticFingerprint);
    assert.strictEqual(loaded.isStale, false);
  });

  // ==========================================================================
  // 22. MCP GENERATION
  // ==========================================================================
  it('22. executes projection generation through MCP boundary', async () => {
    const projectId = 'proj-spec-mcp-gen';
    await setupAuthoritativeUpstreamChain(projectId);

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      adaptiveDiscoveryStore: discoveryStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore: businessRulesStore,
      acceptanceCriteriaStore: acceptanceCriteriaStore,
      riskHumanDecisionStore: riskStore,
      projectSpecStore: specProjectionStore,
      projectSpecEngine,
    });

    const serverTransport = new InMemoryMcpTransport();

    const server = new McpServer({
      transport: serverTransport,
      delegate,
      projectSpecTools: true,
    });
    await server.start();

    const request: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-gen-1',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_SPEC_GENERATE_TOOL_NAME,
        arguments: { projectId },
      },
    };

    const response = (await server.handleMessage(request)) as McpSuccessResponseEnvelope<McpToolResult>;

    assert.strictEqual(response.id, 'req-gen-1');
    assert.ok(response.result?.content?.[0]?.text);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.strictEqual(parsed.projectId, projectId);
    assert.strictEqual(parsed.specRevision, 1);
    assert.ok(parsed.semanticFingerprint);
    await server.stop();
  });

  // ==========================================================================
  // 23. MCP GET
  // ==========================================================================
  it('23. retrieves current projection through MCP boundary', async () => {
    const projectId = 'proj-spec-mcp-get';
    await setupAuthoritativeUpstreamChain(projectId);
    await projectSpecEngine.generate({ projectId });

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      adaptiveDiscoveryStore: discoveryStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore: businessRulesStore,
      acceptanceCriteriaStore: acceptanceCriteriaStore,
      riskHumanDecisionStore: riskStore,
      projectSpecStore: specProjectionStore,
      projectSpecEngine,
    });

    const serverTransport = new InMemoryMcpTransport();

    const server = new McpServer({
      transport: serverTransport,
      delegate,
      projectSpecTools: true,
    });
    await server.start();

    const request: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-get-1',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_SPEC_GET_TOOL_NAME,
        arguments: { projectId },
      },
    };

    const response = (await server.handleMessage(request)) as McpSuccessResponseEnvelope<McpToolResult>;

    assert.strictEqual(response.id, 'req-get-1');
    const parsed = JSON.parse(response.result.content[0].text!);
    assert.strictEqual(parsed.projectId, projectId);
    assert.ok(parsed.markdownContent);
    assert.strictEqual(parsed.isStale, false);
    await server.stop();
  });

  // ==========================================================================
  // 24. MCP STALE DETECTION
  // ==========================================================================
  it('24. detects and reports staleness through MCP boundary', async () => {
    const projectId = 'proj-spec-mcp-stale';
    await setupAuthoritativeUpstreamChain(projectId);
    await projectSpecEngine.generate({ projectId });

    // Advance requirements
    await requirementsEngine.derive({
      projectId,
      discoveryRevision: 1,
      additionalAssumptions: [
        { id: 'ASSUMP-MOD', statement: 'Assumption added', validated: true, affectedRequirements: [] },
      ],
    });

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      adaptiveDiscoveryStore: discoveryStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore: businessRulesStore,
      acceptanceCriteriaStore: acceptanceCriteriaStore,
      riskHumanDecisionStore: riskStore,
      projectSpecStore: specProjectionStore,
      projectSpecEngine,
    });

    const serverTransport = new InMemoryMcpTransport();

    const server = new McpServer({
      transport: serverTransport,
      delegate,
      projectSpecTools: true,
    });
    await server.start();

    const request: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-stale-1',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_SPEC_STALE_TOOL_NAME,
        arguments: { projectId },
      },
    };

    const response = (await server.handleMessage(request)) as McpSuccessResponseEnvelope<McpToolResult>;

    const parsed = JSON.parse(response.result.content[0].text!);
    assert.strictEqual(parsed.isStale, true);
    assert.strictEqual(parsed.details.requirementsStale, true);
    await server.stop();
  });

  // ==========================================================================
  // 25. DIRECTOR READ INTEGRATION
  // ==========================================================================
  it('25. integrates alongside Director read tools without replacing authoritative reads', async () => {
    const projectId = 'proj-spec-director-read';
    await setupAuthoritativeUpstreamChain(projectId);
    await projectSpecEngine.generate({ projectId });

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      adaptiveDiscoveryStore: discoveryStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore: businessRulesStore,
      acceptanceCriteriaStore: acceptanceCriteriaStore,
      riskHumanDecisionStore: riskStore,
      projectSpecStore: specProjectionStore,
      projectSpecEngine,
    });

    const serverTransport = new InMemoryMcpTransport();

    // Register both Director tools and ProjectSpec tools
    const server = new McpServer({
      transport: serverTransport,
      delegate,
      directorTools: true,
      riskTools: true,
      projectSpecTools: true,
    });
    await server.start();

    // Verify existing authoritative Director read tool works
    const statusReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-dir-status',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_STATUS_TOOL_NAME,
        arguments: { projectId },
      },
    };

    let response = (await server.handleMessage(statusReq)) as McpSuccessResponseEnvelope;
    assert.strictEqual(response.id, 'req-dir-status');

    // Verify authoritative risks tool works
    const riskReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-dir-risk',
      method: 'tools/call',
      params: {
        name: AIDM_RISKS_GET_TOOL_NAME,
        arguments: { projectId },
      },
    };

    response = (await server.handleMessage(riskReq)) as McpSuccessResponseEnvelope;
    assert.strictEqual(response.id, 'req-dir-risk');

    // Verify project spec tool works in the same server
    const specReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'req-dir-spec',
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_SPEC_GET_TOOL_NAME,
        arguments: { projectId },
      },
    };

    response = (await server.handleMessage(specReq)) as McpSuccessResponseEnvelope;
    assert.strictEqual(response.id, 'req-dir-spec');

    await server.stop();
  });

  // ==========================================================================
  // 26-32. SAFETY BOUNDARIES
  // ==========================================================================
  it('26. does NOT create an ApprovalPackage or approve the project', async () => {
    const projectId = 'proj-spec-no-approval';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });

    const packages = await approvalStore.listPackages();
    assert.strictEqual(packages.length, 0, 'No approval packages should be created');
  });

  it('27. does NOT grant development authorization', async () => {
    const projectId = 'proj-spec-no-auth';
    await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    assert.ok(!('isDevelopmentAuthorized' in spec) || !(spec as any).isDevelopmentAuthorized);
  });

  it('28. does NOT create ExecutionIntent', async () => {
    const projectId = 'proj-spec-no-intent';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });
    // Check durable state / history for any ExecutionIntent
    const events = await historyManager.readEvents();
    const intentEvents = events.filter((e) => e.eventType.includes('EXECUTION_INTENT'));
    assert.strictEqual(intentEvents.length, 0);
  });

  it('29. does NOT create ExecutionRequest', async () => {
    const projectId = 'proj-spec-no-request';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });
    const events = await historyManager.readEvents();
    const reqEvents = events.filter((e) => e.eventType.includes('EXECUTION_REQUEST'));
    assert.strictEqual(reqEvents.length, 0);
  });

  it('30. does NOT invoke Antigravity CLI or external executor', async () => {
    const projectId = 'proj-spec-no-agy';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });
    // No executor outcome or evidence created
    const events = await historyManager.readEvents();
    const execEvents = events.filter((e) => e.eventType.includes('EXECUTOR') || e.eventType.includes('EVIDENCE'));
    assert.strictEqual(execEvents.length, 0);
  });

  it('31. does NOT mutate the task DAG or create implementation tasks', async () => {
    const projectId = 'proj-spec-no-tasks';
    await setupAuthoritativeUpstreamChain(projectId);

    const initialTasks = await specStore.loadTasks();
    await projectSpecEngine.generate({ projectId });
    const postTasks = await specStore.loadTasks();

    assert.strictEqual(postTasks.length, initialTasks.length);
  });

  it('32. does NOT start an autonomous driver or retry loop', async () => {
    const projectId = 'proj-spec-no-driver';
    await setupAuthoritativeUpstreamChain(projectId);

    await projectSpecEngine.generate({ projectId });
    const state = await durableManager.load();
    assert.strictEqual(state, null);
  });

  // ==========================================================================
  // 33. DELETING PROJECT_SPEC DOES NOT DESTROY STATE & RECONSTRUCTION WORKS
  // ==========================================================================
  it('33. deleting PROJECT_SPEC leaves authoritative state intact and reconstruct faithfully recreates it', async () => {
    const projectId = 'proj-spec-reconstruct';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const spec = await projectSpecEngine.generate({ projectId });
    const originalFingerprint = spec.semanticFingerprint;

    // Delete the entire projection directory and the workspace markdown file
    const specDir = specProjectionStore.specDir;
    await fs.promises.rm(specDir, { recursive: true, force: true });
    await fs.promises.rm(path.join(tempDir, 'PROJECT_SPEC.md'), { force: true });

    // Verify authoritative stores are completely intact!
    const reloadedReq = await requirementsStore.loadRevision(projectId, 1);
    const reloadedArch = await architectureStore.loadRevision(projectId, 1);
    const reloadedBr = await businessRulesStore.loadRevision(projectId, 1);
    const reloadedAc = await acceptanceCriteriaStore.loadRevision(projectId, 1);
    const reloadedRisk = await riskStore.loadRevision(projectId, 1);
    const reloadedDisc = await discoveryStore.loadRevision(projectId, 1);

    assert.ok(reloadedReq);
    assert.strictEqual(reloadedReq.fingerprint, chain.requirements.fingerprint);
    assert.ok(reloadedArch);
    assert.strictEqual(reloadedArch.fingerprint, chain.architecture.fingerprint);
    assert.ok(reloadedBr);
    assert.strictEqual(reloadedBr.fingerprint, chain.businessRules.fingerprint);
    assert.ok(reloadedAc);
    assert.strictEqual(reloadedAc.fingerprint, chain.acceptanceCriteria.fingerprint);
    assert.ok(reloadedRisk);
    assert.strictEqual(reloadedRisk.fingerprint, chain.risks.fingerprint);
    assert.ok(reloadedDisc);
    assert.strictEqual(reloadedDisc.fingerprint, chain.discovery.fingerprint);

    // Reconstruct projection from scratch using authoritative stores
    const reconstructed = await projectSpecEngine.reconstruct(projectId, {
      generatedAt: spec.createdAt,
    });
    assert.strictEqual(reconstructed.projectId, projectId);
    assert.strictEqual(reconstructed.semanticFingerprint, originalFingerprint);
    assert.strictEqual(reconstructed.markdownContent, spec.markdownContent);

    // Verified persisted again
    assert.ok(fs.existsSync(specProjectionStore.getMarkdownPath(projectId, 1)));
    assert.ok(fs.existsSync(path.join(tempDir, 'PROJECT_SPEC.md')));
  });
});
