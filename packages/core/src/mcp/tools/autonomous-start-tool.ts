/**
 * MCP Tool: aidm.autonomous.start (exposed as `aidm_autonomous_start`)
 *
 * Same pipeline as `aidm run --spec`. SECURITY: an MCP caller may be an LLM agent, so the
 * MCP invocation itself is NOT accepted as human authorization. A non-dry-run requires a
 * human-originated, independently verifiable `authContext` (external IdP assertion or
 * trusted IDE signature, validated by the existing P18-04 validator). Without it the tool
 * fails closed with BLOCKED_ON_AUTH_CONTEXT. `dryRun: true` is always allowed (read-only).
 */

import * as path from 'node:path';
import type { McpServer } from '../mcp-server.js';
import type {
  McpToolDefinition,
  McpToolHandler,
  McpToolResult,
  McpRequestContext,
} from '../mcp-types.js';
import { AutonomousSpecRunner, type AutonomousRunOptions } from '../../autonomous/autonomous-runner.js';
import {
  getAutonomousStatus,
  isExternalIdpConfigured,
  resumeExternalApproval,
  startExternalApproval,
} from '../../autonomous/external-approval.js';
import { supplyDecisionToken } from '../../autonomous/decision-requests.js';
import type { ITrustedIdentityProvider } from '../../authorization/trusted-identity-types.js';

export const AIDM_AUTONOMOUS_START_TOOL_NAME = 'aidm.autonomous.start';

export const autonomousStartToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_AUTONOMOUS_START_TOOL_NAME,
  description:
    'Fully autonomous project development from a single Markdown spec (same as `aidm run --spec`). ' +
    'dryRun=true ingests the spec and returns plan + mandate draft without side effects. ' +
    'Live runs require a human-originated authContext; LLM callers cannot self-authorize (BLOCKED_ON_AUTH_CONTEXT). ' +
    'When an external IdP is configured (AIDM_IDP_*), a live run without authContext returns PENDING_EXTERNAL_APPROVAL ' +
    'with an approvalUrl: the human approves with a passkey, then call aidm_autonomous_resume { requestId }.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      specPath: { type: 'string', description: 'Path to the Markdown spec (relative to workspaceRoot or absolute).' },
      workspaceRoot: { type: 'string', description: 'Project root (defaults to the server project root).' },
      budgetUsd: { type: 'number', description: 'Hard LLM budget in USD (required for live runs).' },
      dryRun: { type: 'boolean', description: 'Plan only; no state writes, no LLM/AGY calls.' },
      maxCyclesPerTask: { type: 'number' },
      mandateHours: { type: 'number', description: 'Mandate validity in hours (external approval only, default 8, max 24).' },
      authContext: { type: 'object', description: 'Human-originated, verifiable auth context (P18-04).' },
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
    'llmProvider' | 'allowMockProvider' | 'executorPort' | 'identityManager' | 'registerBudgetTerms' | 'env' | 'decisionResolver'
  >
> & {
  readonly fetchFn?: typeof fetch;
  readonly identityProvider?: ITrustedIdentityProvider;
  /** Tests: run resumed approvals in the foreground. */
  readonly foregroundResume?: boolean;
};

function rootOf(args: Readonly<Record<string, unknown>>, context: McpRequestContext): string {
  return path.resolve(
    (typeof args.workspaceRoot === 'string' && args.workspaceRoot) ||
      (context.delegate as { projectRoot?: string } | undefined)?.projectRoot ||
      process.cwd()
  );
}

export function createAutonomousStartHandler(deps: AutonomousToolDeps = {}): McpToolHandler {
  const { fetchFn, identityProvider, foregroundResume: _fg, ...runnerDeps } = deps;
  void _fg;
  return async (args: Readonly<Record<string, unknown>>, context: McpRequestContext): Promise<McpToolResult> => {
    const root = path.resolve(
      (typeof args.workspaceRoot === 'string' && args.workspaceRoot) ||
        (context.delegate as { projectRoot?: string } | undefined)?.projectRoot ||
        process.cwd()
    );
    if (typeof args.specPath !== 'string' || !/\.(md|markdown)$/i.test(args.specPath)) {
      return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'specPath must be a .md file' }, true);
    }
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
    if (!authContext && args.dryRun !== true && isExternalIdpConfigured(env)) {
      // Asynchronous human approval: fix the binding, persist it, ask the external IdP.
      const res = await startExternalApproval({
        projectRoot: root,
        specPath: path.resolve(root, args.specPath),
        budgetUsd,
        maxCyclesPerTask: typeof args.maxCyclesPerTask === 'number' ? args.maxCyclesPerTask : undefined,
        mandateHours: typeof args.mandateHours === 'number' ? args.mandateHours : undefined,
        env,
        fetchFn,
      });
      return textResult(
        { success: res.success, code: res.code, requestId: res.requestId, approvalUrl: res.approvalUrl, message: res.message },
        !res.success
      );
    }
    void identityProvider;
    try {
      const report = await new AutonomousSpecRunner({
        projectRoot: root,
        specPath: path.resolve(root, args.specPath),
        budgetUsd,
        dryRun: args.dryRun === true,
        maxCyclesPerTask: typeof args.maxCyclesPerTask === 'number' ? args.maxCyclesPerTask : undefined,
        entryPoint: 'aidm_autonomous_start',
        authContext,
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
    'With decisionId + token: hand a signed Product-Owner decision answer to the waiting run. Unverified tokens fail closed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      requestId: { type: 'string', description: 'Approval request id returned by aidm_autonomous_start.' },
      decisionId: { type: 'string', description: 'Pending decision id (from aidm_autonomous_status).' },
      token: { type: 'string', description: 'Optional IdP-signed JWS (otherwise fetched from the IdP).' },
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
  const { fetchFn, identityProvider, foregroundResume, ...runnerDeps } = deps;
  return async (args, context) => {
    const root = rootOf(args, context);
    const token = typeof args.token === 'string' && args.token ? args.token : undefined;
    if (typeof args.decisionId === 'string' && args.decisionId) {
      if (!token) return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'token is required with decisionId' }, true);
      if (!/^[0-9a-f-]{36}$/i.test(args.decisionId)) {
        return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'decisionId must be a UUID' }, true);
      }
      // The waiting run verifies the token (signature, binding, nonce) before using it.
      supplyDecisionToken(args.decisionId, token);
      return textResult({ success: true, code: 'DECISION_TOKEN_SUBMITTED', decisionId: args.decisionId });
    }
    if (typeof args.requestId !== 'string' || !args.requestId) {
      return textResult({ success: false, code: 'INVALID_ARGUMENT', error: 'requestId or decisionId is required' }, true);
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
