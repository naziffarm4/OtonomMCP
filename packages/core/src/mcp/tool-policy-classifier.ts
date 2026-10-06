/**
 * MCP Tool Policy Classifier & Risk Categorization Boundary (Phase 29)
 *
 * Implements deterministic mapping of MCP tool names to authoritative
 * policy action types and risk levels, resolving the MCP authorization bug
 * where all tools were blindly evaluated as READ_ONLY_INSPECTION.
 */

import { OperationActionType } from '../policy/policy-types.js';
import { RiskLevel } from '../risk.js';

export const McpToolCategory = {
  READ_ONLY: 'READ_ONLY',
  PLANNING: 'PLANNING',
  EXECUTION_CAPABLE: 'EXECUTION_CAPABLE',
  HUMAN_GATE: 'HUMAN_GATE',
} as const;

export type McpToolCategory = (typeof McpToolCategory)[keyof typeof McpToolCategory];

export interface McpToolPolicyClassification {
  readonly category: McpToolCategory;
  readonly actionType: OperationActionType;
  readonly operationActionType: OperationActionType;
  readonly isReadOnly: boolean;
  readonly mutatesSource: boolean;
  readonly requestedRiskLevel: RiskLevel;
  readonly riskLevel: RiskLevel;
}

/**
 * Normalizes tool name for comparison by lowercasing and converting underscores to dots.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\-]/g, '.');
}

/**
 * Classifies an MCP tool by its authoritative risk class and policy action type.
 */
export function classifyMcpTool(toolName: string): McpToolPolicyClassification {
  const norm = normalizeName(toolName);

  // 1. Human Gate Tools (approvals, human decisions, retry authorization)
  if (
    norm.includes('approval.human') ||
    norm.includes('approval.package.approve') ||
    norm.includes('approval.package.reject') ||
    norm.includes('approval.resume') ||
    norm.includes('retry.authorize') ||
    norm.includes('task.authorizeretry')
  ) {
    return {
      category: 'HUMAN_GATE',
      actionType: OperationActionType.CUSTOM,
      operationActionType: OperationActionType.CUSTOM,
      isReadOnly: false,
      mutatesSource: false,
      requestedRiskLevel: RiskLevel.CAUTION,
      riskLevel: RiskLevel.CAUTION,
    };
  }

  // 2. Execution-Capable Tools (cycle execution, task execution, driver execution, retry/corrective, director.act)
  if (
    norm.includes('director.act') ||
    norm.includes('executecycle') ||
    norm.includes('execute_cycle') ||
    norm.includes('ingestinstruction') ||
    norm.includes('ingest_instruction') ||
    norm.includes('driver.start') ||
    norm.includes('driver.resume') ||
    norm.includes('executor.execute') ||
    norm.includes('execution.request.create') ||
    norm.includes('execution.request.build') ||
    norm.includes('execution.intent.validate') ||
    norm.includes('task.retry') ||
    norm.includes('task.replan') ||
    norm.includes('task.createcorrective') ||
    norm.includes('phase11') ||
    norm.includes('requestcontinue')
  ) {
    return {
      category: 'EXECUTION_CAPABLE',
      actionType: OperationActionType.COMMAND_EXECUTION,
      operationActionType: OperationActionType.COMMAND_EXECUTION,
      isReadOnly: false,
      mutatesSource: true,
      requestedRiskLevel: RiskLevel.CRITICAL,
      riskLevel: RiskLevel.CRITICAL,
    };
  }

  // 3. Planning / Director Control Tools (sessions, decisions, sync, spec, boundary evaluation, director.open/control)
  if (
    norm.includes('director.open') ||
    norm.includes('director.control') ||
    norm.includes('context.sync') ||
    norm.includes('decision.create') ||
    norm.includes('decision.validate') ||
    norm.includes('decision.list') ||
    norm.includes('session.create') ||
    norm.includes('session.suspend') ||
    norm.includes('session.close') ||
    norm.includes('session.resume') ||
    norm.includes('clarification.session.create') ||
    norm.includes('clarification.session.answer') ||
    norm.includes('clarification.session.blocking') ||
    norm.includes('approval.package.create') ||
    norm.includes('evaluatenextaction') ||
    norm.includes('evaluate_next_action') ||
    norm.includes('driver.pause') ||
    norm.includes('driver.stop') ||
    norm.includes('project.discover') ||
    norm.includes('specification.completeness.evaluate') ||
    norm.includes('requirements-scope.define') ||
    norm.includes('architecture-technology.define') ||
    norm.includes('business-rules.define') ||
    norm.includes('acceptance-criteria.define') ||
    norm.includes('risks.define') ||
    norm.includes('project-spec.generate') ||
    norm.includes('project-spec.stale') ||
    norm.includes('task.decompose') ||
    norm.includes('recovery.evaluate') ||
    norm.includes('context.package')
  ) {
    return {
      category: 'PLANNING',
      actionType: OperationActionType.SOURCE_MUTATION,
      operationActionType: OperationActionType.SOURCE_MUTATION,
      isReadOnly: false,
      mutatesSource: false,
      requestedRiskLevel: RiskLevel.CAUTION,
      riskLevel: RiskLevel.CAUTION,
    };
  }

  // 4. Read-Only Tools (default: inspection, status, queries, evidence)
  return {
    category: 'READ_ONLY',
    actionType: OperationActionType.READ_ONLY_INSPECTION,
    operationActionType: OperationActionType.READ_ONLY_INSPECTION,
    isReadOnly: true,
    mutatesSource: false,
    requestedRiskLevel: RiskLevel.SAFE,
    riskLevel: RiskLevel.SAFE,
  };
}
