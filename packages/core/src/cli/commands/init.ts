import * as path from 'node:path';
import * as fs from 'node:fs';
import { type InitCommandOptions, type CliRunResult } from '../cli-types.js';
import { CliExitCode } from '../exit-codes.js';
import { type CliOutputWriter } from '../cli-output.js';
import { PolicyEngine } from '../../policy/policy-engine.js';
import { SpecStore } from '../../storage/spec-store.js';
import { DurableStateManager } from '../../storage/durable-state.js';
import { LocalRuntimeStateManager } from '../../storage/runtime-state.js';
import { HistoryManager } from '../../storage/history-manager.js';
import { LifecycleState } from '../../lifecycle.js';
import { Actor } from '../../actors.js';

export async function executeInit(
  options: InitCommandOptions,
  writer: CliOutputWriter
): Promise<CliRunResult> {
  const projectRoot = path.resolve(options.projectRoot);

  // 1. Verify target directory exists
  try {
    await fs.promises.access(projectRoot, fs.constants.F_OK);
  } catch {
    const msg = `Target directory does not exist: ${projectRoot}`;
    if (options.json) {
      writer.writeJson({ success: false, error: msg, exitCode: CliExitCode.USAGE_ERROR });
    } else {
      writer.writeError(`Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  // 2. Policy Engine evaluation
  const policyEngine = new PolicyEngine({ projectRoot });
  const initPolicy = policyEngine.evaluate({
    command: 'aidm init',
    project_root: projectRoot,
  });

  if (!initPolicy.allowed) {
    const msg = `Initialization blocked by policy: ${initPolicy.code}`;
    if (options.json) {
      writer.writeJson({
        success: false,
        error: msg,
        decision: initPolicy.decision,
        riskLevel: initPolicy.risk_level,
        exitCode: CliExitCode.POLICY_BLOCKED,
      });
    } else {
      writer.writeError(`Policy Error: ${msg}`);
    }
    return { exitCode: CliExitCode.POLICY_BLOCKED, error: msg };
  }

  // 3. Check for existing project initialization
  const durableManager = new DurableStateManager({ baseDir: projectRoot });
  const alreadyInitialized = await durableManager.exists();

  if (alreadyInitialized && !options.force) {
    const msg = `Project is already initialized at ${projectRoot}. Use --force to re-initialize.`;
    if (options.json) {
      writer.writeJson({
        success: false,
        error: msg,
        projectRoot,
        exitCode: CliExitCode.USAGE_ERROR,
      });
    } else {
      writer.writeError(`Error: ${msg}`);
    }
    return { exitCode: CliExitCode.USAGE_ERROR, error: msg };
  }

  // 4. Create directory structure
  const specDir = path.join(projectRoot, '.ai-manager', 'spec');
  const stateDir = path.join(projectRoot, '.ai-manager', 'state');
  const historyDir = path.join(projectRoot, '.ai-manager', 'history');
  const cacheDir = path.join(projectRoot, '.ai-manager', 'cache');

  await fs.promises.mkdir(specDir, { recursive: true });
  await fs.promises.mkdir(stateDir, { recursive: true });
  await fs.promises.mkdir(historyDir, { recursive: true });
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const projectName = options.projectName ?? path.basename(projectRoot);
  const now = new Date().toISOString();

  // 5. Initialize SpecStore with baseline governance decision DEC-001
  const specStore = new SpecStore({ specDir });
  await specStore.saveDecisions([
    {
      id: 'DEC-001',
      title: 'AIDM Project Baseline Governance',
      description: `Baseline governance established for project: ${projectName}`,
      authority: Actor.DIRECTOR,
      status: 'LOCKED',
      rationale: 'Initial project setup via aidm init.',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // If requirements don't exist or are empty, initialize empty requirements
  const existingReqs = await specStore.loadRequirements();
  if (existingReqs.length === 0) {
    await specStore.saveRequirements([]);
  }

  // 6. Initialize DurableState in INITIALIZING lifecycle state
  await durableManager.save({
    schemaVersion: 1,
    currentLifecycleState: LifecycleState.INITIALIZING,
    activeTaskId: null,
    completedTaskIds: [],
    blockedState: null,
    lastCheckpoint: null,
    updatedAt: now,
    metadata: {
      projectName,
      description: options.description ?? 'AIDM Managed Project',
      initializedAt: now,
    },
  });

  // 7. Initialize LocalRuntimeState
  const runtimeManager = new LocalRuntimeStateManager({ baseDir: projectRoot });
  await runtimeManager.save({
    schemaVersion: 1,
    processId: process.pid,
    acquiredLock: false,
    activeAttempt: 0,
    blockedState: null,
    metadata: { initializedAt: now },
  });

  // 8. Record initialization event in history
  const historyManager = new HistoryManager({ baseDir: projectRoot });
  await historyManager.appendEvent({
    eventType: 'PROJECT_INITIALIZED',
    actor: Actor.USER,
    payload: {
      projectRoot,
      projectName,
      timestamp: now,
    },
  });

  const responseData = {
    projectRoot,
    projectName,
    initialized: true,
    lifecycleState: LifecycleState.INITIALIZING,
    specDir,
    stateDir,
    historyDir,
    timestamp: now,
  };

  if (options.json) {
    writer.writeJson({
      success: true,
      data: responseData,
      exitCode: CliExitCode.SUCCESS,
    });
  } else {
    writer.write(`Initialized AIDM project at ${projectRoot}`);
    writer.write(`  Project Name:    ${projectName}`);
    writer.write(`  Lifecycle State: ${LifecycleState.INITIALIZING}`);
    writer.write(`  Spec Store:      .ai-manager/spec/`);
    writer.write(`  Durable State:   .ai-manager/state/durable-state.json`);
    writer.write(`  History Log:     .ai-manager/history/events.jsonl`);
  }

  return { exitCode: CliExitCode.SUCCESS, data: responseData };
}
