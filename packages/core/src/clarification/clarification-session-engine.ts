/**
 * Clarification Session Engine (Phase 8 TASK-P8-04)
 *
 * Implements the domain-level session protocol for managing clarification questions,
 * human answers, follow-up items, and bounded session resolution.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Do NOT create a second global state machine or replace AIDM FSM.
 * 2. Clarification session state is domain-level protocol state ONLY.
 * 3. DurableStateManager remains authoritative for global orchestration FSM.
 * 4. A session is RESOLVED only when all required/blocking clarifications are resolved.
 * 5. Optional unanswered questions NEVER block session resolution.
 * 6. Contradictions and ambiguities are never resolved silently.
 */

import * as crypto from 'node:crypto';
import type { ProjectDiscoveryReport } from '../discovery/discovery-types.js';
import type {
  ClarificationSession,
  ClarificationQuestion,
  ClarificationAnswer,
  ClarificationAnswerInput,
  ClarificationSessionStatus,
  ClarificationStatus,
} from './clarification-types.js';
import { AmbiguityAnalyzer } from './ambiguity-analyzer.js';
import { AnswerValidator } from './answer-validator.js';
import { sortClarificationQuestions } from './clarification-priority.js';
import { ClarificationValidationError } from './clarification-errors.js';

export interface CreateSessionOptions {
  sessionId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateFollowUpOptions {
  reason: string;
  questionText?: string;
  options?: readonly string[];
  allowsFreeForm?: boolean;
}

export class ClarificationSessionEngine {
  private readonly analyzer: AmbiguityAnalyzer;

  constructor(analyzer?: AmbiguityAnalyzer) {
    this.analyzer = analyzer ?? new AmbiguityAnalyzer();
  }

