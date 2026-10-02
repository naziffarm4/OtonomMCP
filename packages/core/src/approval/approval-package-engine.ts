/**
 * Project Approval Package & Gate Engine (Phase 8 TASK-P8-05 & Phase 15 Product Owner Approval)
 *
 * Implements the authoritative protocol boundary where:
 * 1. Authoritative project-initiation state (Discovery, Requirements, Architecture,
 *    Business Rules, Acceptance Criteria, Risks/HDPs, PROJECT_SPEC, Completeness Gate)
 *    is assembled into an immutable, revision-bound ApprovalPackage.
 * 2. Readiness conditions are evaluated (completeness gate must be COMPLETE, zero unresolved
 *    material human decisions, non-stale authoritative sources, multi-layer integrity).
 * 3. Explicit human Product Owner approval or rejection is enforced with cryptographic revision binding.
 * 4. Development authorization is governed: unauthorized until explicitly approved by Product Owner.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. The system MUST NOT approve the project automatically.
 * 2. Natural language ("tamam", "olur", "yes", "ok") is NEVER counted as approval.
 * 3. Director decisions, risk decisions, or clarification answers are NOT project approval.
 * 4. Completeness Gate = COMPLETE enables approval readiness, but does NOT approve.
 * 5. Approval is strictly bound to exact package revision (immutable per revision).
 * 6. Only human Product Owner (PRODUCT_OWNER / USER) may approve; DIRECTOR, SYSTEM, EXECUTOR,
 *    ANTIGRAVITY are unconditionally rejected.
 * 7. Approval != Execution: approving does NOT create ExecutionIntent/ExecutionRequest, does NOT
 *    invoke Antigravity, does NOT mutate Task DAG, does NOT start the autonomous driver.
 * 8. Stale approval protection: if authoritative inputs change, previous approval cannot authorize
 *    the new state, package is marked stale, and a new approval revision is required.
 * 9. Multi-layer integrity: forged packages with recomputed fingerprints fail closed when
 *    authoritative upstream state does not match.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClarificationSession } from '../clarification/clarification-types.js';
import { Actor } from '../actors.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { SpecStore } from '../storage/spec-store.js';
import { AdaptiveDiscoveryStore } from '../discovery/adaptive-discovery-store.js';
import { RequirementsScopeStore } from '../discovery/requirements-scope-store.js';
import { ArchitectureTechnologyStore } from '../discovery/architecture-technology-store.js';
import { BusinessRulesStore } from '../discovery/business-rules-store.js';
import { AcceptanceCriteriaStore } from '../discovery/acceptance-criteria-store.js';
import { RiskHumanDecisionStore } from '../discovery/risk-human-decision-store.js';
import { ProjectSpecStore } from '../discovery/project-spec-store.js';
import { CompletenessGateStore } from '../discovery/completeness-gate-store.js';
import { CompletenessGateEngine } from '../discovery/completeness-gate-engine.js';
import { ApprovalStore } from './approval-store.js';
import {
  type InitialProjectUnderstanding,
  type ProposedDevelopmentPlan,
  type ApprovalPackage,
  type ProjectApprovalPackage,
  type ProjectApprovalStatus,
  type ApprovalReadiness,
  type ApprovalSourceBindings,
  type ApprovalStaleReport,
  type ProjectApprovalInput,
  type ProjectRejectionInput,
  type ProjectApprovalRecord,
  type ProjectRejectionRecord,
  type UnderstandingItem,
  FORBIDDEN_APPROVAL_ACTORS,
  ApprovalPackageZodSchema,
  computePackageFingerprint,
} from './approval-types.js';
import {
  ApprovalAuthorizationError,
  ApprovalRevisionMismatchError,
  ApprovalInvalidIntentError,
  ApprovalNotReadyError,
  ApprovalAlreadyDecidedError,
  ApprovalValidationError,
  ApprovalStaleError,
  ApprovalForgedFingerprintError,
  ApprovalIntegrityError,
  ApprovalBlockedOnHumanError,
  ApprovalProjectBindingMismatchError,
  ApprovalImmutableRevisionError,
  ApprovalCompletenessGateFailedError,
} from './approval-errors.js';

export interface ApprovalPackageEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly architectureStore?: ArchitectureTechnologyStore;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly riskStore?: RiskHumanDecisionStore;
  readonly specProjectionStore?: ProjectSpecStore;
  readonly completenessStore?: CompletenessGateStore;
  readonly completenessEngine?: CompletenessGateEngine;
  readonly approvalStore?: ApprovalStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export interface BuildApprovalPackageOptions {
  readonly projectId: string;
  readonly packageId?: string;
  readonly discoveryRevision?: number;
  readonly requirementsRevision?: number;
  readonly architectureRevision?: number;
  readonly businessRulesRevision?: number;
  readonly acceptanceCriteriaRevision?: number;
  readonly riskRevision?: number;
  readonly specRevision?: number;
  readonly provenanceCreatedBy?: string;
}

export interface CreatePackageOptions {
  readonly packageId?: string;
  readonly clarificationSession?: ClarificationSession;
}

/**
 * Computes a deterministic SHA-256 hash of the approval package content
 * for tamper-evident binding of approvals to exact package revisions.
 */
export function computePackageHash(pkg: {
  packageId: string;
  revision: number;
  projectId: string;
  projectUnderstanding?: InitialProjectUnderstanding;
  proposedDevelopmentPlan?: ProposedDevelopmentPlan;
  sourceBindings?: ApprovalSourceBindings;
  completenessResult?: any;
  unresolvedHumanDecisionPoints?: readonly unknown[];
  risksRequiringAttention?: readonly unknown[];
}): string {
  if (pkg.sourceBindings) {
    return computePackageFingerprint(pkg as any);
  }
  const canonicalData = {
    packageId: pkg.packageId,
    revision: pkg.revision,
    projectId: pkg.projectId,
    sourceDiscovery: pkg.projectUnderstanding?.sourceDiscoveryReference ?? '',
    confirmedRequirementsCount: pkg.projectUnderstanding?.confirmedRequirements?.length ?? 0,
    clarifiedRequirementsCount: pkg.projectUnderstanding?.clarifiedRequirements?.length ?? 0,
    unresolvedUnknownsCount: pkg.projectUnderstanding?.unresolvedUnknowns?.length ?? 0,
    unresolvedContradictionsCount: pkg.projectUnderstanding?.unresolvedContradictions?.length ?? 0,
    objectives: pkg.proposedDevelopmentPlan?.objectives ?? [],
    proposedScope: pkg.proposedDevelopmentPlan?.proposedScope ?? [],
    featureGroupsCount: pkg.proposedDevelopmentPlan?.proposedFeatureGroups?.length ?? 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalData)).digest('hex');
}

