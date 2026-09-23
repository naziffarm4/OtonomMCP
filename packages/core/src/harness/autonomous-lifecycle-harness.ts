/**
 * Autonomous Lifecycle Harness & E2E Coordinator
 *
 * Coordinates the full Phase 1-6 autonomous development lifecycle:
 * REQUIREMENTS -> TASK GRAPH -> TASK SELECTION -> PRE-FLIGHT CHECKPOINT
 * -> ANTIGRAVITY EXECUTION BOUNDARY -> IMPLEMENTATION -> EVIDENCE COLLECTION
 * -> EVIDENCE VALIDATION -> CHATGPT REVIEW BOUNDARY -> ACCEPT / REJECT
 * -> RECOVERY / RETRY / RESTART -> GIT CHECKPOINT -> PROJECT COMPLETION
 *
 * Implements strict compliance with:
 * - DEC-001: User requirements are LOCKED and authoritative
 * - DEC-002: Role separation (Director Review vs Executor Implementation)
 * - DEC-003: Orchestrator is the sole state authority
 * - DEC-004: Decisions require SYSTEM_VERIFIED_EVIDENCE, not AGENT_CLAIM
 * - Non-bypassable PolicyEngine and Git checkpoint boundaries
 */

import { LifecycleState, TaskLoopState } from '../lifecycle.js';
import { StateMachine, TaskLoopStateMachine } from '../fsm/state-machine.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import { type TaskDefinition } from '../task-engine/task-types.js';
import { RiskLevel } from '../risk.js';
import {
  type AutonomousHarnessOptions,
  type AutonomousHarnessResult,
  type TaskExecutionSummary,
  type TaskExecutionAttempt,
} from './autonomous-harness-types.js';
import {
  ExecutorOperationType,
  PolicyAuthorizationState,
  validateExecutorInstruction,
} from '../executor-bridge/instruction-types.js';
import { EvidenceType, EvidenceSource, type SystemVerifiedEvidence } from '../evidence/evidence-types.js';
import { validateSystemVerifiedEvidence } from '../evidence/evidence-validator.js';
import { ReviewDecision, type ReviewResult, type AcceptanceCriterionInput, CriterionType } from '../qa-review/qa-review-types.js';
import { GitOperationType, GitCheckpointPurpose } from '../git/git-types.js';
import { OperationActionType, PolicyDecisionState } from '../policy/policy-types.js';
import { RecoveryDecision } from '../recovery/types.js';
import { PolicyViolationError } from '../errors/policy-violation-error.js';
import { InvalidEvidenceSourceError } from '../errors/evidence-error.js';

export interface TaskLifecycleListener {
  (event: {
    stage: 'START' | 'CHECKPOINT' | 'INSTRUCT' | 'IMPLEMENT' | 'EVIDENCE' | 'REVIEW' | 'ACCEPT' | 'REJECT' | 'RETRY' | 'RESTART' | 'COMPLETE';
    taskId: string;
    details?: unknown;
  }): void;
}

export class AutonomousLifecycleHarness {
  private readonly options: AutonomousHarnessOptions;
  private readonly macroFsm: StateMachine;
  private readonly dagEngine: TaskDagEngine;
  private readonly listeners: TaskLifecycleListener[] = [];

  private validatedTasks: TaskDefinition[] = [];
  private taskOrder: string[] = [];
  private taskSummaries: Map<string, TaskExecutionSummary> = new Map();
  private completedTaskIds: Set<string> = new Set();
  private failedTaskIds: Set<string> = new Set();

  constructor(options: AutonomousHarnessOptions) {
    this.options = options;
    this.macroFsm = new StateMachine({ initialState: LifecycleState.INITIALIZING });
    this.dagEngine = new TaskDagEngine();
  }

  getMacroState(): LifecycleState {
    return this.macroFsm.getState();
  }

