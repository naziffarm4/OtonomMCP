import * as path from 'node:path';
import { type StatusCommandOptions, type CliRunResult } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import { DurableStateManager } from '../../storage/durable-state.js';
import { SpecStore } from '../../storage/spec-store.js';
import { CheckpointStore } from '../checkpoint-store.js';
import { DefaultGitPort } from '../../git/default-git-port.js';

export async function executeStatus(
  options: StatusCommandOptions,
  writer: CliOutputWriter
): Promise<CliRunResult> {
  const projectRoot = path.resolve(options.projectRoot);

  const durableManager = new DurableStateManager({ baseDir: projectRoot });
  const isInitialized = await durableManager.exists();

  if (!isInitialized) {
    const data = {
      projectRoot,
      initialized: false,
      message: 'Project is not initialized. Run "aidm init" to initialize.',
    };
    if (options.json) {
      writer.writeJson({
        success: false,
        exitCode: CliExitCode.USAGE_ERROR,
        data,
      });
    } else {
      writer.write(`Project at ${projectRoot} is not initialized.`);
      writer.write('Run "aidm init" to initialize.');
    }
    return { exitCode: CliExitCode.USAGE_ERROR, data };
  }

  // 1. Read Durable State
  const durableState = await durableManager.load();
  if (!durableState) {
    const msg = `Failed to load durable state from ${durableManager.filePath}`;
    if (options.json) {
      writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.GENERAL_ERROR });
    } else {
      writer.writeError(`Error: ${msg}`);
    }
    return { exitCode: CliExitCode.GENERAL_ERROR, error: msg };
  }

  // 2. Read Spec Store
  const specStore = new SpecStore({ baseDir: projectRoot });
  let requirementsCount = 0;
  let decisionsCount = 0;
  try {
    const reqs = await specStore.loadRequirements();
    requirementsCount = reqs.length;
  } catch {
    // Requirements might not be initialized yet
  }
  try {
    const decs = await specStore.loadDecisions();
    decisionsCount = decs.length;
  } catch {
    // Decisions might not be initialized yet
  }

  // 3. Read Checkpoints
  const checkpointStore = new CheckpointStore(projectRoot);
  const checkpoints = await checkpointStore.loadCheckpoints();

  // 4. Inspect Git State (safe read-only)
  let gitState: { branch?: string; headSha?: string; clean?: boolean } | null = null;
  try {
    const gitPort = new DefaultGitPort();
    const observed = await gitPort.inspectState(projectRoot);
    gitState = {
      branch: observed.current_branch ?? undefined,
      headSha: observed.head_sha ?? undefined,
      clean: observed.working_tree_clean,
    };
  } catch {
    // Git repo might not exist in directory
  }

  const isBlocked = Boolean(durableState.blockedState);

  const statusData = {
    projectRoot,
    initialized: true,
    lifecycleState: durableState.currentLifecycleState,
    activeTaskId: durableState.activeTaskId,
    completedTasksCount: durableState.completedTaskIds.length,
    completedTaskIds: durableState.completedTaskIds,
    lastCheckpoint: durableState.lastCheckpoint,
    totalCheckpoints: checkpoints.length,
    specifications: {
      requirementsCount,
      decisionsCount,
    },
    isBlocked,
    blockedState: durableState.blockedState ?? null,
    git: gitState,
    updatedAt: durableState.updatedAt,
  };

  if (options.json) {
    writer.writeJson({
      success: true,
      exitCode: CliExitCode.SUCCESS,
      data: statusData,
    });
  } else {
    writer.write(`AIDM Project Status: ${projectRoot}`);
    writer.write(`  Lifecycle State:    ${durableState.currentLifecycleState}`);
    writer.write(`  Active Task:        ${durableState.activeTaskId ?? 'none'}`);
    writer.write(`  Completed Tasks:    ${durableState.completedTaskIds.length}`);
    writer.write(`  Requirements:       ${requirementsCount}`);
    writer.write(`  Decisions:          ${decisionsCount}`);
    writer.write(`  Last Checkpoint:    ${durableState.lastCheckpoint ?? 'none'}`);
    writer.write(`  Total Checkpoints:  ${checkpoints.length}`);

    if (gitState) {
      writer.write(`  Git Branch:         ${gitState.branch ?? 'unknown'}`);
      writer.write(`  Git HEAD:           ${gitState.headSha ?? 'unknown'}`);
      writer.write(`  Working Tree Clean: ${gitState.clean ? 'YES' : 'NO'}`);
    }

    if (isBlocked && durableState.blockedState) {
      writer.write('\n[BLOCKED STATE]');
      writer.write(`  Reason:             ${durableState.blockedState.blockingReason}`);
      writer.write(`  Blocked Task:       ${durableState.blockedState.blockedTaskId ?? 'none'}`);
      writer.write(`  Blocked Iteration:  ${durableState.blockedState.blockedIteration}`);
      writer.write(`  Resume Point:       ${durableState.blockedState.resumePoint}`);
    }
  }

  return { exitCode: CliExitCode.SUCCESS, data: statusData };
}
