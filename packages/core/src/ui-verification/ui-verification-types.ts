/**
 * Phase 5 UI Verification Contracts & Types
 *
 * Defines strongly typed models for UI verification requests, observation requirements,
 * expected DOM/visual/console/network conditions, and deterministic validation.
 */

import { InvalidUiVerificationRequestError } from '../errors/ui-verification-error.js';
import { sanitizeEvidenceSecrets, sanitizeEvidenceDetails } from '../errors/evidence-error.js';

// ============================================================================
// 1. UI OBSERVATION TYPES
// ============================================================================

export const UiObservationType = {
  NAVIGATION: 'NAVIGATION',
  DOM: 'DOM',
  VISIBLE_ELEMENT: 'VISIBLE_ELEMENT',
  SCREENSHOT: 'SCREENSHOT',
  CONSOLE: 'CONSOLE',
  NETWORK: 'NETWORK',
} as const;

export type UiObservationType = (typeof UiObservationType)[keyof typeof UiObservationType];
export const UI_OBSERVATION_TYPES = Object.values(UiObservationType) as readonly UiObservationType[];

export function isUiObservationType(value: unknown): value is UiObservationType {
  return typeof value === 'string' && (UI_OBSERVATION_TYPES as readonly string[]).includes(value);
}

// ============================================================================
// 2. EXPECTED CONDITION SPECIFICATIONS
// ============================================================================

export interface UiDomCondition {
  readonly selector: string;
  readonly presence?: 'present' | 'absent';
  readonly text_contains?: string;
  readonly text_equals?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly min_count?: number;
  readonly max_count?: number;
}

export interface UiVisibleElementCondition {
  readonly selector: string;
  readonly state?: 'visible' | 'hidden';
  readonly text_contains?: string;
  readonly text_equals?: string;
}

export interface UiConsoleCondition {
  readonly disallowed_levels?: readonly ('log' | 'info' | 'warn' | 'error' | 'debug')[];
  readonly disallowed_patterns?: readonly string[];
  readonly expected_patterns?: readonly string[];
}

export interface UiNetworkExpectedRequest {
  readonly url_pattern: string;
  readonly method?: string;
  readonly status?: number;
}

export interface UiNetworkCondition {
  readonly expected_requests?: readonly UiNetworkExpectedRequest[];
  readonly disallowed_urls?: readonly string[];
  readonly disallowed_statuses?: readonly number[];
  readonly require_no_failed_requests?: boolean;
}

export interface UiScreenshotRequirement {
  readonly capture: boolean;
  readonly full_page?: boolean;
  readonly element_selector?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly format?: 'png' | 'jpeg' | 'webp';
}

// ============================================================================
// 3. UI VERIFICATION REQUEST CONTRACT
// ============================================================================

export interface UiVerificationRequest {
  readonly task_id: string;
  readonly project_id: string;
  readonly correlation_id: string;
  readonly criterion_id: string;
  readonly target_url: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly required_observations: readonly UiObservationType[];
  readonly expected_dom_conditions?: readonly UiDomCondition[];
  readonly expected_visible_conditions?: readonly UiVisibleElementCondition[];
  readonly expected_console_conditions?: UiConsoleCondition | null;
  readonly expected_network_conditions?: UiNetworkCondition | null;
  readonly screenshot_requirements?: UiScreenshotRequirement | null;
  readonly timeout_ms?: number;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface UiVerificationRequestInput {
  task_id?: string;
  taskId?: string;
  project_id?: string;
  projectId?: string;
  correlation_id?: string;
  correlationId?: string;
  criterion_id?: string;
  criterionId?: string;
  acceptance_criterion_id?: string;
  acceptanceCriterionId?: string;
  target_url?: string;
  targetUrl?: string;
  url?: string;
  attempt?: number;
  max_attempts?: number;
  maxAttempts?: number;
  required_observations?: readonly (UiObservationType | string)[];
  requiredObservations?: readonly (UiObservationType | string)[];
  expected_dom_conditions?: readonly UiDomCondition[];
  expectedDomConditions?: readonly UiDomCondition[];
  expected_visible_conditions?: readonly UiVisibleElementCondition[];
  expectedVisibleConditions?: readonly UiVisibleElementCondition[];
  expected_console_conditions?: UiConsoleCondition | null;
  expectedConsoleConditions?: UiConsoleCondition | null;
  expected_network_conditions?: UiNetworkCondition | null;
  expectedNetworkConditions?: UiNetworkCondition | null;
  screenshot_requirements?: UiScreenshotRequirement | null;
  screenshotRequirements?: UiScreenshotRequirement | null;
  timeout_ms?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown> | null;
}

// ============================================================================
// 4. REQUEST VALIDATION
// ============================================================================

export interface UiVerificationRequestIssue {
  readonly code: string;
  readonly field?: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface UiVerificationRequestValidationResult {
  readonly valid: boolean;
  readonly request?: UiVerificationRequest;
  readonly issues: readonly UiVerificationRequestIssue[];
}

/**
 * Validates whether a target URL is structurally plausible (http/https/file or relative / path).
 */
export function isValidTargetUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  if (/\s/.test(trimmed)) return false;

  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('file://') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./')
  );
}

