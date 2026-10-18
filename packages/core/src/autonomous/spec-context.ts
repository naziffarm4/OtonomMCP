/**
 * @file spec-context.ts
 * @description Two-tier, task-scoped specification context for the Director and executors.
 *
 * Problem: a raw `markdown.slice(0, N)` silently drops everything after N characters, and dumping
 * a very large spec into every prompt degrades model attention and cost.
 *
 * Solution (deterministic, no LLM):
 *  - INLINE mode (spec <= inlineChars, default 30k chars): the COMPLETE spec is sent verbatim.
 *  - TASK-SCOPED mode (larger specs):
 *      Tier 1 - global context (stable for the whole run): title, intro, and the cross-cutting
 *               sections (purpose/overview, technology, users/roles, constraints, non-goals,
 *               decision policy, risks, global acceptance) + a table of contents of EVERY section.
 *      Tier 2 - task context (per task): the FULL, untruncated text of the sections that govern
 *               the current task, selected by heading match + IDF-weighted term overlap
 *               (Turkish-aware normalization and prefix matching for suffixes).
 *    No section is ever cut mid-text: a section either fits whole or is listed by name so the
 *    Director knows it exists and must not invent its content.
 */

import { classifyHeading, type SectionKind } from './spec-ingestor.js';

export const DEFAULT_SPEC_INLINE_CHARS = 30_000;
export const DEFAULT_GLOBAL_SPEC_BUDGET = 14_000;
export const DEFAULT_TASK_SPEC_BUDGET = 16_000;

/** Sections that apply to every task (sent in tier 1). */
const GLOBAL_KINDS: ReadonlySet<SectionKind> = new Set<SectionKind>([
  'PURPOSE',
  'TECH',
  'USERS',
  'CONSTRAINTS',
  'NON_GOALS',
  'DECISION_POLICY',
  'RISKS',
  'ACCEPTANCE',
  'PATHS',
  'COMMANDS',
]);

const STOP_WORDS = new Set([
  'olan', 'olarak', 'gibi', 'daha', 'icin', 'ancak', 'veya', 'sonra', 'once', 'kadar', 'degil', 'tum', 'tumu',
  'butun', 'her', 'ile', 'ama', 'yani', 'ayrica', 'uzerinden', 'icinde', 'gore', 'sadece', 'olmali', 'olmalidir',
  'edilir', 'edilecek', 'yapilir', 'yapilacak', 'olur', 'olacak', 'sistem', 'sistemi', 'detay', 'detaylar',
  'with', 'from', 'that', 'this', 'must', 'should', 'will', 'shall', 'have', 'into', 'when', 'then', 'than',
  'implementation', 'exists', 'project', 'verification', 'checks', 'pass', 'task', 'gorev', 'spec', 'other', 'diger',
]);

export interface SpecTaskRef {
  readonly taskId: string;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface SpecContextOptions {
  /** Specs up to this size are always sent completely (default 30k chars). */
  readonly inlineChars?: number;
  /** Max chars of cross-cutting sections in tier 1 (default 14k). */
  readonly globalBudget?: number;
  /** Max chars of task sections in tier 2 (default 16k). */
  readonly taskBudget?: number;
  /** Relative paths of the source documents (for the Director's orientation). */
  readonly sourceFiles?: readonly string[];
}

interface SpecUnit {
  readonly order: number;
  readonly heading: string;
  readonly parent?: string;
  readonly kind: SectionKind;
  readonly body: string;
  readonly rendered: string;
  readonly words: ReadonlySet<string>;
  readonly headingWords: ReadonlySet<string>;
  readonly headingKey: string;
}

/** Lower-cases (tr-TR) and folds Turkish letters so "Kasa/kasadan/KASALAR" compare cleanly. */
export function normalizeSpecText(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .replace(/i̇/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[âà]/g, 'a')
    .replace(/[îì]/g, 'i')
    .replace(/[ûù]/g, 'u');
}

/** Normalized content words (>= 4 chars, no stop words), truncated to 7 chars as a cheap stem. */
export function specTerms(s: string): string[] {
  const words = normalizeSpecText(s).match(/[a-z0-9]+/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 4 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
    out.push(w.slice(0, 7));
  }
  return out;
}

const headingKeyOf = (h: string) =>
  normalizeSpecText(h.replace(/^[0-9]+[.)]\s*/, '').replace(/^[A-Z]+-\d+[:.)]?\s*/i, ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function matches(term: string, word: string): boolean {
  return word.startsWith(term) || term.startsWith(word);
}

function setHas(set: ReadonlySet<string>, term: string): boolean {
  if (set.has(term)) return true;
  for (const w of set) if (matches(term, w)) return true;
  return false;
}

export class SpecContext {
  readonly markdown: string;
  readonly totalChars: number;
  readonly title: string;
  readonly preamble: string;
  readonly sourceFiles: readonly string[];
  private readonly units: readonly SpecUnit[];
  private readonly inlineChars: number;
  private readonly globalBudget: number;
  private readonly taskBudget: number;
  private readonly globalUnits: readonly SpecUnit[];
  private readonly poolUnits: readonly SpecUnit[];
  private readonly idf = new Map<string, number>();

