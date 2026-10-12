/**
 * @file external-approval.ts
 * @description Asynchronous external-IdP approval for `aidm_autonomous_start` (ADR-13 / P18-04).
 *
 *   start  : ingest spec -> fix binding (projectId, packageId/revision, contextFingerprint,
 *            specFingerprint, nonce) BEFORE approval -> persist pending record -> POST to IdP ->
 *            PENDING_EXTERNAL_APPROVAL { requestId, approvalUrl }
 *   resume : fetch IdP status (or use a supplied token) -> verify token via the configured adapter
 *            (signature, iss/aud/exp/nbf, nonce single use, binding == persisted record, decision,
 *            actorRole, amr/uv) -> seal mandate with authSource EXTERNAL_IDP -> run the same
 *            AutonomousSpecRunner as the CLI (background by default)
 *   status : persisted records (+ pending Director decision requests)
 *
 * Nothing the MCP caller sends can change the binding: it is read only from the persisted record,
 * which is written before the human sees the request.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SpecIngestor } from './spec-ingestor.js';
import { resolveCanonicalProjectIdentity } from '../director/project-identity-resolver.js';
import { MAX_PERIOD_BUDGET_NANO_USD, nanoUsdToUsd } from '../budget/budget-types.js';
import { createTrustedIdentityProvider } from '../authorization/trusted-identity-config.js';
import { NonceStore } from '../authorization/nonce-store.js';
import type { ITrustedIdentityProvider, TrustedApprovalBinding } from '../authorization/trusted-identity-types.js';
import { IdpClient, IdpClientError, canonicalJson, sha256Hex, verifyIdpToken } from './idp-client.js';
import { AutonomousSpecRunner, type AutonomousRunOptions, type AutonomousRunReport } from './autonomous-runner.js';
import { listDecisionRecords } from './decision-requests.js';
import { preflightLlmProvider } from './llm-provider-config.js';
import { RunMonitor, runMonitorUrl, type RunMonitorStatus } from './run-monitor.js';

type Env = Readonly<Record<string, string | undefined>>;

export const EXTERNAL_APPROVAL_DIR = path.join('.ai-manager', 'state', 'external-approvals');
export const AUTONOMOUS_SPEC_RUN_OPERATION = 'AUTONOMOUS_SPEC_RUN';
export const APPROVAL_REQUEST_TTL_MS = 15 * 60_000;
export const DEFAULT_MANDATE_HOURS = 8;
export const DEFAULT_MAX_CYCLES = 3;

export type ExternalApprovalState =
  | 'PENDING'
  | 'REJECTED'
  | 'EXPIRED'
  | 'VERIFICATION_FAILED'
  | 'RUNNING'
  | 'FINISHED';

export interface ExternalApprovalRecord {
  readonly requestId: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly specPath: string;
  readonly specFingerprint: string;
  readonly packageId: string;
  readonly revision: number;
  readonly contextFingerprint: string;
  readonly operation: string;
  readonly nonce: string;
  readonly budgetUsd: number;
  readonly maxCyclesPerTask: number;
  readonly mandateHours: number;
  readonly allowedPaths: readonly string[];
  readonly taskCount: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
  approvalUrl?: string;
  state: ExternalApprovalState;
  reason?: string;
  approvedBy?: string;
  runId?: string;
  runStatus?: string;
  reportPath?: string;
  updatedAt: string;
}

export interface ExternalApprovalResult {
  readonly success: boolean;
  readonly code: string;
  readonly message?: string;
  readonly requestId?: string;
  readonly approvalUrl?: string;
  readonly record?: ExternalApprovalRecord;
  readonly report?: AutonomousRunReport;
  readonly monitorUrl?: string;
}

export { isExternalIdpConfigured } from './idp-client.js';

function recordPath(projectRoot: string, requestId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('requestId must be a UUID');
  return path.join(projectRoot, EXTERNAL_APPROVAL_DIR, `${requestId}.json`);
}

async function saveRecord(rec: ExternalApprovalRecord): Promise<void> {
  rec.updatedAt = new Date().toISOString();
  const p = recordPath(rec.projectRoot, rec.requestId);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fs.promises.rename(tmp, p);
}

export async function loadExternalApprovalRecord(projectRoot: string, requestId: string): Promise<ExternalApprovalRecord | null> {
  try {
    return JSON.parse(await fs.promises.readFile(recordPath(projectRoot, requestId), 'utf8')) as ExternalApprovalRecord;
  } catch {
    return null;
  }
}

export async function listExternalApprovalRecords(projectRoot: string): Promise<ExternalApprovalRecord[]> {
  const dir = path.join(projectRoot, EXTERNAL_APPROVAL_DIR);
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: ExternalApprovalRecord[] = [];
  for (const n of names.filter((x) => /^[0-9a-f-]{36}\.json$/i.test(x))) {
    try {
      out.push(JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as ExternalApprovalRecord);
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function computeApprovalContextFingerprint(fields: {
  operation: string;
  projectId: string;
  specFingerprint: string;
  packageId: string;
  revision: number;
  budgetUsd: number;
  allowedPaths: readonly string[];
  mandateHours: number;
  maxCyclesPerTask: number;
}): string {
  return sha256Hex(canonicalJson({ ...fields, allowedPaths: [...fields.allowedPaths] }));
}

export function bindingOf(rec: ExternalApprovalRecord): TrustedApprovalBinding {
  return {
    projectId: rec.projectId,
    packageId: rec.packageId,
    revision: rec.revision,
    contextFingerprint: rec.contextFingerprint,
    operation: rec.operation,
  };
}

export interface StartExternalApprovalOptions {
  readonly projectRoot: string;
  readonly specPath: string;
  readonly budgetUsd?: number;
  readonly maxCyclesPerTask?: number;
  readonly mandateHours?: number;
  readonly env?: Env;
  readonly fetchFn?: typeof fetch;
  /** True when the caller injects its own LLM provider (tests/embedding): skip env provider preflight. */
  readonly providerInjected?: boolean;
}

