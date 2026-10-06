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

    // Anti-spoofing check: verify actor and role cannot be escalated
    if (action.actor !== 'DIRECTOR' || action.actorRole !== 'DIRECTOR') {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Actor impersonation rejected: actor must be DIRECTOR and actorRole must be DIRECTOR. Received actor='${action.actor}', actorRole='${action.actorRole}'.`,
        appliedRules: ['ANTI_SPOOFING_AUTHORITY_VIOLATION'],
        riskLevel: RiskLevel.CRITICAL,
      });
    }

    const payload = action.payload as Record<string, unknown> | undefined;
    if (payload) {
      if (
        payload.isTrustedHumanAuth === true ||
        payload.authStatus === 'VERIFIED_HUMAN' ||
        payload.actor === 'USER' ||
        payload.actorRole === 'PRODUCT_OWNER' ||
        payload.hasImplementationAuthority === true
      ) {
        return this.createDecision({
          action,
          decisionResult: AuthorizationDecisionResult.DENY,
          reason: 'Spoofed authority or unverified human claim detected in action payload. Rejected fail-closed.',
          appliedRules: ['ANTI_SPOOFING_AUTHORITY_VIOLATION'],
          riskLevel: RiskLevel.CRITICAL,
        });
      }
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

    const metadata = intent.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      if (
        metadata.isTrustedHumanAuth === true ||
        metadata.authStatus === 'VERIFIED_HUMAN' ||
        metadata.actor === 'USER' ||
        metadata.actorRole === 'PRODUCT_OWNER' ||
        metadata.hasImplementationAuthority === true
      ) {
        return this.createDecisionFromIntent({
          intent,
          decisionResult: AuthorizationDecisionResult.DENY,
          reason: 'Spoofed authority or unverified human claim detected in execution intent metadata. Rejected fail-closed.',
          appliedRules: ['ANTI_SPOOFING_AUTHORITY_VIOLATION'],
          riskLevel: RiskLevel.CRITICAL,
        });
      }
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
    // 1. Explicitly forbidden operation
    if (mandate.forbiddenOperations.includes(actionType)) {
      return {
        result: AuthorizationDecisionResult.DENY,
        rule: 'EXPLICITLY_FORBIDDEN_OPERATION',
        reason: `Action type '${actionType}' is explicitly forbidden by the project mandate.`
      };
    }

    // 2. Implementation actions requiring file modifications
    if (
      actionType === 'IMPLEMENT_TASK' ||
      actionType === 'RETRY_TASK' ||
      actionType === 'CORRECT_TASK'
    ) {
      if (
        mandate.forbiddenOperations.includes('FILE_MODIFY') ||
        mandate.forbiddenOperations.includes('IMPLEMENTATION')
      ) {
        return {
          result: AuthorizationDecisionResult.DENY,
          rule: 'EXPLICITLY_FORBIDDEN_OPERATION',
          reason: `Action type '${actionType}' requires file modifications, which are forbidden by the project mandate.`
        };
      }

      if (
        mandate.allowedOperationTypes.length > 0 &&
        !mandate.allowedOperationTypes.includes('FILE_MODIFY') &&
        !mandate.allowedOperationTypes.includes('IMPLEMENTATION')
      ) {
        return {
          result: AuthorizationDecisionResult.DENY,
          rule: 'OPERATION_NOT_ALLOWED',
          reason: `Action type '${actionType}' requires file modification permissions not granted in allowedOperationTypes.`
        };
      }
    }

    // 3. Human approval required by mandate
    if (mandate.humanApprovalRequiredOperations.includes(actionType)) {
      return {
        result: AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL,
        rule: 'EXPLICITLY_REQUIRES_HUMAN_APPROVAL',
        reason: `Action type '${actionType}' requires human approval according to the project mandate.`
      };
    }

    // 4. Recognized Director Action Types
    const recognizedActionTypes = new Set<string>([
      'ANALYZE_PROJECT',
      'DISCOVER_PROJECT',
      'REQUEST_CLARIFICATION',
      'ACCEPT_CONTEXT',
      'REJECT_CONTEXT',
      'REQUEST_PLANNING',
      'SELECT_TASK',
      'UPDATE_PLAN',
      'REPLAN',
      'DEFER',
      'IMPLEMENT_TASK',
      'RETRY_TASK',
      'CORRECT_TASK',
      'CREATE_TASK',
      'CREATE_CORRECTIVE_TASK',
      'REVIEW_EVIDENCE',
      'ACCEPT_TASK',
      'REJECT_TASK',
      'BLOCK',
      'REQUEST_HUMAN_DECISION',
      'RESUME',
      'DECLARE_PROJECT_COMPLETE',
      'PROJECT_COMPLETE',
      'PAUSE',
      'STOP',
    ]);

    if (recognizedActionTypes.has(actionType)) {
      return {
        result: AuthorizationDecisionResult.ALLOW,
        rule: 'RECOGNIZED_ACTION_ROUTED_TO_GATE',
        reason: `Action type '${actionType}' routed to authoritative dispatcher gate.`
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
