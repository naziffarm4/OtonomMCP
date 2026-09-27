/**
 * Task Decomposition & Ingestion Protocol Types (Phase 12 TASK-P12-01)
 *
 * Establishes the authoritative, typed domain model for transforming an
 * approved development plan and candidate tasks into validated, persistent TaskDefinition[]
 * in SpecStore and TaskDagEngine.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Decomposition requires explicit Product Owner approval: isDevelopmentAuthorized() === true.
 * 2. Director output != authoritative tasks; Director proposals are untrusted candidate data.
 * 3. Static decomposition only: creates a complete initial DAG, zero mid-flight mutation.
 * 4. Deterministic task identities: identical approved input + decompositionRevision => identical task IDs.
 * 5. Idempotent ingestion: repeated calls with identical input are safe no-ops.
 * 6. Atomic persistence: zero partial ingestion; DAG validation must succeed before SpecStore persistence.
 * 7. Zero second authority: respects SpecStore, TaskDagEngine, DurableStateManager, and ApprovalStore.
 * 8. Zero task execution: does NOT invoke Antigravity or spawn any process.
 */

import { z } from 'zod';
import type { TaskDefinition, TaskHierarchyLevel, TaskPriority } from '../task-engine/task-types.js';
import type { RiskLevel } from '../risk.js';

export const TASK_DECOMPOSITION_PROTOCOL_VERSION = 'P12-02';
export const TASK_DECOMPOSITION_SCHEMA_VERSION = 1;

// ============================================================================
// 1. CANDIDATE TASK PROPOSAL CONTRACT
// ============================================================================

export interface CandidateTaskScope {
  readonly analysisScope?: readonly string[];
  readonly implementationScope?: readonly string[];
  readonly targetFiles?: readonly string[];
}

export interface CandidateTaskProposal {
  readonly taskId?: string;
  readonly semanticKey?: string;
  readonly parentFeatureId?: string;
  readonly title: string;
  readonly description: string;
  readonly hierarchyLevel?: TaskHierarchyLevel;
  readonly priority?: TaskPriority;
  readonly riskLevel?: RiskLevel;
  readonly dependencies?: readonly string[];
  readonly traceabilitySources?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly scope?: CandidateTaskScope;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 2. DECOMPOSITION INPUT & RESULT
// ============================================================================

export interface DecomposePlanInput {
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly directorSessionId: string;
  readonly contextFingerprint: string;
  readonly approvalPackageId: string;
  readonly approvalPackageRevision: number;
  readonly understandingRevision?: number | null;
  readonly decompositionRevision?: number;
  readonly candidateTasks?: readonly CandidateTaskProposal[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DecomposePlanResult {
  readonly isSuccess: boolean;
  readonly projectId: string;
  readonly approvalPackageId: string;
  readonly approvalPackageRevision: number;
  readonly contextFingerprint: string;
  readonly decompositionRevision: number;
  readonly tasksCreated: readonly TaskDefinition[];
  readonly isIdempotentReplay: boolean;
  readonly topologicalOrder: readonly string[];
  readonly message: string;
}

// ============================================================================
// 3. ZOD VALIDATION SCHEMAS
// ============================================================================

export const CandidateTaskScopeZodSchema = z.object({
  analysisScope: z.array(z.string()).optional(),
  implementationScope: z.array(z.string()).optional(),
  targetFiles: z.array(z.string()).optional(),
});

export const CandidateTaskProposalZodSchema = z.object({
  taskId: z.string().optional(),
  semanticKey: z.string().optional(),
  parentFeatureId: z.string().optional(),
  title: z.string({ message: 'title is required' }).trim().min(1, 'title cannot be empty'),
  description: z.string({ message: 'description is required' }).trim().min(1, 'description cannot be empty'),
  hierarchyLevel: z.enum(['EPIC', 'FEATURE', 'TASK', 'SUBTASK'] as const).optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).optional(),
  riskLevel: z.enum(['SAFE', 'CAUTION', 'DANGEROUS', 'CRITICAL'] as const).optional(),
  dependencies: z.array(z.string().trim().min(1)).optional(),
  traceabilitySources: z.array(z.string().trim().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
  scope: CandidateTaskScopeZodSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const DecomposePlanInputZodSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: z.string({ message: 'directorSessionId is required' }).min(1),
  contextFingerprint: z.string({ message: 'contextFingerprint is required' }).min(1),
  approvalPackageId: z.string({ message: 'approvalPackageId is required' }).min(1),
  approvalPackageRevision: z.number({ message: 'approvalPackageRevision is required' }).int().positive(),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
  decompositionRevision: z.number().int().positive().optional().default(1),
  candidateTasks: z.array(CandidateTaskProposalZodSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
