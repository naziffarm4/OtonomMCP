# Run monitor contract v1 (OtonomMCP -> External IdP), one-way, informational only

Purpose: Nazif watches autonomous runs live in the IdP UI. Data flows ONLY OtonomMCP -> IdP. Nothing returned by these endpoints is ever used by OtonomMCP for authorization, control or decisions. Monitor failures must never affect a run.

Auth: same `Authorization: Bearer <client token>` as other /api/* machine endpoints. Strict validation, unknown fields -> 400, body > 64 KB -> 413.

## PUT /api/runs/:runId   (snapshot upsert; latest wins by `updatedAt`/`seq`)
{
  runId: string (1..128, [A-Za-z0-9._:-]),       // must equal :runId
  seq: integer >= 0,                              // monotonically increasing per run; IdP ignores (200, {ignored:true}) a snapshot with seq <= stored seq
  projectId: string (<=128),
  projectName: string (<=200),
  entryPoint: 'aidm_run_spec' | 'aidm_autonomous_start',
  status: 'PENDING_APPROVAL'|'RUNNING'|'BLOCKED_ON_HUMAN'|'WAITING_DECISION'|'COMPLETED'|'FAILED'|'STOPPED'|'CONFIGURATION_ERROR'|'REJECTED',
  startedAt: ISO string, updatedAt: ISO string, finishedAt?: ISO string|null,
  model?: string (<=100),
  budget: { limitUsd: number>=0, committedUsd: number>=0, reservedUsd: number>=0 },
  currentTaskId?: string|null (<=128),
  tasks: [ { taskId: string(<=128), title: string(<=200), status: string(<=40), cycles: integer>=0, maxAttempts?: integer>=0, lastSummary?: string(<=500)|null } ]  (<=100 items),
  lastDirectorAction?: { actionType: string(<=60), taskId?: string|null, rationale: string(<=1000), at: ISO string } | null,
  pendingApprovalId?: uuid|null,
  pendingDecisionIds: uuid[] (<=20),
  stopReason?: string(<=1000)|null
}
-> 200 { runId, stored: true } | 200 { runId, ignored: true }

## POST /api/runs/:runId/events   (timeline append; idempotent by (runId, seq))
{ events: [ { seq: integer>=0, at: ISO string, type: one of
    'RUN_STARTED','APPROVAL_REQUESTED','MANDATE_SEALED','CYCLE_START','DIRECTOR_ACTION','AGY_DISPATCH','AGY_RESULT','VERIFICATION','CYCLE_RESULT','REPLAN','ANALYSIS','DECISION_REQUESTED','DECISION_ANSWERED','TASK_ACCEPTED','TASK_BLOCKED','COMMIT','BUDGET','RUN_FINISHED','INFO',
  level: 'info'|'warn'|'error', taskId?: string|null (<=128), message: string (1..500) } ] (1..50 per call) }
-> 200 { runId, accepted: n, duplicates: m }
An events POST for an unknown runId creates a minimal run row (status RUNNING) only if a snapshot never arrived; preferred order is snapshot first.
IdP keeps at most 2000 events per run (oldest dropped) and at most 200 runs (oldest finished dropped).

## Never sent (OtonomMCP must not include): API keys, client token, IdP tokens, full prompts, full AGY output, file contents, env values. Messages/rationales are truncated and should be plain text. IdP must render everything as text (no HTML injection).

## IdP UI
- Requires the normal passkey browser session (read-only pages, no step-up needed).
- `#/runs` list: project, status badge, budget used/limit, current task, updatedAt. `#/runs/:runId` detail: header (status, model, budget bar, started/finished), task table (status, cycles/maxAttempts, last summary), last Director action, links to pending approval/decision pages, timeline (newest first).
- Live: poll every 3 s while the page is visible (CSP script-src 'self', no inline script, no websockets needed). Show "son güncelleme X sn önce"; if no update for >2 min while RUNNING, show "bağlantı yok / duraklamış olabilir" warning.
- Home page shows active runs and a link to #/runs. Turkish UI text.
- Session-auth UI read endpoints e.g. GET /ui-api/runs, GET /ui-api/runs/:id?sinceSeq=N (whatever matches existing UI patterns), CSRF not needed for GET.

## OtonomMCP side
- Enabled only when AIDM_IDP_URL + AIDM_IDP_CLIENT_TOKEN are configured (optionally AIDM_IDP_RUN_MONITOR=off disables).
- Fire-and-forget reporter: queue + batching, 2 s timeout, no retries beyond next flush, never throws into the run, never blocks the run, bounded queue (drop oldest). Final snapshot+events flushed (best effort, <=3 s) at run end.
- Reports from both `aidm run --spec` and MCP `aidm_autonomous_start/resume` background runs. Also emit snapshot at PENDING_APPROVAL with pendingApprovalId.
- CLI prints the monitor URL `http://localhost:7443/#/runs/<runId>` at start.

## IdP notes (IdP worker, feat/real-idp) — implemented, no field renames
- Machine endpoints exactly as above (bearer). Unknown fields at any level -> 400 (snapshot, budget, tasks[], lastDirectorAction, events[]).
  Strings reject control/bidi characters. runId mismatch with path -> 400. Wrong method on /api/runs/:runId -> 405.
- Optional fields may be omitted or null. `lastDirectorAction.rationale` may be empty (0..1000). `tasks[].status` is free text (<=40).
- Ordering is by `seq` only (`updatedAt` stored/displayed, not used for ordering). The first snapshot after an events-created
  minimal row is always stored (any seq >= 0).
- Events: duplicate (runId, seq) are counted in `duplicates` and never overwrite the stored event.
- Retention: newest 2000 events per run kept (by seq). Max 200 runs: oldest FINISHED runs (COMPLETED/FAILED/STOPPED/
  CONFIGURATION_ERROR/REJECTED, by last receive time) are dropped with their events; active runs are never dropped.
- UI read endpoints follow the existing UI pattern (session cookie, no CSRF for GET):
  `GET /api/ui/runs[?active=1]` -> { serverTime, runs:[{runId,status,hasSnapshot,projectId,projectName,currentTaskId,budget,updatedAt,receivedAt,active}] }
  `GET /api/ui/runs/:runId[?sinceSeq=N]` -> { serverTime, run:{...summary, snapshot}, events (newest first, max 500), lastSeq }
- Staleness uses the IdP's receive time (serverTime - receivedAt), so OtonomMCP/IdP clock skew does not matter.
- Monitor tables are never read by approval/decision code (tested: a snapshot with pendingApprovalId / events claiming
  approval leave the approval PENDING).
- Monitor URL: `<IDP_ORIGIN>/#/runs/<encodeURIComponent(runId)>` (with the default origin: http://localhost:7443/#/runs/<runId>).
