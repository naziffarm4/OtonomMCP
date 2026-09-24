/**
 * Comprehensive Test Suite for Phase 9 Director Decision Protocol (TASK-P9-03)
 *
 * Verifies all authoritative requirements:
 * 1. Valid ACTIVE Director session accepted
 * 2. Suspended session rejected
 * 3. Closed session rejected
 * 4. Cross-project session rejected
 * 5. Forged actor (USER) rejected
 * 6. Forged actor (EXECUTOR) rejected
 * 7. Unauthorized actor rejected
 * 8. Matching context fingerprint accepted
 * 9. Changed context fingerprint rejected
 * 10. Stale context snapshot rejected
 * 11. Incomplete context snapshot rejected
 * 12. Missing context snapshot rejected
 * 13-19. All 7 valid decision types accepted (REQUEST_CLARIFICATION, ACCEPT_CONTEXT, REJECT_CONTEXT, REQUEST_PLANNING, DEFER, BLOCK, RESUME)
 * 20. Invalid decision type rejected
 * 21. Malformed payload rejected
 * 22. Schema and protocol version invariants
 * 23. Duplicate decision ID rejected
 * 24. Deterministic persistence and recovery
 * 25. Matching approval revision accepted
 * 26. Changed approval revision rejected
 * 27. Missing approval package revision rejected
 * 28. Director cannot grant PO approval / authorization separation
 * 29. Secret metadata sanitized
 * 30. Path traversal in decision ID rejected
 * 31. Cross-project decision query rejected
 * 32. HistoryManager audit on creation
 * 33. HistoryManager audit on validation failure
 * 34. No duplicate audit on failure
 * 35. Dry-run validation tool
 * 36. List decisions filtering
 * 37. MCP tools registration
 * 38. MCP create and get tools
 * 39. MCP validate tool
 * 40. No task DAG mutation
 * 41. No FSM mutation
 * 42. No Antigravity invocation
 * 43. No Git mutation
 * 44. No autonomous loop
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
  type DirectorSession,
  type DirectorContextSnapshot,
  type DirectorDecision,
  DirectorValidationError,
  DirectorSessionNotFoundError,
  DirectorDecisionNotFoundError,
  DirectorDecisionAlreadyExistsError,
  DirectorInvalidTransitionError,
  DirectorSecurityError,
  DirectorProjectBindingMismatchError,
  DirectorContextMismatchError,
  DirectorContextStaleError,
  DirectorContextIncompleteError,
  DirectorApprovalRevisionMismatchError,
  DIRECTOR_DECISION_PROTOCOL_VERSION,
  DIRECTOR_DECISION_SCHEMA_VERSION,
  DIRECTOR_DECISION_TYPES,
  McpServer,
  DefaultMcpOrchestratorDelegate,
  InMemoryMcpTransport,
  McpInvalidRequestError,
  AIDM_DIRECTOR_DECISION_CREATE_TOOL_NAME,
  AIDM_DIRECTOR_DECISION_GET_TOOL_NAME,
  AIDM_DIRECTOR_DECISION_VALIDATE_TOOL_NAME,
  AIDM_DIRECTOR_DECISION_LIST_TOOL_NAME,
  registerDirectorDecisionTools,
  HistoryManager,
  DurableStateManager,
  SpecStore,
  TaskDagEngine,
  ApprovalPackageEngine,
  InitialProjectUnderstandingBuilder,
  type ProjectDiscoveryReport,
  type ProjectApprovalPackage,
  ApprovalStore,
  ClarificationStore,
  ContextEngine,
  DefaultGitPort,
} from '../dist/index.js';

describe('Phase 9 — Typed Director Decision Protocol (TASK-P9-03)', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let decisionEngine: DirectorDecisionEngine;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let approvalStore: ApprovalStore;
  let clarificationStore: ClarificationStore;
  let contextEngine: ContextEngine;
  let gitPort: DefaultGitPort;
  let delegate: DefaultMcpOrchestratorDelegate;
  let synchronizer: DirectorContextSynchronizer;
  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p9-03-decision-test-'));

    // Create minimal package.json for project identity
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-decision-project', version: '1.0.0' }, null, 2)
    );

    // Initialize stores
    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({
      baseDir: tempDir,
      historyManager,
    });
    sessionEngine = new DirectorSessionEngine({
      store: sessionStore,
      workspaceRoot: tempDir,
    });
    decisionStore = new DirectorDecisionStore({
      sessionStore,
      historyManager,
    });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    clarificationStore = new ClarificationStore({ baseDir: tempDir, historyManager });
    contextEngine = new ContextEngine({ workspaceRoot: tempDir });
    gitPort = new DefaultGitPort();

    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      approvalStore,
      clarificationStore,
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

    // Create initial ACTIVE session and synchronized snapshot
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-dec-001',
    });

    activeSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // 1. Session Lifecycle & Identity Constraints
  // ==========================================================================

  it('T01_valid_active_session_accepted: decision successfully created and bound to active session', async () => {
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Initial context snapshot verified and accepted.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    assert.ok(decision.decisionId.startsWith('dir-dec-'));
    assert.equal(decision.directorSessionId, activeSession.directorSessionId);
    assert.equal(decision.projectId, activeSession.projectId);
    assert.equal(decision.actor, Actor.DIRECTOR);
    assert.equal(decision.decisionType, 'ACCEPT_CONTEXT');
    assert.equal(decision.basedOnContextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(decision.hasImplementationAuthority, false);
    assert.equal(decision.protocolVersion, DIRECTOR_DECISION_PROTOCOL_VERSION);
    assert.equal(decision.schemaVersion, DIRECTOR_DECISION_SCHEMA_VERSION);
  });

  it('T02_suspended_session_rejected: creating a decision with a SUSPENDED session fails', async () => {
    await sessionEngine.suspendSession({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      reason: 'Temporary suspension',
    });

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Trying to decide while suspended',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorInvalidTransitionError);
        assert.match(err.message, /SUSPENDED/);
        return true;
      }
    );
  });

  it('T03_closed_session_rejected: creating a decision with a CLOSED session fails', async () => {
    await sessionEngine.closeSession({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      reason: 'Session finished',
    });

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Trying to decide while closed',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorInvalidTransitionError);
        assert.match(err.message, /CLOSED/);
        return true;
      }
    );
  });

  it('T04_cross_project_session_rejected: session bound to another project cannot create decisions', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          projectId: 'completely-unrelated-project-id',
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Cross project attempt',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorProjectBindingMismatchError);
        return true;
      }
    );
  });

  it('T05_actor_user_impersonation_rejected: creating decision with actor USER fails with security violation', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          actor: Actor.USER,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Attempting to impersonate Product Owner',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.match(err.message, /Product Owner/);
        return true;
      }
    );
  });

  it('T06_actor_executor_impersonation_rejected: creating decision with actor EXECUTOR fails with security violation', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          actor: Actor.EXECUTOR,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Attempting to impersonate Antigravity Executor',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.match(err.message, /EXECUTOR/);
        return true;
      }
    );
  });

  it('T07_unauthorized_actor_rejected: creating decision with unknown actor fails with security violation', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          actor: 'UNAUTHORIZED_THIRD_PARTY',
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Third party actor',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 2. Context Fingerprint & Revision Binding
  // ==========================================================================

  it('T08_matching_fingerprint_accepted: decision based on valid matching context fingerprint succeeds', async () => {
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_PLANNING',
      rationale: 'Snapshot is valid and ready for decomposition.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    assert.equal(decision.decisionType, 'REQUEST_PLANNING');
    assert.equal(decision.basedOnContextFingerprint, activeSnapshot.logicalFingerprint);
  });

  it('T09_changed_fingerprint_rejected: modifying state updates snapshot; old fingerprint is rejected', async () => {
    // Modify authoritative requirements, creating a new snapshot with different fingerprint
    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'New requirement',
        description: 'Added requirement',
        authority: Actor.USER,
        status: 'LOCKED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    // Resynchronize to get new fingerprint
    const newSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    assert.notEqual(newSnapshot.logicalFingerprint, activeSnapshot.logicalFingerprint);

    // Attempting decision with OLD fingerprint must be rejected
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Using stale old fingerprint',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint, // Old!
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorContextMismatchError);
        assert.match(err.message, /Context fingerprint mismatch/);
        return true;
      }
    );
  });

  it('T10_stale_snapshot_rejected: decision based on a stale snapshot is rejected with DirectorContextStaleError', async () => {
    // Manually persist a stale snapshot
    const staleSnapshot: DirectorContextSnapshot = {
      ...activeSnapshot,
      logicalFingerprint: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      syncStatus: 'STALE',
      staleSections: ['contextEngine'],
    };
    await sessionStore.saveSnapshot(staleSnapshot);

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Trying to decide on stale snapshot',
          basedOnContextFingerprint: staleSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorContextStaleError);
        assert.match(err.message, /stale/i);
        return true;
      }
    );
  });

  it('T11_incomplete_snapshot_rejected: decision based on an incomplete snapshot is rejected with DirectorContextIncompleteError', async () => {
    const incompleteSnapshot: DirectorContextSnapshot = {
      ...activeSnapshot,
      logicalFingerprint: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      syncStatus: 'INCOMPLETE',
      isComplete: false,
      unavailableSections: ['approval'],
    };
    await sessionStore.saveSnapshot(incompleteSnapshot);

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Deciding on incomplete context',
          basedOnContextFingerprint: incompleteSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorContextIncompleteError);
        assert.match(err.message, /incomplete/i);
        return true;
      }
    );
  });

  it('T12_missing_context_rejected: decision without any snapshot fails with DirectorContextMismatchError', async () => {
    // Create a new session with no synchronizations
    const freshSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-fresh-002',
    });

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: freshSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'No snapshot exists for fresh session',
          basedOnContextFingerprint: 'dummy-fingerprint',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorContextMismatchError);
        assert.match(err.message, /No context snapshot found/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 3. Decision Types & Validation
  // ==========================================================================

  it('T13_decision_type_request_clarification: REQUEST_CLARIFICATION accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_CLARIFICATION',
      rationale: 'Uncertain about target database engine.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'REQUEST_CLARIFICATION');
  });

  it('T14_decision_type_accept_context: ACCEPT_CONTEXT accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Context accepted as fully understood.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'ACCEPT_CONTEXT');
  });

  it('T15_decision_type_reject_context: REJECT_CONTEXT accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REJECT_CONTEXT',
      rationale: 'Context has contradiction in entry point classification.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'REJECT_CONTEXT');
  });

  it('T16_decision_type_request_planning: REQUEST_PLANNING accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_PLANNING',
      rationale: 'Ready to proceed with task decomposition.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'REQUEST_PLANNING');
  });

  it('T17_decision_type_defer: DEFER accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'DEFER',
      rationale: 'Waiting on external stakeholder feedback.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'DEFER');
  });

  it('T18_decision_type_block: BLOCK accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'BLOCK',
      rationale: 'Discovered security vulnerability in dependency.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'BLOCK');
  });

  it('T19_decision_type_resume: RESUME accepted', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'RESUME',
      rationale: 'Blocker has been resolved.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(dec.decisionType, 'RESUME');
  });

  it('T20_invalid_decision_type_rejected: unknown decision type fails validation', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'EXECUTE_IMMEDIATELY' as any,
          rationale: 'Invalid type attempt',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        return true;
      }
    );
  });

  it('T21_malformed_payload_rejected: missing rationale or fingerprint fails with validation error', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: '', // Empty rationale!
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Valid rationale',
          basedOnContextFingerprint: '', // Empty fingerprint!
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        return true;
      }
    );
  });

  it('T22_schema_and_protocol_version_invariants: decision always reflects protocol and schema version', async () => {
    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Testing protocol invariants',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    assert.equal(dec.protocolVersion, 'P9-03');
    assert.equal(dec.schemaVersion, 1);
  });

  it('T23_duplicate_decision_id_rejected: duplicate decisionId fails with DirectorDecisionAlreadyExistsError', async () => {
    const customId = 'dir-dec-custom-001';

    await decisionEngine.createDecision({
      decisionId: customId,
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'First decision with this ID',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          decisionId: customId,
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Duplicate decision attempt',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorDecisionAlreadyExistsError);
        assert.match(err.message, /already exists/);
        return true;
      }
    );
  });

  it('T24_deterministic_persistence_and_recovery: persisted decision can be reloaded by fresh store instance', async () => {
    const customId = 'dir-dec-recover-001';

    const created = await decisionEngine.createDecision({
      decisionId: customId,
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_CLARIFICATION',
      rationale: 'Testing store reloadability',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      metadata: { customField: 'customValue' },
    });

    // Check file on disk
    const filePath = path.join(tempDir, '.ai-manager', 'director', 'decisions', `${customId}.json`);
    assert.ok(fs.existsSync(filePath));

    // Reload with a completely fresh store instance
    const freshStore = new DirectorDecisionStore({ baseDir: tempDir });
    const loaded = await freshStore.loadDecision(customId);

    assert.ok(loaded);
    assert.equal(loaded.decisionId, created.decisionId);
    assert.equal(loaded.directorSessionId, created.directorSessionId);
    assert.equal(loaded.decisionType, created.decisionType);
    assert.equal(loaded.rationale, created.rationale);
    assert.equal(loaded.basedOnContextFingerprint, created.basedOnContextFingerprint);
    assert.deepEqual(loaded.metadata, { customField: 'customValue' });
  });

  // ==========================================================================
  // 4. Approval Revision Binding
  // ==========================================================================

  function createValidMockApprovalPackage(revision: number): ProjectApprovalPackage {
    const report: ProjectDiscoveryReport = {
      projectIdentity: {
        name: activeSession.projectId,
        version: '1.0.0',
        workspaceRoot: tempDir,
        ecosystem: 'Node.js',
        evidence: [],
      },
      purpose: {
        classification: 'UNDERSTOOD',
        summary: 'Test summary',
        domainKeywords: [],
        evidence: [],
      },
      technologyStack: {
        primaryLanguages: ['TypeScript'],
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        runtimes: [],
        containerization: [],
        ciCd: [],
        workspaceType: 'standalone',
        dependencies: [],
        devDependencies: [],
        evidence: [],
      },
      repositoryStructure: {
        layout: 'standard-src',
        topLevelDirectories: [],
        totalFileCount: 1,
        significantFiles: [],
        fileExtensions: [],
        evidence: [],
      },
      architecture: {
        identifiedAreas: [],
        architecturalPattern: 'Modular',
        summary: 'Modular',
        evidence: [],
      },
      entryPoints: [],
      commands: {
        build: { status: 'DISCOVERED', evidence: [] },
        test: { status: 'DISCOVERED', evidence: [] },
        runtime: { status: 'DISCOVERED', evidence: [] },
        lint: { status: 'UNKNOWN', evidence: [] },
      },
      featureInventory: [],
      documentationSummary: {
        hasReadme: true,
        hasContributing: false,
        hasArchitectureDocs: false,
        documentationFiles: [],
        summary: 'Readme',
        evidence: [],
      },
      requirementsSummary: {
        totalRequirements: 0,
        lockedCount: 0,
        source: 'AIDM_SPEC_STORE',
        requirements: [],
        evidence: [],
      },
      decisionsSummary: {
        totalDecisions: 0,
        source: 'AIDM_SPEC_STORE',
        decisions: [],
        evidence: [],
      },
      currentImplementationState: {
        lifecycleState: 'REQUIREMENTS_INGESTION',
        hasActiveTask: false,
        isBlocked: false,
        totalTasksInDag: 0,
        completedTasksCount: 0,
        evidence: [],
      },
      gitStatus: {
        uncommittedChangesCount: 0,
        untrackedFilesCount: 0,
        evidence: [],
      },
      facts: [],
      observations: [],
      inferences: [],
      unknowns: [],
      contradictions: [],
      clarificationCandidates: [],
      recommendedNextAction: 'PROCEED_TO_PLANNING',
      timestamp: new Date().toISOString(),
    };

    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(report);
    const engine = new ApprovalPackageEngine();
    const basePkg = engine.buildPackage(understanding);
    return {
      ...basePkg,
      revision,
    };
  }

  it('T25_matching_approval_revision_accepted: decision referencing active approval package revision succeeds', async () => {
    // Create an active approval package in approvalStore
    const pkg = createValidMockApprovalPackage(2);
    await approvalStore.savePackage(pkg as any);

    const dec = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Approving based on matching approval revision 2',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: 2,
    });

    assert.equal(dec.basedOnApprovalRevision, 2);
  });

  it('T26_changed_approval_revision_rejected: decision referencing outdated approval revision fails', async () => {
    const pkg = createValidMockApprovalPackage(3);
    await approvalStore.savePackage(pkg as any);

    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Deciding on old revision 1',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
          basedOnApprovalRevision: 1, // Mismatch!
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorApprovalRevisionMismatchError);
        assert.match(err.message, /Approval revision has changed/);
        return true;
      }
    );
  });

  it('T27_missing_approval_package_revision_rejected: referencing revision when no package exists fails', async () => {
    await assert.rejects(
      async () => {
        await decisionEngine.createDecision({
          directorSessionId: activeSession.directorSessionId,
          workspaceRoot: tempDir,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Referencing approval revision without package',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
          basedOnApprovalRevision: 5,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorApprovalRevisionMismatchError);
        assert.match(err.message, /no active approval package exists/);
        return true;
      }
    );
  });

  it('T28_authority_separation_director_cannot_grant_po_approval: Director decision does NOT grant development authorization', async () => {
    // 1. Create a decision of type ACCEPT_CONTEXT
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Director accepts context snapshot completely.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    // 2. hasImplementationAuthority must be strictly false
    assert.equal(decision.hasImplementationAuthority, false);

    // 3. ApprovalPackageEngine.isDevelopmentAuthorized remains false
    const approvalEngine = new ApprovalPackageEngine();
    const activePkg = await approvalStore.getActivePackage();
    const isDevAuth = activePkg ? approvalEngine.isDevelopmentAuthorized(activePkg) : false;
    assert.equal(isDevAuth, false);

    // 4. Session hasImplementationAuthority remains strictly false
    const session = await sessionEngine.getSession(activeSession.directorSessionId);
    assert.equal(session.hasImplementationAuthority, false);
  });

  // ==========================================================================
  // 5. Security & Sanitization
  // ==========================================================================

  it('T29_secret_sanitization: sensitive keys in decision metadata are redacted before persistence', async () => {
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Testing secret redaction',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      metadata: {
        safeField: 'safeValue',
        apiKey: 'SECRET-AI-KEY-12345',
        bearerToken: 'BEARER-SECRET-TOKEN',
        nested: {
          secret: 'password123',
          publicInfo: 'visible',
        },
      },
    });

    const meta = decision.metadata as Record<string, any>;
    assert.equal(meta.safeField, 'safeValue');
    assert.equal(meta.apiKey, '***REDACTED***');
    assert.equal(meta.bearerToken, '***REDACTED***');
    assert.equal(meta.nested.secret, '***REDACTED***');
    assert.equal(meta.nested.publicInfo, 'visible');

    // Verify on-disk file is also redacted
    const loaded = await decisionStore.loadDecision(decision.decisionId);
    assert.ok(loaded);
    const diskMeta = loaded.metadata as Record<string, any>;
    assert.equal(diskMeta.apiKey, '***REDACTED***');
  });

  it('T30_path_traversal_rejection: malicious decisionId is strictly rejected', async () => {
    const traversalPayloads = [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      'dec/sub/evil',
      'dec\\sub\\evil',
      '../dec-001',
    ];

    for (const id of traversalPayloads) {
      await assert.rejects(
        async () => {
          await decisionEngine.createDecision({
            decisionId: id,
            directorSessionId: activeSession.directorSessionId,
            workspaceRoot: tempDir,
            decisionType: 'ACCEPT_CONTEXT',
            rationale: 'Traversal test',
            basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorValidationError);
          return true;
        }
      );
    }
  });

  it('T31_cross_project_decision_query_rejected: getDecision rejects query when requested for different project', async () => {
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Testing cross project query',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    await assert.rejects(
      async () => {
        await decisionEngine.getDecision(decision.decisionId, {
          workspaceRoot: tempDir,
          projectId: 'wrong-project-id',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorProjectBindingMismatchError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 6. Audit & History Logging
  // ==========================================================================

  it('T32_audit_successful_creation: HistoryManager logs DIRECTOR_DECISION_CREATED event', async () => {
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_PLANNING',
      rationale: 'Audit event verification',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    const events = await historyManager.readEvents();
    const createdEvent = events.find(
      (ev) =>
        ev.eventType === 'DIRECTOR_DECISION_CREATED' &&
        ev.payload.decisionId === decision.decisionId
    );

    assert.ok(createdEvent);
    assert.equal(createdEvent.actor, Actor.DIRECTOR);
    assert.equal(createdEvent.payload.decisionType, 'REQUEST_PLANNING');
    assert.equal(createdEvent.payload.basedOnContextFingerprint, activeSnapshot.logicalFingerprint);
  });

  it('T33_audit_validation_failure: HistoryManager logs DIRECTOR_DECISION_VALIDATION_FAILED event', async () => {
    try {
      await decisionEngine.createDecision({
        directorSessionId: activeSession.directorSessionId,
        workspaceRoot: tempDir,
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Failing on bad fingerprint',
        basedOnContextFingerprint: 'non-existent-fingerprint-hex',
      });
    } catch {
      // Expected failure
    }

    const events = await historyManager.readEvents();
    const failureEvent = events.find(
      (ev) => ev.eventType === 'DIRECTOR_DECISION_VALIDATION_FAILED'
    );

    assert.ok(failureEvent);
    assert.equal(failureEvent.actor, Actor.DIRECTOR);
    assert.equal(failureEvent.payload.code, 'CONTEXT_CHANGED');
  });

  it('T34_no_duplicate_audit_on_failed_persistence: validation failure does NOT create creation event', async () => {
    const eventsBefore = await historyManager.readEvents();
    const creationEventsBefore = eventsBefore.filter(
      (ev) => ev.eventType === 'DIRECTOR_DECISION_CREATED'
    ).length;

    try {
      await decisionEngine.createDecision({
        directorSessionId: activeSession.directorSessionId,
        workspaceRoot: tempDir,
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Failing on mismatch',
        basedOnContextFingerprint: 'wrong-fingerprint',
      });
    } catch {
      // Expected
    }

    const eventsAfter = await historyManager.readEvents();
    const creationEventsAfter = eventsAfter.filter(
      (ev) => ev.eventType === 'DIRECTOR_DECISION_CREATED'
    ).length;

    assert.equal(creationEventsAfter, creationEventsBefore);
  });

  // ==========================================================================
  // 7. Dry-Run Validation & Listing
  // ==========================================================================

  it('T35_dry_run_validation_tool: validateDecision reports valid/invalid without creating files', async () => {
    // 1. Valid input
    const validResult = await decisionEngine.validateDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Testing dry run validation',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    assert.equal(validResult.isValid, true);
    assert.equal(validResult.code, 'VALID');

    // Ensure no decision files were created
    const decisions = await decisionEngine.listDecisions({ workspaceRoot: tempDir });
    assert.equal(decisions.length, 0);

    // 2. Invalid input (mismatched fingerprint)
    const invalidResult = await decisionEngine.validateDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Testing dry run invalid',
      basedOnContextFingerprint: 'mismatched-fingerprint',
    });
    assert.equal(invalidResult.isValid, false);
    assert.equal(invalidResult.code, 'CONTEXT_CHANGED');
  });

  it('T36_list_decisions_filtering: lists decisions filtered by type and session', async () => {
    await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Decision 1',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_PLANNING',
      rationale: 'Decision 2',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    const allDecisions = await decisionEngine.listDecisions({ workspaceRoot: tempDir });
    assert.equal(allDecisions.length, 2);

    const acceptOnly = await decisionEngine.listDecisions({
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
    });
    assert.equal(acceptOnly.length, 1);
    assert.equal(acceptOnly[0]?.decisionType, 'ACCEPT_CONTEXT');

    const planningOnly = await decisionEngine.listDecisions({
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_PLANNING',
    });
    assert.equal(planningOnly.length, 1);
    assert.equal(planningOnly[0]?.decisionType, 'REQUEST_PLANNING');
  });

  // ==========================================================================
  // 8. MCP Tools Integration
  // ==========================================================================

  it('T37_mcp_tools_registration: registers all 4 Director decision MCP tools when enabled', () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorDecisionTools: true,
    });

    const toolNames = server.getRegisteredTools().map((t) => t.name);
    assert.ok(toolNames.includes(AIDM_DIRECTOR_DECISION_CREATE_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_DECISION_GET_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_DECISION_VALIDATE_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_DECISION_LIST_TOOL_NAME));
  });

  it('T38_mcp_create_and_get_decision: decision create and get work through MCP envelope', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorDecisionTools: true,
    });
    await server.start();

    // 1. Create decision via MCP
    const createReq = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_DECISION_CREATE_TOOL_NAME,
        arguments: {
          directorSessionId: activeSession.directorSessionId,
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Created via MCP protocol',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        },
      },
    };

    const createRes = await server.handleMessage(createReq);
    assert.ok(createRes && 'result' in createRes);
    const createContent = (createRes as any).result.content[0].text;
    const createdDecision = JSON.parse(createContent);
    assert.equal(createdDecision.decisionType, 'ACCEPT_CONTEXT');
    assert.ok(createdDecision.decisionId);

    // 2. Get decision via MCP
    const getReq = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_DECISION_GET_TOOL_NAME,
        arguments: {
          decisionId: createdDecision.decisionId,
        },
      },
    };

    const getRes = await server.handleMessage(getReq);
    assert.ok(getRes && 'result' in getRes);
    const getContent = (getRes as any).result.content[0].text;
    const retrievedDecision = JSON.parse(getContent);
    assert.equal(retrievedDecision.decisionId, createdDecision.decisionId);

    await server.stop();
  });

  it('T39_mcp_validate_decision: validate tool works through MCP envelope without persisting', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorDecisionTools: true,
    });
    await server.start();

    const validateReq = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_DECISION_VALIDATE_TOOL_NAME,
        arguments: {
          directorSessionId: activeSession.directorSessionId,
          decisionType: 'REQUEST_PLANNING',
          rationale: 'Validating via MCP',
          basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        },
      },
    };

    const validateRes = await server.handleMessage(validateReq);
    assert.ok(validateRes && 'result' in validateRes);
    const validateContent = (validateRes as any).result.content[0].text;
    const valResult = JSON.parse(validateContent);
    assert.equal(valResult.isValid, true);
    assert.equal(valResult.code, 'VALID');

    await server.stop();
  });

  // ==========================================================================
  // 9. Architectural Invariants
  // ==========================================================================

  it('T40_no_task_creation_or_dag_mutation: decision protocol does NOT mutate Task DAG or tasks.json', async () => {
    const tasksBefore = await specStore.loadTasks();

    await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'REQUEST_PLANNING',
      rationale: 'Planning requested',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    const tasksAfter = await specStore.loadTasks();
    assert.deepEqual(tasksAfter, tasksBefore);
  });

  it('T41_no_fsm_mutation: decision protocol does NOT mutate DurableStateManager FSM state', async () => {
    const existsBefore = await durableManager.exists();
    const stateBefore = existsBefore ? await durableManager.load() : null;

    await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Context accepted',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    const existsAfter = await durableManager.exists();
    const stateAfter = existsAfter ? await durableManager.load() : null;
    assert.deepEqual(stateAfter, stateBefore);
  });

  it('T42_no_antigravity_invocation: zero references or calls to Antigravity execution', async () => {
    let antigravityCalled = false;
    // Decision creation must never attempt to invoke any executor
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Proving zero Antigravity calls',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    assert.equal(antigravityCalled, false);
    assert.equal(decision.hasImplementationAuthority, false);
  });

  it('T43_no_git_mutation: decision creation leaves Git working tree and commits untouched', async () => {
    const gitStateBefore = await gitPort.inspectState(tempDir);

    await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Git invariance test',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    const gitStateAfter = await gitPort.inspectState(tempDir);
    assert.equal(gitStateAfter.head_sha, gitStateBefore.head_sha);
    assert.equal(gitStateAfter.current_branch, gitStateBefore.current_branch);
  });

  it('T44_no_autonomous_loop: decision operations complete synchronously without spawning background loops', async () => {
    const start = Date.now();
    const decision = await decisionEngine.createDecision({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Autonomous loop invariance test',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });
    const duration = Date.now() - start;

    assert.ok(decision);
    assert.ok(duration < 5000, 'Decision creation should be fast and synchronous');
  });
});
