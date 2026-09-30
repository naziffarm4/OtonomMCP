/**
 * aidm.project.discover MCP Tool (Phase 8 TASK-P8-03, Phase 15 TASK-P15-01)
 *
 * Exposes structured project discovery through the Director MCP boundary:
 * 1. Existing codebase inspection via ProjectDiscoveryEngine.
 * 2. Adaptive project initiation discovery via AdaptiveDiscoveryEngine (when rawPrompt/prompt provided).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not modify state, filesystem, or git.
 * 2. Reuses authoritative components from McpOrchestratorDelegate.
 * 3. Never promotes AGENT_CLAIM to SYSTEM_VERIFIED_EVIDENCE.
 * 4. Output sanitized via sanitizeMcpPayload.
 * 5. Does NOT approve project, create execution intent, or invoke Antigravity.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { resolveTargetProjectRoot } from '../project-root-resolver.js';
import { ProjectDiscoveryEngine } from '../../discovery/discovery-engine.js';
import { ProjectDiscoveryReport } from '../../discovery/discovery-types.js';
import { AdaptiveDiscoveryEngine } from '../../discovery/adaptive-discovery-engine.js';

export const AIDM_PROJECT_DISCOVER_TOOL_NAME = 'aidm.project.discover';

const discoverInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  prompt: z.string().optional(),
  rawPrompt: z.string().optional(),
  adaptive: z.boolean().optional(),
  resolvedAnswers: z.record(z.string(), z.string()).optional(),
  decidedHumanDecisions: z.record(z.string(), z.string()).optional(),
  allowContextRefresh: z.boolean().optional(),
  maxFileScan: z.number().int().positive().optional(),
  maxDocBytes: z.number().int().positive().optional(),
  maxFeatures: z.number().int().positive().optional(),
});

export type DiscoverInput = z.infer<typeof discoverInputSchema>;

export const projectDiscoverToolDefinition: McpToolDefinition = {
  name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
  description:
    'Inspects an existing project codebase or performs adaptive project discovery for project initiation, producing a structured, typed discovery report or revision detailing identity, purpose, technology stack, architecture, entrypoints, commands, functional/non-functional requirements, human decisions, and prioritized questions.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root. Defaults to configured delegate project root or current working directory.',
      },
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier.',
      },
      prompt: {
        type: 'string',
        description: 'Optional Product Owner initial project description or natural language intent for adaptive discovery.',
      },
      rawPrompt: {
        type: 'string',
        description: 'Alias for prompt: natural language intent for adaptive discovery.',
      },
      adaptive: {
        type: 'boolean',
        description: 'Optional flag to force adaptive discovery engine evaluation.',
      },
      resolvedAnswers: {
        type: 'object',
        description: 'Optional dictionary of resolved question answers for progressive discovery refinement.',
      },
      decidedHumanDecisions: {
        type: 'object',
        description: 'Optional dictionary of decided human decision points for progressive discovery refinement.',
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
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
      });

      const naturalPrompt = (parsed.rawPrompt ?? parsed.prompt ?? '').trim();
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      // If natural prompt or explicit progressive answers are provided, invoke AdaptiveDiscoveryEngine
      if (naturalPrompt.length > 0 || parsed.resolvedAnswers || parsed.decidedHumanDecisions || parsed.adaptive) {
        const adaptiveEngine =
          (isSameRoot && activeDelegate?.adaptiveDiscoveryEngine)
            ? activeDelegate.adaptiveDiscoveryEngine
            : new AdaptiveDiscoveryEngine({
                workspaceRoot: resolvedRoot,
                specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
                historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
                durableStateManager: (isSameRoot && activeDelegate?.durableStateManager) ? activeDelegate.durableStateManager : undefined,
                discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
                existingDiscoveryEngine: (isSameRoot && activeDelegate?.discoveryEngine)
                  ? activeDelegate.discoveryEngine
                  : new ProjectDiscoveryEngine({ workspaceRoot: resolvedRoot }),
              });

        const revision = await adaptiveEngine.discover({
          projectId: parsed.projectId,
          workspaceRoot: resolvedRoot,
          rawPrompt: naturalPrompt,
          resolvedAnswers: parsed.resolvedAnswers,
          decidedHumanDecisions: parsed.decidedHumanDecisions,
        });

        const sanitized = sanitizeMcpPayload(revision);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitized, null, 2),
            },
          ],
        };
      }

      // Default: Phase 8 existing repository discovery engine
      const engine =
        (isSameRoot && activeDelegate?.discoveryEngine)
          ? activeDelegate.discoveryEngine
          : new ProjectDiscoveryEngine({
              workspaceRoot: resolvedRoot,
              delegate: isSameRoot ? activeDelegate : undefined,
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
