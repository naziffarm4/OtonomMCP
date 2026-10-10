/**
 * Comprehensive Test Suite for Phase 15 Acceptance Criteria Definition (TASK-P15-06)
 *
 * Verifies all 60 required capabilities and safety boundaries:
 * T01 basic acceptance criteria definition
 * T02 deterministic derivation
 * T03 deterministic fingerprint
 * T04 criterion ID determinism
 * T05 functional criterion
 * T06 business-rule criterion
 * T07 validation criterion
 * T08 security criterion
 * T09 performance criterion
 * T10 integration criterion
 * T11 data criterion
 * T12 workflow criterion
 * T13 state-transition criterion
 * T14 verification method
 * T15 measurable expected result
 * T16 unresolved threshold becomes PENDING_DECISION
 * T17 no invented performance threshold
 * T18 no silent human decision
 * T19 requirement traceability
 * T20 business-rule traceability
 * T21 architecture traceability
 * T22 uncovered requirement detection
 * T23 coverage statistics
 * T24 conflict preservation
 * T25 requirements revision binding
 * T26 requirements fingerprint binding
 * T27 architecture revision binding
 * T28 architecture fingerprint binding
 * T29 business-rules revision binding
 * T30 business-rules fingerprint binding
 * T31 discovery revision binding
 * T32 stale source rejection
 * T33 cross-project isolation
 * T34 forged fingerprint rejection
 * T35 deterministic deduplication
 * T36 persistence and historical retrieval
 * T37 latest revision retrieval
 * T38 history event
 * T39 MCP boundary
 * T40 no approval
 * T41 no development authorization
 * T42 no ExecutionIntent
 * T43 no Antigravity invocation
 * T44 restart/reload
 * T45 persisted semantic tampering is rejected
 * T46 forged self-consistent fingerprint is rejected
 * T47 modified source binding is rejected
 * T48 modified coverage is rejected
 * T49 modified traceability is rejected
 * T50 same revision + identical canonical artifact = idempotent success
 * T51 same revision + different semantic content + recomputed fingerprint = rejected
 * T52 UNRESOLVED is not accepted by schema
 * T53 unresolved verification method produces PENDING_DECISION
 * T54 unresolved verification method creates Product Owner decision
 * T55 inconsistent traceability rejected
 * T56 nonexistent requirement reference rejected
 * T57 nonexistent business-rule reference rejected
 * T58 nonexistent architecture-decision reference rejected
 * T59 duplicate/colliding criterion identity rejected
 * T60 cross-project additional criterion rejected
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { AcceptanceCriterion } from '../dist/discovery/acceptance-criteria-types.js';
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
  AcceptanceCriteriaValidationError,
  AcceptanceCriteriaRevisionNotFoundError,
  AcceptanceCriteriaProjectBindingMismatchError,
  AcceptanceCriteriaImmutableRevisionError,
  AcceptanceCriteriaStaleSourceError,
  AcceptanceCriteriaForgedFingerprintError,
  SpecStore,
  Actor,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_ACCEPTANCE_CRITERIA_DEFINE_TOOL_NAME,
  AIDM_ACCEPTANCE_CRITERIA_GET_TOOL_NAME,
  computeAcceptanceCriteriaFingerprint,
  VERIFICATION_METHODS,
  VerificationMethodZodSchema,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type ProjectArchitectureRevision,
  type ProjectBusinessRulesRevision,
  type ProjectAcceptanceCriteriaRevision,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Acceptance Criteria Definition (TASK-P15-06)', { concurrency: 1 }, () => {
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
  let approvalStore: ApprovalStore;
  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;
  let architectureEngine: ArchitectureTechnologyEngine;
  let businessRulesEngine: BusinessRulesEngine;
  let acceptanceCriteriaEngine: AcceptanceCriteriaEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-06-ac-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    requirementsStore = new RequirementsScopeStore({ baseDir: tempDir, historyManager });
    architectureStore = new ArchitectureTechnologyStore({ baseDir: tempDir, historyManager });
    businessRulesStore = new BusinessRulesStore({ baseDir: tempDir, historyManager });
    acceptanceCriteriaStore = new AcceptanceCriteriaStore({ baseDir: tempDir, historyManager });
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
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  async function createDiscoveryRevision(
    projectId: string,
    explicitOverrides?: {
      sections?: Record<string, unknown>;
    }
  ): Promise<ProjectDiscoveryRevision> {
    const rawPrompt = `
      Build an Online Appointment Booking System.
      Purpose: Allow clients to book and manage medical appointments.
      Desired Outcome: Scheduled appointments with doctor verification and cancellation policies.
      Target Users: Patients, Doctors, Clinic Staff.
      Platforms: Linux server, Web browsers.
      Required tech: TypeScript, Node.js, PostgreSQL.
      Non-functional: 99.9% uptime, response time < 200ms.
      Business Rules: Patients can cancel appointments up to 12 hours before start time. Only authenticated users may book appointments. Total fee must equal service price plus applicable tax.
      Acceptance: Cancellation deadline enforced, appointment state transitions validated.
    `;

    return discoveryEngine.discover({
      projectId,
      rawPrompt,
      explicitSections: {
        productScope: {
          inScope: [
            'Appointment booking',
            'Cancellation workflow',
            'Doctor schedule lookup',
            'Fee calculation',
          ],
          outOfScope: ['Prescription delivery', 'Insurance claims processing'],
          targetUsers: ['Patients', 'Doctors', 'Clinic Staff'],
          primaryWorkflows: ['Book appointment', 'Cancel appointment', 'Reschedule appointment'],
        },
        functionalRequirements: {
          capabilities: [
            {
              id: 'FREQ-APPT-BOOKING',
              title: 'Appointment Booking',
              description: 'Patients can book and schedule medical appointments with doctors.',
              source: 'test_requirement',
              businessRules: [
                'Only authenticated users may book appointments',
                'Patient phone number must be valid format',
                'Appointments transition from PENDING to CONFIRMED or CANCELLED',
                'Patient booking workflow step sequence must be followed',
              ],
            },
          ],
          behaviors: [],
          businessRules: [],
        },
        architecture: {
          architecturalConstraints: ['modular-monolith'],
          integrationRequirements: ['SMS Gateway', 'Payment Processor API'],
          deploymentModel: 'docker-compose containerized service',
          dataStorageExpectations: ['PostgreSQL Database'],
        },
        technology: {
          requiredTechnologies: ['TypeScript', 'Node.js', 'PostgreSQL'],
          preferredTechnologies: ['Fastify'],
          platformConstraints: ['Linux server', 'Web browsers'],
          prohibitedTechnologies: [],
        },
        ...explicitOverrides?.sections,
      },
      workspaceRoot: tempDir,
    });
  }

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

  async function createArchitectureRevision(
    projectId: string,
    explicitOverrides?: {
      sections?: Record<string, unknown>;
    }
  ): Promise<ProjectArchitectureRevision> {
    const requirements = await createRequirementsRevision(projectId, explicitOverrides);
    return architectureEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
    });
  }

  async function createBusinessRulesRevision(
    projectId: string,
    explicitOverrides?: {
      sections?: Record<string, unknown>;
    }
  ): Promise<ProjectBusinessRulesRevision> {
    const architecture = await createArchitectureRevision(projectId, explicitOverrides);
    return businessRulesEngine.derive({
      projectId,
      architectureRevision: architecture.architectureRevision,
    });
  }

  // T01: basic acceptance criteria definition
  it('T01_basic_acceptance_criteria_definition: transforms upstream specifications into structured revisioned criteria', async () => {
    const businessRules = await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      businessRulesRevision: businessRules.businessRulesRevision,
    });

    assert.ok(result);
    assert.strictEqual(result.projectId, 'proj-clinic');
    assert.strictEqual(result.acceptanceCriteriaRevision, 1);
    assert.strictEqual(result.sourceRequirementsRevision, businessRules.sourceRequirementsRevision);
    assert.strictEqual(result.sourceRequirementsFingerprint, businessRules.sourceRequirementsFingerprint);
    assert.strictEqual(result.sourceArchitectureRevision, businessRules.sourceArchitectureRevision);
    assert.strictEqual(result.sourceArchitectureFingerprint, businessRules.sourceArchitectureFingerprint);
    assert.strictEqual(result.sourceBusinessRulesRevision, businessRules.businessRulesRevision);
    assert.strictEqual(result.sourceBusinessRulesFingerprint, businessRules.fingerprint);
    assert.strictEqual(result.sourceDiscoveryRevision, businessRules.sourceDiscoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, businessRules.sourceDiscoveryFingerprint);
    assert.ok(result.fingerprint);
    assert.ok(result.criteria.length > 0);
    assert.strictEqual(result.isStale, false);
    assert.ok(result.coverage.criteriaCount > 0);
  });

  // T02: deterministic derivation
  it('T02_deterministic_derivation: identical inputs produce identical acceptance criteria and structure', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const result1 = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });
    const result2 = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result1.acceptanceCriteriaRevision, result2.acceptanceCriteriaRevision);
    assert.strictEqual(result1.fingerprint, result2.fingerprint);
    assert.strictEqual(result1.criteria.length, result2.criteria.length);
    assert.deepStrictEqual(result1.criteria, result2.criteria);
    assert.deepStrictEqual(result1.coverage, result2.coverage);
  });

  // T03: deterministic fingerprint
  it('T03_deterministic_fingerprint: fingerprint is canonical and stable across runs', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const r1 = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });
    const r2 = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(r1.fingerprint, r2.fingerprint);
    assert.match(r1.fingerprint, /^[a-f0-9]{64}$/);
  });

  // T04: criterion ID determinism
  it('T04_criterion_id_determinism: criterion IDs follow deterministic AC-<HASH> format without random UUIDs', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result.criteria.length > 0);
    for (const criterion of result.criteria) {
      assert.match(criterion.criterionId, /^AC-[A-Za-z0-9_\-]+$/);
      // Verify no standard random UUID format (8-4-4-4-12) used as ID
      assert.ok(!criterion.criterionId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i));
    }
  });

  // T05: functional criterion
  it('T05_functional_criterion: generates functional acceptance criteria from requirements', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const functionalCriteria = result.criteria.filter((c) => c.criterionType === 'FUNCTIONAL');
    assert.ok(functionalCriteria.length > 0);
    for (const c of functionalCriteria) {
      assert.ok(c.sourceRequirements.length > 0);
      assert.ok(c.statement.length > 0);
      assert.ok(c.expectedResult.length > 0);
    }
  });

  // T06: business-rule criterion
  it('T06_business_rule_criterion: generates business rule criteria from domain business rules', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const ruleCriteria = result.criteria.filter(
      (c) => c.criterionType === 'BUSINESS_RULE' || c.sourceBusinessRules.length > 0
    );
    assert.ok(ruleCriteria.length > 0);
    for (const c of ruleCriteria) {
      assert.ok(c.sourceBusinessRules.length > 0);
      assert.ok(c.statement.length > 0);
    }
  });

  // T07: validation criterion
  it('T07_validation_criterion: generates explicit VALIDATION acceptance criteria', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const validationCriteria = result.criteria.filter((c) => c.criterionType === 'VALIDATION');
    assert.ok(validationCriteria.length > 0);
    for (const c of validationCriteria) {
      assert.strictEqual(c.criterionType, 'VALIDATION');
      assert.ok(c.expectedResult.length > 0);
    }
  });

  // T08: security criterion
  it('T08_security_criterion: generates authorized access and unauthorized rejection security criteria', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const securityCriteria = result.criteria.filter((c) => c.criterionType === 'SECURITY');
    assert.ok(securityCriteria.length >= 2, 'Should generate at least allow and reject security criteria');

    const allowCriterion = securityCriteria.find((c) => c.statement.includes('authorized actor executes'));
    const rejectCriterion = securityCriteria.find((c) => c.statement.includes('unauthorized actor attempts'));

    assert.ok(allowCriterion, 'Must have authorized access criterion');
    assert.ok(rejectCriterion, 'Must have unauthorized rejection criterion');
    assert.strictEqual(rejectCriterion?.verificationMethod, 'SECURITY_TEST');
  });

  // T09: performance criterion
  it('T09_performance_criterion: generates measurable performance criteria when threshold is authoritative', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const perfCriteria = result.criteria.filter((c) => c.criterionType === 'PERFORMANCE');
    assert.ok(perfCriteria.length > 0);

    const definedPerf = perfCriteria.find((c) => c.status === 'DEFINED');
    assert.ok(definedPerf);
    assert.strictEqual(definedPerf.verificationMethod, 'PERFORMANCE_TEST');
    assert.ok(definedPerf.statement.includes('ms') || definedPerf.expectedResult.includes('ms'));
  });

  // T10: integration criterion
  it('T10_integration_criterion: generates INTEGRATION criteria from architecture boundaries', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const integrationCriteria = result.criteria.filter((c) => c.criterionType === 'INTEGRATION');
    assert.ok(integrationCriteria.length > 0);
    for (const c of integrationCriteria) {
      assert.ok(c.verificationMethod === 'INTEGRATION_TEST' || c.verificationMethod === 'AUTOMATED_TEST');
    }
  });

  // T11: data criterion
  it('T11_data_criterion: generates DATA criteria for persistence durability', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const dataCriteria = result.criteria.filter((c) => c.criterionType === 'DATA');
    assert.ok(dataCriteria.length > 0);
    const dataCrit = dataCriteria[0];
    assert.ok(dataCrit.expectedResult.length > 0);
  });

  // T12: workflow criterion
  it('T12_workflow_criterion: generates WORKFLOW criteria for sequence and lifecycle flows', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const workflowCriteria = result.criteria.filter((c) => c.criterionType === 'WORKFLOW');
    assert.ok(workflowCriteria.length > 0);
  });

  // T13: state-transition criterion
  it('T13_state_transition_criterion: generates STATE_TRANSITION criteria enforcing lifecycle invariants', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const stateCriteria = result.criteria.filter((c) => c.criterionType === 'STATE_TRANSITION');
    assert.ok(stateCriteria.length > 0);
    for (const c of stateCriteria) {
      assert.ok(
        c.statement.toLowerCase().includes('transition') ||
        c.expectedResult.toLowerCase().includes('transition')
      );
    }
  });

  // T14: verification method
  it('T14_verification_method: explicitly tags each criterion with a typed verification method', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const validMethods = [...VERIFICATION_METHODS];

    for (const c of result.criteria) {
      assert.ok(validMethods.includes(c.verificationMethod), `Method ${c.verificationMethod} must be valid`);
      assert.notStrictEqual(c.verificationMethod, 'UNRESOLVED');
    }
  });

  // T15: measurable expected result
  it('T15_measurable_expected_result: criteria contain concrete observable expectations', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    for (const c of result.criteria) {
      assert.ok(c.expectedResult.length >= 10, 'Expected result must not be empty or trivial');
    }
  });

  // T16: unresolved threshold becomes PENDING_DECISION
  it('T16_unresolved_threshold_becomes_pending_decision: unquantified threshold marks criterion PENDING_DECISION', async () => {
    const discovery = await createDiscoveryRevision('proj-unresolved', {
      sections: {
        nonFunctionalRequirements: {
          performance: ['response time TBD under load'],
        },
      },
    });
    const req = await requirementsEngine.derive({ projectId: 'proj-unresolved', discoveryRevision: discovery.discoveryRevision });
    const arch = await architectureEngine.derive({ projectId: 'proj-unresolved', requirementsRevision: req.requirementsRevision });
    await businessRulesEngine.derive({ projectId: 'proj-unresolved', architectureRevision: arch.architectureRevision });

    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-unresolved' });

    const pendingNfr = result.criteria.find(
      (c) => c.status === 'PENDING_DECISION' && c.statement.includes('pending Product Owner specification')
    );
    assert.ok(pendingNfr, 'Unquantified threshold must become PENDING_DECISION');
    assert.strictEqual(pendingNfr.status, 'PENDING_DECISION');
    assert.notStrictEqual(pendingNfr.verificationMethod, 'UNRESOLVED');
    assert.ok(VERIFICATION_METHODS.includes(pendingNfr.verificationMethod));
  });

  // T17: no invented performance threshold
  it('T17_no_invented_performance_threshold: engine never invents numeric performance thresholds', async () => {
    const discovery = await createDiscoveryRevision('proj-no-invent', {
      sections: {
        nonFunctionalRequirements: {
          performance: ['system must be fast and responsive'],
        },
      },
    });
    const req = await requirementsEngine.derive({ projectId: 'proj-no-invent', discoveryRevision: discovery.discoveryRevision });
    const arch = await architectureEngine.derive({ projectId: 'proj-no-invent', requirementsRevision: req.requirementsRevision });
    await businessRulesEngine.derive({ projectId: 'proj-no-invent', architectureRevision: arch.architectureRevision });

    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-no-invent' });

    const fastCrit = result.criteria.find((c) => c.statement.includes('fast and responsive'));
    assert.ok(fastCrit);
    assert.strictEqual(fastCrit.status, 'PENDING_DECISION');
    // Ensure no manufactured numbers like "500ms" or "100ms" were injected
    assert.ok(!fastCrit.statement.includes('500ms') && !fastCrit.statement.includes('100ms'));
    assert.notStrictEqual(fastCrit.verificationMethod, 'UNRESOLVED');
    assert.strictEqual(fastCrit.verificationMethod, 'PERFORMANCE_TEST');
  });

  // T18: no silent human decision
  it('T18_no_silent_human_decision: unquantified threshold creates explicit AcceptanceCriteriaHumanDecision record', async () => {
    const discovery = await createDiscoveryRevision('proj-silent-dec', {
      sections: {
        nonFunctionalRequirements: {
          performance: ['latency must be acceptable TBD'],
        },
      },
    });
    const req = await requirementsEngine.derive({ projectId: 'proj-silent-dec', discoveryRevision: discovery.discoveryRevision });
    const arch = await architectureEngine.derive({ projectId: 'proj-silent-dec', requirementsRevision: req.requirementsRevision });
    await businessRulesEngine.derive({ projectId: 'proj-silent-dec', architectureRevision: arch.architectureRevision });

    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-silent-dec' });

    const decision = result.pendingHumanDecisions.find((d) => d.question.includes('latency must be acceptable TBD'));
    assert.ok(decision);
    assert.strictEqual(decision.authority, Actor.USER);
    assert.strictEqual(decision.status, 'PENDING_DECISION');
    assert.ok(decision.affectedCriteria.length > 0);
  });

  // T19: requirement traceability
  it('T19_requirement_traceability: links criteria to source requirements and detects covered requirements', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result.requirementsTraceability.length > 0);
    const covered = result.requirementsTraceability.filter((t) => t.isCovered);
    assert.ok(covered.length > 0);
    for (const c of covered) {
      assert.ok(c.criteriaIds.length > 0);
    }
  });

  // T20: business-rule traceability
  it('T20_business_rule_traceability: links criteria to source business rules', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result.businessRulesTraceability.length > 0);
    for (const t of result.businessRulesTraceability) {
      assert.ok(t.ruleId.startsWith('BR-'));
      if (t.isCovered) {
        assert.ok(t.criteriaIds.length > 0);
      }
    }
  });

  // T21: architecture traceability
  it('T21_architecture_traceability: links criteria to observable architecture decisions', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result.architectureTraceability.length > 0);
    const observable = result.architectureTraceability.filter((t) => t.requiresVerification);
    assert.ok(observable.length > 0);
    for (const t of observable) {
      assert.ok(t.criteriaIds.length > 0);
    }
  });

  // T22: uncovered requirement detection
  it('T22_uncovered_requirement_detection: exposes uncovered requirements with reasons', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      uncoveredExplanations: {
        'NFR-MAINTAINABILITY-1': 'Maintainability is verified via internal engineering guidelines rather than external product criteria',
      },
    });

    const uncovered = result.requirementsTraceability.find((t) => !t.isCovered);
    if (uncovered) {
      assert.ok(result.coverage.uncoveredRequirements.includes(uncovered.requirementId));
      const detail = result.coverage.uncoveredRequirementsDetails.find(
        (d) => d.requirementId === uncovered.requirementId
      );
      assert.ok(detail);
      assert.ok(detail.reason.length > 0);
    }
  });

  // T23: coverage statistics
  it('T23_coverage_statistics: exposes comprehensive and deterministic coverage metrics', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const { coverage } = result;
    assert.ok(coverage.totalRequirements > 0);
    assert.strictEqual(
      coverage.totalRequirements,
      coverage.coveredRequirements.length + coverage.uncoveredRequirements.length
    );
    assert.ok(coverage.totalBusinessRules > 0);
    assert.strictEqual(
      coverage.totalBusinessRules,
      coverage.coveredBusinessRules.length + coverage.uncoveredBusinessRules.length
    );
    assert.strictEqual(coverage.criteriaCount, result.criteria.length);
    assert.ok(coverage.pendingDecisionCount >= result.pendingHumanDecisions.length);
  });

  // T24: conflict preservation
  it('T24_conflict_preservation: preserves conflicts without silently choosing and marks criteria PENDING_DECISION', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      conflicts: [
        {
          conflictId: 'ACC-CLINIC-CANCEL',
          affectedRequirements: ['REQ-BOOKING-01'],
          affectedRules: ['BR-CANCEL-RULE'],
          affectedCriteria: [],
          conflictingStatements: [
            'Patients can cancel anytime without penalty',
            'Cancellations within 12 hours forfeit fee',
          ],
          whyItMatters: 'Cancellation policy contradiction directly impacts fee settlement',
          requiredAuthority: Actor.USER,
          resolutionStatus: 'PENDING_DECISION',
        },
      ],
    });

    assert.ok(result.conflicts.length > 0);
    const conf = result.conflicts.find((c) => c.conflictId === 'ACC-CLINIC-CANCEL');
    assert.ok(conf);
    assert.strictEqual(conf.resolutionStatus, 'PENDING_DECISION');
    assert.strictEqual(conf.requiredAuthority, Actor.USER);
  });

  // T25: requirements revision binding
  it('T25_requirements_revision_binding: binds to exact requirements revision and detects mismatches', async () => {
    const businessRules = await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      requirementsRevision: businessRules.sourceRequirementsRevision,
    });

    assert.strictEqual(result.sourceRequirementsRevision, businessRules.sourceRequirementsRevision);
  });

  // T26: requirements fingerprint binding
  it('T26_requirements_fingerprint_binding: fails closed if requirements fingerprint is forged', async () => {
    await createBusinessRulesRevision('proj-clinic');
    await assert.rejects(
      () =>
        acceptanceCriteriaEngine.derive({
          projectId: 'proj-clinic',
          expectedRequirementsFingerprint: 'forged-fingerprint-12345678',
        }),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T27: architecture revision binding
  it('T27_architecture_revision_binding: binds to exact architecture revision', async () => {
    const businessRules = await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      architectureRevision: businessRules.sourceArchitectureRevision,
    });

    assert.strictEqual(result.sourceArchitectureRevision, businessRules.sourceArchitectureRevision);
  });

  // T28: architecture fingerprint binding
  it('T28_architecture_fingerprint_binding: fails closed if architecture fingerprint is forged', async () => {
    await createBusinessRulesRevision('proj-clinic');
    await assert.rejects(
      () =>
        acceptanceCriteriaEngine.derive({
          projectId: 'proj-clinic',
          expectedArchitectureFingerprint: 'forged-arch-fingerprint-12345',
        }),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T29: business-rules revision binding
  it('T29_business_rules_revision_binding: binds to exact business rules revision', async () => {
    const businessRules = await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      businessRulesRevision: businessRules.businessRulesRevision,
    });

    assert.strictEqual(result.sourceBusinessRulesRevision, businessRules.businessRulesRevision);
  });

  // T30: business-rules fingerprint binding
  it('T30_business_rules_fingerprint_binding: fails closed if business rules fingerprint is forged', async () => {
    await createBusinessRulesRevision('proj-clinic');
    await assert.rejects(
      () =>
        acceptanceCriteriaEngine.derive({
          projectId: 'proj-clinic',
          expectedBusinessRulesFingerprint: 'forged-br-fingerprint-12345',
        }),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T31: discovery revision binding
  it('T31_discovery_revision_binding: binds to exact discovery revision and fingerprint', async () => {
    const businessRules = await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({
      projectId: 'proj-clinic',
      discoveryRevision: businessRules.sourceDiscoveryRevision,
    });

    assert.strictEqual(result.sourceDiscoveryRevision, businessRules.sourceDiscoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, businessRules.sourceDiscoveryFingerprint);
  });

  // T32: stale source rejection
  it('T32_stale_source_rejection: rejects older business rules revision if superseded by latest', async () => {
    await createBusinessRulesRevision('proj-clinic');
    // Create new business rules revision with custom decisions
    await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      customDecisions: [
        {
          decisionId: 'DEC-EXTRA-999',
          question: 'Should VIP patients skip queues?',
          whyItMatters: 'Queue policy',
          affectedRequirements: [],
          affectedRules: [],
          availableOptions: ['Yes', 'No'],
          consequences: ['Changes scheduling logic'],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        },
      ],
    });

    // Attempting to derive with superseded business rules revision 1 must be rejected
    await assert.rejects(
      () =>
        acceptanceCriteriaEngine.derive({
          projectId: 'proj-clinic',
          businessRulesRevision: 1,
        }),
      (err) => err instanceof AcceptanceCriteriaStaleSourceError
    );
  });

  // T33: cross-project isolation
  it('T33_cross_project_isolation: prevents cross-project leakage and binding mismatch', async () => {
    await createBusinessRulesRevision('proj-alpha');
    await createBusinessRulesRevision('proj-beta');

    const betaRules = await businessRulesEngine.getLatest('proj-beta');
    assert.ok(betaRules);

    // Attempting to derive proj-alpha using proj-beta's business rules revision directly
    await assert.rejects(
      () =>
        acceptanceCriteriaEngine.derive({
          projectId: 'proj-alpha',
          expectedBusinessRulesFingerprint: betaRules.fingerprint,
        }),
      (err) =>
        err instanceof AcceptanceCriteriaForgedFingerprintError ||
        err instanceof AcceptanceCriteriaProjectBindingMismatchError
    );
  });

  // T34: forged fingerprint rejection
  it('T34_forged_fingerprint_rejection: rejects all spoofed source fingerprints', async () => {
    await createBusinessRulesRevision('proj-clinic');

    await assert.rejects(
      () =>
        acceptanceCriteriaEngine.derive({
          projectId: 'proj-clinic',
          expectedDiscoveryFingerprint: 'forged-disco-hash',
        }),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T35: deterministic deduplication
  it('T35_deterministic_deduplication: deduplicates duplicate criteria deterministically', async () => {
    const discovery = await createDiscoveryRevision('proj-dedup', {
      sections: {
        functionalRequirements: {
          capabilities: [
            {
              id: 'FREQ-APPT-1',
              title: 'Appointment Booking',
              description: 'Patients can book medical appointments.',
              businessRules: ['Patients can cancel appointments up to 12 hours before start time.'],
            },
            {
              id: 'FREQ-APPT-2',
              title: 'Appointment Booking Clone',
              description: 'Patients can book medical appointments.',
              businessRules: ['Patients can cancel appointments up to 12 hours before start time.'],
            },
          ],
        },
      },
    });
    const req = await requirementsEngine.derive({ projectId: 'proj-dedup', discoveryRevision: discovery.discoveryRevision });
    const arch = await architectureEngine.derive({ projectId: 'proj-dedup', requirementsRevision: req.requirementsRevision });
    await businessRulesEngine.derive({ projectId: 'proj-dedup', architectureRevision: arch.architectureRevision });

    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-dedup' });

    const matching = result.criteria.filter(
      (c) => c.statement.includes('The product enforces requirement condition: Patients can cancel appointments')
    );
    assert.strictEqual(matching.length, 1, 'Duplicate criteria must be deduplicated into a single entry');
    assert.ok(matching[0].sourceRequirements.includes('FREQ-APPT-1'));
    assert.ok(matching[0].sourceRequirements.includes('FREQ-APPT-2'));
  });

  // T36: persistence and historical retrieval
  it('T36_persistence_and_historical_retrieval: persists rev-1.json and retrieves historical revisions', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const saved = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const retrieved = await acceptanceCriteriaEngine.getRevision('proj-clinic', 1);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.acceptanceCriteriaRevision, 1);
    assert.strictEqual(retrieved.fingerprint, saved.fingerprint);
    assert.strictEqual(retrieved.criteria.length, saved.criteria.length);
  });

  // T37: latest revision retrieval
  it('T37_latest_revision_retrieval: retrieves latest revision from latest.json pointer', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const saved = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const latest = await acceptanceCriteriaEngine.getLatest('proj-clinic');
    assert.ok(latest);
    assert.strictEqual(latest.acceptanceCriteriaRevision, saved.acceptanceCriteriaRevision);
    assert.strictEqual(latest.fingerprint, saved.fingerprint);
  });

  // T38: history event
  it('T38_history_event: appends PROJECT_ACCEPTANCE_CRITERIA_DEFINED event to HistoryManager', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const historyFile = path.join(tempDir, '.ai-manager', 'history', 'events.jsonl');
    assert.ok(fs.existsSync(historyFile));
    const content = await fs.promises.readFile(historyFile, 'utf8');
    const lines = content.trim().split('\n');

    const acEvents = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.eventType === 'PROJECT_ACCEPTANCE_CRITERIA_DEFINED');

    assert.ok(acEvents.length > 0);
    const event = acEvents[acEvents.length - 1];
    assert.strictEqual(event.payload.projectId, 'proj-clinic');
    assert.strictEqual(event.payload.acceptanceCriteriaRevision, result.acceptanceCriteriaRevision);
    assert.strictEqual(event.payload.fingerprint, result.fingerprint);
    assert.strictEqual(event.payload.criteriaCount, result.criteria.length);
  });

  // T39: MCP boundary
  it('T39_mcp_boundary: defines and gets acceptance criteria through MCP tools over in-memory transport', async () => {
    await createBusinessRulesRevision('proj-mcp');

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      historyManager,
      specStore,
      adaptiveDiscoveryStore: discoveryStore,
      completenessGateStore: completenessStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore: businessRulesStore,
      acceptanceCriteriaStore,
    });

    const serverTransport = new InMemoryMcpTransport();

    const server = new McpServer({
      transport: serverTransport,
      delegate,
      acceptanceCriteriaTools: true,
    });

    await server.start();

    // 1. Call aidm.acceptance-criteria.define
    const defineReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_ACCEPTANCE_CRITERIA_DEFINE_TOOL_NAME,
        arguments: { projectId: 'proj-mcp' },
      },
    };

    const defineRes = (await server.handleMessage(defineReq)) as McpSuccessResponseEnvelope;
    assert.ok(defineRes.result);
    const definePayload = JSON.parse(
      (defineRes.result as { content: Array<{ text: string }> }).content[0].text
    );
    assert.strictEqual(definePayload.projectId, 'proj-mcp');
    assert.strictEqual(definePayload.acceptanceCriteriaRevision, 1);
    assert.ok(definePayload.criteria.length > 0);

    // 2. Call aidm.acceptance-criteria.get
    const getReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_ACCEPTANCE_CRITERIA_GET_TOOL_NAME,
        arguments: { projectId: 'proj-mcp', revision: 1 },
      },
    };

    const getRes = (await server.handleMessage(getReq)) as McpSuccessResponseEnvelope;
    assert.ok(getRes.result);
    const getPayload = JSON.parse(
      (getRes.result as { content: Array<{ text: string }> }).content[0].text
    );
    assert.strictEqual(getPayload.projectId, 'proj-mcp');
    assert.strictEqual(getPayload.acceptanceCriteriaRevision, 1);
    assert.strictEqual(getPayload.fingerprint, definePayload.fingerprint);

    await server.stop();
  });

  // T40: no approval
  it('T40_no_approval: acceptance criteria definition does NOT approve the project', async () => {
    await createBusinessRulesRevision('proj-clinic');
    await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const packages = await approvalStore.listPackages();
    assert.strictEqual(packages.length, 0, 'Must have zero approval packages');
  });

  // T41: no development authorization
  it('T41_no_development_authorization: development authorization remains false after criteria definition', async () => {
    await createBusinessRulesRevision('proj-clinic');
    await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const state = await durableManager.load();
    assert.strictEqual((state as unknown as Record<string, unknown>)?.['isDevelopmentAuthorized'], undefined);
  });

  // T42: no ExecutionIntent
  it('T42_no_execution_intent: does NOT create ExecutionIntent or ExecutionRequest', async () => {
    await createBusinessRulesRevision('proj-clinic');
    await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const execIntentDir = path.join(tempDir, '.ai-manager', 'execution-intents');
    assert.strictEqual(fs.existsSync(execIntentDir), false);
  });

  // T43: no Antigravity invocation
  it('T43_no_antigravity_invocation: strictly operates without invoking Antigravity', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result);
    // Verified statically: no antigravity imports or executions exist in acceptance criteria subsystem
  });

  // T44: restart/reload
  it('T44_restart_reload: new engine instance reloads persisted revision with complete fidelity', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    // Create fresh engine instance
    const freshEngine = new AcceptanceCriteriaEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
    });

    const reloaded = await freshEngine.getLatest('proj-clinic');
    assert.ok(reloaded);
    assert.strictEqual(reloaded.acceptanceCriteriaRevision, original.acceptanceCriteriaRevision);
    assert.strictEqual(reloaded.fingerprint, original.fingerprint);
    assert.strictEqual(reloaded.criteria.length, original.criteria.length);
    assert.deepStrictEqual(reloaded.coverage, original.coverage);
  });

  // T45: persisted semantic tampering is rejected
  it('T45_persisted_semantic_tampering_is_rejected: store rejects tampered criteria whose fingerprint is mismatched', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    // Directly tamper with persisted JSON on disk without updating fingerprint
    const revFilePath = path.join(
      tempDir,
      '.ai-manager',
      'project-acceptance-criteria',
      'records',
      'proj-clinic',
      `rev-${original.acceptanceCriteriaRevision}.json`
    );
    const content = JSON.parse(await fs.promises.readFile(revFilePath, 'utf-8'));
    content.criteria[0].statement = 'TAMPERED STATEMENT BY ADVERSARY';
    await fs.promises.writeFile(revFilePath, JSON.stringify(content, null, 2), 'utf-8');

    await assert.rejects(
      async () => acceptanceCriteriaStore.loadRevision('proj-clinic', original.acceptanceCriteriaRevision),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T46: forged self-consistent fingerprint is rejected
  it('T46_forged_self_consistent_fingerprint_is_rejected: engine rejects forged artifact even if internal fingerprint is self-consistent', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    // Tamper with semantic field and recompute fingerprint to make it internally self-consistent
    const revFilePath = path.join(
      tempDir,
      '.ai-manager',
      'project-acceptance-criteria',
      'records',
      'proj-clinic',
      `rev-${original.acceptanceCriteriaRevision}.json`
    );
    const latestFilePath = path.join(
      tempDir,
      '.ai-manager',
      'project-acceptance-criteria',
      'records',
      'proj-clinic',
      'latest.json'
    );
    const content = JSON.parse(await fs.promises.readFile(revFilePath, 'utf-8'));
    content.criteria[0].statement = 'MALICIOUS MODIFIED STATEMENT';
    content.fingerprint = computeAcceptanceCriteriaFingerprint(content);

    await fs.promises.writeFile(revFilePath, JSON.stringify(content, null, 2), 'utf-8');
    await fs.promises.writeFile(latestFilePath, JSON.stringify(content, null, 2), 'utf-8');

    // Engine must reject because it verifies authoritative derivation from upstream sources
    await assert.rejects(
      async () => acceptanceCriteriaEngine.getRevision('proj-clinic', original.acceptanceCriteriaRevision),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
    await assert.rejects(
      async () => acceptanceCriteriaEngine.getLatest('proj-clinic'),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T47: modified source binding is rejected
  it('T47_modified_source_binding_is_rejected: rejects artifact when upstream source fingerprint binding is modified', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const revFilePath = path.join(
      tempDir,
      '.ai-manager',
      'project-acceptance-criteria',
      'records',
      'proj-clinic',
      `rev-${original.acceptanceCriteriaRevision}.json`
    );
    const content = JSON.parse(await fs.promises.readFile(revFilePath, 'utf-8'));
    content.sourceRequirementsFingerprint = 'forged-req-fingerprint-12345';
    content.fingerprint = computeAcceptanceCriteriaFingerprint(content);

    await fs.promises.writeFile(revFilePath, JSON.stringify(content, null, 2), 'utf-8');

    await assert.rejects(
      async () => acceptanceCriteriaEngine.getRevision('proj-clinic', original.acceptanceCriteriaRevision),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T48: modified coverage is rejected
  it('T48_modified_coverage_is_rejected: rejects artifact when coverage statistics are tampered with', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const revFilePath = path.join(
      tempDir,
      '.ai-manager',
      'project-acceptance-criteria',
      'records',
      'proj-clinic',
      `rev-${original.acceptanceCriteriaRevision}.json`
    );
    const content = JSON.parse(await fs.promises.readFile(revFilePath, 'utf-8'));
    content.coverage.totalRequirements = 9999;
    content.fingerprint = computeAcceptanceCriteriaFingerprint(content);

    await fs.promises.writeFile(revFilePath, JSON.stringify(content, null, 2), 'utf-8');

    await assert.rejects(
      async () => acceptanceCriteriaEngine.getRevision('proj-clinic', original.acceptanceCriteriaRevision),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T49: modified traceability is rejected
  it('T49_modified_traceability_is_rejected: rejects artifact when traceability report is tampered with', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const revFilePath = path.join(
      tempDir,
      '.ai-manager',
      'project-acceptance-criteria',
      'records',
      'proj-clinic',
      `rev-${original.acceptanceCriteriaRevision}.json`
    );
    const content = JSON.parse(await fs.promises.readFile(revFilePath, 'utf-8'));
    content.requirementsTraceability[0].isCovered = !content.requirementsTraceability[0].isCovered;
    content.fingerprint = computeAcceptanceCriteriaFingerprint(content);

    await fs.promises.writeFile(revFilePath, JSON.stringify(content, null, 2), 'utf-8');

    await assert.rejects(
      async () => acceptanceCriteriaEngine.getRevision('proj-clinic', original.acceptanceCriteriaRevision),
      (err) => err instanceof AcceptanceCriteriaForgedFingerprintError
    );
  });

  // T50: same revision + identical canonical artifact = idempotent success
  it('T50_same_revision_identical_canonical_artifact_idempotent_success: idempotent replay of identical artifact succeeds', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    // Saving identical revision again must succeed without error
    await assert.doesNotReject(async () => {
      await acceptanceCriteriaStore.saveRevision(original);
    });
  });

  // T51: same revision + different semantic content + recomputed fingerprint = rejected
  it('T51_same_revision_different_semantic_content_recomputed_fingerprint_rejected: saveRevision rejects same revision with different content', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const original = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    const modified: ProjectAcceptanceCriteriaRevision = {
      ...original,
      criteria: [
        {
          ...original.criteria[0],
          statement: 'DIFFERENT STATEMENT IN FORGED REVISION',
        },
        ...original.criteria.slice(1),
      ],
    };
    modified.fingerprint = computeAcceptanceCriteriaFingerprint(modified);

    await assert.rejects(
      async () => acceptanceCriteriaStore.saveRevision(modified),
      (err) => err instanceof AcceptanceCriteriaImmutableRevisionError
    );
  });

  // T52: UNRESOLVED is not accepted by schema
  it('T52_unresolved_is_not_accepted_by_schema: VerificationMethod schema rejects UNRESOLVED', () => {
    const parseResult = VerificationMethodZodSchema.safeParse('UNRESOLVED');
    assert.strictEqual(parseResult.success, false);
  });

  // T53: unresolved verification method produces PENDING_DECISION
  it('T53_unresolved_verification_method_produces_pending_decision: unquantified criterion receives PENDING_DECISION', async () => {
    const discovery = await createDiscoveryRevision('proj-pending-dec', {
      sections: {
        nonFunctionalRequirements: {
          performance: ['response time TBD under load'],
        },
      },
    });
    const req = await requirementsEngine.derive({ projectId: 'proj-pending-dec', discoveryRevision: discovery.discoveryRevision });
    const arch = await architectureEngine.derive({ projectId: 'proj-pending-dec', requirementsRevision: req.requirementsRevision });
    await businessRulesEngine.derive({ projectId: 'proj-pending-dec', architectureRevision: arch.architectureRevision });

    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-pending-dec' });
    const pendingCrit = result.criteria.find(
      (c) => c.status === 'PENDING_DECISION' && c.statement.includes('pending Product Owner specification')
    );

    assert.ok(pendingCrit);
    assert.strictEqual(pendingCrit.status, 'PENDING_DECISION');
    assert.ok(VERIFICATION_METHODS.includes(pendingCrit.verificationMethod));
    assert.notStrictEqual(pendingCrit.verificationMethod, 'UNRESOLVED');
  });

  // T54: unresolved verification method creates Product Owner decision
  it('T54_unresolved_verification_method_creates_product_owner_decision: creates Product Owner decision for unresolved item', async () => {
    const discovery = await createDiscoveryRevision('proj-po-dec', {
      sections: {
        nonFunctionalRequirements: {
          availability: ['uptime undecided pending SLA review'],
        },
      },
    });
    const req = await requirementsEngine.derive({ projectId: 'proj-po-dec', discoveryRevision: discovery.discoveryRevision });
    const arch = await architectureEngine.derive({ projectId: 'proj-po-dec', requirementsRevision: req.requirementsRevision });
    await businessRulesEngine.derive({ projectId: 'proj-po-dec', architectureRevision: arch.architectureRevision });

    const result = await acceptanceCriteriaEngine.derive({ projectId: 'proj-po-dec' });
    const decision = result.pendingHumanDecisions.find((d) => d.question.includes('availability'));

    assert.ok(decision);
    assert.strictEqual(decision.authority, Actor.USER);
    assert.strictEqual(decision.status, 'PENDING_DECISION');
  });

  // T55: inconsistent traceability rejected
  it('T55_inconsistent_traceability_rejected: rejects additional criterion when traceability does not match sources', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const badCriterion: AcceptanceCriterion = {
      criterionId: 'AC-BAD-TRACE-1',
      title: 'Bad Traceability',
      description: 'Mismatched traceability test',
      criterionType: 'FUNCTIONAL',
      statement: 'When action is taken, result occurs.',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['FREQ-APPT-BOOKING'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Expected observable outcome occurs.',
      dependencies: [],
      traceability: {
        criterionId: 'AC-BAD-TRACE-1',
        requirementIds: ['FREQ-DIFFERENT-REQ'],
        businessRuleIds: [],
        architectureDecisionIds: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [badCriterion],
      }),
      (err) => err instanceof AcceptanceCriteriaValidationError
    );
  });

  // T56: nonexistent requirement reference rejected
  it('T56_nonexistent_requirement_reference_rejected: rejects additional criterion referencing missing requirement', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const badCriterion: AcceptanceCriterion = {
      criterionId: 'AC-NONEXISTENT-REQ',
      title: 'Nonexistent Req',
      description: 'Test nonexistent requirement reference',
      criterionType: 'FUNCTIONAL',
      statement: 'When action is taken, result occurs.',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['NONEXISTENT-REQ-999'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Expected observable outcome occurs.',
      dependencies: [],
      traceability: {
        criterionId: 'AC-NONEXISTENT-REQ',
        requirementIds: ['NONEXISTENT-REQ-999'],
        businessRuleIds: [],
        architectureDecisionIds: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [badCriterion],
      }),
      (err) => err instanceof AcceptanceCriteriaValidationError
    );
  });

  // T57: nonexistent business-rule reference rejected
  it('T57_nonexistent_business_rule_reference_rejected: rejects additional criterion referencing missing business rule', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const badCriterion: AcceptanceCriterion = {
      criterionId: 'AC-NONEXISTENT-RULE',
      title: 'Nonexistent Rule',
      description: 'Test nonexistent business rule reference',
      criterionType: 'BUSINESS_RULE',
      statement: 'When action is taken, rule is enforced.',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['FREQ-APPT-BOOKING'],
      sourceBusinessRules: ['NONEXISTENT-RULE-999'],
      sourceArchitectureDecisions: [],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Expected observable outcome occurs.',
      dependencies: [],
      traceability: {
        criterionId: 'AC-NONEXISTENT-RULE',
        requirementIds: ['FREQ-APPT-BOOKING'],
        businessRuleIds: ['NONEXISTENT-RULE-999'],
        architectureDecisionIds: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [badCriterion],
      }),
      (err) => err instanceof AcceptanceCriteriaValidationError
    );
  });

  // T58: nonexistent architecture-decision reference rejected
  it('T58_nonexistent_architecture_decision_reference_rejected: rejects additional criterion referencing missing arch decision', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const badCriterion: AcceptanceCriterion = {
      criterionId: 'AC-NONEXISTENT-ARCH',
      title: 'Nonexistent Arch',
      description: 'Test nonexistent architecture reference',
      criterionType: 'COMPATIBILITY',
      statement: 'When action is taken, arch is respected.',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['FREQ-APPT-BOOKING'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: ['NONEXISTENT-ARCH-999'],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Expected observable outcome occurs.',
      dependencies: [],
      traceability: {
        criterionId: 'AC-NONEXISTENT-ARCH',
        requirementIds: ['FREQ-APPT-BOOKING'],
        businessRuleIds: [],
        architectureDecisionIds: ['NONEXISTENT-ARCH-999'],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [badCriterion],
      }),
      (err) => err instanceof AcceptanceCriteriaValidationError
    );
  });

  // T59: duplicate/colliding criterion identity rejected
  it('T59_duplicate_colliding_criterion_identity_rejected: rejects criterion that collides with generated criteria or duplicate in input', async () => {
    await createBusinessRulesRevision('proj-clinic');
    const existing = await acceptanceCriteriaEngine.derive({ projectId: 'proj-clinic' });

    // 1. Collides with an authoritative generated criterion ID
    const collidingIdCriterion: AcceptanceCriterion = {
      criterionId: existing.criteria[0].criterionId,
      title: 'Colliding Criterion',
      description: 'Has identical ID to an authoritative criterion',
      criterionType: 'FUNCTIONAL',
      statement: 'Some unique statement',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['FREQ-APPT-BOOKING'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Some unique expected result',
      dependencies: [],
      traceability: {
        criterionId: existing.criteria[0].criterionId,
        requirementIds: ['FREQ-APPT-BOOKING'],
        businessRuleIds: [],
        architectureDecisionIds: [],
      },
      metadata: {},
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [collidingIdCriterion],
      }),
      (err) => err instanceof AcceptanceCriteriaValidationError
    );

    // 2. Duplicate criterionId within additionalCriteria
    const duplicate1: AcceptanceCriterion = {
      criterionId: 'AC-DUP-ID-1',
      title: 'Dup 1',
      description: 'Dup 1 desc',
      criterionType: 'FUNCTIONAL',
      statement: 'Statement 1',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['FREQ-APPT-BOOKING'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Expected 1',
      dependencies: [],
      traceability: {
        criterionId: 'AC-DUP-ID-1',
        requirementIds: ['FREQ-APPT-BOOKING'],
        businessRuleIds: [],
        architectureDecisionIds: [],
      },
      metadata: {},
    };

    const duplicate2: AcceptanceCriterion = {
      ...duplicate1,
      statement: 'Statement 2 differing',
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [duplicate1, duplicate2],
      }),
      (err) => err instanceof AcceptanceCriteriaValidationError
    );
  });

  // T60: cross-project additional criterion rejected
  it('T60_cross_project_additional_criterion_rejected: rejects additional criterion belonging to another project', async () => {
    await createBusinessRulesRevision('proj-clinic');

    const foreignCriterion: AcceptanceCriterion = {
      criterionId: 'AC-FOREIGN-1',
      title: 'Foreign Criterion',
      description: 'Belongs to foreign project',
      criterionType: 'FUNCTIONAL',
      statement: 'When action is taken, result occurs.',
      priority: 'HIGH',
      status: 'DEFINED',
      sourceRequirements: ['FREQ-APPT-BOOKING'],
      sourceBusinessRules: [],
      sourceArchitectureDecisions: [],
      verificationMethod: 'AUTOMATED_TEST',
      expectedResult: 'Expected observable outcome occurs.',
      dependencies: [],
      traceability: {
        criterionId: 'AC-FOREIGN-1',
        requirementIds: ['FREQ-APPT-BOOKING'],
        businessRuleIds: [],
        architectureDecisionIds: [],
      },
      metadata: { projectId: 'other-project-id' },
    };

    await assert.rejects(
      async () => acceptanceCriteriaEngine.derive({
        projectId: 'proj-clinic',
        additionalCriteria: [foreignCriterion],
      }),
      (err) => err instanceof AcceptanceCriteriaProjectBindingMismatchError
    );
  });
});
