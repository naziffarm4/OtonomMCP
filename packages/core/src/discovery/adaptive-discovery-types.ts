/**
 * Adaptive Project Discovery Types & Zod Schemas (Phase 15 TASK-P15-01)
 *
 * Defines the structured, progressively refined project discovery domain model:
 * - Project Identity (name, purpose, desired outcome)
 * - Product Scope (in scope, out of scope / exclusions, target users, primary workflows)
 * - Functional Requirements (capabilities, behaviors, business rules)
 * - Non-Functional Requirements (performance, security, reliability, scalability, availability, usability, compatibility)
 * - Technology (required, preferred, prohibited, platform / runtime constraints)
 * - Architecture (architectural constraints, integration requirements, deployment model, data storage expectations)
 * - Acceptance (expected behavior, measurable criteria, definition of completion)
 * - Risks (technical, product, operational, dependencies)
 * - Human Decisions (choices requiring Product Owner authority)
 * - Open Questions (prioritized with metadata: BLOCKING, NON_BLOCKING, INFORMATIONAL)
 * - Discovery Revision & Completeness Information
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Product Owner remains the sole product authority; discovery proposes, PO decides.
 * 2. Immutable discovery revisions; historical discovery is never overwritten.
 * 3. Question prioritization distinguishes BLOCKING from NON_BLOCKING and INFORMATIONAL.
 * 4. Deterministic identities and fingerprints without timestamps or random IDs.
 * 5. Discovery does NOT approve project, create execution intent, or invoke Antigravity.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';

// ============================================================================
// 1. QUESTION PRIORITIZATION & CLASSIFICATION
// ============================================================================

export const QUESTION_CLASSIFICATIONS = [
  'BLOCKING',
  'NON_BLOCKING',
  'INFORMATIONAL',
] as const;

export type QuestionClassification = (typeof QUESTION_CLASSIFICATIONS)[number];

export const DiscoveryQuestionZodSchema = z.object({
  id: z.string().min(1, 'id cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  category: z.string().min(1, 'category cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  whatItAffects: z.array(z.string()),
  classification: z.enum(QUESTION_CLASSIFICATIONS),
  requiredDecision: z.string().min(1, 'requiredDecision cannot be empty'),
  dependentSection: z.string().min(1, 'dependentSection cannot be empty'),
  impact: z.string().min(1, 'impact cannot be empty'),
  options: z.array(z.string()).optional(),
  resolvedAnswer: z.string().optional(),
  status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'),
});

export type DiscoveryQuestion = z.infer<typeof DiscoveryQuestionZodSchema>;

// ============================================================================
// 2. HUMAN DECISION POINTS
// ============================================================================

export const HUMAN_DECISION_STATUSES = ['PENDING_DECISION', 'DECIDED'] as const;
export type HumanDecisionStatus = (typeof HUMAN_DECISION_STATUSES)[number];

export const HumanDecisionPointZodSchema = z.object({
  id: z.string().min(1, 'id cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  affectedAreas: z.array(z.string()),
  alternatives: z.array(z.string()).min(2, 'At least 2 alternatives required for a human decision'),
  recommendedOption: z.string().optional(),
  rationale: z.string().optional(),
  authority: z.literal(Actor.USER).default(Actor.USER),
  status: z.enum(HUMAN_DECISION_STATUSES).default('PENDING_DECISION'),
  selectedOption: z.string().optional(),
});

export type HumanDecisionPoint = z.infer<typeof HumanDecisionPointZodSchema>;

// ============================================================================
// 3. DISCOVERY AREAS
// ============================================================================

// --- Area 1: PROJECT_IDENTITY ---
export const ProjectIdentityDiscoveryZodSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  purpose: z.string().min(1, 'purpose cannot be empty'),
  desiredOutcome: z.string().min(1, 'desiredOutcome cannot be empty'),
});

export type ProjectIdentityDiscovery = z.infer<typeof ProjectIdentityDiscoveryZodSchema>;

// --- Area 2: PRODUCT_SCOPE ---
export const ProductScopeDiscoveryZodSchema = z.object({
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()), // Explicit exclusions
  targetUsers: z.array(z.string()),
  primaryWorkflows: z.array(z.string()),
});

export type ProductScopeDiscovery = z.infer<typeof ProductScopeDiscoveryZodSchema>;

// --- Area 3: FUNCTIONAL_REQUIREMENTS ---
export const FunctionalRequirementItemZodSchema = z.object({
  id: z.string().min(1, 'id cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  behavior: z.string().optional(),
  businessRules: z.array(z.string()).default([]),
  source: z.string().default('PRODUCT_OWNER_DISCOVERY'),
});

export type FunctionalRequirementItem = z.infer<typeof FunctionalRequirementItemZodSchema>;

export const FunctionalRequirementsDiscoveryZodSchema = z.object({
  capabilities: z.array(FunctionalRequirementItemZodSchema),
  behaviors: z.array(z.string()),
  businessRules: z.array(z.string()),
});

export type FunctionalRequirementsDiscovery = z.infer<
  typeof FunctionalRequirementsDiscoveryZodSchema
>;

// --- Area 4: NON_FUNCTIONAL_REQUIREMENTS ---
export const NonFunctionalRequirementsDiscoveryZodSchema = z.object({
  performance: z.array(z.string()),
  security: z.array(z.string()),
  reliability: z.array(z.string()),
  scalability: z.array(z.string()),
  availability: z.array(z.string()),
  usability: z.array(z.string()),
  compatibility: z.array(z.string()),
});

export type NonFunctionalRequirementsDiscovery = z.infer<
  typeof NonFunctionalRequirementsDiscoveryZodSchema
>;

// --- Area 5: TECHNOLOGY ---
export const TechnologyDiscoveryZodSchema = z.object({
  requiredTechnologies: z.array(z.string()),
  preferredTechnologies: z.array(z.string()),
  prohibitedTechnologies: z.array(z.string()),
  platformConstraints: z.array(z.string()),
});

export type TechnologyDiscovery = z.infer<typeof TechnologyDiscoveryZodSchema>;

// --- Area 6: ARCHITECTURE ---
export const ArchitectureDiscoveryZodSchema = z.object({
  architecturalConstraints: z.array(z.string()),
  integrationRequirements: z.array(z.string()),
  deploymentModel: z.string().optional(),
  dataStorageExpectations: z.array(z.string()),
});

export type ArchitectureDiscovery = z.infer<typeof ArchitectureDiscoveryZodSchema>;

// --- Area 7: ACCEPTANCE ---
export const AcceptanceDiscoveryZodSchema = z.object({
  expectedBehavior: z.array(z.string()),
  measurableCriteria: z.array(z.string()),
  definitionOfCompletion: z.array(z.string()),
});

export type AcceptanceDiscovery = z.infer<typeof AcceptanceDiscoveryZodSchema>;

// --- Area 8: RISKS ---
export const RISK_CATEGORIES = ['TECHNICAL', 'PRODUCT', 'OPERATIONAL', 'DEPENDENCY'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_IMPACT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskImpactLevel = (typeof RISK_IMPACT_LEVELS)[number];

export const DiscoveryRiskZodSchema = z.object({
  id: z.string().min(1, 'id cannot be empty'),
  category: z.enum(RISK_CATEGORIES),
  statement: z.string().min(1, 'statement cannot be empty'),
  impact: z.enum(RISK_IMPACT_LEVELS),
  mitigation: z.string().optional(),
});

export type DiscoveryRisk = z.infer<typeof DiscoveryRiskZodSchema>;

export const RisksDiscoveryZodSchema = z.object({
  technicalRisks: z.array(DiscoveryRiskZodSchema),
  productRisks: z.array(DiscoveryRiskZodSchema),
  operationalRisks: z.array(DiscoveryRiskZodSchema),
  dependencies: z.array(z.string()),
});

export type RisksDiscovery = z.infer<typeof RisksDiscoveryZodSchema>;

// ============================================================================
// 4. AGGREGATED SECTIONS
// ============================================================================

export const DiscoverySectionsZodSchema = z.object({
  projectIdentity: ProjectIdentityDiscoveryZodSchema,
  productScope: ProductScopeDiscoveryZodSchema,
  functionalRequirements: FunctionalRequirementsDiscoveryZodSchema,
  nonFunctionalRequirements: NonFunctionalRequirementsDiscoveryZodSchema,
  technology: TechnologyDiscoveryZodSchema,
  architecture: ArchitectureDiscoveryZodSchema,
  acceptance: AcceptanceDiscoveryZodSchema,
  risks: RisksDiscoveryZodSchema,
  humanDecisions: z.array(HumanDecisionPointZodSchema),
  openQuestions: z.array(DiscoveryQuestionZodSchema),
});

export type DiscoverySections = z.infer<typeof DiscoverySectionsZodSchema>;

// ============================================================================
// 5. COMPLETENESS INFORMATION
// ============================================================================

export const DiscoveryCompletenessInfoZodSchema = z.object({
  isComplete: z.boolean(),
  hasBlockingQuestions: z.boolean(),
  blockingQuestionsCount: z.number().int().nonnegative(),
  totalQuestionsCount: z.number().int().nonnegative(),
  resolvedQuestionsCount: z.number().int().nonnegative(),
  pendingHumanDecisionsCount: z.number().int().nonnegative(),
  sectionsEvaluatedCount: z.number().int().nonnegative(),
  missingMaterialSections: z.array(z.string()),
});

export type DiscoveryCompletenessInfo = z.infer<typeof DiscoveryCompletenessInfoZodSchema>;

// ============================================================================
// 6. DISCOVERY REVISION
// ============================================================================

export const ProjectDiscoveryRevisionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive('discoveryRevision must be a positive integer'),
  previousRevision: z.number().int().positive().nullable(),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  source: z.string().min(1, 'source cannot be empty'),
  changedSections: z.array(z.string()),
  sections: DiscoverySectionsZodSchema,
  requirements: z.array(FunctionalRequirementItemZodSchema),
  decisions: z.array(HumanDecisionPointZodSchema),
  openQuestions: z.array(DiscoveryQuestionZodSchema),
  risks: z.array(DiscoveryRiskZodSchema),
  completeness: DiscoveryCompletenessInfoZodSchema,
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type ProjectDiscoveryRevision = z.infer<typeof ProjectDiscoveryRevisionZodSchema>;

// ============================================================================
// 7. INPUT CONTRACTS
// ============================================================================

export interface AdaptiveDiscoveryInput {
  readonly projectId?: string;
  readonly workspaceRoot?: string;
  readonly rawPrompt?: string;
  readonly explicitSections?: Partial<DiscoverySections>;
  readonly resolvedAnswers?: Readonly<Record<string, string>>;
  readonly decidedHumanDecisions?: Readonly<Record<string, string>>;
  readonly source?: string;
}

export const AdaptiveDiscoveryInputZodSchema = z.object({
  projectId: z.string().optional(),
  workspaceRoot: z.string().optional(),
  rawPrompt: z.string().optional(),
  explicitSections: z.record(z.string(), z.unknown()).optional(),
  resolvedAnswers: z.record(z.string(), z.string()).optional(),
  decidedHumanDecisions: z.record(z.string(), z.string()).optional(),
  source: z.string().optional(),
});