  subscribe(listener: TaskLifecycleListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  private emit(
    stage: 'START' | 'CHECKPOINT' | 'INSTRUCT' | 'IMPLEMENT' | 'EVIDENCE' | 'REVIEW' | 'ACCEPT' | 'REJECT' | 'RETRY' | 'RESTART' | 'COMPLETE',
    taskId: string,
    details?: unknown
  ): void {
    for (const l of this.listeners) {
      try {
        l({ stage, taskId, details });
      } catch {
        // Suppress listener errors
      }
    }
  }

  /**
   * Initializes the autonomous development session.
   * Progresses macro state:
   * INITIALIZING -> REQUIREMENTS_INGESTION -> ARCHITECTURE_SPEC -> TASK_DECOMPOSITION -> TASK_SELECTION
   */
  async initialize(): Promise<void> {
    const { projectRoot, requirements, decisions, tasks, features, epics, policyEngine } = this.options;

    // Verify workspace boundary with PolicyEngine (prevent workspace escape)
    const accessDecision = policyEngine.evaluate({
      action_type: OperationActionType.FILE_READ,
      target_path: '.',
      project_root: projectRoot,
      is_read_only: true,
    });

    if (!accessDecision.allowed) {
      throw new PolicyViolationError(
        `Initial project access denied by policy: ${accessDecision.code}`,
        {
          decision: accessDecision.decision,
          riskLevel: accessDecision.risk_level,
          violations: accessDecision.violations,
        }
      );
    }

    // 1. INITIALIZING -> REQUIREMENTS_INGESTION
    this.macroFsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION, {
      requirementCount: requirements.length,
    });

    // Validate DEC-001: Requirements must be LOCKED and have USER authority
    for (const req of requirements) {
      if (req.status !== 'LOCKED') {
        throw new Error(`Requirement "${req.id}" must have status: 'LOCKED' (DEC-001)`);
      }
      if (req.authority !== 'USER') {
        throw new Error(`Requirement "${req.id}" must have authority: 'USER' (DEC-001)`);
      }
    }

    // 2. REQUIREMENTS_INGESTION -> ARCHITECTURE_SPEC
    this.macroFsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC, {
      decisions: decisions ?? [],
    });

    // 3. ARCHITECTURE_SPEC -> TASK_DECOMPOSITION
    this.macroFsm.transitionTo(LifecycleState.TASK_DECOMPOSITION);

    // Validate Task Graph using Kahn algorithm and structural integrity rules
    const graphInput = {
      tasks: tasks as any,
      features: (features ?? []) as any,
      epics: (epics ?? []) as any,
    };

    this.validatedTasks = this.dagEngine.assertValidGraph(graphInput);

    // 4. TASK_DECOMPOSITION -> TASK_SELECTION
    this.macroFsm.transitionTo(LifecycleState.TASK_SELECTION);

