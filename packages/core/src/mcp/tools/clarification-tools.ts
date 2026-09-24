/**
 * Clarification Protocol MCP Tools (Phase 8 TASK-P8-04)
 *
 * Exposes bounded, strictly typed clarification operations through the MCP boundary:
 * 1. aidm.clarification.session.create
 * 2. aidm.clarification.session.get
 * 3. aidm.clarification.session.answer
 * 4. aidm.clarification.session.blocking
 *
 * STRICT GOVERNANCE RULES:
 * 1. Read-only discovery input: does not mutate project repository.
 * 2. Does NOT mutate requirements.json or decisions.json.
 * 3. Does NOT replace global AIDM FSM.
 * 4. Human answers are untrusted input; sanitized and validated.
 * 5. Strictly no shell execution, code evaluation, git mutations, or Antigravity invocations.
 */

import { z } from 'zod';
import type { McpToolDefinition, McpToolHandler, McpRequestContext } from '../mcp-types.js';
import type { McpOrchestratorDelegate } from '../mcp-delegate.js';
import type { McpServer } from '../mcp-server.js';
import { sanitizeMcpPayload, McpInvalidRequestError } from '../mcp-errors.js';
import { ProjectDiscoveryEngine } from '../../discovery/discovery-engine.js';
import { ProjectDiscoveryReport } from '../../discovery/discovery-types.js';
import { ClarificationSessionEngine } from '../../clarification/clarification-session-engine.js';
import { ClarificationStore } from '../../clarification/clarification-store.js';
import {
  ClarificationAnswerInput,
  CLARIFICATION_ANSWER_TYPES,
  CLARIFICATION_ANSWER_STATUSES,
} from '../../clarification/clarification-types.js';

// ============================================================================
// TOOL NAMES & DEFINITIONS
// ============================================================================

export const AIDM_CLARIFICATION_CREATE_TOOL_NAME = 'aidm.clarification.session.create';
export const AIDM_CLARIFICATION_GET_TOOL_NAME = 'aidm.clarification.session.get';
export const AIDM_CLARIFICATION_ANSWER_TOOL_NAME = 'aidm.clarification.session.answer';
export const AIDM_CLARIFICATION_BLOCKING_TOOL_NAME = 'aidm.clarification.session.blocking';

// ----------------------------------------------------------------------------
// 1. CREATE SESSION TOOL
// ----------------------------------------------------------------------------

const createSessionInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const clarificationCreateToolDefinition: McpToolDefinition = {
  name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
  description:
    'Creates a structured clarification session from repository discovery findings. Analyzes ambiguities, contradictions, and missing requirements, deterministically prioritizing questions for the Director layer.',
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
      metadata: {
        type: 'object',
        description: 'Optional metadata to associate with the clarification session.',
      },
    },
  },
};

export function createClarificationCreateTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: clarificationCreateToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = createSessionInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      // Discover repository findings in read-only manner
      const discoveryEngine = new ProjectDiscoveryEngine({
        workspaceRoot: resolvedRoot,
        delegate,
      });
      const discoveryReport: ProjectDiscoveryReport = await discoveryEngine.discover();

      // Create session
      const sessionEngine = new ClarificationSessionEngine();
      const session = sessionEngine.createSession(discoveryReport, {
        projectId: parsed.projectId,
        metadata: parsed.metadata,
      });

      // Persist session
      const store = delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
      await store.saveSession(session);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
          },
        ],
      };
    },
  };
}

// ----------------------------------------------------------------------------
// 2. GET SESSION TOOL
// ----------------------------------------------------------------------------

const getSessionInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  sessionId: z.string().optional(),
});

export const clarificationGetToolDefinition: McpToolDefinition = {
  name: AIDM_CLARIFICATION_GET_TOOL_NAME,
  description:
    'Retrieves a clarification session by ID, or returns the currently active session if no ID is specified.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session ID. When omitted, retrieves the active session.',
      },
    },
  },
};

