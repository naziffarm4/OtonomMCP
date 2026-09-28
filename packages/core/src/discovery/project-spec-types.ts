/**
 * Project Specification Projection Types & Zod Schemas
 *
 * Defines the strongly typed domain model for the human-readable PROJECT_SPEC projection
 * consumed from existing authoritative project-initiation artifacts:
 * 1. Adaptive Discovery (P15-01)
 * 2. Requirements / Scope (P15-03)
 * 3. Architecture / Technology (P15-04)
 * 4. Business Rules (P15-05)
 * 5. Acceptance Criteria (P15-06)
 * 6. Risks & Human Decision Points (P15-07)
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. PROJECT_SPEC is strictly a deterministic, human-readable projection, NEVER a second source of truth.
 * 2. Deleting PROJECT_SPEC must leave authoritative state 100% intact and reconstructible.
 * 3. Does NOT approve the project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 * 4. Unresolved Human Decision Points are preserved exactly; never silently decided or converted to approval.
 * 5. Deterministic semantic fingerprint excludes volatile metadata (timestamps).
 * 6. Revision-bound: immutable by revision, binds to exact source revisions and fingerprints.
 * 7. Fails closed on cross-project contamination, forged fingerprints, tampering, or path traversal.
 */

import { z } from 'zod';
import { computeDeterministicFingerprint } from './adaptive-discovery-normalizer.js';

// ============================================================================
// 1. SOURCE BINDINGS MODEL
// ============================================================================

export const ProjectSpecSourceBindingsZodSchema = z.object({
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
  humanDecisionPointsCount: z.number().int().nonnegative().default(0),
  pendingHumanDecisionsCount: z.number().int().nonnegative().default(0),
});

export type ProjectSpecSourceBindings = z.infer<typeof ProjectSpecSourceBindingsZodSchema>;

// ============================================================================
// 2. PROJECTED SECTION MODELS
// ============================================================================

// --- 2.1 Project Identity & Purpose ---
export const SpecProjectIdentityZodSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  desiredOutcome: z.string().min(1),
});

export const SpecProjectPurposeZodSchema = z.object({
  purpose: z.string().min(1),
  problemStatement: z.string().default(''),
  desiredOutcome: z.string().default(''),
  measurableObjective: z.string().optional(),
});

// --- 2.2 Target Users ---
export const SpecTargetUsersZodSchema = z.object({
  primaryUsers: z.array(z.string()).default([]),
  secondaryUsers: z.array(z.string()).default([]),
  systemActors: z.array(z.string()).default([]),
  externalActors: z.array(z.string()).default([]),
});

// --- 2.3 Scope ---
export const SpecScopeItemsZodSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  integrations: z.array(z.string()).default([]),
});

export const SpecUndecidedScopeItemZodSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  description: z.string().min(1),
  availableOptions: z.array(z.string()).default([]),
  status: z.literal('PENDING_DECISION').default('PENDING_DECISION'),
  whyItMatters: z.string().default(''),
  affectedAreas: z.array(z.string()).default([]),
});

export const SpecScopeDefinitionZodSchema = z.object({
  inScope: SpecScopeItemsZodSchema,
  outOfScope: SpecScopeItemsZodSchema,
  undecidedScope: z.array(SpecUndecidedScopeItemZodSchema).default([]),
});

// --- 2.4 Functional Requirements ---
export const SpecFunctionalRequirementItemZodSchema = z.object({
  requirementId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.string().default('HIGH'),
  source: z.string().default(''),
  status: z.string().default('CONFIRMED'),
  affectedScope: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  businessRules: z.array(z.string()).default([]),
});

// --- 2.5 Non-Functional Requirements ---
export const SpecNonFunctionalRequirementsZodSchema = z.object({
  performance: z.array(z.string()).default([]),
  reliability: z.array(z.string()).default([]),
  security: z.array(z.string()).default([]),
  availability: z.array(z.string()).default([]),
  scalability: z.array(z.string()).default([]),
  usability: z.array(z.string()).default([]),
  maintainability: z.array(z.string()).default([]),
  operationalConstraints: z.array(z.string()).default([]),
});