/** One-shot monitor snapshot for the approval phase (fire-and-forget, bounded, never throws). */
async function approvalMonitor(rec: ExternalApprovalRecord, status: RunMonitorStatus, env: Env, fetchFn?: typeof fetch): Promise<void> {
  if (!rec.runId) return;
  const m = RunMonitor.create({ env, runId: rec.runId, fetchFn });
  if (!m) return;
  if (status === 'PENDING_APPROVAL') m.event('APPROVAL_REQUESTED', 'Passkey onayı bekleniyor');
  await m.close({
    runId: rec.runId,
    projectId: rec.projectId,
    projectName: rec.projectName,
    entryPoint: 'aidm_autonomous_start',
    status,
    startedAt: rec.requestedAt,
    finishedAt: status === 'REJECTED' ? new Date().toISOString() : null,
    budget: { limitUsd: rec.budgetUsd, committedUsd: 0, reservedUsd: 0 },
    tasks: [],
    pendingApprovalId: status === 'PENDING_APPROVAL' ? rec.requestId : null,
    pendingDecisionIds: [],
    stopReason: rec.reason ?? null,
  });
}

export async function startExternalApproval(o: StartExternalApprovalOptions): Promise<ExternalApprovalResult> {
  const env = o.env ?? process.env;
  const projectRoot = path.resolve(o.projectRoot);
  const specPath = path.resolve(o.specPath);
  const budgetUsd = o.budgetUsd;
  const maxUsd = nanoUsdToUsd(MAX_PERIOD_BUDGET_NANO_USD);
  if (budgetUsd === undefined || !(budgetUsd > 0)) {
    return { success: false, code: 'CONFIGURATION_ERROR', message: 'A positive budgetUsd is required for live runs.' };
  }
  if (budgetUsd > maxUsd) {
    return { success: false, code: 'CONFIGURATION_ERROR', message: `budgetUsd exceeds the ADR-16 per-period ceiling of $${maxUsd}.` };
  }
  const mandateHours = o.mandateHours ?? DEFAULT_MANDATE_HOURS;
  if (!(mandateHours > 0 && mandateHours <= 24)) {
    return { success: false, code: 'CONFIGURATION_ERROR', message: 'mandateHours must be in (0, 24].' };
  }
  const maxCyclesPerTask = Math.max(1, Math.floor(o.maxCyclesPerTask ?? DEFAULT_MAX_CYCLES));
  // Never ask the human for a passkey approval that a misconfigured provider would waste.
  if (!o.providerInjected) {
    const pf = preflightLlmProvider(env);
    if (!pf.ok) return { success: false, code: 'CONFIGURATION_ERROR', message: `${pf.code}: ${pf.message}` };
  }

  let markdown: string;
  try {
    markdown = await fs.promises.readFile(specPath, 'utf8');
  } catch {
    return { success: false, code: 'SPEC_UNREADABLE', message: `Cannot read spec file '${specPath}'.` };
  }
  const projectId = resolveCanonicalProjectIdentity(projectRoot).projectId;
  const rel = path.relative(projectRoot, specPath);
  const ingestion = new SpecIngestor().ingest(markdown, { projectId, specPath: rel.startsWith('..') ? specPath : rel });
  const taskCount = ingestion.tasks.filter((t) => t.hierarchy_level === 'TASK').length;

  const requestId = crypto.randomUUID();
  const packageId = `pkg-autonomous-${ingestion.specFingerprint.slice(0, 12)}-${requestId.slice(0, 8)}`;
  const revision = 1;
  const contextFingerprint = computeApprovalContextFingerprint({
    operation: AUTONOMOUS_SPEC_RUN_OPERATION,
    projectId,
    specFingerprint: ingestion.specFingerprint,
    packageId,
    revision,
    budgetUsd,
    allowedPaths: ingestion.allowedPaths,
    mandateHours,
    maxCyclesPerTask,
  });
  const now = Date.now();
  const rec: ExternalApprovalRecord = {
    requestId,
    projectRoot,
    projectId,
    projectName: ingestion.projectName,
    specPath,
    specFingerprint: ingestion.specFingerprint,
    packageId,
    revision,
    contextFingerprint,
    operation: AUTONOMOUS_SPEC_RUN_OPERATION,
    nonce: crypto.randomBytes(24).toString('base64url'),
    budgetUsd,
    maxCyclesPerTask,
    mandateHours,
    allowedPaths: [...ingestion.allowedPaths],
    taskCount,
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_REQUEST_TTL_MS).toISOString(),
    state: 'PENDING',
    updatedAt: new Date(now).toISOString(),
    runId: `run-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`,
  };

  let client: IdpClient;
  try {
    client = new IdpClient({ env, fetchFn: o.fetchFn });
  } catch (err) {
    return { success: false, code: 'BLOCKED_ON_AUTH_CONTEXT', message: err instanceof Error ? err.message : String(err) };
  }
  // Persist BEFORE the human can see the request: the binding is fixed from here on.
  await saveRecord(rec);
  const summaryText =
    `Project '${rec.projectName}' (${projectId}); spec ${rel}; budget $${budgetUsd}; ${taskCount} task(s); ` +
    `allowed paths: ${rec.allowedPaths.join(', ') || '(project defaults)'}; mandate ${mandateHours}h; ` +
    `Director (LLM) + AGY executor, no-questions routine implementation, product decisions asked via IdP.`;
  try {
    const res = await client.createApprovalRequest({
      requestId,
      projectId,
      packageId,
      revision,
      contextFingerprint,
      specFingerprint: rec.specFingerprint,
      directorSessionId: null,
      taskId: null,
      operation: rec.operation,
      nonce: rec.nonce,
      summary: {
        projectName: rec.projectName,
        specPath: rel,
        budgetUsd,
        taskCount,
        allowedPaths: rec.allowedPaths,
        mandateHours,
        text: summaryText,
      },
      requestedAt: rec.requestedAt,
      expiresAt: rec.expiresAt,
    });
    rec.approvalUrl = res.approvalUrl;
    await saveRecord(rec);
    await approvalMonitor(rec, 'PENDING_APPROVAL', env, o.fetchFn);
  } catch (err) {
    rec.state = 'VERIFICATION_FAILED';
    rec.reason = err instanceof Error ? err.message : String(err);
    await saveRecord(rec);
    return { success: false, code: err instanceof IdpClientError ? err.code : 'IDP_REQUEST_FAILED', message: rec.reason, requestId };
  }
  return {
    success: true,
    code: 'PENDING_EXTERNAL_APPROVAL',
    message: 'Approve the request with your passkey in the IdP web UI, then call aidm_autonomous_resume { requestId }.',
    requestId,
    approvalUrl: rec.approvalUrl,
    record: rec,
    ...(rec.runId && runMonitorUrl(env, rec.runId) ? { monitorUrl: runMonitorUrl(env, rec.runId)! } : {}),
  };
}

