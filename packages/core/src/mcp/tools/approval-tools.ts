/**
 * Project Approval Gate MCP Tools (Phase 8 TASK-P8-05)
 *
 * Exposes bounded, strictly typed approval gate operations through the MCP boundary:
 * 1. aidm.approval.package.create
 * 2. aidm.approval.package.get
 * 3. aidm.approval.package.readiness
 * 4. aidm.approval.package.approve
 * 5. aidm.approval.package.reject
 *
 * STRICT GOVERNANCE RULES:
 * 1. Read-only discovery input: does not mutate project repository.
 * 2. Does NOT mutate SpecStore (requirements.json or decisions.json) or Task DAG.
 * 3. Does NOT replace global AIDM FSM.
 * 4. Human approval input is untrusted; strictly validated (only human/PO, only explicit intent).
 * 5. Strictly no shell execution, code evaluation, git mutations, or Antigravity invocations.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { ProjectDiscoveryEngine } from '../../discovery/discovery-engine.js';
import type { ProjectDiscoveryReport } from '../../discovery/discovery-types.js';
import { ClarificationStore } from '../../clarification/clarification-store.js';
import { InitialProjectUnderstandingBuilder } from '../../approval/understanding-builder.js';
import { ApprovalPackageEngine } from '../../approval/approval-package-engine.js';
import { ApprovalStore } from '../../approval/approval-store.js';
import {
  APPROVAL_ACTOR_ROLES,
  type ProjectApprovalPackage,
} from '../../approval/approval-types.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME = 'aidm.approval.package.create';
export const AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME = 'aidm.approval.package.get';
export const AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME = 'aidm.approval.package.readiness';
export const AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME = 'aidm.approval.package.approve';
export const AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME = 'aidm.approval.package.reject';

// ============================================================================
// 1. CREATE PACKAGE TOOL
// ============================================================================

const createPackageInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  clarificationSessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  discoveryReport: z.record(z.string(), z.unknown()).optional(),
});

export const approvalPackageCreateToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
  description:
    'Assembles initial project understanding and proposed plan into an immutable, versioned approval package. Evaluates readiness for human approval.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier. Defaults to discovered project name.',
      },
      clarificationSessionId: {
        type: 'string',
        description: 'Optional clarification session ID to associate with the package.',
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata to associate with the package.',
      },
      discoveryReport: {
        type: 'object',
        description: 'Optional pre-computed ProjectDiscoveryReport to avoid re-parsing repository state.',
      },
    },
  },
};

export function createApprovalPackageCreateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: approvalPackageCreateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = createPackageInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      // 1. Discover repository findings or consume pre-computed report
      let discoveryReport: ProjectDiscoveryReport;
      if (parsed.discoveryReport) {
        discoveryReport = parsed.discoveryReport as unknown as ProjectDiscoveryReport;
      } else {
        const discoveryEngine = new ProjectDiscoveryEngine({
          workspaceRoot: resolvedRoot,
          delegate,
        });
        discoveryReport = await discoveryEngine.discover();
      }

      // 2. Load clarification session if specified or active
      const clarifStore =
        delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
      const clarificationSession = parsed.clarificationSessionId
        ? await clarifStore.loadSession(parsed.clarificationSessionId)
        : await clarifStore.getActiveSession();

      // 3. Build understanding
      const builder = new InitialProjectUnderstandingBuilder();
      const understanding = builder.build(discoveryReport, clarificationSession ?? undefined, {
        projectId: parsed.projectId,
      });

      // 4. Build approval package
      const engine = new ApprovalPackageEngine();
      const pkg = engine.buildPackage(understanding, undefined, {
        clarificationSession: clarificationSession ?? undefined,
      });

      // 5. Save package
      const approvalStore =
        delegate?.approvalStore ?? new ApprovalStore({ baseDir: resolvedRoot });
      await approvalStore.savePackage(pkg);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(pkg), null, 2),
          },
        ],
      };
    },
  };
}

// ============================================================================
// 2. GET PACKAGE TOOL
// ============================================================================

const getPackageInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  packageId: z.string().optional(),
  revision: z.number().int().positive().optional(),
});

export const approvalPackageGetToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  description:
    'Retrieves a project approval package by package ID and optional revision, or returns the currently active package if omitted.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      packageId: {
        type: 'string',
        description: 'Optional package ID. When omitted, retrieves the active package.',
      },
      revision: {
        type: 'integer',
        description: 'Optional specific revision number to retrieve.',
      },
    },
  },
};

export function createApprovalPackageGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: approvalPackageGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getPackageInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const approvalStore =
        delegate?.approvalStore ?? new ApprovalStore({ baseDir: resolvedRoot });

      const pkg = parsed.packageId
        ? await approvalStore.loadPackage(parsed.packageId, parsed.revision)
        : await approvalStore.getActivePackage();

      if (!pkg) {
        throw new McpInvalidRequestError(
          `Approval package not found: ${parsed.packageId ?? 'no active package'}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(pkg), null, 2),
          },
        ],
      };
    },
  };
}

// ============================================================================
// 3. READINESS TOOL
// ============================================================================

const readinessInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  packageId: z.string().optional(),
  revision: z.number().int().positive().optional(),
});

export const approvalPackageReadinessToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  description:
    'Evaluates whether an approval package meets all 5 mandatory readiness conditions to be presented for human Product Owner approval.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      packageId: {
        type: 'string',
        description: 'Optional package ID. Defaults to active package.',
      },
      revision: {
        type: 'integer',
        description: 'Optional revision to check readiness for.',
      },
    },
  },
};

export function createApprovalPackageReadinessTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: approvalPackageReadinessToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = readinessInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const approvalStore =
        delegate?.approvalStore ?? new ApprovalStore({ baseDir: resolvedRoot });

      const pkg = parsed.packageId
        ? await approvalStore.loadPackage(parsed.packageId, parsed.revision)
        : await approvalStore.getActivePackage();

      if (!pkg) {
        throw new McpInvalidRequestError(
          `Approval package not found: ${parsed.packageId ?? 'no active package'}`
        );
      }

      const engine = new ApprovalPackageEngine();
      let clarifSession = undefined;
      if (pkg.clarificationSessionReference) {
        const clarifStore =
          delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
        clarifSession = (await clarifStore.loadSession(pkg.clarificationSessionReference)) ?? undefined;
      }

      const readiness = engine.checkReadiness(
        pkg.projectUnderstanding,
        pkg.proposedDevelopmentPlan,
        clarifSession
      );

      const result = {
        packageId: pkg.packageId,
        revision: pkg.revision,
        currentStatus: pkg.status,
        readiness,
        isDevelopmentAuthorized: engine.isDevelopmentAuthorized(pkg),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(result), null, 2),
          },
        ],
      };
    },
  };
}

// ============================================================================
// 4. APPROVE TOOL
// ============================================================================

const approvePackageInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_APPROVAL'),
  comment: z.string().optional(),
});

export const approvalPackageApproveToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
  description:
    'Submits explicit human Product Owner approval for a specific package revision. Validates actor authority, intent, and exact revision binding.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      packageId: {
        type: 'string',
        description: 'The package ID being approved.',
      },
      revision: {
        type: 'integer',
        description: 'The exact package revision number being approved.',
      },
      actor: {
        type: 'string',
        description: 'Identifier of the human Product Owner granting approval.',
      },
      actorRole: {
        type: 'string',
        enum: ['PRODUCT_OWNER', 'USER'],
        description: 'Authoritative human actor role. Must strictly be PRODUCT_OWNER or USER.',
      },
      intent: {
        type: 'string',
        enum: ['EXPLICIT_APPROVAL'],
        description: "Approval intent. Must strictly be 'EXPLICIT_APPROVAL'.",
      },
      comment: {
        type: 'string',
        description: 'Optional approval comment or instruction from Product Owner.',
      },
    },
    required: ['packageId', 'revision', 'actor', 'actorRole', 'intent'],
  },
};

export function createApprovalPackageApproveTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: approvalPackageApproveToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = approvePackageInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const approvalStore =
        delegate?.approvalStore ?? new ApprovalStore({ baseDir: resolvedRoot });

      const pkg = await approvalStore.loadPackage(parsed.packageId);
      if (!pkg) {
        throw new McpInvalidRequestError(`Approval package not found: '${parsed.packageId}'`);
      }

      const engine = new ApprovalPackageEngine();
      const approvedPkg = engine.approvePackage(pkg, {
        packageId: parsed.packageId,
        revision: parsed.revision,
        actor: parsed.actor,
        actorRole: parsed.actorRole,
        intent: parsed.intent,
        comment: parsed.comment,
      });

      await approvalStore.savePackage(approvedPkg);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(approvedPkg), null, 2),
          },
        ],
      };
    },
  };
}

// ============================================================================
// 5. REJECT TOOL
// ============================================================================

const rejectPackageInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  intent: z.literal('EXPLICIT_REJECTION'),
  reason: z.string().optional(),
});

export const approvalPackageRejectToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME,
  description:
    'Submits explicit human Product Owner rejection for a specific package revision. Preserves rejection reason and prevents unauthorized development.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      packageId: {
        type: 'string',
        description: 'The package ID being rejected.',
      },
      revision: {
        type: 'integer',
        description: 'The exact package revision number being rejected.',
      },
      actor: {
        type: 'string',
        description: 'Identifier of the human Product Owner rejecting the package.',
      },
      actorRole: {
        type: 'string',
        enum: ['PRODUCT_OWNER', 'USER'],
        description: 'Authoritative human actor role. Must strictly be PRODUCT_OWNER or USER.',
      },
      intent: {
        type: 'string',
        enum: ['EXPLICIT_REJECTION'],
        description: "Rejection intent. Must strictly be 'EXPLICIT_REJECTION'.",
      },
      reason: {
        type: 'string',
        description: 'Optional rejection reason explaining why understanding/plan was rejected.',
      },
    },
    required: ['packageId', 'revision', 'actor', 'actorRole', 'intent'],
  },
};

export function createApprovalPackageRejectTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: approvalPackageRejectToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = rejectPackageInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const approvalStore =
        delegate?.approvalStore ?? new ApprovalStore({ baseDir: resolvedRoot });

      const pkg = await approvalStore.loadPackage(parsed.packageId);
      if (!pkg) {
        throw new McpInvalidRequestError(`Approval package not found: '${parsed.packageId}'`);
      }

      const engine = new ApprovalPackageEngine();
      const rejectedPkg = engine.rejectPackage(pkg, {
        packageId: parsed.packageId,
        revision: parsed.revision,
        actor: parsed.actor,
        actorRole: parsed.actorRole,
        intent: parsed.intent,
        reason: parsed.reason,
      });

      await approvalStore.savePackage(rejectedPkg);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(rejectedPkg), null, 2),
          },
        ],
      };
    },
  };
}

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerApprovalTools(server: McpServer): void {
  const tools = [
    createApprovalPackageCreateTool(server.delegate),
    createApprovalPackageGetTool(server.delegate),
    createApprovalPackageReadinessTool(server.delegate),
    createApprovalPackageApproveTool(server.delegate),
    createApprovalPackageRejectTool(server.delegate),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
