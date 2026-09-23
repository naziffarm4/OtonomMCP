/**
 * Phase 5 UI System-Verified Evidence Contracts & Normalization
 *
 * Establishes the authoritative bridge between Browser Observations and
 * SYSTEM_VERIFIED_EVIDENCE.
 * Strictly enforces that AGENT_CLAIM cannot be promoted into UI system evidence.
 * Provides deterministic normalization and sensitive data sanitization.
 */

import {
  EvidenceType,
  EvidenceSource,
  EvidenceValidationStatus,
  type SystemVerifiedEvidence,
  type ExecutorIdentity,
  type EvidenceValidationResult,
  type EvidenceValidationIssue,
} from '../evidence/evidence-types.js';
import {
  validateSystemVerifiedEvidence,
  assertValidSystemVerifiedEvidence,
} from '../evidence/evidence-validator.js';
import {
  InvalidEvidenceSourceError,
  sanitizeEvidenceSecrets,
  sanitizeEvidenceDetails,
} from '../errors/evidence-error.js';
import {
  InvalidBrowserObservationError,
  InvalidUiEvidenceError,
} from '../errors/ui-verification-error.js';
import {
  UiObservationType,
  isUiObservationType,
} from './ui-verification-types.js';
import {
  type BrowserObservation,
  type BrowserNavigationObservation,
  type BrowserDomObservation,
  type BrowserVisibleElementObservation,
  type BrowserScreenshotObservation,
  type BrowserConsoleObservation,
  type BrowserNetworkObservation,
  type BrowserConsoleEntry,
  type BrowserNetworkEntry,
  type BrowserDomElementSnapshot,
} from './browser-port.js';

// ============================================================================
// 1. SENSITIVITY SANITIZATION UTILITIES
// ============================================================================

const SENSITIVE_QUERY_PARAM_REGEX = /([?&])(token|key|apikey|secret|password|passwd|auth|access_token)=([^&'"]+)/gi;

/**
 * Sanitizes URLs to ensure query tokens or secrets are not leaked.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string') return rawUrl;
  return rawUrl.replace(SENSITIVE_QUERY_PARAM_REGEX, '$1$2=***REDACTED***');
}

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'apikey',
  'token',
  'secret',
]);

/**
 * Sanitizes HTTP request and response headers deterministically.
 * Orders header keys alphabetically.
 */
export function sanitizeHeaders(
  headers?: Readonly<Record<string, string>> | null
): Readonly<Record<string, string>> | null {
  if (!headers || typeof headers !== 'object') return null;

  const sanitized: Record<string, string> = {};
  const sortedKeys = Object.keys(headers).sort();

  for (const key of sortedKeys) {
    const lowerKey = key.toLowerCase();
    const val = String(headers[key]);

    if (
      SENSITIVE_HEADER_KEYS.has(lowerKey) ||
      lowerKey.includes('auth') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('cookie') ||
      lowerKey.includes('key')
    ) {
      if (lowerKey === 'authorization' && /^Bearer\s+/i.test(val)) {
        sanitized[key] = 'Bearer ***REDACTED_TOKEN***';
      } else {
        sanitized[key] = '***REDACTED***';
      }
    } else {
      sanitized[key] = sanitizeEvidenceSecrets(val);
    }
  }

  return Object.freeze(sanitized);
}

/**
 * Sanitizes and deterministically orders console entries.
 */
export function sanitizeConsoleEntries(
  entries: readonly BrowserConsoleEntry[]
): readonly BrowserConsoleEntry[] {
  if (!Array.isArray(entries)) return Object.freeze([]);

  const sanitized = entries.map((entry, idx) =>
    Object.freeze({
      level: entry.level,
      text: sanitizeEvidenceSecrets(String(entry.text ?? '')),
      source: entry.source ? sanitizeEvidenceSecrets(String(entry.source)) : null,
      timestamp: entry.timestamp ? String(entry.timestamp) : null,
      _idx: idx,
    })
  );

  // Deterministic sort: by timestamp (if present), then level, then text, then original index
  sanitized.sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
      return a.timestamp.localeCompare(b.timestamp);
    }
    if (a.level !== b.level) {
      return a.level.localeCompare(b.level);
    }
    if (a.text !== b.text) {
      return a.text.localeCompare(b.text);
    }
    return a._idx - b._idx;
  });

  return Object.freeze(
    sanitized.map(({ _idx, ...rest }) => Object.freeze(rest))
  );
}

