/**
 * @file autonomous-runner.ts
 * @description Fully autonomous spec-driven project development (`aidm run --spec`,
 * MCP `aidm_autonomous_start`).
 *
 * Pipeline:
 *   spec.md ─► SpecIngestor ─► auto Project Mandate (sealed by HUMAN operator invocation)
 *          ─► SpecStore tasks + ApprovalPackage (approved by the same operator invocation)
 *          ─► loop: DirectorContextSynchronizer ─► ClosedLoopCoordinator
 *                   (DirectorRuntime/LLM ─► AuthorizationPolicyEngine ─► ExecutionBridge
 *                    ─► Driver ─► AGY ─► independent SystemEvidence (SHA-256 + git))
 *          ─► git commit per independently ACCEPTED task ─► summary report
 *
 * PRESERVED INVARIANTS:
 * - LLM output is never authority and never evidence. The Director only proposes actions;
 *   the mandate & approval come from the operator invocation and are verified by the
 *   existing trusted-identity validator.
 * - Zero Executor Trust: a task counts as done only on COMPLETED_SUCCESS from the closed loop
 *   (independently collected evidence). AGY claims are ignored.
 * - Budget hold/settle is mandatory for every LLM call; no budget => no live run.
 * - No-questions mode: clarification requests are answered with logged assumptions; any
 *   human-gate/policy/unknown-state outcome stops the run fail-closed (never auto-approved).
 */

import { DecisionLog, assumptionTr, decisionEventMessage, splitAssumption, type DecisionKind, type DecisionEntry } from './decision-log.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  SpecIngestor,
  looksLikeUrl,
  isSafeProjectRelativePath,
  type SpecIngestionResult,
  type AnalysisPolicy,
  isSyntheticDefaultAcceptanceCriteria,
  isSyntheticDefaultDescription,
} from './spec-ingestor.js';
import {
  ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE,
  generateArchitectureIntentReport,
  saveArchitectureIntentReport,
} from './architecture-intent.js';
export {
  ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE,
  generateArchitectureIntentReport,
  saveArchitectureIntentReport,
};
import { detectWorkspaceStatus } from './repo-manifest-scanner.js';
import { loadSpecBundle, loadSpecBundleSync, findModifiedSpecFiles, SpecBundleError, type SpecBundle } from './spec-bundle.js';
import { SpecContext, resolveSpecInlineChars, type SpecTaskRef } from './spec-context.js';
import {
  CHECKS_SCRIPT_PATH,
  CLARIFICATION_SYSTEM_PROMPT,
  FREE_TEXT_SYSTEM_PROMPT,
  IdpClarificationResolver,
  SPEC_CLARIFICATION_TASK_ID,
  TURKISH_REPAIR_PROMPT,
  buildClarificationRequest,
  buildClarificationUserPrompt,
  loadClarificationState,
  normalizeCheck,
  normalizeClarificationProposal,
  partitionTurkish,
  renderChecksScript,
  resolveClarification,
  saveClarificationState,
  saveDesignBrief,
  type ClarificationResolver,
  type ClarificationCheck,
  type ClarificationState,
} from './spec-clarification.js';
import {
  buildAutonomousMandate,
  sealAutonomousMandate,
  signOperatorInvocation,
  AUTONOMOUS_RUN_LOCK_FILE,
  DEFAULT_AUTONOMOUS_ALLOWED_PATHS,
  type AutonomousAuthorizationProvenance,
} from './autonomous-mandate.js';
import {
  resolveLlmProviderConfig,
  createConfiguredLlmProvider,
  registerProviderBudgetTerms,
  describeLlmProviderConfig,
  resolveDirectorOutputSettings,
  type DirectorOutputSettings,
  type ResolvedLlmProviderConfig,
} from './llm-provider-config.js';
import type { ProjectMandate } from '../authorization/authorization-policy-types.js';
import { ProjectMandateStore } from '../authorization/project-mandate-store.js';
import { IdentityManager } from '../authorization/identity-manager.js';
import { AuthorizationPolicyEngine } from '../authorization/authorization-policy-engine.js';
import { pinCanonicalProjectIdentity, PROJECT_IDENTITY_PIN_FILE } from '../director/project-identity-resolver.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorSessionEngine } from '../director/director-session-engine.js';
import { DirectorContextSynchronizer } from '../director/director-context-synchronizer.js';
import { DirectorRuntime } from '../director/director-runtime.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import { SpecStore } from '../storage/spec-store.js';
import { HistoryManager } from '../storage/history-manager.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';
import { ClosedLoopCoordinator } from '../director-loop/closed-loop-coordinator.js';
import type { ClosedLoopCycleResult } from '../director-loop/closed-loop-types.js';
import type { DirectorActionDispatcher, DirectorActionDispatcherOptions } from '../director-action/director-action-dispatcher.js';
import type { ImplementTaskAction } from '../director/director-action-types.js';
import { BudgetManager } from '../budget/budget-manager.js';
import {
  SystemEvidenceCollector,
  type SystemEvidenceCollectorOptions,
  type VerificationCommandSpec,
} from '../evidence/execution-evidence-collector.js';
import type { ExecutionRequest } from '../executor-bridge/execution-request-types.js';
import type { RawExecutorOutcome } from '../executor-bridge/raw-executor-outcome.js';
import { nanoUsdToUsd, MAX_PERIOD_BUDGET_NANO_USD } from '../budget/budget-types.js';
import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import { LlmResponseFormat } from '../llm-bridge/llm-types.js';
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import { AntigravityAdapter } from '../executor-bridge/antigravity-adapter.js';
import { registerWatcherRoot } from '../mcp/aidm-watcher.js';
import { webGateCommands } from './web-checks.js';
import {
  PLAN_PROMPT_ADDENDUM, normalizeApproachPlan, planQuestion, PLAN_QUESTION_ID, renderPlanTr, syncPreferences, learnPreferences, planCorrectionPreference,
  preferencesPromptBlock, progressEvery, PROGRESS_TASK_ID, PROGRESS_SYSTEM_PROMPT, buildProgressPrompt, renderProgressNote, directorJson,
  SELF_CHECK_TASK_ID, SELF_CHECK_SYSTEM_PROMPT, buildSelfCheckPrompt, parseSelfCheck, readChangedFiles, type UserPreference,
} from './director-extras.js';
import { collectScreenshots, runVisualReview, renderCompletionReportTr, type VisualReview } from './completion-report.js';
import { createIdeRequestInvoker, IDE_EXECUTOR_ID, noteIdeEvent, resetIdeMailbox, resolveExecutorMode, type ExecutorMode } from '../executor-bridge/ide-executor.js';
import { NodeAntigravityProcessRunner } from '../executor-bridge/antigravity-process-runner.js';
import { LifecycleState } from '../lifecycle.js';
import { Actor } from '../actors.js';
import type { ITrustedIdentityProvider } from '../authorization/trusted-identity-types.js';
import { createTrustedIdentityProvider } from '../authorization/trusted-identity-config.js';
import { NonceStore } from '../authorization/nonce-store.js';
import { isExternalIdpConfigured } from './idp-client.js';
import { RunMonitor, runMonitorUrl, monitorText, type RunMonitorEventType, type RunMonitorSnapshotInput, type RunMonitorStatus } from './run-monitor.js';
import { InstructionChannel, computeInstructionChannelFingerprint, type VerifiedInstruction } from './instruction-channel.js';
import { exec as execCb } from 'node:child_process';
import {
  HEARTBEAT_MS,
  loadCheckpoint,
  listInterruptedRuns,
  lockLiveness,
  readRunLock,
  runLiveness,
  saveCheckpoint,
  stashInterruptedChanges,
  isResumableBlockedRun,
  writeRunLock,
  type RunCheckpoint,
} from './run-checkpoint.js';
import {
  IdpDecisionResolver,
  buildDecisionRecord,
  decisionPolicyInstruction,
  formatDecisionForDirector,
  resolveDecisionMode,
  saveDecisionRecord,
  type DecisionMode,
  type DecisionOutcome,
  type DecisionRecord,
  type DecisionResolver,
} from './decision-requests.js';
import { TaskStatus, type TaskDefinition } from '../task-engine/task-types.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// 1. CONTRACTS
// ============================================================================

export type AutonomousRunStatus =
  | 'DRY_RUN_OK'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'BLOCKED_ON_AUTH_CONTEXT'
  | 'BLOCKED_ON_HUMAN'
  | 'BUDGET_EXHAUSTED'
  | 'CONFIGURATION_ERROR'
  | 'STOPPED'
  | 'FAILED';

export type AutonomousEntryPoint = 'aidm run --spec' | 'aidm_autonomous_start';

export interface AutonomousRunOptions {
  readonly projectRoot: string;
  readonly specPath: string;
  readonly budgetUsd?: number;
  readonly dryRun?: boolean;
  readonly entryPoint?: AutonomousEntryPoint;
  /**
   * Pre-verified human auth context (e.g. external IdP assertion for MCP callers).
   * When absent, the CLI entry point signs an OPERATOR_CLI_INVOCATION context; the MCP
   * entry point fails closed (BLOCKED_ON_AUTH_CONTEXT).
   */
  readonly authContext?: Record<string, unknown>;
  readonly maxCyclesPerTask?: number;
  readonly maxClarificationAssumptions?: number;
  readonly mandateValidityHours?: number;
  readonly commit?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  // --- dependency injection (tests / embedding) ---
  readonly llmProvider?: LLMProvider;
  readonly allowMockProvider?: boolean;
  readonly executorPort?: ExecutorPort;
  readonly identityManager?: IdentityManager;
  readonly actionDispatcher?: DirectorActionDispatcher | ((options: DirectorActionDispatcherOptions) => DirectorActionDispatcher);
  /** Registers pricing/contract terms for an injected provider (live config does this itself). */
  readonly registerBudgetTerms?: (budgetManager: BudgetManager) => void;
  readonly onEvent?: (event: AutonomousRunEvent) => void;
  /**
   * External-IdP approval binding fixed BEFORE approval (aidm_autonomous_start). The approval
   * package is created with exactly this id/revision so the signed token binds to it.
   */
  readonly preboundApproval?: {
    readonly packageId: string;
    readonly revision: number;
    readonly contextFingerprint: string;
    readonly approvedBy?: string;
  };
  readonly onRunId?: (runId: string) => void | Promise<void>;
  /** External IdP adapter for mandate sealing (default: env-configured factory). */
  readonly identityProvider?: ITrustedIdentityProvider;
  /**
   * Channel for Director REQUEST_HUMAN_DECISION. undefined => external IdP when configured,
   * otherwise none (decision stops the run BLOCKED_ON_HUMAN). null => explicitly none.
   */
  readonly decisionResolver?: DecisionResolver | null;
  /**
   * Spec clarification channel (contract v1.2 SPEC_CLARIFICATION). Default: the external IdP when
   * configured; null = no human channel (recommended options are applied as logged assumptions).
   */
  readonly clarificationResolver?: ClarificationResolver | null;
  /** Overrides AIDM_DECISION_MODE (ask | assume). */
  readonly decisionMode?: DecisionMode;
  readonly maxDecisionsPerTask?: number;
  /** Max in-scope refinements (REPLAN splits) and read-only analyses per task. */
  readonly maxRefinementsPerTask?: number;
  readonly maxAnalysesPerTask?: number;
  /** Pre-assigned run id (external approval: same id from PENDING_APPROVAL to the end). */
  readonly runId?: string;
  /** fetch used for the IdP run monitor and instruction channel (tests). */
  readonly idpFetchFn?: typeof fetch;
  /** Called once with the monitor URL when the live run monitor is enabled. */
  readonly onMonitorUrl?: (url: string) => void;
  /**
   * Resume an INTERRUPTED run (process killed / reboot) under the same runId. Requires a fresh
   * authorization (authContext / operator invocation); the old sealed mandate is never reused.
   * Accepted tasks are skipped, the interrupted attempt's uncommitted changes are stashed, the
   * budget ledger of the run carries over against the same cap, the spec fingerprint must match.
   */
  readonly resumeRunId?: string;
  /** Start fresh even though an interrupted run exists: marks it ABANDONED (its stale lock is removed). */
  readonly abandonInterrupted?: boolean;
  /** Log file of a detached worker (recorded in the checkpoint for status). */
  readonly logPath?: string;
}

export interface AutonomousRunEvent {
  readonly type: string;
  readonly taskId?: string;
  readonly message: string;
  readonly at: string;
}

export interface AutonomousTaskReport {
  readonly taskId: string;
  readonly title: string;
  status: 'ACCEPTED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'PENDING' | 'SPLIT' | 'WAITING_DECISION';
  /** Set for subtasks created by in-scope refinement or read-only analysis. */
  parentTaskId?: string;
  kind?: 'TASK' | 'SUBTASK' | 'ANALYSIS';
  cycles: number;
  lastCycleStatus?: string;
  lastSummary?: string;
  evidenceIds: string[];
  verificationChecks: Array<{ type: string; status: string; command?: string }>;
  filesChanged: string[];
  commit?: string;
  metadata?: {
    analysisRefusals?: number;
    fallbackSynthesized?: boolean;
  };
}

export interface AutonomousRunReport {
  readonly runId: string;
  status: AutonomousRunStatus;
  readonly dryRun: boolean;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly specPath: string;
  readonly specFingerprint: string;
  readonly entryPoint: AutonomousEntryPoint;
  readonly startedAt: string;
  finishedAt?: string;
  provider?: Record<string, unknown>;
  authorization?: AutonomousAuthorizationProvenance;
  mandate?: Pick<
    ProjectMandate,
    | 'mandateRevision'
    | 'policyVersion'
    | 'allowedOperationTypes'
    | 'autoExecutableTaskClasses'
    | 'forbiddenOperations'
    | 'humanApprovalRequiredOperations'
    | 'allowedDirectories'
    | 'authorizationEndTime'
  >;
  readonly plan: SpecIngestionResult['plan'];
  readonly assumptions: string[];
  readonly warnings: string[];
  readonly tasks: AutonomousTaskReport[];
  budget?: { limitUsd: number; committedUsd: number; reservedUsd: number; availableUsd: number };
  commits: string[];
  decisions: Array<{ decisionId: string; taskId: string; question: string; state: string; channel?: string; answer?: unknown }>;
  /** Pre-implementation spec review ("Netleştirme"). */
  clarification?: {
    status: 'DISABLED' | 'NONE' | 'ANSWERED' | 'AUTO_RECOMMENDED' | 'REUSED' | 'EXPIRED' | 'FAILED';
    decisionId?: string;
    summary?: string;
    lines: string[];
    criteriaAdded: number;
    checksScript?: string;
    newTasks: string[];
    note?: string;
  };
  refinements: string[];
  executorReports: string[];
  /** Spec commands deferred per task because the files they reference did not exist yet. */
  deferredCommands: Array<{ taskId: string; commands: string[] }>;
  /** Run-level acceptance gate (global `## Komutlar` + command-like `## Kabul Kriterleri`). */
  finalGate?: { status: 'PASS' | 'FAIL' | 'NOT_RUN' | 'NO_CHECKS'; repairs: number; checks: Array<{ command: string; exitCode: number | null; tail?: string }>; criteria: string[] };
  /** Verified live PO instructions (no tokens). */
  instructions: Array<{ instructionId: string; mode: string; taskId: string | null; state: string; note?: string }>;
  /** Binding Director-owned design direction (UI projects), stored in .ai-manager/state/design-brief.json. */
  executorMode?: ExecutorMode;
  designBrief?: { name: string; optionId: string; tokens: Record<string, string>; decidedBy: string };
  /** Director's approach plan (approved / corrected with the spec review). */
  approachPlan?: string;
  /** Preferences from earlier projects the Director could use (ids only). */
  preferencesUsed?: string[];
  /** Karar günlüğü markdown path. */
  decisionLogPath?: string;
  /** Director progress notes posted to the IdP run page. */
  progressNotes?: string[];
  /** Director self-checks before acceptance. */
  selfChecks?: Array<{ taskId: string; ok: boolean; doubts: string[] }>;
  /** Prompt-cache statistics (provider-reported cached input tokens). */
  promptCache?: { calls: number; inputTokens: number; cachedTokens: number };
  /** Director vision review of the headless-browser screenshots (advisory). */
  visualReview?: VisualReview;
  /** One-page Turkish completion report (.ai-manager/reports/tamamlama-<runId>.md). */
  completionReportPath?: string;
  monitorUrl?: string;
  skippedByPo?: string[];
  stopReason?: string;
  reportPath?: string;
}

/** Director capabilities in autonomous runs (full director over AGY within the sealed mandate). */
export const DIRECTOR_CAPABILITIES_INSTRUCTION = [
  'You direct the executor (AGY). Write rich, multi-step executor instructions in "objective": context, step-by-step plan,',
  'files to read first, files to change, and how to verify. You may: (a) emit ANALYZE_PROJECT (analysisScope) to have the',
  'executor read code / run tests or builds read-only and report findings back to you; (b) emit REPLAN with proposedTasks',
  'to split the target task into 2-5 in-scope subtasks (targetFiles must stay inside the allowed paths) and/or taskOrder',
  'to reorder remaining tasks. Scope, budget and policy changes are NOT yours: raise REQUEST_HUMAN_DECISION instead.',
  'Executor output and questions come back to you; the executor never talks to the human. Independent evidence decides.',
].join(' ');

/** Added to the Director prompt when a separate analysis subtask is not available for this cycle. */
export const NO_ANALYSIS_DIRECTOR_INSTRUCTION =
  'SPEED RULE: do NOT emit ANALYZE_PROJECT / DISCOVER_PROJECT / REVIEW_EVIDENCE for this task; no separate analysis step is available now. ' +
  'Emit IMPLEMENT_TASK directly and tell the executor in "objective" which files to read first.';

export type AnalysisRefusalReason =
  | 'greenfield'
  | 'policy_never'
  | 'policy_on_demand_not_first_or_failed'
  | 'quota_exhausted'
  | 'analysis_already_done_no_failed_attempt'
  | 'is_analysis_task';

export interface AnalysisAllowedResult {
  readonly allowed: boolean;
  readonly reason?: AnalysisRefusalReason;
}

export interface AnalysisAllowedContext {
  readonly firstTaskOfSegment: boolean;
  readonly afterFailedAttempt: boolean;
  readonly isGreenfield?: boolean;
  readonly analysesDone?: number;
  readonly maxAnalyses?: number;
  readonly isAnalysisTask?: boolean;
}

/**
 * Evaluates whether a separate read-only analysis subtask may run for the current cycle,
 * returning both the boolean decision and the exact refusal reason when disallowed.
 */
export function evaluateAnalysis(
  policy: AnalysisPolicy,
  ctx: AnalysisAllowedContext
): AnalysisAllowedResult {
  if (ctx.isAnalysisTask) {
    return { allowed: false, reason: 'is_analysis_task' };
  }
  if (ctx.isGreenfield) {
    return { allowed: false, reason: 'greenfield' };
  }
  if (policy === 'NEVER') {
    return { allowed: false, reason: 'policy_never' };
  }

  const done = ctx.analysesDone ?? 0;
  const max = ctx.maxAnalyses ?? 2;
  if (done >= max) {
    return { allowed: false, reason: 'quota_exhausted' };
  }

  // A task that has already completed an analysis cannot run another analysis unless
  // an implementation attempt has failed (afterFailedAttempt).
  // Note: maxAnalyses sets the absolute ceiling per task across failures;
  // this rule prevents consecutive analyses without an intervening implementation attempt.
  if (done >= 1 && !ctx.afterFailedAttempt) {
    return { allowed: false, reason: 'analysis_already_done_no_failed_attempt' };
  }

  if (policy === 'EVERY_TASK') {
    return { allowed: true };
  }

  // ON_DEMAND (default / 'gerektiğinde'):
  if (ctx.firstTaskOfSegment || ctx.afterFailedAttempt) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'policy_on_demand_not_first_or_failed' };
}

/** Backward-compatible wrapper returning only boolean decision. */
export function isAnalysisAllowed(
  policy: AnalysisPolicy,
  ctx: AnalysisAllowedContext
): boolean {
  return evaluateAnalysis(policy, ctx).allowed;
}

export function analysisPolicyLabel(policy: AnalysisPolicy): string {
  return policy === 'EVERY_TASK' ? 'her görev' : policy === 'NEVER' ? 'hiç' : 'gerektiğinde';
}

/**
 * Detects whether the workspace is greenfield (contains no real code or project manifests yet).
 * Uses `git ls-files --cached --others --exclude-standard -z` with null-byte separation.
 * If git fails, times out, or the directory is not a git repo, returns false (fail-open for analysis).
 * Any file outside the excluded list (.git, node_modules, .ai-manager, *.md, LICENSE, git configs, images/pdf)
 * means the project is NOT greenfield.
 */
export async function isGreenfieldWorkspace(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: projectRoot,
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      }
    );
    if (!stdout || stdout.length === 0) return true;
    const entries = stdout.split('\0');
    for (const raw of entries) {
      if (!raw || raw.trim().length === 0) continue;
      const normalized = raw.replace(/\\/g, '/');
      const lower = normalized.toLocaleLowerCase('en-US');
      const base = path.posix.basename(lower);

      // Exclude metadata/specs/documentation/configs/assets
      if (
        lower.startsWith('.git/') ||
        lower === '.git' ||
        lower.startsWith('node_modules/') ||
        lower.startsWith('.ai-manager/') ||
        base.endsWith('.md') ||
        base.endsWith('.markdown') ||
        base.startsWith('license') ||
        base.startsWith('licence') ||
        base.startsWith('notice') ||
        base === '.gitignore' ||
        base === '.gitattributes' ||
        base === '.editorconfig' ||
        base.endsWith('.png') ||
        base.endsWith('.jpg') ||
        base.endsWith('.jpeg') ||
        base.endsWith('.gif') ||
        base.endsWith('.svg') ||
        base.endsWith('.ico') ||
        base.endsWith('.webp') ||
        base.endsWith('.pdf')
      ) {
        continue;
      }

      // Any file outside the exclusion list means the repo is NOT greenfield
      return false;
    }
    return true;
  } catch {
    // Non-git directory, timeout, or buffer overflow -> fail-open: do not disable analysis
    return false;
  }
}

export function formatAnalysisRefusal(
  reason: AnalysisRefusalReason,
  taskPolicyLabel: string
): { directorInstruction: string; logMessage: string } {
  switch (reason) {
    case 'greenfield':
      return {
        directorInstruction:
          'A separate read-only analysis is not available for this task. GREENFIELD PROJECT: The repository contains no existing source files or build manifests yet. ' +
          'Do NOT emit ANALYZE_PROJECT; there is nothing to analyze. ' +
          'Directly scaffold the project and implement the initial files with IMPLEMENT_TASK.',
        logMessage: 'Depo henüz boş (greenfield); incelenecek kod yok (reason: greenfield) → doğrudan uygulama istenecek.',
      };
    case 'policy_never':
      return {
        directorInstruction:
          'ANALYSIS DISABLED: Project spec policy is set to "İnceleme: hiç" (NEVER). ' +
          'Do NOT emit ANALYZE_PROJECT. Emit IMPLEMENT_TASK directly.',
        logMessage: 'Spec inceleme politikası "hiç" olarak ayarlı (reason: policy_never) → doğrudan uygulama istenecek.',
      };
    case 'quota_exhausted':
      return {
        directorInstruction:
          'ANALYSIS QUOTA EXHAUSTED: The maximum number of separate analysis subtasks for this task has been reached. ' +
          'The executor inspects relevant files while implementing. Emit IMPLEMENT_TASK directly.',
        logMessage: 'Görev için analiz kotası doldu (reason: quota_exhausted) → doğrudan uygulama istenecek.',
      };
    case 'analysis_already_done_no_failed_attempt':
      return {
        directorInstruction:
          'CONSECUTIVE ANALYSIS NOT PERMITTED: A separate read-only analysis was already completed for this task ' +
          'and no failed implementation attempt has occurred. Emit IMPLEMENT_TASK directly with concrete targetFiles.',
        logMessage: 'Görev için analiz zaten yapıldı, başarısız deneme yok (reason: analysis_already_done_no_failed_attempt) → doğrudan uygulama istenecek.',
      };
    case 'is_analysis_task':
      return {
        directorInstruction: 'This is a read-only analysis task: do not nest further analysis requests. Emit IMPLEMENT_TASK.',
        logMessage: 'Analiz alt görevi içinde yeni analiz açılamaz (reason: is_analysis_task) → doğrudan uygulama istenecek.',
      };
    case 'policy_on_demand_not_first_or_failed':
      return {
        directorInstruction: NO_ANALYSIS_DIRECTOR_INSTRUCTION,
        logMessage: `Bu görevde ayrı analiz adımı yok (İnceleme: ${taskPolicyLabel}, reason: policy_on_demand_not_first_or_failed) → doğrudan uygulama istenecek.`,
      };
  }
  const _exhaustive: never = reason;
  return _exhaustive;
}

/** Instruction prepended to every Director reasoning call in no-questions mode. */
export const NO_QUESTIONS_DIRECTOR_INSTRUCTION = [
  'AUTONOMOUS NO-QUESTIONS MODE.',
  'The human operator has already authorized routine IMPLEMENTATION work for this spec and will not answer questions.',
  'Do NOT emit REQUEST_CLARIFICATION. When something is ambiguous, choose the most reasonable conventional option,',
  'state the assumption explicitly in "rationale"/"constraints", and continue with IMPLEMENT_TASK for the target task.',
  'Only stop (BLOCK / REQUEST_HUMAN_DECISION) for critical security conditions: secrets/credentials, actions outside',
  'the project root, destructive operations, policy/budget changes or anything outside the spec scope.',
  'You have no authority: never claim approval, verification or evidence. Evidence is collected independently.',
].join(' ');

// ============================================================================
// 2. RUNNER
// ============================================================================

export class AutonomousSpecRunner {
  private readonly options: AutonomousRunOptions;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(options: AutonomousRunOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
  }

  private monitor: RunMonitor | null = null;
  private monitorStatus: RunMonitorStatus = 'RUNNING';
  private currentReport: AutonomousRunReport | null = null;
  private decisionLog: DecisionLog | null = null;

  /** Karar günlüğü entry (plain-Turkish AIDM template text; never raw prompts/LLM output). */
  private decide(kind: DecisionKind, title: string, rationale = '', taskId?: string | null): void {
    try {
      this.decisionLog?.record(kind, title, rationale, taskId);
    } catch {
      /* never affects the run */
    }
  }
  private currentTaskId: string | null = null;
  private lastDirectorAction: RunMonitorSnapshotInput['lastDirectorAction'] = null;
  private pendingDecisionIds = new Set<string>();
  private liveBudget?: () => { limitUsd: number; committedUsd: number; reservedUsd: number };
  private maxAttemptsOf: (taskId: string) => number | undefined = () => undefined;
  private instructionChannel: InstructionChannel | null = null;
  private stopInstruction: VerifiedInstruction | null = null;
  private checkpoint: RunCheckpoint | null = null;
  private ideRoot: string | null = null;

  /** Persists the crash-safe checkpoint (never throws). */
  private writeCheckpoint(): void {
    const cp = this.checkpoint;
    const rep = this.currentReport;
    if (!cp || !rep) return;
    cp.currentTaskId = this.currentTaskId;
    cp.tasks = rep.tasks.map((t) => ({
      taskId: t.taskId,
      status: t.status,
      cycles: t.cycles,
      ...(t.metadata ? { metadata: t.metadata } : {}),
    }));
    cp.commits = [...rep.commits];
    cp.monitorSeq = this.monitor?.currentSeq ?? cp.monitorSeq;
    if (rep.monitorUrl) cp.monitorUrl = rep.monitorUrl;
    saveCheckpoint(cp);
  }

