/**
 * @file trusted-identity-config.ts
 * @description Single factory that builds the external Trusted Identity Provider (ADR-13 / P18-04)
 * from environment configuration. Every AuthContextValidator / HumanApprovalEngine uses it, so an
 * operator-configured IdP is honored at all approval gates.
 *
 * Env (names only; values are never logged):
 *   AIDM_IDP_ISSUER            expected `iss` (default 'otonommcp-external-idp')
 *   AIDM_IDP_AUDIENCE          expected `aud` (default 'otonommcp'; comma separated for several)
 *   AIDM_IDP_PUBLIC_KEY_PEM    pinned SPKI public key (PEM text, `\n` escapes allowed)
 *   AIDM_IDP_PUBLIC_KEY_FILE   path to a pinned SPKI PEM file (preferred for localhost)
 *   AIDM_IDP_JWKS_URL          JWKS URL (https + SSRF rules of the adapter)
 *   AIDM_IDP_ALLOW_LOOPBACK_JWKS=1  explicit opt-in: allow http(s)://127.0.0.1|localhost JWKS only
 *
 * No key source configured => UnconfiguredIdentityProviderAdapter (exactly the previous behavior).
 * Partially / invalidly configured => MisconfiguredIdentityProviderAdapter (fail-closed; it reports
 * isConfigured()=true so local signatures are never promoted to human proof while misconfigured).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type {
  ITrustedIdentityProvider,
  IdentityVerificationResult,
  TrustedApprovalBinding,
  TrustedIdentityAssertion,
  TrustedIdentityProviderType,
  TrustedProviderHealth,
} from './trusted-identity-types.js';
import { OidcIdentityProviderAdapter, UnconfiguredIdentityProviderAdapter } from './trusted-identity-adapters.js';
import type { NonceStore } from './nonce-store.js';

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_IDP_ISSUER = 'otonommcp-external-idp';
export const DEFAULT_IDP_AUDIENCE = 'otonommcp';
export const DEFAULT_IDP_URL = 'http://127.0.0.1:7443';

export interface TrustedIdentityConfig {
  /** True when a key source is configured (PEM, PEM file or JWKS URL). */
  readonly configured: boolean;
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly publicKeyPem?: string;
  readonly jwksUrl?: string;
  readonly allowLoopbackJwks: boolean;
  readonly idpUrl: string;
  readonly hasClientToken: boolean;
  /** Set when configuration is present but invalid; the provider then fails closed. */
  readonly error?: string;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function resolveTrustedIdentityConfig(env: Env = process.env): TrustedIdentityConfig {
  const issuer = nonEmpty(env.AIDM_IDP_ISSUER) ?? DEFAULT_IDP_ISSUER;
  const audience = (nonEmpty(env.AIDM_IDP_AUDIENCE) ?? DEFAULT_IDP_AUDIENCE)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const idpUrl = (nonEmpty(env.AIDM_IDP_URL) ?? DEFAULT_IDP_URL).replace(/\/+$/, '');
  const allowLoopbackJwks = env.AIDM_IDP_ALLOW_LOOPBACK_JWKS === '1';
  const hasClientToken = Boolean(nonEmpty(env.AIDM_IDP_CLIENT_TOKEN));
  const base = { issuer, audience, idpUrl, allowLoopbackJwks, hasClientToken };

  const pemInline = nonEmpty(env.AIDM_IDP_PUBLIC_KEY_PEM);
  const pemFile = nonEmpty(env.AIDM_IDP_PUBLIC_KEY_FILE);
  const jwksUrl = nonEmpty(env.AIDM_IDP_JWKS_URL);

  if (!pemInline && !pemFile && !jwksUrl) {
    return { ...base, configured: false };
  }
  if ([pemInline, pemFile, jwksUrl].filter(Boolean).length > 1) {
    return {
      ...base,
      configured: true,
      error: 'Configure exactly one of AIDM_IDP_PUBLIC_KEY_PEM, AIDM_IDP_PUBLIC_KEY_FILE or AIDM_IDP_JWKS_URL.',
    };
  }

  if (pemInline || pemFile) {
    let pem: string;
    try {
      pem = pemInline ? pemInline.replace(/\\n/g, '\n') : fs.readFileSync(pemFile!, 'utf8');
    } catch {
      return { ...base, configured: true, error: 'AIDM_IDP_PUBLIC_KEY_FILE cannot be read.' };
    }
    try {
      const key = crypto.createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ec' && key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ed25519') {
        return { ...base, configured: true, error: `Unsupported IdP public key type '${key.asymmetricKeyType}'.` };
      }
    } catch {
      return { ...base, configured: true, error: 'IdP public key is not a valid SPKI PEM public key.' };
    }
    return { ...base, configured: true, publicKeyPem: pem };
  }

  let parsed: URL;
  try {
    parsed = new URL(jwksUrl!);
  } catch {
    return { ...base, configured: true, error: 'AIDM_IDP_JWKS_URL is not a valid URL.' };
  }
  if (isLoopbackHost(parsed.hostname) && !allowLoopbackJwks) {
    return {
      ...base,
      configured: true,
      error: 'Loopback AIDM_IDP_JWKS_URL requires AIDM_IDP_ALLOW_LOOPBACK_JWKS=1 (or pin the key with AIDM_IDP_PUBLIC_KEY_FILE).',
    };
  }
  return { ...base, configured: true, jwksUrl: jwksUrl! };
}

