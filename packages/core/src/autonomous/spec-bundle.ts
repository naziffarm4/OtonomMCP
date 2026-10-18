/**
 * @file spec-bundle.ts
 * @description Loads a project specification that may consist of several Markdown documents.
 *
 * Supported inputs (all read-only):
 *  1. A single `.md` file (classic mode). Its content is used byte-for-byte, so the spec
 *     fingerprint of existing single-file specs does not change.
 *  2. A single `.md` file with include lines, e.g.
 *       `Ek spec: 02-randevu.md, 03-kasa.md, moduller/`
 *       `Spec parçaları: docs/specs/`
 *       `Include: billing.md`
 *     Each entry is a file or a folder (all `.md` files inside, natural order), relative to the
 *     main spec's folder. The include lines themselves are removed from the combined text.
 *  3. A folder: every `.md` file inside (recursive, natural order, e.g. 01-..., 02-..., 10-...).
 *
 * INVARIANTS:
 *  - Fail closed: a missing include, an include escaping the spec folder, or too many / too large
 *    files throws SpecBundleError (silently dropping part of the spec is never acceptable).
 *  - Deterministic: identical files produce an identical combined Markdown (stable fingerprint).
 *  - Every source file keeps its own SHA-256 so the runner can detect and restore edits to ANY
 *    part of the human spec.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_SPEC_FILES = 64;
export const MAX_SPEC_TOTAL_BYTES = 2_000_000;

export interface SpecSourceFile {
  /** Absolute path of the source document. */
  readonly absPath: string;
  /** Path relative to the bundle root (the main spec's folder, or the spec folder). */
  readonly relPath: string;
  /** Raw UTF-8 content as read from disk. */
  readonly content: string;
  /** SHA-256 of the raw content. */
  readonly sha256: string;
}

export interface SpecBundle {
  /** The path the caller passed (file or folder), resolved. */
  readonly specPath: string;
  /** Folder that include entries and relPaths are relative to. */
  readonly rootDir: string;
  readonly isDirectory: boolean;
  /** Source documents in combination order (main spec first in file mode). */
  readonly files: readonly SpecSourceFile[];
  /** Combined Markdown fed to the ingestor / Director. Equals the raw file for a plain single spec. */
  readonly markdown: string;
}

export class SpecBundleError extends Error {
  readonly code: string;
  constructor(message: string, code = 'SPEC_BUNDLE_INVALID') {
    super(message);
    this.name = 'SpecBundleError';
    this.code = code;
  }
}

const INCLUDE_RE =
  /^\s*(?:[-*+]\s+)?(?:ek\s*spec(?:\s*dosyalar[ıi])?|spec\s*par[çc]alar[ıi]|spec\s*dosyalar[ıi]|spec\s*includes?|includes?)\s*[:=]\s*(.+?)\s*$/i;

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** Parses include lines (outside code fences); returns the entries and the text without them. */
export function extractSpecIncludes(markdown: string): { entries: string[]; text: string } {
  const entries: string[] = [];
  const kept: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : INCLUDE_RE.exec(line.replace(/\*\*|__/g, ''));
    if (m) {
      for (const raw of m[1].split(/[,;]/)) {
        const e = raw.trim().replace(/^`|`$/g, '').replace(/^\[(.+?)\]\((.+?)\)$/, '$2').trim();
        if (e) entries.push(e);
      }
      continue;
    }
    kept.push(line);
  }
  // Keep the original line-ending style when nothing was removed (fingerprint stability).
  return { entries, text: entries.length ? kept.join('\n') : markdown };
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => naturalCompare(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isMd(e.name)) out.push(p);
    }
  };
  walk(dir);
  // Natural order over the relative path keeps "01-x/..." before "02-y/..." and "2.md" before "10.md".
  return out.sort((a, b) => naturalCompare(path.relative(dir, a), path.relative(dir, b)));
}

