/**
 * @file trusted-identity-adapters.ts
 * @description P18-04 Trusted Identity Provider Adapters.
 *
 * Implements concrete adapters adhering to ITrustedIdentityProvider:
 * 1. UnconfiguredIdentityProviderAdapter: Fail-closed fallback when no external IdP is configured.
 * 2. OidcIdentityProviderAdapter: OpenID Connect token validation with JWKS/claims verification.
 * 3. MtlsIdentityProviderAdapter: Mutual TLS X.509 client certificate verification.
 * 4. TestDoubleIdentityProviderAdapter: Explicit test double for testing adapter mechanics.
 */

import * as crypto from 'node:crypto';
import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import {
  type ITrustedIdentityProvider,
  type TrustedIdentityProviderType,
  type TrustedProviderHealth,
  type TrustedIdentityAssertion,
  type TrustedApprovalBinding,
  type IdentityVerificationResult,
  type TrustedIdentityClaim,
  TrustedIdentityAssertionSchema,
} from './trusted-identity-types.js';
import { NonceStore } from './nonce-store.js';
import { maskToken, sanitizeForAudit } from './trusted-identity-sanitizer.js';

// ============================================================================
// 1. UNCONFIGURED IDENTITY PROVIDER ADAPTER (DEFAULT FAIL-CLOSED)
// ============================================================================

/**
 * Default adapter used when no external IdP credentials/endpoints are provisioned.
 * Guarantees strict fail-closed behavior across all approval operations.
 */
export class UnconfiguredIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly providerId = 'unconfigured-default-provider';
  readonly providerType: TrustedIdentityProviderType = 'UNCONFIGURED';

  isConfigured(): boolean {
    return false;
  }

  async getHealth(): Promise<TrustedProviderHealth> {
    return {
      isHealthy: false,
      isConfigured: false,
      providerId: this.providerId,
      providerType: this.providerType,
      message: 'No external Trusted Identity Provider is configured. System is operating in FAIL-CLOSED mode.',
    };
  }

  async verifyAssertion(
    _assertion: TrustedIdentityAssertion,
    _expectedBinding: TrustedApprovalBinding,
    _options?: { dryRun?: boolean }
  ): Promise<IdentityVerificationResult> {
    return {
      isValid: false,
      isTrustedHumanAuth: false,
      status: 'CONFIG_MISSING',
      code: 'BLOCKED_ON_AUTH_CONTEXT',
      reason:
        'Trusted Identity Provider is not configured (P18-04 boundary). Approvals cannot be verified without a configured external IdP. Operation remains BLOCKED_ON_AUTH_CONTEXT.',
      details: {
        providerId: this.providerId,
        providerType: this.providerType,
        isConfigured: false,
      },
    };
  }
}

// ============================================================================
// 2. OIDC IDENTITY PROVIDER ADAPTER
// ============================================================================

export const DEFAULT_ALLOWED_OIDC_ALGORITHMS: readonly string[] = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

export interface OidcIdentityProviderOptions {
  readonly providerId?: string;
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly jwksUri?: string;
  readonly publicKeyPem?: string;
  readonly allowedAlgorithms?: readonly string[];
  readonly nonceStore?: NonceStore;
  readonly clockSkewSeconds?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchJwksFn?: (uri: string, options?: { signal?: AbortSignal }) => Promise<{ keys: unknown[] }>;
  readonly dnsLookupFn?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  readonly verifySignatureFn?: (token: string, keyOrJwks?: string) => Promise<boolean> | boolean;
  readonly isOutage?: boolean;
}

/**
 * CIDR definitions for forbidden IP ranges.
 */
export interface IpCidrRange {
  readonly prefix: string;
  readonly length: number;
  readonly description: string;
}

export const FORBIDDEN_IPV4_RANGES: readonly IpCidrRange[] = [
  { prefix: '0.0.0.0', length: 8, description: 'Current network (RFC 1122)' },
  { prefix: '10.0.0.0', length: 8, description: 'Private-Use (RFC 1918)' },
  { prefix: '100.64.0.0', length: 10, description: 'Shared Address Space / CGNAT (RFC 6598)' },
  { prefix: '127.0.0.0', length: 8, description: 'Loopback (RFC 1122)' },
  { prefix: '169.254.0.0', length: 16, description: 'Link-Local / Cloud Metadata (RFC 3927)' },
  { prefix: '172.16.0.0', length: 12, description: 'Private-Use (RFC 1918)' },
  { prefix: '192.0.0.0', length: 24, description: 'IETF Protocol Assignments (RFC 6890)' },
  { prefix: '192.0.2.0', length: 24, description: 'TEST-NET-1 Documentation (RFC 5737)' },
  { prefix: '192.88.99.0', length: 24, description: '6to4 Relay Anycast (RFC 7526)' },
  { prefix: '192.168.0.0', length: 16, description: 'Private-Use (RFC 1918)' },
  { prefix: '198.18.0.0', length: 15, description: 'Benchmarking (RFC 2544)' },
  { prefix: '198.51.100.0', length: 24, description: 'TEST-NET-2 Documentation (RFC 5737)' },
  { prefix: '203.0.113.0', length: 24, description: 'TEST-NET-3 Documentation (RFC 5737)' },
  { prefix: '224.0.0.0', length: 4, description: 'Multicast (RFC 5771)' },
  { prefix: '240.0.0.0', length: 4, description: 'Reserved for Future Use / Class E (RFC 1112)' },
  { prefix: '255.255.255.255', length: 32, description: 'Limited Broadcast (RFC 919)' },
] as const;

export const FORBIDDEN_IPV6_RANGES: readonly IpCidrRange[] = [
  { prefix: '::', length: 128, description: 'Unspecified address (RFC 4291)' },
  { prefix: '::1', length: 128, description: 'Loopback address (RFC 4291)' },
  { prefix: '100::', length: 64, description: 'Discard-only prefix (RFC 6666)' },
  { prefix: '2001:2::', length: 48, description: 'Benchmarking (RFC 5180)' },
  { prefix: '2001:db8::', length: 32, description: 'Documentation (RFC 3849)' },
  { prefix: '2001:20::', length: 28, description: 'ORCHIDv2 (RFC 7343)' },
  { prefix: '64:ff9b:1::', length: 48, description: 'Local-Use IPv4/IPv6 translation (RFC 8215)' },
  { prefix: 'fc00::', length: 7, description: 'Unique Local Unicast (ULA, RFC 4193)' },
  { prefix: 'fe80::', length: 10, description: 'Link-Local Unicast (RFC 4291)' },
  { prefix: 'fec0::', length: 10, description: 'Site-Local Unicast (deprecated, RFC 3879)' },
  { prefix: 'ff00::', length: 8, description: 'Multicast (RFC 4291)' },
] as const;

/**
 * Parses an IPv4 dotted decimal string into an unsigned 32-bit integer.
 * Returns null if invalid or not standard 4 octets.
 */
