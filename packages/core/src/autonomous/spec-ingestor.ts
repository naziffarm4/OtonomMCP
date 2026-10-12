/**
 * @file spec-ingestor.ts
 * @description SpecIngestor: converts a single Markdown project specification into
 * an InitialProjectUnderstanding + ProposedDevelopmentPlan + authoritative task list
 * for the fully autonomous `aidm run --spec` pipeline.
 *
 * INVARIANTS:
 * 1. Deterministic & offline: no LLM call. The spec text written by the human is the
 *    only source; nothing the LLM says can alter the ingested understanding.
 * 2. Statements taken verbatim from the spec are CONFIRMED_FACT / PRODUCT_OWNER_STATEMENT.
 *    Anything the ingestor fills in itself is recorded as an explicit ASSUMPTION
 *    (no-questions mode: proceed with logged assumptions instead of asking).
 * 3. The spec content is bound by SHA-256 fingerprint so later authorization
 *    (mandate sealing / approval) refers to exactly this spec revision.
 */

import { parseClarificationSetting } from './spec-clarification.js';
import * as crypto from 'node:crypto';
import type {
  InitialProjectUnderstanding,
  ProposedDevelopmentPlan,
  UnderstandingItem,
} from '../approval/approval-types.js';
import {
  InitialProjectUnderstandingZodSchema,
  ProposedDevelopmentPlanZodSchema,
} from '../approval/approval-types.js';
import type { EvidenceReference } from '../discovery/discovery-types.js';
import {
  type TaskDefinition,
  TaskStatus,
  TaskPriority,
} from '../task-engine/task-types.js';
import { RiskLevel } from '../risk.js';

// ============================================================================
// 1. TYPES
// ============================================================================

export interface SpecRequirement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly targetFiles: readonly string[];
  /** Per-requirement override: a line `Deneme: N` / `Max attempts: N` (1..10) inside the requirement. */
  readonly maxAttempts?: number;
}

/** `Deneme: 5`, `Deneme sayısı: 5`, `Maksimum deneme: 5`, `Max attempts: 5` (1..10). */
const ATTEMPTS_RE = /^(?:deneme(?:\s*say[ıi]s[ıi])?|maksimum\s*deneme|max(?:imum)?\s*attempts)\s*[:=]\s*(\d{1,2})\s*\.?$/i;
export const DEFAULT_MAX_ATTEMPTS_PER_TASK = 3;

function extractAttempts(items: string[]): number | undefined {
  let found: number | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = ATTEMPTS_RE.exec(items[i].trim());
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 10) found = n;
      items.splice(i, 1);
    }
  }
  return found;
}

/**
 * Run-wide analysis policy (`İnceleme: her görev | gerektiğinde | hiç`), anywhere in the spec.
 * - EVERY_TASK: the Director may request a read-only AGY analysis before any task.
 * - ON_DEMAND (default): only for the first task of a run segment and after a failed attempt.
 * - NEVER: never run a separate read-only analysis subtask.
 */
export type AnalysisPolicy = 'EVERY_TASK' | 'ON_DEMAND' | 'NEVER';
export const DEFAULT_ANALYSIS_POLICY: AnalysisPolicy = 'ON_DEMAND';
const ANALYSIS_RE = /^(?:i̇nceleme|inceleme|İnceleme|INCELEME|analysis\s*policy)\s*[:=]\s*(.+?)\s*\.?$/i;

const CLARIFICATION_RE = /^(?:netleştirme|netlestirme|Netleştirme|NETLEŞTİRME|spec\s*clarification)\s*[:=]\s*(.+?)\s*\.?$/i;

/** Parses an analysis-policy value; undefined when unrecognized. */
export function parseAnalysisPolicy(raw: string): AnalysisPolicy | undefined {
  const v = raw
    .toLocaleLowerCase('tr-TR')
    .replace(/[ıi̇]/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ğ/g, 'g')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/[\s_]+/g, '-')
    .trim();
  if (/^(her-gorev|her-gorevde|always|every-task|every)$/.test(v)) return 'EVERY_TASK';
  if (/^(gerektiginde|gerekirse|on-demand|auto|varsayilan|default)$/.test(v)) return 'ON_DEMAND';
  if (/^(hic|hicbir-zaman|yok|kapali|never|off|none)$/.test(v)) return 'NEVER';
  return undefined;
}