  constructor(markdown: string, options: SpecContextOptions = {}) {
    this.markdown = markdown;
    this.totalChars = markdown.length;
    this.inlineChars = options.inlineChars ?? DEFAULT_SPEC_INLINE_CHARS;
    this.globalBudget = options.globalBudget ?? DEFAULT_GLOBAL_SPEC_BUDGET;
    this.taskBudget = options.taskBudget ?? DEFAULT_TASK_SPEC_BUDGET;
    this.sourceFiles = options.sourceFiles ?? [];
    const parsed = parseUnits(markdown);
    this.title = parsed.title;
    this.preamble = parsed.preamble;
    this.units = parsed.units;

    // Tier 1: cross-cutting sections in document order while they fit; any overflow stays
    // retrievable per task instead of being truncated.
    const globals: SpecUnit[] = [];
    let used = 0;
    for (const u of this.units) {
      if (!GLOBAL_KINDS.has(u.kind)) continue;
      if (used + u.rendered.length > this.globalBudget) continue;
      globals.push(u);
      used += u.rendered.length;
    }
    this.globalUnits = globals;
    const globalSet = new Set(globals);
    this.poolUnits = this.units.filter((u) => !globalSet.has(u));
  }

  /** True when the whole spec is sent verbatim (no task scoping needed). */
  get isInline(): boolean {
    return this.totalChars <= this.inlineChars;
  }

  get sectionCount(): number {
    return this.units.length;
  }

  private sourcesLine(): string {
    return this.sourceFiles.length > 1 ? `Spec documents (${this.sourceFiles.length}, in order): ${this.sourceFiles.join(', ')}` : '';
  }

  /** Tier 1: stable for the run. Complete spec in inline mode. */
  globalContext(): string {
    if (this.isInline) {
      return [
        `SPEC (Product Owner, verbatim and COMPLETE — ${this.totalChars} chars):`,
        this.sourcesLine(),
        this.markdown,
      ].filter(Boolean).join('\n');
    }
    const toc = this.units.map((u) => `- ${u.parent ? `${u.parent} › ${u.heading}` : u.heading} (${u.body.length} chars)`);
    return [
      `SPEC MODE: TASK-SCOPED. The spec is ${this.totalChars} chars in ${this.units.length} sections — too large to inline in every call.`,
      this.sourcesLine(),
      'Below: the project frame and every cross-cutting section VERBATIM, then a table of contents of ALL sections.',
      'For the current task, the FULL text of every governing section is given separately under "TASK-SCOPED SPEC".',
      'NEVER invent behaviour for a section whose text you have not been given; if the task needs it, say so in rationale and request it (NEED_CONTEXT / REQUEST_HUMAN_DECISION).',
      '',
      this.title ? `# ${this.title}` : '',
      this.preamble,
      ...this.globalUnits.map((u) => u.rendered),
      '',
      '=== SPEC TABLE OF CONTENTS (all sections) ===',
      ...toc,
    ].filter((x) => x !== '').join('\n');
  }