/**
 * Sanitizes and deterministically orders network entries.
 */
export function sanitizeNetworkEntries(
  entries: readonly BrowserNetworkEntry[]
): readonly BrowserNetworkEntry[] {
  if (!Array.isArray(entries)) return Object.freeze([]);

  const sanitized = entries.map((entry, idx) =>
    Object.freeze({
      url: sanitizeUrl(String(entry.url ?? '')),
      method: String(entry.method ?? 'GET').toUpperCase(),
      status: typeof entry.status === 'number' ? entry.status : null,
      status_text: entry.status_text ? sanitizeEvidenceSecrets(String(entry.status_text)) : null,
      resource_type: entry.resource_type ? String(entry.resource_type) : null,
      duration_ms: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
      failed: Boolean(entry.failed),
      failure_reason: entry.failure_reason
        ? sanitizeEvidenceSecrets(String(entry.failure_reason))
        : null,
      request_headers: sanitizeHeaders(entry.request_headers),
      response_headers: sanitizeHeaders(entry.response_headers),
      _idx: idx,
    })
  );

  // Deterministic sort: url, method, original index
  sanitized.sort((a, b) => {
    if (a.url !== b.url) return a.url.localeCompare(b.url);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a._idx - b._idx;
  });

  return Object.freeze(
    sanitized.map(({ _idx, ...rest }) => Object.freeze(rest))
  );
}

/**
 * Sanitizes DOM element snapshot attributes and text.
 */
export function sanitizeDomElementSnapshot(
  snapshot: BrowserDomElementSnapshot
): BrowserDomElementSnapshot {
  const sanitizedAttrs: Record<string, string> = {};
  if (snapshot.attributes && typeof snapshot.attributes === 'object') {
    const sortedKeys = Object.keys(snapshot.attributes).sort();
    for (const key of sortedKeys) {
      const lower = key.toLowerCase();
      const val = String(snapshot.attributes[key]);
      if (
        lower.includes('secret') ||
        lower.includes('token') ||
        lower.includes('key') ||
        lower.includes('auth') ||
        lower.includes('password') ||
        (snapshot.tag_name?.toLowerCase() === 'input' && lower === 'value' && snapshot.attributes['type'] === 'password')
      ) {
        sanitizedAttrs[key] = '***REDACTED***';
      } else {
        sanitizedAttrs[key] = sanitizeEvidenceSecrets(val);
      }
    }
  }

  const sortedClasses = snapshot.classes ? Object.freeze([...snapshot.classes].sort()) : undefined;

  return Object.freeze({
    tag_name: String(snapshot.tag_name ?? ''),
    selector: snapshot.selector ? String(snapshot.selector) : null,
    attributes: Object.freeze(sanitizedAttrs),
    inner_text: snapshot.inner_text ? sanitizeEvidenceSecrets(String(snapshot.inner_text)) : null,
    is_visible: snapshot.is_visible !== undefined ? Boolean(snapshot.is_visible) : undefined,
    id: snapshot.id ? String(snapshot.id) : null,
    classes: sortedClasses,
  });
}

// ============================================================================
// 2. OBSERVATION NORMALIZATION
// ============================================================================

/**
 * Normalizes any browser observation deterministically with all secrets sanitized.
 */
