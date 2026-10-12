/**
 * @file director-closed-loop-multi-task.live.test.ts
 * @description Comprehensive live end-to-end acceptance test suite for Section F:
 *
 * 1. Multi-Task Closed-Loop Auto-Looping with REAL Antigravity CLI:
 *    - Cycle 1: Director selects Task 1 -> AIDM persists & dispatches to real `agy.exe`
 *               -> Real code modified on disk -> Independent evidence verified -> Task 1 ACCEPTED
 *    - Cycle 2: Director automatically inspects updated state -> Selects dependent Task 2
 *               -> Real `agy.exe` modifies code -> Independent evidence verified -> Task 2 ACCEPTED
 *    - Both tasks completed end-to-end with ZERO manual report copying or intervention.
 * 2. Error & Fail-Closed Invariant:
 *    - Independent criteria check failure stops loop fail-closed; does NOT advance blindly.
 * 3. Restart & State Durability:
 *    - Process restart cleanly reloads state; already accepted tasks are NOT re-executed.
 * 4. Human Approval Gate:
 *    - Actions requiring human approval halt safely in BLOCKED_ON_APPROVAL.
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
  type ClosedLoopCycleResult,
  DirectorSessionStore,
  DirectorSessionEngine,
  DirectorDecisionStore,
  ApprovalStore,
  ApprovalPackageEngine,
  HumanApprovalEngine,
  SpecStore,
  HistoryManager,
  DurableStateManager,
  TaskDagEngine,
  SystemExecutionEvidenceStore,
  SystemEvidenceCollector,
  AuthorizationPolicyEngine,
  ProjectMandateStore,
  type ProjectMandate,
  IdentityManager,
  AntigravityAdapter,
  NodeAntigravityProcessRunner,
  resolveAntigravityExecutable,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type TaskDefinition,
  type DirectorSession,
  type ApprovalPackage,
  DirectorContextSynchronizer,
  DefaultGitPort,
} from '../dist/index.js';
import { BudgetManager } from '../dist/budget/budget-manager.js';
import { DirectorRuntime } from '../dist/director/director-runtime.js';
import { DirectorPromptBuilder } from '../dist/director/director-prompt-builder.js';
import type { LLMProvider } from '../dist/llm-bridge/llm-provider.js';
import type { LlmRequest, LlmResponse } from '../dist/llm-bridge/llm-types.js';
import { LlmFinishReason } from '../dist/llm-bridge/llm-types.js';

// Deterministic Closed-Loop Test LLM Provider that reasons over live AIDM snapshots
class ClosedLoopDeterministicLlmProvider implements LLMProvider {
  readonly providerId = 'llm:closed-loop-director';
  readonly providerName = 'closed-loop-director-provider';
  readonly defaultModel = 'director-gpt-6';
  readonly supportedModels = ['director-gpt-6'];
  readonly supportedCapabilities = [] as any;
  isMock = false;

  readonly projectId: string;
  readonly sessionId: string;
  callCount = 0;
  specStore: SpecStore;
  sessionStore: DirectorSessionStore;

  constructor(options: {
    projectId: string;
    sessionId: string;
    specStore: SpecStore;
    sessionStore: DirectorSessionStore;
  }) {
    this.projectId = options.projectId;
    this.sessionId = options.sessionId;
    this.specStore = options.specStore;
    this.sessionStore = options.sessionStore;
  }

  async checkAvailability() {
    return { available: true, model: this.defaultModel };
  }

  async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
    this.callCount++;
    const latestSnapshot = await this.sessionStore.loadLatestSnapshot(this.sessionId);
    const fingerprint = latestSnapshot?.logicalFingerprint ?? 'fp-closed-loop';

    // Inspect tasks in SpecStore
    const tasks = await this.specStore.loadTasks();
    const acceptedTaskIds = new Set(
      tasks.filter((t) => t.status === TaskStatus.ACCEPTED || t.status === 'ACCEPTED').map((t) => t.task_id)
    );

    // Eligible tasks are pending tasks whose dependencies are all accepted
    const pendingTasks = tasks.filter(
      (t) => t.hierarchy_level === 'TASK' && t.status !== TaskStatus.ACCEPTED && t.status !== 'ACCEPTED'
    );
    const eligibleTasks = pendingTasks.filter((t) =>
      t.dependencies.every((depId) => acceptedTaskIds.has(depId))
    );

    let actionPayload: Record<string, unknown>;

    if (eligibleTasks.length === 0) {
      actionPayload = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: `act-${crypto.randomUUID()}`,
        directorSessionId: this.sessionId,
        projectId: this.projectId,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        basedOnContextFingerprint: fingerprint,
        rationale: 'All planned tasks have been completed and verified.',
        confidence: 1.0,
        finalVerificationRequested: true,
        requirementCoverage: [{ requirementId: 'REQ-001', satisfied: true, evidenceIds: [] }],
        unresolvedRisks: [],
        remainingTasks: [],
      };
    } else {
      // Pick first eligible task
      const nextTask = eligibleTasks[0];
      const targetFile = (nextTask.metadata?.targetFiles as string[])?.[0] ?? 'src/output.ts';
      const fileContent = nextTask.task_id === 'TASK-CL-01' ? 'alpha_verified' : 'beta_verified';

      actionPayload = {
        protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
        schemaVersion: 1,
        actionId: `act-${crypto.randomUUID()}`,
        directorSessionId: this.sessionId,
        projectId: this.projectId,
        actionType: 'IMPLEMENT_TASK',
        basedOnContextFingerprint: fingerprint,
        rationale: `Implementing task ${nextTask.task_id} according to specification`,
        confidence: 0.98,
        taskId: nextTask.task_id,
        objective: nextTask.description,
        targetFiles: [targetFile],
        implementationScope: 'src/',
        acceptanceCriteria: nextTask.acceptance_criteria,
        constraints: [`Write file with content containing ${fileContent}`],
      };
    }

    return {
      correlation: { correlation_id: `corr-${Date.now()}`, project_id: this.projectId },
      provider: this.providerId,
      model: this.defaultModel,
      content: JSON.stringify(actionPayload),
      structured_output: actionPayload as TStructured,
      finish_reason: LlmFinishReason.STOP,
      raw_metadata: {},
      error: null,
      usage: {
        reported_input_tokens: 120,
        reported_output_tokens: 80,
        reported_cached_tokens: 0,
        estimated_tokens: 200,
        estimated_cost_usd: 0.001,
        provider_name: this.providerId,
        model: this.defaultModel,
        is_exact_provider_metric: true,
      },
    };
  }
}

describe('Section F: Director–AIDM–Antigravity Multi-Task Closed-Loop Acceptance', () => {
  let tempDir: string;
  let validProjectId: string;
  let validSessionId: string;
  const validRevision = 1;

  async function saveSignedMandate(mandateStore: ProjectMandateStore, identityManager: IdentityManager, mandate: any) {
    const { publicKey, privateKey, identityId } = await identityManager.getOrCreateIdentity();
    const payload = {
      identityId,
      workspaceId: 'ws-cl-test',
      projectId: mandate.projectId,
      instanceId: 'inst-cl',
      actorType: 'PRODUCT_OWNER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      nonce: crypto.randomUUID(),
      publicKeyFingerprint: identityManager.getPublicKeyFingerprint(publicKey),
      authenticationMethod: 'ED25519_DPAPI',
      protocolVersion: 1,
      verified: true,
      authSource: 'TRUSTED_IDE',
    };
    const signature = await identityManager.signPayload(payload, privateKey);
    return await mandateStore.saveMandate(mandate, { ...payload, signature });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-closed-loop-e2e-'));
    validProjectId = path.basename(tempDir).toLowerCase();
    validSessionId = `dir-session-${Date.now()}`;

    // Initialize git repository
    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "ClosedLoop Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "closed-loop@example.com"', { cwd: tempDir, stdio: 'ignore' });

    // Initial project structure
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: validProjectId, version: '1.0.0' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Closed-Loop Acceptance Test Project\n', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      '.ai-manager/\n.gemini/\n.agents/\n*.log\n*.sqlite*\n',
      'utf8'
    );

    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on Windows
    }
  });

  it('completes 2 consecutive tasks in autonomous closed-loop via real agy CLI without manual report copying', async () => {
    const agyResolution = resolveAntigravityExecutable();
    assert.strictEqual(agyResolution.found, true, 'Antigravity CLI (agy.exe) must be available on host');
    assert.ok(agyResolution.executablePath);

    // 1. Initialize AIDM stores
    const specStore = new SpecStore({ baseDir: tempDir });
    const durableStateManager = new DurableStateManager({ baseDir: tempDir });
    const historyManager = new HistoryManager({ baseDir: tempDir });
    const approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    const approvalPackageEngine = new ApprovalPackageEngine({ baseDir: tempDir });
    const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    const decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    const evidenceCollector = new SystemEvidenceCollector({ evidenceStore });
    const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    const identityManager = new IdentityManager({ baseDir: tempDir });
    const policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager });
    const dagEngine = new TaskDagEngine();

    const budgetManager = new BudgetManager({ dbPath: path.join(tempDir, 'budget.sqlite') });
    budgetManager.open();
    budgetManager.createGlobalAccount(100_000_000_000n);
    budgetManager.pricingEngine.registerRate({
      providerId: 'antigravity',
      modelId: 'default',
      serviceTier: 'standard',
      inputRateNum: 100_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 100_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 0n,
      cachedInputRateDen: 1_000_000n,
    });

    // 2. Setup Active Director Session
    const activeSession: DirectorSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      understandingRevision: validRevision,
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };
    await sessionStore.saveSession(activeSession);

    // 3. Setup Project Mandate with PO Authorization
    await saveSignedMandate(mandateStore, identityManager, {
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION'],
      allowedCommandCategories: ['test', 'build', 'lint'],
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
      forbiddenOperations: ['WORKSPACE_ESCAPE'],
      humanApprovalRequiredOperations: ['REPLAN'],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
      policyVersion: 1,
      mandateRevision: 1,
    });

    // 4. Setup Approved ApprovalPackage
    const nowIso = new Date().toISOString();
    const pkgId = `pkg-${validProjectId}`;
    const approvedPackage: ApprovalPackage = {
      packageId: pkgId,
      projectId: validProjectId,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      status: 'APPROVED',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: true,
      approvalRecord: {
        packageId: pkgId,
        revision: validRevision,
        actor: 'PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: nowIso,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Product Owner authorizes task development',
      },
    } as any;
    await approvalStore.savePackage(approvedPackage);

    // Save initial requirements in SpecStore so revision is 1
    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'Closed Loop Services',
        description: 'Implement alpha and beta services',
        authority: 'DIRECTOR',
        status: 'LOCKED',
      } as any,
    ]);

    // 5. Register 2 sequential tasks in SpecStore:
    //    TASK-CL-01: Creates src/service-a.ts with "alpha_verified"
    //    TASK-CL-02: Creates src/service-b.ts with "beta_verified" (depends on TASK-CL-01)
    const task1: TaskDefinition = {
      task_id: 'TASK-CL-01',
      parent_feature_id: 'FEAT-CL-01',
      title: 'Implement Service Alpha',
      description: 'Create src/service-a.ts exporting serviceA with value "alpha_verified"',
      status: TaskStatus.READY,
      priority: TaskPriority.HIGH,
      dependencies: [],
      acceptance_criteria: ['src/service-a.ts must contain "alpha_verified"'],
      tags: ['closed-loop', 'real-exec'],
      traceability_sources: ['REQ-001'],
      assigned_to: 'antigravity',
      estimated_complexity: 'LOW',
      risk_level: RiskLevel.SAFE,
      attempt: 0,
      max_attempts: 1,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: {
        revision: 1,
        targetFiles: ['src/service-a.ts'],
        implementationScope: ['src/service-a.ts'],
        taskClass: 'IMPLEMENTATION',
      },
    };

    const task2: TaskDefinition = {
      task_id: 'TASK-CL-02',
      parent_feature_id: 'FEAT-CL-01',
      title: 'Implement Service Beta',
      description: 'Create src/service-b.ts exporting serviceB with value "beta_verified"',
      status: TaskStatus.READY,
      priority: TaskPriority.HIGH,
      dependencies: ['TASK-CL-01'],
      acceptance_criteria: ['src/service-b.ts must contain "beta_verified"'],
      tags: ['closed-loop', 'real-exec'],
      traceability_sources: ['REQ-002'],
      assigned_to: 'antigravity',
      estimated_complexity: 'LOW',
      risk_level: RiskLevel.SAFE,
      attempt: 0,
      max_attempts: 1,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: {
        revision: 1,
        targetFiles: ['src/service-b.ts'],
        implementationScope: ['src/service-b.ts'],
        taskClass: 'IMPLEMENTATION',
      },
    };

    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-CL-01',
      parent_feature_id: 'ROOT',
      title: 'Feature Closed-Loop Multi-Task',
      description: 'Feature container for closed-loop acceptance tests',
      status: TaskStatus.ACCEPTED,
      priority: TaskPriority.HIGH,
      dependencies: [],
      acceptance_criteria: ['Both services implemented'],
      tags: ['closed-loop'],
      traceability_sources: ['REQ-ROOT'],
      attempt: 0,
      max_attempts: 1,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };

    await specStore.saveTasks([parentFeature, task1, task2]);

    // 6. Setup Real AntigravityAdapter
    const realExecutor = new AntigravityAdapter({
      workspaceRoot: tempDir,
      binaryPath: agyResolution.executablePath!,
      processRunner: new NodeAntigravityProcessRunner(),
      skipCompatibilityProbe: false,
    });

    // 7. Setup DirectorRuntime with deterministic reasoning engine
    const llmProvider = new ClosedLoopDeterministicLlmProvider({
      projectId: validProjectId,
      sessionId: validSessionId,
      specStore,
      sessionStore,
    });
    const promptBuilder = new DirectorPromptBuilder();
    const directorRuntime = new DirectorRuntime({
      llmProvider,
      promptBuilder,
      sessionStore,
      sessionEngine,
    });

    // 8. Setup ClosedLoopCoordinator
    const coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      specStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      durableStateManager,
      historyManager,
      evidenceStore,
      evidenceCollector,
      dagEngine,
      executorPort: realExecutor,
      directorRuntime,
      budgetManager,
      authorizationPolicyEngine: policyEngine,
    });

    // 9. Execute Autonomous Multi-Task Closed-Loop
    const autoLoopResult = await coordinator.coordinateAutoLoop({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Implement all ready tasks in project specification',
      maxCycles: 5,
    });

    // 10. Assert Full Closed-Loop Success
    assert.strictEqual(autoLoopResult.isSuccess, true, `Auto-loop should succeed. Summary: ${autoLoopResult.summary}`);
    assert.strictEqual(
      autoLoopResult.terminalStatus,
      'ALL_TASKS_COMPLETED',
      `Terminal status must be ALL_TASKS_COMPLETED, got ${autoLoopResult.terminalStatus}`
    );
    assert.strictEqual(autoLoopResult.cyclesRun, 2, 'Should execute exactly 2 cycles for 2 tasks');
    assert.deepStrictEqual(
      autoLoopResult.tasksCompleted,
      ['TASK-CL-01', 'TASK-CL-02'],
      'Both tasks must be recorded as completed'
    );

    // 11. Assert On-Disk Real Code Modifications by agy.exe
    const fileAContent = fs.readFileSync(path.join(tempDir, 'src', 'service-a.ts'), 'utf8');
    assert.ok(
      fileAContent.includes('alpha_verified'),
      `src/service-a.ts must contain "alpha_verified", got: ${fileAContent}`
    );

    const fileBContent = fs.readFileSync(path.join(tempDir, 'src', 'service-b.ts'), 'utf8');
    assert.ok(
      fileBContent.includes('beta_verified'),
      `src/service-b.ts must contain "beta_verified", got: ${fileBContent}`
    );

    // 12. Assert Authoritative SpecStore Task States
    const finalTasks = await specStore.loadTasks();
    const finalTask1 = finalTasks.find((t) => t.task_id === 'TASK-CL-01');
    const finalTask2 = finalTasks.find((t) => t.task_id === 'TASK-CL-02');
    assert.strictEqual(finalTask1?.status, TaskStatus.ACCEPTED, 'TASK-CL-01 must be ACCEPTED');
    assert.strictEqual(finalTask2?.status, TaskStatus.ACCEPTED, 'TASK-CL-02 must be ACCEPTED');

    // 13. Assert Independent Evidence in SystemExecutionEvidenceStore
    const evidenceList = await evidenceStore.listAllEvidence();
    assert.ok(evidenceList.length >= 2, 'Must have at least 2 independent evidence records');
    const ev1 = evidenceList.find((e) => e.taskId === 'TASK-CL-01');
    const ev2 = evidenceList.find((e) => e.taskId === 'TASK-CL-02');
    assert.ok(ev1, 'TASK-CL-01 evidence must be recorded');
    assert.ok(ev2, 'TASK-CL-02 evidence must be recorded');
    assert.strictEqual(ev1?.verificationDecision, 'ACCEPT');
    assert.strictEqual(ev2?.verificationDecision, 'ACCEPT');

    // 14. Assert Git State has Real Commits
    const gitLog = child_process.execSync('git log --oneline', { cwd: tempDir, encoding: 'utf8' });
    assert.ok(gitLog.split('\n').length >= 3, 'Git history must reflect initial commit + task commits');
  });

  it('fails closed when acceptance criteria verification fails (Zero Executor Trust)', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    const durableStateManager = new DurableStateManager({ baseDir: tempDir });
    const historyManager = new HistoryManager({ baseDir: tempDir });
    const approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    const approvalPackageEngine = new ApprovalPackageEngine({ baseDir: tempDir });
    const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    const decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    const evidenceCollector = new SystemEvidenceCollector({ evidenceStore });
    const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    const identityManager = new IdentityManager({ baseDir: tempDir });
    const policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager });
    const dagEngine = new TaskDagEngine();

    const activeSession: DirectorSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      understandingRevision: validRevision,
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };
    await sessionStore.saveSession(activeSession);

    await saveSignedMandate(mandateStore, identityManager, {
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION'],
      allowedCommandCategories: ['test', 'build', 'lint'],
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
      forbiddenOperations: ['WORKSPACE_ESCAPE'],
      humanApprovalRequiredOperations: ['REPLAN'],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
      policyVersion: 1,
      mandateRevision: 1,
    });

    const nowIso = new Date().toISOString();
    const pkgId = `pkg-${validProjectId}`;
    const approvedPackage: ApprovalPackage = {
      packageId: pkgId,
      projectId: validProjectId,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      status: 'APPROVED',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: true,
      approvalRecord: {
        packageId: pkgId,
        revision: validRevision,
        actor: 'PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: nowIso,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Product Owner authorizes task development',
      },
    } as any;
    await approvalStore.savePackage(approvedPackage);

    // Create a task with impossible criteria
    const failTask: TaskDefinition = {
      task_id: 'TASK-CL-IMPOSSIBLE',
      parent_feature_id: 'FEAT-CL-01',
      title: 'Impossible Criteria Task',
      description: 'Create file that must satisfy impossible check',
      status: TaskStatus.READY,
      priority: TaskPriority.HIGH,
      dependencies: [],
      acceptance_criteria: ['src/impossible.ts must contain non_existent_token_xyz_999'],
      tags: ['closed-loop'],
      traceability_sources: ['REQ-FAIL'],
      attempt: 0,
      max_attempts: 1,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: {
        revision: 1,
        targetFiles: ['src/impossible.ts'],
        implementationScope: ['src/impossible.ts'],
      },
    };
    await specStore.saveTasks([failTask]);

    // Deterministic provider targeting this task
    const llmProvider = new ClosedLoopDeterministicLlmProvider({
      projectId: validProjectId,
      sessionId: validSessionId,
      specStore,
      sessionStore,
    });
    const directorRuntime = new DirectorRuntime({
      llmProvider,
      promptBuilder: new DirectorPromptBuilder(),
      sessionStore,
      sessionEngine,
    });

    const coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      specStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      durableStateManager,
      historyManager,
      evidenceStore,
      evidenceCollector,
      dagEngine,
      directorRuntime,
      authorizationPolicyEngine: policyEngine,
    });

    const result = await coordinator.coordinateCycle({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      targetTaskId: 'TASK-CL-IMPOSSIBLE',
    });

    // Zero Executor Trust invariant: status must be EXECUTION_FAILED or REJECT
    assert.strictEqual(result.isSuccess, false);
    const updatedTasks = await specStore.loadTasks();
    const updatedFailTask = updatedTasks.find((t) => t.task_id === 'TASK-CL-IMPOSSIBLE');
    assert.notStrictEqual(updatedFailTask?.status, TaskStatus.ACCEPTED, 'Failed task must NOT be ACCEPTED');
  });

  it('halts with BLOCKED_ON_APPROVAL when Product Owner approval is missing', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    const durableStateManager = new DurableStateManager({ baseDir: tempDir });
    const historyManager = new HistoryManager({ baseDir: tempDir });
    const approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    const approvalPackageEngine = new ApprovalPackageEngine({ baseDir: tempDir });
    const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    const decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    const evidenceCollector = new SystemEvidenceCollector({ evidenceStore });

    const activeSession: DirectorSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      understandingRevision: validRevision,
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };
    await sessionStore.saveSession(activeSession);

    // Save package in PENDING (NOT APPROVED)
    const nowIso = new Date().toISOString();
    const draftPackage: ApprovalPackage = {
      packageId: `pkg-${validProjectId}`,
      projectId: validProjectId,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      status: 'PENDING',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: false,
    } as any;
    await approvalStore.savePackage(draftPackage);

    const task: TaskDefinition = {
      task_id: 'TASK-UNAPPROVED',
      parent_feature_id: 'FEAT-01',
      title: 'Unapproved Task',
      description: 'Should not run without PO approval',
      status: TaskStatus.READY,
      priority: TaskPriority.HIGH,
      dependencies: [],
      acceptance_criteria: ['Check'],
      tags: ['unapproved'],
      traceability_sources: ['REQ-UNAPPROVED'],
      attempt: 0,
      max_attempts: 1,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: { revision: 1, targetFiles: ['src/unapproved.ts'] },
    };
    await specStore.saveTasks([task]);

    const llmProvider = new ClosedLoopDeterministicLlmProvider({
      projectId: validProjectId,
      sessionId: validSessionId,
      specStore,
      sessionStore,
    });
    const directorRuntime = new DirectorRuntime({
      llmProvider,
      promptBuilder: new DirectorPromptBuilder(),
      sessionStore,
      sessionEngine,
    });

    const coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      specStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      durableStateManager,
      historyManager,
      evidenceStore,
      evidenceCollector,
      directorRuntime,
    });

    const loopResult = await coordinator.coordinateAutoLoop({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Run unapproved task',
      maxCycles: 2,
    });

    // Invariant: Must halt in BLOCKED_ON_APPROVAL or humanDecisionRequired
    assert.strictEqual(loopResult.isSuccess, false);
    assert.ok(
      loopResult.terminalStatus === 'BLOCKED_ON_APPROVAL' ||
        loopResult.terminalStatus === 'REJECTED_BY_POLICY' ||
        loopResult.humanDecisionRequired === true,
      `Must halt safely without running unapproved task. Got: ${loopResult.terminalStatus}`
    );
  });

  it('resumes safely after restart without re-executing already accepted tasks', async () => {
    const agyResolution = resolveAntigravityExecutable();
    assert.strictEqual(agyResolution.found, true);

    const specStore = new SpecStore({ baseDir: tempDir });
    const durableStateManager = new DurableStateManager({ baseDir: tempDir });
    const historyManager = new HistoryManager({ baseDir: tempDir });
    const approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    const approvalPackageEngine = new ApprovalPackageEngine({ baseDir: tempDir });
    const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
    const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });
    const decisionStore = new DirectorDecisionStore({ sessionStore, historyManager });
    const evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    const evidenceCollector = new SystemEvidenceCollector({ evidenceStore });
    const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
    const identityManager = new IdentityManager({ baseDir: tempDir });
    const policyEngine = new AuthorizationPolicyEngine({ mandateStore, historyManager });
    const dagEngine = new TaskDagEngine();

    const activeSession: DirectorSession = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      understandingRevision: validRevision,
      protocolVersion: 'P9-01',
      schemaVersion: 1,
      actor: 'DIRECTOR',
      actorRole: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };
    await sessionStore.saveSession(activeSession);

    await saveSignedMandate(mandateStore, identityManager, {
      projectId: validProjectId,
      allowedDirectories: ['src/'],
      allowedOperationTypes: ['FILE_READ', 'FILE_CREATE', 'FILE_MODIFY', 'TEST_EXECUTION'],
      allowedCommandCategories: ['test', 'build', 'lint'],
      autoExecutableTaskClasses: ['IMPLEMENTATION'],
      forbiddenOperations: ['WORKSPACE_ESCAPE'],
      humanApprovalRequiredOperations: ['REPLAN'],
      authorizationStartTime: new Date(Date.now() - 3600000).toISOString(),
      authorizationEndTime: new Date(Date.now() + 3600000).toISOString(),
      resourceAndWorkLimits: { maxFileEdits: 50, maxCommands: 50 },
      policyVersion: 1,
      mandateRevision: 1,
    });

    const nowIso = new Date().toISOString();
    const approvedPackage: ApprovalPackage = {
      packageId: `pkg-${validProjectId}`,
      projectId: validProjectId,
      revision: validRevision,
      approvalPackageRevision: validRevision,
      status: 'APPROVED',
      isStale: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      isDevelopmentAuthorized: true,
      approvalRecord: {
        packageId: `pkg-${validProjectId}`,
        revision: validRevision,
        actor: 'PRODUCT_OWNER',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        approvedAt: nowIso,
        packageHash: 'sha256-approved-package-hash',
        comment: 'Product Owner authorizes task development',
      },
    } as any;
    await approvalStore.savePackage(approvedPackage);

    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'Closed Loop Services',
        description: 'Implement alpha and beta services',
        authority: 'DIRECTOR',
        status: 'LOCKED',
      } as any,
    ]);

    // Pre-populate DurableStateManager and SpecStore as if Task 1 was already completed before restart
    await durableStateManager.save({
      durableStateId: `ds-${validProjectId}`,
      projectId: validProjectId,
      currentLifecycleState: 'TASK_LOOP',
      activeTaskId: null,
      completedTaskIds: ['TASK-CL-01'],
      blockedState: null,
      continuationState: 'NONE',
      continuationPolicy: 'AUTONOMOUS' as any,
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: {},
    });

    // Write file for Task 1 on disk
    fs.writeFileSync(path.join(tempDir, 'src', 'service-a.ts'), 'export const serviceA = "alpha_verified";\n', 'utf8');

    const parentFeature: TaskDefinition = {
      task_id: 'FEAT-CL-01',
      parent_feature_id: 'ROOT',
      title: 'Feature Closed-Loop Multi-Task',
      description: 'Feature container for closed-loop acceptance tests',
      status: TaskStatus.ACCEPTED,
      priority: TaskPriority.HIGH,
      dependencies: [],
      acceptance_criteria: ['Both services implemented'],
      tags: ['closed-loop'],
      traceability_sources: ['REQ-ROOT'],
      attempt: 1,
      max_attempts: 1,
      risk_level: RiskLevel.SAFE,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: nowIso,
      hierarchy_level: 'FEATURE',
      metadata: { revision: 1 },
    };

    const task1: TaskDefinition = {
      task_id: 'TASK-CL-01',
      parent_feature_id: 'FEAT-CL-01',
      title: 'Implement Service Alpha',
      description: 'Create src/service-a.ts exporting serviceA with value "alpha_verified"',
      status: TaskStatus.ACCEPTED,
      priority: TaskPriority.HIGH,
      dependencies: [],
      acceptance_criteria: ['src/service-a.ts must contain "alpha_verified"'],
      tags: ['closed-loop', 'real-exec'],
      traceability_sources: ['REQ-001'],
      assigned_to: 'antigravity',
      estimated_complexity: 'LOW',
      risk_level: RiskLevel.SAFE,
      attempt: 1,
      max_attempts: 1,
      created_at: new Date().toISOString(),
      started_at: nowIso,
      completed_at: nowIso,
      hierarchy_level: 'TASK',
      metadata: {
        revision: 1,
        targetFiles: ['src/service-a.ts'],
        implementationScope: ['src/service-a.ts'],
        taskClass: 'IMPLEMENTATION',
      },
    };

    const task2: TaskDefinition = {
      task_id: 'TASK-CL-02',
      parent_feature_id: 'FEAT-CL-01',
      title: 'Implement Service Beta',
      description: 'Create src/service-b.ts exporting serviceB with value "beta_verified"',
      status: TaskStatus.READY,
      priority: TaskPriority.HIGH,
      dependencies: ['TASK-CL-01'],
      acceptance_criteria: ['src/service-b.ts must contain "beta_verified"'],
      tags: ['closed-loop', 'real-exec'],
      traceability_sources: ['REQ-002'],
      assigned_to: 'antigravity',
      estimated_complexity: 'LOW',
      risk_level: RiskLevel.SAFE,
      attempt: 0,
      max_attempts: 1,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: {
        revision: 1,
        targetFiles: ['src/service-b.ts'],
        implementationScope: ['src/service-b.ts'],
        taskClass: 'IMPLEMENTATION',
      },
    };

    await specStore.saveTasks([parentFeature, task1, task2]);

    const realExecutor = new AntigravityAdapter({
      workspaceRoot: tempDir,
      binaryPath: agyResolution.executablePath!,
      processRunner: new NodeAntigravityProcessRunner(),
      skipCompatibilityProbe: false,
    });

    const llmProvider = new ClosedLoopDeterministicLlmProvider({
      projectId: validProjectId,
      sessionId: validSessionId,
      specStore,
      sessionStore,
    });
    const directorRuntime = new DirectorRuntime({
      llmProvider,
      promptBuilder: new DirectorPromptBuilder(),
      sessionStore,
      sessionEngine,
    });

    const coordinator = new ClosedLoopCoordinator({
      workspaceRoot: tempDir,
      specStore,
      sessionStore,
      sessionEngine,
      decisionStore,
      approvalStore,
      approvalPackageEngine,
      durableStateManager,
      historyManager,
      evidenceStore,
      evidenceCollector,
      dagEngine,
      executorPort: realExecutor,
      directorRuntime,
      authorizationPolicyEngine: policyEngine,
    });

    const autoLoopResult = await coordinator.coordinateAutoLoop({
      workspaceRoot: tempDir,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      instruction: 'Resume and implement remaining tasks',
      maxCycles: 3,
    });

    assert.strictEqual(autoLoopResult.isSuccess, true);
    assert.strictEqual(autoLoopResult.terminalStatus, 'ALL_TASKS_COMPLETED');
    // Crucial invariant: only Task 2 was executed, Task 1 was skipped
    assert.strictEqual(autoLoopResult.cyclesRun, 1, 'Must execute only 1 cycle for remaining task');
    assert.deepStrictEqual(autoLoopResult.tasksCompleted, ['TASK-CL-02']);

    const fileBContent = fs.readFileSync(path.join(tempDir, 'src', 'service-b.ts'), 'utf8');
    assert.ok(fileBContent.includes('beta_verified'));
  });
});