// --- 2.6 Constraints ---
export const SpecConstraintsZodSchema = z.object({
  technologyConstraints: z.array(z.string()).default([]),
  platformConstraints: z.array(z.string()).default([]),
  compatibilityConstraints: z.array(z.string()).default([]),
  legalComplianceConstraints: z.array(z.string()).default([]),
  operationalConstraints: z.array(z.string()).default([]),
  budgetResourceConstraints: z.array(z.string()).default([]),
});

// --- 2.7 Assumptions ---
export const SpecAssumptionItemZodSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().optional(),
  validated: z.boolean().default(false),
  affectedRequirements: z.array(z.string()).default([]),
});

// --- 2.8 Open Questions ---
export const SpecOpenQuestionItemZodSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  whyItMatters: z.string().default(''),
  affectedAreas: z.array(z.string()).default([]),
  classification: z.string().default('INFORMATIONAL'),
  availableOptions: z.array(z.string()).default([]),
  status: z.string().default('OPEN'),
});

// --- 2.9 Architecture & Technology ---
export const SpecArchitecturalStyleZodSchema = z.object({
  style: z.string().min(1),
  pattern: z.string().optional(),
  applicationTopology: z.string().optional(),
  subsystemBoundaries: z.array(z.string()).default([]),
  serviceModuleBoundaries: z.array(z.string()).default([]),
  clientServerBoundaries: z.array(z.string()).default([]),
  deploymentTopology: z.string().optional(),
  communicationModel: z.string().optional(),
  status: z.string().default('CONFIRMED'),
});

export const SpecSystemComponentZodSchema = z.object({
  componentId: z.string().min(1),
  name: z.string().min(1),
  responsibility: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  exposedInterfaces: z.array(z.string()).default([]),
  owningBoundary: z.string().default(''),
  sourceReferences: z.array(z.string()).default([]),
  status: z.string().default('CONFIRMED'),
});

export const SpecDataArchitectureZodSchema = z.object({
  persistenceStrategy: z.string().optional(),
  primaryDataStore: z.string().optional(),
  secondaryStores: z.array(z.string()).default([]),
  caching: z.array(z.string()).default([]),
  fileObjectStorage: z.array(z.string()).default([]),
  dataOwnership: z.array(z.string()).default([]),
  dataFlow: z.array(z.string()).default([]),
  retentionRequirements: z.array(z.string()).default([]),
  consistencyRequirements: z.array(z.string()).default([]),
  status: z.string().default('CONFIRMED'),
});

export const SpecApiCommunicationArchitectureZodSchema = z.object({
  httpRest: z.boolean().default(false),
  graphQl: z.boolean().default(false),
  webSocket: z.boolean().default(false),
  messageQueues: z.array(z.string()).default([]),
  eventBus: z.array(z.string()).default([]),
  rpc: z.array(z.string()).default([]),
  ipc: z.array(z.string()).default([]),
  internalApis: z.array(z.string()).default([]),
  externalApis: z.array(z.string()).default([]),
  status: z.string().default('CONFIRMED'),
});

export const SpecPlatformEnvironmentZodSchema = z.object({
  targetOs: z.array(z.string()).default([]),
  targetDevices: z.array(z.string()).default([]),
  browserRequirements: z.array(z.string()).default([]),
  mobileRequirements: z.array(z.string()).default([]),
  desktopRequirements: z.array(z.string()).default([]),
  serverEnvironment: z.array(z.string()).default([]),
  cloudOnPremRequirements: z.array(z.string()).default([]),
  supportedRuntimeVersions: z.array(z.string()).default([]),
});

export const SpecSecurityArchitectureZodSchema = z.object({
  authenticationArchitecture: z.string().optional(),
  authorizationModel: z.string().optional(),
  identityProvider: z.string().optional(),
  secretsHandling: z.array(z.string()).default([]),
  encryptionRequirements: z.array(z.string()).default([]),
  trustBoundaries: z.array(z.string()).default([]),
  dataIsolation: z.array(z.string()).default([]),
  auditRequirements: z.array(z.string()).default([]),
  status: z.string().default('CONFIRMED'),
});

