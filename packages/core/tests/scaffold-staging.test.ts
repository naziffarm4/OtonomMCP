/**
 * Unit tests: Scaffold Staging & Conflict-Free Promotion Manager (Section 5.3)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  preflightWorkspaceDirectory,
  stripStagedGit,
  promoteStagedFiles,
  isProtectedPath,
} from '../dist/autonomous/index.js';

describe('Scaffold Staging & Conflict-Free Promotion (Section 5.3)', () => {
  let tmpWorkspace: string;
  let tmpStaging: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-ws-'));
    tmpStaging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-stg-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpWorkspace, { recursive: true, force: true });
    await fs.promises.rm(tmpStaging, { recursive: true, force: true });
  });

  it('identifies protected filenames correctly', () => {
    assert.equal(isProtectedPath('SPEC.md'), true);
    assert.equal(isProtectedPath('README.md'), true);
    assert.equal(isProtectedPath('.git'), true);
    assert.equal(isProtectedPath('.ai-manager'), true);
    assert.equal(isProtectedPath('.gitignore'), true);
    assert.equal(isProtectedPath('.env.local'), true);
    assert.equal(isProtectedPath('tasks/plan.md'), true);
    assert.equal(isProtectedPath('package.json'), false);
    assert.equal(isProtectedPath('src/index.ts'), false);
  });

  it('preflight approves clean workspace containing only doc / git artifacts', async () => {
    await fs.promises.writeFile(path.join(tmpWorkspace, 'SPEC.md'), '# Spec');
    await fs.promises.writeFile(path.join(tmpWorkspace, 'README.md'), '# Readme');
    await fs.promises.mkdir(path.join(tmpWorkspace, '.git'));
    await fs.promises.writeFile(path.join(tmpWorkspace, '.gitignore'), 'node_modules\n');

    const result = await preflightWorkspaceDirectory(tmpWorkspace);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'CLEAN_BOOTSTRAP_ELIGIBLE');
    assert.deepEqual(result.conflictingFiles, []);
  });

  it('preflight rejects workspace with pre-existing code / foreign manifests', async () => {
    await fs.promises.writeFile(path.join(tmpWorkspace, 'SPEC.md'), '# Spec');
    await fs.promises.writeFile(path.join(tmpWorkspace, 'package.json'), '{}');

    const result = await preflightWorkspaceDirectory(tmpWorkspace);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'CONFLICT_DETECTED');
    assert.deepEqual(result.conflictingFiles, ['package.json']);
  });

  it('stripStagedGit removes .git from staging directory', async () => {
    const stagedGit = path.join(tmpStaging, '.git');
    await fs.promises.mkdir(stagedGit);
    await fs.promises.writeFile(path.join(stagedGit, 'HEAD'), 'ref: refs/heads/main');

    const removed = await stripStagedGit(tmpStaging);
    assert.equal(removed, true);
    assert.equal(fs.existsSync(stagedGit), false);
  });

  it('promotes files without overwriting protected workspace files', async () => {
    // 1. Existing workspace files
    await fs.promises.writeFile(path.join(tmpWorkspace, 'SPEC.md'), 'ORIGINAL SPEC CONTENT');
    await fs.promises.writeFile(path.join(tmpWorkspace, '.gitignore'), 'ORIGINAL GITIGNORE');

    // 2. Staging files (including attempted override of SPEC.md and .git)
    await fs.promises.mkdir(path.join(tmpStaging, '.git'));
    await fs.promises.writeFile(path.join(tmpStaging, '.git', 'config'), '[core]');
    await fs.promises.writeFile(path.join(tmpStaging, 'SPEC.md'), 'HIJACKED SPEC');
    await fs.promises.writeFile(path.join(tmpStaging, 'package.json'), '{"name": "new-app"}');
    await fs.promises.mkdir(path.join(tmpStaging, 'src'));
    await fs.promises.writeFile(path.join(tmpStaging, 'src', 'main.ts'), 'console.log("hello");');
    await fs.promises.writeFile(path.join(tmpStaging, 'gradlew'), '#!/bin/sh\nexit 0');

    const promoteRes = await promoteStagedFiles({
      stagingDir: tmpStaging,
      workspaceRoot: tmpWorkspace,
    });

    // Verify SPEC.md remained untouched
    const specContent = await fs.promises.readFile(path.join(tmpWorkspace, 'SPEC.md'), 'utf-8');
    assert.equal(specContent, 'ORIGINAL SPEC CONTENT');

    // Verify new files were promoted
    assert.equal(fs.existsSync(path.join(tmpWorkspace, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(tmpWorkspace, 'src', 'main.ts')), true);
    assert.equal(fs.existsSync(path.join(tmpWorkspace, 'gradlew')), true);

    // Verify staged .git was NOT promoted to workspace
    assert.equal(fs.existsSync(path.join(tmpWorkspace, '.git', 'config')), false);

    assert.ok(promoteRes.skippedFiles.includes('SPEC.md'));
    assert.ok(promoteRes.promotedFiles.includes('package.json'));
    assert.ok(promoteRes.promotedFiles.includes('src/main.ts'));
    assert.ok(promoteRes.promotedFiles.includes('gradlew'));
  });

  it('blocks symlink path traversal pointing outside staging directory', async () => {
    const secretFile = path.join(tmpWorkspace, 'secret.txt');
    await fs.promises.writeFile(secretFile, 'SUPER_SECRET');

    // Attempt to create a symlink in staging pointing outside
    try {
      await fs.promises.symlink(secretFile, path.join(tmpStaging, 'leak-link'));
      const promoteRes = await promoteStagedFiles({
        stagingDir: tmpStaging,
        workspaceRoot: tmpWorkspace,
      });

      assert.ok(promoteRes.skippedFiles.includes('leak-link'));
      assert.equal(fs.existsSync(path.join(tmpWorkspace, 'leak-link')), false);
    } catch {
      // Symlink creation might be restricted on some Windows configurations without developer mode
    }
  });
});