// In-process background runs (the MCP server is a long-lived process).
const backgroundRuns = new Map<string, Promise<AutonomousRunReport | void>>();

export function getBackgroundRun(requestId: string): Promise<AutonomousRunReport | void> | undefined {
  return backgroundRuns.get(requestId);
}

export interface ResumeExternalApprovalOptions {
  readonly projectRoot: string;
  readonly requestId: string;
  readonly token?: string;
  readonly env?: Env;
  readonly fetchFn?: typeof fetch;
  /** Default true: return RUN_STARTED immediately and run in the background. */
  readonly background?: boolean;
  readonly identityProvider?: ITrustedIdentityProvider;
  /** Runner dependency injection (tests / embedding). */
  readonly runnerDeps?: Partial<AutonomousRunOptions>;
}

async function checkRecordIntegrity(rec: ExternalApprovalRecord): Promise<string | null> {
  const expected = computeApprovalContextFingerprint({
    operation: rec.operation,
    projectId: rec.projectId,
    specFingerprint: rec.specFingerprint,
    packageId: rec.packageId,
    revision: rec.revision,
    budgetUsd: rec.budgetUsd,
    allowedPaths: rec.allowedPaths,
    mandateHours: rec.mandateHours,
    maxCyclesPerTask: rec.maxCyclesPerTask,
  });
  if (expected !== rec.contextFingerprint || rec.operation !== AUTONOMOUS_SPEC_RUN_OPERATION || rec.revision !== 1) {
    return 'Persisted approval binding was modified after the request was created.';
  }
  if (rec.projectId !== resolveCanonicalProjectIdentity(rec.projectRoot).projectId) {
    return 'Project identity changed since the approval request.';
  }
  let markdown: string;
  try {
    markdown = await fs.promises.readFile(rec.specPath, 'utf8');
  } catch {
    return `Spec file '${rec.specPath}' is no longer readable.`;
  }
  const ing = new SpecIngestor().ingest(markdown, { projectId: rec.projectId, specPath: rec.specPath });
  if (ing.specFingerprint !== rec.specFingerprint) return 'Spec file changed after the approval request; start a new approval.';
  if (canonicalJson([...ing.allowedPaths]) !== canonicalJson([...rec.allowedPaths])) return 'Spec scope (allowed paths) changed after the approval request.';
  return null;
}