export const SpecArchitectureIntegrationZodSchema = z.object({
  integrationId: z.string().min(1),
  system: z.string().min(1),
  purpose: z.string().min(1),
  protocol: z.string().optional(),
  direction: z.string().default('BIDIRECTIONAL'),
  dependency: z.string().default('REQUIRED'),
  status: z.string().default('CONFIRMED'),
  source: z.string().default(''),
  affectedRequirements: z.array(z.string()).default([]),
});

export const SpecDeploymentArchitectureZodSchema = z.object({
  environments: z.array(z.string()).default([]),
  development: z.string().optional(),
  test: z.string().optional(),
  staging: z.string().optional(),
  production: z.string().optional(),
  deploymentModel: z.string().optional(),
  hostingPlatform: z.string().optional(),
  runtimeTopology: z.string().optional(),
  scalingExpectations: z.array(z.string()).default([]),
  operationalDependencies: z.array(z.string()).default([]),
  status: z.string().default('CONFIRMED'),
});

export const SpecTechnologyChoiceItemZodSchema = z.object({
  category: z.string().min(1),
  name: z.string().min(1),
  selectionStatus: z.string().min(1),
  versionConstraint: z.string().optional(),
  source: z.string().default(''),
  affectedRequirements: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});

export const SpecArchitectureDecisionItemZodSchema = z.object({
  decisionId: z.string().min(1),
  decisionArea: z.string().min(1),
  question: z.string().min(1),
  status: z.string().min(1),
  selectedOption: z.string().optional(),
  candidateOptions: z.array(z.string()).default([]),
  rationale: z.string().optional(),
  affectedRequirements: z.array(z.string()).default([]),
  consequences: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  authority: z.string().default('ARCHITECT'),
});

export const SpecArchitectureSectionZodSchema = z.object({
  architecturalStyle: SpecArchitecturalStyleZodSchema,
  systemComponents: z.array(SpecSystemComponentZodSchema).default([]),
  dataArchitecture: SpecDataArchitectureZodSchema,
  apiCommunicationArchitecture: SpecApiCommunicationArchitectureZodSchema,
  platformEnvironment: SpecPlatformEnvironmentZodSchema,
  securityArchitecture: SpecSecurityArchitectureZodSchema,
  integrations: z.array(SpecArchitectureIntegrationZodSchema).default([]),
  deploymentArchitecture: SpecDeploymentArchitectureZodSchema,
  technologyDecisions: z.array(SpecTechnologyChoiceItemZodSchema).default([]),
  technologyCandidates: z.array(SpecTechnologyChoiceItemZodSchema).default([]),
  architectureDecisions: z.array(SpecArchitectureDecisionItemZodSchema).default([]),
});

// --- 2.10 Business Rules ---
export const SpecBusinessRuleItemZodSchema = z.object({
  ruleId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  statement: z.string().min(1),
  priority: z.string().min(1),
  status: z.string().min(1),
  sourceRequirements: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  validationExpectation: z.string().optional(),
  temporalDetails: z.record(z.string(), z.unknown()).optional(),
  stateTransitionDetails: z.record(z.string(), z.unknown()).optional(),
  validationCalculationDetails: z.record(z.string(), z.unknown()).optional(),
  authorizationPolicyDetails: z.record(z.string(), z.unknown()).optional(),
});

// --- 2.11 Acceptance Criteria ---
export const SpecAcceptanceCriterionItemZodSchema = z.object({
  criterionId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  criterionType: z.string().min(1),
  statement: z.string().min(1),
  priority: z.string().min(1),
  status: z.string().min(1),
  sourceRequirements: z.array(z.string()).default([]),
  sourceBusinessRules: z.array(z.string()).default([]),
  sourceArchitectureDecisions: z.array(z.string()).default([]),
  verificationMethod: z.string().min(1),
  expectedResult: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
});

