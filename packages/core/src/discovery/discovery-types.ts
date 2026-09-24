/**
 * Discovery Engine Domain Types & Contracts (Phase 8 TASK-P8-03)
 *
 * Defines the structured, typed representation for existing project discovery:
 * - ProjectDiscoveryReport
 * - EvidenceReference (traceable source evidence)
 * - Fact / Observation / Inference / Unknown / Contradiction separation
 * - Purpose understanding classification
 * - Technology stack & architecture inventory
 * - Entrypoints & command discovery (discovered vs unknown)
 * - Feature inventory
 * - Clarification candidates for P8-04
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only discovery result representation.
 * 2. Fact / Inference / Unknown separation is mandatory.
 * 3. Never promote AGENT_CLAIM to SYSTEM_VERIFIED_EVIDENCE.
 * 4. No arbitrary numeric confidence scores; use explicit domain enumerations.
 * 5. Every important claim preserves an EvidenceReference.
 */

// ============================================================================
// 1. EVIDENCE REFERENCES
// ============================================================================

export type EvidenceSourceType =
  | 'FILE'
  | 'CONFIG'
  | 'SPEC_STORE'
  | 'STATE_MANAGER'
  | 'GIT'
  | 'HISTORY'
  | 'PACKAGE_MANIFEST'
  | 'CODE_AST'
  | 'CI_WORKFLOW'
  | 'MAKEFILE'
  | 'SYSTEM_VERIFIED_EVIDENCE';

export interface EvidenceReference {
  readonly sourceType: EvidenceSourceType;
  readonly sourceIdentifier: string;
  readonly path?: string;
  readonly section?: string;
  readonly lineRange?: { readonly start: number; readonly end: number };
  readonly hash?: string;
  readonly contextLayer?: 'L0' | 'L1' | 'L2';
  readonly isSystemVerified?: boolean;
}

// ============================================================================
// 2. PURPOSE UNDERSTANDING
// ============================================================================

export type PurposeClassification = 'UNDERSTOOD' | 'PARTIALLY_UNDERSTOOD' | 'UNKNOWN';

