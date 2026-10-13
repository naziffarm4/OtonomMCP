import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nearMissPath, turkishStopReason, agyTimeouts } from '../dist/autonomous/index.js';
import { workspaceChangedSince } from '../dist/executor-bridge/antigravity-adapter.js';

test('near-miss target names map to the allowed name', () => {
  assert.equal(nearMissPath('blog.htm', ['index.html', 'blog.html']), 'blog.html');
  assert.equal(nearMissPath('hakimda.html', ['hakkimda.html']), 'hakkimda.html');
  assert.equal(nearMissPath('Blog.HTML', ['blog.html']), 'blog.html');
  assert.equal(nearMissPath('src/x.js', ['lib/x.js']), null);
  assert.equal(nearMissPath('secret.env', ['index.html']), null);
});

test('stop reasons become plain Turkish with the code in parentheses', () => {
  const r = turkishStopReason('BLOCKED_ON_HUMAN', 'Task TASK-006 did not pass independent verification within 3 attempt(s).');
  assert.match(r, /^TASK-006 .*doğrulama/);
  assert.match(r, /\(BLOCKED_ON_HUMAN: Task TASK-006/);
  const tr = 'TASK-006 durdu: AGY işi bitiremedi.';
  assert.equal(turkishStopReason('BLOCKED_ON_HUMAN', tr), tr);
  assert.match(turkishStopReason('FAILED', 'weird thing'), /^Çalışma başarısız oldu\. \(FAILED: weird thing\)$/);
});

test('AGY timeout defaults to 20 min with a 60 min cap and is configurable', () => {
  assert.deepEqual(agyTimeouts({}), { minTimeoutMs: 20 * 60_000, maxTimeoutMs: 60 * 60_000 });
  const c = agyTimeouts({ AIDM_AGY_TIMEOUT_MS: '600000', AIDM_AGY_MAX_TIMEOUT_MS: '1200000' });
  assert.equal(c.minTimeoutMs, 600_000);
  assert.equal(c.maxTimeoutMs, 1_200_000);
});

test('workspace change detection drives timeout extension', () => {
  const d = mkdtempSync(join(tmpdir(), 'ws-'));
  const t0 = Date.now() - 1000;
  assert.equal(workspaceChangedSince(d, t0), false);
  writeFileSync(join(d, 'a.html'), 'x');
  assert.equal(workspaceChangedSince(d, t0), true);
  assert.equal(workspaceChangedSince(undefined, t0), false);
});
