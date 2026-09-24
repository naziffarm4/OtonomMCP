/**
 * Director Read-Only Tools Aggregation & Registration Boundary (Phase 8 TASK-P8-02)
 *
 * Centralizes definition, registration, and discovery of all 9 Director read tools:
 * 1. aidm.project.status
 * 2. aidm.project.requirements
 * 3. aidm.project.decisions
 * 4. aidm.tasks.list
 * 5. aidm.tasks.current
 * 6. aidm.context.get
 * 7. aidm.evidence.get
 * 8. aidm.history.get
 * 9. aidm.git.status
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only tools: no FSM, state, Git, task, or evidence mutations.
 * 2. Connects ChatGPT (Director) to authoritative AIDM stores without inventing data.
 * 3. No second source of truth.
 */

import type { McpServer } from '../mcp-server.js';
import {
  AIDM_PROJECT_STATUS_TOOL_NAME,
  createProjectStatusTool,
  projectStatusToolDefinition,
} from './project-status-tool.js';
import {
  AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  createProjectRequirementsTool,
  projectRequirementsToolDefinition,
} from './project-requirements-tool.js';
import {
  AIDM_PROJECT_DECISIONS_TOOL_NAME,
  createProjectDecisionsTool,
  projectDecisionsToolDefinition,
} from './project-decisions-tool.js';
import {
  AIDM_TASKS_LIST_TOOL_NAME,
  createTasksListTool,
  tasksListToolDefinition,
} from './tasks-list-tool.js';
import {
  AIDM_TASKS_CURRENT_TOOL_NAME,
  createTasksCurrentTool,
  tasksCurrentToolDefinition,
} from './tasks-current-tool.js';
import {
  AIDM_CONTEXT_GET_TOOL_NAME,
  createContextGetTool,
  contextGetToolDefinition,
} from './context-get-tool.js';
import {
  AIDM_EVIDENCE_GET_TOOL_NAME,
  createEvidenceGetTool,
  evidenceGetToolDefinition,
} from './evidence-get-tool.js';
import {
  AIDM_HISTORY_GET_TOOL_NAME,
  createHistoryGetTool,
  historyGetToolDefinition,
} from './history-get-tool.js';
import {
  AIDM_GIT_STATUS_TOOL_NAME,
  createGitStatusTool,
  gitStatusToolDefinition,
} from './git-status-tool.js';

export {
  AIDM_PROJECT_STATUS_TOOL_NAME,
  AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  AIDM_PROJECT_DECISIONS_TOOL_NAME,
  AIDM_TASKS_LIST_TOOL_NAME,
  AIDM_TASKS_CURRENT_TOOL_NAME,
  AIDM_CONTEXT_GET_TOOL_NAME,
  AIDM_EVIDENCE_GET_TOOL_NAME,
  AIDM_HISTORY_GET_TOOL_NAME,
  AIDM_GIT_STATUS_TOOL_NAME,
};

export const DIRECTOR_READ_TOOL_NAMES = [
  AIDM_PROJECT_STATUS_TOOL_NAME,
  AIDM_PROJECT_REQUIREMENTS_TOOL_NAME,
  AIDM_PROJECT_DECISIONS_TOOL_NAME,
  AIDM_TASKS_LIST_TOOL_NAME,
  AIDM_TASKS_CURRENT_TOOL_NAME,
  AIDM_CONTEXT_GET_TOOL_NAME,
  AIDM_EVIDENCE_GET_TOOL_NAME,
  AIDM_HISTORY_GET_TOOL_NAME,
  AIDM_GIT_STATUS_TOOL_NAME,
] as const;

export type DirectorReadToolName = (typeof DIRECTOR_READ_TOOL_NAMES)[number];

export const DIRECTOR_READ_TOOL_DEFINITIONS = [
  projectStatusToolDefinition,
  projectRequirementsToolDefinition,
  projectDecisionsToolDefinition,
  tasksListToolDefinition,
  tasksCurrentToolDefinition,
  contextGetToolDefinition,
  evidenceGetToolDefinition,
  historyGetToolDefinition,
  gitStatusToolDefinition,
] as const;

/**
 * Registers all 9 Director read-only tools onto an McpServer instance.
 */
export function registerDirectorReadTools(server: McpServer): void {
  const tools = [
    createProjectStatusTool(),
    createProjectRequirementsTool(),
    createProjectDecisionsTool(),
    createTasksListTool(),
    createTasksCurrentTool(),
    createContextGetTool(),
    createEvidenceGetTool(),
    createHistoryGetTool(),
    createGitStatusTool(),
  ];

  for (const tool of tools) {
    server.registerTool(tool.definition, tool.handler);
  }
}
