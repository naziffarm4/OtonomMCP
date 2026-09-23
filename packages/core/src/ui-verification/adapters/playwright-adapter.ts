import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash } from 'node:crypto';
import {
  BrowserUnavailableError,
  UiVerificationError,
  BrowserNavigationError,
  DomObservationError,
  ScreenshotError,
  ConsoleObservationError,
  NetworkObservationError
} from '../../errors/index.js';
import type {
  BrowserPort,
  BrowserCapability,
  BrowserAvailability,
  BrowserSessionConfig,
  BrowserSession,
  BrowserNavigationRequest,
  BrowserDomObservationRequest,
  BrowserVisibleElementRequest,
  BrowserScreenshotRequest,
  BrowserConsoleObservationRequest,
  BrowserNetworkObservationRequest,
  BrowserNavigationObservation,
  BrowserDomObservation,
  BrowserVisibleElementObservation,
  BrowserScreenshotObservation,
  BrowserConsoleObservation,
  BrowserNetworkObservation
} from '../browser-port.js';
import { BROWSER_CAPABILITIES } from '../browser-port.js';

export interface ConsoleObservationEntry {
  readonly level: 'info' | 'warn' | 'error' | 'debug' | 'log';
  readonly text: string;
  readonly source: string;
  readonly timestamp: string;
}

export interface NetworkObservationEntry {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly resource_type: string;
  readonly duration_ms: number;
  readonly failed: boolean;
  readonly headers: Record<string, string>;
}

export interface PlaywrightAdapterConfig {
  readonly browserExecutablePath?: string;
  readonly headless?: boolean;
}

export class PlaywrightBrowserAdapter implements BrowserPort {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  
  private activeSession: BrowserSession | null = null;
  
  private consoleEntries: ConsoleObservationEntry[] = [];
  private networkEntries: NetworkObservationEntry[] = [];

  constructor(
    private readonly playwrightInstance: typeof import('playwright-core'),
    private readonly config: PlaywrightAdapterConfig = {}
  ) {}

