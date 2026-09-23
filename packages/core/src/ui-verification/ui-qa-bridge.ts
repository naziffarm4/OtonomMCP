import { QAReviewEngine } from '../qa-review/qa-review-engine.js';
import {
  AcceptanceCriterionInput,
  ReviewRequestInput,
  ReviewResult,
  CriterionType,
} from '../qa-review/qa-review-types.js';
import { SystemVerifiedEvidence } from '../evidence/evidence-types.js';
import { UiEvidencePayload } from './ui-evidence-types.js';
import { UiVerificationRequest, UiObservationType } from './ui-verification-types.js';

/**
 * Extracts canonical UiEvidencePayload from SystemVerifiedEvidence metadata.
 * Preserved through the authoritative EvidenceValidator canonicalization boundary.
 */
export function extractCanonicalUiPayload(evi: SystemVerifiedEvidence): UiEvidencePayload | null {
  const meta = evi.metadata as Record<string, unknown> | null | undefined;
  if (meta && typeof meta === 'object' && meta.ui_evidence && typeof meta.ui_evidence === 'object') {
    return meta.ui_evidence as UiEvidencePayload;
  }
  if ('ui_payload' in evi && (evi as any).ui_payload && typeof (evi as any).ui_payload === 'object') {
    return (evi as any).ui_payload as UiEvidencePayload;
  }
  return null;
}

/**
 * UiVerificationQaBridge
 *
 * Synchronous boundary integrating the UI Verification pipeline with the central QA Review Engine.
 * Responsibilities:
 * 1. Takes UI verification request and system evidence pool.
 * 2. Maps UI verification conditions to an AcceptanceCriterionInput evaluated via standard per-item predicate semantics.
 * 3. Consumes canonical validated UI evidence through metadata.ui_evidence without bypassing EvidenceValidator.
 * 4. Invokes the central QAReviewEngine without modifying its architecture or contracts.
 * 5. Returns the authoritative ReviewResult directly from QAReviewEngine.
 */
export class UiVerificationQaBridge {
  constructor(private readonly qaEngine: QAReviewEngine) {}

  public reviewUiVerification(
    request: UiVerificationRequest,
    evidencePool: readonly SystemVerifiedEvidence[],
    existingCriteria?: readonly AcceptanceCriterionInput[]
  ): ReviewResult {
    const uiCriterion: AcceptanceCriterionInput = {
      criterion_id: request.criterion_id,
      description: `UI Verification for ${request.target_url}`,
      criterion_type: CriterionType.UI,
      is_mandatory: true,
      predicate: (candidateEvidence: readonly SystemVerifiedEvidence[]) => {
        return this.evaluateCandidateItem(request, candidateEvidence, evidencePool);
      },
    };

    const criteria: AcceptanceCriterionInput[] = existingCriteria
      ? [...existingCriteria, uiCriterion]
      : [uiCriterion];

    const reviewRequest: ReviewRequestInput = {
      task_id: request.task_id,
      project_id: request.project_id,
      correlation_id: request.correlation_id,
      attempt: request.attempt,
      max_attempts: request.max_attempts,
      acceptance_criteria: criteria,
      evidence: evidencePool,
    };

    return this.qaEngine.review(reviewRequest);
  }

