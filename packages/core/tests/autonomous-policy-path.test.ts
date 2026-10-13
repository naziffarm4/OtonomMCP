/** TASK-003 policy block fixes: URL-like spec paths, glob targets, P21 denied path parsing, PO-approved mandate extensions. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { looksLikeUrl, policyDeniedPath, loadMandateExtensions, SpecIngestor } from '../dist/autonomous/index.js';

describe('policy path fixes', () => {
  it('looksLikeUrl catches example URLs but not project files', () => {
    for (const u of ['site.com/projeler.html', 'https://x.org/a', 'www.example.dev/index.html']) assert.equal(looksLikeUrl(u), true, u);
    for (const f of ['projeler.html', 'src/a.js', 'assets/site.css', 'hakkimda.html', 'docs/readme.md']) assert.equal(looksLikeUrl(f), false, f);
  });
  it('spec ingestion does not turn an example URL into a target file', () => {
    const ing = new SpecIngestor().ingest('# S\n\nx\n\nNetleştirme: kapalı\n\n## Gereksinimler\n\n### Projeler\n`projeler.html` sayfası, adresi `site.com/projeler.html` olur.\n', { projectId: 'p' });
    const all = ing.requirements.flatMap((r: { targetFiles: readonly string[] }) => [...r.targetFiles]);
    assert.ok(all.includes('projeler.html'), JSON.stringify(all));
    assert.ok(!all.includes('site.com/projeler.html'), JSON.stringify(all));
  });
  it('policyDeniedPath parses only P21 directory denials', () => {
    assert.equal(policyDeniedPath("Target file '*.html' is outside allowed directories: [src]."), '*.html');
    assert.equal(policyDeniedPath('Budget exceeded'), null);
    assert.equal(policyDeniedPath(undefined), null);
  });
  it('mandate extensions are per spec fingerprint and drop globs/unsafe paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-ext-'));
    try {
      fs.mkdirSync(path.join(dir, '.ai-manager', 'state'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.ai-manager', 'state', 'mandate-extensions.json'),
        JSON.stringify([
          { specFingerprint: 'A', path: 'iletisim.html' },
          { specFingerprint: 'A', path: '*.html' },
          { specFingerprint: 'A', path: '../x' },
          { specFingerprint: 'B', path: 'b.html' },
        ])
      );
      assert.deepEqual(loadMandateExtensions(dir, 'A'), ['iletisim.html']);
      assert.deepEqual(loadMandateExtensions(dir, 'C'), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
