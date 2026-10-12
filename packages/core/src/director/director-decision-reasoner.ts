/**
 * @file director-decision-reasoner.ts
 * @description Opt-in "decision-only" Director reasoning path (used by the autonomous spec run).
 *
 * The LLM produces ONLY decision fields; the system-owned envelope is bound deterministically
 * (see director-decision-output.ts). Uses OpenAI-compatible strict json_schema structured output
 * with an automatic json_object fallback, and bounded repair retries that feed validation errors
 * back to the LLM. Every request of every invocation gets its own budget reservation
 * (metadata.llm_invocation_id + distinct attempt numbers).
 *
 * Wired into DirectorRuntime at a single narrow point (DirectorRuntimeDependencies.decisionOutput);
 * when not configured, the legacy DirectorRuntime path is unchanged.
 */

import * as crypto from 'node:crypto';
import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import {
  type LlmRequest,
  type LlmResponse,
  type LlmMessage,
  type LlmJsonSchema,
  LlmResponseFormat,
  LlmRole,
} from '../llm-bridge/llm-types.js';
import type { DirectorContextSnapshot } from './director-context-types.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import type { DirectorAction } from './director-action-types.js';
import { DirectorActionZodSchema } from './director-action-schema.js';
import type { DirectorPromptBuildResult, DirectorReasoningInput } from './director-prompt-builder.js';
import {
  bindDecisionToEnvelope,
  DecisionEnvelopeSpoofError,
  DIRECTOR_DECISION_JSON_SCHEMA,
  DIRECTOR_DECISION_PROMPT_SPEC,
  formatValidationIssues,
} from './director-decision-output.js';
import {
  DirectorRuntimeError,
  DirectorSessionInvalidError,
  DirectorLlmRequestFailedError,
  DirectorLlmResponseInvalidError,
  DirectorStructuredOutputRequiredError,
  DirectorActionValidationFailedError,
  DirectorActionContextMismatchError,
} from './director-runtime-errors.js';
import type { DirectorReasoningResult } from './director-runtime.js';

export type DirectorResponseFormatMode = 'json_schema_strict' | 'json_schema' | 'json_object';

export interface DirectorDecisionOutputSettings {
  /** Default 'json_schema_strict'. */
  readonly responseFormatMode?: DirectorResponseFormatMode;
  /** Fall back once to json_object when the provider rejects json_schema. Default true. */
  readonly autoFallbackToJsonObject?: boolean;
  /** Validation-repair retries (0..3). Default 1. */
  readonly maxRepairAttempts?: number;
}

export interface DecisionReasoningParams {
  readonly provider: LLMProvider;
  readonly promptBuild: DirectorPromptBuildResult;
  readonly input: DirectorReasoningInput;
  readonly snapshot: DirectorContextSnapshot;
  readonly settings: DirectorDecisionOutputSettings;
  readonly historyManager?: HistoryManager;
  readonly model: string | null;
  readonly temperature: number;
  readonly maxTokens: number;
}

export const DIRECTOR_DECISION_SCHEMA_NAME = 'director_decision';

export function isUnsupportedResponseFormatError(message: string): boolean {
  const m = message.toLowerCase();
  return (m.includes('response_format') || m.includes('json_schema') || m.includes('structured output')) &&
    (m.includes('not supported') || m.includes('unsupported') || m.includes('invalid') || m.includes('400'));
}

function sanitizeRepairText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 2000);
}

