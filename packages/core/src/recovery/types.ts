import type { DurableState } from '../storage/durable-state.js';
import type { LocalRuntimeState } from '../storage/runtime-state.js';
import type { HistoryEvent } from '../storage/history-manager.js';
import type { FileRecord, ScannedFile } from '../l0/types.js';
import type { DurableStateManager } from '../storage/durable-state.js';
import type { LocalRuntimeStateManager } from '../storage/runtime-state.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { L0Database } from '../l0/database.js';

export const RecoveryDecision = {
  RESUME: 'RESUME',
  RETRY: 'RETRY',
  RESTART: 'RESTART',
  BLOCKED_ON_HUMAN: 'BLOCKED_ON_HUMAN',
} as const;

export type RecoveryDecision = (typeof RecoveryDecision)[keyof typeof RecoveryDecision];

/**
 * Observed read-only Git status for the workspace.
 */
export interface GitState {
  isRepository: boolean;
  currentHead: string | null;
  isClean: boolean;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
}

export const RecoveryFileChangeType = {
  EXPECTED_IMPLEMENTATION_CHANGE: 'EXPECTED_IMPLEMENTATION_CHANGE',
  UNEXPECTED_EXTERNAL_CHANGE: 'UNEXPECTED_EXTERNAL_CHANGE',
} as const;

export type RecoveryFileChangeType =
  (typeof RecoveryFileChangeType)[keyof typeof RecoveryFileChangeType];

/**
 * Explicit classification of a detected file modification or addition.
 */
export interface ClassifiedFileChange {
  path: string;
  type: RecoveryFileChangeType;
  attributionSource?: string;
}

/**
 * Validation or compilability evidence available from build, tests, or execution history.
 */
export interface ValidationEvidence {
  compilable?: boolean;
  buildPassed?: boolean;
  testsPassed?: boolean;
  verifiedAt?: string;
  source?: string;
  gitHead?: string;
  contextReference?: string;
  fileHashes?: Record<string, string>;
  isApplicable?: boolean;
  stale?: boolean;
}

/**
 * Result of comparing persisted L0 index against actual on-disk filesystem state,
 * categorizing changes into attributable implementation progress vs unexpected external changes.
 */
export interface FilesystemReconciliationDiff {
  isConsistent: boolean;
  unexpectedModified: string[];
  unexpectedRemoved: string[];
  unexpectedAdded: string[];
  corruptedFiles: string[];
  expectedChanges: string[];
  unexpectedExternalChanges: string[];
  classifiedChanges: ClassifiedFileChange[];
  currentHashes?: Record<string, string>;
  totalExpectedFiles: number;
  totalActualFiles: number;
}

/**
 * Comprehensive snapshot of all authoritative evidence sources collected during recovery.
 */
export interface RecoverySnapshot {
  durableState: DurableState | null;
  localRuntimeState: LocalRuntimeState | null;
  historyEvents: HistoryEvent[];
  lastEvent: HistoryEvent | null;
  l0Records: FileRecord[];
  scannedFiles: ScannedFile[];
  gitState: GitState;
  isProcessAlive: boolean;
  isRuntimeStale: boolean;
  filesystemDiff: FilesystemReconciliationDiff;
  taskScope?: string[];
  validationEvidence?: ValidationEvidence | null;
  userResponse?: string | Record<string, unknown> | null;
  isCorrupted?: boolean;
}

/**
 * Pure deterministic recovery decision data produced by evaluating evidence sources.
 * Excludes non-deterministic execution metadata such as timestamps.
 */
export interface DeterministicDecisionData {
  decision: RecoveryDecision;
  reason: string;
  taskId: string | null;
  iteration: number | null;
  contextReference: string | null;
  resumePoint: string | null;
  targetCheckpoint?: string | null;
  evidenceReferences?: string[];
}

/**
 * Deterministic recovery decision produced by the Recovery & Reconciliation Engine,
 * accompanied by observational execution metadata.
 */
export interface RecoveryResult extends DeterministicDecisionData {
  timestamp: string;
}

/**
 * Configuration options for the RecoveryEngine.
 */
export interface RecoveryEngineOptions {
  workspaceRoot: string;
  durableStateManager?: DurableStateManager;
  localRuntimeStateManager?: LocalRuntimeStateManager;
  historyManager?: HistoryManager;
  l0Database?: L0Database;
  ignorePatterns?: string[];
  processLivenessChecker?: (pid: number) => boolean;
  fileIntegrityChecker?: (fullPath: string) => Promise<boolean> | boolean;
  taskScope?: string[];
  taskScopeResolver?: (taskId: string, durableState: DurableState | null) => string[] | undefined;
  validationEvidence?: ValidationEvidence | null;
  userResponse?: string | Record<string, unknown> | null;
  isCorrupted?: boolean;
}
