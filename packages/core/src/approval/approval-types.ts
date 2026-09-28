/**
 * Initial Project Understanding & Approval Gate Types (Phase 8 TASK-P8-05)
 *
 * Defines the structured, typed domain model for:
 * - InitialProjectUnderstanding (synthesized from discovery & clarification)
 * - Fact / Inference / Assumption / Unresolved separation
 * - Source traceability (discovery evidence, requirements, clarification answers)
 * - ProposedDevelopmentPlan (proposal only, does NOT mutate Task DAG)
 * - ProjectApprovalPackage & versioned revisions
 * - Explicit human Product Owner approval & rejection records
 * - Approval readiness conditions
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. The system MUST NOT infer approval (no natural language "tamam" or implicit signals).
 * 2. Clarification resolved != project understanding approved.
 * 3. Never silently turn inference into confirmed requirement.
 * 4. Approval is strictly bound to exact package revision (immutable per revision).
 * 5. Only human / Product Owner authority can approve; executor/antigravity/system rejected.
 * 6. Does NOT mutate authoritative requirements (SpecStore) or Task DAG.
 * 7. Does NOT invoke Antigravity or autonomous development loop (belong to P10).
 * 8. Does NOT create a second FSM; respects DurableStateManager authority.
 */

import { z } from 'zod';
import * as crypto from 'node:crypto';
import type {
  EvidenceReference,
  ProjectPurposeUnderstanding,
  TechnologyStackInfo,
  ArchitectureSummary,
  ImplementationStateSummary,
  DiscoveryUnknown,
  DiscoveryContradiction,
} from '../discovery/discovery-types.js';
import {
  CompletenessGateResultZodSchema,
  type CompletenessGateResult,
} from '../discovery/completeness-gate-types.js';

// ============================================================================
// 1. UNDERSTANDING ITEM CLASSIFICATION & ORIGIN
// ============================================================================

export const UNDERSTANDING_ITEM_TYPES = [
  'CONFIRMED_FACT',
  'INFERENCE',
  'ASSUMPTION',
  'UNRESOLVED',
] as const;

export type UnderstandingItemType = (typeof UNDERSTANDING_ITEM_TYPES)[number];

export const UNDERSTANDING_SOURCE_ORIGINS = [
  'DISCOVERY_EVIDENCE',
  'EXISTING_REQUIREMENT',
  'EXISTING_DECISION',
  'HUMAN_CLARIFICATION_ANSWER',
  'PRODUCT_OWNER_STATEMENT',
] as const;

export type UnderstandingSourceOrigin = (typeof UNDERSTANDING_SOURCE_ORIGINS)[number];

export interface UnderstandingItem {
  readonly id: string;
  readonly type: UnderstandingItemType;
  readonly origin: UnderstandingSourceOrigin;
  readonly statement: string;
  readonly rationale?: string;
  readonly evidence: readonly EvidenceReference[];
  readonly sourceReferenceId?: string;
}

// ============================================================================
// 2. INITIAL PROJECT UNDERSTANDING MODEL
// ============================================================================

export interface InitialProjectUnderstanding {
  readonly projectId: string;
  readonly projectName: string;
  readonly apparentPurpose: ProjectPurposeUnderstanding;
  readonly targetUsers: readonly string[];
  readonly technologyStack: TechnologyStackInfo;
  readonly architectureSummary: ArchitectureSummary;
  readonly existingCapabilities: readonly string[];
  readonly confirmedRequirements: readonly UnderstandingItem[];
  readonly clarifiedRequirements: readonly UnderstandingItem[];
  readonly unresolvedUnknowns: readonly DiscoveryUnknown[];
  readonly unresolvedContradictions: readonly DiscoveryContradiction[];
  readonly currentImplementationState: ImplementationStateSummary;
  readonly constraints: readonly string[];
  readonly assumptions: readonly UnderstandingItem[];
  readonly nonGoals: readonly string[];
  readonly proposedDevelopmentScope: readonly string[];
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly sourceDiscoveryReference: string;
  readonly sourceClarificationSessionReference?: string;
  readonly generatedAt: string;
}

// ============================================================================
// 3. PROPOSED DEVELOPMENT PLAN (PROPOSAL ONLY)
// ============================================================================

export interface ProposedFeatureGroup {
  readonly name: string;
  readonly description: string;
  readonly targetCapabilities: readonly string[];
}