export function ipV4ToNumber(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (isNaN(n) || n < 0 || n > 255) return null;
    if (part.length > 1 && part.startsWith('0')) return null; // Reject octal leading zeros
    nums.push(n);
  }
  return ((nums[0] << 24) >>> 0) + ((nums[1] << 16) | (nums[2] << 8) | nums[3]);
}

/**
 * Checks whether an IPv4 address (as 32-bit number) falls into any forbidden range.
 */
export function isForbiddenIpv4(ipNum: number): boolean {
  for (const range of FORBIDDEN_IPV4_RANGES) {
    const prefixNum = ipV4ToNumber(range.prefix);
    if (prefixNum === null) continue;
    const mask = range.length === 0 ? 0 : (~0 << (32 - range.length)) >>> 0;
    if ((ipNum & mask) === (prefixNum & mask)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses an IPv6 string into a canonical 128-bit BigInt.
 * Handles alternative representations, compressed zeros (::), and embedded IPv4.
 * Returns null if invalid.
 */
export function parseIpv6(ipStr: string): { words: number[]; bigInt: bigint } | null {
  if (typeof ipStr !== 'string') return null;
  let clean = ipStr.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase().trim();
  if (clean.length === 0) return null;

  // Reject malformed multiple consecutive colons (e.g. :::, :::: )
  if (clean.includes(':::')) return null;

  // Single leading or trailing colon is invalid (only :: is valid at ends)
  if (clean.startsWith(':') && !clean.startsWith('::')) return null;
  if (clean.endsWith(':') && !clean.endsWith('::')) return null;

  const lastColon = clean.lastIndexOf(':');
  if (lastColon !== -1) {
    const after = clean.slice(lastColon + 1);
    if (after.includes('.')) {
      // Embedded IPv4 dotted quad: strictly parse with ipV4ToNumber
      const v4Num = ipV4ToNumber(after);
      if (v4Num === null) return null;
      const hex1 = ((v4Num >>> 16) & 0xffff).toString(16);
      const hex2 = (v4Num & 0xffff).toString(16);
      clean = clean.slice(0, lastColon + 1) + hex1 + ':' + hex2;
    }
  }

  let words: string[];
  if (clean.includes('::')) {
    const halves = clean.split('::');
    if (halves.length !== 2) return null; // Only one :: allowed
    const [left, right] = halves;

    // Check for empty words in left or right
    const leftParts = left.length > 0 ? left.split(':') : [];
    const rightParts = right.length > 0 ? right.split(':') : [];
    if (leftParts.some((p) => p.length === 0) || rightParts.some((p) => p.length === 0)) {
      return null;
    }

    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 1) return null; // :: must compress at least 1 word
    words = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    words = clean.split(':');
    if (words.some((p) => p.length === 0)) return null;
  }

  if (words.length !== 8) return null;
  const numWords: number[] = [];
  for (const w of words) {
    if (!/^[0-9a-f]{1,4}$/i.test(w)) return null;
    const val = parseInt(w, 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    numWords.push(val);
  }

  let bigInt = 0n;
  for (const w of numWords) {
    bigInt = (bigInt << 16n) | BigInt(w);
  }
  return { words: numWords, bigInt };
}

/**
 * Checks whether an IPv6 128-bit BigInt matches a CIDR prefix.
 */
export function matchesIpv6Prefix(ip128: bigint, prefixStr: string, prefixLen: number): boolean {
  const prefixParsed = parseIpv6(prefixStr);
  if (!prefixParsed) return false;
  const shift = 128n - BigInt(prefixLen);
  return (ip128 >> shift) === (prefixParsed.bigInt >> shift);
}

/**
 * Evaluates whether an IP address (IPv4 or IPv6 in any representation) is private,
 * loopback, link-local, cloud metadata, ULA, multicast, or non-routable/reserved.
 * Returns true if the address is forbidden or invalid (fail-closed).
 */
export function isPrivateOrSpecialIp(ip: string): boolean {
  if (typeof ip !== 'string' || ip.trim().length === 0) return true;
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0].trim();

  // Try IPv4 first
  const v4Num = ipV4ToNumber(clean);
  if (v4Num !== null) {
    return isForbiddenIpv4(v4Num);
  }

  // Try IPv6
  const parsed6 = parseIpv6(clean);
  if (!parsed6) {
    // Malformed/unparseable address format -> fail-closed
    return true;
  }

  const { bigInt } = parsed6;

  // 1. Direct IPv6 CIDR prefix checks
  for (const range of FORBIDDEN_IPV6_RANGES) {
    if (matchesIpv6Prefix(bigInt, range.prefix, range.length)) {
      return true;
    }
  }

  // 2. IPv4-compatible IPv6 (::/96) - deprecated, lower 32 bits embed IPv4
  if (matchesIpv6Prefix(bigInt, '::', 96)) {
    const embeddedV4 = Number(bigInt & 0xffffffffn);
    return isForbiddenIpv4(embeddedV4);
  }

  // 3. IPv4-mapped IPv6 (::ffff:0:0/96) - lower 32 bits embed IPv4
  if (matchesIpv6Prefix(bigInt, '::ffff:0:0', 96)) {
    const embeddedV4 = Number(bigInt & 0xffffffffn);
    return isForbiddenIpv4(embeddedV4);
  }

  // 4. Well-Known Prefix IPv4/IPv6 translation (64:ff9b::/96)
  if (matchesIpv6Prefix(bigInt, '64:ff9b::', 96)) {
    const embeddedV4 = Number(bigInt & 0xffffffffn);
    return isForbiddenIpv4(embeddedV4);
  }

  // 5. 6to4 Anycast (2002::/16) - embeds IPv4 in bits 16..47
  if (matchesIpv6Prefix(bigInt, '2002::', 16)) {
    const embeddedV4 = Number((bigInt >> 80n) & 0xffffffffn);
    return isForbiddenIpv4(embeddedV4);
  }

  return false;
}

/**
 * Validates a JWKS URI syntactically to prevent SSRF and unsafe protocols.
 */
export function validateJwksUri(uriString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uriString);
  } catch {
    throw new Error(`Invalid JWKS URI format: '${uriString}'`);
  }

  if (parsed.protocol !== 'https:') {
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (!isLocalhost || process.env.NODE_ENV === 'production') {
      throw new Error(`JWKS URI must strictly use HTTPS protocol. Insecure protocol '${parsed.protocol}' rejected for SSRF defense.`);
    }
  }

  if (parsed.username || parsed.password) {
    throw new Error('JWKS URI must not contain embedded user credentials. Rejected for SSRF defense.');
  }

  if (parsed.port && parsed.port !== '443' && parsed.port !== '8443') {
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (!isLocalhost || process.env.NODE_ENV === 'production') {
      throw new Error(`Non-standard port '${parsed.port}' on JWKS URI is prohibited for SSRF defense.`);
    }
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0].trim();
  if (
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host === 'metadata.google.internal'
  ) {
    throw new Error(`JWKS URI targets forbidden cloud metadata IP ('${parsed.hostname}'). Rejected for SSRF defense.`);
  }

  if (net.isIP(host) && isPrivateOrSpecialIp(host)) {
    const isLocalhost = host === '127.0.0.1' || host === '::1';
    if (!isLocalhost || process.env.NODE_ENV === 'production') {
      throw new Error(`JWKS URI targets forbidden private/link-local/metadata IP ('${parsed.hostname}'). Rejected for SSRF defense.`);
    }
  }

  if (
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error(`JWKS URI targets forbidden internal host ('${parsed.hostname}'). Rejected for SSRF defense.`);
  }
}

