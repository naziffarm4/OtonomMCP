/**
 * @file decision-requests.ts
 * @description Human product/design decisions raised by the Director (REQUEST_HUMAN_DECISION) during
 * an autonomous run. The human's ONLY counterpart is the Director: the executor (AGY) never asks the
 * human; its questions are routed back to the Director as input.
 *
 * Resolution channels:
 *  - IdpDecisionResolver : POST /api/decision-requests, poll, verify the ES256 answer token
 *                           (same adapter + contract checks as approvals; nonce consumed).
 *  - TtyDecisionResolver : interactive numbered options in the operator's terminal (CLI, TTY only).
 *  - none                 : the run stops BLOCKED_ON_HUMAN for that decision (as before).
 * AIDM_DECISION_MODE=ask (default) | assume (old behavior: proceed with recommended/conventional option).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ITrustedIdentityProvider } from '../authorization/trusted-identity-types.js';
import { IdpClient, canonicalJson, sha256Hex, verifyIdpToken } from './idp-client.js';

type Env = Readonly<Record<string, string | undefined>>;

export const DECISIONS_DIR = path.join('.ai-manager', 'state', 'decisions');
export const AUTONOMOUS_DECISION_OPERATION = 'AUTONOMOUS_DECISION';
/** Contract v1: IdP accepts expiresAt - requestedAt <= 15 min. */
export const DECISION_TTL_MS = 15 * 60_000;
export type DecisionMode = 'ask' | 'assume';

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface DecisionAnswer {
  readonly selectedOptionId?: string;
  readonly freeText?: string;
  readonly answeredBy: string;
  readonly source: 'EXTERNAL_IDP' | 'OPERATOR_TTY';
  readonly answeredAt: string;
}

export interface DecisionRecord {
  readonly decisionId: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly packageId: string;
  readonly revision: number;
  readonly contextFingerprint: string;
  readonly question: string;
  readonly reason?: string;
  readonly options: readonly DecisionOption[];
  readonly allowFreeText: boolean;
  readonly recommendedOptionId?: string;
  readonly nonce: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  decisionUrl?: string;
  state: 'PENDING' | 'ANSWERED' | 'EXPIRED' | 'FAILED' | 'UNAVAILABLE';
  answer?: DecisionAnswer;
  failure?: string;
  updatedAt: string;
}

export type DecisionOutcome =
  | { readonly status: 'ANSWERED'; readonly answer: DecisionAnswer }
  | { readonly status: 'EXPIRED' | 'FAILED' | 'UNAVAILABLE'; readonly reason: string };

export interface DecisionResolver {
  readonly channel: 'EXTERNAL_IDP' | 'OPERATOR_TTY';
  resolve(record: DecisionRecord): Promise<DecisionOutcome>;
}

export function resolveDecisionMode(env: Env = process.env): DecisionMode {
  const v = (env.AIDM_DECISION_MODE ?? 'ask').trim().toLowerCase();
  if (v !== 'ask' && v !== 'assume') {
    throw new Error(`AIDM_DECISION_MODE must be 'ask' or 'assume' (got '${v}').`);
  }
  return v;
}