export interface ProposedDevelopmentPlan {
  readonly objectives: readonly string[];
  readonly proposedScope: readonly string[];
  readonly proposedFeatureGroups: readonly ProposedFeatureGroup[];
  readonly dependencies: readonly string[];
  readonly constraints: readonly string[];
  readonly knownRisks: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly excludedScope: readonly string[];
  readonly suggestedImplementationOrder: readonly string[];
}

// ============================================================================
// 4. APPROVAL STATUS & RECORDS
// ============================================================================

export const PROJECT_APPROVAL_STATUSES = [
  'NOT_READY',
  'READY_FOR_APPROVAL',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
  'STALE',
  'BLOCKED_ON_HUMAN',
] as const;

export type ProjectApprovalStatus = (typeof PROJECT_APPROVAL_STATUSES)[number];

export const APPROVAL_ACTOR_ROLES = ['PRODUCT_OWNER', 'USER'] as const;
export type ApprovalActorRole = (typeof APPROVAL_ACTOR_ROLES)[number];

export const FORBIDDEN_APPROVAL_ACTORS = [
  'EXECUTOR',
  'ANTIGRAVITY',
  'DIRECTOR',
  'ORCHESTRATOR',
  'SYSTEM',
  'AUTOMATED_TEST',
  'DISCOVERY_ENGINE',
  'CLARIFICATION_ENGINE',
] as const;

export interface ProjectApprovalRecord {
  readonly packageId: string;
  readonly revision: number;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole;
  readonly intent: 'EXPLICIT_APPROVAL';
  readonly comment?: string;
  readonly approvedAt: string;
  readonly packageHash: string;
  readonly directorSessionId?: string;
  readonly contextFingerprint?: string;
  readonly understandingRevision?: number | null;
  readonly protocolVersion?: string;
  readonly schemaVersion?: number;
}

export interface ProjectRejectionRecord {
  readonly packageId: string;
  readonly revision: number;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole;
  readonly intent: 'EXPLICIT_REJECTION';
  readonly reason?: string;
  readonly rejectedAt: string;
  readonly packageHash: string;
}

// ============================================================================
// 5. P15 AUTHORITATIVE SOURCE BINDINGS & AUDIT
// ============================================================================

export interface ApprovalSourceBindings {
  readonly projectId: string;
  readonly discoveryRevision: number;
  readonly discoveryFingerprint: string;
  readonly requirementsRevision: number;
  readonly requirementsFingerprint: string;
  readonly architectureRevision: number;
  readonly architectureFingerprint: string;
  readonly businessRulesRevision: number;
  readonly businessRulesFingerprint: string;
  readonly acceptanceCriteriaRevision: number;
  readonly acceptanceCriteriaFingerprint: string;
  readonly riskRevision: number;
  readonly riskFingerprint: string;
  readonly specRevision: number;
  readonly specFingerprint: string;
  readonly completenessFingerprint: string;
  readonly completenessRevision?: number;
}

export interface ApprovalProvenance {
  readonly createdBy: string;
  readonly engineVersion: string;
  readonly evaluatedAt: string;
  readonly sourceStores: readonly string[];
}

export interface ApprovalHistoryEntry {
  readonly eventType: string;
  readonly actor: string;
  readonly actorRole?: string;
  readonly timestamp: string;
  readonly status: string;
  readonly revision: number;
  readonly details?: Record<string, unknown>;
}

export interface ApprovalStaleReport {
  readonly isStale: boolean;
  readonly reasons: readonly string[];
  readonly details: {
    readonly discoveryStale: boolean;
    readonly requirementsStale: boolean;
    readonly architectureStale: boolean;
    readonly businessRulesStale: boolean;
    readonly acceptanceCriteriaStale: boolean;
    readonly risksStale: boolean;
    readonly specStale: boolean;
    readonly completenessStale: boolean;
    readonly humanDecisionsChanged: boolean;
  };
}

// ============================================================================
// 6. PROJECT APPROVAL PACKAGE (DURABLE & REVISIONED)
// ============================================================================

