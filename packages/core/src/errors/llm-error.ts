import { AidmError, type AidmErrorDetails } from './aidm-error.js';

export type LlmErrorCode =
  | 'ERR_INVALID_LLM_REQUEST'
  | 'ERR_INVALID_PROTOCOL_PAYLOAD'
  | 'ERR_LLM_PROVIDER_UNAVAILABLE'
  | 'ERR_LLM_EXECUTION_FAILURE'
  | 'ERR_LLM_TIMEOUT'
  | 'ERR_MALFORMED_LLM_RESPONSE'
  | 'ERR_STRUCTURED_OUTPUT_VALIDATION'
  | 'ERR_UNSUPPORTED_LLM_CAPABILITY';

/**
 * Sanitizes potentially sensitive keys or tokens from error messages and details.
 */
export function sanitizeSecrets(text: string): string {
  return text
    .replace(/(?:sk-[a-zA-Z0-9_-]{10,})/g, '***REDACTED_KEY***')
    .replace(/(?:Bearer\s+[a-zA-Z0-9_.-]{10,})/gi, 'Bearer ***REDACTED_TOKEN***')
    .replace(/(?:key|token|secret|password)=([^&\s]+)/gi, '$1=***REDACTED***');
}

function sanitizeDetails(details?: AidmErrorDetails): AidmErrorDetails | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(details)) {
    if (typeof val === 'string') {
      sanitized[key] = sanitizeSecrets(val);
    } else if (
      key.toLowerCase().includes('secret') ||
      key.toLowerCase().includes('key') ||
      key.toLowerCase().includes('token') ||
      key.toLowerCase().includes('auth')
    ) {
      sanitized[key] = '***REDACTED***';
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

// 1. Invalid LLM Request Error
export interface InvalidLlmRequestDetails extends AidmErrorDetails {
  field?: string;
  correlationId?: string;
  reason?: string;
  validationErrors?: string[];
}

export class InvalidLlmRequestError extends AidmError {
  readonly field?: string;
  readonly correlationId?: string;
  readonly reason?: string;
  readonly validationErrors?: string[];

  constructor(
    message: string,
    details?: InvalidLlmRequestDetails,
    code: LlmErrorCode = 'ERR_INVALID_LLM_REQUEST'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'InvalidLlmRequestError';
    this.field = details?.field;
    this.correlationId = details?.correlationId;
    this.reason = details?.reason;
    this.validationErrors = details?.validationErrors;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 2. Invalid Protocol Payload Error
export interface InvalidProtocolPayloadDetails extends AidmErrorDetails {
  messageType?: string;
  protocolVersion?: string;
  field?: string;
  reason?: string;
}

export class InvalidProtocolPayloadError extends AidmError {
  readonly messageType?: string;
  readonly protocolVersion?: string;
  readonly field?: string;
  readonly reason?: string;

  constructor(
    message: string,
    details?: InvalidProtocolPayloadDetails,
    code: LlmErrorCode = 'ERR_INVALID_PROTOCOL_PAYLOAD'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'InvalidProtocolPayloadError';
    this.messageType = details?.messageType;
    this.protocolVersion = details?.protocolVersion;
    this.field = details?.field;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 3. LLM Provider Unavailable Error
export interface LlmProviderUnavailableDetails extends AidmErrorDetails {
  providerId?: string;
  model?: string;
  endpoint?: string;
  reason?: string;
}

export class LlmProviderUnavailableError extends AidmError {
  readonly providerId?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly reason?: string;

  constructor(
    message: string,
    details?: LlmProviderUnavailableDetails,
    code: LlmErrorCode = 'ERR_LLM_PROVIDER_UNAVAILABLE'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'LlmProviderUnavailableError';
    this.providerId = details?.providerId;
    this.model = details?.model;
    this.endpoint = details?.endpoint;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 4. LLM Execution Failure Error
export interface LlmExecutionDetails extends AidmErrorDetails {
  providerId?: string;
  model?: string;
  correlationId?: string;
  statusCode?: number;
  providerErrorCode?: string;
  rawError?: unknown;
}

export class LlmExecutionError extends AidmError {
  readonly providerId?: string;
  readonly model?: string;
  readonly correlationId?: string;
  readonly statusCode?: number;
  readonly providerErrorCode?: string;

  constructor(
    message: string,
    details?: LlmExecutionDetails,
    code: LlmErrorCode = 'ERR_LLM_EXECUTION_FAILURE'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'LlmExecutionError';
    this.providerId = details?.providerId;
    this.model = details?.model;
    this.correlationId = details?.correlationId;
    this.statusCode = details?.statusCode;
    this.providerErrorCode = details?.providerErrorCode;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 5. LLM Timeout Error
export interface LlmTimeoutDetails extends AidmErrorDetails {
  providerId?: string;
  model?: string;
  correlationId?: string;
  timeoutMs?: number;
}

export class LlmTimeoutError extends AidmError {
  readonly providerId?: string;
  readonly model?: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;

  constructor(
    message: string,
    details?: LlmTimeoutDetails,
    code: LlmErrorCode = 'ERR_LLM_TIMEOUT'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'LlmTimeoutError';
    this.providerId = details?.providerId;
    this.model = details?.model;
    this.correlationId = details?.correlationId;
    this.timeoutMs = details?.timeoutMs;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 6. Malformed LLM Response Error
export interface MalformedLlmResponseDetails extends AidmErrorDetails {
  providerId?: string;
  model?: string;
  correlationId?: string;
  rawResponse?: unknown;
  reason?: string;
}

export class MalformedLlmResponseError extends AidmError {
  readonly providerId?: string;
  readonly model?: string;
  readonly correlationId?: string;
  readonly reason?: string;

  constructor(
    message: string,
    details?: MalformedLlmResponseDetails,
    code: LlmErrorCode = 'ERR_MALFORMED_LLM_RESPONSE'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'MalformedLlmResponseError';
    this.providerId = details?.providerId;
    this.model = details?.model;
    this.correlationId = details?.correlationId;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 7. Structured Output Validation Error
export interface StructuredOutputValidationDetails extends AidmErrorDetails {
  providerId?: string;
  model?: string;
  correlationId?: string;
  rawContent?: string;
  missingFields?: string[];
  schemaErrors?: string[];
  reason?: string;
}

export class StructuredOutputValidationError extends AidmError {
  readonly providerId?: string;
  readonly model?: string;
  readonly correlationId?: string;
  readonly missingFields?: string[];
  readonly schemaErrors?: string[];
  readonly reason?: string;

  constructor(
    message: string,
    details?: StructuredOutputValidationDetails,
    code: LlmErrorCode = 'ERR_STRUCTURED_OUTPUT_VALIDATION'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'StructuredOutputValidationError';
    this.providerId = details?.providerId;
    this.model = details?.model;
    this.correlationId = details?.correlationId;
    this.missingFields = details?.missingFields;
    this.schemaErrors = details?.schemaErrors;
    this.reason = details?.reason;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 8. Unsupported LLM Capability Error
export interface UnsupportedLlmCapabilityDetails extends AidmErrorDetails {
  providerId?: string;
  capability?: string;
  supportedCapabilities?: readonly string[];
  reason?: string;
}

export class UnsupportedLlmCapabilityError extends AidmError {
  readonly providerId?: string;
  readonly capability?: string;
  readonly supportedCapabilities?: readonly string[];

  constructor(
    message: string,
    details?: UnsupportedLlmCapabilityDetails,
    code: LlmErrorCode = 'ERR_UNSUPPORTED_LLM_CAPABILITY'
  ) {
    const cleanMsg = sanitizeSecrets(message);
    const formattedMessage = cleanMsg.startsWith(`[${code}]`)
      ? cleanMsg
      : `[${code}] ${cleanMsg}`;

    super(formattedMessage, code, sanitizeDetails(details));
    this.name = 'UnsupportedLlmCapabilityError';
    this.providerId = details?.providerId;
    this.capability = details?.capability;
    this.supportedCapabilities = details?.supportedCapabilities;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
