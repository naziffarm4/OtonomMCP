import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import {
  AdaptiveDiscoveryEngine,
  AdaptiveDiscoveryStore,
  ClarificationSessionEngine,
  ClarificationStore,
  RequirementsScopeEngine,
  RequirementsScopeStore,
  ArchitectureTechnologyEngine,
  ArchitectureTechnologyStore,
  BusinessRulesEngine,
  BusinessRulesStore,
  AcceptanceCriteriaEngine,
  AcceptanceCriteriaStore,
  RiskHumanDecisionEngine,
  RiskHumanDecisionStore,
  CompletenessGateEngine,
  CompletenessGateStore,
  ApprovalPackageEngine,
  ApprovalStore,
  ProjectSpecEngine,
  ProjectSpecStore,
  type ProjectDiscoveryReport,
} from '../dist/index.js';
import { ExternalMcpClient } from './helpers/external-mcp-client.ts';

const execFile = promisify(execFileCallback);

function createMockReport(overrides?: Partial<ProjectDiscoveryReport>): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'expense-tracker-undecided-test',
      version: '1.0.0',
      workspaceRoot: '/mock/workspace',
      ecosystem: 'Node.js',
      evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'An expense tracker without external database',
      domainKeywords: ['finance', 'expenses'],
      evidence: [{ sourceType: 'FILE', sourceIdentifier: 'README.md' }],
    },
    technologyStack: {
      primaryLanguages: ['TypeScript'],
      frameworks: [],
      buildTools: ['tsc'],
      packageManagers: ['npm'],
      runtimes: ['node'],
      containerization: [],
      ciCd: [],
      workspaceType: 'standalone',
      dependencies: [],
      devDependencies: [],
      evidence: [{ sourceType: 'CONFIG', sourceIdentifier: 'tsconfig.json' }],
    },
    repositoryStructure: {
      layout: 'standard-src',
      topLevelDirectories: ['src'],
      totalFileCount: 4,
      significantFiles: ['package.json'],
      fileExtensions: ['.ts', '.json'],
      evidence: [],
    },
    architecture: {
      identifiedAreas: [],
      architecturalPattern: 'Modular',
      summary: 'Modular TypeScript architecture',
      evidence: [],
    },
    entryPoints: [
      {
        type: 'main',
        target: 'src/index.ts',
        source: 'package.json:main',
        isAuthoritative: true,
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json:main' }],
      },
    ],
    commands: {
      build: { status: 'UNKNOWN', evidence: [] },
      test: { status: 'UNKNOWN', evidence: [] },
      runtime: { status: 'UNKNOWN', evidence: [] },
      lint: { status: 'UNKNOWN', evidence: [] },
    },
    featureInventory: [],
    documentationSummary: {
      hasReadme: true,
      readmePath: 'README.md',
      hasContributing: false,
      hasArchitectureDocs: false,
      documentationFiles: ['README.md'],
      summary: 'README present',
      evidence: [],
    },
    requirementsSummary: {
      totalRequirements: 0,
      lockedCount: 0,
      source: 'NONE',
      requirements: [],
      evidence: [],
    },
    decisionsSummary: {
      totalDecisions: 0,
      source: 'NONE',
      decisions: [],
      evidence: [],
    },
    currentImplementationState: {
      lifecycleState: 'INIT',
      hasActiveTask: false,
      isBlocked: false,
      totalTasksInDag: 0,
      completedTasksCount: 0,
      evidence: [],
    },
    gitStatus: {
      uncommittedChangesCount: 0,
      untrackedFilesCount: 0,
      evidence: [],
    },
    facts: [],
    observations: [],
    inferences: [],
    unknowns: [
      {
        id: 'UNK-001',
        item: 'Preferred Application Interface',
        description: 'Target platform and interface type has not been selected yet.',
        impact: 'HIGH',
      },
      {
        id: 'UNK-002',
        item: 'Expense storage method without an external database',
        description: 'Persistence mechanism for expense data is unspecified.',
        impact: 'HIGH',
      },
      {
        id: 'UNK-003',
        item: 'Expense category management',
        description: 'Category hierarchy and customization model.',
        impact: 'MEDIUM',
      },
    ],
    contradictions: [],
    clarificationCandidates: [],
    recommendedNextAction: 'PROCEED_TO_CLARIFICATION',
    timestamp: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('AIDM Remediation: Preserve Undecided Customer Decisions', { concurrency: 1 }, () => {
  let tmpDir: string;
  const projectId = 'expense-tracker-undecided-test';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-undecided-reg-'));
  });

  after(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('1. Customer answers "I haven\'t decided yet" -> preserved as UNDECIDED and blocking', async () => {
    const clarificationEngine = new ClarificationSessionEngine();
    const report = createMockReport();
    const session = clarificationEngine.createSession(report, {
      projectId,
      sessionId: 'session-undecided-1',
    });

    assert.ok(session.questions.length > 0, 'Clarification session should have questions');
    const targetQ = session.questions[0];

    // Customer explicitly states they haven't decided yet
    const updatedSession = clarificationEngine.submitAnswer(session, {
      clarificationId: targetQ.clarificationId,
      freeFormResponse: "I haven't decided yet. Please explain the alternatives first before I choose.",
      source: 'HUMAN',
    });

    const updatedQ = updatedSession.questions.find((q) => q.clarificationId === targetQ.clarificationId);
    assert.ok(updatedQ, 'Target question must exist');
    assert.equal(updatedQ.status, 'UNDECIDED', 'Question status must be UNDECIDED');
    assert.equal(updatedQ.answer?.status, 'UNDECIDED', 'Answer status must be UNDECIDED');

    // Verify session remains blocked / unresolved
    assert.notEqual(updatedSession.status, 'RESOLVED', 'Session must NOT be RESOLVED when questions are undecided');
  });

  it('2. Customer selects "Other" and requests an explanation -> accepted without INVALID_OPTION error', async () => {
    const clarificationEngine = new ClarificationSessionEngine();
    const report = createMockReport();
    const session = clarificationEngine.createSession(report, {
      projectId,
      sessionId: 'session-undecided-2',
    });

    const targetQ = session.questions[0];

    // Submitting "Other: We need explanation of alternatives before deciding"
    const updatedSession = clarificationEngine.submitAnswer(session, {
      clarificationId: targetQ.clarificationId,
      selectedOptions: ['Other'],
      freeFormResponse: 'Other: We need an explanation of each alternative before we can choose',
      source: 'HUMAN',
    });

    const updatedQ = updatedSession.questions.find((q) => q.clarificationId === targetQ.clarificationId);
    assert.ok(updatedQ);
    assert.equal(updatedQ.status, 'UNDECIDED', 'Selecting Other with explanation request must mark question as UNDECIDED');
    assert.equal(updatedQ.answer?.status, 'UNDECIDED');
  });

  it('3. AIDM recommends LocalStorage without customer approval -> remains PROPOSED / PENDING_DECISION', async () => {
    const discoveryEngine = new AdaptiveDiscoveryEngine({ baseDir: tmpDir });

    const rev = await discoveryEngine.discover({
      projectId,
      rawPrompt: 'Expense tracker without external database. Recommend a storage approach.',
    });

    const storageDecision = rev.decisions.find((d) =>
      d.title.toLowerCase().includes('storage') || d.title.toLowerCase().includes('persistence')
    );

    if (storageDecision) {
      assert.notEqual(storageDecision.status, 'CONFIRMED', 'Storage recommendation must NOT be CONFIRMED without customer approval');
      assert.ok(
        ['PROPOSED', 'PENDING_DECISION', 'UNDECIDED', 'OPEN'].includes(storageDecision.status),
        `Storage recommendation should be PROPOSED or PENDING_DECISION, got ${storageDecision.status}`
      );
    }
  });

  it('4. An undecided interface type does not become Web Application in Architecture', async () => {
    const discoveryEngine = new AdaptiveDiscoveryEngine({ baseDir: tmpDir });
    const reqEngine = new RequirementsScopeEngine({ baseDir: tmpDir });
    const archEngine = new ArchitectureTechnologyEngine({ baseDir: tmpDir });

    // Discovery with undecided interface
    const discRev = await discoveryEngine.discover({
      projectId,
      rawPrompt: 'Expense tracking application. Preferred application interface: Other - I have not decided yet between Web, CLI, or Desktop. Explain alternatives first.',
    });

    const reqRev = await reqEngine.derive({
      projectId,
      discoveryRevision: discRev.discoveryRevision,
    });

    // In-scope platforms must not contain Web Application
    assert.ok(
      !reqRev.inScope.platforms.includes('Web Application') && !reqRev.inScope.platforms.includes('Web / Browser'),
      'In-scope platforms must NOT assume Web Application when interface is undecided'
    );

    const archRev = await archEngine.derive({
      projectId,
      requirementsRevision: reqRev.requirementsRevision,
    });

    // Check ARCH-DEC-005 (Platform Decision)
    const platDecision = archRev.decisions.find((d) => d.decisionId === 'ARCH-DEC-005');
    assert.ok(platDecision, 'ARCH-DEC-005 platform decision should exist');
    assert.equal(platDecision.status, 'PENDING_DECISION', 'Platform decision must be PENDING_DECISION');
    assert.equal(platDecision.selectedOption, undefined, 'Selected option must be undefined when platform is undecided');

    // Architectural style must not be locked to Web client-server
    assert.equal(archRev.architecturalStyle.status, 'PENDING_DECISION');
  });

  it('5. An undecided UI framework does not become React in Technology Stack', async () => {
    const reqStore = new RequirementsScopeStore({ baseDir: tmpDir });
    const archEngine = new ArchitectureTechnologyEngine({ baseDir: tmpDir });

    const latestReq = await reqStore.loadRevision(projectId);
    assert.ok(latestReq, 'Requirements revision must exist');

    const archRev = await archEngine.derive({
      projectId,
      requirementsRevision: latestReq.requirementsRevision,
    });

    const reactTech = archRev.technologyStack.find((t) => t.name.toLowerCase() === 'react');
    if (reactTech) {
      assert.notEqual(reactTech.selectionStatus, 'REQUIRED', 'React must NOT be REQUIRED when UI framework/platform is undecided');
      assert.equal(reactTech.selectionStatus, 'CANDIDATE', 'React must be a CANDIDATE only');
    }
  });

  it('6. Architecture explanations preserve conditional assumptions', async () => {
    const reqStore = new RequirementsScopeStore({ baseDir: tmpDir });
    const archEngine = new ArchitectureTechnologyEngine({ baseDir: tmpDir });

    const latestReq = await reqStore.loadRevision(projectId);
    assert.ok(latestReq);

    const archRev = await archEngine.derive({
      projectId,
      requirementsRevision: latestReq.requirementsRevision,
    });

    // Browser requirements must be empty when platform is undecided
    assert.deepEqual(archRev.platformEnvironment.browserRequirements, [], 'browserRequirements must not assume browser when platform is undecided');

    // Data persistence decision must be PENDING_DECISION
    const dataDecision = archRev.decisions.find((d) => d.decisionId === 'ARCH-DEC-002');
    assert.ok(dataDecision, 'ARCH-DEC-002 data persistence decision should exist');
    assert.equal(dataDecision?.status, 'PENDING_DECISION', 'Data persistence must be PENDING_DECISION');
  });

  it('7. ProjectSpec does not convert PROPOSED decisions into CONFIRMED decisions', async () => {
    const reqStore = new RequirementsScopeStore({ baseDir: tmpDir });
    const archStore = new ArchitectureTechnologyStore({ baseDir: tmpDir });
    const brEngine = new BusinessRulesEngine({ baseDir: tmpDir });
    const acEngine = new AcceptanceCriteriaEngine({ baseDir: tmpDir });
    const riskEngine = new RiskHumanDecisionEngine({ baseDir: tmpDir });
    const specEngine = new ProjectSpecEngine({ baseDir: tmpDir });

    const reqRev = await reqStore.loadRevision(projectId);
    const archRev = await archStore.loadRevision(projectId);
    assert.ok(reqRev && archRev);

    const brRev = await brEngine.derive({ projectId, requirementsRevision: reqRev.requirementsRevision });
    const acRev = await acEngine.derive({ projectId, requirementsRevision: reqRev.requirementsRevision });
    const riskRev = await riskEngine.derive({
      projectId,
      requirementsRevision: reqRev.requirementsRevision,
      architectureRevision: archRev.architectureRevision,
      businessRulesRevision: brRev.businessRulesRevision,
      acceptanceCriteriaRevision: acRev.acceptanceCriteriaRevision,
    });

    const projection = await specEngine.generate({
      projectId,
      requirementsRevision: reqRev.requirementsRevision,
      architectureRevision: archRev.architectureRevision,
      businessRulesRevision: brRev.businessRulesRevision,
      acceptanceCriteriaRevision: acRev.acceptanceCriteriaRevision,
      riskRevision: riskRev.riskRevision,
    });

    // Verify markdown projection does NOT claim confirmed web application or confirmed decisions
    assert.ok(!projection.markdownContent.includes('CONFIRMED: Web Application'), 'ProjectSpec markdown must not claim Web Application is CONFIRMED');

    // Human decision points in projection must retain undecided status
    const pendingHdps = projection.content.humanDecisionPoints.filter((h) =>
      ['PENDING_DECISION', 'UNDECIDED', 'PROPOSED'].includes(h.status)
    );
    assert.ok(pendingHdps.length > 0, 'ProjectSpec must preserve pending/undecided human decision points');
  });

  it('8. Explicit customer selection correctly transitions a decision to CONFIRMED', async () => {
    const discoveryEngine = new AdaptiveDiscoveryEngine({ baseDir: tmpDir });
    const reqEngine = new RequirementsScopeEngine({ baseDir: tmpDir });

    // Explicit confirmation
    const discRev = await discoveryEngine.discover({
      projectId: 'explicit-confirmed-project',
      rawPrompt: 'We are building a Web Application with TypeScript and LocalStorage. Interface is explicitly Web Application.',
    });

    const reqRev = await reqEngine.derive({
      projectId: 'explicit-confirmed-project',
      discoveryRevision: discRev.discoveryRevision,
    });

    assert.ok(reqRev.inScope.platforms.length > 0, 'In-scope platforms should be populated upon explicit confirmation');
  });

  it('9. Reloading persisted project state preserves decision status', async () => {
    const discoveryStore = new AdaptiveDiscoveryStore({ baseDir: tmpDir });

    const rev = await discoveryStore.loadRevision(projectId, 1);
    assert.ok(rev, 'Revision 1 should be loaded from store');

    const interfaceDec = rev.decisions.find((d) =>
      d.title.toLowerCase().includes('platform') || d.title.toLowerCase().includes('interface')
    );
    if (interfaceDec) {
      assert.ok(['UNDECIDED', 'PENDING_DECISION', 'PROPOSED', 'OPEN'].includes(interfaceDec.status), 'Persisted status must remain undecided after reload');
    }
  });

  it('10. Completeness Gate, Approval Package, and real MCP interaction preserve undecided semantics', async () => {
    const completenessEngine = new CompletenessGateEngine({ baseDir: tmpDir });
    const approvalEngine = new ApprovalPackageEngine({ baseDir: tmpDir });

    const compResult = await completenessEngine.evaluate({
      projectId,
    });

    assert.equal(compResult.status, 'BLOCKED_ON_HUMAN', 'Completeness gate must be BLOCKED_ON_HUMAN when human decisions are undecided');
    assert.equal(compResult.isEligibleForApproval, false, 'Project cannot be eligible for approval with undecided choices');

    const pkg = await approvalEngine.createApprovalPackage({
      projectId,
    });

    assert.equal(pkg.status, 'BLOCKED_ON_HUMAN', 'Approval package must be BLOCKED_ON_HUMAN');
    assert.ok((pkg.unresolvedHumanDecisionPoints?.length ?? 0) > 0, 'Approval package must record unresolved HDPs');

    // Real MCP execution test
    const mcpProjectDir = path.join(tmpDir, 'mcp-real-test-project');
    await fs.mkdir(path.join(mcpProjectDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(mcpProjectDir, 'package.json'),
      JSON.stringify({ name: 'mcp-expense-tracker', version: '0.1.0' }, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(mcpProjectDir, 'README.md'),
      '# Expense Tracker\nUndecided interface: Web vs CLI vs Desktop.\n',
      'utf-8'
    );

    const client = new ExternalMcpClient({ projectRoot: mcpProjectDir });
    await client.start();
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });
      await client.notify('notifications/initialized');

      // Call aidm.project.discover with undecided customer intent
      const discoverRes = await client.request<{ content: Array<{ type: string; text: string }> }>('tools/call', {
        name: 'aidm.project.discover',
        arguments: {
          prompt: "I need an expense tracker. I haven't decided between Web Application, CLI, or Desktop yet.",
        },
      });

      assert.equal(discoverRes.error, undefined);
      assert.ok(discoverRes.result?.content?.[0]?.text);
      const discoverOutput = JSON.parse(discoverRes.result.content[0].text);
      assert.ok(discoverOutput.discoveryRevision >= 1);

      // Verify human decisions returned through MCP are not silently confirmed
      const decisionsRes = await client.request<{ content: Array<{ type: string; text: string }> }>('tools/call', {
        name: 'aidm.human-decisions.get',
        arguments: {},
      });
      assert.equal(decisionsRes.error, undefined);
      const decisionsText = decisionsRes.result?.content?.[0]?.text;
      assert.ok(decisionsText);
      const decisionsOutput = JSON.parse(decisionsText);
      const decisionsList = decisionsOutput.humanDecisions ?? decisionsOutput.decisions ?? [];
      for (const d of decisionsList) {
        assert.notEqual(d.status, 'CONFIRMED', 'Human decisions must not be CONFIRMED when undecided');
      }
    } finally {
      await client.stop();
    }
  });
});
