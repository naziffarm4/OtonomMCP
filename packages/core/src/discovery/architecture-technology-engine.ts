/**
 * Architecture & Technology Definition Engine (Phase 15 TASK-P15-04)
 *
 * Transforms authoritative Requirements / Scope (P15-03) and Discovery (P15-01) into an
 * explicit, structured, revisioned Architecture / Technology specification for Project Initiation.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-04 consumes P15-03; does NOT independently reconstruct requirements from raw discovery.
 * 2. Does NOT approve the project, authorize development, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine.
 * 4. Technology choices strictly distinguish REQUIRED, CONSTRAINED, SELECTED, CANDIDATE, and UNDECIDED.
 * 5. Strictly deterministic: identical inputs produce identical architecture definition and fingerprint.
 * 6. Revision-bound: immutable by revision, protects against stale requirements and discovery.
 * 7. Fails closed on cross-project mismatches, forged fingerprints, or path traversal.
 */

import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import { CompletenessGateStore } from './completeness-gate-store.js';
import { RequirementsScopeStore } from './requirements-scope-store.js';
import { ArchitectureTechnologyStore } from './architecture-technology-store.js';
import {
  ArchitectureTechnologyInputZodSchema,
  type ArchitectureTechnologyInput,
  type ProjectArchitectureRevision,
  type ArchitecturalStyleDefinition,
  type SystemComponent,
  type DataArchitecture,
  type ApiCommunicationArchitecture,
  type TechnologyChoiceItem,
  type PlatformEnvironment,
  type SecurityArchitecture,
  type ArchitectureIntegrationItem,
  type DeploymentArchitecture,
  type ArchitectureDecisionItem,
  type ArchitectureDecisionStatus,
  type ArchitectureHumanDecision,
  type ArchitectureTraceabilityLink,
} from './architecture-technology-types.js';
import type { ProjectRequirementsScopeRevision } from './requirements-scope-types.js';
import type { ProjectDiscoveryRevision } from './adaptive-discovery-types.js';
import {
  ArchitectureValidationError,
  ArchitectureRevisionNotFoundError,
  ArchitectureProjectBindingMismatchError,
  ArchitectureStaleSourceError,
  ArchitectureForgedFingerprintError,
} from './architecture-technology-errors.js';
import {
  computeDeterministicFingerprint,
  computeDeterministicHash,
} from './adaptive-discovery-normalizer.js';