  private static readonly MONITOR_TYPES: Record<string, RunMonitorEventType> = {
    CYCLE_START: 'CYCLE_START',
    CYCLE_RESULT: 'CYCLE_RESULT',
    DECISION_REQUESTED: 'DECISION_REQUESTED',
    DECISION_ANSWERED: 'DECISION_ANSWERED',
    TASK_REFINED: 'REPLAN',
    EXECUTOR_REPORT: 'AGY_RESULT',
    MANDATE_SEALED: 'MANDATE_SEALED',
    RUN_FINISHED: 'RUN_FINISHED',
    RUN_STARTED: 'RUN_STARTED',
    TASK_ACCEPTED: 'TASK_ACCEPTED',
    TASK_BLOCKED: 'TASK_BLOCKED',
    VERIFICATION: 'VERIFICATION',
    DIRECTOR_ACTION: 'DIRECTOR_ACTION',
    COMMIT: 'COMMIT',
    ANALYSIS: 'ANALYSIS',
    FINAL_GATE: 'VERIFICATION',
    INSTRUCTION: 'INFO',
    DIRECTOR_ANSWER: 'DIRECTOR_ANSWER',
    PROGRESS_NOTE: 'PROGRESS_NOTE',
    DECISION_LOG: 'DECISION_LOG',
    VISUAL_REVIEW: 'VERIFICATION',
  };

  /**
   * Pre-implementation spec review. Never talks to AGY; talks to the human only through the IdP
   * (one SPEC_CLARIFICATION package). Without a channel, the recommended options are applied as
   * logged assumptions. Answers are persisted per spec fingerprint, so resume never re-asks.
   */
  private async runClarificationPhase(ctx: {
    projectRoot: string;
    projectId: string;
    runId: string;
    packageId: string;
    revision: number;
    markdown: string;
    ingestion: SpecIngestionResult;
    report: AutonomousRunReport;
    provider: LLMProvider;
    model: string;
    decisionMode: string;
    isBudgetExhausted: () => boolean;
    resuming?: boolean;
  }): Promise<{ stop?: { status: AutonomousRunStatus; reason: string }; apply?: ReturnType<typeof resolveClarification> }> {
    const { projectRoot, ingestion, report } = ctx;
    const rep: NonNullable<AutonomousRunReport['clarification']> = { status: 'NONE', lines: [], criteriaAdded: 0, newTasks: [] };
    report.clarification = rep;
    if (ingestion.clarification === false) {
      rep.status = 'DISABLED';
      this.emit('CLARIFICATION', 'Netleştirme kapalı (spec: Netleştirme: kapalı).');
      return {};
    }
    const fp = ingestion.specFingerprint;
    let st: ClarificationState | null = loadClarificationState(projectRoot, fp);
    const finalize = (s: ClarificationState, status: NonNullable<AutonomousRunReport['clarification']>['status']) => {
      const res = resolveClarification(s);
      rep.status = status;
      rep.summary = s.summary;
      rep.lines = res.lines;
      if (s.decisionId) rep.decisionId = s.decisionId;
      for (const l of res.lines) this.emit('CLARIFICATION', l);
      return { apply: res };
    };
    if (st && (st.status === 'ANSWERED' || st.status === 'AUTO_RECOMMENDED')) {
      this.emit('CLARIFICATION', 'Netleştirme cevapları daha önce verilmiş; yeniden sorulmuyor.');
      return finalize(st, 'REUSED');
    }
    if (st && st.status === 'NONE') {
      rep.status = 'NONE';
      return {};
    }
    if (ctx.resuming && !st) {
      // The first segment already ran (or skipped) the review; a resume never repeats it.
      rep.status = 'NONE';
      this.emit('CLARIFICATION', 'Devam eden çalışma: spec incelemesi ilk bölümde yapıldı, tekrarlanmıyor.');
      return {};
    }

    const llmJson = async (system: string, user: string, extra: Array<{ role: 'assistant' | 'user'; content: string }> = []): Promise<unknown> => {
      try {
        return await llmJsonOnce(system, user, extra, 8000);
      } catch (err) {
        // Truncated / malformed JSON (e.g. the model hit max tokens): one retry with a larger budget.
        if (!/JSON|STRUCTURED_OUTPUT/i.test(err instanceof Error ? err.message : String(err))) throw err;
        this.emit('CLARIFICATION', 'Spec incelemesi yanıtı yarım geldi; daha geniş sınırla bir kez yeniden deneniyor.', undefined, 'warn');
        return llmJsonOnce(system, user, [...extra, { role: 'user', content: 'Önceki yanıt yarım kaldı. Daha kısa yaz: en fazla 6 soru, kısa gerekçeler; yalnızca geçerli JSON döndür.' }], 16000);
      }
    };
    const llmJsonOnce = async (system: string, user: string, extra: Array<{ role: 'assistant' | 'user'; content: string }>, maxTokens: number): Promise<unknown> => {
      if (ctx.isBudgetExhausted()) throw new Error('Budget exhausted before the spec review.');
      const res = await ctx.provider.generate({
        correlation: { correlation_id: `clarify-${crypto.randomUUID()}`, project_id: ctx.projectId, task_id: SPEC_CLARIFICATION_TASK_ID, attempt: 1 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }, ...extra],
        director_context: { project_id: ctx.projectId, task_id: SPEC_CLARIFICATION_TASK_ID, objective: 'spec review', acceptance_criteria: null, attempt: 1, max_attempts: 1, relevant_context: null },
        model: ctx.model,
        max_tokens: maxTokens,
        response_format: LlmResponseFormat.JSON_OBJECT,
        json_schema: null,
        metadata: { purpose: 'SPEC_CLARIFICATION', runId: ctx.runId },
      } as never);
      if ((res as { error?: { message?: string } }).error) throw new Error(String((res as { error: { message?: string } }).error.message));
      const so = (res as { structured_output?: unknown }).structured_output;
      if (so && typeof so === 'object') return so;
      const text = String((res as { content?: unknown }).content ?? '');
      const m = /\{[\s\S]*\}/.exec(text);
      return m ? JSON.parse(m[0]) : {};
    };

    if (!st || !st.questions.length) {
      // 1) Director review (budget counted through the wrapped provider).
      const taskIds = report.tasks.filter((t) => t.kind === 'TASK' || !t.kind).map((t) => t.taskId);
      const userBase = buildClarificationUserPrompt({
        specMarkdown: ctx.markdown,
        tasks: ingestion.tasks.filter((t) => taskIds.includes(t.task_id)).map((t) => ({ taskId: t.task_id, title: t.title, acceptance: t.acceptance_criteria })),
        allowedPaths: report.mandate?.allowedDirectories ?? ingestion.allowedPaths,
        verificationCommands: ingestion.verificationCommands,
      });
      // Cross-project memory: preferences from earlier projects pre-fill / skip known questions.
      const planOn = this.env.AIDM_APPROACH_PLAN !== '0';
      let prefs: UserPreference[] = [];
      try {
        prefs = (await syncPreferences(this.env, this.options.idpFetchFn ?? fetch)).items;
      } catch {
        prefs = [];
      }
      if (prefs.length) {
        report.preferencesUsed = prefs.map((p) => p.id).slice(0, 40);
        this.decide('ASSUMPTION', `Önceki projelerden ${prefs.length} kayıtlı tercih dikkate alındı`, 'Bilinen sorular tekrar sorulmasın, cevaplar önceden doldurulsun diye (Tercihlerim).', SPEC_CLARIFICATION_TASK_ID);
      }
      const user = userBase + preferencesPromptBlock(prefs);
      const system = planOn ? `${CLARIFICATION_SYSTEM_PROMPT}\n${PLAN_PROMPT_ADDENDUM}` : CLARIFICATION_SYSTEM_PROMPT;
      let raw: unknown;
      try {
        raw = await llmJson(system, user);
      } catch (err) {
        rep.status = 'FAILED';
        rep.note = `Spec incelemesi yapılamadı: ${err instanceof Error ? err.message : String(err)}`;
        this.emit('CLARIFICATION', rep.note, undefined, 'warn');
        report.assumptions.push(`[${SPEC_CLARIFICATION_TASK_ID}] ${rep.note}`);
        return {};
      }
      let proposal = normalizeClarificationProposal(raw, taskIds);
      let { ok, bad } = partitionTurkish(proposal);
      if (bad.length) {
        // One repair call asking for Turkish; whatever is still not Turkish is dropped.
        try {
          const raw2 = await llmJson(system, user, [
            { role: 'assistant', content: JSON.stringify(raw).slice(0, 20_000) },
            { role: 'user', content: TURKISH_REPAIR_PROMPT },
          ]);
          proposal = normalizeClarificationProposal(raw2, taskIds);
          ({ ok, bad } = partitionTurkish(proposal));
          if (!(raw2 as { plan?: unknown })?.plan) (raw2 as Record<string, unknown>).plan = (raw as { plan?: unknown })?.plan;
          raw = raw2;
        } catch {
          /* keep the first result */
        }
        for (const q of bad) report.assumptions.push(`[${SPEC_CLARIFICATION_TASK_ID}] Türkçe olmayan soru atlandı: ${q.question.slice(0, 120)}`);
      }
      for (const w of proposal.warnings) report.assumptions.push(`[${SPEC_CLARIFICATION_TASK_ID}] ${w}`);
      // The approach plan rides in the same IdP screen as the questions (one passkey round).
      const plan = planOn ? normalizeApproachPlan((raw as { plan?: unknown } | null)?.plan) : null;
      if (plan) {
        // IdP screen holds at most 12 items: an improvement makes room for the plan.
        while (ok.length >= 12) {
          const i = ok.map((q) => q.kind).lastIndexOf('IMPROVEMENT');
          ok.splice(i >= 0 ? i : ok.length - 1, 1);
        }
        ok.push(planQuestion(plan));
        report.approachPlan = renderPlanTr(plan);
        this.decide('PLAN', 'Yaklaşım planı hazırlandı, onaya sunuldu', 'Görevlere başlamadan önce yaklaşım, riskler ve sıra ürün sahibine gösterilsin diye.', SPEC_CLARIFICATION_TASK_ID);
        this.emit('CLARIFICATION', `Director yaklaşım planı hazırladı (onayınıza sunuluyor): ${monitorText(plan.approach, 300)}`);
      }
      st = {
        schemaVersion: 1,
        specFingerprint: fp,
        projectId: ctx.projectId,
        status: ok.length ? 'PENDING' : 'NONE',
        summary: proposal.summary,
        questions: ok,
        updatedAt: new Date().toISOString(),
      };
      await saveClarificationState(projectRoot, st);
      if (!ok.length) {
        rep.status = 'NONE';
        rep.summary = proposal.summary;
        this.emit('CLARIFICATION', 'Director spec\'i inceledi: sorulacak açık nokta yok.');
        return {};
      }
    }

