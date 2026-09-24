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
import type {
  EvidenceReference,
  ProjectPurposeUnderstanding,
  TechnologyStackInfo,
  ArchitectureSummary,
  ImplementationStateSummary,
  DiscoveryUnknown,
  DiscoveryContradiction,
} from '../discovery/discovery-types.js';

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
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
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
// 5. PROJECT APPROVAL PACKAGE
// ============================================================================

export interface ProjectApprovalPackage {
  readonly packageId: string;
  readonly revision: number;
  readonly projectId: string;
  readonly projectUnderstanding: InitialProjectUnderstanding;
  readonly proposedDevelopmentPlan: ProposedDevelopmentPlan;
  readonly unresolvedItems: readonly UnderstandingItem[];
  readonly assumptions: readonly UnderstandingItem[];
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly clarificationSessionReference?: string;
  readonly status: ProjectApprovalStatus;
  readonly approvalRecord?: ProjectApprovalRecord;
  readonly rejectionRecord?: ProjectRejectionRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ============================================================================
// 6. READINESS CHECK & INPUTS
// ============================================================================

export interface ApprovalReadinessBlockingConditions {
  readonly discoveryMissing: boolean;
  readonly unresolvedBlockingClarifications: boolean;
  readonly unresolvedBlockingContradictions: boolean;
  readonly understandingInvalid: boolean;
  readonly proposalIncomplete: boolean;
}

export interface ApprovalReadiness {
  readonly isReady: boolean;
  readonly status: 'READY_FOR_APPROVAL' | 'NOT_READY';
  readonly reasons: readonly string[];
  readonly blockingConditions: ApprovalReadinessBlockingConditions;
}

export interface ProjectApprovalInput {
  readonly packageId: string;
  readonly revision: number;
  readonly actor: string;
  readonly actorRole: ApprovalActorRole;
  readonly intent: 'EXPLICIT_APPROVAL';
  readonly comment?: string;
  readonly timestamp?: string;
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

export const ProjectApprovalPackageZodSchema = z.object({
  packageId: z.string().min(1),
  revision: z.number().int().positive(),
  projectId: z.string().min(1),
  projectUnderstanding: InitialProjectUnderstandingZodSchema,
  proposedDevelopmentPlan: ProposedDevelopmentPlanZodSchema,
  unresolvedItems: z.array(UnderstandingItemZodSchema),
  assumptions: z.array(UnderstandingItemZodSchema),
  evidenceReferences: z.array(z.any()),
  clarificationSessionReference: z.string().optional(),
  status: z.enum(PROJECT_APPROVAL_STATUSES),
  approvalRecord: ProjectApprovalRecordZodSchema.optional(),
  rejectionRecord: ProjectRejectionRecordZodSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const ProjectApprovalInputZodSchema = z.object({
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_APPROVAL', { message: "intent must be strictly 'EXPLICIT_APPROVAL'" }),
  comment: z.string().optional(),
  timestamp: z.string().optional(),
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
