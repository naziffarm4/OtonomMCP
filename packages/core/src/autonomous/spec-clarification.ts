/**
 * @file spec-clarification.ts
 * @description Pre-implementation review of the spec by the Director ("Netleştirme").
 *
 * After the run is approved and BEFORE any task runs, the Director reviews the whole plan like a
 * thoughtful human lead (goals, scope, architecture, tech choices, task breakdown/order, risks,
 * verification) and returns:
 *   - CLARIFICATION questions: open points of the spec (2-4 options, recommended option, rationale);
 *   - IMPROVEMENT proposals ("Önerilen iyileştirmeler"): plan changes the human may accept/reject.
 * Every human-facing string must be plain Turkish (validated; one repair call; non-Turkish items dropped).
 * Each option carries the measurable acceptance criteria it implies, optional declarative checks
 * (rendered by AIDM into a dependency-free node script for the final gate) and optional in-scope
 * new tasks. ONE IdP interaction (operation SPEC_CLARIFICATION, contract v1.2): the human picks per
 * question; the picks finalize criteria/checks/tasks. Free-text-only answers are converted into
 * criteria by one more Director call (no human interaction). State is keyed by spec fingerprint, so a
 * resumed/restarted run never re-asks answered questions and never re-calls the Director for them.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ITrustedIdentityProvider } from '../authorization/trusted-identity-types.js';
import { IdpClient, canonicalJson, sha256Hex, verifyIdpToken } from './idp-client.js';
import { DECISION_TTL_MS } from './decision-requests.js';

type Env = Readonly<Record<string, string | undefined>>;

export const SPEC_CLARIFICATION_OPERATION = 'SPEC_CLARIFICATION';
export const SPEC_CLARIFICATION_TASK_ID = 'SPEC-CLARIFY';
export const CLARIFICATION_DIR = path.join('.ai-manager', 'state', 'spec-clarification');
export const CHECKS_SCRIPT_PATH = 'scripts/aidm-checks/spec-clarifications.mjs';
export const MAX_CLARIFICATION_QUESTIONS = 8;
export const MAX_IMPROVEMENTS = 4;

// ------------------------------------------------------------------ types

export type ClarificationCheck =
  | { type: 'file_exists' | 'file_absent'; path: string; description: string }
  | { type: 'file_contains'; path: string; pattern: string; regex: boolean; description: string }
  | { type: 'glob_count'; glob: string; min?: number; max?: number; description: string }
  | { type: 'each_file_contains' | 'no_file_contains'; glob: string; pattern: string; regex: boolean; description: string }
  /** Some file matching glob defines every CSS custom property (`--name: value`). Design brief tokens. */
  | { type: 'css_tokens'; glob: string; tokens: Record<string, string>; description: string };

export const DESIGN_QUESTION_ID = 'design-direction';
export const DESIGN_BRIEF_PATH = path.join('.ai-manager', 'state', 'design-brief.json');

/** Director-owned visual direction (one option of the design-direction question). */
export interface DesignDirection {
  name: string;
  rationale: string;
  /** CSS custom property name (without --) -> value, e.g. { "renk-ana": "#1f3b2d" }. */
  palette: Record<string, string>;
  fonts: { heading: string; body: string };
  layout: string;
  imagery: string;
  tone: string;
  /** When emoji fit the subject (not banned), e.g. "yalnızca kategori etiketlerinde". */
  emoji: string;
}

/** Binding design brief: chosen direction + the tokens the shared CSS must define. */
export interface DesignBrief extends DesignDirection {
  questionId: string;
  optionId: string;
  tokens: Record<string, string>;
  cssGlob: string;
  decidedBy: 'PO' | 'RECOMMENDED';
}

export interface ClarificationNewTask {
  title: string;
  description: string;
  targetFiles: string[];
  criteria: string[];
}

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
  /** Measurable acceptance criteria (Turkish) this option implies. */
  criteria: string[];
  /** Task ids the criteria apply to; empty = all tasks. */
  appliesTo: string[];
  checks: ClarificationCheck[];
  newTasks: ClarificationNewTask[];
  /** Only on the design-direction question. */
  design?: DesignDirection;
}

export interface SpecClarificationQuestion {
  id: string;
  kind: 'CLARIFICATION' | 'IMPROVEMENT';
  question: string;
  reason: string;
  options: ClarificationOption[];
  recommendedOptionId: string;
  allowFreeText: boolean;
}

export interface ClarificationProposal {
  summary: string;
  questions: SpecClarificationQuestion[];
  warnings: string[];
}

export interface ClarificationAnswerItem {
  questionId: string;
  selectedOptionId?: string;
  freeText?: string;
}

export type SpecClarificationStatus = 'NONE' | 'PENDING' | 'ANSWERED' | 'AUTO_RECOMMENDED' | 'EXPIRED' | 'FAILED';

