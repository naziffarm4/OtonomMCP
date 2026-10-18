/**
 * Multi-document spec input (spec-bundle) + task-scoped spec delivery (spec-context).
 * - A plain single-file spec is byte-identical (fingerprints / approvals unchanged).
 * - "Ek spec:" include lines and spec folders are merged in order; bad includes fail closed.
 * - Small specs are sent to the Director verbatim; large specs get a global frame + the FULL
 *   governing sections per task (never cut mid-section).
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadSpecBundleSync,
  extractSpecIncludes,
  findModifiedSpecFiles,
  defaultProjectRootForSpec,
  SpecBundleError,
} from '../dist/autonomous/spec-bundle.js';
import { SpecContext, resolveSpecInlineChars } from '../dist/autonomous/spec-context.js';

const YILDIZ = path.resolve(process.cwd(), '..', '..', 'YILDIZ-BAYAN-KUAFORU-Proje-Gereksinimleri.md');

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-spec-bundle-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('spec-bundle', () => {
  it('plain single file is returned byte-for-byte', () => {
    const content = '# Proje\n\n## Amaç\nBir şey yap.\n\n## Görevler\n- [ ] A\n';
    const p = write('single/spec.md', content);
    const b = loadSpecBundleSync(p);
    assert.equal(b.markdown, content);
    assert.equal(b.files.length, 1);
    assert.equal(b.isDirectory, false);
  });

  it('include line merges documents in order and is stripped from the text', () => {
    write('inc/modules/randevu.md', '# Randevu\nRandevu kuralları burada.\n');
    write('inc/modules/kasa.md', '# Kasa\nKasa kuralları.\n');
    write('inc/teknik.md', 'Teknik notlar (başlıksız).\n');
    const main = write('inc/spec.md', '# Ana Spec\n\nEk spec: teknik.md, modules/\n\n## Amaç\nX.\n');
    const b = loadSpecBundleSync(main);
    assert.equal(b.files.length, 4);
    assert.ok(!/Ek spec:/i.test(b.markdown));
    const iTek = b.markdown.indexOf('Teknik notlar');
    const iKasa = b.markdown.indexOf('## Kasa');
    const iRan = b.markdown.indexOf('## Randevu');
    assert.ok(iTek > 0 && iKasa > iTek && iRan > iKasa, 'order: include order, folder in natural order');
    assert.ok(/^## teknik/im.test(b.markdown), 'headless document gets an H2 from its filename');
    assert.deepEqual(extractSpecIncludes('Include: a.md; b/\ntext').entries, ['a.md', 'b/']);
  });

  it('folder spec loads every .md in natural order', () => {
    write('folder/specs/10-son.md', '# Son\nz\n');
    write('folder/specs/2-orta.md', '# Orta\ny\n');
    write('folder/specs/1-giris.md', '# Giriş\nx\n');
    const b = loadSpecBundleSync(path.join(tmp, 'folder/specs'));
    assert.deepEqual(b.files.map((f) => f.relPath), ['1-giris.md', '2-orta.md', '10-son.md']);
    assert.equal(b.isDirectory, true);
  });

  it('missing / outside includes fail closed', () => {
    const m1 = write('bad/a.md', '# A\nEk spec: yok.md\n');
    assert.throws(() => loadSpecBundleSync(m1), (e: unknown) => e instanceof SpecBundleError && e.code === 'SPEC_INCLUDE_MISSING');
    const m2 = write('bad/b.md', '# B\nEk spec: ../../etc.md\n');
    assert.throws(() => loadSpecBundleSync(m2), (e: unknown) => e instanceof SpecBundleError && e.code === 'SPEC_INCLUDE_OUTSIDE');
  });

  it('detects modified spec documents', () => {
    const inc = write('mod/part.md', '# Part\np\n');
    const main = write('mod/spec.md', '# Main\nEk spec: part.md\n');
    const b = loadSpecBundleSync(main);
    assert.equal(findModifiedSpecFiles(b).length, 0);
    fs.writeFileSync(inc, '# Part\nchanged\n', 'utf8');
    assert.deepEqual(findModifiedSpecFiles(b).map((f) => f.relPath), ['part.md']);
  });

  it('default project root: file → its folder; folder → nearest project ancestor', () => {
    write('proj/package.json', '{}');
    write('proj/docs/spec/a.md', '# A\n');
    assert.equal(defaultProjectRootForSpec(path.join(tmp, 'proj/docs/spec')), path.join(tmp, 'proj'));
    assert.equal(defaultProjectRootForSpec(path.join(tmp, 'proj/docs/spec/a.md')), path.join(tmp, 'proj/docs/spec'));
  });
});

describe('spec-context', () => {
  it('inline mode sends the complete spec and no task block', () => {
    const md = '# P\n\n## Amaç\nA.\n\n## Randevu\nKural 1.\n';
    const c = new SpecContext(md);
    assert.equal(c.isInline, true);
    assert.ok(c.globalContext().includes(md));
    assert.equal(c.taskContext({ taskId: 'T1', title: 'Randevu' }), '');
  });

  it('task-scoped mode on the YILDIZ spec includes the governing sections verbatim', { skip: !fs.existsSync(YILDIZ) }, () => {
    const md = fs.readFileSync(YILDIZ, 'utf8');
    const c = new SpecContext(md, { inlineChars: 2000 });
    assert.equal(c.isInline, false);
    const g = c.globalContext();
    assert.ok(g.includes('SPEC TABLE OF CONTENTS'));
    const t = c.taskContext({ taskId: 'REQ-RANDEVU', title: 'Randevu Sistemi', description: 'Randevu oluşturma ve takvim' });
    assert.ok(/Randevu Sistemi/.test(t), 'module section present');
    assert.ok(/Ek Kararlar ve Detaylar › Randevu/.test(t), 'related decision subsection present');
  });

  it('resolveSpecInlineChars honours env; invalid / out-of-range falls back to the default', () => {
    assert.equal(resolveSpecInlineChars({}), 30_000);
    assert.equal(resolveSpecInlineChars({ AIDM_SPEC_INLINE_CHARS: '50000' }), 50_000);
    assert.equal(resolveSpecInlineChars({ AIDM_SPEC_INLINE_CHARS: '10' }), 30_000);
  });
});
