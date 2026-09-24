/**
 * Director Decision Protocol MCP Tools (Phase 9 TASK-P9-03)
 *
 * Exposes bounded, strictly typed Director decision operations through the MCP boundary:
 * 1. aidm.director.decision.create
 * 2. aidm.director.decision.get
 * 3. aidm.director.decision.validate
 * 4. aidm.director.decision.list
 *
 * STRICT GOVERNANCE RULES:
 * 1. Establishes TYPED DECISION PROTOCOL only.
 * 2. Director decision NEVER grants development authorization (Director Decision != Product Owner Approval).
 * 3. Director decision NEVER conveys implementation authority (Director Decision != Implementation Authorization).
 * 4. Product Owner approval remains the sole source of development authorization.
 * 5. isDevelopmentAuthorized() semantics remain strictly unchanged.
 * 6. Strictly prevents Antigravity (EXECUTOR) and Product Owner (USER) impersonation.
 * 7. Does NOT mutate SpecStore (requirements.json, decisions.json) or Task DAG.
 * 8. Does NOT invoke Antigravity execution or autonomous iteration loops.
 * 9. Strictly sanitizes secrets and redacts tokens/credentials.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { DirectorDecisionEngine } from '../../director/director-decision-engine.js';
import { DirectorSessionStore } from '../../director/director-session-store.js';
import { DirectorDecisionStore } from '../../director/director-decision-store.js';
import {
  DIRECTOR_DECISION_TYPES,
  DirectorDecisionIdZodSchema,
  CreateDirectorDecisionInputZodSchema,
  GetDirectorDecisionInputZodSchema,
  ValidateDirectorDecisionInputZodSchema,
  ListDirectorDecisionsInputZodSchema,
} from '../../director/director-decision-types.js';
import { DirectorSessionError } from '../../director/director-errors.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_DIRECTOR_DECISION_CREATE_TOOL_NAME = 'aidm.director.decision.create';
export const AIDM_DIRECTOR_DECISION_GET_TOOL_NAME = 'aidm.director.decision.get';
export const AIDM_DIRECTOR_DECISION_VALIDATE_TOOL_NAME = 'aidm.director.decision.validate';
export const AIDM_DIRECTOR_DECISION_LIST_TOOL_NAME = 'aidm.director.decision.list';

// Helper to instantiate DirectorDecisionEngine from request context
function getDecisionEngine(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): DirectorDecisionEngine {
  const sessionStore =
    delegate?.directorSessionStore ??
    new DirectorSessionStore({
      baseDir: resolvedRoot,
      historyManager: delegate?.historyManager,
    });
  const decisionStore = new DirectorDecisionStore({
    sessionStore,
    historyManager: delegate?.historyManager,
  });
  return new DirectorDecisionEngine({
    workspaceRoot: resolvedRoot,
    delegate,
    sessionStore,
    decisionStore,
    approvalStore: delegate?.approvalStore,
  });
}

// ============================================================================
// 1. CREATE DECISION TOOL
// ============================================================================

export const directorDecisionCreateToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_DECISION_CREATE_TOOL_NAME,
  description:
    'Records a typed, revision-bound Director decision based on a synchronized context snapshot. Does NOT grant implementation authority or mutate Task DAG / SpecStore.',
  inputSchema: {
    type: 'object',
    required: ['decisionType', 'rationale', 'basedOnContextFingerprint'],
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
        description: 'Optional Director session identifier. Defaults to active Director session.',
      },
      decisionId: {
        type: 'string',
        description: 'Optional explicit decision identifier. Defaults to deterministic generated ID.',
      },
      actor: {
        type: 'string',
        description: "Actor recording decision. Must be 'DIRECTOR'. Cannot be 'USER' or 'EXECUTOR'.",
      },
      decisionType: {
        type: 'string',
        enum: DIRECTOR_DECISION_TYPES as unknown as string[],
        description: 'Typed decision type.',
      },
      rationale: {
        type: 'string',
        description: 'Human-readable explanation and rationale for the decision.',
      },
      basedOnContextFingerprint: {
        type: 'string',
        description: 'Mandatory deterministic fingerprint of the Director Context Snapshot this decision is based on.',
      },
      basedOnApprovalRevision: {
        type: 'number',
        description: 'Optional associated approval revision number.',
      },
      basedOnUnderstandingRevision: {
        type: 'number',
        description: 'Optional associated understanding revision number.',
      },
      metadata: {
        type: 'object',
        description: 'Optional decision metadata. Sensitive credentials and tokens are redacted.',
      },
    },
  },
};

export function createDirectorDecisionCreateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorDecisionCreateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof CreateDirectorDecisionInputZodSchema>;
      try {
        parsed = CreateDirectorDecisionInputZodSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director decision create request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getDecisionEngine(resolvedRoot, delegate);

      try {
        const decision = await engine.createDecision({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(decision), null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof DirectorSessionError) {
          throw new McpInvalidRequestError(err.message, { code: err.code, details: err.details });
        }
        throw err;
      }
    },
  };
}

// ============================================================================
// 2. GET DECISION TOOL
// ============================================================================

export const directorDecisionGetToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_DECISION_GET_TOOL_NAME,
  description:
    'Retrieves a persisted typed Director decision by its unique decision ID. Strictly read-only.',
  inputSchema: {
    type: 'object',
    required: ['decisionId'],
    properties: {
      decisionId: {
        type: 'string',
        description: 'Unique identifier of the decision to retrieve.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional project workspace root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier for binding validation.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Optional session identifier for session binding validation.',
      },
    },
  },
};

export function createDirectorDecisionGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorDecisionGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof GetDirectorDecisionInputZodSchema>;
      try {
        parsed = GetDirectorDecisionInputZodSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director decision get request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getDecisionEngine(resolvedRoot, delegate);

      try {
        const decision = await engine.getDecision(parsed.decisionId, {
          workspaceRoot: resolvedRoot,
          projectId: parsed.projectId,
          directorSessionId: parsed.directorSessionId,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(decision), null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof DirectorSessionError) {
          throw new McpInvalidRequestError(err.message, { code: err.code, details: err.details });
        }
        throw err;
      }
    },
  };
}

// ============================================================================
// 3. VALIDATE DECISION TOOL
// ============================================================================

export const directorDecisionValidateToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_DECISION_VALIDATE_TOOL_NAME,
  description:
    'Dry-run validates a Director decision against current session, context fingerprint, and approval revision without persisting it. Strictly read-only.',
  inputSchema: {
    type: 'object',
    required: ['decisionType', 'rationale', 'basedOnContextFingerprint'],
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
        description: 'Optional Director session identifier. Defaults to active Director session.',
      },
      decisionId: {
        type: 'string',
        description: 'Optional explicit decision identifier to test for collision.',
      },
      actor: {
        type: 'string',
        description: "Actor. Must be 'DIRECTOR'.",
      },
      decisionType: {
        type: 'string',
        enum: DIRECTOR_DECISION_TYPES as unknown as string[],
        description: 'Typed decision type.',
      },
      rationale: {
        type: 'string',
        description: 'Human-readable explanation and rationale for the decision.',
      },
      basedOnContextFingerprint: {
        type: 'string',
        description: 'Deterministic fingerprint of the Director Context Snapshot to validate against.',
      },
      basedOnApprovalRevision: {
        type: 'number',
        description: 'Optional associated approval revision number.',
      },
      basedOnUnderstandingRevision: {
        type: 'number',
        description: 'Optional associated understanding revision number.',
      },
      metadata: {
        type: 'object',
        description: 'Optional decision metadata.',
      },
    },
  },
};

export function createDirectorDecisionValidateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorDecisionValidateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof ValidateDirectorDecisionInputZodSchema>;
      try {
        parsed = ValidateDirectorDecisionInputZodSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director decision validate request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getDecisionEngine(resolvedRoot, delegate);

      try {
        const result = await engine.validateDecision({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(result), null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof DirectorSessionError) {
          throw new McpInvalidRequestError(err.message, { code: err.code, details: err.details });
        }
        throw err;
      }
    },
  };
}

// ============================================================================
// 4. LIST DECISIONS TOOL
// ============================================================================

export const directorDecisionListToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_DECISION_LIST_TOOL_NAME,
  description:
    'Lists persisted typed Director decisions, optionally filtered by session ID or decision type. Strictly read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional project workspace root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier for binding validation.',
      },
      directorSessionId: {
        type: 'string',
        description: 'Optional session identifier filter.',
      },
      decisionType: {
        type: 'string',
        enum: DIRECTOR_DECISION_TYPES as unknown as string[],
        description: 'Optional decision type filter.',
      },
      limit: {
        type: 'number',
        description: 'Optional maximum number of decisions to return (default 50).',
      },
    },
  },
};

export function createDirectorDecisionListTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorDecisionListToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof ListDirectorDecisionsInputZodSchema>;
      try {
        parsed = ListDirectorDecisionsInputZodSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director decision list request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getDecisionEngine(resolvedRoot, delegate);

      try {
        const decisions = await engine.listDecisions({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(decisions), null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof DirectorSessionError) {
          throw new McpInvalidRequestError(err.message, { code: err.code, details: err.details });
        }
        throw err;
      }
    },
  };
}

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerDirectorDecisionTools(server: McpServer): void {
  const tools = [
    createDirectorDecisionCreateTool(server.delegate),
    createDirectorDecisionGetTool(server.delegate),
    createDirectorDecisionValidateTool(server.delegate),
    createDirectorDecisionListTool(server.delegate),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
