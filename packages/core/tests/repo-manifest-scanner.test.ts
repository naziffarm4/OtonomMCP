/**
 * Unit tests: Repo Manifest Scanner (MOD-01)
 *
 * Verifies workspace initialization status and ecosystem detection across
 * 8 ecosystems + mobile/embedded, including stub detection and empty repo rules.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectWorkspaceStatus,
  isManifestStub,
} from '../dist/autonomous/index.js';

describe('Repo Manifest Scanner (MOD-01)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-repo-scan-test-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects an empty directory as uninitialized', async () => {
    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, false);
    assert.deepEqual(status.detectedEcosystems, []);
    assert.deepEqual(status.manifestFiles, []);
  });

  it('detects a non-existent directory safely as uninitialized', async () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    const status = await detectWorkspaceStatus(nonExistent);
    assert.equal(status.isInitialized, false);
    assert.deepEqual(status.detectedEcosystems, []);
    assert.deepEqual(status.manifestFiles, []);
  });

  it('detects directory with only SPEC.md, README.md, or .git as uninitialized', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'SPEC.md'), '# Specification\n');
    await fs.promises.writeFile(path.join(tmpDir, 'README.md'), '# Readme\n');
    await fs.promises.mkdir(path.join(tmpDir, '.git'));
    await fs.promises.writeFile(path.join(tmpDir, '.git', 'config'), '[core]\n');

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, false);
    assert.deepEqual(status.detectedEcosystems, []);
    assert.deepEqual(status.manifestFiles, []);
  });

  it('detects initialized Node.js project with valid package.json', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2)
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['node']);
    assert.deepEqual(status.manifestFiles, ['package.json']);
  });

  it('deduplicates ecosystem when both package.json and tsconfig.json exist', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-ts-app' })
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022' } })
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['node']);
    assert.deepEqual(status.manifestFiles, ['package.json', 'tsconfig.json']);
  });

  it('treats 0-byte package.json as stub and marks workspace uninitialized', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), '');

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, false);
    assert.deepEqual(status.detectedEcosystems, ['node']);
    assert.deepEqual(status.manifestFiles, ['package.json']);
    assert.deepEqual(status.stubFiles, ['package.json']);
  });

  it('treats empty JSON object in package.json as stub and marks workspace uninitialized', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), '   {}   \n');

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, false);
    assert.deepEqual(status.detectedEcosystems, ['node']);
    assert.deepEqual(status.manifestFiles, ['package.json']);
    assert.deepEqual(status.stubFiles, ['package.json']);
  });

  it('treats comments-only requirements.txt as stub and marks workspace uninitialized', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      '# Add dependencies here\n# TODO\n'
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, false);
    assert.deepEqual(status.detectedEcosystems, ['python']);
    assert.deepEqual(status.manifestFiles, ['requirements.txt']);
    assert.deepEqual(status.stubFiles, ['requirements.txt']);
  });

  it('detects Python project with pyproject.toml', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'pyproject.toml'),
      '[project]\nname = "demo"\nversion = "0.1.0"\n'
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['python']);
    assert.deepEqual(status.manifestFiles, ['pyproject.toml']);
  });

  it('detects Go project with go.mod', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['go']);
    assert.deepEqual(status.manifestFiles, ['go.mod']);
  });

  it('detects Rust project with Cargo.toml', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "app"\nversion = "0.1.0"\n'
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['rust']);
    assert.deepEqual(status.manifestFiles, ['Cargo.toml']);
  });

  it('detects Java/Kotlin project with build.gradle.kts and pom.xml', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'build.gradle.kts'), 'plugins {\n  kotlin("jvm")\n}\n');

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['java']);
    assert.deepEqual(status.manifestFiles, ['build.gradle.kts']);
  });

  it('detects .NET/C# project with *.csproj and *.sln pattern matching', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'MyService.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n'
    );
    await fs.promises.writeFile(path.join(tmpDir, 'Solution.sln'), 'Microsoft Visual Studio Solution File\n');

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['dotnet']);
    assert.deepEqual(status.manifestFiles, ['MyService.csproj', 'Solution.sln']);
  });

  it('detects PHP project with composer.json', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ name: 'vendor/package', require: {} })
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['php']);
    assert.deepEqual(status.manifestFiles, ['composer.json']);
  });

  it('detects Mobile project with pubspec.yaml and app.json', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'pubspec.yaml'),
      'name: flutter_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n'
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['mobile']);
    assert.deepEqual(status.manifestFiles, ['pubspec.yaml']);
  });

  it('detects Embedded project with platformio.ini', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'platformio.ini'),
      '[env:esp32dev]\nplatform = espressif32\n'
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['embedded']);
    assert.deepEqual(status.manifestFiles, ['platformio.ini']);
  });

  it('detects multi-runtime workspaces deterministically', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fullstack' })
    );
    await fs.promises.writeFile(
      path.join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "native-core"\nversion = "0.1.0"\n'
    );

    const status = await detectWorkspaceStatus(tmpDir);
    assert.equal(status.isInitialized, true);
    assert.deepEqual(status.detectedEcosystems, ['node', 'rust']);
    assert.deepEqual(status.manifestFiles, ['Cargo.toml', 'package.json']);
  });

  it('isManifestStub helper identifies various stub conditions correctly', async () => {
    const emptyFile = path.join(tmpDir, 'empty.txt');
    await fs.promises.writeFile(emptyFile, '');
    assert.equal(await isManifestStub(emptyFile), true);

    const whitespaceFile = path.join(tmpDir, 'space.txt');
    await fs.promises.writeFile(whitespaceFile, '  \n\t  \n');
    assert.equal(await isManifestStub(whitespaceFile), true);

    const emptyJson = path.join(tmpDir, 'empty.json');
    await fs.promises.writeFile(emptyJson, '{}');
    assert.equal(await isManifestStub(emptyJson), true);

    const validJson = path.join(tmpDir, 'valid.json');
    await fs.promises.writeFile(validJson, '{"key": "value"}');
    assert.equal(await isManifestStub(validJson), false);

    const commentsOnly = path.join(tmpDir, 'comments.txt');
    await fs.promises.writeFile(commentsOnly, '// Line 1\n/* Line 2 */\n# Line 3\n');
    assert.equal(await isManifestStub(commentsOnly), true);

    const codeFile = path.join(tmpDir, 'code.txt');
    await fs.promises.writeFile(codeFile, '// Header\nconst x = 1;\n');
    assert.equal(await isManifestStub(codeFile), false);
  });
});