export interface ClarificationState {
  schemaVersion: 1;
  specFingerprint: string;
  projectId: string;
  status: SpecClarificationStatus;
  summary: string;
  questions: SpecClarificationQuestion[];
  decisionId?: string;
  runId?: string;
  decisionUrl?: string;
  answers?: ClarificationAnswerItem[];
  answeredBy?: string;
  answeredAt?: string;
  /** Criteria derived from free-text answers by the Director (no human interaction). */
  freeTextCriteria?: Array<{ questionId: string; criteria: string[]; appliesTo: string[]; checks: ClarificationCheck[] }>;
  failure?: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ spec setting

/** `Netleştirme: açık|kapalı` (ascii `netlestirme`); default on. undefined when unrecognized. */
export function parseClarificationSetting(raw: string): boolean | undefined {
  const v = raw
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ç/g, 'c')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .trim();
  if (/^(acik|evet|on|true|yes|1)$/.test(v)) return true;
  if (/^(kapali|hayir|off|false|no|0|yok)$/.test(v)) return false;
  return undefined;
}

// ------------------------------------------------------------------ Turkish validation

const TR_CHARS = /[çğıöşüÇĞİÖŞÜ]/;
const TR_WORDS = /\b(ve|bir|bu|mi|mı|mu|mü|için|ile|olarak|olsun|nasıl|hangi|sayfa|sayfası|dosya|dosyası|tek|her|değil|var|yok|gerek|kullan\w*|ekle\w*|olmalı|mı\?|daha|yerine|önce|sonra|evet|hayır|kabul|öneri\w*)\b/i;

/** Heuristic: non-empty and recognizably Turkish (Turkish letters or common Turkish words). */
export function looksTurkish(text: string | undefined): boolean {
  if (!text || !text.trim()) return false;
  return TR_CHARS.test(text) || TR_WORDS.test(text);
}

function questionIsTurkish(q: SpecClarificationQuestion): boolean {
  return (
    looksTurkish(q.question) &&
    looksTurkish(q.reason) &&
    q.options.every((o) => looksTurkish(`${o.label} ${o.description ?? ''} ${o.criteria.join(' ')}`))
  );
}

// ------------------------------------------------------------------ normalization (untrusted LLM output)

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
}
function safeRel(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return !!n && !n.startsWith('/') && !/^[a-zA-Z]:/.test(n) && !n.split('/').includes('..') && !n.startsWith('.git/') && !n.startsWith('.ai-manager');
}
function slug(s: string, i: number, prefix: string): string {
  const b = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return b || `${prefix}${i + 1}`;
}

export function normalizeCheck(raw: unknown): ClarificationCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = String(r.type ?? '');
  const description = str(r.description, 300) || type;
  const regex = r.regex === true;
  const pattern = str(r.pattern, 200);
  if (regex && pattern) {
    try {
      new RegExp(pattern);
    } catch {
      return null;
    }
  }
  const p = str(r.path, 300).replace(/\\/g, '/');
  const glob = str(r.glob, 300).replace(/\\/g, '/');
  switch (type) {
    case 'file_exists':
    case 'file_absent':
      return safeRel(p) ? { type, path: p, description } : null;
    case 'file_contains':
      return safeRel(p) && pattern ? { type, path: p, pattern, regex, description } : null;
    case 'glob_count': {
      if (!safeRel(glob)) return null;
      const min = Number.isInteger(r.min) && (r.min as number) >= 0 ? (r.min as number) : undefined;
      const max = Number.isInteger(r.max) && (r.max as number) >= 0 ? (r.max as number) : undefined;
      if (min === undefined && max === undefined) return null;
      return { type, glob, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), description };
    }
    case 'each_file_contains':
    case 'no_file_contains':
      return safeRel(glob) && pattern ? { type, glob, pattern, regex, description } : null;
    case 'css_tokens': {
      const tokens = normalizeTokens(r.tokens);
      return safeRel(glob) && Object.keys(tokens).length ? { type, glob, tokens, description } : null;
    }
    default:
      return null;
  }
}

const TOKEN_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const TOKEN_VALUE_RE = /^(#[0-9a-fA-F]{3,8}|[A-Za-z0-9 ,.'"%()-]{1,80})$/;
function normalizeTokens(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k0, v] of Object.entries(raw as Record<string, unknown>).slice(0, 16)) {
    const k = k0.replace(/^--/, '').toLowerCase();
    if (TOKEN_NAME_RE.test(k) && typeof v === 'string' && TOKEN_VALUE_RE.test(v.trim())) out[k] = v.trim();
  }
  return out;
}

