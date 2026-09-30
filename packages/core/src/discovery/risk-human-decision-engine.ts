/**
 * Risk & Human Decision Points Engine (Phase 15 TASK-P15-07)
 *
 * Transforms authoritative Discovery (P15-01), Requirements / Scope (P15-03),
 * Architecture / Technology (P15-04), Business Rules (P15-05), and Acceptance Criteria (P15-06)
 * into an authoritative, revisioned Risk and Human Decision Point specification for project initiation.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-07 defines "What can go wrong, how significant is it, how is it mitigated, and where must a human/Product Owner make an explicit decision?"
 * 2. It does NOT answer "Should the project be approved?" (That belongs to the later Product Owner Approval phase).
 * 3. Does NOT approve the project, authorize development, or invoke Antigravity.
 * 4. Human Decision Points can NEVER be silently chosen by the system.
 * 5. Strictly deterministic: identical inputs produce identical risks, human decisions, and fingerprint.
 * 6. Revision-bound: immutable by revision, protects against stale upstream sources.
 * 7. Fails closed on cross-project mismatches, forged fingerprints, invalid dependencies, or path traversal.
 */

import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import { RequirementsScopeStore } from './requirements-scope-store.js';
import { ArchitectureTechnologyStore } from './architecture-technology-store.js';
import { BusinessRulesStore } from './business-rules-store.js';
import { AcceptanceCriteriaStore } from './acceptance-criteria-store.js';
import { RiskHumanDecisionStore } from './risk-human-decision-store.js';
import type { ProjectDiscoveryRevision } from './adaptive-discovery-types.js';
import type { ProjectRequirementsScopeRevision } from './requirements-scope-types.js';
import type { ProjectArchitectureRevision } from './architecture-technology-types.js';
import type { ProjectBusinessRulesRevision } from './business-rules-types.js';
import type { ProjectAcceptanceCriteriaRevision } from './acceptance-criteria-types.js';
import {
  RiskHumanDecisionInputZodSchema,
  computeRiskFingerprint,
  computeRiskSeverity,
  type RiskHumanDecisionInput,
  type ProjectRiskRevision,
  type ProjectRisk,
  type HumanDecisionPoint,
  type RiskCoverage,
  type HumanDecisionCoverage,
  type RiskCategory,
  type RiskProbability,
  type RiskImpact,
  type RiskStatus,
  type RiskResponse,
} from './risk-human-decision-types.js';
import {
  RiskValidationError,
  RiskRevisionNotFoundError,
  RiskProjectBindingMismatchError,
  RiskStaleSourceError,
  RiskForgedFingerprintError,
  RiskTraceabilityError,
  RiskSeverityMismatchError,
  HumanDecisionAuthorityError,
} from './risk-human-decision-errors.js';
import { computeDeterministicHash } from './adaptive-discovery-normalizer.js';

