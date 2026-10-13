/**
 * Run completion artifacts: Director visual review of headless-browser screenshots (budgeted
 * vision call, advisory) and the one-page Turkish completion report (markdown + IdP upload).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DESIGN_RULES_TR } from './spec-clarification.js';
import { readBrowserCheck, SCREENSHOT_DIR } from './web-checks.js';

export const VISUAL_REVIEW_TASK_ID = 'VISUAL-REVIEW';
const MAX_VISION_IMAGES = 6;

export interface VisualReview {
  status: 'UYGUN' | 'SORUNLU' | 'YAPILMADI';
  notes: string[];
  screenshots: number;
  reason?: string;
}

export interface CompletionShot { name: string; caption: string; file: string; dataUrl: string }

/** Screenshots produced by the browser gate check (jpeg data URLs, size-capped). */
export function collectScreenshots(projectRoot: string, maxBytes = 400 * 1024): CompletionShot[] {
  const bc = readBrowserCheck(projectRoot);
  if (!bc?.screenshots?.length) return [];
  const out: CompletionShot[] = [];
  for (const s of bc.screenshots) {
    const abs = path.join(projectRoot, SCREENSHOT_DIR, path.basename(s.file));
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length > maxBytes) continue;
      const ext = path.extname(abs).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      out.push({ name: path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80), caption: `${s.page} — ${s.view === 'mobil' ? 'telefon' : 'masaüstü'}`, file: abs, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
    } catch {
      /* missing file */
    }
  }
  return out;
}

interface ProviderLike { generate(req: never): Promise<unknown> }

/** Budgeted vision call: Director checks up to 6 screenshots against the binding design rules. */
export async function runVisualReview(ctx: {
  provider: ProviderLike;
  model: string;
  projectId: string;
  runId: string;
  shots: CompletionShot[];
  designBrief?: { name: string; tokens: Record<string, string> };
  isBudgetExhausted: () => boolean;
}): Promise<VisualReview> {
  if (!ctx.shots.length) return { status: 'YAPILMADI', notes: [], screenshots: 0, reason: 'Ekran görüntüsü yok (tarayıcı kontrolü çalışmadı).' };
  if (ctx.isBudgetExhausted()) return { status: 'YAPILMADI', notes: [], screenshots: 0, reason: 'Bütçe bitti.' };
  // Prefer a mix: phone + desktop of the first pages.
  const pick = [...ctx.shots.filter((s) => /mobil/.test(s.name)).slice(0, 3), ...ctx.shots.filter((s) => /masaustu/.test(s.name)).slice(0, 3)].slice(0, MAX_VISION_IMAGES);
  const system = [
    'Sen bir web sitesinin görsel kalite denetçisisin. Ekran görüntülerini aşağıdaki BAĞLAYICI tasarım kurallarına göre değerlendir.',
    ...DESIGN_RULES_TR.map((r) => `- ${r}`),
    ctx.designBrief ? `Seçilen tasarım yönü: ${ctx.designBrief.name}; renk/yazı tokenları: ${JSON.stringify(ctx.designBrief.tokens).slice(0, 600)}` : '',
    'Yalnızca JSON döndür: {"verdict":"UYGUN"|"SORUNLU","notes":["kısa Türkçe gözlem (sayfa + sorun + öneri)", ...]} — en fazla 8 not, sade Türkçe.',
  ].filter(Boolean).join('\n');
  const user = `Ekran görüntüleri sırasıyla: ${pick.map((s) => s.caption).join('; ')}. Kurallara uymayan her şeyi yaz; uygunsa kısa bir olumlu not yeterli.`;
  try {
    const res = (await ctx.provider.generate({
      correlation: { correlation_id: `visual-${crypto.randomUUID()}`, project_id: ctx.projectId, task_id: VISUAL_REVIEW_TASK_ID, attempt: 1 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user, images: pick.map((s) => s.dataUrl) }],
      director_context: { project_id: ctx.projectId, task_id: VISUAL_REVIEW_TASK_ID, objective: 'visual review', acceptance_criteria: null, attempt: 1, max_attempts: 1, relevant_context: null },
      model: ctx.model,
      max_tokens: 2000,
      response_format: 'JSON_OBJECT',
      json_schema: null,
      metadata: { purpose: 'VISUAL_REVIEW', runId: ctx.runId },
    } as never)) as { error?: { message?: string }; structured_output?: unknown; content?: unknown };
    if (res.error) throw new Error(String(res.error.message));
    let obj: unknown = res.structured_output;
    if (!obj || typeof obj !== 'object') {
      const m = /\{[\s\S]*\}/.exec(String(res.content ?? ''));
      obj = m ? JSON.parse(m[0]) : {};
    }
    const o = obj as { verdict?: unknown; notes?: unknown };
    const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 300)).slice(0, 8) : [];
    const verdict = o.verdict === 'UYGUN' || o.verdict === 'SORUNLU' ? o.verdict : notes.length ? 'SORUNLU' : 'YAPILMADI';
    return { status: verdict, notes, screenshots: pick.length, ...(verdict === 'YAPILMADI' ? { reason: 'Director yanıtı anlaşılamadı.' } : {}) };
  } catch (err) {
    return { status: 'YAPILMADI', notes: [], screenshots: 0, reason: `Görsel inceleme yapılamadı (${(err instanceof Error ? err.message : String(err)).slice(0, 160)}).` };
  }
}

