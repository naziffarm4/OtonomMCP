import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerWatcherRoot, readWatcherRoots, watcherRootsFile, acquireWatcherLock, pollBackoff, watcherTick } from '../dist/mcp/aidm-watcher.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-w-'));

describe('aidm watcher: auto-registered roots, single instance, quiet backoff', () => {
  it('run starts register their project once; list persists in LOCALAPPDATA/aidm', () => {
    const la = tmp();
    const env = { LOCALAPPDATA: la };
    assert.equal(watcherRootsFile(env), path.join(la, 'aidm', 'watcher-roots.json'));
    assert.equal(watcherRootsFile({}), null, 'no LOCALAPPDATA (tests/CI) -> nothing written');
    assert.equal(registerWatcherRoot('/p/LLMTEST-1', env), true);
    registerWatcherRoot('/p/LLMTEST-1', env);
    registerWatcherRoot('/p/other', env);
    assert.deepEqual(readWatcherRoots(env), [path.resolve('/p/LLMTEST-1'), path.resolve('/p/other')]);
    assert.equal(registerWatcherRoot('/x', {}), false);
  });

  it('single instance: a second watcher cannot take a live lock; stale locks are reclaimed', () => {
    const f = path.join(tmp(), 'w.lock');
    const rel = acquireWatcherLock(f, process.pid)!;
    assert.ok(rel);
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(acquireWatcherLock(f, (child.pid ?? 0) + 0), null, 'live holder (this process) blocks others');
    rel();
    assert.equal(fs.existsSync(f), false);
    fs.writeFileSync(f, '999999');
    const r2 = acquireWatcherLock(f, process.pid);
    assert.ok(r2, 'dead pid lock reclaimed');
    r2!();
  });

  it('IdP unreachable: logged once per state change, delay backs off to 60s and resets', () => {
    const lines: string[] = [];
    const b = pollBackoff(15);
    for (let i = 0; i < 6; i++) b.update(false, 'ECONNREFUSED', (l) => lines.push(l));
    assert.equal(lines.length, 1);
    assert.equal(b.delayS, 60);
    b.update(true, undefined, (l) => lines.push(l));
    b.update(true, undefined, (l) => lines.push(l));
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /reachable again/);
    assert.equal(b.delayS, 15);
  });

  it('tick reports poll failure via onPollState instead of logging', async () => {
    const logs: string[] = [];
    const states: boolean[] = [];
    await watcherTick({ roots: [], env: { AIDM_IDP_URL: 'http://127.0.0.1:9' }, fetchFn: (async () => { throw new Error('down'); }) as never, log: (l) => logs.push(l), onPollState: (ok) => states.push(ok) });
    assert.deepEqual(states, [false]);
    assert.equal(logs.filter((l) => /poll failed/.test(l)).length, 0);
  });
});
