/**
 * Phase 14 TASK-P14-04: Execution Failure Handling Test Suite
 *
 * Verifies the production failure-handling boundary for real Antigravity execution:
 *
 * Execution failure
 *         ↓
 * RawExecutorOutcome (untrusted, categorized)
 *         ↓
 * Independent evidence (Git + Scope + Criteria + Infrastructure checks)
 *         ↓
 * SystemExecutionEvidence (authoritative envelope: REJECT / BLOCK)
 *         ↓
 * ExecutionStateIntegrator (REJECT / BLOCK durable integration, NO automatic retry)
 *         ↓
 * P13 Failure Diagnosis & Recovery Policy (RETRY / REPLAN / BLOCK_ON_HUMAN / ABORT)
 *
 * Tests all 20 required coverage areas:
 * 1. non-zero exit
 * 2. timeout
 * 3. cancellation
 * 4. startup failure
 * 5. protocol failure
 * 6. malformed output
 * 7. verification failure
 * 8. infrastructure BLOCK
 * 9. scope rejection
 * 10. forged request rejection
 * 11. stale context rejection
 * 12. Git baseline mismatch
 * 13. persisted failure evidence
 * 14. restart/reload
 * 15. idempotent failure integration
 * 16. duplicate history suppression
 * 17. no automatic retry
 * 18. P13 recovery compatibility
 * 19. no orphan executor process
 * 20. real agy failure-path execution
 * 21. secret sanitization in failure diagnostics
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';

import {
  type ExecutionRequest,
  type RawExecutorOutcome,
  type SystemExecutionEvidence,
  ExecutionFailureCategory,
  AntigravityAdapter,
  NodeAntigravityProcessRunner,
  DefaultGitPort,
  SystemEvidenceCollector,
  ExecutionStateIntegrator,
  SpecStore,
  DurableStateManager,
  HistoryManager,
  SystemExecutionEvidenceStore,
  TaskDagEngine,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type TaskDefinition,
  FailureDiagnosisEngine,
  RecoveryPolicyEngine,
  RecoveryStrategy,
  FailureCategory,
  FailureSeverity,
  assertNotVerifiedEvidence,
  ExecutorSecurityViolationError,
  ExecutionIntegrationBindingMismatchError,
  computeDeterministicRequestId,
} from '../dist/index.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

function createExecutableScript(filePath: string, code: string): string {
  const content = `#!/usr/bin/env node\n${code}\n`;
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

describe('Phase 14 TASK-P14-04: Execution Failure Handling', () => {
  let tempDir: string;
  let scriptsDir: string;
  let specStore: SpecStore;
  let durableStateManager: DurableStateManager;
  let historyManager: HistoryManager;
  let evidenceStore: SystemExecutionEvidenceStore;
  let gitPort: DefaultGitPort;
  let collector: SystemEvidenceCollector;
  let integrator: ExecutionStateIntegrator;
  let recoveryPolicyEngine: RecoveryPolicyEngine;
  let initialCommitSha: string;
  let defaultRequest: ExecutionRequest;
  let defaultTask: TaskDefinition;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p14-04-fail-'));
    scriptsDir = path.join(tempDir, '.scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Initialize git repository
    child_process.execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.name "AIDM Test"', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git config user.email "aidm-test@example.com"', { cwd: tempDir, stdio: 'ignore' });

    // Initial files
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'index.ts'),
      'export const version = "1.0.0";\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-p14-04', version: '1.0.0' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.ai-manager/\n*.log\n.scripts/\n', 'utf8');

    child_process.execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    child_process.execSync('git commit -m "initial commit"', { cwd: tempDir, stdio: 'ignore' });
    initialCommitSha = child_process.execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf8' }).trim();

    // Storage services
    specStore = new SpecStore({ baseDir: tempDir });
    durableStateManager = new DurableStateManager({ baseDir: tempDir });
    historyManager = new HistoryManager({ baseDir: tempDir });
    evidenceStore = new SystemExecutionEvidenceStore({ baseDir: tempDir });
    gitPort = new DefaultGitPort();

    collector = new SystemEvidenceCollector({
      gitPort,
      historyManager,
      evidenceStore,
    });

    integrator = new ExecutionStateIntegrator({
      baseDir: tempDir,
      durableStateManager,
      specStore,
      historyManager,
      evidenceStore,
      expectedProjectId: 'test-project',
      requirePersistedEvidence: true,
    });

    recoveryPolicyEngine = new RecoveryPolicyEngine({
      historyManager,
      expectedProjectId: 'test-project',
    });

    // Create default task in SpecStore
    defaultTask = {
      task_id: 'TASK-P14-04-01',
      parent_feature_id: 'ROOT',
      title: 'Harden failure handling',
      description: 'Implement execution failure handling',
      traceability_sources: ['REQ-001'],
      dependencies: [],
      acceptance_criteria: ['Independent test passing'],
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: 3,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.LOW,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      hierarchy_level: 'TASK',
      metadata: { revision: 1, projectId: 'test-project' },
    };
    await specStore.saveTasks([defaultTask]);

    // Build sample ExecutionRequest
    const requestId = computeDeterministicRequestId({
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      projectId: 'test-project',
      taskId: 'TASK-P14-04-01',
      taskRevision: 1,
      directorSessionId: 'sess-p14-04',
      directorDecisionId: 'dec-p14-04',
      contextFingerprint: 'ctx-fingerprint-04',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'EXECUTE_TEST',
      instruction: {
        objective: 'Execute failure path test',
        acceptanceCriteria: ['Must handle execution failure'],
        constraints: [],
        targetFiles: ['src/index.ts'],
        analysisScope: ['src/index.ts'],
        implementationScope: ['src/index.ts'],
      },
      executionLimits: {
        timeoutMs: 5000,
        maxFileModifications: 5,
      },
      expectedRepositoryState: {
        baseCommit: initialCommitSha,
        isClean: true,
      },
    });

    defaultRequest = Object.freeze({
      requestId,
      protocolVersion: 'P10-02',
      schemaVersion: 1,
      projectId: 'test-project',
      taskId: 'TASK-P14-04-01',
      taskRevision: 1,
      directorSessionId: 'sess-p14-04',
      directorDecisionId: 'dec-p14-04',
      contextFingerprint: 'ctx-fingerprint-04',
      understandingRevision: 1,
      approvalPackageRevision: 1,
      operationType: 'EXECUTE_TEST',
      instruction: {
        objective: 'Execute failure path test',
        acceptanceCriteria: ['Must handle execution failure'],
        constraints: [],
        targetFiles: ['src/index.ts'],
        analysisScope: ['src/index.ts'],
        implementationScope: ['src/index.ts'],
      },
      executionLimits: {
        timeoutMs: 5000,
        maxFileModifications: 5,
      },
      expectedRepositoryState: {
        baseCommit: initialCommitSha,
        isClean: true,
      },
      authorizedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // 1. Non-zero Exit Failure
  // ==========================================================================
  it('1. Non-zero exit produces deterministic EXECUTOR_EXIT_FAILURE, REJECT evidence, and REJECTED status', async () => {
    const scriptPath = path.join(scriptsDir, 'fail-script');
    createExecutableScript(scriptPath, 'console.error("fatal error in executor"); process.exit(1);');

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: scriptPath,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const outcome = await adapter.execute(defaultRequest);

    assert.equal(outcome.status, 'FAILURE');
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE);

    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE);

    const integration = await integrator.integrate(evidence);
    assert.equal(integration.success, true);
    assert.equal(integration.taskStatus, TaskStatus.REJECTED);
    assert.equal(integration.verificationDecision, 'REJECT');

    const durableState = await durableStateManager.load();
    assert.ok(!durableState?.completedTaskIds.includes(defaultTask.task_id));
  });

  // ==========================================================================
  // 2. Timeout Handling
  // ==========================================================================
  it('2. Timeout terminates child process, produces EXECUTOR_TIMEOUT and REJECT evidence', async () => {
    const sleepScript = path.join(scriptsDir, 'sleep-script');
    createExecutableScript(sleepScript, 'setTimeout(() => {}, 5000);');

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: sleepScript,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const timeoutLimits = { ...defaultRequest.executionLimits, timeoutMs: 1000 };
    const timeoutRequestId = computeDeterministicRequestId({
      approvalPackageRevision: defaultRequest.approvalPackageRevision,
      contextFingerprint: defaultRequest.contextFingerprint,
      directorDecisionId: defaultRequest.directorDecisionId,
      directorSessionId: defaultRequest.directorSessionId,
      executionLimits: timeoutLimits,
      expectedRepositoryState: defaultRequest.expectedRepositoryState,
      instruction: defaultRequest.instruction,
      operationType: defaultRequest.operationType,
      projectId: defaultRequest.projectId,
      protocolVersion: defaultRequest.protocolVersion,
      schemaVersion: defaultRequest.schemaVersion,
      taskId: defaultRequest.taskId,
      taskRevision: defaultRequest.taskRevision,
      understandingRevision: defaultRequest.understandingRevision,
    });
    const timeoutRequest: ExecutionRequest = {
      ...defaultRequest,
      requestId: timeoutRequestId,
      executionLimits: timeoutLimits,
    };

    const outcome = await adapter.execute(timeoutRequest);

    assert.equal(outcome.status, 'TIMEOUT');
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_TIMEOUT);

    const evidence = await collector.collectAndVerify(timeoutRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_TIMEOUT);

    const integration = await integrator.integrate(evidence);
    assert.equal(integration.taskStatus, TaskStatus.REJECTED);
  });

  // ==========================================================================
  // 3. Cancellation Handling
  // ==========================================================================
  it('3. Cancellation via AbortSignal terminates execution and produces EXECUTOR_CANCELLED', async () => {
    const hangScript = path.join(scriptsDir, 'hang-script');
    createExecutableScript(hangScript, 'setInterval(() => {}, 1000);');

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: hangScript,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const outcome = await adapter.execute(defaultRequest, {
      signal: controller.signal,
    });

    assert.equal(outcome.status, 'CANCELLED');
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_CANCELLED);

    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_CANCELLED);
  });

  // ==========================================================================
  // 4. Startup Failure
  // ==========================================================================
  it('4. Missing executor binary produces deterministic EXECUTOR_START_FAILURE', async () => {
    const missingExe = path.join(tempDir, 'nonexistent-agy-binary');

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: missingExe,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const outcome = await adapter.execute(defaultRequest);

    assert.equal(outcome.status, 'ERROR');
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_START_FAILURE);

    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_START_FAILURE);
  });

  // ==========================================================================
  // 5. Protocol Failure
  // ==========================================================================
  it('5. Malformed protocol / invalid NDJSON produces EXECUTOR_PROTOCOL_FAILURE', async () => {
    const malformedScript = path.join(scriptsDir, 'malformed-proto');
    createExecutableScript(
      malformedScript,
      'console.log("INVALID NOT JSON"); console.log("{ broken json: ");\n'
    );

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: malformedScript,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const outcome = await adapter.execute(defaultRequest);

    assert.equal(outcome.status, 'ERROR');
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_PROTOCOL_FAILURE);

    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_PROTOCOL_FAILURE);
  });

  // ==========================================================================
  // 6. Malformed Output
  // ==========================================================================
  it('6. Binary or null bytes output produces EXECUTOR_OUTPUT_FAILURE', async () => {
    const binaryScript = path.join(scriptsDir, 'binary-out');
    createExecutableScript(
      binaryScript,
      'process.stdout.write(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));\n'
    );

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: binaryScript,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const outcome = await adapter.execute(defaultRequest);

    assert.equal(outcome.status, 'ERROR');
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_OUTPUT_FAILURE);

    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_OUTPUT_FAILURE);
  });

  // ==========================================================================
  // 7. Verification Failure (Raw SUCCESS overridden by Independent Verification)
  // ==========================================================================
  it('7. Executor reports SUCCESS but independent test fails -> authoritative REJECT and VERIFICATION_FAILURE', async () => {
    // Executor writes changes to greeting file
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const version = "2.0.0";\n', 'utf8');

    // Create a mock raw outcome claiming success
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'All tasks completed successfully according to executor',
      stderr: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: ['I solved everything successfully'],
      unverifiedModifiedFiles: ['src/index.ts'],
    };

    // Independent verification command fails!
    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
      verificationCommands: [
        {
          id: 'CHECK_TEST_SUITE',
          type: 'TEST',
          command: `${process.execPath} -e "process.exit(1)"`,
        },
      ],
    });

    // Authoritative outcome must REJECT with VERIFICATION_FAILURE
    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.VERIFICATION_FAILURE);
    assert.equal(evidence.executorOutcomeReference?.status, 'SUCCESS');
  });

  // ==========================================================================
  // 8. Infrastructure BLOCK
  // ==========================================================================
  it('8. Missing verification tool binary produces INFRASTRUCTURE_BLOCK and BLOCK decision', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'done',
      stderr: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    // Run a verification command targeting a non-existent binary -> exit code 127
    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
      verificationCommands: [
        {
          id: 'CHECK_NONEXISTENT_TOOL',
          type: 'BUILD',
          command: 'nonexistent-tool-binary-xyz --check',
        },
      ],
    });

    assert.equal(evidence.verificationDecision, 'BLOCK');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.INFRASTRUCTURE_BLOCK);

    const integration = await integrator.integrate(evidence);
    assert.equal(integration.taskStatus, TaskStatus.BLOCKED);
    assert.equal(integration.verificationDecision, 'BLOCK');

    const durableState = await durableStateManager.load();
    assert.equal(durableState?.blockedState?.blockedTaskId, defaultTask.task_id);
    assert.ok(!durableState?.completedTaskIds.includes(defaultTask.task_id));
  });

  // ==========================================================================
  // 9. Scope Rejection
  // ==========================================================================
  it('9. Modifying files outside allowed implementationScope produces SECURITY_FAILURE', async () => {
    // Modify an out-of-scope file
    fs.writeFileSync(path.join(tempDir, 'src', 'unauthorized.ts'), 'export const secret = 123;\n', 'utf8');

    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: 'created unauthorized file',
      stderr: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: ['src/unauthorized.ts'],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.SECURITY_FAILURE);
  });

  // ==========================================================================
  // 10. Forged Request Rejection
  // ==========================================================================
  it('10. Raw outcome with forbidden verification fields is rejected by security guard', () => {
    const forgedRawOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'SUCCESS',
      verified: true, // FORBIDDEN!
      qaPassed: true, // FORBIDDEN!
      systemAccepted: true, // FORBIDDEN!
    };

    assert.throws(
      () => assertNotVerifiedEvidence(forgedRawOutcome),
      (err: any) => err instanceof ExecutorSecurityViolationError
    );
  });

  // ==========================================================================
  // 11. Stale Context Rejection
  // ==========================================================================
  it('11. Evidence with stale contextFingerprint is rejected by ExecutionStateIntegrator', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'exit 1',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    // Attempt to integrate with expected binding requiring a different context fingerprint
    await assert.rejects(
      () =>
        integrator.integrate(evidence, {
          expectedBinding: {
            contextFingerprint: 'ctx-fingerprint-DIFFERENT',
          },
        }),
      (err: any) => err instanceof ExecutionIntegrationBindingMismatchError
    );
  });

  // ==========================================================================
  // 12. Git Baseline Mismatch
  // ==========================================================================
  it('12. Git baseline mismatch produces SECURITY_FAILURE and REJECT evidence', async () => {
    // Commit an external change so baseline mismatches
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const v = 2;\n', 'utf8');
    child_process.execSync('git commit -am "external commit"', { cwd: tempDir, stdio: 'ignore' });

    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'SUCCESS',
      exitCode: 0,
      signal: null,
      stdout: null,
      stderr: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.SECURITY_FAILURE);
  });

  // ==========================================================================
  // 13. Persisted Failure Evidence
  // ==========================================================================
  it('13. Failure evidence is persisted to SystemExecutionEvidenceStore and reloaded intact', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 42,
      signal: null,
      stdout: 'some error',
      stderr: 'exit 42',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 75,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    // Reload from evidence store directly
    const loaded = await evidenceStore.loadEvidence(evidence.evidenceId);
    assert.ok(loaded);
    assert.equal(loaded?.evidenceId, evidence.evidenceId);
    assert.equal(loaded?.verificationDecision, 'REJECT');
    assert.equal(loaded?.failureCategory, ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE);
    assert.equal(loaded?.executorOutcomeReference?.exitCode, 42);
  });

  // ==========================================================================
  // 14. Restart / Reload Survival
  // ==========================================================================
  it('14. Fresh instances reload failure state faithfully from disk', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'fail',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });
    await integrator.integrate(evidence);

    // Instantiate new managers pointing to same directory (simulating process restart)
    const freshDurableManager = new DurableStateManager({ baseDir: tempDir });
    const freshSpecStore = new SpecStore({ baseDir: tempDir });

    const state = await freshDurableManager.load();
    assert.ok(state);
    assert.equal(state.activeTaskId, null);
    assert.equal(state.completedTaskIds.length, 0);

    const tasks = await freshSpecStore.loadTasks();
    const task = tasks.find((t) => t.task_id === defaultTask.task_id);
    assert.equal(task?.status, TaskStatus.REJECTED);
  });

  // ==========================================================================
  // 15. Idempotent Failure Integration
  // ==========================================================================
  it('15. Replaying exact same failure evidence returns idempotent duplicate without mutation', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'fail',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    const firstRun = await integrator.integrate(evidence);
    assert.strictEqual(firstRun.isDuplicate, false);

    const secondRun = await integrator.integrate(evidence);
    assert.equal(secondRun.success, true);
    assert.equal(secondRun.isDuplicate, true);
    assert.equal(secondRun.taskStatus, TaskStatus.REJECTED);
  });

  // ==========================================================================
  // 16. Duplicate History Suppression
  // ==========================================================================
  it('16. Duplicate failure integration does NOT append duplicate history events', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'fail',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    await integrator.integrate(evidence);
    const eventsAfterFirst = await historyManager.readEvents();

    await integrator.integrate(evidence);
    const eventsAfterSecond = await historyManager.readEvents();

    assert.equal(eventsAfterFirst.length, eventsAfterSecond.length);
  });

  // ==========================================================================
  // 17. No Automatic Retry
  // ==========================================================================
  it('17. Execution failure integration never resets task to READY or triggers autonomous retry', async () => {
    const rawOutcome: RawExecutorOutcome = {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'fail',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      timedOut: false,
      cancelled: false,
      requestBinding: {
        requestId: defaultRequest.requestId,
        projectId: defaultRequest.projectId,
        taskId: defaultRequest.taskId,
        taskRevision: defaultRequest.taskRevision,
        contextFingerprint: defaultRequest.contextFingerprint,
        understandingRevision: defaultRequest.understandingRevision,
        approvalPackageRevision: defaultRequest.approvalPackageRevision,
      },
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    };

    const evidence = await collector.collectAndVerify(defaultRequest, rawOutcome, {
      workingDirectory: tempDir,
    });

    await integrator.integrate(evidence);

    const tasks = await specStore.loadTasks();
    const task = tasks.find((t) => t.task_id === defaultTask.task_id);

    // Must be REJECTED, not READY!
    assert.equal(task?.status, TaskStatus.REJECTED);
    assert.notEqual(task?.status, TaskStatus.READY);
    // Attempts must NOT be incremented by integrator
    assert.equal(task?.attempt, 0);
  });

  // ==========================================================================
  // 18. P13 Recovery Compatibility
  // ==========================================================================
  it('18. P13 FailureDiagnosisEngine and RecoveryPolicyEngine evaluate failure categories accurately', async () => {
    // 18a. EXECUTOR_START_FAILURE -> BLOCK_ON_HUMAN
    const startFailEvidence = await collector.collectAndVerify(defaultRequest, {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'ERROR',
      failureCategory: ExecutionFailureCategory.EXECUTOR_START_FAILURE,
      exitCode: null,
      signal: null,
      stdout: null,
      stderr: 'binary missing',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      timedOut: false,
      cancelled: false,
      requestBinding: defaultRequest,
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    }, { workingDirectory: tempDir });

    const diagnosisStart = FailureDiagnosisEngine.diagnose(startFailEvidence);
    assert.equal(diagnosisStart.primaryCategory, FailureCategory.EXECUTOR_START_FAILURE);
    assert.equal(diagnosisStart.requiresHuman, true);
    assert.equal(diagnosisStart.isRetryable, false);

    const decisionStart = recoveryPolicyEngine.evaluate({
      evidence: startFailEvidence,
      task: defaultTask,
    });
    assert.equal(decisionStart.decision, RecoveryStrategy.BLOCK_ON_HUMAN);

    // 18b. SECURITY_FAILURE -> ABORT
    const secFailEvidence = await collector.collectAndVerify(defaultRequest, {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.SECURITY_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'scope violation',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      timedOut: false,
      cancelled: false,
      requestBinding: defaultRequest,
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    }, { workingDirectory: tempDir });

    const diagnosisSec = FailureDiagnosisEngine.diagnose(secFailEvidence);
    assert.equal(diagnosisSec.primaryCategory, FailureCategory.SECURITY_FAILURE);

    const decisionSec = recoveryPolicyEngine.evaluate({
      evidence: secFailEvidence,
      task: defaultTask,
    });
    assert.equal(decisionSec.decision, RecoveryStrategy.ABORT);

    // 18c. EXECUTOR_EXIT_FAILURE with remaining attempts -> RETRY
    const exitFailEvidence = await collector.collectAndVerify(defaultRequest, {
      requestId: defaultRequest.requestId,
      executorIdentity: { provider: 'antigravity', name: 'agy', version: '1.2.3' },
      status: 'FAILURE',
      failureCategory: ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE,
      exitCode: 1,
      signal: null,
      stdout: null,
      stderr: 'syntax error in code',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      timedOut: false,
      cancelled: false,
      requestBinding: defaultRequest,
      unverifiedAgentClaims: [],
      unverifiedModifiedFiles: [],
    }, { workingDirectory: tempDir });

    const decisionRetry = recoveryPolicyEngine.evaluate({
      evidence: exitFailEvidence,
      task: { ...defaultTask, attempt: 1, max_attempts: 3 },
    });
    assert.equal(decisionRetry.decision, RecoveryStrategy.RETRY);

    // 18d. EXECUTOR_EXIT_FAILURE with exhausted budget -> BLOCK_ON_HUMAN
    const decisionExhausted = recoveryPolicyEngine.evaluate({
      evidence: exitFailEvidence,
      task: { ...defaultTask, attempt: 3, max_attempts: 3 },
    });
    assert.equal(decisionExhausted.decision, RecoveryStrategy.BLOCK_ON_HUMAN);
  });

  // ==========================================================================
  // 19. No Orphan Executor Process
  // ==========================================================================
  it('19. Process timeout terminates real child process leaving no orphan process', async () => {
    const pidFile = path.join(tempDir, 'child.pid');
    const bgScript = path.join(scriptsDir, 'bg-script');
    createExecutableScript(
      bgScript,
      `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`
    );

    const runner = new NodeAntigravityProcessRunner();
    const result = await runner.run({
      executable: bgScript,
      args: [],
      cwd: tempDir,
      timeoutMs: 300,
    });

    assert.equal(result.timedOut, true);

    // Wait 200ms to allow OS process termination cleanup
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(fs.existsSync(pidFile));
    const childPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    assert.ok(!isNaN(childPid));
    assert.equal(isProcessAlive(childPid), false, 'Child process must not be alive after timeout termination');
  });

  // ==========================================================================
  // 20. Real Failure-Path Execution End-to-End
  // ==========================================================================
  it('20. Real process failure-path execution end-to-end through full pipeline', async () => {
    const realFailScript = path.join(scriptsDir, 'real-fail');
    createExecutableScript(
      realFailScript,
      'console.error("test error output"); process.exit(1);'
    );

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: realFailScript,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    // 1. Adapter executes real failing process
    const outcome = await adapter.execute(defaultRequest);

    assert.equal(outcome.status, 'FAILURE');
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.failureCategory, ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE);

    // 2. Collector creates verified evidence
    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    assert.equal(evidence.verificationDecision, 'REJECT');
    assert.equal(evidence.failureCategory, ExecutionFailureCategory.EXECUTOR_EXIT_FAILURE);

    // 3. Integrator integrates failure
    const integration = await integrator.integrate(evidence);
    assert.equal(integration.success, true);
    assert.equal(integration.taskStatus, TaskStatus.REJECTED);

    // 4. P13 evaluates recovery policy without auto-mutating task
    const recoveryDecision = await recoveryPolicyEngine.evaluateAndRecord({
      evidence,
      task: defaultTask,
      recordHistory: true,
    });

    assert.equal(recoveryDecision.decision, RecoveryStrategy.RETRY);
    assert.ok(
      recoveryDecision.failureCategory === FailureCategory.EXECUTOR_EXIT_FAILURE ||
      recoveryDecision.failureCategory === FailureCategory.ACCEPTANCE_CRITERIA_FAILURE
    );

    // 5. Audit trail records correct events
    const events = await historyManager.readEvents();
    assert.ok(events.some((e) => e.eventType === 'SYSTEM_EVIDENCE_VERIFIED'));
    assert.ok(events.some((e) => e.eventType === 'EXECUTION_STATE_INTEGRATED'));
    assert.ok(events.some((e) => e.eventType === 'RECOVERY_DECISION_EVALUATED'));
  });

  // ==========================================================================
  // 21. Secret Sanitization in Failure Diagnostics
  // ==========================================================================
  it('21. Secrets in executor error output are sanitized in evidence and history', async () => {
    const leakyScript = path.join(scriptsDir, 'leaky');
    createExecutableScript(
      leakyScript,
      'console.error("Failed connecting with token=secret-token-abc123xyz and apiKey=secret-key-999"); process.exit(1);'
    );

    const runner = new NodeAntigravityProcessRunner();
    const adapter = new AntigravityAdapter({
      processRunner: runner,
      binaryPath: leakyScript,
      workspaceRoot: tempDir,
      skipCompatibilityProbe: true,
    });

    const outcome = await adapter.execute(defaultRequest);

    const evidence = await collector.collectAndVerify(defaultRequest, outcome, {
      workingDirectory: tempDir,
    });

    const evidenceJson = JSON.stringify(evidence);
    assert.ok(!evidenceJson.includes('secret-token-abc123xyz'), 'Secret token must be sanitized');
    assert.ok(!evidenceJson.includes('secret-key-999'), 'API key must be sanitized');

    await integrator.integrate(evidence);

    const events = await historyManager.readEvents();
    const historyJson = JSON.stringify(events);
    assert.ok(!historyJson.includes('secret-token-abc123xyz'), 'Secret must not leak into history events');
    assert.ok(!historyJson.includes('secret-key-999'), 'API key must not leak into history events');
  });
});