const STATUS_TR: Record<string, string> = { COMPLETED: 'Tamamlandı', PARTIAL: 'Kısmen tamamlandı', FAILED: 'Başarısız', STOPPED: 'Durduruldu', BUDGET_EXHAUSTED: 'Bütçe bitti', DRY_RUN_OK: 'Deneme (dry-run) tamam' };
const TASK_TR: Record<string, string> = { ACCEPTED: 'kabul edildi', FAILED: 'başarısız', BLOCKED: 'engellendi', SKIPPED: 'atlandı', PENDING: 'yapılmadı', SPLIT: 'bölündü', WAITING_DECISION: 'karar bekliyor' };

export interface CompletionReportInput {
  runId: string;
  projectName: string;
  status: string;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  tasks: Array<{ taskId: string; title: string; status: string; kind?: string }>;
  decisions: Array<{ question: string; state: string; answer?: unknown }>;
  clarification?: { status: string; lines: string[] };
  designBrief?: { name: string; decidedBy: string };
  budget?: { limitUsd: number; committedUsd: number };
  finalGate?: { status: string; repairs: number; checks: Array<{ command: string; exitCode: number | null }> };
  visualReview?: VisualReview;
  commits: string[];
  approachPlan?: string;
  progressNotes?: string[];
  selfChecks?: Array<{ taskId: string; ok: boolean; doubts: string[] }>;
  promptCache?: { calls: number; inputTokens: number; cachedTokens: number };
  preferencesUsed?: string[];
}

