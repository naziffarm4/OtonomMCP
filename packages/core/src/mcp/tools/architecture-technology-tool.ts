/**
 * aidm.architecture.technology.define & aidm.architecture.technology.get MCP Tools (Phase 15 TASK-P15-04)
 *
 * Exposes authoritative Architecture & Technology definition and inspection through the Director MCP boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly architecture/technology definition & inspection boundary: does not approve anything or create execution intent.
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
import { ArchitectureTechnologyEngine } from '../../discovery/architecture-technology-engine.js';
import { ArchitectureDecisionItemZodSchema } from '../../discovery/architecture-technology-types.js';

export const AIDM_ARCHITECTURE_TECHNOLOGY_DEFINE_TOOL_NAME = 'aidm.architecture.technology.define';
export const AIDM_ARCHITECTURE_TECHNOLOGY_GET_TOOL_NAME = 'aidm.architecture.technology.get';

// Input schema for DEFINE
const defineInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalDecisions: z.array(ArchitectureDecisionItemZodSchema).optional(),
});

export type ArchitectureTechnologyDefineInput = z.infer<typeof defineInputSchema>;

export const architectureTechnologyDefineToolDefinition: McpToolDefinition = {
  name: AIDM_ARCHITECTURE_TECHNOLOGY_DEFINE_TOOL_NAME,
  description:
    'Transforms authoritative Requirements / Scope (P15-03) and Discovery (P15-01) into an explicit, structured, revisioned Architecture / Technology specification for project initiation. Defines architectural style, logical components, data architecture, communication architecture, technology stack, platform constraints, security architecture, integrations, deployment architecture, decision records, and requirement traceability.',
  inputSchema: {
    type: 'object',
    required: ['projectId'],
    properties: {
      projectId: {
        type: 'string',
        description: 'Canonical project identifier.',
      },
      requirementsRevision: {
        type: 'integer',
        description: 'Optional source requirements revision number. Defaults to latest requirements revision.',
      },
      expectedRequirementsFingerprint: {
        type: 'string',
        description: 'Optional expected requirements fingerprint for cryptographic verification.',
      },
      discoveryRevision: {
        type: 'integer',
        description: 'Optional source discovery revision number.',
      },
      expectedDiscoveryFingerprint: {
        type: 'string',
        description: 'Optional expected discovery fingerprint.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
      additionalDecisions: {
        type: 'array',
        description: 'Optional explicit architecture decisions to include.',
        items: {
          type: 'object',
          required: ['decisionId', 'decisionArea', 'question', 'status', 'authority'],
          properties: {
            decisionId: { type: 'string' },
            decisionArea: { type: 'string' },
            question: { type: 'string' },
            status: { type: 'string' },
            selectedOption: { type: 'string' },
            candidateOptions: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' },
            affectedRequirements: { type: 'array', items: { type: 'string' } },
            consequences: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } },
            authority: { type: 'string' },
            revisionBinding: { type: 'integer' },
          },
        },
      },
    },
  },
};

export function createArchitectureTechnologyDefineTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: architectureTechnologyDefineToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = defineInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
        targetProjectId: parsed.projectId,
      });
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.architectureTechnologyEngine)
          ? activeDelegate.architectureTechnologyEngine
          : new ArchitectureTechnologyEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result = await engine.derive({
        projectId: parsed.projectId,
        requirementsRevision: parsed.requirementsRevision,
        expectedRequirementsFingerprint: parsed.expectedRequirementsFingerprint,
        discoveryRevision: parsed.discoveryRevision,
        expectedDiscoveryFingerprint: parsed.expectedDiscoveryFingerprint,
        workspaceRoot: resolvedRoot,
        additionalDecisions: parsed.additionalDecisions,
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

export type ArchitectureTechnologyGetInput = z.infer<typeof getInputSchema>;

export const architectureTechnologyGetToolDefinition: McpToolDefinition = {
  name: AIDM_ARCHITECTURE_TECHNOLOGY_GET_TOOL_NAME,
  description:
    'Retrieves authoritative Architecture / Technology specification by project ID and optional revision number (defaults to latest).',
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
        description: 'Optional architecture revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createArchitectureTechnologyGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: architectureTechnologyGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
        targetProjectId: parsed.projectId,
      });
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.architectureTechnologyEngine)
          ? activeDelegate.architectureTechnologyEngine
          : new ArchitectureTechnologyEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
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
