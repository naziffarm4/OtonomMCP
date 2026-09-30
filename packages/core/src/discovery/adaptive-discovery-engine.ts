/**
 * Adaptive Project Discovery Engine (Phase 15 TASK-P15-01)
 *
 * Implements the authoritative, progressively refined Project Initiation discovery:
 * - Transforms natural-language Product Owner intent into structured discovery records.
 * - Evaluates missing information adaptively rather than using a rigid questionnaire.
 * - Does not ask questions for details the user or context has already specified.
 * - Prioritizes questions as BLOCKING, NON_BLOCKING, or INFORMATIONAL.
 * - Detects Human Decision Points where only the Product Owner has authority to choose.
 * - Creates immutable, revisioned discovery records persisted via AdaptiveDiscoveryStore.
 * - Preserves existing SpecStore requirements/decisions and previous revision data.
 * - Computes deterministic identities and fingerprints without timestamps or random IDs.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Product Owner remains the sole product authority (discovery proposes, PO decides).
 * 2. Discovery does NOT approve a project (DISCOVERY != APPROVAL != AUTHORIZATION).
 * 3. Discovery does NOT invoke Antigravity, create execution intent, or execute tasks.
 * 4. Strictly deterministic: identical input + identical state produces identical output & fingerprint.
 * 5. Reuses authoritative systems (SpecStore, HistoryManager, DurableStateManager).
 */

import * as path from 'node:path';
import type { SpecStore } from '../storage/spec-store.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { DurableStateManager } from '../storage/durable-state.js';
import { ProjectDiscoveryEngine } from './discovery-engine.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import {
  AdaptiveDiscoveryInputZodSchema,
  type AdaptiveDiscoveryInput,
  type ProjectDiscoveryRevision,
  type DiscoverySections,
  type FunctionalRequirementItem,
  type HumanDecisionPoint,
  type DiscoveryQuestion,
  type DiscoveryRisk,
  type DiscoveryCompletenessInfo,
  type QuestionClassification,
} from './adaptive-discovery-types.js';
import {
  DiscoveryValidationError,
  DiscoveryProjectBindingMismatchError,
} from './adaptive-discovery-errors.js';
import {
  extractStructuredDiscoveryFromIntent,
  deduplicateRequirements,
  deduplicateStrings,
  createDeterministicQuestionId,
  createDeterministicDecisionId,
  createDeterministicRequirementId,
  computeDeterministicFingerprint,
} from './adaptive-discovery-normalizer.js';

export interface AdaptiveDiscoveryEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;
  readonly durableStateManager?: DurableStateManager;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly existingDiscoveryEngine?: ProjectDiscoveryEngine;
}

export class AdaptiveDiscoveryEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  private readonly specStore?: SpecStore;
  private readonly historyManager?: HistoryManager;
  private readonly durableStateManager?: DurableStateManager;
  private readonly discoveryStore: AdaptiveDiscoveryStore;
  private readonly existingDiscoveryEngine?: ProjectDiscoveryEngine;

  constructor(options?: AdaptiveDiscoveryEngineOptions) {
    this.workspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
    this.baseDir = options?.baseDir
      ? path.resolve(options.baseDir)
      : this.workspaceRoot ?? process.cwd();
    this.specStore = options?.specStore;
    this.historyManager = options?.historyManager;
    this.durableStateManager = options?.durableStateManager;
    this.discoveryStore =
      options?.discoveryStore ??
      new AdaptiveDiscoveryStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });
    this.existingDiscoveryEngine = options?.existingDiscoveryEngine;
  }

  /**
   * Executes adaptive discovery on an initial or progressive project request.
   */
  async discover(input: AdaptiveDiscoveryInput = {}): Promise<ProjectDiscoveryRevision> {
    // 1. Schema Validation of untrusted input
    const parsedInput = AdaptiveDiscoveryInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new DiscoveryValidationError(
        `Invalid adaptive discovery input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    // 2. Resolve Project Identity and validate binding
    const resolvedProjectId = this.resolveProjectId(input);
    this.discoveryStore.sanitizeProjectId(resolvedProjectId);

    // 3. Load previous latest revision if one exists (for progressive refinement)
    const previousRevision = await this.discoveryStore.loadRevision(resolvedProjectId);
    const nextRevisionNumber = previousRevision ? previousRevision.discoveryRevision + 1 : 1;

    // 4. Ingest authoritative existing SpecStore context if available
    const existingSpecRequirements = await this.loadExistingSpecRequirements();
    const existingSpecDecisions = await this.loadExistingSpecDecisions();

    // 5. Ingest existing repository discovery (if workspace exists and has files)
    const existingRepoFindings = await this.inspectExistingRepositoryIfAvailable();

    // 6. Extract structured discovery from raw prompt (natural language intent)
    const rawPrompt = (input.rawPrompt ?? '').trim();
    const extracted = rawPrompt.length > 0
      ? extractStructuredDiscoveryFromIntent(rawPrompt, resolvedProjectId)
      : null;

    // 7. Synthesize Discovery Sections across all 10 discovery areas
    const sections = this.synthesizeSections({
      projectId: resolvedProjectId,
      previousRevision,
      extracted,
      explicitSections: input.explicitSections,
      resolvedAnswers: input.resolvedAnswers,
      decidedHumanDecisions: input.decidedHumanDecisions,
      existingSpecRequirements,
      existingSpecDecisions,
      existingRepoFindings,
    });

    // 8. Adaptive Missing-Information & Question Generation
    const { questions, decisions } = this.generateAdaptiveQuestionsAndDecisions(
      sections,
      input.resolvedAnswers ?? {},
      input.decidedHumanDecisions ?? {}
    );

    // Merge existing SpecStore decisions, prior revision decisions, and newly generated decisions
    const allDecisionsMap = new Map<string, HumanDecisionPoint>();
    for (const d of existingSpecDecisions) {
      allDecisionsMap.set(d.id, d);
    }
    if (previousRevision) {
      for (const d of previousRevision.decisions) {
        const chosen = input.decidedHumanDecisions?.[d.id] ?? d.selectedOption;
        if (chosen) {
          allDecisionsMap.set(d.id, {
            ...d,
            status: 'DECIDED',
            selectedOption: chosen,
          });
        } else {
          allDecisionsMap.set(d.id, d);
        }
      }
    }
    for (const d of decisions) {
      allDecisionsMap.set(d.id, d);
    }
    const finalDecisions = Array.from(allDecisionsMap.values()).sort((a, b) => a.id.localeCompare(b.id));

    // Update sections with generated questions and decisions
    const finalSections: DiscoverySections = {
      ...sections,
      humanDecisions: finalDecisions,
      openQuestions: questions,
    };

    // 9. Compute Completeness Information
    const completeness = this.computeCompleteness(finalSections);

    // 10. Compute Changed Sections
    const changedSections = this.computeChangedSections(previousRevision, finalSections);

    // 11. Compile Aggregate Requirements, Risks, and Decisions Lists
    const allRequirements = deduplicateRequirements(
      finalSections.functionalRequirements.capabilities
    );
    const allRisks = [
      ...finalSections.risks.technicalRisks,
      ...finalSections.risks.productRisks,
      ...finalSections.risks.operationalRisks,
    ].sort((a, b) => a.id.localeCompare(b.id));

    // 12. Compute Deterministic Fingerprint
    const fingerprintMaterial = {
      projectId: resolvedProjectId,
      discoveryRevision: nextRevisionNumber,
      previousRevision: previousRevision ? previousRevision.discoveryRevision : null,
      source: input.source ?? (nextRevisionNumber === 1 ? 'PRODUCT_OWNER_REQUEST' : 'PROGRESSIVE_REFINEMENT'),
      changedSections: [...changedSections].sort(),
      sections: finalSections,
      requirements: allRequirements,
      decisions: finalDecisions,
      openQuestions: [...questions].sort((a, b) => a.id.localeCompare(b.id)),
      risks: allRisks,
      completeness,
    };
    const fingerprint = computeDeterministicFingerprint(fingerprintMaterial);

    // 13. Build Immutable Revision Record
    const revisionRecord: ProjectDiscoveryRevision = {
      projectId: resolvedProjectId,
      discoveryRevision: nextRevisionNumber,
      previousRevision: previousRevision ? previousRevision.discoveryRevision : null,
      createdAt: new Date().toISOString(),
      source: input.source ?? (nextRevisionNumber === 1 ? 'PRODUCT_OWNER_REQUEST' : 'PROGRESSIVE_REFINEMENT'),
      changedSections,
      sections: finalSections,
      requirements: allRequirements,
      decisions: finalDecisions,
      openQuestions: questions,
      risks: allRisks,
      completeness,
      fingerprint,
    };

    // 14. Persist to Authoritative Discovery Store
    await this.discoveryStore.saveRevision(revisionRecord);

    return revisionRecord;
  }

  /**
   * Resolves projectId deterministically from input or workspace.
   */
  private resolveProjectId(input: AdaptiveDiscoveryInput): string {
    if (input.projectId && input.projectId.trim().length > 0) {
      return input.projectId.trim();
    }
    if (input.explicitSections?.projectIdentity?.name) {
      return input.explicitSections.projectIdentity.name.trim();
    }
    if (this.workspaceRoot) {
      return path.basename(this.workspaceRoot);
    }
    return 'unnamed-project';
  }

  /**
   * Loads existing requirements from authoritative SpecStore without modifying them.
   */
  private async loadExistingSpecRequirements(): Promise<FunctionalRequirementItem[]> {
    if (!this.specStore) return [];
    try {
      const stored = await this.specStore.loadRequirements();
      return stored.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        behavior: undefined,
        businessRules: [],
        source: 'AIDM_SPEC_STORE',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Loads existing decisions from authoritative SpecStore without modifying them.
   */
  private async loadExistingSpecDecisions(): Promise<HumanDecisionPoint[]> {
    if (!this.specStore) return [];
    try {
      const stored = await this.specStore.loadDecisions();
      return stored.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        affectedAreas: ['spec'],
        alternatives: [d.title, 'Alternative'],
        authority: 'USER',
        status: 'DECIDED',
        selectedOption: d.title,
        rationale: d.rationale,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Inspects existing repository artifacts if available.
   */
  private async inspectExistingRepositoryIfAvailable(): Promise<{
    ecosystem?: string;
    languages?: readonly string[];
  } | null> {
    if (!this.existingDiscoveryEngine) return null;
    try {
      const report = await this.existingDiscoveryEngine.discover();
      return {
        ecosystem: report.projectIdentity?.ecosystem,
        languages: report.technologyStack?.primaryLanguages,
      };
    } catch {
      return null;
    }
  }

  /**
   * Synthesizes discovery sections by merging prior revisions, extracted intent, and explicit sections.
   */
  private synthesizeSections(params: {
    projectId: string;
    previousRevision: ProjectDiscoveryRevision | null;
    extracted: ReturnType<typeof extractStructuredDiscoveryFromIntent> | null;
    explicitSections?: Partial<DiscoverySections>;
    resolvedAnswers?: Readonly<Record<string, string>>;
    decidedHumanDecisions?: Readonly<Record<string, string>>;
    existingSpecRequirements: FunctionalRequirementItem[];
    existingSpecDecisions: HumanDecisionPoint[];
    existingRepoFindings: { ecosystem?: string; languages?: readonly string[] } | null;
  }): DiscoverySections {
    const prev = params.previousRevision?.sections;
    const ext = params.extracted;
    const exp = params.explicitSections;

    // 1. PROJECT_IDENTITY
    const name = exp?.projectIdentity?.name ?? ext?.projectIdentity.name ?? prev?.projectIdentity.name ?? params.projectId;
    const purpose = exp?.projectIdentity?.purpose ?? ext?.projectIdentity.purpose ?? prev?.projectIdentity.purpose ?? 'Pending purpose discovery.';
    const desiredOutcome = exp?.projectIdentity?.desiredOutcome ?? ext?.projectIdentity.desiredOutcome ?? prev?.projectIdentity.desiredOutcome ?? 'Pending desired outcome.';

    // 2. PRODUCT_SCOPE
    const inScope = deduplicateStrings([
      ...(prev?.productScope.inScope ?? []),
      ...(ext?.productScope.inScope ?? []),
      ...(exp?.productScope?.inScope ?? []),
    ]);
    const outOfScope = deduplicateStrings([
      ...(prev?.productScope.outOfScope ?? []),
      ...(ext?.productScope.outOfScope ?? []),
      ...(exp?.productScope?.outOfScope ?? []),
    ]);
    const targetUsers = deduplicateStrings([
      ...(prev?.productScope.targetUsers ?? []),
      ...(ext?.productScope.targetUsers ?? []),
      ...(exp?.productScope?.targetUsers ?? []),
    ]);
    const primaryWorkflows = deduplicateStrings([
      ...(prev?.productScope.primaryWorkflows ?? []),
      ...(ext?.productScope.primaryWorkflows ?? []),
      ...(exp?.productScope?.primaryWorkflows ?? []),
    ]);

    // 3. FUNCTIONAL_REQUIREMENTS
    const rawCapabilities: FunctionalRequirementItem[] = [
      ...(params.existingSpecRequirements ?? []),
      ...(prev?.functionalRequirements.capabilities ?? []),
      ...(ext?.capabilities ?? []),
      ...(exp?.functionalRequirements?.capabilities ?? []),
    ];
    const capabilities = deduplicateRequirements(rawCapabilities);

    const behaviors = deduplicateStrings([
      ...(prev?.functionalRequirements.behaviors ?? []),
      ...(ext?.behaviors ?? []),
      ...(exp?.functionalRequirements?.behaviors ?? []),
    ]);
    const businessRules = deduplicateStrings([
      ...(prev?.functionalRequirements.businessRules ?? []),
      ...(ext?.businessRules ?? []),
      ...(exp?.functionalRequirements?.businessRules ?? []),
    ]);

    // 4. NON_FUNCTIONAL_REQUIREMENTS
    const mergeNfrWithRefinement = (prevItems: string[] = [], newItems: string[] = [], expItems: string[] = []): string[] => {
      const allNew = [...newItems, ...expItems];
      const filteredPrev = prevItems.filter((prevItem) => {
        const isSuperseded = allNew.some((newItem) => {
          const p = prevItem.toLowerCase().trim();
          const n = newItem.toLowerCase().trim();
          return n !== p && n.startsWith(p);
        });
        return !isSuperseded;
      });
      return deduplicateStrings([...filteredPrev, ...allNew]);
    };

    const performance = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.performance,
      ext?.nonFunctional.performance,
      exp?.nonFunctionalRequirements?.performance
    );
    const security = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.security,
      ext?.nonFunctional.security,
      exp?.nonFunctionalRequirements?.security
    );
    const reliability = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.reliability,
      ext?.nonFunctional.reliability,
      exp?.nonFunctionalRequirements?.reliability
    );
    const scalability = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.scalability,
      ext?.nonFunctional.scalability,
      exp?.nonFunctionalRequirements?.scalability
    );
    const availability = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.availability,
      ext?.nonFunctional.availability,
      exp?.nonFunctionalRequirements?.availability
    );
    const usability = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.usability,
      ext?.nonFunctional.usability,
      exp?.nonFunctionalRequirements?.usability
    );
    const compatibility = mergeNfrWithRefinement(
      prev?.nonFunctionalRequirements.compatibility,
      ext?.nonFunctional.compatibility,
      exp?.nonFunctionalRequirements?.compatibility
    );

    // 5. TECHNOLOGY
    const requiredTechnologies = deduplicateStrings([
      ...(prev?.technology.requiredTechnologies ?? []),
      ...(ext?.technology.requiredTechnologies ?? []),
      ...(exp?.technology?.requiredTechnologies ?? []),
      ...(params.existingRepoFindings?.languages ?? []),
    ]);
    const preferredTechnologies = deduplicateStrings([
      ...(prev?.technology.preferredTechnologies ?? []),
      ...(ext?.technology.preferredTechnologies ?? []),
      ...(exp?.technology?.preferredTechnologies ?? []),
    ]);
    const prohibitedTechnologies = deduplicateStrings([
      ...(prev?.technology.prohibitedTechnologies ?? []),
      ...(ext?.technology.prohibitedTechnologies ?? []),
      ...(exp?.technology?.prohibitedTechnologies ?? []),
    ]);
    const platformConstraints = deduplicateStrings([
      ...(prev?.technology.platformConstraints ?? []),
      ...(ext?.technology.platformConstraints ?? []),
      ...(exp?.technology?.platformConstraints ?? []),
    ]);

    // 6. ARCHITECTURE
    const architecturalConstraints = deduplicateStrings([
      ...(prev?.architecture.architecturalConstraints ?? []),
      ...(ext?.architecture.architecturalConstraints ?? []),
      ...(exp?.architecture?.architecturalConstraints ?? []),
    ]);
    const integrationRequirements = deduplicateStrings([
      ...(prev?.architecture.integrationRequirements ?? []),
      ...(ext?.architecture.integrationRequirements ?? []),
      ...(exp?.architecture?.integrationRequirements ?? []),
    ]);
    const deploymentModel = exp?.architecture?.deploymentModel ?? ext?.architecture.deploymentModel ?? prev?.architecture.deploymentModel;
    const dataStorageExpectations = deduplicateStrings([
      ...(prev?.architecture.dataStorageExpectations ?? []),
      ...(ext?.architecture.dataStorageExpectations ?? []),
      ...(exp?.architecture?.dataStorageExpectations ?? []),
    ]);

    // 7. ACCEPTANCE
    const expectedBehavior = deduplicateStrings([
      ...(prev?.acceptance.expectedBehavior ?? []),
      ...(ext?.acceptance.expectedBehavior ?? []),
      ...(exp?.acceptance?.expectedBehavior ?? []),
    ]);
    const measurableCriteria = deduplicateStrings([
      ...(prev?.acceptance.measurableCriteria ?? []),
      ...(ext?.acceptance.measurableCriteria ?? []),
      ...(exp?.acceptance?.measurableCriteria ?? []),
    ]);
    const definitionOfCompletion = deduplicateStrings([
      ...(prev?.acceptance.definitionOfCompletion ?? []),
      ...(ext?.acceptance.definitionOfCompletion ?? []),
      ...(exp?.acceptance?.definitionOfCompletion ?? []),
    ]);

    // 8. RISKS
    const technicalRisks = [
      ...(prev?.risks.technicalRisks ?? []),
      ...(ext?.risks.technicalRisks ?? []),
      ...(exp?.risks?.technicalRisks ?? []),
    ];
    const productRisks = [
      ...(prev?.risks.productRisks ?? []),
      ...(ext?.risks.productRisks ?? []),
      ...(exp?.risks?.productRisks ?? []),
    ];
    const operationalRisks = [
      ...(prev?.risks.operationalRisks ?? []),
      ...(ext?.risks.operationalRisks ?? []),
      ...(exp?.risks?.operationalRisks ?? []),
    ];
    const dependencies = deduplicateStrings([
      ...(prev?.risks.dependencies ?? []),
      ...(ext?.risks.dependencies ?? []),
      ...(exp?.risks?.dependencies ?? []),
    ]);

    return {
      projectIdentity: {
        name,
        purpose,
        desiredOutcome,
      },
      productScope: {
        inScope,
        outOfScope,
        targetUsers,
        primaryWorkflows,
      },
      functionalRequirements: {
        capabilities,
        behaviors,
        businessRules,
      },
      nonFunctionalRequirements: {
        performance,
        security,
        reliability,
        scalability,
        availability,
        usability,
        compatibility,
      },
      technology: {
        requiredTechnologies,
        preferredTechnologies,
        prohibitedTechnologies,
        platformConstraints,
      },
      architecture: {
        architecturalConstraints,
        integrationRequirements,
        deploymentModel,
        dataStorageExpectations,
      },
      acceptance: {
        expectedBehavior,
        measurableCriteria,
        definitionOfCompletion,
      },
      risks: {
        technicalRisks,
        productRisks,
        operationalRisks,
        dependencies,
      },
      humanDecisions: [],
      openQuestions: [],
    };
  }

  /**
   * Adaptively determines which questions and human decisions are required.
   * INVARIANT: Never asks questions for information already specified!
   */
  private generateAdaptiveQuestionsAndDecisions(
    sections: DiscoverySections,
    resolvedAnswers: Readonly<Record<string, string>>,
    decidedHumanDecisions: Readonly<Record<string, string>>
  ): {
    questions: DiscoveryQuestion[];
    decisions: HumanDecisionPoint[];
  } {
    const questions: DiscoveryQuestion[] = [];
    const decisions: HumanDecisionPoint[] = [];

    // Helper to add a question
    const addQuestion = (params: {
      category: string;
      question: string;
      whyItMatters: string;
      whatItAffects: string[];
      classification: QuestionClassification;
      requiredDecision: string;
      dependentSection: string;
      impact: string;
      options?: string[];
    }) => {
      const id = createDeterministicQuestionId(
        params.category,
        params.question,
        params.dependentSection
      );
      const answer = resolvedAnswers[id];
      questions.push({
        id,
        question: params.question,
        category: params.category,
        whyItMatters: params.whyItMatters,
        whatItAffects: params.whatItAffects,
        classification: params.classification,
        requiredDecision: params.requiredDecision,
        dependentSection: params.dependentSection,
        impact: params.impact,
        options: params.options,
        resolvedAnswer: answer,
        status: answer ? 'RESOLVED' : 'OPEN',
      });
    };

    // Helper to add a human decision
    const addDecision = (params: {
      title: string;
      description: string;
      affectedAreas: string[];
      alternatives: string[];
      recommendedOption?: string;
      rationale?: string;
    }) => {
      const id = createDeterministicDecisionId(params.title, params.alternatives);
      const chosen = decidedHumanDecisions[id];
      decisions.push({
        id,
        title: params.title,
        description: params.description,
        affectedAreas: params.affectedAreas,
        alternatives: params.alternatives,
        recommendedOption: params.recommendedOption,
        rationale: params.rationale,
        authority: 'USER',
        status: chosen ? 'DECIDED' : 'PENDING_DECISION',
        selectedOption: chosen,
      });
    };

    // 1. Identity completeness
    if (!sections.projectIdentity.purpose || sections.projectIdentity.purpose.startsWith('Pending')) {
      addQuestion({
        category: 'PROJECT_IDENTITY',
        question: 'What is the primary purpose and expected outcome of this project?',
        whyItMatters: 'Establishes project definition and guides all architectural and scope decisions.',
        whatItAffects: ['scope', 'architecture', 'acceptance'],
        classification: 'BLOCKING',
        requiredDecision: 'Define core project purpose',
        dependentSection: 'projectIdentity',
        impact: 'Without purpose, scope and requirements cannot be validated.',
      });
    }

    // 2. Platform / Runtime Constraints
    // RULE: If platform is already specified, do NOT ask for it!
    if (sections.technology.platformConstraints.length === 0) {
      addQuestion({
        category: 'TECHNOLOGY',
        question: 'What is the primary target runtime platform (e.g. Web, Mobile, Desktop, CLI)?',
        whyItMatters: 'Platform constraints determine client architecture, UI framework, and build pipeline.',
        whatItAffects: ['technology choice', 'architecture', 'implementation scope'],
        classification: 'BLOCKING',
        requiredDecision: 'Select target platform',
        dependentSection: 'technology',
        impact: 'Cannot determine client stack or test targets without platform specification.',
        options: ['Web Application', 'Mobile Application (iOS/Android)', 'Desktop Application', 'Command Line Tool (CLI)'],
      });
    }

    // 3. Technology Stack & Ecosystem
    // RULE: If language/tech is already specified, do NOT ask for it!
    if (
      sections.technology.requiredTechnologies.length === 0 &&
      sections.technology.preferredTechnologies.length === 0
    ) {
      addQuestion({
        category: 'TECHNOLOGY',
        question: 'Which primary programming language and framework ecosystem should be used?',
        whyItMatters: 'Ecosystem dictates package dependencies, tooling, CI/CD, and runtime constraints.',
        whatItAffects: ['technology choice', 'architecture'],
        classification: 'BLOCKING',
        requiredDecision: 'Select programming language and framework',
        dependentSection: 'technology',
        impact: 'Implementation cannot begin without selected language and toolchain.',
        options: ['TypeScript / Node.js', 'Python', 'Go', 'Rust'],
      });
    }

    // 4. Primary Workflows
    // RULE: If primary workflows are already defined, do NOT ask for them!
    if (sections.productScope.primaryWorkflows.length === 0) {
      addQuestion({
        category: 'PRODUCT_SCOPE',
        question: 'What are the primary end-to-end user workflows or core interactions?',
        whyItMatters: 'Workflows define the required sequence of capabilities and acceptance scenarios.',
        whatItAffects: ['implementation scope', 'acceptance criteria'],
        classification: 'BLOCKING',
        requiredDecision: 'Define primary workflows',
        dependentSection: 'productScope',
        impact: 'Tasks and test specifications cannot be formulated without workflows.',
      });
    }

    // 5. Architecture & Data Storage Dependency
    // If capabilities involve accounts, rooms, or data, but storage is unstated
    const hasDataNeed = sections.functionalRequirements.capabilities.some(
      (c) =>
        c.title.toLowerCase().includes('account') ||
        c.title.toLowerCase().includes('room') ||
        c.title.toLowerCase().includes('score') ||
        c.title.toLowerCase().includes('data')
    );

    const hasExplicitStorage =
      sections.architecture.dataStorageExpectations.some((s) =>
        /sql|mongo|redis|postgres|sqlite|database/i.test(s)
      ) ||
      sections.technology.preferredTechnologies.some((t) =>
        /sql|mongo|redis|postgres|sqlite/i.test(t)
      ) ||
      sections.technology.requiredTechnologies.some((t) =>
        /sql|mongo|redis|postgres|sqlite/i.test(t)
      );

    if (hasDataNeed && !hasExplicitStorage) {
      addDecision({
        title: 'Database & Storage Paradigm Selection',
        description: 'Choose the authoritative persistence engine for user accounts, room states, and score records.',
        affectedAreas: ['architecture', 'technology choice', 'security'],
        alternatives: [
          'SQL / Relational (PostgreSQL / SQLite)',
          'NoSQL / Document Store (MongoDB)',
          'In-Memory Key-Value with Durable Snapshots (Redis)',
        ],
        recommendedOption: 'SQL / Relational (PostgreSQL / SQLite)',
        rationale: 'Relational structure guarantees ACID transactions for accounts and scores.',
      });

      addQuestion({
        category: 'ARCHITECTURE',
        question: 'What data storage architecture and persistence engine should be adopted?',
        whyItMatters: 'Data storage engine directly shapes domain data models, queries, and persistence adapters.',
        whatItAffects: ['architecture', 'technology choice', 'database schema'],
        classification: 'BLOCKING',
        requiredDecision: 'Product Owner must decide storage engine (SQL vs NoSQL vs In-Memory)',
        dependentSection: 'architecture',
        impact: 'Domain models and persistence tasks cannot be scheduled without database choice.',
        options: [
          'SQL / Relational (PostgreSQL / SQLite)',
          'NoSQL / Document Store (MongoDB)',
          'In-Memory Key-Value with Durable Snapshots (Redis)',
        ],
      });
    }

    // 6. Deployment Model (Human Decision Point)
    if (!sections.architecture.deploymentModel) {
      addDecision({
        title: 'Deployment & Hosting Environment Model',
        description: 'Select the target deployment model for hosting the production system.',
        affectedAreas: ['architecture', 'operational requirements'],
        alternatives: ['Cloud Hosted (AWS / GCP / Azure)', 'Local / Self-Hosted Docker Container'],
        recommendedOption: 'Local / Self-Hosted Docker Container',
        rationale: 'Simplifies initial validation and eliminates cloud billing dependencies during discovery.',
      });
    }

    // 7. Business Rules Dependency: Disconnect & Reconnect Policy
    const hasReconnect = sections.functionalRequirements.capabilities.some((c) =>
      c.title.toLowerCase().includes('reconnect')
    );
    const hasExplicitReconnectRule = sections.functionalRequirements.businessRules.some((r) =>
      r.toLowerCase().includes('grace') || r.toLowerCase().includes('timeout')
    );

    if (hasReconnect && !hasExplicitReconnectRule) {
      addQuestion({
        category: 'FUNCTIONAL_REQUIREMENTS',
        question: 'What is the disconnect grace period and state preservation policy when a player drops connection?',
        whyItMatters: 'Governs server state machine transitions, bot substitute policies, or forfeit triggers.',
        whatItAffects: ['business behavior', 'implementation scope', 'architecture'],
        classification: 'BLOCKING',
        requiredDecision: 'Define reconnection grace duration and bot takeover rules',
        dependentSection: 'functionalRequirements',
        impact: 'Game server state synchronization cannot be implemented without disconnect semantics.',
        options: [
          '60-second grace window with turn timer continuation',
          'Immediate AI bot substitute until player returns',
          '3-minute grace window then match forfeiture',
        ],
      });
    }

    // 8. Acceptance Criteria Dependency
    if (sections.acceptance.measurableCriteria.length === 0) {
      addQuestion({
        category: 'ACCEPTANCE',
        question: 'What are the measurable acceptance criteria required for project verification?',
        whyItMatters: 'Verification and QA engines require measurable criteria to validate completion.',
        whatItAffects: ['acceptance criteria', 'definition of completion'],
        classification: 'BLOCKING',
        requiredDecision: 'Define measurable acceptance criteria',
        dependentSection: 'acceptance',
        impact: 'QA review and approval package cannot evaluate completion without measurable criteria.',
      });
    }

    // 9. Non-Blocking / Informational Questions
    // Logging / Telemetry (Non-blocking)
    addQuestion({
      category: 'NON_FUNCTIONAL_REQUIREMENTS',
      question: 'Are there specific external telemetry, metrics, or error tracking integrations required?',
      whyItMatters: 'Can be configured as an integration without blocking core domain development.',
      whatItAffects: ['operational telemetry'],
      classification: 'NON_BLOCKING',
      requiredDecision: 'Select optional telemetry provider or defer',
      dependentSection: 'nonFunctionalRequirements',
      impact: 'Informational for monitoring; does not prevent core business logic construction.',
      options: ['OpenTelemetry / Prometheus', 'Sentry', 'Standard Console / File Logs only'],
    });

    // Documentation preference (Informational)
    addQuestion({
      category: 'PROJECT_IDENTITY',
      question: 'What is the preferred documentation output format (Markdown docs vs OpenAPI spec)?',
      whyItMatters: 'Cosmetic and developer documentation preference with zero runtime consequence.',
      whatItAffects: ['documentation files'],
      classification: 'INFORMATIONAL',
      requiredDecision: 'Select documentation format preference',
      dependentSection: 'projectIdentity',
      impact: 'Zero execution impact.',
      options: ['Markdown Documentation in docs/', 'OpenAPI / Swagger JSON & YAML'],
    });

    return {
      questions: questions.sort((a, b) => a.id.localeCompare(b.id)),
      decisions: decisions.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /**
   * Computes completeness metrics across all discovery areas.
   */
  private computeCompleteness(sections: DiscoverySections): DiscoveryCompletenessInfo {
    const blockingQuestions = sections.openQuestions.filter(
      (q) => q.classification === 'BLOCKING' && q.status === 'OPEN'
    );
    const resolvedQuestions = sections.openQuestions.filter((q) => q.status === 'RESOLVED');
    const pendingDecisions = sections.humanDecisions.filter(
      (d) => d.status === 'PENDING_DECISION'
    );

    const missingMaterial: string[] = [];
    if (!sections.projectIdentity.name || sections.projectIdentity.name === 'unnamed-project') {
      missingMaterial.push('projectIdentity.name');
    }
    if (!sections.projectIdentity.purpose || sections.projectIdentity.purpose.startsWith('Pending')) {
      missingMaterial.push('projectIdentity.purpose');
    }
    if (sections.functionalRequirements.capabilities.length === 0) {
      missingMaterial.push('functionalRequirements.capabilities');
    }
    if (sections.technology.platformConstraints.length === 0) {
      missingMaterial.push('technology.platformConstraints');
    }

    const isComplete =
      blockingQuestions.length === 0 &&
      pendingDecisions.length === 0 &&
      missingMaterial.length === 0;

    return {
      isComplete,
      hasBlockingQuestions: blockingQuestions.length > 0,
      blockingQuestionsCount: blockingQuestions.length,
      totalQuestionsCount: sections.openQuestions.length,
      resolvedQuestionsCount: resolvedQuestions.length,
      pendingHumanDecisionsCount: pendingDecisions.length,
      sectionsEvaluatedCount: 10,
      missingMaterialSections: missingMaterial,
    };
  }

  /**
   * Identifies which sections changed compared to previous revision.
   */
  private computeChangedSections(
    previous: ProjectDiscoveryRevision | null,
    current: DiscoverySections
  ): string[] {
    if (!previous) {
      return Object.keys(current).sort();
    }

    const changed: string[] = [];
    const sectionKeys = Object.keys(current) as Array<keyof DiscoverySections>;

    for (const key of sectionKeys) {
      const prevVal = previous.sections[key];
      const currVal = current[key];
      const prevHash = computeDeterministicFingerprint(prevVal);
      const currHash = computeDeterministicFingerprint(currVal);
      if (prevHash !== currHash) {
        changed.push(key);
      }
    }

    return changed.sort();
  }
}
