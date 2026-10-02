/**
 * Requirements & Scope Definition Engine (Phase 15 TASK-P15-03)
 *
 * Transforms discovered project understanding into an explicit, structured,
 * revisioned Requirements / Scope specification for Project Initiation.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-03 transforms discovery into an authoritative Requirements/Scope artifact.
 * 2. Does NOT approve the project, authorize development, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine.
 * 4. Scope semantics strictly distinguish IN_SCOPE, OUT_OF_SCOPE, and UNDECIDED / PENDING_DECISION.
 * 5. Strictly deterministic: identical discovery revision produces identical requirements/scope.
 * 6. Revision-bound: immutable by revision, protects against stale discovery revisions.
 * 7. Fails closed on cross-project mismatches or forged fingerprints.
 */

import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import { CompletenessGateStore } from './completeness-gate-store.js';
import { RequirementsScopeStore } from './requirements-scope-store.js';
import {
  RequirementsScopeInputZodSchema,
  type ProjectRequirementsScopeRevision,
  type RequirementsScopeInput,
  type ScopeStatus,
  type UndecidedScopeItem,
  type FunctionalRequirementScopeItem,
  type ScopeAssumption,
  type ScopeOpenQuestion,
  type ScopeHumanDecision,
} from './requirements-scope-types.js';
import {
  type ProjectDiscoveryRevision,
  type DiscoveryQuestion,
  type HumanDecisionPoint,
} from './adaptive-discovery-types.js';
import {
  RequirementsScopeValidationError,
  RequirementsScopeRevisionNotFoundError,
  RequirementsScopeProjectBindingMismatchError,
  RequirementsScopeStaleSourceError,
  RequirementsScopeForgedFingerprintError,
} from './requirements-scope-errors.js';
import {
  computeDeterministicFingerprint,
  computeDeterministicHash,
  createDeterministicRequirementId,
} from './adaptive-discovery-normalizer.js';