  async checkAvailability(): Promise<BrowserAvailability> {
    try {
      // Just a quick check to see if we can instantiate it or if playwright object exists
      if (!this.playwrightInstance || !this.playwrightInstance.chromium) {
        return Object.freeze({
          available: false,
          provider: 'playwright',
          capabilities: [],
          reason: 'Playwright instance or chromium not provided'
        });
      }
      
      return Object.freeze({
        available: true,
        provider: 'playwright',
        version: 'unknown',
        capabilities: Object.freeze([...BROWSER_CAPABILITIES]),
        reason: null
      });
    } catch (err: unknown) {
      return Object.freeze({
        available: false,
        provider: 'playwright',
        capabilities: [],
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  hasCapability(capability: BrowserCapability): boolean {
    return BROWSER_CAPABILITIES.includes(capability);
  }

  private assertSessionActive(): void {
    if (!this.activeSession || !this.activeSession.is_active || !this.page) {
      throw new UiVerificationError('No active browser session', 'ERR_UI_VERIFICATION_GENERAL', { operation: 'assertSessionActive' });
    }
  }

  async startSession(config?: BrowserSessionConfig): Promise<BrowserSession> {
    if (this.activeSession && this.activeSession.is_active) {
      throw new UiVerificationError('A session is already active', 'ERR_UI_VERIFICATION_GENERAL', { operation: 'startSession' });
    }
    
    try {
      this.browser = await this.playwrightInstance.chromium.launch({
        executablePath: this.config.browserExecutablePath,
        headless: this.config.headless ?? true,
      });

      this.context = await this.browser.newContext({
        viewport: config?.viewport ?? { width: 1280, height: 720 },
        userAgent: config?.user_agent,
      });

      this.page = await this.context.newPage();
      
      this.consoleEntries = [];
      this.networkEntries = [];
      
      // Wire up observation listeners
      this.page.on('console', msg => {
        const text = msg.text();
        const type = msg.type();
        let level: 'info' | 'warn' | 'error' | 'debug' | 'log' = 'info';
        if (type === 'warning') level = 'warn';
        if (type === 'error') level = 'error';
        if (type === 'debug') level = 'debug';
        if (type === 'log') level = 'log';
        
        this.consoleEntries.push({
          level,
          text,
          source: msg.location().url || 'unknown',
          timestamp: new Date().toISOString()
        });
      });
      
      this.page.on('requestfinished', async req => {
        const url = this.sanitizeUrl(req.url());
        const timing = req.timing();
        const duration = timing.responseEnd - timing.requestStart;
        
        const response = await req.response();
        
        this.networkEntries.push({
          url,
          method: req.method(),
          status: response?.status() ?? 0,
          resource_type: req.resourceType(),
          duration_ms: duration > 0 ? duration : 0,
          failed: false,
          headers: this.sanitizeHeaders(req.headers())
        });
      });
      
      this.page.on('requestfailed', req => {
        const url = this.sanitizeUrl(req.url());
        this.networkEntries.push({
          url,
          method: req.method(),
          status: 0,
          resource_type: req.resourceType(),
          duration_ms: 0,
          failed: true,
          headers: this.sanitizeHeaders(req.headers())
        });
      });

      const session_id = `session:${Date.now()}`;
      this.activeSession = Object.freeze({
        session_id,
        is_active: true,
        opened_at: new Date().toISOString(),
        config: config ? Object.freeze({ ...config }) : undefined
      });
      
      return this.activeSession;
    } catch (err) {
      if (err instanceof UiVerificationError) throw err;
      throw new BrowserUnavailableError('Failed to start Playwright session: ' + (err instanceof Error ? err.message : String(err)), { capability: 'SESSION_LIFECYCLE' });
    }
  }

  async closeSession(session_id: string): Promise<void> {
    if (!this.activeSession) {
      throw new UiVerificationError('No active session to close or Session ID mismatch', 'ERR_UI_VERIFICATION_GENERAL', { operation: 'closeSession' });
    }
    if (this.activeSession.session_id !== session_id) {
      throw new UiVerificationError('No active session to close or Session ID mismatch', 'ERR_UI_VERIFICATION_GENERAL', { operation: 'closeSession' });
    }

    try {
      await this.context?.close();
      await this.browser?.close();
    } catch (err) {
      // ignore close errors mostly
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
      this.activeSession = null;
      this.consoleEntries = [];
      this.networkEntries = [];
    }
  }

  async navigate(request: BrowserNavigationRequest): Promise<BrowserNavigationObservation> {
    this.assertSessionActive();
    
    try {
      const start = Date.now();
      const response = await this.page!.goto(request.url, { timeout: request.timeout_ms ?? 30000 });
      const duration = Date.now() - start;
      
      const status_code = response?.status() ?? 0;
      const title = await this.page!.title();
      
      // Determine redirection (simple heuristic: if response url is not request url)
      const redirected = response ? response.url() !== request.url : false;
      
      return Object.freeze({
        observation_id: `obs:${request.task_id}:nav:${request.correlation_id}`,
        task_id: request.task_id,
        correlation_id: request.correlation_id,
        observation_type: 'NAVIGATION',
        url: this.sanitizeUrl(response?.url() ?? request.url),
        status_code,
        title,
        redirected,
        navigation_time_ms: duration,
        captured_at: new Date().toISOString(),
        metadata: null
      });
    } catch (err) {
      throw new BrowserNavigationError('Navigation failed: ' + (err instanceof Error ? err.message : String(err)), { url: this.sanitizeUrl(request.url) });
    }
  }

  async observeDom(request: BrowserDomObservationRequest): Promise<BrowserDomObservation> {
    this.assertSessionActive();
    
    try {
      const selector = request.selector ?? 'html';
      const elementsLocators = await this.page!.locator(selector).all();
      
      const elements = [];
      for (const loc of elementsLocators) {
        const is_visible = await loc.isVisible();
        const inner_text = await loc.innerText();
        const tag_name = await loc.evaluate(e => e.tagName.toLowerCase());
        const id = await loc.getAttribute('id');
        const classAttr = await loc.getAttribute('class');
        
        const attributes: Record<string, string> = await loc.evaluate(e => {
          const attrs: Record<string, string> = {};
          for (let i = 0; i < e.attributes.length; i++) {
            attrs[e.attributes[i].name] = e.attributes[i].value;
          }
          return attrs;
        });
        
        elements.push(Object.freeze({
          tag_name,
          selector,
          attributes: Object.freeze(attributes),
          inner_text: inner_text.substring(0, 1000), // Bound size
          is_visible,
          id: id ?? null,
          classes: classAttr ? Object.freeze(classAttr.split(' ').filter(Boolean)) : Object.freeze([])
        }));
      }
      
      let html_snippet = null;
      if (elementsLocators.length > 0) {
        const outerHTML = await elementsLocators[0].evaluate(e => e.outerHTML);
        html_snippet = outerHTML.substring(0, 2000); // Bound size
      }
      
      return Object.freeze({
        observation_id: `obs:${request.task_id}:dom:${request.correlation_id}`,
        task_id: request.task_id,
        correlation_id: request.correlation_id,
        observation_type: 'DOM',
        url: this.sanitizeUrl(this.page!.url()),
        selector,
        matches_count: elements.length,
        elements: Object.freeze(elements),
        html_snapshot_snippet: html_snippet,
        captured_at: new Date().toISOString(),
        metadata: null
      });
    } catch (err) {
      throw new DomObservationError('DOM observation failed: ' + (err instanceof Error ? err.message : String(err)), { selector: request.selector ?? 'html' });
    }
  }

  async observeVisibleElement(request: BrowserVisibleElementRequest): Promise<BrowserVisibleElementObservation> {
    this.assertSessionActive();
    
    try {
      const loc = this.page!.locator(request.selector).first();
      // We do not want to throw if it doesn't exist, we want to return a typed observation
      const count = await loc.count();
      if (count === 0) {
        return Object.freeze({
          observation_id: `obs:${request.task_id}:visible:${request.correlation_id}`,
          task_id: request.task_id,
          correlation_id: request.correlation_id,
          observation_type: 'VISIBLE_ELEMENT',
          url: this.sanitizeUrl(this.page!.url()),
          selector: request.selector,
          is_visible: false,
          visible_text: '',
          bounding_box: null,
          computed_styles: Object.freeze({}),
          captured_at: new Date().toISOString(),
          metadata: null
        });
      }
      
      const is_visible = await loc.isVisible();
      const visible_text = is_visible ? await loc.innerText() : '';
      const box = await loc.boundingBox();
      
      const computed_styles = await loc.evaluate(e => {
        const styles = window.getComputedStyle(e);
        return {
          display: styles.display,
          visibility: styles.visibility,
          opacity: styles.opacity
        };
      });
      
      return Object.freeze({
        observation_id: `obs:${request.task_id}:visible:${request.correlation_id}`,
        task_id: request.task_id,
        correlation_id: request.correlation_id,
        observation_type: 'VISIBLE_ELEMENT',
        url: this.sanitizeUrl(this.page!.url()),
        selector: request.selector,
        is_visible,
        visible_text: visible_text.substring(0, 1000), // Bound size
        bounding_box: box ? Object.freeze({ x: box.x, y: box.y, width: box.width, height: box.height }) : null,
        computed_styles: Object.freeze(computed_styles),
        captured_at: new Date().toISOString(),
        metadata: null
      });
    } catch (err) {
      throw new DomObservationError('Visible element observation failed: ' + (err instanceof Error ? err.message : String(err)), { selector: request.selector });
    }
  }

  async captureScreenshot(request: BrowserScreenshotRequest): Promise<BrowserScreenshotObservation> {
    this.assertSessionActive();
    
    try {
      const format = request.format ?? 'png';
      let buffer: Buffer;
      if (request.selector) {
        const loc = this.page!.locator(request.selector).first();
        buffer = await loc.screenshot({ type: format });
      } else {
        buffer = await this.page!.screenshot({ type: format, fullPage: request.full_page });
      }
      
      const sha256_hash = createHash('sha256').update(buffer).digest('hex');
      const viewport = this.page!.viewportSize() ?? { width: 0, height: 0 };
      
      return Object.freeze({
        observation_id: `obs:${request.task_id}:screenshot:${request.correlation_id}`,
        task_id: request.task_id,
        correlation_id: request.correlation_id,
        observation_type: 'SCREENSHOT',
        url: this.sanitizeUrl(this.page!.url()),
        format,
        mime_type: `image/${format}`,
        byte_length: buffer.length,
        sha256_hash,
        storage_path: null, // Keep null in memory
        base64_data: buffer.toString('base64'), // Store inline
        viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
        captured_at: new Date().toISOString(),
        metadata: null
      });
    } catch (err) {
      throw new ScreenshotError('Screenshot failed: ' + (err instanceof Error ? err.message : String(err)), { capability: 'SCREENSHOT' });
    }
  }

  async observeConsole(request: BrowserConsoleObservationRequest): Promise<BrowserConsoleObservation> {
    this.assertSessionActive();
    
    try {
      const has_errors = this.consoleEntries.some(e => e.level === 'error');
      
      return Object.freeze({
        observation_id: `obs:${request.task_id}:console:${request.correlation_id}`,
        task_id: request.task_id,
        correlation_id: request.correlation_id,
        observation_type: 'CONSOLE',
        url: this.sanitizeUrl(this.page!.url()),
        entries: Object.freeze([...this.consoleEntries]),
        has_errors,
        captured_at: new Date().toISOString(),
        metadata: null
      });
    } catch (err) {
      throw new UiVerificationError('Console observation failed', 'ERR_UI_VERIFICATION_GENERAL', { capability: 'CONSOLE_OBSERVATION' });
    }
  }

  async observeNetwork(request: BrowserNetworkObservationRequest): Promise<BrowserNetworkObservation> {
    this.assertSessionActive();
    
    try {
      const has_failures = this.networkEntries.some(e => e.failed);
      
      return Object.freeze({
        observation_id: `obs:${request.task_id}:network:${request.correlation_id}`,
        task_id: request.task_id,
        correlation_id: request.correlation_id,
        observation_type: 'NETWORK',
        url: this.sanitizeUrl(this.page!.url()),
        entries: Object.freeze([...this.networkEntries]),
        has_failures,
        captured_at: new Date().toISOString(),
        metadata: null
      });
    } catch (err) {
      throw new UiVerificationError('Network observation failed', 'ERR_UI_VERIFICATION_GENERAL', { capability: 'NETWORK_OBSERVATION' });
    }
  }
  
  private sanitizeUrl(urlStr: string): string {
    try {
      const u = new URL(urlStr);
      // Remove sensitive credentials
      u.username = '';
      u.password = '';
      
      // Basic query param sanitization
      const sensitiveKeys = ['token', 'key', 'auth', 'password', 'secret', 'signature'];
      const keys = Array.from(u.searchParams.keys());
      for (const key of keys) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some(k => lowerKey.includes(k))) {
          u.searchParams.set(key, '[REDACTED]');
        }
      }
      return u.toString();
    } catch {
      return urlStr;
    }
  }
  
  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitive = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];
    for (const [k, v] of Object.entries(headers)) {
      if (sensitive.includes(k.toLowerCase())) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }
}
