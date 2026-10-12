/**
 * @file run-checkpoint.ts
 * @description Crash-safe run checkpoint + lock liveness for resuming interrupted autonomous runs.
 *
 *   lock        : .ai-manager/state/autonomous-run.lock  { runId, pid, hostname, startedAt, heartbeatAt }
 *                 refreshed every HEARTBEAT_MS by the live run. A lock is STALE when its pid is gone
 *                 (or it is from another host / its heartbeat is older than STALE_AFTER_MS).
 *   checkpoint  : .ai-manager/state/autonomous-runs/<runId>.json  (no secrets, no tokens)
 *                 written on every run event; state RUNNING until the run finishes.
 *
 * An interrupted run = checkpoint state RUNNING and no ALIVE lock for it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUTONOMOUS_RUN_LOCK_FILE } from './autonomous-mandate.js';

const execFileAsync = promisify(execFile);

export const RUN_CHECKPOINT_DIR = path.join('.ai-manager', 'state', 'autonomous-runs');
export const HEARTBEAT_MS = 10_000;
/** A lock whose heartbeat is older than this is stale even if the pid exists (pid reuse). */
export const STALE_AFTER_MS = 10 * 60_000;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RunLock {
  readonly runId: string;
  readonly pid: number;
  readonly hostname?: string;
  readonly startedAt: string;
  heartbeatAt?: string;
}

export type LockLiveness = 'NONE' | 'ALIVE' | 'STALE';

export interface RunCheckpoint {
  readonly runId: string;
  readonly projectRoot: string;
  readonly specPath: string;
  readonly specFingerprint: string;
  readonly entryPoint: string;
  /** How the original run was authorized ('cli' operator invocation | 'idp' passkey). */
  readonly approval: 'cli' | 'idp';
  readonly budgetUsd: number;
  readonly maxCyclesPerTask?: number;
  readonly mandateHours?: number;
  readonly startedAt: string;
  state: 'RUNNING' | 'FINISHED';
  status?: string;
  stopReason?: string;
  /** 1 for the original run, +1 per resume. */
  segment: number;
  pid: number;
  updatedAt: string;
  currentTaskId: string | null;
  /** True between CYCLE_START and CYCLE_RESULT of currentTaskId (in-flight attempt). */
  inCycle: boolean;
  tasks: Array<{ taskId: string; status: string; cycles: number }>;
  commits: string[];
  /** Last run-monitor seq used (resumed segments continue above it). */
  monitorSeq: number;
  monitorUrl?: string;
  logPath?: string;
  reportPath?: string;
}

export function lockPathOf(projectRoot: string): string {
  return path.join(projectRoot, AUTONOMOUS_RUN_LOCK_FILE);
}

export function checkpointPathOf(projectRoot: string, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid runId '${runId}'`);
  return path.join(projectRoot, RUN_CHECKPOINT_DIR, `${runId.replace(/:/g, '_')}.json`);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but not ours -> alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRunLock(projectRoot: string): RunLock | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPathOf(projectRoot), 'utf8')) as RunLock;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    // Exists but unreadable/partial: treat as an anonymous lock (pid unknown).
    return fs.existsSync(lockPathOf(projectRoot)) ? { runId: '', pid: -1, startedAt: '' } : null;
  }
}

export function lockLiveness(lock: RunLock | null, now = Date.now()): LockLiveness {
  if (!lock) return 'NONE';
  if (lock.hostname && lock.hostname !== os.hostname()) {
    // Another machine (shared folder): only its heartbeat can tell.
    const hb = Date.parse(lock.heartbeatAt ?? lock.startedAt);
    return Number.isFinite(hb) && now - hb < STALE_AFTER_MS ? 'ALIVE' : 'STALE';
  }
  // Unknown/garbled owner: fail closed (never double-run on a lock we cannot attribute).
  if (typeof lock.pid !== 'number' || lock.pid <= 0) return 'ALIVE';
  if (lock.pid === process.pid) return 'ALIVE';
  if (!isPidAlive(lock.pid)) return 'STALE';
  const hb = Date.parse(lock.heartbeatAt ?? '');
  // Legacy lock (no heartbeat) with a live pid: assume alive (fail closed against double runs).
  if (!Number.isFinite(hb)) return 'ALIVE';
  return now - hb < STALE_AFTER_MS ? 'ALIVE' : 'STALE';
}

export function writeRunLock(projectRoot: string, lock: RunLock): void {
  const p = lockPathOf(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...lock, hostname: lock.hostname ?? os.hostname() }), 'utf8');
  fs.renameSync(tmp, p);
}

export function saveCheckpoint(cp: RunCheckpoint): void {
  try {
    cp.updatedAt = new Date().toISOString();
    const p = checkpointPathOf(cp.projectRoot, cp.runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch {
    /* checkpointing never breaks the run */
  }
}

export function loadCheckpoint(projectRoot: string, runId: string): RunCheckpoint | null {
  try {
    return JSON.parse(fs.readFileSync(checkpointPathOf(projectRoot, runId), 'utf8')) as RunCheckpoint;
  } catch {
    return null;
  }
}

export function listCheckpoints(projectRoot: string): RunCheckpoint[] {
  const dir = path.join(projectRoot, RUN_CHECKPOINT_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RunCheckpoint[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as RunCheckpoint);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export type RunLiveness = 'ALIVE' | 'INTERRUPTED' | 'FINISHED';

/** Classifies a checkpointed run using the project lock (the lock is written before any checkpoint). */
export function runLiveness(projectRoot: string, cp: RunCheckpoint): RunLiveness {
  if (cp.state === 'FINISHED') return 'FINISHED';
  const lock = readRunLock(projectRoot);
  if (lock && lock.runId === cp.runId && lockLiveness(lock) === 'ALIVE') return 'ALIVE';
  return 'INTERRUPTED';
}

export function listInterruptedRuns(projectRoot: string): RunCheckpoint[] {
  return listCheckpoints(projectRoot).filter((c) => runLiveness(projectRoot, c) === 'INTERRUPTED');
}

/**
 * Restores the worktree of an interrupted run to the last AIDM commit. Uncommitted changes left by
 * the interrupted attempt are STASHED (recoverable with `git stash list`), never destroyed.
 * Ignored files (.ai-manager/, node_modules, ...) are untouched.
 */
export async function stashInterruptedChanges(projectRoot: string, runId: string): Promise<{ stashed: boolean; files: string[] }> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: projectRoot,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const files = stdout
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3))
    .filter((p) => !p.startsWith('.ai-manager/'));
  if (files.length === 0) return { stashed: false, files };
  await execFileAsync('git', ['stash', 'push', '--include-untracked', '-m', `aidm-resume ${runId}: interrupted attempt`], { cwd: projectRoot, windowsHide: true });
  return { stashed: true, files };
}
