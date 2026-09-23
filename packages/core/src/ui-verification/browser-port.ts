/**
 * Provider-Neutral Browser Port & Observation Contracts
 *
 * Defines the abstract interface boundary for browser automation providers.
 * Completely decoupled from Playwright, Puppeteer, Selenium, or specific browsers.
 * Supports dependency injection and deterministic in-memory simulation.
 */

import {
  BrowserUnavailableError,
  UnsupportedBrowserCapabilityError,
} from '../errors/ui-verification-error.js';

// ============================================================================
// 1. BROWSER CAPABILITIES
// ============================================================================

export const BrowserCapability = {
  NAVIGATION: 'NAVIGATION',
  DOM_OBSERVATION: 'DOM_OBSERVATION',
  VISIBLE_ELEMENT_OBSERVATION: 'VISIBLE_ELEMENT_OBSERVATION',
  SCREENSHOT: 'SCREENSHOT',
  CONSOLE_OBSERVATION: 'CONSOLE_OBSERVATION',
  NETWORK_OBSERVATION: 'NETWORK_OBSERVATION',
  HEADLESS: 'HEADLESS',
  SESSION_LIFECYCLE: 'SESSION_LIFECYCLE',
} as const;

export type BrowserCapability = (typeof BrowserCapability)[keyof typeof BrowserCapability];
export const BROWSER_CAPABILITIES = Object.values(BrowserCapability) as readonly BrowserCapability[];

export function isBrowserCapability(value: unknown): value is BrowserCapability {
  return typeof value === 'string' && (BROWSER_CAPABILITIES as readonly string[]).includes(value);
}

// ============================================================================
// 2. AVAILABILITY & SESSION CONTRACTS
// ============================================================================

export interface BrowserAvailability {
  readonly available: boolean;
  readonly provider: string;
  readonly version?: string | null;
  readonly capabilities: readonly BrowserCapability[];
  readonly reason?: string | null;
}

