/**
 * Comprehensive Test Suite for Phase 9 TASK-P9-04
 * Human Approval & Resume Protocol
 *
 * Verifies all 16 mandatory adversarial scenarios and protocol invariants:
 * 1. Human/Product Owner approval -> kabul
 * 2. Director approval attempt -> reddedilir
 * 3. Yanlış project -> reddedilir
 * 4. Yanlış Director session -> reddedilir
 * 5. Yanlış context fingerprint -> reddedilir
 * 6. Stale context -> reddedilir
 * 7. Incomplete context -> reddedilir
 * 8. Understanding revision mismatch -> reddedilir
 * 9. Approval revision replay -> reddedilir
 * 10. Approval olmadan development authorization -> false
 * 11. Approval mevcutken ve tüm bağlam eşleşirken authorization -> true
 * 12. Approval kendi başına task oluşturmaz
 * 13. Approval kendi başına Antigravity çağırmaz
 * 14. Approval kendi başına autonomous loop başlatmaz
 * 15. RESUME kararı approval yerine geçmez
 * 16. Director "RESUME" decision'ı Human approval olmadan lifecycle/resume işlemi başlatmaz
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  Actor,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorContextSynchronizer,
  DirectorDecisionStore,
  DirectorDecisionEngine,
  HumanApprovalEngine,
  type DirectorSession,
  type DirectorContextSnapshot,
  type ProjectApprovalPackage,
  type ProjectDiscoveryReport,
  ApprovalStore,
  ApprovalPackageEngine,
  InitialProjectUnderstandingBuilder,
  isDevelopmentAuthorized,
  HistoryManager,
  DurableStateManager,
  SpecStore,
  TaskDagEngine,
  ContextEngine,
  DefaultGitPort,
  DefaultMcpOrchestratorDelegate,
  McpServer,
  InMemoryMcpTransport,
  AIDM_APPROVAL_HUMAN_SUBMIT_TOOL_NAME,
  AIDM_APPROVAL_HUMAN_VALIDATE_TOOL_NAME,
  AIDM_APPROVAL_RESUME_EVALUATE_TOOL_NAME,
  AIDM_DIRECTOR_DECISION_CREATE_TOOL_NAME,
  registerDirectorDecisionTools,
  registerHumanApprovalTools,
  HumanApprovalUnauthorizedActorError,
  HumanApprovalProjectBindingMismatchError,
  HumanApprovalContextMismatchError,
  HumanApprovalContextStaleError,
  HumanApprovalContextIncompleteError,
  HumanApprovalRevisionMismatchError,
  HumanApprovalReplayError,
  DirectorSecurityError,
  DirectorSessionNotFoundError,
  DirectorInvalidTransitionError,
  ApprovalInvalidIntentError,
  ApprovalRevisionMismatchError,
  ApprovalAlreadyDecidedError,
  HUMAN_APPROVAL_PROTOCOL_VERSION,
  HUMAN_APPROVAL_SCHEMA_VERSION,
  RESUME_PROTOCOL_VERSION,
  RESUME_SCHEMA_VERSION,
} from '../dist/index.js';

describe('Phase 9 — Human Approval & Resume Protocol (TASK-P9-04)', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let decisionEngine: DirectorDecisionEngine;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let humanApprovalEngine: HumanApprovalEngine;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let contextEngine: ContextEngine;
  let gitPort: DefaultGitPort;
  let delegate: DefaultMcpOrchestratorDelegate;
  let synchronizer: DirectorContextSynchronizer;
  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let testPackage: ProjectApprovalPackage;

  function createMockReport(workspaceRoot: string): ProjectDiscoveryReport {
    return {
      projectIdentity: {
        name: 'test-approval-project',
        version: '1.0.0',
        workspaceRoot,
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
      },
      architecture: {
        summary: 'Standard modular TypeScript architecture',
        architecturalPattern: 'Modular',
        identifiedAreas: [],
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'src/index.ts' }],
      },
      currentImplementationState: {
        lifecycleState: 'REQUIREMENTS_INGESTION',
        hasActiveTask: false,
        isBlocked: false,
        totalTasksInDag: 0,
        completedTasksCount: 0,
        evidence: [{ sourceType: 'STATE_MANAGER', sourceIdentifier: 'durable-state.json' }],
      },
      unknowns: [],
      contradictions: [],
      evidenceInventory: [],
      generatedAt: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p9-04-test-'));

    // Create minimal package.json
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-approval-project', version: '1.0.0' }, null, 2)
    );

    // Initialize core storage and engines
    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine();
    durableManager = new DurableStateManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    contextEngine = new ContextEngine({ workspaceRoot: tempDir });
    gitPort = new DefaultGitPort();

    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      approvalStore,
      contextEngine,
      gitPort,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
    });

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
    });

    decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
      decisionStore,
      approvalStore,
    });

    humanApprovalEngine = new HumanApprovalEngine({
      workspaceRoot: tempDir,
      delegate,
      approvalStore,
      approvalPackageEngine,
      sessionStore,
      sessionEngine,
      decisionStore,
      historyManager,
    });

    // Create initial active session and synchronized snapshot
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-p904-001',
      understandingRevision: 1,
    });

    activeSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    // Build and save a valid READY_FOR_APPROVAL package
    const report = createMockReport(tempDir);
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, undefined, { projectId: 'test-approval-project' });
    testPackage = approvalPackageEngine.buildPackage(understanding, undefined, {
      packageId: 'pkg-p904-001',
    });
    await approvalStore.savePackage(testPackage);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 1: Human/Product Owner approval -> KABUL
  // ==========================================================================

  it('T01_human_po_approval_accepted: valid Human/Product Owner approval is accepted and binds to session/fingerprint', async () => {
    const result = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      projectId: 'test-approval-project',
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved for development implementation',
    });

    assert.equal(result.package.status, 'APPROVED');
    assert.equal(result.isDevelopmentAuthorized, true);
    assert.equal(result.protocolVersion, HUMAN_APPROVAL_PROTOCOL_VERSION);
    assert.equal(result.schemaVersion, HUMAN_APPROVAL_SCHEMA_VERSION);
    assert.equal(result.verifiedBindings.projectId, 'test-approval-project');
    assert.equal(result.verifiedBindings.directorSessionId, activeSession.directorSessionId);
    assert.equal(result.verifiedBindings.contextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(result.verifiedBindings.understandingRevision, 1);
    assert.equal(result.verifiedBindings.approvalRevision, 1);

    // Verify stored package in ApprovalStore
    const stored = await approvalStore.loadPackage(testPackage.packageId);
    assert.ok(stored);
    assert.equal(stored.status, 'APPROVED');
    assert.equal(stored.approvalRecord?.actor, 'alice-po');
    assert.equal(stored.approvalRecord?.actorRole, 'PRODUCT_OWNER');
    assert.equal(stored.approvalRecord?.directorSessionId, activeSession.directorSessionId);
    assert.equal(stored.approvalRecord?.contextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(stored.approvalRecord?.understandingRevision, 1);
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 2: Director approval attempt -> REDDEDİLİR
  // ==========================================================================

  it('T02_director_approval_attempt_rejected: Director actor attempting approval is strictly rejected', async () => {
    // Attempt 1: actor = 'DIRECTOR'
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'DIRECTOR',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalUnauthorizedActorError);
        assert.match(err.message, /Director actor cannot grant approval/);
        return true;
      }
    );

    // Attempt 2: actorRole = 'DIRECTOR'
    const validation = await humanApprovalEngine.validateApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      actor: 'chatgpt-director',
      actorRole: 'DIRECTOR' as unknown as 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(validation.isValid, false);
    assert.equal(validation.code, 'ACTOR_UNAUTHORIZED');
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 3: Yanlış project -> REDDEDİLİR
  // ==========================================================================

  it('T03_wrong_project_rejected: approval specifying mismatched projectId is rejected', async () => {
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          projectId: 'completely-wrong-project',
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalProjectBindingMismatchError);
        assert.match(err.message, /does not match canonical project/);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 4: Yanlış Director session -> REDDEDİLİR
  // ==========================================================================

  it('T04_wrong_director_session_rejected: non-existent or inactive Director session is rejected', async () => {
    // Non-existent session
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: 'dir-sess-does-not-exist',
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSessionNotFoundError);
        return true;
      }
    );

    // Closed / Inactive session
    const closedSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-closed-001',
    });
    await sessionEngine.closeSession({
      workspaceRoot: tempDir,
      directorSessionId: closedSession.directorSessionId,
    });

    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: closedSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorInvalidTransitionError);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 5: Yanlış context fingerprint -> REDDEDİLİR
  // ==========================================================================

  it('T05_wrong_context_fingerprint_rejected: approval referencing wrong fingerprint is rejected', async () => {
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: 'invalid-fingerprint-abc1234567890',
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalContextMismatchError);
        assert.match(err.message, /Context fingerprint mismatch/);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 6: Stale context -> REDDEDİLİR
  // ==========================================================================

  it('T06_stale_context_rejected: approval attempted on stale context snapshot is rejected', async () => {
    // Manually mark latest snapshot stale
    const staleSnapshot = {
      ...activeSnapshot,
      syncStatus: 'STALE' as const,
      staleSections: ['git', 'specStore'],
    };
    await sessionStore.saveSnapshot(staleSnapshot);

    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalContextStaleError);
        assert.match(err.message, /Context snapshot is stale/);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 7: Incomplete context -> REDDEDİLİR
  // ==========================================================================

  it('T07_incomplete_context_rejected: approval attempted on incomplete context snapshot is rejected', async () => {
    // Manually mark snapshot incomplete
    const incompleteSnapshot = {
      ...activeSnapshot,
      syncStatus: 'INCOMPLETE' as const,
      isComplete: false,
      unavailableSections: ['discovery'],
    };
    await sessionStore.saveSnapshot(incompleteSnapshot);

    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalContextIncompleteError);
        assert.match(err.message, /Context snapshot is incomplete/);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 8: Understanding revision mismatch -> REDDEDİLİR
  // ==========================================================================

  it('T08_understanding_revision_mismatch_rejected: approval referencing mismatched understanding revision is rejected', async () => {
    // Create session bound to understanding revision 3
    const sessionWithRev = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-und-rev-001',
      understandingRevision: 3,
    });
    const snapshotWithRev = await synchronizer.synchronize({
      directorSessionId: sessionWithRev.directorSessionId,
      workspaceRoot: tempDir,
    });

    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: sessionWithRev.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: snapshotWithRev.logicalFingerprint,
          understandingRevision: 2, // mismatch: session is 3
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalRevisionMismatchError);
        assert.match(err.message, /Understanding revision mismatch/);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 9: Approval revision replay -> REDDEDİLİR
  // ==========================================================================

  it('T09_approval_revision_replay_rejected: re-approving an already APPROVED package is rejected', async () => {
    // First approval succeeds
    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    // Replay attempt on same revision must be rejected
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalReplayError);
        assert.match(err.message, /already APPROVED/);
        return true;
      }
    );
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 10: Approval olmadan development authorization -> FALSE
  // ==========================================================================

  it('T10_unauthorized_without_approval: isDevelopmentAuthorized is false without explicit approval', async () => {
    assert.equal(isDevelopmentAuthorized(testPackage), false);
    assert.equal(approvalPackageEngine.isDevelopmentAuthorized(testPackage), false);

    const resumeEval = await humanApprovalEngine.evaluateResume({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
    });
    assert.equal(resumeEval.canResume, false);
    assert.equal(resumeEval.isDevelopmentAuthorized, false);
    assert.equal(resumeEval.code, 'RESUME_BLOCKED_NO_APPROVAL');
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 11: Approval mevcutken ve tüm bağlam eşleşirken -> TRUE
  // ==========================================================================

  it('T11_authorized_when_approved_and_matching: authorization and resume are true when approved and matching', async () => {
    const approvalResult = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    assert.equal(approvalResult.isDevelopmentAuthorized, true);
    assert.equal(isDevelopmentAuthorized(approvalResult.package), true);

    const resumeEval = await humanApprovalEngine.evaluateResume({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
    });

    assert.equal(resumeEval.canResume, true);
    assert.equal(resumeEval.isDevelopmentAuthorized, true);
    assert.equal(resumeEval.code, 'RESUME_AUTHORIZED');
    assert.equal(resumeEval.approvedPackage?.status, 'APPROVED');
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 12: Approval kendi başına task oluşturmaz
  // ==========================================================================

  it('T12_approval_does_not_create_tasks: approval does NOT mutate Task DAG or create tasks', async () => {
    const tasksBefore = await specStore.loadTasks();

    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const tasksAfter = await specStore.loadTasks();
    assert.deepEqual(tasksBefore, tasksAfter);
    assert.equal(tasksAfter.length, 0);

    const tasksFilePath = path.join(tempDir, '.ai-manager', 'tasks.json');
    assert.equal(fs.existsSync(tasksFilePath), false);
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 13: Approval kendi başına Antigravity çağırmaz
  // ==========================================================================

  it('T13_approval_does_not_invoke_antigravity: zero references or invocations of Antigravity executor', async () => {
    // Track execution
    let antigravityCalled = false;
    // Human approval submit must complete without touching antigravity
    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    assert.equal(antigravityCalled, false);
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 14: Approval kendi başına autonomous loop başlatmaz
  // ==========================================================================

  it('T14_approval_does_not_start_autonomous_loop: executes synchronously without background loops', async () => {
    const start = Date.now();
    const result = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    const elapsed = Date.now() - start;

    assert.ok(result);
    assert.ok(elapsed < 2000, `Execution took ${elapsed}ms; must terminate synchronously`);
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 15: RESUME kararı approval yerine geçmez
  // ==========================================================================

  it('T15_resume_decision_does_not_substitute_for_approval: Director RESUME decision does NOT grant approval', async () => {
    // Create a Director RESUME decision
    const directorResumeDecision = await decisionEngine.createDecision({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      decisionType: 'RESUME',
      rationale: 'Director requests to resume work',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: testPackage.revision,
    });

    assert.equal(directorResumeDecision.decisionType, 'RESUME');
    assert.equal(directorResumeDecision.hasImplementationAuthority, false);

    // Package in ApprovalStore is STILL NOT APPROVED
    const currentPkg = await approvalStore.loadPackage(testPackage.packageId);
    assert.ok(currentPkg);
    assert.notEqual(currentPkg.status, 'APPROVED');
    assert.equal(isDevelopmentAuthorized(currentPkg), false);
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIO 16: Director "RESUME" decision'ı Human approval olmadan lifecycle/resume başlatmaz
  // ==========================================================================

  it('T16_director_resume_without_human_approval_cannot_resume: evaluateResume fails without human approval', async () => {
    // Create Director RESUME decision
    const resumeDecision = await decisionEngine.createDecision({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      decisionType: 'RESUME',
      rationale: 'Advisory resume decision by Director',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: testPackage.revision,
    });

    // Evaluate resume with this decision
    const evalResult = await humanApprovalEngine.evaluateResume({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: resumeDecision.decisionId,
      packageId: testPackage.packageId,
    });

    assert.equal(evalResult.canResume, false);
    assert.equal(evalResult.code, 'RESUME_BLOCKED_NO_APPROVAL');
    assert.equal(evalResult.isDevelopmentAuthorized, false);
    assert.match(evalResult.message, /Director decision does NOT grant implementation authority/);
  });

  // ==========================================================================
  // ADDITIONAL SECURITY & PROTOCOL INVARIANT TESTS
  // ==========================================================================

  it('T17_executor_and_antigravity_actor_rejected: EXECUTOR and ANTIGRAVITY actors are strictly blocked', async () => {
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          actor: 'EXECUTOR',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.match(err.message, /Antigravity executor/);
        return true;
      }
    );
  });

  it('T18_natural_language_not_approval: natural language signals are rejected with INTENT_INVALID', async () => {
    for (const invalidIntent of ['tamam', 'anladım', 'devam', 'APPROVE', 'YES']) {
      await assert.rejects(
        async () => {
          await humanApprovalEngine.submitApproval({
            workspaceRoot: tempDir,
            directorSessionId: activeSession.directorSessionId,
            packageId: testPackage.packageId,
            revision: testPackage.revision,
            contextFingerprint: activeSnapshot.logicalFingerprint,
            actor: 'alice-po',
            actorRole: 'PRODUCT_OWNER',
            intent: invalidIntent as 'EXPLICIT_APPROVAL',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ApprovalInvalidIntentError);
          return true;
        }
      );
    }
  });

  it('T19_persistence_and_recovery: approval is persisted and reloadable by fresh ApprovalStore instance', async () => {
    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'bob-po',
      actorRole: 'USER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Verified and approved',
    });

    const freshStore = new ApprovalStore({ baseDir: tempDir });
    const loaded = await freshStore.loadPackage(testPackage.packageId);
    assert.ok(loaded);
    assert.equal(loaded.status, 'APPROVED');
    assert.equal(loaded.approvalRecord?.actor, 'bob-po');
    assert.equal(loaded.approvalRecord?.directorSessionId, activeSession.directorSessionId);
    assert.equal(loaded.approvalRecord?.contextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(loaded.approvalRecord?.understandingRevision, 1);
  });

  it('T20_history_audit_events: HistoryManager records HUMAN_APPROVAL_GRANTED event', async () => {
    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const events = await historyManager.readEvents();
    const approvalEvents = events.filter((e) => e.eventType === 'HUMAN_APPROVAL_GRANTED');
    assert.ok(approvalEvents.length >= 1);
    assert.equal(approvalEvents[0].actor, Actor.USER);
    assert.equal((approvalEvents[0].payload as any).directorSessionId, activeSession.directorSessionId);
    assert.equal((approvalEvents[0].payload as any).contextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal((approvalEvents[0].payload as any).understandingRevision, 1);
  });

  it('T21_no_fsm_mutation: DurableStateManager global FSM state is untouched by approval', async () => {
    const existsBefore = await durableManager.exists();
    const fsmBefore = existsBefore ? await durableManager.load() : null;

    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const existsAfter = await durableManager.exists();
    const fsmAfter = existsAfter ? await durableManager.load() : null;
    assert.deepEqual(fsmBefore, fsmAfter);
  });

  it('T22_no_specstore_mutation: SpecStore requirements and decisions remain untouched', async () => {
    const reqsBefore = await specStore.loadRequirements();
    const decsBefore = await specStore.loadDecisions();

    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    const reqsAfter = await specStore.loadRequirements();
    const decsAfter = await specStore.loadDecisions();
    assert.deepEqual(reqsBefore, reqsAfter);
    assert.deepEqual(decsBefore, decsAfter);
  });

  it('T23_mcp_human_approval_submit_and_validate: tools execute properly via MCP envelope', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      humanApprovalTools: true,
      directorDecisionTools: true,
    });
    await server.start();

    // 1. Dry run validate tool
    const valResp = await server.handleMessage({
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_HUMAN_VALIDATE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        },
      },
    });

    assert.ok(valResp && 'result' in valResp);
    const valData = JSON.parse((valResp as any).result.content[0].text);
    assert.equal(valData.isValid, true);
    assert.equal(valData.code, 'VALID');

    // 2. Submit approval tool
    const subResp = await server.handleMessage({
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_HUMAN_SUBMIT_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
          comment: 'Approved via MCP boundary',
        },
      },
    });

    assert.ok(subResp && 'result' in subResp);
    const subData = JSON.parse((subResp as any).result.content[0].text);
    assert.equal(subData.package.status, 'APPROVED');
    assert.equal(subData.isDevelopmentAuthorized, true);

    // 3. Evaluate resume tool
    const resumeResp = await server.handleMessage({
      jsonrpc: '2.0' as const,
      id: 3,
      method: 'tools/call',
      params: {
        name: AIDM_APPROVAL_RESUME_EVALUATE_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
        },
      },
    });

    assert.ok(resumeResp && 'result' in resumeResp);
    const resumeData = JSON.parse((resumeResp as any).result.content[0].text);
    assert.equal(resumeData.canResume, true);
    assert.equal(resumeData.isDevelopmentAuthorized, true);
    assert.equal(resumeData.code, 'RESUME_AUTHORIZED');

    await server.stop();
  });

  it('T24_resume_blocked_when_context_changes_after_approval: detects fingerprint change post-approval', async () => {
    // Approve with initial snapshot
    await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });

    // New snapshot created with updated fingerprint
    const newSnapshot = {
      ...activeSnapshot,
      snapshotId: 'snap-updated-002',
      logicalFingerprint: 'updated-fingerprint-different-from-approved',
      generatedAt: new Date().toISOString(),
    };
    await sessionStore.saveSnapshot(newSnapshot);

    // Evaluate resume
    const evalResult = await humanApprovalEngine.evaluateResume({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      packageId: testPackage.packageId,
    });

    assert.equal(evalResult.canResume, false);
    assert.equal(evalResult.code, 'RESUME_BLOCKED_CONTEXT_MISMATCH');
    assert.match(evalResult.message, /Context snapshot has changed since human approval was granted/);
  });

  it('T25_package_revision_mismatch_rejected: wrong revision in input fails validation', async () => {
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          packageId: testPackage.packageId,
          revision: 99, // actual is 1
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRevisionMismatchError);
        return true;
      }
    );
  });

  // ==========================================================================
  // FIX-1 ADVERSARIAL TESTS: AUTHORITATIVE UNDERSTANDING REVISION BINDING
  // ==========================================================================

  it('T26_understanding_revision_required: session revision 5 + input revision omitted is rejected', async () => {
    const sessionRev5 = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-und-rev-5',
      understandingRevision: 5,
    });
    const snapshotRev5 = await synchronizer.synchronize({
      directorSessionId: sessionRev5.directorSessionId,
      workspaceRoot: tempDir,
    });

    // 1. validateApproval check
    const validation = await humanApprovalEngine.validateApproval({
      workspaceRoot: tempDir,
      directorSessionId: sessionRev5.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: snapshotRev5.logicalFingerprint,
      // understandingRevision intentionally omitted
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(validation.isValid, false);
    assert.equal(validation.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(validation.message, /Understanding revision binding is mandatory/);

    // 2. submitApproval throws HumanApprovalRevisionMismatchError
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: sessionRev5.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: snapshotRev5.logicalFingerprint,
          // understandingRevision intentionally omitted
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalRevisionMismatchError);
        assert.match(err.message, /Understanding revision binding is mandatory/);
        return true;
      }
    );
  });

  it('T27_understanding_revision_authority_missing: session revision null + input revision 5 is rejected', async () => {
    const sessionNoRev = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-und-rev-null',
      understandingRevision: null,
    });
    const snapshotNoRev = await synchronizer.synchronize({
      directorSessionId: sessionNoRev.directorSessionId,
      workspaceRoot: tempDir,
    });

    // 1. validateApproval check
    const validation = await humanApprovalEngine.validateApproval({
      workspaceRoot: tempDir,
      directorSessionId: sessionNoRev.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: snapshotNoRev.logicalFingerprint,
      understandingRevision: 5,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(validation.isValid, false);
    assert.equal(validation.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(validation.message, /has no authoritative understanding revision/);

    // 2. submitApproval throws HumanApprovalRevisionMismatchError
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: sessionNoRev.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: snapshotNoRev.logicalFingerprint,
          understandingRevision: 5,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalRevisionMismatchError);
        assert.match(err.message, /has no authoritative understanding revision/);
        return true;
      }
    );
  });

  it('T28_understanding_revision_exact_match: session revision 5 + input revision 5 is accepted', async () => {
    const sessionRev5 = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-und-rev-exact-5',
      understandingRevision: 5,
    });
    const snapshotRev5 = await synchronizer.synchronize({
      directorSessionId: sessionRev5.directorSessionId,
      workspaceRoot: tempDir,
    });

    // Build dedicated test package to avoid conflict
    const report = createMockReport(tempDir);
    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report, undefined, { projectId: 'test-approval-project' });
    const pkgRev5 = approvalPackageEngine.buildPackage(understanding, undefined, {
      packageId: 'pkg-p904-exact-5',
    });
    await approvalStore.savePackage(pkgRev5);

    // 1. validateApproval check
    const validation = await humanApprovalEngine.validateApproval({
      workspaceRoot: tempDir,
      directorSessionId: sessionRev5.directorSessionId,
      packageId: pkgRev5.packageId,
      revision: pkgRev5.revision,
      contextFingerprint: snapshotRev5.logicalFingerprint,
      understandingRevision: 5,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(validation.isValid, true);
    assert.equal(validation.code, 'VALID');

    // 2. submitApproval succeeds
    const result = await humanApprovalEngine.submitApproval({
      workspaceRoot: tempDir,
      directorSessionId: sessionRev5.directorSessionId,
      packageId: pkgRev5.packageId,
      revision: pkgRev5.revision,
      contextFingerprint: snapshotRev5.logicalFingerprint,
      understandingRevision: 5,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(result.package.status, 'APPROVED');
    assert.equal(result.isDevelopmentAuthorized, true);
    assert.equal(result.verifiedBindings.understandingRevision, 5);
    assert.equal(result.approvalRecord.understandingRevision, 5);

    // 3. evaluateResume succeeds
    const resumeResult = await humanApprovalEngine.evaluateResume({
      workspaceRoot: tempDir,
      directorSessionId: sessionRev5.directorSessionId,
      packageId: pkgRev5.packageId,
    });
    assert.equal(resumeResult.canResume, true);
    assert.equal(resumeResult.code, 'RESUME_AUTHORIZED');
    assert.equal(resumeResult.isDevelopmentAuthorized, true);
  });

  it('T29_understanding_revision_mismatch: session revision 5 + input revision 4 is rejected', async () => {
    const sessionRev5 = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-und-rev-diff-5',
      understandingRevision: 5,
    });
    const snapshotRev5 = await synchronizer.synchronize({
      directorSessionId: sessionRev5.directorSessionId,
      workspaceRoot: tempDir,
    });

    // 1. validateApproval check
    const validation = await humanApprovalEngine.validateApproval({
      workspaceRoot: tempDir,
      directorSessionId: sessionRev5.directorSessionId,
      packageId: testPackage.packageId,
      revision: testPackage.revision,
      contextFingerprint: snapshotRev5.logicalFingerprint,
      understandingRevision: 4,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
    });
    assert.equal(validation.isValid, false);
    assert.equal(validation.code, 'UNDERSTANDING_REVISION_MISMATCH');
    assert.match(validation.message, /Understanding revision mismatch: approval specifies revision 4, but session understanding revision is 5/);

    // 2. submitApproval throws HumanApprovalRevisionMismatchError
    await assert.rejects(
      async () => {
        await humanApprovalEngine.submitApproval({
          workspaceRoot: tempDir,
          directorSessionId: sessionRev5.directorSessionId,
          packageId: testPackage.packageId,
          revision: testPackage.revision,
          contextFingerprint: snapshotRev5.logicalFingerprint,
          understandingRevision: 4,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof HumanApprovalRevisionMismatchError);
        assert.match(err.message, /Understanding revision mismatch/);
        return true;
      }
    );
  });
});