export interface SpecIngestionOptions {
  /** Canonical project identifier (normally derived from the project root). */
  readonly projectId: string;
  /** Path of the spec file (used only for evidence references). */
  readonly specPath?: string;
  /** Max attempts per generated task (default 2). */
  readonly maxAttemptsPerTask?: number;
  /** Clock override for deterministic tests. */
  readonly now?: () => Date;
}

export interface SpecIngestionResult {
  readonly projectId: string;
  readonly projectName: string;
  /** SHA-256 of the raw spec bytes (UTF-8). */
  readonly specFingerprint: string;
  readonly understanding: InitialProjectUnderstanding;
  readonly plan: ProposedDevelopmentPlan;
  readonly requirements: readonly SpecRequirement[];
  readonly tasks: readonly TaskDefinition[];
  /** Assumptions made because the spec was silent (logged, never asked). */
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
  /** Extra project-relative paths the spec explicitly allows (## Dizinler / ## Paths). */
  readonly allowedPaths: readonly string[];
  /** Commands the spec declares for verification (## Test / ## Komutlar). */
  readonly verificationCommands: readonly string[];
  /**
   * Global `## Kabul Kriterleri` items. They are NOT imposed on every task: they form the
   * run-level final acceptance gate (together with `## Komutlar`).
   */
  readonly globalAcceptanceCriteria: readonly string[];
  /** Human text of `## Karar Politikası` / `## Decision Policy` (what the Director must ask the PO about). */
  readonly decisionPolicy?: string;
  /** `Netleştirme: açık|kapalı` (default true): Director reviews the spec and asks the PO before implementing. */
  readonly clarification: boolean;
  /** `İnceleme:` line (default ON_DEMAND). */
  readonly analysisPolicy: AnalysisPolicy;
}

export class SpecIngestionError extends Error {
  readonly code: string;
  constructor(message: string, code = 'SPEC_INGESTION_FAILED') {
    super(message);
    this.name = 'SpecIngestionError';
    this.code = code;
  }
}

// ============================================================================
// 2. MARKDOWN SECTION CLASSIFICATION (Turkish + English headings)
// ============================================================================

type SectionKind =
  | 'PURPOSE'
  | 'REQUIREMENTS'
  | 'ACCEPTANCE'
  | 'TECH'
  | 'CONSTRAINTS'
  | 'NON_GOALS'
  | 'USERS'
  | 'RISKS'
  | 'PATHS'
  | 'COMMANDS'
  | 'DECISION_POLICY'
  | 'OTHER';

const SECTION_PATTERNS: ReadonlyArray<readonly [SectionKind, RegExp]> = [
  ['DECISION_POLICY', /(karar\s*politikas[ıi]|decision\s*policy)/i],
  ['NON_GOALS', /(kapsam\s*d[ıi][şs][ıi]|non[- ]?goals?|out\s*of\s*scope|hedef\s*olmayan)/i],
  ['ACCEPTANCE', /(kabul\s*kriter|acceptance|done\s*criteria|bitti\s*tan[ıi]m)/i],
  ['REQUIREMENTS', /(gereksinim|requirement|[öo]zellik|feature|g[öo]rev|tasks?\b|kapsam\b|scope)/i],
  ['TECH', /(teknoloji|tech|stack|mimari|architecture)/i],
  ['CONSTRAINTS', /(k[ıi]s[ıi]t|constraint|kural|rules?)/i],
  ['USERS', /(kullan[ıi]c[ıi]|users?|hedef\s*kitle|audience)/i],
  ['RISKS', /(risk)/i],
  ['PATHS', /(dizin|klas[öo]r|paths?|directories)/i],
  ['COMMANDS', /(komut|commands?|test\s*komut|build|do[ğg]rulama|verification)/i],
  ['PURPOSE', /(ama[çc]|purpose|overview|[öo]zet|summary|a[çc][ıi]klama|description|hedef|goal)/i],
];

function classifyHeading(heading: string): SectionKind {
  for (const [kind, re] of SECTION_PATTERNS) {
    if (re.test(heading)) return kind;
  }
  return 'OTHER';
}

