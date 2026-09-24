/**
 * Clarification Answer Validator (Phase 8 TASK-P8-04)
 *
 * Validates human clarification answers against question constraints:
 * - Unknown clarification ID rejection
 * - Already resolved item rejection
 * - Unsupported source rejection (strictly 'HUMAN' required)
 * - Required answer missing validation
 * - Invalid option rejection against allowed options
 * - Prohibited free-form answer rejection
 * - Security sanitization: human input is untrusted; never execute commands or scripts
 */

import type {
  ClarificationQuestion,
  ClarificationAnswer,
  ClarificationAnswerInput,
  ClarificationAnswerStatus,
  ClarificationAnswerType,
} from './clarification-types.js';
import { ClarificationValidationError } from './clarification-errors.js';

const PROHIBITED_EXECUTION_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
  /\bjavascript\s*:/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bspawn\s*\(/i,
  /\bchild_process\b/i,
  /\bpowershell\s+(-enc|-encodedcommand)/i,
  /\bcmd\.exe\s+\/c/i,
  /\brm\s+-rf\s+[\/\\]/i,
  /\bgit\s+(push\s+--force|reset\s+--hard)/i,
  /\bdrop\s+table\b/i,
];

export class AnswerValidator {
  /**
   * Sanitizes human text input. Strips null bytes, non-printable control characters,
   * and verifies no shell/code execution injection attempt is present.
   */
  static sanitizeText(text: string): string {
    const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();

    for (const pattern of PROHIBITED_EXECUTION_PATTERNS) {
      if (pattern.test(cleaned)) {
        throw new ClarificationValidationError(
          `Untrusted answer text contains prohibited executable injection pattern: ${pattern.source}`,
          'SECURITY_VIOLATION',
          { text: cleaned }
        );
      }
    }

    return cleaned;
  }

  /**
   * Validates a clarification answer against the target clarification question.
   */
  static validate(
    input: ClarificationAnswerInput,
    question?: ClarificationQuestion
  ): ClarificationAnswer {
    // 1. Unknown clarification ID check
    if (!question || question.clarificationId !== input.clarificationId) {
      throw new ClarificationValidationError(
        `Clarification question '${input.clarificationId}' was not found in active session`,
        'UNKNOWN_CLARIFICATION_ID',
        { clarificationId: input.clarificationId }
      );
    }

    // 2. Already resolved item rejection
    if (question.status === 'ANSWERED') {
      throw new ClarificationValidationError(
        `Clarification question '${question.clarificationId}' is already resolved and answered`,
        'ALREADY_RESOLVED',
        { clarificationId: question.clarificationId }
      );
    }

    // 3. Source check (strictly HUMAN)
    if (input.source !== 'HUMAN') {
      throw new ClarificationValidationError(
        `Answer source must be strictly 'HUMAN'. Received: '${String(input.source)}'`,
        'UNSUPPORTED_SOURCE',
        { source: input.source }
      );
    }

    // Determine target status
    let status: ClarificationAnswerStatus = input.status ?? 'ANSWERED';
    let answerType: ClarificationAnswerType = input.answerType ?? 'OPTION_SELECTION';

    if (input.answerType === 'DEFERRED' || input.status === 'DEFERRED') {
      status = 'DEFERRED';
      answerType = 'DEFERRED';
    } else if (input.answerType === 'REJECTED' || input.status === 'REJECTED') {
      status = 'REJECTED';
      answerType = 'REJECTED';
    } else if (input.status === 'NEEDS_FOLLOWUP') {
      status = 'NEEDS_FOLLOWUP';
    }

    // 4. Follow-up validation
    if (status === 'NEEDS_FOLLOWUP') {
      if (!input.followUpReason && !input.freeFormResponse) {
        throw new ClarificationValidationError(
          `Answer marked as NEEDS_FOLLOWUP must provide a followUpReason or clarification note`,
          'MISSING_REQUIRED_ANSWER',
          { clarificationId: question.clarificationId }
        );
      }
    }

    // 5. Answer content check for non-deferred/rejected answers
    const hasSelectedOptions = Array.isArray(input.selectedOptions) && input.selectedOptions.length > 0;
    const rawFreeForm = typeof input.freeFormResponse === 'string' ? input.freeFormResponse.trim() : '';
    const hasFreeForm = rawFreeForm.length > 0;

    if (status === 'ANSWERED') {
      if (!hasSelectedOptions && !hasFreeForm) {
        throw new ClarificationValidationError(
          `Clarification answer for '${question.clarificationId}' must provide either selected option(s) or a free-form response`,
          'MISSING_REQUIRED_ANSWER',
          { clarificationId: question.clarificationId }
        );
      }
    }

    // 6. Free-form validation
    let sanitizedFreeForm: string | undefined;
    if (hasFreeForm) {
      if (!question.allowsFreeFormAnswer) {
        throw new ClarificationValidationError(
          `Free-form answers are prohibited for clarification question '${question.clarificationId}'`,
          'FREE_FORM_PROHIBITED',
          { clarificationId: question.clarificationId }
        );
      }
      sanitizedFreeForm = this.sanitizeText(rawFreeForm);
      if (answerType === 'OPTION_SELECTION' && !hasSelectedOptions) {
        answerType = 'FREE_FORM';
      }
    }

    // 7. Option validation against allowed options
    let validatedOptions: readonly string[] | undefined;
    if (hasSelectedOptions) {
      const allowed = question.options ?? [];
      for (const selected of input.selectedOptions!) {
        const sanitizedSelected = this.sanitizeText(selected);
        if (allowed.length > 0 && !allowed.includes(sanitizedSelected)) {
          throw new ClarificationValidationError(
            `Option '${sanitizedSelected}' is not a valid option for question '${question.clarificationId}'. Allowed: ${allowed.join(', ')}`,
            'INVALID_OPTION',
            {
              clarificationId: question.clarificationId,
              selectedOption: sanitizedSelected,
              allowedOptions: allowed,
            }
          );
        }
      }
      validatedOptions = Object.freeze([...input.selectedOptions!]);
    }

    return Object.freeze({
      clarificationId: question.clarificationId,
      answerType,
      selectedOptions: validatedOptions,
      freeFormResponse: sanitizedFreeForm,
      timestamp: new Date().toISOString(),
      source: 'HUMAN',
      status,
      followUpReason: input.followUpReason ? this.sanitizeText(input.followUpReason) : undefined,
      notes: input.notes ? this.sanitizeText(input.notes) : undefined,
    });
  }
}
