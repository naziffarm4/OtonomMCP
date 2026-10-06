/**
 * @file director-response-parser.ts
 * @description Validates and parses raw model output into the AIDM decision contract (TASK-P18-02).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Rejects invalid JSON with MalformedLlmResponseError.
 * 2. Rejects unknown operations (decisionType outside DIRECTOR_DECISION_TYPES).
 * 3. Rejects missing required fields (decisionType, rationale, basedOnContextFingerprint).
 * 4. Enforces strict schema policy against unrecognized properties.
 * 5. Strictly prevents model authority escalation:
 *    - Model cannot set actor to USER or EXECUTOR.
 *    - Model cannot claim or grant implementation authority (hasImplementationAuthority strictly false).
 *    - Model cannot self-authorize development or manufacture approval mandates.
 * 6. Rejects stale or mismatched context fingerprints.
 * 7. Integrates with DirectorDecisionEngine and authorization verification.
 * 8. Model response is never sent directly to Driver.
 */

import {
  MalformedLlmResponseError,
} from '../errors/llm-error.js';
import {
  DirectorSecurityError,
  DirectorValidationError,
  DirectorContextStaleError,
  DirectorDecisionError,
} from '../director/director-errors.js';
import {
  type DirectorDecisionType,
  DIRECTOR_DECISION_TYPES,
} from '../director/director-decision-types.js';
import {
  DirectorDecisionContractZodSchema,
  type ParsedDirectorDecision,
  type ParseDirectorResponseParams,
  type ParseDirectorResponseResult,
} from './director-reasoning-types.js';

export class DirectorResponseParser {
  /**
   * Parses and validates raw LLM output into a typed, verified ParsedDirectorDecision.
   */
  async parse(
    params: ParseDirectorResponseParams
  ): Promise<ParseDirectorResponseResult> {
    const rawObject = this.extractRawObject(params);

    // 1. Check for authority escalation attempts before Zod parsing
    this.assertNoAuthorityEscalation(rawObject, params.usage);

    // 2. Validate against strict Zod decision contract schema
    const parseResult = DirectorDecisionContractZodSchema.safeParse(rawObject);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];

      // Unknown operation / invalid decisionType
      if (issue.path.includes('decisionType')) {
        throw new DirectorValidationError(
          `Unknown or invalid operation '${String((rawObject as Record<string, unknown>).decisionType)}'. Must be one of: ${DIRECTOR_DECISION_TYPES.join(', ')}`,
          {
            reason: 'UNKNOWN_OPERATION',
            decisionType: (rawObject as Record<string, unknown>).decisionType,
            issues: parseResult.error.issues,
            usage: params.usage,
          }
        );
      }

      // Missing required fields
      const isMissingField =
        issue.code === 'invalid_type' &&
        ((issue as unknown as Record<string, unknown>).received === 'undefined' ||
          issue.message.includes('received undefined') ||
          issue.message.includes('Required'));

      if (isMissingField) {
        throw new DirectorValidationError(
          `Missing required field in Director decision: '${issue.path.join('.')}'`,
          {
            reason: 'MISSING_REQUIRED_FIELDS',
            field: issue.path.join('.'),
            issues: parseResult.error.issues,
            usage: params.usage,
          }
        );
      }

      // Unrecognized schema fields (due to .strict())
      if (issue.code === 'unrecognized_keys') {
        const unrecognizedKeys = (issue as { keys?: string[] }).keys ?? [];
        throw new DirectorValidationError(
          `Schema policy violation: unrecognized properties detected in model decision: [${unrecognizedKeys.join(', ')}]`,
          {
            reason: 'UNRECOGNIZED_SCHEMA_FIELDS',
            unrecognizedKeys,
            issues: parseResult.error.issues,
            usage: params.usage,
          }
        );
      }

