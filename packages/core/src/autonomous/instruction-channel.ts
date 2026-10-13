/**
 * @file instruction-channel.ts
 * @description Live Product-Owner instructions (contract: docs/EXTERNAL-IDP-INSTRUCTION-CONTRACT.md).
 * Only an ES256 token verified by the configured IdP adapter (signature, iss/aud, exp, nonce
 * single use, binding to this run's channel, operation AUTONOMOUS_INSTRUCTION, uv/amr) counts.
 * Instruction text is PO data: it never raises privileges; the sealed mandate still applies.
 * Never throws into the run.
 */

import * as crypto from 'node:crypto';
import type { ITrustedIdentityProvider } from '../authorization/trusted-identity-types.js';
import { canonicalJson, decodeJwtPayload, sha256Hex, verifyIdpToken } from './idp-client.js';
import { monitorBaseUrl, monitorText } from './run-monitor.js';

type Env = Readonly<Record<string, string | undefined>>;

export const AUTONOMOUS_INSTRUCTION_OPERATION = 'AUTONOMOUS_INSTRUCTION';
export const INSTRUCTION_MAX_LIFETIME_SEC = 15 * 60;
export type InstructionMode = 'NOTE' | 'PAUSE_AND_APPLY' | 'STOP' | 'ASK';

export interface VerifiedInstruction {
  readonly instructionId: string;
  readonly mode: InstructionMode;
  readonly text: string;
  readonly taskId: string | null;
  readonly sub: string;
  readonly receivedAt: string;
}

export interface InstructionChannelBinding {
  readonly runId: string;
  readonly projectId: string;
  readonly packageId: string;
  readonly revision: number;
  readonly contextFingerprint: string;
}

