/**
 * Authoritative Read-Only Project Decisions Tool: aidm.project.decisions (Phase 8 TASK-P8-02)
 *
 * Exposes locked architecture and product decisions from .ai-manager/spec/decisions.json.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not mutate decisions or files.
 * 2. Reads strictly from existing authoritative SpecStore.
 * 3. Applies MCP secret sanitization.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  type McpToolDefinition,
  type McpToolRegistration,
  type McpToolResult,
  type McpRequestContext,
} from '../mcp-types.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { SpecStore, type Decision } from '../../storage/spec-store.js';

export const AIDM_PROJECT_DECISIONS_TOOL_NAME = 'aidm.project.decisions';

export const ProjectDecisionsInputZodSchema = z.object({
  id: z.string().optional(),
  status: z.enum(['PROPOSED', 'LOCKED', 'REJECTED']).optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

export type ProjectDecisionsInput = z.infer<typeof ProjectDecisionsInputZodSchema>;

export interface ProjectDecisionsOutput {
  readonly decisions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly authority: string;
    readonly status: string;
    readonly rationale?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
  readonly total: number;
  readonly isAuthoritative: true;
  readonly correlationId: string;
}

export const projectDecisionsToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_PROJECT_DECISIONS_TOOL_NAME,
  description:
    'Returns authoritative architecture and product decisions from .ai-manager/spec/decisions.json. Strictly read-only; delegates to SpecStore.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'Optional decision identifier to query a specific decision.',
      },
      status: {
        type: 'string',
        enum: ['PROPOSED', 'LOCKED', 'REJECTED'],
        description: 'Optional status filter (e.g. LOCKED).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'Maximum number of decisions to return (default 100).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Offset for pagination (default 0).',
      },
    },
    additionalProperties: false,
  },
});

export function createProjectDecisionsTool(): McpToolRegistration {
  return {
    definition: projectDecisionsToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = ProjectDecisionsInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_PROJECT_DECISIONS_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      const specStore = delegate?.specStore ?? new SpecStore({ baseDir: projectRoot });

      let loaded: Decision[] = [];
      try {
        loaded = await specStore.loadDecisions();
      } catch {
        loaded = [];
      }

      // Filter by ID if specified
      let filtered = loaded;
      if (input.id) {
        filtered = filtered.filter((d) => d.id === input.id);
      }

      // Filter by status if specified
      if (input.status) {
        filtered = filtered.filter((d) => d.status === input.status);
      }

      const total = filtered.length;
      const paginated = filtered.slice(input.offset, input.offset + input.limit);

      const mapped = paginated.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        authority: d.authority,
        status: d.status,
        rationale: d.rationale,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        metadata: d.metadata,
      }));

      const payload: ProjectDecisionsOutput = {
        decisions: mapped,
        total,
        isAuthoritative: true,
        correlationId: context.correlation.correlationId,
      };

      const sanitized = sanitizeMcpPayload(payload);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitized, null, 2),
          },
        ],
        isError: false,
      };
    },
  };
}
