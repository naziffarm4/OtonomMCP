/**
 * Regression: a scaffolding task that creates package.json with a different `name` than the folder
 * must NOT change the canonical projectId mid-run (it made every later task fail as
 * "Canonical project identity mismatch ... Accidental cross-project execution rejected").
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveCanonicalProjectIdentity,
  pinCanonicalProjectIdentity,
  PROJECT_IDENTITY_PIN_FILE,
} from '../dist/director/project-identity-resolver.js';
import { isProjectIdentityFailure } from '../dist/autonomous/autonomous-runner.js';

function tmp(name: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-pin-'));
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  return dir;
}

describe('project identity pin', () => {
  it('keeps the run-start identity after a task creates package.json with another name', () => {
    const dir = tmp('salon-otonom');
    const atStart = pinCanonicalProjectIdentity(dir);
    assert.equal(atStart.projectId, 'salon-otonom');
    assert.ok(fs.existsSync(path.join(dir, PROJECT_IDENTITY_PIN_FILE)));

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'salon' }));
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'salon-otonom');

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'renamed-again' }));
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'salon-otonom');
  });

  it('auto-pins once the project is AIDM-managed (.ai-manager exists)', () => {
    const dir = tmp('managed');
    fs.mkdirSync(path.join(dir, '.ai-manager'));
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'managed');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'other' }));
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'managed');
  });

  it('does not write anything into unmanaged folders (derived identity, no pin)', () => {
    const dir = tmp('plain');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-name' }));
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'pkg-name');
    assert.equal(fs.existsSync(path.join(dir, '.ai-manager')), false);
  });

  it('ignores a pin copied from another project root and re-pins for this root', () => {
    const dir = tmp('copy-target');
    fs.mkdirSync(path.join(dir, '.ai-manager', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, PROJECT_IDENTITY_PIN_FILE),
      JSON.stringify({ projectId: 'original', projectName: 'original', projectRoot: path.join(os.tmpdir(), 'elsewhere'), ecosystem: 'node' })
    );
    // The foreign pin is ignored and replaced by a pin for THIS root, which then stays stable.
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'copy-target');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'something-else' }));
    assert.equal(resolveCanonicalProjectIdentity(dir).projectId, 'copy-target');
  });

  it('classifies identity/binding rejections as deterministic failures', () => {
    assert.equal(isProjectIdentityFailure("Canonical project identity mismatch: expected 'a', got 'b' at 'x'."), true);
    assert.equal(isProjectIdentityFailure('Cross-project session reuse is strictly prohibited.'), true);
    assert.equal(isProjectIdentityFailure('npm test failed'), false);
    assert.equal(isProjectIdentityFailure(undefined), false);
  });
});
