/**
 * Project Specification Projection Engine
 *
 * Deterministically projects existing authoritative project-initiation stores:
 * 1. Adaptive Discovery (P15-01)
 * 2. Requirements / Scope (P15-03)
 * 3. Architecture / Technology (P15-04)
 * 4. Business Rules (P15-05)
 * 5. Acceptance Criteria (P15-06)
 * 6. Risks & Human Decision Points (P15-07)
 *
 * into a unified, human-readable PROJECT_SPEC.md document and revisioned projection record.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. PROJECT_SPEC.md is strictly a projection, NEVER a second source of truth.
 * 2. If PROJECT_SPEC.md is deleted, authoritative state remains intact and reconstructible.
 * 3. Strict determinism: identical upstream source revisions produce identical semantic projections.
 * 4. Exact source revision and fingerprint binding with explicit staleness detection.
 * 5. Multi-layer integrity: rejects modified content, forged self-consistent hashes, and cross-project contamination.
 * 6. Human decision safety: preserves unresolved decisions exactly; never silently chooses or resolves them.
 * 7. Boundary: does NOT approve project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 */

import * as path from 'node:path';
import type { HistoryManager } from '../storage/history-manager.js';
import type { SpecStore } from '../storage/spec-store.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import { RequirementsScopeStore } from './requirements-scope-store.js';
import { ArchitectureTechnologyStore } from './architecture-technology-store.js';
import { BusinessRulesStore } from './business-rules-store.js';
import { AcceptanceCriteriaStore } from './acceptance-criteria-store.js';
import { RiskHumanDecisionStore } from './risk-human-decision-store.js';
import { ProjectSpecStore } from './project-spec-store.js';
import type { ProjectDiscoveryRevision } from './adaptive-discovery-types.js';
import type { ProjectRequirementsScopeRevision } from './requirements-scope-types.js';
import type { ProjectArchitectureRevision } from './architecture-technology-types.js';
import type { ProjectBusinessRulesRevision } from './business-rules-types.js';
import type { ProjectAcceptanceCriteriaRevision } from './acceptance-criteria-types.js';
import type { ProjectRiskRevision } from './risk-human-decision-types.js';
import {
  ProjectSpecInputZodSchema,
  computeProjectSpecSemanticFingerprint,
  type ProjectSpecInput,
  type ProjectSpecProjection,
  type ProjectSpecSourceBindings,
  type ProjectSpecContent,
  type ProjectSpecStaleReport,
} from './project-spec-types.js';
import {
  ProjectSpecValidationError,
  ProjectSpecRevisionNotFoundError,
  ProjectSpecProjectBindingMismatchError,
  ProjectSpecForgedFingerprintError,
  ProjectSpecTamperingError,
  ProjectSpecPathTraversalError,
} from './project-spec-errors.js';

export interface ProjectSpecEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly architectureStore?: ArchitectureTechnologyStore;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly riskStore?: RiskHumanDecisionStore;
  readonly specStore?: SpecStore;
  readonly specProjectionStore?: ProjectSpecStore;
  readonly historyManager?: HistoryManager;
}

