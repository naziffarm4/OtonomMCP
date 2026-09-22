/**
 * @file llm-transport.ts
 * @description Injectable transport boundary for LLM Provider Adapters (TASK-P3-03).
 * 
 * Invariants:
 * 1. Isolates provider adapters from network/HTTP transport mechanisms.
 * 2. Prevents hidden network calls: transport must be explicitly injected.
 * 3. Supports deterministic testing and hermetic test environments.
 * 4. Distinguishes: successful response, provider HTTP failure, timeout/abort,
 *    malformed payload, and transport unavailability.
 * 5. Strictly protects against credential and secret leakage.
 */

// ============================================================================
// 1. TRANSPORT REQUEST & RESPONSE CONTRACTS
// ============================================================================

export interface LlmTransportRequest<TWirePayload = unknown> {
  /** Optional target endpoint URI */
  readonly endpoint?: string;
  /** HTTP method or transport verb (defaults to 'POST') */
  readonly method?: string;
  /** Transport headers (e.g. Content-Type, correlation headers) */
  readonly headers?: Readonly<Record<string, string>>;
  /** Provider-specific wire payload */
  readonly body: TWirePayload;
  /** Timeout in milliseconds */
  readonly timeoutMs?: number;
  /** Abort signal for cancellation and timeout enforcement */
  readonly signal?: AbortSignal;
}

export interface LlmTransportResponse<TWireResponse = unknown> {
  /** HTTP status code or transport result code */
  readonly status: number;
  /** HTTP status text or transport result description */
  readonly statusText?: string;
  /** Response headers */
  readonly headers?: Readonly<Record<string, string>>;
  /** Raw wire response body */
  readonly body: TWireResponse;
}

// ============================================================================
// 2. TRANSPORT ERRORS
// ============================================================================

export class LlmTransportHttpError extends Error {
  readonly status: number;
  readonly statusText?: string;
  readonly responseBody?: unknown;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    message: string,
    status: number,
    statusText?: string,
    responseBody?: unknown,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'LlmTransportHttpError';
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.headers = headers ? Object.freeze({ ...headers }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LlmTransportUnavailableError extends Error {
  readonly transportName: string;
  readonly reason?: string;

  constructor(transportName: string, message: string, reason?: string) {
    super(message);
    this.name = 'LlmTransportUnavailableError';
    this.transportName = transportName;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// 3. LLM TRANSPORT INTERFACE
// ============================================================================

export interface LlmTransport<TWirePayload = unknown, TWireResponse = unknown> {
  /** Unique name or identifier of the transport implementation */
  readonly transportName: string;

  /**
   * Checks whether the transport is available and ready for dispatch.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Dispatches the wire request through the transport.
   * Throws LlmTransportUnavailableError, LlmTransportHttpError, or abort errors on failure.
   */
  send(
    request: LlmTransportRequest<TWirePayload>
  ): Promise<LlmTransportResponse<TWireResponse>>;
}

// ============================================================================
// 4. DETERMINISTIC MOCK / IN-MEMORY TRANSPORT FIXTURE
// ============================================================================

export interface DeterministicMockTransportConfig<
  TWirePayload = unknown,
  TWireResponse = unknown
> {
  readonly transportName?: string;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly responseDelayMs?: number;
  readonly responseStatus?: number;
  readonly responseStatusText?: string;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: TWireResponse;
  readonly throwHttpErrorOnStatusGte400?: boolean;
  readonly handler?: (
    request: LlmTransportRequest<TWirePayload>
  ) =>
    | Promise<LlmTransportResponse<TWireResponse>>
    | LlmTransportResponse<TWireResponse>;
}

export class DeterministicMockTransport<
  TWirePayload = unknown,
  TWireResponse = unknown
> implements LlmTransport<TWirePayload, TWireResponse> {
  readonly transportName: string;
  private available: boolean;
  private _unavailableReason?: string;
  private responseDelayMs: number;
  private responseStatus: number;
  private responseStatusText: string;
  private responseHeaders: Record<string, string>;
  private responseBody?: TWireResponse;
  private throwHttpErrorOnStatusGte400: boolean;
  private handler?: (
    request: LlmTransportRequest<TWirePayload>
  ) =>
    | Promise<LlmTransportResponse<TWireResponse>>
    | LlmTransportResponse<TWireResponse>;

  private readonly _recordedRequests: LlmTransportRequest<TWirePayload>[] = [];

  constructor(
    config: DeterministicMockTransportConfig<TWirePayload, TWireResponse> = {}
  ) {
    this.transportName = config.transportName ?? 'mock-deterministic-transport';
    this.available = config.available ?? true;
    this._unavailableReason = config.unavailableReason;
    this.responseDelayMs = config.responseDelayMs ?? 0;
    this.responseStatus = config.responseStatus ?? 200;
    this.responseStatusText = config.responseStatusText ?? 'OK';
    this.responseHeaders = { ...(config.responseHeaders ?? { 'content-type': 'application/json' }) };
    this.responseBody = config.responseBody;
    this.throwHttpErrorOnStatusGte400 = config.throwHttpErrorOnStatusGte400 ?? true;
    this.handler = config.handler;
  }

  get unavailableReason(): string | undefined {
    return this._unavailableReason;
  }

  get recordedRequests(): readonly LlmTransportRequest<TWirePayload>[] {
    return Object.freeze([...this._recordedRequests]);
  }

  clearRecordedRequests(): void {
    this._recordedRequests.length = 0;
  }

  setAvailable(available: boolean, reason?: string): void {
    this.available = available;
    this._unavailableReason = reason;
  }

  setResponseBody(body: TWireResponse): void {
    this.responseBody = body;
  }

  setResponseStatus(status: number, statusText: string = 'ERROR'): void {
    this.responseStatus = status;
    this.responseStatusText = statusText;
  }

  setResponseDelayMs(delayMs: number): void {
    this.responseDelayMs = delayMs;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async send(
    request: LlmTransportRequest<TWirePayload>
  ): Promise<LlmTransportResponse<TWireResponse>> {
    // 1. Record request for deterministic verification
    this._recordedRequests.push(Object.freeze({ ...request }));

    // 2. Check transport availability
    if (!this.available) {
      throw new LlmTransportUnavailableError(
        this.transportName,
        `Transport "${this.transportName}" is unavailable${
          this.unavailableReason ? `: ${this.unavailableReason}` : ''
        }`,
        this.unavailableReason
      );
    }

    // 3. Handle delay / timeout simulation with AbortSignal support
    if (this.responseDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;

        const onAbort = () => {
          if (timer) clearTimeout(timer);
          const error = new Error('Transport request aborted');
          error.name = 'AbortError';
          reject(error);
        };

        if (request.signal?.aborted) {
          return onAbort();
        }

        request.signal?.addEventListener('abort', onAbort, { once: true });

        timer = setTimeout(() => {
          if (request.signal) {
            request.signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, this.responseDelayMs);
      });
    }

    // 4. Custom handler if provided
    if (this.handler) {
      return await this.handler(request);
    }

    // 5. Handle HTTP error status if configured
    if (this.responseStatus >= 400 && this.throwHttpErrorOnStatusGte400) {
      throw new LlmTransportHttpError(
        `HTTP ${this.responseStatus}: ${this.responseStatusText}`,
        this.responseStatus,
        this.responseStatusText,
        this.responseBody,
        this.responseHeaders
      );
    }

    return Object.freeze({
      status: this.responseStatus,
      statusText: this.responseStatusText,
      headers: Object.freeze({ ...this.responseHeaders }),
      body: this.responseBody as TWireResponse,
    });
  }
}