export interface ApprovalPackage {
  readonly packageId: string;
  readonly revision: number;
  readonly approvalPackageRevision: number;
  readonly projectId: string;
  readonly projectUnderstanding: InitialProjectUnderstanding;
  readonly proposedDevelopmentPlan: ProposedDevelopmentPlan;
  readonly specRevision?: number;
  readonly projectSpecRevision?: number;
  readonly sourceBindings?: ApprovalSourceBindings;
  readonly completenessResult?: CompletenessGateResult;
  readonly unresolvedHumanDecisionPoints?: readonly unknown[];
  readonly risksRequiringAttention?: readonly unknown[];
  readonly status: ProjectApprovalStatus;
  readonly approvalRecord?: ProjectApprovalRecord;
  readonly rejectionRecord?: ProjectRejectionRecord;
  readonly packageFingerprint?: string;
  readonly provenance?: ApprovalProvenance;
  readonly history?: readonly ApprovalHistoryEntry[];
  readonly isStale?: boolean;
  readonly staleReport?: ApprovalStaleReport;
  readonly createdAt: string;
  readonly updatedAt: string;

  // Backwards compatibility with Phase 8 / Task decomposition:
  readonly unresolvedItems?: readonly UnderstandingItem[];
  readonly assumptions?: readonly UnderstandingItem[];
  readonly evidenceReferences?: readonly EvidenceReference[];
  readonly clarificationSessionReference?: string;
}

export type ProjectApprovalPackage = ApprovalPackage;

// ============================================================================
// 7. READINESS CHECK & INPUTS
// ============================================================================

export interface ApprovalReadinessBlockingConditions {
  readonly discoveryMissing: boolean;
  readonly requirementsMissing: boolean;
  readonly architectureMissing: boolean;
  readonly businessRulesMissing: boolean;
  readonly acceptanceCriteriaMissing: boolean;
  readonly risksMissing: boolean;
  readonly specMissing: boolean;
  readonly completenessGateMissing: boolean;
  readonly completenessNotComplete: boolean;
  readonly unresolvedHumanDecisions: boolean;
  readonly isStale: boolean;
  readonly integrityFailed: boolean;
  readonly crossProjectMismatch: boolean;
  readonly unresolvedBlockingClarifications: boolean;
  readonly unresolvedBlockingContradictions: boolean;
  readonly understandingInvalid: boolean;
  readonly proposalIncomplete: boolean;
}

export interface ApprovalReadiness {
  readonly isReady: boolean;
  readonly status: ProjectApprovalStatus;
  readonly reasons: readonly string[];
  readonly blockingConditions: ApprovalReadinessBlockingConditions;
  readonly isStale?: boolean;
  readonly sourceBindings?: ApprovalSourceBindings;
  readonly packageFingerprint?: string;
}

export interface ProjectApprovalInput {
  readonly packageId: string;
  readonly revision: number;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole;
  readonly intent: 'EXPLICIT_APPROVAL';
  readonly comment?: string;
  readonly timestamp?: string;
  readonly directorSessionId?: string;
  readonly contextFingerprint?: string;
  readonly understandingRevision?: number | null;
  readonly protocolVersion?: string;
  readonly schemaVersion?: number;
}

export interface ProjectRejectionInput {
  readonly packageId: string;
  readonly revision: number;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole;
  readonly intent: 'EXPLICIT_REJECTION';
  readonly reason?: string;
  readonly timestamp?: string;
}

// ============================================================================
// 7. ZOD VALIDATION SCHEMAS
// ============================================================================

export const UnderstandingItemZodSchema = z.object({
  id: z.string().min(1),
  type: z.enum(UNDERSTANDING_ITEM_TYPES),
  origin: z.enum(UNDERSTANDING_SOURCE_ORIGINS),
  statement: z.string().min(1),
  rationale: z.string().optional(),
  evidence: z.array(z.any()),
  sourceReferenceId: z.string().optional(),
});

export const ProposedFeatureGroupZodSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  targetCapabilities: z.array(z.string()),
});

export const ProposedDevelopmentPlanZodSchema = z.object({
  objectives: z.array(z.string()),
  proposedScope: z.array(z.string()),
  proposedFeatureGroups: z.array(ProposedFeatureGroupZodSchema),
  dependencies: z.array(z.string()),
  constraints: z.array(z.string()),
  knownRisks: z.array(z.string()),
  unresolvedIssues: z.array(z.string()),
  excludedScope: z.array(z.string()),
  suggestedImplementationOrder: z.array(z.string()),
});

export const ProjectApprovalRecordZodSchema = z.object({
  packageId: z.string().min(1),
  revision: z.number().int().positive(),
  actor: z.string().min(1),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_APPROVAL'),
  comment: z.string().optional(),
  approvedAt: z.string().min(1),
  packageHash: z.string().min(1),
  directorSessionId: z.string().optional(),
  contextFingerprint: z.string().optional(),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
  protocolVersion: z.string().optional(),
  schemaVersion: z.number().int().positive().optional(),
});

