/**
 * MCP Tool: aidm.autonomous.start (exposed as `aidm_autonomous_start`)
 *
 * Same pipeline as `aidm run --spec`. SECURITY: an MCP caller may be an LLM agent, so the
 * MCP invocation itself is NOT accepted as human authorization. A non-dry-run requires a
 * human-originated, independently verifiable `authContext` (external IdP assertion or
 * trusted IDE signature, validated by the existing P18-04 validator). Without it the tool
 * fails closed with BLOCKED_ON_AUTH_CONTEXT. `dryRun: true` is always allowed (read-only).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '../mcp-server.js';
import type {
  McpToolDefinition,
  McpToolHandler,
  McpToolResult,
  McpRequestContext,
} from '../mcp-types.js';
import { AutonomousSpecRunner, type AutonomousRunOptions } from '../../autonomous/autonomous-runner.js';
import { defaultProjectRootForSpec } from '../../autonomous/spec-bundle.js';
import {
  getAutonomousStatus,
  isExternalIdpConfigured,
  resumeExternalApproval,
  startExternalApproval,
} from '../../autonomous/external-approval.js';
import { supplyDecisionToken } from '../../autonomous/decision-requests.js';
import { annotateApprovalWorker, loadExternalApprovalRecord } from '../../autonomous/external-approval.js';
import { detachedRunsEnabled, spawnDetachedWorker } from '../../autonomous/worker.js';
import { isPidAlive, loadCheckpoint, listResumableRuns } from '../../autonomous/run-checkpoint.js';
import { runMonitorUrl } from '../../autonomous/run-monitor.js';
import type { ITrustedIdentityProvider } from '../../authorization/trusted-identity-types.js';

export const AIDM_AUTONOMOUS_START_TOOL_NAME = 'aidm.autonomous.start';

export const autonomousStartToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_AUTONOMOUS_START_TOOL_NAME,
  description:
    'Fully autonomous project development from a single Markdown spec (same as `aidm run --spec`). ' +
    'specPath may also be a folder of .md files, or a main spec with an "Ek spec: a.md, b/" include line (multi-document spec). ' +
    'dryRun=true ingests the spec and returns plan + mandate draft without side effects. ' +
    'Live runs require a human-originated authContext; LLM callers cannot self-authorize (BLOCKED_ON_AUTH_CONTEXT). ' +
    'When an external IdP is configured (AIDM_IDP_*), a live run without authContext returns PENDING_EXTERNAL_APPROVAL ' +
    'with an approvalUrl and a monitorUrl. Live runs execute in a DETACHED worker process that survives the MCP server / ' +
    'Antigravity exiting: the worker waits for the passkey approval itself and then runs (no resume call needed). ' +
    'Interrupted runs (process killed, reboot): pass resumeRunId to continue the same run after a NEW approval; ' +
    'completed tasks are skipped and the budget carries over. Poll aidm_autonomous_status.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      specPath: { type: 'string', description: 'Path to the Markdown spec (relative to workspaceRoot or absolute).' },
      workspaceRoot: { type: 'string', description: 'Project root (defaults to the folder containing the spec .md). Pass the same value to aidm_autonomous_resume/status.' },
      budgetUsd: { type: 'number', description: 'Hard LLM budget in USD (required for live runs).' },
      dryRun: { type: 'boolean', description: 'Plan only; no state writes, no LLM/AGY calls.' },
      maxCyclesPerTask: { type: 'number' },
      mandateHours: { type: 'number', description: 'Mandate validity in hours (external approval only, default 8, max 24).' },
      authContext: { type: 'object', description: 'Human-originated, verifiable auth context (P18-04).' },
      resumeRunId: { type: 'string', description: 'Continue this INTERRUPTED run (same runId; requires a new approval; spec must be unchanged).' },
      abandonInterrupted: { type: 'boolean', description: 'Start fresh even though an interrupted run exists (it is marked ABANDONED).' },
      detach: { type: 'boolean', description: 'Run in a detached worker process (default true for live runs).' },
    },
    required: ['specPath'],
  },
});

function textResult(payload: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export type AutonomousToolDeps = Partial<
  Pick<
    AutonomousRunOptions,
    'llmProvider' | 'allowMockProvider' | 'executorPort' | 'identityManager' | 'registerBudgetTerms' | 'env' | 'decisionResolver' | 'clarificationResolver'
  >
> & {
  readonly fetchFn?: typeof fetch;
  readonly identityProvider?: ITrustedIdentityProvider;
  /** Tests: run resumed approvals in the foreground. */
  readonly foregroundResume?: boolean;
  /**
   * Detached worker processes for live runs. Default: enabled unless test doubles are injected
   * (llmProvider / executorPort cannot cross a process boundary) or AIDM_MCP_DETACHED_RUNS=off.
   */
  readonly detachedWorker?: boolean;
  /** Extra node flags for spawned workers (tests). */
  readonly workerExecArgv?: string[];
};

