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
  OidcIdentityProviderAdapter,
  MtlsIdentityProviderAdapter,
  UnconfiguredIdentityProviderAdapter,
  TestDoubleIdentityProviderAdapter,
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

  function createSignedJwt(payload: Record<string, unknown>, privateKeyPem: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${header}.${body}`;
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

    const token = createSignedJwt(claims, rsaPrivateKeyPem);
    const assertion: TrustedIdentityAssertion = {
      token,
      binding: {
        projectId,
        packageId: pkg.packageId,
        revision: pkg.revision,
        contextFingerprint,
        directorSessionId,
      },
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
      { token: createSignedJwt(claimsWrongIssuer, rsaPrivateKeyPem), binding, claims: claimsWrongIssuer },
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
      { token: createSignedJwt(claimsWrongAudience, rsaPrivateKeyPem), binding, claims: claimsWrongAudience },
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

    const forgedToken = createSignedJwt(claims, roguePrivateKeyPem);

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

    const token = createSignedJwt(claims, rsaPrivateKeyPem);
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

    const token = createSignedJwt(claims, rsaPrivateKeyPem);
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
      const token = createSignedJwt(claims, rsaPrivateKeyPem);
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

    const token = createSignedJwt(claims, rsaPrivateKeyPem);

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
});
