/**
 * Architecture & Technology Definition Types & Zod Schemas (Phase 15 TASK-P15-04)
 *
 * Defines the strongly typed, revisioned Architecture / Technology domain model for project initiation:
 * - Architectural Style & Topology
 * - Major Logical System Components (with deterministic component IDs)
 * - Data Architecture & Persistence Strategy
 * - API & Communication Architecture
 * - Technology Stack with explicit Selection Statuses
 * - Platform & Environment Constraints
 * - Security Architecture
 * - Integrations
 * - Deployment Architecture
 * - Architectural Decision Model with explicit human boundaries
 * - Traceability to authoritative Requirements & Scope (P15-03)
 * - Revision and source discovery/requirements binding
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-04 defines WHAT architecture/technology decisions are required and what has been selected or remains undecided.
 * 2. Does NOT approve the project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine.
 * 4. Technology choices strictly distinguish REQUIRED, CONSTRAINED, SELECTED, CANDIDATE, and UNDECIDED.
 * 5. Strict determinism: canonical fingerprint calculation excluding timestamps and volatile values.
 * 6. Revision-bound: immutable by revision, binds to source requirements & discovery revisions/fingerprints.
 * 7. Cross-project isolation: results for project A can never be used for project B.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';

// ============================================================================
// 1. ARCHITECTURAL STYLE & TOPOLOGY
// ============================================================================

export const ARCHITECTURAL_STYLE_STATUSES = [
  'CONFIRMED',
  'CANDIDATE',
  'PENDING_DECISION',
] as const;

export type ArchitecturalStyleStatus = (typeof ARCHITECTURAL_STYLE_STATUSES)[number];

export const ArchitecturalStyleDefinitionZodSchema = z.object({
  style: z.string().min(1, 'style cannot be empty'),
  pattern: z.string().optional(),
  applicationTopology: z.string().optional(),
  subsystemBoundaries: z.array(z.string()).default([]),
  serviceModuleBoundaries: z.array(z.string()).default([]),
  clientServerBoundaries: z.array(z.string()).default([]),
  deploymentTopology: z.string().optional(),
  communicationModel: z.string().optional(),
  status: z.enum(ARCHITECTURAL_STYLE_STATUSES).default('CONFIRMED'),
});

export type ArchitecturalStyleDefinition = z.infer<
  typeof ArchitecturalStyleDefinitionZodSchema
>;

// ============================================================================
// 2. SYSTEM COMPONENTS
// ============================================================================

export const COMPONENT_STATUSES = [
  'CONFIRMED',
  'PROPOSED',
  'CANDIDATE',
  'PENDING_DECISION',
] as const;

export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export const SystemComponentZodSchema = z.object({
  componentId: z.string().min(1, 'componentId cannot be empty'),
  name: z.string().min(1, 'name cannot be empty'),
  responsibility: z.string().min(1, 'responsibility cannot be empty'),
  dependencies: z.array(z.string()).default([]),
  exposedInterfaces: z.array(z.string()).default([]),
  owningBoundary: z.string().min(1, 'owningBoundary cannot be empty'),
  sourceReferences: z.array(z.string()).default([]),
  status: z.enum(COMPONENT_STATUSES).default('CONFIRMED'),
});

export type SystemComponent = z.infer<typeof SystemComponentZodSchema>;

// ============================================================================
// 3. DATA ARCHITECTURE
// ============================================================================

export const DATA_ARCHITECTURE_STATUSES = [
  'CONFIRMED',
  'CANDIDATE',
  'PENDING_DECISION',
  'NOT_APPLICABLE',
] as const;

export type DataArchitectureStatus = (typeof DATA_ARCHITECTURE_STATUSES)[number];

export const DataArchitectureZodSchema = z.object({
  persistenceStrategy: z.string().optional(),
  primaryDataStore: z.string().optional(),
  secondaryStores: z.array(z.string()).default([]),
  caching: z.array(z.string()).default([]),
  fileObjectStorage: z.array(z.string()).default([]),
  dataOwnership: z.array(z.string()).default([]),
  dataFlow: z.array(z.string()).default([]),
  retentionRequirements: z.array(z.string()).default([]),
  consistencyRequirements: z.array(z.string()).default([]),
  status: z.enum(DATA_ARCHITECTURE_STATUSES).default('CONFIRMED'),
});

export type DataArchitecture = z.infer<typeof DataArchitectureZodSchema>;

// ============================================================================
// 4. API & COMMUNICATION ARCHITECTURE
// ============================================================================

export const API_COMMUNICATION_STATUSES = [
  'CONFIRMED',
  'CANDIDATE',
  'PENDING_DECISION',
] as const;

export type ApiCommunicationStatus = (typeof API_COMMUNICATION_STATUSES)[number];

export const ApiCommunicationArchitectureZodSchema = z.object({
  httpRest: z.boolean().default(false),
  graphQl: z.boolean().default(false),
  webSocket: z.boolean().default(false),
  messageQueues: z.array(z.string()).default([]),
  eventBus: z.array(z.string()).default([]),
  rpc: z.array(z.string()).default([]),
  ipc: z.array(z.string()).default([]),
  internalApis: z.array(z.string()).default([]),
  externalApis: z.array(z.string()).default([]),
  status: z.enum(API_COMMUNICATION_STATUSES).default('CONFIRMED'),
});

export type ApiCommunicationArchitecture = z.infer<
  typeof ApiCommunicationArchitectureZodSchema
>;

// ============================================================================
// 5. TECHNOLOGY STACK
// ============================================================================

export const TECHNOLOGY_SELECTION_STATUSES = [
  'REQUIRED',
  'CONSTRAINED',
  'SELECTED',
  'CANDIDATE',
  'UNDECIDED',
] as const;

export type TechnologySelectionStatus = (typeof TECHNOLOGY_SELECTION_STATUSES)[number];

export const TECHNOLOGY_CATEGORIES = [
  'PROGRAMMING_LANGUAGE',
  'RUNTIME',
  'FRONTEND_FRAMEWORK',
  'BACKEND_FRAMEWORK',
  'DATABASE',
  'ORM_DATA_ACCESS',
  'UI_FRAMEWORK',
  'BUILD_SYSTEM',
  'PACKAGE_MANAGER',
  'INFRASTRUCTURE_PLATFORM',
  'DEPLOYMENT_TECHNOLOGY',
  'TESTING_TECHNOLOGY',
  'OBSERVABILITY_TECHNOLOGY',
  'OTHER',
] as const;

export type TechnologyCategory = (typeof TECHNOLOGY_CATEGORIES)[number];

export const TechnologyChoiceItemZodSchema = z.object({
  category: z.enum(TECHNOLOGY_CATEGORIES),
  name: z.string().min(1, 'technology name cannot be empty'),
  selectionStatus: z.enum(TECHNOLOGY_SELECTION_STATUSES),
  versionConstraint: z.string().optional(),
  source: z.string().min(1, 'source cannot be empty'),
  affectedRequirements: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});

export type TechnologyChoiceItem = z.infer<typeof TechnologyChoiceItemZodSchema>;

// ============================================================================
// 6. PLATFORM & ENVIRONMENT
// ============================================================================

export const PlatformEnvironmentZodSchema = z.object({
  targetOs: z.array(z.string()).default([]),
  targetDevices: z.array(z.string()).default([]),
  browserRequirements: z.array(z.string()).default([]),
  mobileRequirements: z.array(z.string()).default([]),
  desktopRequirements: z.array(z.string()).default([]),
  serverEnvironment: z.array(z.string()).default([]),
  cloudOnPremRequirements: z.array(z.string()).default([]),
  supportedRuntimeVersions: z.array(z.string()).default([]),
});

export type PlatformEnvironment = z.infer<typeof PlatformEnvironmentZodSchema>;

// ============================================================================
// 7. SECURITY ARCHITECTURE
// ============================================================================

export const SECURITY_ARCHITECTURE_STATUSES = [
  'CONFIRMED',
  'CANDIDATE',
  'PENDING_DECISION',
  'NOT_APPLICABLE',
] as const;

export type SecurityArchitectureStatus = (typeof SECURITY_ARCHITECTURE_STATUSES)[number];

export const SecurityArchitectureZodSchema = z.object({
  authenticationArchitecture: z.string().optional(),
  authorizationModel: z.string().optional(),
  identityProvider: z.string().optional(),
  secretsHandling: z.array(z.string()).default([]),
  encryptionRequirements: z.array(z.string()).default([]),
  trustBoundaries: z.array(z.string()).default([]),
  dataIsolation: z.array(z.string()).default([]),
  auditRequirements: z.array(z.string()).default([]),
  status: z.enum(SECURITY_ARCHITECTURE_STATUSES).default('CONFIRMED'),
});

export type SecurityArchitecture = z.infer<typeof SecurityArchitectureZodSchema>;

// ============================================================================
// 8. INTEGRATIONS
// ============================================================================

export const INTEGRATION_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'BIDIRECTIONAL'] as const;
export type IntegrationDirection = (typeof INTEGRATION_DIRECTIONS)[number];

export const INTEGRATION_DEPENDENCIES = ['REQUIRED', 'OPTIONAL'] as const;
export type IntegrationDependency = (typeof INTEGRATION_DEPENDENCIES)[number];

export const INTEGRATION_STATUSES = ['CONFIRMED', 'CANDIDATE', 'PENDING_DECISION'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const ArchitectureIntegrationItemZodSchema = z.object({
  integrationId: z.string().min(1, 'integrationId cannot be empty'),
  system: z.string().min(1, 'system name cannot be empty'),
  purpose: z.string().min(1, 'purpose cannot be empty'),
  protocol: z.string().optional(),
  direction: z.enum(INTEGRATION_DIRECTIONS).default('BIDIRECTIONAL'),
  dependency: z.enum(INTEGRATION_DEPENDENCIES).default('REQUIRED'),
  status: z.enum(INTEGRATION_STATUSES).default('CONFIRMED'),
  source: z.string().min(1, 'source cannot be empty'),
  affectedRequirements: z.array(z.string()).default([]),
});

export type ArchitectureIntegrationItem = z.infer<
  typeof ArchitectureIntegrationItemZodSchema
>;

// ============================================================================
// 9. DEPLOYMENT ARCHITECTURE
// ============================================================================

export const DEPLOYMENT_ARCHITECTURE_STATUSES = [
  'CONFIRMED',
  'CANDIDATE',
  'PENDING_DECISION',
  'NOT_APPLICABLE',
] as const;

export type DeploymentArchitectureStatus = (typeof DEPLOYMENT_ARCHITECTURE_STATUSES)[number];

export const DeploymentArchitectureZodSchema = z.object({
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
  status: z.enum(DEPLOYMENT_ARCHITECTURE_STATUSES).default('CONFIRMED'),
});

export type DeploymentArchitecture = z.infer<typeof DeploymentArchitectureZodSchema>;

// ============================================================================
// 10. ARCHITECTURAL DECISION MODEL
// ============================================================================

export const ARCHITECTURE_DECISION_AREAS = [
  'STYLE',
  'COMPONENTS',
  'DATA',
  'API',
  'TECH_STACK',
  'PLATFORM',
  'SECURITY',
  'INTEGRATION',
  'DEPLOYMENT',
] as const;

export type ArchitectureDecisionArea = (typeof ARCHITECTURE_DECISION_AREAS)[number];

export const ARCHITECTURE_DECISION_STATUSES = [
  'DECIDED',
  'CONSTRAINED',
  'CANDIDATE',
  'PENDING_DECISION',
  'NOT_APPLICABLE',
] as const;

export type ArchitectureDecisionStatus = (typeof ARCHITECTURE_DECISION_STATUSES)[number];

export const ArchitectureDecisionItemZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  decisionArea: z.enum(ARCHITECTURE_DECISION_AREAS),
  question: z.string().min(1, 'question cannot be empty'),
  status: z.enum(ARCHITECTURE_DECISION_STATUSES),
  selectedOption: z.string().optional(),
  candidateOptions: z.array(z.string()).default([]),
  rationale: z.string().optional(),
  affectedRequirements: z.array(z.string()).default([]),
  consequences: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  authority: z.string().min(1, 'authority cannot be empty'),
  revisionBinding: z.number().int().nonnegative().default(1),
});

export type ArchitectureDecisionItem = z.infer<typeof ArchitectureDecisionItemZodSchema>;

// ============================================================================
// 11. HUMAN DECISION BOUNDARY
// ============================================================================

export const ArchitectureHumanDecisionZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedRequirements: z.array(z.string()).default([]),
  affectedArchitectureAreas: z.array(z.string()).default([]),
  availableOptions: z.array(z.string()).default([]),
  consequences: z.array(z.string()).default([]),
  authority: z.literal(Actor.USER).default(Actor.USER),
  status: z.literal('PENDING_DECISION').default('PENDING_DECISION'),
});

export type ArchitectureHumanDecision = z.infer<
  typeof ArchitectureHumanDecisionZodSchema
>;

// ============================================================================
// 12. REQUIREMENTS TRACEABILITY
// ============================================================================

export const ArchitectureTraceabilityLinkZodSchema = z.object({
  requirementId: z.string().min(1, 'requirementId cannot be empty'),
  requirementTitle: z.string().min(1, 'requirementTitle cannot be empty'),
  addressedByComponents: z.array(z.string()).default([]),
  addressedByDecisions: z.array(z.string()).default([]),
  addressedByTechnologies: z.array(z.string()).default([]),
});

export type ArchitectureTraceabilityLink = z.infer<
  typeof ArchitectureTraceabilityLinkZodSchema
>;

// ============================================================================
// 13. MASTER ARCHITECTURE / TECHNOLOGY REVISION
// ============================================================================

export const ProjectArchitectureRevisionZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  architectureRevision: z
    .number()
    .int()
    .positive('architectureRevision must be a positive integer'),
  sourceRequirementsRevision: z
    .number()
    .int()
    .positive('sourceRequirementsRevision must be a positive integer'),
  sourceRequirementsFingerprint: z
    .string()
    .min(1, 'sourceRequirementsFingerprint cannot be empty'),
  sourceDiscoveryRevision: z
    .number()
    .int()
    .positive('sourceDiscoveryRevision must be a positive integer'),
  sourceDiscoveryFingerprint: z
    .string()
    .min(1, 'sourceDiscoveryFingerprint cannot be empty'),
  isStale: z.boolean().default(false),
  architecturalStyle: ArchitecturalStyleDefinitionZodSchema,
  systemComponents: z.array(SystemComponentZodSchema).default([]),
  dataArchitecture: DataArchitectureZodSchema,
  apiCommunicationArchitecture: ApiCommunicationArchitectureZodSchema,
  technologyStack: z.array(TechnologyChoiceItemZodSchema).default([]),
  platformEnvironment: PlatformEnvironmentZodSchema,
  securityArchitecture: SecurityArchitectureZodSchema,
  integrations: z.array(ArchitectureIntegrationItemZodSchema).default([]),
  deploymentArchitecture: DeploymentArchitectureZodSchema,
  decisions: z.array(ArchitectureDecisionItemZodSchema).default([]),
  pendingHumanDecisions: z.array(ArchitectureHumanDecisionZodSchema).default([]),
  requirementsTraceability: z.array(ArchitectureTraceabilityLinkZodSchema).default([]),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type ProjectArchitectureRevision = z.infer<
  typeof ProjectArchitectureRevisionZodSchema
>;

// ============================================================================
// 14. INPUT CONTRACT
// ============================================================================

export const ArchitectureTechnologyInputZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalDecisions: z.array(ArchitectureDecisionItemZodSchema).optional(),
});

export type ArchitectureTechnologyInput = z.infer<
  typeof ArchitectureTechnologyInputZodSchema
>;
