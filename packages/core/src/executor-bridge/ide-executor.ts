/**
 * IDE pull-mode executor ('ide'). Instead of spawning `agy`, the runner posts each task to a
 * file mailbox under .ai-manager/state/ide/; the agent open in Antigravity pulls it with
 * aidm_next_task, does the work in the IDE and reports with aidm_submit_task. The IDE's report is
 * only an unverified claim: the Director still verifies the workspace independently.
 * If the IDE never submits, the adapter's timeout turns it into EXECUTION_UNKNOWN, which pauses
 * the run resumably (human decision).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AntigravityRequestInvoker } from './antigravity-adapter.js';

export type ExecutorMode = 'ide' | 'cli' | 'cli-session';
export const IDE_EXECUTOR_ID = 'executor:antigravity-ide';
export const IDE_DIR = path.join('.ai-manager', 'state', 'ide');

export interface IdeTask { seq: number; taskId: string; prompt: string; postedAt: string; correlationId: string }
export interface IdeSubmit { seq: number; taskId: string; summary: string; changedFiles: string[]; submittedAt: string }
export interface IdeEvent { type: string; message: string; taskId: string | null; level: string; at: string }
export interface IdeStatus { events: IdeEvent[]; finished: boolean; updatedAt: string }
export type IdeVerdict =
  | { verdict: 'ACCEPTED'; message: string; next: IdeTask }
  | { verdict: 'REPAIR'; message: string; next: IdeTask }
  | { verdict: 'WAIT'; message: string }
  | { verdict: 'DONE'; message: string }
  | { verdict: 'PENDING'; message: string };

/** 'Yürütücü: ide | cli | cli-oturum' in the spec, else AIDM_EXECUTOR_MODE, else 'ide'. */
export function resolveExecutorMode(specMarkdown: string, env: Readonly<Record<string, string | undefined>> = {}): ExecutorMode {
  const m = /^[\s>*-]*(?:\*\*)?Y[üu]r[üu]t[üu]c[üu](?:\*\*)?\s*:\s*(?:\*\*)?\s*([A-Za-zçÇöÖüÜşŞğĞıİ-]+)/imu.exec(specMarkdown);
  const raw = (m?.[1] ?? env.AIDM_EXECUTOR_MODE ?? 'ide').toLowerCase();
  if (raw === 'cli') return 'cli';
  if (raw === 'cli-oturum' || raw === 'cli-session') return 'cli-session';
  return 'ide';
}

const file = (root: string, name: string) => path.join(root, IDE_DIR, name);
function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}
function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

export const readIdeTask = (root: string) => readJson<IdeTask>(file(root, 'task.json'));
export const readIdeSubmit = (root: string) => readJson<IdeSubmit>(file(root, 'submit.json'));
export const readIdeStatus = (root: string) => readJson<IdeStatus>(file(root, 'status.json'));

/** Runner side: mirror monitor events so the IDE tools can tell the agent what happened. */
export function noteIdeEvent(root: string, e: Omit<IdeEvent, 'at'>, finished = false): void {
  try {
    const s = readIdeStatus(root) ?? { events: [], finished: false, updatedAt: '' };
    s.events = [...s.events, { ...e, message: e.message.slice(0, 600), at: new Date().toISOString() }].slice(-40);
    s.finished = finished || e.type === 'RUN_FINISHED';
    s.updatedAt = new Date().toISOString();
    writeJson(file(root, 'status.json'), s);
  } catch { /* never affects the run */ }
}

/** Runner side: clears the mailbox at run start so a stale task is never served. */
export function resetIdeMailbox(root: string): void {
  const s = readIdeTask(root);
  fs.rmSync(path.join(root, IDE_DIR), { recursive: true, force: true });
  if (s) writeJson(file(root, 'seq.json'), { seq: s.seq }); // keep seq monotonic across runs
}

/** Runner side: the request invoker that posts a task and waits for the IDE's submission. */
export function createIdeRequestInvoker(root: string, opts: { pollMs?: number } = {}): AntigravityRequestInvoker {
  const pollMs = opts.pollMs ?? 1000;
  return async (payload, request, ctx) => {
    const prev = Math.max(readIdeTask(root)?.seq ?? 0, readJson<{ seq: number }>(file(root, 'seq.json'))?.seq ?? 0);
    const task: IdeTask = { seq: prev + 1, taskId: request.taskId, prompt: payload.structuredPrompt, postedAt: new Date().toISOString(), correlationId: payload.correlationId };
    writeJson(file(root, 'task.json'), task);
    while (!ctx.signal?.aborted) {
      const sub = readIdeSubmit(root);
      if (sub && sub.seq === task.seq) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ agent_claims: [`IDE: ${sub.summary}`.slice(0, 2000)], unverified_changed_files: sub.changedFiles ?? [] }),
          stderr: null,
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { exit_code: 1, stdout: null, stderr: 'IDE did not submit before the deadline' };
  };
}