/** Normalizes an option's design direction; null unless it has >= 3 hex colours and both fonts. */
export function normalizeDesign(raw: unknown): DesignDirection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const palette: Record<string, string> = {};
  for (const [k, v] of Object.entries(normalizeTokens(r.palette))) if (/^#[0-9a-fA-F]{3,8}$/.test(v)) palette[k] = v.toLowerCase();
  const f = (r.fonts && typeof r.fonts === 'object' ? r.fonts : {}) as Record<string, unknown>;
  const heading = str(f.heading, 80);
  const body = str(f.body, 80);
  if (Object.keys(palette).length < 3 || !heading || !body) return null;
  return {
    name: str(r.name, 120),
    rationale: str(r.rationale, 600),
    palette,
    fonts: { heading, body },
    layout: str(r.layout, 400),
    imagery: str(r.imagery, 400),
    tone: str(r.tone, 300),
    emoji: str(r.emoji, 200),
  };
}

/** Tokens the shared CSS must define for a direction (colours + the two font stacks). */
export function designTokens(d: DesignDirection): Record<string, string> {
  return { ...d.palette, 'font-baslik': d.fonts.heading, 'font-govde': d.fonts.body };
}

function designCriteria(d: DesignDirection): string[] {
  const vars = Object.entries(designTokens(d)).map(([k, v]) => `--${k}: ${v}`).join('; ');
  return [
    `Tasarım yönü "${d.name || 'seçilen'}" bağlayıcıdır: ortak CSS şu değişkenleri :root içinde tanımlar: ${vars}`.slice(0, 300),
    'Renkler ve yazı tipleri yalnızca bu CSS değişkenleriyle kullanılır; bunların dışında yeni bir palet veya yazı tipi uydurulmaz.',
    `Yerleşim: ${d.layout || '-'}; görseller: ${d.imagery || '-'}; ton: ${d.tone || '-'}`.slice(0, 300),
  ];
}

function normalizeOption(raw: unknown, i: number, knownTaskIds: ReadonlySet<string>): ClarificationOption | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const label = str(r.label, 200);
  if (!label) return null;
  const id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : slug(label, i, 'opt');
  const applies = strList(r.appliesTo, 20, 64).filter((t) => knownTaskIds.has(t));
  const checks = (Array.isArray(r.checks) ? r.checks : []).map(normalizeCheck).filter((c): c is ClarificationCheck => !!c).slice(0, 6);
  const newTasks = (Array.isArray(r.newTasks) ? r.newTasks : [])
    .map((t) => {
      const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      const title = str(o.title, 200);
      if (!title) return null;
      return {
        title,
        description: str(o.description, 2000) || title,
        targetFiles: strList(o.targetFiles, 10, 300).map((f) => f.replace(/\\/g, '/')).filter(safeRel),
        criteria: strList(o.criteria, 8, 300),
      };
    })
    .filter((t): t is ClarificationNewTask => !!t)
    .slice(0, 3);
  let description = str(r.description, 1000);
  const design = normalizeDesign(r.design);
  let criteria = strList(r.criteria, 8, 300);
  if (design) {
    // The PO sees the concrete tokens; the chosen option carries binding criteria + a token check.
    const pal = Object.entries(design.palette).map(([k, v]) => `${k} ${v}`).join(', ');
    description = [description || design.rationale, `Palet: ${pal}`, `Yazı tipleri: ${design.fonts.heading} / ${design.fonts.body}`, design.emoji ? `Emoji: ${design.emoji}` : '']
      .filter(Boolean)
      .join(' — ')
      .slice(0, 1000);
    criteria = [...designCriteria(design), ...criteria].slice(0, 8);
    checks.unshift({ type: 'css_tokens', glob: '**/*.css', tokens: designTokens(design), description: 'Ortak CSS tasarım değişkenlerini tanımlıyor' });
  }
  return { id, label, ...(description ? { description } : {}), criteria, appliesTo: design ? [] : applies, checks: checks.slice(0, 6), newTasks, ...(design ? { design } : {}) };
}