export interface RequirementsScopeEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessStore?: CompletenessGateStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export class RequirementsScopeEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly completenessStore: CompletenessGateStore;
  readonly requirementsStore: RequirementsScopeStore;
  private readonly historyManager?: HistoryManager;
  private readonly specStore?: SpecStore;

  constructor(options?: RequirementsScopeEngineOptions) {
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

    this.completenessStore =
      options?.completenessStore ??
      new CompletenessGateStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.requirementsStore =
      options?.requirementsStore ??
      new RequirementsScopeStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });
  }

  /**
   * Derives an authoritative, revisioned Requirements & Scope specification from discovery data.
   */
  async derive(input: RequirementsScopeInput): Promise<ProjectRequirementsScopeRevision> {
    const parsedInput = RequirementsScopeInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new RequirementsScopeValidationError(
        `Invalid requirements/scope input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    const safeProjectId = this.requirementsStore.sanitizeProjectId(input.projectId);

    // 1. Load authoritative source discovery revision
    const discoveryRevision = await this.discoveryStore.loadRevision(
      safeProjectId,
      input.discoveryRevision
    );

    if (!discoveryRevision) {
      throw new RequirementsScopeRevisionNotFoundError(
        `Discovery revision ${input.discoveryRevision !== undefined ? input.discoveryRevision : 'latest'} not found for project '${input.projectId}'.`,
        { projectId: input.projectId, requestedRevision: input.discoveryRevision }
      );
    }

    // 2. Cross-project isolation check
    if (discoveryRevision.projectId !== input.projectId) {
      throw new RequirementsScopeProjectBindingMismatchError(
        `Cross-project mismatch: requested derivation for '${input.projectId}' but discovery record belongs to '${discoveryRevision.projectId}'.`,
        { requestedProjectId: input.projectId, recordProjectId: discoveryRevision.projectId }
      );
    }

    // 3. Forged fingerprint check
    if (
      input.expectedDiscoveryFingerprint &&
      input.expectedDiscoveryFingerprint !== discoveryRevision.fingerprint
    ) {
      throw new RequirementsScopeForgedFingerprintError(
        `Discovery fingerprint mismatch: expected '${input.expectedDiscoveryFingerprint}' but authoritative discovery fingerprint is '${discoveryRevision.fingerprint}'.`,
        {
          expected: input.expectedDiscoveryFingerprint,
          actual: discoveryRevision.fingerprint,
        }
      );
    }

    // 4. Stale discovery source check
    const latestDiscoveryRevNumber = await this.discoveryStore.getLatestRevisionNumber(safeProjectId);
    if (latestDiscoveryRevNumber > discoveryRevision.discoveryRevision) {
      throw new RequirementsScopeStaleSourceError(
        `Cannot derive requirements from stale discovery revision ${discoveryRevision.discoveryRevision}; latest discovery revision is ${latestDiscoveryRevNumber}.`,
        {
          projectId: input.projectId,
          staleRevision: discoveryRevision.discoveryRevision,
          latestRevision: latestDiscoveryRevNumber,
        }
      );
    }

    return this.deriveFromDiscoveryRevision(discoveryRevision, input.additionalAssumptions);
  }

  /**
   * Deterministically derives requirements and scope directly from a ProjectDiscoveryRevision.
   */
  async deriveFromDiscoveryRevision(
    discovery: ProjectDiscoveryRevision,
    additionalAssumptions?: ScopeAssumption[]
  ): Promise<ProjectRequirementsScopeRevision> {
    const sections = discovery.sections;

    // 1. Project Purpose Extraction
    const id = sections.projectIdentity;
    const purpose = id.purpose;
    const problemStatement = `Problem addressed by ${id.name}: deliver ${id.purpose.toLowerCase()}`;
    const desiredOutcome = id.desiredOutcome;
    const measurableObjective =
      sections.acceptance.measurableCriteria && sections.acceptance.measurableCriteria.length > 0
        ? sections.acceptance.measurableCriteria[0]
        : undefined;

    // 2. Target Users / Actors Extraction
    const targetUsersRaw = sections.productScope.targetUsers ?? [];
    const primaryUsers = [...new Set(targetUsersRaw)].sort();
    const secondaryUsers: string[] = [];
    const systemActors: string[] = ['System'];
    const externalActors: string[] = [];

    if (sections.architecture.integrationRequirements && sections.architecture.integrationRequirements.length > 0) {
      for (const req of sections.architecture.integrationRequirements) {
        externalActors.push(`External Service (${req})`);
      }
    }
    externalActors.sort();

    // 3. Pending Human Decisions Extraction (NEVER silently resolved)
    const rawDecisions = discovery.decisions ?? sections.humanDecisions ?? [];
    const pendingHumanDecisions: ScopeHumanDecision[] = [];

    for (const d of rawDecisions) {
      if (['PENDING_DECISION', 'UNDECIDED', 'PROPOSED', 'OPEN'].includes(d.status)) {
        pendingHumanDecisions.push({
          decisionId: d.id,
          title: d.title,
          description: d.description,
          affectedAreas: [...d.affectedAreas].sort(),
          availableOptions: [...(d.alternatives ?? [])].sort(),
          recommendedOption: d.recommendedOption,
          authority: Actor.USER,
          status: (d.status === 'CONFIRMED' || d.status === 'DECIDED') ? 'CONFIRMED' : (d.status as any),
        });
      }
    }
    pendingHumanDecisions.sort((a, b) => a.decisionId.localeCompare(b.decisionId));

    // 4. Undecided Scope Items (Items requiring Product Owner choice)
    const undecidedScope: UndecidedScopeItem[] = [];

    for (const d of pendingHumanDecisions) {
      undecidedScope.push({
        id: `SCOPE-UNDECIDED-${d.decisionId}`,
        topic: d.title,
        description: d.description,
        availableOptions: d.availableOptions,
        status: (d.status === 'UNDECIDED' || d.status === 'PROPOSED' || d.status === 'PENDING_DECISION') ? d.status : 'PENDING_DECISION',
        whyItMatters: `Product Owner decision required before committing to scope: ${d.title}`,
        affectedAreas: d.affectedAreas,
      });
    }

    // Add any blocking questions affecting scope to undecidedScope if not already represented
    const rawQuestions = discovery.openQuestions ?? sections.openQuestions ?? [];
    for (const q of rawQuestions) {
      if (
        q.status !== 'RESOLVED' &&
        q.classification === 'BLOCKING' &&
        q.options &&
        q.options.length >= 2
      ) {
        const alreadyCovered = undecidedScope.some(
          (u) => u.topic.toLowerCase() === q.question.toLowerCase()
        );
        if (!alreadyCovered) {
          undecidedScope.push({
            id: `SCOPE-UNDECIDED-${q.id}`,
            topic: q.question,
            description: q.whyItMatters,
            availableOptions: [...q.options].sort(),
            status: (q.status === 'UNDECIDED' || q.status === 'PROPOSED') ? q.status : 'PENDING_DECISION',
            whyItMatters: q.whyItMatters,
            affectedAreas: [...q.whatItAffects].sort(),
          });
        }
      }
    }
    undecidedScope.sort((a, b) => a.id.localeCompare(b.id));

    // 5. In-Scope Extraction
    const inScopeRawCapabilities = [
      ...(sections.productScope.inScope ?? []),
      ...(sections.functionalRequirements.capabilities ?? []).map((c) => c.title),
    ];
    // Exclude undecided scope items from confirmed in-scope
    const inScopeCapabilities = [
      ...new Set(
        inScopeRawCapabilities.filter(
          (c) => !undecidedScope.some((u) => u.topic.toLowerCase().includes(c.toLowerCase()))
        )
      ),
    ].sort();

    const inScopeWorkflows = [...new Set(sections.productScope.primaryWorkflows ?? [])].sort();
    const isPlatformUndecided = undecidedScope.some(
      (u) => u.topic.toLowerCase().includes('platform') || u.topic.toLowerCase().includes('interface') || u.topic.toLowerCase().includes('ui')
    );
    const inScopePlatforms = isPlatformUndecided
      ? []
      : [...new Set(sections.technology.platformConstraints ?? [])].sort();
    const inScopeIntegrations = [...new Set(sections.architecture.integrationRequirements ?? [])].sort();

    // 6. Out-Of-Scope Extraction
    const outOfScopeRawCapabilities = sections.productScope.outOfScope ?? [];
    const outOfScopeCapabilities = [...new Set(outOfScopeRawCapabilities)].sort();
    const outOfScopeWorkflows: string[] = [];
    const outOfScopePlatforms = [...new Set(sections.technology.prohibitedTechnologies ?? [])].sort();
    const outOfScopeIntegrations: string[] = [];

    // 7. Functional Requirements Extraction & Deduplication
    const rawRequirements = [
      ...(discovery.requirements ?? []),
      ...(sections.functionalRequirements.capabilities ?? []),
    ];

    const reqMap = new Map<string, FunctionalRequirementScopeItem>();

    for (const r of rawRequirements) {
      const canonicalId = r.id.startsWith('FREQ-')
        ? r.id
        : createDeterministicRequirementId(r.title, r.description);

      if (reqMap.has(canonicalId)) {
        // Deterministic deduplication: merge business rules if any
        const existing = reqMap.get(canonicalId)!;
        const mergedRules = [...new Set([...existing.businessRules, ...(r.businessRules ?? [])])].sort();
        existing.businessRules = mergedRules;
        continue;
      }

      // Check if this requirement is affected by pending human decisions
      const isPendingDecision = pendingHumanDecisions.some(
        (d) =>
          d.affectedAreas.includes('functional requirements') ||
          d.title.toLowerCase().includes(r.title.toLowerCase())
      );

      const status = isPendingDecision ? 'PENDING_DECISION' : 'CONFIRMED';

      reqMap.set(canonicalId, {
        requirementId: canonicalId,
        title: r.title.trim(),
        description: r.description.trim(),
        priority: 'HIGH',
        source: r.source || `DISCOVERY_REVISION_${discovery.discoveryRevision}`,
        status,
        affectedScope: [r.title.trim()],
        dependencies: [],
        businessRules: [...new Set(r.businessRules ?? [])].sort(),
      });
    }

    const functionalRequirements = Array.from(reqMap.values()).sort((a, b) =>
      a.requirementId.localeCompare(b.requirementId)
    );

    // 8. Non-Functional Requirements Extraction
    const nfr = sections.nonFunctionalRequirements;
    const nonFunctionalRequirements = {
      performance: [...new Set(nfr.performance ?? [])].sort(),
      reliability: [...new Set(nfr.reliability ?? [])].sort(),
      security: [...new Set(nfr.security ?? [])].sort(),
      availability: [...new Set(nfr.availability ?? [])].sort(),
      scalability: [...new Set(nfr.scalability ?? [])].sort(),
      usability: [...new Set(nfr.usability ?? [])].sort(),
      maintainability: [...new Set(nfr.compatibility ?? [])].sort(),
      operationalConstraints: sections.architecture.deploymentModel
        ? [sections.architecture.deploymentModel]
        : [],
    };

    // 9. Constraints Extraction
    const tech = sections.technology;
    const constraints = {
      technologyConstraints: [...new Set(tech.requiredTechnologies ?? [])].sort(),
      platformConstraints: isPlatformUndecided ? [] : [...new Set(tech.platformConstraints ?? [])].sort(),
      compatibilityConstraints: [...new Set(nfr.compatibility ?? [])].sort(),
      legalComplianceConstraints: [],
      operationalConstraints: [...new Set(sections.architecture.architecturalConstraints ?? [])].sort(),
      budgetResourceConstraints: [],
    };

    // 10. Assumptions (Recorded explicitly, never silently converted into confirmed requirements)
    const assumptionsMap = new Map<string, ScopeAssumption>();

    // Baseline architectural assumptions derived from discovery context
    if (sections.architecture.dataStorageExpectations && sections.architecture.dataStorageExpectations.length > 0) {
      const stmt = `Persistence storage expects ${sections.architecture.dataStorageExpectations.join(', ')}`;
      const id = `ASSUMP-${computeDeterministicHash(stmt)}`;
      assumptionsMap.set(id, {
        id,
        statement: stmt,
        rationale: 'Derived from architecture discovery dataStorageExpectations',
        validated: false,
        affectedRequirements: [],
      });
    }

    if (additionalAssumptions && additionalAssumptions.length > 0) {
      for (const a of additionalAssumptions) {
        assumptionsMap.set(a.id, a);
      }
    }

    const assumptions = Array.from(assumptionsMap.values()).sort((a, b) =>
      a.id.localeCompare(b.id)
    );

    // 11. Open Questions Extraction
    const openQuestions: ScopeOpenQuestion[] = [];
    for (const q of rawQuestions) {
      if (q.status !== 'RESOLVED') {
        const qStatus = (q.status === 'UNDECIDED' || q.status === 'PROPOSED')
          ? q.status
          : (q.options && q.options.length >= 2 ? 'PENDING_DECISION' : 'OPEN');
        openQuestions.push({
          questionId: q.id,
          question: q.question,
          whyItMatters: q.whyItMatters,
          affectedAreas: [...q.whatItAffects].sort(),
          classification: q.classification,
          availableOptions: [...(q.options ?? [])].sort(),
          status: qStatus,
        });
      }
    }
    openQuestions.sort((a, b) => a.questionId.localeCompare(b.questionId));

    // 12. Deterministic Fingerprint Calculation (excluding createdAt, fingerprint, and volatile fields)
    const fingerprintMaterial = {
      projectId: discovery.projectId,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      purpose: {
        purpose,
        problemStatement,
        desiredOutcome,
        measurableObjective,
      },
      targetUsers: {
        primaryUsers,
        secondaryUsers,
        systemActors,
        externalActors,
      },
      inScope: {
        capabilities: inScopeCapabilities,
        workflows: inScopeWorkflows,
        platforms: inScopePlatforms,
        integrations: inScopeIntegrations,
      },
      outOfScope: {
        capabilities: outOfScopeCapabilities,
        workflows: outOfScopeWorkflows,
        platforms: outOfScopePlatforms,
        integrations: outOfScopeIntegrations,
      },
      undecidedScope: undecidedScope.map((u) => ({
        id: u.id,
        topic: u.topic,
        description: u.description,
        availableOptions: [...u.availableOptions].sort(),
        whyItMatters: u.whyItMatters,
        affectedAreas: [...u.affectedAreas].sort(),
      })),
      functionalRequirements: functionalRequirements.map((r) => ({
        requirementId: r.requirementId,
        title: r.title,
        description: r.description,
        priority: r.priority,
        source: r.source,
        status: r.status,
        affectedScope: [...r.affectedScope].sort(),
        dependencies: [...r.dependencies].sort(),
        businessRules: [...r.businessRules].sort(),
      })),
      nonFunctionalRequirements,
      constraints,
      assumptions: assumptions.map((a) => ({
        id: a.id,
        statement: a.statement,
        validated: a.validated,
        affectedRequirements: [...a.affectedRequirements].sort(),
      })),
      openQuestions: openQuestions.map((q) => ({
        questionId: q.questionId,
        question: q.question,
        whyItMatters: q.whyItMatters,
        affectedAreas: [...q.affectedAreas].sort(),
        classification: q.classification,
        availableOptions: [...q.availableOptions].sort(),
        status: q.status,
      })),
      humanDecisions: pendingHumanDecisions.map((d) => ({
        decisionId: d.decisionId,
        title: d.title,
        description: d.description,
        affectedAreas: [...d.affectedAreas].sort(),
        availableOptions: [...d.availableOptions].sort(),
        recommendedOption: d.recommendedOption,
        authority: d.authority,
        status: d.status,
      })),
    };

    const fingerprint = computeDeterministicFingerprint(fingerprintMaterial);

    // Check if an identical revision has already been saved for this project
    const latest = await this.requirementsStore.loadRevision(discovery.projectId);
    if (latest && latest.fingerprint === fingerprint) {
      return latest;
    }

    const latestRequirementsRev = await this.requirementsStore.getLatestRevisionNumber(
      discovery.projectId
    );
    const requirementsRevision = latestRequirementsRev + 1;

    const artifact: ProjectRequirementsScopeRevision = {
      projectId: discovery.projectId,
      requirementsRevision,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      isStale: false,
      purpose: {
        purpose,
        problemStatement,
        desiredOutcome,
        measurableObjective,
      },
      targetUsers: {
        primaryUsers,
        secondaryUsers,
        systemActors,
        externalActors,
      },
      inScope: {
        capabilities: inScopeCapabilities,
        workflows: inScopeWorkflows,
        platforms: inScopePlatforms,
        integrations: inScopeIntegrations,
      },
      outOfScope: {
        capabilities: outOfScopeCapabilities,
        workflows: outOfScopeWorkflows,
        platforms: outOfScopePlatforms,
        integrations: outOfScopeIntegrations,
      },
      undecidedScope,
      functionalRequirements,
      nonFunctionalRequirements,
      constraints,
      assumptions,
      openQuestions,
      humanDecisions: pendingHumanDecisions,
      createdAt: new Date().toISOString(),
      fingerprint,
    };

    // 14. Durably persist
    await this.requirementsStore.saveRevision(artifact);

    return artifact;
  }

  /**
   * Retrieves latest requirements revision for a project.
   */
  async getLatest(projectId: string): Promise<ProjectRequirementsScopeRevision | null> {
    const result = await this.requirementsStore.loadRevision(projectId);
    if (!result) return null;
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Retrieves specific requirements revision for a project.
   */
  async getRevision(
    projectId: string,
    revision: number
  ): Promise<ProjectRequirementsScopeRevision | null> {
    const result = await this.requirementsStore.loadRevision(projectId, revision);
    if (!result) return null;
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Checks whether a requirements revision is stale relative to latest discovery.
   */
  async isRevisionStale(revision: ProjectRequirementsScopeRevision): Promise<boolean> {
    const safeProjectId = this.requirementsStore.sanitizeProjectId(revision.projectId);
    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (!latestDiscovery) {
      return true;
    }
    if (latestDiscovery.discoveryRevision !== revision.sourceDiscoveryRevision) {
      return true;
    }
    if (latestDiscovery.fingerprint !== revision.sourceDiscoveryFingerprint) {
      return true;
    }
    return false;
  }
}
