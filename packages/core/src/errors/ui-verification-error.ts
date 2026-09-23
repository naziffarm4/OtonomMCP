import { AidmError, type AidmErrorDetails } from './aidm-error.js';
import { sanitizeEvidenceSecrets, sanitizeEvidenceDetails } from './evidence-error.js';

export type UiVerificationErrorCode =
  | 'ERR_UI_VERIFICATION_GENERAL'
  | 'ERR_INVALID_UI_VERIFICATION_REQUEST'
  | 'ERR_BROWSER_UNAVAILABLE'
  | 'ERR_UNSUPPORTED_BROWSER_CAPABILITY'
  | 'ERR_BROWSER_NAVIGATION_FAILURE'
  | 'ERR_DOM_OBSERVATION_FAILURE'
  | 'ERR_SCREENSHOT_FAILURE'
  | 'ERR_CONSOLE_OBSERVATION_FAILURE'
  | 'ERR_NETWORK_OBSERVATION_FAILURE'
  | 'ERR_INVALID_BROWSER_OBSERVATION'
  | 'ERR_INVALID_UI_EVIDENCE';

export interface UiVerificationErrorDetails extends AidmErrorDetails {
  taskId?: string;
  projectId?: string;
  correlationId?: string;
  criterionId?: string;
  observationId?: string;
  evidenceId?: string;
  field?: string;
  reason?: string;
  capability?: string;
  url?: string;
  selector?: string;
  cause?: unknown;
}

/**
 * Base structured error class for all UI verification failures.
 * Extends AidmError and ensures secret sanitization across messages and details.
 */
export class UiVerificationError extends AidmError {
  readonly taskId?: string;
  readonly projectId?: string;
  readonly correlationId?: string;
  readonly criterionId?: string;
  readonly observationId?: string;
  readonly evidenceId?: string;
  readonly field?: string;
  readonly reason?: string;
  readonly capability?: string;
  readonly url?: string;
  readonly selector?: string;

  constructor(
    message: string,
    code: UiVerificationErrorCode = 'ERR_UI_VERIFICATION_GENERAL',
    details?: UiVerificationErrorDetails
  ) {
    const sanitizedMsg = sanitizeEvidenceSecrets(message);
    const sanitizedDetails = sanitizeEvidenceDetails(details) as UiVerificationErrorDetails | undefined;
    const formattedMessage = sanitizedMsg.startsWith(`[${code}]`)
      ? sanitizedMsg
      : `[${code}] ${sanitizedMsg}`;

    super(formattedMessage, code, sanitizedDetails);
    this.name = 'UiVerificationError';
    this.taskId = sanitizedDetails?.taskId;
    this.projectId = sanitizedDetails?.projectId;
    this.correlationId = sanitizedDetails?.correlationId;
    this.criterionId = sanitizedDetails?.criterionId;
    this.observationId = sanitizedDetails?.observationId;
    this.evidenceId = sanitizedDetails?.evidenceId;
    this.field = sanitizedDetails?.field;
    this.reason = sanitizedDetails?.reason;
    this.capability = sanitizedDetails?.capability;
    this.url = sanitizedDetails?.url;
    this.selector = sanitizedDetails?.selector;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a UI verification request fails structural validation.
 */
export class InvalidUiVerificationRequestError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_INVALID_UI_VERIFICATION_REQUEST', details);
    this.name = 'InvalidUiVerificationRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the browser runtime or injected browser port is unavailable.
 */
export class BrowserUnavailableError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_BROWSER_UNAVAILABLE', details);
    this.name = 'BrowserUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation requires a browser capability not supported by the provider.
 */
export class UnsupportedBrowserCapabilityError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_UNSUPPORTED_BROWSER_CAPABILITY', details);
    this.name = 'UnsupportedBrowserCapabilityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when page navigation fails or encounters an unhandled navigation error.
 */
export class BrowserNavigationError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_BROWSER_NAVIGATION_FAILURE', details);
    this.name = 'BrowserNavigationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when DOM observation or selector query fails.
 */
export class DomObservationError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_DOM_OBSERVATION_FAILURE', details);
    this.name = 'DomObservationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when capturing a screenshot fails.
 */
export class ScreenshotError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_SCREENSHOT_FAILURE', details);
    this.name = 'ScreenshotError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when console observation fails.
 */
export class ConsoleObservationError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_CONSOLE_OBSERVATION_FAILURE', details);
    this.name = 'ConsoleObservationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when network observation fails.
 */
export class NetworkObservationError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_NETWORK_OBSERVATION_FAILURE', details);
    this.name = 'NetworkObservationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a browser observation object is structurally invalid or corrupt.
 */
export class InvalidBrowserObservationError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_INVALID_BROWSER_OBSERVATION', details);
    this.name = 'InvalidBrowserObservationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when UI verification evidence is structurally invalid or fails integrity constraints.
 */
export class InvalidUiEvidenceError extends UiVerificationError {
  constructor(message: string, details?: UiVerificationErrorDetails) {
    super(message, 'ERR_INVALID_UI_EVIDENCE', details);
    this.name = 'InvalidUiEvidenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