/** MCP side (aidm_next_task). */
export function ideNextTask(root: string): { state: 'TASK'; task: IdeTask; text: string } | { state: 'NONE'; text: string } {
  const t = readIdeTask(root);
  const sub = readIdeSubmit(root);
  const st = readIdeStatus(root);
  if (t && !(sub && sub.seq === t.seq) && !st?.finished) {
    return {
      state: 'TASK',
      task: t,
      text: [
        `Görev ${t.taskId} (sıra no ${t.seq}). Bu işi bu IDE'de yap; terminalden agy çalıştırma.`,
        `Sadece talimattaki izinli dosyalara dokun. Bitince aidm_submit_task ile seq=${t.seq}, kısa bir özet ve değiştirdiğin dosyaları bildir.`,
        'Director işini bağımsız olarak doğrulayacak; iddiaların tek başına yeterli değil.',
        '',
        t.prompt,
      ].join('\n'),
    };
  }
  if (st?.finished) return { state: 'NONE', text: `Çalışma bitti: ${lastOf(st, 'RUN_FINISHED')?.message ?? ''}`.trim() };
  if (t && sub && sub.seq === t.seq) return { state: 'NONE', text: `Görev ${t.taskId} teslim edildi, Director doğruluyor. aidm_task_result ile seq=${t.seq} sonucunu bekle.` };
  return { state: 'NONE', text: 'Şu an bekleyen görev yok. Çalışma başlamadıysa ya da Director düşünüyorsa biraz sonra tekrar aidm_next_task çağır.' };
}

/** MCP side (aidm_submit_task). Returns false when seq is not the open task. */
export function ideSubmit(root: string, seq: number, summary: string, changedFiles: string[] = []): { ok: boolean; text: string } {
  const t = readIdeTask(root);
  if (!t || t.seq !== seq) return { ok: false, text: `seq=${seq} açık görev değil${t ? ` (açık görev: ${t.taskId}, seq=${t.seq})` : ''}. Önce aidm_next_task çağır.` };
  const sub = readIdeSubmit(root);
  if (sub && sub.seq === seq) return { ok: true, text: 'Bu görev zaten teslim edilmiş.' };
  writeJson(file(root, 'submit.json'), { seq, taskId: t.taskId, summary: String(summary).slice(0, 4000), changedFiles: changedFiles.slice(0, 200), submittedAt: new Date().toISOString() } satisfies IdeSubmit);
  return { ok: true, text: 'Teslim alındı.' };
}

function lastOf(st: IdeStatus, type: string): IdeEvent | undefined {
  return [...st.events].reverse().find((e) => e.type === type);
}

/** MCP side: what happened to submission `seq` (non-blocking). */
export function ideVerdict(root: string, seq: number): IdeVerdict {
  const sub = readIdeSubmit(root);
  const t = readIdeTask(root);
  const st = readIdeStatus(root) ?? { events: [], finished: false, updatedAt: '' };
  const since = sub && sub.seq === seq ? sub.submittedAt : t?.postedAt ?? '';
  const recent = st.events.filter((e) => e.at >= since);
  const warns = recent.filter((e) => e.level !== 'info' && e.type !== 'RUN_FINISHED').map((e) => `- ${e.message}`);
  if (t && t.seq > seq) {
    const doneTask = sub && sub.seq === seq ? sub.taskId : null;
    if (doneTask === t.taskId) {
      return { verdict: 'REPAIR', next: t, message: [`Director işi kabul etmedi; ${t.taskId} için düzeltme gerekiyor.`, ...warns.slice(-8), `Yeni talimat seq=${t.seq}: aidm_next_task ile al, düzelt ve tekrar teslim et.`].join('\n') };
    }
    const accepted = recent.some((e) => e.type === 'TASK_ACCEPTED' && e.taskId === doneTask);
    return {
      verdict: 'ACCEPTED',
      next: t,
      message: accepted
        ? `${doneTask ?? 'Önceki görev'} doğrulandı ve kabul edildi. Sıradaki görev ${t.taskId} (seq=${t.seq}); aidm_next_task ile al.`
        : `${doneTask ?? 'Önceki görev'} kapandı (kabul edilmedi, ayrıntı izleme ekranında). Sıradaki görev ${t.taskId} (seq=${t.seq}); aidm_next_task ile al.`,
    };
  }
  if (st.finished) return { verdict: 'DONE', message: `Çalışma bitti: ${lastOf(st, 'RUN_FINISHED')?.message ?? ''}`.trim() };
  const dec = recent.filter((e) => e.type === 'DECISION_REQUESTED').pop();
  const ans = recent.filter((e) => e.type === 'DECISION_ANSWERED').pop();
  if (dec && (!ans || ans.at < dec.at)) return { verdict: 'WAIT', message: `Director IdP üzerinden senden karar bekliyor: ${dec.message}. Karar verilince aidm_task_result ile seq=${seq} tekrar sor.` };
  return { verdict: 'PENDING', message: `Director hâlâ doğruluyor. Birkaç saniye sonra aidm_task_result ile seq=${seq} tekrar sor.` };
}

/** MCP side: long-poll ideVerdict within an MCP-safe window. */
export async function ideAwaitVerdict(root: string, seq: number, waitMs = 45_000, pollMs = 1500): Promise<IdeVerdict> {
  const end = Date.now() + waitMs;
  for (;;) {
    const v = ideVerdict(root, seq);
    if (v.verdict !== 'PENDING' || Date.now() >= end) return v;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