interface RawSection {
  readonly heading: string;
  readonly kind: SectionKind;
  readonly lines: string[];
  readonly startLine: number;
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const CODE_PATH_RE = /`([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+)`/g;

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
}

/** Returns true when a project-relative path is safe (no escape, no absolute, no AIDM state). */
export function isSafeProjectRelativePath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  const parts = normalized.split('/');
  if (parts.some((s) => s === '..')) return false;
  const first = parts[0] === '.' ? parts[1] : parts[0];
  if (!first || first === '.git' || first === '.ai-manager') return false;
  return true;
}

function extractCodePaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CODE_PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (isSafeProjectRelativePath(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

function splitSections(markdown: string): { title: string | null; preamble: string[]; sections: RawSection[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let title: string | null = null;
  const preamble: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inFence = false;

  lines.forEach((line, idx) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h1 = !inFence ? /^#\s+(.+?)\s*#*\s*$/.exec(line) : null;
    const h2 = !inFence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h1 && title === null) {
      title = stripMarkdown(h1[1]);
      return;
    }
    if (h2) {
      current = { heading: stripMarkdown(h2[1]), kind: classifyHeading(h2[1]), lines: [], startLine: idx + 1 };
      sections.push(current);
      return;
    }
    if (current) {
      (current as RawSection).lines.push(line);
    } else {
      preamble.push(line);
    }
  });

  return { title, preamble, sections };
}

function paragraphs(lines: readonly string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const l of lines) {
    if (!l.trim() || /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || LIST_ITEM_RE.test(l)) {
      if (buf.length) out.push(stripMarkdown(buf.join(' ')));
      buf = [];
      continue;
    }
    if (/^\s*[|>]/.test(l)) continue;
    buf.push(l.trim());
  }
  if (buf.length) out.push(stripMarkdown(buf.join(' ')));
  return out.filter(Boolean);
}

function listItems(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = LIST_ITEM_RE.exec(l);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function fencedOrListCommands(lines: readonly string[]): string[] {
  const cmds: string[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence && l.trim() && !l.trim().startsWith('#')) cmds.push(l.trim());
  }
  if (cmds.length === 0) {
    for (const item of listItems(lines)) {
      const m = /`([^`]+)`/.exec(item);
      if (m) cmds.push(m[1].trim());
    }
  }
  return cmds;
}

/**
 * Parses requirements: either `### Sub-heading` blocks (title + body + nested
 * acceptance bullets) or top-level bullet items (one requirement per bullet,
 * indented sub-bullets become acceptance criteria).
 */
function parseRequirementBlocks(lines: readonly string[]): Array<{ title: string; body: string; criteria: string[]; attempts?: number }> {
  const blocks: Array<{ title: string; body: string[]; criteria: string[] }> = [];
  const hasH3 = lines.some((l) => /^###\s+/.test(l));

  if (hasH3) {
    let cur: { title: string; body: string[]; criteria: string[] } | null = null;
    for (const l of lines) {
      const h3 = /^###\s+(.+?)\s*#*\s*$/.exec(l);
      if (h3) {
        cur = { title: stripMarkdown(h3[1]).replace(/^[A-Z]+-\d+[:.)]?\s*/, ''), body: [], criteria: [] };
        blocks.push(cur);
        continue;
      }
      if (!cur) continue;
      const am = ATTEMPTS_RE.exec(stripMarkdown(l.replace(/^\s*[-*+]\s+/, '')).trim());
      if (am) {
        const n = Number(am[1]);
        if (n >= 1 && n <= 10) (cur as { attempts?: number }).attempts = n;
        continue;
      }
      const m = LIST_ITEM_RE.exec(l);
      if (m) cur.criteria.push(stripMarkdown(m[1]));
      else if (l.trim()) cur.body.push(l.trim());
    }
  } else {
    let cur: { title: string; body: string[]; criteria: string[] } | null = null;
    for (const l of lines) {
      const m = LIST_ITEM_RE.exec(l);
      if (!m) continue;
      const indent = /^(\s*)/.exec(l)?.[1].length ?? 0;
      if (indent >= 2 && cur) {
        cur.criteria.push(stripMarkdown(m[1]));
      } else {
        const text = m[1];
        const [head, ...rest] = text.split(/\s[:–—-]\s|:\s/);
        cur = { title: stripMarkdown(head), body: rest.length ? [rest.join(': ')] : [text], criteria: [] };
        blocks.push(cur);
      }
    }
  }

  return blocks.map((b) => ({
    title: b.title,
    body: b.body.join(' '),
    criteria: b.criteria,
    ...((b as { attempts?: number }).attempts ? { attempts: (b as { attempts?: number }).attempts } : {}),
  }));
}