    // 2) One IdP interaction with every question (or auto-apply recommendations without a channel).
    let resolver: ClarificationResolver | null = null;
    if (ctx.decisionMode === 'ask') {
      if (this.options.clarificationResolver !== undefined) resolver = this.options.clarificationResolver;
      else if (isExternalIdpConfigured(this.env)) {
        resolver = new IdpClarificationResolver({
          env: this.env,
          fetchFn: this.options.idpFetchFn,
          provider: this.options.identityProvider ?? createTrustedIdentityProvider({ env: this.env, nonceStore: new NonceStore({ baseDir: projectRoot }) }),
        });
      }
    }
    if (!resolver) {
      st.status = 'AUTO_RECOMMENDED';
      st.answers = st.questions.map((q) => ({ questionId: q.id, selectedOptionId: q.recommendedOptionId }));
      await saveClarificationState(projectRoot, st);
      report.assumptions.push(`[${SPEC_CLARIFICATION_TASK_ID}] Netleştirme kanalı yok (IdP yapılandırılmamış ya da AIDM_DECISION_MODE=assume): önerilen seçenekler uygulandı.`);
      return finalize(st, 'AUTO_RECOMMENDED');
    }
    const req = buildClarificationRequest({
      projectRoot,
      projectId: ctx.projectId,
      runId: ctx.runId,
      packageId: ctx.packageId,
      revision: ctx.revision,
      summary: st.summary,
      questions: st.questions,
    });
    st.status = 'PENDING';
    st.decisionId = req.decisionId;
    st.runId = ctx.runId;
    await saveClarificationState(projectRoot, st);
    rep.decisionId = req.decisionId;
    report.decisions.push({ decisionId: req.decisionId, taskId: SPEC_CLARIFICATION_TASK_ID, question: req.title, state: 'PENDING', channel: resolver.channel });
    this.pendingDecisionIds.add(req.decisionId);
    this.emit('DECISION_REQUESTED', `${req.decisionId}: ${req.title}`, SPEC_CLARIFICATION_TASK_ID);
    const outcome = await resolver.resolve(req, async (url) => {
      st!.decisionUrl = url;
      await saveClarificationState(projectRoot, st!);
      if (url) this.emit('CLARIFICATION', `Sorular IdP'de cevap bekliyor: ${url}`, SPEC_CLARIFICATION_TASK_ID);
    });
    this.pendingDecisionIds.delete(req.decisionId);
    const dRep = report.decisions.find((d) => d.decisionId === req.decisionId)!;
    if (outcome.status !== 'ANSWERED') {
      st.status = outcome.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
      st.failure = outcome.reason;
      await saveClarificationState(projectRoot, st);
      dRep.state = st.status;
      rep.status = st.status;
      rep.note = outcome.reason;
      return {
        stop: {
          status: 'BLOCKED_ON_HUMAN',
          reason:
            `Spec netleştirme soruları cevaplanmadı (${outcome.status}: ${outcome.reason}). Hiçbir görev başlatılmadı. ` +
            'Devam etmek için çalışmayı aynı spec ile yeniden başlat (aidm_autonomous_start ya da `aidm run --spec <spec> --approval idp`): ' +
            'aynı sorular Director yeniden çağrılmadan IdP\'ye tekrar gönderilir. Soru sorulmasın istersen spec\'e `Netleştirme: kapalı` ekle.',
        },
      };
    }
    st.status = 'ANSWERED';
    st.answers = outcome.answers;
    {
      // Learn reusable preferences from the PO's own answers (local file + IdP "Tercihlerim").
      const learned = [...learnPreferences(st.questions, outcome.answers, report.projectName)];
      const pc = planCorrectionPreference(outcome.answers, report.projectName);
      if (pc) learned.push(pc);
      if (learned.length) await syncPreferences(this.env, this.options.idpFetchFn ?? fetch, learned).catch(() => undefined);
    }
    st.answeredBy = outcome.answeredBy;
    st.answeredAt = outcome.answeredAt;
    dRep.state = 'ANSWERED';
    dRep.answer = outcome.answers;
    for (const a of outcome.answers) {
      const q = st.questions.find((x) => x.id === a.questionId);
      if (!q) continue;
      const opt = q.options?.find((o) => o.id === a.selectedOptionId);
      if (q.id === PLAN_QUESTION_ID) {
        this.decide(
          'PLAN',
          a.selectedOptionId === 'duzelt' || (a.freeText && a.selectedOptionId !== 'onay') ? 'Yaklaşım planı düzeltmeyle onaylandı' : 'Yaklaşım planı onaylandı',
          a.freeText ? `Ürün sahibinin düzeltmesi plana işlendi: ${a.freeText}` : 'Ürün sahibi planı passkey ile onayladı.',
          SPEC_CLARIFICATION_TASK_ID
        );
        continue;
      }
      this.decide(
        'DESIGN',
        `${q.question} → ${opt?.label ?? (a.freeText ? 'serbest cevap' : 'seçilmedi')}`,
        a.freeText ? `Ürün sahibinin cevabı: ${a.freeText}` : 'Ürün sahibinin netleştirme cevabı (bağlayıcı).',
        SPEC_CLARIFICATION_TASK_ID
      );
    }
    this.emit('DECISION_ANSWERED', `${req.decisionId}: ${outcome.answers.length} cevap`, SPEC_CLARIFICATION_TASK_ID);
    // 3) Free-text-only answers -> measurable criteria by the Director (no human interaction).
    const freeOnly = outcome.answers.filter((a) => a.freeText && !a.selectedOptionId);
    if (freeOnly.length) {
      try {
        const raw = (await llmJson(
          FREE_TEXT_SYSTEM_PROMPT,
          JSON.stringify(
            freeOnly.map((a) => ({ questionId: a.questionId, question: st!.questions.find((q) => q.id === a.questionId)?.question, answer: a.freeText }))
          )
        )) as { items?: unknown[] };
        st.freeTextCriteria = (Array.isArray(raw.items) ? raw.items : [])
          .map((i) => (i && typeof i === 'object' ? (i as Record<string, unknown>) : {}))
          .filter((i) => freeOnly.some((a) => a.questionId === i.questionId))
          .map((i) => ({
            questionId: String(i.questionId),
            criteria: (Array.isArray(i.criteria) ? i.criteria : []).map((c) => String(c).slice(0, 300)).filter(Boolean).slice(0, 8),
            appliesTo: (Array.isArray(i.appliesTo) ? i.appliesTo : []).map(String).filter((t) => report.tasks.some((x) => x.taskId === t)),
            checks: (Array.isArray(i.checks) ? i.checks : []).map(normalizeCheck).filter((c): c is NonNullable<ReturnType<typeof normalizeCheck>> => !!c).slice(0, 6),
          }));
      } catch (err) {
        report.assumptions.push(`[${SPEC_CLARIFICATION_TASK_ID}] Serbest cevaplar kritere çevrilemedi (${err instanceof Error ? err.message : String(err)}); Director'a bağlayıcı not olarak iletilecek.`);
      }
    }
    await saveClarificationState(projectRoot, st);
    return finalize(st, 'ANSWERED');
  }

  private emit(type: string, message: string, taskId?: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (this.checkpoint && this.checkpoint.state === 'RUNNING') {
      if (type === 'CYCLE_START') this.checkpoint.inCycle = true;
      else if (type === 'CYCLE_RESULT' || type === 'TASK_ACCEPTED' || type === 'TASK_BLOCKED') this.checkpoint.inCycle = false;
      this.writeCheckpoint();
    }
    try {
      this.options.onEvent?.({ type, message, taskId, at: new Date().toISOString() });
    } catch {
      /* listener errors never affect the run */
    }
    if (this.ideRoot) noteIdeEvent(this.ideRoot, { type, message, taskId: taskId ?? null, level });
    if (this.monitor) {
      this.monitor.event(AutonomousSpecRunner.MONITOR_TYPES[type] ?? 'INFO', message, taskId ?? null, level);
      if (type !== 'CYCLE_START') this.pushSnapshot();
    }
  }

  /** Builds a secret-free monitor snapshot from the live report (never throws). */
  private snapshotInput(): RunMonitorSnapshotInput | null {
    const rep = this.currentReport;
    if (!rep) return null;
    try {
      const b = rep.budget ?? this.liveBudget?.() ?? { limitUsd: this.options.budgetUsd ?? 0, committedUsd: 0, reservedUsd: 0 };
      const model = typeof rep.provider?.model === 'string' ? rep.provider.model : undefined;
      return {
        runId: rep.runId,
        projectId: rep.projectId,
        projectName: rep.projectName,
        entryPoint: rep.entryPoint === 'aidm_autonomous_start' ? 'aidm_autonomous_start' : 'aidm_run_spec',
        status: this.monitorStatus,
        startedAt: rep.startedAt,
        finishedAt: rep.finishedAt ?? null,
        ...(model ? { model } : {}),
        budget: { limitUsd: b.limitUsd, committedUsd: b.committedUsd, reservedUsd: b.reservedUsd },
        currentTaskId: this.currentTaskId,
        tasks: rep.tasks.map((t) => ({
          taskId: t.taskId,
          title: t.title,
          status: t.status,
          cycles: t.cycles,
          ...(this.maxAttemptsOf(t.taskId) !== undefined ? { maxAttempts: this.maxAttemptsOf(t.taskId) } : {}),
          lastSummary: t.lastSummary ?? null,
        })),
        lastDirectorAction: this.lastDirectorAction ?? null,
        pendingApprovalId: null,
        pendingDecisionIds: [...this.pendingDecisionIds],
        stopReason: rep.stopReason ?? null,
      };
    } catch {
      return null;
    }
  }

  private pushSnapshot(immediate = false): void {
    if (!this.monitor) return;
    const snap = this.snapshotInput();
    if (snap) this.monitor.snapshot(snap, immediate);
  }

  async run(): Promise<AutonomousRunReport> {
    const projectRoot = path.resolve(this.options.projectRoot);
    const specPath = path.resolve(this.options.specPath);
    const entryPoint = this.options.entryPoint ?? 'aidm run --spec';
    const dryRun = Boolean(this.options.dryRun);
    const resumeRunId = this.options.resumeRunId;
    if (resumeRunId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(resumeRunId)) {
      throw new AutonomousRunError(`Invalid resume runId '${resumeRunId}'`, 'INVALID_RUN_ID');
    }
    const runId = resumeRunId
      ? resumeRunId
      : this.options.runId && /^[A-Za-z0-9._:-]{1,128}$/.test(this.options.runId)
        ? this.options.runId
        : `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      throw new AutonomousRunError(`Project root does not exist: ${projectRoot}`, 'PROJECT_ROOT_MISSING');
    }
    let markdown: string;
    let specBundle: SpecBundle;
    try {
      specBundle = await loadSpecBundle(specPath);
      markdown = specBundle.markdown;
    } catch (err) {
      throw new AutonomousRunError(
        `Cannot read spec file '${specPath}': ${err instanceof Error ? err.message : String(err)}`,
        err instanceof SpecBundleError ? err.code : 'SPEC_UNREADABLE'
      );
    }
    // Task-scoped spec delivery: small specs go to the Director verbatim; large / multi-document
    // specs get a stable global frame + the FULL governing sections per task (never cut mid-text).
    const specContext = new SpecContext(markdown, {
      inlineChars: resolveSpecInlineChars(this.env),
      sourceFiles: specBundle.files.map((f) => f.relPath),
    });

    // Pinned for the project's lifetime: a task that creates/renames package.json (scaffolding)
    // must not change the projectId mid-run (every later task would fail as "cross-project").
    const canonical = pinCanonicalProjectIdentity(projectRoot);
    const projectId = canonical.projectId;
    const wsStatus = await detectWorkspaceStatus(projectRoot);
    const ingestion = new SpecIngestor().ingest(markdown, {
      projectId,
      specPath: path.relative(projectRoot, specPath).startsWith('..') ? specPath : path.relative(projectRoot, specPath),
      maxAttemptsPerTask: Math.max(1, Math.min(10, Math.floor(this.options.maxCyclesPerTask ?? 3))),
      isInitialized: wsStatus.isInitialized,
    });

    const mandateStore = new ProjectMandateStore({
      baseDir: projectRoot,
      identityManager: this.options.identityManager,
      // Same env the run was configured with (MCP/CLI may pass an explicit env, not process.env).
      identityProvider:
        this.options.identityProvider ??
        createTrustedIdentityProvider({ env: this.env, nonceStore: new NonceStore({ baseDir: projectRoot }) }),
    });
    const previousMandate = await mandateStore.loadMandate();
    // The approved spec's own page/target files are inside the mandate (root-level pages such as
    // hakkimda.html are not default directories), plus paths the PO approved by passkey decision
    // for this spec (applied when the next segment seals a new mandate).
    const specTargets = [...new Set(ingestion.requirements.flatMap((r) => [...r.targetFiles]))].filter((f) => !/[*?[{]/.test(f));
    const mandateDraft = buildAutonomousMandate({
      projectId,
      allowedPaths: [...new Set([...ingestion.allowedPaths, ...specTargets, ...loadMandateExtensions(projectRoot, ingestion.specFingerprint)])],
      validityHours: this.options.mandateValidityHours,
      previous: previousMandate,
    });

    const report: AutonomousRunReport = {
      runId,
      status: 'DRY_RUN_OK',
      dryRun,
      projectId,
      projectRoot,
      projectName: ingestion.projectName,
      specPath,
      specFingerprint: ingestion.specFingerprint,
      entryPoint,
      startedAt: new Date().toISOString(),
      plan: ingestion.plan,
      assumptions: [...ingestion.assumptions],
      warnings: [...ingestion.warnings],
      mandate: summarizeMandate(mandateDraft),
      tasks: ingestion.tasks
        .filter((t) => t.hierarchy_level === 'TASK')
        .map((t) => ({
          taskId: t.task_id,
          title: t.title,
          status: 'PENDING' as const,
          cycles: 0,
          evidenceIds: [],
          verificationChecks: [],
          filesChanged: [],
        })),
      commits: [],
      decisions: [],
      refinements: [],
      executorReports: [],
      deferredCommands: [],
      instructions: [],
    };
    this.currentReport = report;
    {
      // Karar günlüğü: live markdown under .ai-manager/reports + DECISION_LOG monitor events.
      const logOn = this.env.AIDM_DECISION_LOG !== '0' && !dryRun;
      const seed = logOn && !dryRun ? loadDecisionSeed(projectRoot, runId) : [];
      this.decisionLog = logOn
        ? new DecisionLog(dryRun ? null : projectRoot, runId, (e) => this.emit('DECISION_LOG', decisionEventMessage(e), e.taskId ?? undefined), seed)
        : null;
      if (this.decisionLog) report.decisionLogPath = this.decisionLog.filePath ?? undefined;
      if (!dryRun) {
        try {
          const archIntent = generateArchitectureIntentReport({
            projectId,
            projectName: ingestion.projectName,
            specFingerprint: ingestion.specFingerprint,
            techStack: ingestion.techStack,
          });
          saveArchitectureIntentReport(projectRoot, archIntent);
        } catch {
          /* best-effort persistence */
        }
      }
      const arr = report.assumptions;
      const push = Array.prototype.push;
      Object.defineProperty(arr, 'push', {
        enumerable: false,
        configurable: true,
        value: (...items: string[]): number => {
          for (const it of items) {
            const { taskId, text } = splitAssumption(String(it));
            const tr = assumptionTr(text);
            this.decide(/görev kapsamını genişletti/.test(tr) ? 'SCOPE' : 'ASSUMPTION', tr, '', taskId);
          }
          return push.apply(arr, items);
        },
      });
      if (!resumeRunId) {
        for (const a of ingestion.assumptions) {
          const { taskId, text } = splitAssumption(a);
          this.decide('ASSUMPTION', assumptionTr(text), 'Spec\'te açıkça belirtilmediği için varsayıldı.', taskId);
        }
        for (const t of report.tasks) this.decide('TASK_CREATE', `${t.taskId}: ${t.title}`, 'Spec\'teki görev listesinden oluşturuldu.', t.taskId);
      }
    }
    // ------------------------------------------------------------------ resume pre-checks
    let resumeFrom: RunCheckpoint | null = null;
    if (resumeRunId && !dryRun) {
      resumeFrom = loadCheckpoint(projectRoot, resumeRunId);
      const refuse = (why: string) => this.finish(report, 'CONFIGURATION_ERROR', `Cannot resume ${resumeRunId}: ${why}`, false);
      if (!resumeFrom) return refuse('no checkpoint for this run in this project.');
      const live = runLiveness(projectRoot, resumeFrom);
      if (live === 'FINISHED' && !isResumableBlockedRun(resumeFrom)) return refuse(`the run already finished (${resumeFrom.status ?? 'FINISHED'}); start a new run instead.`);
      if (live === 'ALIVE') return refuse(`the run is still active (pid ${readRunLock(projectRoot)?.pid}); it is not interrupted.`);
      if (resumeFrom.specFingerprint !== ingestion.specFingerprint) {
        return refuse('the spec file changed since the run started (fingerprint mismatch); start a new run.');
      }
      if (this.options.budgetUsd !== undefined && this.options.budgetUsd !== resumeFrom.budgetUsd) {
        return refuse(`the budget cap is fixed at $${resumeFrom.budgetUsd} for this run (got $${this.options.budgetUsd}).`);
      }
      if (resumeFrom.approval === 'idp' && this.options.authContext?.authSource !== 'EXTERNAL_IDP') {
        return this.finish(report, 'BLOCKED_ON_AUTH_CONTEXT', `Run ${resumeRunId} was approved with an IdP passkey; resuming requires a NEW IdP passkey approval (--approval idp).`, false);
      }
      report.commits.push(...resumeFrom.commits);
    }
    if (!dryRun) {
      this.monitor = RunMonitor.create({
        env: this.env,
        runId,
        fetchFn: this.options.idpFetchFn,
        // Resumed segment: continue strictly above every seq the IdP may have seen.
        ...(resumeFrom ? { startSeq: Math.max(resumeFrom.monitorSeq + 1, (resumeFrom.segment + 1) * 1_000_000) } : {}),
      });
      if (this.monitor) {
        const url = runMonitorUrl(this.env, runId);
        if (url) {
          report.monitorUrl = url;
          try {
            this.options.onMonitorUrl?.(url);
          } catch {
            /* ignore */
          }
        }
        this.emit(
          'RUN_STARTED',
          resumeFrom
            ? `Kesilen çalışma devam ediyor (bölüm ${resumeFrom.segment + 1}): ${ingestion.projectName}`
            : `Otonom çalışma başladı: ${ingestion.projectName}`
        );
        this.pushSnapshot(true);
      }
    }
    for (const a of ingestion.assumptions) this.emit('ASSUMPTION', a);
    let decisionMode: DecisionMode;
    try {
      decisionMode = this.options.decisionMode ?? resolveDecisionMode(this.env);
    } catch (err) {
      return this.finish(report, 'CONFIGURATION_ERROR', err instanceof Error ? err.message : String(err));
    }

    // Provider configuration is described (secret-free) even in dry-run.
    let providerConfig: ResolvedLlmProviderConfig | null = null;
    if (!this.options.llmProvider) {
      try {
        providerConfig = resolveLlmProviderConfig(this.env);
        report.provider = describeLlmProviderConfig(providerConfig);
      } catch (err) {
        report.provider = { error: err instanceof Error ? err.message : String(err) };
        if (!dryRun) return this.finish(report, 'CONFIGURATION_ERROR', report.provider.error as string);
      }
    } else {
      report.provider = {
        kind: 'injected',
        providerName: this.options.llmProvider.providerName,
        model: this.options.llmProvider.defaultModel,
      };
    }

    if (dryRun) {
      this.emit('DRY_RUN', `Spec ingested: ${report.tasks.length} task(s); no state written, no LLM/AGY calls.`);
      return this.finish(report, 'DRY_RUN_OK', undefined, false);
    }

    // ---------------------------------------------------------------- budget gate
    const budgetUsd = resumeFrom ? resumeFrom.budgetUsd : this.options.budgetUsd ?? parseBudget(this.env.AIDM_BUDGET_USD);
    if (budgetUsd === undefined || !(budgetUsd > 0)) {
      return this.finish(
        report,
        'CONFIGURATION_ERROR',
        'A positive budget is required for live runs (--budget-usd N or AIDM_BUDGET_USD). Budget control cannot be bypassed.'
      );
    }
    // ADR-16: an authorized budget period has a hard 10 USD ceiling. Never silently cap: fail closed.
    const maxPeriodUsd = nanoUsdToUsd(MAX_PERIOD_BUDGET_NANO_USD);
    if (budgetUsd > maxPeriodUsd) {
      return this.finish(
        report,
        'CONFIGURATION_ERROR',
        `Budget $${budgetUsd} exceeds the ADR-16 per-period ceiling of $${maxPeriodUsd}. ` +
          `Use --budget-usd <= ${maxPeriodUsd}; a further period requires a new explicit human authorization.`
      );
    }

    // ---------------------------------------------------------------- authorization
    const lockPath = path.join(projectRoot, AUTONOMOUS_RUN_LOCK_FILE);
    let authContext = this.options.authContext;
    if (!authContext) {
      if (entryPoint !== 'aidm run --spec') {
        return this.finish(
          report,
          'BLOCKED_ON_AUTH_CONTEXT',
          'MCP callers must provide a human-originated, verifiable authContext (external IdP / trusted IDE). ' +
            'LLM agents cannot self-authorize an autonomous mandate. Run `aidm run --spec` from your own shell instead.'
        );
      }
      try {
        authContext = await signOperatorInvocation(
          {
            projectId,
            specFingerprint: ingestion.specFingerprint,
            specPath,
            entryPoint,
            budgetUsd,
          },
          this.options.identityManager ?? new IdentityManager({ baseDir: projectRoot })
        );
      } catch (err) {
        return this.finish(
          report,
          'BLOCKED_ON_AUTH_CONTEXT',
          `Operator identity unavailable: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (this.options.preboundApproval && this.options.preboundApproval.revision !== 1) {
      return this.finish(report, 'BLOCKED_ON_AUTH_CONTEXT', 'Pre-bound approval revision must be 1 (new package).');
    }
    // ---------------------------------------------------------------- lock / interrupted runs
    {
      const lock = readRunLock(projectRoot);
      const live = lockLiveness(lock);
      if (live === 'ALIVE') {
        return this.finish(
          report,
          'BLOCKED_ON_AUTH_CONTEXT',
          `BLOCKED_ON_AUTH_CONTEXT: an autonomous run is already active for this project (${lockPath}, run ${lock?.runId || '?'}, pid ${lock?.pid}). ` +
            'Nested mandate sealing from inside a run is refused.',
          false
        );
      }
      const interrupted = listInterruptedRuns(projectRoot).filter((c) => c.runId !== runId);
      if (!resumeFrom && interrupted.length > 0 && !this.options.abandonInterrupted) {
        const last = interrupted[interrupted.length - 1];
        return this.finish(
          report,
          'CONFIGURATION_ERROR',
          `An interrupted run exists for this project: ${last.runId} (started ${last.startedAt}). ` +
            `Resume it with \`aidm run --spec <spec> --resume ${last.runId}\` (MCP: aidm_autonomous_start { resumeRunId }), ` +
            'or start fresh with --abandon-interrupted (MCP: abandonInterrupted: true).',
          false
        );
      }
      for (const c of interrupted) {
        c.state = 'FINISHED';
        c.status = 'ABANDONED';
        c.stopReason = `Abandoned by a new run ${runId}.`;
        saveCheckpoint(c);
      }
      if (lock && live === 'STALE') await fs.promises.rm(lockPath, { force: true });
    }
    await this.options.onRunId?.(runId);
    let sealed: { mandate: ProjectMandate; provenance: AutonomousAuthorizationProvenance };
    try {
      sealed = await sealAutonomousMandate(mandateStore, mandateDraft, authContext, {
        specFingerprint: ingestion.specFingerprint,
        entryPoint,
      });
    } catch (err) {
      return this.finish(report, 'BLOCKED_ON_AUTH_CONTEXT', err instanceof Error ? err.message : String(err), !resumeFrom);
    }
    report.authorization = sealed.provenance;
    report.mandate = summarizeMandate(sealed.mandate);
    this.emit('MANDATE_SEALED', `Mandate revision ${sealed.mandate.mandateRevision} sealed by ${sealed.provenance.authSource}.`);

    const lockRec = { runId, pid: process.pid, startedAt: report.startedAt, heartbeatAt: new Date().toISOString() };
    writeRunLock(projectRoot, lockRec);
    const heartbeat = setInterval(() => {
      try {
        lockRec.heartbeatAt = new Date().toISOString();
        writeRunLock(projectRoot, lockRec);
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    this.checkpoint = {
      runId,
      projectRoot,
      specPath,
      specFingerprint: ingestion.specFingerprint,
      entryPoint,
      approval: sealed.provenance.authSource === 'EXTERNAL_IDP' ? 'idp' : 'cli',
      budgetUsd,
      maxCyclesPerTask: this.options.maxCyclesPerTask,
      mandateHours: this.options.mandateValidityHours,
      startedAt: resumeFrom?.startedAt ?? report.startedAt,
      state: 'RUNNING',
      segment: (resumeFrom?.segment ?? 0) + 1,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      currentTaskId: null,
      inCycle: false,
      tasks: [],
      commits: [],
      monitorSeq: resumeFrom?.monitorSeq ?? 0,
      ...(this.options.logPath ? { logPath: this.options.logPath } : resumeFrom?.logPath ? { logPath: resumeFrom.logPath } : {}),
    };
    this.writeCheckpoint();

    let budgetManager: BudgetManager | undefined;
    try {
      // ------------------------------------------------------------ git baseline
      if (resumeFrom) {
        // The interrupted attempt restarts cleanly from the last AIDM commit (changes stashed, not lost).
        const st = await stashInterruptedChanges(projectRoot, runId).catch((err: unknown) => {
          throw new Error(`Cannot reset the interrupted attempt: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.emit(
          'RESUMED',
          st.stashed
            ? `Kesilen denemenin commitlenmemiş değişiklikleri git stash'e alındı (${st.files.length} dosya); son AIDM commitinden devam.`
            : 'Çalışma ağacı temiz; son AIDM commitinden devam.'
        );
      }
      await ensureGitRepository(projectRoot);
      const baseline = await createGitBaseline(projectRoot, specPath);
      if (!baseline.ok) {
        return this.finish(report, 'CONFIGURATION_ERROR', baseline.reason, true);
      }
      if (baseline.commit) report.commits.push(baseline.commit);

      // ------------------------------------------------------------ stores
      const historyManager = new HistoryManager({ baseDir: projectRoot });
      const specStore = new SpecStore({ baseDir: projectRoot });
      const sessionStore = new DirectorSessionStore({ baseDir: projectRoot, historyManager });
      const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: projectRoot });
      const approvalStore = new ApprovalStore({ baseDir: projectRoot, historyManager });
      const approvalPackageEngine = new ApprovalPackageEngine();
      const durableStateManager = new DurableStateManager({ baseDir: projectRoot });
      const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: projectRoot });

      await specStore.saveRequirements(
        ingestion.requirements.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          acceptanceCriteria: [...r.acceptanceCriteria],
        })) as never
      );
      const existingTasks = await specStore.loadTasks().catch(() => []);
      const accepted = new Set(existingTasks.filter((t) => t.status === 'ACCEPTED').map((t) => t.task_id));
      // The sealed spec is re-written as the authoritative task set (accepted ones stay ACCEPTED).
      // Non-accepted tasks (e.g. REJECTED by an earlier fail-closed stop) restart READY; runner
      // additions from an earlier run (criteria/scope from clarification answers) are replaced and
      // re-applied below, so the same-revision guard of the store does not apply here.
      await specStore.saveTasks(
        ingestion.tasks.map((t) => (accepted.has(t.task_id) ? { ...t, status: 'ACCEPTED' } : t)) as never,
        { bypassValidation: true }
      );

      // Approval package: approved by the SAME verified human operator invocation.
      const draft = approvalPackageEngine.buildPackage(ingestion.understanding, ingestion.plan, {
        packageId:
          this.options.preboundApproval?.packageId ?? `pkg-autonomous-${ingestion.specFingerprint.slice(0, 12)}-${Date.now()}`,
      });
      if (this.options.preboundApproval && draft.revision !== this.options.preboundApproval.revision) {
        return this.finish(report, 'BLOCKED_ON_AUTH_CONTEXT', 'Approval package revision differs from the externally approved binding.', true);
      }
      const approved = approvalPackageEngine.approvePackage(draft, {
        packageId: draft.packageId,
        revision: draft.revision,
        actor: 'USER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        comment: `Approved by explicit operator invocation '${entryPoint}' for spec sha256:${ingestion.specFingerprint}`,
        provenanceSource: 'AIDM_AUTONOMOUS_SPEC_RUN',
        isTrustedHumanAuth: true,
        authStatus: 'VERIFIED_HUMAN',
        authContext: {
          isTrusted: true,
          authSource: sealed.provenance.authSource,
          actorId: sealed.provenance.identityId,
          verifiedAt: sealed.provenance.sealedAt,
        },
      });
      await approvalStore.savePackage(approved);

      const session = await sessionEngine.createSession({
        workspaceRoot: projectRoot,
        projectId,
        actor: Actor.DIRECTOR,
        metadata: { runId, mode: 'AUTONOMOUS_NO_QUESTIONS', specFingerprint: ingestion.specFingerprint },
      } as never);

      const previousState = await durableStateManager.load().catch(() => null);
      await durableStateManager.save({
        ...(previousState ?? {}),
        schemaVersion: 1,
        currentLifecycleState: LifecycleState.TASK_LOOP,
        completedTaskIds: [...accepted],
        activeTaskId: null,
        blockedState: null,
        continuationState: 'NONE',
        continuationPolicy: 'AUTONOMOUS',
      } as never);

      // ------------------------------------------------------------ budget + LLM
      budgetManager = new BudgetManager({
        dbPath: path.join(projectRoot, '.ai-manager', 'state', 'budget', `${runId}.db`),
        historyManager,
      });
      budgetManager.open();
      if (resumeFrom && budgetManager.getGlobalAccount()) {
        // Same ledger, same cap: spend so far carries over (no new period => committed is NOT reset).
        // Holds left by the killed process are recovered (prepared -> released, dispatched -> unknown, still counted).
        budgetManager.recover();
      } else {
        budgetManager.createGlobalAccount(budgetUsd);
        // Record this invocation as an explicitly operator-authorized ADR-16 budget period.
        budgetManager.authorizeBudgetPeriod({ limit: budgetUsd, authorizedBy: `operator:${entryPoint}:${runId}` });
      }
      {
        const bm = budgetManager;
        this.liveBudget = () => {
          const acc = bm.getGlobalAccount();
          return acc
            ? {
                limitUsd: nanoUsdToUsd(acc.limitSpendNanoUsd),
                committedUsd: nanoUsdToUsd(acc.committedSpendNanoUsd),
                reservedUsd: nanoUsdToUsd(acc.reservedSpendNanoUsd),
              }
            : { limitUsd: budgetUsd, committedUsd: 0, reservedUsd: 0 };
        };
      }

      let baseProvider: LLMProvider;
      if (this.options.llmProvider) {
        baseProvider = this.options.llmProvider;
        this.options.registerBudgetTerms?.(budgetManager);
      } else {
        try {
          registerProviderBudgetTerms(providerConfig!, budgetManager);
          report.provider = describeLlmProviderConfig(providerConfig!, budgetManager);
          baseProvider = createConfiguredLlmProvider(providerConfig!, this.env);
        } catch (err) {
          return this.finish(report, 'CONFIGURATION_ERROR', err instanceof Error ? err.message : String(err), true, budgetManager);
        }
      }
      const provider = budgetManager.wrapProvider(baseProvider, { env: this.env });
      {
        // Prompt-cache statistics (provider-reported cached input tokens; billed at the cached rate).
        const pc = (report.promptCache = { calls: 0, inputTokens: 0, cachedTokens: 0 });
        const gen = provider.generate.bind(provider);
        (provider as { generate: typeof gen }).generate = (async (req: never) => {
          const res = await gen(req);
          try {
            const u = (res as { usage?: { reported_input_tokens?: number | null; reported_cached_tokens?: number | null } } | null)?.usage;
            pc.calls++;
            pc.inputTokens += Number(u?.reported_input_tokens ?? 0) || 0;
            pc.cachedTokens += Number(u?.reported_cached_tokens ?? 0) || 0;
          } catch {
            /* statistics only */
          }
          return res;
        }) as typeof gen;
      }

      // Executor mode: 'ide' (default, the agent open in Antigravity pulls tasks via MCP),
      // 'cli' (spawn agy per task) or 'cli-session' (agy, one conversation reused across tasks).
      // The aidm watcher learns every project a run was started in (resume button works without reinstall).
      registerWatcherRoot(projectRoot, this.env);
      const executorMode = resolveExecutorMode(markdown, this.env);
      report.executorMode = executorMode;
      const ideExecutor = executorMode === 'ide' && (!this.options.executorPort || this.options.executorPort.executorId === IDE_EXECUTOR_ID);
      if (ideExecutor) {
        resetIdeMailbox(projectRoot);
        this.ideRoot = projectRoot;
      }
      // Spec sections governing the task being executed, appended to the executor prompt.
      // Assigned once task definitions exist (below); until then nothing is appended.
      const specAugment: { fn: (taskId: string) => string | null } = { fn: () => null };
      const executorPort =
        this.options.executorPort ??
        new AntigravityAdapter({
          workspaceRoot: projectRoot,
          binaryPath: this.env.AIDM_AGY_PATH ?? 'agy',
          processRunner: new NodeAntigravityProcessRunner(),
          ...agyTimeouts(this.env),
          promptAugmenter: (taskId: string) => specAugment.fn(taskId),
          ...(executorMode === 'ide'
            ? { requestInvoker: createIdeRequestInvoker(projectRoot), executorId: IDE_EXECUTOR_ID, ...ideTimeouts(this.env) }
            : {}),
          ...(executorMode === 'cli-session'
            ? { sessionFile: path.join(projectRoot, '.ai-manager', 'state', 'agy-session.json') }
            : {}),
        });
      if (ideExecutor) {
        this.emit('INSTRUCTION', "Yürütücü: IDE modu. Antigravity'deki ajan aidm_next_task ile görevleri alacak, aidm_submit_task ile teslim edecek.");
      }
      const availability = executorPort.checkAvailability
        ? await executorPort.checkAvailability()
        : { available: true };
      if (!availability.available) {
        return this.finish(
          report,
          'CONFIGURATION_ERROR',
          `Executor (AGY) unavailable: ${(availability as { reason?: string }).reason ?? 'unknown'}. Set AIDM_AGY_PATH.`,
          true,
          budgetManager
        );
      }

      let outputSettings: DirectorOutputSettings;
      try {
        outputSettings = resolveDirectorOutputSettings(this.env);
      } catch (err) {
        return this.finish(report, 'CONFIGURATION_ERROR', err instanceof Error ? err.message : String(err), true, budgetManager);
      }
      const directorRuntime = new DirectorRuntime({
        decisionOutput: outputSettings,
        sessionStore,
        sessionEngine,
        historyManager,
        llmProvider: provider,
        allowMockProvider: this.options.allowMockProvider ?? false,
        defaultModel: baseProvider.defaultModel,
      });
      // Global spec commands: per task only when the files they reference already exist;
      // all of them (plus command-like global criteria) at the final run-level gate.
      const specCollector = new SpecVerificationEvidenceCollector(
        { evidenceStore },
        toVerificationCommands(ingestion.verificationCommands),
        projectRoot
      );
      const policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager, specStore, evidenceStore });
      const coordinator = new ClosedLoopCoordinator({
        workspaceRoot: projectRoot,
        sessionStore,
        sessionEngine,
        approvalStore,
        approvalPackageEngine,
        specStore,
        durableStateManager,
        historyManager,
        evidenceStore,
        evidenceCollector: specCollector,
        directorRuntime,
        executorPort,
        authorizationPolicyEngine: policyEngine,
        ...(typeof this.options.actionDispatcher === 'function'
          ? {
              actionDispatcher: this.options.actionDispatcher({
                workspaceRoot: projectRoot,
                historyManager,
                specStore,
                evidenceStore,
                approvalStore,
                approvalPackageEngine,
                authorizationPolicyEngine: policyEngine,
              }),
            }
          : this.options.actionDispatcher
            ? { actionDispatcher: this.options.actionDispatcher }
            : {}),
      });
      const synchronizer = new DirectorContextSynchronizer({ workspaceRoot: projectRoot, sessionStore, sessionEngine });

      await historyManager.appendEvent({
        eventType: 'AUTONOMOUS_RUN_STARTED',
        actor: Actor.ORCHESTRATOR,
        taskId: null,
        payload: { runId, specFingerprint: ingestion.specFingerprint, budgetUsd, entryPoint },
      });

      // ------------------------------------------------------------ task loop
      const defaultAttempts = Math.max(1, Math.min(10, Math.floor(this.options.maxCyclesPerTask ?? 3)));
      // Per-task attempt budget: spec override (`Deneme: N`) > --max-cycles > default 3.
      // Only a verified human answer (retry_2) can raise it, by exactly +2 each time.
      const allowedAttempts = new Map<string, number>();
      const attemptsFor = (taskId: string): number => {
        const cur = allowedAttempts.get(taskId);
        if (cur !== undefined) return cur;
        const def = ingestion.tasks.find((t) => t.task_id === taskId) as TaskDefinition | undefined;
        const fromSpec = Number((def?.metadata as Record<string, unknown> | undefined)?.maxAttemptsFromSpec);
        const n = Number.isInteger(fromSpec) && fromSpec >= 1 ? fromSpec : defaultAttempts;
        allowedAttempts.set(taskId, n);
        return n;
      };
      this.maxAttemptsOf = (id) => allowedAttempts.get(id);
      const setSpecMaxAttempts = async (taskId: string, n: number): Promise<void> => {
        try {
          const tasks = await specStore.loadTasks();
          if (tasks.some((t) => t.task_id === taskId)) {
            await specStore.saveTasks(tasks.map((t) => (t.task_id === taskId ? { ...t, max_attempts: n } : t)) as never);
          }
        } catch {
          /* best effort */
        }
      };
      const poNotes: Array<{ text: string; taskId: string | null; id: string }> = [];
      let pauseInstruction: VerifiedInstruction | null = null;
      let clarificationBudget = Math.max(0, this.options.maxClarificationAssumptions ?? 3);
      let stop: { status: AutonomousRunStatus; reason: string } | null = null;
      const maxDecisionsPerTask = Math.max(0, this.options.maxDecisionsPerTask ?? 3);
      const maxRefinements = Math.max(0, this.options.maxRefinementsPerTask ?? 1);
      const maxAnalyses = Math.max(0, this.options.maxAnalysesPerTask ?? 2);
      const originalTaskCount = report.tasks.length;

      // Decision channel: only the Director talks to the human; AGY questions come back to the Director.
      let decisionResolver: DecisionResolver | null = null;
      if (decisionMode === 'ask') {
        if (this.options.decisionResolver !== undefined) decisionResolver = this.options.decisionResolver;
        else if (isExternalIdpConfigured(this.env)) {
          decisionResolver = new IdpDecisionResolver({
            env: this.env,
            provider:
              this.options.identityProvider ??
              createTrustedIdentityProvider({ env: this.env, nonceStore: new NonceStore({ baseDir: projectRoot }) }),
          });
        }
      }
      const policyText = decisionPolicyInstruction(decisionMode, ingestion.decisionPolicy);

      const taskDefs = new Map<string, TaskDefinition>(ingestion.tasks.map((t) => [t.task_id, t as TaskDefinition]));
      const specRef = (t: TaskDefinition | undefined): SpecTaskRef | null =>
        t ? { taskId: t.task_id, title: t.title, description: t.description, acceptanceCriteria: t.acceptance_criteria } : null;
      specAugment.fn = (taskId: string) => {
        const t = taskDefs.get(taskId) ?? (this.currentTaskId ? taskDefs.get(this.currentTaskId) : undefined);
        if (!t) return null;
        const body = specContext.excerptForTask(specRef(t), 24_000);
        return body.trim()
          ? ['', '=== SPECIFICATION (binding ground truth; the project spec is read-only — never edit it) ===', body].join('\n')
          : null;
      };
      const guidance = new Map<string, string>();
      const decisionsAsked = new Map<string, number>();
      const refinementsDone = new Map<string, number>();
      const analysesDone = new Map<string, number>();
      // Analysis policy (spec `İnceleme:`): a separate read-only AGY analysis costs minutes, so by
      // default it only runs for the first task of this run segment and after a failed attempt.
      const analysisPolicy = ingestion.analysisPolicy ?? 'ON_DEMAND';
      let firstSegmentTaskId: string | undefined;
      const analysisRefusals = new Map<string, number>();
      // Director self-check before acceptance (max one repair per task) + periodic progress notes.
      const selfCheckRepairs = new Map<string, number>();
      const selfCheckOn = this.env.AIDM_SELF_CHECK !== '0';
      const noteEvery = progressEvery(markdown, this.env);
      let sinceNote: string[] = [];
      const postProgressNote = async (): Promise<void> => {
        if (!noteEvery || sinceNote.length < noteEvery || isBudgetExhausted(budgetManager!)) return;
        const doneIds = sinceNote;
        sinceNote = [];
        const next = report.tasks.filter((t) => t.status === 'PENDING' && t.kind !== 'ANALYSIS');
        if (!next.length) return; // the completion report covers the end of the run
        try {
          const o = await directorJson({
            provider: provider as never, model: baseProvider.defaultModel, projectId, runId, taskId: PROGRESS_TASK_ID, purpose: 'PROGRESS_NOTE',
            system: PROGRESS_SYSTEM_PROMPT,
            user: buildProgressPrompt({
              done: report.tasks.filter((t) => doneIds.includes(t.taskId)).map((t) => ({ taskId: t.taskId, title: t.title, summary: t.lastSummary, files: t.filesChanged })),
              next: next.map((t) => ({ taskId: t.taskId, title: t.title })),
              warnings: report.assumptions,
              spentUsd: this.liveBudget?.()?.committedUsd,
            }),
            maxTokens: 600,
          });
          const note = renderProgressNote(o);
          if (note) {
            (report.progressNotes ??= []).push(note);
            this.emit('PROGRESS_NOTE', note);
          }
        } catch {
          /* a progress note is informational; never affects the run */
        }
      };
      const selfCheck = async (t: TaskDefinition, files: readonly string[], summary?: string): Promise<{ ok: boolean; doubts: string[] }> => {
        try {
          const o = await directorJson({
            provider: provider as never, model: baseProvider.defaultModel, projectId, runId, taskId: SELF_CHECK_TASK_ID, purpose: 'SELF_CHECK',
            system: SELF_CHECK_SYSTEM_PROMPT,
            user: buildSelfCheckPrompt({
              specExcerpt: specContext.excerptForTask(specRef(t), 14_000),
              task: { taskId: t.task_id, title: t.title, description: t.description, criteria: t.acceptance_criteria },
              files: readChangedFiles(projectRoot, files),
              executorSummary: summary,
            }),
            maxTokens: 800,
          });
          return parseSelfCheck(o);
        } catch {
          return { ok: true, doubts: [] };
        }
      };
      // Out-of-scope changes (no escape/binding/unsafe paths): per-task strikes + the last file list.
      const scopeStrikes = new Map<string, number>();
      const scopeFiles = new Map<string, string[]>();
      const scopeAttemptFiles = new Map<string, string[]>();
      const policyStrikes = new Map<string, number>();
      const unknownFiles = new Map<string, string[]>();
      const nearMissFixes = new Map<string, number>();
      const noChangeTurns = new Map<string, number>();
      const staleRetries = new Map<string, number>();
      const waiting = new Map<
        string,
        { record: DecisionRecord; kind: 'DIRECTOR' | 'ATTEMPTS_EXHAUSTED' | 'SCOPE_VIOLATION' | 'POLICY_PATH' | 'EXECUTION_UNKNOWN'; promise: Promise<{ taskId: string; outcome: DecisionOutcome }> }
      >();
      const allowedDirs = (report.mandate?.allowedDirectories ?? []).map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''));

      // Executor reports from accepted cycles are carried into the next Director call.
      let carryNote = '';
      const queue: AutonomousTaskReport[] = [];
      if (resumeFrom) {
        for (const taskReport of report.tasks) {
          const prev = resumeFrom.tasks.find((t) => t.taskId === taskReport.taskId);
          if (!prev || accepted.has(taskReport.taskId)) continue;
          // Completed attempts count; the attempt in flight when the process died does not.
          const inflight = resumeFrom.inCycle && resumeFrom.currentTaskId === taskReport.taskId ? 1 : 0;
          taskReport.cycles = Math.max(0, prev.cycles - inflight);
          if (prev.metadata) {
            taskReport.metadata = { ...(taskReport.metadata ?? {}), ...prev.metadata };
            if (typeof prev.metadata.analysisRefusals === 'number') {
              analysisRefusals.set(taskReport.taskId, prev.metadata.analysisRefusals);
            }
          }
        }
      }
      for (const taskReport of report.tasks) {
        if (accepted.has(taskReport.taskId)) {
          taskReport.status = 'SKIPPED';
          taskReport.lastSummary = 'Already ACCEPTED in a previous run.';
          continue;
        }
        taskReport.kind = 'TASK';
        queue.push(taskReport);
      }

      const isWithinAllowed = (p: string): boolean => {
        const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..')) return false;
        if (allowedDirs.length === 0 || allowedDirs.includes('.') || allowedDirs.includes('')) return true;
        return allowedDirs.some((d) => n === d || n.startsWith(`${d}/`));
      };

      /** Writes every known task definition to the spec store: new ones are added; existing ones get
       * the runner's acceptance criteria + metadata while keeping their stored status/attempts. */
      const persistTaskDefs = async (): Promise<void> => {
        const current = await specStore.loadTasks().catch(() => [] as TaskDefinition[]);
        const byId = new Map(current.map((t) => [t.task_id, t]));
        for (const [id, def] of taskDefs) {
          const cur = byId.get(id);
          // Executing or accepted tasks are never rewritten.
          if (cur && (cur.status === TaskStatus.ACCEPTED || cur.status === TaskStatus.IN_PROGRESS)) continue;
          byId.set(
            id,
            cur
              ? ({ ...cur, acceptance_criteria: [...def.acceptance_criteria], metadata: { ...(cur.metadata ?? {}), ...(def.metadata ?? {}) } } as TaskDefinition)
              : def
          );
        }
        // Same revision on purpose (intents bind to it); the runner is the authority for these
        // fields (sealed spec + passkey-verified PO answers), so the same-revision guard is bypassed.
        await specStore.saveTasks([...byId.values()] as never, { bypassValidation: true });
      };
      let clarificationChecks: readonly ClarificationCheck[] = [];
      /** A scope-mismatch rejection is repairable: the governed pipeline marked the task REJECTED
       * (fail-closed); only the runner's verified scope classification puts it back to READY. */
      const reopenTask = async (taskId: string, evenIfAccepted = false): Promise<void> => {
        const tasks = await specStore.loadTasks();
        if (tasks.some((t) => t.task_id === taskId && (evenIfAccepted || t.status !== TaskStatus.ACCEPTED))) {
          // Runtime status transition on stored (already validated) definitions: the store's re-ingest
          // heuristic would otherwise keep REJECTED for an unchanged definition.
          await specStore.saveTasks(tasks.map((t) => (t.task_id === taskId ? { ...t, status: TaskStatus.READY } : t)) as never, { bypassValidation: true });
        }

      };

      const saveTaskDefs = async (): Promise<void> => {
        const current = await specStore.loadTasks().catch(() => [] as TaskDefinition[]);
        const merged = new Map(current.map((t) => [t.task_id, t]));
        for (const [id, def] of taskDefs) if (!merged.has(id)) merged.set(id, def);
        await specStore.saveTasks([...merged.values()] as never);
      };

      const addSubtask = (parent: TaskDefinition, id: string, kind: 'SUBTASK' | 'ANALYSIS', def: { title: string; description: string; acceptance: string[]; targetFiles: string[] }): AutonomousTaskReport => {
        const sub: TaskDefinition = {
          ...parent,
          task_id: id,
          title: def.title.slice(0, 200),
          description: def.description.slice(0, 4000),
          acceptance_criteria: def.acceptance.length ? def.acceptance.map((a) => a.slice(0, 500)).slice(0, 10) : [...parent.acceptance_criteria],
          traceability_sources: [...(parent.traceability_sources ?? []), `PARENT_TASK:${parent.task_id}`],
          status: TaskStatus.READY,
          attempt: 0,
          hierarchy_level: 'TASK',
          metadata: { ...(parent.metadata ?? {}), refinedFromTaskId: parent.task_id, refinementKind: kind, targetFiles: def.targetFiles, readOnly: kind === 'ANALYSIS' },
        };
        taskDefs.set(id, sub);
        const tr: AutonomousTaskReport = {
          taskId: id,
          title: sub.title,
          status: 'PENDING',
          cycles: 0,
          evidenceIds: [],
          verificationChecks: [],
          filesChanged: [],
          parentTaskId: parent.task_id,
          kind,
        };
        report.tasks.push(tr);
        return tr;
      };

      /** Bounded in-scope refinement (split / reorder). Returns guidance text when rejected. */
      const tryRefine = async (taskReport: AutonomousTaskReport, action: Record<string, unknown>): Promise<{ applied: boolean; note: string }> => {
        const parent = taskDefs.get(taskReport.taskId)!;
        const notes: string[] = [];
        let applied = false;
        const order = Array.isArray(action.taskOrder) ? action.taskOrder.filter((x): x is string => typeof x === 'string') : [];
        if (order.length) {
          const pendingIds = new Set(queue.map((q) => q.taskId));
          const valid = order.filter((id) => pendingIds.has(id));
          if (valid.length) {
            const moved = valid.map((id) => queue.find((q) => q.taskId === id)!);
            const rest = queue.filter((q) => !valid.includes(q.taskId));
            queue.length = 0;
            queue.push(...moved, ...rest);
            notes.push(`Reordered remaining tasks: ${valid.join(', ')}.`);
            this.decide('DESIGN', `Kalan görevlerin sırası değişti: ${valid.join(' > ')}`, 'Director bağımlılıklar nedeniyle bu sırayı daha uygun buldu.', taskReport.taskId);
            report.refinements.push(`[${taskReport.taskId}] reorder ${valid.join(' > ')}`);
            applied = true;
          }
        }
        const proposed = Array.isArray(action.proposedTasks) ? (action.proposedTasks as Array<Record<string, unknown>>) : [];
        if (proposed.length) {
          const done = refinementsDone.get(taskReport.taskId) ?? 0;
          const files = proposed.flatMap((t) => (Array.isArray(t.targetFiles) ? t.targetFiles.map(String) : []));
          const reason =
            taskReport.kind !== 'TASK' ? 'only top-level spec tasks can be split'
            : done >= maxRefinements ? 'refinement limit for this task reached'
            : proposed.length < 2 || proposed.length > 5 ? 'a split must have 2-5 subtasks'
            : report.tasks.length + proposed.length > originalTaskCount * 3 ? 'total task budget for this run exceeded'
            : proposed.some((t) => typeof t.title !== 'string' || !t.title.trim() || typeof t.description !== 'string' || !t.description.trim()) ? 'every subtask needs a title and description'
            : files.find((f) => !isWithinAllowed(f)) ? `target file '${files.find((f) => !isWithinAllowed(f))}' is outside the sealed mandate scope`
            : null;
          if (reason) {
            notes.push(`Refinement rejected (${reason}). Stay within the spec scope and allowed paths; scope/budget/policy changes require REQUEST_HUMAN_DECISION.`);
            report.refinements.push(`[${taskReport.taskId}] rejected: ${reason}`);
          } else {
            refinementsDone.set(taskReport.taskId, done + 1);
            const subs = proposed.map((t, i) =>
              addSubtask(parent, `${taskReport.taskId}-S${done + 1}${String.fromCharCode(97 + i)}`, 'SUBTASK', {
                title: String(t.title),
                description: String(t.description),
                acceptance: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(String) : [],
                targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles.map(String) : [],
              })
            );
            await saveTaskDefs();
            taskReport.status = 'SPLIT';
            queue.unshift(...subs);
            notes.push(`Task split into ${subs.map((x) => x.taskId).join(', ')}.`);
            report.refinements.push(`[${taskReport.taskId}] split into ${subs.map((x) => x.taskId).join(', ')}`);
            this.emit('TASK_REFINED', notes[notes.length - 1], taskReport.taskId);
            for (const x of subs) this.decide('TASK_CREATE', `${x.taskId}: ${x.title}`, `${taskReport.taskId} daha küçük, izinli yollar içinde kalan alt görevlere bölündü.`, x.taskId);
            applied = true;
          }
        }
        return { applied, note: notes.join(' ') };
      };

      const executorQuestions = (result: ClosedLoopCycleResult): string | undefined => {
        let blob = '';
        try {
          blob = JSON.stringify({ s: result.summary, c: result.cycleResult, b: result.bridgeResult });
        } catch {
          blob = String(result.summary ?? '');
        }
        const hits = [...blob.matchAll(/(QUESTIONS|BLOCKERS|FINDINGS):\s*([^"\\]{1,800})/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
        return hits.length ? [...new Set(hits)].join(' | ').slice(0, 2000) : undefined;
      };

      // ---- live PO instructions (verified passkey tokens only; text never raises privileges)
      this.instructionChannel = InstructionChannel.create({
        env: this.env,
        fetchFn: this.options.idpFetchFn,
        provider:
          this.options.identityProvider ??
          createTrustedIdentityProvider({ env: this.env, nonceStore: new NonceStore({ baseDir: projectRoot }), fetchFn: this.options.idpFetchFn }),
        binding: {
          runId,
          projectId,
          packageId: approved.packageId,
          revision: approved.revision,
          contextFingerprint: computeInstructionChannelFingerprint({
            runId,
            projectId,
            packageId: approved.packageId,
            revision: approved.revision,
            specFingerprint: ingestion.specFingerprint,
          }),
        },
      });
      if (this.instructionChannel) {
        this.instructionChannel.taskExists = (id) => taskDefs.has(id);
        await this.instructionChannel.open();
      }
      const channel = this.instructionChannel;
      const instructionInbox: VerifiedInstruction[] = [];
      const pollMs = Math.max(500, Number(this.env.AIDM_IDP_POLL_INTERVAL_MS ?? '3000') || 3000);
      let lastPoll = 0;
      const pollInstructions = async (force = false): Promise<void> => {
        if (!channel?.opened) return;
        if (!force && Date.now() - lastPoll < Math.min(pollMs, 1000)) return;
        lastPoll = Date.now();
        const got = await channel.poll();
        for (const rj of channel.rejected.splice(0)) {
          report.instructions.push({ instructionId: rj.instructionId, mode: 'UNKNOWN', taskId: null, state: 'REJECTED', note: monitorText(rj.reason, 300) });
          this.emit('INSTRUCTION', 'Talimat reddedildi (doğrulanamadı)', undefined, 'warn');
        }
        // 'Soru sor' never waits for a cycle boundary and never pauses the run.
        for (const ins of got) {
          if (ins.mode === 'ASK') {
            const p = answerQuestion(ins).catch(() => {});
            pendingAnswers.add(p);
            void p.finally(() => pendingAnswers.delete(p));
          } else instructionInbox.push(ins);
        }
      };
      const pendingAnswers = new Set<Promise<void>>();
      /** Short Director LLM call with the run context; counts against the budget (wrapped provider). */
      const answerQuestion = async (ins: VerifiedInstruction): Promise<void> => {
        const entry: AutonomousRunReport['instructions'][number] = { instructionId: ins.instructionId, mode: 'ASK', taskId: ins.taskId, state: 'RECEIVED' };
        report.instructions.push(entry);
        this.emit('INSTRUCTION', 'Soru alındı; Director yanıtlıyor (çalışma devam ediyor)', ins.taskId ?? undefined);
        await historyManager.appendEvent({ eventType: 'AUTONOMOUS_PO_INSTRUCTION', actor: Actor.USER, taskId: ins.taskId, payload: { instructionId: ins.instructionId, mode: 'ASK', sub: ins.sub } });
        let answer = '';
        let failure = '';
        if (isBudgetExhausted(budgetManager!)) failure = 'Bütçe tükendi; soru yanıtlanamadı.';
        else {
          try {
            const res = await provider.generate({
              correlation: { correlation_id: `ask-${ins.instructionId}`, project_id: projectId, task_id: PO_QUESTION_TASK_ID, attempt: 1 },
              messages: [
                { role: 'system', content: PO_QUESTION_SYSTEM_PROMPT },
                { role: 'user', content: buildPoQuestionPrompt({ question: ins.text, taskId: ins.taskId, markdown: (() => {
                  const qt = taskDefs.get(ins.taskId ?? this.currentTaskId ?? '');
                  return specContext.excerptForTask({ taskId: qt?.task_id ?? 'PO-QUESTION', title: `${ins.text} ${qt?.title ?? ''}`.trim(), description: qt?.description, acceptanceCriteria: qt?.acceptance_criteria }, 30_000);
                })(), report, currentTaskId: this.currentTaskId ?? null, poNotes, budget: this.liveBudget?.() ?? report.budget }) },
              ],
              director_context: { project_id: projectId, task_id: PO_QUESTION_TASK_ID, objective: 'answer product owner question', acceptance_criteria: null, attempt: 1, max_attempts: 1, relevant_context: null },
              model: baseProvider.defaultModel,
              max_tokens: 800,
              response_format: LlmResponseFormat.TEXT,
              json_schema: null,
              metadata: { purpose: 'PO_QUESTION', runId },
            } as never);
            const err = (res as { error?: { message?: string } | null }).error;
            if (err) failure = `Yanıt üretilemedi: ${monitorText(String(err.message ?? 'LLM hatası'), 200)}`;
            else answer = String((res as { content?: unknown }).content ?? '').trim().slice(0, 4000);
            if (!answer && !failure) failure = 'Director boş yanıt verdi.';
          } catch (e) {
            failure = `Yanıt üretilemedi: ${monitorText(e instanceof Error ? e.message : String(e), 200)}`;
          }
        }
        if (answer) {
          entry.state = 'APPLIED';
          entry.note = monitorText(answer, 500);
          await channel?.ack(ins.instructionId, 'APPLIED', 'Director yanıtladı.', answer);
          this.emit('DIRECTOR_ANSWER', `Soru: ${monitorText(ins.text, 120)} — Yanıt: ${monitorText(answer, 340)}`, ins.taskId ?? undefined);
        } else {
          entry.state = 'REJECTED';
          entry.note = failure;
          await channel?.ack(ins.instructionId, 'REJECTED', failure);
          this.emit('INSTRUCTION', failure, ins.taskId ?? undefined, 'warn');
        }
      };
      const pollTimer = channel?.opened ? setInterval(() => void pollInstructions(true), pollMs) : null;
      pollTimer?.unref?.();
      /** Applied at cycle boundaries only (an AGY step is never interrupted). */
      const applyInstructions = async (): Promise<void> => {
        await pollInstructions(true);
        while (instructionInbox.length) {
          const ins = instructionInbox.shift()!;
          const entry: AutonomousRunReport['instructions'][number] = { instructionId: ins.instructionId, mode: ins.mode, taskId: ins.taskId, state: 'RECEIVED' };
          report.instructions.push(entry);
          this.emit('INSTRUCTION', `Talimat alındı (${ins.mode})`, ins.taskId ?? undefined);
          await historyManager.appendEvent({
            eventType: 'AUTONOMOUS_PO_INSTRUCTION',
            actor: Actor.USER,
            taskId: ins.taskId,
            payload: { instructionId: ins.instructionId, mode: ins.mode, sub: ins.sub },
          });
          if (ins.mode === 'STOP') {
            this.stopInstruction = ins;
            entry.state = 'APPLIED';
            stop = { status: 'STOPPED', reason: `Ürün sahibi talimatıyla durduruldu${ins.text ? `: ${monitorText(ins.text, 300)}` : ''}.` };
            return;
          }
          poNotes.push({ text: ins.text, taskId: ins.taskId, id: ins.instructionId });
          if (ins.mode === 'NOTE') {
            entry.state = 'APPLIED';
            await channel?.ack(ins.instructionId, 'APPLIED', "Director bağlamına eklendi.");
            this.emit('INSTRUCTION', 'Talimat uygulandı (NOTE)', ins.taskId ?? undefined);
          } else {
            // PAUSE_AND_APPLY: dispatching pauses at this boundary; the next Director call gets the
            // instruction first and may replan WITHIN the sealed mandate. ACK after that call.
            pauseInstruction = ins;
            for (const t of report.tasks) refinementsDone.delete(t.taskId);
          }
        }
      };
      const settlePause = async (outcome: { applied: boolean; note: string }): Promise<void> => {
        const ins = pauseInstruction;
        if (!ins) return;
        pauseInstruction = null;
        const entry = report.instructions.find((x) => x.instructionId === ins.instructionId);
        const status = outcome.applied ? 'APPLIED' : 'REJECTED';
        if (entry) {
          entry.state = status;
          entry.note = monitorText(outcome.note, 500);
        }
        await channel?.ack(ins.instructionId, status, outcome.note);
        this.emit('INSTRUCTION', outcome.applied ? 'Talimat uygulandı' : 'Talimat reddedildi', ins.taskId ?? undefined, outcome.applied ? 'info' : 'warn');
      };

      /** Runs cycles for one task; returns 'DONE' | 'DEFERRED' (waiting on a decision / split). */
      let dispatchSeq = 0;
      const relSpecPath = path.relative(projectRoot, specPath).replace(/\\/g, '/');
      // Every spec document (main file, includes, folder parts) is read-only for the executor
      // unless the spec itself lists that exact file as a writable path.
      const isSpecFileWritable = (absPath: string): boolean => {
        const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');
        return !rel.startsWith('..') && (ingestion.allowedPaths.includes(rel) || ingestion.requirements.some((r) => r.targetFiles.includes(rel)));
      };
      const protectedSpecFiles = specBundle.files.filter((f) => !isSpecFileWritable(f.absPath));
      const specWritable = protectedSpecFiles.length === 0;
      const specRelPaths = new Set(specBundle.files.map((f) => path.relative(projectRoot, f.absPath).replace(/\\/g, '/')));
      const runTask = async (taskReport: AutonomousTaskReport): Promise<'DONE' | 'DEFERRED'> => {
        const task = taskDefs.get(taskReport.taskId)!;
        let extraGuidance = guidance.get(task.task_id) ?? '';
        guidance.delete(task.task_id);
        taskReport.status = 'PENDING';

        const maxCycles = attemptsFor(task.task_id);
        await setSpecMaxAttempts(task.task_id, maxCycles);
        this.currentTaskId = task.task_id;
        if (taskReport.kind !== 'ANALYSIS' && firstSegmentTaskId === undefined) firstSegmentTaskId = task.task_id;
        let lastFailure = '';
        while (taskReport.cycles < maxCycles) {
          await applyInstructions();
          if (stop) break;
          if (isBudgetExhausted(budgetManager!)) {
            stop = { status: 'BUDGET_EXHAUSTED', reason: 'Budget exhausted; raising the budget requires human approval.' };
            break;
          }
          taskReport.cycles++;
          this.emit('CYCLE_START', `Cycle ${taskReport.cycles}/${maxCycles}`, task.task_id);

          let snapshot;
          try {
            snapshot = await synchronizer.synchronize({ directorSessionId: session.directorSessionId, projectId });
            // Bind the session's understanding baseline to the authoritative requirements revision
            // that this run wrote from the human spec (never to an LLM-provided revision).
            const reqRevision = snapshot.sectionMetadata?.requirements?.revision;
            const currentSession = await sessionStore.loadSession(session.directorSessionId);
            if (currentSession && typeof reqRevision === 'number' && reqRevision > 0 && currentSession.understandingRevision !== reqRevision) {
              await sessionStore.saveSession({ ...currentSession, understandingRevision: reqRevision });
            }
            await sessionStore.saveSnapshot(snapshot);
          } catch (err) {
            stop = { status: 'FAILED', reason: `Context synchronization failed: ${err instanceof Error ? err.message : String(err)}` };
            break;
          }

          const isAnalysis = taskReport.kind === 'ANALYSIS';
          const isGreenfield = await isGreenfieldWorkspace(projectRoot);
          const doneAnalyses = analysesDone.get(task.task_id) ?? 0;
          const analysisEval = evaluateAnalysis(analysisPolicy, {
            firstTaskOfSegment: task.task_id === firstSegmentTaskId,
            afterFailedAttempt: taskReport.cycles >= 2 || lastFailure !== '',
            isGreenfield,
            analysesDone: doneAnalyses,
            maxAnalyses,
            isAnalysisTask: isAnalysis,
          });
          const analysisAllowed = analysisEval.allowed;
          const refusalFormat = analysisEval.reason
            ? formatAnalysisRefusal(analysisEval.reason, analysisPolicyLabel(analysisPolicy))
            : undefined;
          // Ordered by importance: the prompt builder bounds this field (DEFAULT_MAX_FIELD_LENGTH_CHARS),
          // so task, fresh guidance (PO answers, executor reports) come before the static policy text.
          const pauseText = pauseInstruction
            ? `PAUSED BY PRODUCT_OWNER (passkey-verified instruction ${(pauseInstruction as VerifiedInstruction).instructionId}): ${(pauseInstruction as VerifiedInstruction).text}\n` +
              'Apply it now: you may REPLAN (proposedTasks/taskOrder) or adjust this task WITHIN the sealed mandate (allowed paths, budget, operation types). ' +
              'Anything outside the mandate (new paths, budget, network, dependency install, policy) must NOT be done: say so in rationale and raise REQUEST_HUMAN_DECISION.'
            : '';
          const instruction = [
            pauseText,
            `Target task: ${task.task_id} — ${task.title}.`,
            `Task description: ${task.description}`,
            `Acceptance criteria: ${task.acceptance_criteria.join(' | ')}`,
            isAnalysis
              ? 'This is a READ-ONLY ANALYSIS task: emit IMPLEMENT_TASK whose objective starts with "Read-only analysis without modifying files:" and asks the executor to report results under "FINDINGS:". No file may change.'
              : analysisAllowed
                ? ''
                : (refusalFormat?.directorInstruction ?? ''),
            extraGuidance,
            carryNote,
            ...poNotes
              .filter((n) => !n.taskId || n.taskId === task.task_id)
              .slice(-5)
              .map((n) => `BINDING PRODUCT_OWNER INSTRUCTION (passkey-verified ${n.id}): ${n.text}`),
            report.assumptions.length ? `Logged assumptions: ${report.assumptions.slice(-12).join(' | ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          // Run-level context, identical for every Director call of this run: sent first (stable,
          // cacheable prefix) and no longer squeezed into the per-task objective field.
          const stableContext = this.env.AIDM_STABLE_PROMPT === '0' ? '' : [
            clarificationNote,
            report.approachPlan ? `APPROVED APPROACH PLAN (follow it; PO corrections above override it):\n${report.approachPlan}` : '',
            `Project root is the only allowed workspace; allowed paths: ${(report.mandate?.allowedDirectories ?? []).join(', ')}.`,
            decisionMode === 'assume' ? NO_QUESTIONS_DIRECTOR_INSTRUCTION : policyText,
            DIRECTOR_CAPABILITIES_INSTRUCTION,
            'MANDATORY GROUND TRUTH DIRECTIVE: The specification below is the authoritative ground truth for this project. You MUST strictly follow every business rule, platform distinction, user role, and constraint declared within it without deviation or hallucination.',
            ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE,
            specContext.globalContext(),
          ].filter(Boolean).join('\n');

          carryNote = '';
          const headBefore = await gitHead(projectRoot);
          let result: ClosedLoopCycleResult;
          try {
            result = await coordinator.coordinateCycle({
              projectId,
              directorSessionId: session.directorSessionId,
              contextSnapshot: snapshot,
              targetTaskId: task.task_id,
              instruction: stableContext ? instruction : [instruction, clarificationNote, `Project root is the only allowed workspace; allowed paths: ${(report.mandate?.allowedDirectories ?? []).join(', ')}.`, decisionMode === 'assume' ? NO_QUESTIONS_DIRECTOR_INSTRUCTION : policyText, DIRECTOR_CAPABILITIES_INSTRUCTION, ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE].filter(Boolean).join('\n'),
              ...(stableContext ? { stableContext } : {}),
              // Full text of the spec sections governing this task ('' when the whole spec is inline).
              ...(() => {
                const tc = specContext.taskContext(specRef(task));
                return tc ? { taskContext: tc } : {};
              })(),
              maxRecoveryAttempts: maxCycles,
              // Each attempt is a distinct dispatch: a repair with an identical payload must not be
              // swallowed as an idempotent duplicate of the failed attempt.
              // A resumed segment restarts the counter: the segment keeps its keys distinct.
              idempotencyKey: `${runId}:${resumeFrom ? `s${resumeFrom.segment + 1}:` : ''}${task.task_id}:attempt-${++dispatchSeq}`,
            });
          } catch (err) {
            result = {
              status: 'EXECUTION_FAILED',
              summary: err instanceof Error ? err.message : String(err),
            } as ClosedLoopCycleResult;
          }
          taskReport.lastCycleStatus = result.status;
          taskReport.lastSummary = result.summary;
          // The human spec is the source of authority: the executor must never rewrite it unless the
          // spec itself lists it as a writable path. Restore and fail closed.
          if (!specWritable) {
            const touched = findModifiedSpecFiles({ ...specBundle, files: protectedSpecFiles });
            if (touched.length) {
              for (const f of touched) await fs.promises.writeFile(f.absPath, f.content, 'utf8').catch(() => undefined);
              taskReport.status = 'BLOCKED';
              stop = { status: 'BLOCKED_ON_HUMAN', reason: `Spec file '${touched.map((f) => f.relPath).join(', ')}' was modified during task ${task.task_id}; restored. The executor may not edit the spec.` };
              this.emit('TASK_BLOCKED', stop.reason, task.task_id, 'error');
              break;
            }
          }
          if (result.systemEvidence) {
            taskReport.evidenceIds.push(result.systemEvidence.evidenceId);
            taskReport.verificationChecks.push(
              ...result.systemEvidence.verificationChecks.map((c) => ({ type: c.type, status: String(c.status), command: c.command }))
            );
            // Independently observed changes (incl. untracked new files) count even when the cycle failed.
            taskReport.filesChanged = [
              ...new Set([...taskReport.filesChanged, ...result.systemEvidence.changedFiles.map((f) => f.path)]),
            ];
            const failing = result.systemEvidence.verificationChecks.filter((c) => c.status === 'FAIL' || c.status === 'BLOCK');
            lastFailure = failing.length ? formatFailingChecks(failing) : '';
            if (failing.length) this.emit('VERIFICATION', `${failing.length} kontrol başarısız: ${failing.map((c) => c.command ?? c.type).join(', ')}`, task.task_id, 'warn');
            if (failing.length && result.status !== 'COMPLETED_SUCCESS')
              this.decide('TASK_REPAIR', `${task.task_id} kabul edilmedi, yeniden denenecek`, `Bağımsız kontroller geçmedi (${failing.length}): ${failing.map((c) => c.command ?? c.type).slice(0, 4).join(', ')}.`, task.task_id);
          }
          const deferred = specCollector.takeDeferred(task.task_id);
          if (deferred.length) report.deferredCommands.push({ taskId: task.task_id, commands: deferred });
          if (result.directorAction) {
            this.lastDirectorAction = {
              actionType: String(result.directorAction.actionType),
              taskId: task.task_id,
              rationale: monitorText((result.directorAction as unknown as { rationale?: string }).rationale ?? '', 1000),
              at: new Date().toISOString(),
            };
          }
          {
            const at = String((result.directorAction as unknown as { actionType?: string } | undefined)?.actionType ?? '');
            // Analysis actions are not dispatched by the governed gate; the runner turns them into a
            // read-only analysis subtask below (not a failure, the attempt is not counted).
            const analysisReroute =
              !isAnalysis && result.status === 'BLOCKED_ON_APPROVAL' && (at === 'ANALYZE_PROJECT' || at === 'DISCOVER_PROJECT' || at === 'REVIEW_EVIDENCE');
            this.emit(
              'CYCLE_RESULT',
              analysisReroute
                ? analysisAllowed
                  ? `${at}: Director salt-okunur analiz istedi → analiz alt görevi olarak çalıştırılıyor (deneme sayılmaz).`
                  : `${at}: ${refusalFormat?.logMessage ?? ''}`
                : `${result.status}: ${result.summary}`,
              task.task_id
            );
          }

          // A rejected self-claim must never leave the stored task ACCEPTED (the governed cycle may
          // have marked it before the bridge's Zero-Executor-Trust check); otherwise the repair
          // attempt is refused as "already in terminal state".
          if (/self-claim rejected|claims cannot substitute/i.test(String(result.summary ?? ''))) {
            await reopenTask(task.task_id, true).catch(() => undefined);
            // Verification-only / audit work legitimately changes nothing: tell the Director how to
            // get that independently verified instead of burning attempts on "no changes".
            const n = (noChangeTurns.get(task.task_id) ?? 0) + 1;
            noChangeTurns.set(task.task_id, n);
            if (n <= 1 && !pauseInstruction && isVerificationOnlyTask(taskDefs.get(task.task_id) ?? task)) {
              // Audit/verification task (Lighthouse, zero console errors, ...): the next attempt runs as
              // read-only verification; system checks still decide (no file change is the expected result).
              const tasksNow = await specStore.loadTasks();
              await specStore
                .saveTasks(tasksNow.map((t) => (t.task_id === task.task_id ? { ...t, metadata: { ...(t.metadata ?? {}), verificationOnly: true } } : t)) as never, { bypassValidation: true })
                .catch(() => undefined);
              taskReport.cycles--; // the executor did nothing wrong; the attempt is not consumed
              this.emit('VERIFICATION', `${task.task_id}: dosya değişikliği yok; görev yalnızca doğrulama ise salt-okunur doğrulama olarak yeniden isteniyor.`, task.task_id, 'warn');
              extraGuidance = [
                `The previous attempt for ${task.task_id} changed no files, so it could not be independently verified.`,
                'If this task needs real changes, re-emit IMPLEMENT_TASK with concrete targetFiles and edits.',
                'If it is verification/audit only (e.g. Lighthouse, zero console errors, link checks) and nothing must change, re-emit IMPLEMENT_TASK with targetFiles [] and the constraint "Do not modify any files (verification only)", list exactly what to check, and ask the executor to report each result under "FINDINGS:" (with any command output). Read-only verification with passing system checks is accepted without file changes.',
              ].join('\n');
              continue;
            }
          }
          if (/does not match authoritative snapshot|fingerprint mismatch|stale context snapshot/i.test(String(result.summary ?? ''))) {
            // The Director decided on a snapshot that changed before dispatch (e.g. a reopened task):
            // a fresh snapshot + a new decision fixes it. Auto-retry, not a human block.
            const n = (staleRetries.get(task.task_id) ?? 0) + 1;
            staleRetries.set(task.task_id, n);
            if (n <= 2) {
              taskReport.cycles--;
              this.emit('VERIFICATION', `${task.task_id}: bağlam değişmişti; güncel bağlamla yeniden deneniyor (otomatik, ${n}/2).`, task.task_id, 'warn');
              continue;
            }
          }
          let action = (result.directorAction ?? {}) as unknown as Record<string, unknown>;
          let actionType = result.directorAction?.actionType as string | undefined;
          if (pauseInstruction) {
            if (actionType === 'REPLAN' || actionType === 'UPDATE_PLAN' || actionType === 'CREATE_TASK') {
              const ref = await tryRefine(taskReport, action);
              await settlePause({ applied: ref.applied, note: ref.applied ? ref.note : `Kapsam dışı veya uygulanamadı: ${ref.note || 'değişiklik yok'}` });
              if ((taskReport.status as string) === 'SPLIT') return 'DEFERRED';
              taskReport.cycles--;
              extraGuidance = `${ref.note || ''} Continue with IMPLEMENT_TASK for ${task.task_id}.`;
              continue;
            } else if (actionType === 'REQUEST_HUMAN_DECISION') {
              await settlePause({ applied: false, note: 'Talimat sözleşme (mandate) dışında bir değişiklik gerektiriyor; insan kararı istendi.' });
            } else if (!actionType) {
              await settlePause({ applied: false, note: 'Director geçerli bir eylem üretmedi; talimat uygulanamadı.' });
            } else {
              await settlePause({ applied: true, note: `Director talimatı uyguladı (${actionType}).` });
            }
          }
          // Executor (AGY) questions/blockers/findings are routed to the Director, never to the human.
          const execReport = executorQuestions(result);
          if (execReport) {
            report.executorReports.push(`[${task.task_id}] ${execReport}`);
            this.emit('EXECUTOR_REPORT', execReport, task.task_id);
          }
          const execNote = execReport
            ? `Executor report (the executor cannot ask the human; you decide, or raise REQUEST_HUMAN_DECISION for a genuine product decision): ${execReport}`
            : '';

          // ---- Director-raised human decision (only the Director talks to the human)
          if (actionType === 'REQUEST_HUMAN_DECISION') {
            const asked = decisionsAsked.get(task.task_id) ?? 0;
            const question = String(action.question ?? extractQuestion(result) ?? 'unspecified decision').slice(0, 1000);
            if (decisionMode === 'assume') {
              const rec = typeof action.recommendation === 'string' ? ` (recommended: ${action.recommendation})` : '';
              const assumption = `[${task.task_id}] Director decision "${question}" assumed${rec} (AIDM_DECISION_MODE=assume).`;
              report.assumptions.push(assumption);
              taskReport.cycles--;
              extraGuidance = `Human decisions are disabled. ${assumption} Proceed with IMPLEMENT_TASK.`;
              continue;
            }
            if (!decisionResolver || asked >= maxDecisionsPerTask) {
              taskReport.status = 'BLOCKED';
              stop = {
                status: 'BLOCKED_ON_HUMAN',
                reason: `Task ${task.task_id}: Director requests a human decision: "${question}". ${
                  decisionResolver ? 'Decision limit for this task reached.' : 'No decision channel (configure the external IdP or run in an interactive terminal).'
                }`,
              };
              break;
            }
            decisionsAsked.set(task.task_id, asked + 1);
            const record = buildDecisionRecord({
              projectRoot,
              projectId,
              runId,
              taskId: task.task_id,
              packageId: approved.packageId,
              revision: approved.revision,
              question,
              reason: typeof action.reason === 'string' ? action.reason : undefined,
              options: action.options,
              recommendation: typeof action.recommendation === 'string' ? action.recommendation : undefined,
            });
            await saveDecisionRecord(record);
            report.decisions.push({ decisionId: record.decisionId, taskId: task.task_id, question: record.question, state: 'PENDING', channel: decisionResolver.channel });
            this.emit('DECISION_REQUESTED', `${record.decisionId}: ${record.question}`, task.task_id);
            taskReport.cycles--; // asking does not consume an execution attempt
            taskReport.status = 'WAITING_DECISION';
            const resolver = decisionResolver;
            const promise = resolver
              .resolve(record)
              .catch((err): DecisionOutcome => ({ status: 'FAILED', reason: err instanceof Error ? err.message : String(err) }))
              .then((outcome) => ({ taskId: task.task_id, outcome }));
            waiting.set(task.task_id, { record, kind: 'DIRECTOR', promise });
            this.pendingDecisionIds.add(record.decisionId);
            return 'DEFERRED';
          }

          // ---- In-scope refinement (split / reorder)
          if (actionType === 'REPLAN' || actionType === 'UPDATE_PLAN' || actionType === 'CREATE_TASK') {
            const ref = await tryRefine(taskReport, action);
            if ((taskReport.status as string) === 'SPLIT') return 'DEFERRED';
            taskReport.cycles--;
            extraGuidance = `${ref.note || 'No applicable refinement.'} Continue with IMPLEMENT_TASK for ${task.task_id}. ${execNote}`.trim();
            if (!ref.applied && (refinementsDone.get(task.task_id) ?? 0) >= maxRefinements && taskReport.cycles <= 0) taskReport.cycles++;
            continue;
          }

          // ---- Analysis requested where the policy does not allow it: refuse once (not counted)
          // for all 3 read-only types (ANALYZE_PROJECT, DISCOVER_PROJECT, REVIEW_EVIDENCE).
          // On 2nd and subsequent requests:
          // - For ANALYZE_PROJECT / DISCOVER_PROJECT: synthesize an IMPLEMENT_TASK from the spec task definition
          //   and dispatch it through the exact same coordinator / authorization policy path.
          // - For REVIEW_EVIDENCE: do NOT synthesize IMPLEMENT_TASK (evidence review is not implementation);
          //   fall through to normal handling (governed BLOCKED_ON_HUMAN gate, exactly matching baseline db78416).
          if (
            !isAnalysis &&
            !analysisAllowed &&
            (actionType === 'ANALYZE_PROJECT' || actionType === 'DISCOVER_PROJECT' || actionType === 'REVIEW_EVIDENCE') &&
            result.status !== 'REJECTED_BY_POLICY'
          ) {
            const prevRefused = (taskReport.metadata?.analysisRefusals as number | undefined) ?? analysisRefusals.get(task.task_id) ?? 0;
            const refused = prevRefused + 1;
            analysisRefusals.set(task.task_id, refused);
            taskReport.metadata = { ...(taskReport.metadata ?? {}), analysisRefusals: refused };
            this.writeCheckpoint();

            if (refused === 1) {
              taskReport.cycles--;
              extraGuidance = `A separate read-only analysis is not available for ${task.task_id} now. ${refusalFormat?.directorInstruction ?? ''} ${execNote}`.trim();
              continue;
            }

            // Fallback synthesis is restricted to ANALYZE_PROJECT and DISCOVER_PROJECT.
            // REVIEW_EVIDENCE falls through to normal governance gate (BLOCKED_ON_HUMAN).
            if (actionType === 'ANALYZE_PROJECT' || actionType === 'DISCOVER_PROJECT') {
              // 2nd refusal and beyond: Deterministic fallback to IMPLEMENT_TASK synthesized from task definition.
            const storedTask =
              (await specStore.loadTasks().catch(() => [] as TaskDefinition[])).find((t) => t.task_id === task.task_id) ??
              taskDefs.get(task.task_id) ??
              task;

            const description = (storedTask.description ?? '').trim();
            const acceptance = (storedTask.acceptance_criteria ?? []).filter((c: string) => c.trim().length > 0);
            const targets = currentScopeOf(storedTask);

            // Yetersiz-spec kuralı (INSUFFICIENT_TASK_SPECIFICATION):
            // Yalnızca description, acceptance_criteria ve targetFiles ÜÇÜ DE boşsa BLOCKED_ON_HUMAN ile durdurulur.
            // SpecIngestor (spec-ingestor.ts), spec dosyasında görev için gövde yazılmadığında description alanını
            // otomatik olarak `b.title` değerine kopyalar (isSyntheticDefaultDescription).
            // Benzer şekilde kabul kriteri yazılmadığında acceptance_criteria listesine otomatik olarak
            // DEFAULT_SYNTHETIC_ACCEPTANCE_CRITERION varsayılanını ekler (isSyntheticDefaultAcceptanceCriteria).
            // Bu iki durum yalnızca SpecIngestor'ın otomatik ürettiği sentetik varsayılanlar olduğunda "boş" kabul edilir.
            // Kullanıcı tarafından yazılmış gerçek bir tanım, kriter veya hedef dosya varsa eylem sentezlenebilir.
            const isSyntheticPlaceholderAC = isSyntheticDefaultAcceptanceCriteria(acceptance);
            const isSyntheticDesc = isSyntheticDefaultDescription(description, storedTask.title, storedTask.task_id);
            const hasRealDescription = !isSyntheticDesc;
            const hasRealAcceptance = acceptance.length > 0 && !isSyntheticPlaceholderAC;
            const hasTargetFiles = targets.length > 0;

            const isDescriptionEmpty = !hasRealDescription;
            const isAcceptanceEmpty = !hasRealAcceptance;
            const isTargetFilesEmpty = !hasTargetFiles;

            if (isDescriptionEmpty && isAcceptanceEmpty && isTargetFilesEmpty) {
              taskReport.status = 'BLOCKED';
              stop = {
                status: 'BLOCKED_ON_HUMAN',
                reason: `INSUFFICIENT_TASK_SPECIFICATION: Görev ${task.task_id} için tanım (description), kabul kriteri (acceptance_criteria) ve hedef dosya (targetFiles) tanımlanmamış; analiz izni verilmediği için doğrudan uygulamaya geçilemiyor.`,
              };
              this.emit('TASK_BLOCKED', stop.reason, task.task_id, 'error');
              break;
            }

            taskReport.metadata = { ...(taskReport.metadata ?? {}), fallbackSynthesized: true };
            this.emit(
              'VERIFICATION',
              `${task.task_id}: Director analiz isteğinde ısrar etti (${refused}. red); görev tanımından IMPLEMENT_TASK sentezlenerek sevk ediliyor.`,
              task.task_id,
              'warn'
            );
            this.decide(
              'PLAN',
              `${task.task_id} için IMPLEMENT_TASK sentezlendi`,
              `Director izin verilmeyen analiz eyleminde ısrar etti (${refused}. red) → görev tanımından doğrudan uygulama eylemi oluşturulup sevk ediliyor.`,
              task.task_id
            );

            // Inherit confidence from rejected director action if valid in [0, 1], otherwise default to neutral 0.7
            const rawConf =
              typeof (action as { confidence?: unknown })?.confidence === 'number'
                ? (action as { confidence: number }).confidence
                : undefined;
            const fallbackConfidence = typeof rawConf === 'number' && rawConf >= 0 && rawConf <= 1 ? rawConf : 0.7;

            // Derive implementation scope from target files if available, otherwise fallback to mandate allowed directories
            const fallbackScope =
              targets.length > 0
                ? targets.join(', ')
                : (report.mandate?.allowedDirectories ?? DEFAULT_AUTONOMOUS_ALLOWED_PATHS)
                    .map((p) => (p.includes('.') ? p : `${p}/*`))
                    .join(', ');

            const fallbackAction: ImplementTaskAction = {
              protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
              schemaVersion: 1,
              actionId: `act-fallback-${task.task_id.replace(/[^a-zA-Z0-9_\-\.]/g, '_')}-${Date.now()}`,
              directorSessionId: session.directorSessionId,
              projectId,
              actionType: 'IMPLEMENT_TASK',
              basedOnContextFingerprint: snapshot.logicalFingerprint,
              basedOnUnderstandingRevision:
                typeof snapshot.sectionMetadata?.requirements?.revision === 'number' && snapshot.sectionMetadata.requirements.revision > 0
                  ? snapshot.sectionMetadata.requirements.revision
                  : 1,
              rationale: `Direct implementation fallback synthesized from task specification after persistent analysis requests for ${task.task_id}.`,
              confidence: fallbackConfidence,
              taskId: task.task_id,
              objective: description || storedTask.title || `Implement ${task.task_id}`,
              targetFiles: targets,
              implementationScope: fallbackScope,
              acceptanceCriteria: acceptance,
              constraints: [],
            };

            try {
              result = await coordinator.coordinateCycle({
                projectId,
                directorSessionId: session.directorSessionId,
                contextSnapshot: snapshot,
                targetTaskId: task.task_id,
                customAction: fallbackAction,
                instruction: stableContext
                  ? instruction
                  : [
                      instruction,
                      clarificationNote,
                      `Project root is the only allowed workspace; allowed paths: ${(report.mandate?.allowedDirectories ?? []).join(', ')}.`,
                      decisionMode === 'assume' ? NO_QUESTIONS_DIRECTOR_INSTRUCTION : policyText,
                      DIRECTOR_CAPABILITIES_INSTRUCTION,
                    ]
                      .filter(Boolean)
                      .join('\n'),
                ...(stableContext ? { stableContext } : {}),
                maxRecoveryAttempts: maxCycles,
                idempotencyKey: `${runId}:${resumeFrom ? `s${resumeFrom.segment + 1}:` : ''}${task.task_id}:fallback-${dispatchSeq++}`,
              });
            } catch (err) {
              result = {
                status: 'EXECUTION_FAILED',
                summary: err instanceof Error ? err.message : String(err),
              } as ClosedLoopCycleResult;
            }

            taskReport.lastCycleStatus = result.status;
            taskReport.lastSummary = result.summary;

            action = (result.directorAction ?? {}) as unknown as Record<string, unknown>;
            actionType = result.directorAction?.actionType as string | undefined;

            if (result.systemEvidence) {
              taskReport.evidenceIds.push(result.systemEvidence.evidenceId);
              taskReport.verificationChecks.push(
                ...result.systemEvidence.verificationChecks.map((c) => ({ type: c.type, status: String(c.status), command: c.command }))
              );
              taskReport.filesChanged = [
                ...new Set([...taskReport.filesChanged, ...result.systemEvidence.changedFiles.map((f) => f.path)]),
              ];
              const failing = result.systemEvidence.verificationChecks.filter((c) => c.status === 'FAIL' || c.status === 'BLOCK');
              lastFailure = failing.length ? formatFailingChecks(failing) : '';
              if (failing.length) this.emit('VERIFICATION', `${failing.length} kontrol başarısız: ${failing.map((c) => c.command ?? c.type).join(', ')}`, task.task_id, 'warn');
              if (failing.length && result.status !== 'COMPLETED_SUCCESS')
                this.decide('TASK_REPAIR', `${task.task_id} kabul edilmedi, yeniden denenecek`, `Bağımsız kontroller geçmedi (${failing.length}): ${failing.map((c) => c.command ?? c.type).slice(0, 4).join(', ')}.`, task.task_id);
            }

            if (result.directorAction) {
              this.lastDirectorAction = {
                actionType: String(result.directorAction.actionType),
                taskId: task.task_id,
                rationale: monitorText((result.directorAction as unknown as { rationale?: string }).rationale ?? '', 1000),
                at: new Date().toISOString(),
              };
            }
            this.emit('CYCLE_RESULT', `${result.status}: ${result.summary}`, task.task_id);
            }
          }

          // ---- Read-only analysis dispatched to AGY through the governed pipeline
          if (
            !isAnalysis &&
            analysisAllowed &&
            (actionType === 'ANALYZE_PROJECT' || actionType === 'DISCOVER_PROJECT' || actionType === 'REVIEW_EVIDENCE') &&
            result.status !== 'REJECTED_BY_POLICY'
          ) {
            const done = analysesDone.get(task.task_id) ?? 0;
            if (done < maxAnalyses) {
              analysesDone.set(task.task_id, done + 1);
              const scope = String(action.analysisScope ?? action.discoveryScope ?? action.reviewObjective ?? action.rationale ?? 'inspect relevant code').slice(0, 2000);
              const sub = addSubtask(task, `${task.task_id}-A${done + 1}`, 'ANALYSIS', {
                title: `Read-only analysis for ${task.task_id}`,
                description: `Read-only analysis without modifying files: ${scope}. Read the relevant code, run the project's tests/build if useful, and report results under "FINDINGS:".`,
                acceptance: ['No repository file is modified', 'Findings are reported under FINDINGS:'],
                targetFiles: [],
              });
              await saveTaskDefs();
              taskReport.cycles--;
              const outcome = await runTask(sub);
              void outcome;
              const findings = report.executorReports.filter((x) => x.startsWith(`[${sub.taskId}]`)).join(' | ');
              extraGuidance = `Analysis ${sub.taskId} ${sub.status}: ${findings || sub.lastSummary || 'no findings reported'}. Now emit IMPLEMENT_TASK for ${task.task_id}.`;
              if (stop) break;
              continue;
            }
          }

          if (result.status === 'COMPLETED_SUCCESS' && actionType && actionType !== 'IMPLEMENT_TASK' && actionType !== 'RETRY_TASK' && actionType !== 'CORRECT_TASK') {
            // Non-execution action (e.g. review/analysis): not a task completion; continue.
            extraGuidance = `Previous action ${actionType} did not implement the task. Now emit IMPLEMENT_TASK for ${task.task_id}. ${execNote}`.trim();
            continue;
          }

          if (
            result.status === 'COMPLETED_SUCCESS' &&
            selfCheckOn &&
            !isAnalysis &&
            !(selfCheckRepairs.get(task.task_id) ?? 0) &&
            taskReport.cycles < maxCycles &&
            !isBudgetExhausted(budgetManager!)
          ) {
            // Second look before accepting: "bu gerçekten spec'in istediği mi?"
            const files = [...new Set([...taskReport.filesChanged, ...(result.systemEvidence?.changedFiles ?? []).map((f) => f.path)])];
            const sc = await selfCheck(taskDefs.get(task.task_id) ?? task, files, execNote || result.summary);
            (report.selfChecks ??= []).push({ taskId: task.task_id, ok: sc.ok, doubts: sc.doubts });
            if (sc.ok) this.decide('SELF_CHECK', 'Kabul öncesi öz kontrol temiz', 'Değişiklikler spec ve kabul kriterleriyle uyumlu görüldü.', task.task_id);
            if (!sc.ok) {
              selfCheckRepairs.set(task.task_id, 1);
              this.decide('SELF_CHECK', `Kabul öncesi öz kontrolde ${sc.doubts.length} şüphe bulundu`, 'Sonuç spec/kriterlerle tam örtüşmüyor olabilir; kabul ertelendi.', task.task_id);
              this.decide('TASK_REPAIR', `${task.task_id} düzeltmeye geri gönderildi`, 'Öz kontrolde bulunan eksikler giderilsin diye (görev başına en fazla bir kez).', task.task_id);
              this.emit('VERIFICATION', `Director öz kontrolü: kabulden önce düzeltme istendi — ${monitorText(sc.doubts.join(' | '), 400)}`, task.task_id, 'warn');
              await reopenTask(task.task_id, true).catch(() => undefined);
              extraGuidance = [
                `Director self-check BEFORE acceptance found gaps in ${task.task_id} versus the spec/criteria:`,
                ...sc.doubts.map((d) => `- ${d}`),
                `Re-emit IMPLEMENT_TASK for ${task.task_id}: keep the correct work, fix exactly these gaps (inside the task scope).`,
                execNote,
              ].filter(Boolean).join('\n');
              continue;
            }
          }
          if (result.status === 'COMPLETED_SUCCESS') {
            if (execNote) carryNote = `(From the previous task ${task.task_id}) ${execNote}`;
            taskReport.status = 'ACCEPTED';
            accepted.add(task.task_id);
            this.emit('TASK_ACCEPTED', `${task.task_id} kabul edildi (bağımsız kanıt)`, task.task_id);
            this.decide('TASK_ACCEPT', `${task.task_id} kabul edildi`, isAnalysis ? 'Salt-okunur analiz tamamlandı.' : 'Bağımsız doğrulama (testler/kontroller) başarılı oldu.', task.task_id);
            await this.markTaskAccepted(specStore, task.task_id);
            // The closed loop may already checkpoint-commit accepted work; otherwise commit here.
            const headAfter = await gitHead(projectRoot);
            if (headAfter && headAfter !== headBefore) {
              taskReport.commit = headAfter;
              taskReport.filesChanged = await commitFiles(projectRoot, headBefore, headAfter);
              report.commits.push(...(await commitRange(projectRoot, headBefore, headAfter)));
            } else if (this.options.commit !== false && !isAnalysis) {
              const commit = await commitTask(projectRoot, task.task_id, task.title, result.systemEvidence?.evidenceId);
              if (commit) {
                taskReport.commit = commit.sha;
                taskReport.filesChanged = commit.files;
                report.commits.push(commit.sha);
              }
            }
            if (taskReport.filesChanged.length === 0 && result.systemEvidence) {
              taskReport.filesChanged = result.systemEvidence.changedFiles.map((f) => f.path);
            }
            if (!isAnalysis) {
              sinceNote.push(task.task_id);
              await postProgressNote();
            }

            // Post-scaffold tree rescan & scope remapping (MOD-05)
            if (task.task_id === 'TASK-000') {
              try {
                const refreshed = await detectWorkspaceStatus(projectRoot);
                if (refreshed.isInitialized) {
                  this.emit('INFO', `TASK-000 completed. Workspace initialized with ecosystems: ${refreshed.detectedEcosystems.join(', ')}`);
                }
              } catch {
                /* non-fatal discovery notification */
              }
            }
            break;
          }

          if (
            (result.status === 'NO_ACTION_REQUIRED' && actionType === 'REQUEST_CLARIFICATION') ||
            actionType === 'REQUEST_CLARIFICATION'
          ) {
            if (clarificationBudget <= 0) {
              stop = { status: 'BLOCKED_ON_HUMAN', reason: 'Director kept requesting clarification beyond the assumption budget.' };
              break;
            }
            clarificationBudget--;
            const question = extractQuestion(result) ?? 'unspecified ambiguity';
            const assumption = `[${task.task_id}] Director asked "${question}"; proceeding with the most conventional interpretation consistent with the spec.`;
            report.assumptions.push(assumption);
            this.emit('ASSUMPTION', assumption, task.task_id);
            taskReport.cycles--; // a clarification answered by assumption does not consume an execution attempt
            extraGuidance = `Clarification is not available for routine details. ${assumption} Proceed with IMPLEMENT_TASK. If this is a genuine product decision, use REQUEST_HUMAN_DECISION instead.`;
            continue;
          }

          if (result.status === 'NO_ACTION_REQUIRED') {
            extraGuidance = `Task ${task.task_id} is not complete yet. Emit IMPLEMENT_TASK for it. ${execNote}`.trim();
            continue;
          }

          // ---- Project identity / binding mismatch is DETERMINISTIC: retrying the task or moving on to
          // the next ones only reproduces the same rejection (and burns every task's attempts). Stop
          // the whole run once, with one clear reason, instead of cascading through the task list.
          if (isProjectIdentityFailure(result.summary)) {
            taskReport.status = 'BLOCKED';
            taskReport.cycles = Math.max(0, taskReport.cycles - 1); // nothing was executed
            stop = {
              status: 'BLOCKED_ON_HUMAN',
              reason: `${task.task_id} durdu: proje kimliği uyuşmazlığı (${monitorText(result.summary ?? '', 300)}). Bu hata tekrar denemeyle düzelmez; diğer görevler de aynı nedenle reddedileceği için çalışma durduruldu. Kontrol et: ${PROJECT_IDENTITY_PIN_FILE.replace(/\\/g, '/')}.`,
            };
            this.emit('TASK_BLOCKED', stop.reason, task.task_id, 'error');
            break;
          }

          // ---- Policy denied a path outside the mandate (e.g. a glob or a URL the Director put in
          // targetFiles): fixable. First a repair turn, then the PO decides (Turkish, passkey).
          const deniedPath = !isAnalysis && result.status === 'REJECTED_BY_POLICY' ? policyDeniedPath(result.summary) : null;
          if (deniedPath !== null) {
            const scopeNow = currentScopeOf(taskDefs.get(task.task_id)!);
            taskReport.cycles--; // no execution happened; the attempt is not consumed
            // Typo of an allowed name (blog.htm -> blog.html): corrected by feedback, no strike.
            const fix = nearMissPath(deniedPath, [...scopeNow, ...specTargets].filter((x) => !/[*?[{]/.test(x)));
            const fixes = nearMissFixes.get(task.task_id) ?? 0;
            if (fix && fixes < 2) {
              nearMissFixes.set(task.task_id, fixes + 1);
              this.emit('VERIFICATION', `Hedef dosya adı düzeltildi: '${deniedPath}' → '${fix}'`, task.task_id, 'warn');
              extraGuidance = [
                `The policy engine rejected target '${deniedPath}' for ${task.task_id}: it is not an allowed file. You almost certainly meant '${fix}'.`,
                `Use exactly '${fix}' (never '${deniedPath}') in targetFiles and in the executor instruction. Re-emit IMPLEMENT_TASK for ${task.task_id}.`,
              ].join('\n');
              continue;
            }
            const strikes = (policyStrikes.get(task.task_id) ?? 0) + 1;
            policyStrikes.set(task.task_id, strikes);
            this.emit('VERIFICATION', `Politika reddi: '${deniedPath}' izinli yolların dışında`, task.task_id, 'warn');
            if (strikes === 1) {
              extraGuidance = [
                `The policy engine rejected the previous IMPLEMENT_TASK for ${task.task_id}: target file '${deniedPath}' is outside the allowed paths.`,
                'targetFiles must be literal project-relative file paths (no globs like *.html, no URLs) inside the allowed paths.',
                `Use the task's files: ${scopeNow.filter((x) => !/[*?[{]/.test(x)).join(', ') || '(none listed)'}; allowed paths: ${(report.mandate?.allowedDirectories ?? []).join(', ')}.`,
                `Re-emit IMPLEMENT_TASK for ${task.task_id}.`,
              ].join('\n');
              continue;
            }
            if (decisionMode === 'ask' && decisionResolver) {
              const literal = !/[*?[{]/.test(deniedPath) && !looksLikeUrl(deniedPath) && isSafeProjectRelativePath(deniedPath);
              const record = buildDecisionRecord({
                projectRoot,
                projectId,
                runId,
                taskId: task.task_id,
                packageId: approved.packageId,
                revision: approved.revision,
                question: [
                  `Görev ${task.task_id} ('${monitorText(task.title, 120)}') onayladığın izinli yolların dışındaki bir dosyaya yazmak istedi: '${monitorText(deniedPath, 200)}'.`,
                  literal ? '' : 'Bu bir dosya yolu değil (joker karakter veya adres); kapsama eklenemez.',
                  `Görevin kapsamı: ${monitorText(scopeNow.join(', '), 300)}. Ne yapılsın?`,
                ]
                  .filter(Boolean)
                  .join(' '),
                reason: 'Politika motoru (P21) izinli yolların dışındaki hedefleri reddeder. Bu bir güvenlik ihlali değil; karar senin.',
                options: [
                  { id: 'widen', label: 'Kapsamı genişlet ve devam et (bu dosyalar göreve eklenir)' },
                  { id: 'revert', label: 'Fazla dosyaları at ve tekrar dene' },
                  { id: 'stop', label: 'Çalışmayı durdur' },
                ],
                recommendation: literal ? 'widen' : 'revert',
                allowFreeText: true,
              });
              (record as { kind?: string }).kind = 'POLICY_PATH';
              await saveDecisionRecord(record);
              report.decisions.push({ decisionId: record.decisionId, taskId: task.task_id, question: record.question, state: 'PENDING', channel: decisionResolver.channel });
              taskReport.status = 'WAITING_DECISION';
              this.pendingDecisionIds.add(record.decisionId);
              this.emit('DECISION_REQUESTED', `İzinli yol dışı hedef: ${task.task_id} (${record.decisionId})`, task.task_id, 'warn');
              scopeFiles.set(task.task_id, [deniedPath]);
              const resolver = decisionResolver;
              const promise = resolver
                .resolve(record)
                .catch((err): DecisionOutcome => ({ status: 'FAILED', reason: err instanceof Error ? err.message : String(err) }))
                .then((outcome) => ({ taskId: task.task_id, outcome }));
              waiting.set(task.task_id, { record, kind: 'POLICY_PATH', promise });
              return 'DEFERRED';
            }
            taskReport.status = 'BLOCKED';
            stop = { status: 'BLOCKED_ON_HUMAN', reason: `Task ${task.task_id}: target '${deniedPath}' is outside the allowed paths (policy). No human decision channel.` };
            this.emit('TASK_BLOCKED', stop.reason, task.task_id, 'error');
            break;
          }

          // ---- Scope mismatch only (files changed outside implementationScope, but no workspace escape,
          // binding/baseline problem or unsafe path): repairable, never a security hard stop.
          const outOfScope = !isAnalysis ? scopeOnlyViolation(result) : null;
          if (outOfScope) {
            const strikes = (scopeStrikes.get(task.task_id) ?? 0) + 1;
            scopeStrikes.set(task.task_id, strikes);
            scopeFiles.set(task.task_id, outOfScope);
            // The whole attempt is set aside before any retry: kept in-scope files would make the next
            // attempt a no-op that independent verification cannot attribute.
            const attemptFiles = [
              ...new Set([...outOfScope, ...(result.systemEvidence?.changedFiles ?? []).map((f) => f.path.split(' -> ').pop()!.trim())]),
            ];
            scopeAttemptFiles.set(task.task_id, attemptFiles);
            const scopeNow = currentScopeOf(taskDefs.get(task.task_id)!);
            this.emit('VERIFICATION', `${outOfScope.length} dosya görev kapsamı dışında: ${monitorText(outOfScope.join(', '), 300)}`, task.task_id, 'warn');
            if (strikes === 1 && taskReport.cycles < maxCycles) {
              // Repair cycle: out-of-scope files are set aside (recoverable, never deleted) so the next
              // attempt is measured against a clean baseline; the Director decides how to proceed.
              const q = await quarantineFiles(projectRoot, runId, task.task_id, taskReport.cycles, attemptFiles).catch(() => null);
              await reopenTask(task.task_id).catch((err: unknown) => report.warnings.push(`reopen ${task.task_id} failed: ${err instanceof Error ? err.message : String(err)}`));
              this.decide('SCOPE', `${task.task_id} kapsam dışı dosyalara dokundu; deneme kenara alındı`, `Kapsam dışı: ${outOfScope.slice(0, 5).join(', ')}. Değişiklikler silinmedi, karantinaya alındı; görev yalnızca kendi kapsamında yeniden denenecek.`, task.task_id);
              extraGuidance = [
                `Attempt ${taskReport.cycles}/${maxCycles} for ${task.task_id} changed files OUTSIDE this task's implementationScope: ${outOfScope.join(', ')}.`,
                'This is a scope mismatch, not a security incident.',
                q
                  ? `AIDM set this attempt's changes aside (${q}, recoverable): the next attempt starts from the last commit and must recreate the in-scope work.`
                  : '',
                `Allowed implementationScope: ${scopeNow.join(', ')}.`,
                `Re-emit IMPLEMENT_TASK for ${task.task_id} and instruct the executor to change ONLY files inside that scope. ` +
                  'If files outside it are genuinely required, state exactly which ones and why in the rationale: the Product Owner will be asked to widen the scope.',
                execNote,
              ]
                .filter(Boolean)
                .join('\n');
              continue;
            }
            if (decisionMode === 'ask' && decisionResolver) {
              const allInMandate = outOfScope.every(isWithinAllowed);
              const question = [
                `Görev ${task.task_id} ('${monitorText(task.title, 120)}') izin verilen dosya kapsamının dışında dosyalar değiştirdi (${strikes}. kez).`,
                `Kapsam dışı dosyalar: ${monitorText(outOfScope.join(', '), 600)}.`,
                `Görevin kapsamı: ${monitorText(scopeNow.join(', '), 300)}.`,
                allInMandate ? '' : 'Not: bu dosyaların bir kısmı onayladığın izinli yolların dışında; bunlar kapsama eklenemez.',
                'Ne yapılsın?',
              ]
                .filter(Boolean)
                .join(' ');
              const record = buildDecisionRecord({
                projectRoot,
                projectId,
                runId,
                taskId: task.task_id,
                packageId: approved.packageId,
                revision: approved.revision,
                question,
                reason:
                  'Bağımsız doğrulama, görev kapsamı dışındaki dosya değişikliklerini kabul etmez. Bu bir güvenlik ihlali değil (çalışma alanı dışına çıkış veya bağlama hatası yok); karar senin.',
                options: [
                  { id: 'widen', label: 'Kapsamı genişlet ve devam et (bu dosyalar göreve eklenir)' },
                  { id: 'revert', label: 'Fazla dosyaları at ve tekrar dene' },
                  { id: 'stop', label: 'Çalışmayı durdur' },
                ],
                recommendation: allInMandate ? 'widen' : 'revert',
                allowFreeText: true,
              });
              (record as { kind?: string }).kind = 'SCOPE_VIOLATION';
              await saveDecisionRecord(record);
              report.decisions.push({ decisionId: record.decisionId, taskId: task.task_id, question: record.question, state: 'PENDING', channel: decisionResolver.channel });
              taskReport.status = 'WAITING_DECISION';
              this.pendingDecisionIds.add(record.decisionId);
              this.emit('DECISION_REQUESTED', `Kapsam dışı dosyalar: ${task.task_id} (${record.decisionId})`, task.task_id, 'warn');
              const resolver = decisionResolver;
              const promise = resolver
                .resolve(record)
                .catch((err): DecisionOutcome => ({ status: 'FAILED', reason: err instanceof Error ? err.message : String(err) }))
                .then((outcome) => ({ taskId: task.task_id, outcome }));
              waiting.set(task.task_id, { record, kind: 'SCOPE_VIOLATION', promise });
              return 'DEFERRED';
            }
            taskReport.status = 'BLOCKED';
            stop = {
              status: 'BLOCKED_ON_HUMAN',
              reason: `Task ${task.task_id} changed files outside its implementationScope (${monitorText(outOfScope.join(', '), 300)}). No human decision channel to widen the scope.`,
            };
            this.emit('TASK_BLOCKED', stop.reason, task.task_id, 'error');
            break;
          }

          // ---- AGY outcome unknown (e.g. timeout): never a silent end. Look at what it left behind and
          // let the PO decide (Turkish, passkey): wait/retry, check+accept the changes, or stop.
          // Unexpected errors that would need a human get the same Turkish decision (retry / stop).
          const unexpected = result.status === 'EXECUTION_FAILED' && !!result.humanDecisionRequired;
          if (!isAnalysis && (result.status === 'EXECUTION_UNKNOWN' || unexpected)) {
            const { dirty } = await foreignUncommittedChanges(projectRoot, specPath);
            const left = dirty.filter((f) => f !== relSpecPath && !specRelPaths.has(f));
            unknownFiles.set(task.task_id, left);
            const secs = Math.round(((result as { durationMs?: number }).durationMs ?? 0) / 1000);
            const why = unexpected
              ? `${task.task_id} durdu: beklenmeyen bir hata oluştu, devam etmek için kararın gerekiyor (${result.status}: ${monitorText(result.summary ?? '', 200)}).`
              : `${task.task_id} durdu: AGY işi ${secs ? `${Math.max(1, Math.round(secs / 60))} dakikada ` : ''}bitiremedi ya da sonucu belirsiz kaldı; aynı işi iki kez yaptırmamak için durdum (EXECUTION_UNKNOWN).`;
            this.emit('TASK_BLOCKED', why, task.task_id, 'warn');
            if (decisionMode === 'ask' && decisionResolver) {
              const record = buildDecisionRecord({
                projectRoot,
                projectId,
                runId,
                taskId: task.task_id,
                packageId: approved.packageId,
                revision: approved.revision,
                question: [
                  why,
                  left.length ? `Çalışma alanında AGY'nin bıraktığı ${left.length} değişiklik var: ${monitorText(left.join(', '), 400)}.` : 'Çalışma alanında yeni bir değişiklik yok.',
                  'Ne yapılsın?',
                ].join(' '),
                reason: unexpected
                  ? 'Hata otomatik olarak düzeltilemedi. Tekrar denersem görev güncel bağlamla baştan istenir.'
                  : 'AGY bitti mi bilmiyoruz; körlemesine tekrar başlatmak aynı işi iki kez yaptırabilir. Karar senin.',
                options: [
                  { id: 'retry', label: 'Bekle ve tekrar dene (bırakılan değişiklikler kenara alınır, görev baştan yapılır)' },
                  ...(left.length ? [{ id: 'verify', label: 'Değişiklikleri kontrol et ve kabul et (AGY bıraktığı yerden tamamlar, bağımsız doğrulama yapılır)' }] : []),
                  { id: 'stop', label: 'Çalışmayı durdur' },
                ],
                recommendation: left.length ? 'verify' : 'retry',
                allowFreeText: true,
              });
              (record as { kind?: string }).kind = 'EXECUTION_UNKNOWN';
              await saveDecisionRecord(record);
              report.decisions.push({ decisionId: record.decisionId, taskId: task.task_id, question: record.question, state: 'PENDING', channel: decisionResolver.channel });
              taskReport.status = 'WAITING_DECISION';
              this.pendingDecisionIds.add(record.decisionId);
              this.emit('DECISION_REQUESTED', `Sonucu belirsiz AGY adımı: ${task.task_id} (${record.decisionId})`, task.task_id, 'warn');
              const resolver = decisionResolver;
              const promise = resolver
                .resolve(record)
                .catch((err): DecisionOutcome => ({ status: 'FAILED', reason: err instanceof Error ? err.message : String(err) }))
                .then((outcome) => ({ taskId: task.task_id, outcome }));
              waiting.set(task.task_id, { record, kind: 'EXECUTION_UNKNOWN', promise });
              return 'DEFERRED';
            }
            taskReport.status = 'BLOCKED';
            stop = { status: 'BLOCKED_ON_HUMAN', reason: `${why} Karar kanalı yok; IdP'de "Kaldığı yerden devam et" ile sürdürebilirsin.` };
            break;
          }

          // Fail-closed governance gate: preserves authoritative policy boundary when actions cannot be dispatched autonomously.
          if (
            result.status === 'BLOCKED_ON_APPROVAL' ||
            result.status === 'REJECTED_BY_POLICY' ||
            result.status === 'EXECUTION_UNKNOWN' ||
            (result.humanDecisionRequired && result.status !== 'MAX_ATTEMPTS_EXCEEDED')
          ) {
            taskReport.status = 'BLOCKED';
            stop = {
              status: 'BLOCKED_ON_HUMAN',
              reason: `${task.task_id} durdu: ${turkishStatus(result.status)} İnsan onayı gerekiyor (${result.status}: ${monitorText(result.summary ?? '', 200)}).`,
            };
            break;
          }

          if (/ERR_(BUDGET|INSUFFICIENT|PRICING|UNSUPPORTED_BILLING|INVALID_BUDGET)|budget/i.test(result.summary ?? '')) {
            stop = {
              status: 'BUDGET_EXHAUSTED',
              reason: `${result.summary} (budget governance stop; raising budget or pricing changes require human action)`,
            };
            break;
          }

          // EXECUTION_FAILED / CORRECTIVE_TASK_CREATED / MAX_ATTEMPTS_EXCEEDED: bounded retry
          // Repair cycle: the independent verification output goes back to the Director.
          extraGuidance = [
            `Attempt ${taskReport.cycles}/${maxCycles} for ${task.task_id} failed independent verification: ${monitorText(result.summary, 300)}.`,
            lastFailure ? `Failing checks (AIDM-collected output tails):\n${lastFailure}` : '',
            execNote,
            `Direct the executor to fix exactly these failures (keep already-correct files), then retry IMPLEMENT_TASK for ${task.task_id}.`,
          ]
            .filter(Boolean)
            .join('\n');
          if (result.status === 'MAX_ATTEMPTS_EXCEEDED') break;
        }

        // Attempts exhausted: the RUNNER (never the Director) asks the PO what to do.
        if (taskReport.status === 'PENDING' && !stop && taskReport.kind !== 'ANALYSIS' && (taskReport.cycles >= maxCycles || taskReport.lastCycleStatus === 'MAX_ATTEMPTS_EXCEEDED')) {
          if (decisionMode === 'ask' && decisionResolver) {
            const budgetLeft = !isBudgetExhausted(budgetManager!);
            const diagnosis = monitorText(this.lastDirectorAction?.taskId === task.task_id ? this.lastDirectorAction.rationale : '', 300);
            const question = [
              `Görev ${task.task_id} ('${monitorText(task.title, 120)}') ${taskReport.cycles} denemede bağımsız doğrulamayı geçemedi.`,
              lastFailure ? `Son başarısız kontrol: ${monitorText(lastFailure, 400)}` : `Son durum: ${monitorText(taskReport.lastSummary, 300)}`,
              diagnosis ? `Director teşhisi: ${diagnosis}` : '',
              'Ne yapılsın?',
            ]
              .filter(Boolean)
              .join(' ');
            const record = buildDecisionRecord({
              projectRoot,
              projectId,
              runId,
              taskId: task.task_id,
              packageId: approved.packageId,
              revision: approved.revision,
              question,
              reason: 'Deneme hakkı bitti (sistem tarafından açılan karar; Director cevaplayamaz).',
              options: [
                { id: 'retry_2', label: 'Bu göreve 2 deneme daha ver' },
                { id: 'skip', label: 'Görevi atla (bağımlı görevler de atlanır)' },
                { id: 'stop', label: 'Çalışmayı durdur' },
              ],
              recommendation: budgetLeft ? 'retry_2' : undefined,
              allowFreeText: true,
            });
            (record as { kind?: string }).kind = 'ATTEMPTS_EXHAUSTED';
            await saveDecisionRecord(record);
            report.decisions.push({ decisionId: record.decisionId, taskId: task.task_id, question: record.question, state: 'PENDING', channel: decisionResolver.channel });
            taskReport.status = 'WAITING_DECISION';
            this.pendingDecisionIds.add(record.decisionId);
            this.emit('DECISION_REQUESTED', `Deneme hakkı bitti: ${task.task_id} (${record.decisionId})`, task.task_id, 'warn');
            this.decide('TASK_REPAIR', `${task.task_id} için deneme hakkı bitti; ürün sahibine soruldu`, 'Görev bağımsız doğrulamayı geçemedi; daha fazla deneme, atlama ya da durdurma kararı ürün sahibinde.', task.task_id);
            const resolver = decisionResolver;
            const promise = resolver
              .resolve(record)
              .catch((err): DecisionOutcome => ({ status: 'FAILED', reason: err instanceof Error ? err.message : String(err) }))
              .then((outcome) => ({ taskId: task.task_id, outcome }));
            waiting.set(task.task_id, { record, kind: 'ATTEMPTS_EXHAUSTED', promise });
            return 'DEFERRED';
          }
          taskReport.status = 'BLOCKED';
          stop = {
            status: 'BLOCKED_ON_HUMAN',
            reason: `Task ${task.task_id} did not pass independent verification within ${maxCycles} attempt(s)${
              lastFailure ? ` (last failure: ${monitorText(lastFailure, 300)})` : ''
            }. ${decisionMode === 'assume' ? 'AIDM_DECISION_MODE=assume never auto-retries.' : 'No human decision channel to grant more attempts.'}`,
          };
          this.emit('TASK_BLOCKED', stop.reason, task.task_id, 'error');
        }

        if (taskReport.status === 'PENDING') taskReport.status = stop ? 'BLOCKED' : 'FAILED';
        if (taskReport.status === 'FAILED' && taskReport.kind !== 'ANALYSIS' && !stop) {
          stop = { status: 'PARTIAL', reason: `Task ${task.task_id} did not reach independently verified success within ${maxCycles} cycle(s).` };
        }
        return 'DONE';
      };

      const dependsOnUnfinished = (taskReport: AutonomousTaskReport): boolean => {
        const def = taskDefs.get(taskReport.taskId);
        const deps = def?.dependencies ?? [];
        return deps.some(
          (d) =>
            waiting.has(d) ||
            !accepted.has(d) ||
            report.tasks.some(
              (t) =>
                t.taskId === d &&
                (t.status === 'WAITING_DECISION' ||
                  t.status === 'SPLIT' ||
                  t.status === 'PENDING')
            )
        );
      };

      const finishSplitParents = async (): Promise<void> => {
        for (const parent of report.tasks.filter((t) => t.status === 'SPLIT')) {
          const subs = report.tasks.filter((t) => t.parentTaskId === parent.taskId && t.kind === 'SUBTASK');
          if (subs.length && subs.every((t) => t.status === 'ACCEPTED')) {
            parent.status = 'ACCEPTED';
            parent.evidenceIds.push(...subs.flatMap((t) => t.evidenceIds));
            parent.filesChanged = [...new Set(subs.flatMap((t) => t.filesChanged))];
            parent.lastSummary = `Accepted via subtasks ${subs.map((t) => t.taskId).join(', ')} (each independently verified).`;
            accepted.add(parent.taskId);
            await this.markTaskAccepted(specStore, parent.taskId);
          }
        }
      };

      // ---- Spec clarification ("Netleştirme"): BEFORE any implementation the Director reviews the
      // whole plan and asks the PO (via the IdP only) about open points / proposes improvements.
      let clarificationNote = '';
      const extraGateCommands: string[] = [];
      if (!stop) {
        const out = await this.runClarificationPhase({
          projectRoot,
          projectId,
          runId,
          packageId: approved.packageId,
          revision: approved.revision,
          markdown: specContext.reviewContext(40_000),
          ingestion,
          report,
          provider,
          model: baseProvider.defaultModel,
          decisionMode,
          isBudgetExhausted: () => isBudgetExhausted(budgetManager!),
          resuming: !!resumeFrom,
        });
        if (out.stop) stop = out.stop;
        if (!stop && out.apply) {
          const res = out.apply;
          // Criteria: per task (or '*' = every top-level task), recorded in the spec store too.
          const top = report.tasks.filter((t) => t.kind === 'TASK' && !accepted.has(t.taskId));
          let added = 0;
          for (const t of top) {
            const extra = [...(res.criteria.get('*') ?? []), ...(res.criteria.get(t.taskId) ?? [])];
            const def = taskDefs.get(t.taskId);
            if (!def || !extra.length) continue;
            const merged = [...def.acceptance_criteria];
            for (const c of extra) if (!merged.includes(c)) (merged.push(c), added++);
            taskDefs.set(t.taskId, { ...def, acceptance_criteria: merged });
          }
          // In-scope new tasks (accepted improvements), appended after the spec tasks.
          const template = taskDefs.get(top[0]?.taskId ?? '') ?? [...taskDefs.values()][0];
          let n = 0;
          for (const nt of res.newTasks) {
            const id = `TASK-C${String(++n).padStart(2, '0')}`;
            if (accepted.has(id)) continue;
            const files = nt.targetFiles.filter(isWithinAllowed);
            if (nt.targetFiles.length && !files.length) {
              report.assumptions.push(`[${SPEC_CLARIFICATION_TASK_ID}] Yeni görev '${nt.title}' izinli yolların dışında; eklenmedi.`);
              continue;
            }
            if (!template || report.tasks.some((t) => t.taskId === id)) continue;
            const def: TaskDefinition = {
              ...template,
              task_id: id,
              title: nt.title,
              description: nt.description,
              acceptance_criteria: [...nt.criteria, ...(res.criteria.get('*') ?? [])].slice(0, 12),
              traceability_sources: [...(template.traceability_sources ?? [])],
              status: TaskStatus.READY,
              attempt: 0,
              metadata: { ...(template.metadata ?? {}), targetFiles: files, fromClarification: nt.fromQuestion },
            } as TaskDefinition;
            taskDefs.set(id, def);
            const tr: AutonomousTaskReport = { taskId: id, title: def.title, status: 'PENDING', cycles: 0, evidenceIds: [], verificationChecks: [], filesChanged: [], kind: 'TASK' };
            report.tasks.push(tr);
            queue.push(tr);
            this.decide('TASK_CREATE', `${id}: ${def.title}`, 'Netleştirmede kabul edilen iyileştirmeden eklendi.', id);
            report.clarification!.newTasks.push(`${id}: ${def.title}`);
          }
          clarificationChecks = res.checks;
          report.clarification!.criteriaAdded = added;
          // Objective checks -> generated dependency-free script on the final gate (committed by AIDM).
          if (res.checks.length) {
            const abs = path.join(projectRoot, CHECKS_SCRIPT_PATH);
            const content = renderChecksScript(res.checks);
            const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
            if (prev !== content) {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, content, 'utf8');
              if (this.options.commit !== false) {
                try {
                  await git(projectRoot, ['add', '--', CHECKS_SCRIPT_PATH]);
                  await git(projectRoot, ['commit', '-m', 'chore(aidm): spec clarification checks', '--', CHECKS_SCRIPT_PATH]);
                } catch {
                  /* nothing to commit */
                }
              }
            }
            extraGateCommands.push(`node ${CHECKS_SCRIPT_PATH}`);
            report.clarification!.checksScript = CHECKS_SCRIPT_PATH;
          }
          if (res.designBrief) {
            // Director-owned visual direction: binding for every UI task; AGY never invents a palette.
            await saveDesignBrief(projectRoot, res.designBrief);
            report.designBrief = { name: res.designBrief.name, optionId: res.designBrief.optionId, tokens: res.designBrief.tokens, decidedBy: res.designBrief.decidedBy };
            this.emit('CLARIFICATION', `Tasarım yönü bağlayıcı: ${res.designBrief.name || res.designBrief.optionId} (${Object.keys(res.designBrief.tokens).length} CSS değişkeni)`);
          }
          if (res.notes.length) {
            const notes = [...res.notes].sort((a, b) => Number(b.startsWith('[design-brief]')) - Number(a.startsWith('[design-brief]')));
            clarificationNote = `BINDING PRODUCT_OWNER SPEC CLARIFICATIONS (verified answers; follow them in every task): ${notes.join(' | ')}`.slice(0, 3000);
          }
        }
      }

      // ---- Task scope + criteria land in the spec store (the driver builds the instruction's
      // implementationScope and acceptanceCriteria from it). Existing tasks keep their revision and
      // status; only criteria/metadata change (intents bind to the revision number).
      if (!stop) {
        for (const t of report.tasks) {
          if (accepted.has(t.taskId)) continue;
          const def = taskDefs.get(t.taskId);
          if (!def) continue;
          const meta = (def.metadata ?? {}) as Record<string, unknown>;
          const tf = Array.isArray(meta.targetFiles) ? (meta.targetFiles as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          // The shared page-asset scope is a PO-approved rule; other extras must lie inside the mandate.
          // A task without its own files (e.g. "CSS", "Erişilebilirlik") works on the spec's files.
          const basis = tf.length ? tf : specTargets;
          const extra = [...(tf.length ? [] : specTargets), ...scopeExtrasForTask(basis, clarificationChecks)].filter(
            (e) => SHARED_PAGE_ASSET_SCOPE.includes(e) || isWithinAllowed(e)
          );
          const prevExtra = Array.isArray(meta.implementationScopeExtra) ? (meta.implementationScopeExtra as string[]) : [];
          const merged = [...new Set([...prevExtra, ...extra])];
          if (merged.length) taskDefs.set(t.taskId, { ...def, metadata: { ...meta, implementationScopeExtra: merged } } as TaskDefinition);
        }
        try {
          await persistTaskDefs();
        } catch (err) {
          report.warnings.push(`Spec store update (scope/criteria) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      while (!stop) {
        let next: AutonomousTaskReport | undefined;
        // Strictly serial by default: while ANY task waits for a human decision, no other task is
        // started (a blocked task usually means a shared problem — e.g. a broken scaffold — that would
        // make every following task fail and burn its attempts). Opt out: AIDM_CONTINUE_WHILE_WAITING=1.
        const holdForDecision = waiting.size > 0 && this.env.AIDM_CONTINUE_WHILE_WAITING !== '1';
        const idx = holdForDecision ? -1 : queue.findIndex((t) => !dependsOnUnfinished(t));
        if (idx >= 0) next = queue.splice(idx, 1)[0];
        if (!next) {
          if (waiting.size === 0) {
            if (queue.length) {
              stop = { status: 'BLOCKED_ON_HUMAN', reason: `Tasks ${queue.map((q) => q.taskId).join(', ')} depend on unfinished work.` };
            }
            break;
          }
          // Only tasks waiting on human decisions remain: wait for the first answer
          // (instructions — e.g. STOP — are still polled meanwhile).
          const raced = await Promise.race([
            ...[...waiting.values()].map((w) => w.promise),
            new Promise<null>((res) => setTimeout(() => res(null), channel?.opened ? pollMs : 2_147_000_000).unref?.()),
          ]);
          if (!raced) {
            await applyInstructions();
            continue;
          }
          const { taskId, outcome } = raced;
          const w = waiting.get(taskId)!;
          waiting.delete(taskId);
          this.pendingDecisionIds.delete(w.record.decisionId);
          const tr = report.tasks.find((t) => t.taskId === taskId)!;
          const entry = report.decisions.find((d) => d.decisionId === w.record.decisionId);
          w.record.state = outcome.status === 'ANSWERED' ? 'ANSWERED' : outcome.status;
          if (outcome.status === 'ANSWERED') {
            w.record.answer = outcome.answer;
            if (entry) {
              entry.state = 'ANSWERED';
              entry.answer = outcome.answer;
            }
            await saveDecisionRecord(w.record);
            if (w.kind === 'EXECUTION_UNKNOWN') {
              const sel = outcome.answer.selectedOptionId;
              const note = outcome.answer.freeText ? monitorText(outcome.answer.freeText, 2000) : '';
              const files = unknownFiles.get(taskId) ?? [];
              this.emit('DECISION_ANSWERED', `${w.record.decisionId}: ${sel ?? 'serbest metin'}`, taskId);
              await historyManager.appendEvent({
                eventType: 'AUTONOMOUS_DECISION_ANSWERED',
                actor: Actor.USER,
                taskId,
                payload: { decisionId: w.record.decisionId, kind: 'EXECUTION_UNKNOWN', selectedOptionId: sel ?? null, files, answeredBy: outcome.answer.answeredBy },
              });
              if (sel === 'retry' || (sel === 'verify' && files.length)) {
                let q: string | null = null;
                if (sel === 'retry' && files.length) q = await quarantineFiles(projectRoot, runId, taskId, tr.cycles, files).catch(() => null);
                await reopenTask(taskId).catch(() => undefined);
                allowedAttempts.set(taskId, attemptsFor(taskId) + 1); // exactly +1 attempt; budget cap untouched
                guidance.set(
                  taskId,
                  [
                    sel === 'verify'
                      ? `AUTHORITATIVE PRODUCT_OWNER DECISION: the previous AGY step for ${taskId} timed out but left these uncommitted changes: ${files.join(', ')}. Instruct the executor to INSPECT them, finish only what is missing and keep what is correct (do not start over). Independent verification follows.`
                      : `AUTHORITATIVE PRODUCT_OWNER DECISION: the previous AGY step for ${taskId} timed out; its leftovers were set aside (${q ?? 'none'}). Redo ${taskId} from the last commit, in smaller steps.`,
                    note ? `Product Owner guidance: ${note}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n')
                );
                tr.status = 'PENDING';
                queue.unshift(tr);
              } else if (sel === 'stop') {
                tr.status = 'BLOCKED';
                stop = { status: 'STOPPED', reason: `Ürün sahibi kararıyla durduruldu (${w.record.decisionId}).` };
              } else {
                tr.status = 'BLOCKED';
                stop = { status: 'BLOCKED_ON_HUMAN', reason: `${taskId}: karar (${w.record.decisionId}) bir seçenek seçmedi; görev beklemede.` };
              }
              continue;
            }
            if (w.kind === 'POLICY_PATH') {
              const sel = outcome.answer.selectedOptionId;
              const p0 = (scopeFiles.get(taskId) ?? [])[0] ?? '';
              const literal = !!p0 && !/[*?[{]/.test(p0) && !looksLikeUrl(p0) && isSafeProjectRelativePath(p0);
              this.emit('DECISION_ANSWERED', `${w.record.decisionId}: ${sel ?? 'serbest metin'}`, taskId);
              await historyManager.appendEvent({
                eventType: 'AUTONOMOUS_DECISION_ANSWERED',
                actor: Actor.USER,
                taskId,
                payload: { decisionId: w.record.decisionId, kind: 'POLICY_PATH', selectedOptionId: sel ?? null, path: p0, answeredBy: outcome.answer.answeredBy },
              });
              if (sel === 'widen' && literal) {
                // The sealed mandate cannot change inside a run: the passkey-approved path is recorded
                // and sealed into the mandate of the next segment (resume = new passkey approval).
                await saveMandateExtension(projectRoot, ingestion.specFingerprint, p0, w.record.decisionId);
                tr.status = 'BLOCKED';
                stop = {
                  status: 'BLOCKED_ON_HUMAN',
                  reason: `PO approved '${p0}' for ${taskId} (${w.record.decisionId}); it is added to the mandate when the run is resumed ("Kaldığı yerden devam et").`,
                };
              } else if (sel === 'widen' || sel === 'revert') {
                policyStrikes.set(taskId, 0);
                guidance.set(
                  taskId,
                  `AUTHORITATIVE PRODUCT_OWNER DECISION: do NOT target '${p0}'. Emit IMPLEMENT_TASK for ${taskId} with literal file paths inside its scope only: ${currentScopeOf(taskDefs.get(taskId)!).filter((x) => !/[*?[{]/.test(x)).join(', ')}.`
                );
                tr.status = 'PENDING';
                queue.unshift(tr);
              } else if (sel === 'stop') {
                tr.status = 'BLOCKED';
                stop = { status: 'STOPPED', reason: `Ürün sahibi kararıyla durduruldu (${w.record.decisionId}).` };
              } else {
                tr.status = 'BLOCKED';
                stop = { status: 'BLOCKED_ON_HUMAN', reason: `Task ${taskId}: answer to ${w.record.decisionId} selected no option.` };
              }
              continue;
            }
            if (w.kind === 'SCOPE_VIOLATION') {
              const sel = outcome.answer.selectedOptionId;
              const note = outcome.answer.freeText ? monitorText(outcome.answer.freeText, 2000) : '';
              const files = scopeFiles.get(taskId) ?? [];
              this.emit('DECISION_ANSWERED', `${w.record.decisionId}: ${sel ?? 'serbest metin'}`, taskId);
              await historyManager.appendEvent({
                eventType: 'AUTONOMOUS_DECISION_ANSWERED',
                actor: Actor.USER,
                taskId,
                payload: { decisionId: w.record.decisionId, kind: 'SCOPE_VIOLATION', selectedOptionId: sel ?? null, files, answeredBy: outcome.answer.answeredBy },
              });
              if (sel === 'widen' || sel === 'revert') {
                const def = taskDefs.get(taskId)!;
                const meta = (def.metadata ?? {}) as Record<string, unknown>;
                let widened: string[] = [];
                let outside: string[] = files;
                if (sel === 'widen') {
                  widened = files.filter(isWithinAllowed);
                  outside = files.filter((f) => !isWithinAllowed(f));
                  const prev = Array.isArray(meta.implementationScopeExtra) ? (meta.implementationScopeExtra as string[]) : [];
                  taskDefs.set(taskId, { ...def, metadata: { ...meta, implementationScopeExtra: [...new Set([...prev, ...widened])] } } as TaskDefinition);
                  await persistTaskDefs().catch(() => undefined);
                  report.assumptions.push(`[${taskId}] PO widened the task scope with: ${widened.join(', ') || '-'}.`);
                }
                // The attempt is set aside (recoverable, never deleted) and redone with the decided scope.
                const q = await quarantineFiles(projectRoot, runId, taskId, tr.cycles, scopeAttemptFiles.get(taskId) ?? files).catch(() => null);
                await reopenTask(taskId).catch(() => undefined);
                const n = attemptsFor(taskId) + 1; // exactly +1 attempt; budget cap untouched
                allowedAttempts.set(taskId, n);
                scopeStrikes.set(taskId, 0);
                guidance.set(
                  taskId,
                  [
                    sel === 'widen'
                      ? `AUTHORITATIVE PRODUCT_OWNER DECISION: these files are now inside ${taskId}'s implementationScope: ${widened.join(', ')}. The previous attempt was set aside (${q ?? 'n/a'}); redo the task, these files included.`
                      : `AUTHORITATIVE PRODUCT_OWNER DECISION: do NOT create ${files.join(', ')}. The previous attempt was set aside (${q ?? 'n/a'}). Complete ${taskId} changing ONLY files inside its implementationScope: ${currentScopeOf(taskDefs.get(taskId)!).join(', ')}.`,
                    sel === 'widen' && outside.length ? `Outside the approved paths (still not allowed): ${outside.join(', ')}.` : '',
                    note ? `Product Owner guidance: ${note}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n')
                );
                tr.status = 'PENDING';
                queue.unshift(tr);
              } else if (sel === 'stop') {
                tr.status = 'BLOCKED';
                stop = { status: 'STOPPED', reason: `Ürün sahibi kararıyla durduruldu (${w.record.decisionId}).` };
              } else {
                tr.status = 'BLOCKED';
                stop = { status: 'BLOCKED_ON_HUMAN', reason: `Task ${taskId}: answer to ${w.record.decisionId} selected no option; scope unchanged.` };
              }
              continue;
            }
            if (w.kind === 'ATTEMPTS_EXHAUSTED') {
              const sel = outcome.answer.selectedOptionId;
              const note = outcome.answer.freeText ? monitorText(outcome.answer.freeText, 2000) : '';
              this.emit('DECISION_ANSWERED', `${w.record.decisionId}: ${sel ?? 'serbest metin'}`, taskId);
              await historyManager.appendEvent({
                eventType: 'AUTONOMOUS_DECISION_ANSWERED',
                actor: Actor.USER,
                taskId,
                payload: { decisionId: w.record.decisionId, kind: 'ATTEMPTS_EXHAUSTED', selectedOptionId: sel ?? null, answeredBy: outcome.answer.answeredBy },
              });
              if (sel === 'retry_2') {
                const n = attemptsFor(taskId) + 2; // exactly +2; budget cap untouched
                allowedAttempts.set(taskId, n);
                report.assumptions.push(`[${taskId}] PO granted 2 more attempts (now ${n}).`);
                guidance.set(
                  taskId,
                  [
                    'AUTHORITATIVE PRODUCT_OWNER DECISION: 2 more attempts granted for this task.',
                    note ? `Product Owner guidance for the retry: ${note}` : '',
                    tr.lastSummary ? `Last failure: ${monitorText(tr.lastSummary, 400)}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n')
                );
                tr.status = 'PENDING';
                queue.unshift(tr);
              } else if (sel === 'skip') {
                const skipped = new Set([taskId]);
                let grew = true;
                while (grew) {
                  grew = false;
                  for (const t of report.tasks) {
                    if (skipped.has(t.taskId)) continue;
                    const deps = taskDefs.get(t.taskId)?.dependencies ?? [];
                    if (deps.some((d) => skipped.has(d)) || (t.parentTaskId && skipped.has(t.parentTaskId) && t.status !== 'ACCEPTED')) {
                      skipped.add(t.taskId);
                      grew = true;
                    }
                  }
                }
                for (const t of report.tasks) {
                  if (skipped.has(t.taskId) && t.status !== 'ACCEPTED') {
                    t.status = 'SKIPPED';
                    t.lastSummary = `Ürün sahibi kararıyla atlandı (${w.record.decisionId}).`;
                  }
                }
                for (let i = queue.length - 1; i >= 0; i--) if (skipped.has(queue[i].taskId)) queue.splice(i, 1);
                report.skippedByPo = [...(report.skippedByPo ?? []), ...skipped];
              } else if (sel === 'stop') {
                tr.status = 'BLOCKED';
                stop = { status: 'STOPPED', reason: `Ürün sahibi kararıyla durduruldu (${w.record.decisionId}).` };
              } else {
                // Free text without an option grants nothing (fail closed).
                tr.status = 'BLOCKED';
                stop = { status: 'BLOCKED_ON_HUMAN', reason: `Task ${taskId}: answer to ${w.record.decisionId} selected no option; no attempts granted.` };
              }
              continue;
            }
            const statement = formatDecisionForDirector(w.record, outcome.answer);
            report.assumptions.push(`[${taskId}] PO decision: ${statement.split('\n').slice(1).join(' ')}`);
            await historyManager.appendEvent({
              eventType: 'AUTONOMOUS_DECISION_ANSWERED',
              actor: Actor.USER,
              taskId,
              payload: { decisionId: w.record.decisionId, source: outcome.answer.source, answeredBy: outcome.answer.answeredBy, selectedOptionId: outcome.answer.selectedOptionId ?? null },
            });
            guidance.set(taskId, statement);
            tr.status = 'PENDING';
            queue.unshift(tr);
            this.emit('DECISION_ANSWERED', w.record.decisionId, taskId);
          } else {
            w.record.failure = outcome.reason;
            if (entry) entry.state = outcome.status;
            await saveDecisionRecord(w.record);
            tr.status = 'BLOCKED';
            stop = { status: 'BLOCKED_ON_HUMAN', reason: `Task ${taskId}: human decision ${w.record.decisionId} ${outcome.status}: ${outcome.reason}` };
          }
          continue;
        }
        await runTask(next);
        await finishSplitParents();
      }
      if (stop) {
        for (const w of waiting.values()) {
          const tr = report.tasks.find((t) => t.taskId === w.record.taskId);
          if (tr) tr.status = 'BLOCKED';
        }
      }

      // ---- Final run-level acceptance gate: ALL global commands (+ command-like global
      // criteria) must pass on the finished tree. Missing referenced files = FAIL (fail closed).
      // Web projects always get spec-derived site checks (shared nav/CSS, links, tokens, browser).
      const webGate = !stop && this.env.AIDM_WEB_CHECKS !== '0' && report.tasks.some((t) => t.status === 'ACCEPTED') ? webGateCommands(projectRoot, { browser: this.env.AIDM_BROWSER_CHECK !== '0' }) : [];
      const gateCommands = [...finalGateCommands(ingestion.verificationCommands, ingestion.globalAcceptanceCriteria), ...extraGateCommands, ...webGate];
      const everyTaskAccepted = (): boolean =>
        report.tasks.filter((t) => t.kind !== 'ANALYSIS').every((t) => t.status === 'ACCEPTED' || t.status === 'SKIPPED');
      report.finalGate = { status: 'NOT_RUN', repairs: 0, checks: [], criteria: [...ingestion.globalAcceptanceCriteria] };
      if (!stop && everyTaskAccepted() && !(report.skippedByPo?.length) && !gateCommands.length) {
        // Nothing to run: never let COMPLETED read as a fully verified result.
        report.finalGate.status = 'NO_CHECKS';
        const w =
          "Son kabul kapısı çalıştırılamadı: spec'te '## Komutlar' / komut içeren kabul kriteri yok ve netleştirmeden üretilmiş kontrol de yok. " +
          'Görevler tek tek bağımsız kanıtla kabul edildi ama projenin bütünü otomatik olarak doğrulanmadı; elle kontrol et ya da spec\'e test/kontrol komutu ekle.';
        report.warnings.push(w);
        this.emit('FINAL_GATE', w, undefined, 'warn');
      }
      let visualPromise: Promise<VisualReview | null> | null = null;
      let visualRounds = 0;
      const startVisualReview = async (): Promise<VisualReview | null> => {
        if (this.env.AIDM_VISUAL_REVIEW === '0') return null;
        const shots = collectScreenshots(projectRoot);
        if (!shots.length) return null;
        return runVisualReview({
          provider: provider as never,
          model: baseProvider.defaultModel,
          projectId: report.projectId,
          runId,
          shots,
          designBrief: report.designBrief,
          isBudgetExhausted: () => isBudgetExhausted(budgetManager!),
        });
      };
      if (!stop && everyTaskAccepted() && !(report.skippedByPo?.length) && gateCommands.length) {
        const lastTop = [...report.tasks].reverse().find((t) => t.kind === 'TASK' && t.status === 'ACCEPTED');
        for (;;) {
          const checks = await runGateCommands(projectRoot, gateCommands, {
            parallel: this.env.AIDM_GATE_PARALLEL !== '0',
            // The visual review starts as soon as the browser check has its screenshots, while the
            // remaining checks (e.g. tests) are still running.
            onDone: (command, code) => {
              if (code === 0 && /web-browser-check/.test(command) && visualRounds < 2) {
                visualRounds++;
                visualPromise = startVisualReview();
              }
            },
          });
          const failed = checks.filter((c) => c.exitCode !== 0);
          report.finalGate.checks = checks;
          report.finalGate.status = failed.length ? 'FAIL' : 'PASS';
          this.emit('FINAL_GATE', `Son kabul kapısı: ${report.finalGate.status} (${checks.length - failed.length}/${checks.length})`, undefined, failed.length ? 'warn' : 'info');
          if (!failed.length || report.finalGate.repairs >= 2 || !lastTop || stop || isBudgetExhausted(budgetManager!)) break;
          report.finalGate.repairs++;
          const parent = taskDefs.get(lastTop.taskId)!;
          const fix = addSubtask(parent, `GATE-FIX-${report.finalGate.repairs}`, 'SUBTASK', {
            title: 'Son kabul kapısını geçir',
            description:
              `FINAL ACCEPTANCE GATE failed. Make ALL of these commands pass without breaking accepted work: ${gateCommands.join(' ; ')}. ` +
              `Global acceptance criteria: ${ingestion.globalAcceptanceCriteria.join(' | ')}. Failures:\n${formatGateFailures(failed)}`,
            acceptance: ['All final gate commands exit 0', ...ingestion.globalAcceptanceCriteria.slice(0, 8)],
            // Scope = files the run already touched + files the failing gate commands reference.
            targetFiles: [
              ...new Set([
                ...report.tasks.filter((t) => t.status === 'ACCEPTED').flatMap((t) => t.filesChanged),
                ...ingestion.requirements.flatMap((r) => [...r.targetFiles]),
                ...failed.flatMap((c) => referencedPaths(c.command).filter((p) => p !== 'package.json' && !p.startsWith('.ai-manager/'))),
              ]),
            ].slice(0, 50),
          });
          fix.parentTaskId = undefined;
          await saveTaskDefs();
          specCollector.enforceAllFor.add(fix.taskId);
          await runTask(fix);
          if (fix.status !== 'ACCEPTED') break;
        }
        if (report.finalGate.status === 'FAIL' && !stop) {
          stop = {
            status: 'PARTIAL',
            reason: `Final acceptance gate failed: ${report.finalGate.checks.filter((c) => c.exitCode !== 0).map((c) => c.command).join(', ')}`,
          };
        }
      }
      if (pollTimer) clearInterval(pollTimer);
      await Promise.allSettled([...pendingAnswers]);
      // Visual check: Director reviews the gate's screenshots against the design rules (budgeted, advisory).
      if (!visualPromise && report.finalGate && report.finalGate.status !== 'NOT_RUN') visualPromise = startVisualReview();
      if (visualPromise) {
        const vr = await (visualPromise as Promise<VisualReview | null>).catch(() => null);
        if (vr) {
          report.visualReview = vr;
          this.emit('VISUAL_REVIEW', `Görsel inceleme: ${vr.status}${vr.notes.length ? ` — ${vr.notes.slice(0, 2).join(' | ')}` : ''}`, undefined, vr.status === 'SORUNLU' ? 'warn' : 'info');
        }
      }

      const allAccepted =
        !stop &&
        !(report.skippedByPo?.length) &&
        report.finalGate?.status !== 'FAIL' &&
        report.tasks.filter((t) => t.kind !== 'ANALYSIS').every((t) => t.status === 'ACCEPTED' || t.status === 'SKIPPED');
      await historyManager.appendEvent({
        eventType: allAccepted ? 'AUTONOMOUS_RUN_COMPLETED' : 'AUTONOMOUS_RUN_STOPPED',
        actor: Actor.ORCHESTRATOR,
        taskId: null,
        payload: { runId, stopReason: stop?.reason ?? null, commits: report.commits },
      });
      return this.finish(report, allAccepted ? 'COMPLETED' : stop?.status ?? 'PARTIAL', stop?.reason, true, budgetManager);
    } catch (err) {
      return this.finish(report, 'FAILED', err instanceof Error ? err.message : String(err), true, budgetManager);
    } finally {
      clearInterval(heartbeat);
      const cur = readRunLock(projectRoot);
      if (!cur || cur.runId === runId) await fs.promises.rm(lockPath, { force: true });
    }
  }

  private async markTaskAccepted(specStore: SpecStore, taskId: string): Promise<void> {
    try {
      const tasks = await specStore.loadTasks();
      const t = tasks.find((x) => x.task_id === taskId);
      if (t && t.status !== 'ACCEPTED') {
        await specStore.saveTasks(
          tasks.map((x) => (x.task_id === taskId ? { ...x, status: 'ACCEPTED', completed_at: new Date().toISOString() } : x)) as never
        );
      }
    } catch {
      // The closed loop may already have integrated the state; best effort.
    }
  }

  private async finish(
    report: AutonomousRunReport,
    status: AutonomousRunStatus,
    reason?: string,
    persist = true,
    budgetManager?: BudgetManager
  ): Promise<AutonomousRunReport> {
    report.status = status;
    // Every user-facing stop reason is plain Turkish; technical detail only in parentheses.
    if (reason) reason = turkishStopReason(status, reason);
    if (reason) report.stopReason = reason;
    if (status !== 'COMPLETED' && status !== 'DRY_RUN_OK') this.decide('STOP', STATUS_TR[status] ?? `Çalışma durdu (${status})`, reason ?? '', this.currentTaskId ?? null);
    else this.decide('STOP', 'Çalışma tamamlandı', 'Tüm görevler kabul edildi ve son kontroller geçti.', null);
    report.finishedAt = new Date().toISOString();
    if (this.checkpoint) {
      this.checkpoint.state = 'FINISHED';
      this.checkpoint.status = status;
      this.checkpoint.stopReason = reason;
      this.checkpoint.inCycle = false;
    }
    if (budgetManager) {
      const acc = budgetManager.getGlobalAccount();
      if (acc) {
        report.budget = {
          limitUsd: nanoUsdToUsd(acc.limitSpendNanoUsd),
          committedUsd: nanoUsdToUsd(acc.committedSpendNanoUsd),
          reservedUsd: nanoUsdToUsd(acc.reservedSpendNanoUsd),
          availableUsd: nanoUsdToUsd(acc.availableSpendNanoUsd),
        };
      }
      try {
        await budgetManager.flushHistory();
      } catch {
        // ignore
      }
      try {
        budgetManager.close();
      } catch {
        // ignore
      }
    }
    if (persist && !report.dryRun) {
      const dir = path.join(report.projectRoot, '.ai-manager', 'reports');
      await fs.promises.mkdir(dir, { recursive: true });
      const jsonPath = path.join(dir, `autonomous-${report.runId}.json`);
      report.reportPath = jsonPath;
      await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
      // UTF-8 with BOM so Windows tools (PowerShell 5 Get-Content, Notepad) detect UTF-8 reliably.
      await fs.promises.writeFile(jsonPath.replace(/\.json$/, '.md'), `\uFEFF${renderAutonomousReportMarkdown(report)}`, 'utf8');
      try {
        const shots = collectScreenshots(report.projectRoot);
        const md = renderCompletionReportTr(report, shots.map((x) => ({ caption: x.caption, file: path.relative(report.projectRoot, x.file).split(path.sep).join('/') })));
        const cp = path.join(dir, `tamamlama-${report.runId}.md`);
        await fs.promises.writeFile(cp, `\uFEFF${md}`, 'utf8');
        report.completionReportPath = cp;
        await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
        if (this.monitor) {
          const up = await this.monitor.uploadCompletion(md, shots);
          if (!up.report) this.emit('REPORT', 'Tamamlama raporu izleme paneline gönderilemedi (yerel dosyada duruyor).', undefined, 'warn');
        }
      } catch {
        // The completion report is best effort; the main report is already written.
      }
    }
    if (this.checkpoint) {
      if (report.reportPath) this.checkpoint.reportPath = report.reportPath;
      this.writeCheckpoint();
    }
    this.emit('RUN_FINISHED', `${status}${reason ? `: ${reason}` : ''}`, undefined, status === 'COMPLETED' || status === 'DRY_RUN_OK' ? 'info' : 'warn');
    if (this.stopInstruction && this.instructionChannel) {
      await this.instructionChannel.ack(this.stopInstruction.instructionId, 'APPLIED', 'Çalışma durduruldu, rapor yazıldı.').catch(() => false);
    }
    if (this.instructionChannel) await this.instructionChannel.close().catch(() => undefined);
    if (this.monitor) {
      this.monitorStatus = toMonitorStatus(status);
      const snap = this.snapshotInput();
      await this.monitor.close(snap ?? undefined);
    }
    return report;
  }
}

export class AutonomousRunError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AutonomousRunError';
    this.code = code;
  }
}

// ============================================================================
// 3. HELPERS
// ============================================================================

/**
 * SystemEvidenceCollector that additionally runs the verification commands declared by the
 * human in the spec (## Komutlar / ## Test). Results are collected by AIDM itself — AGY test
 * claims are never used.
 */
export class SpecVerificationEvidenceCollector extends SystemEvidenceCollector {
  private readonly specCommands: readonly VerificationCommandSpec[];
  private readonly projectRoot?: string;
  /** Tasks that must run ALL spec commands (final-gate repair tasks). */
  readonly enforceAllFor = new Set<string>();
  private readonly deferred = new Map<string, Set<string>>();
  constructor(
    options: ConstructorParameters<typeof SystemEvidenceCollector>[0],
    specCommands: readonly VerificationCommandSpec[],
    projectRoot?: string
  ) {
    super(options);
    this.specCommands = specCommands;
    this.projectRoot = projectRoot;
  }
  /**
   * A global spec command applies to a task once every file/dir it references exists (after the
   * executor step). Before that it is deferred to the final run-level gate, where it is mandatory.
   * Without a project root (legacy construction) every command applies, as before.
   */
  applies(taskId: string, c: VerificationCommandSpec, workingDir?: string): boolean {
    const root = workingDir ?? this.projectRoot;
    if (!root || this.enforceAllFor.has(taskId)) return true;
    return referencedPaths(c.command).every((p) => fs.existsSync(path.resolve(root, p)));
  }
  takeDeferred(taskId: string): string[] {
    const d = this.deferred.get(taskId);
    this.deferred.delete(taskId);
    return d ? [...d] : [];
  }
  override collectAndVerify(
    request: ExecutionRequest,
    rawOutcome: RawExecutorOutcome,
    options: SystemEvidenceCollectorOptions = {}
  ) {
    const merged = [...(options.verificationCommands ?? [])];
    const wd = (request.metadata?.workingDirectory as string | undefined) ?? this.projectRoot;
    for (const c of this.specCommands) {
      if (merged.some((m) => m.command === c.command)) continue;
      if (this.applies(request.taskId, c, wd)) merged.push(c);
      else {
        const set = this.deferred.get(request.taskId) ?? new Set<string>();
        set.add(c.command);
        this.deferred.set(request.taskId, set);
      }
    }
    return super.collectAndVerify(request, rawOutcome, { ...options, verificationCommands: merged });
  }
}

function toMonitorStatus(s: AutonomousRunStatus): RunMonitorStatus {
  switch (s) {
    case 'COMPLETED':
    case 'DRY_RUN_OK':
      return 'COMPLETED';
    case 'BLOCKED_ON_HUMAN':
    case 'BLOCKED_ON_AUTH_CONTEXT':
    case 'BUDGET_EXHAUSTED':
      return 'BLOCKED_ON_HUMAN';
    case 'CONFIGURATION_ERROR':
      return 'CONFIGURATION_ERROR';
    case 'STOPPED':
      return 'STOPPED';
    default:
      return 'FAILED';
  }
}

/** Short, secret-masked tails of failing verification checks for the Director (bounded). */
export function formatFailingChecks(checks: ReadonlyArray<{ command?: string; type: string; status: unknown; evidence?: string; details?: unknown }>): string {
  const per = Math.max(200, Math.floor(1100 / Math.max(1, checks.length)));
  return checks
    .slice(0, 4)
    .map((c) => {
      const d = (c.details ?? {}) as { exitCode?: unknown; stdoutTail?: unknown; stderrTail?: unknown };
      const tail = [typeof d.stderrTail === 'string' ? d.stderrTail : '', typeof d.stdoutTail === 'string' ? d.stdoutTail : '']
        .filter(Boolean)
        .join(' | ');
      const body = tail ? tail.slice(-per) : String(c.evidence ?? '').slice(0, per);
      return `- [${c.type}] ${c.command ?? ''} exit=${String(d.exitCode ?? '?')}: ${monitorText(body, per)}`;
    })
    .join('\n');
}

const GATE_COMMAND_RE = /^(node|npm|pnpm|yarn|npx|python3?|pytest|go|cargo|make|deno|bun)\b/;

/** Global `## Komutlar` + command-like backticked items of `## Kabul Kriterleri`. */
export function finalGateCommands(commands: readonly string[], criteria: readonly string[]): string[] {
  const out = [...commands];
  for (const c of criteria) {
    for (const m of c.matchAll(/`([^`]+)`/g)) {
      const cmd = m[1].trim();
      if (GATE_COMMAND_RE.test(cmd) && !out.includes(cmd)) out.push(cmd);
    }
  }
  return out;
}

function formatGateFailures(failed: ReadonlyArray<{ command: string; exitCode: number | null; tail?: string }>): string {
  return failed.map((f) => `- ${f.command} exit=${f.exitCode}: ${monitorText(f.tail ?? '', 400)}`).join('\n');
}

export async function runGateCommands(
  cwd: string,
  commands: readonly string[],
  opts: { parallel?: boolean; onDone?: (command: string, exitCode: number | null) => void } = {}
): Promise<Array<{ command: string; exitCode: number | null; tail?: string }>> {
  const runOne = async (command: string): Promise<{ command: string; exitCode: number | null; tail?: string }> => {
    const res = await new Promise<{ code: number | null; text: string }>((resolve) => {
      execCb(command, { cwd, timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, text: `${String(stderr ?? '')}\n${String(stdout ?? '')}` });
      });
    });
    try {
      opts.onDone?.(command, res.code);
    } catch {
      /* listener errors never affect the gate */
    }
    return { command, exitCode: res.code, ...(res.code !== 0 ? { tail: monitorText(res.text.slice(-1500), 1500) } : {}) };
  };
  // Independent checks (tests, site check, headless browser) run concurrently; results keep spec order.
  if (opts.parallel !== false) return Promise.all(commands.map(runOne));
  const out: Array<{ command: string; exitCode: number | null; tail?: string }> = [];
  for (const command of commands) out.push(await runOne(command));
  return out;
}

/** Path-like operands a command depends on (files/dirs); npm-style runners depend on package.json. */
export function referencedPaths(command: string): string[] {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  if (/^(npm|pnpm|yarn|bun)$/.test(tokens[0])) return ['package.json'];
  const refs: string[] = [];
  for (const t0 of tokens.slice(1)) {
    const t = t0.replace(/^['"]|['"]$/g, '');
    if (!t || t.startsWith('-') || /[*?$|&;<>]/.test(t) || /^[a-z]+:\/\//i.test(t)) continue;
    if (t.includes('/') || t.includes('\\') || /\.[A-Za-z0-9]{1,6}$/.test(t)) refs.push(t.replace(/\\/g, '/'));
  }
  return refs;
}

export function toVerificationCommands(commands: readonly string[]): VerificationCommandSpec[] {
  return commands.map((command, i) => {
    const lower = command.toLowerCase();
    const type: VerificationCommandSpec['type'] = /\btest\b|vitest|jest|mocha|pytest/.test(lower)
      ? 'TEST'
      : /typecheck|tsc\b/.test(lower)
      ? 'TYPECHECK'
      : /\blint\b|eslint/.test(lower)
      ? 'LINT'
      : /\bbuild\b/.test(lower)
      ? 'BUILD'
      : 'COMMAND';
    return { id: `SPEC_CMD_${i + 1}`, type, command, mandatory: true };
  });
}

function summarizeMandate(m: ProjectMandate): NonNullable<AutonomousRunReport['mandate']> {
  return {
    mandateRevision: m.mandateRevision,
    policyVersion: m.policyVersion,
    allowedOperationTypes: m.allowedOperationTypes,
    autoExecutableTaskClasses: m.autoExecutableTaskClasses,
    forbiddenOperations: m.forbiddenOperations,
    humanApprovalRequiredOperations: m.humanApprovalRequiredOperations,
    allowedDirectories: m.allowedDirectories,
    authorizationEndTime: m.authorizationEndTime,
  };
}

function parseBudget(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function isBudgetExhausted(bm: BudgetManager): boolean {
  const acc = bm.getGlobalAccount();
  return !acc || acc.availableSpendNanoUsd <= 0n || acc.accountState !== 'ACTIVE';
}

function extractQuestion(result: ClosedLoopCycleResult): string | undefined {
  const a = result.directorAction as unknown as Record<string, unknown> | undefined;
  const q = a?.question ?? a?.questions ?? (result.humanDecisionPoint as Record<string, unknown> | undefined)?.question;
  if (Array.isArray(q)) return q.map(String).join('; ').slice(0, 300);
  return typeof q === 'string' ? q.slice(0, 300) : undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

async function ensureGitRepository(projectRoot: string): Promise<void> {
  let isRepo = false;
  try {
    isRepo = (await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    isRepo = false;
  }
  if (!isRepo) await git(projectRoot, ['init']);
  const gi = path.join(projectRoot, '.gitignore');
  const current = fs.existsSync(gi) ? await fs.promises.readFile(gi, 'utf8') : '';
  if (!/^\.ai-manager\/?\s*$/m.test(current)) {
    await fs.promises.writeFile(gi, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.ai-manager/\n`, 'utf8');
  }
}

