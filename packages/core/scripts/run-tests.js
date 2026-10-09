#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(__dirname, '../tests');
const isLive = process.argv.includes('--live');

if (isLive) {
  process.env.AIDM_LIVE_E2E = '1';
}

const allTestFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

const selectedFiles = isLive
  ? allTestFiles.filter((f) => f.includes('.live.test.ts'))
  : allTestFiles.filter((f) => !f.includes('.live.test.ts'));

if (selectedFiles.length === 0) {
  console.log(isLive ? 'No live test files found.' : 'No deterministic test files found.');
  process.exit(0);
}

const child = spawn(
  process.execPath,
  ['--test', '--experimental-strip-types', ...selectedFiles.map((f) => path.join('tests', f))],
  {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