function insideRoot(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Makes a later document a well-formed part of the combined spec: its H1 becomes an H2 (so the
 * ingestor treats the document as a module section instead of glueing its intro to the previous
 * file's last section). A document without an H1 but with intro text gets an H2 named after the file.
 */
export function normalizeAppendedDocument(content: string, relPath: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let firstH1 = -1;
  let firstH2 = -1;
  let introHasText = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (inFence) {
      if (firstH2 < 0) introHasText = true;
      continue;
    }
    if (firstH1 < 0 && firstH2 < 0 && /^#\s+\S/.test(l)) {
      firstH1 = i;
      continue;
    }
    if (/^##\s+\S/.test(l)) {
      firstH2 = i;
      break;
    }
    if (l.trim()) introHasText = true;
  }
  if (firstH1 >= 0) {
    lines[firstH1] = lines[firstH1].replace(/^#\s+/, '## ');
    return lines.join('\n');
  }
  if (introHasText) {
    const name = path.basename(relPath).replace(/\.(md|markdown)$/i, '').replace(/^[0-9]+[-_. ]*/, '').replace(/[-_]+/g, ' ').trim();
    return [`## ${name || relPath}`, '', ...lines].join('\n');
  }
  return lines.join('\n');
}

function readSource(rootDir: string, absPath: string): SpecSourceFile {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new SpecBundleError(`Cannot read spec file '${absPath}': ${err instanceof Error ? err.message : String(err)}`, 'SPEC_UNREADABLE');
  }
  return { absPath, relPath: path.relative(rootDir, absPath).replace(/\\/g, '/'), content, sha256: sha256(content) };
}

/** Loads the spec (file, file + includes, or folder). Throws SpecBundleError on any problem. */
export function loadSpecBundleSync(specPathInput: string): SpecBundle {
  const specPath = path.resolve(specPathInput);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(specPath);
  } catch {
    throw new SpecBundleError(`Cannot read spec '${specPath}': not found.`, 'SPEC_UNREADABLE');
  }

  const files: SpecSourceFile[] = [];
  let rootDir: string;
  let mainText: string | null = null;

  if (stat.isDirectory()) {
    rootDir = specPath;
    const mdFiles = listMarkdownFiles(specPath);
    if (mdFiles.length === 0) throw new SpecBundleError(`Spec folder '${specPath}' contains no .md files.`, 'SPEC_EMPTY');
    for (const f of mdFiles) files.push(readSource(rootDir, f));
  } else {
    rootDir = path.dirname(specPath);
    const main = readSource(rootDir, specPath);
    files.push(main);
    const { entries, text } = extractSpecIncludes(main.content);
    mainText = text;
    const seen = new Set([path.normalize(specPath).toLowerCase()]);
    for (const entry of entries) {
      const abs = path.resolve(rootDir, entry);
      if (!insideRoot(rootDir, abs)) {
        throw new SpecBundleError(`Spec include '${entry}' is outside the spec folder '${rootDir}'.`, 'SPEC_INCLUDE_OUTSIDE');
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        throw new SpecBundleError(`Spec include '${entry}' was not found (relative to '${rootDir}').`, 'SPEC_INCLUDE_MISSING');
      }
      const targets = st.isDirectory() ? listMarkdownFiles(abs) : [abs];
      if (st.isFile() && !isMd(abs)) throw new SpecBundleError(`Spec include '${entry}' is not a .md file.`, 'SPEC_INCLUDE_INVALID');
      for (const t of targets) {
        const key = path.normalize(t).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(readSource(rootDir, t));
      }
    }
  }

  if (files.length > MAX_SPEC_FILES) {
    throw new SpecBundleError(`Spec consists of ${files.length} files; the limit is ${MAX_SPEC_FILES}.`, 'SPEC_TOO_MANY_FILES');
  }
  const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0);
  if (totalBytes > MAX_SPEC_TOTAL_BYTES) {
    throw new SpecBundleError(`Spec is ${totalBytes} bytes; the limit is ${MAX_SPEC_TOTAL_BYTES}.`, 'SPEC_TOO_LARGE');
  }

  // Plain single file: byte-for-byte (keeps existing fingerprints, approvals and resumes valid).
  if (files.length === 1 && mainText !== null && mainText === files[0].content) {
    return { specPath, rootDir, isDirectory: false, files, markdown: files[0].content };
  }

  const parts: string[] = [];
  files.forEach((f, i) => {
    if (i === 0) parts.push(mainText ?? f.content);
    else parts.push(normalizeAppendedDocument(f.content, f.relPath));
  });
  const markdown = parts.map((p) => p.replace(/\s+$/, '')).join('\n\n') + '\n';
  return { specPath, rootDir, isDirectory: stat.isDirectory(), files, markdown };
}

export async function loadSpecBundle(specPath: string): Promise<SpecBundle> {
  return loadSpecBundleSync(specPath);
}

/**
 * Default project root when none is given: a spec FILE → its folder (unchanged behaviour);
 * a spec FOLDER → the nearest ancestor (itself included) containing .git, .ai-manager or
 * package.json, else the folder itself.
 */
export function defaultProjectRootForSpec(specPathInput: string): string {
  const specPath = path.resolve(specPathInput);
  let isDir = false;
  try {
    isDir = fs.statSync(specPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return path.dirname(specPath);
  let dir = specPath;
  for (;;) {
    if (['.git', '.ai-manager', 'package.json'].some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return specPath;
    dir = parent;
  }
}

/** True when the path is a .md file or an existing directory (accepted spec inputs). */
export function isAcceptableSpecPath(specPathInput: string): boolean {
  const p = path.resolve(specPathInput);
  try {
    if (fs.statSync(p).isDirectory()) return true;
  } catch {
    /* not existing: fall through to the extension check */
  }
  return /\.md$/i.test(p);
}

/** Source files whose current content no longer matches what the run ingested. */
export function findModifiedSpecFiles(bundle: SpecBundle): SpecSourceFile[] {
  const out: SpecSourceFile[] = [];
  for (const f of bundle.files) {
    let now: string | null;
    try {
      now = fs.readFileSync(f.absPath, 'utf8');
    } catch {
      now = null;
    }
    if (now === null || sha256(now) !== f.sha256) out.push(f);
  }
  return out;
}