export class ProjectSpecEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly requirementsStore: RequirementsScopeStore;
  readonly architectureStore: ArchitectureTechnologyStore;
  readonly businessRulesStore: BusinessRulesStore;
  readonly acceptanceCriteriaStore: AcceptanceCriteriaStore;
  readonly riskStore: RiskHumanDecisionStore;
  readonly specProjectionStore: ProjectSpecStore;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;

  constructor(options?: ProjectSpecEngineOptions) {
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

    this.specProjectionStore =
      options?.specProjectionStore ??
      new ProjectSpecStore({
        baseDir: this.baseDir,
        workspaceRoot: this.workspaceRoot,
        historyManager: this.historyManager,
      });
  }

  /**
   * Sanitizes projectId preventing path traversal.
   */
  sanitizeProjectId(projectId: string): string {
    return this.specProjectionStore.sanitizeProjectId(projectId);
  }

  /**
   * Resolves and validates all 6 upstream authoritative sources for projection.
   */
  private async resolveUpstreamSources(
    projectId: string,
    input: ProjectSpecInput
  ): Promise<{
    discovery: ProjectDiscoveryRevision;
    requirements: ProjectRequirementsScopeRevision;
    architecture: ProjectArchitectureRevision;
    businessRules: ProjectBusinessRulesRevision;
    acceptanceCriteria: ProjectAcceptanceCriteriaRevision;
    risks: ProjectRiskRevision;
  }> {
    const safeProjectId = this.sanitizeProjectId(projectId);

    // 1. Authoritative Requirements / Scope (P15-03)
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      input.requirementsRevision
    );
    if (!requirements) {
      throw new ProjectSpecRevisionNotFoundError(
        `No requirements revision found for project '${projectId}'${
          input.requirementsRevision !== undefined ? ` at revision ${input.requirementsRevision}` : ''
        }. Requirements & Scope must be defined before PROJECT_SPEC projection can be generated.`,
        { projectId, requestedRevision: input.requirementsRevision }
      );
    }
    if (requirements.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: requirements belong to '${requirements.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, requirementsProjectId: requirements.projectId }
      );
    }
    if (
      input.expectedRequirementsFingerprint &&
      requirements.fingerprint !== input.expectedRequirementsFingerprint
    ) {
      throw new ProjectSpecForgedFingerprintError(
        `Requirements fingerprint mismatch for project '${projectId}': expected '${input.expectedRequirementsFingerprint}' but got '${requirements.fingerprint}'.`,
        { expected: input.expectedRequirementsFingerprint, actual: requirements.fingerprint }
      );
    }

    // 2. Authoritative Architecture / Technology (P15-04)
    const architecture = await this.architectureStore.loadRevision(
      safeProjectId,
      input.architectureRevision
    );
    if (!architecture) {
      throw new ProjectSpecRevisionNotFoundError(
        `No architecture revision found for project '${projectId}'${
          input.architectureRevision !== undefined ? ` at revision ${input.architectureRevision}` : ''
        }. Architecture & Technology must be defined before PROJECT_SPEC projection can be generated.`,
        { projectId, requestedRevision: input.architectureRevision }
      );
    }
    if (architecture.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: architecture belongs to '${architecture.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, architectureProjectId: architecture.projectId }
      );
    }
    if (
      input.expectedArchitectureFingerprint &&
      architecture.fingerprint !== input.expectedArchitectureFingerprint
    ) {
      throw new ProjectSpecForgedFingerprintError(
        `Architecture fingerprint mismatch for project '${projectId}': expected '${input.expectedArchitectureFingerprint}' but got '${architecture.fingerprint}'.`,
        { expected: input.expectedArchitectureFingerprint, actual: architecture.fingerprint }
      );
    }

    // 3. Authoritative Business Rules (P15-05)
    const businessRules = await this.businessRulesStore.loadRevision(
      safeProjectId,
      input.businessRulesRevision
    );
    if (!businessRules) {
      throw new ProjectSpecRevisionNotFoundError(
        `No business rules revision found for project '${projectId}'${
          input.businessRulesRevision !== undefined ? ` at revision ${input.businessRulesRevision}` : ''
        }. Business Rules must be defined before PROJECT_SPEC projection can be generated.`,
        { projectId, requestedRevision: input.businessRulesRevision }
      );
    }
    if (businessRules.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: business rules belong to '${businessRules.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, businessRulesProjectId: businessRules.projectId }
      );
    }
    if (
      input.expectedBusinessRulesFingerprint &&
      businessRules.fingerprint !== input.expectedBusinessRulesFingerprint
    ) {
      throw new ProjectSpecForgedFingerprintError(
        `Business rules fingerprint mismatch for project '${projectId}': expected '${input.expectedBusinessRulesFingerprint}' but got '${businessRules.fingerprint}'.`,
        { expected: input.expectedBusinessRulesFingerprint, actual: businessRules.fingerprint }
      );
    }

    // 4. Authoritative Acceptance Criteria (P15-06)
    const acceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(
      safeProjectId,
      input.acceptanceCriteriaRevision
    );
    if (!acceptanceCriteria) {
      throw new ProjectSpecRevisionNotFoundError(
        `No acceptance criteria revision found for project '${projectId}'${
          input.acceptanceCriteriaRevision !== undefined ? ` at revision ${input.acceptanceCriteriaRevision}` : ''
        }. Acceptance Criteria must be defined before PROJECT_SPEC projection can be generated.`,
        { projectId, requestedRevision: input.acceptanceCriteriaRevision }
      );
    }
    if (acceptanceCriteria.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: acceptance criteria belong to '${acceptanceCriteria.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, acceptanceCriteriaProjectId: acceptanceCriteria.projectId }
      );
    }
    if (
      input.expectedAcceptanceCriteriaFingerprint &&
      acceptanceCriteria.fingerprint !== input.expectedAcceptanceCriteriaFingerprint
    ) {
      throw new ProjectSpecForgedFingerprintError(
        `Acceptance criteria fingerprint mismatch for project '${projectId}': expected '${input.expectedAcceptanceCriteriaFingerprint}' but got '${acceptanceCriteria.fingerprint}'.`,
        { expected: input.expectedAcceptanceCriteriaFingerprint, actual: acceptanceCriteria.fingerprint }
      );
    }

    // 5. Authoritative Risks & Human Decision Points (P15-07)
    const risks = await this.riskStore.loadRevision(safeProjectId, input.riskRevision);
    if (!risks) {
      throw new ProjectSpecRevisionNotFoundError(
        `No risk revision found for project '${projectId}'${
          input.riskRevision !== undefined ? ` at revision ${input.riskRevision}` : ''
        }. Risks & Human Decision Points must be defined before PROJECT_SPEC projection can be generated.`,
        { projectId, requestedRevision: input.riskRevision }
      );
    }
    if (risks.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: risks belong to '${risks.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, risksProjectId: risks.projectId }
      );
    }
    if (input.expectedRiskFingerprint && risks.fingerprint !== input.expectedRiskFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Risk fingerprint mismatch for project '${projectId}': expected '${input.expectedRiskFingerprint}' but got '${risks.fingerprint}'.`,
        { expected: input.expectedRiskFingerprint, actual: risks.fingerprint }
      );
    }

    // 6. Authoritative Adaptive Discovery (P15-01)
    const discoveryRevisionNumber =
      input.discoveryRevision ?? requirements.sourceDiscoveryRevision;
    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      discoveryRevisionNumber
    );
    if (!discovery) {
      throw new ProjectSpecRevisionNotFoundError(
        `No discovery revision found for project '${projectId}' at revision ${discoveryRevisionNumber}.`,
        { projectId, requestedRevision: discoveryRevisionNumber }
      );
    }
    if (discovery.projectId !== projectId) {
      throw new ProjectSpecProjectBindingMismatchError(
        `Cross-project mismatch: discovery belongs to '${discovery.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, discoveryProjectId: discovery.projectId }
      );
    }
    if (
      input.expectedDiscoveryFingerprint &&
      discovery.fingerprint !== input.expectedDiscoveryFingerprint
    ) {
      throw new ProjectSpecForgedFingerprintError(
        `Discovery fingerprint mismatch for project '${projectId}': expected '${input.expectedDiscoveryFingerprint}' but got '${discovery.fingerprint}'.`,
        { expected: input.expectedDiscoveryFingerprint, actual: discovery.fingerprint }
      );
    }

    return {
      discovery,
      requirements,
      architecture,
      businessRules,
      acceptanceCriteria,
      risks,
    };
  }

  /**
   * Deterministically builds canonical ProjectSpecContent from upstream source artifacts.
   */
  private buildProjectSpecContent(sources: {
    discovery: ProjectDiscoveryRevision;
    requirements: ProjectRequirementsScopeRevision;
    architecture: ProjectArchitectureRevision;
    businessRules: ProjectBusinessRulesRevision;
    acceptanceCriteria: ProjectAcceptanceCriteriaRevision;
    risks: ProjectRiskRevision;
  }): ProjectSpecContent {
    const { discovery, requirements, architecture, businessRules, acceptanceCriteria, risks } =
      sources;

    // 1. Identity & Purpose
    const identity = {
      name: discovery.sections.projectIdentity.name,
      purpose: discovery.sections.projectIdentity.purpose,
      desiredOutcome: discovery.sections.projectIdentity.desiredOutcome,
    };

    const purpose = {
      purpose: requirements.purpose.purpose,
      problemStatement: requirements.purpose.problemStatement,
      desiredOutcome: requirements.purpose.desiredOutcome,
      measurableObjective: requirements.purpose.measurableObjective,
    };

    // 2. Target Users (sorted)
    const targetUsers = {
      primaryUsers: [...requirements.targetUsers.primaryUsers].sort(),
      secondaryUsers: [...requirements.targetUsers.secondaryUsers].sort(),
      systemActors: [...requirements.targetUsers.systemActors].sort(),
      externalActors: [...requirements.targetUsers.externalActors].sort(),
    };

    // 3. Scope Boundaries (sorted)
    const scope = {
      inScope: {
        capabilities: [...requirements.inScope.capabilities].sort(),
        workflows: [...requirements.inScope.workflows].sort(),
        platforms: [...requirements.inScope.platforms].sort(),
        integrations: [...requirements.inScope.integrations].sort(),
      },
      outOfScope: {
        capabilities: [...requirements.outOfScope.capabilities].sort(),
        workflows: [...requirements.outOfScope.workflows].sort(),
        platforms: [...requirements.outOfScope.platforms].sort(),
        integrations: [...requirements.outOfScope.integrations].sort(),
      },
      undecidedScope: [...requirements.undecidedScope]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => ({
          id: item.id,
          topic: item.topic,
          description: item.description,
          availableOptions: [...item.availableOptions].sort(),
          status: 'PENDING_DECISION' as const,
          whyItMatters: item.whyItMatters,
          affectedAreas: [...item.affectedAreas].sort(),
        })),
    };

    // 4. Functional Requirements (sorted by requirementId)
    const functionalRequirements = [...requirements.functionalRequirements]
      .sort((a, b) => a.requirementId.localeCompare(b.requirementId))
      .map((req) => ({
        requirementId: req.requirementId,
        title: req.title,
        description: req.description,
        priority: req.priority,
        source: req.source,
        status: req.status,
        affectedScope: [...req.affectedScope].sort(),
        dependencies: [...req.dependencies].sort(),
        businessRules: [...req.businessRules].sort(),
      }));

    // 5. Non-Functional Requirements (sorted)
    const nonFunctionalRequirements = {
      performance: [...requirements.nonFunctionalRequirements.performance].sort(),
      reliability: [...requirements.nonFunctionalRequirements.reliability].sort(),
      security: [...requirements.nonFunctionalRequirements.security].sort(),
      availability: [...requirements.nonFunctionalRequirements.availability].sort(),
      scalability: [...requirements.nonFunctionalRequirements.scalability].sort(),
      usability: [...requirements.nonFunctionalRequirements.usability].sort(),
      maintainability: [...requirements.nonFunctionalRequirements.maintainability].sort(),
      operationalConstraints: [
        ...requirements.nonFunctionalRequirements.operationalConstraints,
      ].sort(),
    };

    // 6. Constraints (sorted)
    const constraints = {
      technologyConstraints: [...requirements.constraints.technologyConstraints].sort(),
      platformConstraints: [...requirements.constraints.platformConstraints].sort(),
      compatibilityConstraints: [...requirements.constraints.compatibilityConstraints].sort(),
      legalComplianceConstraints: [
        ...requirements.constraints.legalComplianceConstraints,
      ].sort(),
      operationalConstraints: [...requirements.constraints.operationalConstraints].sort(),
      budgetResourceConstraints: [
        ...requirements.constraints.budgetResourceConstraints,
      ].sort(),
    };

    // 7. Assumptions (sorted by id)
    const assumptions = [...requirements.assumptions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => ({
        id: a.id,
        statement: a.statement,
        rationale: a.rationale,
        validated: a.validated,
        affectedRequirements: [...a.affectedRequirements].sort(),
      }));

    // 8. Open Questions (sorted by questionId)
    const openQuestions = [...requirements.openQuestions]
      .sort((a, b) => a.questionId.localeCompare(b.questionId))
      .map((q) => ({
        questionId: q.questionId,
        question: q.question,
        whyItMatters: q.whyItMatters,
        affectedAreas: [...q.affectedAreas].sort(),
        classification: q.classification,
        availableOptions: [...q.availableOptions].sort(),
        status: q.status,
      }));

    // 9. Architecture Sections
    const architecturalStyle = {
      style: architecture.architecturalStyle.style,
      pattern: architecture.architecturalStyle.pattern,
      applicationTopology: architecture.architecturalStyle.applicationTopology,
      subsystemBoundaries: [...architecture.architecturalStyle.subsystemBoundaries].sort(),
      serviceModuleBoundaries: [
        ...architecture.architecturalStyle.serviceModuleBoundaries,
      ].sort(),
      clientServerBoundaries: [
        ...architecture.architecturalStyle.clientServerBoundaries,
      ].sort(),
      deploymentTopology: architecture.architecturalStyle.deploymentTopology,
      communicationModel: architecture.architecturalStyle.communicationModel,
      status: architecture.architecturalStyle.status,
    };

    const systemComponents = [...architecture.systemComponents]
      .sort((a, b) => a.componentId.localeCompare(b.componentId))
      .map((c) => ({
        componentId: c.componentId,
        name: c.name,
        responsibility: c.responsibility,
        dependencies: [...c.dependencies].sort(),
        exposedInterfaces: [...c.exposedInterfaces].sort(),
        owningBoundary: c.owningBoundary,
        sourceReferences: [...c.sourceReferences].sort(),
        status: c.status,
      }));

    const dataArchitecture = {
      persistenceStrategy: architecture.dataArchitecture.persistenceStrategy,
      primaryDataStore: architecture.dataArchitecture.primaryDataStore,
      secondaryStores: [...architecture.dataArchitecture.secondaryStores].sort(),
      caching: [...architecture.dataArchitecture.caching].sort(),
      fileObjectStorage: [...architecture.dataArchitecture.fileObjectStorage].sort(),
      dataOwnership: [...architecture.dataArchitecture.dataOwnership].sort(),
      dataFlow: [...architecture.dataArchitecture.dataFlow].sort(),
      retentionRequirements: [...architecture.dataArchitecture.retentionRequirements].sort(),
      consistencyRequirements: [
        ...architecture.dataArchitecture.consistencyRequirements,
      ].sort(),
      status: architecture.dataArchitecture.status,
    };

    const apiCommunicationArchitecture = {
      httpRest: architecture.apiCommunicationArchitecture.httpRest,
      graphQl: architecture.apiCommunicationArchitecture.graphQl,
      webSocket: architecture.apiCommunicationArchitecture.webSocket,
      messageQueues: [...architecture.apiCommunicationArchitecture.messageQueues].sort(),
      eventBus: [...architecture.apiCommunicationArchitecture.eventBus].sort(),
      rpc: [...architecture.apiCommunicationArchitecture.rpc].sort(),
      ipc: [...architecture.apiCommunicationArchitecture.ipc].sort(),
      internalApis: [...architecture.apiCommunicationArchitecture.internalApis].sort(),
      externalApis: [...architecture.apiCommunicationArchitecture.externalApis].sort(),
      status: architecture.apiCommunicationArchitecture.status,
    };

    const platformEnvironment = {
      targetOs: [...architecture.platformEnvironment.targetOs].sort(),
      targetDevices: [...architecture.platformEnvironment.targetDevices].sort(),
      browserRequirements: [...architecture.platformEnvironment.browserRequirements].sort(),
      mobileRequirements: [...architecture.platformEnvironment.mobileRequirements].sort(),
      desktopRequirements: [...architecture.platformEnvironment.desktopRequirements].sort(),
      serverEnvironment: [...architecture.platformEnvironment.serverEnvironment].sort(),
      cloudOnPremRequirements: [
        ...architecture.platformEnvironment.cloudOnPremRequirements,
      ].sort(),
      supportedRuntimeVersions: [
        ...architecture.platformEnvironment.supportedRuntimeVersions,
      ].sort(),
    };

    const securityArchitecture = {
      authenticationArchitecture: architecture.securityArchitecture.authenticationArchitecture,
      authorizationModel: architecture.securityArchitecture.authorizationModel,
      identityProvider: architecture.securityArchitecture.identityProvider,
      secretsHandling: [...architecture.securityArchitecture.secretsHandling].sort(),
      encryptionRequirements: [
        ...architecture.securityArchitecture.encryptionRequirements,
      ].sort(),
      trustBoundaries: [...architecture.securityArchitecture.trustBoundaries].sort(),
      dataIsolation: [...architecture.securityArchitecture.dataIsolation].sort(),
      auditRequirements: [...architecture.securityArchitecture.auditRequirements].sort(),
      status: architecture.securityArchitecture.status,
    };

    const integrations = [...architecture.integrations]
      .sort((a, b) => a.integrationId.localeCompare(b.integrationId))
      .map((i) => ({
        integrationId: i.integrationId,
        system: i.system,
        purpose: i.purpose,
        protocol: i.protocol,
        direction: i.direction,
        dependency: i.dependency,
        status: i.status,
        source: i.source,
        affectedRequirements: [...i.affectedRequirements].sort(),
      }));

    const deploymentArchitecture = {
      environments: [...architecture.deploymentArchitecture.environments].sort(),
      development: architecture.deploymentArchitecture.development,
      test: architecture.deploymentArchitecture.test,
      staging: architecture.deploymentArchitecture.staging,
      production: architecture.deploymentArchitecture.production,
      deploymentModel: architecture.deploymentArchitecture.deploymentModel,
      hostingPlatform: architecture.deploymentArchitecture.hostingPlatform,
      runtimeTopology: architecture.deploymentArchitecture.runtimeTopology,
      scalingExpectations: [...architecture.deploymentArchitecture.scalingExpectations].sort(),
      operationalDependencies: [
        ...architecture.deploymentArchitecture.operationalDependencies,
      ].sort(),
      status: architecture.deploymentArchitecture.status,
    };

    // Technology decisions vs candidates
    const technologyDecisions = architecture.technologyStack
      .filter((t) => ['REQUIRED', 'CONSTRAINED', 'SELECTED'].includes(t.selectionStatus))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        category: t.category,
        name: t.name,
        selectionStatus: t.selectionStatus,
        versionConstraint: t.versionConstraint,
        source: t.source,
        affectedRequirements: [...t.affectedRequirements].sort(),
        rationale: t.rationale,
      }));

    const technologyCandidates = architecture.technologyStack
      .filter((t) => ['CANDIDATE', 'UNDECIDED'].includes(t.selectionStatus))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        category: t.category,
        name: t.name,
        selectionStatus: t.selectionStatus,
        versionConstraint: t.versionConstraint,
        source: t.source,
        affectedRequirements: [...t.affectedRequirements].sort(),
        rationale: t.rationale,
      }));

    const architectureDecisions = [...architecture.decisions]
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
      .map((d) => ({
        decisionId: d.decisionId,
        decisionArea: d.decisionArea,
        question: d.question,
        status: d.status,
        selectedOption: d.selectedOption,
        candidateOptions: [...d.candidateOptions].sort(),
        rationale: d.rationale,
        affectedRequirements: [...d.affectedRequirements].sort(),
        consequences: [...d.consequences].sort(),
        dependencies: [...d.dependencies].sort(),
        authority: d.authority,
      }));

    // 10. Business Rules (sorted by ruleId)
    const specBusinessRules = [...businessRules.rules]
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
      .map((r) => ({
        ruleId: r.ruleId,
        title: r.title,
        description: r.description,
        category: r.category,
        statement: r.statement,
        priority: r.priority,
        status: r.status,
        sourceRequirements: [...r.sourceRequirements].sort(),
        affectedRequirements: [...r.affectedRequirements].sort(),
        validationExpectation: r.validationExpectation,
        temporalDetails: r.temporalDetails as Record<string, unknown> | undefined,
        stateTransitionDetails: r.stateTransitionDetails as Record<string, unknown> | undefined,
        validationCalculationDetails: r.validationCalculationDetails as
          | Record<string, unknown>
          | undefined,
        authorizationPolicyDetails: r.authorizationPolicyDetails as
          | Record<string, unknown>
          | undefined,
      }));

    // 11. Acceptance Criteria (sorted by criterionId)
    const specAcceptanceCriteria = [...acceptanceCriteria.criteria]
      .sort((a, b) => a.criterionId.localeCompare(b.criterionId))
      .map((ac) => ({
        criterionId: ac.criterionId,
        title: ac.title,
        description: ac.description,
        criterionType: ac.criterionType,
        statement: ac.statement,
        priority: ac.priority,
        status: ac.status,
        sourceRequirements: [...ac.sourceRequirements].sort(),
        sourceBusinessRules: [...ac.sourceBusinessRules].sort(),
        sourceArchitectureDecisions: [...ac.sourceArchitectureDecisions].sort(),
        verificationMethod: ac.verificationMethod,
        expectedResult: ac.expectedResult,
        dependencies: [...ac.dependencies].sort(),
      }));

    // 12. Risks (sorted by riskId)
    const specRisks = [...risks.risks]
      .sort((a, b) => a.riskId.localeCompare(b.riskId))
      .map((r) => ({
        riskId: r.riskId,
        title: r.title,
        description: r.description,
        category: r.category,
        probability: r.probability,
        impact: r.impact,
        severity: r.severity,
        status: r.status,
        response: r.response,
        statement: r.statement,
        consequences: [...r.consequences].sort(),
        mitigation: r.mitigation,
        contingency: r.contingency,
        owner: r.owner,
        sourceRequirements: [...r.sourceRequirements].sort(),
        sourceBusinessRules: [...r.sourceBusinessRules].sort(),
        sourceArchitectureDecisions: [...r.sourceArchitectureDecisions].sort(),
        sourceAcceptanceCriteria: [...r.sourceAcceptanceCriteria].sort(),
      }));

    const riskSummary = {
      totalRisks: risks.coverage.totalRisks,
      criticalRisks: risks.coverage.criticalRisks,
      highRisks: risks.coverage.highRisks,
      mediumRisks: risks.coverage.mediumRisks,
      lowRisks: risks.coverage.lowRisks,
      pendingDecisionRisks: risks.coverage.pendingDecisionRisks,
    };

    // 13. Human Decision Points (from risks artifact and all upstream decision boundaries)
    const humanDecisionPoints = [...risks.humanDecisionPoints]
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
      .map((hdp) => ({
        decisionId: hdp.decisionId,
        title: hdp.title,
        question: hdp.question,
        whyItMatters: hdp.whyItMatters,
        affectedRisks: [...hdp.affectedRisks].sort(),
        affectedRequirements: [...hdp.affectedRequirements].sort(),
        affectedArchitectureDecisions: [...hdp.affectedArchitectureDecisions].sort(),
        affectedBusinessRules: [...hdp.affectedBusinessRules].sort(),
        affectedAcceptanceCriteria: [...hdp.affectedAcceptanceCriteria].sort(),
        availableOptions: [...hdp.availableOptions],
        recommendedInformation: hdp.recommendedInformation ?? '',
        consequences: [...hdp.consequences].sort(),
        authority: hdp.authority,
        status: hdp.status,
      }));

    // 14. End-to-End Traceability Matrix (sorted by requirementId)
    const traceabilityMatrix = functionalRequirements.map((req) => {
      const bRules = specBusinessRules
        .filter((br) => br.sourceRequirements.includes(req.requirementId))
        .map((br) => br.ruleId)
        .sort();

      const aCriteria = specAcceptanceCriteria
        .filter((ac) => ac.sourceRequirements.includes(req.requirementId))
        .map((ac) => ac.criterionId)
        .sort();

      const aDecisions = architectureDecisions
        .filter((ad) => ad.affectedRequirements.includes(req.requirementId))
        .map((ad) => ad.decisionId)
        .sort();

      const components = systemComponents
        .filter((c) => c.sourceReferences.includes(req.requirementId))
        .map((c) => c.componentId)
        .sort();

      const rList = specRisks
        .filter((r) => r.sourceRequirements.includes(req.requirementId))
        .map((r) => r.riskId)
        .sort();

      return {
        requirementId: req.requirementId,
        requirementTitle: req.title,
        businessRuleIds: bRules,
        acceptanceCriteriaIds: aCriteria,
        architectureDecisionIds: aDecisions,
        componentIds: components,
        riskIds: rList,
      };
    });

    return {
      identity,
      purpose,
      targetUsers,
      scope,
      functionalRequirements,
      nonFunctionalRequirements,
      constraints,
      assumptions,
      openQuestions,
      architecture: {
        architecturalStyle,
        systemComponents,
        dataArchitecture,
        apiCommunicationArchitecture,
        platformEnvironment,
        securityArchitecture,
        integrations,
        deploymentArchitecture,
        technologyDecisions,
        technologyCandidates,
        architectureDecisions,
      },
      businessRules: specBusinessRules,
      acceptanceCriteria: specAcceptanceCriteria,
      risks: specRisks,
      riskSummary,
      humanDecisionPoints,
      traceabilityMatrix,
    };
  }

  /**
   * Generates formatted GitHub Flavored Markdown for PROJECT_SPEC.md.
   */
  generateMarkdown(spec: {
    projectId: string;
    specRevision: number;
    sourceBindings: ProjectSpecSourceBindings;
    content: ProjectSpecContent;
    semanticFingerprint: string;
    generatedAt: string;
    isStale?: boolean;
  }): string {
    const { projectId, specRevision, sourceBindings, content, semanticFingerprint, generatedAt, isStale } =
      spec;
    const lines: string[] = [];

    // Title & Header Block
    lines.push(`# PROJECT SPECIFICATION: ${content.identity.name}`);
    lines.push('');
    lines.push(`> [!NOTE]`);
    lines.push(
      `> **Deterministic Specification Projection**  \n> This document is a deterministic, human-readable projection aggregated from authoritative project-initiation stores. Existing authoritative artifacts remain the sole source of truth; if this file is deleted or lost, it can be faithfully reconstructed.`
    );
    lines.push('');

    // Status Banner
    if (isStale) {
      lines.push('> [!CAUTION]');
      lines.push(
        '> **PROJECTION IS STALE**: One or more authoritative upstream artifacts (Discovery, Requirements, Architecture, Business Rules, Acceptance Criteria, or Risks) have been modified since this specification was generated.'
      );
      lines.push('');
    }

    // Pending Human Decisions Warning Banner
    const pendingDecisions = content.humanDecisionPoints.filter(
      (hdp) => hdp.status === 'PENDING_DECISION'
    );
    if (pendingDecisions.length > 0) {
      lines.push('> [!WARNING]');
      lines.push(
        `> **${pendingDecisions.length} UNRESOLVED HUMAN DECISION POINT(S) REQUIRE PRODUCT OWNER ATTENTION**  \n> This specification contains pending human choices that require explicit human Product Owner authority. Automated tools and agents MUST NOT make these choices autonomously or treat informal conversational affirmative statements as formal approval.`
      );
      lines.push('');
    }

    // Metadata Table
    lines.push('### Specification Metadata');
    lines.push('| Property | Value |');
    lines.push('| :--- | :--- |');
    lines.push(`| **Project ID** | \`${projectId}\` |`);
    lines.push(`| **Specification Revision** | \`rev-${specRevision}\` |`);
    lines.push(`| **Projection Status** | **${isStale ? 'STALE' : 'CURRENT'}** |`);
    lines.push(`| **Generated At** | ${generatedAt} |`);
    lines.push(`| **Semantic Fingerprint** | \`${semanticFingerprint}\` |`);
    lines.push(
      `| **Pending Human Decisions** | ${pendingDecisions.length} of ${content.humanDecisionPoints.length} |`
    );
    lines.push('');

    // Table of Contents
    lines.push('## Table of Contents');
    lines.push('1. [Project Identity & Purpose](#1-project-identity--purpose)');
    lines.push('2. [Target Users & Actors](#2-target-users--actors)');
    lines.push('3. [Scope Boundaries](#3-scope-boundaries)');
    lines.push('4. [Functional Requirements](#4-functional-requirements)');
    lines.push('5. [Non-Functional Requirements](#5-non-functional-requirements)');
    lines.push('6. [Constraints & Assumptions](#6-constraints--assumptions)');
    lines.push('7. [Open Questions](#7-open-questions)');
    lines.push('8. [Architecture & System Topology](#8-architecture--system-topology)');
    lines.push('9. [Technology Decisions & Candidates](#9-technology-decisions--candidates)');
    lines.push('10. [Business Rules](#10-business-rules)');
    lines.push('11. [Acceptance Criteria](#11-acceptance-criteria)');
    lines.push('12. [Risks & Responses](#12-risks--responses)');
    lines.push('13. [Human Decision Points](#13-human-decision-points)');
    lines.push('14. [Traceability Matrix](#14-traceability-matrix)');
    lines.push('15. [Authoritative Source Bindings](#15-authoritative-source-bindings)');
    lines.push('');

    // --- Section 1: Project Identity & Purpose ---
    lines.push('## 1. Project Identity & Purpose');
    lines.push(`- **Project Name:** ${content.identity.name}`);
    lines.push(`- **Core Purpose:** ${content.identity.purpose}`);
    lines.push(`- **Desired Outcome:** ${content.identity.desiredOutcome}`);
    if (content.purpose.problemStatement) {
      lines.push(`- **Problem Statement:** ${content.purpose.problemStatement}`);
    }
    if (content.purpose.measurableObjective) {
      lines.push(`- **Measurable Objective:** ${content.purpose.measurableObjective}`);
    }
    lines.push('');

    // --- Section 2: Target Users & Actors ---
    lines.push('## 2. Target Users & Actors');
    if (content.targetUsers.primaryUsers.length > 0) {
      lines.push('### Primary Users');
      for (const u of content.targetUsers.primaryUsers) lines.push(`- ${u}`);
    }
    if (content.targetUsers.secondaryUsers.length > 0) {
      lines.push('### Secondary Users');
      for (const u of content.targetUsers.secondaryUsers) lines.push(`- ${u}`);
    }
    if (content.targetUsers.systemActors.length > 0) {
      lines.push('### System Actors');
      for (const a of content.targetUsers.systemActors) lines.push(`- ${a}`);
    }
    if (content.targetUsers.externalActors.length > 0) {
      lines.push('### External Actors');
      for (const a of content.targetUsers.externalActors) lines.push(`- ${a}`);
    }
    lines.push('');

    // --- Section 3: Scope Boundaries ---
    lines.push('## 3. Scope Boundaries');
    lines.push('### In-Scope Capabilities & Workflows');
    if (content.scope.inScope.capabilities.length > 0) {
      lines.push('**Capabilities:**');
      for (const c of content.scope.inScope.capabilities) lines.push(`- ${c}`);
    }
    if (content.scope.inScope.workflows.length > 0) {
      lines.push('**Workflows:**');
      for (const w of content.scope.inScope.workflows) lines.push(`- ${w}`);
    }
    if (content.scope.inScope.platforms.length > 0) {
      lines.push('**Platforms:**');
      for (const p of content.scope.inScope.platforms) lines.push(`- ${p}`);
    }
    if (content.scope.inScope.integrations.length > 0) {
      lines.push('**Integrations:**');
      for (const i of content.scope.inScope.integrations) lines.push(`- ${i}`);
    }

    lines.push('');
    lines.push('### Explicit Exclusions (Out of Scope)');
    if (content.scope.outOfScope.capabilities.length > 0) {
      lines.push('**Excluded Capabilities:**');
      for (const c of content.scope.outOfScope.capabilities) lines.push(`- ${c}`);
    }
    if (content.scope.outOfScope.workflows.length > 0) {
      lines.push('**Excluded Workflows:**');
      for (const w of content.scope.outOfScope.workflows) lines.push(`- ${w}`);
    }
    if (content.scope.outOfScope.platforms.length > 0) {
      lines.push('**Excluded Platforms:**');
      for (const p of content.scope.outOfScope.platforms) lines.push(`- ${p}`);
    }
    if (content.scope.outOfScope.integrations.length > 0) {
      lines.push('**Excluded Integrations:**');
      for (const i of content.scope.outOfScope.integrations) lines.push(`- ${i}`);
    }

    lines.push('');
    lines.push('### Undecided Scope / Pending Decisions');
    if (content.scope.undecidedScope.length > 0) {
      lines.push('| ID | Topic | Description | Available Options | Why It Matters |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const u of content.scope.undecidedScope) {
        lines.push(
          `| \`${u.id}\` | **${u.topic}** | ${u.description} | ${u.availableOptions.join(', ')} | ${u.whyItMatters} |`
        );
      }
    } else {
      lines.push('_None. All scope items have been decided or confirmed._');
    }
    lines.push('');

    // --- Section 4: Functional Requirements ---
    lines.push('## 4. Functional Requirements');
    if (content.functionalRequirements.length > 0) {
      lines.push('| Requirement ID | Title | Priority | Status | Source | Description |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const req of content.functionalRequirements) {
        lines.push(
          `| \`${req.requirementId}\` | **${req.title}** | ${req.priority} | ${req.status} | ${req.source} | ${req.description} |`
        );
      }
    } else {
      lines.push('_No functional requirements recorded._');
    }
    lines.push('');

    // --- Section 5: Non-Functional Requirements ---
    lines.push('## 5. Non-Functional Requirements');
    const nfr = content.nonFunctionalRequirements;
    if (nfr.performance.length > 0) {
      lines.push('### Performance');
      for (const item of nfr.performance) lines.push(`- ${item}`);
    }
    if (nfr.security.length > 0) {
      lines.push('### Security');
      for (const item of nfr.security) lines.push(`- ${item}`);
    }
    if (nfr.reliability.length > 0) {
      lines.push('### Reliability');
      for (const item of nfr.reliability) lines.push(`- ${item}`);
    }
    if (nfr.availability.length > 0) {
      lines.push('### Availability');
      for (const item of nfr.availability) lines.push(`- ${item}`);
    }
    if (nfr.scalability.length > 0) {
      lines.push('### Scalability');
      for (const item of nfr.scalability) lines.push(`- ${item}`);
    }
    if (nfr.usability.length > 0) {
      lines.push('### Usability');
      for (const item of nfr.usability) lines.push(`- ${item}`);
    }
    if (nfr.maintainability.length > 0) {
      lines.push('### Maintainability');
      for (const item of nfr.maintainability) lines.push(`- ${item}`);
    }
    if (nfr.operationalConstraints.length > 0) {
      lines.push('### Operational Constraints');
      for (const item of nfr.operationalConstraints) lines.push(`- ${item}`);
    }
    lines.push('');

    // --- Section 6: Constraints & Assumptions ---
    lines.push('## 6. Constraints & Assumptions');
    lines.push('### Constraints');
    const c = content.constraints;
    if (c.technologyConstraints.length > 0) {
      lines.push('**Technology Constraints:**');
      for (const item of c.technologyConstraints) lines.push(`- ${item}`);
    }
    if (c.platformConstraints.length > 0) {
      lines.push('**Platform Constraints:**');
      for (const item of c.platformConstraints) lines.push(`- ${item}`);
    }
    if (c.compatibilityConstraints.length > 0) {
      lines.push('**Compatibility Constraints:**');
      for (const item of c.compatibilityConstraints) lines.push(`- ${item}`);
    }
    if (c.legalComplianceConstraints.length > 0) {
      lines.push('**Legal & Compliance Constraints:**');
      for (const item of c.legalComplianceConstraints) lines.push(`- ${item}`);
    }
    if (c.operationalConstraints.length > 0) {
      lines.push('**Operational Constraints:**');
      for (const item of c.operationalConstraints) lines.push(`- ${item}`);
    }
    if (c.budgetResourceConstraints.length > 0) {
      lines.push('**Budget & Resource Constraints:**');
      for (const item of c.budgetResourceConstraints) lines.push(`- ${item}`);
    }

    lines.push('');
    lines.push('### Assumptions');
    if (content.assumptions.length > 0) {
      lines.push('| ID | Statement | Validated | Rationale |');
      lines.push('| :--- | :--- | :--- | :--- |');
      for (const a of content.assumptions) {
        lines.push(
          `| \`${a.id}\` | ${a.statement} | ${a.validated ? 'YES' : 'NO'} | ${a.rationale ?? '-'} |`
        );
      }
    } else {
      lines.push('_No explicit assumptions recorded._');
    }
    lines.push('');

    // --- Section 7: Open Questions ---
    lines.push('## 7. Open Questions');
    if (content.openQuestions.length > 0) {
      lines.push('| Question ID | Classification | Status | Question | Why It Matters |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const q of content.openQuestions) {
        lines.push(
          `| \`${q.questionId}\` | ${q.classification} | ${q.status} | **${q.question}** | ${q.whyItMatters} |`
        );
      }
    } else {
      lines.push('_No open questions recorded._');
    }
    lines.push('');

    // --- Section 8: Architecture & System Topology ---
    lines.push('## 8. Architecture & System Topology');
    const arch = content.architecture;
    lines.push('### Architectural Style & Topology');
    lines.push(`- **Style:** ${arch.architecturalStyle.style}`);
    if (arch.architecturalStyle.pattern) lines.push(`- **Pattern:** ${arch.architecturalStyle.pattern}`);
    if (arch.architecturalStyle.applicationTopology) {
      lines.push(`- **Application Topology:** ${arch.architecturalStyle.applicationTopology}`);
    }
    if (arch.architecturalStyle.deploymentTopology) {
      lines.push(`- **Deployment Topology:** ${arch.architecturalStyle.deploymentTopology}`);
    }
    if (arch.architecturalStyle.communicationModel) {
      lines.push(`- **Communication Model:** ${arch.architecturalStyle.communicationModel}`);
    }

    lines.push('');
    lines.push('### Major System Components');
    if (arch.systemComponents.length > 0) {
      lines.push('| Component ID | Name | Owning Boundary | Responsibility | Status |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const comp of arch.systemComponents) {
        lines.push(
          `| \`${comp.componentId}\` | **${comp.name}** | ${comp.owningBoundary} | ${comp.responsibility} | ${comp.status} |`
        );
      }
    } else {
      lines.push('_No components defined._');
    }

    lines.push('');
    lines.push('### Data Architecture & Storage Strategy');
    if (arch.dataArchitecture.persistenceStrategy) {
      lines.push(`- **Persistence Strategy:** ${arch.dataArchitecture.persistenceStrategy}`);
    }
    if (arch.dataArchitecture.primaryDataStore) {
      lines.push(`- **Primary Data Store:** ${arch.dataArchitecture.primaryDataStore}`);
    }
    if (arch.dataArchitecture.secondaryStores.length > 0) {
      lines.push(`- **Secondary Stores:** ${arch.dataArchitecture.secondaryStores.join(', ')}`);
    }
    if (arch.dataArchitecture.caching.length > 0) {
      lines.push(`- **Caching:** ${arch.dataArchitecture.caching.join(', ')}`);
    }
    if (arch.dataArchitecture.retentionRequirements.length > 0) {
      lines.push(`- **Retention Requirements:** ${arch.dataArchitecture.retentionRequirements.join(', ')}`);
    }

    lines.push('');
    lines.push('### API & Communication Architecture');
    lines.push(`- **HTTP/REST:** ${arch.apiCommunicationArchitecture.httpRest ? 'YES' : 'NO'}`);
    lines.push(`- **GraphQL:** ${arch.apiCommunicationArchitecture.graphQl ? 'YES' : 'NO'}`);
    lines.push(`- **WebSocket:** ${arch.apiCommunicationArchitecture.webSocket ? 'YES' : 'NO'}`);
    if (arch.apiCommunicationArchitecture.messageQueues.length > 0) {
      lines.push(`- **Message Queues:** ${arch.apiCommunicationArchitecture.messageQueues.join(', ')}`);
    }
    if (arch.apiCommunicationArchitecture.eventBus.length > 0) {
      lines.push(`- **Event Bus:** ${arch.apiCommunicationArchitecture.eventBus.join(', ')}`);
    }
    if (arch.apiCommunicationArchitecture.internalApis.length > 0) {
      lines.push(`- **Internal APIs:** ${arch.apiCommunicationArchitecture.internalApis.join(', ')}`);
    }

    lines.push('');
    lines.push('### Platform & Environment');
    if (arch.platformEnvironment.targetOs.length > 0) {
      lines.push(`- **Target OS:** ${arch.platformEnvironment.targetOs.join(', ')}`);
    }
    if (arch.platformEnvironment.supportedRuntimeVersions.length > 0) {
      lines.push(
        `- **Supported Runtimes:** ${arch.platformEnvironment.supportedRuntimeVersions.join(', ')}`
      );
    }
    if (arch.platformEnvironment.serverEnvironment.length > 0) {
      lines.push(`- **Server Environment:** ${arch.platformEnvironment.serverEnvironment.join(', ')}`);
    }

    lines.push('');
    lines.push('### Security Architecture');
    if (arch.securityArchitecture.authenticationArchitecture) {
      lines.push(
        `- **Authentication Architecture:** ${arch.securityArchitecture.authenticationArchitecture}`
      );
    }
    if (arch.securityArchitecture.authorizationModel) {
      lines.push(`- **Authorization Model:** ${arch.securityArchitecture.authorizationModel}`);
    }
    if (arch.securityArchitecture.identityProvider) {
      lines.push(`- **Identity Provider:** ${arch.securityArchitecture.identityProvider}`);
    }
    if (arch.securityArchitecture.secretsHandling.length > 0) {
      lines.push(`- **Secrets Handling:** ${arch.securityArchitecture.secretsHandling.join(', ')}`);
    }
    if (arch.securityArchitecture.encryptionRequirements.length > 0) {
      lines.push(
        `- **Encryption Requirements:** ${arch.securityArchitecture.encryptionRequirements.join(', ')}`
      );
    }

    lines.push('');
    lines.push('### External Integrations');
    if (arch.integrations.length > 0) {
      lines.push('| Integration ID | System | Direction | Dependency | Status | Purpose |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const i of arch.integrations) {
        lines.push(
          `| \`${i.integrationId}\` | **${i.system}** | ${i.direction} | ${i.dependency} | ${i.status} | ${i.purpose} |`
        );
      }
    } else {
      lines.push('_No external integrations defined._');
    }

    lines.push('');
    lines.push('### Deployment Architecture');
    if (arch.deploymentArchitecture.deploymentModel) {
      lines.push(`- **Deployment Model:** ${arch.deploymentArchitecture.deploymentModel}`);
    }
    if (arch.deploymentArchitecture.hostingPlatform) {
      lines.push(`- **Hosting Platform:** ${arch.deploymentArchitecture.hostingPlatform}`);
    }
    if (arch.deploymentArchitecture.environments.length > 0) {
      lines.push(`- **Environments:** ${arch.deploymentArchitecture.environments.join(', ')}`);
    }
    lines.push('');

    // --- Section 9: Technology Decisions & Candidates ---
    lines.push('## 9. Technology Decisions & Candidates');
    lines.push('### Selected / Required Technologies');
    if (arch.technologyDecisions.length > 0) {
      lines.push('| Category | Technology | Status | Version | Rationale |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const t of arch.technologyDecisions) {
        lines.push(
          `| ${t.category} | **${t.name}** | \`${t.selectionStatus}\` | ${t.versionConstraint ?? '-'} | ${t.rationale ?? '-'} |`
        );
      }
    } else {
      lines.push('_No technology decisions confirmed._');
    }

    lines.push('');
    lines.push('### Technology Candidates & Undecided Options');
    if (arch.technologyCandidates.length > 0) {
      lines.push('| Category | Technology | Status | Version | Rationale |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const t of arch.technologyCandidates) {
        lines.push(
          `| ${t.category} | **${t.name}** | \`${t.selectionStatus}\` | ${t.versionConstraint ?? '-'} | ${t.rationale ?? '-'} |`
        );
      }
    } else {
      lines.push('_No unresolved candidate technologies._');
    }

    lines.push('');
    lines.push('### Key Architecture Decisions');
    if (arch.architectureDecisions.length > 0) {
      lines.push('| Decision ID | Area | Status | Question | Selected / Outcome |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const d of arch.architectureDecisions) {
        lines.push(
          `| \`${d.decisionId}\` | ${d.decisionArea} | ${d.status} | **${d.question}** | ${d.selectedOption ?? (d.candidateOptions.length > 0 ? `Candidate: ${d.candidateOptions.join(', ')}` : '-')} |`
        );
      }
    } else {
      lines.push('_No architecture decisions recorded._');
    }
    lines.push('');

    // --- Section 10: Business Rules ---
    lines.push('## 10. Business Rules');
    if (content.businessRules.length > 0) {
      lines.push('| Rule ID | Title | Category | Priority | Status | Statement |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const br of content.businessRules) {
        lines.push(
          `| \`${br.ruleId}\` | **${br.title}** | ${br.category} | ${br.priority} | ${br.status} | ${br.statement} |`
        );
      }
    } else {
      lines.push('_No business rules recorded._');
    }
    lines.push('');

    // --- Section 11: Acceptance Criteria ---
    lines.push('## 11. Acceptance Criteria');
    if (content.acceptanceCriteria.length > 0) {
      lines.push('| Criterion ID | Title | Type | Priority | Method | Expected Result |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const ac of content.acceptanceCriteria) {
        lines.push(
          `| \`${ac.criterionId}\` | **${ac.title}** | ${ac.criterionType} | ${ac.priority} | \`${ac.verificationMethod}\` | ${ac.expectedResult} |`
        );
      }
    } else {
      lines.push('_No acceptance criteria recorded._');
    }
    lines.push('');

    // --- Section 12: Risks & Responses ---
    lines.push('## 12. Risks & Responses');
    lines.push('### Risk Profile Summary');
    lines.push('| Metric | Count |');
    lines.push('| :--- | :--- |');
    lines.push(`| **Total Risks** | ${content.riskSummary.totalRisks} |`);
    lines.push(`| **Critical Severity** | ${content.riskSummary.criticalRisks} |`);
    lines.push(`| **High Severity** | ${content.riskSummary.highRisks} |`);
    lines.push(`| **Medium Severity** | ${content.riskSummary.mediumRisks} |`);
    lines.push(`| **Low Severity** | ${content.riskSummary.lowRisks} |`);
    lines.push(`| **Pending Decision Responses** | ${content.riskSummary.pendingDecisionRisks} |`);

    lines.push('');
    lines.push('### Risk Register');
    if (content.risks.length > 0) {
      lines.push(
        '| Risk ID | Title | Category | Probability | Impact | Severity | Response | Mitigation Strategy |'
      );
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const r of content.risks) {
        lines.push(
          `| \`${r.riskId}\` | **${r.title}** | ${r.category} | ${r.probability} | ${r.impact} | **${r.severity}** | \`${r.response}\` | ${r.mitigation} |`
        );
      }
    } else {
      lines.push('_No risks identified._');
    }
    lines.push('');

    // --- Section 13: Human Decision Points ---
    lines.push('## 13. Human Decision Points');
    lines.push(
      '> [!IMPORTANT]\n> Human Decision Points represent explicit forks in product, technical, or risk direction that require **Product Owner / User** authority. The autonomous system preserves these points faithfully without choosing on the human\'s behalf.'
    );
    lines.push('');

    if (content.humanDecisionPoints.length > 0) {
      for (const hdp of content.humanDecisionPoints) {
        lines.push(`### [${hdp.decisionId}] ${hdp.title}`);
        lines.push(`- **Authority:** \`${hdp.authority}\``);
        lines.push(`- **Status:** **\`${hdp.status}\`**`);
        lines.push(`- **Question:** ${hdp.question}`);
        lines.push(`- **Why It Matters:** ${hdp.whyItMatters}`);
        lines.push(`- **Available Options:**`);
        for (const opt of hdp.availableOptions) {
          lines.push(`  - ${opt}`);
        }
        if (hdp.recommendedInformation) {
          lines.push(`- **Informational Recommendation:** ${hdp.recommendedInformation}`);
        }
        if (hdp.consequences.length > 0) {
          lines.push(`- **Consequences:** ${hdp.consequences.join('; ')}`);
        }
        lines.push('');
      }
    } else {
      lines.push('_No human decision points recorded._');
      lines.push('');
    }

    // --- Section 14: Traceability Matrix ---
    lines.push('## 14. Traceability Matrix');
    if (content.traceabilityMatrix.length > 0) {
      lines.push(
        '| Requirement | Business Rules | Acceptance Criteria | Architecture Decisions | Components | Risks |'
      );
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const row of content.traceabilityMatrix) {
        const br = row.businessRuleIds.length > 0 ? row.businessRuleIds.join(', ') : '-';
        const ac =
          row.acceptanceCriteriaIds.length > 0 ? row.acceptanceCriteriaIds.join(', ') : '-';
        const ad =
          row.architectureDecisionIds.length > 0 ? row.architectureDecisionIds.join(', ') : '-';
        const comp = row.componentIds.length > 0 ? row.componentIds.join(', ') : '-';
        const rk = row.riskIds.length > 0 ? row.riskIds.join(', ') : '-';
        lines.push(
          `| \`${row.requirementId}\` (${row.requirementTitle}) | ${br} | ${ac} | ${ad} | ${comp} | ${rk} |`
        );
      }
    } else {
      lines.push('_No requirements to trace._');
    }
    lines.push('');

    // --- Section 15: Authoritative Source Bindings ---
    lines.push('## 15. Authoritative Source Bindings');
    lines.push(
      'The integrity and provenance of this specification projection are guaranteed by strict cryptographic bindings to the following authoritative upstream artifacts:'
    );
    lines.push('');
    lines.push('| Upstream Source | Revision | Cryptographic Fingerprint (SHA-256) |');
    lines.push('| :--- | :--- | :--- |');
    lines.push(
      `| **Adaptive Discovery (P15-01)** | \`rev-${sourceBindings.discoveryRevision}\` | \`${sourceBindings.discoveryFingerprint}\` |`
    );
    lines.push(
      `| **Requirements / Scope (P15-03)** | \`rev-${sourceBindings.requirementsRevision}\` | \`${sourceBindings.requirementsFingerprint}\` |`
    );
    lines.push(
      `| **Architecture / Technology (P15-04)** | \`rev-${sourceBindings.architectureRevision}\` | \`${sourceBindings.architectureFingerprint}\` |`
    );
    lines.push(
      `| **Business Rules (P15-05)** | \`rev-${sourceBindings.businessRulesRevision}\` | \`${sourceBindings.businessRulesFingerprint}\` |`
    );
    lines.push(
      `| **Acceptance Criteria (P15-06)** | \`rev-${sourceBindings.acceptanceCriteriaRevision}\` | \`${sourceBindings.acceptanceCriteriaFingerprint}\` |`
    );
    lines.push(
      `| **Risks & Human Decision Points (P15-07)** | \`rev-${sourceBindings.riskRevision}\` | \`${sourceBindings.riskFingerprint}\` |`
    );
    lines.push('');
    lines.push('---');
    lines.push(
      `_This document was deterministically projected by AIDM OtonomMCP Project Specification Engine. Semantic Fingerprint: \`${semanticFingerprint}\`._`
    );
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generates a new PROJECT_SPEC projection from current authoritative stores.
   * If an identical projection revision already exists for this exact source combination,
   * performs deterministic idempotent return.
   */
  async generate(input: ProjectSpecInput): Promise<ProjectSpecProjection> {
    const parsedInput = ProjectSpecInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ProjectSpecValidationError(
        `Failed to generate project spec: schema validation error: ${parsedInput.error.message}`,
        { issues: parsedInput.error.issues }
      );
    }

    const { projectId } = parsedInput.data;
    const safeProjectId = this.sanitizeProjectId(projectId);

    // 1. Resolve and validate all 6 authoritative upstream sources
    const sources = await this.resolveUpstreamSources(projectId, parsedInput.data);

    // 2. Count total and pending human decision points
    const pendingHdpCount = sources.risks.humanDecisionPoints.filter(
      (h) => h.status === 'PENDING_DECISION'
    ).length;

    // 3. Construct authoritative source bindings
    const sourceBindings: ProjectSpecSourceBindings = {
      projectId,
      discoveryRevision: sources.discovery.discoveryRevision,
      discoveryFingerprint: sources.discovery.fingerprint,
      requirementsRevision: sources.requirements.requirementsRevision,
      requirementsFingerprint: sources.requirements.fingerprint,
      architectureRevision: sources.architecture.architectureRevision,
      architectureFingerprint: sources.architecture.fingerprint,
      businessRulesRevision: sources.businessRules.businessRulesRevision,
      businessRulesFingerprint: sources.businessRules.fingerprint,
      acceptanceCriteriaRevision: sources.acceptanceCriteria.acceptanceCriteriaRevision,
      acceptanceCriteriaFingerprint: sources.acceptanceCriteria.fingerprint,
      riskRevision: sources.risks.riskRevision,
      riskFingerprint: sources.risks.fingerprint,
      humanDecisionPointsCount: sources.risks.humanDecisionPoints.length,
      pendingHumanDecisionsCount: pendingHdpCount,
    };

    // 4. Check latest projection for idempotent return
    const latestExisting = await this.specProjectionStore.loadLatest(safeProjectId);
    if (latestExisting) {
      const bindingsMatch =
        latestExisting.sourceBindings.discoveryRevision === sourceBindings.discoveryRevision &&
        latestExisting.sourceBindings.discoveryFingerprint === sourceBindings.discoveryFingerprint &&
        latestExisting.sourceBindings.requirementsRevision === sourceBindings.requirementsRevision &&
        latestExisting.sourceBindings.requirementsFingerprint === sourceBindings.requirementsFingerprint &&
        latestExisting.sourceBindings.architectureRevision === sourceBindings.architectureRevision &&
        latestExisting.sourceBindings.architectureFingerprint === sourceBindings.architectureFingerprint &&
        latestExisting.sourceBindings.businessRulesRevision === sourceBindings.businessRulesRevision &&
        latestExisting.sourceBindings.businessRulesFingerprint === sourceBindings.businessRulesFingerprint &&
        latestExisting.sourceBindings.acceptanceCriteriaRevision === sourceBindings.acceptanceCriteriaRevision &&
        latestExisting.sourceBindings.acceptanceCriteriaFingerprint === sourceBindings.acceptanceCriteriaFingerprint &&
        latestExisting.sourceBindings.riskRevision === sourceBindings.riskRevision &&
        latestExisting.sourceBindings.riskFingerprint === sourceBindings.riskFingerprint;

      if (bindingsMatch) {
        // Authoritative sources are identical: return existing projection idempotently
        return latestExisting;
      }
    }

    // 5. Determine next specRevision
    const specRevision = latestExisting ? latestExisting.specRevision + 1 : 1;

    // 6. Build deterministic canonical content
    const rawContent = this.buildProjectSpecContent(sources);
    const content: ProjectSpecContent = JSON.parse(JSON.stringify(rawContent));

    // 7. Compute deterministic semantic fingerprint (ignoring timestamps)
    const semanticFingerprint = computeProjectSpecSemanticFingerprint({
      projectId,
      specRevision,
      sourceBindings,
      content,
    });

    const generatedAt = parsedInput.data.generatedAt ?? new Date().toISOString();

    // 8. Generate formatted Markdown document
    const markdownContent = this.generateMarkdown({
      projectId,
      specRevision,
      sourceBindings,
      content,
      semanticFingerprint,
      generatedAt,
      isStale: false,
    });

    const projection: ProjectSpecProjection = {
      projectId,
      specRevision,
      sourceBindings,
      content,
      markdownContent,
      semanticFingerprint,
      isStale: false,
      createdAt: generatedAt,
    };

    // 9. Persist revision to ProjectSpecStore
    await this.specProjectionStore.saveRevision(projection, {
      workspaceRoot: parsedInput.data.workspaceRoot ?? this.workspaceRoot,
    });

    return projection;
  }

  /**
   * Verifies the authoritative integrity of a loaded projection.
   * Multi-layer defense:
   * 1. Recomputes semantic fingerprint against content and bindings.
   * 2. Checks that every recorded upstream source revision exists with the recorded fingerprint.
   * 3. Reconstructs content from authoritative sources to detect tampering with content.
   */
  async verifyAuthoritativeIntegrity(projection: ProjectSpecProjection): Promise<void> {
    // 1. Check semantic fingerprint self-consistency
    const computedFingerprint = computeProjectSpecSemanticFingerprint(projection);
    if (projection.semanticFingerprint !== computedFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Projection semantic fingerprint mismatch for project '${projection.projectId}': declared '${projection.semanticFingerprint}' but recomputed '${computedFingerprint}'.`,
        { declaredFingerprint: projection.semanticFingerprint, computedFingerprint }
      );
    }

    const safeProjectId = this.sanitizeProjectId(projection.projectId);

    // 2. Check each source binding against the real authoritative stores
    const req = await this.requirementsStore.loadRevision(
      safeProjectId,
      projection.sourceBindings.requirementsRevision
    );
    if (!req || req.fingerprint !== projection.sourceBindings.requirementsFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Authoritative requirements binding check failed for project '${projection.projectId}': revision ${projection.sourceBindings.requirementsRevision} not found or fingerprint mismatch.`,
        {
          expectedFingerprint: projection.sourceBindings.requirementsFingerprint,
          actualFingerprint: req?.fingerprint ?? null,
        }
      );
    }

    const arch = await this.architectureStore.loadRevision(
      safeProjectId,
      projection.sourceBindings.architectureRevision
    );
    if (!arch || arch.fingerprint !== projection.sourceBindings.architectureFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Authoritative architecture binding check failed for project '${projection.projectId}': revision ${projection.sourceBindings.architectureRevision} not found or fingerprint mismatch.`,
        {
          expectedFingerprint: projection.sourceBindings.architectureFingerprint,
          actualFingerprint: arch?.fingerprint ?? null,
        }
      );
    }

    const br = await this.businessRulesStore.loadRevision(
      safeProjectId,
      projection.sourceBindings.businessRulesRevision
    );
    if (!br || br.fingerprint !== projection.sourceBindings.businessRulesFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Authoritative business rules binding check failed for project '${projection.projectId}': revision ${projection.sourceBindings.businessRulesRevision} not found or fingerprint mismatch.`,
        {
          expectedFingerprint: projection.sourceBindings.businessRulesFingerprint,
          actualFingerprint: br?.fingerprint ?? null,
        }
      );
    }

    const ac = await this.acceptanceCriteriaStore.loadRevision(
      safeProjectId,
      projection.sourceBindings.acceptanceCriteriaRevision
    );
    if (!ac || ac.fingerprint !== projection.sourceBindings.acceptanceCriteriaFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Authoritative acceptance criteria binding check failed for project '${projection.projectId}': revision ${projection.sourceBindings.acceptanceCriteriaRevision} not found or fingerprint mismatch.`,
        {
          expectedFingerprint: projection.sourceBindings.acceptanceCriteriaFingerprint,
          actualFingerprint: ac?.fingerprint ?? null,
        }
      );
    }

    const risk = await this.riskStore.loadRevision(
      safeProjectId,
      projection.sourceBindings.riskRevision
    );
    if (!risk || risk.fingerprint !== projection.sourceBindings.riskFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Authoritative risk binding check failed for project '${projection.projectId}': revision ${projection.sourceBindings.riskRevision} not found or fingerprint mismatch.`,
        {
          expectedFingerprint: projection.sourceBindings.riskFingerprint,
          actualFingerprint: risk?.fingerprint ?? null,
        }
      );
    }

    const disc = await this.discoveryStore.loadRevision(
      safeProjectId,
      projection.sourceBindings.discoveryRevision
    );
    if (!disc || disc.fingerprint !== projection.sourceBindings.discoveryFingerprint) {
      throw new ProjectSpecForgedFingerprintError(
        `Authoritative discovery binding check failed for project '${projection.projectId}': revision ${projection.sourceBindings.discoveryRevision} not found or fingerprint mismatch.`,
        {
          expectedFingerprint: projection.sourceBindings.discoveryFingerprint,
          actualFingerprint: disc?.fingerprint ?? null,
        }
      );
    }

    // 3. Detect forged content tampering by verifying against canonical projection derived from upstream stores
    const rawContent = this.buildProjectSpecContent({
      discovery: disc,
      requirements: req,
      architecture: arch,
      businessRules: br,
      acceptanceCriteria: ac,
      risks: risk,
    });
    const canonicalContent: ProjectSpecContent = JSON.parse(JSON.stringify(rawContent));

    const canonicalFingerprintFromSources = computeProjectSpecSemanticFingerprint({
      projectId: projection.projectId,
      specRevision: projection.specRevision,
      sourceBindings: projection.sourceBindings,
      content: canonicalContent,
    });

    if (computedFingerprint !== canonicalFingerprintFromSources) {
      throw new ProjectSpecTamperingError(
        `Project specification content for project '${projection.projectId}' has been tampered with. Content does not match authoritative upstream stores despite self-consistent fingerprint.`,
        {
          declaredFingerprint: projection.semanticFingerprint,
          canonicalFingerprintFromSources,
        }
      );
    }
  }

  /**
   * Compares a projection's source bindings against the current latest authoritative store revisions.
   */
  async detectStale(projectId: string, revision?: number): Promise<ProjectSpecStaleReport> {
    const projection =
      revision !== undefined
        ? await this.specProjectionStore.loadRevision(projectId, revision)
        : await this.specProjectionStore.loadLatest(projectId);

    const safeProjectId = this.sanitizeProjectId(projectId);

    // Load latest from all stores
    const latestDisc = await this.discoveryStore.loadRevision(safeProjectId);
    const latestReq = await this.requirementsStore.loadRevision(safeProjectId);
    const latestArch = await this.architectureStore.loadRevision(safeProjectId);
    const latestBr = await this.businessRulesStore.loadRevision(safeProjectId);
    const latestAc = await this.acceptanceCriteriaStore.loadRevision(safeProjectId);
    const latestRisk = await this.riskStore.loadRevision(safeProjectId);

    const latestAuthoritativeRevisions = {
      discoveryRevision: latestDisc?.discoveryRevision ?? null,
      discoveryFingerprint: latestDisc?.fingerprint ?? null,
      requirementsRevision: latestReq?.requirementsRevision ?? null,
      requirementsFingerprint: latestReq?.fingerprint ?? null,
      architectureRevision: latestArch?.architectureRevision ?? null,
      architectureFingerprint: latestArch?.fingerprint ?? null,
      businessRulesRevision: latestBr?.businessRulesRevision ?? null,
      businessRulesFingerprint: latestBr?.fingerprint ?? null,
      acceptanceCriteriaRevision: latestAc?.acceptanceCriteriaRevision ?? null,
      acceptanceCriteriaFingerprint: latestAc?.fingerprint ?? null,
      riskRevision: latestRisk?.riskRevision ?? null,
      riskFingerprint: latestRisk?.fingerprint ?? null,
    };

    if (!projection) {
      return {
        isStale: true,
        reasons: ['No PROJECT_SPEC projection found for project.'],
        details: {
          discoveryStale: true,
          requirementsStale: true,
          architectureStale: true,
          businessRulesStale: true,
          acceptanceCriteriaStale: true,
          risksStale: true,
          humanDecisionsChanged: true,
        },
        latestAuthoritativeRevisions,
      };
    }

    const sb = projection.sourceBindings;
    const reasons: string[] = [];
    const details = {
      discoveryStale: false,
      requirementsStale: false,
      architectureStale: false,
      businessRulesStale: false,
      acceptanceCriteriaStale: false,
      risksStale: false,
      humanDecisionsChanged: false,
    };

    if (
      !latestDisc ||
      latestDisc.discoveryRevision !== sb.discoveryRevision ||
      latestDisc.fingerprint !== sb.discoveryFingerprint
    ) {
      details.discoveryStale = true;
      reasons.push(
        `Discovery has changed: bound to rev-${sb.discoveryRevision} (${sb.discoveryFingerprint.substring(
          0,
          8
        )}) but latest is rev-${latestDisc?.discoveryRevision ?? 'none'} (${latestDisc?.fingerprint.substring(
          0,
          8
        ) ?? 'none'}).`
      );
    }

    if (
      !latestReq ||
      latestReq.requirementsRevision !== sb.requirementsRevision ||
      latestReq.fingerprint !== sb.requirementsFingerprint
    ) {
      details.requirementsStale = true;
      reasons.push(
        `Requirements have changed: bound to rev-${sb.requirementsRevision} (${sb.requirementsFingerprint.substring(
          0,
          8
        )}) but latest is rev-${latestReq?.requirementsRevision ?? 'none'} (${latestReq?.fingerprint.substring(
          0,
          8
        ) ?? 'none'}).`
      );
    }

    if (
      !latestArch ||
      latestArch.architectureRevision !== sb.architectureRevision ||
      latestArch.fingerprint !== sb.architectureFingerprint
    ) {
      details.architectureStale = true;
      reasons.push(
        `Architecture has changed: bound to rev-${sb.architectureRevision} (${sb.architectureFingerprint.substring(
          0,
          8
        )}) but latest is rev-${latestArch?.architectureRevision ?? 'none'} (${latestArch?.fingerprint.substring(
          0,
          8
        ) ?? 'none'}).`
      );
    }

    if (
      !latestBr ||
      latestBr.businessRulesRevision !== sb.businessRulesRevision ||
      latestBr.fingerprint !== sb.businessRulesFingerprint
    ) {
      details.businessRulesStale = true;
      reasons.push(
        `Business rules have changed: bound to rev-${sb.businessRulesRevision} (${sb.businessRulesFingerprint.substring(
          0,
          8
        )}) but latest is rev-${latestBr?.businessRulesRevision ?? 'none'} (${latestBr?.fingerprint.substring(
          0,
          8
        ) ?? 'none'}).`
      );
    }

    if (
      !latestAc ||
      latestAc.acceptanceCriteriaRevision !== sb.acceptanceCriteriaRevision ||
      latestAc.fingerprint !== sb.acceptanceCriteriaFingerprint
    ) {
      details.acceptanceCriteriaStale = true;
      reasons.push(
        `Acceptance criteria have changed: bound to rev-${sb.acceptanceCriteriaRevision} (${sb.acceptanceCriteriaFingerprint.substring(
          0,
          8
        )}) but latest is rev-${latestAc?.acceptanceCriteriaRevision ?? 'none'} (${latestAc?.fingerprint.substring(
          0,
          8
        ) ?? 'none'}).`
      );
    }

    if (
      !latestRisk ||
      latestRisk.riskRevision !== sb.riskRevision ||
      latestRisk.fingerprint !== sb.riskFingerprint
    ) {
      details.risksStale = true;
      reasons.push(
        `Risks have changed: bound to rev-${sb.riskRevision} (${sb.riskFingerprint.substring(
          0,
          8
        )}) but latest is rev-${latestRisk?.riskRevision ?? 'none'} (${latestRisk?.fingerprint.substring(
          0,
          8
        ) ?? 'none'}).`
      );
    }

    if (
      latestRisk &&
      latestRisk.humanDecisionPoints.length !== sb.humanDecisionPointsCount
    ) {
      details.humanDecisionsChanged = true;
      reasons.push(
        `Human decision points count changed: bound to ${sb.humanDecisionPointsCount} but latest has ${latestRisk.humanDecisionPoints.length}.`
      );
    }

    const isStale = reasons.length > 0;

    return {
      isStale,
      reasons,
      details,
      currentBindings: sb,
      latestAuthoritativeRevisions,
    };
  }

  /**
   * Retrieves latest PROJECT_SPEC projection with integrity check and staleness evaluation.
   */
  async getLatest(projectId: string): Promise<ProjectSpecProjection | null> {
    const projection = await this.specProjectionStore.loadLatest(projectId);
    if (!projection) return null;

    await this.verifyAuthoritativeIntegrity(projection);
    const staleReport = await this.detectStale(projectId);

    return {
      ...projection,
      isStale: staleReport.isStale,
      staleReport,
    };
  }

  /**
   * Retrieves specific revision of PROJECT_SPEC projection with integrity check and staleness evaluation.
   */
  async getRevision(projectId: string, revision: number): Promise<ProjectSpecProjection | null> {
    const projection = await this.specProjectionStore.loadRevision(projectId, revision);
    if (!projection) return null;

    await this.verifyAuthoritativeIntegrity(projection);
    const staleReport = await this.detectStale(projectId, revision);

    return {
      ...projection,
      isStale: staleReport.isStale,
      staleReport,
    };
  }

  /**
   * Reconstructs a PROJECT_SPEC projection directly from authoritative stores.
   * Works on fresh processes without any cached in-memory state or pre-existing projection file.
   */
  async reconstruct(
    projectId: string,
    options?: {
      discoveryRevision?: number;
      requirementsRevision?: number;
      architectureRevision?: number;
      businessRulesRevision?: number;
      acceptanceCriteriaRevision?: number;
      riskRevision?: number;
      workspaceRoot?: string;
      generatedAt?: string;
    }
  ): Promise<ProjectSpecProjection> {
    return this.generate({
      projectId,
      discoveryRevision: options?.discoveryRevision,
      requirementsRevision: options?.requirementsRevision,
      architectureRevision: options?.architectureRevision,
      businessRulesRevision: options?.businessRulesRevision,
      acceptanceCriteriaRevision: options?.acceptanceCriteriaRevision,
      riskRevision: options?.riskRevision,
      workspaceRoot: options?.workspaceRoot ?? this.workspaceRoot,
      generatedAt: options?.generatedAt,
    });
  }
}
