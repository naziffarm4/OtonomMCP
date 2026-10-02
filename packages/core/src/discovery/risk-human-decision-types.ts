/**
 * Risk & Human Decision Points Types & Zod Schemas (Phase 15 TASK-P15-07)
 *
 * Defines the strongly typed, revisioned Risk and Human Decision Point domain model
 * for project initiation:
 * - Deterministic Risk Identity (RISK-<HASH>)
 * - Explicit Risk Categories (23 defined categories)
 * - Explicit Probabilities (VERY_LOW, LOW, MEDIUM, HIGH, VERY_HIGH)
 * - Explicit Impacts (NEGLIGIBLE, LOW, MEDIUM, HIGH, CRITICAL)
 * - Deterministic Severity Mapping (LOW, MEDIUM, HIGH, CRITICAL)
 * - Explicit Risk Statuses (IDENTIFIED, ANALYZING, MITIGATED, ACCEPTED, TRANSFERRED, AVOIDED, PENDING_DECISION, CLOSED, NOT_APPLICABLE)
 * - Explicit Risk Responses (MITIGATE, AVOID, TRANSFER, ACCEPT, MONITOR, PENDING_DECISION)
 * - Product Owner Human Decision Points (HDP-<HASH>)
 * - Human Authority Boundary (PRODUCT_OWNER / USER only)
 * - Comprehensive Traceability (Requirements, Business Rules, Architecture, Acceptance Criteria, Discovery)
 * - Deterministic Coverage Model
 * - Immutable Revision & Multi-Source Bindings
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-07 defines "What can go wrong, how significant is it, how is it mitigated, and where must a human/Product Owner make an explicit decision?"
 * 2. It does NOT answer "Should the project be approved?" (That belongs to the later Product Owner Approval phase).
 * 3. Does NOT approve the project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 * 4. Human Decision Points can NEVER be silently chosen by the system.
 * 5. Strict determinism: canonical fingerprint calculation excluding timestamps and volatile values.
 * 6. Revision-bound: immutable by revision, binds to source requirements, architecture, business rules, acceptance criteria, and discovery.
 * 7. Cross-project isolation: results for project A can never be used for project B.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';
import { computeDeterministicFingerprint } from './adaptive-discovery-normalizer.js';

// ============================================================================
// 1. RISK CATEGORIES
// ============================================================================

export const PROJECT_RISK_CATEGORIES = [
  'PRODUCT',
  'SCOPE',
  'REQUIREMENT',
  'TECHNICAL',
  'ARCHITECTURE',
  'TECHNOLOGY',
  'DATA',
  'SECURITY',
  'PRIVACY',
  'INTEGRATION',
  'OPERATIONAL',
  'DEPLOYMENT',
  'PERFORMANCE',
  'RELIABILITY',
  'AVAILABILITY',
  'DEPENDENCY',
  'RESOURCE',
  'SCHEDULE',
  'COST',
  'COMPLIANCE',
  'USER_ADOPTION',
  'BUSINESS',
  'UNKNOWN',
] as const;

export type ProjectRiskCategory = (typeof PROJECT_RISK_CATEGORIES)[number];
export const ProjectRiskCategoryZodSchema = z.enum(PROJECT_RISK_CATEGORIES);

export const RISK_CATEGORIES = PROJECT_RISK_CATEGORIES;
export type RiskCategory = ProjectRiskCategory;
export const RiskCategoryZodSchema = ProjectRiskCategoryZodSchema;

// ============================================================================
// 2. PROBABILITY & IMPACT
// ============================================================================

export const PROJECT_RISK_PROBABILITIES = [
  'VERY_LOW',
  'LOW',
  'MEDIUM',
  'HIGH',
  'VERY_HIGH',
] as const;

export type ProjectRiskProbability = (typeof PROJECT_RISK_PROBABILITIES)[number];
export const ProjectRiskProbabilityZodSchema = z.enum(PROJECT_RISK_PROBABILITIES);

export const RISK_PROBABILITIES = PROJECT_RISK_PROBABILITIES;
export type RiskProbability = ProjectRiskProbability;
export const RiskProbabilityZodSchema = ProjectRiskProbabilityZodSchema;

export const PROJECT_RISK_IMPACTS = [
  'NEGLIGIBLE',
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type ProjectRiskImpact = (typeof PROJECT_RISK_IMPACTS)[number];
export const ProjectRiskImpactZodSchema = z.enum(PROJECT_RISK_IMPACTS);

export const RISK_IMPACTS = PROJECT_RISK_IMPACTS;
export type RiskImpact = ProjectRiskImpact;
export const RiskImpactZodSchema = ProjectRiskImpactZodSchema;

// ============================================================================
// 3. SEVERITY & DETERMINISTIC MAPPING
// ============================================================================

export const PROJECT_RISK_SEVERITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type ProjectRiskSeverity = (typeof PROJECT_RISK_SEVERITIES)[number];
export const ProjectRiskSeverityZodSchema = z.enum(PROJECT_RISK_SEVERITIES);

export const RISK_SEVERITIES = PROJECT_RISK_SEVERITIES;
export type RiskSeverity = ProjectRiskSeverity;
export const RiskSeverityZodSchema = ProjectRiskSeverityZodSchema;

/**
 * Deterministic Risk Severity Matrix mapping (Probability x Impact) -> Severity.
 * Exhaustively defines all 25 combinations.
 */
