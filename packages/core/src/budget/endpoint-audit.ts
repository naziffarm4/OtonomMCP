/**
 * @file endpoint-audit.ts
 * @description Authoritative Endpoint-Specific Usage Contracts & Billing Endpoint Audit (OM-09C-FIX-5).
 *
 * Implements:
 * 1. Fail-closed unknown / custom endpoint audit:
 *    - Unknown hosts, custom providers (e.g. 'openai-compatible'), proxy hosts, and gateways
 *      require explicit, authoritative provider/host/model pricing in PricingEngine AND an explicit usage contract.
 *    - A model rate registered only under 'openai' or 'anthropic' NEVER authorizes an arbitrary proxy host.
 *    - Hostname spoofing (userinfo, alternate ports, suffix tricks, malformed URLs, non-http protocols)
 *      is strictly rejected fail-closed before dispatch.
 * 2. Authoritative Effective Endpoint Resolution:
 *    - Full traceability from configuration (request endpoint, base_url, adapter, transport, env)
 *      to the exact dispatch URL.
 *    - Distinguishes base URLs from full endpoint URLs.
 *    - Never infers /v1/chat/completions for custom endpoints without an explicit contract.
 *    - Detects and rejects conflicting configuration sources fail-closed.
 * 3. Secret sanitization: API keys, query tokens, and credentials in URLs are never exposed.
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
  readonly effectiveUrl: string;
  readonly effectiveHost?: string;
  readonly isCustomHost?: boolean;
  readonly separateReasoningTokens?: boolean;
}

export interface EndpointAuditFailure {
  readonly valid: false;
  readonly errorReason: string;
  readonly errorCode: BudgetErrorCode;
  readonly sanitizedEndpoint?: string;
}

export type EndpointAuditResult = EndpointAuditSuccess | EndpointAuditFailure;

/**
 * Standard, verified OpenAI hostnames.
 */
export const STANDARD_OPENAI_HOSTS = new Set([
  'api.openai.com',
]);

/**
 * Standard, verified Anthropic hostnames.
 */
export const STANDARD_ANTHROPIC_HOSTS = new Set([
  'api.anthropic.com',
]);

/**
 * Local / Reference test fixture hostnames.
 */
export const LOCAL_TEST_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  'test.local',
]);

/**
 * Explicit definition for a registered custom endpoint usage contract.
 */
export interface EndpointUsageContractDefinition {
  readonly endpointKind: BillingEndpointKind;
  readonly separateReasoningTokens?: boolean;
}

/**
 * Explicit registry for custom endpoint usage contracts.
 */
const REGISTERED_ENDPOINT_CONTRACTS = new Map<string, EndpointUsageContractDefinition>();

export function registerCustomEndpointContract(
  hostOrProvider: string,
  contractOrDefinition: BillingEndpointKind | EndpointUsageContractDefinition,
  options?: { separateReasoningTokens?: boolean }
): void {
  const key = hostOrProvider.trim().toLowerCase();
  if (typeof contractOrDefinition === 'string') {
    REGISTERED_ENDPOINT_CONTRACTS.set(key, {
      endpointKind: contractOrDefinition,
      separateReasoningTokens: options?.separateReasoningTokens ?? false,
    });
  } else {
    REGISTERED_ENDPOINT_CONTRACTS.set(key, {
      endpointKind: contractOrDefinition.endpointKind,
      separateReasoningTokens:
        contractOrDefinition.separateReasoningTokens ?? options?.separateReasoningTokens ?? false,
    });
  }
}

export function clearCustomEndpointContracts(): void {
  REGISTERED_ENDPOINT_CONTRACTS.clear();
}

export function getRegisteredEndpointContract(hostOrProvider: string): BillingEndpointKind | undefined {
  return REGISTERED_ENDPOINT_CONTRACTS.get(hostOrProvider.trim().toLowerCase())?.endpointKind;
}

