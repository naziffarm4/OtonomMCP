/**
 * UIAdapter: Project UI environment and verification abstraction.
 *
 * Implements the project-independent adapter contract specified in
 * Technical Discovery Section 22:
 * "UIAdapter: Projenin arayüz ortamını (Web, Desktop, TUI) ayağa kaldırır."
 */

import {
  UiVerificationService,
  type UiVerificationExecutionResult,
  type UiVerificationServiceOptions,
} from '../ui-verification/ui-verification-service.js';
import {
  type UiVerificationRequest,
  type UiVerificationRequestInput,
} from '../ui-verification/ui-verification-types.js';

export interface UIAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * Verifies UI requirements through the headless UI verification pipeline.
   */
  verifyUI(
    request: UiVerificationRequest | UiVerificationRequestInput,
    options?: UiVerificationServiceOptions
  ): Promise<UiVerificationExecutionResult>;
}

/**
 * Default UI adapter connecting to Phase 5 UiVerificationService.
 */
export class DefaultUIAdapter implements UIAdapter {
  readonly id = 'adapter:ui:playwright';
  readonly name = 'Headless Browser UI Adapter';

  private readonly service: UiVerificationService;

  constructor(service: UiVerificationService) {
    this.service = service;
  }

  async verifyUI(
    request: UiVerificationRequest | UiVerificationRequestInput,
    options?: UiVerificationServiceOptions
  ): Promise<UiVerificationExecutionResult> {
    return this.service.execute(request, options);
  }
}
