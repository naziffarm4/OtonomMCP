/**
 * Comprehensive Test Suite for Product Owner Approval Boundary (Phase 15 TASK-P15-08)
 *
 * Implements and validates all 30 adversarial security scenarios, MCP boundaries,
 * Director read integration, multi-layer integrity, and architectural invariants.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  AdaptiveDiscoveryEngine,
  AdaptiveDiscoveryStore,
  CompletenessGateEngine,
  CompletenessGateStore,
  RequirementsScopeEngine,
  RequirementsScopeStore,
  ArchitectureTechnologyEngine,
  ArchitectureTechnologyStore,
  BusinessRulesEngine,
  BusinessRulesStore,
  AcceptanceCriteriaEngine,
  AcceptanceCriteriaStore,
  RiskHumanDecisionEngine,
  RiskHumanDecisionStore,
  ProjectSpecEngine,
  ProjectSpecStore,
  ApprovalPackageEngine,
  ApprovalStore,
  ApprovalAuthorizationError,
  ApprovalInvalidIntentError,
  ApprovalAlreadyDecidedError,
  ApprovalRevisionMismatchError,
  ApprovalStaleError,
  ApprovalBlockedOnHumanError,
  ApprovalCompletenessGateFailedError,
  ApprovalProjectBindingMismatchError,
  ApprovalForgedFingerprintError,
  ApprovalIntegrityError,
  computePackageFingerprint,
  SpecStore,
  Actor,
  HistoryManager,
  DurableStateManager,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME,
  type ProjectDiscoveryRevision,
  type ProjectRequirementsScopeRevision,
  type ProjectArchitectureRevision,
  type ProjectBusinessRulesRevision,
  type ProjectAcceptanceCriteriaRevision,
  type ProjectRiskRevision,
  type ProjectSpecProjection,
  type CompletenessGateResult,
  type ApprovalPackage,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

describe('Product Owner Approval Capability (TASK-P15-08)', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let specStore: SpecStore;
  let durableManager: DurableStateManager;
  let discoveryStore: AdaptiveDiscoveryStore;
  let completenessStore: CompletenessGateStore;
  let requirementsStore: RequirementsScopeStore;
  let architectureStore: ArchitectureTechnologyStore;
  let businessRulesStore: BusinessRulesStore;
  let acceptanceCriteriaStore: AcceptanceCriteriaStore;
  let riskStore: RiskHumanDecisionStore;
  let specProjectionStore: ProjectSpecStore;
  let approvalStore: ApprovalStore;

  let discoveryEngine: AdaptiveDiscoveryEngine;
  let completenessEngine: CompletenessGateEngine;
  let requirementsEngine: RequirementsScopeEngine;
  let architectureEngine: ArchitectureTechnologyEngine;
  let businessRulesEngine: BusinessRulesEngine;
  let acceptanceCriteriaEngine: AcceptanceCriteriaEngine;
  let riskEngine: RiskHumanDecisionEngine;
  let projectSpecEngine: ProjectSpecEngine;
  let approvalEngine: ApprovalPackageEngine;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'po-approval-test-'));
    historyManager = new HistoryManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tempDir, historyManager });
    completenessStore = new CompletenessGateStore({ baseDir: tempDir, historyManager });
    requirementsStore = new RequirementsScopeStore({ baseDir: tempDir, historyManager });
    architectureStore = new ArchitectureTechnologyStore({ baseDir: tempDir, historyManager });
    businessRulesStore = new BusinessRulesStore({ baseDir: tempDir, historyManager });
    acceptanceCriteriaStore = new AcceptanceCriteriaStore({ baseDir: tempDir, historyManager });
    riskStore = new RiskHumanDecisionStore({ baseDir: tempDir, historyManager });
    specProjectionStore = new ProjectSpecStore({
      baseDir: tempDir,
      workspaceRoot: tempDir,
      historyManager,
    });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });

    discoveryEngine = new AdaptiveDiscoveryEngine({
      baseDir: tempDir,
      historyManager,
      specStore,
      discoveryStore,
    });

    completenessEngine = new CompletenessGateEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      historyManager,
      specStore,
    });

    requirementsEngine = new RequirementsScopeEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      historyManager,
      specStore,
    });

    architectureEngine = new ArchitectureTechnologyEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      historyManager,
      specStore,
    });

    businessRulesEngine = new BusinessRulesEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      historyManager,
      specStore,
    });

    acceptanceCriteriaEngine = new AcceptanceCriteriaEngine({
      baseDir: tempDir,
      discoveryStore,
      completenessStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      historyManager,
      specStore,
    });

    riskEngine = new RiskHumanDecisionEngine({
      baseDir: tempDir,
      discoveryStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      riskStore,
      historyManager,
      specStore,
    });

    projectSpecEngine = new ProjectSpecEngine({
      baseDir: tempDir,
      workspaceRoot: tempDir,
      discoveryStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      riskStore,
      specProjectionStore,
      historyManager,
      specStore,
    });

    approvalEngine = new ApprovalPackageEngine({
      baseDir: tempDir,
      workspaceRoot: tempDir,
      discoveryStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      riskStore,
      specProjectionStore,
      completenessStore,
      completenessEngine,
      approvalStore,
      historyManager,
    });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  async function setupCompleteProjectChain(projectId: string, options?: { unresolvedHdp?: boolean }): Promise<{
    discovery: ProjectDiscoveryRevision;
    requirements: ProjectRequirementsScopeRevision;
    architecture: ProjectArchitectureRevision;
    businessRules: ProjectBusinessRulesRevision;
    acceptanceCriteria: ProjectAcceptanceCriteriaRevision;
    risks: ProjectRiskRevision;
    completeness: CompletenessGateResult;
    specProjection: ProjectSpecProjection;
  }> {
    const discovery = await discoveryEngine.discover({
      projectId,
      rawPrompt: `
        Build a high-performance web multiplayer turn-based board game.
        In scope: user authentication, match lobby, real-time move validation, and persistent match history.
        Target users: casual online players and tournament administrators.
        Primary workflows: create match, join lobby, take turn, and view match history.
        Platform constraints: Web Application running in modern browsers.
        Required technologies: Node.js, TypeScript, React, and WebSocket.
        Architectural constraints: Clean architecture with decoupled game engine domain and websocket transport.
        Deployment model: Local / Self-Hosted Docker Container.
        Data storage expectations: PostgreSQL relational database with Redis session cache.
        Security requirements: JWT authentication, role-based authorization, and input sanitization on all moves.
        Measurable criteria: 100% test pass rate, turn latency under 100ms for 500 concurrent players, 0 data loss on disconnect.
        Definition of completion: Automated integration test suite green and production docker image built.
        Business rules: Turn timer is 30 seconds; 60-second disconnect grace period before forfeit.
        Exclusions: VR headset support is out of scope.
      `,
      explicitSections: {
        functionalRequirements: {
          capabilities: [],
          behaviors: [],
          businessRules: ['60-second disconnect grace window with turn timer continuation'],
        },
      },
      decidedHumanDecisions: {
        'HDEC-6ef75679d70c': 'Local / Self-Hosted Docker Container',
      },
    });

    const requirements = await requirementsEngine.derive({
      projectId,
      discoveryRevision: discovery.discoveryRevision,
    });

    const architecture = await architectureEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
    });

    const businessRules = await businessRulesEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
      architectureRevision: architecture.architectureRevision,
    });

    const acceptanceCriteria = await acceptanceCriteriaEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
      businessRulesRevision: businessRules.businessRulesRevision,
    });

    let risks = await riskEngine.derive({
      projectId,
      requirementsRevision: requirements.requirementsRevision,
      architectureRevision: architecture.architectureRevision,
      businessRulesRevision: businessRules.businessRulesRevision,
      acceptanceCriteriaRevision: acceptanceCriteria.acceptanceCriteriaRevision,
    });

    if (options?.unresolvedHdp) {
      // Insert a pending human decision point conforming to ProjectHumanDecisionPointZodSchema
      const mutatedHdp = [
        ...(risks.humanDecisionPoints ?? []),
        {
          decisionId: 'HDP-TEST-UNRESOLVED',
          title: 'Manual Approval for High-Value Trades',
          question: 'Do we require manual approval for trades exceeding $10M?',
          whyItMatters: 'Material regulatory risk threshold under SEC Rule 15c3-5',
          affectedRisks: [],
          affectedRequirements: [],
          affectedArchitectureDecisions: [],
          affectedBusinessRules: [],
          affectedAcceptanceCriteria: [],
          availableOptions: ['Yes, enforce hard stop', 'No, soft alert only'],
          consequences: ['Trade delays vs regulatory compliance'],
          recommendedInformation: 'Enforce hard stop for safety',
          authority: 'PRODUCT_OWNER' as const,
          status: 'PENDING_DECISION' as const,
          metadata: {},
        },
      ];
      risks = {
        ...risks,
        riskRevision: risks.riskRevision + 1,
        humanDecisionPoints: mutatedHdp,
      };
      const { computeRiskFingerprint } = await import('../dist/discovery/risk-human-decision-types.js');
      const { fingerprint: _fp, ...withoutFp } = risks;
      risks.fingerprint = computeRiskFingerprint(withoutFp as any);
      await riskStore.saveRevision(risks);
    } else {
      // Mark all HDPs as resolved for a ready baseline
      const resolvedHdp = (risks.humanDecisionPoints ?? []).map((hdp) => ({
        ...hdp,
        status: 'RESOLVED' as const,
      }));
      risks = {
        ...risks,
        riskRevision: risks.riskRevision + 1,
        humanDecisionPoints: resolvedHdp,
        humanDecisionCoverage: {
          totalHumanDecisionPoints: resolvedHdp.length,
          pendingHumanDecisionPoints: 0,
          resolvedHumanDecisionPoints: resolvedHdp.length,
        },
      };
      const { computeRiskFingerprint } = await import('../dist/discovery/risk-human-decision-types.js');
      const { fingerprint: _fp, ...withoutFp } = risks;
      risks.fingerprint = computeRiskFingerprint(withoutFp as any);
      await riskStore.saveRevision(risks);
    }

    const completeness = await completenessEngine.evaluate({
      projectId,
      discoveryRevision: discovery.discoveryRevision,
    });

    const specProjection = await projectSpecEngine.generate({ projectId });

    return {
      discovery,
      requirements,
      architecture,
      businessRules,
      acceptanceCriteria,
      risks,
      completeness,
      specProjection,
    };
  }

  // ==========================================================================
  // 1. DIRECTOR attempting approval -> rejected
  // ==========================================================================
  it('01_adversarial: DIRECTOR attempting approval is strictly rejected', async () => {
    const projectId = 'proj-adv-01';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'director-agent',
          actorRole: 'DIRECTOR' as any,
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAuthorizationError && err.message.includes('DIRECTOR')
    );
  });

  // ==========================================================================
  // 2. SYSTEM attempting approval -> rejected
  // ==========================================================================
  it('02_adversarial: SYSTEM attempting approval is strictly rejected', async () => {
    const projectId = 'proj-adv-02';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'SYSTEM',
          actorRole: 'SYSTEM' as any,
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAuthorizationError
    );
  });

  // ==========================================================================
  // 3. EXECUTOR attempting approval -> rejected
  // ==========================================================================
  it('03_adversarial: EXECUTOR attempting approval is strictly rejected', async () => {
    const projectId = 'proj-adv-03';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'EXECUTOR',
          actorRole: 'EXECUTOR' as any,
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAuthorizationError
    );
  });

  // ==========================================================================
  // 4. ANTIGRAVITY attempting approval -> rejected
  // ==========================================================================
  it('04_adversarial: ANTIGRAVITY attempting approval is strictly rejected', async () => {
    const projectId = 'proj-adv-04';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'ANTIGRAVITY',
          actorRole: 'USER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAuthorizationError
    );
  });

  // ==========================================================================
  // 5. Natural-language "tamam" -> rejected
  // ==========================================================================
  it('05_adversarial: natural-language "tamam" is rejected as approval intent', async () => {
    const projectId = 'proj-adv-05';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'tamam' as any,
        }),
      (err: any) => err instanceof ApprovalInvalidIntentError
    );
  });

  // ==========================================================================
  // 6. Natural-language "olur" -> rejected
  // ==========================================================================
  it('06_adversarial: natural-language "olur" is rejected as approval intent', async () => {
    const projectId = 'proj-adv-06';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'olur' as any,
        }),
      (err: any) => err instanceof ApprovalInvalidIntentError
    );
  });

  // ==========================================================================
  // 7. Natural-language "yes" -> rejected
  // ==========================================================================
  it('07_adversarial: natural-language "yes" is rejected as approval intent', async () => {
    const projectId = 'proj-adv-07';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'yes' as any,
        }),
      (err: any) => err instanceof ApprovalInvalidIntentError
    );
  });

  // ==========================================================================
  // 8. Clarification answer mistaken as approval -> rejected
  // ==========================================================================
  it('08_adversarial: clarification answer does not grant project approval', async () => {
    const projectId = 'proj-adv-08';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Clarification answer is not an approval intent
    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'ANSWER_CLARIFICATION' as any,
        }),
      (err: any) => err instanceof ApprovalInvalidIntentError
    );
    assert.equal(approvalEngine.isDevelopmentAuthorized(pkg), false);
  });

  // ==========================================================================
  // 9. Stale PROJECT_SPEC -> blocks approval
  // ==========================================================================
  it('09_adversarial: stale PROJECT_SPEC blocks approval', async () => {
    const projectId = 'proj-adv-09';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Mark PROJECT_SPEC stale in store
    const specLatest = await specProjectionStore.loadRevision(projectId);
    assert.ok(specLatest);
    const latestJsonPath = path.join(
      specProjectionStore.recordsDir,
      specProjectionStore.sanitizeProjectId(projectId),
      'latest.json'
    );
    await fs.promises.writeFile(
      latestJsonPath,
      JSON.stringify({ ...specLatest, isStale: true, stalenessReason: 'Upstream modified' }),
      'utf8'
    );

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 10. Stale requirements -> blocks approval
  // ==========================================================================
  it('10_adversarial: stale requirements blocks approval', async () => {
    const projectId = 'proj-adv-10';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Advance requirements in store to rev 2
    const reqLatest = await requirementsStore.loadRevision(projectId);
    assert.ok(reqLatest);
    await requirementsStore.saveRevision({
      ...reqLatest,
      requirementsRevision: reqLatest.requirementsRevision + 1,
      fingerprint: 'fp-new-req-changed',
    });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 11. Stale architecture -> blocks approval
  // ==========================================================================
  it('11_adversarial: stale architecture blocks approval', async () => {
    const projectId = 'proj-adv-11';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const archLatest = await architectureStore.loadRevision(projectId);
    assert.ok(archLatest);
    await architectureStore.saveRevision({
      ...archLatest,
      architectureRevision: archLatest.architectureRevision + 1,
      fingerprint: 'fp-new-arch-changed',
    });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 12. Stale business rules -> blocks approval
  // ==========================================================================
  it('12_adversarial: stale business rules blocks approval', async () => {
    const projectId = 'proj-adv-12';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const brLatest = await businessRulesStore.loadRevision(projectId);
    assert.ok(brLatest);
    await businessRulesStore.saveRevision({
      ...brLatest,
      businessRulesRevision: brLatest.businessRulesRevision + 1,
      fingerprint: 'fp-new-br-changed',
    });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 13. Stale acceptance criteria -> blocks approval
  // ==========================================================================
  it('13_adversarial: stale acceptance criteria blocks approval', async () => {
    const projectId = 'proj-adv-13';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const acLatest = await acceptanceCriteriaStore.loadRevision(projectId);
    assert.ok(acLatest);
    const { computeAcceptanceCriteriaFingerprint } = await import('../dist/discovery/acceptance-criteria-types.js');
    const newAc = {
      ...acLatest,
      acceptanceCriteriaRevision: acLatest.acceptanceCriteriaRevision + 1,
    };
    const { fingerprint: _fp, ...withoutFp } = newAc;
    newAc.fingerprint = computeAcceptanceCriteriaFingerprint(withoutFp as any);
    await acceptanceCriteriaStore.saveRevision(newAc);

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 14. Stale risks -> blocks approval
  // ==========================================================================
  it('14_adversarial: stale risks blocks approval', async () => {
    const projectId = 'proj-adv-14';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const rkLatest = await riskStore.loadRevision(projectId);
    assert.ok(rkLatest);
    const { computeRiskFingerprint } = await import('../dist/discovery/risk-human-decision-types.js');
    const newRk = {
      ...rkLatest,
      riskRevision: rkLatest.riskRevision + 1,
    };
    const { fingerprint: _fp, ...withoutFp } = newRk;
    newRk.fingerprint = computeRiskFingerprint(withoutFp as any);
    await riskStore.saveRevision(newRk);

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 15. Unresolved human decision -> blocks approval
  // ==========================================================================
  it('15_adversarial: unresolved human decision blocks approval', async () => {
    const projectId = 'proj-adv-15';
    await setupCompleteProjectChain(projectId, { unresolvedHdp: true });
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.equal(pkg.status, 'BLOCKED_ON_HUMAN');
    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalBlockedOnHumanError
    );
  });

  // ==========================================================================
  // 16. Incomplete specification -> blocks approval
  // ==========================================================================
  it('16_adversarial: incomplete specification (gate status != COMPLETE) blocks approval', async () => {
    const projectId = 'proj-adv-16';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Mutate completeness gate in store and package to INCOMPLETE
    const compLatest = await completenessStore.loadResult(projectId);
    assert.ok(compLatest);
    const compLatestPath = path.join(
      completenessStore.recordsDir,
      completenessStore.sanitizeProjectId(projectId),
      'latest.json'
    );
    await fs.promises.writeFile(
      compLatestPath,
      JSON.stringify({ ...compLatest, status: 'INCOMPLETE' }),
      'utf8'
    );

    const incompletePkgBase: ApprovalPackage = {
      ...pkg,
      completenessResult: {
        ...pkg.completenessResult!,
        status: 'INCOMPLETE' as any,
      },
    };
    const incompletePkg: ApprovalPackage = {
      ...incompletePkgBase,
      packageFingerprint: computePackageFingerprint(incompletePkgBase),
    };

    assert.throws(
      () =>
        approvalEngine.approvePackage(incompletePkg, {
          packageId: incompletePkg.packageId,
          revision: incompletePkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalCompletenessGateFailedError
    );
  });

  // ==========================================================================
  // 17. Cross-project approval package -> rejected
  // ==========================================================================
  it('17_adversarial: cross-project approval package access is rejected', async () => {
    const projectId1 = 'proj-adv-17-a';
    const projectId2 = 'proj-adv-17-b';
    await setupCompleteProjectChain(projectId1);
    await setupCompleteProjectChain(projectId2);

    const pkg1 = await approvalEngine.createApprovalPackage({ projectId: projectId1 });

    // Attempting to load pkg1 with expectedProjectId2 must fail
    await assert.rejects(
      async () => approvalStore.loadPackage(pkg1.packageId, pkg1.revision, projectId2),
      (err: any) => err instanceof ApprovalProjectBindingMismatchError
    );
  });

  // ==========================================================================
  // 18. Forged approval package -> throws ApprovalForgedFingerprintError
  // ==========================================================================
  it('18_adversarial: forged approval package fails self-consistency integrity check', async () => {
    const projectId = 'proj-adv-18';
    await setupCompleteProjectChain(projectId, { unresolvedHdp: true });
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Tamper with package without recomputing fingerprint
    const forgedPkg: ApprovalPackage = {
      ...pkg,
      status: 'READY_FOR_APPROVAL',
      unresolvedHumanDecisionPoints: [], // maliciously cleared
    };

    assert.throws(
      () =>
        approvalEngine.approvePackage(forgedPkg, {
          packageId: forgedPkg.packageId,
          revision: forgedPkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalForgedFingerprintError
    );
  });

  // ==========================================================================
  // 19. Recomputed forged fingerprint -> throws ApprovalIntegrityError
  // ==========================================================================
  it('19_adversarial: recomputed forged fingerprint fails closed against authoritative store', async () => {
    const projectId = 'proj-adv-19';
    await setupCompleteProjectChain(projectId, { unresolvedHdp: true });
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Maliciously forge package by clearing unresolved HDPs AND recomputing self-fingerprint
    const forgedPkgBase: ApprovalPackage = {
      ...pkg,
      status: 'READY_FOR_APPROVAL',
      unresolvedHumanDecisionPoints: [],
    };
    const recomputedFp = computePackageFingerprint(forgedPkgBase);
    const forgedPkg = Object.freeze({
      ...forgedPkgBase,
      packageFingerprint: recomputedFp,
    });

    // Fails closed because authoritative store on disk still contains unresolved decisions
    assert.throws(
      () =>
        approvalEngine.approvePackage(forgedPkg, {
          packageId: forgedPkg.packageId,
          revision: forgedPkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalIntegrityError
    );
  });

  // ==========================================================================
  // 20. Modified source after package creation -> package detected as stale
  // ==========================================================================
  it('20_adversarial: modified source after package creation marks package STALE', async () => {
    const projectId = 'proj-adv-20';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Modify discovery store
    const disc = await discoveryStore.loadRevision(projectId);
    assert.ok(disc);
    await discoveryStore.saveRevision({
      ...disc,
      discoveryRevision: disc.discoveryRevision + 1,
      fingerprint: 'fp-modified-discovery',
    });

    const staleness = await approvalEngine.checkStaleness(pkg);
    assert.equal(staleness.isStale, true);
    assert.ok(staleness.reasons.some((r) => r.includes('Discovery revision has changed')));

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalStaleError
    );
  });

  // ==========================================================================
  // 21. Duplicate approval request -> rejected
  // ==========================================================================
  it('21_adversarial: duplicate approval request on already approved package is rejected', async () => {
    const projectId = 'proj-adv-21';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const approvedPkg = approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Initial PO approval',
    });
    assert.equal(approvedPkg.status, 'APPROVED');

    // Duplicate call on the approved package must fail
    assert.throws(
      () =>
        approvalEngine.approvePackage(approvedPkg, {
          packageId: approvedPkg.packageId,
          revision: approvedPkg.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAlreadyDecidedError
    );
  });

  // ==========================================================================
  // 22. Replay of identical explicit approval -> rejected
  // ==========================================================================
  it('22_adversarial: replay of identical explicit approval is rejected deterministically', async () => {
    const projectId = 'proj-adv-22';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const input = {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER' as const,
      intent: 'EXPLICIT_APPROVAL' as const,
      comment: 'First approval',
    };

    const approved = approvalEngine.approvePackage(pkg, input);
    await approvalStore.savePackage(approved);

    const reloaded = await approvalStore.loadPackage(pkg.packageId, pkg.revision);
    assert.ok(reloaded);

    // Replay against reloaded state must fail
    assert.throws(
      () => approvalEngine.approvePackage(reloaded, input),
      (err: any) => err instanceof ApprovalAlreadyDecidedError
    );
  });

  // ==========================================================================
  // 23. Approval after rejection -> policy requires new revision
  // ==========================================================================
  it('23_adversarial: approving a REJECTED package directly is rejected; requires new revision', async () => {
    const projectId = 'proj-adv-23';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const rejected = approvalEngine.rejectPackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_REJECTION',
      reason: 'Scope too broad',
    });
    assert.equal(rejected.status, 'REJECTED');

    // Cannot approve rejected package directly
    assert.throws(
      () =>
        approvalEngine.approvePackage(rejected, {
          packageId: rejected.packageId,
          revision: rejected.revision,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAlreadyDecidedError
    );

    // After revision, revision 2 can be approved
    const { newPackage: rev2 } = approvalEngine.revisePackage(rejected);
    assert.equal(rev2.revision, 2);
    assert.equal(rev2.status, 'READY_FOR_APPROVAL');

    const approvedRev2 = approvalEngine.approvePackage(rev2, {
      packageId: rev2.packageId,
      revision: 2,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(approvedRev2.status, 'APPROVED');
  });

  // ==========================================================================
  // 24. Approval after source revision change -> revision mismatch rejected
  // ==========================================================================
  it('24_adversarial: approval input with mismatched revision is rejected', async () => {
    const projectId = 'proj-adv-24';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    assert.throws(
      () =>
        approvalEngine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision + 5, // mismatched revision
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalRevisionMismatchError
    );
  });

  // ==========================================================================
  // 25. Approval does NOT create ExecutionIntent
  // ==========================================================================
  it('25_invariant: approving project understanding does NOT create ExecutionIntent', async () => {
    const projectId = 'proj-adv-25';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const executionIntentsPath = path.join(tempDir, '.ai-manager', 'execution-intents');
    assert.equal(fs.existsSync(executionIntentsPath), false);
  });

  // ==========================================================================
  // 26. Approval does NOT create ExecutionRequest
  // ==========================================================================
  it('26_invariant: approving project understanding does NOT create ExecutionRequest', async () => {
    const projectId = 'proj-adv-26';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const requestsPath = path.join(tempDir, '.ai-manager', 'execution-requests');
    assert.equal(fs.existsSync(requestsPath), false);
  });

  // ==========================================================================
  // 27. Approval does NOT invoke Antigravity
  // ==========================================================================
  it('27_invariant: approving project understanding does NOT invoke Antigravity', async () => {
    const projectId = 'proj-adv-27';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const events = historyManager ? await historyManager.readEvents() : [];
    assert.ok(!events.some((e) => e.eventType.includes('ANTIGRAVITY')));
  });

  // ==========================================================================
  // 28. Approval does NOT mutate Task DAG
  // ==========================================================================
  it('28_invariant: approving project understanding does NOT mutate Task DAG', async () => {
    const projectId = 'proj-adv-28';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const tasks = await specStore.loadTasks().catch(() => []);
    assert.equal(tasks.length, 0);
  });

  // ==========================================================================
  // 29. Approval does NOT start driver
  // ==========================================================================
  it('29_invariant: approving project understanding does NOT start autonomous loop or driver', async () => {
    const projectId = 'proj-adv-29';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const durableState = await durableManager.load();
    assert.ok(!durableState || durableState.currentLifecycleState !== 'IN_PROGRESS');
  });

  // ==========================================================================
  // 30. Restart/reload preserves approval state
  // ==========================================================================
  it('30_persistence: restart/reload preserves exact approved state across fresh instances', async () => {
    const projectId = 'proj-adv-30';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    const approvedPkg = approvalEngine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for persistence check',
    });
    await approvalStore.savePackage(approvedPkg);

    // Fresh store instance simulating restart
    const freshStore = new ApprovalStore({ baseDir: tempDir });
    const reloaded = await freshStore.loadPackage(pkg.packageId, pkg.revision);

    assert.ok(reloaded);
    assert.equal(reloaded.status, 'APPROVED');
    assert.equal(reloaded.approvalRecord?.actor, 'alice-po');
    assert.equal(reloaded.approvalRecord?.actorRole, 'PRODUCT_OWNER');
    assert.equal(reloaded.approvalRecord?.intent, 'EXPLICIT_APPROVAL');
    assert.equal(reloaded.packageFingerprint, approvedPkg.packageFingerprint);

    const freshEngine = new ApprovalPackageEngine({ baseDir: tempDir });
    assert.equal(freshEngine.isDevelopmentAuthorized(reloaded), true);
  });

  // ==========================================================================
  // 31. MCP Tools Integration
  // ==========================================================================
  it('31_mcp: creates, gets, checks readiness, approves, and rejects via MCP tools', async () => {
    const projectId = 'proj-mcp-31';
    await setupCompleteProjectChain(projectId);

    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      specStore,
      historyManager,
      discoveryStore,
      requirementsStore,
      architectureStore,
      businessRulesStore,
      acceptanceCriteriaStore,
      riskStore,
      specProjectionStore,
      completenessStore,
      approvalStore,
      approvalPackageEngine: approvalEngine,
    });

    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      approvalTools: true,
    });
    await server.start();

    // 1. Create approval package via MCP
    const createRes = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 'req-create-1',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
        arguments: { projectId },
      },
    } as McpRequestEnvelope)) as McpSuccessResponseEnvelope;

    assert.ok(createRes.result);
    const createdPayload = JSON.parse(createRes.result.content[0].text);
    assert.equal(createdPayload.projectId, projectId);
    assert.equal(createdPayload.status, 'READY_FOR_APPROVAL');

    // 2. Check readiness via MCP
    const readinessRes = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 'req-readiness-1',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
        arguments: { packageId: createdPayload.packageId, projectId },
      },
    } as McpRequestEnvelope)) as McpSuccessResponseEnvelope;

    const readinessPayload = JSON.parse(readinessRes.result.content[0].text);
    const isReady = readinessPayload.readiness?.isReady ?? readinessPayload.isReady;
    const status = readinessPayload.readiness?.status ?? readinessPayload.currentStatus;
    assert.equal(isReady, true);
    assert.equal(status, 'READY_FOR_APPROVAL');

    // 3. Director attempting approval via MCP is BLOCKED
    const directorApproveRes = await server.handleMessage({
      jsonrpc: '2.0',
      id: 'req-dir-approve-1',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          packageId: createdPayload.packageId,
          revision: createdPayload.revision,
          projectId,
          actor: 'DIRECTOR',
          actorRole: 'DIRECTOR',
          intent: 'EXPLICIT_APPROVAL',
        },
      },
    } as McpRequestEnvelope);

    assert.ok((directorApproveRes as any).error);
    assert.match((directorApproveRes as any).error.message, /Only human Product Owner.*may grant project approval/);

    // 4. Product Owner explicitly approves via MCP
    const poApproveRes = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 'req-po-approve-1',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          packageId: createdPayload.packageId,
          revision: createdPayload.revision,
          projectId,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
          comment: 'Approved via MCP boundary',
        },
      },
    } as McpRequestEnvelope)) as McpSuccessResponseEnvelope;

    const approvedPayload = JSON.parse(poApproveRes.result.content[0].text);
    assert.equal(approvedPayload.status, 'APPROVED');
    assert.equal(approvedPayload.approvalRecord.actor, 'alice-po');

    // 5. Get approval package via MCP
    const getRes = (await server.handleMessage({
      jsonrpc: '2.0',
      id: 'req-get-1',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
        arguments: { packageId: createdPayload.packageId, projectId },
      },
    } as McpRequestEnvelope)) as McpSuccessResponseEnvelope;

    const getPayload = JSON.parse(getRes.result.content[0].text);
    assert.equal(getPayload.status, 'APPROVED');
  });

  // ==========================================================================
  // 32. Director Read Integration
  // ==========================================================================
  it('32_director_read: Director can inspect package, readiness, and staleness without approving', async () => {
    const projectId = 'proj-dir-read-32';
    await setupCompleteProjectChain(projectId);
    const pkg = await approvalEngine.createApprovalPackage({ projectId });

    // Director inspects package
    const inspected = await approvalStore.loadPackage(pkg.packageId, pkg.revision, projectId);
    assert.ok(inspected);
    assert.equal(inspected.projectId, projectId);
    assert.equal(inspected.status, 'READY_FOR_APPROVAL');

    // Director evaluates readiness
    const readiness = await approvalEngine.checkReadinessAsync(inspected);
    assert.equal(readiness.isReady, true);
    assert.equal(readiness.status, 'READY_FOR_APPROVAL');

    // Director checks staleness
    const staleness = await approvalEngine.checkStaleness(inspected);
    assert.equal(staleness.isStale, false);

    // Director is not allowed to approve
    assert.throws(
      () =>
        approvalEngine.approvePackage(inspected, {
          packageId: inspected.packageId,
          revision: inspected.revision,
          actor: 'director-agent',
          actorRole: 'DIRECTOR' as any,
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: any) => err instanceof ApprovalAuthorizationError
    );
  });
});
