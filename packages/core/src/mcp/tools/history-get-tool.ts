/**
 * Authoritative Read-Only History Retrieval Tool: aidm.history.get (Phase 8 TASK-P8-02)
 *
 * Exposes append-only lifecycle events from .ai-manager/history/events.jsonl without
 * mutating or fabricating events.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not append, mutate, or delete history records.
 * 2. Reads strictly from existing authoritative HistoryManager.
 * 3. Supports targeted, bounded retrieval to prevent token exhaustion.
 * 4. Applies MCP secret sanitization to event payloads.
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
import { HistoryManager, type HistoryEvent } from '../../storage/history-manager.js';
import { ACTORS } from '../../actors.js';

export const AIDM_HISTORY_GET_TOOL_NAME = 'aidm.history.get';

export const HistoryGetInputZodSchema = z.object({
  taskId: z.string().optional(),
  eventType: z.string().optional(),
  actor: z.enum(ACTORS as [string, ...string[]]).optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

export type HistoryGetInput = z.infer<typeof HistoryGetInputZodSchema>;

export interface HistoryEventOutput {
  readonly eventId: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly actor: string;
  readonly taskId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface HistoryGetOutput {
  readonly events: readonly HistoryEventOutput[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly isAuthoritative: true;
  readonly correlationId: string;
}

export const historyGetToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_HISTORY_GET_TOOL_NAME,
  description:
    'Returns immutable lifecycle events from append-only .ai-manager/history/events.jsonl. Strictly read-only; supports bounded, filtered retrieval and redacts sensitive credentials.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId: {
        type: 'string',
        description: 'Optional task identifier filter.',
      },
      eventType: {
        type: 'string',
        description: 'Optional event type filter (e.g. TASK_SELECTED, QA_REVIEW, PROJECT_COMPLETE).',
      },
      actor: {
        type: 'string',
        enum: ['USER', 'DIRECTOR', 'ORCHESTRATOR', 'EXECUTOR'],
        description: 'Optional actor filter.',
      },
      since: {
        type: 'string',
        description: 'Optional ISO 8601 timestamp string; returns events at or after this time.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Maximum number of events to return (default 50).',
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

export function createHistoryGetTool(): McpToolRegistration {
  return {
    definition: historyGetToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = HistoryGetInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_HISTORY_GET_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      const historyManager =
        delegate?.historyManager ?? new HistoryManager({ baseDir: projectRoot });

      let loadedEvents: HistoryEvent[] = [];
      try {
        loadedEvents = await historyManager.readEvents();
      } catch {
        loadedEvents = [];
      }

      // Apply filters
      let filtered = loadedEvents;

      if (input.taskId) {
        filtered = filtered.filter((e) => e.taskId === input.taskId);
      }
      if (input.eventType) {
        filtered = filtered.filter((e) => e.eventType === input.eventType);
      }
      if (input.actor) {
        filtered = filtered.filter((e) => e.actor === input.actor);
      }
      if (input.since) {
        const sinceTime = new Date(input.since).getTime();
        if (!isNaN(sinceTime)) {
          filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceTime);
        }
      }

      const total = filtered.length;
      const paginated = filtered.slice(input.offset, input.offset + input.limit);
      const hasMore = total > input.offset + input.limit;

      const mapped: HistoryEventOutput[] = paginated.map((e) => ({
        eventId: e.eventId,
        timestamp: e.timestamp,
        eventType: e.eventType,
        actor: e.actor,
        taskId: e.taskId ?? null,
        payload: e.payload,
      }));

      const payload: HistoryGetOutput = {
        events: mapped,
        total,
        hasMore,
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
