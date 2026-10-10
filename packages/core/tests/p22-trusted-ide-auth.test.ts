import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';

const expect = (actual: any) => ({
  toBe: (expected: any) => assert.equal(actual, expected),
  toEqual: (expected: any) => assert.deepEqual(actual, expected),
  toContain: (item: any) => {
    if (typeof actual === 'string') {
      assert.ok(actual.includes(item), `Expected "${actual}" to contain "${item}"`);
    } else {
      assert.ok(actual.includes(item));
    }
  },
  not: {
    toContain: (item: any) => {
      if (typeof actual === 'string') {
        assert.ok(!actual.includes(item), `Expected "${actual}" NOT to contain "${item}"`);
      } else {
        assert.ok(!actual.includes(item));
      }
    },
    toBe: (expected: any) => assert.notEqual(actual, expected),
    toEqual: (expected: any) => assert.notDeepEqual(actual, expected),
  },
  rejects: {
    toThrow: async (expectedErr?: any) => {
      await assert.rejects(
        actual,
        expectedErr ? (typeof expectedErr === 'string' ? new RegExp(expectedErr) : expectedErr) : undefined
      );
    },
  },
});

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { IdentityManager, AuthContextValidator, NonceStore } from '../dist/index.js';

describe('P22 - Trusted IDE Authentication & Cryptographic Identity', () => {
  let identityManager: IdentityManager;
  let validator: AuthContextValidator;
  let nonceStore: NonceStore;
  let testDir: string;
  let privateKey: crypto.KeyObject;
  let publicKey: crypto.KeyObject;
  let identityId: string;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), '.test-p22-' + crypto.randomUUID());
    await fs.mkdir(testDir, { recursive: true });
    
    identityManager = new IdentityManager({ baseDir: testDir });
    nonceStore = new NonceStore({ baseDir: testDir });
    validator = new AuthContextValidator(identityManager, nonceStore);

    // Initial generation
    const id = await identityManager.getOrCreateIdentity();
    privateKey = id.privateKey;
    publicKey = id.publicKey;
    identityId = id.identityId;
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  const createValidPayload = () => ({
    identityId,
    projectId: 'proj-123',
    sessionId: 'sess-123',
    taskId: 'task-123',
    nonce: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    verified: true,
    authSource: 'TRUSTED_IDE',
    publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey)
  });

  it('1. Geçerli Ed25519 imzası kabul edilir.', async () => {
    const payload = createValidPayload();
    const signature = await identityManager.signPayload(payload, privateKey);
    const authContext = { ...payload, signature };

    const result = await validator.validate(authContext, 'proj-123');
    expect(result.isValid).toBe(true);
    expect(result.isTrueHumanInteraction).toBe(true);
  });

  it('2. İmzası değiştirilmiş AuthContext reddedilir.', async () => {
    const payload = createValidPayload();
    const signature = await identityManager.signPayload(payload, privateKey);
    const authContext = { ...payload, projectId: 'hacked-proj', signature }; // tampered

    const result = await validator.validate(authContext, 'hacked-proj');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('verification failed');
  });

  it('3. Sahte PRODUCT_OWNER reddedilir (imzasız veya yanlış imzalı).', async () => {
    const payload = createValidPayload();
    const authContext = { ...payload, signature: 'fake-signature', actorRole: 'PRODUCT_OWNER' };

    const result = await validator.validate(authContext, 'proj-123');
    expect(result.isValid).toBe(false);
  });

  it('4. Sahte verified: true reddedilir.', async () => {
    const payload = createValidPayload();
    const authContext = { ...payload, isForged: true, signature: 'any' };

    const result = await validator.validate(authContext, 'proj-123');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('forged');
  });

  it('5. Sahte public key fingerprint reddedilir.', async () => {
    const payload = createValidPayload();
    payload.publicKeyFingerprint = 'fake-fingerprint';
    const signature = await identityManager.signPayload(payload, privateKey);
    
    const result = await validator.validate({ ...payload, signature }, 'proj-123');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('fingerprint mismatch');
  });

  it('6. Başka workspace/project kimliği reddedilir.', async () => {
    const payload = createValidPayload();
    const signature = await identityManager.signPayload(payload, privateKey);
    
    // Valid for proj-123, but checked against proj-999
    const result = await validator.validate({ ...payload, signature }, 'proj-999');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('mismatch');
  });

  it('9. Süresi dolmuş AuthContext reddedilir.', async () => {
    const payload = createValidPayload();
    payload.expiresAt = new Date(Date.now() - 3600000).toISOString(); // expired 1h ago
    const signature = await identityManager.signPayload(payload, privateKey);
    
    const result = await validator.validate({ ...payload, signature }, 'proj-123');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('10. Nonce replay reddedilir.', async () => {
    const payload = createValidPayload();
    const signature = await identityManager.signPayload(payload, privateKey);
    const authContext = { ...payload, signature };

    const res1 = await validator.validate(authContext, 'proj-123');
    expect(res1.isValid).toBe(true);

    const res2 = await validator.validate(authContext, 'proj-123');
    expect(res2.isValid).toBe(false);
    expect(res2.reason).toContain('Replayed');
  });

  it('11. Restart sonrası nonce replay engellenir.', async () => {
    const payload = createValidPayload();
    const signature = await identityManager.signPayload(payload, privateKey);
    const authContext = { ...payload, signature };

    const res1 = await validator.validate(authContext, 'proj-123');
    expect(res1.isValid).toBe(true);

    // Simulate restart by re-instantiating the store
    const newStore = new NonceStore({ baseDir: testDir });
    const newValidator = new AuthContextValidator(identityManager, newStore);
    
    const res2 = await newValidator.validate(authContext, 'proj-123');
    expect(res2.isValid).toBe(false);
    expect(res2.reason).toContain('Replayed');
  });

  it('12. İptal edilmiş kimlik reddedilir.', async () => {
    await identityManager.revokeIdentity();
    
    await expect(identityManager.getOrCreateIdentity()).rejects.toThrow('revoked');
    
    const payload = createValidPayload();
    // Validate will fail because getOrCreateIdentity throws
    const result = await validator.validate({ ...payload, signature: 'abc' }, 'proj-123');
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('13. Geçersiz veya eksik imza reddedilir.', async () => {
    const payload = createValidPayload();
    const result = await validator.validate(payload, 'proj-123'); // No signature
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain('Missing');
  });

  it('15. Private key plaintext dosyada saklanmaz (Windows DPAPI kontrolü).', async () => {
    const stateFile = path.join(testDir, '.ai-manager', 'state', 'identity.json');
    const content = await fs.readFile(stateFile, 'utf8');
    expect(content).not.toContain('PRIVATE KEY');
    expect(content).toContain('encryptedPrivateKeyPem');
  });

  it('21. Restart sonrası güvenli kimlik yüklenir.', async () => {
    const newManager = new IdentityManager({ baseDir: testDir });
    const { identityId: id2 } = await newManager.getOrCreateIdentity();
    expect(id2).toBe(identityId);
  });
});
