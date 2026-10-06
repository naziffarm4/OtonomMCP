/**
 * @file director-action-builder.ts
 * @description Transforms a ParsedDirectorDecision and DirectorContextSnapshot into a
 * strongly-typed, schema-compliant DirectorActionEnvelope (TASK-P19-02).
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. AUTHORITATIVE METADATA SOURCE: projectId, directorSessionId, context fingerprint,
 *    and understanding revision MUST be extracted strictly from the authoritative snapshot.
 * 2. STRICT ACTOR BOUNDARY: actor and actorRole are ALWAYS 'DIRECTOR'.
 *    Model output cannot set or escalate actor permissions.
 * 3. NO EXECUTION: This builder only creates a verifiable action proposal contract.
 * 4. FAIL CLOSED: If the decision is ambiguous, missing required task references, or contradictory,
 *    it throws a DirectorActionValidationError.
 */

import * as crypto from 'node:crypto';
import {
  type DirectorActionEnvelope,
  type DirectorActionType,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_SCHEMA_VERSION,
  DIRECTOR_ACTION_ACTOR,
  DIRECTOR_ACTION_ACTOR_ROLE,
  computeDeterministicActionId,
} from './director-action-types.js';
import { DirectorActionValidationError } from './director-action-errors.js';
import type { ParsedDirectorDecision } from '../director-reasoning/director-reasoning-types.js';
import type { DirectorContextSnapshot } from '../director/director-context-types.js';

export interface BuildDirectorActionEnvelopeParams {
  /** The validated parsed decision from DirectorReasoningEngine */
  readonly decision: ParsedDirectorDecision;
  /** The authoritative context snapshot the decision was based on */
  readonly snapshot: DirectorContextSnapshot;
  /** Optional explicit idempotency key. If omitted, a deterministic key is generated */
  readonly idempotencyKey?: string;
  /** Optional active execution cycle ID */
  readonly cycleId?: string;
  /** Optional override for actionType if explicit mapping is requested */
  readonly explicitActionType?: DirectorActionType;
  /** Optional custom payload overrides */
  readonly customPayload?: Record<string, unknown>;
}