/** Normalizes the Director's (untrusted) review into a bounded proposal. */
export function normalizeClarificationProposal(raw: unknown, knownTaskIds: readonly string[]): ClarificationProposal {
  const known = new Set(knownTaskIds);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const warnings: string[] = [];
  const out: SpecClarificationQuestion[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(r.questions) ? r.questions : [];
  let clar = 0;
  let impr = 0;
  list.forEach((q0, i) => {
    const q = (q0 && typeof q0 === 'object' ? q0 : {}) as Record<string, unknown>;
    const kind = q.kind === 'IMPROVEMENT' ? 'IMPROVEMENT' : 'CLARIFICATION';
    if (kind === 'IMPROVEMENT' ? impr >= MAX_IMPROVEMENTS : clar >= MAX_CLARIFICATION_QUESTIONS) return;
    const question = str(q.question, 1000);
    if (!question) return;
    const opts: ClarificationOption[] = [];
    const ids = new Set<string>();
    (Array.isArray(q.options) ? q.options : []).slice(0, 4).forEach((o, j) => {
      const n = normalizeOption(o, j, known);
      if (!n) return;
      while (ids.has(n.id)) n.id = `${n.id}-${j + 1}`;
      ids.add(n.id);
      opts.push(n);
    });
    if (opts.length < 2) {
      warnings.push(`Soru atlandı (en az 2 seçenek gerekli): ${question.slice(0, 80)}`);
      return;
    }
    let id = typeof q.id === 'string' && ID_RE.test(q.id) ? q.id : slug(question, i, 'q');
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const rec = typeof q.recommendedOptionId === 'string' && opts.some((o) => o.id === q.recommendedOptionId) ? q.recommendedOptionId : opts[0].id;
    out.push({
      id,
      kind,
      question,
      reason: str(q.reason, 1000),
      options: opts,
      recommendedOptionId: rec,
      allowFreeText: q.allowFreeText !== false,
    });
    if (kind === 'IMPROVEMENT') impr++;
    else clar++;
  });
  return { summary: str(r.summary, 2000), questions: out, warnings };
}

/** Splits into Turkish-valid questions and the rest. */
export function partitionTurkish(p: ClarificationProposal): { ok: SpecClarificationQuestion[]; bad: SpecClarificationQuestion[] } {
  const ok: SpecClarificationQuestion[] = [];
  const bad: SpecClarificationQuestion[] = [];
  for (const q of p.questions) (questionIsTurkish(q) ? ok : bad).push(q);
  return { ok, bad };
}

// ------------------------------------------------------------------ Director prompt

export const CLARIFICATION_SYSTEM_PROMPT = [
  'You are the Director (technical lead) of an autonomous software run. A human Product Owner (PO) wrote the spec below.',
  'Do NOT rush into implementation. First review the WHOLE plan like a thoughtful senior lead: goals, scope, architecture,',
  'technology choices, shared components (e.g. how a common navigation/header is included), styling strategy (single vs per-page CSS),',
  'folder layout, routing, data handling, task breakdown and order, risks, and how success will be verified (missing or',
  'unmeasurable acceptance criteria). Ask ONLY about points that are genuinely open or where a wrong guess would cost rework,',
  'and propose IMPROVEMENTS where you see a clearly better approach (kind "IMPROVEMENT", options e.g. "Evet, uygula" / "Hayır, spec\'teki gibi kalsın").',
  'If the spec is clear and you see no better approach, return {"questions": []}.',
  '',
  'LANGUAGE RULE (strict): every human-facing field (summary, question, reason, option label/description, criteria, check description,',
  'new task title/description) MUST be clear, plain TURKISH, as non-technical as possible. "reason" = short "neden soruyorum" explanation.',
  '',
  'Return ONLY a JSON object:',
  '{ "summary": "<Türkçe: planı nasıl anladığın, 1-3 cümle>",',
  '  "questions": [ { "id": "nav", "kind": "CLARIFICATION"|"IMPROVEMENT", "question": "<Türkçe soru>", "reason": "<Türkçe: neden soruyorum>",',
  '     "recommendedOptionId": "<option id>", "allowFreeText": true,',
  '     "options": [ { "id": "a", "label": "<Türkçe>", "description": "<Türkçe>",',
  '        "criteria": ["<Türkçe, ölçülebilir kabul kriteri>"], "appliesTo": ["TASK-002"] /* empty = all tasks */,',
  '        "checks": [ { "type": "file_exists"|"file_absent", "path": "nav.html", "description": "<Türkçe>" },',
  '                    { "type": "file_contains", "path": "index.html", "pattern": "nav.html", "regex": false, "description": "..." },',
  '                    { "type": "glob_count", "glob": "**/*.css", "max": 1, "description": "..." },',
  '                    { "type": "each_file_contains"|"no_file_contains", "glob": "*.html", "pattern": "...", "regex": false, "description": "..." } ],',
  '        "newTasks": [ { "title": "<Türkçe>", "description": "<Türkçe>", "targetFiles": ["..."], "criteria": ["<Türkçe>"] } ] } ] } ] }',
  '',
  `DESIGN DIRECTION (UI/web projects, i.e. the plan has HTML/CSS pages): YOU, not the coding agent, own the visual design. Include exactly one`,
  `CLARIFICATION question with id "${DESIGN_QUESTION_ID}" proposing 2-3 genuinely different directions a thoughtful human designer would choose for THIS`,
  'subject and audience. Each option has a "design" object: { "name", "rationale" (Türkçe, why it fits the subject/audience),',
  '  "palette": { "renk-ana": "#hex", "renk-vurgu": "#hex", "renk-zemin": "#hex", "renk-metin": "#hex", ... } (3-8 colours, kebab-case names),',
  '  "fonts": { "heading": "<font stack>", "body": "<font stack>" }, "layout": "<Türkçe>", "imagery": "<Türkçe>", "tone": "<Türkçe>",',
  '  "emoji": "<Türkçe: where emoji fit, or \'kullanılmaz\'>" }. Set recommendedOptionId to your choice.',
  'Avoid the generic "AI-made" look (default purple/blue gradients, generic glassmorphism cards, stock hero templates, uniform rounded',
  'card grids) unless the subject truly justifies it. Emoji are allowed where they genuinely fit the subject and audience.',
  'Reason from THIS project\'s own subject and audience like a human designer: who visits, what they need, what feeling the brand',
  'should convey. Let that drive palette restraint, typography, whitespace, motion, readability and imagery. Do not reuse a default',
  'palette or font pair across projects; every value must be justified in "rationale" by the subject and audience.',
  '',
  `At most ${MAX_CLARIFICATION_QUESTIONS} CLARIFICATION and ${MAX_IMPROVEMENTS} IMPROVEMENT items, each with 2-4 options. Checks must be objective`,
  'file/content checks on the finished project (project-relative paths, simple globs). newTasks only inside the allowed paths.',
].join('\n');

export function buildClarificationUserPrompt(input: {
  specMarkdown: string;
  tasks: ReadonlyArray<{ taskId: string; title: string; description?: string; acceptance?: readonly string[] }>;
  allowedPaths: readonly string[];
  verificationCommands: readonly string[];
}): string {
  return [
    'SPEC (verbatim):',
    input.specMarkdown.slice(0, 20_000),
    '',
    'CURRENT TASK PLAN (ingested from the spec):',
    ...input.tasks.map((t) => `- ${t.taskId}: ${t.title}${t.acceptance?.length ? ` | kriterler: ${t.acceptance.join('; ')}` : ' | kriter yok'}`),
    `Allowed paths: ${input.allowedPaths.join(', ') || '(project root)'}`,
    `Verification commands: ${input.verificationCommands.join(' | ') || '(none)'}`,
  ].join('\n');
}

export const TURKISH_REPAIR_PROMPT =
  'Some human-facing fields in your previous JSON were not in Turkish. Return the SAME JSON (same ids, same structure) with every ' +
  'human-facing field rewritten in clear, plain Turkish. Return ONLY the JSON object.';

export const FREE_TEXT_SYSTEM_PROMPT = [
  'You are the Director. The Product Owner answered some spec-review questions with free text instead of an option.',
  'Turn each answer into measurable acceptance criteria (Turkish) and, when objective, declarative checks (same check types as before).',
  'Return ONLY JSON: { "items": [ { "questionId": "...", "criteria": ["<Türkçe>"], "appliesTo": [], "checks": [] } ] }',
].join('\n');

// ------------------------------------------------------------------ state

function statePath(projectRoot: string, specFingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(specFingerprint)) throw new Error('specFingerprint must be sha256 hex');
  return path.join(projectRoot, CLARIFICATION_DIR, `${specFingerprint}.json`);
}