export interface BrowserSessionConfig {
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly user_agent?: string;
  readonly timeout_ms?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface BrowserSession {
  readonly session_id: string;
  readonly is_active: boolean;
  readonly opened_at: string | null;
  readonly config?: BrowserSessionConfig;
}

// ============================================================================
// 3. OPERATION REQUEST TYPES
// ============================================================================

export interface BrowserNavigationRequest {
  readonly task_id: string;
  readonly correlation_id: string;
  readonly url: string;
  readonly timeout_ms?: number;
  readonly session_id?: string;
}

export interface BrowserDomObservationRequest {
  readonly task_id: string;
  readonly correlation_id: string;
  readonly url?: string;
  readonly selector?: string;
  readonly session_id?: string;
}

export interface BrowserVisibleElementRequest {
  readonly task_id: string;
  readonly correlation_id: string;
  readonly selector: string;
  readonly url?: string;
  readonly session_id?: string;
}

export interface BrowserScreenshotRequest {
  readonly task_id: string;
  readonly correlation_id: string;
  readonly url?: string;
  readonly selector?: string;
  readonly full_page?: boolean;
  readonly format?: 'png' | 'jpeg' | 'webp';
  readonly session_id?: string;
}

export interface BrowserConsoleObservationRequest {
  readonly task_id: string;
  readonly correlation_id: string;
  readonly url?: string;
  readonly session_id?: string;
}

export interface BrowserNetworkObservationRequest {
  readonly task_id: string;
  readonly correlation_id: string;
  readonly url?: string;
  readonly session_id?: string;
}

// ============================================================================
// 4. OBSERVATION DATA MODELS
// ============================================================================

export interface BrowserNavigationObservation {
  readonly observation_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly observation_type: 'NAVIGATION';
  readonly url: string;
  readonly status_code?: number | null;
  readonly title?: string | null;
  readonly redirected: boolean;
  readonly navigation_time_ms?: number | null;
  readonly captured_at?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface BrowserDomElementSnapshot {
  readonly tag_name: string;
  readonly selector?: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly inner_text?: string | null;
  readonly is_visible?: boolean;
  readonly id?: string | null;
  readonly classes?: readonly string[];
}

export interface BrowserDomObservation {
  readonly observation_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly observation_type: 'DOM';
  readonly url: string;
  readonly selector?: string | null;
  readonly matches_count: number;
  readonly elements?: readonly BrowserDomElementSnapshot[];
  readonly html_snapshot_snippet?: string | null;
  readonly captured_at?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface BrowserVisibleElementObservation {
  readonly observation_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly observation_type: 'VISIBLE_ELEMENT';
  readonly url: string;
  readonly selector: string;
  readonly is_visible: boolean;
  readonly visible_text?: string | null;
  readonly bounding_box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly computed_styles?: Readonly<Record<string, string>> | null;
  readonly captured_at?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface BrowserScreenshotObservation {
  readonly observation_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly observation_type: 'SCREENSHOT';
  readonly url: string;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly mime_type: string;
  readonly byte_length: number;
  readonly sha256_hash: string;
  readonly storage_path?: string | null;
  readonly base64_data?: string | null;
  readonly viewport?: { readonly width: number; readonly height: number } | null;
  readonly captured_at?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface BrowserConsoleEntry {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly text: string;
  readonly source?: string | null;
  readonly timestamp?: string | null;
}

export interface BrowserConsoleObservation {
  readonly observation_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly observation_type: 'CONSOLE';
  readonly url: string;
  readonly entries: readonly BrowserConsoleEntry[];
  readonly has_errors: boolean;
  readonly captured_at?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface BrowserNetworkEntry {
  readonly url: string;
  readonly method: string;
  readonly status?: number | null;
  readonly status_text?: string | null;
  readonly resource_type?: string | null;
  readonly duration_ms?: number | null;
  readonly failed: boolean;
  readonly failure_reason?: string | null;
  readonly request_headers?: Readonly<Record<string, string>> | null;
  readonly response_headers?: Readonly<Record<string, string>> | null;
}

export interface BrowserNetworkObservation {
  readonly observation_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly observation_type: 'NETWORK';
  readonly url: string;
  readonly entries: readonly BrowserNetworkEntry[];
  readonly has_failures: boolean;
  readonly captured_at?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export type BrowserObservation =
  | BrowserNavigationObservation
  | BrowserDomObservation
  | BrowserVisibleElementObservation
  | BrowserScreenshotObservation
  | BrowserConsoleObservation
  | BrowserNetworkObservation;

// ============================================================================
// 5. BROWSER PORT INTERFACE
// ============================================================================

export interface BrowserPort {
  /** Check availability and capabilities of the browser provider */
  checkAvailability(): Promise<BrowserAvailability>;

  /** Query whether a specific capability is supported */
  hasCapability(capability: BrowserCapability): Promise<boolean> | boolean;

  /** Session lifecycle management */
  startSession(config?: BrowserSessionConfig): Promise<BrowserSession>;
  closeSession(session_id: string): Promise<void>;

  /** Observation operations */
  navigate(request: BrowserNavigationRequest): Promise<BrowserNavigationObservation>;
  observeDom(request: BrowserDomObservationRequest): Promise<BrowserDomObservation>;
  observeVisibleElement(request: BrowserVisibleElementRequest): Promise<BrowserVisibleElementObservation>;
  captureScreenshot(request: BrowserScreenshotRequest): Promise<BrowserScreenshotObservation>;
  observeConsole(request: BrowserConsoleObservationRequest): Promise<BrowserConsoleObservation>;
  observeNetwork(request: BrowserNetworkObservationRequest): Promise<BrowserNetworkObservation>;
}

// ============================================================================
// 6. FAKE BROWSER PORT (FOR UNIT & INTEGRATION TESTING)
// ============================================================================

export interface FakeBrowserPortOptions {
  readonly available?: boolean;
  readonly provider?: string;
  readonly version?: string;
  readonly capabilities?: readonly BrowserCapability[];
  readonly reason?: string;
}

export class FakeBrowserPort implements BrowserPort {
  private isAvailable: boolean;
  private providerName: string;
  private providerVersion: string;
  private supportedCapabilities: Set<BrowserCapability>;
  private unavailabilityReason?: string;
  private activeSessions: Map<string, BrowserSession> = new Map();

  // Custom handlers for deterministic test mocking
  public navigateHandler?: (req: BrowserNavigationRequest) => Promise<BrowserNavigationObservation>;
  public domHandler?: (req: BrowserDomObservationRequest) => Promise<BrowserDomObservation>;
  public visibleElementHandler?: (req: BrowserVisibleElementRequest) => Promise<BrowserVisibleElementObservation>;
  public screenshotHandler?: (req: BrowserScreenshotRequest) => Promise<BrowserScreenshotObservation>;
  public consoleHandler?: (req: BrowserConsoleObservationRequest) => Promise<BrowserConsoleObservation>;
  public networkHandler?: (req: BrowserNetworkObservationRequest) => Promise<BrowserNetworkObservation>;

  constructor(options: FakeBrowserPortOptions = {}) {
    this.isAvailable = options.available ?? true;
    this.providerName = options.provider ?? 'fake-browser-port';
    this.providerVersion = options.version ?? '1.0.0';
    this.unavailabilityReason = options.reason;
    this.supportedCapabilities = new Set(
      options.capabilities ?? BROWSER_CAPABILITIES
    );
  }

  setAvailable(available: boolean, reason?: string): void {
    this.isAvailable = available;
    this.unavailabilityReason = reason;
  }

  setCapability(capability: BrowserCapability, supported: boolean): void {
    if (supported) {
      this.supportedCapabilities.add(capability);
    } else {
      this.supportedCapabilities.delete(capability);
    }
  }

  private assertAvailable(): void {
    if (!this.isAvailable) {
      throw new BrowserUnavailableError(
        this.unavailabilityReason ?? 'FakeBrowserPort is marked unavailable.',
        { capability: 'GENERAL' }
      );
    }
  }

  private assertCapability(cap: BrowserCapability): void {
    this.assertAvailable();
    if (!this.supportedCapabilities.has(cap)) {
      throw new UnsupportedBrowserCapabilityError(
        `Capability '${cap}' is not supported by ${this.providerName}.`,
        { capability: cap }
      );
    }
  }

  async checkAvailability(): Promise<BrowserAvailability> {
    return Object.freeze({
      available: this.isAvailable,
      provider: this.providerName,
      version: this.providerVersion,
      capabilities: Object.freeze(Array.from(this.supportedCapabilities)),
      reason: this.isAvailable ? null : (this.unavailabilityReason ?? 'Unavailable'),
    });
  }

  hasCapability(capability: BrowserCapability): boolean {
    return this.supportedCapabilities.has(capability);
  }

  async startSession(config?: BrowserSessionConfig): Promise<BrowserSession> {
    this.assertCapability(BrowserCapability.SESSION_LIFECYCLE);
    const sessionId = `session:fake:${this.activeSessions.size + 1}`;
    const session: BrowserSession = Object.freeze({
      session_id: sessionId,
      is_active: true,
      opened_at: '2026-09-23T00:00:00.000Z',
      config: config ? Object.freeze({ ...config }) : undefined,
    });
    this.activeSessions.set(sessionId, session);
    return session;
  }

  async closeSession(session_id: string): Promise<void> {
    this.assertCapability(BrowserCapability.SESSION_LIFECYCLE);
    this.activeSessions.delete(session_id);
  }

  async navigate(request: BrowserNavigationRequest): Promise<BrowserNavigationObservation> {
    this.assertCapability(BrowserCapability.NAVIGATION);
    if (this.navigateHandler) {
      return await this.navigateHandler(request);
    }
    return Object.freeze({
      observation_id: `obs:${request.task_id}:nav:${request.correlation_id}`,
      task_id: request.task_id,
      correlation_id: request.correlation_id,
      observation_type: 'NAVIGATION',
      url: request.url,
      status_code: 200,
      title: 'Mock Page',
      redirected: false,
      navigation_time_ms: 120,
      captured_at: '2026-09-23T00:00:00.000Z',
      metadata: null,
    });
  }

  async observeDom(request: BrowserDomObservationRequest): Promise<BrowserDomObservation> {
    this.assertCapability(BrowserCapability.DOM_OBSERVATION);
    if (this.domHandler) {
      return await this.domHandler(request);
    }
    return Object.freeze({
      observation_id: `obs:${request.task_id}:dom:${request.correlation_id}`,
      task_id: request.task_id,
      correlation_id: request.correlation_id,
      observation_type: 'DOM',
      url: request.url ?? 'http://localhost/app',
      selector: request.selector ?? 'body',
      matches_count: 1,
      elements: Object.freeze([
        Object.freeze({
          tag_name: 'body',
          selector: request.selector ?? 'body',
          attributes: Object.freeze({ class: 'ready' }),
          inner_text: 'Hello World',
          is_visible: true,
          id: null,
          classes: Object.freeze(['ready']),
        }),
      ]),
      html_snapshot_snippet: '<body class="ready">Hello World</body>',
      captured_at: '2026-09-23T00:00:00.000Z',
      metadata: null,
    });
  }

  async observeVisibleElement(
    request: BrowserVisibleElementRequest
  ): Promise<BrowserVisibleElementObservation> {
    this.assertCapability(BrowserCapability.VISIBLE_ELEMENT_OBSERVATION);
    if (this.visibleElementHandler) {
      return await this.visibleElementHandler(request);
    }
    return Object.freeze({
      observation_id: `obs:${request.task_id}:visible:${request.correlation_id}`,
      task_id: request.task_id,
      correlation_id: request.correlation_id,
      observation_type: 'VISIBLE_ELEMENT',
      url: request.url ?? 'http://localhost/app',
      selector: request.selector,
      is_visible: true,
      visible_text: 'Submit',
      bounding_box: Object.freeze({ x: 10, y: 20, width: 100, height: 40 }),
      computed_styles: Object.freeze({ display: 'block', visibility: 'visible' }),
      captured_at: '2026-09-23T00:00:00.000Z',
      metadata: null,
    });
  }

  async captureScreenshot(
    request: BrowserScreenshotRequest
  ): Promise<BrowserScreenshotObservation> {
    this.assertCapability(BrowserCapability.SCREENSHOT);
    if (this.screenshotHandler) {
      return await this.screenshotHandler(request);
    }
    return Object.freeze({
      observation_id: `obs:${request.task_id}:screenshot:${request.correlation_id}`,
      task_id: request.task_id,
      correlation_id: request.correlation_id,
      observation_type: 'SCREENSHOT',
      url: request.url ?? 'http://localhost/app',
      format: request.format ?? 'png',
      mime_type: `image/${request.format ?? 'png'}`,
      byte_length: 1024,
      sha256_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      storage_path: 'screenshots/mock-page.png',
      base64_data: null,
      viewport: Object.freeze({ width: 1280, height: 720 }),
      captured_at: '2026-09-23T00:00:00.000Z',
      metadata: null,
    });
  }

  async observeConsole(
    request: BrowserConsoleObservationRequest
  ): Promise<BrowserConsoleObservation> {
    this.assertCapability(BrowserCapability.CONSOLE_OBSERVATION);
    if (this.consoleHandler) {
      return await this.consoleHandler(request);
    }
    return Object.freeze({
      observation_id: `obs:${request.task_id}:console:${request.correlation_id}`,
      task_id: request.task_id,
      correlation_id: request.correlation_id,
      observation_type: 'CONSOLE',
      url: request.url ?? 'http://localhost/app',
      entries: Object.freeze([]),
      has_errors: false,
      captured_at: '2026-09-23T00:00:00.000Z',
      metadata: null,
    });
  }

  async observeNetwork(
    request: BrowserNetworkObservationRequest
  ): Promise<BrowserNetworkObservation> {
    this.assertCapability(BrowserCapability.NETWORK_OBSERVATION);
    if (this.networkHandler) {
      return await this.networkHandler(request);
    }
    return Object.freeze({
      observation_id: `obs:${request.task_id}:network:${request.correlation_id}`,
      task_id: request.task_id,
      correlation_id: request.correlation_id,
      observation_type: 'NETWORK',
      url: request.url ?? 'http://localhost/app',
      entries: Object.freeze([]),
      has_failures: false,
      captured_at: '2026-09-23T00:00:00.000Z',
      metadata: null,
    });
  }
}