export interface ProjectPurposeUnderstanding {
  readonly classification: PurposeClassification;
  readonly summary: string;
  readonly rawDescription?: string;
  readonly domainKeywords: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 3. TECHNOLOGY STACK DISCOVERY
// ============================================================================

export type WorkspaceType = 'monorepo' | 'standalone' | 'multi-package' | 'unknown';

export interface TechnologyStackInfo {
  readonly primaryLanguages: readonly string[];
  readonly frameworks: readonly string[];
  readonly buildTools: readonly string[];
  readonly packageManagers: readonly string[];
  readonly runtimes: readonly string[];
  readonly containerization: readonly string[];
  readonly ciCd: readonly string[];
  readonly workspaceType: WorkspaceType;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 4. REPOSITORY STRUCTURE & ARCHITECTURE
// ============================================================================

export type ArchitecturalAreaCategory =
  | 'frontend'
  | 'backend'
  | 'api'
  | 'database'
  | 'domain'
  | 'infrastructure'
  | 'workers'
  | 'cli'
  | 'services'
  | 'tests'
  | 'config'
  | 'deployment'
  | 'documentation';

export interface ArchitecturalArea {
  readonly area: ArchitecturalAreaCategory;
  readonly path: string;
  readonly description: string;
  readonly keyComponents: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

export interface ArchitectureSummary {
  readonly identifiedAreas: readonly ArchitecturalArea[];
  readonly architecturalPattern: string;
  readonly summary: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface RepositoryStructureInfo {
  readonly layout: 'monorepo' | 'standard-src' | 'flat' | 'unknown';
  readonly topLevelDirectories: readonly string[];
  readonly totalFileCount: number;
  readonly significantFiles: readonly string[];
  readonly fileExtensions: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 5. ENTRYPOINTS & COMMANDS
// ============================================================================

export type EntryPointType = 'cli' | 'web' | 'service' | 'library' | 'main' | 'worker';

export interface DiscoveredEntryPoint {
  readonly type: EntryPointType;
  readonly target: string;
  readonly command?: string;
  readonly source: string;
  readonly isAuthoritative: boolean;
  readonly evidence: readonly EvidenceReference[];
}

export type CommandStatus = 'DISCOVERED' | 'UNKNOWN';

export interface DiscoveredCommand {
  readonly status: CommandStatus;
  readonly command?: string;
  readonly source?: string;
  readonly rawDeclaration?: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface ProjectCommands {
  readonly build: DiscoveredCommand;
  readonly test: DiscoveredCommand;
  readonly runtime: DiscoveredCommand;
  readonly lint: DiscoveredCommand;
}

// ============================================================================
// 6. FEATURE INVENTORY
// ============================================================================

export type FeatureStatus =
  | 'IMPLEMENTED'
  | 'PARTIALLY_IMPLEMENTED'
  | 'DOCUMENTED_ONLY'
  | 'INFERRED';

export interface DiscoveredFeature {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly path?: string;
  readonly status: FeatureStatus;
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 7. DOCUMENTATION, REQUIREMENTS & DECISIONS
// ============================================================================

export interface DocumentationSummary {
  readonly hasReadme: boolean;
  readonly readmePath?: string;
  readonly hasContributing: boolean;
  readonly hasArchitectureDocs: boolean;
  readonly documentationFiles: readonly string[];
  readonly summary: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface RequirementItemSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly authority: string;
  readonly acceptanceCriteriaCount: number;
}

export interface RequirementsSummary {
  readonly totalRequirements: number;
  readonly lockedCount: number;
  readonly source: 'AIDM_SPEC_STORE' | 'NONE';
  readonly requirements: readonly RequirementItemSummary[];
  readonly evidence: readonly EvidenceReference[];
}

export interface DecisionItemSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly authority: string;
}

export interface DecisionsSummary {
  readonly totalDecisions: number;
  readonly source: 'AIDM_SPEC_STORE' | 'NONE';
  readonly decisions: readonly DecisionItemSummary[];
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 8. IMPLEMENTATION & GIT STATUS
// ============================================================================

export interface ImplementationStateSummary {
  readonly lifecycleState: string;
  readonly activeTaskId?: string;
  readonly hasActiveTask: boolean;
  readonly isBlocked: boolean;
  readonly blockedReason?: string;
  readonly totalTasksInDag: number;
  readonly completedTasksCount: number;
  readonly evidence: readonly EvidenceReference[];
}

export interface GitStateSummary {
  readonly headCommit?: string;
  readonly branch?: string;
  readonly trackingBranch?: string;
  readonly isClean?: boolean;
  readonly uncommittedChangesCount: number;
  readonly untrackedFilesCount: number;
  readonly acceptedCheckpoint?: {
    readonly checkpointId: string;
    readonly commitHash: string;
  };
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 9. FACT / OBSERVATION / INFERENCE / UNKNOWN / CONTRADICTION SEPARATION
// ============================================================================

export interface DiscoveryFact {
  readonly id: string;
  readonly statement: string;
  readonly category: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface DiscoveryObservation {
  readonly id: string;
  readonly observation: string;
  readonly category: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface DiscoveryInference {
  readonly id: string;
  readonly inference: string;
  readonly rationale: string;
  readonly basisEvidence: readonly EvidenceReference[];
}

export interface DiscoveryUnknown {
  readonly id: string;
  readonly item: string;
  readonly description: string;
  readonly impact: string;
}

export interface DiscoveryContradictionSource {
  readonly description: string;
  readonly evidence: EvidenceReference;
}

export interface DiscoveryContradiction {
  readonly id: string;
  readonly description: string;
  readonly category: string;
  readonly sourceA: DiscoveryContradictionSource;
  readonly sourceB: DiscoveryContradictionSource;
  readonly unresolved: true;
}

// ============================================================================
// 10. CLARIFICATION CANDIDATES (FOR P8-04)
// ============================================================================

export type ClarificationCategory =
  | 'PURPOSE'
  | 'ENTRYPOINT'
  | 'FEATURE_SCOPE'
  | 'COMMAND'
  | 'ARCHITECTURE'
  | 'CONTRADICTION'
  | 'REQUIREMENTS';

export interface ClarificationCandidate {
  readonly id: string;
  readonly category: ClarificationCategory;
  readonly title: string;
  readonly question: string;
  readonly contradictionRef?: string;
  readonly options?: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

// ============================================================================
// 11. PROJECT IDENTITY & COMPLETE DISCOVERY REPORT
// ============================================================================

export interface ProjectIdentity {
  readonly name: string;
  readonly version?: string;
  readonly workspaceRoot: string;
  readonly ecosystem: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface ProjectDiscoveryReport {
  readonly projectIdentity: ProjectIdentity;
  readonly purpose: ProjectPurposeUnderstanding;
  readonly technologyStack: TechnologyStackInfo;
  readonly repositoryStructure: RepositoryStructureInfo;
  readonly architecture: ArchitectureSummary;
  readonly entryPoints: readonly DiscoveredEntryPoint[];
  readonly commands: ProjectCommands;
  readonly featureInventory: readonly DiscoveredFeature[];
  readonly documentationSummary: DocumentationSummary;
  readonly requirementsSummary: RequirementsSummary;
  readonly decisionsSummary: DecisionsSummary;
  readonly currentImplementationState: ImplementationStateSummary;
  readonly gitStatus: GitStateSummary;
  readonly facts: readonly DiscoveryFact[];
  readonly observations: readonly DiscoveryObservation[];
  readonly inferences: readonly DiscoveryInference[];
  readonly unknowns: readonly DiscoveryUnknown[];
  readonly contradictions: readonly DiscoveryContradiction[];
  readonly clarificationCandidates: readonly ClarificationCandidate[];
  readonly recommendedNextAction: 'PROCEED_TO_CLARIFICATION' | 'REQUEST_ADDITIONAL_DISCOVERY';
  readonly timestamp: string;
}

// ============================================================================
// 12. DISCOVERY OPTIONS
// ============================================================================

export interface DiscoveryOptions {
  readonly targetScope?: readonly string[];
  readonly maxFileScan?: number;
  readonly maxDocBytes?: number;
  readonly maxFeatures?: number;
  readonly allowContextRefresh?: boolean;
}
