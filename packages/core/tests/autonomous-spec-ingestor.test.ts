/**
 * Unit tests: SpecIngestor (Markdown spec -> InitialProjectUnderstanding + ProposedDevelopmentPlan + tasks)
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  SpecIngestor,
  SpecIngestionError,
  isSafeProjectRelativePath,
} from '../dist/autonomous/index.js';
import {
  InitialProjectUnderstandingZodSchema,
  ProposedDevelopmentPlanZodSchema,
  ApprovalPackageEngine,
} from '../dist/approval/index.js';
import { TaskDagEngine } from '../dist/task-engine/index.js';

const SPEC = `# Hesap Makinesi CLI

Basit bir komut satırı hesap makinesi.

## Hedef Kullanıcılar
- Geliştiriciler

## Teknoloji
- Node.js 22
- TypeScript

## Gereksinimler

### REQ-1: Toplama
\`src/add.ts\` içinde add(a, b) fonksiyonu.
- add(2, 3) === 5
- Negatif sayılar desteklenir

### Çıkarma
subtract(a, b) fonksiyonu \`src/subtract.ts\` dosyasında.

## Kabul Kriterleri
- Tüm testler geçer

## Kısıtlar
- Harici bağımlılık yok

## Kapsam Dışı
- Grafik arayüz

## Dizinler
- \`bin/\`
- \`../escape\`

## Komutlar
\`\`\`bash
npm test
\`\`\`
`;

describe('SpecIngestor', () => {
  const ingestor = new SpecIngestor();

  it('extracts title, purpose, requirements and acceptance criteria', () => {
    const r = ingestor.ingest(SPEC, { projectId: 'calc', specPath: 'spec.md' });
    assert.equal(r.projectName, 'Hesap Makinesi CLI');
    assert.equal(r.understanding.apparentPurpose.summary, 'Basit bir komut satırı hesap makinesi.');
    assert.equal(r.requirements.length, 2);
    assert.equal(r.requirements[0].title, 'Toplama');
    assert.deepEqual([...r.requirements[0].acceptanceCriteria], ['add(2, 3) === 5', 'Negatif sayılar desteklenir']);
    // Global acceptance criteria are the run-level final gate, not imposed on each task.
    assert.deepEqual([...r.requirements[1].acceptanceCriteria], ['Implementation exists and project verification checks pass']);
    assert.deepEqual([...r.globalAcceptanceCriteria], ['Tüm testler geçer']);
    assert.deepEqual([...r.requirements[0].targetFiles], ['src/add.ts']);
    assert.deepEqual([...r.requirements[1].targetFiles], ['src/subtract.ts']);
    assert.deepEqual([...r.understanding.targetUsers], ['Geliştiriciler']);
    assert.deepEqual([...r.understanding.constraints], ['Harici bağımlılık yok']);
    assert.deepEqual([...r.understanding.nonGoals], ['Grafik arayüz']);
    assert.deepEqual([...r.verificationCommands], ['npm test']);
  });

  it('produces schema-valid understanding and plan accepted by ApprovalPackageEngine', () => {
    const r = ingestor.ingest(SPEC, { projectId: 'calc' });
    assert.equal(InitialProjectUnderstandingZodSchema.safeParse(r.understanding).success, true);
    assert.equal(ProposedDevelopmentPlanZodSchema.safeParse(r.plan).success, true);
    const pkg = new ApprovalPackageEngine().buildPackage(r.understanding, r.plan);
    assert.equal(pkg.status, 'READY_FOR_APPROVAL');
  });

  it('binds the spec by SHA-256 fingerprint', () => {
    const r = ingestor.ingest(SPEC, { projectId: 'calc' });
    assert.equal(r.specFingerprint, crypto.createHash('sha256').update(SPEC, 'utf8').digest('hex'));
    assert.equal(r.understanding.sourceDiscoveryReference, `spec-sha256:${r.specFingerprint}`);
    const changed = ingestor.ingest(SPEC + '\n- extra', { projectId: 'calc' });
    assert.notEqual(changed.specFingerprint, r.specFingerprint);
  });

  it('generates a valid task DAG with deterministic IMPLEMENTATION task class (not LLM-assigned)', () => {
    const r = ingestor.ingest(SPEC, { projectId: 'calc' });
    const tasks = r.tasks.filter((t) => t.hierarchy_level === 'TASK');
    assert.deepEqual(tasks.map((t) => t.task_id), ['TASK-001', 'TASK-002']);
    for (const t of tasks) {
      assert.equal(t.metadata?.taskClass, 'IMPLEMENTATION');
      assert.equal(t.status, 'READY');
      assert.ok(t.traceability_sources.some((s) => s.startsWith('SYSTEM_REQUIREMENT')));
    }
    const dag = new TaskDagEngine().validateGraph({ tasks: tasks as never, features: ['FEAT-SPEC'] });
    assert.equal(dag.valid, true, JSON.stringify(dag.errors));
    assert.deepEqual([...r.plan.suggestedImplementationOrder], ['TASK-001', 'TASK-002']);
  });

  it('rejects unsafe paths from the spec and keeps safe ones', () => {
    const r = ingestor.ingest(SPEC, { projectId: 'calc' });
    assert.deepEqual([...r.allowedPaths], ['bin']);
    assert.ok(r.warnings.some((w) => w.includes('../escape')));
    assert.equal(isSafeProjectRelativePath('../x'), false);
    assert.equal(isSafeProjectRelativePath('/etc/passwd'), false);
    assert.equal(isSafeProjectRelativePath('C:/Windows'), false);
    assert.equal(isSafeProjectRelativePath('.ai-manager/state/project-mandate.json'), false);
    assert.equal(isSafeProjectRelativePath('.git/config'), false);
    assert.equal(isSafeProjectRelativePath('src/a.ts'), true);
  });

  it('no-questions mode: proceeds with logged assumptions on a minimal spec', () => {
    const r = ingestor.ingest('Sadece bir todo uygulaması yap.', { projectId: 'todo' });
    assert.equal(r.projectName, 'todo');
    assert.equal(r.requirements.length, 1);
    assert.ok(r.assumptions.length >= 3);
    assert.ok(r.understanding.assumptions.every((a) => a.type === 'ASSUMPTION'));
    assert.equal(r.understanding.unresolvedUnknowns.length, 0);
  });

  it('supports English headings and bullet requirements with nested criteria', () => {
    const md = `# Todo\n\nA todo app.\n\n## Requirements\n- Add item: store items\n  - item appears in list\n- Remove item\n`;
    const r = ingestor.ingest(md, { projectId: 'todo' });
    assert.equal(r.requirements.length, 2);
    assert.equal(r.requirements[0].title, 'Add item');
    assert.deepEqual([...r.requirements[0].acceptanceCriteria], ['item appears in list']);
  });

  it('fails on empty spec or missing projectId', () => {
    assert.throws(() => ingestor.ingest('   ', { projectId: 'x' }), SpecIngestionError);
    assert.throws(() => ingestor.ingest('# A', { projectId: '' }), SpecIngestionError);
  });

  it('injects TASK-000: SCAFFOLD_PROJECT with DAG dependencies when isInitialized is false', () => {
    const r = ingestor.ingest(SPEC, { projectId: 'calc', isInitialized: false });
    const scaffold = r.tasks.find((t) => t.task_id === 'TASK-000');
    assert.ok(scaffold, 'TASK-000 must exist');
    assert.equal(scaffold.title, 'Universal Project Scaffolding & Bootstrap');
    assert.equal(scaffold.metadata?.taskClass, 'SCAFFOLD');
    assert.deepEqual(scaffold.dependencies, []);

    const implTasks = r.tasks.filter((t) => t.task_id !== 'TASK-000' && t.hierarchy_level === 'TASK');
    for (const t of implTasks) {
      assert.deepEqual(t.dependencies, ['TASK-000'], `Task ${t.task_id} must depend on TASK-000`);
    }

    const feature = r.tasks.find((t) => t.task_id === 'FEAT-SPEC');
    assert.deepEqual(feature?.dependencies, ['TASK-000']);
  });
});
