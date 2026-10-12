/**
 * Windows: every child process AIDM starts (git, AGY, checks, PowerShell DPAPI, taskkill/tasklist,
 * the detached worker) must pass `windowsHide: true`, otherwise console windows flash open/closed
 * during an autonomous run. Static audit of packages/core/src.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CALL_RE = /(?:\bchild_process\.|(?<![.\w]))(spawn|spawnSync|execSync|execFile|execFileSync|fork|execFileAsync|execAsync)\s*\(|\bchild_process\.exec\s*\(/g;

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
}
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

describe('windowsHide on every child process', () => {
  it('all child_process call sites in src pass windowsHide', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const f of walk(SRC)) {
      const src = fs.readFileSync(f, 'utf8');
      if (!/from 'node:child_process'|from "child_process"|from 'child_process'/.test(src)) continue;
      for (const m of src.matchAll(CALL_RE)) {
        const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!));
        if (/^\s*(\/\/|\*)/.test(line) || /promisify\(/.test(line) || /^\s*import\b/.test(line)) continue;
        calls++;
        const text = callText(src, m.index! + m[0].length - 1);
        if (!/windowsHide/.test(text)) offenders.push(`${path.relative(SRC, f)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    assert.ok(calls >= 10, `audit found only ${calls} call sites`);
    assert.deepEqual(offenders, [], `missing windowsHide: ${offenders.join(', ')}`);
  });
});
