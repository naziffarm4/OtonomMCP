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
import {
  AIDM_PROJECT_DISCOVER_TOOL_NAME,
  createProjectDiscoverTool,
  projectDiscoverToolDefinition,
} from './project-discover-tool.js';
import {
  AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME,
  createSpecificationCompletenessTool,
  specificationCompletenessToolDefinition,
} from './specification-completeness-tool.js';
import {
  AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
  AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
  createRequirementsScopeDefineTool,
  createRequirementsScopeGetTool,
  requirementsScopeDefineToolDefinition,
  requirementsScopeGetToolDefinition,
} from './requirements-scope-tool.js';
import {
  AIDM_ARCHITECTURE_TECHNOLOGY_DEFINE_TOOL_NAME,
  AIDM_ARCHITECTURE_TECHNOLOGY_GET_TOOL_NAME,
  createArchitectureTechnologyDefineTool,
  createArchitectureTechnologyGetTool,
  architectureTechnologyDefineToolDefinition,
  architectureTechnologyGetToolDefinition,
} from './architecture-technology-tool.js';
import {
  AIDM_BUSINESS_RULES_DEFINE_TOOL_NAME,
  AIDM_BUSINESS_RULES_GET_TOOL_NAME,
  createBusinessRulesDefineTool,
  createBusinessRulesGetTool,
  businessRulesDefineToolDefinition,
  businessRulesGetToolDefinition,
} from './business-rules-tool.js';
import {
  AIDM_ACCEPTANCE_CRITERIA_DEFINE_TOOL_NAME,
  AIDM_ACCEPTANCE_CRITERIA_GET_TOOL_NAME,
  createAcceptanceCriteriaDefineTool,
  createAcceptanceCriteriaGetTool,
  acceptanceCriteriaDefineToolDefinition,
  acceptanceCriteriaGetToolDefinition,
} from './acceptance-criteria-tool.js';
import {
  AIDM_RISKS_DEFINE_TOOL_NAME,
  AIDM_RISKS_GET_TOOL_NAME,
  AIDM_HUMAN_DECISIONS_GET_TOOL_NAME,
  createRisksDefineTool,
  createRisksGetTool,
  createHumanDecisionsGetTool,
  risksDefineToolDefinition,
  risksGetToolDefinition,
  humanDecisionsGetToolDefinition,
  registerRiskHumanDecisionTools,
} from './risk-human-decision-tool.js';
import {
  AIDM_PROJECT_SPEC_GENERATE_TOOL_NAME,
  AIDM_PROJECT_SPEC_GET_TOOL_NAME,
  AIDM_PROJECT_SPEC_STALE_TOOL_NAME,
  createProjectSpecGenerateTool,
  createProjectSpecGetTool,
  createProjectSpecStaleTool,
  projectSpecGenerateToolDefinition,
  projectSpecGetToolDefinition,
  projectSpecStaleToolDefinition,
  registerProjectSpecTools,
} from './project-spec-tool.js';
import {
  AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  createApprovalPackageGetTool,
  createApprovalPackageReadinessTool,
  approvalPackageGetToolDefinition,
  approvalPackageReadinessToolDefinition,
} from './approval-tools.js';

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
  AIDM_PROJECT_DISCOVER_TOOL_NAME,
  createProjectDiscoverTool,
  projectDiscoverToolDefinition,
  AIDM_SPECIFICATION_COMPLETENESS_TOOL_NAME,
  createSpecificationCompletenessTool,
  specificationCompletenessToolDefinition,
  AIDM_REQUIREMENTS_SCOPE_DEFINE_TOOL_NAME,
  AIDM_REQUIREMENTS_SCOPE_GET_TOOL_NAME,
  createRequirementsScopeDefineTool,
  createRequirementsScopeGetTool,
  requirementsScopeDefineToolDefinition,
  requirementsScopeGetToolDefinition,
  AIDM_ARCHITECTURE_TECHNOLOGY_DEFINE_TOOL_NAME,
  AIDM_ARCHITECTURE_TECHNOLOGY_GET_TOOL_NAME,
  createArchitectureTechnologyDefineTool,
  createArchitectureTechnologyGetTool,
  architectureTechnologyDefineToolDefinition,
  architectureTechnologyGetToolDefinition,
  AIDM_BUSINESS_RULES_DEFINE_TOOL_NAME,
  AIDM_BUSINESS_RULES_GET_TOOL_NAME,
  createBusinessRulesDefineTool,
  createBusinessRulesGetTool,
  businessRulesDefineToolDefinition,
  businessRulesGetToolDefinition,
  AIDM_ACCEPTANCE_CRITERIA_DEFINE_TOOL_NAME,
  AIDM_ACCEPTANCE_CRITERIA_GET_TOOL_NAME,
  createAcceptanceCriteriaDefineTool,
  createAcceptanceCriteriaGetTool,
  acceptanceCriteriaDefineToolDefinition,
  acceptanceCriteriaGetToolDefinition,
  AIDM_RISKS_DEFINE_TOOL_NAME,
  AIDM_RISKS_GET_TOOL_NAME,
  AIDM_HUMAN_DECISIONS_GET_TOOL_NAME,
  createRisksDefineTool,
  createRisksGetTool,
  createHumanDecisionsGetTool,
  risksDefineToolDefinition,
  risksGetToolDefinition,
  humanDecisionsGetToolDefinition,
  registerRiskHumanDecisionTools,
  AIDM_PROJECT_SPEC_GENERATE_TOOL_NAME,
  AIDM_PROJECT_SPEC_GET_TOOL_NAME,
  AIDM_PROJECT_SPEC_STALE_TOOL_NAME,
  createProjectSpecGenerateTool,
  createProjectSpecGetTool,
  createProjectSpecStaleTool,
  projectSpecGenerateToolDefinition,
  projectSpecGetToolDefinition,
  projectSpecStaleToolDefinition,
  registerProjectSpecTools,
  AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  createApprovalPackageGetTool,
  createApprovalPackageReadinessTool,
  approvalPackageGetToolDefinition,
  approvalPackageReadinessToolDefinition,
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

