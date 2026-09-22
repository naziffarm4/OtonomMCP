import type { TokenTelemetry } from '../token-budget/budget-types.js';
import {
  InvalidLlmRequestError,
  InvalidProtocolPayloadError,
  StructuredOutputValidationError,
} from '../errors/llm-error.js';

// ============================================================================
// 1. LLM ROLES & FINISH REASONS
// ============================================================================

export const LlmRole = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
} as const;

export type LlmRole = (typeof LlmRole)[keyof typeof LlmRole];
export const LLM_ROLES = Object.values(LlmRole) as readonly LlmRole[];

export function isLlmRole(value: unknown): value is LlmRole {
  return typeof value === 'string' && (LLM_ROLES as readonly string[]).includes(value);
}

export const LlmFinishReason = {
  STOP: 'STOP',
  LENGTH: 'LENGTH',
  CONTENT_FILTER: 'CONTENT_FILTER',
  TOOL_CALL: 'TOOL_CALL',
  ERROR: 'ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;

export type LlmFinishReason = (typeof LlmFinishReason)[keyof typeof LlmFinishReason];
export const LLM_FINISH_REASONS = Object.values(LlmFinishReason) as readonly LlmFinishReason[];

export function isLlmFinishReason(value: unknown): value is LlmFinishReason {
  return (
    typeof value === 'string' && (LLM_FINISH_REASONS as readonly string[]).includes(value)
  );
}

// ============================================================================
// 2. RESPONSE FORMATS & SCHEMA
// ============================================================================

export const LlmResponseFormat = {
  TEXT: 'TEXT',
  JSON_OBJECT: 'JSON_OBJECT',
  JSON_SCHEMA: 'JSON_SCHEMA',
} as const;

export type LlmResponseFormat = (typeof LlmResponseFormat)[keyof typeof LlmResponseFormat];
export const LLM_RESPONSE_FORMATS = Object.values(LlmResponseFormat) as readonly LlmResponseFormat[];

export function isLlmResponseFormat(value: unknown): value is LlmResponseFormat {
  return (
    typeof value === 'string' && (LLM_RESPONSE_FORMATS as readonly string[]).includes(value)
  );
}

export interface LlmJsonSchema {
  readonly name: string;
  readonly description?: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

// ============================================================================
// 3. MESSAGES & REQUEST CONTRACTS
// ============================================================================

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
  readonly name?: string;
}

export interface LlmRequestCorrelation {
  readonly correlation_id: string;
  readonly project_id: string;
  readonly task_id?: string | null;
  readonly attempt?: number | null;
}

export interface LlmDirectorContext {
  readonly project_id: string;
  readonly task_id?: string | null;
  readonly objective?: string | null;
  readonly acceptance_criteria?: readonly string[] | null;
  readonly attempt?: number | null;
  readonly max_attempts?: number | null;
  readonly relevant_context?: Readonly<Record<string, unknown>> | null;
}

export interface LlmRequest {
  readonly correlation: LlmRequestCorrelation;
  readonly messages: readonly LlmMessage[];
  readonly director_context: LlmDirectorContext;
  readonly model?: string | null;
  readonly temperature?: number | null;
  readonly max_tokens?: number | null;
  readonly response_format: LlmResponseFormat;
  readonly json_schema?: LlmJsonSchema | null;
  readonly timeout_ms?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface LlmRequestInput {
  correlation?: Partial<LlmRequestCorrelation>;
  correlation_id?: string;
  correlationId?: string;
  project_id?: string;
  projectId?: string;
  task_id?: string;
  taskId?: string;
  attempt?: number;
  system_prompt?: string;
  systemPrompt?: string;
  user_prompt?: string;
  userPrompt?: string;
  messages?: readonly LlmMessage[];
  director_context?: Partial<LlmDirectorContext>;
  directorContext?: Partial<LlmDirectorContext>;
  objective?: string;
  acceptance_criteria?: readonly string[];
  acceptanceCriteria?: readonly string[];
  relevant_context?: Record<string, unknown>;
  relevantContext?: Record<string, unknown>;
  max_attempts?: number;
  maxAttempts?: number;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  maxTokens?: number;
  response_format?: LlmResponseFormat;
  responseFormat?: LlmResponseFormat;
  json_schema?: LlmJsonSchema;
  jsonSchema?: LlmJsonSchema;
  timeout_ms?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 4. RESPONSE CONTRACTS (Requirement 6 & 7)
// ============================================================================

export interface LlmResponse<TStructured = unknown> {
  readonly correlation: LlmRequestCorrelation;
  readonly provider: string;
  readonly model: string;
  readonly content: string;
  readonly structured_output: TStructured | null;
  readonly finish_reason: LlmFinishReason;
  readonly usage: TokenTelemetry;
  readonly raw_metadata: Readonly<Record<string, unknown>> | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  } | null;
}

export interface RawLlmResponse {
  readonly provider: string;
  readonly model?: string | null;
  readonly content?: string | null;
  readonly finish_reason?: string | null;
  readonly usage?: Partial<TokenTelemetry> | null;
  readonly raw_metadata?: Record<string, unknown> | null;
  readonly error?: {
    readonly code?: string;
    readonly message: string;
    readonly details?: unknown;
  } | null;
}

// ============================================================================
// 5. TYPED PROTOCOL ENVELOPES (Requirement 2)
// ============================================================================

export interface LlmProtocolRequestEnvelope {
  readonly protocol_version: '1.0';
  readonly message_type: 'LLM_REQUEST';
  readonly timestamp: string;
  readonly correlation_id: string;
  readonly payload: LlmRequest;
}

export interface LlmProtocolResponseEnvelope {
  readonly protocol_version: '1.0';
  readonly message_type: 'LLM_RESPONSE' | 'LLM_ERROR';
  readonly timestamp: string;
  readonly correlation_id: string;
  readonly payload:
    | LlmResponse
    | {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
}

export type LlmProtocolEnvelope =
  | LlmProtocolRequestEnvelope
  | LlmProtocolResponseEnvelope;

// ============================================================================
// 6. DETERMINISTIC HELPERS & VALIDATORS
// ============================================================================

export function generateDeterministicLlmCorrelationId(
  projectId: string,
  taskId?: string | null,
  purpose?: string | null,
  attempt?: number | null
): string {
  const pId = projectId.trim();
  const tId = taskId && taskId.trim().length > 0 ? taskId.trim() : 'general';
  const purp = purpose && purpose.trim().length > 0 ? purpose.trim() : 'director';
  const att = typeof attempt === 'number' && Number.isInteger(attempt) ? attempt : 1;
  return `corr:llm:${pId}:${tId}:${purp}:${att}`;
}

export function validateLlmRequest(input: unknown): LlmRequest {
  if (!input || typeof input !== 'object') {
    throw new InvalidLlmRequestError('LLM request must be a non-null object', {
      reason: 'NON_OBJECT_INPUT',
    });
  }

  const raw = input as LlmRequestInput;

  // 1. Project ID
  const projectId = (
    raw.project_id ??
    raw.projectId ??
    raw.director_context?.project_id ??
    raw.directorContext?.project_id ??
    raw.correlation?.project_id
  )?.trim();

  if (!projectId) {
    throw new InvalidLlmRequestError('Request project_id is required and cannot be empty', {
      field: 'project_id',
      reason: 'MISSING_PROJECT_ID',
    });
  }

  // 2. Task ID
  const taskId = (
    raw.task_id ??
    raw.taskId ??
    raw.director_context?.task_id ??
    raw.directorContext?.task_id ??
    raw.correlation?.task_id
  )?.trim() || null;

  // 3. Attempt
  const rawAttempt =
    raw.attempt ??
    raw.director_context?.attempt ??
    raw.directorContext?.attempt ??
    raw.correlation?.attempt;
  const attempt =
    typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt >= 1
      ? rawAttempt
      : 1;

  // 4. Correlation ID (deterministic default if omitted)
  const correlationId = (
    raw.correlation_id ??
    raw.correlationId ??
    raw.correlation?.correlation_id
  )?.trim() || generateDeterministicLlmCorrelationId(projectId, taskId, 'director', attempt);

  const correlation: LlmRequestCorrelation = Object.freeze({
    correlation_id: correlationId,
    project_id: projectId,
    task_id: taskId,
    attempt,
  });

  // 5. Messages
  let messages: LlmMessage[] = [];
  if (Array.isArray(raw.messages) && raw.messages.length > 0) {
    messages = raw.messages.map((m, idx) => {
      if (!m || typeof m !== 'object') {
        throw new InvalidLlmRequestError(`Message at index ${idx} must be an object`, {
          field: `messages[${idx}]`,
          correlationId,
          reason: 'INVALID_MESSAGE_OBJECT',
        });
      }
      if (!isLlmRole(m.role)) {
        throw new InvalidLlmRequestError(
          `Message at index ${idx} has invalid role "${m.role}". Allowed roles: ${LLM_ROLES.join(', ')}`,
          {
            field: `messages[${idx}].role`,
            correlationId,
            reason: 'INVALID_MESSAGE_ROLE',
          }
        );
      }
      if (typeof m.content !== 'string') {
        throw new InvalidLlmRequestError(`Message at index ${idx} content must be a string`, {
          field: `messages[${idx}].content`,
          correlationId,
          reason: 'INVALID_MESSAGE_CONTENT',
        });
      }
      return Object.freeze({
        role: m.role,
        content: m.content,
        name: typeof m.name === 'string' ? m.name.trim() : undefined,
      });
    });
  } else {
    // Synthesize from system_prompt and user_prompt if provided
    const sysPrompt = (raw.system_prompt ?? raw.systemPrompt)?.trim();
    const userPrompt = (raw.user_prompt ?? raw.userPrompt)?.trim();

    if (sysPrompt) {
      messages.push(Object.freeze({ role: LlmRole.SYSTEM, content: sysPrompt }));
    }
    if (userPrompt) {
      messages.push(Object.freeze({ role: LlmRole.USER, content: userPrompt }));
    }
  }

  if (messages.length === 0) {
    throw new InvalidLlmRequestError(
      'LLM request must contain at least one message or a user/system prompt',
      {
        field: 'messages',
        correlationId,
        reason: 'EMPTY_MESSAGES',
      }
    );
  }

  // 6. Temperature check
  let temperature: number | null = null;
  if (raw.temperature !== undefined && raw.temperature !== null) {
    if (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      throw new InvalidLlmRequestError(
        `Temperature must be a finite number between 0 and 2 (received: ${raw.temperature})`,
        {
          field: 'temperature',
          correlationId,
          reason: 'INVALID_TEMPERATURE',
        }
      );
    }
    temperature = raw.temperature;
  }

  // 7. Max tokens check
  let maxTokens: number | null = null;
  const rawMaxTokens = raw.max_tokens ?? raw.maxTokens;
  if (rawMaxTokens !== undefined && rawMaxTokens !== null) {
    if (typeof rawMaxTokens !== 'number' || !Number.isInteger(rawMaxTokens) || rawMaxTokens < 1) {
      throw new InvalidLlmRequestError(
        `max_tokens must be a positive integer >= 1 (received: ${rawMaxTokens})`,
        {
          field: 'max_tokens',
          correlationId,
          reason: 'INVALID_MAX_TOKENS',
        }
      );
    }
    maxTokens = rawMaxTokens;
  }

  // 8. Response Format & Schema
  const respFormat = raw.response_format ?? raw.responseFormat ?? LlmResponseFormat.TEXT;
  if (!isLlmResponseFormat(respFormat)) {
    throw new InvalidLlmRequestError(
      `response_format must be one of: ${LLM_RESPONSE_FORMATS.join(', ')} (received: ${respFormat})`,
      {
        field: 'response_format',
        correlationId,
        reason: 'INVALID_RESPONSE_FORMAT',
      }
    );
  }

  const rawSchema = raw.json_schema ?? raw.jsonSchema ?? null;
  let jsonSchema: LlmJsonSchema | null = null;
  if (respFormat === LlmResponseFormat.JSON_SCHEMA) {
    if (!rawSchema || typeof rawSchema !== 'object' || typeof rawSchema.name !== 'string' || !rawSchema.schema) {
      throw new InvalidLlmRequestError(
        'json_schema with non-empty name and schema object is required when response_format is JSON_SCHEMA',
        {
          field: 'json_schema',
          correlationId,
          reason: 'MISSING_JSON_SCHEMA',
        }
      );
    }
    jsonSchema = Object.freeze({
      name: rawSchema.name.trim(),
      description: typeof rawSchema.description === 'string' ? rawSchema.description : undefined,
      schema: Object.freeze({ ...rawSchema.schema }),
      strict: rawSchema.strict ?? true,
    });
  }

  // 9. Director Context
  const rawDirCtx = raw.director_context ?? raw.directorContext ?? {};
  const acList = raw.acceptance_criteria ?? raw.acceptanceCriteria ?? rawDirCtx.acceptance_criteria;
  const acceptanceCriteria = Array.isArray(acList) ? Object.freeze([...acList]) : undefined;
  const relCtx = raw.relevant_context ?? raw.relevantContext ?? rawDirCtx.relevant_context ?? null;

  const directorContext: LlmDirectorContext = Object.freeze({
    project_id: projectId,
    task_id: taskId,
    objective: (raw.objective ?? rawDirCtx.objective)?.trim() || null,
    acceptance_criteria: acceptanceCriteria ?? null,
    attempt,
    max_attempts: raw.max_attempts ?? raw.maxAttempts ?? rawDirCtx.max_attempts ?? null,
    relevant_context: relCtx ? Object.freeze({ ...relCtx }) : null,
  });

  const timeoutMs = raw.timeout_ms ?? raw.timeoutMs ?? null;

  return Object.freeze({
    correlation,
    messages: Object.freeze([...messages]),
    director_context: directorContext,
    model: raw.model ? raw.model.trim() : null,
    temperature,
    max_tokens: maxTokens,
    response_format: respFormat,
    json_schema: jsonSchema,
    timeout_ms: timeoutMs,
    metadata: raw.metadata ? Object.freeze({ ...raw.metadata }) : null,
  });
}

// ============================================================================
// 7. STRUCTURED OUTPUT VALIDATOR (Requirement 8)
// ============================================================================

export function validateStructuredOutput<T = unknown>(
  content: string,
  schema?: LlmJsonSchema | null,
  customValidator?: (parsed: unknown) => T
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new StructuredOutputValidationError(
      `Failed to parse structured output as valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        rawContent: content,
        reason: 'INVALID_JSON',
      }
    );
  }

  if (schema && schema.schema && typeof schema.schema === 'object') {
    const requiredFields = (schema.schema as { required?: unknown }).required;
    if (Array.isArray(requiredFields) && parsed && typeof parsed === 'object') {
      const parsedObj = parsed as Record<string, unknown>;
      const missing: string[] = [];
      for (const field of requiredFields) {
        if (typeof field === 'string' && (parsedObj[field] === undefined || parsedObj[field] === null)) {
          missing.push(field);
        }
      }
      if (missing.length > 0) {
        throw new StructuredOutputValidationError(
          `Structured output is missing required schema fields: ${missing.join(', ')}`,
          {
            rawContent: content,
            missingFields: missing,
            reason: 'MISSING_REQUIRED_FIELDS',
          }
        );
      }
    }
  }

  if (customValidator) {
    try {
      return customValidator(parsed);
    } catch (err) {
      if (err instanceof StructuredOutputValidationError) {
        throw err;
      }
      throw new StructuredOutputValidationError(
        `Structured output failed custom validation: ${err instanceof Error ? err.message : String(err)}`,
        {
          rawContent: content,
          reason: 'CUSTOM_VALIDATOR_FAILED',
        }
      );
    }
  }

  return parsed as T;
}

// ============================================================================
// 8. TYPED PROTOCOL ENVELOPE VALIDATOR & SERIALIZATION (Requirement 2)
// ============================================================================

export function serializeLlmProtocolPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (err) {
    throw new InvalidProtocolPayloadError(
      `Failed to serialize LLM protocol payload: ${err instanceof Error ? err.message : String(err)}`,
      { reason: 'SERIALIZATION_FAILED' }
    );
  }
}

export function deserializeLlmProtocolPayload<T = unknown>(jsonStr: string): T {
  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    throw new InvalidProtocolPayloadError(
      `Failed to deserialize LLM protocol payload as JSON: ${err instanceof Error ? err.message : String(err)}`,
      { reason: 'DESERIALIZATION_FAILED' }
    );
  }
}

export function validateLlmProtocolEnvelope(data: unknown): LlmProtocolEnvelope {
  if (!data || typeof data !== 'object') {
    throw new InvalidProtocolPayloadError('Protocol envelope must be a non-null object', {
      reason: 'NON_OBJECT_ENVELOPE',
    });
  }

  const obj = data as Record<string, unknown>;

  if (obj.protocol_version !== '1.0') {
    throw new InvalidProtocolPayloadError(
      `Invalid protocol_version "${obj.protocol_version}". Expected "1.0"`,
      {
        protocolVersion: String(obj.protocol_version),
        field: 'protocol_version',
        reason: 'UNSUPPORTED_PROTOCOL_VERSION',
      }
    );
  }

  const allowedTypes = ['LLM_REQUEST', 'LLM_RESPONSE', 'LLM_ERROR'];
  if (typeof obj.message_type !== 'string' || !allowedTypes.includes(obj.message_type)) {
    throw new InvalidProtocolPayloadError(
      `Invalid message_type "${obj.message_type}". Allowed: ${allowedTypes.join(', ')}`,
      {
        messageType: String(obj.message_type),
        field: 'message_type',
        reason: 'INVALID_MESSAGE_TYPE',
      }
    );
  }

  if (typeof obj.timestamp !== 'string' || !obj.timestamp.trim()) {
    throw new InvalidProtocolPayloadError('Protocol envelope timestamp is required and must be a string', {
      field: 'timestamp',
      reason: 'MISSING_TIMESTAMP',
    });
  }

  if (typeof obj.correlation_id !== 'string' || !obj.correlation_id.trim()) {
    throw new InvalidProtocolPayloadError(
      'Protocol envelope correlation_id is required and cannot be empty',
      {
        field: 'correlation_id',
        reason: 'MISSING_CORRELATION_ID',
      }
    );
  }

  if (!obj.payload || typeof obj.payload !== 'object') {
    throw new InvalidProtocolPayloadError('Protocol envelope payload must be a non-null object', {
      field: 'payload',
      reason: 'MISSING_PAYLOAD',
    });
  }

  return Object.freeze(obj as unknown as LlmProtocolEnvelope);
}
