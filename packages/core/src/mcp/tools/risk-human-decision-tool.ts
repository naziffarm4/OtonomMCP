/**
 * aidm.risks.define, aidm.risks.get & aidm.human-decisions.get MCP Tools (Phase 15 TASK-P15-07)
 *
 * Exposes authoritative Risk & Human Decision Point definition and inspection through the Director MCP boundary.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly risk definition & inspection boundary: does not approve anything or create execution intent.
 * 2. Reuses authoritative components from McpOrchestratorDelegate.
 * 3. Never silently resolves human decision points.
 * 4. Output sanitized via sanitizeMcpPayload.
 * 5. Does NOT invoke Antigravity, create execution requests, or grant development authorization.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import { sanitizeMcpPayload } from '../mcp-errors.js';
import { RiskHumanDecisionEngine } from '../../discovery/risk-human-decision-engine.js';
import {
  ProjectRiskZodSchema,
  HumanDecisionPointZodSchema,
} from '../../discovery/risk-human-decision-types.js';
import type { McpServer } from '../mcp-server.js';

export const AIDM_RISKS_DEFINE_TOOL_NAME = 'aidm.risks.define';
export const AIDM_RISKS_GET_TOOL_NAME = 'aidm.risks.get';
export const AIDM_HUMAN_DECISIONS_GET_TOOL_NAME = 'aidm.human-decisions.get';

// Input schema for DEFINE
const defineInputSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
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
  workspaceRoot: z.string().optional(),
  additionalRisks: z.array(ProjectRiskZodSchema).optional(),
  customDecisions: z.array(HumanDecisionPointZodSchema).optional(),
});

export type RisksDefineInput = z.infer<typeof defineInputSchema>;

export const risksDefineToolDefinition: McpToolDefinition = {
  name: AIDM_RISKS_DEFINE_TOOL_NAME,
  description:
    'Transforms authoritative Discovery (P15-01), Requirements (P15-03), Architecture (P15-04), Business Rules (P15-05), and Acceptance Criteria (P15-06) into an explicit, revisioned project Risk and Human Decision Point specification for project initiation. Models risks, severity, probability, impact, response, traceability, and Product Owner decisions without implementation execution.',
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
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
      additionalRisks: {
        type: 'array',
        description: 'Optional explicit project risks to include.',
        items: {
          type: 'object',
        },
      },
      customDecisions: {
        type: 'array',
        description: 'Optional explicit human decision points for Product Owner.',
        items: {
          type: 'object',
        },
      },
    },
  },
};

export function createRisksDefineTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: risksDefineToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = defineInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? activeDelegate?.projectRoot ?? process.cwd();

      const engine =
        activeDelegate?.riskHumanDecisionEngine ??
        new RiskHumanDecisionEngine({
          workspaceRoot: resolvedRoot,
          discoveryStore: activeDelegate?.adaptiveDiscoveryStore,
          requirementsStore: activeDelegate?.requirementsScopeStore,
          architectureStore: activeDelegate?.architectureTechnologyStore,
          businessRulesStore: activeDelegate?.businessRulesStore,
          acceptanceCriteriaStore: activeDelegate?.acceptanceCriteriaStore,
          riskStore: activeDelegate?.riskHumanDecisionStore,
          historyManager: activeDelegate?.historyManager,
          specStore: activeDelegate?.specStore,
        });

      const result = await engine.derive({
        projectId: parsed.projectId,
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
        workspaceRoot: resolvedRoot,
        additionalRisks: parsed.additionalRisks,
        customDecisions: parsed.customDecisions,
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

export type RisksGetInput = z.infer<typeof getInputSchema>;

export const risksGetToolDefinition: McpToolDefinition = {
  name: AIDM_RISKS_GET_TOOL_NAME,
  description:
    'Retrieves authoritative Project Risks specification by project ID and optional revision number (defaults to latest). Exposes risks, severity, probability, impact, response, coverage statistics, and traceability.',
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
        description: 'Optional risk revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createRisksGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: risksGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? activeDelegate?.projectRoot ?? process.cwd();

      const engine =
        activeDelegate?.riskHumanDecisionEngine ??
        new RiskHumanDecisionEngine({
          workspaceRoot: resolvedRoot,
          discoveryStore: activeDelegate?.adaptiveDiscoveryStore,
          requirementsStore: activeDelegate?.requirementsScopeStore,
          architectureStore: activeDelegate?.architectureTechnologyStore,
          businessRulesStore: activeDelegate?.businessRulesStore,
          acceptanceCriteriaStore: activeDelegate?.acceptanceCriteriaStore,
          riskStore: activeDelegate?.riskHumanDecisionStore,
          historyManager: activeDelegate?.historyManager,
          specStore: activeDelegate?.specStore,
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

export const humanDecisionsGetToolDefinition: McpToolDefinition = {
  name: AIDM_HUMAN_DECISIONS_GET_TOOL_NAME,
  description:
    'Retrieves authoritative Human Decision Points requiring Product Owner input prior to project approval. Strictly read-only inspection.',
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
        description: 'Optional risk revision number. Defaults to latest revision.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project workspace root.',
      },
    },
  },
};

export function createHumanDecisionsGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: humanDecisionsGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getInputSchema.parse(args ?? {});
      const activeDelegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? activeDelegate?.projectRoot ?? process.cwd();

      const engine =
        activeDelegate?.riskHumanDecisionEngine ??
        new RiskHumanDecisionEngine({
          workspaceRoot: resolvedRoot,
          discoveryStore: activeDelegate?.adaptiveDiscoveryStore,
          requirementsStore: activeDelegate?.requirementsScopeStore,
          architectureStore: activeDelegate?.architectureTechnologyStore,
          businessRulesStore: activeDelegate?.businessRulesStore,
          acceptanceCriteriaStore: activeDelegate?.acceptanceCriteriaStore,
          riskStore: activeDelegate?.riskHumanDecisionStore,
          historyManager: activeDelegate?.historyManager,
          specStore: activeDelegate?.specStore,
        });

      const result =
        parsed.revision !== undefined
          ? await engine.getRevision(parsed.projectId, parsed.revision)
          : await engine.getLatest(parsed.projectId);

      const output = result
        ? {
            projectId: result.projectId,
            riskRevision: result.riskRevision,
            isStale: result.isStale,
            humanDecisionPoints: result.humanDecisionPoints,
            humanDecisionCoverage: result.humanDecisionCoverage,
            sourceRevisions: {
              discoveryRevision: result.sourceDiscoveryRevision,
              requirementsRevision: result.sourceRequirementsRevision,
              architectureRevision: result.sourceArchitectureRevision,
              businessRulesRevision: result.sourceBusinessRulesRevision,
              acceptanceCriteriaRevision: result.sourceAcceptanceCriteriaRevision,
            },
          }
        : { error: 'NOT_FOUND', projectId: parsed.projectId };

      const sanitized = sanitizeMcpPayload(output);

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
 * Registers risk & human decision MCP tools onto an McpServer instance.
 */
export function registerRiskHumanDecisionTools(server: McpServer): void {
  const defineTool = createRisksDefineTool(server.delegate);
  const getTool = createRisksGetTool(server.delegate);
  const hdpTool = createHumanDecisionsGetTool(server.delegate);

  server.registerTool(defineTool.definition, defineTool.handler);
  server.registerTool(getTool.definition, getTool.handler);
  server.registerTool(hdpTool.definition, hdpTool.handler);
}
