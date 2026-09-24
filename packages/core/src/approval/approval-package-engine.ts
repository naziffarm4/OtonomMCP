/**
 * Project Approval Package & Gate Engine (Phase 8 TASK-P8-05)
 *
 * Implements the authoritative protocol boundary where:
 * 1. Initial project understanding and proposed plan are assembled into a versioned approval package.
 * 2. Readiness conditions are evaluated (blocking clarifications, contradictions, structural completeness).
 * 3. Explicit human Product Owner approval or rejection is enforced with cryptographic revision binding.
 * 4. Development authorization is governed: unauthorized until explicitly approved by Product Owner.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. The system MUST NOT infer approval (no natural language "tamam" or implicit signals).
 * 2. Clarification answers are NOT approval.
 * 3. Approval is strictly bound to exact package revision (immutable per revision).
 * 4. Only human / Product Owner authority can approve; executor/antigravity/system rejected.
 * 5. Does NOT mutate authoritative requirements (SpecStore) or Task DAG.
 * 6. Does NOT invoke Antigravity or autonomous development loop (belong to P10).
 * 7. Does NOT create a second FSM; respects DurableStateManager authority.
 */

import * as crypto from 'node:crypto';
import type { ClarificationSession } from '../clarification/clarification-types.js';
import {
  type InitialProjectUnderstanding,
  type ProposedDevelopmentPlan,
  type ProjectApprovalPackage,
  type ProjectApprovalStatus,
  type ApprovalReadiness,
  type ProjectApprovalInput,
  type ProjectRejectionInput,
  type ProjectApprovalRecord,
  type ProjectRejectionRecord,
  FORBIDDEN_APPROVAL_ACTORS,
  ProjectApprovalPackageZodSchema,
} from './approval-types.js';
import {
  ApprovalAuthorizationError,
  ApprovalRevisionMismatchError,
  ApprovalInvalidIntentError,
  ApprovalNotReadyError,
  ApprovalAlreadyDecidedError,
  ApprovalValidationError,
} from './approval-errors.js';

export interface CreatePackageOptions {
  readonly packageId?: string;
  readonly clarificationSession?: ClarificationSession;
}

/**
 * Computes a deterministic SHA-256 hash of the approval package content
 * for tamper-evident binding of approvals to exact package revisions.
 */
export function computePackageHash(pkg: {
  packageId: string;
  revision: number;
  projectId: string;
  projectUnderstanding: InitialProjectUnderstanding;
  proposedDevelopmentPlan: ProposedDevelopmentPlan;
}): string {
  const canonicalData = {
    packageId: pkg.packageId,
    revision: pkg.revision,
    projectId: pkg.projectId,
    sourceDiscovery: pkg.projectUnderstanding.sourceDiscoveryReference,
    confirmedRequirementsCount: pkg.projectUnderstanding.confirmedRequirements.length,
    clarifiedRequirementsCount: pkg.projectUnderstanding.clarifiedRequirements.length,
    unresolvedUnknownsCount: pkg.projectUnderstanding.unresolvedUnknowns.length,
    unresolvedContradictionsCount: pkg.projectUnderstanding.unresolvedContradictions.length,
    objectives: pkg.proposedDevelopmentPlan.objectives,
    proposedScope: pkg.proposedDevelopmentPlan.proposedScope,
    featureGroupsCount: pkg.proposedDevelopmentPlan.proposedFeatureGroups.length,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalData)).digest('hex');
}

