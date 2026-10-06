/**
 * @file director-action-types.ts
 * @description Authoritative domain models, protocol constants, risk classifications,
 * and typed action contracts for the Director Action Contract (Phase 26 P26).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Establishes TYPED ACTION PROTOCOL only (Proposal/Decision layer).
 * 2. DirectorAction NEVER conveys implementation authority (DirectorAction != Implementation Authorization).
 * 3. Product Owner approval remains the sole source of development authorization.
 * 4. DirectorAction CANNOT directly mutate SpecStore (requirements.json, decisions.json), Task DAG, or global AIDM FSM.
 * 5. Does NOT invoke Antigravity or autonomous execution loops directly.
 * 6. Actions are strictly bound to a valid, non-stale context snapshot fingerprint and active Director session.
 * 7. DECLARE_PROJECT_COMPLETE proposes completion and requests final verification; it never directly marks terminal state.
 * 8. Evidence references are citations to be independently verified by the AIDM evidence subsystem.
 */

// ============================================================================
// 1. PROTOCOL CONSTANTS
// ============================================================================

export const DIRECTOR_ACTION_PROTOCOL_VERSION = 'AIDM-DIRECTOR-ACTION-1' as const;
export const DIRECTOR_ACTION_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 2. ACTION TYPES
// ============================================================================

export const DIRECTOR_ACTION_TYPES = [
  // Understanding
  'ANALYZE_PROJECT',
  'DISCOVER_PROJECT',
  'REQUEST_CLARIFICATION',
  'ACCEPT_CONTEXT',
  'REJECT_CONTEXT',

  // Planning
  'REQUEST_PLANNING',
  'SELECT_TASK',
  'UPDATE_PLAN',
  'REPLAN',
  'DEFER',

  // Execution
  'IMPLEMENT_TASK',
  'RETRY_TASK',
  'CORRECT_TASK',

  // Evaluation
  'REVIEW_EVIDENCE',
  'ACCEPT_TASK',
  'REJECT_TASK',

  // Control
  'BLOCK',
  'REQUEST_HUMAN_DECISION',
  'RESUME',

  // Completion
  'DECLARE_PROJECT_COMPLETE',
] as const;

export type DirectorActionType = (typeof DIRECTOR_ACTION_TYPES)[number];

// ============================================================================
// 3. RISK CLASSIFICATION
// ============================================================================

export const DIRECTOR_ACTION_RISK_TYPES = [
  'READ_ONLY',
  'PLANNING',
  'EXECUTION',
  'RECOVERY',
  'HUMAN_GATE',
  'TERMINAL',
] as const;

export type DirectorActionRisk = (typeof DIRECTOR_ACTION_RISK_TYPES)[number];

/**
 * Deterministically computes the risk classification for a DirectorActionType.
 * Risk classification is strictly AIDM-governed and cannot be overridden by the Director agent.
 */
export function getDirectorActionRisk(actionType: DirectorActionType): DirectorActionRisk {
  switch (actionType) {
    case 'ANALYZE_PROJECT':
    case 'DISCOVER_PROJECT':
    case 'ACCEPT_CONTEXT':
    case 'REJECT_CONTEXT':
    case 'REVIEW_EVIDENCE':
      return 'READ_ONLY';

    case 'REQUEST_PLANNING':
    case 'SELECT_TASK':
    case 'UPDATE_PLAN':
    case 'REPLAN':
    case 'DEFER':
      return 'PLANNING';

    case 'IMPLEMENT_TASK':
    case 'ACCEPT_TASK':
    case 'REJECT_TASK':
      return 'EXECUTION';

    case 'RETRY_TASK':
    case 'CORRECT_TASK':
      return 'RECOVERY';

    case 'REQUEST_CLARIFICATION':
    case 'BLOCK':
    case 'REQUEST_HUMAN_DECISION':
    case 'RESUME':
      return 'HUMAN_GATE';

    case 'DECLARE_PROJECT_COMPLETE':
      return 'TERMINAL';

    default:
      throw new Error(`Unknown DirectorActionType: ${String(actionType)}`);
  }
}

// ============================================================================
// 4. COMMON ACTION ENVELOPE
// ============================================================================

