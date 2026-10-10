#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(__dirname, '../tests');

const rawArgs = process.argv.slice(2);
const isLive = rawArgs.includes('--live');
const isDryRun = rawArgs.includes('--dry-run') || rawArgs.includes('--list');
const isHelp = rawArgs.includes('--help') || rawArgs.includes('-h');

if (isHelp) {
  console.log(`
Usage: node scripts/run-tests.js [options] [pattern...]

Options:
  --live        Run live tests (*.live.test.ts) instead of deterministic tests
  --dry-run     List matched test files without executing them
  --list        Alias for --dry-run
  -h, --help    Show this help message

Patterns:
  One or more file names, substrings, or glob patterns (*, ?) to filter test files.
  Example:
    pnpm test p18-04
    pnpm test nonce
`);
  process.exit(0);
}

if (isLive) {
  process.env.AIDM_LIVE_E2E = '1';
}

// Extract filter patterns (excluding flags and standard '--' separator)
const patterns = rawArgs.filter((arg) => arg !== '--' && !arg.startsWith('--'));

const allTestFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

let selectedFiles = isLive
  ? allTestFiles.filter((f) => f.includes('.live.test.ts'))
  : allTestFiles.filter((f) => !f.includes('.live.test.ts'));

function matchesPattern(filename, pattern) {
  if (typeof pattern !== 'string') return false;
  // Normalize Windows/POSIX separators and extract basename
  const cleaned = path.basename(pattern.replaceAll('\\', '/')).trim();
  if (!cleaned) return false;

  // Wildcard match if pattern contains * or ?
  if (cleaned.includes('*') || cleaned.includes('?')) {
    const escaped = cleaned
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    try {
      const regex = new RegExp(escaped, 'i');
      return regex.test(filename);
    } catch {
      return false;
    }
  }

  // Case-insensitive substring match
  return filename.toLowerCase().includes(cleaned.toLowerCase());
}

if (patterns.length > 0) {
  selectedFiles = selectedFiles.filter((file) =>
    patterns.some((pattern) => matchesPattern(file, pattern))
  );

  if (selectedFiles.length === 0) {
    console.error(
      `Error: No ${isLive ? 'live ' : 'deterministic '}test files matched pattern(s): ${patterns
        .map((p) => `"${p}"`)
        .join(', ')}`
    );
    process.exit(1);
  }

  console.log(
    `Running ${selectedFiles.length} ${isLive ? 'live' : 'deterministic'} test file(s) matching ${patterns
      .map((p) => `"${p}"`)
      .join(', ')}:`
  );
  for (const file of selectedFiles) {
    console.log(`  • ${file}`);
  }
} else if (selectedFiles.length === 0) {
  console.log(isLive ? 'No live test files found.' : 'No deterministic test files found.');
  process.exit(0);
}

if (isDryRun) {
  console.log(`Dry run: ${selectedFiles.length} test file(s) selected.`);
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