function useWorker(deps: AutonomousToolDeps, args: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string | undefined>>): boolean {
  if (args.detach === false) return false;
  if (deps.detachedWorker !== undefined) return deps.detachedWorker;
  if (deps.llmProvider || deps.executorPort || deps.foregroundResume) return false;
  return detachedRunsEnabled(env);
}

function rootOf(args: Readonly<Record<string, unknown>>, context: McpRequestContext): string {
  return path.resolve(
    (typeof args.workspaceRoot === 'string' && args.workspaceRoot) ||
      (context.delegate as { projectRoot?: string } | undefined)?.projectRoot ||
      process.cwd()
  );
}

export function createAutonomousStartHandler(deps: AutonomousToolDeps = {}): McpToolHandler {
  const { fetchFn, identityProvider, foregroundResume: _fg, detachedWorker: _dw, workerExecArgv, ...runnerDeps } = deps;
  void _fg;
  void _dw;
  return async (args: Readonly<Record<string, unknown>>, context: McpRequestContext): Promise<McpToolResult> => {
    if (typeof args.specPath !== 'string' || !args.specPath.trim()) {
      return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'specPath must be a .md file or a folder of .md files' }, true);
    }
    // Explicit workspaceRoot wins; otherwise the project root is the folder containing the spec.
    // (Previously: server project root, then process.cwd().) A relative specPath is resolved
    // against the explicit root, else against the server root / cwd.
    const explicitRoot = typeof args.workspaceRoot === 'string' && args.workspaceRoot.trim() ? args.workspaceRoot : undefined;
    const base = path.resolve(explicitRoot || (context.delegate as { projectRoot?: string } | undefined)?.projectRoot || process.cwd());
    const specAbs = path.resolve(base, args.specPath);
    const specIsDir = (() => {
      try {
        return fs.statSync(specAbs).isDirectory();
      } catch {
        return false;
      }
    })();
    if (!specIsDir && !/\.(md|markdown)$/i.test(args.specPath)) {
      return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'specPath must be a .md file or a folder of .md files' }, true);
    }
    // A spec folder (multi-document spec) defaults to its nearest project root (.git/.ai-manager/package.json).
    const root = explicitRoot ? base : defaultProjectRootForSpec(specAbs);
    const budgetUsd = typeof args.budgetUsd === 'number' ? args.budgetUsd : undefined;
    const authContext =
      args.authContext && typeof args.authContext === 'object' ? (args.authContext as Record<string, unknown>) : undefined;
    if (authContext && authContext.authSource === 'OPERATOR_CLI_INVOCATION') {
      // Operator CLI contexts are only minted by the local CLI entry point, never accepted over MCP.
      return textResult(
        { success: false, code: 'BLOCKED_ON_AUTH_CONTEXT', error: 'OPERATOR_CLI_INVOCATION contexts are not accepted over MCP.' },
        true
      );
    }
    const env = deps.env ?? process.env;
    const resumeRunId = typeof args.resumeRunId === 'string' && args.resumeRunId.trim() ? args.resumeRunId.trim() : undefined;
    const abandonInterrupted = args.abandonInterrupted === true;
    const resumeRequestId =
      resumeRunId && typeof args.resumeRequestId === 'string' && /^[0-9a-f-]{36}$/i.test(args.resumeRequestId) ? args.resumeRequestId.toLowerCase() : undefined;
    const detach = args.dryRun !== true && useWorker(deps, args, env);
    if (!authContext && args.dryRun !== true && isExternalIdpConfigured(env)) {
      // Asynchronous human approval: fix the binding, persist it, ask the external IdP.
      const res = await startExternalApproval({
        projectRoot: root,
        specPath: specAbs,
        budgetUsd,
        maxCyclesPerTask: typeof args.maxCyclesPerTask === 'number' ? args.maxCyclesPerTask : undefined,
        mandateHours: typeof args.mandateHours === 'number' ? args.mandateHours : undefined,
        ...(resumeRequestId ? { resumeRequestId } : {}),
        env,
        fetchFn,
        providerInjected: Boolean(runnerDeps.llmProvider),
        ...(resumeRunId ? { resumeRunId } : {}),
        ...(abandonInterrupted ? { abandonInterrupted } : {}),
      });
      let worker: { pid?: number; logPath: string } | undefined;
      if (res.success && res.requestId && detach) {
        try {
          worker = await spawnDetachedWorker({ kind: 'approval', projectRoot: root, requestId: res.requestId }, { env, execArgv: workerExecArgv });
          await annotateApprovalWorker(root, res.requestId, worker);
        } catch (err) {
          return textResult({ success: false, code: 'WORKER_SPAWN_FAILED', requestId: res.requestId, approvalUrl: res.approvalUrl, error: err instanceof Error ? err.message : String(err) }, true);
        }
      }
      return textResult(
        {
          success: res.success,
          code: res.code,
          requestId: res.requestId,
          runId: res.record?.runId,
          ...(resumeRunId ? { resumeOfRunId: resumeRunId } : {}),
          approvalUrl: res.approvalUrl,
          monitorUrl: res.monitorUrl,
          workspaceRoot: root,
          ...(worker ? { workerPid: worker.pid, logPath: worker.logPath } : {}),
          message: worker
            ? 'Approve with your passkey in the IdP (approvalUrl). A detached worker waits for the approval and then runs; it keeps running if Antigravity/MCP exits. Poll aidm_autonomous_status.'
            : res.message,
        },
        !res.success
      );
    }
    if (detach && authContext) {
      try {
        const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
        const w = await spawnDetachedWorker(
          {
            kind: 'run',
            projectRoot: root,
            specPath: specAbs,
            budgetUsd,
            maxCyclesPerTask: typeof args.maxCyclesPerTask === 'number' ? args.maxCyclesPerTask : undefined,
            authContext,
            ...(resumeRunId ? { resumeRunId } : { runId }),
            ...(abandonInterrupted ? { abandonInterrupted } : {}),
          },
          { env, execArgv: workerExecArgv }
        );
        const rid = resumeRunId ?? runId;
        return textResult({
          success: true,
          code: 'RUN_STARTED',
          runId: rid,
          workerPid: w.pid,
          logPath: w.logPath,
          monitorUrl: runMonitorUrl(env, rid) ?? undefined,
          workspaceRoot: root,
          message: 'Autonomous run started in a detached worker (survives MCP/Antigravity exit). Poll aidm_autonomous_status.',
        });
      } catch (err) {
        return textResult({ success: false, code: 'WORKER_SPAWN_FAILED', error: err instanceof Error ? err.message : String(err) }, true);
      }
    }
    void identityProvider;
    try {
      const report = await new AutonomousSpecRunner({
        projectRoot: root,
        specPath: specAbs,
        budgetUsd,
        dryRun: args.dryRun === true,
        maxCyclesPerTask: typeof args.maxCyclesPerTask === 'number' ? args.maxCyclesPerTask : undefined,
        entryPoint: 'aidm_autonomous_start',
        authContext,
        ...(resumeRunId ? { resumeRunId } : {}),
        ...(abandonInterrupted ? { abandonInterrupted } : {}),
        ...runnerDeps,
        ...(identityProvider ? { identityProvider } : {}),
      }).run();
      const ok = report.status === 'DRY_RUN_OK' || report.status === 'COMPLETED';
      return textResult({ success: ok, code: report.status, report }, !ok);
    } catch (err) {
      return textResult({ success: false, code: 'AUTONOMOUS_RUN_FAILED', error: err instanceof Error ? err.message : String(err) }, true);
    }
  };
}