export async function resumeExternalApproval(o: ResumeExternalApprovalOptions): Promise<ExternalApprovalResult> {
  const env = o.env ?? process.env;
  const projectRoot = path.resolve(o.projectRoot);
  let rec: ExternalApprovalRecord | null;
  try {
    rec = await loadExternalApprovalRecord(projectRoot, o.requestId);
  } catch {
    return { success: false, code: 'INVALID_ARGUMENT', message: 'requestId must be a UUID.' };
  }
  if (!rec) return { success: false, code: 'NOT_FOUND', message: `No pending approval '${o.requestId}' in this project.` };
  if (rec.state !== 'PENDING') {
    return { success: rec.state === 'RUNNING' || rec.state === 'FINISHED', code: `ALREADY_${rec.state}`, requestId: rec.requestId, record: rec, message: rec.reason };
  }
  if (Date.now() > Date.parse(rec.expiresAt)) {
    rec.state = 'EXPIRED';
    rec.reason = 'Approval request expired before a verified approval was received.';
    await saveRecord(rec);
    return { success: false, code: 'EXPIRED', requestId: rec.requestId, record: rec, message: rec.reason };
  }

  // The persisted record is local state: re-derive the approved binding from its fields and the
  // spec file on disk, so a tampered budget/scope/spec after approval can never match the token.
  const integrity = await checkRecordIntegrity(rec);
  if (integrity) {
    rec.state = 'VERIFICATION_FAILED';
    rec.reason = integrity;
    await saveRecord(rec);
    return { success: false, code: 'BINDING_MISMATCH', requestId: rec.requestId, record: rec, message: integrity };
  }

  let token = o.token;
  if (!token) {
    let st;
    try {
      st = await new IdpClient({ env, fetchFn: o.fetchFn }).getApprovalRequest(rec.requestId);
    } catch (err) {
      return { success: false, code: err instanceof IdpClientError ? err.code : 'IDP_STATUS_FAILED', message: err instanceof Error ? err.message : String(err), requestId: rec.requestId };
    }
    if (st.status === 'PENDING') {
      return { success: true, code: 'PENDING_EXTERNAL_APPROVAL', requestId: rec.requestId, approvalUrl: rec.approvalUrl, record: rec };
    }
    if (st.status === 'REJECTED' || st.status === 'EXPIRED') {
      rec.state = st.status;
      rec.reason = typeof st.reason === 'string' ? st.reason.slice(0, 500) : `IdP reported ${st.status}.`;
      await saveRecord(rec);
      await approvalMonitor(rec, 'REJECTED', env, o.fetchFn);
      return { success: false, code: st.status, requestId: rec.requestId, record: rec, message: rec.reason };
    }
    if (st.status !== 'APPROVED' || typeof st.token !== 'string') {
      return { success: false, code: 'UNVERIFIED', requestId: rec.requestId, message: `Unexpected IdP status '${String(st.status)}'.` };
    }
    token = st.token;
  }

  // Verify (dry-run: nonce is consumed by the mandate store's own re-verification at sealing).
  const provider =
    o.identityProvider ?? createTrustedIdentityProvider({ env, nonceStore: new NonceStore({ baseDir: projectRoot }), fetchFn: o.fetchFn });
  const check = await verifyIdpToken(
    provider,
    token,
    bindingOf(rec),
    {
      requestId: rec.requestId,
      decision: 'APPROVED',
      nonce: rec.nonce,
      projectId: rec.projectId,
      packageId: rec.packageId,
      revision: rec.revision,
      contextFingerprint: rec.contextFingerprint,
      operation: rec.operation,
      directorSessionId: null,
      taskId: null,
    },
    { consumeNonce: false }
  );
  if (!check.ok) {
    // A forged / mismatched token does not burn the pending request (the real approval may follow),
    // but it is recorded. Replay of an already consumed nonce is terminal.
    rec.reason = `${check.status}: ${check.reason ?? 'verification failed'}`;
    if (check.status === 'REPLAY_DETECTED') rec.state = 'VERIFICATION_FAILED';
    await saveRecord(rec);
    return { success: false, code: check.status === 'EXPIRED' ? 'TOKEN_EXPIRED' : check.status, requestId: rec.requestId, message: rec.reason, record: rec };
  }

  // Single-flight: atomically claim the record before running.
  const claimPath = `${recordPath(projectRoot, rec.requestId)}.claim`;
  try {
    await fs.promises.writeFile(claimPath, String(process.pid), { flag: 'wx' });
  } catch {
    return { success: false, code: 'ALREADY_RUNNING', requestId: rec.requestId, message: 'This approval is already being consumed.' };
  }
  rec.state = 'RUNNING';
  rec.approvedBy = typeof check.payload?.sub === 'string' ? check.payload.sub : undefined;
  rec.reason = undefined;
  await saveRecord(rec);

  const record = rec;
  const authContext: Record<string, unknown> = {
    token,
    binding: bindingOf(record),
    authSource: 'EXTERNAL_IDP',
    actorType: 'USER',
    specFingerprint: record.specFingerprint,
    nonce: record.nonce,
    identityId: record.approvedBy,
  };
  const runner = new AutonomousSpecRunner({
    ...(o.runnerDeps ?? {}),
    projectRoot,
    specPath: record.specPath,
    budgetUsd: record.budgetUsd,
    maxCyclesPerTask: record.maxCyclesPerTask,
    mandateValidityHours: record.mandateHours,
    entryPoint: 'aidm_autonomous_start',
    authContext,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(o.fetchFn ? { idpFetchFn: o.fetchFn } : {}),
    preboundApproval: {
      packageId: record.packageId,
      revision: record.revision,
      contextFingerprint: record.contextFingerprint,
      approvedBy: record.approvedBy,
    },
    env,
    onRunId: async (runId: string) => {
      record.runId = runId;
      await saveRecord(record);
    },
  });

  const exec = async (): Promise<AutonomousRunReport> => {
    try {
      const report = await runner.run();
      record.state = 'FINISHED';
      record.runId = report.runId;
      record.runStatus = report.status;
      record.reportPath = report.reportPath;
      record.reason = report.stopReason;
      await saveRecord(record);
      return report;
    } catch (err) {
      record.state = 'FINISHED';
      record.runStatus = 'FAILED';
      record.reason = err instanceof Error ? err.message : String(err);
      await saveRecord(record);
      throw err;
    }
  };

  if (o.background === false) {
    const report = await exec();
    const ok = report.status === 'COMPLETED';
    return { success: ok, code: report.status, requestId: record.requestId, record, report };
  }
  const p = exec().catch(() => undefined);
  backgroundRuns.set(record.requestId, p);
  void p.finally(() => backgroundRuns.delete(record.requestId));
  return {
    success: true,
    code: 'RUN_STARTED',
    requestId: record.requestId,
    record,
    message: 'Approval verified; autonomous run started in the background. Poll aidm_autonomous_status.',
  };
}

export async function getAutonomousStatus(projectRoot: string, requestId?: string): Promise<Record<string, unknown>> {
  const root = path.resolve(projectRoot);
  const approvals = (await listExternalApprovalRecords(root))
    .filter((r) => !requestId || r.requestId === requestId)
    .map((r) => ({
      requestId: r.requestId,
      state: r.state,
      approvalUrl: r.approvalUrl,
      projectId: r.projectId,
      budgetUsd: r.budgetUsd,
      taskCount: r.taskCount,
      expiresAt: r.expiresAt,
      runId: r.runId,
      runStatus: r.runStatus,
      reportPath: r.reportPath,
      reason: r.reason,
      inProcessRunActive: backgroundRuns.has(r.requestId),
    }));
  const decisions = (await listDecisionRecords(root)).map((d) => ({
    decisionId: d.decisionId,
    runId: d.runId,
    taskId: d.taskId,
    state: d.state,
    question: d.question,
    options: d.options,
    recommendedOptionId: d.recommendedOptionId,
    decisionUrl: d.decisionUrl,
    expiresAt: d.expiresAt,
    answer: d.answer,
  }));
  return {
    approvals,
    pendingDecisions: decisions.filter((d) => d.state === 'PENDING'),
    decisions,
  };
}
