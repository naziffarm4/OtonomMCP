/**
 * Autonomous E2E Lifecycle Harness Types
 *
 * Types for the Phase 7 autonomous development lifecycle coordinator and harness.
 * Coordinates all Phase 1-6 subsystems according to the authoritative FSM
 * and process specifications in Technical Discovery Section 2 & 5.
 */

import { type LifecycleState, type TaskLoopState } from '../lifecycle.js';
import { type TaskDefinitionInput } from '../task-engine/task-types.js';
import { type PolicyEngine } from '../policy/policy-engine.js';
import { type GitAdapter } from '../adapters/git-adapter.js';
import { type ExecutorPort } from '../executor-bridge/executor-port.js';
import { type EvidenceCollector } from '../evidence/evidence-collector.js';
import { type SystemVerifiedEvidence } from '../evidence/evidence-types.js';
import { type QAReviewEngine } from '../qa-review/qa-review-engine.js';
import { type ReviewResult, type AcceptanceCriterionInput } from '../qa-review/qa-review-types.js';
import { type RecoveryGitRollbackIntegrator } from '../recovery/recovery-git-integrator.js';
import { type RecoveryDecision } from '../recovery/types.js';
import { type UIAdapter } from '../adapters/ui-adapter.js';
import { type KnownGoodCheckpoint } from '../git/git-checkpoint-manager.js';

// ============================================================================
// 1. REQUIREMENTS & DECISIONS CONTRACTS (DEC-001 & Section 1)
// ============================================================================

export interface AutonomousRequirement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly authority: 'USER';
  readonly status: 'LOCKED';
  readonly acceptanceCriteria?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AutonomousDecision {
  readonly id: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly authority: 'DIRECTOR';
}

// ============================================================================
// 2. HARNESS CONFIGURATION & OPTIONS
// ============================================================================

export interface AutonomousHierarchyNode {
  readonly task_id: string;
  readonly title: string;
  readonly hierarchy_level: 'EPIC' | 'FEATURE';
  readonly traceability_sources: readonly string[];
  readonly description?: string;
  readonly parent_feature_id?: string | null;
}

export interface AutonomousHarnessOptions {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly requirements: readonly AutonomousRequirement[];
  readonly tasks: readonly TaskDefinitionInput[];
  readonly features?: readonly AutonomousHierarchyNode[];
  readonly epics?: readonly AutonomousHierarchyNode[];
  readonly decisions?: readonly AutonomousDecision[];
  readonly taskCriteria?: ReadonlyMap<string, readonly AcceptanceCriterionInput[]>;
  readonly policyEngine: PolicyEngine;
  readonly gitAdapter: GitAdapter;
  readonly executorPort: ExecutorPort;
  readonly evidenceCollector: EvidenceCollector;
  readonly qaReviewEngine: QAReviewEngine;
  readonly recoveryIntegrator?: RecoveryGitRollbackIntegrator;
  readonly uiAdapter?: UIAdapter;
  readonly maxRetriesPerTask?: number;
  readonly humanApprovalToken?: string;
}

// ============================================================================
// 3. EXECUTION SUMMARY & OUTCOMES
// ============================================================================

export interface TaskExecutionAttempt {
  readonly attemptNumber: number;
  readonly instructionId: string;
  readonly evidence: readonly SystemVerifiedEvidence[];
  readonly reviewResult: ReviewResult;
  readonly recoveryDecision?: RecoveryDecision;
  readonly durationMs: number;
}

export interface TaskExecutionSummary {
  readonly taskId: string;
  readonly attempts: readonly TaskExecutionAttempt[];
  readonly finalStatus: 'COMPLETED' | 'FAILED' | 'REJECTED';
  readonly preFlightCheckpoint?: KnownGoodCheckpoint;
  readonly postFlightCheckpoint?: KnownGoodCheckpoint;
  readonly totalAttempts: number;
}

export interface AutonomousHarnessResult {
  readonly success: boolean;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly finalMacroState: LifecycleState;
  readonly completedTasks: readonly string[];
  readonly failedTasks: readonly string[];
  readonly taskSummaries: ReadonlyMap<string, TaskExecutionSummary>;
  readonly durationMs: number;
  readonly error?: string;
}