  /** Tier 2: full text of the sections governing this task ('' in inline mode). */
  taskContext(task: SpecTaskRef | undefined | null, budget = this.taskBudget): string {
    if (this.isInline || !task) return '';
    const { selected, omitted } = this.select(task, budget);
    if (selected.length === 0) {
      return [
        `=== TASK-SCOPED SPEC for ${task.taskId}: ${task.title} ===`,
        'No module section matched this task beyond the cross-cutting sections above. Use them and the table of contents; do not invent rules.',
      ].join('\n');
    }
    return [
      `=== TASK-SCOPED SPEC for ${task.taskId}: ${task.title} ===`,
      'The following spec sections are VERBATIM and UNTRUNCATED. They are binding for this task: follow every rule, number, formula, order of operations and platform boundary exactly.',
      ...selected.map((u) => u.rendered),
      omitted.length ? `\nAlso related (not included for size; request if needed, never guess): ${omitted.join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  /** Compact single-block excerpt for auxiliary prompts (self-check, PO questions). */
  excerptForTask(task: SpecTaskRef | undefined | null, budget: number): string {
    if (this.totalChars <= budget) return this.markdown;
    const head = [this.title ? `# ${this.title}` : '', this.preamble].filter(Boolean).join('\n').slice(0, Math.floor(budget * 0.15));
    const remaining = budget - head.length - 200;
    const { selected } = task ? this.select(task, Math.floor(remaining * 0.75)) : { selected: [] as SpecUnit[] };
    let used = selected.reduce((n, u) => n + u.rendered.length, 0);
    const extras: SpecUnit[] = [];
    for (const u of this.globalUnits) {
      if (used + u.rendered.length > remaining) continue;
      extras.push(u);
      used += u.rendered.length;
    }
    const chosen = [...extras, ...selected].sort((a, b) => a.order - b.order);
    return [
      head,
      `[Spec excerpt: ${chosen.length}/${this.units.length} sections relevant to ${task ? task.taskId : 'the run'}, verbatim]`,
      ...chosen.map((u) => u.rendered),
    ].filter(Boolean).join('\n');
  }

  /**
   * Whole-spec review context (spec clarification): complete when it fits, otherwise the frame +
   * cross-cutting sections verbatim and EVERY other section represented by its opening text.
   */
  reviewContext(budget: number): string {
    if (this.totalChars <= budget) return this.markdown;
    const parts: string[] = [];
    const head = [this.title ? `# ${this.title}` : '', this.preamble].filter(Boolean).join('\n');
    parts.push(head.slice(0, Math.floor(budget * 0.1)));
    let used = parts[0].length;
    const globalBudget = Math.floor(budget * 0.4);
    let gUsed = 0;
    for (const u of this.globalUnits) {
      if (gUsed + u.rendered.length > globalBudget) continue;
      parts.push(u.rendered);
      gUsed += u.rendered.length;
    }
    used += gUsed;
    const rest = this.poolUnits;
    const per = Math.max(300, Math.floor((budget - used) / Math.max(1, rest.length)) - 80);
    for (const u of rest) {
      const label = u.parent ? `${u.parent} › ${u.heading}` : u.heading;
      const body = u.body.length <= per ? u.body : `${u.body.slice(0, per)}\n[… section shortened for the review; it is sent in full when its task runs]`;
      parts.push(`## ${label}\n${body}`);
    }
    return [`[Spec review view: ${this.totalChars} chars / ${this.units.length} sections]`, ...parts].join('\n');
  }

  private idfOf(term: string): number {
    const cached = this.idf.get(term);
    if (cached !== undefined) return cached;
    let df = 0;
    for (const u of this.units) if (setHas(u.words, term)) df++;
    const v = Math.log(1 + this.units.length / (1 + df));
    this.idf.set(term, v);
    return v;
  }

  private select(task: SpecTaskRef, budget: number): { selected: SpecUnit[]; omitted: string[] } {
    const weights = new Map<string, number>();
    const add = (text: string | undefined, w: number) => {
      for (const t of specTerms(text ?? '')) weights.set(t, Math.max(weights.get(t) ?? 0, w));
    };
    add(task.title, 3);
    add(task.description, 1);
    for (const c of task.acceptanceCriteria ?? []) add(c, 1);

    const titleKey = headingKeyOf(task.title);
    const scored: Array<{ u: SpecUnit; score: number; forced: boolean }> = [];
    for (const u of this.poolUnits) {
      // Requirements are derived from sections, so a heading match is the strongest signal.
      const fullKey = u.parent ? `${headingKeyOf(u.parent)} ${u.headingKey}` : u.headingKey;
      const forced =
        titleKey.length >= 4 &&
        (u.headingKey === titleKey ||
          fullKey === titleKey ||
          (u.headingKey.length >= 4 && titleKey.includes(u.headingKey)) ||
          fullKey.includes(titleKey));
      let score = 0;
      for (const [t, w] of weights) {
        if (setHas(u.headingWords, t)) score += 3 * w * this.idfOf(t);
        else if (setHas(u.words, t)) score += w * this.idfOf(t);
      }
      if (forced || score > 0) scored.push({ u, score, forced });
    }
    const maxScore = Math.max(0, ...scored.filter((s) => !s.forced).map((s) => s.score));
    const ranked = scored
      .filter((s) => s.forced || s.score >= maxScore * 0.2)
      .sort((a, b) => Number(b.forced) - Number(a.forced) || b.score - a.score || a.u.order - b.u.order);

    const selected: SpecUnit[] = [];
    const omitted: string[] = [];
    let used = 0;
    for (const s of ranked) {
      if (used + s.u.rendered.length <= budget) {
        selected.push(s.u);
        used += s.u.rendered.length;
      } else if (s.forced && selected.length === 0) {
        // The task's own section is larger than the whole budget: keep it, it is the contract.
        selected.push(s.u);
        used += s.u.rendered.length;
      } else {
        omitted.push(s.u.parent ? `${s.u.parent} › ${s.u.heading}` : s.u.heading);
      }
    }
    selected.sort((a, b) => a.order - b.order);
    return { selected, omitted: omitted.slice(0, 15) };
  }
}

function parseUnits(markdown: string): { title: string; preamble: string; units: SpecUnit[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const preamble: string[] = [];
  interface Group { heading: string; intro: string[]; subs: Array<{ heading: string; lines: string[] }> }
  const groups: Group[] = [];
  let cur: Group | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      const h3 = /^###\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1 && !title && !cur) {
        title = h1[1].trim();
        continue;
      }
      if (h2) {
        cur = { heading: h2[1].replace(/\*\*/g, '').trim(), intro: [], subs: [] };
        groups.push(cur);
        continue;
      }
      if (h3 && cur) {
        cur.subs.push({ heading: h3[1].replace(/\*\*/g, '').trim(), lines: [] });
        continue;
      }
    }
    if (!cur) preamble.push(line);
    else if (cur.subs.length) cur.subs[cur.subs.length - 1].lines.push(line);
    else cur.intro.push(line);
  }

