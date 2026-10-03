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

  async validate(context: any, currentProjectId: string): Promise<{ isValid: boolean, isTrueHumanInteraction: boolean, reason?: string }> {
    if (!context || typeof context !== 'object') {
       return { isValid: false, isTrueHumanInteraction: false, reason: 'Auth context is missing or invalid' };
    }

    if (context.isForged === true) {
        return { isValid: false, isTrueHumanInteraction: false, reason: 'Auth context is forged' };
    }
    
    if (!context.signature) {
       return { isValid: false, isTrueHumanInteraction: false, reason: 'Missing cryptographic signature' };
    }
    
    try {
      const { publicKey, identityId } = await this.identityManager.getOrCreateIdentity();
      
      const payload = { ...context };
      delete payload.signature; // remove signature for verification
      
      const isValidSig = this.identityManager.verifySignature(payload, context.signature, publicKey);
      if (!isValidSig) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Cryptographic signature verification failed' };
      }

      if (context.identityId && context.identityId !== identityId) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Identity ID mismatch' };
      }

      if (context.publicKeyFingerprint && context.publicKeyFingerprint !== this.identityManager.getPublicKeyFingerprint(publicKey)) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Public key fingerprint mismatch' };
      }

      if (context.expiresAt && new Date(context.expiresAt).getTime() < Date.now()) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Auth context is expired' };
      }
      
      if (context.projectId && context.projectId !== currentProjectId) {
          return { isValid: false, isTrueHumanInteraction: false, reason: 'Cross-project authContext binding mismatch' };
      }

      if (context.nonce) {
          const marked = await this.nonceStore.markNonceSeen(context.nonce);
          if (!marked) {
              return { isValid: false, isTrueHumanInteraction: false, reason: 'Replayed authContext nonce. Duplicate use prohibited' };
          }
      }

      // Check for true human interaction proof
      // Since Antigravity IDE cannot securely provide human interaction verification at this time,
      // true human interaction proof is lacking unless this comes from an OS-level trusted UI.
      const isTrueHumanInteraction = context.verified === true && context.authSource === 'TRUSTED_IDE';

      return { isValid: true, isTrueHumanInteraction };
    } catch (err: any) {
      return { isValid: false, isTrueHumanInteraction: false, reason: `Validation failed: ${err.message}` };
    }
  }
}
