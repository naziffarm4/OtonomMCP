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
import { SpecStore } from '../storage/spec-store.js';
import { SystemExecutionEvidenceStore } from '../storage/evidence-store.js';

export interface AuthorizationPolicyEngineOptions {
  historyManager: HistoryManager;
  mandateStore: ProjectMandateStore;
  specStore?: SpecStore;
  evidenceStore?: SystemExecutionEvidenceStore;
}

export class AuthorizationPolicyEngine {
  private readonly historyManager: HistoryManager;
  private readonly mandateStore: ProjectMandateStore;
  private readonly specStore?: SpecStore;
  private readonly evidenceStore?: SystemExecutionEvidenceStore;

  constructor(options: AuthorizationPolicyEngineOptions) {
    this.historyManager = options.historyManager;
    this.mandateStore = options.mandateStore;
    this.specStore = options.specStore;
    this.evidenceStore = options.evidenceStore;
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
        policyVersion: 1,
        mandateRevision: 1,
      });
    }

    if (mandate.projectId !== action.projectId) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Cross-project action evaluation attempt. Mandate project: ${mandate.projectId}, Action project: ${action.projectId}`,
        appliedRules: ['PROJECT_ISOLATION_VIOLATION'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    const now = Date.now();
    const startTime = Date.parse(mandate.authorizationStartTime);
    const endTime = Date.parse(mandate.authorizationEndTime);

    if (Number.isNaN(startTime) || Number.isNaN(endTime) || now < startTime || now > endTime) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Current time is outside the project mandate authorization window.`,
        appliedRules: ['MANDATE_EXPIRED_OR_NOT_STARTED'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    const expectedRevision =
      (action.payload as any)?.expectedMandateRevision ??
      (action as any).expectedMandateRevision ??
      (action as any).metadata?.expectedMandateRevision;
    if (expectedRevision !== undefined && expectedRevision !== mandate.mandateRevision) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Mandate revision mismatch. Expected: ${expectedRevision}, Actual: ${mandate.mandateRevision}`,
        appliedRules: ['MANDATE_REVISION_MISMATCH'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    const expectedPolicyVersion =
      (action.payload as any)?.expectedPolicyVersion ??
      (action as any).expectedPolicyVersion ??
      (action as any).metadata?.expectedPolicyVersion;
    if (expectedPolicyVersion !== undefined && expectedPolicyVersion !== mandate.policyVersion) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Policy version mismatch. Expected: ${expectedPolicyVersion}, Actual: ${mandate.policyVersion}`,
        appliedRules: ['POLICY_VERSION_MISMATCH'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
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
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    if (
      (action as any).hasImplementationAuthority === true ||
      (action as any).isDevelopmentAuthorized === true ||
      (action as any).autoExecutable === true ||
      (action as any).isAutoExecutable === true ||
      (action as any).trusted === true ||
      (action as any).approved === true
    ) {
      return this.createDecision({
        action,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: 'Director cannot self-authorize or escalate implementation authority. Rejected fail-closed.',
        appliedRules: ['ANTI_SPOOFING_AUTHORITY_VIOLATION'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    const payload = action.payload as Record<string, unknown> | undefined;
    if (payload) {
      if (
        payload.isTrustedHumanAuth === true ||
        payload.authStatus === 'VERIFIED_HUMAN' ||
        payload.actor === 'USER' ||
        payload.actorRole === 'PRODUCT_OWNER' ||
        payload.hasImplementationAuthority === true ||
        payload.isDevelopmentAuthorized === true ||
        payload.claimImplementationAuthority === true ||
        payload.selfApproved === true ||
        payload.autoExecutable === true ||
        payload.isAutoExecutable === true ||
        payload.taskClass !== undefined ||
        payload.taskCategory !== undefined ||
        payload.trusted === true ||
        payload.approved === true ||
        payload.isSystemVerified === true ||
        payload.syntheticEvidence !== undefined ||
        payload.mockEvidence !== undefined
      ) {
        return this.createDecision({
          action,
          decisionResult: AuthorizationDecisionResult.DENY,
          reason: 'Spoofed authority, unverified human claim, or synthetic evidence detected in action payload. Rejected fail-closed.',
          appliedRules: ['ANTI_SPOOFING_AUTHORITY_VIOLATION'],
          riskLevel: RiskLevel.CRITICAL,
          policyVersion: mandate.policyVersion,
          mandateRevision: mandate.mandateRevision,
        });
      }
    }

    // Evaluate action against mandate rules and operation semantics
    const actionRuleResult = await this.evaluateActionRules(action, mandate);

    const decisionResult = actionRuleResult.result;
    const appliedRules = actionRuleResult.appliedRules;
    const reason = actionRuleResult.reason;

    return this.createDecision({
      action,
      decisionResult,
      reason,
      appliedRules,
      riskLevel: this.mapRiskLevel(decisionResult),
      authorizationScope: mandate.allowedOperationTypes,
      policyVersion: mandate.policyVersion,
      mandateRevision: mandate.mandateRevision,
      requiredHumanApproval:
        decisionResult === AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL ? 'ProductOwner' : undefined,
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
        policyVersion: 1,
        mandateRevision: 1,
      });
    }

    if (mandate.projectId !== intent.projectId) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Cross-project intent evaluation attempt. Mandate project: ${mandate.projectId}, Intent project: ${intent.projectId}`,
        appliedRules: ['PROJECT_ISOLATION_VIOLATION'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    const now = Date.now();
    const startTime = Date.parse(mandate.authorizationStartTime);
    const endTime = Date.parse(mandate.authorizationEndTime);

    if (Number.isNaN(startTime) || Number.isNaN(endTime) || now < startTime || now > endTime) {
      return this.createDecisionFromIntent({
        intent,
        decisionResult: AuthorizationDecisionResult.DENY,
        reason: `Current time is outside the project mandate authorization window.`,
        appliedRules: ['MANDATE_EXPIRED_OR_NOT_STARTED'],
        riskLevel: RiskLevel.CRITICAL,
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
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
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
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
        policyVersion: mandate.policyVersion,
        mandateRevision: mandate.mandateRevision,
      });
    }

    const metadata = intent.metadata as Record<string, unknown> | undefined;
    if (metadata) {
      if (
        metadata.isTrustedHumanAuth === true ||
        metadata.authStatus === 'VERIFIED_HUMAN' ||
        metadata.actor === 'USER' ||
        metadata.actorRole === 'PRODUCT_OWNER' ||
        metadata.hasImplementationAuthority === true ||
        metadata.isDevelopmentAuthorized === true ||
        metadata.claimImplementationAuthority === true ||
        metadata.selfApproved === true ||
        metadata.autoExecutable === true ||
        metadata.isAutoExecutable === true ||
        metadata.taskClass !== undefined ||
        metadata.taskCategory !== undefined ||
        metadata.trusted === true ||
        metadata.approved === true
      ) {
        return this.createDecisionFromIntent({
          intent,
          decisionResult: AuthorizationDecisionResult.DENY,
          reason: 'Spoofed authority or unverified human claim detected in execution intent metadata. Rejected fail-closed.',
          appliedRules: ['ANTI_SPOOFING_AUTHORITY_VIOLATION'],
          riskLevel: RiskLevel.CRITICAL,
          policyVersion: mandate.policyVersion,
          mandateRevision: mandate.mandateRevision,
        });
      }
    }

    const intentRuleResult = await this.evaluateExecutionIntentRules(intent, mandate);

    const decisionResult = intentRuleResult.result;
    const appliedRules = intentRuleResult.appliedRules;
    const reason = intentRuleResult.reason;

    return this.createDecisionFromIntent({
      intent,
      decisionResult,
      reason,
      appliedRules,
      riskLevel: this.mapRiskLevel(decisionResult),
      authorizationScope: mandate.allowedOperationTypes,
      policyVersion: mandate.policyVersion,
      mandateRevision: mandate.mandateRevision,
      requiredHumanApproval:
        decisionResult === AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL ? 'ProductOwner' : undefined,
    });
  }

  /**
   * Evaluates action against ProjectMandate policies, operation permissions, and security invariants.
   */
  private async evaluateActionRules(
    action: DirectorActionEnvelope,
    mandate: ProjectMandate
  ): Promise<{
    result: AuthorizationDecisionResult;
    appliedRules: string[];
    reason: string;
  }> {
    const requiredOperations: string[] = [action.actionType];
    const payloadObj = (action.payload ?? {}) as Record<string, unknown>;

    if (typeof payloadObj.operationType === 'string' && payloadObj.operationType.trim().length > 0) {
      requiredOperations.push(payloadObj.operationType.trim());
    }

    if (
      action.actionType === 'IMPLEMENT_TASK' ||
      action.actionType === 'RETRY_TASK' ||
      action.actionType === 'CORRECT_TASK'
    ) {
      requiredOperations.push('FILE_MODIFY');
      requiredOperations.push('IMPLEMENTATION');

      const plan = String(payloadObj.executionPlan ?? '').toLowerCase();
      if (plan.includes('test') || plan.includes('npm test') || plan.includes('pnpm test')) {
        requiredOperations.push('TEST_EXECUTION');
      }
      if (plan.includes('build') || plan.includes('npm run build') || plan.includes('pnpm build')) {
        requiredOperations.push('BUILD_EXECUTION');
      }
    } else if (action.actionType === 'CREATE_TASK' || action.actionType === 'CREATE_CORRECTIVE_TASK') {
      requiredOperations.push('FILE_CREATE');
      requiredOperations.push('TASK_CREATE');
    } else if (action.actionType === 'REVIEW_EVIDENCE') {
      requiredOperations.push('FILE_READ');
      requiredOperations.push('READ_ONLY_INSPECTION');
      requiredOperations.push('EVIDENCE_REVIEW');
    } else if (
      action.actionType === 'ANALYZE_PROJECT' ||
      action.actionType === 'DISCOVER_PROJECT' ||
      action.actionType === 'ACCEPT_CONTEXT' ||
      action.actionType === 'REJECT_CONTEXT'
    ) {
      requiredOperations.push('FILE_READ');
      requiredOperations.push('READ_ONLY_INSPECTION');
    }

    // 1. Directory Access Restriction Check (if targetFiles are present)
    if (
      Array.isArray(payloadObj.targetFiles) &&
      payloadObj.targetFiles.length > 0 &&
      mandate.allowedDirectories &&
      mandate.allowedDirectories.length > 0
    ) {
      for (const file of payloadObj.targetFiles) {
        if (typeof file === 'string') {
          const normalized = file.replace(/\\/g, '/');
          const isAllowed = mandate.allowedDirectories.some((dir) => {
            const normDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
            return normalized.startsWith(normDir + '/') || normalized === normDir;
          });
          if (!isAllowed) {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['DIRECTORY_ACCESS_FORBIDDEN'],
              reason: `Target file '${file}' is outside allowed directories: [${mandate.allowedDirectories.join(', ')}].`,
            };
          }
        }
      }
    }

    // 2. Explicitly Forbidden Operations (PRECEDENCE: FORBIDDEN > HUMAN_APPROVAL > ALLOW)
    for (const op of requiredOperations) {
      if (mandate.forbiddenOperations.includes(op)) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['EXPLICITLY_FORBIDDEN_OPERATION'],
          reason: `Operation '${op}' required by action '${action.actionType}' is explicitly forbidden by the project mandate.`,
        };
      }
    }

    // 3. Human Approval Required Operations (PRECEDENCE: HUMAN_APPROVAL > ALLOW)
    for (const op of requiredOperations) {
      if (mandate.humanApprovalRequiredOperations.includes(op)) {
        return {
          result: AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL,
          appliedRules: ['EXPLICITLY_REQUIRES_HUMAN_APPROVAL'],
          reason: `Action '${action.actionType}' (requiring '${op}') requires human approval according to the project mandate.`,
        };
      }
    }

    // 4. Recognized Action Types Check
    const recognizedActionTypes = new Set<string>([
      'IMPLEMENT_TASK',
      'RETRY_TASK',
      'CORRECT_TASK',
      'CREATE_TASK',
      'CREATE_CORRECTIVE_TASK',
      'REPLAN',
      'REVIEW_EVIDENCE',
      'REQUEST_HUMAN_DECISION',
      'REQUEST_CLARIFICATION',
      'DECLARE_PROJECT_COMPLETE',
      'PROJECT_COMPLETE',
      'PAUSE',
      'STOP',
      'BLOCK',
      'RESUME',
      'REQUEST_PLANNING',
      'SELECT_TASK',
      'UPDATE_PLAN',
      'DEFER',
      'ACCEPT_TASK',
      'REJECT_TASK',
      'ANALYZE_PROJECT',
      'DISCOVER_PROJECT',
      'ACCEPT_CONTEXT',
      'REJECT_CONTEXT',
    ]);

    if (!recognizedActionTypes.has(action.actionType)) {
      return {
        result: AuthorizationDecisionResult.DENY,
        appliedRules: ['UNKNOWN_OPERATION_DENIED'],
        reason: `Action type '${action.actionType}' is not recognized and defaults to DENY.`,
      };
    }

    // 4. Allowed Operations Check (Mandate permission must exist)
    if (!mandate.allowedOperationTypes || mandate.allowedOperationTypes.length === 0) {
      return {
        result: AuthorizationDecisionResult.DENY,
        appliedRules: ['OPERATION_NOT_ALLOWED'],
        reason: `Project mandate has no allowedOperationTypes configured. All operations fail-closed.`,
      };
    }

    if (
      action.actionType === 'IMPLEMENT_TASK' ||
      action.actionType === 'RETRY_TASK' ||
      action.actionType === 'CORRECT_TASK'
    ) {
      const hasFileModify =
        mandate.allowedOperationTypes.includes('FILE_MODIFY') ||
        mandate.allowedOperationTypes.includes('IMPLEMENTATION') ||
        mandate.allowedOperationTypes.includes(action.actionType);
      if (!hasFileModify) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action type '${action.actionType}' requires 'FILE_MODIFY' or 'IMPLEMENTATION' permission, which is not granted in allowedOperationTypes.`,
        };
      }

      if (requiredOperations.includes('FILE_CREATE') && !mandate.allowedOperationTypes.includes('FILE_CREATE')) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action '${action.actionType}' requires 'FILE_CREATE' permission not granted in allowedOperationTypes.`,
        };
      }

      if (requiredOperations.includes('TEST_EXECUTION') && !mandate.allowedOperationTypes.includes('TEST_EXECUTION')) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action '${action.actionType}' requires 'TEST_EXECUTION' permission not granted in allowedOperationTypes.`,
        };
      }

      if (requiredOperations.includes('BUILD_EXECUTION') && !mandate.allowedOperationTypes.includes('BUILD_EXECUTION')) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action '${action.actionType}' requires 'BUILD_EXECUTION' permission not granted in allowedOperationTypes.`,
        };
      }
    } else if (action.actionType === 'CREATE_TASK' || action.actionType === 'CREATE_CORRECTIVE_TASK') {
      const hasTaskCreate =
        mandate.allowedOperationTypes.includes('FILE_CREATE') ||
        mandate.allowedOperationTypes.includes('TASK_CREATE') ||
        mandate.allowedOperationTypes.includes('PLANNING') ||
        mandate.allowedOperationTypes.includes('IMPLEMENTATION') ||
        mandate.allowedOperationTypes.includes(action.actionType);
      if (!hasTaskCreate) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action type '${action.actionType}' requires 'FILE_CREATE' or 'TASK_CREATE' permission not granted in allowedOperationTypes.`,
        };
      }
    } else if (action.actionType === 'REVIEW_EVIDENCE') {
      const hasReviewPerm =
        mandate.allowedOperationTypes.includes('FILE_READ') ||
        mandate.allowedOperationTypes.includes('READ_ONLY_INSPECTION') ||
        mandate.allowedOperationTypes.includes('EVIDENCE_REVIEW') ||
        mandate.allowedOperationTypes.includes('REVIEW_EVIDENCE');
      if (!hasReviewPerm) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action type 'REVIEW_EVIDENCE' requires 'FILE_READ' or 'READ_ONLY_INSPECTION' permission not granted in allowedOperationTypes.`,
        };
      }
    } else {
      const isPermitted =
        mandate.allowedOperationTypes.includes(action.actionType) ||
        mandate.allowedOperationTypes.includes('PLANNING') ||
        mandate.allowedOperationTypes.includes('READ_ONLY_INSPECTION') ||
        mandate.allowedOperationTypes.includes('FILE_READ');
      if (!isPermitted) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['OPERATION_NOT_ALLOWED'],
          reason: `Action type '${action.actionType}' is not permitted by allowedOperationTypes.`,
        };
      }
    }

    // 5. Auto-Executable Task Class Check
    if (
      action.actionType === 'IMPLEMENT_TASK' ||
      action.actionType === 'RETRY_TASK' ||
      action.actionType === 'CORRECT_TASK'
    ) {
      if (mandate.autoExecutableTaskClasses !== undefined) {
        if (mandate.autoExecutableTaskClasses.length === 0) {
          return {
            result: AuthorizationDecisionResult.DENY,
            appliedRules: ['TASK_CLASS_NOT_AUTO_EXECUTABLE'],
            reason: 'mandate.autoExecutableTaskClasses is empty. No automated execution permitted.',
          };
        }

        let taskClass = 'IMPLEMENTATION';
        const taskId = String(payloadObj.taskId ?? '');

        if (this.specStore && taskId) {
          try {
            const tasks = await this.specStore.loadTasks();
            const found = tasks.find((t) => t.task_id === taskId);
            if (found) {
              taskClass = String(found.metadata?.taskClass ?? found.metadata?.category ?? 'IMPLEMENTATION');
            }
          } catch {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['AUTHORITATIVE_TASK_LOOKUP_FAILED'],
              reason: 'Failed to load authoritative task definition from SpecStore. Fail-closed.',
            };
          }
        }

        if (!mandate.autoExecutableTaskClasses.includes(taskClass)) {
          return {
            result: AuthorizationDecisionResult.DENY,
            appliedRules: ['TASK_CLASS_NOT_AUTO_EXECUTABLE'],
            reason: `Task class '${taskClass}' is not in mandate autoExecutableTaskClasses: [${mandate.autoExecutableTaskClasses.join(', ')}].`,
          };
        }
      }
    }

    // 6. REVIEW_EVIDENCE Independent Verification Check
    if (action.actionType === 'REVIEW_EVIDENCE') {
      const evidenceIds = payloadObj.evidenceIds;
      const targetTaskId = String(payloadObj.taskId ?? '');

      if (!Array.isArray(evidenceIds) || evidenceIds.length === 0 || !targetTaskId) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['INVALID_EVIDENCE_REFERENCE'],
          reason: 'REVIEW_EVIDENCE requires non-empty evidenceIds array and valid taskId.',
        };
      }

      if (this.evidenceStore) {
        for (const evId of evidenceIds) {
          if (typeof evId !== 'string' || !evId.trim()) {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['INVALID_EVIDENCE_REFERENCE'],
              reason: 'Invalid or empty evidenceId in REVIEW_EVIDENCE.',
            };
          }

          let evidence;
          try {
            evidence = await this.evidenceStore.loadEvidence(evId.trim());
          } catch {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['INVALID_EVIDENCE_REFERENCE'],
              reason: `Evidence '${evId}' could not be loaded from EvidenceStore. Fail-closed.`,
            };
          }

          if (!evidence) {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['INVALID_EVIDENCE_REFERENCE'],
              reason: `Evidence '${evId}' does not exist in authoritative EvidenceStore. Missing evidence rejected fail-closed.`,
            };
          }

          if (evidence.projectId !== action.projectId) {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['PROJECT_ISOLATION_VIOLATION'],
              reason: `Cross-project evidence reference rejected. Evidence project: '${evidence.projectId}', Action project: '${action.projectId}'.`,
            };
          }

          if (evidence.taskId !== targetTaskId) {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['EVIDENCE_TASK_MISMATCH'],
              reason: `Evidence '${evId}' belongs to task '${evidence.taskId}', but action targets task '${targetTaskId}'.`,
            };
          }

          const isVerified =
            (evidence as any).isSystemVerified === true ||
            evidence.verificationDecision === 'ACCEPT' ||
            evidence.verificationDecision === 'REJECT' ||
            evidence.verificationDecision === 'BLOCK';
          if (!isVerified) {
            return {
              result: AuthorizationDecisionResult.DENY,
              appliedRules: ['UNVERIFIED_EVIDENCE_REJECTED'],
              reason: `Evidence '${evId}' is not independently system-verified.`,
            };
          }
        }
      }
    }

    return {
      result: AuthorizationDecisionResult.ALLOW,
      appliedRules: ['MANDATE_OPERATION_AUTHORIZED'],
      reason: `Action type '${action.actionType}' is authorized under the current project mandate.`,
    };
  }

  /**
   * Evaluates an execution intent against ProjectMandate rules and constraints.
   */
  private async evaluateExecutionIntentRules(
    intent: BridgeExecutionIntent,
    mandate: ProjectMandate
  ): Promise<{
    result: AuthorizationDecisionResult;
    appliedRules: string[];
    reason: string;
  }> {
    const requiredOperations = ['IMPLEMENT_TASK', 'FILE_MODIFY', 'IMPLEMENTATION'];

    const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.operationType === 'string' && metadata.operationType.trim().length > 0) {
      requiredOperations.push(metadata.operationType.trim());
    }

    const plan = String(intent.executionPlan ?? '').toLowerCase();
    if (plan.includes('test') || plan.includes('npm test') || plan.includes('pnpm test')) {
      requiredOperations.push('TEST_EXECUTION');
    }
    if (plan.includes('build') || plan.includes('npm run build') || plan.includes('pnpm build')) {
      requiredOperations.push('BUILD_EXECUTION');
    }

    // 1. Explicitly forbidden operation (PRECEDENCE: FORBIDDEN > HUMAN_APPROVAL > ALLOW)
    for (const op of requiredOperations) {
      if (mandate.forbiddenOperations.includes(op)) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['EXPLICITLY_FORBIDDEN_OPERATION'],
          reason: `Operation '${op}' is explicitly forbidden by the project mandate.`,
        };
      }
    }

    // 2. Human approval required by mandate
    for (const op of requiredOperations) {
      if (mandate.humanApprovalRequiredOperations.includes(op)) {
        return {
          result: AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL,
          appliedRules: ['EXPLICITLY_REQUIRES_HUMAN_APPROVAL'],
          reason: `Execution intent requiring '${op}' requires human approval according to the project mandate.`,
        };
      }
    }

    // 3. Allowed operations check
    if (!mandate.allowedOperationTypes || mandate.allowedOperationTypes.length === 0) {
      return {
        result: AuthorizationDecisionResult.DENY,
        appliedRules: ['OPERATION_NOT_ALLOWED'],
        reason: 'Project mandate allowedOperationTypes is empty; execution intent cannot proceed.',
      };
    }

    const hasFileModify =
      mandate.allowedOperationTypes.includes('FILE_MODIFY') ||
      mandate.allowedOperationTypes.includes('IMPLEMENTATION') ||
      mandate.allowedOperationTypes.includes('IMPLEMENT_TASK');
    if (!hasFileModify) {
      return {
        result: AuthorizationDecisionResult.DENY,
        appliedRules: ['OPERATION_NOT_ALLOWED'],
        reason:
          'Execution intent requires FILE_MODIFY or IMPLEMENTATION permission, which is not granted in allowedOperationTypes.',
      };
    }

    if (requiredOperations.includes('TEST_EXECUTION') && !mandate.allowedOperationTypes.includes('TEST_EXECUTION')) {
      return {
        result: AuthorizationDecisionResult.DENY,
        appliedRules: ['OPERATION_NOT_ALLOWED'],
        reason: "Execution intent requires 'TEST_EXECUTION' permission not granted in allowedOperationTypes.",
      };
    }

    if (requiredOperations.includes('BUILD_EXECUTION') && !mandate.allowedOperationTypes.includes('BUILD_EXECUTION')) {
      return {
        result: AuthorizationDecisionResult.DENY,
        appliedRules: ['OPERATION_NOT_ALLOWED'],
        reason: "Execution intent requires 'BUILD_EXECUTION' permission not granted in allowedOperationTypes.",
      };
    }

    // 4. Auto executable task class check
    if (mandate.autoExecutableTaskClasses !== undefined) {
      if (mandate.autoExecutableTaskClasses.length === 0) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['TASK_CLASS_NOT_AUTO_EXECUTABLE'],
          reason: 'mandate.autoExecutableTaskClasses is empty; automated intent execution is not permitted.',
        };
      }

      let taskClass = 'IMPLEMENTATION';
      if (this.specStore && intent.taskId) {
        try {
          const tasks = await this.specStore.loadTasks();
          const found = tasks.find((t) => t.task_id === intent.taskId);
          if (found) {
            taskClass = String(found.metadata?.taskClass ?? found.metadata?.category ?? 'IMPLEMENTATION');
          }
        } catch {
          return {
            result: AuthorizationDecisionResult.DENY,
            appliedRules: ['AUTHORITATIVE_TASK_LOOKUP_FAILED'],
            reason: 'Failed to load authoritative task state from SpecStore. Fail-closed.',
          };
        }
      }

      if (!mandate.autoExecutableTaskClasses.includes(taskClass)) {
        return {
          result: AuthorizationDecisionResult.DENY,
          appliedRules: ['TASK_CLASS_NOT_AUTO_EXECUTABLE'],
          reason: `Task class '${taskClass}' is not in mandate autoExecutableTaskClasses: [${mandate.autoExecutableTaskClasses.join(', ')}].`,
        };
      }
    }

    return {
      result: AuthorizationDecisionResult.ALLOW,
      appliedRules: ['MANDATE_OPERATION_AUTHORIZED', 'ROUTINE_TECHNICAL_OPERATION_ALLOWED'],
      reason: 'Execution intent is authorized under the current project mandate.',
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
    mandateRevision?: number;
    requiredHumanApproval?: string;
  }): Promise<PolicyDecisionRecord> {
    const decisionId = `pdec-${crypto.randomUUID()}`;
    const payloadObj = (params.action.payload ?? {}) as Record<string, unknown>;
    const decision: PolicyDecisionRecord = {
      policyDecisionId: decisionId,
      actionId: params.action.actionId,
      idempotencyKey: params.action.idempotencyKey,
      projectId: params.action.projectId,
      directorSessionId: params.action.directorSessionId,
      taskId: 'taskId' in payloadObj ? String(payloadObj.taskId ?? '') : '',
      taskRevision: 'expectedTaskRevision' in payloadObj ? Number(payloadObj.expectedTaskRevision) : 1,
      contextFingerprint: params.action.basedOnContextFingerprint,
      actionType: params.action.actionType,
      decisionResult: params.decisionResult,
      appliedRules: params.appliedRules,
      reason: params.reason,
      riskLevel: params.riskLevel,
      decisionTime: new Date().toISOString(),
      authorizationScope: params.authorizationScope ?? [],
      requiredHumanApproval: params.requiredHumanApproval,
      policyVersion: params.policyVersion ?? 1,
      mandateRevision: params.mandateRevision ?? 1,
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
    mandateRevision?: number;
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
      actionType: 'IMPLEMENT_TASK',
      decisionResult: params.decisionResult,
      appliedRules: params.appliedRules,
      reason: params.reason,
      riskLevel: params.riskLevel,
      decisionTime: new Date().toISOString(),
      authorizationScope: params.authorizationScope ?? [],
      requiredHumanApproval: params.requiredHumanApproval,
      policyVersion: params.policyVersion ?? 1,
      mandateRevision: params.mandateRevision ?? 1,
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