  /**
   * Creates a new bounded ClarificationSession from a ProjectDiscoveryReport.
   */
  createSession(
    report: ProjectDiscoveryReport,
    options?: CreateSessionOptions
  ): ClarificationSession {
    const analysis = this.analyzer.analyze(report);
    const now = new Date().toISOString();
    const sessionId = options?.sessionId ?? `clarify-session-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const projectId = options?.projectId ?? report.projectIdentity?.name ?? 'default-project';
    const sourceDiscoveryReference = report.timestamp || `discovery-${report.projectIdentity.name}-${now}`;

    const blockingOpenCount = analysis.blockingQuestions.length;
    const totalCount = analysis.questions.length;

    let status: ClarificationSessionStatus = 'RESOLVED';
    if (totalCount > 0) {
      status = blockingOpenCount > 0 ? 'WAITING_FOR_HUMAN' : 'OPEN';
    }

    return Object.freeze({
      sessionId,
      projectId,
      sourceDiscoveryReference,
      questions: analysis.questions,
      answers: Object.freeze([]),
      status,
      blockingOpenCount,
      totalCount,
      resolvedCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: options?.metadata ? Object.freeze({ ...options.metadata }) : undefined,
    });
  }

  /**
   * Submits and validates a human answer for a clarification question within the session.
   */
  submitAnswer(
    session: ClarificationSession,
    input: ClarificationAnswerInput
  ): ClarificationSession {
    const targetQuestion = session.questions.find((q) => q.clarificationId === input.clarificationId);
    if (!targetQuestion) {
      throw new ClarificationValidationError(
        `Clarification question '${input.clarificationId}' does not exist in session '${session.sessionId}'`,
        'UNKNOWN_CLARIFICATION_ID',
        { clarificationId: input.clarificationId, sessionId: session.sessionId }
      );
    }

    // Validate answer against question constraints & security rules
    const validatedAnswer = AnswerValidator.validate(input, targetQuestion);

    // Update target question status
    let newQuestionStatus: ClarificationStatus = 'ANSWERED';
    if (validatedAnswer.status === 'DEFERRED') {
      newQuestionStatus = 'DEFERRED';
    } else if (validatedAnswer.status === 'REJECTED') {
      newQuestionStatus = 'BLOCKED';
    } else if (validatedAnswer.status === 'NEEDS_FOLLOWUP') {
      newQuestionStatus = 'NEEDS_FOLLOWUP';
    }

    const updatedQuestion: ClarificationQuestion = Object.freeze({
      ...targetQuestion,
      status: newQuestionStatus,
      answer: validatedAnswer,
    });

    const updatedQuestions = session.questions.map((q) =>
      q.clarificationId === targetQuestion.clarificationId ? updatedQuestion : q
    );

    const updatedAnswers = [...session.answers, validatedAnswer];

    return this.recomputeSession(session, updatedQuestions, updatedAnswers);
  }

  /**
   * Generates a follow-up clarification question when an answer is insufficient or ambiguous.
   */
  createFollowUp(
    session: ClarificationSession,
    parentClarificationId: string,
    options: CreateFollowUpOptions
  ): { session: ClarificationSession; followUpQuestion: ClarificationQuestion } {
    const parent = session.questions.find((q) => q.clarificationId === parentClarificationId);
    if (!parent) {
      throw new ClarificationValidationError(
        `Cannot create follow-up: parent clarification '${parentClarificationId}' not found`,
        'UNKNOWN_CLARIFICATION_ID',
        { parentClarificationId }
      );
    }

    const followUpIndex = (parent.followUpClarificationIds?.length ?? 0) + 1;
    const followUpId = `${parent.clarificationId}-F${followUpIndex}`;
    const now = new Date().toISOString();

    const followUpQuestion: ClarificationQuestion = Object.freeze({
      clarificationId: followUpId,
      kind: 'AMBIGUOUS_REQUIREMENT',
      priority: parent.priority,
      question:
        options.questionText ??
        `Follow-up on ${parent.clarificationId}: ${options.reason}`,
      context: `Follow-up clarification required because previous response was insufficient: ${options.reason}`,
      reason: options.reason,
      evidence: parent.evidence,
      parentClarificationId: parent.clarificationId,
      options: options.options,
      allowsFreeFormAnswer: options.allowsFreeForm ?? true,
      status: 'OPEN',
      blocking: parent.blocking,
      uncertaintyType: 'AMBIGUOUS',
      createdAt: now,
    });

    // Update parent to reference follow-up ID and mark status as NEEDS_FOLLOWUP
    const updatedParent: ClarificationQuestion = Object.freeze({
      ...parent,
      status: 'NEEDS_FOLLOWUP',
      followUpClarificationIds: Object.freeze([
        ...(parent.followUpClarificationIds ?? []),
        followUpId,
      ]),
    });

    const mergedQuestions = session.questions.map((q) =>
      q.clarificationId === parent.clarificationId ? updatedParent : q
    );
    mergedQuestions.push(followUpQuestion);

    const sortedQuestions = sortClarificationQuestions(mergedQuestions);
    const updatedSession = this.recomputeSession(session, sortedQuestions, session.answers);

    return {
      session: updatedSession,
      followUpQuestion,
    };
  }

  /**
   * Returns all currently unresolved blocking questions for the session in deterministic order.
   */
  getBlockingQuestions(session: ClarificationSession): readonly ClarificationQuestion[] {
    return Object.freeze(
      session.questions.filter((q) => q.blocking && q.status !== 'ANSWERED')
    );
  }

  /**
   * Internal helper to recompute session metrics and status.
   */
  private recomputeSession(
    session: ClarificationSession,
    questions: readonly ClarificationQuestion[],
    answers: readonly ClarificationAnswer[]
  ): ClarificationSession {
    const blockingQuestions = questions.filter((q) => q.blocking);
    const blockingOpenCount = blockingQuestions.filter((q) => q.status !== 'ANSWERED').length;
    const resolvedCount = questions.filter((q) => q.status === 'ANSWERED').length;
    const totalCount = questions.length;

    let status: ClarificationSessionStatus = 'OPEN';

    const hasBlocked = questions.some((q) => q.blocking && q.status === 'BLOCKED');
    const allBlockingResolved = blockingQuestions.length > 0
      ? blockingQuestions.every((q) => q.status === 'ANSWERED')
      : true;

    if (hasBlocked) {
      status = 'BLOCKED';
    } else if (allBlockingResolved) {
      status = 'RESOLVED';
    } else if (resolvedCount > 0) {
      status = 'PARTIALLY_RESOLVED';
    } else if (blockingOpenCount > 0) {
      status = 'WAITING_FOR_HUMAN';
    }

    return Object.freeze({
      ...session,
      questions: Object.freeze(questions),
      answers: Object.freeze(answers),
      status,
      blockingOpenCount,
      totalCount,
      resolvedCount,
      updatedAt: new Date().toISOString(),
    });
  }
}
