import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { ExternalMcpClient } from './helpers/external-mcp-client.ts';

const execFile = promisify(execFileCallback);

async function initGitProject(projectDir: string, projectName: string): Promise<string> {
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'README.md'),
    `# ${projectName}\nInitial baseline for P18 pilot.\n`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, '.gitignore'),
    `.ai-manager/\nnode_modules/\n`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: projectName, version: '0.1.0' }, null, 2),
    'utf-8'
  );

  await execFile('git', ['init'], { cwd: projectDir });
  await execFile('git', ['config', 'user.name', 'P18 Test Director'], { cwd: projectDir });
  await execFile('git', ['config', 'user.email', 'director@aidm.test'], { cwd: projectDir });
  await execFile('git', ['add', '.'], { cwd: projectDir });
  await execFile('git', ['commit', '-m', `Initial commit for ${projectName}`], { cwd: projectDir });

  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
  return stdout.trim();
}

async function getDirInventory(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function scan(current: string) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const full = path.join(current, entry);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        result.push(full);
        await scan(full);
      } else {
        result.push(full);
      }
    }
  }
  await scan(dir);
  return result;
}

describe('P18-02: Real Target Project Binding & MCP Context', () => {
  let targetDirA: string;
  let targetDirB: string;
  let targetAHead: string;
  let targetBHead: string;
  let serverRepoRoot: string;
  let serverRepoInitialInventory: string[];
  let client: ExternalMcpClient;

  before(async () => {
    serverRepoRoot = path.resolve(import.meta.dirname, '../../..');
    serverRepoInitialInventory = await getDirInventory(path.join(serverRepoRoot, '.ai-manager'));

    // Create TARGET-A and TARGET-B as real separate Git projects
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p18-02-'));
    targetDirA = path.join(tempRoot, 'target-project-alpha');
    targetDirB = path.join(tempRoot, 'target-project-beta');

    targetAHead = await initGitProject(targetDirA, 'target-project-alpha');
    targetBHead = await initGitProject(targetDirB, 'target-project-beta');

    assert.ok(targetAHead && targetAHead.length === 40, 'Target-A must have valid Git HEAD SHA');
    assert.ok(targetBHead && targetBHead.length === 40, 'Target-B must have valid Git HEAD SHA');
    assert.notEqual(targetAHead, targetBHead, 'Target-A and Target-B must have distinct Git HEAD SHAs');
  });

  after(async () => {
    if (client && client.isRunning) {
      await client.stop();
    }
    try {
      await fs.rm(path.dirname(targetDirA), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('AC-01 & AC-02: launches real AIDM MCP server and connects external MCP client', async () => {
    // Start server without a fixed project root to verify dynamic client context binding
    client = new ExternalMcpClient({
      projectRoot: process.cwd(),
    });

    await client.start();
    assert.ok(client.isRunning);
    assert.ok(client.serverPid && client.serverPid !== client.clientPid);

    const initRes = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'external-pilot-client', version: '1.0.0' },
    });
    assert.equal(initRes.error, undefined);
    await client.notify('notifications/initialized');
  });

  it('AC-03, AC-04, AC-05, AC-06: binds Target-A and verifies active context propagation to read tools', async () => {
    // 1. Establish active Director session context bound to Target-A
    const createSessionRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.director.session.create',
      arguments: {
        workspaceRoot: targetDirA,
        actor: 'DIRECTOR',
      },
    });

    assert.equal(createSessionRes.error, undefined);
    const sessionData = JSON.parse(createSessionRes.result!.content[0].text);
    assert.equal(path.resolve(sessionData.projectRoot), path.resolve(targetDirA));
    assert.equal(sessionData.status, 'ACTIVE');
    assert.ok(sessionData.directorSessionId.startsWith('dir-sess-'));

    // 2. Query aidm.project.status WITHOUT workspaceRoot argument (verifying active context supplies root)
    const statusRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.project.status',
      arguments: {},
    });

    assert.equal(statusRes.error, undefined);
    const statusData = JSON.parse(statusRes.result!.content[0].text);
    assert.equal(path.resolve(statusData.projectRoot), path.resolve(targetDirA));
    assert.equal(statusData.git.head, targetAHead);
    assert.notEqual(path.resolve(statusData.projectRoot), serverRepoRoot, 'AIDM server repository must NOT be returned');

    // 3. Query aidm.git.status WITHOUT workspaceRoot argument
    const gitRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.git.status',
      arguments: {},
    });

    assert.equal(gitRes.error, undefined);
    const gitData = JSON.parse(gitRes.result!.content[0].text);
    assert.equal(gitData.isGitRepository, true);
    assert.equal(gitData.head, targetAHead);
    assert.equal(gitData.workingTreeClean, true);

    // 4. Query active session info via aidm.director.session.get WITHOUT sessionId
    const getSessionRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.director.session.get',
      arguments: {},
    });

    assert.equal(getSessionRes.error, undefined);
    const getSessionData = JSON.parse(getSessionRes.result!.content[0].text);
    assert.equal(getSessionData.directorSessionId, sessionData.directorSessionId);
    assert.equal(path.resolve(getSessionData.projectRoot), path.resolve(targetDirA));
  });

  it('AC-07 & AC-08: verifies explicit workspaceRoot resolution and conflict rejection', async () => {
    // 1. Explicit matching root succeeds
    const matchingRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.project.status',
      arguments: {
        workspaceRoot: targetDirA,
      },
    });
    assert.equal(matchingRes.error, undefined);

    // 2. Conflict: Calling with explicit Target-B workspaceRoot while Target-A is active context
    // Invariant: Explicit root and active context conflict must NOT silently select one; must fail closed.
    const conflictRes = await client.request('tools/call', {
      name: 'aidm.project.status',
      arguments: {
        workspaceRoot: targetDirB,
      },
    });

    assert.ok(conflictRes.error, 'Conflicting explicit root vs active context must return error');
    assert.match(
      conflictRes.error!.message,
      /conflicts with active context projectRoot/i,
      'Error message must indicate cross-project conflict'
    );

    // Same check on git status
    const gitConflictRes = await client.request('tools/call', {
      name: 'aidm.git.status',
      arguments: {
        workspaceRoot: targetDirB,
      },
    });
    assert.ok(gitConflictRes.error, 'Git status conflict must return error');
    assert.match(gitConflictRes.error!.message, /conflicts with active context projectRoot/i);
  });

  it('AC-09, AC-10, AC-11: verifies fail-closed behavior on invalid roots and path traversal', async () => {
    // 1. Nonexistent directory
    const nonexistentPath = path.join(os.tmpdir(), 'nonexistent-directory-xyz-12345');
    const nonexistentRes = await client.request('tools/call', {
      name: 'aidm.project.status',
      arguments: {
        workspaceRoot: nonexistentPath,
      },
    });
    assert.ok(nonexistentRes.error);
    assert.match(nonexistentRes.error!.message, /does not exist/i);

    // 2. File path instead of directory
    const filePath = path.join(targetDirA, 'README.md');
    const fileRes = await client.request('tools/call', {
      name: 'aidm.project.status',
      arguments: {
        workspaceRoot: filePath,
      },
    });
    assert.ok(fileRes.error);
    assert.match(fileRes.error!.message, /is not a directory/i);

    // 3. Path traversal attempting escape to nonexistent
    const traversalPath = path.join(targetDirA, '../../../../../../nonexistent-escape-target');
    const traversalRes = await client.request('tools/call', {
      name: 'aidm.project.status',
      arguments: {
        workspaceRoot: traversalPath,
      },
    });
    assert.ok(traversalRes.error);
    assert.match(traversalRes.error!.message, /does not exist/i);

    // 4. Empty string
    const emptyRes = await client.request('tools/call', {
      name: 'aidm.project.status',
      arguments: {
        workspaceRoot: '   ',
      },
    });
    assert.ok(emptyRes.error);
    assert.match(emptyRes.error!.message, /non-empty string/i);
  });

  it('AC-14: verifies cross-project isolation when switching active context to Target-B', async () => {
    // 1. Bind Target-B via director session create
    const switchRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.director.session.create',
      arguments: {
        workspaceRoot: targetDirB,
        actor: 'DIRECTOR',
      },
    });
    assert.equal(switchRes.error, undefined);
    const sessionB = JSON.parse(switchRes.result!.content[0].text);
    assert.equal(path.resolve(sessionB.projectRoot), path.resolve(targetDirB));

    // 2. Query project.status without arguments: now points to Target-B
    const statusBRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.project.status',
      arguments: {},
    });
    assert.equal(statusBRes.error, undefined);
    const statusB = JSON.parse(statusBRes.result!.content[0].text);
    assert.equal(path.resolve(statusB.projectRoot), path.resolve(targetDirB));
    assert.equal(statusB.git.head, targetBHead);

    // 3. Query git.status without arguments: points to Target-B's HEAD
    const gitBRes = await client.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.git.status',
      arguments: {},
    });
    assert.equal(gitBRes.error, undefined);
    const gitB = JSON.parse(gitBRes.result!.content[0].text);
    assert.equal(gitB.head, targetBHead);
    assert.notEqual(gitB.head, targetAHead, 'Target-B HEAD must not equal Target-A HEAD');
  });

  it('AC-12, AC-13, AC-15, AC-16: verifies state isolation and server repository protection', async () => {
    // 1. Verify Target-A has its own .ai-manager state
    const targetADirectorDir = path.join(targetDirA, '.ai-manager', 'director');
    const targetAStat = await fs.stat(targetADirectorDir);
    assert.ok(targetAStat.isDirectory(), 'Target-A must have .ai-manager/director');

    // 2. Verify Target-B has its own .ai-manager state
    const targetBDirectorDir = path.join(targetDirB, '.ai-manager', 'director');
    const targetBStat = await fs.stat(targetBDirectorDir);
    assert.ok(targetBStat.isDirectory(), 'Target-B must have .ai-manager/director');

    // 3. Verify AIDM Server Repository .ai-manager did NOT receive target state
    const serverRepoCurrentInventory = await getDirInventory(path.join(serverRepoRoot, '.ai-manager'));
    assert.deepEqual(
      serverRepoCurrentInventory,
      serverRepoInitialInventory,
      'AIDM server repository .ai-manager must remain completely unmodified'
    );

    // 4. Verify target source code was NOT mutated (only the git baseline files we created)
    const targetAReadme = await fs.readFile(path.join(targetDirA, 'README.md'), 'utf-8');
    assert.ok(targetAReadme.includes('target-project-alpha'));
    const targetBReadme = await fs.readFile(path.join(targetDirB, 'README.md'), 'utf-8');
    assert.ok(targetBReadme.includes('target-project-beta'));
  });

  it('AC-18: verifies server shutdown and restart with configured root', async () => {
    // 1. Shutdown client
    const stopResult = await client.stop();
    assert.equal(stopResult.exitCode, 0);

    // 2. Restart server configured specifically for Target-A (-C targetDirA)
    const restartClient = new ExternalMcpClient({
      projectRoot: targetDirA,
    });
    await restartClient.start();
    assert.ok(restartClient.isRunning);

    await restartClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'restarted-client', version: '1.0.0' },
    });

    // 3. Query project status without arguments: resolves to configured Target-A
    const statusRes = await restartClient.request<{
      content: Array<{ type: string; text: string }>;
    }>('tools/call', {
      name: 'aidm.project.status',
      arguments: {},
    });
    assert.equal(statusRes.error, undefined);
    const status = JSON.parse(statusRes.result!.content[0].text);
    assert.equal(path.resolve(status.projectRoot), path.resolve(targetDirA));
    assert.equal(status.git.head, targetAHead);

    // 4. Clean shutdown of restart client
    const restartStop = await restartClient.stop();
    assert.equal(restartStop.exitCode, 0);
  });
});