export const AIDM_AUTONOMOUS_RESUME_TOOL_NAME = 'aidm.autonomous.resume';
export const AIDM_AUTONOMOUS_STATUS_TOOL_NAME = 'aidm.autonomous.status';

export const autonomousResumeToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_AUTONOMOUS_RESUME_TOOL_NAME,
  description:
    'Resume after a human acted in the external IdP. With requestId: verify the passkey-signed approval token ' +
    '(polled from the IdP, or the given token), seal the mandate (authSource EXTERNAL_IDP) and start the run in the background. ' +
    'With decisionId + token: hand a signed Product-Owner decision answer to the waiting run. Unverified tokens fail closed. ' +
    'With runId (+ optional budgetUsd): resume an INTERRUPTED run — asks for a NEW passkey approval bound to that run, ' +
    'then a detached worker continues it (completed tasks skipped, budget carried over).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      requestId: { type: 'string', description: 'Approval request id returned by aidm_autonomous_start.' },
      decisionId: { type: 'string', description: 'Pending decision id (from aidm_autonomous_status).' },
      token: { type: 'string', description: 'Optional IdP-signed JWS (otherwise fetched from the IdP).' },
      runId: { type: 'string', description: 'Interrupted or BLOCKED_ON_HUMAN run to resume. Optional: without requestId/decisionId/runId the single resumable run of the project is resumed (several -> AMBIGUOUS_RUN with the list).' },
      workspaceRoot: { type: 'string' },
    },
  },
});