      // General validation error
      throw new DirectorValidationError(
        `Director decision schema validation failed: ${issue.message}`,
        {
          reason: 'SCHEMA_VALIDATION_ERROR',
          issues: parseResult.error.issues,
          usage: params.usage,
        }
      );
    }

    const validatedData = parseResult.data;

    // 3. Stale Context Fingerprint verification
    const expectedFingerprint =
      params.expectedFingerprint ?? params.snapshot?.logicalFingerprint;

    if (expectedFingerprint) {
      if (validatedData.basedOnContextFingerprint !== expectedFingerprint) {
        throw new DirectorContextStaleError(
          `Context fingerprint mismatch: model decision is based on '${validatedData.basedOnContextFingerprint}', but current snapshot fingerprint is '${expectedFingerprint}'. Decision rejected as stale context.`,
          {
            basedOnFingerprint: validatedData.basedOnContextFingerprint,
            expectedFingerprint,
            reason: 'STALE_CONTEXT_FINGERPRINT',
            usage: params.usage,
          }
        );
      }
    }

    // 4. Invariants Enforcement: Actor is strictly DIRECTOR, authority is strictly false
    const parsedDecision: ParsedDirectorDecision = {
      decisionType: validatedData.decisionType as DirectorDecisionType,
      rationale: validatedData.rationale,
      basedOnContextFingerprint: validatedData.basedOnContextFingerprint,
      selectedTaskId: validatedData.selectedTaskId ?? null,
      suggestedNextAction: validatedData.suggestedNextAction ?? null,
      basedOnApprovalRevision:
        params.snapshot?.sections.approval.revision ?? null,
      basedOnUnderstandingRevision:
        typeof (params.snapshot as unknown as { understandingRevision?: number })
          ?.understandingRevision === 'number'
          ? (params.snapshot as unknown as { understandingRevision?: number })
              .understandingRevision!
          : null,
      metadata: Object.freeze({ ...(validatedData.metadata ?? {}) }),
      actor: 'DIRECTOR',
      hasImplementationAuthority: false,
    };

    // 5. Authoritative validation through existing DirectorDecisionEngine if requested
    let validationResult;
    if (params.validateThroughDecisionEngine && params.decisionEngine) {
      validationResult = await params.decisionEngine.validateDecision({
        workspaceRoot: params.snapshot?.projectRoot,
        projectId: params.snapshot?.projectId,
        directorSessionId: params.snapshot?.directorSessionId,
        actor: parsedDecision.actor,
        decisionType: parsedDecision.decisionType,
        rationale: parsedDecision.rationale,
        basedOnContextFingerprint: parsedDecision.basedOnContextFingerprint,
        basedOnApprovalRevision: parsedDecision.basedOnApprovalRevision,
        basedOnUnderstandingRevision:
          parsedDecision.basedOnUnderstandingRevision,
        metadata: {
          ...parsedDecision.metadata,
          ...(parsedDecision.selectedTaskId
            ? { taskId: parsedDecision.selectedTaskId }
            : {}),
        },
      });

      if (!validationResult.isValid) {
        throw new DirectorDecisionError(
          `DirectorDecisionEngine rejected decision: [${validationResult.code}] ${validationResult.message}`,
          'ERR_DIRECTOR_DECISION_VALIDATION_REJECTED',
          { validationResult, usage: params.usage }
        );
      }
    }

    return {
      decision: Object.freeze(parsedDecision),
      validationResult,
    };
  }

  /**
   * Extracts the raw JavaScript object from text content or structured output.
   * Handles markdown code fences, conversational preamble, and defends against ambiguous multiple objects.
   */
  private extractRawObject(params: ParseDirectorResponseParams): unknown {
    if (
      params.structuredOutput &&
      typeof params.structuredOutput === 'object' &&
      !Array.isArray(params.structuredOutput)
    ) {
      return params.structuredOutput;
    }

    const rawText = params.content?.trim();
    if (!rawText) {
      throw new MalformedLlmResponseError(
        'Empty or missing response content from model',
        { reason: 'EMPTY_RESPONSE', usage: params.usage }
      );
    }

    // 1. Check for markdown code fences
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    const fenceMatches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(rawText)) !== null) {
      if (match[1] && match[1].trim().length > 0) {
        fenceMatches.push(match[1].trim());
      }
    }

    let candidateJson: string;
    if (fenceMatches.length > 1) {
      throw new MalformedLlmResponseError(
        'Ambiguous model response: multiple JSON code fences detected in model response',
        {
          reason: 'MULTIPLE_JSON_OBJECTS',
          rawResponse: rawText.slice(0, 500),
          usage: params.usage,
        }
      );
    } else if (fenceMatches.length === 1) {
      candidateJson = fenceMatches[0];
    } else {
      // No code fence. Check if conversational preamble exists before a JSON object
      const firstBrace = rawText.indexOf('{');
      const lastBrace = rawText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        candidateJson = rawText.slice(firstBrace, lastBrace + 1).trim();
      } else {
        candidateJson = rawText;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateJson);
    } catch (err) {
      throw new MalformedLlmResponseError(
        `Failed to parse model response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        {
          rawResponse: rawText.slice(0, 500),
          reason: 'INVALID_JSON',
          usage: params.usage,
        }
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MalformedLlmResponseError(
        'Model response must be a single non-null JSON object',
        {
          reason: 'NON_OBJECT_PAYLOAD',
          usage: params.usage,
        }
      );
    }

    return parsed;
  }

  /**
   * Strictly asserts that the model did not attempt privilege escalation or self-authorization.
   */
  private assertNoAuthorityEscalation(raw: unknown, usage?: unknown): void {
    if (!raw || typeof raw !== 'object') {
      throw new MalformedLlmResponseError(
        'Model response must be a JSON object',
        { reason: 'NON_OBJECT_PAYLOAD', usage: usage as any }
      );
    }

    const obj = raw as Record<string, unknown>;

    // 1. Actor impersonation check
    if (obj.actor !== undefined && obj.actor !== 'DIRECTOR') {
      throw new DirectorSecurityError(
        `Privilege escalation rejected: model attempted to set actor='${String(obj.actor)}'. Only 'DIRECTOR' is permitted.`,
        { actor: obj.actor, reason: 'ACTOR_IMPERSONATION', usage }
      );
    }

    // 2. Implementation authority assertion check
    if (obj.hasImplementationAuthority === true) {
      throw new DirectorSecurityError(
        'Authority escalation rejected: model cannot grant itself implementation authority (hasImplementationAuthority must strictly be false).',
        { reason: 'IMPLEMENTATION_AUTHORITY_ESCALATION', usage }
      );
    }

    // 3. Self-authorization and mandate generation check
    if (
      obj.isDevelopmentAuthorized === true ||
      obj.developmentAuthorized === true ||
      obj.mandate !== undefined ||
      obj.grantAuthorization === true ||
      obj.authoritySource === 'PRODUCT_OWNER'
    ) {
      throw new DirectorSecurityError(
        'Security policy violation: model attempted to manufacture development authorization or approval mandates. Product Owner approval is strictly required.',
        { reason: 'SELF_AUTHORIZATION_PROHIBITED', usage }
      );
    }
  }

  /**
   * Invariant guard: explicitly checks that this decision cannot be fed directly to Driver.
   * Decisions are advisory/orchestration artifacts and require policy review and instruction ingestion.
   */
  static assertNotDirectDriverPayload(decision: ParsedDirectorDecision): void {
    if (decision.hasImplementationAuthority) {
      throw new DirectorSecurityError(
        'CRITICAL INVARIANT VIOLATION: Model decision cannot have implementation authority.',
        { decisionId: decision.decisionType }
      );
    }
  }
}