export function normalizeBrowserObservation<T extends BrowserObservation>(observation: T): T {
  if (!observation || typeof observation !== 'object') {
    throw new InvalidBrowserObservationError('Browser observation must be a non-null object');
  }

  const base = {
    observation_id: String(observation.observation_id ?? '').trim(),
    task_id: String(observation.task_id ?? '').trim(),
    correlation_id: String(observation.correlation_id ?? '').trim(),
    captured_at: observation.captured_at ? String(observation.captured_at) : null,
    metadata: observation.metadata
      ? (sanitizeEvidenceDetails(observation.metadata) as Record<string, unknown>)
      : null,
  };

  switch (observation.observation_type) {
    case 'NAVIGATION': {
      const nav = observation as BrowserNavigationObservation;
      return Object.freeze({
        ...base,
        observation_type: 'NAVIGATION',
        url: sanitizeUrl(String(nav.url ?? '')),
        status_code: typeof nav.status_code === 'number' ? nav.status_code : null,
        title: nav.title ? sanitizeEvidenceSecrets(String(nav.title)) : null,
        redirected: Boolean(nav.redirected),
        navigation_time_ms: typeof nav.navigation_time_ms === 'number' ? nav.navigation_time_ms : null,
      }) as unknown as T;
    }

    case 'DOM': {
      const dom = observation as BrowserDomObservation;
      const elements = dom.elements
        ? Object.freeze(dom.elements.map(sanitizeDomElementSnapshot))
        : undefined;
      return Object.freeze({
        ...base,
        observation_type: 'DOM',
        url: sanitizeUrl(String(dom.url ?? '')),
        selector: dom.selector ? String(dom.selector) : null,
        matches_count: typeof dom.matches_count === 'number' ? dom.matches_count : 0,
        elements,
        html_snapshot_snippet: dom.html_snapshot_snippet
          ? sanitizeEvidenceSecrets(String(dom.html_snapshot_snippet))
          : null,
      }) as unknown as T;
    }

    case 'VISIBLE_ELEMENT': {
      const vis = observation as BrowserVisibleElementObservation;
      const styles: Record<string, string> = {};
      if (vis.computed_styles && typeof vis.computed_styles === 'object') {
        for (const k of Object.keys(vis.computed_styles).sort()) {
          styles[k] = String(vis.computed_styles[k]);
        }
      }
      return Object.freeze({
        ...base,
        observation_type: 'VISIBLE_ELEMENT',
        url: sanitizeUrl(String(vis.url ?? '')),
        selector: String(vis.selector ?? ''),
        is_visible: Boolean(vis.is_visible),
        visible_text: vis.visible_text ? sanitizeEvidenceSecrets(String(vis.visible_text)) : null,
        bounding_box: vis.bounding_box ? Object.freeze({ ...vis.bounding_box }) : null,
        computed_styles: Object.keys(styles).length > 0 ? Object.freeze(styles) : null,
      }) as unknown as T;
    }

    case 'SCREENSHOT': {
      const ss = observation as BrowserScreenshotObservation;
      return Object.freeze({
        ...base,
        observation_type: 'SCREENSHOT',
        url: sanitizeUrl(String(ss.url ?? '')),
        format: ss.format ?? 'png',
        mime_type: String(ss.mime_type ?? 'image/png'),
        byte_length: typeof ss.byte_length === 'number' ? ss.byte_length : 0,
        sha256_hash: String(ss.sha256_hash ?? ''),
        storage_path: ss.storage_path ? String(ss.storage_path) : null,
        base64_data: ss.base64_data ? String(ss.base64_data) : null,
        viewport: ss.viewport ? Object.freeze({ ...ss.viewport }) : null,
      }) as unknown as T;
    }

    case 'CONSOLE': {
      const con = observation as BrowserConsoleObservation;
      return Object.freeze({
        ...base,
        observation_type: 'CONSOLE',
        url: sanitizeUrl(String(con.url ?? '')),
        entries: sanitizeConsoleEntries(con.entries ?? []),
        has_errors: Boolean(con.has_errors),
      }) as unknown as T;
    }

    case 'NETWORK': {
      const net = observation as BrowserNetworkObservation;
      return Object.freeze({
        ...base,
        observation_type: 'NETWORK',
        url: sanitizeUrl(String(net.url ?? '')),
        entries: sanitizeNetworkEntries(net.entries ?? []),
        has_failures: Boolean(net.has_failures),
      }) as unknown as T;
    }

    default:
      throw new InvalidBrowserObservationError(
        `Unrecognized observation_type '${String((observation as any).observation_type)}'`,
        { field: 'observation_type' }
      );
  }
}

