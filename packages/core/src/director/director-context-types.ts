/**
 * Director Context Synchronization Types (Phase 9 TASK-P9-02)
 *
 * Establishes the strongly typed domain model for ChatGPT Director
 * context synchronization snapshots with authoritative AIDM state.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. CONTEXT ONLY: This synchronization layer is purely derived/read-oriented.
 * 2. It must NOT become a second source of truth.
 * 3. Authoritative AIDM state strictly wins in any divergence.
 * 4. Never mutates requirements, decisions, Task DAG, approvals, clarifications, Git, or OS.
 * 5. Does NOT grant development authorization (isDevelopmentAuthorized() remains unchanged).
 * 6. Does NOT invoke Antigravity or autonomous iteration loops.
 */

import { z } from 'zod';
import { DirectorSessionIdZodSchema } from './director-types.js';

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const DIRECTOR_CONTEXT_PROTOCOL_VERSION = 'P9-02';
export const DIRECTOR_CONTEXT_SCHEMA_VERSION = 1;

export const SYNC_STATUSES = [
  'INITIAL',
  'UNCHANGED',
  'CHANGED',
  'STALE',
  'INCOMPLETE',
] as const;

export type DirectorSyncStatus = (typeof SYNC_STATUSES)[number];

// ============================================================================
// 2. COMPONENT SECTIONS
// ============================================================================

export interface SyncSectionMetadata {
  readonly synchronized: boolean;
  readonly available: boolean;
  readonly isStale: boolean;
  readonly revision?: number | string | null;
  readonly fingerprint: string;
  readonly error?: string | null;
}

export interface DirectorProjectStatusSection {
  readonly initialized: boolean;
  readonly lifecycleState: string;
  readonly isCompleted: boolean;
  readonly isBlocked: boolean;
  readonly blockedReason?: string | null;
  readonly activeTaskId?: string | null;
  readonly lastCheckpoint?: string | null;
}

export interface DirectorRequirementsSection {
  readonly total: number;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly authority: string;
    readonly status: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
}

export interface DirectorDecisionsSection {
  readonly total: number;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly authority: string;
    readonly status: string;
    readonly rationale?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
}

export interface DirectorCurrentTaskSection {
  readonly hasActiveTask: boolean;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly description: string;
    readonly hierarchyLevel: string;
    readonly status: string;
    readonly priority: string;
    readonly riskLevel: string;
    readonly dependencies: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    readonly traceabilitySources: readonly string[];
    readonly attempt: number;
    readonly maxAttempts: number;
  } | null;
}

export interface DirectorTaskListSection {
  readonly total: number;
  readonly topologicalOrder: readonly string[];
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
    readonly hierarchyLevel: string;
    readonly dependencies: readonly string[];
    readonly priority: string;
  }>;
}

export interface DirectorContextEngineSection {
  readonly isAvailable: boolean;
  readonly hasL0Cache: boolean;
  readonly inspectedPaths: ReadonlyArray<{
    readonly sourcePath: string;
    readonly layer: string;
    readonly fileHash: string;
    readonly isStale: boolean;
  }>;
}

export interface DirectorEvidenceSection {
  readonly totalAvailable: number;
  readonly items: ReadonlyArray<{
    readonly evidenceId: string;
    readonly taskId: string;
    readonly evidenceType: string;
    readonly exitCode?: number;
    readonly command?: string;
    readonly isSystemVerified: boolean;
  }>;
}

export interface DirectorHistorySection {
  readonly totalEvents: number;
  readonly recentEvents: ReadonlyArray<{
    readonly eventId: string;
    readonly timestamp: string;
    readonly eventType: string;
    readonly actor: string;
    readonly taskId?: string | null;
  }>;
}

export interface DirectorGitSection {
  readonly isGitRepository: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly workingTreeClean: boolean | null;
  readonly totalAcceptedCheckpoints: number;
  readonly lastCheckpointId?: string | null;
}

export interface DirectorDiscoverySection {
  readonly isDiscovered: boolean;
  readonly projectName: string;
  readonly apparentPurposeClassification: string;
  readonly technologyStack: ReadonlyArray<{ readonly name: string; readonly version?: string }>;
  readonly entryPointsCount: number;
  readonly unknownsCount: number;
  readonly contradictionsCount: number;
}

export interface DirectorClarificationSection {
  readonly hasActiveSession: boolean;
  readonly sessionId?: string | null;
  readonly status?: string | null;
  readonly totalCount: number;
  readonly resolvedCount: number;
  readonly blockingOpenCount: number;
  readonly hasUnresolvedBlocking: boolean;
}

export interface DirectorApprovalSection {
  readonly hasApprovalPackage: boolean;
  readonly packageId?: string | null;
  readonly revision?: number | null;
  readonly status?: string | null;
  readonly isReadyForApproval: boolean;
  readonly isExplicitlyApproved: boolean;
  readonly approvedAt?: string | null;
}

export interface DirectorAuthorizationSection {
  /**
   * Authoritative development authorization state.
   * INVARIANT: strictly reported, never modified or granted by Director sync.
   */
  readonly isDevelopmentAuthorized: boolean;
  readonly authoritySource: 'PRODUCT_OWNER';
  readonly requiresHumanApproval: true;
}

// ============================================================================
// 3. SYNCHRONIZED CONTEXT SNAPSHOT
// ============================================================================

export interface DirectorContextSections {
  readonly projectStatus: DirectorProjectStatusSection;
  readonly requirements: DirectorRequirementsSection;
  readonly decisions: DirectorDecisionsSection;
  readonly currentTask: DirectorCurrentTaskSection;
  readonly taskList: DirectorTaskListSection;
  readonly contextEngine: DirectorContextEngineSection;
  readonly evidence: DirectorEvidenceSection;
  readonly history: DirectorHistorySection;
  readonly git: DirectorGitSection;
  readonly discovery: DirectorDiscoverySection;
  readonly clarification: DirectorClarificationSection;
  readonly approval: DirectorApprovalSection;
  readonly authorization: DirectorAuthorizationSection;
}

export interface DirectorContextSnapshot {
  readonly directorSessionId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly synchronizedAt: string;
  readonly syncStatus: DirectorSyncStatus;
  readonly isComplete: boolean;
  readonly unavailableSections: readonly string[];
  readonly staleSections: readonly string[];
  readonly sectionMetadata: Readonly<Record<keyof DirectorContextSections, SyncSectionMetadata>>;
  readonly logicalFingerprint: string;
  readonly priorFingerprint?: string | null;
  readonly sections: DirectorContextSections;
  /** Explicitly marks this snapshot as derived, read-only data */
  readonly isDerived: true;
}

// ============================================================================
// 4. INPUT SCHEMAS & TYPES
// ============================================================================

export interface DirectorContextSyncInput {
  readonly directorSessionId?: string;
  readonly workspaceRoot?: string;
  readonly projectId?: string;
  readonly priorFingerprint?: string;
  readonly targetPaths?: readonly string[];
  readonly evidenceLimit?: number;
  readonly historyLimit?: number;
}

export const DirectorContextSyncInputZodSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  priorFingerprint: z.string().optional(),
  targetPaths: z.array(z.string().min(1)).optional(),
  evidenceLimit: z.number().int().positive().max(100).optional().default(20),
  historyLimit: z.number().int().positive().max(100).optional().default(20),
}).strict();
