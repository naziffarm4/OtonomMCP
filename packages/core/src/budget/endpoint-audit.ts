/**
 * @file endpoint-audit.ts
 * @description Authoritative Endpoint-Specific Usage Contracts & Billing Endpoint Audit (OM-09C-FIX-4).
 *
 * Implements:
 * 1. Independent endpoint classification: Chat Completions (/v1/chat/completions),
 *    Responses (/v1/responses), Anthropic (/v1/messages), and Reference Adapter.
 * 2. Effective billing endpoint resolution across all configuration paths:
 *    base URL, endpoint overrides, environment variables, provider options, request metadata.
 * 3. Pre-dispatch fail-closed rejection of regional routing and data-residency surcharges
 *    unless explicitly registered and tested in the PricingEngine.
 * 4. Rejection of unknown / unsupported base URL overrides that may incur hidden fees.
 * 5. Secret sanitization: API keys or credentials in URLs are never exposed in error messages or logs.
 */

import { sanitizeSecrets } from '../errors/llm-error.js';
import type { BudgetErrorCode } from '../errors/budget-error.js';
import type { PricingEngine } from './pricing-engine.js';

export type BillingEndpointKind =
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'reference_adapter'
  | 'custom_endpoint';

export interface EndpointAuditSuccess {
  readonly valid: true;
  readonly endpointKind: BillingEndpointKind;
  readonly sanitizedEndpoint: string;
}

export interface EndpointAuditFailure {
  readonly valid: false;
  readonly errorReason: string;
  readonly errorCode: BudgetErrorCode;
  readonly sanitizedEndpoint?: string;
}

export type EndpointAuditResult = EndpointAuditSuccess | EndpointAuditFailure;

/**
 * Standard, verified OpenAI hostnames that do not incur regional surcharges.
 */
const STANDARD_OPENAI_HOSTS = new Set([
  'api.openai.com',
]);

/**
 * Standard, verified Anthropic hostnames.
 */
const STANDARD_ANTHROPIC_HOSTS = new Set([
  'api.anthropic.com',
]);

/**
 * Resolves the BillingEndpointKind from an endpoint URL and provider identifier.
 */
export function resolveBillingEndpointKind(
  endpoint?: string | null,
  providerId?: string | null
): BillingEndpointKind {
  if (!endpoint || endpoint.trim().length === 0) {
    if (providerId?.toLowerCase().includes('anthropic')) {
      return 'anthropic_messages';
    }
    if (providerId?.toLowerCase().includes('openai')) {
      return 'openai_chat_completions';
    }
    return 'reference_adapter';
  }

  try {
    const parsed = new URL(endpoint);
    const pathname = parsed.pathname.toLowerCase();

    if (pathname.endsWith('/responses') || pathname.endsWith('/v1/responses')) {
      return 'openai_responses';
    }
    if (pathname.endsWith('/chat/completions') || pathname.endsWith('/v1/chat/completions')) {
      return 'openai_chat_completions';
    }
    if (pathname.endsWith('/messages') || pathname.endsWith('/v1/messages')) {
      return 'anthropic_messages';
    }
  } catch {
    // If not a valid URL, inspect path snippet
    const lower = endpoint.toLowerCase();
    if (lower.includes('/responses')) return 'openai_responses';
    if (lower.includes('/chat/completions')) return 'openai_chat_completions';
    if (lower.includes('/messages')) return 'anthropic_messages';
  }

  return 'custom_endpoint';
}

/**
 * Inspects all provider configuration paths and validates the effective billing endpoint.
 * Enforces fail-closed rejection on regional processing, data-residency surcharges,
 * and unknown base URL overrides before provider dispatch.
 */