// ============================================================================
// 3. PREDICATES & TRUST BOUNDARY
// ============================================================================

/**
 * Validates whether an object is structurally an authentic BrowserObservation and
 * NOT an unverified AGENT_CLAIM.
 */
export function isBrowserObservation(value: unknown): value is BrowserObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const raw = value as Record<string, unknown>;

  // Strict check: if marked as an agent claim or has an unverified statement, reject immediately
  if (
    raw.source === EvidenceSource.AGENT_CLAIM ||
    raw.is_agent_claim === true ||
    raw.isAgentClaim === true ||
    typeof raw.statement === 'string'
  ) {
    return false;
  }

  // Must have required identity fields
  if (
    typeof raw.observation_id !== 'string' ||
    raw.observation_id.trim().length === 0 ||
    typeof raw.task_id !== 'string' ||
    raw.task_id.trim().length === 0 ||
    typeof raw.correlation_id !== 'string' ||
    raw.correlation_id.trim().length === 0 ||
    typeof raw.url !== 'string'
  ) {
    return false;
  }

  return isUiObservationType(raw.observation_type);
}

// ============================================================================
// 4. UI SYSTEM VERIFIED EVIDENCE CONTRACT
// ============================================================================

export interface UiEvidencePayload {
  readonly observation_id: string;
  readonly observation_type: UiObservationType;
  readonly target_url: string;
  readonly page_url: string;
  readonly navigation_observation?: BrowserNavigationObservation | null;
  readonly dom_observation?: BrowserDomObservation | null;
  readonly visible_element_observation?: BrowserVisibleElementObservation | null;
  readonly screenshot_observation?: BrowserScreenshotObservation | null;
  readonly console_observation?: BrowserConsoleObservation | null;
  readonly network_observation?: BrowserNetworkObservation | null;
  readonly browser_metadata?: Readonly<Record<string, unknown>> | null;
}

export interface UiSystemVerifiedEvidence extends SystemVerifiedEvidence {
  readonly evidence_type: 'UI';
  readonly observation_id: string;
  readonly ui_observation_type: UiObservationType;
  readonly target_url: string;
  readonly page_url: string;
  readonly ui_payload: UiEvidencePayload;
}

export interface CreateUiEvidenceParams {
  readonly task_id: string;
  readonly project_id: string;
  readonly correlation_id: string;
  readonly instruction_id?: string | null;
  readonly observation: BrowserObservation;
  readonly target_url: string;
  readonly working_directory?: string;
  readonly execution_time_ms?: number;
  readonly evidence_id?: string;
  readonly captured_at?: string | null;
  readonly executor_identity?: ExecutorIdentity | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

/**
 * Creates canonical, deeply frozen UiSystemVerifiedEvidence from an authentic BrowserObservation.
 * Strictly enforces that AGENT_CLAIM cannot be promoted into UI system evidence.
 * Integrates directly with the SYSTEM_VERIFIED_EVIDENCE boundary.
 */
export function createUiSystemVerifiedEvidence(
  params: CreateUiEvidenceParams
): UiSystemVerifiedEvidence {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new InvalidUiEvidenceError('UI evidence creation params must be a non-null object');
  }

  const rawParams = params as unknown as Record<string, unknown>;
  const rawObservation = params.observation as unknown as Record<string, unknown>;