export function createClarificationGetTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: clarificationGetToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = getSessionInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const store = delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
      const session = parsed.sessionId
        ? await store.loadSession(parsed.sessionId)
        : await store.getActiveSession();

      if (!session) {
        throw new McpInvalidRequestError(
          `Clarification session not found: ${parsed.sessionId ?? 'no active session'}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(session), null, 2),
          },
        ],
      };
    },
  };
}

// ----------------------------------------------------------------------------
// 3. ANSWER CLARIFICATION TOOL
// ----------------------------------------------------------------------------

const answerClarificationInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  sessionId: z.string().optional(),
  clarificationId: z.string().min(1, 'clarificationId is required'),
  answerType: z.enum(CLARIFICATION_ANSWER_TYPES as unknown as [string, ...string[]]).optional(),
  selectedOptions: z.array(z.string()).optional(),
  freeFormResponse: z.string().optional(),
  source: z.literal('HUMAN', { message: "source must be strictly 'HUMAN'" }),
  status: z.enum(CLARIFICATION_ANSWER_STATUSES as unknown as [string, ...string[]]).optional(),
  followUpReason: z.string().optional(),
  notes: z.string().optional(),
});

export const clarificationAnswerToolDefinition: McpToolDefinition = {
  name: AIDM_CLARIFICATION_ANSWER_TOOL_NAME,
  description:
    'Submits a validated human answer to a clarification question within an active session. Untrusted input is strictly validated and sanitized.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session ID. Defaults to active session.',
      },
      clarificationId: {
        type: 'string',
        description: 'The clarification ID being answered.',
      },
      answerType: {
        type: 'string',
        enum: ['OPTION_SELECTION', 'FREE_FORM', 'DEFERRED', 'REJECTED'],
        description: 'Type of answer provided.',
      },
      selectedOptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of selected options matching question options.',
      },
      freeFormResponse: {
        type: 'string',
        description: 'Free-form clarification text from human Product Owner.',
      },
      source: {
        type: 'string',
        enum: ['HUMAN'],
        description: "Authoritative answer source. Must strictly be 'HUMAN'.",
      },
      status: {
        type: 'string',
        enum: ['ANSWERED', 'DEFERRED', 'REJECTED', 'NEEDS_FOLLOWUP'],
        description: 'Answer status.',
      },
      followUpReason: {
        type: 'string',
        description: 'Reason if answer requires follow-up.',
      },
    },
    required: ['clarificationId', 'source'],
  },
};

export function createClarificationAnswerTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: clarificationAnswerToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = answerClarificationInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const store = delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
      const session = parsed.sessionId
        ? await store.loadSession(parsed.sessionId)
        : await store.getActiveSession();

      if (!session) {
        throw new McpInvalidRequestError(
          `Clarification session not found: ${parsed.sessionId ?? 'no active session'}`
        );
      }

      const answerInput: ClarificationAnswerInput = {
        clarificationId: parsed.clarificationId,
        answerType: parsed.answerType as ClarificationAnswerInput['answerType'],
        selectedOptions: parsed.selectedOptions,
        freeFormResponse: parsed.freeFormResponse,
        source: parsed.source,
        status: parsed.status as ClarificationAnswerInput['status'],
        followUpReason: parsed.followUpReason,
        notes: parsed.notes,
      };

      const sessionEngine = new ClarificationSessionEngine();
      const updatedSession = sessionEngine.submitAnswer(session, answerInput);

      await store.saveSession(updatedSession);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sanitizeMcpPayload(updatedSession), null, 2),
          },
        ],
      };
    },
  };
}

// ----------------------------------------------------------------------------
// 4. BLOCKING QUESTIONS TOOL
// ----------------------------------------------------------------------------

const blockingInputSchema = z.object({
  workspaceRoot: z.string().optional(),
  sessionId: z.string().optional(),
});

export const clarificationBlockingToolDefinition: McpToolDefinition = {
  name: AIDM_CLARIFICATION_BLOCKING_TOOL_NAME,
  description:
    'Retrieves all unresolved blocking clarification questions in deterministic priority order for the given or active session.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceRoot: {
        type: 'string',
        description: 'Optional path to the project root.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session ID. Defaults to active session.',
      },
    },
  },
};

export function createClarificationBlockingTool(
  defaultDelegate?: McpOrchestratorDelegate
): { definition: McpToolDefinition; handler: McpToolHandler } {
  return {
    definition: clarificationBlockingToolDefinition,
    handler: async (args: Record<string, unknown>, context: McpRequestContext) => {
      const parsed = blockingInputSchema.parse(args ?? {});
      const delegate = context.delegate ?? defaultDelegate;
      const resolvedRoot = parsed.workspaceRoot ?? delegate?.projectRoot ?? process.cwd();

      const store = delegate?.clarificationStore ?? new ClarificationStore({ baseDir: resolvedRoot });
      const session = parsed.sessionId
        ? await store.loadSession(parsed.sessionId)
        : await store.getActiveSession();

      if (!session) {
        throw new McpInvalidRequestError(
          `Clarification session not found: ${parsed.sessionId ?? 'no active session'}`
        );
      }

      const sessionEngine = new ClarificationSessionEngine();
      const blockingQuestions = sessionEngine.getBlockingQuestions(session);

      const result = {
        sessionId: session.sessionId,
        status: session.status,
        blockingOpenCount: session.blockingOpenCount,
        blockingQuestions,
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
// REGISTRATION
// ============================================================================

export function registerClarificationTools(server: McpServer): void {
  const tools = [
    createClarificationCreateTool(server.delegate),
    createClarificationGetTool(server.delegate),
    createClarificationAnswerTool(server.delegate),
    createClarificationBlockingTool(server.delegate),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