export function getRegisteredEndpointContractDefinition(
  hostOrProvider: string
): EndpointUsageContractDefinition | undefined {
  return REGISTERED_ENDPOINT_CONTRACTS.get(hostOrProvider.trim().toLowerCase());
}

/**
 * Normalizes a raw usage contract string to its canonical BillingEndpointKind.
 */
export function parseUsageContractKind(contract?: string | null): BillingEndpointKind | undefined {
  if (!contract || contract.trim().length === 0) return undefined;
  const lower = contract.trim().toLowerCase();
  if (lower === 'openai_chat_completions' || lower === 'chat_completions' || lower === '/v1/chat/completions') {
    return 'openai_chat_completions';
  }
  if (lower === 'openai_responses' || lower === 'responses' || lower === '/v1/responses') {
    return 'openai_responses';
  }
  if (lower === 'anthropic_messages' || lower === 'messages' || lower === '/v1/messages') {
    return 'anthropic_messages';
  }
  if (lower === 'reference_adapter' || lower === 'reference') {
    return 'reference_adapter';
  }
  return undefined;
}

/**
 * Resolves the BillingEndpointKind from an endpoint URL, provider identifier, or explicit usage contract.
 */
export function resolveBillingEndpointKind(
  endpoint?: string | null,
  providerId?: string | null,
  usageContract?: string | null
): BillingEndpointKind {
  if (endpoint && endpoint.trim().length > 0 && endpoint !== 'internal:default') {
    try {
      const parsed = new URL(endpoint.trim());
      const hostname = parsed.hostname.toLowerCase();
      // Host-specific registered contract has highest authority for custom endpoints
      const regHost = REGISTERED_ENDPOINT_CONTRACTS.get(hostname);
      if (regHost) return regHost.endpointKind;

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
      const lower = endpoint.toLowerCase();
      if (lower.includes('/responses')) return 'openai_responses';
      if (lower.includes('/chat/completions')) return 'openai_chat_completions';
      if (lower.includes('/messages')) return 'anthropic_messages';
    }

    const parsedContract = parseUsageContractKind(usageContract);
    if (parsedContract) return parsedContract;

    return 'custom_endpoint';
  }

  const parsedContract = parseUsageContractKind(usageContract);
  if (parsedContract) return parsedContract;

  if (providerId) {
    const regProvider = REGISTERED_ENDPOINT_CONTRACTS.get(providerId.trim().toLowerCase());
    if (regProvider) return regProvider.endpointKind;
    if (providerId.toLowerCase().includes('anthropic')) return 'anthropic_messages';
    if (providerId.toLowerCase().includes('openai')) return 'openai_chat_completions';
  }

  return 'reference_adapter';
}

export interface ResolveEndpointParams {
  readonly requestEndpoint?: string | null;
  readonly requestBaseUrl?: string | null;
  readonly adapterEndpoint?: string | null;
  readonly transportEndpoint?: string | null;
  readonly envLlmEndpoint?: string | null;
  readonly envOpenAiBaseUrl?: string | null;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly usageContract?: string | null;
}

export interface ResolveEndpointSuccess {
  readonly success: true;
  readonly effectiveUrl: string;
  readonly isBaseUrl: boolean;
  readonly endpointKind: BillingEndpointKind;
  readonly sanitizedUrl: string;
}

export interface ResolveEndpointFailure {
  readonly success: false;
  readonly errorReason: string;
  readonly errorCode: BudgetErrorCode;
  readonly sanitizedUrl?: string;
}

export type ResolveEndpointResult = ResolveEndpointSuccess | ResolveEndpointFailure;

/**
 * Authoritatively resolves the effective endpoint used for dispatch across all configuration sources.
 * Validates consistency between endpoint and base_url, detects conflicting sources,
 * and performs strict path composition without guessing for unknown endpoints.
 */
