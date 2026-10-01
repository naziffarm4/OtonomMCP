/**
 * aidm.business-rules.define & aidm.business-rules.get MCP Tools (Phase 15 TASK-P15-05)
 *
 * Exposes authoritative Business Rules definition and inspection through the Director MCP boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly business rules definition & inspection boundary: does not approve anything or create execution intent.
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
import { BusinessRulesEngine } from '../../discovery/business-rules-engine.js';
import {
  BusinessRuleZodSchema,
  BusinessRuleHumanDecisionZodSchema,
  BusinessRuleConflictZodSchema,
} from '../../discovery/business-rules-types.js';
import {
  resolveCanonicalProjectIdentity,
  validateCanonicalProjectId,
} from '../../director/project-identity-resolver.js';

export const AIDM_BUSINESS_RULES_DEFINE_TOOL_NAME = 'aidm.business-rules.define';
export const AIDM_BUSINESS_RULES_GET_TOOL_NAME = 'aidm.business-rules.get';

// Input schema for DEFINE
const defineInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty').optional(),
  requirementsRevision: z.number().int().positive().optional(),
  expectedRequirementsFingerprint: z.string().optional(),
  architectureRevision: z.number().int().positive().optional(),
  expectedArchitectureFingerprint: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  expectedDiscoveryFingerprint: z.string().optional(),
  workspaceRoot: z.string().optional(),
  additionalRules: z.array(BusinessRuleZodSchema).optional(),
  customDecisions: z.array(BusinessRuleHumanDecisionZodSchema).optional(),
  conflicts: z.array(BusinessRuleConflictZodSchema).optional(),
});

export type BusinessRulesDefineInput = z.infer<typeof defineInputSchema>;

export const businessRulesDefineToolDefinition: McpToolDefinition = {
  name: AIDM_BUSINESS_RULES_DEFINE_TOOL_NAME,
  description:
    'Transforms authoritative Requirements / Scope (P15-03), Architecture / Technology (P15-04), and Discovery (P15-01) into an explicit, structured, revisioned Business Rules specification for project initiation. Defines domain invariants, workflow rules, validation rules, authorization rules, state transitions, temporal rules, limits, calculation rules, explicit human decision boundaries, conflict records, and requirement traceability.',
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
      additionalRules: {
        type: 'array',
        description: 'Optional explicit business rules to include.',
        items: {
          type: 'object',
          required: ['ruleId', 'title', 'description', 'category', 'statement', 'priority', 'status'],
          properties: {
            ruleId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
            statement: { type: 'string' },
            priority: { type: 'string' },
            status: { type: 'string' },
            sourceReferences: { type: 'array', items: { type: 'string' } },
            sourceRequirements: { type: 'array', items: { type: 'string' } },
            sourceArchitectureDecisions: { type: 'array', items: { type: 'string' } },
            sourceDiscoveryReferences: { type: 'array', items: { type: 'string' } },
            affectedRequirements: { type: 'array', items: { type: 'string' } },
            affectedArchitectureAreas: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } },
            validationExpectation: { type: 'string' },
          },
        },
      },
      customDecisions: {
        type: 'array',
        description: 'Optional explicit human decisions to record.',
        items: {
          type: 'object',
          required: ['decisionId', 'question', 'whyItMatters'],
          properties: {
            decisionId: { type: 'string' },
            question: { type: 'string' },
            whyItMatters: { type: 'string' },
            affectedRules: { type: 'array', items: { type: 'string' } },
            affectedRequirements: { type: 'array', items: { type: 'string' } },
            availableOptions: { type: 'array', items: { type: 'string' } },
            consequences: { type: 'array', items: { type: 'string' } },
            authority: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      conflicts: {
        type: 'array',
        description: 'Optional explicit business rule conflicts to record.',
        items: {
          type: 'object',
          required: ['conflictId', 'whyItMatters'],
          properties: {
            conflictId: { type: 'string' },
            affectedRules: { type: 'array', items: { type: 'string' } },
            affectedRequirements: { type: 'array', items: { type: 'string' } },
            conflictingStatements: { type: 'array', items: { type: 'string' } },
            sourceReferences: { type: 'array', items: { type: 'string' } },
            whyItMatters: { type: 'string' },
            resolutionStatus: { type: 'string' },
            requiredAuthority: { type: 'string' },
          },
        },
      },
    },
  },
};

export function createBusinessRulesDefineTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: businessRulesDefineToolDefinition,
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
        (isSameRoot && activeDelegate?.businessRulesEngine)
          ? activeDelegate.businessRulesEngine
          : new BusinessRulesEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
              historyManager: (isSameRoot && activeDelegate?.historyManager) ? activeDelegate.historyManager : undefined,
              specStore: (isSameRoot && activeDelegate?.specStore) ? activeDelegate.specStore : undefined,
            });

      const result = await engine.derive({
        projectId: canonicalProjectId,
        requirementsRevision: parsed.requirementsRevision,
        expectedRequirementsFingerprint: parsed.expectedRequirementsFingerprint,
        architectureRevision: parsed.architectureRevision,
        expectedArchitectureFingerprint: parsed.expectedArchitectureFingerprint,
        discoveryRevision: parsed.discoveryRevision,
        expectedDiscoveryFingerprint: parsed.expectedDiscoveryFingerprint,
        workspaceRoot: resolvedRoot,
        additionalRules: parsed.additionalRules,
        customDecisions: parsed.customDecisions,
        conflicts: parsed.conflicts,
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

export type BusinessRulesGetInput = z.infer<typeof getInputSchema>;

export const businessRulesGetToolDefinition: McpToolDefinition = {
  name: AIDM_BUSINESS_RULES_GET_TOOL_NAME,
  description:
    'Retrieves authoritative Business Rules specification by project ID and optional revision number (defaults to latest). Exposes confirmed, proposed, and pending business rules, human decisions, and conflicts.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional canonical project identifier. Defaults to active context or resolved target project root identity.',
      },
      revision: {
        type: 'integer',
        description: 'Optional business rules revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createBusinessRulesGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: businessRulesGetToolDefinition,
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
        (isSameRoot && activeDelegate?.businessRulesEngine)
          ? activeDelegate.businessRulesEngine
          : new BusinessRulesEngine({
              workspaceRoot: resolvedRoot,
              discoveryStore: (isSameRoot && activeDelegate?.adaptiveDiscoveryStore) ? activeDelegate.adaptiveDiscoveryStore : undefined,
              completenessStore: (isSameRoot && activeDelegate?.completenessGateStore) ? activeDelegate.completenessGateStore : undefined,
              requirementsStore: (isSameRoot && activeDelegate?.requirementsScopeStore) ? activeDelegate.requirementsScopeStore : undefined,
              architectureStore: (isSameRoot && activeDelegate?.architectureTechnologyStore) ? activeDelegate.architectureTechnologyStore : undefined,
              businessRulesStore: (isSameRoot && activeDelegate?.businessRulesStore) ? activeDelegate.businessRulesStore : undefined,
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
