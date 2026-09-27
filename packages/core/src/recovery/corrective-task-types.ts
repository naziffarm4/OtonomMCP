/**
 * Corrective Task Lineage & Governed DAG Augmentation Types (Phase 13 TASK-P13-03)
 *
 * Defines the authoritative contracts for creating and augmenting a task graph
 * with a governed corrective task following a P13-01 REPLAN decision.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. STRICT DECISIONS: Strategy must be RecoveryStrategy.REPLAN and replanAllowed === true.
 * 2. ZERO EXECUTOR TRUST: Rejects raw executor outcomes and caller-fabricated verification claims.
 * 3. EXPLICIT LINEAGE: Corrective task preserves provenance linking back to source task, revision, and evidence.
 * 4. DETERMINISTIC IDENTITY: Corrective task ID is deterministically derived from project, source task, revision, and evidence.
 * 5. GOVERNED DAG AUGMENTATION: Validated atomically via TaskDagEngine and persisted in SpecStore.
 * 6. NO OVERWRITE: Source failed task is NOT overwritten or reset; its failure state remains identifiable.
 * 7. NO AUTONOMOUS EXECUTION: Zero Antigravity invocation, zero ExecutionIntent/Request creation, zero continuation.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import type { TaskDefinition } from '../task-engine/task-types.js';
import { RecoveryStrategy } from './recovery-policy-types.js';
import type { FailureCategory } from './failure-diagnosis-types.js';

// ============================================================================
// 1. CORRECTIVE TASK LINEAGE METADATA CONTRACT
// ============================================================================

export interface CorrectiveTaskLineage {
  /** Lineage kind identifier */
  readonly kind: 'CORRECTIVE';
  /** Original/source task identifier that failed */
  readonly sourceTaskId: string;
  /** Authoritative revision of the source task at failure time */
  readonly sourceTaskRevision: number;
  /** Verification evidence identifier establishing the failure */
  readonly sourceEvidenceId: string;
  /** Identifier of the recovery policy decision (if available) */
  readonly sourceRecoveryDecisionId?: string;
  /** Primary failure category classified by P13-01 */
  readonly failureCategory: FailureCategory;
  /** Recovery strategy (REPLAN) */
  readonly recoveryStrategy: typeof RecoveryStrategy.REPLAN;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Provenance marker identifying the boundary that created this task */
  readonly createdFrom: 'P13-03';
  /** Timestamp when corrective task was created */
  readonly createdAt: string;
}

export const CorrectiveTaskLineageZodSchema = z.object({
  kind: z.literal('CORRECTIVE'),
  sourceTaskId: z.string().min(1),
  sourceTaskRevision: z.number().int().positive(),
  sourceEvidenceId: z.string().min(1),
  sourceRecoveryDecisionId: z.string().min(1).optional(),
  failureCategory: z.string().min(1),
  recoveryStrategy: z.literal(RecoveryStrategy.REPLAN),
  projectId: z.string().min(1),
  createdFrom: z.literal('P13-03'),
  createdAt: z.string().min(1),
});

// ============================================================================
// 2. CANDIDATE CORRECTIVE TASK PROPOSAL (OPTIONAL CALLER / DIRECTOR ADVICE)
// ============================================================================

export interface CorrectiveTaskProposal {
  /** Optional custom title override; defaults to governed explanation */
  readonly title?: string;
  /** Optional custom technical description; defaults to failure-aware description */
  readonly description?: string;
  /** Optional custom acceptance criteria augmenting standard corrective criteria */
  readonly acceptanceCriteria?: readonly string[];
  /** Optional allowed scope restricting the corrective task within approved boundary */
  readonly scope?: {
    readonly analysisScope?: readonly string[];
    readonly implementationScope?: readonly string[];
    readonly targetFiles?: readonly string[];
  };
  /** Additional dependencies for the corrective task in addition to dependencies/prerequisites */
  readonly additionalDependencies?: readonly string[];
  /** Optional priority override */
  readonly priority?: TaskDefinition['priority'];
  /** Optional custom metadata fields */
  readonly metadata?: Record<string, unknown>;
}

export const CorrectiveTaskProposalZodSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  scope: z
    .object({
      analysisScope: z.array(z.string()).optional(),
      implementationScope: z.array(z.string()).optional(),
      targetFiles: z.array(z.string()).optional(),
    })
    .optional(),
  additionalDependencies: z.array(z.string().min(1)).optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// 3. CORRECTIVE TASK CREATION INPUT CONTRACT
// ============================================================================

