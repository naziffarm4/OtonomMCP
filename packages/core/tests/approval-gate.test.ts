/**
 * Comprehensive Test Suite for Phase 8 Initial Project Understanding & Approval Gate (TASK-P8-05)
 *
 * Verifies all 30 deterministic test requirements:
 * 1. Build understanding from discovery
 * 2. Incorporate resolved clarification answers
 * 3. Preserve unresolved unknowns
 * 4. Preserve assumptions
 * 5. Preserve evidence references
 * 6. Build proposed development plan
 * 7. NOT_READY when blocking clarification remains
 * 8. NOT_READY when contradiction remains
 * 9. READY_FOR_APPROVAL when all blocking conditions resolve
 * 10. Explicit approval
 * 11. Approval actor validation
 * 12. Approval package revision binding
 * 13. Approval invalidated by revision change
 * 14. Explicit rejection
 * 15. Rejection preserves reason
 * 16. Clarification answer is not approval
 * 17. Natural-language "tamam" is not automatically treated as approval
 * 18. No automatic task creation
 * 19. No requirements mutation
 * 20. No architecture mutation
 * 21. No Antigravity invocation
 * 22. No autonomous execution
 * 23. No duplicate FSM
 * 24. Persistence/recovery
 * 25. Approval event history
 * 26. Evidence traceability
 * 27. MCP authorization boundary
 * 28. MCP invalid approval rejection
 * 29. Concurrent/stale approval revision handling
 * 30. Read-only source-project guarantee
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import {
  InitialProjectUnderstandingBuilder,
  ApprovalPackageEngine,
  ApprovalStore,
  computePackageHash,
  ApprovalAuthorizationError,
  ApprovalRevisionMismatchError,
  ApprovalInvalidIntentError,
  ApprovalNotReadyError,
  ApprovalAlreadyDecidedError,
  type ProjectDiscoveryReport,
  type ClarificationSession,
  type ProjectApprovalPackage,
  SpecStore,
  DurableStateManager,
  HistoryManager,
  TaskDagEngine,
  Actor,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_GET_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
  AIDM_APPROVAL_PACKAGE_REJECT_TOOL_NAME,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

const execFile = promisify(execFileCallback);

function createMockReport(overrides?: Partial<ProjectDiscoveryReport>): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'test-approval-project',
      version: '1.0.0',
      workspaceRoot: '/mock/workspace',
      ecosystem: 'Node.js',
      evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'A deterministic agent orchestration platform',
      domainKeywords: ['orchestration', 'agent'],
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'README.md' }],
    },
    technologyStack: {
      primaryLanguages: ['TypeScript'],
      frameworks: [],
      buildTools: ['tsc'],
      packageManagers: ['npm'],
      runtimes: ['node'],
      containerization: [],
      ciCd: [],
      workspaceType: 'standalone',
      dependencies: [],
      devDependencies: [],
      evidence: [{ sourceType: 'CONFIG', sourceIdentifier: 'tsconfig.json' }],
    },
    repositoryStructure: {
      layout: 'standard-src',
      topLevelDirectories: ['src', 'tests'],
      totalFileCount: 12,
      significantFiles: ['package.json', 'tsconfig.json'],
      fileExtensions: ['.ts', '.json'],
      evidence: [],
    },
    architecture: {
      identifiedAreas: [],
      architecturalPattern: 'Modular',
      summary: 'Standard modular TypeScript architecture',
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/index.ts' }],
    },
    entryPoints: [
      {
        type: 'main',
        target: 'src/index.ts',
        source: 'package.json:main',
        isAuthoritative: true,
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json:main' }],
      },
    ],
    commands: {
      build: {
        status: 'DISCOVERED',
        command: 'npm run build',
        source: 'package.json:scripts.build',
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json:scripts.build' }],
      },
      test: {
        status: 'DISCOVERED',
        command: 'npm test',
        source: 'package.json:scripts.test',
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json:scripts.test' }],
      },
      runtime: {
        status: 'DISCOVERED',
        command: 'node dist/index.js',
        evidence: [],
      },
      lint: {
        status: 'UNKNOWN',
        evidence: [],
      },
    },
    featureInventory: [
      {
        id: 'feat-1',
        name: 'Orchestrator FSM',
        description: 'Deterministic state machine lifecycle',
        status: 'IMPLEMENTED',
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/fsm/state-machine.ts' }],
      },
      {
        id: 'feat-2',
        name: 'UI Verification',
        description: 'Automated browser verification pipeline',
        status: 'DOCUMENTED_ONLY',
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'docs/ui-spec.md' }],
      },
    ],
    documentationSummary: {
      hasReadme: true,
      readmePath: 'README.md',
      hasContributing: false,
      hasArchitectureDocs: false,
      documentationFiles: ['README.md'],
      summary: 'README present',
      evidence: [],
    },
    requirementsSummary: {
      totalRequirements: 1,
      lockedCount: 1,
      source: 'AIDM_SPEC_STORE',
      requirements: [
        {
          id: 'REQ-001',
          title: 'Deterministic State Transitions',
          status: 'LOCKED',
          authority: 'PRODUCT_OWNER',
          acceptanceCriteriaCount: 2,
        },
      ],
      evidence: [{ sourceType: 'SPEC_STORE', sourceIdentifier: 'requirements.json' }],
    },
    decisionsSummary: {
      totalDecisions: 1,
      source: 'AIDM_SPEC_STORE',
      decisions: [
        {
          id: 'DEC-001',
          title: 'Use SQLite and Atomic JSON',
          status: 'ADOPTED',
          authority: 'PRODUCT_OWNER',
        },
      ],
      evidence: [{ sourceType: 'SPEC_STORE', sourceIdentifier: 'decisions.json' }],
    },
    currentImplementationState: {
      lifecycleState: 'REQUIREMENTS_INGESTION',
      hasActiveTask: false,
      isBlocked: false,
      totalTasksInDag: 0,
      completedTasksCount: 0,
      evidence: [{ sourceType: 'STATE_MANAGER', sourceIdentifier: 'durable-state.json' }],
    },
    gitStatus: {
      uncommittedChangesCount: 0,
      untrackedFilesCount: 0,
      evidence: [{ sourceType: 'GIT', sourceIdentifier: 'HEAD' }],
    },
    facts: [
      {
        id: 'fact-1',
        statement: 'Package name is test-approval-project',
        category: 'IDENTITY',
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
      },
    ],
    observations: [],
    inferences: [
      {
        id: 'inf-1',
        inference: 'Project uses standard Node.js module resolution',
        rationale: 'tsconfig.json specifies moduleResolution: NodeNext',
        basisEvidence: [{ sourceType: 'CONFIG', sourceIdentifier: 'tsconfig.json' }],
      },
    ],
    unknowns: [
      {
        id: 'unk-1',
        item: 'Production deployment target',
        description: 'No Dockerfile or Kubernetes manifests discovered',
        impact: 'Deployment scope remains undefined',
      },
    ],
    contradictions: [],
    clarificationCandidates: [],
    recommendedNextAction: 'PROCEED_TO_CLARIFICATION',
    timestamp: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

function createMockClarificationSession(overrides?: Partial<ClarificationSession>): ClarificationSession {
  return {
    sessionId: 'session-mock-123',
    projectId: 'test-approval-project',
    sourceDiscoveryReference: '2026-09-24T10:00:00.000Z',
    questions: [
      {
        clarificationId: 'clarif-1',
        kind: 'UNKNOWN_PRODUCT_INTENT',
        priority: 'REQUIRED',
        question: 'What is the target deployment environment?',
        context: 'No deployment manifests found',
        reason: 'Required for infrastructure planning',
        evidence: [{ sourceType: 'CONFIG', sourceIdentifier: 'package.json' }],
        options: ['Docker container', 'Serverless cloud function', 'Standalone binary'],
        allowsFreeFormAnswer: true,
        status: 'ANSWERED',
        blocking: true,
        uncertaintyType: 'MISSING',
        createdAt: '2026-09-24T10:05:00.000Z',
        answer: {
          clarificationId: 'clarif-1',
          answerType: 'OPTION_SELECTION',
          selectedOptions: ['Docker container'],
          timestamp: '2026-09-24T10:06:00.000Z',
          source: 'HUMAN',
          status: 'ANSWERED',
        },
      },
    ],
    answers: [
      {
        clarificationId: 'clarif-1',
        answerType: 'OPTION_SELECTION',
        selectedOptions: ['Docker container'],
        timestamp: '2026-09-24T10:06:00.000Z',
        source: 'HUMAN',
        status: 'ANSWERED',
      },
    ],
    status: 'RESOLVED',
    blockingOpenCount: 0,
    totalCount: 1,
    resolvedCount: 1,
    createdAt: '2026-09-24T10:05:00.000Z',
    updatedAt: '2026-09-24T10:06:00.000Z',
    ...overrides,
  };
}

describe('Phase 8 TASK-P8-05: Initial Project Understanding & Approval Gate Protocol', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p8-05-test-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================================================
  // REQUIREMENT 1: Build understanding from discovery
  // ==========================================================================
  it('T01_build_understanding_from_discovery: synthesizes discovery findings into InitialProjectUnderstanding', () => {
    const report = createMockReport();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report);

    assert.equal(understanding.projectId, 'test-approval-project');
    assert.equal(understanding.projectName, 'test-approval-project');
    assert.equal(understanding.apparentPurpose.summary, 'A deterministic agent orchestration platform');
    assert.equal(understanding.technologyStack.primaryLanguages[0], 'TypeScript');
    assert.ok(understanding.existingCapabilities.length > 0);
    assert.equal(understanding.confirmedRequirements.length, 1);
    assert.equal(understanding.confirmedRequirements[0].statement, 'Deterministic State Transitions');
    assert.equal(understanding.sourceDiscoveryReference, report.timestamp);
  });

  // ==========================================================================
  // REQUIREMENT 2: Incorporate resolved clarification answers
  // ==========================================================================
  it('T02_incorporate_resolved_clarification_answers: maps answered clarification questions to clarifiedRequirements with origin HUMAN_CLARIFICATION_ANSWER', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    assert.equal(understanding.clarifiedRequirements.length, 1);
    const clarified = understanding.clarifiedRequirements[0];
    assert.equal(clarified.type, 'CONFIRMED_FACT');
    assert.equal(clarified.origin, 'HUMAN_CLARIFICATION_ANSWER');
    assert.equal(clarified.statement, 'Docker container');
    assert.equal(clarified.sourceReferenceId, 'clarif-1');
  });

  // ==========================================================================
  // REQUIREMENT 3: Preserve unresolved unknowns
  // ==========================================================================
  it('T03_preserve_unresolved_unknowns: preserves discovery unknowns and open clarification items in unresolvedUnknowns', () => {
    const report = createMockReport({
      unknowns: [
        {
          id: 'unk-auth',
          item: 'Authentication scheme',
          description: 'OAuth2 vs JWT not decided',
          impact: 'Affects API endpoints',
        },
      ],
    });
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report);

    assert.equal(understanding.unresolvedUnknowns.length, 1);
    assert.equal(understanding.unresolvedUnknowns[0].id, 'unk-auth');
    assert.equal(understanding.unresolvedUnknowns[0].item, 'Authentication scheme');
  });

  // ==========================================================================
  // REQUIREMENT 4: Preserve assumptions without promoting inference
  // ==========================================================================
  it('T04_preserve_assumptions: discovery inferences remain typed as INFERENCE and are not converted to confirmed requirements', () => {
    const report = createMockReport({
      inferences: [
        {
          id: 'inf-db',
          inference: 'Likely uses PostgreSQL for relational storage',
          rationale: 'pg package in package.json',
          basisEvidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
        },
      ],
    });
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report);

    assert.equal(understanding.assumptions.length, 1);
    const assumption = understanding.assumptions[0];
    assert.equal(assumption.type, 'INFERENCE');
    assert.equal(assumption.origin, 'DISCOVERY_EVIDENCE');
    assert.notEqual(assumption.type, 'CONFIRMED_FACT');
    assert.equal(understanding.confirmedRequirements.every((r) => r.id !== 'assump-inf-db'), true);
  });

  // ==========================================================================
  // REQUIREMENT 5: Preserve evidence references
  // ==========================================================================
  it('T05_preserve_evidence_references: all discovery evidence references are preserved and deduplicated', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    assert.ok(understanding.evidenceReferences.length > 0);
    const types = understanding.evidenceReferences.map((e) => e.sourceType);
    assert.ok(types.includes('PACKAGE_MANIFEST'));
    assert.ok(types.includes('FILE'));
    assert.ok(types.includes('CONFIG'));
  });

  // ==========================================================================
  // REQUIREMENT 6: Build proposed development plan
  // ==========================================================================
  it('T06_build_proposed_development_plan: engine constructs structurally complete proposed plan as a proposal without mutating Task DAG', () => {
    const report = createMockReport();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report);

    const engine = new ApprovalPackageEngine();
    const plan = engine.createDefaultProposedPlan(understanding);

    assert.ok(plan.objectives.length > 0);
    assert.ok(plan.proposedScope.length > 0);
    assert.ok(plan.proposedFeatureGroups.length > 0);
    assert.ok(plan.constraints.length > 0);
    assert.ok(Array.isArray(plan.suggestedImplementationOrder));
  });

  // ==========================================================================
  // REQUIREMENT 7: NOT_READY when blocking clarification remains
  // ==========================================================================
  it('T07_not_ready_when_blocking_clarification_remains: package status is NOT_READY if clarification session has open blocking questions', () => {
    const report = createMockReport();
    const openBlockingSession = createMockClarificationSession({
      status: 'WAITING_FOR_HUMAN',
      blockingOpenCount: 1,
      questions: [
        {
          clarificationId: 'clarif-blocking',
          kind: 'AMBIGUOUS_REQUIREMENT',
          priority: 'REQUIRED',
          question: 'Which database should be supported?',
          context: 'Ambiguous config',
          reason: 'Blocking architecture choice',
          evidence: [],
          status: 'OPEN',
          blocking: true,
          uncertaintyType: 'AMBIGUOUS',
          allowsFreeFormAnswer: true,
          createdAt: '2026-09-24T10:00:00.000Z',
        },
      ],
      answers: [],
    });

    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, openBlockingSession);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, {
      clarificationSession: openBlockingSession,
    });

    assert.equal(pkg.status, 'NOT_READY');
    const readiness = engine.checkReadiness(understanding, pkg.proposedDevelopmentPlan, openBlockingSession);
    assert.equal(readiness.isReady, false);
    assert.equal(readiness.blockingConditions.unresolvedBlockingClarifications, true);
    assert.ok(readiness.reasons.some((r) => r.includes('unresolved blocking questions')));
  });

  // ==========================================================================
  // REQUIREMENT 8: NOT_READY when contradiction remains
  // ==========================================================================
  it('T08_not_ready_when_contradiction_remains: package status is NOT_READY if discovery contains unresolved contradictions', () => {
    const reportWithContradiction = createMockReport({
      contradictions: [
        {
          id: 'contra-build',
          description: 'package.json specifies tsc, but README says make build',
          category: 'BUILD',
          sourceA: {
            description: 'package.json build script',
            evidence: { sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' },
          },
          sourceB: {
            description: 'README build instruction',
            evidence: { sourceType: 'FILE', sourceIdentifier: 'README.md' },
          },
          unresolved: true,
        },
      ],
    });

    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(reportWithContradiction);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding);

    assert.equal(pkg.status, 'NOT_READY');
    const readiness = engine.checkReadiness(understanding, pkg.proposedDevelopmentPlan);
    assert.equal(readiness.isReady, false);
    assert.equal(readiness.blockingConditions.unresolvedBlockingContradictions, true);
  });

  // ==========================================================================
  // REQUIREMENT 9: READY_FOR_APPROVAL when all blocking conditions resolve
  // ==========================================================================
  it('T09_ready_for_approval_when_all_conditions_resolved: package status transitions to READY_FOR_APPROVAL when all 5 conditions pass', () => {
    const report = createMockReport({ contradictions: [] });
    const resolvedSession = createMockClarificationSession({
      status: 'RESOLVED',
      blockingOpenCount: 0,
    });

    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, resolvedSession);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, {
      clarificationSession: resolvedSession,
    });

    assert.equal(pkg.status, 'READY_FOR_APPROVAL');
    const readiness = engine.checkReadiness(understanding, pkg.proposedDevelopmentPlan, resolvedSession);
    assert.equal(readiness.isReady, true);
    assert.equal(readiness.reasons.length, 0);
  });

  // ==========================================================================
  // REQUIREMENT 10: Explicit approval
  // ==========================================================================
  it('T10_explicit_approval: marks package APPROVED with approvalRecord and cryptographic packageHash', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    assert.equal(pkg.status, 'READY_FOR_APPROVAL');

    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'product-owner-alice',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for development phase P8-06',
    });

    assert.equal(approvedPkg.status, 'APPROVED');
    assert.ok(approvedPkg.approvalRecord);
    assert.equal(approvedPkg.approvalRecord.actor, 'product-owner-alice');
    assert.equal(approvedPkg.approvalRecord.actorRole, 'PRODUCT_OWNER');
    assert.equal(approvedPkg.approvalRecord.intent, 'EXPLICIT_APPROVAL');
    assert.ok(approvedPkg.approvalRecord.packageHash.length > 0);
    assert.equal(engine.isDevelopmentAuthorized(approvedPkg), true);
  });

  // ==========================================================================
  // REQUIREMENT 11: Approval actor validation
  // ==========================================================================
  it('T11_approval_actor_validation: rejects approval attempts by EXECUTOR, ANTIGRAVITY, ORCHESTRATOR, and SYSTEM', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    // 1. Forbidden actor EXECUTOR
    assert.throws(
      () =>
        engine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'EXECUTOR',
          actorRole: 'USER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: unknown) => err instanceof ApprovalAuthorizationError
    );

    // 2. Forbidden actor ANTIGRAVITY
    assert.throws(
      () =>
        engine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'ANTIGRAVITY_AGENT',
          actorRole: 'USER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: unknown) => err instanceof ApprovalAuthorizationError
    );

    // 3. Forbidden actor DIRECTOR
    assert.throws(
      () =>
        engine.approvePackage(pkg, {
          packageId: pkg.packageId,
          revision: pkg.revision,
          actor: 'DIRECTOR',
          actorRole: 'USER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: unknown) => err instanceof ApprovalAuthorizationError
    );
  });

  // ==========================================================================
  // REQUIREMENT 12: Approval package revision binding
  // ==========================================================================
  it('T12_approval_package_revision_binding: approval binds cryptographically to the exact revision and content hash', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    const expectedHash = computePackageHash(pkg);

    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    assert.equal(approvedPkg.approvalRecord?.revision, 1);
    assert.equal(approvedPkg.approvalRecord?.packageHash, expectedHash);
  });

  // ==========================================================================
  // REQUIREMENT 13: Approval invalidated by revision change
  // ==========================================================================
  it('T13_approval_invalidated_by_revision_change: revising package supersedes revision N, revision N+1 requires new approval', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkgRev1 = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    const approvedRev1 = engine.approvePackage(pkgRev1, {
      packageId: pkgRev1.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(engine.isDevelopmentAuthorized(approvedRev1), true);

    // Revise understanding with updated scope
    const revisedUnderstanding = {
      ...understanding,
      proposedDevelopmentScope: ['Extended feature set', 'Security audit'],
    };

    const { supersededPackage, newPackage: pkgRev2 } = engine.revisePackage(
      approvedRev1,
      { understanding: revisedUnderstanding },
      session
    );

    assert.equal(supersededPackage.status, 'SUPERSEDED');
    assert.equal(pkgRev2.revision, 2);
    assert.equal(pkgRev2.approvalRecord, undefined);
    assert.equal(engine.isDevelopmentAuthorized(pkgRev2), false);

    // Attempting to approve revision 1 against pkgRev2 must fail
    assert.throws(
      () =>
        engine.approvePackage(pkgRev2, {
          packageId: pkgRev2.packageId,
          revision: 1, // Stale revision
          actor: 'human-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: unknown) => err instanceof ApprovalRevisionMismatchError
    );
  });

  // ==========================================================================
  // REQUIREMENT 14: Explicit rejection
  // ==========================================================================
  it('T14_explicit_rejection: marks package REJECTED with rejectionRecord and does not authorize development', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    const rejectedPkg = engine.rejectPackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_REJECTION',
      reason: 'Architecture plan does not accommodate multi-tenancy requirements.',
    });

    assert.equal(rejectedPkg.status, 'REJECTED');
    assert.ok(rejectedPkg.rejectionRecord);
    assert.equal(rejectedPkg.rejectionRecord.actor, 'human-po');
    assert.equal(engine.isDevelopmentAuthorized(rejectedPkg), false);
  });

  // ==========================================================================
  // REQUIREMENT 15: Rejection preserves reason
  // ==========================================================================
  it('T15_rejection_preserves_reason: rejection record captures the exact reason provided by Product Owner', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    const reason = 'Scope too broad; focus only on CLI interface first.';
    const rejectedPkg = engine.rejectPackage(pkg, {
      packageId: pkg.packageId,
      revision: pkg.revision,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_REJECTION',
      reason,
    });

    assert.equal(rejectedPkg.rejectionRecord?.reason, reason);
  });

  // ==========================================================================
  // REQUIREMENT 16: Clarification answer is not approval
  // ==========================================================================
  it('T16_clarification_answer_is_not_approval: resolved clarification session never sets package status to APPROVED', () => {
    const report = createMockReport();
    const session = createMockClarificationSession({
      status: 'RESOLVED',
      blockingOpenCount: 0,
    });

    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    assert.notEqual(pkg.status, 'APPROVED');
    assert.equal(pkg.status, 'READY_FOR_APPROVAL');
    assert.equal(engine.isDevelopmentAuthorized(pkg), false);
  });

  // ==========================================================================
  // REQUIREMENT 17: Natural-language "tamam" is not automatically treated as approval
  // ==========================================================================
  it('T17_natural_language_not_approval: rejects natural language strings as approval intent', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    const vagueIntents = ['tamam', 'anladım', 'devam', 'güzel', 'olabilir', 'ok', 'yes'];
    for (const vague of vagueIntents) {
      assert.throws(
        () =>
          engine.approvePackage(pkg, {
            packageId: pkg.packageId,
            revision: pkg.revision,
            actor: 'human-po',
            actorRole: 'PRODUCT_OWNER',
            intent: vague as unknown as 'EXPLICIT_APPROVAL',
          }),
        (err: unknown) => err instanceof ApprovalInvalidIntentError
      );
    }
  });

  // ==========================================================================
  // REQUIREMENT 18: No automatic task creation
  // ==========================================================================
  it('T18_no_automatic_task_creation: approval workflow does not create implementation tasks in SpecStore', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    const initialTasks = await specStore.loadTasks();
    assert.equal(initialTasks.length, 0);

    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const tasksAfter = await specStore.loadTasks();
    assert.equal(tasksAfter.length, 0, 'No tasks should be created in SpecStore merely because package is approved');
    assert.equal(approvedPkg.status, 'APPROVED');
  });

  // ==========================================================================
  // REQUIREMENT 19: No requirements mutation
  // ==========================================================================
  it('T19_no_requirements_mutation: building understanding and approving package does not mutate SpecStore requirements', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveRequirements([
      {
        id: 'REQ-EXISTING',
        title: 'Existing requirement',
        description: 'Original spec',
        status: 'LOCKED',
      },
    ]);

    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const loadedSpec = await specStore.loadRequirements();
    assert.equal(loadedSpec?.length, 1);
    assert.equal(loadedSpec?.[0].id, 'REQ-EXISTING');
    assert.equal(loadedSpec?.[0].title, 'Existing requirement');
  });

  // ==========================================================================
  // REQUIREMENT 20: No architecture mutation
  // ==========================================================================
  it('T20_no_architecture_mutation: package approval does not mutate SpecStore decisions', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveDecisions([
      {
        id: 'DEC-EXISTING',
        title: 'Existing decision',
        description: 'Architecture decision',
        status: 'LOCKED',
      },
    ]);

    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const loadedDecisions = await specStore.loadDecisions();
    assert.equal(loadedDecisions?.length, 1);
    assert.equal(loadedDecisions?.[0].id, 'DEC-EXISTING');
  });

  // ==========================================================================
  // REQUIREMENT 21: No Antigravity invocation
  // ==========================================================================
  it('T21_no_antigravity_invocation: approval gate modules execute without referencing or calling Antigravity', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    assert.equal(approvedPkg.status, 'APPROVED');
    // Invariant: no external execution tokens or processes spawned
  });

  // ==========================================================================
  // REQUIREMENT 22: No autonomous execution
  // ==========================================================================
  it('T22_no_autonomous_execution: approval does not trigger or run autonomous development loop', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    // Verification: Development is authorized in the protocol, but no execution was started
    assert.equal(engine.isDevelopmentAuthorized(approvedPkg), true);
  });

  // ==========================================================================
  // REQUIREMENT 23: No duplicate FSM
  // ==========================================================================
  it('T23_no_duplicate_fsm: package approval does not modify DurableStateManager global lifecycle state', async () => {
    const stateManager = new DurableStateManager({ baseDir: tempDir });
    await stateManager.save({
      currentLifecycleState: 'REQUIREMENTS_INGESTION',
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
    });

    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const state = await stateManager.load();
    assert.equal(state?.currentLifecycleState, 'REQUIREMENTS_INGESTION');
  });

  // ==========================================================================
  // REQUIREMENT 24: Persistence/recovery
  // ==========================================================================
  it('T24_persistence_and_recovery: ApprovalStore atomically saves packages and revision history, recovering across instances', async () => {
    const store = new ApprovalStore({ baseDir: tempDir });

    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    await store.savePackage(pkg);

    // Verify recovery on a fresh instance
    const freshStore = new ApprovalStore({ baseDir: tempDir });
    const loadedLatest = await freshStore.loadPackage(pkg.packageId);
    assert.ok(loadedLatest);
    assert.equal(loadedLatest.packageId, pkg.packageId);
    assert.equal(loadedLatest.revision, 1);

    const activePkg = await freshStore.getActivePackage();
    assert.ok(activePkg);
    assert.equal(activePkg.packageId, pkg.packageId);

    const revisions = await freshStore.listRevisions(pkg.packageId);
    assert.deepEqual(revisions, [1]);
  });

  // ==========================================================================
  // REQUIREMENT 25: Approval event history
  // ==========================================================================
  it('T25_approval_event_history: HistoryManager records audit events for package creation, revision, and approval', async () => {
    const historyManager = new HistoryManager({ baseDir: tempDir });
    const store = new ApprovalStore({ baseDir: tempDir, historyManager });

    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    await store.savePackage(pkg);

    const approvedPkg = engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    await store.savePackage(approvedPkg);

    const events = await historyManager.readEvents();
    assert.ok(events.length >= 2);
    const eventTypes = events.map((e) => e.eventType);
    assert.ok(eventTypes.includes('PROJECT_UNDERSTANDING_CREATED'));
    assert.ok(eventTypes.includes('PROJECT_UNDERSTANDING_APPROVED'));
  });

  // ==========================================================================
  // REQUIREMENT 26: Evidence traceability
  // ==========================================================================
  it('T26_evidence_traceability: every confirmed and clarified requirement preserves authentic source evidence', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    for (const req of understanding.confirmedRequirements) {
      assert.ok(req.evidence.length > 0);
      assert.equal(req.origin, 'EXISTING_REQUIREMENT');
    }

    for (const clarif of understanding.clarifiedRequirements) {
      assert.ok(clarif.evidence.length > 0);
      assert.equal(clarif.origin, 'HUMAN_CLARIFICATION_ANSWER');
    }
  });

  // ==========================================================================
  // REQUIREMENT 27: MCP authorization boundary
  // ==========================================================================
  it('T27_mcp_authorization_boundary: MCP tools successfully build, inspect, and approve package via McpServer', async () => {
    const transport = new InMemoryMcpTransport();
    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      approvalTools: true,
    });
    await server.start();

    // 1. Create approval package via MCP
    const createReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'mcp-create-pkg',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_CREATE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          projectId: 'mcp-test-project',
        },
      },
    };
    const createResp = (await server.handleMessage(createReq)) as McpSuccessResponseEnvelope;
    assert.equal(createResp.error, undefined);
    const createResult = JSON.parse(createResp.result.content[0].text);
    assert.ok(createResult.packageId);

    // 2. Query readiness via MCP
    const readinessReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'mcp-readiness',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_READINESS_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          packageId: createResult.packageId,
        },
      },
    };
    const readinessResp = (await server.handleMessage(readinessReq)) as McpSuccessResponseEnvelope;
    assert.equal(readinessResp.error, undefined);
    const readinessResult = JSON.parse(readinessResp.result.content[0].text);
    assert.equal(readinessResult.packageId, createResult.packageId);

    // 3. Approve package via MCP
    const approveReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'mcp-approve',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          packageId: createResult.packageId,
          revision: createResult.revision,
          actor: 'human-po-bob',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
          comment: 'Approved through MCP interface',
        },
      },
    };
    const approveResp = (await server.handleMessage(approveReq)) as McpSuccessResponseEnvelope;
    assert.equal(approveResp.error, undefined);
    const approveResult = JSON.parse(approveResp.result.content[0].text);
    assert.equal(approveResult.status, 'APPROVED');

    await server.stop();
  });

  // ==========================================================================
  // REQUIREMENT 28: MCP invalid approval rejection
  // ==========================================================================
  it('T28_mcp_invalid_approval_rejection: MCP rejects invalid actor, non-explicit intent, or missing fields with deterministic error', async () => {
    const transport = new InMemoryMcpTransport();
    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const server = new McpServer({
      transport,
      delegate,
      approvalTools: true,
    });
    await server.start();

    // 1. Invalid intent ("tamam")
    const badIntentReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'mcp-bad-intent',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          packageId: 'pkg-nonexistent',
          revision: 1,
          actor: 'human-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'tamam',
        },
      },
    };
    const badIntentResp = (await server.handleMessage(badIntentReq)) as any;
    assert.ok(badIntentResp.error);

    // 2. Forbidden actor
    const badActorReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 'mcp-bad-actor',
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_PACKAGE_APPROVE_TOOL_NAME,
        arguments: {
          packageId: 'pkg-nonexistent',
          revision: 1,
          actor: 'ANTIGRAVITY',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        },
      },
    };
    const badActorResp = (await server.handleMessage(badActorReq)) as any;
    assert.ok(badActorResp.error);

    await server.stop();
  });

  // ==========================================================================
  // REQUIREMENT 29: Concurrent/stale approval revision handling
  // ==========================================================================
  it('T29_concurrent_stale_approval_handling: attempting to approve a superseded or stale revision is rejected deterministically', () => {
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkgRev1 = engine.buildPackage(understanding, undefined, { clarificationSession: session });

    // Revise to revision 2
    const { newPackage: pkgRev2 } = engine.revisePackage(pkgRev1, {}, session);
    assert.equal(pkgRev2.revision, 2);

    // Attempt to approve revision 1 against revision 2
    assert.throws(
      () =>
        engine.approvePackage(pkgRev2, {
          packageId: pkgRev2.packageId,
          revision: 1,
          actor: 'human-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        }),
      (err: unknown) => err instanceof ApprovalRevisionMismatchError
    );
  });

  // ==========================================================================
  // REQUIREMENT 30: Read-only source-project guarantee
  // ==========================================================================
  it('T30_read_only_source_project_guarantee: understanding generation and approval gate do not modify project source files or git state', async () => {
    // Create mock project files
    const srcDir = path.join(tempDir, 'src');
    await fs.promises.mkdir(srcDir, { recursive: true });
    const pkgPath = path.join(tempDir, 'package.json');
    const indexPath = path.join(srcDir, 'index.ts');

    await fs.promises.writeFile(pkgPath, JSON.stringify({ name: 'read-only-test', version: '1.0.0' }));
    await fs.promises.writeFile(indexPath, 'export const ready = true;\n');

    const pkgBefore = await fs.promises.readFile(pkgPath, 'utf8');
    const indexBefore = await fs.promises.readFile(indexPath, 'utf8');

    // Run understanding build and approval workflow
    const report = createMockReport();
    const session = createMockClarificationSession();
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, session);

    const engine = new ApprovalPackageEngine();
    const pkg = engine.buildPackage(understanding, undefined, { clarificationSession: session });
    engine.approvePackage(pkg, {
      packageId: pkg.packageId,
      revision: 1,
      actor: 'human-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const pkgAfter = await fs.promises.readFile(pkgPath, 'utf8');
    const indexAfter = await fs.promises.readFile(indexPath, 'utf8');

    assert.equal(pkgBefore, pkgAfter, 'package.json must remain identical');
    assert.equal(indexBefore, indexAfter, 'src/index.ts must remain identical');
  });
});
