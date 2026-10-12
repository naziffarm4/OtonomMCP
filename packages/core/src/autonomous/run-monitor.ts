/**
 * @file run-monitor.ts
 * @description One-way, informational live run monitor (contract: docs/EXTERNAL-IDP-RUN-MONITOR.md).
 * OtonomMCP -> IdP only. Fire-and-forget: bounded queue, batching, 2 s timeout per request,
 * no retries beyond the next flush, never throws into / blocks / influences the run.
 * Never sends secrets, prompts, AGY output, file contents or env values: only short,
 * truncated plain-text status lines that the runner already produces.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const RUN_MONITOR_EVENT_TYPES = [
  'RUN_STARTED', 'APPROVAL_REQUESTED', 'MANDATE_SEALED', 'CYCLE_START', 'DIRECTOR_ACTION', 'AGY_DISPATCH',
  'AGY_RESULT', 'VERIFICATION', 'CYCLE_RESULT', 'REPLAN', 'ANALYSIS', 'DECISION_REQUESTED', 'DECISION_ANSWERED',
  'TASK_ACCEPTED', 'TASK_BLOCKED', 'COMMIT', 'BUDGET', 'RUN_FINISHED', 'INFO',
] as const;
export type RunMonitorEventType = (typeof RUN_MONITOR_EVENT_TYPES)[number];

export type RunMonitorStatus =
  | 'PENDING_APPROVAL' | 'RUNNING' | 'BLOCKED_ON_HUMAN' | 'WAITING_DECISION' | 'COMPLETED'
  | 'FAILED' | 'STOPPED' | 'CONFIGURATION_ERROR' | 'REJECTED';

export interface RunMonitorTask {
  taskId: string;
  title: string;
  status: string;
  cycles: number;
  maxAttempts?: number;
  lastSummary?: string | null;
}

export interface RunMonitorSnapshot {
  runId: string;
  seq: number;
  projectId: string;
  projectName: string;
  entryPoint: 'aidm_run_spec' | 'aidm_autonomous_start';
  status: RunMonitorStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  model?: string;
  budget: { limitUsd: number; committedUsd: number; reservedUsd: number };
  currentTaskId?: string | null;
  tasks: RunMonitorTask[];
  lastDirectorAction?: { actionType: string; taskId?: string | null; rationale: string; at: string } | null;
  pendingApprovalId?: string | null;
  pendingDecisionIds: string[];
  stopReason?: string | null;
}

export type RunMonitorSnapshotInput = Omit<RunMonitorSnapshot, 'seq' | 'updatedAt'>;

export interface RunMonitorEvent {
  seq: number;
  at: string;
  type: RunMonitorEventType;
  level: 'info' | 'warn' | 'error';
  taskId?: string | null;
  message: string;
}

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUEUE = 500;
const MAX_BATCH = 50;
const REQUEST_TIMEOUT_MS = 2000;
const FINAL_FLUSH_MS = 3000;

// Secret-looking substrings are masked even in the short status lines we send.
const SECRET_RES: RegExp[] = [
  /\b(sk|xai|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWS/JWT
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
];

/** Plain text, no control chars, secrets masked, truncated. */
export function monitorText(value: unknown, max: number): string {
  let s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  for (const re of SECRET_RES) s = s.replace(re, '[redacted]');
  s = s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
    // Bidi overrides/isolates, zero-width and BOM characters are rejected by the IdP contract.
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function str(value: unknown, max: number, fallback = ''): string {
  const t = monitorText(value, max);
  return t || fallback;
}

function nonNeg(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

export function isRunMonitorEnabled(env: Env = process.env): boolean {
  if ((env.AIDM_IDP_RUN_MONITOR ?? '').trim().toLowerCase() === 'off') return false;
  return Boolean(env.AIDM_IDP_URL?.trim() && env.AIDM_IDP_CLIENT_TOKEN?.trim());
}

export function monitorBaseUrl(env: Env = process.env): string | null {
  const raw = env.AIDM_IDP_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (u.username || u.password) return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Browser URL of the run page (IdP UI, hash route). */
export function runMonitorUrl(env: Env, runId: string): string | null {
  const base = monitorBaseUrl(env);
  return base ? `${base}/#/runs/${encodeURIComponent(runId)}` : null;
}

export interface RunMonitorOptions {
  readonly env?: Env;
  readonly fetchFn?: typeof fetch;
  readonly runId: string;
  /** Debounce for snapshot PUTs (default 1000 ms). */
  readonly snapshotDebounceMs?: number;
  /** Batch interval for event POSTs (default 500 ms). */
  readonly flushIntervalMs?: number;
}

export interface RunMonitorStats {
  sent: number;
  failed: number;
  dropped: number;
}

/**
 * Fire-and-forget reporter. All public methods are synchronous (except close) and never throw.
 */
export class RunMonitor {
  readonly runId: string;
  readonly stats: RunMonitorStats = { sent: 0, failed: 0, dropped: 0 };
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private seq = 0;
  private events: RunMonitorEvent[] = [];
  private pendingSnapshot: RunMonitorSnapshot | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private closed = false;
  private snapshotSentOnce = false;

  /** Returns null when the monitor is disabled or misconfigured (never throws). */
  static create(options: RunMonitorOptions): RunMonitor | null {
    try {
      const env = options.env ?? process.env;
      if (!isRunMonitorEnabled(env)) return null;
      const base = monitorBaseUrl(env);
      if (!base || !RUN_ID_RE.test(options.runId)) return null;
      return new RunMonitor(options, base, env.AIDM_IDP_CLIENT_TOKEN!.trim());
    } catch {
      return null;
    }
  }

  private constructor(options: RunMonitorOptions, base: string, token: string) {
    this.runId = options.runId;
    this.base = base;
    this.token = token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.debounceMs = options.snapshotDebounceMs ?? 1000;
    this.intervalMs = options.flushIntervalMs ?? 500;
  }

  private nextSeq(): number {
    return this.seq++;
  }

  snapshot(input: RunMonitorSnapshotInput, immediate = false): void {
    if (this.closed) return;
    try {
      this.pendingSnapshot = this.sanitizeSnapshot(input);
      if (immediate || !this.snapshotSentOnce) this.scheduleSnapshot(0);
      else this.scheduleSnapshot(this.debounceMs);
    } catch {
      /* never throws */
    }
  }

  event(type: RunMonitorEventType, message: string, taskId?: string | null, level: RunMonitorEvent['level'] = 'info'): void {
    if (this.closed) return;
    try {
      const msg = str(message, 500, type);
      this.events.push({
        seq: this.nextSeq(),
        at: new Date().toISOString(),
        type: (RUN_MONITOR_EVENT_TYPES as readonly string[]).includes(type) ? type : 'INFO',
        level,
        ...(taskId ? { taskId: str(taskId, 128) } : { taskId: null }),
        message: msg,
      });
      if (this.events.length > MAX_QUEUE) {
        const drop = this.events.length - MAX_QUEUE;
        this.events.splice(0, drop); // drop oldest
        this.stats.dropped += drop;
      }
      if (!this.eventTimer) this.eventTimer = setTimeout(() => this.kick(), this.intervalMs);
      this.eventTimer.unref?.();
    } catch {
      /* never throws */
    }
  }

  /** Final best-effort flush (bounded to ~3 s). Never throws. */
  async close(final?: RunMonitorSnapshotInput): Promise<void> {
    if (this.closed) return;
    try {
      if (final) this.pendingSnapshot = this.sanitizeSnapshot(final);
      this.closed = true;
      if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
      if (this.eventTimer) clearTimeout(this.eventTimer);
      this.snapshotTimer = this.eventTimer = null;
      const work = (async () => {
        await this.inflight.catch(() => undefined);
        await this.sendSnapshot();
        while (this.events.length) await this.sendEvents();
      })();
      await Promise.race([work, new Promise<void>((r) => setTimeout(r, FINAL_FLUSH_MS).unref?.())]);
    } catch {
      /* never throws */
    }
  }

  private scheduleSnapshot(ms: number): void {
    if (this.snapshotTimer) {
      if (ms > 0) return; // already scheduled
      clearTimeout(this.snapshotTimer);
    }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.inflight = this.inflight.then(() => this.sendSnapshot()).catch(() => undefined);
    }, ms);
    this.snapshotTimer.unref?.();
  }

  private kick(): void {
    this.eventTimer = null;
    // Snapshot first (contract: preferred order), then events.
    this.inflight = this.inflight
      .then(async () => {
        if (!this.snapshotSentOnce && this.pendingSnapshot) await this.sendSnapshot();
        await this.sendEvents();
      })
      .catch(() => undefined);
    if (this.events.length > MAX_BATCH && !this.closed) {
      this.eventTimer = setTimeout(() => this.kick(), this.intervalMs);
      this.eventTimer.unref?.();
    }
  }

  private async sendSnapshot(): Promise<void> {
    const snap = this.pendingSnapshot;
    if (!snap) return;
    this.pendingSnapshot = null;
    const body: RunMonitorSnapshot = { ...snap, seq: this.nextSeq(), updatedAt: new Date().toISOString() };
    const ok = await this.request('PUT', `/api/runs/${encodeURIComponent(this.runId)}`, body);
    if (ok) this.snapshotSentOnce = true;
  }

  private async sendEvents(): Promise<void> {
    if (!this.events.length) return;
    const batch = this.events.splice(0, MAX_BATCH);
    // Failed batches are not retried beyond the next flush: they are simply dropped.
    const ok = await this.request('POST', `/api/runs/${encodeURIComponent(this.runId)}/events`, { events: batch });
    if (!ok) this.stats.dropped += batch.length;
  }

  private async request(method: 'PUT' | 'POST', p: string, body: unknown): Promise<boolean> {
    try {
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json) > 60_000) {
        this.stats.failed++;
        return false;
      }
      const res = await this.fetchFn(`${this.base}${p}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: json,
      });
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore body */
      }
      if (res.status >= 200 && res.status < 300) {
        this.stats.sent++;
        return true;
      }
      this.stats.failed++;
      return false;
    } catch {
      this.stats.failed++;
      return false;
    }
  }

  private sanitizeSnapshot(i: RunMonitorSnapshotInput): RunMonitorSnapshot {
    const iso = (v: unknown, fb: string) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fb);
    const now = new Date().toISOString();
    const snap: RunMonitorSnapshot = {
      runId: this.runId,
      seq: 0,
      projectId: str(i.projectId, 128, 'unknown'),
      projectName: str(i.projectName, 200, 'unknown'),
      entryPoint: i.entryPoint === 'aidm_autonomous_start' ? 'aidm_autonomous_start' : 'aidm_run_spec',
      status: i.status,
      startedAt: iso(i.startedAt, now),
      updatedAt: now,
      finishedAt: i.finishedAt ? iso(i.finishedAt, now) : null,
      budget: {
        limitUsd: nonNeg(i.budget?.limitUsd),
        committedUsd: nonNeg(i.budget?.committedUsd),
        reservedUsd: nonNeg(i.budget?.reservedUsd),
      },
      currentTaskId: i.currentTaskId ? str(i.currentTaskId, 128) : null,
      tasks: (i.tasks ?? []).slice(0, 100).map((t) => ({
        taskId: str(t.taskId, 128, 'task'),
        title: str(t.title, 200, t.taskId),
        status: str(t.status, 40, 'UNKNOWN'),
        cycles: Math.max(0, Math.floor(nonNeg(t.cycles))),
        ...(typeof t.maxAttempts === 'number' ? { maxAttempts: Math.max(0, Math.floor(t.maxAttempts)) } : {}),
        lastSummary: t.lastSummary ? str(t.lastSummary, 500) : null,
      })),
      lastDirectorAction: i.lastDirectorAction
        ? {
            actionType: str(i.lastDirectorAction.actionType, 60, 'UNKNOWN'),
            taskId: i.lastDirectorAction.taskId ? str(i.lastDirectorAction.taskId, 128) : null,
            rationale: str(i.lastDirectorAction.rationale, 1000),
            at: iso(i.lastDirectorAction.at, now),
          }
        : null,
      pendingApprovalId: i.pendingApprovalId && UUID_RE.test(i.pendingApprovalId) ? i.pendingApprovalId : null,
      pendingDecisionIds: (i.pendingDecisionIds ?? []).filter((d) => UUID_RE.test(d)).slice(0, 20),
      stopReason: i.stopReason ? str(i.stopReason, 1000) : null,
    };
    if (i.model) snap.model = str(i.model, 100);
    return snap;
  }
}
