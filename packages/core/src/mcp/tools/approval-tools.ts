/**
 * Project Approval Gate MCP Tools (Phase 8 TASK-P8-05 & Phase 15 Product Owner Approval)
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
 * 6. DIRECTOR / SYSTEM / EXECUTOR / ANTIGRAVITY cannot approve or impersonate approval.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError, McpPolicyBlockedError } from '../mcp-errors.js';
import { resolveTargetProjectRoot } from '../project-root-resolver.js';
import { ProjectDiscoveryEngine } from '../../discovery/discovery-engine.js';
import type { ProjectDiscoveryReport } from '../../discovery/discovery-types.js';
import { ClarificationStore } from '../../clarification/clarification-store.js';
import { InitialProjectUnderstandingBuilder } from '../../approval/understanding-builder.js';
import { ApprovalPackageEngine } from '../../approval/approval-package-engine.js';
import { ApprovalStore } from '../../approval/approval-store.js';
import {
  APPROVAL_ACTOR_ROLES,
  FORBIDDEN_APPROVAL_ACTORS,
  type ApprovalPackage,
  type ProjectApprovalPackage,
} from '../../approval/approval-types.js';
import {
  ApprovalAuthorizationError,
  ApprovalInvalidIntentError,
  ApprovalProjectBindingMismatchError,
} from '../../approval/approval-errors.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME = 'aidm.approval.package.create';
export const AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME = 'aidm.approval.package.get';
export const AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME = 'aidm.approval.package.readiness';
export const AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME = 'aidm.approval.package.approve';
export const AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME = 'aidm.approval.package.reject';

function getApprovalEngine(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): ApprovalPackageEngine {
  const isSameRoot = delegate?.projectRoot === resolvedRoot;
  return new ApprovalPackageEngine({
    workspaceRoot: resolvedRoot,
    discoveryStore: (isSameRoot && delegate?.adaptiveDiscoveryStore) ? delegate.adaptiveDiscoveryStore : undefined,
    requirementsStore: (isSameRoot && delegate?.requirementsScopeStore) ? delegate.requirementsScopeStore : undefined,
    architectureStore: (isSameRoot && delegate?.architectureTechnologyStore) ? delegate.architectureTechnologyStore : undefined,
    businessRulesStore: (isSameRoot && delegate?.businessRulesStore) ? delegate.businessRulesStore : undefined,
    acceptanceCriteriaStore: (isSameRoot && delegate?.acceptanceCriteriaStore) ? delegate.acceptanceCriteriaStore : undefined,
    riskStore: (isSameRoot && delegate?.riskHumanDecisionStore) ? delegate.riskHumanDecisionStore : undefined,
    specProjectionStore: (isSameRoot && delegate?.projectSpecStore) ? delegate.projectSpecStore : undefined,
    completenessStore: (isSameRoot && delegate?.completenessGateStore) ? delegate.completenessGateStore : undefined,
    completenessEngine: (isSameRoot && delegate?.completenessGateEngine) ? delegate.completenessGateEngine : undefined,
    approvalStore: (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : undefined,
    historyManager: (isSameRoot && delegate?.historyManager) ? delegate.historyManager : undefined,
    specStore: (isSameRoot && delegate?.specStore) ? delegate.specStore : undefined,
  });
}

// ============================================================================
// 1. CREATE PACKAGE TOOL
// ============================================================================

const createPackageInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  clarificationSessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  discoveryReport: z.record(z.string(), z.unknown()).optional(),
  packageId: z.string().optional(),
  discoveryRevision: z.number().int().positive().optional(),
  requirementsRevision: z.number().int().positive().optional(),
  architectureRevision: z.number().int().positive().optional(),
  businessRulesRevision: z.number().int().positive().optional(),
  acceptanceCriteriaRevision: z.number().int().positive().optional(),
  riskRevision: z.number().int().positive().optional(),
  specRevision: z.number().int().positive().optional(),
});

export const approvalPackageCreateToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
  description:
    'Assembles authoritative project understanding, specifications, and plans into an immutable, revision-bound ApprovalPackage. Evaluates readiness for Product Owner approval.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      projectId: {
        type: 'string',
        description: 'Project identifier to create approval package for.',
      },
      packageId: {
        type: 'string',
        description: 'Optional custom package ID.',
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
      discoveryRevision: {
        type: 'integer',
        description: 'Optional specific discovery revision.',
      },
      requirementsRevision: {
        type: 'integer',
        description: 'Optional specific requirements revision.',
      },
      architectureRevision: {
        type: 'integer',
        description: 'Optional specific architecture revision.',
      },
      businessRulesRevision: {
        type: 'integer',
        description: 'Optional specific business rules revision.',
      },
      acceptanceCriteriaRevision: {
        type: 'integer',
        description: 'Optional specific acceptance criteria revision.',
      },
      riskRevision: {
        type: 'integer',
        description: 'Optional specific risk revision.',
      },
      specRevision: {
        type: 'integer',
        description: 'Optional specific PROJECT_SPEC revision.',
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
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate,
      });
      const engine = getApprovalEngine(resolvedRoot, delegate);

      // Determine if P15 authoritative initiation state is available
      const targetProjectId = parsed.projectId;
      const hasAdaptiveDiscovery = targetProjectId
        ? await engine.discoveryStore.loadRevision(targetProjectId).catch(() => null)
        : null;

      if (targetProjectId && hasAdaptiveDiscovery) {
        // P15 Authoritative Initiation Flow
        const pkg = await engine.createApprovalPackage({
          projectId: targetProjectId,
          packageId: parsed.packageId,
          discoveryRevision: parsed.discoveryRevision,
          requirementsRevision: parsed.requirementsRevision,
          architectureRevision: parsed.architectureRevision,
          businessRulesRevision: parsed.businessRulesRevision,
          acceptanceCriteriaRevision: parsed.acceptanceCriteriaRevision,
          riskRevision: parsed.riskRevision,
          specRevision: parsed.specRevision,
          provenanceCreatedBy: 'MCP_TOOL',
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(pkg), null, 2),
            },
          ],
        };
      }

      // Legacy Phase 8 Flow (Fallback for existing Phase 8 tests)
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

      const clarifStore =
        delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
      const clarificationSession = parsed.clarificationSessionId
        ? await clarifStore.loadSession(parsed.clarificationSessionId)
        : await clarifStore.getActiveSession();

      const builder = new InitialProjectUnderstandingBuilder();
      const understanding = builder.build(discoveryReport, clarificationSession ?? undefined, {
        projectId: parsed.projectId,
      });

      const pkg = engine.buildPackage(understanding, undefined, {
        packageId: parsed.packageId,
        clarificationSession: clarificationSession ?? undefined,
      });

      const isSameRoot = delegate?.projectRoot === resolvedRoot;
      const approvalStore =
        (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : new ApprovalStore({ baseDir: resolvedRoot });
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
  projectId: z.string().optional(),
  packageId: z.string().optional(),
  revision: z.number().int().positive().optional(),
});

export const approvalPackageGetToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  description:
    'Retrieves a project approval package by package ID, project ID, and optional revision. Inspects source revisions, fingerprints, and staleness.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier.',
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
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate,
      });

      const isSameRoot = delegate?.projectRoot === resolvedRoot;
      const approvalStore =
        (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : new ApprovalStore({ baseDir: resolvedRoot });

      let pkg: ApprovalPackage | null = null;
      if (parsed.packageId) {
        pkg = await approvalStore.loadPackage(parsed.packageId, parsed.revision, parsed.projectId);
      } else if (parsed.projectId) {
        pkg = await approvalStore.getLatestPackage(parsed.projectId);
      } else {
        pkg = await approvalStore.getActivePackage();
      }

      if (!pkg) {
        throw new McpInvalidRequestError(
          `Approval package not found: ${parsed.packageId ?? parsed.projectId ?? 'no active package'}`
        );
      }

      // Check staleness if package has source bindings
      if (pkg.sourceBindings) {
        const engine = getApprovalEngine(resolvedRoot, delegate);
        const staleReport = await engine.checkStaleness(pkg);
        pkg = {
          ...pkg,
          isStale: staleReport.isStale,
          staleReport,
        };
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
  projectId: z.string().optional(),
  packageId: z.string().optional(),
  revision: z.number().int().positive().optional(),
});

export const approvalPackageReadinessToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  description:
    'Evaluates whether an approval package meets all conditions (Specification Completeness Gate COMPLETE, zero unresolved human decisions, non-stale authoritative sources, multi-layer integrity) to be presented for human Product Owner approval.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier.',
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
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate,
      });

      const isSameRoot = delegate?.projectRoot === resolvedRoot;
      const approvalStore =
        (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : new ApprovalStore({ baseDir: resolvedRoot });

      let pkg: ApprovalPackage | null = null;
      if (parsed.packageId) {
        pkg = await approvalStore.loadPackage(parsed.packageId, parsed.revision, parsed.projectId);
      } else if (parsed.projectId) {
        pkg = await approvalStore.getLatestPackage(parsed.projectId);
      } else {
        pkg = await approvalStore.getActivePackage();
      }

      if (!pkg) {
        throw new McpInvalidRequestError(
          `Approval package not found: ${parsed.packageId ?? parsed.projectId ?? 'no active package'}`
        );
      }

      const engine = getApprovalEngine(resolvedRoot, delegate);

      let readiness: any;
      if (pkg.sourceBindings) {
        readiness = await engine.checkReadinessAsync(pkg);
      } else {
        let clarifSession = undefined;
        if (pkg.clarificationSessionReference) {
          const clarifStore =
            delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
          clarifSession = (await clarifStore.loadSession(pkg.clarificationSessionReference)) ?? undefined;
        }

        readiness = engine.checkReadiness(
          pkg.projectUnderstanding!,
          pkg.proposedDevelopmentPlan!,
          clarifSession
        );
      }

      const result = {
        packageId: pkg.packageId,
        revision: pkg.revision,
        projectId: pkg.projectId,
        currentStatus: pkg.status,
        readiness,
        isDevelopmentAuthorized: await engine.isDevelopmentAuthorizedAsync(pkg),
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
  projectId: z.string().optional(),
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.string().min(1, 'actorRole is required'),
  intent: z.string().min(1, 'intent is required'),
  comment: z.string().optional(),
  timestamp: z.string().optional(),
});

export const approvalPackageApproveToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
  description:
    'Submits explicit human Product Owner approval for a specific package revision. Validates actor authority (rejects DIRECTOR, SYSTEM, EXECUTOR), intent, exact revision binding, upstream integrity, and readiness.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier.',
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
        description: 'Authoritative human actor role. Must strictly be PRODUCT_OWNER or USER.',
      },
      intent: {
        type: 'string',
        description: "Approval intent. Must strictly be 'EXPLICIT_APPROVAL'.",
      },
      comment: {
        type: 'string',
        description: 'Optional approval comment or instruction from Product Owner.',
      },
      timestamp: {
        type: 'string',
        description: 'Optional ISO timestamp of approval.',
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
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate,
      });

      // Authority policy enforcement: Reject forbidden actors early at the MCP boundary
      const actorRoleNormalized = parsed.actorRole.trim();
      const actorNormalized = parsed.actor.trim().toUpperCase();

      for (const forbidden of FORBIDDEN_APPROVAL_ACTORS) {
        if (actorNormalized === forbidden || actorNormalized.includes(forbidden)) {
          throw new McpPolicyBlockedError(
            `Unauthorized approval actor '${parsed.actor}'. Only human Product Owner (PRODUCT_OWNER / USER) may grant project approval. Forbidden actor '${forbidden}' rejected.`
          );
        }
      }

      if (actorRoleNormalized !== 'PRODUCT_OWNER' && actorRoleNormalized !== 'USER') {
        throw new McpPolicyBlockedError(
          `Invalid actorRole '${parsed.actorRole}'. Only PRODUCT_OWNER or USER may grant approval.`
        );
      }

      if (parsed.intent !== 'EXPLICIT_APPROVAL') {
        throw new McpInvalidRequestError(
          `Invalid approval intent '${parsed.intent}'. Approval must be strictly 'EXPLICIT_APPROVAL'. Natural language signals are rejected.`
        );
      }

      const isSameRoot = delegate?.projectRoot === resolvedRoot;
      const approvalStore =
        (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : new ApprovalStore({ baseDir: resolvedRoot });

      let pkg = await approvalStore.loadPackage(parsed.packageId, undefined, parsed.projectId);
      if (!pkg) {
        pkg = await approvalStore.loadPackage(parsed.packageId, parsed.revision, parsed.projectId);
      }
      if (!pkg) {
        throw new McpInvalidRequestError(`Approval package not found: '${parsed.packageId}'`);
      }

      const engine = getApprovalEngine(resolvedRoot, delegate);
      const approvedPkg = engine.approvePackage(pkg, {
        packageId: parsed.packageId,
        revision: parsed.revision,
        actor: parsed.actor,
        actorRole: parsed.actorRole as any,
        intent: parsed.intent as any,
        comment: parsed.comment,
        timestamp: parsed.timestamp,
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
  projectId: z.string().optional(),
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be a positive integer'),
  actor: z.string().min(1, 'actor is required'),
  actorRole: z.string().min(1, 'actorRole is required'),
  intent: z.string().min(1, 'intent is required'),
  reason: z.string().optional(),
  timestamp: z.string().optional(),
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
      projectId: {
        type: 'string',
        description: 'Optional project identifier.',
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
        description: 'Authoritative human actor role. Must strictly be PRODUCT_OWNER or USER.',
      },
      intent: {
        type: 'string',
        description: "Rejection intent. Must strictly be 'EXPLICIT_REJECTION'.",
      },
      reason: {
        type: 'string',
        description: 'Optional rejection reason explaining why understanding/plan was rejected.',
      },
      timestamp: {
        type: 'string',
        description: 'Optional ISO timestamp of rejection.',
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
      const resolvedRoot = resolveTargetProjectRoot({
        explicitRoot: parsed.workspaceRoot,
        delegate,
      });

      // Authority policy enforcement: Reject forbidden actors early at the MCP boundary
      const actorRoleNormalized = parsed.actorRole.trim();
      const actorNormalized = parsed.actor.trim().toUpperCase();

      for (const forbidden of FORBIDDEN_APPROVAL_ACTORS) {
        if (actorNormalized === forbidden || actorNormalized.includes(forbidden)) {
          throw new McpPolicyBlockedError(
            `Unauthorized rejection actor '${parsed.actor}'. Only human Product Owner (PRODUCT_OWNER / USER) may reject a project approval package. Forbidden actor '${forbidden}' rejected.`
          );
        }
      }

      if (actorRoleNormalized !== 'PRODUCT_OWNER' && actorRoleNormalized !== 'USER') {
        throw new McpPolicyBlockedError(
          `Invalid actorRole '${parsed.actorRole}'. Only PRODUCT_OWNER or USER may reject an approval package.`
        );
      }

      if (parsed.intent !== 'EXPLICIT_REJECTION') {
        throw new McpInvalidRequestError(
          `Invalid rejection intent '${parsed.intent}'. Rejection must be strictly 'EXPLICIT_REJECTION'.`
        );
      }

      const isSameRoot = delegate?.projectRoot === resolvedRoot;
      const approvalStore =
        (isSameRoot && delegate?.approvalStore) ? delegate.approvalStore : new ApprovalStore({ baseDir: resolvedRoot });

      let pkg = await approvalStore.loadPackage(parsed.packageId, undefined, parsed.projectId);
      if (!pkg) {
        pkg = await approvalStore.loadPackage(parsed.packageId, parsed.revision, parsed.projectId);
      }
      if (!pkg) {
        throw new McpInvalidRequestError(`Approval package not found: '${parsed.packageId}'`);
      }

      const engine = getApprovalEngine(resolvedRoot, delegate);
      const rejectedPkg = engine.rejectPackage(pkg, {
        packageId: parsed.packageId,
        revision: parsed.revision,
        actor: parsed.actor,
        actorRole: parsed.actorRole as any,
        intent: parsed.intent as any,
        reason: parsed.reason,
        timestamp: parsed.timestamp,
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