/** One-page Turkish completion summary (plain markdown, no secrets). */
export function renderCompletionReportTr(r: CompletionReportInput, shots: ReadonlyArray<{ caption: string; file?: string }> = []): string {
  const L: string[] = [];
  const mins = r.finishedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 60000)) : null;
  L.push(`# Tamamlama raporu — ${r.projectName}`, '');
  L.push(`**Durum:** ${STATUS_TR[r.status] ?? r.status}${r.stopReason ? ` — ${r.stopReason}` : ''}`);
  L.push(`**Süre:** ${mins === null ? '-' : `${mins} dk`} · **Harcama:** ${r.budget ? `$${r.budget.committedUsd.toFixed(3)} / $${r.budget.limitUsd.toFixed(2)}` : '-'} · **Commit:** ${r.commits.length}`);
  if (r.promptCache?.inputTokens) L.push(`**LLM:** ${r.promptCache.calls} çağrı · girdi ${r.promptCache.inputTokens} token, önbellekten ${r.promptCache.cachedTokens} (%${Math.round((100 * r.promptCache.cachedTokens) / r.promptCache.inputTokens)})`);
  L.push('');
  if (r.approachPlan) L.push('## Yaklaşım planı', ...r.approachPlan.split('\n').map((x) => `- ${x}`), '');
  const work = r.tasks.filter((t) => t.kind !== 'ANALYSIS');
  L.push('## Yapılanlar');
  for (const t of work) L.push(`- ${t.status === 'ACCEPTED' ? '✅' : '⚠️'} ${t.taskId}: ${t.title} (${TASK_TR[t.status] ?? t.status})`);
  if (!work.length) L.push('- (görev yok)');
  L.push('', '## Kararlar');
  const dec: string[] = [];
  if (r.designBrief) dec.push(`Tasarım yönü: ${r.designBrief.name} (${r.designBrief.decidedBy === 'po' ? 'sizin seçiminiz' : 'Director önerisi'})`);
  for (const l of r.clarification?.lines ?? []) dec.push(l);
  for (const d of r.decisions) dec.push(`${d.question.slice(0, 160)} → ${d.answer === undefined ? d.state : typeof d.answer === 'string' ? d.answer : JSON.stringify(d.answer).slice(0, 120)}`);
  L.push(...(dec.length ? dec.slice(0, 15).map((d) => `- ${d}`) : ['- (karar gerekmedi)']));
  const sc = (r.selfChecks ?? []).filter((x) => !x.ok);
  if (sc.length) {
    L.push('', '## Director öz kontrolü (kabulden önce düzeltilenler)');
    for (const x of sc) L.push(`- ${x.taskId}: ${x.doubts.join('; ')}`);
  }
  if (r.progressNotes?.length) {
    L.push('', '## İlerleme notları');
    for (const n of r.progressNotes) L.push(`- ${n.replace(/\n/g, ' · ')}`);
  }
  if (r.preferencesUsed?.length) L.push('', `_Önceki projelerden ${r.preferencesUsed.length} tercih dikkate alındı (IdP → Tercihlerim)._`);
  L.push('', '## Son kontrol');
  if (r.finalGate) {
    L.push(`- Sonuç: **${r.finalGate.status === 'PASS' ? 'GEÇTİ' : r.finalGate.status === 'FAIL' ? 'KALDI' : r.finalGate.status === 'NO_CHECKS' ? 'kontrol yok' : 'çalışmadı'}**${r.finalGate.repairs ? ` (${r.finalGate.repairs} onarım)` : ''}`);
    for (const c of r.finalGate.checks) L.push(`- ${c.exitCode === 0 ? '✅' : '❌'} \`${c.command}\``);
  } else L.push('- Çalışmadı.');
  const v = r.visualReview;
  L.push('', '## Görsel inceleme');
  if (v) {
    L.push(`- Sonuç: **${v.status === 'UYGUN' ? 'Uygun' : v.status === 'SORUNLU' ? 'Düzeltme önerileri var' : 'Yapılmadı'}**${v.reason ? ` — ${v.reason}` : ''}`);
    for (const n of v.notes) L.push(`- ${n}`);
  } else L.push('- Yapılmadı.');
  if (shots.length) {
    L.push('', '## Ekran görüntüleri');
    for (const s of shots) L.push(`- ${s.caption}${s.file ? `: ${s.file}` : ''}`);
  }
  const gaps: string[] = [];
  for (const t of work) if (t.status !== 'ACCEPTED' && t.status !== 'SKIPPED') gaps.push(`${t.taskId} tamamlanmadı (${TASK_TR[t.status] ?? t.status}).`);
  for (const c of r.finalGate?.checks ?? []) if (c.exitCode !== 0) gaps.push(`Kontrol başarısız: ${c.command}`);
  if (r.finalGate?.status === 'NO_CHECKS') gaps.push('Spec’te otomatik kontrol yok; sonuç elle gözden geçirilmeli.');
  if (v?.status === 'SORUNLU') gaps.push('Görsel incelemede düzeltme önerileri var (yukarıda).');
  if (v?.status === 'YAPILMADI') gaps.push('Görsel inceleme yapılamadı.');
  L.push('', '## Bilinen eksikler');
  L.push(...(gaps.length ? gaps.map((g) => `- ${g}`) : ['- Bilinen eksik yok.']));
  L.push('', `_Çalışma: ${r.runId}_`);
  return L.join('\n') + '\n';
}