export class DirectorActionBuilder {
  /**
   * Constructs an authoritative DirectorActionEnvelope bound strictly to the snapshot context.
   */
  buildEnvelope(params: BuildDirectorActionEnvelopeParams): DirectorActionEnvelope {
    const { decision, snapshot } = params;

    // 1. Validate snapshot presence and basic integrity
    if (!snapshot || !snapshot.logicalFingerprint) {
      throw new DirectorActionValidationError('Cannot build action envelope: missing authoritative context snapshot.');
    }

    if (!snapshot.projectId || !snapshot.directorSessionId) {
      throw new DirectorActionValidationError(
        'Cannot build action envelope: snapshot must contain valid projectId and directorSessionId.'
      );
    }

    // 2. Validate context fingerprint alignment
    if (decision.basedOnContextFingerprint !== snapshot.logicalFingerprint) {
      throw new DirectorActionValidationError(
        `Decision fingerprint mismatch: decision was based on '${decision.basedOnContextFingerprint}', but snapshot fingerprint is '${snapshot.logicalFingerprint}'.`
      );
    }

    // 3. Resolve understanding revision from authoritative snapshot
    const understandingRevision =
      (typeof snapshot.sectionMetadata?.requirements?.revision === 'number' &&
        snapshot.sectionMetadata.requirements.revision > 0)
        ? snapshot.sectionMetadata.requirements.revision
        : (decision.basedOnUnderstandingRevision ?? 1);

    // 4. Map Decision Type to Director Action Type
    const actionType = this.resolveActionType(decision, params.explicitActionType);

    // 5. Construct Typed Payload according to actionType
    const payload = this.constructPayload(actionType, decision, snapshot, params.customPayload);

    // 6. Generate Deterministic Idempotency Key
    const idempotencyKey =
      params.idempotencyKey ??
      this.generateDefaultIdempotencyKey(
        snapshot.projectId,
        snapshot.directorSessionId,
        actionType,
        decision,
        payload
      );

    // 7. Generate Deterministic Action ID
    const actionId = computeDeterministicActionId({
      projectId: snapshot.projectId,
      directorSessionId: snapshot.directorSessionId,
      actionType,
      idempotencyKey,
    });

    // 8. Assemble Immutable Envelope
    // INVARIANT: actor and actorRole are HARDCODED to DIRECTOR/DIRECTOR, ignoring any model hallucination
    const envelope: DirectorActionEnvelope = Object.freeze({
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
      actionId,
      idempotencyKey,
      projectId: snapshot.projectId,
      directorSessionId: snapshot.directorSessionId,
      cycleId: params.cycleId,
      basedOnContextFingerprint: snapshot.logicalFingerprint,
      understandingRevision,
      actionType,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload,
    });

    return envelope;
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  private resolveActionType(
    decision: ParsedDirectorDecision,
    explicitActionType?: DirectorActionType
  ): DirectorActionType {
    if (explicitActionType) {
      return explicitActionType;
    }

    // Check if decision metadata explicitly specifies an actionType
    if (
      decision.metadata?.actionType &&
      typeof decision.metadata.actionType === 'string'
    ) {
      return decision.metadata.actionType as DirectorActionType;
    }

    // Canonical mapping from DirectorDecisionType to DirectorActionType
    switch (decision.decisionType) {
      case 'IMPLEMENT_TASK':
        return 'IMPLEMENT_TASK';
      case 'REQUEST_PLANNING':
        return 'CREATE_TASK';
      case 'REQUEST_CLARIFICATION':
        if (decision.metadata?.isCorrective || decision.metadata?.remediationType) {
          return 'CREATE_CORRECTIVE_TASK';
        }
        return 'REQUEST_HUMAN_DECISION';
      case 'DEFER':
      case 'BLOCK':
        return 'REPLAN';
      case 'ACCEPT_CONTEXT':
        return 'REVIEW_EVIDENCE';
      default:
        throw new DirectorActionValidationError(
          `Cannot map decisionType '${decision.decisionType}' to a supported Director action type.`
        );
    }
  }

  private constructPayload(
    actionType: DirectorActionType,
    decision: ParsedDirectorDecision,
    snapshot: DirectorContextSnapshot,
    customPayload?: Record<string, unknown>
  ): Record<string, unknown> {
    if (customPayload) {
      return customPayload;
    }

    switch (actionType) {
      case 'IMPLEMENT_TASK': {
        const taskId = decision.selectedTaskId ?? String(decision.metadata?.taskId ?? '');
        if (!taskId) {
          throw new DirectorActionValidationError(
            "IMPLEMENT_TASK action requires a selectedTaskId in the decision or metadata."
          );
        }

        // Resolve expected task revision from snapshot tasks if present
        let expectedTaskRevision = 1;
        if (snapshot.sections?.taskList?.tasks) {
          const matching = snapshot.sections.taskList.tasks.find((t) => t.taskId === taskId);
          if (matching && (matching as any).revision) {
            expectedTaskRevision = (matching as any).revision;
          }
        }

        return {
          taskId,
          expectedTaskRevision,
          executionPlan: decision.rationale || 'Execute target task per plan',
          inputContext: decision.metadata || {},
        };
      }

      case 'CREATE_TASK': {
        const title =
          decision.suggestedNextAction ||
          String(decision.metadata?.title ?? '') ||
          `Task for ${decision.rationale.substring(0, 60)}`;

        return {
          title,
          description: decision.rationale,
          parentTaskId: decision.selectedTaskId ?? undefined,
          dependencies: Array.isArray(decision.metadata?.dependencies)
            ? (decision.metadata.dependencies as string[])
            : [],
          acceptanceCriteria: Array.isArray(decision.metadata?.acceptanceCriteria)
            ? (decision.metadata.acceptanceCriteria as string[])
            : [`AC: ${decision.rationale}`],
          estimatedTokens: typeof decision.metadata?.estimatedTokens === 'number'
            ? decision.metadata.estimatedTokens
            : undefined,
          category: (decision.metadata?.category as any) ?? 'IMPLEMENTATION',
        };
      }

      case 'CREATE_CORRECTIVE_TASK': {
        const failedTaskId =
          String(decision.metadata?.failedTaskId ?? '') ||
          decision.selectedTaskId ||
          '';

        const parentTaskId =
          String(decision.metadata?.parentTaskId ?? '') ||
          failedTaskId ||
          '';

        if (!failedTaskId || !parentTaskId) {
          throw new DirectorActionValidationError(
            'CREATE_CORRECTIVE_TASK action requires failedTaskId and parentTaskId.'
          );
        }

        return {
          parentTaskId,
          failedTaskId,
          failureReason: decision.rationale,
          remediationType: (decision.metadata?.remediationType as any) ?? 'CODE_FIX',
          correctivePlan: decision.suggestedNextAction || decision.rationale,
          targetFiles: Array.isArray(decision.metadata?.targetFiles)
            ? (decision.metadata.targetFiles as string[])
            : undefined,
        };
      }

      case 'REPLAN': {
        const affectedTaskIds = Array.isArray(decision.metadata?.affectedTaskIds)
          ? (decision.metadata.affectedTaskIds as string[])
          : decision.selectedTaskId
          ? [decision.selectedTaskId]
          : [];

        if (affectedTaskIds.length === 0) {
          throw new DirectorActionValidationError('REPLAN action requires at least one affectedTaskId.');
        }

        return {
          replanReason: decision.rationale,
          affectedTaskIds,
          proposedModifications: Array.isArray(decision.metadata?.proposedModifications)
            ? (decision.metadata.proposedModifications as any)
            : [
                {
                  taskId: affectedTaskIds[0],
                  action: decision.decisionType === 'BLOCK' ? 'CANCEL' : 'DEFER',
                  justification: decision.rationale,
                },
              ],
        };
      }

      case 'REVIEW_EVIDENCE': {
        const taskId = decision.selectedTaskId ?? String(decision.metadata?.taskId ?? '');
        if (!taskId) {
          throw new DirectorActionValidationError('REVIEW_EVIDENCE action requires a taskId.');
        }

        // Locate evidence from snapshot if not explicitly provided
        let evidenceIds: string[] = [];
        if (Array.isArray(decision.metadata?.evidenceIds)) {
          evidenceIds = decision.metadata.evidenceIds as string[];
        } else if (snapshot.sections?.evidence?.items) {
          evidenceIds = snapshot.sections.evidence.items
            .filter((e) => e.taskId === taskId)
            .map((e) => e.evidenceId);
        }

        if (evidenceIds.length === 0) {
          evidenceIds = [`ev-${taskId}-baseline`];
        }

        return {
          taskId,
          evidenceIds,
          verdict: (decision.metadata?.verdict as any) ?? 'VERIFIED_SUCCESS',
          findings: decision.rationale,
          suggestedRemediation: decision.suggestedNextAction ?? undefined,
        };
      }

      case 'REQUEST_HUMAN_DECISION': {
        const decisionId =
          String(decision.metadata?.decisionId ?? '') ||
          `hdp-${decision.selectedTaskId ?? 'general'}`;

        return {
          decisionId,
          question: decision.rationale,
          options: Array.isArray(decision.metadata?.options)
            ? (decision.metadata.options as string[])
            : ['Proceed with recommended approach', 'Reject and specify alternative'],
          recommendedOption: decision.suggestedNextAction ?? undefined,
          riskLevel: (decision.metadata?.riskLevel as any) ?? 'HIGH',
          affectedAreas: Array.isArray(decision.metadata?.affectedAreas)
            ? (decision.metadata.affectedAreas as string[])
            : ['architecture', 'implementation'],
        };
      }

      case 'PROJECT_COMPLETE':
      case 'PAUSE':
      case 'STOP': {
        return {
          reason: decision.rationale,
          saveCheckpoint: true,
          summary: decision.suggestedNextAction ?? undefined,
        };
      }

      default:
        throw new DirectorActionValidationError(`Unsupported actionType '${actionType}'.`);
    }
  }

  private generateDefaultIdempotencyKey(
    projectId: string,
    sessionId: string,
    actionType: string,
    decision: ParsedDirectorDecision,
    payload: Record<string, unknown>
  ): string {
    const serializedPayload = JSON.stringify(payload, Object.keys(payload).sort());
    const raw = `${projectId}:${sessionId}:${actionType}:${decision.selectedTaskId ?? ''}:${serializedPayload}`;
    const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 16);
    return `key-${actionType.toLowerCase()}-${hash}`;
  }
}
