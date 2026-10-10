import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, '../scripts/run-tests.js');

describe('Safe Test Runner Filtering (run-tests.js)', () => {
  it('1. default invocation without filters selects all deterministic test files (--dry-run)', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--dry-run']);
    assert.equal(stderr, '');
    assert.match(stdout, /Dry run: \d+ test file\(s\) selected\./);
    // At least 116 deterministic test files
    const match = stdout.match(/Dry run: (\d+) test file\(s\) selected\./);
    assert.ok(match, 'Expected match for dry run output');
    const count = parseInt(match[1], 10);
    assert.ok(count >= 116, `Expected at least 116 test files, got ${count}`);
  });

  it('2. --live flag selects only live test files (--dry-run)', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--live', '--dry-run']);
    assert.equal(stderr, '');
    const match = stdout.match(/Dry run: (\d+) test file\(s\) selected\./);
    assert.ok(match, 'Expected match for live dry run output');
    const count = parseInt(match[1], 10);
    assert.equal(count, 2, `Expected exactly 2 live test files, got ${count}`);
  });

  it('3. filters by pattern matching specific files (e.g. p18-04)', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--dry-run', 'p18-04']);
    assert.equal(stderr, '');
    assert.match(stdout, /Running 2 deterministic test file\(s\) matching "p18-04"/);
    assert.match(stdout, /p18-04-real-project-approval\.test\.ts/);
    assert.match(stdout, /p18-04-trusted-identity-context\.test\.ts/);
    assert.match(stdout, /Dry run: 2 test file\(s\) selected\./);
  });

  it('4. non-matching pattern (e.g. nonce) produces explicit error and exit code 1', async () => {
    let thrownError: any = null;
    try {
      await execFileAsync(process.execPath, [scriptPath, 'nonce']);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected script to exit with error when pattern matches 0 files');
    assert.equal(thrownError.code, 1, `Expected exit code 1, got ${thrownError.code}`);
    assert.match(
      thrownError.stderr,
      /Error: No deterministic test files matched pattern\(s\): "nonce"/
    );
  });

  it('5. handles path-like patterns by extracting basename safely', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      '--dry-run',
      'tests/p18-04-real-project-approval.test.ts',
    ]);
    assert.match(stdout, /Running 1 deterministic test file\(s\)/);
    assert.match(stdout, /p18-04-real-project-approval\.test\.ts/);
    assert.match(stdout, /Dry run: 1 test file\(s\) selected\./);
  });

  it('6. supports safe wildcard patterns (* and ?)', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      '--dry-run',
      'p18*approval',
    ]);
    assert.match(stdout, /Running 1 deterministic test file\(s\)/);
    assert.match(stdout, /p18-04-real-project-approval\.test\.ts/);
    assert.match(stdout, /Dry run: 1 test file\(s\) selected\./);
  });

  it('7. supports multiple pattern arguments (union of matches)', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      '--dry-run',
      'actors',
      'errors',
    ]);
    assert.match(stdout, /Running 2 deterministic test file\(s\)/);
    assert.match(stdout, /actors\.test\.ts/);
    assert.match(stdout, /errors\.test\.ts/);
    assert.match(stdout, /Dry run: 2 test file\(s\) selected\./);
  });

  it('8. path traversal attempts are safely sanitized and fail closed', async () => {
    let thrownError: any = null;
    try {
      await execFileAsync(process.execPath, [scriptPath, '../../../../etc/shadow']);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected path traversal attempt to fail closed');
    assert.equal(thrownError.code, 1);
    assert.match(thrownError.stderr, /Error: No deterministic test files matched pattern\(s\)/);
  });

  it('9. standard -- argument delimiter is not treated as a search pattern', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      '--',
      '--dry-run',
      'actors',
    ]);
    assert.match(stdout, /Running 1 deterministic test file\(s\)/);
    assert.match(stdout, /actors\.test\.ts/);
  });

  it('10. --help prints usage instructions and exits 0', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--help']);
    assert.equal(stderr, '');
    assert.match(stdout, /Usage: node scripts\/run-tests\.js/);
    assert.match(stdout, /Options:/);
  });
});
