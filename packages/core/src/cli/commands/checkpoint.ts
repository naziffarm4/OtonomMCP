import * as path from 'node:path';
import { type CheckpointCommandOptions, type CliRunResult } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import { CheckpointStore } from '../checkpoint-store.js';
import { PolicyEngine } from '../../policy/policy-engine.js';
import { DefaultGitPort } from '../../git/default-git-port.js';
import { GitCheckpointManager } from '../../git/git-checkpoint-manager.js';
import { DefaultGitAdapter } from '../../adapters/git-adapter.js';
import { GitCheckpointPurpose } from '../../git/git-types.js';
import { DurableStateManager } from '../../storage/durable-state.js';
import { OperationActionType } from '../../policy/policy-types.js';

export async function executeCheckpoint(
  options: CheckpointCommandOptions,
  writer: CliOutputWriter
): Promise<CliRunResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const checkpointStore = new CheckpointStore(projectRoot);

  const policyEngine = new PolicyEngine({ projectRoot });
  const gitPort = new DefaultGitPort();
  const checkpointManager = new GitCheckpointManager(gitPort, {
    defaultWorkingDirectory: projectRoot,
  });
  const gitAdapter = new DefaultGitAdapter(checkpointManager, gitPort);

  switch (options.action) {
    case 'list': {
      const stored = await checkpointStore.loadCheckpoints();
      if (options.json) {
        writer.writeJson({
          success: true,
          exitCode: CliExitCode.SUCCESS,
          checkpoints: stored,
        });
      } else {
        writer.write(`Checkpoints in ${projectRoot}: (${stored.length} total)`);
        if (stored.length === 0) {
          writer.write('  No checkpoints recorded.');
        } else {
          for (const cp of stored) {
            writer.write(
              `  - [${cp.checkpoint_id}] Task: ${cp.task_id} | Purpose: ${cp.purpose} | Commit: ${cp.commit_sha?.slice(0, 8)} | Date: ${cp.created_at}`
            );
          }
        }
      }
      return { exitCode: CliExitCode.SUCCESS, data: stored };
    }

    case 'create': {
      if (!options.taskId) {
        const msg = 'Missing required option: --task <task_id>';
        if (options.json) {
          writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
        } else {
          writer.writeError(`Usage Error: ${msg}`);
        }
        return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
      }

      // Policy check before creating checkpoint
      const cpPolicy = policyEngine.evaluate({
        command: `git checkpoint create --task ${options.taskId}`,
        project_root: projectRoot,
        target_path: options.taskId,
        action_type: OperationActionType.FILE_READ,
      });

      if (!cpPolicy.allowed) {
        const msg = `Checkpoint creation blocked by policy: ${cpPolicy.code}`;
        if (options.json) {
          writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.POLICY_BLOCKED });
        } else {
          writer.writeError(`Policy Error: ${msg}`);
        }
        return { exitCode: CliExitCode.POLICY_BLOCKED, error: msg };
      }

      const purpose = (options.purpose?.toUpperCase() as GitCheckpointPurpose) ?? GitCheckpointPurpose.MANUAL;

      try {
        const checkpoint = await gitAdapter.createCheckpoint({
          task_id: options.taskId,
          purpose,
          working_directory: projectRoot,
          phase: 'PHASE_7',
        });

        // Persist checkpoint to disk
        await checkpointStore.recordCheckpoint(checkpoint);

        // Update durable state if initialized
        const durableManager = new DurableStateManager({ baseDir: projectRoot });
        if (await durableManager.exists()) {
          const current = await durableManager.load();
          if (current) {
            await durableManager.save({
              currentLifecycleState: current.currentLifecycleState,
              completedTaskIds: current.completedTaskIds,
              activeTaskId: current.activeTaskId,
              blockedState: current.blockedState,
              lastCheckpoint: checkpoint.checkpoint_id,
              metadata: current.metadata,
            });
          }
        }

        const data = {
          checkpointId: checkpoint.checkpoint_id,
          taskId: checkpoint.task_id,
          commitSha: checkpoint.commit_sha,
          purpose: checkpoint.purpose,
          branch: checkpoint.branch,
          createdAt: checkpoint.created_at,
        };

        if (options.json) {
          writer.writeJson({
            success: true,
            exitCode: CliExitCode.SUCCESS,
            data,
          });
        } else {
          writer.write(`Created checkpoint ${checkpoint.checkpoint_id}`);
          writer.write(`  Task:    ${checkpoint.task_id}`);
          writer.write(`  Commit:  ${checkpoint.commit_sha}`);
          writer.write(`  Purpose: ${checkpoint.purpose}`);
          writer.write(`  Branch:  ${checkpoint.branch}`);
        }

        return { exitCode: CliExitCode.SUCCESS, data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.GENERAL_ERROR });
        } else {
          writer.writeError(`Error creating checkpoint: ${msg}`);
        }
        return { exitCode: CliExitCode.GENERAL_ERROR, error: msg };
      }
    }

    case 'rollback': {
      if (!options.checkpointId) {
        const msg = 'Missing required option: --checkpoint <checkpoint_id>';
        if (options.json) {
          writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
        } else {
          writer.writeError(`Usage Error: ${msg}`);
        }
        return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
      }

      // Rollback is a dangerous operation - evaluate policy engine
      const rollbackPolicy = policyEngine.evaluate({
        command: `git rollback ${options.checkpointId}`,
        project_root: projectRoot,
        action_type: OperationActionType.FILE_MODIFY,
        human_approval_token: options.approvalToken,
      });

      if (!rollbackPolicy.allowed) {
        const isHumanRequired =
          rollbackPolicy.decision === 'REQUIRE_HUMAN' ||
          Boolean((rollbackPolicy as any).requires_human_authorization) ||
          rollbackPolicy.code === 'ERR_APPROVAL_TOKEN_REQUIRED' ||
          rollbackPolicy.code === 'ERR_APPROVAL_TOKEN_INVALID';
        const exitCode = isHumanRequired ? CliExitCode.HUMAN_BLOCKED : CliExitCode.POLICY_BLOCKED;
        const msg = `Rollback blocked by policy: ${rollbackPolicy.code} (Human approval token required for dangerous rollback)`;

        if (options.json) {
          writer.writeJson({
            success: false,
            error: msg,
            exitCode,
            requiresHumanApproval: true,
            code: rollbackPolicy.code,
          });
        } else {
          writer.writeError(`Policy Blocked: ${msg}`);
          writer.writeError('Provide a valid human approval token with --token <token>');
        }
        return { exitCode, error: msg };
      }

      try {
        // Execute rollback via GitAdapter
        const rollbackResult = await gitAdapter.rollback(options.checkpointId, {
          working_directory: projectRoot,
          human_approval_token: options.approvalToken,
        });

        // Update durable state
        const durableManager = new DurableStateManager({ baseDir: projectRoot });
        if (await durableManager.exists()) {
          const current = await durableManager.load();
          if (current) {
            await durableManager.save({
              currentLifecycleState: current.currentLifecycleState,
              completedTaskIds: current.completedTaskIds,
              activeTaskId: current.activeTaskId,
              blockedState: current.blockedState,
              lastCheckpoint: options.checkpointId,
              metadata: current.metadata,
            });
          }
        }

        const data = {
          checkpointId: options.checkpointId,
          targetCommitSha: rollbackResult.target_commit_sha,
          resultingHeadSha: rollbackResult.resulting_head_sha,
          success: rollbackResult.success,
        };

        if (options.json) {
          writer.writeJson({
            success: true,
            exitCode: CliExitCode.SUCCESS,
            data,
          });
        } else {
          writer.write(`Successfully rolled back to checkpoint ${options.checkpointId}`);
          writer.write(`  Target SHA:    ${rollbackResult.target_commit_sha}`);
          writer.write(`  Resulting HEAD: ${rollbackResult.resulting_head_sha}`);
        }

        return { exitCode: CliExitCode.SUCCESS, data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.GENERAL_ERROR });
        } else {
          writer.writeError(`Error during rollback: ${msg}`);
        }
        return { exitCode: CliExitCode.GENERAL_ERROR, error: msg };
      }
    }

    case 'help':
    default: {
      const helpText = `aidm checkpoint <action> [options]

Actions:
  list                           List recorded checkpoints
  create --task <id>             Create a new checkpoint for task
  rollback --checkpoint <id>     Roll back repository to checkpoint (requires --token)

Options:
  --task <taskId>                Task ID for checkpoint
  --purpose <purpose>            PRE_FLIGHT, POST_FLIGHT, MANUAL (default: MANUAL)
  --checkpoint <id>              Checkpoint ID for rollback
  --token <token>                Human approval token for rollback
  --project-root, -C <path>      Project root directory
  --json                         Output result in JSON format
`;
      writer.write(helpText);
      return { exitCode: CliExitCode.SUCCESS, message: helpText };
    }
  }
}