  // Rule 1 & Rule 5: AGENT_CLAIM rejection
  if (
    rawParams.source === EvidenceSource.AGENT_CLAIM ||
    rawParams.is_agent_claim === true ||
    rawParams.isAgentClaim === true ||
    (rawObservation && (
      rawObservation.source === EvidenceSource.AGENT_CLAIM ||
      rawObservation.is_agent_claim === true ||
      rawObservation.isAgentClaim === true ||
      typeof rawObservation.statement === 'string'
    ))
  ) {
    throw new InvalidEvidenceSourceError(
      'AGENT_CLAIM cannot be promoted into UI system evidence. Only authentic browser observations are admissible.',
      {
        taskId: params.task_id,
        correlationId: params.correlation_id,
      }
    );
  }

  if (!isBrowserObservation(params.observation)) {
    throw new InvalidBrowserObservationError(
      'Cannot create UI system evidence: observation is not a valid browser observation.',
      {
        taskId: params.task_id,
        correlationId: params.correlation_id,
      }
    );
  }

  const taskId = String(params.task_id ?? '').trim();
  if (!taskId) {
    throw new InvalidUiEvidenceError('Missing mandatory field: task_id', { field: 'task_id' });
  }

  const projectId = String(params.project_id ?? '').trim();
  if (!projectId) {
    throw new InvalidUiEvidenceError('Missing mandatory field: project_id', { field: 'project_id' });
  }

  const correlationId = String(params.correlation_id ?? '').trim();
  if (!correlationId) {
    throw new InvalidUiEvidenceError('Missing mandatory field: correlation_id', { field: 'correlation_id' });
  }

  const targetUrl = sanitizeUrl(String(params.target_url ?? '').trim());
  if (!targetUrl) {
    throw new InvalidUiEvidenceError('Missing mandatory field: target_url', { field: 'target_url' });
  }

  // Deterministically normalize and sanitize the observation
  const normalizedObservation = normalizeBrowserObservation(params.observation);

  // Deterministic evidence ID if caller did not supply one
  const evidenceId = params.evidence_id && params.evidence_id.trim().length > 0
    ? params.evidence_id.trim()
    : `evi:${taskId}:ui:${normalizedObservation.observation_type.toLowerCase()}:${correlationId}`;

  const executionTimeMs = typeof params.execution_time_ms === 'number' && Number.isFinite(params.execution_time_ms)
    ? Math.max(0, params.execution_time_ms)
    : 0;

  const workingDirectory = params.working_directory && params.working_directory.trim().length > 0
    ? params.working_directory.trim()
    : '/';

  const executorIdentity = params.executor_identity
    ? Object.freeze({
        provider: String(params.executor_identity.provider),
        name: String(params.executor_identity.name),
        version: params.executor_identity.version ? String(params.executor_identity.version) : null,
      })
    : Object.freeze({
        provider: 'browser-port',
        name: 'BrowserObservationAdapter',
        version: '1.0.0',
      });

  const capturedAt = normalizedObservation.captured_at ?? params.captured_at ?? null;

  // Build specialized UI evidence payload
  const uiPayload: UiEvidencePayload = Object.freeze({
    observation_id: normalizedObservation.observation_id,
    observation_type: normalizedObservation.observation_type,
    target_url: targetUrl,
    page_url: normalizedObservation.url,
    navigation_observation: normalizedObservation.observation_type === 'NAVIGATION'
      ? (normalizedObservation as BrowserNavigationObservation)
      : null,
    dom_observation: normalizedObservation.observation_type === 'DOM'
      ? (normalizedObservation as BrowserDomObservation)
      : null,
    visible_element_observation: normalizedObservation.observation_type === 'VISIBLE_ELEMENT'
      ? (normalizedObservation as BrowserVisibleElementObservation)
      : null,
    screenshot_observation: normalizedObservation.observation_type === 'SCREENSHOT'
      ? (normalizedObservation as BrowserScreenshotObservation)
      : null,
    console_observation: normalizedObservation.observation_type === 'CONSOLE'
      ? (normalizedObservation as BrowserConsoleObservation)
      : null,
    network_observation: normalizedObservation.observation_type === 'NETWORK'
      ? (normalizedObservation as BrowserNetworkObservation)
      : null,
    browser_metadata: normalizedObservation.metadata ?? null,
  });

