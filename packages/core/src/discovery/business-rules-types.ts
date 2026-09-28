/**
 * Business Rules Definition Types & Zod Schemas (Phase 15 TASK-P15-05)
 *
 * Defines the strongly typed, revisioned Business Rules domain model for project initiation:
 * - Deterministic Rule Identity (BR-<HASH>)
 * - Explicit Rule Categories (Domain Invariant, Workflow, Validation, Authorization, State Transition, etc.)
 * - Explicit Priorities (CRITICAL, HIGH, MEDIUM, LOW, UNRESOLVED)
 * - Explicit Statuses (CONFIRMED, CONSTRAINED, PROPOSED, PENDING_DECISION, NOT_APPLICABLE)
 * - Human Decision Boundaries (Product Owner decisions never silently resolved)
 * - Explicit Conflict Representation
 * - Declarative Rule Dependencies & Traceability (Requirements, Architecture, Discovery)
 * - Specific Structured Rule Details (Temporal, State Transition, Validation/Calculation, Authorization/Policy)
 * - Revision and source requirements/architecture/discovery binding
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-05 defines WHAT domain behavior and invariants the product must obey.
 * 2. Does NOT approve the project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine.
 * 4. Business authorization rules describe product domain permissions, NOT AIDM internal execution authorization.
 * 5. Strict determinism: canonical fingerprint calculation excluding timestamps and volatile values.
 * 6. Revision-bound: immutable by revision, binds to source requirements, architecture, and discovery.
 * 7. Cross-project isolation: results for project A can never be used for project B.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';

// ============================================================================
// 1. BUSINESS RULE CATEGORIES
// ============================================================================

export const BUSINESS_RULE_CATEGORIES = [
  'DOMAIN_INVARIANT',
  'WORKFLOW_RULE',
  'VALIDATION_RULE',
  'AUTHORIZATION_RULE',
  'STATE_TRANSITION_RULE',
  'CALCULATION_RULE',
  'LIMIT_RULE',
  'ELIGIBILITY_RULE',
  'DATA_RULE',
  'INTEGRATION_RULE',
  'TEMPORAL_RULE',
  'NOTIFICATION_RULE',
  'AUDIT_RULE',
  'ERROR_HANDLING_RULE',
  'POLICY_RULE',
] as const;

export type BusinessRuleCategory = (typeof BUSINESS_RULE_CATEGORIES)[number];
export const BusinessRuleCategoryZodSchema = z.enum(BUSINESS_RULE_CATEGORIES);

// ============================================================================
// 2. BUSINESS RULE PRIORITIES
// ============================================================================

export const BUSINESS_RULE_PRIORITIES = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNRESOLVED',
] as const;

export type BusinessRulePriority = (typeof BUSINESS_RULE_PRIORITIES)[number];
export const BusinessRulePriorityZodSchema = z.enum(BUSINESS_RULE_PRIORITIES);

// ============================================================================
// 3. BUSINESS RULE STATUSES
// ============================================================================

export const BUSINESS_RULE_STATUSES = [
  'CONFIRMED',
  'CONSTRAINED',
  'PROPOSED',
  'PENDING_DECISION',
  'NOT_APPLICABLE',
] as const;

export type BusinessRuleStatus = (typeof BUSINESS_RULE_STATUSES)[number];
export const BusinessRuleStatusZodSchema = z.enum(BUSINESS_RULE_STATUSES);

// ============================================================================
// 4. STRUCTURED RULE EXTENSIONS (DECLARATIVE)
// ============================================================================

export const TemporalSpecificationZodSchema = z.object({
  schedule: z.string().optional(),
  windowDuration: z.string().optional(),
  deadline: z.string().optional(),
  cooldown: z.string().optional(),
  retentionPeriod: z.string().optional(),
  timeUnit: z.string().optional(),
  isUnresolved: z.boolean().default(false),
});

export type TemporalSpecification = z.infer<typeof TemporalSpecificationZodSchema>;

export const StateTransitionSpecificationZodSchema = z.object({
  entity: z.string().min(1, 'entity cannot be empty'),
  currentState: z.string().min(1, 'currentState cannot be empty'),
  allowedTransitions: z.array(z.string()).default([]),
  forbiddenTransitions: z.array(z.string()).default([]),
  conditions: z.array(z.string()).default([]),
});

export type StateTransitionSpecification = z.infer<typeof StateTransitionSpecificationZodSchema>;

export const ValidationCalculationSpecificationZodSchema = z.object({
  fields: z.array(z.string()).default([]),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  formula: z.string().optional(),
  constraints: z.array(z.string()).default([]),
});

export type ValidationCalculationSpecification = z.infer<
  typeof ValidationCalculationSpecificationZodSchema
>;

export const AuthorizationPolicySpecificationZodSchema = z.object({
  actor: z.string().min(1, 'actor cannot be empty'),
  operation: z.string().min(1, 'operation cannot be empty'),
  requiredCondition: z.string().optional(),
  effect: z.enum(['ALLOW', 'DENY']).default('ALLOW'),
});

export type AuthorizationPolicySpecification = z.infer<
  typeof AuthorizationPolicySpecificationZodSchema
>;

// ============================================================================
// 5. CORE BUSINESS RULE MODEL
// ============================================================================

export const BusinessRuleZodSchema = z.object({
  ruleId: z.string().min(1, 'ruleId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  category: BusinessRuleCategoryZodSchema,
  statement: z.string().min(1, 'statement cannot be empty'),
  priority: BusinessRulePriorityZodSchema,
  status: BusinessRuleStatusZodSchema,
  sourceReferences: z.array(z.string()).default([]),
  sourceRequirements: z.array(z.string()).default([]),
  sourceArchitectureDecisions: z.array(z.string()).default([]),
  sourceDiscoveryReferences: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  affectedArchitectureAreas: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  validationExpectation: z.string().optional(),
  temporalDetails: TemporalSpecificationZodSchema.optional(),
  stateTransitionDetails: StateTransitionSpecificationZodSchema.optional(),
  validationCalculationDetails: ValidationCalculationSpecificationZodSchema.optional(),
  authorizationPolicyDetails: AuthorizationPolicySpecificationZodSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type BusinessRule = z.infer<typeof BusinessRuleZodSchema>;

// ============================================================================
// 6. HUMAN DECISION BOUNDARY
// ============================================================================

export const BusinessRuleHumanDecisionZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedRules: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  availableOptions: z.array(z.string()).default([]),
  consequences: z.array(z.string()).default([]),
  authority: z.string().default(Actor.USER),
  status: z.literal('PENDING_DECISION').default('PENDING_DECISION'),
});

export type BusinessRuleHumanDecision = z.infer<typeof BusinessRuleHumanDecisionZodSchema>;

// ============================================================================
// 7. BUSINESS RULE CONFLICTS
// ============================================================================

export const BusinessRuleConflictZodSchema = z.object({
  conflictId: z.string().min(1, 'conflictId cannot be empty'),
  affectedRules: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  conflictingStatements: z.array(z.string()).default([]),
  sourceReferences: z.array(z.string()).default([]),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  resolutionStatus: z.enum(['PENDING_DECISION', 'BLOCKED']).default('PENDING_DECISION'),
  requiredAuthority: z.string().default(Actor.USER),
});

export type BusinessRuleConflict = z.infer<typeof BusinessRuleConflictZodSchema>;

// ============================================================================
// 8. REQUIREMENTS TRACEABILITY
// ============================================================================

export const BusinessRuleTraceabilityLinkZodSchema = z.object({
  requirementId: z.string().min(1, 'requirementId cannot be empty'),
  requirementTitle: z.string().min(1, 'requirementTitle cannot be empty'),
  addressedByRules: z.array(z.string()).default([]),
  addressedByDecisions: z.array(z.string()).default([]),
});

export type BusinessRuleTraceabilityLink = z.infer<
  typeof BusinessRuleTraceabilityLinkZodSchema
>;

// ============================================================================
// 9. MASTER BUSINESS RULES REVISION ARTIFACT
// ============================================================================

export const ProjectBusinessRulesRevisionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  businessRulesRevision: z
    .number()
    .int()
    .positive('businessRulesRevision must be a positive integer'),
  sourceRequirementsRevision: z
    .number()
    .int()
    .positive('sourceRequirementsRevision must be a positive integer'),
  sourceRequirementsFingerprint: z
    .string()
    .min(1, 'sourceRequirementsFingerprint cannot be empty'),
  sourceArchitectureRevision: z
    .number()
    .int()
    .positive('sourceArchitectureRevision must be a positive integer'),
  sourceArchitectureFingerprint: z
    .string()
    .min(1, 'sourceArchitectureFingerprint cannot be empty'),
  sourceDiscoveryRevision: z
    .number()
    .int()
    .positive('sourceDiscoveryRevision must be a positive integer'),
  sourceDiscoveryFingerprint: z
    .string()
    .min(1, 'sourceDiscoveryFingerprint cannot be empty'),
  isStale: z.boolean().default(false),
  rules: z.array(BusinessRuleZodSchema).default([]),
  pendingHumanDecisions: z.array(BusinessRuleHumanDecisionZodSchema).default([]),
  conflicts: z.array(BusinessRuleConflictZodSchema).default([]),
  requirementsTraceability: z.array(BusinessRuleTraceabilityLinkZodSchema).default([]),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type ProjectBusinessRulesRevision = z.infer<
  typeof ProjectBusinessRulesRevisionZodSchema
>;

// ============================================================================
// 10. ENGINE INPUT CONTRACT
// ============================================================================

export const BusinessRulesInputZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  architectureRevision: z.number().int().positive().optional(),
  expectedArchitectureFingerprint: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalRules: z.array(BusinessRuleZodSchema).optional(),
  customDecisions: z.array(BusinessRuleHumanDecisionZodSchema).optional(),
  conflicts: z.array(BusinessRuleConflictZodSchema).optional(),
});

export type BusinessRulesInput = z.infer<typeof BusinessRulesInputZodSchema>;