export function resolveEffectiveBillingEndpoint(params: ResolveEndpointParams): ResolveEndpointResult {
  const {
    requestEndpoint,
    requestBaseUrl,
    adapterEndpoint,
    transportEndpoint,
    envLlmEndpoint,
    envOpenAiBaseUrl,
    providerId,
    usageContract,
  } = params;

  // 1. Check for conflicting explicit request sources
  if (requestEndpoint && requestBaseUrl) {
    try {
      const epUrl = new URL(requestEndpoint.trim());
      const buUrl = new URL(requestBaseUrl.trim());
      if (epUrl.origin !== buUrl.origin) {
        return {
          success: false,
          errorReason: `Conflicting endpoint configuration sources: request endpoint origin '${epUrl.origin}' differs from base_url origin '${buUrl.origin}'`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedUrl: sanitizeSecrets(requestEndpoint),
        };
      }
      const normBuPath = buUrl.pathname.replace(/\/+$/, '');
      if (normBuPath.length > 0 && normBuPath !== '/' && !epUrl.pathname.startsWith(normBuPath)) {
        return {
          success: false,
          errorReason: `Conflicting endpoint configuration sources: request endpoint path '${epUrl.pathname}' does not match base_url path '${buUrl.pathname}'`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedUrl: sanitizeSecrets(requestEndpoint),
        };
      }
    } catch {
      // Invalid URL syntax will be handled by auditBillingEndpoint
    }
  }

  // 2. Check for conflicting environment variables
  if (envLlmEndpoint && envOpenAiBaseUrl) {
    try {
      const u1 = new URL(envLlmEndpoint.trim());
      const u2 = new URL(envOpenAiBaseUrl.trim());
      if (u1.origin !== u2.origin) {
        return {
          success: false,
          errorReason: `Conflicting environment endpoint configurations: AIDM_LLM_ENDPOINT origin '${u1.origin}' differs from OPENAI_BASE_URL origin '${u2.origin}'`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedUrl: sanitizeSecrets(envLlmEndpoint),
        };
      }
    } catch {
      // Handled later
    }
  }

  // 3. Candidate raw endpoint selection (priority order)
  let rawUrl: string | undefined;
  let isExplicitBaseUrl = false;

  if (requestEndpoint && requestEndpoint.trim().length > 0) {
    rawUrl = requestEndpoint.trim();
    isExplicitBaseUrl = false;
  } else if (requestBaseUrl && requestBaseUrl.trim().length > 0) {
    rawUrl = requestBaseUrl.trim();
    isExplicitBaseUrl = true;
  } else if (adapterEndpoint && adapterEndpoint.trim().length > 0) {
    rawUrl = adapterEndpoint.trim();
  } else if (transportEndpoint && transportEndpoint.trim().length > 0) {
    rawUrl = transportEndpoint.trim();
  } else if (envLlmEndpoint && envLlmEndpoint.trim().length > 0) {
    rawUrl = envLlmEndpoint.trim();
  } else if (envOpenAiBaseUrl && envOpenAiBaseUrl.trim().length > 0) {
    rawUrl = envOpenAiBaseUrl.trim();
    isExplicitBaseUrl = true;
  } else {
    // Default provider endpoints
    const effProv = (providerId ?? '').toLowerCase();
    if (effProv === 'openai' || effProv.includes('openai')) {
      rawUrl = 'https://api.openai.com/v1/chat/completions';
    } else if (effProv === 'anthropic' || effProv.includes('anthropic')) {
      rawUrl = 'https://api.anthropic.com/v1/messages';
    } else {
      rawUrl = 'internal:default';
    }
  }

  const sanitizedUrl = sanitizeSecrets(rawUrl);

  if (rawUrl === 'internal:default') {
    return {
      success: true,
      effectiveUrl: 'internal:default',
      isBaseUrl: false,
      endpointKind: resolveBillingEndpointKind(rawUrl, providerId, usageContract),
      sanitizedUrl: 'internal:default',
    };
  }

  // 4. Parse candidate URL
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      success: false,
      errorReason: `Invalid endpoint URL '${sanitizedUrl}'; cannot determine authoritative billing endpoint`,
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      sanitizedUrl,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '');

  const isFullEndpointPath =
    pathname.endsWith('/chat/completions') ||
    pathname.endsWith('/responses') ||
    pathname.endsWith('/messages');

  const isBaseUrl = isExplicitBaseUrl || !isFullEndpointPath;
  let effectiveUrl = rawUrl;

  // 5. Path composition on Base URLs
  if (isBaseUrl) {
    if (STANDARD_OPENAI_HOSTS.has(hostname)) {
      const contract = usageContract?.toLowerCase() ?? 'openai_chat_completions';
      const targetAction = contract.includes('responses') ? '/responses' : '/chat/completions';
      if (pathname === '' || pathname === '/') {
        effectiveUrl = `${parsed.origin}/v1${targetAction}`;
      } else if (pathname === '/v1') {
        effectiveUrl = `${parsed.origin}/v1${targetAction}`;
      } else {
        effectiveUrl = `${parsed.origin}${pathname}${targetAction}`;
      }
    } else if (STANDARD_ANTHROPIC_HOSTS.has(hostname)) {
      if (pathname === '' || pathname === '/' || pathname === '/v1') {
        effectiveUrl = `${parsed.origin}/v1/messages`;
      } else {
        effectiveUrl = `${parsed.origin}${pathname}/messages`;
      }
    } else if (LOCAL_TEST_HOSTS.has(hostname)) {
      // Local test fixtures: compose standard OpenAI action if pathname ends in /v1 or empty
      const contract = usageContract?.toLowerCase() ?? 'openai_chat_completions';
      const targetAction = contract.includes('responses')
        ? '/responses'
        : contract.includes('messages')
          ? '/messages'
          : '/chat/completions';
      if (pathname === '' || pathname === '/') {
        effectiveUrl = `${parsed.origin}/v1${targetAction}`;
      } else if (pathname === '/v1') {
        effectiveUrl = `${parsed.origin}/v1${targetAction}`;
      } else {
        effectiveUrl = `${parsed.origin}${pathname}${targetAction}`;
      }
    } else {
      // Custom Host / Gateway / Proxy:
      // Invariant: Never infer /v1/chat/completions solely because endpoint resolution failed or returned custom_endpoint.
      // Must require an explicit registered host-specific contract.
      // A provider-wide contract or request-supplied metadata must not, by itself, establish trusted host authorization.
      const registeredHostEntry = REGISTERED_ENDPOINT_CONTRACTS.get(hostname);

      if (!registeredHostEntry) {
        return {
          success: false,
          errorReason: `Cannot resolve effective endpoint for custom host '${hostname}': base URL provided without a registered host-specific usage contract; provider-level contracts or metadata cannot authorize custom hosts; refusing to infer /v1/chat/completions fail-closed`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedUrl: sanitizeSecrets(effectiveUrl),
        };
      }

      const registeredHostContract = registeredHostEntry.endpointKind;

      // If caller requested a schema, verify consistency
      if (usageContract && usageContract.trim().length > 0) {
        const requestedKind = parseUsageContractKind(usageContract);
        if (requestedKind && requestedKind !== registeredHostContract) {
          return {
            success: false,
            errorReason: `Requested usage contract '${usageContract}' conflicts with registered host contract '${registeredHostContract}' for host '${hostname}'`,
            errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
            sanitizedUrl: sanitizeSecrets(effectiveUrl),
          };
        }
      }

      const targetAction = registeredHostContract === 'openai_responses'
        ? '/responses'
        : registeredHostContract === 'anthropic_messages'
          ? '/messages'
          : '/chat/completions';

      if (pathname === '' || pathname === '/') {
        effectiveUrl = `${parsed.origin}/v1${targetAction}`;
      } else if (pathname === '/v1') {
        effectiveUrl = `${parsed.origin}/v1${targetAction}`;
      } else {
        effectiveUrl = `${parsed.origin}${pathname}${targetAction}`;
      }
    }
  }

  let endpointKind: BillingEndpointKind;
  const isStandardOrLocal =
    STANDARD_OPENAI_HOSTS.has(hostname) ||
    STANDARD_ANTHROPIC_HOSTS.has(hostname) ||
    LOCAL_TEST_HOSTS.has(hostname);

  if (!isStandardOrLocal && REGISTERED_ENDPOINT_CONTRACTS.has(hostname)) {
    endpointKind = REGISTERED_ENDPOINT_CONTRACTS.get(hostname)!.endpointKind;
  } else {
    endpointKind = resolveBillingEndpointKind(effectiveUrl, providerId, usageContract);
  }

  return {
    success: true,
    effectiveUrl,
    isBaseUrl,
    endpointKind,
    sanitizedUrl: sanitizeSecrets(effectiveUrl),
  };
}