export function auditBillingEndpoint(params: {
  endpoint?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  providerId?: string | null;
  modelId?: string | null;
  pricingEngine?: PricingEngine | null;
}): EndpointAuditResult {
  const { endpoint, metadata, providerId, modelId, pricingEngine } = params;

  // 1. Inspect Request Metadata for Regional / Data-Residency Surcharge Flags
  if (
    metadata?.regional ||
    metadata?.data_residency ||
    metadata?.dataResidency ||
    metadata?.regional_processing ||
    metadata?.region
  ) {
    return {
      valid: false,
      errorReason:
        'Regional processing and data-residency billing surcharges are not currently supported by pricing engine; rejected fail-closed to prevent billing inaccuracy',
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
    };
  }

  // 2. If no endpoint URL specified, resolve default reference or standard provider
  if (!endpoint || endpoint.trim().length === 0) {
    const kind = resolveBillingEndpointKind(undefined, providerId);
    return {
      valid: true,
      endpointKind: kind,
      sanitizedEndpoint: 'internal:default',
    };
  }

  // Sanitize endpoint for error reporting (remove credentials/query tokens)
  const sanitizedEndpoint = sanitizeSecrets(endpoint.trim());

  // 3. Parse and validate URL structure
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint.trim());
  } catch {
    return {
      valid: false,
      errorReason: `Invalid endpoint URL '${sanitizedEndpoint}'; cannot determine authoritative billing endpoint`,
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      sanitizedEndpoint,
    };
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return {
      valid: false,
      errorReason: `Unsupported protocol '${parsedUrl.protocol}' for endpoint '${sanitizedEndpoint}'`,
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      sanitizedEndpoint,
    };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const search = parsedUrl.search.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();

  // 4. Regional Endpoint & Data-Residency URL Detection
  const hasRegionalQuery =
    search.includes('data_residency') ||
    search.includes('dataresidency') ||
    search.includes('regional') ||
    search.includes('region=') ||
    search.includes('geo=');

  const hasRegionalHost =
    (hostname.endsWith('.openai.com') && hostname !== 'api.openai.com') ||
    hostname.includes('regional.') ||
    hostname.includes('-geo.') ||
    hostname.includes('.azure.com') ||
    hostname.includes('cognitiveservices.azure.com');

  const hasRegionalPath =
    pathname.includes('/regional/') ||
    pathname.includes('/geo/') ||
    pathname.includes('/data-residency/');

  if (hasRegionalQuery || hasRegionalHost || hasRegionalPath) {
    return {
      valid: false,
      errorReason: `Regional endpoint '${sanitizedEndpoint}' may incur unsupported regional processing or data-residency surcharges; rejected fail-closed to prevent billing inaccuracy`,
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      sanitizedEndpoint,
    };
  }

  // 5. Unknown / Overridden Base URL Detection
  const effectiveProvider = (providerId ?? 'openai').toLowerCase();

  if (effectiveProvider === 'openai' || hostname.includes('openai')) {
    if (!STANDARD_OPENAI_HOSTS.has(hostname)) {
      // Overridden base URL (e.g. custom gateway, third-party proxy, or internal mirror)
      // Check whether PricingEngine has explicitly registered pricing for this overridden provider/host
      let hasCustomPricing = false;
      if (pricingEngine && modelId) {
        try {
          pricingEngine.getRate(hostname, modelId);
          hasCustomPricing = true;
        } catch {
          try {
            pricingEngine.getRate(effectiveProvider, modelId);
            // If registered under 'openai' but endpoint is an unknown external host,
            // we must not silently assume standard rates without host verification
            hasCustomPricing = false;
          } catch {
            hasCustomPricing = false;
          }
        }
      }

      if (!hasCustomPricing) {
        return {
          valid: false,
          errorReason: `Configured base URL '${parsedUrl.origin}' is not a verified standard provider host and has no registered endpoint pricing in PricingEngine; rejected fail-closed before dispatch`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedEndpoint,
        };
      }
    }
  } else if (effectiveProvider === 'anthropic' || hostname.includes('anthropic')) {
    if (!STANDARD_ANTHROPIC_HOSTS.has(hostname)) {
      let hasCustomPricing = false;
      if (pricingEngine && modelId) {
        try {
          pricingEngine.getRate(hostname, modelId);
          hasCustomPricing = true;
        } catch {
          hasCustomPricing = false;
        }
      }

      if (!hasCustomPricing) {
        return {
          valid: false,
          errorReason: `Configured base URL '${parsedUrl.origin}' is not a verified Anthropic host and has no registered endpoint pricing in PricingEngine; rejected fail-closed before dispatch`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedEndpoint,
        };
      }
    }
  }

  const endpointKind = resolveBillingEndpointKind(endpoint, providerId);

  return {
    valid: true,
    endpointKind,
    sanitizedEndpoint,
  };
}
