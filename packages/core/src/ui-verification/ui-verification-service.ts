import { type BrowserPort } from './browser-port.js';
import {
  type UiVerificationRequest,
  type UiVerificationRequestInput,
  assertValidUiVerificationRequest,
} from './ui-verification-types.js';
import {
  UiObservationPipeline,
  type UiObservationPipelineOptions,
  type UiObservationPipelineResult,
} from './ui-observation-pipeline.js';
import { UiVerificationQaBridge } from './ui-qa-bridge.js';
import { QAReviewEngine } from '../qa-review/qa-review-engine.js';
import {
  type AcceptanceCriterionInput,
  type ReviewResult,
  ReviewDecision,
} from '../qa-review/qa-review-types.js';
import {
  UiVerificationError,
} from '../errors/ui-verification-error.js';

export interface UiVerificationServiceOptions extends UiObservationPipelineOptions {
  /** Optional additional acceptance criteria to evaluate alongside the UI criterion */
  readonly existing_criteria?: readonly AcceptanceCriterionInput[];
}

export interface UiVerificationExecutionResult {
  readonly success: boolean;
  readonly decision: ReviewDecision;
  readonly reviewResult: ReviewResult;
  readonly pipelineResult: UiObservationPipelineResult;
}

/**
 * UiVerificationService
 *
 * Production-grade end-to-end composition boundary for Phase 5 UI verification.
 * Orchestrates the complete pipeline flow by delegation:
 *
 * UiVerificationRequest
 *         ↓
 * BrowserPort (Session Lifecycle)
 *         ↓
 * UiObservationPipeline (Observation, Normalization, Sanitization)
 *         ↓
 * UiSystemVerifiedEvidence (System Evidence Generation)
 *         ↓
 * EvidenceValidator (Canonical Validation Boundary)
 *         ↓
 * UiVerificationQaBridge (Canonical Evidence Adapting & Predicate Evaluation)
 *         ↓
 * QAReviewEngine (Deterministic QA Acceptance Decision)
 *         ↓
 * ReviewResult
 *
 * Boundary Guarantees:
 * - Does not implement browser automation logic (delegates to BrowserPort).
 * - Does not implement observation logic (delegates to UiObservationPipeline).
 * - Does not implement evidence validation (delegates to EvidenceValidator).
 * - Does not implement QA acceptance rules (delegates to UiVerificationQaBridge + QAReviewEngine).
 * - Does not reinterpret ReviewResult decisions (returns authoritative decision).
 * - Does not mutate FSM, Orchestrator, or task state.
 * - Does not perform autonomous retries.
 * - Guarantees browser sessions are never leaked under success, failure, or exception.
 * - Guarantees provider-specific errors are structured and sanitized.
 */
export class UiVerificationService {
  private readonly pipeline: UiObservationPipeline;
  private readonly bridge: UiVerificationQaBridge;

  constructor(
    private readonly browserPort: BrowserPort,
    qaEngine?: QAReviewEngine
  ) {
    this.pipeline = new UiObservationPipeline(browserPort);
    this.bridge = new UiVerificationQaBridge(qaEngine ?? new QAReviewEngine());
  }

  /**
   * Executes the complete end-to-end UI verification flow and returns the authoritative ReviewResult directly.
   */
  public async verify(
    requestInput: UiVerificationRequest | UiVerificationRequestInput,
    options?: UiVerificationServiceOptions
  ): Promise<ReviewResult> {
    const executionResult = await this.execute(requestInput, options);
    return executionResult.reviewResult;
  }

  /**
   * Executes the complete end-to-end UI verification flow and returns the full structured execution result.
   */
  public async execute(
    requestInput: UiVerificationRequest | UiVerificationRequestInput,
    options?: UiVerificationServiceOptions
  ): Promise<UiVerificationExecutionResult> {
    // 1. Boundary assertion: ensure request is structurally valid and canonicalized
    const canonicalRequest = assertValidUiVerificationRequest(requestInput);

    // 2. Observation pipeline: collect observations, normalize, sanitize, validate system evidence
    let pipelineResult: UiObservationPipelineResult;
    try {
      pipelineResult = await this.pipeline.run(canonicalRequest, options);
    } catch (err) {
      if (err instanceof UiVerificationError) {
        throw err;
      }
      throw new UiVerificationError(
        `UI observation pipeline encountered unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        'ERR_UI_VERIFICATION_GENERAL',
        {
          taskId: canonicalRequest.task_id,
          projectId: canonicalRequest.project_id,
          correlationId: canonicalRequest.correlation_id,
          cause: err,
        }
      );
    }

    // 3. QA acceptance review: evaluate canonical system evidence against criteria
    const reviewResult = this.bridge.reviewUiVerification(
      canonicalRequest,
      pipelineResult.evidence,
      options?.existing_criteria
    );

    return Object.freeze({
      success: reviewResult.decision === ReviewDecision.ACCEPT,
      decision: reviewResult.decision,
      reviewResult,
      pipelineResult,
    });
  }
}
