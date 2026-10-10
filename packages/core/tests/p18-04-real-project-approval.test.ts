import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { ExternalMcpClient } from './helpers/external-mcp-client.ts';
import { ApprovalPackageEngine, ApprovalStore } from '../dist/approval/index.js';
import { ExecutionAuthorizer } from '../dist/director/execution-authorizer.js';

const execFile = promisify(execFileCallback);

/**
 * Helper to scan directory tree files for state isolation checks.
 */
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

/**
 * Initializes a realistic early-stage target project with material ambiguities.
 */
async function createTargetProject(projectDir: string, projectName: string, description: string): Promise<string> {
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });

  const readmeContent = `# ${projectName}

## Overview
${description}

## Architecture & Requirements (Draft)
1. **Core Service Capabilities**: Must implement baseline domain workflows.
2. **Security & Authentication**: Needs explicit authentication model (API Key vs JWT).
3. **Data Storage**: Must persist domain state and transaction logs (PostgreSQL vs Redis).
4. **Resilience**: Retry mechanism with backoff for network operations.
5. **Business Rules**:
   - Critical priority transactions bypass routine delays.
   - Non-critical messages observe recipient quiet hours.

## Initial Status
Baseline initialization.
`;

  await fs.writeFile(path.join(projectDir, 'README.md'), readmeContent, 'utf-8');
  await fs.writeFile(
    path.join(projectDir, '.gitignore'),
    `.ai-manager/\nPROJECT_SPEC.md\nnode_modules/\ndist/\n`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: projectName,
        version: '0.1.0',
        description,
        main: 'src/index.ts',
        scripts: {
          test: 'node --test',
        },
      },
      null,
      2
    ),
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, 'src/index.ts'),
    `export class ServiceEngine {\n  async execute(): Promise<{ status: string }> {\n    return { status: 'idle' };\n  }\n}\n`,
    'utf-8'
  );

  await execFile('git', ['init'], { cwd: projectDir });
  await execFile('git', ['config', 'user.name', 'P18 Director'], { cwd: projectDir });
  await execFile('git', ['config', 'user.email', 'director@aidm.test'], { cwd: projectDir });
  await execFile('git', ['add', '.'], { cwd: projectDir });
  await execFile('git', ['commit', '-m', `Initial commit for ${projectName}`], { cwd: projectDir });

  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
  return stdout.trim();
}