/**
 * Independent evidence compares against a clean baseline commit. Only AIDM-owned bootstrap
 * files (.gitignore entry, the spec itself) are committed automatically; any other
 * uncommitted user change fails closed instead of being swept into an autonomous commit.
 */
/**
 * Uncommitted changes that are NOT AIDM bootstrap files (.gitignore entry, the spec itself, .ai-manager/).
 * Side-effect free; used by the git baseline AND by the pre-approval preflight. Not a git repo => none.
 */
export async function foreignUncommittedChanges(
  projectRoot: string,
  specPath: string
): Promise<{ dirty: string[]; foreign: string[] }> {
  let status: string;
  try {
    // NUL-separated porcelain output: never trimmed (a leading ' M' status column must survive,
    // otherwise ' M .gitignore' was parsed as 'gitignore') and never C-quoted (non-ASCII paths).
    ({ stdout: status } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    ));
  } catch {
    return { dirty: [], foreign: [] };
  }
  const dirty = parsePorcelainZ(status).filter((p) => !p.startsWith('.ai-manager/'));
  const relSpec = path.relative(projectRoot, specPath).replace(/\\/g, '/');
  const bootstrap = new Set(['.gitignore', relSpec]);
  // Multi-document specs: every included / folder document is a spec file too.
  try {
    for (const f of loadSpecBundleSync(specPath).files) bootstrap.add(path.relative(projectRoot, f.absPath).replace(/\\/g, '/'));
  } catch {
    /* unreadable spec: the run itself fails closed on it */
  }
  return { dirty, foreign: dirty.filter((p) => !bootstrap.has(p)) };
}