/**
 * Inspects all provider configuration paths and validates the effective billing endpoint.
 * Enforces fail-closed rejection on:
 * - Regional processing and data-residency surcharges
 * - Hostname spoofing (userinfo, alternate ports, suffix tricks, malformed URLs, non-http protocols)
 * - Unknown providers (e.g. 'openai-compatible') and custom hosts without explicit host/provider pricing and explicit usage contracts.
 */
export function auditBillingEndpoint(params: {
  endpoint?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  providerId?: string | null;
  modelId?: string | null;
  pricingEngine?: PricingEngine | null;
  usageContract?: string | null;
}): EndpointAuditResult {
  const { endpoint, metadata, providerId, modelId, pricingEngine, usageContract } = params;

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

  // 2. If no endpoint URL specified or internal default
  if (!endpoint || endpoint.trim().length === 0 || endpoint === 'internal:default') {
    const kind = resolveBillingEndpointKind(undefined, providerId, usageContract);
    return {
      valid: true,
      endpointKind: kind,
      sanitizedEndpoint: 'internal:default',
      effectiveUrl: 'internal:default',
      isCustomHost: false,
      separateReasoningTokens: false,
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

  // Protocol validation: only http: and https: are allowed
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return {
      valid: false,
      errorReason: `Unsupported protocol '${parsedUrl.protocol}' for endpoint '${sanitizedEndpoint}'`,
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      sanitizedEndpoint,
    };
  }

  // User-Info Spoofing check: credentials in authority are strictly forbidden
  if (parsedUrl.username || parsedUrl.password) {
    return {
      valid: false,
      errorReason: `Endpoint URL '${sanitizedEndpoint}' contains userinfo in authority; rejected fail-closed to prevent credential spoofing`,
      errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
      sanitizedEndpoint,
    };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const search = parsedUrl.search.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();

  // Port Spoofing check: standard cloud provider endpoints must not use arbitrary ports
  if (STANDARD_OPENAI_HOSTS.has(hostname) || STANDARD_ANTHROPIC_HOSTS.has(hostname)) {
    const port = parsedUrl.port;
    if (port && port !== '443' && !(parsedUrl.protocol === 'http:' && port === '80')) {
      return {
        valid: false,
        errorReason: `Non-standard port '${port}' specified for standard provider host '${hostname}'; rejected fail-closed to prevent endpoint spoofing`,
        errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
        sanitizedEndpoint,
      };
    }
  }

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

  // 5. Hostname & Provider Authorization
  const effectiveProvider = (providerId ?? 'openai').toLowerCase();
  const isStandardOpenAi = STANDARD_OPENAI_HOSTS.has(hostname) && (effectiveProvider === 'openai' || effectiveProvider === 'reference-llm');
  const isStandardAnthropic = STANDARD_ANTHROPIC_HOSTS.has(hostname) && effectiveProvider === 'anthropic';
  const isLocalFixture = LOCAL_TEST_HOSTS.has(hostname);

  // If NOT standard OpenAI, NOT standard Anthropic, and NOT local fixture -> CUSTOM / UNKNOWN ENDPOINT
  if (!isStandardOpenAi && !isStandardAnthropic && !isLocalFixture) {
    // Check 5a: Authoritative Host-Scoped Pricing Registration
    // A model rate registered only under a generic providerId (e.g. 'openai', 'anthropic', 'openai-compatible')
    // must NEVER authorize a custom endpoint/host!
    // The pricing engine MUST have a rate explicitly registered for the hostname.
    let hasHostPricing = false;
    if (pricingEngine && modelId) {
      try {
        pricingEngine.getRate(hostname, modelId);
        hasHostPricing = true;
      } catch {
        hasHostPricing = false;
      }
    }

    if (!hasHostPricing) {
      return {
        valid: false,
        errorReason: `Endpoint host '${hostname}' is not a verified standard provider host and has no registered host-scoped pricing in PricingEngine for model '${modelId ?? 'unknown'}'; generic provider pricing cannot authorize arbitrary hosts; rejected fail-closed before dispatch`,
        errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
        sanitizedEndpoint,
      };
    }

    // Check 5b: Authoritative Host-Scoped Usage Contract Authorization
    // Requirement: Require an explicit usage contract bound to the hostname.
    // A provider-wide contract or request-supplied metadata must NOT, by itself, establish trusted host authorization.
    const registeredHostEntry = REGISTERED_ENDPOINT_CONTRACTS.get(hostname);

    if (!registeredHostEntry) {
      return {
        valid: false,
        errorReason: `Custom endpoint host '${hostname}' has no host-specific registered usage contract (no registered usage contract bound to host); provider-level contracts or request metadata cannot authorize custom endpoints without a registered host contract; rejected fail-closed`,
        errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
        sanitizedEndpoint,
      };
    }

    const registeredHostContract = registeredHostEntry.endpointKind;
    const separateReasoningTokens = registeredHostEntry.separateReasoningTokens === true;

    // Treat caller-supplied usageContract or metadata.usage_contract as requested schema, and verify consistency
    const rawRequestedContract =
      usageContract ??
      (metadata?.usage_contract as string | undefined) ??
      (metadata?.usageContract as string | undefined);

    if (rawRequestedContract && rawRequestedContract.trim().length > 0) {
      const requestedKind = parseUsageContractKind(rawRequestedContract);
      if (requestedKind && requestedKind !== registeredHostContract) {
        return {
          valid: false,
          errorReason: `Requested usage contract '${rawRequestedContract}' conflicts with registered host contract '${registeredHostContract}' for host '${hostname}'; rejected fail-closed`,
          errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
          sanitizedEndpoint,
        };
      }
    }

    // Verify consistency with URL path if path implies a known schema
    let pathKind: BillingEndpointKind | undefined;
    if (pathname.endsWith('/responses') || pathname.endsWith('/v1/responses')) {
      pathKind = 'openai_responses';
    } else if (pathname.endsWith('/chat/completions') || pathname.endsWith('/v1/chat/completions')) {
      pathKind = 'openai_chat_completions';
    } else if (pathname.endsWith('/messages') || pathname.endsWith('/v1/messages')) {
      pathKind = 'anthropic_messages';
    }

    if (pathKind && pathKind !== registeredHostContract) {
      return {
        valid: false,
        errorReason: `Endpoint URL path '${parsedUrl.pathname}' indicates '${pathKind}' which conflicts with registered host usage contract '${registeredHostContract}' for host '${hostname}'; rejected fail-closed`,
        errorCode: 'ERR_UNSUPPORTED_BILLING_MODE',
        sanitizedEndpoint,
      };
    }

    return {
      valid: true,
      endpointKind: registeredHostContract,
      sanitizedEndpoint,
      effectiveUrl: endpoint.trim(),
      effectiveHost: hostname,
      isCustomHost: true,
      separateReasoningTokens,
    };
  }

  const endpointKind = resolveBillingEndpointKind(
    endpoint,
    providerId,
    usageContract ?? (metadata?.usage_contract as string | undefined)
  );

  return {
    valid: true,
    endpointKind,
    sanitizedEndpoint,
    effectiveUrl: endpoint.trim(),
    effectiveHost: hostname,
    isCustomHost: false,
    separateReasoningTokens: false,
  };
}