// --- 2.12 Risks ---
export const SpecRiskItemZodSchema = z.object({
  riskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  probability: z.string().min(1),
  impact: z.string().min(1),
  severity: z.string().min(1),
  status: z.string().min(1),
  response: z.string().min(1),
  statement: z.string().min(1),
  consequences: z.array(z.string()).default([]),
  mitigation: z.string().min(1),
  contingency: z.string().optional(),
  owner: z.string().default('PRODUCT_OWNER'),
  sourceRequirements: z.array(z.string()).default([]),
  sourceBusinessRules: z.array(z.string()).default([]),
  sourceArchitectureDecisions: z.array(z.string()).default([]),
  sourceAcceptanceCriteria: z.array(z.string()).default([]),
});

export const SpecRiskSummaryZodSchema = z.object({
  totalRisks: z.number().int().nonnegative().default(0),
  criticalRisks: z.number().int().nonnegative().default(0),
  highRisks: z.number().int().nonnegative().default(0),
  mediumRisks: z.number().int().nonnegative().default(0),
  lowRisks: z.number().int().nonnegative().default(0),
  pendingDecisionRisks: z.number().int().nonnegative().default(0),
});

// --- 2.13 Human Decision Points ---
export const SpecHumanDecisionPointZodSchema = z.object({
  decisionId: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  whyItMatters: z.string().default(''),
  affectedRisks: z.array(z.string()).default([]),
  affectedRequirements: z.array(z.string()).default([]),
  affectedArchitectureDecisions: z.array(z.string()).default([]),
  affectedBusinessRules: z.array(z.string()).default([]),
  affectedAcceptanceCriteria: z.array(z.string()).default([]),
  availableOptions: z.array(z.string()).min(1),
  recommendedInformation: z.string().default(''),
  consequences: z.array(z.string()).default([]),
  authority: z.enum(['PRODUCT_OWNER', 'USER']).default('PRODUCT_OWNER'),
  status: z.enum(['PENDING_DECISION', 'RESOLVED', 'REJECTED']).default('PENDING_DECISION'),
});

// --- 2.14 Traceability Matrix ---
export const SpecTraceabilityMatrixItemZodSchema = z.object({
  requirementId: z.string().min(1),
  requirementTitle: z.string().min(1),
  businessRuleIds: z.array(z.string()).default([]),
  acceptanceCriteriaIds: z.array(z.string()).default([]),
  architectureDecisionIds: z.array(z.string()).default([]),
  componentIds: z.array(z.string()).default([]),
  riskIds: z.array(z.string()).default([]),
});

// --- 2.15 Aggregated Content ---
export const ProjectSpecContentZodSchema = z.object({
  identity: SpecProjectIdentityZodSchema,
  purpose: SpecProjectPurposeZodSchema,
  targetUsers: SpecTargetUsersZodSchema,
  scope: SpecScopeDefinitionZodSchema,
  functionalRequirements: z.array(SpecFunctionalRequirementItemZodSchema).default([]),
  nonFunctionalRequirements: SpecNonFunctionalRequirementsZodSchema,
  constraints: SpecConstraintsZodSchema,
  assumptions: z.array(SpecAssumptionItemZodSchema).default([]),
  openQuestions: z.array(SpecOpenQuestionItemZodSchema).default([]),
  architecture: SpecArchitectureSectionZodSchema,
  businessRules: z.array(SpecBusinessRuleItemZodSchema).default([]),
  acceptanceCriteria: z.array(SpecAcceptanceCriterionItemZodSchema).default([]),
  risks: z.array(SpecRiskItemZodSchema).default([]),
  riskSummary: SpecRiskSummaryZodSchema,
  humanDecisionPoints: z.array(SpecHumanDecisionPointZodSchema).default([]),
  traceabilityMatrix: z.array(SpecTraceabilityMatrixItemZodSchema).default([]),
});

export type ProjectSpecContent = z.infer<typeof ProjectSpecContentZodSchema>;

// ============================================================================
// 3. STALE DETECTION REPORT
// ============================================================================

