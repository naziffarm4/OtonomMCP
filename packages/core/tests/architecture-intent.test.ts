/**
 * Unit tests: Director Anti-Simplification Directive and Architecture Intent Report (MOD-03)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractTechStackSchema,
  SpecIngestor,
  ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE,
  generateArchitectureIntentReport,
  saveArchitectureIntentReport,
  readArchitectureIntentReport,
  ARCHITECTURE_INTENT_FILE,
} from '../dist/autonomous/index.js';

describe('Director Anti-Simplification & Architecture Intent (MOD-03)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-intent-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('contains the mandatory anti-simplification rules in ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE', () => {
    assert.ok(ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE.includes('[DIRECTIVE: ZERO_UNILATERAL_SIMPLIFICATION]'));
    assert.ok(ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE.includes('strictly forbidden from'));
    assert.ok(ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE.includes('Downgrading multi-platform or workspace requirements'));
    assert.ok(ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE.includes('Postponing or dropping declared architectural layers'));
    assert.ok(ZERO_UNILATERAL_SIMPLIFICATION_DIRECTIVE.includes('consult Antigravity / User'));
  });

  it('generates an ArchitectureIntentReport from techStack and spec metadata', () => {
    const spec = `
# Kuaför Otomasyonu
## Mimari
- Web Portalı: Next.js 14
- Mobil: Flutter
- API: NestJS
`;
    const tech = extractTechStackSchema(spec, 'kuafor');
    const report = generateArchitectureIntentReport({
      projectId: 'proj-kuafor',
      projectName: 'kuafor',
      specFingerprint: 'abcd1234ef',
      techStack: tech,
    });

    assert.equal(report.projectId, 'proj-kuafor');
    assert.equal(report.projectName, 'kuafor');
    assert.equal(report.specFingerprint, 'abcd1234ef');
    assert.equal(report.isMonorepo, true);
    assert.equal(report.workspaceType, 'monorepo');
    assert.ok(report.targets.length >= 3);
    assert.ok(report.packageHierarchy.some((p) => p.path === 'apps/web'));
    assert.ok(report.packageHierarchy.some((p) => p.path === 'apps/mobile'));
    assert.ok(report.packageHierarchy.some((p) => p.path === 'apps/api'));
    assert.ok(report.antiSimplificationDirective.includes('ZERO_UNILATERAL_SIMPLIFICATION'));
  });

  it('saves and reads architecture-intent.json persistently', () => {
    const spec = `# Single Web App\nBuilt with Next.js.`;
    const tech = extractTechStackSchema(spec, 'web-app');
    const report = generateArchitectureIntentReport({
      projectId: 'proj-web',
      projectName: 'web-app',
      specFingerprint: '11223344',
      techStack: tech,
    });

    saveArchitectureIntentReport(tmpDir, report);
    const expectedPath = path.join(tmpDir, ARCHITECTURE_INTENT_FILE);
    assert.ok(fs.existsSync(expectedPath), `Report file must exist at ${expectedPath}`);

    const loaded = readArchitectureIntentReport(tmpDir);
    assert.ok(loaded);
    assert.equal(loaded?.projectId, 'proj-web');
    assert.equal(loaded?.specFingerprint, '11223344');
    assert.equal(loaded?.isMonorepo, false);
    assert.equal(loaded?.workspaceType, 'standalone');
  });

  it('exposes techStack on SpecIngestionResult', () => {
    const ingestor = new SpecIngestor();
    const result = ingestor.ingest('# Todo\nA todo app.\n## Requirements\n- Task 1\n', { projectId: 'todo' });
    assert.ok(result.techStack, 'techStack must be exposed on SpecIngestionResult');
    assert.equal(result.techStack.projectName.toLowerCase(), 'todo');
  });
});