describe('P18-04: Completeness Gate & Product Owner Approval Boundary via Real MCP', { concurrency: 1 }, () => {
  let targetADir: string;
  let targetAGitHead: string;
  const projectAName = 'notification-dispatch-service';

  let targetBDir: string;
  let targetBGitHead: string;
  const projectBName = 'payment-gateway-service';

  let serverRepoRoot: string;
  let serverInitialInventory: string[];
  let client: ExternalMcpClient;

  // Stored state across steps
  let directorSessionId: string;
  let discoveryRev1: any;
  let discoveryRev2: any;
  let completenessResult: any;
  let projectSpecPayload: any;
  let approvalPackage: any;

  before(async () => {
    serverRepoRoot = path.resolve(import.meta.dirname, '../../..');
    serverInitialInventory = await getDirInventory(path.join(serverRepoRoot, '.ai-manager'));

    // Create isolated Target-A project outside AIDM server repo
    const tempRootA = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p18-04-target-a-'));
    targetADir = path.join(tempRootA, projectAName);
    targetAGitHead = await createTargetProject(
      targetADir,
      projectAName,
      'An online web notification dispatcher service with user auth, quiet hours, and persistence.'
    );

    // Create isolated Target-B project for cross-project isolation tests
    const tempRootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p18-04-target-b-'));
    targetBDir = path.join(tempRootB, projectBName);
    targetBGitHead = await createTargetProject(
      targetBDir,
      projectBName,
      'A payment processing service with card tokenization and ledger entries.'
    );

    assert.ok(targetAGitHead.length === 40, 'Target-A must have valid Git HEAD');
    assert.ok(targetBGitHead.length === 40, 'Target-B must have valid Git HEAD');
    assert.notEqual(path.resolve(targetADir), path.resolve(serverRepoRoot));
    assert.notEqual(path.resolve(targetBDir), path.resolve(serverRepoRoot));

    // Start ExternalMcpClient bound to Target-A
    client = new ExternalMcpClient({
      projectRoot: targetADir,
    });
    await client.start();
  });

  after(async () => {
    if (client && client.isRunning) {
      await client.stop();
    }
    try {
      await fs.rm(path.dirname(targetADir), { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      await fs.rm(path.dirname(targetBDir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // STEP 1 — BASELINE INSPECTION
  // ==========================================================================
  it('STEP 1: verifies baseline environment, Git status, and zero execution state via Real MCP', async () => {
    assert.ok(client.isRunning, 'MCP server process must be running');
    assert.notEqual(client.serverPid, client.clientPid, 'Server and client must be distinct OS processes');

    // 1. MCP initialize handshake
    const initRes = await client.request<{ serverInfo: { name: string } }>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'p18-04-po-approval-client', version: '1.0.0' },
    });
    assert.equal(initRes.result?.serverInfo?.name, 'aidm-mcp-server');
    await client.notify('notifications/initialized');

    // 2. Director session creation
    const sessionRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.director.session.create',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        actor: 'DIRECTOR',
        actorRole: 'PROJECT_DIRECTOR',
      },
    });
    assert.ok(sessionRes.result?.content?.[0]?.text);
    const sessionPayload = JSON.parse(sessionRes.result.content[0].text);
    assert.equal(sessionPayload.projectId, projectAName);
    assert.equal(sessionPayload.status, 'ACTIVE');
    assert.ok(sessionPayload.directorSessionId);
    directorSessionId = sessionPayload.directorSessionId;

    // 3. Git status via MCP
    const gitRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.git.status',
      arguments: { workspaceRoot: targetADir },
    });
    const gitPayload = JSON.parse(gitRes.result!.content[0].text);
    assert.equal(gitPayload.head, targetAGitHead);
    assert.equal(gitPayload.workingTreeClean, true);

    // 4. Task state inspection: verify 0 tasks and no activeTaskId
    const taskRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.tasks.list',
      arguments: {},
    });
    const taskPayload = JSON.parse(taskRes.result!.content[0].text);
    assert.equal(taskPayload.tasks.length, 0, 'Baseline task count must be 0');

    // 5. Driver state inspection: verify not running
    const driverRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'driver.status',
      arguments: { workspaceRoot: targetADir, projectId: projectAName },
    });
    const driverPayload = JSON.parse(driverRes.result!.content[0].text);
    assert.equal(driverPayload.driverState, null, 'Driver state must be null at baseline');
    assert.equal(driverPayload.isLocked, false, 'Driver lock must be false at baseline');
  });

  // ==========================================================================
  // STEP 2 — DISCOVERY TO COMPLETE SPECIFICATION GATE
  // ==========================================================================
  it('STEP 2: initial discovery detects material ambiguities; progressive refinement reaches genuinely COMPLETE gate', async () => {
    // 1. Initial discovery with natural language intent from Product Owner (storage unstated)
    const disc1Res = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        prompt: 'Develop an online web notification service using TypeScript with user auth and local deployment.',
      },
    });
    assert.ok(disc1Res.result?.content?.[0]?.text);
    discoveryRev1 = JSON.parse(disc1Res.result.content[0].text);
    assert.equal(discoveryRev1.discoveryRevision, 1);
    assert.ok(discoveryRev1.openQuestions.length > 0, 'Rev 1 must detect open questions');
    assert.ok(discoveryRev1.decisions.length > 0, 'Rev 1 must detect human decision points');

    // Verify Test A: Qualitative NFR does NOT receive invented numeric thresholds
    const disc1Nfr = discoveryRev1.sections.nonFunctionalRequirements;
    assert.ok(
      disc1Nfr.performance.some((p: string) => p.includes('Low-latency') && !p.includes('150ms') && !p.includes('<')),
      'Qualitative NFR must not receive invented numeric threshold'
    );
    assert.ok(
      disc1Nfr.reliability.some((r: string) => r.includes('Resilient') && !r.includes('5s')),
      'Reliability NFR must not receive invented numeric threshold'
    );
    assert.ok(
      disc1Nfr.availability.some((a: string) => a.includes('Graceful') && !a.includes('99.9%')),
      'Availability NFR must not receive invented numeric threshold'
    );

    // Verify Test D: PENDING human decision cannot become DECIDED automatically
    for (const d of discoveryRev1.decisions) {
      assert.ok(
        ['PENDING_DECISION', 'PROPOSED', 'OPEN', 'UNDECIDED'].includes(d.status),
        `Pending human decision must not be auto-decided (got: ${d.status})`
      );
      assert.notEqual(d.status, 'DECIDED', 'Pending human decision must not be auto-decided');
      assert.notEqual(d.status, 'CONFIRMED', 'Pending human decision must not be auto-decided');
    }

    // 2. Initial Completeness Gate evaluation: must NOT be COMPLETE (Test B: Missing threshold -> not complete)
    const gate1Res = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.specification.completeness.evaluate',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        discoveryRevision: 1,
      },
    });
    assert.ok(gate1Res.result?.content?.[0]?.text);
    const gate1Payload = JSON.parse(gate1Res.result.content[0].text);
    assert.notEqual(gate1Payload.status, 'COMPLETE', 'Initial discovery with open questions/HDPs/missing thresholds must not be COMPLETE');
    assert.equal(gate1Payload.isEligibleForApproval, false, 'Initial gate must NOT be eligible for approval');

    // 3. Progressive refinement: Product Owner explicitly supplies quantitative thresholds, answers, and decisions
    const resolvedAnswers: Record<string, string> = {};
    for (const q of discoveryRev1.openQuestions) {
      resolvedAnswers[q.id] = (q.options && q.options.length > 0) ? q.options[0] : 'Standard resolution for ' + q.question;
    }
    const decidedHumanDecisions: Record<string, string> = {};
    for (const d of discoveryRev1.decisions) {
      decidedHumanDecisions[d.id] = (d.alternatives && d.alternatives.length > 0) ? d.alternatives[0] : 'Decided alternative';
    }

    const disc2Res = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        prompt: 'Develop an online web notification service with low latency (< 100ms round-trip), resilient connections (5s heartbeat interval), high availability (99.9% uptime target), secure auth with 100% token verification rate, TypeScript, PostgreSQL database storage, and local deployment (< 5s healthcheck response).',
        resolvedAnswers,
        decidedHumanDecisions,
      },
    });
    assert.ok(disc2Res.result?.content?.[0]?.text);
    discoveryRev2 = JSON.parse(disc2Res.result.content[0].text);
    assert.equal(discoveryRev2.discoveryRevision, 2);
    assert.equal(discoveryRev2.previousRevision, 1);

    // Verify Test E: Explicitly decided human decision remains DECIDED
    for (const d of discoveryRev2.decisions) {
      if (decidedHumanDecisions[d.id]) {
        assert.ok(
          d.status === 'DECIDED' || d.status === 'CONFIRMED',
          `Explicitly decided human decision must remain DECIDED or CONFIRMED (got: ${d.status})`
        );
      }
    }

    // 4. Derive authoritative downstream specifications bound to Discovery Rev 2
    // 4a. Requirements & Scope
    const reqRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.requirements.scope.define',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2.fingerprint,
      },
    });
    const reqPayload = JSON.parse(reqRes.result!.content[0].text);
    assert.equal(reqPayload.requirementsRevision, 1);

    // 4b. Architecture & Technology
    const archRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.architecture.technology.define',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: reqPayload.fingerprint,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2.fingerprint,
      },
    });
    const archPayload = JSON.parse(archRes.result!.content[0].text);
    assert.equal(archPayload.architectureRevision, 1);

    // 4c. Business Rules
    const brRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.business-rules.define',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: reqPayload.fingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: archPayload.fingerprint,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2.fingerprint,
      },
    });
    const brPayload = JSON.parse(brRes.result!.content[0].text);
    assert.equal(brPayload.businessRulesRevision, 1);

    // 4d. Acceptance Criteria
    const acRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.acceptance-criteria.define',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: reqPayload.fingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: archPayload.fingerprint,
        businessRulesRevision: 1,
        expectedBusinessRulesFingerprint: brPayload.fingerprint,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2.fingerprint,
      },
    });
    const acPayload = JSON.parse(acRes.result!.content[0].text);
    assert.equal(acPayload.acceptanceCriteriaRevision, 1);

    // 4e. Risks & Human Decision Points
    const riskRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.risks.define',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2.fingerprint,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: reqPayload.fingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: archPayload.fingerprint,
        businessRulesRevision: 1,
        expectedBusinessRulesFingerprint: brPayload.fingerprint,
        acceptanceCriteriaRevision: 1,
        expectedAcceptanceCriteriaFingerprint: acPayload.fingerprint,
      },
    });
    const riskPayload = JSON.parse(riskRes.result!.content[0].text);
    assert.equal(riskPayload.riskRevision, 1);

    // Verify Test F: DECIDED human decision does not resurrect as pending HDP
    const decidedDiscoveryTitles = new Set(
      discoveryRev2.decisions
        .filter((d: any) => d.status === 'DECIDED' || d.status === 'CONFIRMED')
        .map((d: any) => d.title)
    );
    const resurrectedHdps = (riskPayload.humanDecisionPoints ?? []).filter(
      (h: any) => h.status === 'PENDING_DECISION' && decidedDiscoveryTitles.has(h.title)
    );
    assert.equal(resurrectedHdps.length, 0, 'DECIDED human decision does not resurrect as pending HDP');

    // 4f. Specification Completeness Gate Evaluation
    const gate2Res = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.specification.completeness.evaluate',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        discoveryRevision: 2,
        forceReevaluate: true,
      },
    });
    assert.ok(gate2Res.result?.content?.[0]?.text);
    completenessResult = JSON.parse(gate2Res.result.content[0].text);
    assert.equal(completenessResult.status, 'COMPLETE', 'Completeness Gate must evaluate strictly to COMPLETE');
    assert.equal(completenessResult.isEligibleForApproval, true, 'COMPLETE gate must be eligible for approval');
    assert.equal(completenessResult.humanDecisions.length, 0, 'No pending HDPs may remain in COMPLETE gate');
    assert.equal(completenessResult.blockingQuestions.length, 0, 'No blocking questions may remain in COMPLETE gate');

    // 4g. ProjectSpec projection
    const specRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project-spec.generate',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2.fingerprint,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: reqPayload.fingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: archPayload.fingerprint,
        businessRulesRevision: 1,
        expectedBusinessRulesFingerprint: brPayload.fingerprint,
        acceptanceCriteriaRevision: 1,
        expectedAcceptanceCriteriaFingerprint: acPayload.fingerprint,
        riskRevision: 1,
        expectedRiskFingerprint: riskPayload.fingerprint,
      },
    });
    assert.ok(specRes.result?.content?.[0]?.text);
    projectSpecPayload = JSON.parse(specRes.result.content[0].text);
    assert.equal(projectSpecPayload.specRevision, 1);
    assert.equal(projectSpecPayload.isStale, false);
    assert.ok(projectSpecPayload.semanticFingerprint);
  });

  // ==========================================================================
  // STEP 3 — APPROVAL PACKAGE CREATION & READINESS EVALUATION
  // ==========================================================================
  it('STEP 3: creates authoritative ApprovalPackage and evaluates readiness (READY_FOR_APPROVAL, developmentAuthorized=false)', async () => {
    // 1. Create ApprovalPackage via MCP tool
    const createPkgRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.create',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
      },
    });
    assert.ok(createPkgRes.result?.content?.[0]?.text);
    approvalPackage = JSON.parse(createPkgRes.result.content[0].text);
    assert.equal(approvalPackage.projectId, projectAName);
    assert.equal(approvalPackage.revision, 1);
    assert.equal(approvalPackage.status, 'READY_FOR_APPROVAL');
    assert.equal(approvalPackage.isStale, false);
    assert.ok(approvalPackage.packageFingerprint);
    assert.ok(approvalPackage.sourceBindings);
    assert.equal(approvalPackage.sourceBindings.discoveryRevision, 2);
    assert.equal(approvalPackage.sourceBindings.requirementsRevision, 1);
    assert.equal(approvalPackage.sourceBindings.architectureRevision, 1);
    assert.equal(approvalPackage.sourceBindings.businessRulesRevision, 1);
    assert.equal(approvalPackage.sourceBindings.acceptanceCriteriaRevision, 1);
    assert.equal(approvalPackage.sourceBindings.riskRevision, 1);
    assert.equal(approvalPackage.sourceBindings.specRevision, 1);
    assert.equal(approvalPackage.sourceBindings.completenessFingerprint, completenessResult.fingerprint);

    // 2. Query Readiness via MCP tool
    const readyRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.readiness',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
      },
    });
    assert.ok(readyRes.result?.content?.[0]?.text);
    const readyPayload = JSON.parse(readyRes.result.content[0].text);
    assert.equal(readyPayload.currentStatus, 'READY_FOR_APPROVAL');
    assert.equal(readyPayload.readiness.isReady, true);
    assert.equal(readyPayload.readiness.status, 'READY_FOR_APPROVAL');
    assert.equal(readyPayload.isDevelopmentAuthorized, false, 'developmentAuthorized MUST be false before PO approval');
  });

  // ==========================================================================
  // STEP 4 — NEGATIVE APPROVAL TESTS (FAIL-CLOSED BOUNDARIES)
  // ==========================================================================
  it('STEP 4: verifies all negative approval attempts fail closed (Director, Executor, SYSTEM, natural language, mismatched revision)', async () => {
    // A) Director attempts approval (actor = DIRECTOR)
    const directorApprove = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
        revision: 1,
        actor: 'DIRECTOR',
        actorRole: 'DIRECTOR',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.ok(
      directorApprove.error !== undefined ||
        (directorApprove.result?.content?.[0]?.text &&
          JSON.parse(directorApprove.result.content[0].text).error !== undefined),
      'Director approval attempt must fail closed'
    );

    // B) Executor / Antigravity attempts approval
    const executorApprove = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
        revision: 1,
        actor: 'ANTIGRAVITY_EXECUTOR',
        actorRole: 'EXECUTOR',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.ok(
      executorApprove.error !== undefined ||
        (executorApprove.result?.content?.[0]?.text &&
          JSON.parse(executorApprove.result.content[0].text).error !== undefined),
      'Executor/Antigravity approval attempt must fail closed'
    );

    // C) SYSTEM / ORCHESTRATOR attempts approval
    const systemApprove = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
        revision: 1,
        actor: 'SYSTEM',
        actorRole: 'SYSTEM',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.ok(
      systemApprove.error !== undefined ||
        (systemApprove.result?.content?.[0]?.text &&
          JSON.parse(systemApprove.result.content[0].text).error !== undefined),
      'SYSTEM approval attempt must fail closed'
    );

    // D) Natural language approval attempts ("tamam", "tamam devam et", "devam et", "onay", "onaylıyorum")
    const naturalIntents = ['tamam', 'tamam devam et', 'devam et', 'onay', 'onaylıyorum'];
    for (const natIntent of naturalIntents) {
      const natApprove = await client.request<{
        content?: Array<{ text: string }>;
        error?: { message: string };
      }>('tools/call', {
        name: 'aidm.approval.package.approve',
        arguments: {
          workspaceRoot: targetADir,
          projectId: projectAName,
          packageId: approvalPackage.packageId,
          revision: 1,
          actor: 'Human Product Owner',
          actorRole: 'PRODUCT_OWNER',
          intent: natIntent,
        },
      });
      assert.ok(
        natApprove.error !== undefined ||
          (natApprove.result?.content?.[0]?.text &&
            JSON.parse(natApprove.result.content[0].text).error !== undefined),
        `Natural language intent '${natIntent}' must fail closed`
      );
    }

    // E) Clarification answer: answering clarification does NOT authorize development
    // Create clarification session and answer a question
    const clarifRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.clarification.session.create',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
      },
    });
    const clarifSession = JSON.parse(clarifRes.result!.content[0].text);
    if (clarifSession.questions && clarifSession.questions.length > 0) {
      await client.request<{ content: Array<{ text: string }> }>('tools/call', {
        name: 'aidm.clarification.session.answer',
        arguments: {
          workspaceRoot: targetADir,
          sessionId: clarifSession.sessionId,
          clarificationId: clarifSession.questions[0].clarificationId,
          answerType: 'FREE_FORM',
          freeFormResponse: 'Clarification answer without approval authority',
          source: 'HUMAN',
          status: 'ANSWERED',
        },
      });
    }

    // F) Director session decision: does NOT authorize development
    // (Director session remains active, but does not grant development authorization)

    // G) Stale / mismatched revision (package revision is 1, caller requests revision 999)
    const mismatchedApprove = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
        revision: 999,
        actor: 'Human Product Owner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.ok(
      mismatchedApprove.error !== undefined ||
        (mismatchedApprove.result?.content?.[0]?.text &&
          JSON.parse(mismatchedApprove.result.content[0].text).error !== undefined),
      'Mismatched approval revision must fail closed'
    );

    // H) Masquerade attacks: Forbidden actors claiming actorRole = PRODUCT_OWNER
    const forbiddenActors = ['DIRECTOR', 'ANTIGRAVITY', 'SYSTEM', 'EXECUTOR', 'ORCHESTRATOR'];
    for (const fActor of forbiddenActors) {
      const masqueradeRes = await client.request<{
        content?: Array<{ text: string }>;
        error?: { message: string };
      }>('tools/call', {
        name: 'aidm.approval.package.approve',
        arguments: {
          workspaceRoot: targetADir,
          projectId: projectAName,
          packageId: approvalPackage.packageId,
          revision: 1,
          actor: fActor,
          actorRole: 'PRODUCT_OWNER',
          intent: 'EXPLICIT_APPROVAL',
        },
      });
      assert.ok(
        masqueradeRes.error !== undefined ||
          (masqueradeRes.result?.content?.[0]?.text &&
            JSON.parse(masqueradeRes.result.content[0].text).error !== undefined),
        `Masquerade attack with actor='${fActor}' claiming actorRole='PRODUCT_OWNER' must fail closed`
      );
    }

    // I) Forged / non-existent package ID
    const forgedPkgRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: 'forged-non-existent-package-id',
        revision: 1,
        actor: 'Human Product Owner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.ok(
      forgedPkgRes.error !== undefined ||
        (forgedPkgRes.result?.content?.[0]?.text &&
          JSON.parse(forgedPkgRes.result.content[0].text).error !== undefined),
      'Approval for forged/non-existent package ID must fail closed'
    );

    // Verify developmentAuthorized is STILL strictly false after all negative tests
    const readyVerify = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.readiness',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
      },
    });
    const readyVerifyPayload = JSON.parse(readyVerify.result!.content[0].text);
    assert.equal(readyVerifyPayload.isDevelopmentAuthorized, false, 'developmentAuthorized MUST remain false after negative tests');
  });

  // ==========================================================================
  // STEP 5 — REAL PRODUCT OWNER APPROVAL
  // ==========================================================================
  it('STEP 5: submits explicit human Product Owner approval bound to exact revision via canonical MCP tool', async () => {
    const approveRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
        revision: 1,
        actor: 'Canonical Product Owner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
        comment: 'Formal Product Owner approval granted for baseline scope.',
        timestamp: new Date().toISOString(),
      },
    });

    assert.ok(approveRes.result?.content?.[0]?.text);
    const approvedPayload = JSON.parse(approveRes.result.content[0].text);
    assert.equal(approvedPayload.status, 'APPROVED');
    assert.ok(approvedPayload.approvalRecord);
    assert.equal(approvedPayload.approvalRecord.actor, 'Canonical Product Owner');
    assert.equal(approvedPayload.approvalRecord.actorRole, 'PRODUCT_OWNER');
    assert.equal(approvedPayload.approvalRecord.intent, 'EXPLICIT_APPROVAL');
    assert.equal(approvedPayload.approvalRecord.revision, 1);
    assert.equal(approvedPayload.approvalRecord.packageHash, approvalPackage.packageFingerprint);

    // Verify history event appended
    assert.ok(approvedPayload.history.some((h: any) => h.eventType === 'APPROVAL_EXPLICITLY_GRANTED'));

    // Replay attack check: Re-submitting approval on an already approved package must fail closed
    const replayApproveRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
        revision: 1,
        actor: 'Canonical Product Owner',
        actorRole: 'PRODUCT_OWNER',
        intent: 'EXPLICIT_APPROVAL',
      },
    });
    assert.ok(
      replayApproveRes.error !== undefined ||
        (replayApproveRes.result?.content?.[0]?.text &&
          JSON.parse(replayApproveRes.result.content[0].text).error !== undefined),
      'Replay attack: Re-submitting approval on already approved package must fail closed'
    );
  });

  // ==========================================================================
  // STEP 6 — POST-APPROVAL VERIFICATION & ZERO ACCIDENTAL EXECUTION
  // ==========================================================================
  it('STEP 6: verifies status=APPROVED, developmentAuthorized=true, zero tasks, zero driver execution, and untouched source', async () => {
    // 1. Re-read approval package via MCP
    const getRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.get',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
      },
    });
    const getPayload = JSON.parse(getRes.result!.content[0].text);
    assert.equal(getPayload.status, 'APPROVED');
    assert.equal(getPayload.isStale, false);

    // 2. Re-read readiness via MCP
    const readyRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.readiness',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
      },
    });
    const readyPayload = JSON.parse(readyRes.result!.content[0].text);
    assert.equal(readyPayload.currentStatus, 'APPROVED');
    assert.equal(readyPayload.isDevelopmentAuthorized, true, 'developmentAuthorized MUST become true after PO approval');

    // 3. Verify ZERO tasks created
    const taskRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.tasks.list',
      arguments: {},
    });
    const taskPayload = JSON.parse(taskRes.result!.content[0].text);
    assert.equal(taskPayload.tasks.length, 0, 'No tasks must be created upon approval');

    // 4. Verify Autonomous Driver is NOT running
    const driverRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'driver.status',
      arguments: { workspaceRoot: targetADir, projectId: projectAName },
    });
    const driverPayload = JSON.parse(driverRes.result!.content[0].text);
    assert.equal(driverPayload.driverState, null, 'Driver must not be started');
    assert.equal(driverPayload.isLocked, false, 'Driver lock must not be held');

    // 5. Verify Git status is clean and source files are not modified
    const gitRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.git.status',
      arguments: { workspaceRoot: targetADir },
    });
    const gitPayload = JSON.parse(gitRes.result!.content[0].text);
    assert.equal(gitPayload.head, targetAGitHead);
    assert.equal(gitPayload.workingTreeClean, true);

    const sourceContent = await fs.readFile(path.join(targetADir, 'src', 'index.ts'), 'utf-8');
    assert.ok(sourceContent.includes('idle'), 'Source code must not be altered');
  });

  // ==========================================================================
  // STEP 7 — APPROVAL IMMUTABILITY & REVISION STALENESS TEST
  // ==========================================================================
  it('STEP 7: upstream artifact modification invalidates prior approval (isStale=true, developmentAuthorized=false)', async () => {
    // Modify upstream authoritative discovery by executing a new discovery revision (Revision 3)
    const disc3Res = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        prompt: 'Add WebSocket push notification capability as new requirement.',
      },
    });
    const disc3Payload = JSON.parse(disc3Res.result!.content[0].text);
    assert.equal(disc3Payload.discoveryRevision, 3, 'Discovery should advance to revision 3');

    // Authoritative check BEFORE calling any readiness tool (Test G):
    // The approval package becomes unauthorized immediately because upstream revision changed.
    const targetApprovalStore = new ApprovalStore({ baseDir: targetADir });
    const targetEngine = new ApprovalPackageEngine();

    const directAuthStatus = await targetEngine.isDevelopmentAuthorizedAsync(approvalPackage);
    assert.equal(
      directAuthStatus,
      false,
      'Test G: Approved package must become unauthorized immediately after upstream revision WITHOUT calling readiness'
    );

    // Test H: Approved package remains unauthorized after process restart when upstream revision is stale
    const freshApprovalStore = new ApprovalStore({ baseDir: targetADir });
    const freshEngine = new ApprovalPackageEngine();
    const restartedAuthStatus = await freshEngine.isDevelopmentAuthorizedAsync(approvalPackage);
    assert.equal(
      restartedAuthStatus,
      false,
      'Test H: Freshly initialized engine (simulating restart) must recognize stale state and reject authorization'
    );

    // Re-read approval package: staleness check detects discovery revision mismatch
    const getRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.get',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
      },
    });
    const getPayload = JSON.parse(getRes.result!.content[0].text);
    assert.equal(getPayload.isStale, true, 'Approval package must be marked isStale=true when upstream changes');
    assert.ok(getPayload.staleReport.reasons.length > 0);

    // Re-read readiness: development authorization must FAIL CLOSED
    const readyRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.approval.package.readiness',
      arguments: {
        workspaceRoot: targetADir,
        projectId: projectAName,
        packageId: approvalPackage.packageId,
      },
    });
    const readyPayload = JSON.parse(readyRes.result!.content[0].text);
    assert.equal(readyPayload.readiness.status, 'STALE');
    assert.equal(readyPayload.readiness.isReady, false);
    assert.equal(
      readyPayload.isDevelopmentAuthorized,
      false,
      'Stale package must NOT retain development authorization'
    );
  });

  // ==========================================================================
  // STEP 8 — CROSS-PROJECT ISOLATION
  // ==========================================================================
  it('STEP 8: verifies Target-B does not inherit Target-A approval and approval states remain strictly isolated', async () => {
    // Query Target-B for approval package
    const targetBRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.get',
      arguments: {
        workspaceRoot: targetBDir,
        projectId: projectBName,
      },
    });

    // Target-B has never had an approval package created, so it must error or report none
    assert.ok(
      targetBRes.error !== undefined ||
        (targetBRes.result?.content?.[0]?.text &&
          JSON.parse(targetBRes.result.content[0].text).error !== undefined),
      'Target-B must not inherit Target-A approval package'
    );

    // Verify Target-A approval records exist ONLY in Target-A filesystem
    const targetAApprovalFiles = await fs
      .readdir(path.join(targetADir, '.ai-manager', 'approval', 'packages'))
      .catch(() => []);
    assert.ok(targetAApprovalFiles.length > 0, 'Target-A must have saved approval package');

    const targetBApprovalDirExists = await fs
      .access(path.join(targetBDir, '.ai-manager', 'approval'))
      .then(() => true)
      .catch(() => false);
    assert.equal(targetBApprovalDirExists, false, 'Target-B must not have any approval artifacts');
  });

  // ==========================================================================
  // STEP 9 & 11 — MCP-ONLY ACCEPTANCE & STATE ISOLATION
  // ==========================================================================
  it('STEP 9 & 11: confirms zero state leakage into AIDM server repository and clean target isolation', async () => {
    // 1. Verify target directory contains expected .ai-manager artifacts
    const targetAInventory = await getDirInventory(path.join(targetADir, '.ai-manager'));
    assert.ok(targetAInventory.length > 0, 'Target-A must have created .ai-manager artifacts');
    assert.ok(targetAInventory.some((p) => p.includes('approval')), 'Target-A must contain approval state');
    assert.ok(targetAInventory.some((p) => p.includes('discovery')), 'Target-A must contain discovery state');
    assert.ok(targetAInventory.some((p) => p.includes('completeness')), 'Target-A must contain completeness state');

    // 2. Verify AIDM server repository .ai-manager received ZERO leakage
    const serverCurrentInventory = await getDirInventory(path.join(serverRepoRoot, '.ai-manager'));
    assert.deepEqual(
      serverCurrentInventory.sort(),
      serverInitialInventory.sort(),
      'AIDM server repository .ai-manager must remain completely untouched (zero state leakage)'
    );
  });
});
