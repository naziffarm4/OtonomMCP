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

export const AIDM_AUTONOMOUS_START_TOOL_NAME = 'aidm.autonomous.start';

export const autonomousStartToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_AUTONOMOUS_START_TOOL_NAME,
  description:
    'Fully autonomous project development from a single Markdown spec (same as `aidm run --spec`). ' +
    'dryRun=true ingests the spec and returns plan + mandate draft without side effects. ' +
    'Live runs require a human-originated authContext; LLM callers cannot self-authorize (BLOCKED_ON_AUTH_CONTEXT).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      specPath: { type: 'string', description: 'Path to the Markdown spec (relative to workspaceRoot or absolute).' },
      workspaceRoot: { type: 'string', description: 'Project root (defaults to the server project root).' },
      budgetUsd: { type: 'number', description: 'Hard LLM budget in USD (required for live runs).' },
      dryRun: { type: 'boolean', description: 'Plan only; no state writes, no LLM/AGY calls.' },
      maxCyclesPerTask: { type: 'number' },
      authContext: { type: 'object', description: 'Human-originated, verifiable auth context (P18-04).' },
    },
    required: ['specPath'],
  },
});

function textResult(payload: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function createAutonomousStartHandler(
  deps: Partial<Pick<AutonomousRunOptions, 'llmProvider' | 'allowMockProvider' | 'executorPort' | 'identityManager' | 'registerBudgetTerms' | 'env'>> = {}
): McpToolHandler {
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
    try {
      const report = await new AutonomousSpecRunner({
        projectRoot: root,
        specPath: path.resolve(root, args.specPath),
        budgetUsd,
        dryRun: args.dryRun === true,
        maxCyclesPerTask: typeof args.maxCyclesPerTask === 'number' ? args.maxCyclesPerTask : undefined,
        entryPoint: 'aidm_autonomous_start',
        authContext,
        ...deps,
      }).run();
      const ok = report.status === 'DRY_RUN_OK' || report.status === 'COMPLETED';
      return textResult({ success: ok, code: report.status, report }, !ok);
    } catch (err) {
      return textResult({ success: false, code: 'AUTONOMOUS_RUN_FAILED', error: err instanceof Error ? err.message : String(err) }, true);
    }
  };
}

export function registerAutonomousTools(server: McpServer, deps?: Parameters<typeof createAutonomousStartHandler>[0]): void {
  server.registerTool(autonomousStartToolDefinition, createAutonomousStartHandler(deps));
}
