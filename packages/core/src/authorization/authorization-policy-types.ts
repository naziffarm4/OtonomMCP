import { RiskLevel } from '../risk.js';
import { z } from 'zod';

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
  actionType?: string;
  mandateRevision?: number;
  policyVersion: number;
}

export const ProjectMandateZodSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  allowedDirectories: z.array(z.string()).default([]),
  allowedOperationTypes: z.array(z.string()).default([]),
  allowedCommandCategories: z.array(z.string()).default([]),
  autoExecutableTaskClasses: z.array(z.string()).default([]),
  forbiddenOperations: z.array(z.string()).default([]),
  humanApprovalRequiredOperations: z.array(z.string()).default([]),
  authorizationStartTime: z.string().min(1, 'authorizationStartTime is required'),
  authorizationEndTime: z.string().min(1, 'authorizationEndTime is required'),
  resourceAndWorkLimits: z.object({
    maxFileEdits: z.number().int().nonnegative().optional(),
    maxCommands: z.number().int().nonnegative().optional(),
  }).default({}),
  policyVersion: z.number().int().positive().default(1),
  mandateRevision: z.number().int().positive().default(1),
}).strict();

export type ProjectMandate = z.infer<typeof ProjectMandateZodSchema>;