// ============================================================================
// 3. INGESTOR
// ============================================================================

export class SpecIngestor {
  /**
   * Ingests a Markdown spec. Throws SpecIngestionError when the spec has no usable
   * content at all (nothing to build); otherwise proceeds with logged assumptions.
   */
  ingest(markdown: string, options: SpecIngestionOptions): SpecIngestionResult {
    if (typeof markdown !== 'string' || markdown.trim().length === 0) {
      throw new SpecIngestionError('Spec file is empty.', 'SPEC_EMPTY');
    }
    if (!options?.projectId || options.projectId.trim().length === 0) {
      throw new SpecIngestionError('projectId is required for spec ingestion.', 'SPEC_PROJECT_ID_REQUIRED');
    }

    const now = (options.now ?? (() => new Date()))();
    const generatedAt = now.toISOString();
    const specFingerprint = crypto.createHash('sha256').update(markdown, 'utf8').digest('hex');
    const specRef = options.specPath ?? 'spec.md';
    const evidence: EvidenceReference = {
      sourceType: 'FILE',
      sourceIdentifier: specRef,
      path: specRef,
      hash: specFingerprint,
      isSystemVerified: false,
    };

    const assumptions: string[] = [];
    const warnings: string[] = [];
    // Run-wide `İnceleme:` line: consumed here so it never becomes a criterion or requirement.
    let analysisPolicy: AnalysisPolicy = DEFAULT_ANALYSIS_POLICY;
    let clarification = true;
    const keptLines: string[] = [];
    for (const l of markdown.replace(/\r\n?/g, '\n').split('\n')) {
      const cm = CLARIFICATION_RE.exec(stripMarkdown(l.replace(/^\s*[-*+]\s+/, '')).trim());
      if (cm) {
        const c = parseClarificationSetting(cm[1]);
        if (c !== undefined) {
          clarification = c;
          continue;
        }
        warnings.push(`Unrecognized clarification setting '${cm[1]}' (use: açık | kapalı); line kept as text, default (açık) used.`);
      }
      const m = ANALYSIS_RE.exec(stripMarkdown(l.replace(/^\s*[-*+]\s+/, '')).trim());
      if (m) {
        const p = parseAnalysisPolicy(m[1]);
        if (p) {
          analysisPolicy = p;
          continue;
        }
        warnings.push(`Unrecognized analysis policy '${m[1]}' (use: her görev | gerektiğinde | hiç); line kept as text, default used.`);
      }
      keptLines.push(l);
    }
    const { title, preamble, sections } = splitSections(keptLines.join('\n'));

    const projectName = title ?? options.projectId;
    if (!title) assumptions.push(`Spec has no H1 title; project name assumed to be '${options.projectId}'.`);

    const byKind = (k: SectionKind) => sections.filter((s) => s.kind === k);
    const linesOf = (k: SectionKind) => byKind(k).flatMap((s) => s.lines);

    // Purpose
    const purposeParas = [...paragraphs(preamble), ...paragraphs(linesOf('PURPOSE'))];
    let purpose = purposeParas[0] ?? '';
    if (!purpose) {
      purpose = `Build '${projectName}' as described in the specification.`;
      assumptions.push('Spec has no purpose/overview paragraph; purpose derived from the title.');
    }

    // Requirements
    let reqBlocks = parseRequirementBlocks(linesOf('REQUIREMENTS'));
    if (reqBlocks.length === 0) {
      // Fall back to OTHER sections' bullets, then to the purpose itself.
      reqBlocks = parseRequirementBlocks(linesOf('OTHER'));
      if (reqBlocks.length > 0) {
        assumptions.push('No explicit requirements section; bullet items from other sections treated as requirements.');
      }
    }
    if (reqBlocks.length === 0) {
      reqBlocks = [{ title: projectName, body: purpose, criteria: [] }];
      assumptions.push('No requirement list found; the whole spec is treated as a single requirement.');
    }

    const globalCriteria = listItems(linesOf('ACCEPTANCE')).map(stripMarkdown);
    const verificationCommands = fencedOrListCommands(linesOf('COMMANDS'));
    const allowedPaths = listItems(linesOf('PATHS'))
      .flatMap((i) => {
        const fromCode = [...i.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        return fromCode.length ? fromCode : [i.split(/\s/)[0]];
      })
      .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
      .filter((p) => {
        const ok = isSafeProjectRelativePath(p);
        if (!ok) warnings.push(`Ignored unsafe path in spec: '${p}' (outside project root or AIDM state).`);
        return ok;
      });

    const requirements: SpecRequirement[] = reqBlocks.map((b, i) => {
      const id = `REQ-${String(i + 1).padStart(3, '0')}`;
      // Global criteria belong to the final run-level gate, not to each task.
      const criteria = [...b.criteria];
      const attempts = (b as { attempts?: number }).attempts ?? extractAttempts(criteria);
      if (criteria.length === 0) {
        assumptions.push(`${id} has no acceptance criteria; assumed "implementation exists and project checks pass".`);
        criteria.push('Implementation exists and project verification checks pass');
      }
      const targetFiles = extractCodePaths(`${b.title} ${b.body} ${criteria.join(' ')}`);
      return {
        id,
        title: b.title.slice(0, 200) || id,
        description: (b.body || b.title).slice(0, 2000),
        acceptanceCriteria: criteria,
        targetFiles,
        ...(attempts ? { maxAttempts: attempts } : {}),
      };
    });

    const techItems = [...listItems(linesOf('TECH')), ...paragraphs(linesOf('TECH'))].map(stripMarkdown);
    if (techItems.length === 0) {
      assumptions.push('No technology stack specified; Director will choose a conventional stack consistent with existing files.');
    }
    const constraints = listItems(linesOf('CONSTRAINTS')).map(stripMarkdown);
    const nonGoals = listItems(linesOf('NON_GOALS')).map(stripMarkdown);
    const users = listItems(linesOf('USERS')).map(stripMarkdown);
    const risks = listItems(linesOf('RISKS')).map(stripMarkdown);

    // Understanding items
    const confirmedRequirements: UnderstandingItem[] = requirements.map((r) => ({
      id: r.id,
      type: 'CONFIRMED_FACT',
      origin: 'PRODUCT_OWNER_STATEMENT',
      statement: `${r.title}: ${r.description}`,
      evidence: [evidence],
      sourceReferenceId: specFingerprint,
    }));
    const assumptionItems: UnderstandingItem[] = assumptions.map((a, i) => ({
      id: `ASM-${String(i + 1).padStart(3, '0')}`,
      type: 'ASSUMPTION',
      origin: 'PRODUCT_OWNER_STATEMENT',
      statement: a,
      rationale: 'Autonomous no-questions mode: proceed with a reasonable, logged assumption instead of asking.',
      evidence: [evidence],
    }));

    const understanding: InitialProjectUnderstanding = {
      projectId: options.projectId,
      projectName,
      apparentPurpose: {
        classification: 'UNDERSTOOD',
        summary: purpose,
        rawDescription: purposeParas.join('\n\n') || purpose,
        domainKeywords: [],
        evidence: [evidence],
      },
      targetUsers: users,
      technologyStack: {
        primaryLanguages: techItems,
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        runtimes: [],
        containerization: [],
        ciCd: [],
        workspaceType: 'standalone',
        dependencies: [],
        devDependencies: [],
        evidence: [evidence],
      },
      architectureSummary: {
        identifiedAreas: [],
        architecturalPattern: 'SPEC_DEFINED',
        summary: techItems.join('; ') || 'Defined by Director during implementation',
        evidence: [evidence],
      },
      existingCapabilities: [],
      confirmedRequirements,
      clarifiedRequirements: [],
      unresolvedUnknowns: [],
      unresolvedContradictions: [],
      currentImplementationState: {
        lifecycleState: 'SPEC_INGESTED',
        hasActiveTask: false,
        isBlocked: false,
        totalTasksInDag: requirements.length,
        completedTasksCount: 0,
        evidence: [evidence],
      },
      constraints,
      assumptions: assumptionItems,
      nonGoals,
      proposedDevelopmentScope: requirements.map((r) => `${r.id}: ${r.title}`),
      evidenceReferences: [evidence],
      sourceDiscoveryReference: `spec-sha256:${specFingerprint}`,
      generatedAt,
    };

    const plan: ProposedDevelopmentPlan = {
      objectives: [purpose],
      proposedScope: requirements.map((r) => `${r.id}: ${r.title}`),
      proposedFeatureGroups: [
        {
          name: projectName,
          description: purpose,
          targetCapabilities: requirements.map((r) => r.title),
        },
      ],
      dependencies: [],
      constraints,
      knownRisks: risks,
      unresolvedIssues: [],
      excludedScope: nonGoals,
      suggestedImplementationOrder: requirements.map((r) => `TASK-${r.id.slice(4)}`),
    };

    const u = InitialProjectUnderstandingZodSchema.safeParse(understanding);
    if (!u.success) {
      throw new SpecIngestionError(`Generated understanding is invalid: ${u.error.issues[0]?.message}`, 'SPEC_UNDERSTANDING_INVALID');
    }
    const p = ProposedDevelopmentPlanZodSchema.safeParse(plan);
    if (!p.success) {
      throw new SpecIngestionError(`Generated plan is invalid: ${p.error.issues[0]?.message}`, 'SPEC_PLAN_INVALID');
    }

    const maxAttempts = options.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS_PER_TASK;
    const featureId = 'FEAT-SPEC';
    const feature: TaskDefinition = {
      task_id: featureId,
      parent_feature_id: 'ROOT',
      title: projectName,
      description: purpose,
      traceability_sources: requirements.map((r) => `SYSTEM_REQUIREMENT: ${r.id}`),
      dependencies: [],
      acceptance_criteria: requirements.map((r) => `${r.id} accepted`),
      hierarchy_level: 'FEATURE',
      status: TaskStatus.IN_PROGRESS,
      attempt: 0,
      max_attempts: maxAttempts,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.SAFE,
      created_at: generatedAt,
      started_at: null,
      completed_at: null,
      metadata: { specFingerprint },
    } as TaskDefinition;

    const tasks: TaskDefinition[] = requirements.map((r) => ({
      task_id: `TASK-${r.id.slice(4)}`,
      parent_feature_id: featureId,
      title: r.title,
      description: r.description,
      traceability_sources: [`SYSTEM_REQUIREMENT: ${r.id}`, `PARENT_FEATURE: ${featureId}`],
      dependencies: [],
      acceptance_criteria: [...r.acceptanceCriteria],
      hierarchy_level: 'TASK',
      status: TaskStatus.READY,
      attempt: 0,
      max_attempts: r.maxAttempts ?? maxAttempts,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.CAUTION,
      created_at: generatedAt,
      started_at: null,
      completed_at: null,
      metadata: {
        // Task class is assigned by the deterministic ingestor from the human-written
        // spec, never by LLM output. Only IMPLEMENTATION is auto-executable.
        taskClass: 'IMPLEMENTATION',
        ...(r.maxAttempts ? { maxAttemptsFromSpec: r.maxAttempts } : {}),
        revision: 1,
        targetFiles: [...r.targetFiles],
        requirementId: r.id,
        specFingerprint,
      },
    } as TaskDefinition));

    return Object.freeze({
      projectId: options.projectId,
      projectName,
      specFingerprint,
      understanding,
      plan,
      requirements,
      tasks: [feature, ...tasks],
      assumptions,
      warnings,
      allowedPaths,
      globalAcceptanceCriteria: globalCriteria,
      ...(byKind('DECISION_POLICY').length
        ? {
            decisionPolicy: byKind('DECISION_POLICY')
              .map((sec) => sec.lines.join('\n').trim())
              .filter(Boolean)
              .join('\n')
              .slice(0, 2000),
          }
        : {}),
      verificationCommands,
      analysisPolicy,
      clarification,
    });
  }
}