/**
 * True for project identity / binding rejections (canonical projectId mismatch, cross-project
 * session reuse). These are deterministic: no retry or next task can pass while the cause persists.
 */
export function isProjectIdentityFailure(summary: string | undefined | null): boolean {
  if (!summary) return false;
  return /Canonical project identity mismatch|Accidental cross-project|Cross-project session reuse is strictly prohibited/i.test(summary);
}

export function uncommittedChangesMessage(foreign: readonly string[]): string {
  return `Working tree has uncommitted changes (${foreign.slice(0, 10).join(', ')}${foreign.length > 10 ? `, … +${foreign.length - 10}` : ''}). Commit or stash them before an autonomous run.`;
}

async function createGitBaseline(
  projectRoot: string,
  specPath: string
): Promise<{ ok: true; commit?: string } | { ok: false; reason: string }> {
  const { dirty, foreign } = await foreignUncommittedChanges(projectRoot, specPath);
  if (foreign.length > 0) {
    return { ok: false, reason: uncommittedChangesMessage(foreign) };
  }
  let hasHead = true;
  try {
    await git(projectRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }
  if (dirty.length === 0 && hasHead) return { ok: true };
  if (dirty.length > 0) await git(projectRoot, ['add', '--', ...dirty]);
  await git(projectRoot, ['commit', '--allow-empty', '-m', 'chore(aidm): baseline for autonomous spec run']);
  return { ok: true, commit: await git(projectRoot, ['rev-parse', 'HEAD']) };
}

/** Paths from `git status --porcelain=v1 -z` (rename/copy sources are skipped). */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) i++; // next field is the original path
  }
  return paths;
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

