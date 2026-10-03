import * as crypto from 'node:crypto';
import { HistoryManager } from '../storage/history-manager.js';
import { DirectorActionEnvelope, DirectorActionType } from '../director-action/director-action-types.js';
import {
  AuthorizationDecisionResult,
  PolicyDecisionRecord,
  ProjectMandate,
} from './authorization-policy-types.js';
import { ProjectMandateStore } from './project-mandate-store.js';
import { RiskLevel } from '../risk.js';
import { BridgeExecutionIntent } from '../execution-bridge/execution-bridge-types.js';

export interface AuthorizationPolicyEngineOptions {
  historyManager: HistoryManager;
  mandateStore: ProjectMandateStore;
}

export class AuthorizationPolicyEngine {
  private readonly historyManager: HistoryManager;
  private readonly mandateStore: ProjectMandateStore;

  constructor(options: AuthorizationPolicyEngineOptions) {
    this.historyManager = options.historyManager;
    this.mandateStore = options.mandateStore;
  }

  /**
   * Evaluates an action against the project mandate and context to determine authorization state.
   */
  async evaluateAction(action: DirectorActionEnvelope): Promise<PolicyDecisionRecord> {
    const mandate = await this.mandateStore.loadMandate();

    if (!mandate) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION,
        reason: 'Project Mandate is not configured yet. Awaiting Trusted IDE configuration.',
        appliedRules: ['MISSING_PROJECT_MANDATE'],
        riskLevel: RiskLevel.CAUTION,
      });
    }

    if (mandate.projectId !== action.projectId) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Cross-project action evaluation attempt. Mandate project: ${mandate.projectId}, Action project: ${action.projectId}`,
        appliedRules: ['PROJECT_ISOLATION_VIOLATION'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const now = Date.now();
    const startTime = Date.parse(mandate.authorizationStartTime);
    const endTime = Date.parse(mandate.authorizationEndTime);

    if (now < startTime || now > endTime) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Current time is outside the project mandate authorization window.`,
        appliedRules: ['MANDATE_EXPIRED_OR_NOT_STARTED'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    // Since we don't have expected mandate revision in action envelope, we might not be able to check it against action directly, 
    // but the test expects "Mandate revision uyuşmazlığı" to be checked. Let's assume the action payload has it if provided.
    const expectedRevision = (action.payload as any).expectedMandateRevision;
    if (expectedRevision !== undefined && expectedRevision !== mandate.mandateRevision) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Mandate revision mismatch. Expected: ${expectedRevision}, Actual: ${mandate.mandateRevision}`,
        appliedRules: ['MANDATE_REVISION_MISMATCH'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const expectedPolicyVersion = (action.payload as any).expectedPolicyVersion;
    if (expectedPolicyVersion !== undefined && expectedPolicyVersion !== mandate.policyVersion) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Policy version mismatch. Expected: ${expectedPolicyVersion}, Actual: ${mandate.policyVersion}`,
        appliedRules: ['POLICY_VERSION_MISMATCH'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    // Evaluate basic action type
    const actionTypeRule = this.evaluateActionType(action.actionType, mandate);

    let decisionResult = actionTypeRule.result;
    const appliedRules = [actionTypeRule.rule];
    let reason = actionTypeRule.reason;

    return this.createDecision({
      action,
      decisionResult,
      reason,
      appliedRules,
      riskLevel: this.mapRiskLevel(decisionResult),
      authorizationScope: mandate.allowedOperationTypes,
      policyVersion: mandate.policyVersion,
      requiredHumanApproval: decisionResult === AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL ? 'ProductOwner' : undefined,
    });
  }

  /**
   * Evaluates an execution intent before handing off to Driver (P20 ExecutionBridge).
   */
  async evaluateExecutionIntent(intent: BridgeExecutionIntent): Promise<PolicyDecisionRecord> {
    const mandate = await this.mandateStore.loadMandate();

    if (!mandate) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION,
        reason: 'Project Mandate is not configured yet. Awaiting Trusted IDE configuration.',
        appliedRules: ['MISSING_PROJECT_MANDATE'],
        riskLevel: RiskLevel.CAUTION,
      });
    }

    if (mandate.projectId !== intent.projectId) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Cross-project intent evaluation attempt. Mandate project: ${mandate.projectId}, Intent project: ${intent.projectId}`,
        appliedRules: ['PROJECT_ISOLATION_VIOLATION'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const now = Date.now();
    const startTime = Date.parse(mandate.authorizationStartTime);
    const endTime = Date.parse(mandate.authorizationEndTime);

    if (now < startTime || now > endTime) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Current time is outside the project mandate authorization window.`,
        appliedRules: ['MANDATE_EXPIRED_OR_NOT_STARTED'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const expectedRevision = intent.metadata?.expectedMandateRevision;
    if (expectedRevision !== undefined && expectedRevision !== mandate.mandateRevision) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Mandate revision mismatch. Expected: ${expectedRevision}, Actual: ${mandate.mandateRevision}`,
        appliedRules: ['MANDATE_REVISION_MISMATCH'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const expectedPolicyVersion = intent.metadata?.expectedPolicyVersion;
    if (expectedPolicyVersion !== undefined && expectedPolicyVersion !== mandate.policyVersion) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Policy version mismatch. Expected: ${expectedPolicyVersion}, Actual: ${mandate.policyVersion}`,
        appliedRules: ['POLICY_VERSION_MISMATCH'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const actionTypeRule = this.evaluateActionType('IMPLEMENT_TASK', mandate);
    
    let decisionResult = actionTypeRule.result;
    const appliedRules = [actionTypeRule.rule];
    let reason = actionTypeRule.reason;

    return this.createDecisionFromIntent({
      intent,
      decisionResult,
      reason,
      appliedRules,
      riskLevel: this.mapRiskLevel(decisionResult),
      authorizationScope: mandate.allowedOperationTypes,
      policyVersion: mandate.policyVersion,
      requiredHumanApproval: decisionResult === AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL ? 'ProductOwner' : undefined,
    });
  }

  private evaluateActionType(actionType: DirectorActionType | 'IMPLEMENT_TASK', mandate: ProjectMandate): { result: AuthorizationDecisionResult; rule: string; reason: string } {
    // Some actions are strictly DENY by nature of their definition if they break invariants (none in director action types natively except if explicitly forbidden)
    
    // Check forbidden operations
    if (mandate.forbiddenOperations.includes(actionType)) {
      return {
        result: AuthorizationDecisionResult.DENY,
        rule: 'EXPLICITLY_FORBIDDEN_OPERATION',
        reason: `Action type '${actionType}' is explicitly forbidden by the project mandate.`
      };
    }

    if (mandate.humanApprovalRequiredOperations.includes(actionType)) {
      return {
        result: AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL,
        rule: 'EXPLICITLY_REQUIRES_HUMAN_APPROVAL',
        reason: `Action type '${actionType}' requires human approval according to the project mandate.`
      };
    }

    if (actionType === 'IMPLEMENT_TASK' || actionType === 'CREATE_CORRECTIVE_TASK' || actionType === 'CREATE_TASK' || actionType === 'REVIEW_EVIDENCE') {
      return {
        result: AuthorizationDecisionResult.ALLOW,
        rule: 'ROUTINE_TECHNICAL_OPERATION_ALLOWED',
        reason: 'Routine technical operations are automatically allowed under the current mandate.'
      };
    }

    if (actionType === 'REPLAN' || actionType === 'REQUEST_HUMAN_DECISION' || actionType === 'PROJECT_COMPLETE' || actionType === 'PAUSE' || actionType === 'STOP') {
      return {
        result: AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL,
        rule: 'STRATEGIC_OPERATION_REQUIRES_APPROVAL',
        reason: 'Strategic lifecycle and scope changes require human approval.'
      };
    }

    // Default DENY for unknown/unclassified operations
    return {
      result: AuthorizationDecisionResult.DENY,
      rule: 'UNKNOWN_OPERATION_DENIED',
      reason: `Action type '${actionType}' is not explicitly allowed and defaults to DENY.`
    };
  }

  private mapRiskLevel(result: AuthorizationDecisionResult): RiskLevel {
    switch (result) {
      case AuthorizationDecisionResult.ALLOW:
        return RiskLevel.SAFE;
      case AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL:
      case AuthorizationDecisionResult.WAITING_FOR_TRUSTED_IDENTITY:
      case AuthorizationDecisionResult.WAITING_FOR_POLICY_CONFIGURATION:
        return RiskLevel.CAUTION;
      case AuthorizationDecisionResult.DENY:
        return RiskLevel.CRITICAL;
      default:
        return RiskLevel.CRITICAL;
    }
  }

  private async createDecision(params: {
    action: DirectorActionEnvelope;
    decisionResult: AuthorizationDecisionResult;
    reason: string;
    appliedRules: string[];
    riskLevel: RiskLevel;
    authorizationScope?: string[];
    policyVersion?: number;
    requiredHumanApproval?: string;
  }): Promise<PolicyDecisionRecord> {
    const decisionId = `pdec-${crypto.randomUUID()}`;
    const decision: PolicyDecisionRecord = {
      policyDecisionId: decisionId,
      actionId: params.action.actionId,
      idempotencyKey: params.action.idempotencyKey,
      projectId: params.action.projectId,
      directorSessionId: params.action.directorSessionId,
      taskId: 'taskId' in params.action.payload ? String((params.action.payload as any).taskId) : '',
      taskRevision: 'expectedTaskRevision' in params.action.payload ? Number((params.action.payload as any).expectedTaskRevision) : 1,
      contextFingerprint: params.action.basedOnContextFingerprint,
      decisionResult: params.decisionResult,
      appliedRules: params.appliedRules,
      reason: params.reason,
      riskLevel: params.riskLevel,
      decisionTime: new Date().toISOString(),
      authorizationScope: params.authorizationScope ?? [],
      requiredHumanApproval: params.requiredHumanApproval,
      policyVersion: params.policyVersion ?? 1,
    };

    await this.historyManager.appendEvent({
      eventType: 'AUTHORIZATION_POLICY_DECISION',
      actor: 'DIRECTOR',
      taskId: decision.taskId || null,
      payload: { ...decision },
    });

    return decision;
  }

  private async createDecisionFromIntent(params: {
    intent: BridgeExecutionIntent;
    decisionResult: AuthorizationDecisionResult;
    reason: string;
    appliedRules: string[];
    riskLevel: RiskLevel;
    authorizationScope?: string[];
    policyVersion?: number;
    requiredHumanApproval?: string;
  }): Promise<PolicyDecisionRecord> {
    const decisionId = `pdec-${crypto.randomUUID()}`;
    const decision: PolicyDecisionRecord = {
      policyDecisionId: decisionId,
      actionId: params.intent.actionId,
      idempotencyKey: params.intent.idempotencyKey,
      projectId: params.intent.projectId,
      directorSessionId: params.intent.directorSessionId,
      taskId: params.intent.taskId,
      taskRevision: params.intent.taskRevision ?? 1,
      contextFingerprint: params.intent.basedOnContextFingerprint,
      decisionResult: params.decisionResult,
      appliedRules: params.appliedRules,
      reason: params.reason,
      riskLevel: params.riskLevel,
      decisionTime: new Date().toISOString(),
      authorizationScope: params.authorizationScope ?? [],
      requiredHumanApproval: params.requiredHumanApproval,
      policyVersion: params.policyVersion ?? 1,
    };

    await this.historyManager.appendEvent({
      eventType: 'AUTHORIZATION_POLICY_DECISION',
      actor: 'DIRECTOR',
      taskId: decision.taskId || null,
      payload: { ...decision },
    });

    return decision;
  }
}
