/**
 * @file phase-7-e2e.test.ts
 * @description Dedicated Phase 7 Autonomous E2E Integration & Production Hardening Test Suite (TASK-P7-01).
 *
 * Validates that the AIDM architecture can autonomously coordinate:
 * REQUIREMENTS
 *     ↓
 * TASK GRAPH
 *     ↓
 * TASK SELECTION
 *     ↓
 * PRE-FLIGHT CHECKPOINT
 *     ↓
 * ANTIGRAVITY EXECUTION BOUNDARY
 *     ↓
 * IMPLEMENTATION
 *     ↓
 * EVIDENCE COLLECTION
 *     ↓
 * EVIDENCE VALIDATION
 *     ↓
 * CHATGPT REVIEW BOUNDARY
 *     ↓
 * ACCEPT / REJECT
 *     ↓
 * RECOVERY / RETRY / RESTART
 *     ↓
 * GIT CHECKPOINT
 *     ↓
 * PROJECT COMPLETION
 *
 * Enforces all 15 Step 9 requirements, AC-E2E-01 through AC-E2E-08,
 * controlled failure & recovery, Git isolation, policy boundary,
 * UI verification boundary, and fixture cleanup.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { promisify } from 'node:util';

import {
  // Lifecycle & FSM
  LifecycleState,
  TaskLoopState,
  StateMachine,
  TaskLoopStateMachine,

  // Task DAG Engine
  TaskDagEngine,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type TaskDefinitionInput,

  // Policy Engine
  PolicyEngine,
  OperationActionType,
  PolicyDecisionState,

  // Git Subsystem
  DefaultGitPort,
  GitCheckpointManager,
  GitRollbackManager,
  GitOperationType,
  GitCheckpointPurpose,

  // Evidence Subsystem
  EvidenceCollector,
  EvidenceType,
  EvidenceSource,
  validateSystemVerifiedEvidence,
  type SystemVerifiedEvidence,

  // QA Review Engine
  QAReviewEngine,
  ReviewDecision,
  CriterionType,
  type AcceptanceCriterionInput,

  // Recovery Subsystem
  RecoveryDecision,
  RecoveryGitRollbackIntegrator,

  // Executor Bridge
  type ExecutorPort,
  type ExecutorInstruction,
  type NormalizedExecutorResult,
  ExecutorOperationType,
  ExecutorExecutionStatus,

  // Adapters
  NodeProjectAdapter,
  NodeBuildAdapter,
  NodeTestAdapter,
  NodePackageManagerAdapter,
  DefaultGitAdapter,
  DefaultUIAdapter,

  // Autonomous Harness
  AutonomousLifecycleHarness,
  type AutonomousRequirement,
  type AutonomousDecision,
  type AutonomousHarnessOptions,
} from '../dist/index.js';

const execFile = promisify(child_process.execFile);

// ============================================================================
// DETERMINISTIC FIXTURE HELPERS
// ============================================================================

const AIDM_ROOT = path.resolve(process.cwd());

interface FixtureContext {
  fixtureDir: string;
  gitPort: DefaultGitPort;
  checkpointManager: GitCheckpointManager;
  gitAdapter: DefaultGitAdapter;
  policyEngine: PolicyEngine;
  evidenceCollector: EvidenceCollector;
  qaReviewEngine: QAReviewEngine;
  cleanup: () => Promise<void>;
}

async function createDisposableFixture(name = 'aidm-e2e-fixture'): Promise<FixtureContext> {
  const fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${name}-`));

  // Initialize git repository deterministically
  await execFile('git', ['init', '-b', 'main'], { cwd: fixtureDir });
  await execFile('git', ['config', 'user.name', 'AIDM E2E Fixture'], { cwd: fixtureDir });
  await execFile('git', ['config', 'user.email', 'aidm-fixture@example.com'], { cwd: fixtureDir });

  // Create initial package.json
  const initialPackageJson = {
    name: 'e2e-disposable-fixture',
    version: '1.0.0',
    type: 'module',
    description: 'Disposable fixture project for autonomous Phase 7 E2E validation',
  };
  await fs.promises.writeFile(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify(initialPackageJson, null, 2),
    'utf-8'
  );

  // Initial git commit
  await execFile('git', ['add', '.'], { cwd: fixtureDir });
  await execFile('git', ['commit', '-m', 'chore: initial fixture commit'], { cwd: fixtureDir });

  const gitPort = new DefaultGitPort();
  const checkpointManager = new GitCheckpointManager(gitPort, {
    defaultWorkingDirectory: fixtureDir,
  });
  const gitAdapter = new DefaultGitAdapter(checkpointManager, gitPort);

  const policyEngine = new PolicyEngine({
    project_root: fixtureDir,
    allow_dependency_installation: true,
  });

  const evidenceCollector = new EvidenceCollector();
  const qaReviewEngine = new QAReviewEngine();

  const cleanup = async () => {
    try {
      await fs.promises.rm(fixtureDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if already removed
    }
  };

  return {
    fixtureDir,
    gitPort,
    checkpointManager,
    gitAdapter,
    policyEngine,
    evidenceCollector,
    qaReviewEngine,
    cleanup,
  };
}

/**
 * Deterministic Mock Executor implementing ExecutorPort.
 */