export interface RiskHumanDecisionEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly architectureStore?: ArchitectureTechnologyStore;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly riskStore?: RiskHumanDecisionStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export class RiskHumanDecisionEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly requirementsStore: RequirementsScopeStore;
  readonly architectureStore: ArchitectureTechnologyStore;
  readonly businessRulesStore: BusinessRulesStore;
  readonly acceptanceCriteriaStore: AcceptanceCriteriaStore;
  readonly riskStore: RiskHumanDecisionStore;
  private readonly historyManager?: HistoryManager;
  private readonly specStore?: SpecStore;

  constructor(options?: RiskHumanDecisionEngineOptions) {
    this.workspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
    this.baseDir = options?.baseDir
      ? path.resolve(options.baseDir)
      : this.workspaceRoot ?? process.cwd();
    this.historyManager = options?.historyManager;
    this.specStore = options?.specStore;

    this.discoveryStore =
      options?.discoveryStore ??
      new AdaptiveDiscoveryStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.requirementsStore =
      options?.requirementsStore ??
      new RequirementsScopeStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.architectureStore =
      options?.architectureStore ??
      new ArchitectureTechnologyStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.businessRulesStore =
      options?.businessRulesStore ??
      new BusinessRulesStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.acceptanceCriteriaStore =
      options?.acceptanceCriteriaStore ??
      new AcceptanceCriteriaStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.riskStore =
      options?.riskStore ??
      new RiskHumanDecisionStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });
  }

  /**
   * Helper to construct a deterministic ProjectRisk.
   */
  private buildDeterministicRisk(params: {
    category: RiskCategory;
    probability: RiskProbability;
    impact: RiskImpact;
    status: RiskStatus;
    response: RiskResponse;
    title: string;
    description: string;
    statement: string;
    consequences?: string[];
    mitigation: string;
    contingency?: string;
    owner?: string;
    sourceRequirements?: string[];
    sourceBusinessRules?: string[];
    sourceArchitectureDecisions?: string[];
    sourceAcceptanceCriteria?: string[];
    sourceDiscovery?: string[];
    dependencies?: string[];
    metadata?: Record<string, unknown>;
  }): ProjectRisk {
    const severity = computeRiskSeverity(params.probability, params.impact);
    const sourceRequirements = [...(params.sourceRequirements ?? [])].sort();
    const sourceBusinessRules = [...(params.sourceBusinessRules ?? [])].sort();
    const sourceArchitectureDecisions = [...(params.sourceArchitectureDecisions ?? [])].sort();
    const sourceAcceptanceCriteria = [...(params.sourceAcceptanceCriteria ?? [])].sort();
    const sourceDiscovery = [...(params.sourceDiscovery ?? [])].sort();
    const consequences = [...(params.consequences ?? [])].sort();
    const dependencies = [...(params.dependencies ?? [])].sort();

    const hashInput = `${params.category}:::${params.title}:::${params.statement}:::${sourceRequirements.join(',')}:::${sourceBusinessRules.join(',')}:::${sourceArchitectureDecisions.join(',')}:::${sourceAcceptanceCriteria.join(',')}`;
    const hash = computeDeterministicHash(hashInput, 12).toUpperCase();
    const riskId = `RISK-${params.category}-${hash}`;

    return {
      riskId,
      title: params.title,
      description: params.description,
      category: params.category,
      probability: params.probability,
      impact: params.impact,
      severity,
      status: params.status,
      response: params.response,
      statement: params.statement,
      consequences,
      mitigation: params.mitigation,
      contingency: params.contingency ?? '',
      owner: params.owner ?? 'PRODUCT_OWNER',
      sourceRequirements,
      sourceBusinessRules,
      sourceArchitectureDecisions,
      sourceAcceptanceCriteria,
      sourceDiscovery,
      dependencies,
      traceability: {
        riskId,
        requirementIds: sourceRequirements,
        businessRuleIds: sourceBusinessRules,
        architectureDecisionIds: sourceArchitectureDecisions,
        acceptanceCriteriaIds: sourceAcceptanceCriteria,
        discoveryKeys: sourceDiscovery,
      },
      metadata: params.metadata ?? {},
    };
  }

  /**
   * Helper to construct a deterministic HumanDecisionPoint.
   */
  private buildDeterministicDecision(params: {
    title: string;
    question: string;
    whyItMatters: string;
    affectedRisks?: string[];
    affectedRequirements?: string[];
    affectedArchitectureDecisions?: string[];
    affectedBusinessRules?: string[];
    affectedAcceptanceCriteria?: string[];
    availableOptions: string[];
    consequences?: string[];
    recommendedInformation?: string;
    authority?: 'PRODUCT_OWNER' | 'USER';
    status?: 'PENDING_DECISION' | 'RESOLVED' | 'REJECTED';
    metadata?: Record<string, unknown>;
  }): HumanDecisionPoint {
    const affectedRisks = [...(params.affectedRisks ?? [])].sort();
    const affectedRequirements = [...(params.affectedRequirements ?? [])].sort();
    const affectedArchitectureDecisions = [...(params.affectedArchitectureDecisions ?? [])].sort();
    const affectedBusinessRules = [...(params.affectedBusinessRules ?? [])].sort();
    const affectedAcceptanceCriteria = [...(params.affectedAcceptanceCriteria ?? [])].sort();
    const availableOptions = [...params.availableOptions];
    const consequences = [...(params.consequences ?? [])].sort();

    const hashInput = `${params.title}:::${params.question}:::${affectedRisks.join(',')}:::${affectedRequirements.join(',')}`;
    const hash = computeDeterministicHash(hashInput, 12).toUpperCase();
    const decisionId = `HDP-${hash}`;

    const authority = params.authority ?? 'PRODUCT_OWNER';
    if (authority !== 'PRODUCT_OWNER' && authority !== 'USER') {
      throw new HumanDecisionAuthorityError(
        `Invalid decision authority '${authority}'. Human decisions must be decided by PRODUCT_OWNER or USER.`,
        { authority }
      );
    }

    return {
      decisionId,
      title: params.title,
      question: params.question,
      whyItMatters: params.whyItMatters,
      affectedRisks,
      affectedRequirements,
      affectedArchitectureDecisions,
      affectedBusinessRules,
      affectedAcceptanceCriteria,
      availableOptions,
      consequences,
      recommendedInformation: params.recommendedInformation ?? '',
      authority,
      status: params.status ?? 'PENDING_DECISION',
      metadata: params.metadata ?? {},
    };
  }

  /**
   * Derives an authoritative, revisioned Project Risk & Human Decision Point specification.
   */
  async derive(input: RiskHumanDecisionInput): Promise<ProjectRiskRevision> {
    const parsedInput = RiskHumanDecisionInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new RiskValidationError(
        `Risk input validation failed: ${parsedInput.error.message}`,
        { issues: parsedInput.error.issues }
      );
    }

    const { projectId } = parsedInput.data;
    const safeProjectId = this.riskStore.sanitizeProjectId(projectId);

    // 1. Authoritative Upstream: Requirements & Scope (P15-03)
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      parsedInput.data.requirementsRevision
    );
    if (!requirements) {
      throw new RiskRevisionNotFoundError(
        `No requirements revision found for project '${projectId}'${
          parsedInput.data.requirementsRevision !== undefined
            ? ` at revision ${parsedInput.data.requirementsRevision}`
            : ''
        }. Requirements & Scope must be defined (P15-03) before Risks can be defined.`,
        { projectId, requestedRevision: parsedInput.data.requirementsRevision }
      );
    }

    if (requirements.projectId !== projectId) {
      throw new RiskProjectBindingMismatchError(
        `Cross-project mismatch: requirements belong to '${requirements.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, requirementsProjectId: requirements.projectId }
      );
    }

    if (
      parsedInput.data.expectedRequirementsFingerprint &&
      requirements.fingerprint !== parsedInput.data.expectedRequirementsFingerprint
    ) {
      throw new RiskForgedFingerprintError(
        `Requirements fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedRequirementsFingerprint}' but got '${requirements.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedRequirementsFingerprint,
          actual: requirements.fingerprint,
        }
      );
    }

    // 2. Authoritative Upstream: Architecture & Technology (P15-04)
    const architecture = await this.architectureStore.loadRevision(
      safeProjectId,
      parsedInput.data.architectureRevision
    );
    if (!architecture) {
      throw new RiskRevisionNotFoundError(
        `No architecture revision found for project '${projectId}'${
          parsedInput.data.architectureRevision !== undefined
            ? ` at revision ${parsedInput.data.architectureRevision}`
            : ''
        }. Architecture & Technology must be defined (P15-04) before Risks can be defined.`,
        { projectId, requestedRevision: parsedInput.data.architectureRevision }
      );
    }

    if (architecture.projectId !== projectId) {
      throw new RiskProjectBindingMismatchError(
        `Cross-project mismatch: architecture belongs to '${architecture.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, architectureProjectId: architecture.projectId }
      );
    }

    if (
      parsedInput.data.expectedArchitectureFingerprint &&
      architecture.fingerprint !== parsedInput.data.expectedArchitectureFingerprint
    ) {
      throw new RiskForgedFingerprintError(
        `Architecture fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedArchitectureFingerprint}' but got '${architecture.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedArchitectureFingerprint,
          actual: architecture.fingerprint,
        }
      );
    }

    // 3. Authoritative Upstream: Business Rules (P15-05)
    const businessRules = await this.businessRulesStore.loadRevision(
      safeProjectId,
      parsedInput.data.businessRulesRevision
    );
    if (!businessRules) {
      throw new RiskRevisionNotFoundError(
        `No business rules revision found for project '${projectId}'${
          parsedInput.data.businessRulesRevision !== undefined
            ? ` at revision ${parsedInput.data.businessRulesRevision}`
            : ''
        }. Business Rules must be defined (P15-05) before Risks can be defined.`,
        { projectId, requestedRevision: parsedInput.data.businessRulesRevision }
      );
    }

    if (businessRules.projectId !== projectId) {
      throw new RiskProjectBindingMismatchError(
        `Cross-project mismatch: business rules belong to '${businessRules.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, businessRulesProjectId: businessRules.projectId }
      );
    }

    if (
      parsedInput.data.expectedBusinessRulesFingerprint &&
      businessRules.fingerprint !== parsedInput.data.expectedBusinessRulesFingerprint
    ) {
      throw new RiskForgedFingerprintError(
        `Business rules fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedBusinessRulesFingerprint}' but got '${businessRules.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedBusinessRulesFingerprint,
          actual: businessRules.fingerprint,
        }
      );
    }

    // 4. Authoritative Upstream: Acceptance Criteria (P15-06)
    const acceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(
      safeProjectId,
      parsedInput.data.acceptanceCriteriaRevision
    );
    if (!acceptanceCriteria) {
      throw new RiskRevisionNotFoundError(
        `No acceptance criteria revision found for project '${projectId}'${
          parsedInput.data.acceptanceCriteriaRevision !== undefined
            ? ` at revision ${parsedInput.data.acceptanceCriteriaRevision}`
            : ''
        }. Acceptance Criteria must be defined (P15-06) before Risks can be defined.`,
        { projectId, requestedRevision: parsedInput.data.acceptanceCriteriaRevision }
      );
    }

    if (acceptanceCriteria.projectId !== projectId) {
      throw new RiskProjectBindingMismatchError(
        `Cross-project mismatch: acceptance criteria belong to '${acceptanceCriteria.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, acceptanceCriteriaProjectId: acceptanceCriteria.projectId }
      );
    }

    if (
      parsedInput.data.expectedAcceptanceCriteriaFingerprint &&
      acceptanceCriteria.fingerprint !== parsedInput.data.expectedAcceptanceCriteriaFingerprint
    ) {
      throw new RiskForgedFingerprintError(
        `Acceptance criteria fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedAcceptanceCriteriaFingerprint}' but got '${acceptanceCriteria.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedAcceptanceCriteriaFingerprint,
          actual: acceptanceCriteria.fingerprint,
        }
      );
    }

    // 5. Authoritative Upstream: Adaptive Discovery (P15-01)
    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      parsedInput.data.discoveryRevision ?? requirements.sourceDiscoveryRevision
    );
    if (!discovery) {
      throw new RiskRevisionNotFoundError(
        `No discovery revision found for project '${projectId}' at revision ${
          parsedInput.data.discoveryRevision ?? requirements.sourceDiscoveryRevision
        }.`,
        { projectId, requestedRevision: parsedInput.data.discoveryRevision }
      );
    }

    if (discovery.projectId !== projectId) {
      throw new RiskProjectBindingMismatchError(
        `Cross-project mismatch: discovery belongs to '${discovery.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, discoveryProjectId: discovery.projectId }
      );
    }

    if (
      parsedInput.data.expectedDiscoveryFingerprint &&
      discovery.fingerprint !== parsedInput.data.expectedDiscoveryFingerprint
    ) {
      throw new RiskForgedFingerprintError(
        `Discovery fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedDiscoveryFingerprint}' but got '${discovery.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedDiscoveryFingerprint,
          actual: discovery.fingerprint,
        }
      );
    }

    // 6. Stale source checks against latest revisions
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (
      latestRequirements &&
      latestRequirements.requirementsRevision > requirements.requirementsRevision
    ) {
      throw new RiskStaleSourceError(
        `Stale requirements revision: provided revision ${requirements.requirementsRevision} is superseded by latest revision ${latestRequirements.requirementsRevision}.`,
        {
          currentRevision: requirements.requirementsRevision,
          latestRevision: latestRequirements.requirementsRevision,
        }
      );
    }

    const latestArchitecture = await this.architectureStore.loadRevision(safeProjectId);
    if (
      latestArchitecture &&
      latestArchitecture.architectureRevision > architecture.architectureRevision
    ) {
      throw new RiskStaleSourceError(
        `Stale architecture revision: provided revision ${architecture.architectureRevision} is superseded by latest revision ${latestArchitecture.architectureRevision}.`,
        {
          currentRevision: architecture.architectureRevision,
          latestRevision: latestArchitecture.architectureRevision,
        }
      );
    }

    const latestBusinessRules = await this.businessRulesStore.loadRevision(safeProjectId);
    if (
      latestBusinessRules &&
      latestBusinessRules.businessRulesRevision > businessRules.businessRulesRevision
    ) {
      throw new RiskStaleSourceError(
        `Stale business rules revision: provided revision ${businessRules.businessRulesRevision} is superseded by latest revision ${latestBusinessRules.businessRulesRevision}.`,
        {
          currentRevision: businessRules.businessRulesRevision,
          latestRevision: latestBusinessRules.businessRulesRevision,
        }
      );
    }

    const latestAcceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(safeProjectId);
    if (
      latestAcceptanceCriteria &&
      latestAcceptanceCriteria.acceptanceCriteriaRevision > acceptanceCriteria.acceptanceCriteriaRevision
    ) {
      throw new RiskStaleSourceError(
        `Stale acceptance criteria revision: provided revision ${acceptanceCriteria.acceptanceCriteriaRevision} is superseded by latest revision ${latestAcceptanceCriteria.acceptanceCriteriaRevision}.`,
        {
          currentRevision: acceptanceCriteria.acceptanceCriteriaRevision,
          latestRevision: latestAcceptanceCriteria.acceptanceCriteriaRevision,
        }
      );
    }

    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (latestDiscovery && latestDiscovery.discoveryRevision > discovery.discoveryRevision) {
      throw new RiskStaleSourceError(
        `Stale discovery revision: provided revision ${discovery.discoveryRevision} is superseded by latest revision ${latestDiscovery.discoveryRevision}.`,
        {
          currentRevision: discovery.discoveryRevision,
          latestRevision: latestDiscovery.discoveryRevision,
        }
      );
    }

    // 7. Authoritative Derivation of Risks and Human Decision Points
    const derivedRisks: ProjectRisk[] = [];
    const derivedDecisions: HumanDecisionPoint[] = [];

    // Collect all valid IDs for traceability validation
    const validRequirementIds = new Set(requirements.functionalRequirements.map((r) => r.requirementId));
    const validArchDecisionIds = new Set(architecture.decisions.map((d) => d.decisionId));
    const validBusinessRuleIds = new Set(businessRules.rules.map((r) => r.ruleId));
    const validAcceptanceCriteriaIds = new Set(acceptanceCriteria.criteria.map((c) => c.criterionId));

    // A. Derive from Requirements
    for (const req of requirements.functionalRequirements) {
      if (req.priority === 'CRITICAL') {
        const risk = this.buildDeterministicRisk({
          category: 'REQUIREMENT',
          probability: 'MEDIUM',
          impact: 'CRITICAL',
          status: 'IDENTIFIED',
          response: 'MITIGATE',
          title: `Critical Requirement: ${req.title}`,
          description: `Requirement ${req.requirementId} is marked CRITICAL. Implementation failure jeopardizes project delivery.`,
          statement: `Requirement ${req.requirementId} (${req.title}) is mission-critical. Delivery failure would cause project failure.`,
          consequences: ['Failure to satisfy critical requirement causes project goal non-fulfillment.'],
          mitigation: `Ensure rigorous validation, continuous integration tests, and priority review for ${req.requirementId}.`,
          contingency: `Identify minimum viable fallback scope if full requirement cannot be met.`,
          owner: 'PRODUCT_OWNER',
          sourceRequirements: [req.requirementId],
        });
        derivedRisks.push(risk);
      }
    }

    for (const assumption of requirements.assumptions ?? []) {
      if (!assumption.validated) {
        const risk = this.buildDeterministicRisk({
          category: 'SCOPE',
          probability: 'MEDIUM',
          impact: 'MEDIUM',
          status: 'IDENTIFIED',
          response: 'MONITOR',
          title: `Scope Assumption: ${assumption.statement.slice(0, 50)}`,
          description: `Unvalidated scope assumption: "${assumption.statement}".`,
          statement: `Assumption "${assumption.statement}" has not been formally validated.`,
          consequences: ['Unvalidated assumptions may require scope or architecture changes if invalid.'],
          mitigation: `Validate assumption with stakeholders during initiation.`,
          contingency: `Establish fallback scope if assumption fails.`,
          owner: 'PRODUCT_OWNER',
          sourceDiscovery: [assumption.statement],
        });
        derivedRisks.push(risk);
      }
    }

    for (const hdp of requirements.humanDecisions ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'SCOPE',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Scope Decision: ${hdp.title}`,
        description: `Scope human decision ${hdp.decisionId} requires Product Owner selection.`,
        statement: `Scope decision "${hdp.title}" is unresolved: ${hdp.description}`,
        consequences: ['Unclear scope boundaries introduce scope creep or missed deliverables.'],
        mitigation: `Product Owner must decide between available options.`,
        contingency: `Exclude undecided items from immediate scope.`,
        owner: 'PRODUCT_OWNER',
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: hdp.title,
        question: hdp.description,
        whyItMatters: `Scope decision for ${hdp.title} affects project boundaries.`,
        affectedRisks: [risk.riskId],
        availableOptions:
          hdp.availableOptions && hdp.availableOptions.length > 0
            ? hdp.availableOptions
            : ['Accept', 'Reject', 'Defer'],
        consequences: ['Alternative choice establishes scope baseline.'],
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    // B. Derive from Architecture
    for (const dec of architecture.decisions) {
      const archAffectedReqs = (dec.affectedRequirements ?? []).filter((id) => validRequirementIds.has(id));
      if (dec.status === 'PENDING_DECISION' || dec.status === 'CANDIDATE') {
        const risk = this.buildDeterministicRisk({
          category: 'ARCHITECTURE',
          probability: 'HIGH',
          impact: 'HIGH',
          status: 'PENDING_DECISION',
          response: 'PENDING_DECISION',
          title: `Pending Architecture Decision: ${dec.decisionId}`,
          description: dec.question,
          statement: `Architecture decision ${dec.decisionId} (${dec.question}) is proposed but not finalized.`,
          consequences: dec.consequences.length > 0 ? dec.consequences : ['Unresolved architecture choices cause architectural churn.'],
          mitigation: `Review architectural tradeoffs and obtain Product Owner decision.`,
          contingency: `Default to conservative monolithic or standard reference pattern.`,
          owner: 'PRODUCT_OWNER',
          sourceArchitectureDecisions: [dec.decisionId],
          sourceRequirements: archAffectedReqs,
        });
        derivedRisks.push(risk);

        const decision = this.buildDeterministicDecision({
          title: `Decide Architecture: ${dec.decisionId}`,
          question: dec.question,
          whyItMatters: `Decision ${dec.decisionId} (${dec.decisionArea}) defines structural constraints.`,
          affectedRisks: [risk.riskId],
          affectedArchitectureDecisions: [dec.decisionId],
          affectedRequirements: archAffectedReqs,
          availableOptions:
            dec.candidateOptions && dec.candidateOptions.length > 0
              ? dec.candidateOptions
              : ['Approve proposed approach', 'Select alternative architecture', 'Defer with prototype'],
          consequences: dec.consequences,
          authority: 'PRODUCT_OWNER',
          status: 'PENDING_DECISION',
        });
        derivedDecisions.push(decision);
      } else if (dec.decisionArea === 'SECURITY') {
        const risk = this.buildDeterministicRisk({
          category: 'SECURITY',
          probability: 'LOW',
          impact: 'CRITICAL',
          status: 'IDENTIFIED',
          response: 'MITIGATE',
          title: `Security Architecture Enforcement: ${dec.decisionId}`,
          description: dec.question,
          statement: `Architecture decision ${dec.decisionId} defines security controls. Vulnerabilities could breach data isolation.`,
          consequences: ['Security vulnerabilities could cause data leakage or unauthorized access.'],
          mitigation: `Implement automated security test suites and policy enforcement.`,
          contingency: `Fallback to strict token-based authorization and deny-by-default firewall.`,
          owner: 'PRODUCT_OWNER',
          sourceArchitectureDecisions: [dec.decisionId],
          sourceRequirements: archAffectedReqs,
        });
        derivedRisks.push(risk);
      } else if (dec.decisionArea === 'INTEGRATION') {
        const risk = this.buildDeterministicRisk({
          category: 'INTEGRATION',
          probability: 'MEDIUM',
          impact: 'HIGH',
          status: 'IDENTIFIED',
          response: 'MITIGATE',
          title: `External Integration Architecture: ${dec.decisionId}`,
          description: dec.question,
          statement: `Integration decision ${dec.decisionId} connects to third-party services.`,
          consequences: ['Third-party service failure or rate limiting disrupts application functionality.'],
          mitigation: `Define resilient timeout, retry, and circuit breaker patterns.`,
          contingency: `Offline queuing and degraded local cache mode.`,
          owner: 'PRODUCT_OWNER',
          sourceArchitectureDecisions: [dec.decisionId],
          sourceRequirements: archAffectedReqs,
        });
        derivedRisks.push(risk);
      }
    }

    for (const hdp of architecture.pendingHumanDecisions ?? []) {
      const archHdpReqs = (hdp.affectedRequirements ?? []).filter((id) => validRequirementIds.has(id));
      const risk = this.buildDeterministicRisk({
        category: 'ARCHITECTURE',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Architecture Decision: ${hdp.decisionId}`,
        description: hdp.question,
        statement: `Architecture decision ${hdp.decisionId} requires Product Owner selection: ${hdp.whyItMatters}`,
        consequences: hdp.consequences.length > 0 ? hdp.consequences : ['Architecture choice affects non-functional characteristics.'],
        mitigation: `Product Owner must choose between architecture options.`,
        contingency: `Select simplest proven pattern.`,
        owner: 'PRODUCT_OWNER',
        sourceRequirements: archHdpReqs,
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: `Architecture Decision: ${hdp.decisionId}`,
        question: hdp.question,
        whyItMatters: hdp.whyItMatters,
        affectedRisks: [risk.riskId],
        affectedRequirements: archHdpReqs,
        availableOptions: hdp.availableOptions,
        consequences: hdp.consequences,
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    // C. Derive from Business Rules
    for (const conflict of businessRules.conflicts ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'BUSINESS',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Business Rule Conflict: ${conflict.conflictId}`,
        description: `Contradiction between business rules [${conflict.affectedRules.join(', ')}].`,
        statement: `Contradiction between business rules [${conflict.affectedRules.join(', ')}]: ${conflict.whyItMatters}`,
        consequences: ['Conflicting business rules prevent consistent domain state transitions.'],
        mitigation: `Product Owner decision required to reconcile conflicting business rules.`,
        contingency: `Temporarily suspend automation for conflicting rule paths.`,
        owner: 'PRODUCT_OWNER',
        sourceBusinessRules: conflict.affectedRules,
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: `Resolve Business Rule Conflict: ${conflict.conflictId}`,
        question: `How should the conflict between rules [${conflict.affectedRules.join(', ')}] be resolved?`,
        whyItMatters: conflict.whyItMatters,
        affectedRisks: [risk.riskId],
        affectedBusinessRules: conflict.affectedRules,
        availableOptions:
          conflict.conflictingStatements && conflict.conflictingStatements.length > 0
            ? conflict.conflictingStatements
            : ['Enforce Rule 1 precedence', 'Enforce Rule 2 precedence', 'Redefine both rules'],
        consequences: ['Rule precedence changes domain logic behavior and edge-case handling.'],
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    for (const rule of businessRules.rules) {
      if (rule.category === 'AUTHORIZATION_RULE') {
        const risk = this.buildDeterministicRisk({
          category: 'SECURITY',
          probability: 'LOW',
          impact: 'CRITICAL',
          status: 'IDENTIFIED',
          response: 'MITIGATE',
          title: `Authorization Business Rule: ${rule.title}`,
          description: `Business rule ${rule.ruleId} governs authorization checks.`,
          statement: `Business rule ${rule.ruleId} governs authorization checks. Flaws could allow privilege escalation.`,
          consequences: ['Authorization flaw may expose privileged operations to standard actors.'],
          mitigation: `Enforce server-side role validation and security review.`,
          contingency: `Lock down unauthorized roles to minimal read-only permissions.`,
          owner: 'PRODUCT_OWNER',
          sourceBusinessRules: [rule.ruleId],
          sourceRequirements: rule.sourceRequirements,
        });
        derivedRisks.push(risk);
      } else if (rule.category === 'TEMPORAL_RULE') {
        const risk = this.buildDeterministicRisk({
          category: 'OPERATIONAL',
          probability: 'MEDIUM',
          impact: 'MEDIUM',
          status: 'IDENTIFIED',
          response: 'MONITOR',
          title: `Temporal Rule Constraint: ${rule.title}`,
          description: `Business rule ${rule.ruleId} imposes temporal constraints.`,
          statement: `Business rule ${rule.ruleId} enforces time constraints (${rule.statement}). Clock skew or network delays may cause violations.`,
          consequences: ['Clock desync or delayed processing triggers premature or delayed rule execution.'],
          mitigation: `Use monotonic UTC clocks and idempotent transaction windows.`,
          contingency: `Grace period for clock synchronization skew.`,
          owner: 'PRODUCT_OWNER',
          sourceBusinessRules: [rule.ruleId],
          sourceRequirements: rule.sourceRequirements,
        });
        derivedRisks.push(risk);
      }
    }

    for (const hdp of businessRules.pendingHumanDecisions ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'BUSINESS',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Business Rule Decision: ${hdp.decisionId}`,
        description: hdp.question,
        statement: `Business rule decision ${hdp.decisionId} requires Product Owner selection: ${hdp.whyItMatters}`,
        consequences: hdp.consequences.length > 0 ? hdp.consequences : ['Policy selection changes business domain validation.'],
        mitigation: `Product Owner must decide between rule alternatives.`,
        contingency: `Hold execution of dependent business rule logic.`,
        owner: 'PRODUCT_OWNER',
        sourceBusinessRules: hdp.affectedRules,
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: `Business Rule Decision: ${hdp.decisionId}`,
        question: hdp.question,
        whyItMatters: hdp.whyItMatters,
        affectedRisks: [risk.riskId],
        affectedBusinessRules: hdp.affectedRules,
        availableOptions: hdp.availableOptions,
        consequences: hdp.consequences,
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    // D. Derive from Acceptance Criteria
    for (const criterion of acceptanceCriteria.criteria) {
      if (criterion.status === 'PENDING_DECISION') {
        const risk = this.buildDeterministicRisk({
          category: 'REQUIREMENT',
          probability: 'HIGH',
          impact: 'HIGH',
          status: 'PENDING_DECISION',
          response: 'PENDING_DECISION',
          title: `Pending Acceptance Criterion: ${criterion.title}`,
          description: `Acceptance criterion ${criterion.criterionId} is pending explicit Product Owner decision.`,
          statement: `Acceptance criterion ${criterion.criterionId} is pending explicit Product Owner decision. Observable verification expectation is unconfirmed.`,
          consequences: ['Unresolved acceptance threshold blocks verification and acceptance signoff.'],
          mitigation: `Product Owner must decide acceptable threshold or verification criterion.`,
          contingency: `Hold signoff on affected requirement until threshold is decided.`,
          owner: 'PRODUCT_OWNER',
          sourceAcceptanceCriteria: [criterion.criterionId],
          sourceRequirements: (criterion.sourceRequirements ?? []).filter((id) => validRequirementIds.has(id)),
          sourceBusinessRules: (criterion.sourceBusinessRules ?? []).filter((id) => validBusinessRuleIds.has(id)),
          sourceArchitectureDecisions: (criterion.sourceArchitectureDecisions ?? []).filter((id) => validArchDecisionIds.has(id)),
        });
        derivedRisks.push(risk);

        const decision = this.buildDeterministicDecision({
          title: `Define Acceptance Threshold: ${criterion.title}`,
          question: `What is the acceptable verification criteria or threshold for ${criterion.title}?`,
          whyItMatters: `Criterion ${criterion.criterionId} cannot be verified without an agreed threshold.`,
          affectedRisks: [risk.riskId],
          affectedAcceptanceCriteria: [criterion.criterionId],
          affectedRequirements: (criterion.sourceRequirements ?? []).filter((id) => validRequirementIds.has(id)),
          affectedBusinessRules: (criterion.sourceBusinessRules ?? []).filter((id) => validBusinessRuleIds.has(id)),
          affectedArchitectureDecisions: (criterion.sourceArchitectureDecisions ?? []).filter((id) => validArchDecisionIds.has(id)),
          availableOptions: ['Specify numeric/operational threshold', 'Waive requirement for MVP', 'Revise verification method'],
          consequences: ['Acceptance threshold determines test pass/fail conditions.'],
          authority: 'PRODUCT_OWNER',
          status: 'PENDING_DECISION',
        });
        derivedDecisions.push(decision);
      }
    }

    for (const reqId of acceptanceCriteria.coverage?.uncoveredRequirements ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'REQUIREMENT',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'IDENTIFIED',
        response: 'MITIGATE',
        title: `Uncovered Requirement Acceptance: ${reqId}`,
        description: `Requirement ${reqId} has no associated acceptance criteria defined in P15-06.`,
        statement: `Requirement ${reqId} has no verified acceptance criteria defined in P15-06. Behavior cannot be verified.`,
        consequences: ['Uncovered requirement cannot be objectively tested or validated before delivery.'],
        mitigation: `Author explicit acceptance criteria to verify requirement satisfaction.`,
        contingency: `Seek Product Owner waiver or defer requirement to subsequent iteration.`,
        owner: 'PRODUCT_OWNER',
        sourceRequirements: [reqId],
      });
      derivedRisks.push(risk);
    }

    for (const ruleId of acceptanceCriteria.coverage?.uncoveredBusinessRules ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'BUSINESS',
        probability: 'MEDIUM',
        impact: 'MEDIUM',
        status: 'IDENTIFIED',
        response: 'MITIGATE',
        title: `Uncovered Business Rule: ${ruleId}`,
        description: `Business rule ${ruleId} has no associated acceptance criteria defined in P15-06.`,
        statement: `Business rule ${ruleId} has no verified acceptance criteria defined in P15-06. Policy adherence cannot be verified.`,
        consequences: ['Business rule compliance cannot be confirmed by automated acceptance tests.'],
        mitigation: `Define observable acceptance criteria for rule ${ruleId}.`,
        contingency: `Manual audit of rule enforcement.`,
        owner: 'PRODUCT_OWNER',
        sourceBusinessRules: [ruleId],
      });
      derivedRisks.push(risk);
    }

    for (const conflict of acceptanceCriteria.conflicts ?? []) {
      const confReqs = (conflict.affectedRequirements ?? []).filter((id) => validRequirementIds.has(id));
      const confBRs = (conflict.affectedRules ?? []).filter((id) => validBusinessRuleIds.has(id));
      const confCrits = (conflict.affectedCriteria ?? []).filter((id) => validAcceptanceCriteriaIds.has(id));
      const risk = this.buildDeterministicRisk({
        category: 'REQUIREMENT',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Acceptance Criteria Conflict: ${conflict.conflictId}`,
        description: `Contradiction between acceptance criteria [${confCrits.join(', ')}].`,
        statement: `Contradiction between acceptance criteria: ${conflict.whyItMatters}`,
        consequences: ['Conflicting acceptance criteria make complete test passage impossible.'],
        mitigation: `Product Owner decision required to resolve criteria contradiction.`,
        contingency: `Suspend conflicting test assertions until resolved.`,
        owner: 'PRODUCT_OWNER',
        sourceAcceptanceCriteria: confCrits,
        sourceRequirements: confReqs,
        sourceBusinessRules: confBRs,
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: `Resolve Acceptance Conflict: ${conflict.conflictId}`,
        question: `How should conflicting acceptance expectations be resolved?`,
        whyItMatters: conflict.whyItMatters,
        affectedRisks: [risk.riskId],
        affectedAcceptanceCriteria: confCrits,
        affectedRequirements: confReqs,
        affectedBusinessRules: confBRs,
        availableOptions: ['Adopt first criteria variant', 'Adopt second criteria variant', 'Merge conditions'],
        consequences: ['Deciding criteria sets the baseline for QA test passes.'],
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    for (const hdp of acceptanceCriteria.pendingHumanDecisions ?? []) {
      const acHdpCrits = (hdp.affectedCriteria ?? []).filter((id) => validAcceptanceCriteriaIds.has(id));
      const acHdpReqs = (hdp.affectedRequirements ?? []).filter((id) => validRequirementIds.has(id));
      const risk = this.buildDeterministicRisk({
        category: 'REQUIREMENT',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Acceptance Decision: ${hdp.decisionId}`,
        description: `Pending human decision from acceptance criteria: ${hdp.question}`,
        statement: `Acceptance human decision ${hdp.decisionId} requires Product Owner selection: ${hdp.whyItMatters}`,
        consequences: ['Unresolved acceptance choice blocks criteria finalization.'],
        mitigation: `Product Owner must choose between available acceptance options.`,
        contingency: `Hold test implementation for affected criteria.`,
        owner: 'PRODUCT_OWNER',
        sourceAcceptanceCriteria: acHdpCrits,
        sourceRequirements: acHdpReqs,
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: `Acceptance Decision: ${hdp.decisionId}`,
        question: hdp.question,
        whyItMatters: hdp.whyItMatters,
        affectedRisks: [risk.riskId],
        affectedAcceptanceCriteria: acHdpCrits,
        affectedRequirements: acHdpReqs,
        availableOptions: hdp.availableOptions,
        consequences: hdp.consequences,
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    // E. Derive from Discovery
    for (const dRisk of discovery.risks ?? []) {
      let cat: RiskCategory = 'UNKNOWN';
      if (dRisk.category === 'TECHNICAL') cat = 'TECHNICAL';
      else if (dRisk.category === 'PRODUCT') cat = 'PRODUCT';
      else if (dRisk.category === 'OPERATIONAL') cat = 'OPERATIONAL';
      else if (dRisk.category === 'DEPENDENCY') cat = 'DEPENDENCY';

      let impact: RiskImpact = 'MEDIUM';
      if (dRisk.impact === 'LOW') impact = 'LOW';
      else if (dRisk.impact === 'HIGH') impact = 'HIGH';
      else if (dRisk.impact === 'CRITICAL') impact = 'CRITICAL';

      const risk = this.buildDeterministicRisk({
        category: cat,
        probability: 'MEDIUM',
        impact,
        status: 'IDENTIFIED',
        response: 'MITIGATE',
        title: `Discovery Risk: ${dRisk.statement.slice(0, 50)}`,
        description: dRisk.statement,
        statement: dRisk.statement,
        consequences: ['Discovered early during project adaptive exploration.'],
        mitigation: dRisk.mitigation ?? 'Investigate and address during project initiation.',
        contingency: 'Fallback to proven operational patterns.',
        owner: 'PRODUCT_OWNER',
        sourceDiscovery: [dRisk.statement],
      });
      derivedRisks.push(risk);
    }

    for (const dDecision of discovery.decisions ?? []) {
      if (dDecision.status === 'DECIDED' || dDecision.selectedOption) {
        continue;
      }
      const risk = this.buildDeterministicRisk({
        category: 'PRODUCT',
        probability: 'HIGH',
        impact: 'HIGH',
        status: 'PENDING_DECISION',
        response: 'PENDING_DECISION',
        title: `Discovery Decision: ${dDecision.title}`,
        description: dDecision.description,
        statement: `Discovery human decision "${dDecision.title}" requires Product Owner selection.`,
        consequences: ['Unresolved discovery decision leaves product boundary uncertain.'],
        mitigation: 'Product Owner must decide between alternatives.',
        contingency: 'Adopt conservative recommendation.',
        owner: 'PRODUCT_OWNER',
        sourceDiscovery: [dDecision.title],
      });
      derivedRisks.push(risk);

      const decision = this.buildDeterministicDecision({
        title: dDecision.title,
        question: dDecision.description,
        whyItMatters: `Discovery decision for ${dDecision.title} impacts project direction.`,
        affectedRisks: [risk.riskId],
        availableOptions: dDecision.alternatives,
        consequences: ['Alternative selection establishes scope baseline.'],
        authority: 'PRODUCT_OWNER',
        status: 'PENDING_DECISION',
      });
      derivedDecisions.push(decision);
    }

    for (const constraint of discovery.sections?.technology?.platformConstraints ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'DEPLOYMENT',
        probability: 'MEDIUM',
        impact: 'HIGH',
        status: 'IDENTIFIED',
        response: 'MITIGATE',
        title: `Platform Constraint: ${constraint.slice(0, 50)}`,
        description: `Platform constraint identified: "${constraint}".`,
        statement: `Platform constraint "${constraint}" restricts execution environments.`,
        consequences: ['Non-conforming implementations fail target deployment verification.'],
        mitigation: 'Enforce platform target compliance checks in CI.',
        contingency: 'Support dual target runtime if feasible.',
        owner: 'PRODUCT_OWNER',
        sourceDiscovery: [constraint],
      });
      derivedRisks.push(risk);
    }

    for (const dep of discovery.sections?.risks?.dependencies ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'DEPENDENCY',
        probability: 'MEDIUM',
        impact: 'HIGH',
        status: 'IDENTIFIED',
        response: 'MITIGATE',
        title: `External Dependency: ${dep.slice(0, 50)}`,
        description: `External dependency identified during discovery: "${dep}".`,
        statement: `Project depends on external dependency "${dep}". Service outages or API changes may impact operations.`,
        consequences: ['External service unavailability or breaking API changes disrupt operations.'],
        mitigation: 'Implement resilient client adapters, retry policies, and health monitoring.',
        contingency: 'Offline simulation and graceful fallback mode.',
        owner: 'PRODUCT_OWNER',
        sourceDiscovery: [dep],
      });
      derivedRisks.push(risk);
    }

    for (const integration of discovery.sections?.architecture?.integrationRequirements ?? []) {
      const risk = this.buildDeterministicRisk({
        category: 'INTEGRATION',
        probability: 'MEDIUM',
        impact: 'HIGH',
        status: 'IDENTIFIED',
        response: 'MITIGATE',
        title: `Discovery Integration: ${integration.slice(0, 50)}`,
        description: `Integration requirement identified during discovery: "${integration}".`,
        statement: `Integration requirement "${integration}" requires external service communication.`,
        consequences: ['Integration contract failure or network instability blocks operations.'],
        mitigation: 'Enforce API schema contracts and automated integration test suites.',
        contingency: 'Mock service integration for local dev and degraded operating modes.',
        owner: 'PRODUCT_OWNER',
        sourceDiscovery: [integration],
      });
      derivedRisks.push(risk);
    }

    // F. Process Additional Risks and Custom Decisions from Input
    if (parsedInput.data.additionalRisks) {
      for (const customRisk of parsedInput.data.additionalRisks) {
        // Traceability validation: all referenced IDs must exist in upstream sources
        for (const reqId of customRisk.sourceRequirements) {
          if (!validRequirementIds.has(reqId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in risk '${customRisk.riskId}': requirement '${reqId}' does not exist in authoritative requirements revision ${requirements.requirementsRevision}.`,
              { riskId: customRisk.riskId, requirementId: reqId }
            );
          }
        }

        for (const ruleId of customRisk.sourceBusinessRules) {
          if (!validBusinessRuleIds.has(ruleId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in risk '${customRisk.riskId}': business rule '${ruleId}' does not exist in authoritative business rules revision ${businessRules.businessRulesRevision}.`,
              { riskId: customRisk.riskId, businessRuleId: ruleId }
            );
          }
        }

        for (const archId of customRisk.sourceArchitectureDecisions) {
          if (!validArchDecisionIds.has(archId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in risk '${customRisk.riskId}': architecture decision '${archId}' does not exist in authoritative architecture revision ${architecture.architectureRevision}.`,
              { riskId: customRisk.riskId, architectureDecisionId: archId }
            );
          }
        }

        for (const acId of customRisk.sourceAcceptanceCriteria) {
          if (!validAcceptanceCriteriaIds.has(acId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in risk '${customRisk.riskId}': acceptance criterion '${acId}' does not exist in authoritative acceptance criteria revision ${acceptanceCriteria.acceptanceCriteriaRevision}.`,
              { riskId: customRisk.riskId, acceptanceCriterionId: acId }
            );
          }
        }

        // Validate deterministic severity mapping
        const expectedSeverity = computeRiskSeverity(customRisk.probability, customRisk.impact);
        if (customRisk.severity !== expectedSeverity) {
          throw new RiskSeverityMismatchError(
            `Severity mismatch in additional risk '${customRisk.riskId}': declared '${customRisk.severity}' but computed severity for probability='${customRisk.probability}' and impact='${customRisk.impact}' is '${expectedSeverity}'.`,
            {
              riskId: customRisk.riskId,
              probability: customRisk.probability,
              impact: customRisk.impact,
              declaredSeverity: customRisk.severity,
              expectedSeverity,
            }
          );
        }

        derivedRisks.push(customRisk);
      }
    }

    if (parsedInput.data.customDecisions) {
      for (const customDecision of parsedInput.data.customDecisions) {
        if (customDecision.authority !== 'PRODUCT_OWNER' && customDecision.authority !== 'USER') {
          throw new HumanDecisionAuthorityError(
            `Invalid authority '${customDecision.authority}' for custom decision '${customDecision.decisionId}'. Authority must be PRODUCT_OWNER or USER.`,
            { decisionId: customDecision.decisionId, authority: customDecision.authority }
          );
        }

        for (const reqId of customDecision.affectedRequirements) {
          if (!validRequirementIds.has(reqId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in decision '${customDecision.decisionId}': requirement '${reqId}' does not exist in authoritative requirements.`,
              { decisionId: customDecision.decisionId, requirementId: reqId }
            );
          }
        }

        for (const ruleId of customDecision.affectedBusinessRules) {
          if (!validBusinessRuleIds.has(ruleId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in decision '${customDecision.decisionId}': business rule '${ruleId}' does not exist in authoritative business rules.`,
              { decisionId: customDecision.decisionId, businessRuleId: ruleId }
            );
          }
        }

        for (const archId of customDecision.affectedArchitectureDecisions) {
          if (!validArchDecisionIds.has(archId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in decision '${customDecision.decisionId}': architecture decision '${archId}' does not exist in authoritative architecture.`,
              { decisionId: customDecision.decisionId, architectureDecisionId: archId }
            );
          }
        }

        for (const acId of customDecision.affectedAcceptanceCriteria) {
          if (!validAcceptanceCriteriaIds.has(acId)) {
            throw new RiskTraceabilityError(
              `Invalid traceability reference in decision '${customDecision.decisionId}': acceptance criterion '${acId}' does not exist in authoritative acceptance criteria.`,
              { decisionId: customDecision.decisionId, acceptanceCriterionId: acId }
            );
          }
        }

        derivedDecisions.push(customDecision);
      }
    }

    // G. Deduplicate risks and decision points deterministically
    const riskMap = new Map<string, ProjectRisk>();
    for (const r of derivedRisks) {
      if (!riskMap.has(r.riskId)) {
        riskMap.set(r.riskId, r);
      }
    }
    const finalRisks = Array.from(riskMap.values()).sort((a, b) => a.riskId.localeCompare(b.riskId));

    const decisionMap = new Map<string, HumanDecisionPoint>();
    for (const d of derivedDecisions) {
      if (!decisionMap.has(d.decisionId)) {
        decisionMap.set(d.decisionId, d);
      }
    }
    const finalDecisions = Array.from(decisionMap.values()).sort((a, b) =>
      a.decisionId.localeCompare(b.decisionId)
    );

    // Validate that decision points' affectedRisks exist
    const riskIdSet = new Set(finalRisks.map((r) => r.riskId));
    for (const d of finalDecisions) {
      for (const affectedRiskId of d.affectedRisks) {
        if (!riskIdSet.has(affectedRiskId)) {
          throw new RiskTraceabilityError(
            `Decision '${d.decisionId}' references affectedRisk '${affectedRiskId}' which does not exist in project risks.`,
            { decisionId: d.decisionId, affectedRiskId }
          );
        }
      }
    }

    // H. Compute Coverage
    const allRequirementIds = requirements.functionalRequirements.map((r) => r.requirementId);
    const reqWithRisks = new Set<string>();
    for (const r of finalRisks) {
      for (const reqId of r.sourceRequirements) {
        reqWithRisks.add(reqId);
      }
    }
    const requirementsWithRisks = allRequirementIds
      .filter((id) => reqWithRisks.has(id))
      .sort();
    const requirementsWithoutRisks = allRequirementIds
      .filter((id) => !reqWithRisks.has(id))
      .sort();

    const allArchDecisionIds = architecture.decisions.map((d) => d.decisionId);
    const archWithRisks = new Set<string>();
    for (const r of finalRisks) {
      for (const archId of r.sourceArchitectureDecisions) {
        archWithRisks.add(archId);
      }
    }
    const architectureDecisionsWithRisks = allArchDecisionIds
      .filter((id) => archWithRisks.has(id))
      .sort();
    const architectureDecisionsWithoutRisks = allArchDecisionIds
      .filter((id) => !archWithRisks.has(id))
      .sort();

    const allAcIds = acceptanceCriteria.criteria.map((c) => c.criterionId);
    const acWithRisks = new Set<string>();
    for (const r of finalRisks) {
      for (const acId of r.sourceAcceptanceCriteria) {
        acWithRisks.add(acId);
      }
    }
    const acceptanceCriteriaWithRisks = allAcIds
      .filter((id) => acWithRisks.has(id))
      .sort();
    const acceptanceCriteriaWithoutRisks = allAcIds
      .filter((id) => !acWithRisks.has(id))
      .sort();

    const allRuleIds = businessRules.rules.map((r) => r.ruleId);
    const rulesWithRisks = new Set<string>();
    for (const r of finalRisks) {
      for (const ruleId of r.sourceBusinessRules) {
        rulesWithRisks.add(ruleId);
      }
    }
    const businessRulesWithRisks = allRuleIds
      .filter((id) => rulesWithRisks.has(id))
      .sort();
    const businessRulesWithoutRisks = allRuleIds
      .filter((id) => !rulesWithRisks.has(id))
      .sort();

    const criticalRisks = finalRisks.filter((r) => r.severity === 'CRITICAL').length;
    const highRisks = finalRisks.filter((r) => r.severity === 'HIGH').length;
    const mediumRisks = finalRisks.filter((r) => r.severity === 'MEDIUM').length;
    const lowRisks = finalRisks.filter((r) => r.severity === 'LOW').length;
    const pendingDecisionRisks = finalRisks.filter(
      (r) => r.status === 'PENDING_DECISION' || r.response === 'PENDING_DECISION'
    ).length;

    const coverage: RiskCoverage = {
      totalRisks: finalRisks.length,
      criticalRisks,
      highRisks,
      mediumRisks,
      lowRisks,
      pendingDecisionRisks,
      requirementsWithRisks,
      requirementsWithoutRisks,
      architectureDecisionsWithRisks,
      architectureDecisionsWithoutRisks,
      acceptanceCriteriaWithRisks,
      acceptanceCriteriaWithoutRisks,
      businessRulesWithRisks,
      businessRulesWithoutRisks,
    };

    const pendingHumanDecisionPoints = finalDecisions.filter(
      (d) => d.status === 'PENDING_DECISION'
    ).length;
    const resolvedHumanDecisionPoints = finalDecisions.filter(
      (d) => d.status === 'RESOLVED'
    ).length;

    const humanDecisionCoverage: HumanDecisionCoverage = {
      totalHumanDecisionPoints: finalDecisions.length,
      pendingHumanDecisionPoints,
      resolvedHumanDecisionPoints,
    };

    // I. Allocate Revision Number and Persist
    const latestRevisionNum = await this.riskStore.getLatestRevisionNumber(safeProjectId);
    const newRevisionNumber = latestRevisionNum + 1;

    const artifactWithoutFingerprint = {
      projectId,
      riskRevision: newRevisionNumber,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceArchitectureRevision: architecture.architectureRevision,
      sourceArchitectureFingerprint: architecture.fingerprint,
      sourceBusinessRulesRevision: businessRules.businessRulesRevision,
      sourceBusinessRulesFingerprint: businessRules.fingerprint,
      sourceAcceptanceCriteriaRevision: acceptanceCriteria.acceptanceCriteriaRevision,
      sourceAcceptanceCriteriaFingerprint: acceptanceCriteria.fingerprint,
      risks: finalRisks,
      humanDecisionPoints: finalDecisions,
      coverage,
      humanDecisionCoverage,
    };

    const fingerprint = computeRiskFingerprint(artifactWithoutFingerprint);

    const revision: ProjectRiskRevision = {
      ...artifactWithoutFingerprint,
      isStale: false,
      createdAt: new Date().toISOString(),
      fingerprint,
    };

    await this.riskStore.saveRevision(revision);
    return revision;
  }

  /**
   * Verifies the authoritative integrity of a loaded artifact against upstream sources.
   */
  async verifyAuthoritativeIntegrity(artifact: ProjectRiskRevision): Promise<void> {
    const safeProjectId = this.riskStore.sanitizeProjectId(artifact.projectId);

    // 1. Load upstream sources
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      artifact.sourceRequirementsRevision
    );
    if (!requirements) {
      throw new RiskForgedFingerprintError(
        `Authoritative requirements revision ${artifact.sourceRequirementsRevision} for risk revision ${artifact.riskRevision} not found.`,
        { projectId: artifact.projectId, revision: artifact.riskRevision }
      );
    }
    if (requirements.fingerprint !== artifact.sourceRequirementsFingerprint) {
      throw new RiskForgedFingerprintError(
        `Upstream requirements fingerprint mismatch in persisted risk record: recorded '${artifact.sourceRequirementsFingerprint}' but authoritative requirements fingerprint is '${requirements.fingerprint}'.`,
        { recorded: artifact.sourceRequirementsFingerprint, authoritative: requirements.fingerprint }
      );
    }

    const architecture = await this.architectureStore.loadRevision(
      safeProjectId,
      artifact.sourceArchitectureRevision
    );
    if (!architecture) {
      throw new RiskForgedFingerprintError(
        `Authoritative architecture revision ${artifact.sourceArchitectureRevision} not found.`,
        { projectId: artifact.projectId }
      );
    }
    if (architecture.fingerprint !== artifact.sourceArchitectureFingerprint) {
      throw new RiskForgedFingerprintError(
        `Upstream architecture fingerprint mismatch in persisted risk record: recorded '${artifact.sourceArchitectureFingerprint}' but authoritative architecture fingerprint is '${architecture.fingerprint}'.`,
        { recorded: artifact.sourceArchitectureFingerprint, authoritative: architecture.fingerprint }
      );
    }

    const businessRules = await this.businessRulesStore.loadRevision(
      safeProjectId,
      artifact.sourceBusinessRulesRevision
    );
    if (!businessRules) {
      throw new RiskForgedFingerprintError(
        `Authoritative business rules revision ${artifact.sourceBusinessRulesRevision} not found.`,
        { projectId: artifact.projectId }
      );
    }
    if (businessRules.fingerprint !== artifact.sourceBusinessRulesFingerprint) {
      throw new RiskForgedFingerprintError(
        `Upstream business rules fingerprint mismatch in persisted risk record: recorded '${artifact.sourceBusinessRulesFingerprint}' but authoritative business rules fingerprint is '${businessRules.fingerprint}'.`,
        { recorded: artifact.sourceBusinessRulesFingerprint, authoritative: businessRules.fingerprint }
      );
    }

    const acceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(
      safeProjectId,
      artifact.sourceAcceptanceCriteriaRevision
    );
    if (!acceptanceCriteria) {
      throw new RiskForgedFingerprintError(
        `Authoritative acceptance criteria revision ${artifact.sourceAcceptanceCriteriaRevision} not found.`,
        { projectId: artifact.projectId }
      );
    }
    if (acceptanceCriteria.fingerprint !== artifact.sourceAcceptanceCriteriaFingerprint) {
      throw new RiskForgedFingerprintError(
        `Upstream acceptance criteria fingerprint mismatch in persisted risk record: recorded '${artifact.sourceAcceptanceCriteriaFingerprint}' but authoritative acceptance criteria fingerprint is '${acceptanceCriteria.fingerprint}'.`,
        { recorded: artifact.sourceAcceptanceCriteriaFingerprint, authoritative: acceptanceCriteria.fingerprint }
      );
    }

    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      artifact.sourceDiscoveryRevision
    );
    if (!discovery) {
      throw new RiskForgedFingerprintError(
        `Authoritative discovery revision ${artifact.sourceDiscoveryRevision} not found.`,
        { projectId: artifact.projectId }
      );
    }
    if (discovery.fingerprint !== artifact.sourceDiscoveryFingerprint) {
      throw new RiskForgedFingerprintError(
        `Upstream discovery fingerprint mismatch in persisted risk record: recorded '${artifact.sourceDiscoveryFingerprint}' but authoritative discovery fingerprint is '${discovery.fingerprint}'.`,
        { recorded: artifact.sourceDiscoveryFingerprint, authoritative: discovery.fingerprint }
      );
    }

    // 2. Validate all traceability references exist in authoritative sources
    const validRequirementIds = new Set(requirements.functionalRequirements.map((r) => r.requirementId));
    const validArchDecisionIds = new Set(architecture.decisions.map((d) => d.decisionId));
    const validBusinessRuleIds = new Set(businessRules.rules.map((r) => r.ruleId));
    const validAcceptanceCriteriaIds = new Set(acceptanceCriteria.criteria.map((c) => c.criterionId));

    for (const risk of artifact.risks) {
      for (const reqId of risk.sourceRequirements) {
        if (!validRequirementIds.has(reqId)) {
          throw new RiskForgedFingerprintError(
            `Persisted risk '${risk.riskId}' references nonexistent requirement '${reqId}'.`,
            { riskId: risk.riskId, requirementId: reqId }
          );
        }
      }

      for (const ruleId of risk.sourceBusinessRules) {
        if (!validBusinessRuleIds.has(ruleId)) {
          throw new RiskForgedFingerprintError(
            `Persisted risk '${risk.riskId}' references nonexistent business rule '${ruleId}'.`,
            { riskId: risk.riskId, businessRuleId: ruleId }
          );
        }
      }

      for (const archId of risk.sourceArchitectureDecisions) {
        if (!validArchDecisionIds.has(archId)) {
          throw new RiskForgedFingerprintError(
            `Persisted risk '${risk.riskId}' references nonexistent architecture decision '${archId}'.`,
            { riskId: risk.riskId, architectureDecisionId: archId }
          );
        }
      }

      for (const acId of risk.sourceAcceptanceCriteria) {
        if (!validAcceptanceCriteriaIds.has(acId)) {
          throw new RiskForgedFingerprintError(
            `Persisted risk '${risk.riskId}' references nonexistent acceptance criterion '${acId}'.`,
            { riskId: risk.riskId, acceptanceCriterionId: acId }
          );
        }
      }

      // Check deterministic severity
      const expectedSeverity = computeRiskSeverity(risk.probability, risk.impact);
      if (risk.severity !== expectedSeverity) {
        throw new RiskForgedFingerprintError(
          `Persisted risk '${risk.riskId}' severity '${risk.severity}' does not match computed deterministic severity '${expectedSeverity}'.`,
          { riskId: risk.riskId, declaredSeverity: risk.severity, expectedSeverity }
        );
      }
    }

    for (const hdp of artifact.humanDecisionPoints) {
      if (hdp.authority !== 'PRODUCT_OWNER' && hdp.authority !== 'USER') {
        throw new RiskForgedFingerprintError(
          `Persisted decision point '${hdp.decisionId}' has unauthorized authority '${hdp.authority}'.`,
          { decisionId: hdp.decisionId, authority: hdp.authority }
        );
      }

      for (const reqId of hdp.affectedRequirements) {
        if (!validRequirementIds.has(reqId)) {
          throw new RiskForgedFingerprintError(
            `Persisted decision point '${hdp.decisionId}' references nonexistent requirement '${reqId}'.`,
            { decisionId: hdp.decisionId, requirementId: reqId }
          );
        }
      }

      for (const ruleId of hdp.affectedBusinessRules) {
        if (!validBusinessRuleIds.has(ruleId)) {
          throw new RiskForgedFingerprintError(
            `Persisted decision point '${hdp.decisionId}' references nonexistent business rule '${ruleId}'.`,
            { decisionId: hdp.decisionId, businessRuleId: ruleId }
          );
        }
      }

      for (const archId of hdp.affectedArchitectureDecisions) {
        if (!validArchDecisionIds.has(archId)) {
          throw new RiskForgedFingerprintError(
            `Persisted decision point '${hdp.decisionId}' references nonexistent architecture decision '${archId}'.`,
            { decisionId: hdp.decisionId, architectureDecisionId: archId }
          );
        }
      }

      for (const acId of hdp.affectedAcceptanceCriteria) {
        if (!validAcceptanceCriteriaIds.has(acId)) {
          throw new RiskForgedFingerprintError(
            `Persisted decision point '${hdp.decisionId}' references nonexistent acceptance criterion '${acId}'.`,
            { decisionId: hdp.decisionId, acceptanceCriterionId: acId }
          );
        }
      }
    }

    // 3. Check canonical fingerprint
    const canonicalFingerprint = computeRiskFingerprint(artifact);
    if (artifact.fingerprint !== canonicalFingerprint) {
      throw new RiskForgedFingerprintError(
        `Persisted fingerprint '${artifact.fingerprint}' does not match recomputed canonical fingerprint '${canonicalFingerprint}'.`,
        { declaredFingerprint: artifact.fingerprint, canonicalFingerprint }
      );
    }
  }

  /**
   * Retrieves latest risk revision for a project.
   */
  async getLatest(projectId: string): Promise<ProjectRiskRevision | null> {
    const result = await this.riskStore.loadRevision(projectId);
    if (!result) return null;
    await this.verifyAuthoritativeIntegrity(result);
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Retrieves specific risk revision for a project.
   */
  async getRevision(
    projectId: string,
    revision: number
  ): Promise<ProjectRiskRevision | null> {
    const result = await this.riskStore.loadRevision(projectId, revision);
    if (!result) return null;
    await this.verifyAuthoritativeIntegrity(result);
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Checks whether a risk revision is stale relative to latest requirements, architecture, business rules, acceptance criteria, or discovery.
   */
  async isRevisionStale(revision: ProjectRiskRevision): Promise<boolean> {
    const safeProjectId = this.riskStore.sanitizeProjectId(revision.projectId);

    // Check requirements
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (!latestRequirements) return true;
    if (latestRequirements.requirementsRevision !== revision.sourceRequirementsRevision) return true;
    if (latestRequirements.fingerprint !== revision.sourceRequirementsFingerprint) return true;

    // Check architecture
    const latestArchitecture = await this.architectureStore.loadRevision(safeProjectId);
    if (!latestArchitecture) return true;
    if (latestArchitecture.architectureRevision !== revision.sourceArchitectureRevision) return true;
    if (latestArchitecture.fingerprint !== revision.sourceArchitectureFingerprint) return true;

    // Check business rules
    const latestBusinessRules = await this.businessRulesStore.loadRevision(safeProjectId);
    if (!latestBusinessRules) return true;
    if (latestBusinessRules.businessRulesRevision !== revision.sourceBusinessRulesRevision) return true;
    if (latestBusinessRules.fingerprint !== revision.sourceBusinessRulesFingerprint) return true;

    // Check acceptance criteria
    const latestAcceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(safeProjectId);
    if (!latestAcceptanceCriteria) return true;
    if (latestAcceptanceCriteria.acceptanceCriteriaRevision !== revision.sourceAcceptanceCriteriaRevision) return true;
    if (latestAcceptanceCriteria.fingerprint !== revision.sourceAcceptanceCriteriaFingerprint) return true;

    // Check discovery
    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (!latestDiscovery) return true;
    if (latestDiscovery.discoveryRevision !== revision.sourceDiscoveryRevision) return true;
    if (latestDiscovery.fingerprint !== revision.sourceDiscoveryFingerprint) return true;

    return false;
  }
}
