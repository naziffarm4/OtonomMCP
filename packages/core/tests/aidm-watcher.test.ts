/** aidm watcher: claims passkey-signed resume requests for configured projects and starts the resume. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { watcherTick } from '../dist/mcp/aidm-watcher.js';
import { saveCheckpoint, listResumableRuns } from '../dist/autonomous/index.js';
import { resolveCanonicalProjectIdentity } from '../dist/director/project-identity-resolver.js';

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-watch-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}
function cp(dir: string, runId: string, status: string, startedAt: string) {
  saveCheckpoint({
    runId, projectRoot: dir, specPath: path.join(dir, 'proje.md'), specFingerprint: 'f', entryPoint: 'aidm_autonomous_start', approval: 'idp',
    budgetUsd: 1, startedAt, state: 'FINISHED', status, segment: 1, pid: 999999, updatedAt: startedAt, currentTaskId: null, inCycle: false, tasks: [], commits: [], monitorSeq: 3,
  } as never);
}
function fakeIdp(items: Array<{ resumeId: string; runId: string; projectId: string }>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}${init.body ? ' ' + init.body : ''}`);
    if (u.pathname === '/api/resume-requests') return new Response(JSON.stringify({ items }), { status: 200 });
    if (u.pathname.endsWith('/claim')) return new Response(JSON.stringify({ ok: true }), { status: items.some((i) => u.pathname.includes(i.resumeId)) ? 200 : 409 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const env = { AIDM_IDP_URL: 'http://127.0.0.1:9', AIDM_IDP_CLIENT_TOKEN: 't', AIDM_IDP_ISSUER: 'i', AIDM_IDP_AUDIENCE: 'a' };
const RID = '11111111-2222-4333-8444-555555555555';

describe('aidm watcher', () => {
  it('resumes a BLOCKED_ON_HUMAN run of a configured project; reports STARTED', async () => {
    const dir = project();
    try {
      cp(dir, 'run-a', 'BLOCKED_ON_HUMAN', '2026-10-13T04:30:00.000Z');
      const pid = resolveCanonicalProjectIdentity(dir).projectId;
      const idp = fakeIdp([{ resumeId: RID, runId: 'run-a', projectId: pid }, { resumeId: RID.replace('1', '9'), runId: 'x', projectId: 'other-project' }]);
      const started: string[] = [];
      const res = await watcherTick({ roots: [dir], env, fetchFn: idp.fetchFn, startResume: async (root, runId, resumeId) => { started.push(`${runId}:${resumeId}`); return { ok: true, note: 'WORKER_STARTED' }; } });
      assert.deepEqual(started, [`run-a:${RID}`]);
      assert.equal(res.length, 1);
      assert.equal(res[0]!.outcome, 'STARTED');
      assert.ok(idp.calls.some((c) => c.includes(`/api/resume-requests/${RID}/result`) && c.includes('STARTED')));
      assert.ok(!idp.calls.some((c) => c.includes('other-project') || c.includes(RID.replace('1', '9'))), 'other projects are never claimed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a completed (non-resumable) run is reported FAILED and never started', async () => {
    const dir = project();
    try {
      cp(dir, 'run-b', 'COMPLETED', '2026-10-13T04:30:00.000Z');
      const idp = fakeIdp([{ resumeId: RID, runId: 'run-b', projectId: resolveCanonicalProjectIdentity(dir).projectId }]);
      let started = 0;
      const res = await watcherTick({ roots: [dir], env, fetchFn: idp.fetchFn, startResume: async () => { started++; return { ok: true, note: '' }; } });
      assert.equal(started, 0);
      assert.equal(res[0]!.outcome, 'FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('listResumableRuns: only the newest blocked run is resumable (older ones were superseded)', () => {
    const dir = project();
    try {
      cp(dir, 'run-old', 'BLOCKED_ON_HUMAN', '2026-10-12T04:30:00.000Z');
      cp(dir, 'run-new', 'BLOCKED_ON_HUMAN', '2026-10-13T04:30:00.000Z');
      assert.deepEqual(listResumableRuns(dir).map((c: { runId: string }) => c.runId), ['run-new']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('aidm watcher env', () => {
  it('takes only missing AIDM_/OPENAI_ keys of the OtonomMCP server from the MCP config', async () => {
    const { envFromMcpConfig } = await import('../dist/mcp/aidm-watcher.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-cfg-'));
    try {
      const f = path.join(dir, 'mcp_config.json');
      fs.writeFileSync(f, JSON.stringify({ mcpServers: { other: { env: { AIDM_IDP_URL: 'no' } }, OtonomMCP: { env: { AIDM_IDP_URL: 'u', AIDM_IDP_CLIENT_TOKEN: 'c', OPENAI_MODEL: 'm', PATH: 'x' } } } }));
      assert.deepEqual(envFromMcpConfig({ AIDM_WATCH_MCP_CONFIG: f, OPENAI_MODEL: 'set' }), { AIDM_IDP_URL: 'u', AIDM_IDP_CLIENT_TOKEN: 'c' });
      assert.deepEqual(envFromMcpConfig({ AIDM_WATCH_MCP_CONFIG: path.join(dir, 'none.json') }), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