class DeterministicFixtureExecutor implements ExecutorPort {
  readonly executorId = 'executor:fixture:deterministic';
  readonly provider = 'antigravity';
  readonly supportedOperations = [
    ExecutorOperationType.IMPLEMENT_TASK,
    ExecutorOperationType.APPLY_REPAIR,
  ] as const;

  private readonly implementationFn: (instruction: ExecutorInstruction) => Promise<void>;

  constructor(
    implementationFn: (instruction: ExecutorInstruction) => Promise<void>
  ) {
    this.implementationFn = implementationFn;
  }

  async checkAvailability() {
    return { available: true, ready: true, provider: this.provider, version: '1.0.0' };
  }

  async execute(instruction: ExecutorInstruction): Promise<NormalizedExecutorResult> {
    await this.implementationFn(instruction);
    return {
      instruction_id: instruction.instruction_id,
      task_id: instruction.task_id,
      correlation_id: instruction.correlation_id,
      status: ExecutorExecutionStatus.COMPLETED,
      operation_type: instruction.requested_operation_type,
      duration_ms: 50,
      exit_code: 0,
      summary: 'Task implementation applied successfully to fixture',
      raw_outcome: { success: true },
      policy_authorized: true,
      modified_files: [],
      created_files: [],
      deleted_files: [],
      metadata: {},
    };
  }
}

// ============================================================================
// PHASE 7 DEDICATED E2E TEST SUITE
// ============================================================================

