/**
 * Comprehensive Test Suite for Director ↔ Executor Loop (Phase 16)
 *
 * Validates all 20 required architectural and governance requirements:
 * 1. valid Director instruction
 * 2. unauthorized Director instruction rejection
 * 3. stale instruction rejection
 * 4. stale task revision rejection
 * 5. stale approval rejection
 * 6. cross-project rejection
 * 7. scope mismatch rejection
 * 8. duplicate instruction/idempotency
 * 9. controlled execution cycle
 * 10. evidence ingestion
 * 11. raw executor outcome cannot become proof
 * 12. ACCEPT result
 * 13. REJECT result
 * 14. BLOCK result
 * 15. human decision routing
 * 16. inconsistent authoritative state
 * 17. next-instruction boundary
 * 18. no automatic continuation
 * 19. no Product Owner approval bypass
 * 20. recovery/retry/replan integration without duplication
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as child_process from 'node:child_process';

import {
  DirectorLoopEngine,
  DirectorLoopStore,
  DirectorInstructionValidationError,
  DirectorInstructionUnauthorizedError,
  DirectorInstructionStaleError,
  DirectorInstructionRevisionMismatchError,
  DirectorInstructionScopeMismatchError,
  DirectorInstructionProjectMismatchError,
  DirectorInstructionDuplicateError,
  DirectorInstructionStateInconsistencyError,
  type DirectorInstruction,
  type DirectorExecutionCycleResult,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  DirectorDecisionEngine,
  type DirectorSession,
  type DirectorContextSnapshot,
  type DirectorDecision,
  ApprovalStore,
  ApprovalPackageEngine,
  type ApprovalPackage,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  TaskDagEngine,
  type TaskDefinition,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  SystemEvidenceCollector,
  SystemExecutionEvidenceStore,
  type SystemExecutionEvidence,
  ExecutionStateIntegrator,
  RecoveryPolicyEngine,
  RetryAuthorizationService,
  RecoveryStrategy,
  Actor,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  DIRECTOR_INGEST_INSTRUCTION_TOOL_NAME,
  DIRECTOR_EXECUTE_CYCLE_TOOL_NAME,
  DIRECTOR_GET_CYCLE_RESULT_TOOL_NAME,
  DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME,
} from '../dist/index.js';

describe('Phase 16 — Director ↔ Executor Loop', { concurrency: 1 }, () => {
  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let specStore: SpecStore;
  let dagEngine: TaskDagEngine;
  let durableManager: DurableStateManager;
  let evidenceStore: SystemExecutionEvidenceStore;
  let loopStore: DirectorLoopStore;
  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let approvedPackage: ApprovalPackage;
  let implementDecision: DirectorDecision;
  let testTask: TaskDefinition;
  let canonicalProjectId: string;
  const mockUnderstanding = {
    projectId: 'test-project',
    projectName: 'test-project',
    apparentPurpose: { classification: 'UNDERSTOOD' as const, summary: 'Test', domainKeywords: [], evidence: [] },
    targetUsers: [],
    technologyStack: {
      primaryLanguages: ['TypeScript'],
      frameworks: [],
      buildTools: [],
      packageManagers: [],
      runtimes: [],
      containerization: [],
      ciCd: [],
      workspaceType: 'standalone' as const,
      dependencies: [],
      devDependencies: [],
      evidence: [],
    },
    architectureSummary: { summary: 'Modular', architecturalPattern: 'Modular', identifiedAreas: [], evidence: [] },
    existingCapabilities: [],
    confirmedRequirements: [],
    clarifiedRequirements: [],
    unresolvedUnknowns: [],
    unresolvedContradictions: [],
    currentImplementationState: {
      lifecycleState: 'TASK_LOOP' as const,
      hasActiveTask: false,
      isBlocked: false,
      totalTasksInDag: 0,
      completedTasksCount: 0,
      evidence: [],
    },
    constraints: [],
    assumptions: [],
    nonGoals: [],
    proposedDevelopmentScope: [],
    evidenceReferences: [],
    sourceDiscoveryReference: 'disc-ref',
    generatedAt: new Date().toISOString(),
  };

  const mockDevelopmentPlan = {
    objectives: [],
    proposedScope: [],
    proposedFeatureGroups: [],
    dependencies: [],
    constraints: [],
    knownRisks: [],
    unresolvedIssues: [],
    excludedScope: [],
    suggestedImplementationOrder: [],
  };


  // Mock executor port
  class MockExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
    readonly executorId = 'mock-executor';
    readonly provider = 'mock';
    readonly supportedOperations = ['IMPLEMENT_TASK'];
    outcomeToReturn: Partial<RawExecutorOutcome> = {
      status: 'SUCCESS',
      exitCode: 0,
      stdout: 'Simulated executor success',
      stderr: '',
      unverifiedModifiedFiles: ['src/task.ts'],
    };

    async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
      try {
        fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'src/task.ts'), '// implemented\n', 'utf8');
      } catch {
        // ignore
      }

      return {
        executorIdentity: {
          provider: 'mock',
          name: this.executorId,
          version: '1.0.0',
        },
        requestId: request.requestId,
        requestBinding: {
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
        },
        status: this.outcomeToReturn.status ?? 'SUCCESS',
        exitCode: this.outcomeToReturn.exitCode ?? 0,
        signal: null,
        stdout: this.outcomeToReturn.stdout ?? '',
        stderr: this.outcomeToReturn.stderr ?? '',
        durationMs: 150,
        unverifiedAgentClaims: ['implemented feature'],
        unverifiedModifiedFiles: this.outcomeToReturn.unverifiedModifiedFiles ?? ['src/task.ts'],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        timedOut: false,
        cancelled: false,
      };
    }
  }

  let mockExecutor: MockExecutor;

  function createTestApprovedPackage(projectId: string, revision = 1): ApprovalPackage {
    const now = new Date().toISOString();
    return {
      packageId: `pkg-${projectId}-01`,
      revision,
      approvalPackageRevision: revision,
      projectId,
      projectUnderstanding: { ...mockUnderstanding, projectId },
      proposedDevelopmentPlan: mockDevelopmentPlan,
      status: 'APPROVED',
      isStale: false,
      createdAt: now,
      updatedAt: now,
      approvalRecord: {
        packageId: `pkg-${projectId}-01`,
        revision,
        actor: 'human-po-1',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: now,
        packageHash: 'pkg-hash-test-sha256',
        comment: 'Approved by Product Owner',
      },
    };
  }

  function createTestPendingPackage(projectId: string, revision = 2): ApprovalPackage {
    const now = new Date().toISOString();
    return {
      packageId: `pkg-${projectId}-02`,
      revision,
      approvalPackageRevision: revision,
      projectId,
      projectUnderstanding: { ...mockUnderstanding, projectId },
      proposedDevelopmentPlan: mockDevelopmentPlan,
      status: 'PENDING',
      isStale: false,
      createdAt: now,
      updatedAt: now,
      approvalRecord: undefined,
    };
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p16-test-'));

    // Create minimal package.json so canonical project identity resolves cleanly
    canonicalProjectId = path.basename(tempDir).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: canonicalProjectId, version: '1.0.0' }, null, 2),
      'utf8'
    );
    // Ignore internal state directory in git so state files do not register as untracked repo modifications
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      '.ai-manager/\nnode_modules/\n',
      'utf8'
    );

    // Initialize git repository with initial commit so ExecutionRequestBuilder doesn't reject for repository forgery
    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-test@example.com"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git add . && git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });

    historyManager = new HistoryManager({ baseDir: tempDir });
    sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    approvalPackageEngine = new ApprovalPackageEngine();
    specStore = new SpecStore({ baseDir: tempDir });
    dagEngine = new TaskDagEngine();
    durableManager = new DurableStateManager({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    loopStore = new DirectorLoopStore({ baseDir: tempDir, historyManager });
    mockExecutor = new MockExecutor();

    // 1. Initialize DurableState
    await durableManager.save({
      currentLifecycleState: 'TASK_LOOP' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'MANUAL',
    });

    // 2. Create Active Director Session
    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      projectId: canonicalProjectId,
      understandingRevision: 1,
    });

    // 3. Save Context Snapshot
    activeSnapshot = {
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      projectRoot: tempDir,
      synchronizedAt: new Date().toISOString(),
      logicalFingerprint: 'fp-valid-snapshot-sha256',
      isComplete: true,
      syncStatus: 'CHANGED',
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      isDerived: true,
      sections: {
        projectSummary: { fingerprint: 'fp-1', status: 'FRESH' },
      } as any,
      sectionMetadata: {} as any,
      unavailableSections: [],
      staleSections: [],
    };
    await sessionStore.saveSnapshot(activeSnapshot);

    // 4. Create Approved ApprovalPackage with human Product Owner approval
    const approvedPkg = createTestApprovedPackage(canonicalProjectId, 1);
    await approvalStore.savePackage(approvedPkg);
    approvedPackage = approvedPkg;

    // 5. Create IMPLEMENT_TASK Director Decision
    implementDecision = {
      decisionId: 'dec-p16-task-01',
      directorSessionId: activeSession.directorSessionId,
      projectId: canonicalProjectId,
      protocolVersion: 'P9-03',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Implement core task',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      basedOnApprovalRevision: approvedPackage.revision,
      basedOnUnderstandingRevision: activeSession.understandingRevision,
      createdAt: new Date().toISOString(),
      metadata: {},
      hasImplementationAuthority: false,
    };
    await decisionStore.saveDecision(implementDecision);

    // 6. Create Task in SpecStore
    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-01',
      parent_feature_id: 'ROOT',
      title: 'Parent Feature',
      description: 'Parent feature node',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-FEAT-01'],
      status: 'READY' as any,
      attempt: 0,
      max_attempts: 1,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'FEATURE' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { revision: 1 },
    };

    testTask = {
      task_id: 'TASK-P16-01',
      parent_feature_id: 'FEAT-01',
      title: 'Implement Core Feature',
      description: 'Implement core feature logic',
      traceability_sources: ['REQ-01'],
      dependencies: [],
      acceptance_criteria: ['AC-01: Implementation verified'],
      status: 'READY' as any,
      attempt: 1,
      max_attempts: 3,
      priority: 'HIGH' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: {
        revision: 1,
      },
    };
    await specStore.saveTasks([parentFeature, testTask]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createEngine(executor: ExecutorPort = mockExecutor): DirectorLoopEngine {
    return new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: executor,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 1: valid Director instruction
  // --------------------------------------------------------------------------
  it('1. valid Director instruction: ingests, persists, and audits successfully', async () => {
    const engine = createEngine();
    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task core logic',
      targetFiles: ['src/task.ts'],
      implementationScope: ['src/task.ts', 'src/utils.ts'],
      actor: 'DIRECTOR',
    });

    assert.ok(instruction.instructionId.startsWith('inst-'));
    assert.equal(instruction.taskId, testTask.task_id);
    assert.equal(instruction.actor, 'DIRECTOR');

    const stored = await loopStore.getInstruction(instruction.instructionId);
    assert.ok(stored);
    assert.equal(stored.instructionId, instruction.instructionId);

    const events = await historyManager.readEvents();
    assert.ok(events.some((e) => e.eventType === 'DIRECTOR_INSTRUCTION_INGESTED'));
  });

  // --------------------------------------------------------------------------
  // TEST 2: unauthorized Director instruction rejection
  // --------------------------------------------------------------------------
  it('2. unauthorized Director instruction rejection: non-DIRECTOR actor is rejected', async () => {
    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: approvedPackage.revision,
          objective: 'Attempt unauthorized instruction',
          targetFiles: ['src/task.ts'],
          actor: 'EXECUTOR', // Invalid actor!
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionUnauthorizedError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 3: stale instruction rejection
  // --------------------------------------------------------------------------
  it('3. stale instruction rejection: context fingerprint mismatch fails closed', async () => {
    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 1,
          contextFingerprint: 'fp-stale-fingerprint-mismatch', // Stale!
          understandingRevision: 1,
          approvalPackageRevision: approvedPackage.revision,
          objective: 'Implement task',
          targetFiles: ['src/task.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionStaleError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 4: stale task revision rejection
  // --------------------------------------------------------------------------
  it('4. stale task revision rejection: instruction specifying wrong revision is rejected', async () => {
    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 99, // SpecStore task is at revision 1!
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: approvedPackage.revision,
          objective: 'Implement task',
          targetFiles: ['src/task.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionRevisionMismatchError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 5: stale approval rejection
  // --------------------------------------------------------------------------
  it('5. stale approval rejection: instruction specifying wrong approval revision is rejected', async () => {
    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: 999, // Active package is at revision 1!
          objective: 'Implement task',
          targetFiles: ['src/task.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionRevisionMismatchError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 6: cross-project rejection
  // --------------------------------------------------------------------------
  it('6. cross-project rejection: mismatched projectId is strictly rejected', async () => {
    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          projectId: 'alien-project-id-999', // Mismatch!
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: approvedPackage.revision,
          objective: 'Implement task',
          targetFiles: ['src/task.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionProjectMismatchError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 7: scope mismatch rejection
  // --------------------------------------------------------------------------
  it('7. scope mismatch rejection: targetFiles outside implementationScope are rejected', async () => {
    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: approvedPackage.revision,
          objective: 'Implement task',
          targetFiles: ['src/outside-scope.ts'], // Not in implementationScope!
          implementationScope: ['src/task.ts', 'src/utils.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionScopeMismatchError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 8: duplicate instruction/idempotency
  // --------------------------------------------------------------------------
  it('8. duplicate instruction/idempotency: identical re-ingestion succeeds; conflicting throws', async () => {
    const engine = createEngine();
    const input = {
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    };

    const first = await engine.ingestInstruction(input);
    const second = await engine.ingestInstruction(input);
    assert.equal(first.instructionId, second.instructionId);

    // Conflicting instruction with explicit same ID
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          ...input,
          instructionId: first.instructionId,
          objective: 'Conflicting different objective',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionDuplicateError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 9: controlled execution cycle
  // --------------------------------------------------------------------------
  it('9. controlled execution cycle: runs full pipeline through state integration', async () => {
    const engine = createEngine();
    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const cycleResult = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    assert.ok(cycleResult.cycleId.startsWith('cycle-'));
    assert.equal(cycleResult.taskId, testTask.task_id);
    assert.equal(cycleResult.verificationDecision, 'ACCEPT');
    assert.equal(cycleResult.terminalStatus, 'ACCEPTED');
    assert.ok(cycleResult.systemEvidence);
    assert.ok(cycleResult.integrationOutcome);

    // Verify durable state was updated
    const durableState = await durableManager.load();
    assert.ok(durableState?.completedTaskIds.includes(testTask.task_id));
  });

  // --------------------------------------------------------------------------
  // TEST 10: evidence ingestion
  // --------------------------------------------------------------------------
  it('10. evidence ingestion: cycle result is backed by independently verified evidence in evidenceStore', async () => {
    const engine = createEngine();
    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const cycleResult = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    const storedEvidence = await evidenceStore.loadEvidence(cycleResult.systemEvidence.evidenceId);
    assert.ok(storedEvidence);
    assert.equal(storedEvidence.evidenceId, cycleResult.systemEvidence.evidenceId);
    assert.equal(storedEvidence.verificationDecision, 'ACCEPT');
  });

  // --------------------------------------------------------------------------
  // TEST 11: raw executor outcome cannot become proof
  // --------------------------------------------------------------------------
  it('11. raw executor outcome cannot become proof: executor claiming success when checks fail is NOT accepted', async () => {
    // Custom evidence collector that simulates failing verification checks
    class FailingCheckCollector extends SystemEvidenceCollector {
      async collectAndVerify(request: ExecutionRequest, rawOutcome: RawExecutorOutcome): Promise<SystemExecutionEvidence> {
        return {
          evidenceId: `ev-${crypto.randomUUID().slice(0, 16)}`,
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
          verificationDecision: 'REJECT', // Independent check failed!
          repositoryState: {
            baseCommit: 'commit-base',
            headCommit: 'commit-head',
            isClean: false,
          },
          changedFiles: [{ path: 'src/task.ts', status: 'M' }],
          verificationChecks: [
            {
              checkId: 'CHECK_TESTS',
              type: 'TEST',
              status: 'FAIL',
              evidence: 'Tests failed: 1 assertion error',
            },
          ],
          acceptanceCriteria: [
            {
              criterion: 'AC-01',
              criterionId: 'AC-01',
              status: 'FAIL',
              evidence: 'Failed acceptance criteria',
            },
          ],
          executorOutcomeReference: {
            status: rawOutcome.status, // Raw executor claimed 'SUCCESS'
            exitCode: rawOutcome.exitCode,
            durationMs: rawOutcome.durationMs,
          },
                    verifiedAt: new Date().toISOString(),
        };
      }
    }

    const engine = new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: mockExecutor, // Claims SUCCESS
      evidenceCollector: new FailingCheckCollector({ evidenceStore }),
    });

    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const cycleResult = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    // Invariant verification: Executor outcome claimed SUCCESS, but verification decision is REJECT
    assert.equal(cycleResult.rawExecutorOutcome.status, 'SUCCESS');
    assert.equal(cycleResult.verificationDecision, 'REJECT');
    assert.equal(cycleResult.terminalStatus, 'REJECTED');
    assert.equal(cycleResult.isAuthoritativeProof.executorOutcomeIsProof, false);
    assert.equal(cycleResult.isAuthoritativeProof.systemEvidenceIsProof, true);

    // Task must NOT be marked completed in durable state
    const durableState = await durableManager.load();
    assert.ok(!durableState?.completedTaskIds.includes(testTask.task_id));
  });

  // --------------------------------------------------------------------------
  // TEST 12: ACCEPT result
  // --------------------------------------------------------------------------
  it('12. ACCEPT result: successful verification marks terminalStatus ACCEPTED and updates task state', async () => {
    const engine = createEngine();
    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    assert.equal(result.terminalStatus, 'ACCEPTED');
    assert.equal(result.verificationDecision, 'ACCEPT');
    assert.equal(result.integrationOutcome.success, true);
  });

  // --------------------------------------------------------------------------
  // TEST 13: REJECT result
  // --------------------------------------------------------------------------
  it('13. REJECT result: rejected verification leaves task incomplete and emits failure event', async () => {
    class RejectingCollector extends SystemEvidenceCollector {
      async collectAndVerify(request: ExecutionRequest, rawOutcome: RawExecutorOutcome): Promise<SystemExecutionEvidence> {
        return {
          evidenceId: `ev-${crypto.randomUUID().slice(0, 16)}`,
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
          verificationDecision: 'REJECT',
          repositoryState: { baseCommit: 'b', headCommit: 'h', isClean: true },
          changedFiles: [{ path: 'src/task.ts', status: 'M' }],
          verificationChecks: [{ checkId: 'C1', type: 'TEST', status: 'FAIL', evidence: 'Failed' }],
          acceptanceCriteria: [{ criterion: 'AC1', criterionId: 'AC1', status: 'FAIL', evidence: 'Failed' }],
          executorOutcomeReference: { status: 'FAILURE', exitCode: 1, durationMs: 100 },
          failureCategory: 'TEST_FAILURE',
                    verifiedAt: new Date().toISOString(),
        };
      }
    }

    const engine = new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: mockExecutor,
      evidenceCollector: new RejectingCollector({ evidenceStore }),
    });

    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    assert.equal(result.terminalStatus, 'REJECTED');
    const durableState = await durableManager.load();
    assert.ok(!durableState?.completedTaskIds.includes(testTask.task_id));
  });

  // --------------------------------------------------------------------------
  // TEST 14: BLOCK result
  // --------------------------------------------------------------------------
  it('14. BLOCK result: blocked verification records BlockedState in DurableState', async () => {
    class BlockingCollector extends SystemEvidenceCollector {
      async collectAndVerify(request: ExecutionRequest, rawOutcome: RawExecutorOutcome): Promise<SystemExecutionEvidence> {
        return {
          evidenceId: `ev-${crypto.randomUUID().slice(0, 16)}`,
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
          verificationDecision: 'BLOCK',
          repositoryState: { baseCommit: 'b', headCommit: 'h', isClean: true },
          changedFiles: [{ path: 'src/task.ts', status: 'M' }],
          verificationChecks: [{ checkId: 'C1', type: 'COMMAND', status: 'BLOCK', evidence: 'Environment blocked' }],
          acceptanceCriteria: [{ criterion: 'AC1', criterionId: 'AC1', status: 'BLOCK', evidence: 'Blocked' }],
          executorOutcomeReference: { status: 'ERROR', exitCode: 2, durationMs: 100 },
          failureCategory: 'INFRASTRUCTURE_FAILURE',
                    verifiedAt: new Date().toISOString(),
        };
      }
    }

    const engine = new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: mockExecutor,
      evidenceCollector: new BlockingCollector({ evidenceStore }),
    });

    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    assert.equal(result.terminalStatus, 'BLOCKED');
    const durableState = await durableManager.load();
    assert.ok(durableState?.blockedState !== null);
  });

  // --------------------------------------------------------------------------
  // TEST 15: human decision routing
  // --------------------------------------------------------------------------
  it('15. human decision routing: surfaces exact decision point and stops cycle on BLOCK', async () => {
    class BlockingCollector extends SystemEvidenceCollector {
      async collectAndVerify(request: ExecutionRequest, rawOutcome: RawExecutorOutcome): Promise<SystemExecutionEvidence> {
        return {
          evidenceId: `ev-${crypto.randomUUID().slice(0, 16)}`,
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
          verificationDecision: 'BLOCK',
          repositoryState: { baseCommit: 'b', headCommit: 'h', isClean: true },
          changedFiles: [{ path: 'src/task.ts', status: 'M' }],
          verificationChecks: [{ checkId: 'C1', type: 'COMMAND', status: 'BLOCK', evidence: 'Environment blocked' }],
          acceptanceCriteria: [{ criterion: 'AC1', criterionId: 'AC1', status: 'BLOCK', evidence: 'Blocked' }],
          executorOutcomeReference: { status: 'ERROR', exitCode: 2, durationMs: 100 },
          failureCategory: 'INFRASTRUCTURE_FAILURE',
                    verifiedAt: new Date().toISOString(),
        };
      }
    }

    const engine = new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: mockExecutor,
      evidenceCollector: new BlockingCollector({ evidenceStore }),
    });

    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    const nextAction = await engine.evaluateNextAction({
      workspaceRoot: tempDir,
      cycleId: result.cycleId,
    });

    assert.equal(nextAction.actionStatus, 'HUMAN_DECISION_REQUIRED');
    assert.equal(nextAction.humanDecisionRequired, true);
    assert.equal(nextAction.canIssueNextInstruction, false);
    assert.ok(nextAction.humanDecisionPoint);
    assert.ok(nextAction.humanDecisionPoint.decisionId.includes('blocked'));
  });

  // --------------------------------------------------------------------------
  // TEST 16: inconsistent authoritative state
  // --------------------------------------------------------------------------
  it('16. inconsistent authoritative state: task with unmet dependencies fails closed', async () => {
    // Add task with unmet dependency
    const taskWithDep: TaskDefinition = {
      task_id: 'TASK-P16-DEP',
      parent_feature_id: 'FEAT-01',
      title: 'Dependent Task',
      description: 'Needs prerequisite task',
      traceability_sources: ['REQ-01'],
      dependencies: ['TASK-PREREQUISITE-UNMET'],
      acceptance_criteria: ['AC-01'],
      status: 'READY' as any,
      attempt: 1,
      max_attempts: 3,
      priority: 'MEDIUM' as any,
      risk_level: 'SAFE' as any,
      hierarchy_level: 'TASK' as any,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      metadata: { revision: 1 },
    };
    const currentTasks = await specStore.loadTasks();
    await specStore.saveTasks([...currentTasks, taskWithDep]);

    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: taskWithDep.task_id,
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: approvedPackage.revision,
          objective: 'Implement dependent task',
          targetFiles: ['src/dep.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionStateInconsistencyError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 17: next-instruction boundary
  // --------------------------------------------------------------------------
  it('17. next-instruction boundary: enables Director to query next action after ACCEPT', async () => {
    const engine = createEngine();
    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    const nextAction = await engine.evaluateNextAction({
      workspaceRoot: tempDir,
      cycleId: result.cycleId,
    });

    assert.equal(nextAction.actionStatus, 'EXECUTION_ACCEPTED');
    assert.equal(nextAction.taskCompleted, true);
    assert.equal(nextAction.canIssueNextInstruction, true);
  });

  // --------------------------------------------------------------------------
  // TEST 18: no automatic continuation
  // --------------------------------------------------------------------------
  it('18. no automatic continuation: autoContinue is strictly false and policy is CONTROLLED_MANUAL', async () => {
    const engine = createEngine();
    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    const nextAction = await engine.evaluateNextAction({
      workspaceRoot: tempDir,
      cycleId: result.cycleId,
    });

    // Invariant verification: P16 MUST NOT automatically continue
    assert.equal(nextAction.autoContinue, false);
    assert.equal(nextAction.continuationPolicy, 'CONTROLLED_MANUAL');
  });

  // --------------------------------------------------------------------------
  // TEST 19: no Product Owner approval bypass
  // --------------------------------------------------------------------------
  it('19. no Product Owner approval bypass: unapproved package or colloquial agreement fails closed', async () => {
    // Save unapproved package
    const unapprovedPkg = createTestPendingPackage(canonicalProjectId, 2);
    await approvalStore.savePackage(unapprovedPkg); // status: PENDING

    const engine = createEngine();
    await assert.rejects(
      async () => {
        await engine.ingestInstruction({
          workspaceRoot: tempDir,
          directorSessionId: activeSession.directorSessionId,
          directorDecisionId: implementDecision.decisionId,
          taskId: testTask.task_id,
          taskRevision: 1,
          contextFingerprint: activeSnapshot.logicalFingerprint,
          understandingRevision: 1,
          approvalPackageRevision: 2,
          objective: 'Attempt execution without PO approval',
          targetFiles: ['src/task.ts'],
          actor: 'DIRECTOR',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DirectorInstructionUnauthorizedError);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // TEST 20: recovery/retry/replan integration without duplication
  // --------------------------------------------------------------------------
  it('20. recovery/retry/replan integration: evaluated via RecoveryPolicyEngine & RetryAuthorizationService', async () => {
    class RetryableFailureCollector extends SystemEvidenceCollector {
      async collectAndVerify(request: ExecutionRequest, rawOutcome: RawExecutorOutcome): Promise<SystemExecutionEvidence> {
        return {
          evidenceId: `ev-${crypto.randomUUID().slice(0, 16)}`,
          requestId: request.requestId,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRevision: request.taskRevision,
          contextFingerprint: request.contextFingerprint,
          understandingRevision: request.understandingRevision,
          approvalPackageRevision: request.approvalPackageRevision,
          verificationDecision: 'REJECT',
          repositoryState: { baseCommit: 'b', headCommit: 'h', isClean: true },
          changedFiles: [{ path: 'src/task.ts', status: 'M' }],
          verificationChecks: [{ checkId: 'C1', type: 'TEST', status: 'FAIL', evidence: 'Assertion failed' }],
          acceptanceCriteria: [{ criterion: 'AC1', criterionId: 'AC1', status: 'FAIL', evidence: 'Criterion not met' }],
          executorOutcomeReference: { status: 'FAILURE', exitCode: 1, durationMs: 100 },
          failureCategory: 'TEST_FAILURE',
                    verifiedAt: new Date().toISOString(),
        };
      }
    }

    const engine = new DirectorLoopEngine({
      workspaceRoot: tempDir,
      loopStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      dagEngine,
      durableStateManager: durableManager,
      historyManager,
      evidenceStore,
      executorPort: mockExecutor,
      evidenceCollector: new RetryableFailureCollector({ evidenceStore }),
    });

    const instruction = await engine.ingestInstruction({
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    const result = await engine.executeCycle({
      workspaceRoot: tempDir,
      instructionId: instruction.instructionId,
    });

    assert.equal(result.terminalStatus, 'REJECTED');

    const nextAction = await engine.evaluateNextAction({
      workspaceRoot: tempDir,
      cycleId: result.cycleId,
    });

    assert.equal(nextAction.actionStatus, 'EXECUTION_REJECTED');
    assert.ok(nextAction.recoveryRecommendation);
    assert.equal(nextAction.recoveryRecommendation.decision, RecoveryStrategy.RETRY);
    assert.ok(nextAction.retryAuthorization);
    assert.equal(nextAction.canIssueNextInstruction, true);
    assert.equal(nextAction.autoContinue, false);
  });

  // --------------------------------------------------------------------------
  // MCP Boundary Integration
  // --------------------------------------------------------------------------
  it('MCP boundary exposes director loop tools and executes controlled cycles', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
      approvalStore,
      approvalPackageEngine,
      executorPort: mockExecutor,
    });

    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      directorLoopTools: true,
    });

    await server.start();

    // Initialize MCP session
    await server.handleMessage({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    async function callMcpTool(name: string, args: Record<string, unknown>): Promise<any> {
      const req = {
        jsonrpc: '2.0' as const,
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      };
      const res = (await server.handleMessage(req)) as any;
      assert.ok(res?.result?.content?.[0]?.text, `Tool ${name} failed to return text content`);
      return JSON.parse(res.result.content[0].text);
    }

    // 1. Ingest Instruction via MCP
    const ingestPayload = await callMcpTool(DIRECTOR_INGEST_INSTRUCTION_TOOL_NAME, {
      workspaceRoot: tempDir,
      directorSessionId: activeSession.directorSessionId,
      directorDecisionId: implementDecision.decisionId,
      taskId: testTask.task_id,
      taskRevision: 1,
      contextFingerprint: activeSnapshot.logicalFingerprint,
      understandingRevision: 1,
      approvalPackageRevision: approvedPackage.revision,
      objective: 'Implement task via MCP',
      targetFiles: ['src/task.ts'],
      actor: 'DIRECTOR',
    });

    assert.equal(ingestPayload.success, true);
    const instructionId = ingestPayload.instruction.instructionId;

    // 2. Execute Cycle via MCP
    const executePayload = await callMcpTool(DIRECTOR_EXECUTE_CYCLE_TOOL_NAME, {
      workspaceRoot: tempDir,
      instructionId,
    });

    assert.equal(executePayload.success, true);
    assert.equal(executePayload.cycleResult.terminalStatus, 'ACCEPTED');

    // 3. Get Cycle Result via MCP
    const getResultPayload = await callMcpTool(DIRECTOR_GET_CYCLE_RESULT_TOOL_NAME, {
      workspaceRoot: tempDir,
      instructionId,
    });
    assert.equal(getResultPayload.success, true);
    assert.equal(getResultPayload.cycleResult.instructionId, instructionId);

    // 4. Evaluate Next Action via MCP
    const nextActionPayload = await callMcpTool(DIRECTOR_EVALUATE_NEXT_ACTION_TOOL_NAME, {
      workspaceRoot: tempDir,
      instructionId,
    });
    assert.equal(nextActionPayload.success, true);
    assert.equal(nextActionPayload.boundary.actionStatus, 'EXECUTION_ACCEPTED');
    assert.equal(nextActionPayload.boundary.autoContinue, false);

    await server.stop();
  });
});