  const units: SpecUnit[] = [];
  const mk = (heading: string, body: string, kind: SectionKind, parent?: string): SpecUnit => {
    const label = parent ? `### ${parent} › ${heading}` : `## ${heading}`;
    const trimmed = body.replace(/^\s+|\s+$/g, '');
    return {
      order: units.length,
      heading,
      parent,
      kind,
      body: trimmed,
      rendered: `${label}\n${trimmed}`,
      words: new Set(specTerms(`${parent ?? ''} ${heading} ${trimmed}`)),
      headingWords: new Set(specTerms(`${parent ?? ''} ${heading}`)),
      headingKey: headingKeyOf(heading),
    };
  };
  for (const g of groups) {
    const kind = classifyHeading(g.heading);
    const intro = g.intro.join('\n');
    if (g.subs.length === 0) {
      units.push(mk(g.heading, intro, kind));
      continue;
    }
    if (intro.trim()) units.push(mk(g.heading, intro, kind));
    for (const s of g.subs) units.push(mk(s.heading, s.lines.join('\n'), kind, g.heading));
  }
  return { title, preamble: preamble.join('\n').trim(), units };
}

/** AIDM_SPEC_INLINE_CHARS (2000..200000) overrides the inline threshold. */
export function resolveSpecInlineChars(env: Readonly<Record<string, string | undefined>>): number {
  const n = Number(env.AIDM_SPEC_INLINE_CHARS);
  return Number.isInteger(n) && n >= 2000 && n <= 200_000 ? n : DEFAULT_SPEC_INLINE_CHARS;
}