    // Determine deterministic topological ordering
    this.taskOrder = this.dagEngine.topologicalSort(graphInput);
  }

  /**
   * Executes the complete autonomous lifecycle loop across all tasks in the DAG.
   */
  async runAutonomousLifecycle(): Promise<AutonomousHarnessResult> {
    const startTime = Date.now();

    try {
      if (this.macroFsm.getState() === LifecycleState.INITIALIZING) {
        await this.initialize();
      }

      // Enter macro TASK_LOOP
      this.macroFsm.transitionTo(LifecycleState.TASK_LOOP);

      for (const taskId of this.taskOrder) {
        const task = this.validatedTasks.find((t) => t.task_id === taskId);
        if (!task) {
          throw new Error(`Task "${taskId}" not found in validated task list`);
        }

        const summary = await this.executeTaskLifecycle(task);
        this.taskSummaries.set(taskId, summary);

        if (summary.finalStatus === 'COMPLETED') {
          this.completedTaskIds.add(taskId);
        } else {
          this.failedTaskIds.add(taskId);
          // If a task fails or is rejected, fail closed
          return {
            success: false,
            projectId: this.options.projectId,
            projectRoot: this.options.projectRoot,
            finalMacroState: this.macroFsm.getState(),
            completedTasks: Array.from(this.completedTaskIds),
            failedTasks: Array.from(this.failedTaskIds),
            taskSummaries: this.taskSummaries,
            durationMs: Date.now() - startTime,
            error: `Task "${taskId}" terminated with status ${summary.finalStatus}`,
          };
        }
      }

      // Validate all tasks completed successfully
      if (this.completedTaskIds.size === this.validatedTasks.length) {
        // Complete the project
        this.macroFsm.transitionTo(LifecycleState.PROJECT_COMPLETE, {
          totalCompleted: this.completedTaskIds.size,
        });
      }

      return {
        success: this.completedTaskIds.size === this.validatedTasks.length,
        projectId: this.options.projectId,
        projectRoot: this.options.projectRoot,
        finalMacroState: this.macroFsm.getState(),
        completedTasks: Array.from(this.completedTaskIds),
        failedTasks: Array.from(this.failedTaskIds),
        taskSummaries: this.taskSummaries,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        projectId: this.options.projectId,
        projectRoot: this.options.projectRoot,
        finalMacroState: this.macroFsm.getState(),
        completedTasks: Array.from(this.completedTaskIds),
        failedTasks: Array.from(this.failedTaskIds),
        taskSummaries: this.taskSummaries,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Executes the granular nested TASK_LOOP state machine for an individual task.
   */
  async executeTaskLifecycle(task: TaskDefinition): Promise<TaskExecutionSummary> {
    const {
      projectId,
      projectRoot,
      taskCriteria,
      policyEngine,
      gitAdapter,
      executorPort,
      evidenceCollector,
      qaReviewEngine,
      recoveryIntegrator,
      uiAdapter,
      maxRetriesPerTask = 3,
      humanApprovalToken,
    } = this.options;

    const taskLoopFsm = new TaskLoopStateMachine(TaskLoopState.TASK_SELECTION);
    const taskId = task.task_id;
    this.emit('START', taskId);

    // 1. TASK_SELECTION -> PRE_FLIGHT_CHECKPOINT
    taskLoopFsm.transitionTo(TaskLoopState.PRE_FLIGHT_CHECKPOINT);

    // Policy check for checkpoint
    const cpPolicy = policyEngine.evaluate({
      command: `git checkpoint create --purpose PRE_FLIGHT --task ${taskId}`,
      project_root: projectRoot,
      action_type: OperationActionType.FILE_READ,
    });

    if (!cpPolicy.allowed) {
      throw new PolicyViolationError(
        `Pre-flight checkpoint rejected by policy: ${cpPolicy.code}`,
        { decision: cpPolicy.decision, riskLevel: cpPolicy.risk_level }
      );
    }

    const preFlightCheckpoint = await gitAdapter.createCheckpoint({
      task_id: taskId,
      purpose: GitCheckpointPurpose.PRE_FLIGHT,
      working_directory: projectRoot,
      phase: 'PHASE_7',
    });

    this.emit('CHECKPOINT', taskId, { checkpoint: preFlightCheckpoint });

    let currentAttempt = 0;
    const attempts: TaskExecutionAttempt[] = [];
    let isAccepted = false;
    let postFlightCheckpoint: typeof preFlightCheckpoint | undefined;

    // Resolve structured acceptance criteria for this task
    const structuredCriteria: AcceptanceCriterionInput[] =
      taskCriteria?.get(taskId) !== undefined
        ? [...taskCriteria.get(taskId)!]
        : task.acceptance_criteria.map((c, i) => ({
            criterion_id: `AC-${taskId}-${i + 1}`,
            description: c,
            criterion_type: CriterionType.COMMAND,
            is_mandatory: true,
            expected_exit_code: 0,
          }));

    while (currentAttempt < maxRetriesPerTask && !isAccepted) {
      currentAttempt++;
      const attemptStartTime = Date.now();
      const correlationId = `corr:${projectId}:${taskId}:attempt-${currentAttempt}`;
      const instructionId = `inst-${taskId}-${currentAttempt}-${Date.now()}`;

      // 2. (PRE_FLIGHT_CHECKPOINT or RETRY_STRATEGY_CHECK) -> INSTRUCT_ANTIGRAVITY
      taskLoopFsm.transitionTo(TaskLoopState.INSTRUCT_ANTIGRAVITY);
      this.emit('INSTRUCT', taskId, { attempt: currentAttempt });

      // Build and validate typed ExecutorInstruction
      const instructionInput = {
        task_id: taskId,
        instruction_id: instructionId,
        project_id: projectId,
        working_directory: projectRoot,
        objective: task.title,
        acceptance_criteria: task.acceptance_criteria,
        constraints: ['Follow strict project boundary', 'Never escape workspace root'],
        relevant_context: {
          files: [],
          requirements: task.traceability_sources,
          decisions: [],
          metadata: { attempt: currentAttempt },
        },
        attempt: currentAttempt,
        max_attempts: maxRetriesPerTask,
        risk_level: RiskLevel.CAUTION,
        requested_operation_type: ExecutorOperationType.IMPLEMENT_TASK,
        traceability_information: {
          sources: task.traceability_sources,
          parent_feature_id: task.parent_feature_id,
        },
        correlation_id: correlationId,
        policy_decision: {
          state: PolicyAuthorizationState.AUTHORIZED,
          decided_by: 'POLICY_ENGINE',
          decided_at: new Date().toISOString(),
          justification: 'Automated task instruction verified by policy',
        },
      };

      const instruction = validateExecutorInstruction(instructionInput);

      // Verify instruction with PolicyEngine
      const instrPolicy = policyEngine.evaluate({
        action_type: OperationActionType.FILE_MODIFY,
        target_path: projectRoot,
        project_root: projectRoot,
        mutates_source: true,
      });

      if (!instrPolicy.allowed) {
        throw new PolicyViolationError(
          `Instruction execution denied by policy: ${instrPolicy.code}`,
          { decision: instrPolicy.decision, riskLevel: instrPolicy.risk_level }
        );
      }

      // 3. INSTRUCT_ANTIGRAVITY -> IMPLEMENTATION
      taskLoopFsm.transitionTo(TaskLoopState.IMPLEMENTATION);
      this.emit('IMPLEMENT', taskId, { attempt: currentAttempt });

      await executorPort.execute(instruction);

      // 4. IMPLEMENTATION -> EVIDENCE_COLLECTION
      taskLoopFsm.transitionTo(TaskLoopState.EVIDENCE_COLLECTION);
      this.emit('EVIDENCE', taskId, { attempt: currentAttempt });

      const collectedEvidence: SystemVerifiedEvidence[] = [];

      // Collect evidence for each acceptance criterion
      for (const criterion of structuredCriteria) {
        const criterionId = criterion.criterion_id ?? `AC-${taskId}`;
        const evidenceId = `evi-${taskId}-${criterionId}-att${currentAttempt}`;

        if (criterion.criterion_type === 'UI' && uiAdapter) {
          // If task has explicit UI requirement, use UI verification
          const uiResult = await uiAdapter.verifyUI({
            task_id: taskId,
            project_id: projectId,
            correlation_id: correlationId,
            criterion_id: criterionId,
            target_url: 'http://localhost:3000',
            required_observations: ['DOM'],
            attempt: currentAttempt,
            max_attempts: maxRetriesPerTask,
          });
          if (uiResult.pipelineResult.evidence) {
            collectedEvidence.push(...uiResult.pipelineResult.evidence);
          }
        } else {
          // Command / Build / Test criteria
          const commandToRun = criterion.expected_command ?? 'node --test';

          // Policy check before running evidence collection command
          const cmdPolicy = policyEngine.evaluate({
            command: commandToRun,
            project_root: projectRoot,
          });

          if (!cmdPolicy.allowed) {
            throw new PolicyViolationError(
              `Evidence collection command blocked by policy: ${cmdPolicy.code}`,
              { command: commandToRun, decision: cmdPolicy.decision }
            );
          }

          const evi = await evidenceCollector.executeAndCollectCommandEvidence({
            evidence_id: evidenceId,
            task_id: taskId,
            project_id: projectId,
            correlation_id: correlationId,
            command: commandToRun,
            working_directory: projectRoot,
            evidence_type: criterion.criterion_type === 'TEST' ? EvidenceType.TEST : EvidenceType.COMMAND,
          });

          collectedEvidence.push(evi);
        }
      }

      // 5. EVIDENCE_COLLECTION -> ORCHESTRATOR_EVIDENCE_VALIDATION
      taskLoopFsm.transitionTo(TaskLoopState.ORCHESTRATOR_EVIDENCE_VALIDATION);

      // Invariant: Verify all evidence has SYSTEM_VERIFIED_EVIDENCE source
      for (const evi of collectedEvidence) {
        if (evi.source !== EvidenceSource.SYSTEM_VERIFIED_EVIDENCE) {
          throw new InvalidEvidenceSourceError(
            `Agent claims cannot satisfy system evidence requirement: source is '${evi.source}'`,
            { evidenceId: evi.evidence_id, source: evi.source }
          );
        }
        const valRes = validateSystemVerifiedEvidence(evi);
        if (!valRes.valid) {
          throw new Error(
            `Evidence validation failed for ${evi.evidence_id}: ${valRes.issues.map((e) => e.message).join(', ')}`
          );
        }
      }

      // 6. ORCHESTRATOR_EVIDENCE_VALIDATION -> CHATGPT_REVIEW
      taskLoopFsm.transitionTo(TaskLoopState.CHATGPT_REVIEW);

      // 7. CHATGPT_REVIEW -> ANALYZE_EVIDENCE
      taskLoopFsm.transitionTo(TaskLoopState.ANALYZE_EVIDENCE);
      this.emit('REVIEW', taskId, { attempt: currentAttempt });

      const reviewResult: ReviewResult = qaReviewEngine.review({
        task_id: taskId,
        project_id: projectId,
        correlation_id: correlationId,
        acceptance_criteria: structuredCriteria,
        evidence: collectedEvidence,
      });

      if (reviewResult.decision === ReviewDecision.ACCEPT) {
        isAccepted = true;
        this.emit('ACCEPT', taskId, { reviewResult });

        // 8a. ACCEPT -> POST_FLIGHT_COMMIT
        taskLoopFsm.transitionTo(TaskLoopState.ACCEPT);
        taskLoopFsm.transitionTo(TaskLoopState.POST_FLIGHT_COMMIT);

        // Policy check for commit
        const commitPolicy = policyEngine.evaluate({
          command: `git commit -m "aidm: complete ${taskId}"`,
          project_root: projectRoot,
          action_type: OperationActionType.FILE_MODIFY,
        });

        if (!commitPolicy.allowed) {
          throw new PolicyViolationError(
            `Post-flight commit blocked by policy: ${commitPolicy.code}`,
            { decision: commitPolicy.decision }
          );
        }

        // Execute commit and create post-flight checkpoint
        await gitAdapter.executeAuthorizedOperation(
          {
            operation: GitOperationType.COMMIT,
            commit_message: `aidm: complete ${taskId} (${task.title})`,
          },
          {
            allowed: true,
            risk_level: RiskLevel.CAUTION,
            decision: PolicyDecisionState.ALLOW,
          } as any,
          projectRoot
        );

        postFlightCheckpoint = await gitAdapter.createCheckpoint({
          task_id: taskId,
          purpose: GitCheckpointPurpose.POST_FLIGHT,
          working_directory: projectRoot,
          phase: 'PHASE_7',
        });

        // POST_FLIGHT_COMMIT -> CHECK_DAG_COMPLETION
        taskLoopFsm.transitionTo(TaskLoopState.CHECK_DAG_COMPLETION);
        this.emit('COMPLETE', taskId, { checkpoint: postFlightCheckpoint });

        attempts.push({
          attemptNumber: currentAttempt,
          instructionId,
          evidence: collectedEvidence,
          reviewResult,
          durationMs: Date.now() - attemptStartTime,
        });
        break;
      } else {
        // Review was REJECT (or REQUEST_CONTEXT)
        this.emit('REJECT', taskId, { reviewResult });

        // 8b. REJECT -> ROOT_CAUSE_ANALYSIS
        taskLoopFsm.transitionTo(TaskLoopState.REJECT);
        taskLoopFsm.transitionTo(TaskLoopState.ROOT_CAUSE_ANALYSIS);

        // ROOT_CAUSE_ANALYSIS -> RETRY_STRATEGY_CHECK
        taskLoopFsm.transitionTo(TaskLoopState.RETRY_STRATEGY_CHECK);

        const shouldRestart =
          currentAttempt >= maxRetriesPerTask && recoveryIntegrator !== undefined;

        const recoveryDecision = shouldRestart
          ? RecoveryDecision.RESTART
          : RecoveryDecision.RETRY;

        if (recoveryDecision === RecoveryDecision.RESTART && recoveryIntegrator) {
          this.emit('RESTART', taskId, { targetCheckpoint: preFlightCheckpoint.checkpoint_id });

          // Execute physical rollback back to PRE_FLIGHT checkpoint
          await recoveryIntegrator.processRecoveryDecision(
            {
              decision: RecoveryDecision.RESTART,
              reason: `Task ${taskId} failed review after ${currentAttempt} attempts. Rollback to known-good pre-flight state.`,
              taskId,
              iteration: currentAttempt,
              contextReference: null,
              resumePoint: TaskLoopState.INSTRUCT_ANTIGRAVITY,
              targetCheckpoint: preFlightCheckpoint.checkpoint_id,
            },
            {
              human_approval_token: humanApprovalToken,
              working_directory: projectRoot,
            }
          );
        } else {
          this.emit('RETRY', taskId, { nextAttempt: currentAttempt + 1 });
        }

        attempts.push({
          attemptNumber: currentAttempt,
          instructionId,
          evidence: collectedEvidence,
          reviewResult,
          recoveryDecision,
          durationMs: Date.now() - attemptStartTime,
        });
      }
    }

    return {
      taskId,
      attempts,
      finalStatus: isAccepted ? 'COMPLETED' : 'REJECTED',
      preFlightCheckpoint,
      postFlightCheckpoint,
      totalAttempts: currentAttempt,
    };
  }
}
