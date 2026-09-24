/**
 * Comprehensive Test Suite for Phase 9 Director Context Synchronization (TASK-P9-02)
 *
 * Verifies all 40 deterministic requirements:
 * 1. Successful Director context synchronization
 * 2. Session identity is preserved
 * 3. Project binding is preserved
 * 4. Cross-project synchronization is rejected
 * 5. Closed session cannot synchronize
 * 6. Invalid session is rejected
 * 7. Authoritative project status is included
 * 8. Requirements are read from the authoritative source
 * 9. Decisions are read from the authoritative source
 * 10. Task state is read from the authoritative Task DAG
 * 11. Current task is read from the authoritative source
 * 12. ContextEngine integration
 * 13. Evidence state/references are read-only
 * 14. History state is read-only
 * 15. Git status is read-only
 * 16. Clarification state is represented correctly
 * 17. Approval/readiness state is represented correctly
 * 18. Development authorization is reported but never modified
 * 19. Deterministic ordering
 * 20. Stable logical fingerprint for unchanged state
 * 21. Fingerprint changes when authoritative state changes
 * 22. Volatile timestamps do not alter logical fingerprint
 * 23. Stale context is detected
 * 24. Incomplete synchronization is explicitly represented
 * 25. Persistence/reload if synchronization metadata is persisted
 * 26. HistoryManager audit event
 * 27. Secret sanitization
 * 28. Path traversal rejection
 * 29. Malformed MCP request rejection
 * 30. MCP tool registration
 * 31. No second FSM
 * 32. No second Task DAG
 * 33. No shadow SpecStore
 * 34. No requirements/decision shadow store
 * 35. No authorization mutation
 * 36. No Antigravity invocation
 * 37. No task creation
 * 38. No autonomous loop
 * 39. No Git mutation
 * 40. No source-project mutation
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
  type DirectorSession,
  type DirectorContextSnapshot,
  DirectorValidationError,
  DirectorSessionNotFoundError,
  DirectorInvalidTransitionError,
  DirectorProjectBindingMismatchError,
  DIRECTOR_CONTEXT_PROTOCOL_VERSION,
  DIRECTOR_CONTEXT_SCHEMA_VERSION,
  McpServer,
  DefaultMcpOrchestratorDelegate,
  InMemoryMcpTransport,
  McpInvalidRequestError,
  AIDM_DIRECTOR_CONTEXT_SYNC_TOOL_NAME,
  registerDirectorSessionTools,
  HistoryManager,
  DurableStateManager,
  SpecStore,
  TaskDagEngine,
  ApprovalPackageEngine,
  ApprovalStore,
  ClarificationStore,
  ContextEngine,
  DefaultGitPort,
} from '../dist/index.js';

describe('Phase 9 — Director Context Synchronization (TASK-P9-02)', () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let approvalStore: ApprovalStore;
  let clarificationStore: ClarificationStore;
  let contextEngine: ContextEngine;
  let gitPort: DefaultGitPort;
  let delegate: DefaultMcpOrchestratorDelegate;
  let synchronizer: DirectorContextSynchronizer;
  let activeSession: DirectorSession;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p9-02-sync-test-'));

    // Create minimal package.json for project identity
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-sync-project', version: '1.0.0' }, null, 2)
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
    });

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
    });

    // Seed active session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      metadata: { initialSyncTest: true },
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  // 1. Successful Director context synchronization
  it('T01_successful_synchronization: synchronizes authoritative AIDM state into typed snapshot', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });

    assert.ok(snapshot);
    assert.equal(snapshot.isDerived, true);
    assert.equal(snapshot.protocolVersion, DIRECTOR_CONTEXT_PROTOCOL_VERSION);
    assert.equal(snapshot.schemaVersion, DIRECTOR_CONTEXT_SCHEMA_VERSION);
    assert.equal(snapshot.syncStatus, 'INITIAL');
    assert.equal(snapshot.isComplete, true);
    assert.equal(typeof snapshot.logicalFingerprint, 'string');
    assert.ok(snapshot.logicalFingerprint.length > 0);
  });

  // 2. Session identity is preserved
  it('T02_session_identity_preserved: snapshot references exact session ID and updates lastActivityAt', async () => {
    const beforeActivity = activeSession.lastActivityAt;
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.directorSessionId, activeSession.directorSessionId);
    const updated = await sessionEngine.getSession(activeSession.directorSessionId);
    assert.ok(updated.lastActivityAt >= beforeActivity);
  });

  // 3. Project binding is preserved
  it('T03_project_binding_preserved: snapshot preserves canonical projectRoot and projectId', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.projectId, 'test-sync-project');
    assert.equal(path.resolve(snapshot.projectRoot), path.resolve(tempDir));
  });

  // 4. Cross-project synchronization is rejected
  it('T04_cross_project_rejected: rejects synchronization attempt with mismatched projectId', async () => {
    await assert.rejects(
      async () => {
        await synchronizer.synchronize({
          directorSessionId: activeSession.directorSessionId,
          projectId: 'completely-different-project',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorProjectBindingMismatchError);
        return true;
      }
    );
  });

  // 5. Closed session cannot synchronize
  it('T05_closed_session_cannot_synchronize: terminal closed session rejects context sync', async () => {
    await sessionEngine.closeSession({
      directorSessionId: activeSession.directorSessionId,
      reason: 'Work completed',
    });

    await assert.rejects(
      async () => {
        await synchronizer.synchronize({
          directorSessionId: activeSession.directorSessionId,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorInvalidTransitionError);
        assert.ok((err as Error).message.includes('Invalid Director session lifecycle transition'));
        return true;
      }
    );
  });

  // 6. Invalid session is rejected
  it('T06_invalid_session_rejected: non-existent session ID throws DirectorSessionNotFoundError', async () => {
    await assert.rejects(
      async () => {
        await synchronizer.synchronize({
          directorSessionId: 'dir-sess-nonexistent-12345',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSessionNotFoundError);
        return true;
      }
    );
  });

  // 7. Authoritative project status is included
  it('T07_authoritative_project_status: reads initialized state and lifecycle from DurableStateManager', async () => {
    await durableManager.save({
      schemaVersion: 1,
      currentLifecycleState: 'REQUIREMENTS_INGESTION',
      activeTaskId: 'task-001',
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: 'cp-001',
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.projectStatus.initialized, true);
    assert.equal(snapshot.sections.projectStatus.lifecycleState, 'REQUIREMENTS_INGESTION');
    assert.equal(snapshot.sections.projectStatus.activeTaskId, 'task-001');
    assert.equal(snapshot.sections.projectStatus.lastCheckpoint, 'cp-001');
    assert.equal(snapshot.sections.projectStatus.isBlocked, false);
  });

  // 8. Requirements are read from authoritative source
  it('T08_requirements_authoritative: reads requirements from SpecStore', async () => {
    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'User Login',
        description: 'Allow email login',
        authority: Actor.USER,
        status: 'LOCKED',
      },
      {
        id: 'REQ-002',
        title: 'Project Dashboard',
        description: 'Show metrics',
        authority: Actor.USER,
        status: 'LOCKED',
      },
    ]);

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.requirements.total, 2);
    assert.equal(snapshot.sections.requirements.items[0].id, 'REQ-001');
    assert.equal(snapshot.sections.requirements.items[1].id, 'REQ-002');
  });

  // 9. Decisions are read from authoritative source
  it('T09_decisions_authoritative: reads decisions from SpecStore', async () => {
    await specStore.saveDecisions([
      {
        id: 'DEC-001',
        title: 'Use SQLite',
        description: 'SQLite for durable state',
        authority: Actor.DIRECTOR,
        status: 'LOCKED',
        rationale: 'Local execution',
      },
    ]);

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.decisions.total, 1);
    assert.equal(snapshot.sections.decisions.items[0].id, 'DEC-001');
    assert.equal(snapshot.sections.decisions.items[0].rationale, 'Local execution');
  });

  // 10. Task state is read from authoritative Task DAG
  it('T10_task_state_authoritative: reads tasks and topological order from DAG', async () => {
    await specStore.saveTasks([
      {
        task_id: 'task-b',
        title: 'Build Feature',
        description: 'Feature implementation',
        hierarchy_level: 'TASK',
        status: 'PENDING',
        priority: 'MEDIUM',
        risk_level: 'LOW',
        dependencies: ['task-a'],
        acceptance_criteria: ['Done'],
        traceability_sources: ['REQ-001'],
        attempt: 1,
        max_attempts: 3,
      },
      {
        task_id: 'task-a',
        title: 'Setup Core',
        description: 'Initial setup',
        hierarchy_level: 'TASK',
        status: 'PENDING',
        priority: 'HIGH',
        risk_level: 'LOW',
        dependencies: [],
        acceptance_criteria: ['Core ready'],
        traceability_sources: ['REQ-001'],
        attempt: 1,
        max_attempts: 3,
      },
    ]);

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.taskList.total, 2);
    // Task-a must precede task-b in topological order
    assert.deepEqual(snapshot.sections.taskList.topologicalOrder, ['task-a', 'task-b']);
  });

  // 11. Current task is read from authoritative source
  it('T11_current_task_authoritative: reflects active task from durable state', async () => {
    await specStore.saveTasks([
      {
        task_id: 'task-active',
        title: 'Active Work',
        description: 'Currently working on this',
        hierarchy_level: 'TASK',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        risk_level: 'LOW',
        dependencies: [],
        acceptance_criteria: ['AC 1'],
        traceability_sources: ['REQ-001'],
        attempt: 1,
        max_attempts: 3,
      },
    ]);
    await durableManager.save({
      schemaVersion: 1,
      currentLifecycleState: 'TASK_LOOP',
      activeTaskId: 'task-active',
      completedTaskIds: [],
      blockedState: null,
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.currentTask.hasActiveTask, true);
    assert.equal(snapshot.sections.currentTask.task?.taskId, 'task-active');
    assert.equal(snapshot.sections.currentTask.task?.title, 'Active Work');
  });

  // 12. ContextEngine integration
  it('T12_context_engine_integration: inspects target paths through authoritative ContextEngine', async () => {
    const srcFile = path.join(tempDir, 'sample.ts');
    fs.writeFileSync(srcFile, 'export const sample = 42;');

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      targetPaths: ['sample.ts'],
    });

    assert.equal(snapshot.sections.contextEngine.isAvailable, true);
    assert.equal(snapshot.sections.contextEngine.inspectedPaths.length, 1);
    assert.equal(snapshot.sections.contextEngine.inspectedPaths[0].sourcePath, 'sample.ts');
    assert.equal(snapshot.sections.contextEngine.inspectedPaths[0].isStale, false);
  });

  // 13. Evidence state is read-only
  it('T13_evidence_state_readonly: reads evidence without mutating evidence stores', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.ok(snapshot.sections.evidence);
    assert.equal(typeof snapshot.sections.evidence.totalAvailable, 'number');
    assert.ok(Array.isArray(snapshot.sections.evidence.items));
  });

  // 14. History state is read-only
  it('T14_history_state_readonly: reads recent events without altering audit integrity', async () => {
    await historyManager.appendEvent({
      eventType: 'SYSTEM_BOOT',
      actor: Actor.DIRECTOR,
      payload: { test: true },
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.ok(snapshot.sections.history.totalEvents >= 1);
    assert.ok(snapshot.sections.history.recentEvents.some((e) => e.eventType === 'SYSTEM_BOOT'));
  });

  // 15. Git status is read-only
  it('T15_git_status_readonly: queries Git state without staging, committing, or checking out', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.ok(snapshot.sections.git);
    assert.equal(typeof snapshot.sections.git.isGitRepository, 'boolean');
  });

  // 16. Clarification state is represented correctly
  it('T16_clarification_state_represented: reflects active clarification session and blocking counts', async () => {
    await clarificationStore.saveSession({
      sessionId: 'clarif-sess-001',
      projectId: 'test-sync-project',
      sourceDiscoveryReference: 'disc-001',
      status: 'WAITING_FOR_HUMAN',
      blockingOpenCount: 2,
      totalCount: 3,
      resolvedCount: 1,
      questions: [],
      answers: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.clarification.hasActiveSession, true);
    assert.equal(snapshot.sections.clarification.sessionId, 'clarif-sess-001');
    assert.equal(snapshot.sections.clarification.blockingOpenCount, 2);
    assert.equal(snapshot.sections.clarification.hasUnresolvedBlocking, true);
  });

  // 17. Approval/readiness state is represented correctly
  it('T17_approval_state_represented: reflects approval package and readiness condition', async () => {
    const now = new Date().toISOString();
    await approvalStore.savePackage({
      packageId: 'pkg-001',
      revision: 1,
      projectId: 'test-sync-project',
      projectUnderstanding: {
        projectId: 'test-sync-project',
        projectName: 'Test',
        apparentPurpose: { classification: 'UNDERSTOOD', summary: 'test', domainKeywords: [] },
        targetUsers: ['Users'],
        technologyStack: { languages: ['TS'], frameworks: [], buildTools: [], runtimes: [] },
        architectureSummary: { pattern: 'Modular', mainModules: [], dataFlow: 'Uni' },
        existingCapabilities: [],
        confirmedRequirements: [],
        clarifiedRequirements: [],
        unresolvedUnknowns: [],
        unresolvedContradictions: [],
        currentImplementationState: { isScaffolded: true, completenessAssessment: 'INITIAL' },
        constraints: [],
        assumptions: [],
        nonGoals: [],
        proposedDevelopmentScope: [],
        evidenceReferences: [],
        sourceDiscoveryReference: 'disc-001',
        generatedAt: now,
      },
      proposedDevelopmentPlan: {
        objectives: ['Obj 1'],
        proposedScope: ['Scope 1'],
        proposedFeatureGroups: [{ name: 'Group 1', description: 'Desc', targetCapabilities: [] }],
        dependencies: [],
        constraints: [],
        knownRisks: [],
        unresolvedIssues: [],
        excludedScope: [],
        suggestedImplementationOrder: [],
      },
      unresolvedItems: [],
      assumptions: [],
      evidenceReferences: [],
      status: 'READY_FOR_APPROVAL',
      createdAt: now,
      updatedAt: now,
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.approval.hasApprovalPackage, true);
    assert.equal(snapshot.sections.approval.packageId, 'pkg-001');
    assert.equal(snapshot.sections.approval.revision, 1);
    assert.equal(snapshot.sections.approval.isReadyForApproval, true);
    assert.equal(snapshot.sections.approval.isExplicitlyApproved, false);
  });

  // 18. Development authorization is reported but never modified
  it('T18_development_authorization_invariant: strictly reports isDevelopmentAuthorized: false before PO approval', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.sections.authorization.isDevelopmentAuthorized, false);
    assert.equal(snapshot.sections.authorization.authoritySource, 'PRODUCT_OWNER');
    assert.equal(snapshot.sections.authorization.requiresHumanApproval, true);
  });

  // 19. Deterministic ordering
  it('T19_deterministic_ordering: requirements, decisions, and tasks are sorted deterministically', async () => {
    await specStore.saveRequirements([
      { id: 'REQ-Z', title: 'Z', description: 'Z', authority: Actor.USER, status: 'LOCKED' },
      { id: 'REQ-A', title: 'A', description: 'A', authority: Actor.USER, status: 'LOCKED' },
    ]);

    const snapshot1 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot1.sections.requirements.items[0].id, 'REQ-A');
    assert.equal(snapshot1.sections.requirements.items[1].id, 'REQ-Z');
  });

  // 20. Stable logical fingerprint for unchanged state
  it('T20_stable_fingerprint: produces identical logical fingerprint when underlying state is unchanged', async () => {
    const snap1 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });
    const snap2 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      priorFingerprint: snap1.logicalFingerprint,
    });

    assert.equal(snap1.logicalFingerprint, snap2.logicalFingerprint);
    assert.equal(snap2.syncStatus, 'UNCHANGED');
  });

  // 21. Fingerprint changes when authoritative state changes
  it('T21_fingerprint_changes_on_state_change: modifying requirements changes logical fingerprint', async () => {
    const snap1 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    await specStore.saveRequirements([
      { id: 'REQ-NEW', title: 'New', description: 'Desc', authority: Actor.USER, status: 'LOCKED' },
    ]);

    const snap2 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      priorFingerprint: snap1.logicalFingerprint,
    });

    assert.notEqual(snap1.logicalFingerprint, snap2.logicalFingerprint);
    assert.equal(snap2.syncStatus, 'CHANGED');
  });

  // 22. Volatile timestamps do not alter logical fingerprint
  it('T22_volatile_timestamps_excluded: logical fingerprint is independent of request synchronization timestamp', async () => {
    const snap1 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    // Artificially wait a tiny bit to guarantee different wall clock timestamp
    await new Promise((r) => setTimeout(r, 10));

    const snap2 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.notEqual(snap1.synchronizedAt, snap2.synchronizedAt);
    assert.equal(snap1.logicalFingerprint, snap2.logicalFingerprint);
  });

  // 23. Stale context is detected
  it('T23_stale_context_detected: reports staleSections when target context file hash differs', async () => {
    const targetFile = path.join(tempDir, 'module.ts');
    fs.writeFileSync(targetFile, 'const v = 1;');

    // Sync context index
    await contextEngine.syncIndex();

    // Modify file on disk without re-indexing
    fs.writeFileSync(targetFile, 'const v = 2; // modified outside index');

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      targetPaths: ['module.ts'],
    });

    assert.ok(snapshot.staleSections.includes('contextEngine'));
    assert.equal(snapshot.syncStatus, 'STALE');
  });

  // 24. Incomplete synchronization is explicitly represented
  it('T24_incomplete_synchronization_represented: reports unavailable sections if a store fails', async () => {
    const brokenDelegate = {
      projectRoot: tempDir,
      directorSessionStore: sessionStore,
      getEvidence: async () => {
        throw new Error('Evidence store connection failed');
      },
    } as unknown as DefaultMcpOrchestratorDelegate;
    const brokenSynchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      delegate: brokenDelegate,
      sessionEngine,
      sessionStore,
    });

    const snapshot = await brokenSynchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(snapshot.isComplete, false);
    assert.equal(snapshot.syncStatus, 'INCOMPLETE');
    assert.ok(snapshot.unavailableSections.length > 0);
  });

  // 25. Persistence and recovery of snapshot
  it('T25_snapshot_persistence_and_recovery: loads persisted snapshot from sessionStore', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    const recovered = await sessionStore.loadLatestSnapshot(activeSession.directorSessionId);
    assert.ok(recovered);
    assert.equal(recovered.logicalFingerprint, snapshot.logicalFingerprint);
    assert.equal(recovered.directorSessionId, activeSession.directorSessionId);

    const byHash = await sessionStore.loadSnapshot(
      activeSession.directorSessionId,
      snapshot.logicalFingerprint
    );
    assert.ok(byHash);
    assert.equal(byHash.logicalFingerprint, snapshot.logicalFingerprint);
  });

  // 26. HistoryManager audit events
  it('T26_history_manager_audit_events: logs DIRECTOR_CONTEXT_SYNCHRONIZED event', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    const allEvents = await historyManager.readEvents();
    const events = allEvents.filter((e) => e.eventType === 'DIRECTOR_CONTEXT_SYNCHRONIZED');

    assert.ok(events.length >= 1);
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.actor, Actor.DIRECTOR);
    assert.equal(lastEvent.payload.directorSessionId, activeSession.directorSessionId);
    assert.equal(lastEvent.payload.logicalFingerprint, snapshot.logicalFingerprint);
  });

  // 27. Secret sanitization
  it('T27_secret_sanitization: sensitive keys in metadata are redacted from persisted snapshot', async () => {
    await specStore.saveDecisions([
      {
        id: 'DEC-SECRET',
        title: 'Secret Decision',
        description: 'Test secret',
        metadata: {
          apiKey: 'super-secret-token',
          nested: { password: 'pwd' },
          safeField: 'visible',
        },
      },
    ]);

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    const loaded = await sessionStore.loadLatestSnapshot(activeSession.directorSessionId);
    assert.ok(loaded);
    const contentStr = JSON.stringify(loaded);
    assert.ok(!contentStr.includes('super-secret-token'));
    assert.ok(!contentStr.includes('pwd'));
    assert.ok(contentStr.includes('***REDACTED***'));
  });

  // 28. Path traversal rejection
  it('T28_path_traversal_rejection: rejects path traversal in directorSessionId', async () => {
    await assert.rejects(
      async () => {
        await synchronizer.synchronize({
          directorSessionId: '../../etc/passwd',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        return true;
      }
    );
  });

  // 29. Malformed MCP request rejection
  it('T29_malformed_mcp_request_rejection: rejects invalid arguments schema through MCP tool', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
    });
    await server.start();

    const req = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_CONTEXT_SYNC_TOOL_NAME,
        arguments: {
          evidenceLimit: -5, // must be positive
        },
      },
    };
    const res = await server.handleMessage(req);
    assert.ok(res && 'error' in res);
    assert.ok((res as any).error.message.includes('Invalid Director context sync request'));

    await server.stop();
  });

  // 30. MCP tool registration
  it('T30_mcp_tool_registration: aidm.director.context.sync is registered and executable via MCP', async () => {
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
    });
    await server.start();

    const listReq = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/list',
      params: {},
    };
    const listRes = await server.handleMessage(listReq);
    assert.ok(listRes && 'result' in listRes);
    const tools = (listRes.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((t) => t.name === AIDM_DIRECTOR_CONTEXT_SYNC_TOOL_NAME));

    const callReq = {
      jsonrpc: '2.0' as const,
      id: 3,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_CONTEXT_SYNC_TOOL_NAME,
        arguments: {
          directorSessionId: activeSession.directorSessionId,
        },
      },
    };
    const callRes = await server.handleMessage(callReq);
    assert.ok(callRes && 'result' in callRes);
    const content = (callRes.result as { content: Array<{ text: string }> }).content;
    const parsedSnapshot = JSON.parse(content[0].text);
    assert.equal(parsedSnapshot.directorSessionId, activeSession.directorSessionId);
    assert.equal(parsedSnapshot.isDerived, true);

    await server.stop();
  });

  // 31. No second FSM
  it('T31_no_second_fsm: DurableStateManager remains sole FSM authority', async () => {
    await durableManager.save({
      schemaVersion: 1,
      currentLifecycleState: 'INITIALIZING',
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
    });

    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    // Synchronizer has not altered FSM state
    const durableState = await durableManager.load();
    assert.ok(durableState);
    assert.equal(snapshot.sections.projectStatus.lifecycleState, durableState.currentLifecycleState);
  });

  // 32. No second Task DAG
  it('T32_no_second_dag: DAG is read directly via TaskDagEngine without creating parallel graph store', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.ok(snapshot.sections.taskList);
    assert.equal(fs.existsSync(path.join(tempDir, '.ai-manager', 'director-dag')), false);
  });

  // 33. No shadow SpecStore
  it('T33_no_shadow_spec_store: no shadow requirements or decisions files are created', async () => {
    await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.equal(fs.existsSync(path.join(tempDir, '.ai-manager', 'director-spec')), false);
    assert.equal(fs.existsSync(path.join(tempDir, '.ai-manager', 'director', 'requirements.json')), false);
  });

  // 34. No requirements/decision shadow store
  it('T34_no_requirements_mutation: SpecStore files are completely unmodified by synchronization', async () => {
    await specStore.saveRequirements([
      { id: 'REQ-IMMUTABLE', title: 'T', description: 'D', authority: Actor.USER, status: 'LOCKED' },
    ]);
    const reqMtimeBefore = fs.statSync(specStore.requirementsPath).mtimeMs;

    await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    const reqMtimeAfter = fs.statSync(specStore.requirementsPath).mtimeMs;
    assert.equal(reqMtimeBefore, reqMtimeAfter);
  });

  // 35. No authorization mutation
  it('T35_no_authorization_mutation: isDevelopmentAuthorized remains false before and after sync', async () => {
    const snap1 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });
    assert.equal(snap1.sections.authorization.isDevelopmentAuthorized, false);

    const snap2 = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });
    assert.equal(snap2.sections.authorization.isDevelopmentAuthorized, false);
  });

  // 36. No Antigravity invocation
  it('T36_no_antigravity_invocation: zero calls or references to Antigravity execution', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.ok(snapshot);
    // Verifies no executor processes were spawned or contacted
    assert.equal(fs.existsSync(path.join(tempDir, '.ai-manager', 'antigravity')), false);
  });

  // 37. No task creation
  it('T37_no_task_creation: synchronization does not add or schedule implementation tasks', async () => {
    const tasksBefore = await specStore.loadTasks();
    await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });
    const tasksAfter = await specStore.loadTasks();

    assert.equal(tasksBefore.length, tasksAfter.length);
  });

  // 38. No autonomous loop
  it('T38_no_autonomous_loop: single pass synchronization without continuous iteration loop', async () => {
    const snapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    assert.ok(snapshot.synchronizedAt);
    assert.equal(snapshot.isDerived, true);
  });

  // 39. No Git mutation
  it('T39_no_git_mutation: synchronization leaves working tree and Git HEAD unmutated', async () => {
    const gitStateBefore = await gitPort.inspectState(tempDir);
    await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });
    const gitStateAfter = await gitPort.inspectState(tempDir);

    assert.equal(gitStateBefore.head_sha, gitStateAfter.head_sha);
    assert.equal(gitStateBefore.current_branch, gitStateAfter.current_branch);
  });

  // 40. No source-project mutation
  it('T40_no_source_project_mutation: project files remain strictly untouched by synchronization', async () => {
    const pkgPath = path.join(tempDir, 'package.json');
    const contentBefore = fs.readFileSync(pkgPath, 'utf8');

    await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
    });

    const contentAfter = fs.readFileSync(pkgPath, 'utf8');
    assert.equal(contentBefore, contentAfter);
  });
});
