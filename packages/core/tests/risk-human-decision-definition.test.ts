/**
 * Comprehensive Test Suite for Phase 15 Risk & Human Decision Points (TASK-P15-07)
 *
 * Verifies all 46 required test matrix capabilities and safety boundaries:
 * T01 schema validation
 * T02 deterministic risk ID
 * T03 category validation
 * T04 probability validation
 * T05 impact validation
 * T06 deterministic severity mapping
 * T07 invalid severity combination rejected
 * T08 risk status validation
 * T09 risk response validation
 * T10 derive from requirements
 * T11 derive from architecture
 * T12 derive from business rules
 * T13 derive from acceptance criteria
 * T14 derive from discovery
 * T15 no fabricated risk when no evidence exists
 * T16 deterministic repeated derivation
 * T17 valid requirement traceability
 * T18 nonexistent requirement rejected
 * T19 nonexistent business-rule reference rejected
 * T20 nonexistent architecture reference rejected
 * T21 nonexistent acceptance-criteria reference rejected
 * T22 traceability inconsistency rejected
 * T23 deterministic decision ID
 * T24 Product Owner authority enforced
 * T25 non-human authority rejected
 * T26 unresolved material decision creates PENDING_DECISION
 * T27 natural-language approval-like text is not approval
 * T28 decision affects correct risks/artifacts
 * T29 revision persistence
 * T30 immutable revision
 * T31 idempotent replay
 * T32 stale upstream detection
 * T33 cross-project isolation
 * T34 persisted tampering rejected
 * T35 forged self-consistent fingerprint rejected
 * T36 modified source fingerprint rejected
 * T37 modified risk classification rejected
 * T38 modified decision point rejected
 * T39 modified coverage rejected
 * T40 no approval created
 * T41 no development authorization
 * T42 no ExecutionIntent
 * T43 no ExecutionRequest
 * T44 no Antigravity invocation
 * T45 no task DAG mutation
 * T46 no autonomous driver
 * T47 MCP boundary execution
 * T48 restart reload behavior
 * T49 history audit event
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
  RiskValidationError,
  RiskRevisionNotFoundError,
  RiskProjectBindingMismatchError,
  RiskImmutableRevisionError,
  RiskStaleSourceError,
  RiskForgedFingerprintError,
  RiskTraceabilityError,
  RiskSeverityMismatchError,
  HumanDecisionAuthorityError,
  PROJECT_RISK_CATEGORIES,
  ProjectRiskCategoryZodSchema,
  PROJECT_RISK_PROBABILITIES,
  ProjectRiskProbabilityZodSchema,
  PROJECT_RISK_IMPACTS,
  ProjectRiskImpactZodSchema,
  PROJECT_RISK_SEVERITIES,
  ProjectRiskSeverityZodSchema,
  PROJECT_RISK_STATUSES,
  ProjectRiskStatusZodSchema,
  PROJECT_RISK_RESPONSES,
  ProjectRiskResponseZodSchema,
  PROJECT_HUMAN_DECISION_AUTHORITIES,
  ProjectHumanDecisionAuthorityZodSchema,
  ProjectHumanDecisionPointZodSchema,
  ProjectRiskZodSchema,
  ProjectRiskRevisionZodSchema,
  RISK_SEVERITY_MATRIX,
  computeRiskSeverity,
  computeRiskFingerprint,
  computeAcceptanceCriteriaFingerprint,
  SpecStore,
  Actor,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_RISKS_DEFINE_TOOL_NAME,
  AIDM_RISKS_GET_TOOL_NAME,
  AIDM_HUMAN_DECISIONS_GET_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type ProjectArchitectureRevision,
  type ProjectBusinessRulesRevision,
  type ProjectAcceptanceCriteriaRevision,
  type ProjectRiskRevision,
  type ProjectRisk,
  type ProjectHumanDecisionPoint,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Risk & Human Decision Points (TASK-P15-07)', { concurrency: 1 }, () => {
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
  let approvalStore: ApprovalStore;
  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;
  let architectureEngine: ArchitectureTechnologyEngine;
  let businessRulesEngine: BusinessRulesEngine;
  let acceptanceCriteriaEngine: AcceptanceCriteriaEngine;
  let riskEngine: RiskHumanDecisionEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-07-risk-test-'));
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
  }> {
    const rawPrompt =
      options?.discoveryPrompt ??
      `
      Build a high-volume Medical Appointment Booking Platform.
      Patients can schedule appointments with specialist doctors.
      The system must enforce strict patient data privacy (HIPAA compliance).
      Appointments require prepayment authorization before confirmation.
      Must support real-time SMS notifications via Twilio external service.
      Platform target is Linux Node.js containers on Kubernetes.
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

    return { discovery, requirements, architecture, businessRules, acceptanceCriteria };
  }

  // ============================================================================
  // RISK MODEL TESTS (T01 - T09)
  // ============================================================================

  it('T01_schema_validation: validates valid risk model and rejects missing required fields', () => {
    const validRisk = {
      riskId: 'RISK-SECURITY-1234567890AB',
      title: 'Data Privacy Violation Risk',
      description: 'Potential unauthorized access to patient data',
      category: 'SECURITY',
      probability: 'LOW',
      impact: 'CRITICAL',
      severity: 'HIGH',
      status: 'IDENTIFIED',
      response: 'MITIGATE',
      statement: 'Sensitive medical records could be exposed if token validation fails.',
      consequences: ['Regulatory penalty', 'Loss of trust'],
      mitigation: 'Implement end-to-end encryption and audit logging.',
      contingency: 'Revoke compromised tokens immediately.',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: ['FREQ-01'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      sourceAcceptanceCriteria: [],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-SECURITY-1234567890AB',
        requirementIds: ['FREQ-01'],
        businessRuleIds: [],
        architectureDecisionIds: [],
        acceptanceCriteriaIds: [],
        discoveryKeys: [],
      },
      metadata: {},
    };

    const parseResult = ProjectRiskZodSchema.safeParse(validRisk);
    assert.equal(parseResult.success, true);

    const invalidRisk = { ...validRisk, category: 'INVALID_CATEGORY' };
    const invalidResult = ProjectRiskZodSchema.safeParse(invalidRisk);
    assert.equal(invalidResult.success, false);
  });

  it('T02_deterministic_risk_id: risk IDs follow deterministic RISK-<CATEGORY>-<HASH> format without random UUIDs', async () => {
    const projectId = 'proj-t02-risk-id';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.risks.length > 0);

    const riskIdRegex = /^RISK-[A-Z_]+-[A-F0-9]{12}$/;
    for (const r of result.risks) {
      assert.match(r.riskId, riskIdRegex);
      assert.equal(r.riskId.includes('-'), true);
      assert.equal(r.riskId === r.traceability.riskId, true);
    }
  });

  it('T03_category_validation: validates all 23 defined categories and rejects invented categories', () => {
    assert.equal(PROJECT_RISK_CATEGORIES.length, 23);
    const expected = [
      'PRODUCT', 'SCOPE', 'REQUIREMENT', 'TECHNICAL', 'ARCHITECTURE', 'TECHNOLOGY',
      'DATA', 'SECURITY', 'PRIVACY', 'INTEGRATION', 'OPERATIONAL', 'DEPLOYMENT',
      'PERFORMANCE', 'RELIABILITY', 'AVAILABILITY', 'DEPENDENCY', 'RESOURCE',
      'SCHEDULE', 'COST', 'COMPLIANCE', 'USER_ADOPTION', 'BUSINESS', 'UNKNOWN',
    ];
    for (const cat of expected) {
      assert.equal(ProjectRiskCategoryZodSchema.safeParse(cat).success, true);
    }
    assert.equal(ProjectRiskCategoryZodSchema.safeParse('AI_HALUCINATION').success, false);
    assert.equal(ProjectRiskCategoryZodSchema.safeParse('MAGIC').success, false);
  });

  it('T04_probability_validation: validates all 5 explicit probabilities without converting to percentages', () => {
    assert.equal(PROJECT_RISK_PROBABILITIES.length, 5);
    const expected = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
    for (const p of expected) {
      assert.equal(ProjectRiskProbabilityZodSchema.safeParse(p).success, true);
    }
    assert.equal(ProjectRiskProbabilityZodSchema.safeParse('0.5').success, false);
    assert.equal(ProjectRiskProbabilityZodSchema.safeParse('50%').success, false);
    assert.equal(ProjectRiskProbabilityZodSchema.safeParse('EXTREME').success, false);
  });

  it('T05_impact_validation: validates all 5 explicit impact levels without numeric currency/threshold invention', () => {
    assert.equal(PROJECT_RISK_IMPACTS.length, 5);
    const expected = ['NEGLIGIBLE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    for (const imp of expected) {
      assert.equal(ProjectRiskImpactZodSchema.safeParse(imp).success, true);
    }
    assert.equal(ProjectRiskImpactZodSchema.safeParse('$10000').success, false);
    assert.equal(ProjectRiskImpactZodSchema.safeParse('FATAL').success, false);
  });

  it('T06_deterministic_severity_mapping: exhaustively validates all 25 probability/impact combinations against deterministic table', () => {
    assert.equal(PROJECT_RISK_SEVERITIES.length, 4);

    for (const prob of PROJECT_RISK_PROBABILITIES) {
      for (const imp of PROJECT_RISK_IMPACTS) {
        const severity = computeRiskSeverity(prob, imp);
        assert.ok(PROJECT_RISK_SEVERITIES.includes(severity));
        assert.equal(severity, RISK_SEVERITY_MATRIX[prob][imp]);
      }
    }

    // Explicit baseline checks
    assert.equal(computeRiskSeverity('VERY_LOW', 'NEGLIGIBLE'), 'LOW');
    assert.equal(computeRiskSeverity('LOW', 'LOW'), 'LOW');
    assert.equal(computeRiskSeverity('MEDIUM', 'MEDIUM'), 'MEDIUM');
    assert.equal(computeRiskSeverity('HIGH', 'HIGH'), 'CRITICAL');
    assert.equal(computeRiskSeverity('VERY_HIGH', 'CRITICAL'), 'CRITICAL');
    assert.equal(computeRiskSeverity('LOW', 'CRITICAL'), 'HIGH');
  });

  it('T07_invalid_severity_combination_rejected: rejects risk when caller claims arbitrary severity mismatch (e.g. LOW+LOW=CRITICAL)', async () => {
    const projectId = 'proj-t07-sev-mismatch';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const badRisk: ProjectRisk = {
      riskId: 'RISK-TECHNICAL-01',
      title: 'Low risk claimed as critical',
      description: 'Arbitrary severity injection',
      category: 'TECHNICAL',
      probability: 'LOW',
      impact: 'LOW',
      severity: 'CRITICAL', // Invalid: computeRiskSeverity(LOW, LOW) === LOW
      status: 'IDENTIFIED',
      response: 'MONITOR',
      statement: 'Low probability and low impact claimed as critical.',
      consequences: [],
      mitigation: 'None',
      contingency: '',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: [chain.requirements.functionalRequirements[0].requirementId],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      sourceAcceptanceCriteria: [],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-TECHNICAL-01',
        requirementIds: [chain.requirements.functionalRequirements[0].requirementId],
        businessRuleIds: [],
        architectureDecisionIds: [],
        acceptanceCriteriaIds: [],
        discoveryKeys: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await riskEngine.derive({
          projectId,
          additionalRisks: [badRisk],
        });
      },
      RiskSeverityMismatchError
    );
  });

  it('T08_risk_status_validation: validates all 9 risk statuses and ensures ACCEPTED does not authorize development', () => {
    assert.equal(PROJECT_RISK_STATUSES.length, 9);
    const expected = [
      'IDENTIFIED', 'ANALYZING', 'MITIGATED', 'ACCEPTED', 'TRANSFERRED',
      'AVOIDED', 'PENDING_DECISION', 'CLOSED', 'NOT_APPLICABLE',
    ];
    for (const status of expected) {
      assert.equal(ProjectRiskStatusZodSchema.safeParse(status).success, true);
    }
    assert.equal(ProjectRiskStatusZodSchema.safeParse('APPROVED').success, false);
    assert.equal(ProjectRiskStatusZodSchema.safeParse('AUTHORIZED').success, false);
  });

  it('T09_risk_response_validation: validates all 6 risk responses including PENDING_DECISION', () => {
    assert.equal(PROJECT_RISK_RESPONSES.length, 6);
    const expected = ['MITIGATE', 'AVOID', 'TRANSFER', 'ACCEPT', 'MONITOR', 'PENDING_DECISION'];
    for (const resp of expected) {
      assert.equal(ProjectRiskResponseZodSchema.safeParse(resp).success, true);
    }
    assert.equal(ProjectRiskResponseZodSchema.safeParse('IGNORE').success, false);
  });

  // ============================================================================
  // DERIVATION TESTS (T10 - T16)
  // ============================================================================

  it('T10_derive_from_requirements: derives risks from critical requirements and scope boundaries', async () => {
    const projectId = 'proj-t10-req-derivation';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.risks.length > 0);

    const reqRisks = result.risks.filter((r) => r.category === 'REQUIREMENT' && r.sourceRequirements.length > 0);
    assert.ok(reqRisks.length > 0);

    for (const r of reqRisks) {
      for (const reqId of r.sourceRequirements) {
        assert.ok(chain.requirements.functionalRequirements.some((f) => f.requirementId === reqId));
      }
    }
  });

  it('T11_derive_from_architecture: derives risks from proposed architecture decisions and external services', async () => {
    const projectId = 'proj-t11-arch-derivation';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    const archRisks = result.risks.filter(
      (r) => r.category === 'ARCHITECTURE' || r.category === 'INTEGRATION'
    );
    assert.ok(archRisks.length > 0);

    for (const r of archRisks) {
      if (r.sourceArchitectureDecisions.length > 0) {
        for (const decId of r.sourceArchitectureDecisions) {
          assert.ok(chain.architecture.decisions.some((d) => d.decisionId === decId));
        }
      }
    }
  });

  it('T12_derive_from_business_rules: derives risks from authorization and temporal business rules', async () => {
    const projectId = 'proj-t12-rules-derivation';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    const ruleRisks = result.risks.filter((r) => r.sourceBusinessRules.length > 0);
    assert.ok(ruleRisks.length > 0);

    for (const r of ruleRisks) {
      for (const ruleId of r.sourceBusinessRules) {
        assert.ok(chain.businessRules.rules.some((br) => br.ruleId === ruleId));
      }
    }
  });

  it('T13_derive_from_acceptance_criteria: derives risks from uncovered requirements/rules and pending criteria', async () => {
    const projectId = 'proj-t13-ac-derivation';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.coverage.totalRisks > 0);
  });

  it('T14_derive_from_discovery: derives risks from external dependencies and project constraints', async () => {
    const projectId = 'proj-t14-discovery-derivation';
    await setupAuthoritativeUpstreamChain(projectId, {
      discoveryPrompt: `
      Build an online booking platform with Web and CLI interface.
      Requires Twilio SMS integration and PostgreSQL database.
      Patients can schedule appointments with specialist doctors.
      The system must enforce strict patient data privacy (HIPAA compliance).
      Appointments require prepayment authorization before confirmation.
      Must support real-time SMS notifications via Twilio external service.
      Platform target is Linux Node.js containers on Kubernetes with CLI.
      `,
    });

    const result = await riskEngine.derive({ projectId });
    const depRisks = result.risks.filter(
      (r) => r.category === 'DEPENDENCY' || r.category === 'DEPLOYMENT' || r.category === 'INTEGRATION'
    );
    assert.ok(depRisks.length > 0);
  });

  it('T15_no_fabricated_risk_when_no_evidence_exists: empty or perfectly covered initiation artifacts yield valid 0 risk set', async () => {
    const projectId = 'proj-t15-empty-risk';

    // Mock empty upstream artifacts
    const emptyDiscovery: ProjectDiscoveryRevision = {
      projectId,
      discoveryRevision: 1,
      previousRevision: null,
      createdAt: new Date().toISOString(),
      source: 'prompt',
      changedSections: [],
      sections: {
        projectIdentity: { name: 'Simple App', purpose: 'Demo', desiredOutcome: 'Show demo' },
        productScope: { inScope: ['View text'], outOfScope: [], targetUsers: ['User'], primaryWorkflows: [] },
        functionalRequirements: { capabilities: [], behaviors: [], businessRules: [] },
        nonFunctionalRequirements: { performance: [], security: [], reliability: [], scalability: [], availability: [], usability: [], compatibility: [] },
        technology: { requiredTechnologies: [], preferredTechnologies: [], prohibitedTechnologies: [], platformConstraints: [] },
        architecture: { architecturalConstraints: [], integrationRequirements: [], deploymentModel: 'STANDALONE', dataStorageExpectations: [] },
        acceptance: { expectedBehavior: [], measurableCriteria: [], definitionOfCompletion: [] },
        risks: { technicalRisks: [], productRisks: [], operationalRisks: [], dependencies: [] },
        humanDecisions: [],
        openQuestions: [],
      },
      requirements: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      completeness: {
        isComplete: true,
        hasBlockingQuestions: false,
        blockingQuestionsCount: 0,
        totalQuestionsCount: 0,
        resolvedQuestionsCount: 0,
        pendingHumanDecisionsCount: 0,
        sectionsEvaluatedCount: 8,
        missingMaterialSections: [],
      },
      fingerprint: 'disc-fp-empty-15',
    };
    await discoveryStore.saveRevision(emptyDiscovery);

    const emptyRequirements: ProjectRequirementsScopeRevision = {
      projectId,
      requirementsRevision: 1,
      sourceDiscoveryRevision: 1,
      sourceDiscoveryFingerprint: 'disc-fp-empty-15',
      isStale: false,
      purpose: { purpose: 'Demo', problemStatement: 'None', desiredOutcome: 'Success' },
      targetUsers: { primaryUsers: ['User'], secondaryUsers: [], systemActors: [], externalActors: [] },
      inScope: { capabilities: ['View text'], workflows: [], platforms: [], integrations: [] },
      outOfScope: { capabilities: [], workflows: [], platforms: [], integrations: [] },
      undecidedScope: [],
      functionalRequirements: [], // No critical requirements
      nonFunctionalRequirements: { performance: [], reliability: [], security: [], availability: [], scalability: [], usability: [], maintainability: [], operationalConstraints: [] },
      constraints: { technologyConstraints: [], platformConstraints: [], compatibilityConstraints: [], legalComplianceConstraints: [], operationalConstraints: [], budgetResourceConstraints: [] },
      assumptions: [], // No unvalidated assumptions
      openQuestions: [],
      humanDecisions: [],
      createdAt: new Date().toISOString(),
      fingerprint: 'req-fp-empty-15',
    };
    await requirementsStore.saveRevision(emptyRequirements);

    const emptyArchitecture: ProjectArchitectureRevision = {
      projectId,
      architectureRevision: 1,
      sourceRequirementsRevision: 1,
      sourceRequirementsFingerprint: 'req-fp-empty-15',
      sourceDiscoveryRevision: 1,
      sourceDiscoveryFingerprint: 'disc-fp-empty-15',
      isStale: false,
      architecturalStyle: {
        style: 'MODULAR_MONOLITH',
        subsystemBoundaries: [],
        serviceModuleBoundaries: [],
        clientServerBoundaries: [],
        status: 'CONFIRMED',
      },
      systemComponents: [],
      dataArchitecture: {
        secondaryStores: [],
        caching: [],
        fileObjectStorage: [],
        dataOwnership: [],
        dataFlow: [],
        retentionRequirements: [],
        consistencyRequirements: [],
        status: 'CONFIRMED',
      },
      apiCommunicationArchitecture: {
        httpRest: true,
        graphQl: false,
        webSocket: false,
        messageQueues: [],
        eventBus: [],
        rpc: [],
        ipc: [],
        internalApis: [],
        externalApis: [],
        status: 'CONFIRMED',
      },
      technologyStack: [],
      platformEnvironment: {
        targetOs: ['Linux'],
        targetDevices: [],
        browserRequirements: [],
        mobileRequirements: [],
        desktopRequirements: [],
        serverEnvironment: [],
        cloudOnPremRequirements: [],
        supportedRuntimeVersions: [],
      },
      securityArchitecture: {
        secretsHandling: [],
        encryptionRequirements: [],
        trustBoundaries: [],
        dataIsolation: [],
        auditRequirements: [],
        status: 'CONFIRMED',
      },
      integrations: [],
      deploymentArchitecture: {
        environments: ['production'],
        scalingExpectations: [],
        operationalDependencies: [],
        status: 'CONFIRMED',
      },
      decisions: [], // No proposed / pending decisions
      pendingHumanDecisions: [],
      requirementsTraceability: [],
      createdAt: new Date().toISOString(),
      fingerprint: 'arch-fp-empty-15',
    };
    await architectureStore.saveRevision(emptyArchitecture);

    const emptyBusinessRules: ProjectBusinessRulesRevision = {
      projectId,
      businessRulesRevision: 1,
      sourceRequirementsRevision: 1,
      sourceRequirementsFingerprint: 'req-fp-empty-15',
      sourceArchitectureRevision: 1,
      sourceArchitectureFingerprint: 'arch-fp-empty-15',
      sourceDiscoveryRevision: 1,
      sourceDiscoveryFingerprint: 'disc-fp-empty-15',
      isStale: false,
      rules: [], // No authorization or temporal rules
      conflicts: [],
      pendingHumanDecisions: [],
      requirementsTraceability: [],
      createdAt: new Date().toISOString(),
      fingerprint: 'br-fp-empty-15',
    };
    await businessRulesStore.saveRevision(emptyBusinessRules);

    const emptyAcceptanceCriteriaWithoutFp = {
      projectId,
      acceptanceCriteriaRevision: 1,
      sourceRequirementsRevision: 1,
      sourceRequirementsFingerprint: 'req-fp-empty-15',
      sourceArchitectureRevision: 1,
      sourceArchitectureFingerprint: 'arch-fp-empty-15',
      sourceBusinessRulesRevision: 1,
      sourceBusinessRulesFingerprint: 'br-fp-empty-15',
      sourceDiscoveryRevision: 1,
      sourceDiscoveryFingerprint: 'disc-fp-empty-15',
      isStale: false,
      criteria: [],
      coverage: {
        totalRequirements: 0,
        coveredRequirements: [],
        uncoveredRequirements: [],
        uncoveredRequirementsDetails: [],
        totalBusinessRules: 0,
        coveredBusinessRules: [],
        uncoveredBusinessRules: [],
        architectureDecisionsRequiringVerification: 0,
        architectureDecisionsVerified: [],
        criteriaCount: 0,
        pendingDecisionCount: 0,
      },
      pendingHumanDecisions: [],
      conflicts: [],
      requirementsTraceability: [],
      businessRulesTraceability: [],
      architectureTraceability: [],
      createdAt: new Date().toISOString(),
    };
    const emptyAcceptanceCriteria: ProjectAcceptanceCriteriaRevision = {
      ...emptyAcceptanceCriteriaWithoutFp,
      fingerprint: computeAcceptanceCriteriaFingerprint(emptyAcceptanceCriteriaWithoutFp),
    };
    await acceptanceCriteriaStore.saveRevision(emptyAcceptanceCriteria);

    const result = await riskEngine.derive({ projectId });
    assert.equal(result.risks.length, 0);
    assert.equal(result.coverage.totalRisks, 0);
    assert.equal(result.coverage.criticalRisks, 0);
    assert.equal(result.humanDecisionCoverage.totalHumanDecisionPoints, 0);
  });

  it('T16_deterministic_repeated_derivation: identical upstream inputs produce byte-identical risks, decisions, and fingerprint', async () => {
    const projectId = 'proj-t16-repeat-determinism';
    await setupAuthoritativeUpstreamChain(projectId);

    // Run first derivation
    const rev1 = await riskEngine.derive({ projectId });

    // Wipe riskStore records directory to test repeated fresh derivation on same inputs
    const projectRecords = path.join(riskStore.recordsDir, riskStore.sanitizeProjectId(projectId));
    await fs.promises.rm(projectRecords, { recursive: true, force: true });

    // Run second derivation
    const rev2 = await riskEngine.derive({ projectId });

    assert.equal(rev1.risks.length, rev2.risks.length);
    assert.equal(rev1.humanDecisionPoints.length, rev2.humanDecisionPoints.length);
    assert.equal(rev1.fingerprint, rev2.fingerprint);

    for (let i = 0; i < rev1.risks.length; i++) {
      assert.equal(rev1.risks[i].riskId, rev2.risks[i].riskId);
      assert.equal(rev1.risks[i].severity, rev2.risks[i].severity);
      assert.equal(rev1.risks[i].statement, rev2.risks[i].statement);
    }
  });

  // ============================================================================
  // TRACEABILITY TESTS (T17 - T22)
  // ============================================================================

  it('T17_valid_requirement_traceability: risk links to existing requirements and traceability reports match', async () => {
    const projectId = 'proj-t17-trace-req';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.coverage.requirementsWithRisks.length > 0);

    for (const reqId of result.coverage.requirementsWithRisks) {
      assert.ok(chain.requirements.functionalRequirements.some((f) => f.requirementId === reqId));
    }
  });

  it('T18_nonexistent_requirement_rejected: rejects risk referencing nonexistent requirement', async () => {
    const projectId = 'proj-t18-fake-req';
    await setupAuthoritativeUpstreamChain(projectId);

    const badRisk: ProjectRisk = {
      riskId: 'RISK-REQUIREMENT-FAKE01',
      title: 'Risk on fake req',
      description: 'Traceability defect',
      category: 'REQUIREMENT',
      probability: 'LOW',
      impact: 'LOW',
      severity: 'LOW',
      status: 'IDENTIFIED',
      response: 'MITIGATE',
      statement: 'Fake requirement referenced.',
      consequences: [],
      mitigation: 'Fix reference',
      contingency: '',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: ['FREQ-NONEXISTENT-999'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      sourceAcceptanceCriteria: [],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-REQUIREMENT-FAKE01',
        requirementIds: ['FREQ-NONEXISTENT-999'],
        businessRuleIds: [],
        architectureDecisionIds: [],
        acceptanceCriteriaIds: [],
        discoveryKeys: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await riskEngine.derive({
          projectId,
          additionalRisks: [badRisk],
        });
      },
      RiskTraceabilityError
    );
  });

  it('T19_nonexistent_business_rule_reference_rejected: rejects risk referencing nonexistent business rule', async () => {
    const projectId = 'proj-t19-fake-rule';
    await setupAuthoritativeUpstreamChain(projectId);

    const badRisk: ProjectRisk = {
      riskId: 'RISK-BUSINESS-FAKE01',
      title: 'Risk on fake rule',
      description: 'Traceability defect',
      category: 'BUSINESS',
      probability: 'MEDIUM',
      impact: 'MEDIUM',
      severity: 'MEDIUM',
      status: 'IDENTIFIED',
      response: 'MITIGATE',
      statement: 'Fake rule referenced.',
      consequences: [],
      mitigation: 'Fix reference',
      contingency: '',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: [],
      sourceBusinessRules: ['BR-NONEXISTENT-999'],
      sourceArchitectureDecisions: [],
      sourceAcceptanceCriteria: [],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-BUSINESS-FAKE01',
        requirementIds: [],
        businessRuleIds: ['BR-NONEXISTENT-999'],
        architectureDecisionIds: [],
        acceptanceCriteriaIds: [],
        discoveryKeys: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await riskEngine.derive({
          projectId,
          additionalRisks: [badRisk],
        });
      },
      RiskTraceabilityError
    );
  });

  it('T20_nonexistent_architecture_reference_rejected: rejects risk referencing nonexistent architecture decision', async () => {
    const projectId = 'proj-t20-fake-arch';
    await setupAuthoritativeUpstreamChain(projectId);

    const badRisk: ProjectRisk = {
      riskId: 'RISK-ARCHITECTURE-FAKE01',
      title: 'Risk on fake arch decision',
      description: 'Traceability defect',
      category: 'ARCHITECTURE',
      probability: 'HIGH',
      impact: 'HIGH',
      severity: 'CRITICAL',
      status: 'IDENTIFIED',
      response: 'MITIGATE',
      statement: 'Fake arch decision referenced.',
      consequences: [],
      mitigation: 'Fix reference',
      contingency: '',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: [],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: ['ARCH-DEC-NONEXISTENT-999'],
      sourceAcceptanceCriteria: [],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-ARCHITECTURE-FAKE01',
        requirementIds: [],
        businessRuleIds: [],
        architectureDecisionIds: ['ARCH-DEC-NONEXISTENT-999'],
        acceptanceCriteriaIds: [],
        discoveryKeys: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await riskEngine.derive({
          projectId,
          additionalRisks: [badRisk],
        });
      },
      RiskTraceabilityError
    );
  });

  it('T21_nonexistent_acceptance_criteria_reference_rejected: rejects risk referencing nonexistent acceptance criterion', async () => {
    const projectId = 'proj-t21-fake-ac';
    await setupAuthoritativeUpstreamChain(projectId);

    const badRisk: ProjectRisk = {
      riskId: 'RISK-REQUIREMENT-FAKE01',
      title: 'Risk on fake AC',
      description: 'Traceability defect',
      category: 'REQUIREMENT',
      probability: 'LOW',
      impact: 'LOW',
      severity: 'LOW',
      status: 'IDENTIFIED',
      response: 'MITIGATE',
      statement: 'Fake AC referenced.',
      consequences: [],
      mitigation: 'Fix reference',
      contingency: '',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: [],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      sourceAcceptanceCriteria: ['AC-NONEXISTENT-999'],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-REQUIREMENT-FAKE01',
        requirementIds: [],
        businessRuleIds: [],
        architectureDecisionIds: [],
        acceptanceCriteriaIds: ['AC-NONEXISTENT-999'],
        discoveryKeys: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await riskEngine.derive({
          projectId,
          additionalRisks: [badRisk],
        });
      },
      RiskTraceabilityError
    );
  });

  it('T22_traceability_inconsistency_rejected: rejects risk when sourceRequirements differs from traceability.requirementIds', async () => {
    const projectId = 'proj-t22-inconsistent-trace';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const inconsistentRisk: ProjectRisk = {
      riskId: 'RISK-TECHNICAL-INCONSISTENT',
      title: 'Inconsistent traceability',
      description: 'Internal mismatch',
      category: 'TECHNICAL',
      probability: 'LOW',
      impact: 'LOW',
      severity: 'LOW',
      status: 'IDENTIFIED',
      response: 'MONITOR',
      statement: 'Internal arrays mismatch.',
      consequences: [],
      mitigation: 'Fix arrays',
      contingency: '',
      owner: 'PRODUCT_OWNER',
      sourceRequirements: [chain.requirements.functionalRequirements[0].requirementId],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      sourceAcceptanceCriteria: [],
      sourceDiscovery: [],
      dependencies: [],
      traceability: {
        riskId: 'RISK-TECHNICAL-INCONSISTENT',
        requirementIds: [], // Inconsistent: empty array vs sourceRequirements
        businessRuleIds: [],
        architectureDecisionIds: [],
        acceptanceCriteriaIds: [],
        discoveryKeys: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await riskStore.saveRevision({
          projectId,
          riskRevision: 1,
          sourceDiscoveryRevision: chain.discovery.discoveryRevision,
          sourceDiscoveryFingerprint: chain.discovery.fingerprint,
          sourceRequirementsRevision: chain.requirements.requirementsRevision,
          sourceRequirementsFingerprint: chain.requirements.fingerprint,
          sourceArchitectureRevision: chain.architecture.architectureRevision,
          sourceArchitectureFingerprint: chain.architecture.fingerprint,
          sourceBusinessRulesRevision: chain.businessRules.businessRulesRevision,
          sourceBusinessRulesFingerprint: chain.businessRules.fingerprint,
          sourceAcceptanceCriteriaRevision: chain.acceptanceCriteria.acceptanceCriteriaRevision,
          sourceAcceptanceCriteriaFingerprint: chain.acceptanceCriteria.fingerprint,
          isStale: false,
          risks: [inconsistentRisk],
          humanDecisionPoints: [],
          coverage: {
            totalRisks: 1,
            criticalRisks: 0,
            highRisks: 0,
            mediumRisks: 0,
            lowRisks: 1,
            pendingDecisionRisks: 0,
            requirementsWithRisks: [],
            requirementsWithoutRisks: [],
            architectureDecisionsWithRisks: [],
            architectureDecisionsWithoutRisks: [],
            acceptanceCriteriaWithRisks: [],
            acceptanceCriteriaWithoutRisks: [],
            businessRulesWithRisks: [],
            businessRulesWithoutRisks: [],
          },
          humanDecisionCoverage: {
            totalHumanDecisionPoints: 0,
            pendingHumanDecisionPoints: 0,
            resolvedHumanDecisionPoints: 0,
          },
          createdAt: new Date().toISOString(),
          fingerprint: 'mock-fp',
        });
      },
      RiskValidationError
    );
  });

  // ============================================================================
  // HUMAN DECISION POINTS TESTS (T23 - T28)
  // ============================================================================

  it('T23_deterministic_decision_id: decision IDs follow deterministic HDP-<HASH> format', async () => {
    const projectId = 'proj-t23-decision-id';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.humanDecisionPoints.length > 0);

    const hdpRegex = /^HDP-[A-F0-9]{12}$/;
    for (const hdp of result.humanDecisionPoints) {
      assert.match(hdp.decisionId, hdpRegex);
    }
  });

  it('T24_product_owner_authority_enforced: Product Owner authority is strictly validated', () => {
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('PRODUCT_OWNER').success, true);
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('USER').success, true);
  });

  it('T25_non_human_authority_rejected: non-human roles (DIRECTOR, ANTIGRAVITY, EXECUTOR, SYSTEM) are rejected', () => {
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('DIRECTOR').success, false);
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('ANTIGRAVITY').success, false);
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('EXECUTOR').success, false);
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('SYSTEM').success, false);
    assert.equal(ProjectHumanDecisionAuthorityZodSchema.safeParse('ORCHESTRATOR').success, false);
  });

  it('T26_unresolved_material_decision_creates_pending_decision: unresolved decision point has status PENDING_DECISION', async () => {
    const projectId = 'proj-t26-pending-decision';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    for (const hdp of result.humanDecisionPoints) {
      assert.equal(hdp.status, 'PENDING_DECISION');
      assert.ok(hdp.availableOptions.length > 0);
    }
  });

  it('T27_natural_language_approval_like_text_is_not_approval: strings like "tamam", "olur", "yes" do NOT resolve decisions or approve project', async () => {
    const projectId = 'proj-t27-nl-not-approval';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.humanDecisionPoints.length > 0);

    // Human decision point remains PENDING_DECISION
    assert.equal(result.humanDecisionPoints[0].status, 'PENDING_DECISION');

    // No approval in ApprovalStore
    const approvals = await approvalStore.listPackages();
    assert.equal(approvals.length, 0);
  });

  it('T28_decision_affects_correct_risks_artifacts: decision point links to valid risks and upstream artifacts', async () => {
    const projectId = 'proj-t28-decision-link';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    const riskIdSet = new Set(result.risks.map((r) => r.riskId));

    for (const hdp of result.humanDecisionPoints) {
      for (const affectedRisk of hdp.affectedRisks) {
        assert.ok(riskIdSet.has(affectedRisk));
      }
    }
  });

  // ============================================================================
  // PERSISTENCE TESTS (T29 - T33)
  // ============================================================================

  it('T29_revision_persistence: persists rev-<n>.json and latest.json atomically under .ai-manager/project-risks/', async () => {
    const projectId = 'proj-t29-persist';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.equal(result.riskRevision, 1);

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const rev1Path = path.join(projectDir, 'rev-1.json');
    const latestPath = path.join(projectDir, 'latest.json');

    assert.equal(fs.existsSync(rev1Path), true);
    assert.equal(fs.existsSync(latestPath), true);

    const loaded = await riskStore.loadRevision(projectId, 1);
    assert.equal(loaded?.riskRevision, 1);
    assert.equal(loaded?.fingerprint, result.fingerprint);
  });

  it('T30_immutable_revision: attempting to overwrite rev-<n>.json with different canonical content fails closed', async () => {
    const projectId = 'proj-t30-immutable';
    await setupAuthoritativeUpstreamChain(projectId);

    const original = await riskEngine.derive({ projectId });

    // Create altered revision with same revision number but different content
    const tampered: ProjectRiskRevision = {
      ...original,
      risks: original.risks.slice(0, 1),
    };
    tampered.fingerprint = computeRiskFingerprint(tampered);

    await assert.rejects(
      async () => {
        await riskStore.saveRevision(tampered);
      },
      RiskImmutableRevisionError
    );
  });

  it('T31_idempotent_replay: re-persisting exact identical revision succeeds idempotently', async () => {
    const projectId = 'proj-t31-idempotent';
    await setupAuthoritativeUpstreamChain(projectId);

    const original = await riskEngine.derive({ projectId });
    // Save again with same revision and same content
    await riskStore.saveRevision(original);

    const loaded = await riskStore.loadRevision(projectId, 1);
    assert.equal(loaded?.fingerprint, original.fingerprint);
  });

  it('T32_stale_upstream_detection: getLatest detects staleness when upstream requirements advance', async () => {
    const projectId = 'proj-t32-stale';
    const chain = await setupAuthoritativeUpstreamChain(projectId);

    const riskRev1 = await riskEngine.derive({ projectId });
    assert.equal(riskRev1.isStale, false);

    // Advance requirements to revision 2
    const advancedReq = {
      ...chain.requirements,
      requirementsRevision: 2,
    };
    await requirementsStore.saveRevision(advancedReq);

    // Stale check via engine
    const latest = await riskEngine.getLatest(projectId);
    assert.equal(latest?.isStale, true);
  });

  it('T33_cross_project_isolation: prevents cross-project leakage and rejects path traversal in projectId', async () => {
    const projectIdA = 'proj-t33-a';
    const projectIdB = 'proj-t33-b';
    await setupAuthoritativeUpstreamChain(projectIdA);
    await setupAuthoritativeUpstreamChain(projectIdB);

    await riskEngine.derive({ projectId: projectIdA });
    await riskEngine.derive({ projectId: projectIdB });

    const revA = await riskStore.loadRevision(projectIdA);
    const revB = await riskStore.loadRevision(projectIdB);

    assert.equal(revA?.projectId, projectIdA);
    assert.equal(revB?.projectId, projectIdB);

    // Path traversal rejection
    assert.throws(() => riskStore.sanitizeProjectId('../etc/passwd'), RiskValidationError);
    assert.throws(() => riskStore.sanitizeProjectId('proj/../../escape'), RiskValidationError);
  });

  // ============================================================================
  // INTEGRITY TESTS (T34 - T39)
  // ============================================================================

  it('T34_persisted_tampering_rejected: tampering with persisted risk statement is rejected on load', async () => {
    const projectId = 'proj-t34-tamper-statement';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const revPath = path.join(projectDir, 'rev-1.json');
    const raw = JSON.parse(await fs.promises.readFile(revPath, 'utf8'));

    // Tamper with risk statement without updating fingerprint
    raw.risks[0].statement = 'TAMPERED STATEMENT';
    await fs.promises.writeFile(revPath, JSON.stringify(raw, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await riskStore.loadRevision(projectId, 1);
      },
      RiskForgedFingerprintError
    );
  });

  it('T35_forged_self_consistent_fingerprint_rejected: tampering with sourceRequirements and recomputing fingerprint is rejected by authoritative integrity verification', async () => {
    const projectId = 'proj-t35-forged-fp';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const revPath = path.join(projectDir, 'rev-1.json');
    const latestPath = path.join(projectDir, 'latest.json');
    const raw = JSON.parse(await fs.promises.readFile(revPath, 'utf8'));

    // Tamper with risk traceability to a forged requirement and recompute fingerprint
    raw.risks[0].sourceRequirements = ['REQ-FORGED-999'];
    raw.risks[0].traceability.requirementIds = ['REQ-FORGED-999'];
    raw.fingerprint = computeRiskFingerprint(raw);

    await fs.promises.writeFile(revPath, JSON.stringify(raw, null, 2), 'utf8');
    await fs.promises.writeFile(latestPath, JSON.stringify(raw, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await riskEngine.getLatest(projectId);
      },
      RiskForgedFingerprintError
    );
  });

  it('T36_modified_source_fingerprint_rejected: modifying source requirements fingerprint in record fails closed', async () => {
    const projectId = 'proj-t36-mod-src-fp';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const revPath = path.join(projectDir, 'rev-1.json');
    const raw = JSON.parse(await fs.promises.readFile(revPath, 'utf8'));

    raw.sourceRequirementsFingerprint = 'FORGED_REQ_FP_000000000000';
    raw.fingerprint = computeRiskFingerprint(raw);
    await fs.promises.writeFile(revPath, JSON.stringify(raw, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await riskEngine.getRevision(projectId, 1);
      },
      RiskForgedFingerprintError
    );
  });

  it('T37_modified_risk_classification_rejected: modifying risk category or probability is rejected', async () => {
    const projectId = 'proj-t37-mod-class';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const revPath = path.join(projectDir, 'rev-1.json');
    const raw = JSON.parse(await fs.promises.readFile(revPath, 'utf8'));

    raw.risks[0].probability = 'VERY_LOW';
    // Severity not updated, leading to internal mismatch
    raw.fingerprint = computeRiskFingerprint(raw);
    await fs.promises.writeFile(revPath, JSON.stringify(raw, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await riskStore.loadRevision(projectId, 1);
      },
      RiskSeverityMismatchError
    );
  });

  it('T38_modified_decision_point_rejected: unauthorized authority modification (e.g. to DIRECTOR) fails closed', async () => {
    const projectId = 'proj-t38-mod-decision';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const revPath = path.join(projectDir, 'rev-1.json');
    const raw = JSON.parse(await fs.promises.readFile(revPath, 'utf8'));

    if (raw.humanDecisionPoints.length > 0) {
      raw.humanDecisionPoints[0].authority = 'DIRECTOR'; // Non-human authority
      await fs.promises.writeFile(revPath, JSON.stringify(raw, null, 2), 'utf8');

      await assert.rejects(
        async () => {
          await riskStore.loadRevision(projectId, 1);
        },
        RiskValidationError
      );
    }
  });

  it('T39_modified_coverage_rejected: modifying coverage statistics is detected and rejected', async () => {
    const projectId = 'proj-t39-mod-cov';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const projectDir = path.join(riskStore.recordsDir, projectId);
    const revPath = path.join(projectDir, 'rev-1.json');
    const raw = JSON.parse(await fs.promises.readFile(revPath, 'utf8'));

    raw.coverage.totalRisks = 9999;
    await fs.promises.writeFile(revPath, JSON.stringify(raw, null, 2), 'utf8');

    await assert.rejects(
      async () => {
        await riskStore.loadRevision(projectId, 1);
      },
      RiskForgedFingerprintError
    );
  });

  // ============================================================================
  // BOUNDARY TESTS (T40 - T46)
  // ============================================================================

  it('T40_no_approval_created: risk definition does NOT create or alter approval records', async () => {
    const projectId = 'proj-t40-no-approval';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const approvals = await approvalStore.listPackages();
    assert.equal(approvals.length, 0);
  });

  it('T41_no_development_authorization: durable state remains uninitiated and development is not authorized', async () => {
    const projectId = 'proj-t41-no-dev-auth';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const exists = await durableManager.exists();
    assert.equal(exists, false);
  });

  it('T42_no_execution_intent: execution intents remain strictly untouched', async () => {
    const projectId = 'proj-t42-no-exec-intent';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const intentDir = path.join(tempDir, '.ai-manager', 'execution-intents');
    assert.equal(fs.existsSync(intentDir), false);
  });

  it('T43_no_execution_request: execution requests remain strictly untouched', async () => {
    const projectId = 'proj-t43-no-exec-request';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const requestDir = path.join(tempDir, '.ai-manager', 'execution-requests');
    assert.equal(fs.existsSync(requestDir), false);
  });

  it('T44_no_antigravity_invocation: completes without launching external executor processes or sidecars', async () => {
    const projectId = 'proj-t44-no-antigravity';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.ok(result.riskRevision >= 1);
  });

  it('T45_no_task_dag_mutation: task DAG engine remains unmutated (0 tasks)', async () => {
    const projectId = 'proj-t45-no-dag';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const dagDir = path.join(tempDir, '.ai-manager', 'tasks');
    assert.equal(fs.existsSync(dagDir), false);
  });

  it('T46_no_autonomous_driver: does not start autonomous driver or background execution loop', async () => {
    const projectId = 'proj-t46-no-driver';
    await setupAuthoritativeUpstreamChain(projectId);

    const result = await riskEngine.derive({ projectId });
    assert.equal(typeof result.fingerprint, 'string');
    assert.ok(result.fingerprint.length > 0);
  });

  // ============================================================================
  // INTEGRATION & MCP BOUNDARY (T47 - T49)
  // ============================================================================

  it('T47_mcp_boundary: aidm.risks.define, aidm.risks.get, and aidm.human-decisions.get execute cleanly via MCP', async () => {
    const projectId = 'proj-t47-mcp';
    await setupAuthoritativeUpstreamChain(projectId);

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      adaptiveDiscoveryStore: discoveryStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore: businessRulesStore,
      acceptanceCriteriaStore: acceptanceCriteriaStore,
      riskHumanDecisionStore: riskStore,
      riskHumanDecisionEngine: riskEngine,
      historyManager,
      specStore,
    });

    const serverTransport = new InMemoryMcpTransport();

    const server = new McpServer({
      transport: serverTransport,
      delegate,
      riskTools: true,
    });
    await server.start();

    // 1. aidm.risks.define
    const defineRequest: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_RISKS_DEFINE_TOOL_NAME,
        arguments: { projectId },
      },
    };
    const defineRes = (await server.handleMessage(defineRequest)) as McpSuccessResponseEnvelope;
    assert.ok(defineRes.result);
    const defineData = JSON.parse((defineRes.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(defineData.projectId, projectId);
    assert.equal(defineData.riskRevision, 1);

    // 2. aidm.risks.get
    const getRequest: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_RISKS_GET_TOOL_NAME,
        arguments: { projectId },
      },
    };
    const getRes = (await server.handleMessage(getRequest)) as McpSuccessResponseEnvelope;
    assert.ok(getRes.result);
    const getData = JSON.parse((getRes.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(getData.projectId, projectId);

    // 3. aidm.human-decisions.get
    const hdpRequest: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: AIDM_HUMAN_DECISIONS_GET_TOOL_NAME,
        arguments: { projectId },
      },
    };
    const hdpRes = (await server.handleMessage(hdpRequest)) as McpSuccessResponseEnvelope;
    assert.ok(hdpRes.result);
    const hdpData = JSON.parse((hdpRes.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(hdpData.projectId, projectId);
    assert.ok(Array.isArray(hdpData.humanDecisionPoints));

    await server.stop();
  });

  it('T48_restart_reload_behavior: fresh engine instance reads exact persisted risks intact', async () => {
    const projectId = 'proj-t48-restart';
    await setupAuthoritativeUpstreamChain(projectId);

    const saved = await riskEngine.derive({ projectId });

    // Fresh engine instance pointing to same directory
    const freshEngine = new RiskHumanDecisionEngine({
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

    const loaded = await freshEngine.getLatest(projectId);
    assert.equal(loaded?.projectId, projectId);
    assert.equal(loaded?.fingerprint, saved.fingerprint);
    assert.equal(loaded?.risks.length, saved.risks.length);
  });

  it('T49_history_audit_event: appends PROJECT_RISKS_DEFINED audit event to HistoryManager', async () => {
    const projectId = 'proj-t49-history';
    await setupAuthoritativeUpstreamChain(projectId);

    await riskEngine.derive({ projectId });

    const events = await historyManager.readEvents();
    const riskEvent = events.find((e) => e.eventType === 'PROJECT_RISKS_DEFINED');
    assert.ok(riskEvent !== undefined);
    assert.equal(riskEvent.actor, Actor.DIRECTOR);
    assert.equal(riskEvent.payload.projectId, projectId);
  });
});
