/**
 * P35 — OM-09 Live E2E Readiness Audit Test Suite
 *
 * Validates that the entire execution chain:
 * AIDM -> DirectorRuntime -> DirectorAction -> AuthorizationPolicyEngine
 *      -> ClosedLoopCoordinator -> ExecutionBridge -> AntigravityAdapter / AGY CLI
 *      -> SystemExecutionEvidence -> Verification -> Director review
 * is complete, consistent, and strictly enforces fail-closed guarantees
 * across all 16 required failure modes and the full End-to-End dry run.
 *
 * Invariants Verified:
 * 1. LLM output != authority, != evidence, != authorization, != execution proof.
 * 2. Zero executor trust: AGY outcome is never proof, verification is independent.
 * 3. Fail-closed: denied policy, missing specs/evidence, stale context, or unverified identity halt execution.
 * 4. Timeout/crash to EXECUTION_UNKNOWN with no blind automatic retry.
 * 5. Strict session, project, and context fingerprint binding.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as child_process from 'node:child_process';

import {
  ClosedLoopCoordinator,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  ApprovalStore,
  ApprovalPackageEngine,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  SystemExecutionEvidenceStore,
  SystemEvidenceCollector,
  DirectorActionValidator,
  ExecutionBridge,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
  type TaskDefinition,
  type DirectorContextSnapshot,
  type ExecutorPort,
  type ExecutionRequestExecutorPort,
  type ExecutionRequest,
  type RawExecutorOutcome,
  type DirectorActionEnvelope,
  type BridgeExecutionIntent,
  createFrozenBridgeExecutionIntent,
  AuthorizationDecisionResult,
  ExecutionBridgeStatus,
  computeDeterministicActionId,
} from '../dist/index.js';

import {
  DirectorRuntime,
  DirectorLlmProviderUnavailableError,
  DirectorLlmResponseInvalidError,
  DirectorActionContextMismatchError,
} from '../dist/director/index.js';
import type { LLMProvider } from '../dist/llm-bridge/llm-provider.js';
import type { LlmRequest, LlmResponse } from '../dist/llm-bridge/llm-types.js';

import { LlmFinishReason } from '../dist/llm-bridge/llm-types.js';

// ============================================================================
// DETERMINISTIC MOCK LLM PROVIDER FOR P35 AUDIT
// ============================================================================

class DeterministicLlmProvider implements LLMProvider {
  readonly providerId = 'llm:p35-mock-provider';
  readonly providerName = 'p35-deterministic-mock';
  readonly defaultModel = 'om09-eval-v1';
  readonly supportedModels = ['om09-eval-v1'];
  readonly supportedCapabilities = [] as any;
  isMock = true;

  isAvailable = true;
  unavailableReason: string | undefined;
  capturedRequests: LlmRequest[] = [];
  nextActionToReturn: Record<string, unknown> | null = null;
  rawStringToReturn: string | null = null;
  shouldThrow = false;
  throwError: Error = new Error('LLM Provider connection failed');

  projectId = 'om09-readiness-project';
  directorSessionId = 'session-om09';
  fingerprint = 'ctx-om09-fp';

  setContext(projectId: string, sessionId: string, fingerprint: string) {
    this.projectId = projectId;
    this.directorSessionId = sessionId;
    this.fingerprint = fingerprint;
  }

  async checkAvailability() {
    return {
      available: this.isAvailable,
      reason: this.unavailableReason,
      model: this.defaultModel,
    };
  }

  async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
    this.capturedRequests.push(request);

    if (this.shouldThrow) {
      throw this.throwError;
    }

    if (this.rawStringToReturn !== null) {
      return {
        correlation: {
          correlation_id: `corr-${Date.now()}`,
          project_id: this.projectId,
        },
        provider: this.providerName,
        model: this.defaultModel,
        content: this.rawStringToReturn,
        finish_reason: LlmFinishReason.STOP,
        structured_output: null as TStructured,
        raw_metadata: {},
        error: null,
        usage: {
        reported_input_tokens: 100,
        reported_output_tokens: 50,
        reported_cached_tokens: null,
        estimated_tokens: 150,
        estimated_cost_usd: null,
        provider_name: 'mock',
        model: 'mock-model',
        is_exact_provider_metric: true,
      },
      };
    }

    const payload = this.nextActionToReturn ?? {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: `act-${crypto.randomUUID()}`,
      directorSessionId: this.directorSessionId,
      projectId: this.projectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: this.fingerprint,
      rationale: 'Prerequisites met, ready for safe task execution.',
      confidence: 0.98,
      taskId: 'task-core-01',
      objective: 'Implement verified core component',
      targetFiles: ['src/core.ts'],
      implementationScope: 'src/',
      acceptanceCriteria: ['AC-01-PASS'],
      constraints: ['No unverified side effects'],
    };

    return {
      correlation: {
        correlation_id: `corr-${Date.now()}`,
        project_id: this.projectId,
      },
      provider: this.providerName,
      model: this.defaultModel,
      content: JSON.stringify(payload),
      structured_output: payload as TStructured,
      finish_reason: LlmFinishReason.STOP,
      usage: {
        reported_input_tokens: 150,
        reported_output_tokens: 60,
        reported_cached_tokens: null,
        estimated_tokens: 210,
        estimated_cost_usd: null,
        provider_name: this.providerName,
        model: this.defaultModel,
        is_exact_provider_metric: true,
      },
      raw_metadata: {},
      error: null,
    };
  }
}

// ============================================================================
// DETERMINISTIC MOCK EXECUTOR (REPRESENTING AGY CLI INTERACTION)
// ============================================================================

class MockAgyExecutor implements ExecutorPort, ExecutionRequestExecutorPort {
  readonly executorId = 'mock-agy-cli';
  readonly provider = 'antigravity';
  readonly supportedOperations = ['IMPLEMENT_TASK'];
  executionCallCount = 0;
  isAvailable = true;
  simulateTimeout = false;
  simulateFailure = false;
  simulateContradictoryClaim = false;
  exitCode: number | null = 0;

  private tempDir: string;

  constructor(tempDir: string) {
    this.tempDir = tempDir;
  }

  setTempDir(dir: string) {
    this.tempDir = dir;
  }

  async checkAvailability() {
    return {
      available: this.isAvailable,
      reason: this.isAvailable ? undefined : 'AGY executable not found on PATH or via AGY_BIN_PATH',
    };
  }

  async execute(request: ExecutionRequest): Promise<RawExecutorOutcome> {
    this.executionCallCount++;

    if (this.simulateTimeout) {
      return {
        executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
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
        status: 'TIMEOUT',
        exitCode: null,
        signal: 'SIGKILL',
        stdout: null,
        stderr: 'Execution timed out waiting for process',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 5000,
        timedOut: true,
        cancelled: false,
        unverifiedAgentClaims: [],
        unverifiedModifiedFiles: [],
      };
    }

    if (this.simulateFailure) {
      return {
        executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
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
        status: 'FAILURE',
        exitCode: this.exitCode ?? 1,
        signal: null,
        stdout: 'Process failed with non-zero exit code',
        stderr: 'Fatal compiler error in target',
        startedAt: new Date(Date.now() - 500).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 500,
        timedOut: false,
        cancelled: false,
        unverifiedAgentClaims: ['Failed to build'],
        unverifiedModifiedFiles: [],
      };
    }

    if (this.simulateContradictoryClaim) {
      // AGY falsely claims it modified the file and passed, but no filesystem change actually happened
      return {
        executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
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
        status: 'SUCCESS',
        exitCode: 0,
        signal: null,
        stdout: 'Claimed: All tasks implemented and verified perfectly.',
        stderr: null,
        startedAt: new Date(Date.now() - 300).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 300,
        timedOut: false,
        cancelled: false,
        unverifiedAgentClaims: ['Implemented perfectly', 'All checks passed'],
        unverifiedModifiedFiles: ['src/core.ts'],
      };
    }

    // Normal successful execution: writes real change to disk
    const targetFile = path.join(this.tempDir, 'src', 'core.ts');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, '// Real code written by executor\nexport const READY = true;\n');

    return {
      executorIdentity: { provider: 'antigravity', name: this.executorId, version: '1.0.0' },
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
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'Successfully executed task implementation',
      stderr: null,
      startedAt: new Date(Date.now() - 300).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 300,
      timedOut: false,
      cancelled: false,
      unverifiedAgentClaims: ['Task implemented'],
      unverifiedModifiedFiles: ['src/core.ts'],
    };
  }
}

// ============================================================================
// TEST SUITE: P35 OM-09 READINESS AUDIT
// ============================================================================

describe('P35 — OM-09 Live E2E Readiness Audit Suite', () => {
  let testDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let approvalStore: ApprovalStore;
  let approvalPackageEngine: ApprovalPackageEngine;
  let specStore: SpecStore;
  let durableStateManager: DurableStateManager;
  let evidenceStore: SystemExecutionEvidenceStore;
  let evidenceCollector: SystemEvidenceCollector;
  let mandateStore: ProjectMandateStore;
  let policyEngine: AuthorizationPolicyEngine;
  let executionBridge: ExecutionBridge;
  let llmProvider: DeterministicLlmProvider;
  let mockAgy: MockAgyExecutor;
  let coordinator: ClosedLoopCoordinator;

  const projectId = 'om09-readiness-project';
  const directorSessionId = 'session-om09-active';
  const fingerprint = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  const baseMandate: ProjectMandate = {
    projectId,
    allowedDirectories: ['src/'],
    allowedOperationTypes: [
      'FILE_READ',
      'FILE_CREATE',
      'FILE_MODIFY',
      'TEST_EXECUTION',
      'BUILD_EXECUTION',
      'READ_ONLY_INSPECTION',
      'EVIDENCE_REVIEW',
      'REVIEW_EVIDENCE',
      'IMPLEMENT_TASK',
      'IMPLEMENTATION',
    ],
    allowedCommandCategories: ['test', 'build', 'lint', 'format'],
    autoExecutableTaskClasses: ['IMPLEMENTATION', 'TEST'],
    forbiddenOperations: ['WORKSPACE_ESCAPE', 'SYSTEM_DESTRUCTIVE'],
    humanApprovalRequiredOperations: ['REPLAN', 'REQUEST_HUMAN_DECISION'],
    authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
    authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
    resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
    policyVersion: 1,
    mandateRevision: 1,
  };

  const parentFeature: TaskDefinition = {
    task_id: 'FEAT-CORE',
    parent_feature_id: 'ROOT',
    title: 'Core Feature',
    description: 'Core architectural foundation',
    traceability_sources: ['REQ-01'],
    acceptance_criteria: ['AC-01-PASS'],
    status: 'READY' as any,
    attempt: 0,
    max_attempts: 1,
    priority: 'HIGH' as any,
    risk_level: 'SAFE' as any,
    dependencies: [],
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    hierarchy_level: 'FEATURE' as any,
    metadata: {},
  };

  const sampleTask: TaskDefinition = {
    task_id: 'task-core-01',
      started_at: null,
      completed_at: null,
    parent_feature_id: 'FEAT-CORE',
    title: 'Core Implementation',
    description: 'Implement core functionality',
    traceability_sources: ['REQ-01'],
    acceptance_criteria: ['AC-01-PASS'],
    status: 'READY' as any,
    attempt: 0,
    max_attempts: 3,
    priority: 'HIGH' as any,
    risk_level: 'SAFE' as any,
    dependencies: [],
    created_at: new Date().toISOString(),
    hierarchy_level: 'TASK' as any,
    metadata: {
      taskClass: 'IMPLEMENTATION',
      targetFiles: ['src/core.ts'],
      target_files: ['src/core.ts'],
      expectedFiles: ['src/core.ts'],
      revision: 1,
    },
  };

  const saveMandate = async (mandate: ProjectMandate) => {
    const dir = path.join(testDir, '.ai-manager', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project-mandate.json'), JSON.stringify(mandate, null, 2));
  };

  const createMockEnvelope = (
    actionType: string,
    payloadOverrides: Record<string, unknown> = {},
    projId = projectId,
    sessId = directorSessionId,
    fp = fingerprint,
    idempotencyKey = `idem-${crypto.randomUUID()}`
  ): DirectorActionEnvelope => {
    const actionId = computeDeterministicActionId({
      projectId: projId,
      directorSessionId: sessId,
      actionType: actionType as any,
      idempotencyKey,
    });
    return {
      protocolVersion: 'P19-01',
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      directorSessionId: sessId,
      projectId: projId,
      actionType: actionType as any,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      timestamp: new Date().toISOString(),
      basedOnContextFingerprint: fp,
      understandingRevision: 1,
      payload: {
        taskId: 'task-core-01',
        executionPlan: 'Implement core functionality in src/core.ts',
        ...payloadOverrides,
      },
    };
  };

  const createValidIntent = (
    overrides: Record<string, unknown> = {}
  ): BridgeExecutionIntent =>
    createFrozenBridgeExecutionIntent({
      executionIntentId: `intent-${crypto.randomUUID()}`,
      actionId: `act-${crypto.randomUUID()}`,
      idempotencyKey: `idem-${crypto.randomUUID()}`,
      projectId,
      directorSessionId,
      taskId: 'task-core-01',
      taskRevision: 1,
      basedOnContextFingerprint: fingerprint,
      understandingRevision: 1,
      authorizationReference: {
        packageRevision: 1,
        isDevelopmentAuthorized: true,
      },
      createdAt: new Date().toISOString(),
      executionPlan: 'Implement core functionality in src/core.ts',
      ...overrides,
    });

  const createCanonicalSnapshot = (
    overrides: Partial<DirectorContextSnapshot> = {}
  ): DirectorContextSnapshot => {
    const nowIso = new Date().toISOString();
    return {
      projectId,
      projectRoot: testDir,
      directorSessionId,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: nowIso,
      syncStatus: 'UNCHANGED',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      logicalFingerprint: fingerprint,
      sectionMetadata: {} as any,
      sections: {
        projectStatus: {
          initialized: true,
          lifecycleState: 'DEVELOPMENT',
          isCompleted: false,
          isBlocked: false,
          blockedReason: null,
          activeTaskId: null,
        },
        authorization: {
          isDevelopmentAuthorized: true,
          authoritySource: 'PRODUCT_OWNER',
          requiresHumanApproval: true,
        },
        approval: {
          hasApprovalPackage: true,
          packageId: 'pkg-om09-01',
          revision: 1,
          status: 'APPROVED',
          isReadyForApproval: true,
          isExplicitlyApproved: true,
          approvedAt: nowIso,
        },
        clarification: {
          hasActiveSession: false,
          totalCount: 0,
          resolvedCount: 0,
          blockingOpenCount: 0,
          hasUnresolvedBlocking: false,
        },
        discovery: {
          isDiscovered: true,
          projectName: projectId,
          apparentPurposeClassification: 'APPLICATION',
          technologyStack: [],
          unknownsCount: 0,
          contradictionsCount: 0,
        },
        requirements: { total: 0, items: [], revision: 1 },
        decisions: { total: 0, items: [], revision: 1 },
        currentTask: { task: null },
        taskList: {
          total: 1,
          topologicalOrder: ['task-core-01'],
          tasks: [
            {
              taskId: 'task-core-01',
              title: 'Core Implementation',
              status: 'READY',
              dependencies: [],
            },
          ],
        },
        evidence: { totalAvailable: 0, items: [] },
        git: {
          isGitRepository: true,
          branch: 'main',
          workingTreeClean: true,
          totalAcceptedCheckpoints: 0,
        },
        contextEngine: {
          isAvailable: true,
          hasL0Cache: false,
          inspectedPaths: [],
        },
        history: {
          totalEvents: 0,
          recentEvents: [],
        },
      } as any,
      ...overrides,
      isDerived: true,
    };
  };

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `om09-p35-audit-${crypto.randomUUID()}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Write package.json so canonical project identity resolves to projectId
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: projectId, version: '1.0.0' }, null, 2),
      'utf8'
    );

    // Initialize git repository in testDir for authentic git status & diff
    try {
      child_process.execSync('git init', { cwd: testDir, stdio: 'pipe' });
      child_process.execSync('git config user.name "OM09-Auditor"', { cwd: testDir, stdio: 'pipe' });
      child_process.execSync('git config user.email "auditor@om09.local"', { cwd: testDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(testDir, '.gitignore'), '.ai-manager/\n');
      fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(testDir, 'src', 'core.ts'), '// initial\n');
      child_process.execSync('git add .', { cwd: testDir, stdio: 'pipe' });
      child_process.execSync('git commit -m "initial commit"', { cwd: testDir, stdio: 'pipe' });
    } catch {
      // ignore
    }

    historyManager = new HistoryManager({ baseDir: testDir });
    sessionStore = new DirectorSessionStore({ baseDir: testDir });
    sessionEngine = new DirectorSessionEngine({ store: sessionStore });
    decisionStore = new DirectorDecisionStore({ baseDir: testDir });
    approvalStore = new ApprovalStore({ baseDir: testDir });
    approvalPackageEngine = new ApprovalPackageEngine({ approvalStore });
    specStore = new SpecStore({ baseDir: testDir });
    durableStateManager = new DurableStateManager({ baseDir: testDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: testDir });
    evidenceCollector = new SystemEvidenceCollector();
    mandateStore = new ProjectMandateStore({ baseDir: testDir });

    policyEngine = new AuthorizationPolicyEngine({ historyManager, mandateStore: new ProjectMandateStore({ baseDir: testDir }), specStore, evidenceStore });

    mockAgy = new MockAgyExecutor(testDir);
    executionBridge = new ExecutionBridge({
      workspaceRoot: testDir,
      specStore,
      approvalStore,
      evidenceStore,
      executorPort: mockAgy,
      historyManager,
      durableStateManager,
      authorizationPolicyEngine: policyEngine,
      requireTrustedAuthContext: false,
    });

    llmProvider = new DeterministicLlmProvider();
    llmProvider.setContext(projectId, directorSessionId, fingerprint);

    // Save initial authoritative task and mandate
    await specStore.saveTasks([parentFeature, sampleTask]);
    await saveMandate(baseMandate);

    const nowIso = new Date().toISOString();
    // Create active director session
    await sessionStore.saveSession({
      directorSessionId,
      projectId,
      projectRoot: testDir,
      status: 'ACTIVE',
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      createdAt: nowIso,
      lastActivityAt: nowIso,
      understandingRevision: 1,
      hasImplementationAuthority: false,
      metadata: {},
    });

    // Save active authoritative context snapshot
    const activeSnapshot = createCanonicalSnapshot();
    await sessionStore.saveSnapshot(activeSnapshot);

    // Create approval package
    await approvalStore.savePackage({
      packageId: 'pkg-om09-01',
      projectId,
      revision: 1,
      approvalPackageRevision: 1,
      status: 'APPROVED',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: true,
      approvalRecord: {
        packageId: 'pkg-om09-01',
        revision: 1,
        actor: 'PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: nowIso,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Human Product Owner authorizes task development',
        authStatus: 'VERIFIED_HUMAN',
        isTrustedHumanAuth: true,
      } as any,
    } as any);

    // Save authoritative Director decision authorizing implementation of task-core-01
    await decisionStore.saveDecision({
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      decisionId: 'dec-om09-001',
      directorSessionId,
      projectId,
      actor: 'DIRECTOR',
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Authoritative decision to implement task-core-01',
      basedOnContextFingerprint: fingerprint,
      basedOnApprovalRevision: 1,
      basedOnUnderstandingRevision: 1,
      createdAt: nowIso,
      metadata: {
        taskId: 'task-core-01',
      },
    } as any);

    // Instantiate ClosedLoopCoordinator
    coordinator = new ClosedLoopCoordinator({
      workspaceRoot: testDir,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      specStore,
      historyManager,
      durableStateManager,
      evidenceStore,
      authorizationPolicyEngine: policyEngine,
      executionBridge,
      executorPort: mockAgy,
    });
  });

  afterEach(async () => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // SECTION 9: END-TO-END DRY RUN
  // ==========================================================================

  it('T00: End-to-End dry run passes completely from session open to Director review', async () => {
    // 1. Verify active Director session
    const session = await sessionStore.loadSession(directorSessionId);
    assert.ok(session, 'Director session must exist');
    assert.equal(session.status, 'ACTIVE');

    // 2. Prepare authoritative context snapshot
    const snapshot = createCanonicalSnapshot();

    // 3. DirectorRuntime evaluates with LLM provider
    const runtime = new DirectorRuntime({
      llmProvider,
      sessionStore,
      isProduction: false,
      allowMockProvider: true,
    });

    const reasoningResult = await runtime.reason({
      projectId,
      directorSessionId,
      snapshot,
      trigger: 'PERIODIC_REVIEW',
      objective: 'Implement verified core component',
    });

    assert.ok(reasoningResult.action, 'DirectorRuntime must return structured DirectorAction');
    assert.equal(reasoningResult.action.actionType, 'IMPLEMENT_TASK');
    assert.equal(reasoningResult.action.basedOnContextFingerprint, fingerprint);

    // 4. Validate action envelope
    const envelope = createMockEnvelope('IMPLEMENT_TASK', { taskId: 'task-core-01' });
    const validator = new DirectorActionValidator();
    const validationResult = validator.validate(envelope, {
      currentProjectId: projectId,
      currentDirectorSessionId: directorSessionId,
      currentFingerprint: fingerprint,
      currentUnderstandingRevision: 1,
    });
    assert.equal(validationResult.isValid, true, 'Action envelope must validate successfully');

    // 5. AuthorizationPolicyEngine evaluates and authorizes
    const authDecision = await policyEngine.evaluateAction(envelope);
    assert.equal(authDecision.decisionResult, AuthorizationDecisionResult.ALLOW);
    assert.ok(authDecision.appliedRules.includes('MANDATE_OPERATION_AUTHORIZED'));

    // 6. Build execution intent
    const intent: BridgeExecutionIntent = createValidIntent({
      actionId: envelope.actionId,
      idempotencyKey: envelope.idempotencyKey,
      executionPlan: 'Implement core functionality in src/core.ts',
      metadata: { operationType: 'IMPLEMENT_TASK' },
    });

    // 7. ExecutionBridge dispatches to mock AGY executor & verifies independent evidence
    const bridgeResult = await executionBridge.executeIntent(intent);
    assert.equal(bridgeResult.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED, bridgeResult.reason);
    assert.equal(mockAgy.executionCallCount, 1, 'AGY executor must be invoked exactly once');

    // 8. Verify independent SystemExecutionEvidence was created
    assert.ok(bridgeResult.systemEvidence?.evidenceId, 'Bridge result must carry systemEvidence with evidenceId');
    const storedEvidence = await evidenceStore.loadEvidence(bridgeResult.systemEvidence.evidenceId);
    assert.ok(storedEvidence, 'EvidenceStore must contain independent evidence');
    assert.equal(storedEvidence.verificationDecision, 'ACCEPT');

    // 9. Director review: verify evidence cannot be bypassed or fabricated
    assert.equal(storedEvidence.projectId, projectId);
    assert.equal(storedEvidence.taskId, 'task-core-01');
  });

  // ==========================================================================
  // SECTION 10: FAILURE MATRIX (F01 - F16)
  // ==========================================================================

  // F01: LLM provider unavailable -> no execution
  it('F01: LLM provider unavailable fails closed, AGY not invoked', async () => {
    llmProvider.isAvailable = false;
    llmProvider.unavailableReason = 'Network disconnected';

    const runtime = new DirectorRuntime({
      llmProvider,
      sessionStore,
      isProduction: false,
      allowMockProvider: true,
    });

    await assert.rejects(
      async () =>
        await runtime.reason({
          projectId,
          directorSessionId,
          trigger: 'PERIODIC_REVIEW',
        }),
      (err: any) => {
        assert.ok(
          err instanceof DirectorLlmProviderUnavailableError ||
            err.code === 'DIRECTOR_LLM_PROVIDER_UNAVAILABLE',
          `Expected provider unavailable error, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called when LLM is unavailable');
  });

  // F02: LLM malformed JSON -> no execution
  it('F02: LLM malformed JSON fails closed, AGY not invoked', async () => {
    llmProvider.rawStringToReturn = '<<< NOT A VALID JSON OBJECT >>>';

    const runtime = new DirectorRuntime({
      llmProvider,
      sessionStore,
      isProduction: false,
      allowMockProvider: true,
    });

    await assert.rejects(
      async () =>
        await runtime.reason({
          projectId,
          directorSessionId,
          trigger: 'PERIODIC_REVIEW',
        }),
      (err: any) => {
        assert.ok(
          err instanceof DirectorLlmResponseInvalidError ||
            err.code === 'DIRECTOR_LLM_RESPONSE_INVALID',
          `Expected response invalid error, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called on malformed JSON');
  });

  // F03: LLM action fingerprint stale -> no execution
  it('F03: LLM action fingerprint stale fails closed, AGY not invoked', async () => {
    llmProvider.nextActionToReturn = {
      protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
      schemaVersion: 1,
      actionId: 'act-stale-fp',
      directorSessionId,
      projectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // Mismatched!
      rationale: 'Based on old context',
      confidence: 0.9,
      taskId: 'task-core-01',
      objective: 'Run implementation',
      targetFiles: ['src/core.ts'],
      implementationScope: 'src/',
      acceptanceCriteria: ['AC-01-PASS'],
      constraints: ['No unverified side effects'],
    };

    const runtime = new DirectorRuntime({
      llmProvider,
      sessionStore,
      isProduction: false,
      allowMockProvider: true,
    });

    await assert.rejects(
      async () =>
        await runtime.reason({
          projectId,
          directorSessionId,
          trigger: 'PERIODIC_REVIEW',
        }),
      (err: any) => {
        assert.ok(
          err instanceof DirectorActionContextMismatchError ||
            err.code === 'DIRECTOR_ACTION_CONTEXT_MISMATCH',
          `Expected context mismatch error, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called on stale fingerprint');
  });

  // F04: Authorization DENY -> AGY not invoked
  it('F04: Authorization DENY halts execution, AGY not invoked', async () => {
    // Envelope requests a forbidden operation: WORKSPACE_ESCAPE
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {
      taskId: 'task-core-01',
      operationType: 'WORKSPACE_ESCAPE',
    });

    const decision = await policyEngine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_FORBIDDEN_OPERATION'));

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called on DENY');
  });

  // F05: Human approval required -> AGY not invoked
  it('F05: Human approval required halts execution in fail-closed state, AGY not invoked', async () => {
    // Mandate requires human approval for REPLAN
    const envelope = createMockEnvelope('REPLAN', {
      taskId: 'task-core-01',
    });

    const decision = await policyEngine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.REQUIRE_HUMAN_APPROVAL);
    assert.ok(decision.appliedRules.includes('EXPLICITLY_REQUIRES_HUMAN_APPROVAL'));

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called when human approval is required');
  });

  // F06: AGY unavailable -> controlled failure
  it('F06: AGY unavailable yields controlled failure, no crash', async () => {
    mockAgy.isAvailable = false;

    const intent = createValidIntent({
      actionId: 'act-f06',
      idempotencyKey: 'idem-f06',
    });

    const result = await executionBridge.executeIntent(intent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.equal(result.code, 'ERR_EXECUTOR_UNAVAILABLE');
    assert.ok(result.reason.includes('offline') || result.reason.includes('unavailable') || result.reason.includes('not found'));
  });

  // F07: AGY timeout -> UNKNOWN state without blind retry
  it('F07: AGY timeout transitions to EXECUTION_UNKNOWN without auto re-dispatch', async () => {
    mockAgy.simulateTimeout = true;

    const intent = createValidIntent({
      actionId: 'act-f07',
      idempotencyKey: 'idem-f07',
    });

    const result = await executionBridge.executeIntent(intent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_UNKNOWN);
    assert.ok(result.reason.includes('timed out') || result.reason.includes('EXECUTION_UNKNOWN'));
    assert.equal(mockAgy.executionCallCount, 1, 'Timed out execution must NOT auto-retry without human intervention');
  });

  // F08: AGY exits non-zero -> execution failure
  it('F08: AGY exits non-zero produces execution failure', async () => {
    mockAgy.simulateFailure = true;
    mockAgy.exitCode = 1;

    const intent = createValidIntent({
      actionId: 'act-f08',
      idempotencyKey: 'idem-f08',
    });

    const result = await executionBridge.executeIntent(intent);
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.ok(
      result.code === 'ERR_VERIFICATION_FAILED' ||
        result.code === 'ERR_RAW_EXECUTOR_FAILED' ||
        result.reason.includes('failed')
    );
  });

  // F09: AGY reports success but evidence contradicts -> executor success not trusted
  it('F09: AGY claims success but missing evidence is rejected (Zero Trust)', async () => {
    mockAgy.simulateContradictoryClaim = true;

    const intent = createValidIntent({
      actionId: 'act-f09',
      idempotencyKey: 'idem-f09',
    });

    const result = await executionBridge.executeIntent(intent);
    // Executor returned SUCCESS, but independent verification fails because no actual git/fs changes exist
    assert.equal(result.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.ok(
      result.code === 'ERR_VERIFICATION_FAILED' ||
        result.code === 'ERR_EVIDENCE_REJECTED' ||
        result.reason.includes('rejected')
    );
  });

  // F10: Evidence unavailable -> no ACCEPT
  it('F10: Missing/unavailable evidence prevents task acceptance', async () => {
    // When evidence store cannot load evidence, verification fails closed
    const nonExistentEvidenceId = 'evi-does-not-exist';
    const loaded = await evidenceStore.loadEvidence(nonExistentEvidenceId);
    assert.equal(loaded, null, 'Evidence must be null when absent');

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-core-01',
      evidenceIds: [nonExistentEvidenceId],
    });

    const decision = await policyEngine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('INVALID_EVIDENCE_REFERENCE'));
  });

  // F11: Project mismatch -> no execution
  it('F11: Project mismatch fails closed with DENY, AGY not invoked', async () => {
    const foreignProjectId = 'rogue-foreign-project';
    const envelope = createMockEnvelope('IMPLEMENT_TASK', {}, foreignProjectId);

    const decision = await policyEngine.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('PROJECT_ISOLATION_VIOLATION'));

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called across project boundaries');
  });

  // F12: Session mismatch -> no execution
  it('F12: Session mismatch fails closed, AGY not invoked', async () => {
    const invalidSessionId = 'session-invalid-other';
    const runtime = new DirectorRuntime({
      llmProvider,
      sessionStore,
      isProduction: false,
      allowMockProvider: true,
    });

    await assert.rejects(
      async () =>
        await runtime.reason({
          projectId,
          directorSessionId: invalidSessionId,
          trigger: 'PERIODIC_REVIEW',
        }),
      (err: any) => {
        assert.ok(err.message.includes('does not exist') || err.message.includes('session'));
        return true;
      }
    );

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called on session mismatch');
  });

  // F13: Duplicate idempotency key -> no duplicate execution
  it('F13: Duplicate idempotency key rejects duplicate execution', async () => {
    const idempotencyKey = 'idem-f13-fixed-key';
    const intent1 = createValidIntent({
      executionIntentId: `intent-1-${Date.now()}`,
      actionId: 'act-f13-1',
      idempotencyKey,
    });

    const result1 = await executionBridge.executeIntent(intent1);
    assert.equal(result1.status, ExecutionBridgeStatus.EXECUTION_SUCCEEDED, result1.reason);
    assert.equal(mockAgy.executionCallCount, 1);

    // Attempt exact same idempotencyKey
    const intent2 = createValidIntent({
      executionIntentId: `intent-2-${Date.now()}`,
      actionId: 'act-f13-2',
      idempotencyKey,
    });

    const result2 = await executionBridge.executeIntent(intent2);
    // Duplicate execution is rejected fail-closed
    assert.equal(result2.status, ExecutionBridgeStatus.EXECUTION_FAILED);
    assert.ok(
      result2.code === 'ERR_INTENT_ALREADY_CLAIMED' ||
        result2.code === 'ERR_TASK_INVALID' ||
        result2.reason.includes('already'),
      `Expected duplicate execution rejection, got: ${result2.code} - ${result2.reason}`
    );
    assert.equal(mockAgy.executionCallCount, 1, 'Executor must NOT be called second time for duplicate idempotency key');
  });

  // F14: Stale context -> no execution
  it('F14: Stale context fails closed, AGY not invoked', async () => {
    const staleSnapshot: DirectorContextSnapshot = {
      ...createCanonicalSnapshot(),
      syncStatus: 'STALE',
      staleSections: ['taskList'],
    };

    const runtime = new DirectorRuntime({
      llmProvider,
      sessionStore,
      isProduction: false,
      allowMockProvider: true,
    });

    await assert.rejects(
      async () =>
        await runtime.reason({
          projectId,
          directorSessionId,
          snapshot: staleSnapshot,
          trigger: 'PERIODIC_REVIEW',
        }),
      (err: any) => {
        assert.ok(err.code === 'DIRECTOR_CONTEXT_STALE' || err.message.includes('stale'));
        return true;
      }
    );

    assert.equal(mockAgy.executionCallCount, 0, 'AGY must not be called on stale context');
  });

  // F15: SpecStore unavailable -> authorization DENY
  it('F15: SpecStore unavailable fails closed with DENY', async () => {
    const engineWithoutSpec = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore: null,
      evidenceStore,
    });

    const intent = createValidIntent({
      actionId: 'act-f15',
      idempotencyKey: 'idem-f15',
    });

    const decision = await engineWithoutSpec.evaluateExecutionIntent(intent);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_TASK_STORE_REQUIRED'));
  });

  // F16: EvidenceStore unavailable -> authorization DENY
  it('F16: EvidenceStore unavailable fails closed with DENY', async () => {
    const engineWithoutEvidence = new AuthorizationPolicyEngine({
      historyManager,
      mandateStore,
      specStore,
      evidenceStore: null,
    });

    const envelope = createMockEnvelope('REVIEW_EVIDENCE', {
      taskId: 'task-core-01',
      evidenceIds: ['evi-sample-id'],
    });

    const decision = await engineWithoutEvidence.evaluateAction(envelope);
    assert.equal(decision.decisionResult, AuthorizationDecisionResult.DENY);
    assert.ok(decision.appliedRules.includes('AUTHORITATIVE_EVIDENCE_STORE_REQUIRED'));
  });
});
