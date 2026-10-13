/**
 * Karar günlüğü: every Director/AIDM decision of a run with a short plain-Turkish rationale,
 * timestamp and related task. Written live to .ai-manager/reports/karar-gunlugu-<runId>.md and
 * mirrored to the IdP run page as DECISION_LOG events. Rationales are AIDM-authored templates
 * (plus the PO's own answers); raw prompts / LLM output are never recorded.
 */
import fs from 'node:fs';
import path from 'node:path';

export type DecisionKind =
  | 'PLAN' | 'TASK_CREATE' | 'TASK_ACCEPT' | 'TASK_REPAIR' | 'SCOPE' | 'DESIGN' | 'ASSUMPTION' | 'SELF_CHECK' | 'STOP';

export const DECISION_KIND_TR: Record<DecisionKind, string> = {
  PLAN: 'Plan',
  TASK_CREATE: 'Görev oluşturma',
  TASK_ACCEPT: 'Görev kabulü',
  TASK_REPAIR: 'Düzeltme',
  SCOPE: 'Kapsam',
  DESIGN: 'Tasarım tercihi',
  ASSUMPTION: 'Varsayım',
  SELF_CHECK: 'Öz kontrol',
  STOP: 'Durma',
};

export interface DecisionEntry {
  seq: number;
  at: string;
  kind: DecisionKind;
  taskId: string | null;
  title: string;
  rationale: string;
}

const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi;

export function cleanDecisionText(s: unknown, max: number): string {
  const t = String(s ?? '').replace(SECRET_RE, '[gizli]').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Monitor line: "[Tür] başlık — gerekçe" (≤ 700 chars). */
export function decisionEventMessage(e: Pick<DecisionEntry, 'kind' | 'title' | 'rationale'>): string {
  return cleanDecisionText(`[${DECISION_KIND_TR[e.kind]}] ${e.title}${e.rationale ? ` — ${e.rationale}` : ''}`, 700);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Istanbul is UTC+3 all year.
  const t = new Date(d.getTime() + 3 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 19)} TRT`;
}

export function renderDecisionLogMd(runId: string, entries: readonly DecisionEntry[]): string {
  const lines = [
    `# Karar günlüğü — ${runId}`,
    '',
    'Director ve AIDM\'nin bu çalışmadaki kararları, kısa gerekçeleriyle (zaman TRT). Ham istem/LLM içeriği yer almaz.',
    '',
  ];
  if (!entries.length) lines.push('_Henüz karar yok._');
  for (const e of entries) {
    lines.push(`## ${e.seq}. ${DECISION_KIND_TR[e.kind]}: ${e.title}`);
    lines.push(`- **Zaman:** ${fmtTime(e.at)}`);
    if (e.taskId) lines.push(`- **Görev:** ${e.taskId}`);
    if (e.rationale) lines.push(`- **Gerekçe:** ${e.rationale}`);
    lines.push('');
  }
  return lines.join('\n');
}

export class DecisionLog {
  readonly entries: DecisionEntry[] = [];
  readonly filePath: string | null;
  constructor(
    projectRoot: string | null,
    readonly runId: string,
    private readonly onRecord?: (e: DecisionEntry) => void,
    seed: readonly DecisionEntry[] = []
  ) {
    this.filePath = projectRoot ? path.join(projectRoot, '.ai-manager', 'reports', `karar-gunlugu-${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`) : null;
    this.entries.push(...seed);
  }

  record(kind: DecisionKind, title: string, rationale = '', taskId?: string | null): DecisionEntry | null {
    const t = cleanDecisionText(title, 200);
    if (!t) return null;
    const r = cleanDecisionText(rationale, 400);
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === kind && last.title === t && last.taskId === (taskId ?? null)) return null; // de-dup repeats
    if (this.entries.length >= 1000) return null;
    const e: DecisionEntry = { seq: this.entries.length + 1, at: new Date().toISOString(), kind, taskId: taskId ?? null, title: t, rationale: r };
    this.entries.push(e);
    this.flush();
    try {
      this.onRecord?.(e);
    } catch {
      /* listener errors never affect the run */
    }
    return e;
  }

  flush(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `\uFEFF${renderDecisionLogMd(this.runId, this.entries)}`, 'utf8');
      fs.renameSync(tmp, this.filePath);
      fs.writeFileSync(this.filePath.replace(/\.md$/, '.json'), JSON.stringify(this.entries), 'utf8');
    } catch {
      /* the log never breaks a run */
    }
  }
}

/** Turkish rendering of a report assumption line "[TASK] text" → {taskId, text}. */
export function splitAssumption(line: string): { taskId: string | null; text: string } {
  const m = /^\[([^\]]{1,80})\]\s*(.*)$/s.exec(line);
  return m ? { taskId: m[1]!, text: m[2]! } : { taskId: null, text: line };
}

/** Translates known English assumption templates to plain Turkish (others pass through). */
export function assumptionTr(text: string): string {
  let m = /^Director asked "(.*)"; proceeding with the most conventional/s.exec(text);
  if (m) return `Director bir ayrıntıyı netleştirmek istedi; spec ile uyumlu en yaygın yorumla devam edildi (soru: ${m[1]}).`;
  m = /^PO widened the task scope with: (.*)\.$/s.exec(text);
  if (m) return `Ürün sahibi görev kapsamını genişletti: ${m[1]}.`;
  m = /^PO granted 2 more attempts \(now (\d+)\)\.$/.exec(text);
  if (m) return `Ürün sahibi 2 deneme hakkı daha verdi (toplam ${m[1]}).`;
  m = /^PO decision: (.*)$/s.exec(text);
  if (m) return `Ürün sahibi kararı: ${m[1]}`;
  m = /^Spec has no H1 title; project name assumed to be '(.*)'\.$/.exec(text);
  if (m) return `Spec'te ana başlık yok; proje adı '${m[1]}' kabul edildi.`;
  if (/^Spec has no purpose\/overview paragraph/.test(text)) return 'Spec\'te amaç/genel bakış paragrafı yok; amaç başlıktan çıkarıldı.';
  if (/^No explicit requirements section/.test(text)) return 'Ayrı bir gereksinim bölümü yok; diğer bölümlerdeki maddeler gereksinim sayıldı.';
  if (/^No requirement list found/.test(text)) return 'Gereksinim listesi bulunamadı; spec\'in tamamı tek gereksinim sayıldı.';
  m = /^(\S+) has no acceptance criteria;/.exec(text);
  if (m) return `${m[1]} için kabul kriteri yok; "uygulama mevcut ve proje kontrolleri geçiyor" kabul edildi.`;
  if (/^No technology stack specified/.test(text)) return 'Teknoloji belirtilmemiş; Director mevcut dosyalarla uyumlu yaygın bir yapı seçecek.';
  return text;
}
