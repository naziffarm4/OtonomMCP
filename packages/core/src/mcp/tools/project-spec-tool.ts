/**
 * aidm.project-spec.generate, aidm.project-spec.get, and aidm.project-spec.stale MCP Tools
 *
 * Exposes authoritative PROJECT_SPEC projection generation, retrieval, and staleness detection
 * through the Director MCP boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. PROJECT_SPEC is strictly a projection, NEVER a second source of truth.
 * 2. Connects to existing authoritative stores without inventing or duplicating state.
 * 3. Does NOT approve the project, authorize development, create ExecutionIntent/Request, or invoke Antigravity.
 * 4. Human Decision Points are preserved exactly without autonomous resolution.
 * 5. Sanitizes output via sanitizeMcpPayload.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { resolveTargetProjectRoot } from '../project-root-resolver.js';
import { ProjectSpecEngine } from '../../discovery/project-spec-engine.js';
import {
  resolveCanonicalProjectIdentity,
  validateCanonicalProjectId,
} from '../../director/project-identity-resolver.js';
import type { McpServer } from '../mcp-server.js';

export const AIDM_PROJECT_SPEC_GENERATE_TOOL_NAME = 'aidm.project-spec.generate';
export const AIDM_PROJECT_SPEC_GET_TOOL_NAME = 'aidm.project-spec.get';
export const AIDM_PROJECT_SPEC_STALE_TOOL_NAME = 'aidm.project-spec.stale';

// --- Input schema for GENERATE ---
const generateInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty').optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  architectureRevision: z.number().int().positive().optional(),
  expectedArchitectureFingerprint: z.string().optional(),
  businessRulesRevision: z.number().int().positive().optional(),
  expectedBusinessRulesFingerprint: z.string().optional(),
  acceptanceCriteriaRevision: z.number().int().positive().optional(),
  expectedAcceptanceCriteriaFingerprint: z.string().optional(),
  riskRevision: z.number().int().positive().optional(),
  expectedRiskFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
});

export type ProjectSpecGenerateInput = z.infer<typeof generateInputSchema>;

export const projectSpecGenerateToolDefinition: McpToolDefinition = {
  name: AIDM_PROJECT_SPEC_GENERATE_TOOL_NAME,
  description:
    'Deterministically projects authoritative Discovery (P15-01), Requirements (P15-03), Architecture (P15-04), Business Rules (P15-05), Acceptance Criteria (P15-06), and Risks / Human Decisions (P15-07) into a unified, human-readable PROJECT_SPEC.md specification document and revisioned projection artifact. Not a second source of truth.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier. Defaults to active context or resolved target project root identity.',
      },
      discoveryRevision: {
        type: 'integer',
        description: 'Optional source discovery revision number.',
      },
      expectedDiscoveryFingerprint: {
        type: 'string',
        description: 'Optional expected discovery fingerprint.',
      },
      requirementsRevision: {
        type: 'integer',
        description: 'Optional source requirements revision number.',
      },
      expectedRequirementsFingerprint: {
        type: 'string',
        description: 'Optional expected requirements fingerprint.',
      },
      architectureRevision: {
        type: 'integer',
        description: 'Optional source architecture revision number.',
      },
      expectedArchitectureFingerprint: {
        type: 'string',
        description: 'Optional expected architecture fingerprint.',
      },
      businessRulesRevision: {
        type: 'integer',
        description: 'Optional source business rules revision number.',
      },
      expectedBusinessRulesFingerprint: {
        type: 'string',
        description: 'Optional expected business rules fingerprint.',
      },
      acceptanceCriteriaRevision: {
        type: 'integer',
        description: 'Optional source acceptance criteria revision number.',
      },
      expectedAcceptanceCriteriaFingerprint: {
        type: 'string',
        description: 'Optional expected acceptance criteria fingerprint.',
      },
      riskRevision: {
        type: 'integer',
        description: 'Optional source risk revision number.',
      },
      expectedRiskFingerprint: {
        type: 'string',
        description: 'Optional expected risk fingerprint.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createProjectSpecGenerateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: projectSpecGenerateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = generateInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
        targetProjectId: parsed.projectId,
      });
      const canonicalProjectId =
        parsed.projectId ??
        activeDelegate?.activeContext?.projectId ??
        resolveCanonicalProjectIdentity(resolvedRoot).projectId;
      validateCanonicalProjectId(canonicalProjectId);
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.projectSpecEngine)
          ? activeDelegate.projectSpecEngine
          : new ProjectSpecEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
              acceptanceCriteriaStore: (isSameRoot && activeDelegate?.acceptanceCriteriaStore) ? activeDelegate.acceptanceCriteriaStore : undefined,
              riskStore: (isSameRoot && activeDelegate?.riskHumanDecisionStore) ? activeDelegate.riskHumanDecisionStore : undefined,
              specProjectionStore: (isSameRoot && activeDelegate?.projectSpecStore) ? activeDelegate.projectSpecStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result = await engine.generate({
        projectId: canonicalProjectId,
        discoveryRevision: parsed.discoveryRevision,
        expectedDiscoveryFingerprint: parsed.expectedDiscoveryFingerprint,
        requirementsRevision: parsed.requirementsRevision,
        expectedRequirementsFingerprint: parsed.expectedRequirementsFingerprint,
        architectureRevision: parsed.architectureRevision,
        expectedArchitectureFingerprint: parsed.expectedArchitectureFingerprint,
        businessRulesRevision: parsed.businessRulesRevision,
        expectedBusinessRulesFingerprint: parsed.expectedBusinessRulesFingerprint,
        acceptanceCriteriaRevision: parsed.acceptanceCriteriaRevision,
        expectedAcceptanceCriteriaFingerprint: parsed.expectedAcceptanceCriteriaFingerprint,
        riskRevision: parsed.riskRevision,
        expectedRiskFingerprint: parsed.expectedRiskFingerprint,
        workspaceRoot: resolvedRoot,
      });

      const responsePayload = {
        projectId: result.projectId,
        specRevision: result.specRevision,
        semanticFingerprint: result.semanticFingerprint,
        sourceBindings: result.sourceBindings,
        isStale: result.isStale,
        specPath: engine.specProjectionStore.getSpecPath(result.projectId, result.specRevision),
        markdownPath: engine.specProjectionStore.getMarkdownPath(
          result.projectId,
          result.specRevision
        ),
        markdownContentPreview: result.markdownContent.substring(0, 1000) + '...',
      };

      const sanitized = sanitizeMcpPayload(responsePayload);

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

// --- Input schema for GET & STALE ---
const getInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty').optional(),
  revision: z.number().int().positive().optional(),
  workspaceRoot: z.string().optional(),
});

export type ProjectSpecGetInput = z.infer<typeof getInputSchema>;

export const projectSpecGetToolDefinition: McpToolDefinition = {
  name: AIDM_PROJECT_SPEC_GET_TOOL_NAME,
  description:
    'Retrieves authoritative PROJECT_SPEC projection by project ID and optional revision number (defaults to latest). Exposes structured content, markdown, source bindings, semantic fingerprint, and staleness report.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier. Defaults to active context or resolved target project root identity.',
      },
      revision: {
        type: 'integer',
        description: 'Optional spec revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createProjectSpecGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: projectSpecGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
        targetProjectId: parsed.projectId,
      });
      const canonicalProjectId =
        parsed.projectId ??
        activeDelegate?.activeContext?.projectId ??
        resolveCanonicalProjectIdentity(resolvedRoot).projectId;
      validateCanonicalProjectId(canonicalProjectId);
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.projectSpecEngine)
          ? activeDelegate.projectSpecEngine
          : new ProjectSpecEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
              acceptanceCriteriaStore: (isSameRoot && activeDelegate?.acceptanceCriteriaStore) ? activeDelegate.acceptanceCriteriaStore : undefined,
              riskStore: (isSameRoot && activeDelegate?.riskHumanDecisionStore) ? activeDelegate.riskHumanDecisionStore : undefined,
              specProjectionStore: (isSameRoot && activeDelegate?.projectSpecStore) ? activeDelegate.projectSpecStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result =
        parsed.revision !== undefined
          ? await engine.getRevision(canonicalProjectId, parsed.revision)
          : await engine.getLatest(canonicalProjectId);

      const sanitized = sanitizeMcpPayload(
        result ?? { error: 'NOT_FOUND', projectId: canonicalProjectId }
      );

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

export const projectSpecStaleToolDefinition: McpToolDefinition = {
  name: AIDM_PROJECT_SPEC_STALE_TOOL_NAME,
  description:
    'Detects and reports whether a PROJECT_SPEC projection is stale relative to the latest revisions in the authoritative upstream stores (Discovery, Requirements, Architecture, Business Rules, Acceptance Criteria, Risks).',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier. Defaults to active context or resolved target project root identity.',
      },
      revision: {
        type: 'integer',
        description: 'Optional spec revision number to evaluate. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createProjectSpecStaleTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: projectSpecStaleToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate: activeDelegate,
        targetProjectId: parsed.projectId,
      });
      const canonicalProjectId =
        parsed.projectId ??
        activeDelegate?.activeContext?.projectId ??
        resolveCanonicalProjectIdentity(resolvedRoot).projectId;
      validateCanonicalProjectId(canonicalProjectId);
      const isSameRoot = activeDelegate?.projectRoot === resolvedRoot;

      const engine =
        (isSameRoot && activeDelegate?.projectSpecEngine)
          ? activeDelegate.projectSpecEngine
          : new ProjectSpecEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
              acceptanceCriteriaStore: (isSameRoot && activeDelegate?.acceptanceCriteriaStore) ? activeDelegate.acceptanceCriteriaStore : undefined,
              riskStore: (isSameRoot && activeDelegate?.riskHumanDecisionStore) ? activeDelegate.riskHumanDecisionStore : undefined,
              specProjectionStore: (isSameRoot && activeDelegate?.projectSpecStore) ? activeDelegate.projectSpecStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result = await engine.detectStale(canonicalProjectId, parsed.revision);
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

/**
 * Registers PROJECT_SPEC MCP tools onto an McpServer instance.
 */
export function registerProjectSpecTools(server: McpServer): void {
  const generateTool = createProjectSpecGenerateTool(server.delegate);
  const getTool = createProjectSpecGetTool(server.delegate);
  const staleTool = createProjectSpecStaleTool(server.delegate);

  server.registerTool(generateTool.definition, generateTool.handler);
  server.registerTool(getTool.definition, getTool.handler);
  server.registerTool(staleTool.definition, staleTool.handler);
}
