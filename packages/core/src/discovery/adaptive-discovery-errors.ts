/**
 * Adaptive Discovery Errors (Phase 15 TASK-P15-01)
 *
 * Defines domain-specific error classes for adaptive project discovery.
 */

import { AidmError, type AidmErrorDetails } from '../errors/aidm-error.js';

export class AdaptiveDiscoveryError extends AidmError {
  constructor(message: string, code = 'ERR_ADAPTIVE_DISCOVERY', details?: AidmErrorDetails) {
    super(message, code, details);
  }
}

export class DiscoveryValidationError extends AdaptiveDiscoveryError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DISCOVERY_VALIDATION', details);
  }
}

export class DiscoveryProjectBindingMismatchError extends AdaptiveDiscoveryError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DISCOVERY_PROJECT_BINDING_MISMATCH', details);
  }
}

export class DiscoveryImmutableRevisionError extends AdaptiveDiscoveryError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DISCOVERY_IMMUTABLE_REVISION', details);
  }
}

export class DiscoveryNotFoundError extends AdaptiveDiscoveryError {
  constructor(message: string, details?: AidmErrorDetails) {
    super(message, 'ERR_DISCOVERY_NOT_FOUND', details);
  }
}