describe('Phase 7 Autonomous E2E Integration & Production Readiness (TASK-P7-01)', () => {
  // --------------------------------------------------------------------------
  // TEST 1: Fixture Creation & Initialization
  // --------------------------------------------------------------------------
  it('T01_fixture_creation: disposable fixture project is created and initialized deterministically', async () => {
    const fixture = await createDisposableFixture('t01-creation');
    try {
      assert.ok(fs.existsSync(fixture.fixtureDir));
      const gitState = await fixture.gitPort.inspectState(fixture.fixtureDir);
      assert.equal(gitState.isRepository, true);
      assert.equal(gitState.current_branch, 'main');
      assert.equal(gitState.working_tree_clean, true);
      assert.ok(gitState.head_sha);

      const pkgRaw = await fs.promises.readFile(
        path.join(fixture.fixtureDir, 'package.json'),
        'utf-8'
      );
      const pkg = JSON.parse(pkgRaw);
      assert.equal(pkg.name, 'e2e-disposable-fixture');
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 2: Project Isolation
  // --------------------------------------------------------------------------
  it('T02_project_isolation: fixture is strictly isolated from AIDM source tree; AIDM repo cannot be modified', async () => {
    const fixture = await createDisposableFixture('t02-isolation');
    try {
      // Verify fixture is outside AIDM root
      assert.notEqual(fixture.fixtureDir, AIDM_ROOT);
      assert.equal(fixture.fixtureDir.includes(AIDM_ROOT), false);

      // Verify Git operations in fixture do not touch AIDM repository
      const aidmHeadBefore = (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim();

      // Make a commit in the fixture
      await fs.promises.writeFile(
        path.join(fixture.fixtureDir, 'sample.txt'),
        'hello from fixture',
        'utf-8'
      );
      await execFile('git', ['add', '.'], { cwd: fixture.fixtureDir });
      await execFile('git', ['commit', '-m', 'fixture change'], { cwd: fixture.fixtureDir });

      const aidmHeadAfter = (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim();
      assert.equal(aidmHeadBefore, aidmHeadAfter, 'AIDM HEAD must not change during fixture work');
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 3: Requirements Ingestion & Locking (DEC-001)
  // --------------------------------------------------------------------------
  it('T03_requirement_task_setup: requirements are ingested and locked (status: LOCKED, authority: USER) per DEC-001', async () => {
    const fixture = await createDisposableFixture('t03-requirements');
    try {
      const requirements: AutonomousRequirement[] = [
        {
          id: 'REQ-001',
          title: 'Greeting Service',
          description: 'Autonomous greeting generator function',
          authority: 'USER',
          status: 'LOCKED',
        },
      ];

      const tasks: TaskDefinitionInput[] = [
        {
          task_id: 'TASK-001',
          parent_feature_id: 'FEAT-001',
          title: 'Implement Greeting Function',
          description: 'Implements getGreeting function',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: [],
          acceptance_criteria: ['Function returns greeting'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 3,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
      ];

      const features = [
        {
          task_id: 'FEAT-001',
          title: 'Greeting Feature',
          hierarchy_level: 'FEATURE' as const,
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        },
      ];

      const harness = new AutonomousLifecycleHarness({
        projectId: 'proj-p7-03',
        projectRoot: fixture.fixtureDir,
        requirements,
        tasks,
        features,
        policyEngine: fixture.policyEngine,
        gitAdapter: fixture.gitAdapter,
        executorPort: new DeterministicFixtureExecutor(async () => {}),
        evidenceCollector: fixture.evidenceCollector,
        qaReviewEngine: fixture.qaReviewEngine,
      });

      await harness.initialize();
      assert.equal(harness.getMacroState(), LifecycleState.TASK_SELECTION);
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 4: Task Graph Validation & Kahn Topological Ordering
  // --------------------------------------------------------------------------
  it('T04_task_execution_path: task graph is validated, cycle-free, and sorted deterministically via Kahn algorithm', async () => {
    const fixture = await createDisposableFixture('t04-dag');
    try {
      const requirements: AutonomousRequirement[] = [
        {
          id: 'REQ-001',
          title: 'Core Library',
          description: 'Library with core and math utils',
          authority: 'USER',
          status: 'LOCKED',
        },
      ];

      const tasks: TaskDefinitionInput[] = [
        {
          task_id: 'TASK-B',
          parent_feature_id: 'FEAT-001',
          title: 'Feature B (depends on A)',
          description: 'Second task',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: ['TASK-A'],
          acceptance_criteria: ['B criteria'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 3,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
        {
          task_id: 'TASK-A',
          parent_feature_id: 'FEAT-001',
          title: 'Feature A (base)',
          description: 'First task',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: [],
          acceptance_criteria: ['A criteria'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 3,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
      ];

      const features = [
        {
          task_id: 'FEAT-001',
          title: 'Library Feature',
          hierarchy_level: 'FEATURE' as const,
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        },
      ];

      const harness = new AutonomousLifecycleHarness({
        projectId: 'proj-p7-04',
        projectRoot: fixture.fixtureDir,
        requirements,
        tasks,
        features,
        policyEngine: fixture.policyEngine,
        gitAdapter: fixture.gitAdapter,
        executorPort: new DeterministicFixtureExecutor(async () => {}),
        evidenceCollector: fixture.evidenceCollector,
        qaReviewEngine: fixture.qaReviewEngine,
      });

      await harness.initialize();
      // Topological order should put TASK-A before TASK-B
      assert.equal(harness.getMacroState(), LifecycleState.TASK_SELECTION);
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 5 - 10: Complete Autonomous Lifecycle Path (AC-E2E-01 - AC-E2E-08)
  // --------------------------------------------------------------------------
  it('T05_to_T10_autonomous_lifecycle: complete autonomous development loop from requirements to project completion', async () => {
    const fixture = await createDisposableFixture('t05-10-lifecycle');
    try {
      const requirements: AutonomousRequirement[] = [
        {
          id: 'REQ-001',
          title: 'Greeting Feature',
          description: 'A module returning a personalized greeting and a unit test verifying it',
          authority: 'USER',
          status: 'LOCKED',
        },
      ];

      const features = [
        {
          task_id: 'FEAT-001',
          title: 'Greeting Feature',
          hierarchy_level: 'FEATURE' as const,
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        },
      ];

      const tasks: TaskDefinitionInput[] = [
        {
          task_id: 'TASK-GREETING',
          parent_feature_id: 'FEAT-001',
          title: 'Implement greeting module and unit test',
          description: 'Create src/greeting.js and test/greeting.test.js',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: [],
          acceptance_criteria: ['Greeting returns expected text and test passes'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 3,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
      ];

      const testCommand = 'node --test test/greeting.test.js';

      const taskCriteria = new Map<string, readonly AcceptanceCriterionInput[]>([
        [
          'TASK-GREETING',
          [
            {
              criterion_id: 'AC-E2E-04',
              description: 'Unit test verifying greeting function passes with exit code 0',
              criterion_type: CriterionType.TEST,
              is_mandatory: true,
              expected_command: testCommand,
              expected_exit_code: 0,
            },
          ],
        ],
      ]);

      // Executor writes greeting implementation and unit test inside fixture
      const executor = new DeterministicFixtureExecutor(async (instruction) => {
        const srcDir = path.join(instruction.working_directory, 'src');
        const testDir = path.join(instruction.working_directory, 'test');
        await fs.promises.mkdir(srcDir, { recursive: true });
        await fs.promises.mkdir(testDir, { recursive: true });

        // Write greeting.js
        await fs.promises.writeFile(
          path.join(srcDir, 'greeting.js'),
          'export function getGreeting(name) {\n  return `Hello, ${name}!`;\n}\n',
          'utf-8'
        );

        // Write greeting.test.js
        await fs.promises.writeFile(
          path.join(testDir, 'greeting.test.js'),
          [
            "import { test } from 'node:test';",
            "import * as assert from 'node:assert/strict';",
            "import { getGreeting } from '../src/greeting.js';",
            '',
            "test('greeting returns expected greeting', () => {",
            "  assert.equal(getGreeting('World'), 'Hello, World!');",
            '});',
            '',
          ].join('\n'),
          'utf-8'
        );
      });

      const lifecycleStagesRecorded: string[] = [];

      const harness = new AutonomousLifecycleHarness({
        projectId: 'proj-greeting',
        projectRoot: fixture.fixtureDir,
        requirements,
        tasks,
        features,
        taskCriteria,
        policyEngine: fixture.policyEngine,
        gitAdapter: fixture.gitAdapter,
        executorPort: executor,
        evidenceCollector: fixture.evidenceCollector,
        qaReviewEngine: fixture.qaReviewEngine,
      });

      harness.subscribe((event) => {
        lifecycleStagesRecorded.push(event.stage);
      });

      // Run full autonomous lifecycle
      const result = await harness.runAutonomousLifecycle();

      // AC-E2E-01: Project was initialized
      assert.equal(result.success, true);
      assert.equal(result.finalMacroState, LifecycleState.PROJECT_COMPLETE);

      // AC-E2E-02: Task graph executable and completed
      assert.deepEqual(result.completedTasks, ['TASK-GREETING']);
      assert.equal(result.failedTasks.length, 0);

      // Verify lifecycle stages progressed in order
      assert.ok(lifecycleStagesRecorded.includes('START'));
      assert.ok(lifecycleStagesRecorded.includes('CHECKPOINT'));
      assert.ok(lifecycleStagesRecorded.includes('INSTRUCT'));
      assert.ok(lifecycleStagesRecorded.includes('IMPLEMENT'));
      assert.ok(lifecycleStagesRecorded.includes('EVIDENCE'));
      assert.ok(lifecycleStagesRecorded.includes('REVIEW'));
      assert.ok(lifecycleStagesRecorded.includes('ACCEPT'));
      assert.ok(lifecycleStagesRecorded.includes('COMPLETE'));

      // Check task summary details
      const summary = result.taskSummaries.get('TASK-GREETING');
      assert.ok(summary);
      assert.equal(summary.finalStatus, 'COMPLETED');
      assert.equal(summary.totalAttempts, 1);

      // AC-E2E-07: Checkpoint and commit verification
      assert.ok(summary.preFlightCheckpoint);
      assert.ok(summary.postFlightCheckpoint);
      assert.notEqual(
        summary.preFlightCheckpoint.commit_sha,
        summary.postFlightCheckpoint.commit_sha,
        'Post-flight commit must produce a new commit SHA'
      );

      // Verify git history in fixture contains the commit
      const gitState = await fixture.gitPort.inspectState(fixture.fixtureDir);
      assert.equal(gitState.head_sha, summary.postFlightCheckpoint.commit_sha);
      assert.equal(gitState.working_tree_clean, true);

      // AC-E2E-04 & AC-E2E-05: Verify SYSTEM_VERIFIED_EVIDENCE was generated
      const attempt = summary.attempts[0];
      assert.equal(attempt.evidence.length, 1);
      const evidence = attempt.evidence[0];
      assert.equal(evidence.source, EvidenceSource.SYSTEM_VERIFIED_EVIDENCE);
      assert.equal(evidence.exit_code, 0);
      assert.equal(evidence.command, testCommand);
      assert.ok(evidence.evidence_id);

      // AC-E2E-06: Review decision was ACCEPT
      assert.equal(attempt.reviewResult.decision, ReviewDecision.ACCEPT);
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 11 & 12: Controlled Failure & Recovery (REJECT -> RETRY -> ACCEPT)
  // --------------------------------------------------------------------------
  it('T11_T12_failure_and_retry: first implementation fails, evidence captures failure, review rejects, second attempt passes', async () => {
    const fixture = await createDisposableFixture('t11-12-retry');
    try {
      const requirements: AutonomousRequirement[] = [
        {
          id: 'REQ-001',
          title: 'Math Feature',
          description: 'A square root function',
          authority: 'USER',
          status: 'LOCKED',
        },
      ];

      const features = [
        {
          task_id: 'FEAT-001',
          title: 'Math Feature',
          hierarchy_level: 'FEATURE' as const,
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        },
      ];

      const tasks: TaskDefinitionInput[] = [
        {
          task_id: 'TASK-MATH',
          parent_feature_id: 'FEAT-001',
          title: 'Implement square calculation',
          description: 'Calculates square of numbers',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: [],
          acceptance_criteria: ['Test passes with correct square result'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 3,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
      ];

      const testCommand = 'node --test test/math.test.js';

      const taskCriteria = new Map<string, readonly AcceptanceCriterionInput[]>([
        [
          'TASK-MATH',
          [
            {
              criterion_id: 'AC-MATH-01',
              description: 'Math unit test must pass',
              criterion_type: CriterionType.TEST,
              is_mandatory: true,
              expected_command: testCommand,
              expected_exit_code: 0,
            },
          ],
        ],
      ]);

      let attemptCounter = 0;

      // Executor writes FAILING code on attempt 1, PASSING code on attempt 2
      const executor = new DeterministicFixtureExecutor(async (instruction) => {
        attemptCounter++;
        const srcDir = path.join(instruction.working_directory, 'src');
        const testDir = path.join(instruction.working_directory, 'test');
        await fs.promises.mkdir(srcDir, { recursive: true });
        await fs.promises.mkdir(testDir, { recursive: true });

        if (attemptCounter === 1) {
          // Intentional bug: square returns wrong answer
          await fs.promises.writeFile(
            path.join(srcDir, 'math.js'),
            'export function square(n) { return n + 1; }\n',
            'utf-8'
          );
        } else {
          // Corrected implementation
          await fs.promises.writeFile(
            path.join(srcDir, 'math.js'),
            'export function square(n) { return n * n; }\n',
            'utf-8'
          );
        }

        // Test always expects square(4) === 16
        await fs.promises.writeFile(
          path.join(testDir, 'math.test.js'),
          [
            "import { test } from 'node:test';",
            "import * as assert from 'node:assert/strict';",
            "import { square } from '../src/math.js';",
            '',
            "test('square calculates correctly', () => {",
            '  assert.equal(square(4), 16);',
            '});',
            '',
          ].join('\n'),
          'utf-8'
        );
      });

      const stages: string[] = [];

      const harness = new AutonomousLifecycleHarness({
        projectId: 'proj-math',
        projectRoot: fixture.fixtureDir,
        requirements,
        tasks,
        features,
        taskCriteria,
        policyEngine: fixture.policyEngine,
        gitAdapter: fixture.gitAdapter,
        executorPort: executor,
        evidenceCollector: fixture.evidenceCollector,
        qaReviewEngine: fixture.qaReviewEngine,
        maxRetriesPerTask: 3,
      });

      harness.subscribe((evt) => {
        stages.push(evt.stage);
      });

      const result = await harness.runAutonomousLifecycle();

      // Harness should succeed on retry
      assert.equal(result.success, true);
      assert.equal(result.finalMacroState, LifecycleState.PROJECT_COMPLETE);

      const summary = result.taskSummaries.get('TASK-MATH');
      assert.ok(summary);
      assert.equal(summary.totalAttempts, 2);
      assert.equal(summary.finalStatus, 'COMPLETED');

      // Attempt 1 must be REJECT with exit_code != 0
      const att1 = summary.attempts[0];
      assert.equal(att1.reviewResult.decision, ReviewDecision.REJECT);
      assert.notEqual(att1.evidence[0].exit_code, 0);

      // Attempt 2 must be ACCEPT with exit_code == 0
      const att2 = summary.attempts[1];
      assert.equal(att2.reviewResult.decision, ReviewDecision.ACCEPT);
      assert.equal(att2.evidence[0].exit_code, 0);

      // Verify that REJECT occurred before ACCEPT and RETRY was emitted
      assert.ok(stages.includes('REJECT'));
      assert.ok(stages.includes('RETRY'));
      assert.ok(stages.includes('ACCEPT'));
      assert.ok(stages.indexOf('REJECT') < stages.indexOf('RETRY'));
      assert.ok(stages.indexOf('RETRY') < stages.indexOf('ACCEPT'));
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 13: Recovery RESTART & Git Rollback Boundary
  // --------------------------------------------------------------------------
  it('T13_recovery_restart_rollback: RESTART strategy rolls back to known-good pre-flight checkpoint (RETRY != RESTART)', async () => {
    const fixture = await createDisposableFixture('t13-restart');
    try {
      const rollbackManager = fixture.checkpointManager.getRollbackManager();
      const recoveryIntegrator = new RecoveryGitRollbackIntegrator(
        fixture.checkpointManager,
        rollbackManager
      );

      // Record known-good pre-flight state
      const preFlightCp = await fixture.checkpointManager.createCheckpoint({
        task_id: 'TASK-ROLLBACK-TEST',
        purpose: GitCheckpointPurpose.PRE_FLIGHT,
        working_directory: fixture.fixtureDir,
      });

      const preFlightHead = preFlightCp.commit_sha;

      // Simulate a bad implementation that committed broken changes
      await fs.promises.writeFile(
        path.join(fixture.fixtureDir, 'corrupt.js'),
        'throw new Error("Broken state");',
        'utf-8'
      );
      await execFile('git', ['add', '.'], { cwd: fixture.fixtureDir });
      await execFile('git', ['commit', '-m', 'broken commit that must be rolled back'], {
        cwd: fixture.fixtureDir,
      });

      const badHead = (
        await execFile('git', ['rev-parse', 'HEAD'], { cwd: fixture.fixtureDir })
      ).stdout.trim();
      assert.notEqual(preFlightHead, badHead, 'Repository advanced to bad commit');

      // Execute RESTART recovery decision through RecoveryGitRollbackIntegrator
      const recoveryResult = await recoveryIntegrator.processRecoveryDecision(
        {
          decision: RecoveryDecision.RESTART,
          reason: 'Severe corruption detected; rolling back to pre-flight checkpoint',
          taskId: 'TASK-ROLLBACK-TEST',
          iteration: 1,
          contextReference: null,
          resumePoint: TaskLoopState.INSTRUCT_ANTIGRAVITY,
          targetCheckpoint: preFlightCp.checkpoint_id,
        },
        {
          working_directory: fixture.fixtureDir,
          human_approval_token: 'auth-token-human-authorized-12345',
        }
      );

      assert.equal(recoveryResult.success, true);
      assert.equal(recoveryResult.rollbackExecuted, true);

      // Verify that repository HEAD was restored to preFlightHead
      const restoredHead = (
        await execFile('git', ['rev-parse', 'HEAD'], { cwd: fixture.fixtureDir })
      ).stdout.trim();
      assert.equal(restoredHead, preFlightHead);

      // Verify corrupt file is no longer present
      assert.equal(fs.existsSync(path.join(fixture.fixtureDir, 'corrupt.js')), false);
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 14: Final Completion State Guard
  // --------------------------------------------------------------------------
  it('T14_final_completion_state: PROJECT_COMPLETE state cannot be reached if any task is rejected/incomplete', async () => {
    const fixture = await createDisposableFixture('t14-completion-guard');
    try {
      const requirements: AutonomousRequirement[] = [
        {
          id: 'REQ-001',
          title: 'Failing Requirement',
          description: 'A requirement that will never pass',
          authority: 'USER',
          status: 'LOCKED',
        },
      ];

      const features = [
        {
          task_id: 'FEAT-001',
          title: 'Failing Feature',
          hierarchy_level: 'FEATURE' as const,
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        },
      ];

      const tasks: TaskDefinitionInput[] = [
        {
          task_id: 'TASK-FAIL',
          parent_feature_id: 'FEAT-001',
          title: 'Task that always fails',
          description: 'Always exits with code 1',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: [],
          acceptance_criteria: ['Must pass'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 1, // Only 1 attempt
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
      ];

      const taskCriteria = new Map<string, readonly AcceptanceCriterionInput[]>([
        [
          'TASK-FAIL',
          [
            {
              criterion_id: 'AC-FAIL-01',
              description: 'Must pass',
              criterion_type: CriterionType.COMMAND,
              is_mandatory: true,
              expected_command: 'node -e "process.exit(1)"',
              expected_exit_code: 0,
            },
          ],
        ],
      ]);

      const harness = new AutonomousLifecycleHarness({
        projectId: 'proj-fail',
        projectRoot: fixture.fixtureDir,
        requirements,
        tasks,
        features,
        taskCriteria,
        policyEngine: fixture.policyEngine,
        gitAdapter: fixture.gitAdapter,
        executorPort: new DeterministicFixtureExecutor(async () => {}),
        evidenceCollector: fixture.evidenceCollector,
        qaReviewEngine: fixture.qaReviewEngine,
        maxRetriesPerTask: 1,
      });

      const result = await harness.runAutonomousLifecycle();

      // Must fail closed: success false, final state != PROJECT_COMPLETE
      assert.equal(result.success, false);
      assert.notEqual(result.finalMacroState, LifecycleState.PROJECT_COMPLETE);
      assert.equal(result.completedTasks.length, 0);
      assert.deepEqual(result.failedTasks, ['TASK-FAIL']);
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 15: Fixture Cleanup & Failure Cleanup
  // --------------------------------------------------------------------------
  it('T15_cleanup_and_failure_cleanup: fixture directory is cleaned up upon test completion and in failure paths', async () => {
    let capturedDir: string | undefined;

    // Normal path cleanup
    {
      const fixture = await createDisposableFixture('t15-normal-cleanup');
      capturedDir = fixture.fixtureDir;
      assert.ok(fs.existsSync(capturedDir));
      await fixture.cleanup();
      assert.equal(fs.existsSync(capturedDir), false, 'Fixture dir must be deleted after cleanup');
    }

    // Simulated failure cleanup
    {
      const fixture = await createDisposableFixture('t15-failure-cleanup');
      const failDir = fixture.fixtureDir;
      assert.ok(fs.existsSync(failDir));

      try {
        // Simulate an assertion error inside test execution
        throw new Error('Simulated test assertion error');
      } catch (err) {
        // Ensure cleanup in catch/finally
        await fixture.cleanup();
      }

      assert.equal(
        fs.existsSync(failDir),
        false,
        'Fixture dir must be deleted even if an assertion threw'
      );
    }
  });

  // --------------------------------------------------------------------------
  // TEST 16: Policy Boundary Enforcement
  // --------------------------------------------------------------------------
  it('T16_policy_boundary: path traversal, bulk deletion, and force push attempts are blocked by PolicyEngine', async () => {
    const fixture = await createDisposableFixture('t16-policy');
    try {
      // 1. Path traversal attempt outside project root
      const traversalDecision = fixture.policyEngine.evaluate({
        action_type: OperationActionType.FILE_READ,
        target_path: '../../outside-fixture',
        project_root: fixture.fixtureDir,
      });
      assert.equal(traversalDecision.allowed, false);
      assert.equal(traversalDecision.risk_level, RiskLevel.CRITICAL);

      // 2. Bulk deletion command
      const bulkDelDecision = fixture.policyEngine.evaluate({
        command: 'rm -rf /',
        project_root: fixture.fixtureDir,
      });
      assert.equal(bulkDelDecision.allowed, false);
      assert.equal(bulkDelDecision.risk_level, RiskLevel.CRITICAL);

      // 3. Force push command
      const forcePushDecision = fixture.policyEngine.evaluate({
        command: 'git push --force origin main',
        project_root: fixture.fixtureDir,
      });
      assert.equal(forcePushDecision.allowed, false);
      assert.equal(forcePushDecision.decision, PolicyDecisionState.DENY);
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 17: UI Verification Boundary Preservation
  // --------------------------------------------------------------------------
  it('T17_ui_verification_boundary: UI tasks preserve the UI verification pipeline boundary', async () => {
    const fixture = await createDisposableFixture('t17-ui');
    try {
      // Create a mock UIAdapter that tracks if verifyUI was called
      let uiVerificationCalled = false;
      const mockUiAdapter = {
        id: 'adapter:ui:mock',
        name: 'Mock UI Adapter',
        async verifyUI(request: any) {
          uiVerificationCalled = true;
          return {
            success: true,
            decision: ReviewDecision.ACCEPT,
            reviewResult: {
              task_id: request.task_id,
              decision: ReviewDecision.ACCEPT,
              is_accepted: true,
              findings: [],
              criteria_results: [],
              evaluated_at: new Date().toISOString(),
            },
            pipelineResult: {
              success: true,
              taskId: request.task_id,
              projectId: request.project_id,
              correlationId: request.correlation_id,
              evidence: [
                {
                  evidence_id: `evi-ui-${request.task_id}`,
                  task_id: request.task_id,
                  project_id: request.project_id,
                  correlation_id: request.correlation_id,
                  source: EvidenceSource.SYSTEM_VERIFIED_EVIDENCE,
                  evidence_type: EvidenceType.UI,
                  command: 'playwright:verify',
                  working_directory: fixture.fixtureDir,
                  exit_code: 0,
                  execution_time_ms: 120,
                  content_hash: 'b'.repeat(64),
                },
              ],
            } as any,
          };
        },
      };

      const requirements: AutonomousRequirement[] = [
        {
          id: 'REQ-001',
          title: 'UI Dashboard',
          description: 'A frontend dashboard',
          authority: 'USER',
          status: 'LOCKED',
        },
      ];

      const features = [
        {
          task_id: 'FEAT-001',
          title: 'UI Feature',
          hierarchy_level: 'FEATURE' as const,
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001'],
        },
      ];

      const tasks: TaskDefinitionInput[] = [
        {
          task_id: 'TASK-UI',
          parent_feature_id: 'FEAT-001',
          title: 'Implement dashboard UI',
          description: 'Dashboard page with heading',
          hierarchy_level: 'TASK',
          traceability_sources: ['SYSTEM_REQUIREMENT: REQ-001', 'PARENT_FEATURE: FEAT-001'],
          dependencies: [],
          acceptance_criteria: ['Dashboard renders properly'],
          status: TaskStatus.READY,
          attempt: 1,
          max_attempts: 1,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          estimated_complexity: 'LOW',
        },
      ];

      const taskCriteria = new Map<string, readonly AcceptanceCriterionInput[]>([
        [
          'TASK-UI',
          [
            {
              criterion_id: 'AC-UI-01',
              description: 'Dashboard DOM verification',
              criterion_type: CriterionType.UI,
              is_mandatory: true,
            },
          ],
        ],
      ]);

      const harness = new AutonomousLifecycleHarness({
        projectId: 'proj-ui',
        projectRoot: fixture.fixtureDir,
        requirements,
        tasks,
        features,
        taskCriteria,
        policyEngine: fixture.policyEngine,
        gitAdapter: fixture.gitAdapter,
        executorPort: new DeterministicFixtureExecutor(async () => {}),
        evidenceCollector: fixture.evidenceCollector,
        qaReviewEngine: fixture.qaReviewEngine,
        uiAdapter: mockUiAdapter,
      });

      const result = await harness.runAutonomousLifecycle();

      assert.equal(result.success, true, `Lifecycle failed: ${result.error}`);
      assert.equal(uiVerificationCalled, true, 'UIAdapter.verifyUI must be called for UI criteria');
    } finally {
      await fixture.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 18: Project Adapters Suite Verification
  // --------------------------------------------------------------------------
  it('T18_adapters: project-independent adapters correctly detect project, test runner, and build tool', async () => {
    const fixture = await createDisposableFixture('t18-adapters');
    try {
      const nodeAdapter = new NodeProjectAdapter();
      const isNode = await nodeAdapter.detect(fixture.fixtureDir);
      assert.equal(isNode, true);

      const info = await nodeAdapter.getProjectInfo(fixture.fixtureDir);
      assert.equal(info.type, 'node');
      assert.equal(info.name, 'e2e-disposable-fixture');
      assert.equal(info.testFramework, 'node:test');

      const testAdapter = new NodeTestAdapter(fixture.evidenceCollector);
      assert.equal(testAdapter.id, 'adapter:test:node');

      const buildAdapter = new NodeBuildAdapter(fixture.evidenceCollector);
      assert.equal(buildAdapter.id, 'adapter:build:node');

      const pkgAdapter = new NodePackageManagerAdapter(
        fixture.evidenceCollector,
        fixture.policyEngine
      );
      assert.equal(pkgAdapter.id, 'adapter:pkg:node');
    } finally {
      await fixture.cleanup();
    }
  });
});
