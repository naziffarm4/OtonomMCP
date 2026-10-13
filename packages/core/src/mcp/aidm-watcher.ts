/**
 * aidm watcher: picks up passkey-signed "Kaldığı yerden devam et" requests from the external IdP
 * and resumes that run as a detached worker (no Antigravity / MCP client needed).
 *
 * Safety: the IdP only creates a resume request after a fresh passkey (UV) assertion bound to the
 * runId. The watcher claims it (one winner), then starts the normal pkg-resume approval for the
 * run, carrying resumeRequestId; the IdP approves that request with the same passkey assertion and
 * issues the usual signed token, which the worker verifies (signature, binding, nonce) as always.
 * The watcher never sees passkeys or tokens and only acts on projects it was configured for.
 *
 * Usage: node dist/mcp/aidm-watcher.js --root <project> [--root <project> ...] [--interval 15] [--once]
 *        (roots may also come from AIDM_WATCH_ROOTS, separated by ';')
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdpClient, type IdpResumeRequest } from '../autonomous/idp-client.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { loadCheckpoint, runLiveness, isResumableBlockedRun, isPidAlive } from '../autonomous/run-checkpoint.js';

type Env = Readonly<Record<string, string | undefined>>;
export interface WatcherOptions {
  readonly roots: readonly string[];
  readonly env?: Env;
  readonly fetchFn?: typeof fetch;
  /** Starts the resume; default: the MCP resume handler (detached worker). Tests inject. */
  readonly startResume?: (root: string, runId: string, resumeId: string) => Promise<{ ok: boolean; note: string }>;
  readonly log?: (line: string) => void;
  /** IdP poll outcome; when set, poll failures are reported here instead of logged per tick. */
  readonly onPollState?: (ok: boolean, message?: string) => void;
}

export interface WatcherTickResult {
  resumeId: string;
  runId: string;
  outcome: 'STARTED' | 'FAILED' | 'SKIPPED';
  note: string;
}

async function defaultStart(root: string, runId: string, resumeId: string, env: Env): Promise<{ ok: boolean; note: string }> {
  const cp = loadCheckpoint(root, runId);
  if (!cp) return { ok: false, note: `checkpoint not found for ${runId}` };
  const { createAutonomousStartHandler } = await import('./tools/autonomous-start-tool.js');
  const res = await createAutonomousStartHandler({ env, detachedWorker: true })(
    { specPath: cp.specPath, workspaceRoot: root, resumeRunId: runId, resumeRequestId: resumeId },
    {} as never
  );
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(res.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { ok: !res.isError && payload.success !== false, note: String(payload.code ?? (res.isError ? 'ERROR' : 'OK')) + (payload.workerPid ? ` pid ${payload.workerPid}` : '') };
}

/** One poll: claim and start every pending resume request that belongs to a configured project. */
export async function watcherTick(o: WatcherOptions): Promise<WatcherTickResult[]> {
  const env = o.env ?? process.env;
  const log = o.log ?? (() => {});
  const byProject = new Map<string, string>();
  for (const r of o.roots) {
    try {
      byProject.set(resolveCanonicalProjectIdentity(path.resolve(r)).projectId, path.resolve(r));
    } catch {
      log(`skip root ${r}: no project identity`);
    }
  }
  const out: WatcherTickResult[] = [];
  let items: IdpResumeRequest[];
  let client: IdpClient;
  try {
    client = new IdpClient({ env, fetchFn: o.fetchFn });
    items = await client.listResumeRequests();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (o.onPollState) o.onPollState(false, m);
    else log(`IdP poll failed: ${m}`);
    return out;
  }
  o.onPollState?.(true);
  for (const it of items) {
    const root = byProject.get(it.projectId);
    if (!root) continue; // another watcher's project
    const cp = loadCheckpoint(root, it.runId);
    const live = cp ? runLiveness(root, cp) : null;
    const resumable = !!cp && (live === 'INTERRUPTED' || (live === 'FINISHED' && isResumableBlockedRun(cp)));
    if (!(await client.claimResumeRequest(it.resumeId))) {
      out.push({ resumeId: it.resumeId, runId: it.runId, outcome: 'SKIPPED', note: 'claimed elsewhere' });
      continue;
    }
    if (!resumable) {
      const note = !cp ? 'run not found in project' : `run is not resumable (${live}/${cp.status ?? '-'})`;
      await client.reportResumeRequest(it.resumeId, 'FAILED', note).catch(() => {});
      out.push({ resumeId: it.resumeId, runId: it.runId, outcome: 'FAILED', note });
      log(`${it.runId}: ${note}`);
      continue;
    }
    let r: { ok: boolean; note: string };
    try {
      r = o.startResume ? await o.startResume(root, it.runId, it.resumeId) : await defaultStart(root, it.runId, it.resumeId, env);
    } catch (err) {
      r = { ok: false, note: err instanceof Error ? err.message : String(err) };
    }
    await client.reportResumeRequest(it.resumeId, r.ok ? 'STARTED' : 'FAILED', r.note).catch(() => {});
    out.push({ resumeId: it.resumeId, runId: it.runId, outcome: r.ok ? 'STARTED' : 'FAILED', note: r.note });
    log(`${it.runId}: ${r.ok ? 'resume started' : 'resume failed'} (${r.note})`);
  }
  return out;
}

function parseArgs(argv: string[], env: Env): { roots: string[]; interval: number; once: boolean } {
  const roots: string[] = [];
  let interval = 15;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) roots.push(argv[++i]!);
    else if (argv[i] === '--interval' && argv[i + 1]) interval = Math.max(5, Number(argv[++i]) || 15);
    else if (argv[i] === '--once') once = true;
  }
  for (const r of (env.AIDM_WATCH_ROOTS ?? '').split(';')) if (r.trim()) roots.push(r.trim());
  return { roots, interval, once };
}

