/**
 * Requirements & Scope Definition Types & Zod Schemas (Phase 15 TASK-P15-03)
 *
 * Defines the strongly typed, revisioned Requirements / Scope domain model for project initiation:
 * - Project Purpose & Objectives
 * - Target Users & Actors
 * - Explicit In-Scope vs Out-Of-Scope vs Undecided / Pending Decision
 * - Functional Requirements with deterministic canonical IDs
 * - Non-Functional Requirements & Constraints
 * - Explicit Assumptions
 * - Open Questions & Unresolved Human Decision Points
 * - Revision and source discovery binding
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-03 transforms discovered project understanding into explicit, structured, revisioned requirements/scope.
 * 2. Phase is NOT approval; does NOT authorize development or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved.
 * 4. Scope semantics strictly distinguish IN_SCOPE, OUT_OF_SCOPE, and UNDECIDED / PENDING_DECISION.
 * 5. Deterministic fingerprinting without timestamps or volatile values.
 * 6. Revision-bound: immutable by revision, protects against stale discovery revisions.
 * 7. Cross-project isolation: results for project A can never be used for project B.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';

// ============================================================================
// 1. SCOPE STATUS & SEMANTICS
// ============================================================================

export const SCOPE_STATUSES = [
  'IN_SCOPE',
  'OUT_OF_SCOPE',
  'UNDECIDED',
  'PENDING_DECISION',
] as const;

export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

// ============================================================================
// 2. PROJECT PURPOSE
// ============================================================================

export const ProjectPurposeScopeZodSchema = z.object({
  purpose: z.string().min(1, 'purpose cannot be empty'),
  problemStatement: z.string().min(1, 'problemStatement cannot be empty'),
  desiredOutcome: z.string().min(1, 'desiredOutcome cannot be empty'),
  measurableObjective: z.string().optional(),
});

export type ProjectPurposeScope = z.infer<typeof ProjectPurposeScopeZodSchema>;

// ============================================================================
// 3. TARGET USERS / ACTORS
// ============================================================================

export const TargetUsersScopeZodSchema = z.object({
  primaryUsers: z.array(z.string()).default([]),
  secondaryUsers: z.array(z.string()).default([]),
  systemActors: z.array(z.string()).default([]),
  externalActors: z.array(z.string()).default([]),
});

export type TargetUsersScope = z.infer<typeof TargetUsersScopeZodSchema>;

// ============================================================================
// 4. IN-SCOPE & OUT-OF-SCOPE BOUNDARIES
// ============================================================================

export const InScopeDefinitionZodSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  integrations: z.array(z.string()).default([]),
});

export type InScopeDefinition = z.infer<typeof InScopeDefinitionZodSchema>;

export const OutOfScopeDefinitionZodSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  integrations: z.array(z.string()).default([]),
});

export type OutOfScopeDefinition = z.infer<typeof OutOfScopeDefinitionZodSchema>;

// ============================================================================
// 5. UNDECIDED SCOPE / PENDING DECISION
// ============================================================================

export const UndecidedScopeItemZodSchema = z.object({
  id: z.string().min(1, 'id cannot be empty'),
  topic: z.string().min(1, 'topic cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  availableOptions: z.array(z.string()).default([]),
  status: z.enum(['PENDING_DECISION', 'UNDECIDED', 'PROPOSED']).default('PENDING_DECISION'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedAreas: z.array(z.string()).default([]),
});

export type UndecidedScopeItem = z.infer<typeof UndecidedScopeItemZodSchema>;

// ============================================================================
// 6. FUNCTIONAL REQUIREMENTS
// ============================================================================

export const ScopeRequirementPriorityZodSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type ScopeRequirementPriority = z.infer<typeof ScopeRequirementPriorityZodSchema>;

export const ScopeRequirementStatusZodSchema = z.enum([
  'PROPOSED',
  'CONFIRMED',
  'PENDING_DECISION',
  'DEFERRED',
]);
export type ScopeRequirementStatus = z.infer<typeof ScopeRequirementStatusZodSchema>;

export const FunctionalRequirementScopeItemZodSchema = z.object({
  requirementId: z.string().min(1, 'requirementId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  priority: ScopeRequirementPriorityZodSchema.default('HIGH'),
  source: z.string().min(1, 'source cannot be empty'),
  status: ScopeRequirementStatusZodSchema.default('CONFIRMED'),
  affectedScope: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  businessRules: z.array(z.string()).default([]),
});

export type FunctionalRequirementScopeItem = z.infer<
  typeof FunctionalRequirementScopeItemZodSchema
>;

// ============================================================================
// 7. NON-FUNCTIONAL REQUIREMENTS
// ============================================================================

export const NonFunctionalRequirementsScopeZodSchema = z.object({
  performance: z.array(z.string()).default([]),
  reliability: z.array(z.string()).default([]),
  security: z.array(z.string()).default([]),
  availability: z.array(z.string()).default([]),
  scalability: z.array(z.string()).default([]),
  usability: z.array(z.string()).default([]),
  maintainability: z.array(z.string()).default([]),
  operationalConstraints: z.array(z.string()).default([]),
});

export type NonFunctionalRequirementsScope = z.infer<
  typeof NonFunctionalRequirementsScopeZodSchema
>;

// ============================================================================
// 8. CONSTRAINTS
// ============================================================================

export const ScopeConstraintsZodSchema = z.object({
  technologyConstraints: z.array(z.string()).default([]),
  platformConstraints: z.array(z.string()).default([]),
  compatibilityConstraints: z.array(z.string()).default([]),
  legalComplianceConstraints: z.array(z.string()).default([]),
  operationalConstraints: z.array(z.string()).default([]),
  budgetResourceConstraints: z.array(z.string()).default([]),
});

export type ScopeConstraints = z.infer<typeof ScopeConstraintsZodSchema>;

// ============================================================================
// 9. ASSUMPTIONS
// ============================================================================

export const ScopeAssumptionZodSchema = z.object({
  id: z.string().min(1, 'id cannot be empty'),
  statement: z.string().min(1, 'statement cannot be empty'),
  rationale: z.string().optional(),
  validated: z.boolean().default(false),
  affectedRequirements: z.array(z.string()).default([]),
});

export type ScopeAssumption = z.infer<typeof ScopeAssumptionZodSchema>;

// ============================================================================
// 10. OPEN QUESTIONS
// ============================================================================

export const ScopeQuestionClassificationZodSchema = z.enum([
  'BLOCKING',
  'NON_BLOCKING',
  'INFORMATIONAL',
]);
export type ScopeQuestionClassification = z.infer<typeof ScopeQuestionClassificationZodSchema>;

export const ScopeOpenQuestionZodSchema = z.object({
  questionId: z.string().min(1, 'questionId cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedAreas: z.array(z.string()).default([]),
  classification: ScopeQuestionClassificationZodSchema,
  availableOptions: z.array(z.string()).default([]),
  status: z.enum(['OPEN', 'PENDING_DECISION', 'RESOLVED', 'UNDECIDED', 'PROPOSED']),
});

export type ScopeOpenQuestion = z.infer<typeof ScopeOpenQuestionZodSchema>;

// ============================================================================
// 11. HUMAN DECISIONS
// ============================================================================

export const ScopeHumanDecisionZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  affectedAreas: z.array(z.string()).default([]),
  availableOptions: z.array(z.string()).default([]),
  recommendedOption: z.string().optional(),
  authority: z.literal(Actor.USER).default(Actor.USER),
  status: z.enum(['PENDING_DECISION', 'DECIDED', 'CONFIRMED', 'UNDECIDED', 'PROPOSED', 'OPEN', 'REJECTED']).default('PENDING_DECISION'),
});

export type ScopeHumanDecision = z.infer<typeof ScopeHumanDecisionZodSchema>;

// ============================================================================
// 12. REQUIREMENTS & SCOPE ARTIFACT / REVISION
// ============================================================================

export const ProjectRequirementsScopeRevisionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  requirementsRevision: z.number().int().positive('requirementsRevision must be a positive integer'),
  sourceDiscoveryRevision: z.number().int().positive('sourceDiscoveryRevision must be a positive integer'),
  sourceDiscoveryFingerprint: z.string().min(1, 'sourceDiscoveryFingerprint cannot be empty'),
  isStale: z.boolean().default(false),
  purpose: ProjectPurposeScopeZodSchema,
  targetUsers: TargetUsersScopeZodSchema,
  inScope: InScopeDefinitionZodSchema,
  outOfScope: OutOfScopeDefinitionZodSchema,
  undecidedScope: z.array(UndecidedScopeItemZodSchema).default([]),
  functionalRequirements: z.array(FunctionalRequirementScopeItemZodSchema).default([]),
  nonFunctionalRequirements: NonFunctionalRequirementsScopeZodSchema,
  constraints: ScopeConstraintsZodSchema,
  assumptions: z.array(ScopeAssumptionZodSchema).default([]),
  openQuestions: z.array(ScopeOpenQuestionZodSchema).default([]),
  humanDecisions: z.array(ScopeHumanDecisionZodSchema).default([]),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type ProjectRequirementsScopeRevision = z.infer<
  typeof ProjectRequirementsScopeRevisionZodSchema
>;

// ============================================================================
// 13. INPUT CONTRACT
// ============================================================================

export const RequirementsScopeInputZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalAssumptions: z.array(ScopeAssumptionZodSchema).optional(),
});

export type RequirementsScopeInput = z.infer<typeof RequirementsScopeInputZodSchema>;