export function loadClarificationState(projectRoot: string, specFingerprint: string): ClarificationState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(projectRoot, specFingerprint), 'utf8')) as ClarificationState;
  } catch {
    return null;
  }
}

export async function saveClarificationState(projectRoot: string, st: ClarificationState): Promise<void> {
  st.updatedAt = new Date().toISOString();
  const p = statePath(projectRoot, st.specFingerprint);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(st, null, 2), 'utf8');
  await fs.promises.rename(tmp, p);
}

// ------------------------------------------------------------------ IdP request (contract v1.2)

export interface ClarificationRequest {
  decisionId: string;
  projectRoot: string;
  projectId: string;
  runId: string;
  packageId: string;
  revision: number;
  title: string;
  summary: string;
  questions: SpecClarificationQuestion[];
  contextFingerprint: string;
  nonce: string;
  requestedAt: string;
  expiresAt: string;
}

/** Wire form of the questions (what the human sees and what the fingerprint binds). */
export function wireQuestions(qs: readonly SpecClarificationQuestion[]) {
  return qs.map((q) => ({
    id: q.id,
    kind: q.kind,
    question: q.question,
    ...(q.reason ? { reason: q.reason } : {}),
    options: q.options.map((o) => {
      const crit = [...o.criteria, ...o.newTasks.map((t) => `Yeni görev: ${t.title}`)].slice(0, 8);
      return { id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}), ...(crit.length ? { criteria: crit } : {}) };
    }),
    recommendedOptionId: q.recommendedOptionId,
    allowFreeText: q.allowFreeText,
  }));
}