/**
 * Validates hostname DNS resolution to defend against DNS rebinding and internal/private IP routing.
 */
export async function validateJwksHostDns(
  hostname: string,
  dnsLookupFn?: (hostname: string) => Promise<{ address: string; family: number }[]>
): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0].trim();
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (isLocalhost && process.env.NODE_ENV !== 'production') {
    return;
  }

  if (net.isIP(host)) {
    if (host === '169.254.169.254' || host.startsWith('169.254.')) {
      throw new Error(`JWKS URI targets forbidden cloud metadata IP ('${hostname}'). Rejected for SSRF defense.`);
    }
    if (isPrivateOrSpecialIp(host)) {
      throw new Error(`JWKS URI targets forbidden private/link-local/metadata IP ('${hostname}'). Rejected for SSRF defense.`);
    }
    return;
  }

  let addresses: { address: string; family: number }[];
  try {
    if (dnsLookupFn) {
      addresses = await dnsLookupFn(host);
    } else {
      const records = await dns.promises.lookup(host, { all: true });
      addresses = Array.isArray(records) ? records : [records];
    }
  } catch (err: unknown) {
    throw new Error(
      `JWKS URI hostname '${hostname}' could not be resolved via DNS (${err instanceof Error ? err.message : String(err)}). Rejected fail-closed for SSRF defense.`
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(
      `JWKS URI hostname '${hostname}' yielded zero DNS address records. Rejected fail-closed for SSRF defense.`
    );
  }

  for (const entry of addresses) {
    const ip = entry.address;
    if (ip === '169.254.169.254' || ip.startsWith('169.254.') || ip === '::ffff:169.254.169.254') {
      throw new Error(`JWKS URI resolves to forbidden cloud metadata IP '${ip}' for host '${hostname}'. Rejected for SSRF defense.`);
    }
    if (isPrivateOrSpecialIp(ip)) {
      throw new Error(
        `JWKS URI resolves to forbidden private/link-local/metadata IP '${ip}' for host '${hostname}'. Rejected for SSRF defense.`
      );
    }
  }
}

/**
 * Performs secure JWKS fetch over HTTPS with in-flight DNS lookup validation
 * to eliminate DNS rebinding (TOCTOU) and strictly blocks HTTP redirects.
 */
