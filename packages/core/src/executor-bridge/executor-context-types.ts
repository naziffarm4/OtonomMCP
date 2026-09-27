/**
 * Authoritative Executor Context Package Contracts & Types
 *
 * Defines the strongly typed domain model, Zod validation schemas,
 * and canonical hashing algorithms for the authoritative context-to-executor
 * packaging pipeline.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. AUTHORITATIVE SOURCES ONLY: All packaged information is derived exclusively
 *    from authoritative AIDM stores (SpecStore, ContextEngine, ApprovalStore, GitPort, Recovery).
 * 2. ZERO EXECUTOR TRUST: Does not rely on executor claims; packages ground truth.
 * 3. DETERMINISTIC IDENTIFIERS: packageId is derived deterministically from canonical SHA-256.
 * 4. FINITE TOKEN BUDGET: Strictly bounds payload size with prioritized truncation.
 * 5. IMMUTABILITY & AUDITABILITY: Produces frozen, content-addressed, auditable context packages.
 */

import { z } from 'zod';
import * as crypto from 'node:crypto';
import type { AcceptanceCriterionSpec } from './execution-request-types.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const EXECUTOR_CONTEXT_PROTOCOL_VERSION = '1.0.0';
export const EXECUTOR_CONTEXT_SCHEMA_VERSION = 1;

export const DEFAULT_EXECUTOR_CONTEXT_TOKEN_BUDGET = 16_000;
export const MIN_EXECUTOR_CONTEXT_TOKEN_BUDGET = 1_000;
export const MAX_EXECUTOR_CONTEXT_TOKEN_BUDGET = 64_000;

// ============================================================================
// 2. SUB-SECTION MODELS
// ============================================================================

export interface TaskContextDependency {
  readonly taskId: string;
  readonly title?: string;
  readonly status?: string;
}

export interface TaskContextPayload {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly title: string;
  readonly description: string;
  readonly hierarchyLevel: string;
  readonly priority: string;
  readonly riskLevel: string;
  readonly status: string;
  readonly targetFiles: readonly string[];
  readonly analysisScope: readonly string[];
  readonly implementationScope: readonly string[];
  readonly acceptanceCriteria: readonly (string | AcceptanceCriterionSpec)[];
  readonly constraints: readonly string[];
  readonly dependencies: readonly TaskContextDependency[];
  readonly traceabilitySources: readonly string[];
}

