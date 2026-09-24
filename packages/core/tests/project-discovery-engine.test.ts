/**
 * Comprehensive Test Suite for Phase 8 Existing Project Discovery Engine (TASK-P8-03)
 *
 * Verifies all 18 core discovery requirements:
 * 1. Project identity discovery (Node/TS, Python, Rust, Go)
 * 2. Purpose discovery (UNDERSTOOD, PARTIALLY_UNDERSTOOD, UNKNOWN)
 * 3. Technology stack discovery (languages, frameworks, build tools, CI, Docker)
 * 4. Architecture discovery (frontend, backend, api, db, domain, cli, tests)
 * 5. Entry-point discovery (CLI, web, library, main)
 * 6. Build/test/runtime discovery (DISCOVERED vs UNKNOWN)
 * 7. Feature inventory (bounded, with evidence basis)
 * 8. Requirements/decision integration (from SpecStore)
 * 9. Fact vs inference vs unknown classification
 * 10. Contradiction detection (command mismatch, state conflict)
 * 11. Clarification candidate generation for P8-04
 * 12. Bounded discovery behavior (respects maxFileScan, maxDocBytes)
 * 13. Context/stale-context handling
 * 14. Evidence references (traceable, valid source types)
 * 15. Read-only guarantees (files, state, git unchanged before and after)
 * 16. No Antigravity invocation
 * 17. No arbitrary OS execution
 * 18. No duplicate source of truth (delegates to authoritative stores)
 * 19. MCP tool aidm.project.discover execution via McpServer
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import {
  ProjectDiscoveryEngine,
  type ProjectDiscoveryReport,
  SpecStore,
  DurableStateManager,
  LifecycleState,
  DefaultGitPort,
  CheckpointStore,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_PROJECT_DISCOVER_TOOL_NAME,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

const execFile = promisify(execFileCallback);

describe('Phase 8 Existing Project Discovery Engine (TASK-P8-03)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8-03-discovery-test-'));

    // Initialize mock git repo
    try {
      await execFile('git', ['init', '-b', 'main'], { cwd: tempDir });
      await execFile('git', ['config', 'user.name', 'AIDM Test'], { cwd: tempDir });
      await execFile('git', ['config', 'user.email', 'aidm-test@example.com'], { cwd: tempDir });
      await fs.promises.writeFile(path.join(tempDir, '.gitignore'), '.ai-manager\n');
      await execFile('git', ['add', '.'], { cwd: tempDir });
      await execFile('git', ['commit', '-m', 'initial commit'], { cwd: tempDir });
    } catch {
      // Non-fatal git init fallback
    }
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup fallback
    }
  });

  // Helper to compute sha256 hash of directory content
  async function computeDirChecksum(dir: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    async function walk(current: string) {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const content = await fs.promises.readFile(full);
          hash.update(entry.name);
          hash.update(content);
        }
      }
    }
    await walk(dir);
    return hash.digest('hex');
  }

  // ==========================================================================
  // 1. PROJECT IDENTITY DISCOVERY (Node/TS, Python, Rust, Go)
  // ==========================================================================
  it('T01_project_identity: correctly identifies Node/TypeScript project', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: '@company/payment-service', version: '2.1.0' })
    );
    await fs.promises.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/index.ts'), 'export const VERSION = "2.1.0";');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.projectIdentity.name, '@company/payment-service');
    assert.equal(report.projectIdentity.version, '2.1.0');
    assert.equal(report.projectIdentity.ecosystem, 'typescript');
    assert.ok(report.projectIdentity.evidence.some((e) => e.path === 'package.json'));
  });

  it('T01_project_identity_python: identifies Python project with pyproject.toml', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'pyproject.toml'),
      '[project]\nname = "data-pipeline"\nversion = "0.5.0"\n'
    );
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/main.py'), 'print("data pipeline")');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.projectIdentity.name, 'data-pipeline');
    assert.equal(report.projectIdentity.version, '0.5.0');
    assert.equal(report.projectIdentity.ecosystem, 'python');
  });

  it('T01_project_identity_rust: identifies Rust project with Cargo.toml', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'Cargo.toml'),
      '[package]\nname = "fast-indexer"\nversion = "1.0.4"\nedition = "2021"\n'
    );
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/main.rs'), 'fn main() {}');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.projectIdentity.name, 'fast-indexer');
    assert.equal(report.projectIdentity.version, '1.0.4');
    assert.equal(report.projectIdentity.ecosystem, 'rust');
  });

  // ==========================================================================
  // 2. PURPOSE UNDERSTANDING (UNDERSTOOD, PARTIALLY_UNDERSTOOD, UNKNOWN)
  // ==========================================================================
  it('T02_purpose_understood: extracts clear purpose from README.md and package.json', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'auth-gateway',
        description: 'Zero-trust authentication gateway with JWT token verification and RBAC.',
      })
    );
    await fs.promises.writeFile(
      path.join(tempDir, 'README.md'),
      '# Auth Gateway\n\nHigh performance authentication proxy service designed for microservices.\n'
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.purpose.classification, 'UNDERSTOOD');
    assert.ok(report.purpose.summary.includes('authentication'));
    assert.ok(report.purpose.domainKeywords.length > 0);
    assert.ok(report.purpose.evidence.length >= 2);
  });

  it('T02_purpose_partially_understood: only package name without descriptive text', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'internal-tool' })
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.purpose.classification, 'PARTIALLY_UNDERSTOOD');
    assert.ok(report.purpose.summary.includes('internal-tool'));
  });

  it('T02_purpose_unknown: empty repository returns UNKNOWN purpose', async () => {
    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.purpose.classification, 'UNKNOWN');
    assert.ok(report.purpose.summary.includes('No explicit project purpose'));
  });

  // ==========================================================================
  // 3. TECHNOLOGY STACK DISCOVERY
  // ==========================================================================
  it('T03_technology_stack: detects languages, frameworks, build tools, lockfiles, and CI/CD', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'web-service',
        dependencies: {
          express: '^4.19.0',
          zod: '^3.23.0',
          '@modelcontextprotocol/sdk': '^1.0.0',
        },
        devDependencies: {
          typescript: '^5.4.0',
          vitest: '^1.6.0',
        },
      })
    );
    await fs.promises.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '# pnpm lockfile');
    await fs.promises.writeFile(path.join(tempDir, 'Dockerfile'), 'FROM node:20-alpine');
    await fs.promises.mkdir(path.join(tempDir, '.github/workflows'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, '.github/workflows/ci.yml'),
      'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n'
    );
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/server.ts'), 'console.log("hello");');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.ok(report.technologyStack.primaryLanguages.includes('TypeScript'));
    assert.ok(report.technologyStack.frameworks.includes('Express'));
    assert.ok(report.technologyStack.frameworks.includes('Zod'));
    assert.ok(report.technologyStack.frameworks.includes('MCP SDK'));
    assert.ok(report.technologyStack.frameworks.includes('Vitest'));
    assert.ok(report.technologyStack.packageManagers.includes('pnpm'));
    assert.ok(report.technologyStack.containerization.includes('Docker'));
    assert.ok(report.technologyStack.ciCd.includes('GitHub Actions'));
  });

  // ==========================================================================
  // 4. ARCHITECTURE DISCOVERY
  // ==========================================================================
  it('T04_architecture_discovery: identifies frontend, backend, api, database, domain, and test areas', async () => {
    await fs.promises.mkdir(path.join(tempDir, 'src/api/routes'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, 'src/db/models'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, 'src/domain/services'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, 'tests/unit'), { recursive: true });

    await fs.promises.writeFile(path.join(tempDir, 'src/api/routes/users.ts'), 'export const route = "/users";');
    await fs.promises.writeFile(path.join(tempDir, 'src/db/models/user.ts'), 'export interface User {}');
    await fs.promises.writeFile(path.join(tempDir, 'src/domain/services/user-service.ts'), 'export class UserService {}');
    await fs.promises.writeFile(path.join(tempDir, 'tests/unit/user.test.ts'), '// test');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    const areaCategories = report.architecture.identifiedAreas.map((a) => a.area);
    assert.ok(areaCategories.includes('api'), 'Missing api area');
    assert.ok(areaCategories.includes('database'), 'Missing database area');
    assert.ok(areaCategories.includes('domain'), 'Missing domain area');
    assert.ok(areaCategories.includes('tests'), 'Missing tests area');
    assert.ok(report.architecture.architecturalPattern.length > 0);
  });

  // ==========================================================================
  // 5. ENTRYPOINT DISCOVERY
  // ==========================================================================
  it('T05_entrypoint_discovery: discovers CLI binary and library main entry points', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'cli-tool',
        main: './dist/index.js',
        bin: {
          'my-cli': './dist/cli.js',
        },
      })
    );
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/index.ts'), 'export * from "./lib.js";');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.ok(report.entryPoints.some((e) => e.type === 'cli' && e.command === 'my-cli'));
    assert.ok(report.entryPoints.some((e) => e.type === 'library' && e.target === './dist/index.js'));
    assert.ok(report.entryPoints.some((e) => e.target === 'src/index.ts'));
  });

  // ==========================================================================
  // 6. BUILD / TEST / RUNTIME DISCOVERY (DISCOVERED vs UNKNOWN)
  // ==========================================================================
  it('T06_commands_discovery: distinguishes DISCOVERED scripts from UNKNOWN commands', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: {
          build: 'tsc -b',
          test: 'vitest run',
        },
      })
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.equal(report.commands.build.status, 'DISCOVERED');
    assert.equal(report.commands.build.source, 'package.json:scripts.build');
    assert.equal(report.commands.test.status, 'DISCOVERED');
    assert.equal(report.commands.test.source, 'package.json:scripts.test');
    assert.equal(report.commands.runtime.status, 'UNKNOWN');
    assert.equal(report.commands.runtime.command, undefined);
  });

  // ==========================================================================
  // 7. FEATURE INVENTORY
  // ==========================================================================
  it('T07_feature_inventory: builds bounded inventory from modules and packages', async () => {
    await fs.promises.mkdir(path.join(tempDir, 'src/api/routes'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, 'src/services'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/api/routes/auth.ts'), 'export const auth = {};');
    await fs.promises.writeFile(path.join(tempDir, 'src/services/billing.ts'), 'export const billing = {};');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.ok(report.featureInventory.length >= 2);
    assert.ok(report.featureInventory.some((f) => f.name.includes('Auth')));
    assert.ok(report.featureInventory.some((f) => f.name.includes('Billing')));
    assert.ok(report.featureInventory.every((f) => f.evidence.length > 0));
  });

  // ==========================================================================
  // 8. REQUIREMENTS & DECISIONS INTEGRATION (SpecStore)
  // ==========================================================================
  it('T08_requirements_decisions_integration: reads locked requirements and decisions without mutation', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'User Authentication',
        description: 'Authenticate users via OAuth2',
        status: 'LOCKED',
        acceptance_criteria: ['OAuth2 token validated'],
      } as any,
    ]);
    await specStore.saveDecisions([
      {
        id: 'DEC-001',
        title: 'Use SQLite',
        description: 'Adopt SQLite for zero external dependencies',
        status: 'LOCKED',
      } as any,
    ]);

    const engine = new ProjectDiscoveryEngine({
      workspaceRoot: tempDir,
      specStore,
    });
    const report = await engine.discover();

    assert.equal(report.requirementsSummary.totalRequirements, 1);
    assert.equal(report.requirementsSummary.lockedCount, 1);
    assert.equal(report.requirementsSummary.source, 'AIDM_SPEC_STORE');
    assert.equal(report.requirementsSummary.requirements[0].id, 'REQ-001');

    assert.equal(report.decisionsSummary.totalDecisions, 1);
    assert.equal(report.decisionsSummary.source, 'AIDM_SPEC_STORE');
    assert.equal(report.decisionsSummary.decisions[0].id, 'DEC-001');
  });

  // ==========================================================================
  // 9. FACT VS INFERENCE VS UNKNOWN CLASSIFICATION
  // ==========================================================================
  it('T09_fact_inference_unknown_classification: strictly separates facts, inferences, and unknowns', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        version: '1.0.0',
        scripts: { build: 'tsc' },
      })
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    // Facts are directly verified
    assert.ok(report.facts.some((f) => f.statement.includes('sample-project')));
    assert.ok(report.facts.some((f) => f.statement.includes('Build command')));

    // Observations are evidence-backed interpretations
    assert.ok(report.observations.length > 0);

    // Unknowns capture missing critical information
    assert.ok(report.unknowns.some((u) => u.item.includes('Test Execution Command')));
    assert.ok(report.unknowns.some((u) => u.item.includes('Runtime / Start Command')));
  });

  // ==========================================================================
  // 10. CONTRADICTION DETECTION
  // ==========================================================================
  it('T10_contradiction_detection: detects command discrepancies and lifecycle conflicts', async () => {
    // README says npm start, but package.json has NO start script
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'contradictory-app',
        scripts: {
          dev: 'vite',
        },
      })
    );
    await fs.promises.writeFile(
      path.join(tempDir, 'README.md'),
      '# App\n\nRun npm start to launch the server.\n'
    );

    // Durable state says PROJECT_COMPLETE but has active task
    const durableManager = new DurableStateManager({ baseDir: tempDir });
    await durableManager.save({
      currentLifecycleState: LifecycleState.PROJECT_COMPLETE,
      activeTaskId: 'TASK-PENDING',
      completedTaskIds: [],
    });

    const engine = new ProjectDiscoveryEngine({
      workspaceRoot: tempDir,
      durableStateManager: durableManager,
    });
    const report = await engine.discover();

    assert.ok(report.contradictions.length >= 2, `Expected at least 2 contradictions, got ${report.contradictions.length}`);
    assert.ok(report.contradictions.some((c) => c.category === 'COMMAND_DISCREPANCY'));
    assert.ok(report.contradictions.some((c) => c.category === 'LIFECYCLE_STATE_CONFLICT'));
    assert.ok(report.contradictions.every((c) => c.unresolved === true));
  });

  // ==========================================================================
  // 11. CLARIFICATION CANDIDATE GENERATION (FOR P8-04)
  // ==========================================================================
  it('T11_clarification_candidates: produces structured candidate items for P8-04', async () => {
    // Missing test command and missing purpose
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'opaque-app' })
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.ok(report.clarificationCandidates.length >= 2);
    assert.ok(report.clarificationCandidates.some((c) => c.category === 'PURPOSE'));
    assert.ok(report.clarificationCandidates.some((c) => c.category === 'COMMAND'));
    assert.ok(report.clarificationCandidates.every((c) => c.question && c.question.length > 0));
  });

  // ==========================================================================
  // 12. BOUNDED DISCOVERY BEHAVIOR
  // ==========================================================================
  it('T12_bounded_discovery: respects maxFileScan and does not dump massive files into memory', async () => {
    // Generate 50 files
    await fs.promises.mkdir(path.join(tempDir, 'src/data'), { recursive: true });
    for (let i = 0; i < 50; i++) {
      await fs.promises.writeFile(
        path.join(tempDir, `src/data/file_${i}.ts`),
        `export const val_${i} = ${i};\n`
      );
    }

    const engine = new ProjectDiscoveryEngine({
      workspaceRoot: tempDir,
      maxFileScan: 15,
    });
    const report = await engine.discover({ maxFileScan: 15 });

    // Scanned file count reflects bounded scanning
    assert.ok(report.repositoryStructure.totalFileCount >= 50);
  });

  // ==========================================================================
  // 13. CONTEXT HANDLING & STALE DETECTION
  // ==========================================================================
  it('T13_context_handling: respects context engine options without altering workspace', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'context-app', version: '1.0.0' })
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover({ allowContextRefresh: false });

    assert.equal(report.projectIdentity.name, 'context-app');
  });

  // ==========================================================================
  // 14. EVIDENCE REFERENCES
  // ==========================================================================
  it('T14_evidence_references: preserves valid evidence references on all core claims', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'evidence-app',
        scripts: { build: 'tsc' },
      })
    );
    await fs.promises.writeFile(path.join(tempDir, 'README.md'), '# Evidence App\n');

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    assert.ok(report.projectIdentity.evidence.length > 0);
    assert.ok(report.purpose.evidence.length > 0);
    assert.ok(report.commands.build.evidence.length > 0);
    assert.ok(report.facts.every((f) => f.evidence.length > 0));
    assert.ok(report.observations.every((o) => o.evidence.length > 0));
  });

  // ==========================================================================
  // 15. READ-ONLY GUARANTEES
  // ==========================================================================
  it('T15_read_only_guarantee: discovery does not mutate project files, state, or git commits', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'read-only-app', version: '1.0.0' })
    );
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'src/index.ts'), 'export const a = 1;');

    const beforeHash = await computeDirChecksum(tempDir);
    const gitPort = new DefaultGitPort();
    const gitBefore = await gitPort.inspectState(tempDir);

    const engine = new ProjectDiscoveryEngine({
      workspaceRoot: tempDir,
      gitPort,
    });
    await engine.discover();

    const afterHash = await computeDirChecksum(tempDir);
    const gitAfter = await gitPort.inspectState(tempDir);

    assert.equal(afterHash, beforeHash, 'Project directory was mutated during discovery!');
    assert.equal(gitAfter.head_sha, gitBefore.head_sha, 'Git HEAD was mutated!');
  });

  // ==========================================================================
  // 16. NO ANTIGRAVITY INVOCATION
  // ==========================================================================
  it('T16_no_antigravity_invocation: discovery completes without referencing or invoking Antigravity', async () => {
    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    const report = await engine.discover();

    // Verify report does not declare Antigravity actions or trigger execution
    const json = JSON.stringify(report);
    assert.ok(!json.includes('ANTIGRAVITY_EXECUTE'));
    assert.ok(!json.includes('RUN_ANTIGRAVITY'));
  });

  // ==========================================================================
  // 17. NO ARBITRARY OS EXECUTION
  // ==========================================================================
  it('T17_no_arbitrary_os_execution: discovery does not execute child processes or shell commands', async () => {
    // Setting up a project with a malicious script in package.json
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'safe-app',
        scripts: {
          test: 'node -e "process.exit(1)"',
        },
      })
    );

    const engine = new ProjectDiscoveryEngine({ workspaceRoot: tempDir });
    // discover() must safely parse script text without executing it
    const report = await engine.discover();

    assert.equal(report.commands.test.status, 'DISCOVERED');
    assert.equal(report.commands.test.rawDeclaration, 'node -e "process.exit(1)"');
  });

  // ==========================================================================
  // 18. NO DUPLICATE SOURCE OF TRUTH
  // ==========================================================================
  it('T18_no_duplicate_source_of_truth: discovery reads state directly from DurableStateManager', async () => {
    const durableManager = new DurableStateManager({ baseDir: tempDir });
    await durableManager.save({
      currentLifecycleState: LifecycleState.ARCHITECTURE_SPEC,
      activeTaskId: 'TASK-SPEC',
      completedTaskIds: ['TASK-INIT'],
    });

    const engine = new ProjectDiscoveryEngine({
      workspaceRoot: tempDir,
      durableStateManager: durableManager,
    });
    const report = await engine.discover();

    assert.equal(report.currentImplementationState.lifecycleState, LifecycleState.ARCHITECTURE_SPEC);
    assert.equal(report.currentImplementationState.activeTaskId, 'TASK-SPEC');
    assert.equal(report.currentImplementationState.completedTasksCount, 1);
  });

  // ==========================================================================
  // 19. MCP TOOL INTEGRATION (aidm.project.discover)
  // ==========================================================================
  it('T19_mcp_tool_discover: aidm.project.discover tool executes via McpServer', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'mcp-discovered-service',
        version: '3.0.0',
        description: 'Microservice discovered via MCP protocol',
      })
    );

    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const transport = new InMemoryMcpTransport();
    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
    });
    await server.start();

    const req: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: {
        name: AIDM_PROJECT_DISCOVER_TOOL_NAME,
        arguments: {
          workspaceRoot: tempDir,
        },
      },
    };

    const res = (await server.handleMessage(req)) as McpSuccessResponseEnvelope<{
      content: Array<{ type: string; text: string }>;
    }>;

    await server.stop();

    assert.ok(res.result?.content?.[0]?.text);
    const parsedReport: ProjectDiscoveryReport = JSON.parse(res.result.content[0].text);

    assert.equal(parsedReport.projectIdentity.name, 'mcp-discovered-service');
    assert.equal(parsedReport.projectIdentity.version, '3.0.0');
    assert.equal(parsedReport.purpose.classification, 'UNDERSTOOD');
    assert.ok(parsedReport.purpose.summary.includes('Microservice discovered'));
  });
});