export function computeInstructionChannelFingerprint(f: {
  runId: string;
  projectId: string;
  packageId: string;
  revision: number;
  specFingerprint: string;
}): string {
  return sha256Hex(canonicalJson({ operation: AUTONOMOUS_INSTRUCTION_OPERATION, ...f }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 2000;

export class InstructionChannel {
  readonly binding: InstructionChannelBinding;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly provider: ITrustedIdentityProvider;
  private readonly seen = new Set<string>();
  private polling: Promise<VerifiedInstruction[]> | null = null;
  opened = false;
  /** Set by the runner: does this task id exist in the run? */
  taskExists: (taskId: string) => boolean = () => false;
  readonly rejected: Array<{ instructionId: string; reason: string }> = [];

  /** null when no IdP (URL + client token + verification key) is configured. Never throws. */
  static create(o: {
    env?: Env;
    fetchFn?: typeof fetch;
    provider: ITrustedIdentityProvider;
    binding: InstructionChannelBinding;
    /** Validates a token's target taskId. Without it, every targeted instruction is REJECTED (fail-closed). */
    taskExists?: (taskId: string) => boolean;
  }): InstructionChannel | null {
    try {
      const env = o.env ?? process.env;
      const base = monitorBaseUrl(env);
      const token = env.AIDM_IDP_CLIENT_TOKEN?.trim();
      if (!base || !token || !o.provider?.isConfigured()) return null;
      const ch = new InstructionChannel(base, token, o.fetchFn ?? fetch, o.provider, o.binding);
      if (o.taskExists) ch.taskExists = o.taskExists;
      return ch;
    } catch {
      return null;
    }
  }

  private constructor(base: string, token: string, fetchFn: typeof fetch, provider: ITrustedIdentityProvider, binding: InstructionChannelBinding) {
    this.base = base;
    this.token = token;
    this.fetchFn = fetchFn;
    this.provider = provider;
    this.binding = binding;
  }

  private path(suffix = ''): string {
    return `/api/runs/${encodeURIComponent(this.binding.runId)}${suffix}`;
  }

  private async call(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> } | null> {
    try {
      const res = await this.fetchFn(`${this.base}${p}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  async open(): Promise<boolean> {
    const b = this.binding;
    const r = await this.call('PUT', this.path('/instruction-channel'), {
      runId: b.runId,
      projectId: b.projectId,
      packageId: b.packageId,
      revision: b.revision,
      contextFingerprint: b.contextFingerprint,
      openedAt: new Date().toISOString(),
    });
    this.opened = Boolean(r && r.status >= 200 && r.status < 300);
    return this.opened;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await this.call('DELETE', this.path('/instruction-channel'));
  }

  async ack(instructionId: string, status: 'RECEIVED' | 'APPLIED' | 'REJECTED', note?: string, answer?: string): Promise<boolean> {
    if (!UUID_RE.test(instructionId)) return false;
    const r = await this.call('POST', this.path(`/instructions/${encodeURIComponent(instructionId)}/ack`), {
      status,
      ...(note ? { note: monitorText(note, 1000) } : {}),
      ...(answer ? { answer: answer.slice(0, 4000) } : {}),
    });
    return Boolean(r && r.status >= 200 && r.status < 300);
  }

  /** Polls pending instructions, verifies each, ACKs RECEIVED / REJECTED. Single-flight; never throws. */
  poll(): Promise<VerifiedInstruction[]> {
    if (!this.opened) return Promise.resolve([]);
    if (!this.polling) {
      this.polling = this.doPoll()
        .catch(() => [] as VerifiedInstruction[])
        .finally(() => {
          this.polling = null;
        });
    }
    return this.polling;
  }

  private async doPoll(): Promise<VerifiedInstruction[]> {
    const r = await this.call('GET', this.path('/instructions?status=PENDING_DELIVERY'));
    if (!r || r.status !== 200 || !Array.isArray(r.json.instructions)) return [];
    const out: VerifiedInstruction[] = [];
    for (const item of (r.json.instructions as Array<Record<string, unknown>>).slice(0, 20)) {
      const id = typeof item.instructionId === 'string' ? item.instructionId : '';
      if (!UUID_RE.test(id) || this.seen.has(id)) continue;
      this.seen.add(id);
      const token = typeof item.token === 'string' ? item.token : '';
      const v = await this.verify(id, token);
      if (!v.ok) {
        this.rejected.push({ instructionId: id, reason: v.reason });
        await this.ack(id, 'REJECTED', `Doğrulanamadı: ${v.reason}`);
        continue;
      }
      await this.ack(id, 'RECEIVED');
      out.push(v.instruction);
    }
    return out;
  }

  private async verify(instructionId: string, token: string): Promise<{ ok: true; instruction: VerifiedInstruction } | { ok: false; reason: string }> {
    if (!token) return { ok: false, reason: 'token missing' };
    const b = this.binding;
    // For AUTONOMOUS_INSTRUCTION `taskId` is the instruction TARGET (null when none), not a binding.
    // The adapter checks a present taskId claim against the binding, so the (still unverified)
    // claimed target is mirrored into the binding; the signature check below covers it, and the
    // target must name an existing task of this run.
    let target: string | null = null;
    try {
      const raw = decodeJwtPayload(token).taskId;
      target = typeof raw === 'string' && raw ? raw : null;
    } catch {
      return { ok: false, reason: 'malformed token' };
    }
    if (target !== null && (target.length > 128 || !this.taskExists(target))) {
      return { ok: false, reason: `unknown target task '${monitorText(target, 128)}'` };
    }
    const binding = {
      ...(target ? { taskId: target } : {}),
      projectId: b.projectId,
      packageId: b.packageId,
      revision: b.revision,
      contextFingerprint: b.contextFingerprint,
      operation: AUTONOMOUS_INSTRUCTION_OPERATION,
    };
    const expected = {
      instructionId,
      runId: b.runId,
      projectId: b.projectId,
      packageId: b.packageId,
      revision: b.revision,
      contextFingerprint: b.contextFingerprint,
      operation: AUTONOMOUS_INSTRUCTION_OPERATION,
    };
    const opts = { maxLifetimeSec: INSTRUCTION_MAX_LIFETIME_SEC };
    const dry = await verifyIdpToken(this.provider, token, binding as never, expected, { consumeNonce: false, ...opts });
    if (!dry.ok || !dry.payload) return { ok: false, reason: `${dry.status}: ${dry.reason ?? 'invalid token'}` };
    const p = dry.payload;
    const mode = p.mode;
    if (mode !== 'NOTE' && mode !== 'PAUSE_AND_APPLY' && mode !== 'STOP' && mode !== 'ASK') return { ok: false, reason: 'invalid mode' };
    const text = typeof p.text === 'string' ? p.text : '';
    if (mode !== 'STOP' && (text.length < 1 || text.length > 2000)) return { ok: false, reason: 'text must be 1..2000 chars' };
    if (text.length > 2000) return { ok: false, reason: 'text too long' };
    const taskId = target;
    // Consume the single-use nonce only after the content is valid.
    const fin = await verifyIdpToken(this.provider, token, binding as never, expected, { consumeNonce: true, ...opts });
    if (!fin.ok) return { ok: false, reason: `${fin.status}: ${fin.reason ?? 'invalid token'}` };
    return {
      ok: true,
      instruction: {
        instructionId,
        mode,
        text,
        taskId,
        sub: String(p.sub ?? 'po'),
        receivedAt: new Date().toISOString(),
      },
    };
  }
}

export function newInstructionId(): string {
  return crypto.randomUUID();
}