export class ApprovalPackageEngine {
  /**
   * Evaluates the 5 mandatory readiness conditions for an approval package:
   * 1. Discovery exists.
   * 2. Required/blocking clarification items are resolved.
   * 3. No unresolved blocking contradiction remains.
   * 4. Understanding package is internally valid.
   * 5. Proposed plan is structurally complete.
   */
  checkReadiness(
    understanding: InitialProjectUnderstanding,
    proposedPlan: ProposedDevelopmentPlan,
    clarificationSession?: ClarificationSession
  ): ApprovalReadiness {
    const reasons: string[] = [];

    // Condition 1: Discovery exists
    const discoveryMissing =
      !understanding.sourceDiscoveryReference ||
      understanding.sourceDiscoveryReference.trim().length === 0;
    if (discoveryMissing) {
      reasons.push('Discovery report is missing or invalid; discovery must precede approval.');
    }

    // Condition 2: Blocking clarifications resolved
    let unresolvedBlockingClarifications = false;
    if (clarificationSession) {
      const hasOpenBlocking =
        clarificationSession.blockingOpenCount > 0 ||
        clarificationSession.status === 'WAITING_FOR_HUMAN' ||
        clarificationSession.status === 'BLOCKED';

      const hasBlockingUnansweredQuestion = clarificationSession.questions.some(
        (q) =>
          q.blocking &&
          q.status !== 'ANSWERED' &&
          (!q.answer || q.answer.status !== 'ANSWERED')
      );

      if (hasOpenBlocking || hasBlockingUnansweredQuestion) {
        unresolvedBlockingClarifications = true;
        reasons.push(
          `Clarification session '${clarificationSession.sessionId}' has unresolved blocking questions.`
        );
      }
    }

    // Condition 3: No unresolved blocking contradictions
    const unresolvedBlockingContradictions =
      understanding.unresolvedContradictions &&
      understanding.unresolvedContradictions.length > 0;
    if (unresolvedBlockingContradictions) {
      reasons.push(
        `Project has ${understanding.unresolvedContradictions.length} unresolved blocking contradiction(s).`
      );
    }

    // Condition 4: Understanding package is internally valid
    const understandingInvalid =
      !understanding.projectId ||
      !understanding.projectName ||
      !understanding.technologyStack ||
      !understanding.architectureSummary;
    if (understandingInvalid) {
      reasons.push('Initial project understanding is internally incomplete or invalid.');
    }

    // Condition 5: Proposal is structurally complete
    const proposalIncomplete =
      !proposedPlan.objectives ||
      proposedPlan.objectives.length === 0 ||
      !proposedPlan.proposedScope ||
      proposedPlan.proposedScope.length === 0 ||
      !proposedPlan.proposedFeatureGroups ||
      proposedPlan.proposedFeatureGroups.length === 0;
    if (proposalIncomplete) {
      reasons.push(
        'Proposed development plan is structurally incomplete (must have objectives, proposedScope, and feature groups).'
      );
    }

    const isReady =
      !discoveryMissing &&
      !unresolvedBlockingClarifications &&
      !unresolvedBlockingContradictions &&
      !understandingInvalid &&
      !proposalIncomplete;

    return Object.freeze({
      isReady,
      status: isReady ? 'READY_FOR_APPROVAL' : 'NOT_READY',
      reasons: Object.freeze(reasons),
      blockingConditions: Object.freeze({
        discoveryMissing,
        unresolvedBlockingClarifications,
        unresolvedBlockingContradictions,
        understandingInvalid,
        proposalIncomplete,
      }),
    });
  }

  /**
   * Constructs a default, structurally complete proposed development plan
   * from the project understanding without mutating the Task DAG.
   */
  createDefaultProposedPlan(
    understanding: InitialProjectUnderstanding
  ): ProposedDevelopmentPlan {
    const objectives: string[] = [
      `Implement and verify development scope for ${understanding.projectName}`,
      'Establish authoritative requirements and architecture baselines',
      'Execute development under full verification and test coverage',
    ];

    const proposedScope: string[] =
      understanding.proposedDevelopmentScope.length > 0
        ? [...understanding.proposedDevelopmentScope]
        : ['Baseline core capabilities'];

    const proposedFeatureGroups = [
      {
        name: 'Core Capabilities',
        description: `Primary features discovered for ${understanding.projectName}`,
        targetCapabilities: proposedScope,
      },
    ];

    const knownRisks = understanding.unresolvedUnknowns.map(
      (u) => `${u.item}: ${u.impact}`
    );

    const unresolvedIssues = understanding.unresolvedContradictions.map(
      (c) => c.description
    );

    return Object.freeze({
      objectives: Object.freeze(objectives),
      proposedScope: Object.freeze(proposedScope),
      proposedFeatureGroups: Object.freeze(proposedFeatureGroups),
      dependencies: Object.freeze([]),
      constraints: Object.freeze([...understanding.constraints]),
      knownRisks: Object.freeze(knownRisks),
      unresolvedIssues: Object.freeze(unresolvedIssues),
      excludedScope: Object.freeze([...understanding.nonGoals]),
      suggestedImplementationOrder: Object.freeze([...proposedScope]),
    });
  }