/** Director prompt guidance on what is worth asking the human. */
export function decisionPolicyInstruction(mode: DecisionMode, specPolicy?: string): string {
  if (mode === 'assume') {
    return 'Human decisions are disabled for this run (AIDM_DECISION_MODE=assume): choose the most conventional option, state it as an assumption and continue.';
  }
  return [
    'DECISION POLICY: You are the only party that may talk to the human (Product Owner). The executor never asks the human.',
    'Emit REQUEST_HUMAN_DECISION (question, reason, blocking=true, options: 2-6 {id,label,description}, recommendation = recommended option id)',
    'ONLY for genuine product/design decisions the spec leaves open: product scope and feature behavior, UX choices visible to users,',
    'data-model trade-offs with lasting consequences, security/privacy posture, paid third-party services.',
    'Decide routine technical details yourself (naming, file layout, library choice within the stack, test structure, refactors, error messages) and log them as assumptions.',
    'Never ask about things the spec already answers. While a decision is pending, other independent tasks continue.',
    specPolicy ? `Project decision policy (from the spec "Karar Politikası"): ${specPolicy}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function decisionPath(projectRoot: string, decisionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(decisionId)) throw new Error('decisionId must be a UUID');
  return path.join(projectRoot, DECISIONS_DIR, `${decisionId}.json`);
}

export async function saveDecisionRecord(rec: DecisionRecord): Promise<void> {
  rec.updatedAt = new Date().toISOString();
  const p = decisionPath(rec.projectRoot, rec.decisionId);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fs.promises.rename(tmp, p);
}

export async function listDecisionRecords(projectRoot: string): Promise<DecisionRecord[]> {
  const dir = path.join(projectRoot, DECISIONS_DIR);
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const n of names.filter((x) => /^[0-9a-f-]{36}\.json$/i.test(x))) {
    try {
      out.push(JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as DecisionRecord);
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

function slugId(s: string, i: number): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return base || `option-${i + 1}`;
}

/** Normalizes the Director's (untrusted) proposal into a bounded decision request. */
export function buildDecisionRecord(input: {
  projectRoot: string;
  projectId: string;
  runId: string;
  taskId: string;
  packageId: string;
  revision: number;
  question: string;
  reason?: string;
  options?: unknown;
  recommendation?: string;
  allowFreeText?: boolean;
  ttlMs?: number;
}): DecisionRecord {
  const raw = Array.isArray(input.options) ? input.options : [];
  const options: DecisionOption[] = [];
  const seen = new Set<string>();
  raw.slice(0, 6).forEach((o, i) => {
    const r = (o && typeof o === 'object' ? o : { label: String(o) }) as Record<string, unknown>;
    const label = String(r.label ?? r.title ?? r.id ?? '').trim().slice(0, 200);
    if (!label) return;
    let id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : slugId(label, i);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim().slice(0, 600) : undefined;
    options.push({ id, label, ...(description ? { description } : {}) });
  });
  let allowFreeText = input.allowFreeText ?? true;
  if (options.length < 2) {
    // Bounded fallback: never present a single forced choice.
    options.length = 0;
    options.push(
      { id: 'recommended', label: (input.recommendation ?? 'Proceed with the Director recommendation').slice(0, 200) },
      { id: 'other', label: 'Something else (describe in free text)' }
    );
    allowFreeText = true;
  }
  const rec = input.recommendation;
  const recommendedOptionId = rec ? options.find((o) => o.id === rec || o.label === rec)?.id : undefined;
  const decisionId = crypto.randomUUID();
  const question = input.question.trim().slice(0, 1000);
  const now = Date.now();
  const contextFingerprint = sha256Hex(
    canonicalJson({ projectId: input.projectId, runId: input.runId, taskId: input.taskId, decisionId, question, options })
  );
  return {
    decisionId,
    projectRoot: path.resolve(input.projectRoot),
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId,
    packageId: input.packageId,
    revision: input.revision,
    contextFingerprint,
    question,
    reason: input.reason?.slice(0, 1000),
    options,
    allowFreeText,
    ...(recommendedOptionId ? { recommendedOptionId } : {}),
    nonce: crypto.randomBytes(24).toString('base64url'),
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (input.ttlMs ?? DECISION_TTL_MS)).toISOString(),
    state: 'PENDING',
    updatedAt: new Date(now).toISOString(),
  };
}

function validateAnswer(rec: DecisionRecord, selectedOptionId: unknown, freeText: unknown): string | null {
  const sel = typeof selectedOptionId === 'string' ? selectedOptionId : undefined;
  const ft = typeof freeText === 'string' ? freeText : undefined;
  if (!sel && !ft) return 'Answer has neither selectedOptionId nor freeText.';
  if (sel && !rec.options.some((o) => o.id === sel)) return `selectedOptionId '${sel}' is not one of the offered options.`;
  if (ft && !rec.allowFreeText) return 'Free text is not allowed for this decision.';
  if (ft && ft.length > 2000) return 'freeText exceeds 2000 characters.';
  return null;
}

// Tokens supplied out-of-band via aidm_autonomous_resume { decisionId, token }.
const injectedDecisionTokens = new Map<string, string>();
export function supplyDecisionToken(decisionId: string, token: string): void {
  injectedDecisionTokens.set(decisionId, token);
}

export class IdpDecisionResolver implements DecisionResolver {
  readonly channel = 'EXTERNAL_IDP' as const;
  constructor(
    private readonly opts: {
      env?: Env;
      fetchFn?: typeof fetch;
      provider: ITrustedIdentityProvider;
      pollIntervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {}

  async resolve(rec: DecisionRecord): Promise<DecisionOutcome> {
    const client = new IdpClient({ env: this.opts.env, fetchFn: this.opts.fetchFn });
    try {
      const res = await client.createDecisionRequest({
        decisionId: rec.decisionId,
        projectId: rec.projectId,
        runId: rec.runId,
        taskId: rec.taskId,
        packageId: rec.packageId,
        revision: rec.revision,
        operation: AUTONOMOUS_DECISION_OPERATION,
        contextFingerprint: rec.contextFingerprint,
        question: rec.question,
        ...(rec.reason ? { summary: rec.reason.slice(0, 4000) } : {}),
        options: rec.options,
        allowFreeText: rec.allowFreeText,
        recommendedOptionId: rec.recommendedOptionId ?? null,
        nonce: rec.nonce,
        requestedAt: rec.requestedAt,
        expiresAt: rec.expiresAt,
      });
      rec.decisionUrl = res.decisionUrl;
      await saveDecisionRecord(rec);
    } catch (err) {
      return { status: 'UNAVAILABLE', reason: err instanceof Error ? err.message : String(err) };
    }
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const interval = this.opts.pollIntervalMs ?? 3000;
    let consecutiveErrors = 0;
    while (Date.now() < Date.parse(rec.expiresAt)) {
      let token = injectedDecisionTokens.get(rec.decisionId);
      if (!token) {
        try {
          const st = await client.getDecisionRequest(rec.decisionId);
          consecutiveErrors = 0;
          if (st.status === 'EXPIRED') return { status: 'EXPIRED', reason: 'IdP reported the decision request as expired.' };
          if (st.status === 'ANSWERED' && typeof st.token === 'string') token = st.token;
        } catch (err) {
          if (++consecutiveErrors >= 10) {
            return { status: 'UNAVAILABLE', reason: `IdP unreachable while waiting: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
      }
      if (token) {
        injectedDecisionTokens.delete(rec.decisionId);
        const outcome = await this.verify(rec, token);
        if (outcome.status === 'ANSWERED' || outcome.status === 'EXPIRED') return outcome;
        // The single-use nonce is gone: no later token can be valid for this decision.
        if (outcome.status === 'FAILED' && /REPLAY/i.test(outcome.reason)) return outcome;
        // Invalid token: record and keep waiting for a valid one (never accept it).
        rec.failure = outcome.reason;
        await saveDecisionRecord(rec);
      }
      await sleep(interval);
    }
    return { status: 'EXPIRED', reason: 'Decision request expired without a verified answer.' };
  }

  async verify(rec: DecisionRecord, token: string): Promise<DecisionOutcome> {
    // 1) verify without consuming the nonce, 2) validate the answer, 3) consume. A signed but
    // invalid answer must not burn the decision's single-use nonce.
    const dry = await this.check(rec, token, false);
    if (dry.status !== 'ANSWERED') return dry;
    return this.check(rec, token, true);
  }

  private async check(rec: DecisionRecord, token: string, consumeNonce: boolean): Promise<DecisionOutcome> {
    const check = await verifyIdpToken(
      this.opts.provider,
      token,
      {
        projectId: rec.projectId,
        packageId: rec.packageId,
        revision: rec.revision,
        contextFingerprint: rec.contextFingerprint,
        taskId: rec.taskId,
        operation: AUTONOMOUS_DECISION_OPERATION,
      },
      {
        decisionId: rec.decisionId,
        nonce: rec.nonce,
        runId: rec.runId,
        taskId: rec.taskId,
        projectId: rec.projectId,
        contextFingerprint: rec.contextFingerprint,
      },
      { consumeNonce }
    );
    if (!check.ok || !check.payload) return { status: 'FAILED', reason: `${check.status}: ${check.reason ?? 'invalid answer token'}` };
    const bad = validateAnswer(rec, check.payload.selectedOptionId, check.payload.freeText);
    if (bad) return { status: 'FAILED', reason: bad };
    return {
      status: 'ANSWERED',
      answer: {
        ...(typeof check.payload.selectedOptionId === 'string' ? { selectedOptionId: check.payload.selectedOptionId } : {}),
        ...(typeof check.payload.freeText === 'string' ? { freeText: check.payload.freeText } : {}),
        answeredBy: String(check.payload.sub),
        source: 'EXTERNAL_IDP',
        answeredAt: new Date().toISOString(),
      },
    };
  }
}

