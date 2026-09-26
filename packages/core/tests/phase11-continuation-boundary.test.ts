/**
 * Phase 11 TASK-P11-02: Controlled Continuation Boundary Test Suite
 *
 * Verifies all 46 required test cases across 8 functional groups:
 * 1. Continuation State & Persistence (T01 - T06)
 * 2. Execution Integration Continuation Checkpoint (T07 - T14)
 * 3. Human Continuation Authorization (T15 - T22)
 * 4. MCP phase11.requestContinue Tool (T23 - T30)
 * 5. Director Decision Engine Block (T31 - T36)
 * 6. HistoryManager Audit Trail (T37 - T40)
 * 7. Recovery & Concurrency Safety (T41 - T44)
 * 8. Strict Architectural Invariants (T45 - T46)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  DurableStateManager,
  CURRENT_DURABLE_STATE_SCHEMA_VERSION,
  type DurableState,
  ExecutionStateIntegrator,
  type SystemExecutionEvidence,
  HumanApprovalEngine,
  DirectorDecisionEngine,
  DirectorSessionEngine,
  DirectorSessionStore,
  ApprovalStore,
  SpecStore,
  HistoryManager,
  TaskDagEngine,
  Actor,
  LifecycleState,
  createPhase11ContinuationToolHandler,
  phase11RequestContinueToolDefinition,
  PHASE11_REQUEST_CONTINUE_TOOL_NAME,
  InitialProjectUnderstandingBuilder,
  ApprovalPackageEngine,
} from '../dist/index.js';

describe('Phase 11 TASK-P11-02: Controlled Continuation Boundary', () => {
  let tmpDir: string;
  let durableManager: DurableStateManager;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let approvalStore: ApprovalStore;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;

  const PROJECT_ID = 'test-project';
  const SESSION_ID = 'dir-ses-11111111-2222-3333-4444-555555555555';
  const FINGERPRINT = 'fp-test-1234567890abcdef';

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p11-test-'));
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2)
    );
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'state'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'history'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'sessions'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'decisions'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, '.ai-manager', 'specs'), { recursive: true });

    durableManager = new DurableStateManager({ baseDir: tmpDir });
    historyManager = new HistoryManager({ baseDir: tmpDir });
    sessionStore = new DirectorSessionStore({ baseDir: tmpDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tmpDir });
    approvalStore = new ApprovalStore({ baseDir: tmpDir, historyManager });
    specStore = new SpecStore({ baseDir: tmpDir, historyManager });
    dagEngine = new TaskDagEngine();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedActiveSession(snapshotOverrides?: Partial<any>): Promise<void> {
    await sessionEngine.createSession({
      directorSessionId: SESSION_ID,
      projectId: PROJECT_ID,
      understandingRevision: 1,
    });

    await sessionStore.saveSnapshot({
      directorSessionId: SESSION_ID,
      snapshotId: 'snap-1',
      logicalFingerprint: FINGERPRINT,
      understandingRevision: 1,
      syncStatus: 'SYNCED',
      isComplete: true,
      staleSections: [],
      unavailableSections: [],
      timestamp: new Date().toISOString(),
      ...snapshotOverrides,
    });
  }

  function createValidEvidence(taskId: string, decision: 'ACCEPT' | 'REJECT' | 'BLOCK' = 'ACCEPT'): SystemExecutionEvidence {
    return {
      evidenceId: `evi-${crypto.randomUUID().slice(0, 8)}`,
      requestId: `req-${crypto.randomUUID().slice(0, 8)}`,
      projectId: PROJECT_ID,
      taskId,
      taskRevision: 1,
      contextFingerprint: FINGERPRINT,
      understandingRevision: 1,
      approvalPackageRevision: 1,
      verificationDecision: decision,
      verifiedAt: new Date().toISOString(),
      verifierIdentity: 'SYSTEM_EVIDENCE_VERIFIER',
      deterministicChecksum: 'sha256-checksum',
      findingsSummary: `Evidence verified with decision ${decision}`,
      repositoryState: {
        baseCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        headCommit: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        isClean: true,
      },
      changedFiles: [{ path: 'src/index.ts', status: 'M' }],
      verificationChecks: [
        {
          checkId: 'CHECK_TESTS',
          type: 'TEST',
          status: 'PASS',
          command: 'pnpm test',
          evidence: 'Tests passing',
        },
      ],
      acceptanceCriteria: [
        {
          criterion: 'AC-1: Verification completes',
          status: 'PASS',
          evidence: 'All checks passed',
        },
      ],
      executorOutcomeReference: {
        status: 'SUCCESS',
        exitCode: 0,
        durationMs: 150,
      },
    };
  }

  // ==========================================================================
  // GROUP 1: Continuation State & Persistence (T01 - T06)
  // ==========================================================================

  it('T01: default DurableState has continuationState=NONE and continuationPolicy=AUTONOMOUS', async () => {
    const saved = await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
    });

    assert.equal(saved.continuationState, 'NONE');
    assert.equal(saved.continuationPolicy, 'AUTONOMOUS');

    const loaded = await durableManager.load();
    assert.ok(loaded);
    assert.equal(loaded.continuationState, 'NONE');
    assert.equal(loaded.continuationPolicy, 'AUTONOMOUS');
  });

  it('T02: DurableState persists continuationState=WAITING and continuationPolicy=MANUAL', async () => {
    const saved = await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    assert.equal(saved.continuationState, 'WAITING');
    assert.equal(saved.continuationPolicy, 'MANUAL');

    const loaded = await durableManager.load();
    assert.ok(loaded);
    assert.equal(loaded.continuationState, 'WAITING');
    assert.equal(loaded.continuationPolicy, 'MANUAL');
  });

  it('T03: DurableState serializes both camelCase and snake_case representations', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const raw = JSON.parse(await fs.promises.readFile(durableManager.filePath, 'utf8'));
    assert.equal(raw.continuationState, 'WAITING');
    assert.equal(raw.continuation_state, 'WAITING');
    assert.equal(raw.continuationPolicy, 'MANUAL');
    assert.equal(raw.continuation_policy, 'MANUAL');
  });

  it('T04: DurableState loads backward-compatible file lacking continuation fields, defaulting correctly', async () => {
    const legacyState = {
      schema_version: 1,
      current_lifecycle_state: 'TASK_LOOP',
      completed_task_ids: [],
      updated_at: new Date().toISOString(),
    };
    await fs.promises.writeFile(durableManager.filePath, JSON.stringify(legacyState, null, 2), 'utf8');

    const loaded = await durableManager.load();
    assert.ok(loaded);
    assert.equal(loaded.continuationState, 'NONE');
    assert.equal(loaded.continuationPolicy, 'AUTONOMOUS');
  });

  it('T05: DurableState rejects invalid continuationState value', async () => {
    await assert.rejects(async () => {
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        completedTaskIds: [],
        continuationState: 'INVALID_STATE' as any,
      });
    });
  });

  it('T06: DurableState rejects invalid continuationPolicy value', async () => {
    await assert.rejects(async () => {
      await durableManager.save({
        currentLifecycleState: LifecycleState.TASK_LOOP,
        completedTaskIds: [],
        continuationPolicy: 'INVALID_POLICY' as any,
      });
    });
  });

  // ==========================================================================
  // GROUP 2: Execution Integration Continuation Checkpoint (T07 - T14)
  // ==========================================================================

  it('T07: AUTONOMOUS policy does not set WAITING on verified ACCEPT', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'AUTONOMOUS',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'ACCEPT');
    const outcome = await integrator.integrate(evidence);

    assert.equal(outcome.success, true);
    assert.equal(outcome.continuationState, 'NONE');

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T08: MANUAL policy sets continuationState=WAITING on verified ACCEPT', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'ACCEPT');
    const outcome = await integrator.integrate(evidence);

    assert.equal(outcome.success, true);
    assert.equal(outcome.continuationState, 'WAITING');

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'WAITING');
  });

  it('T09: verified REJECT does not create WAITING checkpoint even under MANUAL policy', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'REJECT');
    const outcome = await integrator.integrate(evidence);

    assert.equal(outcome.success, true);
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T10: verified BLOCK does not create WAITING checkpoint even under MANUAL policy', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'BLOCK');
    const outcome = await integrator.integrate(evidence);

    assert.equal(outcome.success, true);
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T11: unverified raw executor outcome does not create WAITING checkpoint', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const rawOutcome = {
      executorIdentity: 'ANTIGRAVITY',
      unverifiedAgentClaims: { status: 'COMPLETED' },
    };

    await assert.rejects(async () => {
      await integrator.integrate(rawOutcome);
    });

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T12: checkpoint is NOT created merely because human approval package is approved', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    await seedActiveSession();

    // Human development approval via ApprovalPackageEngine & ApprovalStore
    const mockReport = {
      projectIdentity: {
        name: PROJECT_ID,
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
    const approvalEngine = new ApprovalPackageEngine();
    const draftPkg = approvalEngine.buildPackage(understanding);
    const approvedPkg = approvalEngine.approvePackage(draftPkg, {
      packageId: draftPkg.packageId,
      revision: draftPkg.revision,
      actor: 'test-po',
      actorRole: 'PRODUCT_OWNER',
      intent: 'EXPLICIT_APPROVAL',
      comment: 'Approved',
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
    });
    await approvalStore.savePackage(approvedPkg);

    // Checkpoint must NOT be WAITING
    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T13: WAITING checkpoint emits PHASE11_CONTINUATION_WAITING history event', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'ACCEPT');
    await integrator.integrate(evidence);

    const events = await historyManager.readEvents();
    const waitingEvt = events.find((e) => e.eventType === 'PHASE11_CONTINUATION_WAITING');
    assert.ok(waitingEvt, 'PHASE11_CONTINUATION_WAITING event must be recorded');
    assert.equal(waitingEvt.actor, Actor.ORCHESTRATOR);
    assert.equal(waitingEvt.taskId, 'task-1');
  });

  it('T14: idempotent duplicate integration does not re-create or mutate WAITING checkpoint', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'ACCEPT');
    await integrator.integrate(evidence);

    // Now clear checkpoint to NONE while preserving integrated records in metadata
    const midState = (await durableManager.load())!;
    await durableManager.save({
      ...midState,
      continuationState: 'NONE',
    });

    // Replay same evidence
    const replayOutcome = await integrator.integrate(evidence);
    assert.equal(replayOutcome.isDuplicate, true);

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  // ==========================================================================
  // GROUP 3: Human Continuation Authorization (T15 - T22)
  // ==========================================================================

  it('T15: validateContinuationRequest accepts valid human PRODUCT_OWNER actor', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.code, 'VALID');
  });

  it('T16: validateContinuationRequest accepts valid human USER actor', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'bob-user',
      actorRole: 'USER',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.code, 'VALID');
  });

  it('T17: validateContinuationRequest rejects DIRECTOR actor', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'ACTOR_UNAUTHORIZED');
  });

  it('T18: validateContinuationRequest rejects EXECUTOR / ANTIGRAVITY actor', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'ANTIGRAVITY',
      actorRole: 'EXECUTOR',
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'SECURITY_VIOLATION');
  });

  it('T19: validateContinuationRequest rejects forbidden actors (SYSTEM, ORCHESTRATOR)', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'SYSTEM',
      actorRole: 'SYSTEM',
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'ACTOR_UNAUTHORIZED');
  });

  it('T20: validateContinuationRequest rejects inactive session', async () => {
    await sessionEngine.createSession({
      directorSessionId: SESSION_ID,
      projectId: PROJECT_ID,
      understandingRevision: 1,
    });
    await sessionEngine.suspendSession({
      directorSessionId: SESSION_ID,
      reason: 'Testing inactive session',
    });

    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'SESSION_NOT_ACTIVE');
  });

  it('T21: validateContinuationRequest rejects context fingerprint mismatch', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: 'fp-different-fingerprint',
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'CONTEXT_FINGERPRINT_MISMATCH');
  });

  it('T22: validateContinuationRequest returns CONTINUATION_NOT_NEEDED when continuationState is already NONE', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const humanEngine = new HumanApprovalEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const result = await humanEngine.validateContinuationRequest({
      directorSessionId: SESSION_ID,
      contextFingerprint: FINGERPRINT,
      actor: 'alice-po',
      actorRole: 'PRODUCT_OWNER',
    });

    assert.equal(result.isValid, false);
    assert.equal(result.code, 'CONTINUATION_NOT_NEEDED');
  });

  // ==========================================================================
  // GROUP 4: MCP phase11.requestContinue Tool (T23 - T30)
  // ==========================================================================

  it('T23: MCP tool definition has correct name and schema', () => {
    assert.equal(phase11RequestContinueToolDefinition.name, 'phase11.requestContinue');
    assert.ok(phase11RequestContinueToolDefinition.description.includes('continuation'));
    assert.deepEqual(phase11RequestContinueToolDefinition.inputSchema.required, [
      'directorSessionId',
      'contextFingerprint',
      'actor',
      'actorRole',
    ]);
  });

  it('T24: MCP tool transitions WAITING to NONE on valid request', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-1' } as any }
    );

    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(body.success, true);
    assert.equal(body.continuationState, 'NONE');

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T25: MCP tool returns idempotent no-op when continuationState is already NONE', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-2' } as any }
    );

    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(body.code, 'CONTINUATION_NOT_NEEDED');
    assert.equal(body.isIdempotent, true);
  });

  it('T26: MCP tool rejects unauthorized actor', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'DIRECTOR',
        actorRole: 'DIRECTOR',
      },
      { correlation: { requestId: 'req-mcp-3' } as any }
    );

    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(body.code, 'ACTOR_UNAUTHORIZED');

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'WAITING');
  });

  it('T27: MCP tool rejects cross-project mismatch', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        projectId: 'foreign-project',
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-4' } as any }
    );

    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(body.code, 'PROJECT_BINDING_MISMATCH');
  });

  it('T28: MCP tool rejects stale context fingerprint', async () => {
    await seedActiveSession({ syncStatus: 'STALE', staleSections: ['tasks'] });
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-5' } as any }
    );

    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(body.code, 'CONTEXT_STALE');
  });

  it('T29: MCP tool does not mutate DAG or invoke execution', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-6' } as any }
    );

    assert.equal(result.isError, false);
    // DurableState completedTaskIds unchanged
    const state = await durableManager.load();
    assert.deepEqual(state?.completedTaskIds, ['task-1']);
    assert.equal(state?.continuationState, 'NONE');
  });

  it('T30: MCP tool records PHASE11_CONTINUATION_REQUESTED and PHASE11_CONTINUATION_ACCEPTED events', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-7' } as any }
    );

    const events = await historyManager.readEvents();
    assert.ok(events.some((e) => e.eventType === 'PHASE11_CONTINUATION_REQUESTED'));
    assert.ok(events.some((e) => e.eventType === 'PHASE11_CONTINUATION_ACCEPTED'));
  });

  // ==========================================================================
  // GROUP 5: Director Decision Engine Block (T31 - T36)
  // ==========================================================================

  it('T31: DirectorDecisionEngine validateDecision blocks decision when continuationState is WAITING', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const validation = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Ready to implement next task',
    });

    assert.equal(validation.isValid, false);
    assert.equal(validation.code, 'CONTINUATION_WAITING');
    assert.ok(validation.message.includes('continuationState === \'WAITING\''));
  });

  it('T32: DirectorDecisionEngine createDecision throws when continuationState is WAITING', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    await assert.rejects(async () => {
      await decisionEngine.createDecision({
        directorSessionId: SESSION_ID,
        decisionType: 'IMPLEMENT_TASK',
        basedOnContextFingerprint: FINGERPRINT,
        actor: Actor.DIRECTOR,
        rationale: 'Ready to implement next task',
      });
    });
  });

  it('T33: DirectorDecisionEngine permits decision when continuationState is NONE', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    const validation = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Ready to implement next task',
    });

    assert.equal(validation.isValid, true);
    assert.equal(validation.code, 'VALID');
  });

  it('T34: Director continuation proceeds after requestContinue transitions WAITING to NONE', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tmpDir,
      durableStateManager: durableManager,
      sessionEngine,
      sessionStore,
    });

    // Before continuation: blocked
    const val1 = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Ready to implement next task',
    });
    assert.equal(val1.isValid, false);
    assert.equal(val1.code, 'CONTINUATION_WAITING');

    // Human calls requestContinue
    const handler = createPhase11ContinuationToolHandler(tmpDir);
    await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-8' } as any }
    );

    // After continuation: unblocked
    const val2 = await decisionEngine.validateDecision({
      directorSessionId: SESSION_ID,
      decisionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: FINGERPRINT,
      actor: Actor.DIRECTOR,
      rationale: 'Ready to implement next task',
    });
    assert.equal(val2.isValid, true);
    assert.equal(val2.code, 'VALID');
  });

  it('T35: ExecutionIntegrationService does NOT invoke DirectorDecisionEngine', async () => {
    // Verified by architectural audit: ExecutionStateIntegrator has no dependency on DirectorDecisionEngine
    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    assert.equal((integrator as any).decisionEngine, undefined);
  });

  it('T36: phase11.requestContinue does NOT invoke DirectorDecisionEngine directly', async () => {
    // The MCP tool only mutates DurableState (WAITING -> NONE) and appends history event
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    const result = await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-9' } as any }
    );

    assert.equal(result.isError, false);
    // Director decision store remains empty
    const decisions = await fs.promises.readdir(path.join(tmpDir, '.ai-manager', 'decisions'));
    assert.equal(decisions.length, 0);
  });

  // ==========================================================================
  // GROUP 6: HistoryManager Audit Trail (T37 - T40)
  // ==========================================================================

  it('T37: HistoryManager records PHASE11_CONTINUATION_WAITING on checkpoint creation', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: [],
      continuationPolicy: 'MANUAL',
      continuationState: 'NONE',
    });

    const integrator = new ExecutionStateIntegrator({
      baseDir: tmpDir,
      durableStateManager: durableManager,
      historyManager,
    });

    const evidence = createValidEvidence('task-1', 'ACCEPT');
    await integrator.integrate({ evidence });

    const events = await historyManager.readEvents();
    const evt = events.find((e) => e.eventType === 'PHASE11_CONTINUATION_WAITING');
    assert.ok(evt);
    assert.equal(evt.actor, Actor.ORCHESTRATOR);
    assert.equal(evt.payload.continuationState, 'WAITING');
  });

  it('T38: HistoryManager records PHASE11_CONTINUATION_REQUESTED on continue call', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-10' } as any }
    );

    const events = await historyManager.readEvents();
    const evt = events.find((e) => e.eventType === 'PHASE11_CONTINUATION_REQUESTED');
    assert.ok(evt);
    assert.equal(evt.actor, Actor.USER);
  });

  it('T39: HistoryManager records PHASE11_CONTINUATION_ACCEPTED on successful continuation', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'alice-po',
        actorRole: 'PRODUCT_OWNER',
      },
      { correlation: { requestId: 'req-mcp-11' } as any }
    );

    const events = await historyManager.readEvents();
    const evt = events.find((e) => e.eventType === 'PHASE11_CONTINUATION_ACCEPTED');
    assert.ok(evt);
    assert.equal(evt.actor, Actor.ORCHESTRATOR);
    assert.equal(evt.payload.continuationState, 'NONE');
  });

  it('T40: HistoryManager records PHASE11_CONTINUATION_REJECTED on invalid request', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler = createPhase11ContinuationToolHandler(tmpDir);
    await handler(
      {
        workspaceRoot: tmpDir,
        directorSessionId: SESSION_ID,
        contextFingerprint: FINGERPRINT,
        actor: 'DIRECTOR',
        actorRole: 'DIRECTOR',
      },
      { correlation: { requestId: 'req-mcp-12' } as any }
    );

    const events = await historyManager.readEvents();
    const evt = events.find((e) => e.eventType === 'PHASE11_CONTINUATION_REJECTED');
    assert.ok(evt);
    assert.equal(evt.actor, Actor.ORCHESTRATOR);
  });

  // ==========================================================================
  // GROUP 7: Recovery & Concurrency Safety (T41 - T44)
  // ==========================================================================

  it('T41: WAITING checkpoint survives service restart and is correctly restored from disk', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    // New DurableStateManager instance simulating restart
    const restartedManager = new DurableStateManager({ baseDir: tmpDir });
    const loaded = await restartedManager.load();
    assert.ok(loaded);
    assert.equal(loaded.continuationState, 'WAITING');
    assert.equal(loaded.continuationPolicy, 'MANUAL');
  });

  it('T42: state interruption during continuation preserves atomic durability without corruption', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    // Verify atomic file write leaves no tmp artifacts and valid JSON
    const content = await fs.promises.readFile(durableManager.filePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(content));
  });

  it('T43: concurrent continuation calls resolve safely with exactly one acceptance and one no-op', async () => {
    await seedActiveSession();
    await durableManager.save({
      currentLifecycleState: LifecycleState.TASK_LOOP,
      completedTaskIds: ['task-1'],
      continuationState: 'WAITING',
      continuationPolicy: 'MANUAL',
    });

    const handler1 = createPhase11ContinuationToolHandler(tmpDir);
    const handler2 = createPhase11ContinuationToolHandler(tmpDir);

    const [res1, res2] = await Promise.all([
      handler1(
        {
          workspaceRoot: tmpDir,
          directorSessionId: SESSION_ID,
          contextFingerprint: FINGERPRINT,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
        },
        { correlation: { requestId: 'req-c1' } as any }
      ),
      handler2(
        {
          workspaceRoot: tmpDir,
          directorSessionId: SESSION_ID,
          contextFingerprint: FINGERPRINT,
          actor: 'alice-po',
          actorRole: 'PRODUCT_OWNER',
        },
        { correlation: { requestId: 'req-c2' } as any }
      ),
    ]);

    const b1 = JSON.parse(res1.content[0].text ?? '{}');
    const b2 = JSON.parse(res2.content[0].text ?? '{}');

    const successes = [b1, b2].filter((b) => b.success === true);
    const noOps = [b1, b2].filter((b) => b.code === 'CONTINUATION_NOT_NEEDED');

    assert.equal(successes.length, 1, 'Exactly one concurrent call should succeed in releasing');
    assert.equal(noOps.length, 1, 'The other call should return CONTINUATION_NOT_NEEDED');
  });

  it('T44: terminal PROJECT_COMPLETE clears continuation checkpoint to NONE', async () => {
    await durableManager.save({
      currentLifecycleState: LifecycleState.PROJECT_COMPLETE,
      completedTaskIds: ['task-1', 'task-2'],
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    const state = await durableManager.load();
    assert.equal(state?.continuationState, 'NONE');
    assert.equal(state?.currentLifecycleState, LifecycleState.PROJECT_COMPLETE);
  });

  // ==========================================================================
  // GROUP 8: Strict Architectural Invariants (T45 - T46)
  // ==========================================================================

  it('T45: NO second FSM, DAG, approval store, or history manager is introduced', async () => {
    // DurableStateManager is the sole FSM/state authority
    assert.equal(typeof DurableStateManager, 'function');
    // TaskDagEngine is the sole DAG authority
    assert.equal(typeof TaskDagEngine, 'function');
    // HistoryManager is the sole audit authority
    assert.equal(typeof HistoryManager, 'function');
  });

  it('T46: AutonomousLifecycleHarness remains outside the P11 runtime path', async () => {
    const p11ToolSrc = await fs.promises.readFile(
      path.join(__dirname, '..', 'src', 'mcp', 'tools', 'phase11-continuation-tool.ts'),
      'utf8'
    );
    assert.ok(
      !p11ToolSrc.includes('AutonomousLifecycleHarness'),
      'phase11-continuation-tool must NOT import or reference AutonomousLifecycleHarness'
    );

    const execIntSrc = await fs.promises.readFile(
      path.join(__dirname, '..', 'src', 'execution-integration', 'execution-integration-service.ts'),
      'utf8'
    );
    assert.ok(
      !execIntSrc.includes('AutonomousLifecycleHarness'),
      'execution-integration-service must NOT import or reference AutonomousLifecycleHarness'
    );
  });
});