  /**
   * Assembles an InitialProjectUnderstanding into a versioned ProjectApprovalPackage.
   */
  buildPackage(
    understanding: InitialProjectUnderstanding,
    proposedPlan?: ProposedDevelopmentPlan,
    options?: CreatePackageOptions
  ): ProjectApprovalPackage {
    const now = new Date().toISOString();
    const packageId =
      options?.packageId ??
      `pkg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const effectivePlan = proposedPlan ?? this.createDefaultProposedPlan(understanding);

    const readiness = this.checkReadiness(
      understanding,
      effectivePlan,
      options?.clarificationSession
    );

    const unresolvedItems = [
      ...understanding.unresolvedUnknowns.map((u) => ({
        id: `unk-${u.id}`,
        type: 'UNRESOLVED' as const,
        origin: 'DISCOVERY_EVIDENCE' as const,
        statement: `${u.item}: ${u.description}`,
        evidence: [],
      })),
      ...understanding.unresolvedContradictions.map((c) => ({
        id: `contra-${c.id}`,
        type: 'UNRESOLVED' as const,
        origin: 'DISCOVERY_EVIDENCE' as const,
        statement: c.description,
        evidence: [c.sourceA.evidence, c.sourceB.evidence],
      })),
    ];

    const pkg: ProjectApprovalPackage = {
      packageId,
      revision: 1,
      projectId: understanding.projectId,
      projectUnderstanding: understanding,
      proposedDevelopmentPlan: effectivePlan,
      unresolvedItems: Object.freeze(unresolvedItems),
      assumptions: understanding.assumptions,
      evidenceReferences: understanding.evidenceReferences,
      clarificationSessionReference: options?.clarificationSession?.sessionId,
      status: readiness.status,
      createdAt: now,
      updatedAt: now,
    };

    const parsed = ProjectApprovalPackageZodSchema.safeParse(pkg);
    if (!parsed.success) {
      throw new ApprovalValidationError(
        `Failed to validate approval package: ${parsed.error.message}`,
        'SCHEMA_VALIDATION_FAILED',
        { issues: parsed.error.issues }
      );
    }

    return Object.freeze(pkg);
  }

  /**
   * Applies explicit human Product Owner approval to a specific package revision.
   */
  approvePackage(
    pkg: ProjectApprovalPackage,
    input: ProjectApprovalInput
  ): ProjectApprovalPackage {
    // 1. Revision binding check
    if (input.revision !== pkg.revision) {
      throw new ApprovalRevisionMismatchError(
        `Approval revision mismatch: package revision is ${pkg.revision}, but approval input specified ${input.revision}. Approvals must bind to the exact revision.`,
        { packageId: pkg.packageId, currentRevision: pkg.revision, requestedRevision: input.revision }
      );
    }

    // 2. Status check: must be READY_FOR_APPROVAL
    if (pkg.status === 'APPROVED' || pkg.status === 'REJECTED' || pkg.status === 'SUPERSEDED') {
      throw new ApprovalAlreadyDecidedError(
        `Cannot approve package '${pkg.packageId}': package is already in status '${pkg.status}'.`,
        { packageId: pkg.packageId, status: pkg.status, revision: pkg.revision }
      );
    }

    if (pkg.status === 'NOT_READY') {
      const readiness = this.checkReadiness(
        pkg.projectUnderstanding,
        pkg.proposedDevelopmentPlan
      );
      throw new ApprovalNotReadyError(
        `Cannot approve package '${pkg.packageId}': package is in status NOT_READY. Reasons: ${readiness.reasons.join('; ')}`,
        readiness.reasons,
        { packageId: pkg.packageId, revision: pkg.revision }
      );
    }

    // 3. Actor authorization check: must strictly be human Product Owner
    this.validateApprovalActor(input.actor, input.actorRole);

    // 4. Intent check: must strictly be EXPLICIT_APPROVAL
    this.validateApprovalIntent(input.intent);

    const now = input.timestamp ?? new Date().toISOString();
    const packageHash = computePackageHash(pkg);

    const approvalRecord: ProjectApprovalRecord = Object.freeze({
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: input.actor,
      actorRole: input.actorRole,
      intent: 'EXPLICIT_APPROVAL',
      comment: input.comment,
      approvedAt: now,
      packageHash,
    });

    const approvedPkg: ProjectApprovalPackage = Object.freeze({
      ...pkg,
      status: 'APPROVED',
      approvalRecord,
      updatedAt: now,
    });

    return approvedPkg;
  }

  /**
   * Applies explicit human Product Owner rejection to a specific package revision.
   */
  rejectPackage(
    pkg: ProjectApprovalPackage,
    input: ProjectRejectionInput
  ): ProjectApprovalPackage {
    // 1. Revision binding check
    if (input.revision !== pkg.revision) {
      throw new ApprovalRevisionMismatchError(
        `Rejection revision mismatch: package revision is ${pkg.revision}, but rejection input specified ${input.revision}.`,
        { packageId: pkg.packageId, currentRevision: pkg.revision, requestedRevision: input.revision }
      );
    }

    // 2. Actor authorization check
    this.validateApprovalActor(input.actor, input.actorRole);

    // 3. Intent check: must strictly be EXPLICIT_REJECTION
    if (input.intent !== 'EXPLICIT_REJECTION') {
      throw new ApprovalInvalidIntentError(
        `Invalid rejection intent: '${input.intent}'. Must be strictly 'EXPLICIT_REJECTION'.`,
        { intent: input.intent }
      );
    }

    const now = input.timestamp ?? new Date().toISOString();
    const packageHash = computePackageHash(pkg);

    const rejectionRecord: ProjectRejectionRecord = Object.freeze({
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: input.actor,
      actorRole: input.actorRole,
      intent: 'EXPLICIT_REJECTION',
      reason: input.reason,
      rejectedAt: now,
      packageHash,
    });

    const rejectedPkg: ProjectApprovalPackage = Object.freeze({
      ...pkg,
      status: 'REJECTED',
      rejectionRecord,
      updatedAt: now,
    });

    return rejectedPkg;
  }

  /**
   * Revises an existing package with updated understanding or plan.
   * Produces a SUPERSEDED previous revision and a brand new revision (N+1)
   * requiring its own explicit approval.
   */
  revisePackage(
    currentPkg: ProjectApprovalPackage,
    updates: {
      understanding?: InitialProjectUnderstanding;
      proposedPlan?: ProposedDevelopmentPlan;
    },
    clarificationSession?: ClarificationSession
  ): {
    supersededPackage: ProjectApprovalPackage;
    newPackage: ProjectApprovalPackage;
  } {
    const now = new Date().toISOString();

    const supersededPackage: ProjectApprovalPackage = Object.freeze({
      ...currentPkg,
      status: 'SUPERSEDED',
      updatedAt: now,
    });

    const updatedUnderstanding = updates.understanding ?? currentPkg.projectUnderstanding;
    const updatedPlan = updates.proposedPlan ?? currentPkg.proposedDevelopmentPlan;

    const readiness = this.checkReadiness(
      updatedUnderstanding,
      updatedPlan,
      clarificationSession
    );

    const newPackage: ProjectApprovalPackage = Object.freeze({
      packageId: currentPkg.packageId,
      revision: currentPkg.revision + 1,
      projectId: updatedUnderstanding.projectId,
      projectUnderstanding: updatedUnderstanding,
      proposedDevelopmentPlan: updatedPlan,
      unresolvedItems: currentPkg.unresolvedItems,
      assumptions: updatedUnderstanding.assumptions,
      evidenceReferences: updatedUnderstanding.evidenceReferences,
      clarificationSessionReference: clarificationSession?.sessionId ?? currentPkg.clarificationSessionReference,
      status: readiness.status,
      approvalRecord: undefined, // New revision is NOT approved
      rejectionRecord: undefined,
      createdAt: currentPkg.createdAt,
      updatedAt: now,
    });

    return { supersededPackage, newPackage };
  }

  /**
   * Returns whether development is formally authorized under this approval package.
   * Development is ONLY authorized if status is APPROVED with a valid human approval record.
   */
  isDevelopmentAuthorized(pkg: ProjectApprovalPackage): boolean {
    if (pkg.status !== 'APPROVED') {
      return false;
    }
    if (!pkg.approvalRecord) {
      return false;
    }
    if (pkg.approvalRecord.intent !== 'EXPLICIT_APPROVAL') {
      return false;
    }
    if (pkg.approvalRecord.revision !== pkg.revision) {
      return false;
    }
    return true;
  }

  /**
   * Validates that the actor claiming approval authority is strictly human Product Owner.
   */
  private validateApprovalActor(actor: string, actorRole: string): void {
    if (!actor || actor.trim().length === 0) {
      throw new ApprovalAuthorizationError('Approval actor cannot be empty.');
    }

    const normalizedActor = actor.trim().toUpperCase();
    for (const forbidden of FORBIDDEN_APPROVAL_ACTORS) {
      if (normalizedActor === forbidden || normalizedActor.includes(forbidden)) {
        throw new ApprovalAuthorizationError(
          `Unauthorized approval actor: '${actor}'. Only human Product Owner may authorize project understanding and development.`,
          { actor, forbiddenActor: forbidden }
        );
      }
    }

    if (actorRole !== 'PRODUCT_OWNER' && actorRole !== 'USER') {
      throw new ApprovalAuthorizationError(
        `Invalid actorRole: '${actorRole}'. Must be 'PRODUCT_OWNER' or 'USER'.`,
        { actorRole }
      );
    }
  }

  /**
   * Validates that the approval intent is explicit and rejects natural language ambiguities.
   */
  private validateApprovalIntent(intent: string): void {
    if (intent !== 'EXPLICIT_APPROVAL') {
      throw new ApprovalInvalidIntentError(
        `Invalid approval intent: '${intent}'. Approval must be explicit ('EXPLICIT_APPROVAL'). Natural language signals ('tamam', 'anladım', 'devam', 'güzel') are NOT approval.`,
        { intent }
      );
    }
  }
}

/**
 * Convenience helper to check if development is authorized under an approval package.
 */
export function isDevelopmentAuthorized(pkg: ProjectApprovalPackage): boolean {
  return new ApprovalPackageEngine().isDevelopmentAuthorized(pkg);
}
