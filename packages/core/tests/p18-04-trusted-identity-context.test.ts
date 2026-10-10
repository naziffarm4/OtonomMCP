/**
 * @file p18-04-trusted-identity-context.test.ts
 * @description Phase 18 TASK-P18-04 Trusted Identity Context & External IdP Integration Test Suite.
 *
 * Verifies all security criteria for the Trusted Identity Context boundary:
 * 1. Valid approval with matching cryptographic scope binding (OIDC assertion).
 * 2. Wrong issuer or audience fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 3. Invalid or tampered cryptographic signature fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 4. Expired approval token fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 5. Revoked identity fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 6. Cross-project, cross-task, cross-session, or revision mismatch fails closed.
 * 7. Replay / nonce reuse attempts fail closed with REPLAY_DETECTED.
 * 8. Missing provider configuration (default unconfigured state) fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 9. Provider outage / network failure fails closed with BLOCKED_ON_AUTH_CONTEXT.
 * 10. Anti-spoofing: Client cannot self-declare isTrustedHumanAuth: true or authStatus: VERIFIED_HUMAN.
 * 11. Unauthorized actors (DIRECTOR, EXECUTOR) are strictly rejected.
 * 12. Reconnect / resume preserves approval context bindings across sessions.
 * 13. Test double classification: TestDoubleIdentityProviderAdapter is explicitly isolated.
 * 14. Sensitive credentials and raw JWTs are sanitized in audit events.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as https from 'node:https';

import {
  HumanApprovalEngine,
  ApprovalStore,
  ApprovalPackageEngine,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  HistoryManager,
  DurableStateManager,
  NonceStore,
  withInProcessLock,
  inProcessLockQueues,
  withCrossProcessNonceLock,
  OidcIdentityProviderAdapter,
  MtlsIdentityProviderAdapter,
  UnconfiguredIdentityProviderAdapter,
  TestDoubleIdentityProviderAdapter,
  fetchSecureJwks,
  isPrivateOrSpecialIp,
  validateJwksHostDns,
  validateJwksUri,
  maskToken,
  sanitizeForAudit,
  ExecutionBridge,
  createFrozenBridgeExecutionIntent,
  type ApprovalPackage,
  type DirectorSession,
  type DirectorContextSnapshot,
  type TrustedIdentityAssertion,
  type TrustedApprovalBinding,
  type TrustedIdentityClaim,
} from '../dist/index.js';

describe('Phase 18 TASK-P18-04 — Trusted Identity Context Architecture & Verification', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let approvalStore: ApprovalStore;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let packageEngine: ApprovalPackageEngine;
  let nonceStore: NonceStore;

  // RSA Key pair for OIDC tests
  let rsaPublicKeyPem: string;
  let rsaPrivateKeyPem: string;

  const projectId = 'proj-trusted-identity-test';
  const directorSessionId = 'sess-trusted-identity-01';
  const contextFingerprint = 'ctx-fp-sha256-authoritative-baseline-999';

  function createSignedJwt(
    payload: Record<string, unknown>,
    privateKeyPem: string,
    binding?: TrustedApprovalBinding | Record<string, unknown>,
    headerOverrides?: Record<string, unknown>
  ): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', ...headerOverrides })
    ).toString('base64url');
    const fullPayload = binding ? { ...payload, binding } : payload;
    const body = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const data = `${header}.${body}`;
    if (headerOverrides?.alg === 'none') {
      return `${data}.`;
    }
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(data);
    const signature = signer.sign(privateKeyPem).toString('base64url');
    return `${data}.${signature}`;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p18-04-trusted-id-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: projectId, version: '1.0.0' }, null, 2),
      'utf8'
    );
    await fs.mkdir(path.join(tempDir, '.ai-manager', 'state'), { recursive: true });

    historyManager = new HistoryManager({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    packageEngine = new ApprovalPackageEngine();
    nonceStore = new NonceStore({ baseDir: tempDir });

    const rsaKeys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    rsaPublicKeyPem = rsaKeys.publicKey;
    rsaPrivateKeyPem = rsaKeys.privateKey;

    // Create active director session and snapshot
    const activeSession = await sessionEngine.createSession({
      directorSessionId,
      workspaceRoot: tempDir,
      projectId,
      understandingRevision: 1,
    });

    const snapshot: DirectorContextSnapshot = {
      directorSessionId: activeSession.directorSessionId,
      projectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      logicalFingerprint: contextFingerprint,
      syncStatus: 'UNCHANGED',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      sectionMetadata: {} as any,
      sections: {} as any,
      isDerived: true,
    };
    await sessionStore.saveSnapshot(snapshot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function createMockPackage(options: { status?: 'READY_FOR_APPROVAL' | 'APPROVED' } = {}): Promise<ApprovalPackage> {
    const status = options.status ?? 'READY_FOR_APPROVAL';
    const now = new Date().toISOString();
    const pkg: ApprovalPackage = {
      packageId: 'pkg-p18-04-001',
      projectId,
      revision: 1,
      approvalPackageRevision: 1,
      status,
      createdAt: now,
      updatedAt: now,
      isStale: false,
      projectUnderstanding: {
        projectId,
        projectName: 'Trusted Identity Service',
        apparentPurpose: { summary: 'Service with trusted IdP boundaries' } as any,
        targetUsers: ['Engineers'],
        technologyStack: { languages: ['TypeScript'], framework: 'Node.js', runtime: 'Node' } as any,
        architectureSummary: { pattern: 'Zero-Trust Architecture' } as any,
        existingCapabilities: [],
        confirmedRequirements: [],
        clarifiedRequirements: [],
        unresolvedUnknowns: [],
        unresolvedContradictions: [],
        currentImplementationState: { state: 'IN_PROGRESS' } as any,
        constraints: [],
        assumptions: [],
        nonGoals: [],
        proposedDevelopmentScope: ['src/index.ts'],
        evidenceReferences: [],
        sourceDiscoveryReference: 'disc-ref-01',
        generatedAt: now,
      },
      proposedDevelopmentPlan: {
        objectives: ['Deploy trusted identity adapter'],
        proposedScope: ['src/index.ts'],
        proposedFeatureGroups: [],
        dependencies: [],
        constraints: [],
        knownRisks: [],
        unresolvedIssues: [],
        excludedScope: [],
        suggestedImplementationOrder: [],
      },
      approvalRecord:
        status === 'APPROVED'
          ? {
              packageId: 'pkg-p18-04-001',
              revision: 1,
              actor: 'human-product-owner',
              actorRole: 'PRODUCT_OWNER',
              intent: 'EXPLICIT_APPROVAL',
              approvedAt: now,
              packageHash: 'sha256-dummy-pkg-hash-p18',
              comment: 'Authorized via trusted identity suite',
            }
          : undefined,
    };

    await approvalStore.savePackage(pkg);
    return pkg;
  }

  // ==========================================================================
  // 1. VALID APPROVAL WITH MATCHING OIDC ASSERTION
  // ==========================================================================
  it('TEST 1: Valid OIDC assertion with matching cryptographic scope binding is verified successfully', async () => {
    const pkg = await createMockPackage();

    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const engine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      approvalStore,
      approvalPackageEngine: packageEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
      identityProvider: oidcAdapter,
    });

    const nonce = `nonce-${crypto.randomUUID()}`;
    const claims: TrustedIdentityClaim = {
      identityId: 'id-human-po-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice-product-owner@company.corp',
      email: 'alice-product-owner@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce,
      authMethod: 'OIDC',
    };

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint,
      directorSessionId,
    };

    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);
    const assertion: TrustedIdentityAssertion = {
      token,
      binding,
      claims,
    };

    const result = await engine.submitApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint,
      understandingRevision: 1,
      actor: 'alice-product-owner@company.corp',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Verified with corporate SSO hardware passkey',
      trustedAssertion: assertion as unknown as Record<string, unknown>,
    });

    assert.equal(result.package.status, 'APPROVED');
    assert.equal(result.isDevelopmentAuthorized, true);
    assert.equal(result.approvalRecord.isTrustedHumanAuth, true);
    assert.equal(result.approvalRecord.authStatus, 'VERIFIED_HUMAN');
    assert.equal(result.approvalRecord.provenanceSource, 'TRUSTED_EXTERNAL_IDP');

    // Verify stored package
    const saved = await approvalStore.loadPackage(pkg.packageId);
    assert.equal(saved?.approvalRecord?.isTrustedHumanAuth, true);
    assert.equal(saved?.approvalRecord?.authStatus, 'VERIFIED_HUMAN');
  });

  // ==========================================================================
  // 2. WRONG ISSUER OR AUDIENCE -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 2: Wrong issuer or audience fails closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-1',
      revision: 1,
      contextFingerprint,
    };

    // 2a. Wrong issuer
    const claimsWrongIssuer: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://rogue-identity.attacker.com',
      audience: 'aidm-core-platform',
      subject: 'attacker@evil.com',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const resWrongIssuer = await oidcAdapter.verifyAssertion(
      { token: createSignedJwt(claimsWrongIssuer, rsaPrivateKeyPem, binding), binding, claims: claimsWrongIssuer },
      binding
    );
    assert.equal(resWrongIssuer.isValid, false);
    assert.equal(resWrongIssuer.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(resWrongIssuer.status, 'ISSUER_MISMATCH');

    // 2b. Wrong audience
    const claimsWrongAudience: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'unrelated-client-id',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const resWrongAudience = await oidcAdapter.verifyAssertion(
      { token: createSignedJwt(claimsWrongAudience, rsaPrivateKeyPem, binding), binding, claims: claimsWrongAudience },
      binding
    );
    assert.equal(resWrongAudience.isValid, false);
    assert.equal(resWrongAudience.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(resWrongAudience.status, 'AUDIENCE_MISMATCH');
  });

  // ==========================================================================
  // 3. TAMPERED / INVALID CRYPTOGRAPHIC SIGNATURE -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 3: Invalid cryptographic signature fails closed with SIGNATURE_INVALID and BLOCKED_ON_AUTH_CONTEXT', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-1',
      revision: 1,
      contextFingerprint,
    };

    // Sign with an untrusted key
    const rogueKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const roguePrivateKeyPem = rogueKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    const forgedToken = createSignedJwt(claims, roguePrivateKeyPem, binding);

    const result = await oidcAdapter.verifyAssertion(
      { token: forgedToken, binding, claims },
      binding
    );

    assert.equal(result.isValid, false);
    assert.equal(result.isTrustedHumanAuth, false);
    assert.equal(result.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(result.status, 'SIGNATURE_INVALID');
  });

  // ==========================================================================
  // 4. EXPIRED APPROVAL TOKEN -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 4: Expired approval token fails closed with EXPIRED and BLOCKED_ON_AUTH_CONTEXT', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
      clockSkewSeconds: 0,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-1',
      revision: 1,
      contextFingerprint,
    };

    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired in past
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);
    const result = await oidcAdapter.verifyAssertion({ token, binding, claims }, binding);

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(result.status, 'EXPIRED');
  });

  // ==========================================================================
  // 5. REVOKED IDENTITY -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 5: Revoked identity fails closed with REVOKED and BLOCKED_ON_AUTH_CONTEXT', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const revokedSub = 'compromised-user@company.corp';
    oidcAdapter.revokeIdentity(revokedSub);

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-1',
      revision: 1,
      contextFingerprint,
    };

    const claims: TrustedIdentityClaim = {
      identityId: 'id-compromised',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: revokedSub,
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);
    const result = await oidcAdapter.verifyAssertion({ token, binding, claims }, binding);

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(result.status, 'REVOKED');
  });

  // ==========================================================================
  // 6. BINDING MISMATCH (CROSS-PROJECT, REVISION, OR FINGERPRINT) -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 6: Binding mismatch (cross-project, revision, or context fingerprint) fails closed', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const makeAssertion = (binding: TrustedApprovalBinding) => {
      const claims: TrustedIdentityClaim = {
        identityId: 'id-01',
        issuer: 'https://auth.company.corp',
        audience: 'aidm-core-platform',
        subject: 'alice@company.corp',
        actorRole: 'PRODUCT_OWNER',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        nonce: `nonce-${crypto.randomUUID()}`,
        authMethod: 'OIDC',
      };
      const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);
      return { token, binding, claims };
    };

    // 6a. Cross-project binding mismatch
    const resProjectMismatch = await oidcAdapter.verifyAssertion(
      makeAssertion({ projectId: 'project-attacker-b', packageId: 'pkg-1', revision: 1, contextFingerprint }),
      { projectId: 'project-target-a', packageId: 'pkg-1', revision: 1, contextFingerprint }
    );
    assert.equal(resProjectMismatch.isValid, false);
    assert.equal(resProjectMismatch.status, 'BINDING_MISMATCH');
    assert.equal(resProjectMismatch.code, 'BLOCKED_ON_AUTH_CONTEXT');

    // 6b. Revision mismatch
    const resRevMismatch = await oidcAdapter.verifyAssertion(
      makeAssertion({ projectId, packageId: 'pkg-1', revision: 1, contextFingerprint }),
      { projectId, packageId: 'pkg-1', revision: 2, contextFingerprint }
    );
    assert.equal(resRevMismatch.isValid, false);
    assert.equal(resRevMismatch.status, 'BINDING_MISMATCH');
    assert.equal(resRevMismatch.code, 'BLOCKED_ON_AUTH_CONTEXT');

    // 6c. Context fingerprint mismatch
    const resFpMismatch = await oidcAdapter.verifyAssertion(
      makeAssertion({ projectId, packageId: 'pkg-1', revision: 1, contextFingerprint: 'fp-stale' }),
      { projectId, packageId: 'pkg-1', revision: 1, contextFingerprint: 'fp-fresh' }
    );
    assert.equal(resFpMismatch.isValid, false);
    assert.equal(resFpMismatch.status, 'BINDING_MISMATCH');
    assert.equal(resFpMismatch.code, 'BLOCKED_ON_AUTH_CONTEXT');
  });

  // ==========================================================================
  // 7. REPLAY & NONCE REUSE PROTECTION -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 7: Replay and nonce reuse attempts fail closed with REPLAY_DETECTED', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-1',
      revision: 1,
      contextFingerprint,
    };

    const replayedNonce = `replayed-nonce-${crypto.randomUUID()}`;
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: replayedNonce,
      authMethod: 'OIDC',
    };

    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    // First use succeeds
    const firstUse = await oidcAdapter.verifyAssertion({ token, binding, claims }, binding);
    assert.equal(firstUse.isValid, true);
    assert.equal(firstUse.status, 'VERIFIED');

    // Second use with identical nonce MUST fail closed
    const secondUse = await oidcAdapter.verifyAssertion({ token, binding, claims }, binding);
    assert.equal(secondUse.isValid, false);
    assert.equal(secondUse.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(secondUse.status, 'REPLAY_DETECTED');
  });

  // ==========================================================================
  // 8. UNCONFIGURED PROVIDER (DEFAULT STATE) -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 8: Unconfigured identity provider strictly fails closed with CONFIG_MISSING and BLOCKED_ON_AUTH_CONTEXT', async () => {
    const unconfigured = new UnconfiguredIdentityProviderAdapter();
    assert.equal(unconfigured.isConfigured(), false);

    const health = await unconfigured.getHealth();
    assert.equal(health.isHealthy, false);
    assert.equal(health.isConfigured, false);

    const res = await unconfigured.verifyAssertion(
      {
        token: 'any-token',
        binding: { projectId, packageId: 'pkg-1', revision: 1, contextFingerprint },
      },
      { projectId, packageId: 'pkg-1', revision: 1, contextFingerprint }
    );

    assert.equal(res.isValid, false);
    assert.equal(res.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(res.status, 'CONFIG_MISSING');
  });

  // ==========================================================================
  // 9. PROVIDER OUTAGE / UNREACHABLE -> FAIL-CLOSED
  // ==========================================================================
  it('TEST 9: Provider outage / network failure fails closed with PROVIDER_OUTAGE and BLOCKED_ON_AUTH_CONTEXT', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
      isOutage: true, // Simulating IdP endpoint timeout
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-1',
      revision: 1,
      contextFingerprint,
    };

    const res = await oidcAdapter.verifyAssertion(
      { token: 'some-token', binding },
      binding
    );

    assert.equal(res.isValid, false);
    assert.equal(res.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(res.status, 'PROVIDER_OUTAGE');

    const health = await oidcAdapter.getHealth();
    assert.equal(health.isHealthy, false);
  });

  // ==========================================================================
  // 10. ANTI-SPOOFING: CLIENT BOOLEAN DECLARATION CANNOT SELF-AUTHORIZE
  // ==========================================================================
  it('TEST 10: Client self-declaring isTrustedHumanAuth: true without external IdP assertion is rejected fail-closed', async () => {
    const pkg = await createMockPackage();

    // Default engine with unconfigured IdP
    const engine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      approvalStore,
      approvalPackageEngine: packageEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
    });

    // 10a. Dry-run validation rejects spoofed client input
    const validation = await engine.validateApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint,
      understandingRevision: 1,
      actor: 'malicious-client',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      isTrustedHumanAuth: true, // Spoofed field!
      authStatus: 'VERIFIED_HUMAN', // Spoofed field!
    });

    assert.equal(validation.isValid, false);
    assert.equal(validation.code, 'BLOCKED_ON_AUTH_CONTEXT');

    // 10b. Direct spoof attempt to submitApproval is strictly rejected fail-closed
    await assert.rejects(
      async () => {
        await engine.submitApproval({
          workspaceRoot: tempDir,
          projectId,
          directorSessionId,
          packageId: pkg.packageId,
          revision: pkg.revision,
          contextFingerprint,
          understandingRevision: 1,
          actor: 'malicious-client',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
          isTrustedHumanAuth: true,
          authStatus: 'VERIFIED_HUMAN',
        });
      },
      (err: any) =>
        err.name === 'HumanApprovalValidationError' &&
        err.message.includes('Client cannot self-declare isTrustedHumanAuth')
    );

    // 10c. Submit normal approval without trusted IdP assertion -> authStatus is UNVERIFIED_CLIENT_INPUT
    const submitResult = await engine.submitApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint,
      understandingRevision: 1,
      actor: 'product-owner-local',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    assert.equal(submitResult.approvalRecord.isTrustedHumanAuth, false);
    assert.equal(submitResult.approvalRecord.authStatus, 'UNVERIFIED_CLIENT_INPUT');

    // 10d. ExecutionBridge fails closed with BLOCKED_ON_AUTH_CONTEXT on this unverified approval
    const bridge = new ExecutionBridge({
      workspaceRoot: tempDir,
      approvalStore,
      approvalPackageEngine: packageEngine,
      sessionStore,
      sessionEngine,
      requireTrustedAuthContext: true,
    });

    const intent = createFrozenBridgeExecutionIntent({
      executionIntentId: `intent-${Date.now()}`,
      actionId: `action-${Date.now()}`,
      idempotencyKey: `idem-${Date.now()}`,
      projectId,
      directorSessionId,
      taskId: 'task-auth-01',
      taskRevision: 1,
      basedOnContextFingerprint: contextFingerprint,
      understandingRevision: 1,
      authorizationReference: {
        packageId: pkg.packageId,
        packageRevision: pkg.revision,
        isDevelopmentAuthorized: true,
        authorizedAt: new Date().toISOString(),
        authorizedByRole: 'PRODUCT_OWNER',
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Execute anti-spoof verification',
    });

    const valResult = await bridge.validatePreconditions(intent);
    assert.equal(valResult.isValid, false);
    const check6 = valResult.allChecks.find((c) => c.checkName === '6_PRODUCT_OWNER_APPROVAL');
    assert.ok(check6);
    assert.equal(check6.passed, false);
    assert.equal(check6.code, 'BLOCKED_ON_AUTH_CONTEXT');

    const bridgeResult = await bridge.executeIntent(intent);
    assert.equal(bridgeResult.status, 'EXECUTION_FAILED');
  });

  // ==========================================================================
  // 11. ACTOR AUTHORITY DEFENSE
  // ==========================================================================
  it('TEST 11: Unauthorized actors (DIRECTOR, EXECUTOR) are strictly rejected from human approval', async () => {
    const pkg = await createMockPackage();

    const engine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      approvalStore,
      approvalPackageEngine: packageEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
    });

    // 11a. DIRECTOR actor rejected
    await assert.rejects(
      async () => {
        await engine.submitApproval({
          workspaceRoot: tempDir,
          projectId,
          directorSessionId,
          packageId: pkg.packageId,
          revision: pkg.revision,
          contextFingerprint,
          understandingRevision: 1,
          actor: 'DIRECTOR',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: any) =>
        err.name === 'HumanApprovalUnauthorizedActorError' ||
        err.code === 'ERR_HUMAN_APPROVAL_UNAUTHORIZED_ACTOR' ||
        err.code === 'ACTOR_UNAUTHORIZED'
    );

    // 11b. EXECUTOR actor rejected
    await assert.rejects(
      async () => {
        await engine.submitApproval({
          workspaceRoot: tempDir,
          projectId,
          directorSessionId,
          packageId: pkg.packageId,
          revision: pkg.revision,
          contextFingerprint,
          understandingRevision: 1,
          actor: 'EXECUTOR',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: any) =>
        err.name === 'HumanApprovalUnauthorizedActorError' ||
        err.name === 'DirectorSecurityError' ||
        err.code === 'ERR_HUMAN_APPROVAL_UNAUTHORIZED_ACTOR' ||
        err.code === 'ERR_DIRECTOR_SECURITY' ||
        err.code === 'SECURITY_VIOLATION'
    );
  });

  // ==========================================================================
  // 12. RECONNECT / RESUME PRESERVES APPROVAL CONTEXT BINDINGS
  // ==========================================================================
  it('TEST 12: Reconnect/resume preserves approval context bindings across sessions', async () => {
    const pkg = await createMockPackage();

    const engine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      approvalStore,
      approvalPackageEngine: packageEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
    });

    // Submit valid approval bound to session and fingerprint
    await engine.submitApproval({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
      contextFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    // 12a. Resume with identical active session and context fingerprint -> RESUME_AUTHORIZED
    const resumeAuth = await engine.evaluateResume({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
    });
    assert.equal(resumeAuth.canResume, true);
    assert.equal(resumeAuth.code, 'RESUME_AUTHORIZED');

    // 12b. Resume with altered context fingerprint -> RESUME_BLOCKED_CONTEXT_MISMATCH
    const alteredSnapshot: DirectorContextSnapshot = {
      directorSessionId,
      projectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      logicalFingerprint: 'ctx-fp-sha256-MODIFIED-999',
      isComplete: true,
      syncStatus: 'CHANGED',
      sections: {} as any,
      unavailableSections: [],
      staleSections: [],
      sectionMetadata: {} as any,
      isDerived: true,
    };
    await sessionStore.saveSnapshot(alteredSnapshot);

    const resumeBlocked = await engine.evaluateResume({
      workspaceRoot: tempDir,
      projectId,
      directorSessionId,
      packageId: pkg.packageId,
      revision: pkg.revision,
    });
    assert.equal(resumeBlocked.canResume, false);
    assert.equal(resumeBlocked.code, 'RESUME_BLOCKED_CONTEXT_MISMATCH');
  });

  // ==========================================================================
  // 13. TEST DOUBLE ISOLATION
  // ==========================================================================
  it('TEST 13: TestDoubleIdentityProviderAdapter is explicitly isolated and marked as test double', async () => {
    const testDouble = new TestDoubleIdentityProviderAdapter();
    assert.equal(testDouble.isTestDouble, true);
    assert.equal(testDouble.providerType, 'LOCAL_TEST_DOUBLE');

    const health = await testDouble.getHealth();
    assert.ok(health.message?.includes('Test double'));

    const binding: TrustedApprovalBinding = { projectId, packageId: 'pkg-1', revision: 1, contextFingerprint };
    const res = await testDouble.verifyAssertion(
      {
        token: 'test-token',
        binding,
        claims: {
          identityId: 'id-test',
          issuer: 'test-issuer',
          audience: 'test-aud',
          subject: 'test-user',
          actorRole: 'PRODUCT_OWNER',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          nonce: 'test-nonce-123',
          authMethod: 'LOCAL_TEST_DOUBLE',
        },
      },
      binding
    );

    assert.equal(res.isValid, true);
    assert.equal(res.reason?.includes('TEST DOUBLE ONLY'), true);
  });

  // ==========================================================================
  // 14. LOG & AUDIT CREDENTIAL SANITIZATION
  // ==========================================================================
  it('TEST 14: Sensitive credentials and raw JWTs are sanitized in audit events and helper utilities', async () => {
    const rawJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature';
    const masked = maskToken(rawJwt);
    assert.ok(masked.includes('[MASKED]'));
    assert.equal(masked.includes('abc123signature'), false);

    const sensitivePayload = {
      actor: 'alice-po',
      token: rawJwt,
      clientSecret: 'super-secret-key-1234',
      authorization: 'Bearer secret-bearer-token-5678',
      nested: {
        apiKey: 'api-key-9999',
        publicField: 'safe-value',
      },
    };

    const sanitized = sanitizeForAudit(sensitivePayload);
    assert.equal(sanitized.actor, 'alice-po');
    assert.ok(sanitized.token.includes('[MASKED]'));
    assert.ok(sanitized.clientSecret.includes('[MASKED]'));
    assert.ok(sanitized.authorization.includes('[MASKED]'));
    assert.ok(sanitized.nested.apiKey.includes('[MASKED]'));
    assert.equal(sanitized.nested.publicField, 'safe-value');
  });

  // ==========================================================================
  // SECTION 3: EXPANDED NEGATIVE SECURITY & ZERO-TRUST TEST SUITE
  // ==========================================================================

  // SEC-1: Adapter with only jwksUri and no real signature verifier/resolution fails closed
  it('SEC-1: Only jwksUri defined without real signature verifier strictly fails closed with BLOCKED_ON_AUTH_CONTEXT', async () => {
    const adapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://auth.company.corp/.well-known/jwks.json',
      requestTimeoutMs: 1000,
      fetchJwksFn: async () => {
        throw new Error('ECONNREFUSED: No live JWKS endpoint available');
      },
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-1',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-sec-1',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    const res = await adapter.verifyAssertion({ token, binding }, binding);
    assert.equal(res.isValid, false);
    assert.equal(res.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(res.status, 'PROVIDER_OUTAGE');
  });

  // SEC-2: Valid signed token with fake assertion.claims
  it('SEC-2: Valid signed token with spoofed client assertion.claims fails closed', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-2',
      revision: 1,
      contextFingerprint,
    };

    // Authentic token signed for bob (USER)
    const authenticClaims: TrustedIdentityClaim = {
      identityId: 'id-bob-user',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'bob-user@company.corp',
      actorRole: 'USER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(authenticClaims, rsaPrivateKeyPem, binding);

    // Attacker sends authentic token but attaches fake assertion.claims trying to spoof role as PRODUCT_OWNER
    const spoofedClaims: Partial<TrustedIdentityClaim> = {
      identityId: 'id-eve-root',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'eve-attacker@company.corp',
      actorRole: 'PRODUCT_OWNER',
    };

    const res = await oidcAdapter.verifyAssertion(
      { token, binding, claims: spoofedClaims as any },
      binding
    );

    assert.equal(res.isValid, false);
    assert.equal(res.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(res.status, 'UNVERIFIED');
    assert.ok(res.reason.includes('contradicts verified token'));

    // When client does NOT pass assertion.claims, claims are strictly populated from token payload
    const resNoClaims = await oidcAdapter.verifyAssertion(
      { token, binding },
      binding
    );
    assert.equal(resNoClaims.isValid, true);
    assert.equal(resNoClaims.claims?.subject, 'bob-user@company.corp');
    assert.equal(resNoClaims.claims?.actorRole, 'USER');
  });

  // SEC-3: Token payload vs assertion.binding mismatch
  it('SEC-3: Token payload vs assertion.binding mismatch fails closed with BINDING_MISMATCH', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    // Token was cryptographically signed for project-ALPHA
    const tokenBinding: TrustedApprovalBinding = {
      projectId: 'project-ALPHA',
      packageId: 'pkg-alpha-001',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-alice',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, tokenBinding);

    // Client attempts to submit this token for project-BETA
    const targetBinding: TrustedApprovalBinding = {
      projectId: 'project-BETA',
      packageId: 'pkg-beta-999',
      revision: 1,
      contextFingerprint,
    };

    const res = await oidcAdapter.verifyAssertion(
      { token, binding: targetBinding },
      targetBinding
    );
    assert.equal(res.isValid, false);
    assert.equal(res.status, 'BINDING_MISMATCH');
    assert.equal(res.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.ok(res.reason.includes('Cross-project binding violation'));
  });

  // SEC-4: Unsupported algorithm and invalid kid
  it('SEC-4: Unsupported algorithm (alg: none, HS256) and invalid kid strictly fails closed with SIGNATURE_INVALID', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-4',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    // 4a. alg: 'none' attack
    const noneToken = createSignedJwt(claims, rsaPrivateKeyPem, binding, { alg: 'none' });
    const resNone = await oidcAdapter.verifyAssertion({ token: noneToken, binding }, binding);
    assert.equal(resNone.isValid, false);
    assert.equal(resNone.status, 'SIGNATURE_INVALID');
    assert.equal(resNone.code, 'BLOCKED_ON_AUTH_CONTEXT');

    // 4b. alg: 'HS256' symmetric downgrade attack
    const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const hsBody = Buffer.from(JSON.stringify({ ...claims, binding })).toString('base64url');
    const hsHmac = crypto.createHmac('sha256', rsaPublicKeyPem).update(`${hsHeader}.${hsBody}`).digest('base64url');
    const hsToken = `${hsHeader}.${hsBody}.${hsHmac}`;
    const resHs = await oidcAdapter.verifyAssertion({ token: hsToken, binding }, binding);
    assert.equal(resHs.isValid, false);
    assert.equal(resHs.status, 'SIGNATURE_INVALID');
    assert.equal(resHs.code, 'BLOCKED_ON_AUTH_CONTEXT');

    // 4c. Unknown kid in JWKS
    const jwksAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://auth.company.corp/keys',
      fetchJwksFn: async () => ({
        keys: [{
          kty: 'RSA',
          kid: 'known-good-kid',
          ...crypto.createPublicKey(rsaPublicKeyPem).export({ format: 'jwk' }),
        }],
      }),
    });
    const unknownKidToken = createSignedJwt(claims, rsaPrivateKeyPem, binding, { kid: 'rogue-unknown-kid' });
    const resKid = await jwksAdapter.verifyAssertion({ token: unknownKidToken, binding }, binding);
    assert.equal(resKid.isValid, false);
    assert.equal(resKid.status, 'SIGNATURE_INVALID');
    assert.ok(resKid.reason.includes('not found in resolved JWKS keys'));
  });

  // SEC-5: Corrupt, unreachable, or malformed JWKS response and SSRF mitigation
  it('SEC-5: Corrupt, malformed, or SSRF-targeting JWKS responses fail closed', async () => {
    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-5',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    // 5a. Malformed JWKS JSON (keys is empty)
    const malformedAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://auth.company.corp/keys',
      fetchJwksFn: async () => ({ keys: [] }),
    });
    const resMalformed = await malformedAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resMalformed.isValid, false);
    assert.equal(resMalformed.status, 'SIGNATURE_INVALID');
    assert.ok(resMalformed.reason.includes('missing or empty keys array'));

    // 5b. SSRF Attempt targeting cloud metadata IP
    const ssrfAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://169.254.169.254/latest/meta-data',
    });
    const resSsrf = await ssrfAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resSsrf.isValid, false);
    assert.equal(resSsrf.status, 'CONFIG_MISSING');
    assert.ok(resSsrf.reason.includes('cloud metadata IP'));

    // 5c. Insecure HTTP protocol rejected
    const insecureHttpAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'http://evil.corp/keys',
    });
    const resInsecure = await insecureHttpAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resInsecure.isValid, false);
    assert.equal(resInsecure.status, 'CONFIG_MISSING');
    assert.ok(resInsecure.reason.includes('HTTPS protocol'));
  });

  // SEC-6: Invalid iat, exp, and nbf timestamps
  it('SEC-6: Invalid iat (future), exp (past), and nbf (future) fail closed', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
      clockSkewSeconds: 0,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-6',
      revision: 1,
      contextFingerprint,
    };

    // 6a. Future iat (issued 10 minutes in the future)
    const futureIatClaims = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date(Date.now() + 600000).toISOString(),
      expiresAt: new Date(Date.now() + 1200000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const futureIatToken = createSignedJwt(futureIatClaims, rsaPrivateKeyPem, binding);
    const resFutureIat = await oidcAdapter.verifyAssertion({ token: futureIatToken, binding }, binding);
    assert.equal(resFutureIat.isValid, false);
    assert.equal(resFutureIat.status, 'UNVERIFIED');
    assert.ok(resFutureIat.reason.includes('issued in the future'));

    // 6b. Future nbf (not valid until 10 minutes from now)
    const futureNbfClaims = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      notBefore: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const futureNbfToken = createSignedJwt(futureNbfClaims, rsaPrivateKeyPem, binding);
    const resFutureNbf = await oidcAdapter.verifyAssertion({ token: futureNbfToken, binding }, binding);
    assert.equal(resFutureNbf.isValid, false);
    assert.equal(resFutureNbf.status, 'UNVERIFIED');
    assert.ok(resFutureNbf.reason.includes('not yet valid'));

    // 6c. Malformed date
    const malformedDateClaims = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: 'not-a-valid-date',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const malformedDateToken = createSignedJwt(malformedDateClaims, rsaPrivateKeyPem, binding);
    const resMalformedDate = await oidcAdapter.verifyAssertion({ token: malformedDateToken, binding }, binding);
    assert.equal(resMalformedDate.isValid, false);
    assert.equal(resMalformedDate.status, 'UNVERIFIED');
  });

  // SEC-7: Parallel nonce consumption and replay attack resistance
  it('SEC-7: Parallel concurrent nonce consumption allows exactly one success and rejects all replays', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-7',
      revision: 1,
      contextFingerprint,
    };

    const sharedNonce = `parallel-nonce-${crypto.randomUUID()}`;
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: sharedNonce,
      authMethod: 'OIDC',
    };

    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    // Launch 15 concurrent verification requests simultaneously
    const concurrency = 15;
    const promises = Array.from({ length: concurrency }, () =>
      oidcAdapter.verifyAssertion({ token, binding, claims }, binding)
    );

    const results = await Promise.all(promises);

    const validCount = results.filter((r) => r.isValid && r.status === 'VERIFIED').length;
    const replayCount = results.filter((r) => !r.isValid && r.status === 'REPLAY_DETECTED').length;

    assert.equal(validCount, 1, 'Exactly one concurrent request MUST succeed');
    assert.equal(replayCount, concurrency - 1, 'All other concurrent requests MUST be detected as REPLAY_DETECTED');
  });

  // SEC-8: Approval reuse for different package, revision, session, or action fails closed
  it('SEC-8: Reusing an approval for another package, revision, session, or operation fails closed', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const originalBinding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-original',
      revision: 1,
      contextFingerprint: 'ctx-fp-original',
      directorSessionId: 'sess-original',
      taskId: 'task-original',
      operation: 'DEPLOY_PROD',
    };

    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, originalBinding);

    // 8a. Reused for different package
    const resDiffPkg = await oidcAdapter.verifyAssertion(
      { token, binding: { ...originalBinding, packageId: 'pkg-rogue' } },
      { ...originalBinding, packageId: 'pkg-rogue' }
    );
    assert.equal(resDiffPkg.isValid, false);
    assert.equal(resDiffPkg.status, 'BINDING_MISMATCH');

    // 8b. Reused for different revision
    const resDiffRev = await oidcAdapter.verifyAssertion(
      { token, binding: { ...originalBinding, revision: 2 } },
      { ...originalBinding, revision: 2 }
    );
    assert.equal(resDiffRev.isValid, false);
    assert.equal(resDiffRev.status, 'BINDING_MISMATCH');

    // 8c. Reused for different session
    const resDiffSess = await oidcAdapter.verifyAssertion(
      { token, binding: { ...originalBinding, directorSessionId: 'sess-rogue' } },
      { ...originalBinding, directorSessionId: 'sess-rogue' }
    );
    assert.equal(resDiffSess.isValid, false);
    assert.equal(resDiffSess.status, 'BINDING_MISMATCH');

    // 8d. Reused for different operation
    const resDiffOp = await oidcAdapter.verifyAssertion(
      { token, binding: { ...originalBinding, operation: 'DELETE_DATABASE' } },
      { ...originalBinding, operation: 'DELETE_DATABASE' }
    );
    assert.equal(resDiffOp.isValid, false);
    assert.equal(resDiffOp.status, 'BINDING_MISMATCH');
  });

  // SEC-9: Authentic mTLS X.509 verification vs fake client metadata
  it('SEC-9: mTLS verification strictly requires authentic X.509 certificate and rejects unverified client metadata', async () => {
    const clientSubject = 'CN=alice-po, O=AIDM Security, C=TR';
    const mtlsAdapter = new MtlsIdentityProviderAdapter({
      allowedSubjects: [clientSubject],
      trustedCaFingerprints: ['AA:BB:CC:DD:EE:FF'],
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-mtls-1',
      revision: 1,
      contextFingerprint,
    };

    // 9a. Client only passes unverified assertion.claims with no real certificate
    const resNoCert = await mtlsAdapter.verifyAssertion(
      {
        token: 'not-a-certificate',
        binding,
        claims: {
          identityId: clientSubject,
          issuer: 'CN=Fake CA',
          audience: projectId,
          subject: clientSubject,
          actorRole: 'USER',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          nonce: `nonce-${crypto.randomUUID()}`,
          authMethod: 'MTLS',
          publicKeyFingerprint: 'AA:BB:CC:DD:EE:FF',
        },
      },
      binding
    );

    assert.equal(resNoCert.isValid, false);
    assert.equal(resNoCert.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.equal(resNoCert.status, 'UNVERIFIED');
    assert.ok(resNoCert.reason.includes('Client-submitted metadata cannot substitute for TLS certificate verification'));

    // 9b. Genuine TLS connection verifier function succeeds when verified at TLS layer
    const verifiedMtlsAdapter = new MtlsIdentityProviderAdapter({
      allowedSubjects: [clientSubject],
      trustedCaFingerprints: ['AA:BB:CC:DD:EE:FF'],
      verifyTlsConnectionFn: async (assertion) => {
        // Authoritative TLS socket verification
        return assertion.binding.projectId === projectId;
      },
    });

    const resVerifiedMtls = await verifiedMtlsAdapter.verifyAssertion(
      {
        token: 'tls-channel-token',
        binding,
        claims: {
          identityId: clientSubject,
          issuer: 'CN=Trusted CA',
          audience: projectId,
          subject: clientSubject,
          actorRole: 'USER',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          nonce: `nonce-${crypto.randomUUID()}`,
          authMethod: 'MTLS',
        },
      },
      binding
    );

    assert.equal(resVerifiedMtls.isValid, true);
    assert.equal(resVerifiedMtls.status, 'VERIFIED');
    assert.equal(resVerifiedMtls.code, 'VERIFIED_HUMAN');
  });

  // SEC-10: Real JWKS resolver with valid JWK imports and verifies signatures
  it('SEC-10: Real JWKS key resolver imports JWK and verifies valid RSA tokens', async () => {
    const keyId = 'prod-key-2026-10';
    const jwk = crypto.createPublicKey(rsaPublicKeyPem).export({ format: 'jwk' });

    const jwksAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://auth.company.corp/.well-known/jwks.json',
      fetchJwksFn: async () => ({
        keys: [{
          ...jwk,
          kid: keyId,
          use: 'sig',
          alg: 'RS256',
        }],
      }),
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-10',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding, { kid: keyId });
    const res = await jwksAdapter.verifyAssertion({ token, binding }, binding);

    assert.equal(res.isValid, true);
    assert.equal(res.status, 'VERIFIED');
    assert.equal(res.code, 'VERIFIED_HUMAN');
    assert.equal(res.claims?.subject, 'alice@company.corp');
  });

  // SEC-11: Scope-Binding fail-closed on missing or mismatched directorSessionId, taskId, and operation
  it('SEC-11: Missing or mismatched directorSessionId, taskId, or operation in signed token strictly fails closed', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const fullExpectedBinding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-11',
      revision: 1,
      contextFingerprint,
      directorSessionId: 'sess-target-11',
      taskId: 'task-target-11',
      operation: 'DEPLOY_PROD',
    };

    const baseClaims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    // 11a. Token missing directorSessionId when expectedBinding requires it
    const tokenNoSession = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      {
        projectId,
        packageId: 'pkg-sec-11',
        revision: 1,
        contextFingerprint,
        taskId: 'task-target-11',
        operation: 'DEPLOY_PROD',
      }
    );
    const resNoSession = await oidcAdapter.verifyAssertion(
      { token: tokenNoSession, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resNoSession.isValid, false);
    assert.equal(resNoSession.status, 'BINDING_MISMATCH');
    assert.ok(resNoSession.reason.includes('Session binding mismatch'));

    // 11b. Token missing taskId when expectedBinding requires it
    const tokenNoTask = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      {
        projectId,
        packageId: 'pkg-sec-11',
        revision: 1,
        contextFingerprint,
        directorSessionId: 'sess-target-11',
        operation: 'DEPLOY_PROD',
      }
    );
    const resNoTask = await oidcAdapter.verifyAssertion(
      { token: tokenNoTask, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resNoTask.isValid, false);
    assert.equal(resNoTask.status, 'BINDING_MISMATCH');
    assert.ok(resNoTask.reason.includes('Task binding mismatch'));

    // 11c. Token missing operation when expectedBinding requires it
    const tokenNoOp = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      {
        projectId,
        packageId: 'pkg-sec-11',
        revision: 1,
        contextFingerprint,
        directorSessionId: 'sess-target-11',
        taskId: 'task-target-11',
      }
    );
    const resNoOp = await oidcAdapter.verifyAssertion(
      { token: tokenNoOp, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resNoOp.isValid, false);
    assert.equal(resNoOp.status, 'BINDING_MISMATCH');
    assert.ok(resNoOp.reason.includes('Operation binding mismatch'));

    // 11d. Each field modified individually in token
    const tokenWrongSession = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      { ...fullExpectedBinding, directorSessionId: 'sess-rogue' }
    );
    const resWrongSession = await oidcAdapter.verifyAssertion(
      { token: tokenWrongSession, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resWrongSession.isValid, false);
    assert.equal(resWrongSession.status, 'BINDING_MISMATCH');

    const tokenWrongTask = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      { ...fullExpectedBinding, taskId: 'task-rogue' }
    );
    const resWrongTask = await oidcAdapter.verifyAssertion(
      { token: tokenWrongTask, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resWrongTask.isValid, false);
    assert.equal(resWrongTask.status, 'BINDING_MISMATCH');

    const tokenWrongOp = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      { ...fullExpectedBinding, operation: 'DROP_DATABASE' }
    );
    const resWrongOp = await oidcAdapter.verifyAssertion(
      { token: tokenWrongOp, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resWrongOp.isValid, false);
    assert.equal(resWrongOp.status, 'BINDING_MISMATCH');

    // 11e. Correct token matching all required fields succeeds
    const tokenAllMatch = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      fullExpectedBinding
    );
    const resAllMatch = await oidcAdapter.verifyAssertion(
      { token: tokenAllMatch, binding: fullExpectedBinding },
      fullExpectedBinding
    );
    assert.equal(resAllMatch.isValid, true);
    assert.equal(resAllMatch.status, 'VERIFIED');
    assert.equal(resAllMatch.code, 'VERIFIED_HUMAN');
  });

  // SEC-12: assertion.binding client spoofing vs signed token payload mismatch
  it('SEC-12: Client-provided assertion.binding contradicting signed token payload strictly fails closed', async () => {
    const oidcAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      publicKeyPem: rsaPublicKeyPem,
      nonceStore,
    });

    const expectedBinding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-12',
      revision: 1,
      contextFingerprint,
      taskId: 'task-target-12',
    };

    const baseClaims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    // Client passes assertion.binding matching expected execution context,
    // but the cryptographically signed JWT token was issued for task-evil!
    const tokenForEvilTask = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      { ...expectedBinding, taskId: 'task-evil' }
    );
    const resSpoofedClientBinding = await oidcAdapter.verifyAssertion(
      {
        token: tokenForEvilTask,
        binding: expectedBinding,
      },
      expectedBinding
    );
    assert.equal(resSpoofedClientBinding.isValid, false);
    assert.equal(resSpoofedClientBinding.status, 'BINDING_MISMATCH');

    // Vice-versa: signed token matches expected, but client tampers with assertion.binding
    const tokenValid = createSignedJwt(
      { ...baseClaims, nonce: `nonce-${crypto.randomUUID()}` },
      rsaPrivateKeyPem,
      expectedBinding
    );
    const resTamperedBinding = await oidcAdapter.verifyAssertion(
      {
        token: tokenValid,
        binding: { ...expectedBinding, taskId: 'task-rogue' },
      },
      expectedBinding
    );
    assert.equal(resTamperedBinding.isValid, false);
    assert.equal(resTamperedBinding.status, 'BINDING_MISMATCH');
  });

  // SEC-13: Multiple NonceStore instances, reservation lifecycle, and restart replay resistance
  it('SEC-13: Multiple NonceStore instances on same file enforce cross-instance atomicity and restart replay prevention', async () => {
    const sharedNonceFile = path.join(tempDir, `shared-nonces-${crypto.randomUUID()}.json`);
    const storeA = new NonceStore({ filePath: sharedNonceFile });
    const storeB = new NonceStore({ filePath: sharedNonceFile });

    const testNonce = `nonce-shared-${crypto.randomUUID()}`;

    // 13a. Store A reserves nonce -> succeeds
    const reservedA = await storeA.reserveNonce(testNonce, 10000);
    assert.equal(reservedA, true, 'Store A must successfully reserve new nonce');

    // 13b. Store B tries to reserve same nonce while reserved by A -> fails
    const reservedB = await storeB.reserveNonce(testNonce, 10000);
    assert.equal(reservedB, false, 'Store B must be rejected while nonce is reserved');

    // 13c. Store B checks isNonceSeen -> returns true (in flight)
    const seenDuringReservation = await storeB.isNonceSeen(testNonce);
    assert.equal(seenDuringReservation, true, 'isNonceSeen must report true while nonce is reserved');

    // 13d. Store A releases reservation (e.g. verification failed before commit)
    await storeA.releaseReservation(testNonce);

    // 13e. Store B can now reserve and permanently mark seen
    const reservedBAfterRelease = await storeB.reserveNonce(testNonce, 10000);
    assert.equal(reservedBAfterRelease, true, 'Store B must be able to reserve after release');

    const markedB = await storeB.markNonceSeen(testNonce);
    assert.equal(markedB, true, 'Store B must successfully mark nonce seen');

    // 13f. Store A attempts duplicate consume -> fails (replay)
    const markedA = await storeA.markNonceSeen(testNonce);
    assert.equal(markedA, false, 'Store A must fail on already-seen nonce');

    // 13g. Simulate complete process restart with brand new NonceStore instance C
    const storeC = new NonceStore({ filePath: sharedNonceFile });
    const reservedC = await storeC.reserveNonce(testNonce);
    assert.equal(reservedC, false, 'Store C after restart must strictly reject already-seen nonce');
    const seenC = await storeC.isNonceSeen(testNonce);
    assert.equal(seenC, true, 'Store C after restart must confirm nonce is seen');
  });

  // SEC-14: Cross-process concurrent race condition on NonceStore
  it('SEC-14: Concurrent inter-process execution enforces single winner on identical nonce', async () => {
    const sharedFile = path.join(tempDir, `multiprocess-nonces-${crypto.randomUUID()}.json`);
    const storeMain = new NonceStore({ filePath: sharedFile });
    const nonceValue = `race-nonce-${crypto.randomUUID()}`;

    // Child process script using compiled NonceStore
    const nonceStoreUrl = new URL('../dist/authorization/nonce-store.js', import.meta.url).href;
    const childScript = `
      import { NonceStore } from '${nonceStoreUrl}';
      const store = new NonceStore({ filePath: process.argv[1] });
      const res = await store.reserveNonce(process.argv[2], 30000);
      let marked = false;
      if (res) {
        marked = await store.markNonceSeen(process.argv[2]);
      }
      process.stdout.write(JSON.stringify({ reserved: res, marked }));
    `;

    // Launch child process and concurrent main process call simultaneously
    const childPromise = new Promise<{ reserved: boolean; marked: boolean }>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['--input-type=module', '-e', childScript, sharedFile, nonceValue], {
        cwd: process.cwd(),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Child process failed (${code}): ${stderr}`));
        } else {
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error(`Failed to parse child output: ${stdout}, err: ${e}`));
          }
        }
      });
    });

    // Run simultaneously in main process
    const mainReserved = await storeMain.reserveNonce(nonceValue, 30000);
    let mainMarked = false;
    if (mainReserved) {
      mainMarked = await storeMain.markNonceSeen(nonceValue);
    }

    const childResult = await childPromise;

    const totalReserved = (mainReserved ? 1 : 0) + (childResult.reserved ? 1 : 0);
    const totalMarked = (mainMarked ? 1 : 0) + (childResult.marked ? 1 : 0);

    assert.equal(totalReserved, 1, 'Exactly one process (main or child) MUST win reservation');
    assert.equal(totalMarked, 1, 'Exactly one process MUST successfully mark nonce seen');
  });

  // SEC-15: JWKS Redirect prevention and URL security
  it('SEC-15: JWKS redirect responses and URL credentials strictly fail closed', async () => {
    // 15a. HTTP 302 redirect attempted by JWKS endpoint is blocked fail-closed
    const redirectAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://auth.company.corp/redirect',
      fetchJwksFn: async () => {
        // Simulating redirect rejection from fetch redirect: manual
        throw new Error('JWKS endpoint attempted redirect to https://evil.corp/keys. Automatic redirects are blocked for SSRF defense.');
      },
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-15',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    const resRedirect = await redirectAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resRedirect.isValid, false);
    assert.equal(resRedirect.status, 'PROVIDER_OUTAGE');
    assert.ok(resRedirect.reason.includes('redirect'));

    // 15b. JWKS URI with embedded credentials fails closed
    const credsAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://admin:secret@auth.company.corp/jwks.json',
    });
    const resCreds = await credsAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resCreds.isValid, false);
    assert.equal(resCreds.status, 'CONFIG_MISSING');
    assert.ok(resCreds.reason.includes('embedded user credentials'));
  });

  // SEC-16: JWKS Key compatibility and algorithm contradiction defense
  it('SEC-16: Contradictions between token header alg and JWK alg or kty strictly fail closed', async () => {
    const keyId = 'key-ec-mismatch';

    // Generate an EC key
    const ecKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ecJwk = ecKeys.publicKey.export({ format: 'jwk' });

    // Adapter returns an EC JWK, but token claims RS256
    const mismatchAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://auth.company.corp/jwks.json',
      fetchJwksFn: async () => ({
        keys: [{
          ...ecJwk,
          kid: keyId,
          alg: 'ES256',
        }],
      }),
    });

    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-16',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };

    // Token has header alg: RS256, but JWK has alg: ES256 and kty: EC
    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding, { kid: keyId, alg: 'RS256' });
    const res = await mismatchAdapter.verifyAssertion({ token, binding }, binding);

    assert.equal(res.isValid, false);
    assert.equal(res.status, 'SIGNATURE_INVALID');
    assert.ok(res.reason.includes('contradicts token header algorithm') || res.reason.includes('requires kty'));
  });

  // SEC-17: Lock held >4s is safely maintained and not stolen or deleted by concurrent process
  it('SEC-17: Nonce lock held for longer than 4 seconds is not stolen or broken by second process', async () => {
    const sharedFile = path.join(tempDir, `long-lock-${crypto.randomUUID()}.json`);
    const nonceStoreUrl = new URL('../dist/authorization/nonce-store.js', import.meta.url).href;

    // Process 1 holds lock for 4500ms
    const p1Script = `
      import { withCrossProcessNonceLock } from '${nonceStoreUrl}';
      const file = process.argv[1];
      await withCrossProcessNonceLock(file, async () => {
        process.stdout.write('P1_LOCKED');
        await new Promise((r) => setTimeout(r, 4500));
        process.stdout.write(JSON.stringify({ p1End: Date.now() }));
      }, { timeoutMs: 10000 });
    `;

    // Process 2 starts later and attempts to acquire lock with 10s timeout
    const p2Script = `
      import { withCrossProcessNonceLock } from '${nonceStoreUrl}';
      const file = process.argv[1];
      const p2Attempt = Date.now();
      await withCrossProcessNonceLock(file, async () => {
        const p2Acquired = Date.now();
        process.stdout.write(JSON.stringify({ p2Attempt, p2Acquired }));
      }, { timeoutMs: 10000 });
    `;

    const p1 = cp.spawn(process.execPath, ['--input-type=module', '-e', p1Script, sharedFile]);
    let p1Out = '';
    let p2Out = '';

    await new Promise<void>((resolve, reject) => {
      p1.stdout.on('data', (d) => {
        p1Out += d.toString();
        if (p1Out.includes('P1_LOCKED') && !p1Out.includes('SPAWNED_P2')) {
          p1Out += 'SPAWNED_P2';
          setTimeout(() => {
            const p2 = cp.spawn(process.execPath, ['--input-type=module', '-e', p2Script, sharedFile]);
            p2.stdout.on('data', (d2) => { p2Out += d2.toString(); });
            p2.on('close', (code) => {
              if (code !== 0) reject(new Error(`P2 exited with code ${code}`));
              else resolve();
            });
          }, 500);
        }
      });
      p1.on('error', reject);
    });

    const p1Data = JSON.parse(p1Out.slice(p1Out.indexOf('{')));
    const p2Data = JSON.parse(p2Out);

    assert.ok(
      p2Data.p2Acquired >= p1Data.p1End,
      `P2 acquired lock (${p2Data.p2Acquired}) before P1 released it (${p1Data.p1End})`
    );
  });

  // SEC-18: Abrupt process termination releases lock cleanly and concurrent processes acquire sequentially
  it('SEC-18: Abrupt process termination releases lock cleanly and concurrent processes acquire sequentially', async () => {
    const sharedFile = path.join(tempDir, `crash-lock-${crypto.randomUUID()}.json`);
    const nonceStoreUrl = new URL('../dist/authorization/nonce-store.js', import.meta.url).href;

    // Process A acquires lock and hangs
    const p1Script = `
      import { withCrossProcessNonceLock } from '${nonceStoreUrl}';
      await withCrossProcessNonceLock(process.argv[1], async () => {
        process.stdout.write('CRASH_LOCK_ACQUIRED');
        await new Promise((r) => setTimeout(r, 60000));
      });
    `;

    const p1 = cp.spawn(process.execPath, ['--input-type=module', '-e', p1Script, sharedFile]);
    let p1Out = '';

    await new Promise<void>((resolve, reject) => {
      p1.stdout.on('data', (d) => {
        p1Out += d.toString();
        if (p1Out.includes('CRASH_LOCK_ACQUIRED')) {
          p1.kill('SIGKILL');
          resolve();
        }
      });
      p1.on('error', reject);
    });

    // Competing child process worker script
    const competitorScript = `
      import { withCrossProcessNonceLock } from '${nonceStoreUrl}';
      const id = process.argv[2];
      await withCrossProcessNonceLock(process.argv[1], async () => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 150));
        process.stdout.write(JSON.stringify({ id, start, end: Date.now() }));
      }, { timeoutMs: 10000 });
    `;

    // Spawn 2 competing processes concurrently to race for the recovered lock
    const p2Promise = new Promise<{ id: string; start: number; end: number }>((resolve, reject) => {
      const p2 = cp.spawn(process.execPath, ['--input-type=module', '-e', competitorScript, sharedFile, 'p2']);
      let out = '';
      p2.stdout.on('data', (d) => { out += d.toString(); });
      p2.on('close', (c) => c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`p2 failed ${c}`)));
    });

    const p3Promise = new Promise<{ id: string; start: number; end: number }>((resolve, reject) => {
      const p3 = cp.spawn(process.execPath, ['--input-type=module', '-e', competitorScript, sharedFile, 'p3']);
      let out = '';
      p3.stdout.on('data', (d) => { out += d.toString(); });
      p3.on('close', (c) => c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`p3 failed ${c}`)));
    });

    const [res2, res3] = await Promise.all([p2Promise, p3Promise]);

    const isP2First = res2.end <= res3.start;
    const isP3First = res3.end <= res2.start;
    assert.ok(
      isP2First || isP3First,
      `Competitors overlapped execution: p2=[${res2.start}, ${res2.end}], p3=[${res3.start}, ${res3.end}]`
    );
  });

  // SEC-19: Multi-process race across reservation, release, and permanent consumption
  it('SEC-19: Multi-process race across reservation, release, and permanent consumption', async () => {
    const sharedFile = path.join(tempDir, `race-cycle-${crypto.randomUUID()}.json`);
    const storeA = new NonceStore({ filePath: sharedFile });
    const storeB = new NonceStore({ filePath: sharedFile });
    const testNonce = `cycle-nonce-${crypto.randomUUID()}`;

    // Step 1: Store A reserves nonce
    const resA = await storeA.reserveNonce(testNonce, 15000);
    assert.equal(resA, true);

    // Step 2: Child process attempts reservation of same nonce -> MUST fail
    const nonceStoreUrl = new URL('../dist/authorization/nonce-store.js', import.meta.url).href;
    const childReserve = (nonce: string) => new Promise<boolean>((resolve, reject) => {
      const p = cp.spawn(process.execPath, ['--input-type=module', '-e', `
        import { NonceStore } from '${nonceStoreUrl}';
        const s = new NonceStore({ filePath: process.argv[1] });
        const res = await s.reserveNonce(process.argv[2], 10000);
        process.stdout.write(JSON.stringify({ res }));
      `, sharedFile, nonce]);
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('close', (c) => c === 0 ? resolve(JSON.parse(out).res) : reject(new Error(`reserve child failed ${c}`)));
    });

    const childRes1 = await childReserve(testNonce);
    assert.equal(childRes1, false, 'Child process must be rejected while nonce is reserved by A');

    // Step 3: Store A releases reservation
    await storeA.releaseReservation(testNonce);

    // Step 4: Child process now attempts reservation -> MUST succeed
    const childRes2 = await childReserve(testNonce);
    assert.equal(childRes2, true, 'Child process must succeed reserving after release');

    // Step 5: Child process consumes it
    const childConsume = (nonce: string) => new Promise<boolean>((resolve, reject) => {
      const p = cp.spawn(process.execPath, ['--input-type=module', '-e', `
        import { NonceStore } from '${nonceStoreUrl}';
        const s = new NonceStore({ filePath: process.argv[1] });
        const res = await s.markNonceSeen(process.argv[2]);
        process.stdout.write(JSON.stringify({ res }));
      `, sharedFile, nonce]);
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('close', (c) => c === 0 ? resolve(JSON.parse(out).res) : reject(new Error(`consume child failed ${c}`)));
    });

    const childConsumeRes = await childConsume(testNonce);
    assert.equal(childConsumeRes, true, 'Child process must mark nonce seen');

    // Step 6: Any further attempt by store A, store B, or any process MUST fail
    const replayAttemptA = await storeA.markNonceSeen(testNonce);
    assert.equal(replayAttemptA, false, 'Store A must detect replay');

    const replayAttemptB = await storeB.reserveNonce(testNonce);
    assert.equal(replayAttemptB, false, 'Store B reserve must detect replay');
  });

  // SEC-20: DNS SSRF defense rejects domains resolving to private/metadata IPs or unresolvable hosts
  it('SEC-20: DNS SSRF defense rejects domains resolving to private/metadata IPs or unresolvable hosts', async () => {
    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-20',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    // 20a. Domain resolves to RFC1918 private IP (10.0.0.1)
    const privateDnsAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://evil-rebind.attacker.corp/keys',
      dnsLookupFn: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    const resPrivateDns = await privateDnsAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resPrivateDns.isValid, false);
    assert.equal(resPrivateDns.status, 'CONFIG_MISSING');
    assert.ok(resPrivateDns.reason.includes('forbidden private/link-local/metadata IP'));

    // 20b. Domain resolves to cloud metadata IP (169.254.169.254)
    const metadataDnsAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://evil-metadata.attacker.corp/keys',
      dnsLookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    const resMetadataDns = await metadataDnsAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resMetadataDns.isValid, false);
    assert.equal(resMetadataDns.status, 'CONFIG_MISSING');
    assert.ok(resMetadataDns.reason.includes('forbidden cloud metadata IP'));

    // 20c. Domain fails DNS resolution entirely
    const unresolvableAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://non-existent-domain-404.corp/keys',
      dnsLookupFn: async () => {
        throw new Error('getaddrinfo ENOTFOUND non-existent-domain-404.corp');
      },
    });
    const resUnresolvable = await unresolvableAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(resUnresolvable.isValid, false);
    assert.equal(resUnresolvable.status, 'CONFIG_MISSING');
    assert.ok(resUnresolvable.reason.includes('could not be resolved via DNS'));
  });

  // SEC-21: Comprehensive IPv4 and IPv6 SSRF defense across loopback, private, link-local, cloud metadata, ULA, multicast, and IPv4-mapped representations
  it('SEC-21: Comprehensive IPv4 and IPv6 SSRF defense across loopback, private, link-local, metadata, ULA, multicast, and IPv4-mapped representations', () => {
    // Proves: All forbidden RFC address families (private, loopback, link-local, metadata, ULA, multicast, IPv4-mapped, IPv4-compatible, reserved)
    // are rejected fail-closed, while valid public IPv4 and IPv6 addresses are permitted.
    const forbiddenAddresses = [
      // IPv4 Loopback & Private
      '127.0.0.1',
      '127.255.255.255',
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.254',
      // IPv4 Link-Local & Cloud Metadata
      '169.254.169.254',
      '169.254.1.1',
      // IPv4 CGNAT & Protocol Assignments & Test nets & Multicast & Reserved
      '100.64.0.1',
      '100.127.255.255',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
      '0.0.0.0',
      // IPv6 Loopback & Unspecified
      '::1',
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '::',
      '0:0:0:0:0:0:0:0',
      // IPv6 Link-Local
      'fe80::1',
      'fe80::dead:beef',
      'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      // IPv6 Unique Local Address (ULA)
      'fc00::1',
      'fd00::1',
      'fd12:3456:789a:1::1',
      // IPv6 Multicast
      'ff02::1',
      'ff05::2',
      // IPv6 Documentation & Benchmarking & ORCHID
      '2001:db8::1',
      '2001:2::1',
      '2001:20::1',
      // IPv4-mapped IPv6
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:192.168.1.1',
      '[::ffff:127.0.0.1]',
      // IPv4-compatible IPv6 (deprecated)
      '::127.0.0.1',
      '::10.0.0.1',
      // IPv4/IPv6 translation
      '64:ff9b::10.0.0.1',
      '64:ff9b:1::1',
      // 6to4 embedding private IPv4
      '2002:0a00:0001::',
      // Malformed / Non-canonical IP formats (fail-closed)
      '999.999.999.999',
      '0177.0.0.1', // octal bypass attempt
      'invalid:::ipv6',
      '',
    ];

    for (const ip of forbiddenAddresses) {
      assert.equal(
        isPrivateOrSpecialIp(ip),
        true,
        `Forbidden IP '${ip}' MUST be rejected by SSRF defense`
      );
    }

    // Public IPs must not be falsely blocked
    const legitimatePublicIps = [
      '93.184.216.34', // example.com
      '8.8.8.8', // Google DNS
      '1.1.1.1', // Cloudflare DNS
      '2606:4700:4700::1111', // Cloudflare public IPv6
      '2001:4860:4860::8888', // Google public IPv6
    ];

    for (const pubIp of legitimatePublicIps) {
      assert.equal(
        isPrivateOrSpecialIp(pubIp),
        false,
        `Legitimate public IP '${pubIp}' should not be blocked`
      );
    }
  });

  // SEC-22: Real DNS rebinding (TOCTOU) defense rejects in-flight connection before socket is opened
  it('SEC-22: Real DNS rebinding (TOCTOU) defense rejects in-flight connection before socket is opened', async () => {
    // Proves: Even if pre-flight DNS lookup resolves to a legitimate public IP, when the in-flight
    // TLS connection lookup resolves to a forbidden IP (e.g. 127.0.0.1, 169.254.169.254, or fe80::1),
    // fetchSecureJwks intercepts it at socket creation, aborts immediately, and verifies assertion fails closed.
    const binding: TrustedApprovalBinding = {
      projectId,
      packageId: 'pkg-sec-22',
      revision: 1,
      contextFingerprint,
    };
    const claims: TrustedIdentityClaim = {
      identityId: 'id-01',
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      subject: 'alice@company.corp',
      actorRole: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      nonce: `nonce-${crypto.randomUUID()}`,
      authMethod: 'OIDC',
    };
    const token = createSignedJwt(claims, rsaPrivateKeyPem, binding);

    let rebindingCallCount = 0;
    const dnsLookupFn = async () => {
      rebindingCallCount++;
      if (rebindingCallCount === 1) {
        // Pre-flight check sees a public IP
        return [{ address: '93.184.216.34', family: 4 }];
      }
      // In-flight connection lookup rebinds to internal loopback!
      return [{ address: '127.0.0.1', family: 4 }];
    };

    const rebindAdapter = new OidcIdentityProviderAdapter({
      issuer: 'https://auth.company.corp',
      audience: 'aidm-core-platform',
      jwksUri: 'https://rebind-attack.victim.corp/keys',
      dnsLookupFn,
    });

    const res = await rebindAdapter.verifyAssertion({ token, binding }, binding);
    assert.equal(res.isValid, false);
    assert.equal(res.status, 'PROVIDER_OUTAGE');
    assert.equal(res.code, 'BLOCKED_ON_AUTH_CONTEXT');
    assert.ok(
      res.reason.includes('In-flight socket connection blocked'),
      `Expected in-flight rejection reason, got: ${res.reason}`
    );

    // Direct test of fetchSecureJwks proving in-flight rejection error
    const directDnsRebind = async () => {
      return [{ address: '169.254.169.254', family: 4 }];
    };

    await assert.rejects(
      async () => {
        await fetchSecureJwks('https://rebind-attack.victim.corp/keys', 5000, directDnsRebind);
      },
      /In-flight socket connection blocked: 'rebind-attack\.victim\.corp' resolved to forbidden IP '169\.254\.169\.254'/
    );
  });

  // SEC-23: Multiple DNS records with any forbidden address strictly fail closed
  it('SEC-23: Multiple DNS records with any forbidden address strictly fail closed', async () => {
    // Proves: If a domain resolves to multiple A/AAAA records where one is public and one is private,
    // both pre-flight DNS validation and in-flight socket lookup fail closed.
    const multiRecordDns = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }, // RFC1918 poison
    ];

    await assert.rejects(
      async () => {
        await validateJwksHostDns('dual-homed.evil.corp', multiRecordDns);
      },
      /JWKS URI resolves to forbidden private\/link-local\/metadata IP '10\.0\.0\.1'/
    );

    // Also in-flight fetchSecureJwks rejection
    await assert.rejects(
      async () => {
        await fetchSecureJwks('https://dual-homed.evil.corp/keys', 5000, multiRecordDns);
      },
      /In-flight socket connection blocked: 'dual-homed\.evil\.corp' resolved to forbidden IP '10\.0\.0\.1'/
    );

    // IPv6 poison in multiple records
    const multiIpv6Dns = async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '::1', family: 6 }, // Loopback poison
    ];

    await assert.rejects(
      async () => {
        await validateJwksHostDns('dual-homed-ipv6.evil.corp', multiIpv6Dns);
      },
      /JWKS URI resolves to forbidden private\/link-local\/metadata IP '::1'/
    );
  });

  // SEC-24: Fail-closed handling of DNS resolution errors, empty responses, and malformed address entries
  it('SEC-24: Fail-closed handling of DNS resolution errors, empty responses, and malformed address entries', async () => {
    // Proves: DNS lookups yielding errors, 0 records, or malformed entries fail closed without connecting.
    const errorDns = async () => {
      throw new Error('getaddrinfo ENOTFOUND nxdomain.corp');
    };

    await assert.rejects(
      async () => {
        await validateJwksHostDns('nxdomain.corp', errorDns);
      },
      /could not be resolved via DNS/
    );

    const emptyDns = async () => [];
    await assert.rejects(
      async () => {
        await validateJwksHostDns('empty.corp', emptyDns);
      },
      /yielded zero DNS address records/
    );

    await assert.rejects(
      async () => {
        await fetchSecureJwks('https://empty.corp/keys', 5000, emptyDns);
      },
      /In-flight DNS resolution for 'empty\.corp' returned zero records/
    );

    const malformedIpDns = async () => [{ address: 'not-an-ip-address', family: 4 }];
    await assert.rejects(
      async () => {
        await validateJwksHostDns('malformed.corp', malformedIpDns);
      },
      /forbidden private\/link-local\/metadata IP/
    );
  });

  // SEC-25: In-flight HTTP redirect blocking and metadata host defense
  it('SEC-25: In-flight HTTP redirect blocking and metadata host defense', async () => {
    // Proves: HTTP 3xx redirects over genuine TLS connection are blocked, and metadata hosts/credentials fail-closed.
    const pfxBase64 = 'MIIKEgIBAzCCCc4GCSqGSIb3DQEHAaCCCb8Eggm7MIIJtzCCBgAGCSqGSIb3DQEHAaCCBfEEggXtMIIF6TCCBeUGCyqGSIb3DQEMCgECoIIE/jCCBPowHAYKKoZIhvcNAQwBAzAOBAhhsDVptefIPgICB9AEggTY3ekShUfSm7q0MSSsQgKP3RlqEX8vKU33LdldSfntFdPv6oTdKsB65mXPmP+UCrgeOgAwRYZ8q1MaH4lycQzdgwg9tYk0QCV7I/IcJqTpPYjBI/YFF+2vMZCDwHDCapPR7jivh7z3a3WmmXtovoCV8VIJeCTR/jx9YSqLUXeefQlvNSBfog9+sL0CzbTzhZBl644dFy22Y1YACJeXmqGZhR6uW0np1Sx0OSJ0msgoeeVAUI+jhlYGyt2BSh0gc5XBZHepX291CMxYO1ZrUHEiwfl4And6qYayQNdN+Pi82G8YkG9Je18VzmO9M3kgBiqM1iNPG225n0Q65HleGP7j+qRYyVq7vhV7GbJdYUZGzI/3X1Ionzh3aybOI35CHfPJ+RhU1N5Prdr1Hsb3UurXC5VaBLnEnhaPMM+mF9WLfGiw5l0zqtiwAlGWfIkZH50dda+Vd7pBRt8Uv494+Om4kbnZMajrzIetn6bG223eipHZSrwTa322VgmtMpLrxAeuggJHJYVq9xfy4qvFvlkWc1imQ2gTGQw1RDH6tTOQGAiFBbXVBoPBttHOXliyFePmDH4J7vReLsD4vCLvY2+EKxMJyodcns5nflathSADbT98R4xnZoWglhSeQ6V/HI/Tm2eLv8ro7N5mWv+fHIEyiac2Lc/dD2v0/dT+p40XZaAX790beVYLVM6KTVbzfmkO5atc9CjPZzJlglyfKstR1UaDuHqherednwMR+UZh5e5w8z5mPKA9DM5kjeZOhaXJpHdjChOYnMFOPgED2Wwb+uPQb4ZX/ODmxbBhpGF+4VMklSYd/bJ2sW2gt7fra7we6WQ3lGIbvIvE0OsH/sMVElguB5LJnHwYBs/lEHw0arH/z1Vw65+aUm3LtV8K+/A4fl7EvRhT270ZUOm/PULtusK7MepcTUUBFd0PUYGodkSMeCyLXwWc5sARbm324h0bcF5QbnVnLx/fTCC5h2yedvl3d04byiaToq4Nxzw4ynFrjYG3Pyuttk1ijrjmEWFXyAFIGNAF0/V0C5unFcjRYZ+FE8gE+6A2b9KQn57rIM/BFLj9wK4JlgqjeITFBG2A694O5+svEFjD/lSqAjB8JMNTzu0cNmrAVTQF8FLHZO1p9C5R87JjuIPvejOAiSoZQc6G3xOF0lGxpXTRjTQuHJSUIeEEqBW96o2gYEoOj7ZyK1uS8n9oKdGO2YWpFsnWZPW+LSrgW7t+Ie08t4AUD2z9DrUeS9gQJJ1+31zs+NWsSucBOrflaSREbRy0s+8MXoSFWdkkN5MzvqphZNvbyZdloHToSLz7Ag1ff4/LJpbFkTYPa1pdnCsnpbWKZb/vCUxQ93h97iaa6AyiiIZfQmajt1G5/4pnFOPsJhqKneQTJHrDp1R6Kq9MY0EkVXYCAB4LAAba524phhnXs3aGXWwrgkxCHgZrw6udcHFnrBsqb5z4exVTJ9iRhh5sHritM6Pi6/9R1zf9ope9oi1RUkcgGPtyikssDyQjZtEIFRt2rDqrJxmR2kPUt2pEq+V5oshFAAebpOFtOY3Y3vzWoehrXi9HHl231MXdoCZ+3h8aO3yMwwyjkv6S6Qbmz4VL3l+vjLdALGpiQlms+phUq+cmefTToB+NZast3fF+6OSFgetg5NTMZTGB0zATBgkqhkiG9w0BCRUxBgQEAQAAADBdBgkqhkiG9w0BCRQxUB5OAHQAZQAtAGQAMwAxADAANQA0AGUANAAtADIAYwBlAGIALQA0AGQAYwAwAC0AOABkADMANAAtADEANwBmAGEAMAA0ADgAMABhAGEAOABiMF0GCSsGAQQBgjcRATFQHk4ATQBpAGMAcgBvAHMAbwBmAHQAIABTAG8AZgB0AHcAYQByAGUAIABLAGUAeQAgAFMAdABvAHIAYQBnAGUAIABQAHIAbwB2AGkAZABlAHIwggOvBgkqhkiG9w0BBwagggOgMIIDnAIBADCCA5UGCSqGSIb3DQEHATAcBgoqhkiG9w0BDAEDMA4ECJCC7KY1eX89AgIH0ICCA2gGPiJqqW4hIk9739lMHb+lWVgln03WsS9NTlA2t0ueISxLmoAU44FpHQ+VGPo7impFXLbYjU6KIFB1aEc8hUcPRJybVN/w1ZwqKurxay6dhA1GEbM2xnWNa0LeAwarRtCZiEDUK25xVe1DqoiztECDLeHH8PrzLdyuA3yrX8YXb3x7DZyga4QlVg67te7XOICKt5BrMmVsBwo+UN3RiKg1t/HUm/Vv0CSoBClKnF/R3CICAL0exd0H5JMluiz5mt9a5cbaPFNRhCCxa7oERSCdyAZYmmoJmca07lpV4rL0l7pcE17TldbSrmpA8b65Geu16mMbC4rWWTIqlz9CJgoXaC28E0ZwTWLhVsLYMYQ2YFqJ46w/0hK55AQd2g1fiyr8y8GQu/Xa59QEv+ODJxiupJwqhe7RDh+VKHlV9VKYBEnEQ0ONhyPyLf60q9Emkf/RUpci6YwC2IuLfRmOdYqTRk4efToVBDowKiBtnY/7+klKT7EzaGslNMZHBeKpQUJGgsDTAdhLdCgypuvkcTZCE99j2b2oX0jnB3hCytvlNHKGNoeBPTm1N6i4NM9gCyVOXqJJgvgxFCtZn+omW3jJ5BCP5JOdq5vBjoK05dH/W7FYRhQMX+cX1+6NjJHN6jYkJC2Zg9QEoCz89xSYoVio3NtWSLY5Tduqjjsjwjyq6ajjpDNCqsT2eaxs1dAwDufsaGdtSGRjrC6uf3fIMPCBmGH7qvMm53+fSTCtID2fbP1lVOm27lrWjRcIie8iJkvVsTkjw7G6uNbsFl9x6j8rf2fTLWuNbjbAZPbvhlJIxmLfdr1nfdanvAwAjG9P/mEYtuJR5wdWMr+XBK3ZYM2vdwWo+DFhls+QkH1xoxZwO6ZgcWHJaNK02vfqeziA65A2LNiX314TM5xDEG1YTf05gQQuRlgQ8gqbAYpwY1r94lJ8Q4gtvH5SU3KsAKRiS6qzXtfdVM5Vn+q4q19dibflw4+DBS2Vz1F/nZ10e7bLPiXmAznoWocj5PngYrT2DuvA4ggF5zhzxjNZWpc1Z3VArFwfh+ILY8hWdx54HTwv38kmHCtXKtmXipUOMzOdelV7KutIkcuYU3vzDnSs4rntckg1awVvpp/BZGS7qNEaN2tn6mcbVlrcOZWFzcoGMYoORVAvf/RPfzA7MB8wBwYFKw4DAhoEFLqHqearA1O37yd+Y/Av0vJbsaUVBBQL7VAmoTNMtMP/VbbdOPh7kwMaMAICB9A=';
    const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const testServer = https.createServer(
      { pfx: Buffer.from(pfxBase64, 'base64'), passphrase: 'test' },
      (_req, res) => {
        res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' });
        res.end();
      }
    );

    await new Promise<void>((resolve) => {
      testServer.listen(0, '127.0.0.1', () => resolve());
    });

    const port = (testServer.address() as any).port;

    try {
      await assert.rejects(
        async () => {
          await fetchSecureJwks(`https://127.0.0.1:${port}/keys`, 5000);
        },
        /JWKS endpoint attempted redirect to 'https:\/\/169\.254\.169\.254\/latest\/meta-data'\. Automatic redirects are blocked for SSRF defense\./
      );
    } finally {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }

    // Direct syntactic checks on metadata hostnames and user credentials
    assert.throws(
      () => validateJwksUri('https://metadata.google.internal/computeMetadata/v1/'),
      /targets forbidden cloud metadata IP/
    );

    assert.throws(
      () => validateJwksUri('https://169.254.169.254/keys'),
      /targets forbidden cloud metadata IP/
    );

    assert.throws(
      () => validateJwksUri('https://admin:secret@auth.company.corp/keys'),
      /must not contain embedded user credentials/
    );

    assert.throws(
      () => validateJwksUri('https://auth.company.corp:8080/keys'),
      /Non-standard port '8080' on JWKS URI is prohibited/
    );
  });

  // SEC-26: In-process mutex queue clean lifecycle and zero-leak cleanup
  it('SEC-26: In-process mutex queue clean lifecycle and zero-leak cleanup', async () => {
    // Proves: withInProcessLock retains identical promise identity, executes sequentially without race,
    // cleans up map entries back to 0, handles operation rejections without poisoning, and doesn't leak on 50+ paths.
    const fileA = path.join(tempDir, `lock-a-${crypto.randomUUID()}.json`);

    const executionLog: string[] = [];

    // 26a. Concurrent operations on same file execute in strict sequence
    const op1 = withInProcessLock(fileA, async () => {
      await new Promise((r) => setTimeout(r, 60));
      executionLog.push('op1');
      return 1;
    });

    const op2 = withInProcessLock(fileA, async () => {
      executionLog.push('op2');
      return 2;
    });

    const op3 = withInProcessLock(fileA, async () => {
      executionLog.push('op3');
      throw new Error('op3 expected failure');
    });

    const op4 = withInProcessLock(fileA, async () => {
      executionLog.push('op4');
      return 4;
    });

    const results = await Promise.allSettled([op1, op2, op3, op4]);
    assert.deepEqual(executionLog, ['op1', 'op2', 'op3', 'op4'], 'Operations MUST execute in strict serialization');
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[2].status, 'rejected');
    assert.equal(results[3].status, 'fulfilled', 'op4 MUST NOT be poisoned by op3 rejection');

    // Queue for fileA must be cleanly deleted from Map
    const normA = path.resolve(fileA);
    assert.equal(inProcessLockQueues.has(normA), false, 'Queue entry for fileA must be deleted after settlement');

    // 26b. High cardinality distinct paths must not accumulate queue entries
    const distinctOps = [];
    for (let i = 0; i < 60; i++) {
      const distinctFile = path.join(tempDir, `distinct-path-${i}.json`);
      distinctOps.push(
        withInProcessLock(distinctFile, async () => {
          return i * 2;
        })
      );
    }

    const distinctResults = await Promise.all(distinctOps);
    assert.equal(distinctResults.length, 60);
    assert.equal(inProcessLockQueues.size, 0, 'inProcessLockQueues Map must have 0 size after all operations complete');
  });

  // SEC-27: Persistent nonce replay retention beyond 2,000 nonces and restart durability
  it('SEC-27: Persistent nonce replay retention beyond 2,000 nonces and restart durability', async () => {
    // Proves: The vulnerable 2,000 nonce list slice is eliminated. Consuming >2,000 unique nonces
    // does not evict valid nonces, and attempts to replay the first nonce are strictly rejected across restarts.
    const customNonceFile = path.join(tempDir, `large-nonce-store-${crypto.randomUUID()}.json`);
    const store = new NonceStore({ filePath: customNonceFile });

    const firstNonce = `first-critical-nonce-${crypto.randomUUID()}`;
    const initialMarked = await store.markNonceSeen(firstNonce);
    assert.equal(initialMarked, true, 'First nonce must be marked seen initially');

    // Consume 2,050 unique nonces
    const largeBatch: string[] = [];
    for (let i = 1; i <= 2050; i++) {
      largeBatch.push(`batch-nonce-${i}-${crypto.randomUUID()}`);
    }

    const batchCount = await store.markNoncesSeenBatch(largeBatch);
    assert.equal(batchCount, 2050, 'All 2,050 batch nonces must be persisted');

    // Replay attempt on the first nonce MUST FAIL (firstNonce must NOT have been evicted!)
    const replayAttempt = await store.markNonceSeen(firstNonce);
    assert.equal(replayAttempt, false, 'First nonce MUST NOT be evicted or accepted for replay after 2,050 nonces');

    const isFirstSeen = await store.isNonceSeen(firstNonce);
    assert.equal(isFirstSeen, true, 'First nonce must be reported as seen');

    // Restart verification: Independent NonceStore instance simulating process restart
    const restartedStore = new NonceStore({ filePath: customNonceFile });
    const restartReplayAttempt = await restartedStore.markNonceSeen(firstNonce);
    assert.equal(restartReplayAttempt, false, 'Restarted store MUST detect replay of first nonce');

    const restartIsSeen = await restartedStore.isNonceSeen(firstNonce);
    assert.equal(restartIsSeen, true, 'Restarted store must find first nonce in persistent storage');
  });
});

