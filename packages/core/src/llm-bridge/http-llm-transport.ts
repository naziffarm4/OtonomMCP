/**
 * @file http-llm-transport.ts
 * @description Production HTTP Transport implementation for LLM Provider Adapters (TASK-P18-01).
 *
 * INVARIANTS:
 * 1. Zero external dependencies: Uses native Node.js 18+ `fetch` API.
 * 2. Implements existing LlmTransport<TWirePayload, TWireResponse> contract.
 * 3. Strict fail-closed semantics: Never silently produces simulated or mock responses.
 * 4. Deterministic timeout enforcement with AbortSignal cancellation support.
 * 5. Secure credential handling: API keys and bearer tokens are never exposed in logs,
 *    telemetry, error messages, or serialized representations.
 * 6. Header propagation: Ensures Content-Type, Authorization, Correlation IDs (x-correlation-id,
 *    x-request-id) are transmitted safely.
 * 7. Strongly typed error mapping: Maps HTTP 400, 401, 403, 408, 429, 5xx, timeouts,
 *    and malformed responses into structured AIDM error types.
 */

import type {
  LlmTransport,
  LlmTransportRequest,
  LlmTransportResponse,
} from './llm-transport.js';
import {
  LlmTransportHttpError,
  LlmTransportUnavailableError,
} from './llm-transport.js';
import {
  LlmTimeoutError,
  MalformedLlmResponseError,
  InvalidLlmRequestError,
  sanitizeSecrets,
} from '../errors/llm-error.js';
import { BudgetError } from '../errors/budget-error.js';
import type { BudgetManager } from '../budget/budget-manager.js';
import { TransportSecurityRegistry } from './transport-security-registry.js';

// ============================================================================
// 1. CONFIGURATION INTERFACE
// ============================================================================

export interface HttpLlmTransportConfig {
  /** Unique name of this transport instance (defaults to 'http-llm-transport') */
  readonly transportName?: string;
  /** Base or target endpoint URI (e.g. 'https://api.openai.com/v1/chat/completions') */
  readonly endpoint?: string;
  /** Optional dependency-injected API key (never leaked or logged) */
  readonly apiKey?: string | null;
  /** Header name used for authorization (defaults to 'authorization') */
  readonly authHeaderName?: string;
  /** Prefix for auth header value (defaults to 'Bearer ' when authHeaderName is 'authorization') */
  readonly authHeaderPrefix?: string;
  /** Default custom headers applied to all outgoing requests */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Default timeout in milliseconds (defaults to 30000ms) */
  readonly defaultTimeoutMs?: number;
  /** Whether to throw LlmTransportHttpError on HTTP status >= 400 (defaults to true) */
  readonly throwHttpErrorOnStatusGte400?: boolean;
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  readonly fetchFn?: typeof fetch;
  /** Whether to enforce budget authorization header on every outgoing HTTP request (P18-03) */
  readonly enforceBudget?: boolean;
  /** Optional authoritative BudgetManager to verify and claim reservations in SQLite (P18-03) */
  readonly budgetManager?: BudgetManager;
}

// ============================================================================
// 2. SECRET SANITIZATION HELPERS
// ============================================================================

/**
 * Recursively redacts sensitive values and keys in arbitrary objects or arrays.
 */
export function sanitizeSecretsInObject<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeSecrets(value) as unknown as T;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretsInObject(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lowerKey = k.toLowerCase();
      // Token counts are telemetry metrics, not credentials
      const isTokenMetric =
        lowerKey.endsWith('_tokens') ||
        lowerKey.endsWith('tokens') ||
        lowerKey.startsWith('token_count') ||
        lowerKey === 'tokens';

      if (
        !isTokenMetric &&
        (lowerKey.includes('secret') ||
          lowerKey.includes('apikey') ||
          lowerKey.includes('api_key') ||
          lowerKey.includes('password') ||
          lowerKey.includes('auth') ||
          (lowerKey.includes('token') && typeof v === 'string') ||
          (lowerKey === 'key' && typeof v === 'string'))
      ) {
        if (typeof v === 'string') {
          sanitizedObj[k] = sanitizeSecrets(v);
        } else {
          sanitizedObj[k] = '***REDACTED***';
        }
      } else {
        sanitizedObj[k] = sanitizeSecretsInObject(v);
      }
    }
    return sanitizedObj as T;
  }
  return value;
}