export const RISK_SEVERITY_MATRIX: Record<RiskProbability, Record<RiskImpact, RiskSeverity>> = {
  VERY_LOW: {
    NEGLIGIBLE: 'LOW',
    LOW: 'LOW',
    MEDIUM: 'LOW',
    HIGH: 'LOW',
    CRITICAL: 'MEDIUM',
  },
  LOW: {
    NEGLIGIBLE: 'LOW',
    LOW: 'LOW',
    MEDIUM: 'LOW',
    HIGH: 'MEDIUM',
    CRITICAL: 'HIGH',
  },
  MEDIUM: {
    NEGLIGIBLE: 'LOW',
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
    CRITICAL: 'CRITICAL',
  },
  HIGH: {
    NEGLIGIBLE: 'LOW',
    LOW: 'MEDIUM',
    MEDIUM: 'HIGH',
    HIGH: 'CRITICAL',
    CRITICAL: 'CRITICAL',
  },
  VERY_HIGH: {
    NEGLIGIBLE: 'LOW',
    LOW: 'MEDIUM',
    MEDIUM: 'HIGH',
    HIGH: 'CRITICAL',
    CRITICAL: 'CRITICAL',
  },
};

/**
 * Computes deterministic severity from probability and impact.
 */
export function computeRiskSeverity(
  probability: RiskProbability,
  impact: RiskImpact
): RiskSeverity {
  const row = RISK_SEVERITY_MATRIX[probability];
  if (!row) {
    throw new Error(`Invalid risk probability: '${probability}'`);
  }
  const severity = row[impact];
  if (!severity) {
    throw new Error(`Invalid risk impact: '${impact}'`);
  }
  return severity;
}

// ============================================================================
// 4. RISK STATUS & RISK RESPONSE
// ============================================================================

export const PROJECT_RISK_STATUSES = [
  'IDENTIFIED',
  'ANALYZING',
  'MITIGATED',
  'ACCEPTED',
  'TRANSFERRED',
  'AVOIDED',
  'PENDING_DECISION',
  'CLOSED',
  'NOT_APPLICABLE',
] as const;

export type ProjectRiskStatus = (typeof PROJECT_RISK_STATUSES)[number];
export const ProjectRiskStatusZodSchema = z.enum(PROJECT_RISK_STATUSES);

export const RISK_STATUSES = PROJECT_RISK_STATUSES;
export type RiskStatus = ProjectRiskStatus;
export const RiskStatusZodSchema = ProjectRiskStatusZodSchema;

