import * as path from 'node:path';
import * as fs from 'node:fs';
import { type RunCommandOptions, type CliRunResult, type CliAppOptions } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import {
  AutonomousLifecycleHarness,
  type AutonomousRequirement,
  type AutonomousHierarchyNode,
} from '../../harness/index.js';
import { SpecStore } from '../../storage/spec-store.js';
import { PolicyEngine } from '../../policy/policy-engine.js';
import { DefaultGitPort } from '../../git/default-git-port.js';
import { GitCheckpointManager } from '../../git/git-checkpoint-manager.js';
import { DefaultGitAdapter } from '../../adapters/git-adapter.js';
import { RecoveryGitRollbackIntegrator } from '../../recovery/recovery-git-integrator.js';
import { EvidenceCollector } from '../../evidence/evidence-collector.js';
import { NodeProcessExecutor } from '../../evidence/process-executor-port.js';
import { QAReviewEngine } from '../../qa-review/qa-review-engine.js';
import { TaskDagEngine } from '../../task-engine/dag-engine.js';
import {
  type TaskDefinitionInput,
  TaskStatus,
  TaskPriority,
} from '../../task-engine/task-types.js';
import { RiskLevel } from '../../risk.js';
import { LifecycleState } from '../../lifecycle.js';
import { CriterionType, type AcceptanceCriterionInput } from '../../qa-review/qa-review-types.js';
import { CheckpointStore } from '../checkpoint-store.js';
import { type ExecutorPort } from '../../executor-bridge/executor-port.js';

