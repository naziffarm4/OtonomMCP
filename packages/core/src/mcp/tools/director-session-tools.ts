/**
 * Director Session Identity MCP Tools (Phase 9 TASK-P9-01)
 *
 * Exposes bounded, strictly typed Director session identity operations through the MCP boundary:
 * 1. aidm.director.session.create
 * 2. aidm.director.session.get
 * 3. aidm.director.session.suspend
 * 4. aidm.director.session.close
 * 5. aidm.director.session.resume
 *
 * STRICT GOVERNANCE RULES:
 * 1. Establishes Director SESSION IDENTITY and authority context only.
 * 2. Director session NEVER grants implementation authority.
 * 3. Product Owner approval remains the sole source of development authorization.
 * 4. Strictly prevents Antigravity (EXECUTOR) and Product Owner (USER) impersonation.
 * 5. Does NOT mutate SpecStore (requirements.json, decisions.json) or Task DAG.
 * 6. Does NOT invoke Antigravity execution or autonomous iteration loops.
 * 7. Strictly sanitizes secrets and redacts tokens/credentials.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { DirectorSessionStore } from '../../director/director-session-store.js';
import { DirectorSessionEngine } from '../../director/director-session-engine.js';
import {
  DirectorSessionIdZodSchema,
  DIRECTOR_ACTOR_ROLES,
} from '../../director/director-types.js';
import { DirectorSessionError } from '../../director/director-errors.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME = 'aidm.director.session.create';
export const AIDM_DIRECTOR_SESSION_GET_TOOL_NAME = 'aidm.director.session.get';
export const AIDM_DIRECTOR_SESSION_SUSPEND_TOOL_NAME = 'aidm.director.session.suspend';
export const AIDM_DIRECTOR_SESSION_CLOSE_TOOL_NAME = 'aidm.director.session.close';
export const AIDM_DIRECTOR_SESSION_RESUME_TOOL_NAME = 'aidm.director.session.resume';

// Helper to instantiate DirectorSessionEngine from request context
function getSessionEngine(
  resolvedRoot: string,
  delegate?: McpOrchestratorDelegate
): DirectorSessionEngine {
  const store =
    delegate?.directorSessionStore ??
    new DirectorSessionStore({
      baseDir: resolvedRoot,
      historyManager: delegate?.historyManager,
    });
  return new DirectorSessionEngine({
    store,
    workspaceRoot: resolvedRoot,
  });
}

// ============================================================================
// 1. CREATE SESSION TOOL
// ============================================================================

const createSessionInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  actor: z.string().optional(),
  actorRole: z.enum(DIRECTOR_ACTOR_ROLES).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  approvalPackageId: z.string().nullable().optional(),
  approvalRevision: z.number().int().nonnegative().nullable().optional(),
  understandingRevision: z.number().int().nonnegative().nullable().optional(),
});

export const directorSessionCreateToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
  description:
    'Establishes a durable, explicit Director session identity bound to the project context. Does NOT grant implementation authority.',
  inputSchema: {
    type: 'object',
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
        description: 'Optional explicit session identifier. Defaults to deterministic generated ID.',
      },
      actor: {
        type: 'string',
        description: "Actor establishing session. Must be 'DIRECTOR'. Cannot be 'USER' or 'EXECUTOR'.",
      },
      actorRole: {
        type: 'string',
        enum: ['DIRECTOR', 'PROJECT_DIRECTOR'],
        description: 'Optional actor role.',
      },
      metadata: {
        type: 'object',
        description: 'Optional session metadata. Sensitive credentials and tokens are redacted.',
      },
      approvalPackageId: {
        type: 'string',
        description: 'Optional associated approval package identifier.',
      },
      approvalRevision: {
        type: 'number',
        description: 'Optional associated approval revision number.',
      },
      understandingRevision: {
        type: 'number',
        description: 'Optional associated understanding revision number.',
      },
    },
  },
};

export function createDirectorSessionCreateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorSessionCreateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof createSessionInputSchema>;
      try {
        parsed = createSessionInputSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director session create request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getSessionEngine(resolvedRoot, delegate);

      try {
        const session = await engine.createSession({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
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
// 2. GET SESSION TOOL
// ============================================================================

const getSessionInputSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  touch: z.boolean().optional(),
});

export const directorSessionGetToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_SESSION_GET_TOOL_NAME,
  description:
    'Retrieves a persisted Director session by ID or returns the currently active session. Strictly non-mutating unless touch is true.',
  inputSchema: {
    type: 'object',
    properties: {
      directorSessionId: {
        type: 'string',
        description: 'Optional session identifier. If omitted, retrieves the active session.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional project workspace root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier for binding validation.',
      },
      touch: {
        type: 'boolean',
        description: 'Whether to update the lastActivityAt timestamp.',
      },
    },
  },
};

export function createDirectorSessionGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorSessionGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof getSessionInputSchema>;
      try {
        parsed = getSessionInputSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director session get request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getSessionEngine(resolvedRoot, delegate);

      try {
        const session = await engine.getSession(parsed.directorSessionId, {
          workspaceRoot: resolvedRoot,
          projectId: parsed.projectId,
          touch: parsed.touch,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
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
// 3. SUSPEND SESSION TOOL
// ============================================================================

const suspendSessionInputSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  reason: z.string().optional(),
});

export const directorSessionSuspendToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_SESSION_SUSPEND_TOOL_NAME,
  description:
    'Suspends an active Director session. Preserves session identity and protocol context for deterministic resume.',
  inputSchema: {
    type: 'object',
    properties: {
      directorSessionId: {
        type: 'string',
        description: 'Optional session identifier. If omitted, suspends active session.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional project workspace root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier for binding validation.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for suspending session.',
      },
    },
  },
};

export function createDirectorSessionSuspendTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorSessionSuspendToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof suspendSessionInputSchema>;
      try {
        parsed = suspendSessionInputSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director session suspend request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getSessionEngine(resolvedRoot, delegate);

      try {
        const session = await engine.suspendSession({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
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
// 4. CLOSE SESSION TOOL
// ============================================================================

const closeSessionInputSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  reason: z.string().optional(),
});

export const directorSessionCloseToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_SESSION_CLOSE_TOOL_NAME,
  description:
    'Permanently closes a Director session. Closed sessions are terminal and cannot be resumed.',
  inputSchema: {
    type: 'object',
    properties: {
      directorSessionId: {
        type: 'string',
        description: 'Optional session identifier. If omitted, closes active session.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional project workspace root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier for binding validation.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for closing session.',
      },
    },
  },
};

export function createDirectorSessionCloseTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorSessionCloseToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof closeSessionInputSchema>;
      try {
        parsed = closeSessionInputSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director session close request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getSessionEngine(resolvedRoot, delegate);

      try {
        const session = await engine.closeSession({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
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
// 5. RESUME SESSION TOOL
// ============================================================================

const resumeSessionInputSchema = z.object({
  directorSessionId: DirectorSessionIdZodSchema.optional(),
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const directorSessionResumeToolDefinition: McpToolDefinition = {
  name: AIDM_DIRECTOR_SESSION_RESUME_TOOL_NAME,
  description:
    'Resumes an existing suspended or active Director session. Recovers existing identity and protocol state without creating a new session.',
  inputSchema: {
    type: 'object',
    properties: {
      directorSessionId: {
        type: 'string',
        description: 'Optional session identifier. If omitted, resumes active or suspended session.',
      },
      workspaceRoot: {
        type: 'string',
        description: 'Optional project workspace root.',
      },
      projectId: {
        type: 'string',
        description: 'Optional project identifier for binding validation.',
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata to merge upon resume.',
      },
    },
  },
};

export function createDirectorSessionResumeTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: directorSessionResumeToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      let parsed: z.infer<typeof resumeSessionInputSchema>;
      try {
        parsed = resumeSessionInputSchema.parse(args ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new McpInvalidRequestError(`Invalid Director session resume request: ${err.message}`, {
            issues: err.issues,
          });
        }
        throw err;
      }

      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();
      const engine = getSessionEngine(resolvedRoot, delegate);

      try {
        const session = await engine.resumeSession({
          ...parsed,
          workspaceRoot: resolvedRoot,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
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

export function registerDirectorSessionTools(server: McpServer): void {
  const tools = [
    createDirectorSessionCreateTool(server.delegate),
    createDirectorSessionGetTool(server.delegate),
    createDirectorSessionSuspendTool(server.delegate),
    createDirectorSessionCloseTool(server.delegate),
    createDirectorSessionResumeTool(server.delegate),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
