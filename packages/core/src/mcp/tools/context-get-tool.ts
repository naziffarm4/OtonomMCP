/**
 * Authoritative Read-Only Context Retrieval Tool: aidm.context.get (Phase 8 TASK-P8-02)
 *
 * Exposes targeted L0 (metadata/hash), L1 (structural/signatures), or L2 (content)
 * project context through the authoritative ContextEngine.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only: does not refresh index or mutate filesystem/cache.
 * 2. Requires explicit sourcePaths: prevents unbounded repository dumps.
 * 3. Identifies stale context without silently mutating the index.
 * 4. Strictly validates paths against workspace escape.
 * 5. Applies MCP secret sanitization.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import {
  type McpToolDefinition,
  type McpToolRegistration,
  type McpToolResult,
  type McpRequestContext,
} from '../mcp-types.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { ContextEngine } from '../../context-engine/context-engine.js';
import {
  type ContextLayer,
  type ContextItem,
  type ContextTokenInfo,
  ContextIntent,
} from '../../context-engine/context-types.js';
import { computeFileSha256 } from '../../l0/hasher.js';

export const AIDM_CONTEXT_GET_TOOL_NAME = 'aidm.context.get';

export const ContextGetInputZodSchema = z.object({
  sourcePaths: z
    .array(z.string().min(1, 'sourcePath cannot be empty'))
    .min(1, 'At least one sourcePath must be specified for targeted retrieval'),
  layer: z.enum(['L0', 'L1', 'L2']).optional(),
  intent: z
    .enum(['LOCATE_FILE', 'METADATA', 'CONTRACT', 'STRUCTURAL', 'FULL_IMPLEMENTATION', 'AUTO'])
    .optional(),
  taskId: z.string().optional(),
  relevantSymbols: z.array(z.string()).optional(),
}).strict();

export type ContextGetInput = z.infer<typeof ContextGetInputZodSchema>;

export interface ContextItemOutput {
  readonly sourcePath: string;
  readonly layer: 'L0' | 'L1' | 'L2';
  readonly fileHash: string;
  readonly size: number;
  readonly isStale: boolean;
  readonly indexedHash?: string;
  readonly currentHash?: string;
  readonly mtimeMs?: number;
  readonly indexedAt?: string;
  readonly interfaces?: readonly string[];
  readonly typeDefinitions?: readonly string[];
  readonly signatures?: readonly string[];
  readonly imports?: readonly string[];
  readonly exports?: readonly string[];
  readonly summary?: string;
  readonly content?: string;
  readonly encoding?: string;
  readonly tokenInfo: {
    readonly estimated_tokens: number;
    readonly is_exact_provider_metric: boolean;
  };
}

export interface ContextGetOutput {
  readonly requestId: string;
  readonly taskId: string | null;
  readonly targetLayer: string;
  readonly isSufficient: boolean;
  readonly sufficiencyReason: string;
  readonly totalEstimatedTokens: number;
  readonly items: readonly ContextItemOutput[];
  readonly correlationId: string;
}

export const contextGetToolDefinition: McpToolDefinition = Object.freeze({
  name: AIDM_CONTEXT_GET_TOOL_NAME,
  description:
    'Returns targeted project context (L0 metadata/hash, L1 structural/signatures, or L2 content) using the authoritative ContextEngine. Strictly read-only; reports stale context without silently mutating the index.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sourcePaths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Required list of specific relative file paths to inspect. Prevents full-repo dumps.',
      },
      layer: {
        type: 'string',
        enum: ['L0', 'L1', 'L2'],
        description: 'Explicit layer to retrieve (L0: metadata, L1: signatures/diff, L2: content).',
      },
      intent: {
        type: 'string',
        enum: ['LOCATE_FILE', 'METADATA', 'CONTRACT', 'STRUCTURAL', 'FULL_IMPLEMENTATION', 'AUTO'],
        description: 'Context resolution intent (default AUTO).',
      },
      taskId: {
        type: 'string',
        description: 'Optional task identifier linking this context request to a task.',
      },
      relevantSymbols: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional relevant symbols for focused L1 extraction.',
      },
    },
    required: ['sourcePaths'],
    additionalProperties: false,
  },
});

export function createContextGetTool(): McpToolRegistration {
  return {
    definition: contextGetToolDefinition,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      context: McpRequestContext
    ): Promise<McpToolResult> => {
      const parseResult = ContextGetInputZodSchema.safeParse(args);
      if (!parseResult.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for tool ${AIDM_CONTEXT_GET_TOOL_NAME}: ${parseResult.error.message}`,
          { issues: parseResult.error.issues },
          context.correlation.correlationId
        );
      }

      const input = parseResult.data;
      const delegate = context.delegate;
      const projectRoot = delegate?.projectRoot ? path.resolve(delegate.projectRoot) : process.cwd();

      // Path containment check (prevent path traversal outside workspace)
      for (const rawPath of input.sourcePaths) {
        const resolved = path.resolve(projectRoot, rawPath);
        const relative = path.relative(projectRoot, resolved);
        if (relative.startsWith('..') || path.isAbsolute(rawPath)) {
          throw new McpInvalidRequestError(
            `Access denied: path "${rawPath}" escapes workspace root "${projectRoot}"`,
            { path: rawPath },
            context.correlation.correlationId
          );
        }
      }

      // Authoritative ContextEngine
      const contextEngine =
        delegate?.contextEngine ?? new ContextEngine({ workspaceRoot: projectRoot });

      // Determine requested layer
      const requestedLayer: ContextLayer | undefined = input.layer as ContextLayer | undefined;
      const intent = input.intent ?? ContextIntent.AUTO;

      const items: ContextItemOutput[] = [];
      let totalTokens = 0;
      let targetLayerName: string = requestedLayer ?? 'L0';
      let isSufficient = true;
      let sufficiencyReason = 'Targeted context resolved';

      // Sort paths deterministically
      const sortedPaths = [...input.sourcePaths].sort();

      for (const relPath of sortedPaths) {
        const normalized = relPath.replace(/\\/g, '/');
        const fullPath = path.join(projectRoot, normalized);

        // Check if file exists on disk
        const fileExists = fs.existsSync(fullPath);
        let currentDiskHash = '';
        if (fileExists) {
          try {
            currentDiskHash = await computeFileSha256(fullPath);
          } catch {
            currentDiskHash = '';
          }
        }

        // Retrieve L0 first
        let l0Context;
        try {
          l0Context = await contextEngine.getL0Context(normalized);
        } catch {
          // If file not in index and not on disk, return empty or not found
          items.push({
            sourcePath: normalized,
            layer: requestedLayer ?? 'L0',
            fileHash: '',
            size: 0,
            isStale: false,
            summary: 'File not found',
            tokenInfo: { estimated_tokens: 0, is_exact_provider_metric: false },
          });
          continue;
        }

        const isStale = Boolean(currentDiskHash && l0Context.fileHash !== currentDiskHash);

        if (requestedLayer === 'L2') {
          // Retrieve L2
          targetLayerName = 'L2';
          const l2 = await contextEngine.getL2Context(normalized);
          totalTokens += l2.tokenInfo.estimated_tokens;
          items.push({
            sourcePath: normalized,
            layer: 'L2',
            fileHash: l2.fileHash,
            size: l2.size,
            isStale,
            indexedHash: l0Context.fileHash,
            currentHash: currentDiskHash || l2.fileHash,
            content: l2.content,
            encoding: l2.encoding,
            tokenInfo: {
              estimated_tokens: l2.tokenInfo.estimated_tokens,
              is_exact_provider_metric: l2.tokenInfo.is_exact_provider_metric,
            },
          });
        } else if (requestedLayer === 'L1') {
          // Retrieve L1
          targetLayerName = 'L1';
          const l1 = await contextEngine.getL1Context(normalized, {
            relevantSymbols: input.relevantSymbols,
          });
          totalTokens += l1.tokenInfo.estimated_tokens;
          items.push({
            sourcePath: normalized,
            layer: 'L1',
            fileHash: l1.fileHash,
            size: l1.size,
            isStale,
            indexedHash: l0Context.fileHash,
            currentHash: currentDiskHash || l1.fileHash,
            interfaces: l1.interfaces,
            typeDefinitions: l1.typeDefinitions,
            signatures: l1.signatures,
            imports: l1.imports,
            exports: l1.exports,
            summary: l1.summary,
            tokenInfo: {
              estimated_tokens: l1.tokenInfo.estimated_tokens,
              is_exact_provider_metric: l1.tokenInfo.is_exact_provider_metric,
            },
          });
        } else {
          // Default L0 (or resolve based on intent)
          targetLayerName = 'L0';
          totalTokens += l0Context.tokenInfo.estimated_tokens;
          items.push({
            sourcePath: normalized,
            layer: 'L0',
            fileHash: l0Context.fileHash,
            size: l0Context.size,
            isStale,
            indexedHash: l0Context.fileHash,
            currentHash: currentDiskHash || l0Context.fileHash,
            mtimeMs: l0Context.mtimeMs,
            indexedAt: l0Context.indexedAt,
            tokenInfo: {
              estimated_tokens: l0Context.tokenInfo.estimated_tokens,
              is_exact_provider_metric: l0Context.tokenInfo.is_exact_provider_metric,
            },
          });
        }
      }

      const payload: ContextGetOutput = {
        requestId: `ctx-req-${Date.now()}`,
        taskId: input.taskId ?? context.correlation.taskId ?? null,
        targetLayer: targetLayerName,
        isSufficient,
        sufficiencyReason,
        totalEstimatedTokens: totalTokens,
        items,
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