export interface TracedRequirementContext {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly authority: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface TracedDecisionContext {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly rationale?: string;
  readonly authority: string;
  readonly status: string;
}

export interface ProjectConventionsContext {
  readonly nonGoals?: readonly string[];
  readonly architectureConstraints?: readonly string[];
  readonly targetUsers?: readonly string[];
}

export interface SpecContextPayload {
  readonly requirements: readonly TracedRequirementContext[];
  readonly decisions: readonly TracedDecisionContext[];
  readonly projectConventions: ProjectConventionsContext;
}

export interface FileStructureContext {
  readonly path: string;
  readonly layer: 'L0' | 'L1';
  readonly sha256: string;
  readonly size: number;
  readonly exports?: readonly string[];
  readonly imports?: readonly string[];
  readonly interfaces?: readonly string[];
  readonly typeDefinitions?: readonly string[];
  readonly signatures?: readonly string[];
  readonly summary?: string;
  readonly isStale?: boolean;
}

export interface ScopeSummaryContext {
  readonly path: string;
  readonly layer: 'L0' | 'L1';
  readonly sha256: string;
  readonly size: number;
  readonly summary?: string;
}

export interface CodeContextPayload {
  readonly targetFileStructures: readonly FileStructureContext[];
  readonly analysisScopeSummaries: readonly ScopeSummaryContext[];
}

export interface TechnologyStackContext {
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly runtime?: string;
  readonly packageManager?: string;
}

export interface RepositoryStateContext {
  readonly baseCommit: string;
  readonly branch: string | null;
  readonly isClean: boolean;
}

export interface ProjectBaselinePayload {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly technologyStack: TechnologyStackContext;
  readonly repositoryState: RepositoryStateContext;
}

export interface PriorFailureDiagnosisContext {
  readonly category?: string;
  readonly diagnosisCode?: string;
  readonly reason?: string;
  readonly prescribedAction?: string;
}

export interface RecoveryContextPayload {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly isRetry: boolean;
  readonly parentTaskId?: string;
  readonly rootTaskId?: string;
  readonly priorFailureDiagnosis?: PriorFailureDiagnosisContext;
}

export interface ContextBudgetPayload {
  readonly estimatedTokens: number;
  readonly maxTokenBudget: number;
  readonly isTruncated: boolean;
  readonly sectionTokenBreakdown: Readonly<Record<string, number>>;
}

export interface ContextSourceAuditRecord {
  readonly sourceName: string;
  readonly available: boolean;
  readonly recordCount?: number;
  readonly notes?: string;
}

// ============================================================================
// 3. EXECUTOR CONTEXT PACKAGE CONTRACT
// ============================================================================

export interface ExecutorContextPackage {
  /** Deterministic identifier formatted as ctx-pkg-<sha256(32)> */
  readonly packageId: string;
  /** Protocol version string */
  readonly protocolVersion: string;
  /** Schema version integer */
  readonly schemaVersion: number;
  /** ISO 8601 assembly timestamp */
  readonly createdAt: string;
  /** Bound canonical project ID */
  readonly projectId: string;
  /** Target task identifier */
  readonly taskId: string;
  /** Monotonic task revision */
  readonly taskRevision: number;
  /** Associated ExecutionRequest ID if bound to a specific request */
  readonly requestId?: string;
  /** Logical fingerprint of authoritative context at assembly time */
  readonly contextFingerprint: string;
  /** Deterministic content hash across canonical package contents */
  readonly contentHash: string;
  /** Audit log of authoritative data sources queried */
  readonly sources: readonly ContextSourceAuditRecord[];
  /** Authoritative task definition and criteria */
  readonly taskContext: TaskContextPayload;
  /** Authoritative specification requirements, decisions, conventions */
  readonly specContext: SpecContextPayload;
  /** Authoritative codebase L0/L1 structural contracts */
  readonly codeContext: CodeContextPayload;
  /** Authoritative project environment, tech stack, and Git baseline */
  readonly projectBaseline: ProjectBaselinePayload;
  /** Recovery, retry attempt, and corrective lineage context (if applicable) */
  readonly recoveryContext?: RecoveryContextPayload;
  /** Token budget and bounds tracking */
  readonly budget: ContextBudgetPayload;
}

// ============================================================================
// 4. INPUT SCHEMAS & CONTRACTS
// ============================================================================

export interface BuildExecutorContextInput {
  readonly taskId: string;
  readonly taskRevision?: number;
  readonly projectId?: string;
  readonly requestId?: string;
  readonly directorSessionId?: string;
  readonly contextFingerprint?: string;
  readonly targetFiles?: readonly string[];
  readonly analysisScope?: readonly string[];
  readonly implementationScope?: readonly string[];
  readonly maxTokenBudget?: number;
  readonly includeL1Structure?: boolean;
  readonly includeSpecDetails?: boolean;
  readonly includeBaseline?: boolean;
  readonly includeRecovery?: boolean;
  readonly workingDirectory?: string;
}

export interface ContextPackageValidationResult {
  readonly isValid: boolean;
  readonly packageId?: string;
  readonly isStale: boolean;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 5. ZOD SCHEMAS
// ============================================================================

export const TaskContextDependencyZodSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().optional(),
  status: z.string().optional(),
});

export const TaskContextPayloadZodSchema = z.object({
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string(),
  hierarchyLevel: z.string(),
  priority: z.string(),
  riskLevel: z.string(),
  status: z.string(),
  targetFiles: z.array(z.string()),
  analysisScope: z.array(z.string()),
  implementationScope: z.array(z.string()),
  acceptanceCriteria: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  constraints: z.array(z.string()),
  dependencies: z.array(TaskContextDependencyZodSchema),
  traceabilitySources: z.array(z.string()),
});

export const TracedRequirementContextZodSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  authority: z.string(),
  acceptanceCriteria: z.array(z.string()).optional(),
});

export const TracedDecisionContextZodSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  rationale: z.string().optional(),
  authority: z.string(),
  status: z.string(),
});

export const ProjectConventionsContextZodSchema = z.object({
  nonGoals: z.array(z.string()).optional(),
  architectureConstraints: z.array(z.string()).optional(),
  targetUsers: z.array(z.string()).optional(),
});

export const SpecContextPayloadZodSchema = z.object({
  requirements: z.array(TracedRequirementContextZodSchema),
  decisions: z.array(TracedDecisionContextZodSchema),
  projectConventions: ProjectConventionsContextZodSchema,
});

export const FileStructureContextZodSchema = z.object({
  path: z.string().min(1),
  layer: z.enum(['L0', 'L1']),
  sha256: z.string().min(1),
  size: z.number().nonnegative(),
  exports: z.array(z.string()).optional(),
  imports: z.array(z.string()).optional(),
  interfaces: z.array(z.string()).optional(),
  typeDefinitions: z.array(z.string()).optional(),
  signatures: z.array(z.string()).optional(),
  summary: z.string().optional(),
  isStale: z.boolean().optional(),
});

export const ScopeSummaryContextZodSchema = z.object({
  path: z.string().min(1),
  layer: z.enum(['L0', 'L1']),
  sha256: z.string().min(1),
  size: z.number().nonnegative(),
  summary: z.string().optional(),
});