export async function fetchSecureJwks(
  jwksUri: string,
  timeoutMs: number,
  dnsLookupFn?: (hostname: string) => Promise<{ address: string; family: number }[]>
): Promise<{ keys?: unknown[] }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(jwksUri);
    } catch (e) {
      return reject(new Error(`Invalid JWKS URL: ${e instanceof Error ? e.message : String(e)}`));
    }

    if (parsed.protocol !== 'https:') {
      const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (!isLocalhost || process.env.NODE_ENV === 'production') {
        return reject(new Error(`JWKS URI must strictly use HTTPS protocol: '${parsed.protocol}'`));
      }
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0].trim();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';

    const ssrfGuardedLookup = (
      lookupHostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
    ) => {
      const isAll = typeof options === 'object' && options !== null && Boolean((options as Record<string, unknown>).all);

      if (dnsLookupFn) {
        dnsLookupFn(lookupHostname)
          .then((records) => {
            if (!records || records.length === 0) {
              return callback(
                new Error(
                  `In-flight DNS resolution for '${lookupHostname}' returned zero records. Rejected fail-closed for SSRF defense.`
                ) as NodeJS.ErrnoException,
                []
              );
            }
            for (const r of records) {
              const ip = r.address;
              if (
                isPrivateOrSpecialIp(ip) &&
                (!isLocalhost || process.env.NODE_ENV === 'production')
              ) {
                return callback(
                  new Error(
                    `In-flight socket connection blocked: '${lookupHostname}' resolved to forbidden IP '${ip}'. Rejected for SSRF defense.`
                  ) as NodeJS.ErrnoException,
                  []
                );
              }
            }
            if (isAll) {
              callback(null, records as dns.LookupAddress[]);
            } else {
              callback(null, records[0].address as unknown as dns.LookupAddress[], records[0].family);
            }
          })
          .catch((err) => callback(err instanceof Error ? (err as NodeJS.ErrnoException) : new Error(String(err)), []));
        return;
      }

      dns.lookup(lookupHostname, { ...(typeof options === 'object' && options !== null ? options : {}), all: true }, (err, addresses) => {
        if (err) return callback(err, []);
        const list = Array.isArray(addresses) ? addresses : [addresses];
        if (list.length === 0) {
          return callback(
            new Error(`In-flight DNS resolution for '${lookupHostname}' returned zero records. Rejected fail-closed for SSRF defense.`) as NodeJS.ErrnoException,
            []
          );
        }
        for (const entry of list) {
          const ip = typeof entry === 'string' ? entry : entry?.address;
          if (!ip) {
            return callback(
              new Error(`In-flight DNS lookup returned empty IP for '${lookupHostname}'. Rejected fail-closed.`) as NodeJS.ErrnoException,
              []
            );
          }
          if (
            isPrivateOrSpecialIp(ip) &&
            (!isLocalhost || process.env.NODE_ENV === 'production')
          ) {
            return callback(
              new Error(
                `In-flight socket connection blocked: '${lookupHostname}' resolved to forbidden IP '${ip}'. Rejected for SSRF defense.`
              ) as NodeJS.ErrnoException,
              []
            );
          }
        }
        if (isAll) {
          callback(null, list as dns.LookupAddress[]);
        } else {
          const first = list[0];
          if (typeof first === 'string') {
            callback(null, first as unknown as dns.LookupAddress[], 4);
          } else {
            callback(null, first.address as unknown as dns.LookupAddress[], first.family);
          }
        }
      });
    };

    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        lookup: ssrfGuardedLookup as unknown as https.RequestOptions['lookup'],
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          const loc = res.headers.location;
          return reject(new Error(`JWKS endpoint attempted redirect to '${loc ?? 'unknown'}'. Automatic redirects are blocked for SSRF defense.`));
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`JWKS endpoint returned HTTP ${res.statusCode} ${res.statusMessage ?? ''}`));
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            reject(new Error(`Failed to parse JWKS JSON response: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`JWKS request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Maps standard JWT alg string to Node.js crypto algorithm name.
 */
function getCryptoAlgorithm(alg: string): string | null {
  switch (alg) {
    case 'RS256':
      return 'RSA-SHA256';
    case 'RS384':
      return 'RSA-SHA384';
    case 'RS512':
      return 'RSA-SHA512';
    case 'ES256':
      return 'sha256';
    case 'ES384':
      return 'sha384';
    case 'ES512':
      return 'sha512';
    case 'EdDSA':
      return null;
    default:
      return null;
  }
}

/**
 * Safely parses numeric epoch seconds or ISO strings into epoch milliseconds.
 */
function parseJwtDateMs(val: unknown): number {
  if (typeof val === 'number') {
    return val < 100000000000 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const num = Number(val);
    if (!isNaN(num) && num > 0) {
      return num < 100000000000 ? num * 1000 : num;
    }
    return Date.parse(val);
  }
  return NaN;
}

/**
 * OpenID Connect token validator adapter.
 * Enforces zero-trust cryptographic signature verification, JWKS resolution,
 * payload-derived claims, and cryptographic context scope binding.
 */
export class OidcIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType = 'OIDC';
  private readonly issuer: string;
  private readonly audience: string | readonly string[];
  private readonly jwksUri?: string;
  private readonly publicKeyPem?: string;
  private readonly allowedAlgorithms: readonly string[];
  private readonly nonceStore?: NonceStore;
  private readonly clockSkewSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchJwksFn?: (uri: string, options?: { signal?: AbortSignal }) => Promise<{ keys: unknown[] }>;
  private readonly dnsLookupFn?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  private readonly verifySignatureFn?: (token: string, keyOrJwks?: string) => Promise<boolean> | boolean;
  private isOutage: boolean;
  private readonly revokedIdentities = new Set<string>();

  constructor(options: OidcIdentityProviderOptions) {
    this.providerId = options.providerId ?? 'oidc-provider';
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.jwksUri = options.jwksUri;
    this.publicKeyPem = options.publicKeyPem;
    this.allowedAlgorithms = options.allowedAlgorithms ?? DEFAULT_ALLOWED_OIDC_ALGORITHMS;
    this.nonceStore = options.nonceStore;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 60;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.fetchJwksFn = options.fetchJwksFn;
    this.dnsLookupFn = options.dnsLookupFn;
    this.verifySignatureFn = options.verifySignatureFn;
    this.isOutage = options.isOutage ?? false;
  }

  isConfigured(): boolean {
    return Boolean(
      this.issuer &&
      this.audience &&
      (this.jwksUri || this.publicKeyPem || this.verifySignatureFn)
    );
  }

  setOutage(outage: boolean): void {
    this.isOutage = outage;
  }

  revokeIdentity(identityIdOrSub: string): void {
    this.revokedIdentities.add(identityIdOrSub);
  }

  async getHealth(): Promise<TrustedProviderHealth> {
    const configured = this.isConfigured();
    if (!configured) {
      return {
        isHealthy: false,
        isConfigured: false,
        providerId: this.providerId,
        providerType: this.providerType,
        message: 'OIDC provider configuration is incomplete (missing issuer, audience, or verification key/endpoint).',
      };
    }
    if (this.isOutage) {
      return {
        isHealthy: false,
        isConfigured: true,
        providerId: this.providerId,
        providerType: this.providerType,
        message: 'OIDC provider endpoint is currently unreachable (network timeout / outage).',
      };
    }
    return {
      isHealthy: true,
      isConfigured: true,
      providerId: this.providerId,
      providerType: this.providerType,
      message: 'OIDC provider endpoint is reachable and healthy.',
    };
  }

  async verifyAssertion(
    rawAssertion: TrustedIdentityAssertion,
    expectedBinding: TrustedApprovalBinding,
    options?: { dryRun?: boolean }
  ): Promise<IdentityVerificationResult> {
    // 1. Configuration & Outage check (Strict Fail-Closed)
    if (!this.isConfigured()) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'CONFIG_MISSING',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'OIDC Provider configuration is missing or incomplete. Rejected fail-closed.',
      };
    }

    if (this.isOutage) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'PROVIDER_OUTAGE',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'OIDC Provider endpoint is unreachable (outage / network failure). Rejected fail-closed.',
      };
    }

    // 2. Parse assertion schema
    const parseRes = TrustedIdentityAssertionSchema.safeParse(rawAssertion);
    if (!parseRes.success) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Invalid assertion structure: ${parseRes.error.issues[0]?.message ?? 'parse failure'}`,
      };
    }
    const assertion = parseRes.data;

    // 3. Token Format & Header Verification
    const parts = assertion.token.split('.');
    if (parts.length !== 3) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Invalid JWT token format: expected exactly 3 parts separated by dots.',
      };
    }

    let header: { alg?: string; kid?: string; typ?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Malformed JWT header: unable to parse base64url JSON.',
      };
    }

    if (!header || typeof header !== 'object' || !header.alg) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: "JWT header missing required 'alg' parameter.",
      };
    }

    // 3a. Algorithm Allowlist Validation
    if (header.alg === 'none' || header.alg.startsWith('HS')) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Insecure or symmetric algorithm '${header.alg}' is strictly prohibited.`,
      };
    }

    if (!this.allowedAlgorithms.includes(header.alg)) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Algorithm '${header.alg}' is not permitted by allowed algorithms list [${this.allowedAlgorithms.join(', ')}].`,
      };
    }

    // 4. Cryptographic Signature Verification
    const dataToVerify = Buffer.from(`${parts[0]}.${parts[1]}`);
    let signatureBuffer: Buffer;
    try {
      signatureBuffer = Buffer.from(parts[2], 'base64url');
      if (signatureBuffer.length === 0) {
        throw new Error('Empty signature');
      }
    } catch {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Malformed base64url signature in JWT token.',
      };
    }

    let isSignatureValid = false;

    if (this.verifySignatureFn) {
      try {
        isSignatureValid = await this.verifySignatureFn(assertion.token, this.publicKeyPem ?? this.jwksUri);
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Custom verifySignatureFn execution error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (this.publicKeyPem) {
      try {
        const cryptoAlg = getCryptoAlgorithm(header.alg);
        isSignatureValid = crypto.verify(cryptoAlg, dataToVerify, this.publicKeyPem, signatureBuffer);
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (this.jwksUri) {
      // Validate JWKS URI for SSRF protection (syntactic check)
      try {
        validateJwksUri(this.jwksUri);
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'CONFIG_MISSING',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // Validate DNS resolution (SSRF protection against private IPs and rebinding)
      const parsedJwksUrl = new URL(this.jwksUri);
      const host = parsedJwksUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      const isIpLiteral = net.isIP(host) !== 0;

      if (!isIpLiteral && (!isLocalhost || process.env.NODE_ENV === 'production')) {
        if (!this.fetchJwksFn || this.dnsLookupFn) {
          try {
            await validateJwksHostDns(host, this.dnsLookupFn);
          } catch (err: unknown) {
            return {
              isValid: false,
              isTrustedHumanAuth: false,
              status: 'CONFIG_MISSING',
              code: 'BLOCKED_ON_AUTH_CONTEXT',
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }

      let jwksData: { keys?: unknown[] };
      try {
        if (this.fetchJwksFn) {
          jwksData = await this.fetchJwksFn(this.jwksUri, {
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
        } else {
          jwksData = await fetchSecureJwks(this.jwksUri, this.requestTimeoutMs, this.dnsLookupFn);
        }
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'PROVIDER_OUTAGE',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `JWKS network fetch failed or timed out: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!jwksData || !Array.isArray(jwksData.keys) || jwksData.keys.length === 0) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: 'Malformed JWKS response: missing or empty keys array.',
        };
      }

      // Match key from JWKS
      let matchedJwk: Record<string, unknown> | undefined;
      if (header.kid) {
        matchedJwk = jwksData.keys.find(
          (k: any) => k && typeof k === 'object' && k.kid === header.kid
        ) as Record<string, unknown> | undefined;
        if (!matchedJwk) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'SIGNATURE_INVALID',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: `Key ID (kid) '${header.kid}' not found in resolved JWKS keys.`,
          };
        }
      } else if (jwksData.keys.length === 1 && jwksData.keys[0] && typeof jwksData.keys[0] === 'object') {
        matchedJwk = jwksData.keys[0] as Record<string, unknown>;
      } else {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: "JWKS contains multiple keys but JWT header does not specify 'kid'.",
        };
      }

      if (!matchedJwk.kty || typeof matchedJwk.kty !== 'string') {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: "JWK key missing required 'kty' parameter.",
        };
      }

      // Check algorithm compatibility between JWK and token header
      if (matchedJwk.alg && typeof matchedJwk.alg === 'string' && matchedJwk.alg !== header.alg) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `JWK algorithm '${matchedJwk.alg}' contradicts token header algorithm '${header.alg}'.`,
        };
      }

      if (header.alg.startsWith('RS') && matchedJwk.kty !== 'RSA') {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Algorithm '${header.alg}' requires kty 'RSA', but JWK has kty '${matchedJwk.kty}'.`,
        };
      }
      if (header.alg.startsWith('ES') && matchedJwk.kty !== 'EC') {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Algorithm '${header.alg}' requires kty 'EC', but JWK has kty '${matchedJwk.kty}'.`,
        };
      }
      if (header.alg === 'EdDSA' && matchedJwk.kty !== 'OKP' && matchedJwk.kty !== 'EC') {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Algorithm 'EdDSA' requires kty 'OKP' or 'EC', but JWK has kty '${matchedJwk.kty}'.`,
        };
      }

      try {
        const publicKey = crypto.createPublicKey({ key: matchedJwk as any, format: 'jwk' });
        const cryptoAlg = getCryptoAlgorithm(header.alg);
        isSignatureValid = crypto.verify(cryptoAlg, dataToVerify, publicKey, signatureBuffer);
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `JWKS cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'CONFIG_MISSING',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'OIDC provider has no active cryptographic verification mechanism configured.',
      };
    }

    if (!isSignatureValid) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Cryptographic signature verification failed for OIDC token.',
        details: { maskedToken: maskToken(assertion.token) },
      };
    }

    // 5. Authoritative Claims Extraction from Verified Payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Malformed JWT payload: invalid JSON structure.',
      };
    }

    if (!payload || typeof payload !== 'object') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'JWT payload is not a valid JSON object.',
      };
    }

    const sub = (payload.sub ?? payload.subject) as string | undefined;
    const iss = (payload.iss ?? payload.issuer) as string | undefined;
    const aud = (payload.aud ?? payload.audience) as string | string[] | undefined;
    const actorRole = (payload.actorRole ?? payload.role ?? payload['https://aidm.io/role']) as string | undefined;
    const email = payload.email as string | undefined;
    const nonce = (payload.nonce ?? payload.jti) as string | undefined;
    const exp = payload.exp ?? payload.expiresAt;
    const iat = payload.iat ?? payload.issuedAt;
    const nbf = payload.nbf ?? payload.notBefore;

    // Required fields check in authoritative payload
    if (!sub || typeof sub !== 'string') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: "Authoritative JWT payload missing required 'sub' claim.",
      };
    }

    if (!iss || typeof iss !== 'string') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: "Authoritative JWT payload missing required 'iss' claim.",
      };
    }

    if (!aud) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: "Authoritative JWT payload missing required 'aud' claim.",
      };
    }

    if (!actorRole || typeof actorRole !== 'string') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: "Authoritative JWT payload missing required 'actorRole' or 'role' claim.",
      };
    }

    // 5a. Cross-check client-provided assertion.claims for tampering / spoofing
    if (assertion.claims) {
      const clientClaims = assertion.claims;
      if (clientClaims.subject && clientClaims.subject !== sub) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Client assertion.claims.subject ('${clientClaims.subject}') contradicts verified token subject ('${sub}'). Spoofing attempt blocked.`,
        };
      }
      if (clientClaims.actorRole && clientClaims.actorRole !== actorRole) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Client assertion.claims.actorRole ('${clientClaims.actorRole}') contradicts verified token actorRole ('${actorRole}'). Privilege escalation blocked.`,
        };
      }
      if (clientClaims.issuer && clientClaims.issuer !== iss) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'ISSUER_MISMATCH',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Client assertion.claims.issuer ('${clientClaims.issuer}') contradicts verified token issuer ('${iss}').`,
        };
      }
    }

    // 5b. Issuer check
    if (iss !== this.issuer) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'ISSUER_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Issuer mismatch: expected '${this.issuer}', got '${iss}'.`,
      };
    }

    // 5c. Audience check
    const allowedAudiences = Array.isArray(this.audience) ? this.audience : [this.audience];
    const tokenAudiences = Array.isArray(aud) ? aud : [aud];
    const hasAudienceMatch = tokenAudiences.some((a) => allowedAudiences.includes(a));
    if (!hasAudienceMatch) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'AUDIENCE_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Audience mismatch: token audience '${tokenAudiences.join(', ')}' does not match allowed audiences '${allowedAudiences.join(', ')}'.`,
      };
    }

    // 5d. Actor Role authority check (strictly PRODUCT_OWNER or USER)
    if (actorRole !== 'PRODUCT_OWNER' && actorRole !== 'USER') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'ACTOR_UNAUTHORIZED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Actor role '${actorRole}' is unauthorized for human approval. Must strictly be PRODUCT_OWNER or USER.`,
      };
    }

    // 5e. Revocation check
    if (this.revokedIdentities.has(sub) || (payload.identityId && this.revokedIdentities.has(String(payload.identityId)))) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'REVOKED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Identity '${sub}' has been revoked. Approval cannot be accepted.`,
      };
    }

    // 5f. Expiry, Issued-At, and Not-Before Checks
    const nowMs = Date.now();
    const skewMs = this.clockSkewSeconds * 1000;

    if (exp === undefined || exp === null) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: "Authoritative JWT payload missing required 'exp' claim.",
      };
    }

    const expMs = parseJwtDateMs(exp);
    if (isNaN(expMs) || expMs + skewMs < nowMs) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'EXPIRED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `OIDC token has expired (exp: '${exp}'). Current time: '${new Date(nowMs).toISOString()}'.`,
      };
    }

    if (iat !== undefined && iat !== null) {
      const iatMs = parseJwtDateMs(iat);
      if (isNaN(iatMs)) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Invalid 'iat' date format in token: '${iat}'.`,
        };
      }
      if (iatMs - skewMs > nowMs) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `OIDC token was issued in the future (iat: '${iat}'). Clock skew exceeded.`,
        };
      }
    }

    if (nbf !== undefined && nbf !== null) {
      const nbfMs = parseJwtDateMs(nbf);
      if (isNaN(nbfMs)) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Invalid 'nbf' date format in token: '${nbf}'.`,
        };
      }
      if (nbfMs - skewMs > nowMs) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `OIDC token is not yet valid (nbf: '${nbf}'). Current time: '${new Date(nowMs).toISOString()}'.`,
        };
      }
    }

    // 5g. Anti-Replay: Nonce check & atomic reservation
    if (!nonce || typeof nonce !== 'string' || nonce.length < 8) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'OIDC token missing required nonce or nonce has fewer than 8 characters.',
      };
    }

    if (this.nonceStore) {
      try {
        if (options?.dryRun) {
          const seen = await this.nonceStore.isNonceSeen(nonce);
          if (seen) {
            return {
              isValid: false,
              isTrustedHumanAuth: false,
              status: 'REPLAY_DETECTED',
              code: 'BLOCKED_ON_AUTH_CONTEXT',
              reason: `Replay attack detected: Nonce '${nonce}' was previously used. Duplicate token reuse prohibited.`,
            };
          }
        } else {
          const reserved = await this.nonceStore.reserveNonce(nonce, 60_000);
          if (!reserved) {
            return {
              isValid: false,
              isTrustedHumanAuth: false,
              status: 'REPLAY_DETECTED',
              code: 'BLOCKED_ON_AUTH_CONTEXT',
              reason: `Replay attack detected: Nonce '${nonce}' was previously used or is currently in flight. Duplicate token reuse prohibited.`,
            };
          }
        }
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Nonce state verification failed: ${err instanceof Error ? err.message : String(err)}. Rejecting fail-closed.`,
        };
      }
    }

    const releaseNonceIfReserved = async () => {
      if (this.nonceStore && !options?.dryRun) {
        try {
          await this.nonceStore.releaseReservation(nonce);
        } catch {
          // Ignore release errors during failure teardown
        }
      }
    };

    // 6. Cryptographic Scope Binding Verification (Payload Bound)
    const rawPb = (payload.binding && typeof payload.binding === 'object' ? payload.binding : {}) as Record<string, unknown>;
    const payloadBinding: Partial<TrustedApprovalBinding> = {
      projectId: typeof rawPb.projectId === 'string' ? rawPb.projectId : (typeof payload.projectId === 'string' ? payload.projectId : undefined),
      packageId: typeof rawPb.packageId === 'string' ? rawPb.packageId : (typeof payload.packageId === 'string' ? payload.packageId : undefined),
      revision: typeof rawPb.revision === 'number' ? rawPb.revision : (typeof payload.revision === 'number' ? payload.revision : (rawPb.revision ? Number(rawPb.revision) : (payload.revision ? Number(payload.revision) : undefined))),
      contextFingerprint: typeof rawPb.contextFingerprint === 'string' ? rawPb.contextFingerprint : (typeof payload.contextFingerprint === 'string' ? payload.contextFingerprint : undefined),
      directorSessionId: typeof rawPb.directorSessionId === 'string' ? rawPb.directorSessionId : (typeof payload.directorSessionId === 'string' ? payload.directorSessionId : undefined),
      taskId: typeof rawPb.taskId === 'string' ? rawPb.taskId : (typeof payload.taskId === 'string' ? payload.taskId : undefined),
      operation: typeof rawPb.operation === 'string' ? rawPb.operation : (typeof payload.operation === 'string' ? payload.operation : undefined),
    };

    if (!payloadBinding.projectId || payloadBinding.projectId !== expectedBinding.projectId) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Cross-project binding violation: token bound to '${payloadBinding.projectId}', but target is '${expectedBinding.projectId}'.`,
      };
    }

    if (!payloadBinding.packageId || payloadBinding.packageId !== expectedBinding.packageId) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Package binding mismatch: token bound to '${payloadBinding.packageId}', expected '${expectedBinding.packageId}'.`,
      };
    }

    if (payloadBinding.revision === undefined || payloadBinding.revision !== expectedBinding.revision) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Revision binding mismatch: token bound to revision ${payloadBinding.revision}, expected ${expectedBinding.revision}.`,
      };
    }

    if (!payloadBinding.contextFingerprint || payloadBinding.contextFingerprint !== expectedBinding.contextFingerprint) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Context fingerprint binding mismatch: token bound to '${payloadBinding.contextFingerprint}', expected '${expectedBinding.contextFingerprint}'.`,
      };
    }

    // Fail-Closed: If expectedBinding specifies directorSessionId, token MUST contain it and match
    if (expectedBinding.directorSessionId !== undefined && payloadBinding.directorSessionId !== expectedBinding.directorSessionId) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Session binding mismatch: token bound to session '${payloadBinding.directorSessionId ?? '<missing>'}', expected '${expectedBinding.directorSessionId}'.`,
      };
    }

    // Fail-Closed: If token explicitly specifies directorSessionId, it cannot be used where expectedBinding doesn't match
    if (payloadBinding.directorSessionId !== undefined && payloadBinding.directorSessionId !== expectedBinding.directorSessionId) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Session binding mismatch: token bound to session '${payloadBinding.directorSessionId}', expected '${expectedBinding.directorSessionId ?? '<none>'}'.`,
      };
    }

    // Fail-Closed: If expectedBinding specifies taskId, token MUST contain it and match
    if (expectedBinding.taskId !== undefined && payloadBinding.taskId !== expectedBinding.taskId) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Task binding mismatch: token bound to task '${payloadBinding.taskId ?? '<missing>'}', expected '${expectedBinding.taskId}'.`,
      };
    }

    // Fail-Closed: If token explicitly specifies taskId, it cannot be used where expectedBinding doesn't match
    if (payloadBinding.taskId !== undefined && payloadBinding.taskId !== expectedBinding.taskId) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Task binding mismatch: token bound to task '${payloadBinding.taskId}', expected '${expectedBinding.taskId ?? '<none>'}'.`,
      };
    }

    // Fail-Closed: If expectedBinding specifies operation, token MUST contain it and match
    if (expectedBinding.operation !== undefined && payloadBinding.operation !== expectedBinding.operation) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Operation binding mismatch: token bound to operation '${payloadBinding.operation ?? '<missing>'}', expected '${expectedBinding.operation}'.`,
      };
    }

    // Fail-Closed: If token explicitly specifies operation, it cannot be used where expectedBinding doesn't match
    if (payloadBinding.operation !== undefined && payloadBinding.operation !== expectedBinding.operation) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Operation binding mismatch: token bound to operation '${payloadBinding.operation}', expected '${expectedBinding.operation ?? '<none>'}'.`,
      };
    }

    // Also verify assertion.binding matches expected execution binding and does not contradict token payload
    const binding = assertion.binding;
    if (
      !binding ||
      binding.projectId !== expectedBinding.projectId ||
      binding.packageId !== expectedBinding.packageId ||
      binding.revision !== expectedBinding.revision ||
      binding.contextFingerprint !== expectedBinding.contextFingerprint ||
      (expectedBinding.directorSessionId !== undefined && binding.directorSessionId !== expectedBinding.directorSessionId) ||
      (expectedBinding.taskId !== undefined && binding.taskId !== expectedBinding.taskId) ||
      (expectedBinding.operation !== undefined && binding.operation !== expectedBinding.operation) ||
      (payloadBinding.directorSessionId !== undefined && binding.directorSessionId !== payloadBinding.directorSessionId) ||
      (payloadBinding.taskId !== undefined && binding.taskId !== payloadBinding.taskId) ||
      (payloadBinding.operation !== undefined && binding.operation !== payloadBinding.operation)
    ) {
      await releaseNonceIfReserved();
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Client assertion.binding contradicts expected execution binding boundaries or signed token payload.',
      };
    }

    // Mark nonce permanently seen/consumed now that all checks passed
    if (this.nonceStore && !options?.dryRun) {
      const tokenExpMs = typeof exp === 'number' ? parseJwtDateMs(exp) : undefined;
      try {
        await this.nonceStore.markNonceSeen(nonce, tokenExpMs);
      } catch (err: unknown) {
        await releaseNonceIfReserved();
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Failed to persist nonce consumption: ${err instanceof Error ? err.message : String(err)}. Rejecting fail-closed.`,
        };
      }
    }

    // 7. Successful External Verification
    const verifiedClaims: TrustedIdentityClaim = {
      identityId: String(payload.identityId ?? sub),
      issuer: iss,
      audience: aud,
      subject: sub,
      email,
      actorRole: actorRole as 'PRODUCT_OWNER' | 'USER',
      issuedAt: typeof iat === 'number' ? new Date(parseJwtDateMs(iat)).toISOString() : String(iat ?? new Date().toISOString()),
      expiresAt: typeof exp === 'number' ? new Date(parseJwtDateMs(exp)).toISOString() : String(exp),
      notBefore: nbf ? (typeof nbf === 'number' ? new Date(parseJwtDateMs(nbf)).toISOString() : String(nbf)) : undefined,
      nonce,
      authMethod: 'OIDC',
      publicKeyFingerprint: header.kid,
    };

    return {
      isValid: true,
      isTrustedHumanAuth: true,
      status: 'VERIFIED',
      code: 'VERIFIED_HUMAN',
      reason: 'OIDC external identity assertion verified successfully with authoritative cryptographic bindings.',
      claims: verifiedClaims,
      verifiedAt: new Date().toISOString(),
      details: sanitizeForAudit({
        issuer: iss,
        subject: sub,
        actorRole,
        binding: {
          projectId: expectedBinding.projectId,
          packageId: expectedBinding.packageId,
          revision: expectedBinding.revision,
        },
      }),
    };
  }
}