export function buildClarificationRequest(input: {
  projectRoot: string;
  projectId: string;
  runId: string;
  packageId: string;
  revision: number;
  summary: string;
  questions: SpecClarificationQuestion[];
  ttlMs?: number;
}): ClarificationRequest {
  const decisionId = crypto.randomUUID();
  const title = `Uygulamaya başlamadan önce ${input.questions.length} soru / öneri`;
  const now = Date.now();
  const contextFingerprint = sha256Hex(
    canonicalJson({
      projectId: input.projectId,
      runId: input.runId,
      taskId: SPEC_CLARIFICATION_TASK_ID,
      decisionId,
      question: title,
      questions: wireQuestions(input.questions),
    })
  );
  return {
    decisionId,
    projectRoot: path.resolve(input.projectRoot),
    projectId: input.projectId,
    runId: input.runId,
    packageId: input.packageId,
    revision: input.revision,
    title,
    summary: input.summary,
    questions: input.questions,
    contextFingerprint,
    nonce: crypto.randomBytes(24).toString('base64url'),
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (input.ttlMs ?? DECISION_TTL_MS)).toISOString(),
  };
}

export type ClarificationOutcome =
  | { status: 'ANSWERED'; answers: ClarificationAnswerItem[]; answeredBy: string; answeredAt: string }
  | { status: 'EXPIRED' | 'FAILED' | 'UNAVAILABLE'; reason: string };

export interface ClarificationResolver {
  readonly channel: 'EXTERNAL_IDP';
  resolve(req: ClarificationRequest, onCreated?: (decisionUrl?: string) => void | Promise<void>): Promise<ClarificationOutcome>;
}

/** Validates the signed answers claim against the request (every question answered, ids valid). */
export function validateClarificationAnswers(req: Pick<ClarificationRequest, 'questions'>, raw: unknown): { answers?: ClarificationAnswerItem[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'answers claim missing' };
  const byId = new Map<string, ClarificationAnswerItem>();
  for (const a0 of raw) {
    const a = (a0 && typeof a0 === 'object' ? a0 : {}) as Record<string, unknown>;
    const q = req.questions.find((x) => x.id === a.questionId);
    if (!q) return { error: `unknown questionId ${String(a.questionId)}` };
    if (byId.has(q.id)) return { error: `duplicate answer for ${q.id}` };
    const sel = typeof a.selectedOptionId === 'string' ? a.selectedOptionId : undefined;
    const ft = typeof a.freeText === 'string' && a.freeText.trim() ? a.freeText.slice(0, 2000) : undefined;
    if (sel && !q.options.some((o) => o.id === sel)) return { error: `${q.id}: invalid option ${sel}` };
    if (ft && !q.allowFreeText) return { error: `${q.id}: free text not allowed` };
    if (!sel && !ft) return { error: `${q.id}: unanswered` };
    byId.set(q.id, { questionId: q.id, ...(sel ? { selectedOptionId: sel } : {}), ...(ft ? { freeText: ft } : {}) });
  }
  for (const q of req.questions) if (!byId.has(q.id)) return { error: `${q.id}: unanswered` };
  return { answers: req.questions.map((q) => byId.get(q.id)!) };
}

export class IdpClarificationResolver implements ClarificationResolver {
  readonly channel = 'EXTERNAL_IDP' as const;
  constructor(
    private readonly opts: { env?: Env; fetchFn?: typeof fetch; provider: ITrustedIdentityProvider; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> }
  ) {}

  async resolve(req: ClarificationRequest, onCreated?: (decisionUrl?: string) => void | Promise<void>): Promise<ClarificationOutcome> {
    const client = new IdpClient({ env: this.opts.env, fetchFn: this.opts.fetchFn });
    try {
      const res = await client.createDecisionRequest({
        decisionId: req.decisionId,
        projectId: req.projectId,
        runId: req.runId,
        taskId: SPEC_CLARIFICATION_TASK_ID,
        packageId: req.packageId,
        revision: req.revision,
        operation: SPEC_CLARIFICATION_OPERATION,
        contextFingerprint: req.contextFingerprint,
        question: req.title,
        ...(req.summary ? { summary: req.summary.slice(0, 4000) } : {}),
        questions: wireQuestions(req.questions),
        allowFreeText: true,
        nonce: req.nonce,
        requestedAt: req.requestedAt,
        expiresAt: req.expiresAt,
      });
      await onCreated?.(res.decisionUrl);
    } catch (err) {
      return { status: 'UNAVAILABLE', reason: err instanceof Error ? err.message : String(err) };
    }
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const interval = this.opts.pollIntervalMs ?? 3000;
    let errors = 0;
    while (Date.now() < Date.parse(req.expiresAt)) {
      try {
        const st = await client.getDecisionRequest(req.decisionId);
        errors = 0;
        if (st.status === 'EXPIRED') return { status: 'EXPIRED', reason: 'IdP reported the clarification request as expired.' };
        if (st.status === 'ANSWERED' && typeof st.token === 'string') {
          const out = await this.verify(req, st.token);
          if (out.status === 'ANSWERED' || /REPLAY/i.test((out as { reason: string }).reason)) return out;
        }
      } catch (err) {
        if (++errors >= 10) return { status: 'UNAVAILABLE', reason: `IdP unreachable while waiting: ${err instanceof Error ? err.message : String(err)}` };
      }
      await sleep(interval);
    }
    return { status: 'EXPIRED', reason: 'Clarification request expired without a verified answer.' };
  }

