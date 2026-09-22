/**
 * System Lifecycle State Definitions for AI Development Manager.
 * 
 * Defines the macro lifecycle stages of an AIDM project session as specified
 * in the Authoritative AIDM Technical Discovery (Section 2 & Section 33):
 * 
 * Macro Process:
 * INITIALIZING
 *   ↓
 * REQUIREMENTS_INGESTION
 *   ↓
 * ARCHITECTURE_SPEC
 *   ↓
 * TASK_DECOMPOSITION
 *   ↓
 * TASK_SELECTION
 *   ↓
 * TASK_LOOP (nested process)
 *   ↓
 * PROJECT_COMPLETE
 * 
 * Interruption & Resume:
 * TASK_LOOP → BLOCKED_ON_HUMAN → RESUME_EXACT_BLOCKED_POINT → TASK_LOOP
 */

// ============================================================================
// 1. TOP-LEVEL MACRO LIFECYCLE STATES
// ============================================================================

export const LifecycleState = {
  INITIALIZING: 'INITIALIZING',
  REQUIREMENTS_INGESTION: 'REQUIREMENTS_INGESTION',
  ARCHITECTURE_SPEC: 'ARCHITECTURE_SPEC',
  TASK_DECOMPOSITION: 'TASK_DECOMPOSITION',
  TASK_SELECTION: 'TASK_SELECTION',
  TASK_LOOP: 'TASK_LOOP',
  BLOCKED_ON_HUMAN: 'BLOCKED_ON_HUMAN',
  RESUME_EXACT_BLOCKED_POINT: 'RESUME_EXACT_BLOCKED_POINT',
  PROJECT_COMPLETE: 'PROJECT_COMPLETE',
} as const;

export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

export const LIFECYCLE_STATES = Object.values(LifecycleState) as readonly LifecycleState[];

export const INITIALIZING = LifecycleState.INITIALIZING;
export const REQUIREMENTS_INGESTION = LifecycleState.REQUIREMENTS_INGESTION;
export const ARCHITECTURE_SPEC = LifecycleState.ARCHITECTURE_SPEC;
export const TASK_DECOMPOSITION = LifecycleState.TASK_DECOMPOSITION;
export const TASK_SELECTION = LifecycleState.TASK_SELECTION;
export const TASK_LOOP = LifecycleState.TASK_LOOP;
export const BLOCKED_ON_HUMAN = LifecycleState.BLOCKED_ON_HUMAN;
export const RESUME_EXACT_BLOCKED_POINT = LifecycleState.RESUME_EXACT_BLOCKED_POINT;
export const PROJECT_COMPLETE = LifecycleState.PROJECT_COMPLETE;

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

// Aliases for compatibility
export const SystemState = LifecycleState;
export type SystemState = LifecycleState;

// ============================================================================
// 2. NESTED TASK_LOOP PROCESS STATES (Nested Sub-FSM)
// ============================================================================

/**
 * Detailed process states within the TASK_LOOP lifecycle, as documented in
 * Technical Discovery Section 2 (Process Architecture & State Machine).
 */
export const TaskLoopState = {
  TASK_SELECTION: 'TASK_SELECTION',
  PRE_FLIGHT_CHECKPOINT: 'PRE_FLIGHT_CHECKPOINT',
  INSTRUCT_ANTIGRAVITY: 'INSTRUCT_ANTIGRAVITY',
  IMPLEMENTATION: 'IMPLEMENTATION',
  EVIDENCE_COLLECTION: 'EVIDENCE_COLLECTION',
  ORCHESTRATOR_EVIDENCE_VALIDATION: 'ORCHESTRATOR_EVIDENCE_VALIDATION',
  CHATGPT_REVIEW: 'CHATGPT_REVIEW',
  ANALYZE_EVIDENCE: 'ANALYZE_EVIDENCE',
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  REQUEST_CONTEXT: 'REQUEST_CONTEXT',
  ROOT_CAUSE_ANALYSIS: 'ROOT_CAUSE_ANALYSIS',
  RETRY_STRATEGY_CHECK: 'RETRY_STRATEGY_CHECK',
  POST_FLIGHT_COMMIT: 'POST_FLIGHT_COMMIT',
  CHECK_DAG_COMPLETION: 'CHECK_DAG_COMPLETION',
  PROJECT_COMPLETE_VALIDATION: 'PROJECT_COMPLETE_VALIDATION',
  BLOCKED_ON_HUMAN: 'BLOCKED_ON_HUMAN',
} as const;

export type TaskLoopState = (typeof TaskLoopState)[keyof typeof TaskLoopState];

export const TASK_LOOP_STATES = Object.values(TaskLoopState) as readonly TaskLoopState[];

export function isTaskLoopState(value: unknown): value is TaskLoopState {
  return typeof value === 'string' && (TASK_LOOP_STATES as readonly string[]).includes(value);
}