export const ProjectRejectionRecordZodSchema = z.object({
  packageId: z.string().min(1),
  revision: z.number().int().positive(),
  actor: z.string().min(1),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_REJECTION'),
  reason: z.string().optional(),
  rejectedAt: z.string().min(1),
  packageHash: z.string().min(1),
});

export const InitialProjectUnderstandingZodSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  apparentPurpose: z.any(),
  targetUsers: z.array(z.string()),
  technologyStack: z.any(),
  architectureSummary: z.any(),
  existingCapabilities: z.array(z.string()),
  confirmedRequirements: z.array(UnderstandingItemZodSchema),
  clarifiedRequirements: z.array(UnderstandingItemZodSchema),
  unresolvedUnknowns: z.array(z.any()),
  unresolvedContradictions: z.array(z.any()),
  currentImplementationState: z.any(),
  constraints: z.array(z.string()),
  assumptions: z.array(UnderstandingItemZodSchema),
  nonGoals: z.array(z.string()),
  proposedDevelopmentScope: z.array(z.string()),
  evidenceReferences: z.array(z.any()),
  sourceDiscoveryReference: z.string().min(1),
  sourceClarificationSessionReference: z.string().optional(),
  generatedAt: z.string().min(1),
});

export const ApprovalSourceBindingsZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive('discoveryRevision must be a positive integer'),
  discoveryFingerprint: z.string().min(1, 'discoveryFingerprint cannot be empty'),
  requirementsRevision: z.number().int().positive('requirementsRevision must be a positive integer'),
  requirementsFingerprint: z.string().min(1, 'requirementsFingerprint cannot be empty'),
  architectureRevision: z.number().int().positive('architectureRevision must be a positive integer'),
  architectureFingerprint: z.string().min(1, 'architectureFingerprint cannot be empty'),
  businessRulesRevision: z.number().int().positive('businessRulesRevision must be a positive integer'),
  businessRulesFingerprint: z.string().min(1, 'businessRulesFingerprint cannot be empty'),
  acceptanceCriteriaRevision: z.number().int().positive('acceptanceCriteriaRevision must be a positive integer'),
  acceptanceCriteriaFingerprint: z.string().min(1, 'acceptanceCriteriaFingerprint cannot be empty'),
  riskRevision: z.number().int().positive('riskRevision must be a positive integer'),
  riskFingerprint: z.string().min(1, 'riskFingerprint cannot be empty'),
  specRevision: z.number().int().positive('specRevision must be a positive integer'),
  specFingerprint: z.string().min(1, 'specFingerprint cannot be empty'),
  completenessFingerprint: z.string().min(1, 'completenessFingerprint cannot be empty'),
  completenessRevision: z.number().int().positive().optional(),
});

export const ApprovalProvenanceZodSchema = z.object({
  createdBy: z.string().default('SYSTEM'),
  engineVersion: z.string().default('P15-APPROVAL-1.0'),
  evaluatedAt: z.string().min(1),
  sourceStores: z.array(z.string()).default([]),
});

