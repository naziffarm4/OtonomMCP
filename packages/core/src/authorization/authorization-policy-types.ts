import { RiskLevel } from '../risk.js';

export const AuthorizationDecisionResult = {
  ALLOW: 'ALLOW',
  REQUIRE_HUMAN_APPROVAL: 'REQUIRE_HUMAN_APPROVAL',
  DENY: 'DENY',
  WAITING_FOR_TRUSTED_IDENTITY: 'WAITING_FOR_TRUSTED_IDENTITY',
  WAITING_FOR_POLICY_CONFIGURATION: 'WAITING_FOR_POLICY_CONFIGURATION',
} as const;

export type AuthorizationDecisionResult =
  typeof AuthorizationDecisionResult[keyof typeof AuthorizationDecisionResult];

export interface PolicyDecisionRecord {
  policyDecisionId: string;
  actionId: string;
  idempotencyKey: string;
  projectId: string;
  directorSessionId: string;
  taskId: string;
  taskRevision: number;
  contextFingerprint: string;
  decisionResult: AuthorizationDecisionResult;
  appliedRules: string[];
  reason: string;
  riskLevel: RiskLevel;
  decisionTime: string;
  authorizationScope: string[];
  requiredHumanApproval?: string;
  policyVersion: number;
}

export interface ProjectMandate {
  projectId: string;
  allowedDirectories: string[];
  allowedOperationTypes: string[];
  allowedCommandCategories: string[];
  autoExecutableTaskClasses: string[];
  forbiddenOperations: string[];
  humanApprovalRequiredOperations: string[];
  authorizationStartTime: string;
  authorizationEndTime: string;
  resourceAndWorkLimits: {
    maxFileEdits?: number;
    maxCommands?: number;
  };
  policyVersion: number;
  mandateRevision: number;
}
