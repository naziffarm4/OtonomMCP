/**
 * aidm.requirements.scope.define & aidm.requirements.scope.get MCP Tools (Phase 15 TASK-P15-03)
 *
 * Exposes authoritative Requirements & Scope definition and inspection through the Director MCP boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly requirements/scope definition & inspection boundary: does not approve anything or create execution intent.
 * 2. Reuses authoritative components from McpOrchestratorDelegate.
 * 3. Never silently resolves human decision points.
 * 4. Output sanitized via sanitizeMcpPayload.
 * 5. Does NOT invoke Antigravity, create execution requests, or grant development authorization.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { resolveTargetProjectRoot } from '../project-root-resolver.js';
import { RequirementsScopeEngine } from '../../discovery/requirements-scope-engine.js';
import { ScopeAssumptionZodSchema } from '../../discovery/requirements-scope-types.js';

export const AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME = 'aidm.requirements.scope.define';
export const AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME = 'aidm.requirements.scope.get';

// Input schema for DEFINE
const defineInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalAssumptions: z.array(ScopeAssumptionZodSchema).optional(),
});

export type RequirementsScopeDefineInput = z.infer<typeof defineInputSchema>;

export const requirementsScopeDefineToolDefinition: McpToolDefinition = {
  name: AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
  description:
    'Transforms discovered project understanding into an explicit, structured, revisioned Requirements & Scope specification for project initiation. Extracts purpose, target users, in-scope, out-of-scope, undecided items, functional requirements with canonical IDs, non-functional requirements, constraints, assumptions, open questions, and pending human decisions.',
  inputSchema: {
    type: 'object',
    required: ['projectId'],
    properties: {
      projectId: {
        type: 'string',
        description: 'Canonical project identifier.',
      },
      discoveryRevision: {
        type: 'integer',
        description: 'Optional source discovery revision number. Defaults to the latest discovery revision.',
      },
      expectedDiscoveryFingerprint: {
        type: 'string',
        description: 'Optional expected discovery fingerprint for cryptographic verification.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
      additionalAssumptions: {
        type: 'array',
        description: 'Optional explicit assumptions to record.',
        items: {
          type: 'object',
          required: ['id', 'statement'],
          properties: {
            id: { type: 'string' },
            statement: { type: 'string' },
            rationale: { type: 'string' },
            validated: { type: 'boolean' },
            affectedRequirements: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

export function createRequirementsScopeDefineTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: requirementsScopeDefineToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = defineInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
      });
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.requirementsScopeEngine)
          ? activeDelegate.requirementsScopeEngine
          : new RequirementsScopeEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result = await engine.derive({
        projectId: parsed.projectId,
        discoveryRevision: parsed.discoveryRevision,
        expectedDiscoveryFingerprint: parsed.expectedDiscoveryFingerprint,
        workspaceRoot: resolvedRoot,
        additionalAssumptions: parsed.additionalAssumptions,
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

// Input schema for GET
const getInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  revision: z.number().int().positive().optional(),
  workspaceRoot: z.string().optional(),
});

export type RequirementsScopeGetInput = z.infer<typeof getInputSchema>;

export const requirementsScopeGetToolDefinition: McpToolDefinition = {
  name: AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
  description:
    'Retrieves authoritative Requirements & Scope specification by project ID and optional revision number (defaults to latest).',
  inputSchema: {
    type: 'object',
    required: ['projectId'],
    properties: {
      projectId: {
        type: 'string',
        description: 'Canonical project identifier.',
      },
      revision: {
        type: 'integer',
        description: 'Optional requirements revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createRequirementsScopeGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: requirementsScopeGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
      });
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.requirementsScopeEngine)
          ? activeDelegate.requirementsScopeEngine
          : new RequirementsScopeEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result =
        parsed.revision !== undefined
          ? await engine.getRevision(parsed.projectId, parsed.revision)
          : await engine.getLatest(parsed.projectId);

      const sanitized = sanitizeMcpPayload(result ?? { error: 'NOT_FOUND', projectId: parsed.projectId });

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
