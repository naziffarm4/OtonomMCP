/**
 * @file idp-client.ts
 * @description HTTP client for the external IdP API (docs/EXTERNAL-IDP-CONTRACT.md) plus the
 * contract-level token checks that complement OidcIdentityProviderAdapter (requestId/decisionId,
 * decision, amr=webauthn, uv=true, short lifetime, nonce echo, exact binding).
 */

import * as crypto from 'node:crypto';
import type { ITrustedIdentityProvider, TrustedApprovalBinding } from '../authorization/trusted-identity-types.js';
import { resolveTrustedIdentityConfig } from '../authorization/trusted-identity-config.js';

type Env = Readonly<Record<string, string | undefined>>;

/** True when an external IdP is configured for verification AND API access (AIDM_IDP_* + client token). */
export function isExternalIdpConfigured(env: Env = process.env): boolean {
  const c = resolveTrustedIdentityConfig(env);
  return c.configured && Boolean(env.AIDM_IDP_CLIENT_TOKEN?.trim());
}

export class IdpClientError extends Error {
  readonly code: string;
  constructor(message: string, code = 'IDP_REQUEST_FAILED') {
    super(message);
    this.name = 'IdpClientError';
    this.code = code;
  }
}

export interface IdpStatusResponse {
  readonly status: string;
  readonly token?: string;
  readonly reason?: string;
  readonly [k: string]: unknown;
}

export class IdpClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { env?: Env; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    const env = options.env ?? process.env;
    const cfg = resolveTrustedIdentityConfig(env);
    const token = env.AIDM_IDP_CLIENT_TOKEN?.trim();
    if (!token) {
      throw new IdpClientError('AIDM_IDP_CLIENT_TOKEN is not set; cannot talk to the external IdP.', 'IDP_NOT_CONFIGURED');
    }
    let parsed: URL;
    try {
      parsed = new URL(cfg.idpUrl);
    } catch {
      throw new IdpClientError('AIDM_IDP_URL is not a valid URL.', 'IDP_NOT_CONFIGURED');
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new IdpClientError('AIDM_IDP_URL must use https (http only for 127.0.0.1/localhost).', 'IDP_NOT_CONFIGURED');
    }
    if (parsed.username || parsed.password) {
      throw new IdpClientError('AIDM_IDP_URL must not embed credentials.', 'IDP_NOT_CONFIGURED');
    }
    this.baseUrl = cfg.idpUrl;
    this.token = token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${p}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new IdpClientError(`IdP unreachable: ${err instanceof Error ? err.message : String(err)}`, 'IDP_UNREACHABLE');
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  async createApprovalRequest(body: Record<string, unknown>): Promise<{ approvalUrl?: string; status: string }> {
    const r = await this.call('POST', '/api/approval-requests', body);
    if (r.status !== 201 && r.status !== 200) {
      throw new IdpClientError(`IdP rejected approval request (HTTP ${r.status}).`, 'IDP_REQUEST_REJECTED');
    }
    return { approvalUrl: typeof r.json.approvalUrl === 'string' ? r.json.approvalUrl : undefined, status: String(r.json.status ?? 'PENDING') };
  }

  async getApprovalRequest(requestId: string): Promise<IdpStatusResponse> {
    const r = await this.call('GET', `/api/approval-requests/${encodeURIComponent(requestId)}`);
    if (r.status !== 200) throw new IdpClientError(`IdP status lookup failed (HTTP ${r.status}).`, 'IDP_STATUS_FAILED');
    return r.json as IdpStatusResponse;
  }

  async createDecisionRequest(body: Record<string, unknown>): Promise<{ decisionUrl?: string; status: string }> {
    const r = await this.call('POST', '/api/decision-requests', body);
    if (r.status !== 201 && r.status !== 200) {
      throw new IdpClientError(`IdP rejected decision request (HTTP ${r.status}).`, 'IDP_REQUEST_REJECTED');
    }
    return { decisionUrl: typeof r.json.decisionUrl === 'string' ? r.json.decisionUrl : undefined, status: String(r.json.status ?? 'PENDING') };
  }

  async getDecisionRequest(decisionId: string): Promise<IdpStatusResponse> {
    const r = await this.call('GET', `/api/decision-requests/${encodeURIComponent(decisionId)}`);
    if (r.status !== 200) throw new IdpClientError(`IdP status lookup failed (HTTP ${r.status}).`, 'IDP_STATUS_FAILED');
    return r.json as IdpStatusResponse;
  }
}

/** Canonical JSON (sorted keys) used for binding fingerprints. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

export interface TokenCheckResult {
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Contract checks that only make sense AFTER the adapter verified the signature. Never call on an
 * unverified token.
 */
export function checkContractClaims(
  payload: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
  opts: { maxLifetimeSec?: number } = {}
): TokenCheckResult {
  const fail = (status: string, reason: string): TokenCheckResult => ({ ok: false, status, reason });
  if (payload.actorRole !== 'PRODUCT_OWNER') return fail('UNVERIFIED', 'Token actorRole must be PRODUCT_OWNER.');
  if (!Array.isArray(payload.amr) || !payload.amr.includes('webauthn')) return fail('UNVERIFIED', "Token amr must include 'webauthn'.");
  if (payload.uv !== true) return fail('UNVERIFIED', 'Token must assert WebAuthn user verification (uv=true).');
  if (typeof payload.jti !== 'string' || payload.jti.length < 8) return fail('UNVERIFIED', 'Token jti missing.');
  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp - iat > (opts.maxLifetimeSec ?? 300) || exp <= iat) {
    return fail('UNVERIFIED', `Token lifetime must be positive and at most ${opts.maxLifetimeSec ?? 300} seconds.`);
  }
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined || v === null) {
      if (payload[k] !== undefined && payload[k] !== null) return fail('BINDING_MISMATCH', `Unexpected claim '${k}'.`);
      continue;
    }
    if (payload[k] !== v) return fail('BINDING_MISMATCH', `Claim '${k}' does not match the pending request.`);
  }
  return { ok: true, status: 'VERIFIED', payload };
}

/**
 * Full verification: adapter (signature, iss/aud/exp/nbf/iat, nonce replay, binding) then contract
 * claims. `consumeNonce=false` runs the adapter in dry-run mode (nonce is consumed later by the
 * mandate store's own validation, which re-verifies the same token).
 */
export async function verifyIdpToken(
  provider: ITrustedIdentityProvider,
  token: string,
  binding: TrustedApprovalBinding,
  expectedClaims: Readonly<Record<string, unknown>>,
  options: { consumeNonce: boolean; maxLifetimeSec?: number }
): Promise<TokenCheckResult> {
  if (!provider.isConfigured()) {
    return { ok: false, status: 'CONFIG_MISSING', reason: 'No external IdP configured (AIDM_IDP_*).' };
  }
  const res = await provider.verifyAssertion(
    { token, binding, authSource: 'EXTERNAL_IDP' } as never,
    binding,
    { dryRun: !options.consumeNonce }
  );
  if (!res.isValid || !res.isTrustedHumanAuth) {
    return { ok: false, status: String(res.status ?? 'UNVERIFIED'), reason: res.reason };
  }
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwtPayload(token);
  } catch {
    return { ok: false, status: 'UNVERIFIED', reason: 'Malformed token payload.' };
  }
  return checkContractClaims(payload, expectedClaims, { maxLifetimeSec: options.maxLifetimeSec });
}