/** Fail-closed provider used when IdP configuration is present but invalid. */
export class MisconfiguredIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly providerId = 'misconfigured-external-idp';
  readonly providerType: TrustedIdentityProviderType = 'OIDC';
  constructor(private readonly reason: string) {}
  isConfigured(): boolean {
    return true;
  }
  async getHealth(): Promise<TrustedProviderHealth> {
    return {
      isHealthy: false,
      isConfigured: true,
      providerId: this.providerId,
      providerType: this.providerType,
      message: `External IdP misconfigured: ${this.reason}`,
    };
  }
  async verifyAssertion(
    _a: TrustedIdentityAssertion,
    _b: TrustedApprovalBinding,
    _o?: { dryRun?: boolean }
  ): Promise<IdentityVerificationResult> {
    return {
      isValid: false,
      isTrustedHumanAuth: false,
      status: 'CONFIG_MISSING',
      code: 'BLOCKED_ON_AUTH_CONTEXT',
      reason: `External IdP misconfigured: ${this.reason} (fail-closed).`,
    };
  }
}

const RAW_SIG_LEN: Record<string, number> = { ES256: 64, ES384: 96, ES512: 132 };

/**
 * Signature verifier for an explicitly opted-in loopback JWKS (localhost IdP). Fetches the JWKS
 * from exactly the configured URL (no redirects), matches by kid, and verifies ES/EdDSA/RS family signatures.
 */
function createLoopbackJwksVerifier(
  jwksUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): (token: string) => Promise<boolean> {
  let cache: { at: number; keys: Array<Record<string, unknown>> } | null = null;
  return async (token: string) => {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    if (!header.alg || header.alg === 'none' || header.alg.startsWith('HS')) return false;
    if (!cache || Date.now() - cache.at > 5 * 60_000) {
      const res = await fetchFn(jwksUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) throw new Error(`JWKS fetch returned HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('JWKS has no keys');
      cache = { at: Date.now(), keys: body.keys };
    }
    const jwk = header.kid ? cache.keys.find((k) => k.kid === header.kid) : cache.keys.length === 1 ? cache.keys[0] : undefined;
    if (!jwk) return false;
    if (typeof jwk.alg === 'string' && jwk.alg !== header.alg) return false;
    if (header.alg.startsWith('ES') && jwk.kty !== 'EC') return false;
    if (header.alg.startsWith('RS') && jwk.kty !== 'RSA') return false;
    const key = crypto.createPublicKey({ key: jwk as never, format: 'jwk' });
    return verifyJwsSignature(header.alg, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  };
}

/** JWS signature verification (ES* signatures are raw R||S per RFC 7518; DER accepted for compatibility). */
export function verifyJwsSignature(alg: string, data: Buffer, key: crypto.KeyLike, sig: Buffer): boolean {
  const hash: Record<string, string | null> = {
    RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512',
    ES256: 'sha256', ES384: 'sha384', ES512: 'sha512', EdDSA: null,
  };
  if (!(alg in hash)) return false;
  if (alg.startsWith('ES') && sig.length === RAW_SIG_LEN[alg]) {
    return crypto.verify(hash[alg], data, { key: key as crypto.KeyObject, dsaEncoding: 'ieee-p1363' } as crypto.VerifyKeyObjectInput, sig);
  }
  return crypto.verify(hash[alg], data, key, sig);
}

export interface CreateTrustedIdentityProviderOptions {
  readonly env?: Env;
  readonly nonceStore?: NonceStore;
  readonly fetchFn?: typeof fetch;
}

/** The one factory for the external IdP adapter (see file header). */
export function createTrustedIdentityProvider(options: CreateTrustedIdentityProviderOptions = {}): ITrustedIdentityProvider {
  const cfg = resolveTrustedIdentityConfig(options.env ?? process.env);
  if (!cfg.configured) return new UnconfiguredIdentityProviderAdapter();
  if (cfg.error) return new MisconfiguredIdentityProviderAdapter(cfg.error);
  const audience = cfg.audience.length === 1 ? cfg.audience[0] : cfg.audience;
  if (cfg.publicKeyPem) {
    return new OidcIdentityProviderAdapter({
      providerId: 'external-idp-pinned-key',
      issuer: cfg.issuer,
      audience,
      publicKeyPem: cfg.publicKeyPem,
      nonceStore: options.nonceStore,
    });
  }
  const url = new URL(cfg.jwksUrl!);
  if (isLoopbackHost(url.hostname)) {
    // Explicit operator opt-in (checked in resolve): bypass the adapter's SSRF DNS rules only for loopback.
    return new OidcIdentityProviderAdapter({
      providerId: 'external-idp-loopback-jwks',
      issuer: cfg.issuer,
      audience,
      jwksUri: cfg.jwksUrl,
      nonceStore: options.nonceStore,
      verifySignatureFn: createLoopbackJwksVerifier(cfg.jwksUrl!, options.fetchFn ?? fetch, 5000),
    });
  }
  return new OidcIdentityProviderAdapter({
    providerId: 'external-idp-jwks',
    issuer: cfg.issuer,
    audience,
    jwksUri: cfg.jwksUrl,
    nonceStore: options.nonceStore,
  });
}