/**
 * Validates a UI verification request against boundary integrity constraints.
 * Deterministic and free of side effects.
 */
export function validateUiVerificationRequest(
  input: unknown
): UiVerificationRequestValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      issues: Object.freeze([
        {
          code: 'ERR_INVALID_UI_VERIFICATION_REQUEST',
          field: 'request',
          message: 'UI verification request must be a non-null object',
        },
      ]),
    };
  }

  const raw = input as UiVerificationRequestInput & Record<string, unknown>;
  const issues: UiVerificationRequestIssue[] = [];

  function addIssue(code: string, field: string | undefined, rawMsg: string, details?: Record<string, unknown>): void {
    issues.push(
      Object.freeze({
        code,
        field,
        message: sanitizeEvidenceSecrets(rawMsg),
        details: details ? Object.freeze({ ...details }) : undefined,
      })
    );
  }

  // task_id
  const taskId = String(raw.task_id ?? raw.taskId ?? '').trim();
  if (!taskId) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'task_id',
      'Missing mandatory UI verification request field: task_id'
    );
  }

  // project_id
  const projectId = String(raw.project_id ?? raw.projectId ?? '').trim();
  if (!projectId) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'project_id',
      'Missing mandatory UI verification request field: project_id'
    );
  }

  // correlation_id
  const correlationId = String(raw.correlation_id ?? raw.correlationId ?? '').trim();
  if (!correlationId) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'correlation_id',
      'Missing mandatory UI verification request field: correlation_id'
    );
  }

  // criterion_id
  const criterionId = String(
    raw.criterion_id ??
    raw.criterionId ??
    raw.acceptance_criterion_id ??
    raw.acceptanceCriterionId ??
    ''
  ).trim();
  if (!criterionId) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'criterion_id',
      'Missing mandatory UI verification request field: criterion_id'
    );
  }

  // target_url
  const targetUrl = String(raw.target_url ?? raw.targetUrl ?? raw.url ?? '').trim();
  if (!targetUrl) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'target_url',
      'Missing mandatory UI verification request field: target_url'
    );
  } else if (!isValidTargetUrl(targetUrl)) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'target_url',
      `Invalid target_url '${targetUrl}'. Must be a valid http, https, file, or absolute/relative path.`,
      { target_url: targetUrl }
    );
  }

  // attempt
  const attempt = raw.attempt !== undefined ? Number(raw.attempt) : 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'attempt',
      `Invalid attempt '${String(raw.attempt)}'. Must be an integer >= 1.`,
      { attempt: raw.attempt }
    );
  }

  // max_attempts
  const maxAttempts = raw.max_attempts !== undefined
    ? Number(raw.max_attempts)
    : (raw.maxAttempts !== undefined ? Number(raw.maxAttempts) : Math.max(attempt, 1));
  if (!Number.isInteger(maxAttempts) || maxAttempts < attempt) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'max_attempts',
      `Invalid max_attempts '${String(raw.max_attempts ?? raw.maxAttempts)}'. Must be an integer >= attempt (${attempt}).`,
      { max_attempts: raw.max_attempts ?? raw.maxAttempts, attempt }
    );
  }

  // required_observations
  const rawObs = raw.required_observations ?? raw.requiredObservations;
  let requiredObservations: readonly UiObservationType[] = [];
  if (!rawObs || !Array.isArray(rawObs) || rawObs.length === 0) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'required_observations',
      'required_observations must be a non-empty array of valid UiObservationType values.'
    );
  } else {
    const validObsList: UiObservationType[] = [];
    for (let i = 0; i < rawObs.length; i++) {
      const item = rawObs[i];
      if (!isUiObservationType(item)) {
        addIssue(
          'ERR_INVALID_UI_VERIFICATION_REQUEST',
          `required_observations[${i}]`,
          `Invalid observation type '${String(item)}'. Must be one of: ${UI_OBSERVATION_TYPES.join(', ')}.`,
          { observation_type: item }
        );
      } else {
        validObsList.push(item);
      }
    }
    // Deduplicate and sort deterministically
    requiredObservations = Object.freeze(Array.from(new Set(validObsList)).sort());
  }

  // timeout_ms
  const timeoutMs = raw.timeout_ms !== undefined
    ? Number(raw.timeout_ms)
    : (raw.timeoutMs !== undefined ? Number(raw.timeoutMs) : undefined);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    addIssue(
      'ERR_INVALID_UI_VERIFICATION_REQUEST',
      'timeout_ms',
      `Invalid timeout_ms '${String(timeoutMs)}'. Must be a non-negative number.`,
      { timeout_ms: timeoutMs }
    );
  }

  if (issues.length > 0) {
    return {
      valid: false,
      issues: Object.freeze(issues),
    };
  }

  // Canonical deeply frozen UiVerificationRequest
  const domConditions = raw.expected_dom_conditions ?? raw.expectedDomConditions;
  const visibleConditions = raw.expected_visible_conditions ?? raw.expectedVisibleConditions;
  const consoleConditions = raw.expected_console_conditions ?? raw.expectedConsoleConditions;
  const networkConditions = raw.expected_network_conditions ?? raw.expectedNetworkConditions;
  const screenshotReq = raw.screenshot_requirements ?? raw.screenshotRequirements;

  const sanitizedMetadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? (sanitizeEvidenceDetails(raw.metadata) as Record<string, unknown>)
    : null;

  const canonicalRequest: UiVerificationRequest = Object.freeze({
    task_id: taskId,
    project_id: projectId,
    correlation_id: correlationId,
    criterion_id: criterionId,
    target_url: targetUrl,
    attempt,
    max_attempts: maxAttempts,
    required_observations: requiredObservations,
    expected_dom_conditions: domConditions ? Object.freeze([...domConditions]) : undefined,
    expected_visible_conditions: visibleConditions ? Object.freeze([...visibleConditions]) : undefined,
    expected_console_conditions: consoleConditions ? Object.freeze({ ...consoleConditions }) : null,
    expected_network_conditions: networkConditions ? Object.freeze({ ...networkConditions }) : null,
    screenshot_requirements: screenshotReq ? Object.freeze({ ...screenshotReq }) : null,
    timeout_ms: timeoutMs,
    metadata: sanitizedMetadata ? Object.freeze(sanitizedMetadata) : null,
  });

  return {
    valid: true,
    request: canonicalRequest,
    issues: Object.freeze([]),
  };
}

/**
 * Asserts that an input is a valid UiVerificationRequest, throwing InvalidUiVerificationRequestError on failure.
 */
export function assertValidUiVerificationRequest(input: unknown): UiVerificationRequest {
  const result = validateUiVerificationRequest(input);
  if (!result.valid || !result.request) {
    const firstIssue = result.issues[0];
    throw new InvalidUiVerificationRequestError(firstIssue.message, {
      field: firstIssue.field,
      reason: firstIssue.message,
      cause: result.issues,
      ...firstIssue.details,
    });
  }
  return result.request;
}