/**
 * Returns a descriptive status string for standard HTTP error codes.
 */
export function formatHttpStatusDescription(status: number, statusText?: string): string {
  let category = statusText || 'Error';
  if (status === 400) {
    category = 'Bad Request (Invalid Request)';
  } else if (status === 401) {
    category = 'Unauthorized (Authentication Failure)';
  } else if (status === 403) {
    category = 'Forbidden (Authorization Failure)';
  } else if (status === 404) {
    category = 'Not Found';
  } else if (status === 408) {
    category = 'Request Timeout';
  } else if (status === 429) {
    category = 'Too Many Requests (Rate Limit Exceeded)';
  } else if (status === 500) {
    category = 'Internal Server Error (Provider Error)';
  } else if (status === 502) {
    category = 'Bad Gateway (Provider Outage)';
  } else if (status === 503) {
    category = 'Service Unavailable (Provider Outage)';
  } else if (status === 504) {
    category = 'Gateway Timeout (Provider Outage)';
  }
  return `HTTP ${status}: ${category}`;
}

// ============================================================================
// 3. HTTP LLM TRANSPORT IMPLEMENTATION
// ============================================================================

const HTTP_TRANSPORT_STATE = new WeakMap<object, { available: boolean; reason?: string }>();
const TRANSPORT_BUDGET_MANAGERS = new WeakMap<object, BudgetManager>();