  async verify(req: ClarificationRequest, token: string): Promise<ClarificationOutcome> {
    const check = async (consumeNonce: boolean): Promise<ClarificationOutcome> => {
      const res = await verifyIdpToken(
        this.opts.provider,
        token,
        {
          projectId: req.projectId,
          packageId: req.packageId,
          revision: req.revision,
          contextFingerprint: req.contextFingerprint,
          taskId: SPEC_CLARIFICATION_TASK_ID,
          operation: SPEC_CLARIFICATION_OPERATION,
        },
        { decisionId: req.decisionId, nonce: req.nonce, runId: req.runId, taskId: SPEC_CLARIFICATION_TASK_ID, projectId: req.projectId, contextFingerprint: req.contextFingerprint },
        { consumeNonce }
      );
      if (!res.ok || !res.payload) return { status: 'FAILED', reason: `${res.status}: ${res.reason ?? 'invalid answer token'}` };
      const v = validateClarificationAnswers(req, res.payload.answers);
      if (v.error) return { status: 'FAILED', reason: v.error };
      return { status: 'ANSWERED', answers: v.answers!, answeredBy: String(res.payload.sub), answeredAt: new Date().toISOString() };
    };
    const dry = await check(false);
    return dry.status === 'ANSWERED' ? check(true) : dry;
  }
}

// ------------------------------------------------------------------ applying answers

export interface ClarificationResolution {
  /** taskId -> extra criteria; key '*' = all tasks. */
  criteria: Map<string, string[]>;
  checks: ClarificationCheck[];
  newTasks: Array<ClarificationNewTask & { fromQuestion: string }>;
  /** Binding PO statements fed to the Director on every task. */
  notes: string[];
  /** Human-readable lines for the report. */
  lines: string[];
  /** Binding design brief when the design-direction question was answered with a design option. */
  designBrief?: DesignBrief;
}

export function resolveClarification(st: Pick<ClarificationState, 'questions' | 'answers' | 'freeTextCriteria'>, answers?: ClarificationAnswerItem[]): ClarificationResolution {
  const ans: ClarificationAnswerItem[] = answers ?? st.answers ?? st.questions.map((q) => ({ questionId: q.id, selectedOptionId: q.recommendedOptionId }));
  const res: ClarificationResolution = { criteria: new Map(), checks: [], newTasks: [], notes: [], lines: [] };
  const addCrit = (targets: string[], list: string[]) => {
    for (const t of targets.length ? targets : ['*']) {
      const cur = res.criteria.get(t) ?? [];
      for (const c of list) if (!cur.includes(c)) cur.push(c);
      res.criteria.set(t, cur);
    }
  };
  for (const q of st.questions) {
    const a = ans.find((x) => x.questionId === q.id);
    if (!a) continue;
    const opt = a.selectedOptionId ? q.options.find((o) => o.id === a.selectedOptionId) : undefined;
    const isImprovementRejected = q.kind === 'IMPROVEMENT' && opt && opt.criteria.length === 0 && opt.newTasks.length === 0 && opt.checks.length === 0;
    if (opt) {
      addCrit(opt.appliesTo, opt.criteria);
      res.checks.push(...opt.checks);
      res.newTasks.push(...opt.newTasks.map((t) => ({ ...t, fromQuestion: q.id })));
    }
    const ftc = st.freeTextCriteria?.find((f) => f.questionId === q.id);
    if (ftc) {
      addCrit(ftc.appliesTo, ftc.criteria);
      res.checks.push(...ftc.checks);
    }
    if (opt?.design) {
      res.designBrief = { ...opt.design, questionId: q.id, optionId: opt.id, tokens: designTokens(opt.design), cssGlob: '**/*.css', decidedBy: answers || st.answers ? 'PO' : 'RECOMMENDED' };
      res.notes.push(`[design-brief] BINDING visual design "${opt.design.name}": ${designBriefText(res.designBrief)}`);
    }
    const chosen = opt ? opt.label : '(serbest cevap)';
    res.lines.push(`${q.kind === 'IMPROVEMENT' ? 'Öneri' : 'Soru'}: ${q.question} → ${chosen}${a.freeText ? ` — not: ${a.freeText}` : ''}`);
    res.notes.push(
      `[${q.id}] ${q.question} => ${opt ? `${opt.label}${opt.description ? ` (${opt.description})` : ''}` : 'free-text answer'}${a.freeText ? `; PO note: ${a.freeText}` : ''}${
        isImprovementRejected ? ' (improvement declined: keep the spec approach)' : ''
      }`
    );
  }
  return res;
}