/** Interactive terminal resolver (CLI only; caller must ensure stdin is a TTY). */
export class TtyDecisionResolver implements DecisionResolver {
  readonly channel = 'OPERATOR_TTY' as const;
  constructor(
    private readonly io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; operator?: string } = {
      input: process.stdin,
      output: process.stdout,
    }
  ) {}

  async resolve(rec: DecisionRecord): Promise<DecisionOutcome> {
    const rl = readline.createInterface({ input: this.io.input, output: this.io.output, terminal: false });
    const ask = (q: string) => new Promise<string | null>((res) => {
      let done = false;
      rl.question(q, (a) => { done = true; res(a); });
      rl.once('close', () => { if (!done) res(null); });
    });
    try {
      const w = (s: string) => this.io.output.write(`${s}\n`);
      w('');
      w(`[AIDM] Director karar istiyor (${rec.taskId}): ${rec.question}`);
      if (rec.reason) w(`        Gerekçe: ${rec.reason}`);
      rec.options.forEach((o, i) =>
        w(`  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}${o.id === rec.recommendedOptionId ? '  (önerilen)' : ''}`)
      );
      if (rec.allowFreeText) w('  0) Serbest metin');
      for (let attempt = 0; attempt < 3; attempt++) {
        const a = await ask('Seçiminiz: ');
        if (a === null) return { status: 'UNAVAILABLE', reason: 'Terminal input closed.' };
        const n = Number(a.trim());
        if (Number.isInteger(n) && n >= 1 && n <= rec.options.length) {
          return { status: 'ANSWERED', answer: { selectedOptionId: rec.options[n - 1].id, answeredBy: this.io.operator ?? 'operator-tty', source: 'OPERATOR_TTY', answeredAt: new Date().toISOString() } };
        }
        if (rec.allowFreeText && n === 0) {
          const t = await ask('Açıklama: ');
          if (t && t.trim()) {
            return { status: 'ANSWERED', answer: { freeText: t.trim().slice(0, 2000), answeredBy: this.io.operator ?? 'operator-tty', source: 'OPERATOR_TTY', answeredAt: new Date().toISOString() } };
          }
        }
        w('Geçersiz seçim.');
      }
      return { status: 'FAILED', reason: 'No valid answer after 3 attempts.' };
    } finally {
      rl.close();
    }
  }
}

/** Authoritative PRODUCT_OWNER statement fed back to the Director. */
export function formatDecisionForDirector(rec: DecisionRecord, answer: DecisionAnswer): string {
  const opt = answer.selectedOptionId ? rec.options.find((o) => o.id === answer.selectedOptionId) : undefined;
  return [
    `AUTHORITATIVE PRODUCT_OWNER DECISION (verified via ${answer.source}, decisionId ${rec.decisionId}):`,
    `Question: ${rec.question}`,
    opt ? `Chosen option: [${opt.id}] ${opt.label}${opt.description ? ` — ${opt.description}` : ''}` : '',
    answer.freeText ? `Product Owner note: ${answer.freeText}` : '',
    'Treat this as a binding product requirement for this task; do not ask again. Continue with IMPLEMENT_TASK.',
  ]
    .filter(Boolean)
    .join('\n');
}
