/**
 * aidm.acceptance-criteria.define & aidm.acceptance-criteria.get MCP Tools (Phase 15 TASK-P15-06)
 *
 * Exposes authoritative Acceptance Criteria definition and inspection through the Director MCP boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly acceptance criteria definition & inspection boundary: does not approve anything or create execution intent.
 * 2. Reuses authoritative components from McpOrchestratorDelegate.
 * 3. Never silently resolves human decision points or manufactures numeric thresholds.
 * 4. Output sanitized via sanitizeMcpPayload.
 * 5. Does NOT invoke Antigravity, create execution requests, or grant development authorization.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { resolveTargetProjectRoot } from '../project-root-resolver.js';
import { AcceptanceCriteriaEngine } from '../../discovery/acceptance-criteria-engine.js';
import {
  AcceptanceCriterionZodSchema,
  AcceptanceCriteriaHumanDecisionZodSchema,
  AcceptanceCriteriaConflictZodSchema,
} from '../../discovery/acceptance-criteria-types.js';
import {
  resolveCanonicalProjectIdentity,
  validateCanonicalProjectId,
} from '../../director/project-identity-resolver.js';

export const AIDM_ACCEPTANCE_CRITERIA_DEFINE_TOOL_NAME = 'aidm.acceptance-criteria.define';
export const AIDM_ACCEPTANCE_CRITERIA_GET_TOOL_NAME = 'aidm.acceptance-criteria.get';

// Input schema for DEFINE
const defineInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty').optional(),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  architectureRevision: z.number().int().positive().optional(),
  expectedArchitectureFingerprint: z.string().optional(),
  businessRulesRevision: z.number().int().positive().optional(),
  expectedBusinessRulesFingerprint: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalCriteria: z.array(AcceptanceCriterionZodSchema).optional(),
  customDecisions: z.array(AcceptanceCriteriaHumanDecisionZodSchema).optional(),
  conflicts: z.array(AcceptanceCriteriaConflictZodSchema).optional(),
  uncoveredExplanations: z.record(z.string(), z.string()).optional(),
});

export type AcceptanceCriteriaDefineInput = z.infer<typeof defineInputSchema>;

export const acceptanceCriteriaDefineToolDefinition: McpToolDefinition = {
  name: AIDM_ACCEPTANCE_CRITERIA_DEFINE_TOOL_NAME,
  description:
    'Transforms authoritative Requirements / Scope (P15-03), Architecture / Technology (P15-04), Business Rules (P15-05), and Discovery (P15-01) into an explicit, structured, revisioned Acceptance Criteria specification for project initiation. Defines observable behaviors, verification methods, human decision boundaries, coverage metrics, and requirement/rule/architecture traceability without implementation tasks or autonomous execution.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier. Defaults to active context or resolved target project root identity.',
      },
      requirementsRevision: {
        type: 'integer',
        description: 'Optional source requirements revision number. Defaults to latest requirements revision.',
      },
      expectedRequirementsFingerprint: {
        type: 'string',
        description: 'Optional expected requirements fingerprint for cryptographic verification.',
      },
      architectureRevision: {
        type: 'integer',
        description: 'Optional source architecture revision number. Defaults to latest architecture revision.',
      },
      expectedArchitectureFingerprint: {
        type: 'string',
        description: 'Optional expected architecture fingerprint for cryptographic verification.',
      },
      businessRulesRevision: {
        type: 'integer',
        description: 'Optional source business rules revision number. Defaults to latest business rules revision.',
      },
      expectedBusinessRulesFingerprint: {
        type: 'string',
        description: 'Optional expected business rules fingerprint.',
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
      additionalCriteria: {
        type: 'array',
        description: 'Optional explicit acceptance criteria to include.',
        items: {
          type: 'object',
          required: [
            'criterionId',
            'title',
            'description',
            'criterionType',
            'statement',
            'priority',
            'status',
            'verificationMethod',
            'expectedResult',
          ],
        },
      },
      customDecisions: {
        type: 'array',
        description: 'Optional explicit human decisions to record.',
        items: {
          type: 'object',
          required: ['decisionId', 'question', 'whyItMatters'],
        },
      },
      conflicts: {
        type: 'array',
        description: 'Optional explicit acceptance criteria conflicts to record.',
        items: {
          type: 'object',
          required: ['conflictId', 'whyItMatters'],
        },
      },
      uncoveredExplanations: {
        type: 'object',
        description: 'Optional map of requirementId to reason why a separate acceptance criterion is not required.',
      },
    },
  },
};

export function createAcceptanceCriteriaDefineTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: acceptanceCriteriaDefineToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = defineInputSchema.parse(args ?? {});
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
        (isSameRoot && activeDelegate?.acceptanceCriteriaEngine)
          ? activeDelegate.acceptanceCriteriaEngine
          : new AcceptanceCriteriaEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
              acceptanceCriteriaStore: (isSameRoot && activeDelegate?.acceptanceCriteriaStore) ? activeDelegate.acceptanceCriteriaStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result = await engine.derive({
        projectId: canonicalProjectId,
        requirementsRevision: parsed.requirementsRevision,
        expectedRequirementsFingerprint: parsed.expectedRequirementsFingerprint,
        architectureRevision: parsed.architectureRevision,
        expectedArchitectureFingerprint: parsed.expectedArchitectureFingerprint,
        businessRulesRevision: parsed.businessRulesRevision,
        expectedBusinessRulesFingerprint: parsed.expectedBusinessRulesFingerprint,
        discoveryRevision: parsed.discoveryRevision,
        expectedDiscoveryFingerprint: parsed.expectedDiscoveryFingerprint,
        workspaceRoot: resolvedRoot,
        additionalCriteria: parsed.additionalCriteria,
        customDecisions: parsed.customDecisions,
        conflicts: parsed.conflicts,
        uncoveredExplanations: parsed.uncoveredExplanations,
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
  projectId: z.string().min(1, 'projectId cannot be empty').optional(),
  revision: z.number().int().positive().optional(),
  workspaceRoot: z.string().optional(),
});

export type AcceptanceCriteriaGetInput = z.infer<typeof getInputSchema>;

export const acceptanceCriteriaGetToolDefinition: McpToolDefinition = {
  name: AIDM_ACCEPTANCE_CRITERIA_GET_TOOL_NAME,
  description:
    'Retrieves authoritative Acceptance Criteria specification by project ID and optional revision number (defaults to latest). Exposes criteria, verification methods, coverage statistics, pending human decisions, and traceability.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier. Defaults to active context or resolved target project root identity.',
      },
      revision: {
        type: 'integer',
        description: 'Optional acceptance criteria revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createAcceptanceCriteriaGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: acceptanceCriteriaGetToolDefinition,
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
        (isSameRoot && activeDelegate?.acceptanceCriteriaEngine)
          ? activeDelegate.acceptanceCriteriaEngine
          : new AcceptanceCriteriaEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
              acceptanceCriteriaStore: (isSameRoot && activeDelegate?.acceptanceCriteriaStore) ? activeDelegate.acceptanceCriteriaStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result =
        parsed.revision !== undefined
          ? await engine.getRevision(canonicalProjectId, parsed.revision)
          : await engine.getLatest(canonicalProjectId);

      const sanitized = sanitizeMcpPayload(result ?? { error: 'NOT_FOUND', projectId: canonicalProjectId });

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
