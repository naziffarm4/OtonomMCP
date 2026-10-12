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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SpecIngestor, type SpecIngestionResult } from './spec-ingestor.js';
import {
  buildAutonomousMandate,
  sealAutonomousMandate,
  signOperatorInvocation,
  AUTONOMOUS_RUN_LOCK_FILE,
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
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
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
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import { AntigravityAdapter } from '../executor-bridge/antigravity-adapter.js';
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
  refinements: string[];
  executorReports: string[];
  /** Spec commands deferred per task because the files they reference did not exist yet. */
  deferredCommands: Array<{ taskId: string; commands: string[] }>;
  /** Run-level acceptance gate (global `## Komutlar` + command-like `## Kabul Kriterleri`). */
  finalGate?: { status: 'PASS' | 'FAIL' | 'NOT_RUN'; repairs: number; checks: Array<{ command: string; exitCode: number | null; tail?: string }>; criteria: string[] };
  /** Verified live PO instructions (no tokens). */
  instructions: Array<{ instructionId: string; mode: string; taskId: string | null; state: string; note?: string }>;
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
  private currentTaskId: string | null = null;
  private lastDirectorAction: RunMonitorSnapshotInput['lastDirectorAction'] = null;
  private pendingDecisionIds = new Set<string>();
  private liveBudget?: () => { limitUsd: number; committedUsd: number; reservedUsd: number };
  private maxAttemptsOf: (taskId: string) => number | undefined = () => undefined;
  private instructionChannel: InstructionChannel | null = null;
  private stopInstruction: VerifiedInstruction | null = null;
  private checkpoint: RunCheckpoint | null = null;

  /** Persists the crash-safe checkpoint (never throws). */
  private writeCheckpoint(): void {
    const cp = this.checkpoint;
    const rep = this.currentReport;
    if (!cp || !rep) return;
    cp.currentTaskId = this.currentTaskId;
    cp.tasks = rep.tasks.map((t) => ({ taskId: t.taskId, status: t.status, cycles: t.cycles }));
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
  };

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
    try {
      markdown = await fs.promises.readFile(specPath, 'utf8');
    } catch (err) {
      throw new AutonomousRunError(
        `Cannot read spec file '${specPath}': ${err instanceof Error ? err.message : String(err)}`,
        'SPEC_UNREADABLE'
      );
    }

    const canonical = resolveCanonicalProjectIdentity(projectRoot);
    const projectId = canonical.projectId;
    const ingestion = new SpecIngestor().ingest(markdown, {
      projectId,
      specPath: path.relative(projectRoot, specPath).startsWith('..') ? specPath : path.relative(projectRoot, specPath),
      maxAttemptsPerTask: Math.max(1, Math.min(10, Math.floor(this.options.maxCyclesPerTask ?? 3))),
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
    const mandateDraft = buildAutonomousMandate({
      projectId,
      allowedPaths: ingestion.allowedPaths,
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
    // ------------------------------------------------------------------ resume pre-checks
    let resumeFrom: RunCheckpoint | null = null;
    if (resumeRunId && !dryRun) {
      resumeFrom = loadCheckpoint(projectRoot, resumeRunId);
      const refuse = (why: string) => this.finish(report, 'CONFIGURATION_ERROR', `Cannot resume ${resumeRunId}: ${why}`, false);
      if (!resumeFrom) return refuse('no checkpoint for this run in this project.');
      const live = runLiveness(projectRoot, resumeFrom);
      if (live === 'FINISHED') return refuse(`the run already finished (${resumeFrom.status ?? 'FINISHED'}); start a new run instead.`);
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
      await specStore.saveTasks(
        ingestion.tasks.map((t) => (accepted.has(t.task_id) ? { ...t, status: 'ACCEPTED' } : t)) as never
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
      const provider = budgetManager.wrapProvider(baseProvider);

      const executorPort =
        this.options.executorPort ??
        new AntigravityAdapter({
          workspaceRoot: projectRoot,
          binaryPath: this.env.AIDM_AGY_PATH ?? 'agy',
          processRunner: new NodeAntigravityProcessRunner(),
        });
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
      const guidance = new Map<string, string>();
      const decisionsAsked = new Map<string, number>();
      const refinementsDone = new Map<string, number>();
      const analysesDone = new Map<string, number>();
      const waiting = new Map<
        string,
        { record: DecisionRecord; kind: 'DIRECTOR' | 'ATTEMPTS_EXHAUSTED'; promise: Promise<{ taskId: string; outcome: DecisionOutcome }> }
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
        instructionInbox.push(...got);
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
      const specWritable =
        !relSpecPath.startsWith('..') &&
        (ingestion.allowedPaths.includes(relSpecPath) || ingestion.requirements.some((r) => r.targetFiles.includes(relSpecPath)));
      const runTask = async (taskReport: AutonomousTaskReport): Promise<'DONE' | 'DEFERRED'> => {
        const task = taskDefs.get(taskReport.taskId)!;
        let extraGuidance = guidance.get(task.task_id) ?? '';
        guidance.delete(task.task_id);
        taskReport.status = 'PENDING';

        const maxCycles = attemptsFor(task.task_id);
        await setSpecMaxAttempts(task.task_id, maxCycles);
        this.currentTaskId = task.task_id;
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
              : '',
            extraGuidance,
            carryNote,
            ...poNotes
              .filter((n) => !n.taskId || n.taskId === task.task_id)
              .slice(-5)
              .map((n) => `BINDING PRODUCT_OWNER INSTRUCTION (passkey-verified ${n.id}): ${n.text}`),
            `Project root is the only allowed workspace; allowed paths: ${(report.mandate?.allowedDirectories ?? []).join(', ')}.`,
            decisionMode === 'assume' ? NO_QUESTIONS_DIRECTOR_INSTRUCTION : policyText,
            DIRECTOR_CAPABILITIES_INSTRUCTION,
            report.assumptions.length ? `Logged assumptions: ${report.assumptions.join(' | ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');

          carryNote = '';
          const headBefore = await gitHead(projectRoot);
          let result: ClosedLoopCycleResult;
          try {
            result = await coordinator.coordinateCycle({
              projectId,
              directorSessionId: session.directorSessionId,
              contextSnapshot: snapshot,
              targetTaskId: task.task_id,
              instruction,
              maxRecoveryAttempts: maxCycles,
              // Each attempt is a distinct dispatch: a repair with an identical payload must not be
              // swallowed as an idempotent duplicate of the failed attempt.
              idempotencyKey: `${runId}:${task.task_id}:attempt-${++dispatchSeq}`,
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
            let now = '';
            try {
              now = await fs.promises.readFile(specPath, 'utf8');
            } catch {
              now = '';
            }
            if (crypto.createHash('sha256').update(now, 'utf8').digest('hex') !== ingestion.specFingerprint) {
              await fs.promises.writeFile(specPath, markdown, 'utf8').catch(() => undefined);
              taskReport.status = 'BLOCKED';
              stop = { status: 'BLOCKED_ON_HUMAN', reason: `Spec file '${path.basename(specPath)}' was modified during task ${task.task_id}; restored. The executor may not edit the spec.` };
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
          this.emit('CYCLE_RESULT', `${result.status}: ${result.summary}`, task.task_id);

          const action = (result.directorAction ?? {}) as unknown as Record<string, unknown>;
          const actionType = result.directorAction?.actionType as string | undefined;
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

          // ---- Read-only analysis dispatched to AGY through the governed pipeline
          if (
            !isAnalysis &&
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

          if (result.status === 'COMPLETED_SUCCESS') {
            if (execNote) carryNote = `(From the previous task ${task.task_id}) ${execNote}`;
            taskReport.status = 'ACCEPTED';
            accepted.add(task.task_id);
            this.emit('TASK_ACCEPTED', `${task.task_id} kabul edildi (bağımsız kanıt)`, task.task_id);
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

          if (
            result.status === 'BLOCKED_ON_APPROVAL' ||
            result.status === 'REJECTED_BY_POLICY' ||
            result.status === 'EXECUTION_UNKNOWN' ||
            (result.humanDecisionRequired && result.status !== 'MAX_ATTEMPTS_EXCEEDED')
          ) {
            taskReport.status = 'BLOCKED';
            stop = {
              status: 'BLOCKED_ON_HUMAN',
              reason: `Task ${task.task_id}: ${result.status} — ${result.summary}. Human approval required (fail-closed).`,
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
        return deps.some((d) => waiting.has(d) || report.tasks.some((t) => t.taskId === d && (t.status === 'WAITING_DECISION' || t.status === 'SPLIT')));
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

      while (!stop) {
        let next: AutonomousTaskReport | undefined;
        const idx = queue.findIndex((t) => !dependsOnUnfinished(t));
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
      const gateCommands = finalGateCommands(ingestion.verificationCommands, ingestion.globalAcceptanceCriteria);
      const everyTaskAccepted = (): boolean =>
        report.tasks.filter((t) => t.kind !== 'ANALYSIS').every((t) => t.status === 'ACCEPTED' || t.status === 'SKIPPED');
      report.finalGate = { status: 'NOT_RUN', repairs: 0, checks: [], criteria: [...ingestion.globalAcceptanceCriteria] };
      if (!stop && everyTaskAccepted() && !(report.skippedByPo?.length) && gateCommands.length) {
        const lastTop = [...report.tasks].reverse().find((t) => t.kind === 'TASK' && t.status === 'ACCEPTED');
        for (;;) {
          const checks = await runGateCommands(projectRoot, gateCommands);
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
                ...failed.flatMap((c) => referencedPaths(c.command).filter((p) => p !== 'package.json')),
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
    if (reason) report.stopReason = reason;
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

async function runGateCommands(cwd: string, commands: readonly string[]): Promise<Array<{ command: string; exitCode: number | null; tail?: string }>> {
  const out: Array<{ command: string; exitCode: number | null; tail?: string }> = [];
  for (const command of commands) {
    const res = await new Promise<{ code: number | null; text: string }>((resolve) => {
      execCb(command, { cwd, timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, text: `${String(stderr ?? '')}\n${String(stdout ?? '')}` });
      });
    });
    out.push({ command, exitCode: res.code, ...(res.code !== 0 ? { tail: monitorText(res.text.slice(-1500), 1500) } : {}) });
  }
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
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
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
async function createGitBaseline(
  projectRoot: string,
  specPath: string
): Promise<{ ok: true; commit?: string } | { ok: false; reason: string }> {
  // NUL-separated porcelain output: never trimmed (a leading ' M' status column must survive,
  // otherwise ' M .gitignore' was parsed as 'gitignore') and never C-quoted (non-ASCII paths).
  const { stdout: status } = await execFileAsync(
    'git',
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 }
  );
  const dirty = parsePorcelainZ(status).filter((p) => !p.startsWith('.ai-manager/'));
  const relSpec = path.relative(projectRoot, specPath).replace(/\\/g, '/');
  const bootstrap = new Set(['.gitignore', relSpec]);
  const foreign = dirty.filter((p) => !bootstrap.has(p));
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `Working tree has uncommitted changes (${foreign.slice(0, 10).join(', ')}). Commit or stash them before an autonomous run.`,
    };
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