export interface CreateCorrectiveTaskInput {
  /** Authoritative SystemExecutionEvidence verifying the failure */
  readonly evidence: unknown;
  /** Authoritative RecoveryPolicyDecision from P13-01 */
  readonly decision?: unknown;
  /** Optional proposal from Director or caller */
  readonly proposal?: CorrectiveTaskProposal;
  /** Optional canonical project identifier for cross-project isolation assertion */
  readonly expectedProjectId?: string;
  /** Optional active Director session identifier */
  readonly directorSessionId?: string;
  /** Optional context fingerprint assertion */
  readonly contextFingerprint?: string;
  /** Optional understanding revision assertion */
  readonly understandingRevision?: number;
  /** Optional approval package revision assertion */
  readonly approvalPackageRevision?: number;
  /** Optional workspace root directory */
  readonly workspaceRoot?: string;
}

export const CreateCorrectiveTaskInputZodSchema = z.object({
  evidence: z.unknown(),
  decision: z.unknown().optional(),
  proposal: CorrectiveTaskProposalZodSchema.optional(),
  expectedProjectId: z.string().min(1).optional(),
  directorSessionId: z.string().min(1).optional(),
  contextFingerprint: z.string().min(1).optional(),
  understandingRevision: z.number().int().positive().optional(),
  approvalPackageRevision: z.number().int().positive().optional(),
  workspaceRoot: z.string().min(1).optional(),
});

// ============================================================================
// 4. CORRECTIVE TASK CREATION OUTCOME
// ============================================================================

export interface CreateCorrectiveTaskOutcome {
  /** Whether the corrective task was created/persisted or returned via idempotency */
  readonly success: boolean;
  /** Canonical project identifier */
  readonly projectId: string;
  /** Source task identifier */
  readonly sourceTaskId: string;
  /** Source task revision */
  readonly sourceTaskRevision: number;
  /** Deterministic corrective task identifier */
  readonly correctiveTaskId: string;
  /** Newly created corrective task definition */
  readonly correctiveTask: TaskDefinition;
  /** Full validated DAG topological order containing the new corrective task */
  readonly topologicalOrder: readonly string[];
  /** Total count of tasks in the augmented task graph */
  readonly totalTaskCount: number;
  /** Deterministic replan idempotency key */
  readonly replanKey: string;
  /** Whether this call was a duplicate/idempotent execution */
  readonly isDuplicate: boolean;
  /** Associated history event identifier */
  readonly historyEventId?: string;
  /** Evidence ID bound to this corrective creation */
  readonly evidenceId: string;
  /** Descriptive outcome message */
  readonly message: string;
}

// ============================================================================
// 5. DETERMINISTIC IDENTITY & IDEMPOTENCY KEY HELPERS
// ============================================================================

export interface CorrectiveIdentityComponents {
  readonly projectId: string;
  readonly sourceTaskId: string;
  readonly sourceTaskRevision: number;
  readonly evidenceId: string;
}

/**
 * Derives a deterministic corrective task ID:
 * Format: TASK-CORRECTIVE-{cleanSourceTask}-{hashSuffix}
 *
 * Example: TASK-CORRECTIVE-TASK-001-A1B2C3
 */
export function computeDeterministicCorrectiveTaskId(
  components: CorrectiveIdentityComponents
): string {
  const cleanSource = components.sourceTaskId
    .replace(/^TASK-/i, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase() || 'ROOT';

  const canonicalRaw = `${components.projectId.trim().toLowerCase()}:${components.sourceTaskId.trim().toUpperCase()}:${components.sourceTaskRevision}:${components.evidenceId.trim().toLowerCase()}`;
  const hash = crypto.createHash('sha256').update(canonicalRaw, 'utf8').digest('hex').substring(0, 6).toUpperCase();

  return `TASK-CORRECTIVE-${cleanSource}-${hash}`;
}

/**
 * Computes deterministic replan idempotency key:
 * replan-<sha256(projectId:sourceTaskId:sourceTaskRevision:evidenceId)[:16]>
 */
export function computeDeterministicReplanKey(
  components: CorrectiveIdentityComponents
): string {
  const raw = `${components.projectId}:${components.sourceTaskId}:${components.sourceTaskRevision}:${components.evidenceId}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
  return `replan-${hash}`;
}

/**
 * Computes deterministic history event ID for corrective task creation:
 * evt-corrective-<sha256(replanKey:TASK_CORRECTIVE_CREATED)[:16]>
 */
export function computeDeterministicCorrectiveEventId(replanKey: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${replanKey}:TASK_CORRECTIVE_CREATED`, 'utf8')
    .digest('hex')
    .substring(0, 16);
  return `evt-corrective-${hash}`;
}