// ============================================================================
// 3. MTLS IDENTITY PROVIDER ADAPTER
// ============================================================================

export interface MtlsIdentityProviderOptions {
  readonly providerId?: string;
  readonly trustedCaFingerprints?: readonly string[];
  readonly allowedSubjects: readonly string[];
  readonly trustedClientCertificates?: readonly string[];
  readonly nonceStore?: NonceStore;
  readonly verifyTlsConnectionFn?: (assertion: TrustedIdentityAssertion) => Promise<boolean> | boolean;
}

/**
 * mTLS X.509 client certificate identity adapter.
 * Requires genuine X.509 certificate verification; client metadata alone is strictly rejected.
 */
export class MtlsIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType = 'MTLS';
  private readonly trustedCaFingerprints: readonly string[];
  private readonly allowedSubjects: readonly string[];
  private readonly trustedClientCertificates: readonly string[];
  private readonly nonceStore?: NonceStore;
  private readonly verifyTlsConnectionFn?: (assertion: TrustedIdentityAssertion) => Promise<boolean> | boolean;

  constructor(options: MtlsIdentityProviderOptions) {
    this.providerId = options.providerId ?? 'mtls-provider';
    this.trustedCaFingerprints = options.trustedCaFingerprints ?? [];
    this.allowedSubjects = options.allowedSubjects;
    this.trustedClientCertificates = options.trustedClientCertificates ?? [];
    this.nonceStore = options.nonceStore;
    this.verifyTlsConnectionFn = options.verifyTlsConnectionFn;
  }

  isConfigured(): boolean {
    return (
      this.allowedSubjects.length > 0 &&
      (this.trustedCaFingerprints.length > 0 ||
        this.trustedClientCertificates.length > 0 ||
        Boolean(this.verifyTlsConnectionFn))
    );
  }

  async getHealth(): Promise<TrustedProviderHealth> {
    const configured = this.isConfigured();
    return {
      isHealthy: configured,
      isConfigured: configured,
      providerId: this.providerId,
      providerType: this.providerType,
      message: configured ? 'mTLS provider configured.' : 'mTLS provider missing CA fingerprints or allowed subjects.',
    };
  }

  async verifyAssertion(
    rawAssertion: TrustedIdentityAssertion,
    expectedBinding: TrustedApprovalBinding,
    _options?: { dryRun?: boolean }
  ): Promise<IdentityVerificationResult> {
    if (!this.isConfigured()) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'CONFIG_MISSING',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'mTLS Provider configuration is missing or incomplete.',
      };
    }

    const parseRes = TrustedIdentityAssertionSchema.safeParse(rawAssertion);
    if (!parseRes.success) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Invalid assertion structure: ${parseRes.error.issues[0]?.message ?? 'parse failure'}`,
      };
    }
    const assertion = parseRes.data;

    // Check binding
    if (assertion.binding.projectId !== expectedBinding.projectId) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'mTLS assertion cross-project binding mismatch.',
      };
    }

    // mTLS Verification: Must provide genuine X.509 certificate or TLS connection verifier
    if (this.verifyTlsConnectionFn) {
      try {
        const ok = await this.verifyTlsConnectionFn(assertion);
        if (!ok) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'SIGNATURE_INVALID',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: 'mTLS TLS connection layer verification failed.',
          };
        }
        return {
          isValid: true,
          isTrustedHumanAuth: true,
          status: 'VERIFIED',
          code: 'VERIFIED_HUMAN',
          reason: 'mTLS TLS connection layer verified successfully.',
          claims: assertion.claims as TrustedIdentityClaim,
          verifiedAt: new Date().toISOString(),
        };
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `mTLS TLS verification function threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (assertion.token && assertion.token.includes('-----BEGIN CERTIFICATE-----')) {
      // Parse authentic X.509 certificate
      let cert: crypto.X509Certificate;
      try {
        cert = new crypto.X509Certificate(assertion.token);
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Malformed X.509 client certificate: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Check certificate validity period
      const now = Date.now();
      const validFrom = Date.parse(cert.validFrom);
      const validTo = Date.parse(cert.validTo);
      if (validTo < now) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'EXPIRED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Client certificate expired at '${cert.validTo}'.`,
        };
      }
      if (validFrom > now) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Client certificate not yet valid (validFrom: '${cert.validFrom}').`,
        };
      }

      // Check subject
      if (!this.allowedSubjects.includes(cert.subject)) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'ACTOR_UNAUTHORIZED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Certificate subject '${cert.subject}' is not in allowedSubjects list.`,
        };
      }

      // Check fingerprint
      const certFp256 = cert.fingerprint256.replace(/:/g, '').toUpperCase();
      const certFpSha1 = cert.fingerprint.replace(/:/g, '').toUpperCase();
      const isTrustedFp =
        this.trustedCaFingerprints.some((fp) => {
          const clean = fp.replace(/:/g, '').toUpperCase();
          return clean === certFp256 || clean === certFpSha1;
        }) ||
        this.trustedClientCertificates.some((fp) => {
          const clean = fp.replace(/:/g, '').toUpperCase();
          return clean === certFp256 || clean === certFpSha1;
        });

      if (!isTrustedFp && (this.trustedCaFingerprints.length > 0 || this.trustedClientCertificates.length > 0)) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Certificate fingerprint '${cert.fingerprint256}' is not trusted.`,
        };
      }

      const nonce = assertion.claims?.nonce;
      if (nonce && this.nonceStore) {
        try {
          const marked = await this.nonceStore.markNonceSeen(nonce);
          if (!marked) {
            return {
              isValid: false,
              isTrustedHumanAuth: false,
              status: 'REPLAY_DETECTED',
              code: 'BLOCKED_ON_AUTH_CONTEXT',
              reason: `Replay attack detected: Nonce '${nonce}' was previously used.`,
            };
          }
        } catch (err: unknown) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'UNVERIFIED',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: `Nonce state verification failed: ${err instanceof Error ? err.message : String(err)}. Rejecting fail-closed.`,
          };
        }
      }

      const claims: TrustedIdentityClaim = {
        identityId: cert.subject,
        issuer: cert.issuer,
        audience: expectedBinding.projectId,
        subject: cert.subject,
        actorRole: 'USER',
        issuedAt: cert.validFrom,
        expiresAt: cert.validTo,
        nonce: nonce ?? 'mtls-verified-channel',
        authMethod: 'MTLS',
        publicKeyFingerprint: cert.fingerprint256,
      };

      return {
        isValid: true,
        isTrustedHumanAuth: true,
        status: 'VERIFIED',
        code: 'VERIFIED_HUMAN',
        reason: 'mTLS authentic X.509 client certificate verified successfully.',
        claims,
        verifiedAt: new Date().toISOString(),
      };
    } else {
      // Rejection of unverified client claims without certificate evidence
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'mTLS verification requires an authoritative X.509 client certificate or verified TLS connection context. Client-submitted metadata cannot substitute for TLS certificate verification.',
      };
    }
  }
}

// ============================================================================
// 4. TEST DOUBLE IDENTITY PROVIDER ADAPTER (EXPLICIT FOR UNIT TESTS ONLY)
// ============================================================================

export interface TestDoubleIdentityProviderOptions {
  readonly providerId?: string;
  readonly defaultStatus?: 'VERIFIED' | 'UNVERIFIED' | 'OUTAGE';
  readonly nonceStore?: NonceStore;
}

/**
 * Dedicated test double for testing adapter mechanics.
 * Marked with isTestDouble = true and must NEVER be accepted as proof of external IdP!
 */
export class TestDoubleIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly isTestDouble = true;
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType = 'LOCAL_TEST_DOUBLE';
  private defaultStatus: 'VERIFIED' | 'UNVERIFIED' | 'OUTAGE';
  private readonly nonceStore?: NonceStore;

  constructor(options: TestDoubleIdentityProviderOptions = {}) {
    this.providerId = options.providerId ?? 'test-double-provider';
    this.defaultStatus = options.defaultStatus ?? 'VERIFIED';
    this.nonceStore = options.nonceStore;
  }

  isConfigured(): boolean {
    return true;
  }

  setStatus(status: 'VERIFIED' | 'UNVERIFIED' | 'OUTAGE'): void {
    this.defaultStatus = status;
  }

  async getHealth(): Promise<TrustedProviderHealth> {
    return {
      isHealthy: this.defaultStatus !== 'OUTAGE',
      isConfigured: true,
      providerId: this.providerId,
      providerType: this.providerType,
      message: 'Test double provider (for unit testing adapter behavior only).',
    };
  }

  async verifyAssertion(
    assertion: TrustedIdentityAssertion,
    expectedBinding: TrustedApprovalBinding,
    _options?: { dryRun?: boolean }
  ): Promise<IdentityVerificationResult> {
    if (this.defaultStatus === 'OUTAGE') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'PROVIDER_OUTAGE',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Test double simulated provider outage.',
      };
    }

    if (this.defaultStatus === 'UNVERIFIED') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Test double simulated unverified assertion.',
      };
    }

    // Binding check
    if (assertion.binding.projectId !== expectedBinding.projectId) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'Cross-project binding mismatch.',
      };
    }

    if (assertion.claims?.nonce && this.nonceStore) {
      try {
        const marked = await this.nonceStore.markNonceSeen(assertion.claims.nonce);
        if (!marked) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'REPLAY_DETECTED',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: 'Replay detected on test double.',
          };
        }
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Nonce state verification failed: ${err instanceof Error ? err.message : String(err)}. Rejecting fail-closed.`,
        };
      }
    }

    return {
      isValid: true,
      isTrustedHumanAuth: true,
      status: 'VERIFIED',
      code: 'VERIFIED_HUMAN',
      reason: 'Test double verified assertion (TEST DOUBLE ONLY).',
      claims: assertion.claims as TrustedIdentityClaim,
      verifiedAt: new Date().toISOString(),
    };
  }
}
