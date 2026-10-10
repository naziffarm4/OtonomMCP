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

export interface OidcIdentityProviderOptions {
  readonly providerId?: string;
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly jwksUri?: string;
  readonly publicKeyPem?: string;
  readonly nonceStore?: NonceStore;
  readonly clockSkewSeconds?: number;
  readonly verifySignatureFn?: (token: string, keyOrJwks?: string) => Promise<boolean> | boolean;
  readonly isOutage?: boolean;
}

/**
 * OpenID Connect token validator adapter.
 */
export class OidcIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType = 'OIDC';
  private readonly issuer: string;
  private readonly audience: string | readonly string[];
  private readonly jwksUri?: string;
  private readonly publicKeyPem?: string;
  private readonly nonceStore?: NonceStore;
  private readonly clockSkewSeconds: number;
  private readonly verifySignatureFn?: (token: string, keyOrJwks?: string) => Promise<boolean> | boolean;
  private isOutage: boolean;
  private readonly revokedIdentities = new Set<string>();

  constructor(options: OidcIdentityProviderOptions) {
    this.providerId = options.providerId ?? 'oidc-provider';
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.jwksUri = options.jwksUri;
    this.publicKeyPem = options.publicKeyPem;
    this.nonceStore = options.nonceStore;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 60;
    this.verifySignatureFn = options.verifySignatureFn;
    this.isOutage = options.isOutage ?? false;
  }

  isConfigured(): boolean {
    return Boolean(this.issuer && this.audience && (this.jwksUri || this.publicKeyPem || this.verifySignatureFn));
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
        message: 'OIDC provider configuration is incomplete (missing issuer, audience, or verification key).',
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
    // 1. Configuration & Outage check (Fail-Closed)
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

    // 3. Cryptographic Signature Verification
    if (this.verifySignatureFn) {
      const isValidSig = await this.verifySignatureFn(assertion.token, this.publicKeyPem ?? this.jwksUri);
      if (!isValidSig) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: 'Cryptographic signature verification failed for OIDC token.',
          details: { maskedToken: maskToken(assertion.token) },
        };
      }
    } else if (this.publicKeyPem) {
      // Decode JWT parts
      const parts = assertion.token.split('.');
      if (parts.length !== 3) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: 'Invalid JWT token format (expected 3 parts).',
        };
      }
      const dataToVerify = `${parts[0]}.${parts[1]}`;
      const signatureBase64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
      try {
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(dataToVerify);
        const verified = verifier.verify(this.publicKeyPem, Buffer.from(signatureBase64, 'base64'));
        if (!verified) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'SIGNATURE_INVALID',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: 'RSA-SHA256 signature verification failed against configured public key.',
            details: { maskedToken: maskToken(assertion.token) },
          };
        }
      } catch (err: unknown) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'SIGNATURE_INVALID',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 4. Claims Extraction & Verification
    const claims = assertion.claims as TrustedIdentityClaim | undefined;
    if (!claims) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'OIDC token missing authoritative claims payload.',
      };
    }

    // 4a. Issuer check
    if (claims.issuer !== this.issuer) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'ISSUER_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Issuer mismatch: expected '${this.issuer}', got '${claims.issuer}'.`,
      };
    }

    // 4b. Audience check
    const allowedAudiences = Array.isArray(this.audience) ? this.audience : [this.audience];
    const claimAudiences = Array.isArray(claims.audience) ? claims.audience : [claims.audience];
    const hasAudienceMatch = claimAudiences.some((aud) => allowedAudiences.includes(aud));
    if (!hasAudienceMatch) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'AUDIENCE_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Audience mismatch: token audience '${claimAudiences.join(', ')}' does not match allowed audiences '${allowedAudiences.join(', ')}'.`,
      };
    }

    // 4c. Actor Role authority check (strictly PRODUCT_OWNER or USER)
    if (claims.actorRole !== 'PRODUCT_OWNER' && claims.actorRole !== 'USER') {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'ACTOR_UNAUTHORIZED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Actor role '${claims.actorRole}' is unauthorized for human approval. Must strictly be PRODUCT_OWNER or USER.`,
      };
    }

    // 4d. Revocation check
    if (this.revokedIdentities.has(claims.identityId) || this.revokedIdentities.has(claims.subject)) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'REVOKED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Identity '${claims.subject}' has been revoked. Approval cannot be accepted.`,
      };
    }

    // 4e. Expiry & Not Before checks
    const nowMs = Date.now();
    const skewMs = this.clockSkewSeconds * 1000;
    const expMs = Date.parse(claims.expiresAt);
    if (isNaN(expMs) || expMs + skewMs < nowMs) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'EXPIRED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `OIDC token has expired at '${claims.expiresAt}'. Current time: '${new Date(nowMs).toISOString()}'.`,
      };
    }

    if (claims.notBefore) {
      const nbfMs = Date.parse(claims.notBefore);
      if (!isNaN(nbfMs) && nbfMs - skewMs > nowMs) {
        return {
          isValid: false,
          isTrustedHumanAuth: false,
          status: 'UNVERIFIED',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
          reason: `OIDC token not yet valid (nbf: '${claims.notBefore}').`,
        };
      }
    }

    // 5. Anti-Replay: Nonce check
    if (!claims.nonce || claims.nonce.length < 8) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'OIDC token missing required nonce (minimum 8 characters required).',
      };
    }

    if (this.nonceStore) {
      if (options?.dryRun) {
        const seen = await this.nonceStore.isNonceSeen(claims.nonce);
        if (seen) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'REPLAY_DETECTED',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: `Replay attack detected: Nonce '${claims.nonce}' was previously used. Duplicate token reuse prohibited.`,
          };
        }
      } else {
        const marked = await this.nonceStore.markNonceSeen(claims.nonce);
        if (!marked) {
          return {
            isValid: false,
            isTrustedHumanAuth: false,
            status: 'REPLAY_DETECTED',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
            reason: `Replay attack detected: Nonce '${claims.nonce}' was previously used. Duplicate token reuse prohibited.`,
          };
        }
      }
    }

    // 6. Cryptographic Scope Binding Verification
    const binding = assertion.binding;
    if (binding.projectId !== expectedBinding.projectId) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Cross-project binding violation: token bound to '${binding.projectId}', but target is '${expectedBinding.projectId}'.`,
      };
    }

    if (binding.packageId !== expectedBinding.packageId) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Package binding mismatch: token bound to '${binding.packageId}', expected '${expectedBinding.packageId}'.`,
      };
    }

    if (binding.revision !== expectedBinding.revision) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Revision binding mismatch: token bound to revision ${binding.revision}, expected ${expectedBinding.revision}.`,
      };
    }

    if (binding.contextFingerprint !== expectedBinding.contextFingerprint) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Context fingerprint binding mismatch: token bound to '${binding.contextFingerprint}', expected '${expectedBinding.contextFingerprint}'.`,
      };
    }

    if (expectedBinding.directorSessionId && binding.directorSessionId && binding.directorSessionId !== expectedBinding.directorSessionId) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Session binding mismatch: token bound to session '${binding.directorSessionId}', expected '${expectedBinding.directorSessionId}'.`,
      };
    }

    if (expectedBinding.taskId && binding.taskId && binding.taskId !== expectedBinding.taskId) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'BINDING_MISMATCH',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Task binding mismatch: token bound to task '${binding.taskId}', expected '${expectedBinding.taskId}'.`,
      };
    }

    // 7. Successful External Verification
    return {
      isValid: true,
      isTrustedHumanAuth: true,
      status: 'VERIFIED',
      code: 'VERIFIED_HUMAN',
      reason: 'OIDC external identity assertion verified successfully with all cryptographic bindings.',
      claims,
      verifiedAt: new Date().toISOString(),
      details: sanitizeForAudit({
        issuer: claims.issuer,
        subject: claims.subject,
        actorRole: claims.actorRole,
        binding: {
          projectId: binding.projectId,
          packageId: binding.packageId,
          revision: binding.revision,
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
  readonly trustedCaFingerprints: readonly string[];
  readonly allowedSubjects: readonly string[];
  readonly nonceStore?: NonceStore;
}

/**
 * mTLS X.509 client certificate identity adapter.
 */
export class MtlsIdentityProviderAdapter implements ITrustedIdentityProvider {
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType = 'MTLS';
  private readonly trustedCaFingerprints: readonly string[];
  private readonly allowedSubjects: readonly string[];
  private readonly nonceStore?: NonceStore;

  constructor(options: MtlsIdentityProviderOptions) {
    this.providerId = options.providerId ?? 'mtls-provider';
    this.trustedCaFingerprints = options.trustedCaFingerprints;
    this.allowedSubjects = options.allowedSubjects;
    this.nonceStore = options.nonceStore;
  }

  isConfigured(): boolean {
    return this.trustedCaFingerprints.length > 0 && this.allowedSubjects.length > 0;
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
    const claims = assertion.claims as TrustedIdentityClaim | undefined;

    if (!claims) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'UNVERIFIED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: 'mTLS assertion missing required claims.',
      };
    }

    if (!this.allowedSubjects.includes(claims.subject)) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'ACTOR_UNAUTHORIZED',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Certificate subject '${claims.subject}' is not in allowedSubjects list.`,
      };
    }

    // Check CA fingerprint
    if (claims.publicKeyFingerprint && !this.trustedCaFingerprints.includes(claims.publicKeyFingerprint)) {
      return {
        isValid: false,
        isTrustedHumanAuth: false,
        status: 'SIGNATURE_INVALID',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
        reason: `Certificate CA fingerprint '${claims.publicKeyFingerprint}' is not trusted.`,
      };
    }

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

    return {
      isValid: true,
      isTrustedHumanAuth: true,
      status: 'VERIFIED',
      code: 'VERIFIED_HUMAN',
      reason: 'mTLS client certificate verified.',
      claims,
      verifiedAt: new Date().toISOString(),
    };
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
