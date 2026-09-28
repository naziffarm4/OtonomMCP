/**
 * Acceptance Criteria Definition Types & Zod Schemas (Phase 15 TASK-P15-06)
 *
 * Defines the strongly typed, revisioned Acceptance Criteria domain model for project initiation:
 * - Deterministic Criterion Identity (AC-<HASH>)
 * - Explicit Criterion Types (FUNCTIONAL, BUSINESS_RULE, VALIDATION, SECURITY, PERFORMANCE, RELIABILITY, etc.)
 * - Explicit Priorities (CRITICAL, HIGH, MEDIUM, LOW, UNRESOLVED)
 * - Explicit Statuses (DEFINED, PENDING_DECISION, NOT_APPLICABLE)
 * - Explicit Verification Methods (AUTOMATED_TEST, INTEGRATION_TEST, END_TO_END_TEST, MANUAL_VERIFICATION, etc.)
 * - Observable Expected Results (no invented numeric thresholds)
 * - Human Decision Boundaries (unresolved thresholds/conditions produce PENDING_DECISION)
 * - Explicit Conflict Representation
 * - Declarative Traceability (Requirements, Business Rules, Architecture)
 * - Deterministic Coverage Model (total/covered/uncovered counts and lists)
 * - Revision and source binding (requirements, architecture, business rules, discovery)
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-06 defines "How will we know that the product satisfies the requirement?"
 * 2. Does NOT approve the project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine (thresholds, acceptable behavior).
 * 4. Implementation-independent: describes observable product behavior, not implementation tasks.
 * 5. Strict determinism: canonical fingerprint calculation excluding timestamps and volatile values.
 * 6. Revision-bound: immutable by revision, binds to source requirements, architecture, business rules, and discovery.
 * 7. Cross-project isolation: results for project A can never be used for project B.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';

import { computeDeterministicFingerprint } from './adaptive-discovery-normalizer.js';

// ============================================================================
// 1. CRITERION TYPES
// ============================================================================

export const ACCEPTANCE_CRITERION_TYPES = [
  'FUNCTIONAL',
  'BUSINESS_RULE',
  'VALIDATION',
  'SECURITY',
  'PERFORMANCE',
  'RELIABILITY',
  'AVAILABILITY',
  'USABILITY',
  'COMPATIBILITY',
  'INTEGRATION',
  'DATA',
  'WORKFLOW',
  'STATE_TRANSITION',
  'OPERATIONAL',
  'DEPLOYMENT',
] as const;

export type AcceptanceCriterionType = (typeof ACCEPTANCE_CRITERION_TYPES)[number];
export const AcceptanceCriterionTypeZodSchema = z.enum(ACCEPTANCE_CRITERION_TYPES);

// ============================================================================
// 2. VERIFICATION METHODS
// ============================================================================

export const VERIFICATION_METHODS = [
  'AUTOMATED_TEST',
  'INTEGRATION_TEST',
  'END_TO_END_TEST',
  'MANUAL_VERIFICATION',
  'OBSERVATION',
  'PERFORMANCE_TEST',
  'SECURITY_TEST',
  'STATIC_CHECK',
  'DEPLOYMENT_CHECK',
  'DOCUMENT_REVIEW',
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export const VerificationMethodZodSchema = z.enum(VERIFICATION_METHODS);

// ============================================================================
// 3. PRIORITIES & STATUSES
// ============================================================================

export const ACCEPTANCE_CRITERIA_PRIORITIES = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNRESOLVED',
] as const;

export type AcceptanceCriteriaPriority = (typeof ACCEPTANCE_CRITERIA_PRIORITIES)[number];
export const AcceptanceCriteriaPriorityZodSchema = z.enum(ACCEPTANCE_CRITERIA_PRIORITIES);

export const ACCEPTANCE_CRITERIA_STATUSES = [
  'DEFINED',
  'PENDING_DECISION',
  'NOT_APPLICABLE',
] as const;

export type AcceptanceCriteriaStatus = (typeof ACCEPTANCE_CRITERIA_STATUSES)[number];
export const AcceptanceCriteriaStatusZodSchema = z.enum(ACCEPTANCE_CRITERIA_STATUSES);

// ============================================================================
// 4. TRACEABILITY LINK MODEL
// ============================================================================

export const AcceptanceCriteriaTraceabilityLinkZodSchema = z.object({
  criterionId: z.string().min(1, 'criterionId cannot be empty'),
  requirementIds: z.array(z.string()).default([]),
  businessRuleIds: z.array(z.string()).default([]),
  architectureDecisionIds: z.array(z.string()).default([]),
});

export type AcceptanceCriteriaTraceabilityLink = z.infer<
  typeof AcceptanceCriteriaTraceabilityLinkZodSchema
>;

// ============================================================================
// 5. CORE ACCEPTANCE CRITERION MODEL
// ============================================================================

export const AcceptanceCriterionZodSchema = z.object({
  criterionId: z.string().min(1, 'criterionId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  criterionType: AcceptanceCriterionTypeZodSchema,
  statement: z.string().min(1, 'statement cannot be empty'),
  priority: AcceptanceCriteriaPriorityZodSchema,
  status: AcceptanceCriteriaStatusZodSchema,
  sourceRequirements: z.array(z.string()).default([]),
  sourceBusinessRules: z.array(z.string()).default([]),
  sourceArchitectureDecisions: z.array(z.string()).default([]),
  verificationMethod: VerificationMethodZodSchema,
  expectedResult: z.string().min(1, 'expectedResult cannot be empty'),
  dependencies: z.array(z.string()).default([]),
  traceability: AcceptanceCriteriaTraceabilityLinkZodSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionZodSchema>;
export const ProjectAcceptanceCriterionZodSchema = AcceptanceCriterionZodSchema;
export type ProjectAcceptanceCriterion = AcceptanceCriterion;

// ============================================================================
// 6. HUMAN DECISION BOUNDARY
// ============================================================================

export const AcceptanceCriteriaHumanDecisionZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedCriteria: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  availableOptions: z.array(z.string()).default([]),
  consequences: z.array(z.string()).default([]),
  authority: z.string().default(Actor.USER),
  status: z.literal('PENDING_DECISION').default('PENDING_DECISION'),
});

export type AcceptanceCriteriaHumanDecision = z.infer<
  typeof AcceptanceCriteriaHumanDecisionZodSchema
>;

// ============================================================================
// 7. ACCEPTANCE CRITERIA CONFLICTS
// ============================================================================

export const AcceptanceCriteriaConflictZodSchema = z.object({
  conflictId: z.string().min(1, 'conflictId cannot be empty'),
  affectedRequirements: z.array(z.string()).default([]),
  affectedRules: z.array(z.string()).default([]),
  affectedCriteria: z.array(z.string()).default([]),
  conflictingStatements: z.array(z.string()).default([]),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  requiredAuthority: z.string().default(Actor.USER),
  resolutionStatus: z.enum(['PENDING_DECISION', 'BLOCKED']).default('PENDING_DECISION'),
});

export type AcceptanceCriteriaConflict = z.infer<
  typeof AcceptanceCriteriaConflictZodSchema
>;

// ============================================================================
// 8. TRACEABILITY REPORTS (REQUIREMENTS, BUSINESS RULES, ARCHITECTURE)
// ============================================================================

export const AcceptanceCriteriaRequirementTraceZodSchema = z.object({
  requirementId: z.string().min(1, 'requirementId cannot be empty'),
  requirementTitle: z.string().min(1, 'requirementTitle cannot be empty'),
  isCovered: z.boolean(),
  uncoveredReason: z.string().optional(),
  criteriaIds: z.array(z.string()).default([]),
});

export type AcceptanceCriteriaRequirementTrace = z.infer<
  typeof AcceptanceCriteriaRequirementTraceZodSchema
>;

export const AcceptanceCriteriaBusinessRuleTraceZodSchema = z.object({
  ruleId: z.string().min(1, 'ruleId cannot be empty'),
  ruleTitle: z.string().min(1, 'ruleTitle cannot be empty'),
  isCovered: z.boolean(),
  criteriaIds: z.array(z.string()).default([]),
});

export type AcceptanceCriteriaBusinessRuleTrace = z.infer<
  typeof AcceptanceCriteriaBusinessRuleTraceZodSchema
>;

export const AcceptanceCriteriaArchitectureTraceZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  decisionTitle: z.string().min(1, 'decisionTitle cannot be empty'),
  requiresVerification: z.boolean(),
  criteriaIds: z.array(z.string()).default([]),
});

export type AcceptanceCriteriaArchitectureTrace = z.infer<
  typeof AcceptanceCriteriaArchitectureTraceZodSchema
>;

// ============================================================================
// 9. COVERAGE MODEL
// ============================================================================

export const UncoveredRequirementDetailZodSchema = z.object({
  requirementId: z.string().min(1, 'requirementId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  reason: z.string().min(1, 'reason cannot be empty'),
});

export type UncoveredRequirementDetail = z.infer<
  typeof UncoveredRequirementDetailZodSchema
>;

export const AcceptanceCriteriaCoverageZodSchema = z.object({
  totalRequirements: z.number().int().nonnegative(),
  coveredRequirements: z.array(z.string()).default([]),
  uncoveredRequirements: z.array(z.string()).default([]),
  uncoveredRequirementsDetails: z.array(UncoveredRequirementDetailZodSchema).default([]),
  totalBusinessRules: z.number().int().nonnegative(),
  coveredBusinessRules: z.array(z.string()).default([]),
  uncoveredBusinessRules: z.array(z.string()).default([]),
  architectureDecisionsRequiringVerification: z.number().int().nonnegative(),
  architectureDecisionsVerified: z.array(z.string()).default([]),
  criteriaCount: z.number().int().nonnegative(),
  pendingDecisionCount: z.number().int().nonnegative(),
});

export type AcceptanceCriteriaCoverage = z.infer<
  typeof AcceptanceCriteriaCoverageZodSchema
>;

// ============================================================================
// 10. MASTER ACCEPTANCE CRITERIA REVISION ARTIFACT
// ============================================================================

export const ProjectAcceptanceCriteriaRevisionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  acceptanceCriteriaRevision: z
    .number()
    .int()
    .positive('acceptanceCriteriaRevision must be a positive integer'),
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
  sourceBusinessRulesRevision: z
    .number()
    .int()
    .positive('sourceBusinessRulesRevision must be a positive integer'),
  sourceBusinessRulesFingerprint: z
    .string()
    .min(1, 'sourceBusinessRulesFingerprint cannot be empty'),
  sourceDiscoveryRevision: z
    .number()
    .int()
    .positive('sourceDiscoveryRevision must be a positive integer'),
  sourceDiscoveryFingerprint: z
    .string()
    .min(1, 'sourceDiscoveryFingerprint cannot be empty'),
  isStale: z.boolean().default(false),
  criteria: z.array(AcceptanceCriterionZodSchema).default([]),
  coverage: AcceptanceCriteriaCoverageZodSchema,
  pendingHumanDecisions: z.array(AcceptanceCriteriaHumanDecisionZodSchema).default([]),
  conflicts: z.array(AcceptanceCriteriaConflictZodSchema).default([]),
  requirementsTraceability: z.array(AcceptanceCriteriaRequirementTraceZodSchema).default([]),
  businessRulesTraceability: z.array(AcceptanceCriteriaBusinessRuleTraceZodSchema).default([]),
  architectureTraceability: z.array(AcceptanceCriteriaArchitectureTraceZodSchema).default([]),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type ProjectAcceptanceCriteriaRevision = z.infer<
  typeof ProjectAcceptanceCriteriaRevisionZodSchema
>;

// ============================================================================
// 11. ENGINE INPUT CONTRACT
// ============================================================================

export const AcceptanceCriteriaInputZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  architectureRevision: z.number().int().positive().optional(),
  expectedArchitectureFingerprint: z.string().optional(),
  businessRulesRevision: z.number().int().positive().optional(),
  expectedBusinessRulesFingerprint: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalCriteria: z.array(AcceptanceCriterionZodSchema).optional(),
  customDecisions: z.array(AcceptanceCriteriaHumanDecisionZodSchema).optional(),
  conflicts: z.array(AcceptanceCriteriaConflictZodSchema).optional(),
  uncoveredExplanations: z.record(z.string(), z.string()).optional(),
});

export type AcceptanceCriteriaInput = z.infer<typeof AcceptanceCriteriaInputZodSchema>;

// ============================================================================
// 12. CANONICAL DETERMINISTIC FINGERPRINT HELPER
// ============================================================================

export function computeAcceptanceCriteriaFingerprint(
  revision: {
    projectId: string;
    sourceRequirementsRevision: number;
    sourceRequirementsFingerprint: string;
    sourceArchitectureRevision: number;
    sourceArchitectureFingerprint: string;
    sourceBusinessRulesRevision: number;
    sourceBusinessRulesFingerprint: string;
    sourceDiscoveryRevision: number;
    sourceDiscoveryFingerprint: string;
    criteria: Array<{
      criterionId: string;
      title: string;
      description: string;
      criterionType: string;
      statement: string;
      priority: string;
      status: string;
      sourceRequirements: string[];
      sourceBusinessRules: string[];
      sourceArchitectureDecisions: string[];
      verificationMethod: string;
      expectedResult: string;
      dependencies: string[];
      metadata?: Record<string, unknown>;
    }>;
    coverage: {
      totalRequirements: number;
      coveredRequirements: string[];
      uncoveredRequirements: string[];
      uncoveredRequirementsDetails: Array<{
        requirementId: string;
        title: string;
        reason: string;
      }>;
      totalBusinessRules: number;
      coveredBusinessRules: string[];
      uncoveredBusinessRules: string[];
      architectureDecisionsRequiringVerification: number;
      architectureDecisionsVerified: string[];
      criteriaCount: number;
      pendingDecisionCount: number;
    };
    pendingHumanDecisions: Array<{
      decisionId: string;
      question: string;
      whyItMatters: string;
      affectedCriteria: string[];
      affectedRequirements: string[];
      availableOptions: string[];
      consequences: string[];
      authority: string;
      status: string;
    }>;
    conflicts: Array<{
      conflictId: string;
      affectedRequirements: string[];
      affectedRules: string[];
      affectedCriteria: string[];
      conflictingStatements: string[];
      whyItMatters: string;
      requiredAuthority: string;
      resolutionStatus: string;
    }>;
    requirementsTraceability: Array<{
      requirementId: string;
      requirementTitle: string;
      isCovered: boolean;
      uncoveredReason?: string;
      criteriaIds: string[];
    }>;
    businessRulesTraceability: Array<{
      ruleId: string;
      ruleTitle: string;
      isCovered: boolean;
      criteriaIds: string[];
    }>;
    architectureTraceability: Array<{
      decisionId: string;
      decisionTitle: string;
      requiresVerification: boolean;
      criteriaIds: string[];
    }>;
  }
): string {
  const sortedCriteria = [...revision.criteria]
    .sort((a, b) => a.criterionId.localeCompare(b.criterionId))
    .map((c) => ({
      criterionId: c.criterionId,
      title: c.title,
      description: c.description,
      criterionType: c.criterionType,
      statement: c.statement,
      priority: c.priority,
      status: c.status,
      sourceRequirements: [...c.sourceRequirements].sort(),
      sourceBusinessRules: [...c.sourceBusinessRules].sort(),
      sourceArchitectureDecisions: [...c.sourceArchitectureDecisions].sort(),
      verificationMethod: c.verificationMethod,
      expectedResult: c.expectedResult,
      dependencies: [...c.dependencies].sort(),
      metadata: c.metadata ?? {},
    }));

  const sortedPendingDecisions = [...revision.pendingHumanDecisions]
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
    .map((d) => ({
      decisionId: d.decisionId,
      question: d.question,
      whyItMatters: d.whyItMatters,
      affectedCriteria: [...d.affectedCriteria].sort(),
      affectedRequirements: [...d.affectedRequirements].sort(),
      availableOptions: [...d.availableOptions].sort(),
      consequences: [...d.consequences].sort(),
      authority: d.authority,
      status: d.status,
    }));

  const sortedConflicts = [...revision.conflicts]
    .sort((a, b) => a.conflictId.localeCompare(b.conflictId))
    .map((c) => ({
      conflictId: c.conflictId,
      affectedRequirements: [...c.affectedRequirements].sort(),
      affectedRules: [...c.affectedRules].sort(),
      affectedCriteria: [...c.affectedCriteria].sort(),
      conflictingStatements: [...c.conflictingStatements].sort(),
      whyItMatters: c.whyItMatters,
      requiredAuthority: c.requiredAuthority,
      resolutionStatus: c.resolutionStatus,
    }));

  const sortedRequirementsTraceability = [...revision.requirementsTraceability]
    .sort((a, b) => a.requirementId.localeCompare(b.requirementId))
    .map((t) => ({
      requirementId: t.requirementId,
      requirementTitle: t.requirementTitle,
      isCovered: t.isCovered,
      uncoveredReason: t.uncoveredReason,
      criteriaIds: [...t.criteriaIds].sort(),
    }));

  const sortedBusinessRulesTraceability = [...revision.businessRulesTraceability]
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
    .map((t) => ({
      ruleId: t.ruleId,
      ruleTitle: t.ruleTitle,
      isCovered: t.isCovered,
      criteriaIds: [...t.criteriaIds].sort(),
    }));

  const sortedArchitectureTraceability = [...revision.architectureTraceability]
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
    .map((t) => ({
      decisionId: t.decisionId,
      decisionTitle: t.decisionTitle,
      requiresVerification: t.requiresVerification,
      criteriaIds: [...t.criteriaIds].sort(),
    }));

  const fingerprintMaterial = {
    projectId: revision.projectId,
    sourceRequirementsRevision: revision.sourceRequirementsRevision,
    sourceRequirementsFingerprint: revision.sourceRequirementsFingerprint,
    sourceArchitectureRevision: revision.sourceArchitectureRevision,
    sourceArchitectureFingerprint: revision.sourceArchitectureFingerprint,
    sourceBusinessRulesRevision: revision.sourceBusinessRulesRevision,
    sourceBusinessRulesFingerprint: revision.sourceBusinessRulesFingerprint,
    sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
    sourceDiscoveryFingerprint: revision.sourceDiscoveryFingerprint,
    criteria: sortedCriteria,
    coverage: {
      totalRequirements: revision.coverage.totalRequirements,
      coveredRequirements: [...revision.coverage.coveredRequirements].sort(),
      uncoveredRequirements: [...revision.coverage.uncoveredRequirements].sort(),
      uncoveredRequirementsDetails: [...revision.coverage.uncoveredRequirementsDetails].sort((a, b) =>
        a.requirementId.localeCompare(b.requirementId)
      ),
      totalBusinessRules: revision.coverage.totalBusinessRules,
      coveredBusinessRules: [...revision.coverage.coveredBusinessRules].sort(),
      uncoveredBusinessRules: [...revision.coverage.uncoveredBusinessRules].sort(),
      architectureDecisionsRequiringVerification:
        revision.coverage.architectureDecisionsRequiringVerification,
      architectureDecisionsVerified: [...revision.coverage.architectureDecisionsVerified].sort(),
      criteriaCount: revision.coverage.criteriaCount,
      pendingDecisionCount: revision.coverage.pendingDecisionCount,
    },
    pendingHumanDecisions: sortedPendingDecisions,
    conflicts: sortedConflicts,
    requirementsTraceability: sortedRequirementsTraceability,
    businessRulesTraceability: sortedBusinessRulesTraceability,
    architectureTraceability: sortedArchitectureTraceability,
  };

  return computeDeterministicFingerprint(fingerprintMaterial);
}