export const PROJECT_RISK_RESPONSES = [
  'MITIGATE',
  'AVOID',
  'TRANSFER',
  'ACCEPT',
  'MONITOR',
  'PENDING_DECISION',
] as const;

export type ProjectRiskResponse = (typeof PROJECT_RISK_RESPONSES)[number];
export const ProjectRiskResponseZodSchema = z.enum(PROJECT_RISK_RESPONSES);

export const RISK_RESPONSES = PROJECT_RISK_RESPONSES;
export type RiskResponse = ProjectRiskResponse;
export const RiskResponseZodSchema = ProjectRiskResponseZodSchema;

// ============================================================================
// 5. HUMAN DECISION POINT MODEL
// ============================================================================

export const PROJECT_HUMAN_DECISION_AUTHORITIES = ['PRODUCT_OWNER', 'USER'] as const;
export type ProjectHumanDecisionAuthority = (typeof PROJECT_HUMAN_DECISION_AUTHORITIES)[number];
export const ProjectHumanDecisionAuthorityZodSchema = z.enum(PROJECT_HUMAN_DECISION_AUTHORITIES);

export const HUMAN_DECISION_AUTHORITIES = PROJECT_HUMAN_DECISION_AUTHORITIES;
export type HumanDecisionAuthority = ProjectHumanDecisionAuthority;
export const HumanDecisionAuthorityZodSchema = ProjectHumanDecisionAuthorityZodSchema;

export const PROJECT_HUMAN_DECISION_STATUSES = [
  'PENDING_DECISION',
  'RESOLVED',
  'CONFIRMED',
  'UNDECIDED',
  'PROPOSED',
  'OPEN',
  'REJECTED',
] as const;
export type ProjectHumanDecisionStatus = (typeof PROJECT_HUMAN_DECISION_STATUSES)[number];
export const ProjectHumanDecisionStatusZodSchema = z.enum(PROJECT_HUMAN_DECISION_STATUSES);

export const HUMAN_DECISION_STATUSES = PROJECT_HUMAN_DECISION_STATUSES;
export type HumanDecisionStatus = ProjectHumanDecisionStatus;
export const HumanDecisionStatusZodSchema = ProjectHumanDecisionStatusZodSchema;

export const ProjectHumanDecisionPointZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedRisks: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  affectedArchitectureDecisions: z.array(z.string()).default([]),
  affectedBusinessRules: z.array(z.string()).default([]),
  affectedAcceptanceCriteria: z.array(z.string()).default([]),
  availableOptions: z.array(z.string()).min(1, 'availableOptions must contain at least one option'),
  consequences: z.array(z.string()).default([]),
  recommendedInformation: z.string().default(''),
  authority: ProjectHumanDecisionAuthorityZodSchema.default('PRODUCT_OWNER'),
  status: ProjectHumanDecisionStatusZodSchema.default('PENDING_DECISION'),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProjectHumanDecisionPoint = z.infer<typeof ProjectHumanDecisionPointZodSchema>;

export const HumanDecisionPointZodSchema = ProjectHumanDecisionPointZodSchema;
export type HumanDecisionPoint = ProjectHumanDecisionPoint;

// ============================================================================
// 6. RISK TRACEABILITY LINK MODEL
// ============================================================================

export const RiskTraceabilityLinkZodSchema = z.object({
  riskId: z.string().min(1, 'riskId cannot be empty'),
  requirementIds: z.array(z.string()).default([]),
  businessRuleIds: z.array(z.string()).default([]),
  architectureDecisionIds: z.array(z.string()).default([]),
  acceptanceCriteriaIds: z.array(z.string()).default([]),
  discoveryKeys: z.array(z.string()).default([]),
});

export type RiskTraceabilityLink = z.infer<typeof RiskTraceabilityLinkZodSchema>;

// ============================================================================
// 7. CORE PROJECT RISK MODEL
// ============================================================================