export interface ArchitectureTechnologyEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessStore?: CompletenessGateStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly architectureStore?: ArchitectureTechnologyStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export class ArchitectureTechnologyEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly completenessStore: CompletenessGateStore;
  readonly requirementsStore: RequirementsScopeStore;
  readonly architectureStore: ArchitectureTechnologyStore;
  private readonly historyManager?: HistoryManager;
  private readonly specStore?: SpecStore;

  constructor(options?: ArchitectureTechnologyEngineOptions) {
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

    this.architectureStore =
      options?.architectureStore ??
      new ArchitectureTechnologyStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });
  }

  /**
   * Derives an authoritative, revisioned Architecture / Technology specification.
   */
  async derive(input: ArchitectureTechnologyInput): Promise<ProjectArchitectureRevision> {
    const parsedInput = ArchitectureTechnologyInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ArchitectureValidationError(
        `Invalid architecture/technology input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    const safeProjectId = this.architectureStore.sanitizeProjectId(input.projectId);

    // 1. Load authoritative source requirements revision
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      input.requirementsRevision
    );

    if (!requirements) {
      throw new ArchitectureRevisionNotFoundError(
        `Requirements revision ${input.requirementsRevision !== undefined ? input.requirementsRevision : 'latest'} not found for project '${input.projectId}'.`,
        { projectId: input.projectId, requestedRevision: input.requirementsRevision }
      );
    }

    // 2. Cross-project isolation check
    if (requirements.projectId !== input.projectId) {
      throw new ArchitectureProjectBindingMismatchError(
        `Cross-project mismatch: requested derivation for '${input.projectId}' but requirements record belongs to '${requirements.projectId}'.`,
        { requestedProjectId: input.projectId, recordProjectId: requirements.projectId }
      );
    }

    // 3. Forged requirements fingerprint check
    if (
      input.expectedRequirementsFingerprint &&
      input.expectedRequirementsFingerprint !== requirements.fingerprint
    ) {
      throw new ArchitectureForgedFingerprintError(
        `Requirements fingerprint mismatch: expected '${input.expectedRequirementsFingerprint}' but authoritative fingerprint is '${requirements.fingerprint}'.`,
        {
          expected: input.expectedRequirementsFingerprint,
          actual: requirements.fingerprint,
        }
      );
    }

    // 4. Stale requirements source check
    const latestReqRevNumber = await this.requirementsStore.getLatestRevisionNumber(safeProjectId);
    if (latestReqRevNumber > requirements.requirementsRevision) {
      throw new ArchitectureStaleSourceError(
        `Cannot derive architecture from stale requirements revision ${requirements.requirementsRevision}; latest requirements revision is ${latestReqRevNumber}.`,
        {
          projectId: input.projectId,
          staleRevision: requirements.requirementsRevision,
          latestRevision: latestReqRevNumber,
        }
      );
    }

    // 5. Load authoritative source discovery revision bound to requirements
    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      requirements.sourceDiscoveryRevision
    );

    if (!discovery) {
      throw new ArchitectureRevisionNotFoundError(
        `Discovery revision ${requirements.sourceDiscoveryRevision} referenced by requirements not found for project '${input.projectId}'.`,
        { projectId: input.projectId, requestedRevision: requirements.sourceDiscoveryRevision }
      );
    }

    if (discovery.fingerprint !== requirements.sourceDiscoveryFingerprint) {
      throw new ArchitectureForgedFingerprintError(
        `Source discovery fingerprint mismatch: requirements bound to '${requirements.sourceDiscoveryFingerprint}' but discovery has '${discovery.fingerprint}'.`,
        {
          expected: requirements.sourceDiscoveryFingerprint,
          actual: discovery.fingerprint,
        }
      );
    }

    if (
      input.discoveryRevision !== undefined &&
      input.discoveryRevision !== requirements.sourceDiscoveryRevision
    ) {
      throw new ArchitectureValidationError(
        `Discovery revision mismatch: input specifies ${input.discoveryRevision} but source requirements revision ${requirements.requirementsRevision} binds to discovery revision ${requirements.sourceDiscoveryRevision}.`,
        { inputRevision: input.discoveryRevision, requirementsRevision: requirements.sourceDiscoveryRevision }
      );
    }

    if (
      input.expectedDiscoveryFingerprint &&
      input.expectedDiscoveryFingerprint !== requirements.sourceDiscoveryFingerprint
    ) {
      throw new ArchitectureForgedFingerprintError(
        `Discovery fingerprint mismatch: expected '${input.expectedDiscoveryFingerprint}' but bound discovery fingerprint is '${requirements.sourceDiscoveryFingerprint}'.`,
        { expected: input.expectedDiscoveryFingerprint, actual: requirements.sourceDiscoveryFingerprint }
      );
    }

    // Stale discovery check
    const latestDiscRevNumber = await this.discoveryStore.getLatestRevisionNumber(safeProjectId);
    if (latestDiscRevNumber > discovery.discoveryRevision) {
      throw new ArchitectureStaleSourceError(
        `Cannot derive architecture when source discovery has newer revision available (${latestDiscRevNumber} > ${discovery.discoveryRevision}).`,
        {
          projectId: input.projectId,
          staleRevision: discovery.discoveryRevision,
          latestRevision: latestDiscRevNumber,
        }
      );
    }

    return this.deriveFromAuthoritativeSources(requirements, discovery, input.additionalDecisions);
  }

  /**
   * Deterministically derives architecture and technology from authoritative requirements and discovery.
   */
  async deriveFromAuthoritativeSources(
    requirements: ProjectRequirementsScopeRevision,
    discovery: ProjectDiscoveryRevision,
    additionalDecisions?: ArchitectureDecisionItem[]
  ): Promise<ProjectArchitectureRevision> {
    const sections = discovery.sections;

    // 1. Pending Human Decisions Extraction
    const pendingHumanDecisions: ArchitectureHumanDecision[] = [];

    // Decisions from requirements
    for (const d of requirements.humanDecisions) {
      if (['PENDING_DECISION', 'UNDECIDED', 'PROPOSED', 'OPEN'].includes(d.status)) {
        pendingHumanDecisions.push({
          decisionId: d.decisionId,
          question: d.title,
          whyItMatters: d.description,
          affectedRequirements: [...d.affectedAreas].sort(),
          affectedArchitectureAreas: [...d.affectedAreas].sort(),
          availableOptions: [...d.availableOptions].sort(),
          consequences: [],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // Undecided scope items that require architectural choices
    for (const u of requirements.undecidedScope) {
      if (
        !pendingHumanDecisions.some(
          (p) => p.decisionId === u.id || p.question.toLowerCase() === u.topic.toLowerCase()
        )
      ) {
        pendingHumanDecisions.push({
          decisionId: u.id,
          question: u.topic,
          whyItMatters: u.whyItMatters,
          affectedRequirements: [...u.affectedAreas].sort(),
          affectedArchitectureAreas: [...u.affectedAreas].sort(),
          availableOptions: [...u.availableOptions].sort(),
          consequences: [],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // Decisions directly present on discovery
    const rawDiscDecisions = discovery.decisions ?? sections.humanDecisions ?? [];
    for (const d of rawDiscDecisions) {
      if (
        ['PENDING_DECISION', 'UNDECIDED', 'PROPOSED', 'OPEN'].includes(d.status) &&
        !pendingHumanDecisions.some(
          (p) => p.decisionId === d.id || p.question.toLowerCase() === d.title.toLowerCase()
        )
      ) {
        pendingHumanDecisions.push({
          decisionId: d.id,
          question: d.title,
          whyItMatters: d.description,
          affectedRequirements: [...d.affectedAreas].sort(),
          affectedArchitectureAreas: [...d.affectedAreas].sort(),
          availableOptions: [...(d.alternatives ?? [])].sort(),
          consequences: [],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // Unresolved or undecided discovery questions
    const rawDiscQuestions = discovery.openQuestions ?? sections.openQuestions ?? [];
    for (const q of rawDiscQuestions) {
      if (
        q.status !== 'RESOLVED' &&
        !pendingHumanDecisions.some(
          (p) => p.decisionId === q.id || p.question.toLowerCase() === q.question.toLowerCase()
        )
      ) {
        pendingHumanDecisions.push({
          decisionId: q.id,
          question: q.question,
          whyItMatters: q.whyItMatters,
          affectedRequirements: [...q.whatItAffects].sort(),
          affectedArchitectureAreas: [...q.whatItAffects].sort(),
          availableOptions: [...(q.options ?? [])].sort(),
          consequences: [],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    pendingHumanDecisions.sort((a, b) => a.decisionId.localeCompare(b.decisionId));

    // Helper to check if an architectural area has an unresolved decision
    const hasPendingDecisionInArea = (areaKeyword: string): boolean => {
      const regex = new RegExp(`\\b${areaKeyword}\\b`, 'i');
      return pendingHumanDecisions.some(
        (p) =>
          regex.test(p.question) ||
          regex.test(p.whyItMatters) ||
          p.affectedArchitectureAreas.some((a) => regex.test(a))
      );
    };

    const isPlatformPending =
      hasPendingDecisionInArea('platform') ||
      hasPendingDecisionInArea('interface') ||
      hasPendingDecisionInArea('frontend') ||
      hasPendingDecisionInArea('ui');

    // 2. Architectural Style Extraction
    const archSection = sections.architecture;
    const patternConstraint = archSection.architecturalConstraints.find((c) =>
      /monolith|client-server|service-oriented|microservice|event-driven|serverless/i.test(c)
    );
    const styleFromDiscovery = patternConstraint || 'modular-monolith';
    const isStylePending =
      isPlatformPending ||
      hasPendingDecisionInArea('style') ||
      hasPendingDecisionInArea('monolith') ||
      hasPendingDecisionInArea('microservice');

    const architecturalStyle: ArchitecturalStyleDefinition = {
      style: isStylePending ? 'UNDECIDED' : styleFromDiscovery,
      pattern: patternConstraint,
      applicationTopology: isStylePending
        ? undefined
        : (patternConstraint ? `${patternConstraint} topology` : 'modular application'),
      subsystemBoundaries: [
        'Core Logic Subsystem',
        'API & Communication Subsystem',
        'Persistence & Storage Subsystem',
      ].sort(),
      serviceModuleBoundaries: [
        'Domain Services',
        'Storage Adapters',
        'Integration Adapters',
      ].sort(),
      clientServerBoundaries: isPlatformPending
        ? ['Application Domain Module', 'Adapter Layer']
        : [
            'Client Application Layer',
            'Server / Host Application Layer',
          ].sort(),
      deploymentTopology: archSection.deploymentModel ?? 'single-node process',
      communicationModel: 'synchronous RPC / in-process dispatch',
      status: isStylePending ? 'PENDING_DECISION' : 'CONFIRMED',
    };

    // 3. System Components Extraction
    // Logical major components derived from functional requirements and in-scope boundaries
    const componentMap = new Map<string, SystemComponent>();

    // Default core components
    const coreCompId = `COMP-${computeDeterministicHash('Core Application Domain', 8).toUpperCase()}`;
    componentMap.set(coreCompId, {
      componentId: coreCompId,
      name: 'Core Application Domain',
      responsibility: `Executes core workflows: ${requirements.inScope.workflows.slice(0, 3).join(', ') || 'business logic'}`,
      dependencies: [],
      exposedInterfaces: ['CoreDomainService'],
      owningBoundary: 'Core Logic Subsystem',
      sourceReferences: requirements.functionalRequirements.map((f) => f.requirementId).slice(0, 5),
      status: 'CONFIRMED',
    });

    // If integrations exist, add Integration Gateway component
    if (requirements.inScope.integrations.length > 0) {
      const intCompId = `COMP-${computeDeterministicHash('External Integration Gateway', 8).toUpperCase()}`;
      componentMap.set(intCompId, {
        componentId: intCompId,
        name: 'External Integration Gateway',
        responsibility: `Manages integrations with: ${requirements.inScope.integrations.join(', ')}`,
        dependencies: [coreCompId],
        exposedInterfaces: ['IntegrationGatewayService'],
        owningBoundary: 'Integration Adapters',
        sourceReferences: requirements.inScope.integrations,
        status: 'CONFIRMED',
      });
    }

    // If data storage or assumptions exist, add Data Access Component
    if (
      (archSection.dataStorageExpectations && archSection.dataStorageExpectations.length > 0) ||
      requirements.assumptions.some((a) => a.statement.toLowerCase().includes('storage') || a.statement.toLowerCase().includes('persistence'))
    ) {
      const dataCompId = `COMP-${computeDeterministicHash('Data Persistence Service', 8).toUpperCase()}`;
      componentMap.set(dataCompId, {
        componentId: dataCompId,
        name: 'Data Persistence Service',
        responsibility: 'Manages entity persistence, state durability, and query access',
        dependencies: [],
        exposedInterfaces: ['DataRepository'],
        owningBoundary: 'Persistence & Storage Subsystem',
        sourceReferences: ['ARCH-STORAGE-REQ'],
        status: hasPendingDecisionInArea('database') || hasPendingDecisionInArea('sql') ? 'PENDING_DECISION' : 'CONFIRMED',
      });
    }

    // Derive domain components from functional requirements capabilities
    for (const freq of requirements.functionalRequirements) {
      const compName = `${freq.title.split(' ')[0]} Component`;
      const compId = `COMP-${computeDeterministicHash(compName, 8).toUpperCase()}`;
      if (!componentMap.has(compId)) {
        componentMap.set(compId, {
          componentId: compId,
          name: compName,
          responsibility: freq.description,
          dependencies: [coreCompId],
          exposedInterfaces: [`I${compName.replace(/\s+/g, '')}`],
          owningBoundary: 'Domain Services',
          sourceReferences: [freq.requirementId],
          status: freq.status === 'PENDING_DECISION' ? 'PENDING_DECISION' : 'CONFIRMED',
        });
      } else {
        const existing = componentMap.get(compId)!;
        existing.sourceReferences = [...new Set([...existing.sourceReferences, freq.requirementId])].sort();
      }
    }

    const systemComponents = Array.from(componentMap.values()).sort((a, b) =>
      a.componentId.localeCompare(b.componentId)
    );

    // 4. Data Architecture Extraction
    const isDataPending =
      isPlatformPending ||
      hasPendingDecisionInArea('database') ||
      hasPendingDecisionInArea('sql') ||
      hasPendingDecisionInArea('nosql') ||
      hasPendingDecisionInArea('storage') ||
      hasPendingDecisionInArea('persistence');
    const storageExpectations = archSection.dataStorageExpectations ?? [];
    const primaryDataStoreCandidate = storageExpectations.length > 0 ? storageExpectations[0] : undefined;

    const dataArchitecture: DataArchitecture = {
      persistenceStrategy: isDataPending ? undefined : (primaryDataStoreCandidate ? `Durable storage via ${primaryDataStoreCandidate}` : undefined),
      primaryDataStore: isDataPending ? undefined : primaryDataStoreCandidate,
      secondaryStores: isDataPending ? [] : storageExpectations.slice(1).sort(),
      caching: [],
      fileObjectStorage: [],
      dataOwnership: ['Core Application Domain owns primary entities'],
      dataFlow: isPlatformPending ? ['Domain Service -> Storage Adapter'] : ['Client -> API Gateway -> Domain Service -> Data Persistence Service'],
      retentionRequirements: [],
      consistencyRequirements: ['Strong consistency for transactional data'],
      status: isDataPending ? 'PENDING_DECISION' : (primaryDataStoreCandidate ? 'CONFIRMED' : 'NOT_APPLICABLE'),
    };

    // 5. API & Communication Architecture Extraction
    const isApiPending =
      hasPendingDecisionInArea('api') ||
      hasPendingDecisionInArea('rest') ||
      hasPendingDecisionInArea('graphql') ||
      hasPendingDecisionInArea('protocol') ||
      hasPendingDecisionInArea('communication');
    const integrations = requirements.inScope.integrations;
    const prohibitedTechNames = sections.technology?.prohibitedTechnologies ?? [];
    const isHttpRestProhibited =
      prohibitedTechNames.some((t) => t.toLowerCase().includes('rest') || t.toLowerCase().includes('http') || t.toLowerCase().includes('network endpoint') || t.toLowerCase().includes('web api')) ||
      requirements.outOfScope.capabilities.some((f) => f.toLowerCase().includes('rest') || f.toLowerCase().includes('http') || f.toLowerCase().includes('external api') || f.toLowerCase().includes('web api')) ||
      requirements.outOfScope.integrations.some((i) => i.toLowerCase().includes('rest') || i.toLowerCase().includes('http') || i.toLowerCase().includes('external api') || i.toLowerCase().includes('web api'));

    const hasHttpRest = !isHttpRestProhibited && (integrations.some((i) => i.toLowerCase().includes('rest') || i.toLowerCase().includes('http')) || (!isApiPending && integrations.length > 0 && !integrations.every((i) => i.toLowerCase().includes('module') || i.toLowerCase().includes('library') || i.toLowerCase().includes('in-process'))));
    const hasWebSocket = integrations.some((i) => i.toLowerCase().includes('websocket') || i.toLowerCase().includes('socket'));
    const hasGraphQl = integrations.some((i) => i.toLowerCase().includes('graphql'));

    const apiCommunicationArchitecture: ApiCommunicationArchitecture = {
      httpRest: isApiPending || isHttpRestProhibited ? false : hasHttpRest,
      graphQl: isApiPending ? false : hasGraphQl,
      webSocket: isApiPending ? false : hasWebSocket,
      messageQueues: [],
      eventBus: [],
      rpc: [],
      ipc: [],
      internalApis: ['In-process typed service interfaces'],
      externalApis: [...new Set(integrations)].sort(),
      status: isApiPending ? 'PENDING_DECISION' : 'CONFIRMED',
    };

    // 6. Technology Stack Extraction
    const techStackMap = new Map<string, TechnologyChoiceItem>();

    // 6.1 Required / Constrained Technologies from constraints and discovery
    const techSection = sections.technology;
    const requiredTechs = [
      ...(requirements.constraints.technologyConstraints ?? []),
      ...(techSection.requiredTechnologies ?? []),
    ];

    for (const techName of requiredTechs) {
      const normalizedName = techName.trim();
      if (!normalizedName) continue;
      const lower = normalizedName.toLowerCase();
      let category: TechnologyChoiceItem['category'] = 'OTHER';

      if (lower.includes('typescript') || lower.includes('javascript') || lower.includes('python') || lower.includes('rust') || lower.includes('go')) {
        category = 'PROGRAMMING_LANGUAGE';
      } else if (lower.includes('node') || lower.includes('deno') || lower.includes('bun')) {
        category = 'RUNTIME';
      } else if (lower.includes('react') || lower.includes('vue') || lower.includes('angular') || lower.includes('svelte')) {
        category = 'FRONTEND_FRAMEWORK';
      } else if (lower.includes('express') || lower.includes('fastify') || lower.includes('nest')) {
        category = 'BACKEND_FRAMEWORK';
      } else if (lower.includes('postgres') || lower.includes('sqlite') || lower.includes('mysql') || lower.includes('mongo')) {
        category = 'DATABASE';
      } else if (lower.includes('prisma') || lower.includes('typeorm') || lower.includes('drizzle')) {
        category = 'ORM_DATA_ACCESS';
      }

      if (category === 'DATABASE' && isDataPending) {
        continue;
      }

      if (isPlatformPending && (category === 'FRONTEND_FRAMEWORK' || lower.includes('vite') || lower.includes('react') || lower.includes('localstorage'))) {
        techStackMap.set(`CANDIDATE:::${normalizedName}`, {
          category: category === 'FRONTEND_FRAMEWORK' ? 'FRONTEND_FRAMEWORK' : 'OTHER',
          name: normalizedName,
          selectionStatus: 'CANDIDATE',
          source: 'RECOMMENDATION',
          affectedRequirements: [],
          rationale: 'Candidate option pending platform and interface selection',
        });
        continue;
      }

      techStackMap.set(`${category}:::${normalizedName}`, {
        category,
        name: normalizedName,
        selectionStatus: 'REQUIRED',
        source: 'CONSTRAINTS_AND_DISCOVERY',
        affectedRequirements: [],
        rationale: 'Mandated by project technology constraints',
      });
    }

    // 6.2 Prohibited Technologies
    const prohibitedTechs = techSection.prohibitedTechnologies ?? [];
    for (const p of prohibitedTechs) {
      const normalizedName = p.trim();
      techStackMap.set(`PROHIBITED:::${normalizedName}`, {
        category: 'OTHER',
        name: normalizedName,
        selectionStatus: 'CONSTRAINED',
        source: 'PROHIBITED_TECHNOLOGIES',
        affectedRequirements: [],
        rationale: 'Explicitly prohibited by project discovery constraints',
      });
    }

    // 6.3 Candidates / Undecided from pending decisions
    for (const p of pendingHumanDecisions) {
      if (
        p.question.toLowerCase().includes('database') ||
        p.question.toLowerCase().includes('framework') ||
        p.question.toLowerCase().includes('technology') ||
        p.question.toLowerCase().includes('platform') ||
        p.question.toLowerCase().includes('protocol') ||
        p.question.toLowerCase().includes('api') ||
        p.affectedArchitectureAreas.some((a) =>
          ['database', 'storage', 'technology', 'platform', 'api', 'architecture', 'communication'].includes(a.toLowerCase())
        )
      ) {
        for (const opt of p.availableOptions) {
          const key = `CANDIDATE:::${opt}`;
          if (!techStackMap.has(key)) {
            techStackMap.set(key, {
              category: 'OTHER',
              name: opt,
              selectionStatus: 'CANDIDATE',
              source: `HUMAN_DECISION_${p.decisionId}`,
              affectedRequirements: p.affectedRequirements,
              rationale: `Candidate option under Product Owner review (${p.question})`,
            });
          }
        }
      }
    }

    const technologyStack = Array.from(techStackMap.values()).sort((a, b) =>
      `${a.category}:::${a.name}`.localeCompare(`${b.category}:::${b.name}`)
    );

    // 7. Platform & Environment Extraction
    const platformConstraints = isPlatformPending
      ? []
      : [
          ...(requirements.constraints.platformConstraints ?? []),
          ...(requirements.inScope.platforms ?? []),
          ...(techSection.platformConstraints ?? []),
        ];

    const platformEnvironment: PlatformEnvironment = {
      targetOs: [...new Set(platformConstraints.filter((p) => /linux|windows|macos|darwin/i.test(p)))].sort(),
      targetDevices: [...new Set(platformConstraints.filter((p) => /mobile|desktop|server|tablet/i.test(p)))].sort(),
      browserRequirements: isPlatformPending ? [] : [...new Set(platformConstraints.filter((p) => /chrome|firefox|safari|edge|browser/i.test(p)))].sort(),
      mobileRequirements: isPlatformPending ? [] : [...new Set(platformConstraints.filter((p) => /ios|android|mobile/i.test(p)))].sort(),
      desktopRequirements: [...new Set(platformConstraints.filter((p) => /electron|desktop|posix/i.test(p)))].sort(),
      serverEnvironment: [...new Set(platformConstraints.filter((p) => /node|container|docker|linux|cloud/i.test(p)))].sort(),
      cloudOnPremRequirements: [...new Set(platformConstraints.filter((p) => /cloud|aws|gcp|azure|on-prem/i.test(p)))].sort(),
      supportedRuntimeVersions: [],
    };

    // 8. Security Architecture Extraction
    const secReqs = requirements.nonFunctionalRequirements.security ?? [];
    const isSecurityPending = hasPendingDecisionInArea('auth') || hasPendingDecisionInArea('security');

    const securityArchitecture: SecurityArchitecture = {
      authenticationArchitecture: isSecurityPending ? undefined : (secReqs.length > 0 ? secReqs[0] : undefined),
      authorizationModel: isSecurityPending ? undefined : (secReqs.some((s) => /rbac|role|permission/i.test(s)) ? 'Role-Based Access Control (RBAC)' : undefined),
      identityProvider: undefined,
      secretsHandling: ['Zero hardcoded credentials', 'Environment variable and secrets store isolation'].sort(),
      encryptionRequirements: [...new Set(secReqs.filter((s) => /encrypt|tls|ssl|crypto/i.test(s)))].sort(),
      trustBoundaries: ['Client to Server Boundary', 'Core Domain to External Gateway Boundary'].sort(),
      dataIsolation: ['Project-isolated storage records and directory paths'],
      auditRequirements: ['Append-only immutable event log via HistoryManager'],
      status: isSecurityPending ? 'PENDING_DECISION' : (secReqs.length > 0 ? 'CONFIRMED' : 'NOT_APPLICABLE'),
    };

    // 9. Integrations Extraction
    const integrationList: ArchitectureIntegrationItem[] = [];
    for (const intName of requirements.inScope.integrations) {
      const normalized = intName.trim();
      if (!normalized) continue;
      const intId = `INT-${computeDeterministicHash(normalized, 8).toUpperCase()}`;
      const isPending = pendingHumanDecisions.some((p) => p.question.toLowerCase().includes(normalized.toLowerCase()));

      integrationList.push({
        integrationId: intId,
        system: normalized,
        purpose: `Integration support for ${normalized}`,
        direction: 'BIDIRECTIONAL',
        dependency: 'REQUIRED',
        status: isPending ? 'PENDING_DECISION' : 'CONFIRMED',
        source: 'IN_SCOPE_INTEGRATIONS',
        affectedRequirements: requirements.functionalRequirements
          .filter((f) => f.description.toLowerCase().includes(normalized.toLowerCase()))
          .map((f) => f.requirementId),
      });
    }
    integrationList.sort((a, b) => a.integrationId.localeCompare(b.integrationId));

    // 10. Deployment Architecture Extraction
    const opConstraints = requirements.nonFunctionalRequirements.operationalConstraints ?? [];
    const isDeployPending = hasPendingDecisionInArea('deployment') || hasPendingDecisionInArea('hosting') || hasPendingDecisionInArea('cloud');

    const deploymentArchitecture: DeploymentArchitecture = {
      environments: ['development', 'test', 'staging', 'production'].sort(),
      development: 'Local development environment with automated test suites',
      test: 'CI automated test runner',
      staging: isDeployPending ? undefined : 'Staging pre-production environment',
      production: isDeployPending ? undefined : (archSection.deploymentModel ?? 'Containerized or single-node service'),
      deploymentModel: isDeployPending ? undefined : archSection.deploymentModel,
      hostingPlatform: isDeployPending ? undefined : undefined,
      runtimeTopology: isDeployPending ? undefined : 'Single-node process with modular boundaries',
      scalingExpectations: [],
      operationalDependencies: [...new Set(opConstraints)].sort(),
      status: isDeployPending ? 'PENDING_DECISION' : 'CONFIRMED',
    };

    // 11. Architectural Decisions Model
    const decisionsMap = new Map<string, ArchitectureDecisionItem>();

    // 11.1 Style Decision
    const styleDecId = 'ARCH-DEC-001';
    decisionsMap.set(styleDecId, {
      decisionId: styleDecId,
      decisionArea: 'STYLE',
      question: 'What architectural style and subsystem topology will govern the system?',
      status: architecturalStyle.status === 'PENDING_DECISION' ? 'PENDING_DECISION' : 'DECIDED',
      selectedOption: architecturalStyle.status === 'CONFIRMED' ? architecturalStyle.style : undefined,
      candidateOptions: ['modular-monolith', 'monolith', 'microservices', 'client-server'].sort(),
      rationale: architecturalStyle.status === 'CONFIRMED' ? 'Derived from discovery architectural pattern' : 'Pending Product Owner decision',
      affectedRequirements: requirements.functionalRequirements.slice(0, 3).map((f) => f.requirementId),
      consequences: ['Governs module boundaries, communication patterns, and deployment units'],
      dependencies: [],
      authority: architecturalStyle.status === 'CONFIRMED' ? 'SYSTEM' : Actor.USER,
      revisionBinding: 1,
    });

    // 11.2 Data Persistence Decision
    const dataDecId = 'ARCH-DEC-002';
    decisionsMap.set(dataDecId, {
      decisionId: dataDecId,
      decisionArea: 'DATA',
      question: 'What primary data storage technology and strategy should be selected?',
      status: dataArchitecture.status === 'PENDING_DECISION' ? 'PENDING_DECISION' : (dataArchitecture.primaryDataStore ? 'DECIDED' : 'NOT_APPLICABLE'),
      selectedOption: dataArchitecture.primaryDataStore,
      candidateOptions: archSection.dataStorageExpectations ? [...archSection.dataStorageExpectations].sort() : [],
      rationale: dataArchitecture.primaryDataStore ? 'Explicitly defined in project discovery expectations' : 'Database choice remains undecided',
      affectedRequirements: requirements.functionalRequirements.slice(0, 3).map((f) => f.requirementId),
      consequences: ['Determines data modeling, migration strategies, and persistence adapters'],
      dependencies: [styleDecId],
      authority: dataArchitecture.status === 'PENDING_DECISION' ? Actor.USER : 'SYSTEM',
      revisionBinding: 1,
    });

    // 11.3 API & Communication Decision
    const apiDecId = 'ARCH-DEC-003';
    const isExternalApiNotApplicable =
      isHttpRestProhibited ||
      (!apiCommunicationArchitecture.httpRest &&
        !apiCommunicationArchitecture.graphQl &&
        !apiCommunicationArchitecture.webSocket);

    const apiSelectedOption = isExternalApiNotApplicable
      ? 'NOT_APPLICABLE'
      : apiCommunicationArchitecture.httpRest
      ? 'REST'
      : apiCommunicationArchitecture.graphQl
      ? 'GraphQL'
      : 'In-process typed RPC';

    const apiCandidateOptions = [
      'GraphQL',
      'In-process typed RPC',
      'NOT_APPLICABLE',
      'REST',
      'WebSocket',
    ].sort();

    const apiRationale = isExternalApiNotApplicable
      ? 'Communication protocol for external network API is NOT_APPLICABLE. The product boundary is a typed in-process TypeScript API/module with no HTTP server, no REST endpoint, and no external network listener.'
      : 'Derived from integrations and subsystem boundaries';

    const apiConsequences = isExternalApiNotApplicable
      ? [
          'Communication protocol for external network API: NOT_APPLICABLE',
          'Product boundary: typed in-process TypeScript API/module',
          'No HTTP server, no REST endpoint, and no external network listener',
        ]
      : ['Determines client contracts, payload schemas, and serialization formats'];

    const apiDecStatus: ArchitectureDecisionStatus =
      apiCommunicationArchitecture.status === 'PENDING_DECISION'
        ? 'PENDING_DECISION'
        : isExternalApiNotApplicable
        ? 'NOT_APPLICABLE'
        : 'DECIDED';

    decisionsMap.set(apiDecId, {
      decisionId: apiDecId,
      decisionArea: 'API',
      question: 'What communication protocol will expose external and internal interfaces?',
      status: apiDecStatus,
      selectedOption: apiSelectedOption,
      candidateOptions: apiCandidateOptions,
      rationale: apiRationale,
      affectedRequirements: requirements.functionalRequirements.slice(0, 3).map((f) => f.requirementId),
      consequences: apiConsequences,
      dependencies: [styleDecId],
      authority: apiCommunicationArchitecture.status === 'PENDING_DECISION' ? Actor.USER : 'SYSTEM',
      revisionBinding: 1,
    });

    // 11.4 Technology Constraints Decision
    const techDecId = 'ARCH-DEC-004';
    decisionsMap.set(techDecId, {
      decisionId: techDecId,
      decisionArea: 'TECH_STACK',
      question: 'What runtime and programming languages constrain this project?',
      status: requiredTechs.length > 0 ? 'CONSTRAINED' : 'CANDIDATE',
      selectedOption: requiredTechs.length > 0 ? requiredTechs.sort().join(', ') : undefined,
      candidateOptions: requiredTechs.sort(),
      rationale: requiredTechs.length > 0 ? 'Mandated by project technology constraints' : 'No explicit technology constraints specified',
      affectedRequirements: requirements.functionalRequirements.slice(0, 3).map((f) => f.requirementId),
      consequences: ['Constrains toolchain, library ecosystem, and runtime execution'],
      dependencies: [],
      authority: 'SYSTEM',
      revisionBinding: 1,
    });

    // 11.5 Platform & Interface Decision
    const platDecId = 'ARCH-DEC-005';
    const platformCandidates = ['Web Application', 'CLI (Command Line Interface)', 'Desktop Application', 'Library / Module'].sort();
    decisionsMap.set(platDecId, {
      decisionId: platDecId,
      decisionArea: 'PLATFORM',
      question: 'What target platform and user interface type will this system provide?',
      status: isPlatformPending ? 'PENDING_DECISION' : 'DECIDED',
      selectedOption: isPlatformPending ? undefined : (platformConstraints.length > 0 ? platformConstraints[0] : 'Web Application'),
      candidateOptions: platformCandidates,
      rationale: isPlatformPending ? 'Target interface type has not been confirmed by the Product Owner' : 'Derived from confirmed platform constraints',
      affectedRequirements: requirements.functionalRequirements.slice(0, 3).map((f) => f.requirementId),
      consequences: ['Governs UI framework selection, runtime environment, and client persistence'],
      dependencies: [],
      authority: isPlatformPending ? Actor.USER : 'SYSTEM',
      revisionBinding: 1,
    });

    // Merge any explicit additional decisions passed in
    if (additionalDecisions && additionalDecisions.length > 0) {
      for (const d of additionalDecisions) {
        decisionsMap.set(d.decisionId, d);
      }
    }

    const decisions = Array.from(decisionsMap.values()).sort((a, b) =>
      a.decisionId.localeCompare(b.decisionId)
    );

    // 12. Requirements Traceability
    const traceabilityLinks: ArchitectureTraceabilityLink[] = [];
    for (const req of requirements.functionalRequirements) {
      const matchingComps = systemComponents
        .filter((c) => c.sourceReferences.includes(req.requirementId))
        .map((c) => c.componentId);

      const matchingDecs = decisions
        .filter((d) => d.affectedRequirements.includes(req.requirementId))
        .map((d) => d.decisionId);

      const matchingTechs = technologyStack
        .filter((t) => t.affectedRequirements.includes(req.requirementId) || t.selectionStatus === 'REQUIRED')
        .map((t) => t.name);

      traceabilityLinks.push({
        requirementId: req.requirementId,
        requirementTitle: req.title,
        addressedByComponents: matchingComps.length > 0 ? matchingComps.sort() : [coreCompId],
        addressedByDecisions: matchingDecs.length > 0 ? matchingDecs.sort() : [styleDecId],
        addressedByTechnologies: [...new Set(matchingTechs)].sort(),
      });
    }
    traceabilityLinks.sort((a, b) => a.requirementId.localeCompare(b.requirementId));

    // 13. Deterministic Fingerprint Calculation (excluding createdAt, fingerprint, and volatile fields)
    const fingerprintMaterial = {
      projectId: requirements.projectId,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceDiscoveryRevision: requirements.sourceDiscoveryRevision,
      sourceDiscoveryFingerprint: requirements.sourceDiscoveryFingerprint,
      architecturalStyle,
      systemComponents: systemComponents.map((c) => ({
        componentId: c.componentId,
        name: c.name,
        responsibility: c.responsibility,
        dependencies: [...c.dependencies].sort(),
        exposedInterfaces: [...c.exposedInterfaces].sort(),
        owningBoundary: c.owningBoundary,
        sourceReferences: [...c.sourceReferences].sort(),
        status: c.status,
      })),
      dataArchitecture,
      apiCommunicationArchitecture,
      technologyStack: technologyStack.map((t) => ({
        category: t.category,
        name: t.name,
        selectionStatus: t.selectionStatus,
        versionConstraint: t.versionConstraint,
        source: t.source,
        affectedRequirements: [...t.affectedRequirements].sort(),
        rationale: t.rationale,
      })),
      platformEnvironment,
      securityArchitecture,
      integrations: integrationList.map((i) => ({
        integrationId: i.integrationId,
        system: i.system,
        purpose: i.purpose,
        protocol: i.protocol,
        direction: i.direction,
        dependency: i.dependency,
        status: i.status,
        source: i.source,
        affectedRequirements: [...i.affectedRequirements].sort(),
      })),
      deploymentArchitecture,
      decisions: decisions.map((d) => ({
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
        revisionBinding: d.revisionBinding,
      })),
      pendingHumanDecisions: pendingHumanDecisions.map((p) => ({
        decisionId: p.decisionId,
        question: p.question,
        whyItMatters: p.whyItMatters,
        affectedRequirements: [...p.affectedRequirements].sort(),
        affectedArchitectureAreas: [...p.affectedArchitectureAreas].sort(),
        availableOptions: [...p.availableOptions].sort(),
        consequences: [...p.consequences].sort(),
        authority: p.authority,
        status: p.status,
      })),
      requirementsTraceability: traceabilityLinks.map((tl) => ({
        requirementId: tl.requirementId,
        requirementTitle: tl.requirementTitle,
        addressedByComponents: [...tl.addressedByComponents].sort(),
        addressedByDecisions: [...tl.addressedByDecisions].sort(),
        addressedByTechnologies: [...tl.addressedByTechnologies].sort(),
      })),
    };

    const fingerprint = computeDeterministicFingerprint(fingerprintMaterial);

    // Check if identical revision has already been saved for this project
    const latest = await this.architectureStore.loadRevision(requirements.projectId);
    if (latest && latest.fingerprint === fingerprint) {
      return latest;
    }

    const latestArchRev = await this.architectureStore.getLatestRevisionNumber(
      requirements.projectId
    );
    const architectureRevision = latestArchRev + 1;

    const artifact: ProjectArchitectureRevision = {
      projectId: requirements.projectId,
      architectureRevision,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceDiscoveryRevision: requirements.sourceDiscoveryRevision,
      sourceDiscoveryFingerprint: requirements.sourceDiscoveryFingerprint,
      isStale: false,
      architecturalStyle,
      systemComponents,
      dataArchitecture,
      apiCommunicationArchitecture,
      technologyStack,
      platformEnvironment,
      securityArchitecture,
      integrations: integrationList,
      deploymentArchitecture,
      decisions,
      pendingHumanDecisions,
      requirementsTraceability: traceabilityLinks,
      createdAt: new Date().toISOString(),
      fingerprint,
    };

    // 14. Durably persist
    await this.architectureStore.saveRevision(artifact);

    return artifact;
  }

  /**
   * Retrieves latest architecture revision for a project.
   */
  async getLatest(projectId: string): Promise<ProjectArchitectureRevision | null> {
    const result = await this.architectureStore.loadRevision(projectId);
    if (!result) return null;
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Retrieves specific architecture revision for a project.
   */
  async getRevision(
    projectId: string,
    revision: number
  ): Promise<ProjectArchitectureRevision | null> {
    const result = await this.architectureStore.loadRevision(projectId, revision);
    if (!result) return null;
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Checks whether an architecture revision is stale relative to latest requirements or discovery.
   */
  async isRevisionStale(revision: ProjectArchitectureRevision): Promise<boolean> {
    const safeProjectId = this.architectureStore.sanitizeProjectId(revision.projectId);

    // Check if requirements have advanced
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (!latestRequirements) {
      return true;
    }
    if (latestRequirements.requirementsRevision !== revision.sourceRequirementsRevision) {
      return true;
    }
    if (latestRequirements.fingerprint !== revision.sourceRequirementsFingerprint) {
      return true;
    }

    // Check if discovery has advanced
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