function parseContent(response: LlmResponse, correlationId: string): unknown {
  if (response.structured_output !== null && response.structured_output !== undefined && typeof response.structured_output === 'object') {
    return response.structured_output;
  }
  if (typeof response.content === 'string' && response.content.trim()) {
    let text = response.content.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
    if (fenced) text = fenced[1]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new DirectorLlmResponseInvalidError(
        `Failed to parse LLM response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        { correlationId }
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DirectorStructuredOutputRequiredError('LLM response must be a JSON object (Director decision).', { correlationId });
    }
    return parsed;
  }
  throw new DirectorStructuredOutputRequiredError('Structured output is required for Director reasoning.', { correlationId });
}

function mapSpoofError(err: DecisionEnvelopeSpoofError): Error {
  if (err.field === 'projectId') {
    return new DirectorActionValidationFailedError(
      `DirectorAction projectId '${String(err.actual)}' does not match expected projectId '${err.expected}'.`,
      { expectedProjectId: err.expected, actualProjectId: err.actual }
    );
  }
  if (err.field === 'directorSessionId') {
    return new DirectorSessionInvalidError(
      `DirectorAction directorSessionId '${String(err.actual)}' does not match expected session '${err.expected}'.`,
      { expectedSessionId: err.expected, actualSessionId: err.actual }
    );
  }
  return new DirectorActionContextMismatchError(
    `DirectorAction fingerprint mismatch: action is based on '${String(err.actual)}', but current context fingerprint is '${err.expected}'. Fail-closed rejection.`,
    { expectedFingerprint: err.expected, actionFingerprint: err.actual }
  );
}

export async function runDecisionReasoning(p: DecisionReasoningParams): Promise<DirectorReasoningResult> {
  const { provider, promptBuild, input, snapshot } = p;
  const correlationId = promptBuild.correlationId;
  const invocationId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const baseAttempt = input.attempt ?? 1;
  const maxRepair = Math.max(0, Math.min(p.settings.maxRepairAttempts ?? 1, 3));
  const autoFallback = p.settings.autoFallbackToJsonObject ?? true;
  let mode: DirectorResponseFormatMode = p.settings.responseFormatMode ?? 'json_schema_strict';

  const baseMessages: LlmMessage[] = [
    ...promptBuild.messages,
    // Decision-only contract supersedes any envelope instructions above: envelope is system-bound.
    Object.freeze({ role: LlmRole.SYSTEM, content: DIRECTOR_DECISION_PROMPT_SPEC }),
  ];
  let messages: LlmMessage[] = baseMessages;
  let requestSeq = 0;
  let fellBack = false;
  let action: DirectorAction | undefined;
  let llmResponse: LlmResponse | undefined;

  for (let repair = 0; repair <= maxRepair; repair++) {
    const attempt = baseAttempt + requestSeq++;
    const useSchema = mode !== 'json_object';
    const jsonSchema: LlmJsonSchema | null = useSchema
      ? Object.freeze({
          name: DIRECTOR_DECISION_SCHEMA_NAME,
          description: 'AIDM Director decision (decision fields only; envelope is system-bound)',
          schema: DIRECTOR_DECISION_JSON_SCHEMA,
          strict: mode === 'json_schema_strict',
        })
      : null;
    const request = Object.freeze({
      correlation: Object.freeze({ correlation_id: correlationId, project_id: input.projectId, task_id: input.taskId ?? null, attempt }),
      messages: Object.freeze([...messages]),
      director_context: Object.freeze({
        project_id: input.projectId,
        task_id: input.taskId ?? null,
        objective: input.objective ?? null,
        acceptance_criteria: null,
        attempt,
        max_attempts: null,
        relevant_context: input.additionalContext ?? null,
      }),
      model: p.model,
      temperature: p.temperature,
      max_tokens: p.maxTokens,
      response_format: useSchema ? LlmResponseFormat.JSON_SCHEMA : LlmResponseFormat.JSON_OBJECT,
      json_schema: jsonSchema,
      metadata: Object.freeze({
        directorSessionId: input.directorSessionId,
        trigger: input.trigger,
        contextFingerprint: snapshot.logicalFingerprint,
        llm_invocation_id: invocationId,
        repairAttempt: repair,
      }),
    }) as unknown as LlmRequest;

    let repairReason: string | null = null;
    let rawContent = '';
    try {
      llmResponse = await provider.generate(request);
    } catch (err) {
      if (err instanceof DirectorRuntimeError) throw err;
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'ERR_STRUCTURED_OUTPUT_VALIDATION' || code === 'ERR_MALFORMED_LLM_RESPONSE') {
        // A completion was received (and billed) but violated the output contract: repairable.
        const details = (err as { details?: { rawContent?: unknown } }).details;
        rawContent = typeof details?.rawContent === 'string' ? details.rawContent : '';
        repairReason = msg;
      } else if (useSchema && !fellBack && autoFallback && isUnsupportedResponseFormatError(msg)) {
        fellBack = true;
        mode = 'json_object';
        repair--; // provider produced no completion; fallback gets its own attempt/reservation
        continue;
      } else {
        throw new DirectorLlmRequestFailedError(`LLM provider execution failed: ${msg}`, {
          provider: provider.providerName,
          correlationId,
          error: msg,
        });
      }
    }

    if (!repairReason && llmResponse) {
      if (llmResponse.error) {
        throw new DirectorLlmRequestFailedError(`LLM provider returned error: ${llmResponse.error.message}`, {
          code: llmResponse.error.code,
          correlationId,
        });
      }
      rawContent = typeof llmResponse.content === 'string' ? llmResponse.content : '';
      let raw: unknown;
      try {
        raw = parseContent(llmResponse, correlationId);
      } catch (err) {
        if (repair >= maxRepair) throw err;
        repairReason = err instanceof Error ? err.message : String(err);
      }
      if (!repairReason) {
        let bound: unknown;
        try {
          bound = bindDecisionToEnvelope(raw, {
            projectId: input.projectId,
            directorSessionId: input.directorSessionId,
            contextFingerprint: snapshot.logicalFingerprint,
          });
        } catch (err) {
          // Identity / fingerprint spoofing is a security property: never repaired, fail closed.
          if (err instanceof DecisionEnvelopeSpoofError) throw mapSpoofError(err);
          throw err;
        }
        const parsed = DirectorActionZodSchema.safeParse(bound);
        if (parsed.success) {
          action = parsed.data as DirectorAction;
          break;
        }
        repairReason = `LLM output failed DirectorAction schema validation: ${parsed.error.issues[0]?.message ?? 'validation failed'}\n${formatValidationIssues(parsed.error.issues)}`;
        if (repair >= maxRepair) {
          throw new DirectorActionValidationFailedError(repairReason, { issues: parsed.error.issues, correlationId });
        }
      }
    }

    if (repair >= maxRepair) {
      throw new DirectorActionValidationFailedError(
        `LLM output failed DirectorAction validation after ${requestSeq} request(s): ${repairReason ?? 'unknown'}`,
        { correlationId }
      );
    }
    messages = [
      ...baseMessages,
      ...(rawContent ? [Object.freeze({ role: LlmRole.ASSISTANT, content: rawContent.slice(0, 8000) })] : []),
      Object.freeze({
        role: LlmRole.USER,
        content: [
          'Your previous response was rejected by the AIDM validator:',
          sanitizeRepairText(repairReason ?? 'invalid output'),
          'Return ONE corrected JSON object that follows the RESPONSE FORMAT exactly. Do not include envelope fields.',
        ].join('\n'),
      }),
    ];
  }

  if (!action || !llmResponse) {
    throw new DirectorActionValidationFailedError('LLM output did not yield a valid DirectorAction.', { correlationId });
  }
  // Defense in depth: envelope must equal authoritative values.
  if (
    action.projectId !== input.projectId ||
    action.directorSessionId !== input.directorSessionId ||
    action.basedOnContextFingerprint !== snapshot.logicalFingerprint
  ) {
    throw new DirectorActionContextMismatchError('DirectorAction envelope binding mismatch. Fail-closed rejection.', { correlationId });
  }

  const reasoningId = `dir-rsn-${crypto.randomUUID()}`;
  const result: DirectorReasoningResult = Object.freeze({
    reasoningId,
    projectId: input.projectId,
    directorSessionId: input.directorSessionId,
    contextFingerprint: snapshot.logicalFingerprint,
    action,
    provider: provider.providerName,
    model: llmResponse.model || p.model || provider.defaultModel,
    correlationId,
    finishReason: String(llmResponse.finish_reason ?? 'STOP'),
    usage: llmResponse.usage ? Object.freeze({ ...llmResponse.usage }) : null,
    createdAt: new Date().toISOString(),
  });

  if (p.historyManager) {
    try {
      await p.historyManager.appendEvent({
        eventType: 'DIRECTOR_REASONING_COMPLETED',
        actor: Actor.DIRECTOR,
        payload: {
          reasoningId,
          projectId: input.projectId,
          directorSessionId: input.directorSessionId,
          contextFingerprint: snapshot.logicalFingerprint,
          actionType: action.actionType,
          actionId: action.actionId,
          confidence: action.confidence,
          correlationId,
          provider: provider.providerName,
          envelopeSource: 'SYSTEM',
          requests: requestSeq,
        },
      });
    } catch {
      // Audit failures must not break reasoning runtime
    }
  }
  return result;
}