export const ProjectRiskZodSchema = z.object({
  riskId: z.string().min(1, 'riskId cannot be empty'),
  title: z.string().min(1, 'title cannot be empty'),
  description: z.string().min(1, 'description cannot be empty'),
  category: ProjectRiskCategoryZodSchema,
  probability: ProjectRiskProbabilityZodSchema,
  impact: ProjectRiskImpactZodSchema,
  severity: ProjectRiskSeverityZodSchema,
  status: ProjectRiskStatusZodSchema,
  response: ProjectRiskResponseZodSchema.default('PENDING_DECISION'),
  statement: z.string().min(1, 'statement cannot be empty'),
  consequences: z.array(z.string()).default([]),
  mitigation: z.string().min(1, 'mitigation cannot be empty'),
  contingency: z.string().default(''),
  owner: z.string().min(1, 'owner cannot be empty').default('PRODUCT_OWNER'),
  sourceRequirements: z.array(z.string()).default([]),
  sourceBusinessRules: z.array(z.string()).default([]),
  sourceArchitectureDecisions: z.array(z.string()).default([]),
  sourceAcceptanceCriteria: z.array(z.string()).default([]),
  sourceDiscovery: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  traceability: RiskTraceabilityLinkZodSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProjectRisk = z.infer<typeof ProjectRiskZodSchema>;

// ============================================================================
// 8. COVERAGE MODELS
// ============================================================================

export const RiskCoverageZodSchema = z.object({
  totalRisks: z.number().int().nonnegative(),
  criticalRisks: z.number().int().nonnegative(),
  highRisks: z.number().int().nonnegative(),
  mediumRisks: z.number().int().nonnegative(),
  lowRisks: z.number().int().nonnegative(),
  pendingDecisionRisks: z.number().int().nonnegative(),
  requirementsWithRisks: z.array(z.string()).default([]),
  requirementsWithoutRisks: z.array(z.string()).default([]),
  architectureDecisionsWithRisks: z.array(z.string()).default([]),
  architectureDecisionsWithoutRisks: z.array(z.string()).default([]),
  acceptanceCriteriaWithRisks: z.array(z.string()).default([]),
  acceptanceCriteriaWithoutRisks: z.array(z.string()).default([]),
  businessRulesWithRisks: z.array(z.string()).default([]),
  businessRulesWithoutRisks: z.array(z.string()).default([]),
});

export type RiskCoverage = z.infer<typeof RiskCoverageZodSchema>;

export const HumanDecisionCoverageZodSchema = z.object({
  totalHumanDecisionPoints: z.number().int().nonnegative(),
  pendingHumanDecisionPoints: z.number().int().nonnegative(),
  resolvedHumanDecisionPoints: z.number().int().nonnegative(),
});

export type HumanDecisionCoverage = z.infer<typeof HumanDecisionCoverageZodSchema>;

// ============================================================================
// 9. MASTER PROJECT RISK REVISION ARTIFACT
// ============================================================================

export const ProjectRiskRevisionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  riskRevision: z
    .number()
    .int()
    .positive('riskRevision must be a positive integer'),
  sourceDiscoveryRevision: z
    .number()
    .int()
    .positive('sourceDiscoveryRevision must be a positive integer'),
  sourceDiscoveryFingerprint: z
    .string()
    .min(1, 'sourceDiscoveryFingerprint cannot be empty'),
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
  sourceAcceptanceCriteriaRevision: z
    .number()
    .int()
    .positive('sourceAcceptanceCriteriaRevision must be a positive integer'),
  sourceAcceptanceCriteriaFingerprint: z
    .string()
    .min(1, 'sourceAcceptanceCriteriaFingerprint cannot be empty'),
  isStale: z.boolean().default(false),
  risks: z.array(ProjectRiskZodSchema).default([]),
  humanDecisionPoints: z.array(ProjectHumanDecisionPointZodSchema).default([]),
  coverage: RiskCoverageZodSchema,
  humanDecisionCoverage: HumanDecisionCoverageZodSchema,
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type ProjectRiskRevision = z.infer<typeof ProjectRiskRevisionZodSchema>;

// ============================================================================
// 10. ENGINE INPUT CONTRACT
// ============================================================================

export const RiskHumanDecisionInputZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  architectureRevision: z.number().int().positive().optional(),
  expectedArchitectureFingerprint: z.string().optional(),
  businessRulesRevision: z.number().int().positive().optional(),
  expectedBusinessRulesFingerprint: z.string().optional(),
  acceptanceCriteriaRevision: z.number().int().positive().optional(),
  expectedAcceptanceCriteriaFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalRisks: z.array(ProjectRiskZodSchema).optional(),
  customDecisions: z.array(ProjectHumanDecisionPointZodSchema).optional(),
});

