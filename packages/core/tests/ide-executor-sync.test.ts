/**
 * Unit tests: Antigravity Sync Bridge & Evidence-Driven Verification (MOD-04)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ideNextTask,
  ideSubmit,
  readIdeSubmit,
  createIdeRequestInvoker,
  saveArchitectureIntentReport,
  generateArchitectureIntentReport,
  extractTechStackSchema,
  createIdeNextTaskHandler,
  createIdeSubmitTaskHandler,
} from '../dist/index.js';

describe('Antigravity Sync Bridge (MOD-04)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ideNextTask returns architectureIntent when report is present in projectRoot', () => {
    const spec = `
# Kuaför Otomasyonu
## Mimari
- Web: Next.js
- Mobil: Flutter
`;
    const tech = extractTechStackSchema(spec, 'kuafor');
    const intentReport = generateArchitectureIntentReport({
      projectId: 'proj-1',
      projectName: 'kuafor',
      specFingerprint: 'hash123',
      techStack: tech,
    });
    saveArchitectureIntentReport(tmpDir, intentReport);

    // Initial call before any task is posted
    const noneResult = ideNextTask(tmpDir);
    assert.equal(noneResult.state, 'NONE');
    assert.ok(noneResult.architectureIntent, 'Must include architectureIntent in NONE state');
    assert.equal(noneResult.architectureIntent?.projectName, 'kuafor');
    assert.equal(noneResult.architectureIntent?.isMonorepo, true);

    // Write a mock task to mailbox
    const ideDir = path.join(tmpDir, '.ai-manager', 'state', 'ide');
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideDir, 'task.json'),
      JSON.stringify({ seq: 1, taskId: 'TASK-000', prompt: 'Scaffold workspace', postedAt: new Date().toISOString() })
    );

    const taskResult = ideNextTask(tmpDir);
    assert.equal(taskResult.state, 'TASK');
    if (taskResult.state === 'TASK') {
      assert.equal(taskResult.task.taskId, 'TASK-000');
      assert.ok(taskResult.architectureIntent, 'Must include architectureIntent in TASK state');
      assert.equal(taskResult.architectureIntent?.isMonorepo, true);
    }
  });

  it('ideSubmit records testEvidence in submit.json', () => {
    const ideDir = path.join(tmpDir, '.ai-manager', 'state', 'ide');
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideDir, 'task.json'),
      JSON.stringify({ seq: 1, taskId: 'TASK-001', prompt: 'Implement auth', postedAt: new Date().toISOString() })
    );

    const testEvidence = {
      command: 'pnpm test auth',
      exitCode: 0,
      output: 'All 8 tests passed',
    };

    const res = ideSubmit(tmpDir, 1, 'Auth module completed with unit tests', ['src/auth.ts'], testEvidence);
    assert.equal(res.ok, true);

    const sub = readIdeSubmit(tmpDir);
    assert.ok(sub);
    assert.equal(sub?.seq, 1);
    assert.equal(sub?.taskId, 'TASK-001');
    assert.deepEqual(sub?.testEvidence, testEvidence);
  });

  it('MCP createIdeNextTaskHandler passes architectureIntent to MCP caller', async () => {
    const spec = `# Monorepo App\npnpm workspace with Next.js and NestJS.`;
    const tech = extractTechStackSchema(spec, 'mono');
    const intentReport = generateArchitectureIntentReport({
      projectId: 'proj-mono',
      projectName: 'mono',
      specFingerprint: 'hashmono',
      techStack: tech,
    });
    saveArchitectureIntentReport(tmpDir, intentReport);

    const handler = createIdeNextTaskHandler();
    const result = await handler({ workspaceRoot: tmpDir }, {} as any);
    const parsed = JSON.parse(result.content[0].text);

    assert.ok(parsed.architectureIntent);
    assert.equal(parsed.architectureIntent.projectName, 'mono');
    assert.equal(parsed.architectureIntent.isMonorepo, true);
  });

  it('MCP createIdeSubmitTaskHandler accepts testEvidence and records it', async () => {
    const ideDir = path.join(tmpDir, '.ai-manager', 'state', 'ide');
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideDir, 'task.json'),
      JSON.stringify({ seq: 2, taskId: 'TASK-002', prompt: 'Implement payment', postedAt: new Date().toISOString() })
    );
    // Write verdict to avoid wait timeout
    fs.writeFileSync(
      path.join(ideDir, 'verdict.json'),
      JSON.stringify({ seq: 2, verdict: 'ACCEPTED', message: 'Good job' })
    );

    const handler = createIdeSubmitTaskHandler();
    const result = await handler({
      workspaceRoot: tmpDir,
      seq: 2,
      summary: 'Payment gateway implemented',
      changedFiles: ['src/payment.ts'],
      testEvidence: {
        command: 'pnpm test payment',
        exitCode: 0,
        output: 'PASS payment.test.ts',
      },
    }, {} as any);

    assert.ok(result);
    const sub = readIdeSubmit(tmpDir);
    assert.equal(sub?.seq, 2);
    assert.equal(sub?.testEvidence?.exitCode, 0);
    assert.equal(sub?.testEvidence?.command, 'pnpm test payment');
  });
});
