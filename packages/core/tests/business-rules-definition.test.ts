/**
 * Comprehensive Test Suite for Phase 15 Business Rules Definition (TASK-P15-05)
 *
 * Verifies all 41 required capabilities and safety boundaries:
 * T01 basic business rule definition
 * T02 deterministic derivation
 * T03 deterministic fingerprint
 * T04 rule ID determinism
 * T05 domain invariant
 * T06 workflow rule
 * T07 validation rule
 * T08 authorization/policy rule
 * T09 state transition rule
 * T10 calculation rule
 * T11 limit rule
 * T12 temporal rule
 * T13 rule priority
 * T14 confirmed rule
 * T15 proposed rule
 * T16 pending Product Owner decision
 * T17 no silent business-policy selection
 * T18 rule dependencies
 * T19 invalid rule dependency rejection
 * T20 requirement traceability
 * T21 architecture traceability
 * T22 discovery traceability
 * T23 requirements revision binding
 * T24 requirements fingerprint binding
 * T25 architecture revision binding
 * T26 architecture fingerprint binding
 * T27 discovery revision binding
 * T28 stale source rejection
 * T29 cross-project isolation
 * T30 forged fingerprint rejection
 * T31 deterministic deduplication
 * T32 conflict detection/preservation
 * T33 persistence and historical retrieval
 * T34 latest revision retrieval
 * T35 history event
 * T36 MCP boundary
 * T37 no approval
 * T38 no development authorization
 * T39 no ExecutionIntent
 * T40 no Antigravity invocation
 * T41 restart/reload
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
  BusinessRulesValidationError,
  BusinessRulesRevisionNotFoundError,
  BusinessRulesProjectBindingMismatchError,
  BusinessRulesImmutableRevisionError,
  BusinessRulesStaleSourceError,
  BusinessRulesForgedFingerprintError,
  BusinessRulesDependencyError,
  SpecStore,
  Actor,
  HistoryManager,
  DurableStateManager,
  ApprovalStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_BUSINESS_RULES_DEFINE_TOOL_NAME,
  AIDM_BUSINESS_RULES_GET_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type ProjectArchitectureRevision,
  type ProjectBusinessRulesRevision,
  type BusinessRule,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Phase 15 Business Rules Definition (TASK-P15-05)', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let completenessStore: CompletenessGateStore;
  let requirementsStore: RequirementsScopeStore;
  let architectureStore: ArchitectureTechnologyStore;
  let businessRulesStore: BusinessRulesStore;
  let approvalStore: ApprovalStore;
  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;
  let architectureEngine: ArchitectureTechnologyEngine;
  let businessRulesEngine: BusinessRulesEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p15-05-rules-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    requirementsStore = new RequirementsScopeStore({ baseDir: tempDir, historyManager });
    architectureStore = new ArchitectureTechnologyStore({ baseDir: tempDir, historyManager });
    businessRulesStore = new BusinessRulesStore({ baseDir: tempDir, historyManager });
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

  // T01: basic business rule definition
  it('T01_basic_business_rule_definition: transforms upstream requirements and architecture into structured business rules', async () => {
    const architecture = await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      architectureRevision: architecture.architectureRevision,
    });

    assert.ok(result);
    assert.strictEqual(result.projectId, 'proj-clinic');
    assert.strictEqual(result.businessRulesRevision, 1);
    assert.strictEqual(result.sourceRequirementsRevision, architecture.sourceRequirementsRevision);
    assert.strictEqual(result.sourceRequirementsFingerprint, architecture.sourceRequirementsFingerprint);
    assert.strictEqual(result.sourceArchitectureRevision, architecture.architectureRevision);
    assert.strictEqual(result.sourceArchitectureFingerprint, architecture.fingerprint);
    assert.strictEqual(result.sourceDiscoveryRevision, architecture.sourceDiscoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, architecture.sourceDiscoveryFingerprint);
    assert.ok(result.fingerprint);
    assert.ok(result.rules.length > 0);
    assert.strictEqual(result.isStale, false);
  });

  // T02: deterministic derivation
  it('T02_deterministic_derivation: identical inputs produce identical business rules count and structure', async () => {
    await createArchitectureRevision('proj-clinic');

    const result1 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });
    const result2 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result1.businessRulesRevision, result2.businessRulesRevision);
    assert.strictEqual(result1.fingerprint, result2.fingerprint);
    assert.strictEqual(result1.rules.length, result2.rules.length);
    assert.deepStrictEqual(result1.rules, result2.rules);
  });

  // T03: deterministic fingerprint
  it('T03_deterministic_fingerprint: fingerprint is consistent and excludes volatile values', async () => {
    await createArchitectureRevision('proj-clinic');

    const r1 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });
    const r2 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(r1.fingerprint, r2.fingerprint);
    assert.match(r1.fingerprint, /^[a-f0-9]{64}$/);
  });

  // T04: rule ID determinism
  it('T04_rule_id_determinism: rule IDs follow deterministic BR-<HASH> pattern without random UUIDs', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result.rules.length > 0);
    for (const rule of result.rules) {
      assert.match(rule.ruleId, /^BR-[A-Za-z0-9_\-]+$/);
      // Ensure no raw UUID format
      assert.doesNotMatch(rule.ruleId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    }
  });

  // T05: domain invariant
  it('T05_domain_invariant: categorizes and records domain invariants accurately', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-INV01',
      title: 'Appointment ID Uniqueness',
      description: 'Every appointment must have a unique immutable identifier across all clinics',
      category: 'DOMAIN_INVARIANT',
      statement: 'Appointment identifier must be globally unique and immutable.',
      priority: 'CRITICAL',
      status: 'CONFIRMED',
      sourceReferences: ['DOMAIN-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      validationExpectation: 'Database unique constraint verification',
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-INV01');
    assert.ok(found);
    assert.strictEqual(found.category, 'DOMAIN_INVARIANT');
    assert.strictEqual(found.priority, 'CRITICAL');
    assert.strictEqual(found.status, 'CONFIRMED');
  });

  // T06: workflow rule
  it('T06_workflow_rule: categorizes and represents sequential workflow steps and prerequisites', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-WF01',
      title: 'Appointment Booking Sequence',
      description: 'Patient must select an available slot before confirming payment',
      category: 'WORKFLOW_RULE',
      statement: 'Patient must select an available slot before confirming payment workflow step.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['WF-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      validationExpectation: 'Step sequence assertion',
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-WF01');
    assert.ok(found);
    assert.strictEqual(found.category, 'WORKFLOW_RULE');
  });

  // T07: validation rule
  it('T07_validation_rule: supports declarative validation rules without implementation details', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-VAL01',
      title: 'Patient Phone Validation',
      description: 'Patient phone number must be in E.164 international format',
      category: 'VALIDATION_RULE',
      statement: 'Patient phone number must be a valid E.164 phone format and cannot be empty.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['DATA-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      validationExpectation: 'Format validation check',
      validationCalculationDetails: {
        fields: ['phoneNumber'],
        constraints: ['E.164 format'],
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-VAL01');
    assert.ok(found);
    assert.strictEqual(found.category, 'VALIDATION_RULE');
    assert.deepStrictEqual(found.validationCalculationDetails?.fields, ['phoneNumber']);
  });

  // T08: authorization/policy rule
  it('T08_authorization_policy_rule: distinguishes project domain authorization from AIDM internal execution authorization', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-AUTH01',
      title: 'Medical Record Access Authorization',
      description: 'Only attending doctors may view confidential patient medical records',
      category: 'AUTHORIZATION_RULE',
      statement: 'Only authorized attending doctors may view confidential patient medical records.',
      priority: 'CRITICAL',
      status: 'CONFIRMED',
      sourceReferences: ['SECURITY-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: ['SECURITY'],
      dependencies: [],
      authorizationPolicyDetails: {
        actor: 'Attending Doctor',
        operation: 'View Medical Record',
        effect: 'ALLOW',
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-AUTH01');
    assert.ok(found);
    assert.strictEqual(found.category, 'AUTHORIZATION_RULE');
    assert.strictEqual(found.authorizationPolicyDetails?.actor, 'Attending Doctor');
    assert.strictEqual(found.authorizationPolicyDetails?.effect, 'ALLOW');
  });

  // T09: state transition rule
  it('T09_state_transition_rule: captures legal and forbidden entity lifecycle transitions', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-ST01',
      title: 'Appointment Lifecycle Transitions',
      description: 'Appointment cannot transition from CANCELLED back to ACTIVE',
      category: 'STATE_TRANSITION_RULE',
      statement: 'Appointment lifecycle status cannot transition from CANCELLED back to ACTIVE state.',
      priority: 'CRITICAL',
      status: 'CONFIRMED',
      sourceReferences: ['LIFECYCLE-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      stateTransitionDetails: {
        entity: 'Appointment',
        currentState: 'CANCELLED',
        allowedTransitions: ['ARCHIVED'],
        forbiddenTransitions: ['ACTIVE', 'SCHEDULED'],
        conditions: ['Cancelled appointments are terminal for scheduling'],
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-ST01');
    assert.ok(found);
    assert.strictEqual(found.category, 'STATE_TRANSITION_RULE');
    assert.deepStrictEqual(found.stateTransitionDetails?.forbiddenTransitions, ['ACTIVE', 'SCHEDULED']);
  });

  // T10: calculation rule
  it('T10_calculation_rule: represents arithmetic and derived relationship rules declaratively', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-CALC01',
      title: 'Total Appointment Fee Calculation',
      description: 'Total fee must equal the sum of service line items plus tax',
      category: 'CALCULATION_RULE',
      statement: 'Total appointment fee must equal the sum of service line items plus tax amount.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['BILLING-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      validationCalculationDetails: {
        formula: 'total = sum(items.price) + tax',
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-CALC01');
    assert.ok(found);
    assert.strictEqual(found.category, 'CALCULATION_RULE');
    assert.strictEqual(found.validationCalculationDetails?.formula, 'total = sum(items.price) + tax');
  });

  // T11: limit rule
  it('T11_limit_rule: captures boundary caps and quotas', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-LIM01',
      title: 'Active Bookings Cap',
      description: 'A patient may have at most 3 active appointments at any given time',
      category: 'LIMIT_RULE',
      statement: 'A patient may hold a maximum limit of at most 3 active appointments simultaneously.',
      priority: 'MEDIUM',
      status: 'CONFIRMED',
      sourceReferences: ['POLICY-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      validationCalculationDetails: {
        maximum: 3,
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-LIM01');
    assert.ok(found);
    assert.strictEqual(found.category, 'LIMIT_RULE');
    assert.strictEqual(found.validationCalculationDetails?.maximum, 3);
  });

  // T12: temporal rule
  it('T12_temporal_rule: captures deadlines, cancellation windows, and temporal conditions', async () => {
    await createArchitectureRevision('proj-clinic');
    const customRule: BusinessRule = {
      ruleId: 'BR-TEMP01',
      title: 'Cancellation Deadline Window',
      description: 'Appointments may be cancelled up to 12 hours before scheduled start time',
      category: 'TEMPORAL_RULE',
      statement: 'Patient may cancel an appointment up to 12 hours before its scheduled start time deadline.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['POLICY-SPEC'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      temporalDetails: {
        windowDuration: '12 hours',
        deadline: '12 hours before start time',
        isUnresolved: false,
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [customRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-TEMP01');
    assert.ok(found);
    assert.strictEqual(found.category, 'TEMPORAL_RULE');
    assert.strictEqual(found.temporalDetails?.windowDuration, '12 hours');
    assert.strictEqual(found.temporalDetails?.isUnresolved, false);
  });

  // T13: rule priority
  it('T13_rule_priority: preserves CRITICAL, HIGH, MEDIUM, LOW, and UNRESOLVED priorities', async () => {
    await createArchitectureRevision('proj-clinic');
    const ruleUnresolved: BusinessRule = {
      ruleId: 'BR-PRI01',
      title: 'Unresolved Priority Rule',
      description: 'Test rule with unresolved priority',
      category: 'DOMAIN_INVARIANT',
      statement: 'System behavior with undetermined priority.',
      priority: 'UNRESOLVED',
      status: 'PROPOSED',
      sourceReferences: [],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [ruleUnresolved],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-PRI01');
    assert.ok(found);
    assert.strictEqual(found.priority, 'UNRESOLVED');
  });

  // T14: confirmed rule
  it('T14_confirmed_rule: marks authoritatively established rules as CONFIRMED', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const confirmedRules = result.rules.filter((r) => r.status === 'CONFIRMED');
    assert.ok(confirmedRules.length > 0);
  });

  // T15: proposed rule
  it('T15_proposed_rule: marks candidate/implicit rules as PROPOSED rather than CONFIRMED', async () => {
    await createArchitectureRevision('proj-clinic');
    const proposedRule: BusinessRule = {
      ruleId: 'BR-PROP01',
      title: 'Proposed SMS Reminder Frequency',
      description: 'Proposed policy to send SMS 2 hours before appointment',
      category: 'NOTIFICATION_RULE',
      statement: 'System should notify patient via SMS reminder 2 hours before scheduled slot.',
      priority: 'MEDIUM',
      status: 'PROPOSED',
      sourceReferences: ['CANDIDATE-PROPOSAL'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [proposedRule],
    });

    const found = result.rules.find((r) => r.ruleId === 'BR-PROP01');
    assert.ok(found);
    assert.strictEqual(found.status, 'PROPOSED');
  });

  // T16: pending Product Owner decision
  it('T16_pending_product_owner_decision: records explicit human decisions and sets rule status to PENDING_DECISION', async () => {
    await createArchitectureRevision('proj-clinic');
    const pendingRule: BusinessRule = {
      ruleId: 'BR-DEC01',
      title: 'Late Cancellation Refund Policy',
      description: 'Policy governing refund percentage when patient cancels within 2 hours',
      category: 'POLICY_RULE',
      statement: 'Patient late cancellation refund percentage is pending Product Owner decision.',
      priority: 'HIGH',
      status: 'PENDING_DECISION',
      sourceReferences: ['REFUND-POLICY-TBD'],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: [],
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [pendingRule],
      customDecisions: [
        {
          decisionId: 'BD-REFUND01',
          question: 'What is the refund percentage for late cancellations within 2 hours of start time?',
          whyItMatters: 'Direct financial impact on clinic revenue and patient fairness.',
          affectedRules: ['BR-DEC01'],
          affectedRequirements: [],
          availableOptions: ['100% full refund', '50% partial refund', '0% no refund'],
          consequences: ['Zero refund may upset patients; full refund leaves open unused slots.'],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        },
      ],
    });

    const foundRule = result.rules.find((r) => r.ruleId === 'BR-DEC01');
    assert.ok(foundRule);
    assert.strictEqual(foundRule.status, 'PENDING_DECISION');

    const foundDecision = result.pendingHumanDecisions.find((d) => d.decisionId === 'BD-REFUND01');
    assert.ok(foundDecision);
    assert.strictEqual(foundDecision.authority, Actor.USER);
    assert.strictEqual(foundDecision.status, 'PENDING_DECISION');
  });

  // T17: no silent business-policy selection
  it('T17_no_silent_business_policy_selection: never guesses a business policy when ambiguous options exist', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      customDecisions: [
        {
          decisionId: 'BD-PRICING',
          question: 'Should VIP clients receive 10% discount?',
          whyItMatters: 'Requires Product Owner pricing strategy approval',
          affectedRules: [],
          affectedRequirements: [],
          availableOptions: ['Yes 10% discount', 'No discount'],
          consequences: ['Affects margins'],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        },
      ],
    });

    const decision = result.pendingHumanDecisions.find((d) => d.decisionId === 'BD-PRICING');
    assert.ok(decision);
    assert.strictEqual(decision.status, 'PENDING_DECISION');
    // Ensure no automatic selection was made
    assert.ok(!('selectedOption' in decision) || (decision as any).selectedOption === undefined);
  });

  // T18: rule dependencies
  it('T18_rule_dependencies: models explicit dependencies between business rules', async () => {
    await createArchitectureRevision('proj-clinic');
    const rule1: BusinessRule = {
      ruleId: 'BR-DEP01',
      title: 'Authentication Prerequisite',
      description: 'User must be authenticated before performing actions',
      category: 'AUTHORIZATION_RULE',
      statement: 'User must be authenticated with valid session credentials.',
      priority: 'CRITICAL',
      status: 'CONFIRMED',
      sourceReferences: [],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: ['SECURITY'],
      dependencies: [],
      metadata: {},
    };

    const rule2: BusinessRule = {
      ruleId: 'BR-DEP02',
      title: 'Order Creation Permission',
      description: 'Only authenticated users may create orders',
      category: 'AUTHORIZATION_RULE',
      statement: 'Only authenticated users with active accounts may create new orders.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: [],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: ['SECURITY'],
      dependencies: ['BR-DEP01'],
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [rule1, rule2],
    });

    const found2 = result.rules.find((r) => r.ruleId === 'BR-DEP02');
    assert.ok(found2);
    assert.deepStrictEqual(found2.dependencies, ['BR-DEP01']);
  });

  // T19: invalid rule dependency rejection
  it('T19_invalid_rule_dependency_rejection: fails closed when a rule references a nonexistent dependency', async () => {
    await createArchitectureRevision('proj-clinic');
    const invalidRule: BusinessRule = {
      ruleId: 'BR-INVDEP01',
      title: 'Dangling Dependency Rule',
      description: 'References a rule that does not exist in the revision',
      category: 'DOMAIN_INVARIANT',
      statement: 'Action requires nonexistent condition.',
      priority: 'MEDIUM',
      status: 'CONFIRMED',
      sourceReferences: [],
      sourceRequirements: [],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: [],
      affectedArchitectureAreas: [],
      dependencies: ['BR-GHOST-DOES-NOT-EXIST'],
      metadata: {},
    };

    await assert.rejects(
      async () => {
        await businessRulesEngine.derive({
          projectId: 'proj-clinic',
          additionalRules: [invalidRule],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof BusinessRulesDependencyError);
        assert.ok((err as Error).message.includes('BR-GHOST-DOES-NOT-EXIST'));
        return true;
      }
    );
  });

  // T20: requirement traceability
  it('T20_requirement_traceability: links every rule to source functional requirements', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result.requirementsTraceability.length > 0);
    for (const trace of result.requirementsTraceability) {
      assert.ok(trace.requirementId);
      assert.ok(trace.requirementTitle);
      assert.ok(Array.isArray(trace.addressedByRules));
    }
  });

  // T21: architecture traceability
  it('T21_architecture_traceability: exposes affected architecture areas and source decisions', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const rulesWithArch = result.rules.filter((r) => r.affectedArchitectureAreas.length > 0);
    assert.ok(rulesWithArch.length > 0);
  });

  // T22: discovery traceability
  it('T22_discovery_traceability: preserves references to raw discovery evidence', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const rulesWithDiscovery = result.rules.filter((r) => r.sourceDiscoveryReferences.length > 0);
    assert.ok(rulesWithDiscovery.length > 0);
  });

  // T23: requirements revision binding
  it('T23_requirements_revision_binding: binds immutably to source requirements revision number', async () => {
    const arch = await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result.sourceRequirementsRevision, arch.sourceRequirementsRevision);
  });

  // T24: requirements fingerprint binding
  it('T24_requirements_fingerprint_binding: binds immutably to source requirements fingerprint', async () => {
    const arch = await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result.sourceRequirementsFingerprint, arch.sourceRequirementsFingerprint);
  });

  // T25: architecture revision binding
  it('T25_architecture_revision_binding: binds immutably to source architecture revision number', async () => {
    const arch = await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result.sourceArchitectureRevision, arch.architectureRevision);
  });

  // T26: architecture fingerprint binding
  it('T26_architecture_fingerprint_binding: binds immutably to source architecture fingerprint', async () => {
    const arch = await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result.sourceArchitectureFingerprint, arch.fingerprint);
  });

  // T27: discovery revision binding
  it('T27_discovery_revision_binding: binds immutably to source discovery revision and fingerprint', async () => {
    const arch = await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.strictEqual(result.sourceDiscoveryRevision, arch.sourceDiscoveryRevision);
    assert.strictEqual(result.sourceDiscoveryFingerprint, arch.sourceDiscoveryFingerprint);
  });

  // T28: stale source rejection
  it('T28_stale_source_rejection: detects when upstream requirements or architecture have advanced', async () => {
    await createArchitectureRevision('proj-clinic');
    const r1 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });
    assert.strictEqual(r1.isStale, false);

    // Simulate advancing requirements
    const disc2 = await createDiscoveryRevision('proj-clinic', {
      sections: { productScope: { inScope: ['Advanced Billing Feature'] } },
    });
    const req2 = await requirementsEngine.derive({
      projectId: 'proj-clinic',
      discoveryRevision: disc2.discoveryRevision,
    });
    await architectureEngine.derive({
      projectId: 'proj-clinic',
      requirementsRevision: req2.requirementsRevision,
    });

    const isStale = await businessRulesEngine.isRevisionStale(r1);
    assert.strictEqual(isStale, true);

    const latest = await businessRulesEngine.getRevision('proj-clinic', r1.businessRulesRevision);
    assert.ok(latest);
    assert.strictEqual(latest.isStale, true);
  });

  // T29: cross-project isolation
  it('T29_cross_project_isolation: strictly prevents cross-project data leakage and access', async () => {
    await createArchitectureRevision('proj-alpha');
    await createArchitectureRevision('proj-beta');

    await businessRulesEngine.derive({ projectId: 'proj-alpha' });
    await businessRulesEngine.derive({ projectId: 'proj-beta' });

    const store = new BusinessRulesStore({ baseDir: tempDir });
    const alphaRecord = await store.loadRevision('proj-alpha');
    assert.ok(alphaRecord);
    assert.strictEqual(alphaRecord.projectId, 'proj-alpha');

    // Tamper with record path to simulate cross-project access
    const alphaDir = path.join(store.recordsDir, 'proj-alpha');
    const betaDir = path.join(store.recordsDir, 'proj-beta');
    await fs.promises.copyFile(
      path.join(alphaDir, 'latest.json'),
      path.join(betaDir, 'latest.json')
    );

    await assert.rejects(
      async () => {
        await store.loadRevision('proj-beta');
      },
      (err: unknown) => {
        assert.ok(err instanceof BusinessRulesProjectBindingMismatchError);
        return true;
      }
    );
  });

  // T30: forged fingerprint rejection
  it('T30_forged_fingerprint_rejection: fails closed when expected fingerprint does not match authoritative source', async () => {
    await createArchitectureRevision('proj-clinic');

    await assert.rejects(
      async () => {
        await businessRulesEngine.derive({
          projectId: 'proj-clinic',
          expectedRequirementsFingerprint: '0000000000000000000000000000000000000000000000000000000000000000',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof BusinessRulesForgedFingerprintError);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await businessRulesEngine.derive({
          projectId: 'proj-clinic',
          expectedArchitectureFingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof BusinessRulesForgedFingerprintError);
        return true;
      }
    );
  });

  // T31: deterministic deduplication
  it('T31_deterministic_deduplication: deduplicates equivalent rules deterministically and canonicalizes arrays', async () => {
    await createArchitectureRevision('proj-clinic');
    const dup1: BusinessRule = {
      ruleId: 'BR-DUP1',
      title: 'Duplicate Policy 1',
      description: 'First copy of policy statement',
      category: 'POLICY_RULE',
      statement: 'Patient identity must be validated using two-factor authentication.',
      priority: 'MEDIUM',
      status: 'CONFIRMED',
      sourceReferences: ['REF-1'],
      sourceRequirements: ['REQ-001'],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: ['REQ-001'],
      affectedArchitectureAreas: [],
      dependencies: [],
      metadata: {},
    };

    const dup2: BusinessRule = {
      ruleId: 'BR-DUP2',
      title: 'Duplicate Policy 2',
      description: 'Second copy of policy statement with higher priority',
      category: 'POLICY_RULE',
      statement: 'Patient identity must be validated using two-factor authentication.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['REF-2'],
      sourceRequirements: ['REQ-002'],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: ['REQ-002'],
      affectedArchitectureAreas: [],
      dependencies: [],
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [dup1, dup2],
    });

    const matching = result.rules.filter(
      (r) => r.statement === 'Patient identity must be validated using two-factor authentication.'
    );
    assert.strictEqual(matching.length, 1);
    assert.strictEqual(matching[0]!.priority, 'HIGH');
    assert.deepStrictEqual(matching[0]!.sourceReferences, ['REF-1', 'REF-2']);
    assert.deepStrictEqual(matching[0]!.affectedRequirements, ['REQ-001', 'REQ-002']);
  });

  // T32: conflict detection/preservation
  it('T32_conflict_detection_preservation: detects and preserves business rule conflicts without silently choosing', async () => {
    await createArchitectureRevision('proj-clinic');
    const ruleA: BusinessRule = {
      ruleId: 'BR-CONF-A',
      title: 'Permit Guest Booking',
      description: 'Allows guest checkout without account',
      category: 'AUTHORIZATION_RULE',
      statement: 'Allow guest patients to book appointments without authentication.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['MARKETING-REQ'],
      sourceRequirements: ['REQ-001'],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: ['REQ-001'],
      affectedArchitectureAreas: [],
      dependencies: [],
      authorizationPolicyDetails: {
        actor: 'Guest Patient',
        operation: 'Book Appointment',
        effect: 'ALLOW',
      },
      metadata: {},
    };

    const ruleB: BusinessRule = {
      ruleId: 'BR-CONF-B',
      title: 'Deny Guest Booking',
      description: 'Requires all patients to have an account',
      category: 'AUTHORIZATION_RULE',
      statement: 'Deny guest patients to book appointments without authentication.',
      priority: 'HIGH',
      status: 'CONFIRMED',
      sourceReferences: ['SECURITY-REQ'],
      sourceRequirements: ['REQ-002'],
      sourceArchitectureDecisions: [],
      sourceDiscoveryReferences: [],
      affectedRequirements: ['REQ-002'],
      affectedArchitectureAreas: [],
      dependencies: [],
      authorizationPolicyDetails: {
        actor: 'Guest Patient',
        operation: 'Book Appointment',
        effect: 'DENY',
      },
      metadata: {},
    };

    const result = await businessRulesEngine.derive({
      projectId: 'proj-clinic',
      additionalRules: [ruleA, ruleB],
    });

    assert.ok(result.conflicts.length > 0);
    const conflict = result.conflicts[0]!;
    assert.strictEqual(conflict.resolutionStatus, 'PENDING_DECISION');
    assert.strictEqual(conflict.requiredAuthority, Actor.USER);

    // Affected rules must be set to PENDING_DECISION
    const foundA = result.rules.find((r) => r.ruleId === 'BR-CONF-A');
    const foundB = result.rules.find((r) => r.ruleId === 'BR-CONF-B');
    assert.ok(foundA);
    assert.ok(foundB);
    assert.strictEqual(foundA.status, 'PENDING_DECISION');
    assert.strictEqual(foundB.status, 'PENDING_DECISION');
  });

  // T33: persistence and historical retrieval
  it('T33_persistence_and_historical_retrieval: historical revisions are retrievable and rev files are immutable', async () => {
    await createArchitectureRevision('proj-clinic');
    const r1 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const loaded = await businessRulesEngine.getRevision('proj-clinic', 1);
    assert.ok(loaded);
    assert.strictEqual(loaded.businessRulesRevision, 1);
    assert.strictEqual(loaded.fingerprint, r1.fingerprint);

    // Verify immutability check
    const store = new BusinessRulesStore({ baseDir: tempDir });
    const tampered = { ...r1, fingerprint: '1111111111111111111111111111111111111111111111111111111111111111' };
    await assert.rejects(
      async () => {
        await store.saveRevision(tampered);
      },
      (err: unknown) => {
        assert.ok(err instanceof BusinessRulesImmutableRevisionError);
        return true;
      }
    );
  });

  // T34: latest revision retrieval
  it('T34_latest_revision_retrieval: correctly loads the latest pointer for a project', async () => {
    await createArchitectureRevision('proj-clinic');
    const r1 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const latest = await businessRulesEngine.getLatest('proj-clinic');
    assert.ok(latest);
    assert.strictEqual(latest.businessRulesRevision, r1.businessRulesRevision);
    assert.strictEqual(latest.fingerprint, r1.fingerprint);
  });

  // T35: history event
  it('T35_history_event: appends PROJECT_BUSINESS_RULES_DEFINED audit event to HistoryManager', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const historyFile = path.join(tempDir, '.ai-manager', 'history', 'events.jsonl');
    assert.ok(fs.existsSync(historyFile));
    const content = await fs.promises.readFile(historyFile, 'utf8');
    const lines = content.trim().split('\n');

    const businessRulesEvents = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.eventType === 'PROJECT_BUSINESS_RULES_DEFINED');

    assert.ok(businessRulesEvents.length >= 1);
    const event = businessRulesEvents[businessRulesEvents.length - 1]!;
    assert.strictEqual(event.actor, Actor.DIRECTOR);
    assert.strictEqual(event.payload.projectId, 'proj-clinic');
    assert.strictEqual(event.payload.businessRulesRevision, result.businessRulesRevision);
    assert.strictEqual(event.payload.fingerprint, result.fingerprint);
    assert.ok(typeof event.payload.ruleCount === 'number');
    assert.ok(typeof event.payload.confirmedCount === 'number');
    assert.ok(typeof event.payload.pendingDecisionCount === 'number');
  });

  // T36: MCP boundary
  it('T36_mcp_boundary: aidm.business-rules.define and aidm.business-rules.get execute through MCP server without leaking internal state', async () => {
    await createArchitectureRevision('proj-clinic');

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      historyManager,
      specStore,
      adaptiveDiscoveryStore: discoveryStore,
      completenessGateStore: completenessStore,
      requirementsScopeStore: requirementsStore,
      architectureTechnologyStore: architectureStore,
      businessRulesStore,
      adaptiveDiscoveryEngine: discoveryEngine,
      completenessGateEngine: completenessEngine,
      requirementsScopeEngine: requirementsEngine,
      architectureTechnologyEngine: architectureEngine,
      businessRulesEngine,
    });

    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      businessRulesTools: true,
    });

    await server.start();

    // Test define tool
    const defineReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_BUSINESS_RULES_DEFINE_TOOL_NAME,
        arguments: { projectId: 'proj-clinic' },
      },
    };

    const defineRes = (await server.handleMessage(defineReq)) as McpSuccessResponseEnvelope;
    assert.strictEqual(defineRes.id, 1);
    assert.ok(defineRes.result);
    const defineData = JSON.parse((defineRes.result.content[0] as any).text);
    assert.strictEqual(defineData.projectId, 'proj-clinic');
    assert.strictEqual(defineData.businessRulesRevision, 1);

    // Test get tool
    const getReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_BUSINESS_RULES_GET_TOOL_NAME,
        arguments: { projectId: 'proj-clinic' },
      },
    };

    const getRes = (await server.handleMessage(getReq)) as McpSuccessResponseEnvelope;
    assert.strictEqual(getRes.id, 2);
    assert.ok(getRes.result);
    const getData = JSON.parse((getRes.result.content[0] as any).text);
    assert.strictEqual(getData.projectId, 'proj-clinic');
    assert.strictEqual(getData.businessRulesRevision, 1);

    await server.stop();
  });

  // T37: no approval
  it('T37_no_approval: business rules definition does NOT create or alter approval records', async () => {
    await createArchitectureRevision('proj-clinic');
    await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const packages = await approvalStore.listPackages('proj-clinic');
    assert.strictEqual(packages.length, 0);
  });

  // T38: no development authorization
  it('T38_no_development_authorization: durable state remains unmutated; development is not authorized', async () => {
    await createArchitectureRevision('proj-clinic');
    await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const stateExists = await durableManager.exists();
    assert.strictEqual(stateExists, false);
  });

  // T39: no ExecutionIntent
  it('T39_no_execution_intent: execution intents remain strictly untouched', async () => {
    await createArchitectureRevision('proj-clinic');
    await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    const intentDir = path.join(tempDir, '.ai-manager', 'execution-intents');
    assert.strictEqual(fs.existsSync(intentDir), false);
  });

  // T40: no Antigravity invocation
  it('T40_no_antigravity_invocation: completes without launching external executor processes or mutating DAG', async () => {
    await createArchitectureRevision('proj-clinic');
    const result = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    assert.ok(result);
    const tasksDir = path.join(tempDir, '.ai-manager', 'tasks');
    assert.strictEqual(fs.existsSync(tasksDir), false);
  });

  // T41: restart/reload behavior
  it('T41_restart_reload_behavior: fresh engine instance reads exact persisted business rules intact', async () => {
    await createArchitectureRevision('proj-clinic');
    const r1 = await businessRulesEngine.derive({ projectId: 'proj-clinic' });

    // Create brand new engine instance pointing to the same directory
    const freshEngine = new BusinessRulesEngine({
      baseDir: tempDir,
    });

    const reloaded = await freshEngine.getLatest('proj-clinic');
    assert.ok(reloaded);
    assert.strictEqual(reloaded.projectId, 'proj-clinic');
    assert.strictEqual(reloaded.businessRulesRevision, r1.businessRulesRevision);
    assert.strictEqual(reloaded.fingerprint, r1.fingerprint);
    assert.strictEqual(reloaded.rules.length, r1.rules.length);
    assert.strictEqual(reloaded.isStale, false);
  });
});