export type RiskHumanDecisionInput = z.infer<typeof RiskHumanDecisionInputZodSchema>;

// ============================================================================
// 11. CANONICAL DETERMINISTIC FINGERPRINT HELPER
// ============================================================================

export function computeRiskFingerprint(revision: {
  projectId: string;
  sourceDiscoveryRevision: number;
  sourceDiscoveryFingerprint: string;
  sourceRequirementsRevision: number;
  sourceRequirementsFingerprint: string;
  sourceArchitectureRevision: number;
  sourceArchitectureFingerprint: string;
  sourceBusinessRulesRevision: number;
  sourceBusinessRulesFingerprint: string;
  sourceAcceptanceCriteriaRevision: number;
  sourceAcceptanceCriteriaFingerprint: string;
  risks: Array<{
    riskId: string;
    title: string;
    description: string;
    category: string;
    probability: string;
    impact: string;
    severity: string;
    status: string;
    response: string;
    statement: string;
    consequences: string[];
    mitigation: string;
    contingency: string;
    owner: string;
    sourceRequirements: string[];
    sourceBusinessRules: string[];
    sourceArchitectureDecisions: string[];
    sourceAcceptanceCriteria: string[];
    sourceDiscovery: string[];
    dependencies: string[];
    metadata?: Record<string, unknown>;
  }>;
  humanDecisionPoints: Array<{
    decisionId: string;
    title: string;
    question: string;
    whyItMatters: string;
    affectedRisks: string[];
    affectedRequirements: string[];
    affectedArchitectureDecisions: string[];
    affectedBusinessRules: string[];
    affectedAcceptanceCriteria: string[];
    availableOptions: string[];
    consequences: string[];
    recommendedInformation: string;
    authority: string;
    status: string;
    metadata?: Record<string, unknown>;
  }>;
  coverage: {
    totalRisks: number;
    criticalRisks: number;
    highRisks: number;
    mediumRisks: number;
    lowRisks: number;
    pendingDecisionRisks: number;
    requirementsWithRisks: string[];
    requirementsWithoutRisks: string[];
    architectureDecisionsWithRisks: string[];
    architectureDecisionsWithoutRisks: string[];
    acceptanceCriteriaWithRisks: string[];
    acceptanceCriteriaWithoutRisks: string[];
    businessRulesWithRisks: string[];
    businessRulesWithoutRisks: string[];
  };
  humanDecisionCoverage: {
    totalHumanDecisionPoints: number;
    pendingHumanDecisionPoints: number;
    resolvedHumanDecisionPoints: number;
  };
}): string {
  const sortedRisks = [...revision.risks]
    .sort((a, b) => a.riskId.localeCompare(b.riskId))
    .map((r) => ({
      riskId: r.riskId,
      title: r.title,
      description: r.description,
      category: r.category,
      probability: r.probability,
      impact: r.impact,
      severity: r.severity,
      status: r.status,
      response: r.response,
      statement: r.statement,
      consequences: [...r.consequences].sort(),
      mitigation: r.mitigation,
      contingency: r.contingency,
      owner: r.owner,
      sourceRequirements: [...r.sourceRequirements].sort(),
      sourceBusinessRules: [...r.sourceBusinessRules].sort(),
      sourceArchitectureDecisions: [...r.sourceArchitectureDecisions].sort(),
      sourceAcceptanceCriteria: [...r.sourceAcceptanceCriteria].sort(),
      sourceDiscovery: [...r.sourceDiscovery].sort(),
      dependencies: [...r.dependencies].sort(),
      metadata: r.metadata ?? {},
    }));

  const sortedHumanDecisionPoints = [...revision.humanDecisionPoints]
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
    .map((d) => ({
      decisionId: d.decisionId,
      title: d.title,
      question: d.question,
      whyItMatters: d.whyItMatters,
      affectedRisks: [...d.affectedRisks].sort(),
      affectedRequirements: [...d.affectedRequirements].sort(),
      affectedArchitectureDecisions: [...d.affectedArchitectureDecisions].sort(),
      affectedBusinessRules: [...d.affectedBusinessRules].sort(),
      affectedAcceptanceCriteria: [...d.affectedAcceptanceCriteria].sort(),
      availableOptions: [...d.availableOptions].sort(),
      consequences: [...d.consequences].sort(),
      recommendedInformation: d.recommendedInformation,
      authority: d.authority,
      status: d.status,
      metadata: d.metadata ?? {},
    }));

  const fingerprintMaterial = {
    projectId: revision.projectId,
    sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
    sourceDiscoveryFingerprint: revision.sourceDiscoveryFingerprint,
    sourceRequirementsRevision: revision.sourceRequirementsRevision,
    sourceRequirementsFingerprint: revision.sourceRequirementsFingerprint,
    sourceArchitectureRevision: revision.sourceArchitectureRevision,
    sourceArchitectureFingerprint: revision.sourceArchitectureFingerprint,
    sourceBusinessRulesRevision: revision.sourceBusinessRulesRevision,
    sourceBusinessRulesFingerprint: revision.sourceBusinessRulesFingerprint,
    sourceAcceptanceCriteriaRevision: revision.sourceAcceptanceCriteriaRevision,
    sourceAcceptanceCriteriaFingerprint: revision.sourceAcceptanceCriteriaFingerprint,
    risks: sortedRisks,
    humanDecisionPoints: sortedHumanDecisionPoints,
    coverage: {
      totalRisks: revision.coverage.totalRisks,
      criticalRisks: revision.coverage.criticalRisks,
      highRisks: revision.coverage.highRisks,
      mediumRisks: revision.coverage.mediumRisks,
      lowRisks: revision.coverage.lowRisks,
      pendingDecisionRisks: revision.coverage.pendingDecisionRisks,
      requirementsWithRisks: [...revision.coverage.requirementsWithRisks].sort(),
      requirementsWithoutRisks: [...revision.coverage.requirementsWithoutRisks].sort(),
      architectureDecisionsWithRisks: [...revision.coverage.architectureDecisionsWithRisks].sort(),
      architectureDecisionsWithoutRisks: [...revision.coverage.architectureDecisionsWithoutRisks].sort(),
      acceptanceCriteriaWithRisks: [...revision.coverage.acceptanceCriteriaWithRisks].sort(),
      acceptanceCriteriaWithoutRisks: [...revision.coverage.acceptanceCriteriaWithoutRisks].sort(),
      businessRulesWithRisks: [...revision.coverage.businessRulesWithRisks].sort(),
      businessRulesWithoutRisks: [...revision.coverage.businessRulesWithoutRisks].sort(),
    },
    humanDecisionCoverage: {
      totalHumanDecisionPoints: revision.humanDecisionCoverage.totalHumanDecisionPoints,
      pendingHumanDecisionPoints: revision.humanDecisionCoverage.pendingHumanDecisionPoints,
      resolvedHumanDecisionPoints: revision.humanDecisionCoverage.resolvedHumanDecisionPoints,
    },
  };

  return computeDeterministicFingerprint(fingerprintMaterial);
}