  const metadata: Record<string, unknown> = {
    ui_evidence: uiPayload,
  };

  if (params.metadata && typeof params.metadata === 'object') {
    const sanitizedCustomMeta = sanitizeEvidenceDetails(params.metadata) as Record<string, unknown>;
    Object.assign(metadata, sanitizedCustomMeta);
  }

  const canonicalEvidence: UiSystemVerifiedEvidence = Object.freeze({
    evidence_id: evidenceId,
    task_id: taskId,
    instruction_id: params.instruction_id ?? null,
    project_id: projectId,
    correlation_id: correlationId,
    command: `browser:observe:${normalizedObservation.observation_type.toLowerCase()}`,
    exit_code: 0,
    stdout_tail: `[UI Observation] type=${normalizedObservation.observation_type} url=${normalizedObservation.url}`,
    stderr: null,
    working_directory: workingDirectory,
    execution_time_ms: executionTimeMs,
    git_head_before: null,
    git_head_after: null,
    unified_diff: null,
    file_hashes_after: null,
    evidence_type: EvidenceType.UI,
    executor_identity: executorIdentity,
    captured_at: capturedAt,
    metadata: Object.freeze(metadata),
    source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
    observation_id: normalizedObservation.observation_id,
    ui_observation_type: normalizedObservation.observation_type,
    target_url: targetUrl,
    page_url: normalizedObservation.url,
    ui_payload: uiPayload,
  });

  // Verify against the authoritative SystemVerifiedEvidence boundary
  assertValidSystemVerifiedEvidence(canonicalEvidence);

  return canonicalEvidence;
}

/**
 * Validates a UI evidence input against both SystemVerifiedEvidence and UI-specific invariants.
 */
export function validateUiSystemVerifiedEvidence(input: unknown): EvidenceValidationResult {
  const baseResult = validateSystemVerifiedEvidence(input);
  if (!baseResult.valid) {
    return baseResult;
  }

  const raw = input as UiSystemVerifiedEvidence & Record<string, unknown>;
  const issues: EvidenceValidationIssue[] = [];

  if (raw.evidence_type !== EvidenceType.UI) {
    issues.push(
      Object.freeze({
        code: 'ERR_INVALID_UI_EVIDENCE',
        field: 'evidence_type',
        message: `Expected evidence_type to be '${EvidenceType.UI}', received '${String(raw.evidence_type)}'`,
      })
    );
  }

  if (!raw.observation_id || typeof raw.observation_id !== 'string' || raw.observation_id.trim().length === 0) {
    issues.push(
      Object.freeze({
        code: 'ERR_INVALID_UI_EVIDENCE',
        field: 'observation_id',
        message: 'Missing or empty observation_id in UI evidence',
      })
    );
  }

  if (!isUiObservationType(raw.ui_observation_type)) {
    issues.push(
      Object.freeze({
        code: 'ERR_INVALID_UI_EVIDENCE',
        field: 'ui_observation_type',
        message: `Invalid ui_observation_type '${String(raw.ui_observation_type)}'`,
      })
    );
  }

  if (issues.length > 0) {
    return {
      status: EvidenceValidationStatus.INVALID,
      valid: false,
      issues: Object.freeze(issues),
    };
  }

  return baseResult;
}

/**
 * Asserts that an input is valid UiSystemVerifiedEvidence, throwing on failure.
 */
export function assertValidUiSystemVerifiedEvidence(input: unknown): UiSystemVerifiedEvidence {
  const result = validateUiSystemVerifiedEvidence(input);
  if (!result.valid) {
    const first = result.issues[0];
    throw new InvalidUiEvidenceError(first.message, {
      field: first.field,
      reason: first.message,
    });
  }
  return input as UiSystemVerifiedEvidence;
}