async function commitRange(cwd: string, from: string | null, to: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['rev-list', '--reverse', from ? `${from}..${to}` : to]);
    return out.split('\n').filter(Boolean);
  } catch {
    return [to];
  }
}

async function commitFiles(cwd: string, from: string | null, to: string): Promise<string[]> {
  try {
    const out = from
      ? await git(cwd, ['diff', '--name-only', from, to])
      : await git(cwd, ['show', '--name-only', '--format=', to]);
    return out.split('\n').filter((f) => f && !f.startsWith('.ai-manager/'));
  } catch {
    return [];
  }
}

/** Commits the working tree after an independently ACCEPTED task. Never pushes. */
async function commitTask(
  projectRoot: string,
  taskId: string,
  title: string,
  evidenceId?: string
): Promise<{ sha: string; files: string[] } | null> {
  try {
    await git(projectRoot, ['add', '-A', '--', '.', ':(exclude).ai-manager']);
    const staged = await git(projectRoot, ['diff', '--cached', '--name-only']);
    if (!staged) return null;
    const subject = `feat(aidm): ${taskId} ${title}`.slice(0, 100);
    const body = `Autonomous spec run (aidm run --spec).\nEvidence: ${evidenceId ?? 'n/a'}`;
    await git(projectRoot, ['commit', '-m', subject, '-m', body]);
    const sha = await git(projectRoot, ['rev-parse', 'HEAD']);
    return { sha, files: staged.split('\n').filter(Boolean) };
  } catch {
    return null;
  }
}