export class HttpLlmTransport<TWirePayload = unknown, TWireResponse = unknown>
  implements LlmTransport<TWirePayload, TWireResponse>
{
  readonly transportName: string;
  readonly transportKind = 'network_http' as const;
  readonly isLiveNetworkTransport = true;
  readonly endpoint?: string;
  readonly enforceBudget: boolean;

  private readonly apiKey: string | null;
  private readonly authHeaderName: string;
  private readonly authHeaderPrefix: string;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly defaultTimeoutMs: number;
  private readonly throwHttpErrorOnStatusGte400: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(config: HttpLlmTransportConfig = {}) {
    this.transportName = config.transportName ?? 'http-llm-transport';
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey ?? null;
    this.enforceBudget = config.enforceBudget ?? false;
    if (config.budgetManager) {
      TRANSPORT_BUDGET_MANAGERS.set(this, config.budgetManager);
    }
    this.authHeaderName = (config.authHeaderName || 'authorization').toLowerCase();
    this.authHeaderPrefix =
      config.authHeaderPrefix !== undefined
        ? config.authHeaderPrefix
        : this.authHeaderName === 'authorization'
          ? 'Bearer '
          : '';
    this.defaultHeaders = Object.freeze({ ...(config.defaultHeaders ?? {}) });
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30000;
    this.throwHttpErrorOnStatusGte400 = config.throwHttpErrorOnStatusGte400 ?? true;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);

    // Initialize availability state in isolated WeakMap
    HTTP_TRANSPORT_STATE.set(this, { available: true });

    // Register with authoritative TransportSecurityRegistry and freeze instance
    TransportSecurityRegistry.registerLiveNetworkTransport(this);
  }

  get budgetManager(): BudgetManager | undefined {
    return TRANSPORT_BUDGET_MANAGERS.get(this);
  }

  setBudgetManager(budgetManager: BudgetManager): void {
    TRANSPORT_BUDGET_MANAGERS.set(this, budgetManager);
  }

  get unavailableReason(): string | undefined {
    return HTTP_TRANSPORT_STATE.get(this)?.reason;
  }

  setAvailable(available: boolean, reason?: string): void {
    HTTP_TRANSPORT_STATE.set(this, { available, reason });
  }

  /**
   * Checks whether the transport is ready and configured.
   */
  async isAvailable(): Promise<boolean> {
    const state = HTTP_TRANSPORT_STATE.get(this);
    if (state && !state.available) {
      return false;
    }
    if (this.endpoint) {
      try {
        const u = new URL(this.endpoint);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Dispatches a wire request through the real HTTP transport.
   */
  async send(
    request: LlmTransportRequest<TWirePayload>
  ): Promise<LlmTransportResponse<TWireResponse>> {
    // 0. Budget Authorization Check (P18-03)
    if (this.enforceBudget) {
      const reservationId =
        request.headers?.['x-budget-reservation-id'] ??
        (request.body as any)?.metadata?.__aidm_reservation_id;
      if (!reservationId) {
        throw new BudgetError(
          `Direct call to HTTP transport "${this.transportName}" without budget reservation header is strictly prohibited.`,
          'ERR_BUDGET_REQUIRED',
          { transportName: this.transportName, reason: 'DIRECT_TRANSPORT_CALL_PROHIBITED' }
        );
      }

      if (this.budgetManager) {
        // Authoritative resolution of required binding fields:
        const expectedModelId =
          (request.body as any)?.model ||
          (request.headers?.['x-budget-model-id'] as string) ||
          undefined;

        const expectedProjectId =
          (request.headers?.['x-project-id'] as string) ||
          (request.body as any)?.project_id ||
          'default_project';

        const expectedProviderId =
          (request.headers?.['x-budget-provider-id'] as string) ||
          (this.transportName !== 'http-llm-transport' ? this.transportName : undefined) ||
          (request.endpoint?.includes('openai') ? 'reference-llm' : undefined);

        const rawAccountId =
          (request.headers?.['x-budget-account-id'] as string) ||
          (request.body as any)?.metadata?.__aidm_account_id;

        const expectedAccountId =
          rawAccountId ||
          (expectedProjectId
            ? (this.budgetManager.getProjectAccount(expectedProjectId) ?? this.budgetManager.getGlobalAccount())?.accountId
            : this.budgetManager.getGlobalAccount()?.accountId);

        // Generate fresh, internal single-use capability token for this specific HTTP dispatch
        // (Caller-provided claim ID is intentionally ignored to prevent spoofing and re-use)
        const dispatchClaimId = `claim_${crypto.randomUUID()}`;

        this.budgetManager.claimReservationForDispatch({
          reservationId: String(reservationId),
          dispatchClaimId,
          expectedAccountId: expectedAccountId ? String(expectedAccountId) : (undefined as any),
          expectedProjectId: expectedProjectId ? String(expectedProjectId) : (undefined as any),
          expectedProviderId: expectedProviderId ? String(expectedProviderId) : (undefined as any),
          expectedModelId: expectedModelId ? String(expectedModelId) : (undefined as any),
        });
      }
    }

    // 1. Availability check
    const state = HTTP_TRANSPORT_STATE.get(this);
    if (state && !state.available) {
      throw new LlmTransportUnavailableError(
        this.transportName,
        `Transport "${this.transportName}" is unavailable: ${state.reason ?? 'Disabled'}`,
        state.reason ?? 'UNAVAILABLE'
      );
    }

    // 2. Resolve target URL
    const targetUrl = request.endpoint || this.endpoint;
    if (!targetUrl) {
      throw new LlmTransportUnavailableError(
        this.transportName,
        `No endpoint configured for HTTP transport "${this.transportName}"`,
        'MISSING_ENDPOINT'
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      throw new LlmTransportUnavailableError(
        this.transportName,
        `Invalid endpoint URL "${sanitizeSecrets(targetUrl)}" for transport "${this.transportName}"`,
        'INVALID_ENDPOINT_URL'
      );
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new LlmTransportUnavailableError(
        this.transportName,
        `Unsupported protocol "${parsedUrl.protocol}" for transport "${this.transportName}". Only http: and https: are supported.`,
        'UNSUPPORTED_PROTOCOL'
      );
    }

    // 3. Assemble request headers
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.defaultHeaders,
    };

    if (this.apiKey) {
      headers[this.authHeaderName] = `${this.authHeaderPrefix}${this.apiKey}`;
    }

    if (request.headers) {
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k.toLowerCase()] = v;
      }
    }

    // Correlation ID propagation
    if (!headers['x-correlation-id']) {
      const bodyObj = request.body as Record<string, unknown> | null;
      const correlationId = bodyObj?.correlation_id ?? bodyObj?.correlationId;
      if (typeof correlationId === 'string' && correlationId.trim().length > 0) {
        headers['x-correlation-id'] = correlationId;
        if (!headers['x-request-id']) {
          headers['x-request-id'] = correlationId;
        }
      }
    }

    // 4. Assemble request body
    const method = (request.method || 'POST').toUpperCase();
    let bodyContent: string | undefined = undefined;

    if (method !== 'GET' && method !== 'HEAD') {
      if (typeof request.body === 'string') {
        bodyContent = request.body;
      } else {
        try {
          bodyContent = JSON.stringify(request.body);
        } catch (serializeErr) {
          throw new InvalidLlmRequestError(
            `Failed to serialize HTTP transport body to JSON: ${
              serializeErr instanceof Error ? serializeErr.message : String(serializeErr)
            }`,
            { reason: 'JSON_SERIALIZE_ERROR' }
          );
        }
      }
    }

    // 5. Setup timeout & AbortSignal handling
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const abortController = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let didTimeout = false;

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        didTimeout = true;
        abortController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const onCallerAbort = () => {
      abortController.abort(request.signal?.reason ?? new Error('Request aborted by caller'));
    };

    if (request.signal) {
      if (request.signal.aborted) {
        if (timer) clearTimeout(timer);
        const abortErr = new Error('Transport request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    // 6. Execute network fetch
    let response: Response;
    try {
      response = await this.fetchFn(targetUrl, {
        method,
        headers,
        body: bodyContent,
        signal: abortController.signal,
      });
    } catch (fetchErr: unknown) {
      if (didTimeout) {
        throw new LlmTimeoutError(
          `Request to LLM endpoint "${sanitizeSecrets(targetUrl)}" timed out after ${timeoutMs}ms`,
          { timeoutMs, endpoint: sanitizeSecrets(targetUrl) }
        );
      }
      if (
        fetchErr instanceof Error &&
        (fetchErr.name === 'AbortError' || fetchErr.message.includes('aborted'))
      ) {
        const abortErr = new Error('Transport request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      const msg = fetchErr instanceof Error ? sanitizeSecrets(fetchErr.message) : 'Network error';
      throw new LlmTransportUnavailableError(
        this.transportName,
        `HTTP transport connection to "${sanitizeSecrets(targetUrl)}" failed: ${msg}`,
        'NETWORK_FAILURE'
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (request.signal) {
        request.signal.removeEventListener('abort', onCallerAbort);
      }
    }

    // 7. Parse response headers (with secret sanitization)
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = sanitizeSecrets(value);
    });

    // 8. Parse response body
    let rawText: string;
    try {
      rawText = await response.text();
    } catch (readErr) {
      throw new LlmTransportUnavailableError(
        this.transportName,
        `Failed to read HTTP response text from "${sanitizeSecrets(targetUrl)}": ${
          readErr instanceof Error ? sanitizeSecrets(readErr.message) : String(readErr)
        }`,
        'READ_ERROR'
      );
    }

    let parsedBody: unknown = null;
    let isJson = false;

    if (rawText.trim().length > 0) {
      try {
        parsedBody = JSON.parse(rawText);
        isJson = true;
      } catch {
        parsedBody = rawText;
        isJson = false;
      }
    }

    const sanitizedBody =
      typeof parsedBody === 'string'
        ? sanitizeSecrets(parsedBody)
        : sanitizeSecretsInObject(parsedBody);

    // 9. Error handling on HTTP status >= 400
    if (response.status >= 400 && this.throwHttpErrorOnStatusGte400) {
      const statusMessage = formatHttpStatusDescription(response.status, response.statusText);
      throw new LlmTransportHttpError(
        statusMessage,
        response.status,
        response.statusText,
        sanitizedBody,
        responseHeaders
      );
    }

    // 10. Malformed response check on 2xx
    if (!isJson && rawText.trim().length > 0) {
      throw new MalformedLlmResponseError(
        `Provider returned non-JSON response (HTTP ${response.status}): ${sanitizeSecrets(
          rawText.substring(0, 200)
        )}`,
        {
          rawResponse: sanitizeSecrets(rawText.substring(0, 500)),
          reason: 'EXPECTED_JSON_RESPONSE',
        }
      );
    }

    return Object.freeze({
      status: response.status,
      statusText: response.statusText,
      headers: Object.freeze(responseHeaders),
      body: sanitizedBody as TWireResponse,
    });
  }
}

/**
 * Authoritative Factory function for creating verified HttpLlmTransport instances.
 */
export function createHttpLlmTransport<TWirePayload = unknown, TWireResponse = unknown>(
  config: HttpLlmTransportConfig = {}
): HttpLlmTransport<TWirePayload, TWireResponse> {
  return new HttpLlmTransport<TWirePayload, TWireResponse>(config);
}
