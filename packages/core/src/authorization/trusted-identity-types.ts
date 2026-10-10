/**
 * @file trusted-identity-types.ts
 * @description P18-04 Trusted Identity Context & External Identity Provider Contract.
 *
 * Establishes the authoritative, zero-trust adapter contract for external identity
 * verification, cryptographic scope binding, anti-replay, and fail-closed security.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Client/model boolean claims (e.g. `isTrustedHumanAuth: true`, `actor: "USER"`)
 *    are NEVER accepted as proof of human identity.
 * 2. Approvals for sensitive/mandate-protected operations MUST be cryptographically
 *    bound to canonical project ID, package ID, revision, context fingerprint, and nonce.
 * 3. Without an active, verified connection to an external IdP, human approval
 *    evaluations remain strictly fail-closed in `BLOCKED_ON_AUTH_CONTEXT`.
 * 4. Tokens, bearer credentials, and private keys MUST be sanitized and masked in logs.
 * 5. Replay, reuse, expiration, and cross-context approvals are immediately rejected.
 */

import { z } from 'zod';
import { APPROVAL_ACTOR_ROLES, type ApprovalActorRole } from '../approval/approval-types.js';

// ============================================================================
// 1. CONSTANTS & STATUS CODES
// ============================================================================

export const TRUSTED_IDENTITY_PROTOCOL_VERSION = 'P18-04';
export const TRUSTED_IDENTITY_SCHEMA_VERSION = 1;

export const IDENTITY_VERIFICATION_STATUSES = [
  'VERIFIED',
  'UNVERIFIED',
  'EXPIRED',
  'REVOKED',
  'ISSUER_MISMATCH',
  'AUDIENCE_MISMATCH',
  'BINDING_MISMATCH',
  'SIGNATURE_INVALID',
  'REPLAY_DETECTED',
  'PROVIDER_OUTAGE',
  'CONFIG_MISSING',
  'ACTOR_UNAUTHORIZED',
] as const;

export type IdentityVerificationStatus = (typeof IDENTITY_VERIFICATION_STATUSES)[number];

export const TRUSTED_IDENTITY_PROVIDER_TYPES = [
  'OIDC',
  'MTLS',
  'WEBAUTHN',
  'LOCAL_TEST_DOUBLE',
  'UNCONFIGURED',
] as const;

export type TrustedIdentityProviderType = (typeof TRUSTED_IDENTITY_PROVIDER_TYPES)[number];

// ============================================================================
// 2. SCHEMAS & INTERFACES
// ============================================================================

/**
 * Verified claims extracted from a valid external identity credential.
 */
export const TrustedIdentityClaimSchema = z.object({
  identityId: z.string().min(1, 'identityId is required'),
  issuer: z.string().min(1, 'issuer is required'),
  audience: z.union([z.string().min(1), z.array(z.string().min(1))]),
  subject: z.string().min(1, 'subject is required'),
  email: z.string().email().optional(),
  actorRole: z.enum(APPROVAL_ACTOR_ROLES),
  issuedAt: z.string().min(1, 'issuedAt is required'),
  expiresAt: z.string().min(1, 'expiresAt is required'),
  notBefore: z.string().optional(),
  nonce: z.string().min(8, 'nonce must have at least 8 characters for replay defense'),
  authMethod: z.enum(TRUSTED_IDENTITY_PROVIDER_TYPES),
  publicKeyFingerprint: z.string().optional(),
});

export type TrustedIdentityClaim = z.infer<typeof TrustedIdentityClaimSchema>;

/**
 * Cryptographic scope binding: The exact boundaries the approval is authorized for.
 */
export const TrustedApprovalBindingSchema = z.object({
  projectId: z.string().min(1, 'projectId is required for canonical isolation'),
  packageId: z.string().min(1, 'packageId is required'),
  revision: z.number().int().positive('revision must be positive integer'),
  contextFingerprint: z.string().min(1, 'contextFingerprint is required to bind context freshness'),
  directorSessionId: z.string().optional(),
  taskId: z.string().optional(),
  operation: z.string().optional(),
});

export type TrustedApprovalBinding = z.infer<typeof TrustedApprovalBindingSchema>;

/**
 * Incoming external assertion submitted by human Product Owner via out-of-band flow.
 */
export const TrustedIdentityAssertionSchema = z.object({
  token: z.string().min(1, 'Assertion token or credential is required'),
  binding: TrustedApprovalBindingSchema,
  claims: TrustedIdentityClaimSchema.partial().optional(),
  authSource: z.string().optional(),
  clientMetadata: z.record(z.string(), z.unknown()).optional(),
});

export type TrustedIdentityAssertion = z.infer<typeof TrustedIdentityAssertionSchema>;

/**
 * Structured result of an identity verification attempt.
 */
export interface IdentityVerificationResult {
  readonly isValid: boolean;
  readonly isTrustedHumanAuth: boolean;
  readonly status: IdentityVerificationStatus;
  readonly code: string;
  readonly reason: string;
  readonly claims?: TrustedIdentityClaim;
  readonly verifiedAt?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Health check report for a configured identity provider.
 */
export interface TrustedProviderHealth {
  readonly isHealthy: boolean;
  readonly isConfigured: boolean;
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType;
  readonly latencyMs?: number;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The authoritative adapter interface for external identity providers.
 */
export interface ITrustedIdentityProvider {
  readonly providerId: string;
  readonly providerType: TrustedIdentityProviderType;
  isConfigured(): boolean;
  getHealth(): Promise<TrustedProviderHealth>;
  verifyAssertion(
    assertion: TrustedIdentityAssertion,
    expectedBinding: TrustedApprovalBinding,
    options?: { dryRun?: boolean }
  ): Promise<IdentityVerificationResult>;
}