export class ApprovalPackageEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly requirementsStore: RequirementsScopeStore;
  readonly architectureStore: ArchitectureTechnologyStore;
  readonly businessRulesStore: BusinessRulesStore;
  readonly acceptanceCriteriaStore: AcceptanceCriteriaStore;
  readonly riskStore: RiskHumanDecisionStore;
  readonly specProjectionStore: ProjectSpecStore;
  readonly completenessStore: CompletenessGateStore;
  readonly completenessEngine: CompletenessGateEngine;
  readonly approvalStore: ApprovalStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;

  constructor(options?: ApprovalPackageEngineOptions) {
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
        historyManager: this.historyManager,
      });

    this.completenessStore =
      options?.completenessStore ??
      new CompletenessGateStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.completenessEngine =
      options?.completenessEngine ??
      new CompletenessGateEngine({
        baseDir: this.baseDir,
        discoveryStore: this.discoveryStore,
        completenessStore: this.completenessStore,
        historyManager: this.historyManager,
      });

    this.approvalStore =
      options?.approvalStore ??
      new ApprovalStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });
  }

  /**
   * Builds an authoritative, revision-bound ApprovalPackage from the 8 upstream initiation artifacts:
   * 1. Adaptive Discovery
   * 2. Requirements / Scope
   * 3. Architecture / Technology
   * 4. Business Rules
   * 5. Acceptance Criteria
   * 6. Risks & Human Decision Points
   * 7. PROJECT_SPEC projection
   * 8. Specification Completeness Gate result
   */
  async createApprovalPackage(options: BuildApprovalPackageOptions): Promise<ApprovalPackage> {
    const { projectId } = options;
    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new ApprovalValidationError('projectId cannot be empty.', 'MISSING_PACKAGE_ID');
    }

    // 1. Authoritative upstream artifact retrieval
    const discovery = await this.discoveryStore.loadRevision(projectId, options.discoveryRevision);
    const requirements = await this.requirementsStore.loadRevision(projectId, options.requirementsRevision);
    const architecture = await this.architectureStore.loadRevision(projectId, options.architectureRevision);
    const businessRules = await this.businessRulesStore.loadRevision(projectId, options.businessRulesRevision);
    const acceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(projectId, options.acceptanceCriteriaRevision);
    const risks = await this.riskStore.loadRevision(projectId, options.riskRevision);
    const specProjection = await this.specProjectionStore.loadRevision(projectId, options.specRevision);

    // 2. Cross-project isolation check
    const sources = [
      { name: 'discovery', item: discovery },
      { name: 'requirements', item: requirements },
      { name: 'architecture', item: architecture },
      { name: 'businessRules', item: businessRules },
      { name: 'acceptanceCriteria', item: acceptanceCriteria },
      { name: 'risks', item: risks },
      { name: 'specProjection', item: specProjection },
    ];

    for (const source of sources) {
      if (source.item && source.item.projectId !== projectId) {
        throw new ApprovalProjectBindingMismatchError(
          `Cross-project artifact mismatch in ${source.name}: expected projectId '${projectId}', got '${source.item.projectId}'.`,
          { expectedProjectId: projectId, actualProjectId: source.item.projectId, source: source.name }
        );
      }
    }

    // 3. Completeness Gate evaluation (authoritative P15-02 reuse)
    let completenessResult = discovery
      ? await this.completenessStore.loadResult(projectId, discovery.discoveryRevision)
      : null;

    if (!completenessResult && discovery) {
      completenessResult = await this.completenessEngine.evaluate({
        projectId,
        discoveryRevision: discovery.discoveryRevision,
      });
    }

    if (completenessResult && completenessResult.projectId !== projectId) {
      throw new ApprovalProjectBindingMismatchError(
        `Cross-project completeness gate mismatch: expected projectId '${projectId}', got '${completenessResult.projectId}'.`,
        { expectedProjectId: projectId, actualProjectId: completenessResult.projectId }
      );
    }

    // 4. Missing sources check
    const missingReasons: string[] = [];
    if (!discovery) missingReasons.push('Adaptive Discovery is missing or invalid.');
    if (!requirements) missingReasons.push('Requirements & Scope is missing or invalid.');
    if (!architecture) missingReasons.push('Architecture & Technology is missing or invalid.');
    if (!businessRules) missingReasons.push('Business Rules are missing or invalid.');
    if (!acceptanceCriteria) missingReasons.push('Acceptance Criteria are missing or invalid.');
    if (!risks) missingReasons.push('Risks & Human Decision Points are missing or invalid.');
    if (!specProjection) missingReasons.push('PROJECT_SPEC projection is missing or invalid.');
    if (!completenessResult) missingReasons.push('Specification Completeness Gate result is missing or invalid.');

    // 5. Unresolved Human Decision Points collection
    const unresolvedHDPs: any[] = [];
    if (risks?.humanDecisionPoints) {
      for (const hdp of risks.humanDecisionPoints) {
        if (['PENDING_DECISION', 'UNDECIDED', 'PROPOSED', 'OPEN'].includes(hdp.status)) {
          unresolvedHDPs.push(hdp);
        }
      }
    }
    if (completenessResult?.humanDecisions) {
      for (const hd of completenessResult.humanDecisions) {
        if (['PENDING_DECISION', 'UNDECIDED', 'PROPOSED', 'OPEN'].includes(hd.status) && !unresolvedHDPs.some((x) => x.decisionId === hd.decisionId)) {
          unresolvedHDPs.push(hd);
        }
      }
    }

    // 6. Risks requiring attention collection (CRITICAL/HIGH/PENDING)
    const risksRequiringAttention: any[] = [];
    if (risks?.risks) {
      for (const r of risks.risks) {
        if (r.severity === 'CRITICAL' || r.severity === 'HIGH' || r.status === 'PENDING_DECISION') {
          risksRequiringAttention.push(r);
        }
      }
    }

    // 7. Staleness check
    const stalenessReasons: string[] = [];
    if (specProjection?.isStale) {
      stalenessReasons.push('PROJECT_SPEC projection is marked STALE.');
    }
    if (completenessResult?.isStale) {
      stalenessReasons.push('Completeness Gate result is marked STALE.');
    }

    // Check if the latest available in store is newer than what was resolved
    const latestDiscovery = await this.discoveryStore.loadRevision(projectId);
    if (latestDiscovery && discovery && latestDiscovery.discoveryRevision > discovery.discoveryRevision) {
      stalenessReasons.push(`Discovery revision in store (${latestDiscovery.discoveryRevision}) is newer than package revision (${discovery.discoveryRevision}).`);
    }
    const latestReqs = await this.requirementsStore.loadRevision(projectId);
    if (latestReqs && requirements && latestReqs.requirementsRevision > requirements.requirementsRevision) {
      stalenessReasons.push(`Requirements revision in store (${latestReqs.requirementsRevision}) is newer than package revision (${requirements.requirementsRevision}).`);
    }
    const latestArch = await this.architectureStore.loadRevision(projectId);
    if (latestArch && architecture && latestArch.architectureRevision > architecture.architectureRevision) {
      stalenessReasons.push(`Architecture revision in store (${latestArch.architectureRevision}) is newer than package revision (${architecture.architectureRevision}).`);
    }
    const latestBr = await this.businessRulesStore.loadRevision(projectId);
    if (latestBr && businessRules && latestBr.businessRulesRevision > businessRules.businessRulesRevision) {
      stalenessReasons.push(`Business rules revision in store (${latestBr.businessRulesRevision}) is newer than package revision (${businessRules.businessRulesRevision}).`);
    }
    const latestAc = await this.acceptanceCriteriaStore.loadRevision(projectId);
    if (latestAc && acceptanceCriteria && latestAc.acceptanceCriteriaRevision > acceptanceCriteria.acceptanceCriteriaRevision) {
      stalenessReasons.push(`Acceptance criteria revision in store (${latestAc.acceptanceCriteriaRevision}) is newer than package revision (${acceptanceCriteria.acceptanceCriteriaRevision}).`);
    }
    const latestRisk = await this.riskStore.loadRevision(projectId);
    if (latestRisk && risks && latestRisk.riskRevision > risks.riskRevision) {
      stalenessReasons.push(`Risk revision in store (${latestRisk.riskRevision}) is newer than package revision (${risks.riskRevision}).`);
    }
    const latestSpec = await this.specProjectionStore.loadRevision(projectId);
    if (latestSpec && specProjection && latestSpec.specRevision > specProjection.specRevision) {
      stalenessReasons.push(`PROJECT_SPEC revision in store (${latestSpec.specRevision}) is newer than package revision (${specProjection.specRevision}).`);
    }

    const isStale = stalenessReasons.length > 0;

    // 8. Determine initial status
    let initialStatus: ProjectApprovalStatus = 'NOT_READY';
    if (missingReasons.length > 0) {
      initialStatus = 'NOT_READY';
    } else if (isStale) {
      initialStatus = 'STALE';
    } else if (unresolvedHDPs.length > 0 || completenessResult?.status === 'BLOCKED_ON_HUMAN') {
      initialStatus = 'BLOCKED_ON_HUMAN';
    } else if (completenessResult?.status === 'COMPLETE') {
      initialStatus = 'READY_FOR_APPROVAL';
    } else {
      initialStatus = 'NOT_READY';
    }

    // 9. Construct source bindings
    const sourceBindings: ApprovalSourceBindings = {
      projectId,
      discoveryRevision: discovery?.discoveryRevision ?? 1,
      discoveryFingerprint: discovery?.fingerprint ?? 'missing-discovery',
      requirementsRevision: requirements?.requirementsRevision ?? 1,
      requirementsFingerprint: requirements?.fingerprint ?? 'missing-requirements',
      architectureRevision: architecture?.architectureRevision ?? 1,
      architectureFingerprint: architecture?.fingerprint ?? 'missing-architecture',
      businessRulesRevision: businessRules?.businessRulesRevision ?? 1,
      businessRulesFingerprint: businessRules?.fingerprint ?? 'missing-business-rules',
      acceptanceCriteriaRevision: acceptanceCriteria?.acceptanceCriteriaRevision ?? 1,
      acceptanceCriteriaFingerprint: acceptanceCriteria?.fingerprint ?? 'missing-acceptance-criteria',
      riskRevision: risks?.riskRevision ?? 1,
      riskFingerprint: risks?.fingerprint ?? 'missing-risks',
      specRevision: specProjection?.specRevision ?? 1,
      specFingerprint: specProjection?.semanticFingerprint ?? 'missing-spec',
      completenessFingerprint: completenessResult?.fingerprint ?? 'missing-completeness',
      completenessRevision: discovery?.discoveryRevision,
    };

    const packageId = options.packageId ?? `pkg-p15-${projectId}`;
    const now = new Date().toISOString();

    const projectName = specProjection?.content?.identity?.name ?? discovery?.sections?.projectIdentity?.name ?? projectId;
    const purposeSummary = specProjection?.content?.purpose?.purpose ?? discovery?.sections?.projectIdentity?.purpose ?? '';

    // 10. Synthesize backwards-compatible understanding and proposed plan
    const projectUnderstanding: InitialProjectUnderstanding = {
      projectId,
      projectName,
      apparentPurpose: {
        classification: 'greenfield-new-project' as any,
        summary: purposeSummary,
        rawDescription: purposeSummary,
        domainKeywords: [],
        evidence: [],
      },
      targetUsers: specProjection?.content?.targetUsers?.primaryUsers ?? [],
      technologyStack: {
        primaryLanguages: [],
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        runtimes: [],
        containerization: [],
        ciCd: [],
        workspaceType: 'standalone',
        dependencies: [],
        devDependencies: [],
        evidence: [],
      },
      architectureSummary: {
        identifiedAreas: [],
        architecturalPattern: specProjection?.content?.architecture?.architecturalStyle?.style ?? 'Modular',
        summary: specProjection?.content?.architecture?.architecturalStyle?.pattern ?? 'Standard modular architecture',
        evidence: [],
      },
      existingCapabilities: [],
      confirmedRequirements: (requirements?.functionalRequirements ?? []).map((r: any, idx: number) => ({
        id: r.id ?? r.requirementId ?? `req-${idx + 1}`,
        type: 'CONFIRMED_FACT' as const,
        origin: 'EXISTING_REQUIREMENT' as const,
        statement: `${r.title ?? r.requirementId ?? 'Requirement'}: ${r.statement ?? r.description ?? ''}`,
        evidence: [],
      })),
      clarifiedRequirements: [],
      unresolvedUnknowns: [],
      unresolvedContradictions: [],
      currentImplementationState: {
        lifecycleState: 'GREENFIELD',
        hasActiveTask: false,
        isBlocked: false,
        totalTasksInDag: 0,
        completedTasksCount: 0,
        evidence: [],
      },
      constraints: specProjection?.content?.constraints?.technologyConstraints ?? [],
      assumptions: (specProjection?.content?.assumptions ?? []).map((a: any, idx: number) => ({
        id: a.id ?? a.assumptionId ?? `assump-${idx + 1}`,
        type: 'ASSUMPTION' as const,
        origin: 'DISCOVERY_EVIDENCE' as const,
        statement: a.statement ?? '',
        evidence: [],
      })),
      nonGoals: specProjection?.content?.scope?.outOfScope?.capabilities ?? [],
      proposedDevelopmentScope: specProjection?.content?.scope?.inScope?.capabilities ?? [],
      evidenceReferences: [],
      sourceDiscoveryReference: discovery?.fingerprint ?? 'none',
      generatedAt: now,
    };

    const proposedDevelopmentPlan: ProposedDevelopmentPlan = {
      objectives: [
        specProjection?.content?.purpose?.purpose ?? `Implement baseline capabilities for ${projectId}`,
      ],
      proposedScope: specProjection?.content?.scope?.inScope?.capabilities ?? ['Core baseline'],
      proposedFeatureGroups: [
        {
          name: 'Core Capabilities',
          description: `Primary features for ${projectId}`,
          targetCapabilities: specProjection?.content?.scope?.inScope?.capabilities ?? ['Core baseline'],
        },
      ],
      dependencies: [],
      constraints: specProjection?.content?.constraints?.technologyConstraints ?? [],
      knownRisks: (risks?.risks ?? []).map((r: any) => `${r.title}: ${r.statement}`),
      unresolvedIssues: unresolvedHDPs.map((h: any) => h.question ?? h.title),
      excludedScope: specProjection?.content?.scope?.outOfScope?.capabilities ?? [],
      suggestedImplementationOrder: specProjection?.content?.scope?.inScope?.capabilities ?? ['Core baseline'],
    };

    // 11. Assemble ApprovalPackage
    const pkgCandidate: ApprovalPackage = {
      packageId,
      revision: 1,
      approvalPackageRevision: 1,
      projectId,
      specRevision: specProjection?.specRevision ?? 1,
      projectSpecRevision: specProjection?.specRevision ?? 1,
      sourceBindings,
      completenessResult: completenessResult ?? undefined,
      unresolvedHumanDecisionPoints: Object.freeze(unresolvedHDPs),
      risksRequiringAttention: Object.freeze(risksRequiringAttention),
      status: initialStatus,
      isStale,
      staleReport: isStale ? {
        isStale: true,
        reasons: stalenessReasons,
        details: {
          discoveryStale: stalenessReasons.some((r) => r.includes('Discovery')),
          requirementsStale: stalenessReasons.some((r) => r.includes('Requirements')),
          architectureStale: stalenessReasons.some((r) => r.includes('Architecture')),
          businessRulesStale: stalenessReasons.some((r) => r.includes('Business rules')),
          acceptanceCriteriaStale: stalenessReasons.some((r) => r.includes('Acceptance criteria')),
          risksStale: stalenessReasons.some((r) => r.includes('Risk')),
          specStale: stalenessReasons.some((r) => r.includes('PROJECT_SPEC')),
          completenessStale: stalenessReasons.some((r) => r.includes('Completeness')),
          humanDecisionsChanged: false,
        },
      } : undefined,
      provenance: {
        createdBy: options.provenanceCreatedBy ?? 'SYSTEM',
        engineVersion: 'P15-APPROVAL-1.0',
        evaluatedAt: now,
        sourceStores: [
          'AdaptiveDiscoveryStore',
          'RequirementsScopeStore',
          'ArchitectureTechnologyStore',
          'BusinessRulesStore',
          'AcceptanceCriteriaStore',
          'RiskHumanDecisionStore',
          'ProjectSpecStore',
          'CompletenessGateStore',
        ],
      },
      history: [
        {
          eventType: 'APPROVAL_PACKAGE_CREATED',
          actor: 'SYSTEM',
          actorRole: 'SYSTEM',
          timestamp: now,
          status: initialStatus,
          revision: 1,
        },
      ],
      createdAt: now,
      updatedAt: now,
      // Backwards compatibility fields:
      projectUnderstanding,
      proposedDevelopmentPlan,
      unresolvedItems: Object.freeze([]),
      assumptions: projectUnderstanding.assumptions,
      evidenceReferences: Object.freeze([]),
    };

    const packageFingerprint = computePackageFingerprint(pkgCandidate);
    const finalPackage: ApprovalPackage = Object.freeze({
      ...pkgCandidate,
      packageFingerprint,
    });

    const parsed = ApprovalPackageZodSchema.safeParse(finalPackage);
    if (!parsed.success) {
      throw new ApprovalValidationError(
        `Failed to validate approval package: ${parsed.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { issues: parsed.error.issues }
      );
    }

    // 12. Save to store
    await this.approvalStore.savePackage(finalPackage);

    // 13. Audit events via HistoryManager
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'APPROVAL_PACKAGE_CREATED',
          actor: Actor.ORCHESTRATOR,
          payload: {
            packageId: finalPackage.packageId,
            revision: finalPackage.revision,
            projectId: finalPackage.projectId,
            status: finalPackage.status,
            packageFingerprint: finalPackage.packageFingerprint,
            isStale: finalPackage.isStale,
          },
        });

        if (initialStatus === 'BLOCKED_ON_HUMAN' || initialStatus === 'NOT_READY' || initialStatus === 'STALE') {
          await this.historyManager.appendEvent({
            eventType: 'APPROVAL_BLOCKED',
            actor: Actor.ORCHESTRATOR,
            payload: {
              packageId: finalPackage.packageId,
              revision: finalPackage.revision,
              projectId: finalPackage.projectId,
              status: finalPackage.status,
              reasons: [...missingReasons, ...stalenessReasons, ...(unresolvedHDPs.length > 0 ? ['Unresolved human decision points pending'] : [])],
            },
          });
        }
      } catch {
        // Logging failure should not break engine
      }
    }

    return finalPackage;
  }

  /**
   * Verifies upstream integrity of an ApprovalPackage against authoritative stores.
   * Fails closed if the package is forged, has recomputed forged fingerprints, or has altered content.
   */
  async verifyUpstreamIntegrity(pkg: ApprovalPackage): Promise<void> {
    if (!pkg.sourceBindings) {
      // Legacy package without source bindings
      return;
    }

    // 1. Self-consistency check
    const expectedFingerprint = computePackageFingerprint(pkg);
    if (pkg.packageFingerprint && pkg.packageFingerprint !== expectedFingerprint) {
      throw new ApprovalForgedFingerprintError(
        `Approval package '${pkg.packageId}' fingerprint mismatch. Recorded: '${pkg.packageFingerprint}', recomputed: '${expectedFingerprint}'. Tampered package rejected.`,
        { packageId: pkg.packageId, recordedFingerprint: pkg.packageFingerprint, recomputedFingerprint: expectedFingerprint }
      );
    }

    // 2. Authoritative store binding checks (multi-layer integrity)
    const discovery = await this.discoveryStore.loadRevision(pkg.projectId, pkg.sourceBindings.discoveryRevision);
    if (!discovery || discovery.fingerprint !== pkg.sourceBindings.discoveryFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails discovery integrity: recorded fingerprint '${pkg.sourceBindings.discoveryFingerprint}' does not match authoritative store.`,
        { source: 'discovery', recorded: pkg.sourceBindings.discoveryFingerprint, actual: discovery?.fingerprint }
      );
    }

    const requirements = await this.requirementsStore.loadRevision(pkg.projectId, pkg.sourceBindings.requirementsRevision);
    if (!requirements || requirements.fingerprint !== pkg.sourceBindings.requirementsFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails requirements integrity: recorded fingerprint '${pkg.sourceBindings.requirementsFingerprint}' does not match authoritative store.`,
        { source: 'requirements', recorded: pkg.sourceBindings.requirementsFingerprint, actual: requirements?.fingerprint }
      );
    }

    const architecture = await this.architectureStore.loadRevision(pkg.projectId, pkg.sourceBindings.architectureRevision);
    if (!architecture || architecture.fingerprint !== pkg.sourceBindings.architectureFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails architecture integrity: recorded fingerprint '${pkg.sourceBindings.architectureFingerprint}' does not match authoritative store.`,
        { source: 'architecture', recorded: pkg.sourceBindings.architectureFingerprint, actual: architecture?.fingerprint }
      );
    }

    const businessRules = await this.businessRulesStore.loadRevision(pkg.projectId, pkg.sourceBindings.businessRulesRevision);
    if (!businessRules || businessRules.fingerprint !== pkg.sourceBindings.businessRulesFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails business rules integrity: recorded fingerprint '${pkg.sourceBindings.businessRulesFingerprint}' does not match authoritative store.`,
        { source: 'businessRules', recorded: pkg.sourceBindings.businessRulesFingerprint, actual: businessRules?.fingerprint }
      );
    }

    const acceptanceCriteria = await this.acceptanceCriteriaStore.loadRevision(pkg.projectId, pkg.sourceBindings.acceptanceCriteriaRevision);
    if (!acceptanceCriteria || acceptanceCriteria.fingerprint !== pkg.sourceBindings.acceptanceCriteriaFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails acceptance criteria integrity: recorded fingerprint '${pkg.sourceBindings.acceptanceCriteriaFingerprint}' does not match authoritative store.`,
        { source: 'acceptanceCriteria', recorded: pkg.sourceBindings.acceptanceCriteriaFingerprint, actual: acceptanceCriteria?.fingerprint }
      );
    }

    const risks = await this.riskStore.loadRevision(pkg.projectId, pkg.sourceBindings.riskRevision);
    if (!risks || risks.fingerprint !== pkg.sourceBindings.riskFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails risk integrity: recorded fingerprint '${pkg.sourceBindings.riskFingerprint}' does not match authoritative store.`,
        { source: 'risks', recorded: pkg.sourceBindings.riskFingerprint, actual: risks?.fingerprint }
      );
    }

    const specProjection = await this.specProjectionStore.loadRevision(pkg.projectId, pkg.sourceBindings.specRevision);
    if (!specProjection || specProjection.semanticFingerprint !== pkg.sourceBindings.specFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails PROJECT_SPEC projection integrity: recorded fingerprint '${pkg.sourceBindings.specFingerprint}' does not match authoritative store.`,
        { source: 'specProjection', recorded: pkg.sourceBindings.specFingerprint, actual: specProjection?.semanticFingerprint }
      );
    }

    const completenessResult = await this.completenessStore.loadResult(pkg.projectId, pkg.sourceBindings.discoveryRevision);
    if (!completenessResult || completenessResult.fingerprint !== pkg.sourceBindings.completenessFingerprint) {
      throw new ApprovalIntegrityError(
        `Approval package '${pkg.packageId}' fails completeness gate integrity: recorded fingerprint '${pkg.sourceBindings.completenessFingerprint}' does not match authoritative store.`,
        { source: 'completeness', recorded: pkg.sourceBindings.completenessFingerprint, actual: completenessResult?.fingerprint }
      );
    }
  }

  /**
   * Checks staleness of an ApprovalPackage against latest authoritative stores.
   */
  async checkStaleness(pkg: ApprovalPackage): Promise<ApprovalStaleReport> {
    if (!pkg.sourceBindings) {
      return {
        isStale: false,
        reasons: [],
        details: {
          discoveryStale: false,
          requirementsStale: false,
          architectureStale: false,
          businessRulesStale: false,
          acceptanceCriteriaStale: false,
          risksStale: false,
          specStale: false,
          completenessStale: false,
          humanDecisionsChanged: false,
        },
      };
    }

    const reasons: string[] = [];

    const latestDiscovery = await this.discoveryStore.loadRevision(pkg.projectId);
    const discoveryStale = !latestDiscovery ||
      latestDiscovery.discoveryRevision !== pkg.sourceBindings.discoveryRevision ||
      latestDiscovery.fingerprint !== pkg.sourceBindings.discoveryFingerprint;
    if (discoveryStale) {
      reasons.push(`Discovery revision has changed in authoritative store (package: rev ${pkg.sourceBindings.discoveryRevision}, store: rev ${latestDiscovery?.discoveryRevision ?? 'none'}).`);
    }

    const latestReqs = await this.requirementsStore.loadRevision(pkg.projectId);
    const requirementsStale = !latestReqs ||
      latestReqs.requirementsRevision !== pkg.sourceBindings.requirementsRevision ||
      latestReqs.fingerprint !== pkg.sourceBindings.requirementsFingerprint;
    if (requirementsStale) {
      reasons.push(`Requirements revision has changed in authoritative store (package: rev ${pkg.sourceBindings.requirementsRevision}, store: rev ${latestReqs?.requirementsRevision ?? 'none'}).`);
    }

    const latestArch = await this.architectureStore.loadRevision(pkg.projectId);
    const architectureStale = !latestArch ||
      latestArch.architectureRevision !== pkg.sourceBindings.architectureRevision ||
      latestArch.fingerprint !== pkg.sourceBindings.architectureFingerprint;
    if (architectureStale) {
      reasons.push(`Architecture revision has changed in authoritative store (package: rev ${pkg.sourceBindings.architectureRevision}, store: rev ${latestArch?.architectureRevision ?? 'none'}).`);
    }

    const latestBr = await this.businessRulesStore.loadRevision(pkg.projectId);
    const businessRulesStale = !latestBr ||
      latestBr.businessRulesRevision !== pkg.sourceBindings.businessRulesRevision ||
      latestBr.fingerprint !== pkg.sourceBindings.businessRulesFingerprint;
    if (businessRulesStale) {
      reasons.push(`Business rules revision has changed in authoritative store (package: rev ${pkg.sourceBindings.businessRulesRevision}, store: rev ${latestBr?.businessRulesRevision ?? 'none'}).`);
    }

    const latestAc = await this.acceptanceCriteriaStore.loadRevision(pkg.projectId);
    const acceptanceCriteriaStale = !latestAc ||
      latestAc.acceptanceCriteriaRevision !== pkg.sourceBindings.acceptanceCriteriaRevision ||
      latestAc.fingerprint !== pkg.sourceBindings.acceptanceCriteriaFingerprint;
    if (acceptanceCriteriaStale) {
      reasons.push(`Acceptance criteria revision has changed in authoritative store (package: rev ${pkg.sourceBindings.acceptanceCriteriaRevision}, store: rev ${latestAc?.acceptanceCriteriaRevision ?? 'none'}).`);
    }

    const latestRisks = await this.riskStore.loadRevision(pkg.projectId);
    const risksStale = !latestRisks ||
      latestRisks.riskRevision !== pkg.sourceBindings.riskRevision ||
      latestRisks.fingerprint !== pkg.sourceBindings.riskFingerprint;
    if (risksStale) {
      reasons.push(`Risk revision has changed in authoritative store (package: rev ${pkg.sourceBindings.riskRevision}, store: rev ${latestRisks?.riskRevision ?? 'none'}).`);
    }

    const latestSpec = await this.specProjectionStore.loadRevision(pkg.projectId);
    const specStale = !latestSpec ||
      latestSpec.specRevision !== pkg.sourceBindings.specRevision ||
      latestSpec.semanticFingerprint !== pkg.sourceBindings.specFingerprint ||
      latestSpec.isStale === true;
    if (specStale) {
      reasons.push(`PROJECT_SPEC projection is stale or has changed in store (package: rev ${pkg.sourceBindings.specRevision}, store: rev ${latestSpec?.specRevision ?? 'none'}, isStale: ${latestSpec?.isStale}).`);
    }

    const latestCompleteness = latestDiscovery
      ? await this.completenessStore.loadResult(pkg.projectId, latestDiscovery.discoveryRevision)
      : null;
    const completenessStale = !latestCompleteness ||
      latestCompleteness.fingerprint !== pkg.sourceBindings.completenessFingerprint ||
      latestCompleteness.isStale === true;
    if (completenessStale) {
      reasons.push(`Completeness gate result has changed or is stale in store.`);
    }

    const isStale = reasons.length > 0;

    return {
      isStale,
      reasons,
      details: {
        discoveryStale,
        requirementsStale,
        architectureStale,
        businessRulesStale,
        acceptanceCriteriaStale,
        risksStale,
        specStale,
        completenessStale,
        humanDecisionsChanged: false,
      },
    };
  }

  /**
   * Evaluates readiness for human Product Owner approval.
   * Supports both P15 ApprovalPackage and legacy InitialProjectUnderstanding.
   */
  async checkReadinessAsync(pkg: ApprovalPackage): Promise<ApprovalReadiness> {
    const reasons: string[] = [];

    // 1. Verify upstream integrity
    let integrityFailed = false;
    try {
      await this.verifyUpstreamIntegrity(pkg);
    } catch (err: any) {
      integrityFailed = true;
      reasons.push(`Integrity verification failed: ${err.message}`);
    }

    // 2. Check staleness
    const staleReport = await this.checkStaleness(pkg);
    const isStale = staleReport.isStale;
    if (isStale) {
      reasons.push(...staleReport.reasons);
    }

    // 3. Completeness Gate Status Check
    const completenessGateMissing = !pkg.completenessResult;
    let completenessNotComplete = false;

    if (completenessGateMissing) {
      reasons.push('Completeness gate result is missing.');
    } else {
      if (pkg.completenessResult!.status !== 'COMPLETE') {
        completenessNotComplete = true;
        reasons.push(
          `Specification Completeness Gate status is '${pkg.completenessResult!.status}' (must strictly be 'COMPLETE').`
        );
      }
    }

    // 4. Human Decision Points Check
    const unresolvedHDPs = (pkg.unresolvedHumanDecisionPoints ?? []).filter(
      (h: any) => h.status === 'PENDING_DECISION'
    );
    const unresolvedHumanDecisions = unresolvedHDPs.length > 0;
    if (unresolvedHumanDecisions) {
      reasons.push(
        `Project has ${unresolvedHDPs.length} unresolved material Human Decision Point(s) requiring human resolution.`
      );
    }

    // 5. Source missing checks
    const discoveryMissing = !pkg.sourceBindings?.discoveryRevision;
    const requirementsMissing = !pkg.sourceBindings?.requirementsRevision;
    const architectureMissing = !pkg.sourceBindings?.architectureRevision;
    const businessRulesMissing = !pkg.sourceBindings?.businessRulesRevision;
    const acceptanceCriteriaMissing = !pkg.sourceBindings?.acceptanceCriteriaRevision;
    const risksMissing = !pkg.sourceBindings?.riskRevision;
    const specMissing = !pkg.sourceBindings?.specRevision;

    // Determine status
    let status: ProjectApprovalStatus;
    if (integrityFailed || discoveryMissing || requirementsMissing || architectureMissing || businessRulesMissing || acceptanceCriteriaMissing || risksMissing || specMissing || completenessGateMissing || completenessNotComplete) {
      status = 'NOT_READY';
    } else if (isStale) {
      status = 'STALE';
    } else if (unresolvedHumanDecisions || pkg.completenessResult?.status === 'BLOCKED_ON_HUMAN') {
      status = 'BLOCKED_ON_HUMAN';
    } else {
      status = 'READY_FOR_APPROVAL';
    }

    const isReady =
      status === 'READY_FOR_APPROVAL' &&
      !integrityFailed &&
      !isStale &&
      !completenessGateMissing &&
      !completenessNotComplete &&
      !unresolvedHumanDecisions;

    const blockingConditions = {
      discoveryMissing,
      requirementsMissing,
      architectureMissing,
      businessRulesMissing,
      acceptanceCriteriaMissing,
      risksMissing,
      specMissing,
      completenessGateMissing,
      completenessNotComplete,
      unresolvedHumanDecisions,
      isStale,
      integrityFailed,
      crossProjectMismatch: false,
      unresolvedBlockingClarifications: false,
      unresolvedBlockingContradictions: false,
      understandingInvalid: false,
      proposalIncomplete: false,
    };

    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'APPROVAL_READINESS_EVALUATED',
          actor: Actor.ORCHESTRATOR,
          payload: {
            packageId: pkg.packageId,
            revision: pkg.revision,
            projectId: pkg.projectId,
            isReady,
            status,
            reasons,
          },
        });

        if (!isReady) {
          await this.historyManager.appendEvent({
            eventType: 'APPROVAL_BLOCKED',
            actor: Actor.ORCHESTRATOR,
            payload: {
              packageId: pkg.packageId,
              revision: pkg.revision,
              projectId: pkg.projectId,
              reasons,
              blockingConditions,
            },
          });
        }
      } catch {
        // Logging failure should not break evaluation
      }
    }

    return Object.freeze({
      isReady,
      status,
      reasons: Object.freeze(reasons),
      blockingConditions: Object.freeze(blockingConditions),
      isStale,
      sourceBindings: pkg.sourceBindings,
      packageFingerprint: pkg.packageFingerprint,
    });
  }

  /**
   * Synchronous / Legacy readiness check conforming to Phase 8 signature.
   */
  checkReadiness(
    understandingOrPkg: InitialProjectUnderstanding | ApprovalPackage,
    proposedPlan?: ProposedDevelopmentPlan,
    clarificationSession?: ClarificationSession
  ): ApprovalReadiness {
    // If passed a P15 package directly:
    if ('sourceBindings' in understandingOrPkg && (understandingOrPkg as ApprovalPackage).sourceBindings) {
      const pkg = understandingOrPkg as ApprovalPackage & { sourceBindings: ApprovalSourceBindings };
      const reasons: string[] = [];

      const discoveryMissing = !pkg.sourceBindings.discoveryRevision;
      const completenessGateMissing = !pkg.completenessResult;
      const completenessNotComplete = pkg.completenessResult?.status !== 'COMPLETE';
      const unresolvedHDPs = (pkg.unresolvedHumanDecisionPoints ?? []).filter(
        (h: any) => h.status === 'PENDING_DECISION'
      );
      const unresolvedHumanDecisions = unresolvedHDPs.length > 0;
      const isStale = pkg.isStale ?? false;

      if (completenessNotComplete) {
        reasons.push(`Completeness gate status is '${pkg.completenessResult?.status ?? 'MISSING'}'.`);
      }
      if (unresolvedHumanDecisions) {
        reasons.push(`Unresolved human decision points: ${unresolvedHDPs.length}.`);
      }
      if (isStale) {
        reasons.push('Package is marked STALE.');
      }

      let status: ProjectApprovalStatus = 'NOT_READY';
      if (isStale) status = 'STALE';
      else if (unresolvedHumanDecisions || pkg.completenessResult?.status === 'BLOCKED_ON_HUMAN') status = 'BLOCKED_ON_HUMAN';
      else if (!completenessNotComplete && !discoveryMissing) status = 'READY_FOR_APPROVAL';

      const isReady = status === 'READY_FOR_APPROVAL' && !isStale && !unresolvedHumanDecisions;

      return Object.freeze({
        isReady,
        status,
        reasons: Object.freeze(reasons),
        blockingConditions: Object.freeze({
          discoveryMissing,
          requirementsMissing: false,
          architectureMissing: false,
          businessRulesMissing: false,
          acceptanceCriteriaMissing: false,
          risksMissing: false,
          specMissing: false,
          completenessGateMissing,
          completenessNotComplete,
          unresolvedHumanDecisions,
          isStale,
          integrityFailed: false,
          crossProjectMismatch: false,
          unresolvedBlockingClarifications: false,
          unresolvedBlockingContradictions: false,
          understandingInvalid: false,
          proposalIncomplete: false,
        }),
      });
    }

    // Legacy Phase 8 evaluation path
    const understanding = understandingOrPkg as InitialProjectUnderstanding;
    const plan = proposedPlan ?? this.createDefaultProposedPlan(understanding);
    const reasons: string[] = [];

    // Condition 1: Discovery exists
    const discoveryMissing =
      !understanding.sourceDiscoveryReference ||
      understanding.sourceDiscoveryReference.trim().length === 0;
    if (discoveryMissing) {
      reasons.push('Discovery report is missing or invalid; discovery must precede approval.');
    }

    // Condition 2: Blocking clarifications resolved
    let unresolvedBlockingClarifications = false;
    if (clarificationSession) {
      const hasOpenBlocking =
        clarificationSession.blockingOpenCount > 0 ||
        clarificationSession.status === 'WAITING_FOR_HUMAN' ||
        clarificationSession.status === 'BLOCKED';

      const hasBlockingUnansweredQuestion = clarificationSession.questions.some(
        (q) =>
          q.blocking &&
          q.status !== 'ANSWERED' &&
          (!q.answer || q.answer.status !== 'ANSWERED')
      );

      if (hasOpenBlocking || hasBlockingUnansweredQuestion) {
        unresolvedBlockingClarifications = true;
        reasons.push(
          `Clarification session '${clarificationSession.sessionId}' has unresolved blocking questions.`
        );
      }
    }

    // Condition 3: No unresolved blocking contradictions
    const unresolvedBlockingContradictions =
      understanding.unresolvedContradictions &&
      understanding.unresolvedContradictions.length > 0;
    if (unresolvedBlockingContradictions) {
      reasons.push(
        `Project has ${understanding.unresolvedContradictions.length} unresolved blocking contradiction(s).`
      );
    }

    // Condition 4: Understanding package is internally valid
    const understandingInvalid =
      !understanding.projectId ||
      !understanding.projectName ||
      !understanding.technologyStack ||
      !understanding.architectureSummary;
    if (understandingInvalid) {
      reasons.push('Initial project understanding is internally incomplete or invalid.');
    }

    // Condition 5: Proposal is structurally complete
    const proposalIncomplete =
      !plan.objectives ||
      plan.objectives.length === 0 ||
      !plan.proposedScope ||
      plan.proposedScope.length === 0 ||
      !plan.proposedFeatureGroups ||
      plan.proposedFeatureGroups.length === 0;
    if (proposalIncomplete) {
      reasons.push(
        'Proposed development plan is structurally incomplete (must have objectives, proposedScope, and feature groups).'
      );
    }

    const isReady =
      !discoveryMissing &&
      !unresolvedBlockingClarifications &&
      !unresolvedBlockingContradictions &&
      !understandingInvalid &&
      !proposalIncomplete;

    return Object.freeze({
      isReady,
      status: isReady ? 'READY_FOR_APPROVAL' : 'NOT_READY',
      reasons: Object.freeze(reasons),
      blockingConditions: Object.freeze({
        discoveryMissing,
        requirementsMissing: false,
        architectureMissing: false,
        businessRulesMissing: false,
        acceptanceCriteriaMissing: false,
        risksMissing: false,
        specMissing: false,
        completenessGateMissing: false,
        completenessNotComplete: false,
        unresolvedHumanDecisions: false,
        isStale: false,
        integrityFailed: false,
        crossProjectMismatch: false,
        unresolvedBlockingClarifications,
        unresolvedBlockingContradictions,
        understandingInvalid,
        proposalIncomplete,
      }),
    });
  }

  /**
   * Constructs a default, structurally complete proposed development plan
   * from the project understanding without mutating the Task DAG.
   */
  createDefaultProposedPlan(
    understanding: InitialProjectUnderstanding
  ): ProposedDevelopmentPlan {
    const objectives: string[] = [
      `Implement and verify development scope for ${understanding.projectName}`,
      'Establish authoritative requirements and architecture baselines',
      'Execute development under full verification and test coverage',
    ];

    const proposedScope: string[] =
      understanding.proposedDevelopmentScope.length > 0
        ? [...understanding.proposedDevelopmentScope]
        : ['Baseline core capabilities'];

    const proposedFeatureGroups = [
      {
        name: 'Core Capabilities',
        description: `Primary features discovered for ${understanding.projectName}`,
        targetCapabilities: proposedScope,
      },
    ];

    const knownRisks = (understanding.unresolvedUnknowns ?? []).map(
      (u) => `${u.item}: ${u.impact}`
    );

    const unresolvedIssues = (understanding.unresolvedContradictions ?? []).map(
      (c) => c.description
    );

    return Object.freeze({
      objectives: Object.freeze(objectives),
      proposedScope: Object.freeze(proposedScope),
      proposedFeatureGroups: Object.freeze(proposedFeatureGroups),
      dependencies: Object.freeze([]),
      constraints: Object.freeze([...(understanding.constraints ?? [])]),
      knownRisks: Object.freeze(knownRisks),
      unresolvedIssues: Object.freeze(unresolvedIssues),
      excludedScope: Object.freeze([...(understanding.nonGoals ?? [])]),
      suggestedImplementationOrder: Object.freeze([...proposedScope]),
    });
  }

  /**
   * Legacy method for building approval package from InitialProjectUnderstanding.
   */
  buildPackage(
    understanding: InitialProjectUnderstanding,
    proposedPlan?: ProposedDevelopmentPlan,
    options?: CreatePackageOptions
  ): ProjectApprovalPackage {
    const now = new Date().toISOString();
    const packageId =
      options?.packageId ??
      `pkg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const effectivePlan = proposedPlan ?? this.createDefaultProposedPlan(understanding);

    const readiness = this.checkReadiness(
      understanding,
      effectivePlan,
      options?.clarificationSession
    );

    const unresolvedItems = [
      ...(understanding.unresolvedUnknowns ?? []).map((u) => ({
        id: `unk-${u.id}`,
        type: 'UNRESOLVED' as const,
        origin: 'DISCOVERY_EVIDENCE' as const,
        statement: `${u.item}: ${u.description}`,
        evidence: [],
      })),
      ...(understanding.unresolvedContradictions ?? []).map((c) => ({
        id: `contra-${c.id}`,
        type: 'UNRESOLVED' as const,
        origin: 'DISCOVERY_EVIDENCE' as const,
        statement: c.description,
        evidence: [c.sourceA.evidence, c.sourceB.evidence],
      })),
    ];

    const pkg: ProjectApprovalPackage = {
      packageId,
      revision: 1,
      approvalPackageRevision: 1,
      projectId: understanding.projectId,
      projectUnderstanding: understanding,
      proposedDevelopmentPlan: effectivePlan,
      unresolvedItems: Object.freeze(unresolvedItems),
      assumptions: understanding.assumptions ?? [],
      evidenceReferences: understanding.evidenceReferences ?? [],
      clarificationSessionReference: options?.clarificationSession?.sessionId,
      status: readiness.status,
      createdAt: now,
      updatedAt: now,
    };

    const parsed = ApprovalPackageZodSchema.safeParse(pkg);
    if (!parsed.success) {
      throw new ApprovalValidationError(
        `Failed to validate approval package: ${parsed.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { issues: parsed.error.issues }
      );
    }

    return Object.freeze(pkg);
  }

  /**
   * Applies explicit human Product Owner approval to a specific package revision.
   */
  /**
   * Applies explicit human Product Owner approval to a specific package revision.
   */
  approvePackage(
    pkg: ApprovalPackage,
    input: ProjectApprovalInput
  ): ApprovalPackage {
    // 1. Revision binding check
    if (input.revision !== pkg.revision) {
      throw new ApprovalRevisionMismatchError(
        `Approval revision mismatch: package revision is ${pkg.revision}, but approval input specified ${input.revision}. Approvals must bind to the exact revision.`,
        { packageId: pkg.packageId, currentRevision: pkg.revision, requestedRevision: input.revision }
      );
    }

    // 2. Status / Replay check: cannot approve already decided packages
    if (pkg.status === 'APPROVED') {
      throw new ApprovalAlreadyDecidedError(
        `Cannot approve package '${pkg.packageId}': package is already in status 'APPROVED'. Duplicate approval requests are rejected.`,
        { packageId: pkg.packageId, status: pkg.status, revision: pkg.revision }
      );
    }

    if (pkg.status === 'REJECTED') {
      throw new ApprovalAlreadyDecidedError(
        `Cannot approve package '${pkg.packageId}': package is already in status 'REJECTED'. A rejected package cannot be approved directly; a new revision must be created.`,
        { packageId: pkg.packageId, status: pkg.status, revision: pkg.revision }
      );
    }

    if (pkg.status === 'SUPERSEDED') {
      throw new ApprovalAlreadyDecidedError(
        `Cannot approve package '${pkg.packageId}': package is in status 'SUPERSEDED'.`,
        { packageId: pkg.packageId, status: pkg.status, revision: pkg.revision }
      );
    }

    if (pkg.status === 'STALE' || pkg.isStale === true) {
      throw new ApprovalStaleError(
        `Cannot approve package '${pkg.packageId}': package is STALE. A new approval revision must be created.`,
        ['Package is marked STALE'],
        { packageId: pkg.packageId, revision: pkg.revision }
      );
    }

    if (pkg.status === 'BLOCKED_ON_HUMAN') {
      throw new ApprovalBlockedOnHumanError(
        `Cannot approve package '${pkg.packageId}': package is BLOCKED_ON_HUMAN.`,
        (pkg.unresolvedHumanDecisionPoints ?? []).map((h: any) => h.question ?? h.title ?? h.id ?? 'unresolved decision'),
        { packageId: pkg.packageId }
      );
    }

    // 3. Actor authorization check: must strictly be human Product Owner (PRODUCT_OWNER or USER)
    this.validateApprovalActor(input.actor, input.actorRole);

    // 4. Intent check: must strictly be EXPLICIT_APPROVAL
    this.validateApprovalIntent(input.intent);

    // 5. Readiness and Upstream Integrity evaluation (if P15 package)
    if (pkg.sourceBindings) {
      // 5a. Integrity check & disk verification: fails closed on forged package or recomputed fingerprint
      this.verifyUpstreamIntegritySync(pkg);

      // 5b. Completeness Gate check: must strictly be COMPLETE
      if (!pkg.completenessResult || pkg.completenessResult.status !== 'COMPLETE') {
        throw new ApprovalCompletenessGateFailedError(
          `Cannot approve package '${pkg.packageId}': Specification Completeness Gate status is '${pkg.completenessResult?.status ?? 'MISSING'}'. Gate must be COMPLETE before approval.`,
          { packageId: pkg.packageId, completenessStatus: pkg.completenessResult?.status }
        );
      }

      // 5c. Unresolved Human Decisions check: must be 0 pending HDPs
      const unresolvedHDPs = (pkg.unresolvedHumanDecisionPoints ?? []).filter(
        (h: any) => h.status === 'PENDING_DECISION'
      );
      if (unresolvedHDPs.length > 0) {
        throw new ApprovalBlockedOnHumanError(
          `Cannot approve package '${pkg.packageId}': project has ${unresolvedHDPs.length} unresolved material Human Decision Point(s). All required decisions must be resolved by Product Owner prior to approval.`,
          unresolvedHDPs.map((h: any) => h.question ?? h.title ?? h.id),
          { packageId: pkg.packageId, unresolvedCount: unresolvedHDPs.length }
        );
      }
    } else {
      // Legacy package status check
      if (pkg.status === 'NOT_READY') {
        const readiness = this.checkReadiness(
          pkg.projectUnderstanding ?? ({} as any),
          pkg.proposedDevelopmentPlan ?? ({} as any)
        );
        throw new ApprovalNotReadyError(
          `Cannot approve package '${pkg.packageId}': package is in status NOT_READY. Reasons: ${readiness.reasons.join('; ')}`,
          readiness.reasons,
          { packageId: pkg.packageId, revision: pkg.revision }
        );
      }
    }

    const now = input.timestamp ?? new Date().toISOString();
    const packageHash = pkg.packageFingerprint ?? computePackageHash(pkg as any);

    const approvalRecord: ProjectApprovalRecord = Object.freeze({
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: input.actor,
      actorRole: input.actorRole,
      intent: 'EXPLICIT_APPROVAL',
      comment: input.comment,
      approvedAt: now,
      packageHash,
      ...(input.directorSessionId ? { directorSessionId: input.directorSessionId } : {}),
      ...(input.contextFingerprint ? { contextFingerprint: input.contextFingerprint } : {}),
      ...(input.understandingRevision !== undefined ? { understandingRevision: input.understandingRevision } : {}),
      ...(input.protocolVersion ? { protocolVersion: input.protocolVersion } : {}),
      ...(input.schemaVersion ? { schemaVersion: input.schemaVersion } : {}),
    });

    const approvedPkg: ApprovalPackage = Object.freeze({
      ...pkg,
      status: 'APPROVED',
      approvalRecord,
      updatedAt: now,
      history: [
        ...(pkg.history ?? []),
        {
          eventType: 'APPROVAL_EXPLICITLY_GRANTED',
          actor: input.actor,
          actorRole: input.actorRole,
          timestamp: now,
          status: 'APPROVED',
          revision: pkg.revision,
          details: { comment: input.comment },
        },
      ],
    });

    return approvedPkg;
  }

  /**
   * Applies explicit human Product Owner rejection to a specific package revision.
   */
  rejectPackage(
    pkg: ApprovalPackage,
    input: ProjectRejectionInput
  ): ApprovalPackage {
    // 1. Revision binding check
    if (input.revision !== pkg.revision) {
      throw new ApprovalRevisionMismatchError(
        `Rejection revision mismatch: package revision is ${pkg.revision}, but rejection input specified ${input.revision}.`,
        { packageId: pkg.packageId, currentRevision: pkg.revision, requestedRevision: input.revision }
      );
    }

    // 2. Status check: cannot reject already decided packages
    if (pkg.status === 'APPROVED' || pkg.status === 'SUPERSEDED') {
      throw new ApprovalAlreadyDecidedError(
        `Cannot reject package '${pkg.packageId}': package is already in status '${pkg.status}'.`,
        { packageId: pkg.packageId, status: pkg.status, revision: pkg.revision }
      );
    }

    // 3. Actor authorization check
    this.validateApprovalActor(input.actor, input.actorRole);

    // 4. Intent check: must strictly be EXPLICIT_REJECTION
    if (input.intent !== 'EXPLICIT_REJECTION') {
      throw new ApprovalInvalidIntentError(
        `Invalid rejection intent: '${input.intent}'. Must be strictly 'EXPLICIT_REJECTION'.`,
        { intent: input.intent }
      );
    }

    const now = input.timestamp ?? new Date().toISOString();
    const packageHash = pkg.packageFingerprint ?? computePackageHash(pkg as any);

    const rejectionRecord: ProjectRejectionRecord = Object.freeze({
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: input.actor,
      actorRole: input.actorRole,
      intent: 'EXPLICIT_REJECTION',
      reason: input.reason,
      rejectedAt: now,
      packageHash,
    });

    const rejectedPkg: ApprovalPackage = Object.freeze({
      ...pkg,
      status: 'REJECTED',
      rejectionRecord,
      updatedAt: now,
      history: [
        ...(pkg.history ?? []),
        {
          eventType: 'APPROVAL_EXPLICITLY_REJECTED',
          actor: input.actor,
          actorRole: input.actorRole,
          timestamp: now,
          status: 'REJECTED',
          revision: pkg.revision,
          details: { reason: input.reason },
        },
      ],
    });

    return rejectedPkg;
  }

  /**
   * Synchronously verifies upstream integrity of an ApprovalPackage against authoritative stores.
   * Fails closed if the package is forged, has recomputed forged fingerprints, or has altered content.
   */
  verifyUpstreamIntegritySync(pkg: ApprovalPackage): void {
    if (!pkg.sourceBindings) return;

    // 1. Self-consistency check
    const expectedFingerprint = computePackageFingerprint(pkg);
    if (pkg.packageFingerprint && pkg.packageFingerprint !== expectedFingerprint) {
      throw new ApprovalForgedFingerprintError(
        `Approval package '${pkg.packageId}' fingerprint mismatch. Recorded: '${pkg.packageFingerprint}', recomputed: '${expectedFingerprint}'. Tampered package rejected.`,
        { packageId: pkg.packageId, recordedFingerprint: pkg.packageFingerprint, recomputedFingerprint: expectedFingerprint }
      );
    }

    const safeProjectId = this.discoveryStore.sanitizeProjectId(pkg.projectId);

    // 2. Authoritative Discovery verification
    const discLatestPath = path.join(this.discoveryStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(discLatestPath)) {
      try {
        const discLatest = JSON.parse(fs.readFileSync(discLatestPath, 'utf8'));
        const discLatestRev = discLatest.discoveryRevision ?? discLatest.revision;
        if (discLatestRev !== pkg.sourceBindings.discoveryRevision || discLatest.fingerprint !== pkg.sourceBindings.discoveryFingerprint) {
          throw new ApprovalStaleError(
            `Discovery revision has changed in authoritative store (package: rev ${pkg.sourceBindings.discoveryRevision}, store: rev ${discLatestRev}).`,
            [`Discovery store rev ${discLatestRev} !== package rev ${pkg.sourceBindings.discoveryRevision}`]
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError) throw err;
      }
    }
    const discRevPath = path.join(this.discoveryStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.discoveryRevision}.json`);
    if (fs.existsSync(discRevPath)) {
      const discRev = JSON.parse(fs.readFileSync(discRevPath, 'utf8'));
      if (discRev.fingerprint !== pkg.sourceBindings.discoveryFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails discovery integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'discovery', recorded: pkg.sourceBindings.discoveryFingerprint, actual: discRev.fingerprint }
        );
      }
    }

    // 3. Authoritative Requirements verification
    const reqLatestPath = path.join(this.requirementsStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(reqLatestPath)) {
      try {
        const reqLatest = JSON.parse(fs.readFileSync(reqLatestPath, 'utf8'));
        const reqLatestRev = reqLatest.requirementsRevision ?? reqLatest.revision;
        if (reqLatestRev !== pkg.sourceBindings.requirementsRevision || reqLatest.fingerprint !== pkg.sourceBindings.requirementsFingerprint) {
          throw new ApprovalStaleError(
            `Requirements revision has changed in authoritative store (package: rev ${pkg.sourceBindings.requirementsRevision}, store: rev ${reqLatestRev}).`,
            [`Requirements store rev ${reqLatestRev} !== package rev ${pkg.sourceBindings.requirementsRevision}`]
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError) throw err;
      }
    }
    const reqRevPath = path.join(this.requirementsStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.requirementsRevision}.json`);
    if (fs.existsSync(reqRevPath)) {
      const reqRev = JSON.parse(fs.readFileSync(reqRevPath, 'utf8'));
      if (reqRev.fingerprint !== pkg.sourceBindings.requirementsFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails requirements integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'requirements', recorded: pkg.sourceBindings.requirementsFingerprint, actual: reqRev.fingerprint }
        );
      }
    }

    // 4. Authoritative Architecture verification
    const archLatestPath = path.join(this.architectureStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(archLatestPath)) {
      try {
        const archLatest = JSON.parse(fs.readFileSync(archLatestPath, 'utf8'));
        const archLatestRev = archLatest.architectureRevision ?? archLatest.revision;
        if (archLatestRev !== pkg.sourceBindings.architectureRevision || archLatest.fingerprint !== pkg.sourceBindings.architectureFingerprint) {
          throw new ApprovalStaleError(
            `Architecture revision has changed in authoritative store (package: rev ${pkg.sourceBindings.architectureRevision}, store: rev ${archLatestRev}).`,
            [`Architecture store rev ${archLatestRev} !== package rev ${pkg.sourceBindings.architectureRevision}`]
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError) throw err;
      }
    }
    const archRevPath = path.join(this.architectureStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.architectureRevision}.json`);
    if (fs.existsSync(archRevPath)) {
      const archRev = JSON.parse(fs.readFileSync(archRevPath, 'utf8'));
      if (archRev.fingerprint !== pkg.sourceBindings.architectureFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails architecture integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'architecture', recorded: pkg.sourceBindings.architectureFingerprint, actual: archRev.fingerprint }
        );
      }
    }

    // 5. Authoritative Business Rules verification
    const brLatestPath = path.join(this.businessRulesStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(brLatestPath)) {
      try {
        const brLatest = JSON.parse(fs.readFileSync(brLatestPath, 'utf8'));
        const brLatestRev = brLatest.businessRulesRevision ?? brLatest.revision;
        if (brLatestRev !== pkg.sourceBindings.businessRulesRevision || brLatest.fingerprint !== pkg.sourceBindings.businessRulesFingerprint) {
          throw new ApprovalStaleError(
            `Business rules revision has changed in authoritative store (package: rev ${pkg.sourceBindings.businessRulesRevision}, store: rev ${brLatestRev}).`,
            [`Business rules store rev ${brLatestRev} !== package rev ${pkg.sourceBindings.businessRulesRevision}`]
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError) throw err;
      }
    }
    const brRevPath = path.join(this.businessRulesStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.businessRulesRevision}.json`);
    if (fs.existsSync(brRevPath)) {
      const brRev = JSON.parse(fs.readFileSync(brRevPath, 'utf8'));
      if (brRev.fingerprint !== pkg.sourceBindings.businessRulesFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails business rules integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'businessRules', recorded: pkg.sourceBindings.businessRulesFingerprint, actual: brRev.fingerprint }
        );
      }
    }

    // 6. Authoritative Acceptance Criteria verification
    const acLatestPath = path.join(this.acceptanceCriteriaStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(acLatestPath)) {
      try {
        const acLatest = JSON.parse(fs.readFileSync(acLatestPath, 'utf8'));
        const acLatestRev = acLatest.acceptanceCriteriaRevision ?? acLatest.revision;
        if (acLatestRev !== pkg.sourceBindings.acceptanceCriteriaRevision || acLatest.fingerprint !== pkg.sourceBindings.acceptanceCriteriaFingerprint) {
          throw new ApprovalStaleError(
            `Acceptance criteria revision has changed in authoritative store (package: rev ${pkg.sourceBindings.acceptanceCriteriaRevision}, store: rev ${acLatestRev}).`,
            [`Acceptance criteria store rev ${acLatestRev} !== package rev ${pkg.sourceBindings.acceptanceCriteriaRevision}`]
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError) throw err;
      }
    }
    const acRevPath = path.join(this.acceptanceCriteriaStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.acceptanceCriteriaRevision}.json`);
    if (fs.existsSync(acRevPath)) {
      const acRev = JSON.parse(fs.readFileSync(acRevPath, 'utf8'));
      if (acRev.fingerprint !== pkg.sourceBindings.acceptanceCriteriaFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails acceptance criteria integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'acceptanceCriteria', recorded: pkg.sourceBindings.acceptanceCriteriaFingerprint, actual: acRev.fingerprint }
        );
      }
    }

    // 7. Authoritative Risk & HDP verification
    const riskLatestPath = path.join(this.riskStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(riskLatestPath)) {
      try {
        const riskLatest = JSON.parse(fs.readFileSync(riskLatestPath, 'utf8'));
        const riskLatestRev = riskLatest.riskRevision ?? riskLatest.revision;
        if (riskLatestRev !== pkg.sourceBindings.riskRevision || riskLatest.fingerprint !== pkg.sourceBindings.riskFingerprint) {
          throw new ApprovalStaleError(
            `Risk revision has changed in authoritative store (package: rev ${pkg.sourceBindings.riskRevision}, store: rev ${riskLatestRev}).`,
            [`Risk store rev ${riskLatestRev} !== package rev ${pkg.sourceBindings.riskRevision}`]
          );
        }
        const storeUnresolved = (riskLatest.humanDecisionPoints ?? []).filter((h: any) => h.status === 'PENDING_DECISION');
        if (storeUnresolved.length > 0 && (!pkg.unresolvedHumanDecisionPoints || pkg.unresolvedHumanDecisionPoints.length === 0)) {
          throw new ApprovalIntegrityError(
            `Approval package integrity violation: package claims 0 unresolved decisions, but authoritative risk store contains ${storeUnresolved.length} pending decision(s). Forged package rejected.`,
            { source: 'risks', storePending: storeUnresolved.length, packagePending: 0 }
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError || err instanceof ApprovalIntegrityError) throw err;
      }
    }
    const riskRevPath = path.join(this.riskStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.riskRevision}.json`);
    if (fs.existsSync(riskRevPath)) {
      const riskRev = JSON.parse(fs.readFileSync(riskRevPath, 'utf8'));
      if (riskRev.fingerprint !== pkg.sourceBindings.riskFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails risk integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'risks', recorded: pkg.sourceBindings.riskFingerprint, actual: riskRev.fingerprint }
        );
      }
    }

    // 8. Authoritative Project Spec verification
    const specLatestPath = path.join(this.specProjectionStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(specLatestPath)) {
      try {
        const specLatest = JSON.parse(fs.readFileSync(specLatestPath, 'utf8'));
        if (specLatest.specRevision !== pkg.sourceBindings.specRevision || specLatest.semanticFingerprint !== pkg.sourceBindings.specFingerprint || specLatest.isStale) {
          throw new ApprovalStaleError(
            `PROJECT_SPEC projection is stale or has changed in store (package: rev ${pkg.sourceBindings.specRevision}, store: rev ${specLatest.specRevision}).`,
            [`PROJECT_SPEC store rev ${specLatest.specRevision} !== package rev ${pkg.sourceBindings.specRevision}`]
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError) throw err;
      }
    }
    const specRevPath = path.join(this.specProjectionStore.recordsDir, safeProjectId, `rev-${pkg.sourceBindings.specRevision}.json`);
    if (fs.existsSync(specRevPath)) {
      const specRev = JSON.parse(fs.readFileSync(specRevPath, 'utf8'));
      if (specRev.semanticFingerprint !== pkg.sourceBindings.specFingerprint) {
        throw new ApprovalIntegrityError(
          `Approval package fails PROJECT_SPEC projection integrity: recorded fingerprint does not match authoritative store.`,
          { source: 'specProjection', recorded: pkg.sourceBindings.specFingerprint, actual: specRev.semanticFingerprint }
        );
      }
    }

    // 9. Authoritative Completeness Gate verification
    const compLatestPath = path.join(this.completenessStore.recordsDir, safeProjectId, 'latest.json');
    if (fs.existsSync(compLatestPath)) {
      try {
        const compLatest = JSON.parse(fs.readFileSync(compLatestPath, 'utf8'));
        if (compLatest.fingerprint !== pkg.sourceBindings.completenessFingerprint || compLatest.isStale) {
          throw new ApprovalStaleError(
            `Completeness gate result has changed or is stale in store.`,
            [`Completeness store fingerprint !== package completenessFingerprint`]
          );
        }
        if (compLatest.status !== 'COMPLETE') {
          throw new ApprovalCompletenessGateFailedError(
            `Authoritative completeness gate status is '${compLatest.status}' in store. Gate must be COMPLETE before approval.`,
            { packageId: pkg.packageId, completenessStatus: compLatest.status }
          );
        }
        if (compLatest.status !== pkg.completenessResult?.status) {
          throw new ApprovalIntegrityError(
            `Approval package integrity violation: package claims completeness status '${pkg.completenessResult?.status}' but authoritative completeness store has '${compLatest.status}'. Forged package rejected.`,
            { source: 'completeness', storeStatus: compLatest.status, packageStatus: pkg.completenessResult?.status }
          );
        }
      } catch (err) {
        if (err instanceof ApprovalStaleError || err instanceof ApprovalIntegrityError || err instanceof ApprovalCompletenessGateFailedError) throw err;
      }
    }
  }

  /**
   * Revises an existing package with updated sources or understanding.
   * Produces a SUPERSEDED previous revision and a brand new revision (N+1)
   * requiring its own explicit approval.
   */
  revisePackage(
    currentPkg: ApprovalPackage,
    updates?: {
      understanding?: InitialProjectUnderstanding;
      proposedPlan?: ProposedDevelopmentPlan;
    },
    clarificationSession?: ClarificationSession
  ): {
    supersededPackage: ApprovalPackage;
    newPackage: ApprovalPackage;
  } {
    const now = new Date().toISOString();

    const supersededPackage: ApprovalPackage = Object.freeze({
      ...currentPkg,
      status: 'SUPERSEDED',
      updatedAt: now,
      history: [
        ...(currentPkg.history ?? []),
        {
          eventType: 'APPROVAL_PACKAGE_SUPERSEDED',
          actor: 'SYSTEM',
          timestamp: now,
          status: 'SUPERSEDED',
          revision: currentPkg.revision,
        },
      ],
    });

    // Legacy / Phase 8 & P15 package revision
    const updatedUnderstanding = updates?.understanding ?? currentPkg.projectUnderstanding!;
    const updatedPlan = updates?.proposedPlan ?? currentPkg.proposedDevelopmentPlan!;

    const readiness = this.checkReadiness(
      updatedUnderstanding,
      updatedPlan,
      clarificationSession
    );

    const newPackageBase: ApprovalPackage = Object.freeze({
      ...currentPkg,
      packageId: currentPkg.packageId,
      revision: currentPkg.revision + 1,
      approvalPackageRevision: currentPkg.revision + 1,
      projectId: updatedUnderstanding.projectId,
      projectUnderstanding: updatedUnderstanding,
      proposedDevelopmentPlan: updatedPlan,
      unresolvedItems: currentPkg.unresolvedItems,
      assumptions: updatedUnderstanding.assumptions,
      evidenceReferences: updatedUnderstanding.evidenceReferences,
      clarificationSessionReference: clarificationSession?.sessionId ?? currentPkg.clarificationSessionReference,
      status: readiness.status,
      approvalRecord: undefined, // New revision is NOT approved
      rejectionRecord: undefined,
      createdAt: currentPkg.createdAt,
      updatedAt: now,
      history: [
        ...(supersededPackage.history ?? []),
        {
          eventType: 'APPROVAL_PACKAGE_REVISED',
          actor: 'SYSTEM',
          timestamp: now,
          status: readiness.status,
          revision: currentPkg.revision + 1,
        },
      ],
    });

    const packageFingerprint = computePackageFingerprint(newPackageBase);
    const newPackage = Object.freeze({
      ...newPackageBase,
      packageFingerprint,
    });

    return { supersededPackage, newPackage };
  }

  /**
   * Returns whether development is formally authorized under this approval package.
   * Development is ONLY authorized if status is APPROVED with a valid human approval record
   * and the package is not stale.
   */
  isDevelopmentAuthorized(pkg: ApprovalPackage): boolean {
    if (pkg.status !== 'APPROVED') {
      return false;
    }
    if (!pkg.approvalRecord) {
      return false;
    }
    if (pkg.approvalRecord.intent !== 'EXPLICIT_APPROVAL') {
      return false;
    }
    if (pkg.approvalRecord.revision !== pkg.revision) {
      return false;
    }
    if (pkg.isStale === true) {
      return false;
    }
    if (pkg.approvalRecord.actorRole !== 'PRODUCT_OWNER' && pkg.approvalRecord.actorRole !== 'USER') {
      return false;
    }
    return true;
  }

  /**
   * Authoritative asynchronous check for development authorization.
   * Verifies that the package is APPROVED, human PO approval record is valid,
   * not explicitly marked stale, AND that upstream authoritative store bindings
   * are fresh and match current project state.
   */
  async isDevelopmentAuthorizedAsync(pkg: ApprovalPackage): Promise<boolean> {
    if (!this.isDevelopmentAuthorized(pkg)) {
      return false;
    }
    if (pkg.sourceBindings) {
      try {
        const staleReport = await this.checkStaleness(pkg);
        if (staleReport.isStale) {
          return false;
        }
      } catch {
        // Fail closed on store inspection failure
        return false;
      }
    }
    return true;
  }

  /**
   * Validates that the actor claiming approval authority is strictly human Product Owner.
   */
  validateApprovalActor(actor: string, actorRole: string): void {
    if (!actor || typeof actor !== 'string' || actor.trim().length === 0) {
      throw new ApprovalAuthorizationError('Approval actor cannot be empty.');
    }

    const normalizedActor = actor.trim().toUpperCase();
    for (const forbidden of FORBIDDEN_APPROVAL_ACTORS) {
      if (normalizedActor === forbidden || normalizedActor.includes(forbidden)) {
        throw new ApprovalAuthorizationError(
          `Unauthorized approval actor: '${actor}'. Only human Product Owner (PRODUCT_OWNER / USER) may authorize project understanding and development. Rejected forbidden actor '${forbidden}'.`,
          { actor, forbiddenActor: forbidden }
        );
      }
    }

    if (actorRole !== 'PRODUCT_OWNER' && actorRole !== 'USER') {
      throw new ApprovalAuthorizationError(
        `Invalid actorRole: '${actorRole}'. Must be strictly 'PRODUCT_OWNER' or 'USER'. Actors '${actorRole}' cannot grant Product Owner approval.`,
        { actorRole }
      );
    }
  }

  /**
   * Validates that the approval intent is explicit and rejects natural language ambiguities.
   */
  validateApprovalIntent(intent: string): void {
    if (intent !== 'EXPLICIT_APPROVAL') {
      throw new ApprovalInvalidIntentError(
        `Invalid approval intent: '${intent}'. Approval must be strictly explicit ('EXPLICIT_APPROVAL'). Natural language signals ('tamam', 'olur', 'yes', 'ok', 'anladım', 'devam', 'güzel') are NOT approval.`,
        { intent }
      );
    }
  }
}

/**
 * Convenience helper to check if development is authorized under an approval package.
 */
export function isDevelopmentAuthorized(pkg: ApprovalPackage): boolean {
  return new ApprovalPackageEngine().isDevelopmentAuthorized(pkg);
}

/**
 * Convenience helper to asynchronously check development authorization against authoritative freshness.
 */
export async function isDevelopmentAuthorizedAsync(
  pkg: ApprovalPackage,
  engine?: ApprovalPackageEngine
): Promise<boolean> {
  const effectiveEngine = engine ?? new ApprovalPackageEngine();
  return effectiveEngine.isDevelopmentAuthorizedAsync(pkg);
}