export const ProjectSpecStaleReportZodSchema = z.object({
  isStale: z.boolean(),
  reasons: z.array(z.string()),
  details: z.object({
    discoveryStale: z.boolean(),
    requirementsStale: z.boolean(),
    architectureStale: z.boolean(),
    businessRulesStale: z.boolean(),
    acceptanceCriteriaStale: z.boolean(),
    risksStale: z.boolean(),
    humanDecisionsChanged: z.boolean(),
  }),
  currentBindings: ProjectSpecSourceBindingsZodSchema.optional(),
  latestAuthoritativeRevisions: z.object({
    discoveryRevision: z.number().int().positive().nullable(),
    discoveryFingerprint: z.string().nullable(),
    requirementsRevision: z.number().int().positive().nullable(),
    requirementsFingerprint: z.string().nullable(),
    architectureRevision: z.number().int().positive().nullable(),
    architectureFingerprint: z.string().nullable(),
    businessRulesRevision: z.number().int().positive().nullable(),
    businessRulesFingerprint: z.string().nullable(),
    acceptanceCriteriaRevision: z.number().int().positive().nullable(),
    acceptanceCriteriaFingerprint: z.string().nullable(),
    riskRevision: z.number().int().positive().nullable(),
    riskFingerprint: z.string().nullable(),
  }),
});

export type ProjectSpecStaleReport = z.infer<typeof ProjectSpecStaleReportZodSchema>;

// ============================================================================
// 4. MASTER PROJECT SPEC PROJECTION ARTIFACT
// ============================================================================

export const ProjectSpecProjectionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  specRevision: z.number().int().positive('specRevision must be a positive integer'),
  sourceBindings: ProjectSpecSourceBindingsZodSchema,
  content: ProjectSpecContentZodSchema,
  markdownContent: z.string().min(1, 'markdownContent cannot be empty'),
  semanticFingerprint: z.string().min(1, 'semanticFingerprint cannot be empty'),
  isStale: z.boolean().default(false),
  staleReport: ProjectSpecStaleReportZodSchema.optional(),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
});

export type ProjectSpecProjection = z.infer<typeof ProjectSpecProjectionZodSchema>;

// ============================================================================
// 5. INPUT CONTRACT FOR ENGINE
// ============================================================================

export const ProjectSpecInputZodSchema = z.object({
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
  riskRevision: z.number().int().positive().optional(),
  expectedRiskFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  generatedAt: z.string().optional(),
});

export type ProjectSpecInput = z.infer<typeof ProjectSpecInputZodSchema>;

// ============================================================================
// 6. CANONICAL DETERMINISTIC FINGERPRINT HELPER
// ============================================================================

/**
 * Computes canonical deterministic semantic fingerprint for a PROJECT_SPEC projection.
 * STRICT INVARIANT:
 * Excludes volatile metadata (createdAt / generation timestamp, isStale, formatting whitespace)
 * so that identical authoritative source inputs produce identical semantic fingerprints.
 */
export function computeProjectSpecSemanticFingerprint(spec: {
  projectId: string;
  specRevision: number;
  sourceBindings: ProjectSpecSourceBindings;
  content: ProjectSpecContent;
}): string {
  const fingerprintMaterial = {
    projectId: spec.projectId,
    specRevision: spec.specRevision,
    sourceBindings: {
      discoveryRevision: spec.sourceBindings.discoveryRevision,
      discoveryFingerprint: spec.sourceBindings.discoveryFingerprint,
      requirementsRevision: spec.sourceBindings.requirementsRevision,
      requirementsFingerprint: spec.sourceBindings.requirementsFingerprint,
      architectureRevision: spec.sourceBindings.architectureRevision,
      architectureFingerprint: spec.sourceBindings.architectureFingerprint,
      businessRulesRevision: spec.sourceBindings.businessRulesRevision,
      businessRulesFingerprint: spec.sourceBindings.businessRulesFingerprint,
      acceptanceCriteriaRevision: spec.sourceBindings.acceptanceCriteriaRevision,
      acceptanceCriteriaFingerprint: spec.sourceBindings.acceptanceCriteriaFingerprint,
      riskRevision: spec.sourceBindings.riskRevision,
      riskFingerprint: spec.sourceBindings.riskFingerprint,
      humanDecisionPointsCount: spec.sourceBindings.humanDecisionPointsCount,
      pendingHumanDecisionsCount: spec.sourceBindings.pendingHumanDecisionsCount,
    },
    content: spec.content,
  };

  return computeDeterministicFingerprint(fingerprintMaterial);
}
