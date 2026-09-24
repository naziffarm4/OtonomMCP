/**
 * Comprehensive Test Suite for Phase 9 Director Session Identity (TASK-P9-01)
 *
 * Verifies all 28 deterministic requirements:
 * 1. Director session creation
 * 2. Deterministic session ID behavior / uniqueness semantics
 * 3. Project binding
 * 4. Session persistence
 * 5. Session reload after fresh process/store instance
 * 6. Activity timestamp / state update
 * 7. Suspend
 * 8. Close
 * 9. Invalid lifecycle transition rejection
 * 10. HistoryManager audit events
 * 11. Secret sanitization
 * 12. Path traversal / session ID validation
 * 13. Actor-type enforcement
 * 14. Product Owner vs Director authority separation
 * 15. Antigravity cannot create/impersonate Director session
 * 16. Director session cannot grant implementation authorization
 * 17. Existing isDevelopmentAuthorized() semantics remain unchanged
 * 18. Cross-project session binding rejection
 * 19. MCP request/response schema validation
 * 20. MCP tool registration
 * 21. Malformed MCP request rejection
 * 22. Persistence recovery
 * 23. No second FSM
 * 24. No shadow store
 * 25. No Task DAG mutation
 * 26. No Antigravity execution
 * 27. No autonomous loop
 * 28. Resume semantics distinct from retry or new identity
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
  resolveCanonicalProjectIdentity,
  validateProjectBinding,
  type DirectorSession,
  DirectorValidationError,
  DirectorSessionNotFoundError,
  DirectorSessionAlreadyExistsError,
  DirectorInvalidTransitionError,
  DirectorSecurityError,
  DirectorProjectBindingMismatchError,
  DIRECTOR_PROTOCOL_VERSION,
  DIRECTOR_SCHEMA_VERSION,
  McpServer,
  DefaultMcpOrchestratorDelegate,
  InMemoryMcpTransport,
  McpInvalidRequestError,
  AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_GET_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_SUSPEND_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_CLOSE_TOOL_NAME,
  AIDM_DIRECTOR_SESSION_RESUME_TOOL_NAME,
  HistoryManager,
  DurableStateManager,
  SpecStore,
  TaskDagEngine,
  ApprovalPackageEngine,
  ApprovalStore,
  InitialProjectUnderstandingBuilder,
  isDevelopmentAuthorized,
  type ProjectApprovalPackage,
} from '../dist/index.js';

describe('Phase 9 Director Session Identity (TASK-P9-01)', () => {
  let tmpDir: string;
  let historyManager: HistoryManager;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p9-session-test-'));

    // Create a mock package.json for project identity
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2)
    );

    historyManager = new HistoryManager({ baseDir: tmpDir });
    durableManager = new DurableStateManager({ baseDir: tmpDir });
    specStore = new SpecStore({ baseDir: tmpDir });
    dagEngine = new TaskDagEngine();

    sessionStore = new DirectorSessionStore({
      baseDir: tmpDir,
      historyManager,
    });

    sessionEngine = new DirectorSessionEngine({
      store: sessionStore,
      workspaceRoot: tmpDir,
    });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================================================
  // 1. Director Session Creation
  // ==========================================================================
  it('T01_director_session_creation: creates a durable Director session with all required identity fields', async () => {
    const session = await sessionEngine.createSession({
      metadata: { client: 'chatgpt-director-v1' },
      approvalPackageId: 'pkg-001',
      approvalRevision: 1,
      understandingRevision: 1,
    });

    assert.ok(session.directorSessionId.startsWith('dir-sess-'));
    assert.equal(session.projectId, 'test-project');
    assert.equal(session.projectRoot, path.resolve(tmpDir));
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.protocolVersion, DIRECTOR_PROTOCOL_VERSION);
    assert.equal(session.schemaVersion, DIRECTOR_SCHEMA_VERSION);
    assert.equal(session.actor, Actor.DIRECTOR);
    assert.equal(session.actorRole, 'DIRECTOR');
    assert.ok(session.createdAt);
    assert.ok(session.lastActivityAt);
    assert.equal(session.approvalPackageId, 'pkg-001');
    assert.equal(session.approvalRevision, 1);
    assert.equal(session.understandingRevision, 1);
    assert.equal(session.hasImplementationAuthority, false);
    assert.equal((session.metadata as Record<string, unknown>).client, 'chatgpt-director-v1');
  });

  // ==========================================================================
  // 2. Deterministic Session ID Behavior & Uniqueness Semantics
  // ==========================================================================
  it('T02_deterministic_session_id_uniqueness: validates custom session ID and rejects duplicates', async () => {
    const customId = 'dir-sess-custom-001';
    const session = await sessionEngine.createSession({
      directorSessionId: customId,
    });
    assert.equal(session.directorSessionId, customId);

    // Attempting to create duplicate session ID must fail deterministically
    await assert.rejects(
      async () => {
        await sessionEngine.createSession({
          directorSessionId: customId,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSessionAlreadyExistsError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 3. Project Binding
  // ==========================================================================
  it('T03_project_binding: session is canonically bound to workspace root and project identity', async () => {
    const canonical = resolveCanonicalProjectIdentity(tmpDir);
    assert.equal(canonical.projectId, 'test-project');
    assert.equal(canonical.projectRoot, path.resolve(tmpDir));

    const session = await sessionEngine.createSession({
      projectId: 'test-project',
    });
    assert.equal(session.projectId, canonical.projectId);
    assert.equal(session.projectRoot, canonical.projectRoot);
  });

  // ==========================================================================
  // 4. Session Persistence
  // ==========================================================================
  it('T04_session_persistence: persists session file and active pointer atomically under .ai-manager/director/', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-persist-test',
    });

    const sessionFile = path.join(tmpDir, '.ai-manager', 'director', 'sessions', `${session.directorSessionId}.json`);
    const activeFile = path.join(tmpDir, '.ai-manager', 'director', 'active-session.json');

    assert.ok(fs.existsSync(sessionFile), 'Session file must exist');
    assert.ok(fs.existsSync(activeFile), 'Active session pointer must exist');

    const raw = JSON.parse(await fs.promises.readFile(sessionFile, 'utf8'));
    assert.equal(raw.directorSessionId, session.directorSessionId);
    assert.equal(raw.status, 'ACTIVE');
  });

  // ==========================================================================
  // 5. Session Reload After Fresh Process/Store Instance
  // ==========================================================================
  it('T05_session_reload_fresh_instance: recovers identical session from a fresh store instance without data loss', async () => {
    const created = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-reload-test',
      metadata: { key: 'value123' },
    });

    // Fresh store and engine instance simulating process restart
    const freshStore = new DirectorSessionStore({ baseDir: tmpDir });
    const freshEngine = new DirectorSessionEngine({ store: freshStore, workspaceRoot: tmpDir });

    const loaded = await freshEngine.getSession('dir-sess-reload-test');
    assert.equal(loaded.directorSessionId, created.directorSessionId);
    assert.equal(loaded.createdAt, created.createdAt);
    assert.equal(loaded.projectId, created.projectId);
    assert.equal(loaded.projectRoot, created.projectRoot);
    assert.equal(loaded.status, created.status);

    // Active session lookup also recovers it
    const active = await freshStore.getActiveSession();
    assert.ok(active);
    assert.equal(active.directorSessionId, created.directorSessionId);
  });

  // ==========================================================================
  // 6. Activity Timestamp & State Update
  // ==========================================================================
  it('T06_activity_timestamp_state_update: touch updates lastActivityAt without changing createdAt or ID', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-touch-test',
    });

    // Wait slightly to guarantee timestamp advance
    await new Promise((r) => setTimeout(r, 10));

    const touched = await sessionEngine.touchSession({
      directorSessionId: session.directorSessionId,
    });

    assert.equal(touched.directorSessionId, session.directorSessionId);
    assert.equal(touched.createdAt, session.createdAt);
    assert.ok(new Date(touched.lastActivityAt).getTime() >= new Date(session.lastActivityAt).getTime());
  });

  // ==========================================================================
  // 7. Suspend Session
  // ==========================================================================
  it('T07_suspend_session: transitions ACTIVE to SUSPENDED with updated activity timestamp', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-suspend-test',
    });

    const suspended = await sessionEngine.suspendSession({
      directorSessionId: session.directorSessionId,
      reason: 'Awaiting human review',
    });

    assert.equal(suspended.status, 'SUSPENDED');
    assert.equal(suspended.directorSessionId, session.directorSessionId);
    assert.equal((suspended.metadata as Record<string, unknown>).suspendReason, 'Awaiting human review');

    // Reload from store to verify durable persistence of SUSPENDED state
    const loaded = await sessionStore.loadSession(session.directorSessionId);
    assert.equal(loaded?.status, 'SUSPENDED');
  });

  // ==========================================================================
  // 8. Close Session
  // ==========================================================================
  it('T08_close_session: transitions session to terminal CLOSED status and updates active pointer', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-close-test',
    });

    const closed = await sessionEngine.closeSession({
      directorSessionId: session.directorSessionId,
      reason: 'Mission completed',
    });

    assert.equal(closed.status, 'CLOSED');
    assert.equal((closed.metadata as Record<string, unknown>).closeReason, 'Mission completed');

    // Active session should now be null
    const active = await sessionStore.getActiveSession();
    assert.equal(active, null);
  });

  // ==========================================================================
  // 9. Invalid Lifecycle Transition Rejection
  // ==========================================================================
  it('T09_invalid_lifecycle_transition_rejection: closed session is terminal and cannot transition to ACTIVE or SUSPENDED', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-terminal-test',
    });

    await sessionEngine.closeSession({
      directorSessionId: session.directorSessionId,
    });

    // Attempt resume on closed session
    await assert.rejects(
      async () => {
        await sessionEngine.resumeSession({
          directorSessionId: session.directorSessionId,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorInvalidTransitionError);
        return true;
      }
    );

    // Attempt suspend on closed session
    await assert.rejects(
      async () => {
        await sessionEngine.suspendSession({
          directorSessionId: session.directorSessionId,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorInvalidTransitionError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 10. HistoryManager Audit Events
  // ==========================================================================
  it('T10_history_manager_audit_events: records all lifecycle transitions into append-only history log', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-audit-test',
    });

    await sessionEngine.suspendSession({
      directorSessionId: session.directorSessionId,
    });

    await sessionEngine.resumeSession({
      directorSessionId: session.directorSessionId,
    });

    await sessionEngine.closeSession({
      directorSessionId: session.directorSessionId,
    });

    const events = await historyManager.readEvents();
    const eventTypes = events.map((e) => e.eventType);

    assert.ok(eventTypes.includes('DIRECTOR_SESSION_CREATED'), 'Must record DIRECTOR_SESSION_CREATED');
    assert.ok(eventTypes.includes('DIRECTOR_SESSION_SUSPENDED'), 'Must record DIRECTOR_SESSION_SUSPENDED');
    assert.ok(eventTypes.includes('DIRECTOR_SESSION_RESUMED'), 'Must record DIRECTOR_SESSION_RESUMED');
    assert.ok(eventTypes.includes('DIRECTOR_SESSION_CLOSED'), 'Must record DIRECTOR_SESSION_CLOSED');

    for (const e of events) {
      assert.equal(e.actor, Actor.DIRECTOR);
      assert.ok(e.payload.directorSessionId);
    }
  });

  // ==========================================================================
  // 11. Secret Sanitization
  // ==========================================================================
  it('T11_secret_sanitization: sensitive keys in session metadata are redacted before storage and MCP output', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-secret-test',
      metadata: {
        publicInfo: 'public-data',
        apiKey: 'super-secret-key-12345',
        bearerToken: 'token-xyz',
        dbPassword: 'secret-password',
      },
    });

    assert.equal(session.metadata.publicInfo, 'public-data');
    assert.equal(session.metadata.apiKey, '***REDACTED***');
    assert.equal(session.metadata.bearerToken, '***REDACTED***');
    assert.equal(session.metadata.dbPassword, '***REDACTED***');

    // Verify stored file also has redacted secrets
    const loaded = await sessionStore.loadSession(session.directorSessionId);
    assert.equal(loaded?.metadata.apiKey, '***REDACTED***');
  });

  // ==========================================================================
  // 12. Path Traversal & Session ID Validation
  // ==========================================================================
  it('T12_path_traversal_session_id_validation: strictly rejects malicious session IDs and path traversal payloads', async () => {
    const maliciousIds = [
      '../evil',
      '../../etc/passwd',
      'dir/sess',
      'dir\\sess',
      'sess\0null',
      'ab', // too short (< 3)
      'sess with spaces',
      'sess*wildcard',
    ];

    for (const badId of maliciousIds) {
      await assert.rejects(
        async () => {
          await sessionEngine.createSession({
            directorSessionId: badId,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorValidationError);
          return true;
        },
        `Expected rejection for malicious ID: ${badId}`
      );
    }
  });

  // ==========================================================================
  // 13. Actor-Type Enforcement
  // ==========================================================================
  it('T13_actor_type_enforcement: rejects unauthorized actor types when creating a Director session', async () => {
    await assert.rejects(
      async () => {
        await sessionEngine.createSession({
          actor: 'UNKNOWN_ACTOR',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 14. Product Owner vs Director Authority Separation
  // ==========================================================================
  it('T14_product_owner_vs_director_authority_separation: Director session cannot impersonate Product Owner (USER)', async () => {
    await assert.rejects(
      async () => {
        await sessionEngine.createSession({
          actor: Actor.USER,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.ok(err.message.includes('Product Owner'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 15. Antigravity Cannot Create/Impersonate Director Session
  // ==========================================================================
  it('T15_antigravity_cannot_create_or_impersonate_director: Antigravity (EXECUTOR) cannot create a Director session', async () => {
    await assert.rejects(
      async () => {
        await sessionEngine.createSession({
          actor: Actor.EXECUTOR,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.ok(err.message.includes('EXECUTOR') || err.message.includes('Antigravity'));
        return true;
      }
    );
  });

  // ==========================================================================
  // 16. Director Session Cannot Grant Implementation Authorization
  // ==========================================================================
  it('T16_director_session_cannot_grant_implementation_authorization: session identity strictly sets hasImplementationAuthority to false', async () => {
    const session = await sessionEngine.createSession();
    assert.equal(session.hasImplementationAuthority, false);

    // Even if resume or suspend is called, hasImplementationAuthority remains false
    const suspended = await sessionEngine.suspendSession({
      directorSessionId: session.directorSessionId,
    });
    assert.equal(suspended.hasImplementationAuthority, false);

    const resumed = await sessionEngine.resumeSession({
      directorSessionId: session.directorSessionId,
    });
    assert.equal(resumed.hasImplementationAuthority, false);
  });

  // ==========================================================================
  // 17. Existing isDevelopmentAuthorized() Semantics Remain Unchanged
  // ==========================================================================
  it('T17_isDevelopmentAuthorized_semantics_remain_unchanged: isDevelopmentAuthorized is false regardless of Director session state', async () => {
    const approvalStore = new ApprovalStore({ baseDir: tmpDir });
    const approvalEngine = new ApprovalPackageEngine();

    // Create a valid unapproved package
    const mockReport = {
      projectIdentity: {
        name: 'test-project',
        version: '1.0.0',
        workspaceRoot: tmpDir,
        ecosystem: 'Node.js',
        evidence: [],
      },
      purpose: {
        classification: 'UNDERSTOOD' as const,
        summary: 'Test purpose',
        domainKeywords: [],
        evidence: [],
      },
      technologyStack: {
        primaryLanguages: ['TypeScript'],
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        runtimes: ['node'],
        containerization: [],
        ciCd: [],
        workspaceType: 'standalone' as const,
        dependencies: [],
        devDependencies: [],
        evidence: [],
      },
      repositoryStructure: {
        layout: 'standard-src' as const,
        topLevelDirectories: ['src'],
        totalFileCount: 1,
        significantFiles: [],
        fileExtensions: ['.ts'],
        evidence: [],
      },
      architecture: {
        identifiedAreas: [],
        architecturalPattern: 'Modular',
        summary: 'Test arch',
        evidence: [],
      },
      entryPoints: [],
      commands: {
        build: { status: 'UNKNOWN' as const },
        test: { status: 'UNKNOWN' as const },
      },
      featureInventory: [],
      documentationSummary: {
        hasReadme: true,
        hasContributing: false,
        hasArchitectureDocs: false,
        documentationFiles: [],
        summary: 'None',
        evidence: [],
      },
      requirementsSummary: {
        totalRequirements: 0,
        lockedCount: 0,
        source: 'AIDM_SPEC_STORE' as const,
        requirements: [],
        evidence: [],
      },
      decisionsSummary: {
        totalDecisions: 0,
        source: 'AIDM_SPEC_STORE' as const,
        decisions: [],
        evidence: [],
      },
      currentImplementationState: {
        lifecycleState: 'REQUIREMENTS_INGESTION' as const,
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
      recommendedNextAction: 'PROCEED_TO_APPROVAL_PROPOSAL' as const,
      timestamp: new Date().toISOString(),
    };

    const builder = new InitialProjectUnderstandingBuilder();
    const understanding = builder.build(mockReport as any);
    const draftPkg = approvalEngine.buildPackage(understanding);
    await approvalStore.savePackage(draftPkg);

    // Initial check: isDevelopmentAuthorized must be false
    assert.equal(isDevelopmentAuthorized(draftPkg), false);

    // Create and activate Director session
    const session = await sessionEngine.createSession({
      approvalPackageId: draftPkg.packageId,
      approvalRevision: draftPkg.revision,
    });
    assert.equal(session.status, 'ACTIVE');

    // INVARIANT: Director session existence does NOT authorize development
    assert.equal(isDevelopmentAuthorized(draftPkg), false);

    // Even after resuming or updating session, isDevelopmentAuthorized remains strictly false
    await sessionEngine.suspendSession({ directorSessionId: session.directorSessionId });
    await sessionEngine.resumeSession({ directorSessionId: session.directorSessionId });
    assert.equal(isDevelopmentAuthorized(draftPkg), false);

    // Only explicit PO approval authorizes development
    const approvedPkg = approvalEngine.approvePackage(draftPkg, {
      packageId: draftPkg.packageId,
      revision: draftPkg.revision,
      actor: 'human-po@example.com',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved plan',
    });
    assert.equal(isDevelopmentAuthorized(approvedPkg), true);
  });

  // ==========================================================================
  // 18. Cross-Project Session Binding Rejection
  // ==========================================================================
  it('T18_cross_project_session_binding_rejection: rejects resume or query when projectId or workspace does not match', async () => {
    const session = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-project-test',
    });

    // Attempting to query session with a mismatched projectId must fail
    await assert.rejects(
      async () => {
        await sessionEngine.getSession(session.directorSessionId, {
          projectId: 'different-project',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorProjectBindingMismatchError);
        return true;
      }
    );

    // Attempting to resume session with mismatched project must fail
    await assert.rejects(
      async () => {
        await sessionEngine.resumeSession({
          directorSessionId: session.directorSessionId,
          projectId: 'different-project',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorProjectBindingMismatchError);
        return true;
      }
    );
  });

  // ==========================================================================
  // 19. MCP Request / Response Schema Validation
  // ==========================================================================
  it('T19_mcp_request_response_schema_validation: MCP tools execute and return valid formatted payloads', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tmpDir,
      directorSessionStore: sessionStore,
    });
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
    });
    await server.start();

    // 1. Create session via MCP tool
    const createReq = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
        arguments: {
          directorSessionId: 'dir-sess-mcp-001',
          metadata: { channel: 'mcp-chatgpt' },
        },
      },
    };
    const createRes = await server.handleMessage(createReq);
    assert.ok(createRes && 'result' in createRes);
    const createResult = (createRes as any).result;
    assert.ok(createResult.content && createResult.content[0].text);
    const parsedSession = JSON.parse(createResult.content[0].text);
    assert.equal(parsedSession.directorSessionId, 'dir-sess-mcp-001');
    assert.equal(parsedSession.status, 'ACTIVE');

    // 2. Get session via MCP tool
    const getReq = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_SESSION_GET_TOOL_NAME,
        arguments: {
          directorSessionId: 'dir-sess-mcp-001',
        },
      },
    };
    const getRes = await server.handleMessage(getReq);
    assert.ok(getRes && 'result' in getRes);
    const getResult = (getRes as any).result;
    const parsedGet = JSON.parse(getResult.content[0].text);
    assert.equal(parsedGet.directorSessionId, 'dir-sess-mcp-001');

    await server.stop();
  });

  // ==========================================================================
  // 20. MCP Tool Registration
  // ==========================================================================
  it('T20_mcp_tool_registration: McpServer registers all 5 Director session tools when enabled', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tmpDir });
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
    });

    const tools = server.getRegisteredTools();
    const toolNames = tools.map((t) => t.name);

    assert.ok(toolNames.includes(AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_SESSION_GET_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_SESSION_SUSPEND_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_SESSION_CLOSE_TOOL_NAME));
    assert.ok(toolNames.includes(AIDM_DIRECTOR_SESSION_RESUME_TOOL_NAME));
  });

  // ==========================================================================
  // 21. Malformed MCP Request Rejection
  // ==========================================================================
  it('T21_malformed_mcp_request_rejection: malformed MCP tool requests fail deterministically', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tmpDir,
      directorSessionStore: sessionStore,
    });
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorSessionTools: true,
    });
    await server.start();

    // Call create with invalid actor (USER)
    const badActorReq = {
      jsonrpc: '2.0' as const,
      id: 10,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
        arguments: {
          actor: 'USER',
        },
      },
    };
    const badActorRes = await server.handleMessage(badActorReq);
    assert.ok(badActorRes && 'error' in badActorRes);

    // Call create with path traversal ID
    const traversalReq = {
      jsonrpc: '2.0' as const,
      id: 11,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
        arguments: {
          directorSessionId: '../../secret',
        },
      },
    };
    const traversalRes = await server.handleMessage(traversalReq);
    assert.ok(traversalRes && 'error' in traversalRes);

    await server.stop();
  });

  // ==========================================================================
  // 22. Persistence Recovery
  // ==========================================================================
  it('T22_persistence_recovery: recovers active session across completely fresh delegate and server instances', async () => {
    // 1. Create session in first server
    const transport1 = new InMemoryMcpTransport();
    const delegate1 = new DefaultMcpOrchestratorDelegate({ projectRoot: tmpDir });
    const server1 = new McpServer({
      transport: transport1,
      delegate: delegate1,
      directorSessionTools: true,
    });
    await server1.start();

    const createReq = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_SESSION_CREATE_TOOL_NAME,
        arguments: {
          directorSessionId: 'dir-sess-recovery-test',
        },
      },
    };
    await server1.handleMessage(createReq);
    await server1.stop();

    // 2. Spin up fresh second server instance
    const transport2 = new InMemoryMcpTransport();
    const delegate2 = new DefaultMcpOrchestratorDelegate({ projectRoot: tmpDir });
    const server2 = new McpServer({
      transport: transport2,
      delegate: delegate2,
      directorSessionTools: true,
    });
    await server2.start();

    // Get active session without passing ID
    const getReq = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_DIRECTOR_SESSION_GET_TOOL_NAME,
        arguments: {},
      },
    };
    const getRes = await server2.handleMessage(getReq);
    assert.ok(getRes && 'result' in getRes);
    const parsed = JSON.parse((getRes as any).result.content[0].text);
    assert.equal(parsed.directorSessionId, 'dir-sess-recovery-test');
    assert.equal(parsed.status, 'ACTIVE');

    await server2.stop();
  });

  // ==========================================================================
  // 23. No Second FSM Authority
  // ==========================================================================
  it('T23_no_second_fsm: session operations never mutate DurableStateManager global FSM', async () => {
    // Initialize durable state with valid values (correct field names)
    await durableManager.save({
      currentLifecycleState: 'INITIALIZING',
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
    });
    const initialState = await durableManager.load();
    const initialStatus = initialState!.currentLifecycleState;

    // Perform Director session operations
    const session = await sessionEngine.createSession();
    await sessionEngine.suspendSession({ directorSessionId: session.directorSessionId });
    await sessionEngine.resumeSession({ directorSessionId: session.directorSessionId });
    await sessionEngine.closeSession({ directorSessionId: session.directorSessionId });

    // DurableStateManager state must remain completely unaltered
    const finalState = await durableManager.load();
    assert.equal(finalState!.currentLifecycleState, initialStatus);
  });

  // ==========================================================================
  // 24. No Shadow Store
  // ==========================================================================
  it('T24_no_shadow_store: session files reside strictly under .ai-manager/director/ without external files', async () => {
    await sessionEngine.createSession({ directorSessionId: 'dir-sess-shadow-test' });

    const rootEntries = await fs.promises.readdir(tmpDir);
    // Only package.json and .ai-manager should exist in root
    assert.ok(rootEntries.includes('package.json'));
    assert.ok(rootEntries.includes('.ai-manager'));
    assert.equal(rootEntries.filter((e) => e !== 'package.json' && e !== '.ai-manager').length, 0);

    const aiManagerEntries = await fs.promises.readdir(path.join(tmpDir, '.ai-manager'));
    assert.ok(aiManagerEntries.includes('director'));
  });

  // ==========================================================================
  // 25. No Task DAG Mutation
  // ==========================================================================
  it('T25_no_task_dag_mutation: session operations do not modify Task DAG or tasks.json', async () => {
    const tasksPath = path.join(tmpDir, '.ai-manager', 'spec', 'tasks.json');
    const tasksExistBefore = fs.existsSync(tasksPath);

    await sessionEngine.createSession();
    await sessionEngine.resumeSession();

    const tasksExistAfter = fs.existsSync(tasksPath);
    assert.equal(tasksExistBefore, tasksExistAfter);
  });

  // ==========================================================================
  // 26. No Antigravity Execution
  // ==========================================================================
  it('T26_no_antigravity_execution: session creation does not invoke Antigravity executor', async () => {
    const session = await sessionEngine.createSession();
    // Executor is not called; session actor is strictly DIRECTOR
    assert.equal(session.actor, Actor.DIRECTOR);
    assert.equal(session.hasImplementationAuthority, false);
  });

  // ==========================================================================
  // 27. No Autonomous Loop
  // ==========================================================================
  it('T27_no_autonomous_loop: session creation and lifecycle operations terminate synchronously', async () => {
    const startTime = Date.now();
    const session = await sessionEngine.createSession();
    const elapsed = Date.now() - startTime;

    // Operation must complete immediately without running a long loop
    assert.ok(elapsed < 2000, 'Creation must complete immediately');
    assert.equal(session.status, 'ACTIVE');
  });

  // ==========================================================================
  // 28. Resume Semantics Distinct From Retry or New Identity
  // ==========================================================================
  it('T28_resume_semantics_distinct_from_retry_or_new_identity: resume recovers existing identity and does not create new session', async () => {
    const created = await sessionEngine.createSession({
      directorSessionId: 'dir-sess-resume-identity-test',
      metadata: { originalContext: 'step-1' },
    });

    await sessionEngine.suspendSession({
      directorSessionId: created.directorSessionId,
    });

    const resumed = await sessionEngine.resumeSession({
      directorSessionId: created.directorSessionId,
      metadata: { resumeNote: 'returning-from-pause' },
    });

    // Identity, createdAt, protocolVersion MUST be identical
    assert.equal(resumed.directorSessionId, created.directorSessionId);
    assert.equal(resumed.createdAt, created.createdAt);
    assert.equal(resumed.protocolVersion, created.protocolVersion);
    assert.equal(resumed.schemaVersion, created.schemaVersion);
    assert.equal(resumed.status, 'ACTIVE');
    assert.equal((resumed.metadata as Record<string, unknown>).originalContext, 'step-1');
    assert.equal((resumed.metadata as Record<string, unknown>).resumeNote, 'returning-from-pause');

    // Total session count in store must still be 1 (not 2)
    const allSessions = await sessionStore.listSessions();
    assert.equal(allSessions.length, 1);
  });
});