/**
 * The OtonomMCP server's own env block from the Antigravity MCP config (the same settings the MCP
 * server runs with). Only AIDM_* / OPENAI_* keys, only when not already set; values are never logged.
 */
export function envFromMcpConfig(env: Env): Record<string, string> {
  const file = env.AIDM_WATCH_MCP_CONFIG || path.join(env.USERPROFILE || env.HOME || '.', '.gemini', 'config', 'mcp_config.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, unknown> }> };
    const servers = j.mcpServers ?? {};
    const name = env.AIDM_WATCH_MCP_SERVER || Object.keys(servers).find((k) => /otonom|aidm/i.test(k));
    const src = (name && servers[name]?.env) || {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) if (/^(AIDM_|OPENAI_)/.test(k) && typeof v === 'string' && !env[k]) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Persisted list of projects to watch (every run start registers its project). */
export function watcherRootsFile(env: Env): string | null {
  if (env.AIDM_WATCH_ROOTS_FILE) return env.AIDM_WATCH_ROOTS_FILE;
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'aidm', 'watcher-roots.json') : null;
}
const sameRoot = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
export function readWatcherRoots(env: Env): string[] {
  const f = watcherRootsFile(env);
  if (!f) return [];
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { roots?: unknown };
    return Array.isArray(j.roots) ? j.roots.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  } catch {
    return [];
  }
}
/** Adds a project root to the watcher list (idempotent, best effort; never throws). */
export function registerWatcherRoot(root: string, env: Env): boolean {
  const f = watcherRootsFile(env);
  if (!f) return false;
  try {
    const abs = path.resolve(root);
    // Throwaway projects (tests, scratch runs in the temp folder) are never watched.
    const t = path.resolve(env.AIDM_WATCH_TMPDIR || os.tmpdir());
    const realT = (() => { try { return fs.realpathSync.native(t); } catch { return t; } })();
    const realA = (() => { try { return fs.realpathSync.native(abs); } catch { return abs; } })();
    const under = (a: string, b: string) => { const rel = path.relative(b, a); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    if (under(abs, t) || under(realA, realT) || (process.platform === 'win32' && under(abs.toLowerCase(), t.toLowerCase()))) return false;
    const roots = readWatcherRoots(env);
    if (roots.some((r) => sameRoot(path.resolve(r), abs))) return true;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ roots: [...roots, abs] }, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch {
    return false;
  }
}
function mergeRoots(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of [...a, ...b]) if (!out.some((x) => sameRoot(path.resolve(x), path.resolve(r)))) out.push(r);
  return out;
}

/** Single instance: returns a release function, or null when another live watcher holds the lock. */
export function acquireWatcherLock(lockFile: string, pid = process.pid): (() => void) | null {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lockFile, String(pid), { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(lockFile, 'utf8').trim() === String(pid)) fs.rmSync(lockFile, { force: true });
        } catch { /* gone */ }
      };
    } catch {
      const other = Number(fs.readFileSync(lockFile, 'utf8').trim());
      if (other && other !== pid && isPidAlive(other)) return null;
      fs.rmSync(lockFile, { force: true }); // stale lock
    }
  }
  return null;
}

/** IdP poll state: logs only on change, backs off up to maxS while the IdP is unreachable. */
export function pollBackoff(baseS: number, maxS = 60) {
  let down = false;
  let delay = baseS;
  return {
    update(ok: boolean, message: string | undefined, log: (l: string) => void): void {
      if (ok) {
        if (down) log('IdP reachable again');
        down = false;
        delay = baseS;
      } else {
        if (!down) log(`IdP unreachable: ${message ?? ''} (retrying with backoff up to ${maxS}s; logged once)`);
        down = true;
        delay = Math.min(maxS, delay * 2);
      }
    },
    get delayS() {
      return delay;
    },
  };
}

export async function main(argv = process.argv.slice(2), baseEnv: Env = process.env): Promise<void> {
  const fromCfg = envFromMcpConfig(baseEnv);
  // Workers spawned for a resume inherit this process env.
  for (const [k, v] of Object.entries(fromCfg)) process.env[k] = v;
  const env: Env = { ...baseEnv, ...fromCfg };
  const { roots: argRoots, interval, once } = parseArgs(argv, env);
  const logFile = env.AIDM_WATCH_LOG || path.join(env.LOCALAPPDATA || env.HOME || '.', 'aidm', 'aidm-watcher.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = (l: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${l}\n`);
  const release = once ? () => {} : acquireWatcherLock(path.join(path.dirname(logFile), 'aidm-watcher.lock'));
  if (!release) {
    log(`another watcher is already running; pid ${process.pid} exits`);
    return;
  }
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => process.exit(0));
  // Command-line roots are registered too, so the list survives without the arguments.
  for (const r of argRoots) registerWatcherRoot(r, env);
  const backoff = pollBackoff(interval);
  let lastCount = -1;
  for (;;) {
    const roots = mergeRoots(argRoots, readWatcherRoots(env)).filter((r) => fs.existsSync(r));
    if (roots.length !== lastCount) {
      log(`watching ${roots.length} project(s), every ${interval}s; settings from MCP config: ${Object.keys(fromCfg).length} key(s)`);
      lastCount = roots.length;
    }
    if (roots.length) await watcherTick({ roots, env, log, onPollState: (ok, m) => backoff.update(ok, m, log) });
    if (once) return;
    await new Promise((r) => setTimeout(r, (roots.length ? backoff.delayS : interval) * 1000));
  }
}

const invoked = process.argv[1] && /aidm-watcher\.(js|ts)$/.test(process.argv[1]);
if (invoked) void main();