export const ApprovalHistoryEntryZodSchema = z.object({
  eventType: z.string().min(1),
  actor: z.string().min(1),
  actorRole: z.string().optional(),
  timestamp: z.string().min(1),
  status: z.string().min(1),
  revision: z.number().int().positive(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ApprovalStaleReportZodSchema = z.object({
  isStale: z.boolean(),
  reasons: z.array(z.string()).default([]),
  details: z.object({
    discoveryStale: z.boolean(),
    requirementsStale: z.boolean(),
    architectureStale: z.boolean(),
    businessRulesStale: z.boolean(),
    acceptanceCriteriaStale: z.boolean(),
    risksStale: z.boolean(),
    specStale: z.boolean(),
    completenessStale: z.boolean(),
    humanDecisionsChanged: z.boolean(),
  }),
});

export const ApprovalPackageZodSchema = z.object({
  packageId: z.string().min(1),
  revision: z.number().int().positive(),
  approvalPackageRevision: z.number().int().positive().optional(),
  projectId: z.string().min(1),
  specRevision: z.number().int().positive().optional(),
  projectSpecRevision: z.number().int().positive().optional(),
  sourceBindings: ApprovalSourceBindingsZodSchema.optional(),
  completenessResult: CompletenessGateResultZodSchema.optional(),
  unresolvedHumanDecisionPoints: z.array(z.any()).optional(),
  risksRequiringAttention: z.array(z.any()).optional(),
  status: z.enum(PROJECT_APPROVAL_STATUSES),
  approvalRecord: ProjectApprovalRecordZodSchema.optional(),
  rejectionRecord: ProjectRejectionRecordZodSchema.optional(),
  packageFingerprint: z.string().optional(),
  provenance: ApprovalProvenanceZodSchema.optional(),
  history: z.array(ApprovalHistoryEntryZodSchema).optional(),
  isStale: z.boolean().optional(),
  staleReport: ApprovalStaleReportZodSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),

  // Legacy fields
  projectUnderstanding: InitialProjectUnderstandingZodSchema.optional(),
  proposedDevelopmentPlan: ProposedDevelopmentPlanZodSchema.optional(),
  unresolvedItems: z.array(UnderstandingItemZodSchema).optional(),
  assumptions: z.array(UnderstandingItemZodSchema).optional(),
  evidenceReferences: z.array(z.any()).optional(),
  clarificationSessionReference: z.string().optional(),
});

export const ProjectApprovalPackageZodSchema = ApprovalPackageZodSchema;

/**
 * Computes deterministic canonical SHA-256 fingerprint for an ApprovalPackage.
 * Strictly excludes volatile metadata (timestamps, createdAt, updatedAt, history).
 */
export function computePackageFingerprint(pkg: {
  projectId: string;
  approvalPackageRevision?: number;
  revision?: number;
  specRevision?: number;
  projectSpecRevision?: number;
  sourceBindings?: ApprovalSourceBindings;
  completenessResult?: CompletenessGateResult;
  unresolvedHumanDecisionPoints?: readonly unknown[];
  risksRequiringAttention?: readonly unknown[];
}): string {
  const canonicalData = {
    projectId: pkg.projectId,
    revision: pkg.approvalPackageRevision ?? pkg.revision ?? 1,
    specRevision: pkg.specRevision ?? pkg.projectSpecRevision ?? 1,
    sourceBindings: pkg.sourceBindings
      ? {
          discoveryRevision: pkg.sourceBindings.discoveryRevision,
          discoveryFingerprint: pkg.sourceBindings.discoveryFingerprint,
          requirementsRevision: pkg.sourceBindings.requirementsRevision,
          requirementsFingerprint: pkg.sourceBindings.requirementsFingerprint,
          architectureRevision: pkg.sourceBindings.architectureRevision,
          architectureFingerprint: pkg.sourceBindings.architectureFingerprint,
          businessRulesRevision: pkg.sourceBindings.businessRulesRevision,
          businessRulesFingerprint: pkg.sourceBindings.businessRulesFingerprint,
          acceptanceCriteriaRevision: pkg.sourceBindings.acceptanceCriteriaRevision,
          acceptanceCriteriaFingerprint: pkg.sourceBindings.acceptanceCriteriaFingerprint,
          riskRevision: pkg.sourceBindings.riskRevision,
          riskFingerprint: pkg.sourceBindings.riskFingerprint,
          specRevision: pkg.sourceBindings.specRevision,
          specFingerprint: pkg.sourceBindings.specFingerprint,
          completenessFingerprint: pkg.sourceBindings.completenessFingerprint,
        }
      : null,
    completenessStatus: pkg.completenessResult?.status ?? null,
    completenessFingerprint: pkg.completenessResult?.fingerprint ?? null,
    unresolvedHumanDecisionPointsCount: (pkg.unresolvedHumanDecisionPoints ?? []).length,
    risksRequiringAttentionCount: (pkg.risksRequiringAttention ?? []).length,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalData)).digest('hex');
}

export const ProjectApprovalInputZodSchema = z.object({
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_APPROVAL', { message: "intent must be strictly 'EXPLICIT_APPROVAL'" }),
  comment: z.string().optional(),
  timestamp: z.string().optional(),
  directorSessionId: z.string().optional(),
  contextFingerprint: z.string().optional(),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
  protocolVersion: z.string().optional(),
  schemaVersion: z.number().int().positive().optional(),
});

export const ProjectRejectionInputZodSchema = z.object({
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_REJECTION', { message: "intent must be strictly 'EXPLICIT_REJECTION'" }),
  reason: z.string().optional(),
  timestamp: z.string().optional(),
});
