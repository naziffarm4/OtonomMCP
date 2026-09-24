/**
 * aidm.project.discover MCP Read-Only Tool (Phase 8 TASK-P8-03)
 *
 * Exposes bounded, structured project discovery through the Director MCP boundary.
 * Produces a typed ProjectDiscoveryReport without mutating project state, files, Git, or tasks.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not modify state, filesystem, or git.
 * 2. Reuses authoritative components from McpOrchestratorDelegate.
 * 3. Never promotes AGENT_CLAIM to SYSTEM_VERIFIED_EVIDENCE.
 * 4. Output sanitized via sanitizeMcpPayload.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { ProjectDiscoveryEngine } from '../../discovery/discovery-engine.js';
import { ProjectDiscoveryReport } from '../../discovery/discovery-types.js';

export const AIDM_PROJECT_DISCOVER_TOOL_NAME = 'aidm.project.discover';

const discoverInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  allowContextRefresh: z.boolean().optional(),
  maxFileScan: z.number().int().positive().optional(),
  maxDocBytes: z.number().int().positive().optional(),
  maxFeatures: z.number().int().positive().optional(),
});

export type DiscoverInput = z.infer<typeof discoverInputSchema>;

export const projectDiscoverToolDefinition: McpToolDefinition = {
  name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
  description:
    'Inspects an existing project codebase in a strictly read-only, bounded manner and produces a comprehensive ProjectDiscoveryReport detailing identity, purpose, technology stack, architecture, entrypoints, commands, feature inventory, authoritative AIDM state, facts, observations, inferences, unknowns, contradictions, and clarification candidates for P8-04.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root. Defaults to configured delegate project root or current working directory.',
      },
      allowContextRefresh: {
        type: 'boolean',
        description: 'Whether to synchronize L0 context index if stale before querying. Defaults to false.',
      },
      maxFileScan: {
        type: 'integer',
        description: 'Maximum number of workspace files to inspect during L0 scan. Defaults to 5000.',
      },
      maxDocBytes: {
        type: 'integer',
        description: 'Maximum bytes to read from documentation files (bounded L1/L2 read). Defaults to 32768.',
      },
      maxFeatures: {
        type: 'integer',
        description: 'Maximum number of features to enumerate in feature inventory. Defaults to 50.',
      },
    },
  },
};

export function createProjectDiscoverTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: projectDiscoverToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = discoverInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? activeDelegate?.projectRoot ?? process.cwd();

      const engine = new ProjectDiscoveryEngine({
        workspaceRoot: resolvedRoot,
        delegate: activeDelegate,
        maxFileScan: parsed.maxFileScan,
        maxDocBytes: parsed.maxDocBytes,
      });

      const report: ProjectDiscoveryReport = await engine.discover({
        allowContextRefresh: parsed.allowContextRefresh,
        maxFileScan: parsed.maxFileScan,
        maxDocBytes: parsed.maxDocBytes,
        maxFeatures: parsed.maxFeatures,
      });

      const sanitized = sanitizeMcpPayload(report);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
      };
    },
  };
}