// ------------------------------------------------------------------ generated check script

/** Renders a dependency-free node script evaluating the declarative checks (data only; no LLM code). */
export function renderChecksScript(checks: readonly ClarificationCheck[]): string {
  const data = JSON.stringify(checks, null, 2);
  return `// Generated by AIDM from the PO's spec clarification answers. Do not edit by hand; it is regenerated.
// Run: node ${CHECKS_SCRIPT_PATH}  (exit 0 = all checks pass)
import fs from 'node:fs';
import path from 'node:path';

const CHECKS = ${data};
const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', '.ai-manager']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}
function globRe(g) {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { r += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&');
  }
  return new RegExp('^' + r + '$');
}
let files = null;
const match = (g) => { files ??= walk(ROOT); const re = globRe(g); return files.filter((f) => re.test(f)); };
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } };
const has = (text, c) => (c.regex ? new RegExp(c.pattern).test(text) : text.includes(c.pattern));

let failed = 0;
for (const c of CHECKS) {
  let ok = false, why = '';
  if (c.type === 'file_exists') { ok = fs.existsSync(path.join(ROOT, c.path)); why = c.path + ' yok'; }
  else if (c.type === 'file_absent') { ok = !fs.existsSync(path.join(ROOT, c.path)); why = c.path + ' olmamalı'; }
  else if (c.type === 'file_contains') { const t = read(c.path); ok = t !== null && has(t, c); why = c.path + " içinde '" + c.pattern + "' yok"; }
  else if (c.type === 'glob_count') { const n = match(c.glob).length; ok = (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max); why = c.glob + ': ' + n + ' dosya'; }
  else if (c.type === 'each_file_contains') { const fs_ = match(c.glob); const bad = fs_.filter((f) => !has(read(f) ?? '', c)); ok = fs_.length > 0 && bad.length === 0; why = fs_.length ? 'eksik: ' + bad.join(', ') : c.glob + ' ile eşleşen dosya yok'; }
  else if (c.type === 'css_tokens') {
    const squash = (x) => x.split(' ').join('').split('\\n').join('').split('\\t').join('').split('\\r').join('').toLowerCase();
    const css = squash(match(c.glob).map((f) => read(f) ?? '').join(' '));
    const missing = Object.entries(c.tokens).filter(([k, v]) => !css.includes(squash('--' + k + ':' + v)));
    ok = missing.length === 0; why = 'eksik değişkenler: ' + missing.map(([k, v]) => '--' + k + ': ' + v).join('; ');
  }
  else if (c.type === 'no_file_contains') { const bad = match(c.glob).filter((f) => has(read(f) ?? '', c)); ok = bad.length === 0; why = 'içeriyor: ' + bad.join(', '); }
  console.log((ok ? 'PASS ' : 'FAIL ') + c.description + (ok ? '' : ' — ' + why));
  if (!ok) failed++;
}
if (failed) { console.error(failed + ' kontrol başarısız'); process.exit(1); }
`;
}

/** Compact brief for Director prompts and AGY instructions. */
export function designBriefText(b: DesignBrief): string {
  const vars = Object.entries(b.tokens).map(([k, v]) => `--${k}: ${v}`).join('; ');
  return [
    `Define in the shared CSS :root exactly: ${vars}.`,
    'Use colours and fonts ONLY via these variables; do not invent any other palette or font.',
    `Layout: ${b.layout}. Imagery: ${b.imagery}. Tone: ${b.tone}. Emoji: ${b.emoji || 'as fits'}.`,
    'No generic AI look (default purple/blue gradients, glassmorphism cards, stock hero templates, uniform rounded card grids).',
  ].join(' ');
}

export async function saveDesignBrief(projectRoot: string, brief: DesignBrief): Promise<void> {
  const f = path.join(projectRoot, DESIGN_BRIEF_PATH);
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  await fs.promises.writeFile(f, JSON.stringify({ schemaVersion: 1, ...brief, savedAt: new Date().toISOString() }, null, 2), 'utf8');
}

export function loadDesignBrief(projectRoot: string): DesignBrief | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, DESIGN_BRIEF_PATH), 'utf8')) as DesignBrief;
  } catch {
    return null;
  }
}
