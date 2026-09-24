/**
 * Human Approval & Resume Protocol MCP Tools (Phase 9 TASK-P9-04)
 *
 * Exposes bounded, strictly typed Human Approval and Resume Protocol operations
 * through the MCP boundary:
 * 1. aidm.approval.human.submit
 * 2. aidm.approval.human.validate
 * 3. aidm.approval.resume.evaluate
 *
 * STRICT GOVERNANCE RULES:
 * 1. Human/Product Owner approval is strictly separated from Director session identity.
 * 2. Director (DIRECTOR) CANNOT grant approval; executor (EXECUTOR) / antigravity CANNOT approve.
 * 3. Natural-language "tamam", clarification answers, or Director decisions (including RESUME) are NOT approval.
 * 4. Approval is strictly bound to canonical project, active session, context fingerprint, and package revision.
 * 5. Rejects stale or incomplete context.
 * 6. Replay protection against duplicate approval.
 * 7. isDevelopmentAuthorized() remains authoritative; no second authority.
 * 8. Does NOT mutate Task DAG, invoke Antigravity, or start autonomous loops.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { HumanApprovalEngine } from '../../director/human-approval-engine.js';
import {
  SubmitHumanApprovalInputZodSchema,
  ValidateHumanApprovalInputZodSchema,
  EvaluateResumeInputZodSchema,
} from '../../director/human-approval-types.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_APPROVAL_HUMAN_SUBMIT_TOOL_NAME = 'aidm.approval.human.submit';
export const AIDM_APPROVAL_HUMAN_VALIDATE_TOOL_NAME = 'aidm.approval.human.validate';
export const AIDM_APPROVAL_RESUME_EVALUATE_TOOL_NAME = 'aidm.approval.resume.evaluate';

function getApprovalEngine(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): HumanApprovalEngine {
  return new HumanApprovalEngine({
    workspaceRoot: resolvedRoot,
    delegate,
  });
}

// ============================================================================
// 1. SUBMIT HUMAN APPROVAL TOOL
// ============================================================================

export const humanApprovalSubmitToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_HUMAN_SUBMIT_TOOL_NAME,
  description:
    'Submits explicit human Product Owner approval bound to a Director session, context fingerprint, and exact package revision. Grants implementation authorization without mutating Task DAG or invoking Antigravity.',
  inputSchema: {
    type: 'object',
    required: [
      'directorSessionId',
      'packageId',
      'revision',
      'contextFingerprint',
      'actor',
      'actorRole',
      'intent',
    ],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root. Defaults to configured delegate project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier. Must match canonical project identity if provided.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Active Director session ID to bind this approval to.',
      },
      packageId: {
        type: 'string',
        description: 'The approval package ID being approved.',
      },
      revision: {
        type: 'integer',
        description: 'The exact package revision number being approved.',
      },
      contextFingerprint: {
        type: 'string',
        description: 'The logical fingerprint of the non-stale, complete Director Context Snapshot.',
      },
      understandingRevision: {
        type: 'integer',
        description: 'Optional understanding revision number matching the session state.',
      },
      actor: {
        type: 'string',
        description: 'Identifier of the human Product Owner granting approval. Director cannot approve.',
      },
      actorRole: {
        type: 'string',
        enum: ['PRODUCT_OWNER', 'USER'],
        description: "Authoritative human actor role. Must strictly be 'PRODUCT_OWNER' or 'USER'.",
      },
      intent: {
        type: 'string',
        enum: ['EXPLICIT_APPROVAL'],
        description: "Approval intent. Must strictly be 'EXPLICIT_APPROVAL'. Natural language is not accepted.",
      },
      comment: {
        type: 'string',
        description: 'Optional approval comment or instruction from Product Owner.',
      },
      timestamp: {
        type: 'string',
        description: 'Optional ISO 8601 timestamp for the approval record.',
      },
    },
  },
};

export function createHumanApprovalSubmitTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: humanApprovalSubmitToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = SubmitHumanApprovalInputZodSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for '${AIDM_APPROVAL_HUMAN_SUBMIT_TOOL_NAME}': ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.data.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getApprovalEngine(resolvedRoot, delegate);

      const result = await engine.submitApproval(parsed.data);

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
// 2. VALIDATE HUMAN APPROVAL TOOL
// ============================================================================

export const humanApprovalValidateToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_HUMAN_VALIDATE_TOOL_NAME,
  description:
    'Dry-run validation of a human Product Owner approval input against session state, context snapshot freshness, and package revision binding without committing changes.',
  inputSchema: {
    type: 'object',
    required: [
      'directorSessionId',
      'packageId',
      'revision',
      'contextFingerprint',
      'actor',
      'actorRole',
      'intent',
    ],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Active Director session ID.',
      },
      packageId: {
        type: 'string',
        description: 'Approval package ID.',
      },
      revision: {
        type: 'integer',
        description: 'Approval package revision.',
      },
      contextFingerprint: {
        type: 'string',
        description: 'Director context snapshot fingerprint.',
      },
      understandingRevision: {
        type: 'integer',
        description: 'Optional understanding revision.',
      },
      actor: {
        type: 'string',
        description: 'Human Product Owner actor identifier.',
      },
      actorRole: {
        type: 'string',
        enum: ['PRODUCT_OWNER', 'USER'],
        description: 'Authoritative human actor role.',
      },
      intent: {
        type: 'string',
        enum: ['EXPLICIT_APPROVAL'],
        description: "Must strictly be 'EXPLICIT_APPROVAL'.",
      },
      comment: {
        type: 'string',
        description: 'Optional comment.',
      },
    },
  },
};

export function createHumanApprovalValidateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: humanApprovalValidateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = ValidateHumanApprovalInputZodSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for '${AIDM_APPROVAL_HUMAN_VALIDATE_TOOL_NAME}': ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.data.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getApprovalEngine(resolvedRoot, delegate);

      const result = await engine.validateApproval(parsed.data);

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
// 3. EVALUATE RESUME TOOL
// ============================================================================

export const approvalResumeEvaluateToolDefinition: McpToolDefinition = {
  name: AIDM_APPROVAL_RESUME_EVALUATE_TOOL_NAME,
  description:
    'Evaluates whether development resume is authorized under explicit human Product Owner approval. Verifies that Director decisions alone cannot grant resume authorization.',
  inputSchema: {
    type: 'object',
    required: ['directorSessionId'],
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Active Director session ID.',
      },
      packageId: {
        type: 'string',
        description: 'Optional package ID. Defaults to active approval package.',
      },
      revision: {
        type: 'integer',
        description: 'Optional revision number.',
      },
      directorDecisionId: {
        type: 'string',
        description: 'Optional Director decision ID (e.g. RESUME decision) to verify.',
      },
    },
  },
};

export function createApprovalResumeEvaluateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: approvalResumeEvaluateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = EvaluateResumeInputZodSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new McpInvalidRequestError(
          `Invalid arguments for '${AIDM_APPROVAL_RESUME_EVALUATE_TOOL_NAME}': ${parsed.error.issues[0]?.message ?? 'validation failed'}`
        );
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.data.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getApprovalEngine(resolvedRoot, delegate);

      const result = await engine.evaluateResume(parsed.data);

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
// REGISTRATION
// ============================================================================

export function registerHumanApprovalTools(server: McpServer): void {
  const tools = [
    createHumanApprovalSubmitTool(server.delegate),
    createHumanApprovalValidateTool(server.delegate),
    createApprovalResumeEvaluateTool(server.delegate),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