export const autonomousStatusToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_AUTONOMOUS_STATUS_TOOL_NAME,
  description: 'Read-only: external approval requests, background run state and pending Product-Owner decisions.',
  inputSchema: {
    type: 'object' as const,
    properties: { requestId: { type: 'string' }, workspaceRoot: { type: 'string' } },
  },
});

export function createAutonomousResumeHandler(deps: AutonomousToolDeps = {}): McpToolHandler {
  const { fetchFn, identityProvider, foregroundResume, detachedWorker: _dw, workerExecArgv, ...runnerDeps } = deps;
  void _dw;
  const startHandler = createAutonomousStartHandler(deps);
  return async (args, context) => {
    const root = rootOf(args, context);
    if (!args.requestId && !args.decisionId && (args.runId === undefined || (typeof args.runId === 'string' && args.runId))) {
      let cp;
      if (typeof args.runId === 'string') {
        try {
          cp = loadCheckpoint(root, args.runId);
        } catch {
          cp = null;
        }
        if (!cp) return textResult({ success: false, code: 'NOT_FOUND', error: `No checkpoint for run '${args.runId}' in ${root}.` }, true);
      } else {
        // No runId: the single resumable run of this project (interrupted or BLOCKED_ON_HUMAN).
        const resumable = listResumableRuns(root);
        if (resumable.length === 0) {
          return textResult({ success: false, code: 'NOT_FOUND', error: `No interrupted or blocked run to resume in ${root}. Pass requestId, decisionId or runId.` }, true);
        }
        if (resumable.length > 1) {
          return textResult(
            {
              success: false,
              code: 'AMBIGUOUS_RUN',
              error: 'Several runs can be resumed; pass runId.',
              runs: resumable.map((c) => ({ runId: c.runId, status: c.status ?? 'INTERRUPTED', startedAt: c.startedAt, updatedAt: c.updatedAt, stopReason: c.stopReason })),
            },
            true
          );
        }
        cp = resumable[0]!;
      }
      return startHandler(
        {
          specPath: cp.specPath,
          workspaceRoot: root,
          resumeRunId: cp.runId,
          ...(typeof args.budgetUsd === 'number' ? { budgetUsd: args.budgetUsd } : {}),
          ...(args.authContext ? { authContext: args.authContext } : {}),
        },
        context
      );
    }
    const token = typeof args.token === 'string' && args.token ? args.token : undefined;
    if (typeof args.decisionId === 'string' && args.decisionId) {
      if (!token) return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'token is required with decisionId' }, true);
      if (!/^[0-9a-f-]{36}$/i.test(args.decisionId)) {
        return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'decisionId must be a UUID' }, true);
      }
      // The waiting run verifies the token (signature, binding, nonce) before using it.
      supplyDecisionToken(args.decisionId, token, root);
      return textResult({ success: true, code: 'DECISION_TOKEN_SUBMITTED', decisionId: args.decisionId });
    }
    if (typeof args.requestId !== 'string' || !args.requestId) {
      return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'requestId or decisionId is required' }, true);
    }
    const env = deps.env ?? process.env;
    if (useWorker(deps, args, env)) {
      const rec = await loadExternalApprovalRecord(root, args.requestId).catch(() => null);
      if (rec && rec.state === 'PENDING' && rec.workerPid && isPidAlive(rec.workerPid)) {
        return textResult({
          success: true,
          code: 'PENDING_EXTERNAL_APPROVAL',
          requestId: rec.requestId,
          approvalUrl: rec.approvalUrl,
          runId: rec.runId,
          workerPid: rec.workerPid,
          logPath: rec.logPath,
          message: 'A detached worker is already waiting for this approval; it starts the run by itself.',
        });
      }
      if (rec && rec.state === 'PENDING') {
        try {
          const w = await spawnDetachedWorker({ kind: 'approval', projectRoot: root, requestId: rec.requestId }, { env, execArgv: workerExecArgv });
          await annotateApprovalWorker(root, rec.requestId, w);
          return textResult({
            success: true,
            code: 'WORKER_STARTED',
            requestId: rec.requestId,
            approvalUrl: rec.approvalUrl,
            runId: rec.runId,
            workerPid: w.pid,
            logPath: w.logPath,
            message: 'Detached worker started: it verifies the passkey approval and runs. Poll aidm_autonomous_status.',
          });
        } catch (err) {
          return textResult({ success: false, code: 'WORKER_SPAWN_FAILED', error: err instanceof Error ? err.message : String(err) }, true);
        }
      }
    }
    try {
      const res = await resumeExternalApproval({
        projectRoot: root,
        requestId: args.requestId,
        token,
        env: deps.env,
        fetchFn,
        identityProvider,
        background: foregroundResume ? false : true,
        runnerDeps,
      });
      return textResult(
        {
          success: res.success,
          code: res.code,
          requestId: res.requestId,
          message: res.message,
          state: res.record?.state,
          runId: res.record?.runId,
          ...(res.report ? { report: res.report } : {}),
        },
        !res.success
      );
    } catch (err) {
      return textResult({ success: false, code: 'AUTONOMOUS_RESUME_FAILED', error: err instanceof Error ? err.message : String(err) }, true);
    }
  };
}

export function createAutonomousStatusHandler(): McpToolHandler {
  return async (args, context) => {
    const root = rootOf(args, context);
    const status = await getAutonomousStatus(root, typeof args.requestId === 'string' ? args.requestId : undefined);
    return textResult({ success: true, ...status });
  };
}

export function registerAutonomousTools(server: McpServer, deps?: AutonomousToolDeps): void {
  server.registerTool(autonomousStartToolDefinition, createAutonomousStartHandler(deps));
  server.registerTool(autonomousResumeToolDefinition, createAutonomousResumeHandler(deps));
  server.registerTool(autonomousStatusToolDefinition, createAutonomousStatusHandler());
}