  /**
   * Evaluates a single candidate evidence item under established per-item predicate semantics.
   * QAReviewEngine calls predicate([candidate]) for each candidate item.
   */
  private evaluateCandidateItem(
    request: UiVerificationRequest,
    candidateEvidence: readonly SystemVerifiedEvidence[],
    evidencePool: readonly SystemVerifiedEvidence[]
  ): { satisfied: boolean; reason?: string } {
    if (!candidateEvidence || candidateEvidence.length === 0) {
      return { satisfied: false, reason: 'No candidate evidence item supplied.' };
    }

    const currentEvi = candidateEvidence[0];

    // Identity boundary check
    if (currentEvi.task_id !== request.task_id || currentEvi.correlation_id !== request.correlation_id) {
      return {
        satisfied: false,
        reason: `Evidence identity mismatch: expected task='${request.task_id}', corr='${request.correlation_id}', received task='${currentEvi.task_id}', corr='${currentEvi.correlation_id}'.`,
      };
    }

    // Extract canonical UI payload from metadata (authoritative EvidenceValidator representation)
    const currentPayload = extractCanonicalUiPayload(currentEvi);
    if (!currentPayload) {
      return {
        satisfied: false,
        reason: `Evidence '${currentEvi.evidence_id}' has no canonical ui_evidence payload.`,
      };
    }

    // Completeness verification: ensure all requested observations are present in the evidence pool
    const matchingEvidence = evidencePool.filter(
      (e) =>
        e.evidence_type === 'UI' &&
        e.task_id === request.task_id &&
        e.correlation_id === request.correlation_id
    );
    const allPayloads = matchingEvidence
      .map(extractCanonicalUiPayload)
      .filter((p): p is UiEvidencePayload => p !== null);

    if (request.required_observations.includes(UiObservationType.NAVIGATION)) {
      const hasNav = allPayloads.some((p) => p.observation_type === UiObservationType.NAVIGATION);
      if (!hasNav) {
        return { satisfied: false, reason: 'Missing NAVIGATION evidence.' };
      }
    }

    if (request.expected_dom_conditions && request.expected_dom_conditions.length > 0) {
      for (const cond of request.expected_dom_conditions) {
        const hasDom = allPayloads.some(
          (p) =>
            p.observation_type === UiObservationType.DOM &&
            p.dom_observation?.selector === cond.selector
        );
        if (!hasDom) {
          return { satisfied: false, reason: `Missing DOM evidence for selector: ${cond.selector}` };
        }
      }
    }

    if (request.expected_visible_conditions && request.expected_visible_conditions.length > 0) {
      for (const cond of request.expected_visible_conditions) {
        const hasVis = allPayloads.some(
          (p) =>
            p.observation_type === UiObservationType.VISIBLE_ELEMENT &&
            p.visible_element_observation?.selector === cond.selector
        );
        if (!hasVis) {
          return { satisfied: false, reason: `Missing VISIBLE_ELEMENT evidence for selector: ${cond.selector}` };
        }
      }
    }

    // Specific candidate evaluation
    switch (currentPayload.observation_type) {
      case UiObservationType.NAVIGATION: {
        const nav = currentPayload.navigation_observation;
        if (nav && typeof nav.status_code === 'number' && nav.status_code >= 400) {
          return { satisfied: false, reason: `Navigation failed with status code ${nav.status_code}` };
        }
        return { satisfied: true };
      }

      case UiObservationType.DOM: {
        const dom = currentPayload.dom_observation;
        if (!dom) {
          return { satisfied: false, reason: 'Missing dom_observation in UI payload.' };
        }

        const cond = request.expected_dom_conditions?.find((c) => c.selector === dom.selector);
        if (cond) {
          if (cond.presence === 'absent' && dom.matches_count > 0) {
            return { satisfied: false, reason: `DOM element present but expected absent: ${cond.selector}` };
          }
          if (cond.presence !== 'absent' && dom.matches_count === 0) {
            return { satisfied: false, reason: `DOM element absent but expected present: ${cond.selector}` };
          }
          if (cond.max_count !== undefined && dom.matches_count > cond.max_count) {
            return {
              satisfied: false,
              reason: `DOM elements count ${dom.matches_count} exceeds max ${cond.max_count} for selector: ${cond.selector}`,
            };
          }
          if (cond.text_contains && dom.elements) {
            const hasText = dom.elements.some((el) => el.inner_text && el.inner_text.includes(cond.text_contains!));
            if (!hasText) {
              return {
                satisfied: false,
                reason: `No elements matched text_contains: '${cond.text_contains}' for selector: ${cond.selector}`,
              };
            }
          }
        }
        return { satisfied: true };
      }

      case UiObservationType.VISIBLE_ELEMENT: {
        const vis = currentPayload.visible_element_observation;
        if (!vis) {
          return { satisfied: false, reason: 'Missing visible_element_observation in UI payload.' };
        }

        const cond = request.expected_visible_conditions?.find((c) => c.selector === vis.selector);
        if (cond) {
          if (cond.state === 'hidden' && vis.is_visible) {
            return { satisfied: false, reason: `Element visible but expected hidden: ${cond.selector}` };
          }
          if (cond.state !== 'hidden' && !vis.is_visible) {
            return { satisfied: false, reason: `Element hidden but expected visible: ${cond.selector}` };
          }
          const text = vis.visible_text ?? '';
          if (cond.text_contains && !text.includes(cond.text_contains)) {
            return {
              satisfied: false,
              reason: `Element text does not contain '${cond.text_contains}' for selector: ${cond.selector}`,
            };
          }
          if (cond.text_equals && text !== cond.text_equals) {
            return {
              satisfied: false,
              reason: `Element text '${text}' does not equal '${cond.text_equals}' for selector: ${cond.selector}`,
            };
          }
        }
        return { satisfied: true };
      }

      case UiObservationType.CONSOLE: {
        const con = currentPayload.console_observation;
        if (con?.has_errors) {
          return { satisfied: false, reason: 'Console observation reported errors.' };
        }
        return { satisfied: true };
      }

      case UiObservationType.NETWORK: {
        const net = currentPayload.network_observation;
        if (net?.has_failures) {
          return { satisfied: false, reason: 'Network observation reported failures.' };
        }
        return { satisfied: true };
      }

      case UiObservationType.SCREENSHOT: {
        return { satisfied: true };
      }

      default:
        return { satisfied: true };
    }
  }
}