export interface DirectorActionEnvelope {
  readonly protocolVersion: typeof DIRECTOR_ACTION_PROTOCOL_VERSION;
  readonly schemaVersion: typeof DIRECTOR_ACTION_SCHEMA_VERSION;
  readonly actionId: string;
  readonly directorSessionId: string;
  readonly projectId: string;
  readonly actionType: DirectorActionType;
  readonly basedOnContextFingerprint: string;
  readonly basedOnUnderstandingRevision?: number | null;
  readonly basedOnApprovalRevision?: number | null;
  readonly rationale: string;
  readonly confidence: number;
  readonly expectedOutcome?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// 5. ACTION-SPECIFIC DOMAIN INTERFACES
// ============================================================================

// --- Understanding Actions ---

export interface AnalyzeProjectAction extends DirectorActionEnvelope {
  readonly actionType: 'ANALYZE_PROJECT';
  readonly analysisScope?: string;
}

export interface DiscoverProjectAction extends DirectorActionEnvelope {
  readonly actionType: 'DISCOVER_PROJECT';
  readonly discoveryScope?: string;
}

export interface RequestClarificationAction extends DirectorActionEnvelope {
  readonly actionType: 'REQUEST_CLARIFICATION';
  readonly question: string;
  readonly reason: string;
  readonly blocking: boolean;
  readonly options?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
}

export interface AcceptContextAction extends DirectorActionEnvelope {
  readonly actionType: 'ACCEPT_CONTEXT';
  readonly contextScope?: string;
}

export interface RejectContextAction extends DirectorActionEnvelope {
  readonly actionType: 'REJECT_CONTEXT';
  readonly reason?: string;
}

// --- Planning Actions ---

export interface RequestPlanningAction extends DirectorActionEnvelope {
  readonly actionType: 'REQUEST_PLANNING';
  readonly planningScope?: string;
}

export interface SelectTaskAction extends DirectorActionEnvelope {
  readonly actionType: 'SELECT_TASK';
  readonly taskId?: string;
}

export interface UpdatePlanAction extends DirectorActionEnvelope {
  readonly actionType: 'UPDATE_PLAN';
  readonly planSummary?: string;
}

export interface ReplanAction extends DirectorActionEnvelope {
  readonly actionType: 'REPLAN';
  readonly reason: string;
  readonly affectedTaskIds: readonly string[];
  readonly planningObjective: string;
  readonly constraints: readonly string[];
}

export interface DeferAction extends DirectorActionEnvelope {
  readonly actionType: 'DEFER';
  readonly reason?: string;
  readonly taskId?: string;
}

// --- Execution Actions ---

export interface ImplementTaskAction extends DirectorActionEnvelope {
  readonly actionType: 'IMPLEMENT_TASK';
  readonly taskId: string;
  readonly objective: string;
  readonly targetFiles: readonly string[];
  readonly implementationScope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
}

export interface RetryTaskAction extends DirectorActionEnvelope {
  readonly actionType: 'RETRY_TASK';
  readonly taskId: string;
  readonly previousExecutionId: string;
  readonly reason: string;
  readonly correctionStrategy?: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface CorrectTaskAction extends DirectorActionEnvelope {
  readonly actionType: 'CORRECT_TASK';
  readonly taskId: string;
  readonly failureAnalysis: string;
  readonly correctionPlan: string;
  readonly targetFiles: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

// --- Evaluation Actions ---

export interface ReviewEvidenceAction extends DirectorActionEnvelope {
  readonly actionType: 'REVIEW_EVIDENCE';
  readonly taskId?: string;
  readonly evidenceIds: readonly string[];
  readonly reviewObjective: string;
}

export interface AcceptTaskAction extends DirectorActionEnvelope {
  readonly actionType: 'ACCEPT_TASK';
  readonly taskId: string;
  readonly evidenceIds: readonly string[];
  readonly acceptanceRationale: string;
}

export interface RejectTaskAction extends DirectorActionEnvelope {
  readonly actionType: 'REJECT_TASK';
  readonly taskId: string;
  readonly evidenceIds: readonly string[];
  readonly rejectionReason: string;
}

// --- Control Actions ---

export interface BlockAction extends DirectorActionEnvelope {
  readonly actionType: 'BLOCK';
  readonly reason?: string;
}

export interface RequestHumanDecisionAction extends DirectorActionEnvelope {
  readonly actionType: 'REQUEST_HUMAN_DECISION';
  readonly question: string;
  readonly reason: string;
  readonly blocking: true;
}

export interface ResumeAction extends DirectorActionEnvelope {
  readonly actionType: 'RESUME';
  readonly resumeReason?: string;
}

// --- Completion Action ---

export interface DeclareProjectCompleteRequirementCoverage {
  readonly requirementId: string;
  readonly satisfied: boolean;
  readonly evidenceIds: readonly string[];
}

export interface DeclareProjectCompleteAction extends DirectorActionEnvelope {
  readonly actionType: 'DECLARE_PROJECT_COMPLETE';
  readonly completionRationale: string;
  readonly requirementCoverage: readonly DeclareProjectCompleteRequirementCoverage[];
  readonly unresolvedRisks: readonly string[];
  readonly remainingTasks: readonly string[];
  readonly finalVerificationRequested: true;
}

// ============================================================================
// 6. DISCRIMINATED UNION
// ============================================================================

export type DirectorAction =
  | AnalyzeProjectAction
  | DiscoverProjectAction
  | RequestClarificationAction
  | AcceptContextAction
  | RejectContextAction
  | RequestPlanningAction
  | SelectTaskAction
  | UpdatePlanAction
  | ReplanAction
  | DeferAction
  | ImplementTaskAction
  | RetryTaskAction
  | CorrectTaskAction
  | ReviewEvidenceAction
  | AcceptTaskAction
  | RejectTaskAction
  | BlockAction
  | RequestHumanDecisionAction
  | ResumeAction
  | DeclareProjectCompleteAction;
