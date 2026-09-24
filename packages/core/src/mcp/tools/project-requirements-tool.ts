/**
 * Authoritative Read-Only Project Requirements Tool: aidm.project.requirements (Phase 8 TASK-P8-02)
 *
 * Exposes locked project requirements from .ai-manager/spec/requirements.json.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not mutate requirements or files.
 * 2. Reads strictly from existing authoritative SpecStore.
 * 3. Never returns synthesized requirements as authoritative.
 * 4. Applies MCP secret sanitization.
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
import { SpecStore, type Requirement } from '../../storage/spec-store.js';

export const AIDM_PROJECT_REQUIREMENTS_TOOL_NAME = 'aidm.project.requirements';

export const ProjectRequirementsInputZodSchema = z.object({
  id: z.string().optional(),
  status: z.enum(['DRAFT', 'LOCKED', 'SUPERSEDED']).optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

export type ProjectRequirementsInput = z.infer<typeof ProjectRequirementsInputZodSchema>;

export interface ProjectRequirementsOutput {
  readonly requirements: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly authority: string;
    readonly status: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
  readonly total: number;
  readonly isAuthoritative: true;
  readonly correlationId: string;
}

export const projectRequirementsToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  description:
    'Returns authoritative project requirements from .ai-manager/spec/requirements.json. Strictly read-only; never synthesizes requirements.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'Optional requirement identifier to query a specific requirement.',
      },
      status: {
        type: 'string',
        enum: ['DRAFT', 'LOCKED', 'SUPERSEDED'],
        description: 'Optional status filter (e.g. LOCKED).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'Maximum number of requirements to return (default 100).',
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

export function createProjectRequirementsTool(): McpToolRegistration {
  return {
    definition: projectRequirementsToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = ProjectRequirementsInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_PROJECT_REQUIREMENTS_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      const specStore = delegate?.specStore ?? new SpecStore({ baseDir: projectRoot });

      let loaded: Requirement[] = [];
      try {
        loaded = await specStore.loadRequirements();
      } catch {
        // If requirements.json does not exist, return authoritative empty set
        loaded = [];
      }

      // Filter by ID if specified
      let filtered = loaded;
      if (input.id) {
        filtered = filtered.filter((r) => r.id === input.id);
      }

      // Filter by status if specified
      if (input.status) {
        filtered = filtered.filter((r) => r.status === input.status);
      }

      const total = filtered.length;
      const paginated = filtered.slice(input.offset, input.offset + input.limit);

      const mapped = paginated.map((r) => {
        const rawCriteria = (r.metadata as Record<string, unknown> | undefined)?.acceptance_criteria ??
          (r.metadata as Record<string, unknown> | undefined)?.acceptanceCriteria;
        const acceptanceCriteria = Array.isArray(rawCriteria)
          ? rawCriteria.map(String)
          : undefined;

        return {
          id: r.id,
          title: r.title,
          description: r.description,
          authority: r.authority,
          status: r.status,
          acceptanceCriteria,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          metadata: r.metadata,
        };
      });

      const payload: ProjectRequirementsOutput = {
        requirements: mapped,
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