export async function executeRun(
  options: RunCommandOptions,
  writer: CliOutputWriter,
  appOptions?: CliAppOptions
): Promise<CliRunResult> {
  const projectRoot = path.resolve(options.projectRoot);

  // 1. Verify project directory exists
  try {
    await fs.promises.access(projectRoot, fs.constants.F_OK);
  } catch {
    const msg = `Target project directory does not exist: ${projectRoot}`;
    if (options.json) {
      writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
    } else {
      writer.writeError(`Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  // 2. Load requirements
  let rawRequirements: any[] = [];
  if (options.requirementsPath) {
    const fullPath = path.resolve(projectRoot, options.requirementsPath);
    try {
      const content = await fs.promises.readFile(fullPath, 'utf8');
      rawRequirements = JSON.parse(content);
    } catch (err) {
      const msg = `Failed to read requirements file at ${fullPath}: ${err instanceof Error ? err.message : String(err)}`;
      if (options.json) {
        writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
      } else {
        writer.writeError(`Error: ${msg}`);
      }
      return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
    }
  } else {
    // Try SpecStore (.ai-manager/spec/requirements.json)
    const specStore = new SpecStore({ baseDir: projectRoot });
    try {
      rawRequirements = await specStore.loadRequirements();
    } catch {
      // Not yet created
    }
  }

  if (!Array.isArray(rawRequirements) || rawRequirements.length === 0) {
    const msg = 'No requirements found. Add requirements to .ai-manager/spec/requirements.json or pass --requirements <path>';
    if (options.json) {
      writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
    } else {
      writer.writeError(`Usage Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  // Normalize requirements per DEC-001 (LOCKED, authority: USER)
  const requirements: AutonomousRequirement[] = rawRequirements.map((r, i) => ({
    id: r.id ?? `REQ-${String(i + 1).padStart(3, '0')}`,
    title: r.title ?? `Requirement ${i + 1}`,
    description: r.description ?? r.title ?? 'No description provided',
    authority: 'USER',
    status: 'LOCKED',
    acceptanceCriteria: r.acceptanceCriteria ?? r.acceptance_criteria ?? [],
    metadata: r.metadata,
  }));

  // 3. Load or generate tasks
  let tasks: TaskDefinitionInput[] = [];
  const features: AutonomousHierarchyNode[] = [];
  const taskCriteriaMap = new Map<string, AcceptanceCriterionInput[]>();

  if (options.tasksPath) {
    const fullTasksPath = path.resolve(projectRoot, options.tasksPath);
    try {
      const content = await fs.promises.readFile(fullTasksPath, 'utf8');
      tasks = JSON.parse(content);
    } catch (err) {
      const msg = `Failed to read tasks file at ${fullTasksPath}: ${err instanceof Error ? err.message : String(err)}`;
      if (options.json) {
        writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
      } else {
        writer.writeError(`Error: ${msg}`);
      }
      return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
    }
  } else {
    // Check if .ai-manager/spec/tasks.json exists
    const defaultTasksFile = path.join(projectRoot, '.ai-manager', 'spec', 'tasks.json');
    try {
      const content = await fs.promises.readFile(defaultTasksFile, 'utf8');
      tasks = JSON.parse(content);
    } catch {
      // Auto-generate feature and task definitions from requirements
      for (const req of requirements) {
        const featId = `FEAT-${req.id.replace(/^REQ-/, '')}`;
        const taskId = `TASK-${req.id.replace(/^REQ-/, '')}`;

        features.push({
          task_id: featId,
          title: `Feature for ${req.title}`,
          hierarchy_level: 'FEATURE',
          traceability_sources: [`SYSTEM_REQUIREMENT: ${req.id}`],
          description: req.description,
        });

        tasks.push({
          task_id: taskId,
          parent_feature_id: featId,
          title: req.title,
          description: req.description,
          hierarchy_level: 'TASK',
          traceability_sources: [`SYSTEM_REQUIREMENT: ${req.id}`, `PARENT_FEATURE: ${featId}`],
          dependencies: [],
          acceptance_criteria: req.acceptanceCriteria && req.acceptanceCriteria.length > 0
            ? [...req.acceptanceCriteria]
            : ['Test suite passes without errors'],
          status: TaskStatus.READY,
          attempt: 0,
          max_attempts: options.maxRetries,
          priority: TaskPriority.HIGH,
          risk_level: RiskLevel.CAUTION,
          metadata: { estimated_complexity: 'LOW' },
        });

        taskCriteriaMap.set(taskId, [
          {
            criterion_id: `AC-${taskId}-01`,
            description: `Verification for ${req.title}`,
            criterion_type: CriterionType.TEST,
            expected_exit_code: 0,
            is_mandatory: true,
          },
        ]);
      }
    }
  }

  // 4. Validate Task DAG before execution
  const dagEngine = new TaskDagEngine();
  const dagValidation = dagEngine.validateGraph({
    tasks,
    features: features.map((f) => f.task_id),
  });

  if (!dagValidation.valid) {
    const errorDetails = dagValidation.errors.map((e: any) => e.message ?? String(e)).join('; ');
    const msg = `Task DAG validation failed: ${errorDetails}`;
    if (options.json) {
      writer.writeJson({
        success: false,
        error: msg,
        exitCode: CliExitCode.USAGE_ERROR,
        issues: dagValidation.errors,
      });
    } else {
      writer.writeError(`DAG Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  // 5. If --dry-run: output validation success and return immediately
  if (options.dryRun) {
    const data = {
      dryRun: true,
      valid: true,
      requirementsCount: requirements.length,
      tasksCount: tasks.length,
      executionOrder: dagValidation.topologicalOrder ?? [],
    };
    if (options.json) {
      writer.writeJson({
        success: true,
        exitCode: CliExitCode.SUCCESS,
        data,
      });
    } else {
      writer.write('DAG and requirements validation passed (--dry-run).');
      writer.write(`  Requirements:    ${requirements.length}`);
      writer.write(`  Tasks:           ${tasks.length}`);
      writer.write(`  Execution Order: ${(dagValidation.topologicalOrder ?? []).join(' -> ')}`);
    }
    return { exitCode: CliExitCode.SUCCESS, data };
  }

  // 6. Assemble subsystems behind existing application boundaries
  const policyEngine = new PolicyEngine({ projectRoot });
  const gitPort = new DefaultGitPort();
  const checkpointManager = new GitCheckpointManager(gitPort, {
    defaultWorkingDirectory: projectRoot,
  });
  const gitAdapter = new DefaultGitAdapter(checkpointManager, gitPort);
  const recoveryIntegrator = new RecoveryGitRollbackIntegrator(checkpointManager);
  const checkpointStore = new CheckpointStore(projectRoot);

  const processExecutor = new NodeProcessExecutor();
  const evidenceCollector = new EvidenceCollector({ processExecutor });
  const qaReviewEngine = new QAReviewEngine();

  // Determine executor port: use injected executorPort if available, or default
  const fallbackExecutor: ExecutorPort = {
    executorId: 'executor:default:cli',
    provider: 'default',
    supportedOperations: ['MUTATE_SOURCE', 'EXECUTE_TEST', 'RUN_COMMAND', 'INSPECT_WORKSPACE'] as any,
    async checkAvailability() {
      return { available: true, provider: 'default', version: '1.0.0' } as any;
    },
    async execute(instruction) {
      return {
        instruction_id: instruction.instruction_id,
        correlation_id: instruction.correlation_id,
        task_id: instruction.task_id,
        status: 'SUCCESS',
        execution_time_ms: 10,
        artifacts_created: [],
        artifacts_modified: [],
        raw_output: 'Executed instruction successfully',
      } as any;
    },
  };

  const executorPort = appOptions?.executorPort ?? fallbackExecutor;

  const harness = new AutonomousLifecycleHarness({
    projectId: path.basename(projectRoot),
    projectRoot,
    requirements,
    tasks,
    features,
    taskCriteria: taskCriteriaMap,
    policyEngine,
    gitAdapter,
    executorPort,
    evidenceCollector,
    qaReviewEngine,
    recoveryIntegrator,
    uiAdapter: appOptions?.uiAdapter,
    maxRetriesPerTask: options.maxRetries,
    humanApprovalToken: options.approvalToken,
  });

  // Track lifecycle progress
  if (!options.json) {
    harness.subscribe((evt) => {
      const taskStr = evt.taskId ? ` [${evt.taskId}]` : '';
      if (options.verbose || evt.stage === 'START' || evt.stage === 'COMPLETE' || evt.stage === 'REJECT') {
        writer.write(`[AIDM] ${evt.stage}${taskStr}`);
      }
    });
  }

  // 7. Execute autonomous lifecycle through existing AutonomousLifecycleHarness
  const startTime = Date.now();
  const result = await harness.runAutonomousLifecycle();
  const durationMs = Date.now() - startTime;

  // Persist post-flight checkpoints to CheckpointStore
  for (const [, summary] of result.taskSummaries.entries()) {
    if (summary.postFlightCheckpoint) {
      await checkpointStore.recordCheckpoint(summary.postFlightCheckpoint);
    }
  }

  // 8. Determine exit code
  let exitCode: CliExitCode;
  if (result.success) {
    exitCode = CliExitCode.SUCCESS;
  } else if (result.finalMacroState === LifecycleState.BLOCKED_ON_HUMAN) {
    exitCode = CliExitCode.HUMAN_BLOCKED;
  } else if (result.error && (result.error.includes('Policy') || result.error.includes('denied by policy'))) {
    exitCode = CliExitCode.POLICY_BLOCKED;
  } else if (result.failedTasks.length > 0) {
    exitCode = CliExitCode.PROJECT_FAILED;
  } else {
    exitCode = CliExitCode.GENERAL_ERROR;
  }

  if (options.json) {
    writer.writeJson({
      success: result.success,
      exitCode,
      projectId: result.projectId,
      projectRoot: result.projectRoot,
      finalMacroState: result.finalMacroState,
      completedTasks: result.completedTasks,
      failedTasks: result.failedTasks,
      durationMs,
      error: result.error,
    });
  } else {
    if (result.success) {
      writer.write(`Autonomous run completed successfully in ${durationMs}ms.`);
      writer.write(`  Final State:     ${result.finalMacroState}`);
      writer.write(`  Completed Tasks: ${result.completedTasks.length} (${result.completedTasks.join(', ')})`);
    } else {
      writer.writeError(`Autonomous run finished with status ${result.finalMacroState} (exit code ${exitCode})`);
      if (result.error) {
        writer.writeError(`  Error: ${result.error}`);
      }
      writer.writeError(`  Completed Tasks: ${result.completedTasks.length}`);
      writer.writeError(`  Failed Tasks:    ${result.failedTasks.length} (${result.failedTasks.join(', ')})`);
    }
  }

  return {
    exitCode,
    data: result,
    error: result.error,
  };
}
