import { IdentityManager } from './identity-manager.js';
import { NonceStore } from './nonce-store.js';
import {
  type ITrustedIdentityProvider,
  type TrustedIdentityAssertion,
  type IdentityVerificationResult,
  type TrustedIdentityClaim,
} from './trusted-identity-types.js';
import { UnconfiguredIdentityProviderAdapter } from './trusted-identity-adapters.js';

export interface ValidatedAuthContext {
  identityId?: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  instanceId?: string;
  actorType?: string;
  actorRole?: string;
  issuedAt?: string;
  expiresAt?: string;
  nonce?: string;
  publicKeyFingerprint?: string;
  authenticationMethod?: string;
  signature?: string;
  protocolVersion?: number;
  verified?: boolean;
  authSource?: string;
  isForged?: boolean;
  token?: string;
  binding?: {
    projectId: string;
    packageId: string;
    revision: number;
    contextFingerprint: string;
    directorSessionId?: string;
    taskId?: string;
    operation?: string;
  };
  claims?: Partial<TrustedIdentityClaim>;
}

export class AuthContextValidator {
  private readonly identityManager: IdentityManager;
  private readonly nonceStore: NonceStore;
  private readonly identityProvider: ITrustedIdentityProvider;

  constructor(
    identityManager: IdentityManager,
    nonceStore: NonceStore,
    identityProvider?: ITrustedIdentityProvider
  ) {
    this.identityManager = identityManager;
    this.nonceStore = nonceStore;
    this.identityProvider = identityProvider ?? new UnconfiguredIdentityProviderAdapter();
  }

  getIdentityProvider(): ITrustedIdentityProvider {
    return this.identityProvider;
  }

  async validate(
    context: unknown,
    currentProjectId: string
  ): Promise<{
    isValid: boolean;
    isTrueHumanInteraction: boolean;
    reason?: string;
    code?: string;
    claims?: TrustedIdentityClaim;
  }> {
    if (!context || typeof context !== 'object') {
      return {
        isValid: false,
        isTrueHumanInteraction: false,
        reason: 'Auth context is missing or invalid',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
      };
    }

    const ctx = context as ValidatedAuthContext & Record<string, unknown>;

    if (ctx.isForged === true) {
      return {
        isValid: false,
        isTrueHumanInteraction: false,
        reason: 'Auth context is forged',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
      };
    }

    // Branch A: If an external assertion is provided (token & binding) or if an explicit provider is configured
    if (ctx.token && typeof ctx.token === 'string' && ctx.binding) {
      const assertion: TrustedIdentityAssertion = {
        token: ctx.token,
        binding: {
          projectId: ctx.binding.projectId ?? currentProjectId,
          packageId: ctx.binding.packageId,
          revision: ctx.binding.revision,
          contextFingerprint: ctx.binding.contextFingerprint,
          directorSessionId: ctx.binding.directorSessionId,
          taskId: ctx.binding.taskId,
          operation: ctx.binding.operation,
        },
        claims: ctx.claims,
        authSource: (ctx.authSource as string) ?? 'EXTERNAL_IDP',
      };

      try {
        const result: IdentityVerificationResult = await this.identityProvider.verifyAssertion(assertion, {
          projectId: currentProjectId,
          packageId: ctx.binding.packageId,
          revision: ctx.binding.revision,
          contextFingerprint: ctx.binding.contextFingerprint,
          directorSessionId: ctx.binding.directorSessionId,
          taskId: ctx.binding.taskId,
          operation: ctx.binding.operation,
        });

        return {
          isValid: result.isValid,
          isTrueHumanInteraction: result.isTrustedHumanAuth,
          reason: result.reason,
          code: result.code,
          claims: result.claims,
        };
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return {
          isValid: false,
          isTrueHumanInteraction: false,
          reason: `External identity verification failed: ${errMessage}`,
          code: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      }
    }

    // Branch B: Local Ed25519 payload verification
    if (!ctx.signature) {
      return {
        isValid: false,
        isTrueHumanInteraction: false,
        reason: 'Missing cryptographic signature',
        code: 'BLOCKED_ON_AUTH_CONTEXT',
      };
    }

    try {
      const { publicKey, identityId } = await this.identityManager.getOrCreateIdentity();

      const payload: Record<string, unknown> = { ...ctx };
      delete payload.signature; // remove signature for verification

      const isValidSig = this.identityManager.verifySignature(payload, ctx.signature, publicKey);
      if (!isValidSig) {
        return {
          isValid: false,
          isTrueHumanInteraction: false,
          reason: 'Cryptographic signature verification failed',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      }

      if (ctx.identityId && ctx.identityId !== identityId) {
        return {
          isValid: false,
          isTrueHumanInteraction: false,
          reason: 'Identity ID mismatch',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      }

      if (
        ctx.publicKeyFingerprint &&
        ctx.publicKeyFingerprint !== this.identityManager.getPublicKeyFingerprint(publicKey)
      ) {
        return {
          isValid: false,
          isTrueHumanInteraction: false,
          reason: 'Public key fingerprint mismatch',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      }

      if (ctx.expiresAt && new Date(ctx.expiresAt).getTime() < Date.now()) {
        return {
          isValid: false,
          isTrueHumanInteraction: false,
          reason: 'Auth context is expired',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      }

      if (ctx.projectId && ctx.projectId !== currentProjectId) {
        return {
          isValid: false,
          isTrueHumanInteraction: false,
          reason: 'Cross-project authContext binding mismatch',
          code: 'BLOCKED_ON_AUTH_CONTEXT',
        };
      }

      if (ctx.nonce) {
        const marked = await this.nonceStore.markNonceSeen(ctx.nonce);
        if (!marked) {
          return {
            isValid: false,
            isTrueHumanInteraction: false,
            reason: 'Replayed authContext nonce. Duplicate use prohibited',
            code: 'BLOCKED_ON_AUTH_CONTEXT',
          };
        }
      }

      // Check for true human interaction proof
      // When an external provider is configured, local signatures are NOT external human proofs.
      // For backwards compatibility with P22 tests where TRUSTED_IDE is tested against the local engine:
      let isTrueHumanInteraction = false;
      if (this.identityProvider.isConfigured()) {
        isTrueHumanInteraction = false;
      } else {
        isTrueHumanInteraction = ctx.verified === true && ctx.authSource === 'TRUSTED_IDE';
      }

      return { isValid: true, isTrueHumanInteraction };
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        isTrueHumanInteraction: false,
        reason: `Validation failed: ${errMessage}`,
        code: 'BLOCKED_ON_AUTH_CONTEXT',
      };
    }
  }
}
