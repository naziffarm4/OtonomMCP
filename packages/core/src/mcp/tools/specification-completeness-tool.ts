/**
 * aidm.specification.completeness.evaluate MCP Tool (Phase 15 TASK-P15-02)
 *
 * Exposes authoritative specification completeness evaluation through the Director MCP boundary.
 * Determines whether the currently discovered project specification contains sufficient,
 * unambiguous information to proceed to Product Owner approval.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only / evaluation boundary: does not approve anything or create execution intent.
 * 2. Reuses authoritative components from McpOrchestratorDelegate.
 * 3. Never silently resolves human decision points.
 * 4. Output sanitized via sanitizeMcpPayload.
 * 5. Does NOT invoke Antigravity or grant development authorization.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { CompletenessGateEngine } from '../../discovery/completeness-gate-engine.js';

export const AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME = 'aidm.specification.completeness.evaluate';

const completenessInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive().optional(),
  workspaceRoot: z.string().optional(),
  forceReevaluate: z.boolean().optional(),
});

export type SpecificationCompletenessInput = z.infer<typeof completenessInputSchema>;

export const specificationCompletenessToolDefinition: McpToolDefinition = {
  name: AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME,
  description:
    'Evaluates specification completeness for a project discovery revision across all 15 material specification areas, producing an authoritative completeness gate result (COMPLETE, INCOMPLETE, BLOCKED_ON_HUMAN, NOT_APPLICABLE) with audit evidence, missing information, and pending human decisions.',
  inputSchema: {
    type: 'object',
    required: ['projectId'],
    properties: {
      projectId: {
        type: 'string',
        description: 'Canonical project identifier to evaluate.',
      },
      discoveryRevision: {
        type: 'integer',
        description: 'Optional discovery revision number. Defaults to the latest discovery revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
      forceReevaluate: {
        type: 'boolean',
        description: 'Whether to force re-evaluation if an evaluation is already cached.',
      },
    },
  },
};

export function createSpecificationCompletenessTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: specificationCompletenessToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = completenessInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? activeDelegate?.projectRoot ?? process.cwd();

      const engine =
        activeDelegate?.completenessGateEngine ??
        new CompletenessGateEngine({
          workspaceRoot: resolvedRoot,
          discoveryStore: activeDelegate?.adaptiveDiscoveryStore,
          completenessStore: activeDelegate?.completenessGateStore,
          historyManager: activeDelegate?.historyManager,
          specStore: activeDelegate?.specStore,
        });

      const result = await engine.evaluate({
        projectId: parsed.projectId,
        discoveryRevision: parsed.discoveryRevision,
        workspaceRoot: resolvedRoot,
        forceReevaluate: parsed.forceReevaluate,
      });

      const sanitized = sanitizeMcpPayload(result);

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