/**
 * Registers the project discovery tool onto an McpServer instance.
 */
export function registerDiscoveryTools(server: McpServer): void {
  const discoverTool = createProjectDiscoverTool(server.delegate);
  server.registerTool(discoverTool.definition, discoverTool.handler);
}

/**
 * Registers the specification completeness tool onto an McpServer instance.
 */
export function registerCompletenessTools(server: McpServer): void {
  const completenessTool = createSpecificationCompletenessTool(server.delegate);
  server.registerTool(completenessTool.definition, completenessTool.handler);
}

/**
 * Registers the requirements & scope tools onto an McpServer instance.
 */
export function registerRequirementsScopeTools(server: McpServer): void {
  const defineTool = createRequirementsScopeDefineTool(server.delegate);
  const getTool = createRequirementsScopeGetTool(server.delegate);
  server.registerTool(defineTool.definition, defineTool.handler);
  server.registerTool(getTool.definition, getTool.handler);
}

/**
 * Registers the architecture & technology tools onto an McpServer instance.
 */
export function registerArchitectureTechnologyTools(server: McpServer): void {
  const defineTool = createArchitectureTechnologyDefineTool(server.delegate);
  const getTool = createArchitectureTechnologyGetTool(server.delegate);
  server.registerTool(defineTool.definition, defineTool.handler);
  server.registerTool(getTool.definition, getTool.handler);
}

/**
 * Registers the business rules tools onto an McpServer instance.
 */
export function registerBusinessRulesTools(server: McpServer): void {
  const defineTool = createBusinessRulesDefineTool(server.delegate);
  const getTool = createBusinessRulesGetTool(server.delegate);
  server.registerTool(defineTool.definition, defineTool.handler);
  server.registerTool(getTool.definition, getTool.handler);
}

/**
 * Registers the acceptance criteria tools onto an McpServer instance.
 */
export function registerAcceptanceCriteriaTools(server: McpServer): void {
  const defineTool = createAcceptanceCriteriaDefineTool(server.delegate);
  const getTool = createAcceptanceCriteriaGetTool(server.delegate);
  server.registerTool(defineTool.definition, defineTool.handler);
  server.registerTool(getTool.definition, getTool.handler);
}
