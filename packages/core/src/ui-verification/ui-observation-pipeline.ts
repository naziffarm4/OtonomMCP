import {
  type UiVerificationRequest,
  UiObservationType
} from './ui-verification-types.js';
import {
  type BrowserPort,
  type BrowserSessionConfig,
  type BrowserSession,
  type BrowserObservation
} from './browser-port.js';
import {
  createUiSystemVerifiedEvidence,
  type UiSystemVerifiedEvidence
} from './ui-evidence-types.js';
import { validateSystemVerifiedEvidence } from '../evidence/evidence-validator.js';
import {
  UiVerificationError,
  InvalidUiEvidenceError,
} from '../errors/index.js';

import { type ExecutorIdentity } from '../evidence/evidence-types.js';

export interface UiObservationPipelineResult {
  readonly success: boolean;
  readonly evidence: readonly UiSystemVerifiedEvidence[];
  readonly issues: readonly string[];
}

export interface UiObservationPipelineOptions {
  readonly working_directory?: string;
  readonly executor_identity?: ExecutorIdentity;
  readonly browser_config?: BrowserSessionConfig;
}

export class UiObservationPipeline {
  constructor(private readonly browserPort: BrowserPort) {}

  async run(
    request: UiVerificationRequest,
    options?: UiObservationPipelineOptions
  ): Promise<UiObservationPipelineResult> {
    const availability = await this.browserPort.checkAvailability();
    if (!availability.available) {
      return {
        success: false,
        evidence: Object.freeze([]),
        issues: Object.freeze(['Browser is unavailable: ' + (availability.reason ?? 'Unknown')])
      };
    }

    const issues: string[] = [];
    const evidenceList: UiSystemVerifiedEvidence[] = [];
    let session: BrowserSession | null = null;
    let hasRequiredFailure = false;

    // Reject AGENT_CLAIM from being passed as verification request metadata or similar?
    // We already do this inside createUiSystemVerifiedEvidence.
    
    try {
      session = await this.browserPort.startSession(options?.browser_config);

      const requestedObs = request.required_observations;
      
      const processObservation = (obs: BrowserObservation, start: number) => {
        try {
          if (obs.task_id !== request.task_id || obs.correlation_id !== request.correlation_id) {
            throw new Error(`Correlation mismatch: observation task/correlation does not match request`);
          }
          const evidence = createUiSystemVerifiedEvidence({
            task_id: request.task_id,
            project_id: request.project_id,
            correlation_id: request.correlation_id,
            observation: obs,
            target_url: request.target_url,
            working_directory: options?.working_directory,
            executor_identity: options?.executor_identity,
            execution_time_ms: Date.now() - start,
          });

          const validation = validateSystemVerifiedEvidence(evidence);
          if (!validation.valid) {
            throw new InvalidUiEvidenceError(`Evidence validation failed for ${obs.observation_type}: ` + validation.issues.map(i => i.message).join(', '));
          }

          evidenceList.push(evidence);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          issues.push(`Failed to produce valid evidence for ${obs.observation_type}: ${errorMsg}`);
          hasRequiredFailure = true;
        }
      };

      const handleObsError = (type: string, err: unknown) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        issues.push(`Failed to collect required observation ${type}: ${errorMsg}`);
        hasRequiredFailure = true;
      };

      // 1. Navigation
      // We always need to navigate to the target URL first.
      let currentUrl = request.target_url;
      const navStart = Date.now();
      try {
        const navObs = await this.browserPort.navigate({
          task_id: request.task_id,
          correlation_id: request.correlation_id,
          url: request.target_url,
          timeout_ms: request.timeout_ms
        });
        currentUrl = navObs.url;
        
        if (requestedObs.includes(UiObservationType.NAVIGATION)) {
          processObservation(navObs, navStart);
        }
      } catch (err) {
        if (requestedObs.includes(UiObservationType.NAVIGATION)) {
          handleObsError(UiObservationType.NAVIGATION, err);
        } else {
          issues.push(`Implicit navigation failed: ${err instanceof Error ? err.message : String(err)}`);
          hasRequiredFailure = true;
        }
      }

      if (hasRequiredFailure) {
        return {
          success: false,
          evidence: Object.freeze([...evidenceList]),
          issues: Object.freeze([...issues])
        };
      }

      // Order enforced: DOM, VISIBLE_ELEMENT, SCREENSHOT, CONSOLE, NETWORK
      
      // 2. DOM
      if (requestedObs.includes(UiObservationType.DOM)) {
        const selectors = request.expected_dom_conditions?.length 
          ? request.expected_dom_conditions.map(c => c.selector)
          : [undefined];

        for (const selector of selectors) {
          const start = Date.now();
          try {
            const obs = await this.browserPort.observeDom({
              task_id: request.task_id,
              correlation_id: request.correlation_id,
              selector: selector
            });
            processObservation(obs, start);
          } catch (err) {
            handleObsError(UiObservationType.DOM, err);
          }
        }
      }

      // 3. VISIBLE ELEMENT
      if (requestedObs.includes(UiObservationType.VISIBLE_ELEMENT)) {
        const selectors = request.expected_visible_conditions?.length
          ? request.expected_visible_conditions.map(c => c.selector)
          : ['body'];
        
        for (const selector of selectors) {
          const start = Date.now();
          try {
            const obs = await this.browserPort.observeVisibleElement({
              task_id: request.task_id,
              correlation_id: request.correlation_id,
              selector: selector
            });
            processObservation(obs, start);
          } catch (err) {
            handleObsError(UiObservationType.VISIBLE_ELEMENT, err);
          }
        }
      }

      // 4. SCREENSHOT
      if (requestedObs.includes(UiObservationType.SCREENSHOT)) {
        const start = Date.now();
        try {
          const req = request.screenshot_requirements;
          const format = req?.format ?? 'png';
          
          const obs = await this.browserPort.captureScreenshot({
            task_id: request.task_id,
            correlation_id: request.correlation_id,
            format: format,
            full_page: req?.full_page ?? false,
            selector: req?.element_selector
          });
          processObservation(obs, start);
        } catch (err) {
          handleObsError(UiObservationType.SCREENSHOT, err);
        }
      }

      // 5. CONSOLE
      if (requestedObs.includes(UiObservationType.CONSOLE)) {
        const start = Date.now();
        try {
          const obs = await this.browserPort.observeConsole({
            task_id: request.task_id,
            correlation_id: request.correlation_id,
          });
          processObservation(obs, start);
        } catch (err) {
          handleObsError(UiObservationType.CONSOLE, err);
        }
      }

      // 6. NETWORK
      if (requestedObs.includes(UiObservationType.NETWORK)) {
        const start = Date.now();
        try {
          const obs = await this.browserPort.observeNetwork({
            task_id: request.task_id,
            correlation_id: request.correlation_id,
          });
          processObservation(obs, start);
        } catch (err) {
          handleObsError(UiObservationType.NETWORK, err);
        }
      }

    } catch (err) {
      if (err instanceof UiVerificationError) {
        issues.push(err.message);
      } else {
        issues.push(`Pipeline execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      hasRequiredFailure = true;
    } finally {
      if (session) {
        try {
          await this.browserPort.closeSession(session.session_id);
        } catch (err) {
          // Ignore closure errors
        }
      }
    }

    return {
      success: !hasRequiredFailure,
      evidence: Object.freeze([...evidenceList]),
      issues: Object.freeze([...issues])
    };
  }
}