export const CodeContextPayloadZodSchema = z.object({
  targetFileStructures: z.array(FileStructureContextZodSchema),
  analysisScopeSummaries: z.array(ScopeSummaryContextZodSchema),
});

export const TechnologyStackContextZodSchema = z.object({
  languages: z.array(z.string()).optional(),
  frameworks: z.array(z.string()).optional(),
  runtime: z.string().optional(),
  packageManager: z.string().optional(),
});

export const RepositoryStateContextZodSchema = z.object({
  baseCommit: z.string().min(1),
  branch: z.string().nullable(),
  isClean: z.boolean(),
});

export const ProjectBaselinePayloadZodSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  projectRoot: z.string().min(1),
  technologyStack: TechnologyStackContextZodSchema,
  repositoryState: RepositoryStateContextZodSchema,
});

export const PriorFailureDiagnosisContextZodSchema = z.object({
  category: z.string().optional(),
  diagnosisCode: z.string().optional(),
  reason: z.string().optional(),
  prescribedAction: z.string().optional(),
});

export const RecoveryContextPayloadZodSchema = z.object({
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  isRetry: z.boolean(),
  parentTaskId: z.string().optional(),
  rootTaskId: z.string().optional(),
  priorFailureDiagnosis: PriorFailureDiagnosisContextZodSchema.optional(),
});

export const ContextBudgetPayloadZodSchema = z.object({
  estimatedTokens: z.number().nonnegative(),
  maxTokenBudget: z.number().positive(),
  isTruncated: z.boolean(),
  sectionTokenBreakdown: z.record(z.string(), z.number()),
});

export const ContextSourceAuditRecordZodSchema = z.object({
  sourceName: z.string().min(1),
  available: z.boolean(),
  recordCount: z.number().optional(),
  notes: z.string().optional(),
});

export const ExecutorContextPackageZodSchema = z.object({
  packageId: z.string().regex(/^ctx-pkg-[a-f0-9]{24,64}$/, 'packageId must match ctx-pkg-<sha256-hex>'),
  protocolVersion: z.string().min(1),
  schemaVersion: z.literal(EXECUTOR_CONTEXT_SCHEMA_VERSION),
  createdAt: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().nonnegative(),
  requestId: z.string().optional(),
  contextFingerprint: z.string().min(1),
  contentHash: z.string().min(1),
  sources: z.array(ContextSourceAuditRecordZodSchema),
  taskContext: TaskContextPayloadZodSchema,
  specContext: SpecContextPayloadZodSchema,
  codeContext: CodeContextPayloadZodSchema,
  projectBaseline: ProjectBaselinePayloadZodSchema,
  recoveryContext: RecoveryContextPayloadZodSchema.optional(),
  budget: ContextBudgetPayloadZodSchema,
});

export const BuildExecutorContextInputZodSchema = z.object({
  taskId: z.string().min(1, 'taskId is required'),
  taskRevision: z.number().int().nonnegative().optional(),
  projectId: z.string().optional(),
  requestId: z.string().optional(),
  directorSessionId: z.string().optional(),
  contextFingerprint: z.string().optional(),
  targetFiles: z.array(z.string()).optional(),
  analysisScope: z.array(z.string()).optional(),
  implementationScope: z.array(z.string()).optional(),
  maxTokenBudget: z
    .number()
    .int()
    .min(MIN_EXECUTOR_CONTEXT_TOKEN_BUDGET)
    .max(MAX_EXECUTOR_CONTEXT_TOKEN_BUDGET)
    .optional(),
  includeL1Structure: z.boolean().optional(),
  includeSpecDetails: z.boolean().optional(),
  includeBaseline: z.boolean().optional(),
  includeRecovery: z.boolean().optional(),
  workingDirectory: z.string().optional(),
});

// ============================================================================
// 6. CANONICAL HASHING HELPERS
// ============================================================================

export function canonicalContextStringify(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalContextStringify(item)).join(',') + ']';
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const entries = sortedKeys.map(
      (k) => `${JSON.stringify(k)}:${canonicalContextStringify(obj[k])}`
    );
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Computes deterministic packageId and contentHash from canonical payload contents.
 * Format: ctx-pkg-<sha256-hex(32)>
 */
export function computeDeterministicContextPackageId(payload: {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly contextFingerprint: string;
  readonly taskContext: TaskContextPayload;
  readonly specContext: SpecContextPayload;
  readonly codeContext: CodeContextPayload;
  readonly projectBaseline: ProjectBaselinePayload;
  readonly recoveryContext?: RecoveryContextPayload;
}): { packageId: string; contentHash: string } {
  const canonicalJson = canonicalContextStringify(payload);
  const hash = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return {
    packageId: `ctx-pkg-${hash.substring(0, 32)}`,
    contentHash: hash,
  };
}