export function renderAutonomousReportMarkdown(r: AutonomousRunReport): string {
  const lines: string[] = [];
  lines.push(`# AIDM Otonom Çalışma Raporu — ${r.projectName}`, '');
  lines.push(`- Run: \`${r.runId}\``);
  lines.push(`- Durum: **${r.status}**${r.stopReason ? ` — ${r.stopReason}` : ''}`);
  lines.push(`- Spec: \`${r.specPath}\` (sha256 \`${r.specFingerprint}\`)`);
  lines.push(`- Giriş noktası: \`${r.entryPoint}\``);
  if (r.authorization) {
    lines.push(
      `- Yetki kaynağı: ${r.authorization.authSource} (actor ${r.authorization.actorType}, mandate rev ${r.authorization.mandateRevision})`
    );
  }
  if (r.budget) {
    lines.push(
      `- Bütçe: limit $${r.budget.limitUsd.toFixed(4)}, harcanan $${r.budget.committedUsd.toFixed(4)}, rezerve $${r.budget.reservedUsd.toFixed(4)}`
    );
  }
  if (r.finalGate) {
    const g = r.finalGate;
    lines.push(
      `- Son kabul kapısı: **${g.status}**${
        g.status === 'NO_CHECKS' ? ' — çalıştırılacak kontrol yok, bütün proje otomatik doğrulanmadı' : g.checks.length ? ` (${g.checks.filter((c) => c.exitCode === 0).length}/${g.checks.length})` : ''
      }`
    );
  }
  if (r.clarification) {
    const c = r.clarification;
    lines.push('', '## Spec netleştirme', '', `- Durum: **${c.status}**${c.decisionId ? ` (karar \`${c.decisionId}\`)` : ''}`);
    if (c.summary) lines.push(`- Director'un özeti: ${c.summary}`);
    lines.push(...c.lines.map((l) => `- ${l}`));
    if (c.criteriaAdded) lines.push(`- Görevlere eklenen kabul kriteri: ${c.criteriaAdded}`);
    if (c.checksScript) lines.push(`- Son kabul kapısına eklenen kontrol: \`node ${c.checksScript}\``);
    if (c.newTasks.length) lines.push(`- Eklenen görevler: ${c.newTasks.join(', ')}`);
    if (c.note) lines.push(`- Not: ${c.note}`);
  }
  lines.push('', '## Görevler', '', '| Görev | Durum | Döngü | Commit | Dosyalar | Kanıt |', '|---|---|---|---|---|---|');
  for (const t of r.tasks) {
    lines.push(
      `| ${t.taskId} ${t.title} | ${t.status} | ${t.cycles} | ${t.commit ? t.commit.slice(0, 10) : '-'} | ${t.filesChanged.join(', ') || '-'} | ${t.evidenceIds.join(', ') || '-'} |`
    );
  }
  const checks = r.tasks.flatMap((t) => t.verificationChecks.map((c) => `${t.taskId}: ${c.type} ${c.status}${c.command ? ` (\`${c.command}\`)` : ''}`));
  lines.push('', '## Doğrulama / Testler', '', ...(checks.length ? checks.map((c) => `- ${c}`) : ['- (yok)']));
  lines.push('', '## Varsayımlar', '', ...(r.assumptions.length ? r.assumptions.map((a) => `- ${a}`) : ['- (yok)']));
  if (r.warnings.length) lines.push('', '## Uyarılar', '', ...r.warnings.map((w) => `- ${w}`));
  lines.push('', '## Commitler', '', ...(r.commits.length ? r.commits.map((c) => `- ${c}`) : ['- (yok)']), '');
  return lines.join('\n');
}

/** Shared asset scope granted to page work (HTML pages always come with shared CSS/JS/images). */
export const SHARED_PAGE_ASSET_SCOPE: readonly string[] = Object.freeze(['assets/**', '*.css']);

/**
 * Extra implementationScope entries for a task: shared asset paths when the task builds pages, plus
 * every concrete path the PO's clarification checks require (e.g. `assets/site.js`).
 */
export function scopeExtrasForTask(targetFiles: readonly string[], checks: readonly ClarificationCheck[]): string[] {
  const out = new Set<string>();
  if (targetFiles.some((f) => /\.html?$/i.test(f))) for (const s of SHARED_PAGE_ASSET_SCOPE) out.add(s);
  for (const c of checks) {
    const p = (c as { path?: unknown }).path;
    if ((c.type === 'file_exists' || c.type === 'file_contains') && typeof p === 'string' && p.trim()) out.add(p.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return [...out];
}

/**
 * Returns the out-of-scope files when the ONLY failing independent check is the implementation-scope
 * check (no workspace escape, binding, baseline/git, security or unsafe-path failure); else null.
 */
export function scopeOnlyViolation(result: ClosedLoopCycleResult): string[] | null {
  const ev = result.systemEvidence as
    | { verificationChecks?: ReadonlyArray<{ checkId?: string; type: string; status: unknown; evidence?: string }>; failureCategory?: string }
    | undefined;
  if (!ev || !Array.isArray(ev.verificationChecks)) return null;
  if (ev.failureCategory && ev.failureCategory !== 'SECURITY_FAILURE') return null;
  const failing = ev.verificationChecks.filter((c) => c.status === 'FAIL' || c.status === 'BLOCK');
  if (!failing.length || !failing.every((c) => c.type === 'FILE_SCOPE' && c.status === 'FAIL')) return null;
  const files = new Set<string>();
  for (const c of failing) {
    const m = /\[([^\]]*)\]\s*$/.exec(c.evidence ?? '');
    if (!m) return null;
    for (const f of m[1]!.split(',').map((x) => x.trim()).filter(Boolean)) files.add(f.replace(/\\/g, '/'));
  }
  if (!files.size) return null;
  // A path that tries to leave the project is a real security issue, never "just scope".
  for (const f of files) if (f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.split('/').includes('..')) return null;
  return [...files];
}

function currentScopeOf(def: TaskDefinition): string[] {
  const meta = (def.metadata ?? {}) as Record<string, unknown>;
  const tf = Array.isArray(meta.targetFiles) ? (meta.targetFiles as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const extra = Array.isArray(meta.implementationScopeExtra) ? (meta.implementationScopeExtra as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return [...new Set([...tf, ...extra])];
}

/**
 * Sets out-of-scope files aside under .ai-manager/scope-quarantine/<run>/<task>-attempt-<n>/ (copies
 * kept, recoverable): new files are moved there, tracked files are copied there and restored from
 * HEAD. Only project-relative paths outside .ai-manager are touched. Returns the quarantine dir.
 */
export async function quarantineFiles(projectRoot: string, runId: string, taskId: string, attempt: number, files: readonly string[]): Promise<string> {
  const rel = path.posix.join('.ai-manager', 'scope-quarantine', runId.replace(/[^A-Za-z0-9._-]/g, '_'), `${taskId.replace(/[^A-Za-z0-9._-]/g, '_')}-attempt-${attempt}`);
  const dir = path.join(projectRoot, rel);
  const root = path.resolve(projectRoot);
  for (const f of files) {
    const n = f.replace(/\\/g, '/');
    if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..') || n === '.ai-manager' || n.startsWith('.ai-manager/') || n.startsWith('.git/')) continue;
    const abs = path.resolve(root, n);
    if (!abs.startsWith(root + path.sep)) continue;
    let tracked = false;
    try {
      await git(projectRoot, ['cat-file', '-e', `HEAD:${n}`]);
      tracked = true;
    } catch {
      tracked = false;
    }
    const dest = path.join(dir, n);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      if (!tracked) fs.rmSync(abs, { force: true });
    }
    if (tracked) await git(projectRoot, ['checkout', 'HEAD', '--', n]).catch(() => undefined);
  }
  return rel;
}

/** Extracts the denied path from a P21 directory-access rejection; null for other policy rejections. */
export function policyDeniedPath(summary: string | undefined): string | null {
  const m = /Target file '([^']*)' is outside allowed directories/.exec(summary ?? '');
  return m ? m[1]! : null;
}

const MANDATE_EXT_FILE = path.join('.ai-manager', 'state', 'mandate-extensions.json');

/** Paths the PO approved by passkey decision for this spec fingerprint (sealed on the next segment). */
export function loadMandateExtensions(projectRoot: string, specFingerprint: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectRoot, MANDATE_EXT_FILE), 'utf8')) as Array<{ specFingerprint: string; path: string }>;
    return j.filter((e) => e.specFingerprint === specFingerprint && isSafeProjectRelativePath(e.path) && !/[*?[{]/.test(e.path)).map((e) => e.path);
  } catch {
    return [];
  }
}

async function saveMandateExtension(projectRoot: string, specFingerprint: string, p: string, decisionId: string): Promise<void> {
  const f = path.join(projectRoot, MANDATE_EXT_FILE);
  let j: unknown[] = [];
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown[];
  } catch {
    j = [];
  }
  j.push({ specFingerprint, path: p, decisionId, approvedAt: new Date().toISOString() });
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  await fs.promises.writeFile(f, JSON.stringify(j, null, 2), 'utf8');
}

export const PO_QUESTION_TASK_ID = 'PO-QUESTION';
export const PO_QUESTION_SYSTEM_PROMPT = [
  'Sen bu otonom çalıştırmanın Director\'ısın. Ürün sahibi çalışma sürerken sana bir soru soruyor.',
  'Kısa, sade ve doğru TÜRKÇE ile yanıt ver (en fazla 8 cümle). Yalnızca verilen bağlamı kullan; bilmediğini uydurma, "bilmiyorum" de.',
  'Bu bir sohbet yanıtıdır: plan değiştirme, eylem önerme formatı, JSON veya kod bloğu kullanma. Çalışma bu sırada durmadan devam ediyor.',
].join('\n');

/** Run context for a PO question: spec, task states, recent decisions, clarification answers, PO notes, budget. */
export function buildPoQuestionPrompt(o: {
  question: string;
  taskId: string | null;
  markdown: string;
  report: AutonomousRunReport;
  currentTaskId: string | null;
  poNotes: ReadonlyArray<{ text: string; taskId: string | null }>;
  budget?: { limitUsd: number; committedUsd: number };
}): string {
  const r = o.report;
  const tasks = r.tasks.map((t) => `- ${t.taskId} ${t.title ?? ''}: ${t.status} (döngü ${t.cycles ?? 0})${t.lastSummary ? ` — ${String(t.lastSummary).slice(0, 160)}` : ''}`).join('\n');
  const decisions = r.decisions.slice(-6).map((d) => `- ${d.taskId}: ${String(d.question).slice(0, 200)} → ${d.state}${(d as { answer?: string }).answer ? ` (${String((d as { answer?: string }).answer).slice(0, 120)})` : ''}`).join('\n');
  const clar = (r.clarification?.lines ?? []).slice(0, 20).map((l) => `- ${l}`).join('\n');
  const notes = o.poNotes.slice(-5).map((n) => `- ${n.taskId ? `[${n.taskId}] ` : ''}${n.text.slice(0, 200)}`).join('\n');
  const b = o.budget ?? r.budget;
  return [
    `SORU${o.taskId ? ` (görev ${o.taskId} hakkında)` : ''}: ${o.question}`,
    '',
    `Şu anki görev: ${o.currentTaskId ?? '(yok)'}`,
    b ? `Bütçe: limit $${b.limitUsd.toFixed(4)}, harcanan $${b.committedUsd.toFixed(4)}` : '',
    '',
    'GÖREVLER:',
    tasks || '(yok)',
    '',
    'SON KARARLAR:',
    decisions || '(yok)',
    '',
    'NETLEŞTİRME CEVAPLARI:',
    clar || '(yok)',
    '',
    'ÜRÜN SAHİBİ NOTLARI:',
    notes || '(yok)',
    '',
    'SPEC (kısaltılmış):',
    o.markdown.slice(0, 32_000),
  ]
    .filter((x) => x !== undefined)
    .join('\n');
}

/** AGY step timeouts: default 20 min, extended on progress up to 60 min. Env: AIDM_AGY_TIMEOUT_MS / AIDM_AGY_MAX_TIMEOUT_MS. */
export function agyTimeouts(env: Readonly<Record<string, string | undefined>>): { minTimeoutMs: number; maxTimeoutMs: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 60_000 && n <= 3_600_000 ? n : d;
  };
  const minTimeoutMs = num(env.AIDM_AGY_TIMEOUT_MS, 20 * 60_000);
  return { minTimeoutMs, maxTimeoutMs: Math.max(minTimeoutMs, num(env.AIDM_AGY_MAX_TIMEOUT_MS, 60 * 60_000)) };
}

/** Plain-Turkish meaning of a task result status (technical code goes in parentheses by the caller). */
export function turkishStatus(status: string): string {
  switch (status) {
    case 'BLOCKED_ON_APPROVAL':
      return 'bu adım için ayrıca onay gerekiyor.';
    case 'REJECTED_BY_POLICY':
      return 'güvenlik kuralları bu adımı reddetti.';
    case 'EXECUTION_UNKNOWN':
      return 'AGY işi bitiremedi ya da sonucu belirsiz kaldı; aynı işi iki kez yaptırmamak için durdum.';
    case 'MAX_ATTEMPTS_EXCEEDED':
      return 'deneme hakkı bitti.';
    default:
      return 'beklenmeyen bir durum oluştu.';
  }
}

/** The allowed path a denied target was most likely meant to be (same folder; .htm/.html or <= 2 typos). */
export function nearMissPath(denied: string, candidates: readonly string[]): string | null {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const d = norm(denied);
  const dir = (x: string) => (x.includes('/') ? x.slice(0, x.lastIndexOf('/')) : '');
  const stem = (x: string) => x.replace(/\.html?$/, '.html');
  const lev = (a: string, b: string): number => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
    for (let j = 1; j <= b.length; j++) m[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) m[i]![j] = Math.min(m[i - 1]![j]! + 1, m[i]![j - 1]! + 1, m[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length]![b.length]!;
  };
  let best: { c: string; score: number } | null = null;
  for (const c of new Set(candidates)) {
    const n = norm(c);
    if (c === denied || dir(n) !== dir(d)) continue;
    const score = stem(n) === stem(d) ? 0 : d.length > 4 ? lev(n, d) : 99;
    if (score <= 2 && (!best || score < best.score)) best = { c, score };
  }
  return best ? best.c : null;
}

const TR_HINT = /[çğıöşüÇĞİÖŞÜ]|\b(durdu|görev|çalışma|karar|onay|bütçe|değil|için|yok|var)\b/i;
const STATUS_TR: Record<string, string> = {
  BLOCKED_ON_HUMAN: 'Çalışma senin kararını bekliyor',
  STOPPED: 'Çalışma durduruldu',
  PARTIAL: 'Çalışma kısmen tamamlandı',
  FAILED: 'Çalışma başarısız oldu',
  BUDGET_EXHAUSTED: 'Bütçe bitti',
  CONFIGURATION_ERROR: 'Ayar hatası',
  COMPLETED: 'Çalışma tamamlandı',
};

/** Plain-Turkish stop reason. Already-Turkish reasons are kept; known English ones are rewritten with the original in parentheses. */
export function turkishStopReason(status: string, reason: string): string {
  if (!reason) return reason;
  const lead = reason.slice(0, 120);
  if (TR_HINT.test(lead) && !/^Task |^Tasks /.test(reason)) return reason;
  const task = /^Tasks? ([A-Z0-9,\- ]+?)(?::| did| changed| depend)/.exec(reason)?.[1]?.trim();
  const t = task ? `${task} ` : '';
  const rules: Array<[RegExp, string]> = [
    [/timed out|EXECUTION_UNKNOWN/i, `${t}durdu: AGY işi zamanında bitiremedi ya da sonucu belirsiz kaldı; aynı işi iki kez yaptırmamak için durdum.`],
    [/outside its implementationScope/i, `${t}durdu: görev, izin verilen dosyaların dışında dosya değiştirdi ve kapsamı genişletecek bir karar kanalı yok.`],
    [/outside the allowed paths|outside allowed directories/i, `${t}durdu: onayladığın izinli yolların dışındaki bir dosyaya yazmak istedi.`],
    [/did not pass independent verification|did not reach independently verified success/i, `${t}deneme hakkı içinde bağımsız doğrulamayı geçemedi.`],
    [/depend on unfinished work/i, `${t}bitmemiş başka işlere bağlı; önce onların tamamlanması gerekiyor.`],
    [/selected no option/i, `${t}kararında bir seçenek seçilmedi; görev beklemede.`],
    [/requests a human decision/i, `${t}için Director senden bir karar istiyor.`],
    [/human decision .* (EXPIRED|FAILED)/i, `${t}için istenen kararın süresi doldu ya da alınamadı.`],
    [/Abandoned by a new run/i, 'Yeni bir çalışma başlatıldığı için bu çalışma bırakıldı.'],
    [/budget/i, 'Bütçe sınırına ulaşıldı; bütçeyi artırmak senin onayını gerektirir.'],
    [/Final acceptance gate failed/i, 'Son kabul kontrolleri başarısız oldu.'],
    [/uncommitted changes/i, 'Çalışma klasöründe kaydedilmemiş değişiklikler var; önce bunları kaydet veya kenara al.'],
    [/unavailable|AIDM_AGY_PATH/i, 'AGY (Antigravity) çalıştırılamadı; kurulumunu ve AIDM_AGY_PATH ayarını kontrol et.'],
  ];
  const hit = rules.find(([re]) => re.test(reason));
  const head = hit ? hit[1] : `${STATUS_TR[status] ?? 'Çalışma durdu'}.`;
  return `${head} (${status}: ${reason.slice(0, 600)})`;
}

/** IDE mode: how long to wait for the IDE agent to submit (AIDM_IDE_TIMEOUT_MS, default 45 min; cap 2 h). */
export function ideTimeouts(env: Readonly<Record<string, string | undefined>>): { minTimeoutMs: number; maxTimeoutMs: number } {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const min = n(env.AIDM_IDE_TIMEOUT_MS, 45 * 60_000);
  return { minTimeoutMs: min, maxTimeoutMs: Math.max(min, n(env.AIDM_IDE_MAX_TIMEOUT_MS, 120 * 60_000)) };
}

/** Audit / verification-only work, where "nothing had to change" is a legitimate result. */
export function isVerificationOnlyTask(t: { title?: string; description?: string; acceptance_criteria?: readonly unknown[] }): boolean {
  const text = [t.title, t.description, ...(t.acceptance_criteria ?? []).map(String)].join(' ');
  return /lighthouse|konsol(da)? hata|console error|doğrula|denetle|denetim|audit|verify|verification|kontrol et|test et|erişilebilirlik testi|performans (ölçümü|testi)|smoke/i.test(text);
}

/** Previous entries of a resumed run (JSON sidecar of the markdown log). */
function loadDecisionSeed(projectRoot: string, runId: string): DecisionEntry[] {
  try {
    const f = path.join(projectRoot, '.ai-manager', 'reports', `karar-gunlugu-${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    const v = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
    return Array.isArray(v) ? (v as DecisionEntry[]).filter((e) => e && typeof e.title === 'string').slice(0, 1000) : [];
  } catch {
    return [];
  }
}

