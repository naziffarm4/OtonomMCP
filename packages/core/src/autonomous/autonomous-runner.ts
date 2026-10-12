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
import { nanoUsdToUsd } from '../budget/budget-types.js';
import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import { AntigravityAdapter } from '../executor-bridge/antigravity-adapter.js';
import { NodeAntigravityProcessRunner } from '../executor-bridge/antigravity-process-runner.js';
import { LifecycleState } from '../lifecycle.js';
import { Actor } from '../actors.js';

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
  status: 'ACCEPTED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'PENDING';
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
  stopReason?: string;
  reportPath?: string;
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

  private emit(type: string, message: string, taskId?: string): void {
    this.options.onEvent?.({ type, message, taskId, at: new Date().toISOString() });
  }

  async run(): Promise<AutonomousRunReport> {
    const projectRoot = path.resolve(this.options.projectRoot);
    const specPath = path.resolve(this.options.specPath);
    const entryPoint = this.options.entryPoint ?? 'aidm run --spec';
    const dryRun = Boolean(this.options.dryRun);
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

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
    });

    const mandateStore = new ProjectMandateStore({
      baseDir: projectRoot,
      identityManager: this.options.identityManager,
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
    };
    for (const a of ingestion.assumptions) this.emit('ASSUMPTION', a);

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
    const budgetUsd = this.options.budgetUsd ?? parseBudget(this.env.AIDM_BUDGET_USD);
    if (budgetUsd === undefined || !(budgetUsd > 0)) {
      return this.finish(
        report,
        'CONFIGURATION_ERROR',
        'A positive budget is required for live runs (--budget-usd N or AIDM_BUDGET_USD). Budget control cannot be bypassed.'
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

    let sealed: { mandate: ProjectMandate; provenance: AutonomousAuthorizationProvenance };
    try {
      sealed = await sealAutonomousMandate(mandateStore, mandateDraft, authContext, {
        specFingerprint: ingestion.specFingerprint,
        entryPoint,
      });
    } catch (err) {
      return this.finish(report, 'BLOCKED_ON_AUTH_CONTEXT', err instanceof Error ? err.message : String(err));
    }
    report.authorization = sealed.provenance;
    report.mandate = summarizeMandate(sealed.mandate);
    this.emit('MANDATE_SEALED', `Mandate revision ${sealed.mandate.mandateRevision} sealed by ${sealed.provenance.authSource}.`);

    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.promises.writeFile(lockPath, JSON.stringify({ runId, pid: process.pid, startedAt: report.startedAt }), 'utf8');

    let budgetManager: BudgetManager | undefined;
    try {
      // ------------------------------------------------------------ git baseline
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
        packageId: `pkg-autonomous-${ingestion.specFingerprint.slice(0, 12)}-${Date.now()}`,
      });
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
      budgetManager.createGlobalAccount(budgetUsd);

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
        evidenceCollector: new SpecVerificationEvidenceCollector(
          { evidenceStore },
          toVerificationCommands(ingestion.verificationCommands)
        ),
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
      const maxCycles = Math.max(1, this.options.maxCyclesPerTask ?? 3);
      let clarificationBudget = Math.max(0, this.options.maxClarificationAssumptions ?? 3);
      let stop: { status: AutonomousRunStatus; reason: string } | null = null;

      for (const taskReport of report.tasks) {
        if (accepted.has(taskReport.taskId)) {
          taskReport.status = 'SKIPPED';
          taskReport.lastSummary = 'Already ACCEPTED in a previous run.';
          continue;
        }
        const task = ingestion.tasks.find((t) => t.task_id === taskReport.taskId)!;
        let extraGuidance = '';

        while (taskReport.cycles < maxCycles) {
          if (isBudgetExhausted(budgetManager)) {
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

          const instruction = [
            NO_QUESTIONS_DIRECTOR_INSTRUCTION,
            `Target task: ${task.task_id} — ${task.title}.`,
            `Task description: ${task.description}`,
            `Acceptance criteria: ${task.acceptance_criteria.join(' | ')}`,
            `Project root is the only allowed workspace; allowed paths: ${(report.mandate?.allowedDirectories ?? []).join(', ')}.`,
            report.assumptions.length ? `Logged assumptions: ${report.assumptions.join(' | ')}` : '',
            extraGuidance,
          ]
            .filter(Boolean)
            .join('\n');

          const headBefore = await gitHead(projectRoot);
          let result: ClosedLoopCycleResult;
          try {
            result = await coordinator.coordinateCycle({
              projectId,
              directorSessionId: session.directorSessionId,
              contextSnapshot: snapshot,
              targetTaskId: task.task_id,
              instruction,
              maxRecoveryAttempts: 1,
            });
          } catch (err) {
            result = {
              status: 'EXECUTION_FAILED',
              summary: err instanceof Error ? err.message : String(err),
            } as ClosedLoopCycleResult;
          }
          taskReport.lastCycleStatus = result.status;
          taskReport.lastSummary = result.summary;
          if (result.systemEvidence) {
            taskReport.evidenceIds.push(result.systemEvidence.evidenceId);
            taskReport.verificationChecks.push(
              ...result.systemEvidence.verificationChecks.map((c) => ({ type: c.type, status: String(c.status), command: c.command }))
            );
          }
          this.emit('CYCLE_RESULT', `${result.status}: ${result.summary}`, task.task_id);

          const actionType = result.directorAction?.actionType as string | undefined;

          if (result.status === 'COMPLETED_SUCCESS' && actionType && actionType !== 'IMPLEMENT_TASK' && actionType !== 'RETRY_TASK' && actionType !== 'CORRECT_TASK') {
            // Non-execution action (e.g. review/analysis): not a task completion; continue.
            extraGuidance = `Previous action ${actionType} did not implement the task. Now emit IMPLEMENT_TASK for ${task.task_id}.`;
            continue;
          }

          if (result.status === 'COMPLETED_SUCCESS') {
            taskReport.status = 'ACCEPTED';
            accepted.add(task.task_id);
            await this.markTaskAccepted(specStore, task.task_id);
            // The closed loop may already checkpoint-commit accepted work; otherwise commit here.
            const headAfter = await gitHead(projectRoot);
            if (headAfter && headAfter !== headBefore) {
              taskReport.commit = headAfter;
              taskReport.filesChanged = await commitFiles(projectRoot, headBefore, headAfter);
              report.commits.push(...(await commitRange(projectRoot, headBefore, headAfter)));
            } else if (this.options.commit !== false) {
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
            extraGuidance = `Clarification is not available. ${assumption} Proceed with IMPLEMENT_TASK.`;
            continue;
          }

          if (result.status === 'NO_ACTION_REQUIRED') {
            extraGuidance = `Task ${task.task_id} is not complete yet. Emit IMPLEMENT_TASK for it.`;
            continue;
          }

          if (
            result.status === 'BLOCKED_ON_APPROVAL' ||
            result.status === 'REJECTED_BY_POLICY' ||
            result.status === 'EXECUTION_UNKNOWN' ||
            result.humanDecisionRequired
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
          extraGuidance = `Previous attempt failed: ${result.summary}. Fix the cause and retry IMPLEMENT_TASK for ${task.task_id}.`;
          if (result.status === 'MAX_ATTEMPTS_EXCEEDED') break;
        }

        if (taskReport.status === 'PENDING') taskReport.status = stop ? 'BLOCKED' : 'FAILED';
        if (stop) break;
        if (taskReport.status === 'FAILED') {
          stop = { status: 'PARTIAL', reason: `Task ${task.task_id} did not reach independently verified success within ${maxCycles} cycle(s).` };
          break;
        }
      }

      const allAccepted = report.tasks.every((t) => t.status === 'ACCEPTED' || t.status === 'SKIPPED');
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
      await fs.promises.rm(lockPath, { force: true });
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
    this.emit('RUN_FINISHED', `${status}${reason ? `: ${reason}` : ''}`);
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
  constructor(
    options: ConstructorParameters<typeof SystemEvidenceCollector>[0],
    specCommands: readonly VerificationCommandSpec[]
  ) {
    super(options);
    this.specCommands = specCommands;
  }
  override collectAndVerify(
    request: ExecutionRequest,
    rawOutcome: RawExecutorOutcome,
    options: SystemEvidenceCollectorOptions = {}
  ) {
    const merged = [...(options.verificationCommands ?? [])];
    for (const c of this.specCommands) if (!merged.some((m) => m.command === c.command)) merged.push(c);
    return super.collectAndVerify(request, rawOutcome, { ...options, verificationCommands: merged });
  }
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
  const status = await git(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  const dirty = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((p) => !p.startsWith('.ai-manager/'));
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
