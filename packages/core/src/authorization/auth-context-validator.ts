import { IdentityManager } from './identity-manager.js';
import { NonceStore } from './nonce-store.js';

export interface ValidatedAuthContext {
  identityId?: string;
  workspaceId?: string;
  projectId?: string;
  instanceId?: string;
  actorType?: string;
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
}

export class AuthContextValidator {
  private readonly identityManager: IdentityManager;
  private readonly nonceStore: NonceStore;

  constructor(identityManager: IdentityManager, nonceStore: NonceStore) {
    this.identityManager = identityManager;
    this.nonceStore = nonceStore;
  }

  async validate(context: unknown, currentProjectId: string): Promise<{ isValid: boolean, isTrueHumanInteraction: boolean, reason?: string }> {
    if (!context || typeof context !== 'object') {
       return { isValid: false, isTrueHumanInteraction: false, reason: 'Auth context is missing or invalid' };
    }

    const ctx = context as ValidatedAuthContext & Record<string, unknown>;

    if (ctx.isForged === true) {
        return { isValid: false, isTrueHumanInteraction: false, reason: 'Auth context is forged' };
    }
    
    if (!ctx.signature) {
       return { isValid: false, isTrueHumanInteraction: false, reason: 'Missing cryptographic signature' };
    }
    
    try {
      const { publicKey, identityId } = await this.identityManager.getOrCreateIdentity();
      
      const payload: Record<string, unknown> = { ...ctx };
      delete payload.signature; // remove signature for verification
      
      const isValidSig = this.identityManager.verifySignature(payload, ctx.signature, publicKey);
      if (!isValidSig) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Cryptographic signature verification failed' };
      }

      if (ctx.identityId && ctx.identityId !== identityId) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Identity ID mismatch' };
      }

      if (ctx.publicKeyFingerprint && ctx.publicKeyFingerprint !== this.identityManager.getPublicKeyFingerprint(publicKey)) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Public key fingerprint mismatch' };
      }

      if (ctx.expiresAt && new Date(ctx.expiresAt).getTime() < Date.now()) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Auth context is expired' };
      }
      
      if (ctx.projectId && ctx.projectId !== currentProjectId) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Cross-project authContext binding mismatch' };
      }

      if (ctx.nonce) {
          const marked = await this.nonceStore.markNonceSeen(ctx.nonce);
          if (!marked) {
              return { isValid: false, isTrueHumanInteraction: false, reason: 'Replayed authContext nonce. Duplicate use prohibited' };
          }
      }

      // Check for true human interaction proof
      // Since Antigravity IDE cannot securely provide human interaction verification at this time,
      // true human interaction proof is lacking unless this comes from an OS-level trusted UI.
      const isTrueHumanInteraction = ctx.verified === true && ctx.authSource === 'TRUSTED_IDE';

      return { isValid: true, isTrueHumanInteraction };
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return { isValid: false, isTrueHumanInteraction: false, reason: `Validation failed: ${errMessage}` };
    }
  }
}
